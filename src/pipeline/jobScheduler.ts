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
  REQUEST_ATTEMPT_SEPARATOR,
  persistPassSettlementInTransaction,
  preparePassSettlement,
  reconcilePresumedCostFromSettlement,
  serializeLegacyAnalystProjection,
  type DurablePass,
  type PassSettlement,
  type PersistPassSettlementResult,
} from "@/pipeline/jobArtifacts";
import {
  assertSafeJobRevision,
  mutateJobSnapshotInTransaction,
  renewInvisibleJobLease,
  renewInvisibleJobLeaseInTransaction,
} from "@/pipeline/jobState";
import {
  normalizeLinkedReportRecoverySteps,
  parseCanonicalJobSteps,
} from "@/pipeline/jobSteps";
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
/**
 * Worst-case postlaunch runner bookkeeping is deliberately over-reserved:
 * judge/report validation can retry twice, with visible finish/detail/restart
 * writes, followed by verify degradation and one report/error terminal write.
 * Revision space is enormous, so 32 is a safer fail-early bound than coupling
 * paid admission to the exact current control-flow write count.
 */
const PAID_PIPELINE_BOOKKEEPING_HEADROOM = 32;

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
  /** Model the reservation was priced for; "" on leases written before the column existed. */
  model: string;
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
        | "revision-headroom"
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

function parseSteps(raw: string): StepProgress[] {
  const steps = parseCanonicalJobSteps(raw);
  if (steps === null) throw new Error("jobScheduler: invalid persisted step snapshot");
  return steps;
}

function isTerminalJobStatus(status: string): boolean {
  return status === "done" || status === "error" ||
    status === "unsupported" || status === "canceled";
}

/**
 * A retained paid lease keeps a terminal snapshot financially open. After a
 * non-settlement deletion, version the transition to finalized iff that was
 * the last retained row. Settlement already versions cost + deletion once and
 * deliberately does not call this helper.
 */
function finalizeTerminalPaidLeasesInTransaction(
  db: ThesisDb,
  jobId: string,
  nowIso: string,
): boolean {
  const remaining = db.select({ permitId: jobLlmLeases.permitId })
    .from(jobLlmLeases)
    .where(eq(jobLlmLeases.jobId, jobId))
    .limit(1)
    .get();
  if (remaining !== undefined) return false;
  const parent = db.select({ status: jobs.status, revision: jobs.revision })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .get();
  if (parent === undefined || !isTerminalJobStatus(parent.status)) return false;
  const mutation = mutateJobSnapshotInTransaction(db, {
    jobId,
    now: new Date(nowIso),
    forceRevision: true,
    fence: { expectedRevision: parent.revision, status: parent.status },
    mutate: () => ({}),
  });
  if (mutation === null) {
    throw new Error("jobScheduler: terminal paid-lease finalization fence changed");
  }
  return true;
}

/**
 * Convert an expired, unsettled paid-pass lease into PRESUMED spend
 * (DECISIONS D-07).
 *
 * The lease exists because a provider call was authorized. If the process
 * holding it dies, nothing ever reports what that call billed — but Anthropic
 * may well have billed it, up to the reserved maximum. Deleting the row (the
 * behavior before this change) silently returned that money to every cap, so
 * a crash loop could spend without limit. Instead the whole reservation is
 * written to `cost_log` as a `presumed` row, which every admission path
 * already counts, and only evidence moves it down: a late settlement for the
 * same attempt (`reconcilePresumedCostFromSettlement` in jobArtifacts) or the
 * Usage & Cost API ({@link reconcilePresumedCostsAgainstReportedTotals}).
 *
 * The row carries `presumedAttemptId` rather than `attemptId` so the billed
 * attempt slot stays free: a settlement that arrives after expiry can still be
 * recorded in full, and it deletes the presumed row in the same transaction.
 */
