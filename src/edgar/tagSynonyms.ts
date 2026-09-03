/**
 * US-GAAP tag synonyms per statement line item.
 *
 * Every concept chain in src/edgar/statements.ts reads its tag list from this
 * table, so a taxonomy review has one place to look and one stamp to update.
 * Order matters: within a line item the first tag present for the period wins.
 *
 * Review stamp: the element names below were reviewed against the US-GAAP
 * 2025 taxonomy element list on 2026-09-02 (an offline review of names; no
 * live taxonomy fetch — the same names resolved at live issuers during the
 * 21-issuer keyless sweep of 2026-09-02). `InterestExpense` was deprecated by
 * the 2024 taxonomy in favour of `InterestExpenseNonoperating` and
 * `InterestExpenseOperating`; it stays in the chain because filers on older
 * taxonomy versions still tag it.
 *
 * Stand-ins (`standIns`) are tried only after every tag in `tags` misses, one
 * at a time, each with its own disclosure text: the cash-flow supplement's
 * `InterestPaidNet` is net of capitalized interest, `InterestPaid` is gross,
 * and the two figures differ by exactly the interest a filer capitalizes into
 * assets, so one shared sentence would misdescribe one of them.
 *
 * The module is pure data.
 */

export const TAG_SYNONYMS_TAXONOMY = "us-gaap-2025";
export const TAG_SYNONYMS_REVIEWED_ON = "2026-09-02";

export interface TagStandIn {
  tag: string;
  /** Wording recorded as a `Substitution` and in the manifest when this stand-in serves. */
  disclose: string;
}

export interface TagSynonymEntry {
  /** Tried in order; the first present for the period wins. */
  tags: readonly string[];
  /** Tried only after every `tags` entry misses, in order, each disclosed separately. */
  standIns?: readonly TagStandIn[];
}

const entry = (tags: readonly string[], standIns?: readonly TagStandIn[]): TagSynonymEntry =>
  standIns === undefined ? { tags } : { tags, standIns };

export const REVENUE_TAGS: readonly string[] = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "Revenues",
  "SalesRevenueNet",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "RevenuesNetOfInterestExpense",
];

/**
 * The pretax element that, by taxonomy definition, is measured BEFORE
 * equity-method results — its name lists what it excludes. When it serves as
 * the base of the derived EBIT, subtracting equity-method income removes money
 * that was never in the base, so the adjustment is gated on it.
 */
export const PRETAX_EXCLUDING_EQUITY_METHOD_TAG =
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments";

export const INCOME_BEFORE_TAX_TAGS: readonly string[] = [
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
  PRETAX_EXCLUDING_EQUITY_METHOD_TAG,
];

/**
 * `InterestExpenseOperating` is LAST among the income-statement tags: for a
 * bank it is the whole interest expense, but for a non-bank that tags both,
 * the non-operating figure is the borrowing cost the WACC wants.
 */
export const INTEREST_EXPENSE_TAGS: readonly string[] = [
  "InterestExpense",
  "InterestExpenseNonoperating",
  "InterestExpenseDebt",
  "InterestAndDebtExpense",
  "InterestExpenseOperating",
];

const INTEREST_STAND_IN_PREAMBLE =
  "stands in for interest expense: the filer tags its income-statement interest line only by extension; the cash figure omits accrued but unpaid interest";

export const INTEREST_EXPENSE_STAND_INS: readonly TagStandIn[] = [
  {
    tag: "InterestPaidNet",
    disclose:
      "cash interest paid net of capitalized interest (cash-flow supplement, InterestPaidNet) " +
      `${INTEREST_STAND_IN_PREAMBLE} and EXCLUDES the interest capitalized into assets, so it can run below the expense line`,
  },
  {
    tag: "InterestPaid",
    disclose:
      "cash interest paid, gross (cash-flow supplement, InterestPaid) " +
      `${INTEREST_STAND_IN_PREAMBLE} and INCLUDES the interest capitalized into assets, so it can run above the expense line`,
  },
];

