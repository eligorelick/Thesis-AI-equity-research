/**
 * Per-request cost admission (DECISIONS D-10).
 *
 * Before this, one reservation per pass had to cover every request the pass
 * could make — 108 of them — so a job cap anywhere near real spend rejected
 * every job before it started. Now each provider request is admitted and
 * settled on its own, and a cap can be set at a useful size.
 *
 * Offline throughout: the provider is a fake stream, and admission is the real
 * scheduler running against a temporary SQLite file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { APIError } from "@anthropic-ai/sdk";
import type { BetaMessage, BetaUsage } from "@anthropic-ai/sdk/resources/beta/messages/messages";

import { resetConfigCache } from "@/config/env";
import { createDatabase, setDbForTests, type DatabaseHandle, type ThesisDb } from "@/db";
import { costLog, jobLlmLeases, jobs } from "@/db/schema";
import { initialSteps } from "@/pipeline/jobRunner";
import {
  acquirePaidPassLease,
  claimNextQueuedJob,
  releaseUnbilledPaidPassLease,
  requestAttemptId,
  resizePaidPassLease,
  settlePaidPassLease,
  settleRequestCost,
  type ClaimedJob,
  type PaidPassLease,
  type SchedulerLimits,
} from "@/pipeline/jobScheduler";
import { readGenerationResumeArtifacts } from "@/pipeline/jobArtifacts";
import { readStoredJobResumeInTransaction } from "@/pipeline/jobStore";
import type { AnalystCase } from "@/report/schema";
import {
  JUDGE_ORDER_SETTINGS,
  JUDGE_PASSES_PER_SETTING,
} from "@/pipeline/stageC/judgeProtocol";
import {
  MAX_PROVIDER_WEB_SEARCHES,
  PASS_MAX_REQUESTS,
  _resetAnthropicForTests,
  maximumPassCostUsd,
  maximumRequestCostUsd,
  passWorstCaseCostUsd,
  runPass,
  type RequestAdmission,
  type RequestPermit,
} from "@/providers/anthropic";

const NOW = new Date("2026-08-08T12:00:00.000Z");

const LIMITS: SchedulerLimits = {
  maxActiveJobs: 1,
  maxActiveLlmCalls: 2,
  maxRollingCostUsd: null,
  rollingCostWindowMs: 60 * 60 * 1000,
  paidPassLeaseTtlMs: 15 * 60 * 1000,
  jobLeaseTtlMs: 15 * 60 * 1000,
};

let directory: string;
let first: DatabaseHandle;
let second: DatabaseHandle;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "thesis-request-admission-"));
  const file = join(directory, "scheduler.db");
  first = createDatabase(file);
  second = createDatabase(file);
  setDbForTests(first.db);
});

afterEach(() => {
  vi.useRealTimers();
  _resetAnthropicForTests();
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

function analystCase(): AnalystCase {
  return {
    thesis: [{ text: "t", label: "JUDGMENT", source: "payload", asOf: null }],
    keyDrivers: [],
    risksToCase: [],
    catalysts: [],
    priceTarget: { value: 250, horizon: "12mo", assumptions: [] },
    evidence: [],
  };
}

function usage(over: Partial<BetaUsage> = {}): BetaUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: null,
    inference_geo: null,
    iterations: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    speed: null,
    ...over,
  } as BetaUsage;
}

function message(over: Record<string, unknown> = {}): BetaMessage {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [{ type: "text", text: '{"ok":true}', citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: usage(),
    ...over,
  } as unknown as BetaMessage;
}

/** A stream that emits its events then resolves or fails. */
function fakeStream(script: { events?: unknown[]; final?: BetaMessage; failWith?: unknown }) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const add = (name: string, fn: (...args: unknown[]) => void): void => {
    listeners.set(name, [...(listeners.get(name) ?? []), fn]);
  };
  let settle!: { resolve: (m: BetaMessage) => void; reject: (e: unknown) => void };
  const finalPromise = new Promise<BetaMessage>((resolve, reject) => {
    settle = { resolve, reject };
  });
  finalPromise.catch(() => {});
  queueMicrotask(() => {
    for (const event of script.events ?? []) {
      for (const fn of listeners.get("streamEvent") ?? []) fn(event);
    }
    if (script.failWith !== undefined) settle.reject(script.failWith);
    else if (script.final !== undefined) settle.resolve(script.final);
  });
  return {
    on: add,
    once: add,
    finalMessage: () => finalPromise,
    abort: () => {},
  };
}

