/**
 * Stage A contracts: the DataBundle — everything downstream (validation,
 * Stage B compute, LLM payload assembly) consumes — plus the small pure
 * calendar helpers shared between fetching (dataBundle.ts) and validation
 * (stageA/validate.ts), e.g. the 13F quarter-resolution rule.
 *
 * EVERY externally sourced member of the bundle is a FetchResult<...> whose
 * ok-branch carries Sourced provenance (src/types/core.ts): as-of date,
 * provider, endpoint, fetch time, staleness. Failures are ManifestEntry gaps —
 * missing inputs NEVER throw (the application contract §3, non-negotiable rule #4).
 */

import type { FetchResult, ManifestEntry } from "@/types/core";
import type {
  FmpAnalystEstimatesRow,
  FmpBalanceSheetRow,
  FmpCashFlowRow,
  FmpEarningsRow,
  FmpEnterpriseValuesRow,
  FmpEodBarRow,
  FmpExecutiveCompensationRow,
  FmpFinancialGrowthRow,
  FmpFinancialScoresRow,
  FmpGradesConsensusRow,
  FmpIncomeStatementRow,
  FmpInsiderTradeRow,
  FmpInsiderTradeStatisticsRow,
  FmpInstitutionalHolderRow,
  FmpKeyExecutiveRow,
  FmpKeyMetricsRow,
  FmpMarketCapRow,
  FmpMarketRiskPremiumRow,
  FmpNewsArticleRow,
  FmpPayload,
  FmpPositionsSummaryRow,
  FmpPriceTargetConsensusRow,
  FmpPriceTargetSummaryRow,
  FmpProfileRow,
  FmpQuoteRow,
  FmpRatiosRow,
  FmpRawRow,
  FmpSecFilingRow,
  FmpSegmentationRow,
  FmpSharesFloatRow,
  FmpStockPeerRow,
  FmpTranscriptDateRow,
  FmpTranscriptRow,
  FmpTreasuryRatesRow,
} from "@/providers/fmp";
import type { CikMapping, EdgarFiling } from "@/providers/edgar";
import type { CompanyFacts } from "@/edgar/xbrl";
import type { ExtractMethod } from "@/edgar/extract";
import type { ShortInterestPoint } from "@/providers/finra";
import type { FredObservation } from "@/providers/fred";
import type { InsiderSentimentMonth } from "@/providers/finnhub";

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

/** FetchResult over an FMP payload of typed rows (rows keep all raw fields). */
export type FmpFetch<TRow extends FmpRawRow> = FetchResult<FmpPayload<TRow>>;

// ---------------------------------------------------------------------------
// Sub-bundles
// ---------------------------------------------------------------------------

/**
 * Statements: annual up to 10 fiscal years, quarterly up to 8 quarters
 * (the application contract §4 growth windows). Rows are sorted date DESC (deterministic).
 */
export interface StatementSet {
  incomeAnnual: FmpFetch<FmpIncomeStatementRow>;
  incomeQuarterly: FmpFetch<FmpIncomeStatementRow>;
  balanceAnnual: FmpFetch<FmpBalanceSheetRow>;
  balanceQuarterly: FmpFetch<FmpBalanceSheetRow>;
  cashflowAnnual: FmpFetch<FmpCashFlowRow>;
  cashflowQuarterly: FmpFetch<FmpCashFlowRow>;
  /** Period metadata: how much history was REQUESTED (returned may be less). */
  periods: { annualRequested: number; quarterlyRequested: number };
}

/** One extracted 10-K / 10-Q section (text feeds the LLM payload). */
export interface ExtractedSection {
  /** Which report section this is. */
  sectionName: "item1A" | "item7" | "tenQItem2";
  text: string;
  /** Extraction layer that produced the text (diagnostics/appendix). */
  method: ExtractMethod;
  chars: number;
  /** Set when a 10-Q Part II Item 1A merely refers back to the 10-K. */
  marker?: "unchanged_from_10k";
  /** Source filing provenance. */
  accession: string;
  form: string;
  filingDate: string;
  /** Fiscal period the filing covers (used as the section's asOf). */
  reportDate: string;
  documentUrl: string;
}

/** Light summary of companyfacts for the report appendix (full facts kept too). */
export interface XbrlSummary {
  entityName: string;
  usGaapTagCount: number;
  /** Most recent core-form fact period end across headline tags (freshness probe). */
  latestFactEnd: string | null;
  /** True when the filer uses bank-style tagging (JPM/BAC/WFC/C pattern). */
  bankTagging: boolean;
}

