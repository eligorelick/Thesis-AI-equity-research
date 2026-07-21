/**
 * Job-runner orchestration tests. NO network, NO live LLM calls — the pipeline
 * is driven with a MOCK PipelinePasses and an injected DataBundle, against an
 * in-memory better-sqlite3 database (setDbForTests).
 *
 * Coverage:
 *  - deterministic step order + status transitions (pending→running→done);
 *  - jobs.stepsJson persisted after every transition;
 *  - cost_log rows written per LLM pass with token/cost/fallback columns;
 *  - reports row inserted with reportJson + verificationRate + costUsd, and
 *    jobs.reportId linked + status "done";
 *  - events published in order (step-update / cost-update / done);
 *  - the NO-KEY degraded path: fetch/validate/compute run, the four LLM steps
 *    are "skipped" with the no-key reason, and a data-only report is persisted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

// Mock the Anthropic provider so the runner's model-resolution step is driven
// by the test (no live network). By default resolveModel succeeds with a fixed
// model (the happy-path tests need it to resolve); individual tests override it
// (e.g. to throw for the model-resolution-failure case). Other provider exports
// are irrelevant to the runner and left undefined.
vi.mock("@/providers/anthropic", () => ({
  resolveModel: vi.fn(async (setting: string) => ({
    model: setting === "auto" || setting === "" ? "claude-opus-4-8" : setting,
    resolvedFrom: setting === "auto" ? ("auto" as const) : ("explicit" as const),
  })),
}));

import { resolveModel } from "@/providers/anthropic";
import { createDatabase, setDbForTests, type DatabaseHandle } from "@/db";
import { costLog, jobs, reports } from "@/db/schema";
import { setSetting } from "@/settings/settings";
import {
  ACTIVE_JOB_STALE_MS,
  cancelJob,
  claimJobForResume,
  createJob,
  getReusableActiveJobForSymbol,
  isSymbolJobActive,
  JOB_CANCELED_ERROR,
  readPassSnapshots,
  runJob,
  snapshotsCoverResume,
  sweepAbandonedJobs,
  stepsShowResumableFailure,
  initialSteps,
  LLM_STEPS,
  NO_KEY_SKIP_REASON,
  MAX_JUDGE_RETRIES,
  MODEL_RESOLUTION_SKIP_PREFIX,
  type PipelinePasses,
  type PassResultLike,
  type VerifyPassResult,
} from "@/pipeline/jobRunner";
import {
  _clearJobSubscribers,
  subscribeJob,
  getJobSnapshot,
  type JobEvent,
} from "@/pipeline/events";
import {
  ReportSchema,
  type AnalystCase,
  type JudgeOutput,
  type Report,
} from "@/report/schema";
import type { DataBundle } from "@/pipeline/types";
import { PIPELINE_STEPS, type StepProgress } from "@/types/core";

/* ------------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------------ */

let handle: DatabaseHandle;

/** Typed handle to the mocked resolveModel (see vi.mock at the top of file). */
const resolveModelMock = vi.mocked(resolveModel);

/** The default success behavior — restored before every test. */
function defaultResolveModel(setting: string): Promise<{ model: string; resolvedFrom: "auto" | "explicit" }> {
  return Promise.resolve({
    model: setting === "auto" || setting === "" ? "claude-opus-4-8" : setting,
    resolvedFrom: setting === "auto" ? "auto" : "explicit",
  });
}

beforeEach(() => {
  handle = createDatabase(":memory:");
  setDbForTests(handle.db);
  _clearJobSubscribers();
  // Reset the model-resolution mock to its success default (vi.mock factory
  // implementations persist across tests; restoreAllMocks does not reset them).
  resolveModelMock.mockReset();
  resolveModelMock.mockImplementation(defaultResolveModel);
});

afterEach(() => {
  setDbForTests(null);
  handle.sqlite.close();
  _clearJobSubscribers();
  vi.restoreAllMocks();
});

/** A minimal DataBundle stub sufficient for validate + compute + persistence. */
function fakeBundle(symbol = "AAPL"): DataBundle {
  const builtAt = "2026-07-06T00:00:00.000Z";
  const asOf: Record<string, string> = { quote: "2026-07-05", profile: "2026-07-01" };
  const gap = { ok: false as const, gap: { field: "x", reason: "fixture", severity: "info" as const } };
  const profile = {
    ok: true as const,
    value: {
      data: { rows: [{ companyName: "Apple Inc.", sector: "Technology", price: 200 }], raw: {} },
      asOf: "2026-07-01",
      source: "fmp" as const,
      endpoint: "profile",
      fetchedAt: builtAt,
    },
  };
  // Everything else can be a gap — runStageB/validateBundle degrade gracefully.
  const bundle = {
    symbol,
    builtAt,
    profile,
    quote: gap,
    statements: {
      incomeAnnual: gap,
      incomeQuarterly: gap,
      balanceAnnual: gap,
      balanceQuarterly: gap,
      cashflowAnnual: gap,
      cashflowQuarterly: gap,
      periods: { annualRequested: 10, quarterlyRequested: 8 },
    },
    keyMetrics: gap,
    keyMetricsTtm: gap,
    ratios: gap,
    ratiosTtm: gap,
    financialGrowth: gap,
    financialScores: gap,
    enterpriseValues: gap,
    analystEstimates: gap,
    priceTargetConsensus: gap,
    priceTargetSummary: gap,
    gradesConsensus: gap,
    earningsHistory: gap,
    earningsCalendarNext: gap,
    transcript: { meta: gap, latest: gap },
    insiderTrades: gap,
    insiderStats: gap,
    institutional: {
      year: 2026,
      quarter: 1 as const,
      quarterEnd: "2026-03-31",
      positionsSummary: gap,
      topHolders: gap,
    },
    peers: gap,
    segmentation: { product: gap, geographic: gap },
    executives: gap,
    compensation: gap,
    marketCapHistory: gap,
    sharesFloat: gap,
    secFilings: gap,
    news: gap,
    pressReleases: gap,
    eodPrices: gap,
    benchmarkPrices: { spy: gap, sectorEtf: gap, sectorEtfSymbol: null },
    shortInterest: gap,
    shortInterestTrend: gap,
    insiderSentiment: gap,
    macro: { core: {}, sector: {}, gicsSector: null, attribution: "attr" },
    treasury: gap,
    marketRiskPremium: gap,
    edgar: {
      cik: gap,
      latestTenK: gap,
      latestTenQ: gap,
      item1a: gap,
      mdna: gap,
      tenQMdna: gap,
      auditorChange8Ks: gap,
      nonReliance8Ks: gap,
      companyFacts: gap,
      xbrlSummary: null,
    },
    asOf,
    gaps: [],
  } as unknown as DataBundle;
  return bundle;
}

function fakeAnalystCase(): AnalystCase {
  return {
    thesis: [{ text: "t", label: "JUDGMENT", source: "payload", asOf: null }],
    keyDrivers: [],
    risksToCase: [],
    catalysts: [],
    priceTarget: { value: 250, horizon: "12mo", assumptions: [] },
    evidence: [],
  };
}

function grade(): Report["verdict"]["gradeStrip"]["fundamentals"] {
  return {
    grade: "B",
    oneLineWhy: "solid",
    reasoning: [{ text: "r", label: "JUDGMENT", source: "payload", asOf: null }],
    confidence: "medium",
    keyNumbers: [],
  };
}

function fakeJudgeOutput(): JudgeOutput {
  return {
    verdict: {
      synthesis: "A three-sentence synthesis with scenarios and probabilities. It avoids ratings. It is grounded.",
      gradeStrip: {
        fundamentals: grade(),
        valuation: grade(),
        technicals: grade(),
        quality: grade(),
        leadership: grade(),
        moat: grade(),
      },
    },
    business: { whatTheySell: [], segments: { product: [], geographic: [] }, concentrationRisks: [] },
    fundamentals: { graded: grade(), growthTable: [], marginTrend: [], returns: [], fcf: [], commentary: [] },
    balanceSheet: {
      debtProfile: { commentary: [], numbers: [] },
      coverage: { commentary: [], numbers: [] },
      capexTrajectory: { commentary: [], numbers: [] },
      capitalAllocation: [],
    },
    valuation: {
      graded: grade(),
      dcf: {
        perShare: { value: 240, unit: "USD/share", source: "computed", asOf: null, verified: null },
        assumptions: [],
        sensitivityGrid: [],
        upsidePct: null,
      },
      reverseDcf: { impliedMetric: "growth", impliedValue: null, narrative: "implied narrative" },
      multiples: [],
      scenarios: [
        { name: "bull", probability: 0.34, priceTarget: { value: 300, unit: "USD/share", source: "computed", asOf: null, verified: null }, horizon: "12mo", assumptions: [], whatWouldHaveToBeTrue: [] },
        { name: "base", probability: 0.33, priceTarget: { value: 250, unit: "USD/share", source: "computed", asOf: null, verified: null }, horizon: "12mo", assumptions: [], whatWouldHaveToBeTrue: [] },
        { name: "bear", probability: 0.33, priceTarget: { value: 200, unit: "USD/share", source: "computed", asOf: null, verified: null }, horizon: "12mo", assumptions: [], whatWouldHaveToBeTrue: [] },
      ],
    },
    quality: {
      graded: grade(),
      forensicScores: {
        altman: { variant: "z", score: null, zone: null },
        beneish: { variant: "m", score: null, zone: null },
        piotroski: { variant: "f", score: null, zone: null },
        accruals: { variant: "a", score: null, zone: null },
      },
      flags: [],
    },
    technicals: {
      graded: grade(),
      read: { trend: "up", momentum: "positive", keyLevels: "levels", relativeStrength: "strong vs peers" },
      indicators: [],
      flags: [],
    },
    leadership: { graded: grade(), executives: [], insiderSummary: [], governanceNotes: [] },
    competitive: { moatGraded: grade(), peerTable: [], moatAssessment: [], marketShareDirection: "gaining" },
    catalystsRisks: { catalysts: [], risks: [] },
    outlook: {
      segmentTrajectories: [],
      estimateRevisionTrend: [],
      guidanceCredibility: [],
      scenarioNarratives: { y1: [], y3: [], y5: [] },
    },
    macro: {
      relevantSeries: [],
      sensitivityNotes: [],
      fredAttribution:
        "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.",
    },
    disagreements: [],
  };
}

/** Build a full valid Report from a JudgeOutput + minimal meta/appendix. */
function fakeReport(judge: JudgeOutput): Report {
  return {
    meta: {
      symbol: "AAPL",
      companyName: "Apple Inc.",
      generatedAt: "2026-07-06T00:00:00.000Z",
      specVersion: "1.0.0",
      model: "claude-opus-4-8",
      pipelineVersion: "stage-c-1.0.0",
      costUsd: 0,
      verificationRate: null,
      disclaimer: "Informational only — not investment advice.",
      asOfMap: {},
    },
    ...judge,
    appendix: {
      sources: [],
      missingData: [],
      verificationRate: null,
      costBreakdown: [],
    },
  };
}

