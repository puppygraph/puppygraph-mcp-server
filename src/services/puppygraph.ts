import { Neo4jClient } from '../clients/neo4j.js';
import { GremlinClient } from '../clients/gremlin.js';
import { loadConfig } from '../utils/config.js';
import { fetchSchemaFromEndpoint } from '../utils/schema.js';
import { QueryResult } from '../utils/types.js';

/**
 * Core service that manages connections to graph databases and executes queries
 * 
 * This service:
 * - Manages connections to Neo4j (Cypher) and Gremlin endpoints
 * - Executes queries and returns standardized results
 * - Provides schema information about the graph
 * - Monitors connection status
 */
export class PuppyGraphService {
  /** Neo4j client for Cypher queries */
  private neo4jClient: Neo4jClient;
  /** Gremlin client for Gremlin queries */
  private gremlinClient: GremlinClient;
  /** Configuration loaded from environment variables */
  private config = loadConfig();
  /** Current connection error message, if any */
  private connectionError: string | null = null;

  constructor() {
    console.log(`PuppyGraph Neo4j service initialized with URL: ${this.config.neo4j.url}`);
    console.log(`PuppyGraph Gremlin service initialized with URL: ${this.config.gremlin.url}`);
    console.log(`Using database: ${this.config.neo4j.database || "default"}`);
    
    this.neo4jClient = new Neo4jClient(this.config.neo4j);
    this.gremlinClient = new GremlinClient(this.config.gremlin);
    
    this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      await this.neo4jClient.connect();
    } catch (error: any) {
      console.error('Neo4j connection initialization error:', error.message);
    }
    
    try {
      await this.gremlinClient.connect();
    } catch (error: any) {
      console.error('Gremlin connection initialization error:', error.message);
    }
    
    this.updateConnectionError();
    
