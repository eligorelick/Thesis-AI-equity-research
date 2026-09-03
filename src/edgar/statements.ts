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
 *  2. THE DUPLICATE-PERIOD RULE (see xbrl.ts): facts are filtered to the audited
 *     core forms BEFORE deduping, then grouped by period and reduced to the
 *     LAST-FILED copy — max(filed), then the amendment on a same-day tie, then
 *     the larger accession number — applied once per (tag, unit) when the index
 *     is built. That rule governs the VALUE; row LABELS come from the earliest
 *     core-form filing of the same period, because `fy`/`fp` on a later
 *     comparative describe that later FILING (see UnitPoints.reporters). When
 *     the two differ, the earliest filing's value is kept on the row as
 *     `original`, and a material line that moved by more than 1% raises a
 *     `restatement` flag (see `Restatement`).
 *
 *  3. ONE FILING LINEAGE PER DERIVATION. A derived quarter (YTD difference,
 *     FY − YTD, FY − Q1 − Q2 − Q3) subtracts the newest copy of each operand
 *     that was filed NO LATER than the minuend's own filing, so a restated FY
 *     is never netted against an unrestated YTD or vice versa. When no such
 *     copy exists the quarter is left null and the notes say why.
 *
 * Tag lists come from src/edgar/tagSynonyms.ts (stamped with the taxonomy
 * year they were reviewed against). The module is pure: no network, no clock,
 * no environment. The companyfacts JSON comes from src/providers/edgar.ts.
 */

import type { FmpBalanceSheetRow, FmpCashFlowRow, FmpIncomeStatementRow } from "@/providers/fmp";
import type { ManifestEntry } from "@/types/core";
import { discoverStockSplits, type SplitEvent, type SplitNote, type StockSplits } from "@/edgar/splits";
import {
  BALANCE_SHEET_SHARES_TAG,
  COMBINED_CURRENT_DEBT_TAG,
  EBIT_NON_OPERATING_ADJUSTMENTS,
  INCOME_BEFORE_TAX_TAGS,
  MATURITIES_NEXT_YEAR_TAG,
  REVENUE_TAGS,
  standInsFor,
  tagsFor,
  type TagStandIn,
} from "@/edgar/tagSynonyms";
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

export { BALANCE_SHEET_SHARES_TAG } from "@/edgar/tagSynonyms";

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
  /** Concepts a fallback step served instead of the concept's own tag, with the periods it served. */
  substitutions: Substitution[];
  /**
   * Material lines whose last-filed value moved by more than
   * `RESTATEMENT_THRESHOLD_PCT` of the value the period was first reported
   * with. The rows carry the same facts as `original` / `restated`; this list
   * is the statement-level flag the forensics module and the manifest read.
   */
  restatements: Restatement[];
}

/** A filing's identity, as carried on `original` values and restatement flags. */
export interface FilingRef {
  accn: string;
  filed: string;
  form: string;
}

/**
 * The value a period was FIRST reported with, kept beside the last-filed value
 * that the row carries. Present only on fields resolved directly from a fact
 * (never on a derived quarter, whose operands may each have their own).
 */
export interface OriginalValue extends FilingRef {
  value: number;
}

/** One material line that a later filing restated by more than the threshold. */
export interface Restatement {
  /** Row date (fiscal period end). */
  date: string;
  field: string;
  original: number;
  restated: number;
  /** Signed change as a percentage of the original value. */
  changePct: number;
  originalFiling: FilingRef;
  restatedFiling: FilingRef;
}

/** A material line moving by more than this share of its prior value is a restatement flag. */
export const RESTATEMENT_THRESHOLD_PCT = 1;

/** The lines whose restatement is material enough to flag, per statement. */
const MATERIAL_FIELDS: Record<StatementName, readonly string[]> = {
  income: ["revenue", "netIncome"],
  balance: ["totalAssets", "totalStockholdersEquity"],
  cashflow: ["operatingCashFlow"],
};

/**
 * One field of one statement resolved by a stand-in rather than its own tag
 * (cash interest paid for interest expense; pretax income + interest for
 * EBIT). `text` is the step's `disclose` wording; `periods` lists every row
 * date it served, newest first.
 */
