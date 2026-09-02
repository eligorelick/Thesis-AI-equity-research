/**
 * SEC EDGAR XBRL `companyfacts` -> FMP-shaped statement rows.
 *
 * This is the core of the keyless data path: it turns the public
 * https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json payload into
 * annual and quarterly income-statement, balance-sheet and cash-flow rows that
 * satisfy `FmpIncomeStatementRow` / `FmpBalanceSheetRow` / `FmpCashFlowRow`, so
 * every Stage B analytic runs unchanged on public data.
 *
 * Two invariants drive the whole module:
 *
 *  1. NOTHING IS INVENTED. Every produced numeric field is `number | null`.
 *     A value appears only when the filed facts support it; a total is computed
 *     only from operands that are actually present. The pipeline reads FMP's
 *     literal `0` as "undisclosed", so a fabricated `0` here would silently
 *     become a real (wrong) datum downstream — hence `null`, never `0`.
 *
 *  2. THE CRITICAL DEDUP RULE (see xbrl.ts): facts are filtered to the audited
 *     core forms BEFORE deduping, then grouped by period and reduced to
 *     max(filed) with amendments winning a tie, applied once per (tag, unit)
 *     when the index is built. That rule governs the VALUE; row LABELS come
 *     from the earliest core-form filing of the same period, because `fy`/`fp`
 *     on a later comparative describe that later FILING (see UnitPoints.reporters).
 *
 * The module is pure: no network, no clock, no environment. The companyfacts
 * JSON comes from src/providers/edgar.ts.
 */

import type { FmpBalanceSheetRow, FmpCashFlowRow, FmpIncomeStatementRow } from "@/providers/fmp";
import type { ManifestEntry } from "@/types/core";
import {
  CORE_FACT_FORMS,
  conceptFactsSchema,
  dedupByPeriod,
  filterToCoreForms,
  looksLikeBankTagging,
  parseFactPoints,
  type CompanyFacts,
  type FactPoint,
} from "@/edgar/xbrl";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StatementBuildOptions {
  symbol: string;
  /** 10-digit or raw CIK; copied verbatim onto every row. */
  cik: string | null;
  annualPeriods: number;
  quarterlyPeriods: number;
}

export type Derivation = "ytd-difference" | "fy-minus-ytd" | "fy-minus-quarters";

export interface StatementRowsResult<TRow> {
  /** date DESC (newest fiscal period first). */
  rows: TRow[];
  notes: string[];
  gaps: ManifestEntry[];
}

/**
 * Where a share count came from. A per-class reporter (GOOGL, BRK.B, FOXA)
 * files its cover counts DIMENSIONED by class, and companyfacts excludes
 * dimensional facts, so `dei:EntityCommonStockSharesOutstanding` is absent
 * entirely for them; the non-dimensional balance-sheet total is present and is
 * the all-classes figure. Verified live against Alphabet (CIK 0001652044,
 * 2026-09-02): no dei concept, `us-gaap:CommonStockSharesOutstanding` 12.23B at
 * 2026-06-30. Without the fallback those issuers get no market cap, no
 * enterprise value and no market-cap history at all.
 */
export type SharesBasis = "dei cover page" | "balance sheet CommonStockSharesOutstanding";

export interface SharesOutstandingPoint {
  value: number;
  asOf: string;
  basis: SharesBasis;
}

export interface BuiltStatements {
  incomeAnnual: StatementRowsResult<FmpIncomeStatementRow>;
  incomeQuarterly: StatementRowsResult<FmpIncomeStatementRow>;
  balanceAnnual: StatementRowsResult<FmpBalanceSheetRow>;
  balanceQuarterly: StatementRowsResult<FmpBalanceSheetRow>;
  cashflowAnnual: StatementRowsResult<FmpCashFlowRow>;
  cashflowQuarterly: StatementRowsResult<FmpCashFlowRow>;
  /** Latest shares outstanding (cover page, else balance sheet) and public float. */
  shares: {
    outstanding: SharesOutstandingPoint | null;
    publicFloat: { value: number; asOf: string } | null;
  };
  reportedCurrency: string | null;
  /** True when at least one 20-F point was used (foreign private issuer). */
  filesTwentyF: boolean;
}

// ---------------------------------------------------------------------------
// Period tolerances & form partitions
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
/** 52/53-week fiscal calendars move period ends by a few days between filings. */
const TOLERANCE_DAYS = 3;
const ANNUAL_MIN_DAYS = 300;
const ANNUAL_MAX_DAYS = 400;
const QUARTER_MIN_DAYS = 70;
const QUARTER_MAX_DAYS = 110;

/** Derived from CORE_FACT_FORMS so a change there cannot silently desync. */
const ANNUAL_FORMS = new Set([...CORE_FACT_FORMS].filter((f) => f.startsWith("10-K") || f.startsWith("20-F")));
const QUARTERLY_FORMS = new Set([...CORE_FACT_FORMS].filter((f) => f.startsWith("10-Q")));

function dateMs(d: string): number {
  return Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
}

function withinDays(a: string, b: string, days: number): boolean {
  const am = dateMs(a);
  const bm = dateMs(b);
  if (Number.isNaN(am) || Number.isNaN(bm)) return false;
  return Math.abs(am - bm) <= days * DAY_MS;
}

/** Signed day count from `a` to `b`. */
function daysBetween(a: string, b: string): number {
  return (dateMs(b) - dateMs(a)) / DAY_MS;
}

/** Length of a fact's own period in days; null for instants (no `start`). */
function durationDays(p: FactPoint): number | null {
  return p.start !== undefined ? daysBetween(p.start, p.end) : null;
}

/**
 * Strip binary-float noise from a derived value and normalise `-0` to `0`.
 * EPS differences are the motivating case (7.5 - 5.9 = 1.5999999999999996).
 */
function tidy(x: number, decimals: number): number {
  if (!Number.isFinite(x)) return x;
  const r = Number(x.toFixed(decimals));
  return r === 0 ? 0 : r;
}

const MONEY_DECIMALS = 4;
const PER_SHARE_DECIMALS = 6;

// ---------------------------------------------------------------------------
// Concept chains
// ---------------------------------------------------------------------------

type UnitKind = "money" | "perShare" | "shares";

/**
 * A field's resolution recipe.
 *
 * `chain` is an addition to the four kinds named in the design brief: the bank
 * revenue chain and the SG&A chain interleave a `sum` step between `first`
 * steps, which the flat kinds cannot express. It resolves its steps in order
 * and the first step that produces a value wins.
 *
 * `sumAnyOf` is `sumAny` over SPECS rather than tags: the lease chain adds an
 * operating-lease subtotal (tagged total, else current + noncurrent) to a
 * finance-lease subtotal resolved the same way, which neither `sumAny` (flat
 * tags) nor `chain` (first-wins) can express. Its `label`s name the parts in
 * the absent-component note, exactly as tag names do for `sumAny`.
 */
export type ChainSpec =
  | { kind: "first"; tags: string[]; unit: UnitKind; sign?: -1 }
  | { kind: "sum"; tags: string[]; unit: "money" }
  | { kind: "sumAny"; tags: string[]; unit: "money" }
  | { kind: "sumAnyOf"; parts: { label: string; spec: ChainSpec }[]; unit: "money" }
  | { kind: "diff"; plus: string; minus: string; unit: "money" }
  | { kind: "chain"; steps: ChainSpec[]; unit: UnitKind };

const REVENUE_TAGS = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "Revenues",
  "SalesRevenueNet",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "RevenuesNetOfInterestExpense",
];

const REVENUE_SPEC: ChainSpec = { kind: "first", tags: REVENUE_TAGS, unit: "money" };

/**
 * Banks tag total net revenue under Revenues / RevenuesNetOfInterestExpense, or
 * not at all (then NII + noninterest income is the verified identity). RFC tags
 * stay as a trailing fallback but must never win at a bank: at BAC/WFC/C they
 * carry FEE-ONLY revenue and would drop the whole net-interest-income line.
 */
const BANK_REVENUE_SPEC: ChainSpec = {
  kind: "chain",
  unit: "money",
  steps: [
    { kind: "first", tags: ["Revenues", "RevenuesNetOfInterestExpense"], unit: "money" },
    { kind: "sum", tags: ["InterestIncomeExpenseNet", "NoninterestIncome"], unit: "money" },
    { kind: "first", tags: REVENUE_TAGS, unit: "money" },
  ],
};

const DEPRECIATION_SPEC: ChainSpec = {
  kind: "first",
  tags: ["DepreciationDepletionAndAmortization", "DepreciationAndAmortization", "DepreciationAmortizationAndAccretionNet"],
  unit: "money",
};

