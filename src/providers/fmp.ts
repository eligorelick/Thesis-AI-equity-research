/**
 * Typed FMP (Financial Modeling Prep) client — server-only.
 *
 * Conventions per the provider data contract §1.1 + §2 (load-bearing quirks):
 *  - Base:   https://financialmodelingprep.com/stable/<endpoint>
 *  - Auth:   `apikey` HEADER (keeps the key out of logged URLs)
 *  - Shape:  success = JSON array; error = JSON object with key `"Error Message"`
 *            (space included). Any non-array body carrying "Error Message" is an
 *            error REGARDLESS of HTTP status (401-before-routing: bogus paths
 *            401 identically to real ones, so status alone proves nothing).
 *  - Retry:  429/5xx only (handled by fetchWithPolicy); 401/402/403 are
 *            deterministic auth/plan errors → returned as data gaps, no retry.
 *  - EOD:    historical-price-eod/full serves max ~5 years per request →
 *            automatic 5-year from/to chunking loop.
 *
 * FIXTURE MODE: with no FMP_API_KEY configured, each method loads wholly
 * synthetic contract fixtures from fixtures/fmp/<method>/<SYMBOL>.json
 * (falling back to <method>/default.json) and returns them wrapped in Sourced
 * with endpoint annotated "[FIXTURE]" and stale:true. Missing fixture →
 * FetchResult gap "no API key + no fixture". Fixtures are never current data.
 *
 * CACHING: pass `cachedFetch` (from @/cache/apiCache) in the config; every live
 * response flows through it with TTLs per DATA_MAP §3 (see FMP_TTLS). Without
 * it the client fetches directly (uncached) — fixture mode never caches.
 */

import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FetchResult, ManifestEntry, Sourced } from "@/types/core";
import { fetchWithPolicy, HttpTransportError, type FetchPolicy, type TokenBucketLimiter } from "@/providers/http";

// ---------------------------------------------------------------------------
// Cache contract (implemented by @/cache/apiCache — injected to keep this
// module dependency-light and testable before the cache module lands)
// ---------------------------------------------------------------------------

export interface CachedFetchResult<T> {
  value: T;
  /** true when served past TTL (stale-while-revalidate) */
  stale?: boolean;
  /** Specific preservation condition surfaced by the durable cache. */
  staleReason?: "empty-refresh-preserved";
  /** ISO timestamp of the original fetch that produced `value` */
  fetchedAt?: string;
}

export type CachedFetchFn = <T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
) => Promise<CachedFetchResult<T>>;

// ---------------------------------------------------------------------------
// Row types — minimal fields the pipeline needs; every row keeps all raw
// fields via the index signature (and FmpPayload.raw keeps the whole body).
// Numbers can be missing/null; FMP emits 0 for "not disclosed" (DATA_MAP §1.1).
// ---------------------------------------------------------------------------

export interface FmpRawRow {
  [key: string]: unknown;
}

export interface FmpProfileRow extends FmpRawRow {
  symbol?: string;
  companyName?: string;
  price?: number;
  marketCap?: number;
  beta?: number;
  sector?: string | null;
  industry?: string | null;
  country?: string | null;
  currency?: string | null;
  cik?: string | null;
  exchange?: string;
  exchangeFullName?: string;
  ipoDate?: string | null;
  /** string per docs sample — do not assume number */
  fullTimeEmployees?: string | null;
  isEtf?: boolean;
  isAdr?: boolean;
  isFund?: boolean;
  isActivelyTrading?: boolean;
  description?: string;
  ceo?: string | null;
  website?: string | null;
}

export interface FmpQuoteRow extends FmpRawRow {
  symbol?: string;
  name?: string;
  price?: number;
  change?: number;
  /** quote uses changePercentage (movers use changesPercentage, EOD changePercent) */
  changePercentage?: number;
  volume?: number;
  dayLow?: number;
  dayHigh?: number;
  yearHigh?: number;
  yearLow?: number;
  marketCap?: number;
  priceAvg50?: number;
  priceAvg200?: number;
  exchange?: string;
  open?: number;
  previousClose?: number;
  /** unix SECONDS (aftermarket endpoints use ms) */
  timestamp?: number;
}

export interface FmpStatementRow extends FmpRawRow {
  date?: string;
  symbol?: string;
  reportedCurrency?: string | null;
  cik?: string | null;
  filingDate?: string;
  acceptedDate?: string;
  fiscalYear?: string;
  period?: string;
}

export interface FmpIncomeStatementRow extends FmpStatementRow {
  revenue?: number;
  costOfRevenue?: number;
  grossProfit?: number;
  researchAndDevelopmentExpenses?: number;
  sellingGeneralAndAdministrativeExpenses?: number;
  operatingExpenses?: number;
  operatingIncome?: number;
  ebitda?: number;
  ebit?: number;
  netInterestIncome?: number;
  interestIncome?: number;
  interestExpense?: number;
  depreciationAndAmortization?: number;
  incomeBeforeTax?: number;
  incomeTaxExpense?: number;
  netIncome?: number;
  bottomLineNetIncome?: number;
  eps?: number;
  epsDiluted?: number;
  weightedAverageShsOut?: number;
  weightedAverageShsOutDil?: number;
}

export interface FmpBalanceSheetRow extends FmpStatementRow {
  cashAndCashEquivalents?: number;
  shortTermInvestments?: number;
  cashAndShortTermInvestments?: number;
  netReceivables?: number;
  inventory?: number;
  totalCurrentAssets?: number;
  propertyPlantEquipmentNet?: number;
  goodwill?: number;
  intangibleAssets?: number;
  totalAssets?: number;
  shortTermDebt?: number;
  longTermDebt?: number;
  totalCurrentLiabilities?: number;
  totalLiabilities?: number;
  deferredRevenue?: number;
  capitalLeaseObligations?: number;
  treasuryStock?: number;
  preferredStock?: number;
  commonStock?: number;
  retainedEarnings?: number;
  accumulatedOtherComprehensiveIncomeLoss?: number;
  totalStockholdersEquity?: number;
  totalEquity?: number;
  minorityInterest?: number;
  totalInvestments?: number;
  totalDebt?: number;
  netDebt?: number;
}

export interface FmpCashFlowRow extends FmpStatementRow {
  netIncome?: number;
  depreciationAndAmortization?: number;
  stockBasedCompensation?: number;
  changeInWorkingCapital?: number;
  netCashProvidedByOperatingActivities?: number;
  investmentsInPropertyPlantAndEquipment?: number;
  acquisitionsNet?: number;
  netDebtIssuance?: number;
  netStockIssuance?: number;
  /** NEGATIVE = outflow */
  commonStockRepurchased?: number;
  /** NEGATIVE = outflow */
  netDividendsPaid?: number;
  commonDividendsPaid?: number;
  preferredDividendsPaid?: number;
  operatingCashFlow?: number;
  /** NEGATIVE by convention: freeCashFlow = operatingCashFlow + capitalExpenditure */
  capitalExpenditure?: number;
  freeCashFlow?: number;
  incomeTaxesPaid?: number;
  interestPaid?: number;
}

export interface FmpKeyMetricsRow extends FmpStatementRow {
  marketCap?: number;
  enterpriseValue?: number;
  evToSales?: number;
  evToEBITDA?: number;
  netDebtToEBITDA?: number;
  currentRatio?: number;
  incomeQuality?: number;
  workingCapital?: number;
  returnOnEquity?: number;
  returnOnInvestedCapital?: number;
  returnOnAssets?: number;
  earningsYield?: number;
  freeCashFlowYield?: number;
  capexToRevenue?: number;
  /** FMP's misspelling is the real field name */
  researchAndDevelopementToRevenue?: number;
  daysOfSalesOutstanding?: number;
  daysOfPayablesOutstanding?: number;
  daysOfInventoryOutstanding?: number;
  cashConversionCycle?: number;
  grahamNumber?: number;
}

export interface FmpRatiosRow extends FmpStatementRow {
  grossProfitMargin?: number;
  ebitdaMargin?: number;
  operatingProfitMargin?: number;
  netProfitMargin?: number;
  priceToEarningsRatio?: number;
  priceToBookRatio?: number;
  priceToSalesRatio?: number;
  priceToFreeCashFlowRatio?: number;
  debtToEquityRatio?: number;
  debtToAssetsRatio?: number;
  /** 0 can be an artifact of interestExpense=0 (undisclosed) — treat as n/a */
  interestCoverageRatio?: number;
  dividendYield?: number;
  dividendPayoutRatio?: number;
  revenuePerShare?: number;
  bookValuePerShare?: number;
  tangibleBookValuePerShare?: number;
  effectiveTaxRate?: number;
}

export interface FmpFinancialGrowthRow extends FmpStatementRow {
  revenueGrowth?: number;
  grossProfitGrowth?: number;
  /** sic — lowercase "growth", real field names */
  ebitgrowth?: number;
  epsgrowth?: number;
  epsdilutedGrowth?: number;
  netIncomeGrowth?: number;
  operatingCashFlowGrowth?: number;
  freeCashFlowGrowth?: number;
  assetGrowth?: number;
  debtGrowth?: number;
  weightedAverageSharesDilutedGrowth?: number;
  /** sic — "bookValueperShareGrowth" */
  bookValueperShareGrowth?: number;
  /** TOTAL growth over the window, NOT annualized (FMP FAQ) */
  threeYRevenueGrowthPerShare?: number;
  fiveYRevenueGrowthPerShare?: number;
  tenYRevenueGrowthPerShare?: number;
}

