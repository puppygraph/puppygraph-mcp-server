export interface SchemaConfig {
  url: string;
  username: string;
  password: string;
}

export async function fetchSchemaFromEndpoint(config: SchemaConfig): Promise<any> {
  console.error(`Fetching schema from endpoint: ${config.url}`);
  
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
    console.error('Successfully fetched schema from endpoint');
    
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