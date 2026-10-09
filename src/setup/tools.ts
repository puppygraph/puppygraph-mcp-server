import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  RestConnectionError,
  type PuppyGraphRestLike,
  type RestResponse,
} from "../clients/rest.js";
import { createRequestId, errorCategory } from "../utils/logging.js";
import { collectSecrets, maskSecrets, MASK, scrubText } from "../utils/redact.js";
import { SCHEMA_TEMPLATE, SCHEMA_TEMPLATE_NOTES } from "./template.js";
import { responseError, UpstreamHttpError, validateSchema } from "./validate.js";

/**
 * Tools that take an agent from an empty PuppyGraph to a queryable graph:
 * register a catalog, explore its tables, write a schema, check it, install it.
 *
 * Write tools (create_catalog, upload_schema) are not registered in read-only
 * mode, and refuse if called anyway.
 */

export type SetupErrorCode =
  | "READ_ONLY"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "VALIDATION_FAILED"
  | "REPLACE_REQUIRED"
  | "AUTHENTICATION_FAILED"
  | "PERMISSION_DENIED"
  | "CONNECTION_FAILED"
  | "TIMEOUT"
  | "UPSTREAM_ERROR";

class SetupError extends Error {
  constructor(
    readonly code: SetupErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SetupError";
  }
}

// Driver classes for the common JDBC catalog types, as the PuppyGraph UI
// fills them in.
const JDBC_DRIVERS: Record<string, string> = {
  postgresql: "org.postgresql.Driver",
  alloydb: "org.postgresql.Driver",
  mysql8: "com.mysql.cj.jdbc.Driver",
  mysql5: "com.mysql.jdbc.Driver",
  mariadb: "org.mariadb.jdbc.Driver",
  sqlserver: "com.microsoft.sqlserver.jdbc.SQLServerDriver",
  redshift: "com.amazon.redshift.Driver",
  snowflake: "net.snowflake.client.jdbc.SnowflakeDriver",
  duckdb: "org.duckdb.DuckDBDriver",
  clickhouse: "com.clickhouse.jdbc.ClickHouseDriver",
  oracle: "oracle.jdbc.OracleDriver",
  trino: "io.trino.jdbc.TrinoDriver",
  presto: "com.facebook.presto.jdbc.PrestoDriver",
  vertica: "com.vertica.jdbc.Driver",
  singlestore: "com.singlestore.jdbc.Driver",
};

const CATALOG_TYPES_HINT =
  "JDBC: postgresql, mysql8, mysql5, mariadb, sqlserver, redshift, snowflake, duckdb, clickhouse, oracle, trino, presto, vertica, singlestore, alloydb. Others (pass their fields in options): iceberg, hive, hudi, deltalake, bigquery, databricks, mongodb, elasticsearch, spanner";

const UPLOAD_TIMEOUT_MS = 10 * 60_000;
const CATALOG_TIMEOUT_MS = 5 * 60_000;

function textResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function errorFromResponse(
  response: RestResponse,
  action: string,
  secrets: readonly string[],
): SetupError {
  const message = responseError(response.body, secrets);
  if (response.status === 401) {
    return new SetupError(
      "AUTHENTICATION_FAILED",
      `PuppyGraph rejected the HTTP API credentials while trying to ${action}. Check PUPPYGRAPH_SCHEMA_USERNAME / PUPPYGRAPH_SCHEMA_PASSWORD in the MCP server configuration.`,
    );
  }
  if (response.status === 403) {
    return new SetupError("PERMISSION_DENIED", `Not allowed to ${action}: ${message}`);
  }
  if (response.status === 404) {
    return new SetupError(
      "UPSTREAM_ERROR",
      `This PuppyGraph server has no endpoint to ${action} (HTTP 404). These tools need PuppyGraph 1.x.`,
    );
  }
  return new SetupError("UPSTREAM_ERROR", `Failed to ${action}: ${message}`);
}

