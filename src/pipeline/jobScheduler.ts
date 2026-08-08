/** Durable SQLite job/paid-pass scheduler. All authority is a fresh nonce. */
import "server-only";

import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  eq,
  gt,
  gte,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { getDb, type ThesisDb } from "@/db";
import { getConfig } from "@/config/env";
import {
  costLog,
  jobLlmLeases,
  jobPassArtifacts,
  jobs,
  reports,
} from "@/db/schema";
import {
  persistPassSettlementInTransaction,
  preparePassSettlement,
  type DurablePass,
  type PassSettlement,
  type PersistPassSettlementResult,
} from "@/pipeline/jobArtifacts";
import {
  prepareQueuedJobResumeInTransaction,
  queuedResumeSourceMatchesInTransaction,
  type PipelinePasses,
  type PreparedJobResume,
} from "@/pipeline/jobRunner";
import type { StepProgress } from "@/types/core";

const MICRO_USD = 1_000_000;
const MAX_SAFE_MICRO_USD = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_ROLLING_WINDOW_MS = 52_560_000 * 60_000;
const SCHEDULER_RETRY_DELAY_MS = 1_000;

export interface SchedulerLimits {
  maxActiveJobs: number;
  maxActiveLlmCalls: number;
  maxRollingCostUsd: number | null;
  rollingCostWindowMs: number;
  paidPassLeaseTtlMs: number;
  jobLeaseTtlMs: number;
}

export function configuredSchedulerLimits(): SchedulerLimits {
  const config = getConfig();
  return {
    maxActiveJobs: config.maxActiveJobs,
    maxActiveLlmCalls: config.maxActiveLlmCalls,
    maxRollingCostUsd: config.maxRollingCostUsd,
    rollingCostWindowMs: config.rollingCostWindowMs,
    paidPassLeaseTtlMs: config.paidPassLeaseTtlMs,
    jobLeaseTtlMs: config.jobLeaseTtlMs,
  };
}

export interface JobClaim {
  jobId: string;
  symbol: string;
  runGeneration: number;
  revision: number;
  leaseOwner: string;
  heartbeatAt: string;
  leaseExpiresAt: string;
  preparedResume: PreparedJobResume | null;
}

export type ClaimedJob = JobClaim;

export interface PaidPassLease {
  permitId: string;
  jobId: string;
  runGeneration: number;
  attemptId: string;
  pass: DurablePass;
  leaseOwner: string;
  jobLeaseOwner: string;
  reservedCostUsd: number;
  acquiredAt: string;
  leaseExpiresAt: string;
}

export type PaidPassAcquireResult =
  | { acquired: true; lease: PaidPassLease }
  | {
      acquired: false;
      reason:
        | "capacity"
        | "job-budget"
        | "job-budget-pending"
        | "rolling-budget"
        | "rolling-budget-pending";
    };

export type SchedulerPassResolver = () => Promise<PipelinePasses>;

export interface SchedulerKickOptions {
  /** Deterministic test seam; production always reads the validated config. */
  limits?: SchedulerLimits;
  /** Test-only execution seam; production dynamically imports runJob. */
  runClaim?: (
    claim: ClaimedJob,
    resolver: SchedulerPassResolver,
    limits: SchedulerLimits,
  ) => Promise<void>;
  now?: () => Date;
  workerId?: string;
}

interface SchedulerPumpState {
  resolver: SchedulerPassResolver | null;
  options: SchedulerKickOptions;
  scheduled: boolean;
  pumping: boolean;
  epoch: number;
  wakeTimer: ReturnType<typeof setTimeout> | null;
  wakeAtMs: number | null;
  failedClaims: Map<string, ClaimedJob>;
}

const SCHEDULER_PUMP_KEY = Symbol.for("thesis.jobScheduler.pump.v1");

function schedulerPumpState(): SchedulerPumpState {
  const root = globalThis as typeof globalThis & {
    [SCHEDULER_PUMP_KEY]?: SchedulerPumpState;
  };
  root[SCHEDULER_PUMP_KEY] ??= {
    resolver: null,
    options: {},
    scheduled: false,
    pumping: false,
    epoch: 0,
    wakeTimer: null,
    wakeAtMs: null,
    failedClaims: new Map(),
  };
  const state = root[SCHEDULER_PUMP_KEY];
  // Hot reload can preserve the previous object shape across this module's
  // introduction of durable wake metadata.
  state.wakeTimer ??= null;
  state.wakeAtMs ??= null;
  state.failedClaims ??= new Map();
  return state;
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`jobScheduler: ${label} must be a positive safe integer`);
  }
}

function assertLimits(limits: SchedulerLimits): void {
  assertPositiveSafeInteger(limits.maxActiveJobs, "maxActiveJobs");
  assertPositiveSafeInteger(limits.maxActiveLlmCalls, "maxActiveLlmCalls");
  assertPositiveSafeInteger(limits.rollingCostWindowMs, "rollingCostWindowMs");
  assertPositiveSafeInteger(limits.paidPassLeaseTtlMs, "paidPassLeaseTtlMs");
  assertPositiveSafeInteger(limits.jobLeaseTtlMs, "jobLeaseTtlMs");
  if (limits.paidPassLeaseTtlMs > MAX_TIMER_DELAY_MS) {
    throw new Error("jobScheduler: paidPassLeaseTtlMs exceeds the executable timer range");
  }
  if (limits.jobLeaseTtlMs > MAX_TIMER_DELAY_MS) {
    throw new Error("jobScheduler: jobLeaseTtlMs exceeds the executable timer range");
  }
  if (limits.rollingCostWindowMs > MAX_ROLLING_WINDOW_MS) {
    throw new Error("jobScheduler: rollingCostWindowMs exceeds the supported Date range");
  }
  if (
    limits.maxRollingCostUsd !== null &&
    (!Number.isFinite(limits.maxRollingCostUsd) || limits.maxRollingCostUsd < 0)
  ) {
    throw new Error("jobScheduler: maxRollingCostUsd must be null or a finite nonnegative value");
  }
}