/** A mock PipelinePasses recording calls; passes cost/usage through. */
function mockPasses(over: Partial<{
  verificationRate: number;
  bullCostUsd: number;
  bearCostUsd: number;
  judgeCostUsd: number;
  verifyCostUsd: number;
}> = {}): {
  passes: PipelinePasses;
  calls: string[];
} {
  const calls: string[] = [];
  const bull: PassResultLike<AnalystCase> = {
    data: fakeAnalystCase(),
    model: "claude-opus-4-8",
    costUsd: over.bullCostUsd ?? 0.9,
    fallbackUsed: false,
    usage: { input_tokens: 15000, output_tokens: 6000, cache_creation_input_tokens: 75000, cache_read_input_tokens: 0 },
    webSearches: 7,
  };
  const bear: PassResultLike<AnalystCase> = {
    data: fakeAnalystCase(),
    model: "claude-opus-4-8",
    costUsd: over.bearCostUsd ?? 0.47,
    fallbackUsed: false,
    usage: { input_tokens: 15000, output_tokens: 6000, cache_creation_input_tokens: 0, cache_read_input_tokens: 300000 },
    webSearches: 6,
  };
  const judge = fakeJudgeOutput();
  const judgeResult: PassResultLike<JudgeOutput> = {
    data: judge,
    model: "claude-opus-4-8",
    costUsd: over.judgeCostUsd ?? 0.4,
    fallbackUsed: false,
    usage: { input_tokens: 12000, output_tokens: 12000, cache_read_input_tokens: 75000 },
  };
  const verify: VerifyPassResult = {
    verifiedReport: fakeReport(judge),
    verificationRate: over.verificationRate ?? 1,
    costUsd: over.verifyCostUsd ?? 0.2,
    model: "claude-opus-4-8",
    fallbackUsed: false,
    usage: { input_tokens: 12000, output_tokens: 4000, cache_read_input_tokens: 75000 },
    log: [{ claim: "revenue 100", outcome: "verified" }],
  };

  const passes: PipelinePasses = {
    assembleContextPayload: (b, c, v) => {
      calls.push("assembleContextPayload");
      void b;
      void c;
      void v;
      return { payload: true };
    },
    runBullThenBear: async () => {
      calls.push("runBullThenBear");
      return { bull, bear };
    },
    runJudgePass: async () => {
      calls.push("runJudgePass");
      return judgeResult;
    },
    runVerifyPass: async () => {
      calls.push("runVerifyPass");
      return verify;
    },
    assembleReport: (input) => {
      calls.push("assembleReport");
      return fakeReport(input.judgeOutput);
    },
  };
  return { passes, calls };
}

const NOW = (): Date => new Date("2026-07-06T00:00:00.000Z");

/* ------------------------------------------------------------------------ *
 * createJob
 * ------------------------------------------------------------------------ */

describe("createJob", () => {
  it("inserts a queued job with all steps pending", () => {
    const { jobId } = createJob("aapl");
    const row = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(row).toBeDefined();
    expect(row?.symbol).toBe("AAPL"); // uppercased
    expect(row?.status).toBe("queued");
    expect(row?.reportId).toBeNull();
    const steps = JSON.parse(row?.stepsJson ?? "[]") as StepProgress[];
    expect(steps.map((s) => s.step)).toEqual([...PIPELINE_STEPS]);
    expect(steps.every((s) => s.status === "pending")).toBe(true);
  });

  it("isSymbolJobActive detects a queued/running job and clears when done", async () => {
    const { jobId } = createJob("AAPL");
    expect(isSymbolJobActive("aapl")).toBe(true);
    // Force to done so it is no longer active.
    handle.db.update(jobs).set({ status: "done" }).where(eq(jobs.id, jobId)).run();
    expect(isSymbolJobActive("AAPL")).toBe(false);
  });

  it("returns a reusable active job id for fresh jobs but expires stale active jobs", () => {
    const { jobId } = createJob("AAPL");
    const row = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(row).toBeDefined();
    const freshNow = new Date(Date.parse(row!.updatedAt) + 1000);

    expect(getReusableActiveJobForSymbol("aapl", freshNow)).toEqual({
      jobId,
      status: "queued",
      updatedAt: row!.updatedAt,
    });

    const staleUpdatedAt = new Date(freshNow.getTime() - ACTIVE_JOB_STALE_MS - 1000).toISOString();
    handle.db
      .update(jobs)
      .set({ status: "running", updatedAt: staleUpdatedAt, error: null })
      .where(eq(jobs.id, jobId))
      .run();

    expect(getReusableActiveJobForSymbol("AAPL", freshNow)).toBeNull();
    const expired = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(expired?.status).toBe("error");
    expect(expired?.error).toContain("stale active job expired");
  });

  it("sweepAbandonedJobs terminal-izes stale queued/running jobs across ALL symbols", () => {
    const now = new Date("2026-07-09T12:00:00.000Z");
    const staleIso = new Date(now.getTime() - ACTIVE_JOB_STALE_MS - 1000).toISOString();
    const freshIso = new Date(now.getTime() - 60_000).toISOString();

    // Orphaned running job for a symbol nobody re-runs (the audit's PYPL case).
    const { jobId: orphan } = createJob("PYPL");
    handle.db.update(jobs).set({ status: "running", updatedAt: staleIso }).where(eq(jobs.id, orphan)).run();
    // Stale queued job for another symbol.
    const { jobId: staleQueued } = createJob("MSFT");
    handle.db.update(jobs).set({ updatedAt: staleIso }).where(eq(jobs.id, staleQueued)).run();
    // Fresh running job — must NOT be touched.
    const { jobId: live } = createJob("AAPL");
    handle.db.update(jobs).set({ status: "running", updatedAt: freshIso }).where(eq(jobs.id, live)).run();
    // Terminal job — must NOT be touched.
    const { jobId: done } = createJob("INTU");
    handle.db.update(jobs).set({ status: "done", updatedAt: staleIso }).where(eq(jobs.id, done)).run();

    const changed = sweepAbandonedJobs(now);
    expect(changed).toBe(2);

    const orphanRow = handle.db.select().from(jobs).where(eq(jobs.id, orphan)).get();
    expect(orphanRow?.status).toBe("error");
    expect(orphanRow?.error).toContain("abandoned: no progress for 30 minutes");
    expect(handle.db.select().from(jobs).where(eq(jobs.id, staleQueued)).get()?.status).toBe("error");
    expect(handle.db.select().from(jobs).where(eq(jobs.id, live)).get()?.status).toBe("running");
    expect(handle.db.select().from(jobs).where(eq(jobs.id, done)).get()?.status).toBe("done");
  });

  // Regression (2026-07-20 audit): a process crash mid-synthesize used to leave
  // stepsJson with synthesize:"running" forever — the sweep flipped only the
  // job STATUS, so stepsShowResumableFailure never matched and the retry route
  // 409'd, stranding two already-paid analyst snapshots. The sweep must
  // normalize stepsJson the way abortRun does (running → error, pending →
  // skipped) so a swept synthesize-crash is resumable.
  it("sweepAbandonedJobs makes a mid-synthesize crash resumable (steps normalized)", () => {
    const now = new Date("2026-07-09T12:00:00.000Z");
    const staleIso = new Date(now.getTime() - ACTIVE_JOB_STALE_MS - 1000).toISOString();
    const { jobId } = createJob("NVDA");
    const crashedSteps = [
      { step: "fetch", status: "done" },
      { step: "validate", status: "done" },
      { step: "compute", status: "done" },
      { step: "bull", status: "done" },
      { step: "bear", status: "done" },
      { step: "synthesize", status: "running", startedAt: staleIso },
      { step: "verify", status: "pending" },
    ];
    handle.db
      .update(jobs)
      .set({
        status: "running",
        updatedAt: staleIso,
        stepsJson: JSON.stringify(crashedSteps),
        bullJson: JSON.stringify({ ok: true }),
        bearJson: JSON.stringify({ ok: true }),
      })
      .where(eq(jobs.id, jobId))
      .run();

    expect(sweepAbandonedJobs(now)).toBe(1);

    const row = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(row?.status).toBe("error");
    const steps = JSON.parse(row?.stepsJson ?? "[]") as StepProgress[];
    const by = new Map(steps.map((s) => [s.step, s]));
    expect(by.get("synthesize")?.status).toBe("error");
    expect(by.get("synthesize")?.detail).toContain("abandoned");
    expect(by.get("verify")?.status).toBe("skipped");
    expect(by.get("bull")?.status).toBe("done");

    // The whole point: the swept job now presents the resumable shape.
    expect(stepsShowResumableFailure(steps)).toEqual({
      doneSides: ["bull", "bear"],
      failedSides: [],
    });
  });

  it("sweepAbandonedJobs leaves malformed stepsJson untouched but still un-wedges the row", () => {
    const now = new Date("2026-07-09T12:00:00.000Z");
    const staleIso = new Date(now.getTime() - ACTIVE_JOB_STALE_MS - 1000).toISOString();
    const { jobId } = createJob("CORRUPT");
    handle.db
      .update(jobs)
      .set({ status: "running", updatedAt: staleIso, stepsJson: "{not json" })
      .where(eq(jobs.id, jobId))
      .run();

    expect(sweepAbandonedJobs(now)).toBe(1);
    const row = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(row?.status).toBe("error");
    expect(row?.stepsJson).toBe("{not json");
  });
});

/* ------------------------------------------------------------------------ *
 * runJob — full happy path (key present)
 * ------------------------------------------------------------------------ */

