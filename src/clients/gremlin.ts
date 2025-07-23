import * as gremlinApi from 'gremlin';

export interface GremlinConfig {
  url: string;
  username: string;
  password: string;
  traversalSource: string;
}

const gremlin = (gremlinApi as any).default || gremlinApi;

export class GremlinClient {
  private client: any = null;
  private connected: boolean = false;
  private connectionError: string | null = null;

  constructor(private config: GremlinConfig) {}

  async connect(): Promise<boolean> {
    try {
      console.error('Initializing connection to Gremlin endpoint...');
      console.error(`URL: ${this.config.url}, TraversalSource: ${this.config.traversalSource}`);
      
      const url = this.config.url;
      if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
        console.error('Warning: Gremlin URL should typically start with ws:// or wss:// for WebSocket connections');
        console.error('Current URL:', url);
      }
      
      const options: any = {
        traversalSource: this.config.traversalSource
      };
      
      if (this.config.username && this.config.password) {
        if (gremlin.driver?.auth?.PlainTextSaslAuthenticator) {
          options.authenticator = new gremlin.driver.auth.PlainTextSaslAuthenticator(
            this.config.username,
            this.config.password
          );
          console.error('Using driver.auth.PlainTextSaslAuthenticator for authentication');
        } else {
          options.username = this.config.username;
          options.password = this.config.password;
          console.error('Using basic username/password for authentication');
        }
      } else {
        console.error('No Gremlin credentials provided, attempting connection without authentication');
      }
      
      // Standard approach with structure.Graph
      if (gremlin.structure?.Graph) {
        console.error('Using structure.Graph approach');
        
        const graph = new gremlin.structure.Graph();
        const connection = new gremlin.driver.DriverRemoteConnection(url, options);
        const g = graph.traversal().withRemote(connection);
        
        console.error('Testing connection with a simple query...');
        const result = await g.V().limit(1).count().next();
        console.error('Connection test successful, result:', result.value);
        
        this.client = {
          connection, graph, g,
          close: async () => {
            try { await connection.close(); } 
            catch (e) { console.error('Error closing Gremlin connection:', e); }
          }
        };
        
        this.connected = true;
        console.error('Successfully initialized Gremlin connection using structure.Graph approach');
        return true;
      }
      
      // Fallback: Try direct client approach if available
      if (typeof gremlin.Client === 'function') {
        try {
          console.error('Falling back to direct Client approach');
          const client = new gremlin.Client(url, options);
          
          const testResult = await client.submit('g.V().limit(1).count()');
          const count = await testResult.all();
          console.error('Connection test successful with direct client, result:', count);
          
          this.client = {
            _client: client,
            close: async () => { await client.close(); }
          };
          
          this.connected = true;
          console.error('Successfully initialized Gremlin client using fallback approach');
          return true;
        } catch (clientErr) {
          console.error('Error with direct client approach:', clientErr);
        }
      }
      
      throw new Error(`Could not establish connection to Gremlin server at ${url}. Please verify the server is running and the URL is correct.`);
      
    } catch (error: any) {
      const errorMsg = error.message || 'Unknown error';
      this.connectionError = errorMsg;
      console.error('Failed to initialize Gremlin connection:', errorMsg);
      this.connected = false;
      return false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getConnectionError(): string | null {
    return this.connectionError;
  }

  async executeQuery(query: string, parameters: Record<string, any> = {}): Promise<any[]> {
    if (!this.connected || !this.client) {
      throw new Error('Not connected to Gremlin endpoint');
    }
    
    let result: any;
    
    // Standard approach with Graph and traversal
    if (this.client.g) {
      console.error('Executing query via graph.traversal');
      const g = this.client.g;
      
      if (query.trim().startsWith('g.')) {
        // Security check
        if (query.includes('System.') || query.includes('java.') || 
            query.includes('eval(') || query.includes('constructor')) {
          throw new Error('Potentially unsafe Gremlin query rejected');
        }
        
        const evalTraversal = new Function('g', `return ${query}`);
        result = await evalTraversal(g).toList();
      } else {
        throw new Error('Query does not start with g. - cannot execute as traversal');
      }
    }
    // Direct client approach
    else if (this.client._client && typeof this.client._client.submit === 'function') {
      console.error('Executing query via client.submit');
      const client = this.client._client;
      const submission = await client.submit(query, parameters || {});
      result = await submission.all();
    }
    // Process traversal approach
    else if (gremlin.process?.traversal) {
      console.error('Executing query via process.traversal');
      const traversalFn = gremlin.process.traversal;
      const g = traversalFn().withRemote(this.client);
      
      if (query.trim().startsWith('g.')) {
        // Security check
        if (query.includes('System.') || query.includes('java.') || 
            query.includes('eval(') || query.includes('constructor')) {
          throw new Error('Potentially unsafe Gremlin query rejected');
        }
        
        const evalTraversal = new Function('g', `return ${query}`);
        result = await evalTraversal(g).toList();
      } else {
        throw new Error('Query does not start with g. - cannot execute as traversal');
      }
    } else {
      throw new Error('No valid Gremlin execution method available');
    }
    
    return result;
  }

  async getSchemaData(): Promise<any> {
    if (!this.connected || !this.client) {
      throw new Error('Gremlin client not initialized');
    }
    
    let result: any;
    
    // Standard approach with graph traversal
    if (this.client.g) {
      console.error('Getting schema data via graph.traversal');
      const g = this.client.g;
      
      const nodeCount = await g.V().count().next();
      const edgeCount = await g.E().count().next();
      const labelResults = await g.V().label().groupCount().next();
      const edgeResults = await g.E().label().groupCount().next();
      
      const nodeLabels = Object.entries(labelResults.value || {}).map(([label, count]: [string, any]) => ({
        label,
        count: Number(count)
      }));
      
      const edgeLabels = Object.entries(edgeResults.value || {}).map(([type, count]: [string, any]) => ({
        type,
        count: Number(count)
      }));
      
      result = {
        summary: "Graph Structure Information",
        source: "Gremlin Database Queries",
        totalNodes: nodeCount.value,
        totalRelationships: edgeCount.value,
        nodeLabels: nodeLabels,
        relationshipTypes: edgeLabels,
        graphType: "PuppyGraph SQL-to-Graph Bridge"
      };
    }
    // Direct client approach
    else if (this.client._client && typeof this.client._client.submit === 'function') {
      console.error('Getting schema data via client.submit');
      const client = this.client._client;
      
      const nodeCount = await client.submit('g.V().count()');
      const nodeCountValue = (await nodeCount.all())[0];
      
      const edgeCount = await client.submit('g.E().count()');
      const edgeCountValue = (await edgeCount.all())[0];
      
      const labelQuery = await client.submit('g.V().groupCount().by(label)');
      const labelResults = (await labelQuery.all())[0];
      
      const edgeQuery = await client.submit('g.E().groupCount().by(label)');
      const edgeResults = (await edgeQuery.all())[0];
      
      const nodeLabels = Object.entries(labelResults || {}).map(([label, count]: [string, any]) => ({
        label,
        count: Number(count)
      }));
      
      const edgeLabels = Object.entries(edgeResults || {}).map(([type, count]: [string, any]) => ({
        type,
        count: Number(count)
      }));
      
      result = {
        summary: "Graph Structure Information",
        source: "Gremlin Database Queries",
        totalNodes: nodeCountValue,
        totalRelationships: edgeCountValue,
        nodeLabels: nodeLabels,
        relationshipTypes: edgeLabels,
        graphType: "PuppyGraph SQL-to-Graph Bridge"
      };
    } 
    // Process traversal approach
    else if (gremlin.process?.traversal) {
      console.error('Getting schema data via process.traversal');
      const traversalFn = gremlin.process.traversal;
      const g = traversalFn().withRemote(this.client);
      
      const nodeCount = await g.V().count().next();
      const edgeCount = await g.E().count().next();
      const labelResults = await g.V().label().groupCount().next();
      const edgeResults = await g.E().label().groupCount().next();
      
      const nodeLabels = Object.entries(labelResults.value || {}).map(([label, count]: [string, any]) => ({
        label,
        count: Number(count)
      }));
      
      const edgeLabels = Object.entries(edgeResults.value || {}).map(([type, count]: [string, any]) => ({
        type,
        count: Number(count)
      }));
      
      result = {
        summary: "Graph Structure Information",
        source: "Gremlin Database Queries",
        totalNodes: nodeCount.value,
        totalRelationships: edgeCount.value,
        nodeLabels: nodeLabels,
        relationshipTypes: edgeLabels,
        graphType: "PuppyGraph SQL-to-Graph Bridge"
      };
    } else {
      throw new Error('No valid Gremlin execution method available for schema queries');
    }
    
    return result;
  }

  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
        console.error('Gremlin connection closed');
      } catch (error) {
        console.error('Error closing Gremlin connection:', error);
      }
      this.client = null;
      this.connected = false;
    }
  }
}