async function call(
  rest: PuppyGraphRestLike,
  method: "GET" | "POST",
  path: string,
  action: string,
  options: { query?: Record<string, string>; body?: unknown; timeoutMs?: number } = {},
  secrets: readonly string[] = [],
): Promise<any> {
  const response = await rest.request(method, path, options);
  if (!response.ok) {
    throw errorFromResponse(response, action, secrets);
  }
  return response.body;
}

async function listCatalogNames(rest: PuppyGraphRestLike): Promise<any[]> {
  const body = await call(rest, "GET", "/ui-api/catalog", "list catalogs");
  return Array.isArray(body?.catalogs) ? body.catalogs : [];
}

async function requireCatalog(rest: PuppyGraphRestLike, name: string): Promise<void> {
  const catalogs = await listCatalogNames(rest);
  if (!catalogs.some((catalog) => catalog?.name === name)) {
    const known = catalogs.map((catalog) => catalog?.name).filter(Boolean);
    throw new SetupError(
      "NOT_FOUND",
      `Catalog '${name}' not found. Registered catalogs: ${known.length ? known.join(", ") : "none"}. Create it with puppygraph_create_catalog.`,
    );
  }
}

/** Short description of a catalog for tool output; credentials masked. */
function catalogSummary(catalog: any): Record<string, unknown> {
  const { name, type, ...rest } = catalog || {};
  return maskSecrets({ name, type, ...rest });
}

function liveSchemaSummary(schema: any) {
  // Fail closed: anything but an object whose node/edge fields are absent or
  // arrays could hide an installed schema from the replace guard.
  const shapeOk =
    schema !== null &&
    typeof schema === "object" &&
    !Array.isArray(schema) &&
    (schema.node === undefined || Array.isArray(schema.node)) &&
    (schema.edge === undefined || Array.isArray(schema.edge));
  if (!shapeOk) {
    throw new SetupError(
      "UPSTREAM_ERROR",
      "Could not tell whether a schema is installed (unexpected response from GET /schemajson); nothing was uploaded.",
    );
  }
  const nodes = schema.node ?? [];
  const edges = schema.edge ?? [];
  return {
    node_labels: nodes.map((node: any) => node?.label),
    edge_labels: edges.map((edge: any) => edge?.label),
    empty: nodes.length === 0 && edges.length === 0,
  };
}

async function liveVersion(rest: PuppyGraphRestLike): Promise<number | null> {
  const response = await rest.request("GET", "/ui-api/schema/versions", {
    query: { limit: "50" },
  });
  const versions = (response.body as any)?.versions;
  if (!response.ok || !Array.isArray(versions)) {
    return null;
  }
  const live = versions.find((version: any) => version?.isLive) || versions[0];
  return typeof live?.version === "number" ? live.version : null;
}

// password_env / secret_env may only name variables with this prefix, or
// ones the operator lists in SECRET_ENV_ALLOWLIST. The agent picks the
// variable name, so without this rule an agent could send any secret of the
// MCP server's process (e.g. a cloud key) to a database host it chose.
export const SECRET_ENV_PREFIX = "PUPPYGRAPH_SECRET_";
export const SECRET_ENV_ALLOWLIST = "PUPPYGRAPH_MCP_SECRET_ENV_ALLOWLIST";

function isAllowedSecretEnv(environment: NodeJS.ProcessEnv, variable: string): boolean {
  if (variable.startsWith(SECRET_ENV_PREFIX) && variable.length > SECRET_ENV_PREFIX.length) {
    return true;
  }
  return (environment[SECRET_ENV_ALLOWLIST] || "")
    .split(",")
    .map((name) => name.trim())
    .some((name) => name !== "" && name === variable);
}

function readEnvSecret(environment: NodeJS.ProcessEnv, variable: string): string {
  // The refusal must not depend on whether the variable exists.
  if (!isAllowedSecretEnv(environment, variable)) {
    throw new SetupError(
      "INVALID_INPUT",
      `Environment variable ${variable} can't be used for catalog secrets. Allowed: names starting with ${SECRET_ENV_PREFIX} (e.g. ${SECRET_ENV_PREFIX}PG_PASSWORD), or names the operator lists in ${SECRET_ENV_ALLOWLIST}. Ask the user to set one in the MCP server's configuration, or pass the value directly.`,
    );
  }
  const value = environment[variable];
  if (value === undefined || value === "") {
    throw new SetupError(
      "INVALID_INPUT",
      `Environment variable ${variable} is not set in the MCP server's environment. Add it to the server's env configuration, or pass the value directly.`,
    );
  }
  return value;
}

