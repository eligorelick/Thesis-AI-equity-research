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
  BALANCE_SHEET_SHARES_TAG,
  buildStatementsFromCompanyFacts,
  RESTATEMENT_THRESHOLD_PCT,
  type BuiltStatements,
  type SharesBasis,
  type StatementRowsResult,
} from "@/edgar/statements";
import { conceptFactsSchema, dedupFactPoints, parseFactPoints, type CompanyFacts } from "@/edgar/xbrl";
import { describeSplitRatio, discoverStockSplits, SPLIT_RATIO_TAG, type SplitEvent } from "@/edgar/splits";
import { estimateBeta, type ClosePoint } from "@/pipeline/stageB/betaEstimate";
import type { EdgarRegistrant } from "@/pipeline/types";
import type { CikMapping } from "@/providers/edgar";
import { isPlanLimited } from "@/providers/fmp";
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
import type { StatementSource } from "@/config/env";
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
  /**
   * WS4 (D-12) statement-history policy, from `THESIS_STATEMENT_SOURCE`:
   *  - `auto`: FMP first, then EDGAR companyfacts for periods older than the
   *    oldest FMP row (a plan that caps `limit` truncates history);
   *  - `fmp`: never backfill;
   *  - `edgar`: ignore FMP's statement rows and build all six members from
   *    companyfacts.
   * No period ever mixes sources: a backfilled row is whole and carries
   * `source: "edgar"`.
   */
  statementSource: StatementSource;
  /**
   * SEC independently tied this ticker to this registrant — either its own
   * ticker table made the match, or it answered for the CIK with submissions or
   * companyfacts.
   *
   * When false, only the members that assert NOTHING about the issuer are
   * eligible: the SPY and sector-ETF benchmark series are the same instruments
   * whoever the company turns out to be. Everything else — the profile, the
   * quote, the statements, the company's own price history and every figure
   * derived from them — would be publishing "this is that issuer's data" on the
   * strength of a ticker string alone, so those members keep FMP's result and
   * no gap is filed for a substitution that was never attempted.
   */
  edgarConfirmedIssuer: boolean;
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

/** The members `THESIS_STATEMENT_SOURCE` governs. */
const STATEMENT_MEMBERS = Object.keys(STATEMENT_ENDPOINTS) as (keyof typeof STATEMENT_ENDPOINTS)[];

const ENTERPRISE_VALUES_ENDPOINT = "derived:enterprise-values(balance×close×shares)";
/**
 * The profile and market-cap-history endpoints name the share concept that
 * actually served the count. A per-class reporter has no dei cover count, so
 * claiming `dei:shares` there would be a false provenance string in the
 * sources appendix — the same rule the shares-float endpoint follows.
 */
/** A manifest reason lists at most this many restated lines before summarising. */
const MAX_LISTED_RESTATEMENTS = 6;

function sharesConcept(basis: SharesBasis | null): string {
  return basis === "balance sheet CommonStockSharesOutstanding" ? `us-gaap:${BALANCE_SHEET_SHARES_TAG}` : "dei:shares";
}
function profileEndpoint(basis: SharesBasis | null): string {
  return `derived:profile(edgar:submissions + yahoo:chart + ${sharesConcept(basis)})`;
}
function marketCapEndpoint(basis: SharesBasis | null): string {
  return `derived:market-cap(close×${sharesConcept(basis)})`;
}
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
 * One share-count concept as a deduped series, oldest first; empty when absent.
 * Each point is carried to the current share basis by the splits dated after
 * its own filing (`factorFor`), the same rule `src/edgar/statements.ts`
 * applies: a cover count filed before a 4-for-1 split is a quarter of today's
 * share count, and the daily market-cap history would be a quarter short.
 */
function sharePointsForConcept(
  facts: CompanyFacts,
  namespaceName: string,
  tag: string,
  instantOnly: boolean,
  factorFor: (filed: string) => number,
): { value: number; asOf: string }[] {
  const namespace = facts.facts[namespaceName];
  if (namespace === null || namespace === undefined || typeof namespace !== "object") return [];
  const raw = (namespace as Record<string, unknown>)[tag];
  if (raw === undefined) return [];
  const parsed = conceptFactsSchema.safeParse(raw);
  if (!parsed.success) return [];
  const unitPoints = parsed.data.units["shares"];
  if (!Array.isArray(unitPoints)) return [];
  return dedupFactPoints(parseFactPoints(unitPoints))
    .flatMap((point) => {
      if (instantOnly && point.start !== undefined) return [];
      const day = isoDay(point.end);
      return day !== null && isFiniteNumber(point.val) && point.val > 0
        ? [{ value: Math.round(point.val * factorFor(point.filed)), asOf: day }]
        : [];
    })
    .sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0));
}

