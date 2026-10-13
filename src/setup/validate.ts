import type { PuppyGraphRestLike, RestResponse } from "../clients/rest.js";
import { collectSecrets, scrubText } from "../utils/redact.js";

/**
 * Client-side dry run of a PuppyGraph 1.x graph schema.
 *
 * PuppyGraph has no endpoint that validates a schema without applying it
 * (POST /schema?preflight=true checks first but then installs the schema), so
 * this runs the checks the server's validator would, using only read
 * endpoints: catalog list, table columns, and 0.x conversion.
 */

export interface ValidationResult {
  valid: boolean;
  problems: string[];
  warnings: string[];
  /** True when the input was a 0.x schema and was converted to 1.x. */
  convertedFrom0x: boolean;
  /** The 1.x schema that was checked (credentials NOT masked: internal use). */
  schema: Record<string, any> | null;
  tablesChecked: number;
}

/**
 * An HTTP answer that says nothing about the schema (rejected credentials,
 * missing permission), so it must not be reported as a schema problem.
 */
export class UpstreamHttpError extends Error {
  constructor(readonly response: RestResponse, readonly action: string) {
    super(`HTTP ${response.status} while trying to ${action}`);
    this.name = "UpstreamHttpError";
  }
}

/** PuppyGraph answers this until its leader is elected, for a minute or so after start. */
export function isStartingMessage(message: string): boolean {
  return /no healthy leader/i.test(message);
}

/** PuppyGraph is still starting: says nothing about the schema. */
export class ServerStartingError extends Error {
  constructor() {
    super("PuppyGraph is still starting");
    this.name = "ServerStartingError";
  }
}

function throwIfAccessDenied(response: RestResponse, action: string): void {
  if (!response.ok && isStartingMessage(responseError(response.body, []))) {
    throw new ServerStartingError();
  }
  if (response.status === 401 || response.status === 403) {
    throw new UpstreamHttpError(response, action);
  }
}

type Entity = { kind: "Node" | "Edge"; value: Record<string, any> };

/** A column of a source table, as /ui-api/column describes it. */
interface SourceColumn {
  name: string;
  schemaType?: string;
}

const MAX_LISTED_COLUMNS = 40;

export function isLegacySchema(schema: Record<string, any>): boolean {
  return (
    ("graph" in schema || "catalogs" in schema) &&
    !("node" in schema) &&
    !("edge" in schema)
  );
}

export function responseError(body: unknown, secrets: readonly string[]): string {
  let message: string;
  if (typeof body === "string") {
    message = body;
  } else if (body && typeof body === "object") {
    const candidate = body as Record<string, unknown>;
    message = String(
      candidate.errorMessage ??
        candidate.error ??
        candidate.message ??
        JSON.stringify(body),
    );
  } else {
    message = "no details";
  }
  return scrubText(message.trim() || "no details", secrets).slice(0, 2000);
}

