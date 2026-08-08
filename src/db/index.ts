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
import { normalizeLinkedReportRecoverySteps } from "@/pipeline/jobSteps";
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

const BASE_TABLE_DDL = `
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

CREATE TABLE IF NOT EXISTS "jobs" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "symbol" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "stepsJson" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  "error" TEXT,
  "reportId" INTEGER REFERENCES "reports"("id") ON DELETE SET NULL,
  "unsupportedKind" TEXT,
  "unsupportedMessage" TEXT,
  "bullJson" TEXT,
  "bearJson" TEXT,
  "payloadFingerprint" TEXT,
  "runGeneration" INTEGER NOT NULL DEFAULT 0,
  "resumeSourceGeneration" INTEGER,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "queuedAt" TEXT,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TEXT,
  "heartbeatAt" TEXT,
  "notBefore" TEXT,
  "maxCostUsd" REAL
);

CREATE TABLE IF NOT EXISTS "cost_log" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "jobId" TEXT NOT NULL,
  "runGeneration" INTEGER NOT NULL DEFAULT 0,
  "attemptId" TEXT,
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

CREATE TABLE IF NOT EXISTS "settings" (
  "key" TEXT PRIMARY KEY NOT NULL,
  "value" TEXT NOT NULL
);
`;

const DURABLE_JOB_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS "job_pass_artifacts" (
  "jobId" TEXT NOT NULL REFERENCES "jobs"("id") ON DELETE CASCADE,
  "runGeneration" INTEGER NOT NULL,
  "attemptId" TEXT NOT NULL,
  "pass" TEXT NOT NULL,
  "outcomeJson" TEXT NOT NULL,
  "telemetryJson" TEXT NOT NULL,
  "costJson" TEXT NOT NULL,
  "settledAt" TEXT NOT NULL,
  CONSTRAINT "job_pass_artifacts_pk" PRIMARY KEY ("jobId", "runGeneration", "attemptId", "pass")
);

