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
 *     max(filed) with amendments winning a tie. That is `dedupFactPoints`,
 *     applied once per (tag, unit) when the index is built.
 *
 * The module is pure: no network, no clock, no environment. The companyfacts
 * JSON comes from src/providers/edgar.ts.
 */

import type { FmpBalanceSheetRow, FmpCashFlowRow, FmpIncomeStatementRow } from "@/providers/fmp";
import type { ManifestEntry } from "@/types/core";
import {
  CORE_FACT_FORMS,
  conceptFactsSchema,
  dedupFactPoints,
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

export interface BuiltStatements {
  incomeAnnual: StatementRowsResult<FmpIncomeStatementRow>;
  incomeQuarterly: StatementRowsResult<FmpIncomeStatementRow>;
  balanceAnnual: StatementRowsResult<FmpBalanceSheetRow>;
  balanceQuarterly: StatementRowsResult<FmpBalanceSheetRow>;
  cashflowAnnual: StatementRowsResult<FmpCashFlowRow>;
  cashflowQuarterly: StatementRowsResult<FmpCashFlowRow>;
  /** Latest cover-page shares outstanding and public float from `dei`. */
  shares: {
    outstanding: { value: number; asOf: string } | null;
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
 */
export type ChainSpec =
  | { kind: "first"; tags: string[]; unit: UnitKind; sign?: -1 }
  | { kind: "sum"; tags: string[]; unit: "money" }
  | { kind: "sumAny"; tags: string[]; unit: "money" }
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
  operatingExpenses: { kind: "first", tags: ["OperatingExpenses"], unit: "money" },
  operatingIncome: { kind: "first", tags: ["OperatingIncomeLoss"], unit: "money" },
  interestExpense: {
    kind: "first",
    tags: ["InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt", "InterestAndDebtExpense"],
    unit: "money",
  },
  interestIncome: {
    kind: "first",
    tags: ["InvestmentIncomeInterest", "InvestmentIncomeInterestAndDividend", "InterestAndDividendIncomeOperating"],
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
  netIncome: { kind: "first", tags: ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"], unit: "money" },
  depreciationAndAmortization: DEPRECIATION_SPEC,
  eps: { kind: "first", tags: ["EarningsPerShareBasic"], unit: "perShare" },
  epsDiluted: { kind: "first", tags: ["EarningsPerShareDiluted"], unit: "perShare" },
  weightedAverageShsOut: { kind: "first", tags: ["WeightedAverageNumberOfSharesOutstandingBasic"], unit: "shares" },
  weightedAverageShsOutDil: { kind: "first", tags: ["WeightedAverageNumberOfDilutedSharesOutstanding"], unit: "shares" },
};

const BALANCE_CHAINS: Record<string, ChainSpec> = {
  cashAndCashEquivalents: {
    kind: "first",
    tags: ["CashAndCashEquivalentsAtCarryingValue", "Cash", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
    unit: "money",
  },
  shortTermInvestments: {
    kind: "first",
    tags: ["ShortTermInvestments", "MarketableSecuritiesCurrent", "AvailableForSaleSecuritiesDebtSecuritiesCurrent"],
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
  capitalLeaseObligations: { kind: "first", tags: ["FinanceLeaseLiability", "CapitalLeaseObligations"], unit: "money" },
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
  /** Extra keys; legal via the FmpRawRow index signature. */
  investingCashFlow: { kind: "first", tags: ["NetCashProvidedByUsedInInvestingActivities"], unit: "money" },
  financingCashFlow: { kind: "first", tags: ["NetCashProvidedByUsedInFinancingActivities"], unit: "money" },
};

/** Fields whose value is a verbatim copy of another resolved field. */
const CASHFLOW_ALIASES: Record<string, string> = {
  netCashProvidedByOperatingActivities: "operatingCashFlow",
  investmentsInPropertyPlantAndEquipment: "capitalExpenditure",
  commonDividendsPaid: "netDividendsPaid",
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
  points: FactPoint[];
}
type FactIndex = Map<string, UnitPoints[]>;

function collectTags(spec: ChainSpec, into: Set<string>): void {
  if (spec.kind === "chain") {
    for (const step of spec.steps) collectTags(step, into);
    return;
  }
  if (spec.kind === "diff") {
    into.add(spec.plus);
    into.add(spec.minus);
    return;
  }
  for (const tag of spec.tags) into.add(tag);
}

/** Every us-gaap tag any chain or anchor can ask for; nothing else is parsed. */
const NEEDED_US_GAAP_TAGS: ReadonlySet<string> = (() => {
  const tags = new Set<string>(FY_ANCHOR_DURATION_TAGS);
  tags.add("Assets");
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
        const points = dedupFactPoints(parseFactPoints(rawPoints));
        if (points.length > 0) entries.push({ unit, points });
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
  unit: string;
  derivation?: Derivation;
  derivedFrom?: string[];
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

/** Merge component resolutions into one: first point/unit wins, provenance unions. */
function combine(value: number, parts: Resolved[]): Resolved {
  const head = parts[0] as Resolved;
  const derived = parts.find((p) => p.derivation !== undefined);
  const derivedFrom = [...new Set(parts.flatMap((p) => p.derivedFrom ?? []))];
  const out: Resolved = { value, point: head.point, unit: head.unit };
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
    for (const p of up.points) {
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
    for (const p of assets.points) {
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
    for (const p of assets.points) {
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
    return p === null ? null : { value: p.val, point: p, unit: up.unit };
  };
}

function instantResolver(index: FactIndex, end: string): TagResolver {
  return (tag, kind) => {
    const up = pickUnitPoints(index, tag, kind);
    if (up === null) return null;
    const p = findInstant(up.points, end);
    return p === null ? null : { value: p.val, point: p, unit: up.unit };
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
    const unit = up.unit;
    const decimals = decimalsFor(kind);

    if (!ytdOnly) {
      const threeMonth = findByDurationDays(pts, ctx.end, QUARTER_MIN_DAYS, QUARTER_MAX_DAYS);
      if (threeMonth !== null) return { value: threeMonth.val, point: threeMonth, unit };
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
            value: tidy(fy.val - ytdPrev.val, decimals),
            point: fy,
            unit,
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
        value: tidy(fy.val - sum, decimals),
        point: fy,
        unit,
        derivation: "fy-minus-quarters",
        derivedFrom: [describePoint(tag, fy), ...quarters.map((p) => describePoint(tag, p))],
      };
    }

    if (kind === "perShare" || ctx.fyStart === null) return null;
    const ytd = findDurationExact(pts, ctx.fyStart, ctx.end);
    if (ytd === null || ytd.start === undefined) return null;
    // First quarter of the fiscal year: the year-to-date fact IS the quarter.
    if (daysBetween(ctx.fyStart, ctx.end) <= QUARTER_MAX_DAYS) return { value: ytd.val, point: ytd, unit };
    if (ctx.previousEnd === null) return null;
    const prior = findDurationExact(pts, ytd.start, ctx.previousEnd);
    if (prior === null) return null;
    return {
      value: tidy(ytd.val - prior.val, decimals),
      point: ytd,
      unit,
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

function computeBalance(v: FieldValues, notes: NoteSink, ctx: string): void {
  v.cashAndShortTermInvestments ??= add(v.cashAndCashEquivalents ?? null, v.shortTermInvestments ?? null);
  v.totalEquity ??= add(v.totalStockholdersEquity ?? null, v.minorityInterest ?? null);
  v.totalLiabilities ??= sub(v.totalAssets ?? null, v.totalEquity ?? null);
  v.totalDebt ??= sumAnyValues(
    [
      ["shortTermDebt", v.shortTermDebt ?? null],
      ["longTermDebt", v.longTermDebt ?? null],
    ],
    notes,
    `totalDebt ${ctx}`,
  );
  v.netDebt ??= sub(v.totalDebt ?? null, v.cashAndCashEquivalents ?? null);
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
  compute: (v: FieldValues, notes: NoteSink, ctx: string) => void;
}

interface PeriodSlot {
  date: string;
  resolve: TagResolver;
  quarter: QuarterContext | null;
}

interface BuildState {
  filesTwentyF: boolean;
}

function fiscalYearLabel(anchor: FactPoint, slot: PeriodSlot): string {
  const form = anchor.form.trim();
  const fromAnnualFiling = anchor.fp === "FY" || form.startsWith("10-K") || form.startsWith("20-F");
  if (fromAnnualFiling && typeof anchor.fy === "number") return String(anchor.fy);
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
    def.compute(values, notes, ctxLabel);
    for (const field of def.unsourced) values[field] ??= null;

    const anchorForm = anchor.point.form.trim();
    if (anchorForm.startsWith("20-F")) state.filesTwentyF = true;

    const row: Record<string, unknown> = {
      symbol: opts.symbol,
      cik: opts.cik,
      date: slot.date,
      reportedCurrency: anchor.unit,
      fiscalYear: fiscalYearLabel(anchor.point, slot),
      period: slot.quarter === null ? "FY" : quarterLabel(anchor.point, slot.quarter),
      filingDate: anchor.point.filed,
      acceptedDate: anchor.point.filed,
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

function latestDeiPoint(index: FactIndex, tag: string, kind: UnitKind): { value: number; asOf: string } | null {
  const up = pickUnitPoints(index, `dei:${tag}`, kind);
  if (up === null) return null;
  let best: FactPoint | null = null;
  for (const p of up.points) {
    if (best === null || p.end > best.end || (p.end === best.end && p.filed > best.filed)) best = p;
  }
  return best === null ? null : { value: best.val, asOf: best.end };
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
  aliases: {},
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
      outstanding: latestDeiPoint(index, "EntityCommonStockSharesOutstanding", "shares"),
      publicFloat: latestDeiPoint(index, "EntityPublicFloat", "money"),
    },
    reportedCurrency: currency,
    filesTwentyF: state.filesTwentyF,
  };
}
