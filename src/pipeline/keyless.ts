/**
 * Keyless fallback orchestration — fills the bundle members FMP could not
 * serve from the public sources (SEC EDGAR + Yahoo) that need no API key.
 *
 * Three rules govern everything below:
 *
 *  1. FMP IS NEVER OVERWRITTEN. Only a member that is a gap, or an ok result
 *     carrying zero rows (`needsFallback`), is eligible for replacement. A
 *     vendor row always wins over a derived one.
 *
 *  2. NOTHING IS FABRICATED. Every derived number is computed only from
 *     operands that are actually present. A missing operand skips the row and
 *     adds a note; it never becomes a zero. Where a whole member cannot be
 *     built, FMP's original result stays in place and the keyless failure is
 *     disclosed as its own `warn` gap.
 *
 *  3. EVERY SUBSTITUTION IS DISCLOSED. Each replacement pushes a
 *     `keyless.<member>` manifest entry naming the source, the endpoint or
 *     derivation, and the reason FMP could not serve it. On a plan with no FMP
 *     key those entries are `expected` (a structural condition, not an
 *     incident); on a keyed plan they are not.
 *
 * The module is orchestration only: the statement mapping lives in
 * `@/edgar/statements`, the SIC taxonomy in `@/edgar/sic`, the beta regression
 * in `@/pipeline/stageB/betaEstimate` and the price/quote fetching in
 * `@/providers/yahoo`. `resolveSectorEtf` is passed in rather than imported so
 * this module never depends on `@/pipeline/dataBundle` (which imports it).
 */

import { sectorIndustryForSic } from "@/edgar/sic";
import {
  buildStatementsFromCompanyFacts,
  type BuiltStatements,
  type StatementRowsResult,
} from "@/edgar/statements";
import { conceptFactsSchema, dedupFactPoints, parseFactPoints, type CompanyFacts } from "@/edgar/xbrl";
import { estimateBeta, type ClosePoint } from "@/pipeline/stageB/betaEstimate";
import type { EdgarRegistrant } from "@/pipeline/types";
import type { CikMapping } from "@/providers/edgar";
import type {
  FmpBalanceSheetRow,
  FmpCashFlowRow,
  FmpEnterpriseValuesRow,
  FmpEodBarRow,
  FmpIncomeStatementRow,
  FmpMarketCapRow,
  FmpPayload,
  FmpProfileRow,
  FmpQuoteRow,
  FmpRawRow,
  FmpSharesFloatRow,
} from "@/providers/fmp";
import type { YahooClient, YahooMeta } from "@/providers/yahoo";
import type { DataSource, FetchResult, ManifestEntry } from "@/types/core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface KeylessMembers {
  profile: FetchResult<FmpPayload<FmpProfileRow>>;
  quote: FetchResult<FmpPayload<FmpQuoteRow>>;
  incomeAnnual: FetchResult<FmpPayload<FmpIncomeStatementRow>>;
  incomeQuarterly: FetchResult<FmpPayload<FmpIncomeStatementRow>>;
  balanceAnnual: FetchResult<FmpPayload<FmpBalanceSheetRow>>;
  balanceQuarterly: FetchResult<FmpPayload<FmpBalanceSheetRow>>;
  cashflowAnnual: FetchResult<FmpPayload<FmpCashFlowRow>>;
  cashflowQuarterly: FetchResult<FmpPayload<FmpCashFlowRow>>;
  eodPrices: FetchResult<FmpPayload<FmpEodBarRow>>;
  spy: FetchResult<FmpPayload<FmpEodBarRow>>;
  sectorEtf: FetchResult<FmpPayload<FmpEodBarRow>>;
  enterpriseValues: FetchResult<FmpPayload<FmpEnterpriseValuesRow>>;
  marketCapHistory: FetchResult<FmpPayload<FmpMarketCapRow>>;
  sharesFloat: FetchResult<FmpPayload<FmpSharesFloatRow>>;
}

