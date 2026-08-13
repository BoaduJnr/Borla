import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    testTimeout: 15000,
    hookTimeout: 30000,
    setupFiles: ["./test/setup.ts"],
    fileParallelism: false, // integration tests share one Postgres — avoid cross-test races
  },
});