export async function validateSchema(
  rest: PuppyGraphRestLike,
  input: unknown,
): Promise<ValidationResult> {
  const result: ValidationResult = {
    valid: false,
    problems: [],
    warnings: [],
    convertedFrom0x: false,
    schema: null,
    tablesChecked: 0,
  };

  let schema: unknown = input;
  if (typeof schema === "string") {
    try {
      schema = JSON.parse(schema);
    } catch (error: any) {
      result.problems.push(`The schema is not valid JSON: ${error.message}`);
      return result;
    }
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    result.problems.push("The schema must be a JSON object with node and edge arrays.");
    return result;
  }
  const secrets = collectSecrets(schema);

  let graph = schema as Record<string, any>;
  if (isLegacySchema(graph)) {
    const converted = await rest.request("POST", "/ui-api/convertSchema", {
      body: { schemaJson: graph, createLocalTable: false, defaultDataSource: "external" },
    });
    throwIfAccessDenied(converted, "convert the 0.x schema");
    if (!converted.ok || !converted.body || typeof converted.body !== "object") {
      result.problems.push(
        `The schema is in the deprecated 0.x format and PuppyGraph could not convert it: ${responseError(converted.body, secrets)}`,
      );
      return result;
    }
    graph = converted.body as Record<string, any>;
    result.convertedFrom0x = true;
    result.warnings.push(
      "The schema is in the deprecated 0.x format (catalogs/graph.vertices). It was converted to 1.x for these checks; upload_schema sends it as given and PuppyGraph converts it. Prefer writing 1.x schemas (see puppygraph_schema_template).",
    );
  }
  result.schema = graph;

  const nodes = arrayField(graph, "node", result);
  const edges = arrayField(graph, "edge", result);
  if (nodes.length === 0) {
    result.problems.push("The schema has no nodes: add at least one entry to the node array.");
  }

  // Catalogs the schema may reference: registered on the server, or embedded.
  const embedded = new Set<string>(
    (Array.isArray(graph.catalog) ? graph.catalog : [])
      .map((catalog: any) => catalog?.name)
      .filter((name: unknown): name is string => typeof name === "string"),
  );
  let registered: Set<string> | null = null;
  const catalogs = await rest.request("GET", "/ui-api/catalog");
  throwIfAccessDenied(catalogs, "list catalogs");
  if (catalogs.ok && catalogs.body && typeof catalogs.body === "object") {
    registered = new Set(
      (((catalogs.body as any).catalogs || []) as any[])
        .map((catalog) => catalog?.name)
        .filter((name): name is string => typeof name === "string"),
    );
  } else {
    result.warnings.push(
      `Could not list the registered catalogs (${responseError(catalogs.body, secrets)}); catalog references were not checked.`,
    );
  }

  const entities: Entity[] = [
    ...nodes.map((value) => ({ kind: "Node" as const, value })),
    ...edges.map((value) => ({ kind: "Edge" as const, value })),
  ];
  checkLabels(nodes, edges, result);

  const columnCache = new Map<string, Promise<SourceColumn[] | string>>();
  for (const entity of entities) {
    await checkEntity(entity, {
      rest,
      result,
      registered,
      embedded,
      columnCache,
      secrets,
      nodeLabels: new Set(nodes.map((node) => node?.label)),
    });
  }
  checkEdgeKeys(nodes, edges, result);

  result.valid = result.problems.length === 0;
  return result;
}

function arrayField(
  graph: Record<string, any>,
  field: "node" | "edge",
  result: ValidationResult,
): Record<string, any>[] {
  const value = graph[field];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    result.problems.push(`'${field}' must be an array.`);
    return [];
  }
  value.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      result.problems.push(`${field}[${index}] must be an object.`);
    }
  });
  return value.filter((item) => item && typeof item === "object" && !Array.isArray(item));
}

function checkLabels(
  nodes: Record<string, any>[],
  edges: Record<string, any>[],
  result: ValidationResult,
): void {
  const seen = new Map<string, string>();
  for (const [kind, list] of [
    ["Node", nodes],
    ["Edge", edges],
  ] as const) {
    for (const entity of list) {
      const label = entity.label;
      if (typeof label !== "string" || label === "") {
        result.problems.push(`${kind} without a label: every ${kind.toLowerCase()} needs a non-empty label.`);
        continue;
      }
      const previous = seen.get(label);
      if (previous) {
        result.problems.push(
          previous === kind
            ? `Duplicate ${kind.toLowerCase()} label '${label}'.`
            : `Label '${label}' is used by both a node and an edge; labels cannot be shared.`,
        );
      }
      seen.set(label, kind);
    }
  }
}

interface CheckContext {
  rest: PuppyGraphRestLike;
  result: ValidationResult;
  registered: Set<string> | null;
  embedded: Set<string>;
  columnCache: Map<string, Promise<SourceColumn[] | string>>;
  secrets: readonly string[];
  nodeLabels: Set<unknown>;
}

function names(columns: unknown): string[] {
  return Array.isArray(columns)
    ? columns
        .map((column) => column?.name)
        .filter((name): name is string => typeof name === "string" && name !== "")
    : [];
}

