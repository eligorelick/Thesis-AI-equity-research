/**
 * Spend accounting when a paid pass never settles (DECISIONS D-07).
 *
 * A reservation exists because a provider call was authorized. If the process
 * holding it dies, Anthropic may still have billed up to the reserved
 * maximum, so the reservation becomes PRESUMED spend rather than being
 * returned to the caps. Only evidence moves it down: a late settlement for the
 * same attempt, or Anthropic's own reported totals.
 *
 * Everything here is offline: two SQLite connections and one real worker
 * process share a file; the provider is never called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { eq } from "drizzle-orm";

import {
  createDatabase,
  setDbForTests,
  type DatabaseHandle,
  type ThesisDb,
} from "@/db";
import { costLog, jobLlmLeases, jobPassArtifacts, jobs } from "@/db/schema";
import type { PassSettlement } from "@/pipeline/jobArtifacts";
import { initialSteps } from "@/pipeline/jobRunner";
import {
  acquirePaidPassLease,
  claimNextQueuedJob,
  listPresumedCosts,
  reconcileExpiredJobClaims,
  reconcilePresumedCostsAgainstReportedTotals,
  settlePaidPassLease,
  type ClaimedJob,
  type PaidPassLease,
  type SchedulerLimits,
} from "@/pipeline/jobScheduler";
import type { AnalystCase } from "@/report/schema";

const NOW = new Date("2026-08-08T12:00:00.000Z");
const WORKER_TIMEOUT_MS = 30_000;

const LIMITS: SchedulerLimits = {
  maxActiveJobs: 1,
  maxActiveLlmCalls: 2,
  maxRollingCostUsd: null,
  rollingCostWindowMs: 60 * 60 * 1000,
  paidPassLeaseTtlMs: 15 * 60 * 1000,
  jobLeaseTtlMs: 15 * 60 * 1000,
};

let directory: string;
let file: string;
let first: DatabaseHandle;
let second: DatabaseHandle;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "thesis-presumed-spend-"));
  file = join(directory, "scheduler.db");
  first = createDatabase(file);
  second = createDatabase(file);
  setDbForTests(first.db);
});

afterEach(() => {
  vi.useRealTimers();
  setDbForTests(null);
  first.sqlite.close();
  second.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

function seedJob(db: ThesisDb, id: string, symbol: string, maxCostUsd: number | null = null): void {
  const now = NOW.toISOString();
  db.insert(jobs).values({
    id,
    symbol,
    status: "queued",
    stepsJson: JSON.stringify(initialSteps()),
    createdAt: now,
    updatedAt: now,
    queuedAt: now,
    maxCostUsd,
  }).run();
}

function analystSettlement(costUsd: number): PassSettlement<AnalystCase> {
  return {
    outcome: "success",
    data: {
      thesis: [{ text: "durable thesis", label: "JUDGMENT", source: "payload", asOf: null }],
      keyDrivers: [],
      risksToCase: [],
      catalysts: [],
      priceTarget: { value: 250, horizon: "12mo", assumptions: [] },
      evidence: [],
    },
    telemetry: {
      model: "claude-sonnet-5",
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearches: 0,
      costUsd,
      fallbackUsed: false,
      billable: true,
      fetchedUrls: [],
    },
  };
}

/** Claim a job and reserve one paid pass, both as the same owner. */
function reserve(
  db: ThesisDb,
  jobId: string,
  attemptId: string,
  reservationUsd: number,
  now = NOW,
  pass: "bull" | "bear" = "bull",
): { claim: ClaimedJob; lease: PaidPassLease } {
  const claim = claimNextQueuedJob("owner", now, LIMITS, db);
  if (claim === null || claim.jobId !== jobId) throw new Error("fixture claim failed");
  const acquired = acquirePaidPassLease(
    claim,
    pass,
    attemptId,
    reservationUsd,
    now,
    LIMITS,
    db,
    "claude-sonnet-5",
  );
  if (!acquired.acquired) throw new Error(`fixture reservation failed: ${acquired.reason}`);
  return { claim, lease: acquired.lease };
}

/**
 * Reconciliation past the lease TTL is what the wake timer runs; it sweeps
 * expired paid leases into presumed spend.
 */
function sweepAt(db: ThesisDb, at: Date): void {
  reconcileExpiredJobClaims(at, db);
}

