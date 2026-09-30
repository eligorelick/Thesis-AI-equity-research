/**
 * A general-route (or bank-route) DataBundle whose every currency label is a
 * knob, for the currency-integrity suites. Adapted from the runStageB wiring
 * fixture in tests/stageB.ttm.compute.test.ts; values are in millions.
 *
 * `null` for a currency means the row carries NO `reportedCurrency` at all.
 */
import type { DataBundle } from "@/pipeline/types";

export const BUILT_AT = "2026-07-06T00:00:00.000Z";
export const M = 1_000_000;
/** The four quarter ends of the latest trailing window, newest first. */
export const TTM_DATES = ["2026-03-31", "2025-12-31", "2025-09-30", "2025-06-30"] as const;

export interface CurrencyBundleOptions {
  /** Listing/trading currency on the profile (the quote's currency). */
  profileCurrency?: string | null;
  /**
   * Per-year overrides for the annual rows (index 0 = FY2025, newest). Each
   * defaults to `annualCurrency`; `null` means the row carries no label.
   */
  incomeAnnualCurrencies?: readonly (string | null)[];
  balanceAnnualCurrencies?: readonly (string | null)[];
  cashflowAnnualCurrencies?: readonly (string | null)[];
  /** reportedCurrency on every annual statement row. */
  annualCurrency?: string | null;
  /** reportedCurrency on the four latest income quarters (index 0 = newest). */
  quarterCurrencies?: readonly (string | null)[];
  /** reportedCurrency on the same-period balance-sheet and cash-flow quarters. */
  siblingQuarterCurrencies?: readonly (string | null)[];
  /** Override for the balance-sheet quarters alone (else siblingQuarterCurrencies). */
  balanceQuarterCurrencies?: readonly (string | null)[];
  /** Override for the cash-flow quarters alone (else siblingQuarterCurrencies). */
  cashflowQuarterCurrencies?: readonly (string | null)[];
  /**
   * Filing identity on the four latest quarters of every statement. "shared":
   * each quarter's income, balance-sheet and cash-flow rows carry the same
   * SEC acceptance timestamp and CIK (one 10-Q). "none" (default): no row
   * carries any, so rows share only a period-end date.
   */
  filingLinks?: "shared" | "none";
  /** Revenue per latest quarter (millions). 300 → TTM 1,200 against FY2025's 1,000. */
  quarterlyRevenue?: number;
  /** Route a bank (excess-return model) instead of a general company. */
  bank?: boolean;
  /** Route an industrial equity REIT (P/FFO, implied cap rate) instead of a general company. */
  reit?: boolean;
  /** Total debt on every balance row (millions). 0 makes the WACC the cost of equity. */
  debt?: number;
  /**
   * Cash-burning: every operating cash flow is negative (quarters -55, capex
   * -10, so a 65 quarterly burn; FY2025 -220), which routes the unprofitable
   * overlay and runs the runway model on 120 of quarter-end liquidity.
   */
  burning?: boolean;
  /**
   * completeCurrencyBundle only: analyst estimates (FY2026 revenue 1,300,
   * FY2027 1,450) and a price-target consensus (120). `false` leaves them out;
   * `estimateCurrency` / `priceTargetCurrency` put a currency on the rows
   * themselves (absent by default, as in FMP's feed).
   */
  estimates?: boolean;
  estimateCurrency?: string | null;
  priceTargetCurrency?: string | null;
  /** SEC SIC code (3571 routes Altman to the original, market-equity variant). */
  sic?: string;
  symbol?: string;
}

function ok<T>(rows: T[], asOf: string, endpoint: string) {
  return {
    ok: true as const,
    value: { data: { rows, raw: {} }, asOf, source: "fmp" as const, endpoint, fetchedAt: BUILT_AT },
  };
}

const GAP = { ok: false as const, gap: { field: "fixture", reason: "fixture gap", severity: "info" as const } };

const NO_SCALE = new Set(["epsDiluted", "date", "reportedCurrency", "fiscalYear", "period", "cik", "acceptedDate"]);

function scaled(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k, typeof v === "number" && !NO_SCALE.has(k) && k !== "weightedAverageShsOutDil" ? v * M : v]),
    ),
  );
}

/** Attach `reportedCurrency` only when a code is given: null means the field is absent. */
function labelled<T extends Record<string, unknown>>(row: T, code: string | null | undefined): T {
  return code == null ? row : { ...row, reportedCurrency: code };
}

