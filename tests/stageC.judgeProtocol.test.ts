/**
 * WS7 (D-20) — the adversarial protocol: judge case order, per-side length caps,
 * `case_strength`, and the shared-model-family disclosure.
 *
 * What these pin, and why each one is a REGRESSION guard rather than a
 * restatement of the implementation:
 *
 *  - The judge must not always read the bull case first. Before this the order
 *    was a literal in judgeUserTurns, so "bull first" was true of every report
 *    ever produced. The tests below pin that the order is drawn from the seed,
 *    that BOTH orders actually occur, and that the order used is recorded where
 *    a reader can see it.
 *  - Both cases share one character cap, truncation is disclosed rather than
 *    silent, and the judge is told both lengths.
 *  - `case_strength` survives the schema round trip in both directions (a fresh
 *    pass must supply it; an artifact persisted before it existed must still
 *    parse), and reaches the judge and the report.
 *  - A judge from the same model family as the analysts is disclosed.
 *
 * NO network, NO live LLM: every pass is driven by MockRunPass. Fixture style
 * mirrors tests/stageC.index.test.ts (a compact sparse bundle; runStageB and
 * validateBundle degrade on gaps).
 */

import { describe, expect, it } from "vitest";

import { runStageB, type ComputedMetrics } from "@/pipeline/compute";
import { validateBundle } from "@/pipeline/stageA/validate";
import { parseEnv } from "@/config/env";
import type { DataBundle } from "@/pipeline/types";
import type { AnalystCase, JudgeOutput, Report } from "@/report/schema";
import { ANALYST_CASE_SCHEMA, analystCaseToJsonSchema } from "@/report/schema";
import {
  annotateSharedModelFamily,
  buildExecutionMetadataEntry,
  sharedModelFamilyOf,
} from "@/report/execution";
import {
  ANALYST_CASE_CHAR_CAP,
  buildJudgePresentation,
  buildJudgeProtocolDraft,
  capAnalystCase,
  DEFAULT_JUDGE_ORDER_SETTING,
  JUDGE_ORDER_SETTINGS,
  JUDGE_PASSES_PER_SETTING,
  reconcileJudgeOutputs,
  reconciliationFields,
  resolveJudgeOrder,
  resolveJudgeOrderSetting,
} from "@/pipeline/stageC/judgeProtocol";
import {
  assembleContextPayload,
  payloadFingerprint,
  type ContextPayload,
} from "@/pipeline/stageC/payload";
import {
  buildBullFraming,
  buildJudgeFraming,
  CASE_STRENGTH_RUBRIC,
} from "@/pipeline/stageC/prompts";
import { reportToMarkdown } from "@/report/export/markdown";
import { reportToPrintHtml } from "@/report/export/printHtml";
import {
  assembleReport,
  buildJudgeRunPassArgs,
  judgeUserTurns,
  MockRunPass,
  runJudgePass,
  type PassDeps,
} from "@/pipeline/stageC/passes";