export interface EdgarBundle {
  cik: FetchResult<CikMapping>;
  /** Latest annual primary filing: prefer 10-K, otherwise Form 20-F. */
  latestTenK: FetchResult<EdgarFiling>;
  /** Latest interim filing: prefer 10-Q; a 6-K is retained as provenance only. */
  latestTenQ: FetchResult<EdgarFiling>;
  /** Annual risk factors: 10-K Item 1A or 20-F Item 3.D. */
  item1a: FetchResult<ExtractedSection>;
  /** Annual MD&A: 10-K Item 7 or 20-F Item 5. */
  mdna: FetchResult<ExtractedSection>;
  /** 10-Q Part I Item 2 (MD&A); Form 6-K never gets an inferred equivalent. */
  tenQMdna: FetchResult<ExtractedSection>;
  /** 8-Ks carrying Item 4.01 (auditor change) among recent filings. May be empty. */
  auditorChange8Ks: FetchResult<EdgarFiling[]>;
  /** 8-Ks carrying Item 4.02 (non-reliance / restatement red flag). May be empty. */
  nonReliance8Ks: FetchResult<EdgarFiling[]>;
  /** Full companyfacts JSON — validation runs getConcept chains against this. */
  companyFacts: FetchResult<CompanyFacts>;
  /** Derived from companyFacts when available (report-renderable). */
  xbrlSummary: XbrlSummary | null;
}

/** 13F data resolved to a specific reporting quarter (see resolve13FQuarter). */
export interface InstitutionalBundle {
  year: number;
  quarter: 1 | 2 | 3 | 4;
  /** Calendar quarter end the 13F cycle covers (label everything with this). */
  quarterEnd: string;
  positionsSummary: FmpFetch<FmpPositionsSummaryRow>;
  topHolders: FmpFetch<FmpInstitutionalHolderRow>;
}

export interface BenchmarkPrices {
  spy: FmpFetch<FmpEodBarRow>;
  sectorEtf: FmpFetch<FmpEodBarRow>;
  /** SPDR sector ETF resolved from profile.sector; null when unmapped. */
  sectorEtfSymbol: string | null;
}

export interface MacroBundle {
  /** FRED series id -> observations (ascending by date, as FRED serves them). */
  core: Record<string, FetchResult<FredObservation[]>>;
  sector: Record<string, FetchResult<FredObservation[]>>;
  /** GICS sector used for series routing (mapped from FMP profile.sector). */
  gicsSector: string | null;
  /** Mandatory FRED attribution string — must be rendered verbatim. */
  attribution: string;
}

export interface TranscriptBundle {
  /** earning-call-transcript-dates rows (date desc). */
  meta: FmpFetch<FmpTranscriptDateRow>;
  /** Latest full transcript (content can be multi-100KB); often a gap. */
  latest: FmpFetch<FmpTranscriptRow>;
}

// ---------------------------------------------------------------------------
// DataBundle
// ---------------------------------------------------------------------------

/**
 * Everything a report run needs, fetched once by buildDataBundle().
 *
 * Deterministic ordering: FMP row arrays are sorted date DESC; provider time
 * series (FRED observations, FINRA trend) stay ascending as their providers
 * deterministically emit them.
 */
export interface DataBundle {
  symbol: string;
  /** ISO timestamp of the bundle build (clock injectable in tests). */
  builtAt: string;

  profile: FmpFetch<FmpProfileRow>;
  quote: FmpFetch<FmpQuoteRow>;
  statements: StatementSet;

  keyMetrics: FmpFetch<FmpKeyMetricsRow>;
  keyMetricsTtm: FmpFetch<FmpKeyMetricsRow>;
  ratios: FmpFetch<FmpRatiosRow>;
  ratiosTtm: FmpFetch<FmpRatiosRow>;
  financialGrowth: FmpFetch<FmpFinancialGrowthRow>;
  financialScores: FmpFetch<FmpFinancialScoresRow>;
  enterpriseValues: FmpFetch<FmpEnterpriseValuesRow>;

  analystEstimates: FmpFetch<FmpAnalystEstimatesRow>;
  priceTargetConsensus: FmpFetch<FmpPriceTargetConsensusRow>;
  priceTargetSummary: FmpFetch<FmpPriceTargetSummaryRow>;
  gradesConsensus: FmpFetch<FmpGradesConsensusRow>;

  /** Past + future earnings rows (future rows carry epsActual=null). */
  earningsHistory: FmpFetch<FmpEarningsRow>;
  /** Derived: first future-dated earnings row (next expected report). */
  earningsCalendarNext: FetchResult<FmpEarningsRow>;

  transcript: TranscriptBundle;

  insiderTrades: FmpFetch<FmpInsiderTradeRow>;
  insiderStats: FmpFetch<FmpInsiderTradeStatisticsRow>;
  institutional: InstitutionalBundle;

  peers: FmpFetch<FmpStockPeerRow>;
  segmentation: {
    product: FmpFetch<FmpSegmentationRow>;
    geographic: FmpFetch<FmpSegmentationRow>;
  };

  executives: FmpFetch<FmpKeyExecutiveRow>;
  compensation: FmpFetch<FmpExecutiveCompensationRow>;

