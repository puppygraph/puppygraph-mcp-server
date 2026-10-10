import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const liveTestEnabled = process.env.PUPPYGRAPH_LIVE_TEST === "true";
const describeLive = liveTestEnabled ? describe : describe.skip;

function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function parseTextContent(result: { content: Array<Record<string, unknown>> }) {
  const content = result.content[0];
  expect(content).toMatchObject({ type: "text" });

  if (content.type !== "text" || typeof content.text !== "string") {
    throw new Error("Expected an MCP text result");
  }

  return JSON.parse(content.text);
}

describeLive("live PuppyGraph MCP stdio compatibility", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let stderrOutput = "";

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ["build/index.js"],
      cwd: process.cwd(),
      env: stringEnvironment(),
      stderr: "pipe",
    });

    client = new Client({ name: "puppygraph-live-test", version: "1.1.0" });
    await client.connect(transport);
    transport.stderr?.on("data", (chunk) => {
      stderrOutput += chunk.toString();
    });
  }, 30_000);

  afterAll(async () => {
    await client?.close();
  });

  it("lists the 1.0.0 tools and executes both query languages", async () => {
    const { tools } = await client.listTools();
    expect(tools.slice(0, 6).map((tool) => tool.name)).toEqual([
      "puppygraph_query",
      "puppygraph_schema",
      "puppygraph_status",
      "mcp__puppygraph_query",
      "mcp__puppygraph_schema",
      "mcp__puppygraph_status",
    ]);

    const cypher = parseTextContent(
      await client.callTool({
        name: "puppygraph_query",
        arguments: {
          language: "cypher",
          query: "MATCH (n) RETURN count(n) AS count",
        },
      }),
    );
    expect(cypher).toMatchObject({
      data: [{ count: expect.any(Number) }],
      metadata: {
        execution_time: expect.any(Number),
        row_count: 1,
      },
    });

    const gremlin = parseTextContent(
      await client.callTool({
        name: "puppygraph_query",
        arguments: {
          language: "gremlin",
          query: "g.V().count()",
        },
      }),
    );
    expect(gremlin).toMatchObject({
      data: [expect.any(Number)],
      metadata: {
        execution_time: expect.any(Number),
        row_count: 1,
      },
    });

    const gremlinWithBindings = parseTextContent(
      await client.callTool({
        name: "puppygraph_query",
        arguments: {
          language: "gremlin",
          query: "g.V().limit(resultLimit).count()",
          parameters: { resultLimit: 1 },
        },
      }),
    );
    expect(gremlinWithBindings).toMatchObject({
      data: [expect.any(Number)],
      metadata: {
        execution_time: expect.any(Number),
        row_count: 1,
      },
    });

    const schema = parseTextContent(
      await client.callTool({ name: "puppygraph_schema", arguments: {} }),
    );
    expect(schema).toMatchObject({
      summary: "PuppyGraph Schema Information",
      source: "Schema API",
      schema: expect.any(Object),
      schema_endpoint: expect.any(String),
      timestamp: expect.any(String),
    });

    const status = parseTextContent(
      await client.callTool({ name: "puppygraph_status", arguments: {} }),
    );
    expect(status).toMatchObject({
      status: "connected",
      fallback_mode: false,
      error: null,
      puppygraph_url: expect.any(String),
      puppygraph_database: expect.any(String),
    });
  }, 60_000);

  it("does not write query or parameter values to stderr", async () => {
    const querySecret = "live-query-secret";
    const parameterSecret = "live-parameter-secret";
    const logStart = stderrOutput.length;

    const result = parseTextContent(
      await client.callTool({
        name: "puppygraph_query",
        arguments: {
          language: "cypher",
          query: `MATCH (n) WHERE '${querySecret}' = '${querySecret}' RETURN count(n) AS count`,
          parameters: { parameter: parameterSecret },
        },
      }),
    );
    expect(result).toMatchObject({
      data: [
        {
          count: expect.any(Number),
        },
      ],
      metadata: {
        execution_time: expect.any(Number),
        row_count: 1,
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    const queryLogs = stderrOutput.slice(logStart);
    expect(queryLogs).toContain("request_id=");
    expect(queryLogs).toContain("language=cypher");
    expect(queryLogs).not.toContain(querySecret);
    expect(queryLogs).not.toContain(parameterSecret);
  });

  it("returns an explicit sanitized MCP error for an upstream query failure", async () => {
    const querySecret = "live-invalid-query-secret";
    const logStart = stderrOutput.length;

    const result = await client.callTool({
      name: "puppygraph_query",
      arguments: {
        language: "cypher",
        query: `THIS IS NOT VALID CYPHER '${querySecret}'`,
      },
    });

    expect(result.isError).toBe(true);
    expect(parseTextContent(result)).toEqual({
      data: [],
      metadata: {
        error: "PuppyGraph query was rejected",
        error_type: "QUERY_REJECTED",
      },
    });
    expect(JSON.stringify(result)).not.toContain(querySecret);

    await new Promise((resolve) => setImmediate(resolve));
    expect(stderrOutput.slice(logStart)).not.toContain(querySecret);
  });
});
