import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchSchemaFromEndpoint, SchemaConfig } from '../../src/utils/schema';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;
global.btoa = vi.fn((str) => Buffer.from(str).toString('base64'));

describe('Schema Utilities', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('fetchSchemaFromEndpoint', () => {
    const mockConfig: SchemaConfig = {
      url: 'http://localhost:8081/schemajson',
      username: 'test-user',
      password: 'test-password',
    };

    it('should fetch schema successfully', async () => {
      const mockSchemaData = {
        nodes: [{ label: 'Person', count: 10 }],
        relationships: [{ type: 'KNOWS', count: 5 }],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockSchemaData,
      });

      const result = await fetchSchemaFromEndpoint(mockConfig);

      // Check that fetch was called with the right parameters
      expect(mockFetch).toHaveBeenCalledWith(
        mockConfig.url,
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': `Basic ${btoa(`${mockConfig.username}:${mockConfig.password}`)}`,
            'Accept': 'application/json',
          }),
        })
      );

      // Check the result structure
      expect(result).toEqual({
        summary: 'PuppyGraph Schema Information',
        source: 'Schema API',
        schema: mockSchemaData,
        schema_endpoint: mockConfig.url,
        timestamp: expect.any(String),
      });
    });

    it('should handle fetch errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(fetchSchemaFromEndpoint(mockConfig)).rejects.toThrow('HTTP error! Status: 404');
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(fetchSchemaFromEndpoint(mockConfig)).rejects.toThrow('Network error');
    });
  });
});