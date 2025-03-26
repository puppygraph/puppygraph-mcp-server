import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Neo4jClient } from '../../src/clients/neo4j';

// Mock the neo4j-driver module
vi.mock('neo4j-driver', () => {
  const mockSession = {
    run: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const mockDriver = {
    session: vi.fn().mockReturnValue(mockSession),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return {
    auth: {
      basic: vi.fn().mockReturnValue({ username: 'test', password: 'test' }),
    },
    driver: vi.fn().mockReturnValue(mockDriver),
    types: {
      Node: class MockNode {
        identity: any;
        labels: string[];
        properties: Record<string, any>;
        constructor(identity: any, labels: string[], properties: Record<string, any>) {
          this.identity = identity;
          this.labels = labels;
          this.properties = properties;
        }
      },
      Relationship: class MockRelationship {
        identity: any;
        type: string;
        start: any;
        end: any;
        properties: Record<string, any>;
        constructor(identity: any, type: string, start: any, end: any, properties: Record<string, any>) {
          this.identity = identity;
          this.type = type;
          this.start = start;
          this.end = end;
          this.properties = properties;
        }
      },
      Path: class MockPath {
        segments: any[];
        constructor(segments: any[]) {
          this.segments = segments;
        }
      },
    },
    isInt: vi.fn().mockImplementation((value) => typeof value === 'object' && value !== null && 'toNumber' in value),
  };
});

describe('Neo4jClient', () => {
  let client: Neo4jClient;
  const mockConfig = {
    url: 'bolt://localhost:7687',
    username: 'neo4j',
    password: 'password',
    database: 'neo4j',
  };

  beforeEach(() => {
    client = new Neo4jClient(mockConfig);
    // Reset all mocks for each test
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('connect', () => {
    it('should successfully connect to Neo4j', async () => {
      // Directly modify mock session behavior for this test
      const mockSession = {
        run: vi.fn().mockResolvedValueOnce({ records: [] }),
        close: vi.fn().mockResolvedValue(undefined)
      };
      
      const mockDriver = {
        session: vi.fn().mockReturnValue(mockSession),
        close: vi.fn().mockResolvedValue(undefined)
      };
      
      // Use spyOn with mockImplementation to replace the driver function
      const neo4jModule = await import('neo4j-driver');
      vi.spyOn(neo4jModule, 'driver').mockImplementation(() => mockDriver);
      
      const result = await client.connect();

      expect(result).toBe(true);
      expect(neo4jModule.driver).toHaveBeenCalledWith(
        mockConfig.url,
        undefined,
        expect.objectContaining({
          disableLosslessIntegers: true
        })
      );
      expect(mockSession.run).toHaveBeenCalledWith('RETURN 1 as result');
      expect(client.isConnected()).toBe(true);
    });

    it('should handle connection failures', async () => {
      // Directly modify mock session behavior for this test
      const mockSession = {
        run: vi.fn().mockRejectedValueOnce(new Error('Connection failed')),
        close: vi.fn().mockResolvedValue(undefined)
      };
      
      const mockDriver = {
        session: vi.fn().mockReturnValue(mockSession),
        close: vi.fn().mockResolvedValue(undefined)
      };
      
      // Use spyOn with mockImplementation to replace the driver function
      const neo4jModule = await import('neo4j-driver');
      vi.spyOn(neo4jModule, 'driver').mockImplementation(() => mockDriver);

      const result = await client.connect();

      expect(result).toBe(false);
      expect(neo4jModule.driver).toHaveBeenCalledWith(
        mockConfig.url,
        undefined,
        expect.objectContaining({
          disableLosslessIntegers: true
        })
      );
      expect(mockSession.run).toHaveBeenCalledWith('RETURN 1 as result');
      expect(client.isConnected()).toBe(false);
      expect(client.getConnectionError()).toBe('Connection failed');
    });
  });

  describe('executeQuery', () => {
    it('should execute a Cypher query successfully', async () => {
      // Directly modify mock session behavior for this test
      const mockSession = {
        run: vi.fn().mockResolvedValueOnce({
          records: [
            {
              keys: ['n'],
              get: (key: string) => ({ id: 1, name: 'Node1' }),
            },
          ],
        }),
        close: vi.fn().mockResolvedValue(undefined)
      };
      
      // Mock properties for this test
      Object.defineProperty(client, 'driver', {
        value: { session: () => mockSession },
        writable: true,
        configurable: true
      });
      
      Object.defineProperty(client, 'connected', {
        value: true,
        writable: true,
        configurable: true
      });

      const result = await client.executeQuery('MATCH (n) RETURN n LIMIT 1');

      expect(mockSession.run).toHaveBeenCalledWith('MATCH (n) RETURN n LIMIT 1', {});
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('n');
    });

    it('should throw an error if not connected', async () => {
      vi.spyOn(client, 'isConnected').mockReturnValue(false);

      await expect(client.executeQuery('MATCH (n) RETURN n LIMIT 1')).rejects.toThrow(
        'Not connected to Neo4j endpoint'
      );
    });
  });

  describe('close', () => {
    it('should close the connection', async () => {
      const mockDriver = {
        close: vi.fn().mockResolvedValue(undefined)
      };

      // Mock properties
      Object.defineProperty(client, 'driver', {
        value: mockDriver,
        writable: true,
        configurable: true
      });
      Object.defineProperty(client, 'connected', {
        value: true,
        writable: true,
        configurable: true
      });

      await client.close();

      expect(mockDriver.close).toHaveBeenCalled();
    });
  });
});