  marketCapHistory: FmpFetch<FmpMarketCapRow>;
  sharesFloat: FmpFetch<FmpSharesFloatRow>;
  secFilings: FmpFetch<FmpSecFilingRow>;
  news: FmpFetch<FmpNewsArticleRow>;
  pressReleases: FmpFetch<FmpNewsArticleRow>;

  /** ~5y daily OHLCV, date desc, split-adjusted close only. */
  eodPrices: FmpFetch<FmpEodBarRow>;
  benchmarkPrices: BenchmarkPrices;

  /** FINRA — asOf is the settlementDate; label staleness (9–24 d inherent). */
  shortInterest: FetchResult<ShortInterestPoint>;
  shortInterestTrend: FetchResult<ShortInterestPoint[]>;

  /** Finnhub MSPR monthly series. */
  insiderSentiment: FetchResult<InsiderSentimentMonth[]>;

  macro: MacroBundle;
  treasury: FmpFetch<FmpTreasuryRatesRow>;
  marketRiskPremium: FmpFetch<FmpMarketRiskPremiumRow>;

  edgar: EdgarBundle;

  /** Bundle member (dot-path) -> asOf ISO date, for the report appendix. */
  asOf: Record<string, string>;
  /** Merged missing-data manifest (deduped, severity-ordered). */
  gaps: ManifestEntry[];
}

// ---------------------------------------------------------------------------
// Shared pure calendar helpers (used by dataBundle.ts AND stageA/validate.ts)
// ---------------------------------------------------------------------------

/** SEC 13F filing deadline: 45 days after calendar quarter end. */
export const THIRTEEN_F_DEADLINE_DAYS = 45;

const DAY_MS = 86_400_000;

/** Calendar quarter end (UTC) as YYYY-MM-DD: Q1=03-31, Q2=06-30, Q3=09-30, Q4=12-31. */
export function quarterEndIso(year: number, quarter: 1 | 2 | 3 | 4): string {
  const ends: Record<1 | 2 | 3 | 4, string> = {
    1: "03-31",
    2: "06-30",
    3: "09-30",
    4: "12-31",
  };
  return `${year}-${ends[quarter]}`;
}

export interface ThirteenFQuarter {
  year: number;
  quarter: 1 | 2 | 3 | 4;
  quarterEnd: string;
}

interface DateBearingRow {
  date?: unknown;
}

/** Resolve 13F coverage from returned rows, falling back to the request cycle. */
export function derive13FCoverage(
  rows: readonly DateBearingRow[],
  fallback: ThirteenFQuarter,
  now: Date,
): ThirteenFQuarter {
  const nowMs = now.getTime();
  const dates = rows
    .map((row) => (typeof row.date === "string" ? row.date.slice(0, 10) : ""))
    .filter((date) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
      const ms = Date.parse(`${date}T00:00:00Z`);
      return Number.isFinite(ms) && ms <= nowMs;
    })
    .sort()
    .reverse();
  const date = dates[0];
  if (date === undefined) return fallback;
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const quarter = (month <= 3 ? 1 : month <= 6 ? 2 : month <= 9 ? 3 : 4) as 1 | 2 | 3 | 4;
  return { year, quarter, quarterEnd: date };
}

/**
 * 13F quarter-resolution rule (DATA_MAP §2.8): the latest calendar quarter
 * whose end is >= 45 days ago — i.e. whose 13F filing deadline has passed, so
 * FMP's Ultimate 13F endpoints (which require explicit year+quarter) should
 * have data. Deterministic given `now`.
 */
export function resolve13FQuarter(now: Date): ThirteenFQuarter {
  const cutoff = now.getTime() - THIRTEEN_F_DEADLINE_DAYS * DAY_MS;
  const startYear = now.getUTCFullYear();
  for (let year = startYear; year >= startYear - 2; year--) {
    for (const quarter of [4, 3, 2, 1] as const) {
      const end = quarterEndIso(year, quarter);
      if (Date.parse(`${end}T00:00:00Z`) <= cutoff) {
        return { year, quarter, quarterEnd: end };
      }
    }
  }
  // Unreachable for any sane clock; satisfy the type system deterministically.
  return { year: startYear - 3, quarter: 4, quarterEnd: quarterEndIso(startYear - 3, 4) };
}

/**
 * Latest calendar quarter end on or before `date` (UTC). Used by the
 * fundamentals-staleness rule in stageA/validate.ts.
 */
export function latestQuarterEndOnOrBefore(date: Date): string {
  const year = date.getUTCFullYear();
  const candidates = [
    quarterEndIso(year - 1, 4),
    quarterEndIso(year, 1),
    quarterEndIso(year, 2),
    quarterEndIso(year, 3),
    quarterEndIso(year, 4),
  ];
  let best = candidates[0];
  for (const c of candidates) {
    if (Date.parse(`${c}T00:00:00Z`) <= date.getTime() && c > best) best = c;
  }
  return best;
}
