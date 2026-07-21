/**
 * Keyless / degraded END-TO-END report + accuracy-consistency tests
 * (Phase 4 gate, the application contract §10 + §1 rules #1/#4).
 *
 * Two guarantees are proven here, both executable:
 *
 *  (A) The data-only (no-ANTHROPIC_API_KEY) report path assembles a
 *      ReportSchema-VALID report that:
 *        - carries the data-only disclosure (analysis.llm critical manifest entry
 *          + the "data-only" synthesis + the standing not-investment-advice
 *          disclaimer),
 *        - contains ZERO fabricated analyzed numbers or scenario odds: there
 *          are no TracedNumber placeholders and unavailable probabilities are null,
 *        - never presents a fabricated GRADE as analyzed — every graded section
 *          is the ungraded "F" data-only flag with its disclosing reasoning.
 *
 *  (B) Accuracy-consistency of the FACT-grounding chain: a payload assembled from
 *      a known ComputedMetrics fixture carries the SAME figures the compute stage
 *      produced — no drift / transcription error between Stage B output and what
 *      the LLM would receive. This is the executable proof that the number the
 *      model sees is the number we computed.
 *
 * NO network, NO live LLM. Deterministic clock. No 'any'.
 */

import { describe, expect, it } from "vitest";

import { runStageB, type ComputedMetrics } from "@/pipeline/compute";
import { validateBundle } from "@/pipeline/stageA/validate";
import {
  assembleContextPayload,
  serializePayloadForPrompt,
  type ContextPayload,
} from "@/pipeline/stageC/payload";
import { collectTracedNumbers } from "@/pipeline/stageC/passes";
import { buildDataOnlyReport } from "@/pipeline/jobRunner";
import { ReportSchema, DISCLAIMER_TEXT, type Report, type TracedNumber } from "@/report/schema";
import type { DataBundle } from "@/pipeline/types";
import type { ValidationReport } from "@/pipeline/stageA/validate";

/* ------------------------------------------------------------------------ *
 * Fixtures — a realistic AAPL bundle whose statements let Stage B compute
 * real numbers. Everything not needed is a gap; runStageB / validateBundle
 * degrade gracefully. (Mirrors the shape used by the Stage C suite.)
 * ------------------------------------------------------------------------ */

const BUILT_AT = "2026-07-06T00:00:00.000Z";
const GENERATED_AT = "2026-07-06T12:00:00.000Z";
const NOW = new Date("2026-07-06T00:00:00Z");

function ok<T>(data: T, asOf: string, endpoint = "fmp") {
  return {
    ok: true as const,
    value: { data, asOf, source: "fmp" as const, endpoint, fetchedAt: BUILT_AT },
  };
}
const gap = { ok: false as const, gap: { field: "x", reason: "fixture gap", severity: "info" as const } };

function fmpPayload<T>(rows: T[], asOf: string, endpoint: string) {
  return ok({ rows, raw: {} }, asOf, endpoint);
}