function authorityDate(injected: Date | undefined, label: string): Date {
  const value = injected ?? new Date();
  if (!Number.isFinite(value.getTime())) {
    throw new Error(`jobScheduler: ${label} time is invalid`);
  }
  return value;
}

function nonce(label: string): string {
  const safe = label.trim().length > 0 ? label.trim() : "worker";
  return `${safe}:${randomUUID()}`;
}

function normalizeTerminalSteps(raw: string, message: string, at: string): string {
  try {
    const steps = JSON.parse(raw) as StepProgress[];
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

function sameNullable(column: typeof jobs.leaseOwner | typeof jobs.leaseExpiresAt, value: string | null) {
  return value === null ? isNull(column) : eq(column, value);
}

function pruneExpiredPaidLeases(db: ThesisDb, nowIso: string): number {
  return db.delete(jobLlmLeases).where(lte(jobLlmLeases.leaseExpiresAt, nowIso)).run().changes;
}

function reconcileExpiredJobClaimsInTransaction(db: ThesisDb, nowIso: string): number {
  const abandoned = db
    .select()
    .from(jobs)
    .where(and(
      eq(jobs.status, "running"),
      or(
        isNull(jobs.leaseOwner),
        isNull(jobs.leaseExpiresAt),
        lte(jobs.leaseExpiresAt, nowIso),
      ),
    ))
    .all();
  let changed = 0;
  for (const row of abandoned) {
    const message = row.leaseOwner === null || row.leaseExpiresAt === null
      ? "abandoned: running job has no durable lease"
      : "abandoned: durable job lease expired";
    changed += db.update(jobs)
      .set({
        status: "error",
        error: message,
        stepsJson: normalizeTerminalSteps(row.stepsJson, message, nowIso),
        unsupportedKind: null,
        unsupportedMessage: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        updatedAt: nowIso,
        revision: row.revision + 1,
      })
      .where(and(
        eq(jobs.id, row.id),
        eq(jobs.status, "running"),
        eq(jobs.runGeneration, row.runGeneration),
        eq(jobs.revision, row.revision),
        sameNullable(jobs.leaseOwner, row.leaseOwner),
        sameNullable(jobs.leaseExpiresAt, row.leaseExpiresAt),
      ))
      .run().changes;
  }
  return changed;
}

/**
 * Reconcile scheduler-owned expiry state inside an already-acquired writer
 * transaction. Callers must sample `now` only after BEGIN IMMEDIATE succeeds.
 */
export function reconcileExpiredSchedulerStateInTransaction(
  db: ThesisDb,
  now: Date,
): number {
  const nowIso = authorityDate(now, "scheduler-state reconciliation").toISOString();
  pruneExpiredPaidLeases(db, nowIso);
  return reconcileExpiredJobClaimsInTransaction(db, nowIso);
}

/** Reconcile only missing/expired durable running claims; updatedAt is irrelevant. */
export function reconcileExpiredJobClaims(
  now: Date | undefined = undefined,
  db: ThesisDb = getDb(),
): number {
  return db.transaction((tx) => {
    return reconcileExpiredSchedulerStateInTransaction(
      tx as ThesisDb,
      authorityDate(now, "job-claim reconciliation"),
    );
  }, { behavior: "immediate" });
}

/** Shared exact claim primitive; callers choose oldest-due or a specific id. */
function claimQueuedJobInternal(
  workerId: string,
  now: Date | undefined,
  limits: SchedulerLimits,
  db: ThesisDb,
  onlyJobId?: string,
): ClaimedJob | null {
  assertLimits(limits);
  return db.transaction((tx): ClaimedJob | null => {
    const authority = authorityDate(now, "job claim");
    const nowIso = authority.toISOString();
    pruneExpiredPaidLeases(tx as ThesisDb, nowIso);
    reconcileExpiredJobClaimsInTransaction(tx as ThesisDb, nowIso);

    const running = tx
      .select({ count: sql<number>`count(*)` })
      .from(jobs)
      .where(eq(jobs.status, "running"))
      .get()?.count ?? 0;
    if (running >= limits.maxActiveJobs) return null;

    const candidates = tx
      .select()
      .from(jobs)
      .where(and(
        eq(jobs.status, "queued"),
        or(isNull(jobs.notBefore), lte(jobs.notBefore, nowIso)),
        onlyJobId === undefined ? undefined : eq(jobs.id, onlyJobId),
      ))
      .orderBy(
        asc(sql`COALESCE(${jobs.queuedAt}, ${jobs.createdAt})`),
        asc(jobs.createdAt),
        asc(jobs.id),
      )
      .all();

    for (const row of candidates) {
      let preparedResume: PreparedJobResume | null = null;
      if (row.runGeneration > 0) {
        const linked = row.reportId === null
          ? undefined
          : tx.select({ id: reports.id }).from(reports).where(eq(reports.id, row.reportId)).get();
        if (linked !== undefined) {
          tx.update(jobs)
            .set({
              status: "done",
              error: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              updatedAt: nowIso,
              revision: row.revision + 1,
            })
            .where(and(
              eq(jobs.id, row.id),
              eq(jobs.status, "queued"),
              eq(jobs.runGeneration, row.runGeneration),
              eq(jobs.revision, row.revision),
            ))
            .run();
          continue;
        }
        preparedResume = prepareQueuedJobResumeInTransaction(tx, row.id);
        if (preparedResume === null) {
          const message = "queued retry has no coherent durable source plan";
          tx.update(jobs)
            .set({
              status: "error",
              error: message,
              stepsJson: normalizeTerminalSteps(row.stepsJson, message, nowIso),
              leaseOwner: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              updatedAt: nowIso,
              revision: row.revision + 1,
            })
            .where(and(
              eq(jobs.id, row.id),
              eq(jobs.status, "queued"),
              eq(jobs.runGeneration, row.runGeneration),
              eq(jobs.revision, row.revision),
            ))
            .run();
          continue;
        }
        const sourceLease = tx
          .select({ permitId: jobLlmLeases.permitId })
          .from(jobLlmLeases)
          .where(and(
            eq(jobLlmLeases.jobId, row.id),
            // A canceled queued retry may still represent an older paid
            // cohort. Any live ancestor permit can settle into that lineage,
            // so none may overlap the new target generation.
            lt(jobLlmLeases.runGeneration, row.runGeneration),
            gt(jobLlmLeases.leaseExpiresAt, nowIso),
          ))
          .get();
        if (sourceLease !== undefined) continue;
      }

      const leaseOwner = nonce(workerId);
      const leaseExpiresAt = new Date(authority.getTime() + limits.jobLeaseTtlMs).toISOString();
      // The savepoint makes even trigger-driven source changes harmless: if
      // the post-claim digest differs, roll the claim and its side effects
      // back before terminalizing the still-queued target generation.
      tx.run(sql.raw("SAVEPOINT scheduler_job_claim"));
      const claimed = tx.update(jobs)
        .set({
          status: "running",
          error: null,
          unsupportedKind: null,
          unsupportedMessage: null,
          leaseOwner,
          heartbeatAt: nowIso,
          leaseExpiresAt,
          updatedAt: nowIso,
          revision: row.revision + 1,
        })
        .where(and(
          eq(jobs.id, row.id),
          eq(jobs.status, "queued"),
          eq(jobs.runGeneration, row.runGeneration),
          eq(jobs.revision, row.revision),
        ))
        .run();
      if (claimed.changes !== 1) {
        tx.run(sql.raw("ROLLBACK TO scheduler_job_claim"));
        tx.run(sql.raw("RELEASE scheduler_job_claim"));
        continue;
      }
      if (
        preparedResume !== null &&
        !queuedResumeSourceMatchesInTransaction(tx, preparedResume)
      ) {
        tx.run(sql.raw("ROLLBACK TO scheduler_job_claim"));
        tx.run(sql.raw("RELEASE scheduler_job_claim"));
        const message = "queued retry source artifact digest changed before dispatch";
        tx.update(jobs)
          .set({
            status: "error",
            error: message,
            stepsJson: normalizeTerminalSteps(row.stepsJson, message, nowIso),
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            updatedAt: nowIso,
            revision: row.revision + 1,
          })
          .where(and(
            eq(jobs.id, row.id),
            eq(jobs.status, "queued"),
            eq(jobs.runGeneration, row.runGeneration),
            eq(jobs.revision, row.revision),
          ))
          .run();
        continue;
      }
      tx.run(sql.raw("RELEASE scheduler_job_claim"));
      return {
        jobId: row.id,
        symbol: row.symbol,
        runGeneration: row.runGeneration,
        revision: row.revision + 1,
        leaseOwner,
        heartbeatAt: nowIso,
        leaseExpiresAt,
        preparedResume,
      };
    }
    return null;
  }, { behavior: "immediate" });
}

/** Claim the oldest due row under one BEGIN IMMEDIATE transaction. */
export function claimNextQueuedJob(
  workerId: string,
  now: Date | undefined,
  limits: SchedulerLimits,
  db: ThesisDb = getDb(),
): ClaimedJob | null {
  return claimQueuedJobInternal(workerId, now, limits, db);
}

/** Compatibility/direct-run seam that uses the same durable claim transaction. */
export function claimQueuedJobById(
  jobId: string,
  workerId: string,
  now: Date | undefined,
  limits: SchedulerLimits,
  db: ThesisDb = getDb(),
): ClaimedJob | null {
  return claimQueuedJobInternal(workerId, now, limits, db, jobId);
}

export function renewJobLease(
  claim: JobClaim,
  now: Date | undefined,
  limits: SchedulerLimits,
  db: ThesisDb = getDb(),
): boolean {
  assertLimits(limits);
  return db.transaction((tx): boolean => {
    const authority = authorityDate(now, "job-lease renewal");
    const nowIso = authority.toISOString();
    const leaseExpiresAt = new Date(authority.getTime() + limits.jobLeaseTtlMs).toISOString();
    return tx.update(jobs)
      .set({ heartbeatAt: nowIso, leaseExpiresAt })
      .where(and(
        eq(jobs.id, claim.jobId),
        eq(jobs.runGeneration, claim.runGeneration),
        eq(jobs.status, "running"),
        eq(jobs.leaseOwner, claim.leaseOwner),
        gt(jobs.leaseExpiresAt, nowIso),
      ))
      .run().changes === 1;
  }, { behavior: "immediate" });
}

export function terminalizeClaim(
  claim: JobClaim,
  status: "done" | "error" | "unsupported",
  message: string | null,
  now: Date | undefined,
  db: ThesisDb = getDb(),
): boolean {
  return db.transaction((tx): boolean => {
    const authorityAt = authorityDate(now, "claim terminalization").toISOString();
    const row = tx.select().from(jobs).where(and(
      eq(jobs.id, claim.jobId),
      eq(jobs.runGeneration, claim.runGeneration),
      eq(jobs.status, "running"),
      eq(jobs.leaseOwner, claim.leaseOwner),
      gt(jobs.leaseExpiresAt, authorityAt),
    )).get();
    if (row === undefined) return false;
    return tx.update(jobs)
      .set({
        status,
        error: status === "error" ? (message ?? "job failed") : null,
        stepsJson: status === "error"
          ? normalizeTerminalSteps(row.stepsJson, message ?? "job failed", authorityAt)
          : row.stepsJson,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        updatedAt: authorityAt,
        revision: row.revision + 1,
      })
      .where(and(
        eq(jobs.id, claim.jobId),
        eq(jobs.runGeneration, claim.runGeneration),
        eq(jobs.revision, row.revision),
        eq(jobs.status, "running"),
        eq(jobs.leaseOwner, claim.leaseOwner),
        gt(jobs.leaseExpiresAt, authorityAt),
      ))
      .run().changes === 1;
  }, { behavior: "immediate" });
}

async function terminalizeSchedulerExecutionFailure(
  claim: ClaimedJob,
  message: string,
  now?: Date,
): Promise<void> {
  if (!terminalizeClaim(claim, "error", message, now)) return;
  const { publishJobEvent } = await import("@/pipeline/events");
  publishJobEvent({ type: "error", jobId: claim.jobId, message });
}

async function executeClaim(
  claim: ClaimedJob,
  resolver: SchedulerPassResolver,
  limits: SchedulerLimits,
  now?: () => Date,
): Promise<void> {
  let passes: PipelinePasses;
  try {
    passes = await resolver();
  } catch {
    await terminalizeSchedulerExecutionFailure(
      claim,
      "scheduler pass resolution failed before execution",
      now?.(),
    );
    return;
  }

  try {
    // Dynamic import avoids making the runner/scheduler cycle choose execution
    // authority during module initialization. The exact claim is handed in;
    // runJob never performs a second queued transition.
    const { runJob } = await import("@/pipeline/jobRunner");
    await runJob(claim.jobId, passes, {
      claim,
      schedulerLimits: limits,
      resume: claim.runGeneration > 0,
    });
  } catch {
    await terminalizeSchedulerExecutionFailure(
      claim,
      "scheduler execution failed unexpectedly",
      now?.(),
    );
  }
}

function requestPump(state: SchedulerPumpState): void {
  clearDurableWake(state);
  state.epoch += 1;
  if (state.scheduled || state.pumping || state.resolver === null) return;
  state.scheduled = true;
  queueMicrotask(() => {
    state.scheduled = false;
    void pumpQueuedJobs(state).catch(() => {
      // A transient writer lock or filesystem error must not strand the only
      // durable queued row. Retry once per bounded timer; SQLite claims still
      // provide correctness and a later success recomputes the exact next wake.
      schedulePumpRetry(state);
    });
  });
}

function clearDurableWake(state: SchedulerPumpState): void {
  if (state.wakeTimer !== null) clearTimeout(state.wakeTimer);
  state.wakeTimer = null;
  state.wakeAtMs = null;
}

function earliestDurableWake(now: Date, db: ThesisDb = getDb()): number | null {
  const nowIso = now.toISOString();
  const dueQueue = db.select({ id: jobs.id })
    .from(jobs)
    .where(and(
      eq(jobs.status, "queued"),
      or(isNull(jobs.notBefore), lte(jobs.notBefore, nowIso)),
    ))
    .get();
  const expiredJobClaim = db.select({ id: jobs.id })
    .from(jobs)
    .where(and(
      eq(jobs.status, "running"),
      or(isNull(jobs.leaseExpiresAt), lte(jobs.leaseExpiresAt, nowIso)),
    ))
    .get();
  const expiredPaidLease = db.select({ permitId: jobLlmLeases.permitId })
    .from(jobLlmLeases)
    .where(lte(jobLlmLeases.leaseExpiresAt, nowIso))
    .get();
  // This also closes the T1/T2 boundary: a row can become actionable after the
  // claim transaction sampled T1 but before this read samples T2. Keep one
  // bounded cross-process poll while due work is blocked by another owner.
  const boundedPollAt =
    dueQueue !== undefined || expiredJobClaim !== undefined || expiredPaidLease !== undefined
      ? now.getTime() + SCHEDULER_RETRY_DELAY_MS
      : null;
  const futureQueue = db.select({ at: jobs.notBefore })
    .from(jobs)
    .where(and(eq(jobs.status, "queued"), gt(jobs.notBefore, nowIso)))
    .orderBy(asc(jobs.notBefore))
    .get()?.at;
  const liveJobClaim = db.select({ at: jobs.leaseExpiresAt })
    .from(jobs)
    .where(and(eq(jobs.status, "running"), gt(jobs.leaseExpiresAt, nowIso)))
    .orderBy(asc(jobs.leaseExpiresAt))
    .get()?.at;
  const livePaidLease = db.select({ at: jobLlmLeases.leaseExpiresAt })
    .from(jobLlmLeases)
    .where(gt(jobLlmLeases.leaseExpiresAt, nowIso))
    .orderBy(asc(jobLlmLeases.leaseExpiresAt))
    .get()?.at;
  const durableTimes = [futureQueue, liveJobClaim, livePaidLease]
    .filter((value): value is string => typeof value === "string")
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value) && value > now.getTime());
  const times = boundedPollAt === null ? durableTimes : [boundedPollAt, ...durableTimes];
  return times.length === 0 ? null : Math.min(...times);
}

