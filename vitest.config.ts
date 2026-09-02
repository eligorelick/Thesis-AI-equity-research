import { defineConfig } from "vitest/config";
import {
  PRODUCT_TEST_EXCLUDE,
  PRODUCT_TEST_INCLUDE,
  SHARED_RESOLVE_ALIAS,
  SHARED_SETUP_FILES,
} from "./vitest.shared";

export default defineConfig({
  test: {
    include: PRODUCT_TEST_INCLUDE,
    exclude: PRODUCT_TEST_EXCLUDE,
    setupFiles: SHARED_SETUP_FILES,
    environment: "node",
    // Keep forks: threads are unsafe with the native better-sqlite3 addon.
    pool: "forks",
    isolate: true,
    // Several scheduler tests intentionally launch their own TypeScript worker
    // threads. Reserving half the CPUs prevents Vitest forks from starving
    // those nested workers while preserving parallel product-test execution.
    maxWorkers: "50%",
    coverage: {
      provider: "v8",
      include: ["src/pipeline/stageB/**/*.ts", "src/report/schema.ts"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage/core",
      thresholds: {
        statements: 90,
        branches: 84,
        functions: 95,
        lines: 93,
      },
    },
  },
  resolve: {
    alias: SHARED_RESOLVE_ALIAS,
  },
});
