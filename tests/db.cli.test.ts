import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const REQUIRED_TABLES = [
  "api_cache",
  "cost_log",
  "jobs",
  "reports",
  "settings",
  "watchlist",
] as const;

describe("database CLI", () => {
  it("bootstraps the configured SQLite database through npm run db:push", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "thesis-db-cli-"));
    const dbPath = path.join(tempDir, "thesis.db");
    const configuredNpmCli = process.env.npm_execpath;
    const npmCli = configuredNpmCli?.endsWith(".js")
      ? configuredNpmCli
      : path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

    try {
      execFileSync(process.execPath, [npmCli, "run", "db:push"], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, THESIS_DB_PATH: dbPath },
        stdio: "pipe",
      });

      expect(existsSync(dbPath)).toBe(true);
      const sqlite = new Database(dbPath, { readonly: true });
      const tables = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name);
      sqlite.close();

      expect(tables).toEqual(REQUIRED_TABLES);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