function fakeClient(scripts: Array<{ events?: unknown[]; final?: BetaMessage; failWith?: unknown }>): Anthropic {
  let i = 0;
  return {
    beta: {
      messages: {
        stream: () => fakeStream(scripts[Math.min(i++, scripts.length - 1)]!),
        create: async () => message(),
      },
    },
  } as unknown as Anthropic;
}

function midStreamOverload(): APIError {
  return new APIError(
    undefined,
    { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } as never,
    undefined,
    undefined,
    "overloaded_error",
  );
}

/** The real scheduler as the provider's admission, for one pass attempt. */
function schedulerAdmission(
  claim: ClaimedJob,
  pass: "bull" | "synthesize",
  passAttemptId: string,
  db: ThesisDb,
): { admission: RequestAdmission; reserved: number[]; leases: Map<string, PaidPassLease> } {
  const leases = new Map<string, PaidPassLease>();
  const reserved: number[] = [];
  let sequence = 0;
  return {
    reserved,
    leases,
    admission: {
      reserve: async ({ maximumUsd }) => {
        sequence += 1;
        const acquired = acquirePaidPassLease(
          claim, pass, requestAttemptId(passAttemptId, sequence), maximumUsd,
          NOW, LIMITS, db, "claude-sonnet-5",
        );
        if (!acquired.acquired) throw new Error(`paid ${pass} request blocked by ${acquired.reason}`);
        leases.set(acquired.lease.permitId, acquired.lease);
        reserved.push(acquired.lease.reservedCostUsd);
        return { id: acquired.lease.permitId, maximumUsd: acquired.lease.reservedCostUsd };
      },
      settle: async (permit: RequestPermit, settled) => {
        const lease = leases.get(permit.id);
        if (lease === undefined) return;
        leases.delete(permit.id);
        settleRequestCost(lease, {
          model: settled.model,
          inputTokens: settled.usage?.input_tokens ?? 0,
          outputTokens: settled.usage?.output_tokens ?? 0,
          cacheReadTokens: settled.usage?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: settled.usage?.cache_creation_input_tokens ?? 0,
          webSearches: settled.webSearches,
          costUsd: settled.costUsd,
          fallbackUsed: settled.fallbackUsed,
          ...(settled.presumed === true ? { presumed: true } : {}),
        }, NOW, db);
      },
      release: async (permit: RequestPermit) => {
        const lease = leases.get(permit.id);
        if (lease === undefined) return;
        leases.delete(permit.id);
        releaseUnbilledPaidPassLease(lease, db, NOW);
      },
    },
  };
}

const passOpts = {
  model: "claude-sonnet-5",
  system: "system",
  messages: [{ role: "user" as const, content: "hi" }],
  maxTokens: 8_000,
  field: "llm.bull",
  reservationPass: "bull" as const,
};

