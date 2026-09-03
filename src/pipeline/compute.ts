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
  normalizeReportedCurrency,
  routeCompany,
  degradationPlan,
  type CompanyRouteResult,
  type DegradationPlan,
  type RunwayResult,
  type RoutingIncomeRow,
  type RoutingCashflowRow,
} from "@/pipeline/stageB/sectorRouting";
// WS5: XBRL routing evidence (D-16) and financial-route metrics (D-17).
import { deriveRoutingEvidence } from "@/pipeline/stageB/routingEvidence";
import {
  computeFinancialMetrics,
  computeNareitFfo,
  type FinancialMetricsResult,
} from "@/pipeline/stageB/financialMetrics";
import {
  computeGrowth,
  type GrowthResult,
  type GrowthIncomeRow,
  type GrowthCashFlowRow,
} from "@/pipeline/stageB/growth";
import {
  computeWacc,
  computeRoic,
  computeRote,
  computeDupont,
  computeRoicVsWaccSpread,
  type WaccResult,
  type RoicResult,
  type RoteResult,
  type DupontResult,
  type RoicVsWaccSpread,
  type ReturnsIncomeRow,
  type ReturnsBalanceRow,
  PRIOR_YEAR_COST_OF_DEBT_MAX_YEARS_BACK,
  type PriorYearCostOfDebt,
  // WS6 (D-19)
  waccByFiscalYear,
  waccDisclosure,
  type WaccDisclosure,
  type WaccHistoryResult,
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
import {
  normalizeQuarterRows,
  quarterWindowViolation,
  type FiscalDatedRow,
} from "@/pipeline/stageB/quarterWindows";
import {
  classifyInstrumentSupport,
  UnsupportedInstrumentError,
} from "@/pipeline/stageB/instrumentSupport";
// WS6 (D-19): THESIS_EV_INCLUDE_LEASES.
import { getConfig } from "@/config/env";
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
  /**
   * WS5 (D-17): route metrics for bank / insurer / mortgage-REIT routes — the
   * figures those routes lead with. Empty on every other route. Each metric is
   * computed from the filer's tags or withheld with its reason.
   */
  financialMetrics: FinancialMetricsResult;
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
  // WS6 (D-19): every WACC input named with its source and date, and the WACC
  // recomputed at each fiscal year end from that year's risk-free observation.
  waccInputs: WaccDisclosure;
  waccHistory: WaccHistoryResult;
  roic: RoicResult;
  rote: RoteResult;
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

const countryKeyOf = (value: unknown): string =>
  typeof value === "string" ? value.toLowerCase().replace(/[^a-z]/g, "") : "";

/**
 * FMP's profile reports an ISO-2 code ("TW"); its market-risk-premium rows are
 * keyed by full country NAME ("Taiwan"). Comparing them directly could never
 * match, so the domicile lookup silently fell through to the US premium for
 * every foreign issuer — the exact defect it was written to fix.
 *
 * Unlisted codes stay unresolved and keep the DISCLOSED US fallback, so an
 * unmapped domicile fails closed and loudly rather than matching wrongly.
 */
const COUNTRY_CODE_TO_NAME: Readonly<Record<string, string>> = {
  ar: "argentina", au: "australia", at: "austria", be: "belgium", br: "brazil",
  ca: "canada", cl: "chile", cn: "china", co: "colombia", cz: "czechrepublic",
  dk: "denmark", eg: "egypt", fi: "finland", fr: "france", de: "germany",
  gr: "greece", hk: "hongkong", hu: "hungary", in: "india", id: "indonesia",
  ie: "ireland", il: "israel", it: "italy", jp: "japan", kr: "southkorea",
  lu: "luxembourg", my: "malaysia", mx: "mexico", nl: "netherlands",
  nz: "newzealand", no: "norway", pe: "peru", ph: "philippines", pl: "poland",
  pt: "portugal", qa: "qatar", ro: "romania", ru: "russia", sa: "saudiarabia",
  sg: "singapore", za: "southafrica", es: "spain", se: "sweden",
  ch: "switzerland", tw: "taiwan", th: "thailand", tr: "turkey",
  ae: "unitedarabemirates", gb: "unitedkingdom", uk: "unitedkingdom",
  us: "unitedstates", vn: "vietnam",
};

/** Every spelling one domicile may appear under, for set-intersection matching. */
function countryAliases(value: unknown): Set<string> {
  const key = countryKeyOf(value);
  if (key.length === 0) return new Set();
  const out = new Set([key]);
  const mapped = COUNTRY_CODE_TO_NAME[key];
  if (mapped !== undefined) out.add(mapped);
  for (const [code, name] of Object.entries(COUNTRY_CODE_TO_NAME)) {
    if (name === key) out.add(code);
  }
  return out;
}

/**
 * Select the total ERP for the ISSUER'S domicile, never the US premium by
 * default. CAPM's market premium is a property of the market the equity is
 * exposed to; substituting the US premium for a foreign issuer understates its
 * cost of equity by the whole country risk premium — which is the entire point
 * of Damodaran's country-risk adjustment, and which the vendor already supplies
 * per country in the same payload.
 *
 * Returns the domicile row when it resolves unambiguously. Otherwise falls back
 * to the US row and says so, so the substitution is disclosed rather than
 * silent. Conflicting rows for one country fail closed, as the US selector
 * already did.
 */
export function selectEquityRiskPremium(
  rows: ReadonlyArray<FmpMarketRiskPremiumRow>,
  country: string | null,
): {
  pct: number | null;
  basis: "domicile" | "us-fallback";
  country: string | null;
  /** Why the domicile row was not used — absent, or several conflicting rows. */
  reason: "absent" | "conflicting" | null;
} {
  const aliases = countryAliases(country);
  const isUs = [...aliases].some((a) => US_COUNTRY_KEYS.has(a) || a === "unitedstates");
  let matchCount = 0;
  if (aliases.size > 0 && !isUs) {
    const matches = [
      ...new Set(
        rows.flatMap((row) => {
          const value = num(row.totalEquityRiskPremium);
          const rowAliases = countryAliases(row.country);
          const hit = [...rowAliases].some((a) => aliases.has(a));
          return hit && value !== null ? [value] : [];
        }),
      ),
    ];
    matchCount = matches.length;
    if (matches.length === 1) {
      return {
        pct: matches[0],
        basis: "domicile",
        country: typeof country === "string" ? country : null,
        reason: null,
      };
    }
  }
  return {
    pct: selectUsEquityRiskPremium(rows),
    // Keyed on isUs, not on alias resolution: an unknown or blank domicile is
    // NOT a domicile match, and labelling it one made its disclosure unreachable.
    basis: isUs ? "domicile" : "us-fallback",
    country: typeof country === "string" ? country : null,
    // More than one DISTINCT premium for the domicile is a vendor conflict, not
    // an absence, and must not be disclosed as "no vendor row".
    reason: isUs ? null : matchCount > 1 ? "conflicting" : "absent",
  };
}

// ---------------------------------------------------------------------------
// Adapters — map FMP rows to each module's input row shape (structural, but we
// build explicit objects so a field rename upstream fails the typecheck here).
// ---------------------------------------------------------------------------

function toGrowthIncome(r: FmpIncomeStatementRow): GrowthIncomeRow {
  return {
    date: String(r.date ?? ""),
    // Restatement recency: without these, a duplicated fiscal period is
    // ambiguous and gets rejected wholesale instead of resolved.
    acceptedDate: str(r.acceptedDate),
    filingDate: str(r.filingDate),
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
    acceptedDate: str(r.acceptedDate),
    filingDate: str(r.filingDate),
    freeCashFlow: num(r.freeCashFlow),
    operatingCashFlow: num(r.operatingCashFlow),
    capitalExpenditure: num(r.capitalExpenditure),
  };
}

function toReturnsIncome(
  r: FmpIncomeStatementRow,
  /** Preferred dividends by fiscal date, joined from the cash-flow statement. */
  preferredByDate?: Map<string, FmpCashFlowRow>,
): ReturnsIncomeRow {
  // Joined with the SAME +/-5-day tolerance every other statement pairing uses.
  // An exact string match returned null whenever the cash-flow fiscal date
  // drifted from the income one, and ROTE fails closed on a null preferred
  // dividend when preferred is outstanding — so a one-day drift suppressed the
  // metric entirely for every preferred issuer.
  const prefRow = preferredByDate ? matchByDate(preferredByDate, String(r.date ?? "")) : null;
  return {
    date: String(r.date ?? ""),
    preferredDividendsPaid: prefRow ? num(prefRow.preferredDividendsPaid) : null,
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
    // Invested capital nets the same cash the house net-debt resolver does.
    shortTermInvestments: num(r.shortTermInvestments),
    // Tangible common equity components (ROTE denominator).
    goodwill: num(r.goodwill),
    intangibleAssets: num(r.intangibleAssets),
    preferredStock: num(r.preferredStock),
    cashAndShortTermInvestments: num(r.cashAndShortTermInvestments),
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
    volume: num(r.volume),
  };
}

// ---------------------------------------------------------------------------
// TTM synthesis: sum the latest 4 quarters for flow fields, take latest for
// stock/per-share fields. Returns null when fewer than 4 quarters available.
// ---------------------------------------------------------------------------

export interface TtmIncome {
  date: string;
  reportedCurrency: string | null;
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

interface NormalizedQuarterSet<T> {
  rows: T[];
  rejected: Array<{ period: string; reason: string }>;
}

function quarterRowsGap(
  family: "income" | "cashFlow" | "balance",
  rejected: ReadonlyArray<{ period: string; reason: string }>,
): ManifestEntry | null {
  if (rejected.length === 0) return null;
  const shown = rejected.slice(0, 8).map(({ period, reason }) => `${period}: ${reason}`);
  const omitted = rejected.length - shown.length;
  return {
    field: `compute.quarterRows.${family}`,
    reason: `${rejected.length} rejected quarterly period${rejected.length === 1 ? "" : "s"}: ${shown.join("; ")}${omitted > 0 ? `; +${omitted} more` : ""}`,
    severity: "info",
    attemptedSources: [
      family === "income"
        ? "fmp:/stable/income-statement?period=quarter"
        : family === "cashFlow"
          ? "fmp:/stable/cash-flow-statement?period=quarter"
          : "fmp:/stable/balance-sheet-statement?period=quarter",
    ],
  };
}

function normalizeStatementQuarters<T extends FiscalDatedRow>(
  rows: readonly T[],
  family: "income" | "cashFlow" | "balance",
  gaps?: ManifestEntry[],
): NormalizedQuarterSet<T> {
  const normalized = normalizeQuarterRows(rows);
  const disclosure = quarterRowsGap(family, normalized.rejected);
  if (disclosure) gaps?.push(disclosure);
  return normalized;
}

function rejectedAffectsCurrentWindow<T extends FiscalDatedRow>(
  normalized: NormalizedQuarterSet<T>,
): { period: string; reason: string } | null {
  if (normalized.rejected.length === 0) return null;
  const selected = normalized.rows.slice(0, 4);
  const oldestSelected = typeof selected[3]?.date === "string" ? selected[3].date : null;
  if (oldestSelected === null) return normalized.rejected[0];

  return normalized.rejected.find(({ period }) => {
    const prefix = /^(\d{4}-\d{2}-\d{2})/.exec(period)?.[1] ?? null;
    const orderable =
      prefix !== null && normalizeQuarterRows([{ date: prefix }]).rows.length === 1
        ? prefix
        : null;
    return orderable === null || orderable >= oldestSelected;
  }) ?? null;
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
  const normalized = normalizeStatementQuarters(quarterly, "income", gaps);
  return ttmIncomeFromNormalized(normalized, gaps);
}

function ttmIncomeFromNormalized(
  normalized: NormalizedQuarterSet<FmpIncomeStatementRow>,
  gaps?: ManifestEntry[],
): TtmIncome | null {
  const rejected = rejectedAffectsCurrentWindow(normalized);
  if (rejected) {
    gaps?.push({
      field: "compute.ttmIncome",
      reason: `current TTM window is uncertain because fiscal period ${rejected.period} was rejected (${rejected.reason}) — TTM basis suppressed; latest annual statement used instead`,
      severity: "info",
      attemptedSources: ["fmp:/stable/income-statement?period=quarter"],
    });
    return null;
  }
  if (normalized.rows.length < 4) return null;
  const q = normalized.rows.slice(0, 4);

  // Contiguity gate (audit M1): a non-TTM window must never be labeled TTM.
  // The 5th row (when present) lets the gate check the OLDEST quarter's own
  // duration, so a transition/stub period cannot enter the TTM sum unchecked.
  const violation = quarterWindowViolation(q, normalized.rows[4] ?? null);
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

  const firstReportedCurrency = normalizeReportedCurrency(q[0].reportedCurrency);
  const reportedCurrency =
    firstReportedCurrency !== null &&
    q.every((row) => normalizeReportedCurrency(row.reportedCurrency) === firstReportedCurrency)
      ? firstReportedCurrency
      : null;

  return {
    date: String(q[0].date ?? ""),
    reportedCurrency,
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
  const normalized = normalizeStatementQuarters(quarterly, "cashFlow", gaps);
  return ttmCashFlowFromNormalized(normalized, gaps);
}

function ttmCashFlowFromNormalized(
  normalized: NormalizedQuarterSet<FmpCashFlowRow>,
  gaps?: ManifestEntry[],
): TtmCashFlow | null {
  const rejected = rejectedAffectsCurrentWindow(normalized);
  if (rejected) {
    gaps?.push({
      field: "compute.ttmCashFlow",
      reason: `current TTM window is uncertain because fiscal period ${rejected.period} was rejected (${rejected.reason}) — TTM basis suppressed; latest annual statement used instead`,
      severity: "info",
      attemptedSources: ["fmp:/stable/cash-flow-statement?period=quarter"],
    });
    return null;
  }
  if (normalized.rows.length < 4) return null;
  const q = normalized.rows.slice(0, 4);
  // Contiguity gate (audit M1) — identical to ttmIncome.
  const violation = quarterWindowViolation(q, normalized.rows[4] ?? null);
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
// WS6: the series the rate came from travels with it, so the WACC disclosure
// can name it instead of printing an unattributed percentage.
function riskFreePct(
  bundle: DataBundle,
): { pct: number | null; asOf: string | null; seriesId: string | null } {
  const treasuryRows = rowsOf(bundle.treasury);
  const t = treasuryRows[0];
  const fromTreasury = t ? num(t.year10) : null;
  if (fromTreasury !== null) {
    return { pct: fromTreasury, asOf: isoDay(t?.date), seriesId: "fmp:treasury-rates.year10" };
  }
  const dgs10 = bundle.macro.core["DGS10"];
  if (dgs10 && dgs10.ok) {
    const obs = dgs10.value.data;
    const last = obs[obs.length - 1];
    if (last && Number.isFinite(last.value)) {
      return { pct: last.value, asOf: last.date, seriesId: "fred:DGS10" };
    }
  }
  return { pct: null, asOf: null, seriesId: null };
}

// WS6: the full FRED DGS10 observation history the bundle fetched (five years
// back), so a WACC can be recomputed at each fiscal year end.
function riskFreeObservations(bundle: DataBundle): { date: string; value: number }[] {
  const dgs10 = bundle.macro.core["DGS10"];
  if (!dgs10 || !dgs10.ok) return [];
  return dgs10.value.data.filter((o) => Number.isFinite(o.value));
}

/**
 * Latest-two totalDebt observations for WACC.
 *
 * A negative balance is invalid for FMP's totalDebt field. Preserve that fact
 * separately so opposite-signed observations can never average to zero and
 * impersonate a genuinely debt-free capital structure.
 */
/**
 * The most recent fiscal year (excluding the latest, at index 0) whose income
 * statement discloses a POSITIVE interest expense and whose balance sheet
 * carries positive total debt — the issuer's own last-disclosed effective cost
 * of debt. Consumed by the WACC only when the current interest expense is
 * missing or a provider-placeholder zero. Annual rows are newest-first.
 */
export function priorYearCostOfDebt(
  incomeAnnual: readonly FmpIncomeStatementRow[],
  balanceAnnual: readonly FmpBalanceSheetRow[],
): PriorYearCostOfDebt | null {
  for (let index = 1; index < incomeAnnual.length && index <= PRIOR_YEAR_COST_OF_DEBT_MAX_YEARS_BACK; index += 1) {
    const income = incomeAnnual[index];
    const fiscalYearEnd = isoDay(income?.date);
    const interestExpense = num(income?.interestExpense);
    if (fiscalYearEnd === null || interestExpense === null || interestExpense <= 0) continue;
    const balanceIndex = balanceAnnual.findIndex((row) => isoDay(row.date) === fiscalYearEnd);
    if (balanceIndex < 0) continue;
    const debtThisYear = num(balanceAnnual[balanceIndex]?.totalDebt);
    const debtPriorYear = num(balanceAnnual[balanceIndex + 1]?.totalDebt);
    if (debtThisYear === null || debtThisYear <= 0) continue;
    if (debtPriorYear !== null && debtPriorYear < 0) continue;
    const totalDebtAvg =
      debtPriorYear !== null && debtPriorYear > 0 ? (debtThisYear + debtPriorYear) / 2 : debtThisYear;
    return {
      pct: (interestExpense / totalDebtAvg) * 100,
      fiscalYearEnd,
      yearsBack: index,
      interestExpense,
      totalDebtAvg,
      ebit: num(income?.ebit) ?? num(income?.operatingIncome),
    };
  }
  return null;
}

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
  const support = classifyInstrumentSupport(profile);
  if (!support.supported) throw new UnsupportedInstrumentError(support);
  const quote = firstRow(bundle.quote);

  const incomeAnnual = rowsOf(bundle.statements.incomeAnnual);
  const balanceAnnual = rowsOf(bundle.statements.balanceAnnual);
  const cashflowAnnual = rowsOf(bundle.statements.cashflowAnnual);
  const ttmGaps: ManifestEntry[] = [];
  const incomeQuarterSet = normalizeStatementQuarters(
    rowsOf(bundle.statements.incomeQuarterly),
    "income",
    ttmGaps,
  );
  const balanceQuarterSet = normalizeStatementQuarters(
    rowsOf(bundle.statements.balanceQuarterly),
    "balance",
    ttmGaps,
  );
  const cashflowQuarterSet = normalizeStatementQuarters(
    rowsOf(bundle.statements.cashflowQuarterly),
    "cashFlow",
    ttmGaps,
  );
  const incomeQuarterly = incomeQuarterSet.rows;
  const balanceQuarterly = balanceQuarterSet.rows;
  const cashflowQuarterly = cashflowQuarterSet.rows;

  const todayIso = bundle.builtAt.slice(0, 10);

  // WS5: routing evidence from EDGAR companyfacts, read-only (D-16).
  const routingEvidence = deriveRoutingEvidence(bundle.edgar?.companyFacts ?? null);

  // --- Route FIRST -----------------------------------------------------------
  const inc0 = incomeAnnual[0];
  const cf0 = cashflowAnnual[0];
  const routingIncomeAnnual: RoutingIncomeRow | null = inc0
    ? {
        date: isoDay(inc0.date),
        revenue: num(inc0.revenue),
        netIncome: num(inc0.netIncome),
        reportedCurrency: normalizeReportedCurrency(inc0.reportedCurrency),
      }
    : null;
  const ttmInc = ttmIncomeFromNormalized(incomeQuarterSet, ttmGaps);
  const routingIncomeTtm: RoutingIncomeRow | null = ttmInc
    ? {
        date: ttmInc.date,
        revenue: ttmInc.revenue,
        netIncome: ttmInc.netIncome,
        reportedCurrency: ttmInc.reportedCurrency,
      }
    : null;
  const routingCashflowAnnual: RoutingCashflowRow | null = cf0
    ? { date: isoDay(cf0.date), operatingCashFlow: num(cf0.operatingCashFlow) }
    : null;
  const ttmCf = ttmCashFlowFromNormalized(cashflowQuarterSet, ttmGaps);
  const routingCashflowTtm: RoutingCashflowRow | null = ttmCf
    ? { date: ttmCf.date, operatingCashFlow: ttmCf.operatingCashFlow }
    : null;

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
      // SEC SIC from the EDGAR submissions payload. FMP's profile carries no
      // SIC, so without this the routing evidence and Altman's SIC-decisive
      // variant branch were both permanently blind.
      sic: str(bundle.edgar?.sic),
    },
    {
      incomeTtm: routingIncomeTtm,
      incomeAnnual: routingIncomeAnnual,
      cashflowTtm: routingCashflowTtm,
      cashflowAnnual: routingCashflowAnnual,
      availableQuarters: incomeQuarterly.length,
    },
    // WS5: XBRL routing evidence (D-16). Read-only from the bundle's EDGAR
    // companyfacts; an absent or failed payload routes on industry/SIC alone
    // and says so in the routing note and the manifest.
    { today: todayIso, evidence: routingEvidence },
  );

  const policy = metricPolicy(route);
  const isSuppressed = (key: string): boolean => policy.suppress.includes(key);
  const suppress = (key: string, reason: string): void => {
    suppressed.push({ key, reason });
  };

  // WS5: the REIT sub-map drives the withholding disclosures in the plan.
  const degradation = degradationPlan(
    route.base,
    route.overlays,
    incomeQuarterly.length,
    route.reitSubmap ?? null,
  );

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

  // --- SEC 8-K forensic events -------------------------------------------
  // Item 4.02 (non-reliance on previously issued financial statements) is a
  // restatement announcement — among the strongest accounting red flags a
  // filer can make — and Item 4.01 is an auditor change. The bundle FETCHED
  // and parsed both feeds and then nothing read them: grep found zero
  // consumers. Surface them as notes and gaps so they reach the report and the
  // Stage C payload, where the forensic section is read.
  const eventGaps: ManifestEntry[] = [];
  const eventNotes: string[] = [];
  const nonReliance = bundle.edgar?.nonReliance8Ks;
  if (nonReliance?.ok === true && nonReliance.value.data.length > 0) {
    const dates = nonReliance.value.data
      .map((f) => f.filingDate)
      .filter((d): d is string => typeof d === "string" && d.length > 0)
      .sort()
      .reverse();
    eventNotes.push(
      `SEC Form 8-K Item 4.02 filed (${dates.slice(0, 3).join(", ")}${dates.length > 3 ? ", …" : ""}): ` +
        "the company announced that previously issued financial statements should NO LONGER BE RELIED UPON. " +
        "Any figure below drawn from a superseded period may be restated.",
    );
    eventGaps.push({
      field: "forensics.nonReliance8K",
      reason: `${nonReliance.value.data.length} Form 8-K Item 4.02 non-reliance/restatement filing(s) on record (latest ${dates[0] ?? "unknown"}) — historical statements may be superseded`,
      severity: "warn",
    });
  }
  const auditorChange = bundle.edgar?.auditorChange8Ks;
  if (auditorChange?.ok === true && auditorChange.value.data.length > 0) {
    const dates = auditorChange.value.data
      .map((f) => f.filingDate)
      .filter((d): d is string => typeof d === "string" && d.length > 0)
      .sort()
      .reverse();
    eventNotes.push(
      `SEC Form 8-K Item 4.01 filed (${dates.slice(0, 3).join(", ")}${dates.length > 3 ? ", …" : ""}): ` +
        "the company changed its registered public accounting firm.",
    );
    eventGaps.push({
      field: "forensics.auditorChange8K",
      reason: `${auditorChange.value.data.length} Form 8-K Item 4.01 auditor-change filing(s) on record (latest ${dates[0] ?? "unknown"})`,
      severity: "info",
    });
  }

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
      sicCode: str(bundle.edgar?.sic),
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
    // WS6 wiring.
    capital,
    wacc: returns.wacc,
    waccInputs: returns.waccInputs,
    waccHistory: returns.waccHistory,
    roic: returns.roic,
    dupont: returns.dupont,
    // WS5: P/TBV against ROTE on the financial routes.
    rote: returns.rote,
    profile,
    quote,
  });

  // --- Route metrics for financial companies (WS5, D-17) --------------------
  // The bank, insurer and mortgage-REIT routes have led with NIM, the
  // efficiency ratio, the combined ratio, book value per share, the spread and
  // leverage since the route table was written, and nothing computed any of
  // them. Each is now computed from the filer's own XBRL tags where its
  // definition allows, and withheld with a stated reason where it does not.
  const financialMetrics = computeFinancialMetrics(route.base, {
    companyFacts: bundle.edgar?.companyFacts ?? null,
    balance: balanceAnnual.map((r) => ({
      date: String(r.date ?? ""),
      totalAssets: num(r.totalAssets),
      totalStockholdersEquity: num(r.totalStockholdersEquity),
      totalEquity: num(r.totalEquity),
      goodwill: num(r.goodwill),
      intangibleAssets: num(r.intangibleAssets),
      preferredStock: num(r.preferredStock),
    })),
    income: incomeAnnual.map((r) => ({
      date: String(r.date ?? ""),
      revenue: num(r.revenue),
      netIncome: num(r.netIncome),
      interestIncome: num(r.interestIncome),
      interestExpense: num(r.interestExpense),
      netInterestIncome: num(r.netInterestIncome),
    })),
    shares: num(incomeAnnual[0]?.weightedAverageShsOutDil),
    sharesBasis: "statements:income.weightedAverageShsOutDil",
  });

  // --- Runway (overlay-gated) ------------------------------------------------
  let runway: RunwayResult | null = null;
  const needsRunway =
    route.overlays.includes("pre-revenue") ||
    route.overlays.includes("unprofitable") ||
    route.overlays.includes("recent-ipo");
  if (needsRunway) {
    const b0 = newestBalanceRow(balanceQuarterly[0], balanceAnnual[0]);
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
    rote: returns.rote,
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
  const balPointProj = pickBalanceAnchor(balQProj, balanceAnnual[0] ?? null).row;
  const posSharesProj = (v: number | null): number | null => (v !== null && v > 0 ? v : null);
  const sharesQProj = posSharesProj(num(incomeQuarterly[0]?.weightedAverageShsOutDil));
  const sharesAProj = posSharesProj(num(inc0Proj?.weightedAverageShsOutDil));
  const dilutedSharesProj =
    projRowDate(incomeQuarterly[0]) >= projRowDate(inc0Proj) ? (sharesQProj ?? sharesAProj) : (sharesAProj ?? sharesQProj);
  const netDebtProj = netDebtFromBalance(balPointProj).value;
  // Collapse restated/duplicate fiscal years BEFORE the dispersion sees them.
  // Removing the irregular-spacing veto left scenarioDispersion with no
  // protection against a duplicated period, which contributes a zero-length
  // interval and a repeated observation to the volatility estimate.
  const projNorm = normalizeQuarterRows(incomeAnnual);
  const projectionPeriodGaps: ManifestEntry[] = projNorm.rejected.map(({ period, reason }) => ({
    field: "projections.incomeStatement.period",
    reason: `annual period ${period} dropped from the projection history: ${reason}`,
    severity: "warn" as const,
  }));
  const projectionIncomeHistory = projNorm.rows.map(
    (r): ProjectionIncomeRow => ({
      date: String(r.date ?? ""),
      revenue: num(r.revenue),
      ebit: num(r.ebit) ?? num(r.operatingIncome),
      netIncome: num(r.netIncome),
      epsDiluted: num(r.epsDiluted),
    }),
  );
  // Never default a currency. This used to be `?? "USD"`, and the value becomes
  // the printed UNIT on the fair-value per-share and on every projection point
  // (`${currency}/share`) — so an issuer whose profile carries no currency had
  // its figures labelled US dollars on no evidence at all. That is the same
  // false-denomination defect the report formatter was fixed for; a missing
  // currency must read as unknown, not as USD.
  // Falls back to the STATEMENTS' reporting currency, which is where a
  // per-share intrinsic value is actually denominated. Leaving it null produced
  // the unit "per share (currency unknown)", which is outside the provenance
  // vocabulary, so canonicalizeTracedUnit rejected it and the fair value,
  // projections and scenario targets were silently DROPPED from the registry —
  // a worse outcome than the USD default this replaced.
  const projectionCurrency =
    str(profile?.currency) ?? str(ttmInc?.reportedCurrency ?? incomeAnnual[0]?.reportedCurrency);
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
    eventGaps,
    projectionPeriodGaps,
    technicals.gaps,
    valuation.gaps,
    // WS5: every withheld route metric reaches the missing-data manifest with
    // the reason it was withheld.
    financialMetrics.gaps,
    runway?.gaps ?? null,
  );

  // The 8-K forensic events belong with the forensic notes the report renders,
  // not in runStageB's own `notes`, which has no consumer.
  forensics.notes.push(...eventNotes);
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
    financialMetrics,
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
  const erpSelection = selectEquityRiskPremium(
    rowsOf(bundle.marketRiskPremium),
    str(profile?.country),
  );
  const usErpPct = erpSelection.pct;
  if (erpSelection.basis === "us-fallback") {
    notes.push(
      `Equity risk premium: no vendor row for ${erpSelection.country ?? "the issuer's domicile"} — the US ` +
        "premium is used, which OMITS the country risk premium and understates cost of equity for a " +
        "non-US issuer (no country-risk adjustment applied).",
    );
    gaps.push({
      field: "returns.wacc.erp.country",
      reason: `equity risk premium for ${erpSelection.country ?? "issuer domicile"} unavailable — US premium substituted without a country-risk adjustment`,
      severity: "warn",
    });
  }
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
    // Never inferred on ANY financial route — bank, insurer and mortgage REIT
    // alike — and on keyed plans as well as keyless ones.
    //
    // The reason is what the route consumes, not how it is funded: all three
    // value on the cost of equity (the excess-return and price-to-book models
    // in valuation.ts), and none reads the WACC cost of debt. Nor would
    // interest expense over short-plus-long-term debt BE their funding cost:
    // deposits, policy reserves and repo are the liabilities that fund them,
    // and repo is tagged `SecuritiesSoldUnderAgreementsToRepurchase`, which is
    // outside the debt chains — so the inference is wrong for a mortgage REIT
    // for the same reason it is wrong for a bank (JPM's keyless run produced
    // 183.28%). Financials keep the existing "cost of debt unavailable, cost of
    // equity carried" outcome.
    priorYearCostOfDebt:
      !isFinancial && (interestExpenseForWacc === null || interestExpenseForWacc <= 0)
        ? priorYearCostOfDebt(incomeAnnual, balanceAnnual)
        : null,
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
    // WS6 (D-19): name which of the three tax-rate sources actually supplied it.
    effectiveTaxRateBasis:
      num(ratiosTtm?.effectiveTaxRateTTM) !== null
        ? "FMP ratios-ttm effectiveTaxRateTTM (observed effective rate)"
        : num(ratiosTtm?.effectiveTaxRate) !== null
          ? "FMP ratios effectiveTaxRate (observed effective rate)"
          : effectiveTaxRateFromTtm(ttmInc) !== null
            ? "TTM incomeTaxExpense / incomeBeforeTax from the statements (observed effective rate)"
            : null,
    riskFreeSeriesId: rf.seriesId,
    erpAsOf: sourcedOf(bundle.marketRiskPremium)?.asOf ?? null,
    ebitTtm: ebitForWacc,
    analysisDate: isoDay(bundle.builtAt) ?? undefined,
    isFinancial,
    totalAssets: bal0 ? num(bal0.totalAssets) : null,
    // ADR guard: market cap is quoted in the trading currency while totalDebt
    // is a reporting-currency balance, so the E/D weights must not mix them.
    reportedCurrency: str(ttmInc?.reportedCurrency ?? incomeAnnual[0]?.reportedCurrency),
    quoteCurrency: str(profile?.currency),
    asOf: {
      riskFreeRate: rf.asOf ?? undefined,
      statements: isoDay(incomeAnnual[0]?.date) ?? undefined,
      marketCap: sourcedOf(bundle.quote)?.asOf,
    },
  });

  // Preferred dividends live on the CASH-FLOW statement; ROTE nets them out of
  // its numerator because its denominator already excludes preferred.
  const preferredByDate = new Map<string, FmpCashFlowRow>(
    rowsOf(bundle.statements.cashflowAnnual).map((r: FmpCashFlowRow) => [String(r.date ?? ""), r]),
  );
  const returnsIncome = incomeAnnual.map((r) => toReturnsIncome(r, preferredByDate));
  const returnsBalance = balanceAnnual.map(toReturnsBalance);

  const roic = computeRoic(returnsIncome, returnsBalance);
  // Return on tangible common equity — the capital-return measure for
  // deposit-funded balance sheets, where invested capital is undefined.
  const rote = computeRote(returnsIncome, returnsBalance);
  const dupont = computeDupont(returnsIncome, returnsBalance);
  const roicVsWacc = computeRoicVsWaccSpread(roic.latestRoicPct, wacc.waccPct);

  // WS6 (D-19): recompute the WACC at each ROIC fiscal year end from that
  // year's own FRED observation. The bundle fetches DGS10 five years back, so
  // years outside that window (or without an observation near the year end)
  // are reported as missing and the current WACC is applied to them instead.
  const waccHistory = waccByFiscalYear(
    wacc,
    roic.series.map((y) => y.date),
    riskFreeObservations(bundle),
    { seriesId: "fred:DGS10" },
  );
  const waccInputs = waccDisclosure(wacc);
  notes.push(waccInputs.summary);
  notes.push(...waccHistory.notes);
  // The per-year-WACC shortfall is disclosed by the DCF assumption block (its
  // only consumer is the terminal excess-return rule), so it is NOT pushed here
  // as a returns-level gap; `waccHistory.gaps` stays on the result for callers.
  gaps.push(...wacc.gaps, ...roic.gaps, ...rote.gaps, ...dupont.gaps);
  return { wacc, waccInputs, waccHistory, roic, rote, dupont, roicVsWacc, notes, gaps };
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
  /** WS6 (D-19): FCF/SBC treatment for the DCF assumption block. */
  capital: CapitalResult;
  wacc: WaccResult;
  // WS6 (D-19): the named WACC inputs and the per-fiscal-year WACC series.
  waccInputs: WaccDisclosure;
  waccHistory: WaccHistoryResult;
  /** Annual ROIC series — evidence for the DCF terminal excess-return rule. */
  roic: RoicResult;
  /** Latest fiscal-year DuPont decomposition — the excess-return ROE fallback. */
  dupont: DupontResult;
  /** WS5: return on tangible common equity — the return P/TBV is read against. */
  rote: RoteResult;
  profile: FmpRawRow | null;
  quote: FmpRawRow | null;
}

