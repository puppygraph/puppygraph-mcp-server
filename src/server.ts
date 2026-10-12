import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  PuppyGraphRestClient,
  type PuppyGraphRestLike,
} from "./clients/rest.js";
import { GUIDE_URI, guideMarkdown, SCHEMA_URI, serverInstructions } from "./guide.js";
import { registerSetupTools } from "./setup/tools.js";
import { loadRestConfig } from "./utils/config.js";
import {
  findWriteOperation,
  isReadOnly,
  readOnlyErrorMessage,
} from "./utils/readonly.js";
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
  "Execute a graph query (Gremlin or Cypher) against PuppyGraph";
const READ_ONLY_QUERY_DESCRIPTION =
  `${QUERY_DESCRIPTION}. The server is in read-only mode: queries that create, change or delete data are rejected.`;
const SCHEMA_DESCRIPTION =
  "Get schema and structure information about the PuppyGraph database: node and edge labels and their properties. Call it before writing a query.";
const STATUS_DESCRIPTION =
  "Get connection status and configuration information for PuppyGraph. Call this first to check that PuppyGraph is reachable.";
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
};
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
              });

        return textResult(result);
      } catch (error: any) {
        const safeError = safeToolError(error, "query");
        console.error(
          `Query failed request_id=${requestId} language=${args.language} error_type=${errorCategory(error)}`,
        );

        return textErrorResult({
          data: [],
          metadata: {
            error: safeError.message,
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
        return textResult(await service.getDataSources());
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
  registerSetupTools(server, rest, { readOnly, environment });
  registerResources(server, service, readOnly);

  return server;
}