function fixtureBundle(symbol = "AAPL"): DataBundle {
  const incomeAnnual = fmpPayload(
    [
      { date: "2025-09-27", fiscalYear: "2025", period: "FY", revenue: 416161000000, grossProfit: 190000000000, operatingIncome: 127000000000, ebit: 127000000000, netIncome: 112010000000, epsDiluted: 7.1, weightedAverageShsOutDil: 15100000000, interestExpense: 3900000000, incomeBeforeTax: 130000000000, incomeTaxExpense: 18000000000, reportedCurrency: "USD", depreciationAndAmortization: 11500000000 },
      { date: "2024-09-28", fiscalYear: "2024", period: "FY", revenue: 391035000000, grossProfit: 180683000000, operatingIncome: 123216000000, ebit: 123216000000, netIncome: 93736000000, epsDiluted: 6.08, weightedAverageShsOutDil: 15400000000, interestExpense: 3800000000, incomeBeforeTax: 123485000000, incomeTaxExpense: 29749000000, reportedCurrency: "USD", depreciationAndAmortization: 11445000000 },
      { date: "2023-09-30", fiscalYear: "2023", period: "FY", revenue: 383285000000, grossProfit: 169148000000, operatingIncome: 114301000000, ebit: 114301000000, netIncome: 96995000000, epsDiluted: 6.13, weightedAverageShsOutDil: 15812000000, interestExpense: 3933000000, incomeBeforeTax: 113736000000, incomeTaxExpense: 16741000000, reportedCurrency: "USD", depreciationAndAmortization: 11519000000 },
      { date: "2022-09-24", fiscalYear: "2022", period: "FY", revenue: 394328000000, grossProfit: 170782000000, operatingIncome: 119437000000, ebit: 119437000000, netIncome: 99803000000, epsDiluted: 6.11, weightedAverageShsOutDil: 16326000000, interestExpense: 2931000000, incomeBeforeTax: 119103000000, incomeTaxExpense: 19300000000, reportedCurrency: "USD", depreciationAndAmortization: 11104000000 },
      { date: "2021-09-25", fiscalYear: "2021", period: "FY", revenue: 365817000000, grossProfit: 152836000000, operatingIncome: 108949000000, ebit: 108949000000, netIncome: 94680000000, epsDiluted: 5.61, weightedAverageShsOutDil: 16865000000, interestExpense: 2645000000, incomeBeforeTax: 109207000000, incomeTaxExpense: 14527000000, reportedCurrency: "USD", depreciationAndAmortization: 11284000000 },
    ],
    "2025-09-27",
    "income-statement",
  );
  const balanceAnnual = fmpPayload(
    [
      { date: "2025-09-27", totalAssets: 365000000000, totalLiabilities: 300000000000, totalStockholdersEquity: 65000000000, totalEquity: 65000000000, totalDebt: 100000000000, netDebt: 70000000000, cashAndCashEquivalents: 30000000000, cashAndShortTermInvestments: 55000000000, goodwill: 0, intangibleAssets: 0, minorityInterest: 0, preferredStock: 0 },
      { date: "2024-09-28", totalAssets: 364980000000, totalLiabilities: 308030000000, totalStockholdersEquity: 56950000000, totalEquity: 56950000000, totalDebt: 106629000000, netDebt: 76686000000, cashAndCashEquivalents: 29943000000, cashAndShortTermInvestments: 65171000000 },
      { date: "2023-09-30", totalAssets: 352583000000, totalLiabilities: 290437000000, totalStockholdersEquity: 62146000000, totalEquity: 62146000000, totalDebt: 111088000000, netDebt: 81123000000, cashAndCashEquivalents: 29965000000, cashAndShortTermInvestments: 61555000000 },
      { date: "2022-09-24", totalAssets: 352755000000, totalLiabilities: 302083000000, totalStockholdersEquity: 50672000000, totalEquity: 50672000000, totalDebt: 120069000000, netDebt: 96423000000, cashAndCashEquivalents: 23646000000, cashAndShortTermInvestments: 48304000000 },
      { date: "2021-09-25", totalAssets: 351002000000, totalLiabilities: 287912000000, totalStockholdersEquity: 63090000000, totalEquity: 63090000000, totalDebt: 124719000000, netDebt: 89779000000, cashAndCashEquivalents: 34940000000, cashAndShortTermInvestments: 62639000000 },
    ],
    "2025-09-27",
    "balance-sheet",
  );
  const cashflowAnnual = fmpPayload(
    [
      { date: "2025-09-27", operatingCashFlow: 118000000000, capitalExpenditure: -11000000000, freeCashFlow: 107000000000, stockBasedCompensation: 12000000000, commonStockRepurchased: -90000000000, netIncome: 112010000000, depreciationAndAmortization: 11500000000 },
      { date: "2024-09-28", operatingCashFlow: 118254000000, capitalExpenditure: -9447000000, freeCashFlow: 108807000000, stockBasedCompensation: 11688000000, commonStockRepurchased: -94949000000, netIncome: 93736000000, depreciationAndAmortization: 11445000000 },
      { date: "2023-09-30", operatingCashFlow: 110543000000, capitalExpenditure: -10959000000, freeCashFlow: 99584000000, stockBasedCompensation: 10833000000, commonStockRepurchased: -77550000000, netIncome: 96995000000, depreciationAndAmortization: 11519000000 },
      { date: "2022-09-24", operatingCashFlow: 122151000000, capitalExpenditure: -10708000000, freeCashFlow: 111443000000, stockBasedCompensation: 9038000000, commonStockRepurchased: -89402000000, netIncome: 99803000000, depreciationAndAmortization: 11104000000 },
      { date: "2021-09-25", operatingCashFlow: 104038000000, capitalExpenditure: -11085000000, freeCashFlow: 92953000000, stockBasedCompensation: 7906000000, commonStockRepurchased: -85971000000, netIncome: 94680000000, depreciationAndAmortization: 11284000000 },
    ],
    "2025-09-27",
    "cash-flow",
  );

  const asOf: Record<string, string> = {
    profile: "2026-07-01",
    quote: "2026-07-05",
    "statements.incomeAnnual": "2025-09-27",
    "macro.core.DGS10": "2026-07-04",
  };

  const bundle = {
    symbol,
    builtAt: BUILT_AT,
    profile: ok({ rows: [{ companyName: "Apple Inc.", sector: "Technology", industry: "Consumer Electronics", price: 210, marketCap: 3150000000000, beta: 1.2, currency: "USD", country: "US", ipoDate: "1980-12-12", isAdr: false, isEtf: false, isFund: false }], raw: {} }, "2026-07-01", "profile"),
    quote: ok({ rows: [{ symbol, price: 210, marketCap: 3150000000000, dayLow: 208, dayHigh: 212, yearLow: 164, yearHigh: 260, volume: 44000000, timestamp: 1751731200 }], raw: {} }, "2026-07-05", "quote"),
    statements: {
      incomeAnnual,
      incomeQuarterly: gap,
      balanceAnnual,
      balanceQuarterly: gap,
      cashflowAnnual,
      cashflowQuarterly: gap,
      periods: { annualRequested: 10, quarterlyRequested: 8 },
    },
    keyMetrics: gap,
    keyMetricsTtm: fmpPayload([{ returnOnEquity: 1.5, returnOnInvestedCapital: 0.55, effectiveTaxRate: 0.15 }], "2026-03-28", "key-metrics-ttm"),
    ratios: gap,
    ratiosTtm: fmpPayload([{ effectiveTaxRate: 0.15, netProfitMargin: 0.27 }], "2026-03-28", "ratios-ttm"),
    financialGrowth: gap,
    financialScores: gap,
    enterpriseValues: fmpPayload([{ date: "2025-09-27", marketCapitalization: 3100000000000, enterpriseValue: 3170000000000 }], "2025-09-27", "enterprise-values"),
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
    macro: {
      core: { DGS10: ok([{ date: "2026-07-04", value: 4.4 }], "2026-07-04", "fred") },
      sector: {},
      gicsSector: "Technology",
      attribution: "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.",
    },
    treasury: fmpPayload([{ date: "2026-07-04", year10: 4.4 }], "2026-07-04", "treasury"),
    marketRiskPremium: fmpPayload([{ totalEquityRiskPremium: 4.5 }], "2026-07-01", "market-risk-premium"),
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
    gaps: [{ field: "sharesFloat", reason: "float unavailable", severity: "warn" as const }],
  } as unknown as DataBundle;
  return bundle;
}

