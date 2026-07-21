/**
 * Invariant-1 hardening — deterministic injection of the remaining judge-path
 * numerics at assembly (extends the 2026-07-11 scenario-target / fair-value /
 * DCF-display pattern):
 *
 *  - valuation.multiples rows        ← Stage B multiples framework
 *  - valuation.reverseDcf implied*   ← Stage B reverse-DCF solve
 *  - quality.forensicScores numbers  ← Stage B forensics
 *  - business.segments[].sharePct    ← bundle segmentation totals
 *
 * Each suite proves: (a) deliberately WRONG judge-emitted values never survive
 * assembly, (b) a missing/suppressed computed side yields nulls/empty (never
 * fabricated), and (c) judge-authored PROSE (reverseDcf.narrative,
 * notApplicableReason) is preserved verbatim.
 *
 * The one judge-path bare numeric intentionally NOT overwritten is
 * leadership.executives[].tenureYears — biographical, not financial, grounded
 * in the payload's titleSince dates.
 *
 * NO network, NO live LLM. Fixture style mirrors tests/stageC.payload.passes.test.ts.
 */

import { describe, expect, it } from "vitest";

import { runStageB, type ComputedMetrics } from "@/pipeline/compute";
import type { DataBundle } from "@/pipeline/types";
import type { JudgeOutput, Report } from "@/report/schema";
import { ReportSchema } from "@/report/schema";
import {
  assembleReport,
  applyMultiples,
  applyReverseDcf,
  applyForensicScores,
  applySegmentShares,
  MULTIPLE_LABELS,
} from "@/pipeline/stageC/passes";

/* ------------------------------------------------------------------------ *
 * Fixtures (mirrors tests/stageC.payload.passes.test.ts)
 * ------------------------------------------------------------------------ */

const BUILT_AT = "2026-07-06T00:00:00.000Z";
const GENERATED_AT = "2026-07-06T12:00:00.000Z";

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

