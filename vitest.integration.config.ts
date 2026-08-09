import { defineConfig } from "vitest/config";
import {
  INTEGRATION_TEST_INCLUDE,
  SHARED_RESOLVE_ALIAS,
} from "./vitest.shared";

export default defineConfig({
  test: {
    include: INTEGRATION_TEST_INCLUDE,
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