/**
 * Non-operating items subtracted from the derived EBIT (pretax income +
 * interest expense) when the filer tags them.
 *
 * `componentOf` names another adjustment that already contains this one in the
 * taxonomy's income-statement calculation: `InvestmentIncomeInterest` is a
 * child of `NonoperatingIncomeExpense`, so it is subtracted on its own only
 * when the aggregate is absent.
 *
 * `notWhenBaseTag` names base tags whose OWN DEFINITION excludes this item, so
 * subtracting it would remove money the base never held. Equity-method results
 * are the case: they sit beside the aggregate at the pretax level under
 * `IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest`,
 * but the second pretax element in `INCOME_BEFORE_TAX_TAGS` is measured before
 * them. Ungated, a filer with pretax-before-equity 5,000, equity income 300 and
 * interest 200 published EBIT 4,900 instead of 5,200 — 5.8% low, into the DCF
 * and every EBIT multiple.
 */
export interface EbitNonOperatingAdjustment {
  label: string;
  tags: readonly string[];
  componentOf?: string;
  notWhenBaseTag?: readonly string[];
}

export const EBIT_NON_OPERATING_ADJUSTMENTS: readonly EbitNonOperatingAdjustment[] = [
  { label: "NonoperatingIncomeExpense", tags: ["NonoperatingIncomeExpense"] },
  { label: "InvestmentIncomeInterest", tags: ["InvestmentIncomeInterest"], componentOf: "NonoperatingIncomeExpense" },
  {
    label: "IncomeLossFromEquityMethodInvestments",
    tags: ["IncomeLossFromEquityMethodInvestments"],
    notWhenBaseTag: [PRETAX_EXCLUDING_EQUITY_METHOD_TAG],
  },
];

/**
 * The interest-expense element the taxonomy makes a CHILD of
 * `NonoperatingIncomeExpense`. When a filer tags both, "pretax + interest −
 * aggregate" adds back an interest expense the aggregate already removed and
 * overstates EBIT by exactly that interest, so the derivation is withheld
 * rather than published (see `EBIT_INTEREST_INSIDE_AGGREGATE`).
 */
export const INTEREST_INSIDE_NONOPERATING_TAG = "InterestExpenseNonoperating";

/**
 * The pair whose co-presence makes the derivation unsound, with the disclosure
 * the withheld figure carries.
 */
export const EBIT_INTEREST_INSIDE_AGGREGATE = {
  partTag: INTEREST_INSIDE_NONOPERATING_TAG,
  adjustmentTag: "NonoperatingIncomeExpense",
  disclose:
    "operating income WITHHELD rather than derived: the filer reports no OperatingIncomeLoss line, and its interest " +
    `expense is tagged ${INTEREST_INSIDE_NONOPERATING_TAG}, which the us-gaap calculation makes a component of the ` +
    "NonoperatingIncomeExpense aggregate it also filed. \"Pretax income + interest expense − the aggregate\" would " +
    "therefore add back an interest expense the aggregate has already removed and overstate EBIT by exactly that " +
    "interest, so no figure is published for this period.",
} as const;

/**
 * The caveat every derived EBIT carries when the non-operating aggregate was
 * subtracted and an interest expense was added back from a tag the taxonomy
 * does NOT place inside it. Many filers present "total other income (expense),
 * net" as a line that already contains interest expense, and nothing in
 * companyfacts says which presentation a filer used.
 */
export const EBIT_AGGREGATE_MAY_HOLD_INTEREST =
  "caveat — the NonoperatingIncomeExpense aggregate subtracted here is frequently presented as \"total other income " +
  "(expense), net\" and may ALREADY contain the interest expense added back; companyfacts carries no presentation " +
  "linkbase, so this cannot be checked, and where it does the figure overstates EBIT by that interest";

/** The current portion of long-term debt AND finance leases, as retailers tag their current installments. */
export const COMBINED_CURRENT_DEBT_TAG = "LongTermDebtAndCapitalLeaseObligationsCurrent";

/** The debt-maturity schedule's first-year principal: a note disclosure, not a balance-sheet line. */
export const MATURITIES_NEXT_YEAR_TAG = "LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths";

export const MATURITIES_STAND_IN: TagStandIn = {
  tag: MATURITIES_NEXT_YEAR_TAG,
  disclose:
    `current maturities of long-term debt from the debt maturity schedule (${MATURITIES_NEXT_YEAR_TAG}) stand in for the ` +
    "balance sheet's current portion of long-term debt: neither DebtCurrent nor LongTermDebtCurrent was filed for the period; " +
    "the figure is current maturities only (short-term borrowings and commercial paper are counted separately when tagged) and, " +
    "as a note disclosure, may be filed annually only, so quarterly rows can lack it",
};