/** ~300 daily closes ending 2026-07-02 around 100, so technicals have a last close. */
function eodRows(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const end = Date.UTC(2026, 6, 2);
  for (let i = 0; i < 300; i++) {
    const date = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    const close = 100 - i * 0.05;
    rows.push({ date, open: close, high: close, low: close, close, adjClose: close, volume: 1_000_000 });
  }
  return rows;
}

export function currencyBundle(opts: CurrencyBundleOptions = {}): DataBundle {
  const annual = opts.annualCurrency === undefined ? "USD" : opts.annualCurrency;
  const quarters = opts.quarterCurrencies ?? [annual, annual, annual, annual];
  const siblings = opts.siblingQuarterCurrencies ?? [null, null, null, null];
  const balanceCodes = opts.balanceQuarterCurrencies ?? siblings;
  const cashflowCodes = opts.cashflowQuarterCurrencies ?? siblings;
  /** The i-th latest quarter's filing identity, when linked. */
  const filing = (i: number): Record<string, string> =>
    opts.filingLinks === "shared" ? {
          cik: "0000000042",
          // Filed ~a month after the quarter closed.
          acceptedDate: `${new Date(Date.parse(TTM_DATES[i]!) + 32 * 86_400_000).toISOString().slice(0, 10)} 16:05:00`,
        } : {};
  const qRev = opts.quarterlyRevenue ?? 300;
  const symbol = opts.symbol ?? (opts.bank ? "BNK" : opts.reit ? "RET" : "GEN");
  const perYear = (codes: readonly (string | null)[] | undefined, i: number): string | null =>
    codes !== undefined && i < codes.length ? codes[i]! : annual;
  const debt = opts.debt ?? 300;
  const interest = debt === 0 ? 0 : 1;

  const incomeAnnual = [
    { date: "2025-12-31", fiscalYear: "2025", period: "FY", revenue: 1000, grossProfit: 400, operatingIncome: 200, ebit: 200, netIncome: 150, epsDiluted: 1.5, weightedAverageShsOutDil: 100 * M, interestExpense: 15 * interest, incomeBeforeTax: 190, incomeTaxExpense: 40, depreciationAndAmortization: 50 },
    { date: "2024-12-31", fiscalYear: "2024", period: "FY", revenue: 900, grossProfit: 360, operatingIncome: 180, ebit: 180, netIncome: 140, epsDiluted: 1.4, weightedAverageShsOutDil: 101 * M, interestExpense: 15 * interest, incomeBeforeTax: 175, incomeTaxExpense: 35, depreciationAndAmortization: 45 },
    { date: "2023-12-31", fiscalYear: "2023", period: "FY", revenue: 800, grossProfit: 320, operatingIncome: 160, ebit: 160, netIncome: 130, epsDiluted: 1.27, weightedAverageShsOutDil: 102 * M, interestExpense: 14 * interest, incomeBeforeTax: 158, incomeTaxExpense: 28, depreciationAndAmortization: 40 },
    { date: "2022-12-31", fiscalYear: "2022", period: "FY", revenue: 700, grossProfit: 280, operatingIncome: 140, ebit: 140, netIncome: 110, epsDiluted: 1.06, weightedAverageShsOutDil: 103 * M, interestExpense: 13 * interest, incomeBeforeTax: 135, incomeTaxExpense: 25, depreciationAndAmortization: 35 },
  ].map((r, i) => labelled(r, perYear(opts.incomeAnnualCurrencies, i)));

  const latest = TTM_DATES.map((date, i) =>
    labelled(
      { date, revenue: qRev, operatingIncome: 60, ebit: 60, netIncome: 45, epsDiluted: 0.45, weightedAverageShsOutDil: 100 * M, interestExpense: 4 * interest, incomeBeforeTax: 57, incomeTaxExpense: 12, depreciationAndAmortization: 12.5, ...filing(i) },
      quarters[i],
    ),
  );
  const older = ["2025-03-31", "2024-12-31", "2024-09-30", "2024-06-30"].map((date) =>
    labelled(
      { date, revenue: 240, operatingIncome: 48, ebit: 48, netIncome: 36, epsDiluted: 0.36, weightedAverageShsOutDil: 100 * M, interestExpense: 4 * interest, incomeBeforeTax: 45.5, incomeTaxExpense: 9.5, depreciationAndAmortization: 12 },
      annual,
    ),
  );

  const balanceAnnual = [
    { date: "2025-12-31", totalAssets: 2000, totalLiabilities: 1500, totalStockholdersEquity: 500, totalEquity: 500, totalDebt: debt, netDebt: debt - 60, cashAndCashEquivalents: 60, cashAndShortTermInvestments: 100, goodwill: 40, intangibleAssets: 10, minorityInterest: 0, preferredStock: 0 },
    { date: "2024-12-31", totalAssets: 1900, totalLiabilities: 1450, totalStockholdersEquity: 450, totalEquity: 450, totalDebt: debt, netDebt: debt - 60, cashAndCashEquivalents: 60, cashAndShortTermInvestments: 95, goodwill: 40, intangibleAssets: 10, minorityInterest: 0, preferredStock: 0 },
  ].map((r, i) => labelled(r, perYear(opts.balanceAnnualCurrencies, i)));
  const balanceQuarterly = TTM_DATES.map((date, i) =>
    labelled(
      { date, totalAssets: 2050, totalLiabilities: 1530, totalStockholdersEquity: 520, totalEquity: 520, totalDebt: debt, netDebt: debt - 70, cashAndCashEquivalents: 70, cashAndShortTermInvestments: 120, goodwill: 40, intangibleAssets: 10, minorityInterest: 0, preferredStock: 0, ...filing(i) },
      balanceCodes[i],
    ),
  );
  const cashflowAnnual = [
    { date: "2025-12-31", operatingCashFlow: opts.burning ? -220 : 220, capitalExpenditure: -40, freeCashFlow: 180, netIncome: 150, depreciationAndAmortization: 50, stockBasedCompensation: 10, commonStockRepurchased: -20, commonDividendsPaid: -30, commonStockIssuance: 10, netCashProvidedByOperatingActivities: 220, netCashProvidedByInvestingActivities: -40 },
    { date: "2024-12-31", operatingCashFlow: 205, capitalExpenditure: -38, freeCashFlow: 167, netIncome: 140, depreciationAndAmortization: 45, stockBasedCompensation: 9, commonStockRepurchased: -30, commonDividendsPaid: -28, commonStockIssuance: 2, netCashProvidedByOperatingActivities: 205, netCashProvidedByInvestingActivities: -38 },
    { date: "2023-12-31", operatingCashFlow: 190, capitalExpenditure: -35, freeCashFlow: 155, netIncome: 130, depreciationAndAmortization: 40, stockBasedCompensation: 8, commonStockRepurchased: -13, commonDividendsPaid: -26, commonStockIssuance: 0, netCashProvidedByOperatingActivities: 190, netCashProvidedByInvestingActivities: -35 },
  ].map((r, i) => labelled(r, perYear(opts.cashflowAnnualCurrencies, i)));
  const cashflowQuarterly = TTM_DATES.map((date, i) =>
    labelled(
      { date, operatingCashFlow: opts.burning ? -55 : 55, capitalExpenditure: -10, freeCashFlow: 45, netIncome: 45, depreciationAndAmortization: 12.5, ...filing(i) },
      cashflowCodes[i],
    ),
  );

  const profileCurrency = opts.profileCurrency === undefined ? "USD" : opts.profileCurrency;
  return {
    symbol,
    builtAt: BUILT_AT,
    profile: ok(
      [{
        companyName: opts.bank ? "Test Bancorp" : opts.reit ? "Test Properties" : "Test General Co",
        sector: opts.bank ? "Financial Services" : opts.reit ? "Real Estate" : "Technology",
        industry: opts.bank ? "Banks - Diversified" : opts.reit ? "REIT - Industrial" : "Consumer Electronics",
        price: 100, marketCap: 10_000 * M, beta: 1.0,
        ...(profileCurrency === null ? {} : { currency: profileCurrency }),
        country: "US", ipoDate: "2000-01-01", isAdr: false, isEtf: false, isFund: false,
      }],
      "2026-07-01",
      "profile",
    ),
    quote: ok([{ symbol, price: 100, marketCap: 10_000 * M, timestamp: 1751731200 }], "2026-07-05", "quote"),
    statements: {
      incomeAnnual: ok(scaled(incomeAnnual), "2025-12-31", "income-statement"),
      incomeQuarterly: ok(scaled([...latest, ...older]), "2026-03-31", "income-statement"),
      balanceAnnual: ok(scaled(balanceAnnual), "2025-12-31", "balance-sheet"),
      balanceQuarterly: ok(scaled(balanceQuarterly), "2026-03-31", "balance-sheet"),
      cashflowAnnual: ok(scaled(cashflowAnnual), "2025-12-31", "cash-flow"),
      cashflowQuarterly: ok(scaled(cashflowQuarterly), "2026-03-31", "cash-flow"),
      periods: { annualRequested: 10, quarterlyRequested: 8 },
    },
    keyMetrics: GAP,
    keyMetricsTtm: ok([{ returnOnEquityTTM: 0.12 }], "2026-03-31", "key-metrics-ttm"),
    ratios: GAP,
    ratiosTtm: ok([{ effectiveTaxRateTTM: 0.2 }], "2026-03-31", "ratios-ttm"),
    enterpriseValues: GAP,
    analystEstimates: GAP,
    marketCapHistory: GAP,
    eodPrices: ok(eodRows(), "2026-07-02", "historical-price-eod"),
    benchmarkPrices: { spy: GAP, sectorEtf: GAP, sectorEtfSymbol: null },
    macro: { core: {}, sector: {}, gicsSector: null, attribution: "" },
    treasury: ok([{ date: "2026-07-04", year10: 4.0 }], "2026-07-04", "treasury"),
    marketRiskPremium: ok([{ totalEquityRiskPremium: 4.5 }], "2026-07-01", "market-risk-premium"),
    asOf: {},
    gaps: [],
    edgar: { sic: opts.sic ?? null },
  } as unknown as DataBundle;
}

