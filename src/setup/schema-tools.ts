import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PuppyGraphRestLike } from "../clients/rest.js";
import { MASK } from "../utils/redact.js";
import {
  call,
  liveVersion,
  runTool,
  SetupError,
} from "./common.js";
import { validateSchema } from "./validate.js";

/**
 * Schema tools PuppyGraph AI has and the MCP server lacked: find things in a
 * large schema, change one node or edge at a time, and check after an upload
 * that edges really connect nodes.
 *
 * PuppyGraph serves per-element schema changes over gRPC only, so the edit
 * tools read the installed schema, change one element, check it and upload
 * the whole schema, refusing if someone else changed the schema meanwhile.
 */

/** Runs a Cypher query and returns its rows. */
export type CypherRunner = (query: string) => Promise<Array<Record<string, unknown>>>;
/** Runs a Gremlin traversal and returns its results. */
export type GremlinRunner = (query: string) => Promise<unknown[]>;

type Schema = { node: any[]; edge: any[]; [key: string]: unknown };

const UPLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_EDGES_CHECKED = 30;
const READY_WAIT_MS = 10_000;

export function normalizeSchema(value: unknown): Schema {
  const schema = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  if ((schema.node !== undefined && !Array.isArray(schema.node)) || (schema.edge !== undefined && !Array.isArray(schema.edge))) {
    throw new SetupError("UPSTREAM_ERROR", "Unexpected response from GET /schemajson; nothing was changed.");
  }
  return { ...schema, node: (schema.node as any[]) ?? [], edge: (schema.edge as any[]) ?? [] };
}

/** The relationship label(s) a Cypher pattern uses for an edge: its type, else its label. */
export function cypherLabels(edge: any): string[] {
  return Array.isArray(edge?.type) && edge.type.length > 0 ? edge.type : [edge?.label];
}

function sourceOf(element: any): string | undefined {
  const source = element?.dataSourceGroup?.externalDataSource;
  return source?.enabled ? `${source.catalog}.${source.schema}.${source.table}` : undefined;
}

function columns(list: unknown): Array<{ name: string; type: string }> {
  return Array.isArray(list) ? list.map((column: any) => ({ name: column?.name, type: column?.type })) : [];
}

function nodeSummary(node: any) {
  return {
    label: node?.label,
    id: columns(node?.id),
    attributes: columns(node?.attribute),
    source: sourceOf(node),
  };
}

function edgeSummary(edge: any) {
  const labels = cypherLabels(edge);
  return {
    label: edge?.label,
    cypher_labels: labels,
    pattern: `(:${edge?.fromNodeLabel})-[:${labels[0]}]->(:${edge?.toNodeLabel})`,
    from: edge?.fromNodeLabel,
    to: edge?.toNodeLabel,
    fromKey: columns(edge?.fromKey),
    toKey: columns(edge?.toKey),
    attributes: columns(edge?.attribute),
    source: sourceOf(edge),
  };
}

/** Labels only, for schemas too large to return whole (as PuppyGraph AI does). */
export function schemaSkeleton(value: unknown) {
  const schema = normalizeSchema(value);
  const relationships = [
    ...new Set(
      schema.edge.flatMap((edge) =>
        cypherLabels(edge).map((label) => `(${edge?.fromNodeLabel})-[:${label}]->(${edge?.toNodeLabel})`),
      ),
    ),
  ].sort();
  return {
    note: `This schema is large (${schema.node.length} node types, ${schema.edge.length} edge mappings), so only its structure is shown. Use puppygraph_search_schema to find elements by keyword and puppygraph_get_schema_element for one element's ids, attributes, source and keys before writing a query.`,
    node_labels: schema.node.map((node) => node?.label).sort(),
    relationships,
  };
}

function closest(name: string, candidates: string[], limit = 5): string[] {
  const lower = name.toLowerCase();
  const scored = candidates.map((candidate) => {
    const other = candidate.toLowerCase();
    const score = other === lower ? 0 : other.includes(lower) || lower.includes(other) ? 1 : 2 + Math.abs(other.length - lower.length);
    return { candidate, score };
  });
  return scored.sort((a, b) => a.score - b.score).slice(0, limit).map((entry) => entry.candidate);
}

