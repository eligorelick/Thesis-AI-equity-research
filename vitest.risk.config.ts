import { defineConfig } from "vitest/config";
import {
  PRODUCT_TEST_EXCLUDE,
  PRODUCT_TEST_INCLUDE,
  RISK_SOURCE_MANIFEST,
  SHARED_RESOLVE_ALIAS,
  SHARED_SETUP_FILES,
} from "./vitest.shared";

export default defineConfig({
  test: {
    include: PRODUCT_TEST_INCLUDE,
    exclude: PRODUCT_TEST_EXCLUDE,
    setupFiles: SHARED_SETUP_FILES,
    environment: "node",
    pool: "forks",
    isolate: true,
    maxWorkers: 1,
    coverage: {
      provider: "v8",
      include: RISK_SOURCE_MANIFEST,
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage/risk",
      thresholds: {
        statements: 85,
        branches: 75,
        functions: 85,
        lines: 85,
        perFile: true,
        autoUpdate: false,
      },
    },
  },
  resolve: {
    alias: SHARED_RESOLVE_ALIAS,
  },
});
