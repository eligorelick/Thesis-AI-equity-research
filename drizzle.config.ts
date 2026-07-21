import { defineConfig } from "drizzle-kit";
import { defaultDbPath } from "./src/db/paths";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: { url: defaultDbPath() },
});