describe("what one request may cost", () => {
  it("bounds a request by context at the cache-write price, the output ceiling and the search cap", () => {
    // Sonnet 5: 1M input at $2.50/MTok (5-minute cache write) + 128K output at
    // $10/MTok + 8 searches at $0.01.
    expect(maximumRequestCostUsd("claude-sonnet-5", "bull")).toBeCloseTo(2.5 + 1.28 + 0.08, 6);
    // The judge never searches.
    expect(maximumRequestCostUsd("claude-sonnet-5", "synthesize")).toBeCloseTo(2.5 + 1.28, 6);
    // Haiku's judge runs on the Sonnet floor, so it is bounded there.
    expect(maximumRequestCostUsd("claude-haiku-4-5", "synthesize"))
      .toBe(maximumRequestCostUsd("claude-sonnet-5", "synthesize"));
    expect(maximumRequestCostUsd("claude-haiku-4-5", "bull"))
      .toBeCloseTo(0.25 + 0.32 + 0.08, 6);
    expect(MAX_PROVIDER_WEB_SEARCHES).toBe(8);
  });

  it("reports the pass worst case without reserving it", () => {
    const perRequest = maximumRequestCostUsd("claude-sonnet-5", "bull");
    expect(passWorstCaseCostUsd("claude-sonnet-5", "bull")).toBeCloseTo(perRequest * PASS_MAX_REQUESTS, 5);
    expect(PASS_MAX_REQUESTS).toBe(36);
  });

  it("sizes the JUDGE worst case and pass bound for the orders the setting runs", () => {
    // WS7 (D-20), 2026-09 review: `THESIS_JUDGE_ORDER=both` issues a MIRRORED
    // second judge request per attempt. The published worst case and the
    // "pass"-mode reservation were both sized for one order, so the figure
    // understated the real exposure by two times and, in pass mode (which has
    // no per-request admission at all), two requests shared one reservation
    // sized for one.
    const perRequest = maximumRequestCostUsd("claude-sonnet-5", "synthesize");
    const oneOrder = passWorstCaseCostUsd("claude-sonnet-5", "synthesize");
    expect(oneOrder).toBeCloseTo(perRequest * PASS_MAX_REQUESTS, 5);
    expect(
      passWorstCaseCostUsd("claude-sonnet-5", "synthesize", undefined, JUDGE_PASSES_PER_SETTING.both),
    ).toBeCloseTo(oneOrder * 2, 5);
    expect(
      maximumPassCostUsd("claude-sonnet-5", "synthesize", undefined, JUDGE_PASSES_PER_SETTING.both),
    ).toBeCloseTo(maximumPassCostUsd("claude-sonnet-5", "synthesize") * 2, 5);

    // Only the judge multiplies, and only when the setting says two orders.
    for (const setting of JUDGE_ORDER_SETTINGS.filter((value) => value !== "both")) {
      expect(
        passWorstCaseCostUsd("claude-sonnet-5", "synthesize", undefined, JUDGE_PASSES_PER_SETTING[setting]),
      ).toBeCloseTo(oneOrder, 5);
    }
    for (const pass of ["bull", "bear"] as const) {
      expect(
        passWorstCaseCostUsd("claude-sonnet-5", pass, undefined, JUDGE_PASSES_PER_SETTING.both),
      ).toBeCloseTo(passWorstCaseCostUsd("claude-sonnet-5", pass), 5);
      expect(
        maximumPassCostUsd("claude-sonnet-5", pass, undefined, JUDGE_PASSES_PER_SETTING.both),
      ).toBeCloseTo(maximumPassCostUsd("claude-sonnet-5", pass), 5);
    }
  });

  it("refuses a verify bound without explicit capability metadata", () => {
    expect(() => maximumRequestCostUsd("claude-sonnet-5", "verify")).toThrow(/capability|billable/i);
    expect(maximumRequestCostUsd("claude-sonnet-5", "verify", { billable: false })).toBe(0);
  });
});

