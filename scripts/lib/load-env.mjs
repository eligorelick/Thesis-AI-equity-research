import { createRequire } from "node:module";

// @next/env is CommonJS; require works in both native ESM and tsx's CJS lane.
const { loadEnvConfig } = createRequire(import.meta.url)("@next/env");

/** Load the same env files and shell precedence as Next, before CLI config/DB use. */
export function loadMaintenanceEnv(directory = process.cwd()) {
  return loadEnvConfig(directory, process.env.NODE_ENV !== "production");
}
