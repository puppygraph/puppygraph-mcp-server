import { Neo4jConfig } from '../clients/neo4j.js';
import { GremlinConfig } from '../clients/gremlin.js';
import { SchemaConfig } from './schema.js';

/**
 * Complete configuration for the PuppyGraph MCP server
 */
export interface PuppyGraphConfig {
  /** Neo4j database connection configuration */
  neo4j: Neo4jConfig;
  /** Gremlin server connection configuration */
  gremlin: GremlinConfig;
  /** Schema API endpoint configuration */
  schema: SchemaConfig;
}

/**
 * Loads configuration from environment variables with fallbacks to defaults
 * 
 * Environment variables:
 * - PUPPYGRAPH_URL: Neo4j Bolt URL
 * - PUPPYGRAPH_USERNAME: Neo4j username
 * - PUPPYGRAPH_PASSWORD: Neo4j password
 * - PUPPYGRAPH_DATABASE: Neo4j database name
 * - PUPPYGRAPH_GREMLIN_URL: Gremlin WebSocket URL
 * - PUPPYGRAPH_GREMLIN_USERNAME: Gremlin username
 * - PUPPYGRAPH_GREMLIN_PASSWORD: Gremlin password
 * - PUPPYGRAPH_GREMLIN_TRAVERSAL_SOURCE: Gremlin traversal source
 * - PUPPYGRAPH_SCHEMA_URL: Schema API URL
 * - PUPPYGRAPH_SCHEMA_USERNAME: Schema API username
 * - PUPPYGRAPH_SCHEMA_PASSWORD: Schema API password
 *
 * @returns Complete PuppyGraph configuration
 */
export function loadConfig(): PuppyGraphConfig {
  return {
    neo4j: {
      url: process.env.PUPPYGRAPH_URL || "bolt://localhost:7687",
      username: process.env.PUPPYGRAPH_USERNAME || "neo4j",
      password: process.env.PUPPYGRAPH_PASSWORD || "password",
      database: process.env.PUPPYGRAPH_DATABASE || ""
    },
    gremlin: {
      url: process.env.PUPPYGRAPH_GREMLIN_URL || "ws://localhost:8182/gremlin",
      username: process.env.PUPPYGRAPH_GREMLIN_USERNAME || "puppygraph",
      password: process.env.PUPPYGRAPH_GREMLIN_PASSWORD || "puppygraph123",
      traversalSource: process.env.PUPPYGRAPH_GREMLIN_TRAVERSAL_SOURCE || "g"
    },
    schema: {
      url: process.env.PUPPYGRAPH_SCHEMA_URL || "http://localhost:8081/schemajson",
      username: process.env.PUPPYGRAPH_SCHEMA_USERNAME || "puppygraph",
      password: process.env.PUPPYGRAPH_SCHEMA_PASSWORD || "puppygraph123"
    }
  };
}