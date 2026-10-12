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

function throwIfAccessDenied(response: RestResponse, action: string): void {
  if (response.status === 401 || response.status === 403) {
    throw new UpstreamHttpError(response, action);
  }
}

type Entity = { kind: "Node" | "Edge"; value: Record<string, any> };

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

  const columnCache = new Map<string, Promise<string[] | string>>();
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
  columnCache: Map<string, Promise<string[] | string>>;
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

  const columns = await tableColumns(ctx, catalog, schema, table);
  if (typeof columns === "string") {
    problems.push(`${where}: cannot read table '${catalog}.${schema}.${table}': ${columns}`);
    return;
  }
  ctx.result.tablesChecked = ctx.columnCache.size;

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
}

function tableColumns(
  ctx: CheckContext,
  catalog: string,
  schema: string,
  table: string,
): Promise<string[] | string> {
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
          return names(body.column);
        }
        return `${responseError(response.body, ctx.secrets)} (check the schema and table names with puppygraph_list_tables)`;
      });
    ctx.columnCache.set(key, pending);
  }
  return pending;
}