function presumeExpiredPaidLeasesInTransaction(db: ThesisDb, nowIso: string): number {
  const expired = db.select()
    .from(jobLlmLeases)
    .where(lte(jobLlmLeases.leaseExpiresAt, nowIso))
    .all();
  if (expired.length === 0) return 0;
  for (const lease of expired) {
    const alreadySettled = db.select({ id: costLog.id })
      .from(costLog)
      .where(and(
        eq(costLog.jobId, lease.jobId),
        eq(costLog.runGeneration, lease.runGeneration),
        eq(costLog.attemptId, lease.attemptId),
        eq(costLog.step, lease.pass),
      ))
      .get();
    if (alreadySettled !== undefined) continue;
    const alreadyPresumed = db.select({ id: costLog.id })
      .from(costLog)
      .where(and(
        eq(costLog.jobId, lease.jobId),
        eq(costLog.runGeneration, lease.runGeneration),
        eq(costLog.presumedAttemptId, lease.attemptId),
        eq(costLog.step, lease.pass),
      ))
      .get();
    if (alreadyPresumed !== undefined) continue;
    const reservedMicro = BigInt(reservationMicroUsd(lease.reservedCostUsd));
    if (reservedMicro === 0n) continue;
    db.insert(costLog).values({
      jobId: lease.jobId,
      runGeneration: lease.runGeneration,
      attemptId: null,
      presumedAttemptId: lease.attemptId,
      settlementKind: "presumed",
      step: lease.pass,
      model: lease.model.length > 0 ? lease.model : "unknown",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearches: 0,
      costUsd: Number(reservedMicro) / MICRO_USD,
      fallbackUsed: false,
      reconciledAt: null,
      createdAt: nowIso,
    }).run();
  }
  return expired.length;
}

function pruneExpiredPaidLeases(db: ThesisDb, nowIso: string): number {
  const expired = db.select({ jobId: jobLlmLeases.jobId })
    .from(jobLlmLeases)
    .where(lte(jobLlmLeases.leaseExpiresAt, nowIso))
    .all();
  if (expired.length === 0) return 0;
  presumeExpiredPaidLeasesInTransaction(db, nowIso);
  const deleted = db.delete(jobLlmLeases)
    .where(lte(jobLlmLeases.leaseExpiresAt, nowIso))
    .run().changes;
  for (const jobId of new Set(expired.map((row) => row.jobId))) {
    finalizeTerminalPaidLeasesInTransaction(db, jobId, nowIso);
  }
  return deleted;
}

/**
 * Attempt id for one provider REQUEST inside a pass attempt (DECISIONS D-10).
 * The pass keeps its own id for the durable artifact; each request gets a
 * suffixed id so its reservation and its cost row are addressable on their
 * own, and the billed-attempt unique index still holds. The resume reader
 * pairs these rows back to their pass artifact with the same separator
 * (`costRowBelongsToAttempt`).
 */
export function requestAttemptId(passAttemptId: string, sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("jobScheduler: request sequence must be a positive integer");
  }
  return `${passAttemptId}${REQUEST_ATTEMPT_SEPARATOR}${sequence}`;
}

/**
 * Lower an exact live lease's reservation (DECISIONS D-10).
 *
 * In request-reservation mode the pass lease is taken for one request's
 * maximum, which covers a pass that settles without ever reaching the
 * provider. Once the first request has its OWN reservation that headroom is
 * redundant, so it is released: live exposure then stays at exactly
 * THESIS_MAX_ACTIVE_LLM_CALLS request maxima rather than twice that. Only
 * downward, and only on the exact live lease.
 */
export function resizePaidPassLease(
  lease: PaidPassLease,
  reservedCostUsd: number,
  now: Date | undefined = undefined,
  db: ThesisDb = getDb(),
): PaidPassLease | null {
  const nextMicro = reservationMicroUsd(reservedCostUsd);
  return db.transaction((tx): PaidPassLease | null => {
    const authority = authorityDate(now, "paid-pass resize");
    const nowIso = authority.toISOString();
    const exact = tx.select().from(jobLlmLeases).where(exactLeaseWhere(lease)).get();
    if (exact === undefined || exact.leaseExpiresAt <= nowIso) return null;
    if (BigInt(nextMicro) > BigInt(reservationMicroUsd(exact.reservedCostUsd))) {
      throw new Error("jobScheduler: a paid-pass reservation can only be lowered");
    }
    tx.update(jobLlmLeases)
      .set({ reservedCostUsd: nextMicro / MICRO_USD })
      .where(exactLeaseWhere(lease))
      .run();
    return { ...lease, reservedCostUsd: nextMicro / MICRO_USD };
  }, { behavior: "immediate" });
}