describe("runJob — full pipeline with mock passes", () => {
  it("runs all steps in order, logs cost, persists the report, links jobs.reportId", async () => {
    const { jobId } = createJob("AAPL");
    const { passes, calls } = mockPasses();

    const events: JobEvent[] = [];
    subscribeJob(jobId, (e) => events.push(e));

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: true,
      now: NOW,
    });

    expect(result.status).toBe("done");
    expect(result.dataOnly).toBe(false);
    expect(result.verificationRate).toBe(1);
    expect(result.reportId).not.toBeNull();

    // Pass call order.
    expect(calls).toEqual([
      "assembleContextPayload",
      "runBullThenBear",
      "runJudgePass",
      "runVerifyPass",
    ]);

    // jobs row updated.
    const jobRow = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(jobRow?.status).toBe("done");
    expect(jobRow?.reportId).toBe(result.reportId);
    const steps = JSON.parse(jobRow?.stepsJson ?? "[]") as StepProgress[];
    expect(steps.map((s) => s.step)).toEqual([...PIPELINE_STEPS]);
    expect(steps.every((s) => s.status === "done")).toBe(true);
    // Every step carries timing.
    for (const s of steps) {
      expect(s.startedAt).toBeDefined();
      expect(s.finishedAt).toBeDefined();
    }

    // cost_log rows — one per LLM pass (bull, bear, synthesize, verify).
    const costRows = handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all();
    expect(costRows.map((r) => r.step).sort()).toEqual(["bear", "bull", "synthesize", "verify"]);
    const bullRow = costRows.find((r) => r.step === "bull");
    expect(bullRow?.costUsd).toBeCloseTo(0.9, 6);
    expect(bullRow?.inputTokens).toBe(15000);
    expect(bullRow?.cacheWriteTokens).toBe(75000);
    expect(bullRow?.webSearches).toBe(7);
    expect(bullRow?.fallbackUsed).toBe(false);
    const totalCost = costRows.reduce((a, r) => a + r.costUsd, 0);
    expect(totalCost).toBeCloseTo(0.9 + 0.47 + 0.4 + 0.2, 6);

    // reports row.
    const repRow = handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get();
    expect(repRow).toBeDefined();
    expect(repRow?.symbol).toBe("AAPL");
    expect(repRow?.status).toBe("done");
    expect(repRow?.verificationRate).toBe(1);
    expect(repRow?.specVersion).toBe("1.2.0");
    expect(repRow?.costUsd).toBeCloseTo(totalCost, 6);
    const parsed = ReportSchema.safeParse(JSON.parse(repRow?.reportJson ?? "{}"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Runner reconciled meta cost + pipeline version onto the report.
      expect(parsed.data.meta.costUsd).toBeCloseTo(totalCost, 4);
      expect(parsed.data.meta.pipelineVersion).toBe("stage-c-1.0.0");
      expect(parsed.data.meta.verificationRate).toBe(1);
      expect(parsed.data.meta.runId).toBe(jobId);
      expect(parsed.data.meta.reportId).toBe(result.reportId);
      expect(parsed.data.meta.startedAt).toBeDefined();
      expect(parsed.data.meta.completedAt).toBeDefined();
      expect(parsed.data.meta.persistedAt).toBeDefined();
      expect(parsed.data.meta.execution?.map((entry) => entry.step)).toEqual([
        "bull",
        "bear",
        "synthesize",
        "verify",
      ]);
      expect(parsed.data.appendix.costBreakdown.length).toBe(4);
    }
  });

  it("preserves cost precision beyond four decimals in persisted report metadata", async () => {
    const { jobId } = createJob("AAPL");
    const { passes } = mockPasses({
      bullCostUsd: 0.1111114,
      bearCostUsd: 0.2222226,
      judgeCostUsd: 0.3333337,
      verifyCostUsd: 0,
    });

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: true,
      now: NOW,
    });
    const row = handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get()!;
    const report = ReportSchema.parse(JSON.parse(row.reportJson!));
    const exact = 0.1111114 + 0.2222226 + 0.3333337;

    expect(report.meta.costUsd).toBe(exact);
    expect(row.costUsd).toBe(exact);
    expect(report.meta.costUsd).not.toBe(Math.round(exact * 1e4) / 1e4);
  });

  it("passes the union of bull, bear, and judge fetched URLs to verification", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const runBullThenBear = base.passes.runBullThenBear.bind(base.passes);
    const runJudgePass = base.passes.runJudgePass.bind(base.passes);
    const runVerifyPass = base.passes.runVerifyPass.bind(base.passes);
    let seen: string[] | undefined;

    const result = await runJob(
      jobId,
      {
        ...base.passes,
        runBullThenBear: async (deps, hooks) => {
          const analyst = await runBullThenBear(deps, hooks);
          analyst.bull.fetchedUrls = ["https://example.com/shared", "https://example.com/bull"];
          analyst.bear.fetchedUrls = ["https://example.com/bear", "https://example.com/shared"];
          return analyst;
        },
        runJudgePass: async (deps, bull, bear, feedback) => {
          const judge = await runJudgePass(deps, bull, bear, feedback);
          judge.fetchedUrls = ["https://example.com/judge"];
          return judge;
        },
        runVerifyPass: async (deps, judge, evidence) => {
          seen = evidence!.fetchedUrls;
          return runVerifyPass(deps, judge, evidence);
        },
      },
      { bundle: fakeBundle("AAPL"), hasAnthropicKey: true, now: NOW },
    );

    expect(result.status).toBe("done");
    expect(seen).toEqual([
      "https://example.com/bear",
      "https://example.com/bull",
      "https://example.com/judge",
      "https://example.com/shared",
    ]);
  });

  it("rolls back the report insert if linking the terminal job fails", async () => {
    const { jobId } = createJob("AAPL");
    const { passes } = mockPasses();
    handle.sqlite.exec(`
      CREATE TRIGGER reject_report_link
      BEFORE UPDATE OF "reportId" ON "jobs"
      WHEN NEW."reportId" IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'injected report-link failure');
      END;
    `);

    await expect(
      runJob(jobId, passes, { bundle: fakeBundle("AAPL"), hasAnthropicKey: true, now: NOW }),
    ).rejects.toThrow("injected report-link failure");

    expect(handle.db.select().from(reports).all()).toHaveLength(0);
    const row = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(row?.reportId).toBeNull();
    expect(row?.status).toBe("error");
  });

  it("reconcileMeta preserves appendix.missingData — the H4 report-disclosure invariant (fix-review)", async () => {
    // The stageC adapter merges validation gaps into the assembled report's
    // appendix.missingData; the runner's reconcileMeta post-processing must
    // never rebuild that manifest (it may only touch verificationRate /
    // costBreakdown / verificationLog), or the H4 fix would be silently undone.
    const { jobId } = createJob("AAPL");
    const { passes } = mockPasses();
    const MARKER = {
      field: "validation.test.marker",
      reason: "seeded by test — must survive reconcileMeta untouched",
      severity: "warn" as const,
    };
    const origVerify = passes.runVerifyPass;
    passes.runVerifyPass = async (...args: Parameters<PipelinePasses["runVerifyPass"]>) => {
      const v = await origVerify(...args);
      v.verifiedReport?.appendix.missingData.push(MARKER);
      return v;
    };

    const result = await runJob(jobId, passes, { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW });
    const repRow = handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get();
    const parsed = ReportSchema.safeParse(JSON.parse(repRow?.reportJson ?? "{}"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.appendix.missingData.some((m) => m.field === MARKER.field)).toBe(true);
      // reconcileMeta DID run (its own fields are populated) — it just didn't
      // touch the manifest.
      expect(parsed.data.appendix.costBreakdown.length).toBeGreaterThan(0);
    }
  });

  it("publishes events in order: step-updates, cost-updates, then done", async () => {
    const { jobId } = createJob("AAPL");
    const { passes } = mockPasses();
    const events: JobEvent[] = [];
    subscribeJob(jobId, (e) => events.push(e));

    await runJob(jobId, passes, { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW });

    const types = events.map((e) => e.type);
    // First event is a step-update (fetch running).
    expect(types[0]).toBe("step-update");
    // Exactly one terminal "done", and it is last.
    expect(types.filter((t) => t === "done")).toHaveLength(1);
    expect(types[types.length - 1]).toBe("done");
    expect(types).not.toContain("error");

    // Four cost-updates (bull/bear/synthesize/verify), each after its step's run.
    const costUpdates = events.filter((e): e is Extract<JobEvent, { type: "cost-update" }> => e.type === "cost-update");
    expect(costUpdates.map((e) => e.step)).toEqual(["bull", "bear", "synthesize", "verify"]);
    // Running total is monotonic.
    const totals = costUpdates.map((e) => e.totalCostUsd);
    for (let i = 1; i < totals.length; i++) expect(totals[i]).toBeGreaterThan(totals[i - 1]);

    // The done event carries the final total + reportId.
    const done = events.find((e): e is Extract<JobEvent, { type: "done" }> => e.type === "done");
    expect(done?.reportId).not.toBeNull();
    expect(done?.verificationRate).toBe(1);
    expect(done?.dataOnly).toBe(false);
    expect(done?.totalCostUsd).toBeCloseTo(0.9 + 0.47 + 0.4 + 0.2, 4);

    // The step-update transitions cover every step reaching "done".
    const stepDone = new Set(
      events
        .filter((e): e is Extract<JobEvent, { type: "step-update" }> => e.type === "step-update")
        .filter((e) => e.step.status === "done")
        .map((e) => e.step.step),
    );
    expect(stepDone).toEqual(new Set(PIPELINE_STEPS));
  });

  it("getJobSnapshot reflects the persisted terminal state", async () => {
    const { jobId } = createJob("AAPL");
    const { passes } = mockPasses();
    await runJob(jobId, passes, { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW });
    const snap = getJobSnapshot(jobId);
    expect(snap?.status).toBe("done");
    expect(snap?.reportId).not.toBeNull();
    expect(snap?.steps.every((s) => s.status === "done")).toBe(true);
    expect(snap?.verificationRate).toBe(1);
    expect(snap?.totalCostUsd).toBeCloseTo(0.9 + 0.47 + 0.4 + 0.2, 4);
    expect(snap?.dataOnly).toBe(false);
  });

  it("threads the analysisEffort setting into PassDeps (default 'high', settings override)", async () => {
    vi.stubEnv("ANALYSIS_EFFORT", ""); // empty env = unset, regardless of host machine
    const capturedEfforts: (string | undefined)[] = [];
    const runWithCapture = async () => {
      const { jobId } = createJob("AAPL");
      const { passes } = mockPasses();
      const origBullBear = passes.runBullThenBear;
      passes.runBullThenBear = async (deps, hooks) => {
        capturedEfforts.push(deps.effort);
        return origBullBear(deps, hooks);
      };
      await runJob(jobId, passes, { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW });
    };

    await runWithCapture(); // no setting/env → default
    setSetting("analysisEffort", "medium");
    await runWithCapture(); // settings-table override
    expect(capturedEfforts).toEqual(["high", "medium"]);
  });
});

/* ------------------------------------------------------------------------ *
 * runJob — no-key degraded path
 * ------------------------------------------------------------------------ */