export interface Substitution {
  field: string;
  text: string;
  periods: string[];
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
  /**
   * The per-class cover counts summed into `value` when the filing reported
   * `dei:EntityCommonStockSharesOutstanding` once per share class (same
   * accession, same date, distinct facts). Companyfacts drops the class
   * dimension, so the classes are unnamed; the order is as filed. Absent when
   * the count came from a single fact.
   */
  classes?: number[];
  /** The filing the count (or the summed per-class counts) came from. */
  filing?: FilingRef;
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
  /**
   * The stock splits applied to per-share and share-count facts filed before
   * them (see src/edgar/splits.ts) and one note per tagged split, applied or
   * not. The note texts are also carried on the income and balance rows' notes.
   */
  splits: { events: SplitEvent[]; notes: SplitNote[] };
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
  | { kind: "first"; tags: string[]; unit: UnitKind; sign?: -1; disclose?: string }
  | { kind: "sum"; tags: string[]; unit: "money"; disclose?: string }
  | { kind: "sumAny"; tags: string[]; unit: "money" }
  | { kind: "sumAnyOf"; parts: { label: string; spec: ChainSpec }[]; unit: "money" }
  /**
   * Every part must resolve (a derivation such as pretax income + interest
   * expense). `minusAny` lists optional subtrahends resolved afterwards: each
   * one present is subtracted, one whose `componentOf` is itself present is
   * skipped (it is already inside that aggregate), and `discloseAdjusted`
   * words the disclosure from what was and was not subtracted.
   */
  | {
      kind: "sumAll";
      parts: { label: string; spec: ChainSpec }[];
      unit: "money";
      disclose?: string;
      minusAny?: { label: string; tags: readonly string[]; componentOf?: string }[];
      discloseAdjusted?: (ctx: { subtracted: string[]; unavailable: string[]; alreadyInside: string[] }) => string;
    }
  | { kind: "diff"; plus: string; minus: string; unit: "money"; disclose?: string }
  | { kind: "chain"; steps: ChainSpec[]; unit: UnitKind };

/** One `first` step per stand-in so each tag carries its own disclosure wording. */
function standInSteps(standIns: readonly TagStandIn[], unit: UnitKind): ChainSpec[] {
  return standIns.map((s) => ({ kind: "first", tags: [s.tag], unit, disclose: s.disclose }));
}

/** A line item's own tags first, then its stand-ins one at a time. */
function lineItemChain(item: Parameters<typeof tagsFor>[0], unit: UnitKind): ChainSpec {
  const standIns = standInsFor(item);
  const own: ChainSpec = { kind: "first", tags: tagsFor(item), unit };
  return standIns.length === 0 ? own : { kind: "chain", unit, steps: [own, ...standInSteps(standIns, unit)] };
}

/**
 * `disclose` marks a fallback step whose figure is a stand-in for the concept,
 * not the concept's own tag. When such a step resolves, its wording is recorded
 * as a `Substitution` on the statement (the keyless layer files it in the
 * manifest) and appended to the progress notes.
 */

const REVENUE_SPEC: ChainSpec = { kind: "first", tags: [...REVENUE_TAGS], unit: "money" };

/**
 * `InterestExpenseOperating` is LAST among the income-statement tags: for a
 * bank it is the whole interest expense (JPM FY2025 97.9B, and it files none
 * of the four tags before it, so the chain resolved nothing and the keyless
 * WACC raised a critical gap the FMP path never shows), but for a non-bank
 * that tags both, the non-operating figure is the borrowing cost the WACC
 * wants.
 *
 * Caterpillar and GE tag their income-statement interest line only by
 * extension (cat:..., ge:...), which the us-gaap namespace of companyfacts
 * never carries, yet both file the cash-flow supplement's cash interest paid.
 * That is the last resort, and the two cash tags are SEPARATE steps because
 * they are different figures: `InterestPaidNet` is net of interest
 * capitalized into assets, `InterestPaid` is gross of it. Each carries its own
 * disclosure wording (tagSynonyms.ts).
 */
const INTEREST_EXPENSE_SPEC: ChainSpec = lineItemChain("interestExpense", "money");

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
    { kind: "first", tags: tagsFor("bankRevenueTotal"), unit: "money" },
    { kind: "sum", tags: tagsFor("bankRevenueComponents"), unit: "money" },
    { kind: "first", tags: [...REVENUE_TAGS], unit: "money" },
  ],
};

/**
 * A bank's interest expense is its cost of funds, so "pretax income + interest
 * expense" is no EBIT there (JPMorgan FY2025: 72B pretax against 97.9B of
 * interest expense). On a bank-tagged filer operating income is the filed
 * line or nothing; the derivation below is for industrial filers only.
 */
const BANK_OPERATING_INCOME_SPEC: ChainSpec = { kind: "first", tags: tagsFor("operatingIncome"), unit: "money" };

const DEPRECIATION_SPEC: ChainSpec = { kind: "first", tags: tagsFor("depreciationAndAmortization"), unit: "money" };

const INCOME_CHAINS: Record<string, ChainSpec> = {
  revenue: REVENUE_SPEC,
  costOfRevenue: lineItemChain("costOfRevenue", "money"),
  grossProfit: lineItemChain("grossProfit", "money"),
  researchAndDevelopmentExpenses: lineItemChain("researchAndDevelopmentExpenses", "money"),
  sellingGeneralAndAdministrativeExpenses: {
    kind: "chain",
    unit: "money",
    steps: [
      lineItemChain("sellingGeneralAndAdministrativeExpenses", "money"),
      { kind: "sum", tags: [...tagsFor("sellingAndMarketingExpenses"), ...tagsFor("generalAndAdministrativeExpenses")], unit: "money" },
    ],
  },
  /** The two SG&A components FMP also publishes on their own; Stage B's forensics read both. */
  sellingAndMarketingExpenses: lineItemChain("sellingAndMarketingExpenses", "money"),
  generalAndAdministrativeExpenses: lineItemChain("generalAndAdministrativeExpenses", "money"),
  operatingExpenses: lineItemChain("operatingExpenses", "money"),
  /**
   * Pfizer files no OperatingIncomeLoss line at all (its statement runs from
   * revenue straight to income before taxes); GE Aerospace neither. Without an
   * EBIT the DCF was "not buildable". Pretax income + interest expense is the
   * textbook EBIT for a firm that reports none.
   *
   * Pretax income also contains the OTHER non-operating items, so the
   * derivation subtracts each one the filer tags — the `NonoperatingIncomeExpense`
   * aggregate, `InvestmentIncomeInterest` when that aggregate is absent (the
   * taxonomy makes it a component of it, so subtracting both would double-count),
   * and equity-method results. Whatever could not be subtracted is named in the
   * disclosure as the error band on the figure.
   */
  operatingIncome: {
    kind: "chain",
    unit: "money",
    steps: [
      { kind: "first", tags: tagsFor("operatingIncome"), unit: "money" },
      {
        kind: "sumAll",
        unit: "money",
        parts: [
          { label: "pretax income", spec: { kind: "first", tags: [...INCOME_BEFORE_TAX_TAGS], unit: "money" } },
          { label: "interest expense", spec: INTEREST_EXPENSE_SPEC },
        ],
        minusAny: EBIT_NON_OPERATING_ADJUSTMENTS.map((a) => ({
          label: a.label,
          tags: a.tags,
          ...(a.componentOf === undefined ? {} : { componentOf: a.componentOf }),
        })),
        discloseAdjusted: describeDerivedEbit,
      },
    ],
  },
  interestExpense: INTEREST_EXPENSE_SPEC,
  interestIncome: lineItemChain("interestIncome", "money"),
  netInterestIncome: lineItemChain("netInterestIncome", "money"),
  incomeBeforeTax: { kind: "first", tags: [...INCOME_BEFORE_TAX_TAGS], unit: "money" },
  incomeTaxExpense: lineItemChain("incomeTaxExpense", "money"),
  totalOtherIncomeExpensesNet: lineItemChain("totalOtherIncomeExpensesNet", "money"),
  netIncome: lineItemChain("netIncome", "money"),
  netIncomeFromContinuingOperations: lineItemChain("netIncomeFromContinuingOperations", "money"),
  netIncomeFromDiscontinuedOperations: lineItemChain("netIncomeFromDiscontinuedOperations", "money"),
  depreciationAndAmortization: DEPRECIATION_SPEC,
  eps: lineItemChain("eps", "perShare"),
  epsDiluted: lineItemChain("epsDiluted", "perShare"),
  weightedAverageShsOut: lineItemChain("weightedAverageShsOut", "shares"),
  weightedAverageShsOutDil: lineItemChain("weightedAverageShsOutDil", "shares"),
};