export interface RequestCostSettlement {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
  costUsd: number;
  fallbackUsed: boolean;
  /** True when the figure is a presumed maximum rather than reported usage. */
  presumed?: boolean;
}

/**
 * Settle ONE provider request: record what it billed and release its
 * reservation. Unlike {@link settlePaidPassLease} this writes no artifact and
 * no step projection — the pass settles those once, after its last request.
 *
 * A presumed settlement (the request was sent and then timed out) is recorded
 * as such so `npm run costs:reconcile` can lower it later; a reported one is
 * final.
 */
export function settleRequestCost(
  lease: PaidPassLease,
  settlement: RequestCostSettlement,
  now: Date | undefined = undefined,
  db: ThesisDb = getDb(),
): { recorded: boolean; costUsd: number } {
  if (!Number.isFinite(settlement.costUsd) || settlement.costUsd < 0) {
    throw new Error("jobScheduler: request settlement cost must be a nonnegative finite number");
  }
  return db.transaction((tx) => {
    const authority = authorityDate(now, "request settlement");
    const authorityAt = authority.toISOString();
    const existing = tx.select({ id: costLog.id, costUsd: costLog.costUsd })
      .from(costLog)
      .where(and(
        eq(costLog.jobId, lease.jobId),
        eq(costLog.runGeneration, lease.runGeneration),
        eq(costLog.attemptId, lease.attemptId),
        eq(costLog.step, lease.pass),
      ))
      .get();
    if (existing !== undefined) {
      // Idempotent replay: the exact request already settled.
      tx.delete(jobLlmLeases).where(exactLeaseWhere(lease)).run();
      return { recorded: false, costUsd: existing.costUsd };
    }
    const reservedMicro = BigInt(reservationMicroUsd(lease.reservedCostUsd));
    const settledMicro = settledMicroUsd(settlement.costUsd);
    if (settledMicro > reservedMicro) {
      throw new PaidPassOverReservationError({
        inserted: false,
        currentGeneration: false,
        telemetry: null,
        overReservation: true,
        currentRevision: null,
        currentSteps: null,
        currentTotalCostUsd: null,
        projectionError: null,
      } as unknown as SettlePaidPassResult);
    }
    // A presumed row for this request (its lease expired earlier) is
    // superseded by whatever is written below. Deleted BEFORE the insert
    // because a presumed settlement now claims the same `presumedAttemptId`,
    // which the presumed-attempt unique index would reject and which a delete
    // afterwards would remove again.
    reconcilePresumedCostFromSettlement(tx, {
      jobId: lease.jobId,
      runGeneration: lease.runGeneration,
      attemptId: lease.attemptId,
      pass: lease.pass,
    });
    if (settledMicro > 0n) {
      const presumed = settlement.presumed === true;
      tx.insert(costLog).values({
        jobId: lease.jobId,
        runGeneration: lease.runGeneration,
        attemptId: lease.attemptId,
        // A stalled stream settles reported usage plus the worst case for the
        // remainder. That remainder is a presumed maximum like any other, so
        // it must carry `presumedAttemptId` too: both reconciliation entry
        // points select on that column, and without it the row could never be
        // listed by `npm run costs:reconcile`, never lowered by a reported
        // total, and never subtracted from that total while its neighbours
        // were lowered against it (DECISIONS D-07, D-09). `attemptId` stays
        // set — the request DID bill under it — so the billed-attempt index
        // still fences a duplicate settlement for the same request.
        presumedAttemptId: presumed ? lease.attemptId : null,
        settlementKind: presumed ? "presumed" : "actual",
        step: lease.pass,
        model: settlement.model,
        inputTokens: settlement.inputTokens,
        outputTokens: settlement.outputTokens,
        cacheReadTokens: settlement.cacheReadTokens,
        cacheWriteTokens: settlement.cacheWriteTokens,
        webSearches: settlement.webSearches,
        costUsd: Number(settledMicro) / MICRO_USD,
        fallbackUsed: settlement.fallbackUsed,
        reconciledAt: null,
        createdAt: authorityAt,
      }).run();
    }
    tx.delete(jobLlmLeases).where(exactLeaseWhere(lease)).run();
    return { recorded: settledMicro > 0n, costUsd: Number(settledMicro) / MICRO_USD };
  }, { behavior: "immediate" });
}

