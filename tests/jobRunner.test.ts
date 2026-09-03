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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3";
import type { ThesisConfig } from "@/config/env";

const providerBoundaryMocks = vi.hoisted(() => ({
  runPass: vi.fn(async () => {
    throw new Error("provider runPass must not run during durable verify recovery");
  }),
  runPassStreaming: vi.fn(() => {
    throw new Error("provider runPassStreaming must not run during durable verify recovery");
  }),
  webSearchTool: vi.fn(() => {
    throw new Error("provider webSearchTool must not run during durable verify recovery");
  }),
}));
const configMocks = vi.hoisted(() => ({
  getConfig: vi.fn<() => ThesisConfig>(() => ({
    fmpApiKey: undefined,
    finnhubApiKey: undefined,
    fredApiKey: undefined,
    anthropicApiKey: undefined,
    anthropicAdminKey: undefined,
    analysisModel: "auto",
    hasFmpKey: false,
    hasFinnhubKey: false,
    hasFredKey: false,
    hasAnthropicKey: false,
    fixtureMode: true,
    // WS4 (D-12): statement-source policy; the default.
    statementSource: "auto" as const,
    maxActiveJobs: 1,
    maxActiveLlmCalls: 2,
    maxJobCostUsd: null,
    maxRollingCostUsd: null,
    rollingCostWindowMs: 86_400_000,
    paidPassLeaseTtlMs: 900_000,
    jobLeaseTtlMs: 900_000,
    streamIdleTimeoutMs: 120_000,
    reservationMode: "request" as const,
    // WS8 added these two config fields; this mock returns the full ThesisConfig.
    resumeOnStart: true,
    tokenFile: undefined,
    // WS6 (D-19): THESIS_EV_INCLUDE_LEASES defaults off.
    evIncludeLeases: false,
    // WS7 (D-20): THESIS_JUDGE_ORDER defaults to the one-judge-pass random order.
    judgeOrder: "random" as const,
  })),
}));

vi.mock("@/config/env", () => ({
  getConfig: configMocks.getConfig,
}));

// Mock the Anthropic provider so the runner's model-resolution step is driven
// by the test (no live network). By default resolveModel succeeds with a fixed
// model (the happy-path tests need it to resolve); individual tests override it
// (e.g. to throw for the model-resolution-failure case). Provider pass boundaries
// fail loudly so the real Stage C facade remains network-free in recovery tests.
vi.mock("@/providers/anthropic", () => ({
  maximumPassCostUsd: vi.fn((_model: string, pass: string, capability?: { billable?: boolean }) =>
    pass === "verify" && capability?.billable === false ? 0 : 100),
  // The pass lease reserves one request maximum in request-reservation mode.
  maximumRequestCostUsd: vi.fn((_model: string, pass: string, capability?: { billable?: boolean }) =>
    pass === "verify" && capability?.billable === false ? 0 : 100),
  resolveModel: vi.fn(async (setting: string) => ({
    model: setting === "auto" || setting === "" ? "claude-opus-4-8" : setting,
    resolvedFrom: setting === "auto" ? ("auto" as const) : ("explicit" as const),
  })),
  runPass: providerBoundaryMocks.runPass,
  runPassStreaming: providerBoundaryMocks.runPassStreaming,
  webSearchTool: providerBoundaryMocks.webSearchTool,
}));

import { resolveModel, type RequestAdmission } from "@/providers/anthropic";
import {
  bootstrapSchema,
  createDatabase,
  setDbForTests,
  type DatabaseHandle,
  type ThesisDb,
} from "@/db";
import { costLog, jobLlmLeases, jobPassArtifacts, jobs, reports } from "@/db/schema";
import { setSetting } from "@/settings/settings";
import { explainAnalysisModel } from "@/settings/contracts";
import {
  ACTIVE_JOB_STALE_MS,
  BullBearPassFailure,
  cancelJob,
  claimJobForResume,
  claimPreparedJobResume,
  createJob,
  getOrCreateJobForSymbol,
  getReusableActiveJobForSymbol,
  isSymbolJobActive,
  JOB_CANCELED_ERROR,
  JOB_HEARTBEAT_MS,
  readPassSnapshots,
  recordQueuedResumeDispatchFailure,
  prepareJobResume,
  prepareQueuedJobResume,
  runJob,
  sweepAbandonedJobs,
  DURABLE_LAUNCH_AUTHORITY_CAPABILITY,
  initialSteps,
  LLM_STEPS,
  NO_KEY_SKIP_REASON,
  MAX_JUDGE_RETRIES,
  MODEL_RESOLUTION_SKIP_PREFIX,
  type PipelinePasses,
  type PassResultLike,
  type RunJobOptions,
  type VerifyPassResult,
} from "@/pipeline/jobRunner";
import {
  DURABLE_PASSES,
  PASS_ARTIFACT_ENVELOPE_VERSION,
  parsePassArtifactEnvelope,
  persistPassSettlement,
  readCurrentGenerationPassArtifacts,
} from "@/pipeline/jobArtifacts";
import { readJobResumeState } from "@/pipeline/jobStore";
import { claimNextQueuedJob, configuredSchedulerLimits } from "@/pipeline/jobScheduler";
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
import { runStageB } from "@/pipeline/compute";
import { validateBundle } from "@/pipeline/stageA/validate";
import { pipelinePasses } from "@/pipeline/stageC";
import {
  completeJudgeProtocol,
  resolveJudgeOrder,
} from "@/pipeline/stageC/judgeProtocol";
import { sharedModelFamilyOf } from "@/report/execution";
import { deriveReportCompletenessPresentation } from "@/report/completeness";
import { PIPELINE_STEPS, type StepProgress } from "@/types/core";

/* ------------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------------ */

let handle: DatabaseHandle;
let tempDirectory: string | null;

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
  tempDirectory = null;
  handle = createDatabase(":memory:");
  setDbForTests(handle.db);
  _clearJobSubscribers();
  // Reset the model-resolution mock to its success default (vi.mock factory
  // implementations persist across tests; restoreAllMocks does not reset them).
  resolveModelMock.mockReset();
  resolveModelMock.mockImplementation(defaultResolveModel);
  providerBoundaryMocks.runPass.mockClear();
  providerBoundaryMocks.runPassStreaming.mockClear();
  providerBoundaryMocks.webSearchTool.mockClear();
  configMocks.getConfig.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  setDbForTests(null);
  handle.sqlite.close();
  if (tempDirectory !== null) rmSync(tempDirectory, { recursive: true, force: true });
  _clearJobSubscribers();
  vi.restoreAllMocks();
});

/** A minimal DataBundle stub sufficient for validate + compute + persistence. */
function fakeBundle(
  symbol = "AAPL",
  instrument: { isEtf?: boolean | null; isFund?: boolean | null } = {},
): DataBundle {
  const builtAt = "2026-07-06T00:00:00.000Z";
  const gap = { ok: false as const, gap: { field: "x", reason: "fixture", severity: "info" as const } };
  const profile = {
    ok: true as const,
    value: {
      data: {
        rows: [{ companyName: "Apple Inc.", sector: "Technology", price: 200, ...instrument }],
        raw: {},
      },
      asOf: "2026-07-01",
      source: "fmp" as const,
      endpoint: "profile",
      fetchedAt: builtAt,
      stale: false,
    },
  };
  const treasury = {
    ok: true as const,
    value: {
      data: { rows: [{ date: "2026-07-04", year10: 4.4 }], raw: {} },
      asOf: "2026-07-04",
      source: "fmp" as const,
      endpoint: "/stable/treasury-rates",
      fetchedAt: "2026-07-05T18:30:00.000Z",
      stale: true,
    },
  };
  const sourceManifest = {
    profile: {
      provider: profile.value.source,
      endpoint: profile.value.endpoint,
      asOf: profile.value.asOf,
      fetchedAt: profile.value.fetchedAt,
      stale: profile.value.stale,
    },
    treasury: {
      provider: treasury.value.source,
      endpoint: treasury.value.endpoint,
      asOf: treasury.value.asOf,
      fetchedAt: treasury.value.fetchedAt,
      stale: treasury.value.stale,
    },
  };
  const asOf = Object.fromEntries(
    Object.entries(sourceManifest).map(([field, entry]) => [field, entry.asOf]),
  );
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
    treasury,
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
    sourceManifest,
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
      // WS6 (D-19): a HISTORICAL disclaimer string; the schema accepts any
      // non-empty text on the parse side so persisted reports stay readable.
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
    launchAuthorityCapability: DURABLE_LAUNCH_AUTHORITY_CAPABILITY,
    verifyCapability: {
      billable: true,
      maxInputTokens: 12_000,
      maxOutputTokens: 4_000,
      maxWebSearches: 0,
    },
    preflightPass: () => {},
    assembleContextPayload: (b, c, v) => {
      calls.push("assembleContextPayload");
      void b;
      void c;
      void v;
      return { payload: true };
    },
    runBullThenBear: async (_deps, hooks, settlements) => {
      calls.push("runBullThenBear");
      await hooks?.beforePass?.("bull");
      hooks?.onPassStart?.("bull");
      await hooks?.beforeProviderLaunch?.("bull");
      let bullSettlementError: unknown;
      try {
        await settlements?.bull?.(testSuccessSettlement(bull));
      } catch (error) {
        bullSettlementError = error;
      }
      hooks?.onPassFinish?.("bull");
      await hooks?.beforePass?.("bear");
      hooks?.onPassStart?.("bear");
      await hooks?.beforeProviderLaunch?.("bear");
      let bearSettlementError: unknown;
      try {
        await settlements?.bear?.(testSuccessSettlement(bear));
      } catch (error) {
        bearSettlementError = error;
      }
      hooks?.onPassFinish?.("bear");
      if (bullSettlementError !== undefined) throw bullSettlementError;
      if (bearSettlementError !== undefined) throw bearSettlementError;
      return { bull, bear };
    },
    runJudgePass: async (...raw: unknown[]) => {
      const beforeProviderLaunch = raw[5] as (() => void | Promise<void>) | undefined;
      await beforeProviderLaunch?.();
      calls.push("runJudgePass");
      return judgeResult;
    },
    runVerifyPass: async (...raw: unknown[]) => {
      const beforeProviderLaunch = raw[4] as (() => void | Promise<void>) | undefined;
      await beforeProviderLaunch?.();
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

type TestSettlement<T> =
  | { outcome: "success"; data: T; telemetry: TestTelemetry }
  | { outcome: "failure"; failure: { name: string; message: string; kind?: string }; telemetry: TestTelemetry };

interface TestTelemetry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
  costUsd: number;
  fallbackUsed: boolean;
  billable: boolean;
  fetchedUrls: string[];
}

type TestSettlementHook<T> = (settlement: TestSettlement<T>) => void | Promise<void>;

interface TestAnalystSettlementHooks {
  bull?: TestSettlementHook<AnalystCase>;
  bear?: TestSettlementHook<AnalystCase>;
}

interface TestAnalystPassHooks {
  beforePass?: (side: "bull" | "bear") => void | Promise<void>;
  beforeProviderLaunch?: (side: "bull" | "bear") => void | Promise<void>;
  onPassStart?: (side: "bull" | "bear") => void;
  onPassFinish?: (side: "bull" | "bear") => void;
}

function testAnalystHooks(raw: unknown[]): {
  lifecycle: TestAnalystPassHooks | undefined;
  settlements: TestAnalystSettlementHooks | undefined;
} {
  return {
    lifecycle: raw[1] as TestAnalystPassHooks | undefined,
    settlements: raw[2] as TestAnalystSettlementHooks | undefined,
  };
}

async function launchTestAnalystSide(
  hooks: TestAnalystPassHooks | undefined,
  side: "bull" | "bear",
): Promise<void> {
  await hooks?.beforePass?.(side);
  hooks?.onPassStart?.(side);
  await hooks?.beforeProviderLaunch?.(side);
}

/**
 * A request admission that never resolves is the failure under test: a
 * `capacity` refusal is transient, so the runner's reserve loop retries
 * forever. Fail with the reason rather than the harness timeout.
 */
async function admittedWithin<T>(pending: Promise<T>, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(reason)), 2_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function testTelemetry<T>(pass: PassResultLike<T>, billable = true): TestTelemetry {
  return {
    model: pass.model,
    inputTokens: pass.usage?.input_tokens ?? 0,
    outputTokens: pass.usage?.output_tokens ?? 0,
    cacheReadTokens: pass.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: pass.usage?.cache_creation_input_tokens ?? 0,
    webSearches: pass.webSearches ?? 0,
    costUsd: pass.costUsd,
    fallbackUsed: pass.fallbackUsed,
    billable,
    fetchedUrls: [...(pass.fetchedUrls ?? [])],
  };
}

function testSuccessSettlement<T>(pass: PassResultLike<T>, billable = true): TestSettlement<T> {
  return { outcome: "success", data: pass.data, telemetry: testTelemetry(pass, billable) };
}

function testFailureSettlement<T>(pass: PassResultLike<T>, message: string): TestSettlement<T> {
  return {
    outcome: "failure",
    failure: { name: "ProviderError", message, kind: "provider" },
    telemetry: testTelemetry(pass),
  };
}

function testAnalystPass(side: "bull" | "bear", costUsd = side === "bull" ? 0.9 : 0.47): PassResultLike<AnalystCase> {
  return {
    data: fakeAnalystCase(),
    model: "claude-opus-4-8",
    costUsd,
    fallbackUsed: false,
    usage: {
      input_tokens: side === "bull" ? 15_000 : 14_000,
      output_tokens: side === "bull" ? 6_000 : 5_500,
      cache_creation_input_tokens: side === "bull" ? 75_000 : 0,
      cache_read_input_tokens: side === "bear" ? 300_000 : 0,
    },
    webSearches: side === "bull" ? 7 : 6,
    fetchedUrls: [`https://example.com/${side}`],
  };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function seedResumableLegacyJob(
  jobId: string,
  status: "done" | "error" = "error",
  fingerprint = "1.3.0:seeded",
): void {
  handle.db
    .update(jobs)
    .set({
      status,
      error: "synthesize failed",
      stepsJson: JSON.stringify([
        { step: "bull", status: "done" },
        { step: "bear", status: "done" },
        { step: "synthesize", status: "error" },
      ] satisfies StepProgress[]),
      bullJson: JSON.stringify(testAnalystPass("bull")),
      bearJson: JSON.stringify(testAnalystPass("bear")),
      payloadFingerprint: fingerprint,
    })
    .where(eq(jobs.id, jobId))
    .run();
}

function clearPreparedResumeProcessCache(): void {
  delete (globalThis as typeof globalThis & {
    __thesisPreparedJobResumes?: unknown;
  }).__thesisPreparedJobResumes;
}

/* ------------------------------------------------------------------------ *
 * Unsupported instrument terminal gate
 * ------------------------------------------------------------------------ */

describe("runJob — unsupported instruments", () => {
  it("adds nullable unsupported columns to a legacy jobs table without changing existing rows", () => {
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec(`
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY NOT NULL,
          symbol TEXT NOT NULL,
          status TEXT NOT NULL,
          stepsJson TEXT NOT NULL,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL,
          error TEXT,
          reportId INTEGER,
          bullJson TEXT,
          bearJson TEXT,
          payloadFingerprint TEXT
        );
        INSERT INTO jobs (id, symbol, status, stepsJson, createdAt, updatedAt)
        VALUES ('legacy', 'AAPL', 'done', '[]', '2026-01-01', '2026-01-01');
      `);

      bootstrapSchema(sqlite);

      const columns = sqlite.pragma("table_info(jobs)") as { name: string }[];
      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["unsupportedKind", "unsupportedMessage"]),
      );
      expect(
        sqlite.prepare("SELECT unsupportedKind, unsupportedMessage FROM jobs WHERE id = ?").get("legacy"),
      ).toEqual({ unsupportedKind: null, unsupportedMessage: null });
    } finally {
      sqlite.close();
    }
  });

  it.each([
    ["live ledger", [0.4, 0.2], 0.6],
    ["zero-row legacy fallback", [], 0.4],
  ])("returns already-linked data-only report truth from the %s", async (_label, costs, expectedCost) => {
    const { jobId } = createJob("AAPL");
    const report = fakeReport(fakeJudgeOutput());
    report.appendix.missingData.push({
      field: "analysis.llm",
      reason: "data-only fixture",
      severity: "critical",
      attemptedSources: [],
    });
    const linked = handle.db.insert(reports).values({
      symbol: "AAPL",
      createdAt: NOW().toISOString(),
      model: "legacy-model",
      status: "done",
      reportJson: JSON.stringify(report),
      verificationRate: null,
      costUsd: 0.4,
      specVersion: "1.0.0",
    }).returning({ id: reports.id }).get();
    for (const [index, costUsd] of costs.entries()) {
      handle.db.insert(costLog).values({
        jobId,
        runGeneration: 0,
        attemptId: `linked-cost-${index}`,
        step: index === 0 ? "bull" : "bear",
        model: "legacy-model",
        costUsd,
        createdAt: new Date(NOW().getTime() + index).toISOString(),
      }).run();
    }
    handle.db.update(jobs).set({
      status: "done",
      reportId: linked.id,
      revision: 5,
    }).where(eq(jobs.id, jobId)).run();
    const events: JobEvent[] = [];
    const unsubscribe = subscribeJob(jobId, (event) => events.push(event));

    const result = await runJob(jobId, mockPasses().passes);
    unsubscribe();

    expect(result).toMatchObject({
      status: "done",
      reportId: linked.id,
      totalCostUsd: expectedCost,
      dataOnly: true,
    });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      revision: 5,
      totalCostUsd: expectedCost,
      dataOnly: true,
    });
  });

  it("does not return or publish success for a dangling terminal report link", async () => {
    const { jobId } = createJob("AAPL");
    handle.sqlite.pragma("foreign_keys = OFF");
    handle.sqlite.prepare(`UPDATE jobs SET status = 'done', reportId = 999999, revision = 2 WHERE id = ?`)
      .run(jobId);
    handle.sqlite.pragma("foreign_keys = ON");
    const events: JobEvent[] = [];
    const unsubscribe = subscribeJob(jobId, (event) => events.push(event));
    try {
      await expect(runJob(jobId, mockPasses().passes)).rejects.toThrow(/already|blocked|report/i);
    } finally {
      unsubscribe();
    }
    expect(events.filter((event) => event.type === "done")).toEqual([]);
  });

  it("rolls cancellation back at the maximum safe revision", () => {
    const { jobId } = createJob("AAPL");
    handle.db.update(jobs).set({ revision: Number.MAX_SAFE_INTEGER })
      .where(eq(jobs.id, jobId)).run();

    expect(() => cancelJob(jobId)).toThrow(/safe|overflow|revision/i);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
      status: "queued",
      revision: Number.MAX_SAFE_INTEGER,
      error: null,
    });
  });

  it("publishes canonical cost and data-only truth when a queued failure recovers a linked report", () => {
    const { jobId } = createJob("AAPL");
    const report = fakeReport(fakeJudgeOutput());
    report.appendix.missingData.push({
      field: "analysis.llm",
      reason: "data-only fixture",
      severity: "critical",
      attemptedSources: [],
    });
    const linked = handle.db.insert(reports).values({
      symbol: "AAPL",
      createdAt: NOW().toISOString(),
      model: "legacy-model",
      status: "done",
      reportJson: JSON.stringify(report),
      verificationRate: null,
      costUsd: 0.4,
      specVersion: "1.0.0",
    }).returning({ id: reports.id }).get();
    handle.db.insert(costLog).values({
      jobId,
      runGeneration: 0,
      attemptId: "queued-linked-late-cost",
      step: "bull",
      model: "legacy-model",
      costUsd: 0.65,
      createdAt: NOW().toISOString(),
    }).run();
    handle.db.update(jobs).set({ reportId: linked.id }).where(eq(jobs.id, jobId)).run();
    const row = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    const events: JobEvent[] = [];
    const unsubscribe = subscribeJob(jobId, (event) => events.push(event));

    expect(recordQueuedResumeDispatchFailure(
      jobId,
      row.runGeneration,
      row.revision,
      new Error("dispatch failed"),
    )).toBe(true);
    unsubscribe();

    expect(events.at(-1)).toMatchObject({
      type: "done",
      reportId: linked.id,
      totalCostUsd: 0.65,
      dataOnly: true,
    });
    const recovered = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    expect(recovered.status).toBe("done");
    const recoveredSteps = JSON.parse(recovered.stepsJson) as StepProgress[];
    expect(recoveredSteps).toHaveLength(7);
    expect(recoveredSteps.every((step) => step.status === "skipped")).toBe(true);
    expect(recoveredSteps.every((step) =>
      step.detail === "covered by linked persisted report recovered after queued dispatch failure"
    )).toBe(true);
  });

  it("terminalizes a queued dispatch failure with normalized steps in one revision", () => {
    const { jobId } = createJob("AAPL");
    const before = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;

    expect(recordQueuedResumeDispatchFailure(
      jobId,
      before.runGeneration,
      before.revision,
      new Error("adapter exploded"),
    )).toBe(true);

    const terminal = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    expect(terminal).toMatchObject({
      status: "error",
      error: "runJob: queued retry dispatch failed before execution",
      revision: before.revision + 1,
    });
    const steps = JSON.parse(terminal.stepsJson) as StepProgress[];
    expect(steps).toHaveLength(7);
    expect(steps.some((step) => step.status === "pending" || step.status === "running"))
      .toBe(false);
    expect(steps.every((step) => step.status === "skipped")).toBe(true);
    expect(steps.every((step) => step.detail === terminal.error)).toBe(true);
  });

  it("terminalizes an unsupported ETF before paid work with zero durable leases, artifacts, costs, reports, or provider/model/pass calls", async () => {
    const { jobId } = createJob("SPY");
    const { passes: basePasses, calls } = mockPasses();
    const preflightPass = vi.fn();
    const passes: PipelinePasses = { ...basePasses, preflightPass };
    const events: JobEvent[] = [];
    const unsubscribe = subscribeJob(jobId, (event) => events.push(event));

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle("SPY", { isEtf: true, isFund: false }),
      hasAnthropicKey: true,
      now: NOW,
    });
    unsubscribe();

    expect(result).toMatchObject({
      status: "unsupported",
      reportId: null,
      verificationRate: null,
      totalCostUsd: 0,
      dataOnly: false,
      kind: "etf",
    });
    expect(result).toHaveProperty("message", expect.stringMatching(/not supported/i));
    expect(calls).toEqual([]);
    expect(preflightPass).not.toHaveBeenCalled();
    expect(resolveModelMock).not.toHaveBeenCalled();
    expect(providerBoundaryMocks.runPass).not.toHaveBeenCalled();
    expect(providerBoundaryMocks.runPassStreaming).not.toHaveBeenCalled();
    expect(providerBoundaryMocks.webSearchTool).not.toHaveBeenCalled();
    expect(handle.db.select().from(jobLlmLeases).all()).toHaveLength(0);
    expect(handle.db.select().from(jobPassArtifacts).all()).toHaveLength(0);
    expect(handle.db.select().from(reports).all()).toHaveLength(0);
    expect(handle.db.select().from(costLog).all()).toHaveLength(0);

    const row = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(row).toMatchObject({
      status: "unsupported",
      reportId: null,
      error: null,
      unsupportedKind: "etf",
    });
    expect(row?.unsupportedMessage).toMatch(/not supported/i);

    const steps = JSON.parse(row?.stepsJson ?? "[]") as StepProgress[];
    expect(steps.map(({ step, status }) => ({ step, status }))).toEqual([
      { step: "fetch", status: "done" },
      { step: "validate", status: "done" },
      { step: "compute", status: "skipped" },
      { step: "bull", status: "skipped" },
      { step: "bear", status: "skipped" },
      { step: "synthesize", status: "skipped" },
      { step: "verify", status: "skipped" },
    ]);
    for (const step of steps.slice(2)) {
      expect(step.detail).toBe(row?.unsupportedMessage);
    }

    expect(events.at(-1)).toEqual({
      type: "unsupported",
      jobId,
      revision: expect.any(Number),
      kind: "etf",
      message: row?.unsupportedMessage,
      totalCostUsd: 0,
    });
    expect(getJobSnapshot(jobId)).toMatchObject({
      status: "unsupported",
      reportId: null,
      totalCostUsd: 0,
      unsupported: { kind: "etf", message: row?.unsupportedMessage },
    });
  });

  it("keeps unsupported terminal across cancel, stale sweep, and active-job dedup checks", () => {
    const { jobId } = createJob("SPY");
    handle.db
      .update(jobs)
      .set({
        status: "unsupported",
        unsupportedKind: "etf",
        unsupportedMessage: "ETF analysis is not supported; companies only.",
        updatedAt: "2020-01-01T00:00:00.000Z",
      })
      .where(eq(jobs.id, jobId))
      .run();

    expect(cancelJob(jobId)).toBe(false);
    expect(sweepAbandonedJobs(new Date("2026-08-07T00:00:00.000Z"), 1)).toBe(0);
    expect(getReusableActiveJobForSymbol("SPY")).toBeNull();
    expect(getOrCreateJobForSymbol("SPY")).toMatchObject({ existing: false });
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
      status: "unsupported",
      unsupportedKind: "etf",
    });
  });

  it("rejects runtime unsupported resume claims without mutating terminal metadata", () => {
    const { jobId } = createJob("SPY");
    handle.db
      .update(jobs)
      .set({
        status: "unsupported",
        error: null,
        reportId: null,
        unsupportedKind: "etf",
        unsupportedMessage: "ETF analysis is not supported; companies only.",
        updatedAt: "2026-08-07T00:00:00.000Z",
      })
      .where(eq(jobs.id, jobId))
      .run();
    const before = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();

    expect(claimJobForResume(jobId, "unsupported" as never)).toBe(false);

    const after = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(after).toMatchObject({
      status: "unsupported",
      error: null,
      reportId: null,
      unsupportedKind: "etf",
      unsupportedMessage: "ETF analysis is not supported; companies only.",
    });
  });

  it("clears stale unsupported metadata when a queued job terminalizes as canceled error", () => {
    const { jobId } = createJob("AAPL");
    handle.db
      .update(jobs)
      .set({ unsupportedKind: "fund", unsupportedMessage: "stale" })
      .where(eq(jobs.id, jobId))
      .run();

    expect(cancelJob(jobId)).toBe(true);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
      status: "error",
      unsupportedKind: null,
      unsupportedMessage: null,
    });
  });

  it("clears stale unsupported metadata when a supported company finishes done", async () => {
    const { jobId } = createJob("AAPL");
    handle.db
      .update(jobs)
      .set({ unsupportedKind: "fund", unsupportedMessage: "stale" })
      .where(eq(jobs.id, jobId))
      .run();

    const result = await runJob(jobId, mockPasses().passes, {
      bundle: fakeBundle("AAPL", { isEtf: false, isFund: false }),
      hasAnthropicKey: false,
      now: NOW,
    });

    expect(result.status).toBe("done");
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
      status: "done",
      unsupportedKind: null,
      unsupportedMessage: null,
    });
  });

  it("clears stale unsupported metadata on failRun and resume claim transitions", async () => {
    const failed = createJob("FAIL").jobId;
    handle.db
      .update(jobs)
      .set({ unsupportedKind: "fund", unsupportedMessage: "stale" })
      .where(eq(jobs.id, failed))
      .run();
    const failingOptions = { hasAnthropicKey: true };
    Object.defineProperty(failingOptions, "bundle", {
      get() {
        throw new Error("fixture fetch failed");
      },
    });

    expect((await runJob(failed, mockPasses().passes, failingOptions)).status).toBe("error");
    expect(handle.db.select().from(jobs).where(eq(jobs.id, failed)).get()).toMatchObject({
      status: "error",
      unsupportedKind: null,
      unsupportedMessage: null,
    });

    seedResumableLegacyJob(failed, "error");
    handle.db
      .update(jobs)
      .set({ unsupportedKind: "etf", unsupportedMessage: "stale" })
      .where(eq(jobs.id, failed))
      .run();
    expect(claimJobForResume(failed, "error")).toBe(true);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, failed)).get()).toMatchObject({
      status: "queued",
      unsupportedKind: null,
      unsupportedMessage: null,
    });
  });

  it("never lets an updatedAt read turn a queued or unsupported row terminal", () => {
    const { jobId } = createJob("SPY");
    const staleUpdatedAt = "2020-01-01T00:00:00.000Z";
    handle.db.update(jobs).set({ updatedAt: staleUpdatedAt }).where(eq(jobs.id, jobId)).run();
    expect(getReusableActiveJobForSymbol("SPY", new Date("2026-08-07T00:00:00.000Z"), 1))
      .toMatchObject({ jobId, status: "queued", updatedAt: staleUpdatedAt });
    handle.db.update(jobs).set({
      status: "unsupported",
      unsupportedKind: "etf",
      unsupportedMessage: "concurrent terminal transition",
    }).where(eq(jobs.id, jobId)).run();
    expect(getReusableActiveJobForSymbol("SPY", new Date("2026-08-07T00:00:00.000Z"), 1)).toBeNull();
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
      status: "unsupported",
      unsupportedKind: "etf",
      unsupportedMessage: "concurrent terminal transition",
    });
  });

  it("uses the durable lease rather than updatedAt when reusing a running row", () => {
    const { jobId } = createJob("MSFT");
    const staleUpdatedAt = "2020-01-01T00:00:00.000Z";
    const leaseExpiresAt = "2026-08-07T00:10:00.000Z";
    handle.db.update(jobs).set({
      status: "running",
      updatedAt: staleUpdatedAt,
      leaseOwner: "worker:nonce",
      heartbeatAt: "2026-08-07T00:00:00.000Z",
      leaseExpiresAt,
    }).where(eq(jobs.id, jobId)).run();

    expect(
      getReusableActiveJobForSymbol("MSFT", new Date("2026-08-07T00:00:01.000Z"), 60_000),
    ).toEqual({ jobId, status: "running", updatedAt: staleUpdatedAt });
    expect(getReusableActiveJobForSymbol("MSFT", new Date(leaseExpiresAt), 60_000)).toBeNull();
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.status).toBe("running");
  });
});