/* ------------------------------------------------------------------------ *
 * Fixtures
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
      stale: false,
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
    sourceManifest: {
      profile: {
        provider: profile.value.source,
        endpoint: profile.value.endpoint,
        asOf: profile.value.asOf,
        fetchedAt: profile.value.fetchedAt,
        stale: profile.value.stale,
      },
    },
    asOf: { profile: profile.value.asOf },
    gaps: [],
  } as unknown as DataBundle;
}

function grade(letter: "A" | "B" | "C" | "D" | "F" = "B"): Report["verdict"]["gradeStrip"]["fundamentals"] {
  return {
    grade: letter,
    oneLineWhy: "solid",
    reasoning: [{ text: "r", label: "JUDGMENT", source: "payload", asOf: null }],
    confidence: "medium",
    keyNumbers: [],
  };
}

function fakeJudgeOutput(
  over: { fundamentals?: "A" | "B" | "C" | "D" | "F"; bullProbability?: number } = {},
): JudgeOutput {
  const price = { value: 240, unit: "USD/share", source: "computed", asOf: null, verified: null };
  const bullProbability = over.bullProbability ?? 0.34;
  return {
    verdict: {
      synthesis: "A three-sentence synthesis with scenarios and probabilities. It avoids ratings. It is grounded.",
      gradeStrip: {
        fundamentals: grade(over.fundamentals ?? "B"),
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
        { name: "bull", probability: bullProbability, priceTarget: { ...price, value: 300 }, horizon: "12mo", assumptions: [], whatWouldHaveToBeTrue: [] },
        { name: "base", probability: 0.33, priceTarget: { ...price, value: 250 }, horizon: "12mo", assumptions: [], whatWouldHaveToBeTrue: [] },
        { name: "bear", probability: 1 - 0.33 - bullProbability, priceTarget: { ...price, value: 200 }, horizon: "12mo", assumptions: [], whatWouldHaveToBeTrue: [] },
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

function analystCase(side: "bull" | "bear", over: Partial<AnalystCase> = {}): AnalystCase {
  return {
    thesis: [{ text: `${side} thesis marker`, label: "JUDGMENT", source: "payload", asOf: null }],
    keyDrivers: [],
    risksToCase: [],
    catalysts: [],
    priceTarget: { value: side === "bull" ? 300 : 180, horizon: "12mo", assumptions: [] },
    evidence: [],
    case_strength: side === "bull" ? 4 : 2,
    ...over,
  };
}

function buildInputs(): { bundle: DataBundle; computed: ComputedMetrics; payload: ContextPayload } {
  const bundle = fakeBundle();
  const computed = runStageB(bundle);
  const validation = validateBundle(bundle, { now: new Date("2026-07-06T00:00:00Z") });
  return { bundle, computed, payload: assembleContextPayload(bundle, computed, validation) };
}

function makeDeps(mock: MockRunPass, over: Partial<PassDeps> = {}): PassDeps {
  return {
    runPass: mock.runPass,
    runPassStreaming: mock.runPassStreaming,
    model: "claude-opus-4-8",
    judgeOrder: "random",
    jobSeed: "job-seed-a",
    ...over,
  };
}

/** The character index at which each case's serialized JSON appears. */
function caseOffsets(messages: unknown): { bull: number; bear: number } {
  const text = JSON.stringify(messages);
  return {
    bull: text.indexOf("bull thesis marker"),
    bear: text.indexOf("bear thesis marker"),
  };
}

/* ------------------------------------------------------------------------ *
 * (a) Position bias — the judge does not always read the bull case first
 * ------------------------------------------------------------------------ */