/**
 * The share-count series the market-cap history and enterprise values need
 * (`BuiltStatements.shares` exposes only the latest point), oldest first.
 *
 * The dei cover-page concept comes first, and `us-gaap:CommonStockSharesOutstanding`
 * is the fallback: a per-class reporter (GOOGL, BRK.B, FOXA) files its cover
 * counts DIMENSIONED by share class, companyfacts carries no dimensional facts,
 * so the dei concept is absent for them entirely while the non-dimensional
 * balance-sheet total — all classes combined — is present. Without the fallback
 * those issuers get no market cap, enterprise value or market-cap history at
 * all. Same-`end` duplicates are refilings and stay deduped by max(`filed`);
 * they are never summed.
 */
export function sharesOutstandingSeries(facts: CompanyFacts): {
  points: { value: number; asOf: string }[];
  basis: SharesBasis | null;
  /** The stock splits the pre-split points were carried across, oldest first. */
  splits: SplitEvent[];
} {
  const splits = discoverStockSplits(facts);
  const cover = sharePointsForConcept(facts, "dei", DEI_SHARES_TAG, false, splits.factorFor);
  if (cover.length > 0) return { points: cover, basis: "dei cover page", splits: splits.events };
  const balanceSheet = sharePointsForConcept(facts, "us-gaap", BALANCE_SHEET_SHARES_TAG, true, splits.factorFor);
  return balanceSheet.length > 0
    ? { points: balanceSheet, basis: "balance sheet CommonStockSharesOutstanding", splits: splits.events }
    : { points: [], basis: null, splits: splits.events };
}

/**
 * Instrument classification for the profile's `isEtf`/`isFund` flags, from
 * Yahoo's chart meta (`EQUITY`, `ETF`, `MUTUALFUND`, `INDEX`, `CRYPTOCURRENCY`,
 * `CURRENCY`, `FUTURE`, `OPTION`, and the rare `CLOSEDEND`).
 *
 * When the meta is unavailable the flags stay false — the profile still has to
 * say something — but "not classified" is filed as an `info` gap rather than
 * silently read downstream as "this is a company".
 */
export function classifyInstrument(meta: YahooMeta | null): {
  isEtf: boolean;
  isFund: boolean;
  note: string | null;
  gap: ManifestEntry | null;
} {
  const type = meta?.instrumentType ?? null;
  if (type === null) {
    return {
      isEtf: false,
      isFund: false,
      note: null,
      gap: {
        field: "profile.instrumentType",
        reason:
          "instrument type not classified — Yahoo meta unavailable; treated as a company",
        severity: "info",
        attemptedSources: ["yahoo:chart(meta.instrumentType)"],
      },
    };
  }
  const normalized = type.trim().toUpperCase();
  return {
    isEtf: normalized === "ETF",
    isFund: normalized === "MUTUALFUND" || normalized === "CLOSEDEND",
    note: `instrument type ${normalized} (Yahoo chart meta)`,
    gap: null,
  };
}

