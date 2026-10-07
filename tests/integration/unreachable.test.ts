import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// No mocks: the real Neo4j, Gremlin and schema clients point at a closed port.
// The server must report errors and never answer with sample or made-up data.
const UNREACHABLE = {
  PUPPYGRAPH_URL: "bolt://127.0.0.1:1",
  PUPPYGRAPH_GREMLIN_URL: "ws://127.0.0.1:1/gremlin",
  PUPPYGRAPH_SCHEMA_URL: "http://127.0.0.1:1/schemajson",
};

function parseTextContent(result: { content: Array<Record<string, unknown>> }) {
  const content = result.content[0];
  if (content.type !== "text" || typeof content.text !== "string") {
    throw new Error("Expected an MCP text result");
  }
  return JSON.parse(content.text);
}

describe("MCP server with PuppyGraph unreachable", () => {
  const originalEnv = { ...process.env };
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    Object.assign(process.env, UNREACHABLE);
    const { puppyGraphService } = await import("../../src/services/puppygraph.js");
    const { createPuppyGraphServer } = await import("../../src/server.js");

    const server = createPuppyGraphServer(puppyGraphService, process.env, false);
    client = new Client({ name: "unreachable-test-client", version: "1.2.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    close = async () => {
      await client.close();
      await server.close();
      await puppyGraphService.close();
    };
  });

  afterAll(async () => {
    await close?.();
    process.env = originalEnv;
  });

  it.each([
    ["cypher", "MATCH (n) RETURN n LIMIT 5"],
    ["gremlin", "g.V().limit(5)"],
  ])("returns a connection error for a %s query, with no rows", async (language, query) => {
    const result = await client.callTool({
      name: "puppygraph_query",
      arguments: { language, query },
    });

    expect(result.isError).toBe(true);
    expect(parseTextContent(result)).toEqual({
      data: [],
      metadata: {
        error: "Unable to connect to PuppyGraph",
        error_type: "CONNECTION_FAILED",
      },
    });
  });

  it("returns an error for the schema, not a sample schema", async () => {
    const result = await client.callTool({ name: "puppygraph_schema", arguments: {} });

    expect(result.isError).toBe(true);
    const body = parseTextContent(result);
    expect(Object.keys(body)).toEqual(["metadata"]);
    expect(body.metadata.error_type).toBe("CONNECTION_FAILED");
  });

  it("reports the server as disconnected", async () => {
    const result = await client.callTool({ name: "puppygraph_status", arguments: {} });

    expect(parseTextContent(result)).toMatchObject({
      status: "disconnected",
      fallback_mode: false,
      error_type: "CONNECTION_FAILED",
    });
  });
});