export interface PresumedCostRow {
  id: number;
  jobId: string;
  runGeneration: number;
  attemptId: string;
  pass: string;
  model: string;
  costUsd: number;
  createdAt: string;
}

/** Every unreconciled presumed-spend row, oldest first. */
export function listPresumedCosts(db: ThesisDb = getDb()): PresumedCostRow[] {
  return db.select()
    .from(costLog)
    .where(and(eq(costLog.settlementKind, "presumed"), isNull(costLog.reconciledAt)))
    .all()
    .filter((row) => row.presumedAttemptId !== null)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .map((row) => ({
      id: row.id,
      jobId: row.jobId,
      runGeneration: row.runGeneration,
      attemptId: row.presumedAttemptId as string,
      pass: row.step,
      model: row.model,
      costUsd: row.costUsd,
      createdAt: row.createdAt,
    }));
}

export interface ReportedCostBucket {
  /** Inclusive ISO start of the reporting bucket. */
  startTime: string;
  /** Exclusive ISO end of the reporting bucket. */
  endTime: string;
  /** Total USD Anthropic reports for the bucket. */
  reportedUsd: number;
}

export interface PresumedReconciliation {
  id: number;
  jobId: string;
  attemptId: string;
  pass: string;
  fromUsd: number;
  toUsd: number;
}

/**
 * Reconcile presumed rows downward against Anthropic's reported totals
 * (Usage & Cost API). The API reports totals per time bucket, not per
 * request, so the only sound inference is an upper bound: within a bucket,
 * presumed spend cannot exceed what Anthropic says the whole bucket cost,
 * minus the actual settlements already recorded there. The remainder is split
 * across that bucket's presumed rows in proportion to their reserved amounts,
 * and a row is only ever lowered, never raised.
 *
 * Pure over its inputs so it can be exercised offline; the fetch that
 * produces `buckets` lives in the reconcile script.
 */
