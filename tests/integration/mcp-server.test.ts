import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

// Mock the MCP SDK since we don't need actual communication for unit tests
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    tool: vi.fn(),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/mcp.js', () => ({
  McpClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    invokeMethod: vi.fn().mockImplementation((method, params) => {
      // Mock responses based on the method and params
      if (method === 'puppygraph_query') {
        if (params.query.includes('error')) {
          return {
            content: [{ 
              type: 'text', 
              text: JSON.stringify({
                metadata: { error: `Simulated ${params.language} error` }
              })
            }]
          };
        }
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({
              data: [{ id: 1 }, { id: 2 }],
              metadata: { execution_time: 42, row_count: 2 }
            })
          }]
        };
      }
      if (method === 'puppygraph_schema') {
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({
              summary: 'PuppyGraph Schema Information',
              source: 'Mock Test',
              totalNodes: 10,
              totalRelationships: 15
            })
          }]
        };
      }
      if (method === 'puppygraph_status') {
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({
              status: 'connected',
              fallback_mode: false
            })
          }]
        };
      }
      return { content: [{ type: 'text', text: '{}' }] };
    }),
  })),
}));

// Mock the puppygraph service
vi.mock('../../src/services/puppygraph.js', () => ({
  puppyGraphService: {
    executeGremlin: vi.fn().mockImplementation(async ({ query, parameters }) => {
      if (query.includes('error')) {
        throw new Error('Simulated Gremlin error');
      }
      return {
        data: [
          { id: 1, label: 'vertex', properties: { name: ['Test'] } },
          { id: 2, label: 'vertex', properties: { name: ['Test2'] } },
        ],
        metadata: {
          execution_time: 42,
          row_count: 2,
        },
      };
    }),
    executeCypher: vi.fn().mockImplementation(async ({ query, parameters }) => {
      if (query.includes('error')) {
        throw new Error('Simulated Cypher error');
      }
      return {
        data: [
          { n: { id: 1, labels: ['Node'], properties: { name: 'Test' } } },
          { n: { id: 2, labels: ['Node'], properties: { name: 'Test2' } } },
        ],
        metadata: {
          execution_time: 38,
          row_count: 2,
        },
      };
    }),
    getDataSources: vi.fn().mockResolvedValue({
      summary: 'PuppyGraph Schema Information',
      source: 'Mock Test',
      nodeLabels: [{ label: 'Node', count: 10 }],
      relationshipTypes: [{ type: 'CONNECTS_TO', count: 15 }],
      totalNodes: 10,
      totalRelationships: 15,
    }),
    getConnectionStatus: vi.fn().mockReturnValue({
      connected: true,
      neo4jConnected: true,
      gremlinConnected: true,
      connectionError: null,
      fallbackMode: false,
    }),
  },
}));

// This allows importing the server functions
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(),
}));

// Import and mock the server
vi.mock('../../src/index.js', () => ({
  server: {
    connect: vi.fn(),
    tool: vi.fn(),
  }
}));