const INCOME_CHAINS: Record<string, ChainSpec> = {
  revenue: REVENUE_SPEC,
  costOfRevenue: { kind: "first", tags: ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold", "CostOfServices"], unit: "money" },
  grossProfit: { kind: "first", tags: ["GrossProfit"], unit: "money" },
  researchAndDevelopmentExpenses: {
    kind: "first",
    tags: ["ResearchAndDevelopmentExpense", "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost"],
    unit: "money",
  },
  sellingGeneralAndAdministrativeExpenses: {
    kind: "chain",
    unit: "money",
    steps: [
      { kind: "first", tags: ["SellingGeneralAndAdministrativeExpense"], unit: "money" },
      { kind: "sum", tags: ["SellingAndMarketingExpense", "GeneralAndAdministrativeExpense"], unit: "money" },
    ],
  },
  /** The two SG&A components FMP also publishes on their own; Stage B's forensics read both. */
  sellingAndMarketingExpenses: { kind: "first", tags: ["SellingAndMarketingExpense"], unit: "money" },
  generalAndAdministrativeExpenses: { kind: "first", tags: ["GeneralAndAdministrativeExpense"], unit: "money" },
  operatingExpenses: { kind: "first", tags: ["OperatingExpenses"], unit: "money" },
  operatingIncome: { kind: "first", tags: ["OperatingIncomeLoss"], unit: "money" },
  /**
   * `InterestExpenseOperating` is LAST: for a bank it is the whole interest
   * expense (JPM FY2025 97.9B, and it files none of the four tags above, so the
   * chain resolved nothing and the keyless WACC raised a critical gap the FMP
   * path never shows), but for a non-bank that tags both, the non-operating
   * figure is the borrowing cost the WACC wants.
   */
  interestExpense: {
    kind: "first",
    tags: [
      "InterestExpense",
      "InterestExpenseNonoperating",
      "InterestExpenseDebt",
      "InterestAndDebtExpense",
      "InterestExpenseOperating",
    ],
    unit: "money",
  },
  interestIncome: {
    kind: "first",
    tags: [
      "InvestmentIncomeInterest",
      "InvestmentIncomeInterestAndDividend",
      "InterestAndDividendIncomeOperating",
      // The bank twin of the tag above: JPM's total interest income, 193.3B.
      "InterestIncomeOperating",
    ],
    unit: "money",
  },
  netInterestIncome: { kind: "first", tags: ["InterestIncomeExpenseNet"], unit: "money" },
  incomeBeforeTax: {
    kind: "first",
    tags: [
      "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
      "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
    ],
    unit: "money",
  },
  incomeTaxExpense: { kind: "first", tags: ["IncomeTaxExpenseBenefit"], unit: "money" },
  totalOtherIncomeExpensesNet: { kind: "first", tags: ["NonoperatingIncomeExpense"], unit: "money" },
  netIncome: { kind: "first", tags: ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"], unit: "money" },
  netIncomeFromContinuingOperations: { kind: "first", tags: ["IncomeLossFromContinuingOperations"], unit: "money" },
  netIncomeFromDiscontinuedOperations: {
    kind: "first",
    tags: ["IncomeLossFromDiscontinuedOperationsNetOfTax"],
    unit: "money",
  },
  depreciationAndAmortization: DEPRECIATION_SPEC,
  eps: { kind: "first", tags: ["EarningsPerShareBasic"], unit: "perShare" },
  epsDiluted: { kind: "first", tags: ["EarningsPerShareDiluted"], unit: "perShare" },
  weightedAverageShsOut: { kind: "first", tags: ["WeightedAverageNumberOfSharesOutstandingBasic"], unit: "shares" },
  weightedAverageShsOutDil: { kind: "first", tags: ["WeightedAverageNumberOfDilutedSharesOutstanding"], unit: "shares" },
};

/**
 * Operating and finance lease liabilities, each as "tagged total, else the
 * current + noncurrent split". FMP's `capitalLeaseObligations` carries BOTH
 * (Apple FY2025: operating ~12.5B + finance ~1.2B = 13.72B) and its `totalDebt`
 * includes the pair, so both belong here or net debt, ROIC's invested capital
 * and the historical cost-of-debt denominator all drift off the house numbers.
 */
const LEASE_LIABILITY_SPEC: ChainSpec = {
  kind: "sumAnyOf",
  unit: "money",
  parts: [
    {
      label: "operatingLeaseLiability",
      spec: {
        kind: "chain",
        unit: "money",
        steps: [
          { kind: "first", tags: ["OperatingLeaseLiability"], unit: "money" },
          { kind: "sumAny", tags: ["OperatingLeaseLiabilityCurrent", "OperatingLeaseLiabilityNoncurrent"], unit: "money" },
        ],
      },
    },
    {
      label: "financeLeaseLiability",
      spec: {
        kind: "chain",
        unit: "money",
        steps: [
          { kind: "first", tags: ["FinanceLeaseLiability", "CapitalLeaseObligations"], unit: "money" },
          { kind: "sumAny", tags: ["FinanceLeaseLiabilityCurrent", "FinanceLeaseLiabilityNoncurrent"], unit: "money" },
        ],
      },
    },
  ],
};

const BALANCE_CHAINS: Record<string, ChainSpec> = {
  /**
   * Bank tagging (JPM): `CashAndCashEquivalentsAtCarryingValue` goes stale — its
   * last point is 2018 — while `CashAndDueFromBanks` carries the operating cash.
   * The restricted-cash catch-all stays last: at a bank it equals cash + the
   * interest-bearing deposits that `shortTermInvestments` below claims, so
   * letting it win here would double-count them in cashAndShortTermInvestments.
   */
  cashAndCashEquivalents: {
    kind: "first",
    tags: [
      "CashAndCashEquivalentsAtCarryingValue",
      "CashAndDueFromBanks",
      "Cash",
      "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
    ],
    unit: "money",
  },
  shortTermInvestments: {
    kind: "first",
    tags: [
      "ShortTermInvestments",
      "MarketableSecuritiesCurrent",
      "AvailableForSaleSecuritiesDebtSecuritiesCurrent",
      // A bank's near-cash: JPM's 321.60B of interest-bearing deposits in banks.
      "InterestBearingDepositsInBanks",
    ],
    unit: "money",
  },
  cashAndShortTermInvestments: { kind: "first", tags: ["CashCashEquivalentsAndShortTermInvestments"], unit: "money" },
  netReceivables: { kind: "first", tags: ["AccountsReceivableNetCurrent", "ReceivablesNetCurrent"], unit: "money" },
  inventory: { kind: "first", tags: ["InventoryNet"], unit: "money" },
  totalCurrentAssets: { kind: "first", tags: ["AssetsCurrent"], unit: "money" },
  propertyPlantEquipmentNet: {
    kind: "first",
    tags: [
      "PropertyPlantAndEquipmentNet",
      "PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization",
    ],
    unit: "money",
  },
  goodwill: { kind: "first", tags: ["Goodwill"], unit: "money" },
  intangibleAssets: { kind: "first", tags: ["IntangibleAssetsNetExcludingGoodwill", "FiniteLivedIntangibleAssetsNet"], unit: "money" },
  totalAssets: { kind: "first", tags: ["Assets"], unit: "money" },
  shortTermDebt: {
    kind: "chain",
    unit: "money",
    steps: [
      { kind: "first", tags: ["DebtCurrent"], unit: "money" },
      { kind: "sumAny", tags: ["LongTermDebtCurrent", "ShortTermBorrowings", "CommercialPaper"], unit: "money" },
    ],
  },
  longTermDebt: {
    kind: "first",
    tags: ["LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations", "LongTermDebt"],
    unit: "money",
  },
  totalCurrentLiabilities: { kind: "first", tags: ["LiabilitiesCurrent"], unit: "money" },
  totalLiabilities: { kind: "first", tags: ["Liabilities"], unit: "money" },
  deferredRevenue: { kind: "first", tags: ["ContractWithCustomerLiabilityCurrent", "DeferredRevenueCurrent"], unit: "money" },
  taxPayables: { kind: "first", tags: ["AccruedIncomeTaxesCurrent", "TaxesPayableCurrent"], unit: "money" },
  capitalLeaseObligations: LEASE_LIABILITY_SPEC,
  preferredStock: { kind: "first", tags: ["PreferredStockValue"], unit: "money" },
  commonStock: { kind: "first", tags: ["CommonStockValue"], unit: "money" },
  retainedEarnings: { kind: "first", tags: ["RetainedEarningsAccumulatedDeficit"], unit: "money" },
  accumulatedOtherComprehensiveIncomeLoss: {
    kind: "first",
    tags: ["AccumulatedOtherComprehensiveIncomeLossNetOfTax"],
    unit: "money",
  },
  totalStockholdersEquity: { kind: "first", tags: ["StockholdersEquity"], unit: "money" },
  minorityInterest: { kind: "first", tags: ["MinorityInterest"], unit: "money" },
  totalEquity: {
    kind: "first",
    tags: ["StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
    unit: "money",
  },
  /** Extra key (banks); legal via the FmpRawRow index signature. */
  deposits: { kind: "first", tags: ["Deposits"], unit: "money" },
};

const CASHFLOW_CHAINS: Record<string, ChainSpec> = {
  netIncome: { kind: "first", tags: ["NetIncomeLoss", "ProfitLoss"], unit: "money" },
  depreciationAndAmortization: DEPRECIATION_SPEC,
  stockBasedCompensation: { kind: "first", tags: ["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"], unit: "money" },
  changeInWorkingCapital: { kind: "first", tags: ["IncreaseDecreaseInOperatingCapital"], unit: "money", sign: -1 },
  operatingCashFlow: {
    kind: "first",
    tags: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
    unit: "money",
  },
  capitalExpenditure: {
    kind: "first",
    tags: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
    unit: "money",
    sign: -1,
  },
  acquisitionsNet: { kind: "first", tags: ["PaymentsToAcquireBusinessesNetOfCashAcquired"], unit: "money", sign: -1 },
  netDebtIssuance: { kind: "diff", plus: "ProceedsFromIssuanceOfLongTermDebt", minus: "RepaymentsOfLongTermDebt", unit: "money" },
  netStockIssuance: { kind: "diff", plus: "ProceedsFromIssuanceOfCommonStock", minus: "PaymentsForRepurchaseOfCommonStock", unit: "money" },
  commonStockIssuance: { kind: "first", tags: ["ProceedsFromIssuanceOfCommonStock"], unit: "money" },
  commonStockRepurchased: { kind: "first", tags: ["PaymentsForRepurchaseOfCommonStock"], unit: "money", sign: -1 },
  netDividendsPaid: { kind: "first", tags: ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"], unit: "money", sign: -1 },
  preferredDividendsPaid: {
    kind: "first",
    tags: ["PaymentsOfDividendsPreferredStockAndPreferenceStock"],
    unit: "money",
    sign: -1,
  },
  incomeTaxesPaid: { kind: "first", tags: ["IncomeTaxesPaidNet", "IncomeTaxesPaid"], unit: "money" },
  interestPaid: { kind: "first", tags: ["InterestPaidNet", "InterestPaid"], unit: "money" },
  /**
   * FMP's own names for the two remaining cash-flow subtotals. Stage B's
   * forensics accruals ratio reads `netCashProvidedByInvestingActivities`
   * literally, so emitting only the short `investingCashFlow` key left the
   * ratio unresolvable on the keyless path.
   */
  netCashProvidedByInvestingActivities: { kind: "first", tags: ["NetCashProvidedByUsedInInvestingActivities"], unit: "money" },
  netCashProvidedByFinancingActivities: { kind: "first", tags: ["NetCashProvidedByUsedInFinancingActivities"], unit: "money" },
};

/** Fields whose value is a verbatim copy of another resolved field. */
const CASHFLOW_ALIASES: Record<string, string> = {
  netCashProvidedByOperatingActivities: "operatingCashFlow",
  investmentsInPropertyPlantAndEquipment: "capitalExpenditure",
  commonDividendsPaid: "netDividendsPaid",
  /** Short forms kept for existing consumers; legal via the FmpRawRow index signature. */
  investingCashFlow: "netCashProvidedByInvestingActivities",
  financingCashFlow: "netCashProvidedByFinancingActivities",
};

/** Balance-sheet aliases: FMP publishes the same receivables figure under two names. */
const BALANCE_ALIASES: Record<string, string> = {
  accountsReceivables: "netReceivables",
};

/**
 * FMP columns this extractor deliberately does not source from XBRL. They are
 * emitted as explicit nulls so a consumer sees "undisclosed", not "absent key".
 */
const INCOME_UNSOURCED = ["bottomLineNetIncome"];
const BALANCE_UNSOURCED = ["treasuryStock", "totalInvestments"];

/** Anchor concepts that date a fiscal year. `Assets` supplies instants. */
const FY_ANCHOR_DURATION_TAGS = [...REVENUE_TAGS, "NetIncomeLoss", "ProfitLoss"];

// ---------------------------------------------------------------------------
// Fact index
// ---------------------------------------------------------------------------

interface UnitPoints {
  unit: string;
  /** Deduped: the max(filed) winner per period. This is where a VALUE comes from. */
  points: FactPoint[];
  /**
   * Per period, the EARLIEST core-form filing that reported it — the filing whose
   * `fy`/`fp`/`form`/`filed` actually describe this period.
   *
   * The mandated max(filed) dedup deliberately keeps the newest copy of a period so a
   * restatement wins, but the newest copy is frequently a COMPARATIVE carried in a later
   * filing, and `fy`/`fp` describe the FILING, not the fact's own period (xbrl.ts:37).
   * JPM is the live example: the FY2025 year-end `Assets`/`Deposits` instants appear both
   * as {fy:2025, fp:"FY", form:"10-K", filed:"2026-02-13"} and as
   * {fy:2026, fp:"Q1", form:"10-Q", filed:"2026-05-01", frame:"CY2025Q4I"}. Labelling from
   * the dedup winner would stamp the FY2025 balance row with a 10-Q filing date, and once
   * the next 10-K lands with an fp:"FY" comparative it would stamp the FY2025 income row
   * `fiscalYear: "2026"`. So: VALUE from the newest copy, LABELS from the first one.
   */
  reporters: Map<string, FactPoint>;
}
type FactIndex = Map<string, UnitPoints[]>;

/** Dedup/grouping key: durations by (start, end), instants by end. Mirrors dedupByPeriod. */
function periodKey(p: FactPoint): string {
  return `${p.start ?? ""}|${p.end}`;
}

/** The filing that first reported a point's period; the point itself when it stands alone. */
function reporterFor(up: UnitPoints, p: FactPoint): FactPoint {
  return up.reporters.get(periodKey(p)) ?? p;
}

/** Earliest `filed` wins; ties prefer the original over an amendment, then the lower accession. */
function buildReporters(corePoints: FactPoint[]): Map<string, FactPoint> {
  const reporters = new Map<string, FactPoint>();
  for (const p of corePoints) {
    const key = periodKey(p);
    const cur = reporters.get(key);
    if (cur === undefined || p.filed < cur.filed) {
      reporters.set(key, p);
      continue;
    }
    if (p.filed > cur.filed) continue;
    const pAmend = p.form.trim().endsWith("/A");
    const curAmend = cur.form.trim().endsWith("/A");
    if (curAmend && !pAmend) reporters.set(key, p);
    else if (pAmend === curAmend && p.accn < cur.accn) reporters.set(key, p);
  }
  return reporters;
}

function collectTags(spec: ChainSpec, into: Set<string>): void {
  if (spec.kind === "chain") {
    for (const step of spec.steps) collectTags(step, into);
    return;
  }
  if (spec.kind === "sumAnyOf") {
    for (const part of spec.parts) collectTags(part.spec, into);
    return;
  }
  if (spec.kind === "diff") {
    into.add(spec.plus);
    into.add(spec.minus);
    return;
  }
  for (const tag of spec.tags) into.add(tag);
}

/** The all-classes share count a per-class reporter files instead of the dei cover count. */
export const BALANCE_SHEET_SHARES_TAG = "CommonStockSharesOutstanding";

/** Every us-gaap tag any chain or anchor can ask for; nothing else is parsed. */
const NEEDED_US_GAAP_TAGS: ReadonlySet<string> = (() => {
  const tags = new Set<string>(FY_ANCHOR_DURATION_TAGS);
  tags.add("Assets");
  // Not in any chain: the share-count fallback below reads it directly.
  tags.add(BALANCE_SHEET_SHARES_TAG);
  for (const table of [INCOME_CHAINS, BALANCE_CHAINS, CASHFLOW_CHAINS]) {
    for (const spec of Object.values(table)) collectTags(spec, tags);
  }
  collectTags(BANK_REVENUE_SPEC, tags);
  return tags;
})();

const NEEDED_DEI_TAGS = new Set(["EntityCommonStockSharesOutstanding", "EntityPublicFloat"]);

function unitMatches(unit: string, kind: UnitKind): boolean {
  if (kind === "money") return /^[A-Z]{3}$/.test(unit);
  if (kind === "perShare") return unit.endsWith("/shares");
  return unit === "shares";
}

/**
 * Parse -> core-form filter -> per-period max(filed), once per (tag, unit).
 * Unit entries are ordered USD-first then alphabetically so a filer reporting
 * in two currencies resolves deterministically.
 */
function buildFactIndex(facts: CompanyFacts): FactIndex {
  const index: FactIndex = new Map();
  const namespaces: [string, string, ReadonlySet<string>][] = [
    ["us-gaap", "", NEEDED_US_GAAP_TAGS],
    ["dei", "dei:", NEEDED_DEI_TAGS],
  ];
  for (const [namespace, prefix, wanted] of namespaces) {
    const concepts = facts.facts[namespace];
    if (concepts === undefined || concepts === null || typeof concepts !== "object") continue;
    for (const [tag, raw] of Object.entries(concepts)) {
      if (!wanted.has(tag)) continue;
      const parsed = conceptFactsSchema.safeParse(raw);
      if (!parsed.success) continue;
      const entries: UnitPoints[] = [];
      for (const [unit, rawPoints] of Object.entries(parsed.data.units)) {
        if (!Array.isArray(rawPoints)) continue;
        const core = filterToCoreForms(parseFactPoints(rawPoints));
        const points = dedupByPeriod(core);
        if (points.length > 0) entries.push({ unit, points, reporters: buildReporters(core) });
      }
      if (entries.length === 0) continue;
      entries.sort((a, b) => (a.unit === "USD" ? -1 : b.unit === "USD" ? 1 : a.unit.localeCompare(b.unit)));
      index.set(prefix + tag, entries);
    }
  }
  return index;
}

function pickUnitPoints(index: FactIndex, tag: string, kind: UnitKind): UnitPoints | null {
  const entries = index.get(tag);
  if (entries === undefined) return null;
  return entries.find((e) => unitMatches(e.unit, kind)) ?? null;
}

// ---------------------------------------------------------------------------
// Period resolvers
// ---------------------------------------------------------------------------

/** Deterministic pick: closest end, then latest filed, then largest accession. */
function pickBest(candidates: FactPoint[], end: string): FactPoint | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0] ?? null;
  const target = dateMs(end);
  const sorted = [...candidates].sort((a, b) => {
    const da = Math.abs(dateMs(a.end) - target);
    const db = Math.abs(dateMs(b.end) - target);
    if (da !== db) return da - db;
    if (a.filed !== b.filed) return b.filed.localeCompare(a.filed);
    return b.accn.localeCompare(a.accn);
  });
  return sorted[0] ?? null;
}

/** Instant (balance-date) fact ending within tolerance of `end`. */
function findInstant(points: FactPoint[], end: string): FactPoint | null {
  return pickBest(
    points.filter((p) => p.start === undefined && withinDays(p.end, end, TOLERANCE_DAYS)),
    end,
  );
}

/** Duration fact whose own length falls in [minDays, maxDays] and ends near `end`. */
function findByDurationDays(points: FactPoint[], end: string, minDays: number, maxDays: number): FactPoint | null {
  return pickBest(
    points.filter((p) => {
      const d = durationDays(p);
      return d !== null && d >= minDays && d <= maxDays && withinDays(p.end, end, TOLERANCE_DAYS);
    }),
    end,
  );
}

/** Duration fact matching BOTH ends of an explicit [start, end] window. */
function findDurationExact(points: FactPoint[], start: string, end: string): FactPoint | null {
  return pickBest(
    points.filter(
      (p) => p.start !== undefined && withinDays(p.start, start, TOLERANCE_DAYS) && withinDays(p.end, end, TOLERANCE_DAYS),
    ),
    end,
  );
}

function findAnnualDuration(points: FactPoint[], end: string): FactPoint | null {
  return findByDurationDays(points, end, ANNUAL_MIN_DAYS, ANNUAL_MAX_DAYS);
}

/**
 * Annual-row lookup. The explicit window wins; when it misses (or no fiscal-year
 * start is known) any 300-400 day fact ending at the same fiscal year end is
 * accepted. That fallback exists because a restating filing can shift a concept's
 * context start by more than the 3-day tolerance while the year end is unchanged.
 */
function findDurationForAnnual(points: FactPoint[], start: string | null, end: string): FactPoint | null {
  if (start !== null) {
    const exact = findDurationExact(points, start, end);
    if (exact !== null) return exact;
  }
  return findAnnualDuration(points, end);
}

// ---------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------

interface Resolved {
  value: number;
  /** The fact the value is anchored to (the FY point for a derived quarter). */
  point: FactPoint;
  /** The filing that FIRST reported `point`'s period. Row labels are read off this. */
  reporter: FactPoint;
  unit: string;
  /**
   * The us-gaap tag(s) this value came from, in resolution order. A chain of
   * near-synonyms hides which concept actually won, and for the debt fields
   * that is exactly what decides whether two of them overlap: the composition
   * has to be visible in the row notes and readable by `computeBalance`.
   */
  tags: string[];
  /** For a `sumAnyOf`, each resolved part by label (the lease split needs it). */
  parts?: Record<string, number>;
  derivation?: Derivation;
  derivedFrom?: string[];
}

/** Value and period from `point`; labels from the filing that first reported that period. */
function resolvedPoint(tag: string, up: UnitPoints, point: FactPoint, value: number): Resolved {
  return { value, point, reporter: reporterFor(up, point), unit: up.unit, tags: [tag] };
}

type TagResolver = (tag: string, kind: UnitKind) => Resolved | null;

interface NoteSink {
  readonly notes: string[];
  add(note: string): void;
}

function createNoteSink(): NoteSink {
  const seen = new Set<string>();
  const notes: string[] = [];
  return {
    notes,
    add(note: string): void {
      if (seen.has(note)) return;
      seen.add(note);
      notes.push(note);
    },
  };
}

function describePoint(tag: string, p: FactPoint): string {
  return `${tag} ${p.start ?? "(instant)"}..${p.end}`;
}

/**
 * Merge component resolutions into one: first point/unit wins, provenance unions, and the
 * reporter is the earliest-filed of the components — the first filing in which every part of
 * this combined figure had been reported at least once.
 */
function combine(value: number, parts: Resolved[]): Resolved {
  const head = parts[0] as Resolved;
  const derived = parts.find((p) => p.derivation !== undefined);
  const derivedFrom = [...new Set(parts.flatMap((p) => p.derivedFrom ?? []))];
  const reporter = parts.reduce((a, b) => (b.reporter.filed < a.reporter.filed ? b : a), head).reporter;
  const tags = [...new Set(parts.flatMap((p) => p.tags))];
  const out: Resolved = { value, point: head.point, reporter, unit: head.unit, tags };
  if (derived !== undefined) out.derivation = derived.derivation;
  if (derivedFrom.length > 0) out.derivedFrom = derivedFrom;
  return out;
}

/** Resolve components sharing one unit; components in another unit are dropped. */
function resolveComponents(
  tags: string[],
  unit: UnitKind,
  resolve: TagResolver,
): { present: { tag: string; r: Resolved }[]; absent: string[] } {
  const present: { tag: string; r: Resolved }[] = [];
  const absent: string[] = [];
  for (const tag of tags) {
    const r = resolve(tag, unit);
    if (r === null) {
      absent.push(tag);
      continue;
    }
    if (present.length > 0 && present[0]!.r.unit !== r.unit) {
      absent.push(tag);
      continue;
    }
    present.push({ tag, r });
  }
  return { present, absent };
}

function resolveSpec(spec: ChainSpec, resolve: TagResolver, notes: NoteSink, label: string): Resolved | null {
  switch (spec.kind) {
    case "chain": {
      for (const step of spec.steps) {
        const r = resolveSpec(step, resolve, notes, label);
        if (r !== null) return r;
      }
      return null;
    }
    case "first": {
      for (const tag of spec.tags) {
        const r = resolve(tag, spec.unit);
        if (r === null) continue;
        if (spec.sign === undefined) return r;
        const decimals = spec.unit === "perShare" ? PER_SHARE_DECIMALS : MONEY_DECIMALS;
        return { ...r, value: tidy(r.value * spec.sign, decimals) };
      }
      return null;
    }
    case "sum": {
      const { present } = resolveComponents(spec.tags, spec.unit, resolve);
      if (present.length !== spec.tags.length) return null;
      const total = present.reduce((s, p) => s + p.r.value, 0);
      return combine(tidy(total, MONEY_DECIMALS), present.map((p) => p.r));
    }
    case "sumAny": {
      const { present, absent } = resolveComponents(spec.tags, spec.unit, resolve);
      if (present.length === 0) return null;
      if (absent.length > 0) {
        notes.add(
          `${label}: sum of present components (${present.map((p) => p.tag).join(", ")}); absent and excluded: ${absent.join(", ")}`,
        );
      }
      const total = present.reduce((s, p) => s + p.r.value, 0);
      return combine(tidy(total, MONEY_DECIMALS), present.map((p) => p.r));
    }
    case "sumAnyOf": {
      // Same contract as `sumAny`, one level up: at least one part must resolve,
      // parts in a foreign currency are dropped, and every absent part is named.
      const present: { label: string; r: Resolved }[] = [];
      const absent: string[] = [];
      for (const part of spec.parts) {
        const r = resolveSpec(part.spec, resolve, notes, `${label} (${part.label})`);
        if (r === null || (present.length > 0 && present[0]!.r.unit !== r.unit)) {
          absent.push(part.label);
          continue;
        }
        present.push({ label: part.label, r });
      }
      if (present.length === 0) return null;
      if (absent.length > 0) {
        notes.add(
          `${label}: sum of present components (${present.map((p) => p.label).join(", ")}); absent and excluded: ${absent.join(", ")}`,
        );
      }
      const total = present.reduce((s, p) => s + p.r.value, 0);
      return {
        ...combine(tidy(total, MONEY_DECIMALS), present.map((p) => p.r)),
        parts: Object.fromEntries(present.map((p) => [p.label, p.r.value])),
      };
    }
    case "diff": {
      const plus = resolve(spec.plus, spec.unit);
      const minus = resolve(spec.minus, spec.unit);
      if (plus === null || minus === null || plus.unit !== minus.unit) return null;
      return combine(tidy(plus.value - minus.value, MONEY_DECIMALS), [plus, minus]);
    }
  }
}

// ---------------------------------------------------------------------------
// Fiscal calendar discovery
// ---------------------------------------------------------------------------

interface FiscalYear {
  end: string;
  /** Start of the fiscal year, from the anchor duration point; null when unknown. */
  start: string | null;
}

/** Newest-first, near-duplicate ends merged (a 53rd week moves an end by days). */
function mergeEndsDesc(ends: Iterable<string>, prefer?: ReadonlySet<string>): string[] {
  const sorted = [...new Set(ends)].sort((a, b) => b.localeCompare(a));
  const kept: string[] = [];
  for (const end of sorted) {
    const last = kept[kept.length - 1];
    if (last !== undefined && withinDays(end, last, TOLERANCE_DAYS)) {
      // Keep the fiscal-year end of a cluster rather than an adjacent instant.
      if (prefer !== undefined && prefer.has(end) && !prefer.has(last)) kept[kept.length - 1] = end;
      continue;
    }
    kept.push(end);
  }
  return kept;
}

function discoverFiscalYears(index: FactIndex): FiscalYear[] {
  const ends = new Set<string>();
  const starts = new Map<string, { start: string; duration: number; filed: string }>();
  for (const tag of FY_ANCHOR_DURATION_TAGS) {
    const up = pickUnitPoints(index, tag, "money");
    if (up === null) continue;
    // Iterate the REPORTERS, not the dedup winners: a period first reported on a 10-K but
    // later carried as a comparative in a 10-Q would otherwise stop looking like a year end.
    for (const p of up.reporters.values()) {
      if (!ANNUAL_FORMS.has(p.form.trim())) continue;
      const d = durationDays(p);
      if (d === null || d < ANNUAL_MIN_DAYS || d > ANNUAL_MAX_DAYS) continue;
      ends.add(p.end);
      const cur = starts.get(p.end);
      if (cur === undefined || d > cur.duration || (d === cur.duration && p.filed > cur.filed)) {
        starts.set(p.end, { start: p.start as string, duration: d, filed: p.filed });
      }
    }
  }
  const assets = pickUnitPoints(index, "Assets", "money");
  if (assets !== null) {
    for (const p of assets.reporters.values()) {
      if (p.start !== undefined || !ANNUAL_FORMS.has(p.form.trim())) continue;
      ends.add(p.end);
    }
  }
  return mergeEndsDesc(ends).map((end) => {
    const exact = starts.get(end);
    if (exact !== undefined) return { end, start: exact.start };
    // The merge may have kept a neighbouring end; reuse a start within tolerance.
    let best: { start: string; duration: number } | null = null;
    for (const [key, value] of starts) {
      if (!withinDays(key, end, TOLERANCE_DAYS)) continue;
      if (best === null || value.duration > best.duration) best = value;
    }
    return { end, start: best?.start ?? null };
  });
}

function discoverQuarterEnds(index: FactIndex, fiscalYearEnds: ReadonlySet<string>): string[] {
  const ends = new Set<string>(fiscalYearEnds);
  const assets = pickUnitPoints(index, "Assets", "money");
  if (assets !== null) {
    for (const p of assets.reporters.values()) {
      if (p.start !== undefined || !QUARTERLY_FORMS.has(p.form.trim())) continue;
      ends.add(p.end);
    }
  }
  return mergeEndsDesc(ends, fiscalYearEnds);
}

interface QuarterContext {
  end: string;
  /** Start of the fiscal year containing `end`; null when no anchor spans it. */
  fyStart: string | null;
  /** End of that fiscal year (used for the fiscal-year label). */
  fyEnd: string | null;
  isFiscalYearEnd: boolean;
  /** Nearest earlier quarter end 70-110 days back; null at the oldest quarter. */
  previousEnd: string | null;
}

/**
 * The fiscal-year window containing `q`: the longest anchor duration point (FY
 * or year-to-date, any core form) whose [start, end] brackets `q`. When nothing
 * brackets it, the previous quarter end + 1 day is used as the window start so a
 * year-to-date difference can still be attempted.
 */
function fiscalWindowFor(index: FactIndex, q: string, previousEnd: string | null): { start: string | null; end: string | null } {
  let best: { start: string; end: string; duration: number } | null = null;
  for (const tag of FY_ANCHOR_DURATION_TAGS) {
    const up = pickUnitPoints(index, tag, "money");
    if (up === null) continue;
    for (const p of up.points) {
      const d = durationDays(p);
      if (p.start === undefined || d === null || d > ANNUAL_MAX_DAYS) continue;
      if (daysBetween(p.start, q) < -TOLERANCE_DAYS || daysBetween(q, p.end) < -TOLERANCE_DAYS) continue;
      if (best === null || d > best.duration) best = { start: p.start, end: p.end, duration: d };
    }
  }
  if (best !== null) return { start: best.start, end: best.duration >= ANNUAL_MIN_DAYS ? best.end : null };
  if (previousEnd !== null) {
    return { start: new Date(dateMs(previousEnd) + DAY_MS).toISOString().slice(0, 10), end: null };
  }
  return { start: null, end: null };
}

function buildQuarterContexts(index: FactIndex, quarterEnds: string[], fiscalYearEnds: ReadonlySet<string>): QuarterContext[] {
  const isFyEnd = (end: string): boolean => [...fiscalYearEnds].some((f) => withinDays(f, end, TOLERANCE_DAYS));
  return quarterEnds.map((end, i) => {
    let previousEnd: string | null = null;
    for (let j = i + 1; j < quarterEnds.length; j += 1) {
      const gap = daysBetween(quarterEnds[j] as string, end);
      if (gap >= QUARTER_MIN_DAYS && gap <= QUARTER_MAX_DAYS) {
        previousEnd = quarterEnds[j] as string;
        break;
      }
      if (gap > QUARTER_MAX_DAYS) break;
    }
    const window = fiscalWindowFor(index, end, previousEnd);
    // Prefer a discovered fiscal-year end at or after this quarter for labelling.
    const laterFyEnds = [...fiscalYearEnds].filter((f) => daysBetween(end, f) >= -TOLERANCE_DAYS).sort();
    return {
      end,
      fyStart: window.start,
      fyEnd: laterFyEnds[0] ?? window.end,
      isFiscalYearEnd: isFyEnd(end),
      previousEnd,
    };
  });
}

// ---------------------------------------------------------------------------
// Tag resolvers per period kind
// ---------------------------------------------------------------------------

function annualResolver(index: FactIndex, fy: FiscalYear): TagResolver {
  return (tag, kind) => {
    const up = pickUnitPoints(index, tag, kind);
    if (up === null) return null;
    const p = findDurationForAnnual(up.points, fy.start, fy.end);
    return p === null ? null : resolvedPoint(tag, up, p, p.val);
  };
}

function instantResolver(index: FactIndex, end: string): TagResolver {
  return (tag, kind) => {
    const up = pickUnitPoints(index, tag, kind);
    if (up === null) return null;
    const p = findInstant(up.points, end);
    return p === null ? null : resolvedPoint(tag, up, p, p.val);
  };
}

function decimalsFor(kind: UnitKind): number {
  return kind === "perShare" ? PER_SHARE_DECIMALS : MONEY_DECIMALS;
}

/** The three 3-month points preceding an FY end, all required. */
function precedingQuarterPoints(points: FactPoint[], ctx: QuarterContext, quarterEnds: string[]): FactPoint[] | null {
  const out: FactPoint[] = [];
  let cursor = ctx.previousEnd;
  for (let i = 0; i < 3; i += 1) {
    if (cursor === null) return null;
    const p = findByDurationDays(points, cursor, QUARTER_MIN_DAYS, QUARTER_MAX_DAYS);
    if (p === null) return null;
    out.push(p);
    const idx = quarterEnds.indexOf(cursor);
    cursor = null;
    for (let j = idx + 1; j < quarterEnds.length && idx >= 0; j += 1) {
      const gap = daysBetween(quarterEnds[j] as string, quarterEnds[idx] as string);
      if (gap >= QUARTER_MIN_DAYS && gap <= QUARTER_MAX_DAYS) {
        cursor = quarterEnds[j] as string;
        break;
      }
      if (gap > QUARTER_MAX_DAYS) break;
    }
  }
  return out;
}

/**
 * The quarterly period algorithm.
 *
 *  (a) a tagged 3-month fact ending at the quarter (skipped when `ytdOnly`,
 *      because 10-Q cash-flow facts are year-to-date by construction);
 *  (c) at a fiscal-year end: FY - year-to-date-through-the-previous-quarter,
 *      else FY - (Q1 + Q2 + Q3) when all three 3-month facts exist;
 *  (b) otherwise the year-to-date difference — and, in the first quarter of a
 *      fiscal year, the year-to-date fact IS the quarter.
 *
 * Weighted share counts are never subtracted (a share count is a stock, not a
 * flow); per-share amounts use (a) plus the FY-minus-YTD rule at Q4 only, which
 * is the FMP convention for a fourth-quarter EPS.
 */
function quarterResolver(index: FactIndex, ctx: QuarterContext, quarterEnds: string[], ytdOnly: boolean): TagResolver {
  return (tag, kind) => {
    const up = pickUnitPoints(index, tag, kind);
    if (up === null) return null;
    const pts = up.points;
    const decimals = decimalsFor(kind);

    if (!ytdOnly) {
      const threeMonth = findByDurationDays(pts, ctx.end, QUARTER_MIN_DAYS, QUARTER_MAX_DAYS);
      if (threeMonth !== null) return resolvedPoint(tag, up, threeMonth, threeMonth.val);
    }
    if (kind === "shares") return null;

    if (ctx.isFiscalYearEnd) {
      const fy =
        (ctx.fyStart !== null ? findDurationExact(pts, ctx.fyStart, ctx.end) : null) ?? findAnnualDuration(pts, ctx.end);
      if (fy === null || fy.start === undefined) return null;
      if (ctx.previousEnd !== null) {
        const ytdPrev = findDurationExact(pts, fy.start, ctx.previousEnd);
        if (ytdPrev !== null) {
          return {
            ...resolvedPoint(tag, up, fy, tidy(fy.val - ytdPrev.val, decimals)),
            derivation: "fy-minus-ytd",
            derivedFrom: [describePoint(tag, fy), describePoint(tag, ytdPrev)],
          };
        }
      }
      if (kind === "perShare") return null;
      const quarters = precedingQuarterPoints(pts, ctx, quarterEnds);
      if (quarters === null) return null;
      const sum = quarters.reduce((s, p) => s + p.val, 0);
      return {
        ...resolvedPoint(tag, up, fy, tidy(fy.val - sum, decimals)),
        derivation: "fy-minus-quarters",
        derivedFrom: [describePoint(tag, fy), ...quarters.map((p) => describePoint(tag, p))],
      };
    }

    if (kind === "perShare" || ctx.fyStart === null) return null;
    const ytd = findDurationExact(pts, ctx.fyStart, ctx.end);
    if (ytd === null || ytd.start === undefined) return null;
    // First quarter of the fiscal year: the year-to-date fact IS the quarter.
    if (daysBetween(ctx.fyStart, ctx.end) <= QUARTER_MAX_DAYS) return resolvedPoint(tag, up, ytd, ytd.val);
    if (ctx.previousEnd === null) return null;
    const prior = findDurationExact(pts, ytd.start, ctx.previousEnd);
    if (prior === null) return null;
    return {
      ...resolvedPoint(tag, up, ytd, tidy(ytd.val - prior.val, decimals)),
      derivation: "ytd-difference",
      derivedFrom: [describePoint(tag, ytd), describePoint(tag, prior)],
    };
  };
}

// ---------------------------------------------------------------------------
// Computed-field passes (fill only fields still null; operands must be present)
// ---------------------------------------------------------------------------

type FieldValues = Record<string, number | null>;

function add(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : tidy(a + b, MONEY_DECIMALS);
}

function sub(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : tidy(a - b, MONEY_DECIMALS);
}

function sumAnyValues(parts: [string, number | null][], notes: NoteSink, label: string): number | null {
  const present = parts.filter((p): p is [string, number] => p[1] !== null);
  if (present.length === 0) return null;
  const absent = parts.filter((p) => p[1] === null).map((p) => p[0]);
  if (absent.length > 0) {
    notes.add(`${label}: sum of present components (${present.map((p) => p[0]).join(", ")}); absent and excluded: ${absent.join(", ")}`);
  }
  return tidy(present.reduce((s, p) => s + p[1], 0), MONEY_DECIMALS);
}

/**
 * What a computed pass may consult beyond the field values: which tag(s) won
 * each chain, and a direct tag lookup at this period. Both exist for the debt
 * fields, whose chains contain near-synonyms that overlap each other.
 */
interface ComputeContext {
  resolved: ReadonlyMap<string, Resolved>;
  /** The value of one money tag at this period, or null. */
  money(tag: string): number | null;
}

function computeIncome(v: FieldValues, notes: NoteSink, ctx: string): void {
  v.grossProfit ??= sub(v.revenue ?? null, v.costOfRevenue ?? null);
  v.operatingExpenses ??= sumAnyValues(
    [
      ["researchAndDevelopmentExpenses", v.researchAndDevelopmentExpenses ?? null],
      ["sellingGeneralAndAdministrativeExpenses", v.sellingGeneralAndAdministrativeExpenses ?? null],
    ],
    notes,
    `operatingExpenses ${ctx}`,
  );
  v.ebitda ??= add(v.operatingIncome ?? null, v.depreciationAndAmortization ?? null);
  v.ebit ??= add(v.incomeBeforeTax ?? null, v.interestExpense ?? null) ?? v.operatingIncome ?? null;
}

function computeBalance(v: FieldValues, notes: NoteSink, ctx: string, cc: ComputeContext): void {
  // A strict `add` here returned null for every filer that presents a single
  // "Cash and cash equivalents" line and tags no short-term-investment concept
  // (Home Depot, McDonald's, UPS, Costco and hundreds like them). That
  // suppressed the net-debt cash basis and with it the whole DCF equity bridge,
  // for a shape FMP publishes as cash. Sum what is present and name what is not.
  v.cashAndShortTermInvestments ??= sumAnyValues(
    [
      ["cashAndCashEquivalents", v.cashAndCashEquivalents ?? null],
      ["shortTermInvestments", v.shortTermInvestments ?? null],
    ],
    notes,
    `cashAndShortTermInvestments ${ctx}`,
  );
  // `totalEquity` deliberately stays strict: `validate.ts` and `forensics.ts`
  // both fall back to `totalStockholdersEquity`, so nothing is suppressed.
  v.totalEquity ??= add(v.totalStockholdersEquity ?? null, v.minorityInterest ?? null);
  v.totalLiabilities ??= sub(v.totalAssets ?? null, v.totalEquity ?? null);
  const lease = resolveDebtOverlaps(v, notes, ctx, cc);
  // FMP's definition: shortTermDebt + longTermDebt + capitalLeaseObligations
  // (Apple FY2025 20.329 + 78.328 + 13.720 = 112.377B). Dropping the leases
  // moved net debt, invested capital and the cost-of-debt denominator off the
  // house numbers every band was calibrated against.
  v.totalDebt ??= sumAnyValues(
    [
      ["shortTermDebt", v.shortTermDebt ?? null],
      ["longTermDebt", v.longTermDebt ?? null],
      [lease.label, lease.value],
    ],
    notes,
    `totalDebt ${ctx}`,
  );
  v.netDebt ??= sub(v.totalDebt ?? null, v.cashAndCashEquivalents ?? null);
}

/**
 * FMP semantics for the three debt fields: `longTermDebt` is noncurrent debt
 * excluding leases, `shortTermDebt` is current debt, `capitalLeaseObligations`
 * is the operating + finance lease liability, and `totalDebt` is their sum.
 * Three us-gaap tags in the chains break that partition by overlapping each
 * other, and every one of them reaches net debt, invested capital, ROIC, the
 * multiples EV and the cost-of-debt denominator with no note:
 *
 *  1. `LongTermDebtAndCapitalLeaseObligations` already contains the finance
 *     leases that `capitalLeaseObligations` resolves again.
 *  2. `LongTermDebt` is the us-gaap TOTAL including current maturities, which
 *     `shortTermDebt` counts again through `LongTermDebtCurrent`.
 *  3. `CommercialPaper` is conventionally a component of `ShortTermBorrowings`.
 *
 * The composition of all three fields is named in the notes either way, so a
 * reader can see which concepts a debt figure is made of. Returns the label the
 * lease component carries into the `totalDebt` sum.
 */
function resolveDebtOverlaps(
  v: FieldValues,
  notes: NoteSink,
  ctx: string,
  cc: ComputeContext,
): { label: string; value: number | null } {
  const tagsOf = (field: string): string[] => cc.resolved.get(field)?.tags ?? [];
  for (const field of ["shortTermDebt", "longTermDebt", "capitalLeaseObligations"] as const) {
    const tags = tagsOf(field);
    if (tags.length > 0) notes.add(`${field} ${ctx}: from ${tags.join(" + ")}`);
  }

  // Case 3 first: it changes `shortTermDebt`, which case 2 does not read.
  const shortTermTags = tagsOf("shortTermDebt");
  if (shortTermTags.includes("ShortTermBorrowings") && shortTermTags.includes("CommercialPaper")) {
    const commercialPaper = cc.money("CommercialPaper");
    if (commercialPaper !== null && v.shortTermDebt != null) {
      v.shortTermDebt = tidy(v.shortTermDebt - commercialPaper, MONEY_DECIMALS);
      notes.add(
        `shortTermDebt ${ctx}: CommercialPaper excluded — commercial paper is conventionally a component of ShortTermBorrowings, which resolved for this period`,
      );
    }
  }

  const longTermTags = tagsOf("longTermDebt");
  // Case 2.
  if (longTermTags.includes("LongTermDebt") && v.longTermDebt != null) {
    const current = cc.money("LongTermDebtCurrent");
    if (current !== null) {
      v.longTermDebt = tidy(v.longTermDebt - current, MONEY_DECIMALS);
      notes.add(`longTermDebt ${ctx}: LongTermDebt less current maturities (LongTermDebtCurrent ${current})`);
    } else {
      notes.add(
        `longTermDebt ${ctx}: resolved from the LongTermDebt total and no LongTermDebtCurrent fact was filed, so current maturities may be included`,
      );
    }
  }

  // Case 1. `capitalLeaseObligations` itself keeps the full lease figure — that
  // is what FMP publishes — and the exclusion is applied only to the sum.
  const leases = cc.resolved.get("capitalLeaseObligations");
  const full = v.capitalLeaseObligations ?? null;
  if (longTermTags.includes("LongTermDebtAndCapitalLeaseObligations") && leases?.parts !== undefined) {
    const finance = leases.parts["financeLeaseLiability"];
    if (finance !== undefined) {
      notes.add(
        `totalDebt ${ctx}: longTermDebt resolved from LongTermDebtAndCapitalLeaseObligations, which already includes finance lease obligations, so only the operating-lease liability is added here; capitalLeaseObligations still reports the full ${full ?? "null"}`,
      );
      return {
        label: "capitalLeaseObligations (operating leases only)",
        value: leases.parts["operatingLeaseLiability"] ?? null,
      };
    }
  }
  return { label: "capitalLeaseObligations", value: full };
}

function computeCashflow(v: FieldValues): void {
  v.freeCashFlow ??= add(v.operatingCashFlow ?? null, v.capitalExpenditure ?? null);
}

// ---------------------------------------------------------------------------
// Row assembly
// ---------------------------------------------------------------------------

type StatementName = "income" | "balance" | "cashflow";
type Scope = "annual" | "quarter";

interface StatementDef {
  statement: StatementName;
  chains: Record<string, ChainSpec>;
  /** Ordered; the first that resolves anchors the row's labels and currency. */
  anchors: string[];
  aliases: Record<string, string>;
  unsourced: string[];
  computed: string[];
  compute: (v: FieldValues, notes: NoteSink, ctx: string, cc: ComputeContext) => void;
}

interface PeriodSlot {
  date: string;
  resolve: TagResolver;
  quarter: QuarterContext | null;
}

interface BuildState {
  filesTwentyF: boolean;
}

/**
 * How long after a period ends its own report may still arrive. SEC annual deadlines top out
 * at 120 days (20-F; a 10-K is 60-90), so 270 days leaves generous slack for a late filer —
 * while staying well under the ~410 days at which the SAME period reappears as a comparative
 * inside the NEXT year's annual report, whose `fy` is one year too high.
 */
const MAX_OWN_PERIOD_FILING_LAG_DAYS = 270;

/**
 * `fy`/`fp` describe the FILING, not the fact's period (xbrl.ts:37), so they may only be
 * trusted when this filing is plausibly the period's OWN report: an annual `fp`/form, filed
 * within the window above. A comparative carried in a later filing fails one test or both,
 * and the fiscal-year end's own year is used instead.
 */
function fiscalYearLabel(anchor: FactPoint, slot: PeriodSlot): string {
  const form = anchor.form.trim();
  const fromAnnualFiling = anchor.fp === "FY" || form.startsWith("10-K") || form.startsWith("20-F");
  const lag = daysBetween(anchor.end, anchor.filed);
  const reportsOwnPeriod = lag >= 0 && lag <= MAX_OWN_PERIOD_FILING_LAG_DAYS;
  if (fromAnnualFiling && reportsOwnPeriod && typeof anchor.fy === "number") return String(anchor.fy);
  return (slot.quarter?.fyEnd ?? slot.date).slice(0, 4);
}

function quarterLabel(anchor: FactPoint, ctx: QuarterContext): string {
  if (ctx.isFiscalYearEnd) return "Q4";
  const fp = anchor.fp ?? "";
  if (fp === "Q1" || fp === "Q2" || fp === "Q3") return fp;
  if (ctx.fyStart === null) return "Q4";
  const ordinal = Math.min(4, Math.max(1, Math.round(daysBetween(ctx.fyStart, ctx.end) / 91.3)));
  return `Q${ordinal}`;
}

function buildStatementRows<TRow>(
  def: StatementDef,
  slots: PeriodSlot[],
  scope: Scope,
  opts: StatementBuildOptions,
  state: BuildState,
  notes: NoteSink,
): StatementRowsResult<TRow> {
  const rows: TRow[] = [];
  const fieldNames = [...Object.keys(def.chains), ...Object.keys(def.aliases), ...def.computed, ...def.unsourced];

  for (const slot of slots) {
    const ctxLabel = slot.date;
    const values: FieldValues = {};
    const resolutions = new Map<string, Resolved>();
    for (const [field, spec] of Object.entries(def.chains)) {
      const r = resolveSpec(spec, slot.resolve, notes, `${field} ${ctxLabel}`);
      values[field] = r === null ? null : tidy(r.value, decimalsFor(spec.unit));
      if (r !== null) resolutions.set(field, r);
    }
    for (const [alias, source] of Object.entries(def.aliases)) values[alias] = values[source] ?? null;

    const anchorField = def.anchors.find((f) => resolutions.has(f));
    if (anchorField === undefined) {
      notes.add(`${def.statement} ${ctxLabel}: no ${def.anchors.join(" or ")} fact resolved; row omitted`);
      continue;
    }
    const anchor = resolutions.get(anchorField) as Resolved;
    def.compute(values, notes, ctxLabel, {
      resolved: resolutions,
      money: (tag) => {
        const r = slot.resolve(tag, "money");
        return r === null ? null : tidy(r.value, MONEY_DECIMALS);
      },
    });
    for (const field of def.unsourced) values[field] ??= null;

    if (anchor.point.form.trim().startsWith("20-F") || anchor.reporter.form.trim().startsWith("20-F")) {
      state.filesTwentyF = true;
    }

    const row: Record<string, unknown> = {
      symbol: opts.symbol,
      cik: opts.cik,
      date: slot.date,
      reportedCurrency: anchor.unit,
      // Labels and dates come from the filing that FIRST reported the period; the VALUE above
      // still comes from the max(filed) dedup winner, so a restatement wins the number.
      fiscalYear: fiscalYearLabel(anchor.reporter, slot),
      period: slot.quarter === null ? "FY" : quarterLabel(anchor.reporter, slot.quarter),
      filingDate: anchor.reporter.filed,
      acceptedDate: anchor.reporter.filed,
    };
    for (const field of fieldNames) row[field] = values[field] ?? null;

    if (slot.quarter !== null) {
      const derivedFields = [...resolutions.entries()].filter(([, r]) => r.derivation !== undefined);
      const derivation = anchor.derivation ?? derivedFields[0]?.[1].derivation;
      if (derivation !== undefined) {
        row.derivation = derivation;
        row.derivedFrom = [...new Set(derivedFields.flatMap(([, r]) => r.derivedFrom ?? []))];
        const names = derivedFields.filter(([, r]) => r.derivation === derivation).map(([f]) => f);
        notes.add(`${def.statement} ${ctxLabel} (${String(row.period)}): ${DERIVATION_PHRASE[derivation]} derivation used for ${names.join(", ")}`);
      }
    }
    rows.push(row as TRow);
  }

  const gaps: ManifestEntry[] = [];
  if (rows.length === 0) gaps.push(noRowsGap(def, scope, opts, slots.length));
  return { rows, notes: notes.notes, gaps };
}

function noRowsGap(def: StatementDef, scope: Scope, opts: StatementBuildOptions, candidates: number): ManifestEntry {
  return {
    field: `edgar.statements.${def.statement}(${opts.symbol},${scope})`,
    reason:
      `no ${scope === "annual" ? "annual" : "quarterly"} ${def.statement} rows could be built from SEC companyfacts: ` +
      `${candidates} candidate period${candidates === 1 ? "" : "s"}, none with a ${def.anchors.join(" or ")} anchor`,
    severity: "warn",
    attemptedSources: def.anchors.map((f) => `companyfacts us-gaap/${f}`),
  };
}

const DERIVATION_PHRASE: Record<Derivation, string> = {
  "ytd-difference": "YTD difference",
  "fy-minus-ytd": "FY − YTD",
  "fy-minus-quarters": "FY − (Q1+Q2+Q3)",
};

// ---------------------------------------------------------------------------
// dei cover-page facts
// ---------------------------------------------------------------------------

/**
 * Newest point of one indexed concept. Same-`end` duplicates in companyfacts
 * are refilings, so the max(`filed`) winner is the right one — they are never
 * summed.
 */
function latestPoint(
  index: FactIndex,
  key: string,
  kind: UnitKind,
  instantOnly = false,
): { value: number; asOf: string } | null {
  const up = pickUnitPoints(index, key, kind);
  if (up === null) return null;
  let best: FactPoint | null = null;
  for (const p of up.points) {
    if (instantOnly && p.start !== undefined) continue;
    if (best === null || p.end > best.end || (p.end === best.end && p.filed > best.filed)) best = p;
  }
  return best === null ? null : { value: best.val, asOf: best.end };
}

function latestDeiPoint(index: FactIndex, tag: string, kind: UnitKind): { value: number; asOf: string } | null {
  return latestPoint(index, `dei:${tag}`, kind);
}

/**
 * Cover-page share count, else the balance-sheet all-classes total. See
 * `SharesBasis`: a per-class reporter files no non-dimensional dei cover count
 * at all, and suppressing its market cap is worse than reporting the
 * combined-class figure with the basis named.
 */
export function latestSharesOutstanding(index: FactIndex): SharesOutstandingPoint | null {
  const cover = latestDeiPoint(index, "EntityCommonStockSharesOutstanding", "shares");
  if (cover !== null) return { ...cover, basis: "dei cover page" };
  const balanceSheet = latestPoint(index, BALANCE_SHEET_SHARES_TAG, "shares", true);
  return balanceSheet === null
    ? null
    : { ...balanceSheet, basis: "balance sheet CommonStockSharesOutstanding" };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const INCOME_DEF = (bankRevenue: boolean): StatementDef => ({
  statement: "income",
  chains: bankRevenue ? { ...INCOME_CHAINS, revenue: BANK_REVENUE_SPEC } : INCOME_CHAINS,
  anchors: ["revenue", "netIncome"],
  aliases: {},
  unsourced: INCOME_UNSOURCED,
  computed: ["grossProfit", "operatingExpenses", "ebitda", "ebit"],
  compute: computeIncome,
});

const BALANCE_DEF: StatementDef = {
  statement: "balance",
  chains: BALANCE_CHAINS,
  anchors: ["totalAssets"],
  aliases: BALANCE_ALIASES,
  unsourced: BALANCE_UNSOURCED,
  computed: ["cashAndShortTermInvestments", "totalEquity", "totalLiabilities", "totalDebt", "netDebt"],
  compute: computeBalance,
};

const CASHFLOW_DEF: StatementDef = {
  statement: "cashflow",
  chains: CASHFLOW_CHAINS,
  anchors: ["operatingCashFlow"],
  aliases: CASHFLOW_ALIASES,
  unsourced: [],
  computed: ["freeCashFlow"],
  compute: (v) => computeCashflow(v),
};

/**
 * Build FMP-shaped annual and quarterly statements from an SEC companyfacts
 * payload. Pure and total: a payload with no usable facts yields empty row
 * lists plus one manifest gap per statement and scope, never a throw.
 */
export function buildStatementsFromCompanyFacts(facts: CompanyFacts, opts: StatementBuildOptions): BuiltStatements {
  const index = buildFactIndex(facts);
  const state: BuildState = { filesTwentyF: false };

  const allFiscalYears = discoverFiscalYears(index);
  const fiscalYearEnds = new Set(allFiscalYears.map((fy) => fy.end));
  const annualYears = allFiscalYears.slice(0, Math.max(0, opts.annualPeriods));

  const quarterEnds = discoverQuarterEnds(index, fiscalYearEnds);
  const quarterContexts = buildQuarterContexts(index, quarterEnds, fiscalYearEnds);
  // One quarter of headroom: the oldest requested quarter still needs its
  // predecessor to resolve a year-to-date difference.
  const quarterSlotContexts = quarterContexts.slice(0, Math.max(0, opts.quarterlyPeriods) + 1);

  const annualSlots = (resolverFor: (fy: FiscalYear) => TagResolver): PeriodSlot[] =>
    annualYears.map((fy) => ({ date: fy.end, resolve: resolverFor(fy), quarter: null }));
  const quarterSlots = (ytdOnly: boolean): PeriodSlot[] =>
    quarterSlotContexts.map((ctx) => ({
      date: ctx.end,
      resolve: quarterResolver(index, ctx, quarterEnds, ytdOnly),
      quarter: ctx,
    }));
  const balanceQuarterSlots = (): PeriodSlot[] =>
    quarterSlotContexts.map((ctx) => ({ date: ctx.end, resolve: instantResolver(index, ctx.end), quarter: ctx }));

  const bankRevenue = looksLikeBankTagging(facts);
  const incomeDef = INCOME_DEF(bankRevenue);
  const bankNote =
    "revenue resolved through the bank revenue chain (RevenueFromContractWithCustomer* absent, bank revenue/NII tags present)";

  const incomeAnnualNotes = createNoteSink();
  const incomeQuarterlyNotes = createNoteSink();
  if (bankRevenue) {
    incomeAnnualNotes.add(bankNote);
    incomeQuarterlyNotes.add(bankNote);
  }

  const incomeAnnual = buildStatementRows<FmpIncomeStatementRow>(
    incomeDef,
    annualSlots((fy) => annualResolver(index, fy)),
    "annual",
    opts,
    state,
    incomeAnnualNotes,
  );
  const incomeQuarterly = buildStatementRows<FmpIncomeStatementRow>(
    incomeDef,
    quarterSlots(false),
    "quarter",
    opts,
    state,
    incomeQuarterlyNotes,
  );
  const balanceAnnual = buildStatementRows<FmpBalanceSheetRow>(
    BALANCE_DEF,
    annualYears.map((fy) => ({ date: fy.end, resolve: instantResolver(index, fy.end), quarter: null })),
    "annual",
    opts,
    state,
    createNoteSink(),
  );
  const balanceQuarterly = buildStatementRows<FmpBalanceSheetRow>(
    BALANCE_DEF,
    balanceQuarterSlots(),
    "quarter",
    opts,
    state,
    createNoteSink(),
  );
  const cashflowAnnual = buildStatementRows<FmpCashFlowRow>(
    CASHFLOW_DEF,
    annualSlots((fy) => annualResolver(index, fy)),
    "annual",
    opts,
    state,
    createNoteSink(),
  );
  const cashflowQuarterly = buildStatementRows<FmpCashFlowRow>(
    CASHFLOW_DEF,
    quarterSlots(true),
    "quarter",
    opts,
    state,
    createNoteSink(),
  );

  // Trim the headroom quarter back to the requested count; a request trimmed to
  // nothing still has to disclose that it produced no rows.
  const quarterlyResults: [StatementRowsResult<{ [k: string]: unknown }>, StatementDef][] = [
    [incomeQuarterly, incomeDef],
    [balanceQuarterly, BALANCE_DEF],
    [cashflowQuarterly, CASHFLOW_DEF],
  ];
  for (const [result, def] of quarterlyResults) {
    result.rows.splice(Math.max(0, opts.quarterlyPeriods));
    if (result.rows.length === 0 && result.gaps.length === 0) {
      result.gaps.push(noRowsGap(def, "quarter", opts, quarterSlotContexts.length));
    }
  }

  const currency =
    [
      incomeAnnual.rows[0],
      balanceAnnual.rows[0],
      cashflowAnnual.rows[0],
      incomeQuarterly.rows[0],
      balanceQuarterly.rows[0],
      cashflowQuarterly.rows[0],
    ].find((r) => typeof r?.reportedCurrency === "string")?.reportedCurrency ?? null;

  return {
    incomeAnnual,
    incomeQuarterly,
    balanceAnnual,
    balanceQuarterly,
    cashflowAnnual,
    cashflowQuarterly,
    shares: {
      outstanding: latestSharesOutstanding(index),
      publicFloat: latestDeiPoint(index, "EntityPublicFloat", "money"),
    },
    reportedCurrency: currency,
    filesTwentyF: state.filesTwentyF,
  };
}