function armDurableWake(state: SchedulerPumpState, wakeAtMs: number, nowMs: number): void {
  if (state.wakeTimer !== null && state.wakeAtMs !== null && state.wakeAtMs <= wakeAtMs) return;
  clearDurableWake(state);
  const delayMs = Math.max(1, Math.min(MAX_TIMER_DELAY_MS, wakeAtMs - nowMs));
  state.wakeAtMs = wakeAtMs;
  state.wakeTimer = setTimeout(() => {
    state.wakeTimer = null;
    state.wakeAtMs = null;
    requestPump(state);
  }, delayMs);
  state.wakeTimer.unref?.();
}

function scheduleDurableWake(state: SchedulerPumpState, now: Date): void {
  if (state.resolver === null) {
    clearDurableWake(state);
    return;
  }
  const wakeAtMs = earliestDurableWake(now);
  if (wakeAtMs === null) {
    clearDurableWake(state);
    return;
  }
  armDurableWake(state, wakeAtMs, now.getTime());
}

function schedulePumpRetry(state: SchedulerPumpState): void {
  if (state.resolver === null) return;
  const now = (state.options.now ?? (() => new Date()))();
  armDurableWake(
    state,
    now.getTime() + SCHEDULER_RETRY_DELAY_MS,
    now.getTime(),
  );
}