describe("runJob — no-key degraded path", () => {
  it("runs fetch/validate/compute, skips LLM steps, persists a data-only report", async () => {
    const { jobId } = createJob("AAPL");
    const { passes, calls } = mockPasses();
    const events: JobEvent[] = [];
    subscribeJob(jobId, (e) => events.push(e));

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: false,
      now: NOW,
    });

    expect(result.status).toBe("done");
    expect(result.dataOnly).toBe(true);
    expect(result.verificationRate).toBeNull();
    expect(result.reportId).not.toBeNull();

    // NO pass was invoked (not even payload assembly).
    expect(calls).toEqual([]);

    // Step strip: first three done, LLM steps skipped with the no-key reason.
    const jobRow = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    const steps = JSON.parse(jobRow?.stepsJson ?? "[]") as StepProgress[];
    const byStep = new Map(steps.map((s) => [s.step, s]));
    expect(byStep.get("fetch")?.status).toBe("done");
    expect(byStep.get("validate")?.status).toBe("done");
    expect(byStep.get("compute")?.status).toBe("done");
    for (const step of LLM_STEPS) {
      expect(byStep.get(step)?.status).toBe("skipped");
      expect(byStep.get(step)?.detail).toBe(NO_KEY_SKIP_REASON);
    }

    // No cost_log rows (no LLM calls).
    const costRows = handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all();
    expect(costRows).toHaveLength(0);

    // A data-only report was persisted and is schema-valid.
    const repRow = handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get();
    expect(repRow?.verificationRate).toBeNull();
    const parsed = ReportSchema.safeParse(JSON.parse(repRow?.reportJson ?? "{}"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.meta.symbol).toBe("AAPL");
      expect(parsed.data.meta.verificationRate).toBeNull();
      // The data-only condition is recorded as a critical manifest entry.
      const llmGap = parsed.data.appendix.missingData.find((m) => m.field === "analysis.llm");
      expect(llmGap?.severity).toBe("critical");
      expect(llmGap?.reason).toBe(NO_KEY_SKIP_REASON);
      // Sources were carried from the bundle asOf map.
      expect(parsed.data.appendix.sources.length).toBeGreaterThan(0);
    }

    // Terminal "done" event with dataOnly true.
    const done = events.find((e): e is Extract<JobEvent, { type: "done" }> => e.type === "done");
    expect(done?.dataOnly).toBe(true);
    expect(done?.reportId).toBe(result.reportId);
  });
});

/* ------------------------------------------------------------------------ *
 * runJob — LLM pass failure degrades to a data-only report
 * ------------------------------------------------------------------------ */

describe("runJob — LLM pass failure", () => {
  it("marks bull/bear error, skips downstream, persists a data-only report", async () => {
    const { jobId } = createJob("AAPL");
    const { passes } = mockPasses();
    // Make the adversarial passes throw.
    passes.runBullThenBear = async () => {
      throw new Error("boom in bull/bear");
    };

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    });

    // Still finishes "done" with a persisted data-only report and reports that
    // terminal state honestly even though an Anthropic key was configured.
    expect(result.status).toBe("done");
    expect(result.reportId).not.toBeNull();
    expect(result.dataOnly).toBe(true);

    const jobRow = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    const steps = JSON.parse(jobRow?.stepsJson ?? "[]") as StepProgress[];
    const byStep = new Map(steps.map((s) => [s.step, s]));
    expect(byStep.get("compute")?.status).toBe("done");
    expect(byStep.get("bull")?.status).toBe("error");
    expect(byStep.get("bear")?.status).toBe("error");
    expect(byStep.get("synthesize")?.status).toBe("skipped");
    expect(byStep.get("verify")?.status).toBe("skipped");

    const repRow = handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get();
    const parsed = ReportSchema.safeParse(JSON.parse(repRow?.reportJson ?? "{}"));
    expect(parsed.success).toBe(true);
  });

  it("preserves a successful bull pass and billed bear telemetry when only bear fails", async () => {
    const { jobId } = createJob("AAPL");
    const { passes } = mockPasses();
    const bull: PassResultLike<AnalystCase> = {
      data: fakeAnalystCase(),
      model: "claude-opus-4-8",
      costUsd: 0.9,
      fallbackUsed: false,
      usage: {
        input_tokens: 15000,
        output_tokens: 6000,
        cache_creation_input_tokens: 75000,
        cache_read_input_tokens: 0,
      },
      webSearches: 7,
    };
    const error = Object.assign(new Error("bull/bear pass failed"), {
      bull,
      bearError: "bear pass failed (refusal): schema-invalid structured output for llm.bear",
      bearBilledAttempt: {
        model: "claude-opus-4-8",
        costUsd: 0.31,
        fallbackUsed: false,
        usage: {
          input_tokens: 14000,
          output_tokens: 5000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 300000,
        },
        webSearches: 6,
      },
    });
    passes.runBullThenBear = async () => {
      throw error;
    };

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    });

    expect(result.status).toBe("done");
    expect(result.dataOnly).toBe(true);
    expect(result.totalCostUsd).toBeCloseTo(1.21, 6);

    const jobRow = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    const steps = JSON.parse(jobRow?.stepsJson ?? "[]") as StepProgress[];
    const byStep = new Map(steps.map((s) => [s.step, s]));
    expect(byStep.get("bull")?.status).toBe("done");
    expect(byStep.get("bull")?.costUsd).toBeCloseTo(0.9, 6);
    expect(byStep.get("bear")?.status).toBe("error");
    expect(byStep.get("bear")?.detail).toContain("schema-invalid structured output");
    expect(byStep.get("bear")?.costUsd).toBeCloseTo(0.31, 6);
    expect(byStep.get("synthesize")?.status).toBe("skipped");
    expect(byStep.get("verify")?.status).toBe("skipped");

    const costRows = handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all();
    expect(costRows.map((r) => r.step).sort()).toEqual(["bear", "bull"]);
    expect(costRows.find((r) => r.step === "bull")?.costUsd).toBeCloseTo(0.9, 6);
    expect(costRows.find((r) => r.step === "bear")?.costUsd).toBeCloseTo(0.31, 6);
    expect(costRows.find((r) => r.step === "bear")?.webSearches).toBe(6);

    // The PAID bull output itself is persisted (not just its cost) so a
    // partial resume can reuse it instead of re-billing the pass.
    const snapshots = readPassSnapshots(jobId);
    expect(snapshots).not.toBeNull();
    expect(snapshots!.bull).not.toBeNull();
    expect(snapshots!.bull!.costUsd).toBeCloseTo(0.9, 6);
    expect(snapshots!.bear).toBeNull();
  });

  it("verify failure still persists the (unverified) assembled report", async () => {
    const { jobId } = createJob("AAPL");
    const { passes } = mockPasses();
    passes.runVerifyPass = async () => {
      throw new Error("verify exploded");
    };

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    });

    expect(result.status).toBe("done");
    expect(result.reportId).not.toBeNull();
    expect(result.verificationRate).toBeNull();

    const jobRow = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    const steps = JSON.parse(jobRow?.stepsJson ?? "[]") as StepProgress[];
    const byStep = new Map(steps.map((s) => [s.step, s]));
    expect(byStep.get("synthesize")?.status).toBe("done");
    expect(byStep.get("verify")?.status).toBe("error");

    // Bull/bear/synthesize costs still logged (3 rows, verify never logged).
    const costRows = handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all();
    expect(costRows.map((r) => r.step).sort()).toEqual(["bear", "bull", "synthesize"]);
  });
});

/* ------------------------------------------------------------------------ *
 * runJob — model-resolution failure degrades to data-only (Fix §1)
 * ------------------------------------------------------------------------ */

