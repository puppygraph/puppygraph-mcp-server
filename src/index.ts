#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPuppyGraphServer } from "./server.js";
import { puppyGraphService, shutdown } from "./services/puppygraph.js";
import { errorCategory, urlForLog } from "./utils/logging.js";
import { isReadOnly } from "./utils/readonly.js";

export const server = createPuppyGraphServer(puppyGraphService);

async function main() {
  console.error("Starting PuppyGraph MCP Server...");

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The MCP client closing stdin means the session is over.
  process.stdin.on("end", shutdown);

  const status = puppyGraphService.getConnectionStatus();

  console.error("PuppyGraph MCP Server running on stdio");
  console.error(
    "Available tools: puppygraph_query, puppygraph_schema, puppygraph_status",
  );
  console.error(
    `PuppyGraph URL: ${urlForLog(process.env.PUPPYGRAPH_URL || "bolt://localhost:7687")}`,
  );
  console.error(
    `PuppyGraph Database: ${process.env.PUPPYGRAPH_DATABASE || "default"}`,
  );
  console.error(
    `Connection status: ${status.connected ? "Connected" : "Disconnected"}${
      status.fallbackMode ? " (Using fallback data)" : ""
    }`,
  );

  console.error(
    `Read-only mode: ${isReadOnly() ? "on (write queries are rejected)" : "off"}`,
  );

  if (status.connectionError) {
    console.error("Connection error reported");
  }
}

main().catch((error) => {
  console.error(`Fatal startup error error_type=${errorCategory(error)}`);
  process.exit(1);
});
