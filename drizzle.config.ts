import { defineConfig } from "drizzle-kit";
import { defaultDbPath } from "./src/db/paths";
import { loadMaintenanceEnv } from "./scripts/lib/load-env.mjs";

loadMaintenanceEnv();

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: { url: defaultDbPath() },
});