async function pumpQueuedJobs(state: SchedulerPumpState): Promise<void> {
  if (state.pumping || state.resolver === null) return;
  const resolver = state.resolver;
  const options = state.options;
  const limits = options.limits ?? configuredSchedulerLimits();
  const now = options.now ?? (() => new Date());
  const workerId = options.workerId ?? `scheduler-${process.pid}`;
  const runClaim = options.runClaim ?? ((claim, selectedResolver, selectedLimits) =>
    executeClaim(claim, selectedResolver, selectedLimits, options.now));
  state.pumping = true;
  const startedEpoch = state.epoch;
  try {
    for (const [key, failedClaim] of state.failedClaims) {
      await terminalizeSchedulerExecutionFailure(
        failedClaim,
        "scheduler execution failed unexpectedly",
        options.now?.(),
      );
      state.failedClaims.delete(key);
    }
    for (;;) {
      const claim = claimNextQueuedJob(workerId, options.now?.(), limits);
      if (claim === null) break;
      void Promise.resolve(runClaim(claim, resolver, limits)).then(
        () => requestPump(state),
        () => {
          state.failedClaims.set(
            `${claim.jobId}:${claim.runGeneration}:${claim.leaseOwner}`,
            // Terminalization needs only exact claim identity. Do not retain a
            // potentially large retry plan while a transient database fault is
            // waiting for its bounded reconciliation retry.
            { ...claim, preparedResume: null },
          );
          requestPump(state);
        },
      );
    }
  } finally {
    state.pumping = false;
    if (state.epoch !== startedEpoch) requestPump(state);
    else scheduleDurableWake(state, now());
  }
}