/* ------------------------------------------------------------------------ *
 * Task 20 - paid-pass durable settlement boundaries
 * ------------------------------------------------------------------------ */

describe("runJob - durable paid-pass settlements", () => {
  it("does not bump the identical initial progress snapshot after a durable claim", async () => {
    const { jobId } = createJob("AAPL");
    const claim = claimNextQueuedJob(
      "initial-progress-noop",
      undefined,
      configuredSchedulerLimits(),
      handle.db,
    )!;
    const claimedRevision = claim.revision;
    const events: JobEvent[] = [];
    const unsubscribe = subscribeJob(jobId, (event) => events.push(event));
    try {
      await runJob(jobId, mockPasses().passes, {
        bundle: fakeBundle(),
        hasAnthropicKey: false,
        now: NOW,
        claim,
      });
    } finally {
      unsubscribe();
    }

    const firstVisibleProgress = events.find((event) => event.type === "step-update");
    expect(firstVisibleProgress).toMatchObject({
      revision: claimedRevision + 1,
      step: { step: "fetch", status: "running" },
    });
  });

  it("uses a supplied durable claim without invoking a second queued claimant", async () => {
    const { jobId } = createJob("AAPL");
    const scheduler = await import("@/pipeline/jobScheduler");
    const limits = {
      maxActiveJobs: 1,
      maxActiveLlmCalls: 2,
      maxRollingCostUsd: null,
      rollingCostWindowMs: 60 * 60 * 1000,
      paidPassLeaseTtlMs: 900_000,
      jobLeaseTtlMs: 900_000,
    };
    const claim = scheduler.claimQueuedJobById(
      jobId,
      "preclaimed-test",
      new Date(),
      limits,
    );
    expect(claim).toMatchObject({ jobId, runGeneration: 0, revision: 1 });
    const duplicateClaim = vi.spyOn(scheduler, "claimQueuedJobById");

    const result = await runJob(jobId, mockPasses().passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
      claim: claim!,
      schedulerLimits: limits,
    });

    expect(result.status).toBe("done");
    expect(duplicateClaim).not.toHaveBeenCalled();
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.runGeneration).toBe(0);
  });

  it("rejects an expired supplied claim before any pass adapter can launch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T12:00:00.000Z"));
    const { jobId } = createJob("AAPL");
    const scheduler = await import("@/pipeline/jobScheduler");
    const limits = {
      maxActiveJobs: 1,
      maxActiveLlmCalls: 1,
      maxRollingCostUsd: null,
      rollingCostWindowMs: 60_000,
      paidPassLeaseTtlMs: 200,
      jobLeaseTtlMs: 100,
    };
    const claim = scheduler.claimQueuedJobById(jobId, "expired-preclaim", new Date(), limits)!;
    const base = mockPasses();
    await vi.advanceTimersByTimeAsync(101);

    await expect(runJob(jobId, base.passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
      claim,
      schedulerLimits: limits,
    })).rejects.toThrow(/expired|authority|live preclaim/i);
    expect(base.calls).not.toContain("runBullThenBear");
    expect(handle.db.select().from(jobPassArtifacts).all()).toEqual([]);
    expect(handle.db.select().from(costLog).all()).toEqual([]);
  });

  it("clears the overall timer and external abort listener when initial persistence loses authority", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW());
    const { jobId } = createJob("AAPL");
    const claim = claimNextQueuedJob(
      "initial-persist-cleanup",
      undefined,
      configuredSchedulerLimits(),
      handle.db,
    );
    if (claim === null) throw new Error("fixture job was not claimed");
    const base = mockPasses();
    const initialTimerCount = vi.getTimerCount();
    const addEventListener = vi.fn(() => {
      handle.db.update(jobs)
        .set({ leaseOwner: "different-owner:nonce" })
        .where(eq(jobs.id, jobId))
        .run();
    });
    const removeEventListener = vi.fn();
    const signal = {
      aborted: false,
      reason: undefined,
      addEventListener,
      removeEventListener,
    } as unknown as AbortSignal;

    await expect(runJob(jobId, base.passes, {
      bundle: fakeBundle(),
      claim,
      hasAnthropicKey: true,
      now: NOW,
      signal,
    })).rejects.toThrow(/superseded/i);

    expect(addEventListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(initialTimerCount);
    expect(base.calls).toEqual([]);
  });

  it("rejects provider-cap preflight before acquiring a paid lease or launching an adapter", async () => {
    const { jobId } = createJob("AAPL");
    const scheduler = await import("@/pipeline/jobScheduler");
    const limits = {
      maxActiveJobs: 1,
      maxActiveLlmCalls: 2,
      maxRollingCostUsd: null,
      rollingCostWindowMs: 60_000,
      paidPassLeaseTtlMs: 900_000,
      jobLeaseTtlMs: 900_000,
    };
    const claim = scheduler.claimQueuedJobById(jobId, "preflight-cap", new Date(), limits)!;
    const base = mockPasses();
    const providerLaunch = vi.fn(base.passes.runBullThenBear);
    const passes: PipelinePasses = {
      ...base.passes,
      preflightPass: (_deps, request) => {
        if (request.pass === "bull") throw new Error("request exceeds finite provider cap");
      },
      runBullThenBear: providerLaunch,
    };

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
      claim,
      schedulerLimits: limits,
    });

    expect(result).toMatchObject({ status: "done", dataOnly: true });
    expect(providerLaunch).not.toHaveBeenCalled();
    expect(handle.db.select().from(jobLlmLeases).all()).toEqual([]);
    expect(handle.db.select().from(jobPassArtifacts).all()).toEqual([]);
    expect(handle.db.select().from(costLog).all()).toEqual([]);
  });

  it("fails closed before paid work when an injected adapter cannot prove awaited launch authority", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const providerLaunch = vi.fn(base.passes.runBullThenBear);
    const unsafe = { ...base.passes, runBullThenBear: providerLaunch };
    delete (unsafe as PipelinePasses & { launchAuthorityCapability?: unknown })
      .launchAuthorityCapability;

    const result = await runJob(jobId, unsafe, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    });

    expect(result).toMatchObject({ status: "done", dataOnly: true });
    expect(providerLaunch).not.toHaveBeenCalled();
    expect(handle.db.select().from(jobLlmLeases).all()).toEqual([]);
    expect(handle.db.select().from(jobPassArtifacts).all()).toEqual([]);
    expect(handle.db.select().from(costLog).all()).toEqual([]);
  });

  it.each(["bull", "bear"] as const)(
    "fences a canceled %s after permit acquisition but before the provider boundary",
    async (targetSide) => {
      const { jobId } = createJob("AAPL");
      const base = mockPasses();
      let targetProviderCalls = 0;
      const passes: PipelinePasses = {
        ...base.passes,
        runBullThenBear: async (...raw: unknown[]) => {
          const { lifecycle, settlements } = testAnalystHooks(raw);
          if (targetSide === "bear") {
            await launchTestAnalystSide(lifecycle, "bull");
            await settlements?.bull?.(testSuccessSettlement(testAnalystPass("bull")));
            lifecycle?.onPassFinish?.("bull");
          }
          await lifecycle?.beforePass?.(targetSide);
          expect(handle.db.select().from(jobLlmLeases).all()).toEqual([
            expect.objectContaining({ jobId, pass: targetSide }),
          ]);
          expect(cancelJob(jobId)).toBe(true);
          try {
            lifecycle?.onPassStart?.(targetSide);
          } catch {
            // Production Stage C intentionally isolates timing telemetry.
          }
          await lifecycle?.beforeProviderLaunch?.(targetSide);
          targetProviderCalls += 1;
          throw new Error(`${targetSide} provider must not launch after cancel`);
        },
      };

      expect(await runJob(jobId, passes, {
        bundle: fakeBundle(),
        hasAnthropicKey: true,
        now: NOW,
      })).toMatchObject({ status: "error", reportId: null });
      expect(targetProviderCalls).toBe(0);
      expect(handle.db.select().from(jobLlmLeases).all()).toEqual([]);
      expect(
        handle.db.select().from(jobPassArtifacts).all().filter((row) => row.pass === targetSide),
      ).toEqual([]);
      expect(handle.db.select().from(costLog).all().filter((row) => row.step === targetSide))
        .toEqual([]);
    },
  );

  it("does not launch or mutate after the exact job lease expires between permit and boundary", async () => {
    const { jobId } = createJob("AAPL");
    const scheduler = await import("@/pipeline/jobScheduler");
    const limits = {
      maxActiveJobs: 1,
      maxActiveLlmCalls: 2,
      maxRollingCostUsd: null,
      rollingCostWindowMs: 60_000,
      paidPassLeaseTtlMs: 900_000,
      jobLeaseTtlMs: 900_000,
    };
    const claim = scheduler.claimQueuedJobById(jobId, "expiry-boundary", new Date(), limits)!;
    const base = mockPasses();
    let providerCalls = 0;
    let revisionAtExpiry = -1;
    let stepsAtExpiry = "";
    const passes: PipelinePasses = {
      ...base.passes,
      runBullThenBear: async (...raw: unknown[]) => {
        const { lifecycle } = testAnalystHooks(raw);
        await lifecycle?.beforePass?.("bull");
        const row = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
        revisionAtExpiry = row.revision;
        stepsAtExpiry = row.stepsJson;
        handle.db.update(jobs).set({
          leaseExpiresAt: new Date(Date.now() - 1).toISOString(),
        }).where(eq(jobs.id, jobId)).run();
        lifecycle?.onPassStart?.("bull");
        await lifecycle?.beforeProviderLaunch?.("bull");
        providerCalls += 1;
        throw new Error("provider must not launch through an expired job claim");
      },
    };

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
      claim,
      schedulerLimits: limits,
    });

    expect(result).toMatchObject({ status: "error", reportId: null });
    expect(providerCalls).toBe(0);
    expect(handle.db.select().from(jobPassArtifacts).all()).toEqual([]);
    expect(handle.db.select().from(costLog).all()).toEqual([]);
    expect(handle.db.select().from(jobLlmLeases).all()).toEqual([]);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
      status: "running",
      revision: revisionAtExpiry,
      stepsJson: stepsAtExpiry,
    });
  });

  it("preserves a deferred bull's exact settlement when external cancel fences bear", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const bull = testAnalystPass("bull", 0.41);
    const bullResultGate = deferred<void>();
    const bearPermitAcquired = deferred<void>();
    const continueToBearFence = deferred<void>();
    let bullProviderCalls = 0;
    let bearProviderCalls = 0;
    const passes: PipelinePasses = {
      ...base.passes,
      runBullThenBear: async (...raw: unknown[]) => {
        const { lifecycle, settlements } = testAnalystHooks(raw);
        await launchTestAnalystSide(lifecycle, "bull");
        bullProviderCalls += 1;
        const settledBull = bullResultGate.promise.then(async () => {
          await settlements?.bull?.(testSuccessSettlement(bull));
          lifecycle?.onPassFinish?.("bull");
          return bull;
        });

        await lifecycle?.beforePass?.("bear");
        bearPermitAcquired.resolve();
        await continueToBearFence.promise;
        try {
          lifecycle?.onPassStart?.("bear");
          await lifecycle?.beforeProviderLaunch?.("bear");
          bearProviderCalls += 1;
          throw new Error("bear provider must remain fenced");
        } catch (error) {
          const settled = await settledBull;
          throw new BullBearPassFailure("bear launch lost after bull started", {
            bull: settled,
            bullLaunched: true,
            bearLaunched: false,
            bearError: error instanceof Error ? error.message : String(error),
          });
        }
      },
    };

    const running = runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    });
    await bearPermitAcquired.promise;
    expect(handle.db.select().from(jobLlmLeases).all()).toEqual([
      expect.objectContaining({ jobId, pass: "bull" }),
      expect.objectContaining({ jobId, pass: "bear" }),
    ]);

    // Simulate another process's cancellation: mutate durable authority but do
    // not signal this process's controller.
    const current = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    handle.db.update(jobs).set({
      status: "error",
      error: JOB_CANCELED_ERROR,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      revision: current.revision + 1,
      updatedAt: NOW().toISOString(),
    }).where(eq(jobs.id, jobId)).run();
    continueToBearFence.resolve();
    await Promise.resolve();
    expect(bearProviderCalls).toBe(0);
    expect(handle.db.select().from(jobPassArtifacts).all()).toEqual([]);

    bullResultGate.resolve();
    await expect(running).resolves.toMatchObject({ status: "error", reportId: null });
    expect(bullProviderCalls).toBe(1);
    expect(bearProviderCalls).toBe(0);
    expect(handle.db.select().from(jobPassArtifacts).all()).toEqual([
      expect.objectContaining({ jobId, pass: "bull", attemptId: expect.any(String) }),
    ]);
    expect(handle.db.select().from(costLog).all()).toEqual([
      expect.objectContaining({ jobId, step: "bull", costUsd: 0.41 }),
    ]);
    expect(handle.db.select().from(jobLlmLeases).all()).toEqual([]);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
      status: "error",
      bullJson: null,
      bearJson: null,
      leaseOwner: null,
    });
  });

  it.each(["synthesize", "verify"] as const)(
    "fences a canceled %s attempt at the adapter's immediate launch boundary",
    async (targetPass) => {
      const { jobId } = createJob("AAPL");
      const base = mockPasses();
      let targetProviderCalls = 0;
      const passes: PipelinePasses = {
        ...base.passes,
        ...(targetPass === "synthesize"
          ? {
              runJudgePass: async (...raw: unknown[]) => {
                const beforeProviderLaunch = raw[5] as (() => void | Promise<void>) | undefined;
                expect(cancelJob(jobId)).toBe(true);
                await beforeProviderLaunch?.();
                targetProviderCalls += 1;
                throw new Error("judge provider must not launch after cancel");
              },
            }
          : {
              runVerifyPass: async (...raw: unknown[]) => {
                const beforeProviderLaunch = raw[4] as (() => void | Promise<void>) | undefined;
                expect(cancelJob(jobId)).toBe(true);
                await beforeProviderLaunch?.();
                targetProviderCalls += 1;
                throw new Error("verify provider must not launch after cancel");
              },
            }),
      };

      expect(await runJob(jobId, passes, {
        bundle: fakeBundle(),
        hasAnthropicKey: true,
        now: NOW,
      })).toMatchObject({ status: "error", reportId: null });
      expect(targetProviderCalls).toBe(0);
      expect(handle.db.select().from(jobLlmLeases).all()).toEqual([]);
      expect(
        handle.db.select().from(jobPassArtifacts).all().filter((row) => row.pass === targetPass),
      ).toEqual([]);
      expect(handle.db.select().from(costLog).all().filter((row) => row.step === targetPass))
        .toEqual([]);
    },
  );

  it("fences a canceled single-side resume immediately before its provider boundary", async () => {
    const { jobId } = createJob("AAPL");
    const fingerprint = "1.3.0:single-side-launch";
    seedResumableLegacyJob(jobId, "error", fingerprint);
    handle.db.update(jobs).set({
      bearJson: null,
      stepsJson: JSON.stringify([
        { step: "bull", status: "done" },
        { step: "bear", status: "error" },
        { step: "synthesize", status: "skipped" },
      ] satisfies StepProgress[]),
    }).where(eq(jobs.id, jobId)).run();
    expect(claimJobForResume(jobId, "error")).toBe(true);
    const base = mockPasses();
    let targetProviderCalls = 0;
    const passes: PipelinePasses = {
      ...base.passes,
      fingerprintPayload: () => fingerprint,
      runAnalystPass: async (...raw: unknown[]) => {
        const beforeProviderLaunch = raw[3] as (() => void | Promise<void>) | undefined;
        expect(cancelJob(jobId)).toBe(true);
        await beforeProviderLaunch?.();
        targetProviderCalls += 1;
        throw new Error("single-side provider must not launch after cancel");
      },
    };

    expect(await runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
      resume: true,
    })).toMatchObject({ status: "error", reportId: null });
    expect(targetProviderCalls).toBe(0);
    expect(handle.db.select().from(jobLlmLeases).all()).toEqual([]);
    expect(handle.db.select().from(jobPassArtifacts).all().filter((row) => row.pass === "bear"))
      .toEqual([]);
    expect(handle.db.select().from(costLog).all().filter((row) => row.step === "bear"))
      .toEqual([]);
  });

  it.each(["bull", "bear"] as const)(
    "releases a single-side %s permit when the adapter exits before its launch callback",
    async (side) => {
      const { jobId } = createJob("AAPL");
      const fingerprint = `1.3.0:prelaunch-single-${side}`;
      seedResumableLegacyJob(jobId, "error", fingerprint);
      handle.db.update(jobs).set({
        ...(side === "bull" ? { bullJson: null } : { bearJson: null }),
      }).where(eq(jobs.id, jobId)).run();
      expect(claimJobForResume(jobId, "error")).toBe(true);
      const base = mockPasses();
      const providerBoundary = vi.fn();
      const result = await runJob(jobId, {
        ...base.passes,
        fingerprintPayload: () => fingerprint,
        runAnalystPass: async () => {
          // The adapter exits after the runner's paid gate but before invoking
          // beforeProviderLaunch, so this is not a provider attempt.
          throw new Error(`${side} adapter rejected before provider launch`);
        },
      }, { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW, resume: true });

      expect(result).toMatchObject({ status: "done", dataOnly: true });
      expect(providerBoundary).not.toHaveBeenCalled();
      expect(handle.db.select().from(jobLlmLeases).all()).toEqual([]);
      expect(handle.db.select().from(jobPassArtifacts).all().filter((row) => row.pass === side))
        .toEqual([]);
      expect(handle.db.select().from(costLog).all().filter((row) => row.step === side))
        .toEqual([]);
      const report = handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get()!;
      const parsed = ReportSchema.parse(JSON.parse(report.reportJson!));
      expect(parsed.appendix.missingData).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: `llm.${side}`, attemptedSources: [] }),
      ]));
    },
  );

  it.each(["synthesize", "verify"] as const)(
    "releases a %s permit when the adapter exits before its launch callback",
    async (targetPass) => {
      const { jobId } = createJob("AAPL");
      const base = mockPasses();
      const providerBoundary = vi.fn();
      const passes: PipelinePasses = {
        ...base.passes,
        ...(targetPass === "synthesize"
          ? {
              runJudgePass: async () => {
                throw new Error("judge adapter rejected before provider launch");
              },
            }
          : {
              runVerifyPass: async () => {
                throw new Error("verify adapter rejected before provider launch");
              },
            }),
      };
      const result = await runJob(jobId, passes, {
        bundle: fakeBundle(),
        hasAnthropicKey: true,
        now: NOW,
        maxJudgeRetries: 0,
      });

      expect(result.status).toBe("done");
      expect(providerBoundary).not.toHaveBeenCalled();
      expect(handle.db.select().from(jobLlmLeases).all()).toEqual([]);
      expect(
        handle.db.select().from(jobPassArtifacts).all().filter((row) => row.pass === targetPass),
      ).toEqual([]);
      expect(handle.db.select().from(costLog).all().filter((row) => row.step === targetPass))
        .toEqual([]);
      if (targetPass === "synthesize") {
        const report = handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get()!;
        const parsed = ReportSchema.parse(JSON.parse(report.reportJson!));
        expect(parsed.appendix.missingData).toEqual(expect.arrayContaining([
          expect.objectContaining({ field: "llm.judge", attemptedSources: [] }),
        ]));
      }
    },
  );

  it("preserves concrete billed telemetry even when an adapter omits its launch callback", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const billedAttempt = {
      model: "claude-opus-4-8",
      costUsd: 0.123456,
      fallbackUsed: false,
      usage: { input_tokens: 100, output_tokens: 50 },
      webSearches: 0,
    };
    const result = await runJob(jobId, {
      ...base.passes,
      runJudgePass: async () => {
        throw Object.assign(new Error("provider returned billing before adapter failed"), {
          billedAttempt,
        });
      },
    }, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
      maxJudgeRetries: 0,
    });

    expect(result).toMatchObject({ status: "done", dataOnly: true });
    expect(handle.db.select().from(jobLlmLeases).all()).toEqual([]);
    expect(handle.db.select().from(jobPassArtifacts).all().filter((row) => row.pass === "synthesize"))
      .toEqual([expect.objectContaining({ pass: "synthesize" })]);
    expect(handle.db.select().from(costLog).all().filter((row) => row.step === "synthesize"))
      .toEqual([expect.objectContaining({ costUsd: 0.123456 })]);
  });

  it("holds bear at the independent paid gate until bull settles when global capacity is one", async () => {
    const { jobId } = createJob("AAPL");
    const scheduler = await import("@/pipeline/jobScheduler");
    const limits = {
      maxActiveJobs: 1,
      maxActiveLlmCalls: 1,
      maxRollingCostUsd: null,
      rollingCostWindowMs: 60 * 60 * 1000,
      paidPassLeaseTtlMs: 900_000,
      jobLeaseTtlMs: 900_000,
    };
    const claim = scheduler.claimQueuedJobById(
      jobId,
      "capacity-test",
      new Date(),
      limits,
    )!;
    const base = mockPasses();
    const bull = testAnalystPass("bull");
    const bear = testAnalystPass("bear");
    const bullAcquired = deferred();
    const releaseBull = deferred();
    const bearAcquired = deferred();
    const releaseBear = deferred();
    let bearStarted = false;
    const passes: PipelinePasses = {
      ...base.passes,
      runBullThenBear: async (...raw: unknown[]) => {
        const { lifecycle, settlements } = testAnalystHooks(raw);
        if (!settlements?.bull || !settlements.bear) {
          throw new Error("missing analyst settlement hooks");
        }
        await launchTestAnalystSide(lifecycle, "bull");
        bullAcquired.resolve(undefined);
        const bearLaunch = (async () => {
          await launchTestAnalystSide(lifecycle, "bear");
          bearStarted = true;
          bearAcquired.resolve(undefined);
          await releaseBear.promise;
          await settlements.bear!(testSuccessSettlement(bear));
          lifecycle?.onPassFinish?.("bear");
        })();
        await releaseBull.promise;
        await settlements.bull(testSuccessSettlement(bull));
        lifecycle?.onPassFinish?.("bull");
        await bearLaunch;
        return { bull, bear };
      },
    };

    const running = runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
      claim,
      schedulerLimits: limits,
    });
    await bullAcquired.promise;
    expect(handle.db.select().from(jobLlmLeases).all()).toEqual([
      expect.objectContaining({ pass: "bull" }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(bearStarted).toBe(false);

    releaseBull.resolve(undefined);
    await bearAcquired.promise;
    expect(handle.db.select().from(jobLlmLeases).all()).toEqual([
      expect.objectContaining({ pass: "bear" }),
    ]);
    releaseBear.resolve(undefined);
    expect((await running).status).toBe("done");
    expect(handle.db.select().from(jobLlmLeases).all()).toEqual([]);
  });

  it("waits for a conservative live reservation to settle before declaring the job budget exhausted", async () => {
    const { jobId } = createJob("AAPL");
    handle.db.update(jobs).set({ maxCostUsd: 150 }).where(eq(jobs.id, jobId)).run();
    const limits = {
      maxActiveJobs: 1,
      maxActiveLlmCalls: 2,
      maxRollingCostUsd: null,
      rollingCostWindowMs: 60 * 60 * 1000,
      paidPassLeaseTtlMs: 900_000,
      jobLeaseTtlMs: 900_000,
    };
    const claim = claimNextQueuedJob("budget-wait", undefined, limits, handle.db)!;
    const base = mockPasses();
    const bull = testAnalystPass("bull", 0.9);
    const bear = testAnalystPass("bear", 0.47);
    const bullAcquired = deferred();
    const releaseBull = deferred();
    const bearAcquired = deferred();
    const releaseBear = deferred();
    let bearStarted = false;
    const passes: PipelinePasses = {
      ...base.passes,
      runBullThenBear: async (...raw: unknown[]) => {
        const { lifecycle, settlements } = testAnalystHooks(raw);
        if (!settlements?.bull || !settlements.bear) {
          throw new Error("missing analyst settlement hooks");
        }
        await launchTestAnalystSide(lifecycle, "bull");
        bullAcquired.resolve(undefined);
        const bearLaunch = (async () => {
          await launchTestAnalystSide(lifecycle, "bear");
          bearStarted = true;
          bearAcquired.resolve(undefined);
          await releaseBear.promise;
          await settlements.bear!(testSuccessSettlement(bear));
        })();
        await releaseBull.promise;
        await settlements.bull(testSuccessSettlement(bull));
        await bearLaunch;
        return { bull, bear };
      },
    };

    const running = runJob(jobId, passes, {
      bundle: fakeBundle(),
      claim,
      hasAnthropicKey: true,
      now: NOW,
      schedulerLimits: limits,
    });
    await bullAcquired.promise;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(bearStarted).toBe(false);

    releaseBull.resolve(undefined);
    await bearAcquired.promise;
    expect(handle.db.select().from(jobLlmLeases).all()).toEqual([
      expect.objectContaining({ pass: "bear", reservedCostUsd: 100 }),
    ]);
    releaseBear.resolve(undefined);
    expect((await running).status).toBe("done");
    expect(handle.db.select().from(jobLlmLeases).all()).toEqual([]);
  });

  it("renews a long paid attempt before lease expiry and settles through the same owner", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T00:00:00.000Z"));
    const { jobId } = createJob("AAPL");
    const scheduler = await import("@/pipeline/jobScheduler");
    const limits = {
      maxActiveJobs: 1,
      maxActiveLlmCalls: 1,
      maxRollingCostUsd: null,
      rollingCostWindowMs: 60 * 60 * 1000,
      paidPassLeaseTtlMs: 200,
      jobLeaseTtlMs: 1_000,
    };
    const claim = scheduler.claimQueuedJobById(jobId, "renew-test", new Date(), limits)!;
    const base = mockPasses();
    const acquired = deferred();
    const release = deferred();
    const passes: PipelinePasses = {
      ...base.passes,
      runBullThenBear: async (...raw: unknown[]) => {
        const { lifecycle, settlements } = testAnalystHooks(raw);
        await launchTestAnalystSide(lifecycle, "bull");
        acquired.resolve(undefined);
        await release.promise;
        await settlements?.bull?.(testSuccessSettlement(testAnalystPass("bull")));
        lifecycle?.onPassFinish?.("bull");
        throw new BullBearPassFailure("bear was not launched", {
          bullLaunched: true,
          bearLaunched: false,
          bearError: "not launched",
        });
      },
    };
    const running = runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
      claim,
      schedulerLimits: limits,
    });
    await acquired.promise;
    const originalExpiry = handle.db.select().from(jobLlmLeases).get()!.leaseExpiresAt;

    await vi.advanceTimersByTimeAsync(150);
    expect(handle.db.select().from(jobLlmLeases).get()!.leaseExpiresAt > originalExpiry).toBe(true);
    release.resolve(undefined);
    expect((await running).status).toBe("done");
    expect(handle.db.select().from(jobLlmLeases).all()).toEqual([]);
  });

  it("aborts the runner when a paid-attempt renewal loses its exact owner", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T00:00:00.000Z"));
    const { jobId } = createJob("AAPL");
    const scheduler = await import("@/pipeline/jobScheduler");
    const limits = {
      maxActiveJobs: 1,
      maxActiveLlmCalls: 1,
      maxRollingCostUsd: null,
      rollingCostWindowMs: 60 * 60 * 1000,
      paidPassLeaseTtlMs: 200,
      jobLeaseTtlMs: 1_000,
    };
    const claim = scheduler.claimQueuedJobById(jobId, "lost-renewal-test", new Date(), limits)!;
    const base = mockPasses();
    const acquired = deferred();
    const passes: PipelinePasses = {
      ...base.passes,
      runBullThenBear: async (deps, lifecycle) => {
        await launchTestAnalystSide(lifecycle, "bull");
        acquired.resolve(undefined);
        await new Promise<never>((_resolve, reject) => {
          deps.signal?.addEventListener(
            "abort",
            () => reject(deps.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        });
        throw new Error("unreachable after lease loss");
      },
    };
    const running = runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
      claim,
      schedulerLimits: limits,
    });
    await acquired.promise;
    handle.db.update(jobLlmLeases).set({ leaseOwner: "stolen:owner" }).run();

    await vi.advanceTimersByTimeAsync(50);
    expect(await running).toMatchObject({ status: "error", reportId: null });
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
      status: "error",
      error: expect.stringMatching(/renewal lost authority/i),
      leaseOwner: null,
    });
    expect(handle.db.select().from(reports).all()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains an in-flight reservation but clears its local renewal timer after external abort", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T00:00:00.000Z"));
    const { jobId } = createJob("AAPL");
    const scheduler = await import("@/pipeline/jobScheduler");
    const limits = {
      maxActiveJobs: 1,
      maxActiveLlmCalls: 1,
      maxRollingCostUsd: null,
      rollingCostWindowMs: 60 * 60 * 1000,
      paidPassLeaseTtlMs: 200,
      jobLeaseTtlMs: 1_000,
    };
    const claim = scheduler.claimQueuedJobById(jobId, "external-abort-test", new Date(), limits)!;
    const base = mockPasses();
    const acquired = deferred();
    const passes: PipelinePasses = {
      ...base.passes,
      runBullThenBear: async (deps, lifecycle) => {
        await launchTestAnalystSide(lifecycle, "bull");
        acquired.resolve(undefined);
        await new Promise<never>((_resolve, reject) => {
          deps.signal?.addEventListener(
            "abort",
            () => reject(deps.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        });
        throw new Error("unreachable after external abort");
      },
    };
    const external = new AbortController();
    const running = runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
      claim,
      schedulerLimits: limits,
      signal: external.signal,
    });
    await acquired.promise;

    external.abort(new Error("test external abort"));
    expect(await running).toMatchObject({ status: "error", reportId: null });
    expect(handle.db.select().from(jobLlmLeases).all()).toEqual([
      expect.objectContaining({ jobId, pass: "bull" }),
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  /**
   * A pass lease and its OWN first request lease must never occupy a paid slot
   * at the same time (DECISIONS D-10). The pass lease reserves one request
   * maximum only to cover a pass that settles without ever reaching the
   * provider; it is released the moment the first request asks for admission.
   */
  it("admits a pass's own first request with THESIS_MAX_ACTIVE_LLM_CALLS=1", async () => {
    const { jobId } = createJob("AAPL");
    const scheduler = await import("@/pipeline/jobScheduler");
    const limits = {
      maxActiveJobs: 1,
      maxActiveLlmCalls: 1,
      maxRollingCostUsd: null,
      rollingCostWindowMs: 60 * 60 * 1000,
      paidPassLeaseTtlMs: 900_000,
      jobLeaseTtlMs: 900_000,
    };
    const claim = scheduler.claimQueuedJobById(jobId, "single-slot-admission", new Date(), limits)!;
    const base = mockPasses();
    let liveDuringRequest: Array<{ pass: string; attemptId: string; reservedCostUsd: number }> = [];
    const passes: PipelinePasses = {
      ...base.passes,
      runBullThenBear: async (deps, lifecycle, settlements) => {
        await launchTestAnalystSide(lifecycle, "bull");
        const admission = deps.admissionFor?.("bull");
        expect(admission, "request admission must be threaded in request mode").toBeDefined();
        // Refused, this never resolves: `capacity` is transient, so the
        // runner's reserve loop would retry forever and no request is sent.
        const permit = await admittedWithin(
          admission!.reserve({ attempt: 1, kind: "stream", maximumUsd: 0.5 }),
          "the pass's own first request was never admitted",
        );
        liveDuringRequest = handle.db
          .select()
          .from(jobLlmLeases)
          .all()
          .filter((row) => row.reservedCostUsd > 0)
          .map((row) => ({
            pass: row.pass,
            attemptId: row.attemptId,
            reservedCostUsd: row.reservedCostUsd,
          }));
        await admission!.release(permit);
        await settlements?.bull?.(testSuccessSettlement(testAnalystPass("bull")));
        lifecycle?.onPassFinish?.("bull");
        await launchTestAnalystSide(lifecycle, "bear");
        await settlements?.bear?.(testSuccessSettlement(testAnalystPass("bear")));
        lifecycle?.onPassFinish?.("bear");
        return { bull: testAnalystPass("bull"), bear: testAnalystPass("bear") };
      },
    };

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
      claim,
      schedulerLimits: limits,
    });

    expect(result.status).toBe("done");
    // Only the request holds money while it is in flight — never the request
    // plus the pass lease that exists to hand off to it.
    expect(liveDuringRequest).toEqual([
      expect.objectContaining({ pass: "bull", attemptId: expect.stringContaining("#r1") }),
    ]);
  });

  it("lets bull and bear hold request leases at the same time at the default of 2", async () => {
    const { jobId } = createJob("AAPL");
    const scheduler = await import("@/pipeline/jobScheduler");
    const limits = {
      maxActiveJobs: 1,
      maxActiveLlmCalls: 2,
      maxRollingCostUsd: null,
      rollingCostWindowMs: 60 * 60 * 1000,
      paidPassLeaseTtlMs: 900_000,
      jobLeaseTtlMs: 900_000,
    };
    const claim = scheduler.claimQueuedJobById(jobId, "two-slot-admission", new Date(), limits)!;
    const base = mockPasses();
    let concurrentRequests: string[] = [];
    const passes: PipelinePasses = {
      ...base.passes,
      runBullThenBear: async (deps, lifecycle, settlements) => {
        // The real ordering: bear launches while bull is still streaming, so
        // bear reads the prompt cache bull just wrote.
        await launchTestAnalystSide(lifecycle, "bull");
        const bullAdmission = deps.admissionFor?.("bull") as RequestAdmission;
        const bullPermit = await admittedWithin(
          bullAdmission.reserve({ attempt: 1, kind: "stream", maximumUsd: 0.5 }),
          "bull's first request was never admitted",
        );
        await launchTestAnalystSide(lifecycle, "bear");
        const bearAdmission = deps.admissionFor?.("bear") as RequestAdmission;
        const bearPermit = await admittedWithin(
          bearAdmission.reserve({ attempt: 1, kind: "stream", maximumUsd: 0.5 }),
          "bear's first request was refused while bull was still streaming",
        );
        concurrentRequests = handle.db
          .select()
          .from(jobLlmLeases)
          .all()
          .filter((row) => row.reservedCostUsd > 0)
          .map((row) => row.pass)
          .sort();
        await bullAdmission.release(bullPermit);
        await bearAdmission.release(bearPermit);
        await settlements?.bull?.(testSuccessSettlement(testAnalystPass("bull")));
        lifecycle?.onPassFinish?.("bull");
        await settlements?.bear?.(testSuccessSettlement(testAnalystPass("bear")));
        lifecycle?.onPassFinish?.("bear");
        return { bull: testAnalystPass("bull"), bear: testAnalystPass("bear") };
      },
    };

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
      claim,
      schedulerLimits: limits,
    });

    expect(result.status).toBe("done");
    expect(concurrentRequests).toEqual(["bear", "bull"]);
  });

  /**
   * D-07's disclosure clause: presumed spend is part of the total the report
   * shows, so the report has to say which part of it is a bound.
   */
  it("discloses presumed spend in the manifest and in cost metadata", async () => {
    const { jobId } = createJob("AAPL");
    // A previous generation-0 attempt whose owner died: its whole reservation
    // is counted until something reconciles it downward.
    handle.db.insert(costLog).values({
      jobId,
      runGeneration: 0,
      attemptId: null,
      presumedAttemptId: "dead-attempt",
      settlementKind: "presumed",
      step: "bull",
      model: "claude-sonnet-5",
      costUsd: 3.86,
      createdAt: NOW().toISOString(),
    }).run();

    const result = await runJob(jobId, mockPasses().passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    });

    expect(result.status).toBe("done");
    const row = handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get()!;
    const parsed = ReportSchema.parse(JSON.parse(row.reportJson!));
    expect(parsed.meta.presumedCostUsd).toBe(3.86);
    expect(parsed.appendix.missingData).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "cost.presumed",
        severity: "warn",
        reason: expect.stringContaining("presumed upper bound"),
      }),
    ]));
  });

  it("omits the presumed-spend disclosure when nothing in the run was presumed", async () => {
    const { jobId } = createJob("MSFT");

    const result = await runJob(jobId, mockPasses().passes, {
      bundle: fakeBundle("MSFT"),
      hasAnthropicKey: true,
      now: NOW,
    });

    const row = handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get()!;
    const parsed = ReportSchema.parse(JSON.parse(row.reportJson!));
    expect(parsed.meta.presumedCostUsd).toBeUndefined();
    expect(parsed.appendix.missingData.some((gap) => gap.field === "cost.presumed")).toBe(false);
  });

  it("still records a late measured settlement after a request lease renewal lost authority", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T00:00:00.000Z"));
    const { jobId } = createJob("AAPL");
    const scheduler = await import("@/pipeline/jobScheduler");
    const limits = {
      maxActiveJobs: 1,
      maxActiveLlmCalls: 2,
      maxRollingCostUsd: null,
      rollingCostWindowMs: 60 * 60 * 1000,
      paidPassLeaseTtlMs: 200,
      jobLeaseTtlMs: 10_000,
    };
    const claim = scheduler.claimQueuedJobById(jobId, "late-measurement", new Date(), limits)!;
    const base = mockPasses();
    const stolen = deferred();
    const passes: PipelinePasses = {
      ...base.passes,
      runBullThenBear: async (deps, lifecycle) => {
        await launchTestAnalystSide(lifecycle, "bull");
        const admission = deps.admissionFor?.("bull") as RequestAdmission;
        const permit = await admittedWithin(
          admission.reserve({ attempt: 1, kind: "stream", maximumUsd: 12 }),
          "bull's first request was never admitted",
        );
        // Renewal loses authority for the REQUEST lease only: exactly the
        // state in which the reservation has already expired into a presumed
        // row at its full maximum.
        handle.db
          .update(jobLlmLeases)
          .set({ leaseOwner: "stolen:owner" })
          .where(eq(jobLlmLeases.permitId, permit.id))
          .run();
        stolen.resolve(undefined);
        await new Promise<void>((resolve) => {
          deps.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        // The provider still returned real usage for this request.
        await admission.settle(permit, {
          model: "claude-sonnet-5",
          usage: {
            input_tokens: 20_000,
            output_tokens: 800,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          webSearches: 0,
          costUsd: 0.12,
          fallbackUsed: false,
        });
        throw new Error("bull aborted after its request lease lost authority");
      },
    };

    const running = runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
      claim,
      schedulerLimits: limits,
    });
    await stolen.promise;
    await vi.advanceTimersByTimeAsync(120);

    expect(await running).toMatchObject({ status: "error", reportId: null });
    // The measurement is the record, not the presumed maximum.
    expect(handle.db.select().from(costLog).all()).toEqual([
      expect.objectContaining({ costUsd: 0.12, settlementKind: "actual", step: "bull" }),
    ]);
  });

  it("analyst finish lifecycle stays local until the durable settlement commits", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const started = deferred();
    const allowFinish = deferred();
    const finished = deferred();
    const releaseResult = deferred();
    const events: JobEvent[] = [];
    const unsubscribe = subscribeJob(jobId, (event) => events.push(event));
    const passes: PipelinePasses = {
      ...base.passes,
      runBullThenBear: async (deps, hooks) => {
        await launchTestAnalystSide(hooks, "bull");
        started.resolve(undefined);
        await allowFinish.promise;
        hooks?.onPassFinish?.("bull");
        finished.resolve(undefined);
        await releaseResult.promise;
        return base.passes.runBullThenBear(deps, hooks);
      },
    };
    const running = runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    });

    try {
      await started.promise;
      events.length = 0;
      allowFinish.resolve(undefined);
      await finished.promise;
      const row = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
      const bull = (JSON.parse(row.stepsJson) as StepProgress[])
        .find((step) => step.step === "bull");
      expect(bull).toMatchObject({ status: "running" });
      expect(bull?.finishedAt).toBeUndefined();
      expect(bull?.completedAt).toBeUndefined();
      expect(events).toEqual([]);
    } finally {
      cancelJob(jobId);
      releaseResult.resolve(undefined);
      await running.catch(() => undefined);
      unsubscribe();
    }
  });

  it("superseded worker cannot write lifecycle heartbeat failure terminal state or events", async () => {
    vi.useFakeTimers();
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const entered = deferred();
    let rejectAnalysts!: (error: Error) => void;
    let finishOldBull: (() => void) | undefined;
    const oldAnalysts = new Promise<never>((_resolve, reject) => {
      rejectAnalysts = reject;
    });
    const passes: PipelinePasses = {
      ...base.passes,
      runBullThenBear: async (_deps, hooks) => {
        await launchTestAnalystSide(hooks, "bull");
        finishOldBull = () => hooks?.onPassFinish?.("bull");
        entered.resolve(undefined);
        return oldAnalysts;
      },
    };
    const running = runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
      deadlineMs: 90 * 60 * 1000,
    });
    await entered.promise;

    const sentinelSteps = initialSteps().map((step) => ({
      ...step,
      detail: "new generation owns this row",
    }));
    const sentinelUpdatedAt = "2026-08-08T08:00:00.000Z";
    handle.db
      .update(jobs)
      .set({
        status: "queued",
        runGeneration: 1,
        revision: 44,
        stepsJson: JSON.stringify(sentinelSteps),
        error: "new generation sentinel",
        reportId: null,
        updatedAt: sentinelUpdatedAt,
      })
      .where(eq(jobs.id, jobId))
      .run();
    const events: JobEvent[] = [];
    const unsubscribe = subscribeJob(jobId, (event) => events.push(event));
    try {
      await vi.advanceTimersByTimeAsync(JOB_HEARTBEAT_MS);
      finishOldBull?.();
      rejectAnalysts(new Error("old generation analyst failure"));
      const result = await running;
      expect(result).toMatchObject({ status: "error", reportId: null });

      expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
        status: "queued",
        runGeneration: 1,
        revision: 44,
        stepsJson: JSON.stringify(sentinelSteps),
        error: "new generation sentinel",
        reportId: null,
        updatedAt: sentinelUpdatedAt,
      });
      expect(handle.db.select().from(reports).all()).toEqual([]);
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
      rejectAnalysts(new Error("test cleanup"));
      await running.catch(() => undefined);
    }
  });

  it("does not persist a placeholder artifact for an analyst side never launched", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const passes: PipelinePasses = {
      ...base.passes,
      runBullThenBear: async (...raw: unknown[]) => {
        const { lifecycle: hooks, settlements } = testAnalystHooks(raw);
        const bull = settlements?.bull;
        await launchTestAnalystSide(hooks, "bull");
        if (!bull) throw new Error("missing bull settlement hook");
        await bull({
          outcome: "failure",
          failure: { name: "Error", message: "bull failed before cache warm" },
          telemetry: testTelemetry(testAnalystPass("bull", 0), false),
        });
        hooks?.onPassFinish?.("bull");
        const failure = new BullBearPassFailure("bull failed; bear not launched", {
          bullError: "bull failed before cache warm",
          bearError: "bear not launched",
          bullLaunched: true,
          bearLaunched: false,
        });
        throw failure;
      },
    };

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    });

    expect(result.dataOnly).toBe(true);
    const terminal = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    const steps = JSON.parse(terminal.stepsJson) as StepProgress[];
    expect(terminal.status).toBe("done");
    expect(steps.find((step) => step.step === "bull")?.status).toBe("error");
    expect(steps.find((step) => step.step === "bear")).toMatchObject({
      status: "skipped",
      detail: "provider pass was not launched",
    });
    expect(
      handle.db
        .select()
        .from(jobPassArtifacts)
        .where(eq(jobPassArtifacts.jobId, jobId))
        .all()
        .map((artifact) => artifact.pass),
    ).toEqual(["bull"]);
  });

  it("plain failure before analyst provider dispatch creates no pass settlement", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const providerBoundary = vi.fn(base.passes.runBullThenBear);
    const failBeforeDispatch = (): Promise<void> =>
      Promise.reject(new Error("adapter preflight failed before provider dispatch"));
    const passes: PipelinePasses = {
      ...base.passes,
      runBullThenBear: async (...args) => {
        await failBeforeDispatch();
        return providerBoundary(...args);
      },
    };

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    });

    expect(result).toMatchObject({ status: "done", dataOnly: true });
    expect(providerBoundary).not.toHaveBeenCalled();
    expect(
      handle.db.select().from(jobPassArtifacts).where(eq(jobPassArtifacts.jobId, jobId)).all(),
    ).toEqual([]);
    expect(handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all()).toEqual([]);
    const terminal = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    const steps = JSON.parse(terminal.stepsJson) as StepProgress[];
    expect(terminal.status).toBe("done");
    expect(steps.find((step) => step.step === "bull")).toMatchObject({
      status: "skipped",
      detail: "provider pass was not launched",
    });
    expect(steps.find((step) => step.step === "bear")).toMatchObject({
      status: "skipped",
      detail: "provider pass was not launched",
    });
    expect(steps.some((step) => step.status === "running")).toBe(false);
    const reportRow = handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get()!;
    const report = ReportSchema.parse(JSON.parse(reportRow.reportJson ?? "{}"));
    const analysisGaps = report.appendix.missingData.filter(
      (gap) => gap.field === "analysis.llm" || gap.field === "llm.bull" || gap.field === "llm.bear",
    );
    expect(analysisGaps.map((gap) => gap.field).sort()).toEqual([
      "analysis.llm",
      "llm.bear",
      "llm.bull",
    ]);
    expect(analysisGaps.map((gap) => gap.reason).join(" ")).toContain(
      "adapter preflight failed before provider dispatch",
    );
    expect(analysisGaps.flatMap((gap) => gap.attemptedSources ?? [])).toEqual([]);
  });

  it("releases a permit acquired by the adapter when it exits before provider launch", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const passes: PipelinePasses = {
      ...base.passes,
      runBullThenBear: async (_deps, hooks) => {
        await hooks?.beforePass?.("bull");
        throw new Error("adapter stopped after gate but before provider dispatch");
      },
    };

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    });

    expect(result).toMatchObject({ status: "done", dataOnly: true });
    expect(handle.db.select().from(jobLlmLeases).all()).toEqual([]);
    expect(handle.db.select().from(jobPassArtifacts).all()).toEqual([]);
    expect(handle.db.select().from(costLog).all()).toEqual([]);
  });

  it("fails a multi-pass run before provider launch when only one revision slot remains", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const providerBoundary = vi.fn();
    const passes: PipelinePasses = {
      ...base.passes,
      runBullThenBear: async (_deps, hooks) => {
        handle.db.update(jobs).set({ revision: Number.MAX_SAFE_INTEGER - 1 })
          .where(eq(jobs.id, jobId)).run();
        await hooks?.beforePass?.("bull");
        providerBoundary();
        throw new Error("unreachable provider boundary");
      },
    };

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    });

    expect(result).toMatchObject({ status: "error", reportId: null, totalCostUsd: 0 });
    expect(providerBoundary).not.toHaveBeenCalled();
    expect(handle.db.select().from(jobLlmLeases).all()).toEqual([]);
    expect(handle.db.select().from(jobPassArtifacts).all()).toEqual([]);
    expect(handle.db.select().from(costLog).all()).toEqual([]);
    const terminal = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    expect(terminal).toMatchObject({
      status: "error",
      revision: Number.MAX_SAFE_INTEGER,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(JSON.parse(terminal.stepsJson) as StepProgress[])
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ status: "running" })]));
  });

  it("reserves retry bookkeeping headroom before a near-MAX synth boundary", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const originalAnalysts = base.passes.runBullThenBear.bind(base.passes);
    const synthProvider = vi.fn(async (...raw: unknown[]) => {
      const settlement = raw[4] as TestSettlementHook<JudgeOutput> | undefined;
      const authorize = raw[5] as (() => void | Promise<void>) | undefined;
      await authorize?.();
      const failed: PassResultLike<JudgeOutput> = {
        data: fakeJudgeOutput(),
        model: "claude-opus-4-8",
        costUsd: 0.12,
        fallbackUsed: false,
      };
      await settlement?.(testFailureSettlement(failed, "schema-invalid synth output"));
      throw new Error("schema-invalid synth output");
    });
    const passes: PipelinePasses = {
      ...base.passes,
      runBullThenBear: async (...args) => {
        const analysts = await originalAnalysts(...args);
        // Simulate a job that reaches the retryable judge boundary near the
        // finite revision ceiling after already committing analyst costs.
        handle.db.update(jobs).set({ revision: Number.MAX_SAFE_INTEGER - 4 })
          .where(eq(jobs.id, jobId)).run();
        return analysts;
      },
      runJudgePass: synthProvider,
    };

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    });

    expect(result).toMatchObject({
      status: "error",
      totalCostUsd: 1.37,
      reportId: null,
    });
    expect(synthProvider).not.toHaveBeenCalled();
    expect(handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all()
      .map((row) => row.step).sort()).toEqual(["bear", "bull"]);
    expect(handle.db.select().from(jobPassArtifacts).where(eq(jobPassArtifacts.jobId, jobId)).all()
      .map((row) => row.pass).sort()).toEqual(["bear", "bull"]);
    expect(handle.db.select().from(jobLlmLeases).all()).toEqual([]);
    const terminal = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    expect(terminal).toMatchObject({
      status: "error",
      revision: Number.MAX_SAFE_INTEGER - 2,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    const steps = JSON.parse(terminal.stepsJson) as StepProgress[];
    expect(steps.some((step) => step.status === "pending" || step.status === "running"))
      .toBe(false);
  });

  it("persists bull artifact and cost before unresolved bear settles", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const bull = testAnalystPass("bull");
    const bear = testAnalystPass("bear");
    const entered = deferred();
    const bullCallbackReturned = deferred();
    const releaseBear = deferred();

    const passes: PipelinePasses = {
      ...base.passes,
      fingerprintPayload: () => "1.3.0:aaaabbbb",
      runBullThenBear: async (...raw: unknown[]) => {
        const { lifecycle, settlements } = testAnalystHooks(raw);
        await launchTestAnalystSide(lifecycle, "bull");
        entered.resolve(undefined);
        if (settlements?.bull) {
          await settlements.bull(testSuccessSettlement(bull));
        }
        bullCallbackReturned.resolve(undefined);
        await releaseBear.promise;
        return { bull, bear };
      },
    };

    const running = runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    });

    try {
      await entered.promise;
      await bullCallbackReturned.promise;

      const artifacts = handle.db
        .select()
        .from(jobPassArtifacts)
        .where(eq(jobPassArtifacts.jobId, jobId))
        .all();
      const costs = handle.db
        .select()
        .from(costLog)
        .where(eq(costLog.jobId, jobId))
        .all();
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]).toMatchObject({ pass: "bull", runGeneration: 0 });
      expect(costs).toHaveLength(1);
      expect(costs[0]).toMatchObject({ step: "bull", runGeneration: 0 });
      expect(costs[0]?.attemptId).toBe(artifacts[0]?.attemptId);

      const row = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
      const steps = JSON.parse(row.stepsJson) as StepProgress[];
      expect(steps.find((step) => step.step === "bull")?.status).toBe("done");
      expect(steps.find((step) => step.step === "bear")?.status).not.toBe("done");
    } finally {
      cancelJob(jobId);
      releaseBear.resolve(undefined);
      await running.catch(() => undefined);
    }
  });

  it("late settlement after cancellation only invalidates a newer queued generation", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const entered = deferred();
    let lateBull: TestSettlementHook<AnalystCase> | undefined;
    const passes: PipelinePasses = {
      ...base.passes,
      fingerprintPayload: () => "1.3.0:old00000",
      runBullThenBear: async (...raw: unknown[]) => {
        const { lifecycle, settlements } = testAnalystHooks(raw);
        await launchTestAnalystSide(lifecycle, "bull");
        lateBull = settlements?.bull;
        entered.resolve(undefined);
        return new Promise<never>(() => {});
      },
    };

    const running = runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
      deadlineMs: 10_000,
    });
    await entered.promise;
    expect(cancelJob(jobId)).toBe(true);
    expect((await running).status).toBe("error");
    expect(typeof lateBull).toBe("function");

    const newerSnapshot = JSON.stringify({
      ...testAnalystPass("bull", 0.12),
      model: "new-generation-model",
    });
    const resumableSteps = [
      { step: "bull", status: "done" },
      { step: "bear", status: "done" },
      { step: "synthesize", status: "error" },
    ] as StepProgress[];
    handle.db
      .update(jobs)
      .set({
        status: "error",
        error: "retryable synthesis failure",
        stepsJson: JSON.stringify(resumableSteps),
        bullJson: newerSnapshot,
        bearJson: newerSnapshot,
        payloadFingerprint: "1.3.0:new00000",
        revision: 9,
      })
      .where(eq(jobs.id, jobId))
      .run();

    expect(claimJobForResume(jobId, "error")).toBe(true);
    const claimed = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    expect(claimed.runGeneration).toBe(1);
    const immutableNewerState = {
      stepsJson: claimed.stepsJson,
      revision: claimed.revision,
      bullJson: claimed.bullJson,
      bearJson: claimed.bearJson,
      payloadFingerprint: claimed.payloadFingerprint,
    };
    const events: JobEvent[] = [];
    const unsubscribe = subscribeJob(jobId, (event) => events.push(event));
    try {
      await lateBull!(testSuccessSettlement(testAnalystPass("bull")));
    } finally {
      unsubscribe();
    }

    const after = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    expect({
      stepsJson: after.stepsJson,
      bullJson: after.bullJson,
      bearJson: after.bearJson,
      payloadFingerprint: after.payloadFingerprint,
    }).toEqual({
      stepsJson: immutableNewerState.stepsJson,
      bullJson: immutableNewerState.bullJson,
      bearJson: immutableNewerState.bearJson,
      payloadFingerprint: immutableNewerState.payloadFingerprint,
    });
    expect(after.revision).toBe(immutableNewerState.revision + 1);
    expect(events).toEqual([]);
    expect(
      handle.db.select().from(jobPassArtifacts).where(eq(jobPassArtifacts.jobId, jobId)).all(),
    ).toEqual([expect.objectContaining({ pass: "bull", runGeneration: 0 })]);
    expect(
      handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all(),
    ).toEqual([expect.objectContaining({ step: "bull", runGeneration: 0 })]);
  });

  it("superseded worker rolls back its report insert when the generation changes before link", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const verifySettled = deferred();
    const releaseVerify = deferred();
    const passes: PipelinePasses = {
      ...base.passes,
      runVerifyPass: async (deps, judge, evidence, settlement) => {
        const verified = await base.passes.runVerifyPass(deps, judge, evidence);
        if (!settlement) throw new Error("missing verify settlement hook");
        await settlement({
          outcome: "success",
          data: verified.verifiedReport,
          telemetry: {
            model: "deterministic",
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
        });
        verifySettled.resolve(undefined);
        await releaseVerify.promise;
        return verified;
      },
    };
    const running = runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    });
    await verifySettled.promise;

    const before = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    const sentinelSteps = initialSteps().map((step) => ({
      ...step,
      detail: "new generation report sentinel",
    }));
    handle.db
      .update(jobs)
      .set({
        status: "queued",
        runGeneration: 1,
        revision: before.revision + 1,
        stepsJson: JSON.stringify(sentinelSteps),
        error: "new generation remains unlinked",
        reportId: null,
      })
      .where(eq(jobs.id, jobId))
      .run();
    const immutable = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    const events: JobEvent[] = [];
    const unsubscribe = subscribeJob(jobId, (event) => events.push(event));
    try {
      releaseVerify.resolve(undefined);
      expect(await running).toMatchObject({ status: "error", reportId: null });
    } finally {
      unsubscribe();
      releaseVerify.resolve(undefined);
      await running.catch(() => undefined);
    }

    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toEqual(immutable);
    expect(handle.db.select().from(reports).all()).toEqual([]);
    expect(events).toEqual([]);
  });

  it("rolls back report persistence when its writer-lock wait crosses job-lease expiry", async () => {
    handle.sqlite.close();
    tempDirectory = mkdtempSync(join(tmpdir(), "thesis-runner-report-lock-"));
    const file = join(tempDirectory, "runner.db");
    handle = createDatabase(file);
    setDbForTests(handle.db);
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const limits = {
      ...configuredSchedulerLimits(),
      jobLeaseTtlMs: 400,
      paidPassLeaseTtlMs: 2_000,
    };
    const writers: Worker[] = [];
    const events: JobEvent[] = [];
    const unsubscribe = subscribeJob(jobId, (event) => events.push(event));
    const passes: PipelinePasses = {
      ...base.passes,
      verifyCapability: { billable: false },
      runVerifyPass: async (...args: Parameters<PipelinePasses["runVerifyPass"]>) => {
        const verified = await base.passes.runVerifyPass(...args);
        const settlement = args[3] as TestSettlementHook<Report> | undefined;
        if (settlement === undefined) throw new Error("missing verify settlement hook");
        await settlement({
          outcome: "success",
          data: verified.verifiedReport,
          telemetry: {
            model: "deterministic",
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
        });
        const writer = new Worker(new URL("./fixtures/sqliteWriteLockWorker.mjs", import.meta.url), {
          workerData: { file, holdMs: 750 },
        });
        writers.push(writer);
        await new Promise<void>((resolve, reject) => {
          const sentinel = setTimeout(
            () => reject(new Error("report writer did not acquire its lock")),
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
        return {
          ...verified,
          costUsd: undefined,
          model: undefined,
          usage: undefined,
        };
      },
    };

    try {
      const result = await runJob(jobId, passes, {
        bundle: fakeBundle(),
        hasAnthropicKey: true,
        now: NOW,
        schedulerLimits: limits,
      });

      expect(result).toMatchObject({ status: "error", reportId: null });
      expect(handle.db.select().from(reports).all()).toEqual([]);
      expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
        status: "running",
        reportId: null,
      });
      expect(events.filter((event) => event.type === "done" || event.type === "error"))
        .toEqual([]);
    } finally {
      unsubscribe();
      await Promise.all(writers.map((writer) => writer.terminate()));
    }
  });

  it("commits paid cost and its terminal step in one wire-visible revision", async () => {
    const { jobId } = createJob("AAPL");
    const originalDb = handle.db;
    const committedObservations: Array<{
      revision: number;
      bullStatus: StepProgress["status"] | undefined;
      totalCostUsd: number;
    }> = [];
    const observedDb = new Proxy(originalDb, {
      get(target, property) {
        if (property === "transaction") {
          return (...args: Parameters<ThesisDb["transaction"]>) => {
            const value = target.transaction(...args);
            const row = target.select().from(jobs).where(eq(jobs.id, jobId)).get();
            const totalCostUsd = target.select().from(costLog)
              .where(eq(costLog.jobId, jobId)).all()
              .reduce((total, cost) => total + cost.costUsd, 0);
            if (row !== undefined && totalCostUsd > 0) {
              const bullStatus = (JSON.parse(row.stepsJson) as StepProgress[])
                .find((step) => step.step === "bull")?.status;
              committedObservations.push({ revision: row.revision, bullStatus, totalCostUsd });
            }
            return value;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as ThesisDb;
    setDbForTests(observedDb);
    const base = mockPasses();
    let beforeRevision = -1;
    let afterRevision = -1;
    let committedSteps: StepProgress[] = [];
    let committedCost = -1;
    const passes: PipelinePasses = {
      ...base.passes,
      runBullThenBear: async (...raw: unknown[]) => {
        const { lifecycle, settlements } = testAnalystHooks(raw);
        await launchTestAnalystSide(lifecycle, "bull");
        const before = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
        beforeRevision = before.revision;
        await settlements?.bull?.(testSuccessSettlement(testAnalystPass("bull")));
        const after = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
        afterRevision = after.revision;
        committedSteps = JSON.parse(after.stepsJson) as StepProgress[];
        committedCost = handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all()
          .reduce((total, row) => total + row.costUsd, 0);
        throw new Error("stop after observing the atomic bull settlement");
      },
    };

    try {
      await runJob(jobId, passes, {
        bundle: fakeBundle(),
        hasAnthropicKey: true,
        now: NOW,
      });
    } finally {
      setDbForTests(originalDb);
    }

    expect(afterRevision - beforeRevision).toBe(1);
    expect(committedCost).toBeCloseTo(0.9, 10);
    expect(committedSteps).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: "bull", status: "done", costUsd: 0.9 }),
    ]));
    expect(committedObservations).not.toContainEqual(expect.objectContaining({
      bullStatus: "running",
      totalCostUsd: expect.any(Number),
    }));
  });

  it("rebases live step and terminal report mutations after an external revision-only cost bump", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const bull = testAnalystPass("bull");
    const bear = testAnalystPass("bear");
    const passes: PipelinePasses = {
      ...base.passes,
      runBullThenBear: async (...raw: unknown[]) => {
        const { lifecycle, settlements } = testAnalystHooks(raw);
        await launchTestAnalystSide(lifecycle, "bull");
        await settlements?.bull?.(testSuccessSettlement(bull));
        lifecycle?.onPassFinish?.("bull");

        persistPassSettlement({
          jobId,
          runGeneration: 0,
          attemptId: "external-late-cost",
          pass: "bull",
          settlement: testSuccessSettlement(testAnalystPass("bull", 0.05)),
          payloadFingerprint: "1.3.0:external-late-cost",
          settledAt: new Date().toISOString(),
        });

        await launchTestAnalystSide(lifecycle, "bear");
        await settlements?.bear?.(testSuccessSettlement(bear));
        lifecycle?.onPassFinish?.("bear");
        return { bull, bear };
      },
    };

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    });

    expect(result).toMatchObject({ status: "done", dataOnly: false });
    expect(result.reportId).not.toBeNull();
    const row = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    expect(row).toMatchObject({ status: "done", reportId: result.reportId });
    expect(JSON.parse(row.stepsJson)).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: "bull", status: "done" }),
      expect.objectContaining({ step: "bear", status: "done" }),
      expect.objectContaining({ step: "synthesize", status: "done" }),
      expect.objectContaining({ step: "verify", status: "done" }),
    ]));
    expect(handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ attemptId: "external-late-cost", costUsd: 0.05 }),
        expect.objectContaining({ step: "bear", costUsd: 0.47 }),
      ]));
  });

  it("reconciles report row and JSON from the in-transaction ledger after a final late charge", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const passes: PipelinePasses = {
      ...base.passes,
      runVerifyPass: async (deps, judge, evidence, settlement) => {
        const verified = await base.passes.runVerifyPass(deps, judge, evidence);
        if (!settlement) throw new Error("missing verify settlement hook");
        await settlement(testSuccessSettlement({
          data: verified.verifiedReport,
          model: verified.model ?? "deterministic",
          costUsd: verified.costUsd ?? 0,
          fallbackUsed: verified.fallbackUsed ?? false,
          usage: verified.usage,
        }));
        persistPassSettlement({
          jobId,
          runGeneration: 0,
          attemptId: "late-before-report-link",
          pass: "bull",
          settlement: testSuccessSettlement(testAnalystPass("bull", 0.05)),
          payloadFingerprint: "1.3.0:late-before-report-link",
          settledAt: new Date().toISOString(),
        });
        return verified;
      },
    };

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    });

    expect(result).toMatchObject({ status: "done", totalCostUsd: 2.02 });
    const stored = handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get()!;
    expect(stored.costUsd).toBeCloseTo(2.02, 10);
    const report = ReportSchema.parse(JSON.parse(stored.reportJson!));
    expect(report.meta.costUsd).toBeCloseTo(2.02, 10);
    expect(report.appendix.costBreakdown.reduce((total, row) => total + row.costUsd, 0))
      .toBeCloseTo(2.02, 10);
    expect(report.appendix.costBreakdown).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: "bull", costUsd: 0.05 }),
    ]));
  });

  it("preserves ordered cost metadata while appending a late ledger row without invented fields", async () => {
    const { jobId } = createJob("AAPL");
    persistPassSettlement({
      jobId,
      runGeneration: 0,
      attemptId: "generation-0-bull",
      pass: "bull",
      settlement: testSuccessSettlement({
        ...testAnalystPass("bull", 0.11),
        model: "claude-haiku-3-5",
        fallbackUsed: false,
      }),
      payloadFingerprint: "1.3.0:prior-ledger",
      settledAt: NOW().toISOString(),
    });
    persistPassSettlement({
      jobId,
      runGeneration: 0,
      attemptId: "generation-0-synthesize",
      pass: "synthesize",
      settlement: testSuccessSettlement({
        data: fakeJudgeOutput(),
        model: "claude-sonnet-4-5",
        costUsd: 0.2,
        fallbackUsed: true,
      }),
      payloadFingerprint: "1.3.0:prior-ledger",
      settledAt: NOW().toISOString(),
    });
    const schedulerLimits = configuredSchedulerLimits();
    const sourceClaim = claimNextQueuedJob(
      "ordered-ledger-metadata",
      undefined,
      schedulerLimits,
      handle.db,
    )!;
    const claim = { ...sourceClaim, runGeneration: 1 };
    handle.db.update(jobs).set({ runGeneration: 1 }).where(eq(jobs.id, jobId)).run();

    const base = mockPasses();
    const passes: PipelinePasses = {
      ...base.passes,
      runVerifyPass: async () => {
        throw new Error("deterministic verification unavailable");
      },
      assembleReport: (input) => {
        persistPassSettlement({
          jobId,
          runGeneration: 1,
          attemptId: "generation-1-late-verify",
          pass: "verify",
          settlement: testSuccessSettlement({
            data: fakeReport(input.judgeOutput),
            model: "late-ledger-model",
            costUsd: 0.07,
            fallbackUsed: true,
          }),
          payloadFingerprint: "1.3.0:late-ledger",
          settledAt: NOW().toISOString(),
        });
        return fakeReport(input.judgeOutput);
      },
    };

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle(),
      claim,
      hasAnthropicKey: true,
      now: NOW,
      schedulerLimits,
    });

    expect(result.status).toBe("done");
    const ledger = handle.db.select({
      id: costLog.id,
      step: costLog.step,
      model: costLog.model,
      costUsd: costLog.costUsd,
      fallbackUsed: costLog.fallbackUsed,
    }).from(costLog).where(eq(costLog.jobId, jobId)).orderBy(costLog.id).all();
    expect(ledger.map(({ step, model, costUsd, fallbackUsed }) => ({
      step,
      model,
      costUsd,
      fallbackUsed,
    }))).toEqual([
      { step: "bull", model: "claude-haiku-3-5", costUsd: 0.11, fallbackUsed: false },
      { step: "synthesize", model: "claude-sonnet-4-5", costUsd: 0.2, fallbackUsed: true },
      { step: "bull", model: "claude-opus-4-8", costUsd: 0.9, fallbackUsed: false },
      { step: "bear", model: "claude-opus-4-8", costUsd: 0.47, fallbackUsed: false },
      { step: "synthesize", model: "claude-opus-4-8", costUsd: 0.4, fallbackUsed: false },
      { step: "verify", model: "late-ledger-model", costUsd: 0.07, fallbackUsed: true },
    ]);
    const stored = handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get()!;
    const report = ReportSchema.parse(JSON.parse(stored.reportJson!));
    expect(report.appendix.costBreakdown.map(({ step, model, costUsd, fallbackUsed }) => ({
      step,
      model,
      costUsd,
      fallbackUsed,
    }))).toEqual(ledger.map(({ step, model, costUsd, fallbackUsed }) => ({
      step,
      model,
      costUsd,
      fallbackUsed,
    })));
    for (const row of report.appendix.costBreakdown.slice(0, -1)) {
      expect(row).toEqual(expect.objectContaining({
        requestedModel: expect.any(String),
        requestedEffort: expect.anything(),
        effectiveEffort: expect.anything(),
        adjustments: expect.any(Array),
      }));
    }
    expect(report.appendix.costBreakdown.at(-1)).toEqual({
      step: "verify",
      model: "late-ledger-model",
      costUsd: 0.07,
      fallbackUsed: true,
    });
    expect(stored.costUsd).toBeCloseTo(2.15, 10);
    expect(report.meta.costUsd).toBeCloseTo(2.15, 10);
  });

  it("duplicate settlement callback bills exactly once", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses({ verifyCostUsd: 0 });
    const bull = testAnalystPass("bull");
    const bear = testAnalystPass("bear");
    const passes: PipelinePasses = {
      ...base.passes,
      fingerprintPayload: () => "1.3.0:aaaabbbb",
      runBullThenBear: async (...raw: unknown[]) => {
        const { lifecycle, settlements } = testAnalystHooks(raw);
        await launchTestAnalystSide(lifecycle, "bull");
        if (settlements?.bull) {
          await settlements.bull(testSuccessSettlement(bull));
          await settlements.bull(testSuccessSettlement(bull));
        }
        await launchTestAnalystSide(lifecycle, "bear");
        if (settlements?.bear) await settlements.bear(testSuccessSettlement(bear));
        return { bull, bear };
      },
    };

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    });
    expect(result.status).toBe("done");

    const bullArtifacts = handle.db
      .select()
      .from(jobPassArtifacts)
      .where(eq(jobPassArtifacts.jobId, jobId))
      .all()
      .filter((row) => row.pass === "bull");
    const bullCosts = handle.db
      .select()
      .from(costLog)
      .where(eq(costLog.jobId, jobId))
      .all()
      .filter((row) => row.step === "bull");
    expect(bullArtifacts).toHaveLength(1);
    expect(bullCosts).toHaveLength(1);
    expect(bullCosts[0]?.attemptId).toBe(bullArtifacts[0]?.attemptId);
    expect(bullCosts[0]?.costUsd).toBeCloseTo(0.9, 10);
  });

  it("persists schema-valid judge artifact before verify starts", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses({ verifyCostUsd: 0 });
    const originalJudge = base.passes.runJudgePass.bind(base.passes);
    const originalVerify = base.passes.runVerifyPass.bind(base.passes);
    let judgeArtifactsAtVerify = 0;
    let judgeEnvelope: unknown;
    const passes: PipelinePasses = {
      ...base.passes,
      fingerprintPayload: () => "1.3.0:aaaabbbb",
      runJudgePass: async (...raw: unknown[]) => {
        const result = await originalJudge(
          raw[0] as Parameters<PipelinePasses["runJudgePass"]>[0],
          raw[1] as Parameters<PipelinePasses["runJudgePass"]>[1],
          raw[2] as Parameters<PipelinePasses["runJudgePass"]>[2],
          raw[3] as string | undefined,
        );
        const settlement = raw[4] as TestSettlementHook<JudgeOutput> | undefined;
        if (settlement) await settlement(testSuccessSettlement(result));
        return result;
      },
      runVerifyPass: async (...raw: Parameters<PipelinePasses["runVerifyPass"]>) => {
        const rows = handle.db
          .select()
          .from(jobPassArtifacts)
          .where(eq(jobPassArtifacts.jobId, jobId))
          .all()
          .filter((row) => row.pass === "synthesize");
        judgeArtifactsAtVerify = rows.length;
        judgeEnvelope = rows[0] ? JSON.parse(rows[0].outcomeJson) : null;
        return originalVerify(...raw);
      },
    };

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    });
    expect(result.status).toBe("done");
    expect(judgeArtifactsAtVerify).toBe(1);
    expect(judgeEnvelope).toMatchObject({
      artifactVersion: 1,
      outcome: "success",
      data: expect.objectContaining({ verdict: expect.any(Object) }),
      payloadFingerprint: "1.3.0:aaaabbbb",
    });
  });

  it.each([
    {
      label: "artifact failure rolls back cost",
      trigger: `
        CREATE TRIGGER reject_task20_artifact
        BEFORE INSERT ON job_pass_artifacts
        WHEN NEW.pass = 'bull'
        BEGIN SELECT RAISE(ABORT, 'injected artifact failure'); END;
      `,
      expected: "injected artifact failure",
    },
    {
      label: "cost failure rolls back artifact",
      trigger: `
        CREATE TRIGGER reject_task20_cost
        BEFORE INSERT ON cost_log
        WHEN NEW.step = 'bull' AND NEW.attemptId IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'injected cost failure'); END;
      `,
      expected: "injected cost failure",
    },
  ])("$label and emits no done step/event", async ({ trigger, expected }) => {
    const { jobId } = createJob("AAPL");
    handle.sqlite.exec(trigger);
    const base = mockPasses();
    const events: JobEvent[] = [];
    const unsubscribe = subscribeJob(jobId, (event) => events.push(event));
    const passes: PipelinePasses = {
      ...base.passes,
      fingerprintPayload: () => "1.3.0:aaaabbbb",
      runBullThenBear: async (...raw: unknown[]) => {
        const { lifecycle, settlements } = testAnalystHooks(raw);
        await launchTestAnalystSide(lifecycle, "bull");
        const settlement = settlements?.bull;
        if (!settlement) throw new Error("missing durable bull settlement hook");
        await settlement(testSuccessSettlement(testAnalystPass("bull")));
        throw new Error("unreachable after injected persistence rejection");
      },
    };

    try {
      await expect(
        runJob(jobId, passes, { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW }),
      ).rejects.toThrow(expected);
    } finally {
      unsubscribe();
    }
    expect(
      handle.db.select().from(jobPassArtifacts).where(eq(jobPassArtifacts.jobId, jobId)).all(),
    ).toHaveLength(0);
    expect(
      handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all(),
    ).toHaveLength(0);
    expect(
      events.some(
        (event) =>
          event.type === "step-update" && event.step.step === "bull" && event.step.status === "done",
      ),
    ).toBe(false);
  });

  it.each([
    ["within reservation", 0.9],
    ["over reservation", 101],
  ])("terminalizes safely after %s immutable paid truth commits but corrupt steps block projection", async (_label, costUsd) => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const passes: PipelinePasses = {
      ...base.passes,
      runBullThenBear: async (...raw: unknown[]) => {
        const { lifecycle, settlements } = testAnalystHooks(raw);
        await launchTestAnalystSide(lifecycle, "bull");
        handle.db.update(jobs).set({ stepsJson: "{corrupt-after-launch" })
          .where(eq(jobs.id, jobId)).run();
        if (!settlements?.bull) throw new Error("missing durable bull settlement hook");
        await settlements.bull(testSuccessSettlement(testAnalystPass("bull", costUsd)));
        throw new Error("unreachable after projection failure");
      },
    };

    let surfaced: unknown;
    try {
      await runJob(jobId, passes, {
        bundle: fakeBundle(),
        hasAnthropicKey: true,
        now: NOW,
      });
    } catch (error) {
      surfaced = error;
    }

    expect(handle.db.select().from(jobPassArtifacts).where(eq(jobPassArtifacts.jobId, jobId)).all())
      .toHaveLength(1);
    expect(handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all()).toEqual([
      expect.objectContaining({ step: "bull", costUsd }),
    ]);
    expect(handle.db.select().from(jobLlmLeases).where(eq(jobLlmLeases.jobId, jobId)).all())
      .toEqual([]);
    const terminal = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    expect(terminal).toMatchObject({
      status: "error",
      bullJson: null,
      payloadFingerprint: null,
    });
    expect(JSON.parse(terminal.stepsJson)).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: "bull", status: "error" }),
      expect.objectContaining({ step: "bear", status: "skipped" }),
    ]));
    expect(surfaced).toMatchObject({
      message: expect.stringMatching(/projection failed|step snapshot/i),
    });
  });

  it("aborts a not-yet-launched sibling after analyst settlement persistence rejects", async () => {
    const { jobId } = createJob("AAPL");
    handle.sqlite.exec(`
      CREATE TRIGGER reject_task20_bull_artifact
      BEFORE INSERT ON job_pass_artifacts
      WHEN NEW.pass = 'bull'
      BEGIN SELECT RAISE(ABORT, 'injected bull artifact failure'); END;
    `);
    const base = mockPasses();

    await expect(runJob(jobId, base.passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    })).rejects.toThrow(/injected bull artifact failure/i);

    expect(
      handle.db.select().from(jobPassArtifacts).where(eq(jobPassArtifacts.jobId, jobId)).all(),
    ).toHaveLength(0);
    expect(
      handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all(),
    ).toHaveLength(0);
  });

  it("conflicting duplicate settlement rejects without mutating the first checkpoint", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const bull = testAnalystPass("bull");
    const passes: PipelinePasses = {
      ...base.passes,
      fingerprintPayload: () => "1.3.0:aaaabbbb",
      runBullThenBear: async (...raw: unknown[]) => {
        const { lifecycle, settlements } = testAnalystHooks(raw);
        await launchTestAnalystSide(lifecycle, "bull");
        const settlement = settlements?.bull;
        if (!settlement) throw new Error("missing durable bull settlement hook");
        await settlement(testSuccessSettlement(bull));
        await settlement(testSuccessSettlement({ ...bull, costUsd: 9.99 }));
        throw new Error("unreachable after conflicting duplicate");
      },
    };

    await expect(
      runJob(jobId, passes, { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW }),
    ).rejects.toThrow(/conflict|invariant/i);

    const artifacts = handle.db
      .select()
      .from(jobPassArtifacts)
      .where(eq(jobPassArtifacts.jobId, jobId))
      .all();
    const costs = handle.db
      .select()
      .from(costLog)
      .where(eq(costLog.jobId, jobId))
      .all();
    expect(artifacts).toHaveLength(1);
    expect(costs).toHaveLength(1);
    expect(costs[0]?.costUsd).toBeCloseTo(0.9, 10);
  });

  it("queued resume re-derives a source synthesize artifact after process-cache loss", async () => {
    const { jobId } = createJob("AAPL");
    persistPassSettlement({
      jobId,
      runGeneration: 0,
      attemptId: "source-synthesize-success",
      pass: "synthesize",
      settlement: testSuccessSettlement({
        data: fakeJudgeOutput(),
        model: "claude-opus-4-8",
        costUsd: 0.4,
        fallbackUsed: false,
      }),
      payloadFingerprint: "1.3.0:cross-process",
      settledAt: NOW().toISOString(),
    });
    handle.db
      .update(jobs)
      .set({ status: "error", error: "worker crashed after synthesize", reportId: null })
      .where(eq(jobs.id, jobId))
      .run();

    expect(claimJobForResume(jobId, "error")).toBe(true);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.runGeneration).toBe(1);
    clearPreparedResumeProcessCache();

    const base = mockPasses();
    const analysts = vi.fn(async () => {
      throw new Error("source synthesize reuse must not launch analysts");
    });
    const judge = vi.fn(async () => {
      throw new Error("source synthesize reuse must not launch judge");
    });
    const verify = vi.fn(base.passes.runVerifyPass);
    const result = await runJob(
      jobId,
      {
        ...base.passes,
        fingerprintPayload: () => "1.3.0:cross-process",
        runBullThenBear: analysts,
        runJudgePass: judge,
        runVerifyPass: verify,
      },
      { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW, resume: true },
    );

    expect(result.status).toBe("done");
    expect(analysts).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("reuses durable synthesize and runs deterministic verify after spend caps are exhausted", async () => {
    const { jobId } = createJob("AAPL");
    persistPassSettlement({
      jobId,
      runGeneration: 0,
      attemptId: "source-synthesize-no-key",
      pass: "synthesize",
      settlement: testSuccessSettlement({
        data: fakeJudgeOutput(),
        model: "claude-opus-4-8",
        costUsd: 0.4,
        fallbackUsed: false,
      }),
      payloadFingerprint: "1.3.0:synthesize-no-key",
      settledAt: NOW().toISOString(),
    });
    handle.db
      .update(jobs)
      .set({
        status: "error",
        error: "worker stopped before verify",
        reportId: null,
        maxCostUsd: 0.2,
      })
      .where(eq(jobs.id, jobId))
      .run();
    expect(claimJobForResume(jobId, "error")).toBe(true);
    clearPreparedResumeProcessCache();
    resolveModelMock.mockRejectedValue(new Error("models.list must not run for durable synthesize"));
    setSetting("analysisModel", "claude-sonnet-5");
    setSetting("analysisEffort", "medium");

    const base = mockPasses();
    const analysts = vi.fn(async () => {
      throw new Error("durable synthesize must not launch analysts");
    });
    const oneAnalyst = vi.fn(async () => {
      throw new Error("durable synthesize must not launch one analyst");
    });
    const judge = vi.fn(async () => {
      throw new Error("durable synthesize must not launch judge");
    });
    const verify = vi.fn(async (...args: Parameters<PipelinePasses["runVerifyPass"]>) => ({
      ...await base.passes.runVerifyPass(...args),
      costUsd: undefined,
      model: undefined,
      usage: undefined,
    }));

    const result = await runJob(
      jobId,
      {
        ...base.passes,
        verifyCapability: { billable: false },
        fingerprintPayload: () => "1.3.0:synthesize-no-key",
        runBullThenBear: analysts,
        runAnalystPass: oneAnalyst,
        runJudgePass: judge,
        runVerifyPass: verify,
      },
      {
        bundle: fakeBundle(),
        hasAnthropicKey: false,
        now: NOW,
        resume: true,
        schedulerLimits: {
          ...configuredSchedulerLimits(),
          maxRollingCostUsd: 0.2,
        },
      },
    );

    expect(result).toMatchObject({ status: "done", dataOnly: false });
    expect(result.reportId).not.toBeNull();
    expect(resolveModelMock).not.toHaveBeenCalled();
    expect(analysts).not.toHaveBeenCalled();
    expect(oneAnalyst).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]?.[0]).toMatchObject({
      analysisModel: "claude-opus-4-8",
      effort: "medium",
    });
    expect(
      handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all()
        .map((row) => [row.step, row.costUsd]),
    ).toEqual([["synthesize", 0.4]]);
  });

  it("queued resume re-derives a source verify artifact and persists it without paid work", async () => {
    const { jobId } = createJob("AAPL");
    persistPassSettlement({
      jobId,
      runGeneration: 0,
      attemptId: "source-verify-success",
      pass: "verify",
      settlement: testSuccessSettlement({
        data: fakeReport(fakeJudgeOutput()),
        model: "deterministic",
        costUsd: 0,
        fallbackUsed: false,
      }, false),
      payloadFingerprint: "1.3.0:cross-process",
      settledAt: NOW().toISOString(),
    });
    handle.db
      .update(jobs)
      .set({ status: "error", error: "worker crashed before report link", reportId: null })
      .where(eq(jobs.id, jobId))
      .run();

    expect(claimJobForResume(jobId, "error")).toBe(true);
    clearPreparedResumeProcessCache();

    const base = mockPasses();
    const analysts = vi.fn(base.passes.runBullThenBear);
    const judge = vi.fn(base.passes.runJudgePass);
    const verify = vi.fn(base.passes.runVerifyPass);
    const result = await runJob(
      jobId,
      {
        ...base.passes,
        fingerprintPayload: () => "1.3.0:cross-process",
        runBullThenBear: analysts,
        runJudgePass: judge,
        runVerifyPass: verify,
      },
      { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW, resume: true },
    );

    expect(result).toMatchObject({ status: "done", dataOnly: false });
    expect(result.reportId).not.toBeNull();
    expect(analysts).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(
      handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get()?.model,
    ).toBe("claude-opus-4-8");
  });

  it("keeps a generation-zero synthesize lineage through queued and claimed cancellation", async () => {
    const { jobId } = createJob("AAPL");
    const fingerprint = "1.3.0:chained-synthesize";
    persistPassSettlement({
      jobId,
      runGeneration: 0,
      attemptId: "lineage-source-synthesize",
      pass: "synthesize",
      settlement: testSuccessSettlement({
        data: fakeJudgeOutput(),
        model: "claude-opus-4-8",
        costUsd: 0.4,
        fallbackUsed: false,
      }),
      payloadFingerprint: fingerprint,
      settledAt: NOW().toISOString(),
    });
    handle.db.update(jobs).set({
      status: "error",
      error: "stopped after synthesize",
      reportId: null,
    }).where(eq(jobs.id, jobId)).run();

    expect(claimJobForResume(jobId, "error")).toBe(true);
    expect(cancelJob(jobId)).toBe(true);
    expect(readJobResumeState(jobId)).toMatchObject({
      resumable: true,
      reusablePasses: ["synthesize"],
      rerunPasses: ["verify"],
    });
    expect(claimJobForResume(jobId, "error")).toBe(true);
    clearPreparedResumeProcessCache();

    const base = mockPasses();
    const analysts = vi.fn(async () => {
      throw new Error("ancestor synthesize must suppress analyst work");
    });
    const oneAnalyst = vi.fn(async () => {
      throw new Error("ancestor synthesize must suppress one-sided analyst work");
    });
    const judge = vi.fn(async () => {
      throw new Error("ancestor synthesize must not be re-billed");
    });
    const verify = vi.fn(base.passes.runVerifyPass);
    const result = await runJob(jobId, {
      ...base.passes,
      fingerprintPayload: () => fingerprint,
      runBullThenBear: analysts,
      runAnalystPass: oneAnalyst,
      runJudgePass: judge,
      runVerifyPass: verify,
    }, { bundle: fakeBundle(), hasAnthropicKey: false, now: NOW, resume: true });

    expect(result).toMatchObject({ status: "done", dataOnly: false });
    expect(analysts).not.toHaveBeenCalled();
    expect(oneAnalyst).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledTimes(1);
    const row = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    expect(row).toMatchObject({ runGeneration: 2, resumeSourceGeneration: 0 });
    const synthesize = (JSON.parse(row.stepsJson) as StepProgress[])
      .find((step) => step.step === "synthesize");
    expect(synthesize?.detail).toContain("generation 0");
  });

  it("keeps a generation-zero verify lineage through two canceled retries with no paid tail", async () => {
    const { claimQueuedJobById } = await import("@/pipeline/jobScheduler");
    const { jobId } = createJob("AAPL");
    persistPassSettlement({
      jobId,
      runGeneration: 0,
      attemptId: "lineage-source-verify",
      pass: "verify",
      settlement: testSuccessSettlement({
        data: fakeReport(fakeJudgeOutput()),
        model: "deterministic",
        costUsd: 0,
        fallbackUsed: false,
      }, false),
      payloadFingerprint: "1.3.0:chained-verify",
      settledAt: NOW().toISOString(),
    });
    handle.db.update(jobs).set({
      status: "error",
      error: "stopped before report link",
      reportId: null,
    }).where(eq(jobs.id, jobId)).run();

    expect(claimJobForResume(jobId, "error")).toBe(true);
    // Exercise the claimed-then-canceled path rather than only a queued cancel.
    const firstClaim = claimQueuedJobById(jobId, "lineage-canceled-worker", new Date(), {
      maxActiveJobs: 1,
      maxActiveLlmCalls: 2,
      maxRollingCostUsd: null,
      rollingCostWindowMs: 60 * 60 * 1000,
      paidPassLeaseTtlMs: 900_000,
      jobLeaseTtlMs: 900_000,
    });
    expect(firstClaim).not.toBeNull();
    expect(cancelJob(jobId)).toBe(true);
    expect(readJobResumeState(jobId)).toMatchObject({
      resumable: true,
      reusablePasses: ["verify"],
      rerunPasses: [],
    });
    expect(claimJobForResume(jobId, "error")).toBe(true);
    clearPreparedResumeProcessCache();

    const base = mockPasses();
    const analysts = vi.fn(base.passes.runBullThenBear);
    const oneAnalyst = vi.fn(async () => {
      throw new Error("verified ancestor must suppress one-sided analyst work");
    });
    const judge = vi.fn(base.passes.runJudgePass);
    const verify = vi.fn(base.passes.runVerifyPass);
    const result = await runJob(jobId, {
      ...base.passes,
      runBullThenBear: analysts,
      runAnalystPass: oneAnalyst,
      runJudgePass: judge,
      runVerifyPass: verify,
    }, { resume: true, now: NOW });

    expect(result).toMatchObject({ status: "done", dataOnly: false });
    expect(analysts).not.toHaveBeenCalled();
    expect(oneAnalyst).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    const row = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    expect(row).toMatchObject({ runGeneration: 2, resumeSourceGeneration: 0 });
    const verifyStep = (JSON.parse(row.stepsJson) as StepProgress[])
      .find((step) => step.step === "verify");
    expect(verifyStep?.detail).toContain("generation 0");
    expect(handle.db.select().from(jobPassArtifacts)
      .where(eq(jobPassArtifacts.jobId, jobId)).all())
      .toEqual([expect.objectContaining({ runGeneration: 0, attemptId: "lineage-source-verify" })]);
  });

  it.each([null, "1.3.0:verified-final"])(
    "links a durable verify result with fingerprint %j before fetch, key, model, or payload prerequisites",
    async (payloadFingerprint) => {
    const { jobId } = createJob("AAPL");
    const verifiedReport = fakeReport(fakeJudgeOutput());
    persistPassSettlement({
      jobId,
      runGeneration: 0,
      attemptId: payloadFingerprint === null
        ? "source-verify-earliest-terminal-null"
        : "source-verify-earliest-terminal-known",
      pass: "verify",
      settlement: testSuccessSettlement({
        data: verifiedReport,
        model: "deterministic",
        costUsd: 0,
        fallbackUsed: false,
      }, false),
      payloadFingerprint,
      settledAt: NOW().toISOString(),
    });
    handle.db
      .update(jobs)
      .set({ status: "error", error: "report link interrupted", reportId: null })
      .where(eq(jobs.id, jobId))
      .run();
    const base = mockPasses();
    const assemblePayload = vi.fn(() => {
      throw new Error("payload prerequisite must not run for durable verify");
    });
    const analysts = vi.fn(base.passes.runBullThenBear);
    const judge = vi.fn(base.passes.runJudgePass);
    const verify = vi.fn(base.passes.runVerifyPass);
    const fetchPrerequisite = vi.fn(() => {
      throw new Error("fetch prerequisite must not run for durable verify");
    });
    const options: RunJobOptions = {
      now: NOW,
      resume: true,
    };
    Object.defineProperty(options, "bundle", { get: fetchPrerequisite });

    const result = await runJob(
      jobId,
      {
        ...base.passes,
        assembleContextPayload: assemblePayload,
        fingerprintPayload: () => "1.3.0:naturally-changed-live-payload",
        runBullThenBear: analysts,
        runJudgePass: judge,
        runVerifyPass: verify,
      },
      options,
    );

    expect(result).toMatchObject({ status: "done", dataOnly: false });
    expect(result.reportId).not.toBeNull();
    expect(fetchPrerequisite).not.toHaveBeenCalled();
    expect(resolveModelMock).not.toHaveBeenCalled();
    expect(assemblePayload).not.toHaveBeenCalled();
    expect(analysts).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    const persistedJson = handle.db
      .select()
      .from(reports)
      .where(eq(reports.id, result.reportId!))
      .get()?.reportJson;
    expect(persistedJson).not.toBeNull();
    const persisted = ReportSchema.parse(JSON.parse(persistedJson!));
    const { meta: persistedMeta, appendix: persistedAppendix, ...persistedAnalysis } = persisted;
    const { meta: expectedMeta, appendix: expectedAppendix, ...expectedAnalysis } = verifiedReport;
    expect(persistedAnalysis).toEqual(expectedAnalysis);
    expect(persistedAppendix.sources).toEqual(expectedAppendix.sources);
    expect(persistedAppendix.missingData).toEqual(expectedAppendix.missingData);
    expect(persistedMeta).toMatchObject({
      symbol: expectedMeta.symbol,
      companyName: expectedMeta.companyName,
      generatedAt: expectedMeta.generatedAt,
      model: expectedMeta.model,
      asOfMap: expectedMeta.asOfMap,
    });
    },
  );

  it("reconciles real-facade verify recovery from the local ledger before early persistence", async () => {
    const { jobId } = createJob("AAPL");
    const bundle = fakeBundle();
    const validation = validateBundle(bundle, { now: NOW() });
    const computed = runStageB(bundle);
    const payload = pipelinePasses.assembleContextPayload(bundle, computed, validation);
    const payloadFingerprint = pipelinePasses.fingerprintPayload!(payload);

    persistPassSettlement({
      jobId,
      runGeneration: 0,
      attemptId: "real-facade-bull",
      pass: "bull",
      settlement: testSuccessSettlement(testAnalystPass("bull")),
      payloadFingerprint,
      settledAt: NOW().toISOString(),
    });
    persistPassSettlement({
      jobId,
      runGeneration: 0,
      attemptId: "real-facade-bear",
      pass: "bear",
      settlement: testSuccessSettlement(testAnalystPass("bear")),
      payloadFingerprint,
      settledAt: NOW().toISOString(),
    });
    persistPassSettlement({
      jobId,
      runGeneration: 0,
      attemptId: "real-facade-synthesize",
      pass: "synthesize",
      settlement: testSuccessSettlement({
        data: fakeJudgeOutput(),
        model: "claude-opus-4-8",
        costUsd: 0.4,
        fallbackUsed: false,
      }),
      payloadFingerprint,
      settledAt: NOW().toISOString(),
    });

    const verified = await pipelinePasses.runVerifyPass(
      // jobSeed as the runner threads it on every pass call (WS7 D-20).
      { analysisModel: "claude-opus-4-8", payload, jobSeed: jobId },
      fakeJudgeOutput(),
      { fetchedUrls: [] },
      async (settlement) => {
        persistPassSettlement({
          jobId,
          runGeneration: 0,
          attemptId: "real-facade-verify",
          pass: "verify",
          settlement,
          payloadFingerprint,
          settledAt: NOW().toISOString(),
        });
      },
    );
    expect(providerBoundaryMocks.runPass).not.toHaveBeenCalled();
    expect(providerBoundaryMocks.runPassStreaming).not.toHaveBeenCalled();
    expect(providerBoundaryMocks.webSearchTool).not.toHaveBeenCalled();

    const verifyArtifact = readCurrentGenerationPassArtifacts(jobId).find(
      (artifact) => artifact.pass === "verify",
    );
    expect(verifyArtifact?.envelope.outcome).toBe("success");
    if (verifyArtifact?.envelope.outcome !== "success") {
      throw new Error("expected a durable real-facade verify success artifact");
    }
    const storedBeforeRecovery = ReportSchema.parse(verifyArtifact.envelope.data);
    expect(storedBeforeRecovery.meta.costUsd).toBe(0);
    expect(storedBeforeRecovery.meta.execution).toEqual([]);
    expect(storedBeforeRecovery.appendix.costBreakdown).toEqual([]);
    expect(verified.verifiedReport.meta.generatedAt).toBe(storedBeforeRecovery.meta.generatedAt);

    handle.db
      .update(jobs)
      .set({ status: "error", error: "report link interrupted", reportId: null })
      .where(eq(jobs.id, jobId))
      .run();
    clearPreparedResumeProcessCache();
    providerBoundaryMocks.runPass.mockClear();
    providerBoundaryMocks.runPassStreaming.mockClear();
    providerBoundaryMocks.webSearchTool.mockClear();

    const fetchPrerequisite = vi.fn(() => {
      throw new Error("fetch prerequisite must not run for durable verify recovery");
    });
    const options: RunJobOptions = {
      now: NOW,
      resume: true,
    };
    Object.defineProperty(options, "bundle", { get: fetchPrerequisite });

    const result = await runJob(jobId, pipelinePasses, options);

    expect(result).toMatchObject({ status: "done", dataOnly: false });
    expect(fetchPrerequisite).not.toHaveBeenCalled();
    // A direct invocation must read only local settings before taking its
    // durable claim; durable recovery still avoids every provider/model
    // boundary and never fetches the data prerequisite.
    // WS6 (D-19): 2 -> 3. Stage B reads THESIS_EV_INCLUDE_LEASES once per run
    // to decide whether lease liabilities count in the enterprise-value bridge
    // (src/pipeline/compute.ts). It is a local settings read like the other
    // two; no provider or model boundary is crossed, which the assertions
    // below still pin.
    // WS7 (D-20), 2026-09 review: 3 -> 4. The count spans this whole test, and
    // the DIRECT pipelinePasses.runVerifyPass call above now reads
    // THESIS_JUDGE_ORDER — once, and only because no judge pass ran in this
    // process, so the judgement protocol has to be reconstructed from the seed
    // and the setting instead of vanishing. Also a local settings read; the
    // recovery run itself still crosses no provider or model boundary.
    expect(configMocks.getConfig).toHaveBeenCalledTimes(4);
    expect(resolveModelMock).not.toHaveBeenCalled();
    expect(providerBoundaryMocks.runPass).not.toHaveBeenCalled();
    expect(providerBoundaryMocks.runPassStreaming).not.toHaveBeenCalled();
    expect(providerBoundaryMocks.webSearchTool).not.toHaveBeenCalled();

    const persistedRow = handle.db
      .select()
      .from(reports)
      .where(eq(reports.id, result.reportId!))
      .get();
    expect(persistedRow?.costUsd).toBeCloseTo(1.77, 10);
    const persisted = ReportSchema.parse(JSON.parse(persistedRow!.reportJson!));
    expect(persisted.meta.costUsd).toBeCloseTo(1.77, 10);
    expect(persisted.meta.execution?.map((entry) => ({
      step: entry.step,
      requestedModel: entry.requestedModel,
      effectiveModel: entry.effectiveModel,
    }))).toEqual([
      { step: "bull", requestedModel: "claude-opus-4-8", effectiveModel: "claude-opus-4-8" },
      { step: "bear", requestedModel: "claude-opus-4-8", effectiveModel: "claude-opus-4-8" },
      { step: "synthesize", requestedModel: "claude-opus-4-8", effectiveModel: "claude-opus-4-8" },
      { step: "verify", requestedModel: "deterministic", effectiveModel: "deterministic" },
    ]);
    expect(persisted.appendix.costBreakdown.map(({ step, model, costUsd }) => ({
      step,
      model,
      costUsd,
    }))).toEqual([
      { step: "bull", model: "claude-opus-4-8", costUsd: 0.9 },
      { step: "bear", model: "claude-opus-4-8", costUsd: 0.47 },
      { step: "synthesize", model: "claude-opus-4-8", costUsd: 0.4 },
    ]);
    expect(persisted.meta.symbol).toBe("AAPL");
    expect(persisted.meta.companyName).toBe("Apple Inc.");
    expect(persisted.meta.asOfMap).toEqual({ profile: "2026-07-01", treasury: "2026-07-04" });
    expect(persisted.meta.generatedAt).toBe(storedBeforeRecovery.meta.generatedAt);
    expect(persisted.verdict.synthesis).toBe(
      "A three-sentence synthesis with scenarios and probabilities. It avoids ratings. It is grounded.",
    );

    // ---- WS7 (D-20), 2026-09 review ------------------------------------
    // Everything below is measured on the report this REAL-FACADE production
    // run persisted, not on a direct assembleReport call with hand-written
    // cost entries.
    //
    // SHOULD-FIX 4: the judge pass did not run in this process (the synthesize
    // artifact was replayed), so the WeakMap that held the protocol missed and
    // the whole judgement protocol used to vanish from the resumed report — no
    // metadata block, no reader sentence, no case-order manifest entry, no
    // error and no gap entry. It is now reconstructed from the job seed and the
    // setting, with the unrecoverable half disclosed.
    const protocol = persisted.meta.judgeProtocol;
    expect(protocol).toBeDefined();
    expect(protocol?.order).toBe(resolveJudgeOrder("random", jobId).order);
    expect(protocol?.seed).toBe(jobId);
    expect(protocol?.bull).toBeNull();
    expect(protocol?.bear).toBeNull();
    expect(protocol?.note).toContain("reconstructed rather than recorded");
    const recovered = persisted.appendix.missingData.find(
      (entry) => entry.field === "llm.judge.protocol-recovered",
    );
    expect(recovered?.severity).toBe("warn");
    expect(
      persisted.appendix.missingData.some(
        (entry) => entry.field === "llm.judge.case-order" && entry.reason === protocol?.note,
      ),
    ).toBe(true);

    // BLOCKER 1: all three passes ran on claude-opus-4-8, so the judge graded
    // its own family's output. Stage C assembles the report with
    // `costEntries: []`, so this used to compute "not shared" and NOTHING lit:
    // no metadata flag, no reader sentence, no manifest entry, no badge. The
    // runner now re-stamps it from the execution list it owns.
    expect(protocol?.sharedModelFamily).toEqual({
      shared: true,
      analystFamily: "opus",
      judgeFamily: "opus",
    });
    expect(protocol?.note).toContain("grading output from its own family");
    const familyEntry = persisted.appendix.missingData.find(
      (entry) => entry.field === "llm.judge.model-family",
    );
    expect(familyEntry?.severity).toBe("warn");
    expect(familyEntry?.reason).toContain("not independent");
    // reconcileMeta replaces meta.execution with the runner's own list, which
    // used to discard the appended shared-family execution note.
    expect(
      persisted.meta.execution?.find((entry) => entry.step === "synthesize")?.note,
    ).toContain("rather than acting as an independent second opinion");

    // BLOCKER 2, at the reconcile end: both edits above CHANGE the manifest the
    // completeness metadata summarizes, so it is recomputed. A disagreement of
    // one entry renders as "Completeness unknown" and blanks state, counts,
    // EDGAR, XBRL and forensic validation in the appendix and the banner.
    const completeness = deriveReportCompletenessPresentation(
      persisted.meta.dataCompleteness,
      persisted.appendix.missingData,
    );
    expect(completeness.metadataStatus).toBe("confirmed");
    expect(completeness.warningCount).toBe(
      persisted.appendix.missingData.filter(
        (entry) => entry.severity === "warn" && entry.expected !== true,
      ).length,
    );
    expect(completeness.warningCount).not.toBe(0);
  });

  it("keeps repeated prior-generation ledger attempts distinct from effective pass execution", async () => {
    const { jobId } = createJob("AAPL");
    const persistAttempt = (
      runGeneration: number,
      attemptId: string,
      pass: "bull" | "bear" | "synthesize" | "verify",
      settlement: TestSettlement<unknown>,
      payloadFingerprint: string,
    ): void => {
      persistPassSettlement({
        jobId,
        runGeneration,
        attemptId,
        pass,
        settlement,
        payloadFingerprint,
        settledAt: NOW().toISOString(),
      });
    };
    const oldBullAttempt = {
      ...testAnalystPass("bull", 0.11),
      model: "claude-haiku-3-5",
      fallbackUsed: false,
    };
    const oldSynthesizeAttempt: PassResultLike<JudgeOutput> = {
      data: fakeJudgeOutput(),
      model: "claude-sonnet-4-5",
      costUsd: 0.2,
      fallbackUsed: false,
    };
    const oldVerifyAttempt: PassResultLike<Report> = {
      data: fakeReport(fakeJudgeOutput()),
      model: "claude-sonnet-4-5",
      costUsd: 0.05,
      fallbackUsed: true,
    };
    for (const [attemptId, pass, settlement] of [
      ["generation-0-bull-failure", "bull", testFailureSettlement(oldBullAttempt, "old bull failed")],
      ["generation-0-synthesize-failure", "synthesize", testFailureSettlement(oldSynthesizeAttempt, "old synthesize failed")],
      ["generation-0-verify-failure", "verify", testFailureSettlement(oldVerifyAttempt, "old paid verify failed")],
    ] as const) {
      persistAttempt(0, attemptId, pass, settlement, "1.3.0:prior-generation");
    }

    handle.db
      .update(jobs)
      .set({ runGeneration: 1, revision: 1 })
      .where(eq(jobs.id, jobId))
      .run();
    const currentBull = { ...testAnalystPass("bull"), fallbackUsed: true };
    const currentBear = testAnalystPass("bear");
    const currentSynthesize: PassResultLike<JudgeOutput> = {
      data: fakeJudgeOutput(),
      model: "claude-opus-4-8",
      costUsd: 0.4,
      fallbackUsed: true,
    };
    for (const [attemptId, pass, settlement] of [
      ["generation-1-bull-success", "bull", testSuccessSettlement(currentBull)],
      ["generation-1-bear-success", "bear", testSuccessSettlement(currentBear)],
      ["generation-1-synthesize-success", "synthesize", testSuccessSettlement(currentSynthesize)],
    ] as const) {
      persistAttempt(1, attemptId, pass, settlement, "1.3.0:current-generation");
    }
    persistPassSettlement({
      jobId,
      runGeneration: 1,
      attemptId: "generation-1-verify-success",
      pass: "verify",
      settlement: testSuccessSettlement({
        data: fakeReport(fakeJudgeOutput()),
        model: "deterministic",
        costUsd: 0,
        fallbackUsed: false,
      }, false),
      payloadFingerprint: "1.3.0:current-generation",
      settledAt: NOW().toISOString(),
    });
    handle.db
      .update(jobs)
      .set({ status: "error", error: "generation 1 report link interrupted", reportId: null })
      .where(eq(jobs.id, jobId))
      .run();

    const base = mockPasses();
    const result = await runJob(jobId, base.passes, {
      hasAnthropicKey: false,
      now: NOW,
      resume: true,
    });

    expect(result).toMatchObject({ status: "done", dataOnly: false, totalCostUsd: 2.13 });
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.runGeneration).toBe(2);
    expect(handle.db
      .select({ runGeneration: costLog.runGeneration })
      .from(costLog)
      .where(eq(costLog.jobId, jobId))
      .orderBy(costLog.id)
      .all()
      .map((row) => row.runGeneration)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(base.calls).toEqual([]);

    const row = handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get();
    expect(row?.costUsd).toBeCloseTo(2.13, 10);
    const persisted = ReportSchema.parse(JSON.parse(row!.reportJson!));
    expect(persisted.meta.costUsd).toBeCloseTo(2.13, 10);
    expect(persisted.meta.execution?.map((entry) => ({
      step: entry.step,
      effectiveModel: entry.effectiveModel,
      fallbackUsed: entry.fallbackUsed,
      adjustments: entry.adjustments,
    }))).toEqual([
      { step: "bull", effectiveModel: "claude-opus-4-8", fallbackUsed: true, adjustments: ["fallback"] },
      { step: "bear", effectiveModel: "claude-opus-4-8", fallbackUsed: false, adjustments: [] },
      { step: "synthesize", effectiveModel: "claude-opus-4-8", fallbackUsed: true, adjustments: ["fallback"] },
      { step: "verify", effectiveModel: "deterministic", fallbackUsed: false, adjustments: [] },
    ]);
    expect(persisted.appendix.costBreakdown.map((entry) => ({
      step: entry.step,
      model: entry.model,
      costUsd: entry.costUsd,
      fallbackUsed: entry.fallbackUsed,
      hasAdjustments: Object.hasOwn(entry, "adjustments"),
      hasRequestedModel: Object.hasOwn(entry, "requestedModel"),
      hasRequestedEffort: Object.hasOwn(entry, "requestedEffort"),
      hasEffectiveEffort: Object.hasOwn(entry, "effectiveEffort"),
    }))).toEqual([
      { step: "bull", model: "claude-haiku-3-5", costUsd: 0.11, fallbackUsed: false, hasAdjustments: false, hasRequestedModel: false, hasRequestedEffort: false, hasEffectiveEffort: false },
      { step: "synthesize", model: "claude-sonnet-4-5", costUsd: 0.2, fallbackUsed: false, hasAdjustments: false, hasRequestedModel: false, hasRequestedEffort: false, hasEffectiveEffort: false },
      { step: "verify", model: "claude-sonnet-4-5", costUsd: 0.05, fallbackUsed: true, hasAdjustments: false, hasRequestedModel: false, hasRequestedEffort: false, hasEffectiveEffort: false },
      { step: "bull", model: "claude-opus-4-8", costUsd: 0.9, fallbackUsed: true, hasAdjustments: false, hasRequestedModel: false, hasRequestedEffort: false, hasEffectiveEffort: false },
      { step: "bear", model: "claude-opus-4-8", costUsd: 0.47, fallbackUsed: false, hasAdjustments: false, hasRequestedModel: false, hasRequestedEffort: false, hasEffectiveEffort: false },
      { step: "synthesize", model: "claude-opus-4-8", costUsd: 0.4, fallbackUsed: true, hasAdjustments: false, hasRequestedModel: false, hasRequestedEffort: false, hasEffectiveEffort: false },
    ]);
  });

  it("queued resume includes a late source analyst settlement before worker dispatch", async () => {
    const { jobId } = createJob("AAPL");
    persistPassSettlement({
      jobId,
      runGeneration: 0,
      attemptId: "source-bull-before-enqueue",
      pass: "bull",
      settlement: testSuccessSettlement(testAnalystPass("bull")),
      payloadFingerprint: "1.3.0:late-source",
      settledAt: NOW().toISOString(),
    });
    handle.db
      .update(jobs)
      .set({ status: "error", error: "bear still settling", reportId: null })
      .where(eq(jobs.id, jobId))
      .run();
    expect(claimJobForResume(jobId, "error")).toBe(true);

    persistPassSettlement({
      jobId,
      runGeneration: 0,
      attemptId: "source-bear-after-enqueue",
      pass: "bear",
      settlement: testSuccessSettlement(testAnalystPass("bear")),
      payloadFingerprint: "1.3.0:late-source",
      settledAt: NOW().toISOString(),
    });
    clearPreparedResumeProcessCache();

    const base = mockPasses();
    const bothAnalysts = vi.fn(base.passes.runBullThenBear);
    const oneAnalyst = vi.fn(async () => testAnalystPass("bear"));
    const result = await runJob(
      jobId,
      {
        ...base.passes,
        fingerprintPayload: () => "1.3.0:late-source",
        runBullThenBear: bothAnalysts,
        runAnalystPass: oneAnalyst,
      },
      { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW, resume: true },
    );

    expect(result.status).toBe("done");
    expect(bothAnalysts).not.toHaveBeenCalled();
    expect(oneAnalyst).not.toHaveBeenCalled();
  });

  it("generation-zero resume dispatch remains a fresh run rather than reading generation minus one", async () => {
    const { jobId } = createJob("AAPL");
    clearPreparedResumeProcessCache();
    const base = mockPasses();
    const analysts = vi.fn(base.passes.runBullThenBear);

    const result = await runJob(
      jobId,
      { ...base.passes, runBullThenBear: analysts },
      { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW, resume: true },
    );

    expect(result.status).toBe("done");
    expect(analysts).toHaveBeenCalledTimes(1);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.runGeneration).toBe(0);
  });

  it("terminalizes an unrecoverable source-artifact digest race without paid work or a queued strand", async () => {
    const { jobId } = createJob("AAPL");
    seedResumableLegacyJob(jobId, "error", "1.3.0:digest-race");
    expect(claimJobForResume(jobId, "error")).toBe(true);
    clearPreparedResumeProcessCache();
    handle.sqlite.exec(`
      CREATE TRIGGER inject_source_artifact_during_resume_dispatch
      BEFORE UPDATE OF status ON jobs
      WHEN OLD.status = 'queued' AND NEW.status = 'running' AND OLD.runGeneration = 1
      BEGIN
        INSERT INTO job_pass_artifacts (
          jobId, runGeneration, attemptId, pass, outcomeJson, telemetryJson, costJson, settledAt
        ) VALUES (
          OLD.id, 0, 'late-digest-race', 'bull', '{}', '{}', '{}', '2026-07-06T12:00:00.000Z'
        );
      END;
    `);
    const base = mockPasses();
    const paidJudge = vi.fn(base.passes.runJudgePass);

    await expect(runJob(
      jobId,
      {
        ...base.passes,
        fingerprintPayload: () => "1.3.0:digest-race",
        runJudgePass: paidJudge,
      },
      { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW, resume: true },
    )).rejects.toThrow(/source artifact.*changed|digest/i);

    expect(paidJudge).not.toHaveBeenCalled();
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
      status: "error",
      runGeneration: 1,
      error: expect.stringMatching(/source artifact.*changed|digest/i),
    });
    expect(
      handle.db.select().from(jobPassArtifacts).where(eq(jobPassArtifacts.jobId, jobId)).all(),
    ).toEqual([]);
  });

  it("rolls back a claim trigger that mutates the queued legacy reuse projection", async () => {
    const { jobId } = createJob("AAPL");
    seedResumableLegacyJob(jobId, "error", "1.3.0:legacy-race");
    expect(claimJobForResume(jobId, "error")).toBe(true);
    const queued = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    const originalBull = queued.bullJson;
    clearPreparedResumeProcessCache();
    handle.sqlite.exec(`
      CREATE TRIGGER mutate_legacy_projection_during_scheduler_claim
      BEFORE UPDATE OF status ON jobs
      WHEN OLD.status = 'queued' AND NEW.status = 'running' AND OLD.runGeneration = 1
      BEGIN
        UPDATE jobs SET bullJson = '{"tampered":true}' WHERE id = OLD.id;
      END;
    `);
    const base = mockPasses();
    const paidJudge = vi.fn(base.passes.runJudgePass);

    await expect(runJob(
      jobId,
      {
        ...base.passes,
        fingerprintPayload: () => "1.3.0:legacy-race",
        runJudgePass: paidJudge,
      },
      { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW, resume: true },
    )).rejects.toThrow(/source artifact|source state|digest/i);

    expect(paidJudge).not.toHaveBeenCalled();
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
      status: "error",
      runGeneration: 1,
      bullJson: originalBull,
      error: expect.stringMatching(/source artifact|source state|digest/i),
    });
  });

  it("two queued-resume workers launch the reusable tail exactly once", async () => {
    const { jobId } = createJob("AAPL");
    seedResumableLegacyJob(jobId, "error", "1.3.0:two-workers");
    expect(claimJobForResume(jobId, "error")).toBe(true);
    clearPreparedResumeProcessCache();
    const base = mockPasses();
    const originalJudge = base.passes.runJudgePass.bind(base.passes);
    const entered = deferred();
    const release = deferred();
    const paidJudge = vi.fn(async (...args: Parameters<PipelinePasses["runJudgePass"]>) => {
      entered.resolve(undefined);
      await release.promise;
      return originalJudge(...args);
    });
    const passes: PipelinePasses = {
      ...base.passes,
      fingerprintPayload: () => "1.3.0:two-workers",
      runJudgePass: paidJudge,
    };

    const first = runJob(
      jobId,
      passes,
      { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW, resume: true },
    );
    await entered.promise;
    const second = runJob(
      jobId,
      passes,
      { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW, resume: true },
    );
    await expect(second).rejects.toThrow(/already dispatched/);
    release.resolve(undefined);

    expect(await first).toMatchObject({ status: "done", dataOnly: false });
    expect(paidJudge).toHaveBeenCalledTimes(1);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.runGeneration).toBe(1);
  });

  it("preclaimed resume bumps exactly once, keeps legacy fallbacks, and clones no artifacts", async () => {
    const { jobId } = createJob("AAPL");
    const source = mockPasses();
    const sourcePasses: PipelinePasses = {
      ...source.passes,
      fingerprintPayload: () => "1.3.0:source",
      runJudgePass: async () => {
        throw new Error("judge transport failed after analyst settlement");
      },
    };
    await runJob(jobId, sourcePasses, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    });
    const terminal = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    const sourceArtifacts = handle.db
      .select()
      .from(jobPassArtifacts)
      .where(eq(jobPassArtifacts.jobId, jobId))
      .all();
    expect(terminal.runGeneration).toBe(0);
    expect(terminal.bullJson).not.toBeNull();
    expect(terminal.bearJson).not.toBeNull();
    handle.db.update(jobs).set({ reportId: null }).where(eq(jobs.id, jobId)).run();

    expect(claimJobForResume(jobId, "done")).toBe(true);
    const claimed = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    expect(claimed.runGeneration).toBe(1);
    expect(claimed.bullJson).toBe(terminal.bullJson);
    expect(claimed.bearJson).toBe(terminal.bearJson);
    expect(readCurrentGenerationPassArtifacts(jobId)).toEqual([]);
    expect(
      handle.db
        .select()
        .from(jobPassArtifacts)
        .where(eq(jobPassArtifacts.jobId, jobId))
        .all()
        .filter((row) => row.runGeneration === 1),
    ).toEqual([]);

    const resumed = mockPasses();
    const paidAnalystDispatch = vi.fn(async () => {
      throw new Error("preclaimed resume must not re-run analysts");
    });
    const result = await runJob(
      jobId,
      {
        ...resumed.passes,
        fingerprintPayload: () => "1.3.0:source",
        runBullThenBear: paidAnalystDispatch,
      },
      { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW, resume: true },
    );
    expect(result.status).toBe("done");
    expect(paidAnalystDispatch).not.toHaveBeenCalled();
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.runGeneration).toBe(1);
    const allArtifacts = handle.db
      .select()
      .from(jobPassArtifacts)
      .where(eq(jobPassArtifacts.jobId, jobId))
      .all();
    expect(allArtifacts.filter((row) => row.runGeneration === 0)).toHaveLength(sourceArtifacts.length);
    expect(
      allArtifacts.filter(
        (row) => row.runGeneration === 1 && (row.pass === "bull" || row.pass === "bear"),
      ),
    ).toEqual([]);
  });

  it("direct terminal resume performs the same single generation bump", async () => {
    const { jobId } = createJob("AAPL");
    seedResumableLegacyJob(jobId, "error", "1.3.0:direct");
    const healthy = mockPasses();
    const analysts = vi.fn(async () => {
      throw new Error("direct resume must reuse prepared analysts");
    });

    const result = await runJob(
      jobId,
      {
        ...healthy.passes,
        fingerprintPayload: () => "1.3.0:direct",
        runBullThenBear: analysts,
      },
      { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW, resume: true },
    );
    expect(result.status).toBe("done");
    expect(analysts).not.toHaveBeenCalled();
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.runGeneration).toBe(1);
  });

  it.each([
    [
      "full terminal",
      () => JSON.stringify(initialSteps().map((step, index) => ({
        ...step,
        status: index === 5 ? "error" as const : index === 6 ? "skipped" as const : "done" as const,
      }))),
    ],
    ["malformed", () => "{not-json"],
    [
      "partial",
      () => JSON.stringify([
        { step: "bull", status: "done" },
        { step: "bear", status: "done" },
        { step: "synthesize", status: "error" },
      ] satisfies StepProgress[]),
    ],
  ])("resets a %s source snapshot to seven pending retry steps in the claim revision", (
    _label,
    sourceSteps,
  ) => {
    const { jobId } = createJob("AAPL");
    seedResumableLegacyJob(jobId, "error", "1.3.0:retry-step-reset");
    handle.db.update(jobs).set({ stepsJson: sourceSteps() }).where(eq(jobs.id, jobId)).run();
    const before = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    const prepared = prepareJobResume(jobId, "error");
    expect(prepared).not.toBeNull();

    expect(claimPreparedJobResume(prepared!)).toBe(true);

    const queued = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    expect(queued).toMatchObject({
      status: "queued",
      runGeneration: before.runGeneration + 1,
      revision: before.revision + 1,
      bullJson: before.bullJson,
      bearJson: before.bearJson,
      payloadFingerprint: before.payloadFingerprint,
    });
    expect(JSON.parse(queued.stepsJson)).toEqual(initialSteps());
    const snapshot = getJobSnapshot(jobId)!;
    expect(snapshot).toMatchObject({
      status: "queued",
      revision: before.revision + 1,
      steps: initialSteps(),
    });
    const queuedPlan = prepareQueuedJobResume(jobId);
    expect(queuedPlan).toMatchObject({
      sourceGeneration: prepared!.sourceGeneration,
      targetGeneration: prepared!.targetGeneration,
      bull: prepared!.bull,
      bear: prepared!.bear,
      synthesize: prepared!.synthesize,
      verify: prepared!.verify,
      payloadFingerprint: prepared!.payloadFingerprint,
    });
    expect(handle.db.select().from(jobPassArtifacts).where(eq(jobPassArtifacts.jobId, jobId)).all())
      .toEqual([]);
  });

  it("one-sided paid analyst remains resumable after a preclaimed retry crashes early", () => {
    const { jobId } = createJob("AAPL");
    handle.db
      .update(jobs)
      .set({
        status: "error",
        error: "bear failed",
        stepsJson: JSON.stringify([
          { step: "bull", status: "done" },
          { step: "bear", status: "error" },
          { step: "synthesize", status: "skipped" },
        ] satisfies StepProgress[]),
        bullJson: JSON.stringify(testAnalystPass("bull")),
        bearJson: null,
        payloadFingerprint: "1.3.0:one-sided",
      })
      .where(eq(jobs.id, jobId))
      .run();
    expect(claimJobForResume(jobId, "error")).toBe(true);
    const claimed = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    expect(claimed.runGeneration).toBe(1);

    handle.db
      .update(jobs)
      .set({
        status: "error",
        error: "crashed during fetch before missing bear launched",
        revision: claimed.revision + 1,
        stepsJson: JSON.stringify([
          { step: "fetch", status: "error" },
          { step: "validate", status: "skipped" },
          { step: "compute", status: "skipped" },
          { step: "bull", status: "skipped" },
          { step: "bear", status: "skipped" },
          { step: "synthesize", status: "skipped" },
          { step: "verify", status: "skipped" },
        ] satisfies StepProgress[]),
      })
      .where(eq(jobs.id, jobId))
      .run();

    const again = prepareJobResume(jobId, "error");
    expect(again).not.toBeNull();
    expect(again?.bull).not.toBeNull();
    expect(again?.bear).toBeNull();
    expect(claimPreparedJobResume(again!)).toBe(true);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.runGeneration).toBe(2);
  });

  it("duplicate run dispatch launches providers once", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const original = base.passes.runBullThenBear.bind(base.passes);
    const entered = deferred();
    const release = deferred();
    const providerLaunch = vi.fn(async (...args: Parameters<PipelinePasses["runBullThenBear"]>) => {
      entered.resolve(undefined);
      await release.promise;
      return original(...args);
    });
    const passes: PipelinePasses = { ...base.passes, runBullThenBear: providerLaunch };

    const first = runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    });
    await entered.promise;
    await expect(
      runJob(jobId, passes, { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW }),
    ).rejects.toThrow(/already dispatched|already claimed/i);
    release.resolve(undefined);
    expect((await first).status).toBe("done");
    expect(providerLaunch).toHaveBeenCalledTimes(1);
  });

  it("simultaneous bull and bear settlements preserve both step states", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const bull = testAnalystPass("bull");
    const bear = testAnalystPass("bear");
    const passes: PipelinePasses = {
      ...base.passes,
      fingerprintPayload: () => "1.3.0:parallel",
      runBullThenBear: async (...raw: unknown[]) => {
        const { lifecycle, settlements: hooks } = testAnalystHooks(raw);
        if (!hooks?.bull || !hooks.bear) throw new Error("missing analyst settlement hooks");
        await Promise.all([
          launchTestAnalystSide(lifecycle, "bull"),
          launchTestAnalystSide(lifecycle, "bear"),
        ]);
        await Promise.all([
          hooks.bull(testSuccessSettlement(bull)),
          hooks.bear(testSuccessSettlement(bear)),
        ]);
        return { bull, bear };
      },
    };

    expect((await runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    })).status).toBe("done");
    const steps = JSON.parse(
      handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!.stepsJson,
    ) as StepProgress[];
    expect(steps.find((step) => step.step === "bull")?.status).toBe("done");
    expect(steps.find((step) => step.step === "bear")?.status).toBe("done");
    expect(
      readCurrentGenerationPassArtifacts(jobId)
        .filter((artifact) => artifact.pass === "bull" || artifact.pass === "bear"),
    ).toHaveLength(2);
  });

  it.each([
    { label: "billed", billable: true, costUsd: 0.33 },
    { label: "unbilled", billable: false, costUsd: 0 },
  ])("persists a $label failure atomically", async ({ billable, costUsd }) => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const error = new Error("judge attempt failed deterministically");
    const passes: PipelinePasses = {
      ...base.passes,
      runJudgePass: async (...raw: unknown[]) => {
        const hook = raw[4] as TestSettlementHook<JudgeOutput> | undefined;
        if (!hook) throw new Error("missing judge settlement hook");
        await hook({
          outcome: "failure",
          failure: { name: "Error", message: error.message },
          telemetry: {
            ...testTelemetry({
              data: fakeJudgeOutput(),
              model: "claude-opus-4-8",
              costUsd,
              fallbackUsed: false,
              usage: { input_tokens: 800, output_tokens: 400 },
            }, billable),
            billable,
          },
        });
        if (billable) {
          Object.assign(error, {
            billedAttempt: {
              model: "claude-opus-4-8",
              costUsd,
              fallbackUsed: false,
              usage: { input_tokens: 800, output_tokens: 400 },
            },
          });
        }
        throw error;
      },
    };

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    });
    expect(result.dataOnly).toBe(true);
    const synth = readCurrentGenerationPassArtifacts(jobId).filter(
      (artifact) => artifact.pass === "synthesize",
    );
    expect(synth).toHaveLength(1);
    expect(synth[0]?.envelope.outcome).toBe("failure");
    const synthCosts = handle.db
      .select()
      .from(costLog)
      .where(eq(costLog.jobId, jobId))
      .all()
      .filter((row) => row.step === "synthesize");
    expect(synthCosts).toHaveLength(billable ? 1 : 0);
    if (billable) expect(synthCosts[0]?.attemptId).toBe(synth[0]?.attemptId);
  });

  it.each([
    { label: "deterministic", billable: false, costUsd: undefined },
    { label: "paid mock", billable: true, costUsd: 0.18 },
  ])("persists $label verify with the correct atomic cost pair", async ({ billable, costUsd }) => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const original = base.passes.runVerifyPass.bind(base.passes);
    const passes: PipelinePasses = {
      ...base.passes,
      runVerifyPass: async (deps, judge, evidence, hook) => {
        const result = await original(deps, judge, evidence);
        const telemetry: TestTelemetry = {
          model: billable ? "claude-opus-4-8" : "deterministic",
          inputTokens: billable ? 100 : 0,
          outputTokens: billable ? 50 : 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          webSearches: 0,
          costUsd: costUsd ?? 0,
          fallbackUsed: false,
          billable,
          fetchedUrls: [],
        };
        await (hook as TestSettlementHook<Report> | undefined)?.({
          outcome: "success",
          data: result.verifiedReport,
          telemetry,
        });
        return {
          ...result,
          costUsd,
          model: telemetry.model,
          usage: { input_tokens: telemetry.inputTokens, output_tokens: telemetry.outputTokens },
        };
      },
    };

    expect((await runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    })).status).toBe("done");
    const verifyArtifacts = readCurrentGenerationPassArtifacts(jobId).filter(
      (artifact) => artifact.pass === "verify",
    );
    expect(verifyArtifacts).toHaveLength(1);
    const verifyCosts = handle.db
      .select()
      .from(costLog)
      .where(eq(costLog.jobId, jobId))
      .all()
      .filter((row) => row.step === "verify");
    expect(verifyCosts).toHaveLength(billable ? 1 : 0);
    if (billable) expect(verifyCosts[0]?.attemptId).toBe(verifyArtifacts[0]?.attemptId);
  });

  it("clears an opposite legacy analyst when a new fingerprint cohort settles", async () => {
    const { jobId } = createJob("AAPL");
    handle.db
      .update(jobs)
      .set({
        bullJson: JSON.stringify(testAnalystPass("bull")),
        payloadFingerprint: "1.3.0:fpA",
      })
      .where(eq(jobs.id, jobId))
      .run();
    const base = mockPasses();
    const bearSettled = deferred();
    const passes: PipelinePasses = {
      ...base.passes,
      fingerprintPayload: () => "1.3.0:fpB",
      runBullThenBear: async (...raw: unknown[]) => {
        const { lifecycle, settlements } = testAnalystHooks(raw);
        await launchTestAnalystSide(lifecycle, "bear");
        const bear = settlements?.bear;
        if (!bear) throw new Error("missing bear settlement hook");
        await bear(testSuccessSettlement(testAnalystPass("bear")));
        bearSettled.resolve(undefined);
        return new Promise<never>(() => {});
      },
    };
    const running = runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
      deadlineMs: 10_000,
    });
    await bearSettled.promise;
    const checkpoint = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    expect(checkpoint.payloadFingerprint).toBe("1.3.0:fpB");
    expect(checkpoint.bullJson).toBeNull();
    expect(checkpoint.bearJson).not.toBeNull();
    expect(cancelJob(jobId)).toBe(true);
    expect((await running).status).toBe("error");
  });

  it("current judge failure keeps each legacy analyst resumable without cloning or rebilling", async () => {
    const { jobId } = createJob("AAPL");
    const source = mockPasses();
    await runJob(
      jobId,
      {
        ...source.passes,
        fingerprintPayload: () => "1.3.0:cohort",
        runJudgePass: async () => {
          throw new Error("source judge unavailable");
        },
      },
      { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW },
    );
    handle.db.update(jobs).set({ reportId: null }).where(eq(jobs.id, jobId)).run();
    expect(claimJobForResume(jobId, "done")).toBe(true);

    const retry = mockPasses();
    const judgeError = Object.assign(new Error("current judge billed failure"), {
      billedAttempt: {
        model: "claude-opus-4-8",
        costUsd: 0.27,
        fallbackUsed: false,
        usage: { input_tokens: 500, output_tokens: 250 },
      },
    });
    const result = await runJob(
      jobId,
      {
        ...retry.passes,
        fingerprintPayload: () => "1.3.0:cohort",
        runBullThenBear: async () => {
          throw new Error("must reuse legacy analysts");
        },
        runJudgePass: async () => {
          throw judgeError;
        },
      },
      { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW, resume: true },
    );
    expect(result.dataOnly).toBe(true);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.runGeneration).toBe(1);
    const current = readCurrentGenerationPassArtifacts(jobId);
    expect(current.filter((artifact) => artifact.pass === "bull" || artifact.pass === "bear")).toEqual([]);
    expect(current.filter((artifact) => artifact.pass === "synthesize")).toHaveLength(1);
    expect(
      handle.db
        .select()
        .from(costLog)
        .where(eq(costLog.jobId, jobId))
        .all()
        .filter((row) => row.step === "bull" || row.step === "bear"),
    ).toHaveLength(2);
    expect(readPassSnapshots(jobId)?.bull).not.toBeNull();
    expect(readPassSnapshots(jobId)?.bear).not.toBeNull();
    handle.db.update(jobs).set({ reportId: null }).where(eq(jobs.id, jobId)).run();
    expect(claimJobForResume(jobId, "done")).toBe(true);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.runGeneration).toBe(2);
  });

  it("report-link change in the prepare-to-claim window loses the exact source-state CAS", () => {
    const { jobId } = createJob("AAPL");
    seedResumableLegacyJob(jobId, "error");
    const first = 999_981;
    const second = 999_982;
    handle.sqlite.pragma("foreign_keys = OFF");
    handle.sqlite.prepare("UPDATE jobs SET reportId = ? WHERE id = ?").run(first, jobId);
    const prepared = prepareJobResume(jobId, "error");
    expect(prepared).not.toBeNull();
    handle.sqlite.prepare("UPDATE jobs SET reportId = ? WHERE id = ?").run(second, jobId);
    handle.sqlite.pragma("foreign_keys = ON");

    expect(claimPreparedJobResume(prepared!)).toBe(false);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
      status: "error",
      runGeneration: 0,
      reportId: second,
    });
  });

  it("report existence appearing in the prepare-to-claim window prevents the retry bump", () => {
    const { jobId } = createJob("AAPL");
    seedResumableLegacyJob(jobId, "error", "1.3.0:report-race");
    const danglingReportId = 999_991;
    handle.sqlite.pragma("foreign_keys = OFF");
    handle.sqlite.prepare("UPDATE jobs SET reportId = ? WHERE id = ?").run(danglingReportId, jobId);
    handle.sqlite.pragma("foreign_keys = ON");
    const prepared = prepareJobResume(jobId, "error");
    expect(prepared).not.toBeNull();

    handle.db.insert(reports).values({
      id: danglingReportId,
      symbol: "AAPL",
      createdAt: NOW().toISOString(),
      model: "deterministic",
      status: "done",
      reportJson: "corrupt but existing",
      verificationRate: null,
      costUsd: 0,
      specVersion: "1.0.0",
    }).run();

    expect(claimPreparedJobResume(prepared!)).toBe(false);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
      status: "error",
      runGeneration: 0,
      reportId: danglingReportId,
    });
  });

  it("preserves a dangling report projection so a new process can revalidate it after enqueue", () => {
    const { jobId } = createJob("AAPL");
    seedResumableLegacyJob(jobId, "error", "1.3.0:dangling-enqueue");
    const danglingReportId = 999_992;
    handle.sqlite.pragma("foreign_keys = OFF");
    handle.sqlite.prepare("UPDATE jobs SET reportId = ? WHERE id = ?").run(danglingReportId, jobId);
    handle.sqlite.pragma("foreign_keys = ON");

    expect(claimJobForResume(jobId, "error")).toBe(true);
    clearPreparedResumeProcessCache();

    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
      status: "queued",
      runGeneration: 1,
      reportId: danglingReportId,
    });
    expect(prepareQueuedJobResume(jobId)).toMatchObject({
      sourceGeneration: 0,
      targetGeneration: 1,
      sourceReportId: danglingReportId,
      sourceReportExists: false,
    });
  });

  it("finishes from a report that appears after queued preparation without paid work or a queued strand", async () => {
    const { jobId } = createJob("AAPL");
    seedResumableLegacyJob(jobId, "error", "1.3.0:report-after-prepare");
    const danglingReportId = 999_993;
    handle.sqlite.pragma("foreign_keys = OFF");
    handle.sqlite.prepare("UPDATE jobs SET reportId = ? WHERE id = ?").run(danglingReportId, jobId);
    handle.sqlite.pragma("foreign_keys = ON");
    expect(claimJobForResume(jobId, "error")).toBe(true);
    clearPreparedResumeProcessCache();
    expect(prepareQueuedJobResume(jobId)).not.toBeNull();

    handle.db.insert(reports).values({
      id: danglingReportId,
      symbol: "AAPL",
      createdAt: NOW().toISOString(),
      model: "claude-opus-4-8",
      status: "done",
      reportJson: "corrupt but existing",
      verificationRate: 0.75,
      costUsd: 1.37,
      specVersion: "1.0.0",
    }).run();
    const base = mockPasses();
    const paidAnalysts = vi.fn(base.passes.runBullThenBear);
    const paidJudge = vi.fn(base.passes.runJudgePass);
    const paidVerify = vi.fn(base.passes.runVerifyPass);

    const result = await runJob(
      jobId,
      {
        ...base.passes,
        fingerprintPayload: () => "1.3.0:report-after-prepare",
        runBullThenBear: paidAnalysts,
        runJudgePass: paidJudge,
        runVerifyPass: paidVerify,
      },
      { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW, resume: true },
    );

    expect(result).toMatchObject({
      status: "done",
      reportId: danglingReportId,
      verificationRate: 0.75,
    });
    expect(paidAnalysts).not.toHaveBeenCalled();
    expect(paidJudge).not.toHaveBeenCalled();
    expect(paidVerify).not.toHaveBeenCalled();
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
      status: "done",
      runGeneration: 1,
      reportId: danglingReportId,
    });
  });

  it("direct settlement invalidates the canonical snapshot exactly once", () => {
    const { jobId } = createJob("AAPL");
    const before = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    const input = {
      jobId,
      runGeneration: 0,
      attemptId: "direct-revision-invalidation",
      pass: "bull" as const,
      settlement: testSuccessSettlement(testAnalystPass("bull", 0.25)),
      payloadFingerprint: "1.3.0:direct-revision",
      settledAt: NOW().toISOString(),
    };

    expect(persistPassSettlement(input)).toMatchObject({ inserted: true });
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
      revision: before.revision + 1,
      stepsJson: before.stepsJson,
    });
    expect(getJobSnapshot(jobId)).toMatchObject({
      revision: before.revision + 1,
      totalCostUsd: 0.25,
    });

    expect(persistPassSettlement(input)).toMatchObject({ inserted: false });
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.revision)
      .toBe(before.revision + 1);
    expect(handle.db.select().from(jobPassArtifacts).where(eq(jobPassArtifacts.jobId, jobId)).all())
      .toHaveLength(1);
    expect(handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all())
      .toHaveLength(1);
  });

  it("artifact settlement in the prepare-to-claim window loses the exact source-state CAS", () => {
    const { jobId } = createJob("AAPL");
    seedResumableLegacyJob(jobId, "error");
    const prepared = prepareJobResume(jobId, "error");
    expect(prepared).not.toBeNull();

    persistPassSettlement({
      jobId,
      runGeneration: 0,
      attemptId: "late-source-settlement",
      pass: "synthesize",
      settlement: {
        outcome: "failure",
        failure: { name: "Error", message: "late source failure" },
        telemetry: testTelemetry({
          data: fakeJudgeOutput(),
          model: "local-unbilled",
          costUsd: 0,
          fallbackUsed: false,
        }, false),
      },
      payloadFingerprint: "1.3.0:seeded",
      settledAt: NOW().toISOString(),
    });

    expect(claimPreparedJobResume(prepared!)).toBe(false);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
      status: "error",
      runGeneration: 0,
    });
  });

  it("prepared resume rejects reusable-plan mutation before the exact claim", () => {
    const { jobId } = createJob("AAPL");
    seedResumableLegacyJob(jobId, "error", "1.3.0:immutable");
    const prepared = prepareJobResume(jobId, "error");
    expect(prepared).not.toBeNull();
    prepared!.payloadFingerprint = null;

    expect(claimPreparedJobResume(prepared!)).toBe(false);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
      status: "error",
      runGeneration: 0,
    });
  });

  it("scheduler-preclaimed retry rederives durable analysts without retaining a strong process cache", async () => {
    const { jobId } = createJob("AAPL");
    seedResumableLegacyJob(jobId, "error", "1.3.0:immutable");
    const prepared = prepareJobResume(jobId, "error");
    expect(prepared).not.toBeNull();
    expect(claimPreparedJobResume(prepared!)).toBe(true);
    const claim = claimNextQueuedJob(
      "production-shaped-retry",
      undefined,
      configuredSchedulerLimits(),
      handle.db,
    );
    expect(claim).not.toBeNull();
    expect((globalThis as typeof globalThis & { __thesisPreparedJobResumes?: unknown })
      .__thesisPreparedJobResumes).toBeUndefined();

    prepared!.bull!.data.thesis[0]!.text = "MUTATED AFTER CLAIM";
    prepared!.payloadFingerprint = null;
    const base = mockPasses();
    let observedBullText = "";
    const result = await runJob(
      jobId,
      {
        ...base.passes,
        fingerprintPayload: () => "1.3.0:immutable",
        runBullThenBear: async () => {
          throw new Error("preclaimed resume must reuse analysts");
        },
        runJudgePass: async (deps, bull, bear, feedback, settlement) => {
          observedBullText = bull.data.thesis[0]?.text ?? "";
          return base.passes.runJudgePass(deps, bull, bear, feedback, settlement);
        },
      },
      { bundle: fakeBundle(), claim: claim!, hasAnthropicKey: true, now: NOW, resume: true },
    );

    expect(result.status).toBe("done");
    expect(observedBullText).toBe("t");
  });

  it("duplicate replay of an earlier judge attempt cannot regress a later success", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const verifyEntered = deferred();
    const releaseVerify = deferred();
    let attempt = 0;
    let firstHook: TestSettlementHook<JudgeOutput> | undefined;
    const firstFailure: TestSettlement<JudgeOutput> = {
      outcome: "failure",
      failure: { name: "Error", message: "schema-invalid first judge", kind: "schema" },
      telemetry: {
        model: "claude-opus-4-8",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        webSearches: 0,
        costUsd: 0.12,
        fallbackUsed: false,
        billable: true,
        fetchedUrls: [],
      },
    };
    const passes: PipelinePasses = {
      ...base.passes,
      runJudgePass: async (deps, bull, bear, feedback, settlement) => {
        attempt += 1;
        if (!settlement) throw new Error("missing judge settlement hook");
        if (attempt === 1) {
          firstHook = settlement;
          await settlement(firstFailure);
          throw new Error("schema-invalid first judge");
        }
        const success = await base.passes.runJudgePass(deps, bull, bear, feedback);
        await settlement(testSuccessSettlement(success));
        return success;
      },
      runVerifyPass: async (...args) => {
        verifyEntered.resolve(undefined);
        await releaseVerify.promise;
        return base.passes.runVerifyPass(...args);
      },
    };
    const running = runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    });
    await verifyEntered.promise;
    expect(firstHook).toBeTypeOf("function");
    const events: JobEvent[] = [];
    const unsubscribe = subscribeJob(jobId, (event) => events.push(event));
    try {
      await firstHook!(firstFailure);
      const steps = JSON.parse(
        handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!.stepsJson,
      ) as StepProgress[];
      expect(steps.find((step) => step.step === "synthesize")?.status).toBe("done");
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
      releaseVerify.resolve(undefined);
      await running.catch(() => undefined);
    }
  });

  it("duplicate replay of an earlier judge attempt is a no-op while its retry is running", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const secondEntered = deferred();
    const releaseSecond = deferred();
    let attempt = 0;
    let firstHook: TestSettlementHook<JudgeOutput> | undefined;
    const firstFailure: TestSettlement<JudgeOutput> = {
      outcome: "failure",
      failure: { name: "Error", message: "schema-invalid first judge", kind: "schema" },
      telemetry: {
        model: "claude-opus-4-8",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        webSearches: 0,
        costUsd: 0.12,
        fallbackUsed: false,
        billable: true,
        fetchedUrls: [],
      },
    };
    const passes: PipelinePasses = {
      ...base.passes,
      runJudgePass: async (deps, bull, bear, feedback, settlement) => {
        attempt += 1;
        if (!settlement) throw new Error("missing judge settlement hook");
        if (attempt === 1) {
          firstHook = settlement;
          await settlement(firstFailure);
          throw new Error("schema-invalid first judge");
        }
        secondEntered.resolve(undefined);
        await releaseSecond.promise;
        const success = await base.passes.runJudgePass(deps, bull, bear, feedback);
        await settlement(testSuccessSettlement(success));
        return success;
      },
    };
    const running = runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    });

    await secondEntered.promise;
    expect(firstHook).toBeTypeOf("function");
    const before = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    const beforeSteps = JSON.parse(before.stepsJson) as StepProgress[];
    expect(beforeSteps.find((step) => step.step === "synthesize")?.status).toBe("running");
    const beforeArtifacts = handle.db
      .select()
      .from(jobPassArtifacts)
      .where(eq(jobPassArtifacts.jobId, jobId))
      .all();
    const beforeCosts = handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all();
    const events: JobEvent[] = [];
    const unsubscribe = subscribeJob(jobId, (event) => events.push(event));
    try {
      await firstHook!(firstFailure);
      const after = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
      expect(after).toMatchObject({
        stepsJson: before.stepsJson,
        revision: before.revision,
        updatedAt: before.updatedAt,
      });
      expect(events).toEqual([]);
      expect(
        handle.db.select().from(jobPassArtifacts).where(eq(jobPassArtifacts.jobId, jobId)).all(),
      ).toHaveLength(beforeArtifacts.length);
      expect(handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all()).toHaveLength(
        beforeCosts.length,
      );
    } finally {
      unsubscribe();
      releaseSecond.resolve(undefined);
      await running.catch(() => undefined);
    }
  });

  it("current same-pass failure suppresses only that analyst legacy fallback", () => {
    const { jobId } = createJob("AAPL");
    seedResumableLegacyJob(jobId, "error", "1.3.0:same-pass");
    persistPassSettlement({
      jobId,
      runGeneration: 0,
      attemptId: "current-bull-failure",
      pass: "bull",
      settlement: {
        outcome: "failure",
        failure: { name: "Error", message: "current bull failed" },
        telemetry: testTelemetry(testAnalystPass("bull", 0), false),
      },
      payloadFingerprint: "1.3.0:same-pass",
      settledAt: NOW().toISOString(),
    });

    const prepared = prepareJobResume(jobId, "error");
    expect(prepared).not.toBeNull();
    expect(prepared?.bull).toBeNull();
    expect(prepared?.bear?.data).toEqual(fakeAnalystCase());
  });

  it("strict artifact parser rejects unknown versions and fields", () => {
    expect(DURABLE_PASSES).toEqual(["bull", "bear", "synthesize", "verify"]);
    const valid = {
      artifactVersion: PASS_ARTIFACT_ENVELOPE_VERSION,
      outcome: "success",
      data: fakeAnalystCase(),
      payloadFingerprint: "1.3.0:strict",
    } as const;
    expect(parsePassArtifactEnvelope("bull", valid)).toMatchObject(valid);
    expect(() => parsePassArtifactEnvelope("bull", { ...valid, artifactVersion: 2 })).toThrow(
      /version/i,
    );
    expect(() => parsePassArtifactEnvelope("bull", { ...valid, extra: true })).toThrow(
      /unexpected/i,
    );
  });

  it("strict artifact reader rejects mismatched cost metadata and missing ledger pairs", () => {
    const { jobId } = createJob("AAPL");
    const attemptId = "strict-cost-pair";
    const pass = testAnalystPass("bull");
    persistPassSettlement({
      jobId,
      runGeneration: 0,
      attemptId,
      pass: "bull",
      settlement: testSuccessSettlement(pass),
      payloadFingerprint: "1.3.0:strict-cost",
      settledAt: NOW().toISOString(),
    });
    const artifact = handle.db
      .select()
      .from(jobPassArtifacts)
      .where(eq(jobPassArtifacts.attemptId, attemptId))
      .get()!;
    const cost = JSON.parse(artifact.costJson) as Record<string, unknown>;
    handle.db
      .update(jobPassArtifacts)
      .set({ costJson: JSON.stringify({ ...cost, costUsd: pass.costUsd + 1 }) })
      .where(eq(jobPassArtifacts.attemptId, attemptId))
      .run();
    expect(() => readCurrentGenerationPassArtifacts(jobId)).toThrow(/telemetry.*cost/i);

    handle.db
      .update(jobPassArtifacts)
      .set({ costJson: artifact.costJson })
      .where(eq(jobPassArtifacts.attemptId, attemptId))
      .run();
    handle.db.delete(costLog).where(eq(costLog.attemptId, attemptId)).run();
    expect(() => readCurrentGenerationPassArtifacts(jobId)).toThrow(/cost pair/i);
  });
});

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
    expect(row?.queuedAt).toBe(row?.createdAt);
    expect(row?.maxCostUsd).toBeNull();
    const steps = JSON.parse(row?.stepsJson ?? "[]") as StepProgress[];
    expect(steps.map((s) => s.step)).toEqual([...PIPELINE_STEPS]);
    expect(steps.every((s) => s.status === "pending")).toBe(true);
  });

  it("snapshots the configured per-job cost cap when the fresh enqueue commits", () => {
    const current = configMocks.getConfig();
    configMocks.getConfig.mockReturnValueOnce({ ...current, maxJobCostUsd: 12.345678 });

    const { jobId } = createJob("COST");
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
      status: "queued",
      maxCostUsd: 12.345678,
    });
  });

  it("reconciles an expired same-symbol claim and enqueues its successor in one writer transaction", () => {
    vi.useFakeTimers();
    const beforeExpiry = new Date("2026-08-08T12:00:00.000Z");
    const afterExpiry = new Date("2026-08-08T12:00:01.000Z");
    vi.setSystemTime(beforeExpiry);
    const { jobId: expiredJobId } = createJob("AAPL");
    handle.db
      .update(jobs)
      .set({
        status: "running",
        leaseOwner: "expiring-post-owner",
        heartbeatAt: beforeExpiry.toISOString(),
        leaseExpiresAt: new Date(beforeExpiry.getTime() + 500).toISOString(),
      })
      .where(eq(jobs.id, expiredJobId))
      .run();
    const transactionSpy = vi.spyOn(handle.db, "transaction");

    const admitted = getOrCreateJobForSymbol("AAPL", { now: () => afterExpiry });

    expect(admitted).toMatchObject({ existing: false });
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, expiredJobId)).get()).toMatchObject({
      status: "error",
      leaseOwner: null,
      error: expect.stringMatching(/lease expired/i),
    });
    expect(handle.db.select().from(jobs).where(eq(jobs.id, admitted.jobId)).get()).toMatchObject({
      status: "queued",
      symbol: "AAPL",
    });
  });

  it("reuses an exact-live same-symbol claim from the atomic admission transaction", () => {
    vi.useFakeTimers();
    const authority = new Date("2026-08-08T12:00:00.000Z");
    vi.setSystemTime(authority);
    const { jobId } = createJob("AAPL");
    handle.db
      .update(jobs)
      .set({
        status: "running",
        leaseOwner: "live-post-owner",
        heartbeatAt: authority.toISOString(),
        leaseExpiresAt: new Date(authority.getTime() + 60_000).toISOString(),
      })
      .where(eq(jobs.id, jobId))
      .run();
    const transactionSpy = vi.spyOn(handle.db, "transaction");

    expect(getOrCreateJobForSymbol("AAPL", { now: () => authority })).toEqual({
      jobId,
      existing: true,
      status: "running",
      updatedAt: authority.toISOString(),
    });
    expect(transactionSpy).toHaveBeenCalledTimes(1);
  });

  it("isSymbolJobActive detects a queued/running job and clears when done", async () => {
    const { jobId } = createJob("AAPL");
    expect(isSymbolJobActive("aapl")).toBe(true);
    // Force to done so it is no longer active.
    handle.db.update(jobs).set({ status: "done" }).where(eq(jobs.id, jobId)).run();
    expect(isSymbolJobActive("AAPL")).toBe(false);
  });

  it("returns queued jobs regardless of age and reconciles only expired running leases", () => {
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
      .set({
        status: "running",
        updatedAt: staleUpdatedAt,
        error: null,
        leaseOwner: "expired:owner",
        heartbeatAt: staleUpdatedAt,
        leaseExpiresAt: freshNow.toISOString(),
      })
      .where(eq(jobs.id, jobId))
      .run();

    expect(getReusableActiveJobForSymbol("AAPL", freshNow)).toBeNull();
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.status).toBe("running");
    expect(sweepAbandonedJobs(freshNow)).toBe(1);
    const expired = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(expired?.status).toBe("error");
    expect(expired?.error).toContain("durable job lease expired");
  });

  it("sweepAbandonedJobs ignores queued age and reconciles expired running leases across symbols", () => {
    const now = new Date("2026-07-09T12:00:00.000Z");
    const staleIso = new Date(now.getTime() - ACTIVE_JOB_STALE_MS - 1000).toISOString();
    const freshIso = new Date(now.getTime() - 60_000).toISOString();

    // Orphaned running job for a symbol nobody re-runs (the audit's PYPL case).
    const { jobId: orphan } = createJob("PYPL");
    handle.db.update(jobs).set({
      status: "running",
      updatedAt: freshIso,
      leaseOwner: "expired:owner",
      heartbeatAt: freshIso,
      leaseExpiresAt: now.toISOString(),
    }).where(eq(jobs.id, orphan)).run();
    // Stale queued job for another symbol.
    const { jobId: staleQueued } = createJob("MSFT");
    handle.db.update(jobs).set({ updatedAt: staleIso }).where(eq(jobs.id, staleQueued)).run();
    // Fresh running job — must NOT be touched.
    const { jobId: live } = createJob("AAPL");
    handle.db.update(jobs).set({
      status: "running",
      updatedAt: staleIso,
      leaseOwner: "live:owner",
      heartbeatAt: freshIso,
      leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
    }).where(eq(jobs.id, live)).run();
    // Terminal job — must NOT be touched.
    const { jobId: done } = createJob("INTU");
    handle.db.update(jobs).set({ status: "done", updatedAt: staleIso }).where(eq(jobs.id, done)).run();

    const changed = sweepAbandonedJobs(now);
    expect(changed).toBe(1);

    const orphanRow = handle.db.select().from(jobs).where(eq(jobs.id, orphan)).get();
    expect(orphanRow?.status).toBe("error");
    expect(orphanRow?.error).toContain("durable job lease expired");
    expect(handle.db.select().from(jobs).where(eq(jobs.id, staleQueued)).get()?.status).toBe("queued");
    expect(handle.db.select().from(jobs).where(eq(jobs.id, live)).get()?.status).toBe("running");
    expect(handle.db.select().from(jobs).where(eq(jobs.id, done)).get()?.status).toBe("done");
  });

  // Sweep step normalization is display metadata only; durable artifacts, not
  // these words, decide whether the swept job can resume.
  it("sweepAbandonedJobs normalizes a mid-synthesize crash for display", () => {
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
        leaseOwner: "expired:owner",
        heartbeatAt: staleIso,
        leaseExpiresAt: now.toISOString(),
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

  });

  it("sweepAbandonedJobs leaves malformed stepsJson untouched but still un-wedges the row", () => {
    const now = new Date("2026-07-09T12:00:00.000Z");
    const staleIso = new Date(now.getTime() - ACTIVE_JOB_STALE_MS - 1000).toISOString();
    const { jobId } = createJob("CORRUPT");
    handle.db
      .update(jobs)
      .set({
        status: "running",
        updatedAt: staleIso,
        leaseOwner: "expired:owner",
        heartbeatAt: staleIso,
        leaseExpiresAt: now.toISOString(),
        stepsJson: "{not json",
      })
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

  it("rolls back report persistence when a postcharge revision jump reaches MAX_SAFE", async () => {
    const { jobId } = createJob("AAPL");
    const base = mockPasses();
    const originalVerify = base.passes.runVerifyPass.bind(base.passes);
    const passes: PipelinePasses = {
      ...base.passes,
      runVerifyPass: async (deps, judge, evidence, settlement) => {
        const verified = await originalVerify(deps, judge, evidence);
        if (!settlement) throw new Error("missing verify settlement hook");
        await settlement(testSuccessSettlement({
          data: verified.verifiedReport,
          model: verified.model ?? "deterministic",
          costUsd: verified.costUsd ?? 0,
          fallbackUsed: verified.fallbackUsed ?? false,
          usage: verified.usage,
        }));
        handle.db.update(jobs).set({ revision: Number.MAX_SAFE_INTEGER })
          .where(eq(jobs.id, jobId)).run();
        return verified;
      },
    };

    await expect(runJob(jobId, passes, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: true,
      now: NOW,
    })).rejects.toThrow(/safe|overflow|revision/i);

    expect(handle.db.select().from(reports).all()).toEqual([]);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
      status: "running",
      reportId: null,
      revision: Number.MAX_SAFE_INTEGER,
    });
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

  it("captures one coherent model/effort revision before asynchronous model resolution", async () => {
    setSetting("analysisModel", "claude-fable-5");
    setSetting("analysisEffort", "medium");
    const resolution = deferred<Awaited<ReturnType<typeof resolveModel>>>();
    resolveModelMock.mockImplementationOnce(() => resolution.promise);
    const captured: Array<{ analysisModel: string; effort: string | undefined }> = [];
    const { jobId } = createJob("AAPL");
    const { passes } = mockPasses();
    const original = passes.runBullThenBear;
    passes.runBullThenBear = async (deps, hooks, settlements) => {
      captured.push({ analysisModel: deps.analysisModel, effort: deps.effort });
      return original(deps, hooks, settlements);
    };

    const running = runJob(jobId, passes, {
      bundle: fakeBundle(),
      hasAnthropicKey: true,
      now: NOW,
    });
    await vi.waitFor(() => {
      expect(resolveModelMock).toHaveBeenCalledWith("claude-fable-5");
    });

    setSetting("analysisModel", "claude-sonnet-5");
    setSetting("analysisEffort", "max");
    resolution.resolve({
      model: "claude-fable-5",
      resolvedFrom: "explicit",
    });
    await running;

    expect(captured).toEqual([{ analysisModel: "claude-fable-5", effort: "medium" }]);
  });

  it("reads the writable pair through one snapshot API and never through split legacy getters", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "pipeline", "jobRunner.ts"),
      "utf8",
    );
    expect(source).toContain("getWritableSettingsAuthority(");
    expect(source.match(/getWritableSettingsAuthority\(/g)).toHaveLength(1);
    expect(source).not.toContain("getAnalysisModelSetting");
    expect(source).not.toContain("getAnalysisEffortSetting");
  });

  // WS7 (D-20), 2026-09 review — BLOCKER 1, on the PRIMARY (verify-succeeded)
  // path, which is the path a normal run takes.
  it("completes the judgement protocol's model families from the runner's own execution list", async () => {
    const { jobId } = createJob("AAPL");
    const { passes: base } = mockPasses();
    const judge = fakeJudgeOutput();
    // Exactly what Stage C's verify path stores: the protocol the judge pass
    // recorded, completed with the families the (empty) cost entries named —
    // i.e. "not shared", both families null, and no manifest entry for it.
    const stored = completeJudgeProtocol(
      {
        setting: "random",
        order: "bull-first",
        seed: jobId,
        bull: { chars: 10, originalChars: 10, capChars: 24_000, truncated: false, droppedItems: 0, caseStrength: 4 },
        bear: { chars: 12, originalChars: 12, capChars: 24_000, truncated: false, droppedItems: 0, caseStrength: 3 },
        disclosures: [],
      },
      sharedModelFamilyOf([]),
    );
    expect(stored.sharedModelFamily).toEqual({
      shared: false,
      analystFamily: null,
      judgeFamily: null,
    });
    const unstamped: Report = {
      ...fakeReport(judge),
      meta: { ...fakeReport(judge).meta, judgeProtocol: stored },
    };
    const passes: PipelinePasses = {
      ...base,
      runVerifyPass: async (...raw: unknown[]) => {
        const beforeProviderLaunch = raw[4] as (() => void | Promise<void>) | undefined;
        await beforeProviderLaunch?.();
        return {
          verifiedReport: unstamped,
          verificationRate: 1,
          costUsd: 0.2,
          model: "claude-opus-4-8",
          fallbackUsed: false,
          log: [],
        };
      },
    };

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: true,
      now: NOW,
    });
    expect(result.status).toBe("done");

    const persisted = ReportSchema.parse(
      JSON.parse(
        handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get()!.reportJson!,
      ),
    );
    // All three passes ran on claude-opus-4-8, so the judge graded its own
    // family's output. Every surface has to say so.
    expect(persisted.meta.judgeProtocol?.sharedModelFamily).toEqual({
      shared: true,
      analystFamily: "opus",
      judgeFamily: "opus",
    });
    expect(persisted.meta.judgeProtocol?.note).toContain("grading output from its own family");
    expect(
      persisted.meta.execution?.find((entry) => entry.step === "synthesize")?.note,
    ).toContain("rather than acting as an independent second opinion");
    const warning = persisted.appendix.missingData.find(
      (entry) => entry.field === "llm.judge.model-family",
    );
    expect(warning?.severity).toBe("warn");
    expect(warning?.reason).toContain("not independent");
    // The per-side facts the judge pass DID record survive the re-stamp.
    expect(persisted.meta.judgeProtocol?.bull?.caseStrength).toBe(4);
    expect(persisted.meta.judgeProtocol?.bear?.caseStrength).toBe(3);
    // Adding that manifest entry must not leave the completeness metadata
    // describing the manifest it had before.
    const completeness = deriveReportCompletenessPresentation(
      persisted.meta.dataCompleteness,
      persisted.appendix.missingData,
    );
    expect(completeness.metadataStatus).toBe("confirmed");
  });
});