/** The all-classes share count a per-class reporter files instead of the dei cover count. */
export const BALANCE_SHEET_SHARES_TAG = "CommonStockSharesOutstanding";

export const LINE_ITEM_TAGS = {
  // --- income statement -----------------------------------------------------
  revenue: entry(REVENUE_TAGS),
  bankRevenueTotal: entry(["Revenues", "RevenuesNetOfInterestExpense"]),
  bankRevenueComponents: entry(["InterestIncomeExpenseNet", "NoninterestIncome"]),
  costOfRevenue: entry(["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold", "CostOfServices"]),
  grossProfit: entry(["GrossProfit"]),
  researchAndDevelopmentExpenses: entry([
    "ResearchAndDevelopmentExpense",
    "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost",
  ]),
  sellingGeneralAndAdministrativeExpenses: entry(["SellingGeneralAndAdministrativeExpense"]),
  sellingAndMarketingExpenses: entry(["SellingAndMarketingExpense"]),
  generalAndAdministrativeExpenses: entry(["GeneralAndAdministrativeExpense"]),
  operatingExpenses: entry(["OperatingExpenses"]),
  operatingIncome: entry(["OperatingIncomeLoss"]),
  interestExpense: entry(INTEREST_EXPENSE_TAGS, INTEREST_EXPENSE_STAND_INS),
  interestIncome: entry([
    "InvestmentIncomeInterest",
    "InvestmentIncomeInterestAndDividend",
    "InterestAndDividendIncomeOperating",
    // The bank twin of the tag above: JPM's total interest income.
    "InterestIncomeOperating",
  ]),
  netInterestIncome: entry(["InterestIncomeExpenseNet"]),
  incomeBeforeTax: entry(INCOME_BEFORE_TAX_TAGS),
  incomeTaxExpense: entry(["IncomeTaxExpenseBenefit"]),
  totalOtherIncomeExpensesNet: entry(["NonoperatingIncomeExpense"]),
  netIncome: entry(["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"]),
  netIncomeFromContinuingOperations: entry(["IncomeLossFromContinuingOperations"]),
  netIncomeFromDiscontinuedOperations: entry(["IncomeLossFromDiscontinuedOperationsNetOfTax"]),
  depreciationAndAmortization: entry([
    "DepreciationDepletionAndAmortization",
    "DepreciationAndAmortization",
    "DepreciationAmortizationAndAccretionNet",
  ]),
  eps: entry(["EarningsPerShareBasic"]),
  epsDiluted: entry(["EarningsPerShareDiluted"]),
  weightedAverageShsOut: entry(["WeightedAverageNumberOfSharesOutstandingBasic"]),
  weightedAverageShsOutDil: entry(["WeightedAverageNumberOfDilutedSharesOutstanding"]),

  // --- balance sheet --------------------------------------------------------
  cashAndCashEquivalents: entry([
    "CashAndCashEquivalentsAtCarryingValue",
    "CashAndDueFromBanks",
    "Cash",
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
  ]),
  shortTermInvestments: entry([
    "ShortTermInvestments",
    "MarketableSecuritiesCurrent",
    "AvailableForSaleSecuritiesDebtSecuritiesCurrent",
    "InterestBearingDepositsInBanks",
  ]),
  cashAndShortTermInvestments: entry(["CashCashEquivalentsAndShortTermInvestments"]),
  netReceivables: entry(["AccountsReceivableNetCurrent", "ReceivablesNetCurrent"]),
  inventory: entry(["InventoryNet"]),
  totalCurrentAssets: entry(["AssetsCurrent"]),
  propertyPlantEquipmentNet: entry([
    "PropertyPlantAndEquipmentNet",
    "PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization",
  ]),
  goodwill: entry(["Goodwill"]),
  intangibleAssets: entry(["IntangibleAssetsNetExcludingGoodwill", "FiniteLivedIntangibleAssetsNet"]),
  totalAssets: entry(["Assets"]),
  /** The balance sheet's own total-current-debt line; a superset of every tag below. */
  debtCurrent: entry(["DebtCurrent"]),
  /** Borrowings with an initial term under a year — a different instrument from current maturities. */
  shortTermBorrowings: entry(["ShortTermBorrowings"]),
  commercialPaper: entry(["CommercialPaper"]),
  /** The current portion of long-term debt; the maturity-schedule figure stands in only when both miss. */
  currentMaturitiesOfLongTermDebt: entry(["LongTermDebtCurrent", COMBINED_CURRENT_DEBT_TAG], [MATURITIES_STAND_IN]),
  longTermDebt: entry(["LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations", "LongTermDebt"]),
  totalCurrentLiabilities: entry(["LiabilitiesCurrent"]),
  totalLiabilities: entry(["Liabilities"]),
  deferredRevenue: entry(["ContractWithCustomerLiabilityCurrent", "DeferredRevenueCurrent"]),
  taxPayables: entry(["AccruedIncomeTaxesCurrent", "TaxesPayableCurrent"]),
  operatingLeaseLiability: entry(["OperatingLeaseLiability"]),
  operatingLeaseLiabilityParts: entry(["OperatingLeaseLiabilityCurrent", "OperatingLeaseLiabilityNoncurrent"]),
  financeLeaseLiability: entry(["FinanceLeaseLiability", "CapitalLeaseObligations"]),
  financeLeaseLiabilityParts: entry(["FinanceLeaseLiabilityCurrent", "FinanceLeaseLiabilityNoncurrent"]),
  preferredStock: entry(["PreferredStockValue"]),
  commonStock: entry(["CommonStockValue"]),
  retainedEarnings: entry(["RetainedEarningsAccumulatedDeficit"]),
  accumulatedOtherComprehensiveIncomeLoss: entry(["AccumulatedOtherComprehensiveIncomeLossNetOfTax"]),
  totalStockholdersEquity: entry(["StockholdersEquity"]),
  totalEquity: entry(["StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]),
  minorityInterest: entry(["MinorityInterest"]),
  deposits: entry(["Deposits"]),
  sharesOutstandingBalanceSheet: entry([BALANCE_SHEET_SHARES_TAG]),

  // --- cash flow ------------------------------------------------------------
  cashflowNetIncome: entry(["NetIncomeLoss", "ProfitLoss"]),
  stockBasedCompensation: entry(["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"]),
  changeInWorkingCapital: entry(["IncreaseDecreaseInOperatingCapital"]),
  operatingCashFlow: entry([
    "NetCashProvidedByUsedInOperatingActivities",
    "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
  ]),
  capitalExpenditure: entry(["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"]),
  acquisitionsNet: entry(["PaymentsToAcquireBusinessesNetOfCashAcquired"]),
  debtIssuance: entry(["ProceedsFromIssuanceOfLongTermDebt"]),
  debtRepayment: entry(["RepaymentsOfLongTermDebt"]),
  commonStockIssuance: entry(["ProceedsFromIssuanceOfCommonStock"]),
  commonStockRepurchased: entry(["PaymentsForRepurchaseOfCommonStock"]),
  netDividendsPaid: entry(["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"]),
  preferredDividendsPaid: entry(["PaymentsOfDividendsPreferredStockAndPreferenceStock"]),
  incomeTaxesPaid: entry(["IncomeTaxesPaidNet", "IncomeTaxesPaid"]),
  interestPaid: entry(["InterestPaidNet", "InterestPaid"]),
  netCashProvidedByInvestingActivities: entry(["NetCashProvidedByUsedInInvestingActivities"]),
  netCashProvidedByFinancingActivities: entry(["NetCashProvidedByUsedInFinancingActivities"]),

  // --- dei cover page (the `dei` namespace, not us-gaap) ---------------------
  /** Stated once per class of registered common stock; the classes are summed. */
  deiSharesOutstanding: entry(["EntityCommonStockSharesOutstanding"]),
  /** A DOLLAR amount as of the last business day of the most recent second fiscal quarter. */
  deiPublicFloat: entry(["EntityPublicFloat"]),
} as const satisfies Record<string, TagSynonymEntry>;

export type LineItem = keyof typeof LINE_ITEM_TAGS;

/** The ordered tag list of one line item (a fresh array; callers may not mutate the table). */
export function tagsFor(item: LineItem): string[] {
  return [...LINE_ITEM_TAGS[item].tags];
}

/** The stand-ins of one line item, in order; empty when it has none. */
export function standInsFor(item: LineItem): TagStandIn[] {
  return [...(LINE_ITEM_TAGS[item].standIns ?? [])];
}