/** Notify the process-local pump; durable SQLite claims provide correctness. */
export function kickJobScheduler(
  resolver: SchedulerPassResolver,
  options: SchedulerKickOptions = {},
): void {
  const state = schedulerPumpState();
  state.resolver = resolver;
  state.options = options;
  requestPump(state);
}

/** Test isolation only; never used by production routes. */
export function _resetJobSchedulerForTests(): void {
  const state = schedulerPumpState();
  clearDurableWake(state);
  state.resolver = null;
  state.options = {};
  state.scheduled = false;
  state.pumping = false;
  state.failedClaims.clear();
  state.epoch += 1;
}

function decimalMicroUsd(value: number, mode: "ceil" | "floor", label: string): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`jobScheduler: ${label} must be a finite nonnegative USD value`);
  }
  const rendered = value.toString();
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(rendered);
  if (match === null) {
    throw new Error(`jobScheduler: ${label} cannot be converted to micro-USD`);
  }
  const fraction = match[2] ?? "";
  const coefficient = BigInt(`${match[1]}${fraction}`);
  const exponent = Number(match[3] ?? "0");
  const microExponent = exponent - fraction.length + 6;
  let micro: bigint;
  if (microExponent >= 0) {
    micro = coefficient * (10n ** BigInt(microExponent));
  } else {
    const divisor = 10n ** BigInt(-microExponent);
    micro = coefficient / divisor;
    if (mode === "ceil" && coefficient % divisor !== 0n) micro += 1n;
  }
  return micro;
}

function exactSafeMicroUsd(value: number, mode: "ceil" | "floor", label: string): number {
  const micro = decimalMicroUsd(value, mode, label);
  if (micro > MAX_SAFE_MICRO_USD) {
    throw new Error(`jobScheduler: ${label} exceeds safe micro-USD precision`);
  }
  return Number(micro);
}

function reservationMicroUsd(value: number): number {
  return exactSafeMicroUsd(value, "ceil", "reservation");
}

function settledMicroUsd(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("jobScheduler: stored settled cost is invalid");
  }
  return decimalMicroUsd(value, "ceil", "settled cost");
}

function capMicroUsd(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("jobScheduler: stored/configured cost cap is invalid");
  }
  return exactSafeMicroUsd(value, "floor", "cost cap");
}

