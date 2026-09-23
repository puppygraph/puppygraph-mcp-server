import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('CLI entry point', () => {
  it('starts with a node shebang so the puppygraph-mcp bin is executable', () => {
    // package.json maps the `puppygraph-mcp` bin to build/index.js; tsc keeps
    // the shebang from src/index.ts. Without it, MCP clients that spawn the bin
    // directly fail with "Exec format error".
    const entry = readFileSync(fileURLToPath(new URL('../../src/index.ts', import.meta.url)), 'utf8');
    expect(entry.startsWith('#!/usr/bin/env node\n')).toBe(true);
  });
});
