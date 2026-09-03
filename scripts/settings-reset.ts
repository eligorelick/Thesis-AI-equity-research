/**
 * `npm run settings:reset -- --yes` — drop the stored settings rows.
 *
 * Settings resolve database → environment → default (src/settings/settings.ts
 * `resolveValue`). A value saved from the Settings page therefore keeps
 * winning over `.env` forever, which is confusing when someone edits `.env`
 * and sees nothing change. Deleting the stored rows hands control back to the
 * environment, and then to the built-in defaults.
 *
 * Without `--yes` this prints exactly which rows it would delete and changes
 * nothing. The cache-maintenance stamp is bookkeeping rather than a setting, so
 * it is preserved — deleting it would force a VACUUM sweep on the next start.
 *
 * Run through npm so the `@/` path alias and the `react-server` condition
 * (which makes the `server-only` marker inert outside Next) are both applied:
 *   npm run settings:reset            # preview
 *   npm run settings:reset -- --yes   # delete
 *   npm run settings:reset -- --yes --db /path/to/thesis.db
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

import Database from "better-sqlite3";

import { MAINTENANCE_LAST_RUN_KEY } from "@/cache/maintenance";
import { defaultDbPath } from "@/db/paths";

/** Keys the reset leaves in place: internal bookkeeping, not user settings. */
export const PRESERVED_SETTING_KEYS: readonly string[] = [MAINTENANCE_LAST_RUN_KEY];

export interface SettingsResetArguments {
  dbFile: string;
  confirmed: boolean;
}

export interface SettingsResetRow {
  key: string;
  value: string;
}

export interface SettingsResetSummary extends SettingsResetArguments {
  /** False when the database file does not exist yet — nothing is stored. */
  databaseExists: boolean;
  /** Rows that were deleted, or that would be deleted in a preview. */
  rows: SettingsResetRow[];
  /** Rows actually deleted: 0 in a preview. */
  deleted: number;
  /** Bookkeeping keys present in the table and deliberately kept. */
  preserved: string[];
}

export function parseSettingsResetArguments(
  argv: readonly string[],
  cwd = process.cwd(),
): SettingsResetArguments {
  const known = new Set(["--yes", "--db"]);
  for (const [index, token] of argv.entries()) {
    if (!token.startsWith("--")) {
      // The only positional-looking token allowed is the value after --db.
      if (index > 0 && argv[index - 1] === "--db") continue;
      throw new Error(`Unexpected argument "${token}"`);
    }
    if (!known.has(token)) throw new Error(`Unknown option "${token}"`);
  }

  const dbIndex = argv.indexOf("--db");
  if (dbIndex >= 0) {
    const value = argv[dbIndex + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--db requires a path");
    }
    return { dbFile: path.resolve(cwd, value), confirmed: argv.includes("--yes") };
  }
  return { dbFile: defaultDbPath(), confirmed: argv.includes("--yes") };
}

/**
 * Read the stored settings and, when confirmed, delete them in one statement.
 * Never creates a database: an absent file means nothing is stored.
 */
export function runSettingsReset({
  dbFile,
  confirmed,
}: SettingsResetArguments): SettingsResetSummary {
  let sqlite: Database.Database;
  try {
    sqlite = new Database(dbFile, { fileMustExist: true });
  } catch {
    return {
      dbFile,
      confirmed,
      databaseExists: false,
      rows: [],
      deleted: 0,
      preserved: [],
    };
  }

  try {
    const hasSettingsTable = sqlite
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'`)
      .get() !== undefined;
    if (!hasSettingsTable) {
      return { dbFile, confirmed, databaseExists: true, rows: [], deleted: 0, preserved: [] };
    }

    const all = sqlite
      .prepare(`SELECT key, value FROM settings ORDER BY key`)
      .all() as SettingsResetRow[];
    const preserved = all
      .filter((row) => PRESERVED_SETTING_KEYS.includes(row.key))
      .map((row) => row.key);
    const rows = all.filter((row) => !PRESERVED_SETTING_KEYS.includes(row.key));

    let deleted = 0;
    if (confirmed && rows.length > 0) {
      const placeholders = PRESERVED_SETTING_KEYS.map(() => "?").join(", ");
      deleted = sqlite
        .prepare(`DELETE FROM settings WHERE key NOT IN (${placeholders})`)
        .run(...PRESERVED_SETTING_KEYS).changes;
    }

    return { dbFile, confirmed, databaseExists: true, rows, deleted, preserved };
  } finally {
    sqlite.close();
  }
}

/** Human-readable report; the summary is returned for tests and callers. */
export function runSettingsResetCli(
  argv: readonly string[],
  io: { writeStdout(value: string): void } = {
    writeStdout: (value) => process.stdout.write(value),
  },
  cwd = process.cwd(),
): SettingsResetSummary {
  const summary = runSettingsReset(parseSettingsResetArguments(argv, cwd));
  const lines: string[] = [`database: ${summary.dbFile}`];

  if (!summary.databaseExists) {
    lines.push("no database file yet, so no settings are stored; nothing to reset.");
  } else if (summary.rows.length === 0) {
    lines.push("no stored settings; environment values and defaults already apply.");
  } else {
    lines.push(
      summary.confirmed
        ? `deleted ${summary.deleted} stored setting ${summary.deleted === 1 ? "row" : "rows"}:`
        : `would delete ${summary.rows.length} stored setting ${summary.rows.length === 1 ? "row" : "rows"}:`,
    );
    for (const row of summary.rows) lines.push(`  ${row.key} = ${row.value}`);
    lines.push(
      summary.confirmed
        ? "these settings now come from the environment, then the built-in defaults."
        : "nothing was deleted. Re-run with --yes to delete them.",
    );
  }
  if (summary.preserved.length > 0) {
    lines.push(`kept internal bookkeeping: ${summary.preserved.join(", ")}`);
  }

  io.writeStdout(`${lines.join("\n")}\n`);
  return summary;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  try {
    runSettingsResetCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