function sumCostRowsMicro(rows: Array<{ costUsd: number }>): bigint {
  return rows.reduce((total, row) => total + settledMicroUsd(row.costUsd), 0n);
}

function sumLeaseRowsMicro(rows: Array<{ reservedCostUsd: number }>): bigint {
  return rows.reduce((total, row) => total + BigInt(reservationMicroUsd(row.reservedCostUsd)), 0n);
}

export function acquirePaidPassLease(
  claim: JobClaim,
  pass: DurablePass,
  attemptId: string,
  maximumNextPassUsd: number,
  now: Date | undefined,
  limits: SchedulerLimits,
  db: ThesisDb = getDb(),
): PaidPassAcquireResult {
  assertLimits(limits);
  if (attemptId.trim().length === 0) throw new Error("jobScheduler: attemptId is required");
  const reserveMicro = reservationMicroUsd(maximumNextPassUsd);
  return db.transaction((tx): PaidPassAcquireResult => {
    const authority = authorityDate(now, "paid-pass acquisition");
    const nowIso = authority.toISOString();
    pruneExpiredPaidLeases(tx as ThesisDb, nowIso);
    const parent = tx.select({
      status: jobs.status,
      runGeneration: jobs.runGeneration,
      leaseOwner: jobs.leaseOwner,
      leaseExpiresAt: jobs.leaseExpiresAt,
      maxCostUsd: jobs.maxCostUsd,
    }).from(jobs).where(eq(jobs.id, claim.jobId)).get();
    if (
      parent === undefined ||
      parent.status !== "running" ||
      parent.runGeneration !== claim.runGeneration ||
      parent.leaseOwner !== claim.leaseOwner ||
      parent.leaseExpiresAt === null ||
      parent.leaseExpiresAt <= nowIso
    ) {
      throw new Error("jobScheduler: paid pass has no exact live parent claim");
    }

    const allLive = tx.select().from(jobLlmLeases).all();
    if (allLive.length >= limits.maxActiveLlmCalls) {
      return { acquired: false, reason: "capacity" };
    }

    const jobSettled = sumCostRowsMicro(
      tx.select({ costUsd: costLog.costUsd }).from(costLog).where(eq(costLog.jobId, claim.jobId)).all(),
    );
    const jobReserved = sumLeaseRowsMicro(allLive.filter((lease) => lease.jobId === claim.jobId));
    if (
      reserveMicro > 0 &&
      parent.maxCostUsd !== null &&
      jobSettled + jobReserved + BigInt(reserveMicro) > BigInt(capMicroUsd(parent.maxCostUsd))
    ) {
      return {
        acquired: false,
        reason:
          jobSettled + BigInt(reserveMicro) > BigInt(capMicroUsd(parent.maxCostUsd))
            ? "job-budget"
            : "job-budget-pending",
      };
    }

    if (reserveMicro > 0 && limits.maxRollingCostUsd !== null) {
      const cutoff = new Date(authority.getTime() - limits.rollingCostWindowMs).toISOString();
      const rollingSettled = sumCostRowsMicro(
        tx.select({ costUsd: costLog.costUsd }).from(costLog).where(gte(costLog.createdAt, cutoff)).all(),
      );
      const rollingReserved = sumLeaseRowsMicro(allLive);
      if (
        rollingSettled + rollingReserved + BigInt(reserveMicro) >
        BigInt(capMicroUsd(limits.maxRollingCostUsd))
      ) {
        return {
          acquired: false,
          reason:
            rollingSettled + BigInt(reserveMicro) >
              BigInt(capMicroUsd(limits.maxRollingCostUsd))
              ? "rolling-budget"
              : "rolling-budget-pending",
        };
      }
    }

    const permitId = randomUUID();
    const leaseOwner = nonce(claim.leaseOwner);
    const leaseExpiresAt = new Date(authority.getTime() + limits.paidPassLeaseTtlMs).toISOString();
    tx.insert(jobLlmLeases).values({
      permitId,
      jobId: claim.jobId,
      runGeneration: claim.runGeneration,
      attemptId,
      pass,
      leaseOwner,
      reservedCostUsd: reserveMicro / MICRO_USD,
      acquiredAt: nowIso,
      leaseExpiresAt,
    }).run();
    return {
      acquired: true,
      lease: {
        permitId,
        jobId: claim.jobId,
        runGeneration: claim.runGeneration,
        attemptId,
        pass,
        leaseOwner,
        jobLeaseOwner: claim.leaseOwner,
        reservedCostUsd: reserveMicro / MICRO_USD,
        acquiredAt: nowIso,
        leaseExpiresAt,
      },
    };
  }, { behavior: "immediate" });
}

function exactLeaseWhere(lease: PaidPassLease) {
  return and(
    eq(jobLlmLeases.permitId, lease.permitId),
    eq(jobLlmLeases.jobId, lease.jobId),
    eq(jobLlmLeases.runGeneration, lease.runGeneration),
    eq(jobLlmLeases.attemptId, lease.attemptId),
    eq(jobLlmLeases.pass, lease.pass),
    eq(jobLlmLeases.leaseOwner, lease.leaseOwner),
  );
}