async function checkEntity(entity: Entity, ctx: CheckContext): Promise<void> {
  const { kind, value } = entity;
  const where = `${kind} '${value.label ?? "?"}'`;
  const { problems, warnings } = ctx.result;

  if (kind === "Node" && names(value.id).length === 0) {
    problems.push(`${where}: no id column. Declare at least one entry in id.`);
  }
  if (kind === "Edge") {
    for (const side of ["fromNodeLabel", "toNodeLabel"] as const) {
      if (!value[side]) {
        problems.push(`${where}: ${side} is missing.`);
      } else if (!ctx.nodeLabels.has(value[side])) {
        problems.push(`${where}: ${side} '${value[side]}' is not a node label in this schema.`);
      }
    }
    for (const keys of ["fromKey", "toKey"] as const) {
      if (names(value[keys]).length === 0) {
        problems.push(`${where}: ${keys} is empty. Declare the column(s) that hold the ${keys === "fromKey" ? "source" : "target"} node id.`);
      }
    }
  }

  const group = value.dataSourceGroup || {};
  const enabled = ["externalDataSource", "localDataSource", "unionDataSource"].filter(
    (name) => group[name]?.enabled,
  );
  if (enabled.length !== 1) {
    problems.push(
      enabled.length === 0
        ? `${where}: no enabled data source. Set dataSourceGroup.externalDataSource with enabled: true.`
        : `${where}: ${enabled.length} enabled data sources; exactly one must be enabled.`,
    );
    return;
  }
  if (enabled[0] !== "externalDataSource") {
    warnings.push(`${where}: ${enabled[0]} is not checked by this tool; PuppyGraph checks it on upload.`);
    return;
  }

  const source = group.externalDataSource;
  const mapped: any[] = Array.isArray(source.mappedField) ? source.mappedField : [];
  if (mapped.length === 0) {
    problems.push(`${where}: externalDataSource has no mappedField entries.`);
  }

  // Declared columns and mapped targets must match each other.
  const declared = new Set([
    ...names(value.id),
    ...names(value.attribute),
    ...names(value.fromKey),
    ...names(value.toKey),
  ]);
  const targets = new Set<string>();
  const sourceOf = new Map<string, unknown>();
  mapped.forEach((field, index) => {
    const hasSource = typeof field?.sourceFieldName === "string" && field.sourceFieldName !== "";
    const hasExpression = typeof field?.sourceExpression === "string" && field.sourceExpression !== "";
    if (hasSource === hasExpression) {
      problems.push(`${where}: mappedField[${index}] must set exactly one of sourceFieldName or sourceExpression.`);
    }
    if (typeof field?.targetFieldName !== "string" || field.targetFieldName === "") {
      problems.push(`${where}: mappedField[${index}] has an empty targetFieldName.`);
    } else {
      // PuppyGraph accepts several mappings to one target and silently uses
      // one of them, so conflicting ones are an error here.
      const source = field.sourceFieldName ?? field.sourceExpression;
      if (targets.has(field.targetFieldName)) {
        const first = sourceOf.get(field.targetFieldName);
        if (first === source) {
          warnings.push(`${where}: target field '${field.targetFieldName}' is mapped twice from the same source; remove the duplicate.`);
        } else {
          problems.push(
            `${where}: target field '${field.targetFieldName}' is mapped more than once (from '${first}' and '${source}'); map each target exactly once.`,
          );
        }
      } else {
        sourceOf.set(field.targetFieldName, source);
      }
      targets.add(field.targetFieldName);
      if (!declared.has(field.targetFieldName)) {
        problems.push(
          `${where}: mapped target field '${field.targetFieldName}' is not declared in id, attribute${kind === "Edge" ? ", fromKey or toKey" : ""}.`,
        );
      }
    }
  });
  const unmapped = [...declared].filter((name) => !targets.has(name));
  if (mapped.length > 0 && unmapped.length > 0) {
    problems.push(
      `${where}: declares column(s) ${unmapped.join(", ")} but no mappedField targets them. Add {"sourceFieldName": "<table column>", "targetFieldName": "<name>"} for each.`,
    );
  }

  const { catalog, schema, table } = source;
  if (!catalog || !schema || !table) {
    problems.push(
      `${where}: externalDataSource needs catalog, schema and table (got catalog='${catalog ?? ""}', schema='${schema ?? ""}', table='${table ?? ""}').`,
    );
    return;
  }
  if (!ctx.embedded.has(catalog) && ctx.registered && !ctx.registered.has(catalog)) {
    const known = [...ctx.registered].join(", ") || "none";
    problems.push(
      `${where}: catalog '${catalog}' is not registered in PuppyGraph (registered: ${known}). Create it with puppygraph_create_catalog first.`,
    );
    return;
  }
  if (ctx.embedded.has(catalog) && !(ctx.registered?.has(catalog))) {
    warnings.push(
      `${where}: catalog '${catalog}' is defined inside the schema and not registered yet, so table and column names were not checked. PuppyGraph checks them on upload.`,
    );
    return;
  }

  const sourceColumns = await tableColumns(ctx, catalog, schema, table);
  if (typeof sourceColumns === "string") {
    problems.push(`${where}: cannot read table '${catalog}.${schema}.${table}': ${sourceColumns}`);
    return;
  }
  ctx.result.tablesChecked = ctx.columnCache.size;
  if (sourceColumns.length === 0) {
    // PuppyGraph answers an unknown table with an empty column list.
    problems.push(
      `${where}: table '${catalog}.${schema}.${table}' was not found (or has no columns). Check the database and table names with puppygraph_list_tables; names are case-sensitive.`,
    );
    return;
  }
  const columns = sourceColumns.map((column) => column.name);

  const available = new Set(columns);
  const aliases = new Set<string>();
  for (const unnest of Array.isArray(source.unnest) ? source.unnest : []) {
    for (const column of Array.isArray(unnest?.arrayColumn) ? unnest.arrayColumn : []) {
      if (column?.alias) aliases.add(column.alias);
    }
    if (unnest?.ordinalityAlias) aliases.add(unnest.ordinalityAlias);
  }
  for (const field of mapped) {
    const name = field?.sourceFieldName;
    if (typeof name !== "string" || name === "" || available.has(name) || aliases.has(name)) {
      continue;
    }
    const caseMatch = columns.find((column) => column.toLowerCase() === name.toLowerCase());
    if (caseMatch) {
      warnings.push(
        `${where}: mapped source field '${name}' matches column '${caseMatch}' in '${catalog}.${schema}.${table}' only when ignoring case. Use the exact column name if the upload fails.`,
      );
      continue;
    }
    const listed = columns.slice(0, MAX_LISTED_COLUMNS).join(", ");
    problems.push(
      `${where}: mapped source field '${name}' not found in remote table '${catalog}.${schema}.${table}'. Available columns: ${listed}${columns.length > MAX_LISTED_COLUMNS ? ", ..." : ""}`,
    );
  }
  checkTypes(where, value, mapped, sourceColumns, `${catalog}.${schema}.${table}`, problems);
}

