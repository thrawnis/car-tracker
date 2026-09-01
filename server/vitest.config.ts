import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**"],
    globalSetup: ["./test/globalSetup.ts"],
    setupFiles: ["./test/setup.ts"],
    // Integration tests share one database and reset it between tests;
    // run everything in a single process/fork to avoid cross-test races.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