export function reconcilePresumedCostsAgainstReportedTotals(
  buckets: readonly ReportedCostBucket[],
  now: Date = new Date(),
  db: ThesisDb = getDb(),
): PresumedReconciliation[] {
  const nowIso = now.toISOString();
  return db.transaction((tx): PresumedReconciliation[] => {
    const applied: PresumedReconciliation[] = [];
    for (const bucket of buckets) {
      if (!(bucket.startTime < bucket.endTime) || !Number.isFinite(bucket.reportedUsd)) {
        throw new Error("jobScheduler: invalid reported cost bucket");
      }
      const inBucket = tx.select().from(costLog)
        .where(and(
          gte(costLog.createdAt, bucket.startTime),
          lt(costLog.createdAt, bucket.endTime),
        ))
        .all();
      const presumed = inBucket.filter(
        (row) => row.settlementKind === "presumed" && row.reconciledAt === null && row.presumedAttemptId !== null,
      );
      if (presumed.length === 0) continue;
      const actualMicro = inBucket
        .filter((row) => row.settlementKind !== "presumed")
        .reduce((total, row) => total + settledMicroUsd(row.costUsd), 0n);
      const reportedMicro = settledMicroUsd(Math.max(0, bucket.reportedUsd));
      const remainingMicro = reportedMicro > actualMicro ? reportedMicro - actualMicro : 0n;
      const presumedTotalMicro = presumed.reduce(
        (total, row) => total + settledMicroUsd(row.costUsd),
        0n,
      );
      if (presumedTotalMicro <= remainingMicro) continue;
      for (const row of presumed) {
        const share = presumedTotalMicro === 0n
          ? 0n
          : (settledMicroUsd(row.costUsd) * remainingMicro) / presumedTotalMicro;
        const nextUsd = Number(share) / MICRO_USD;
        if (nextUsd >= row.costUsd) continue;
        tx.update(costLog)
          .set({ costUsd: nextUsd, reconciledAt: nowIso })
          .where(eq(costLog.id, row.id))
          .run();
        applied.push({
          id: row.id,
          jobId: row.jobId,
          attemptId: row.presumedAttemptId as string,
          pass: row.step,
          fromUsd: row.costUsd,
          toUsd: nextUsd,
        });
      }
    }
    return applied;
  }, { behavior: "immediate" });
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
    const mutation = mutateJobSnapshotInTransaction(db, {
      jobId: row.id,
      now: new Date(nowIso),
      fence: {
        expectedRevision: row.revision,
        runGeneration: row.runGeneration,
        status: "running",
        leaseOwner: row.leaseOwner,
      },
      mutate: (current) => current.leaseExpiresAt === row.leaseExpiresAt
        ? ({
        status: "error",
        error: message,
        stepsJson: normalizeTerminalSteps(row.stepsJson, message, nowIso),
        unsupportedKind: null,
        unsupportedMessage: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
      }) : null,
    });
    if (mutation !== null) changed += 1;
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
          const stepsJson = normalizeLinkedReportRecoverySteps(
            row.stepsJson,
            nowIso,
            "covered by linked persisted report recovered before dispatch",
          );
          mutateJobSnapshotInTransaction(tx as ThesisDb, {
            jobId: row.id,
            now: authority,
            fence: {
              expectedRevision: row.revision,
              status: "queued",
              runGeneration: row.runGeneration,
            },
            mutate: (current) => current.reportId === linked.id ? ({
              status: "done",
              error: null,
              stepsJson,
              leaseOwner: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
            }) : null,
          });
          continue;
        }
        preparedResume = prepareQueuedJobResumeInTransaction(tx, row.id);
        if (preparedResume === null) {
          const message = "queued retry has no coherent durable source plan";
          mutateJobSnapshotInTransaction(tx as ThesisDb, {
            jobId: row.id,
            now: authority,
            fence: {
              expectedRevision: row.revision,
              status: "queued",
              runGeneration: row.runGeneration,
            },
            mutate: () => ({
              status: "error",
              error: message,
              stepsJson: normalizeTerminalSteps(row.stepsJson, message, nowIso),
              leaseOwner: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
            }),
          });
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
      const claimed = mutateJobSnapshotInTransaction(tx as ThesisDb, {
        jobId: row.id,
        now: authority,
        fence: {
          expectedRevision: row.revision,
          status: "queued",
          runGeneration: row.runGeneration,
        },
        mutate: () => ({
          status: "running",
          error: null,
          unsupportedKind: null,
          unsupportedMessage: null,
          leaseOwner,
          heartbeatAt: nowIso,
          leaseExpiresAt,
        }),
      });
      if (claimed === null) {
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
        mutateJobSnapshotInTransaction(tx as ThesisDb, {
          jobId: row.id,
          now: authority,
          fence: {
            expectedRevision: row.revision,
            status: "queued",
            runGeneration: row.runGeneration,
          },
          mutate: () => ({
            status: "error",
            error: message,
            stepsJson: normalizeTerminalSteps(row.stepsJson, message, nowIso),
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
          }),
        });
        continue;
      }
      tx.run(sql.raw("RELEASE scheduler_job_claim"));
      return {
        jobId: row.id,
        symbol: row.symbol,
        runGeneration: row.runGeneration,
        revision: claimed.revision,
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
  return renewInvisibleJobLease({
    jobId: claim.jobId,
    runGeneration: claim.runGeneration,
    leaseOwner: claim.leaseOwner,
    leaseTtlMs: limits.jobLeaseTtlMs,
    ...(now === undefined ? {} : { now }),
  }, db);
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
    return mutateJobSnapshotInTransaction(tx as ThesisDb, {
      jobId: claim.jobId,
      now: new Date(authorityAt),
      fence: {
        runGeneration: claim.runGeneration,
        status: "running",
        leaseOwner: claim.leaseOwner,
        leaseValidAfter: authorityAt,
      },
      mutate: () => ({
        status,
        error: status === "error" ? (message ?? "job failed") : null,
        stepsJson: status === "error"
          ? normalizeTerminalSteps(row.stepsJson, message ?? "job failed", authorityAt)
          : row.stepsJson,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
      }),
    }) !== null;
  }, { behavior: "immediate" });
}