/**
 * PuppyGraph only accepts a declared type equal to the source column's
 * schemaType, ignoring case and spaces: Int for a BIGINT column, Double for
 * DECIMAL(12,2) or DECIMAL(14,2) for DECIMAL(12,2) are all rejected on upload
 * (checked on 1.14.0 and main), so say so before uploading.
 */
function checkTypes(
  where: string,
  entity: Record<string, any>,
  mapped: any[],
  columns: SourceColumn[],
  tableName: string,
  problems: string[],
): void {
  const declaredType = new Map<string, unknown>();
  for (const list of ["id", "attribute", "fromKey", "toKey"]) {
    for (const column of Array.isArray(entity[list]) ? entity[list] : []) {
      if (typeof column?.name === "string") declaredType.set(column.name, column.type);
    }
  }
  const checked = new Set<string>();
  for (const field of mapped) {
    const sourceName = field?.sourceFieldName;
    const target = field?.targetFieldName;
    // A target mapped twice is already a problem; check only its first mapping.
    if (typeof sourceName !== "string" || typeof target !== "string" || checked.has(target)) continue;
    checked.add(target);
    const column =
      columns.find((candidate) => candidate.name === sourceName) ??
      columns.find((candidate) => candidate.name.toLowerCase() === sourceName.toLowerCase());
    const declared = declaredType.get(target);
    if (!column?.schemaType || typeof declared !== "string") continue;
    if (normalizeType(column.schemaType) === "UNKNOWN") {
      problems.push(
        `${where}: column '${sourceName}' of '${tableName}' has a source type PuppyGraph can't map (schemaType UNKNOWN, e.g. a Postgres ENUM). Leave it out of the schema.`,
      );
    } else if (normalizeType(declared) !== normalizeType(column.schemaType)) {
      problems.push(
        `${where}: '${target}' is declared as ${declared}, but column '${sourceName}' of '${tableName}' has schemaType ${column.schemaType}. Declare it as ${column.schemaType}: PuppyGraph rejects any other type (e.g. Long for INT, Double for DECIMAL).`,
      );
    }
  }
}

export function normalizeType(type: string): string {
  return type.replace(/\s+/g, "").toUpperCase();
}

function sourceOfTarget(entity: Record<string, any>, target: string): string | undefined {
  const mapped = entity?.dataSourceGroup?.externalDataSource?.mappedField;
  const field = Array.isArray(mapped) ? mapped.find((item: any) => item?.targetFieldName === target) : undefined;
  return field?.sourceFieldName;
}

function sourceTable(entity: Record<string, any>): string | undefined {
  const source = entity?.dataSourceGroup?.externalDataSource;
  return source?.enabled && source.catalog && source.schema && source.table
    ? JSON.stringify([source.catalog, source.schema, source.table])
    : undefined;
}