export interface KeylessInputs {
  symbol: string;
  /** YYYY-MM-DD */
  today: string;
  /** YYYY-MM-DD — start of the EOD history window. */
  eodFrom: string;
  /** Resolved by the caller from the FMP sector, or null. */
  sectorEtfSymbol: string | null;
  /** FMP's results (ok, gap, or ok-but-empty). */
  fmp: KeylessMembers;
  /** No FMP key configured → the substitution gaps are `expected`. */
  fmpKeyless: boolean;
  edgar: {
    cik: FetchResult<CikMapping>;
    registrant: EdgarRegistrant | null;
    companyFacts: FetchResult<CompanyFacts>;
  };
  yahoo: YahooClient;
  annualPeriods: number;
  quarterlyPeriods: number;
  now: () => Date;
  /**
   * `resolveSectorEtf` from `@/pipeline/dataBundle`, injected: importing it
   * here would close an import cycle (dataBundle → keyless → dataBundle).
   */
  resolveSectorEtf: (sector: string | null) => string | null;
}

export interface KeylessOutcome {
  members: KeylessMembers;
  /** Sector ETF symbol resolved from the keyless profile when FMP had none. */
  sectorEtfSymbol: string | null;
  gaps: ManifestEntry[];
  notes: string[];
  /** Members actually replaced, for progress logging. */
  replaced: (keyof KeylessMembers)[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATEMENT_ENDPOINTS = {
  incomeAnnual: "companyfacts→income-statement(annual)",
  incomeQuarterly: "companyfacts→income-statement(quarter)",
  balanceAnnual: "companyfacts→balance-sheet(annual)",
  balanceQuarterly: "companyfacts→balance-sheet(quarter)",
  cashflowAnnual: "companyfacts→cash-flow(annual)",
  cashflowQuarterly: "companyfacts→cash-flow(quarter)",
} as const;

const PROFILE_ENDPOINT = "derived:profile(edgar:submissions + yahoo:chart + dei:shares)";
const ENTERPRISE_VALUES_ENDPOINT = "derived:enterprise-values(balance×close×shares)";
const MARKET_CAP_ENDPOINT = "derived:market-cap(close×dei:shares)";
const SHARES_FLOAT_ENDPOINT = "companyfacts→shares-float(dei:EntityCommonStockSharesOutstanding + dei:EntityPublicFloat)";

const DEI_SHARES_TAG = "EntityCommonStockSharesOutstanding";

/**
 * A cover-page share count is dated a few weeks AFTER the fiscal period it
 * accompanies (the 10-Q cover states shares outstanding at the filing date).
 * Allowing 60 days lets the quarter that a cover page belongs to claim it,
 * while a cover page from the NEXT quarter stays out of reach.
 */
const DEI_COVER_LAG_DAYS = 60;

const DAY_MS = 86_400_000;

/** The 50 states, DC, and the five inhabited territories. */
const US_JURISDICTIONS: ReadonlySet<string> = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC", "PR", "VI", "GU", "AS", "MP",
]);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Any member's result, widened for the member-agnostic bookkeeping helpers. */
type AnyMemberResult = FetchResult<FmpPayload<FmpRawRow>>;

/** A gap, or an ok result with no rows: both mean FMP served nothing usable. */
export function needsFallback<T extends FmpRawRow>(result: FetchResult<FmpPayload<T>>): boolean {
  return !result.ok || result.value.data.rows.length === 0;
}

function fmpReason(result: AnyMemberResult): string {
  return result.ok ? "returned no rows" : result.gap.reason;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isoDay(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 10) return null;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(ms)) return date;
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

/** Newest row date, for the `asOf` of a derived payload. */
function newestDate(rows: readonly FmpRawRow[], fallback: string): string {
  let newest: string | null = null;
  for (const row of rows) {
    const day = isoDay(row["date"]);
    if (day !== null && (newest === null || day > newest)) newest = day;
  }
  return newest ?? fallback;
}

function sourced<T extends FmpRawRow>(
  rows: T[],
  source: DataSource,
  endpoint: string,
  asOf: string,
  fetchedAt: string,
): FetchResult<FmpPayload<T>> {
  return { ok: true, value: { data: { rows, raw: null }, asOf, source, endpoint, fetchedAt } };
}

/**
 * Last usable close at or before `date`. `rowsDesc` is FMP's newest-first EOD
 * ordering; a bar with no close is skipped rather than read as zero.
 */