/**
 * The derived-EBIT disclosure, worded from what the subtraction pass could and
 * could not remove. An adjustment the filer did not tag is an error band on the
 * figure, so it is named rather than passed over in silence.
 */
function describeDerivedEbit(ctx: { subtracted: string[]; unavailable: string[]; alreadyInside: string[] }): string {
  const head =
    "EBIT derived as pretax income + interest expense: the filer reports no OperatingIncomeLoss line";
  const parts: string[] = [];
  if (ctx.subtracted.length > 0) {
    parts.push(`non-operating items subtracted from the derivation: ${ctx.subtracted.join(", ")}`);
  }
  if (ctx.alreadyInside.length > 0) {
    parts.push(
      `not subtracted separately because the aggregate already contains them: ${ctx.alreadyInside.join(", ")}`,
    );
  }
  if (ctx.unavailable.length > 0) {
    parts.push(
      `error band — the filer tags none of ${ctx.unavailable.join(", ")} for this period, so any such item stays inside the figure`,
    );
  } else if (ctx.subtracted.length === 0) {
    parts.push("no non-operating tag was filed for this period, so any such item stays inside the figure");
  }
  return `${head}; ${parts.join("; ")}`;
}

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
          { kind: "first", tags: tagsFor("operatingLeaseLiability"), unit: "money" },
          { kind: "sumAny", tags: tagsFor("operatingLeaseLiabilityParts"), unit: "money" },
        ],
      },
    },
    {
      label: "financeLeaseLiability",
      spec: {
        kind: "chain",
        unit: "money",
        steps: [
          { kind: "first", tags: tagsFor("financeLeaseLiability"), unit: "money" },
          { kind: "sumAny", tags: tagsFor("financeLeaseLiabilityParts"), unit: "money" },
        ],
      },
    },
  ],
};

/**
 * The current portion of long-term debt AND finance leases, as Home Depot and
 * other retailers tag their current installments. `resolveDebtOverlaps` keeps
 * its finance-lease slice from being counted twice.
 */
const COMBINED_CURRENT_TAG = COMBINED_CURRENT_DEBT_TAG;

/**
 * Borrowings with an initial term under a year. A DIFFERENT INSTRUMENT from the
 * current maturities of long-term debt below, which is why the two are separate
 * components of one sum rather than alternatives in a first-wins chain.
 */
const SHORT_TERM_BORROWING_TAGS = [...tagsFor("shortTermBorrowings"), ...tagsFor("commercialPaper")];

/** The balance-sheet lines that carry the current maturities of long-term debt. */
const CURRENT_MATURITY_BALANCE_TAGS = [...tagsFor("currentMaturitiesOfLongTermDebt")];

/** The tags that specifically carry the CURRENT MATURITIES of long-term debt. */
const CURRENT_MATURITY_TAGS: readonly string[] = [...tagsFor("debtCurrent"), ...tagsFor("currentMaturitiesOfLongTermDebt")];

const MATURITIES_STAND_IN_SPEC = standInSteps(standInsFor("currentMaturitiesOfLongTermDebt"), "money");

