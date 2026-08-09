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
import {
  costLog,
  jobLlmLeases,
  jobPassArtifacts,
  jobs,
  reports,
} from "@/db/schema";
import {
  preparePassSettlement,
  type PassSettlement,
} from "@/pipeline/jobArtifacts";
import {
  cancelJob,
  claimJobForResume,
  claimPreparedJobResume,
  initialSteps,
  prepareJobResume,
} from "@/pipeline/jobRunner";
import { getJobSnapshot } from "@/pipeline/events";
import type { SchedulerKickOptions, SchedulerLimits } from "@/pipeline/jobScheduler";
import type { AnalystCase } from "@/report/schema";
import type { StepProgress } from "@/types/core";
import { resetConfigCache } from "@/config/env";

const NOW = new Date("2026-08-08T12:00:00.000Z");
const RACE_PHASE_TIMEOUT_MS = 10_000;
// Worker startup and the synchronized SQLite action are separate bounded
// phases. Leave time for both plus worker termination without relaxing any
// non-process test or the suite-wide timeout.
const PROCESS_RACE_TEST_TIMEOUT_MS = 30_000;

const LIMITS = {
  maxActiveJobs: 1,
  maxActiveLlmCalls: 1,
  maxRollingCostUsd: null,
  rollingCostWindowMs: 60 * 60 * 1000,
  paidPassLeaseTtlMs: 15 * 60 * 1000,
  jobLeaseTtlMs: 15 * 60 * 1000,
} as const;

let directory: string;
let first: DatabaseHandle;
let second: DatabaseHandle;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "thesis-job-scheduler-"));
  const file = join(directory, "scheduler.db");
  first = createDatabase(file);
  second = createDatabase(file);
  setDbForTests(first.db);
});

