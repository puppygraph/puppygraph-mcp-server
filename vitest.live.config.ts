import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/live/**/*.live.test.ts"],
    environment: "node",
    globals: true,
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
