/**
 * Database bootstrap for Thesis. better-sqlite3 stores its WAL-mode database
 * in the user's app-data directory by default, wrapped in Drizzle. Schema is
 * created idempotently with
 * CREATE TABLE IF NOT EXISTS on first connection — no migration step needed.
 *
 * Server-only: never import from client components. API keys and local data
 * must not reach the browser.
 *
 * The singleton is stashed on globalThis so Next.js dev hot-reloads reuse the
 * same connection instead of leaking file handles. Tests inject an in-memory
 * database via setDbForTests() (see tests/db.cache.test.ts).
 */

import "server-only";

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { maintainApiCache } from "@/cache/maintenance";
import * as schema from "./schema";
import { defaultDbPath, hasExplicitDbPath } from "./paths";

if (typeof window !== "undefined") {
  // Programming error, not a data gap: this module must stay server-side.
  throw new Error("src/db is server-only and must never be imported into client components");
}

export type ThesisDb = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  db: ThesisDb;
  sqlite: Database.Database;
}

// ---------------------------------------------------------------------------
// Idempotent DDL — kept exactly in sync with src/db/schema.ts.
// ---------------------------------------------------------------------------

const DDL = `
CREATE TABLE IF NOT EXISTS "watchlist" (
  "symbol" TEXT PRIMARY KEY NOT NULL,
  "addedAt" TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "reports" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "symbol" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "reportJson" TEXT,
  "verificationRate" REAL,
  "costUsd" REAL,
  "specVersion" TEXT
);
CREATE INDEX IF NOT EXISTS "idx_reports_symbol_createdAt" ON "reports" ("symbol", "createdAt");

CREATE TABLE IF NOT EXISTS "api_cache" (
  "cacheKey" TEXT PRIMARY KEY NOT NULL,
  "provider" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "paramsJson" TEXT NOT NULL,
  "bodyJson" TEXT NOT NULL,
  "bodyGz" BLOB,
  "fetchedAt" TEXT NOT NULL,
  "ttlSeconds" INTEGER NOT NULL,
  "asOf" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_api_cache_provider_endpoint" ON "api_cache" ("provider", "endpoint");
CREATE INDEX IF NOT EXISTS "idx_api_cache_fetchedAt" ON "api_cache" ("fetchedAt");

CREATE TABLE IF NOT EXISTS "jobs" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "symbol" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "stepsJson" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  "error" TEXT,
  "reportId" INTEGER REFERENCES "reports"("id") ON DELETE SET NULL,
  "bullJson" TEXT,
  "bearJson" TEXT,
  "payloadFingerprint" TEXT
);
CREATE INDEX IF NOT EXISTS "idx_jobs_symbol" ON "jobs" ("symbol");
CREATE INDEX IF NOT EXISTS "idx_jobs_status" ON "jobs" ("status");

CREATE TABLE IF NOT EXISTS "cost_log" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "jobId" TEXT NOT NULL,
  "step" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
  "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
  "webSearches" INTEGER NOT NULL DEFAULT 0,
  "costUsd" REAL NOT NULL DEFAULT 0,
  "fallbackUsed" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_cost_log_jobId" ON "cost_log" ("jobId");

CREATE TABLE IF NOT EXISTS "settings" (
  "key" TEXT PRIMARY KEY NOT NULL,
  "value" TEXT NOT NULL
);
`;

/**
 * Idempotent column add for existing databases — the bootstrap DDL only runs
 * CREATE TABLE IF NOT EXISTS, so columns added after a table first shipped
 * need an explicit guard (SQLite has no ADD COLUMN IF NOT EXISTS).
 */
