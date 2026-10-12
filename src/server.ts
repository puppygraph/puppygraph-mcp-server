import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  PuppyGraphRestClient,
  type PuppyGraphRestLike,
} from "./clients/rest.js";
import { GUIDE_URI, guideMarkdown, SCHEMA_URI, serverInstructions } from "./guide.js";
import { schemaSkeleton } from "./setup/schema-tools.js";
import { registerSetupTools } from "./setup/tools.js";
import { loadRestConfig } from "./utils/config.js";
import {
  findWriteOperation,
  isReadOnly,
  readOnlyErrorMessage,
} from "./utils/readonly.js";
import { redactUri, scrubText } from "./utils/redact.js";
import {
  createRequestId,
  errorCategory,
  safeToolError,
  urlForLog,
} from "./utils/logging.js";

export interface PuppyGraphServiceLike {
  executeGremlin(params: {
    query: string;
    parameters?: Record<string, any>;
    requestId?: string;
  }): Promise<unknown>;
  executeCypher(params: {
    query: string;
    parameters?: Record<string, any>;
    requestId?: string;
    timeoutMs?: number;
  }): Promise<unknown>;
  getDataSources(): Promise<unknown>;
  getConnectionStatus(): {
    connected: boolean;
    neo4jConnected: boolean;
    gremlinConnected: boolean;
    connectionError: string | null;
    fallbackMode: boolean;
  };
}

const QUERY_DESCRIPTION =
  "Execute a graph query (Gremlin or Cypher) against PuppyGraph. Use LIMIT (e.g. 20) unless all rows are needed. Node ids are not properties: id(n) or elementId(n) returns 'Label[value]' (e.g. 'Account[1]', 'OrderLine[1,2]' for a two-column id); n.<id column> is null. On an error or warning about an unknown label or property, look the name up with puppygraph_search_schema / puppygraph_get_schema_element and retry";
const READ_ONLY_QUERY_DESCRIPTION =
  `${QUERY_DESCRIPTION}. The server is in read-only mode: queries that create, change or delete data are rejected.`;
const SCHEMA_DESCRIPTION =
  "Get schema and structure information about the PuppyGraph database: node and edge labels and their properties. Call it before writing a query.";
const STATUS_DESCRIPTION =
  "Get connection status and configuration information for PuppyGraph. Call this first to check that PuppyGraph is reachable. This server's features are all tools named puppygraph_* (query a graph; connect a database, warehouse, lake or files and build a graph schema); puppygraph_guide explains which to call in what order.";
const READ_ONLY_STATUS_DESCRIPTION =
  `${STATUS_DESCRIPTION}. The server is in read-only mode: the tools that create catalogs and upload schemas are disabled.`;

const querySchema = {
  query: z.string().describe("The query to execute (Gremlin or Cypher)"),
  language: z
    .enum(["gremlin", "cypher"])
    .describe("The query language to use"),
  parameters: z
    .record(z.any())
    .optional()
    .describe("Optional parameters for the query"),
  timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(300)
    .optional()
    .describe("Cypher only: give up after this many seconds (at most 300)"),
};

// Credentials the query tool knows about: they never appear in its output.
function configuredSecrets(environment: NodeJS.ProcessEnv): string[] {
  return [
    "PUPPYGRAPH_USERNAME",
    "PUPPYGRAPH_PASSWORD",
    "PUPPYGRAPH_GREMLIN_USERNAME",
    "PUPPYGRAPH_GREMLIN_PASSWORD",
    "PUPPYGRAPH_SCHEMA_USERNAME",
    "PUPPYGRAPH_SCHEMA_PASSWORD",
  ]
    .map((name) => environment[name])
    .filter((value): value is string => typeof value === "string" && value.length >= 3);
}

function stringValues(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") {
    found.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => stringValues(item, found));
  } else if (value !== null && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((item) => stringValues(item, found));
  }
  return found;
}