describe("a paid pass settled in request mode is still resumable", () => {
  it("pairs a `#rN` request cost row with its pass artifact instead of calling it an orphan", () => {
    seedJob(first.db, "job-resume", "AAPL");
    const claim = claimNextQueuedJob("owner", NOW, LIMITS, first.db)!;
    const attemptId = "pass-attempt";

    // The exact shape request mode leaves behind: a pass lease taken for one
    // request maximum, one request settled under `<attempt>#r1`, and the pass
    // artifact written under the bare attempt id with billable false (the
    // request already billed it).
    const passLease = acquirePaidPassLease(
      claim, "bull", attemptId, maximumRequestCostUsd("claude-sonnet-5", "bull"),
      NOW, LIMITS, first.db, "claude-sonnet-5",
    );
    if (!passLease.acquired) throw new Error("fixture pass lease failed");
    const requestLease = acquirePaidPassLease(
      claim, "bull", requestAttemptId(attemptId, 1),
      maximumRequestCostUsd("claude-sonnet-5", "bull"), NOW, LIMITS, first.db, "claude-sonnet-5",
    );
    if (!requestLease.acquired) throw new Error("fixture request lease failed");
    settleRequestCost(requestLease.lease, {
      model: "claude-sonnet-5",
      inputTokens: 40_000,
      outputTokens: 6_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 12_000,
      webSearches: 2,
      costUsd: 0.21,
      fallbackUsed: false,
    }, NOW, first.db);
    const settled = settlePaidPassLease(passLease.lease, {
      settlement: {
        outcome: "success",
        data: analystCase(),
        telemetry: {
          model: "claude-sonnet-5",
          inputTokens: 40_000,
          outputTokens: 6_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 12_000,
          webSearches: 2,
          costUsd: 0.21,
          fallbackUsed: false,
          billable: false,
          fetchedUrls: [],
        },
      },
      payloadFingerprint: "1.3.0:request-mode",
    }, first.db, NOW);
    expect(settled.inserted).toBe(true);

    // One request row, no pass row: exactly what the reader used to reject.
    const rows = first.db.select().from(costLog).where(eq(costLog.jobId, "job-resume")).all();
    expect(rows.map((row) => row.attemptId)).toEqual([requestAttemptId(attemptId, 1)]);

    const read = readGenerationResumeArtifacts(first.db, "job-resume", 0);
    expect(read.corruptPasses).toEqual([]);
    expect(read.artifacts).toHaveLength(1);

    first.db.update(jobs)
      .set({ status: "error", error: "killed mid-run" })
      .where(eq(jobs.id, "job-resume"))
      .run();
    const resume = readStoredJobResumeInTransaction(first.db, "job-resume")!;
    expect(resume.plan.state.resumable).toBe(true);
    expect(resume.plan.state.reusablePasses).toContain("bull");
    expect(resume.plan.bull?.data).toEqual(analystCase());
  });

  it("still rejects a cost row that belongs to no artifact at all", () => {
    seedJob(first.db, "job-orphan", "AAPL");
    const claim = claimNextQueuedJob("owner", NOW, LIMITS, first.db)!;
    const stray = acquirePaidPassLease(
      claim, "bull", requestAttemptId("some-other-attempt", 1), 1, NOW, LIMITS, first.db, "claude-sonnet-5",
    );
    if (!stray.acquired) throw new Error("fixture lease failed");
    settleRequestCost(stray.lease, {
      model: "claude-sonnet-5",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearches: 0,
      costUsd: 0.5,
      fallbackUsed: false,
    }, NOW, first.db);

    const read = readGenerationResumeArtifacts(first.db, "job-orphan", 0);
    expect(read.corruptPasses).toEqual(["bull"]);
    expect(read.corruptionReasons.bull).toMatch(/cost row exists without its artifact/);
  });
});

