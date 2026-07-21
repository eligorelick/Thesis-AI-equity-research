/**
 * Stage C adapter (src/pipeline/stageC/index.ts) tests.
 *
 * index.ts is the thin adapter bridging the runner's loose PipelinePasses facade
 * to the strictly-typed passes.ts exports. It previously had ZERO coverage — and
 * finding H4 (validation gaps dropped from the rendered report) lived exactly in
 * its assembleReport / runVerifyPass forwarding. These tests cover:
 *
 *   - pipelinePasses construction (the object exposes the facade methods),
 *   - the WeakMap per-job assembly-context recovery used by runVerifyPass
 *     (a registered payload recovers its bundle/computed/validation; an
 *     unregistered one falls back to the minimal stand-in — no cross-job leak),
 *   - assembleReport forwarding the Stage A validation gaps into the appendix
 *     missing-data manifest (H4).
 *
 * No network, no LLM: assembleReport is pure, and runVerifyPass's model-side pass
 * was removed — its verification is a deterministic numeric trace, so these run
 * offline without an Anthropic key.
 */

import { afterEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { APIError } from "@anthropic-ai/sdk";

import { runStageB, type ComputedMetrics } from "@/pipeline/compute";
import { validateBundle } from "@/pipeline/stageA/validate";
import type { DataBundle } from "@/pipeline/types";
import type { ManifestEntry } from "@/types/core";
import type { AnalystCase, JudgeOutput, Report } from "@/report/schema";
import { BullBearPassFailure, type AssembleReportInput, type PassDeps } from "@/pipeline/jobRunner";
import type { ContextPayload, PayloadSection } from "@/pipeline/stageC/payload";
import { pipelinePasses } from "@/pipeline/stageC/index";
import {
  PASS_TRANSPORT_MAX_ATTEMPTS,
  _resetAnthropicForTests,
  _setTransportRetrySleepForTests,
} from "@/providers/anthropic";

/* ------------------------------------------------------------------------ *
 * Fixtures — a compact sparse bundle (runStageB/validateBundle degrade on gaps)
 * and a schema-valid JudgeOutput.
 * ------------------------------------------------------------------------ */

const BUILT_AT = "2026-07-06T00:00:00.000Z";
const GENERATED_AT = "2026-07-06T12:00:00.000Z";

function fakeBundle(symbol = "AAPL"): DataBundle {
  const gap = { ok: false as const, gap: { field: "x", reason: "fixture", severity: "info" as const } };
  const profile = {
    ok: true as const,
    value: {
      data: { rows: [{ companyName: "Apple Inc.", sector: "Technology", price: 200 }], raw: {} },
      asOf: "2026-07-01",
      source: "fmp" as const,
      endpoint: "profile",
      fetchedAt: BUILT_AT,
    },
  };
  return {
    symbol,
    builtAt: BUILT_AT,
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
    asOf: { quote: "2026-07-05", profile: "2026-07-01" },
    gaps: [],
  } as unknown as DataBundle;
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
  const price = { value: 240, unit: "USD/share", source: "computed", asOf: null, verified: null };
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
      dcf: { perShare: price, assumptions: [], sensitivityGrid: [], upsidePct: null },
      reverseDcf: { impliedMetric: "growth", impliedValue: null, narrative: "implied narrative" },
      multiples: [],
      scenarios: [
        { name: "bull", probability: 0.34, priceTarget: { ...price, value: 300 }, horizon: "12mo", assumptions: [], whatWouldHaveToBeTrue: [] },
        { name: "base", probability: 0.33, priceTarget: { ...price, value: 250 }, horizon: "12mo", assumptions: [], whatWouldHaveToBeTrue: [] },
        { name: "bear", probability: 0.33, priceTarget: { ...price, value: 200 }, horizon: "12mo", assumptions: [], whatWouldHaveToBeTrue: [] },
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

function buildInputs(): { bundle: DataBundle; computed: ComputedMetrics; validation: ReturnType<typeof validateBundle> } {
  const bundle = fakeBundle();
  const computed = runStageB(bundle);
  const validation = validateBundle(bundle, { now: new Date("2026-07-06T00:00:00Z") });
  return { bundle, computed, validation };
}

const VALIDATION_MARKER: ManifestEntry = {
  field: "balanceSheet.identity",
  reason: "assets != liabilities + equity (adapter validation-only marker)",
  severity: "warn",
};

function assembleInput(
  bundle: DataBundle,
  computed: ComputedMetrics,
  validation: ReturnType<typeof validateBundle>,
): AssembleReportInput {
  return {
    judgeOutput: fakeJudgeOutput(),
    bundle,
    computed,
    validation,
    meta: {
      symbol: "AAPL",
      companyName: "Apple Inc.",
      generatedAt: GENERATED_AT,
      model: "claude-opus-4-8",
      costUsd: 0,
      verificationRate: 1,
      asOfMap: {},
    },
    verificationRate: 1,
    verificationLog: [],
    costBreakdown: [],
  };
}

/** A minimal, structurally-complete ContextPayload NOT registered in the WeakMap. */
function unregisteredPayload(): ContextPayload {
  const emptySection = (title: string): PayloadSection => ({ title, figures: [], notes: [] });
  return {
    payloadVersion: "1.1.0",
    symbol: "ZZZ",
    companyName: null,
    route: { base: "general", overlays: [], sector: null, industry: null },
    quote: emptySection("Quote"),
    computed: [],
    statements: [],
    estimates: emptySection("Estimates"),
    peers: emptySection("Peers"),
    insiders: emptySection("Insiders"),
    institutional: emptySection("Institutional"),
    leadership: emptySection("Leadership"),
    shortInterest: emptySection("Short interest"),
    segments: emptySection("Segments"),
    macro: emptySection("Macro"),
    transcript: null,
    filings: [],
    news: emptySection("News"),
    validationFlags: [],
    missingData: [],
    asOfMap: {},
  };
}

const keyOf = (m: ManifestEntry): string => `${m.field}|${m.reason}`;

/* ------------------------------------------------------------------------ *
 * Construction
 * ------------------------------------------------------------------------ */

describe("pipelinePasses construction", () => {
  it("exposes the full PipelinePasses facade as callable methods", () => {
    expect(typeof pipelinePasses.assembleContextPayload).toBe("function");
    expect(typeof pipelinePasses.fingerprintPayload).toBe("function");
    expect(typeof pipelinePasses.runBullThenBear).toBe("function");
    expect(typeof pipelinePasses.runJudgePass).toBe("function");
    expect(typeof pipelinePasses.runVerifyPass).toBe("function");
    expect(typeof pipelinePasses.assembleReport).toBe("function");
  });

  it("assembleContextPayload produces a stable fingerprint", () => {
    const { bundle, computed, validation } = buildInputs();
    const payload = pipelinePasses.assembleContextPayload(bundle, computed, validation);
    const fp = pipelinePasses.fingerprintPayload?.(payload);
    expect(fp).toMatch(/^1\.2\.0:[0-9a-f]{8}$/);
  });
});

/* ------------------------------------------------------------------------ *
 * assembleReport — H4: forward Stage A validation gaps into the appendix
 * ------------------------------------------------------------------------ */

describe("pipelinePasses.assembleReport (H4 forwarding)", () => {
  it("merges input.validation.gaps into appendix.missingData", () => {
    const { bundle, computed, validation } = buildInputs();
    validation.gaps.push(VALIDATION_MARKER);
    const report = pipelinePasses.assembleReport(assembleInput(bundle, computed, validation));
    expect(report.appendix.missingData.some((m) => keyOf(m) === keyOf(VALIDATION_MARKER))).toBe(true);
  });

  it("still includes computed gaps (does not replace them with validation gaps)", () => {
    const { bundle, computed, validation } = buildInputs();
    // Seed a distinctive computed gap and a distinctive validation gap; both must appear.
    const computedMarker: ManifestEntry = { field: "computed.marker", reason: "computed-only marker", severity: "warn" };
    computed.gaps.push(computedMarker);
    validation.gaps.push(VALIDATION_MARKER);
    const report = pipelinePasses.assembleReport(assembleInput(bundle, computed, validation));
    const keys = new Set(report.appendix.missingData.map(keyOf));
    expect(keys.has(keyOf(computedMarker))).toBe(true);
    expect(keys.has(keyOf(VALIDATION_MARKER))).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * runVerifyPass — WeakMap per-job assembly-context recovery
 * ------------------------------------------------------------------------ */

describe("pipelinePasses.runVerifyPass (WeakMap context recovery)", () => {
  it("recovers the registered bundle/computed/validation and forwards validation gaps to the verified report", async () => {
    const { bundle, computed, validation } = buildInputs();
    validation.gaps.push(VALIDATION_MARKER);
    // assembleContextPayload registers { bundle, computed, validation } keyed by payload identity.
    const payload = pipelinePasses.assembleContextPayload(bundle, computed, validation);
    const deps: PassDeps<ContextPayload> = { analysisModel: "claude-opus-4-8", payload };

    const result = await pipelinePasses.runVerifyPass(deps, fakeJudgeOutput());

    // The verified report used the RECOVERED context (real symbol + validation gap).
    expect(result.verifiedReport.meta.symbol).toBe("AAPL");
    expect(
      result.verifiedReport.appendix.missingData.some((m) => keyOf(m) === keyOf(VALIDATION_MARKER)),
    ).toBe(true);
  });

  it("falls back to the minimal stand-in for an unregistered payload (no cross-job leak)", async () => {
    // Register a DIFFERENT job's context, then verify against an UNRELATED payload
    // object. The WeakMap keys on identity, so the registered context must NOT leak.
    const { bundle, computed, validation } = buildInputs();
    validation.gaps.push(VALIDATION_MARKER);
    pipelinePasses.assembleContextPayload(bundle, computed, validation);

    const deps: PassDeps<ContextPayload> = { analysisModel: "claude-opus-4-8", payload: unregisteredPayload() };
    const result = await pipelinePasses.runVerifyPass(deps, fakeJudgeOutput());

    // Stand-in bundle has an empty symbol and no gaps — the other job's marker is absent.
    expect(result.verifiedReport.meta.symbol).toBe("");
    expect(
      result.verifiedReport.appendix.missingData.some((m) => keyOf(m) === keyOf(VALIDATION_MARKER)),
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * runBullThenBear — failure surfaces as BullBearPassFailure (adapter contract)
 * ------------------------------------------------------------------------ */

describe("pipelinePasses adapter smoke", () => {
  it("fakeAnalystCase is a valid shape (fixture sanity)", () => {
    // Guards the fixture used by future adapter tests; keeps this file self-contained.
    expect(fakeAnalystCase().priceTarget.value).toBe(250);
  });
});

/* ------------------------------------------------------------------------ *
 * 2026-07-10 incident regression, end to end through the REAL provider:
 * a mid-stream `overloaded_error` on both analyst streams must (a) be retried
 * by the provider, and (b) when it persists, surface as BullBearPassFailure
 * carrying billed attempts so the job runner writes real cost_log rows
 * (the live incident recorded $0.0000 for ~17 minutes of billed generation).
 * ------------------------------------------------------------------------ */

describe("pipelinePasses.runBullThenBear against a persistently overloaded stream", () => {
  afterEach(() => {
    _resetAnthropicForTests();
    _setTransportRetrySleepForTests();
  });

  it("throws BullBearPassFailure with billed attempts for both sides after provider retries exhaust", async () => {
    _setTransportRetrySleepForTests(async () => {});
    let streamCalls = 0;
    const midStreamOverload = () =>
      new APIError(
        undefined,
        {
          type: "error",
          error: { details: null, type: "overloaded_error", message: "Overloaded" },
          request_id: "req_test",
        } as never,
        undefined,
        undefined,
        "overloaded_error",
      );
    const fakeStream = () => {
      const listeners = new Map<string, Array<{ fn: (...args: unknown[]) => void; once: boolean }>>();
      const add = (name: string, fn: (...args: unknown[]) => void, once: boolean) => {
        const arr = listeners.get(name) ?? [];
        arr.push({ fn, once });
        listeners.set(name, arr);
      };
      const emit = (name: string, ...args: unknown[]) => {
        const arr = listeners.get(name) ?? [];
        listeners.set(
          name,
          arr.filter((l) => !l.once),
        );
        for (const l of arr) l.fn(...args);
      };
      let reject!: (e: unknown) => void;
      const finalPromise = new Promise<never>((_r, rej) => {
        reject = rej;
      });
      finalPromise.catch(() => {});
      queueMicrotask(() => {
        emit("streamEvent", {
          type: "message_start",
          message: {
            model: "claude-opus-4-8",
            usage: {
              input_tokens: 5_000,
              output_tokens: 1,
              cache_creation_input_tokens: 40_000,
              cache_read_input_tokens: 0,
            },
          },
        });
        emit("streamEvent", { type: "message_delta", delta: {}, usage: { output_tokens: 9_000 } });
        const err = midStreamOverload();
        emit("error", err);
        reject(err);
      });
      return {
        on: (name: string, fn: (...args: unknown[]) => void) => add(name, fn, false),
        once: (name: string, fn: (...args: unknown[]) => void) => add(name, fn, true),
        finalMessage: () => finalPromise,
      };
    };
    const client = {
      beta: {
        messages: {
          stream: () => {
            streamCalls += 1;
            return fakeStream();
          },
          create: async () => {
            throw new Error("unexpected non-streaming create() call");
          },
        },
      },
    } as unknown as Anthropic;
    _resetAnthropicForTests(client);

    const { bundle, computed, validation } = buildInputs();
    const payload = pipelinePasses.assembleContextPayload(bundle, computed, validation);
    const deps: PassDeps<ContextPayload> = { analysisModel: "claude-opus-4-8", payload };

    const failure = await pipelinePasses
      .runBullThenBear(deps)
      .then(() => null)
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(BullBearPassFailure);
    const details = failure as BullBearPassFailure;
    expect(details.message).toContain("bull pass failed (transport)");
    expect(details.message).toContain("bear pass failed (transport)");
    // Every attempt of both sides was retried before giving up…
    expect(streamCalls).toBe(2 * PASS_TRANSPORT_MAX_ATTEMPTS);
    // …and the billed spend of those attempts survives for cost_log.
    expect(details.bullBilledAttempt?.model).toBe("claude-opus-4-8");
    expect(details.bullBilledAttempt?.costUsd ?? 0).toBeGreaterThan(0);
    expect(details.bullBilledAttempt?.usage?.output_tokens).toBe(3 * 9_000);
    expect(details.bearBilledAttempt?.costUsd ?? 0).toBeGreaterThan(0);
  });
});