function closePoints(rows: readonly FmpEodBarRow[]): ClosePoint[] {
  return rows.flatMap((row) => {
    const day = isoDay(row.date);
    if (day === null || !isFiniteNumber(row.close)) return [];
    // Yahoo's chart carries `adjClose` (dividend-adjusted); FMP's EOD endpoint
    // does not. The beta estimator uses it only when BOTH series have it, so
    // passing it through unconditionally is safe: a missing one degrades the
    // whole regression to closing prices with a disclosure, never silently.
    const adjClose = row["adjClose"];
    return [{ date: day, close: row.close, adjClose: isFiniteNumber(adjClose) ? adjClose : null }];
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

  /**
   * Every member except the two benchmark series. Substituting one of these
   * publishes a claim about WHICH COMPANY the data belongs to, so each needs
   * `edgarConfirmedIssuer`. `spy` and `sectorEtf` are index instruments that
   * belong to no issuer, so they stay eligible either way.
   */
  const issuerBound = (member: keyof KeylessMembers): boolean =>
    member !== "spy" && member !== "sectorEtf";

  /**
   * WS4 (D-12): `THESIS_STATEMENT_SOURCE=edgar` rebuilds the six statement
   * members from companyfacts even when FMP served rows, so a reader who
   * distrusts the vendor's normalisation can run on filed facts alone. It never
   * lifts the issuer gate.
   */
  const statementsFromEdgarOnly =
    inputs.statementSource === "edgar" && (STATEMENT_MEMBERS as readonly string[]).length > 0;
  const needs = (member: keyof KeylessMembers): boolean =>
    (inputs.edgarConfirmedIssuer || !issuerBound(member)) &&
    (needsFallback(inputs.fmp[member] as AnyMemberResult) ||
      (statementsFromEdgarOnly && (STATEMENT_MEMBERS as readonly string[]).includes(member)));

  if (!inputs.edgarConfirmedIssuer) {
    notes.push(
      `keyless fallbacks limited to the benchmark series: EDGAR did not confirm ${inputs.symbol} as a registrant, so no member that would assert an issuer identity was attempted`,
    );
  }

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

  // Every consumer of `built` (the six statements, the profile, the derived
  // capitalization members) is issuer-bound, so an unconfirmed issuer skips the
  // whole build rather than doing the work and discarding it.
  const built: BuiltStatements | null = inputs.edgar.companyFacts.ok && inputs.edgarConfirmedIssuer
    ? buildStatementsFromCompanyFacts(inputs.edgar.companyFacts.value.data, {
        symbol: inputs.symbol,
        cik: cik10,
        annualPeriods: inputs.annualPeriods,
        quarterlyPeriods: inputs.quarterlyPeriods,
      })
    : null;
  // A split restatement changes every per-share and share-count figure the
  // report will cite, and a ratio that could NOT be applied leaves the series
  // on mixed share bases; both belong in the manifest, not only in the
  // transient progress log the statement notes reach.
  if (built !== null) {
    // One field per split date: the manifest dedups by field.
    for (const note of built.splits.notes) {
      gaps.push({
        field: `keyless.stockSplits(${note.date})`,
        reason: note.text,
        severity: note.severity,
        attemptedSources: [`edgar:companyfacts us-gaap/${SPLIT_RATIO_TAG}`],
        expected: note.severity === "info",
      });
    }
  }
  // A multi-class filer reports the cover-page count ONCE PER CLASS in the same
  // filing; companyfacts drops the class dimension, so the classes arrive as
  // several unnamed facts sharing an accession and a date. They are summed —
  // taking any single one would understate the count, and understating shares
  // overstates every per-share figure — and the sum is disclosed with its parts.
  const coverClasses = built?.shares.outstanding?.classes ?? null;
  if (built !== null && coverClasses !== null && coverClasses.length > 1) {
    const point = built.shares.outstanding!;
    const filing = point.filing;
    gaps.push({
      field: "keyless.sharesOutstanding.classes",
      reason:
        `the cover page of ${filing === undefined ? "the latest filing" : `${filing.form} ${filing.accn} (filed ${filing.filed})`} ` +
        `reports dei:${DEI_SHARES_TAG} once per share class; companyfacts carries no class dimension, so the ${coverClasses.length} ` +
        `unnamed counts (${coverClasses.join(" + ")}) are summed to ${point.value} as of ${point.asOf}. Per-class figures are not ` +
        "recoverable from this source, so any per-class analysis is out of reach keylessly.",
      severity: "info",
      attemptedSources: [`edgar:companyfacts dei/${DEI_SHARES_TAG}`],
      expected: true,
    });
    notes.push(
      `keyless share count: ${coverClasses.length} share classes summed (${coverClasses.join(" + ")} = ${point.value} at ${point.asOf})`,
    );
  }
  const factsFetchedAt = inputs.edgar.companyFacts.ok
    ? inputs.edgar.companyFacts.value.fetchedAt
    : fetchedAt;
  const factsReason = inputs.edgar.companyFacts.ok ? null : inputs.edgar.companyFacts.gap.reason;
  const emptyStatementsContext = describeEmptyStatements(
    inputs.edgar.companyFacts.ok ? inputs.edgar.companyFacts.value.data : null,
    registrant,
  );

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
    // A concept served by a stand-in tag (cash interest paid for interest
    // expense, pretax income + interest for EBIT) feeds the WACC and the DCF;
    // the report has to say so, not only the progress log.
    for (const sub of result.substitutions) {
      gaps.push({
        field: `keyless.${member}.${sub.field}`,
        reason: `${sub.text} (periods: ${sub.periods.join(", ")})`,
        severity: "info",
        attemptedSources: ["edgar:companyfacts"],
        expected: true,
      });
    }
    // A later filing that moved a material line by more than the threshold is
    // the single most decision-relevant thing companyfacts can tell a reader
    // about a period, and it was computed and then dropped: the row carried a
    // `restatement` flag no manifest ever read.
    if (result.restatements.length > 0) {
      const listed = result.restatements
        .slice(0, MAX_LISTED_RESTATEMENTS)
        .map(
          (r) =>
            `${r.date} ${r.field} ${r.original} → ${r.restated} (${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(1)}%, ` +
            `first ${r.originalFiling.form} ${r.originalFiling.accn} filed ${r.originalFiling.filed}, ` +
            `restated in ${r.restatedFiling.form} ${r.restatedFiling.accn} filed ${r.restatedFiling.filed})`,
        );
      const extra = result.restatements.length - listed.length;
      gaps.push({
        field: `keyless.${member}.restatements`,
        reason:
          `${result.restatements.length} material line(s) restated by more than ${RESTATEMENT_THRESHOLD_PCT}% in a later filing; ` +
          `this statement carries the LAST-FILED value and keeps the superseded one as \`original\`: ` +
          listed.join("; ") +
          (extra > 0 ? `; and ${extra} more` : ""),
        severity: "warn",
        attemptedSources: ["edgar:companyfacts"],
      });
      notes.push(
        `${member}: ${result.restatements.length} restated material line(s) — last-filed values shown, first-reported values kept as \`original\``,
      );
    }
    if (result.rows.length === 0) {
      const why = result.gaps[0]?.reason ?? "no period resolved from the filed facts";
      failKeyless(member, `EDGAR companyfacts produced no ${member} rows: ${why}${emptyStatementsContext}`, ["edgar:companyfacts", endpoint], true);
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

  // --- Statement backfill (D-12) --------------------------------------------
  //
  // An entry-tier FMP plan caps `limit`, so a request for ten fiscal years
  // comes back with five and every long-window CAGR silently measures a
  // shorter span. The periods FMP could not serve are filed facts like any
  // other, so they are taken from companyfacts and APPENDED — never merged
  // into a period FMP already served, so no row mixes two sources — and each
  // one carries `source: "edgar"` with the endpoint that produced it.
  const backfill = <TRow extends FmpRawRow>(
    member: keyof KeylessMembers,
    result: StatementRowsResult<TRow> | null,
    endpoint: string,
  ): void => {
    if (inputs.statementSource !== "auto") return;
    if (replaced.includes(member) || result === null || result.rows.length === 0) return;
    if (!inputs.edgarConfirmedIssuer) return;
    const current = inputs.fmp[member] as FetchResult<FmpPayload<TRow>>;
    if (!current.ok || current.value.data.rows.length === 0) return;
    const vendorRows = current.value.data.rows;
    const vendorDates = vendorRows.map((row) => isoDay(row["date"])).filter((day): day is string => day !== null);
    if (vendorDates.length === 0) return;
    const oldestVendor = vendorDates.reduce((a, b) => (a < b ? a : b));
    const older = result.rows.filter((row) => {
      const day = isoDay(row["date"]);
      return day !== null && day < oldestVendor;
    });
    if (older.length === 0) return;
    const olderDates = older.map((row) => isoDay(row["date"]) as string).sort();
    const filled = older.map((row) => ({ ...row, source: "edgar", sourceEndpoint: endpoint }) as TRow);
    const planLimit = isPlanLimited(current.value.data) ? current.value.data.planLimit : null;
    members[member] = {
      ok: true,
      value: {
        ...current.value,
        endpoint: `${current.value.endpoint} + ${endpoint} (older periods)`,
        data: { ...current.value.data, rows: [...vendorRows, ...filled] },
      },
    } as KeylessMembers[typeof member];
    notes.push(
      `${member}: ${filled.length} older period(s) backfilled from EDGAR companyfacts (${olderDates[0]} … ${olderDates[olderDates.length - 1]})`,
    );
    gaps.push({
      field: `statements.backfill.${member}`,
      reason:
        `FMP served ${vendorRows.length} period(s) back to ${oldestVendor}` +
        (planLimit === null
          ? ""
          : ` (its subscription caps 'limit' at ${planLimit.applied}, so ${planLimit.applied} of ${planLimit.requested} requested periods arrived)`) +
        `; SEC EDGAR companyfacts supplied ${filled.length} older period(s), ${olderDates[0]} to ${olderDates[olderDates.length - 1]}, each row carrying source "edgar" (${endpoint}). ` +
        "No period mixes the two sources: the vendor's rows are untouched and only periods it did not serve were added.",
      severity: "info",
      attemptedSources: [current.value.endpoint, endpoint],
      // Structural on a plan whose limit is capped; an incident otherwise.
      expected: planLimit !== null || inputs.fmpKeyless,
    });
    replaced.push(member);
  };
  backfill("incomeAnnual", built?.incomeAnnual ?? null, STATEMENT_ENDPOINTS.incomeAnnual);
  backfill("incomeQuarterly", built?.incomeQuarterly ?? null, STATEMENT_ENDPOINTS.incomeQuarterly);
  backfill("balanceAnnual", built?.balanceAnnual ?? null, STATEMENT_ENDPOINTS.balanceAnnual);
  backfill("balanceQuarterly", built?.balanceQuarterly ?? null, STATEMENT_ENDPOINTS.balanceQuarterly);
  backfill("cashflowAnnual", built?.cashflowAnnual ?? null, STATEMENT_ENDPOINTS.cashflowAnnual);
  backfill("cashflowQuarterly", built?.cashflowQuarterly ?? null, STATEMENT_ENDPOINTS.cashflowQuarterly);

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
    // Name the lookup that actually ran. With an unconfirmed issuer there is no
    // registrant and the SIC taxonomy was never consulted, so claiming
    // `edgar:submissions.sic` was attempted would put a lookup in the manifest
    // that never happened.
    if (inputs.edgarConfirmedIssuer) {
      failKeyless(
        "sectorEtf",
        `no sector ETF resolved: the registrant's SIC maps to sector ${classification.sector ?? "unknown"}`,
        ["edgar:submissions.sic"],
      );
    } else {
      failKeyless(
        "sectorEtf",
        "no sector ETF resolved: FMP's profile carried no mappable sector, and EDGAR did not confirm the registrant whose SIC would supply one",
        ["fmp:profile.sector"],
      );
    }
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
  const shareSeries = inputs.edgar.companyFacts.ok
    ? sharesOutstandingSeries(inputs.edgar.companyFacts.value.data)
    : { points: [], basis: null, splits: [] };
  const deiShares = shareSeries.points;
  if (shareSeries.splits.length > 0 && deiShares.length > 0) {
    notes.push(
      `keyless share counts: points filed before the ${shareSeries.splits
        .map((e) => `${describeSplitRatio(e.ratio)} split of ${e.date}`)
        .join(" and the ")} are restated to the current share basis`,
    );
  }
  /** Which share-count concept a derived figure rests on, for the notes. */
  const seriesBasis: SharesBasis | "no share-count concept" =
    shareSeries.basis ?? "no share-count concept";

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
      // D-15: a point estimate with no uncertainty attached invites a reader to
      // treat 1.2 ± 0.05 and 1.2 ± 0.40 as the same input to a discount rate,
      // and the price basis decides whether a dividend payer's returns were
      // measured at all. Both travel with the number, in the notes and in the
      // manifest.
      if (beta.disclosure !== null) gaps.push(beta.disclosure);
      // The regression's fit is what says how much of this stock's movement the
      // benchmark explains; the spec calls for reporting it, and it was
      // computed and then dropped on the floor.
      notes.push(
        `profile: ${beta.note}${beta.rSquared !== null ? ` (R² ${beta.rSquared.toFixed(2)})` : ""}`,
      );
      if (outstanding !== null) {
        notes.push(
          `profile: market cap from the ${outstanding.basis} share count (${outstanding.value} at ${outstanding.asOf})`,
        );
      }
      const instrument = classifyInstrument(meta);
      if (instrument.gap !== null) gaps.push(instrument.gap);
      if (instrument.note !== null) notes.push(`profile: ${instrument.note}`);
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
        // Beside the raw slope, never in place of it: the Blume-adjusted value,
        // the regression's uncertainty and fit, and which price series the
        // returns were built from.
        betaBlume: beta.betaBlume,
        betaStandardError: beta.standardError,
        betaRSquared: beta.rSquared,
        betaMonths: beta.months,
        betaBasis: beta.basis,
        // The instrument guard (`classifyInstrumentSupport`) decides support
        // from these two flags alone, so hard-coding them false meant a keyless
        // `/company/SPY` produced a company report for a fund: ETF and
        // closed-end trusts are SEC registrants with tickers and 10-K filings,
        // so they clear the issuer gate and the whole fallback runs for them.
        // Yahoo's chart meta already carries the classification.
        isEtf: instrument.isEtf,
        isFund: instrument.isFund,
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
      const profileEp = profileEndpoint(outstanding?.basis ?? null);
      members.profile = sourced([profileRow], "computed", profileEp, asOf, fetchedAt);
      record("profile", "computed", profileEp);
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
      notes.push(`keyless enterprise values: fallback share counts from the ${seriesBasis}`);
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
        `no market-cap history: ${eodRows.length} price bar${eodRows.length === 1 ? "" : "s"} and ${deiShares.length} share observation${deiShares.length === 1 ? "" : "s"} (${seriesBasis})`,
        ["computed:market-cap"],
      );
    } else {
      notes.push(`keyless market-cap history: share counts from the ${seriesBasis}`);
      const marketCapEp = marketCapEndpoint(shareSeries.basis);
      members.marketCapHistory = sourced(rows, "computed", marketCapEp, newestDate(rows, inputs.today), fetchedAt);
      record("marketCapHistory", "computed", marketCapEp);
    }
  }

  // --- Shares float ---------------------------------------------------------

  if (needs("sharesFloat")) {
    if (outstanding === null) {
      failKeyless(
        "sharesFloat",
        `no share count in companyfacts: neither dei:${DEI_SHARES_TAG} nor us-gaap:${BALANCE_SHEET_SHARES_TAG}`,
        ["edgar:companyfacts"],
      );
    } else {
      // EntityPublicFloat is a DOLLAR amount measured on ONE cover-page date —
      // for a 10-K, the last business day of the most recently completed second
      // fiscal quarter, so it can be most of a year old by the time the filing
      // is read. Only a price turns it into shares, and dividing a stale dollar
      // float by today's price silently rescales the share count by however
      // much the stock has moved since. The figure is therefore labelled with
      // its own measurement date and flagged when that date is stale.
      const publicFloat = built?.shares.publicFloat ?? null;
      const floatShares = publicFloat !== null && price !== null && price > 0 ? publicFloat.value / price : null;
      const freeFloat = floatShares !== null && outstanding.value > 0 ? (floatShares / outstanding.value) * 100 : null;
      const floatAge = describePublicFloatAge(publicFloat, price, inputs.today);
      gaps.push(floatAge.gap);
      if (floatAge.note !== null) notes.push(`keyless shares float: ${floatAge.note}`);
      const row: Record<string, unknown> = {
        symbol: inputs.symbol,
        date: outstanding.asOf,
        outstandingShares: outstanding.value,
        floatShares,
        freeFloat,
        // The float's own measurement date travels WITH the value: the row's
        // `date` is the share count's as-of, which is a different, later date.
        publicFloatUsd: publicFloat?.value ?? null,
        publicFloatAsOf: publicFloat?.asOf ?? null,
        publicFloatStale: floatAge.stale,
        source: "edgar",
      };
      // The endpoint names the concept that actually served the count: a
      // per-class reporter has no dei cover count, so claiming one would be a
      // false provenance string.
      const floatEndpoint =
        outstanding.basis === "dei cover page"
          ? SHARES_FLOAT_ENDPOINT
          : `companyfacts→shares-float(us-gaap:${BALANCE_SHEET_SHARES_TAG} + dei:EntityPublicFloat)`;
      notes.push(`keyless shares float: outstanding share count from the ${outstanding.basis}`);
      members.sharesFloat = sourced([row as FmpSharesFloatRow], "edgar", floatEndpoint, outstanding.asOf, factsFetchedAt);
      record("sharesFloat", "edgar", floatEndpoint);
    }
  }

  return { members, sectorEtfSymbol, gaps, notes, replaced };
}

