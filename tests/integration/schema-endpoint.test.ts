import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { fetchSchemaFromEndpoint } from '../../src/utils/schema';

// Create mock server
const mockSchemaData = {
  nodes: [
    { label: 'Person', count: 150, properties: ['name', 'age'] },
    { label: 'Movie', count: 100, properties: ['title', 'year'] },
  ],
  relationships: [
    { type: 'ACTED_IN', count: 250, properties: ['role', 'year'] },
    { type: 'DIRECTED', count: 50, properties: ['year'] },
  ]
};

const server = setupServer(
  // Define HTTP request handlers
  http.get('http://test-server/schema', ({ request }) => {
    const authHeader = request.headers.get('Authorization');
    
    // Check authentication
    if (!authHeader || authHeader !== 'Basic dGVzdC11c2VyOnRlc3QtcGFzc3dvcmQ=') {
      return new HttpResponse(null, { status: 401 });
    }
    
    return HttpResponse.json(mockSchemaData);
  }),
  
  // 404 for any other route
  http.all('*', () => {
    return new HttpResponse(null, { status: 404 });
  })
);

describe('Schema Endpoint Integration', () => {
  beforeAll(() => {
    // Start the mock server
    server.listen();
  });
  
  afterAll(() => {
    // Clean up after tests
    server.close();
  });
  
  beforeEach(() => {
    // Reset handlers between tests
    server.resetHandlers();
  });
  
  it('should fetch schema from endpoint with correct authentication', async () => {
    const result = await fetchSchemaFromEndpoint({
      url: 'http://test-server/schema',
      username: 'test-user',
      password: 'test-password',
    });
    
    expect(result).toEqual({
      summary: "PuppyGraph Schema Information",
      source: "Schema API",
      schema: mockSchemaData,
      schema_endpoint: 'http://test-server/schema',
      timestamp: expect.any(String),
    });
  });
  
  it('should handle authentication failures', async () => {
    await expect(fetchSchemaFromEndpoint({
      url: 'http://test-server/schema',
      username: 'wrong-user',
      password: 'wrong-password',
    })).rejects.toThrow('HTTP error! Status: 401');
  });
  
  it('should handle 404 errors', async () => {
    await expect(fetchSchemaFromEndpoint({
      url: 'http://test-server/not-found',
      username: 'test-user',
      password: 'test-password',
    })).rejects.toThrow('HTTP error! Status: 404');
  });
  
  it('should handle unexpected server errors', async () => {
    // Override handler for this test to simulate server error
    server.use(
      http.get('http://test-server/schema', () => {
        return new HttpResponse(null, { status: 500 });
      })
    );
    
    await expect(fetchSchemaFromEndpoint({
      url: 'http://test-server/schema',
      username: 'test-user',
      password: 'test-password',
    })).rejects.toThrow('HTTP error! Status: 500');
  });
});