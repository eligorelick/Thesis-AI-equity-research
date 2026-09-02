import { defineConfig } from "vitest/config";
import {
  INTEGRATION_TEST_INCLUDE,
  SHARED_RESOLVE_ALIAS,
  SHARED_SETUP_FILES,
} from "./vitest.shared";

export default defineConfig({
  test: {
    include: INTEGRATION_TEST_INCLUDE,
    setupFiles: SHARED_SETUP_FILES,
    environment: "node",
    pool: "forks",
    isolate: true,
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 15_000,
    retry: 0,
  },
  resolve: {
    alias: SHARED_RESOLVE_ALIAS,
  },
});