export interface FmpFinancialScoresRow extends FmpRawRow {
  symbol?: string;
  reportedCurrency?: string | null;
  altmanZScore?: number;
  /** integer 0–9 */
  piotroskiScore?: number;
  workingCapital?: number;
  totalAssets?: number;
  retainedEarnings?: number;
  ebit?: number;
  marketCap?: number;
  totalLiabilities?: number;
  revenue?: number;
}

export interface FmpEnterpriseValuesRow extends FmpRawRow {
  symbol?: string;
  date?: string;
  stockPrice?: number;
  numberOfShares?: number;
  marketCapitalization?: number;
  /** positive number that FMP subtracts */
  minusCashAndCashEquivalents?: number;
  addTotalDebt?: number;
  enterpriseValue?: number;
}

export interface FmpAnalystEstimatesRow extends FmpRawRow {
  symbol?: string;
  /** fiscal-period end date */
  date?: string;
  revenueLow?: number;
  revenueHigh?: number;
  revenueAvg?: number;
  ebitdaLow?: number;
  ebitdaHigh?: number;
  ebitdaAvg?: number;
  ebitLow?: number;
  ebitHigh?: number;
  ebitAvg?: number;
  netIncomeLow?: number;
  netIncomeHigh?: number;
  netIncomeAvg?: number;
  sgaExpenseLow?: number;
  sgaExpenseHigh?: number;
  sgaExpenseAvg?: number;
  epsLow?: number;
  epsHigh?: number;
  epsAvg?: number;
  numAnalystsRevenue?: number;
  numAnalystsEps?: number;
}

export interface FmpPriceTargetSummaryRow extends FmpRawRow {
  symbol?: string;
  lastMonthCount?: number;
  lastMonthAvgPriceTarget?: number;
  lastQuarterCount?: number;
  lastQuarterAvgPriceTarget?: number;
  lastYearCount?: number;
  lastYearAvgPriceTarget?: number;
  allTimeCount?: number;
  allTimeAvgPriceTarget?: number;
  /** JSON-stringified array INSIDE a string — needs a second JSON.parse */
  publishers?: string;
}

export interface FmpPriceTargetConsensusRow extends FmpRawRow {
  symbol?: string;
  targetHigh?: number;
  targetLow?: number;
  targetConsensus?: number;
  targetMedian?: number;
}

export interface FmpGradesConsensusRow extends FmpRawRow {
  symbol?: string;
  strongBuy?: number;
  buy?: number;
  hold?: number;
  sell?: number;
  strongSell?: number;
  consensus?: string;
}

export interface FmpEarningsRow extends FmpRawRow {
  symbol?: string;
  date?: string;
  /** null on future (not-yet-reported) rows */
  epsActual?: number | null;
  epsEstimated?: number | null;
  revenueActual?: number | null;
  revenueEstimated?: number | null;
  lastUpdated?: string;
}

export interface FmpTranscriptDateRow extends FmpRawRow {
  quarter?: number;
  fiscalYear?: number;
  date?: string;
}

export interface FmpTranscriptRow extends FmpRawRow {
  symbol?: string;
  /** "Q3" — request param is quarter=3 but response uses period */
  period?: string;
  year?: number;
  date?: string;
  /** full speaker-labeled text; can be multi-100KB */
  content?: string;
}

export interface FmpInsiderTradeRow extends FmpRawRow {
  symbol?: string;
  filingDate?: string;
  transactionDate?: string;
  reportingCik?: string;
  companyCik?: string;
  /** e.g. "P-Purchase", "S-Sale" */
  transactionType?: string;
  securitiesOwned?: number;
  reportingName?: string;
  typeOfOwner?: string;
  /** "A" | "D" */
  acquisitionOrDisposition?: string;
  formType?: string;
  securitiesTransacted?: number;
  price?: number;
  securityName?: string;
  url?: string;
}

export interface FmpInsiderTradeStatisticsRow extends FmpRawRow {
  symbol?: string;
  cik?: string;
  year?: number;
  quarter?: number;
  /** A/D counts include awards/grants; P/S = open-market */
  acquiredTransactions?: number;
  disposedTransactions?: number;
  acquiredDisposedRatio?: number;
  totalAcquired?: number;
  totalDisposed?: number;
  totalPurchases?: number;
  totalSales?: number;
}

export interface FmpInstitutionalHolderRow extends FmpRawRow {
  date?: string;
  cik?: string;
  investorName?: string;
  symbol?: string;
  sharesNumber?: number;
  changeInSharesNumber?: number;
  changeInSharesNumberPercentage?: number;
  marketValue?: number;
  weight?: number;
  /** % of shares outstanding held by this holder */
  ownership?: number;
  avgPricePaid?: number;
  isNew?: boolean;
  isSoldOut?: boolean;
  holdingPeriod?: number;
  firstAdded?: string;
  performance?: number;
}

export interface FmpPositionsSummaryRow extends FmpRawRow {
  symbol?: string;
  date?: string;
  investorsHolding?: number;
  investorsHoldingChange?: number;
  numberOf13Fshares?: number;
  totalInvested?: number;
  ownershipPercent?: number;
  newPositions?: number;
  increasedPositions?: number;
  reducedPositions?: number;
  closedPositions?: number;
  totalCalls?: number;
  totalPuts?: number;
  putCallRatio?: number;
}

export interface FmpOwnershipDatesRow extends FmpRawRow {
  date?: string;
  year?: number;
  quarter?: number;
}

export interface FmpStockPeerRow extends FmpRawRow {
  symbol?: string;
  companyName?: string;
  price?: number;
  mktCap?: number;
}

export interface FmpSegmentationRow extends FmpRawRow {
  symbol?: string;
  fiscalYear?: number;
  period?: string;
  reportedCurrency?: string | null;
  date?: string;
  /** free-text as-reported segment names → values; keys drift year-to-year */
  data?: Record<string, number>;
}

export interface FmpKeyExecutiveRow extends FmpRawRow {
  title?: string;
  name?: string;
  pay?: number | null;
  currencyPay?: string | null;
  yearBorn?: number | null;
  titleSince?: string | null;
  active?: boolean | null;
}

export interface FmpExecutiveCompensationRow extends FmpRawRow {
  cik?: string;
  symbol?: string;
  companyName?: string;
  filingDate?: string;
  acceptedDate?: string;
  /** combined "Name — Title" string */
  nameAndPosition?: string;
  year?: number;
  salary?: number;
  bonus?: number;
  stockAward?: number;
  optionAward?: number;
  incentivePlanCompensation?: number;
  allOtherCompensation?: number;
  total?: number;
  link?: string;
}

export interface FmpMarketCapRow extends FmpRawRow {
  symbol?: string;
  date?: string;
  marketCap?: number;
}

export interface FmpSharesFloatRow extends FmpRawRow {
  symbol?: string;
  /** datetime string, not plain date */
  date?: string;
  /** PERCENT free float, e.g. 99.83 */
  freeFloat?: number;
  floatShares?: number;
  outstandingShares?: number;
  /** SEC filing URL */
  source?: string | null;
}

export interface FmpSecFilingRow extends FmpRawRow {
  symbol?: string;
  cik?: string;
  /** datetime string */
  filingDate?: string;
  acceptedDate?: string;
  formType?: string;
  link?: string;
  finalLink?: string;
}

export interface FmpNewsArticleRow extends FmpRawRow {
  symbol?: string | null;
  publishedDate?: string;
  publisher?: string;
  title?: string;
  image?: string | null;
  site?: string;
  /** snippet, not full body */
  text?: string;
  url?: string;
}

export interface FmpEodBarRow extends FmpRawRow {
  symbol?: string;
  date?: string;
  open?: number;
  high?: number;
  low?: number;
  /** split-adjusted ONLY (dividend-adjusted variant is a separate endpoint) */
  close?: number;
  volume?: number;
  change?: number;
  /** EOD uses changePercent (quote uses changePercentage) */
  changePercent?: number;
  vwap?: number;
}

export interface FmpSectorPeRow extends FmpRawRow {
  date?: string;
  sector?: string;
  exchange?: string;
  pe?: number;
}

export interface FmpIndustryPeRow extends FmpRawRow {
  date?: string;
  industry?: string;
  exchange?: string;
  pe?: number;
}

export interface FmpSectorPerformanceRow extends FmpRawRow {
  date?: string;
  sector?: string;
  exchange?: string;
  /** units PLV — likely percent */
  averageChange?: number;
}

export interface FmpTreasuryRatesRow extends FmpRawRow {
  date?: string;
  month1?: number;
  month2?: number;
  month3?: number;
  month6?: number;
  year1?: number;
  year2?: number;
  year3?: number;
  year5?: number;
  year7?: number;
  year10?: number;
  year20?: number;
  year30?: number;
}