type Handler<A> = (args: A, log: (message: string) => void) => Promise<unknown>;

function runTool<A>(name: string, handler: Handler<A>, secretsOf: (args: A) => string[] = () => []) {
  return async (args: A) => {
    const requestId = createRequestId();
    const log = (message: string) =>
      console.error(`Tool ${name} request_id=${requestId} ${message}`);
    let secrets: string[] = [];
    try {
      secrets = secretsOf(args);
      log("started");
      const value = await handler(args, log);
      log("completed");
      return textResult(maskSecrets(value, secrets));
    } catch (error: any) {
      let code: SetupErrorCode = "UPSTREAM_ERROR";
      let message = "Unexpected error";
      let details: Record<string, unknown> = {};
      if (error instanceof UpstreamHttpError) {
        error = errorFromResponse(error.response, error.action, secrets);
      }
      if (error instanceof SetupError) {
        ({ code, message, details } = error);
      } else if (error instanceof RestConnectionError) {
        code = error.timedOut ? "TIMEOUT" : "CONNECTION_FAILED";
        message = `${error.message}. Check that PuppyGraph is running and PUPPYGRAPH_HTTP_URL points at its web port (8081 by default).`;
      }
      log(`failed error_type=${code} error_category=${errorCategory(error)}`);
      return textResult(
        maskSecrets(
          { ok: false, error: scrubText(message, secrets), error_type: code, ...details },
          secrets,
        ),
        true,
      );
    }
  };
}

export interface SetupToolOptions {
  readOnly: boolean;
  environment: NodeJS.ProcessEnv;
}

