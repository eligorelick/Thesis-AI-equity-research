/**
 * Tiny in-process typed pub/sub for job progress (the application contract §5 — SSE-streamed
 * generation progress). Single local user, single process: subscribers live in
 * a Map<jobId, Set<callback>> stashed on globalThis so Next.js dev hot-reloads
 * reuse the same bus instead of orphaning subscribers on a fresh module copy.
 *
 * Server-only: getJobSnapshot() reads the jobs table (imports @/db). The SSE
 * route replays a snapshot to late/reconnecting clients, then streams live
 * events until a terminal ("done" | "error") event arrives.
 */

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { costLog, jobs, reports } from "@/db/schema";
import { ReportSchema } from "@/report/schema";
import type { StepProgress } from "@/types/core";

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
  /** The step whose status just changed. */
  step: StepProgress;
  /** Full ordered StepProgress[] snapshot after this transition. */
  steps: StepProgress[];
}

/** Running cost update after an LLM pass logs to cost_log. */
export interface CostUpdateEvent {
  type: "cost-update";
  jobId: string;
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
  message: string;
}

export type JobEvent = StepUpdateEvent | CostUpdateEvent | JobDoneEvent | JobErrorEvent;

/** True for the two terminal event kinds (subscribers unsubscribe after these). */
export function isTerminalEvent(event: JobEvent): boolean {
  return event.type === "done" || event.type === "error";
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
}

/** Parse the persisted stepsJson defensively (never throw on a bad row). */
export function parseStepsJson(stepsJson: string): StepProgress[] {
  try {
    const parsed = JSON.parse(stepsJson) as unknown;
    return Array.isArray(parsed) ? (parsed as StepProgress[]) : [];
  } catch {
    return [];
  }
}

/**
 * Read the current persisted state of a job from the jobs table. Returns null
 * when no such job exists. Used by the SSE endpoint (replay-then-stream) and
 * the JSON polling-fallback endpoint.
 */
export function getJobSnapshot(jobId: string): JobSnapshot | null {
  const row = getDb()
    .select()
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .get();
  if (row === undefined) return null;

  const costRows = getDb()
    .select({ costUsd: costLog.costUsd })
    .from(costLog)
    .where(eq(costLog.jobId, jobId))
    .all();
  const loggedCostUsd = costRows.reduce((acc, r) => acc + r.costUsd, 0);

  let verificationRate: number | null = null;
  let totalCostUsd = loggedCostUsd;
  let dataOnly = false;
  if (row.reportId !== null) {
    const reportRow = getDb().select().from(reports).where(eq(reports.id, row.reportId)).get();
    if (reportRow !== undefined) {
      verificationRate = reportRow.verificationRate;
      totalCostUsd = reportRow.costUsd ?? loggedCostUsd;
      dataOnly = reportJsonIsDataOnly(reportRow.reportJson);
    }
  }

  return {
    jobId: row.id,
    symbol: row.symbol,
    status: row.status,
    steps: parseStepsJson(row.stepsJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    error: row.error,
    reportId: row.reportId,
    verificationRate,
    totalCostUsd,
    dataOnly,
  };
}

function reportJsonIsDataOnly(reportJson: string | null): boolean {
  if (reportJson === null) return false;
  try {
    const parsed = ReportSchema.safeParse(JSON.parse(reportJson));
    return parsed.success
      ? parsed.data.appendix.missingData.some((m) => m.field === "analysis.llm")
      : false;
  } catch {
    return false;
  }
}