/**
 * PuppyGraph's own explanation of a failed query (a syntax error, an unknown
 * label, a data source error), as PuppyGraph AI shows its agent. String
 * literals of the query, parameter values and the configured credentials are
 * scrubbed from it, so the result never carries data the query was given.
 */
function queryErrorDetail(error: unknown, query: string, parameters: unknown, environment: NodeJS.ProcessEnv): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const message = raw.replace(/^Error executing (Cypher|Gremlin) query:\s*/i, "").trim();
  const literals = [...query.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)]
    .map((match) => match[1] ?? match[2] ?? "");
  const secrets = [...literals, ...stringValues(parameters), ...configuredSecrets(environment)]
    .filter((secret) => secret.length > 0);
  return scrubText(redactUri(message), secrets).slice(0, 1500);
}
const emptyInputSchema = z.object({}).strict();

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function textErrorResult(value: unknown) {
  return {
    ...textResult(value),
    isError: true,
  };
}

function registerToolSet(
  server: McpServer,
  service: PuppyGraphServiceLike,
  environment: NodeJS.ProcessEnv,
  readOnly: boolean,
  prefix: "" | "mcp__",
): void {
  const suffix = prefix === "mcp__" ? " via mcp__ prefix" : "";

  server.tool(
    `${prefix}puppygraph_query`,
    readOnly ? READ_ONLY_QUERY_DESCRIPTION : QUERY_DESCRIPTION,
    querySchema,
    async (args, _extra) => {
      const requestId = createRequestId();
      try {
        console.error(
          `Query received request_id=${requestId} language=${args.language}`,
        );

        const writeOperation = readOnly
          ? findWriteOperation(args.query, args.language)
          : null;
        if (writeOperation) {
          console.error(
            `Query rejected request_id=${requestId} language=${args.language} reason=read_only`,
          );
          return textErrorResult({
            data: [],
            metadata: {
              error: readOnlyErrorMessage(writeOperation),
              error_type: "READ_ONLY",
            },
          });
        }

        const result =
          args.language === "gremlin"
            ? await service.executeGremlin({
                query: args.query,
                parameters: args.parameters || {},
                requestId,
              })
            : await service.executeCypher({
                query: args.query,
                parameters: args.parameters || {},
                requestId,
                ...(args.timeout_seconds ? { timeoutMs: args.timeout_seconds * 1000 } : {}),
              });

        return textResult(result);
      } catch (error: any) {
        const safeError = safeToolError(error, "query");
        console.error(
          `Query failed request_id=${requestId} language=${args.language} error_type=${errorCategory(error)}`,
        );

        const detail = safeError.code === "CONNECTION_FAILED"
          ? ""
          : queryErrorDetail(error, args.query, args.parameters, environment);
        return textErrorResult({
          data: [],
          metadata: {
            error: detail ? `${safeError.message}: ${detail}` : safeError.message,
            error_type: safeError.code,
          },
        });
      }
    },
  );

  server.registerTool(
    `${prefix}puppygraph_schema`,
    {
      description: SCHEMA_DESCRIPTION,
      inputSchema: emptyInputSchema,
    },
    async (_args, _extra) => {
      try {
        console.error(`Fetching schema information${suffix}`);
        return textResult(compactLargeSchema(await service.getDataSources()));
      } catch (error: any) {
        const safeError = safeToolError(error, "schema");
        console.error(
          `Schema fetch failed error_type=${errorCategory(error)}`,
        );

        return textErrorResult({
          metadata: {
            error: safeError.message,
            error_type: safeError.code,
          },
        });
      }
    },
  );

  server.registerTool(
    `${prefix}puppygraph_status`,
    {
      description: readOnly ? READ_ONLY_STATUS_DESCRIPTION : STATUS_DESCRIPTION,
      inputSchema: emptyInputSchema,
    },
    async (_args, _extra) => {
      try {
        console.error(
          `Fetching connection status${prefix === "" ? " information" : suffix}`,
        );
        const status = service.getConnectionStatus();
        const connectionError = status.connectionError
          ? safeToolError(new Error(status.connectionError), "status")
          : null;

        return textResult({
          status: status.connected ? "connected" : "disconnected",
          fallback_mode: status.fallbackMode,
          error: connectionError?.message || null,
          ...(connectionError ? { error_type: connectionError.code } : {}),
          puppygraph_url: urlForLog(
            environment.PUPPYGRAPH_URL || "bolt://localhost:7687",
          ),
          puppygraph_database: environment.PUPPYGRAPH_DATABASE || "default",
          read_only: readOnly,
        });
      } catch (error: any) {
        const safeError = safeToolError(error, "status");
        console.error(
          `Status fetch failed error_type=${errorCategory(error)}`,
        );

        return textErrorResult({
          status: "error",
          error: safeError.message,
          error_type: safeError.code,
        });
      }
    },
  );
}