export interface FmpEconomicIndicatorRow extends FmpRawRow {
  name?: string;
  date?: string;
  value?: number;
}

export interface FmpMarketRiskPremiumRow extends FmpRawRow {
  country?: string;
  continent?: string | null;
  countryRiskPremium?: number;
  /** percent; NO as-of date in the response (DATA_MAP §2.5) */
  totalEquityRiskPremium?: number;
}

export interface FmpDcfRow extends FmpRawRow {
  symbol?: string;
  date?: string;
  dcf?: number;
  /** the real field name has a space: "Stock Price" */
  "Stock Price"?: number;
}

export interface FmpSectorNameRow extends FmpRawRow {
  sector?: string;
}

export interface FmpIndustryNameRow extends FmpRawRow {
  industry?: string;
}

/** Every method returns the typed rows plus the verbatim parsed body. */
export interface FmpPayload<TRow extends FmpRawRow = FmpRawRow> {
  rows: TRow[];
  raw: unknown;
}

export type FmpResult<TRow extends FmpRawRow = FmpRawRow> = Promise<FetchResult<FmpPayload<TRow>>>;

/** Statement-family period selector (DATA_MAP §1.1 fiscal conventions). */
export type FmpPeriod = "Q1" | "Q2" | "Q3" | "Q4" | "FY" | "annual" | "quarter";

// ---------------------------------------------------------------------------
// TTLs per DATA_MAP §3 (ms)
// ---------------------------------------------------------------------------

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** "immutable"/frozen-day-1 classes — effectively forever */
const FOREVER = 3650 * DAY;

export const FMP_TTLS = {
  profile: DAY,
  quote: 15 * MIN,
  batchQuote: 15 * MIN,
  incomeStatement: DAY,
  balanceSheet: DAY,
  cashFlow: DAY,
  keyMetrics: DAY,
  keyMetricsTtm: DAY,
  ratios: DAY,
  ratiosTtm: DAY,
  financialGrowth: DAY,
  financialScores: DAY,
  enterpriseValues: DAY,
  analystEstimates: DAY,
  priceTargetSummary: DAY,
  priceTargetConsensus: DAY,
  gradesConsensus: DAY,
  earnings: DAY,
  earningsCalendar: DAY,
  transcriptDates: DAY,
  transcript: FOREVER,
  insiderTradingSearch: DAY,
  insiderTradeStatistics: DAY,
  institutionalHolderAnalytics: DAY,
  symbolPositionsSummary: DAY,
  institutionalOwnershipDates: DAY,
  stockPeers: DAY,
  revenueProductSegmentation: DAY,
  revenueGeographicSegmentation: DAY,
  keyExecutives: 7 * DAY,
  executiveCompensation: 7 * DAY,
  marketCap: 15 * MIN,
  historicalMarketCap: DAY,
  sharesFloat: DAY,
  secFilingsSearch: 6 * HOUR,
  stockNews: 6 * HOUR,
  pressReleases: 6 * HOUR,
  historicalPriceEodFull: DAY,
  sectorPeSnapshot: HOUR,
  industryPeSnapshot: HOUR,
  sectorPerformanceSnapshot: HOUR,
  treasuryRates: 2 * HOUR,
  economicIndicators: 4 * HOUR,
  marketRiskPremium: 7 * DAY,
  dcf: DAY,
  leveredDcf: DAY,
  availableIndustries: FOREVER,
  availableSectors: FOREVER,
} as const satisfies Record<string, number>;

export type FmpMethodName = keyof typeof FMP_TTLS;

const coerceVendorNumber = (value: unknown): unknown => {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "string" && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) {
    return Number(value);
  }
  return value;
};
const numericVendorField = z.preprocess(coerceVendorNumber, z.number().finite().optional());
const requiredNumericVendorField = z.preprocess(coerceVendorNumber, z.number().finite());

function numericFields(names: readonly string[]): z.ZodRawShape {
  return Object.fromEntries(names.map((name) => [name, numericVendorField]));
}

const datedRowShape = { date: z.iso.date() };
const statementIdentityShape = {
  ...datedRowShape,
  symbol: z.string().trim().min(1).optional(),
  reportedCurrency: z.string().trim().min(1).nullish(),
  fiscalYear: z.union([z.string(), z.number()]).optional(),
  period: z.string().trim().min(1).optional(),
};

const CRITICAL_FMP_ROW_SCHEMAS: Partial<Record<FmpMethodName, z.ZodType<unknown>>> = {
  profile: z.object({
    symbol: z.string().trim().min(1),
    ...numericFields(["price", "marketCap", "beta"]),
  }).passthrough(),
  quote: z.object({
    symbol: z.string().trim().min(1),
    ...numericFields([
      "price", "change", "changePercentage", "volume", "dayLow", "dayHigh", "yearHigh",
      "yearLow", "marketCap", "priceAvg50", "priceAvg200", "open", "previousClose", "timestamp",
    ]),
  }).passthrough(),
  incomeStatement: z.object({
    ...statementIdentityShape,
    ...numericFields([
      "revenue", "costOfRevenue", "grossProfit", "researchAndDevelopmentExpenses",
      "sellingGeneralAndAdministrativeExpenses", "operatingExpenses", "operatingIncome", "ebitda",
      "ebit", "netInterestIncome", "interestIncome", "interestExpense", "depreciationAndAmortization",
      "incomeBeforeTax", "incomeTaxExpense", "netIncome", "bottomLineNetIncome", "eps", "epsDiluted",
      "weightedAverageShsOut", "weightedAverageShsOutDil",
    ]),
  }).passthrough(),
  balanceSheet: z.object({
    ...statementIdentityShape,
    ...numericFields([
      "cashAndCashEquivalents", "shortTermInvestments", "cashAndShortTermInvestments", "accountsReceivables",
      "netReceivables", "inventory", "totalCurrentAssets", "propertyPlantEquipmentNet", "goodwill",
      "intangibleAssets", "totalAssets", "shortTermDebt", "longTermDebt", "totalCurrentLiabilities",
      "totalLiabilities", "deferredRevenue", "capitalLeaseObligations", "treasuryStock", "preferredStock",
      "commonStock", "retainedEarnings", "accumulatedOtherComprehensiveIncomeLoss",
      "totalStockholdersEquity", "totalEquity", "minorityInterest", "totalInvestments", "totalDebt", "netDebt",
    ]),
  }).passthrough(),
  cashFlow: z.object({
    ...statementIdentityShape,
    ...numericFields([
      "netIncome", "depreciationAndAmortization", "stockBasedCompensation", "changeInWorkingCapital",
      "netCashProvidedByOperatingActivities", "investmentsInPropertyPlantAndEquipment", "acquisitionsNet",
      "netDebtIssuance", "netStockIssuance", "commonStockRepurchased", "netDividendsPaid",
      "commonDividendsPaid", "preferredDividendsPaid", "operatingCashFlow", "capitalExpenditure",
      "freeCashFlow", "incomeTaxesPaid", "interestPaid",
    ]),
  }).passthrough(),
  analystEstimates: z.object({
    ...datedRowShape,
    symbol: z.string().trim().min(1).optional(),
    ...numericFields([
      "revenueLow", "revenueHigh", "revenueAvg", "ebitdaLow", "ebitdaHigh", "ebitdaAvg",
      "ebitLow", "ebitHigh", "ebitAvg", "netIncomeLow", "netIncomeHigh", "netIncomeAvg",
      "sgaExpenseLow", "sgaExpenseHigh", "sgaExpenseAvg", "epsLow", "epsHigh", "epsAvg",
      "numAnalystsRevenue", "numAnalystsEps",
    ]),
  }).passthrough(),
  enterpriseValues: z.object({
    ...datedRowShape,
    symbol: z.string().trim().min(1).optional(),
    ...numericFields([
      "stockPrice", "numberOfShares", "marketCapitalization", "minusCashAndCashEquivalents",
      "addTotalDebt", "enterpriseValue",
    ]),
  }).passthrough(),
  treasuryRates: z.object({
    ...datedRowShape,
    ...numericFields(["month1", "month2", "month3", "month6", "year1", "year2", "year3", "year5", "year7", "year10", "year20", "year30"]),
  }).passthrough(),
  marketRiskPremium: z.object({
    country: z.string().trim().min(1),
    countryRiskPremium: numericVendorField,
    totalEquityRiskPremium: requiredNumericVendorField,
  }).passthrough(),
  historicalPriceEodFull: z.object({
    ...datedRowShape,
    symbol: z.string().trim().min(1).optional(),
    ...numericFields(["open", "high", "low", "close", "volume", "change", "changePercent", "vwap"]),
  }).passthrough(),
};