function cagrPctFor(growth: GrowthResult, window: number): number | null {
  const p = growth.revenueCagrs.find((c) => c.windowYears === window);
  return p ? p.cagrPct : null;
}

function computeValuation(bundle: DataBundle, ctx: ValuationCtx): ValuationResult {
  const { route, incomeAnnual, balanceAnnual, balanceQuarterly, incomeQuarterly, ttmInc, ttmCf, growth, wacc, roic, profile, quote } = ctx;
  // WS6 (D-18/D-19): the growth-anchor regression method and the WACC
  // disclosure travel into the DCF assumption block with the rest.
  const waccByYear = new Map(ctx.waccHistory.points.map((point) => [point.date, point]));

  const bal0 = balanceAnnual[0];
  const inc0 = incomeAnnual[0];
  const rowDate = (r: { date?: unknown } | null | undefined): string =>
    typeof r?.date === "string" ? r.date : "";
  // Point-in-time balance anchor (2026-07-09 audit M4): whole-row preference
  // for the NEWER of the latest quarterly vs latest annual balance row — a
  // lagging quarterly feed must not beat a fresher annual row, and fields are
  // never mixed across periods. Same pattern runway already uses.
  const balQ = balanceQuarterly[0] ?? null;
  const balanceAnchor = pickBalanceAnchor(balQ, bal0);
  const balPoint = balanceAnchor.row;
  const balPointBasis = balanceAnchor.basis;
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
  // WS6 (D-19): THESIS_EV_INCLUDE_LEASES, read once for both bridges.
  const evIncludeLeases = getConfig().evIncludeLeases;

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

  // Same deduped rows the projection history uses: the DCF's near-term growth
  // path is fitted to this series, so a restated fiscal year appearing twice
  // biases the base case exactly as it biased the dispersion.
  const dcfIncomeHistory: DcfIncomeRow[] = normalizeQuarterRows(incomeAnnual).rows.map((r) => ({
    date: String(r.date ?? ""),
    revenue: num(r.revenue),
    operatingIncome: num(r.operatingIncome),
    incomeBeforeTax: num(r.incomeBeforeTax),
    incomeTaxExpense: num(r.incomeTaxExpense),
  }));

  const dcfBalance: DcfBalanceRow | null = balPoint && balPointBasis
    ? {
        date: String(balPoint.date ?? ""),
        basis: balPointBasis,
        totalDebt: num(balPoint.totalDebt),
        totalStockholdersEquity: num(balPoint.totalStockholdersEquity),
        cashAndShortTermInvestments: num(balPoint.cashAndShortTermInvestments),
      }
    : null;

  const rf = riskFreePct(bundle);
  const dcfInputs: DcfAssumptionInputs | null =
    route.base === "general" && !route.overlays.includes("pre-revenue")
      ? {
          revenueCagr3yPct: cagrPctFor(growth, 3),
          revenueCagr5yPct: cagrPctFor(growth, 5),
          // WS6 (D-18): the log-linear regression method of the growth anchor.
          revenueLogLinear: growth.revenueLogLinear,
          analystEstimates,
          waccPct: wacc.waccPct ?? 0,
          // WS6 (D-19): every WACC input named in the assumption block.
          waccBasis: ctx.waccInputs.summary,
          // WS6 (D-19): the reported FCF before and after the SBC deduction.
          fcfSbc: {
            beforeSbc: ctx.capital.fcf.latestFcfBeforeSbc,
            afterSbc: ctx.capital.fcf.latestFcf,
            sbc: ctx.capital.fcf.latestSbc,
            asOf: ctx.capital.asOf,
            basis: ctx.capital.fcf.basis,
          },
          riskFreePct: rf.pct ?? 0,
          incomeTtm: dcfIncomeTtm,
          incomeHistory: dcfIncomeHistory,
          balance: dcfBalance,
          marketCap,
          // The terminal excess-return rule reads the same annual ROIC series
          // the returns section reports.
          // WS6 (D-19): each ROIC year carries the WACC recomputed from its own
          // fiscal year end's risk-free observation, when one existed.
          roicHistory: roic.series.map((y) => {
            const point = waccByYear.get(y.date);
            return {
              date: y.date,
              roicPct: y.roicPct,
              waccPct: point?.waccPct ?? null,
              waccAsOf: point?.riskFreeAsOf ?? null,
            };
          }),
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
        // WS6 (D-19): lease liabilities for the EV bridge.
        capitalLeaseObligations: num(balPoint.capitalLeaseObligations),
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

  // WS5: FFO/AFFO per the NAREIT definition where the filer's tags allow (net
  // income + real-estate D&A − gains on property sales + impairments; AFFO less
  // recurring capex and straight-line rent), falling back to the netIncome +
  // D&A approximation and saying so. Read-only from EDGAR companyfacts.
  const da = ttmInc?.depreciationAndAmortization ?? null;
  const nareitFfo = computeNareitFfo({
    companyFacts: bundle.edgar?.companyFacts ?? null,
    periodEnd: isoDay(ctx.incomeAnnual[0]?.date),
    netIncome: ttmInc?.netIncome ?? num(ctx.incomeAnnual[0]?.netIncome),
    depreciationAndAmortization: da ?? num(ctx.incomeAnnual[0]?.depreciationAndAmortization),
    capitalExpenditure: ttmCf?.capitalExpenditure ?? num(ctx.cashflowAnnual[0]?.capitalExpenditure),
  });
  const ffoApprox = nareitFfo.ffo;
  const affoApprox = nareitFfo.affo;

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
    // WS6 (D-19): off by default; see docs/METHODOLOGY.md, "EV bridge".
    includeLeasesInEv: evIncludeLeases,
  };

  // --- Excess-return inputs (financials) ------------------------------------
  // Same FMP TTM-suffix drift as effectiveTaxRate above (returnOnEquity ->
  // returnOnEquityTTM on key-metrics-ttm). That row is FMP-only: on the keyless
  // path it never exists, and a null here SUPPRESSES the entire bank/insurer
  // valuation with a critical gap. The latest fiscal-year DuPont ROE (net income
  // / average equity) is computed from the same statements the rest of the
  // route runs on, so it is a defensible — and disclosed — second basis.
  const vendorRoePct = pctFromFraction(num(keyMetricsTtm?.returnOnEquityTTM ?? keyMetricsTtm?.returnOnEquity));
  const dupontRoePct = ctx.dupont.latest?.roePct ?? null;
  const currentRoeFromDupont = vendorRoePct === null && dupontRoePct !== null;

  const excessReturn: ExcessReturnInputs | null =
    route.base === "bank" || route.base === "insurer" || route.base === "reit-mortgage"
      ? {
          bookValue: balPoint ? num(balPoint.totalStockholdersEquity) : null,
          currentRoePct: vendorRoePct ?? dupontRoePct,
          // The printed assumption names the figure it actually faded from;
          // saying "TTM ROE" over a fiscal-year DuPont number made the report
          // contradict its own substitution note below.
          currentRoeBasis: currentRoeFromDupont ? "fiscal-year-dupont" : "ttm",
          currentRoeAsOf: currentRoeFromDupont ? (ctx.dupont.latest?.date ?? null) : null,
          // Audit M5: null CoE SUPPRESSES the model inside excessReturnModel
          // (critical gap) — never a silent 10% default.
          costOfEquityPct: wacc.costOfEquityPct,
          // Audit L4: (dividends + net buybacks) / net income, 3y average, from
          // the annual cash-flow statements; null suppresses the valuation.
          payoutRatioPct: payoutRatioPct3y(ctx.cashflowAnnual),
          dilutedShares,
          marketCap,
          asOf: isoDay(balPoint?.date),
          // WS5: P/TBV is read against ROTE, both on the tangible base the
          // returns block already computes — never against plain book equity.
          tangibleCommonEquity: ctx.rote?.latestTangibleCommonEquity ?? null,
          rotePct: ctx.rote?.latestRotePct ?? null,
          // The justified-P/TBV cross-check caps its growth rate at the same
          // ceiling the DCF terminal value uses: nothing grows faster than the
          // risk-free rate forever. Null leaves the house terminal-growth cap
          // as the only bound, which the basis string discloses.
          riskFreePct: rf.pct,
        }
      : null;

  // --- REIT inputs -----------------------------------------------------------
  const noiApprox = ttmInc && ttmInc.operatingIncome !== null && da !== null ? ttmInc.operatingIncome + da : null;
  const reitSubmapReason =
    route.reitSubmap === "undetermined"
      ? (route.gaps.find((g) => g.field === "route.reitSubmap")?.reason ?? null)
      : null;
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
          // WS5: print the basis FFO/AFFO were actually built on, and withhold
          // the whole block when the equity-vs-mortgage sub-map is unproven.
          ffoBasis: nareitFfo.ffoBasis,
          affoBasis: nareitFfo.affoBasis,
          ffoApproximate: nareitFfo.ffoApproximate,
          affoApproximate: nareitFfo.affoApproximate,
          submap: route.reitSubmap ?? null,
          submapReason: reitSubmapReason,
        }
      : null;

  const bundleInputs: ValuationBundleInputs = {
    currentPrice,
    waccPct: wacc.waccPct,
    netDebt: netDebtDerived,
    dilutedShares,
    minorityInterest: balPoint ? num(balPoint.minorityInterest) : null,
    preferred: balPoint ? num(balPoint.preferredStock) : null,
    // WS6 (D-19): the DCF equity bridge follows the same lease convention.
    leaseLiability: balPoint ? num(balPoint.capitalLeaseObligations) : null,
    includeLeasesInEv: evIncludeLeases,
    dcfInputs,
    multiples,
    excessReturn,
    reit,
  };

  void ratiosTtm; // reserved for future ratio cross-checks
  const result = valueCompany(route, bundleInputs);
  // WS5: the FFO computation's own notes and gaps (which tags resolved, which
  // stand-in was used) reach the report on the route that consumes them.
  if (route.base === "reit") {
    result.notes.push(...nareitFfo.notes);
    result.gaps.push(...nareitFfo.gaps);
  }
  // Basis disclosures for the point-in-time anchors chosen above (audit H2/M3).
  if (balanceAnchor.fallback !== null) {
    result.notes.push(balanceAnchor.fallback);
    result.gaps.push({ field: "valuation.balanceAnchor", reason: balanceAnchor.fallback, severity: "info" });
  }
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
  if (excessReturn !== null && currentRoeFromDupont) {
    result.notes.push(
      `current ROE from the latest fiscal-year DuPont decomposition (statements, FY ${ctx.dupont.latest?.date ?? "?"}: net income / average equity) — FMP key-metrics TTM unavailable`,
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
/**
 * Newest liquidity anchor for the runway model.
 *
 * Preferring the quarterly row unconditionally anchored runway on stale cash
 * whenever the latest annual row was newer — the ordinary case once the 10-K is
 * filed but the matching quarter is not yet published, or when quarterly
 * coverage lags. Runway must measure the most recent balance actually known, so
 * pick by date and fall back to whichever row exists.
 */
/** The balance fields the valuation anchors read: net debt, invested capital and the EV bridge. */
const BALANCE_ANCHOR_FIELDS = ["totalDebt", "totalStockholdersEquity", "cashAndShortTermInvestments"] as const;

export interface BalanceAnchor<TRow> {
  row: TRow | null;
  basis: "quarter" | "annual" | undefined;
  /** Why the newest row was passed over, when it was; null otherwise. */
  fallback: string | null;
}

/**
 * The valuation's point-in-time balance row: the NEWER of the latest quarterly
 * and annual whole rows (audit H2/M3/M4 — fields are never mixed across
 * periods), unless that newer row lacks one of the fields the anchors read
 * while the older row carries all three. Caterpillar's 10-Q balance sheet
 * tags no us-gaap debt line at all (its 10-K carries the debt through the
 * maturity schedule), so the newest row had equity and cash but no
 * totalDebt, invested capital was undefined and the DCF, net debt and EV
 * multiples were suppressed while a complete fiscal-year row sat one period
 * back. A stale-but-whole row is the disclosed compromise: the fallback is a
 * valuation note and an info gap. When no row is whole the newest stands.
 */
export function pickBalanceAnchor<TRow extends { date?: unknown } & Partial<Record<(typeof BALANCE_ANCHOR_FIELDS)[number], unknown>>>(
  quarterlyRow: TRow | null | undefined,
  annualRow: TRow | null | undefined,
): BalanceAnchor<TRow> {
  const quarterly = quarterlyRow ?? null;
  const annual = annualRow ?? null;
  const date = (r: TRow | null): string => (typeof r?.date === "string" ? r.date : "");
  const missing = (r: TRow): string[] =>
    BALANCE_ANCHOR_FIELDS.filter((field) => !(typeof r[field] === "number" && Number.isFinite(r[field] as number)));
  const newer: TRow | null = quarterly !== null && (annual === null || date(quarterly) >= date(annual)) ? quarterly : annual;
  const older: TRow | null = newer === quarterly ? annual : quarterly;
  if (newer === null) return { row: null, basis: undefined, fallback: null };
  const basisOf = (r: TRow): "quarter" | "annual" => (r === quarterly ? "quarter" : "annual");
  const lacking = missing(newer);
  if (older !== null && lacking.length > 0 && missing(older).length === 0) {
    const list = lacking.length === 1 ? lacking[0] : `${lacking.slice(0, -1).join(", ")} and ${lacking[lacking.length - 1]}`;
    return {
      row: older,
      basis: basisOf(older),
      fallback:
        `balance anchor: the newest balance row (${basisOf(newer)} ${date(newer)}) lacks ${list}, so net debt, invested capital and ` +
        `the EV bridge use the ${basisOf(older)} row as of ${date(older)}, the newest row carrying totalDebt, totalStockholdersEquity ` +
        `and cashAndShortTermInvestments`,
    };
  }
  return { row: newer, basis: basisOf(newer), fallback: null };
}

export function newestBalanceRow<TRow extends { date?: unknown }>(
  quarterly: TRow | undefined,
  annual: TRow | undefined,
): TRow | undefined {
  if (quarterly === undefined) return annual;
  if (annual === undefined) return quarterly;
  const q = typeof quarterly.date === "string" ? quarterly.date : "";
  const a = typeof annual.date === "string" ? annual.date : "";
  // Ties keep the quarterly row: same period end, but quarterly is the
  // finer-grained statement the rest of the runway model is built from.
  return a > q ? annual : quarterly;
}

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
      acceptedDate: i.acceptedDate,
      filingDate: i.filingDate,
      revenue: num(i.revenue),
      operatingIncome: num(i.operatingIncome),
      depreciationAndAmortization: num(i.depreciationAndAmortization) ?? (cf ? num(cf.depreciationAndAmortization) : null),
      // Kept separate: the REIT FFO history must use the same D&A basis as the
      // current ffoApprox, which reads the income statement only.
      incomeDepreciationAndAmortization: num(i.depreciationAndAmortization),
      netIncome: num(i.netIncome),
      operatingCashFlow: cf ? num(cf.operatingCashFlow) : null,
      capitalExpenditure: cf ? num(cf.capitalExpenditure) : null,
      totalStockholdersEquity: bal ? num(bal.totalStockholdersEquity) : null,
      // House-EV components, so own-history EV matches the current definition.
      totalDebt: bal ? num(bal.totalDebt) : null,
      cashAndShortTermInvestments: bal ? num(bal.cashAndShortTermInvestments) : null,
      preferredStock: bal ? num(bal.preferredStock) : null,
      minorityInterest: bal ? num(bal.minorityInterest) : null,
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
