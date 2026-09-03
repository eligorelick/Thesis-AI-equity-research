/**
 * `npm run settings:reset` (WS8, R-41/D-21).
 *
 * Settings resolve database → environment → default, so a row saved from the
 * Settings page outranks `.env` until someone deletes it. These tests pin the
 * refusal without `--yes`, the exact preview text, the delete, and the two
 * bookkeeping rows the reset must not touch. One test spawns the argv that
 * package.json declares for `settings:reset` so the `@/` alias and the
 * `react-server` condition stay wired; everything else calls the module
 * directly.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WRITABLE_SETTINGS_REVISION_KEY } from "@/settings/settings";

import {
  PRESERVED_SETTING_KEYS,
  parseSettingsResetArguments,
  runSettingsReset,
  runSettingsResetCli,
} from "../scripts/settings-reset";

const ROOT = path.resolve(__dirname, "..");

let directory: string;
let dbFile: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "thesis-settings-reset-"));
  dbFile = path.join(directory, "thesis.db");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function seedSettings(rows: Array<[string, string]>): void {
  const sqlite = new Database(dbFile);
  try {
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS "settings" ("key" TEXT PRIMARY KEY NOT NULL, "value" TEXT NOT NULL)`,
    );
    const insert = sqlite.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`);
    for (const [key, value] of rows) insert.run(key, value);
  } finally {
    sqlite.close();
  }
}

function storedSettings(): Array<[string, string]> {
  const sqlite = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    return (
      sqlite.prepare(`SELECT key, value FROM settings ORDER BY key`).all() as Array<{
        key: string;
        value: string;
      }>
    ).map((row) => [row.key, row.value]);
  } finally {
    sqlite.close();
  }
}

function capture(argv: readonly string[]): { summary: ReturnType<typeof runSettingsReset>; out: string } {
  let out = "";
  const summary = runSettingsResetCli(argv, { writeStdout: (value) => (out += value) });
  return { summary, out };
}

describe("parseSettingsResetArguments", () => {
  it("requires --yes to confirm and resolves --db against the working directory", () => {
    expect(parseSettingsResetArguments(["--db", "thesis.db"], directory)).toEqual({
      dbFile: path.join(directory, "thesis.db"),
      confirmed: false,
    });
    expect(parseSettingsResetArguments(["--yes", "--db", "thesis.db"], directory)).toEqual({
      dbFile: path.join(directory, "thesis.db"),
      confirmed: true,
    });
  });

  it("falls back to the configured database path when --db is absent", () => {
    process.env.THESIS_DB_PATH = dbFile;
    try {
      expect(parseSettingsResetArguments([], directory)).toEqual({
        dbFile,
        confirmed: false,
      });
    } finally {
      delete process.env.THESIS_DB_PATH;
    }
  });

  it.each([
    [["--force"], /Unknown option "--force"/],
    [["--db"], /--db requires a path/],
    [["--db", "--yes"], /--db requires a path/],
    [["reset"], /Unexpected argument "reset"/],
  ])("rejects %s rather than guessing", (argv, message) => {
    expect(() => parseSettingsResetArguments(argv, directory)).toThrow(message);
  });
});

describe("runSettingsReset", () => {
  it("previews without deleting, then deletes with --yes", () => {
    seedSettings([
      ["analysisModel", "claude-opus-4-8"],
      ["analysisEffort", "max"],
      ["__writableSettingsRevision", "7"],
    ]);

    const preview = runSettingsReset({ dbFile, confirmed: false });
    expect(preview.deleted).toBe(0);
    // The revision counter is never offered for deletion: it is the monotonic
    // sequence behind the settings compare-and-swap, not a setting.
    expect(preview.rows.map((row) => row.key)).toEqual([
      "analysisEffort",
      "analysisModel",
    ]);
    expect(preview.preserved).toEqual(["__writableSettingsRevision"]);
    expect(storedSettings()).toHaveLength(3);

    const applied = runSettingsReset({ dbFile, confirmed: true });
    expect(applied.deleted).toBe(2);
    expect(storedSettings()).toEqual([["__writableSettingsRevision", "7"]]);
  });

  it("keeps the cache-maintenance stamp, which is bookkeeping and not a setting", () => {
    expect([...PRESERVED_SETTING_KEYS].sort()).toEqual([
      "__writableSettingsRevision",
      "cacheMaintenanceLastRunAt",
    ]);
    seedSettings([
      ["analysisModel", "claude-sonnet-5"],
      ["cacheMaintenanceLastRunAt", "2026-09-01T00:00:00.000Z"],
    ]);

    const summary = runSettingsReset({ dbFile, confirmed: true });

    expect(summary.deleted).toBe(1);
    expect(summary.preserved).toEqual(["cacheMaintenanceLastRunAt"]);
    expect(storedSettings()).toEqual([
      ["cacheMaintenanceLastRunAt", "2026-09-01T00:00:00.000Z"],
    ]);
  });

  it("keeps the writable-settings revision so a reset cannot replay an etag", () => {
    expect(PRESERVED_SETTING_KEYS).toContain(WRITABLE_SETTINGS_REVISION_KEY);
    seedSettings([
      ["analysisModel", "claude-sonnet-5"],
      ["analysisEffort", "max"],
      [WRITABLE_SETTINGS_REVISION_KEY, "12"],
    ]);

    const summary = runSettingsReset({ dbFile, confirmed: true });

    expect(summary.deleted).toBe(2);
    expect(summary.preserved).toEqual([WRITABLE_SETTINGS_REVISION_KEY]);
    // Survives at its old value: the next write advances 12 -> 13, so no etag
    // a stale tab still holds can ever match again.
    expect(storedSettings()).toEqual([[WRITABLE_SETTINGS_REVISION_KEY, "12"]]);
  });

  it("never creates a database and tolerates one without the settings table", () => {
    const absent = runSettingsReset({ dbFile, confirmed: true });
    expect(absent).toMatchObject({ databaseExists: false, rows: [], deleted: 0 });
    expect(existsSync(dbFile)).toBe(false);

    const sqlite = new Database(dbFile);
    sqlite.exec(`CREATE TABLE "watchlist" ("symbol" TEXT PRIMARY KEY NOT NULL)`);
    sqlite.close();

    expect(runSettingsReset({ dbFile, confirmed: true })).toMatchObject({
      databaseExists: true,
      rows: [],
      deleted: 0,
    });
  });
});

describe("runSettingsResetCli", () => {
  it("prints what it would delete and says nothing was deleted", () => {
    seedSettings([
      ["analysisModel", "claude-opus-4-8"],
      ["analysisEffort", "max"],
    ]);

    const { out } = capture(["--db", dbFile]);

    expect(out).toContain("would delete 2 stored setting rows:");
    expect(out).toContain("analysisEffort = max");
    expect(out).toContain("analysisModel = claude-opus-4-8");
    expect(out).toContain("Re-run with --yes");
    expect(storedSettings()).toHaveLength(2);
  });

  it("reports the deletion and where values now come from", () => {
    seedSettings([["analysisModel", "claude-opus-4-8"]]);

    const { out } = capture(["--yes", "--db", dbFile]);

    expect(out).toContain("deleted 1 stored setting row:");
    expect(out).toContain("environment, then the built-in defaults");
    expect(storedSettings()).toEqual([]);
  });

  it("says so when nothing is stored", () => {
    seedSettings([]);
    expect(capture(["--yes", "--db", dbFile]).out).toContain("no stored settings");
    rmSync(dbFile);
    expect(capture(["--yes", "--db", dbFile]).out).toContain("no database file yet");
  });

  it("runs the declared settings:reset argv, alias and react-server condition included", () => {
    seedSettings([["analysisModel", "claude-opus-4-8"]]);

    // Spawn the script exactly as package.json declares it, but without the
    // package manager. `npm run` fires npm's update-notifier — a live
    // pacote.manifest("npm@*") request to registry.npmjs.org from a child
    // process that tests/setup/noLiveNetwork.ts cannot reach, since that guard
    // only replaces globalThis.fetch inside the Vitest process. Reading the
    // argv here pins the same alias and condition wiring without any network
    // capability, and without depending on npm_execpath, which is unset under
    // node_modules/.bin/vitest and under IDE runners.
    const manifest = JSON.parse(
      readFileSync(path.join(ROOT, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const [runner, ...scriptArgv] = manifest.scripts["settings:reset"].split(/\s+/);

    expect(runner).toBe("node");
    expect(scriptArgv).toContain("--conditions=react-server");
    expect(scriptArgv).toContain("scripts/settings-reset.ts");

    function run(extra: readonly string[]): ReturnType<typeof spawnSync> {
      return spawnSync(process.execPath, [...scriptArgv, ...extra], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 60_000,
      });
    }

    const preview = run(["--db", dbFile]);
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain("would delete 1 stored setting row:");
    expect(preview.stdout).toContain("analysisModel = claude-opus-4-8");
    expect(storedSettings()).toHaveLength(1);

    const applied = run(["--yes", "--db", dbFile]);
    expect(applied.status, applied.stderr).toBe(0);
    expect(applied.stdout).toContain("deleted 1 stored setting row:");
    expect(storedSettings()).toEqual([]);
  }, 90_000);
});