afterEach(async () => {
  const { _resetJobSchedulerForTests } = await scheduler();
  _resetJobSchedulerForTests();
  vi.useRealTimers();
  setDbForTests(null);
  first.sqlite.close();
  second.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

function seedJob(
  db: ThesisDb,
  id: string,
  symbol: string,
  over: Partial<typeof jobs.$inferInsert> = {},
): void {
  const now = NOW.toISOString();
  db.insert(jobs)
    .values({
      id,
      symbol,
      status: "queued",
      stepsJson: JSON.stringify(initialSteps()),
      createdAt: now,
      updatedAt: now,
      queuedAt: now,
      ...over,
    })
    .run();
}

function analystCase(): AnalystCase {
  return {
    thesis: [{ text: "durable thesis", label: "JUDGMENT", source: "payload", asOf: null }],
    keyDrivers: [],
    risksToCase: [],
    catalysts: [],
    priceTarget: { value: 250, horizon: "12mo", assumptions: [] },
    evidence: [],
  };
}

function analystSettlement(costUsd = 0.1): PassSettlement<AnalystCase> {
  return {
    outcome: "success",
    data: analystCase(),
    telemetry: {
      model: "claude-opus-4-8",
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

function invalidStepSnapshots(): Array<[string, string]> {
  const missingTarget = initialSteps().filter((step) => step.step !== "bull");
  const missingNonTarget = initialSteps().filter((step) => step.step !== "verify");
  const duplicate = initialSteps();
  duplicate[4] = { ...duplicate[4]!, step: "bull" };
  const reordered = initialSteps();
  [reordered[3], reordered[4]] = [reordered[4]!, reordered[3]!];
  const unknown: Array<Record<string, unknown>> = initialSteps().map((step) => ({ ...step }));
  unknown[3] = { ...unknown[3], step: "unknown" };
  const invalidStatus: Array<Record<string, unknown>> = initialSteps().map((step) => ({ ...step }));
  invalidStatus[3] = { ...invalidStatus[3], status: "finished" };
  const invalidOptional: Array<Record<string, unknown>> = initialSteps().map((step) => ({ ...step }));
  invalidOptional[3] = { ...invalidOptional[3], costUsd: -1, finishedAt: "not-a-date" };
  return [
    ["malformed JSON", "{not-json"],
    ["missing durable target", JSON.stringify(missingTarget)],
    ["missing non-target step", JSON.stringify(missingNonTarget)],
    ["duplicate step", JSON.stringify(duplicate)],
    ["reordered steps", JSON.stringify(reordered)],
    ["unknown step", JSON.stringify(unknown)],
    ["invalid status", JSON.stringify(invalidStatus)],
    ["invalid optional fields", JSON.stringify(invalidOptional)],
  ];
}

function seedAnalystArtifact(
  db: ThesisDb,
  jobId: string,
  side: "bull" | "bear",
  attemptId: string,
  fingerprint = "1.3.0:source",
): void {
  const input = {
    jobId,
    runGeneration: 0,
    attemptId,
    pass: side,
    settlement: analystSettlement(),
    payloadFingerprint: fingerprint,
    settledAt: NOW.toISOString(),
  } as const;
  const prepared = preparePassSettlement(input);
  db.insert(jobPassArtifacts)
    .values({
      jobId,
      runGeneration: 0,
      attemptId,
      pass: side,
      outcomeJson: prepared.outcomeJson,
      telemetryJson: prepared.telemetryJson,
      costJson: prepared.costJson,
      settledAt: NOW.toISOString(),
    })
    .run();
  db.insert(costLog)
    .values({
      jobId,
      runGeneration: 0,
      attemptId,
      step: side,
      model: prepared.telemetry.model,
      inputTokens: prepared.telemetry.inputTokens,
      outputTokens: prepared.telemetry.outputTokens,
      cacheReadTokens: prepared.telemetry.cacheReadTokens,
      cacheWriteTokens: prepared.telemetry.cacheWriteTokens,
      webSearches: prepared.telemetry.webSearches,
      costUsd: prepared.telemetry.costUsd,
      fallbackUsed: prepared.telemetry.fallbackUsed,
      createdAt: NOW.toISOString(),
    })
    .run();
}

async function scheduler() {
  return import("@/pipeline/jobScheduler");
}

async function underTimedWriterLock<T>(holdMs: number, action: () => T): Promise<T> {
  const writer = new Worker(new URL("./fixtures/sqliteWriteLockWorker.mjs", import.meta.url), {
    workerData: { file: join(directory, "scheduler.db"), holdMs },
  });
  let sentinel: ReturnType<typeof setTimeout> | undefined;
  const locked = new Promise<void>((resolve, reject) => {
    writer.on("message", (message: { state?: string; error?: string }) => {
      if (message.state === "locked") resolve();
      else if (message.error) reject(new Error(message.error));
    });
    writer.on("error", reject);
    sentinel = setTimeout(() => reject(new Error("timed writer did not acquire its lock")), 10_000);
    sentinel.unref();
  });
  const released = new Promise<void>((resolve, reject) => {
    writer.on("message", (message: { state?: string; error?: string }) => {
      if (message.state === "released") resolve();
      else if (message.error) reject(new Error(message.error));
    });
    writer.on("error", reject);
  });
  try {
    await locked;
    if (sentinel !== undefined) clearTimeout(sentinel);
    const result = action();
    await released;
    return result;
  } finally {
    if (sentinel !== undefined) clearTimeout(sentinel);
    await writer.terminate();
  }
}

type RaceAction =
  | {
      kind: "claim";
      workerId: string;
    }
  | {
      kind: "spend";
      claim: Awaited<ReturnType<typeof scheduler>>["claimNextQueuedJob"] extends (
        ...args: never[]
      ) => infer R ? NonNullable<R> : never;
      pass: "bull" | "bear";
      attemptId: string;
      reservationUsd: number;
    };

interface RaceResult {
  claim?: Awaited<ReturnType<typeof scheduler>>["claimNextQueuedJob"] extends (
    ...args: never[]
  ) => infer R ? R : never;
  lease?: Awaited<ReturnType<typeof scheduler>>["acquirePaidPassLease"] extends (
    ...args: never[]
  ) => infer R ? R : never;
}

async function runBarrierRace(
  actions: [RaceAction, RaceAction],
  limits: SchedulerLimits = LIMITS,
): Promise<RaceResult[]> {
  const start = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const ready = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const startView = new Int32Array(start);
  const readyView = new Int32Array(ready);
  const workerUrl = new URL("./fixtures/jobSchedulerRaceWorker.ts", import.meta.url);
  const file = join(directory, "scheduler.db");
  const workers = actions.map((action) => new Worker(workerUrl, {
    execArgv: ["--conditions=react-server", "--import", "tsx"],
    workerData: {
      action,
      file,
      limits,
      nowIso: NOW.toISOString(),
      ready,
      start,
    },
  }));
  const results = workers.map((worker) => new Promise<RaceResult>((resolve, reject) => {
    let settled = false;
    worker.on("message", (message: { ok: boolean; result?: RaceResult; error?: string }) => {
      settled = true;
      if (message.ok && message.result !== undefined) resolve(message.result);
      else reject(new Error(message.error ?? "race worker failed without an error"));
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (!settled && code !== 0) reject(new Error(`race worker exited with code ${code}`));
    });
  }));
  let completionTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    const readyDeadline = Date.now() + RACE_PHASE_TIMEOUT_MS;
    while (Atomics.load(readyView, 0) !== workers.length) {
      if (Date.now() >= readyDeadline) throw new Error("race workers did not reach the barrier");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    Atomics.store(startView, 0, 1);
    Atomics.notify(startView, 0, workers.length);
    return await Promise.race([
      Promise.all(results),
      new Promise<never>((_, reject) => {
        completionTimer = setTimeout(
          () => reject(new Error("race workers did not finish")),
          RACE_PHASE_TIMEOUT_MS,
        );
        completionTimer.unref();
      }),
    ]);
  } finally {
    if (completionTimer !== undefined) clearTimeout(completionTimer);
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

describe("durable job claims", () => {
  it("rolls a queued claim back at the maximum safe revision", async () => {
    const { claimNextQueuedJob } = await scheduler();
    seedJob(first.db, "max-revision-claim", "AAPL", {
      revision: Number.MAX_SAFE_INTEGER,
    });

    expect(() => claimNextQueuedJob("worker", NOW, LIMITS, first.db))
      .toThrow(/safe|overflow|revision/i);
    expect(first.db.select().from(jobs).where(eq(jobs.id, "max-revision-claim")).get())
      .toMatchObject({
        status: "queued",
        revision: Number.MAX_SAFE_INTEGER,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
  });

  it.each([
    {
      name: "falls back from null queuedAt to createdAt",
      rows: [
        { id: "job-later", symbol: "MSFT", queuedAt: "2026-08-08T11:00:00.000Z", createdAt: "2026-08-08T11:00:00.000Z" },
        { id: "job-null", symbol: "AAPL", queuedAt: null, createdAt: "2026-08-08T10:00:00.000Z" },
      ],
      expected: "job-null",
    },
    {
      name: "includes exact-due notBefore and excludes an earlier future row",
      rows: [
        { id: "job-future", symbol: "AAPL", queuedAt: "2026-08-08T09:00:00.000Z", notBefore: "2026-08-08T12:00:00.001Z" },
        { id: "job-due", symbol: "MSFT", queuedAt: "2026-08-08T11:00:00.000Z", notBefore: "2026-08-08T12:00:00.000Z" },
      ],
      expected: "job-due",
    },
    {
      name: "breaks equal createdAt ordering ties by stable id",
      rows: [
        { id: "job-b", symbol: "MSFT", queuedAt: null, createdAt: "2026-08-08T10:00:00.000Z" },
        { id: "job-a", symbol: "AAPL", queuedAt: null, createdAt: "2026-08-08T10:00:00.000Z" },
      ],
      expected: "job-a",
    },
  ])("claims deterministically when it $name", async ({ rows, expected }) => {
    const { claimNextQueuedJob } = await scheduler();
    for (const row of rows) {
      seedJob(first.db, row.id, row.symbol, row);
    }

    expect(claimNextQueuedJob("ordered", NOW, LIMITS, second.db)?.jobId).toBe(expected);
  });

  it("lets two database connections claim a queued row exactly once with a fresh owner nonce", async () => {
    const { claimNextQueuedJob } = await scheduler();
    seedJob(first.db, "job-a", "AAPL");

    const a = claimNextQueuedJob("worker", NOW, LIMITS, first.db);
    const b = claimNextQueuedJob("worker", NOW, LIMITS, second.db);

    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(a?.leaseOwner).not.toBe("worker");
    expect(a?.leaseOwner).toMatch(/^worker:/);
    expect(first.db.select().from(jobs).where(eq(jobs.id, "job-a")).get()).toMatchObject({
      status: "running",
      runGeneration: 0,
      revision: 1,
      leaseOwner: a?.leaseOwner,
      heartbeatAt: NOW.toISOString(),
    });
  });

  it("serializes simultaneous process-level claim contenders with exactly one winner and no lock leak", async () => {
    const { terminalizeClaim } = await scheduler();
    seedJob(first.db, "job-race", "AAPL");

    const results = await runBarrierRace([
      { kind: "claim", workerId: "race-a" },
      { kind: "claim", workerId: "race-b" },
    ]);
    const winners = results.map((result) => result.claim).filter((claim) => claim !== null);

    expect(winners).toHaveLength(1);
    expect(winners[0]?.leaseOwner).toMatch(/^race-[ab]:/);
    expect(first.db.select().from(jobs).where(eq(jobs.id, "job-race")).get()).toMatchObject({
      status: "running",
      revision: 1,
      leaseOwner: winners[0]?.leaseOwner,
    });
    expect(terminalizeClaim(winners[0]!, "error", "race complete", NOW, second.db)).toBe(true);
    seedJob(first.db, "after-race", "MSFT");
    expect((await scheduler()).claimNextQueuedJob("after", NOW, LIMITS, second.db)?.jobId).toBe("after-race");
  }, PROCESS_RACE_TEST_TIMEOUT_MS);

  it("enforces active-job capacity across connections and dispatches the next due job after release", async () => {
    const { claimNextQueuedJob, terminalizeClaim } = await scheduler();
    seedJob(first.db, "job-a", "AAPL", { queuedAt: "2026-08-08T10:00:00.000Z" });
    seedJob(first.db, "job-b", "MSFT", { queuedAt: "2026-08-08T11:00:00.000Z" });

    const a = claimNextQueuedJob("one", NOW, LIMITS, first.db);
    expect(a?.jobId).toBe("job-a");
    expect(claimNextQueuedJob("two", NOW, LIMITS, second.db)).toBeNull();

    expect(terminalizeClaim(a!, "error", "test complete", NOW, first.db)).toBe(true);
    expect(claimNextQueuedJob("two", NOW, LIMITS, second.db)?.jobId).toBe("job-b");
  });

  it("terminalizes expired and legacy-unleased running rows once instead of transferring their generation", async () => {
    const { claimNextQueuedJob } = await scheduler();
    seedJob(first.db, "expired", "AAPL", {
      status: "running",
      revision: 4,
      leaseOwner: "dead:nonce",
      heartbeatAt: "2026-08-08T11:00:00.000Z",
      leaseExpiresAt: NOW.toISOString(),
    });
    seedJob(first.db, "legacy", "MSFT", {
      status: "running",
      revision: 7,
      leaseOwner: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
    });
    seedJob(first.db, "next", "NVDA");

    const claim = claimNextQueuedJob("new", NOW, { ...LIMITS, maxActiveJobs: 3 }, second.db);
    expect(claim?.jobId).toBe("next");
    for (const [id, revision] of [["expired", 5], ["legacy", 8]] as const) {
      expect(second.db.select().from(jobs).where(eq(jobs.id, id)).get()).toMatchObject({
        status: "error",
        runGeneration: 0,
        revision,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
      });
    }
  });

  it("retains a still-live paid reservation when its parent job claim is reconciled as expired", async () => {
    const { reconcileExpiredJobClaims } = await scheduler();
    seedJob(first.db, "expired-with-paid", "AAPL", {
      status: "running",
      revision: 4,
      leaseOwner: "dead:job-owner",
      heartbeatAt: "2026-08-08T11:00:00.000Z",
      leaseExpiresAt: NOW.toISOString(),
    });
    first.db.insert(jobLlmLeases).values({
      permitId: "still-live-paid",
      jobId: "expired-with-paid",
      runGeneration: 0,
      attemptId: "paid-attempt",
      pass: "bull",
      leaseOwner: "paid:owner",
      reservedCostUsd: 0.5,
      acquiredAt: "2026-08-08T11:59:00.000Z",
      leaseExpiresAt: "2026-08-08T12:01:00.000Z",
    }).run();

    expect(reconcileExpiredJobClaims(NOW, second.db)).toBe(1);
    expect(second.db.select().from(jobs).where(eq(jobs.id, "expired-with-paid")).get())
      .toMatchObject({ status: "error", revision: 5, leaseOwner: null });
    expect(second.db.select().from(jobLlmLeases).all()).toEqual([
      expect.objectContaining({ permitId: "still-live-paid", jobId: "expired-with-paid" }),
    ]);
  });

  it("rederives a retry source in the claim transaction and blocks while source-generation paid work is live", async () => {
    const { claimNextQueuedJob } = await scheduler();
    seedJob(first.db, "retry", "AAPL", { runGeneration: 1, revision: 1 });
    seedAnalystArtifact(first.db, "retry", "bull", "source-bull");
    seedAnalystArtifact(first.db, "retry", "bear", "source-bear");
    first.db.insert(jobLlmLeases).values({
      permitId: "source-live",
      jobId: "retry",
      runGeneration: 0,
      attemptId: "source-bear-late",
      pass: "bear",
      leaseOwner: "source:nonce",
      reservedCostUsd: 0.5,
      acquiredAt: NOW.toISOString(),
      leaseExpiresAt: new Date(NOW.getTime() + 1_000).toISOString(),
    }).run();

    expect(claimNextQueuedJob("target", NOW, LIMITS, second.db)).toBeNull();
    expect(second.db.select().from(jobs).where(eq(jobs.id, "retry")).get()?.status).toBe("queued");

    const later = new Date(NOW.getTime() + 1_001);
    const claimed = claimNextQueuedJob("target", later, LIMITS, second.db);
    expect(claimed).toMatchObject({ jobId: "retry", runGeneration: 1 });
    expect(claimed?.preparedResume).toMatchObject({
      sourceGeneration: 0,
      targetGeneration: 1,
      bull: expect.any(Object),
      bear: expect.any(Object),
      synthesize: null,
      verify: null,
    });
  });

  it("preserves the paid source lineage across queued retry cancellation and another retry", async () => {
    const { claimNextQueuedJob, settlePaidPassLease } = await scheduler();
    const fingerprint = "1.3.0:ancestor-lineage";
    const legacyBull = {
      data: analystCase(),
      model: "claude-opus-4-8",
      costUsd: 0.1,
      fallbackUsed: false,
      usage: { input_tokens: 1_000, output_tokens: 500 },
      webSearches: 0,
      fetchedUrls: [],
    };
    seedJob(first.db, "retry-chain", "AAPL", {
      status: "error",
      bullJson: JSON.stringify(legacyBull),
      payloadFingerprint: fingerprint,
    });
    seedAnalystArtifact(first.db, "retry-chain", "bull", "source-bull", fingerprint);
    const ancestorLease = {
      permitId: "ancestor-live-bear",
      jobId: "retry-chain",
      runGeneration: 0,
      attemptId: "ancestor-bear",
      pass: "bear" as const,
      leaseOwner: "ancestor:paid-owner",
      jobLeaseOwner: "ancestor:job-owner",
      reservedCostUsd: 0.5,
      acquiredAt: NOW.toISOString(),
      leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    };
    first.db.insert(jobLlmLeases).values(ancestorLease).run();

    expect(claimJobForResume("retry-chain", "error")).toBe(true);
    expect(cancelJob("retry-chain")).toBe(true);
    expect(claimJobForResume("retry-chain", "error")).toBe(true);
    expect(first.db.select().from(jobs).where(eq(jobs.id, "retry-chain")).get())
      .toMatchObject({ status: "queued", runGeneration: 2 });

    // Generation 2 must still wait for the actual generation-0 paid source;
    // looking only at generation 1 would admit a duplicate bear call.
    expect(claimNextQueuedJob("target", NOW, LIMITS, second.db)).toBeNull();
    expect(second.db.select().from(jobLlmLeases).all()).toEqual([
      expect.objectContaining({ permitId: ancestorLease.permitId, runGeneration: 0 }),
    ]);

    expect(settlePaidPassLease(ancestorLease, {
      settlement: analystSettlement(0.1),
      payloadFingerprint: fingerprint,
      settledAt: NOW.toISOString(),
    }, second.db, NOW)).toMatchObject({ inserted: true });
    const claimed = claimNextQueuedJob("target", NOW, LIMITS, second.db);
    expect(claimed).toMatchObject({ jobId: "retry-chain", runGeneration: 2 });
    expect(claimed?.preparedResume).toMatchObject({
      sourceGeneration: 0,
      targetGeneration: 2,
      bull: expect.any(Object),
      bear: expect.any(Object),
    });
    expect(second.db.select().from(jobLlmLeases).all()).toEqual([]);
  });

  it("treats a linked report visible in the locked claim snapshot as done before any retry work", async () => {
    const { claimNextQueuedJob } = await scheduler();
    seedJob(first.db, "retry", "AAPL", {
      status: "error",
      error: "source synthesize failed",
      revision: 4,
      stepsJson: JSON.stringify([
        { step: "bull", status: "done" },
        { step: "bear", status: "done" },
        { step: "synthesize", status: "error" },
      ] satisfies StepProgress[]),
    });
    seedAnalystArtifact(first.db, "retry", "bull", "source-bull");
    seedAnalystArtifact(first.db, "retry", "bear", "source-bear");
    first.sqlite.pragma("foreign_keys = OFF");
    first.sqlite.prepare("UPDATE jobs SET reportId = 41 WHERE id = 'retry'").run();
    first.sqlite.pragma("foreign_keys = ON");
    const prepared = prepareJobResume("retry", "error");
    expect(prepared).not.toBeNull();
    expect(claimPreparedJobResume(prepared!)).toBe(true);
    expect(first.db.select().from(jobs).where(eq(jobs.id, "retry")).get()).toMatchObject({
      status: "queued",
      runGeneration: 1,
      revision: 5,
      stepsJson: JSON.stringify(initialSteps()),
    });

    first.db.insert(reports).values({
      id: 41,
      symbol: "AAPL",
      createdAt: NOW.toISOString(),
      model: "claude-opus-4-8",
      status: "done",
      reportJson: "{}",
      verificationRate: 0.75,
      costUsd: 1.25,
      specVersion: "1.0.0",
    }).run();
    // A source lease cannot delay a report that already won the durable race.
    first.db.insert(jobLlmLeases).values({
      permitId: "source-live",
      jobId: "retry",
      runGeneration: 0,
      attemptId: "source-late",
      pass: "synthesize",
      leaseOwner: "source:nonce",
      reservedCostUsd: 10,
      acquiredAt: NOW.toISOString(),
      leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    }).run();

    expect(claimNextQueuedJob("target", NOW, LIMITS, second.db)).toBeNull();
    const recovered = second.db.select().from(jobs).where(eq(jobs.id, "retry")).get()!;
    expect(recovered).toMatchObject({
      status: "done",
      runGeneration: 1,
      revision: 6,
      reportId: 41,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    const recoveredSteps = JSON.parse(recovered.stepsJson) as StepProgress[];
    expect(recoveredSteps).toHaveLength(7);
    expect(recoveredSteps.every((step) => step.status === "skipped")).toBe(true);
    expect(recoveredSteps.every((step) =>
      step.detail === "covered by linked persisted report recovered before dispatch"
    )).toBe(true);
    expect(recoveredSteps.some((step) => /error|fail|duplicate/i.test(step.detail ?? "")))
      .toBe(false);
    expect(getJobSnapshot("retry")).toMatchObject({
      status: "done",
      revision: 6,
      steps: recoveredSteps,
    });
    expect(second.db.select().from(jobLlmLeases).all()).toHaveLength(1);
  });

  it("renews only the exact live, unexpired job claim", async () => {
    const { claimNextQueuedJob, renewJobLease } = await scheduler();
    seedJob(first.db, "job-a", "AAPL");
    const claim = claimNextQueuedJob("one", NOW, LIMITS, first.db)!;
    const later = new Date(NOW.getTime() + 60_000);

    expect(renewJobLease({ ...claim, leaseOwner: "one:stale" }, later, LIMITS, second.db)).toBe(false);
    expect(renewJobLease(claim, later, LIMITS, second.db)).toBe(true);
    expect(second.db.select().from(jobs).where(eq(jobs.id, claim.jobId)).get()).toMatchObject({
      heartbeatAt: later.toISOString(),
      leaseExpiresAt: new Date(later.getTime() + LIMITS.jobLeaseTtlMs).toISOString(),
    });
  });

  it("samples claim time after a writer lock crosses queued notBefore", async () => {
    const { claimNextQueuedJob } = await scheduler();
    const started = new Date();
    seedJob(first.db, "becomes-due-under-lock", "AAPL", {
      createdAt: started.toISOString(),
      queuedAt: started.toISOString(),
      notBefore: new Date(started.getTime() + 100).toISOString(),
    });

    const claim = await underTimedWriterLock(250, () =>
      claimNextQueuedJob("after-lock", undefined, LIMITS, second.db));

    expect(claim).toMatchObject({ jobId: "becomes-due-under-lock" });
    expect(second.db.select().from(jobs).where(eq(jobs.id, "becomes-due-under-lock")).get())
      .toMatchObject({ status: "running", leaseOwner: claim?.leaseOwner });
  });

  it("reconciles a job claim that expires while waiting for the writer lock before taking capacity", async () => {
    const { claimNextQueuedJob } = await scheduler();
    const started = new Date();
    seedJob(first.db, "expires-under-lock", "AAPL", {
      status: "running",
      revision: 1,
      createdAt: started.toISOString(),
      queuedAt: started.toISOString(),
      leaseOwner: "crashed:nonce",
      heartbeatAt: started.toISOString(),
      leaseExpiresAt: new Date(started.getTime() + 100).toISOString(),
    });
    seedJob(first.db, "waits-for-capacity", "MSFT", {
      createdAt: started.toISOString(),
      queuedAt: started.toISOString(),
    });

    const claim = await underTimedWriterLock(250, () =>
      claimNextQueuedJob("after-expiry", undefined, LIMITS, second.db));

    expect(claim?.jobId).toBe("waits-for-capacity");
    expect(second.db.select().from(jobs).where(eq(jobs.id, "expires-under-lock")).get())
      .toMatchObject({ status: "error", revision: 2, leaseOwner: null });
  });

  it("samples explicit reconciliation time after its blocking writer lock", async () => {
    const { reconcileExpiredJobClaims } = await scheduler();
    const started = new Date();
    seedJob(first.db, "reconcile-under-lock", "AAPL", {
      status: "running",
      revision: 1,
      createdAt: started.toISOString(),
      queuedAt: started.toISOString(),
      leaseOwner: "crashed:reconcile",
      heartbeatAt: started.toISOString(),
      leaseExpiresAt: new Date(started.getTime() + 100).toISOString(),
    });
    const beforeReconcileMs = Date.now();

    expect(await underTimedWriterLock(250, () =>
      reconcileExpiredJobClaims(undefined, second.db))).toBe(1);

    expect(second.db.select().from(jobs).where(eq(jobs.id, "reconcile-under-lock")).get())
      .toMatchObject({ status: "error", revision: 2, leaseOwner: null });
    expect(Date.parse(
      second.db.select().from(jobs).where(eq(jobs.id, "reconcile-under-lock")).get()!.updatedAt,
    )).toBeGreaterThanOrEqual(beforeReconcileMs + 200);
  });

  it("timestamps cancellation only after its blocking writer lock is acquired", async () => {
    const createdAt = new Date();
    const runningSteps = initialSteps();
    runningSteps[0] = {
      ...runningSteps[0],
      status: "running",
      startedAt: createdAt.toISOString(),
    };
    seedJob(first.db, "cancel-under-lock", "AAPL", {
      createdAt: createdAt.toISOString(),
      queuedAt: createdAt.toISOString(),
      stepsJson: JSON.stringify(runningSteps),
    });
    const beforeCancelMs = Date.now();

    expect(await underTimedWriterLock(250, () => cancelJob("cancel-under-lock"))).toBe(true);

    const canceled = first.db.select().from(jobs).where(eq(jobs.id, "cancel-under-lock")).get()!;
    expect(Date.parse(canceled.updatedAt)).toBeGreaterThanOrEqual(beforeCancelMs + 200);
    expect(canceled).toMatchObject({ status: "error", revision: 1, leaseOwner: null });
    const steps = JSON.parse(canceled.stepsJson) as Array<{ status: string; finishedAt?: string }>;
    expect(steps[0]).toMatchObject({ status: "error", finishedAt: canceled.updatedAt });
  });
});

describe("durable scheduler pump", () => {
  it("fills only job capacity and dispatches the next queued row after terminal completion", async () => {
    const {
      _resetJobSchedulerForTests,
      kickJobScheduler,
      terminalizeClaim,
    } = await scheduler();
    _resetJobSchedulerForTests();
    seedJob(first.db, "job-a", "AAPL", { queuedAt: "2026-08-08T10:00:00.000Z" });
    seedJob(first.db, "job-b", "MSFT", { queuedAt: "2026-08-08T11:00:00.000Z" });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const launched: string[] = [];

    kickJobScheduler(async () => ({} as never), {
      limits: LIMITS,
      runClaim: async (claim) => {
        launched.push(claim.jobId);
        if (claim.jobId === "job-a") await firstGate;
        terminalizeClaim(claim, "error", "test complete", new Date(), first.db);
      },
    });
    await expect.poll(() => launched).toEqual(["job-a"]);
    expect(first.db.select().from(jobs).where(eq(jobs.id, "job-b")).get()?.status).toBe("queued");

    releaseFirst();
    await expect.poll(() => launched).toEqual(["job-a", "job-b"]);
    await expect.poll(() => first.db.select().from(jobs).where(eq(jobs.id, "job-b")).get()?.status)
      .toBe("error");
    _resetJobSchedulerForTests();
  });

  it("terminalizes pass-resolution failure safely and keeps draining the queue", async () => {
    const { _resetJobSchedulerForTests, kickJobScheduler } = await scheduler();
    _resetJobSchedulerForTests();
    seedJob(first.db, "job-a", "AAPL", { queuedAt: "2026-08-08T10:00:00.000Z" });
    seedJob(first.db, "job-b", "MSFT", { queuedAt: "2026-08-08T11:00:00.000Z" });

    kickJobScheduler(async () => {
      throw new Error("secret provider configuration detail");
    }, { limits: LIMITS });

    await expect.poll(() => first.db.select().from(jobs).all().map((row) => row.status))
      .toEqual(["error", "error"]);
    for (const row of first.db.select().from(jobs).all()) {
      expect(row.error).toBe("scheduler pass resolution failed before execution");
      expect(row.error).not.toContain("secret");
      expect(row.leaseOwner).toBeNull();
    }
    _resetJobSchedulerForTests();
  });

  it("dispatches the next job after cancel while preserving the canceled paid reservation", async () => {
    const {
      _resetJobSchedulerForTests,
      acquirePaidPassLease,
      claimNextQueuedJob,
      kickJobScheduler,
      terminalizeClaim,
    } = await scheduler();
    _resetJobSchedulerForTests();
    seedJob(first.db, "job-a", "AAPL", { queuedAt: "2026-08-08T10:00:00.000Z" });
    seedJob(first.db, "job-b", "MSFT", { queuedAt: "2026-08-08T11:00:00.000Z" });
    const firstClaim = claimNextQueuedJob("first", NOW, LIMITS, first.db)!;
    const paid = acquirePaidPassLease(firstClaim, "bull", "in-flight", 0.5, NOW, LIMITS, first.db);
    if (!paid.acquired) throw new Error("fixture paid lease was not acquired");
    expect(cancelJob("job-a")).toBe(true);
    const launched: string[] = [];

    kickJobScheduler(async () => ({} as never), {
      limits: LIMITS,
      now: () => NOW,
      runClaim: async (claim) => {
        launched.push(claim.jobId);
        terminalizeClaim(claim, "error", "test complete", NOW, first.db);
      },
    });

    await expect.poll(() => launched).toEqual(["job-b"]);
    expect(first.db.select().from(jobs).where(eq(jobs.id, "job-a")).get()).toMatchObject({
      status: "error",
      leaseOwner: null,
      revision: 2,
    });
    expect(first.db.select().from(jobLlmLeases).all()).toEqual([
      expect.objectContaining({ permitId: paid.lease.permitId, jobId: "job-a" }),
    ]);
    _resetJobSchedulerForTests();
  });

  it("keeps one durable wake timer for future notBefore work and clears it on reset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const {
      _resetJobSchedulerForTests,
      kickJobScheduler,
      terminalizeClaim,
    } = await scheduler();
    _resetJobSchedulerForTests();
    seedJob(first.db, "future", "AAPL", {
      notBefore: new Date(NOW.getTime() + 100).toISOString(),
    });
    const launched: string[] = [];
    const options: SchedulerKickOptions = {
      limits: LIMITS,
      now: () => new Date(),
      runClaim: async (claim) => {
        launched.push(claim.jobId);
        terminalizeClaim(claim, "error", "test complete", new Date(), first.db);
      },
    };

    kickJobScheduler(async () => ({} as never), options);
    await vi.advanceTimersByTimeAsync(0);
    expect(launched).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);

    // Repeated route/startup kicks replace, rather than multiply, the wake.
    kickJobScheduler(async () => ({} as never), options);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(101);
    expect(launched).toEqual(["future"]);
    _resetJobSchedulerForTests();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reclaims a crash-held job lease and dispatches queued work without another route request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const {
      _resetJobSchedulerForTests,
      kickJobScheduler,
      terminalizeClaim,
    } = await scheduler();
    _resetJobSchedulerForTests();
    seedJob(first.db, "crashed", "AAPL", {
      status: "running",
      revision: 1,
      leaseOwner: "dead:owner",
      heartbeatAt: NOW.toISOString(),
      leaseExpiresAt: new Date(NOW.getTime() + 100).toISOString(),
    });
    seedJob(first.db, "next", "MSFT", { queuedAt: new Date(NOW.getTime() + 1).toISOString() });
    const launched: string[] = [];

    kickJobScheduler(async () => ({} as never), {
      limits: LIMITS,
      now: () => new Date(),
      runClaim: async (claim) => {
        launched.push(claim.jobId);
        terminalizeClaim(claim, "error", "test complete", new Date(), first.db);
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(launched).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(101);
    expect(launched).toEqual(["next"]);
    expect(first.db.select().from(jobs).where(eq(jobs.id, "crashed")).get()?.status).toBe("error");
    _resetJobSchedulerForTests();
  });

  it("wakes when a source-generation paid lease expires and then claims the retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const {
      _resetJobSchedulerForTests,
      kickJobScheduler,
      terminalizeClaim,
    } = await scheduler();
    _resetJobSchedulerForTests();
    seedJob(first.db, "retry", "AAPL", { runGeneration: 1, revision: 1 });
    seedAnalystArtifact(first.db, "retry", "bull", "source-bull");
    seedAnalystArtifact(first.db, "retry", "bear", "source-bear");
    first.db.insert(jobLlmLeases).values({
      permitId: "source-live",
      jobId: "retry",
      runGeneration: 0,
      attemptId: "source-late",
      pass: "bear",
      leaseOwner: "source:nonce",
      reservedCostUsd: 0.5,
      acquiredAt: NOW.toISOString(),
      leaseExpiresAt: new Date(NOW.getTime() + 100).toISOString(),
    }).run();
    const launched: string[] = [];

    kickJobScheduler(async () => ({} as never), {
      limits: LIMITS,
      now: () => new Date(),
      runClaim: async (claim) => {
        launched.push(claim.jobId);
        terminalizeClaim(claim, "error", "test complete", new Date(), first.db);
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(launched).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(101);
    expect(launched).toEqual(["retry"]);
    _resetJobSchedulerForTests();
  });

  it("bootstraps pre-existing durable queue work after a simulated process restart without a route kick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const {
      _resetJobSchedulerForTests,
      terminalizeClaim,
    } = await scheduler();
    _resetJobSchedulerForTests();
    seedJob(first.db, "startup-queued", "AAPL");
    const launched: string[] = [];
    const { bootstrapReportScheduler } = await import("@/pipeline/jobSchedulerBootstrap");

    await bootstrapReportScheduler({
      limits: LIMITS,
      now: () => new Date(),
      runClaim: async (claim) => {
        launched.push(claim.jobId);
        terminalizeClaim(claim, "error", "test complete", new Date(), first.db);
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(launched).toEqual(["startup-queued"]);
    expect(first.db.select().from(jobs).where(eq(jobs.id, "startup-queued")).get()).toMatchObject({
      status: "error",
      revision: 2,
      leaseOwner: null,
    });
  });

  it("retries after a transient cross-process SQLite writer lock without another kick", async () => {
    seedJob(first.db, "locked-queue", "AAPL");
    const release = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const releaseView = new Int32Array(release);
    const writer = new Worker(new URL("./fixtures/sqliteWriteLockWorker.mjs", import.meta.url), {
      workerData: { file: join(directory, "scheduler.db"), release },
    });
    let sentinel: ReturnType<typeof setTimeout> | undefined;
    const locked = new Promise<void>((resolve, reject) => {
      const onMessage = (message: { state?: string; error?: string }): void => {
        if (message.state === "locked") resolve();
        else if (message.error) reject(new Error(message.error));
      };
      writer.on("message", onMessage);
      writer.on("error", reject);
      sentinel = setTimeout(() => reject(new Error("writer did not acquire its lock")), 10_000);
      sentinel.unref();
    });
    try {
      await locked;
      if (sentinel !== undefined) clearTimeout(sentinel);
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      first.sqlite.pragma("busy_timeout = 25");
      const {
        _resetJobSchedulerForTests,
        kickJobScheduler,
        terminalizeClaim,
      } = await scheduler();
      _resetJobSchedulerForTests();
      const launched: string[] = [];

      kickJobScheduler(async () => ({} as never), {
        limits: LIMITS,
        now: () => new Date(),
        runClaim: async (claim) => {
          launched.push(claim.jobId);
          terminalizeClaim(claim, "error", "test complete", new Date(), first.db);
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(launched).toEqual([]);
      expect(vi.getTimerCount()).toBe(1);

      const released = new Promise<void>((resolve, reject) => {
        writer.on("message", (message: { state?: string; error?: string }) => {
          if (message.state === "released") resolve();
          else if (message.error) reject(new Error(message.error));
        });
        writer.on("error", reject);
      });
      Atomics.store(releaseView, 0, 1);
      Atomics.notify(releaseView, 0);
      await released;
      await vi.advanceTimersByTimeAsync(1_001);

      expect(launched).toEqual(["locked-queue"]);
      expect(first.db.select().from(jobs).where(eq(jobs.id, "locked-queue")).get()?.status)
        .toBe("error");
    } finally {
      if (sentinel !== undefined) clearTimeout(sentinel);
      Atomics.store(releaseView, 0, 1);
      Atomics.notify(releaseView, 0);
      await writer.terminate();
    }
  });

  it("retries exact failed-claim terminalization after a transient writer lock", async () => {
    seedJob(first.db, "failed-claim-lock", "AAPL");
    first.sqlite.pragma("busy_timeout = 25");
    const {
      _resetJobSchedulerForTests,
      kickJobScheduler,
    } = await scheduler();
    _resetJobSchedulerForTests();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const writers: Worker[] = [];

    try {
      kickJobScheduler(async () => ({} as never), {
        limits: LIMITS,
        runClaim: async () => {
          const writer = new Worker(new URL("./fixtures/sqliteWriteLockWorker.mjs", import.meta.url), {
            workerData: { file: join(directory, "scheduler.db"), holdMs: 250 },
          });
          writers.push(writer);
          await new Promise<void>((resolve, reject) => {
            const sentinel = setTimeout(
              () => reject(new Error("failed-claim writer did not acquire its lock")),
              10_000,
            );
            sentinel.unref();
            writer.on("message", (message: { state?: string; error?: string }) => {
              if (message.state === "locked") {
                clearTimeout(sentinel);
                resolve();
              } else if (message.error) {
                clearTimeout(sentinel);
                reject(new Error(message.error));
              }
            });
            writer.on("error", (error) => {
              clearTimeout(sentinel);
              reject(error);
            });
          });
          throw new Error("injected scheduler execution failure");
        },
      });

      await expect.poll(
        () => first.db.select().from(jobs).where(eq(jobs.id, "failed-claim-lock")).get()?.status,
        { timeout: 5_000, interval: 50 },
      ).toBe("error");
      expect(first.db.select().from(jobs).where(eq(jobs.id, "failed-claim-lock")).get())
        .toMatchObject({
          error: "scheduler execution failed unexpectedly",
          leaseOwner: null,
          leaseExpiresAt: null,
          revision: 2,
        });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await Promise.all(writers.map((writer) => writer.terminate()));
    }
  });

  it("keeps a wake when notBefore crosses between the claim snapshot and wake recomputation", async () => {
    vi.useFakeTimers();
    const t1 = new Date("2026-08-08T12:00:00.000Z");
    const t2 = new Date(t1.getTime() + 2);
    vi.setSystemTime(t1);
    seedJob(first.db, "boundary-due", "AAPL", {
      notBefore: new Date(t1.getTime() + 1).toISOString(),
    });
    const { kickJobScheduler, terminalizeClaim } = await scheduler();
    const times = [t1, t2];
    let reads = 0;
    const launched: string[] = [];

    kickJobScheduler(async () => ({} as never), {
      limits: LIMITS,
      now: () => times[Math.min(reads++, times.length - 1)]!,
      runClaim: async (claim) => {
        launched.push(claim.jobId);
        terminalizeClaim(claim, "error", "test complete", t2, first.db);
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(launched).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_001);
    expect(launched).toEqual(["boundary-due"]);
  });

  it("recovers after invalid startup config without poisoning the process-local pump", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    seedJob(first.db, "config-recovery", "AAPL");
    const { kickJobScheduler, terminalizeClaim } = await scheduler();
    const launched: string[] = [];
    const options: SchedulerKickOptions = {
      now: () => new Date(),
      runClaim: async (claim) => {
        launched.push(claim.jobId);
        terminalizeClaim(claim, "error", "test complete", new Date(), first.db);
      },
    };

    try {
      vi.stubEnv("THESIS_MAX_ACTIVE_JOBS", "0");
      resetConfigCache();
      kickJobScheduler(async () => ({} as never), options);
      await vi.advanceTimersByTimeAsync(0);
      expect(launched).toEqual([]);

      vi.stubEnv("THESIS_MAX_ACTIVE_JOBS", "1");
      resetConfigCache();
      kickJobScheduler(async () => ({} as never), options);
      await vi.advanceTimersByTimeAsync(0);
      expect(launched).toEqual(["config-recovery"]);
    } finally {
      vi.unstubAllEnvs();
      resetConfigCache();
    }
  });
});

describe("paid-pass leases and exact spend gates", () => {
  it("refuses a paid permit near revision exhaustion while preserving a terminal slot", async () => {
    const { acquirePaidPassLease, claimNextQueuedJob } = await scheduler();
    seedJob(first.db, "revision-headroom-acquire", "AAPL");
    const claim = claimNextQueuedJob("jobs", NOW, LIMITS, first.db)!;
    first.db.update(jobs).set({ revision: Number.MAX_SAFE_INTEGER - 1 })
      .where(eq(jobs.id, claim.jobId)).run();

    expect(acquirePaidPassLease(
      claim,
      "bull",
      "near-max-acquire",
      0.5,
      NOW,
      LIMITS,
      first.db,
    )).toEqual({ acquired: false, reason: "revision-headroom" });
    expect(first.db.select().from(jobLlmLeases).all()).toEqual([]);
    expect(first.db.select().from(jobPassArtifacts).all()).toEqual([]);
    expect(first.db.select().from(costLog).all()).toEqual([]);
  });

  it("enforces global LLM capacity across two database connections and binds the attempt id", async () => {
    const { acquirePaidPassLease, claimNextQueuedJob } = await scheduler();
    seedJob(first.db, "job-a", "AAPL");
    seedJob(first.db, "job-b", "MSFT");
    const jobLimits = { ...LIMITS, maxActiveJobs: 2 };
    const a = claimNextQueuedJob("jobs", NOW, jobLimits, first.db)!;
    const b = claimNextQueuedJob("jobs", NOW, jobLimits, second.db)!;

    const firstLease = acquirePaidPassLease(a, "bull", "attempt-a", 0.5, NOW, jobLimits, first.db);
    const blocked = acquirePaidPassLease(b, "bull", "attempt-b", 0.5, NOW, jobLimits, second.db);

    expect(firstLease).toMatchObject({
      acquired: true,
      lease: { attemptId: "attempt-a", pass: "bull", reservedCostUsd: 0.5 },
    });
    expect(blocked).toEqual({ acquired: false, reason: "capacity" });
  });

  it("atomically allows only one reservation when two sub-cap attempts would exceed the per-job cap", async () => {
    const { acquirePaidPassLease, claimNextQueuedJob } = await scheduler();
    seedJob(first.db, "job-a", "AAPL", { maxCostUsd: 0.99 });
    const claim = claimNextQueuedJob("jobs", NOW, { ...LIMITS, maxActiveLlmCalls: 2 }, first.db)!;

    const a = acquirePaidPassLease(claim, "bull", "attempt-a", 0.5, NOW, { ...LIMITS, maxActiveLlmCalls: 2 }, first.db);
    const b = acquirePaidPassLease(claim, "bear", "attempt-b", 0.5, NOW, { ...LIMITS, maxActiveLlmCalls: 2 }, second.db);

    expect(a.acquired).toBe(true);
    expect(b).toEqual({ acquired: false, reason: "job-budget-pending" });
    expect(second.db.select().from(jobLlmLeases).all()).toHaveLength(1);
  });

  it("serializes simultaneous per-job spend admissions with exactly one reservation and no lock leak", async () => {
    const { claimNextQueuedJob, releaseUnbilledPaidPassLease } = await scheduler();
    seedJob(first.db, "job-race", "AAPL", { maxCostUsd: 0.99 });
    const limits = { ...LIMITS, maxActiveLlmCalls: 2 };
    const claim = claimNextQueuedJob("jobs", NOW, limits, first.db)!;

    const results = await runBarrierRace([
      { kind: "spend", claim, pass: "bull", attemptId: "race-bull", reservationUsd: 0.5 },
      { kind: "spend", claim, pass: "bear", attemptId: "race-bear", reservationUsd: 0.5 },
    ], limits);
    const leases = results.map((result) => result.lease);
    const winners = leases.filter((result) => result?.acquired === true);
    const blocked = leases.filter((result) => result?.acquired === false);

    expect(winners).toHaveLength(1);
    expect(blocked).toEqual([{ acquired: false, reason: "job-budget-pending" }]);
    expect(second.db.select().from(jobLlmLeases).all()).toHaveLength(1);
    const winner = winners[0];
    if (winner?.acquired !== true) throw new Error("race fixture has no winning lease");
    expect(releaseUnbilledPaidPassLease(winner.lease, second.db, NOW)).toBe(true);
    expect(first.db.select().from(jobLlmLeases).all()).toEqual([]);
  }, PROCESS_RACE_TEST_TIMEOUT_MS);

  it("serializes simultaneous rolling-budget admissions across jobs", async () => {
    const { claimNextQueuedJob, releaseUnbilledPaidPassLease } = await scheduler();
    seedJob(first.db, "job-a", "AAPL");
    seedJob(first.db, "job-b", "MSFT", { queuedAt: new Date(NOW.getTime() + 1).toISOString() });
    const limits = {
      ...LIMITS,
      maxActiveJobs: 2,
      maxActiveLlmCalls: 2,
      maxRollingCostUsd: 0.99,
    };
    const a = claimNextQueuedJob("jobs", NOW, limits, first.db)!;
    const b = claimNextQueuedJob("jobs", NOW, limits, second.db)!;

    const results = await runBarrierRace([
      { kind: "spend", claim: a, pass: "bull", attemptId: "race-a", reservationUsd: 0.5 },
      { kind: "spend", claim: b, pass: "bear", attemptId: "race-b", reservationUsd: 0.5 },
    ], limits);
    const leases = results.map((result) => result.lease);
    const winners = leases.filter((result) => result?.acquired === true);

    expect(winners).toHaveLength(1);
    expect(leases.filter((result) => result?.acquired === false)).toEqual([
      { acquired: false, reason: "rolling-budget-pending" },
    ]);
    const winner = winners[0];
    if (winner?.acquired !== true) throw new Error("race fixture has no winning lease");
    expect(releaseUnbilledPaidPassLease(winner.lease, first.db, NOW)).toBe(true);
  }, PROCESS_RACE_TEST_TIMEOUT_MS);

  it("sums every generation, legacy null-attempt costs, and live reservations using micro-USD comparisons", async () => {
    const { acquirePaidPassLease, claimNextQueuedJob } = await scheduler();
    seedJob(first.db, "job-a", "AAPL", { maxCostUsd: 1.000001 });
    first.db.insert(costLog).values([
      { jobId: "job-a", runGeneration: 0, attemptId: null, step: "bull", model: "legacy", costUsd: 0.4, createdAt: NOW.toISOString() },
      { jobId: "job-a", runGeneration: 1, attemptId: "old", step: "bear", model: "m", costUsd: 0.4, createdAt: NOW.toISOString() },
    ]).run();
    const claim = claimNextQueuedJob("jobs", NOW, { ...LIMITS, maxActiveLlmCalls: 3 }, first.db)!;

    expect(acquirePaidPassLease(claim, "bull", "a", 0.2, NOW, { ...LIMITS, maxActiveLlmCalls: 3 }, first.db).acquired).toBe(true);
    expect(acquirePaidPassLease(claim, "bear", "b", 0.000001, NOW, { ...LIMITS, maxActiveLlmCalls: 3 }, second.db).acquired).toBe(true);
    expect(acquirePaidPassLease(claim, "synthesize", "c", 0.000001, NOW, { ...LIMITS, maxActiveLlmCalls: 3 }, second.db)).toEqual({
      acquired: false,
      reason: "job-budget-pending",
    });
  });

  it("ceil-rounds scientific-notation sub-micro costs and guards the safe micro-USD boundary", async () => {
    const {
      acquirePaidPassLease,
      claimNextQueuedJob,
      releaseUnbilledPaidPassLease,
      settlePaidPassLease,
    } = await scheduler();
    seedJob(first.db, "job-a", "AAPL", { maxCostUsd: 0.000002 });
    const limits = { ...LIMITS, maxActiveLlmCalls: 2 };
    const claim = claimNextQueuedJob("jobs", NOW, limits, first.db)!;
    const firstLease = acquirePaidPassLease(claim, "bull", "sub-micro-settle", 1e-7, NOW, limits, first.db);
    if (!firstLease.acquired) throw new Error("sub-micro fixture lease was not acquired");
    expect(firstLease.lease.reservedCostUsd).toBe(0.000001);

    expect(() => settlePaidPassLease(firstLease.lease, {
      settlement: analystSettlement(1e-7),
      payloadFingerprint: "1.3.0:sub-micro",
      settledAt: NOW.toISOString(),
    }, second.db, NOW)).not.toThrow();
    const secondLease = acquirePaidPassLease(claim, "bear", "sub-micro-reserve", 1e-7, NOW, limits, second.db);
    if (!secondLease.acquired) throw new Error("second sub-micro fixture lease was not acquired");
    expect(secondLease.lease.reservedCostUsd).toBe(0.000001);
    expect(acquirePaidPassLease(claim, "synthesize", "over-cap", 1e-7, NOW, limits, first.db)).toEqual({
      acquired: false,
      reason: "job-budget-pending",
    });
    expect(releaseUnbilledPaidPassLease(secondLease.lease, first.db, NOW)).toBe(true);

    seedJob(first.db, "job-boundary", "MSFT");
    const boundaryClaim = claimNextQueuedJob(
      "boundary",
      NOW,
      { ...limits, maxActiveJobs: 2 },
      first.db,
    )!;
    const boundary = acquirePaidPassLease(
      boundaryClaim,
      "verify",
      "safe-boundary",
      9_007_199_254.74099,
      NOW,
      limits,
      first.db,
    );
    if (!boundary.acquired) throw new Error("safe-boundary fixture lease was not acquired");
    expect(releaseUnbilledPaidPassLease(boundary.lease, first.db, NOW)).toBe(true);
    expect(() => acquirePaidPassLease(
      boundaryClaim,
      "verify",
      "unsafe-boundary",
      Number.MAX_SAFE_INTEGER / 1_000_000,
      NOW,
      limits,
      first.db,
    )).toThrow(/safe|precision|range/i);
  });

  it("counts rolling settled rows at the inclusive cutoff and every live reservation regardless of age", async () => {
    const { acquirePaidPassLease, claimNextQueuedJob } = await scheduler();
    seedJob(first.db, "job-a", "AAPL");
    first.db.insert(costLog).values([
      { jobId: "other", runGeneration: 0, attemptId: null, step: "bull", model: "m", costUsd: 0.25, createdAt: "2026-08-08T10:59:59.999Z" },
      { jobId: "other", runGeneration: 0, attemptId: null, step: "bear", model: "m", costUsd: 0.4, createdAt: "2026-08-08T11:00:00.000Z" },
    ]).run();
    const claim = claimNextQueuedJob("jobs", NOW, { ...LIMITS, maxActiveLlmCalls: 3 }, first.db)!;
    first.db.insert(jobLlmLeases).values({
      permitId: "old-but-live",
      jobId: "job-a",
      runGeneration: 0,
      attemptId: "old-live",
      pass: "bull",
      leaseOwner: "old:nonce",
      reservedCostUsd: 0.4,
      acquiredAt: "2025-01-01T00:00:00.000Z",
      leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    }).run();
    const limits = { ...LIMITS, maxActiveLlmCalls: 3, maxRollingCostUsd: 0.99 };

    expect(acquirePaidPassLease(claim, "bear", "new", 0.2, NOW, limits, second.db)).toEqual({
      acquired: false,
      reason: "rolling-budget-pending",
    });
  });

  it("fails a rolling cap immediately when settled cost plus the next bound is already over", async () => {
    const { acquirePaidPassLease, claimNextQueuedJob } = await scheduler();
    seedJob(first.db, "rolling-settled", "AAPL");
    first.db.insert(costLog).values({
      jobId: "rolling-settled",
      runGeneration: 0,
      attemptId: "settled",
      step: "bull",
      model: "m",
      costUsd: 0.9,
      createdAt: NOW.toISOString(),
    }).run();
    const limits = { ...LIMITS, maxRollingCostUsd: 0.99 };
    const claim = claimNextQueuedJob("jobs", NOW, limits, first.db)!;

    expect(acquirePaidPassLease(claim, "bear", "next", 0.2, NOW, limits, second.db))
      .toEqual({ acquired: false, reason: "rolling-budget" });
  });

  it("admits a zero-cost deterministic pass after job and rolling budgets are exhausted", async () => {
    const {
      acquirePaidPassLease,
      claimNextQueuedJob,
      releaseUnbilledPaidPassLease,
    } = await scheduler();
    seedJob(first.db, "zero-cost-verify", "AAPL", { maxCostUsd: 0.5 });
    first.db.insert(costLog).values({
      jobId: "zero-cost-verify",
      runGeneration: 0,
      attemptId: "already-paid",
      step: "synthesize",
      model: "m",
      costUsd: 1,
      createdAt: NOW.toISOString(),
    }).run();
    const limits = { ...LIMITS, maxRollingCostUsd: 0.5 };
    const claim = claimNextQueuedJob("jobs", NOW, limits, first.db)!;

    const acquired = acquirePaidPassLease(
      claim,
      "verify",
      "deterministic-verify",
      0,
      NOW,
      limits,
      second.db,
    );
    expect(acquired).toMatchObject({
      acquired: true,
      lease: { pass: "verify", reservedCostUsd: 0 },
    });
    if (acquired.acquired) {
      expect(releaseUnbilledPaidPassLease(acquired.lease, second.db, NOW)).toBe(true);
    }
  });

  it("reclaims an expired permit with a fresh identity and denies the stale owner renew/release/settle authority", async () => {
    const {
      acquirePaidPassLease,
      claimNextQueuedJob,
      releaseUnbilledPaidPassLease,
      renewPaidPassLease,
      settlePaidPassLease,
    } = await scheduler();
    seedJob(first.db, "job-a", "AAPL");
    const reclaimLimits = { ...LIMITS, jobLeaseTtlMs: LIMITS.jobLeaseTtlMs * 2 };
    const claim = claimNextQueuedJob("jobs", NOW, reclaimLimits, first.db)!;
    const oldResult = acquirePaidPassLease(claim, "bull", "old", 0.5, NOW, reclaimLimits, first.db);
    if (!oldResult.acquired) throw new Error("fixture lease was not acquired");
    const old = oldResult.lease;
    const later = new Date(NOW.getTime() + LIMITS.paidPassLeaseTtlMs + 1);
    const freshResult = acquirePaidPassLease(claim, "bull", "fresh", 0.5, later, reclaimLimits, second.db);
    if (!freshResult.acquired) throw new Error("expired lease was not reclaimed");

    expect(freshResult.lease.permitId).not.toBe(old.permitId);
    expect(freshResult.lease.leaseOwner).not.toBe(old.leaseOwner);
    expect(renewPaidPassLease(old, later, LIMITS, first.db)).toBe(false);
    expect(releaseUnbilledPaidPassLease(old, first.db)).toBe(false);
    expect(() => settlePaidPassLease(old, {
      settlement: analystSettlement(),
      payloadFingerprint: "1.3.0:test",
      settledAt: later.toISOString(),
    }, first.db, later)).toThrow(/lease|stale|authority/i);
    expect(second.db.select().from(jobPassArtifacts).all()).toEqual([]);
    expect(second.db.select().from(costLog).all()).toEqual([]);
    expect(second.db.select().from(jobLlmLeases).all()).toEqual([
      expect.objectContaining({ permitId: freshResult.lease.permitId }),
    ]);
  });

  it("does not let an expired owner release its unreclaimed paid lease", async () => {
    const { acquirePaidPassLease, claimNextQueuedJob, releaseUnbilledPaidPassLease } = await scheduler();
    seedJob(first.db, "job-a", "AAPL");
    const limits = { ...LIMITS, jobLeaseTtlMs: LIMITS.jobLeaseTtlMs * 2 };
    const claim = claimNextQueuedJob("jobs", NOW, limits, first.db)!;
    const acquired = acquirePaidPassLease(claim, "bull", "expired-release", 0.5, NOW, limits, first.db);
    if (!acquired.acquired) throw new Error("fixture lease was not acquired");
    const afterExpiry = new Date(NOW.getTime() + limits.paidPassLeaseTtlMs + 1);

    expect(releaseUnbilledPaidPassLease(acquired.lease, first.db, afterExpiry)).toBe(false);
    expect(first.db.select().from(jobLlmLeases).all()).toEqual([
      expect.objectContaining({ permitId: acquired.lease.permitId }),
    ]);
  });

  it("finalizes a terminal snapshot only when its last prelaunch lease is released", async () => {
    const {
      acquirePaidPassLease,
      claimNextQueuedJob,
      releaseUnbilledPaidPassLease,
    } = await scheduler();
    const limits = { ...LIMITS, maxActiveLlmCalls: 2 };
    seedJob(first.db, "terminal-release", "AAPL");
    const claim = claimNextQueuedJob("jobs", NOW, limits, first.db)!;
    const bull = acquirePaidPassLease(
      claim,
      "bull",
      "terminal-release-bull",
      0.5,
      NOW,
      limits,
      first.db,
    );
    const bear = acquirePaidPassLease(
      claim,
      "bear",
      "terminal-release-bear",
      0.5,
      NOW,
      limits,
      first.db,
    );
    if (!bull.acquired || !bear.acquired) throw new Error("fixture leases were not acquired");
    expect(cancelJob(claim.jobId)).toBe(true);
    const canceled = getJobSnapshot(claim.jobId)!;
    expect(canceled.settlementsPending).toBe(true);

    expect(releaseUnbilledPaidPassLease(bull.lease, first.db, NOW)).toBe(true);
    expect(getJobSnapshot(claim.jobId)).toMatchObject({
      revision: canceled.revision,
      settlementsPending: true,
    });

    expect(releaseUnbilledPaidPassLease(bear.lease, second.db, NOW)).toBe(true);
    expect(getJobSnapshot(claim.jobId)).toMatchObject({
      revision: canceled.revision + 1,
      settlementsPending: false,
    });
  });

  it("arms a durable wake that finalizes a terminal retained lease at expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const {
      acquirePaidPassLease,
      claimNextQueuedJob,
      kickJobScheduler,
    } = await scheduler();
    const limits = {
      ...LIMITS,
      paidPassLeaseTtlMs: 100,
      jobLeaseTtlMs: 1_000,
    };
    seedJob(first.db, "terminal-expiry-wake", "AAPL");
    const claim = claimNextQueuedJob("jobs", NOW, limits, first.db)!;
    const acquired = acquirePaidPassLease(
      claim,
      "bull",
      "terminal-expiry-wake",
      0.5,
      NOW,
      limits,
      first.db,
    );
    if (!acquired.acquired) throw new Error("fixture lease was not acquired");
    expect(cancelJob(claim.jobId)).toBe(true);
    const canceled = getJobSnapshot(claim.jobId)!;
    expect(canceled.settlementsPending).toBe(true);

    kickJobScheduler(async () => ({} as never), {
      limits,
      now: () => new Date(),
      runClaim: async () => {},
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(101);

    expect(first.db.select().from(jobLlmLeases).where(eq(jobLlmLeases.jobId, claim.jobId)).all())
      .toEqual([]);
    expect(getJobSnapshot(claim.jobId)).toMatchObject({
      revision: canceled.revision + 1,
      settlementsPending: false,
    });
  });

  it("finalizes an already-expired terminal lease on one startup scheduler kick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const {
      acquirePaidPassLease,
      claimNextQueuedJob,
      kickJobScheduler,
    } = await scheduler();
    const limits = {
      ...LIMITS,
      paidPassLeaseTtlMs: 100,
      jobLeaseTtlMs: 1_000,
    };
    seedJob(first.db, "terminal-expired-startup", "AAPL");
    const claim = claimNextQueuedJob("jobs", NOW, limits, first.db)!;
    const acquired = acquirePaidPassLease(
      claim,
      "bull",
      "terminal-expired-startup",
      0.5,
      NOW,
      limits,
      first.db,
    );
    if (!acquired.acquired) throw new Error("fixture lease was not acquired");
    expect(cancelJob(claim.jobId)).toBe(true);
    const canceled = getJobSnapshot(claim.jobId)!;
    expect(canceled.settlementsPending).toBe(true);

    first.db.update(jobLlmLeases)
      .set({ leaseExpiresAt: new Date(NOW.getTime() - 1).toISOString() })
      .where(eq(jobLlmLeases.permitId, acquired.lease.permitId))
      .run();
    expect(getJobSnapshot(claim.jobId)).toMatchObject({
      revision: canceled.revision,
      settlementsPending: true,
    });

    kickJobScheduler(async () => ({} as never), {
      limits,
      now: () => new Date(),
      runClaim: async () => {},
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(first.db.select().from(jobLlmLeases).where(eq(jobLlmLeases.jobId, claim.jobId)).all())
      .toEqual([]);
    expect(getJobSnapshot(claim.jobId)).toMatchObject({
      revision: canceled.revision + 1,
      settlementsPending: false,
    });
  });

  it("renews launch leases without a snapshot revision when the visible steps are unchanged", async () => {
    const {
      acquirePaidPassLease,
      authorizePaidPassLaunch,
      claimNextQueuedJob,
    } = await scheduler();
    seedJob(first.db, "launch-revision", "AAPL");
    const claim = claimNextQueuedJob("jobs", NOW, LIMITS, first.db)!;
    const acquired = acquirePaidPassLease(
      claim,
      "bull",
      "launch-revision-attempt",
      0.5,
      NOW,
      LIMITS,
      first.db,
    );
    if (!acquired.acquired) throw new Error("fixture lease was not acquired");
    const unchangedAt = new Date(NOW.getTime() + 1_000);

    expect(authorizePaidPassLaunch(
      acquired.lease,
      claim.revision,
      JSON.stringify(initialSteps()),
      unchangedAt,
      LIMITS,
      second.db,
    )).toMatchObject({ revision: claim.revision, heartbeatAt: unchangedAt.toISOString() });
    expect(second.db.select().from(jobs).where(eq(jobs.id, claim.jobId)).get()).toMatchObject({
      revision: claim.revision,
      updatedAt: NOW.toISOString(),
      heartbeatAt: unchangedAt.toISOString(),
    });

    const changedSteps = initialSteps();
    changedSteps[3] = {
      ...changedSteps[3],
      status: "running",
      startedAt: new Date(NOW.getTime() + 2_000).toISOString(),
    };
    const changedAt = new Date(NOW.getTime() + 2_000);
    expect(authorizePaidPassLaunch(
      acquired.lease,
      claim.revision,
      JSON.stringify(changedSteps),
      changedAt,
      LIMITS,
      second.db,
    )).toMatchObject({ revision: claim.revision + 1, heartbeatAt: changedAt.toISOString() });
    expect(second.db.select().from(jobs).where(eq(jobs.id, claim.jobId)).get()).toMatchObject({
      revision: claim.revision + 1,
      updatedAt: changedAt.toISOString(),
      stepsJson: JSON.stringify(changedSteps),
    });
  });

  it("rechecks revision headroom at authorization before any provider boundary", async () => {
    const {
      acquirePaidPassLease,
      authorizePaidPassLaunch,
      claimNextQueuedJob,
    } = await scheduler();
    seedJob(first.db, "revision-headroom-launch", "AAPL");
    const claim = claimNextQueuedJob("jobs", NOW, LIMITS, first.db)!;
    const acquired = acquirePaidPassLease(
      claim,
      "bull",
      "near-max-launch",
      0.5,
      NOW,
      LIMITS,
      first.db,
    );
    if (!acquired.acquired) throw new Error("fixture lease was not acquired");
    first.db.update(jobs).set({ revision: Number.MAX_SAFE_INTEGER - 2 })
      .where(eq(jobs.id, claim.jobId)).run();
    const candidate = initialSteps();
    candidate[3] = {
      ...candidate[3]!,
      status: "running",
      startedAt: NOW.toISOString(),
    };

    expect(() => authorizePaidPassLaunch(
      acquired.lease,
      claim.revision,
      JSON.stringify(candidate),
      NOW,
      LIMITS,
      second.db,
    )).toThrow(/revision.*headroom/i);
    expect(second.db.select().from(jobs).where(eq(jobs.id, claim.jobId)).get()).toMatchObject({
      revision: Number.MAX_SAFE_INTEGER - 2,
      stepsJson: JSON.stringify(initialSteps()),
    });
    expect(second.db.select().from(jobLlmLeases).all()).toHaveLength(1);
    expect(second.db.select().from(jobPassArtifacts).all()).toEqual([]);
    expect(second.db.select().from(costLog).all()).toEqual([]);
  });

  it("captures renewal authority only after a blocking writer lock is acquired", async () => {
    const { claimNextQueuedJob, renewJobLease } = await scheduler();
    const started = new Date();
    const limits = { ...LIMITS, jobLeaseTtlMs: 100 };
    seedJob(first.db, "job-lock-renew", "AAPL", {
      createdAt: started.toISOString(),
      queuedAt: started.toISOString(),
    });
    const claim = claimNextQueuedJob("jobs", started, limits, first.db)!;

    const renewed = await underTimedWriterLock(250, () =>
      renewJobLease(claim, undefined, limits, first.db));

    expect(renewed).toBe(false);
    expect(first.db.select().from(jobs).where(eq(jobs.id, claim.jobId)).get())
      .toMatchObject({ leaseExpiresAt: claim.leaseExpiresAt });
  });

  it("captures acquisition authority only after a blocking writer lock is acquired", async () => {
    const { acquirePaidPassLease, claimNextQueuedJob } = await scheduler();
    const started = new Date();
    const limits = { ...LIMITS, jobLeaseTtlMs: 100 };
    seedJob(first.db, "job-lock-acquire", "AAPL", {
      createdAt: started.toISOString(),
      queuedAt: started.toISOString(),
    });
    const claim = claimNextQueuedJob("jobs", started, limits, first.db)!;

    await expect(underTimedWriterLock(250, () =>
      acquirePaidPassLease(claim, "bull", "after-lock", 0.5, undefined, limits, first.db)))
      .rejects.toThrow(/live parent claim/i);
    expect(first.db.select().from(jobLlmLeases).all()).toEqual([]);
  });

  it("captures paid renewal and launch authority after a blocking writer lock", async () => {
    const {
      acquirePaidPassLease,
      authorizePaidPassLaunch,
      claimNextQueuedJob,
      renewPaidPassLease,
    } = await scheduler();
    const started = new Date();
    const limits = { ...LIMITS, jobLeaseTtlMs: 100, paidPassLeaseTtlMs: 100 };
    seedJob(first.db, "job-lock-launch", "AAPL", {
      createdAt: started.toISOString(),
      queuedAt: started.toISOString(),
    });
    const claim = claimNextQueuedJob("jobs", started, limits, first.db)!;
    const acquired = acquirePaidPassLease(
      claim,
      "bull",
      "lock-launch",
      0.5,
      started,
      limits,
      first.db,
    );
    if (!acquired.acquired) throw new Error("fixture lease was not acquired");

    const authorized = await underTimedWriterLock(250, () =>
      authorizePaidPassLaunch(
        acquired.lease,
        claim.revision,
        JSON.stringify(initialSteps()),
        undefined,
        limits,
        first.db,
      ));
    expect(authorized).toBeNull();
    expect(renewPaidPassLease(acquired.lease, undefined, limits, second.db)).toBe(false);
  });

  it("captures paid-lease renewal time after the held writer lock", async () => {
    const { acquirePaidPassLease, claimNextQueuedJob, renewPaidPassLease } = await scheduler();
    const started = new Date();
    const limits = { ...LIMITS, jobLeaseTtlMs: 1_000, paidPassLeaseTtlMs: 100 };
    seedJob(first.db, "job-lock-paid-renew", "AAPL", {
      createdAt: started.toISOString(),
      queuedAt: started.toISOString(),
    });
    const claim = claimNextQueuedJob("jobs", started, limits, first.db)!;
    const acquired = acquirePaidPassLease(
      claim,
      "bull",
      "lock-paid-renew",
      0.5,
      started,
      limits,
      first.db,
    );
    if (!acquired.acquired) throw new Error("fixture lease was not acquired");

    const renewed = await underTimedWriterLock(250, () =>
      renewPaidPassLease(acquired.lease, undefined, limits, second.db));

    expect(renewed).toBe(false);
    expect(second.db.select().from(jobLlmLeases).all()).toEqual([
      expect.objectContaining({ leaseExpiresAt: acquired.lease.leaseExpiresAt }),
    ]);
  });
});

describe("atomic paid settlement", () => {
  it.each(invalidStepSnapshots())(
    "fails prelaunch authorization before provider work when stored steps have %s",
    async (_label, corruptStepsJson) => {
      const { acquirePaidPassLease, authorizePaidPassLaunch, claimNextQueuedJob } = await scheduler();
      seedJob(first.db, "job-invalid-prelaunch", "AAPL");
      const claim = claimNextQueuedJob("jobs", NOW, LIMITS, first.db)!;
      const acquired = acquirePaidPassLease(
        claim,
        "bull",
        "invalid-prelaunch",
        0.5,
        NOW,
        LIMITS,
        first.db,
      );
      if (!acquired.acquired) throw new Error("fixture lease was not acquired");
      first.db.update(jobs).set({ stepsJson: corruptStepsJson })
        .where(eq(jobs.id, claim.jobId)).run();
      const candidate = initialSteps();
      candidate.find((step) => step.step === "bull")!.status = "running";

      expect(() => authorizePaidPassLaunch(
        acquired.lease,
        claim.revision,
        JSON.stringify(candidate),
        NOW,
        LIMITS,
        second.db,
      )).toThrow(/invalid persisted step snapshot/i);
      expect(second.db.select().from(jobs).where(eq(jobs.id, claim.jobId)).get())
        .toMatchObject({ revision: claim.revision, stepsJson: corruptStepsJson });
      expect(second.db.select().from(jobLlmLeases).all()).toHaveLength(1);
      expect(second.db.select().from(jobPassArtifacts).all()).toEqual([]);
      expect(second.db.select().from(costLog).all()).toEqual([]);
    },
  );

  it("fails prelaunch authorization on a noncanonical candidate without mutating authority", async () => {
    const { acquirePaidPassLease, authorizePaidPassLaunch, claimNextQueuedJob } = await scheduler();
    seedJob(first.db, "job-invalid-candidate", "AAPL");
    const claim = claimNextQueuedJob("jobs", NOW, LIMITS, first.db)!;
    const acquired = acquirePaidPassLease(
      claim,
      "bull",
      "invalid-candidate",
      0.5,
      NOW,
      LIMITS,
      first.db,
    );
    if (!acquired.acquired) throw new Error("fixture lease was not acquired");
    const candidate = initialSteps().filter((step) => step.step !== "verify");

    expect(() => authorizePaidPassLaunch(
      acquired.lease,
      claim.revision,
      JSON.stringify(candidate),
      NOW,
      LIMITS,
      second.db,
    )).toThrow(/invalid persisted step snapshot/i);
    expect(second.db.select().from(jobs).where(eq(jobs.id, claim.jobId)).get()?.revision)
      .toBe(claim.revision);
    expect(second.db.select().from(jobLlmLeases).all()).toHaveLength(1);
  });

  it("bumps revision with a new exact-current settlement but not an exact replay", async () => {
    const { acquirePaidPassLease, claimNextQueuedJob, settlePaidPassLease } = await scheduler();
    seedJob(first.db, "job-a", "AAPL");
    const claim = claimNextQueuedJob("jobs", NOW, LIMITS, first.db)!;
    const acquired = acquirePaidPassLease(claim, "bull", "revision", 0.5, NOW, LIMITS, first.db);
    if (!acquired.acquired) throw new Error("fixture lease was not acquired");
    const input = {
      settlement: analystSettlement(0.4),
      payloadFingerprint: "1.3.0:revision",
      settledAt: new Date(NOW.getTime() - 60_000).toISOString(),
      step: {
        finishedAt: new Date(NOW.getTime() - 30_000).toISOString(),
        detail: "bull settlement committed",
      },
    };

    const settled = settlePaidPassLease(acquired.lease, input, first.db, NOW);
    expect(settled).toMatchObject({
      inserted: true,
      currentGeneration: true,
      currentRevision: claim.revision + 1,
    });
    const after = first.db.select().from(jobs).where(eq(jobs.id, claim.jobId)).get()!;
    expect(after).toMatchObject({
      revision: claim.revision + 1,
      updatedAt: NOW.toISOString(),
      bullJson: expect.any(String),
    });
    expect(JSON.parse(after.stepsJson)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        step: "bull",
        status: "done",
        detail: "bull settlement committed",
        costUsd: 0.4,
      }),
    ]));

    const replay = settlePaidPassLease(acquired.lease, input, second.db, NOW);
    expect(replay).toMatchObject({ inserted: false, currentRevision: null });
    expect(second.db.select().from(jobs).where(eq(jobs.id, claim.jobId)).get()?.revision)
      .toBe(claim.revision + 1);
  });

  it.each(invalidStepSnapshots())(
    "commits a known charge once when exact-current steps are %s, then reports projection failure",
    async (_label, corruptStepsJson) => {
      const { acquirePaidPassLease, claimNextQueuedJob, settlePaidPassLease } = await scheduler();
      seedJob(first.db, "job-corrupt-settlement", "AAPL");
      const claim = claimNextQueuedJob("jobs", NOW, LIMITS, first.db)!;
      const acquired = acquirePaidPassLease(
        claim,
        "bull",
        "corrupt-settlement",
        0.5,
        NOW,
        LIMITS,
        first.db,
      );
      if (!acquired.acquired) throw new Error("fixture lease was not acquired");
      first.db.update(jobs).set({ stepsJson: corruptStepsJson })
        .where(eq(jobs.id, claim.jobId)).run();
      const input = {
        settlement: analystSettlement(0.4),
        payloadFingerprint: "1.3.0:corrupt-settlement",
        settledAt: NOW.toISOString(),
      };

      const settled = settlePaidPassLease(acquired.lease, input, second.db, NOW);

      expect(settled).toMatchObject({
        inserted: true,
        currentGeneration: true,
        currentRevision: claim.revision + 1,
        currentSteps: null,
        currentTotalCostUsd: 0.4,
        projectionError: expect.stringMatching(/step snapshot|missing durable step/i),
      });
      expect(second.db.select().from(jobPassArtifacts).all()).toHaveLength(1);
      expect(second.db.select().from(costLog).all()).toEqual([
        expect.objectContaining({ costUsd: 0.4 }),
      ]);
      expect(second.db.select().from(jobLlmLeases).all()).toEqual([]);
      expect(second.db.select().from(jobs).where(eq(jobs.id, claim.jobId)).get()).toMatchObject({
        revision: claim.revision + 1,
        stepsJson: corruptStepsJson,
        bullJson: null,
        payloadFingerprint: null,
      });

      expect(settlePaidPassLease(acquired.lease, input, first.db, NOW)).toMatchObject({
        inserted: false,
        currentRevision: null,
      });
      expect(first.db.select().from(jobs).where(eq(jobs.id, claim.jobId)).get()?.revision)
        .toBe(claim.revision + 1);
    },
  );

  it("settles immutable truth with revision-only invalidation after the parent job lease expires", async () => {
    const { acquirePaidPassLease, claimNextQueuedJob, settlePaidPassLease } = await scheduler();
    seedJob(first.db, "job-a", "AAPL");
    const limits = { ...LIMITS, jobLeaseTtlMs: 100, paidPassLeaseTtlMs: 1_000 };
    const claim = claimNextQueuedJob("jobs", NOW, limits, first.db)!;
    const acquired = acquirePaidPassLease(claim, "bull", "parent-expired", 0.5, NOW, limits, first.db);
    if (!acquired.acquired) throw new Error("fixture lease was not acquired");
    const afterParentExpiry = new Date(NOW.getTime() + 101);

    const settled = settlePaidPassLease(acquired.lease, {
      settlement: analystSettlement(0.4),
      payloadFingerprint: "1.3.0:parent-expired",
      settledAt: afterParentExpiry.toISOString(),
    }, second.db, afterParentExpiry);
    expect(settled).toMatchObject({
      inserted: true,
      currentGeneration: false,
      currentRevision: null,
    });
    expect(second.db.select().from(jobPassArtifacts).all()).toHaveLength(1);
    expect(second.db.select().from(costLog).all()).toHaveLength(1);
    expect(second.db.select().from(jobLlmLeases).all()).toEqual([]);
    expect(second.db.select().from(jobs).where(eq(jobs.id, claim.jobId)).get()).toMatchObject({
      revision: claim.revision + 1,
      updatedAt: afterParentExpiry.toISOString(),
      bullJson: null,
      bearJson: null,
      payloadFingerprint: null,
    });
  });

  it("does not backdate settlement authority across a blocking writer lock", async () => {
    const { acquirePaidPassLease, claimNextQueuedJob, settlePaidPassLease } = await scheduler();
    const started = new Date();
    const limits = { ...LIMITS, jobLeaseTtlMs: 1_000, paidPassLeaseTtlMs: 100 };
    seedJob(first.db, "job-lock-settle", "AAPL", {
      createdAt: started.toISOString(),
      queuedAt: started.toISOString(),
    });
    const claim = claimNextQueuedJob("jobs", started, limits, first.db)!;
    const acquired = acquirePaidPassLease(
      claim,
      "bull",
      "lock-settle",
      0.5,
      started,
      limits,
      first.db,
    );
    if (!acquired.acquired) throw new Error("fixture lease was not acquired");

    await expect(underTimedWriterLock(250, () => settlePaidPassLease(acquired.lease, {
      settlement: analystSettlement(0.4),
      payloadFingerprint: "1.3.0:lock-settle",
    }, second.db))).rejects.toThrow(/expired paid-pass lease/i);
    expect(second.db.select().from(jobPassArtifacts).all()).toEqual([]);
    expect(second.db.select().from(costLog).all()).toEqual([]);
    expect(second.db.select().from(jobLlmLeases).all()).toHaveLength(1);
  });

  it("accepts actual cost exactly equal to the reserved micro-USD amount", async () => {
    const { acquirePaidPassLease, claimNextQueuedJob, settlePaidPassLease } = await scheduler();
    seedJob(first.db, "job-exact", "AAPL");
    const claim = claimNextQueuedJob("jobs", NOW, LIMITS, first.db)!;
    const acquired = acquirePaidPassLease(
      claim,
      "bull",
      "exact-reservation",
      0.123456,
      NOW,
      LIMITS,
      first.db,
    );
    if (!acquired.acquired) throw new Error("exact-reservation fixture lease was not acquired");

    expect(settlePaidPassLease(acquired.lease, {
      settlement: analystSettlement(0.123456),
      payloadFingerprint: "1.3.0:exact-reservation",
      settledAt: NOW.toISOString(),
    }, second.db, NOW)).toMatchObject({ inserted: true, overReservation: false });
    expect(second.db.select().from(costLog).all()).toEqual([
      expect.objectContaining({ costUsd: 0.123456 }),
    ]);
    expect(second.db.select().from(jobLlmLeases).all()).toEqual([]);
  });

  it("inserts artifact and cost, projects only under the exact live claim, and deletes the exact lease", async () => {
    const { acquirePaidPassLease, claimNextQueuedJob, settlePaidPassLease } = await scheduler();
    seedJob(first.db, "job-a", "AAPL");
    const claim = claimNextQueuedJob("jobs", NOW, LIMITS, first.db)!;
    const acquired = acquirePaidPassLease(claim, "bull", "attempt", 0.5, NOW, LIMITS, first.db);
    if (!acquired.acquired) throw new Error("fixture lease was not acquired");

    const result = settlePaidPassLease(acquired.lease, {
      settlement: analystSettlement(0.4),
      payloadFingerprint: "1.3.0:test",
      settledAt: NOW.toISOString(),
    }, second.db, NOW);

    expect(result).toMatchObject({ inserted: true, overReservation: false });
    expect(second.db.select().from(jobPassArtifacts).all()).toHaveLength(1);
    expect(second.db.select().from(costLog).all()).toHaveLength(1);
    expect(second.db.select().from(jobLlmLeases).all()).toHaveLength(0);
    expect(second.db.select().from(jobs).where(eq(jobs.id, claim.jobId)).get()).toMatchObject({
      bullJson: expect.any(String),
      payloadFingerprint: "1.3.0:test",
      status: "running",
      leaseOwner: claim.leaseOwner,
    });
  });

  it("cancel-first/settle-second preserves reservation until immutable settlement and cannot mutate current projections", async () => {
    const { acquirePaidPassLease, claimNextQueuedJob, settlePaidPassLease } = await scheduler();
    seedJob(first.db, "job-a", "AAPL");
    const claim = claimNextQueuedJob("jobs", NOW, LIMITS, first.db)!;
    const acquired = acquirePaidPassLease(claim, "bull", "attempt", 0.5, NOW, LIMITS, first.db);
    if (!acquired.acquired) throw new Error("fixture lease was not acquired");

    expect(cancelJob(claim.jobId)).toBe(true);
    const canceled = first.db.select().from(jobs).where(eq(jobs.id, claim.jobId)).get()!;
    expect(canceled).toMatchObject({
      status: "error",
      revision: 2,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      bullJson: null,
      bearJson: null,
      payloadFingerprint: null,
    });
    expect(first.db.select().from(jobLlmLeases).all()).toHaveLength(1);

    const lateInput = {
      settlement: analystSettlement(0.4),
      payloadFingerprint: "1.3.0:late",
      settledAt: NOW.toISOString(),
    };
    settlePaidPassLease(acquired.lease, lateInput, second.db, NOW);
    expect(second.db.select().from(jobPassArtifacts).all()).toHaveLength(1);
    expect(second.db.select().from(costLog).all()).toHaveLength(1);
    expect(second.db.select().from(jobLlmLeases).all()).toHaveLength(0);
    expect(second.db.select().from(jobs).where(eq(jobs.id, claim.jobId)).get()).toMatchObject({
      status: "error",
      revision: 3,
      bullJson: null,
      bearJson: null,
      payloadFingerprint: null,
    });
    expect(settlePaidPassLease(acquired.lease, lateInput, first.db, NOW))
      .toMatchObject({ inserted: false, currentRevision: null });
    expect(first.db.select().from(jobs).where(eq(jobs.id, claim.jobId)).get()?.revision).toBe(3);
  });

  it("invalidates a queued descendant once for a late ancestor charge without projecting it", async () => {
    const { acquirePaidPassLease, claimNextQueuedJob, settlePaidPassLease } = await scheduler();
    seedJob(first.db, "queued-descendant", "AAPL");
    const claim = claimNextQueuedJob("jobs", NOW, LIMITS, first.db)!;
    const acquired = acquirePaidPassLease(claim, "bull", "ancestor", 0.5, NOW, LIMITS, first.db);
    if (!acquired.acquired) throw new Error("fixture lease was not acquired");
    first.db.update(jobs).set({
      status: "queued",
      runGeneration: 1,
      revision: 7,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
    }).where(eq(jobs.id, claim.jobId)).run();

    const input = {
      settlement: analystSettlement(0.4),
      payloadFingerprint: "1.3.0:ancestor",
      settledAt: NOW.toISOString(),
    };
    settlePaidPassLease(acquired.lease, input, second.db, NOW);
    expect(second.db.select().from(jobs).where(eq(jobs.id, claim.jobId)).get()).toMatchObject({
      status: "queued",
      runGeneration: 1,
      revision: 8,
      bullJson: null,
      payloadFingerprint: null,
    });
    settlePaidPassLease(acquired.lease, input, first.db, NOW);
    expect(first.db.select().from(jobs).where(eq(jobs.id, claim.jobId)).get()?.revision).toBe(8);
  });

  it("invalidates cost truth once without projecting through a different valid running generation owner", async () => {
    const {
      acquirePaidPassLease,
      authorizePaidPassLaunch,
      claimNextQueuedJob,
      settlePaidPassLease,
      terminalizeClaim,
    } = await scheduler();
    seedJob(first.db, "different-owner", "AAPL");
    const claim = claimNextQueuedJob("jobs", NOW, LIMITS, first.db)!;
    const acquired = acquirePaidPassLease(claim, "bull", "old-owner", 0.5, NOW, LIMITS, first.db);
    if (!acquired.acquired) throw new Error("fixture lease was not acquired");
    first.db.update(jobs).set({
      status: "running",
      runGeneration: 1,
      revision: 10,
      leaseOwner: "new-owner:nonce",
      heartbeatAt: NOW.toISOString(),
      leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    }).where(eq(jobs.id, claim.jobId)).run();
    const newClaim = {
      jobId: claim.jobId,
      symbol: claim.symbol,
      runGeneration: 1,
      revision: 10,
      leaseOwner: "new-owner:nonce",
      heartbeatAt: NOW.toISOString(),
      leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      preparedResume: null,
    };
    const newOwnerPermit = acquirePaidPassLease(
      newClaim,
      "bear",
      "new-owner-bear",
      0.5,
      NOW,
      { ...LIMITS, maxActiveLlmCalls: 2 },
      first.db,
    );
    if (!newOwnerPermit.acquired) throw new Error("new owner permit was not acquired");

    settlePaidPassLease(acquired.lease, {
      settlement: analystSettlement(0.4),
      payloadFingerprint: "1.3.0:old-owner",
      settledAt: NOW.toISOString(),
    }, second.db, NOW);
    expect(second.db.select().from(jobs).where(eq(jobs.id, claim.jobId)).get()).toMatchObject({
      status: "running",
      runGeneration: 1,
      revision: 11,
      leaseOwner: "new-owner:nonce",
      bullJson: null,
      payloadFingerprint: null,
    });
    expect(second.db.select().from(jobPassArtifacts).all()).toHaveLength(1);
    expect(second.db.select().from(costLog).all()).toHaveLength(1);
    const replay = settlePaidPassLease(acquired.lease, {
      settlement: analystSettlement(0.4),
      payloadFingerprint: "1.3.0:old-owner",
      settledAt: NOW.toISOString(),
    }, first.db, NOW);
    expect(replay).toMatchObject({ inserted: false, currentRevision: null });
    expect(first.db.select().from(jobs).where(eq(jobs.id, claim.jobId)).get()).toMatchObject({
      status: "running",
      runGeneration: 1,
      revision: 11,
      leaseOwner: "new-owner:nonce",
      bullJson: null,
      payloadFingerprint: null,
    });

    const nextSteps = initialSteps();
    nextSteps.find((step) => step.step === "bear")!.status = "running";
    const continued = authorizePaidPassLaunch(
      newOwnerPermit.lease,
      newClaim.revision,
      JSON.stringify(nextSteps),
      new Date(NOW.getTime() + 1),
      { ...LIMITS, maxActiveLlmCalls: 2 },
      second.db,
    );
    expect(continued).toMatchObject({ revision: 12 });
    expect(terminalizeClaim(
      { ...newClaim, revision: continued!.revision },
      "error",
      "new owner completed its fenced cleanup",
      new Date(NOW.getTime() + 2),
      second.db,
    )).toBe(true);
    expect(second.db.select().from(jobs).where(eq(jobs.id, claim.jobId)).get()).toMatchObject({
      status: "error",
      revision: 13,
      leaseOwner: null,
      error: "new owner completed its fenced cleanup",
    });
  });

  it("rebases paid launch on a revision-only cost invalidation without losing newer steps", async () => {
    const {
      acquirePaidPassLease,
      authorizePaidPassLaunch,
      claimNextQueuedJob,
    } = await scheduler();
    seedJob(first.db, "launch-rebase", "AAPL");
    const claim = claimNextQueuedJob("jobs", NOW, LIMITS, first.db)!;
    const acquired = acquirePaidPassLease(
      claim,
      "bull",
      "launch-rebase-attempt",
      0.5,
      NOW,
      LIMITS,
      first.db,
    );
    if (!acquired.acquired) throw new Error("fixture lease was not acquired");

    const concurrent = initialSteps();
    concurrent[0] = {
      ...concurrent[0],
      status: "done",
      finishedAt: NOW.toISOString(),
      completedAt: NOW.toISOString(),
      detail: "concurrent durable fetch",
    };
    const concurrentBull = concurrent.find((step) => step.step === "bull")!;
    concurrentBull.status = "error";
    concurrentBull.finishedAt = NOW.toISOString();
    concurrentBull.completedAt = NOW.toISOString();
    concurrentBull.detail = "stale terminal metadata";
    first.db.update(jobs).set({
      stepsJson: JSON.stringify(concurrent),
      revision: claim.revision + 1,
      updatedAt: new Date(NOW.getTime() + 1).toISOString(),
    }).where(eq(jobs.id, claim.jobId)).run();

    const staleCandidate = initialSteps();
    staleCandidate.find((step) => step.step === "bull")!.status = "running";
    const authorized = authorizePaidPassLaunch(
      acquired.lease,
      claim.revision,
      JSON.stringify(staleCandidate),
      new Date(NOW.getTime() + 2),
      LIMITS,
      second.db,
    );

    expect(authorized).toMatchObject({ revision: claim.revision + 2 });
    const stored = second.db.select().from(jobs).where(eq(jobs.id, claim.jobId)).get()!;
    expect(JSON.parse(stored.stepsJson)).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: "fetch", detail: "concurrent durable fetch" }),
      expect.objectContaining({ step: "bull", status: "running" }),
    ]));
    const storedBull = (JSON.parse(stored.stepsJson) as StepProgress[])
      .find((step) => step.step === "bull")!;
    expect(storedBull).not.toHaveProperty("finishedAt");
    expect(storedBull).not.toHaveProperty("completedAt");
    expect(storedBull).not.toHaveProperty("detail");
  });

  it("commits known cost and artifact before throwing when actual cost exceeds the reservation", async () => {
    const { acquirePaidPassLease, claimNextQueuedJob, settlePaidPassLease } = await scheduler();
    seedJob(first.db, "job-a", "AAPL");
    const claim = claimNextQueuedJob("jobs", NOW, LIMITS, first.db)!;
    const acquired = acquirePaidPassLease(claim, "bull", "attempt", 0.1, NOW, LIMITS, first.db);
    if (!acquired.acquired) throw new Error("fixture lease was not acquired");

    expect(() => settlePaidPassLease(acquired.lease, {
      settlement: analystSettlement(0.100001),
      payloadFingerprint: "1.3.0:over",
      settledAt: NOW.toISOString(),
    }, second.db, NOW)).toThrow(/exceeds.*reservation|invariant/i);
    expect(second.db.select().from(jobPassArtifacts).all()).toHaveLength(1);
    expect(second.db.select().from(costLog).all()).toEqual([
      expect.objectContaining({ costUsd: 0.100001 }),
    ]);
    expect(second.db.select().from(jobLlmLeases).all()).toHaveLength(0);
  });

  it("commits a huge finite charge before raising the invariant and saturates later admission", async () => {
    const { acquirePaidPassLease, claimNextQueuedJob, settlePaidPassLease } = await scheduler();
    seedJob(first.db, "job-a", "AAPL", { maxCostUsd: 1 });
    const claim = claimNextQueuedJob("jobs", NOW, LIMITS, first.db)!;
    const acquired = acquirePaidPassLease(claim, "bull", "huge", 0.5, NOW, LIMITS, first.db);
    if (!acquired.acquired) throw new Error("fixture lease was not acquired");
    const input = {
      settlement: analystSettlement(1e20),
      payloadFingerprint: "1.3.0:huge",
      settledAt: NOW.toISOString(),
    };

    expect(() => settlePaidPassLease(acquired.lease, input, second.db, NOW))
      .toThrow(/exceeds.*reservation|invariant/i);
    expect(second.db.select().from(jobPassArtifacts).all()).toHaveLength(1);
    expect(second.db.select().from(costLog).all()).toEqual([
      expect.objectContaining({ costUsd: 1e20 }),
    ]);
    expect(second.db.select().from(jobLlmLeases).all()).toEqual([]);
    expect(settlePaidPassLease(acquired.lease, input, first.db, NOW)).toMatchObject({
      inserted: false,
      overReservation: false,
    });
    expect(() => settlePaidPassLease(acquired.lease, {
      ...input,
      settlement: analystSettlement(1e20 + 1e10),
    }, first.db, NOW)).toThrow(/conflict|duplicate|mismatch/i);
    expect(acquirePaidPassLease(claim, "bear", "after-huge", 0.000001, NOW, LIMITS, first.db))
      .toEqual({ acquired: false, reason: "job-budget" });
  });

  it("accepts only an exact committed replay after lease deletion and rejects a conflict", async () => {
    const { acquirePaidPassLease, claimNextQueuedJob, settlePaidPassLease } = await scheduler();
    seedJob(first.db, "job-a", "AAPL");
    const claim = claimNextQueuedJob("jobs", NOW, LIMITS, first.db)!;
    const acquired = acquirePaidPassLease(claim, "bull", "attempt", 0.5, NOW, LIMITS, first.db);
    if (!acquired.acquired) throw new Error("fixture lease was not acquired");
    const input = {
      settlement: analystSettlement(0.4),
      payloadFingerprint: "1.3.0:duplicate",
      settledAt: NOW.toISOString(),
    };
    const firstSettlement = settlePaidPassLease(acquired.lease, input, first.db, NOW);

    expect(firstSettlement.inserted).toBe(true);
    expect(settlePaidPassLease(acquired.lease, input, second.db, NOW)).toMatchObject({
      inserted: false,
      overReservation: false,
    });
    expect(() => settlePaidPassLease(acquired.lease, {
      ...input,
      settlement: analystSettlement(0.400001),
    }, second.db, NOW)).toThrow(/conflict|duplicate|mismatch/i);
    expect(second.db.select().from(jobPassArtifacts).all()).toHaveLength(1);
    expect(second.db.select().from(costLog).all()).toHaveLength(1);
  });

  it("denies an expired exact lease before any immutable cost or artifact write", async () => {
    const { acquirePaidPassLease, claimNextQueuedJob, settlePaidPassLease } = await scheduler();
    seedJob(first.db, "job-a", "AAPL");
    const claim = claimNextQueuedJob(
      "jobs",
      NOW,
      { ...LIMITS, jobLeaseTtlMs: LIMITS.jobLeaseTtlMs * 2 },
      first.db,
    )!;
    const acquired = acquirePaidPassLease(claim, "bull", "attempt", 0.5, NOW, LIMITS, first.db);
    if (!acquired.acquired) throw new Error("fixture lease was not acquired");
    const afterExpiry = new Date(NOW.getTime() + LIMITS.paidPassLeaseTtlMs + 1);

    expect(() => settlePaidPassLease(acquired.lease, {
      settlement: analystSettlement(0.4),
      payloadFingerprint: "1.3.0:expired",
      // A stale caller cannot backdate artifact metadata to revive authority.
      settledAt: NOW.toISOString(),
    }, second.db, afterExpiry)).toThrow(/expired|lease|authority|stale/i);
    expect(second.db.select().from(jobPassArtifacts).all()).toEqual([]);
    expect(second.db.select().from(costLog).all()).toEqual([]);
  });

  it("atomically persists an unbillable launched failure but releases a prelaunch exit without an artifact", async () => {
    const {
      acquirePaidPassLease,
      claimNextQueuedJob,
      releaseUnbilledPaidPassLease,
      settlePaidPassLease,
    } = await scheduler();
    seedJob(first.db, "job-a", "AAPL");
    const claim = claimNextQueuedJob("jobs", NOW, { ...LIMITS, maxActiveLlmCalls: 2 }, first.db)!;
    const launched = acquirePaidPassLease(claim, "bull", "launched", 0.5, NOW, { ...LIMITS, maxActiveLlmCalls: 2 }, first.db);
    const prelaunch = acquirePaidPassLease(claim, "bear", "prelaunch", 0.5, NOW, { ...LIMITS, maxActiveLlmCalls: 2 }, first.db);
    if (!launched.acquired || !prelaunch.acquired) throw new Error("fixture leases were not acquired");

    settlePaidPassLease(launched.lease, {
      settlement: {
        outcome: "failure",
        failure: { name: "AbortError", message: "failed before response" },
        telemetry: {
          model: "claude-opus-4-8",
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          webSearches: 0,
          costUsd: 0,
          fallbackUsed: false,
          billable: false,
          fetchedUrls: [],
        },
      },
      payloadFingerprint: "1.3.0:failure",
      settledAt: NOW.toISOString(),
    }, second.db, NOW);
    expect(releaseUnbilledPaidPassLease(prelaunch.lease, second.db, NOW)).toBe(true);
    expect(second.db.select().from(jobPassArtifacts).all()).toHaveLength(1);
    expect(second.db.select().from(costLog).all()).toHaveLength(0);
    expect(second.db.select().from(jobLlmLeases).all()).toHaveLength(0);
  });
});

describe("conservative provider reservation bounds", () => {
  it.each([
    ["claude-haiku-4-5", 70.2, 560.52],
    ["claude-sonnet-5", 517.32, 560.52],
    ["claude-opus-4-8", 856.44, 934.2],
    ["claude-fable-5", 1704.24, 1868.4],
  ])("bounds every retry layer for %s", async (model, analyst, synthesize) => {
    const provider = await import("@/providers/anthropic");
    expect(provider.maximumPassCostUsd(model, "bull")).toBe(analyst);
    expect(provider.maximumPassCostUsd(model, "bear")).toBe(analyst);
    expect(provider.maximumPassCostUsd(model, "synthesize")).toBe(synthesize);
    expect(provider.maximumPassCostUsd(model, "verify", { billable: false })).toBe(0);
  });

  it("accepts only priced aliases or eight-digit snapshots and fails closed for unknown auto/explicit results", async () => {
    const provider = await import("@/providers/anthropic");
    expect(provider.maximumPassCostUsd("claude-opus-4-8-20260601", "bull")).toBe(856.44);
    expect(() => provider.maximumPassCostUsd("claude-opus-4-8-beta", "bull")).toThrow(/unsupported|priced/i);
    expect(() => provider.maximumPassCostUsd("claude-mystery-9", "bull")).toThrow(/unsupported|priced/i);
    await expect(provider.resolveModel("claude-mystery-9")).rejects.toThrow(/unsupported|priced/i);
    expect(() => provider.pickPreferredModel(["claude-mystery-9"])).toThrow(/supported|priced/i);
  });

  it("requires explicit bounded billable capability for non-deterministic verify", async () => {
    const provider = await import("@/providers/anthropic");
    expect(() => provider.maximumPassCostUsd("claude-opus-4-8", "verify")).toThrow(/capability|billable/i);
    expect(provider.maximumPassCostUsd("claude-opus-4-8", "verify", {
      billable: true,
      maxInputTokens: 1_000,
      maxOutputTokens: 500,
      maxWebSearches: 0,
    })).toBeGreaterThan(0);
  });

  it("keeps the provider hard timeout below the default paid-pass lease TTL", async () => {
    const provider = await import("@/providers/anthropic");
    expect(provider.ANTHROPIC_REQUEST_TIMEOUT_MS).toBe(600_000);
    expect(provider.ANTHROPIC_REQUEST_TIMEOUT_MS).toBeLessThan(LIMITS.paidPassLeaseTtlMs);
  });
});
