import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PuppyGraphRestLike } from "../clients/rest.js";
import {
  call,
  errorFromResponse,
  listCatalogNames,
  liveVersion,
  requireCatalog,
  runTool,
  SetupError,
  textResult,
} from "./common.js";
import {
  dockerHostJdbcUri,
  isLoopbackJdbcUri,
  LOCALHOST_HINT,
  looksUnreachable,
} from "../utils/jdbc.js";
import { collectSecrets, maskSecrets, MASK, scrubText } from "../utils/redact.js";
import { catalogSpec, catalogTypes, checkCatalogValues, isKnownCatalogType } from "./catalog-spec.js";
import { guideMarkdown } from "../guide.js";
import { type CypherRunner, type GremlinRunner, registerSchemaTools, schemaDiff, waitUntilQueryable, withSchemaLock } from "./schema-tools.js";
import { SCHEMA_TEMPLATE, SCHEMA_TEMPLATE_NOTES } from "./template.js";
import { responseError, validateSchema } from "./validate.js";

/**
 * Tools that take an agent from an empty PuppyGraph to a queryable graph:
 * register a catalog, explore its tables, write a schema, check it, install it.
 *
 * Write tools (create_catalog, upload_schema) are not registered in read-only
 * mode, and refuse if called anyway.
 */

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
  "JDBC: postgresql, mysql8, mysql5, mariadb, sqlserver, redshift, snowflake, duckdb, clickhouse, oracle, trino, presto, vertica, singlestore, alloydb. Others (pass their fields in options): iceberg, hive, hudi, deltalake, bigquery, databricks, mongodbAtlas, elasticsearch, spanner. puppygraph_catalog_spec gives every type's exact field names";

// PuppyGraph doesn't ship the MySQL drivers; the catalog form asks for a
// download URL. These are the official connectors on Maven Central.
const MYSQL_DRIVER_URLS: Record<string, string> = {
  mysql8: "https://repo1.maven.org/maven2/com/mysql/mysql-connector-j/8.4.0/mysql-connector-j-8.4.0.jar",
  mysql5: "https://repo1.maven.org/maven2/mysql/mysql-connector-java/5.1.49/mysql-connector-java-5.1.49.jar",
};

/**
 * What to change for the catalog errors agents run into most, in the spirit
 * of PuppyGraph AI's catalog result explanations. Returns undefined when
 * there is nothing more specific to say.
 */
export function catalogErrorHint(message: string, type: string, jdbcUri: string | undefined): Record<string, unknown> | undefined {
  if (/locate the driver|driverUrl/i.test(message)) {
    return {
      hint: `PuppyGraph doesn't include the driver for '${type}'. Pass driver_url with a URL PuppyGraph can download the driver jar from${MYSQL_DRIVER_URLS[type] ? `, e.g. the official connector: ${MYSQL_DRIVER_URLS[type]}` : ""}.`,
      ...(MYSQL_DRIVER_URLS[type] ? { suggested_driver_url: MYSQL_DRIVER_URLS[type] } : {}),
    };
  }
  if (/public key is not available|allowPublicKeyRetrieval/i.test(message) && jdbcUri) {
    const separator = jdbcUri.includes("?") ? "&" : "?";
    return {
      hint: "MySQL 8's default authentication needs the server's public key over a non-TLS connection. Add allowPublicKeyRetrieval=true (and useSSL=false if the server has no TLS) to the JDBC URI.",
      suggested_jdbc_uri: /allowPublicKeyRetrieval/i.test(jdbcUri) ? jdbcUri : `${jdbcUri}${separator}allowPublicKeyRetrieval=true&useSSL=false`,
    };
  }
  if (/unknown (metastoreType|storageType|catalogType)|metastoreType:|is required/i.test(message)) {
    return { hint: `The catalog fields are incomplete or misnamed. Call puppygraph_catalog_spec with type '${type}' for the exact field names, and pass them in options.` };
  }
  if (/authentication failed|access denied|password|login failed|unauthorized|invalid credentials/i.test(message)) {
    return {
      hint: "The data source rejected the login. Check the username and the authentication settings. Don't ask the user to paste a password into the conversation: have them put it in an environment variable of the MCP server (PUPPYGRAPH_SECRET_...) and pass password_env.",
    };
  }
  if (/duckdb/i.test(message) && /does not exist|cannot open|no such file/i.test(message)) {
    return {
      hint: "The DuckDB path is read inside the PuppyGraph server (container), not on this machine. Mount the .duckdb file into the container (e.g. docker run -v /host/dir:/files ...) and use jdbc:duckdb:/files/<name>.duckdb. To load CSV or Parquet files, create tables or views in that DuckDB file first. Files on S3 need an Iceberg, Delta Lake or Hive catalog instead: DuckDB S3 settings aren't saved in the file.",
    };
  }
  if (/in-memory database in read-only mode/i.test(message)) {
    return { hint: "PuppyGraph opens DuckDB read-only, so jdbc:duckdb: (in memory) can't work. Point jdbc_uri at a .duckdb file inside the PuppyGraph container." };
  }
  return undefined;
}