// Above this size the schema is returned as a skeleton, as PuppyGraph AI
// does: the full document can run to megabytes.
const LARGE_SCHEMA_BYTES = 48 * 1024;

function compactLargeSchema(result: unknown): unknown {
  const schema = (result as any)?.schema;
  if (!schema || typeof schema !== "object" || JSON.stringify(schema).length <= LARGE_SCHEMA_BYTES) {
    return result;
  }
  try {
    return { ...(result as object), schema: schemaSkeleton(schema) };
  } catch {
    return result;
  }
}

// Read-only resources. Clients that look at resources before tools would
// otherwise find none and conclude there is nothing here.
function registerResources(
  server: McpServer,
  service: PuppyGraphServiceLike,
  readOnly: boolean,
): void {
  server.registerResource(
    "guide",
    GUIDE_URI,
    {
      title: "How to use the PuppyGraph MCP server",
      description: "Which tools to call, in what order, to query a graph or build one from a database.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: guideMarkdown(readOnly) }],
    }),
  );

  server.registerResource(
    "schema",
    SCHEMA_URI,
    {
      title: "PuppyGraph graph schema",
      description: "The current graph schema: node and edge labels and their properties (same as the puppygraph_schema tool).",
      mimeType: "application/json",
    },
    async (uri) => {
      let value: unknown;
      try {
        value = await service.getDataSources();
      } catch (error: any) {
        const safeError = safeToolError(error, "schema");
        console.error(`Schema resource failed error_type=${errorCategory(error)}`);
        value = { metadata: { error: safeError.message, error_type: safeError.code } };
      }
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value, null, 2) }],
      };
    },
  );
}

export function createPuppyGraphServer(
  service: PuppyGraphServiceLike,
  environment: NodeJS.ProcessEnv = process.env,
  readOnly: boolean = isReadOnly(environment),
  rest: PuppyGraphRestLike = new PuppyGraphRestClient(loadRestConfig(environment)),
): McpServer {
  const server = new McpServer({
    name: "puppygraph",
    version: "1.3.0",
  }, {
    capabilities: {
      resources: {},
      tools: {},
    },
    instructions: serverInstructions(readOnly),
  });

  registerToolSet(server, service, environment, readOnly, "");
  registerToolSet(server, service, environment, readOnly, "mcp__");
  // Catalog and schema setup tools. Only unprefixed: the mcp__ aliases exist
  // for clients of 1.0.0, which had no setup tools.
  registerSetupTools(server, rest, {
    readOnly,
    environment,
    query: async (cypher) => {
      const result = (await service.executeCypher({ query: cypher })) as { data?: Array<Record<string, unknown>> };
      return Array.isArray(result?.data) ? result.data : [];
    },
    gremlin: async (traversal) => {
      const result = (await service.executeGremlin({ query: traversal })) as { data?: unknown[] };
      return Array.isArray(result?.data) ? result.data : [];
    },
  });
  registerResources(server, service, readOnly);

  return server;
}
