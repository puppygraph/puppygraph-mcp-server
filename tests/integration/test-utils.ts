import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PipeServerTransport } from '@modelcontextprotocol/sdk/server/pipe.js';
import { McpClient } from '@modelcontextprotocol/sdk/client/mcp.js';
import { PipeClientTransport } from '@modelcontextprotocol/sdk/client/pipe.js';

/**
 * Creates a server and client connected via pipes for testing
 * This allows testing MCP servers without using the stdio transport
 */
export async function createConnectedClient(server: McpServer): Promise<{
  client: McpClient;
  clientTransport: PipeClientTransport;
  serverTransport: PipeServerTransport;
}> {
  // Create pipe transports for server and client
  const pipe = { server: null as any, client: null as any };
  pipe.server = new PipeServerTransport();
  pipe.client = new PipeClientTransport({
    onData: (data) => pipe.server.receive(data),
    onClose: () => {},
  });

  pipe.server.onData = (data) => pipe.client.receive(data);
  
  // Connect server to our pipe transport
  await server.connect(pipe.server);
  
  // Create and connect client
  const client = new McpClient();
  await client.connect(pipe.client);
  
  return {
    client,
    clientTransport: pipe.client,
    serverTransport: pipe.server,
  };
}

/**
 * Mocks the console.error to capture or suppress logs during tests
 */
export function mockConsoleError() {
  const originalConsoleError = console.error;
  const mockConsoleError = vi.fn();
  
  beforeEach(() => {
    console.error = mockConsoleError;
  });
  
  afterEach(() => {
    console.error = originalConsoleError;
  });
  
  return mockConsoleError;
}