export function renewPaidPassLease(
  lease: PaidPassLease,
  now: Date | undefined,
  limits: SchedulerLimits,
  db: ThesisDb = getDb(),
): boolean {
  assertLimits(limits);
  return db.transaction((tx): boolean => {
    const authority = authorityDate(now, "paid-pass renewal");
    const nowIso = authority.toISOString();
    const parent = tx.select({
      status: jobs.status,
      runGeneration: jobs.runGeneration,
      leaseOwner: jobs.leaseOwner,
      leaseExpiresAt: jobs.leaseExpiresAt,
    }).from(jobs).where(eq(jobs.id, lease.jobId)).get();
    if (
      parent?.status !== "running" ||
      parent.runGeneration !== lease.runGeneration ||
      parent.leaseOwner !== lease.jobLeaseOwner ||
      parent.leaseExpiresAt === null ||
      parent.leaseExpiresAt <= nowIso
    ) return false;
    return tx.update(jobLlmLeases)
      .set({ leaseExpiresAt: new Date(authority.getTime() + limits.paidPassLeaseTtlMs).toISOString() })
      .where(and(exactLeaseWhere(lease), gt(jobLlmLeases.leaseExpiresAt, nowIso)))
      .run().changes === 1;
  }, { behavior: "immediate" });
}

export interface PaidPassLaunchAuthority {
  revision: number;
  heartbeatAt: string;
  jobLeaseExpiresAt: string;
  paidLeaseExpiresAt: string;
}

/**
 * Atomically authorize the immediate provider boundary. The exact job owner,
 * revision, unexpired job lease, and exact unexpired paid permit are checked in
 * one BEGIN IMMEDIATE transaction that also persists the launch-visible step
 * snapshot and renews both leases.
 */
export function authorizePaidPassLaunch(
  lease: PaidPassLease,
  expectedRevision: number,
  stepsJson: string,
  now: Date | undefined,
  limits: SchedulerLimits,
  db: ThesisDb = getDb(),
): PaidPassLaunchAuthority | null {
  assertLimits(limits);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error("jobScheduler: invalid launch revision");
  }
  return db.transaction((tx): PaidPassLaunchAuthority | null => {
    const authority = authorityDate(now, "paid-pass launch");
    const nowIso = authority.toISOString();
    const jobLeaseExpiresAt = new Date(authority.getTime() + limits.jobLeaseTtlMs).toISOString();
    const paidLeaseExpiresAt = new Date(authority.getTime() + limits.paidPassLeaseTtlMs).toISOString();
    const parent = tx.select({
      status: jobs.status,
      runGeneration: jobs.runGeneration,
      revision: jobs.revision,
      leaseOwner: jobs.leaseOwner,
      leaseExpiresAt: jobs.leaseExpiresAt,
      stepsJson: jobs.stepsJson,
    }).from(jobs).where(eq(jobs.id, lease.jobId)).get();
    const permit = tx.select({ leaseExpiresAt: jobLlmLeases.leaseExpiresAt })
      .from(jobLlmLeases)
      .where(exactLeaseWhere(lease))
      .get();
    if (
      parent?.status !== "running" ||
      parent.runGeneration !== lease.runGeneration ||
      parent.revision !== expectedRevision ||
      parent.leaseOwner !== lease.jobLeaseOwner ||
      parent.leaseExpiresAt === null ||
      parent.leaseExpiresAt <= nowIso ||
      permit === undefined ||
      permit.leaseExpiresAt <= nowIso
    ) return null;

    const visibleStepTransition = parent.stepsJson !== stepsJson;
    const nextRevision = visibleStepTransition ? expectedRevision + 1 : expectedRevision;
    const jobUpdate = tx.update(jobs).set({
      ...(visibleStepTransition ? { stepsJson, revision: nextRevision, updatedAt: nowIso } : {}),
      heartbeatAt: nowIso,
      leaseExpiresAt: jobLeaseExpiresAt,
    }).where(and(
      eq(jobs.id, lease.jobId),
      eq(jobs.status, "running"),
      eq(jobs.runGeneration, lease.runGeneration),
      eq(jobs.revision, expectedRevision),
      eq(jobs.leaseOwner, lease.jobLeaseOwner),
      gt(jobs.leaseExpiresAt, nowIso),
    )).run();
    const permitUpdate = tx.update(jobLlmLeases)
      .set({ leaseExpiresAt: paidLeaseExpiresAt })
      .where(and(exactLeaseWhere(lease), gt(jobLlmLeases.leaseExpiresAt, nowIso)))
      .run();
    if (jobUpdate.changes !== 1 || permitUpdate.changes !== 1) {
      throw new Error("jobScheduler: atomic launch authority changed inside locked transaction");
    }
    return {
      revision: nextRevision,
      heartbeatAt: nowIso,
      jobLeaseExpiresAt,
      paidLeaseExpiresAt,
    };
  }, { behavior: "immediate" });
}

export function releaseUnbilledPaidPassLease(
  lease: PaidPassLease,
  db: ThesisDb = getDb(),
  now?: Date,
): boolean {
  const released = db.transaction((tx): boolean => {
    const authorityAt = authorityDate(now, "paid-pass release").toISOString();
    return tx.delete(jobLlmLeases)
      .where(and(exactLeaseWhere(lease), gt(jobLlmLeases.leaseExpiresAt, authorityAt)))
      .run().changes === 1;
  }, { behavior: "immediate" });
  if (released) requestPump(schedulerPumpState());
  return released;
}

export interface SettlePaidPassInput<T> {
  settlement: PassSettlement<T>;
  payloadFingerprint: string | null;
  settledAt?: string;
}

export interface SettlePaidPassResult extends PersistPassSettlementResult {
  overReservation: boolean;
  /** Revision committed with a new exact-current settlement; null otherwise. */
  currentRevision: number | null;
}

export class PaidPassOverReservationError extends Error {
  constructor(readonly result: SettlePaidPassResult) {
    super("jobScheduler invariant: actual paid-pass cost exceeds its reservation");
    this.name = "PaidPassOverReservationError";
  }
}