const UPLOAD_TIMEOUT_MS = 10 * 60_000;
const CATALOG_TIMEOUT_MS = 5 * 60_000;
// PuppyGraph gives up on a probe after 1 minute (sample), 5 minutes (profile,
// row count) or 10 minutes (join check); wait a little longer than that.
const SAMPLE_TIMEOUT_MS = 90_000;
const PROFILE_TIMEOUT_MS = 6 * 60_000;
const JOIN_TIMEOUT_MS = 11 * 60_000;

/**
 * A connection failure to a loopback JDBC host, as PuppyGraph in Docker
 * reports it: say why and suggest the URI to retry with. Other errors pass
 * through unchanged.
 */
function withLocalhostHint(error: SetupError, jdbcUri: string | undefined): SetupError {
  if (!jdbcUri || !isLoopbackJdbcUri(jdbcUri) || !looksUnreachable(error.message)) {
    return error;
  }
  return new SetupError("HOST_UNREACHABLE_FROM_PUPPYGRAPH", error.message, {
    ...error.details,
    hint: LOCALHOST_HINT,
    suggested_jdbc_uri: dockerHostJdbcUri(jdbcUri),
  });
}

async function probe(
  rest: PuppyGraphRestLike,
  route: string,
  action: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<any> {
  const response = await rest.request("POST", `/ui-api/catalog/probe/${route}`, { body, timeoutMs });
  const result = response.body as any;
  const code = result?.code;
  if (response.status === 404 && code !== "catalog_not_found") {
    throw new SetupError(
      "NOT_SUPPORTED",
      "This PuppyGraph version can't probe source data (the probe endpoints came after 1.14). Choose ids and edges from the column names and types in puppygraph_describe_table and tell the user that the keys and joins are unverified until checked; after uploading, run puppygraph_check_edges, which checks every edge against the data on any PuppyGraph 1.x.",
    );
  }
  if (!response.ok) {
    const message = responseError(response.body, []);
    if (code === "catalog_not_found") {
      throw new SetupError("NOT_FOUND", `${message}. List the catalogs with puppygraph_list_catalogs.`);
    }
    if (code === "invalid_request") {
      throw new SetupError("INVALID_INPUT", message);
    }
    if (response.status === 403 && code === undefined) {
      throw new SetupError(
        "PERMISSION_DENIED",
        `Not allowed to ${action}: ${message}. Probing source data needs the DATA:read permission; without it, choose ids and edges from column names and types and tell the user they are unverified.`,
      );
    }
    throw errorFromResponse(response, action, []);
  }
  if (result?.ok === false) {
    throw new SetupError("UPSTREAM_ERROR", `Failed to ${action}: ${responseError(result.error_message || "no details", [])}`);
  }
  return result;
}

// Integers past 2^53 (e.g. BIGINT ids) come back as strings, so the agent
// sees the exact value.
function exactInteger(digits: string): number | string {
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : digits;
}

function parseRow(row: string): unknown {
  return JSON.parse(
    row.replace(/"(?:[^"\\]|\\.)*"|(?<![\d.eE+-])-?\d{16,}(?![.\deE])/g, (token) =>
      token.startsWith('"') || Number.isSafeInteger(Number(token)) ? token : `"${token}"`,
    ),
  );
}

function closestNames(name: string, candidates: string[], limit = 5): string[] {
  const lower = name.toLowerCase();
  const score = (candidate: string) => {
    const other = candidate.toLowerCase();
    return other === lower ? 0 : other.includes(lower) || lower.includes(other) ? 1 : 2 + Math.abs(other.length - lower.length);
  };
  return [...candidates].sort((a, b) => score(a) - score(b)).slice(0, limit);
}

