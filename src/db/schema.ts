/**
 * Drizzle SQLite schema for Thesis (the application contract §2: watchlist, reports, api_cache,
 * jobs, cost_log — plus settings).
 *
 * Conventions:
 * - All timestamps are ISO-8601 UTC strings (lexicographically sortable).
 * - JSON blobs are stored as TEXT (`*Json` columns); serialization happens at
 *   the call site (e.g. `stepsJson` holds a serialized `StepProgress[]` from
 *   src/types/core.ts, `reportJson` holds the full Report object).
 * - Status columns are free TEXT on purpose — the job/report modules own their
 *   lifecycle enums; the schema does not constrain them.
 *
 * This file must stay in sync with the raw DDL in src/db/index.ts
 * (bootstrapSchema) — the app bootstraps with CREATE TABLE IF NOT EXISTS and
 * needs no migration step.
 */

import "server-only";

import { blob, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Watchlist — one row per tracked ticker. */
export const watchlist = sqliteTable("watchlist", {
  symbol: text("symbol").primaryKey(),
  /** ISO timestamp when the symbol was added. */
  addedAt: text("addedAt").notNull(),
});

/** Saved reports, versioned by row (the application contract §8 report history + diffing). */
export const reports = sqliteTable(
  "reports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    symbol: text("symbol").notNull(),
    /** ISO timestamp when generation completed (or started, while running). */
    createdAt: text("createdAt").notNull(),
    /** Resolved Anthropic model id used for the analysis passes. */
    model: text("model").notNull(),
    /** Report lifecycle status (owned by the report module). */
    status: text("status").notNull(),
    /** Full Report object as JSON; null until synthesis completes. */
    reportJson: text("reportJson"),
    /** Verification pass: fraction of numeric claims traced (0..1). */
    verificationRate: real("verificationRate"),
    /** Actual API cost of generating this report, USD. */
    costUsd: real("costUsd"),
    /** Spec version the report was generated against (for diff semantics). */
    specVersion: text("specVersion"),
  },
  (t) => [index("idx_reports_symbol_createdAt").on(t.symbol, t.createdAt)],
);

/**
 * API response cache (the provider data contract §3): serve-stale-while-revalidate with
 * per-endpoint TTLs. `cacheKey` = provider|endpoint|stable-sorted-params-JSON
 * (see src/cache/apiCache.ts buildCacheKey).
 */
export const apiCache = sqliteTable(
  "api_cache",
  {
    cacheKey: text("cacheKey").primaryKey(),
    /** Provider id: fmp | edgar | finra | fred | finnhub | anthropic | computed */
    provider: text("provider").notNull(),
    endpoint: text("endpoint").notNull(),
    /** Stable-sorted JSON of the request params (same text used in the key). */
    paramsJson: text("paramsJson").notNull(),
    /** JSON-serialized response body; "" when the body lives in bodyGz. */
    bodyJson: text("bodyJson").notNull(),
    /** gzip of large JSON bodies (src/cache/compression.ts); null when plain. */
    bodyGz: blob("bodyGz", { mode: "buffer" }),
    /** ISO timestamp when we fetched the body. */
    fetchedAt: text("fetchedAt").notNull(),
    /** TTL recorded at write time (seconds); freshness checks use the caller's TTL. */
    ttlSeconds: integer("ttlSeconds").notNull(),
    /** ISO date the datum is "as of" (fiscal period end, quote time, ...). */
    asOf: text("asOf").notNull(),
  },
  (t) => [
    index("idx_api_cache_provider_endpoint").on(t.provider, t.endpoint),
    index("idx_api_cache_fetchedAt").on(t.fetchedAt),
  ],
);

/** Async report-generation jobs (the application contract §2: fetch → ... → verify, SSE-streamed). */
export const jobs = sqliteTable(
  "jobs",
  {
    /** Caller-supplied id (uuid). */
    id: text("id").primaryKey(),
    symbol: text("symbol").notNull(),
    /** Job lifecycle status (owned by the job module). */
    status: text("status").notNull(),
    /** Serialized StepProgress[] (src/types/core.ts). */
    stepsJson: text("stepsJson").notNull(),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
    /** Human-readable failure description; null while healthy. */
    error: text("error"),
    /** Set once the job produced a saved report. */
    reportId: integer("reportId").references(() => reports.id, {
      onDelete: "set null",
    }),
    /**
     * Persisted bull/bear pass snapshots (serialized PassResultLike<AnalystCase>,
     * src/pipeline/jobRunner.ts) written as each side completes, so a failed
     * synthesize can be retried WITHOUT re-billing the analyst passes.
     */
    bullJson: text("bullJson"),
    bearJson: text("bearJson"),
    /** payloadFingerprint at analyst-pass time — resume drift detection. */
    payloadFingerprint: text("payloadFingerprint"),
  },
  (t) => [index("idx_jobs_symbol").on(t.symbol), index("idx_jobs_status").on(t.status)],
);

/** Per-LLM-call cost ledger (the application contract §2/§5; fallback events logged here too). */
export const costLog = sqliteTable(
  "cost_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: text("jobId").notNull(),
    /** Pipeline step attribution (e.g. "bull" | "bear" | "synthesize" | "verify"). */
    step: text("step").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("inputTokens").notNull().default(0),
    outputTokens: integer("outputTokens").notNull().default(0),
    cacheReadTokens: integer("cacheReadTokens").notNull().default(0),
    cacheWriteTokens: integer("cacheWriteTokens").notNull().default(0),
    webSearches: integer("webSearches").notNull().default(0),
    costUsd: real("costUsd").notNull().default(0),
    /** 1 when a server-side refusal fallback model handled the request (SPEC §5). */
    fallbackUsed: integer("fallbackUsed", { mode: "boolean" }).notNull().default(false),
    createdAt: text("createdAt").notNull(),
  },
  (t) => [index("idx_cost_log_jobId").on(t.jobId)],
);

/** Key-value settings; values here override .env at read time (src/settings). */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// ---------------------------------------------------------------------------
// Inferred row types
// ---------------------------------------------------------------------------

export type WatchlistRow = typeof watchlist.$inferSelect;
export type NewWatchlistRow = typeof watchlist.$inferInsert;
export type ReportRow = typeof reports.$inferSelect;
export type NewReportRow = typeof reports.$inferInsert;
export type ApiCacheRow = typeof apiCache.$inferSelect;
export type NewApiCacheRow = typeof apiCache.$inferInsert;
export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
export type CostLogRow = typeof costLog.$inferSelect;
export type NewCostLogRow = typeof costLog.$inferInsert;
export type SettingRow = typeof settings.$inferSelect;