const MEMBER_GAP = { ok: false as const, gap: { field: "fixture", reason: "fixture gap", severity: "info" as const } };

function okRows<T>(rows: T[], asOf: string, endpoint: string) {
  return {
    ok: true as const,
    value: { data: { rows, raw: {} }, asOf, source: "fmp" as const, endpoint, fetchedAt: BUILT_AT },
  };
}

/**
 * currencyBundle plus every member the payload assembler and the data-only
 * report read, with one analyst-estimate row and a price-target consensus.
 * Debt-free by default.
 */
export function completeCurrencyBundle(opts: CurrencyBundleOptions): DataBundle {
  const base = currencyBundle({ debt: 0, ...opts }) as unknown as Record<string, unknown>;
  return {
    ...base,
    analystEstimates:
      opts.estimates === false
        ? MEMBER_GAP
        : okRows(
            [
              { symbol: base.symbol, date: "2026-12-31", revenueAvg: 1300 * M, epsAvg: 1.9 },
              { symbol: base.symbol, date: "2027-12-31", revenueAvg: 1450 * M, epsAvg: 2.1 },
            ].map((r) => (opts.estimateCurrency == null ? r : { ...r, reportedCurrency: opts.estimateCurrency })),
            "2026-07-01",
            "analyst-estimates",
          ),
    priceTargetConsensus:
      opts.estimates === false
        ? MEMBER_GAP
        : okRows(
            [{ symbol: base.symbol, targetConsensus: 120, targetHigh: 150, targetLow: 90 }].map((r) =>
              opts.priceTargetCurrency == null ? r : { ...r, currency: opts.priceTargetCurrency },
            ),
            "2026-07-01",
            "price-target-consensus",
          ),
    priceTargetSummary: MEMBER_GAP,
    gradesConsensus: MEMBER_GAP,
    financialGrowth: MEMBER_GAP,
    financialScores: MEMBER_GAP,
    earningsHistory: MEMBER_GAP,
    earningsCalendarNext: MEMBER_GAP,
    transcript: { latest: MEMBER_GAP },
    insiderTrades: MEMBER_GAP,
    insiderStats: MEMBER_GAP,
    institutional: { positionsSummary: MEMBER_GAP, topHolders: MEMBER_GAP, quarterEnd: null },
    peers: MEMBER_GAP,
    segmentation: { product: MEMBER_GAP, geographic: MEMBER_GAP },
    executives: MEMBER_GAP,
    compensation: MEMBER_GAP,
    sharesFloat: MEMBER_GAP,
    secFilings: MEMBER_GAP,
    news: MEMBER_GAP,
    pressReleases: MEMBER_GAP,
    shortInterest: MEMBER_GAP,
    shortInterestTrend: MEMBER_GAP,
    insiderSentiment: MEMBER_GAP,
    edgar: { sic: opts.sic ?? null, item1a: MEMBER_GAP, mdna: MEMBER_GAP, tenQMdna: MEMBER_GAP },
    sourceManifest: {},
  } as unknown as DataBundle;
}
