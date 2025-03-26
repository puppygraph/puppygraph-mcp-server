import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { puppyGraphService } from "./services/puppygraph.js";

// Create and export the server for testing
export const server = new McpServer({
  name: "puppygraph",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});

server.tool(
  "puppygraph_query",
  "Execute a graph query (Gremlin or Cypher) against PuppyGraph",
  {
    query: z.string().describe("The query to execute (Gremlin or Cypher)"),
    language: z.enum(["gremlin", "cypher"]).describe("The query language to use"),
    parameters: z.record(z.any()).optional().describe("Optional parameters for the query")
  },
  async (args, _extra) => {
    try {
      console.error(`Executing ${args.language} query: ${args.query}`);
      
      let result;
      if (args.language === "gremlin") {
        result = await puppyGraphService.executeGremlin({
          query: args.query,
          parameters: args.parameters || {}
        });
      } else {
        result = await puppyGraphService.executeCypher({
          query: args.query,
          parameters: args.parameters || {}
        });
      }
      
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error: any) {
      console.error(`Error executing ${args.language} query:`, error);
      
      const errorResult = {
        data: [],
        metadata: {
          error: error.message || `Error executing ${args.language} query`,
          error_type: error.name || "Error"
        }
      };
      
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(errorResult, null, 2)
          }
        ]
      };
    }
  }
);

server.tool(
  "puppygraph_schema",
  "Get schema and structure information about the PuppyGraph database",
  {},
  async (_args, _extra) => {
    try {
      console.error("Fetching schema information");
      
      const result = await puppyGraphService.getDataSources();
      
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error: any) {
      console.error("Error fetching schema information:", error);
      
      const errorResult = {
        metadata: {
          error: error.message || "Error fetching schema information",
          error_type: error.name || "Error"
        }
      };
      
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(errorResult, null, 2)
          }
        ]
      };
    }
  }
);

server.tool(
  "puppygraph_status",
  "Get connection status and configuration information for PuppyGraph",
  {},
  async (_args, _extra) => {
    try {
      console.error("Fetching connection status information");
      
      const status = puppyGraphService.getConnectionStatus();
      
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: status.connected ? "connected" : "disconnected",
              fallback_mode: status.fallbackMode,
              error: status.connectionError,
              puppygraph_url: process.env.PUPPYGRAPH_URL || "bolt://localhost:7687",
              puppygraph_database: process.env.PUPPYGRAPH_DATABASE || "default"
            }, null, 2)
          }
        ]
      };
    } catch (error: any) {
      console.error("Error fetching connection status:", error);
      
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "error",
              error: error.message || "Error fetching connection status"
            }, null, 2)
          }
        ]
      };
    }
  }
);

// MCP prefixed versions for compatibility
server.tool(
  "mcp__puppygraph_query",
  "Execute a graph query (Gremlin or Cypher) against PuppyGraph",
  {
    query: z.string().describe("The query to execute (Gremlin or Cypher)"),
    language: z.enum(["gremlin", "cypher"]).describe("The query language to use"),
    parameters: z.record(z.any()).optional().describe("Optional parameters for the query")
  },
  async (args, _extra) => {
    try {
      console.error(`Executing ${args.language} query via mcp__ prefix: ${args.query}`);
      
      let result;
      if (args.language === "gremlin") {
        result = await puppyGraphService.executeGremlin({
          query: args.query,
          parameters: args.parameters || {}
        });
      } else {
        result = await puppyGraphService.executeCypher({
          query: args.query,
          parameters: args.parameters || {}
        });
      }
      
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error: any) {
      console.error(`Error executing ${args.language} query:`, error);
      
      const errorResult = {
        data: [],
        metadata: {
          error: error.message || `Error executing ${args.language} query`,
          error_type: error.name || "Error"
        }
      };
      
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(errorResult, null, 2)
          }
        ]
      };
    }
  }
);

server.tool(
  "mcp__puppygraph_schema",
  "Get schema and structure information about the PuppyGraph database",
  {},
  async (_args, _extra) => {
    try {
      console.error("Fetching schema information via mcp__ prefix");
      
      const result = await puppyGraphService.getDataSources();
      
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error: any) {
      console.error("Error fetching schema information:", error);
      
      const errorResult = {
        metadata: {
          error: error.message || "Error fetching schema information",
          error_type: error.name || "Error"
        }
      };
      
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(errorResult, null, 2)
          }
        ]
      };
    }
  }
);

server.tool(
  "mcp__puppygraph_status",
  "Get connection status and configuration information for PuppyGraph",
  {},
  async (_args, _extra) => {
    try {
      console.error("Fetching connection status via mcp__ prefix");
      
      const status = puppyGraphService.getConnectionStatus();
      
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: status.connected ? "connected" : "disconnected",
              fallback_mode: status.fallbackMode,
              error: status.connectionError,
              puppygraph_url: process.env.PUPPYGRAPH_URL || "bolt://localhost:7687",
              puppygraph_database: process.env.PUPPYGRAPH_DATABASE || "default"
            }, null, 2)
          }
        ]
      };
    } catch (error: any) {
      console.error("Error fetching connection status:", error);
      
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "error",
              error: error.message || "Error fetching connection status"
            }, null, 2)
          }
        ]
      };
    }
  }
);

async function main() {
  console.error("Starting PuppyGraph MCP Server...");
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  const status = puppyGraphService.getConnectionStatus();
  
  console.error("PuppyGraph MCP Server running on stdio");
  console.error(`Available tools: puppygraph_query, puppygraph_schema, puppygraph_status`);
  console.error(`PuppyGraph URL: ${process.env.PUPPYGRAPH_URL || "bolt://localhost:7687"}`);
  console.error(`PuppyGraph Database: ${process.env.PUPPYGRAPH_DATABASE || "default"}`);
  console.error(`Connection status: ${status.connected ? "Connected" : "Disconnected"}${status.fallbackMode ? " (Using fallback data)" : ""}`);
  
  if (status.connectionError) {
    console.error(`Connection error: ${status.connectionError}`);
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});