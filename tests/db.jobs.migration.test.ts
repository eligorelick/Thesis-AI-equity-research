import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapSchema } from "@/db";
import * as drizzleSchema from "@/db/schema";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const DB_MODULE_URL = pathToFileURL(path.join(ROOT, "src", "db", "index.ts")).href;
const MAXIMUM_PASS_COST_USD = 4.25;

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "thesis-jobs-migration-"));
  tempDirs.push(dir);
  return path.join(dir, "thesis.db");
}

function openSqlite(file: string): Database.Database {
  const sqlite = new Database(file);
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  return sqlite;
}

function createAuditedLegacyDatabase(file: string, jobId = "legacy-job"): void {
  const sqlite = openSqlite(file);
  try {
    sqlite.exec(`
      CREATE TABLE "reports" (
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
      CREATE TABLE "jobs" (
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
        "payloadFingerprint" TEXT
      );
      CREATE TABLE "cost_log" (
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
      INSERT INTO "jobs" (
        "id", "symbol", "status", "stepsJson", "createdAt", "updatedAt",
        "bullJson", "payloadFingerprint"
      ) VALUES (
        '${jobId}', 'AAPL', 'queued', '[{"step":"fetch","status":"pending"}]',
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
        '{"legacy":true}', 'legacy-fingerprint'
      );
      INSERT INTO "cost_log" (
        "jobId", "step", "model", "inputTokens", "outputTokens", "costUsd", "createdAt"
      ) VALUES (
        '${jobId}', 'bull', 'legacy-model', 100, 20, 0.125, '2026-07-01T00:01:00.000Z'
      );
    `);
  } finally {
    sqlite.close();
  }
}

function columnInfo(sqlite: Database.Database, table: string): Map<string, { notnull: number; dflt_value: string | null; pk: number }> {
  const rows = sqlite.pragma(`table_info(${table})`) as {
    name: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }[];
  return new Map(rows.map(({ name, notnull, dflt_value, pk }) => [name, { notnull, dflt_value, pk }]));
}

function indexInfo(sqlite: Database.Database, table: string, indexName: string): { unique: number; partial: number } {
  const rows = sqlite.pragma(`index_list(${table})`) as { name: string; unique: number; partial: number }[];
  const row = rows.find(({ name }) => name === indexName);
  expect(row, `missing ${indexName} on ${table}`).toBeDefined();
  return { unique: row!.unique, partial: row!.partial };
}