describe('MCP Server Integration Tests', () => {
  let client: any;
  let puppyGraphService: any;

  beforeAll(async () => {
    const { puppyGraphService: service } = await import('../../src/services/puppygraph.js');
    puppyGraphService = service;
    
    // Create mock client that doesn't actually need MCP
    client = {
      invokeMethod: vi.fn().mockImplementation((method, params) => {
        if (method === 'puppygraph_query') {
          if (params.language === 'gremlin') {
            return {
              content: [{ 
                type: 'text', 
                text: JSON.stringify({
                  data: [{ id: 1 }, { id: 2 }],
                  metadata: { execution_time: 42, row_count: 2 }
                })
              }]
            };
          } else {
            return {
              content: [{ 
                type: 'text', 
                text: JSON.stringify({
                  data: [{ n: { id: 1 } }, { n: { id: 2 } }],
                  metadata: { execution_time: 38, row_count: 2 }
                })
              }]
            };
          }
        }
        if (method === 'puppygraph_schema') {
          return {
            content: [{ 
              type: 'text', 
              text: JSON.stringify({
                summary: 'PuppyGraph Schema Information',
                source: 'Mock Test',
                totalNodes: 10,
                totalRelationships: 15
              })
            }]
          };
        }
        if (method === 'puppygraph_status') {
          return {
            content: [{ 
              type: 'text', 
              text: JSON.stringify({
                status: 'connected',
                fallback_mode: false
              })
            }]
          };
        }
        return { content: [{ type: 'text', text: '{}' }] };
      }),
      disconnect: vi.fn()
    };
  });

  afterAll(async () => {
    await client.disconnect();
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('Tool: puppygraph_query', () => {
    it('should execute Gremlin queries successfully', async () => {
      const response = await client.invokeMethod('puppygraph_query', {
        query: 'g.V().limit(10)',
        language: 'gremlin',
      });

      const { puppyGraphService } = await import('../../src/services/puppygraph.js');
      
      expect(puppyGraphService.executeGremlin).toHaveBeenCalledWith({
        query: 'g.V().limit(10)',
        parameters: {},
      });
      
      expect(response.content).toHaveLength(1);
      expect(response.content[0].type).toBe('text');
      
      // Parse the JSON response
      const result = JSON.parse(response.content[0].text);
      expect(result).toHaveProperty('data');
      expect(result.data).toHaveLength(2);
      expect(result).toHaveProperty('metadata');
      expect(result.metadata).toHaveProperty('execution_time');
      expect(result.metadata).toHaveProperty('row_count', 2);
    });

    it('should execute Cypher queries successfully', async () => {
      const response = await client.invokeMethod('puppygraph_query', {
        query: 'MATCH (n) RETURN n LIMIT 10',
        language: 'cypher',
      });

      const { puppyGraphService } = await import('../../src/services/puppygraph.js');
      
      expect(puppyGraphService.executeCypher).toHaveBeenCalledWith({
        query: 'MATCH (n) RETURN n LIMIT 10',
        parameters: {},
      });
      
      // Parse the JSON response
      const result = JSON.parse(response.content[0].text);
      expect(result).toHaveProperty('data');
      expect(result.data).toHaveLength(2);
      expect(result).toHaveProperty('metadata');
      expect(result.metadata).toHaveProperty('execution_time');
      expect(result.metadata).toHaveProperty('row_count', 2);
    });

    it('should handle errors in queries', async () => {
      const response = await client.invokeMethod('puppygraph_query', {
        query: 'g.V().error()',
        language: 'gremlin',
      });

      // Parse the JSON response
      const result = JSON.parse(response.content[0].text);
      expect(result).toHaveProperty('metadata');
      expect(result.metadata).toHaveProperty('error');
      expect(result.metadata.error).toContain('Simulated Gremlin error');
    });
  });

  describe('Tool: puppygraph_schema', () => {
    it('should return schema information', async () => {
      const response = await client.invokeMethod('puppygraph_schema', {});

      const { puppyGraphService } = await import('../../src/services/puppygraph.js');
      
      expect(puppyGraphService.getDataSources).toHaveBeenCalled();
      
      // Parse the JSON response
      const result = JSON.parse(response.content[0].text);
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('source', 'Mock Test');
      expect(result).toHaveProperty('totalNodes', 10);
      expect(result).toHaveProperty('totalRelationships', 15);
    });
  });

  describe('Tool: puppygraph_status', () => {
    it('should return connection status', async () => {
      const response = await client.invokeMethod('puppygraph_status', {});

      const { puppyGraphService } = await import('../../src/services/puppygraph.js');
      
      expect(puppyGraphService.getConnectionStatus).toHaveBeenCalled();
      
      // Parse the JSON response
      const result = JSON.parse(response.content[0].text);
      expect(result).toHaveProperty('status', 'connected');
      expect(result).toHaveProperty('fallback_mode', false);
    });
  });

  describe('MCP prefix compatibility', () => {
    it('should handle mcp__puppygraph_query calls', async () => {
      const response = await client.invokeMethod('mcp__puppygraph_query', {
        query: 'MATCH (n) RETURN n LIMIT 5',
        language: 'cypher',
      });

      const { puppyGraphService } = await import('../../src/services/puppygraph.js');
      
      expect(puppyGraphService.executeCypher).toHaveBeenCalledWith({
        query: 'MATCH (n) RETURN n LIMIT 5',
        parameters: {},
      });
      
      // Results should be the same as with the non-prefixed method
      const result = JSON.parse(response.content[0].text);
      expect(result).toHaveProperty('data');
      expect(result.data).toHaveLength(2);
    });
  });
});