describe("runJob — model-resolution failure", () => {
  it("marks LLM steps skipped with the resolution reason and persists a data-only report (job done, not error)", async () => {
    const { jobId } = createJob("AAPL");
    const { passes, calls } = mockPasses();

    // A transient Anthropic transport/auth failure inside resolveModel must NOT
    // fail the whole job — it degrades like the no-key path.
    resolveModelMock.mockRejectedValue(new Error("503 models.list() transport error"));

    const events: JobEvent[] = [];
    subscribeJob(jobId, (e) => events.push(e));

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: true,
      now: NOW,
    });

    // Ends "done" (data-only), NOT "error".
    expect(result.status).toBe("done");
    expect(result.reportId).not.toBeNull();
    expect(result.verificationRate).toBeNull();
    expect(result.dataOnly).toBe(true);
    expect(result.dataOnly).toBe(true);

    // No LLM pass ran — resolution failed before payload assembly.
    expect(calls).toEqual([]);

    // fetch/validate/compute done; the four LLM steps skipped with the reason.
    const jobRow = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(jobRow?.status).toBe("done");
    const steps = JSON.parse(jobRow?.stepsJson ?? "[]") as StepProgress[];
    const byStep = new Map(steps.map((s) => [s.step, s]));
    expect(byStep.get("fetch")?.status).toBe("done");
    expect(byStep.get("validate")?.status).toBe("done");
    expect(byStep.get("compute")?.status).toBe("done");
    for (const step of LLM_STEPS) {
      expect(byStep.get(step)?.status).toBe("skipped");
      expect(byStep.get(step)?.detail).toContain(MODEL_RESOLUTION_SKIP_PREFIX);
      expect(byStep.get(step)?.detail).toContain("transport error");
    }

    // No cost_log rows (no LLM calls).
    const costRows = handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all();
    expect(costRows).toHaveLength(0);

    // A schema-valid data-only report was persisted.
    const repRow = handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get();
    const parsed = ReportSchema.safeParse(JSON.parse(repRow?.reportJson ?? "{}"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.meta.symbol).toBe("AAPL");
      const llmGap = parsed.data.appendix.missingData.find((m) => m.field === "analysis.llm");
      expect(llmGap?.severity).toBe("critical");
    }

    // Terminal "done" event, no "error" event emitted.
    const types = events.map((e) => e.type);
    expect(types).not.toContain("error");
    expect(types[types.length - 1]).toBe("done");
    const done = events.find((e): e is Extract<JobEvent, { type: "done" }> => e.type === "done");
    expect(done?.dataOnly).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * runJob — judge/verify/assemble retry-on-validation contract (SPEC §2, Fix §2)
 * ------------------------------------------------------------------------ */

describe("runJob — judge retry on schema-validation failure (SPEC §2)", () => {
  it("retries the judge on schema-invalid output twice then succeeds (2 retries, then done)", async () => {
    const { jobId } = createJob("AAPL");
    const { passes, calls } = mockPasses();

    // The real facade converts a schema-invalid judge output into a throw
    // (unwrap). Simulate: throw on the first two attempts, succeed on the third.
    let judgeAttempts = 0;
    const feedbacks: Array<string | undefined> = [];
    const validJudge = passes.runJudgePass;
    passes.runJudgePass = (async (...args: unknown[]) => {
      const [deps, bull, bear, feedback] = args as [
        Parameters<PipelinePasses["runJudgePass"]>[0],
        Parameters<PipelinePasses["runJudgePass"]>[1],
        Parameters<PipelinePasses["runJudgePass"]>[2],
        string | undefined,
      ];
      feedbacks.push(feedback);
      judgeAttempts += 1;
      calls.push(`runJudgePass#${judgeAttempts}`);
      if (judgeAttempts <= MAX_JUDGE_RETRIES) {
        const err = new Error(`judge pass failed (refusal): schema-invalid structured output (attempt ${judgeAttempts})`);
        Object.assign(err, {
          billedAttempt: {
            model: "claude-opus-4-8",
            costUsd: 0.1 + judgeAttempts / 100,
            fallbackUsed: false,
            usage: { input_tokens: 1000, output_tokens: 2000 },
            webSearches: 0,
          },
        });
        throw err;
      }
      return validJudge(deps, bull, bear);
    }) as PipelinePasses["runJudgePass"];

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: true,
      now: NOW,
    });

    // Exactly 1 + MAX_JUDGE_RETRIES judge attempts (2 retries after the first).
    expect(judgeAttempts).toBe(MAX_JUDGE_RETRIES + 1);
    // Our wrapper recorded one "runJudgePass#N" per attempt.
    expect(calls.filter((c) => /^runJudgePass#\d+$/.test(c)).length).toBe(MAX_JUDGE_RETRIES + 1);
    expect(feedbacks[0]).toBeUndefined();
    expect(feedbacks[1]).toContain("schema-invalid structured output (attempt 1)");
    expect(feedbacks[2]).toContain("schema-invalid structured output (attempt 2)");

    // The run succeeds with a persisted, schema-valid report.
    expect(result.status).toBe("done");
    expect(result.reportId).not.toBeNull();
    expect(result.verificationRate).toBe(1);

    const jobRow = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    const steps = JSON.parse(jobRow?.stepsJson ?? "[]") as StepProgress[];
    const byStep = new Map(steps.map((s) => [s.step, s]));
    expect(byStep.get("synthesize")?.status).toBe("done");
    expect(byStep.get("verify")?.status).toBe("done");

    // Failed but billed judge attempts are logged before the successful retry.
    const costRows = handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all();
    expect(costRows.filter((r) => r.step === "synthesize")).toHaveLength(3);
    expect(costRows.map((r) => r.step).sort()).toEqual([
      "bear",
      "bull",
      "synthesize",
      "synthesize",
      "synthesize",
      "verify",
    ]);

    const repRow = handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get();
    const parsed = ReportSchema.safeParse(JSON.parse(repRow?.reportJson ?? "{}"));
    expect(parsed.success).toBe(true);
  });

  it("does not retry non-validation judge provider failures, but still logs billed cost once", async () => {
    const { jobId } = createJob("AAPL");
    const { passes } = mockPasses();
    let judgeAttempts = 0;
    passes.runJudgePass = async () => {
      judgeAttempts += 1;
      // Provider/model error text is untrusted too. A prohibited directive in
      // the raw error may remain in jobs.error/step diagnostics, but must never
      // bypass ReportSchema through the data-only persistence path.
      const err = new Error(
        "judge pass failed (max_tokens): response hit max_tokens=32000; Buy the stock now",
      );
      Object.assign(err, {
        retryable: false,
        billedAttempt: {
          model: "claude-opus-4-8",
          costUsd: 0.44,
          fallbackUsed: false,
          usage: { input_tokens: 20_000, output_tokens: 32_000, cache_read_input_tokens: 75_000 },
          webSearches: 0,
        },
      });
      throw err;
    };

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: true,
      now: NOW,
    });

    expect(judgeAttempts).toBe(1);
    expect(result.status).toBe("done");
    expect(result.dataOnly).toBe(true);

    const jobRow = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    const steps = JSON.parse(jobRow?.stepsJson ?? "[]") as StepProgress[];
    const byStep = new Map(steps.map((s) => [s.step, s]));
    expect(byStep.get("synthesize")?.status).toBe("error");
    expect(byStep.get("synthesize")?.detail).toContain("max_tokens");
    // The judge never produced output, so verify never ran — honestly
    // "skipped" (upstream failure), not "error".
    expect(byStep.get("verify")?.status).toBe("skipped");
    expect(byStep.get("verify")?.detail).toContain("upstream synthesize failed");

    const costRows = handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all();
    const synthRows = costRows.filter((r) => r.step === "synthesize");
    expect(synthRows).toHaveLength(1);
    expect(synthRows[0]?.costUsd).toBeCloseTo(0.44, 6);
    expect(synthRows[0]?.outputTokens).toBe(32_000);

    const repRow = handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get();
    const parsed = ReportSchema.safeParse(JSON.parse(repRow?.reportJson ?? "{}"));
    expect(parsed.success).toBe(true);
    expect(repRow?.reportJson).not.toMatch(/Buy the stock now/i);
  });

  it("publishes retryable judge schema failure details before retrying so live logs do not look hung", async () => {
    const { jobId } = createJob("AAPL");
    const { passes } = mockPasses();
    const validJudge = passes.runJudgePass;
    let judgeAttempts = 0;
    passes.runJudgePass = async (...args) => {
      judgeAttempts += 1;
      if (judgeAttempts === 1) {
        const err = new Error("judge pass failed (refusal): schema-invalid structured output: valuation.dcf required");
        Object.assign(err, {
          billedAttempt: {
            model: "claude-opus-4-8",
            costUsd: 0.44,
            fallbackUsed: false,
            usage: { input_tokens: 20_000, output_tokens: 41_657 },
            webSearches: 0,
          },
        });
        throw err;
      }
      return validJudge(...args);
    };
    const events: JobEvent[] = [];
    subscribeJob(jobId, (e) => events.push(e));

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: true,
      now: NOW,
    });

    expect(result.status).toBe("done");
    expect(judgeAttempts).toBe(2);
    const retryDetail = events.find(
      (e): e is Extract<JobEvent, { type: "step-update" }> =>
        e.type === "step-update" &&
        e.step.step === "synthesize" &&
        e.step.status === "running" &&
        typeof e.step.detail === "string" &&
        e.step.detail.includes("valuation.dcf required"),
    );
    expect(retryDetail).toBeDefined();
    expect(retryDetail!.step.detail).toContain("judge attempt 1/3 failed; retrying");
  });

  it("retries the judge on an assembleReport (report-schema) failure then succeeds", async () => {
    const { jobId } = createJob("AAPL");
    const { passes } = mockPasses();

    // Force the runner down the assembleReport path: verify returns no
    // verifiedReport (so the runner must assemble). assembleReport throws a
    // report-schema validation error on the first attempt, succeeds after.
    passes.runVerifyPass = async () => ({
      verifiedReport: undefined as unknown as Report,
      verificationRate: 1,
      costUsd: 0.2,
      model: "claude-opus-4-8",
      fallbackUsed: false,
      log: [],
    });
    let assembleAttempts = 0;
    passes.assembleReport = (input) => {
      assembleAttempts += 1;
      if (assembleAttempts === 1) {
        throw new Error("assembled report failed ReportSchema validation: meta.symbol required");
      }
      return fakeReport(input.judgeOutput);
    };

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: true,
      now: NOW,
    });

    // One retry: assemble ran twice (fail, then succeed).
    expect(assembleAttempts).toBe(2);
    expect(result.status).toBe("done");
    expect(result.reportId).not.toBeNull();

    const jobRow = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    const steps = JSON.parse(jobRow?.stepsJson ?? "[]") as StepProgress[];
    const byStep = new Map(steps.map((s) => [s.step, s]));
    expect(byStep.get("synthesize")?.status).toBe("done");
    expect(byStep.get("verify")?.status).toBe("done");
  });

  it("never persists a report that becomes invalid during final meta/log reconciliation", async () => {
    const { jobId } = createJob("AAPL");
    const { passes } = mockPasses();
    const originalVerify = passes.runVerifyPass;
    passes.runVerifyPass = async (...args) => {
      const result = await originalVerify(...args);
      return {
        ...result,
        log: [
          {
            claim: "Strong Buy after verification.",
            outcome: "unverified" as const,
            note: "nested rating-language tripwire",
          },
        ],
      };
    };

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: true,
      now: NOW,
    });

    expect(result.status).toBe("done");
    expect(result.dataOnly).toBe(true);
    const row = handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get();
    expect(ReportSchema.safeParse(JSON.parse(row?.reportJson ?? "{}")).success).toBe(true);
  });

  it("honors maxJudgeRetries=0 after an assembleReport failure so one-attempt harnesses do not retry judge", async () => {
    const { jobId } = createJob("AAPL");
    const { passes } = mockPasses();

    passes.runVerifyPass = async () => ({
      verifiedReport: undefined as unknown as Report,
      verificationRate: 1,
      costUsd: 0.2,
      model: "claude-opus-4-8",
      fallbackUsed: false,
      usage: { input_tokens: 1000, output_tokens: 500 },
      log: [],
    });
    let judgeAttempts = 0;
    let assembleAttempts = 0;
    const validJudge = passes.runJudgePass;
    passes.runJudgePass = async (...args) => {
      judgeAttempts += 1;
      return validJudge(...args);
    };
    passes.assembleReport = () => {
      assembleAttempts += 1;
      throw new Error("assembled report failed ReportSchema validation: meta.symbol required");
    };

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: true,
      now: NOW,
      maxJudgeRetries: 0,
    });

    expect(judgeAttempts).toBe(1);
    expect(assembleAttempts).toBe(1);
    expect(result.status).toBe("done");
    expect(result.dataOnly).toBe(true);

    const jobRow = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    const steps = JSON.parse(jobRow?.stepsJson ?? "[]") as StepProgress[];
    const byStep = new Map(steps.map((s) => [s.step, s]));
    expect(byStep.get("synthesize")?.status).toBe("error");
    expect(byStep.get("synthesize")?.detail).toContain("after 1 attempt");
    expect(byStep.get("verify")?.status).toBe("error");

    const costRows = handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all();
    expect(costRows.filter((r) => r.step === "synthesize")).toHaveLength(1);
    expect(costRows.filter((r) => r.step === "verify")).toHaveLength(1);
  });

  it("fails loudly on synthesize/verify when validation fails all attempts, still persists data-only (no crash)", async () => {
    const { jobId } = createJob("AAPL");
    const { passes } = mockPasses();

    // Judge is schema-invalid on EVERY attempt (throws every time).
    let judgeAttempts = 0;
    passes.runJudgePass = async () => {
      judgeAttempts += 1;
      throw new Error(`judge pass failed (refusal): schema-invalid structured output (attempt ${judgeAttempts})`);
    };

    const events: JobEvent[] = [];
    subscribeJob(jobId, (e) => events.push(e));

    // Must NOT throw / reject — the runner degrades gracefully.
    const result = await runJob(jobId, passes, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: true,
      now: NOW,
    });

    // Exhausted all attempts (1 + MAX_JUDGE_RETRIES).
    expect(judgeAttempts).toBe(MAX_JUDGE_RETRIES + 1);

    // The job still ends "done" (data-only) with a persisted report — never
    // "error" for a validation exhaustion, and never an unhandled rejection.
    expect(result.status).toBe("done");
    expect(result.reportId).not.toBeNull();
    expect(result.verificationRate).toBeNull();

    const jobRow = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(jobRow?.status).toBe("done");
    const steps = JSON.parse(jobRow?.stepsJson ?? "[]") as StepProgress[];
    const byStep = new Map(steps.map((s) => [s.step, s]));
    // synthesize marked "error" LOUDLY with the validation detail; verify
    // never ran (no judge attempt succeeded) so it is honestly "skipped".
    expect(byStep.get("synthesize")?.status).toBe("error");
    expect(byStep.get("verify")?.status).toBe("skipped");
    expect(byStep.get("synthesize")?.detail).toContain("failed schema validation");
    expect(byStep.get("synthesize")?.detail).toContain(String(MAX_JUDGE_RETRIES + 1));
    expect(byStep.get("verify")?.detail).toContain("upstream synthesize failed");

    // bull/bear still done, cost logged; NO synthesize cost row (every judge
    // attempt threw before cost logging).
    expect(byStep.get("bull")?.status).toBe("done");
    expect(byStep.get("bear")?.status).toBe("done");
    const costRows = handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all();
    expect(costRows.map((r) => r.step).sort()).toEqual(["bear", "bull"]);

    // A schema-valid data-only report was persisted (graceful persistence).
    const repRow = handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get();
    const parsed = ReportSchema.safeParse(JSON.parse(repRow?.reportJson ?? "{}"));
    expect(parsed.success).toBe(true);

    // No unhandled "error" event; terminal event is "done".
    const types = events.map((e) => e.type);
    expect(types).not.toContain("error");
    expect(types[types.length - 1]).toBe("done");
  });
});