const BALANCE_CHAINS: Record<string, ChainSpec> = {
  /**
   * Bank tagging (JPM): `CashAndCashEquivalentsAtCarryingValue` goes stale — its
   * last point is 2018 — while `CashAndDueFromBanks` carries the operating cash.
   * The restricted-cash catch-all stays last: at a bank it equals cash + the
   * interest-bearing deposits that `shortTermInvestments` below claims, so
   * letting it win here would double-count them in cashAndShortTermInvestments.
   */
  cashAndCashEquivalents: lineItemChain("cashAndCashEquivalents", "money"),
  shortTermInvestments: lineItemChain("shortTermInvestments", "money"),
  cashAndShortTermInvestments: lineItemChain("cashAndShortTermInvestments", "money"),
  netReceivables: lineItemChain("netReceivables", "money"),
  inventory: lineItemChain("inventory", "money"),
  totalCurrentAssets: lineItemChain("totalCurrentAssets", "money"),
  propertyPlantEquipmentNet: lineItemChain("propertyPlantEquipmentNet", "money"),
  goodwill: lineItemChain("goodwill", "money"),
  intangibleAssets: lineItemChain("intangibleAssets", "money"),
  totalAssets: lineItemChain("totalAssets", "money"),
  /**
   * D-13 order: the filed total (`DebtCurrent`) first; then the sum of the
   * balance-sheet current-debt lines the filer did tag.
   *
   * That sum has TWO components, because short-term borrowings and the current
   * maturities of long-term debt are different instruments and a filer can tag
   * one without the other. The maturity schedule's next-twelve-months principal
   * is the stand-in for the CURRENT-MATURITIES COMPONENT ALONE — a note
   * disclosure rather than a balance-sheet line, disclosed as a stand-in on
   * every row it serves. Making it a step of the whole chain (as this did
   * before) meant a filer that tagged `ShortTermBorrowings` while tagging its
   * current maturities only by extension lost the current maturities entirely:
   * Caterpillar FY2024 published short-term debt 5,514 against a filed 12,634,
   * understating total debt by 7.12B. `resolveDebtOverlaps` case 5 still nets
   * the schedule figure out whenever a balance-sheet current-maturities tag
   * did resolve, so it is never counted twice.
   */
  shortTermDebt: {
    kind: "chain",
    unit: "money",
    steps: [
      { kind: "first", tags: tagsFor("debtCurrent"), unit: "money" },
      {
        kind: "sumAnyOf",
        unit: "money",
        parts: [
          {
            label: "short-term borrowings",
            spec: { kind: "sumAny", tags: SHORT_TERM_BORROWING_TAGS, unit: "money" },
          },
          {
            label: "current maturities of long-term debt",
            spec: {
              kind: "chain",
              unit: "money",
              steps: [
                { kind: "sumAny", tags: CURRENT_MATURITY_BALANCE_TAGS, unit: "money" },
                ...MATURITIES_STAND_IN_SPEC,
              ],
            },
          },
        ],
      },
    ],
  },
  longTermDebt: lineItemChain("longTermDebt", "money"),
  totalCurrentLiabilities: lineItemChain("totalCurrentLiabilities", "money"),
  totalLiabilities: lineItemChain("totalLiabilities", "money"),
  deferredRevenue: lineItemChain("deferredRevenue", "money"),
  taxPayables: lineItemChain("taxPayables", "money"),
  capitalLeaseObligations: LEASE_LIABILITY_SPEC,
  preferredStock: lineItemChain("preferredStock", "money"),
  commonStock: lineItemChain("commonStock", "money"),
  retainedEarnings: lineItemChain("retainedEarnings", "money"),
  accumulatedOtherComprehensiveIncomeLoss: lineItemChain("accumulatedOtherComprehensiveIncomeLoss", "money"),
  /**
   * Caterpillar tags no StockholdersEquity line — only the total including
   * noncontrolling interest — so invested capital, the DCF and the multiples
   * EV bridge were all suppressed. Parent equity is that total less the
   * noncontrolling interest when the filer tags one (exact), else the total
   * itself stands in (disclosed; the noncontrolling slice is usually small).
   */
  totalStockholdersEquity: {
    kind: "chain",
    unit: "money",
    steps: [
      { kind: "first", tags: tagsFor("totalStockholdersEquity"), unit: "money" },
      {
        kind: "diff",
        plus: tagsFor("totalEquity")[0] as string,
        minus: tagsFor("minorityInterest")[0] as string,
        unit: "money",
        disclose:
          "stockholders' equity derived as total equity including noncontrolling interest minus the noncontrolling interest: the filer tags no StockholdersEquity line",
      },
      {
        kind: "first",
        tags: tagsFor("totalEquity"),
        unit: "money",
        disclose:
          "total equity including noncontrolling interest stands in for stockholders' equity: the filer tags neither a StockholdersEquity line nor a MinorityInterest to net out",
      },
    ],
  },
  minorityInterest: lineItemChain("minorityInterest", "money"),
  totalEquity: lineItemChain("totalEquity", "money"),
  /** Extra key (banks); legal via the FmpRawRow index signature. */
  deposits: lineItemChain("deposits", "money"),
};

const CASHFLOW_CHAINS: Record<string, ChainSpec> = {
  netIncome: lineItemChain("cashflowNetIncome", "money"),
  depreciationAndAmortization: DEPRECIATION_SPEC,
  stockBasedCompensation: lineItemChain("stockBasedCompensation", "money"),
  changeInWorkingCapital: { kind: "first", tags: tagsFor("changeInWorkingCapital"), unit: "money", sign: -1 },
  operatingCashFlow: lineItemChain("operatingCashFlow", "money"),
  capitalExpenditure: { kind: "first", tags: tagsFor("capitalExpenditure"), unit: "money", sign: -1 },
  acquisitionsNet: { kind: "first", tags: tagsFor("acquisitionsNet"), unit: "money", sign: -1 },
  netDebtIssuance: {
    kind: "diff",
    plus: tagsFor("debtIssuance")[0] as string,
    minus: tagsFor("debtRepayment")[0] as string,
    unit: "money",
  },
  netStockIssuance: {
    kind: "diff",
    plus: tagsFor("commonStockIssuance")[0] as string,
    minus: tagsFor("commonStockRepurchased")[0] as string,
    unit: "money",
  },
  commonStockIssuance: lineItemChain("commonStockIssuance", "money"),
  commonStockRepurchased: { kind: "first", tags: tagsFor("commonStockRepurchased"), unit: "money", sign: -1 },
  netDividendsPaid: { kind: "first", tags: tagsFor("netDividendsPaid"), unit: "money", sign: -1 },
  preferredDividendsPaid: { kind: "first", tags: tagsFor("preferredDividendsPaid"), unit: "money", sign: -1 },
  incomeTaxesPaid: lineItemChain("incomeTaxesPaid", "money"),
  interestPaid: lineItemChain("interestPaid", "money"),
  /**
   * FMP's own names for the two remaining cash-flow subtotals. Stage B's
   * forensics accruals ratio reads `netCashProvidedByInvestingActivities`
   * literally, so emitting only the short `investingCashFlow` key left the
   * ratio unresolvable on the keyless path.
   */
  netCashProvidedByInvestingActivities: lineItemChain("netCashProvidedByInvestingActivities", "money"),
  netCashProvidedByFinancingActivities: lineItemChain("netCashProvidedByFinancingActivities", "money"),
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
const FY_ANCHOR_DURATION_TAGS = [...REVENUE_TAGS, ...tagsFor("cashflowNetIncome")];

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
  /**
   * EVERY core-form copy of this (tag, unit), deduped by nothing: a derived
   * quarter needs the copy of its subtrahend that belongs to the SAME filing
   * lineage as its minuend, which the max(filed) winner is not when only one of
   * the two was restated (see `lineagePoints`).
   */
  all: FactPoint[];
}
type FactIndex = Map<string, UnitPoints[]>;

/**
 * The copies of one concept visible to a filing made on `filedCutoff`: every
 * core copy filed no later than that, reduced to one per period by the same
 * last-filed rule. Subtracting a YTD fact restated AFTER the annual fact it is
 * netted against would mix two lineages and produce a quarter neither filing
 * ever reported.
 */