describe("judge case order (THESIS_JUDGE_ORDER)", () => {
  it("draws a reproducible order per seed and produces BOTH orders across seeds", () => {
    // Reproducible: the same seed always draws the same order, so a resume, a
    // judge retry and the pre-launch request validation agree.
    for (const seed of ["job-1", "job-2", "0ca4b1f0-3f7e-4a9a-9b3f-1f0e7c2d5a11"]) {
      expect(resolveJudgeOrder("random", seed).order).toBe(
        resolveJudgeOrder("random", seed).order,
      );
    }
    // Unbiased across jobs: over a spread of job-id-shaped seeds both orders
    // occur. A hard-coded "bull-first" would fail this outright.
    const drawn = new Set(
      Array.from({ length: 64 }, (_, i) => resolveJudgeOrder("random", `job-${i}`).order),
    );
    expect(drawn).toEqual(new Set(["bull-first", "bear-first"]));
  });

  it("honors a pinned setting and degrades an unrecognized one to the cheap default", () => {
    expect(resolveJudgeOrder("bull-first", "any").order).toBe("bull-first");
    expect(resolveJudgeOrder("bear-first", "any").order).toBe("bear-first");
    expect(resolveJudgeOrder("bull-first", "any").secondaryOrder).toBeNull();
    expect(resolveJudgeOrderSetting("BEAR-FIRST")).toBe("bear-first");
    expect(resolveJudgeOrderSetting("sideways")).toBe(DEFAULT_JUDGE_ORDER_SETTING);
    expect(resolveJudgeOrderSetting(undefined)).toBe("random");
    expect(DEFAULT_JUDGE_ORDER_SETTING).toBe("random");
  });

  it("parses THESIS_JUDGE_ORDER in config exactly as Stage C resolves it", () => {
    // Two parsers exist (config/env.ts cannot import the Stage C module without
    // dragging the payload layer into config), so pin that they agree.
    for (const raw of [undefined, "", "random", "bull-first", "bear-first", "both", "nonsense"]) {
      const config = parseEnv(raw === undefined ? {} : { THESIS_JUDGE_ORDER: raw });
      expect(config.judgeOrder).toBe(resolveJudgeOrderSetting(raw));
    }
  });

  it("puts the bear case FIRST in the judge turn when the drawn order says so", () => {
    const { payload } = buildInputs();
    const bull = analystCase("bull");
    const bear = analystCase("bear");

    const bullFirst = buildJudgePresentation({ setting: "bull-first", seed: "s", bull, bear });
    const bearFirst = buildJudgePresentation({ setting: "bear-first", seed: "s", bull, bear });

    const a = caseOffsets(judgeUserTurns(payload, bull, bear, bullFirst));
    const b = caseOffsets(judgeUserTurns(payload, bull, bear, bearFirst));

    expect(a.bull).toBeGreaterThan(-1);
    expect(a.bull).toBeLessThan(a.bear);
    expect(b.bear).toBeLessThan(b.bull);
  });

  it("tells the judge the order carries no meaning", () => {
    const framing = buildJudgeFraming();
    expect(framing).toContain("RANDOMIZED PER REPORT");
    expect(framing).toContain("Neither being first nor being second is evidence");
  });

  it("records the order used in report metadata, the reader sentence and the manifest", async () => {
    const { bundle, computed, payload } = buildInputs();
    const mock = new MockRunPass();
    mock.onJson("llm.judge", fakeJudgeOutput());
    const deps = makeDeps(mock, { judgeOrder: "bear-first" });

    const run = await runJudgePass(deps, payload, analystCase("bull"), analystCase("bear"));
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.result.judgeProtocol?.order).toBe("bear-first");

    const report = assembleReport(
      {
        symbol: "AAPL",
        bundle,
        computed,
        judgeOutput: run.result.output,
        verify: { verificationRate: null, log: [] },
        costEntries: [
          { step: "bull", model: "claude-opus-4-8", costUsd: 0.5 },
          { step: "bear", model: "claude-opus-4-8", costUsd: 0.5 },
          { step: "synthesize", model: "claude-opus-4-8", costUsd: 0.5 },
        ],
        model: "claude-opus-4-8",
        judgeProtocol: run.result.judgeProtocol,
      },
      GENERATED_AT,
    );

    const protocol = report.meta.judgeProtocol;
    expect(protocol?.order).toBe("bear-first");
    expect(protocol?.setting).toBe("bear-first");
    expect(protocol?.seed).toBe("job-seed-a");
    // The additive field is not enough on its own — a reader has to be able to
    // read the fact in prose.
    expect(protocol?.note).toContain("read the bear case first");
    expect(protocol?.note).toContain("THESIS_JUDGE_ORDER=bear-first");
    expect(
      report.appendix.missingData.some(
        (entry) => entry.field === "llm.judge.case-order" && entry.reason === protocol?.note,
      ),
    ).toBe(true);
  });

  it("falls back to the payload fingerprint when no job seed is threaded", async () => {
    const { payload } = buildInputs();
    const mock = new MockRunPass();
    mock.onJson("llm.judge", fakeJudgeOutput());
    const run = await runJudgePass(
      makeDeps(mock, { jobSeed: undefined }),
      payload,
      analystCase("bull"),
      analystCase("bear"),
    );
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    // Deterministic and reproducible: a seedless caller draws from the payload
    // fingerprint (version:hash) rather than from anything random.
    expect(run.result.judgeProtocol?.seed).toBe(payloadFingerprint(payload));
    expect(run.result.judgeProtocol?.order).toBe(
      resolveJudgeOrder("random", payloadFingerprint(payload)).order,
    );
  });
});

/* ------------------------------------------------------------------------ *
 * (a continued) `both` — two judge passes, reconciled
 * ------------------------------------------------------------------------ */