/** Whole months from an ISO day to the analysis date, floored at 0. */
function monthsSince(day: string, today: string): number | null {
  const from = Date.parse(`${day.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${today.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  return Math.floor((to - from) / DAY_MS / 30.4375);
}

/** A public float older than this is disclosed as stale (D-14). */
export const PUBLIC_FLOAT_STALE_MONTHS = 6;

/**
 * The disclosure that travels with a keyless float share count. Three cases,
 * one manifest field so a reader always finds the answer in the same place:
 * no float fact at all, a float converted at a price from a later date, and
 * the same conversion where the float is more than six months old — which is
 * the common case, because the cover-page figure is measured at the end of the
 * second fiscal quarter and refreshed once a year.
 */
function describePublicFloatAge(
  publicFloat: { value: number; asOf: string } | null,
  price: number | null,
  today: string,
): { gap: ManifestEntry; note: string | null; stale: boolean } {
  const field = "keyless.sharesFloat.publicFloat";
  const attemptedSources = ["edgar:companyfacts(dei:EntityPublicFloat)"];
  if (publicFloat === null) {
    return {
      gap: {
        field,
        reason:
          "no dei:EntityPublicFloat fact in companyfacts, so the float share count and free-float percentage are absent; only the outstanding share count is reported",
        severity: "warn",
        attemptedSources,
      },
      note: null,
      stale: false,
    };
  }
  if (price === null || price <= 0) {
    return {
      gap: {
        field,
        reason: `dei:EntityPublicFloat is a dollar amount measured ${publicFloat.asOf} and no price was available to convert it, so the float share count and free-float percentage are absent`,
        severity: "warn",
        attemptedSources,
      },
      note: null,
      stale: false,
    };
  }
  const months = monthsSince(publicFloat.asOf, today);
  const stale = months !== null && months > PUBLIC_FLOAT_STALE_MONTHS;
  const age = months === null ? "" : ` (${months} month${months === 1 ? "" : "s"} before the analysis date)`;
  const conversion =
    `float shares = dei:EntityPublicFloat, a dollar amount measured ${publicFloat.asOf}${age}, ` +
    "divided by the latest price";
  return {
    gap: {
      field,
      reason: stale
        ? `${conversion}. The two dates differ by more than ${PUBLIC_FLOAT_STALE_MONTHS} months: the cover-page float is measured at the end of the issuer's second fiscal quarter and refreshed once a year, so this share count is rescaled by every price move since ${publicFloat.asOf} and should be read as an order of magnitude, not a current figure`
        : `${conversion}; the two dates are within ${PUBLIC_FLOAT_STALE_MONTHS} months of each other`,
      severity: stale ? "warn" : "info",
      attemptedSources,
      ...(stale ? {} : { expected: true }),
    },
    note: `public float ${publicFloat.value} USD measured ${publicFloat.asOf}${age}, converted to shares at the latest price${stale ? " — stale, see the manifest" : ""}`,
    stale,
  };
}

