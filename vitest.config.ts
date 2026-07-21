import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Reuse the module registry across files per worker for a faster suite.
    // Keep `forks` — `threads` segfaults on the native better-sqlite3 addon.
    pool: "forks",
    isolate: false,
    coverage: {
      provider: "v8",
      include: ["src/pipeline/stageB/**/*.ts", "src/report/schema.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 90,
        branches: 84,
        functions: 95,
        lines: 93,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "server-only": path.resolve(__dirname, "tests/server-only.mock.ts"),
    },
  },
});
