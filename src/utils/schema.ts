/**
 * Configuration for connecting to a schema API endpoint
 */
export interface SchemaConfig {
  /** URL of the schema API endpoint */
  url: string;
  /** Username for authentication */
  username: string;
  /** Password for authentication */
  password: string;
}

/**
 * Schema information returned from the API
 */
export interface SchemaResult {
  /** Description of the schema */
  summary: string;
  /** Source of the schema information */
  source: string;
  /** The actual schema data */
  schema: any;
  /** Endpoint URL the schema was fetched from */
  schema_endpoint: string;
  /** Timestamp when the schema was fetched */
  timestamp: string;
}

/**
 * Fetches schema information from a remote endpoint
 * 
 * @param config Configuration for the schema endpoint
 * @returns Schema information
 */
export async function fetchSchemaFromEndpoint(config: SchemaConfig): Promise<SchemaResult> {
  console.log(`Fetching schema from endpoint: ${config.url}`);
  
  try {
    const credentials = btoa(`${config.username}:${config.password}`);
    
    const response = await fetch(config.url, {
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }
    
    const schemaData = await response.json();
    console.log('Successfully fetched schema from endpoint');
    
    return {
      summary: "PuppyGraph Schema Information",
      source: "Schema API",
      schema: schemaData,
      schema_endpoint: config.url,
      timestamp: new Date().toISOString()
    };
  } catch (error: any) {
    console.error('Error fetching schema from endpoint:', error.message);
    throw error;
  }
}