describe("THESIS_JUDGE_ORDER=both", () => {
  it("declares its cost as two judge passes and every other setting as one", () => {
    expect(JUDGE_PASSES_PER_SETTING.both).toBe(2);
    for (const setting of JUDGE_ORDER_SETTINGS.filter((s) => s !== "both")) {
      expect(JUDGE_PASSES_PER_SETTING[setting]).toBe(1);
    }
  });

  it("runs the judge twice with the orders swapped and merges both requests' billing", async () => {
    const { payload } = buildInputs();
    const mock = new MockRunPass();
    mock.onJson("llm.judge", fakeJudgeOutput(), { costUsd: 0.4 });
    mock.onJson("llm.judge", fakeJudgeOutput(), { costUsd: 0.6 });

    const run = await runJudgePass(
      makeDeps(mock, { judgeOrder: "both" }),
      payload,
      analystCase("bull"),
      analystCase("bear"),
    );
    expect(run.ok).toBe(true);
    if (!run.ok) return;

    const calls = mock.calls.filter((call) => call.field === "llm.judge");
    expect(calls).toHaveLength(2);
    const first = caseOffsets(calls[0].messages);
    const second = caseOffsets(calls[1].messages);
    // Mirrored: whichever side led the first request trails in the second.
    expect(first.bull < first.bear).toBe(second.bull > second.bear);
    // Two paid requests, one settled pass: the cost log must see both.
    expect(run.result.costUsd).toBeCloseTo(1.0, 10);
    expect(run.result.usage.input_tokens).toBe(2000);
  });

  it("reports agreement when the mirrored pass produced the same grades and probabilities", async () => {
    const { payload } = buildInputs();
    const mock = new MockRunPass();
    mock.onJson("llm.judge", fakeJudgeOutput());
    mock.onJson("llm.judge", fakeJudgeOutput());
    const run = await runJudgePass(
      makeDeps(mock, { judgeOrder: "both" }),
      payload,
      analystCase("bull"),
      analystCase("bear"),
    );
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const reconciliation = run.result.judgeProtocol?.reconciliation;
    expect(reconciliation?.performed).toBe(true);
    expect(reconciliation?.agreed).toBe(true);
    expect(reconciliation?.disagreements).toEqual([]);
    expect(reconciliation?.comparedFields).toEqual(reconciliationFields());
  });

  it("keeps the seeded pass and discloses every order-sensitive field when they differ", async () => {
    const { bundle, computed, payload } = buildInputs();
    const mock = new MockRunPass();
    mock.onJson("llm.judge", fakeJudgeOutput({ fundamentals: "B", bullProbability: 0.34 }));
    mock.onJson("llm.judge", fakeJudgeOutput({ fundamentals: "D", bullProbability: 0.5 }));

    const run = await runJudgePass(
      makeDeps(mock, { judgeOrder: "both" }),
      payload,
      analystCase("bull"),
      analystCase("bear"),
    );
    expect(run.ok).toBe(true);
    if (!run.ok) return;

    // The PRIMARY output is the report — the two are never averaged into a third
    // the model never produced.
    expect(run.result.output.verdict.gradeStrip.fundamentals.grade).toBe("B");
    const reconciliation = run.result.judgeProtocol?.reconciliation;
    expect(reconciliation?.agreed).toBe(false);
    expect(reconciliation?.disagreements).toEqual(
      expect.arrayContaining([
        { field: "verdict.gradeStrip.fundamentals.grade", primary: "B", secondary: "D" },
        { field: "valuation.scenarios.bull.probability", primary: "0.34", secondary: "0.50" },
      ]),
    );

    const report = assembleReport(
      {
        symbol: "AAPL",
        bundle,
        computed,
        judgeOutput: run.result.output,
        verify: { verificationRate: null, log: [] },
        costEntries: [{ step: "synthesize", model: "claude-opus-4-8", costUsd: 1 }],
        model: "claude-opus-4-8",
        judgeProtocol: run.result.judgeProtocol,
      },
      GENERATED_AT,
    );
    const disclosed = report.appendix.missingData.filter((entry) =>
      entry.field.startsWith("llm.judge.order-sensitive."),
    );
    expect(disclosed.length).toBeGreaterThanOrEqual(2);
    expect(disclosed.every((entry) => entry.severity === "warn")).toBe(true);
    expect(report.meta.judgeProtocol?.note).toContain("differed on");
  });

  it("compares grades and probabilities only — prose differences are not disagreement", () => {
    // Two runs of a language model never write the same sentence. Comparing
    // prose would report a failure on every `both` run and teach the reader to
    // ignore the field, so reconciliation is scoped to the decisions.
    const primary = fakeJudgeOutput();
    const secondary = fakeJudgeOutput();
    secondary.verdict.synthesis =
      "An entirely different synthesis, worded differently, with the same conclusions and probabilities.";
    secondary.valuation.reverseDcf.narrative = "a differently worded reverse-DCF narrative";

    const agreed = reconcileJudgeOutputs(primary, secondary, "bear-first");
    expect(agreed.agreed).toBe(true);
    expect(agreed.comparedFields).toEqual(reconciliationFields());
    expect(agreed.comparedFields).toContain("verdict.gradeStrip.valuation.grade");
    expect(agreed.comparedFields).toContain("valuation.scenarios.base.probability");
    expect(agreed.comparedFields.some((field) => field.includes("synthesis"))).toBe(false);

    secondary.verdict.gradeStrip.valuation.grade = "F";
    const differed = reconcileJudgeOutputs(primary, secondary, "bear-first");
    expect(differed.agreed).toBe(false);
    expect(differed.disagreements).toEqual([
      { field: "verdict.gradeStrip.valuation.grade", primary: "B", secondary: "F" },
    ]);
    expect(differed.secondaryOrder).toBe("bear-first");
  });

  it("keeps the primary report when the mirrored pass fails, and says the check did not run", async () => {
    const { payload } = buildInputs();
    const mock = new MockRunPass();
    mock.onJson("llm.judge", fakeJudgeOutput());
    mock.on("llm.judge", {
      kind: "error",
      error: { kind: "transport", message: "mirrored judge attempt died" },
    });
    const run = await runJudgePass(
      makeDeps(mock, { judgeOrder: "both" }),
      payload,
      analystCase("bull"),
      analystCase("bear"),
    );
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const reconciliation = run.result.judgeProtocol?.reconciliation;
    expect(reconciliation?.performed).toBe(false);
    expect(reconciliation?.note).toContain("mirrored judge attempt died");
  });
});