function lineagePoints(up: UnitPoints, filedCutoff: string): FactPoint[] {
  return dedupByPeriod(up.all.filter((p) => p.filed <= filedCutoff));
}

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
  if (spec.kind === "sumAnyOf" || spec.kind === "sumAll") {
    for (const part of spec.parts) collectTags(part.spec, into);
    // An optional subtrahend is only ever resolved by tag, so its tags have to
    // be parsed into the index like any other.
    if (spec.kind === "sumAll") {
      for (const adjustment of spec.minusAny ?? []) for (const tag of adjustment.tags) into.add(tag);
    }
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
  // Not in any chain: the share-count fallback below reads it directly.
  tags.add(BALANCE_SHEET_SHARES_TAG);
  for (const table of [INCOME_CHAINS, BALANCE_CHAINS, CASHFLOW_CHAINS]) {
    for (const spec of Object.values(table)) collectTags(spec, tags);
  }
  collectTags(BANK_REVENUE_SPEC, tags);
  return tags;
})();

/** Cover-page share count; stated once per class of registered common stock. */
const DEI_SHARES_TAG = tagsFor("deiSharesOutstanding")[0] as string;
const DEI_PUBLIC_FLOAT_TAG = tagsFor("deiPublicFloat")[0] as string;
const NEEDED_DEI_TAGS = new Set([DEI_SHARES_TAG, DEI_PUBLIC_FLOAT_TAG]);

function unitMatches(unit: string, kind: UnitKind): boolean {
  if (kind === "money") return /^[A-Z]{3}$/.test(unit);
  if (kind === "perShare") return unit.endsWith("/shares");
  return unit === "shares";
}

/**
 * Carry every per-share and share-count point filed before a stock split to
 * the current share basis (see src/edgar/splits.ts). Applied to each point by
 * its OWN filing date, before the max(filed) dedup, so a period restated in a
 * post-split filing is scaled once (by 1) and a period only ever filed
 * pre-split is scaled by the splits since. Money facts are untouched.
 */
function toCurrentShareBasis(points: FactPoint[], unit: string, splits: StockSplits): FactPoint[] {
  if (splits.events.length === 0) return points;
  const perShare = unitMatches(unit, "perShare");
  const shares = unitMatches(unit, "shares");
  if (!perShare && !shares) return points;
  return points.map((p) => {
    const factor = splits.factorFor(p.filed);
    if (factor === 1 || !Number.isFinite(p.val)) return p;
    const val = perShare ? tidy(p.val / factor, PER_SHARE_DECIMALS) : Math.round(p.val * factor);
    return { ...p, val };
  });
}

/**
 * Parse -> split adjustment -> core-form filter -> per-period max(filed), once
 * per (tag, unit). Unit entries are ordered USD-first then alphabetically so a
 * filer reporting in two currencies resolves deterministically.
 */
function buildFactIndex(facts: CompanyFacts, splits: StockSplits): FactIndex {
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
        const core = filterToCoreForms(toCurrentShareBasis(parseFactPoints(rawPoints), unit, splits));
        const points = dedupByPeriod(core);
        if (points.length > 0) entries.push({ unit, points, reporters: buildReporters(core), all: core });
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
  /**
   * The value the period was FIRST reported with, when a later filing changed
   * it. Set only for a value read straight from one fact: for a sum or a
   * derived quarter each operand has its own history and a single "original"
   * would be an invention.
   */
  original?: OriginalValue;
}

function filingRef(p: FactPoint): FilingRef {
  return { accn: p.accn, filed: p.filed, form: p.form.trim() };
}

/**
 * Value and period from `point`; labels from the filing that first reported
 * that period. When that first filing reported a DIFFERENT number, it is kept
 * as `original` so the row can show what was superseded.
 */
function resolvedPoint(tag: string, up: UnitPoints, point: FactPoint, value: number): Resolved {
  const reporter = reporterFor(up, point);
  const out: Resolved = { value, point, reporter, unit: up.unit, tags: [tag] };
  if (reporter.accn !== point.accn && reporter.val !== point.val && value === point.val) {
    out.original = { value: reporter.val, ...filingRef(reporter) };
  }
  return out;
}

type TagResolver = (tag: string, kind: UnitKind) => Resolved | null;

interface NoteSink {
  readonly notes: string[];
  readonly substitutions: Substitution[];
  add(note: string): void;
  /** Record that `field` at row `period` was served by a stand-in described by `text`. */
  substitute(field: string, period: string, text: string): void;
}

function createNoteSink(): NoteSink {
  const seen = new Set<string>();
  const notes: string[] = [];
  const substitutions: Substitution[] = [];
  return {
    notes,
    substitutions,
    add(note: string): void {
      if (seen.has(note)) return;
      seen.add(note);
      notes.push(note);
    },
    substitute(field: string, period: string, text: string): void {
      const existing = substitutions.find((s) => s.field === field && s.text === text);
      if (existing === undefined) substitutions.push({ field, text, periods: [period] });
      else if (!existing.periods.includes(period)) existing.periods.push(period);
    },
  };
}

