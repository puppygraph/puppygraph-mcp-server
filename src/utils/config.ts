import { Neo4jConfig } from '../clients/neo4j.js';
import { GremlinConfig } from '../clients/gremlin.js';
import { SchemaConfig } from './schema.js';
import { RestConfig } from '../clients/rest.js';

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
      username: process.env.PUPPYGRAPH_USERNAME || "puppygraph",
      password: process.env.PUPPYGRAPH_PASSWORD || "puppygraph123",
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

/**
 * Loads the HTTP API configuration used by the catalog and schema tools.
 *
 * - PUPPYGRAPH_HTTP_URL: base URL of the PuppyGraph HTTP API. Defaults to the
 *   origin of PUPPYGRAPH_SCHEMA_URL, then http://localhost:8081.
 * - Credentials are the schema API ones (PUPPYGRAPH_SCHEMA_USERNAME/PASSWORD).
 */
export function loadRestConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RestConfig {
  let url = environment.PUPPYGRAPH_HTTP_URL || "";
  if (!url && environment.PUPPYGRAPH_SCHEMA_URL) {
    try {
      url = new URL(environment.PUPPYGRAPH_SCHEMA_URL).origin;
    } catch {
      // Keep the invalid value so requests fail with a configuration error,
      // rather than silently going to a PuppyGraph on localhost.
      url = environment.PUPPYGRAPH_SCHEMA_URL;
    }
  }
  return {
    url: url || "http://localhost:8081",
    username: environment.PUPPYGRAPH_SCHEMA_USERNAME || "puppygraph",
    password: environment.PUPPYGRAPH_SCHEMA_PASSWORD || "puppygraph123",
  };
}