/* ------------------------------------------------------------------------ *
 * (b) Length caps
 * ------------------------------------------------------------------------ */

describe("analyst case length cap", () => {
  it("states the exact enforced cap in the analyst prompt", () => {
    // A cap the analyst was never told about would be a trap, not a rule.
    expect(buildBullFraming()).toContain(`at most ${ANALYST_CASE_CHAR_CAP} characters`);
  });

  it("leaves a case inside the cap byte-identical", () => {
    const input = analystCase("bull");
    const capped = capAnalystCase(input);
    expect(capped.value).toEqual(input);
    expect(capped.presentation.truncated).toBe(false);
    expect(capped.presentation.droppedItems).toBe(0);
    expect(capped.presentation.chars).toBe(JSON.stringify(input).length);
    expect(capped.disclosure).toBe("");
  });

  it("truncates an oversized case by dropping trailing entries, and discloses what went", () => {
    const filler = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        text: `driver ${i} ${"x".repeat(200)}`,
        label: "FACT" as const,
        source: "payload",
        asOf: null,
      }));
    const oversized = analystCase("bull", {
      keyDrivers: filler(60),
      catalysts: filler(60),
      risksToCase: filler(60),
    });
    expect(JSON.stringify(oversized).length).toBeGreaterThan(ANALYST_CASE_CHAR_CAP);

    const capped = capAnalystCase(oversized);
    expect(capped.presentation.truncated).toBe(true);
    expect(capped.presentation.chars).toBeLessThanOrEqual(ANALYST_CASE_CHAR_CAP);
    expect(capped.presentation.originalChars).toBe(JSON.stringify(oversized).length);
    expect(capped.presentation.droppedItems).toBeGreaterThan(0);
    // Dropped from the cheapest end first; the thesis is never emptied.
    expect(capped.value.thesis.length).toBeGreaterThanOrEqual(1);
    expect(capped.value.catalysts.length).toBeLessThan(60);
    expect(capped.value.keyDrivers.length).toBe(60);
    // Disclosed, not silent.
    expect(capped.disclosure).toContain("exceeded the");
    expect(capped.disclosure).toContain("dropped");
    // The caller never has its object mutated.
    expect(oversized.catalysts).toHaveLength(60);
  });

  it("caps both sides identically and tells the judge both lengths", () => {
    const { payload } = buildInputs();
    const bull = analystCase("bull");
    const bear = analystCase("bear", {
      keyDrivers: Array.from({ length: 200 }, (_, i) => ({
        text: `bear driver ${i} ${"y".repeat(200)}`,
        label: "FACT" as const,
        source: "payload",
        asOf: null,
      })),
    });
    const presentation = buildJudgePresentation({ setting: "bull-first", seed: "s", bull, bear });
    expect(presentation.bull.presentation.capChars).toBe(
      presentation.bear.presentation.capChars,
    );

    const text = JSON.stringify(judgeUserTurns(payload, bull, bear, presentation));
    expect(text).toContain("CASE LENGTHS AND SELF-ASSESSMENTS");
    expect(text).toContain(`BULL: ${presentation.bull.presentation.chars} characters`);
    expect(text).toContain(`BEAR: ${presentation.bear.presentation.chars} characters`);
    expect(text).toContain("Length is not evidence");
    expect(text).toContain("TRUNCATED");
    // The judge receives the CAPPED bear case, not the original.
    expect(text).not.toContain("bear driver 199");
  });

  it("discloses a truncated side in the report manifest and metadata", async () => {
    const { bundle, computed, payload } = buildInputs();
    const mock = new MockRunPass();
    mock.onJson("llm.judge", fakeJudgeOutput());
    const bull = analystCase("bull", {
      catalysts: Array.from({ length: 200 }, (_, i) => ({
        text: `catalyst ${i} ${"z".repeat(200)}`,
        label: "ESTIMATE" as const,
        source: "payload",
        asOf: null,
      })),
    });
    const run = await runJudgePass(makeDeps(mock), payload, bull, analystCase("bear"));
    expect(run.ok).toBe(true);
    if (!run.ok) return;

    const report = assembleReport(
      {
        symbol: "AAPL",
        bundle,
        computed,
        judgeOutput: run.result.output,
        verify: { verificationRate: null, log: [] },
        costEntries: [{ step: "synthesize", model: "claude-opus-4-8", costUsd: 1 }],
        model: "claude-opus-4-8",
        judgeProtocol: run.result.judgeProtocol,
      },
      GENERATED_AT,
    );
    expect(report.meta.judgeProtocol?.bull.truncated).toBe(true);
    expect(report.meta.judgeProtocol?.bear.truncated).toBe(false);
    expect(report.meta.judgeProtocol?.note).toContain("after truncation");
    const entry = report.appendix.missingData.find((m) => m.field === "llm.bull.length-cap");
    expect(entry?.severity).toBe("warn");
    expect(entry?.reason).toContain("Both sides share the same cap");
  });
});

