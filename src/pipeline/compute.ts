/**
 * Stage B orchestrator — runStageB(bundle) adapts the raw DataBundle into each
 * pure Stage B module's own input types, runs sector routing FIRST, then feeds
 * every analytical module, honouring the metric-suppression policy for the
 * routed sector (suppressed metrics are nulled with a disclosing note rather
 * than silently dropped).
 *
 * Pure + deterministic: no network, no DB, no LLM, no clock reads beyond the
 * bundle's own builtAt. Missing inputs degrade to gaps — never throw
 * (the application contract §3, non-negotiable rule #4).
 */

import type { FetchResult, ManifestEntry, Sourced } from "@/types/core";
import type { DataBundle, FmpFetch } from "@/pipeline/types";
import type {
  FmpBalanceSheetRow,
  FmpCashFlowRow,
  FmpIncomeStatementRow,
  FmpMarketRiskPremiumRow,
  FmpRawRow,
} from "@/providers/fmp";

import {
  computeRunway,
  metricPolicy,
  routeCompany,
  degradationPlan,
  type CompanyRouteResult,
  type DegradationPlan,
  type RunwayResult,
  type RoutingIncomeRow,
  type RoutingCashflowRow,
} from "@/pipeline/stageB/sectorRouting";
import {
  computeGrowth,
  type GrowthResult,
  type GrowthIncomeRow,
  type GrowthCashFlowRow,
} from "@/pipeline/stageB/growth";
import {
  computeWacc,
  computeRoic,
  computeDupont,
  computeRoicVsWaccSpread,
  type WaccResult,
  type RoicResult,
  type DupontResult,
  type RoicVsWaccSpread,
  type ReturnsIncomeRow,
  type ReturnsBalanceRow,
} from "@/pipeline/stageB/returns";
import {
  computeCapital,
  type CapitalResult,
  type CapitalIncomeRow,
  type CapitalCashFlowRow,
  type CapitalBalanceRow,
  type MarketCapPoint,
  type QuoteInput,
} from "@/pipeline/stageB/capital";
import {
  runForensics,
  type ForensicsReport,
  type ForensicsIncomeRow,
  type ForensicsBalanceRow,
  type ForensicsCashFlowRow,
} from "@/pipeline/stageB/forensics";
import {
  computeTechnicals,
  type TechnicalsResult,
  type OhlcvRow,
} from "@/pipeline/stageB/technicals";
import {
  valueCompany,
  type ValuationResult,
  type ValuationBundleInputs,
  type DcfAssumptionInputs,
  type DcfIncomeRow,
  type DcfBalanceRow,
  type AnalystEstimateRow,
  type MultiplesFrameworkInputs,
  type MultiplesQuoteInputs,
  type MultiplesIncomeTtm,
  type MultiplesCashFlowTtm,
  type MultiplesBalance,
  type QuarterlyFundamentalsRow,
  type EnterpriseValuesRow,
  type ExcessReturnInputs,
  type ReitInputs,
} from "@/pipeline/stageB/valuation";
import { computeScores } from "@/pipeline/stageB/grading";
import { computeProjections, type ProjectionIncomeRow } from "@/pipeline/stageB/projections";
import { computeScenarioTargets } from "@/pipeline/stageB/scenarioTargets";
import { computeFairValue } from "@/pipeline/stageB/fairValue";
import { resolveNetDebt, type NetDebtResolution } from "@/pipeline/stageB/netDebt";
import { mergeManifest } from "@/pipeline/stageA/manifest";
import type { Scoring, Projections, ScenarioTargets, FairValue } from "@/report/schema";

// ---------------------------------------------------------------------------
// Public result contract
// ---------------------------------------------------------------------------

/**
 * The full Stage B analytical picture for one company. Every sub-result carries
 * its own notes + gaps; the top-level `gaps` is the merged, deduped, severity-
 * ordered union of every module's gaps plus the bundle's own manifest.
 *
 * `suppressed` lists the metric keys nulled by the sector metric policy (a
 * bank's Altman-Z, an EV/EBITDA for a financial, etc.) with the reason, so the
 * UI can render "suppressed for <route>" rather than a blank.
 */
export interface ComputedMetrics {
  symbol: string;
  builtAt: string;
  route: CompanyRouteResult;
  degradation: DegradationPlan;
  growth: GrowthResult;
  returns: ReturnsBlock;
  capital: CapitalResult;
  forensics: ForensicsReport;
  technicals: TechnicalsResult;
  valuation: ValuationResult;
  /** Present only for the pre-revenue / unprofitable / recent-ipo overlays. */
  runway: RunwayResult | null;
  /** Deterministic aspect scores + weighted composite (feature 1.1.0). */
  scores: Scoring;
  /** Weighted forward projections (feature 1.1.0). */
  projections: Projections;
  /** Deterministic bull/base/bear price targets (2026-07-11 checkpoint). */
  scenarioTargets: ScenarioTargets;
  /** Deterministic intrinsic per-share fair value (2026-07-11 DCF checkpoint). */
  fairValue: FairValue;
  /** Metric keys nulled by the sector policy, with the disclosing reason. */
  suppressed: SuppressedMetric[];
  notes: string[];
  gaps: ManifestEntry[];
}

export interface ReturnsBlock {
  wacc: WaccResult;
  roic: RoicResult;
  dupont: DupontResult;
  roicVsWacc: RoicVsWaccSpread;
  notes: string[];
  gaps: ManifestEntry[];
}

