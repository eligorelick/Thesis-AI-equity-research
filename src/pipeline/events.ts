/**
 * Process-local postcommit invalidation hints for job progress. Subscribers
 * live in a global Map so dev hot reloads do not orphan them, but the database
 * revisioned JobSnapshot is the only wire truth: SSE re-reads it after hints
 * and also polls so commits from other processes cannot be missed.
 *
 * Server-only: getJobSnapshot() reads one coherent jobs/cost/report/resume
 * transaction. Typed events remain diagnostics/hints and are never trusted as
 * terminal or financial payloads by the stream route.
 */

import { eq } from "drizzle-orm";
import { getDb, type ThesisDb } from "@/db";
import { costLog, jobLlmLeases, jobs, reports } from "@/db/schema";
import { readStoredJobResumeInTransaction } from "@/pipeline/jobStore";
import { assertSafeJobRevision } from "@/pipeline/jobState";
import { parseCanonicalJobSteps } from "@/pipeline/jobSteps";
import { ReportSchema, withLenientLegacyRead } from "@/report/schema";
import type { StepProgress } from "@/types/core";
import type { UnsupportedInstrumentKind } from "@/pipeline/stageB/instrumentSupport";

/* ------------------------------------------------------------------------ *
 * Event types
 * ------------------------------------------------------------------------ */

/**
 * A single step transition (StepProgress plus the full ordered step list so a
 * subscriber can render the whole strip from one event).
 */
export interface StepUpdateEvent {
  type: "step-update";
  jobId: string;
  /** Committed canonical snapshot revision; payload is only an invalidation hint. */
  revision: number;
  /** The step whose status just changed. */
  step: StepProgress;
  /** Full ordered StepProgress[] snapshot after this transition. */
  steps: StepProgress[];
}

/** Running cost update after an LLM pass logs to cost_log. */
export interface CostUpdateEvent {
  type: "cost-update";
  jobId: string;
  revision: number;
  /** Pipeline step the cost is attributed to. */
  step: string;
  /** Cost of this pass, USD. */
  passCostUsd: number;
  /** Running total across the job so far, USD. */
  totalCostUsd: number;
}

/** Terminal success — the report is persisted. */
export interface JobDoneEvent {
  type: "done";
  jobId: string;
  revision: number;
  /** reports.id of the persisted report (null for a data-only stub with no row). */
  reportId: number | null;
  /** Fraction of traceable numbers verified (null when verify did not run). */
  verificationRate: number | null;
  totalCostUsd: number;
  /** True when the LLM steps were skipped (no key) — a data-only report. */
  dataOnly: boolean;
}

/** Terminal failure — the job could not complete. */
export interface JobErrorEvent {
  type: "error";
  jobId: string;
  revision: number;
  message: string;
}

/** Terminal non-error outcome — company analysis does not support this instrument. */
export interface JobUnsupportedEvent {
  type: "unsupported";
  jobId: string;
  revision: number;
  kind: UnsupportedInstrumentKind;
  message: string;
  totalCostUsd: number;
}

export type JobEvent =
  | StepUpdateEvent
  | CostUpdateEvent
  | JobDoneEvent
  | JobErrorEvent
  | JobUnsupportedEvent;

/** True for every terminal event kind (subscribers unsubscribe after these). */
export function isTerminalEvent(event: JobEvent): boolean {
  return event.type === "done" || event.type === "error" || event.type === "unsupported";
}

export type JobEventCallback = (event: JobEvent) => void;

/* ------------------------------------------------------------------------ *
 * Hot-reload-safe subscriber bus (globalThis stash)
 * ------------------------------------------------------------------------ */

interface JobEventBus {
  subscribers: Map<string, Set<JobEventCallback>>;
}

const globalWithBus = globalThis as typeof globalThis & {
  __thesisJobEventBus?: JobEventBus;
};

function bus(): JobEventBus {
  if (!globalWithBus.__thesisJobEventBus) {
    globalWithBus.__thesisJobEventBus = { subscribers: new Map() };
  }
  return globalWithBus.__thesisJobEventBus;
}

/**
 * Subscribe to events for a job. Returns an unsubscribe function; call it on
 * client disconnect (SSE AbortSignal) so the Set doesn't leak callbacks.
 */
export function subscribeJob(jobId: string, cb: JobEventCallback): () => void {
  const { subscribers } = bus();
  let set = subscribers.get(jobId);
  if (set === undefined) {
    set = new Set();
    subscribers.set(jobId, set);
  }
  set.add(cb);
  return () => {
    const current = subscribers.get(jobId);
    if (current === undefined) return;
    current.delete(cb);
    if (current.size === 0) subscribers.delete(jobId);
  };
}

/**
 * Publish an event to every current subscriber of the job. A throwing callback
 * never blocks the others or the runner (isolated per-subscriber). No-op when
 * nobody is listening (the runner still persists everything to the jobs row,
 * so late subscribers catch up via getJobSnapshot()).
 */