/** Same realistic AAPL-shaped bundle the payload/passes suite uses. */
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
  const incomeQuarterly = fmpPayload(
    [
      { date: "2026-03-28", fiscalYear: "2026", period: "Q2", revenue: 95000000000, operatingIncome: 30000000000, ebit: 30000000000, netIncome: 26000000000, epsDiluted: 2.01, weightedAverageShsOutDil: 15000000000, interestExpense: 950000000, incomeBeforeTax: 30500000000, incomeTaxExpense: 4500000000, depreciationAndAmortization: 2900000000, reportedCurrency: "USD" },
      { date: "2025-12-28", fiscalYear: "2026", period: "Q1", revenue: 124000000000, operatingIncome: 42000000000, ebit: 42000000000, netIncome: 36000000000, epsDiluted: 2.4, weightedAverageShsOutDil: 15050000000, interestExpense: 980000000, incomeBeforeTax: 42500000000, incomeTaxExpense: 6500000000, depreciationAndAmortization: 3000000000, reportedCurrency: "USD" },
      { date: "2025-09-27", fiscalYear: "2025", period: "Q4", revenue: 100000000000, operatingIncome: 30000000000, ebit: 30000000000, netIncome: 26000000000, epsDiluted: 1.7, weightedAverageShsOutDil: 15100000000, interestExpense: 970000000, incomeBeforeTax: 30500000000, incomeTaxExpense: 4500000000, depreciationAndAmortization: 2900000000, reportedCurrency: "USD" },
      { date: "2025-06-28", fiscalYear: "2025", period: "Q3", revenue: 94000000000, operatingIncome: 28000000000, ebit: 28000000000, netIncome: 24000000000, epsDiluted: 1.6, weightedAverageShsOutDil: 15150000000, interestExpense: 960000000, incomeBeforeTax: 28500000000, incomeTaxExpense: 4500000000, depreciationAndAmortization: 2850000000, reportedCurrency: "USD" },
    ],
    "2026-03-28",
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
      { date: "2025-09-27", operatingCashFlow: 118000000000, capitalExpenditure: -11000000000, freeCashFlow: 107000000000, stockBasedCompensation: 12000000000, commonStockRepurchased: -90000000000, netIncome: 112010000000, depreciationAndAmortization: 11500000000, netCashProvidedByOperatingActivities: 118000000000, netCashProvidedByInvestingActivities: -5000000000, commonStockIssuance: 0 },
      { date: "2024-09-28", operatingCashFlow: 118254000000, capitalExpenditure: -9447000000, freeCashFlow: 108807000000, stockBasedCompensation: 11688000000, commonStockRepurchased: -94949000000, netIncome: 93736000000, depreciationAndAmortization: 11445000000, netCashProvidedByOperatingActivities: 118254000000, netCashProvidedByInvestingActivities: 2935000000, commonStockIssuance: 0 },
      { date: "2023-09-30", operatingCashFlow: 110543000000, capitalExpenditure: -10959000000, freeCashFlow: 99584000000, stockBasedCompensation: 10833000000, commonStockRepurchased: -77550000000, netIncome: 96995000000, depreciationAndAmortization: 11519000000, netCashProvidedByOperatingActivities: 110543000000, netCashProvidedByInvestingActivities: 3705000000, commonStockIssuance: 0 },
      { date: "2022-09-24", operatingCashFlow: 122151000000, capitalExpenditure: -10708000000, freeCashFlow: 111443000000, stockBasedCompensation: 9038000000, commonStockRepurchased: -89402000000, netIncome: 99803000000, depreciationAndAmortization: 11104000000, netCashProvidedByOperatingActivities: 122151000000, netCashProvidedByInvestingActivities: -22354000000, commonStockIssuance: 0 },
      { date: "2021-09-25", operatingCashFlow: 104038000000, capitalExpenditure: -11085000000, freeCashFlow: 92953000000, stockBasedCompensation: 7906000000, commonStockRepurchased: -85971000000, netIncome: 94680000000, depreciationAndAmortization: 11284000000, netCashProvidedByOperatingActivities: 104038000000, netCashProvidedByInvestingActivities: -14545000000, commonStockIssuance: 1105000000 },
    ],
    "2025-09-27",
    "cash-flow",
  );
  const balanceQuarterly = fmpPayload(
    [{ date: "2026-03-28", totalAssets: 340000000000, totalLiabilities: 280000000000, totalStockholdersEquity: 60000000000, totalEquity: 60000000000, totalDebt: 98000000000, netDebt: 68000000000, cashAndCashEquivalents: 28000000000, cashAndShortTermInvestments: 52000000000 }],
    "2026-03-28",
    "balance-sheet",
  );
  const cashflowQuarterly = fmpPayload(
    [
      { date: "2026-03-28", operatingCashFlow: 28000000000, capitalExpenditure: -2800000000, freeCashFlow: 25200000000, depreciationAndAmortization: 2900000000, netIncome: 26000000000 },
      { date: "2025-12-28", operatingCashFlow: 40000000000, capitalExpenditure: -3000000000, freeCashFlow: 37000000000, depreciationAndAmortization: 3000000000, netIncome: 36000000000 },
      { date: "2025-09-27", operatingCashFlow: 30000000000, capitalExpenditure: -2900000000, freeCashFlow: 27100000000, depreciationAndAmortization: 2900000000, netIncome: 26000000000 },
      { date: "2025-06-28", operatingCashFlow: 27000000000, capitalExpenditure: -2700000000, freeCashFlow: 24300000000, depreciationAndAmortization: 2850000000, netIncome: 24000000000 },
    ],
    "2026-03-28",
    "cash-flow",
  );

  const asOf: Record<string, string> = {
    profile: "2026-07-01",
    quote: "2026-07-05",
    "statements.incomeAnnual": "2025-09-27",
    "edgar.item1a": "2025-09-27",
    "macro.core.DGS10": "2026-07-04",
  };

  const bundle = {
    symbol,
    builtAt: BUILT_AT,
    profile: ok({ rows: [{ companyName: "Apple Inc.", sector: "Technology", industry: "Consumer Electronics", price: 210, marketCap: 3150000000000, beta: 1.2, currency: "USD", country: "US", ipoDate: "1980-12-12", isAdr: false, isEtf: false, isFund: false }], raw: {} }, "2026-07-01", "profile"),
    quote: ok({ rows: [{ symbol, price: 210, marketCap: 3150000000000, dayLow: 208, dayHigh: 212, yearLow: 164, yearHigh: 260, volume: 44000000, timestamp: 1751731200 }], raw: {} }, "2026-07-05", "quote"),
    statements: {
      incomeAnnual,
      incomeQuarterly,
      balanceAnnual,
      balanceQuarterly,
      cashflowAnnual,
      cashflowQuarterly,
      periods: { annualRequested: 10, quarterlyRequested: 8 },
    },
    keyMetrics: gap,
    keyMetricsTtm: fmpPayload([{ returnOnEquity: 1.5, returnOnInvestedCapital: 0.55, effectiveTaxRate: 0.15 }], "2026-03-28", "key-metrics-ttm"),
    ratios: gap,
    ratiosTtm: fmpPayload([{ effectiveTaxRate: 0.15, netProfitMargin: 0.27 }], "2026-03-28", "ratios-ttm"),
    financialGrowth: gap,
    financialScores: gap,
    enterpriseValues: fmpPayload([{ date: "2025-09-27", marketCapitalization: 3100000000000, enterpriseValue: 3170000000000 }], "2025-09-27", "enterprise-values"),
    analystEstimates: fmpPayload(
      [
        { date: "2026-09-30", revenueAvg: 440000000000, epsAvg: 7.5, numAnalystsEps: 30 },
        { date: "2027-09-30", revenueAvg: 470000000000, epsAvg: 8.2, numAnalystsEps: 28 },
      ],
      "2026-07-01",
      "analyst-estimates",
    ),
    priceTargetConsensus: fmpPayload([{ targetConsensus: 240, targetHigh: 300, targetLow: 180 }], "2026-07-01", "price-target-consensus"),
    priceTargetSummary: gap,
    gradesConsensus: fmpPayload([{ consensus: "Buy", strongBuy: 15, buy: 10, hold: 5, sell: 1, strongSell: 0 }], "2026-07-01", "grades-consensus"),
    earningsHistory: gap,
    earningsCalendarNext: gap,
    transcript: {
      meta: fmpPayload([{ quarter: 2, fiscalYear: 2026, date: "2026-05-01" }], "2026-05-01", "transcript-dates"),
      latest: fmpPayload([{ symbol, period: "Q2", year: 2026, date: "2026-05-01", content: "CEO: Revenue grew this quarter. ".repeat(50) }], "2026-05-01", "earning-call-transcript"),
    },
    insiderTrades: fmpPayload([{ transactionDate: "2026-06-01", reportingName: "Tim Cook", typeOfOwner: "CEO", transactionType: "S-Sale", securitiesTransacted: 50000, price: 205 }], "2026-06-01", "insider-trades"),
    insiderStats: fmpPayload([{ year: 2026, quarter: 2, totalPurchases: 0, totalSales: 500000, acquiredDisposedRatio: 0.1 }], "2026-06-30", "insider-statistics"),
    institutional: {
      year: 2026,
      quarter: 1 as const,
      quarterEnd: "2026-03-31",
      positionsSummary: fmpPayload([{ investorsHolding: 5000, ownershipPercent: 62.5, newPositions: 120, closedPositions: 40, putCallRatio: 0.8 }], "2026-03-31", "13f-summary"),
      topHolders: fmpPayload([{ investorName: "Vanguard", sharesNumber: 1300000000 }], "2026-03-31", "13f-holders"),
    },
    peers: fmpPayload([{ symbol: "MSFT", companyName: "Microsoft", mktCap: 3400000000000 }, { symbol: "GOOGL", companyName: "Alphabet", mktCap: 2200000000000 }], "2026-07-01", "stock-peers"),
    segmentation: {
      product: fmpPayload([{ date: "2025-09-27", data: { iPhone: 210000000000, Mac: 30000000000, Services: 100000000000 } }], "2025-09-27", "revenue-product-segmentation"),
      geographic: fmpPayload([{ date: "2025-09-27", data: { Americas: 170000000000, Europe: 100000000000, GreaterChina: 70000000000 } }], "2025-09-27", "revenue-geographic-segmentation"),
    },
    executives: fmpPayload([{ name: "Tim Cook", title: "CEO", titleSince: "2011-08-24", pay: 99000000, currencyPay: "USD" }], "2026-07-01", "key-executives"),
    compensation: fmpPayload([{ nameAndPosition: "Tim Cook — CEO", year: 2025, total: 99000000, filingDate: "2026-01-10" }], "2026-01-10", "executive-compensation"),
    marketCapHistory: fmpPayload([{ date: "2025-09-27", marketCap: 3100000000000 }], "2025-09-27", "market-cap"),
    sharesFloat: gap,
    secFilings: gap,
    news: fmpPayload([{ publishedDate: "2026-07-03", publisher: "Reuters", title: "Apple ships new product", text: "The company launched a device." }], "2026-07-03", "news"),
    pressReleases: gap,
    eodPrices: gap,
    benchmarkPrices: { spy: gap, sectorEtf: gap, sectorEtfSymbol: null },
    shortInterest: ok({ symbol, issueName: "APPLE INC", settlementDate: "2026-06-30", currentShortPositionQuantity: 100000000, previousShortPositionQuantity: 95000000, changePreviousNumber: 5000000, changePercent: 5.3, averageDailyVolumeQuantity: 50000000, daysToCoverQuantity: 2, daysToCoverSentinel: false, marketClassCode: "NNM", notes: [] }, "2026-06-30", "finra"),
    shortInterestTrend: gap,
    insiderSentiment: ok([{ year: 2026, month: 6, change: -50000, mspr: -12.5 }], "2026-06-30", "finnhub"),
    macro: {
      core: {
        DGS10: ok([{ date: "2026-07-04", value: 4.4 }], "2026-07-04", "fred"),
        CPIAUCSL: ok([{ date: "2026-06-01", value: 320 }], "2026-06-01", "fred"),
      },
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
      item1a: ok({ sectionName: "item1A", text: "Risk factor text. ".repeat(100), method: "toc", chars: 1800, accession: "0000320193-25-000079", form: "10-K", filingDate: "2025-10-31", reportDate: "2025-09-27", documentUrl: "https://sec.gov/x" }, "2025-09-27", "edgar-item1a"),
      mdna: ok({ sectionName: "item7", text: "MD&A discussion text. ".repeat(100), method: "toc", chars: 2200, accession: "0000320193-25-000079", form: "10-K", filingDate: "2025-10-31", reportDate: "2025-09-27", documentUrl: "https://sec.gov/y" }, "2025-09-27", "edgar-mdna"),
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

function buildInputs(): { bundle: DataBundle; computed: ComputedMetrics } {
  const bundle = fixtureBundle();
  const computed = runStageB(bundle);
  return { bundle, computed };
}

const tn = (value: number, source: string, unit = "USD", asOf: string | null = "2025-09-27") => ({
  value,
  unit,
  source,
  asOf,
  verified: null,
});

/**
 * A schema-valid JudgeOutput that deliberately SMUGGLES wrong values into every
 * surface this suite hardens: fabricated multiples rows, a wrong reverse-DCF
 * implied value, wrong forensic scores, wrong segment shares.
 */
function judgeOutput(): JudgeOutput {
  const g = () => ({
    grade: "B" as const,
    oneLineWhy: "solid fundamentals with fair valuation",
    reasoning: [{ text: "reason", label: "JUDGMENT" as const, source: "computed", asOf: null }],
    confidence: "medium" as const,
    keyNumbers: [],
  });
  const num = (v: number, source: string) => ({ value: v, unit: "USD/share", source, asOf: null, verified: null });
  return {
    verdict: {
      synthesis: "A grounded synthesis across scenarios and probabilities without any rating language whatsoever.",
      gradeStrip: { fundamentals: g(), valuation: g(), technicals: g(), quality: g(), leadership: g(), moat: g() },
    },
    business: {
      whatTheySell: [{ text: "devices and services", label: "FACT", source: "fmp:profile", asOf: "2026-07-01" }],
      segments: {
        product: [
          // Revenue values match the bundle segmentation; sharePct values are WRONG on purpose.
          { name: "iPhone", revenue: tn(210000000000, "fmp:revenue-product-segmentation"), sharePct: 99.9 },
          { name: "Services", revenue: tn(100000000000, "fmp:revenue-product-segmentation"), sharePct: 1 },
          { name: "Mac", revenue: tn(30000000000, "fmp:revenue-product-segmentation"), sharePct: 77 },
        ],
        geographic: [
          { name: "Americas", revenue: tn(170000000000, "fmp:revenue-geographic-segmentation"), sharePct: 3.2 },
          { name: "Europe", revenue: tn(100000000000, "fmp:revenue-geographic-segmentation"), sharePct: null },
        ],
      },
      concentrationRisks: [],
    },
    fundamentals: { graded: g(), growthTable: [], marginTrend: [], returns: [], fcf: [], commentary: [] },
    balanceSheet: { debtProfile: { commentary: [], numbers: [] }, coverage: { commentary: [], numbers: [] }, capexTrajectory: { commentary: [], numbers: [] }, capitalAllocation: [] },
    valuation: {
      graded: g(),
      dcf: { perShare: null, assumptions: [], sensitivityGrid: [], upsidePct: null },
      reverseDcf: {
        impliedMetric: "hallucinated metric",
        impliedValue: 42.42, // WRONG on purpose — must be replaced by the computed solve.
        narrative: "the market is pricing mid-single-digit growth",
      },
      multiples: [
        // Fabricated rows — must be discarded wholesale.
        { name: "P/E (hallucinated)", current: 9999, peerMedian: 1, own5yPercentile: 100, sectorAppropriate: true },
      ],
      scenarios: [
        { name: "bull", probability: 0.34, priceTarget: num(300, "computed"), horizon: "12mo", assumptions: ["strong cycle"], whatWouldHaveToBeTrue: ["services accelerate"] },
        { name: "base", probability: 0.33, priceTarget: num(240, "computed"), horizon: "12mo", assumptions: ["steady"], whatWouldHaveToBeTrue: ["margins stable"] },
        { name: "bear", probability: 0.33, priceTarget: num(180, "computed"), horizon: "12mo", assumptions: ["demand softens"], whatWouldHaveToBeTrue: ["China weakens"] },
      ],
    },
    quality: {
      graded: g(),
      forensicScores: {
        // All WRONG on purpose — must be replaced by the computed forensics.
        altman: { variant: "hallucinated-Z", score: 9999, zone: "imaginary" },
        beneish: { variant: "hallucinated-M", score: 9999, zone: "imaginary" },
        piotroski: { variant: "hallucinated-F", score: 9999, zone: "imaginary" },
        accruals: { variant: "hallucinated", score: 9999, zone: "imaginary" },
      },
      flags: [],
    },
    technicals: { graded: g(), read: { trend: "uptrend", momentum: "neutral", keyLevels: "support near lows", relativeStrength: "in line with market" }, indicators: [], flags: [] },
    leadership: { graded: g(), executives: [], insiderSummary: [], governanceNotes: [] },
    competitive: { moatGraded: g(), peerTable: [], moatAssessment: [], marketShareDirection: "holding share" },
    catalystsRisks: { catalysts: [], risks: [] },
    outlook: { segmentTrajectories: [], estimateRevisionTrend: [], guidanceCredibility: [], scenarioNarratives: { y1: [], y3: [], y5: [] } },
    macro: {
      relevantSeries: [],
      sensitivityNotes: [],
      fredAttribution: "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.",
    },
    disagreements: [],
  };
}

function assemble(bundle: DataBundle, computed: ComputedMetrics, jo: JudgeOutput): Report {
  return assembleReport(
    {
      symbol: "AAPL",
      bundle,
      computed,
      judgeOutput: jo,
      verify: { verificationRate: 1, log: [] },
      costEntries: [],
      model: "claude-opus-4-8",
    },
    GENERATED_AT,
  );
}

/* ------------------------------------------------------------------------ *
 * Multiples rows
 * ------------------------------------------------------------------------ */

describe("valuation.multiples — deterministic injection (assembly)", () => {
  it("replaces the judge's rows wholesale with rows derived from the computed multiples framework", () => {
    const { bundle, computed } = buildInputs();
    if (computed.valuation.kind === "pre-revenue" || computed.valuation.multiples === null) {
      throw new Error("fixture must route to a multiples-bearing valuation");
    }
    const mr = computed.valuation.multiples;
    expect(mr.multiples.length).toBeGreaterThan(0);

    const report = assemble(bundle, computed, judgeOutput());

    // The fabricated judge row never survives.
    expect(report.valuation.multiples.some((r) => r.current === 9999)).toBe(false);
    expect(report.valuation.multiples.some((r) => r.name.includes("hallucinated"))).toBe(false);
    // Row-for-row derived from the computed MultiplesResult.
    expect(report.valuation.multiples).toEqual(
      mr.multiples.map((stat) => ({
        name: MULTIPLE_LABELS[stat.key],
        current: stat.current,
        peerMedian: stat.peers?.median ?? null,
        own5yPercentile: stat.ownHistory?.percentileRank ?? null,
        sectorAppropriate: mr.sectorAppropriate.includes(stat.key),
      })),
    );
    expect(() => ReportSchema.parse(report)).not.toThrow();
  });

  it("maps peer median, own-5y percentile, and the sector-appropriate flag field-by-field", () => {
    const jo = judgeOutput();
    const computedValuation = {
      kind: "excess-return",
      route: "bank",
      excessReturn: {},
      multiples: {
        multiples: [
          { key: "peTtm", current: 11.2, basis: "TTM EPS", ownHistory: { percentileRank: 62, p5: 8, p25: 9, median: 10, p75: 12, p95: 14, observations: 20 }, peers: { median: 10.5, min: 8, max: 14, count: 6 } },
          { key: "priceToTbv", current: 1.4, basis: "tangible book", ownHistory: null, peers: null },
          { key: "evToEbitda", current: null, basis: "n/m", ownHistory: null, peers: { median: 9.9, min: 7, max: 12, count: 5 } },
        ],
        sectorAppropriate: ["peTtm", "priceToTbv"],
        asOf: { quote: "2026-07-05", statements: "2025-09-27" },
        notes: [],
        gaps: [],
      },
      notes: [],
      gaps: [],
    } as unknown as ComputedMetrics["valuation"];

    const out = applyMultiples(jo.valuation, computedValuation);
    expect(out.multiples).toEqual([
      { name: "P/E (TTM)", current: 11.2, peerMedian: 10.5, own5yPercentile: 62, sectorAppropriate: true },
      { name: "P/TBV", current: 1.4, peerMedian: null, own5yPercentile: null, sectorAppropriate: true },
      { name: "EV/EBITDA", current: null, peerMedian: 9.9, own5yPercentile: null, sectorAppropriate: false },
    ]);
    // The judge's narrative surfaces on valuation are untouched.
    expect(out.reverseDcf).toEqual(jo.valuation.reverseDcf);
  });

  it("emits an empty table for pre-revenue (multiples === null) and for an absent computed valuation", () => {
    const jo = judgeOutput();
    const preRevenue = { kind: "pre-revenue", route: "general", multiples: null, notes: [], gaps: [] } as unknown as ComputedMetrics["valuation"];
    expect(applyMultiples(jo.valuation, preRevenue).multiples).toEqual([]);
    expect(applyMultiples(jo.valuation, undefined).multiples).toEqual([]);
  });

  it("has a complete, fixed label per MultipleKey", () => {
    expect(Object.keys(MULTIPLE_LABELS).sort()).toEqual(
      ["evToEbitda", "evToSales", "peTtm", "priceToAffo", "priceToBook", "priceToFcf", "priceToFfo", "priceToTbv"].sort(),
    );
    for (const label of Object.values(MULTIPLE_LABELS)) expect(label.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------ *
 * Reverse DCF implied metric/value
 * ------------------------------------------------------------------------ */

describe("valuation.reverseDcf — deterministic injection (assembly)", () => {
  it("overwrites the judge's impliedMetric + impliedValue with the computed growth solve, preserving the narrative", () => {
    const { bundle, computed } = buildInputs();
    if (computed.valuation.kind !== "dcf") throw new Error("fixture must route to the DCF valuation");
    computed.valuation = {
      ...computed.valuation,
      reverseDcf: { method: "growth", impliedRevenueGrowthPct: 7.3, impliedTerminalMarginPct: null, notes: [], gaps: [] },
    };
    const report = assemble(bundle, computed, judgeOutput());

    expect(report.valuation.reverseDcf.impliedValue).toBe(7.3); // NOT the judge's 42.42
    expect(report.valuation.reverseDcf.impliedMetric).toBe("constant revenue growth (explicit horizon)");
    expect(report.valuation.reverseDcf.narrative).toBe("the market is pricing mid-single-digit growth");
    expect(() => ReportSchema.parse(report)).not.toThrow();
  });

  it("maps the margin-fallback solve to the terminal EBIT margin", () => {
    const { computed } = buildInputs();
    if (computed.valuation.kind !== "dcf") throw new Error("fixture must route to the DCF valuation");
    const jo = judgeOutput();
    const out = applyReverseDcf(jo.valuation, {
      ...computed.valuation,
      reverseDcf: { method: "margin", impliedRevenueGrowthPct: null, impliedTerminalMarginPct: 24.5, notes: [], gaps: [] },
    });
    expect(out.reverseDcf.impliedValue).toBe(24.5);
    expect(out.reverseDcf.impliedMetric).toBe("terminal EBIT margin");
    expect(out.reverseDcf.narrative).toBe(jo.valuation.reverseDcf.narrative);
  });

  it('suppresses to "n/a" + null for method "none", non-DCF kinds, and an absent computed valuation', () => {
    const { computed } = buildInputs();
    if (computed.valuation.kind !== "dcf") throw new Error("fixture must route to the DCF valuation");
    const jo = judgeOutput();

    const none = applyReverseDcf(jo.valuation, {
      ...computed.valuation,
      reverseDcf: { method: "none", impliedRevenueGrowthPct: null, impliedTerminalMarginPct: null, notes: ["no price"], gaps: [] },
    });
    expect(none.reverseDcf).toMatchObject({ impliedMetric: "n/a", impliedValue: null });

    const preRevenue = applyReverseDcf(
      jo.valuation,
      { kind: "pre-revenue", route: "general", multiples: null, notes: [], gaps: [] } as unknown as ComputedMetrics["valuation"],
    );
    expect(preRevenue.reverseDcf).toMatchObject({ impliedMetric: "n/a", impliedValue: null });

    const absent = applyReverseDcf(jo.valuation, undefined);
    expect(absent.reverseDcf).toMatchObject({ impliedMetric: "n/a", impliedValue: null });
    // Narrative survives every suppression path.
    expect(none.reverseDcf.narrative).toBe(jo.valuation.reverseDcf.narrative);
    expect(preRevenue.reverseDcf.narrative).toBe(jo.valuation.reverseDcf.narrative);
    expect(absent.reverseDcf.narrative).toBe(jo.valuation.reverseDcf.narrative);
  });
});

/* ------------------------------------------------------------------------ *
 * Forensic scores
 * ------------------------------------------------------------------------ */

describe("quality.forensicScores — deterministic injection (assembly)", () => {
  it("overwrites every judge-authored score/zone/variant with the computed forensics", () => {
    const { bundle, computed } = buildInputs();
    const f = computed.forensics;
    const report = assemble(bundle, computed, judgeOutput());
    const scores = report.quality.forensicScores;

    // The smuggled 9999s and hallucinated variants never survive.
    for (const key of ["altman", "beneish", "piotroski", "accruals"] as const) {
      expect(scores[key].score).not.toBe(9999);
      expect(scores[key].zone).not.toBe("imaginary");
      expect(scores[key].variant.includes("hallucinated")).toBe(false);
    }

    expect(scores.altman.variant).toBe(f.altman?.variant ?? f.altmanSelection.variant);
    expect(scores.altman.score).toBe(f.altman?.score ?? null);
    expect(scores.altman.zone).toBe(f.altman?.zone ?? null);

    expect(scores.beneish.variant).toBe("m-score");
    expect(scores.beneish.score).toBe(f.beneish?.score ?? null);
    expect(scores.beneish.zone).toBe(f.beneish?.verdict ?? null);

    expect(scores.piotroski.variant).toBe("f-score");
    expect(scores.piotroski.score).toBe(f.piotroski?.score ?? null);
    if (f.piotroski && f.piotroski.score !== null) {
      expect(scores.piotroski.zone).toBe(`${f.piotroski.score}/${f.piotroski.outOf}`);
    } else {
      expect(scores.piotroski.zone).toBeNull();
    }

    // Fixture has full statements — the primary accruals ratio must be real.
    expect(f.accruals?.cashFlowAccrualRatio).not.toBeNull();
    expect(scores.accruals.variant).toBe("cash-flow");
    expect(scores.accruals.score).toBe(f.accruals?.cashFlowAccrualRatio ?? null);
    expect(scores.accruals.zone).toBe(f.accruals?.band ?? null);
    expect(() => ReportSchema.parse(report)).not.toThrow();
  });

  it("preserves the judge's notApplicableReason when the computed counterpart is null (it explains why)", () => {
    const jo = judgeOutput();
    jo.quality.forensicScores.altman = {
      variant: "Z",
      score: null,
      zone: null,
      notApplicableReason: "Altman Z is not defined for financial companies.",
    };
    const suppressed = {
      altmanSelection: { variant: null, notes: ["financials excluded"] },
      altman: null,
      beneish: null,
      piotroski: null,
      accruals: null,
      flags: [],
      notes: [],
      gaps: [],
    } as unknown as ComputedMetrics["forensics"];

    const out = applyForensicScores(jo.quality, suppressed);
    expect(out.forensicScores.altman.score).toBeNull();
    expect(out.forensicScores.altman.zone).toBeNull();
    // Falls back to the judge's variant string only when computed + selection are unavailable.
    expect(out.forensicScores.altman.variant).toBe("Z");
    expect(out.forensicScores.altman.notApplicableReason).toBe(
      "Altman Z is not defined for financial companies.",
    );
    // The judge's other (wrong) numbers are still nulled, never trusted.
    expect(out.forensicScores.beneish.score).toBeNull();
    expect(out.forensicScores.piotroski.score).toBeNull();
    expect(out.forensicScores.accruals.score).toBeNull();
  });

  it("drops notApplicableReason when a computed score exists (the prose no longer applies)", () => {
    const { computed } = buildInputs();
    const jo = judgeOutput();
    jo.quality.forensicScores.accruals = {
      variant: "cash-flow",
      score: null,
      zone: null,
      notApplicableReason: "stale excuse that should disappear",
    };
    expect(computed.forensics.accruals?.cashFlowAccrualRatio).not.toBeNull();
    const out = applyForensicScores(jo.quality, computed.forensics);
    expect(out.forensicScores.accruals.score).toBe(computed.forensics.accruals!.cashFlowAccrualRatio);
    expect(out.forensicScores.accruals.notApplicableReason).toBeUndefined();
  });

  it("nulls all scores when the computed forensics block is absent (verify stand-in) — never trusts the judge", () => {
    const jo = judgeOutput();
    const out = applyForensicScores(jo.quality, undefined);
    for (const key of ["altman", "beneish", "piotroski", "accruals"] as const) {
      expect(out.forensicScores[key].score).toBeNull();
      expect(out.forensicScores[key].zone).toBeNull();
    }
    // Fixed labels stay fixed; only Altman's variant falls back to the judge string.
    expect(out.forensicScores.beneish.variant).toBe("m-score");
    expect(out.forensicScores.piotroski.variant).toBe("f-score");
    expect(out.forensicScores.accruals.variant).toBe("cash-flow");
    expect(out.forensicScores.altman.variant).toBe("hallucinated-Z");
  });
});

/* ------------------------------------------------------------------------ *
 * Segment shares
 * ------------------------------------------------------------------------ */

describe("business.segments[].sharePct — deterministic injection (assembly)", () => {
  it("overwrites every judge sharePct with revenue ÷ latest-period segmentation total × 100 (1 decimal)", () => {
    const { bundle, computed } = buildInputs();
    const report = assemble(bundle, computed, judgeOutput());

    // Product total = 210e9 + 30e9 + 100e9 = 340e9.
    const product = report.business.segments.product;
    expect(product.find((s) => s.name === "iPhone")!.sharePct).toBe(61.8); // not 99.9
    expect(product.find((s) => s.name === "Services")!.sharePct).toBe(29.4); // not 1
    expect(product.find((s) => s.name === "Mac")!.sharePct).toBe(8.8); // not 77

    // Geographic rows divide by the GEOGRAPHIC total (170e9 + 100e9 + 70e9 = 340e9).
    const geo = report.business.segments.geographic;
    expect(geo.find((s) => s.name === "Americas")!.sharePct).toBe(50); // not 3.2
    expect(geo.find((s) => s.name === "Europe")!.sharePct).toBe(29.4); // judge said null

    // Names + traced revenue stay judge-authored.
    expect(product.find((s) => s.name === "iPhone")!.revenue.value).toBe(210000000000);
    expect(() => ReportSchema.parse(report)).not.toThrow();
  });

  it("nulls sharePct when the bundle segmentation feed is a gap — the judge's number is still discarded", () => {
    const { bundle } = buildInputs();
    const noProduct = {
      ...bundle,
      segmentation: { ...bundle.segmentation, product: gap },
    } as unknown as DataBundle;
    const out = applySegmentShares(judgeOutput().business, noProduct);
    for (const row of out.segments.product) expect(row.sharePct).toBeNull();
    // Geographic feed is intact, so its shares still compute.
    expect(out.segments.geographic.find((s) => s.name === "Americas")!.sharePct).toBe(50);
  });

  it("nulls sharePct when the bundle is absent entirely (verify stand-in path)", () => {
    const out = applySegmentShares(judgeOutput().business, undefined);
    for (const row of [...out.segments.product, ...out.segments.geographic]) {
      expect(row.sharePct).toBeNull();
    }
  });

  it("nulls sharePct when the latest segmentation period sums to a non-positive total", () => {
    const { bundle } = buildInputs();
    const zeroed = {
      ...bundle,
      segmentation: {
        ...bundle.segmentation,
        product: fmpPayload([{ date: "2025-09-27", data: { iPhone: 0, Mac: 0 } }], "2025-09-27", "revenue-product-segmentation"),
      },
    } as unknown as DataBundle;
    const out = applySegmentShares(judgeOutput().business, zeroed);
    for (const row of out.segments.product) expect(row.sharePct).toBeNull();
  });
});
