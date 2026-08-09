import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "FMP_API_KEY",
  "FINNHUB_API_KEY",
  "FRED_API_KEY",
  "EDGAR_CONTACT",
] as const;
const REQUIRED_TABLES = [
  "api_cache",
  "cost_log",
  "job_llm_leases",
  "job_pass_artifacts",
  "jobs",
  "reports",
  "settings",
  "watchlist",
] as const;

function resolveNpmExecPath(configured: string | undefined): string {
  if (!configured) {
    throw new Error(
      "database CLI integration requires npm_execpath; run it through npm run test:integration",
    );
  }
  if (!path.isAbsolute(configured)) {
    throw new Error("database CLI integration requires an absolute npm_execpath");
  }
  if (!/^(?:npm|npm-cli)\.(?:js|cjs|mjs)$/i.test(path.basename(configured))) {
    throw new Error(
      "database CLI integration requires npm_execpath to name the npm CLI file",
    );
  }
  let isFile = false;
  try {
    isFile = statSync(configured).isFile();
  } catch {
    // The diagnostic below intentionally covers both missing and inaccessible paths.
  }
  if (!isFile) {
    throw new Error("database CLI integration requires npm_execpath to name an existing file");
  }
  return configured;
}

function providerFreeEnvironment(
  dbPath: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, THESIS_DB_PATH: dbPath };
  const providerKeys = new Set(PROVIDER_ENV_KEYS);
  for (const key of Object.keys(env)) {
    if (providerKeys.has(key.toUpperCase() as (typeof PROVIDER_ENV_KEYS)[number])) {
      delete env[key];
    }
  }
  return env;
}

function npmScriptInvocation(
  npmCli: string,
  script: string,
  dbPath: string,
  sourceEnv: NodeJS.ProcessEnv = process.env,
) {
  return {
    executable: process.execPath,
    args: [npmCli, "run", script] as const,
    options: {
      cwd: ROOT,
      encoding: "utf8" as const,
      env: providerFreeEnvironment(dbPath, sourceEnv),
      stdio: "pipe" as const,
      timeout: 12_000,
      shell: false as const,
    },
  };
}

function runNpmScript(npmCli: string, script: string, dbPath: string): string {
  const invocation = npmScriptInvocation(npmCli, script, dbPath);
  return execFileSync(
    invocation.executable,
    [...invocation.args],
    invocation.options,
  );
}

describe("database CLI", () => {
  it("rejects missing, relative, and non-file npm_execpath values", () => {
    expect(() => resolveNpmExecPath(undefined)).toThrow(/npm_execpath.*npm run/i);
    expect(() => resolveNpmExecPath("node_modules/npm/bin/npm-cli.js")).toThrow(
      /absolute npm_execpath/i,
    );
    expect(() =>
      resolveNpmExecPath(path.join(ROOT, "missing", "npm-cli.js")),
    ).toThrow(/npm_execpath.*existing file/i);
    expect(() => resolveNpmExecPath(ROOT)).toThrow(
      /npm_execpath.*npm CLI file/i,
    );

    const tempDir = mkdtempSync(path.join(os.tmpdir(), "thesis-db-cli-resolver-"));
    try {
      const arbitrary = path.join(tempDir, "arbitrary.js");
      writeFileSync(arbitrary, "process.exit(0);\n", "utf8");
      expect(() => resolveNpmExecPath(arbitrary)).toThrow(
        /npm_execpath.*npm CLI file/i,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("strips every provider credential without depending on environment-key casing", () => {
    const npmCli = path.join(ROOT, "node_modules", "npm", "bin", "npm-cli.js");
    const invocation = npmScriptInvocation(npmCli, "db:push", "safe.db", {
      NODE_ENV: "test",
      ANTHROPIC_API_KEY: "secret-one",
      fmp_api_key: "secret-two",
      Finnhub_Api_Key: "secret-three",
      FRED_API_KEY: "secret-four",
      edgar_contact: "secret-five",
      SAFE_SETTING: "retained",
    });
    expect(invocation).toEqual({
      executable: process.execPath,
      args: [npmCli, "run", "db:push"],
      options: {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          NODE_ENV: "test",
          THESIS_DB_PATH: "safe.db",
          SAFE_SETTING: "retained",
        },
        stdio: "pipe",
        timeout: 12_000,
        shell: false,
      },
    });
  });

  it("bootstraps a Unicode/spaced SQLite path without provider credentials and cleans up", () => {
    const npmCli = resolveNpmExecPath(process.env.npm_execpath);
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "thesis-db-cli-"));
    const dbDirectory = path.join(tempDir, "nested database 目录");
    const dbPath = path.join(dbDirectory, "thesis 数据.db");
    mkdirSync(dbDirectory, { recursive: true });

    try {
      const env = providerFreeEnvironment(dbPath);
      for (const key of PROVIDER_ENV_KEYS) expect(env).not.toHaveProperty(key);

      runNpmScript(npmCli, "db:push", dbPath);
      expect(existsSync(dbPath)).toBe(true);

      const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const tables = sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all()
          .map((row) => (row as { name: string }).name);
        expect(tables).toEqual(REQUIRED_TABLES);
      } finally {
        sqlite.close();
      }
      expect(sqlite.open).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    expect(existsSync(tempDir)).toBe(false);
  }, 15_000);

  it("cleans an already-created Unicode/spaced workspace after child failure", () => {
    const npmCli = resolveNpmExecPath(process.env.npm_execpath);
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "thesis-db-cli-failure-"));
    const nested = path.join(tempDir, "failure workspace 数据");
    mkdirSync(nested, { recursive: true });
    const dbPath = path.join(nested, "failure database 数据.db");
    const sentinel = path.join(nested, "created before child 数据.txt");
    writeFileSync(sentinel, "must be removed after the child rejects\n", "utf8");

    try {
      expect(existsSync(sentinel)).toBe(true);
      expect(() =>
        runNpmScript(npmCli, "intentionally-missing-db-script", dbPath),
      ).toThrow();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    expect(existsSync(tempDir)).toBe(false);
  }, 15_000);
});