/** Settle immutable truth and delete the exact reservation in one transaction. */
export function settlePaidPassLease<T>(
  lease: PaidPassLease,
  input: SettlePaidPassInput<T>,
  db: ThesisDb = getDb(),
  authorityNow?: Date,
): SettlePaidPassResult {
  const settlementInput = {
    jobId: lease.jobId,
    runGeneration: lease.runGeneration,
    attemptId: lease.attemptId,
    pass: lease.pass,
    settlement: input.settlement,
    payloadFingerprint: input.payloadFingerprint,
    settledAt: input.settledAt,
  };
  const prepared = preparePassSettlement(settlementInput);
  if (authorityNow !== undefined && !Number.isFinite(authorityNow.getTime())) {
    throw new Error("jobScheduler: paid-pass settlement time is invalid");
  }
  const result = db.transaction((tx): SettlePaidPassResult => {
    // When no deterministic test clock is injected, capture wall time only
    // after BEGIN IMMEDIATE has acquired the writer lock. A lock wait can never
    // backdate settlement authority across lease expiry.
    const authority = authorityNow ?? new Date();
    if (!Number.isFinite(authority.getTime())) {
      throw new Error("jobScheduler: paid-pass settlement time is invalid");
    }
    const authorityAt = authority.toISOString();
    const existingArtifact = tx.select({ attemptId: jobPassArtifacts.attemptId })
      .from(jobPassArtifacts)
      .where(and(
        eq(jobPassArtifacts.jobId, lease.jobId),
        eq(jobPassArtifacts.runGeneration, lease.runGeneration),
        eq(jobPassArtifacts.attemptId, lease.attemptId),
        eq(jobPassArtifacts.pass, lease.pass),
      ))
      .get();
    const existingCost = tx.select({ attemptId: costLog.attemptId })
      .from(costLog)
      .where(and(
        eq(costLog.jobId, lease.jobId),
        eq(costLog.runGeneration, lease.runGeneration),
        eq(costLog.attemptId, lease.attemptId),
        eq(costLog.step, lease.pass),
      ))
      .get();
    if (existingArtifact !== undefined || existingCost !== undefined) {
      const duplicate = persistPassSettlementInTransaction(tx, settlementInput, prepared, {
        jobLeaseOwner: lease.jobLeaseOwner,
        authorityAt,
      });
      return { ...duplicate, overReservation: false, currentRevision: null };
    }

    const exact = tx.select().from(jobLlmLeases).where(exactLeaseWhere(lease)).get();
    if (exact === undefined) {
      throw new Error("jobScheduler: stale paid-pass lease has no settlement authority");
    }
    if (exact.leaseExpiresAt <= authorityAt) {
      throw new Error("jobScheduler: expired paid-pass lease has no settlement authority");
    }
    const persisted = persistPassSettlementInTransaction(tx, settlementInput, prepared, {
      jobLeaseOwner: lease.jobLeaseOwner,
      authorityAt,
    });
    const deleted = tx.delete(jobLlmLeases).where(exactLeaseWhere(lease)).run();
    if (deleted.changes !== 1) {
      throw new Error("jobScheduler: exact paid-pass lease disappeared during settlement");
    }
    let currentRevision: number | null = null;
    if (persisted.inserted) {
      const parent = tx.select({
        status: jobs.status,
        runGeneration: jobs.runGeneration,
        revision: jobs.revision,
        leaseOwner: jobs.leaseOwner,
        leaseExpiresAt: jobs.leaseExpiresAt,
      }).from(jobs).where(eq(jobs.id, lease.jobId)).get();
      if (parent === undefined) {
        throw new Error("jobScheduler: paid settlement parent job disappeared");
      }
      const exactLiveCurrent =
        parent.status === "running" &&
        parent.runGeneration === lease.runGeneration &&
        parent.leaseOwner === lease.jobLeaseOwner &&
        parent.leaseExpiresAt !== null &&
        parent.leaseExpiresAt > authorityAt;
      const protectedDifferentLiveOwner =
        parent.status === "running" &&
        parent.leaseExpiresAt !== null &&
        parent.leaseExpiresAt > authorityAt &&
        !exactLiveCurrent;
      if (!protectedDifferentLiveOwner) {
        const revisionUpdate = tx.update(jobs).set({
          revision: parent.revision + 1,
          // Artifact/cost provenance keeps input.settledAt. The mutable job
          // snapshot clock records commit authority and must never regress.
          updatedAt: authorityAt,
        }).where(and(
          eq(jobs.id, lease.jobId),
          eq(jobs.revision, parent.revision),
          ...(exactLiveCurrent
            ? [
                eq(jobs.status, "running"),
                eq(jobs.runGeneration, lease.runGeneration),
                eq(jobs.leaseOwner, lease.jobLeaseOwner),
                gt(jobs.leaseExpiresAt, authorityAt),
              ]
            : []),
        )).run();
        if (revisionUpdate.changes !== 1) {
          throw new Error("jobScheduler: settlement revision fence changed unexpectedly");
        }
        if (exactLiveCurrent) currentRevision = parent.revision + 1;
      }
    }
    return {
      ...persisted,
      currentRevision,
      overReservation:
        settledMicroUsd(prepared.telemetry.costUsd) >
        BigInt(reservationMicroUsd(exact.reservedCostUsd)),
    };
  }, { behavior: "immediate" });
  if (result.inserted) requestPump(schedulerPumpState());
  if (result.overReservation) {
    throw new PaidPassOverReservationError(result);
  }
  return result;
}