export function publishJobEvent(event: JobEvent): void {
  assertSafeJobRevision(event.revision);
  const set = bus().subscribers.get(event.jobId);
  if (set === undefined || set.size === 0) return;
  // Copy so an unsubscribe during iteration can't mutate the live Set.
  for (const cb of [...set]) {
    try {
      cb(event);
    } catch (err) {
      // A bad subscriber must never break the job or the other subscribers.
      console.warn(`publishJobEvent: subscriber threw for job ${event.jobId}:`, err);
    }
  }
}

/** TEST/maintenance: number of live subscribers for a job (0 when none). */
export function subscriberCount(jobId: string): number {
  return bus().subscribers.get(jobId)?.size ?? 0;
}

/** TEST hook: drop every subscriber (prevents cross-test leakage). */
export function _clearJobSubscribers(): void {
  bus().subscribers.clear();
}

/* ------------------------------------------------------------------------ *
 * Snapshot (late subscribers / polling fallback / reconnect replay)
 * ------------------------------------------------------------------------ */

export interface JobSnapshot {
  jobId: string;
  revision: number;
  symbol: string;
  status: string;
  steps: StepProgress[];
  createdAt: string;
  updatedAt: string;
  error: string | null;
  reportId: number | null;
  verificationRate: number | null;
  totalCostUsd: number;
  dataOnly: boolean;
  resumable: boolean;
  /** Terminal truth can still receive an immutable paid-pass settlement. */
  settlementsPending: boolean;
  unsupported: { kind: UnsupportedInstrumentKind; message: string } | null;
}

/** Parse the persisted stepsJson defensively (never throw on a bad row). */
export function parseStepsJson(stepsJson: string, allowTerminalSubset = false): StepProgress[] {
  return parseCanonicalJobSteps(stepsJson, { allowTerminalSubset }) ?? [];
}

/**
 * Read the current persisted state of a job from the jobs table. Returns null
 * when no such job exists. Used by the SSE endpoint (replay-then-stream) and
 * the JSON polling-fallback endpoint.
 */
export function getJobSnapshot(jobId: string): JobSnapshot | null {
  return getDb().transaction((tx): JobSnapshot | null => {
    const db = tx as ThesisDb;
    const row = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (row === undefined) return null;
    assertSafeJobRevision(row.revision);

    const costRows = db.select({ costUsd: costLog.costUsd })
      .from(costLog)
      .where(eq(costLog.jobId, jobId))
      .all();
    const loggedCostUsd = costRows.reduce((acc, cost) => acc + cost.costUsd, 0);
    let verificationRate: number | null = null;
    let legacyReportCostUsd: number | null = null;
    let dataOnly = false;
    if (row.reportId !== null) {
      const reportRow = db.select().from(reports).where(eq(reports.id, row.reportId)).get();
      if (reportRow !== undefined) {
        verificationRate = reportRow.verificationRate;
        legacyReportCostUsd = reportRow.costUsd;
        dataOnly = reportJsonIsDataOnly(reportRow.reportJson);
      }
    }
    const resume = readStoredJobResumeInTransaction(db, jobId);
    const terminal = row.status === "done" || row.status === "error" ||
      row.status === "unsupported" || row.status === "canceled";
    // Retained rows, including expired rows not yet pruned by the scheduler,
    // are durable pending-settlement truth. Never derive this wire field from
    // wall clock: pruning/deletion commits the revision that changes it.
    const settlementsPending = terminal && db.select({ permitId: jobLlmLeases.permitId })
      .from(jobLlmLeases)
      .where(eq(jobLlmLeases.jobId, jobId))
      .limit(1)
      .get() !== undefined;

    return {
      jobId: row.id,
      revision: row.revision,
      symbol: row.symbol,
      status: row.status,
      steps: parseStepsJson(
        row.stepsJson,
        row.status === "done" || row.status === "error" ||
          row.status === "unsupported" || row.status === "canceled",
      ),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      error: row.error,
      reportId: row.reportId,
      verificationRate,
      totalCostUsd: costRows.length > 0 ? loggedCostUsd : (legacyReportCostUsd ?? 0),
      dataOnly,
      resumable: resume?.plan.state.resumable ?? false,
      settlementsPending,
      unsupported:
        row.status === "unsupported" &&
        (row.unsupportedKind === "etf" ||
          row.unsupportedKind === "fund" ||
          row.unsupportedKind === "etf-fund") &&
        typeof row.unsupportedMessage === "string" &&
        row.unsupportedMessage.trim().length > 0
          ? { kind: row.unsupportedKind, message: row.unsupportedMessage }
          : null,
    };
  });
}

/** Lightweight existence probe used before allocating an SSE stream. */
export function jobExists(jobId: string): boolean {
  return getDb().select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId)).get() !== undefined;
}

export function reportJsonIsDataOnly(reportJson: string | null): boolean {
  if (reportJson === null) return false;
  try {
    const raw = JSON.parse(reportJson);
    const parsed = ReportSchema.safeParse(raw);
    if (parsed.success) return parsed.data.appendix.missingData.some((m) => m.field === "analysis.llm");
    const legacy = withLenientLegacyRead(() => ReportSchema.safeParse(raw));
    return legacy.success && legacy.data.appendix.missingData.some((m) => m.field === "analysis.llm");
  } catch {
    return false;
  }
}
