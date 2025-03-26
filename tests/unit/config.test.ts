import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../src/utils/config';

describe('Config Utilities', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset env before each test
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original env after each test
    process.env = originalEnv;
  });

  describe('loadConfig', () => {
    it('should load default configuration when no env variables are set', () => {
      const config = loadConfig();

      expect(config.neo4j).toEqual({
        url: 'bolt://localhost:7687',
        username: 'neo4j',
        password: 'password',
        database: '',
      });

      expect(config.gremlin).toEqual({
        url: 'ws://localhost:8182/gremlin',
        username: 'puppygraph',
        password: 'puppygraph123',
        traversalSource: 'g',
      });

      expect(config.schema).toEqual({
        url: 'http://localhost:8081/schemajson',
        username: 'puppygraph',
        password: 'puppygraph123',
      });
    });

    it('should override defaults with environment variables', () => {
      // Set environment variables
      process.env.PUPPYGRAPH_URL = 'bolt://custom-neo4j:7687';
      process.env.PUPPYGRAPH_USERNAME = 'custom-neo4j';
      process.env.PUPPYGRAPH_PASSWORD = 'custom-password';
      process.env.PUPPYGRAPH_DATABASE = 'custom-db';
      
      process.env.PUPPYGRAPH_GREMLIN_URL = 'ws://custom-gremlin:8182/gremlin';
      process.env.PUPPYGRAPH_GREMLIN_USERNAME = 'custom-gremlin';
      process.env.PUPPYGRAPH_GREMLIN_PASSWORD = 'custom-gremlin-pass';
      process.env.PUPPYGRAPH_GREMLIN_TRAVERSAL_SOURCE = 'custom-g';
      
      process.env.PUPPYGRAPH_SCHEMA_URL = 'http://custom-schema:8081/schema';
      process.env.PUPPYGRAPH_SCHEMA_USERNAME = 'custom-schema';
      process.env.PUPPYGRAPH_SCHEMA_PASSWORD = 'custom-schema-pass';

      const config = loadConfig();

      expect(config.neo4j).toEqual({
        url: 'bolt://custom-neo4j:7687',
        username: 'custom-neo4j',
        password: 'custom-password',
        database: 'custom-db',
      });

      expect(config.gremlin).toEqual({
        url: 'ws://custom-gremlin:8182/gremlin',
        username: 'custom-gremlin',
        password: 'custom-gremlin-pass',
        traversalSource: 'custom-g',
      });

      expect(config.schema).toEqual({
        url: 'http://custom-schema:8081/schema',
        username: 'custom-schema',
        password: 'custom-schema-pass',
      });
    });

    it('should allow partial override of configuration', () => {
      // Set only some environment variables
      process.env.PUPPYGRAPH_URL = 'bolt://partial-override:7687';
      process.env.PUPPYGRAPH_GREMLIN_PASSWORD = 'partial-override-pass';

      const config = loadConfig();

      expect(config.neo4j.url).toBe('bolt://partial-override:7687');
      expect(config.neo4j.username).toBe('neo4j'); // Default
      
      expect(config.gremlin.url).toBe('ws://localhost:8182/gremlin'); // Default
      expect(config.gremlin.password).toBe('partial-override-pass');
    });
  });
});