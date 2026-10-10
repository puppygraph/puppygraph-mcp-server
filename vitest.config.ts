import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/schema-endpoint.test.ts',
      'tests/integration/mcp-server.test.ts',
      'tests/integration/unreachable.test.ts',
      'tests/integration/setup-tools.test.ts',
    ],
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/build/**', 'src/types/**/*.ts'],
    },
  },
});