/** The row a resolution is for; carried through `chain` steps so a `disclose` lands on the right field. */
interface ResolveAt {
  field: string;
  period: string;
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

function resolveSpec(spec: ChainSpec, resolve: TagResolver, notes: NoteSink, label: string, at?: ResolveAt): Resolved | null {
  const disclosed = (r: Resolved | null): Resolved | null => {
    if (r === null || !("disclose" in spec) || spec.disclose === undefined) return r;
    notes.add(`${label}: ${spec.disclose}`);
    // A stand-in inside a composite (the interest term of a derived EBIT) is
    // the composite's business to disclose; the field it belongs to discloses
    // its own resolution separately.
    if (at !== undefined) notes.substitute(at.field, at.period, spec.disclose);
    return r;
  };
  switch (spec.kind) {
    case "chain": {
      for (const step of spec.steps) {
        const r = resolveSpec(step, resolve, notes, label, at);
        if (r !== null) return r;
      }
      return null;
    }
    case "first": {
      for (const tag of spec.tags) {
        const r = resolve(tag, spec.unit);
        if (r === null) continue;
        if (spec.sign === undefined) return disclosed(r);
        const decimals = spec.unit === "perShare" ? PER_SHARE_DECIMALS : MONEY_DECIMALS;
        return disclosed({ ...r, value: tidy(r.value * spec.sign, decimals) });
      }
      return null;
    }
    case "sum": {
      const { present } = resolveComponents(spec.tags, spec.unit, resolve);
      if (present.length !== spec.tags.length) return null;
      const total = present.reduce((s, p) => s + p.r.value, 0);
      return disclosed(combine(tidy(total, MONEY_DECIMALS), present.map((p) => p.r)));
    }
    case "sumAll": {
      const present: Resolved[] = [];
      for (const part of spec.parts) {
        const r = resolveSpec(part.spec, resolve, notes, `${label} (${part.label})`);
        if (r === null || (present.length > 0 && present[0]!.unit !== r.unit)) return null;
        present.push(r);
      }
      let total = present.reduce((s, r) => s + r.value, 0);
      // Optional subtrahends: each one the filer tagged for this period is
      // removed, one whose parent aggregate also resolved is skipped (the
      // taxonomy already counts it inside that aggregate), and everything that
      // could not be resolved is named as the error band on the result.
      const subtracted: string[] = [];
      const unavailable: string[] = [];
      const alreadyInside: string[] = [];
      if (spec.minusAny !== undefined) {
        const resolvedByLabel = new Map<string, Resolved>();
        for (const adjustment of spec.minusAny) {
          const hit = adjustment.tags
            .map((tag) => resolve(tag, spec.unit))
            .find((r): r is Resolved => r !== null && r.unit === present[0]!.unit);
          if (hit !== undefined) resolvedByLabel.set(adjustment.label, hit);
        }
        for (const adjustment of spec.minusAny) {
          const hit = resolvedByLabel.get(adjustment.label);
          if (hit === undefined) {
            unavailable.push(adjustment.label);
            continue;
          }
          if (adjustment.componentOf !== undefined && resolvedByLabel.has(adjustment.componentOf)) {
            alreadyInside.push(adjustment.label);
            continue;
          }
          total -= hit.value;
          subtracted.push(adjustment.label);
          present.push(hit);
        }
      }
      const combined = combine(tidy(total, MONEY_DECIMALS), present);
      if (spec.discloseAdjusted !== undefined) {
        const text = spec.discloseAdjusted({ subtracted, unavailable, alreadyInside });
        notes.add(`${label}: ${text}`);
        if (at !== undefined) notes.substitute(at.field, at.period, text);
        return combined;
      }
      return disclosed(combined);
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
      // `at` travels INTO the parts: unlike `sumAll` (whose composite words its
      // own disclosure), a `sumAnyOf` part that resolved through a stand-in is
      // a stand-in for a slice of this very field, so it is that field's
      // substitution — the debt-maturity schedule standing in for the current
      // maturities of long-term debt is the case.
      const present: { label: string; r: Resolved }[] = [];
      const absent: string[] = [];
      for (const part of spec.parts) {
        const r = resolveSpec(part.spec, resolve, notes, `${label} (${part.label})`, at);
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
      return disclosed(combine(tidy(plus.value - minus.value, MONEY_DECIMALS), [plus, minus]));
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

/** The three 3-month points preceding an FY end, all required, from one filing lineage. */
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
function quarterResolver(
  index: FactIndex,
  ctx: QuarterContext,
  quarterEnds: string[],
  ytdOnly: boolean,
  notes: NoteSink,
): TagResolver {
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

    /** Every operand of a difference comes from the minuend's own filing lineage. */
    const lineage = (minuend: FactPoint): FactPoint[] => lineagePoints(up, minuend.filed);
    const refuse = (minuend: FactPoint, what: string): null => {
      notes.add(
        `${tag} ${ctx.end}: ${what} not derived — no ${
          ctx.isFiscalYearEnd ? "year-to-date" : "prior year-to-date"
        } fact filed on or before the ${minuend.form.trim()} of ${minuend.filed} (accession ${minuend.accn}) that reported the minuend, so the difference would mix two filing lineages`,
      );
      return null;
    };

    if (ctx.isFiscalYearEnd) {
      const fy =
        (ctx.fyStart !== null ? findDurationExact(pts, ctx.fyStart, ctx.end) : null) ?? findAnnualDuration(pts, ctx.end);
      if (fy === null || fy.start === undefined) return null;
      const sameLineage = lineage(fy);
      if (ctx.previousEnd !== null) {
        const ytdPrev = findDurationExact(sameLineage, fy.start, ctx.previousEnd);
        if (ytdPrev !== null) {
          return {
            ...resolvedPoint(tag, up, fy, tidy(fy.val - ytdPrev.val, decimals)),
            derivation: "fy-minus-ytd",
            derivedFrom: [describePoint(tag, fy), describePoint(tag, ytdPrev)],
          };
        }
        // A year-to-date fact exists but only in a filing made AFTER the annual
        // one this row's value came from: that is the case the lineage rule is
        // for, and it is disclosed rather than silently mixed.
        if (findDurationExact(pts, fy.start, ctx.previousEnd) !== null) return refuse(fy, "FY − YTD");
      }
      if (kind === "perShare") return null;
      const quarters = precedingQuarterPoints(sameLineage, ctx, quarterEnds);
      if (quarters === null) {
        return precedingQuarterPoints(pts, ctx, quarterEnds) === null
          ? null
          : refuse(fy, "FY − (Q1+Q2+Q3)");
      }
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
    const prior = findDurationExact(lineage(ytd), ytd.start, ctx.previousEnd);
    if (prior === null) {
      return findDurationExact(pts, ytd.start, ctx.previousEnd) === null ? null : refuse(ytd, "YTD difference");
    }
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

  // Case 4a: the combined current tag is a superset of `LongTermDebtCurrent`,
  // so beside it the combined figure is dropped.
  const combinedCurrent = shortTermTags.includes(COMBINED_CURRENT_TAG) ? cc.money(COMBINED_CURRENT_TAG) : null;
  const combinedCurrentStands = combinedCurrent !== null && !shortTermTags.includes("LongTermDebtCurrent");
  if (combinedCurrent !== null && !combinedCurrentStands && v.shortTermDebt != null) {
    v.shortTermDebt = tidy(v.shortTermDebt - combinedCurrent, MONEY_DECIMALS);
    notes.add(
      `shortTermDebt ${ctx}: ${COMBINED_CURRENT_TAG} excluded — it contains LongTermDebtCurrent, which also resolved for this period`,
    );
  }

  // Case 5: the maturity schedule's first year is the current portion of
  // long-term debt. It stands in for THAT COMPONENT of the sum only, so it is
  // reached whenever no balance-sheet current-maturities tag resolved — beside
  // short-term borrowings as readily as alone. When such a tag DID resolve the
  // schedule figure never entered the sum, and it is named anyway, because a
  // reader has to see the figure the filer disclosed either way.
  const maturitiesStand = shortTermTags.includes(MATURITIES_NEXT_YEAR_TAG);
  const maturities = cc.money(MATURITIES_NEXT_YEAR_TAG);
  if (maturitiesStand) {
    notes.add(
      `shortTermDebt ${ctx}: current maturities taken from the debt maturity schedule (${MATURITIES_NEXT_YEAR_TAG} ${maturities}) — no balance-sheet current-maturities tag was filed for the period; the figure is CURRENT MATURITIES ONLY (any short-term borrowings and commercial paper the filer tagged are added beside it) and, being a note disclosure rather than a balance-sheet line, is often filed annually only, so quarterly rows can lack it`,
    );
  } else if (maturities !== null) {
    const currentMaturityTagResolved = CURRENT_MATURITY_TAGS.some((tag) => shortTermTags.includes(tag));
    notes.add(
      currentMaturityTagResolved
        ? `shortTermDebt ${ctx}: ${MATURITIES_NEXT_YEAR_TAG} excluded — the balance sheet's own current-debt tag resolved for this period and already carries the current maturities`
        : `shortTermDebt ${ctx}: the debt maturity schedule reports ${maturities} of long-term debt due within a year (${MATURITIES_NEXT_YEAR_TAG}) and it did NOT enter the sum — it could not be combined with the tags that did resolve (${shortTermTags.length === 0 ? "none" : shortTermTags.join(" + ")}), which happens when the schedule is filed in another currency, so short-term debt here may exclude the current maturities of long-term debt`,
    );
  }

  const longTermTags = tagsOf("longTermDebt");
  // Case 2.
  if (longTermTags.includes("LongTermDebt") && v.longTermDebt != null) {
    const current = cc.money("LongTermDebtCurrent") ?? (maturitiesStand ? maturities : null);
    if (current !== null) {
      v.longTermDebt = tidy(v.longTermDebt - current, MONEY_DECIMALS);
      notes.add(
        `longTermDebt ${ctx}: LongTermDebt less current maturities (${cc.money("LongTermDebtCurrent") !== null ? "LongTermDebtCurrent" : MATURITIES_NEXT_YEAR_TAG} ${current})`,
      );
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
  // Case 4b: the combined current tag stands in `shortTermDebt` and carries the
  // current finance leases, which `capitalLeaseObligations` also holds. (When
  // case 1 fired above, the finance leases sit in the two debt tags exactly
  // once and nothing is netted.)
  if (combinedCurrentStands && full !== null) {
    const financeCurrent = cc.money("FinanceLeaseLiabilityCurrent");
    if (financeCurrent !== null) {
      notes.add(
        `totalDebt ${ctx}: shortTermDebt includes ${COMBINED_CURRENT_TAG}, whose finance-lease slice (FinanceLeaseLiabilityCurrent ${financeCurrent}) is also inside capitalLeaseObligations, so it is netted out of the lease component here; capitalLeaseObligations still reports the full ${full}`,
      );
      return {
        label: "capitalLeaseObligations (less the finance-lease current portion already in shortTermDebt)",
        value: tidy(full - financeCurrent, MONEY_DECIMALS),
      };
    }
    notes.add(
      `totalDebt ${ctx}: shortTermDebt includes ${COMBINED_CURRENT_TAG} and no FinanceLeaseLiabilityCurrent fact was filed, so its finance-lease slice may be counted twice`,
    );
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
  const restatements: Restatement[] = [];
  const fieldNames = [...Object.keys(def.chains), ...Object.keys(def.aliases), ...def.computed, ...def.unsourced];
  const material = new Set(MATERIAL_FIELDS[def.statement]);

  for (const slot of slots) {
    const ctxLabel = slot.date;
    const values: FieldValues = {};
    const resolutions = new Map<string, Resolved>();
    for (const [field, spec] of Object.entries(def.chains)) {
      const r = resolveSpec(spec, slot.resolve, notes, `${field} ${ctxLabel}`, { field, period: slot.date });
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

    // The superseded figure of every field a later filing changed, kept beside
    // the value the row carries; a MATERIAL line that moved by more than
    // RESTATEMENT_THRESHOLD_PCT of its first-reported value also raises a
    // statement-level `restatement` flag the forensics module can read.
    const original: Record<string, OriginalValue> = {};
    const rowFlags: Restatement[] = [];
    for (const [field, resolved] of resolutions) {
      const prior = resolved.original;
      if (prior === undefined) continue;
      original[field] = prior;
      if (!material.has(field)) continue;
      const changePct = prior.value === 0 ? Number.POSITIVE_INFINITY : ((resolved.value - prior.value) / Math.abs(prior.value)) * 100;
      if (!(Math.abs(changePct) > RESTATEMENT_THRESHOLD_PCT)) continue;
      rowFlags.push({
        date: slot.date,
        field,
        original: prior.value,
        restated: resolved.value,
        changePct: Number.isFinite(changePct) ? tidy(changePct, 4) : changePct,
        originalFiling: { accn: prior.accn, filed: prior.filed, form: prior.form },
        restatedFiling: filingRef(resolved.point),
      });
    }
    if (Object.keys(original).length > 0) row.original = original;
    if (rowFlags.length > 0) {
      row.restatement = rowFlags;
      restatements.push(...rowFlags);
      for (const flag of rowFlags) {
        notes.add(
          `${def.statement} ${ctxLabel}: ${flag.field} restated from ${flag.original} (${flag.originalFiling.form} ${flag.originalFiling.filed}) to ${flag.restated} (${flag.restatedFiling.form} ${flag.restatedFiling.filed}), ${
            Number.isFinite(flag.changePct) ? `${flag.changePct > 0 ? "+" : ""}${flag.changePct.toFixed(2)}%` : "from zero"
          } — the row carries the last-filed value and the superseded one as \`original\``,
        );
      }
    }

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
  return { rows, notes: notes.notes, gaps, substitutions: notes.substitutions, restatements };
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
  const cover = latestCoverShareCount(index);
  if (cover !== null) return cover;
  const balanceSheet = latestPoint(index, BALANCE_SHEET_SHARES_TAG, "shares", true);
  return balanceSheet === null
    ? null
    : { ...balanceSheet, basis: "balance sheet CommonStockSharesOutstanding" };
}

/**
 * The newest cover-page share count, SUMMED across share classes.
 *
 * `dei:EntityCommonStockSharesOutstanding` is stated once per class of
 * registered common stock, so a multi-class issuer's cover page produces
 * several facts with the same period end and the same accession — one per
 * class. Companyfacts drops the class dimension, so they are indistinguishable
 * except by value, and the period dedup (one fact per period) kept exactly one
 * of them: the market cap of a three-class issuer was the market cap of
 * whichever class sorted first. Facts of one filing and one date are therefore
 * summed, and the per-class breakdown is carried for disclosure.
 *
 * Byte-identical repeats of a fact (the same value in the same filing for the
 * same date) are a companyfacts artifact, not a second class, and are counted
 * once.
 */
function latestCoverShareCount(index: FactIndex): SharesOutstandingPoint | null {
  const up = pickUnitPoints(index, `dei:${DEI_SHARES_TAG}`, "shares");
  if (up === null) return null;
  let best: FactPoint | null = null;
  for (const p of up.all) {
    if (best === null || p.end > best.end || (p.end === best.end && (p.filed > best.filed || (p.filed === best.filed && p.accn > best.accn)))) {
      best = p;
    }
  }
  if (best === null) return null;
  const winner = best;
  const seen = new Set<string>();
  const classes: number[] = [];
  for (const p of up.all) {
    if (p.end !== winner.end || p.accn !== winner.accn || p.filed !== winner.filed) continue;
    const key = `${p.val}|${p.form.trim()}|${p.start ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    classes.push(p.val);
  }
  const value = classes.reduce((s, v) => s + v, 0);
  const point: SharesOutstandingPoint = {
    value: classes.length === 0 ? winner.val : value,
    asOf: winner.end,
    basis: "dei cover page",
    filing: filingRef(winner),
  };
  if (classes.length > 1) point.classes = classes;
  return point;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const INCOME_DEF = (bankRevenue: boolean): StatementDef => ({
  statement: "income",
  chains: bankRevenue
    ? { ...INCOME_CHAINS, revenue: BANK_REVENUE_SPEC, operatingIncome: BANK_OPERATING_INCOME_SPEC }
    : INCOME_CHAINS,
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
  const splits = discoverStockSplits(facts);
  const index = buildFactIndex(facts, splits);
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
  const quarterSlots = (ytdOnly: boolean, notes: NoteSink): PeriodSlot[] =>
    quarterSlotContexts.map((ctx) => ({
      date: ctx.end,
      resolve: quarterResolver(index, ctx, quarterEnds, ytdOnly, notes),
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
  // The split notes ride with the rows that carry share-basis figures: EPS and
  // weighted shares on the income rows, CommonStockSharesOutstanding on the
  // balance rows.
  const balanceAnnualNotes = createNoteSink();
  const balanceQuarterlyNotes = createNoteSink();
  for (const note of splits.notes) {
    incomeAnnualNotes.add(note.text);
    incomeQuarterlyNotes.add(note.text);
    balanceAnnualNotes.add(note.text);
    balanceQuarterlyNotes.add(note.text);
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
    quarterSlots(false, incomeQuarterlyNotes),
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
    balanceAnnualNotes,
  );
  const balanceQuarterly = buildStatementRows<FmpBalanceSheetRow>(
    BALANCE_DEF,
    balanceQuarterSlots(),
    "quarter",
    opts,
    state,
    balanceQuarterlyNotes,
  );
  const cashflowAnnual = buildStatementRows<FmpCashFlowRow>(
    CASHFLOW_DEF,
    annualSlots((fy) => annualResolver(index, fy)),
    "annual",
    opts,
    state,
    createNoteSink(),
  );
  const cashflowQuarterlyNotes = createNoteSink();
  const cashflowQuarterly = buildStatementRows<FmpCashFlowRow>(
    CASHFLOW_DEF,
    quarterSlots(true, cashflowQuarterlyNotes),
    "quarter",
    opts,
    state,
    cashflowQuarterlyNotes,
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
    // A substitution only counts for the rows that survive the trim.
    const kept = new Set(result.rows.map((row) => String(row.date)));
    for (const sub of result.substitutions) sub.periods = sub.periods.filter((p) => kept.has(p));
    result.substitutions = result.substitutions.filter((sub) => sub.periods.length > 0);
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
      publicFloat: latestDeiPoint(index, DEI_PUBLIC_FLOAT_TAG, "money"),
    },
    reportedCurrency: currency,
    filesTwentyF: state.filesTwentyF,
    splits: { events: splits.events, notes: splits.notes },
  };
}