/** Labels added, removed or changed between two schemas. */
export function schemaDiff(before: unknown, after: unknown) {
  const a = normalizeSchema(before);
  const b = normalizeSchema(after);
  const diff = (kind: "node" | "edge") => {
    const old = new Map(a[kind].map((element) => [element?.label, JSON.stringify(element)]));
    const now = new Map(b[kind].map((element) => [element?.label, JSON.stringify(element)]));
    return {
      added: [...now.keys()].filter((label) => !old.has(label)),
      removed: [...old.keys()].filter((label) => !now.has(label)),
      changed: [...now.keys()].filter((label) => old.has(label) && old.get(label) !== now.get(label)),
    };
  };
  return { nodes: diff("node"), edges: diff("edge") };
}

async function count(query: CypherRunner, cypher: string): Promise<number> {
  const rows = await query(cypher);
  const value = rows?.[0] ? Object.values(rows[0])[0] : 0;
  return typeof value === "number" ? value : Number(value ?? 0);
}

const quote = (label: string) => "`" + String(label).replace(/`/g, "``") + "`";

/**
 * How many rows the edge's table maps to edges, whether or not they reach a
 * node. Cypher can't say: depending on the PuppyGraph version it counts edge
 * rows (1.14) or only edges whose endpoints exist (later). Gremlin's g.E()
 * counts the rows on both, so it is asked first.
 */
async function gremlinCount(gremlin: GremlinRunner, traversal: string): Promise<number | undefined> {
  try {
    const result = await gremlin(traversal);
    const value = Array.isArray(result) ? Number(result[0]) : NaN;
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Counts an edge's rows and how many reach an existing source and target
 * node, each side on its own. PuppyGraph versions differ: up to 1.14 Cypher
 * counts every edge row and a node scan on one side checks that side alone,
 * while Gremlin doesn't look the nodes up; later versions drop edges whose
 * endpoints don't exist from every Cypher match, while Gremlin's
 * g.V().hasLabel().outE() checks one side. Gremlin's g.E() counts the rows on
 * both, so when Cypher sees fewer edges than that, the sides come from
 * Gremlin; otherwise from Cypher.
 */
async function edgeCounts(query: CypherRunner, gremlin: GremlinRunner | undefined, edge: any): Promise<EdgeCounts> {
  const rel = quote(cypherLabels(edge)[0]);
  const from = quote(edge.fromNodeLabel);
  const to = quote(edge.toNodeLabel);
  // Gremlin's g.E() is the only count of the edge rows that doesn't depend on
  // the nodes existing, so without it the check can't conclude anything:
  // falling back to Cypher would report a broken mapping as fine on servers
  // where Cypher drops edges with a missing endpoint.
  let gremlinLabel: string | undefined;
  let gremlinRows: number | undefined;
  if (gremlin) {
    for (const label of [...new Set([edge.label, ...cypherLabels(edge)])]) {
      const value = await gremlinCount(gremlin, `g.E().hasLabel(${JSON.stringify(String(label))}).count()`);
      if (value !== undefined && (gremlinRows === undefined || value > gremlinRows)) {
        gremlinLabel = label;
        gremlinRows = value;
      }
    }
  }
  if (gremlinLabel === undefined || gremlinRows === undefined) {
    return {
      inconclusive: gremlin
        ? "The Gremlin endpoint didn't answer, so the edge rows couldn't be counted independently of the nodes."
        : "This MCP server has no Gremlin connection, so the edge rows couldn't be counted independently of the nodes.",
    };
  }
  if (gremlinRows === 0) return { rows: 0, fromHits: 0, toHits: 0 };
  const cypherRows = await count(query, `MATCH ()-[r:${rel}]->() RETURN count(r) AS n`);
  if (gremlinRows > cypherRows) {
    // Cypher drops edges with a missing endpoint: count each side with Gremlin.
    const label = JSON.stringify(gremlinLabel);
    const fromHits = await gremlinCount(gremlin!, `g.V().hasLabel(${JSON.stringify(String(edge.fromNodeLabel))}).outE(${label}).count()`);
    const toHits = await gremlinCount(gremlin!, `g.V().hasLabel(${JSON.stringify(String(edge.toNodeLabel))}).inE(${label}).count()`);
    if (fromHits === undefined || toHits === undefined) {
      return { inconclusive: "The Gremlin endpoint stopped answering while counting the edge's endpoints." };
    }
    return { rows: gremlinRows, fromHits, toHits };
  }
  return {
    rows: gremlinRows,
    fromHits: await count(query, `MATCH (a:${from}) WITH a MATCH (a)-[r:${rel}]->() RETURN count(r) AS n`),
    toHits: await count(query, `MATCH (b:${to}) WITH b MATCH ()-[r:${rel}]->(b) RETURN count(r) AS n`),
  };
}

type EdgeCounts = { rows: number; fromHits: number; toHits: number; inconclusive?: undefined } | { inconclusive: string };

// One schema change at a time per PuppyGraph from this server: each change
// reads the whole schema and writes it back.
const schemaLocks = new WeakMap<object, Promise<unknown>>();

export function withSchemaLock<T>(rest: object, task: () => Promise<T>): Promise<T> {
  const previous = schemaLocks.get(rest) ?? Promise.resolve();
  const run = previous.then(task, task);
  schemaLocks.set(rest, run.catch(() => undefined));
  return run;
}

/**
 * Waits (briefly) until labels that were just added or changed can be
 * queried. PuppyGraph can answer the first queries after an upload with 0
 * rows, so a check run straight away would look like a broken mapping.
 */
export async function waitUntilQueryable(
  query: CypherRunner | undefined,
  schema: unknown,
  diff: ReturnType<typeof schemaDiff>,
): Promise<{ ready: boolean; note?: string }> {
  if (!query) return { ready: true };
  const nodes = [...diff.nodes.added, ...diff.nodes.changed].slice(0, 3);
  const edges = normalizeSchema(schema).edge.filter((edge) =>
    [...diff.edges.added, ...diff.edges.changed].includes(edge?.label),
  ).slice(0, 3);
  const probes = [
    ...nodes.map((label) => `MATCH (n:${quote(label)}) RETURN count(n) AS n`),
    ...edges.map((edge) => `MATCH ()-[r:${quote(cypherLabels(edge)[0])}]->() RETURN count(r) AS n`),
  ];
  if (probes.length === 0) return { ready: true };
  const deadline = Date.now() + READY_WAIT_MS;
  const pending = new Set(probes);
  while (pending.size > 0 && Date.now() < deadline) {
    for (const probe of [...pending]) {
      try {
        if ((await count(query, probe)) > 0) pending.delete(probe);
      } catch {
        // not queryable yet
      }
    }
    if (pending.size > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return pending.size === 0
    ? { ready: true }
    : {
        ready: false,
        note: "Some new labels still return 0 rows. PuppyGraph can take a few seconds to serve a new schema, and a table can also be empty: run puppygraph_check_edges before deciding the mapping is wrong.",
      };
}

export interface SchemaToolOptions {
  readOnly: boolean;
  query?: CypherRunner;
  gremlin?: GremlinRunner;
}

const nodeInput = z.record(z.any()).describe(
  "One node as in the graph schema: label, id, attribute, dataSourceGroup.externalDataSource (see puppygraph_schema_template)",
);
const edgeInput = z.record(z.any()).describe(
  "One edge as in the graph schema: label, fromNodeLabel, toNodeLabel, fromKey, toKey, attribute, dataSourceGroup.externalDataSource (see puppygraph_schema_template)",
);

export function registerSchemaTools(
  server: McpServer,
  rest: PuppyGraphRestLike,
  { readOnly, query, gremlin }: SchemaToolOptions,
): void {
  const readLive = async () => normalizeSchema(await call(rest, "GET", "/schemajson", "read the installed schema"));

  server.registerTool(
    "puppygraph_search_schema",
    {
      description:
        "Search the installed graph schema for node and edge types by keyword (case-insensitive, matched against labels, relationship labels, endpoint labels and attribute names), without loading the whole schema. Each edge comes with the pattern to use in Cypher.",
      inputSchema: {
        query: z.string().min(1).describe("Keyword, e.g. a label fragment or an attribute name"),
        limit: z.number().int().min(1).max(200).optional().describe("Max nodes and max edges to return, default 40"),
      },
    },
    runTool("puppygraph_search_schema", async ({ query: keyword, limit }: { query: string; limit?: number }) => {
      const schema = await readLive();
      const max = limit ?? 40;
      const needle = keyword.toLowerCase();
      const has = (value: unknown) => typeof value === "string" && value.toLowerCase().includes(needle);
      const names = (list: unknown) => (Array.isArray(list) ? list.map((column: any) => column?.name) : []);
      const nodes = schema.node.filter((node) => has(node?.label) || [...names(node?.id), ...names(node?.attribute)].some(has));
      const edges = schema.edge.filter((edge) =>
        [edge?.label, ...cypherLabels(edge), edge?.fromNodeLabel, edge?.toNodeLabel, ...names(edge?.attribute)].some(has),
      );
      return {
        nodes: nodes.slice(0, max).map(nodeSummary),
        edges: edges.slice(0, max).map(edgeSummary),
        nodes_truncated: nodes.length > max,
        edges_truncated: edges.length > max,
      };
    }),
  );

  server.registerTool(
    "puppygraph_get_schema_element",
    {
      description:
        "Get one node or edge of the installed graph schema: ids, attributes (with types), source table and, for edges, endpoints, keys and the relationship label to use in Cypher. Accepts a node label, an edge label, or a Cypher relationship label. Use it before filtering on a property you haven't seen.",
      inputSchema: { label: z.string().min(1).describe("Node label, edge label or relationship label") },
    },
    runTool("puppygraph_get_schema_element", async ({ label }: { label: string }) => {
      const schema = await readLive();
      const node = schema.node.find((candidate) => candidate?.label === label);
      if (node) return { kind: "node", ...nodeSummary(node) };
      const edge = schema.edge.find((candidate) => candidate?.label === label);
      if (edge) return { kind: "edge", ...edgeSummary(edge) };
      const byType = schema.edge.filter((candidate) => cypherLabels(candidate).includes(label));
      if (byType.length > 0) {
        return { kind: "relationship", label, connects: byType.map(edgeSummary) };
      }
      const known = [...schema.node.map((n) => n?.label), ...schema.edge.flatMap((e) => [e?.label, ...cypherLabels(e)])];
      throw new SetupError(
        "NOT_FOUND",
        known.length === 0
          ? "No graph schema is installed yet."
          : `No node, edge or relationship labelled '${label}'. Closest: ${closest(label, [...new Set(known)]).join(", ")}. Labels are case-sensitive.`,
      );
    }),
  );

  server.registerTool(
    "puppygraph_check_edges",
    {
      description:
        "Check the installed graph against its data: for each edge type, how many edge rows exist and how many of them reach an existing source node and an existing target node, plus a row count per node type. A wrong join key, a swapped direction or a key of the wrong type shows up as rows that reach no node. Plain count queries can't show this: they count edge rows without looking up the nodes. Run it after every upload. It works on every PuppyGraph 1.x, and needs no data-probing permission.",
      inputSchema: {
        labels: z.array(z.string().min(1)).optional().describe(`Edge labels to check; all edges (up to ${MAX_EDGES_CHECKED}) when omitted`),
      },
    },
    runTool("puppygraph_check_edges", async ({ labels }: { labels?: string[] }) => {
      if (!query) {
        throw new SetupError("UPSTREAM_ERROR", "Graph queries are not available in this MCP server, so edges can't be checked.");
      }
      const schema = await readLive();
      if (schema.node.length === 0) {
        throw new SetupError("NOT_FOUND", "No graph schema is installed yet. Upload one with puppygraph_upload_schema first.");
      }
      const unknown = (labels ?? []).filter((label) => !schema.edge.some((edge) => edge?.label === label || cypherLabels(edge).includes(label)));
      if (unknown.length > 0) {
        throw new SetupError("NOT_FOUND", `Unknown edge label(s): ${unknown.join(", ")}. Edges: ${schema.edge.map((edge) => edge?.label).join(", ") || "none"}.`);
      }
      const selected = labels
        ? schema.edge.filter((edge) => labels.includes(edge?.label) || cypherLabels(edge).some((label) => labels.includes(label)))
        : schema.edge;
      const edges = selected.slice(0, MAX_EDGES_CHECKED);

      const counts = async () => {
        const nodes: Array<{ label: string; rows: number; distinct_ids: number; note?: string }> = [];
        for (const node of schema.node) {
          const [row] = await query(`MATCH (n:${quote(node.label)}) RETURN count(n) AS n, count(DISTINCT id(n)) AS d`);
          const rows = Number(row?.n ?? 0);
          const distinct = Number(row?.d ?? rows);
          nodes.push({
            label: node?.label,
            rows,
            distinct_ids: distinct,
            ...(distinct < rows
              ? { note: `${rows - distinct} rows repeat an id: the id column isn't unique in this table, so each such node exists more than once and edges to it are multiplied. Use a unique column (a pk_candidate), or a table with one row per ${node?.label}.` }
              : {}),
          });
        }
        return nodes;
      };
      // Right after an upload PuppyGraph can answer 0 for everything; give it
      // a few seconds before trusting a graph that looks empty.
      let nodes = await counts();
      for (let attempt = 0; attempt < 3 && nodes.length > 0 && nodes.every((node) => node.rows === 0); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        nodes = await counts();
      }

      const results = [];
      for (const edge of edges) {
        const counted = await edgeCounts(query, gremlin, edge);
        if (counted.inconclusive !== undefined) {
          results.push({
            label: edge.label,
            pattern: `(:${edge.fromNodeLabel})-[:${cypherLabels(edge)[0]}]->(:${edge.toNodeLabel})`,
            rows: null,
            reach_source: null,
            reach_target: null,
            source_hit_rate: null,
            target_hit_rate: null,
            status: "inconclusive",
            note: `${counted.inconclusive} Not checked; don't report this edge as verified.`,
          });
          continue;
        }
        const { rows, fromHits, toHits } = counted;
        const share = (hits: number) => (rows === 0 ? null : Math.round((hits / rows) * 1000) / 1000);
        let status: string;
        let note: string;
        const duplicated = [fromHits > rows ? edge.fromNodeLabel : undefined, toHits > rows ? edge.toNodeLabel : undefined].filter(Boolean);
        if (rows > 0 && duplicated.length > 0) {
          status = "suspect";
          note = `Edge rows reach more nodes than there are rows: '${duplicated.join("' and '")}' has duplicate ids, so edges are multiplied. See the node's note.`;
        } else if (rows === 0) {
          status = "empty";
          note = "The edge table has no rows (or PuppyGraph isn't serving it yet; check again in a few seconds).";
        } else if (fromHits === 0 || toHits === 0) {
          status = "broken";
          note = fromHits === 0 && toHits === 0
            ? `No edge row reaches both its '${edge.fromNodeLabel}' and '${edge.toNodeLabel}' nodes: fromKey or toKey doesn't hold that node's ids, or the direction is swapped. Fix the mapping.`
            : `No edge row reaches ${fromHits === 0 ? `a '${edge.fromNodeLabel}' node` : `a '${edge.toNodeLabel}' node`}: the ${fromHits === 0 ? "fromKey" : "toKey"} column doesn't hold that node's ids, or the direction is swapped. Fix the mapping.`;
        } else if (fromHits < rows || toHits < rows) {
          const low = Math.min(fromHits, toHits) / rows;
          status = low < 0.95 ? "suspect" : "ok";
          note = `${rows - Math.min(fromHits, toHits)} of ${rows} edge rows don't reach ${fromHits === toHits ? "both endpoint nodes" : `a ${fromHits < toHits ? `'${edge.fromNodeLabel}'` : `'${edge.toNodeLabel}'`} node`} (NULL keys or ids missing from the node table).${low < 0.95 ? " Below about 95%, check the key columns and the direction, and tell the user." : ""}`;
        } else {
          status = "ok";
          note = "Every edge row reaches both endpoint nodes.";
        }
        results.push({
          label: edge.label,
          pattern: `(:${edge.fromNodeLabel})-[:${cypherLabels(edge)[0]}]->(:${edge.toNodeLabel})`,
          rows,
          reach_source: fromHits,
          reach_target: toHits,
          source_hit_rate: share(fromHits),
          target_hit_rate: share(toHits),
          status,
          note,
        });
      }
      const problems = results.filter((result) => !["ok", "inconclusive"].includes(result.status)).map((result) => result.label);
      const unchecked = results.filter((result) => result.status === "inconclusive").map((result) => result.label);
      const duplicateNodes = nodes.filter((node) => node.distinct_ids < node.rows).map((node) => node.label);
      const emptyNodes = nodes.filter((node) => node.rows === 0).map((node) => node.label);
      const findings = [
        ...(problems.length ? [`edges to look at: ${problems.join(", ")}`] : []),
        ...(duplicateNodes.length ? [`nodes with duplicate ids: ${duplicateNodes.join(", ")}`] : []),
        ...(emptyNodes.length ? [`nodes with no rows: ${emptyNodes.join(", ")}`] : []),
        ...(unchecked.length ? [`edges that couldn't be checked: ${unchecked.join(", ")}`] : []),
      ];
      return {
        edges: results,
        nodes,
        ...(selected.length > edges.length ? { edges_not_checked: selected.length - edges.length } : {}),
        summary: findings.length === 0
          ? "Every checked edge connects existing nodes, and node ids are unique."
          : `Found ${findings.join("; ")}. Report them to the user with this evidence.`,
      };
    }),
  );

  if (readOnly) {
    return;
  }

  /**
   * Applies one change to the installed schema: read it, change it, check
   * the elements the change touches, and upload it, unless the schema changed
   * in the meantime.
   */
  const edit = (
    touched: string[],
    change: (schema: Schema) => void,
    log: (message: string) => void,
  ) => withSchemaLock(rest, () => applyEdit(touched, change, log));

  const applyEdit = async (
    touched: string[],
    change: (schema: Schema) => void,
    log: (message: string) => void,
  ) => {
    // The version first: a change that lands between the two reads then shows
    // up as a version mismatch below instead of being overwritten.
    const before = await liveVersion(rest);
    const live = await readLive();
    if (before === null && (live.node.length > 0 || live.edge.length > 0)) {
      throw new SetupError(
        "UPSTREAM_ERROR",
        "Could not read the installed schema's version, so a concurrent change couldn't be detected; nothing was changed. Try again, or use puppygraph_upload_schema with the whole schema.",
      );
    }
    if (live.catalog !== undefined && JSON.stringify(live.catalog).includes(MASK)) {
      // Catalogs come back with masked credentials; uploading them would store
      // the mask. They are registered on the server, so leave them out.
      delete live.catalog;
    }
    const next = JSON.parse(JSON.stringify(live)) as Schema;
    change(next);

    const validation = await validateSchema(rest, next);
    const mentions = (problem: string) => touched.some((label) => problem.includes(`'${label}'`));
    const own = validation.problems.filter(mentions);
    const others = validation.problems.filter((problem) => !mentions(problem));
    if (own.length > 0) {
      throw new SetupError("VALIDATION_FAILED", "The change has problems; nothing was changed. Fix them and call again.", {
        problems: own,
        warnings: validation.warnings,
      });
    }
    const now = await liveVersion(rest);
    if (before !== now) {
      throw new SetupError(
        "CONFLICT",
        `The installed schema changed while this change was being prepared (version ${before} → ${now}); nothing was changed. Call again to apply it to the new version.`,
      );
    }
    log(`touched=${JSON.stringify(touched)} previous_version=${before}`);
    const response = await rest.request("POST", "/schema", {
      query: { preflight: "true" },
      body: next,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    const body = (response.body && typeof response.body === "object" ? response.body : {}) as any;
    if (!response.ok || body.ok !== true) {
      const message = typeof response.body === "string" ? response.body : body.errorMessage ?? body.error ?? body.message ?? JSON.stringify(response.body);
      throw new SetupError("UPSTREAM_ERROR", `PuppyGraph rejected the change; the installed schema is unchanged. ${String(message).slice(0, 2000)}`, {
        warnings: validation.warnings,
      });
    }
    const diff = schemaDiff(live, next);
    const ready = await waitUntilQueryable(query, next, diff);
    return {
      ok: true,
      version: body.version ?? null,
      previous_version: before,
      changes: diff,
      ...ready,
      warnings: [
        ...validation.warnings,
        ...others.map((problem) => `Elsewhere in the schema (not changed by this call): ${problem}`),
        ...(Array.isArray(body.warnings) ? body.warnings : []),
      ],
      next: "Add the edges once their nodes exist, then check the graph with puppygraph_check_edges.",
    };
  };

  const find = (list: any[], label: string, kind: "node" | "edge") => {
    const index = list.findIndex((element) => element?.label === label);
    if (index < 0) {
      const labels = list.map((element) => element?.label);
      throw new SetupError(
        "NOT_FOUND",
        `No ${kind} labelled '${label}' in the installed schema.${labels.length ? ` Closest: ${closest(label, labels).join(", ")}.` : ` The schema has no ${kind}s.`}`,
      );
    }
    return index;
  };
  const absent = (schema: Schema, label: unknown) => {
    if (typeof label !== "string" || label === "") {
      throw new SetupError("INVALID_INPUT", "The element needs a non-empty label.");
    }
    if ([...schema.node, ...schema.edge].some((element) => element?.label === label)) {
      throw new SetupError("ALREADY_EXISTS", `'${label}' already exists in the schema; labels are unique across nodes and edges. Use the update tool to change it.`);
    }
  };
  const mutationNote = "Changes the installed schema for everyone who queries this PuppyGraph; other elements stay as they are. The element is checked first (columns, types, keys) and nothing changes on a problem.";

  server.registerTool(
    "puppygraph_add_node",
    {
      description: `Add one node type to the installed graph schema (creates the schema if there is none). Add all nodes first, then the edges between them. ${mutationNote}`,
      inputSchema: { node: nodeInput },
    },
    runTool("puppygraph_add_node", async ({ node }: { node: Record<string, any> }, log) =>
      edit([node?.label], (schema) => {
        absent(schema, node?.label);
        schema.node.push(node);
      }, log),
    ),
  );

  server.registerTool(
    "puppygraph_update_node",
    {
      description: `Replace one node type of the installed schema with a new definition (same label). ${mutationNote}`,
      inputSchema: { label: z.string().min(1).describe("Label of the node to replace"), node: nodeInput },
    },
    runTool("puppygraph_update_node", async ({ label, node }: { label: string; node: Record<string, any> }, log) =>
      edit([label], (schema) => {
        if (node?.label !== label) {
          throw new SetupError("INVALID_INPUT", `node.label must be '${label}'. To rename, add a node with the new label and remove the old one.`);
        }
        schema.node[find(schema.node, label, "node")] = node;
      }, log),
    ),
  );

  server.registerTool(
    "puppygraph_remove_node",
    {
      description: `Remove one node type from the installed schema. Refused while an edge still uses it: remove those edges first. ${mutationNote}`,
      inputSchema: { label: z.string().min(1).describe("Label of the node to remove") },
    },
    runTool("puppygraph_remove_node", async ({ label }: { label: string }, log) =>
      edit([label], (schema) => {
        const index = find(schema.node, label, "node");
        const users = schema.edge.filter((edge) => edge?.fromNodeLabel === label || edge?.toNodeLabel === label).map((edge) => edge?.label);
        if (users.length > 0) {
          throw new SetupError("INVALID_INPUT", `Edges still use '${label}': ${users.join(", ")}. Remove them first.`);
        }
        schema.node.splice(index, 1);
      }, log),
    ),
  );

  server.registerTool(
    "puppygraph_add_edge",
    {
      description: `Add one edge type to the installed schema; both endpoint nodes must exist. Only add an edge whose join you checked: with puppygraph_check_join where the server supports it (hit_rate near 1.0; below about 0.95 it's a soft reference, so tell the user), otherwise say it is unverified, and run puppygraph_check_edges after adding it. ${mutationNote}`,
      inputSchema: { edge: edgeInput },
    },
    runTool("puppygraph_add_edge", async ({ edge }: { edge: Record<string, any> }, log) =>
      edit([edge?.label], (schema) => {
        absent(schema, edge?.label);
        for (const side of ["fromNodeLabel", "toNodeLabel"]) {
          if (!schema.node.some((node) => node?.label === edge?.[side])) {
            throw new SetupError("INVALID_INPUT", `${side} '${edge?.[side] ?? ""}' is not a node in the installed schema. Add the node first with puppygraph_add_node.`);
          }
        }
        schema.edge.push(edge);
      }, log),
    ),
  );

  server.registerTool(
    "puppygraph_update_edge",
    {
      description: `Replace one edge type of the installed schema with a new definition (same label). ${mutationNote}`,
      inputSchema: { label: z.string().min(1).describe("Label of the edge to replace"), edge: edgeInput },
    },
    runTool("puppygraph_update_edge", async ({ label, edge }: { label: string; edge: Record<string, any> }, log) =>
      edit([label], (schema) => {
        if (edge?.label !== label) {
          throw new SetupError("INVALID_INPUT", `edge.label must be '${label}'. To rename, add an edge with the new label and remove the old one.`);
        }
        schema.edge[find(schema.edge, label, "edge")] = edge;
      }, log),
    ),
  );

  server.registerTool(
    "puppygraph_remove_edge",
    {
      description: `Remove one edge type from the installed schema. ${mutationNote}`,
      inputSchema: { label: z.string().min(1).describe("Label of the edge to remove") },
    },
    runTool("puppygraph_remove_edge", async ({ label }: { label: string }, log) =>
      edit([label], (schema) => {
        schema.edge.splice(find(schema.edge, label, "edge"), 1);
      }, log),
    ),
  );

  const attributeInput = {
    name: z.string().min(1).describe("Attribute name (not already on the element)"),
    type: z.string().min(1).describe("The column's schemaType from puppygraph_describe_table, as is (e.g. String, Long, DECIMAL(12,2), DateTime)"),
    source_field_name: z.string().min(1).optional().describe("Source column; defaults to the attribute name"),
  };
  const addAttribute = (element: any, args: { name: string; type: string; source_field_name?: string }) => {
    const used = [...(element.id ?? []), ...(element.attribute ?? []), ...(element.fromKey ?? []), ...(element.toKey ?? [])]
      .map((column: any) => column?.name);
    if (used.includes(args.name)) {
      throw new SetupError("ALREADY_EXISTS", `'${element.label}' already has a column named '${args.name}'.`);
    }
    const source = element?.dataSourceGroup?.externalDataSource;
    if (!source?.enabled) {
      throw new SetupError("INVALID_INPUT", `'${element.label}' doesn't read from an external data source; update it with the update tool instead.`);
    }
    element.attribute = [...(element.attribute ?? []), { name: args.name, type: args.type }];
    source.mappedField = [...(source.mappedField ?? []), { sourceFieldName: args.source_field_name ?? args.name, targetFieldName: args.name }];
  };

  server.registerTool(
    "puppygraph_add_node_attribute",
    {
      description: `Add one attribute (a source column) to a node type of the installed schema. ${mutationNote}`,
      inputSchema: { node_label: z.string().min(1).describe("Existing node label"), ...attributeInput },
    },
    runTool("puppygraph_add_node_attribute", async (args: { node_label: string; name: string; type: string; source_field_name?: string }, log) =>
      edit([args.node_label], (schema) => {
        addAttribute(schema.node[find(schema.node, args.node_label, "node")], args);
      }, log),
    ),
  );

  server.registerTool(
    "puppygraph_add_edge_attribute",
    {
      description: `Add one attribute (a source column) to an edge type of the installed schema. ${mutationNote}`,
      inputSchema: { edge_label: z.string().min(1).describe("Existing edge label"), ...attributeInput },
    },
    runTool("puppygraph_add_edge_attribute", async (args: { edge_label: string; name: string; type: string; source_field_name?: string }, log) =>
      edit([args.edge_label], (schema) => {
        addAttribute(schema.edge[find(schema.edge, args.edge_label, "edge")], args);
      }, log),
    ),
  );
}