/* ------------------------------------------------------------------------ *
 * (c) case_strength
 * ------------------------------------------------------------------------ */

describe("analyst case_strength", () => {
  it("accepts 1-5, rejects out-of-range and fractional scores", () => {
    const base = analystCase("bull");
    for (const value of [1, 2, 3, 4, 5]) {
      expect(ANALYST_CASE_SCHEMA.safeParse({ ...base, case_strength: value }).success).toBe(true);
    }
    for (const value of [0, 6, 2.5, -1]) {
      expect(ANALYST_CASE_SCHEMA.safeParse({ ...base, case_strength: value }).success).toBe(false);
    }
  });

  it("still parses an analyst artifact persisted before the field existed", () => {
    // Resume reads bull/bear snapshots written by an older build; an additive
    // field must never invalidate one.
    const legacy = analystCase("bull");
    delete (legacy as { case_strength?: number }).case_strength;
    expect(ANALYST_CASE_SCHEMA.safeParse(legacy).success).toBe(true);
    expect(ANALYST_CASE_SCHEMA.safeParse({ ...legacy, case_strength: null }).success).toBe(true);
  });

  it("requires it in the schema a FRESH analyst pass is asked to fill", () => {
    const json = analystCaseToJsonSchema();
    const required = json.required as string[];
    expect(required).toContain("case_strength");
    const property = (json.properties as Record<string, Record<string, unknown>>).case_strength;
    expect(property.type).toBe("integer");
  });

  it("states the rubric to the analysts and tells the judge it may discount a weak side", () => {
    expect(CASE_STRENGTH_RUBRIC).toContain("case_strength");
    for (const score of ["1 —", "2 —", "3 —", "4 —", "5 —"]) {
      expect(CASE_STRENGTH_RUBRIC).toContain(score);
    }
    expect(buildBullFraming()).toContain(CASE_STRENGTH_RUBRIC);
    const judge = buildJudgeFraming();
    expect(judge).toContain("You MAY DISCOUNT A");
    expect(judge).toContain("WEAK SIDE");
    expect(judge).toContain(CASE_STRENGTH_RUBRIC);
  });

  it("carries both scores into the judge turn and the report metadata", async () => {
    const { bundle, computed, payload } = buildInputs();
    const mock = new MockRunPass();
    mock.onJson("llm.judge", fakeJudgeOutput());
    const run = await runJudgePass(
      makeDeps(mock),
      payload,
      analystCase("bull"), // case_strength 4
      analystCase("bear"), // case_strength 2
    );
    expect(run.ok).toBe(true);
    if (!run.ok) return;

    const judgeText = JSON.stringify(mock.calls[0].messages);
    expect(judgeText).toContain("self-assessed strength 4/5");
    expect(judgeText).toContain("self-assessed strength 2/5");

    const report = assembleReport(
      {
        symbol: "AAPL",
        bundle,
        computed,
        judgeOutput: run.result.output,
        verify: { verificationRate: null, log: [] },
        costEntries: [{ step: "synthesize", model: "claude-opus-4-8", costUsd: 1 }],
        model: "claude-opus-4-8",
        judgeProtocol: run.result.judgeProtocol,
      },
      GENERATED_AT,
    );
    expect(report.meta.judgeProtocol?.bull.caseStrength).toBe(4);
    expect(report.meta.judgeProtocol?.bear.caseStrength).toBe(2);
    expect(report.meta.judgeProtocol?.note).toContain("bull 4, bear 2");
  });

  it("reports a missing self-assessment as missing rather than inventing one", () => {
    const legacy = analystCase("bull");
    delete (legacy as { case_strength?: number }).case_strength;
    const presentation = buildJudgePresentation({
      setting: "bull-first",
      seed: "s",
      bull: legacy,
      bear: analystCase("bear"),
    });
    expect(presentation.bull.presentation.caseStrength).toBeNull();
  });
});