export interface SuppressedMetric {
  key: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Small unwrap helpers — every bundle member is a FetchResult<...>
// ---------------------------------------------------------------------------

function rowsOf<TRow extends FmpRawRow>(f: FmpFetch<TRow>): TRow[] {
  return f.ok ? f.value.data.rows : [];
}

/** First row of a single-row FMP payload (profile/quote), or null. */
function firstRow<TRow extends FmpRawRow>(f: FmpFetch<TRow>): TRow | null {
  return f.ok ? (f.value.data.rows[0] ?? null) : null;
}

function sourcedOf<T>(f: FetchResult<T>): Sourced<T> | null {
  return f.ok ? f.value : null;
}

function valueOf<T>(f: FetchResult<T>): T | null {
  return f.ok ? f.value.data : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function isoDay(v: unknown): string | null {
  const s = str(v);
  return s ? s.slice(0, 10) : null;
}

const US_COUNTRY_KEYS = new Set(["us", "usa", "unitedstates", "unitedstatesofamerica"]);

/**
 * Select the US total ERP by country identity, never by provider array order.
 * Conflicting US rows fail closed so an ambiguous vendor response cannot
 * silently choose whichever value happens to arrive first.
 */
export function selectUsEquityRiskPremium(
  rows: ReadonlyArray<FmpMarketRiskPremiumRow>,
): number | null {
  const values = rows.flatMap((row) => {
    const countryKey = typeof row.country === "string"
      ? row.country.toLowerCase().replace(/[^a-z]/g, "")
      : "";
    const value = num(row.totalEquityRiskPremium);
    return US_COUNTRY_KEYS.has(countryKey) && value !== null ? [value] : [];
  });
  const uniqueValues = [...new Set(values)];
  return uniqueValues.length === 1 ? uniqueValues[0] : null;
}

// ---------------------------------------------------------------------------
// Adapters — map FMP rows to each module's input row shape (structural, but we
// build explicit objects so a field rename upstream fails the typecheck here).
// ---------------------------------------------------------------------------

function toGrowthIncome(r: FmpIncomeStatementRow): GrowthIncomeRow {
  return {
    date: String(r.date ?? ""),
    revenue: num(r.revenue),
    grossProfit: num(r.grossProfit),
    operatingIncome: num(r.operatingIncome),
    netIncome: num(r.netIncome),
    epsDiluted: num(r.epsDiluted),
  };
}

function toGrowthCashFlow(r: FmpCashFlowRow): GrowthCashFlowRow {
  return {
    date: String(r.date ?? ""),
    freeCashFlow: num(r.freeCashFlow),
    operatingCashFlow: num(r.operatingCashFlow),
    capitalExpenditure: num(r.capitalExpenditure),
  };
}

function toReturnsIncome(r: FmpIncomeStatementRow): ReturnsIncomeRow {
  return {
    date: String(r.date ?? ""),
    revenue: num(r.revenue),
    operatingIncome: num(r.operatingIncome),
    ebit: num(r.ebit),
    incomeBeforeTax: num(r.incomeBeforeTax),
    incomeTaxExpense: num(r.incomeTaxExpense),
    netIncome: num(r.netIncome),
  };
}

function toReturnsBalance(r: FmpBalanceSheetRow): ReturnsBalanceRow {
  return {
    date: String(r.date ?? ""),
    totalDebt: num(r.totalDebt),
    totalStockholdersEquity: num(r.totalStockholdersEquity),
    cashAndCashEquivalents: num(r.cashAndCashEquivalents),
    totalAssets: num(r.totalAssets),
  };
}

function toCapitalIncome(r: FmpIncomeStatementRow): CapitalIncomeRow {
  return {
    date: String(r.date ?? ""),
    revenue: num(r.revenue),
    operatingIncome: num(r.operatingIncome),
    ebit: num(r.ebit),
    ebitda: num(r.ebitda),
    interestExpense: num(r.interestExpense),
    netIncome: num(r.netIncome),
    weightedAverageShsOutDil: num(r.weightedAverageShsOutDil),
    weightedAverageShsOut: num(r.weightedAverageShsOut),
  };
}

function toCapitalCashFlow(r: FmpCashFlowRow): CapitalCashFlowRow {
  return {
    date: String(r.date ?? ""),
    netIncome: num(r.netIncome),
    depreciationAndAmortization: num(r.depreciationAndAmortization),
    stockBasedCompensation: num(r.stockBasedCompensation),
    operatingCashFlow: num(r.operatingCashFlow),
    capitalExpenditure: num(r.capitalExpenditure),
    freeCashFlow: num(r.freeCashFlow),
    commonStockRepurchased: num(r.commonStockRepurchased),
  };
}

function toCapitalBalance(r: FmpBalanceSheetRow): CapitalBalanceRow {
  return {
    date: String(r.date ?? ""),
    totalDebt: num(r.totalDebt),
    netDebt: num(r.netDebt),
    cashAndCashEquivalents: num(r.cashAndCashEquivalents),
    shortTermInvestments: num(r.shortTermInvestments),
    cashAndShortTermInvestments: num(r.cashAndShortTermInvestments),
  };
}

function toForensicsIncome(r: FmpIncomeStatementRow): ForensicsIncomeRow {
  return {
    date: String(r.date ?? ""),
    fiscalYear: str(r.fiscalYear),
    period: str(r.period),
    revenue: num(r.revenue),
    costOfRevenue: num(r.costOfRevenue),
    grossProfit: num(r.grossProfit),
    sellingGeneralAndAdministrativeExpenses: num(r.sellingGeneralAndAdministrativeExpenses),
    generalAndAdministrativeExpenses: num(r.generalAndAdministrativeExpenses),
    sellingAndMarketingExpenses: num(r.sellingAndMarketingExpenses),
    depreciationAndAmortization: num(r.depreciationAndAmortization),
    ebit: num(r.ebit),
    operatingIncome: num(r.operatingIncome),
    interestExpense: num(r.interestExpense),
    incomeTaxExpense: num(r.incomeTaxExpense),
    netIncome: num(r.netIncome),
    netIncomeFromContinuingOperations: num(r.netIncomeFromContinuingOperations),
    netIncomeFromDiscontinuedOperations: num(r.netIncomeFromDiscontinuedOperations),
    totalOtherIncomeExpensesNet: num(r.totalOtherIncomeExpensesNet),
  };
}

function toForensicsBalance(r: FmpBalanceSheetRow): ForensicsBalanceRow {
  return {
    date: String(r.date ?? ""),
    totalAssets: num(r.totalAssets),
    totalCurrentAssets: num(r.totalCurrentAssets),
    cashAndShortTermInvestments: num(r.cashAndShortTermInvestments),
    accountsReceivables: num(r.accountsReceivables),
    netReceivables: num(r.netReceivables),
    inventory: num(r.inventory),
    propertyPlantEquipmentNet: num(r.propertyPlantEquipmentNet),
    totalLiabilities: num(r.totalLiabilities),
    totalCurrentLiabilities: num(r.totalCurrentLiabilities),
    shortTermDebt: num(r.shortTermDebt),
    longTermDebt: num(r.longTermDebt),
    taxPayables: num(r.taxPayables),
    retainedEarnings: num(r.retainedEarnings),
    totalStockholdersEquity: num(r.totalStockholdersEquity),
    totalEquity: num(r.totalEquity),
    minorityInterest: num(r.minorityInterest),
    totalDebt: num(r.totalDebt),
  };
}

function toForensicsCashFlow(r: FmpCashFlowRow): ForensicsCashFlowRow {
  return {
    date: String(r.date ?? ""),
    netIncome: num(r.netIncome),
    depreciationAndAmortization: num(r.depreciationAndAmortization),
    netCashProvidedByOperatingActivities: num(r.netCashProvidedByOperatingActivities),
    netCashProvidedByInvestingActivities: num(r.netCashProvidedByInvestingActivities),
    commonStockIssuance: num(r.commonStockIssuance),
  };
}

function toOhlcv(r: FmpRawRow): OhlcvRow {
  return {
    date: String(r.date ?? ""),
    open: num(r.open) ?? 0,
    high: num(r.high) ?? 0,
    low: num(r.low) ?? 0,
    close: num(r.close) ?? 0,
    volume: num(r.volume) ?? 0,
  };
}

// ---------------------------------------------------------------------------
// TTM synthesis: sum the latest 4 quarters for flow fields, take latest for
// stock/per-share fields. Returns null when fewer than 4 quarters available.
// ---------------------------------------------------------------------------

export interface TtmIncome {
  date: string;
  revenue: number | null;
  operatingIncome: number | null;
  depreciationAndAmortization: number | null;
  netIncome: number | null;
  epsDiluted: number | null;
  ebit: number | null;
  interestExpense: number | null;
  incomeBeforeTax: number | null;
  incomeTaxExpense: number | null;
}

// --- Quarter contiguity gate (2026-07-09 audit M1) --------------------------
// slice(0,4) only guarantees "the 4 newest rows", not "the last 4 quarters":
// a missing middle quarter silently reaches back a 5th season (double-counting
// one quarter's seasonality) and a duplicated row (restatement) double-counts
// a quarter outright — either way the sum is mislabeled as TTM and feeds DCF
// startRevenue, P/E and EV/Sales. Gate: 4 DISTINCT period-ends, strictly
// descending, successive gaps each ~1 quarter and total span ~3 quarters.
// Bands accept 52/53-week fiscal calendars (13- and 14-week quarters).

const DAY_MS = 24 * 3600 * 1000;
/**
 * Accepted days between successive quarter-ends (12-week ≈ 84d; 13-week ≈ 91d;
 * 14-week ≈ 98d; monthly drift). Floor 70 rejects fiscal-transition stub
 * periods (~2 months) that would relabel an ~11-month window as TTM (2026-07-09
 * fix review) while still admitting a legitimate 4-4-4 12-week quarter.
 */
const QUARTER_GAP_DAYS: readonly [number, number] = [70, 135];
/** Accepted days from oldest to newest period-end (~3 quarters; 274d on a calendar year; floor = 3 × 84d). */
const TTM_SPAN_DAYS: readonly [number, number] = [250, 320];

/**
 * Returns a human-readable violation when the 4 newest-first rows are not a
 * contiguous trailing-twelve-month window, else null.
 */
function ttmContiguityViolation(rows: ReadonlyArray<{ date?: unknown }>): string | null {
  const ends: number[] = [];
  const labels: string[] = [];
  for (const r of rows) {
    const label = String(r.date ?? "");
    const t = Date.parse(label);
    if (!Number.isFinite(t)) return `unparseable quarter period-end date "${label}"`;
    ends.push(t);
    labels.push(label);
  }
  for (let i = 0; i + 1 < ends.length; i++) {
    const gapDays = Math.round((ends[i] - ends[i + 1]) / DAY_MS);
    if (gapDays === 0) return `duplicate quarter period-end ${labels[i]}`;
    if (gapDays < 0) return `quarter period-ends not in descending order (${labels[i]} before ${labels[i + 1]})`;
    if (gapDays < QUARTER_GAP_DAYS[0] || gapDays > QUARTER_GAP_DAYS[1]) {
      return `non-contiguous quarters: ${gapDays}-day gap between ${labels[i + 1]} and ${labels[i]} (accepted ${QUARTER_GAP_DAYS[0]}–${QUARTER_GAP_DAYS[1]} for 52/53-week calendars)`;
    }
  }
  const spanDays = Math.round((ends[0] - ends[ends.length - 1]) / DAY_MS);
  if (spanDays < TTM_SPAN_DAYS[0] || spanDays > TTM_SPAN_DAYS[1]) {
    return `four quarter-ends span ${spanDays} days (accepted ${TTM_SPAN_DAYS[0]}–${TTM_SPAN_DAYS[1]}) — not a trailing twelve months`;
  }
  return null;
}

function sumField(rows: FmpIncomeStatementRow[], key: keyof FmpIncomeStatementRow): number | null {
  let acc = 0;
  let seen = false;
  for (const r of rows) {
    const v = num(r[key]);
    if (v !== null) {
      acc += v;
      seen = true;
    }
  }
  return seen ? acc : null;
}

/** Non-null quarter count for a field (completeness gate for critical sums). */
function countField(rows: FmpIncomeStatementRow[], key: keyof FmpIncomeStatementRow): number {
  let n = 0;
  for (const r of rows) if (num(r[key]) !== null) n++;
  return n;
}

/**
 * TTM income from the latest 4 quarterly income rows (newest first).
 *
 * Completeness gating (2026-07 audit): revenue routes the pre-revenue overlay
 * and seeds the DCF, so a 3-of-4-quarter partial sum labeled "TTM" silently
 * understates it ~25% — when any of the 4 quarters lacks revenue the WHOLE row
 * is null so every consumer falls back to the audited annual row on one
 * consistent basis. The tax pair (incomeTaxExpense / incomeBeforeTax) is gated
 * as a PAIR so effective-tax rates are never computed over mismatched quarter
 * subsets. A null field is missing data, not a zero: every other period-flow
 * value is individually suppressed unless all four quarters report it. That
 * prevents a smaller period from contaminating EBITDA/FFO, DCF EBIT,
 * net-income multiples, or the cost-of-debt proxy. Suppressions are disclosed
 * via `gaps`.
 *
 * Contiguity gating (2026-07-09 audit M1): the 4 rows must also BE the last
 * four quarters — distinct period-ends, strictly descending, each gap ~1
 * quarter and total span ~3 quarters (52/53-week calendars accepted) — else
 * the whole row is suppressed with a disclosed gap and every consumer falls
 * back to the audited annual statement.
 */
export function ttmIncome(
  quarterly: FmpIncomeStatementRow[],
  gaps?: ManifestEntry[],
): TtmIncome | null {
  if (quarterly.length < 4) return null;
  const q = quarterly.slice(0, 4);

  // Contiguity gate (audit M1): a non-TTM window must never be labeled TTM.
  const violation = ttmContiguityViolation(q);
  if (violation !== null) {
    gaps?.push({
      field: "compute.ttmIncome",
      reason: `latest 4 quarterly rows do not form a contiguous trailing twelve months (${violation}) — TTM basis suppressed; latest annual statement used instead`,
      severity: "info",
      attemptedSources: ["fmp:/stable/income-statement?period=quarter"],
    });
    return null;
  }

  const revenueCount = countField(q, "revenue");
  if (revenueCount < 4) {
    gaps?.push({
      field: "compute.ttmIncome",
      reason: `revenue present in only ${revenueCount}/4 latest quarters — TTM basis suppressed (a partial sum would understate it); latest annual statement used instead`,
      severity: "info",
      attemptedSources: ["fmp:/stable/income-statement?period=quarter"],
    });
    return null;
  }

  let incomeBeforeTax = sumField(q, "incomeBeforeTax");
  let incomeTaxExpense = sumField(q, "incomeTaxExpense");
  const preTaxCount = countField(q, "incomeBeforeTax");
  const taxCount = countField(q, "incomeTaxExpense");
  if (preTaxCount < 4 || taxCount < 4) {
    if (incomeBeforeTax !== null || incomeTaxExpense !== null) {
      gaps?.push({
        field: "compute.ttmIncome.taxPair",
        reason: `incomeBeforeTax/incomeTaxExpense present in ${preTaxCount}/4 and ${taxCount}/4 quarters — TTM tax pair suppressed (a rate over mismatched quarters would be distorted)`,
        severity: "info",
        attemptedSources: ["fmp:/stable/income-statement?period=quarter"],
      });
    }
    incomeBeforeTax = null;
    incomeTaxExpense = null;
  }

  // Bottom-line fields feed routing (unprofitable overlay) and multiples
  // (P/E, EPS): a 3-of-4-quarter partial sum silently understates them —
  // e.g. an inflated P/E from missing a quarter of earnings. Gate them at
  // field level (not whole-row) with a disclosed suppression, same rationale
  // as the tax pair. All remaining period-flow fields are gated below as
  // well; missing is not equivalent to zero for a TTM calculation.
  const gateComplete = (key: keyof FmpIncomeStatementRow): number | null => {
    const count = countField(q, key);
    const value = sumField(q, key);
    if (count === 0 || count === 4) return value;
    gaps?.push({
      field: `compute.ttmIncome.${key}`,
      reason: `${key} present in only ${count}/4 latest quarters — TTM value suppressed (a partial sum labeled TTM would understate it)`,
      severity: "info",
      attemptedSources: ["fmp:/stable/income-statement?period=quarter"],
    });
    return null;
  };

  return {
    date: String(q[0].date ?? ""),
    revenue: sumField(q, "revenue"),
    operatingIncome: gateComplete("operatingIncome"),
    depreciationAndAmortization: gateComplete("depreciationAndAmortization"),
    netIncome: gateComplete("netIncome"),
    epsDiluted: gateComplete("epsDiluted"),
    ebit: gateComplete("ebit"),
    interestExpense: gateComplete("interestExpense"),
    incomeBeforeTax,
    incomeTaxExpense,
  };
}

/**
 * Effective tax rate from TTM statements (incomeTaxExpense / incomeBeforeTax)
 * for when the FMP ratios endpoints return nothing (the 6× missing
 * `returns.wacc.effectiveTaxRate` in the run-history audit). The two fields
 * are gated as a complete pair in ttmIncome, so the ratio never mixes quarter
 * subsets. Pre-tax losses return null — a negative-base "rate" is meaningless
 * for WACC (computeWacc suppresses a levered WACC when no observed rate exists).
 */
export function effectiveTaxRateFromTtm(ttm: TtmIncome | null): number | null {
  if (ttm === null || ttm.incomeTaxExpense === null || ttm.incomeBeforeTax === null) return null;
  if (!(ttm.incomeBeforeTax > 0)) return null;
  return ttm.incomeTaxExpense / ttm.incomeBeforeTax;
}

interface TtmCashFlow {
  date: string;
  operatingCashFlow: number | null;
  capitalExpenditure: number | null;
  depreciationAndAmortization: number | null;
}

export function ttmCashFlow(
  quarterly: FmpCashFlowRow[],
  gaps?: ManifestEntry[],
): TtmCashFlow | null {
  if (quarterly.length < 4) return null;
  const q = quarterly.slice(0, 4);
  // Contiguity gate (audit M1) — identical to ttmIncome.
  const violation = ttmContiguityViolation(q);
  if (violation !== null) {
    gaps?.push({
      field: "compute.ttmCashFlow",
      reason: `latest 4 quarterly rows do not form a contiguous trailing twelve months (${violation}) — TTM basis suppressed; latest annual statement used instead`,
      severity: "info",
      attemptedSources: ["fmp:/stable/cash-flow-statement?period=quarter"],
    });
    return null;
  }
  const sum = (key: keyof FmpCashFlowRow): number | null => {
    let acc = 0;
    let seen = false;
    for (const r of q) {
      const v = num(r[key]);
      if (v !== null) {
        acc += v;
        seen = true;
      }
    }
    return seen ? acc : null;
  };
  const gateComplete = (key: keyof FmpCashFlowRow): number | null => {
    let count = 0;
    for (const row of q) if (num(row[key]) !== null) count++;
    if (count === 0 || count === 4) return sum(key);
    gaps?.push({
      field: `compute.ttmCashFlow.${key}`,
      reason: `${key} present in only ${count}/4 latest quarters — TTM value suppressed (a partial sum would understate the period flow)`,
      severity: "info",
      attemptedSources: ["fmp:/stable/cash-flow-statement?period=quarter"],
    });
    return null;
  };
  return {
    date: String(q[0].date ?? ""),
    operatingCashFlow: gateComplete("operatingCashFlow"),
    capitalExpenditure: gateComplete("capitalExpenditure"),
    depreciationAndAmortization: gateComplete("depreciationAndAmortization"),
  };
}

// ---------------------------------------------------------------------------
// runStageB
// ---------------------------------------------------------------------------

const SPREAD_DAYS = 24 * 3600 * 1000;

/** Latest risk-free rate (10y): FMP treasury.year10 (pct) → FRED DGS10 (pct). */
function riskFreePct(bundle: DataBundle): { pct: number | null; asOf: string | null } {
  const treasuryRows = rowsOf(bundle.treasury);
  const t = treasuryRows[0];
  const fromTreasury = t ? num(t.year10) : null;
  if (fromTreasury !== null) {
    return { pct: fromTreasury, asOf: isoDay(t?.date) };
  }
  const dgs10 = bundle.macro.core["DGS10"];
  if (dgs10 && dgs10.ok) {
    const obs = dgs10.value.data;
    const last = obs[obs.length - 1];
    if (last && Number.isFinite(last.value)) {
      return { pct: last.value, asOf: last.date };
    }
  }
  return { pct: null, asOf: null };
}

/**
 * Latest-two totalDebt observations for WACC.
 *
 * A negative balance is invalid for FMP's totalDebt field. Preserve that fact
 * separately so opposite-signed observations can never average to zero and
 * impersonate a genuinely debt-free capital structure.
 */
function totalDebtSnapshot(balances: FmpBalanceSheetRow[]): {
  average: number | null;
  negativeObservation: number | null;
} {
  const a = balances[0] ? num(balances[0].totalDebt) : null;
  const b = balances[1] ? num(balances[1].totalDebt) : null;
  const negativeObservation = [a, b].find((value) => value !== null && value < 0) ?? null;
  if (negativeObservation !== null) return { average: null, negativeObservation };
  if (a === null && b === null) return { average: null, negativeObservation: null };
  if (a !== null && b !== null) return { average: (a + b) / 2, negativeObservation: null };
  return { average: a ?? b, negativeObservation: null };
}

export function runStageB(bundle: DataBundle): ComputedMetrics {
  const notes: string[] = [];
  const suppressed: SuppressedMetric[] = [];

  const profile = firstRow(bundle.profile);
  const quote = firstRow(bundle.quote);

  const incomeAnnual = rowsOf(bundle.statements.incomeAnnual);
  const balanceAnnual = rowsOf(bundle.statements.balanceAnnual);
  const cashflowAnnual = rowsOf(bundle.statements.cashflowAnnual);
  const incomeQuarterly = rowsOf(bundle.statements.incomeQuarterly);
  const balanceQuarterly = rowsOf(bundle.statements.balanceQuarterly);
  const cashflowQuarterly = rowsOf(bundle.statements.cashflowQuarterly);

  const todayIso = bundle.builtAt.slice(0, 10);

  // --- Route FIRST -----------------------------------------------------------
  const inc0 = incomeAnnual[0];
  const cf0 = cashflowAnnual[0];
  const routingIncomeAnnual: RoutingIncomeRow | null = inc0
    ? { date: isoDay(inc0.date), revenue: num(inc0.revenue), netIncome: num(inc0.netIncome) }
    : null;
  const ttmGaps: ManifestEntry[] = [];
  const ttmInc = ttmIncome(incomeQuarterly, ttmGaps);
  const routingIncomeTtm: RoutingIncomeRow | null = ttmInc
    ? { date: ttmInc.date, revenue: ttmInc.revenue, netIncome: ttmInc.netIncome }
    : routingIncomeAnnual;
  const routingCashflowAnnual: RoutingCashflowRow | null = cf0
    ? { date: isoDay(cf0.date), operatingCashFlow: num(cf0.operatingCashFlow) }
    : null;
  const ttmCf = ttmCashFlow(cashflowQuarterly, ttmGaps);
  const routingCashflowTtm: RoutingCashflowRow | null = ttmCf
    ? { date: ttmCf.date, operatingCashFlow: ttmCf.operatingCashFlow }
    : routingCashflowAnnual;

  const route = routeCompany(
    {
      sector: str(profile?.sector),
      industry: str(profile?.industry),
      isAdr: typeof profile?.isAdr === "boolean" ? profile.isAdr : null,
      isEtf: typeof profile?.isEtf === "boolean" ? profile.isEtf : null,
      isFund: typeof profile?.isFund === "boolean" ? profile.isFund : null,
      ipoDate: str(profile?.ipoDate),
      country: str(profile?.country),
      currency: str(profile?.currency),
    },
    {
      incomeTtm: routingIncomeTtm,
      incomeAnnual: routingIncomeAnnual,
      cashflowTtm: routingCashflowTtm,
      cashflowAnnual: routingCashflowAnnual,
      availableQuarters: incomeQuarterly.length,
    },
    { today: todayIso },
  );

  const policy = metricPolicy(route);
  const isSuppressed = (key: string): boolean => policy.suppress.includes(key);
  const suppress = (key: string, reason: string): void => {
    suppressed.push({ key, reason });
  };

  const degradation = degradationPlan(route.base, route.overlays, incomeQuarterly.length);

  // --- Growth ----------------------------------------------------------------
  const growth = computeGrowth(
    incomeAnnual.map(toGrowthIncome),
    cashflowAnnual.map(toGrowthCashFlow),
    { period: "annual" },
  );

  // --- Returns (WACC / ROIC / DuPont) ---------------------------------------
  const returns = computeReturns(bundle, incomeAnnual, balanceAnnual, ttmInc, route);

  // --- Capital ---------------------------------------------------------------
  const capital = computeCapital(
    incomeAnnual.map(toCapitalIncome),
    cashflowAnnual.map(toCapitalCashFlow),
    balanceAnnual.map(toCapitalBalance),
    rowsOf(bundle.marketCapHistory).map<MarketCapPoint>((r) => ({
      date: String(r.date ?? ""),
      marketCap: num(r.marketCap),
    })),
    quoteInput(quote),
  );

  // --- Forensics (route-aware; module handles financial suppression) --------
  const forensics = runForensics(route, {
    income: incomeAnnual.map(toForensicsIncome),
    balance: balanceAnnual.map(toForensicsBalance),
    cashFlow: cashflowAnnual.map(toForensicsCashFlow),
    marketCap: num(profile?.marketCap ?? quote?.marketCap),
    marketCapAsOf: isoDay(inc0?.date),
    reportedCurrency: str(inc0?.reportedCurrency),
    quoteCurrency: str(profile?.currency),
    classification: {
      sector: str(profile?.sector),
      industry: str(profile?.industry),
    },
  });

  // --- Technicals ------------------------------------------------------------
  // EOD rows are date DESC in the bundle; the module re-sorts ASC defensively.
  const eod = rowsOf(bundle.eodPrices).map(toOhlcv);
  const spy = rowsOf(bundle.benchmarkPrices.spy).map(toOhlcv);
  const sectorEtf = rowsOf(bundle.benchmarkPrices.sectorEtf).map(toOhlcv);
  const technicals = computeTechnicals(
    eod,
    spy,
    sectorEtf,
    bundle.benchmarkPrices.sectorEtfSymbol,
  );

  // --- Valuation -------------------------------------------------------------
  const valuation = computeValuation(bundle, {
    route,
    incomeAnnual,
    balanceAnnual,
    cashflowAnnual,
    incomeQuarterly,
    balanceQuarterly,
    cashflowQuarterly,
    ttmInc,
    ttmCf,
    growth,
    wacc: returns.wacc,
    profile,
    quote,
  });

  // --- Runway (overlay-gated) ------------------------------------------------
  let runway: RunwayResult | null = null;
  const needsRunway =
    route.overlays.includes("pre-revenue") ||
    route.overlays.includes("unprofitable") ||
    route.overlays.includes("recent-ipo");
  if (needsRunway) {
    const b0 = balanceQuarterly[0] ?? balanceAnnual[0];
    if (b0) {
      runway = computeRunway(
        {
          date: String(b0.date ?? ""),
          cashAndCashEquivalents: num(b0.cashAndCashEquivalents),
          shortTermInvestments: num(b0.shortTermInvestments),
          cashAndShortTermInvestments: num(b0.cashAndShortTermInvestments),
        },
        cashflowQuarterly.map((r) => ({
          date: String(r.date ?? ""),
          operatingCashFlow: num(r.operatingCashFlow),
          capitalExpenditure: num(r.capitalExpenditure),
        })),
        incomeQuarterly.map((r) => ({
          date: String(r.date ?? ""),
          weightedAverageShsOutDil: num(r.weightedAverageShsOutDil),
        })),
      );
    }
  }

  // --- Scores + projections (deterministic; feature 1.1.0) ------------------
  const currentPrice = num(quote?.price);
  const asOfDay = bundle.builtAt.slice(0, 10);
  const scores = computeScores({
    route,
    policy,
    growth,
    roic: returns.roic,
    roicVsWacc: returns.roicVsWacc,
    wacc: returns.wacc,
    capital,
    forensics,
    technicals,
    valuation,
    currentPrice,
    asOf: asOfDay,
  });

  // Same point-in-time anchors as computeValuation (audit H2/M3/M4): the NEWER
  // of the latest quarterly vs annual whole rows (balance + diluted shares,
  // zero-for-undisclosed share counts treated as missing), and net debt from
  // the shared components-only resolver. Disclosures are emitted once from the
  // valuation block (identical underlying rows).
  const inc0Proj = incomeAnnual[0];
  const projRowDate = (r: { date?: unknown } | null | undefined): string =>
    typeof r?.date === "string" ? r.date : "";
  const balQProj = balanceQuarterly[0] ?? null;
  const balPointProj =
    (projRowDate(balQProj) >= projRowDate(balanceAnnual[0]) ? (balQProj ?? balanceAnnual[0]) : (balanceAnnual[0] ?? balQProj)) ?? null;
  const posSharesProj = (v: number | null): number | null => (v !== null && v > 0 ? v : null);
  const sharesQProj = posSharesProj(num(incomeQuarterly[0]?.weightedAverageShsOutDil));
  const sharesAProj = posSharesProj(num(inc0Proj?.weightedAverageShsOutDil));
  const dilutedSharesProj =
    projRowDate(incomeQuarterly[0]) >= projRowDate(inc0Proj) ? (sharesQProj ?? sharesAProj) : (sharesAProj ?? sharesQProj);
  const netDebtProj = netDebtFromBalance(balPointProj).value;
  const projectionIncomeHistory = incomeAnnual.map(
    (r): ProjectionIncomeRow => ({
      date: String(r.date ?? ""),
      revenue: num(r.revenue),
      ebit: num(r.ebit) ?? num(r.operatingIncome),
      netIncome: num(r.netIncome),
      epsDiluted: num(r.epsDiluted),
    }),
  );
  const projectionCurrency = str(profile?.currency) ?? "USD";
  const projections = computeProjections({
    route,
    valuation,
    waccPct: returns.wacc.waccPct,
    netDebt: netDebtProj,
    dilutedShares: dilutedSharesProj,
    incomeHistory: projectionIncomeHistory,
    fcfHistory: capital.fcf.series.map((r) => ({ date: r.date, fcf: r.fcf })),
    shareCountAnnualizedPct: capital.shareCount.annualizedPct,
    currency: projectionCurrency,
    asOf: asOfDay,
  });

  // Deterministic bull/base/bear price targets (2026-07-11 scenario-credibility
  // checkpoint). Reuses the SAME point-in-time anchors + ±σ construction as the
  // projection fan, so the target band and the fan agree; base IS the DCF fair
  // value. Suppressed (never fabricated) off the general DCF route / on missing
  // WACC or bridge inputs. assembleReport overwrites the judge's scenario
  // priceTargets from this — the LLM no longer authors the headline numbers.
  const scenarioTargets = computeScenarioTargets({
    route,
    valuation,
    waccPct: returns.wacc.waccPct,
    netDebt: netDebtProj,
    dilutedShares: dilutedSharesProj,
    minorityInterest: balPointProj ? num(balPointProj.minorityInterest) : null,
    preferred: balPointProj ? num(balPointProj.preferredStock) : null,
    incomeHistory: projectionIncomeHistory,
    currentPrice,
    currency: projectionCurrency,
    asOf: asOfDay,
  });

  // Deterministic intrinsic per-share fair value (2026-07-11 DCF-credibility
  // checkpoint). Route-appropriate (FCFF DCF / excess-return), reused from
  // valueCompany — never recomputed. assembleReport overwrites the judge's
  // valuation.dcf.perShare + upsidePct from this; suppressed (never fabricated)
  // when no per-share model applies or the equity bridge is missing.
  const fairValue = computeFairValue({
    valuation,
    currentPrice,
    currency: projectionCurrency,
    asOf: asOfDay,
  });

  // --- Metric-policy suppression sweep (disclose, don't silently drop) -------
  // Forensics Z / M already suppressed inside runForensics for financials; we
  // additionally record the policy-driven suppressions for the UI.
  if (isSuppressed("altmanZ")) suppress("forensics.altmanZ", `Altman Z-score not meaningful for ${route.base} — suppressed by metric policy`);
  if (isSuppressed("beneishM")) suppress("forensics.beneishM", `Beneish M-score not meaningful for ${route.base} — suppressed by metric policy`);
  if (isSuppressed("fcfDcf")) {
    suppress(
      "valuation.dcf",
      route.overlays.includes("unprofitable")
        ? "FCFF DCF not meaningful — free cash flow is structurally negative (unprofitable overlay); see multiples for relative valuation"
        : `FCFF DCF not meaningful for ${route.base} — book/excess-return model used`,
    );
  }
  if (isSuppressed("evEbitda")) suppress("multiples.evToEbitda", `EV/EBITDA excluded for ${route.base} — enterprise value ill-defined`);
  if (isSuppressed("currentRatio")) suppress("returns.currentRatio", `current ratio not meaningful for ${route.base}`);

  // --- Merge all gaps + notes ------------------------------------------------
  const gaps = mergeManifest(
    bundle.gaps,
    ttmGaps,
    route.gaps,
    degradation.gaps,
    growth.gaps,
    returns.gaps,
    capital.gaps,
    forensics.gaps,
    technicals.gaps,
    valuation.gaps,
    runway?.gaps ?? null,
  );

  notes.push(...route.notes);
  return {
    symbol: bundle.symbol,
    builtAt: bundle.builtAt,
    route,
    degradation,
    growth,
    returns,
    capital,
    forensics,
    technicals,
    valuation,
    runway,
    scores,
    projections,
    scenarioTargets,
    fairValue,
    suppressed,
    notes,
    gaps,
  };
}

// ---------------------------------------------------------------------------
// Returns block
// ---------------------------------------------------------------------------

function quoteInput(quote: FmpRawRow | null): QuoteInput {
  return { price: num(quote?.price), timestamp: num(quote?.timestamp) };
}

function computeReturns(
  bundle: DataBundle,
  incomeAnnual: FmpIncomeStatementRow[],
  balanceAnnual: FmpBalanceSheetRow[],
  ttmInc: TtmIncome | null,
  route: CompanyRouteResult,
): ReturnsBlock {
  const notes: string[] = [];
  const gaps: ManifestEntry[] = [];

  const profile = firstRow(bundle.profile);
  const quote = firstRow(bundle.quote);
  const ratiosTtm = rowsOf(bundle.ratiosTtm)[0] ?? rowsOf(bundle.ratios)[0];
  const rf = riskFreePct(bundle);
  const usErpPct = selectUsEquityRiskPremium(rowsOf(bundle.marketRiskPremium));
  const bal0 = balanceAnnual[0];
  const debtSnapshot = totalDebtSnapshot(balanceAnnual);

  const isFinancial = route.base === "bank" || route.base === "insurer" || route.base === "reit-mortgage";

  // 2026-07-09 audit M2: key the annual fallback on FIELD nullness, not on
  // ttmInc existence — when the completeness gate nulls a TTM field the annual
  // figure must still be consulted. Missing interest with debt now suppresses
  // WACC, but using a complete annual observation preserves more valid output.
  // Each annual fallback is disclosed with its basis in notes.
  const annualDate = isoDay(incomeAnnual[0]?.date) ?? "?";
  const interestExpenseAnnual = num(incomeAnnual[0]?.interestExpense);
  const interestExpenseForWacc = ttmInc?.interestExpense ?? interestExpenseAnnual;
  if (ttmInc && ttmInc.interestExpense === null && interestExpenseAnnual !== null) {
    notes.push(
      `WACC interest expense: TTM field unavailable (suppressed or unreported) — latest annual FY (${annualDate}) figure used instead`,
    );
  }
  const ebitAnnual = num(incomeAnnual[0]?.operatingIncome);
  const ebitForWacc = ttmInc?.ebit ?? ttmInc?.operatingIncome ?? ebitAnnual;
  if (ttmInc && ttmInc.ebit === null && ttmInc.operatingIncome === null && ebitAnnual !== null) {
    notes.push(
      `WACC EBIT (interest-coverage input): TTM fields unavailable (suppressed or unreported) — latest annual FY (${annualDate}) operating income used instead`,
    );
  }

  const wacc = computeWacc({
    beta: num(profile?.beta),
    riskFreePct: rf.pct,
    erpPct: usErpPct,
    interestExpenseTtm: interestExpenseForWacc,
    totalDebtAvg: debtSnapshot.average,
    negativeTotalDebtObservation: debtSnapshot.negativeObservation,
    marketCap: num(quote?.marketCap ?? profile?.marketCap),
    // FMP's ratios-ttm endpoint suffixes every metric name with "TTM"
    // (effectiveTaxRate -> effectiveTaxRateTTM); the annual ratios fallback row
    // keeps the bare name. Try both so a live vendor rename doesn't silently
    // suppress a levered WACC unnecessarily.
    effectiveTaxRate:
      num(ratiosTtm?.effectiveTaxRateTTM ?? ratiosTtm?.effectiveTaxRate) ??
      effectiveTaxRateFromTtm(ttmInc),
    ebitTtm: ebitForWacc,
    analysisDate: isoDay(bundle.builtAt) ?? undefined,
    isFinancial,
    totalAssets: bal0 ? num(bal0.totalAssets) : null,
    asOf: {
      riskFreeRate: rf.asOf ?? undefined,
      statements: isoDay(incomeAnnual[0]?.date) ?? undefined,
      marketCap: sourcedOf(bundle.quote)?.asOf,
    },
  });

  const roic = computeRoic(incomeAnnual.map(toReturnsIncome), balanceAnnual.map(toReturnsBalance));
  const dupont = computeDupont(incomeAnnual.map(toReturnsIncome), balanceAnnual.map(toReturnsBalance));
  const roicVsWacc = computeRoicVsWaccSpread(roic.latestRoicPct, wacc.waccPct);

  gaps.push(...wacc.gaps, ...roic.gaps, ...dupont.gaps);
  return { wacc, roic, dupont, roicVsWacc, notes, gaps };
}

// ---------------------------------------------------------------------------
// Valuation block — assemble the discriminated ValuationBundleInputs
// ---------------------------------------------------------------------------

interface ValuationCtx {
  route: CompanyRouteResult;
  incomeAnnual: FmpIncomeStatementRow[];
  balanceAnnual: FmpBalanceSheetRow[];
  cashflowAnnual: FmpCashFlowRow[];
  incomeQuarterly: FmpIncomeStatementRow[];
  balanceQuarterly: FmpBalanceSheetRow[];
  cashflowQuarterly: FmpCashFlowRow[];
  ttmInc: TtmIncome | null;
  ttmCf: TtmCashFlow | null;
  growth: GrowthResult;
  wacc: WaccResult;
  profile: FmpRawRow | null;
  quote: FmpRawRow | null;
}

function cagrPctFor(growth: GrowthResult, window: number): number | null {
  const p = growth.revenueCagrs.find((c) => c.windowYears === window);
  return p ? p.cagrPct : null;
}

function computeValuation(bundle: DataBundle, ctx: ValuationCtx): ValuationResult {
  const { route, incomeAnnual, balanceAnnual, balanceQuarterly, incomeQuarterly, ttmInc, ttmCf, growth, wacc, profile, quote } = ctx;

  const bal0 = balanceAnnual[0];
  const inc0 = incomeAnnual[0];
  const rowDate = (r: { date?: unknown } | null | undefined): string =>
    typeof r?.date === "string" ? r.date : "";
  // Point-in-time balance anchor (2026-07-09 audit M4): whole-row preference
  // for the NEWER of the latest quarterly vs latest annual balance row — a
  // lagging quarterly feed must not beat a fresher annual row, and fields are
  // never mixed across periods. Same pattern runway already uses.
  const balQ = balanceQuarterly[0] ?? null;
  const balPoint = (rowDate(balQ) >= rowDate(bal0) ? (balQ ?? bal0) : (bal0 ?? balQ)) ?? null;
  const balPointBasis: "quarter" | "annual" | undefined =
    balPoint === null ? undefined : balPoint === balQ ? "quarter" : "annual";
  const ratiosTtm = rowsOf(bundle.ratiosTtm)[0] ?? rowsOf(bundle.ratios)[0];
  const keyMetricsTtm = rowsOf(bundle.keyMetricsTtm)[0] ?? rowsOf(bundle.keyMetrics)[0];

  const currentPrice = num(quote?.price);
  const marketCap = num(quote?.marketCap ?? profile?.marketCap);
  // 2026-07-09 audit M3: per-share values against a current price use the
  // weighted-average diluted share count from the NEWER of the latest quarterly
  // vs annual income statement (domain-valuation.md §"per-share"); annual can be
  // up to ~18 months stale on buybacks/dilution, but a lagging quarterly feed
  // must not beat a fresher annual row. A literal 0 is FMP's
  // zero-for-undisclosed sentinel, not a real count (missing ≠ zero).
  const posShares = (v: number | null): number | null => (v !== null && v > 0 ? v : null);
  const sharesQuarterly = posShares(num(incomeQuarterly[0]?.weightedAverageShsOutDil));
  const sharesAnnual = posShares(num(inc0?.weightedAverageShsOutDil));
  const quarterlySharesFresh = rowDate(incomeQuarterly[0]) >= rowDate(inc0);
  const dilutedShares = quarterlySharesFresh ? (sharesQuarterly ?? sharesAnnual) : (sharesAnnual ?? sharesQuarterly);
  const dilutedSharesBasis: "quarter" | "annual" | null =
    dilutedShares === null
      ? null
      : (quarterlySharesFresh && sharesQuarterly !== null) || sharesAnnual === null
        ? "quarter"
        : "annual";

  const netDebtInfo = netDebtFromBalance(balPoint);
  const netDebtDerived = netDebtInfo.value;

  // --- DCF inputs (general route) -------------------------------------------
  const analystEstimates: AnalystEstimateRow[] | null = bundle.analystEstimates.ok
    ? rowsOf(bundle.analystEstimates)
        .map((r) => ({ date: String(r.date ?? ""), revenueAvg: num(r.revenueAvg) }))
        .filter((r) => r.date.length > 0)
    : null;

  const dcfIncomeTtm: DcfIncomeRow | null = ttmInc
    ? {
        date: ttmInc.date,
        basis: "ttm",
        revenue: ttmInc.revenue,
        operatingIncome: ttmInc.operatingIncome,
        incomeBeforeTax: ttmInc.incomeBeforeTax,
        incomeTaxExpense: ttmInc.incomeTaxExpense,
      }
    : inc0
      ? {
          date: String(inc0.date ?? ""),
          basis: "annual",
          revenue: num(inc0.revenue),
          operatingIncome: num(inc0.operatingIncome),
          incomeBeforeTax: num(inc0.incomeBeforeTax),
          incomeTaxExpense: num(inc0.incomeTaxExpense),
        }
      : null;

  const dcfIncomeHistory: DcfIncomeRow[] = incomeAnnual.map((r) => ({
    date: String(r.date ?? ""),
    revenue: num(r.revenue),
    operatingIncome: num(r.operatingIncome),
    incomeBeforeTax: num(r.incomeBeforeTax),
    incomeTaxExpense: num(r.incomeTaxExpense),
  }));

  const dcfBalance: DcfBalanceRow | null = bal0
    ? {
        date: String(bal0.date ?? ""),
        totalDebt: num(bal0.totalDebt),
        totalStockholdersEquity: num(bal0.totalStockholdersEquity),
        cashAndShortTermInvestments: num(bal0.cashAndShortTermInvestments),
      }
    : null;

  const rf = riskFreePct(bundle);
  const dcfInputs: DcfAssumptionInputs | null =
    route.base === "general" && !route.overlays.includes("pre-revenue")
      ? {
          revenueCagr3yPct: cagrPctFor(growth, 3),
          revenueCagr5yPct: cagrPctFor(growth, 5),
          analystEstimates,
          waccPct: wacc.waccPct ?? 0,
          riskFreePct: rf.pct ?? 0,
          incomeTtm: dcfIncomeTtm,
          incomeHistory: dcfIncomeHistory,
          balance: dcfBalance,
          marketCap,
          // ADR guard (audit H3): same currency pair the multiples framework
          // already flags — valueCompany suppresses the DCF on mismatch.
          reportedCurrency: str(inc0?.reportedCurrency),
          quoteCurrency: str(profile?.currency),
        }
      : null;

  // --- Multiples framework ---------------------------------------------------
  const multiplesQuote: MultiplesQuoteInputs = {
    price: currentPrice,
    marketCap,
    currency: str(profile?.currency),
  };
  const multiplesIncomeTtm: MultiplesIncomeTtm | null = ttmInc
    ? {
        date: ttmInc.date,
        basis: "ttm",
        revenue: ttmInc.revenue,
        operatingIncome: ttmInc.operatingIncome,
        depreciationAndAmortization: ttmInc.depreciationAndAmortization,
        netIncome: ttmInc.netIncome,
        epsDiluted: ttmInc.epsDiluted,
      }
    : inc0
      ? {
          date: String(inc0.date ?? ""),
          basis: "annual",
          revenue: num(inc0.revenue),
          operatingIncome: num(inc0.operatingIncome),
          depreciationAndAmortization: num(inc0.depreciationAndAmortization),
          netIncome: num(inc0.netIncome),
          epsDiluted: num(inc0.epsDiluted),
        }
      : null;
  const multiplesCashFlowTtm: MultiplesCashFlowTtm | null = ttmCf
    ? {
        date: ttmCf.date,
        basis: "ttm",
        operatingCashFlow: ttmCf.operatingCashFlow,
        capitalExpenditure: ttmCf.capitalExpenditure,
        depreciationAndAmortization: ttmCf.depreciationAndAmortization,
      }
    : ctx.cashflowAnnual[0]
      ? {
          date: String(ctx.cashflowAnnual[0].date ?? ""),
          basis: "annual",
          operatingCashFlow: num(ctx.cashflowAnnual[0].operatingCashFlow),
          capitalExpenditure: num(ctx.cashflowAnnual[0].capitalExpenditure),
          depreciationAndAmortization: num(ctx.cashflowAnnual[0].depreciationAndAmortization),
        }
      : null;
  const multiplesBalance: MultiplesBalance | null = balPoint
    ? {
        date: String(balPoint.date ?? ""),
        basis: balPointBasis,
        totalDebt: num(balPoint.totalDebt),
        cashAndShortTermInvestments: num(balPoint.cashAndShortTermInvestments),
        totalStockholdersEquity: num(balPoint.totalStockholdersEquity),
        goodwill: num(balPoint.goodwill),
        intangibleAssets: num(balPoint.intangibleAssets),
        minorityInterest: num(balPoint.minorityInterest),
        preferredStock: num(balPoint.preferredStock),
      }
    : null;

  const quarterlyFundamentals: QuarterlyFundamentalsRow[] = mergeQuarterly(
    ctx.incomeQuarterly,
    ctx.cashflowQuarterly,
    ctx.balanceQuarterly,
  );

  const enterpriseValuesHistory: EnterpriseValuesRow[] = rowsOf(bundle.enterpriseValues).map((r) => ({
    date: String(r.date ?? ""),
    marketCapitalization: num(r.marketCapitalization),
    enterpriseValue: num(r.enterpriseValue),
  }));

  // REIT FFO/AFFO approximations (labeled approximate upstream).
  const da = ttmInc?.depreciationAndAmortization ?? null;
  const ffoApprox = ttmInc && ttmInc.netIncome !== null && da !== null ? ttmInc.netIncome + da : null;
  const affoApprox =
    ffoApprox !== null && ttmCf && ttmCf.capitalExpenditure !== null
      ? ffoApprox - Math.abs(ttmCf.capitalExpenditure)
      : null;

  const multiples: MultiplesFrameworkInputs = {
    quote: multiplesQuote,
    reportedCurrency: str(inc0?.reportedCurrency),
    incomeTtm: multiplesIncomeTtm,
    cashFlowTtm: multiplesCashFlowTtm,
    balance: multiplesBalance,
    quarterlyFundamentals,
    enterpriseValuesHistory,
    ffoApprox: route.base === "reit" ? ffoApprox : null,
    affoApprox: route.base === "reit" ? affoApprox : null,
  };

  // --- Excess-return inputs (financials) ------------------------------------
  const excessReturn: ExcessReturnInputs | null =
    route.base === "bank" || route.base === "insurer" || route.base === "reit-mortgage"
      ? {
          bookValue: balPoint ? num(balPoint.totalStockholdersEquity) : null,
          // Same FMP TTM-suffix drift as effectiveTaxRate above
          // (returnOnEquity -> returnOnEquityTTM on key-metrics-ttm).
          currentRoePct: pctFromFraction(num(keyMetricsTtm?.returnOnEquityTTM ?? keyMetricsTtm?.returnOnEquity)),
          // Audit M5: null CoE SUPPRESSES the model inside excessReturnModel
          // (critical gap) — never a silent 10% default.
          costOfEquityPct: wacc.costOfEquityPct,
          // Audit L4: (dividends + net buybacks) / net income, 3y average, from
          // the annual cash-flow statements; null suppresses the valuation.
          payoutRatioPct: payoutRatioPct3y(ctx.cashflowAnnual),
          dilutedShares,
          marketCap,
          asOf: isoDay(balPoint?.date),
        }
      : null;

  // --- REIT inputs -----------------------------------------------------------
  const noiApprox = ttmInc && ttmInc.operatingIncome !== null && da !== null ? ttmInc.operatingIncome + da : null;
  const reit: ReitInputs | null =
    route.base === "reit"
      ? {
          ffoApprox,
          affoApprox,
          sharePrice: currentPrice,
          shares: dilutedShares,
          netDebt: netDebtDerived,
          noiApprox,
          asOf: ttmInc?.date ?? isoDay(inc0?.date),
        }
      : null;

  const bundleInputs: ValuationBundleInputs = {
    currentPrice,
    waccPct: wacc.waccPct,
    netDebt: netDebtDerived,
    dilutedShares,
    minorityInterest: balPoint ? num(balPoint.minorityInterest) : null,
    preferred: balPoint ? num(balPoint.preferredStock) : null,
    dcfInputs,
    multiples,
    excessReturn,
    reit,
  };

  void ratiosTtm; // reserved for future ratio cross-checks
  const result = valueCompany(route, bundleInputs);
  // Basis disclosures for the point-in-time anchors chosen above (audit H2/M3).
  if (netDebtInfo.value === null && balPoint !== null) {
    result.notes.push(
      `${netDebtInfo.version}: net debt unavailable — ${netDebtInfo.reason}`,
    );
    result.gaps.push({
      field: "valuation.netDebt",
      reason: `${netDebtInfo.reason}; valuation equity bridge suppressed rather than using FMP's incompatible cash-only netDebt field`,
      severity: "warn",
    });
  } else if (netDebtInfo.value !== null) {
    const c = netDebtInfo.components;
    result.notes.push(
      `${netDebtInfo.version}: net debt ${netDebtInfo.value} as of ${netDebtInfo.asOf ?? "?"}; totalDebt ${c.totalDebt}, cashAndShortTermInvestments ${c.cashAndShortTermInvestments ?? "derived from cash + shortTermInvestments"}`,
    );
  }
  if (dilutedSharesBasis === "annual") {
    result.notes.push(
      `diluted share count from the latest ANNUAL statement (${isoDay(inc0?.date) ?? "?"}) — latest-quarter weightedAverageShsOutDil unavailable, zero, or older than the annual row; per-share values may lag recent buybacks/dilution`,
    );
  }
  return result;
}

/**
 * Point-in-time net debt (2026-07-09 audit H2). House convention — matching the
 * multiples-EV and invested-capital definitions — is
 * totalDebt − (cashAndShortTermInvestments ?? cashAndCashEquivalents), derived
 * from statement fields. FMP's vendor `netDebt` field nets cash ONLY
 * (the statement-field contract: netDebt = totalDebt − cashAndCashEquivalents),
 * so it is retained only as a diagnostic component and never used as a
 * fallback for the house convention.
 */
function netDebtFromBalance(
  bal: FmpBalanceSheetRow | null | undefined,
): NetDebtResolution {
  return resolveNetDebt({
    date: bal ? str(bal.date) : null,
    totalDebt: bal ? num(bal.totalDebt) : null,
    cashAndCashEquivalents: bal ? num(bal.cashAndCashEquivalents) : null,
    shortTermInvestments: bal ? num(bal.shortTermInvestments) : null,
    cashAndShortTermInvestments: bal ? num(bal.cashAndShortTermInvestments) : null,
    vendorNetDebt: bal ? num(bal.netDebt) : null,
  });
}

/**
 * Payout ratio for the excess-return model (2026-07-09 audit L4):
 * (common dividends + net buybacks) / net income per fiscal year, averaged over
 * the latest 3 annual cash-flow rows with POSITIVE net income, clamped to
 * [0, 100]. FMP signs: commonDividendsPaid / commonStockRepurchased are
 * negative outflows, commonStockIssuance a positive inflow (net buybacks =
 * |repurchases| − issuance). Years reporting neither dividends nor buybacks are
 * unusable (missing ≠ zero); fewer than 2 usable years returns null so the
 * excess-return valuation is suppressed rather than assigned a house payout.
 */
export function payoutRatioPct3y(cashflowAnnual: FmpCashFlowRow[]): number | null {
  const ratios: number[] = [];
  for (const r of cashflowAnnual.slice(0, 3)) {
    const ni = num(r.netIncome);
    if (ni === null || ni <= 0) continue;
    const div = num(r.commonDividendsPaid);
    const rep = num(r.commonStockRepurchased);
    if (div === null && rep === null) continue;
    const iss = num(r.commonStockIssuance) ?? 0;
    const distributed = -(div ?? 0) - (rep ?? 0) - iss;
    ratios.push((distributed / ni) * 100);
  }
  if (ratios.length < 2) return null;
  const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return Math.min(100, Math.max(0, avg));
}

function pctFromFraction(v: number | null): number | null {
  return v === null ? null : v * 100;
}

/** Merge quarterly income + cash-flow + balance by matching fiscal-period date. */
function mergeQuarterly(
  income: FmpIncomeStatementRow[],
  cashflow: FmpCashFlowRow[],
  balance: FmpBalanceSheetRow[],
): QuarterlyFundamentalsRow[] {
  const cfByDate = new Map<string, FmpCashFlowRow>();
  for (const r of cashflow) cfByDate.set(String(r.date ?? ""), r);
  const balByDate = new Map<string, FmpBalanceSheetRow>();
  for (const r of balance) balByDate.set(String(r.date ?? ""), r);

  return income.map((i) => {
    const d = String(i.date ?? "");
    const cf = matchByDate(cfByDate, d);
    const bal = matchByDate(balByDate, d);
    return {
      date: d,
      revenue: num(i.revenue),
      operatingIncome: num(i.operatingIncome),
      depreciationAndAmortization: num(i.depreciationAndAmortization) ?? (cf ? num(cf.depreciationAndAmortization) : null),
      netIncome: num(i.netIncome),
      operatingCashFlow: cf ? num(cf.operatingCashFlow) : null,
      capitalExpenditure: cf ? num(cf.capitalExpenditure) : null,
      totalStockholdersEquity: bal ? num(bal.totalStockholdersEquity) : null,
    };
  });
}

function matchByDate<T>(byDate: Map<string, T>, iso: string): T | null {
  const exact = byDate.get(iso);
  if (exact !== undefined) return exact;
  // Tolerate small fiscal-date drift across statements (±5 days).
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return null;
  let best: T | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const [k, v] of byDate) {
    const t = Date.parse(k);
    if (!Number.isFinite(t)) continue;
    const delta = Math.abs(t - target) / SPREAD_DAYS;
    if (delta < bestDelta) {
      bestDelta = delta;
      best = v;
    }
  }
  return bestDelta <= 5 ? best : null;
}

// Re-export sourcedOf for the page layer's provenance stamping.
export { sourcedOf, rowsOf, valueOf };
