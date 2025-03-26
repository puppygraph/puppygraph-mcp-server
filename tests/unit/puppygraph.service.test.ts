import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Neo4jClient } from '../../src/clients/neo4j';
import { GremlinClient } from '../../src/clients/gremlin';
import { loadConfig } from '../../src/utils/config';
import { fetchSchemaFromEndpoint } from '../../src/utils/schema';

// Need to mock these imports before importing the service
vi.mock('../../src/clients/neo4j', () => {
  return {
    Neo4jClient: vi.fn().mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(true),
      isConnected: vi.fn().mockReturnValue(true),
      getConnectionError: vi.fn().mockReturnValue(null),
      executeQuery: vi.fn().mockResolvedValue([]),
      close: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

vi.mock('../../src/clients/gremlin', () => {
  return {
    GremlinClient: vi.fn().mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(true),
      isConnected: vi.fn().mockReturnValue(true),
      getConnectionError: vi.fn().mockReturnValue(null),
      executeQuery: vi.fn().mockResolvedValue([]),
      getSchemaData: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

vi.mock('../../src/utils/config', () => {
  return {
    loadConfig: vi.fn().mockReturnValue({
      neo4j: {
        url: 'bolt://localhost:7687',
        username: 'neo4j',
        password: 'password',
        database: '',
      },
      gremlin: {
        url: 'ws://localhost:8182/gremlin',
        username: 'puppygraph',
        password: 'puppygraph123',
        traversalSource: 'g',
      },
      schema: {
        url: 'http://localhost:8081/schemajson',
        username: 'puppygraph',
        password: 'puppygraph123',
      },
    }),
  };
});

vi.mock('../../src/utils/schema', () => {
  return {
    fetchSchemaFromEndpoint: vi.fn().mockResolvedValue({
      summary: "PuppyGraph Schema Information",
      source: "Schema API",
      schema: {},
      schema_endpoint: 'http://localhost:8081/schemajson',
      timestamp: '2023-03-26T00:00:00.000Z',
    }),
  };
});

// Now import the puppygraph service
import { PuppyGraphService } from '../../src/services/puppygraph.js';

describe('PuppyGraphService', () => {
  let service: PuppyGraphService;
  let mockNeo4jClient: any;
  let mockGremlinClient: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create a manual instance for testing
    service = new PuppyGraphService();
  });

  describe('executeGremlin', () => {
    it('should execute a Gremlin query successfully', async () => {
      // Replace the private gremlinClient with our spy
      mockGremlinClient = {
        isConnected: vi.fn().mockReturnValue(true),
        executeQuery: vi.fn().mockResolvedValue([{ id: 1, name: 'Test' }]),
        connect: vi.fn().mockResolvedValue(true),
        getConnectionError: vi.fn().mockReturnValue(null),
      };

      // @ts-ignore - accessing private property for testing
      service.gremlinClient = mockGremlinClient;

      const result = await service.executeGremlin({
        query: 'g.V().count()',
      });

      expect(mockGremlinClient.executeQuery).toHaveBeenCalled();
      expect(result).toEqual({
        data: [{ id: 1, name: 'Test' }],
        metadata: {
          execution_time: expect.any(Number),
          row_count: 1,
        },
      });
    });

    it('should throw an error if not connected to Gremlin endpoint', async () => {
      mockGremlinClient = {
        isConnected: vi.fn().mockReturnValue(false),
        connect: vi.fn().mockResolvedValue(false),
        getConnectionError: vi.fn().mockReturnValue('Connection failed'),
      };

      // @ts-ignore - accessing private property for testing
      service.gremlinClient = mockGremlinClient;

      await expect(service.executeGremlin({ query: 'g.V().count()' })).rejects.toThrow(
        'Cannot execute Gremlin query'
      );
    });
  });

  describe('executeCypher', () => {
    it('should execute a Cypher query successfully', async () => {
      mockNeo4jClient = {
        isConnected: vi.fn().mockReturnValue(true),
        executeQuery: vi.fn().mockResolvedValue([{ node: { id: 1, name: 'Test' } }]),
        connect: vi.fn().mockResolvedValue(true),
        getConnectionError: vi.fn().mockReturnValue(null),
      };

      // @ts-ignore - accessing private property for testing
      service.neo4jClient = mockNeo4jClient;

      const result = await service.executeCypher({
        query: 'MATCH (n) RETURN n LIMIT 1',
      });

      expect(mockNeo4jClient.executeQuery).toHaveBeenCalled();
      expect(result).toEqual({
        data: [{ node: { id: 1, name: 'Test' } }],
        metadata: {
          execution_time: expect.any(Number),
          row_count: 1,
        },
      });
    });

    it('should throw an error if not connected to Neo4j endpoint', async () => {
      mockNeo4jClient = {
        isConnected: vi.fn().mockReturnValue(false),
        connect: vi.fn().mockResolvedValue(false),
        getConnectionError: vi.fn().mockReturnValue('Connection failed'),
      };

      // @ts-ignore - accessing private property for testing
      service.neo4jClient = mockNeo4jClient;

      await expect(service.executeCypher({ query: 'MATCH (n) RETURN n' })).rejects.toThrow(
        'Cannot execute Cypher query'
      );
    });
  });

  describe('getDataSources', () => {
    it('should fetch schema from endpoint successfully', async () => {
      const mockSchemaData = {
        summary: "PuppyGraph Schema Information",
        source: "Schema API",
        schema: { nodes: [], relationships: [] },
      };
      
      (fetchSchemaFromEndpoint as any).mockResolvedValueOnce(mockSchemaData);
      
      const result = await service.getDataSources();
      
      expect(fetchSchemaFromEndpoint).toHaveBeenCalled();
      expect(result).toEqual(mockSchemaData);
    });

    it('should fall back to Neo4j if schema endpoint fails', async () => {
      (fetchSchemaFromEndpoint as any).mockRejectedValueOnce(new Error('Schema endpoint failed'));
      
      mockNeo4jClient = {
        isConnected: vi.fn().mockReturnValue(true),
        executeQuery: vi.fn().mockResolvedValue([{ count: 42 }]),
        connect: vi.fn().mockResolvedValue(true),
        getConnectionError: vi.fn().mockReturnValue(null),
      };
      
      // @ts-ignore - accessing private property for testing
      service.neo4jClient = mockNeo4jClient;
      
      const result = await service.getDataSources();
      
      expect(fetchSchemaFromEndpoint).toHaveBeenCalled();
      expect(mockNeo4jClient.executeQuery).toHaveBeenCalledWith('MATCH (n) RETURN count(n) as count');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('nodeCount', 42);
    });
  });

  describe('getConnectionStatus', () => {
    it('should return connected status when either client is connected', () => {
      mockNeo4jClient = {
        isConnected: vi.fn().mockReturnValue(true),
        getConnectionError: vi.fn().mockReturnValue(null),
      };
      
      mockGremlinClient = {
        isConnected: vi.fn().mockReturnValue(false),
        getConnectionError: vi.fn().mockReturnValue('Gremlin error'),
      };
      
      // @ts-ignore - accessing private property for testing
      service.neo4jClient = mockNeo4jClient;
      // @ts-ignore - accessing private property for testing
      service.gremlinClient = mockGremlinClient;
      // @ts-ignore - accessing private property for testing
      service.connectionError = 'Gremlin error';
      
      const status = service.getConnectionStatus();
      
      expect(status.connected).toBe(true);
      expect(status.neo4jConnected).toBe(true);
      expect(status.gremlinConnected).toBe(false);
      expect(status.connectionError).toBe('Gremlin error');
      expect(status.fallbackMode).toBe(false);
    });
  });
});