describe("a paid lease that expires without settling", () => {
  it("records the whole reservation as presumed spend instead of returning it to the caps", () => {
    seedJob(first.db, "job-a", "AAPL");
    const { lease } = reserve(first.db, "job-a", "attempt-1", 12.5);
    expect(first.db.select().from(costLog).all()).toEqual([]);

    const afterExpiry = new Date(NOW.getTime() + LIMITS.paidPassLeaseTtlMs + 1);
    sweepAt(second.db, afterExpiry);

    expect(second.db.select().from(jobLlmLeases).where(eq(jobLlmLeases.permitId, lease.permitId)).all())
      .toEqual([]);
    const rows = second.db.select().from(costLog).where(eq(costLog.jobId, "job-a")).all();
    expect(rows).toEqual([
      expect.objectContaining({
        jobId: "job-a",
        step: "bull",
        attemptId: null,
        presumedAttemptId: "attempt-1",
        settlementKind: "presumed",
        model: "claude-sonnet-5",
        costUsd: 12.5,
        reconciledAt: null,
      }),
    ]);
    expect(listPresumedCosts(second.db)).toEqual([
      expect.objectContaining({ jobId: "job-a", attemptId: "attempt-1", pass: "bull", costUsd: 12.5 }),
    ]);
  });

  it("counts presumed spend against the per-job cap so a crash loop cannot spend past it", () => {
    seedJob(first.db, "job-cap", "AAPL", 20);
    reserve(first.db, "job-cap", "attempt-1", 12.5);

    const afterExpiry = new Date(NOW.getTime() + LIMITS.paidPassLeaseTtlMs + 1);
    sweepAt(second.db, afterExpiry);
    expect(listPresumedCosts(second.db)).toHaveLength(1);

    // The job is reclaimable after its own lease expired; the next attempt is
    // admitted only for what is left under the cap.
    second.db.update(jobs).set({ status: "queued", leaseOwner: null, leaseExpiresAt: null })
      .where(eq(jobs.id, "job-cap")).run();
    const claim = claimNextQueuedJob("owner-2", afterExpiry, LIMITS, second.db);
    expect(claim?.jobId).toBe("job-cap");
    expect(acquirePaidPassLease(claim!, "bear", "attempt-2", 12.5, afterExpiry, LIMITS, second.db, "claude-sonnet-5"))
      .toMatchObject({ acquired: false, reason: "job-budget" });
    expect(acquirePaidPassLease(claim!, "bear", "attempt-2", 7.5, afterExpiry, LIMITS, second.db, "claude-sonnet-5"))
      .toMatchObject({ acquired: true });
  });

  it("presumes each expired attempt exactly once, however often the sweep runs", () => {
    seedJob(first.db, "job-b", "AAPL");
    reserve(first.db, "job-b", "attempt-1", 3);
    const afterExpiry = new Date(NOW.getTime() + LIMITS.paidPassLeaseTtlMs + 1);

    sweepAt(second.db, afterExpiry);
    sweepAt(first.db, new Date(afterExpiry.getTime() + 1_000));
    sweepAt(second.db, new Date(afterExpiry.getTime() + 2_000));

    expect(second.db.select().from(costLog).where(eq(costLog.jobId, "job-b")).all()).toHaveLength(1);
  });

  it("leaves a settled attempt alone when a stale lease row expires behind it", () => {
    seedJob(first.db, "job-c", "AAPL");
    const { lease } = reserve(first.db, "job-c", "attempt-1", 9);
    settlePaidPassLease(lease, {
      settlement: analystSettlement(0.42),
      payloadFingerprint: "1.3.0:test",
      settledAt: NOW.toISOString(),
    }, first.db, NOW);

    sweepAt(second.db, new Date(NOW.getTime() + LIMITS.paidPassLeaseTtlMs + 1));

    const rows = second.db.select().from(costLog).where(eq(costLog.jobId, "job-c")).all();
    expect(rows).toEqual([
      expect.objectContaining({ attemptId: "attempt-1", settlementKind: "actual", costUsd: 0.42 }),
    ]);
    expect(listPresumedCosts(second.db)).toEqual([]);
  });
});