CREATE TABLE IF NOT EXISTS "job_llm_leases" (
  "permitId" TEXT PRIMARY KEY NOT NULL,
  "jobId" TEXT NOT NULL REFERENCES "jobs"("id") ON DELETE CASCADE,
  "runGeneration" INTEGER NOT NULL,
  "attemptId" TEXT NOT NULL,
  "pass" TEXT NOT NULL,
  "leaseOwner" TEXT NOT NULL,
  "reservedCostUsd" REAL NOT NULL,
  "acquiredAt" TEXT NOT NULL,
  "leaseExpiresAt" TEXT NOT NULL
);
`;

const INDEX_DDL = `
CREATE INDEX IF NOT EXISTS "idx_reports_symbol_createdAt" ON "reports" ("symbol", "createdAt");
CREATE INDEX IF NOT EXISTS "idx_api_cache_provider_endpoint" ON "api_cache" ("provider", "endpoint");
CREATE INDEX IF NOT EXISTS "idx_api_cache_fetchedAt" ON "api_cache" ("fetchedAt");
CREATE INDEX IF NOT EXISTS "idx_jobs_symbol" ON "jobs" ("symbol");
CREATE INDEX IF NOT EXISTS "idx_jobs_status" ON "jobs" ("status");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_jobs_active_symbol" ON "jobs" ("symbol") WHERE "status" IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS "idx_jobs_queue_claim" ON "jobs" ("status", "notBefore", "queuedAt");
CREATE INDEX IF NOT EXISTS "idx_jobs_lease_expiry" ON "jobs" ("status", "leaseExpiresAt");
CREATE INDEX IF NOT EXISTS "idx_cost_log_jobId" ON "cost_log" ("jobId");
CREATE INDEX IF NOT EXISTS "idx_cost_log_createdAt" ON "cost_log" ("createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_cost_log_billed_attempt_pass"
  ON "cost_log" ("jobId", "runGeneration", "attemptId", "step")
  WHERE "attemptId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_job_pass_artifacts_job_generation"
  ON "job_pass_artifacts" ("jobId", "runGeneration", "settledAt");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_job_llm_leases_attempt_pass"
  ON "job_llm_leases" ("jobId", "runGeneration", "attemptId", "pass");
CREATE INDEX IF NOT EXISTS "idx_job_llm_leases_expiry" ON "job_llm_leases" ("leaseExpiresAt");
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

function normalizeBootstrapTerminalSteps(
  raw: string,
  message: string,
  at: string,
  linkedReportWins = false,
): string {
  if (linkedReportWins) {
    return normalizeLinkedReportRecoverySteps(
      raw,
      at,
      "covered by linked persisted report recovered during database migration",
    );
  }
  try {
    const steps = JSON.parse(raw) as Array<Record<string, unknown>>;
    if (!Array.isArray(steps)) return raw;
    for (const step of steps) {
      if (step.status === "running") {
        step.status = "error";
        step.detail = message;
        step.finishedAt = at;
        step.completedAt = at;
      } else if (step.status === "pending") {
        step.status = "skipped";
        step.detail = `not reached — ${message}`;
      }
    }
    return JSON.stringify(steps);
  } catch {
    return raw;
  }
}

/**
 * Runs the idempotent CREATE TABLE IF NOT EXISTS DDL plus column guards for
 * columns added after a table first shipped. Safe to call any number of
 * times; called automatically by createDatabase()/getDb().
 */
export function bootstrapSchema(sqlite: Database.Database): void {
  sqlite.transaction(() => {
    // Keep this order: existing tables first, then legacy column upgrades and
    // backfills, then new tables, and only then indexes that reference the new
    // columns. BEGIN IMMEDIATE serializes concurrent application bootstraps.
    sqlite.exec(BASE_TABLE_DDL);

    ensureColumn(sqlite, "api_cache", "bodyGz", "BLOB");
    ensureColumn(sqlite, "jobs", "bullJson", "TEXT");
    ensureColumn(sqlite, "jobs", "bearJson", "TEXT");
    ensureColumn(sqlite, "jobs", "payloadFingerprint", "TEXT");
    ensureColumn(sqlite, "jobs", "unsupportedKind", "TEXT");
    ensureColumn(sqlite, "jobs", "unsupportedMessage", "TEXT");
    ensureColumn(sqlite, "jobs", "runGeneration", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(sqlite, "jobs", "resumeSourceGeneration", "INTEGER");
    ensureColumn(sqlite, "jobs", "revision", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(sqlite, "jobs", "queuedAt", "TEXT");
    ensureColumn(sqlite, "jobs", "leaseOwner", "TEXT");
    ensureColumn(sqlite, "jobs", "leaseExpiresAt", "TEXT");
    ensureColumn(sqlite, "jobs", "heartbeatAt", "TEXT");
    ensureColumn(sqlite, "jobs", "notBefore", "TEXT");
    ensureColumn(sqlite, "jobs", "maxCostUsd", "REAL");
    ensureColumn(sqlite, "cost_log", "runGeneration", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(sqlite, "cost_log", "attemptId", "TEXT");

    sqlite.exec(`
      UPDATE "jobs" SET "runGeneration" = 0 WHERE "runGeneration" IS NULL;
      UPDATE "jobs" SET "revision" = 0 WHERE "revision" IS NULL;
      UPDATE "jobs" SET "queuedAt" = "createdAt"
       WHERE "status" = 'queued' AND "queuedAt" IS NULL;
      UPDATE "cost_log" SET "runGeneration" = 0 WHERE "runGeneration" IS NULL;
    `);

    // A pre-index database may contain duplicate active rows from the old
    // check-then-insert route. Retain the newest row and terminalize older
    // duplicates before installing the cross-process uniqueness constraint.
    const duplicateMessage = "duplicate active job superseded during database migration";
    const duplicateAtMs = Date.now();
    const duplicates = sqlite.prepare(`
      SELECT old."id" AS "id", old."revision" AS "revision",
             old."stepsJson" AS "stepsJson", old."updatedAt" AS "updatedAt",
             old."reportId" AS "reportId",
             EXISTS (
               SELECT 1 FROM "reports" AS linked WHERE linked."id" = old."reportId"
             ) AS "reportExists"
        FROM "jobs" AS old
       WHERE old."status" IN ('queued', 'running')
         AND EXISTS (
           SELECT 1 FROM "jobs" AS newer
            WHERE newer."symbol" = old."symbol"
              AND newer."status" IN ('queued', 'running')
              AND (newer."updatedAt" > old."updatedAt"
                OR (newer."updatedAt" = old."updatedAt" AND newer."id" > old."id"))
         )
    `).all() as Array<{
      id: string;
      revision: number;
      stepsJson: string;
      updatedAt: string;
      reportId: number | null;
      reportExists: number;
    }>;
    const terminalizeDuplicate = sqlite.prepare(`
      UPDATE "jobs"
         SET "status" = ?,
             "error" = ?,
             "unsupportedKind" = NULL,
             "unsupportedMessage" = NULL,
             "stepsJson" = ?,
             "leaseOwner" = NULL,
             "leaseExpiresAt" = NULL,
             "heartbeatAt" = NULL,
             "updatedAt" = ?,
             "revision" = ?
       WHERE "id" = ?
         AND "revision" = ?
         AND "status" IN ('queued', 'running')
    `);
    for (const duplicate of duplicates) {
      if (!Number.isSafeInteger(duplicate.revision) || duplicate.revision < 0) {
        throw new Error("database migration: invalid or unsafe job revision");
      }
      if (duplicate.revision === Number.MAX_SAFE_INTEGER) {
        throw new Error("database migration: safe job revision overflow");
      }
      const storedUpdatedAtMs = Date.parse(duplicate.updatedAt);
      if (!Number.isFinite(storedUpdatedAtMs)) {
        throw new Error("database migration: invalid stored job updatedAt");
      }
      const terminalAt = new Date(Math.max(storedUpdatedAtMs, duplicateAtMs)).toISOString();
      const linkedReportWins = duplicate.reportId !== null && duplicate.reportExists === 1;
      const status = linkedReportWins ? "done" : "error";
      const error = linkedReportWins ? null : duplicateMessage;
      const result = terminalizeDuplicate.run(
        status,
        error,
        normalizeBootstrapTerminalSteps(
          duplicate.stepsJson,
          duplicateMessage,
          terminalAt,
          linkedReportWins,
        ),
        terminalAt,
        duplicate.revision + 1,
        duplicate.id,
        duplicate.revision,
      );
      if (result.changes !== 1) {
        throw new Error("database migration: duplicate job revision fence changed unexpectedly");
      }
    }

    sqlite.exec(DURABLE_JOB_TABLE_DDL);
    sqlite.exec(INDEX_DDL);
  }).immediate();
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