function insertArtifact(sqlite: Database.Database): void {
  sqlite.prepare(`
    INSERT INTO "job_pass_artifacts" (
      "jobId", "runGeneration", "attemptId", "pass", "outcomeJson",
      "telemetryJson", "costJson", "settledAt"
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "legacy-job",
    0,
    "attempt-1",
    "bull",
    JSON.stringify({ outcome: "success", data: { thesis: "durable" } }),
    JSON.stringify({ inputTokens: 100, outputTokens: 20 }),
    JSON.stringify({ costUsd: 0.125 }),
    "2026-07-01T00:02:00.000Z",
  );
}

function insertLease(
  sqlite: Database.Database,
  permitId: string,
  attemptId: string,
  acquiredAt = "2026-07-01T00:03:00.000Z",
  leaseExpiresAt = "2026-07-01T00:04:00.000Z",
): void {
  sqlite.prepare(`
    INSERT INTO "job_llm_leases" (
      "permitId", "jobId", "runGeneration", "attemptId", "pass", "leaseOwner",
      "reservedCostUsd", "acquiredAt", "leaseExpiresAt"
    ) VALUES (?, 'legacy-job', 0, ?, 'bull', 'worker-1', ?, ?, ?)
  `).run(permitId, attemptId, MAXIMUM_PASS_COST_USD, acquiredAt, leaseExpiresAt);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("durable job schema migration", () => {
  it("idempotently upgrades the audited legacy schema with safe defaults and preserves rows", () => {
    const dbPath = tempDbPath();
    createAuditedLegacyDatabase(dbPath);
    const sqlite = openSqlite(dbPath);
    try {
      bootstrapSchema(sqlite);
      bootstrapSchema(sqlite);

      const job = sqlite.prepare(`
        SELECT "symbol", "status", "stepsJson", "bullJson", "payloadFingerprint",
               "runGeneration", "revision", "queuedAt", "leaseOwner", "leaseExpiresAt",
               "heartbeatAt", "notBefore", "maxCostUsd"
          FROM "jobs" WHERE "id" = 'legacy-job'
      `).get() as Record<string, unknown>;
      expect(job).toMatchObject({
        symbol: "AAPL",
        status: "queued",
        stepsJson: '[{"step":"fetch","status":"pending"}]',
        bullJson: '{"legacy":true}',
        payloadFingerprint: "legacy-fingerprint",
        runGeneration: 0,
        revision: 0,
        queuedAt: "2026-07-01T00:00:00.000Z",
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        notBefore: null,
        maxCostUsd: null,
      });

      const legacyCost = sqlite.prepare(`
        SELECT "jobId", "step", "costUsd", "runGeneration", "attemptId"
          FROM "cost_log" WHERE "id" = 1
      `).get();
      expect(legacyCost).toEqual({
        jobId: "legacy-job",
        step: "bull",
        costUsd: 0.125,
        runGeneration: 0,
        attemptId: null,
      });

      const jobColumns = columnInfo(sqlite, "jobs");
      expect(jobColumns.get("runGeneration")).toEqual({ notnull: 1, dflt_value: "0", pk: 0 });
      expect(jobColumns.get("revision")).toEqual({ notnull: 1, dflt_value: "0", pk: 0 });
      expect(jobColumns.get("leaseOwner")?.notnull).toBe(0);
      const costColumns = columnInfo(sqlite, "cost_log");
      expect(costColumns.get("runGeneration")).toEqual({ notnull: 1, dflt_value: "0", pk: 0 });
      expect(costColumns.get("attemptId")?.notnull).toBe(0);

      expect(Object.keys(drizzleSchema)).toEqual(
        expect.arrayContaining(["jobPassArtifacts", "jobLlmLeases"]),
      );
    } finally {
      sqlite.close();
    }
  });

  it("enforces exact artifact, billed-attempt, and paid-pass lease uniqueness", () => {
    const dbPath = tempDbPath();
    createAuditedLegacyDatabase(dbPath);
    const sqlite = openSqlite(dbPath);
    try {
      bootstrapSchema(sqlite);

      insertArtifact(sqlite);
      expect(() => insertArtifact(sqlite)).toThrowError(/UNIQUE constraint failed/);

      const billed = sqlite.prepare(`
        INSERT INTO "cost_log" (
          "jobId", "runGeneration", "attemptId", "step", "model", "costUsd", "createdAt"
        ) VALUES ('legacy-job', 0, 'attempt-1', 'bull', 'test-model', 0.125, ?)
      `);
      billed.run("2026-07-01T00:02:00.000Z");
      expect(() => billed.run("2026-07-01T00:02:01.000Z")).toThrowError(/UNIQUE constraint failed/);

      const legacyWriter = sqlite.prepare(`
        INSERT INTO "cost_log" (
          "jobId", "runGeneration", "attemptId", "step", "model", "costUsd", "createdAt"
        ) VALUES ('legacy-job', 0, NULL, 'bear', 'test-model', 0.25, ?)
      `);
      legacyWriter.run("2026-07-01T00:02:02.000Z");
      legacyWriter.run("2026-07-01T00:02:03.000Z");
      expect(
        sqlite.prepare(`SELECT count(*) AS "count" FROM "cost_log" WHERE "attemptId" IS NULL`).get(),
      ).toEqual({ count: 3 });

      insertLease(sqlite, "permit-1", "attempt-1");
      expect(() => insertLease(sqlite, "permit-2", "attempt-1")).toThrowError(/UNIQUE constraint failed/);
      expect(() => insertLease(sqlite, "permit-1", "attempt-2")).toThrowError(/UNIQUE constraint failed/);
    } finally {
      sqlite.close();
    }
  });

  it("keeps permits and spend reservations durable across reopen and exposes reclaim indexes", () => {
    const dbPath = tempDbPath();
    createAuditedLegacyDatabase(dbPath);
    let sqlite = openSqlite(dbPath);
    try {
      bootstrapSchema(sqlite);
      insertArtifact(sqlite);
      insertLease(sqlite, "permit-live", "attempt-live");
      insertLease(
        sqlite,
        "permit-expired",
        "attempt-expired",
        "2026-06-30T23:58:00.000Z",
        "2026-06-30T23:59:00.000Z",
      );
    } finally {
      sqlite.close();
    }

    sqlite = openSqlite(dbPath);
    try {
      bootstrapSchema(sqlite);
      const persistedLease = sqlite.prepare(`
        SELECT "permitId", "reservedCostUsd", "acquiredAt", "leaseExpiresAt"
          FROM "job_llm_leases" WHERE "permitId" = 'permit-live'
      `).get() as {
        permitId: string;
        reservedCostUsd: number;
        acquiredAt: string;
        leaseExpiresAt: string;
      };
      const llmLease = {
        ...persistedLease,
        acquiredAt: Date.parse(persistedLease.acquiredAt),
        leaseExpiresAt: Date.parse(persistedLease.leaseExpiresAt),
      };
      expect(llmLease.permitId).toBe("permit-live");
      expect(llmLease.leaseExpiresAt).toBeGreaterThan(llmLease.acquiredAt);
      expect(llmLease.reservedCostUsd).toBe(MAXIMUM_PASS_COST_USD);
      expect(sqlite.prepare(`SELECT count(*) AS "count" FROM "job_pass_artifacts"`).get()).toEqual({ count: 1 });

      const indexMatrix = [
        ["jobs", "idx_jobs_active_symbol", 1, 1],
        ["jobs", "idx_jobs_queue_claim", 0, 0],
        ["jobs", "idx_jobs_lease_expiry", 0, 0],
        ["cost_log", "idx_cost_log_billed_attempt_pass", 1, 1],
        ["cost_log", "idx_cost_log_createdAt", 0, 0],
        ["job_pass_artifacts", "idx_job_pass_artifacts_job_generation", 0, 0],
        ["job_llm_leases", "idx_job_llm_leases_attempt_pass", 1, 0],
        ["job_llm_leases", "idx_job_llm_leases_expiry", 0, 0],
      ] as const;
      for (const [table, name, unique, partial] of indexMatrix) {
        expect(indexInfo(sqlite, table, name)).toEqual({ unique, partial });
      }

      const expired = sqlite.prepare(`
        SELECT "permitId" FROM "job_llm_leases" INDEXED BY "idx_job_llm_leases_expiry"
         WHERE "leaseExpiresAt" <= ? ORDER BY "leaseExpiresAt"
      `).all("2026-07-01T00:00:00.000Z");
      expect(expired).toEqual([{ permitId: "permit-expired" }]);
      expect(() => sqlite.prepare(`
        SELECT "id" FROM "jobs" INDEXED BY "idx_jobs_queue_claim"
         WHERE "status" = 'queued' AND "notBefore" IS NULL ORDER BY "queuedAt"
      `).all()).not.toThrow();
      expect(() => sqlite.prepare(`
        SELECT "id" FROM "jobs" INDEXED BY "idx_jobs_lease_expiry"
         WHERE "status" = 'running' AND "leaseExpiresAt" <= ?
      `).all("2026-07-01T00:00:00.000Z")).not.toThrow();
      expect(() => sqlite.prepare(`
        SELECT "jobId" FROM "job_pass_artifacts" INDEXED BY "idx_job_pass_artifacts_job_generation"
         WHERE "jobId" = 'legacy-job' AND "runGeneration" = 0 ORDER BY "settledAt"
      `).all()).not.toThrow();
      expect(() => sqlite.prepare(`
        SELECT "costUsd" FROM "cost_log" INDEXED BY "idx_cost_log_createdAt"
         WHERE "createdAt" >= ?
      `).all("2026-07-01T00:00:00.000Z")).not.toThrow();
    } finally {
      sqlite.close();
    }
  });

  it("increments revisions atomically with stale-writer fencing across connections", () => {
    const dbPath = tempDbPath();
    createAuditedLegacyDatabase(dbPath);
    const first = openSqlite(dbPath);
    const second = openSqlite(dbPath);
    try {
      bootstrapSchema(first);
      bootstrapSchema(second);
      const increment = (sqlite: Database.Database, expectedRevision: number) => sqlite.prepare(`
        UPDATE "jobs" SET "revision" = "revision" + 1
         WHERE "id" = 'legacy-job' AND "revision" = ?
      `).run(expectedRevision).changes;

      expect(increment(first, 0)).toBe(1);
      expect(increment(second, 0)).toBe(0);
      expect(increment(second, 1)).toBe(1);
      expect(first.prepare(`SELECT "revision" FROM "jobs" WHERE "id" = 'legacy-job'`).get()).toEqual({ revision: 2 });
    } finally {
      first.close();
      second.close();
    }
  });

  it("serializes concurrent legacy bootstraps without losing legacy data", async () => {
    const dbPath = tempDbPath();
    createAuditedLegacyDatabase(dbPath, "concurrent-legacy-job");
    const script = `
      const { default: Database } = await import("better-sqlite3");
      const { bootstrapSchema } = await import(${JSON.stringify(DB_MODULE_URL)});
      const sqlite = new Database(process.argv[1]);
      sqlite.pragma("busy_timeout = 5000");
      try { bootstrapSchema(sqlite); } finally { sqlite.close(); }
    `;
    const args = ["--conditions=react-server", "--import", "tsx", "--input-type=module", "--eval", script, dbPath];

    await Promise.all([
      execFileAsync(process.execPath, args, { cwd: ROOT, windowsHide: true }),
      execFileAsync(process.execPath, args, { cwd: ROOT, windowsHide: true }),
    ]);

    const sqlite = openSqlite(dbPath);
    try {
      bootstrapSchema(sqlite);
      expect(sqlite.prepare(`
        SELECT "symbol", "bullJson", "runGeneration", "revision"
          FROM "jobs" WHERE "id" = 'concurrent-legacy-job'
      `).get()).toEqual({
        symbol: "AAPL",
        bullJson: '{"legacy":true}',
        runGeneration: 0,
        revision: 0,
      });
      expect(sqlite.prepare(`SELECT "costUsd" FROM "cost_log" WHERE "jobId" = 'concurrent-legacy-job'`).get()).toEqual({ costUsd: 0.125 });
    } finally {
      sqlite.close();
    }
  }, 15_000);
});