describe("reconciling presumed spend downward", () => {
  it("replaces the presumed maximum with measured usage when a late settlement arrives", () => {
    seedJob(first.db, "job-d", "AAPL");
    const { lease } = reserve(first.db, "job-d", "attempt-1", 12.5);
    const afterExpiry = new Date(NOW.getTime() + LIMITS.paidPassLeaseTtlMs + 1);
    sweepAt(second.db, afterExpiry);
    expect(listPresumedCosts(second.db)).toHaveLength(1);

    const settled = settlePaidPassLease(lease, {
      settlement: analystSettlement(0.87),
      payloadFingerprint: "1.3.0:test",
      settledAt: afterExpiry.toISOString(),
    }, second.db, afterExpiry);

    expect(settled).toMatchObject({ inserted: true, overReservation: false });
    expect(listPresumedCosts(second.db)).toEqual([]);
    expect(second.db.select().from(costLog).where(eq(costLog.jobId, "job-d")).all()).toEqual([
      expect.objectContaining({
        attemptId: "attempt-1",
        presumedAttemptId: null,
        settlementKind: "actual",
        costUsd: 0.87,
      }),
    ]);
    expect(second.db.select().from(jobPassArtifacts).all()).toHaveLength(1);
  });

  it("refuses a settlement with neither a live lease nor a presumed row", () => {
    seedJob(first.db, "job-e", "AAPL");
    const { lease } = reserve(first.db, "job-e", "attempt-1", 12.5);
    // Released before launch: nothing was authorized to bill, so nothing is
    // presumed and a later settlement has no authority at all.
    first.db.delete(jobLlmLeases).where(eq(jobLlmLeases.permitId, lease.permitId)).run();

    expect(() => settlePaidPassLease(lease, {
      settlement: analystSettlement(0.5),
      payloadFingerprint: "1.3.0:test",
      settledAt: NOW.toISOString(),
    }, first.db, NOW)).toThrow(/stale|authority/i);
    expect(first.db.select().from(costLog).all()).toEqual([]);
  });

  it("lowers presumed rows to the reported bucket total, in proportion, and never raises one", () => {
    seedJob(first.db, "job-f", "AAPL");
    seedJob(first.db, "job-g", "MSFT", null);
    reserve(first.db, "job-f", "attempt-f", 30);
    first.db.update(jobs).set({ status: "queued", leaseOwner: null, leaseExpiresAt: null })
      .where(eq(jobs.id, "job-f")).run();
    const expiry = new Date(NOW.getTime() + LIMITS.paidPassLeaseTtlMs + 1);
    sweepAt(second.db, expiry);
    // A second presumed attempt in the same bucket, plus one real settlement.
    second.db.insert(costLog).values({
      jobId: "job-g",
      runGeneration: 0,
      attemptId: null,
      presumedAttemptId: "attempt-g",
      settlementKind: "presumed",
      step: "bear",
      model: "claude-sonnet-5",
      costUsd: 10,
      createdAt: expiry.toISOString(),
    }).run();
    second.db.insert(costLog).values({
      jobId: "job-g",
      runGeneration: 0,
      attemptId: "settled-attempt",
      step: "synthesize",
      model: "claude-sonnet-5",
      costUsd: 1,
      createdAt: expiry.toISOString(),
    }).run();

    const bucket = {
      startTime: NOW.toISOString(),
      endTime: new Date(expiry.getTime() + 60_000).toISOString(),
      reportedUsd: 5,
    };
    const applied = reconcilePresumedCostsAgainstReportedTotals([bucket], expiry, second.db);

    // Anthropic reports $5 for the bucket and $1 of it is already accounted
    // for by the real settlement, so $4 remains to split 30:10.
    expect(applied).toEqual([
      expect.objectContaining({ attemptId: "attempt-f", fromUsd: 30, toUsd: 3 }),
      expect.objectContaining({ attemptId: "attempt-g", fromUsd: 10, toUsd: 1 }),
    ]);
    expect(listPresumedCosts(second.db)).toEqual([]);
    const reconciled = second.db.select().from(costLog)
      .where(eq(costLog.settlementKind, "presumed")).all();
    expect(reconciled.map((row) => row.costUsd)).toEqual([3, 1]);
    expect(reconciled.every((row) => row.reconciledAt === expiry.toISOString())).toBe(true);

    // A later report that would RAISE the presumption leaves it untouched.
    expect(reconcilePresumedCostsAgainstReportedTotals(
      [{ ...bucket, reportedUsd: 500 }],
      expiry,
      second.db,
    )).toEqual([]);
  });

  it("leaves presumed rows alone when the reported total already covers them", () => {
    seedJob(first.db, "job-h", "AAPL");
    reserve(first.db, "job-h", "attempt-h", 4);
    const expiry = new Date(NOW.getTime() + LIMITS.paidPassLeaseTtlMs + 1);
    sweepAt(second.db, expiry);

    expect(reconcilePresumedCostsAgainstReportedTotals([{
      startTime: NOW.toISOString(),
      endTime: new Date(expiry.getTime() + 60_000).toISOString(),
      reportedUsd: 40,
    }], expiry, second.db)).toEqual([]);
    expect(listPresumedCosts(second.db)).toEqual([
      expect.objectContaining({ attemptId: "attempt-h", costUsd: 4 }),
    ]);
  });

  it("rejects a malformed reported bucket rather than guessing a window", () => {
    expect(() => reconcilePresumedCostsAgainstReportedTotals([{
      startTime: NOW.toISOString(),
      endTime: NOW.toISOString(),
      reportedUsd: 1,
    }], NOW, first.db)).toThrow(/invalid reported cost bucket/);
  });
});