function buildInputs(symbol = "AAPL"): {
  bundle: DataBundle;
  computed: ComputedMetrics;
  validation: ValidationReport;
  payload: ContextPayload;
} {
  const bundle = fixtureBundle(symbol);
  const computed = runStageB(bundle);
  const validation = validateBundle(bundle, { now: NOW });
  const payload = assembleContextPayload(bundle, computed, validation);
  return { bundle, computed, validation, payload };
}

/** The exact set of graded sections in a Report (verdict grade strip + section grades). */
function collectGradeBlocks(report: Report): Report["fundamentals"]["graded"][] {
  const strip = report.verdict.gradeStrip;
  return [
    strip.fundamentals, strip.valuation, strip.technicals, strip.quality, strip.leadership, strip.moat,
    report.fundamentals.graded,
    report.valuation.graded,
    report.quality.graded,
    report.technicals.graded,
    report.leadership.graded,
    report.competitive.moatGraded,
  ];
}

/* ------------------------------------------------------------------------ *
 * (A) Data-only report path — schema-valid, disclosed, never fabricated
 * ------------------------------------------------------------------------ */

describe("data-only report (keyless / no-LLM degraded path)", () => {
  function dataOnly(reason = "ANTHROPIC_API_KEY not set — analysis passes skipped"): Report {
    const { bundle, computed, validation } = buildInputs();
    return buildDataOnlyReport({
      symbol: "AAPL",
      companyName: "Apple Inc.",
      generatedAt: GENERATED_AT,
      model: "none",
      costUsd: 0,
      bundle,
      validation,
      computed,
      costBreakdown: [],
      reason,
    });
  }

  it("assembles a ReportSchema-valid report", () => {
    const report = dataOnly();
    expect(() => ReportSchema.parse(report)).not.toThrow();
    expect(report.meta.symbol).toBe("AAPL");
    expect(report.meta.companyName).toBe("Apple Inc.");
  });

  it("carries the data-only disclosure and the standing not-investment-advice disclaimer", () => {
    const reason = "ANTHROPIC_API_KEY not set — analysis passes skipped";
    const report = dataOnly(reason);

    // The standing disclaimer is present (rule: every report is informational only).
    expect(report.meta.disclaimer).toBe(DISCLAIMER_TEXT);
    // verificationRate is null — no verification ran on a data-only report.
    expect(report.meta.verificationRate).toBeNull();
    // The data-only condition is recorded as a CRITICAL manifest entry with the reason.
    const analysisGap = report.appendix.missingData.find((m) => m.field === "analysis.llm");
    expect(analysisGap).toBeDefined();
    expect(analysisGap?.severity).toBe("critical");
    expect(analysisGap?.reason).toBe(reason);
    // The verdict synthesis explicitly frames itself as data-only.
    expect(report.verdict.synthesis.toLowerCase()).toContain("data-only");
  });

  it("presents NO fabricated grade as analyzed — every graded section is the ungraded data-only flag", () => {
    const report = dataOnly();
    for (const block of collectGradeBlocks(report)) {
      // The data-only stub grades everything "F" with an explicit ungraded reason.
      expect(block.grade).toBe("F");
      expect(block.oneLineWhy.toLowerCase()).toContain("data-only");
      expect(block.confidence).toBe("low");
      // Reasoning discloses the LLM did not run — never a fabricated analytic claim.
      expect(block.reasoning.some((c) => /did not run|data-only/i.test(c.text))).toBe(true);
    }
  });

  it("contains no fabricated numeric placeholders", () => {
    const report = dataOnly();
    const numbers: TracedNumber[] = collectTracedNumbers(report);
    expect(numbers).toEqual([]);
    expect(report.valuation.scenarios.map((scenario) => scenario.probability)).toEqual([
      null,
      null,
      null,
    ]);
    expect(report.meta.provenanceCoverage?.numeric).toEqual({
      supported: 0,
      total: 0,
      rate: null,
    });
    expect(report.appendix.provenanceCoverage).toEqual(report.meta.provenanceCoverage);
  });

  it("appendix discloses the fetched sources + every gap (never papered over)", () => {
    const report = dataOnly();
    // Sources come from the bundle's asOf map (what WAS fetched).
    expect(report.appendix.sources.length).toBeGreaterThan(0);
    // The seeded sharesFloat gap is disclosed alongside the analysis.llm gap.
    expect(report.appendix.missingData.some((m) => m.field === "sharesFloat")).toBe(true);
    expect(report.appendix.missingData.some((m) => m.field === "analysis.llm")).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * (B) Accuracy-consistency: compute output == what the LLM receives
 * ------------------------------------------------------------------------ */

describe("accuracy-consistency: payload figures match ComputedMetrics (no drift)", () => {
  it("serialized payload carries the exact computed revenue-CAGR values", () => {
    const { computed, payload } = buildInputs();
    const serialized = serializePayloadForPrompt(payload);

    // The fixture's real statements yield at least one computed (non-null) revenue CAGR.
    const realCagrs = computed.growth.revenueCagrs.filter(
      (c): c is typeof c & { cagrPct: number } => typeof c.cagrPct === "number",
    );
    expect(realCagrs.length).toBeGreaterThan(0);
    for (const c of realCagrs) {
      // The payload rounds to <=4 dp with no trailing-zero noise (see payload.round()).
      const rendered = String(Number(c.cagrPct.toFixed(4)));
      // Find the matching payload figure by label + source; assert value equality.
      const fig = payload.computed
        .flatMap((s) => s.figures)
        .find((f) => f.label === `revenue CAGR ${c.windowYears}y` && f.source === "computed.growth.revenueCagrs");
      expect(fig).toBeDefined();
      // No drift: the number the model receives IS the number compute produced.
      expect(fig?.value).toBe(c.cagrPct);
      // …and the same value is present in the serialized text (what the LLM reads).
      expect(serialized).toContain(rendered);
    }
  });

  it("payload WACC / ROIC figures equal the computed returns block (no transcription error)", () => {
    const { computed, payload } = buildInputs();
    const figs = payload.computed.flatMap((s) => s.figures);

    const waccFig = figs.find((f) => f.label === "WACC" && f.source === "computed.returns.wacc");
    expect(waccFig).toBeDefined();
    expect(waccFig?.value).toBe(computed.returns.wacc.waccPct);

    const roicFig = figs.find((f) => f.label === "ROIC (latest)" && f.source === "computed.returns.roic");
    expect(roicFig).toBeDefined();
    expect(roicFig?.value).toBe(computed.returns.roic.latestRoicPct);
  });

  it("statement extract cells equal the source statement values (income statement)", () => {
    const { bundle, payload } = buildInputs();
    const incomeRows = bundle.statements.incomeAnnual.ok ? bundle.statements.incomeAnnual.value.data.rows : [];
    const fy2025 = incomeRows.find((r) => r.date === "2025-09-27");
    expect(fy2025).toBeDefined();

    const incomeBlock = payload.statements.find((b) => b.title.includes("Income statement"));
    expect(incomeBlock).toBeDefined();
    const revenueLine = incomeBlock?.lineItems.find((li) => li.lineItem === "revenue");
    const fy2025Cell = revenueLine?.byPeriod.find((c) => c.period === "2025-09-27");
    // The revenue the model sees is EXACTLY the fetched statement revenue — no drift.
    expect(fy2025Cell?.value).toBe(416161000000);
    expect(fy2025Cell?.value).toBe(fy2025?.revenue);
  });

  it("payload figures never fabricate a value for an absent input (gaps render as null, not a number)", () => {
    const { payload } = buildInputs();
    // analystEstimates was a gap → the estimates section must not carry a
    // consensus price-target figure (no invented number).
    const consensus = payload.estimates.figures.find((f) => f.label === "price target consensus");
    expect(consensus).toBeUndefined();
    // The quote section IS populated (real fixture), so its figures are non-null numbers.
    const price = payload.quote.figures.find((f) => f.label === "price");
    expect(price?.value).toBe(210);
  });
});