/**
 * Why a companyfacts payload that parsed still built no statement rows. Two
 * situations account for it among listed issuers and neither is a data
 * outage: a foreign private issuer reporting under IFRS (TSMC's 20-F facts
 * sit in the ifrs-full namespace; the builder reads us-gaap only) and a
 * successor registrant (ExxonMobil Holdings Corp, July 2026) whose
 * predecessor's history sits under a CIK EDGAR does not link. Appended to the
 * "no rows" reason so the manifest names the cause rather than the symptom.
 */
function describeEmptyStatements(facts: CompanyFacts | null, registrant: EdgarRegistrant | null): string {
  const parts: string[] = [];
  if (facts !== null) {
    const ifrs = Object.keys(facts.facts["ifrs-full"] ?? {}).length;
    const usGaap = Object.keys(facts.facts["us-gaap"] ?? {}).length;
    if (ifrs > 0 && ifrs > usGaap) {
      parts.push(
        `the issuer reports under IFRS (${ifrs} ifrs-full concepts, ${usGaap} us-gaap) and the keyless statement builder reads us-gaap only`,
      );
    }
  }
  if (registrant !== null && registrant.forms.some((form) => form.trim() === "8-K12B")) {
    parts.push(
      "the registrant is a successor issuer (Form 8-K12B on file) whose predecessor's XBRL history sits under another CIK that EDGAR does not link",
    );
  }
  return parts.length === 0 ? "" : `; ${parts.join("; ")}`;
}