/* ------------------------------------------------------------------------ *
 * runJob — no-key degraded path
 * ------------------------------------------------------------------------ */

describe("runJob — no-key degraded path", () => {
  it("persists a data-only report with real source envelopes", async () => {
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
      expect(parsed.data.appendix.sources).toContainEqual({
        provider: "fmp",
        endpoint: "/stable/treasury-rates",
        asOf: "2026-07-04",
        fetchedAt: "2026-07-05T18:30:00.000Z",
        stale: true,
      });
      expect(parsed.data.appendix.sources).not.toContainEqual(
        expect.objectContaining({ provider: "fred", endpoint: "treasury" }),
      );
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
    passes.runBullThenBear = async (_deps, hooks) => {
      await launchTestAnalystSide(hooks, "bull");
      await launchTestAnalystSide(hooks, "bear");
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
    if (parsed.success) {
      const analysisGaps = parsed.data.appendix.missingData.filter(
        (gap) => gap.field === "analysis.llm" || gap.field === "llm.bull" || gap.field === "llm.bear",
      );
      expect(analysisGaps.map((gap) => gap.field).sort()).toEqual([
        "analysis.llm",
        "llm.bear",
        "llm.bull",
      ]);
      expect(analysisGaps.every((gap) => gap.attemptedSources?.includes("anthropic"))).toBe(true);
    }
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
    passes.runBullThenBear = async (_deps, hooks) => {
      await launchTestAnalystSide(hooks, "bull");
      await launchTestAnalystSide(hooks, "bear");
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
    expect(
      handle.db.select().from(jobPassArtifacts).where(eq(jobPassArtifacts.jobId, jobId)).all()
        .filter((row) => row.pass === "verify"),
    ).toEqual([]);
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

  /**
   * D-02: a stored model id the registry refuses is a NAMED cause, not a
   * transport accident, and the data-only report has to say so — the step
   * detail is transient UI, the report is the durable record.
   */
  it("discloses a rejected analysis model as a model-rejected execution adjustment", async () => {
    vi.stubEnv("ANALYSIS_MODEL", "claude-opus-5-20260115");
    const { jobId } = createJob("AAPL");
    const { passes, calls } = mockPasses();
    resolveModelMock.mockRejectedValue(
      new Error(explainAnalysisModel("claude-opus-5-20260115") ?? "rejected"),
    );

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: true,
      now: NOW,
    });

    expect(result).toMatchObject({ status: "done", dataOnly: true });
    expect(calls).toEqual([]);
    const repRow = handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get();
    const parsed = ReportSchema.parse(JSON.parse(repRow?.reportJson ?? "{}"));
    expect(parsed.meta.execution).toEqual(LLM_STEPS.map((step) => ({
      step,
      requestedModel: "claude-opus-5-20260115",
      effectiveModel: "none",
      requestedEffort: "high",
      effectiveEffort: null,
      fallbackUsed: false,
      adjustments: ["model-rejected"],
      note: expect.stringContaining("dated snapshot ids do not exist"),
    })));
  });

  it("leaves execution metadata off a transport-failed resolution, which is not a rejection", async () => {
    vi.stubEnv("ANALYSIS_MODEL", ""); // empty env = unset, whatever the host holds
    const { jobId } = createJob("AAPL");
    const { passes } = mockPasses();
    resolveModelMock.mockRejectedValue(new Error("503 models.list() transport error"));

    const result = await runJob(jobId, passes, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: true,
      now: NOW,
    });

    const repRow = handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get();
    const parsed = ReportSchema.parse(JSON.parse(repRow?.reportJson ?? "{}"));
    expect(parsed.meta.execution).toBeUndefined();
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
    const synthCosts = costRows.filter((r) => r.step === "synthesize");
    expect(synthCosts).toHaveLength(3);
    const synthArtifacts = readCurrentGenerationPassArtifacts(jobId).filter(
      (artifact) => artifact.pass === "synthesize",
    );
    expect(synthArtifacts).toHaveLength(3);
    expect(new Set(synthArtifacts.map((artifact) => artifact.attemptId)).size).toBe(3);
    expect(new Set(synthCosts.map((row) => row.attemptId))).toEqual(
      new Set(synthArtifacts.map((artifact) => artifact.attemptId)),
    );
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
    expect(byStep.get("verify")?.status).toBe("error");
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

  it("clamps an oversized judge retry override to the audited production maximum", async () => {
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
      maxJudgeRetries: MAX_JUDGE_RETRIES + 3,
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
        await launchTestAnalystSide(hooks, "bull");
        await sleep(5);
        hooks?.onPassFinish?.("bull");
        await launchTestAnalystSide(hooks, "bear");
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
      fingerprintPayload: () => "fp-v1",
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
    handle.db.update(jobs).set({ reportId: null }).where(eq(jobs.id, jobId)).run();

    // Retry with a healthy judge: bull/bear must NOT run again.
    const second = mockPasses();
    const resumeCalls: string[] = [];
    const resumePasses: PipelinePasses = {
      ...second.passes,
      fingerprintPayload: () => "fp-v1",
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

  it("rejects payload drift before any resumed paid pass", async () => {
    const { jobId } = createJob("AAPL");
    const first = failingJudgePasses();
    await runJob(
      jobId,
      { ...first.passes, fingerprintPayload: () => "fp-v1" },
      { bundle: fakeBundle("AAPL"), hasAnthropicKey: true, now: NOW },
    );
    handle.db.update(jobs).set({ reportId: null }).where(eq(jobs.id, jobId)).run();

    // Force the assembleReport path (verify throws) and record the computed
    // gaps the runner hands it — the drift gap must be among them.
    const second = mockPasses();
    await expect(
      runJob(
        jobId,
        { ...second.passes, fingerprintPayload: () => "fp-v2-DRIFTED" },
        { bundle: fakeBundle("AAPL"), hasAnthropicKey: true, now: NOW, resume: true },
      ),
    ).rejects.toThrow(/not resumable|fingerprint mismatch|start a fresh job/i);
    expect(second.calls).toEqual(["assembleContextPayload"]);
    expect(
      handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all(),
    ).toHaveLength(2);
  });

  it.each([
    {
      label: "stored provenance is unknown but the rebuilt payload is fingerprinted",
      storedFingerprint: null,
      rebuiltFingerprint: "fp-v1-known",
    },
    {
      label: "stored provenance is fingerprinted but the rebuilt payload is unknown",
      storedFingerprint: "fp-v1-known",
      rebuiltFingerprint: null,
    },
  ])("rejects $label before any resumed paid pass", async ({
    storedFingerprint,
    rebuiltFingerprint,
  }) => {
    const { jobId } = createJob("AAPL");
    seedResumableLegacyJob(jobId, "error", storedFingerprint ?? "temporary-fingerprint");
    if (storedFingerprint === null) {
      handle.db
        .update(jobs)
        .set({ payloadFingerprint: null })
        .where(eq(jobs.id, jobId))
        .run();
    }

    const base = mockPasses();
    const paidAnalysts = vi.fn(base.passes.runBullThenBear);
    const paidJudge = vi.fn(base.passes.runJudgePass);
    const resumePasses: PipelinePasses = {
      ...base.passes,
      fingerprintPayload: rebuiltFingerprint === null
        ? undefined
        : () => rebuiltFingerprint,
      runBullThenBear: paidAnalysts,
      runJudgePass: paidJudge,
    };

    await expect(
      runJob(jobId, resumePasses, {
        bundle: fakeBundle("AAPL"),
        hasAnthropicKey: true,
        now: NOW,
        resume: true,
      }),
    ).rejects.toThrow(/not resumable|fingerprint mismatch|start a fresh job/i);
    expect(paidAnalysts).not.toHaveBeenCalled();
    expect(paidJudge).not.toHaveBeenCalled();
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
        runBullThenBear: async (_deps, hooks) => {
          await launchTestAnalystSide(hooks, "bull");
          await launchTestAnalystSide(hooks, "bear");
          throw firstError;
        },
      },
      { bundle: fakeBundle("AAPL"), hasAnthropicKey: true, now: NOW },
    );
    handle.db.update(jobs).set({ reportId: null }).where(eq(jobs.id, jobId)).run();
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
        fingerprintPayload: () => "fp-v1",
        runBullThenBear: async (_deps, hooks) => {
          await launchTestAnalystSide(hooks, "bull");
          await launchTestAnalystSide(hooks, "bear");
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
    handle.db.update(jobs).set({ reportId: null }).where(eq(jobs.id, jobId)).run();

    const second = mockPasses();
    const result = await runJob(
      jobId,
      {
        ...second.passes,
        fingerprintPayload: () => "fp-v1",
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

    // A terminal job must never report a live step. `markSkipped` only moves a
    // PENDING step, so a pass that failed while RUNNING used to stay "running"
    // on a job the client had been told was done, with no way out of that state
    // in the UI. persistDataOnly sweeps every non-terminal LLM step.
    for (const step of ["bull", "bear", "synthesize", "verify"] as const) {
      expect(byStep.get(step)?.status, step).not.toBe("running");
      expect(byStep.get(step)?.status, step).not.toBe("pending");
    }

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
  describe("durable resume authority", () => {
    function markTerminal(jobId: string, status: "done" | "error" = "error"): void {
      handle.db
        .update(jobs)
        .set({ status, reportId: null, error: status === "error" ? "fixture terminal" : null })
        .where(eq(jobs.id, jobId))
        .run();
    }

    it("reports a dangling report link while preserving reusable analyst work", () => {
      const { jobId } = createJob("AAPL");
      seedResumableLegacyJob(jobId, "error", "1.3.0:dangling");
      handle.sqlite.pragma("foreign_keys = OFF");
      handle.sqlite.prepare("UPDATE jobs SET reportId = 999999 WHERE id = ?").run(jobId);
      handle.sqlite.pragma("foreign_keys = ON");

      expect(readJobResumeState(jobId)).toEqual({
        resumable: true,
        reusablePasses: ["bull", "bear"],
        rerunPasses: ["synthesize", "verify"],
        reason: "dangling report link; reusable analyst work is available",
      });
    });

    it("reuses a schema-valid synthesize success and reruns only verify", () => {
      const { jobId } = createJob("AAPL");
      persistPassSettlement({
        jobId,
        runGeneration: 0,
        attemptId: "resume-synthesize",
        pass: "synthesize",
        settlement: testSuccessSettlement({
          data: fakeJudgeOutput(),
          model: "claude-opus-4-8",
          costUsd: 0.4,
          fallbackUsed: false,
        }),
        payloadFingerprint: "1.3.0:tail",
        settledAt: NOW().toISOString(),
      });
      markTerminal(jobId);

      expect(readJobResumeState(jobId)).toEqual({
        resumable: true,
        reusablePasses: ["synthesize"],
        rerunPasses: ["verify"],
        reason: "reusable synthesize work is available",
      });
    });

    it("reuses a schema-valid verify success and reruns no paid pass", () => {
      const { jobId } = createJob("AAPL");
      persistPassSettlement({
        jobId,
        runGeneration: 0,
        attemptId: "resume-verify",
        pass: "verify",
        settlement: testSuccessSettlement({
          data: fakeReport(fakeJudgeOutput()),
          model: "deterministic",
          costUsd: 0,
          fallbackUsed: false,
        }, false),
        payloadFingerprint: "1.3.0:tail",
        settledAt: NOW().toISOString(),
      });
      markTerminal(jobId);

      expect(readJobResumeState(jobId)).toEqual({
        resumable: true,
        reusablePasses: ["verify"],
        rerunPasses: [],
        reason: "reusable verified report is available",
      });
    });

    it.each(["failure", "malformed"] as const)(
      "current bull %s suppresses matching legacy bull but leaves legacy bear reusable",
      (kind) => {
        const { jobId } = createJob("AAPL");
        seedResumableLegacyJob(jobId, "error", "1.3.0:per-pass");
        persistPassSettlement({
          jobId,
          runGeneration: 0,
          attemptId: `current-bull-${kind}`,
          pass: "bull",
          settlement: {
            outcome: "failure",
            failure: { name: "Error", message: "current bull unavailable" },
            telemetry: testTelemetry(testAnalystPass("bull", 0), false),
          },
          payloadFingerprint: "1.3.0:per-pass",
          settledAt: NOW().toISOString(),
        });
        if (kind === "malformed") {
          handle.db
            .update(jobPassArtifacts)
            .set({ outcomeJson: "{malformed" })
            .where(eq(jobPassArtifacts.attemptId, `current-bull-${kind}`))
            .run();
        }

        expect(readJobResumeState(jobId)).toEqual({
          resumable: true,
          reusablePasses: ["bear"],
          rerunPasses: ["bull", "synthesize", "verify"],
          reason: "reusable analyst work is available",
        });
      },
    );

    it("does not combine current bull fpA with legacy bear fpB", () => {
      const { jobId } = createJob("AAPL");
      seedResumableLegacyJob(jobId, "error", "fpB");
      persistPassSettlement({
        jobId,
        runGeneration: 0,
        attemptId: "current-bull-fpA",
        pass: "bull",
        settlement: testSuccessSettlement(testAnalystPass("bull")),
        payloadFingerprint: "fpA",
        settledAt: NOW().toISOString(),
      });
      handle.db
        .update(jobs)
        .set({
          bearJson: JSON.stringify(testAnalystPass("bear")),
          payloadFingerprint: "fpB",
        })
        .where(eq(jobs.id, jobId))
        .run();

      expect(readJobResumeState(jobId)).toMatchObject({
        resumable: true,
        reusablePasses: ["bull"],
        rerunPasses: ["bear", "synthesize", "verify"],
      });
    });

    it("treats current bull and bear successes from different fingerprints as cohort corruption", () => {
      const { jobId } = createJob("AAPL");
      for (const [side, fingerprint] of [["bull", "fpA"], ["bear", "fpB"]] as const) {
        persistPassSettlement({
          jobId,
          runGeneration: 0,
          attemptId: `current-${side}-${fingerprint}`,
          pass: side,
          settlement: testSuccessSettlement(testAnalystPass(side)),
          payloadFingerprint: fingerprint,
          settledAt: NOW().toISOString(),
        });
      }
      markTerminal(jobId);

      expect(readJobResumeState(jobId)).toMatchObject({
        resumable: false,
        reusablePasses: [],
        rerunPasses: [],
      });
    });

    it("ignores malformed stepsJson when durable legacy analysts are coherent", () => {
      const { jobId } = createJob("AAPL");
      seedResumableLegacyJob(jobId, "error", "1.3.0:malformed-steps");
      handle.db.update(jobs).set({ stepsJson: "{malformed" }).where(eq(jobs.id, jobId)).run();

      expect(readJobResumeState(jobId)).toMatchObject({
        resumable: true,
        reusablePasses: ["bull", "bear"],
        rerunPasses: ["synthesize", "verify"],
      });
      expect(prepareJobResume(jobId, "error")).not.toBeNull();
    });

    it("treats two distinct current successes for one pass as cohort corruption", () => {
      const { jobId } = createJob("AAPL");
      for (const attemptId of ["bull-success-a", "bull-success-b"]) {
        persistPassSettlement({
          jobId,
          runGeneration: 0,
          attemptId,
          pass: "bull",
          settlement: testSuccessSettlement(testAnalystPass("bull")),
          payloadFingerprint: "1.3.0:ambiguous",
          settledAt: NOW().toISOString(),
        });
      }
      persistPassSettlement({
        jobId,
        runGeneration: 0,
        attemptId: "bear-success",
        pass: "bear",
        settlement: testSuccessSettlement(testAnalystPass("bear")),
        payloadFingerprint: "1.3.0:ambiguous",
        settledAt: NOW().toISOString(),
      });
      markTerminal(jobId);

      expect(readJobResumeState(jobId)).toMatchObject({
        resumable: false,
        reusablePasses: [],
        rerunPasses: [],
      });
    });

    it("isolates an artifact-cost half-pair to its pass and reuses the healthy sibling", () => {
      const { jobId } = createJob("AAPL");
      for (const side of ["bull", "bear"] as const) {
        persistPassSettlement({
          jobId,
          runGeneration: 0,
          attemptId: `half-pair-${side}`,
          pass: side,
          settlement: testSuccessSettlement(testAnalystPass(side)),
          payloadFingerprint: "1.3.0:half-pair",
          settledAt: NOW().toISOString(),
        });
      }
      handle.db.delete(costLog).where(eq(costLog.attemptId, "half-pair-bull")).run();
      markTerminal(jobId);

      expect(readJobResumeState(jobId)).toEqual({
        resumable: true,
        reusablePasses: ["bear"],
        rerunPasses: ["bull", "synthesize", "verify"],
        reason: "reusable analyst work is available",
      });
    });

    it.each(["queued", "running", "unsupported"])(
      "never marks %s jobs resumable even with compatible snapshots",
      (status) => {
        const { jobId } = createJob("AAPL");
        seedResumableLegacyJob(jobId, "error", "1.3.0:inactive");
        handle.db.update(jobs).set({ status }).where(eq(jobs.id, jobId)).run();
        expect(readJobResumeState(jobId)).toMatchObject({ resumable: false });
      },
    );

    it("failure-only artifacts save no paid work and are not resumable", () => {
      const { jobId } = createJob("AAPL");
      persistPassSettlement({
        jobId,
        runGeneration: 0,
        attemptId: "failure-only",
        pass: "synthesize",
        settlement: {
          outcome: "failure",
          failure: { name: "Error", message: "no reusable output" },
          telemetry: testTelemetry({
            data: fakeJudgeOutput(),
            model: "claude-opus-4-8",
            costUsd: 0.3,
            fallbackUsed: false,
          }),
        },
        payloadFingerprint: "1.3.0:failure-only",
        settledAt: NOW().toISOString(),
      });
      markTerminal(jobId);

      expect(readJobResumeState(jobId)).toMatchObject({ resumable: false });
    });

    it.each([
      { label: "analyst null", pass: "bull" as const, fingerprint: null },
      { label: "analyst whitespace", pass: "bull" as const, fingerprint: "   " },
      { label: "synthesize null", pass: "synthesize" as const, fingerprint: null },
      { label: "synthesize whitespace", pass: "synthesize" as const, fingerprint: "   " },
    ])(
      "rejects current $label provenance before claim, generation bump, or paid dispatch",
      async ({ pass, fingerprint }) => {
        const { jobId } = createJob("AAPL");
        if (pass === "bull") {
          persistPassSettlement({
            jobId,
            runGeneration: 0,
            attemptId: `unknown-${pass}-${fingerprint === null ? "null" : "blank"}`,
            pass,
            settlement: testSuccessSettlement(testAnalystPass("bull")),
            payloadFingerprint: fingerprint,
            settledAt: NOW().toISOString(),
          });
        } else {
          persistPassSettlement({
            jobId,
            runGeneration: 0,
            attemptId: `unknown-${pass}-${fingerprint === null ? "null" : "blank"}`,
            pass,
            settlement: testSuccessSettlement({
              data: fakeJudgeOutput(),
              model: "claude-opus-4-8",
              costUsd: 0.4,
              fallbackUsed: false,
            }),
            payloadFingerprint: fingerprint,
            settledAt: NOW().toISOString(),
          });
        }
        markTerminal(jobId);
        const base = mockPasses();
        const paidAnalysts = vi.fn(base.passes.runBullThenBear);
        const paidJudge = vi.fn(base.passes.runJudgePass);

        expect(readJobResumeState(jobId)).toMatchObject({ resumable: false });
        expect(claimJobForResume(jobId, "error")).toBe(false);
        await expect(runJob(
          jobId,
          { ...base.passes, runBullThenBear: paidAnalysts, runJudgePass: paidJudge },
          { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW, resume: true },
        )).rejects.toThrow(/not resumable/i);
        expect(paidAnalysts).not.toHaveBeenCalled();
        expect(paidJudge).not.toHaveBeenCalled();
        expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
          status: "error",
          runGeneration: 0,
        });
      },
    );

    it("rejects blank current verify provenance before authority, claim, generation bump, or paid dispatch", async () => {
        const payloadFingerprint = "   ";
        const { jobId } = createJob("AAPL");
        persistPassSettlement({
          jobId,
          runGeneration: 0,
          attemptId: "unknown-verify-blank",
          pass: "verify",
          settlement: testSuccessSettlement({
            data: fakeReport(fakeJudgeOutput()),
            model: "deterministic",
            costUsd: 0,
            fallbackUsed: false,
          }, false),
          payloadFingerprint,
          settledAt: NOW().toISOString(),
        });
        markTerminal(jobId);
        const base = mockPasses();
        const paidAnalysts = vi.fn(base.passes.runBullThenBear);
        const paidJudge = vi.fn(base.passes.runJudgePass);
        const paidVerify = vi.fn(base.passes.runVerifyPass);

        expect.soft(readJobResumeState(jobId)).toMatchObject({ resumable: false });
        expect.soft(claimJobForResume(jobId, "error")).toBe(false);
        await expect(runJob(
          jobId,
          {
            ...base.passes,
            fingerprintPayload: () => "1.3.0:known-current",
            runBullThenBear: paidAnalysts,
            runJudgePass: paidJudge,
            runVerifyPass: paidVerify,
          },
          { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW, resume: true },
        )).rejects.toThrow(/not resumable|fingerprint mismatch/i);
        expect(paidAnalysts).not.toHaveBeenCalled();
        expect(paidJudge).not.toHaveBeenCalled();
        expect(paidVerify).not.toHaveBeenCalled();
        expect.soft(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({
          status: "error",
          runGeneration: 0,
        });
      });
  });

  it("synthesize step done without a linked report or judge artifact remains resumable", () => {
    const { jobId } = createJob("AAPL");
    seedResumableLegacyJob(jobId, "done", "1.3.0:step-lie");
    handle.db
      .update(jobs)
      .set({
        stepsJson: JSON.stringify([
          { step: "bull", status: "error" },
          { step: "bear", status: "error" },
          { step: "synthesize", status: "done" },
        ] satisfies StepProgress[]),
      })
      .where(eq(jobs.id, jobId))
      .run();

    const prepared = prepareJobResume(jobId, "done");

    expect(prepared).not.toBeNull();
    expect(prepared?.bull).not.toBeNull();
    expect(prepared?.bear).not.toBeNull();
  });

  it("an existing linked report blocks retry even when its JSON is corrupt", () => {
    const { jobId } = createJob("AAPL");
    seedResumableLegacyJob(jobId, "done", "1.3.0:linked-report");
    const linked = handle.db
      .insert(reports)
      .values({
        symbol: "AAPL",
        createdAt: "2026-08-08T00:00:00.000Z",
        model: "claude-opus-4-8",
        status: "done",
        reportJson: "{corrupt-json",
        verificationRate: null,
        costUsd: 1.37,
        specVersion: "1.0.0",
      })
      .returning({ id: reports.id })
      .get();
    handle.db.update(jobs).set({ reportId: linked.id }).where(eq(jobs.id, jobId)).run();

    expect(prepareJobResume(jobId, "done")).toBeNull();
  });

  it.each([null, "", "   "])(
    "legacy analyst snapshots with fingerprint %j fail closed",
    (payloadFingerprint) => {
      const { jobId } = createJob("AAPL");
      seedResumableLegacyJob(jobId, "error", "1.3.0:temporary");
      handle.db
        .update(jobs)
        .set({ payloadFingerprint })
        .where(eq(jobs.id, jobId))
        .run();

      expect(prepareJobResume(jobId, "error")).toBeNull();
    },
  );

  it("folds a pre-lineage-column terminal generation over its prior paid cohort", () => {
    const { jobId } = createJob("AAPL");
    for (const side of ["bull", "bear"] as const) {
      persistPassSettlement({
        jobId,
        runGeneration: 0,
        attemptId: `stale-${side}`,
        pass: side,
        settlement: testSuccessSettlement(testAnalystPass(side)),
        payloadFingerprint: "1.3.0:stale",
        settledAt: NOW().toISOString(),
      });
    }
    handle.db
      .update(jobs)
      .set({
        status: "error",
        runGeneration: 1,
        bullJson: null,
        bearJson: null,
        payloadFingerprint: null,
        stepsJson: JSON.stringify([
          { step: "bull", status: "done" },
          { step: "bear", status: "done" },
          { step: "synthesize", status: "error" },
        ] satisfies StepProgress[]),
      })
      .where(eq(jobs.id, jobId))
      .run();

    expect(readJobResumeState(jobId)).toMatchObject({
      resumable: true,
      reusablePasses: ["bull", "bear"],
      rerunPasses: ["synthesize", "verify"],
    });
    expect(prepareJobResume(jobId, "error")).toMatchObject({
      sourceGeneration: 0,
      claimGeneration: 1,
      targetGeneration: 2,
      bull: expect.any(Object),
      bear: expect.any(Object),
    });
  });

  it("keeps an older synthesize success authoritative after a newer verify failure", () => {
    const { jobId } = createJob("AAPL");
    const fingerprint = "1.3.0:mixed-lineage";
    persistPassSettlement({
      jobId,
      runGeneration: 0,
      attemptId: "mixed-source-synthesize",
      pass: "synthesize",
      settlement: testSuccessSettlement({
        data: fakeJudgeOutput(),
        model: "claude-opus-4-8",
        costUsd: 0.4,
        fallbackUsed: false,
      }),
      payloadFingerprint: fingerprint,
      settledAt: NOW().toISOString(),
    });
    handle.db.update(jobs).set({ status: "error", error: "verify pending" })
      .where(eq(jobs.id, jobId)).run();
    expect(claimJobForResume(jobId, "error")).toBe(true);
    persistPassSettlement({
      jobId,
      runGeneration: 1,
      attemptId: "mixed-newer-verify-failure",
      pass: "verify",
      settlement: {
        outcome: "failure",
        failure: { name: "ProviderError", message: "newer verify failed" },
        telemetry: testTelemetry({
          data: fakeReport(fakeJudgeOutput()),
          model: "deterministic",
          costUsd: 0,
          fallbackUsed: false,
        }, false),
      },
      payloadFingerprint: fingerprint,
      settledAt: NOW().toISOString(),
    });
    handle.db.update(jobs).set({ status: "error", error: "verify failed" })
      .where(eq(jobs.id, jobId)).run();

    expect(readJobResumeState(jobId)).toMatchObject({
      resumable: true,
      reusablePasses: ["synthesize"],
      rerunPasses: ["verify"],
    });
    expect(prepareJobResume(jobId, "error")).toMatchObject({
      sourceGeneration: 0,
      claimGeneration: 1,
      synthesize: expect.any(Object),
      verify: null,
    });
  });

  it("rejects a direct resume of a healthy completed job", async () => {
    const { jobId } = createJob("AAPL");
    const passes = mockPasses();
    const first = await runJob(jobId, passes.passes, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: true,
      now: NOW,
    });
    expect(first.status).toBe("done");
    const before = handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all();

    await expect(
      runJob(jobId, passes.passes, {
        bundle: fakeBundle("AAPL"),
        hasAnthropicKey: true,
        now: NOW,
        resume: true,
      }),
    ).rejects.toThrow(/not resumable|already synthesized/i);
    expect(handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all()).toHaveLength(before.length);
  });

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

  it("claimJobForResume lets exactly one terminal-state contender claim a retry", () => {
    const { jobId } = createJob("AAPL");
    seedResumableLegacyJob(jobId, "done");

    expect(claimJobForResume(jobId, "done")).toBe(true);
    const claimed = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(claimed?.status).toBe("queued");
    expect(claimed?.error).toBeNull();
    expect(claimed?.runGeneration).toBe(1);
    expect(claimJobForResume(jobId, "done")).toBe(false);
  });

  // A degraded retry may rewrite all display steps to skipped. Durable legacy
  // analysts remain authoritative regardless of that presentation shape.
  it("a degraded resume does not strand the paid snapshots — the job stays resumable", async () => {
    const { jobId } = createJob("AAPL");

    // 1) First run: synthesize fails after both analysts → both PAID snapshots
    //    persisted; classic resumable shape.
    const firstPasses: PipelinePasses = {
      ...mockPasses().passes,
      fingerprintPayload: () => "1.3.0:degraded-resume",
      runJudgePass: async () => {
        throw new Error("judge pass failed (transport): stream rejected (simulated)");
      },
    };
    await runJob(jobId, firstPasses, { bundle: fakeBundle("AAPL"), hasAnthropicKey: true, now: NOW });
    const afterFirst = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;

    // 2) Resume that DEGRADES before the resume branch (no key): steps rewritten
    //    all-skipped, job finishes "done" — the step shape is now non-resumable.
    expect(afterFirst.status).toBe("done");
    handle.db.update(jobs).set({ reportId: null }).where(eq(jobs.id, jobId)).run();
    expect(readJobResumeState(jobId)?.resumable).toBe(true);
    claimJobForResume(jobId, "done"); // mirror the retry route's claim
    await runJob(jobId, mockPasses().passes, {
      bundle: fakeBundle("AAPL"),
      hasAnthropicKey: false,
      now: NOW,
      resume: true,
    });
    const afterDegraded = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    const snapshots = readPassSnapshots(jobId);
    expect(snapshots!.bull).not.toBeNull();
    expect(snapshots!.bear).not.toBeNull();
    handle.db.update(jobs).set({ reportId: null }).where(eq(jobs.id, jobId)).run();
    expect(readJobResumeState(jobId)?.resumable).toBe(true);

    // 3) Re-resume with a healthy judge: BOTH snapshots reused (analysts must
    //    NOT re-run), a real report is produced — nothing re-billed.
    expect(afterDegraded.status).toBe("done");
    claimJobForResume(jobId, "done");
    const healthy = mockPasses();
    const rebillGuard: PipelinePasses = {
      ...healthy.passes,
      fingerprintPayload: () => "1.3.0:degraded-resume",
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

  // Regression (2026-07-20 audit): the sweep's per-row UPDATE dropped the
  // stale-status predicate (a TOCTOU widening vs the prior atomic UPDATE). A row
  // that flips live between the sweep's SELECT and its per-row write must not be
  // clobbered back to error.
  it("lease reconciliation respects an exact renewal even when updatedAt is ancient", async () => {
    const scheduler = await import("@/pipeline/jobScheduler");
    const claimedAt = new Date("2026-07-09T12:00:00.000Z");
    const limits = {
      maxActiveJobs: 1,
      maxActiveLlmCalls: 1,
      maxRollingCostUsd: null,
      rollingCostWindowMs: 60_000,
      paidPassLeaseTtlMs: 1_000,
      jobLeaseTtlMs: 1_000,
    };
    const { jobId } = createJob("RACE");
    const claim = scheduler.claimQueuedJobById(jobId, "race", claimedAt, limits)!;
    handle.db.update(jobs).set({ updatedAt: "2000-01-01T00:00:00.000Z" })
      .where(eq(jobs.id, jobId)).run();
    expect(scheduler.renewJobLease(
      claim,
      new Date(claimedAt.getTime() + 500),
      limits,
    )).toBe(true);

    expect(sweepAbandonedJobs(new Date(claimedAt.getTime() + 1_001))).toBe(0);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.status).toBe("running");
    expect(sweepAbandonedJobs(new Date(claimedAt.getTime() + 1_501))).toBe(1);
    expect(handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.status).toBe("error");
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
        payloadFingerprint: "1.3.0:cancel-window",
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

describe("analyst repair attempt after schema-invalid output", () => {
  const SCHEMA_ERROR =
    'bear pass failed (schema): schema-invalid structured output for llm.bear: Invalid ISO date (expected YYYY-MM-DD): "2026-Q1"';
  const RAW = '{"thesis":"x","asOf":"2026-Q1"}';
  const bearBilledAttempt = {
    model: "claude-opus-4-8",
    costUsd: 0.31,
    fallbackUsed: false,
    usage: { input_tokens: 14000, output_tokens: 5000, cache_creation_input_tokens: 0, cache_read_input_tokens: 300000 },
    webSearches: 6,
  };
  function schemaInvalidBear(bull: PassResultLike<AnalystCase>, retryable: boolean): Error {
    return Object.assign(new Error(SCHEMA_ERROR), {
      bull,
      bearError: SCHEMA_ERROR,
      bearBilledAttempt,
      bearRetryable: retryable,
      bearRawText: RAW,
    });
  }

  it("repairs a schema-invalid bear once with the error and raw output fed back, then synthesizes", async () => {
    // 2026-09-02: a haiku analyst wrote "2026-Q1" for asOf and, with no
    // retry, both paid passes and the whole analysis were lost ($0.25).
    const { jobId } = createJob("AAPL");
    const { passes, calls } = mockPasses();
    const bull = testAnalystPass("bull");
    const bear = testAnalystPass("bear");
    passes.runBullThenBear = async (_deps, hooks) => {
      await launchTestAnalystSide(hooks, "bull");
      await launchTestAnalystSide(hooks, "bear");
      throw schemaInvalidBear(bull, true);
    };
    const feedbacks: Array<string | undefined> = [];
    passes.runAnalystPass = async (_deps, side, settlement, beforeProviderLaunch, feedback) => {
      calls.push(`runAnalystPass:${side}`);
      feedbacks.push(feedback);
      await beforeProviderLaunch?.();
      await settlement?.(testSuccessSettlement(bear));
      return bear;
    };

    const result = await runJob(jobId, passes, { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW });

    expect(calls.filter((c) => c.startsWith("runAnalystPass:"))).toEqual(["runAnalystPass:bear"]);
    expect(feedbacks[0]).toContain('Invalid ISO date (expected YYYY-MM-DD): "2026-Q1"');
    expect(feedbacks[0]).toContain(`YOUR PREVIOUS OUTPUT (repair this JSON in place — do not start over):\n${RAW}`);
    expect(result.status).toBe("done");
    expect(result.dataOnly).toBe(false);
    expect(result.reportId).not.toBeNull();

    const jobRow = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    const steps = JSON.parse(jobRow?.stepsJson ?? "[]") as StepProgress[];
    const byStep = new Map(steps.map((s) => [s.step, s]));
    expect(byStep.get("bull")?.status).toBe("done");
    expect(byStep.get("bear")?.status).toBe("done");
    expect(byStep.get("synthesize")?.status).toBe("done");
    expect(byStep.get("verify")?.status).toBe("done");

    // Both bear attempts are billed and logged; bull's single pass is kept.
    const costRows = handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all();
    expect(costRows.filter((r) => r.step === "bear").map((r) => r.costUsd).sort()).toEqual([0.31, 0.47]);
    expect(costRows.filter((r) => r.step === "bull")).toHaveLength(1);
    expect(result.totalCostUsd).toBeCloseTo(0.9 + 0.31 + 0.47 + 0.4 + 0.2, 6);
  });

  it("persists data-only when the repair attempt fails too, naming the second failure", async () => {
    const { jobId } = createJob("AAPL");
    const { passes } = mockPasses();
    const bull = testAnalystPass("bull");
    passes.runBullThenBear = async (_deps, hooks) => {
      await launchTestAnalystSide(hooks, "bull");
      await launchTestAnalystSide(hooks, "bear");
      throw schemaInvalidBear(bull, true);
    };
    passes.runAnalystPass = async (_deps, _side, _settlement, beforeProviderLaunch) => {
      await beforeProviderLaunch?.();
      throw Object.assign(new Error("bear pass failed (schema): schema-invalid structured output for llm.bear (again)"), {
        billedAttempt: { model: "claude-opus-4-8", costUsd: 0.2, fallbackUsed: false },
        retryable: true,
      });
    };

    const result = await runJob(jobId, passes, { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW });

    expect(result.status).toBe("done");
    expect(result.dataOnly).toBe(true);
    const jobRow = handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    const steps = JSON.parse(jobRow?.stepsJson ?? "[]") as StepProgress[];
    const byStep = new Map(steps.map((s) => [s.step, s]));
    expect(byStep.get("bull")?.status).toBe("done");
    expect(byStep.get("bear")?.status).toBe("error");
    expect(byStep.get("synthesize")?.status).toBe("skipped");
    const costRows = handle.db.select().from(costLog).where(eq(costLog.jobId, jobId)).all();
    expect(costRows.filter((r) => r.step === "bear").map((r) => r.costUsd).sort()).toEqual([0.2, 0.31]);

    const reportRow = handle.db.select().from(reports).where(eq(reports.id, result.reportId!)).get()!;
    const report = ReportSchema.parse(JSON.parse(reportRow.reportJson ?? "{}"));
    const bearGap = report.appendix.missingData.find((gap) => gap.field === "llm.bear");
    expect(bearGap?.reason).toMatch(/^repair attempt after schema-invalid output also failed: .*\(again\)/);
  });

  it("does not attempt a repair for a failure that was not a schema rejection", async () => {
    const { jobId } = createJob("AAPL");
    const { passes, calls } = mockPasses();
    const bull = testAnalystPass("bull");
    passes.runBullThenBear = async (_deps, hooks) => {
      await launchTestAnalystSide(hooks, "bull");
      await launchTestAnalystSide(hooks, "bear");
      throw schemaInvalidBear(bull, false);
    };
    passes.runAnalystPass = async () => {
      calls.push("runAnalystPass");
      throw new Error("must not be called");
    };

    const result = await runJob(jobId, passes, { bundle: fakeBundle(), hasAnthropicKey: true, now: NOW });

    expect(calls).not.toContain("runAnalystPass");
    expect(result.dataOnly).toBe(true);
  });
});