    if (!this.neo4jClient.isConnected() && !this.gremlinClient.isConnected()) {
      console.error('All connection attempts failed');
    }
  }
  
  private updateConnectionError(): void {
    const neo4jError = this.neo4jClient.getConnectionError();
    const gremlinError = this.gremlinClient.getConnectionError();
    
    if (neo4jError && gremlinError) {
      this.connectionError = `Neo4j: ${neo4jError} | Gremlin: ${gremlinError}`;
    } else if (neo4jError) {
      this.connectionError = `Neo4j: ${neo4jError}`;
    } else if (gremlinError) {
      this.connectionError = `Gremlin: ${gremlinError}`;
    } else {
      this.connectionError = null;
    }
  }

  public async executeGremlin(params: { query: string; parameters?: Record<string, any> }): Promise<QueryResult<any>> {
    console.log(`Executing Gremlin query: ${params.query}`);
    console.log(`Parameters: ${JSON.stringify(params.parameters || {})}`);
    
    // Try to reconnect if needed
    if (!this.gremlinClient.isConnected()) {
      console.log('Not connected to Gremlin endpoint, attempting to reconnect...');
      const reconnected = await this.gremlinClient.connect();
      this.updateConnectionError();
      
      if (!reconnected) {
        console.error('Gremlin reconnection failed');
        throw new Error(`Cannot execute Gremlin query: Not connected to Gremlin endpoint. ${this.connectionError || ''}`);
      }
    }
    
    const startTime = Date.now();
    
    try {
      const result = await this.gremlinClient.executeQuery(params.query, params.parameters);
      const executionTime = Date.now() - startTime;
      
      console.log(`Gremlin query executed successfully, returned ${result.length} items`);
      
      return {
        data: result,
        metadata: {
          execution_time: executionTime,
          row_count: result.length
        }
      };
    } catch (error: any) {
      console.error('Error executing Gremlin query:', error);
      throw new Error(`Error executing Gremlin query: ${error.message}`);
    }
  }

  public async executeCypher(params: { query: string; parameters?: Record<string, any> }): Promise<QueryResult<any>> {
    console.log(`Executing Cypher query: ${params.query}`);
    console.log(`Parameters: ${JSON.stringify(params.parameters || {})}`);
    
    // Try to reconnect if needed
    if (!this.neo4jClient.isConnected()) {
      console.log('Not connected to Neo4j endpoint, attempting to reconnect...');
      const reconnected = await this.neo4jClient.connect();
      this.updateConnectionError();
      
      if (!reconnected) {
        console.error('Neo4j reconnection failed');
        throw new Error(`Cannot execute Cypher query: Not connected to Neo4j endpoint. ${this.connectionError || ''}`);
      }
    }
    
    const startTime = Date.now();
    
    try {
      const records = await this.neo4jClient.executeQuery(params.query, params.parameters);
      const executionTime = Date.now() - startTime;
      
      console.log(`Cypher query executed successfully, returned ${records.length} records`);
      
      return {
        data: records,
        metadata: {
          execution_time: executionTime,
          row_count: records.length
        }
      };
    } catch (error: any) {
      console.error('Error executing Cypher query:', error);
      throw new Error(`Error executing Cypher query: ${error.message}`);
    }
  }

  public async getDataSources(): Promise<any> {
    console.log("Fetching data sources information");
    
    // Try schema endpoint first
    try {
      return await fetchSchemaFromEndpoint(this.config.schema);
    } catch (schemaError: any) {
      console.log('Schema endpoint failed, falling back to database queries:', schemaError.message);
    }
    
    // Try Neo4j connection
    if (!this.neo4jClient.isConnected()) {
      console.log('Not connected to Neo4j endpoint, attempting to reconnect...');
      const reconnected = await this.neo4jClient.connect();
      this.updateConnectionError();
      
      if (!reconnected) {
        console.log('Neo4j reconnection failed, trying Gremlin endpoint');
        
        // Try Gremlin connection
        if (!this.gremlinClient.isConnected()) {
          const gremlinConnected = await this.gremlinClient.connect();
          this.updateConnectionError();
          
          if (!gremlinConnected) {
            console.error('Both Neo4j and Gremlin connections failed');
            throw new Error('Cannot fetch schema: Not connected to any endpoint. ' + this.connectionError);
          }
        }
        
        try {
          return await this.gremlinClient.getSchemaData();
        } catch (gremlinError: any) {
          console.error('Gremlin schema query failed:', gremlinError);
          throw new Error('Failed to fetch schema via Gremlin: ' + (gremlinError.message || 'Unknown error'));
        }
      }
    }
    
    // Use Neo4j if available
    try {
      const schemaData = await this.neo4jClient.executeQuery('MATCH (n) RETURN count(n) as count');
      // Further processing would happen here for a complete schema
      return { 
        summary: "Graph Structure Information via Neo4j",
        nodeCount: schemaData[0].count,
        timestamp: new Date().toISOString()
      };
    } catch (error: any) {
      console.error('Failed to get data sources via Neo4j');
      throw new Error('Failed to fetch database schema: ' + (error.message || 'Unknown error'));
    }
  }

  public getConnectionStatus(): { 
    connected: boolean; 
    neo4jConnected: boolean;
    gremlinConnected: boolean;
    connectionError: string | null; 
    fallbackMode: boolean; 
  } {
    const neo4jConnected = this.neo4jClient.isConnected();
    const gremlinConnected = this.gremlinClient.isConnected();
    
    return {
      connected: neo4jConnected || gremlinConnected,
      neo4jConnected,
      gremlinConnected,
      connectionError: this.connectionError,
      fallbackMode: false
    };
  }

  public async close(): Promise<void> {
    await Promise.all([
      this.neo4jClient.close(),
      this.gremlinClient.close()
    ]);
    console.log('PuppyGraph connections closed');
  }
}

// Create and export a singleton instance
export const puppyGraphService = new PuppyGraphService();

// Ensure connections are closed gracefully on application shutdown
process.on('SIGINT', async () => {
  await puppyGraphService.close();
});

process.on('SIGTERM', async () => {
  await puppyGraphService.close();
});