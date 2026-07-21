import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SENSITIVE_MODULES = [
  "src/config/env.ts",
  "src/db/index.ts",
  "src/db/paths.ts",
  "src/db/schema.ts",
  "src/cache/apiCache.ts",
  "src/cache/compression.ts",
  "src/cache/maintenance.ts",
  "src/settings/settings.ts",
  "src/providers/anthropic.ts",
  "src/providers/edgar.ts",
  "src/providers/finnhub.ts",
  "src/providers/finra.ts",
  "src/providers/fmp.ts",
  "src/providers/fred.ts",
  "src/providers/http.ts",
] as const;

describe("client/server import boundary", () => {
  it.each(SENSITIVE_MODULES)("marks %s as server-only", async (relativePath) => {
    const source = await readFile(path.join(process.cwd(), relativePath), "utf8");
    expect(source).toMatch(/^import ["']server-only["'];/m);
  });
});
