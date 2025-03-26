import { Driver, Session, auth, driver as createDriver, types, isInt } from 'neo4j-driver';

export interface Neo4jConfig {
  url: string;
  username: string;
  password: string;
  database: string;
}

export class Neo4jClient {
  private driver: Driver | null = null;
  private database: string = "";
  private connected: boolean = false;
  private connectionError: string | null = null;

  constructor(private config: Neo4jConfig) {
    this.database = config.database;
  }

  async connect(): Promise<boolean> {
    try {
      console.error('Initializing connection to Neo4j endpoint...');
      
      this.driver = createDriver(
        this.config.url,
        auth.basic(this.config.username, this.config.password),
        { disableLosslessIntegers: true }
      );
      
      await this.verifyConnection();
      this.connected = true;
      console.error('Successfully connected to Neo4j endpoint');
      return true;
    } catch (error: any) {
      this.connectionError = error.message;
      console.error('Failed to initialize Neo4j connection:', error.message);
      this.connected = false;
      return false;
    }
  }

  async verifyConnection(): Promise<void> {
    if (!this.driver) {
      throw new Error('Neo4j driver not initialized');
    }
    
    const session = this.getSession();
    try {
      console.error('Testing Neo4j connection with basic query...');
      await session.run('RETURN 1 as result');
      console.error('Neo4j connection verified');
    } catch (error: any) {
      console.error('Neo4j connection verification failed:', error.message);
      throw error;
    } finally {
      await session.close();
    }
  }

  getSession(): Session {
    if (!this.driver) {
      throw new Error('Neo4j driver not initialized');
    }
    
    if (this.database) {
      return this.driver.session({ database: this.database } as any);
    }
    return this.driver.session();
  }

  isConnected(): boolean {
    return this.connected;
  }

  getConnectionError(): string | null {
    return this.connectionError;
  }

  async executeQuery(cypher: string, parameters: Record<string, any> = {}): Promise<any[]> {
    if (!this.connected || !this.driver) {
      throw new Error('Not connected to Neo4j endpoint');
    }
    
    const session = this.getSession();
    try {
      const result = await session.run(cypher, parameters);
      return result.records.map(record => {
        const obj: Record<string, any> = {};
        
        // Convert symbol keys to strings if needed
        const keys = Array.isArray(record.keys) ? record.keys : [];
        
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          if (typeof key === 'string') {
            obj[key] = this.convertValue(record.get(key));
          }
        }
        
        return obj;
      });
    } finally {
      await session.close();
    }
  }

  convertValue(value: any): any {
    if (value === null || value === undefined) {
      return value;
    }
    
    if (isInt(value)) {
      return value.toNumber();
    }
    
    if (value instanceof types.Node) {
      return {
        id: this.convertValue(value.identity),
        labels: value.labels,
        properties: this.convertProperties(value.properties)
      };
    }
    
    if (value instanceof types.Relationship) {
      return {
        id: this.convertValue(value.identity),
        type: value.type,
        startNodeId: this.convertValue(value.start),
        endNodeId: this.convertValue(value.end),
        properties: this.convertProperties(value.properties)
      };
    }
    
    if (value instanceof types.Path) {
      return {
        segments: value.segments.map(segment => ({
          start: this.convertValue(segment.start),
          relationship: this.convertValue(segment.relationship),
          end: this.convertValue(segment.end)
        }))
      };
    }
    
    if (Array.isArray(value)) {
      return value.map(item => this.convertValue(item));
    }
    
    if (typeof value === 'object') {
      return this.convertProperties(value);
    }
    
    return value;
  }

  convertProperties(properties: Record<string, any>): Record<string, any> {
    const result: Record<string, any> = {};
    
    for (const key in properties) {
      result[key] = this.convertValue(properties[key]);
    }
    
    return result;
  }

  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
      this.connected = false;
      console.error('Neo4j connection closed');
    }
  }
}