/* ------------------------------------------------------------------------ *
 * (f) Shared model family
 * ------------------------------------------------------------------------ */

describe("shared judge/analyst model family", () => {
  it("reads the family from the registry, not from an id prefix", () => {
    expect(
      sharedModelFamilyOf([
        { step: "bull", effectiveModel: "claude-opus-4-8" },
        { step: "bear", effectiveModel: "claude-opus-4-8" },
        { step: "synthesize", effectiveModel: "claude-opus-4-8" },
      ]),
    ).toEqual({ shared: true, analystFamily: "opus", judgeFamily: "opus" });

    // The haiku judge floor puts the judge in another family — the honest case.
    expect(
      sharedModelFamilyOf([
        { step: "bull", effectiveModel: "claude-haiku-4-5" },
        { step: "bear", effectiveModel: "claude-haiku-4-5" },
        { step: "synthesize", effectiveModel: "claude-sonnet-5" },
      ]),
    ).toEqual({ shared: false, analystFamily: "haiku", judgeFamily: "sonnet" });

    // Two analyst sides served by different families is not a clean claim.
    expect(
      sharedModelFamilyOf([
        { step: "bull", effectiveModel: "claude-opus-4-8" },
        { step: "bear", effectiveModel: "claude-sonnet-5" },
        { step: "synthesize", effectiveModel: "claude-opus-4-8" },
      ]).shared,
    ).toBe(false);

    // An unknown id yields no family and therefore no claim.
    expect(
      sharedModelFamilyOf([
        { step: "bull", effectiveModel: "made-up-model" },
        { step: "bear", effectiveModel: "made-up-model" },
        { step: "synthesize", effectiveModel: "made-up-model" },
      ]),
    ).toEqual({ shared: false, analystFamily: null, judgeFamily: null });
  });

  it("appends the sentence to the judge's execution note only when the family is shared", () => {
    const entries = (analyst: string, judge: string) =>
      ["bull", "bear", "synthesize"].map((step) =>
        buildExecutionMetadataEntry({
          step,
          requestedModel: step === "synthesize" ? judge : analyst,
          effectiveModel: step === "synthesize" ? judge : analyst,
          requestedEffort: "high",
          fallbackUsed: false,
        }),
      );

    const shared = annotateSharedModelFamily(entries("claude-opus-4-8", "claude-opus-4-8"));
    const judgeEntry = shared.find((entry) => entry.step === "synthesize");
    expect(judgeEntry?.note).toContain("the same model family that wrote both");
    expect(shared.find((entry) => entry.step === "bull")?.note).toBeUndefined();

    const notShared = annotateSharedModelFamily(entries("claude-haiku-4-5", "claude-sonnet-5"));
    expect(notShared.find((entry) => entry.step === "synthesize")?.note ?? "").not.toContain(
      "the same model family that wrote both",
    );
  });

  it("discloses a same-family judge in metadata, the reader sentence and the manifest", () => {
    const { bundle, computed } = buildInputs();
    const build = (analyst: string, judge: string): Report =>
      assembleReport(
        {
          symbol: "AAPL",
          bundle,
          computed,
          judgeOutput: fakeJudgeOutput(),
          verify: { verificationRate: null, log: [] },
          costEntries: [
            { step: "bull", model: analyst, costUsd: 0.5 },
            { step: "bear", model: analyst, costUsd: 0.5 },
            { step: "synthesize", model: judge, costUsd: 0.5 },
          ],
          model: analyst,
          judgeProtocol: buildJudgeProtocolDraft(
            buildJudgePresentation({
              setting: "bull-first",
              seed: "s",
              bull: analystCase("bull"),
              bear: analystCase("bear"),
            }),
          ),
        },
        GENERATED_AT,
      );

    const same = build("claude-opus-4-8", "claude-opus-4-8");
    expect(same.meta.judgeProtocol?.sharedModelFamily).toEqual({
      shared: true,
      analystFamily: "opus",
      judgeFamily: "opus",
    });
    expect(same.meta.judgeProtocol?.note).toContain("grading output from its own family");
    const warning = same.appendix.missingData.find((m) => m.field === "llm.judge.model-family");
    expect(warning?.severity).toBe("warn");
    expect(warning?.reason).toContain("not independent");

    const floored = build("claude-haiku-4-5", "claude-sonnet-5");
    expect(floored.meta.judgeProtocol?.sharedModelFamily.shared).toBe(false);
    expect(
      floored.appendix.missingData.some((m) => m.field === "llm.judge.model-family"),
    ).toBe(false);
    expect(floored.meta.judgeProtocol?.note).toContain("the analysts on haiku");
  });
});