function ensureColumn(
  sqlite: Database.Database,
  table: string,
  column: string,
  decl: string,
): void {
  const cols = sqlite.pragma(`table_info(${table})`) as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    sqlite.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${decl}`);
  }
}

/**
 * Runs the idempotent CREATE TABLE IF NOT EXISTS DDL plus column guards for
 * columns added after a table first shipped. Safe to call any number of
 * times; called automatically by createDatabase()/getDb().
 */
export function bootstrapSchema(sqlite: Database.Database): void {
  sqlite.exec(DDL);
  ensureColumn(sqlite, "api_cache", "bodyGz", "BLOB");
  ensureColumn(sqlite, "jobs", "bullJson", "TEXT");
  ensureColumn(sqlite, "jobs", "bearJson", "TEXT");
  ensureColumn(sqlite, "jobs", "payloadFingerprint", "TEXT");
}

// ---------------------------------------------------------------------------
// Connection factory
// ---------------------------------------------------------------------------

function legacyProjectDbPath(): string {
  return path.join(process.cwd(), "data", "thesis.db");
}

function importLegacyProjectDbIfExplicitlyEnabled(targetFile: string): void {
  if (hasExplicitDbPath() || process.env.THESIS_IMPORT_LEGACY_DB?.trim() !== "1") return;

  const legacy = path.resolve(legacyProjectDbPath());
  const target = path.resolve(targetFile);
  if (legacy === target || fs.existsSync(target) || !fs.existsSync(legacy)) return;

  fs.mkdirSync(path.dirname(target), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = `${legacy}${suffix}`;
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, `${target}${suffix}`);
    }
  }
}

/**
 * Opens (creating parent directories if needed), applies pragmas (WAL,
 * busy_timeout, foreign_keys), bootstraps the schema, and wraps in Drizzle.
 * Pass ":memory:" for tests.
 */
export function createDatabase(file: string = defaultDbPath()): DatabaseHandle {
  if (file !== ":memory:") {
    const active = path.resolve(file);
    const workspace = path.resolve(legacyProjectDbPath());
    console.info(`[db] active database: ${active}`);
    if (workspace !== active && fs.existsSync(workspace)) {
      console.warn(
        `[db] stale workspace database detected at ${workspace}; it is not used. ` +
        "Set THESIS_IMPORT_LEGACY_DB=1 only for an intentional one-time import.",
      );
    }
    importLegacyProjectDbIfExplicitlyEnabled(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL"); // no-op ("memory") for :memory: databases
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  bootstrapSchema(sqlite);
  if (file !== ":memory:") {
    // Compress/purge/VACUUM sweep, guarded to once per 24h. Maintenance must
    // never block or break startup — the cache is rebuildable by design.
    try {
      maintainApiCache(sqlite);
    } catch (err) {
      console.warn("[db] cache maintenance failed:", err instanceof Error ? err.message : err);
    }
  }
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

// ---------------------------------------------------------------------------
// Lazy singleton, hot-reload-safe via globalThis stash
// ---------------------------------------------------------------------------

interface ThesisDbStash {
  handle?: DatabaseHandle;
  testDb?: ThesisDb | null;
}

const globalWithStash = globalThis as typeof globalThis & {
  __thesisDbStash?: ThesisDbStash;
};

function stash(): ThesisDbStash {
  if (!globalWithStash.__thesisDbStash) {
    globalWithStash.__thesisDbStash = {};
  }
  return globalWithStash.__thesisDbStash;
}

/**
 * Lazily-initialized singleton Drizzle instance backed by the default local
 * app-data database path. First call creates the file, applies WAL mode, and
 * bootstraps the schema.
 * If a test database was injected via setDbForTests(), that one is returned
 * instead.
 */
export function getDb(): ThesisDb {
  const s = stash();
  if (s.testDb) return s.testDb;
  if (!s.handle) {
    s.handle = createDatabase();
  }
  return s.handle.db;
}

/** Raw better-sqlite3 handle of the singleton (maintenance/pragma use). */
export function getRawSqlite(): Database.Database {
  const s = stash();
  if (s.testDb) {
    throw new Error("getRawSqlite() is unavailable while a test database override is active");
  }
  if (!s.handle) {
    s.handle = createDatabase();
  }
  return s.handle.sqlite;
}

/**
 * Test escape hatch: make getDb() return the given database (build one with
 * createDatabase(":memory:")). Pass null to restore normal behavior. Never
 * call from app code.
 */
export function setDbForTests(db: ThesisDb | null): void {
  stash().testDb = db;
}

/** Closes the on-disk singleton (if open) and clears the stash. */
export function closeDb(): void {
  const s = stash();
  if (s.handle) {
    s.handle.sqlite.close();
    s.handle = undefined;
  }
}

export * from "./schema";
export { defaultDataDir, defaultDbPath } from "./paths";