/**
 * Edge keys must line up with the ids of the nodes they point at: as many
 * columns, of the same types. PuppyGraph accepts a mismatch and the edge then
 * matches no node (or the wrong ones). Also warns when an edge read from a
 * node's own table keys that node by a column other than its id, which is
 * what a swapped from/to looks like.
 */
function checkEdgeKeys(nodes: Record<string, any>[], edges: Record<string, any>[], result: ValidationResult): void {
  const byLabel = new Map(nodes.map((node) => [node?.label, node]));
  for (const edge of edges) {
    const where = `Edge '${edge.label ?? "?"}'`;
    const sides = [
      { keys: "fromKey", label: edge.fromNodeLabel, role: "source" },
      { keys: "toKey", label: edge.toNodeLabel, role: "target" },
    ] as const;
    const idMatches: boolean[] = [];
    const sameTable: boolean[] = [];
    for (const side of sides) {
      const node = byLabel.get(side.label);
      const keys: any[] = Array.isArray(edge[side.keys]) ? edge[side.keys] : [];
      const ids: any[] = Array.isArray(node?.id) ? node.id : [];
      if (!node || keys.length === 0 || ids.length === 0) {
        idMatches.push(true);
        sameTable.push(false);
        continue;
      }
      if (keys.length !== ids.length) {
        result.problems.push(
          `${where}: ${side.keys} has ${keys.length} column(s) but node '${side.label}' has an id of ${ids.length} column(s) (${ids.map((id) => id?.name).join(", ")}). Give ${side.keys} one column per id column, in the same order.`,
        );
      } else {
        keys.forEach((key, index) => {
          const id = ids[index];
          if (typeof key?.type === "string" && typeof id?.type === "string" && normalizeType(key.type) !== normalizeType(id.type)) {
            result.problems.push(
              `${where}: ${side.keys} column '${key.name}' is ${key.type} but node '${side.label}' id column '${id.name}' is ${id.type}. A key of another type matches no '${side.label}' node: check that the column really holds '${side.label}' ids.`,
            );
          }
        });
      }
      const edgeTable = sourceTable(edge);
      // A key-count mismatch is already a problem; don't also guess at direction.
      const isSame = keys.length === ids.length && edgeTable !== undefined && edgeTable === sourceTable(node);
      sameTable.push(isSame);
      if (isSame) {
        const keySources = keys.map((key) => sourceOfTarget(edge, key?.name));
        const idSources = ids.map((id) => sourceOfTarget(node, id?.name));
        idMatches.push(keySources.every((source, index) => source !== undefined && source === idSources[index]));
      } else {
        idMatches.push(true);
      }
    }
    const selfEdge = edge.fromNodeLabel === edge.toNodeLabel;
    const suspicious = selfEdge
      ? sameTable[0] && sameTable[1] && !idMatches[0] && !idMatches[1]
      : sides.some((_side, index) => sameTable[index] && !idMatches[index]);
    if (suspicious) {
      result.warnings.push(
        `${where}: it reads the table of '${selfEdge ? edge.fromNodeLabel : sides.find((_s, i) => sameTable[i] && !idMatches[i])!.label}', but keys that node by a column other than its id. If the edge points the other way, swap fromNodeLabel/toNodeLabel with fromKey/toKey. Check the direction with puppygraph_check_edges after uploading.`,
      );
    }
  }
}

function tableColumns(
  ctx: CheckContext,
  catalog: string,
  schema: string,
  table: string,
): Promise<SourceColumn[] | string> {
  const key = JSON.stringify([catalog, schema, table]);
  let pending = ctx.columnCache.get(key);
  if (!pending) {
    pending = ctx.rest
      .request("GET", "/ui-api/column", {
        query: { catalogName: catalog, databaseName: schema, tableName: table },
      })
      .then((response) => {
        throwIfAccessDenied(response, `read the columns of '${catalog}.${schema}.${table}'`);
        const body = response.body as any;
        if (response.ok && body && Array.isArray(body.column)) {
          return (body.column as any[])
            .filter((column) => typeof column?.name === "string" && column.name !== "")
            .map((column) => ({
              name: column.name as string,
              schemaType: typeof column.schemaType === "string" ? column.schemaType : undefined,
            }));
        }
        return `${responseError(response.body, ctx.secrets)} (check the schema and table names with puppygraph_list_tables)`;
      });
    ctx.columnCache.set(key, pending);
  }
  return pending;
}