/* ------------------------------------------------------------------------ *
 * initialSteps helper
 * ------------------------------------------------------------------------ */

describe("initialSteps", () => {
  it("returns the fixed pipeline order, all pending", () => {
    const steps = initialSteps();
    expect(steps.map((s) => s.step)).toEqual([...PIPELINE_STEPS]);
    expect(steps.every((s) => s.status === "pending")).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * Per-pass timing via analyst hooks (2026-07 audit item 6)
 * ------------------------------------------------------------------------ */

describe("runJob — per-pass timing", () => {
  it("stamps real per-side bull/bear times via hooks; verify starts only after a successful judge", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const passes: PipelinePasses = {
      ...base.passes,
      runBullThenBear: async (deps, hooks) => {
        hooks?.onPassStart?.("bull");
        await sleep(5);
        hooks?.onPassFinish?.("bull");
        hooks?.onPassStart?.("bear");
        await sleep(5);
        hooks?.onPassFinish?.("bear");
        return base.passes.runBullThenBear(deps);
      },
    };

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: true,
      now: NOW,
    });
    expect(result.status).toBe("done");

    const row = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    const steps = JSON.parse(row!.stepsJson) as StepProgress[];
    const byStep = Object.fromEntries(steps.map((s) => [s.step, s])) as Record<string, StepProgress>;

    // Each analyst side carries its own start/finish, in real order.
    expect(byStep.bull.startedAt).toBeDefined();
    expect(byStep.bull.finishedAt).toBeDefined();
    expect(byStep.bear.startedAt).toBeDefined();
    expect(byStep.bull.startedAt! <= byStep.bull.finishedAt!).toBe(true);
    expect(byStep.bull.startedAt! <= byStep.bear.startedAt!).toBe(true);
    expect(byStep.bull.finishedAt! <= byStep.bear.finishedAt!).toBe(true);

    // Verify starts when it actually runs (after the judge), not alongside it.
    expect(byStep.verify.startedAt).toBeDefined();
    expect(byStep.synthesize.startedAt! <= byStep.verify.startedAt!).toBe(true);
    expect(byStep.synthesize.finishedAt! <= byStep.verify.startedAt!).toBe(true);
    expect(byStep.synthesize.completedAt).toBe(byStep.synthesize.finishedAt);
    expect(byStep.verify.status).toBe("done");
  });
});

/* ------------------------------------------------------------------------ *
 * Stage-level resume (2026-07 audit item 1)
 * ------------------------------------------------------------------------ */

describe("runJob — resume from persisted analyst snapshots", () => {
  /** mockPasses whose judge fails hard (non-retryable) on the first run. */
  function failingJudgePasses(): { passes: PipelinePasses; calls: string[] } {
    const base = mockPasses();
    const calls: string[] = [];
    const passes: PipelinePasses = {
      ...base.passes,
      runBullThenBear: async (deps, hooks) => {
        calls.push("runBullThenBear");
        return base.passes.runBullThenBear(deps, hooks);
      },
      runJudgePass: async () => {
        calls.push("runJudgePass");
        throw new Error("judge pass failed (transport): stream rejected (simulated)");
      },
    };
    return { passes, calls };
  }

  it("first run persists bull/bear snapshots + fingerprint when synthesize fails", async () => {
    const { jobId } = createJob("AAPL");
    const { passes } = failingJudgePasses();
    const withFingerprint: PipelinePasses = {
      ...passes,
      fingerprintPayload: () => "fp-v1",
    };

    const result = await runJob(jobId, withFingerprint, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: true,
      now: NOW,
    });
    // Degrades to a data-only report, as before…
    expect(result.status).toBe("done");
    expect(result.dataOnly).toBe(true);

    // …but the paid analyst outputs are now persisted for a later resume.
    const snapshots = readPassSnapshots(jobId);
    expect(snapshots).not.toBeNull();
    expect(snapshots!.bull!.costUsd).toBe(0.9);
    expect(snapshots!.bear!.costUsd).toBe(0.47);
    expect(snapshots!.payloadFingerprint).toBe("fp-v1");
    expect(snapshots!.bull!.data.thesis.length).toBeGreaterThan(0);
  });

  it("resume skips runBullThenBear, reuses the snapshots, and accumulates cost on the same job", async () => {
    const { jobId } = createJob("AAPL");
    const first = failingJudgePasses();
    await runJob(jobId, first.passes, { bundle: fakeBundle("AAPL"), hasAnthropicKey: true, now: NOW });
    expect(first.calls).toContain("runBullThenBear");

    // Retry with a healthy judge: bull/bear must NOT run again.
    const second = mockPasses();
    const resumeCalls: string[] = [];
    const resumePasses: PipelinePasses = {
      ...second.passes,
      runBullThenBear: async () => {
        resumeCalls.push("runBullThenBear");
        throw new Error("must not re-run the analyst passes on resume");
      },
    };
    const result = await runJob(jobId, resumePasses, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: true,
      now: NOW,
      resume: true,
    });

    expect(resumeCalls).toEqual([]);
    expect(result.status).toBe("done");
    expect(result.dataOnly).toBe(false);
    expect(result.reportId).not.toBeNull();

    // Steps reflect the reuse.
    const row = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    const steps = JSON.parse(row!.stepsJson) as StepProgress[];
    const bull = steps.find((s) => s.step === "bull")!;
    expect(bull.status).toBe("done");
    expect(bull.detail).toContain("resume");
    expect(bull.costUsd).toBe(0.9);

    // cost_log keeps the ORIGINAL bull/bear rows (no duplicates) + the new
    // judge row; meta.costUsd covers the job's true all-in cost.
    const costRows = handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all();
    const bullRows = costRows.filter((r) => r.step === "bull");
    expect(bullRows).toHaveLength(1);
    expect(costRows.some((r) => r.step === "synthesize")).toBe(true);
    const reportRow = handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get();
    expect(reportRow!.costUsd!).toBeCloseTo(0.9 + 0.47 + 0.4 + 0.2, 4);
  });

  it("discloses payload drift as a warn gap fed into report assembly", async () => {
    const { jobId } = createJob("AAPL");
    const first = failingJudgePasses();
    await runJob(
      jobId,
      { ...first.passes, fingerprintPayload: () => "fp-v1" },
      { bundle: fakeBundle("AAPL"), hasAnthropicKey: true, now: NOW },
    );

    // Force the assembleReport path (verify throws) and record the computed
    // gaps the runner hands it — the drift gap must be among them.
    const second = mockPasses();
    const assembledGapFields: string[][] = [];
    const result = await runJob(
      jobId,
      {
        ...second.passes,
        fingerprintPayload: () => "fp-v2-DRIFTED",
        runVerifyPass: async () => {
          throw new Error("verify unavailable (simulated)");
        },
        assembleReport: (input) => {
          assembledGapFields.push(input.computed.gaps.map((g) => g.field));
          return second.passes.assembleReport(input);
        },
      },
      { bundle: fakeBundle("AAPL"), hasAnthropicKey: true, now: NOW, resume: true },
    );
    expect(result.status).toBe("done");
    expect(result.dataOnly).toBe(false);
    expect(assembledGapFields).toHaveLength(1);
    expect(assembledGapFields[0]).toContain("analysis.resume");
  });

  it("a resume without snapshots degrades to a full fresh run", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();

    const result = await runJob(jobId, base.passes, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: true,
      now: NOW,
      resume: true, // nothing persisted yet — must fall back to fresh passes
    });
    expect(base.calls).toContain("runBullThenBear");
    expect(result.status).toBe("done");
    expect(result.dataOnly).toBe(false);
  });

  it("readPassSnapshots is per-side: invalid sides null out, and only both-null is unusable", () => {
    const { jobId } = createJob("AAPL");
    // Nothing persisted -> null (nothing to resume from).
    expect(readPassSnapshots(jobId)).toBeNull();

    // Only bull persisted -> usable partial: bull present, bear null (the
    // resume path re-runs ONLY bear instead of re-billing both).
    handle.db
      .update(jobs)
      .set({
        bullJson: JSON.stringify({
          data: fakeAnalystCase(),
          model: "m",
          costUsd: 1,
          fallbackUsed: false,
          fetchedUrls: ["https://example.com/a"],
        }),
      })
      .where(eq(jobs.id, jobId))
      .run();
    const bullOnly = readPassSnapshots(jobId);
    expect(bullOnly).not.toBeNull();
    expect(bullOnly!.bull).not.toBeNull();
    expect(bullOnly!.bear).toBeNull();
    expect(bullOnly!.bull!.fetchedUrls).toEqual(["https://example.com/a"]);

    // Corrupt bear JSON -> bear stays null; the valid bull is NOT discarded.
    handle.db.update(jobs).set({ bearJson: "{not json" }).where(eq(jobs.id, jobId)).run();
    expect(readPassSnapshots(jobId)!.bear).toBeNull();
    expect(readPassSnapshots(jobId)!.bull).not.toBeNull();

    // Schema-invalid AnalystCase -> that side null (a resumed judge is never
    // fed a corrupt snapshot).
    handle.db
      .update(jobs)
      .set({ bearJson: JSON.stringify({ data: { wrong: true }, model: "m", costUsd: 1, fallbackUsed: false }) })
      .where(eq(jobs.id, jobId))
      .run();
    expect(readPassSnapshots(jobId)!.bear).toBeNull();

    // Corrupt bull too -> both null -> null (start a fresh run instead).
    handle.db.update(jobs).set({ bullJson: "{not json" }).where(eq(jobs.id, jobId)).run();
    expect(readPassSnapshots(jobId)).toBeNull();
  });

  it("partial persistence + resume: a saved bull is reused and ONLY bear re-runs", async () => {
    const { jobId } = createJob("AAPL");
    // First run: bull succeeds, bear fails (the 2026-07-10 "some calls error,
    // others don't" shape). The runner must persist the paid bull output.
    const bullResult: PassResultLike<AnalystCase> = {
      data: fakeAnalystCase(),
      model: "claude-opus-4-8",
      costUsd: 0.9,
      fallbackUsed: false,
      usage: { input_tokens: 15000, output_tokens: 6000 },
      webSearches: 7,
    };
    const firstError = Object.assign(new Error("bull/bear pass failed"), {
      bull: bullResult,
      bearError: "bear pass failed (transport): stream died overloaded",
      bearBilledAttempt: {
        model: "claude-opus-4-8",
        costUsd: 0.31,
        fallbackUsed: false,
        usage: { input_tokens: 14000, output_tokens: 5000 },
        webSearches: 6,
      },
    });
    const first = mockPasses();
    await runJob(
      jobId,
      {
        ...first.passes,
        fingerprintPayload: () => "fp-v1",
        runBullThenBear: async () => {
          throw firstError;
        },
      },
      { bundle: fakeBundle("AAPL"), hasAnthropicKey: true, now: NOW },
    );
    const persisted = readPassSnapshots(jobId);
    expect(persisted!.bull).not.toBeNull();
    expect(persisted!.bear).toBeNull();
    expect(persisted!.payloadFingerprint).toBe("fp-v1");

    // Resume: bull must be REUSED (runBullThenBear never called), bear re-run
    // via the single-side runner, then synthesis proceeds normally.
    const second = mockPasses();
    const analystCalls: string[] = [];
    const resumePasses: PipelinePasses = {
      ...second.passes,
      fingerprintPayload: () => "fp-v1",
      runBullThenBear: async () => {
        throw new Error("must not re-run BOTH analyst passes on partial resume");
      },
      runAnalystPass: async (_deps, side) => {
        analystCalls.push(side);
        return {
          data: fakeAnalystCase(),
          model: "claude-opus-4-8",
          costUsd: 0.52,
          fallbackUsed: false,
          usage: { input_tokens: 14000, output_tokens: 5500 },
          webSearches: 5,
        };
      },
    };
    const result = await runJob(jobId, resumePasses, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: true,
      now: NOW,
      resume: true,
    });

    expect(analystCalls).toEqual(["bear"]);
    expect(result.status).toBe("done");
    expect(result.dataOnly).toBe(false);
    expect(result.reportId).not.toBeNull();

    const row = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    const steps = JSON.parse(row!.stepsJson) as StepProgress[];
    const byStep = new Map(steps.map((s) => [s.step, s]));
    expect(byStep.get("bull")?.status).toBe("done");
    expect(byStep.get("bull")?.detail).toContain("resume");
    expect(byStep.get("bear")?.status).toBe("done");
    expect(byStep.get("bear")?.detail ?? "").not.toContain("resume");

    // Cost ledger: original bull ($0.9) + failed bear attempt ($0.31) + fresh
    // bear ($0.52) + judge + verify — all on ONE job id, nothing re-billed.
    const costRows = handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all();
    expect(costRows.filter((r) => r.step === "bull")).toHaveLength(1);
    expect(costRows.filter((r) => r.step === "bear")).toHaveLength(2);
    const reportRow = handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get();
    expect(reportRow!.costUsd!).toBeCloseTo(0.9 + 0.31 + 0.52 + 0.4 + 0.2, 4);

    // The freshly re-run bear is persisted too — a THIRD attempt (if synthesis
    // had failed) would reuse both sides.
    const after = readPassSnapshots(jobId);
    expect(after!.bear).not.toBeNull();
    expect(after!.bear!.costUsd).toBeCloseTo(0.52, 6);
  });

  it("partial resume whose re-run side fails again degrades to data-only with the billed cost recorded", async () => {
    const { jobId } = createJob("AAPL");
    const first = mockPasses();
    await runJob(
      jobId,
      {
        ...first.passes,
        runBullThenBear: async () => {
          throw Object.assign(new Error("bull/bear pass failed"), {
            bull: {
              data: fakeAnalystCase(),
              model: "claude-opus-4-8",
              costUsd: 0.9,
              fallbackUsed: false,
            } as PassResultLike<AnalystCase>,
            bearError: "bear pass failed (transport): stream died overloaded",
          });
        },
      },
      { bundle: fakeBundle("AAPL"), hasAnthropicKey: true, now: NOW },
    );

    const second = mockPasses();
    const result = await runJob(
      jobId,
      {
        ...second.passes,
        runBullThenBear: async () => {
          throw new Error("must not re-run BOTH analyst passes on partial resume");
        },
        runAnalystPass: async () => {
          const err = new Error("bear pass failed (transport): still overloaded");
          Object.assign(err, {
            billedAttempt: {
              model: "claude-opus-4-8",
              costUsd: 0.28,
              fallbackUsed: false,
              usage: { input_tokens: 14000, output_tokens: 4200 },
              webSearches: 3,
            },
          });
          throw err;
        },
      },
      { bundle: fakeBundle("AAPL"), hasAnthropicKey: true, now: NOW, resume: true },
    );

    expect(result.status).toBe("done");
    expect(result.dataOnly).toBe(true);

    const row = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    const steps = JSON.parse(row!.stepsJson) as StepProgress[];
    const byStep = new Map(steps.map((s) => [s.step, s]));
    expect(byStep.get("bull")?.status).toBe("done"); // reused, still not lost
    expect(byStep.get("bear")?.status).toBe("error");
    expect(byStep.get("bear")?.detail).toContain("still overloaded");
    expect(byStep.get("synthesize")?.status).toBe("skipped");

    // The failed retry attempt's spend is on the ledger.
    const costRows = handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all();
    const bearRows = costRows.filter((r) => r.step === "bear");
    expect(bearRows).toHaveLength(1);
    expect(bearRows[0]?.costUsd).toBeCloseTo(0.28, 6);

    // The bull snapshot SURVIVES the failed resume — retry again later.
    expect(readPassSnapshots(jobId)!.bull).not.toBeNull();
  });

  it("a partial snapshot without runAnalystPass support falls back to a fresh full run", async () => {
    const { jobId } = createJob("AAPL");
    // Persist only bull (simulating a partial failure recorded by an older run).
    handle.db
      .update(jobs)
      .set({
        bullJson: JSON.stringify({
          data: fakeAnalystCase(),
          model: "claude-opus-4-8",
          costUsd: 0.9,
          fallbackUsed: false,
        }),
      })
      .where(eq(jobs.id, jobId))
      .run();

    const base = mockPasses(); // has NO runAnalystPass
    const result = await runJob(jobId, base.passes, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: true,
      now: NOW,
      resume: true,
    });
    // Safe degradation: both passes re-run (re-billed), report still produced.
    expect(base.calls).toContain("runBullThenBear");
    expect(result.status).toBe("done");
    expect(result.dataOnly).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * Review-finding regressions (2026-07-09 adversarial review)
 * ------------------------------------------------------------------------ */

describe("review regressions — cost rehydration, live-job guard, resumability predicate", () => {
  it("a resumed run that degrades (no key) still reports the job's true prior spend", async () => {
    const { jobId } = createJob("AAPL");
    // Seed prior spend as if bull/bear ran on an earlier attempt.
    handle.db.insert(costLog).values([
      { jobId, step: "bull", model: "m", costUsd: 0.7, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, fallbackUsed: false, createdAt: "2026-07-09T00:00:00.000Z" },
      { jobId, step: "bear", model: "m", costUsd: 0.4, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, fallbackUsed: false, createdAt: "2026-07-09T00:00:00.000Z" },
    ]).run();

    const { passes } = mockPasses();
    const result = await runJob(jobId, passes, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: false, // degraded exit BEFORE the resume branch
      now: NOW,
      resume: true,
    });
    expect(result.dataOnly).toBe(true);
    expect(result.totalCostUsd).toBeCloseTo(1.1, 6);

    const reportRow = handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get();
    expect(reportRow?.costUsd).toBeCloseTo(1.1, 6);
    const report = JSON.parse(reportRow!.reportJson!) as Report;
    expect(report.meta.costUsd).toBeCloseTo(1.1, 6);
  });

  it("sweepAbandonedJobs never reaps a job THIS process is still executing", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    let releaseBull: (() => void) | undefined;
    const bullGate = new Promise<void>((resolve) => {
      releaseBull = resolve;
    });
    const passes: PipelinePasses = {
      ...base.passes,
      runBullThenBear: async (deps, hooks) => {
        await bullGate; // hold the run mid-pass
        return base.passes.runBullThenBear(deps, hooks);
      },
    };

    const running = runJob(jobId, passes, { bundle: fakeBundle("AAPL"), hasAnthropicKey: true, now: NOW });
    // Let runJob reach the awaited pass, then backdate it past staleness.
    await new Promise((r) => setTimeout(r, 20));
    const staleIso = new Date(Date.now() - ACTIVE_JOB_STALE_MS - 60_000).toISOString();
    handle.db.update(jobs).set({ updatedAt: staleIso }).where(eq(jobs.id, jobId)).run();

    // Both the global sweep and the per-symbol expiry must skip the live job.
    expect(sweepAbandonedJobs()).toBe(0);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.status).toBe("running");
    expect(getReusableActiveJobForSymbol("AAPL")).not.toBeNull();

    releaseBull!();
    const result = await running;
    expect(result.status).toBe("done");
    // After completion the job is no longer live — a stale row WOULD be swept.
    handle.db.update(jobs).set({ status: "running", updatedAt: staleIso }).where(eq(jobs.id, jobId)).run();
    expect(sweepAbandonedJobs()).toBe(1);
  });

  it("cancels an active job through the shared job AbortSignal without persisting a report", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const passes: PipelinePasses = {
      ...base.passes,
      runBullThenBear: async (deps) => {
        entered();
        await new Promise<never>((_resolve, reject) => {
          expect(deps.signal).toBeInstanceOf(AbortSignal);
          deps.signal!.addEventListener("abort", () => reject(deps.signal!.reason), { once: true });
        });
        throw new Error("unreachable after cancellation");
      },
    };

    const running = runJob(jobId, passes, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: true,
      now: NOW,
      deadlineMs: 10_000,
    });
    await started;
    expect(cancelJob(jobId)).toBe(true);

    const result = await running;
    expect(result.status).toBe("error");
    expect(result.reportId).toBeNull();
    expect(handle.db.select().from(reports).all()).toHaveLength(0);
    const row = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(row?.status).toBe("error");
    expect(row?.error).toContain("canceled by user");
    expect(cancelJob(jobId)).toBe(false);
  });

  it("enforces a hard overall deadline even when an injected pass ignores cancellation", async () => {
    const { jobId } = createJob("MSFT");
    const base = mockPasses();
    const never = new Promise<never>(() => {});
    const passes: PipelinePasses = {
      ...base.passes,
      runBullThenBear: async () => never,
    };

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle("MSFT"),
      hasAnthropicKey: true,
      now: NOW,
      deadlineMs: 10,
    });

    expect(result.status).toBe("error");
    const row = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(row?.error).toContain("overall deadline exceeded");
    expect(handle.db.select().from(reports).all()).toHaveLength(0);
  });

  it("stepsShowResumableFailure accepts synthesis failures AND one-sided analyst failures", () => {
    const shape = (bull: string, bear: string, synth: string) =>
      stepsShowResumableFailure([
        { step: "bull", status: bull },
        { step: "bear", status: bear },
        { step: "synthesize", status: synth },
      ] as StepProgress[]);
    // Classic shape: both analysts paid, synthesis failed — resume the tail.
    expect(shape("done", "done", "error")).toEqual({ doneSides: ["bull", "bear"], failedSides: [] });
    // Partial shape: one paid side saved, the other errored — resume re-runs
    // only the failed side (synthesize was honestly "skipped").
    expect(shape("done", "error", "skipped")).toEqual({ doneSides: ["bull"], failedSides: ["bear"] });
    expect(shape("error", "done", "skipped")).toEqual({ doneSides: ["bear"], failedSides: ["bull"] });
    // Never resumable: healthy job (would re-bill / could overwrite its report)…
    expect(shape("done", "done", "done")).toBeNull();
    // …both analysts dead (nothing to reuse — fresh run is strictly correct)…
    expect(shape("error", "error", "skipped")).toBeNull();
    // …or a run that never reached a terminal analyst state.
    expect(shape("done", "done", "skipped")).toBeNull();
    expect(shape("done", "running", "pending")).toBeNull();
    expect(stepsShowResumableFailure([])).toBeNull();
  });

  it("claimJobForResume lets exactly one terminal-state contender claim a retry", () => {
    const { jobId } = createJob("AAPL");
    handle.db
      .update(jobs)
      .set({ status: "done", error: "synthesize failed" })
      .where(eq(jobs.id, jobId))
      .run();

    expect(claimJobForResume(jobId, "done")).toBe(true);
    const claimed = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(claimed?.status).toBe("queued");
    expect(claimed?.error).toBeNull();
    expect(claimJobForResume(jobId, "done")).toBe(false);
  });

  // Regression (2026-07-20 audit): a resume that DEGRADES before re-marking the
  // analyst steps (no-key/model-resolution failure) rewrote bull/bear/synthesize
  // "skipped" and finished "done", so stepsShowResumableFailure returned null
  // forever and the retry route 409'd — stranding BOTH already-paid snapshots.
  // snapshotsCoverResume rescues that shape; a re-resume reuses the snapshots.
  it("a degraded resume does not strand the paid snapshots — the job stays resumable", async () => {
    const { jobId } = createJob("AAPL");

    // 1) First run: synthesize fails after both analysts → both PAID snapshots
    //    persisted; classic resumable shape.
    const firstPasses: PipelinePasses = {
      ...mockPasses().passes,
      runJudgePass: async () => {
        throw new Error("judge pass failed (transport): stream rejected (simulated)");
      },
    };
    await runJob(jobId, firstPasses, { bundle: fakeBundle("AAPL"), hasAnthropicKey: true, now: NOW });
    const afterFirst = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    expect(
      stepsShowResumableFailure(JSON.parse(afterFirst.stepsJson) as StepProgress[]),
    ).not.toBeNull();

    // 2) Resume that DEGRADES before the resume branch (no key): steps rewritten
    //    all-skipped, job finishes "done" — the step shape is now non-resumable.
    claimJobForResume(jobId, afterFirst.status); // mirror the retry route's claim
    await runJob(jobId, mockPasses().passes, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: false,
      now: NOW,
      resume: true,
    });
    const afterDegraded = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    const degradedSteps = JSON.parse(afterDegraded.stepsJson) as StepProgress[];
    expect(stepsShowResumableFailure(degradedSteps)).toBeNull(); // shape lost…
    const snapshots = readPassSnapshots(jobId);
    expect(snapshots!.bull).not.toBeNull();
    expect(snapshots!.bear).not.toBeNull();
    // …but the snapshot-level fallback keeps it resumable.
    expect(snapshotsCoverResume(snapshots, degradedSteps)).toBe(true);

    // 3) Re-resume with a healthy judge: BOTH snapshots reused (analysts must
    //    NOT re-run), a real report is produced — nothing re-billed.
    claimJobForResume(jobId, afterDegraded.status);
    const healthy = mockPasses();
    const rebillGuard: PipelinePasses = {
      ...healthy.passes,
      runBullThenBear: async () => {
        throw new Error("must not re-run analyst passes — the snapshots were stranded");
      },
    };
    const result = await runJob(jobId, rebillGuard, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: true,
      now: NOW,
      resume: true,
    });
    expect(result.status).toBe("done");
    expect(result.dataOnly).toBe(false);
    expect(result.reportId).not.toBeNull();
  });

  it("snapshotsCoverResume: both snapshots + synthesize!=done ⇒ resumable; done or a missing side ⇒ not", () => {
    const { jobId } = createJob("AAPL");
    const bothSnap = JSON.stringify({
      data: fakeAnalystCase(),
      model: "m",
      costUsd: 0.9,
      fallbackUsed: false,
    });
    handle.db
      .update(jobs)
      .set({ bullJson: bothSnap, bearJson: bothSnap })
      .where(eq(jobs.id, jobId))
      .run();
    const snap = readPassSnapshots(jobId);
    const skipped = [{ step: "synthesize", status: "skipped" }] as StepProgress[];
    expect(snapshotsCoverResume(snap, skipped)).toBe(true);
    // A completed synthesis is never resumable (its report must not be re-billed).
    expect(snapshotsCoverResume(snap, [{ step: "synthesize", status: "done" }] as StepProgress[])).toBe(false);
    // A missing side falls to the single-side path, not this fallback.
    handle.db.update(jobs).set({ bearJson: null }).where(eq(jobs.id, jobId)).run();
    expect(snapshotsCoverResume(readPassSnapshots(jobId), skipped)).toBe(false);
    // No snapshots at all.
    expect(snapshotsCoverResume(null, skipped)).toBe(false);
  });

  // Regression (2026-07-20 audit): the sweep's per-row UPDATE dropped the
  // stale-status predicate (a TOCTOU widening vs the prior atomic UPDATE). A row
  // that flips live between the sweep's SELECT and its per-row write must not be
  // clobbered back to error.
  it("sweepAbandonedJobs re-checks staleness on the write (row that goes live mid-sweep is not clobbered)", () => {
    const now = new Date("2026-07-09T12:00:00.000Z");
    const staleIso = new Date(now.getTime() - ACTIVE_JOB_STALE_MS - 1000).toISOString();
    const { jobId } = createJob("RACE");
    handle.db.update(jobs).set({ status: "running", updatedAt: staleIso }).where(eq(jobs.id, jobId)).run();

    // Simulate a concurrent claim landing in the SELECT→UPDATE window: on the
    // sweep's first per-row UPDATE call, flip the row fresh-running (as a
    // resume/heartbeat would) BEFORE the guarded write commits. Shadow the
    // instance method directly (robust whether it lives on the instance or the
    // Drizzle prototype); delete restores the original.
    const shadow = handle.db as unknown as { update: (table: unknown) => unknown };
    const realUpdate = handle.db.update.bind(handle.db);
    let interleaved = false;
    shadow.update = (table: unknown) => {
      if (!interleaved) {
        interleaved = true;
        realUpdate(jobs).set({ updatedAt: now.toISOString() }).where(eq(jobs.id, jobId)).run();
      }
      return realUpdate(table as typeof jobs);
    };
    try {
      sweepAbandonedJobs(now);
    } finally {
      delete (shadow as { update?: unknown }).update;
    }
    expect(interleaved).toBe(true); // the interleave actually fired

    // With the stale predicate re-asserted, the freshly-live row is NOT reverted.
    const row = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(row?.status).toBe("running");
    expect(row?.error).toBeNull();
  });

  // Regression (2026-07-20 audit): a cancel acknowledged (202) in the resume
  // dispatch window flips the claimed row to error "job canceled by user"; the
  // runJob resume gate accepted that error+resume and re-ran the paid passes,
  // silently un-doing the cancel. It must honor the cancel.
  it("an acknowledged cancel is not overridden by a resume dispatched in the same window", async () => {
    const { jobId } = createJob("AAPL");
    const snap = JSON.stringify({
      data: fakeAnalystCase(),
      model: "m",
      costUsd: 0.9,
      fallbackUsed: false,
    });
    handle.db
      .update(jobs)
      .set({
        status: "error",
        error: "synthesize failed",
        stepsJson: JSON.stringify([
          { step: "bull", status: "done" },
          { step: "bear", status: "done" },
          { step: "synthesize", status: "error" },
        ]),
        bullJson: snap,
        bearJson: snap,
      })
      .where(eq(jobs.id, jobId))
      .run();

    // Retry route claims the terminal job to "queued"; a cancel lands in the
    // async gap before runJob starts → flips it to error+marker, returns 202.
    expect(claimJobForResume(jobId, "error")).toBe(true);
    expect(cancelJob(jobId)).toBe(true);
    const canceled = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    expect(canceled.status).toBe("error");
    expect(canceled.error).toBe(JOB_CANCELED_ERROR);

    // The dispatched resume finally runs — it must NOT re-run any paid pass.
    const healthy = mockPasses();
    const guard: PipelinePasses = {
      ...healthy.passes,
      runBullThenBear: async () => {
        throw new Error("resume ran despite an acknowledged cancel");
      },
      runJudgePass: async () => {
        throw new Error("resume ran despite an acknowledged cancel");
      },
    };
    const result = await runJob(jobId, guard, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: true,
      now: NOW,
      resume: true,
    });
    expect(result.status).toBe("error");

    // Job left canceled; no report produced.
    const after = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    expect(after.status).toBe("error");
    expect(after.error).toBe(JOB_CANCELED_ERROR);
    expect(handle.db.select().from(reports).all()).toHaveLength(0);
  });
});
