import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GremlinClient } from '../../src/clients/gremlin';

// Mock the gremlin module
vi.mock('gremlin', () => {
  const mockTraversal = {
    V: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    count: vi.fn().mockReturnThis(),
    next: vi.fn().mockResolvedValue({ value: 1, done: false }),
    toList: vi.fn().mockResolvedValue([{ id: 1, label: 'person' }]),
  };

  const mockG = {
    V: vi.fn().mockReturnValue(mockTraversal),
    E: vi.fn().mockReturnValue(mockTraversal),
  };

  const mockDriverRemoteConnection = {
    close: vi.fn().mockResolvedValue(undefined),
  };

  const mockGraph = {
    traversal: vi.fn().mockReturnValue({
      withRemote: vi.fn().mockReturnValue(mockG),
    }),
  };

  // Mock client approach
  const mockSubmission = {
    all: vi.fn().mockResolvedValue([{ id: 1, label: 'person' }]),
  };

  const mockClient = {
    submit: vi.fn().mockResolvedValue(mockSubmission),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return {
    driver: {
      auth: {
        PlainTextSaslAuthenticator: vi.fn(),
      },
      DriverRemoteConnection: vi.fn().mockImplementation(() => mockDriverRemoteConnection),
    },
    structure: {
      Graph: vi.fn().mockImplementation(() => mockGraph),
    },
    process: {
      traversal: vi.fn().mockReturnValue({
        withRemote: vi.fn().mockReturnValue(mockG),
      }),
    },
    Client: vi.fn().mockImplementation(() => mockClient),
  };
});

describe('GremlinClient', () => {
  let client: GremlinClient;
  const mockConfig = {
    url: 'ws://localhost:8182/gremlin',
    username: 'puppygraph',
    password: 'puppygraph123',
    traversalSource: 'g',
  };

  beforeEach(() => {
    client = new GremlinClient(mockConfig);
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('connect', () => {
    it('should successfully connect using Graph approach', async () => {
      const gremlinModule = await import('gremlin');
      
      const result = await client.connect();

      expect(result).toBe(true);
      expect(gremlinModule.structure.Graph).toHaveBeenCalled();
      expect(gremlinModule.driver.DriverRemoteConnection).toHaveBeenCalledWith(
        mockConfig.url,
        expect.objectContaining({
          traversalSource: mockConfig.traversalSource,
        })
      );
      expect(client.isConnected()).toBe(true);
    });

    it('should handle connection failures', async () => {
      const gremlinModule = await import('gremlin');
      
      // Make the traversal.next() throw an error to simulate connection failure
      const mockGraph = gremlinModule.structure.Graph();
      const mockTraversal = mockGraph.traversal().withRemote({}).V().limit(1).count();
      mockTraversal.next.mockRejectedValueOnce(new Error('Connection failed'));

      const result = await client.connect();

      expect(result).toBe(false);
      expect(client.isConnected()).toBe(false);
      expect(client.getConnectionError()).toContain('Connection failed');
    });
  });

  describe('executeQuery', () => {
    it('should execute a Gremlin query using graph approach', async () => {
      // Set up the client as connected with the g approach
      vi.spyOn(client, 'isConnected').mockReturnValue(true);

      // Set up the client property with a mock client that has 'g'
      const mockG = {
        V: vi.fn().mockReturnThis(),
        count: vi.fn().mockReturnThis(),
        toList: vi.fn().mockResolvedValue([{ id: 1, label: 'person' }]),
      };

      Object.defineProperty(client, 'client', {
        value: { g: mockG },
        writable: true,
      });

      // Execute a query that starts with g.
      const result = await client.executeQuery('g.V().count()');

      expect(result).toEqual([{ id: 1, label: 'person' }]);
    });

    it('should throw an error if not connected', async () => {
      vi.spyOn(client, 'isConnected').mockReturnValue(false);

      await expect(client.executeQuery('g.V().count()')).rejects.toThrow(
        'Not connected to Gremlin endpoint'
      );
    });

    it('should reject unsafe queries', async () => {
      vi.spyOn(client, 'isConnected').mockReturnValue(true);
      
      Object.defineProperty(client, 'client', {
        value: { g: {} },
        writable: true,
      });

      await expect(client.executeQuery('g.V().count(); System.exit(1)')).rejects.toThrow(
        'Potentially unsafe Gremlin query rejected'
      );
    });
  });

  describe('close', () => {
    it('should close the connection', async () => {
      const mockClientWithClose = {
        close: vi.fn().mockResolvedValue(undefined),
      };

      Object.defineProperty(client, 'client', {
        value: mockClientWithClose,
        writable: true,
      });
      Object.defineProperty(client, 'connected', {
        value: true,
        writable: true,
      });

      await client.close();

      expect(mockClientWithClose.close).toHaveBeenCalled();
      expect(client.isConnected()).toBe(false);
    });
  });
});