describe("every provider request is admitted and settled on its own", () => {
  it("reserves once per attempt and records one cost row per request", async () => {
    seedJob(first.db, "job-a", "AAPL");
    const claim = claimNextQueuedJob("owner", NOW, LIMITS, first.db)!;
    const { admission, reserved } = schedulerAdmission(claim, "bull", "pass-attempt", first.db);
    _resetAnthropicForTests(fakeClient([
      { events: [{ type: "message_start", message: message({ usage: usage({ input_tokens: 1_000 }) }) }], failWith: midStreamOverload() },
      { events: [{ type: "message_start", message: message() }], final: message({ usage: usage({ input_tokens: 2_000, output_tokens: 500 }) }) },
    ]));
    const { _setTransportRetrySleepForTests } = await import("@/providers/anthropic");
    _setTransportRetrySleepForTests(async () => {});

    const result = await runPass({ ...passOpts, admission });

    expect(result.ok).toBe(true);
    // Two requests: the failed attempt and the retry, each with its own
    // reservation at the per-request maximum.
    expect(reserved).toEqual([
      maximumRequestCostUsd("claude-sonnet-5", "bull"),
      maximumRequestCostUsd("claude-sonnet-5", "bull"),
    ]);
    const rows = first.db.select().from(costLog).where(eq(costLog.jobId, "job-a")).all();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.attemptId)).toEqual([
      requestAttemptId("pass-attempt", 1),
      requestAttemptId("pass-attempt", 2),
    ]);
    expect(rows.every((row) => row.settlementKind === "actual")).toBe(true);
    // No reservation outlives the pass.
    expect(first.db.select().from(jobLlmLeases).all()).toEqual([]);
  });

  it("settles a request that never reached the provider at zero", async () => {
    seedJob(first.db, "job-b", "AAPL");
    const claim = claimNextQueuedJob("owner", NOW, LIMITS, first.db)!;
    const { admission } = schedulerAdmission(claim, "bull", "pass-attempt", first.db);
    _resetAnthropicForTests(fakeClient([{ failWith: new APIError(400, { type: "error", error: { type: "invalid_request_error", message: "bad" } } as never, "bad", new Headers()) }]));

    const result = await runPass({ ...passOpts, admission });

    expect(result.ok).toBe(false);
    expect(first.db.select().from(costLog).all()).toEqual([]);
    expect(first.db.select().from(jobLlmLeases).all()).toEqual([]);
  });

  it("presumes the maximum for a request that was sent and then timed out", async () => {
    seedJob(first.db, "job-c", "AAPL");
    const claim = claimNextQueuedJob("owner", NOW, LIMITS, first.db)!;
    const { admission } = schedulerAdmission(claim, "bull", "pass-attempt", first.db);
    process.env.THESIS_STREAM_IDLE_SECONDS = "1";
    resetConfigCache();
    try {
      _resetAnthropicForTests(fakeClient([
        // Accepted, streamed a little, then silence.
        { events: [{ type: "message_start", message: message({ usage: usage({ input_tokens: 1_000, output_tokens: 100 }) }) }] },
      ]));

      const result = await runPass({ ...passOpts, admission });

      expect(result.ok).toBe(false);
      const rows = first.db.select().from(costLog).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ settlementKind: "presumed", attemptId: requestAttemptId("pass-attempt", 1) });
      // Reported usage plus the presumed remainder, never above the bound.
      expect(rows[0]!.costUsd).toBeGreaterThan(0);
      expect(rows[0]!.costUsd).toBeLessThanOrEqual(maximumRequestCostUsd("claude-sonnet-5", "bull"));
    } finally {
      delete process.env.THESIS_STREAM_IDLE_SECONDS;
      resetConfigCache();
    }
  }, 15_000);

  it("stops at a request boundary when the cap refuses the next request, keeping what was billed", async () => {
    // The cap admits the first request and nothing after it.
    const oneRequest = maximumRequestCostUsd("claude-sonnet-5", "bull");
    seedJob(first.db, "job-d", "AAPL", oneRequest);
    const claim = claimNextQueuedJob("owner", NOW, LIMITS, first.db)!;
    const { admission } = schedulerAdmission(claim, "bull", "pass-attempt", first.db);
    _resetAnthropicForTests(fakeClient([
      { events: [{ type: "message_start", message: message({ usage: usage({ input_tokens: 1_000, output_tokens: 10 }) }) }], failWith: midStreamOverload() },
    ]));
    const { _setTransportRetrySleepForTests } = await import("@/providers/anthropic");
    _setTransportRetrySleepForTests(async () => {});

    const result = await runPass({ ...passOpts, admission });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("transport");
    expect(result.error.message).toMatch(/spend admission refused request/);
    expect(result.gap.reason).toMatch(/stopped at a request boundary/);
    // What the first request billed is disclosed, not lost.
    expect(result.error.costUsd ?? 0).toBeGreaterThan(0);
    const rows = first.db.select().from(costLog).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.costUsd).toBeGreaterThan(0);
  });
});