export function registerSetupTools(
  server: McpServer,
  rest: PuppyGraphRestLike,
  { readOnly, environment }: SetupToolOptions,
): void {
  const refuseIfReadOnly = (tool: string) => {
    if (readOnly) {
      throw new SetupError(
        "READ_ONLY",
        `${tool} is disabled: the PuppyGraph MCP server is in read-only mode. Restart it without PUPPYGRAPH_READ_ONLY / --read-only to change catalogs or the schema.`,
      );
    }
  };

  server.registerTool(
    "puppygraph_list_catalogs",
    {
      description:
        "List the data source catalogs registered in PuppyGraph (name, type, connection; credentials masked). A graph schema reads its tables through these catalogs.",
      inputSchema: {},
    },
    runTool("puppygraph_list_catalogs", async () => {
      const catalogs = await listCatalogNames(rest);
      return { catalogs: catalogs.map(catalogSummary) };
    }),
  );

  if (!readOnly) {
    server.registerTool(
      "puppygraph_create_catalog",
      {
        description:
          "Register a data source (database, warehouse or lake) as a PuppyGraph catalog, so a graph schema can map its tables. PuppyGraph connects to the source to check the settings before saving. Credentials are never returned or logged. Next: puppygraph_list_tables, then write a schema.",
        inputSchema: {
          name: z.string().min(1).describe("Catalog name, used as 'catalog' in the schema"),
          type: z.string().min(1).describe(`Catalog type. ${CATALOG_TYPES_HINT}`),
          jdbc_uri: z
            .string()
            .optional()
            .describe("JDBC URI for JDBC types, e.g. jdbc:postgresql://host:5432/dbname. The host must be reachable from the PuppyGraph server (from a container, not 'localhost' of the agent)."),
          username: z.string().optional().describe("Database user (JDBC types)"),
          password: z.string().optional().describe("Database password (JDBC types). Prefer password_env when the password is in the MCP server's environment."),
          password_env: z
            .string()
            .optional()
            .describe("Name of an environment variable of the MCP server that holds the password (must start with PUPPYGRAPH_SECRET_ or be listed in PUPPYGRAPH_MCP_SECRET_ENV_ALLOWLIST), so the password never passes through the conversation"),
          driver_class: z
            .string()
            .optional()
            .describe("JDBC driver class; defaults by type (e.g. org.postgresql.Driver)"),
          options: z
            .record(z.any())
            .optional()
            .describe("Extra catalog fields as the PuppyGraph catalog form takes them, for non-JDBC types (e.g. metastore and storage settings for iceberg)"),
          secret_env: z
            .record(z.string())
            .optional()
            .describe("Map of option field name to MCP server environment variable name (same rule as password_env), for secrets in options (e.g. {\"secretKey\": \"PUPPYGRAPH_SECRET_S3_KEY\"})"),
        },
      },
      runTool(
        "puppygraph_create_catalog",
        async (args, log) => {
          refuseIfReadOnly("puppygraph_create_catalog");
          if (args.password !== undefined && args.password_env !== undefined) {
            throw new SetupError("INVALID_INPUT", "Pass either password or password_env, not both.");
          }
          const password =
            args.password_env !== undefined
              ? readEnvSecret(environment, args.password_env)
              : args.password;
          const options: Record<string, unknown> = { ...(args.options || {}) };
          const envSecrets: string[] = [];
          for (const [field, variable] of Object.entries(args.secret_env || {})) {
            options[field] = readEnvSecret(environment, variable);
            envSecrets.push(options[field] as string);
          }
          const isJdbc = args.type in JDBC_DRIVERS || args.jdbc_uri !== undefined;
          if (isJdbc && !args.jdbc_uri && !("jdbcUri" in options)) {
            throw new SetupError("INVALID_INPUT", `jdbc_uri is required for catalog type '${args.type}'.`);
          }
          const catalog: Record<string, unknown> = {
            ...options,
            catalogName: args.name,
            catalogType: args.type,
          };
          if (isJdbc) {
            if (args.jdbc_uri !== undefined) catalog.jdbcUri = args.jdbc_uri;
            if (args.username !== undefined) catalog.jdbcUsername = args.username;
            if (password !== undefined) catalog.jdbcPassword = password;
            const driver = args.driver_class || JDBC_DRIVERS[args.type];
            if (driver) catalog.driverClass = driver;
          } else if (args.username !== undefined || password !== undefined) {
            throw new SetupError(
              "INVALID_INPUT",
              `username/password apply to JDBC catalog types only; pass the credentials for '${args.type}' in options (with secret_env for secrets).`,
            );
          }
          // Everything secret that is sent, whatever field it is in, so it
          // can be scrubbed from whatever comes back.
          const secrets = [
            ...collectSecrets(catalog),
            ...(password ? [password] : []),
            ...envSecrets,
          ];
          log(`catalog=${JSON.stringify(args.name)} type=${JSON.stringify(args.type)}`);

          const response = await rest.request("POST", "/ui-api/catalog", {
            body: { catalogs: [catalog] },
            timeoutMs: CATALOG_TIMEOUT_MS,
          });
          if (!response.ok) {
            const error = errorFromResponse(response, `create catalog '${args.name}'`, secrets);
            if (/already exists/i.test(error.message)) {
              throw new SetupError(
                "ALREADY_EXISTS",
                `A catalog named '${args.name}' already exists. Use it as is (check it with puppygraph_test_catalog), or pick another name.`,
              );
            }
            throw error;
          }
          // Only the masked catalog definition goes back to the agent, never
          // the response body as-is.
          const created = Array.isArray((response.body as any)?.catalogs)
            ? (response.body as any).catalogs[0]
            : undefined;
          return {
            ok: true,
            catalog: maskSecrets(
              created
                ? catalogSummary(created)
                : { name: args.name, type: args.type, jdbcUri: args.jdbc_uri },
              secrets,
            ),
            next: `List its tables with puppygraph_list_tables (catalog '${args.name}').`,
          };
        },
        (args) => [
          ...(args.password ? [args.password] : []),
          ...collectSecrets(args.options || {}),
        ],
      ),
    );
  }

  server.registerTool(
    "puppygraph_test_catalog",
    {
      description:
        "Check that PuppyGraph can connect to a registered catalog and read data through it.",
      inputSchema: { catalog: z.string().min(1).describe("Catalog name") },
    },
    runTool("puppygraph_test_catalog", async ({ catalog }: { catalog: string }) => {
      await requireCatalog(rest, catalog);
      const body = await call(rest, "GET", "/ui-api/validateCatalog", `test catalog '${catalog}'`, {
        query: { catalogName: catalog },
        timeoutMs: CATALOG_TIMEOUT_MS,
      });
      const ok = body?.ok === true;
      const message = body?.validate_message ?? body?.validateMessage ?? body?.message ?? null;
      if (!ok) {
        throw new SetupError("UPSTREAM_ERROR", `Catalog '${catalog}' failed the check: ${message ?? "no details"}`);
      }
      return { ok, catalog, message };
    }),
  );

  server.registerTool(
    "puppygraph_list_tables",
    {
      description:
        "List the databases/schemas of a catalog, or the tables in one of them. Use the names exactly as returned in the graph schema (externalDataSource.schema and .table).",
      inputSchema: {
        catalog: z.string().min(1).describe("Catalog name"),
        database: z
          .string()
          .optional()
          .describe("Database or schema name (e.g. 'public'). Omit to list the databases first."),
      },
    },
    runTool(
      "puppygraph_list_tables",
      async ({ catalog, database }: { catalog: string; database?: string }) => {
        await requireCatalog(rest, catalog);
        if (!database) {
          const body = await call(rest, "GET", "/ui-api/database", `list databases of '${catalog}'`, {
            query: { catalogName: catalog },
          });
          return {
            catalog,
            databases: body?.database ?? [],
            next: "Call again with database set to list its tables.",
          };
        }
        const body = await call(
          rest,
          "GET",
          "/ui-api/table",
          `list tables of '${catalog}.${database}' (check the database name with puppygraph_list_tables without database)`,
          { query: { catalogName: catalog, databaseName: database } },
        );
        return { catalog, database, tables: body?.table ?? [] };
      },
    ),
  );

  server.registerTool(
    "puppygraph_describe_table",
    {
      description:
        "List the columns of a table in a catalog: name, source type, and schemaType (the PuppyGraph type to use for it in the graph schema).",
      inputSchema: {
        catalog: z.string().min(1).describe("Catalog name"),
        database: z.string().min(1).describe("Database or schema name"),
        table: z.string().min(1).describe("Table name"),
      },
    },
    runTool(
      "puppygraph_describe_table",
      async ({ catalog, database, table }: { catalog: string; database: string; table: string }) => {
        await requireCatalog(rest, catalog);
        const body = await call(
          rest,
          "GET",
          "/ui-api/column",
          `describe '${catalog}.${database}.${table}' (check the names with puppygraph_list_tables)`,
          { query: { catalogName: catalog, databaseName: database, tableName: table } },
        );
        return { catalog, database, table, columns: body?.column ?? [] };
      },
    ),
  );

  server.registerTool(
    "puppygraph_schema_template",
    {
      description:
        "Get an annotated example of a PuppyGraph 1.x graph schema (nodes and edges mapped from tables), to adapt before validating and uploading.",
      inputSchema: {},
    },
    runTool("puppygraph_schema_template", async () => ({
      notes: SCHEMA_TEMPLATE_NOTES,
      template: SCHEMA_TEMPLATE,
    })),
  );

  const schemaInput = z
    .union([z.record(z.any()), z.string()])
    .describe("The graph schema as a JSON object (or a JSON string): 1.x format with node and edge arrays");

  server.registerTool(
    "puppygraph_validate_schema",
    {
      description:
        "Dry-run a graph schema without changing anything: checks its structure, that catalogs, tables and mapped columns exist, and that edges point at defined nodes. Converts 0.x schemas to 1.x. Run this before puppygraph_upload_schema.",
      inputSchema: { schema: schemaInput },
    },
    runTool(
      "puppygraph_validate_schema",
      async ({ schema }: { schema: unknown }) => {
        const result = await validateSchema(rest, schema);
        return {
          valid: result.valid,
          problems: result.problems,
          warnings: result.warnings,
          tables_checked: result.tablesChecked,
          converted_from_0x: result.convertedFrom0x,
          ...(result.convertedFrom0x ? { converted_schema: result.schema } : {}),
        };
      },
      ({ schema }: { schema: unknown }) => secretsOfSchema(schema),
    ),
  );

  if (!readOnly) {
    server.registerTool(
      "puppygraph_upload_schema",
      {
        description:
          "Install a graph schema in PuppyGraph so it can be queried. Validates it first and refuses on problems; PuppyGraph also checks every mapped table and column before changing anything. If a schema is already installed, it is only replaced when replace is true. On failure the installed schema stays as it was.",
        inputSchema: {
          schema: schemaInput,
          replace: z
            .boolean()
            .optional()
            .describe("Set true to replace the schema that is currently installed. Without it, the upload is refused when a schema is already installed."),
        },
      },
      runTool(
        "puppygraph_upload_schema",
        async ({ schema, replace }: { schema: unknown; replace?: boolean }, log) => {
          refuseIfReadOnly("puppygraph_upload_schema");
          const validation = await validateSchema(rest, schema);
          if (!validation.valid) {
            throw new SetupError(
              "VALIDATION_FAILED",
              "The schema has problems; nothing was uploaded. Fix them and try again.",
              { problems: validation.problems, warnings: validation.warnings },
            );
          }

          const live = await call(rest, "GET", "/schemajson", "read the installed schema");
          const liveSummary = liveSchemaSummary(live);
          const previousVersion = liveSummary.empty ? null : await liveVersion(rest);
          if (!liveSummary.empty && replace !== true) {
            throw new SetupError(
              "REPLACE_REQUIRED",
              `A schema is already installed (version ${previousVersion ?? "unknown"}: nodes ${liveSummary.node_labels.join(", ") || "none"}; edges ${liveSummary.edge_labels.join(", ") || "none"}). Uploading replaces it for everyone who queries this PuppyGraph. Call again with replace: true only if that is intended.`,
              { installed_version: previousVersion, installed: { nodes: liveSummary.node_labels, edges: liveSummary.edge_labels } },
            );
          }

          // Send the schema that was validated: for a 0.x input that is the
          // converted 1.x schema, which also works on servers that don't
          // convert 0.x on upload (1.13 and older).
          const parsed = validation.schema;
          const secrets = secretsOfSchema(parsed);
          log(`replace=${replace === true} nodes=${(validation.schema?.node || []).length} edges=${(validation.schema?.edge || []).length}`);
          const response = await rest.request("POST", "/schema", {
            query: { preflight: "true" },
            body: parsed,
            timeoutMs: UPLOAD_TIMEOUT_MS,
          });
          const body = (response.body && typeof response.body === "object" ? response.body : {}) as any;
          if (!response.ok || body.ok !== true) {
            if (response.status === 401 || response.status === 403) {
              throw errorFromResponse(response, "upload the schema", secrets);
            }
            throw new SetupError(
              "UPSTREAM_ERROR",
              `PuppyGraph rejected the schema; the installed schema is unchanged. ${responseError(response.body, secrets)}`,
              { warnings: validation.warnings },
            );
          }
          return {
            ok: true,
            version: body.version ?? null,
            previous_version: previousVersion,
            message: body.message ?? "Schema uploaded",
            warnings: [...validation.warnings, ...(Array.isArray(body.warnings) ? body.warnings : [])],
            next: "Query the graph with puppygraph_query, e.g. MATCH (n) RETURN labels(n), count(*).",
          };
        },
        ({ schema }: { schema: unknown }) => secretsOfSchema(schema),
      ),
    );
  }
}

function secretsOfSchema(schema: unknown): string[] {
  if (typeof schema === "string") {
    try {
      return collectSecrets(JSON.parse(schema));
    } catch {
      return [];
    }
  }
  return collectSecrets(schema).filter((secret) => secret !== MASK);
}