/** PuppyGraph lists no tables for an unknown database; say so instead. */
async function requireDatabase(rest: PuppyGraphRestLike, catalog: string, database: string): Promise<void> {
  const body = await call(rest, "GET", "/ui-api/database", `list databases of '${catalog}'`, {
    query: { catalogName: catalog },
  });
  const databases: string[] = Array.isArray(body?.database) ? body.database : [];
  if (!databases.includes(database)) {
    throw new SetupError(
      "NOT_FOUND",
      `Database '${database}' not found in catalog '${catalog}'. Databases: ${databases.length ? closestNames(database, databases, 20).join(", ") : "none"}. Names are case-sensitive.`,
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

export interface SetupToolOptions {
  readOnly: boolean;
  environment: NodeJS.ProcessEnv;
  /** Runs a Cypher query (for puppygraph_check_edges and post-upload checks). */
  query?: CypherRunner;
  /** Runs a Gremlin traversal (puppygraph_check_edges counts edge rows with it). */
  gremlin?: GremlinRunner;
}

export function registerSetupTools(
  server: McpServer,
  rest: PuppyGraphRestLike,
  { readOnly, environment, query, gremlin }: SetupToolOptions,
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
    "puppygraph_guide",
    {
      description:
        "How to use this PuppyGraph MCP server: everything it does is a puppygraph_* tool. Returns the steps to query a graph, and to build one from a database, warehouse, lake or files (catalog → tables → keys → schema → check), with the rules for correct keys, types and edges. Call it first if you haven't used these tools before.",
      inputSchema: {},
    },
    runTool("puppygraph_guide", async () => ({ guide: guideMarkdown(readOnly) })),
  );

  server.registerTool(
    "puppygraph_catalog_spec",
    {
      description:
        "Describe the catalog types PuppyGraph supports (omit type), or one type's connection fields: exact names, defaults, allowed values, which fields apply when (e.g. icebergMetastoreType=rest shows restUri and restWarehouse), and its docs link. Use the names in puppygraph_create_catalog's options. Read-only: it connects to nothing.",
      inputSchema: {
        type: z.string().min(1).optional().describe("Catalog type, e.g. iceberg, deltalake, hive, bigquery, snowflake, mysql8"),
      },
    },
    runTool("puppygraph_catalog_spec", async ({ type }: { type?: string }) => {
      if (!type) {
        return { catalog_types: catalogTypes(), next: "Call again with type to get its fields." };
      }
      if (!isKnownCatalogType(type)) {
        throw new SetupError(
          "INVALID_INPUT",
          `Unknown catalog type '${type}'. Types: ${catalogTypes().map((entry) => entry.type).join(", ")}.`,
        );
      }
      return {
        ...catalogSpec(type),
        how_to_pass:
          "In puppygraph_create_catalog, fields marked pass_as go in that parameter; every other field goes in options under its exact name. Put sensitive fields in secret_env (field → MCP server environment variable) rather than in options, so they stay out of the conversation. Only the fields under the values you choose apply (see shown_when).",
      };
    }),
  );

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
          driver_url: z
            .string()
            .optional()
            .describe("URL PuppyGraph downloads the JDBC driver jar from. Required for mysql8/mysql5 (PuppyGraph doesn't ship the MySQL driver), e.g. https://repo1.maven.org/maven2/com/mysql/mysql-connector-j/8.4.0/mysql-connector-j-8.4.0.jar"),
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
            .describe("Extra catalog fields, named exactly as puppygraph_catalog_spec lists them for the type (e.g. for iceberg on an Iceberg REST catalog: icebergMetastoreType, restUri, restWarehouse, storageType, ...). Put secrets in secret_env, not here."),
          secret_env: z
            .record(z.string())
            .optional()
            .describe("Map of option field name to MCP server environment variable name (same rule as password_env), for secrets in options (e.g. {\"storageSecretKey\": \"PUPPYGRAPH_SECRET_S3_KEY\"})"),
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
          if (MYSQL_DRIVER_URLS[args.type] && !args.driver_url && !("driverUrl" in options)) {
            throw new SetupError(
              "INVALID_INPUT",
              `PuppyGraph doesn't include the MySQL driver: pass driver_url, e.g. the official connector ${MYSQL_DRIVER_URLS[args.type]}. Nothing was created.`,
              { suggested_driver_url: MYSQL_DRIVER_URLS[args.type] },
            );
          }
          // Check the options against the catalog form before PuppyGraph
          // answers with something like "unknown metastoreType:".
          const optionWarnings: string[] = [];
          if (isKnownCatalogType(args.type)) {
            // The values that will actually be sent, under their form names.
            const values: Record<string, unknown> = { ...options };
            if (args.jdbc_uri !== undefined) values.jdbcUri = args.jdbc_uri;
            if (args.username !== undefined) values.jdbcUsername = args.username;
            if (password !== undefined) values.jdbcPassword = password;
            if (args.driver_url !== undefined) values.driverUrl = args.driver_url;
            if (isJdbc && (args.driver_class || JDBC_DRIVERS[args.type])) values.driverClass = args.driver_class || JDBC_DRIVERS[args.type];
            const check = checkCatalogValues(args.type, values);
            const invalid = Object.entries(check.invalid_options).map(([field, allowed]) => `${field} must be one of ${allowed.map(String).join(", ")}`);
            const missing = check.missing;
            if (missing.length > 0 || invalid.length > 0) {
              throw new SetupError(
                "INVALID_INPUT",
                `The '${args.type}' catalog settings are incomplete: ${[
                  ...(missing.length ? [`missing ${missing.join(", ")}`] : []),
                  ...invalid,
                ].join("; ")}${check.unknown.length ? `; the catalog form has no field ${check.unknown.join(", ")}` : ""}. Nothing was created. Call puppygraph_catalog_spec with type '${args.type}' for the exact field names, and pass them in options (secrets in secret_env).`,
              );
            }
            if (check.unknown.length > 0) {
              optionWarnings.push(`The catalog form has no field ${check.unknown.join(", ")}; PuppyGraph may ignore it. Field names are in puppygraph_catalog_spec.`);
            }
          }
          const catalog: Record<string, unknown> = {
            ...options,
            catalogName: args.name,
            catalogType: args.type,
          };
          // The catalog form picks BigQuery's client with bigqueryDriverType;
          // PuppyGraph reads connectivity (the web UI translates it the same way).
          if (args.type === "bigquery" && options.bigqueryDriverType === "adbc" && catalog.connectivity === undefined) {
            catalog.connectivity = "adbc";
          }
          if (isJdbc) {
            if (args.jdbc_uri !== undefined) catalog.jdbcUri = args.jdbc_uri;
            if (args.username !== undefined) catalog.jdbcUsername = args.username;
            if (password !== undefined) catalog.jdbcPassword = password;
            const driver = args.driver_class || JDBC_DRIVERS[args.type];
            if (driver) catalog.driverClass = driver;
            if (args.driver_url !== undefined) catalog.driverUrl = args.driver_url;
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
            const error = withLocalhostHint(
              errorFromResponse(response, `create catalog '${args.name}'`, secrets),
              (catalog.jdbcUri as string | undefined) ?? undefined,
            );
            if (/already exists/i.test(error.message)) {
              throw new SetupError(
                "ALREADY_EXISTS",
                `A catalog named '${args.name}' already exists. Use it as is (check it with puppygraph_test_catalog), or pick another name.`,
              );
            }
            const hint = error.code === "UPSTREAM_ERROR"
              ? catalogErrorHint(error.message, args.type, catalog.jdbcUri as string | undefined)
              : undefined;
            if (hint) {
              throw new SetupError(error.code, error.message, { ...error.details, ...maskSecrets(hint, secrets) });
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
            ...(optionWarnings.length ? { warnings: optionWarnings } : {}),
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
        const tables = body?.table ?? [];
        if (Array.isArray(tables) && tables.length === 0) {
          await requireDatabase(rest, catalog, database);
        }
        return { catalog, database, tables };
      },
    ),
  );

  server.registerTool(
    "puppygraph_describe_table",
    {
      description:
        "List the columns of a table in a catalog: name, source type, and schemaType. Declare each column in the graph schema with its schemaType exactly as given (e.g. LONG, DECIMAL(12,2), ARRAY<STRING>): PuppyGraph rejects any other type. Columns with schemaType UNKNOWN can't be mapped; leave them out.",
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
        const columns: any[] = Array.isArray(body?.column) ? body.column : [];
        if (columns.length === 0) {
          // PuppyGraph answers an unknown table with no columns.
          await requireDatabase(rest, catalog, database);
          const listed = await call(rest, "GET", "/ui-api/table", `list tables of '${catalog}.${database}'`, {
            query: { catalogName: catalog, databaseName: database },
          });
          const tables: string[] = Array.isArray(listed?.table) ? listed.table : [];
          if (!tables.includes(table)) {
            throw new SetupError(
              "NOT_FOUND",
              `Table '${table}' not found in '${catalog}.${database}'.${tables.length ? ` Closest: ${closestNames(table, tables).join(", ")}.` : " The database has no tables."} Names are case-sensitive.`,
            );
          }
        }
        const unsupported = columns
          .filter((column) => String(column?.schemaType ?? "").toUpperCase() === "UNKNOWN")
          .map((column) => column?.name);
        return {
          catalog,
          database,
          table,
          columns,
          ...(unsupported.length
            ? { unsupported_columns: unsupported, note: "PuppyGraph can't map these columns' source type (e.g. Postgres ENUM); leave them out of the schema." }
            : {}),
        };
      },
    ),
  );

  const tableInput = {
    catalog: z.string().min(1).describe("Catalog name"),
    database: z.string().min(1).describe("Database or schema name"),
    table: z.string().min(1).describe("Table name"),
  };

  server.registerTool(
    "puppygraph_sample_table",
    {
      description:
        "Return a few real rows of a table (default 10, at most 100), to tell id-shaped columns from free text and spot enums before mapping the table. The rows go into the conversation, so ask for only the columns you need.",
      inputSchema: {
        ...tableInput,
        columns: z.array(z.string().min(1)).optional().describe("Columns to return; all columns when omitted"),
        limit: z.number().int().min(1).max(100).optional().describe("Number of rows, default 10"),
      },
    },
    runTool(
      "puppygraph_sample_table",
      async (args: { catalog: string; database: string; table: string; columns?: string[]; limit?: number }) => {
        const { catalog, database, table } = args;
        const body = await probe(
          rest,
          "sample-rows",
          `sample '${catalog}.${database}.${table}'`,
          { catalog, database, table, ...(args.columns ? { columns: args.columns } : {}), ...(args.limit ? { limit: args.limit } : {}) },
          SAMPLE_TIMEOUT_MS,
        );
        const columns: string[] = Array.isArray(body?.columns) ? body.columns : [];
        const rows = (Array.isArray(body?.row_json) ? body.row_json : []).map(parseRow);
        return { catalog, database, table, columns, rows, truncated: body?.truncated === true };
      },
    ),
  );

  server.registerTool(
    "puppygraph_profile_column",
    {
      description:
        "Profile one column from its data: total, null and distinct counts, cardinality_class (unique, high, medium, low or binary) and looks_like hints (pk_candidate, fk_candidate, enum, measure, free_text, timestamp, json), plus up to 20 sample values and min/max unless the server returns counts only. A node id should be a pk_candidate: unique and never null. Use this to decide which column is a table's id, which ones reference other tables, and which are attributes. It scans the whole column, so it can take minutes on large tables.",
      inputSchema: { ...tableInput, column: z.string().min(1).describe("Column name") },
    },
    runTool(
      "puppygraph_profile_column",
      async ({ catalog, database, table, column }: { catalog: string; database: string; table: string; column: string }) => {
        const profile = await probe(
          rest,
          "column-profile",
          `profile '${catalog}.${database}.${table}.${column}'`,
          { catalog, database, table, column },
          PROFILE_TIMEOUT_MS,
        );
        return { catalog, database, table, column, ...profile };
      },
    ),
  );

  server.registerTool(
    "puppygraph_table_row_count",
    {
      description:
        "Count the rows of a table. Helps tell entity tables (nodes) from event and link tables (often edges), and judge how long profiling will take.",
      inputSchema: tableInput,
    },
    runTool(
      "puppygraph_table_row_count",
      async ({ catalog, database, table }: { catalog: string; database: string; table: string }) => {
        const body = await probe(
          rest,
          "row-count",
          `count the rows of '${catalog}.${database}.${table}'`,
          { catalog, database, table },
          PROFILE_TIMEOUT_MS,
        );
        return { catalog, database, table, row_count: exactInteger(String(body?.row_count)), approximate: body?.is_approximate === true };
      },
    ),
  );

  const columnRef = z.object({
    catalog: z.string().min(1),
    database: z.string().min(1),
    table: z.string().min(1),
    column: z.string().min(1),
  });

  server.registerTool(
    "puppygraph_check_join",
    {
      description:
        "Check from the data whether a column references another table: samples distinct values of from.column and counts how many exist in to.column. Without to.column, tries the type-compatible columns of to.table and ranks them. Returns candidates with hit_rate (share of sampled values found), from_keys and to_keys (distinct counts), and up to 5 values that were not found (unless the server returns counts only). Check every edge this way before putting it in a schema; never present a join you did not check as verified. A hit_rate near 1.0 is a foreign key; below about 0.95 it is a soft reference, so tell the user the evidence. Independent checks can run in parallel. It can take minutes on large tables.",
      inputSchema: {
        from: columnRef.describe("The referencing column, e.g. orders.customer_id"),
        to: columnRef
          .extend({ column: z.string().min(1).optional() })
          .describe("The referenced table and, if known, its key column, e.g. customers.id"),
        max_candidates: z.number().int().min(1).max(25).optional().describe("Without to.column: how many candidate columns to return, default 5"),
      },
    },
    runTool(
      "puppygraph_check_join",
      async (args: {
        from: { catalog: string; database: string; table: string; column: string };
        to: { catalog: string; database: string; table: string; column?: string };
        max_candidates?: number;
      }) => {
        const { from, to } = args;
        const body = await probe(
          rest,
          "join-check",
          `check '${from.table}.${from.column}' against '${to.table}${to.column ? `.${to.column}` : ""}'`,
          { from, to, ...(args.max_candidates ? { max_candidates: args.max_candidates } : {}) },
          JOIN_TIMEOUT_MS,
        );
        return { from, to, candidates: Array.isArray(body?.candidates) ? body.candidates : [] };
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
        async ({ schema, replace }: { schema: unknown; replace?: boolean }, log) => withSchemaLock(rest, async () => {
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

          // Always send the caller's schema as given. For a 0.x schema the
          // server converts it itself; the converted schema from validation
          // is only for checks, because servers may mask catalog passwords in
          // convertSchema output, and uploading that would store "******".
          const original = typeof schema === "string" ? JSON.parse(schema) : schema;
          const secrets = secretsOfSchema(original);
          log(`replace=${replace === true} nodes=${(validation.schema?.node || []).length} edges=${(validation.schema?.edge || []).length}`);
          const upload = (body: unknown) =>
            rest.request("POST", "/schema", {
              query: { preflight: "true" },
              body,
              timeoutMs: UPLOAD_TIMEOUT_MS,
            });
          let response = await upload(original);
          if (
            validation.convertedFrom0x &&
            response.status === 400 &&
            /unknown field \\?"(catalogs|graph)\\?"/.test(responseError(response.body, secrets))
          ) {
            // Servers before 1.14 can't convert 0.x on upload. Fall back to the
            // converted schema, but only if conversion kept every credential:
            // a masked one would be stored as the literal mask.
            const converted = validation.schema;
            if (!keepsEveryCredential(secrets, collectSecrets(converted)) || containsMask(converted)) {
              throw new SetupError(
                "UPSTREAM_ERROR",
                "This PuppyGraph can't convert 0.x schemas on upload, and its converted schema has masked or missing catalog credentials, so it can't be uploaded safely; the installed schema is unchanged. Upload the converted 1.x schema from puppygraph_validate_schema with the real credentials filled in, or register the catalog with puppygraph_create_catalog and remove it from the schema.",
              );
            }
            log("server does not convert 0.x on upload; uploading the converted schema");
            validation.warnings.push(
              "This PuppyGraph doesn't convert 0.x schemas on upload, so the schema converted during validation was uploaded instead.",
            );
            response = await upload(converted);
          }
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
          const changes = validation.schema ? schemaDiff(live, validation.schema) : undefined;
          const ready = changes ? await waitUntilQueryable(query, validation.schema, changes) : { ready: true };
          return {
            ok: true,
            version: body.version ?? null,
            previous_version: previousVersion,
            message: body.message ?? "Schema uploaded",
            ...(changes ? { changes } : {}),
            ...ready,
            warnings: [...validation.warnings, ...(Array.isArray(body.warnings) ? body.warnings : [])],
            next: "Check that every edge connects real nodes with puppygraph_check_edges, then query the graph with puppygraph_query.",
          };
        }),
        ({ schema }: { schema: unknown }) => secretsOfSchema(schema),
      ),
    );
  }

  registerSchemaTools(server, rest, { readOnly, query, gremlin });
}

/**
 * Whether every credential of the original schema is still in the converted
 * one, counting repeats: comparing totals alone would accept a conversion
 * that dropped one credential and duplicated another.
 */
function keepsEveryCredential(original: readonly string[], converted: readonly string[]): boolean {
  const available = new Map<string, number>();
  for (const secret of converted) {
    available.set(secret, (available.get(secret) ?? 0) + 1);
  }
  for (const secret of original) {
    const left = available.get(secret) ?? 0;
    if (left === 0) {
      return false;
    }
    available.set(secret, left - 1);
  }
  return true;
}

function containsMask(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsMask);
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsMask);
  }
  return value === MASK;
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