describe("a crashed process, from the surviving one", () => {
  it("loses no spend, duplicates no paid pass, and keeps the caps across restart", async () => {
    seedJob(first.db, "job-crash", "AAPL", 20);

    const worker = new Worker(new URL("./fixtures/paidPassCrashWorker.ts", import.meta.url), {
      execArgv: ["--conditions=react-server", "--import", "tsx"],
      workerData: {
        file,
        workerId: "crashing",
        pass: "bull",
        attemptId: "crashed-attempt",
        reservationUsd: 12.5,
        model: "claude-sonnet-5",
        limits: LIMITS,
        nowIso: NOW.toISOString(),
      },
    });
    const crashed = await new Promise<{ ok: boolean; error?: string; lease?: PaidPassLease }>(
      (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("crash worker timed out")), WORKER_TIMEOUT_MS);
        timer.unref();
        worker.on("message", (message) => {
          clearTimeout(timer);
          resolve(message as { ok: boolean; error?: string; lease?: PaidPassLease });
        });
        worker.on("error", reject);
      },
    );
    await worker.terminate();
    expect(crashed.ok, crashed.error).toBe(true);

    // While the crashed lease is still live the surviving process must not
    // start a second paid pass for the same job beyond global capacity.
    const duringLease = new Date(NOW.getTime() + 60_000);
    expect(second.db.select().from(jobLlmLeases).all()).toHaveLength(1);
    const stolen = claimNextQueuedJob("survivor", duringLease, LIMITS, second.db);
    expect(stolen).toBeNull();

    // After both leases expire the survivor takes over. The crashed
    // reservation is presumed spent, so the same money cannot be spent twice.
    const afterExpiry = new Date(NOW.getTime() + LIMITS.paidPassLeaseTtlMs + 1);
    sweepAt(second.db, afterExpiry);
    expect(listPresumedCosts(second.db)).toEqual([
      expect.objectContaining({ jobId: "job-crash", attemptId: "crashed-attempt", costUsd: 12.5 }),
    ]);

    second.db.update(jobs).set({ status: "queued", leaseOwner: null, leaseExpiresAt: null })
      .where(eq(jobs.id, "job-crash")).run();
    const resumed = claimNextQueuedJob("survivor", afterExpiry, LIMITS, second.db);
    expect(resumed?.jobId).toBe("job-crash");

    // A fresh attempt gets its own reservation and its own lease row: the
    // crashed attempt is never re-run under the same identity.
    const retry = acquirePaidPassLease(
      resumed!, "bull", "retry-attempt", 7.5, afterExpiry, LIMITS, second.db, "claude-sonnet-5",
    );
    expect(retry).toMatchObject({ acquired: true });
    expect(second.db.select().from(jobLlmLeases).all()).toEqual([
      expect.objectContaining({ attemptId: "retry-attempt" }),
    ]);

    // Presumed 12.5 + reserved 7.5 exactly fills the $20 job cap, so a third
    // pass is refused; "pending" because it is the live reservation, not
    // recorded spend alone, that closes the gap.
    expect(acquirePaidPassLease(
      resumed!, "bear", "third-attempt", 0.01, afterExpiry, LIMITS, second.db, "claude-sonnet-5",
    )).toMatchObject({ acquired: false, reason: "job-budget-pending" });

    if (retry.acquired) {
      settlePaidPassLease(retry.lease, {
        settlement: analystSettlement(1.25),
        payloadFingerprint: "1.3.0:test",
        settledAt: afterExpiry.toISOString(),
      }, second.db, afterExpiry);
    }
    const ledger = second.db.select().from(costLog).where(eq(costLog.jobId, "job-crash")).all();
    expect(ledger).toHaveLength(2);
    expect(ledger.reduce((total, row) => total + row.costUsd, 0)).toBeCloseTo(13.75, 10);
    expect(ledger.filter((row) => row.settlementKind === "presumed")).toHaveLength(1);
  }, WORKER_TIMEOUT_MS);
});