async function terminalizeSchedulerExecutionFailure(
  claim: ClaimedJob,
  message: string,
  now?: Date,
): Promise<void> {
  if (!terminalizeClaim(claim, "error", message, now)) return;
  const { publishJobEvent } = await import("@/pipeline/events");
  const revision = getDb().select({ revision: jobs.revision }).from(jobs)
    .where(eq(jobs.id, claim.jobId)).get()?.revision;
  if (revision !== undefined) {
    publishJobEvent({ type: "error", jobId: claim.jobId, revision, message });
  }
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

function hasJobRevisionHeadroom(revision: number, requiredWrites: number): boolean {
  assertSafeJobRevision(revision);
  if (!Number.isSafeInteger(requiredWrites) || requiredWrites < 1) {
    throw new Error("jobScheduler: invalid revision headroom requirement");
  }
  return Number.MAX_SAFE_INTEGER - revision >= requiredWrites;
}

export function acquirePaidPassLease(
  claim: JobClaim,
  pass: DurablePass,
  attemptId: string,
  maximumNextPassUsd: number,
  now: Date | undefined,
  limits: SchedulerLimits,
  db: ThesisDb = getDb(),
  /**
   * Model this reservation is priced for. Recorded on the lease so a crash
   * that leaves it to expire can name the model in its presumed-spend row.
   */
  model = "",
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
      revision: jobs.revision,
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
    // Global LLM capacity counts leases that reserve money — the provider
    // requests actually in flight. A zero-reservation lease is bookkeeping
    // (deterministic verify, and the pass-level artifact authority in
    // request-reservation mode); letting one occupy a paid slot would block a
    // real request behind work that cannot bill.
    const liveBillable = allLive.filter((lease) => reservationMicroUsd(lease.reservedCostUsd) > 0);
    const outstandingForJob = allLive.filter((lease) => lease.jobId === claim.jobId).length;
    // Reserve one visible launch transition, every already-issued settlement,
    // this permit's future settlement, and the conservative postlaunch runner
    // bookkeeping/terminal budget.
    if (!hasJobRevisionHeadroom(
      parent.revision,
      outstandingForJob + 2 + PAID_PIPELINE_BOOKKEEPING_HEADROOM,
    )) {
      return { acquired: false, reason: "revision-headroom" };
    }
    if (reserveMicro > 0 && liveBillable.length >= limits.maxActiveLlmCalls) {
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
      model,
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
        model,
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
 * generation, unexpired job lease, and exact unexpired paid permit are checked in
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
    pruneExpiredPaidLeases(tx as ThesisDb, nowIso);
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
      parent.leaseOwner !== lease.jobLeaseOwner ||
      parent.leaseExpiresAt === null ||
      parent.leaseExpiresAt <= nowIso ||
      permit === undefined ||
      permit.leaseExpiresAt <= nowIso
    ) return null;

    const latestSteps = parseSteps(parent.stepsJson);
    const candidateSteps = parseSteps(stepsJson);
    const candidate = candidateSteps.find((step) => step.step === lease.pass);
    const currentIndex = latestSteps.findIndex((step) => step.step === lease.pass);
    const current = latestSteps[currentIndex];
    if (candidate === undefined || current === undefined || currentIndex < 0) {
      throw new Error(`jobScheduler: missing launch step ${lease.pass}`);
    }
    const targetChanged = JSON.stringify(candidate) !== JSON.stringify(current);
    if (targetChanged) latestSteps[currentIndex] = structuredClone(candidate);
    const mergedStepsJson = JSON.stringify(latestSteps);
    const visibleStepTransition = parent.stepsJson !== mergedStepsJson;
    const outstandingForJob = tx.select({ permitId: jobLlmLeases.permitId })
      .from(jobLlmLeases)
      .where(eq(jobLlmLeases.jobId, lease.jobId))
      .all().length;
    // Every live permit can still settle immutable truth and bump the shared
    // snapshot. Also reserve the conservative retry/degradation/terminal
    // bookkeeping budget and this launch transition when it is visible.
    const requiredWrites = outstandingForJob + PAID_PIPELINE_BOOKKEEPING_HEADROOM +
      (visibleStepTransition ? 1 : 0);
    if (!hasJobRevisionHeadroom(parent.revision, requiredWrites)) {
      throw new Error("jobScheduler: insufficient safe revision headroom before paid pass launch");
    }
    let nextRevision = parent.revision;
    if (visibleStepTransition) {
      const mutation = mutateJobSnapshotInTransaction(tx as ThesisDb, {
        jobId: lease.jobId,
        now: authority,
        fence: {
          runGeneration: lease.runGeneration,
          status: "running",
          leaseOwner: lease.jobLeaseOwner,
          leaseValidAfter: nowIso,
        },
        mutate: () => ({ stepsJson: mergedStepsJson }),
      });
      if (mutation === null) {
        throw new Error("jobScheduler: launch step transition lost authority");
      }
      nextRevision = mutation.revision;
    }
    const jobRenewed = renewInvisibleJobLeaseInTransaction({
      jobId: lease.jobId,
      runGeneration: lease.runGeneration,
      leaseOwner: lease.jobLeaseOwner,
      leaseTtlMs: limits.jobLeaseTtlMs,
      now: authority,
    }, tx as ThesisDb);
    const permitUpdate = tx.update(jobLlmLeases)
      .set({ leaseExpiresAt: paidLeaseExpiresAt })
      .where(and(exactLeaseWhere(lease), gt(jobLlmLeases.leaseExpiresAt, nowIso)))
      .run();
    if (!jobRenewed || permitUpdate.changes !== 1) {
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
    const deleted = tx.delete(jobLlmLeases)
      .where(and(exactLeaseWhere(lease), gt(jobLlmLeases.leaseExpiresAt, authorityAt)))
      .run().changes;
    if (deleted !== 1) return false;
    finalizeTerminalPaidLeasesInTransaction(tx as ThesisDb, lease.jobId, authorityAt);
    return true;
  }, { behavior: "immediate" });
  if (released) requestPump(schedulerPumpState());
  return released;
}

