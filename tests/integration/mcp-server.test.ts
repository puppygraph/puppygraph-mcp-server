import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPuppyGraphServer,
  type PuppyGraphServiceLike,
} from "../../src/server.js";

const queryResult = {
  data: [{ id: 1, label: "person" }],
  metadata: {
    execution_time: 12,
    row_count: 1,
  },
};

const schemaResult = {
  summary: "PuppyGraph Schema Information",
  source: "Schema API",
  schema: {
    node: [{ label: "person" }],
    edge: [],
  },
  schema_endpoint: "http://localhost:8081/schemajson",
  timestamp: "2000-01-01T00:00:00.000Z",
};

function parseTextContent(result: { content: Array<Record<string, unknown>> }) {
  const content = result.content[0];
  expect(content).toMatchObject({ type: "text" });

  if (content.type !== "text" || typeof content.text !== "string") {
    throw new Error("Expected an MCP text result");
  }

  return JSON.parse(content.text);
}

describe("MCP backward-compatibility contract", () => {
  let client: Client;
  let server: McpServer;
  let service: PuppyGraphServiceLike & {
    executeGremlin: ReturnType<typeof vi.fn>;
    executeCypher: ReturnType<typeof vi.fn>;
    getDataSources: ReturnType<typeof vi.fn>;
    getConnectionStatus: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    service = {
      executeGremlin: vi.fn().mockResolvedValue(queryResult),
      executeCypher: vi.fn().mockResolvedValue(queryResult),
      getDataSources: vi.fn().mockResolvedValue(schemaResult),
      getConnectionStatus: vi.fn().mockReturnValue({
        connected: true,
        neo4jConnected: true,
        gremlinConnected: true,
        connectionError: null,
        fallbackMode: false,
      }),
    };

    server = createPuppyGraphServer(service, {
      PUPPYGRAPH_URL: "bolt://compatibility-test:7687",
      PUPPYGRAPH_DATABASE: "compatibility-db",
    });
    client = new Client({ name: "compatibility-test-client", version: "1.1.0" });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("advertises the 1.1.0 server identity", () => {
    expect(client.getServerVersion()).toEqual({
      name: "puppygraph",
      version: "1.1.0",
    });
  });

  it("advertises the six 1.0.0 tools with compatible input schemas", async () => {
    const { tools } = await client.listTools();

    expect(
      tools.map(({ name, description }) => ({ name, description })),
    ).toEqual([
      {
        name: "puppygraph_query",
        description:
          "Execute a graph query (Gremlin or Cypher) against PuppyGraph",
      },
      {
        name: "puppygraph_schema",
        description:
          "Get schema and structure information about the PuppyGraph database",
      },
      {
        name: "puppygraph_status",
        description:
          "Get connection status and configuration information for PuppyGraph",
      },
      {
        name: "mcp__puppygraph_query",
        description:
          "Execute a graph query (Gremlin or Cypher) against PuppyGraph",
      },
      {
        name: "mcp__puppygraph_schema",
        description:
          "Get schema and structure information about the PuppyGraph database",
      },
      {
        name: "mcp__puppygraph_status",
        description:
          "Get connection status and configuration information for PuppyGraph",
      },
    ]);

    const queryTool = tools.find((tool) => tool.name === "puppygraph_query");
    const prefixedQueryTool = tools.find(
      (tool) => tool.name === "mcp__puppygraph_query",
    );
    expect(queryTool).toBeDefined();
    expect(prefixedQueryTool).toBeDefined();
    expect(queryTool?.description).toBe(
      "Execute a graph query (Gremlin or Cypher) against PuppyGraph",
    );
    expect(prefixedQueryTool?.description).toBe(queryTool?.description);
    expect(prefixedQueryTool?.inputSchema).toEqual(queryTool?.inputSchema);
    expect(queryTool?.inputSchema).toEqual({
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The query to execute (Gremlin or Cypher)",
        },
        language: {
          type: "string",
          enum: ["gremlin", "cypher"],
          description: "The query language to use",
        },
        parameters: {
          type: "object",
          additionalProperties: {},
          description: "Optional parameters for the query",
        },
      },
      required: ["query", "language"],
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    for (const name of [
      "puppygraph_schema",
      "puppygraph_status",
      "mcp__puppygraph_schema",
      "mcp__puppygraph_status",
    ]) {
      expect(tools.find((tool) => tool.name === name)?.inputSchema).toEqual({
        type: "object",
        properties: {},
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#",
      });
    }
  });

  it.each([
    ["puppygraph_query", "gremlin", "g.V().limit(1)", "executeGremlin"],
    [
      "puppygraph_query",
      "cypher",
      "MATCH (n) RETURN n LIMIT 1",
      "executeCypher",
    ],
    [
      "mcp__puppygraph_query",
      "gremlin",
      "g.V().limit(1)",
      "executeGremlin",
    ],
    [
      "mcp__puppygraph_query",
      "cypher",
      "MATCH (n) RETURN n LIMIT 1",
      "executeCypher",
    ],
  ] as const)(
    "%s preserves successful %s query responses",
    async (toolName, language, query, method) => {
      const result = await client.callTool({
        name: toolName,
        arguments: {
          query,
          language,
          parameters: { limit: 1 },
        },
      });

      expect(service[method]).toHaveBeenCalledWith({
        query,
        parameters: { limit: 1 },
        requestId: expect.any(String),
      });
      expect(result.isError).toBeUndefined();
      expect(parseTextContent(result)).toEqual(queryResult);
    },
  );

  it("keeps parameters optional and forwards an empty object", async () => {
    const result = await client.callTool({
      name: "puppygraph_query",
      arguments: {
        query: "MATCH (n) RETURN n LIMIT 1",
        language: "cypher",
      },
    });

    expect(service.executeCypher).toHaveBeenCalledWith({
      query: "MATCH (n) RETURN n LIMIT 1",
      parameters: {},
      requestId: expect.any(String),
    });
    expect(result.isError).toBeUndefined();
    expect(parseTextContent(result)).toEqual(queryResult);
  });

  it.each(["puppygraph_schema", "mcp__puppygraph_schema"])(
    "%s preserves the successful schema response",
    async (toolName) => {
      const result = await client.callTool({ name: toolName, arguments: {} });

      expect(service.getDataSources).toHaveBeenCalled();
      expect(result.isError).toBeUndefined();
      expect(parseTextContent(result)).toEqual(schemaResult);
    },
  );

  it("does not log query text, parameters, credentials, or driver messages", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const querySecret = "query-secret@example.com";
    const parameterSecret = "parameter-secret-token";
    const username = "sensitive-user";
    const password = "sensitive-password";
    service.executeCypher.mockRejectedValueOnce(
      new Error(`${querySecret} ${parameterSecret} ${username} ${password}`),
    );

    try {
      const result = await client.callTool({
        name: "puppygraph_query",
        arguments: {
          language: "cypher",
          query: `MATCH (n {email: '${querySecret}'}) RETURN n`,
          parameters: { token: parameterSecret, username, password },
        },
      });

      const logs = stderr.mock.calls.flat().join(" ");
      expect(logs).toContain("Query received request_id=");
      expect(logs).toContain("language=cypher");
      expect(logs).toContain("error_type=Error");
      expect(logs).not.toContain(querySecret);
      expect(logs).not.toContain(parameterSecret);
      expect(logs).not.toContain(username);
      expect(logs).not.toContain(password);

      expect(result.isError).toBe(true);
      expect(parseTextContent(result)).toEqual({
        data: [],
        metadata: {
          error: "Unable to execute PuppyGraph query",
          error_type: "UPSTREAM_ERROR",
        },
      });
      const serializedResult = JSON.stringify(result);
      expect(serializedResult).not.toContain(querySecret);
      expect(serializedResult).not.toContain(parameterSecret);
      expect(serializedResult).not.toContain(username);
      expect(serializedResult).not.toContain(password);
    } finally {
      stderr.mockRestore();
    }
  });

  it.each(["puppygraph_status", "mcp__puppygraph_status"])(
    "%s preserves the successful status response",
    async (toolName) => {
      const result = await client.callTool({ name: toolName, arguments: {} });

      expect(result.isError).toBeUndefined();
      expect(parseTextContent(result)).toEqual({
        status: "connected",
        fallback_mode: false,
        error: null,
        puppygraph_url: "bolt://compatibility-test:7687",
        puppygraph_database: "compatibility-db",
      });
    },
  );

  it.each(["puppygraph_status", "mcp__puppygraph_status"])(
    "%s sanitizes a disconnected status without marking the tool call as failed",
    async (toolName) => {
      const secret = "bolt://user:password@example.com:7687";
      service.getConnectionStatus.mockReturnValueOnce({
        connected: false,
        neo4jConnected: false,
        gremlinConnected: false,
        connectionError: `Connection failed at ${secret}`,
        fallbackMode: false,
      });

      const result = await client.callTool({ name: toolName, arguments: {} });

      expect(result.isError).toBeUndefined();
      expect(parseTextContent(result)).toEqual({
        status: "disconnected",
        fallback_mode: false,
        error: "Unable to connect to PuppyGraph",
        error_type: "CONNECTION_FAILED",
        puppygraph_url: "bolt://compatibility-test:7687",
        puppygraph_database: "compatibility-db",
      });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain("password");
    },
  );

  it.each(["puppygraph_query", "mcp__puppygraph_query"])(
    "%s marks query failures as sanitized MCP errors",
    async (toolName) => {
      const secret = "query-secret://user:password@example.com";
      service.executeCypher.mockRejectedValueOnce(new Error(secret));

      const result = await client.callTool({
        name: toolName,
        arguments: {
          language: "cypher",
          query: "MATCH (n) RETURN n",
        },
      });

      expect(result.isError).toBe(true);
      expect(parseTextContent(result)).toEqual({
        data: [],
        metadata: {
          error: "Unable to execute PuppyGraph query",
          error_type: "UPSTREAM_ERROR",
        },
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    },
  );

  it.each(["puppygraph_schema", "mcp__puppygraph_schema"])(
    "%s marks schema failures as sanitized MCP errors",
    async (toolName) => {
      const secret = "http://user:password@example.com/schemajson?token=secret";
      service.getDataSources.mockRejectedValueOnce(new Error(secret));

      const result = await client.callTool({ name: toolName, arguments: {} });

      expect(result.isError).toBe(true);
      expect(parseTextContent(result)).toEqual({
        metadata: {
          error: "Unable to fetch PuppyGraph schema",
          error_type: "UPSTREAM_ERROR",
        },
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    },
  );

  it.each(["puppygraph_status", "mcp__puppygraph_status"])(
    "%s marks status failures as sanitized MCP errors",
    async (toolName) => {
      const secret = "bolt://user:password@example.com:7687";
      service.getConnectionStatus.mockImplementationOnce(() => {
        throw new Error(secret);
      });

      const result = await client.callTool({ name: toolName, arguments: {} });

      expect(result.isError).toBe(true);
      expect(parseTextContent(result)).toEqual({
        status: "error",
        error: "Unable to fetch PuppyGraph status",
        error_type: "UPSTREAM_ERROR",
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    },
  );
});