export function lastCloseOnOrBefore(rowsDesc: readonly FmpEodBarRow[], date: string): number | null {
  let best: { date: string; close: number } | null = null;
  for (const row of rowsDesc) {
    const day = isoDay(row.date);
    if (day === null || day > date) continue;
    if (!isFiniteNumber(row.close)) continue;
    if (best === null || day > best.date) best = { date: day, close: row.close };
  }
  return best === null ? null : best.close;
}

/**
 * The cover-page share count in force on `date`: the latest cover date at or
 * before it, else the earliest one known (a bar older than the first cover page
 * is priced on the oldest count we have rather than dropped).
 */
export function sharesOnOrBefore(
  points: readonly { value: number; asOf: string }[],
  date: string,
): number | null {
  let earliest: { value: number; asOf: string } | null = null;
  let latestOnOrBefore: { value: number; asOf: string } | null = null;
  for (const point of points) {
    if (earliest === null || point.asOf < earliest.asOf) earliest = point;
    if (point.asOf <= date && (latestOnOrBefore === null || point.asOf > latestOnOrBefore.asOf)) {
      latestOnOrBefore = point;
    }
  }
  const chosen = latestOnOrBefore ?? earliest;
  return chosen === null ? null : chosen.value;
}

/** True for a two-letter US state, DC or territory code (EDGAR's stateOfIncorporation). */
export function isUsJurisdiction(code: string | null | undefined): boolean {
  return typeof code === "string" && US_JURISDICTIONS.has(code.trim().toUpperCase());
}

/**
 * The dei cover-page share-count series (deduped by the critical rule), oldest
 * first. `BuiltStatements.shares` exposes only the latest point; the market-cap
 * history and enterprise values need the whole series.
 */
export function deiSharePoints(facts: CompanyFacts): { value: number; asOf: string }[] {
  const namespace = facts.facts["dei"];
  if (namespace === null || namespace === undefined || typeof namespace !== "object") return [];
  const raw = (namespace as Record<string, unknown>)[DEI_SHARES_TAG];
  if (raw === undefined) return [];
  const parsed = conceptFactsSchema.safeParse(raw);
  if (!parsed.success) return [];
  const unitPoints = parsed.data.units["shares"];
  if (!Array.isArray(unitPoints)) return [];
  return dedupFactPoints(parseFactPoints(unitPoints))
    .flatMap((point) => {
      const day = isoDay(point.end);
      return day !== null && isFiniteNumber(point.val) && point.val > 0
        ? [{ value: point.val, asOf: day }]
        : [];
    })
    .sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0));
}