/* ------------------------------------------------------------------------ *
 * The reader actually sees it
 * ------------------------------------------------------------------------ */

describe("judgement protocol reaches the rendered report", () => {
  it("prints the protocol sentence and the checks table in both exports", () => {
    const { bundle, computed } = buildInputs();
    const checks = {
      direction: { checked: 4, passed: 3, failed: 1, rate: 0.75 },
      period: { checked: 2, passed: 2, failed: 0, rate: 1 },
      unit: { checked: 0, passed: 0, failed: 0, rate: null },
      namedIndividual: { checked: 1, passed: 1, failed: 0, rate: 1 },
    };
    const report = assembleReport(
      {
        symbol: "AAPL",
        bundle,
        computed,
        judgeOutput: fakeJudgeOutput(),
        verify: { verificationRate: 0.9, checks, log: [] },
        costEntries: [
          { step: "bull", model: "claude-opus-4-8", costUsd: 0.5 },
          { step: "bear", model: "claude-opus-4-8", costUsd: 0.5 },
          { step: "synthesize", model: "claude-opus-4-8", costUsd: 0.5 },
        ],
        model: "claude-opus-4-8",
        judgeProtocol: buildJudgeProtocolDraft(
          buildJudgePresentation({
            setting: "random",
            seed: "job-seed-a",
            bull: analystCase("bull"),
            bear: analystCase("bear"),
          }),
        ),
      },
      GENERATED_AT,
    );

    const note = report.meta.judgeProtocol?.note ?? "";
    expect(note).not.toBe("");

    const markdown = reportToMarkdown(report);
    expect(markdown).toContain("Judgement protocol");
    expect(markdown).toContain("read the");
    expect(markdown).toContain("Deterministic checks");
    expect(markdown).toContain("3/4"); // direction: passed / checked
    expect(markdown).toContain("n/a — nothing eligible"); // unit: nothing to check

    const html = reportToPrintHtml(report);
    expect(html).toContain("Judgement protocol");
    expect(html).toContain("Deterministic checks");
    expect(html).toContain("3/4");
    // "checked" is a separate table from citation coverage, never merged in.
    expect(html).toContain("Citation coverage");
  });
});

/* ------------------------------------------------------------------------ *
 * Request-shaping invariants the runner's preflight depends on
 * ------------------------------------------------------------------------ */

describe("judge request shaping stays reproducible", () => {
  it("rebuilds a byte-identical request from the same deps, so preflight validates the real one", () => {
    const { payload } = buildInputs();
    const mock = new MockRunPass();
    const deps = makeDeps(mock, { judgeOrder: "random", jobSeed: "job-42" });
    const bull = analystCase("bull");
    const bear = analystCase("bear");
    const a = buildJudgeRunPassArgs(deps, payload, bull, bear);
    const b = buildJudgeRunPassArgs(deps, payload, bull, bear);
    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages));
  });

  it("keeps the per-request admission fields the cost plumbing needs", () => {
    const { payload } = buildInputs();
    const mock = new MockRunPass();
    const admission = { token: "admission-object" };
    const deps = makeDeps(mock, { admissionFor: () => admission });
    const args = buildJudgeRunPassArgs(deps, payload, analystCase("bull"), analystCase("bear"));
    expect(args.admission).toBe(admission);
    expect(args.reservationPass).toBe("synthesize");
  });
});
