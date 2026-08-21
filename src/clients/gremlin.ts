import * as gremlinApi from 'gremlin';
import { errorCategory, urlForLog } from '../utils/logging.js';

export interface GremlinConfig {
  url: string;
  username: string;
  password: string;
  traversalSource: string;
}

const gremlin = (gremlinApi as any).default || gremlinApi;

async function resultToArray(result: any): Promise<any[]> {
  if (Array.isArray(result)) {
    return result;
  }
  if (typeof result?.toArray === 'function') {
    return result.toArray();
  }
  if (typeof result?.all === 'function') {
    return await result.all();
  }
  if (result?.[Symbol.iterator]) {
    return Array.from(result);
  }
  throw new Error('Gremlin driver returned an unsupported result type');
}

export class GremlinClient {
  private client: any = null;
  private connected: boolean = false;
  private connectionError: string | null = null;

  constructor(private config: GremlinConfig) {}

  async connect(): Promise<boolean> {
    try {
      console.error('Initializing connection to Gremlin endpoint...');
      console.error(`URL: ${urlForLog(this.config.url)}, TraversalSource: ${this.config.traversalSource}`);
      
      const url = this.config.url;
      if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
        console.error('Warning: Gremlin URL should typically start with ws:// or wss:// for WebSocket connections');
        console.error('Current URL:', urlForLog(url));
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
      
      const Client = gremlin.driver?.Client;
      if (typeof Client !== 'function') {
        throw new Error('The Gremlin driver does not provide a remote script client');
      }

      const client = new Client(url, options);
      console.error('Testing connection with a simple query...');
      const testResult = await client.submit('g.V().limit(1).count()');
      const count = await resultToArray(testResult);
      console.error('Connection test successful, result:', count);

      this.client = client;
      this.connected = true;
      this.connectionError = null;
      console.error('Successfully initialized Gremlin remote client');
      return true;
      
    } catch (error: any) {
      const errorMsg = error.message || 'Unknown error';
      this.connectionError = errorMsg;
      console.error(`Failed to initialize Gremlin connection error_type=${errorCategory(error)}`);
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
    
    if (!query.trim().startsWith('g.')) {
      throw new Error('Query does not start with g. - cannot execute as traversal');
    }

    if (typeof this.client.submit !== 'function') {
      throw new Error('No valid Gremlin execution method available');
    }

    console.error('Executing query via remote client');
    const submission = await this.client.submit(query, parameters || {});
    return await resultToArray(submission);
  }

  async getSchemaData(): Promise<any> {
    if (!this.connected || !this.client) {
      throw new Error('Gremlin client not initialized');
    }
    
    if (typeof this.client.submit !== 'function') {
      throw new Error('No valid Gremlin execution method available for schema queries');
    }

    console.error('Getting schema data via remote client');
    const nodeCount = await this.client.submit('g.V().count()');
    const nodeCountValue = (await resultToArray(nodeCount))[0];

    const edgeCount = await this.client.submit('g.E().count()');
    const edgeCountValue = (await resultToArray(edgeCount))[0];

    const labelQuery = await this.client.submit('g.V().groupCount().by(label)');
    const labelResults = (await resultToArray(labelQuery))[0];

    const edgeQuery = await this.client.submit('g.E().groupCount().by(label)');
    const edgeResults = (await resultToArray(edgeQuery))[0];

    const nodeLabels = Object.entries(labelResults || {}).map(([label, count]: [string, any]) => ({
      label,
      count: Number(count)
    }));

    const edgeLabels = Object.entries(edgeResults || {}).map(([type, count]: [string, any]) => ({
      type,
      count: Number(count)
    }));

    return {
      summary: "Graph Structure Information",
      source: "Gremlin Database Queries",
      totalNodes: nodeCountValue,
      totalRelationships: edgeCountValue,
      nodeLabels: nodeLabels,
      relationshipTypes: edgeLabels,
      graphType: "PuppyGraph SQL-to-Graph Bridge"
    };
  }

  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
        console.error('Gremlin connection closed');
      } catch (error) {
        console.error(`Error closing Gremlin connection error_type=${errorCategory(error)}`);
      }
      this.client = null;
      this.connected = false;
    }
  }
}