function closePoints(rows: readonly FmpEodBarRow[]): ClosePoint[] {
  return rows.flatMap((row) => {
    const day = isoDay(row.date);
    return day !== null && isFiniteNumber(row.close) ? [{ date: day, close: row.close }] : [];
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function applyKeylessFallbacks(inputs: KeylessInputs): Promise<KeylessOutcome> {
  const members: KeylessMembers = { ...inputs.fmp };
  const gaps: ManifestEntry[] = [];
  const notes: string[] = [];
  const replaced: (keyof KeylessMembers)[] = [];

  // Without a CIK there is no registrant, no companyfacts and no basis for
  // trusting that a Yahoo symbol is the same issuer. Nothing is attempted.
  if (!inputs.edgar.cik.ok) {
    notes.push(
      `keyless fallbacks skipped: EDGAR did not resolve ${inputs.symbol} to a registrant`,
    );
    return { members, sectorEtfSymbol: inputs.sectorEtfSymbol, gaps, notes, replaced };
  }

  const fetchedAt = inputs.now().toISOString();
  const cik10 = inputs.edgar.cik.value.data.cik10;
  const registrant = inputs.edgar.registrant;

  const needs = (member: keyof KeylessMembers): boolean =>
    needsFallback(inputs.fmp[member] as AnyMemberResult);

  /** A member was served from a keyless source: disclose what replaced what. */
  const record = (member: keyof KeylessMembers, source: DataSource, endpoint: string): void => {
    replaced.push(member);
    gaps.push({
      field: `keyless.${member}`,
      reason: `served by ${source} (${endpoint}) because FMP ${fmpReason(inputs.fmp[member] as AnyMemberResult)}`,
      severity: "info",
      expected: inputs.fmpKeyless,
    });
  };

  /**
   * The keyless source could not serve the member either. FMP's result stays
   * in place — extended with where else we looked — and the failure is its own
   * `warn` gap. `appendReason` is set for the statements, whose single
   * companyfacts attempt covers all six members at once.
   */
  const failKeyless = (
    member: keyof KeylessMembers,
    reason: string,
    attemptedSources: string[],
    appendReason = false,
  ): void => {
    const original = inputs.fmp[member] as AnyMemberResult;
    if (!original.ok) {
      const extended: AnyMemberResult = {
        ok: false,
        gap: {
          ...original.gap,
          reason: appendReason ? `${original.gap.reason}; ${reason}` : original.gap.reason,
          attemptedSources: [...(original.gap.attemptedSources ?? []), ...attemptedSources],
        },
      };
      // The member keeps FMP's own row type; only the gap branch is rewritten,
      // which carries no rows at all.
      (members as unknown as Record<string, AnyMemberResult>)[member] = extended;
    }
    gaps.push({ field: `keyless.${member}`, reason, severity: "warn", attemptedSources });
  };

  /** Wrap a keyless fetch so a rejected promise can never escape as a throw. */
  const attempt = async <T>(field: string, run: () => Promise<FetchResult<T>>): Promise<FetchResult<T>> => {
    try {
      return await run();
    } catch (err) {
      return {
        ok: false,
        gap: {
          field,
          reason: `keyless source threw: ${errorMessage(err)}`,
          severity: "warn",
          attemptedSources: [field],
        },
      };
    }
  };

  const attemptedOf = (gap: ManifestEntry): string[] => [gap.field, ...(gap.attemptedSources ?? [])];

  // --- Statements: one companyfacts build feeds all six members -------------

  const factsOk = inputs.edgar.companyFacts.ok;
  const built: BuiltStatements | null = factsOk
    ? buildStatementsFromCompanyFacts(inputs.edgar.companyFacts.value.data, {
        symbol: inputs.symbol,
        cik: cik10,
        annualPeriods: inputs.annualPeriods,
        quarterlyPeriods: inputs.quarterlyPeriods,
      })
    : null;
  const factsFetchedAt = inputs.edgar.companyFacts.ok
    ? inputs.edgar.companyFacts.value.fetchedAt
    : fetchedAt;
  const factsReason = inputs.edgar.companyFacts.ok ? null : inputs.edgar.companyFacts.gap.reason;

  const statementFor = <TRow extends FmpRawRow>(
    member: keyof KeylessMembers,
    result: StatementRowsResult<TRow> | null,
    endpoint: string,
  ): FetchResult<FmpPayload<TRow>> | null => {
    if (!needs(member)) return null;
    if (result === null) {
      failKeyless(
        member,
        `EDGAR companyfacts unavailable: ${factsReason ?? "not fetched"}`,
        ["edgar:companyfacts"],
        true,
      );
      return null;
    }
    for (const note of result.notes) notes.push(`${member}: ${note}`);
    if (result.rows.length === 0) {
      const why = result.gaps[0]?.reason ?? "no period resolved from the filed facts";
      failKeyless(member, `EDGAR companyfacts produced no ${member} rows: ${why}`, ["edgar:companyfacts", endpoint], true);
      return null;
    }
    record(member, "edgar", endpoint);
    return sourced(result.rows, "edgar", endpoint, newestDate(result.rows, factsFetchedAt.slice(0, 10)), factsFetchedAt);
  };

  const incomeAnnual = statementFor("incomeAnnual", built?.incomeAnnual ?? null, STATEMENT_ENDPOINTS.incomeAnnual);
  if (incomeAnnual !== null) members.incomeAnnual = incomeAnnual;
  const incomeQuarterly = statementFor("incomeQuarterly", built?.incomeQuarterly ?? null, STATEMENT_ENDPOINTS.incomeQuarterly);
  if (incomeQuarterly !== null) members.incomeQuarterly = incomeQuarterly;
  const balanceAnnual = statementFor("balanceAnnual", built?.balanceAnnual ?? null, STATEMENT_ENDPOINTS.balanceAnnual);
  if (balanceAnnual !== null) members.balanceAnnual = balanceAnnual;
  const balanceQuarterly = statementFor("balanceQuarterly", built?.balanceQuarterly ?? null, STATEMENT_ENDPOINTS.balanceQuarterly);
  if (balanceQuarterly !== null) members.balanceQuarterly = balanceQuarterly;
  const cashflowAnnual = statementFor("cashflowAnnual", built?.cashflowAnnual ?? null, STATEMENT_ENDPOINTS.cashflowAnnual);
  if (cashflowAnnual !== null) members.cashflowAnnual = cashflowAnnual;
  const cashflowQuarterly = statementFor("cashflowQuarterly", built?.cashflowQuarterly ?? null, STATEMENT_ENDPOINTS.cashflowQuarterly);
  if (cashflowQuarterly !== null) members.cashflowQuarterly = cashflowQuarterly;

  // --- Yahoo: every needed series and the quote in one concurrent round ------

  const classification = sectorIndustryForSic(registrant?.sic ?? null);
  const sectorEtfSymbol = inputs.sectorEtfSymbol ?? inputs.resolveSectorEtf(classification.sector);

  const wantHistory = needs("eodPrices");
  const wantSpy = needs("spy");
  const wantSectorEtf = needs("sectorEtf") && sectorEtfSymbol !== null;
  const wantProfile = needs("profile");
  const wantQuote = needs("quote");

  const [history, spy, sectorEtf, metaResult] = await Promise.all([
    wantHistory
      ? attempt(`yahoo.dailyHistory(${inputs.symbol})`, () => inputs.yahoo.dailyHistory(inputs.symbol, inputs.eodFrom, inputs.today))
      : null,
    wantSpy
      ? attempt("yahoo.dailyHistory(SPY)", () => inputs.yahoo.dailyHistory("SPY", inputs.eodFrom, inputs.today))
      : null,
    wantSectorEtf && sectorEtfSymbol !== null
      ? attempt(`yahoo.dailyHistory(${sectorEtfSymbol})`, () => inputs.yahoo.dailyHistory(sectorEtfSymbol, inputs.eodFrom, inputs.today))
      : null,
    wantProfile ? attempt(`yahoo.meta(${inputs.symbol})`, () => inputs.yahoo.meta(inputs.symbol)) : null,
  ]);
  // `quote()` is `meta()` plus a row mapping: both read the SAME chart request
  // (range=5d&interval=1d), so issuing them together would race two identical
  // requests to an unofficial endpoint. Sequencing the quote AFTER the meta
  // lets it resolve from the durable cache the first one just populated. The
  // three history series stay concurrent above — they are distinct requests.
  const quoteResult = wantQuote
    ? await attempt(`yahoo.quote(${inputs.symbol})`, () => inputs.yahoo.quote(inputs.symbol))
    : null;

  const takeHistory = (
    member: "eodPrices" | "spy" | "sectorEtf",
    result: FetchResult<FmpPayload<FmpEodBarRow>> | null,
  ): void => {
    if (result === null) return;
    if (result.ok) {
      members[member] = result;
      record(member, result.value.source, result.value.endpoint);
      return;
    }
    failKeyless(member, `keyless price history failed: ${result.gap.reason}`, attemptedOf(result.gap));
  };
  takeHistory("eodPrices", history);
  takeHistory("spy", spy);
  takeHistory("sectorEtf", sectorEtf);
  if (needs("sectorEtf") && sectorEtfSymbol === null) {
    failKeyless(
      "sectorEtf",
      `no sector ETF resolved: the registrant's SIC maps to sector ${classification.sector ?? "unknown"}`,
      ["edgar:submissions.sic"],
    );
  }

  // Post-fallback prices: FMP's rows when it had them, otherwise Yahoo's.
  const eodRows = members.eodPrices.ok ? members.eodPrices.value.data.rows : [];
  const spyRows = members.spy.ok ? members.spy.value.data.rows : [];
  const meta: YahooMeta | null = metaResult !== null && metaResult.ok ? metaResult.value.data : null;
  const quotePrice =
    quoteResult !== null && quoteResult.ok && isFiniteNumber(quoteResult.value.data.rows[0]?.price)
      ? quoteResult.value.data.rows[0].price
      : null;
  const price = meta?.regularMarketPrice ?? quotePrice ?? lastCloseOnOrBefore(eodRows, inputs.today);
  const outstanding = built?.shares.outstanding ?? null;
  const marketCap = price !== null && outstanding !== null ? price * outstanding.value : null;
  const deiShares = inputs.edgar.companyFacts.ok
    ? deiSharePoints(inputs.edgar.companyFacts.value.data)
    : [];

  // --- Profile --------------------------------------------------------------

  if (wantProfile) {
    if (registrant === null) {
      failKeyless(
        "profile",
        "no EDGAR registrant (submissions payload unavailable): a keyless profile has no name, exchange or jurisdiction",
        ["edgar:submissions"],
      );
    } else {
      const beta = estimateBeta(closePoints(eodRows), closePoints(spyRows));
      if (beta.gap !== null) gaps.push(beta.gap);
      notes.push(`profile: ${beta.note}`);
      // A registrant name in EDGAR's all-caps house style reads poorly in a
      // report; Yahoo's longName is the cased version of the same entity.
      const allCaps = registrant.name === registrant.name.toUpperCase() && /[A-Z]/.test(registrant.name);
      const row: Record<string, unknown> = {
        symbol: inputs.symbol,
        companyName: allCaps && meta?.longName != null ? meta.longName : registrant.name,
        cik: cik10,
        sector: classification.sector,
        industry: classification.industry,
        exchange: meta?.exchangeName ?? registrant.exchanges[0] ?? null,
        exchangeFullName: meta?.fullExchangeName ?? null,
        currency: meta?.currency ?? built?.reportedCurrency ?? null,
        country: isUsJurisdiction(registrant.stateOfIncorporation) ? "US" : null,
        ipoDate: meta?.firstTradeDate ?? null,
        price,
        marketCap,
        beta: beta.beta,
        isEtf: false,
        isFund: false,
        // The statements builder reads the form on the facts it actually used,
        // so `filesTwentyF` describes the periods this profile reports. The
        // submissions form list is only a fallback for when no statements could
        // be built at all: it spans up to a thousand recent filings, so a single
        // historical 20-F would otherwise flag an issuer that has since
        // converted to domestic 10-K reporting as an ADR forever.
        isAdr: built !== null
          ? built.filesTwentyF
          : registrant.forms.some((form) => form.trim().startsWith("20-F")),
        isActivelyTrading: true,
        description: null,
        ceo: null,
        website: null,
        fullTimeEmployees: null,
      };
      // Same escape hatch the statements builder uses: an FMP row type declares
      // its fields optional-and-non-null, but "filed nothing" must stay an
      // explicit null rather than a 0 or a dropped key.
      const profileRow = row as FmpProfileRow;
      const asOf = metaResult !== null && metaResult.ok ? metaResult.value.asOf : inputs.today;
      members.profile = sourced([profileRow], "computed", PROFILE_ENDPOINT, asOf, fetchedAt);
      record("profile", "computed", PROFILE_ENDPOINT);
    }
  }

  // --- Quote ----------------------------------------------------------------

  if (quoteResult !== null) {
    if (quoteResult.ok) {
      // Yahoo's chart meta has no share count, so the market cap is EDGAR's.
      const rows = quoteResult.value.data.rows.map((quoteRow) =>
        outstanding !== null && isFiniteNumber(quoteRow.price)
          ? { ...quoteRow, marketCap: quoteRow.price * outstanding.value }
          : quoteRow,
      );
      members.quote = {
        ok: true,
        value: { ...quoteResult.value, data: { ...quoteResult.value.data, rows } },
      };
      record("quote", quoteResult.value.source, quoteResult.value.endpoint);
    } else {
      failKeyless("quote", `keyless quote failed: ${quoteResult.gap.reason}`, attemptedOf(quoteResult.gap));
    }
  }

  // --- Enterprise values ----------------------------------------------------

  if (needs("enterpriseValues")) {
    const balanceRows = members.balanceQuarterly.ok ? members.balanceQuarterly.value.data.rows : [];
    const incomeRows = members.incomeQuarterly.ok ? members.incomeQuarterly.value.data.rows : [];
    const dilutedByDate = new Map<string, unknown>();
    for (const incomeRow of incomeRows) {
      const day = isoDay(incomeRow.date);
      if (day !== null) dilutedByDate.set(day, incomeRow.weightedAverageShsOutDil);
    }
    const rows: FmpEnterpriseValuesRow[] = [];
    for (const balanceRow of balanceRows) {
      const date = isoDay(balanceRow.date);
      if (date === null) continue;
      const stockPrice = lastCloseOnOrBefore(eodRows, date);
      const diluted = dilutedByDate.get(date);
      const numberOfShares = isFiniteNumber(diluted) && diluted > 0
        ? diluted
        : sharesOnOrBefore(deiShares, addDays(date, DEI_COVER_LAG_DAYS));
      const addTotalDebt = isFiniteNumber(balanceRow.totalDebt) ? balanceRow.totalDebt : null;
      const minusCash = isFiniteNumber(balanceRow.cashAndCashEquivalents)
        ? balanceRow.cashAndCashEquivalents
        : null;
      const missing: string[] = [];
      if (stockPrice === null) missing.push("a close on or before the period end");
      if (numberOfShares === null) missing.push("a share count");
      if (addTotalDebt === null) missing.push("totalDebt");
      if (minusCash === null) missing.push("cashAndCashEquivalents");
      if (stockPrice === null || numberOfShares === null || addTotalDebt === null || minusCash === null) {
        notes.push(`keyless enterprise value ${date} skipped: no ${missing.join(", no ")}`);
        continue;
      }
      const marketCapitalization = stockPrice * numberOfShares;
      rows.push({
        symbol: inputs.symbol,
        date,
        stockPrice,
        numberOfShares,
        marketCapitalization,
        addTotalDebt,
        minusCashAndCashEquivalents: minusCash,
        enterpriseValue: marketCapitalization + addTotalDebt - minusCash,
      });
    }
    if (rows.length === 0) {
      failKeyless(
        "enterpriseValues",
        `no quarterly period had all of price, shares, totalDebt and cash (${balanceRows.length} balance-sheet period${balanceRows.length === 1 ? "" : "s"} considered)`,
        ["computed:enterprise-values"],
      );
    } else {
      members.enterpriseValues = sourced(rows, "computed", ENTERPRISE_VALUES_ENDPOINT, newestDate(rows, inputs.today), fetchedAt);
      record("enterpriseValues", "computed", ENTERPRISE_VALUES_ENDPOINT);
    }
  }

  // --- Market-cap history ---------------------------------------------------

  if (needs("marketCapHistory")) {
    const rows: FmpMarketCapRow[] = [];
    for (const bar of eodRows) {
      const date = isoDay(bar.date);
      if (date === null || !isFiniteNumber(bar.close)) continue;
      const shares = sharesOnOrBefore(deiShares, date);
      if (shares === null) continue;
      rows.push({ symbol: inputs.symbol, date, marketCap: bar.close * shares });
    }
    if (rows.length === 0) {
      failKeyless(
        "marketCapHistory",
        `no market-cap history: ${eodRows.length} price bar${eodRows.length === 1 ? "" : "s"} and ${deiShares.length} dei share observation${deiShares.length === 1 ? "" : "s"}`,
        ["computed:market-cap"],
      );
    } else {
      members.marketCapHistory = sourced(rows, "computed", MARKET_CAP_ENDPOINT, newestDate(rows, inputs.today), fetchedAt);
      record("marketCapHistory", "computed", MARKET_CAP_ENDPOINT);
    }
  }

  // --- Shares float ---------------------------------------------------------

  if (needs("sharesFloat")) {
    if (outstanding === null) {
      failKeyless(
        "sharesFloat",
        `no dei:${DEI_SHARES_TAG} cover-page share count in companyfacts`,
        ["edgar:companyfacts"],
      );
    } else {
      // EntityPublicFloat is a DOLLAR amount; only a price turns it into shares.
      const publicFloat = built?.shares.publicFloat ?? null;
      const floatShares = publicFloat !== null && price !== null && price > 0 ? publicFloat.value / price : null;
      const freeFloat = floatShares !== null && outstanding.value > 0 ? (floatShares / outstanding.value) * 100 : null;
      const row: Record<string, unknown> = {
        symbol: inputs.symbol,
        date: outstanding.asOf,
        outstandingShares: outstanding.value,
        floatShares,
        freeFloat,
        source: "edgar",
      };
      members.sharesFloat = sourced([row as FmpSharesFloatRow], "edgar", SHARES_FLOAT_ENDPOINT, outstanding.asOf, factsFetchedAt);
      record("sharesFloat", "edgar", SHARES_FLOAT_ENDPOINT);
    }
  }

  return { members, sectorEtfSymbol, gaps, notes, replaced };
}