export interface SettlePaidPassInput<T> {
  settlement: PassSettlement<T>;
  payloadFingerprint: string | null;
  settledAt?: string;
  /** Canonical terminal step metadata merged in the same exact-current transaction. */
  step?: { finishedAt?: string; detail?: string };
}

export interface SettlePaidPassResult extends PersistPassSettlementResult {
  overReservation: boolean;
  /** Revision committed with a new exact-current settlement; null otherwise. */
  currentRevision: number | null;
  currentSteps: StepProgress[] | null;
  currentTotalCostUsd: number | null;
  /** Immutable settlement committed, but its exact-current step projection was unsafe. */
  projectionError: string | null;
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
      return {
        ...duplicate,
        overReservation: false,
        currentRevision: null,
        currentSteps: null,
        currentTotalCostUsd: null,
        projectionError: null,
      };
    }

    const exact = tx.select().from(jobLlmLeases).where(exactLeaseWhere(lease)).get();
    // The lease may already have expired into a PRESUMED cost row (D-07). That
    // row is a placeholder for exactly this attempt, so the real settlement is
    // still welcome: persisting it replaces the presumed maximum with measured
    // usage in the same transaction (see persistPassSettlementInTransaction),
    // which is the downward reconciliation the reservation policy calls for.
    // Without this branch the only report of what the call actually cost would
    // be thrown away and the maximum would stand.
    const presumed = tx.select({ id: costLog.id, costUsd: costLog.costUsd })
      .from(costLog)
      .where(and(
        eq(costLog.jobId, lease.jobId),
        eq(costLog.runGeneration, lease.runGeneration),
        eq(costLog.presumedAttemptId, lease.attemptId),
        eq(costLog.step, lease.pass),
      ))
      .get();
    if (exact === undefined && presumed === undefined) {
      throw new Error("jobScheduler: stale paid-pass lease has no settlement authority");
    }
    if (exact !== undefined && exact.leaseExpiresAt <= authorityAt && presumed === undefined) {
      throw new Error("jobScheduler: expired paid-pass lease has no settlement authority");
    }
    const persisted = persistPassSettlementInTransaction(tx, settlementInput, prepared, {
      jobLeaseOwner: lease.jobLeaseOwner,
      authorityAt,
    });
    if (exact !== undefined) {
      const deleted = tx.delete(jobLlmLeases).where(exactLeaseWhere(lease)).run();
      if (deleted.changes !== 1) {
        throw new Error("jobScheduler: exact paid-pass lease disappeared during settlement");
      }
    }
    let currentRevision: number | null = null;
    let currentSteps: StepProgress[] | null = null;
    let currentTotalCostUsd: number | null = null;
    let projectionError: string | null = null;
    if (persisted.inserted) {
      const parent = tx.select({
        status: jobs.status,
        runGeneration: jobs.runGeneration,
        revision: jobs.revision,
        leaseOwner: jobs.leaseOwner,
        leaseExpiresAt: jobs.leaseExpiresAt,
        stepsJson: jobs.stepsJson,
        payloadFingerprint: jobs.payloadFingerprint,
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
      const set: Record<string, unknown> = {};
      if (exactLiveCurrent) {
        try {
          const latest = parseSteps(parent.stepsJson);
          const step = latest.find((candidate) => candidate.step === lease.pass);
          if (step === undefined) {
            throw new Error(`jobScheduler: missing durable step ${lease.pass}`);
          }
          step.status = input.settlement.outcome === "success" ? "done" : "error";
          step.startedAt ??= authorityAt;
          step.finishedAt = input.step?.finishedAt ?? authorityAt;
          step.completedAt = step.finishedAt;
          step.detail = input.step?.detail ?? (
            input.settlement.outcome === "success"
              ? `${lease.pass} pass settled`
              : input.settlement.failure.message
          );
          const stepCost = tx.select({ costUsd: costLog.costUsd }).from(costLog)
            .where(and(eq(costLog.jobId, lease.jobId), eq(costLog.step, lease.pass))).all()
            .reduce((total, row) => total + row.costUsd, 0);
          if (prepared.telemetry.billable || stepCost > 0) step.costUsd = stepCost;
          currentSteps = latest;
          set.stepsJson = JSON.stringify(latest);
          if (
            input.settlement.outcome === "success" &&
            (lease.pass === "bull" || lease.pass === "bear")
          ) {
            const own = lease.pass === "bull" ? "bullJson" : "bearJson";
            const opposite = lease.pass === "bull" ? "bearJson" : "bullJson";
            set[own] = serializeLegacyAnalystProjection(
              input.settlement.data,
              prepared.telemetry,
            );
            set.payloadFingerprint = input.payloadFingerprint;
            if (parent.payloadFingerprint !== input.payloadFingerprint) set[opposite] = null;
          }
        } catch (error) {
          projectionError = error instanceof Error ? error.message : String(error);
          currentSteps = null;
          for (const key of ["stepsJson", "bullJson", "bearJson", "payloadFingerprint"]) {
            delete set[key];
          }
        }
      }
      const revisionUpdate = mutateJobSnapshotInTransaction(tx as ThesisDb, {
        jobId: lease.jobId,
        now: authority,
        forceRevision: true,
        ...(exactLiveCurrent
          ? {
              fence: {
                status: "running",
                runGeneration: lease.runGeneration,
                leaseOwner: lease.jobLeaseOwner,
                leaseValidAfter: authorityAt,
              },
            }
          : {}),
        mutate: () => set,
      });
      if (revisionUpdate === null) {
        throw new Error("jobScheduler: settlement revision fence changed unexpectedly");
      }
      if (exactLiveCurrent) {
        currentRevision = revisionUpdate.revision;
        currentTotalCostUsd = tx.select({ costUsd: costLog.costUsd }).from(costLog)
          .where(eq(costLog.jobId, lease.jobId)).all()
          .reduce((total, row) => total + row.costUsd, 0);
      }
    }
    return {
      ...persisted,
      currentRevision,
      currentSteps,
      currentTotalCostUsd,
      projectionError,
      // A settlement against a presumed row is bounded by the presumed amount,
      // which IS the reservation that was taken for this attempt. A settlement
      // that bills nothing (request-reservation mode records cost per request,
      // so the pass artifact carries the figure without charging it again)
      // cannot over-run a reservation it never draws on.
      overReservation:
        prepared.telemetry.billable &&
        settledMicroUsd(prepared.telemetry.costUsd) >
          BigInt(reservationMicroUsd(exact?.reservedCostUsd ?? presumed?.costUsd ?? 0)),
    };
  }, { behavior: "immediate" });
  if (result.inserted) requestPump(schedulerPumpState());
  if (result.overReservation) {
    throw new PaidPassOverReservationError(result);
  }
  return result;
}
