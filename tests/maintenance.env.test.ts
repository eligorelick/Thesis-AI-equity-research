import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const require = createRequire(pathToFileURL(path.join(ROOT, "package.json")));
const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };

// Run real maintenance entrypoints with synthetic env files and a fetch guard.
// No child inherits provider keys or points at the user's application-data DB.
function run(script: string, directory: string, extra: string[] = [], env: Partial<NodeJS.ProcessEnv> = {}) {
  const guard = path.join(directory, "offline.mjs");
  writeFileSync(guard, `globalThis.fetch = async (_, init) => {
    if (init?.headers?.["x-api-key"] === "fixture-model-key") throw new Error("offline-model-key-loaded");
    throw new Error("live network forbidden");
  };`);
  const [, ...args] = manifest.scripts[script].split(/\s+/);
  const absoluteArgs = args.map((arg) => arg === "tsx"
    ? pathToFileURL(require.resolve("tsx")).href
    : arg.startsWith("scripts/") ? path.join(ROOT, arg) : arg);
  return spawnSync(process.execPath, ["--import", pathToFileURL(guard).href, ...absoluteArgs, ...extra], {
    cwd: directory,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      NODE_ENV: "development",
      TSX_TSCONFIG_PATH: path.join(ROOT, "tsconfig.json"),
      HOME: directory,
      USERPROFILE: directory,
      LOCALAPPDATA: directory,
      APPDATA: directory,
      XDG_DATA_HOME: directory,
      ...env,
    },
  });
}

function seed(dbPath: string) {
  const db = new Database(dbPath);
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); INSERT INTO settings VALUES ('analysisModel', 'claude-opus-5');");
  db.close();
}

function count(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try { return (db.prepare("SELECT COUNT(*) AS n FROM settings").get() as { n: number }).n; }
  finally { db.close(); }
}

describe("maintenance CLI environment", () => {
  it("resets the env-selected DB with Next file precedence and preserves shell overrides", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "thesis-cli-env-"));
    const base = path.join(directory, "base.db");
    const local = path.join(directory, "local.db");
    const shell = path.join(directory, "shell.db");
    try {
      [base, local, shell].forEach(seed);
      writeFileSync(path.join(directory, ".env"), `THESIS_DB_PATH=${base.replaceAll("\\", "/")}\n`);
      writeFileSync(path.join(directory, ".env.development.local"), `THESIS_DB_PATH=${local.replaceAll("\\", "/")}\n`);
      const fromFiles = run("settings:reset", directory, ["--yes"]);
      expect(fromFiles.status, fromFiles.stderr).toBe(0);
      expect(count(local)).toBe(0);
      expect(count(base)).toBe(1);
      expect(count(shell)).toBe(1);
      const fromShell = run("settings:reset", directory, ["--yes"], { THESIS_DB_PATH: shell });
      expect(fromShell.status, fromShell.stderr).toBe(0);
      expect(count(shell)).toBe(0);
      expect(count(base)).toBe(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("loads the model-list key from .env before the guarded provider read", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "thesis-model-env-"));
    try {
      writeFileSync(path.join(directory, ".env"), "ANTHROPIC_API_KEY=fixture-model-key\n");
      const child = run("models:refresh", directory);
      expect(child.status).toBe(1);
      expect(child.stderr).toContain("offline-model-key-loaded");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("reconciles only the configured temporary DB without any paid-account read", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "thesis-cost-env-"));
    const configured = path.join(directory, "configured.db");
    try {
      writeFileSync(path.join(directory, ".env"), `THESIS_DB_PATH=${configured.replaceAll("\\", "/")}\n`);
      const child = run("costs:reconcile", directory);
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout).toContain("no unreconciled presumed spend");
      expect(existsSync(configured)).toBe(true);
      expect(existsSync(path.join(directory, "Thesis", "thesis.db"))).toBe(false);
      expect(existsSync(path.join(directory, "thesis", "thesis.db"))).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