describe("spend caps at a usable size", () => {
  it("admits a Sonnet 5 fixture-shaped run under a $5 per-job cap", () => {
    seedJob(first.db, "job-e", "AAPL", 5);
    const claim = claimNextQueuedJob("owner", NOW, LIMITS, first.db)!;
    const perRequest = maximumRequestCostUsd("claude-sonnet-5", "bull");
    expect(perRequest).toBeLessThan(5);

    // A fixture run makes one request per analyst side and one for the judge.
    for (const [pass, attempt] of [["bull", "a1"], ["bear", "a2"]] as const) {
      const acquired = acquirePaidPassLease(
        claim, pass, requestAttemptId(attempt, 1), perRequest, NOW, LIMITS, first.db, "claude-sonnet-5",
      );
      expect(acquired.acquired, `${pass} must be admitted under a $5 cap`).toBe(true);
      if (acquired.acquired) {
        settleRequestCost(acquired.lease, {
          model: "claude-sonnet-5",
          inputTokens: 40_000,
          outputTokens: 6_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          webSearches: 2,
          costUsd: 0.16,
          fallbackUsed: false,
        }, NOW, first.db);
      }
    }
    const judge = acquirePaidPassLease(
      claim, "synthesize", requestAttemptId("a3", 1),
      maximumRequestCostUsd("claude-sonnet-5", "synthesize"), NOW, LIMITS, first.db, "claude-sonnet-5",
    );
    expect(judge.acquired).toBe(true);

    // The former bound would have needed hundreds of dollars of headroom for
    // the same run.
    expect(passWorstCaseCostUsd("claude-sonnet-5", "bull")).toBeGreaterThan(100);
  });

  it("counts only reservations that can bill toward global LLM capacity", () => {
    seedJob(first.db, "job-f", "AAPL");
    const claim = claimNextQueuedJob("owner", NOW, LIMITS, first.db)!;
    // Deterministic verify reserves nothing and must never occupy a paid slot.
    for (const attempt of ["z1", "z2", "z3"]) {
      expect(acquirePaidPassLease(claim, "verify", attempt, 0, NOW, LIMITS, first.db, ""))
        .toMatchObject({ acquired: true });
    }
    expect(acquirePaidPassLease(claim, "bull", "p1", 1, NOW, LIMITS, first.db, "claude-sonnet-5"))
      .toMatchObject({ acquired: true });
    expect(acquirePaidPassLease(claim, "bear", "p2", 1, NOW, LIMITS, first.db, "claude-sonnet-5"))
      .toMatchObject({ acquired: true });
    // Two paid calls is the configured capacity.
    expect(acquirePaidPassLease(claim, "bull", "p3", 1, NOW, LIMITS, first.db, "claude-sonnet-5"))
      .toMatchObject({ acquired: false, reason: "capacity" });
  });

  it("lowers a pass reservation to zero once a request reserves for itself, and never raises one", () => {
    seedJob(first.db, "job-g", "AAPL");
    const claim = claimNextQueuedJob("owner", NOW, LIMITS, first.db)!;
    const acquired = acquirePaidPassLease(claim, "bull", "pass", 3, NOW, LIMITS, first.db, "claude-sonnet-5");
    if (!acquired.acquired) throw new Error("fixture lease failed");

    const resized = resizePaidPassLease(acquired.lease, 0, NOW, first.db);
    expect(resized).toMatchObject({ reservedCostUsd: 0 });
    expect(second.db.select().from(jobLlmLeases).all()).toEqual([
      expect.objectContaining({ permitId: acquired.lease.permitId, reservedCostUsd: 0 }),
    ]);
    expect(() => resizePaidPassLease(resized!, 1, NOW, first.db)).toThrow(/only be lowered/);
    // A lease that is gone cannot be resized.
    releaseUnbilledPaidPassLease(resized!, first.db, NOW);
    expect(resizePaidPassLease(resized!, 0, NOW, first.db)).toBeNull();
  });

  it("replays an already-settled request without billing it twice", () => {
    seedJob(first.db, "job-h", "AAPL");
    const claim = claimNextQueuedJob("owner", NOW, LIMITS, first.db)!;
    const acquired = acquirePaidPassLease(claim, "bull", requestAttemptId("pass", 1), 2, NOW, LIMITS, first.db, "claude-sonnet-5");
    if (!acquired.acquired) throw new Error("fixture lease failed");
    const settlement = {
      model: "claude-sonnet-5",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearches: 0,
      costUsd: 0.5,
      fallbackUsed: false,
    };
    expect(settleRequestCost(acquired.lease, settlement, NOW, first.db)).toEqual({ recorded: true, costUsd: 0.5 });
    expect(settleRequestCost(acquired.lease, settlement, NOW, second.db)).toEqual({ recorded: false, costUsd: 0.5 });
    expect(first.db.select().from(costLog).all()).toHaveLength(1);
  });

  it("refuses to settle a request above its own reservation", () => {
    seedJob(first.db, "job-i", "AAPL");
    const claim = claimNextQueuedJob("owner", NOW, LIMITS, first.db)!;
    const acquired = acquirePaidPassLease(claim, "bull", requestAttemptId("pass", 1), 1, NOW, LIMITS, first.db, "claude-sonnet-5");
    if (!acquired.acquired) throw new Error("fixture lease failed");
    expect(() => settleRequestCost(acquired.lease, {
      model: "claude-sonnet-5",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearches: 0,
      costUsd: 1.5,
      fallbackUsed: false,
    }, NOW, first.db)).toThrow();
  });
});
