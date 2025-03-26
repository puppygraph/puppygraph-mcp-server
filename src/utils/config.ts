import { Neo4jConfig } from '../clients/neo4j.js';
import { GremlinConfig } from '../clients/gremlin.js';
import { SchemaConfig } from './schema.js';

export interface PuppyGraphConfig {
  neo4j: Neo4jConfig;
  gremlin: GremlinConfig;
  schema: SchemaConfig;
}

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