function validateCriticalRows<TRow extends FmpRawRow>(
  method: FmpMethodName,
  rows: readonly Record<string, unknown>[],
): { ok: true; rows: TRow[] } | { ok: false; reason: string } {
  const schema = CRITICAL_FMP_ROW_SCHEMAS[method];
  if (schema === undefined) return { ok: true, rows: rows as TRow[] };
  const parsed: TRow[] = [];
  for (const [index, row] of rows.entries()) {
    const result = schema.safeParse(row);
    if (!result.success) {
      const issue = result.error.issues[0];
      const path = issue?.path.length ? issue.path.join(".") : "row";
      return {
        ok: false,
        reason: `FMP provider schema drift in ${method} row ${index} at ${path}: ${issue?.message ?? "invalid row"}`,
      };
    }
    parsed.push(result.data as TRow);
  }
  return { ok: true, rows: parsed };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * FMP error detection: any non-array object carrying an "Error Message" key is
 * an error regardless of HTTP status (401-before-routing, DATA_MAP §1.1).
 */
export function isFmpErrorBody(body: unknown): body is { "Error Message": string } {
  return (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    "Error Message" in body
  );
}

export function fmpErrorMessage(body: unknown): string {
  if (isFmpErrorBody(body)) {
    const msg = (body as Record<string, unknown>)["Error Message"];
    return typeof msg === "string" ? msg : JSON.stringify(msg);
  }
  return "unknown FMP error";
}

/**
 * Exact gap reason for an FMP 200-with-empty-array response. Consumers key
 * benign-empty handling off this string (EOD chunk classification here;
 * expected-structural-gap marking in dataBundle) — keep it in one place.
 */
export const FMP_EMPTY_ARRAY_REASON = "FMP returned an empty array (no data for this query)";

export type FmpParams = Record<string, string | number | boolean | undefined>;

/**
 * Auth-carrying param names that must NEVER appear in a query string, cache key,
 * or provenance annotation. FMP uses header auth; no stable endpoint takes a
 * param by these names, so stripping them is purely defensive (audit
 * 2026-07-11 #8) — a future change that accidentally threads the key through
 * params cannot leak it into the persisted api_cache or the report appendix.
 */
const FMP_AUTH_PARAM_NAMES: ReadonlySet<string> = new Set(["apikey", "api_key", "token"]);

/** Canonical query string: sorted keys, undefined dropped, NO apikey (header auth). */
export function fmpQueryString(params: FmpParams): string {
  const entries = Object.entries(params)
    .filter((e): e is [string, string | number | boolean] => e[1] !== undefined)
    .filter(([k]) => !FMP_AUTH_PARAM_NAMES.has(k.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
}

/** Stable cache key for an FMP call (param-order independent; never contains the key). */
export function fmpCacheKey(endpoint: string, params: FmpParams): string {
  const qs = fmpQueryString(params);
  return qs ? `fmp:/stable/${endpoint}?${qs}` : `fmp:/stable/${endpoint}`;
}

export interface DateChunk {
  from: string;
  to: string;
}

const MAX_EOD_YEARS = 5;

/**
 * Split [from, to] (inclusive, YYYY-MM-DD) into consecutive chunks of at most
 * `maxYears` years each — FMP EOD serves max ~5 years per request (DATA_MAP §1.1).
 */
export function chunkDateRange(from: string, to: string, maxYears: number = MAX_EOD_YEARS): DateChunk[] {
  const fromDate = parseIsoDate(from);
  const toDate = parseIsoDate(to);
  if (fromDate.getTime() > toDate.getTime()) {
    throw new Error(`chunkDateRange: from (${from}) is after to (${to})`);
  }
  if (!(maxYears > 0)) throw new Error(`chunkDateRange: maxYears must be > 0 (got ${maxYears})`);

  const chunks: DateChunk[] = [];
  let cursor = fromDate;
  while (cursor.getTime() <= toDate.getTime()) {
    const chunkEndExclusive = addUtcYears(cursor, maxYears);
    const chunkEnd = new Date(Math.min(chunkEndExclusive.getTime() - DAY, toDate.getTime()));
    chunks.push({ from: toIsoDate(cursor), to: toIsoDate(chunkEnd) });
    cursor = new Date(chunkEnd.getTime() + DAY);
  }
  return chunks;
}

function parseIsoDate(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw new Error(`invalid ISO date: "${value}" (expected YYYY-MM-DD)`);
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(date.getTime())) throw new Error(`invalid ISO date: "${value}"`);
  return date;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addUtcYears(date: Date, years: number): Date {
  const d = new Date(date.getTime());
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d;
}

/**
 * Derive an asOf date from response rows (fiscal date / quote timestamp), else
 * fallback. Clamped to the fetch date: forward-looking endpoints
 * (analystEstimates rows dated 2026..2030, earnings with future scheduled rows)
 * must never surface a FUTURE "as of" in the sources appendix (L2). The newest
 * row date that is on or before the fetch date wins; if every row date is in
 * the future, the fetch date is used. Backward-looking endpoints are
 * unaffected (all their dates are already <= the fetch date).
 */
export function deriveAsOf(rows: FmpRawRow[], fallbackIso: string): string {
  const fetchDate = fallbackIso.slice(0, 10);
  for (const field of ["date", "filingDate", "publishedDate"] as const) {
    const dates = rows
      .map((row) => row[field])
      .filter((value): value is string => typeof value === "string" && value.length >= 10)
      .map((value) => value.slice(0, 10))
      .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
    if (dates.length === 0) continue;
    const past = dates.filter((value) => value <= fetchDate);
    if (past.length > 0) return past.sort().at(-1) ?? past[0];
    return fetchDate; // every row date is in the future — clamp
  }

  const timestamps = rows
    .map((row) => row["timestamp"])
    .filter((ts): ts is number => typeof ts === "number" && Number.isFinite(ts) && ts > 0);
  if (timestamps.length > 0) {
    const latest = Math.max(...timestamps);
    // quote.timestamp is unix seconds; aftermarket is ms, disambiguated by magnitude.
    const ms = latest > 1e12 ? latest : latest * 1000;
    const tsDate = new Date(ms).toISOString().slice(0, 10);
    return tsDate <= fetchDate ? tsDate : fetchDate; // clamp a future timestamp
  }
  return fetchDate;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface FmpClientConfig {
  /** Defaults to process.env.FMP_API_KEY. Absent/empty → FIXTURE MODE. */
  apiKey?: string;
  /** Defaults to https://financialmodelingprep.com/stable */
  baseUrl?: string;
  /** Directory holding fixtures/fmp/<method>/<KEY>.json. Defaults to <cwd>/fixtures/fmp. */
  fixturesDir?: string;
  /** cachedFetch from @/cache/apiCache — wire it in the pipeline composition root. */
  cachedFetch?: CachedFetchFn;
  /** Override the shared fmp limiter (tests). */
  limiter?: TokenBucketLimiter;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Per-attempt timeout, default 30s. */
  timeoutMs?: number;
  /** Job/request cancellation signal, composed with each per-attempt timeout. */
  signal?: AbortSignal;
}

interface CallSpec {
  method: FmpMethodName;
  /** path under /stable/, e.g. "income-statement" or "insider-trading/search" */
  endpoint: string;
  params: FmpParams;
  /** Most stable endpoints return arrays. Set only for endpoints verified as single-object success bodies. */
  allowObjectBody?: boolean;
  /** fixture basenames tried in order (before "default"); usually the symbol */
  fixtureKeys?: string[];
  /** manifest field for gaps, e.g. "fmp.profile(AAPL)" */
  gapField: string;
}

interface LiveExchange {
  body: unknown;
  status: number;
  fetchedAt: string;
}

const DEFAULT_BASE_URL = "https://financialmodelingprep.com/stable";

export class FmpClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fixturesDir: string;
  private readonly cachedFetch: CachedFetchFn;
  private readonly limiter: TokenBucketLimiter | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly signal: AbortSignal | undefined;

  constructor(config: FmpClientConfig = {}) {
    const envKey = typeof process !== "undefined" ? process.env.FMP_API_KEY : undefined;
    const key = (config.apiKey ?? envKey ?? "").trim();
    this.apiKey = key.length > 0 ? key : undefined;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fixturesDir = config.fixturesDir ?? path.join(process.cwd(), "fixtures", "fmp");
    this.cachedFetch = config.cachedFetch ?? (async (_key, _ttl, loader) => ({ value: await loader() }));
    this.limiter = config.limiter;
    this.fetchImpl = config.fetchImpl;
    this.now = config.now ?? (() => new Date());
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.signal = config.signal;
  }

  /** True when no API key is configured and fixtures serve all methods. */
  get fixtureMode(): boolean {
    return this.apiKey === undefined;
  }

  // -- core plumbing --------------------------------------------------------

  private async call<TRow extends FmpRawRow>(spec: CallSpec): Promise<FetchResult<FmpPayload<TRow>>> {
    if (this.fixtureMode) return this.fromFixture<TRow>(spec);
    return this.fromLive<TRow>(spec);
  }

  private async fromLive<TRow extends FmpRawRow>(spec: CallSpec): Promise<FetchResult<FmpPayload<TRow>>> {
    const apiKey = this.apiKey;
    if (apiKey === undefined) {
      throw new Error("fromLive called without an API key (programming error — fixtureMode should have routed)");
    }
    const qs = fmpQueryString(spec.params);
    const endpointPath = qs ? `/stable/${spec.endpoint}?${qs}` : `/stable/${spec.endpoint}`;
    const url = `${this.baseUrl}/${spec.endpoint}${qs ? `?${qs}` : ""}`;
    const cacheKey = fmpCacheKey(spec.endpoint, spec.params);
    const ttlMs = FMP_TTLS[spec.method];

    let exchange: CachedFetchResult<LiveExchange>;
    try {
      exchange = await this.cachedFetch<LiveExchange>(cacheKey, ttlMs, async () => {
        const policy: FetchPolicy = {
          provider: "fmp",
          timeoutMs: this.timeoutMs,
          signal: this.signal,
          ...(this.limiter ? { limiter: this.limiter } : {}),
          ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        };
        const res = await fetchWithPolicy(
          url,
          { headers: { apikey: apiKey, accept: "application/json" } },
          policy,
        );
        let body: unknown;
        try {
          body = res.bodyText.length > 0 ? (JSON.parse(res.bodyText) as unknown) : null;
        } catch {
          throw new FmpBodyParseError(
            `FMP returned unparseable body (HTTP ${res.status}) for ${endpointPath}: ${res.bodyText.slice(0, 200)}`,
          );
        }
        if (isFmpErrorBody(body)) {
          // thrown (not returned) so error bodies are never cached as data
          throw new FmpApiError(fmpErrorMessage(body), res.status);
        }
        if (!res.ok) {
          throw new FmpApiError(`HTTP ${res.status}: ${res.bodyText.slice(0, 200)}`, res.status);
        }
        return { body, status: res.status, fetchedAt: this.now().toISOString() };
      });
    } catch (err) {
      if (err instanceof FmpApiError) {
        return gap(spec.gapField, `FMP error (HTTP ${err.status}): ${err.message}`, "warn", [endpointPath]);
      }
      if (err instanceof FmpBodyParseError) {
        return gap(spec.gapField, err.message, "warn", [endpointPath]);
      }
      if (err instanceof HttpTransportError) throw err; // hard transport failure after retries
      throw err; // programming error
    }

    const body = exchange.value.body;
    // Prefer the cache envelope's fetchedAt (original fetch time when served
    // from cache) over the loader's timestamp.
    const fetchedAt = exchange.fetchedAt ?? exchange.value.fetchedAt;
    if (Array.isArray(body) && body.some((row) => !isRecord(row))) {
      return gap(
        spec.gapField,
        `FMP provider schema drift in ${spec.method}: response array contains a non-object row`,
        "warn",
        [endpointPath],
      );
    }
    const normalizedRows = normalizeRows<TRow>(body, spec.allowObjectBody === true);
    if (normalizedRows.length === 0) {
      const reason = isRecord(body)
        ? "FMP returned an unrecognized object body where an array was expected"
        : FMP_EMPTY_ARRAY_REASON;
      return gap(spec.gapField, reason, "info", [endpointPath]);
    }
    const validation = validateCriticalRows<TRow>(spec.method, normalizedRows);
    if (!validation.ok) return gap(spec.gapField, validation.reason, "warn", [endpointPath]);
    const rows = validation.rows;
    const sourced: Sourced<FmpPayload<TRow>> = {
      data: { rows, raw: body },
      asOf: deriveAsOf(rows, fetchedAt ?? this.now().toISOString()),
      source: "fmp",
      endpoint: endpointPath,
      fetchedAt: fetchedAt ?? this.now().toISOString(),
      ...(exchange.stale ? { stale: true } : {}),
      ...(exchange.staleReason ? { staleReason: exchange.staleReason } : {}),
    };
    return { ok: true, value: sourced };
  }

  private async fromFixture<TRow extends FmpRawRow>(spec: CallSpec): Promise<FetchResult<FmpPayload<TRow>>> {
    const qs = fmpQueryString(spec.params);
    const endpointPath = qs ? `/stable/${spec.endpoint}?${qs}` : `/stable/${spec.endpoint}`;
    const candidates = [...(spec.fixtureKeys ?? []).map((k) => sanitizeFixtureKey(k)), "default"].filter(
      (k, i, all) => k.length > 0 && all.indexOf(k) === i,
    );

    const attempted: string[] = [endpointPath];
    for (const candidate of candidates) {
      const fixturePath = path.join(this.fixturesDir, spec.method, `${candidate}.json`);
      attempted.push(`fixture:${path.join("fixtures", "fmp", spec.method, `${candidate}.json`)}`);
      let text: string;
      try {
        text = await fs.readFile(fixturePath, "utf8");
      } catch {
        continue; // try next candidate
      }
      let body: unknown;
      try {
        body = JSON.parse(text) as unknown;
      } catch (err) {
        throw new Error(`fixture ${fixturePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (Array.isArray(body) && body.some((row) => !isRecord(row))) {
        return gap(
          spec.gapField,
          `FMP provider schema drift in ${spec.method}: fixture array contains a non-object row`,
          "warn",
          attempted,
        );
      }
      const normalizedRows = normalizeRows<TRow>(body, spec.allowObjectBody === true);
      if (normalizedRows.length === 0) {
        return gap(spec.gapField, FMP_EMPTY_ARRAY_REASON, "info", attempted);
      }
      const validation = validateCriticalRows<TRow>(spec.method, normalizedRows);
      if (!validation.ok) return gap(spec.gapField, validation.reason, "warn", attempted);
      const rows = validation.rows;
      const nowIso = this.now().toISOString();
      const sourced: Sourced<FmpPayload<TRow>> = {
        data: { rows, raw: body },
        asOf: deriveAsOf(rows, nowIso),
        source: "fmp",
        endpoint: `[FIXTURE] ${endpointPath}`,
        fetchedAt: nowIso,
        stale: true,
      };
      return { ok: true, value: sourced };
    }

    return gap(spec.gapField, "no API key + no fixture", "warn", attempted);
  }

  // -- company & reference --------------------------------------------------

  profile(symbol: string): FmpResult<FmpProfileRow> {
    return this.call<FmpProfileRow>({
      method: "profile",
      endpoint: "profile",
      params: { symbol },
      fixtureKeys: [symbol],
      gapField: `fmp.profile(${symbol})`,
    });
  }

  quote(symbol: string): FmpResult<FmpQuoteRow> {
    return this.call<FmpQuoteRow>({
      method: "quote",
      endpoint: "quote",
      params: { symbol },
      fixtureKeys: [symbol],
      gapField: `fmp.quote(${symbol})`,
    });
  }

  batchQuote(symbols: string[]): FmpResult<FmpQuoteRow> {
    const joined = symbols.join(",");
    return this.call<FmpQuoteRow>({
      method: "batchQuote",
      endpoint: "batch-quote",
      params: { symbols: joined },
      fixtureKeys: [symbols.join("_"), symbols[0] ?? ""],
      gapField: `fmp.batchQuote(${joined})`,
    });
  }

  // -- statements -----------------------------------------------------------

  incomeStatement(symbol: string, period: FmpPeriod = "annual", limit = 10): FmpResult<FmpIncomeStatementRow> {
    return this.call<FmpIncomeStatementRow>({
      method: "incomeStatement",
      endpoint: "income-statement",
      params: { symbol, period, limit },
      fixtureKeys: [`${symbol}_${period}`, symbol],
      gapField: `fmp.incomeStatement(${symbol},${period})`,
    });
  }

  balanceSheet(symbol: string, period: FmpPeriod = "annual", limit = 10): FmpResult<FmpBalanceSheetRow> {
    return this.call<FmpBalanceSheetRow>({
      method: "balanceSheet",
      endpoint: "balance-sheet-statement",
      params: { symbol, period, limit },
      fixtureKeys: [`${symbol}_${period}`, symbol],
      gapField: `fmp.balanceSheet(${symbol},${period})`,
    });
  }

  cashFlow(symbol: string, period: FmpPeriod = "annual", limit = 10): FmpResult<FmpCashFlowRow> {
    return this.call<FmpCashFlowRow>({
      method: "cashFlow",
      endpoint: "cash-flow-statement",
      params: { symbol, period, limit },
      fixtureKeys: [`${symbol}_${period}`, symbol],
      gapField: `fmp.cashFlow(${symbol},${period})`,
    });
  }

  // -- metrics & ratios -----------------------------------------------------

  keyMetrics(symbol: string, period: FmpPeriod = "annual", limit = 10): FmpResult<FmpKeyMetricsRow> {
    return this.call<FmpKeyMetricsRow>({
      method: "keyMetrics",
      endpoint: "key-metrics",
      params: { symbol, period, limit },
      fixtureKeys: [`${symbol}_${period}`, symbol],
      gapField: `fmp.keyMetrics(${symbol},${period})`,
    });
  }

  /** TTM snapshot — symbol-only, no date/period fields, metric names suffixed TTM. */
  keyMetricsTtm(symbol: string): FmpResult<FmpKeyMetricsRow> {
    return this.call<FmpKeyMetricsRow>({
      method: "keyMetricsTtm",
      endpoint: "key-metrics-ttm",
      params: { symbol },
      fixtureKeys: [symbol],
      gapField: `fmp.keyMetricsTtm(${symbol})`,
    });
  }

  ratios(symbol: string, period: FmpPeriod = "annual", limit = 10): FmpResult<FmpRatiosRow> {
    return this.call<FmpRatiosRow>({
      method: "ratios",
      endpoint: "ratios",
      params: { symbol, period, limit },
      fixtureKeys: [`${symbol}_${period}`, symbol],
      gapField: `fmp.ratios(${symbol},${period})`,
    });
  }

  /** TTM snapshot — symbol-only, ratio names suffixed TTM. */
  ratiosTtm(symbol: string): FmpResult<FmpRatiosRow> {
    return this.call<FmpRatiosRow>({
      method: "ratiosTtm",
      endpoint: "ratios-ttm",
      params: { symbol },
      fixtureKeys: [symbol],
      gapField: `fmp.ratiosTtm(${symbol})`,
    });
  }

  financialGrowth(symbol: string, period: FmpPeriod = "annual", limit = 10): FmpResult<FmpFinancialGrowthRow> {
    return this.call<FmpFinancialGrowthRow>({
      method: "financialGrowth",
      endpoint: "financial-growth",
      params: { symbol, period, limit },
      fixtureKeys: [`${symbol}_${period}`, symbol],
      gapField: `fmp.financialGrowth(${symbol},${period})`,
    });
  }

  /** Altman Z + Piotroski snapshot (inputs exposed; no date field). */
  financialScores(symbol: string): FmpResult<FmpFinancialScoresRow> {
    return this.call<FmpFinancialScoresRow>({
      method: "financialScores",
      endpoint: "financial-scores",
      params: { symbol },
      fixtureKeys: [symbol],
      gapField: `fmp.financialScores(${symbol})`,
    });
  }

  enterpriseValues(symbol: string, period: FmpPeriod = "annual", limit = 10): FmpResult<FmpEnterpriseValuesRow> {
    return this.call<FmpEnterpriseValuesRow>({
      method: "enterpriseValues",
      endpoint: "enterprise-values",
      params: { symbol, period, limit },
      fixtureKeys: [`${symbol}_${period}`, symbol],
      gapField: `fmp.enterpriseValues(${symbol},${period})`,
    });
  }

  // -- analysts -------------------------------------------------------------

  analystEstimates(
    symbol: string,
    period: "annual" | "quarter" = "annual",
    page = 0,
    limit = 10,
  ): FmpResult<FmpAnalystEstimatesRow> {
    return this.call<FmpAnalystEstimatesRow>({
      method: "analystEstimates",
      endpoint: "analyst-estimates",
      params: { symbol, period, page, limit },
      fixtureKeys: [`${symbol}_${period}`, symbol],
      gapField: `fmp.analystEstimates(${symbol},${period})`,
    });
  }

  /** NOTE: `publishers` is a JSON-string-in-string — double parse downstream. */
  priceTargetSummary(symbol: string): FmpResult<FmpPriceTargetSummaryRow> {
    return this.call<FmpPriceTargetSummaryRow>({
      method: "priceTargetSummary",
      endpoint: "price-target-summary",
      params: { symbol },
      fixtureKeys: [symbol],
      gapField: `fmp.priceTargetSummary(${symbol})`,
    });
  }

  priceTargetConsensus(symbol: string): FmpResult<FmpPriceTargetConsensusRow> {
    return this.call<FmpPriceTargetConsensusRow>({
      method: "priceTargetConsensus",
      endpoint: "price-target-consensus",
      params: { symbol },
      fixtureKeys: [symbol],
      gapField: `fmp.priceTargetConsensus(${symbol})`,
    });
  }

  gradesConsensus(symbol: string): FmpResult<FmpGradesConsensusRow> {
    return this.call<FmpGradesConsensusRow>({
      method: "gradesConsensus",
      endpoint: "grades-consensus",
      params: { symbol },
      fixtureKeys: [symbol],
      gapField: `fmp.gradesConsensus(${symbol})`,
    });
  }

  // -- earnings & transcripts -------------------------------------------------

  /** Past + future rows; future rows carry epsActual=null. Surprise = compute. */
  earnings(symbol: string, limit = 40): FmpResult<FmpEarningsRow> {
    return this.call<FmpEarningsRow>({
      method: "earnings",
      endpoint: "earnings",
      params: { symbol, limit },
      fixtureKeys: [symbol],
      gapField: `fmp.earnings(${symbol})`,
    });
  }

  earningsCalendar(from: string, to: string): FmpResult<FmpEarningsRow> {
    return this.call<FmpEarningsRow>({
      method: "earningsCalendar",
      endpoint: "earnings-calendar",
      params: { from, to },
      fixtureKeys: [`${from}_${to}`],
      gapField: `fmp.earningsCalendar(${from},${to})`,
    });
  }

  transcriptDates(symbol: string): FmpResult<FmpTranscriptDateRow> {
    return this.call<FmpTranscriptDateRow>({
      method: "transcriptDates",
      endpoint: "earning-call-transcript-dates",
      params: { symbol },
      fixtureKeys: [symbol],
      gapField: `fmp.transcriptDates(${symbol})`,
    });
  }

  /** Ultimate-gated; `content` can be multi-100KB (bandwidth budget!). */
  transcript(symbol: string, year: number, quarter: number): FmpResult<FmpTranscriptRow> {
    return this.call<FmpTranscriptRow>({
      method: "transcript",
      endpoint: "earning-call-transcript",
      params: { symbol, year, quarter },
      fixtureKeys: [`${symbol}_${year}_Q${quarter}`, symbol],
      gapField: `fmp.transcript(${symbol},${year}Q${quarter})`,
    });
  }

  // -- insiders & ownership ---------------------------------------------------

  insiderTradingSearch(symbol: string, page = 0, limit = 100): FmpResult<FmpInsiderTradeRow> {
    return this.call<FmpInsiderTradeRow>({
      method: "insiderTradingSearch",
      endpoint: "insider-trading/search",
      params: { symbol, page, limit },
      fixtureKeys: [symbol],
      gapField: `fmp.insiderTradingSearch(${symbol})`,
    });
  }

  insiderTradeStatistics(symbol: string): FmpResult<FmpInsiderTradeStatisticsRow> {
    return this.call<FmpInsiderTradeStatisticsRow>({
      method: "insiderTradeStatistics",
      endpoint: "insider-trading/statistics",
      params: { symbol },
      fixtureKeys: [symbol],
      gapField: `fmp.insiderTradeStatistics(${symbol})`,
    });
  }

  /** Ultimate-gated 13F analytics. Requires explicit year+quarter (no "latest" mode). */
  institutionalHolderAnalytics(
    symbol: string,
    year: number,
    quarter: number,
    page = 0,
    limit = 100,
  ): FmpResult<FmpInstitutionalHolderRow> {
    return this.call<FmpInstitutionalHolderRow>({
      method: "institutionalHolderAnalytics",
      endpoint: "institutional-ownership/extract-analytics/holder",
      params: { symbol, year: String(year), quarter: String(quarter), page, limit },
      fixtureKeys: [`${symbol}_${year}_Q${quarter}`, symbol],
      gapField: `fmp.institutionalHolderAnalytics(${symbol},${year}Q${quarter})`,
    });
  }

  /** Ultimate-gated. 13F lags quarter-end by ≤45 days — label the quarter. */
  symbolPositionsSummary(symbol: string, year: number, quarter: number): FmpResult<FmpPositionsSummaryRow> {
    return this.call<FmpPositionsSummaryRow>({
      method: "symbolPositionsSummary",
      endpoint: "institutional-ownership/symbol-positions-summary",
      params: { symbol, year: String(year), quarter: String(quarter) },
      fixtureKeys: [`${symbol}_${year}_Q${quarter}`, symbol],
      gapField: `fmp.symbolPositionsSummary(${symbol},${year}Q${quarter})`,
    });
  }

  /** Per-HOLDER 13F filing dates (param is the holder's CIK, not a symbol). */
  institutionalOwnershipDates(cik: string): FmpResult<FmpOwnershipDatesRow> {
    return this.call<FmpOwnershipDatesRow>({
      method: "institutionalOwnershipDates",
      endpoint: "institutional-ownership/dates",
      params: { cik },
      fixtureKeys: [cik],
      gapField: `fmp.institutionalOwnershipDates(${cik})`,
    });
  }

  // -- peers, segments, people ------------------------------------------------

  stockPeers(symbol: string): FmpResult<FmpStockPeerRow> {
    return this.call<FmpStockPeerRow>({
      method: "stockPeers",
      endpoint: "stock-peers",
      params: { symbol },
      fixtureKeys: [symbol],
      gapField: `fmp.stockPeers(${symbol})`,
    });
  }

  /** `data` keys are free-text as-reported segment labels — never hard-code them. */
  revenueProductSegmentation(symbol: string, period: "annual" | "quarter" = "annual"): FmpResult<FmpSegmentationRow> {
    return this.call<FmpSegmentationRow>({
      method: "revenueProductSegmentation",
      endpoint: "revenue-product-segmentation",
      params: { symbol, period, structure: "flat" },
      fixtureKeys: [`${symbol}_${period}`, symbol],
      gapField: `fmp.revenueProductSegmentation(${symbol},${period})`,
    });
  }

  revenueGeographicSegmentation(
    symbol: string,
    period: "annual" | "quarter" = "annual",
  ): FmpResult<FmpSegmentationRow> {
    return this.call<FmpSegmentationRow>({
      method: "revenueGeographicSegmentation",
      endpoint: "revenue-geographic-segmentation",
      params: { symbol, period, structure: "flat" },
      fixtureKeys: [`${symbol}_${period}`, symbol],
      gapField: `fmp.revenueGeographicSegmentation(${symbol},${period})`,
    });
  }

  keyExecutives(symbol: string): FmpResult<FmpKeyExecutiveRow> {
    return this.call<FmpKeyExecutiveRow>({
      method: "keyExecutives",
      endpoint: "key-executives",
      params: { symbol },
      fixtureKeys: [symbol],
      gapField: `fmp.keyExecutives(${symbol})`,
    });
  }

  /** Proxy-lagged (a 2026 filing can carry FY2023 rows). */
  executiveCompensation(symbol: string): FmpResult<FmpExecutiveCompensationRow> {
    return this.call<FmpExecutiveCompensationRow>({
      method: "executiveCompensation",
      endpoint: "governance-executive-compensation",
      params: { symbol },
      fixtureKeys: [symbol],
      gapField: `fmp.executiveCompensation(${symbol})`,
    });
  }

  // -- capitalization ----------------------------------------------------------

  marketCap(symbol: string): FmpResult<FmpMarketCapRow> {
    return this.call<FmpMarketCapRow>({
      method: "marketCap",
      endpoint: "market-capitalization",
      params: { symbol },
      fixtureKeys: [symbol],
      gapField: `fmp.marketCap(${symbol})`,
    });
  }

  historicalMarketCap(symbol: string, from: string, to: string): FmpResult<FmpMarketCapRow> {
    return this.call<FmpMarketCapRow>({
      method: "historicalMarketCap",
      endpoint: "historical-market-capitalization",
      params: { symbol, from, to, limit: 5000 },
      fixtureKeys: [`${symbol}_${from}_${to}`, symbol],
      gapField: `fmp.historicalMarketCap(${symbol})`,
    });
  }

  /** Snapshot only (no history). `freeFloat` is a percent; `date` is a datetime. */
  sharesFloat(symbol: string): FmpResult<FmpSharesFloatRow> {
    return this.call<FmpSharesFloatRow>({
      method: "sharesFloat",
      endpoint: "shares-float",
      params: { symbol },
      fixtureKeys: [symbol],
      gapField: `fmp.sharesFloat(${symbol})`,
    });
  }

  // -- filings & news -----------------------------------------------------------

  /** from/to are REQUIRED by FMP. No form-type filter — filter client-side. */
  secFilingsSearch(symbol: string, from: string, to: string, page = 0, limit = 100): FmpResult<FmpSecFilingRow> {
    return this.call<FmpSecFilingRow>({
      method: "secFilingsSearch",
      endpoint: "sec-filings-search/symbol",
      params: { symbol, from, to, page, limit },
      fixtureKeys: [`${symbol}_${from}_${to}`, symbol],
      gapField: `fmp.secFilingsSearch(${symbol})`,
    });
  }

  /** Param is plural `symbols` (comma-separated). Max limit 250. */
  stockNews(symbols: string[], from: string, to: string, page = 0, limit = 100): FmpResult<FmpNewsArticleRow> {
    const joined = symbols.join(",");
    return this.call<FmpNewsArticleRow>({
      method: "stockNews",
      endpoint: "news/stock",
      params: { symbols: joined, from, to, page, limit },
      fixtureKeys: [symbols.join("_"), symbols[0] ?? ""],
      gapField: `fmp.stockNews(${joined})`,
    });
  }

  /** Premium+-gated per docs restriction data. */
  pressReleases(symbols: string[], from: string, to: string, page = 0, limit = 100): FmpResult<FmpNewsArticleRow> {
    const joined = symbols.join(",");
    return this.call<FmpNewsArticleRow>({
      method: "pressReleases",
      endpoint: "news/press-releases",
      params: { symbols: joined, from, to, page, limit },
      fixtureKeys: [symbols.join("_"), symbols[0] ?? ""],
      gapField: `fmp.pressReleases(${joined})`,
    });
  }

  // -- prices ---------------------------------------------------------------

  /**
   * Full OHLCV daily history with automatic 5-year chunking (FMP serves max
   * ~5 years per request). Rows are merged, deduped by date, sorted
   * newest-first (FMP convention). Close is split-adjusted ONLY.
   */
  async historicalPriceEodFull(symbol: string, from: string, to: string): FmpResult<FmpEodBarRow> {
    if (this.fixtureMode) {
      return this.call<FmpEodBarRow>({
        method: "historicalPriceEodFull",
        endpoint: "historical-price-eod/full",
        params: { symbol, from, to },
        fixtureKeys: [`${symbol}_${from}_${to}`, symbol],
        gapField: `fmp.historicalPriceEodFull(${symbol})`,
      });
    }

    const chunks = chunkDateRange(from, to);
    const attempted = [`/stable/historical-price-eod/full?symbol=${symbol}&from=${from}&to=${to}`];
    const results: FetchResult<FmpPayload<FmpEodBarRow>>[] = [];
    for (const chunk of chunks) {
      results.push(await this.fromLiveEodChunk(symbol, chunk));
    }

    // An empty OLDER chunk can be the pre-listing period, but an empty NEWEST
    // chunk usually cannot establish that the last available close is current.
    // Treat every non-row chunk as a boundary in the returned contiguous
    // suffix: that preserves valid post-listing history while refusing stale
    // prices. The one exception is the "no bar published yet" case handled
    // below (weekend/holiday/pre-close runs).
    const failures = results.filter((r): r is { ok: false; gap: ManifestEntry } => !r.ok);

    if (!results.some((r) => r.ok)) {
      return gap(
        `fmp.historicalPriceEodFull(${symbol})`,
        `all ${chunks.length} EOD chunk(s) failed: ${failures[0]?.gap.reason ?? "unknown"}`,
        "warn",
        attempted,
      );
    }

    // A published EOD bar lags the wall clock: on a weekend, exchange holiday,
    // or a pre-close/intraday run the request window ends on a day that has no
    // bar yet. For some calendar eras the 5-year chunk boundary collapses the
    // newest chunk to just the last few days (e.g. {today, today}); that chunk
    // then comes back EMPTY even though yesterday's close is valid and current,
    // and the naive "empty newest chunk ⇒ refuse everything" rule would erase
    // ALL technicals (stock + SPY + sector ETF share the window). Treat such an
    // empty newest chunk as "no new bar published yet" and fall back to the
    // prior chunk's close — but ONLY when (a) the newest chunk is empty (not an
    // errored/rate-limited fetch), (b) it spans at most a week of calendar days,
    // (c) the immediately-prior chunk actually returned rows, and (d) the prior
    // chunk's newest BAR is itself recent — within the same week of the request
    // end. Guard (d) is the load-bearing one: for the default 5-year window the
    // newest chunk is always ~0 days wide, so the span guard alone would let a
    // delisted/long-halted symbol (prior chunk ok, but its bars ending months
    // ago) serve stale closes as current. Such a symbol is still refused below
    // (asOf then reflects real rows only).
    const NO_NEW_BAR_MAX_SPAN_DAYS = 7;
    const newestIdx = chunks.length - 1;
    const newestResult = results[newestIdx];
    const priorResult = newestIdx >= 1 ? results[newestIdx - 1] : undefined;
    const newestChunk = chunks[newestIdx];
    const newestSpanDays =
      (parseIsoDate(newestChunk.to).getTime() - parseIsoDate(newestChunk.from).getTime()) / DAY;
    const priorNewestBarDate =
      priorResult?.ok === true
        ? priorResult.value.data.rows.reduce<string | null>(
            (max, r) => (typeof r.date === "string" && (max === null || r.date > max) ? r.date : max),
            null,
          )
        : null;
    const priorBarLagDays =
      priorNewestBarDate !== null
        ? (parseIsoDate(newestChunk.to).getTime() - parseIsoDate(priorNewestBarDate).getTime()) / DAY
        : Number.POSITIVE_INFINITY;
    const newestIsNoNewBar =
      newestResult !== undefined &&
      !newestResult.ok &&
      newestResult.gap.reason === FMP_EMPTY_ARRAY_REASON &&
      newestSpanDays <= NO_NEW_BAR_MAX_SPAN_DAYS &&
      priorBarLagDays <= NO_NEW_BAR_MAX_SPAN_DAYS &&
      priorResult?.ok === true &&
      priorResult.value.data.rows.length > 0;

    // Accept only the contiguous run of row-bearing chunks ending at the
    // effective-newest chunk (chunks are built oldest -> newest). A missing
    // newest chunk normally refuses everything — a months-stale lastClose would
    // silently corrupt every technical read — but a "no new bar yet" newest
    // chunk steps the boundary back one chunk instead. A missing OLDER chunk
    // merely truncates history: computeTechnicals already flags per-window
    // insufficiency, so a shortened window degrades honestly instead of erasing
    // the whole technicals section (2026-07 audit: 8-11 early reports lost ALL
    // technicals to one rate-limited chunk). Successful chunks older than a
    // boundary are dropped too — a hole in the middle of the series would
    // corrupt drawdowns/RS.
    const effectiveNewestIdx = newestIsNoNewBar ? newestIdx - 1 : newestIdx;
    let suffixStart = effectiveNewestIdx + 1;
    while (suffixStart > 0 && results[suffixStart - 1]?.ok) suffixStart--;
    if (suffixStart === effectiveNewestIdx + 1) {
      const failed = failures
        .map((g) => `${g.gap.field}: ${g.gap.reason}`)
        .slice(0, 3)
        .join("; ");
      return gap(
        `fmp.historicalPriceEodFull(${symbol})`,
        `partial EOD history refused: the newest chunk failed — ${failures.length}/${chunks.length} chunk(s) failed (${failed})`,
        "warn",
        attempted,
      );
    }

    const byDate = new Map<string, FmpEodBarRow>();
    const rawParts: unknown[] = [];
    let latestFetchedAt = "";
    let anyStale = false;
    for (let i = suffixStart; i <= effectiveNewestIdx; i++) {
      const result = results[i];
      if (!result.ok) continue; // unreachable inside the accepted suffix
      anyStale = anyStale || result.value.stale === true;
      if (result.value.fetchedAt > latestFetchedAt) latestFetchedAt = result.value.fetchedAt;
      rawParts.push(result.value.data.raw);
      for (const row of result.value.data.rows) {
        if (typeof row.date === "string") byDate.set(row.date.slice(0, 10), row);
      }
    }

    if (byDate.size === 0) {
      return gap(
        `fmp.historicalPriceEodFull(${symbol})`,
        "FMP returned no EOD rows for the requested window",
        "warn",
        attempted,
      );
    }

    const rows = [...byDate.values()].sort((a, b) => {
      const da = typeof a.date === "string" ? a.date : "";
      const db = typeof b.date === "string" ? b.date : "";
      return da < db ? 1 : da > db ? -1 : 0;
    });

    const truncatedFrom = suffixStart > 0 ? chunks[suffixStart].from : null;
    // The no-new-bar newest chunk is a "failure" but is NOT an older chunk that
    // truncated history, so exclude it from the older-chunk counts.
    const olderFailCount = newestIsNoNewBar ? failures.length - 1 : failures.length;
    const disclosures: string[] = [];
    if (truncatedFrom !== null) {
      const droppedOk = suffixStart - olderFailCount;
      disclosures.push(
        `history truncated to ${truncatedFrom}..${to} — ${olderFailCount} older chunk(s) failed${droppedOk > 0 ? `, ${droppedOk} disjoint older chunk(s) dropped` : ""}`,
      );
    }
    if (newestIsNoNewBar) {
      disclosures.push(
        `newest window ${newestChunk.from}..${newestChunk.to} has no published bar yet (weekend/holiday/pre-close) — series ends at the last available close`,
      );
    }
    const fetchedAt = latestFetchedAt || this.now().toISOString();
    return {
      ok: true,
      value: {
        data: { rows, raw: rawParts },
        asOf: deriveAsOf(rows, fetchedAt),
        source: "fmp",
        endpoint: `/stable/historical-price-eod/full?symbol=${symbol}&from=${from}&to=${to} (${chunks.length} chunk(s)${disclosures.length > 0 ? `; ${disclosures.join("; ")}` : ""})`,
        fetchedAt,
        ...(anyStale ? { stale: true } : {}),
      },
    };
  }

  private fromLiveEodChunk(symbol: string, chunk: DateChunk): Promise<FetchResult<FmpPayload<FmpEodBarRow>>> {
    return this.fromLive<FmpEodBarRow>({
      method: "historicalPriceEodFull",
      endpoint: "historical-price-eod/full",
      params: { symbol, from: chunk.from, to: chunk.to },
      gapField: `fmp.historicalPriceEodFull(${symbol},${chunk.from}..${chunk.to})`,
    });
  }

  // -- sector / macro context -------------------------------------------------

  sectorPeSnapshot(date: string): FmpResult<FmpSectorPeRow> {
    return this.call<FmpSectorPeRow>({
      method: "sectorPeSnapshot",
      endpoint: "sector-pe-snapshot",
      params: { date },
      fixtureKeys: [date],
      gapField: `fmp.sectorPeSnapshot(${date})`,
    });
  }

  industryPeSnapshot(date: string): FmpResult<FmpIndustryPeRow> {
    return this.call<FmpIndustryPeRow>({
      method: "industryPeSnapshot",
      endpoint: "industry-pe-snapshot",
      params: { date },
      fixtureKeys: [date],
      gapField: `fmp.industryPeSnapshot(${date})`,
    });
  }

  /** `averageChange` units are PLV (likely percent). Rows repeat per exchange. */
  sectorPerformanceSnapshot(date: string): FmpResult<FmpSectorPerformanceRow> {
    return this.call<FmpSectorPerformanceRow>({
      method: "sectorPerformanceSnapshot",
      endpoint: "sector-performance-snapshot",
      params: { date },
      fixtureKeys: [date],
      gapField: `fmp.sectorPerformanceSnapshot(${date})`,
    });
  }

  /** Percent yields, full curve per day. No params → latest row. */
  treasuryRates(from?: string, to?: string): FmpResult<FmpTreasuryRatesRow> {
    return this.call<FmpTreasuryRatesRow>({
      method: "treasuryRates",
      endpoint: "treasury-rates",
      params: { from, to },
      fixtureKeys: [from && to ? `${from}_${to}` : ""],
      gapField: "fmp.treasuryRates",
    });
  }

  /** `name` per the 24 documented enum values (DATA_MAP §2.12 / fmp-market.md §6). */
  economicIndicators(name: string): FmpResult<FmpEconomicIndicatorRow> {
    return this.call<FmpEconomicIndicatorRow>({
      method: "economicIndicators",
      endpoint: "economic-indicators",
      params: { name },
      fixtureKeys: [name],
      gapField: `fmp.economicIndicators(${name})`,
    });
  }

  /** NO as-of date in the response (annual-ish vintage) — 7d TTL, label accordingly. */
  marketRiskPremium(): FmpResult<FmpMarketRiskPremiumRow> {
    return this.call<FmpMarketRiskPremiumRow>({
      method: "marketRiskPremium",
      endpoint: "market-risk-premium",
      params: {},
      gapField: "fmp.marketRiskPremium",
    });
  }

  // -- valuation ----------------------------------------------------------------

  /** Headline DCF. Beware the literal "Stock Price" field (space in key). */
  dcf(symbol: string): FmpResult<FmpDcfRow> {
    return this.call<FmpDcfRow>({
      method: "dcf",
      endpoint: "discounted-cash-flow",
      params: { symbol },
      fixtureKeys: [symbol],
      gapField: `fmp.dcf(${symbol})`,
    });
  }

  leveredDcf(symbol: string): FmpResult<FmpDcfRow> {
    return this.call<FmpDcfRow>({
      method: "leveredDcf",
      endpoint: "levered-discounted-cash-flow",
      params: { symbol },
      fixtureKeys: [symbol],
      gapField: `fmp.leveredDcf(${symbol})`,
    });
  }

  // -- enums (freeze day-1 per DATA_MAP §2.5) -----------------------------------

  availableIndustries(): FmpResult<FmpIndustryNameRow> {
    return this.call<FmpIndustryNameRow>({
      method: "availableIndustries",
      endpoint: "available-industries",
      params: {},
      gapField: "fmp.availableIndustries",
    });
  }

  availableSectors(): FmpResult<FmpSectorNameRow> {
    return this.call<FmpSectorNameRow>({
      method: "availableSectors",
      endpoint: "available-sectors",
      params: {},
      gapField: "fmp.availableSectors",
    });
  }
}

/** Convenience factory. */
export function createFmpClient(config: FmpClientConfig = {}): FmpClient {
  return new FmpClient(config);
}

// ---------------------------------------------------------------------------
// Internal errors & helpers
// ---------------------------------------------------------------------------

/** FMP business-level error (body carried "Error Message" or non-OK status). */
class FmpApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "FmpApiError";
    this.status = status;
  }
}

class FmpBodyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FmpBodyParseError";
  }
}

function gap(
  field: string,
  reason: string,
  severity: ManifestEntry["severity"],
  attemptedSources: string[],
): { ok: false; gap: ManifestEntry } {
  return { ok: false, gap: { field, reason, severity, attemptedSources } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Success bodies are arrays of objects; single-object bodies require explicit opt-in. */
function normalizeRows<TRow extends FmpRawRow>(body: unknown, allowObjectBody: boolean): TRow[] {
  if (Array.isArray(body)) {
    return body.filter(isRecord) as TRow[];
  }
  if (allowObjectBody && isRecord(body)) return [body as TRow];
  return [];
}

function sanitizeFixtureKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._\-^]/g, "_").toUpperCase();
}
