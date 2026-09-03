/**
 * Stage A composition root: buildDataBundle(symbol) — turns a ticker into the
 * DataBundle everything downstream consumes (the application contract §3).
 *
 * Wiring (integration caveats from Phase 1):
 *  - FMP: createFmpClient({ cachedFetch }) takes an injected CachedFetchFn;
 *    makeFmpCachedFetch() below adapts it onto cache/apiCache.cachedFetch
 *    (lazy-imported so merely importing this module never touches SQLite).
 *    With no FMP_API_KEY the client uses synthetic contract fixtures
 *    (fixtures/fmp/...) for DEMO/DBNK and discloses gaps for other symbols.
 *  - EDGAR: createEdgarClient({ transport: createDbCachedEdgarTransport() }) —
 *    durable api_cache, declared User-Agent, ≤5 req/s, 403 → cooldown.
 *  - FINRA / FRED / Finnhub: functional clients with their own throttles.
 *
 * Guarantees:
 *  - Everything independent is fetched CONCURRENTLY (promises started up
 *    front; provider token buckets pace the actual requests).
 *  - Missing inputs NEVER throw: every member is a FetchResult and every
 *    failure lands in bundle.gaps as a ManifestEntry.
 *  - Deterministic ordering: FMP row arrays sorted date DESC; FRED/FINRA time
 *    series stay ascending as their providers deterministically emit them.
 *  - 13F year/quarter resolved by rule: latest quarter ended ≥45 days ago
 *    (resolve13FQuarter in pipeline/types.ts).
 */

import type { FetchResult, ManifestEntry, Sourced } from "@/types/core";
import {
  createFmpClient,
  isPlanLimited,
  FMP_EMPTY_ARRAY_REASON,
  type CachedFetchFn,
  type CachedFetchResult,
  type FmpClient,
  type FmpEarningsRow,
  type FmpEodBarRow,
  type FmpPayload,
  type FmpRawRow,
} from "@/providers/fmp";
import {
  createDbCachedEdgarTransport,
  createEdgarClient,
  findDocumentByType,
  hasConfiguredEdgarIdentity,
  padCik,
  resolveEdgarUserAgent,
  type CikMapping,
  type EdgarClient,
  type EdgarFiling,
  type EdgarSubmissions,
} from "@/providers/edgar";
import { createYahooClient, type YahooClient } from "@/providers/yahoo";
import {
  extractFromExhibit,
  extractSection,
  parseDocument,
  type ParsedDocument,
  type SectionSpec,
} from "@/edgar/extract";
import { latestFactEnd, looksLikeBankTagging } from "@/edgar/xbrl";
import {
  FINRA_MAX_TREND_PARTITIONS,
  FINRA_TTL_SECONDS,
  shortInterestTrend as finraShortInterestTrend,
  type ShortInterestPoint,
  type FinraConfig,
} from "@/providers/finra";
import {
  CORE_SERIES,
  FRED_ATTRIBUTION,
  SECTOR_SERIES,
  series as fredSeries,
  ttlForFredSeries,
  type FredConfig,
  type FredObservation,
  type FredSeriesOptions,
  type FredUnits,
  type GicsSector,
} from "@/providers/fred";
import {
  FINNHUB_TTL_SECONDS,
  insiderSentiment,
  type FinnhubConfig,
  type InsiderSentimentMonth,
} from "@/providers/finnhub";
import { getConfig } from "@/config/env";
// WS4 (D-11): the two reserved fixture symbols short-circuit every provider.
import {
  isReservedFixtureSymbol,
  reservedFixtureManifestEntry,
  reservedProviderGap,
} from "@/providers/reservedSymbols";
import {
  derive13FCoverage,
  resolve13FQuarter,
  type BenchmarkPrices,
  type DataBundle,
  type EdgarBundle,
  type ExtractedSection,
  type MacroBundle,
  type SourceManifestEntry,
  type StatementSet,
  type TranscriptBundle,
  type XbrlSummary,
} from "@/pipeline/types";
import { mergeManifest } from "@/pipeline/stageA/manifest";
import { applyKeylessFallbacks, type KeylessOutcome } from "@/pipeline/keyless";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Benchmark index proxy for relative strength. */
export const BENCHMARK_SYMBOL = "SPY";
/** Annual statement history requested (SPEC §4: up to 10y CAGRs). */
export const ANNUAL_PERIODS = 10;
/** Quarterly statement/EV history requested (20 rolling TTM windows + one headroom window). */
export const QUARTERLY_PERIODS = 24;
/** Daily price history window, years (SPEC §4 technicals). */
export const EOD_YEARS = 5;

const DAY_MS = 86_400_000;

/**
 * FMP sector string (lowercased) -> SPDR sector ETF. Covers FMP's 11 sectors
 * plus their GICS spellings (FMP: "Financial Services", "Healthcare",
 * "Consumer Cyclical/Defensive", "Basic Materials").
 */
export const SECTOR_ETF_MAP: Readonly<Record<string, string>> = {
  technology: "XLK",
  "information technology": "XLK",
  "financial services": "XLF",
  financials: "XLF",
  financial: "XLF",
  energy: "XLE",
  healthcare: "XLV",
  "health care": "XLV",
  "consumer cyclical": "XLY",
  "consumer discretionary": "XLY",
  "consumer defensive": "XLP",
  "consumer staples": "XLP",
  industrials: "XLI",
  "basic materials": "XLB",
  materials: "XLB",
  utilities: "XLU",
  "real estate": "XLRE",
  "communication services": "XLC",
};

/** FMP sector string (lowercased) -> GICS sector for FRED series routing. */
export const FMP_SECTOR_TO_GICS: Readonly<Record<string, GicsSector>> = {
  technology: "Information Technology",
  "information technology": "Information Technology",
  "financial services": "Financials",
  financials: "Financials",
  financial: "Financials",
  energy: "Energy",
  healthcare: "Health Care",
  "health care": "Health Care",
  "consumer cyclical": "Consumer Discretionary",
  "consumer discretionary": "Consumer Discretionary",
  "consumer defensive": "Consumer Staples",
  "consumer staples": "Consumer Staples",
  industrials: "Industrials",
  "basic materials": "Materials",
  materials: "Materials",
  utilities: "Utilities",
  "real estate": "Real Estate",
  "communication services": "Communication Services",
};

const PROVIDER_MAX_STALE_SECONDS = 7 * 86_400;

/** Resolve the SPDR sector ETF for an FMP profile.sector value (null = unmapped). */
export function resolveSectorEtf(sector: string | null | undefined): string | null {
  if (typeof sector !== "string") return null;
  return SECTOR_ETF_MAP[sector.trim().toLowerCase()] ?? null;
}

/** Resolve the GICS sector (FRED routing) for an FMP profile.sector value. */
export function resolveGicsSector(sector: string | null | undefined): GicsSector | null {
  if (typeof sector !== "string") return null;
  return FMP_SECTOR_TO_GICS[sector.trim().toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// FMP cachedFetch adapter (the ~10-line bridge onto cache/apiCache)
// ---------------------------------------------------------------------------

/**
 * Adapts cache/apiCache.cachedFetch({provider,endpoint,params,ttlSeconds,fetcher})
 * to the FMP client's CachedFetchFn(key, ttlMs, loader). The FMP cache key
 * already encodes endpoint+params (fmpCacheKey), so it rides in `endpoint`.
 * The cache module (and SQLite under it) is lazy-imported on first use.
 */
export function makeFmpCachedFetch(): CachedFetchFn {
  let mod: Promise<typeof import("@/cache/apiCache")> | null = null;
  return async <T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<CachedFetchResult<T>> => {
    mod ??= import("@/cache/apiCache");
    const { cachedFetch } = await mod;
    const sourced = await cachedFetch<T>({
      provider: "fmp",
      endpoint: key,
      params: {},
      ttlSeconds: Math.max(0, Math.floor(ttlMs / 1000)),
      maxStaleSeconds: PROVIDER_MAX_STALE_SECONDS,
      // asOf here is cache-row metadata; the FMP client re-derives the real
      // asOf from response rows (deriveAsOf) after this returns.
      fetcher: async () => ({ body: await loader(), asOf: new Date().toISOString().slice(0, 10) }),
      // FMP wraps each response as a LiveExchange { body, status, fetchedAt }.
      // A transient 200-`[]` (body === []) must never overwrite a previously
      // cached non-empty statement/price body for the whole TTL (M6). First
      // fetches still cache (segmentation expected-empty caching unaffected).
      // A zero-length 200 body parses to `body: null` in the FMP loader, which
      // carries even less than `[]`, so it counts as empty here too. An object
      // body is NOT treated as empty: `allowObjectBody` endpoints return one
      // legitimately, and for the rest the loader already rejects it before
      // storage.
      // A value that is not a LiveExchange at all is never "empty" — only an
      // envelope that really carries an empty body qualifies.
      isEmptyBody: (value: T): boolean => {
        if (typeof value !== "object" || value === null || !("body" in value)) return false;
        const inner = (value as { body?: unknown }).body;
        if (inner === null || inner === undefined) return true;
        return Array.isArray(inner) && inner.length === 0;
      },
    });
    const out: CachedFetchResult<T> = { value: sourced.data, fetchedAt: sourced.fetchedAt };
    if (sourced.stale === true) out.stale = true;
    if (sourced.staleReason !== undefined) out.staleReason = sourced.staleReason;
    return out;
  };
}

/**
 * The Yahoo analogue of makeFmpCachedFetch. The Yahoo client already encodes
 * the endpoint and its query in the cache key it passes, so that key rides in
 * `endpoint` exactly as FMP's does.
 *
 * The empty-body guard differs: the Yahoo loader stores the parsed chart
 * result directly (no LiveExchange envelope), and its only "carries nothing"
 * value is a literal `null` — a zero-length body. Any other shape has already
 * survived the schema parse and the error-envelope check inside the client, so
 * treating it as empty would discard good data.
 */
export function makeYahooCachedFetch(): CachedFetchFn {
  let mod: Promise<typeof import("@/cache/apiCache")> | null = null;
  return async <T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<CachedFetchResult<T>> => {
    mod ??= import("@/cache/apiCache");
    const { cachedFetch } = await mod;
    const sourced = await cachedFetch<T>({
      provider: "yahoo",
      endpoint: key,
      params: {},
      ttlSeconds: Math.max(0, Math.floor(ttlMs / 1000)),
      maxStaleSeconds: PROVIDER_MAX_STALE_SECONDS,
      fetcher: async () => ({ body: await loader(), asOf: new Date().toISOString().slice(0, 10) }),
      isEmptyBody: (value: T): boolean => value === null,
    });
    const out: CachedFetchResult<T> = { value: sourced.data, fetchedAt: sourced.fetchedAt };
    if (sourced.stale === true) out.stale = true;
    if (sourced.staleReason !== undefined) out.staleReason = sourced.staleReason;
    return out;
  };
}

// ---------------------------------------------------------------------------
// FRED cached fetch adapter — the analogue of makeFmpCachedFetch for FRED.
// ---------------------------------------------------------------------------

/** A FRED single-series fetch with its config baked in. */
export type FredSeriesFetch = (
  id: string,
  opts: FredSeriesOptions,
) => Promise<FetchResult<FredObservation[]>>;

/**
 * FRED series fetch wrapped in the durable api_cache (serve-stale-while-
 * revalidate), mirroring makeFmpCachedFetch / createDbCachedEdgarTransport.
 *
 * fred.ts defines FRED_TTL_SECONDS + ttlForFredSeries but nothing ever wired
 * them to the cache, so every company-page load re-fetched all ~12–16 macro
 * series LIVE at ≤2 req/s — 6–8s+ of the page latency, on every visit. Now
 * core + sector series serve from SQLite within their per-series TTL (rates 2h,
 * others 4h). Gaps are NOT cached: they tunnel out as a typed throw (like the
 * EDGAR transport) so a transient FRED miss retries next request, never sticks.
 */
export function makeCachedFredSeries(cfg: FredConfig): FredSeriesFetch {
  let mod: Promise<typeof import("@/cache/apiCache")> | null = null;
  class FredGap extends Error {
    constructor(readonly gap: ManifestEntry) {
      super(gap.reason);
    }
  }
  class UncachedFredFallback extends Error {
    constructor(readonly value: Sourced<FredObservation[]>) {
      super("FRED keyed API fell back to fredgraph.csv; returned uncached");
    }
  }
  return async (id, opts) => {
    mod ??= import("@/cache/apiCache");
    const { cachedFetch } = await mod;
    const seriesId = id.trim().toUpperCase();
    const units = opts.units ?? "lin";
    try {
      const sourced = await cachedFetch<{
        obs: FredObservation[];
        endpoint: string;
        source: Sourced<unknown>["source"];
      }>({
        provider: "fred",
        endpoint: `series/${seriesId}`,
        params: {
          authMode: cfg.apiKey ? "keyed" : "keyless",
          start: opts.start ?? null,
          end: opts.end ?? null,
          units,
        },
        ttlSeconds: ttlForFredSeries(seriesId),
        maxStaleSeconds: PROVIDER_MAX_STALE_SECONDS,
        fetcher: async () => {
          const res = await fredSeries(id, opts, cfg);
          if (!res.ok) throw new FredGap(res.gap);
          if (cfg.apiKey && res.value.endpoint.includes("fredgraph.csv")) {
            throw new UncachedFredFallback(res.value);
          }
          return {
            body: { obs: res.value.data, endpoint: res.value.endpoint, source: res.value.source },
            asOf: res.value.asOf,
          };
        },
      });
      const value: Sourced<FredObservation[]> = {
        data: sourced.data.obs,
        asOf: sourced.asOf,
        source: sourced.data.source,
        endpoint: sourced.data.endpoint,
        fetchedAt: sourced.fetchedAt,
      };
      if (sourced.stale === true) value.stale = true;
      return { ok: true, value };
    } catch (err) {
      if (err instanceof FredGap) return { ok: false, gap: err.gap };
      if (err instanceof UncachedFredFallback) return { ok: true, value: err.value };
      throw err; // hard transport failure — settle() upstream files a gap
    }
  };
}

type FinraShortInterestTrendFetch = (
  symbol: string,
  nPartitions?: number,
) => Promise<FetchResult<ShortInterestPoint[]>>;

type FinnhubInsiderSentimentFetch = (
  symbol: string,
  from: string,
  to: string,
) => Promise<FetchResult<InsiderSentimentMonth[]>>;

class ProviderGap extends Error {
  constructor(readonly gap: ManifestEntry) {
    super(gap.reason);
  }
}

/**
 * FINRA trend rows are daily-stable between settlement publications. Cache only
 * successful payloads; gaps tunnel out so transient access failures retry on
 * the next report instead of poisoning the durable cache.
 */
export function makeCachedFinraShortInterestTrend(cfg: FinraConfig): FinraShortInterestTrendFetch {
  let mod: Promise<typeof import("@/cache/apiCache")> | null = null;
  return async (symbol, nPartitions = FINRA_MAX_TREND_PARTITIONS) => {
    mod ??= import("@/cache/apiCache");
    const { cachedFetch } = await mod;
    const sym = symbol.trim().toUpperCase();
    const n = Math.min(Math.max(1, Math.floor(nPartitions)), FINRA_MAX_TREND_PARTITIONS);
    try {
      const sourced = await cachedFetch<{
        rows: ShortInterestPoint[];
        endpoint: string;
      }>({
        provider: "finra",
        endpoint: `short-interest/trend/${sym}`,
        params: { nPartitions: n },
        ttlSeconds: FINRA_TTL_SECONDS,
        maxStaleSeconds: PROVIDER_MAX_STALE_SECONDS,
        fetcher: async () => {
          const res = await finraShortInterestTrend(sym, n, cfg);
          if (!res.ok) throw new ProviderGap(res.gap);
          return {
            body: { rows: res.value.data, endpoint: res.value.endpoint },
            asOf: res.value.asOf,
          };
        },
      });
      const value: Sourced<ShortInterestPoint[]> = {
        data: sourced.data.rows,
        asOf: sourced.asOf,
        source: "finra",
        endpoint: sourced.data.endpoint,
        fetchedAt: sourced.fetchedAt,
      };
      if (sourced.stale === true) value.stale = true;
      return { ok: true, value };
    } catch (err) {
      if (err instanceof ProviderGap) return { ok: false, gap: err.gap };
      throw err;
    }
  };
}

/**
 * Finnhub insider sentiment is the only always-on Finnhub call. Cache successful
 * keyed responses for 24h; no-key and premium/access gaps are left uncached.
 */
export function makeCachedFinnhubInsiderSentiment(cfg: FinnhubConfig): FinnhubInsiderSentimentFetch {
  let mod: Promise<typeof import("@/cache/apiCache")> | null = null;
  return async (symbol, from, to) => {
    if (!cfg.apiKey) return insiderSentiment(symbol, from, to, cfg);

    mod ??= import("@/cache/apiCache");
    const { cachedFetch } = await mod;
    const sym = symbol.trim().toUpperCase();
    try {
      const sourced = await cachedFetch<{
        months: InsiderSentimentMonth[];
        endpoint: string;
      }>({
        provider: "finnhub",
        endpoint: "stock/insider-sentiment",
        params: { symbol: sym, from, to },
        ttlSeconds: FINNHUB_TTL_SECONDS,
        maxStaleSeconds: PROVIDER_MAX_STALE_SECONDS,
        fetcher: async () => {
          const res = await insiderSentiment(sym, from, to, cfg);
          if (!res.ok) throw new ProviderGap(res.gap);
          return {
            body: { months: res.value.data, endpoint: res.value.endpoint },
            asOf: res.value.asOf,
          };
        },
      });
      const value: Sourced<InsiderSentimentMonth[]> = {
        data: sourced.data.months,
        asOf: sourced.asOf,
        source: "finnhub",
        endpoint: sourced.data.endpoint,
        fetchedAt: sourced.fetchedAt,
      };
      if (sourced.stale === true) value.stale = true;
      return { ok: true, value };
    } catch (err) {
      if (err instanceof ProviderGap) return { ok: false, gap: err.gap };
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type DataBundleCore = Omit<DataBundle, "sourceManifest" | "asOf" | "gaps">;

function isFetchResult(value: unknown): value is FetchResult<unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.ok === true
    ? Object.prototype.hasOwnProperty.call(candidate, "value")
    : candidate.ok === false && Object.prototype.hasOwnProperty.call(candidate, "gap");
}

/** Derive dot-path producer identities from the object that is actually returned. */
function collectFetchResultRegistry(bundleCore: DataBundleCore): Record<string, FetchResult<unknown>> {
  const registry: Record<string, FetchResult<unknown>> = {};

  const visit = (value: unknown, memberPath: string): void => {
    if (isFetchResult(value)) {
      registry[memberPath] = value;
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${memberPath}.${index}`));
      return;
    }
    for (const [member, child] of Object.entries(value)) {
      visit(child, memberPath === "" ? member : `${memberPath}.${member}`);
    }
  };

  visit(bundleCore, "");
  return registry;
}

function gapResult<T>(
  field: string,
  reason: string,
  severity: ManifestEntry["severity"],
  attemptedSources?: string[],
  expected = false,
): FetchResult<T> {
  const gap: ManifestEntry = { field, reason, severity };
  if (attemptedSources !== undefined) gap.attemptedSources = attemptedSources;
  if (expected) gap.expected = true;
  return { ok: false, gap };
}

/** Awaits a FetchResult-producing promise; thrown errors become gaps. */
async function settle<T>(field: string, p: Promise<FetchResult<T>>): Promise<FetchResult<T>> {
  try {
    return await p;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return gapResult<T>(field, `fetch failed: ${reason}`, "warn");
  }
}

function latestShortInterestFromTrend(
  symbol: string,
  trend: FetchResult<ShortInterestPoint[]>,
): FetchResult<ShortInterestPoint> {
  const sym = symbol.trim().toUpperCase();
  const field = `shortInterest.${sym}`;
  if (!trend.ok) {
    return {
      ok: false,
      gap: {
        field,
        reason: `latest FINRA short interest unavailable because trend fetch failed: ${trend.gap.reason}`,
        severity: trend.gap.severity,
        attemptedSources: trend.gap.attemptedSources ?? ["finra"],
      },
    };
  }
  const row = trend.value.data[trend.value.data.length - 1];
  if (!row) {
    return gapResult(
      field,
      `no FINRA short interest rows for ${sym} across the requested settlement cycles`,
      "info",
      ["finra"],
    );
  }
  const value: Sourced<ShortInterestPoint> = {
    data: row,
    asOf: row.settlementDate,
    source: "finra",
    endpoint: trend.value.endpoint,
    fetchedAt: trend.value.fetchedAt,
  };
  if (trend.value.stale === true) value.stale = true;
  return { ok: true, value };
}

function isoDaysAgo(from: Date, days: number): string {
  return new Date(from.getTime() - days * DAY_MS).toISOString().slice(0, 10);
}

function rowKey(row: FmpRawRow, field: string): string {
  const v = row[field];
  return typeof v === "string" ? v : "";
}

/**
 * Segmentation endpoints structurally return nothing for many issuers — they
 * simply don't disclose product/geo revenue splits in a form FMP carries
 * (INTU's geographic split was absent in 16 of 19 audited reports). An empty
 * result is EXPECTED for such filers, not a data-quality incident: flag it so
 * the manifest can count it separately instead of inflating the headline gap
 * count on every report. Transport/plan errors keep their original gap.
 */
function markSegmentationGapExpected<T>(result: FetchResult<T>): FetchResult<T> {
  if (result.ok || !result.gap.reason.includes(FMP_EMPTY_ARRAY_REASON)) return result;
  return {
    ok: false,
    gap: {
      ...result.gap,
      severity: "info",
      expected: true,
      reason:
        "issuer does not report this revenue segmentation via FMP (known structural gap — disclosed, not an error)",
    },
  };
}

/** New FetchResult with rows sorted DESC by a string date field (default "date"). */
function sortRows<TRow extends FmpRawRow>(
  res: FetchResult<FmpPayload<TRow>>,
  dateField = "date",
): FetchResult<FmpPayload<TRow>> {
  if (!res.ok) return res;
  const rows = [...res.value.data.rows].sort((a, b) => {
    const da = rowKey(a, dateField);
    const db = rowKey(b, dateField);
    return da < db ? 1 : da > db ? -1 : 0;
  });
  return { ok: true, value: { ...res.value, data: { ...res.value.data, rows } } };
}

/** New FetchResult with rows sorted DESC by a numeric field (e.g. comp year). */
function sortRowsNumeric<TRow extends FmpRawRow>(
  res: FetchResult<FmpPayload<TRow>>,
  numField: string,
): FetchResult<FmpPayload<TRow>> {
  if (!res.ok) return res;
  const rows = [...res.value.data.rows].sort((a, b) => {
    const na = typeof a[numField] === "number" ? (a[numField] as number) : Number.NEGATIVE_INFINITY;
    const nb = typeof b[numField] === "number" ? (b[numField] as number) : Number.NEGATIVE_INFINITY;
    return nb - na;
  });
  return { ok: true, value: { ...res.value, data: { ...res.value.data, rows } } };
}

/**
 * Derive the next expected earnings date: the earliest future-dated row of
 * /stable/earnings (future rows carry epsActual=null — DATA_MAP §2.1).
 */
function isValidIsoDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === date;
}

export function deriveNextEarnings(
  earnings: FetchResult<FmpPayload<FmpEarningsRow>>,
  todayIso: string,
  symbol: string,
): FetchResult<FmpEarningsRow> {
  const field = `earningsCalendarNext(${symbol})`;
  if (!earnings.ok) {
    return gapResult(field, `earnings history unavailable: ${earnings.gap.reason}`, "info");
  }
  const dated = earnings.value.data.rows
    .map((r) => ({ row: r, date: typeof r.date === "string" ? r.date.slice(0, 10) : "" }))
    .filter((x) => isValidIsoDate(x.date) && x.date >= todayIso)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const next = dated[0];
  if (next === undefined) {
    return gapResult(field, "no future-dated earnings row in /stable/earnings response", "info", [
      earnings.value.endpoint,
    ]);
  }
  const value: Sourced<FmpEarningsRow> = {
    data: next.row,
    // `asOf` is the OBSERVATION date — when this calendar was observed — which
    // the derivation inherits from its parent envelope. Using `next.date` here
    // stamped the datum with the FUTURE event date, so every downstream
    // freshness and as-of comparison saw it as newer than data observed later.
    // The event date itself stays in the datum (`data.date`).
    asOf: earnings.value.asOf,
    source: earnings.value.source,
    endpoint: `${earnings.value.endpoint} (derived: earliest future row)`,
    fetchedAt: earnings.value.fetchedAt,
  };
  if (earnings.value.stale === true) value.stale = true;
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// FRED helpers
// ---------------------------------------------------------------------------

type FredSeriesSpecRequest = { id: string; units: FredUnits };

function fredSpecKey(spec: FredSeriesSpecRequest): string {
  return `${spec.id.trim().toUpperCase()}|${spec.units}`;
}

export function dedupeFredSeriesSpecs(
  specs: readonly FredSeriesSpecRequest[],
): FredSeriesSpecRequest[] {
  const seen = new Set<string>();
  const out: FredSeriesSpecRequest[] = [];
  for (const spec of specs) {
    const normalized = { id: spec.id.trim().toUpperCase(), units: spec.units };
    const key = fredSpecKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

async function fetchFredSeriesMap(
  specs: readonly FredSeriesSpecRequest[],
  start: string,
  fetchSeries: FredSeriesFetch,
): Promise<Record<string, FetchResult<FredObservation[]>>> {
  const entries = await Promise.all(
    specs.map(async (s) => {
      const res = await settle(`macro.${s.id}`, fetchSeries(s.id, { start, units: s.units }));
      return [fredSpecKey(s), res] as const;
    }),
  );
  const out: Record<string, FetchResult<FredObservation[]>> = {};
  for (const [key, res] of entries) out[key] = res;
  return out;
}

function selectFredSeriesResults(
  specs: readonly FredSeriesSpecRequest[],
  fetched: Record<string, FetchResult<FredObservation[]>>,
): Record<string, FetchResult<FredObservation[]>> {
  const out: Record<string, FetchResult<FredObservation[]>> = {};
  for (const spec of specs) {
    out[spec.id] =
      fetched[fredSpecKey(spec)] ??
      gapResult(`macro.${spec.id}`, `FRED series ${spec.id} (${spec.units}) was not fetched`, "warn", ["fred"]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Transcript sub-flow
// ---------------------------------------------------------------------------

async function buildTranscriptBundle(symbol: string, fmp: FmpClient): Promise<TranscriptBundle> {
  const meta = sortRows(await settle(`fmp.transcriptDates(${symbol})`, fmp.transcriptDates(symbol)));
  if (!meta.ok) {
    return {
      meta,
      latest: gapResult(
        `fmp.transcript(${symbol})`,
        `transcript dates unavailable: ${meta.gap.reason}`,
        "info",
      ),
    };
  }
  let pick: { fiscalYear: number; quarter: number } | null = null;
  for (const r of meta.value.data.rows) {
    if (typeof r.fiscalYear === "number" && typeof r.quarter === "number") {
      pick = { fiscalYear: r.fiscalYear, quarter: r.quarter };
      break;
    }
  }
  if (pick === null) {
    return {
      meta,
      latest: gapResult(
        `fmp.transcript(${symbol})`,
        "transcript-dates rows carried no usable fiscalYear+quarter",
        "info",
        [meta.value.endpoint],
      ),
    };
  }
  const latest = await settle(
    `fmp.transcript(${symbol})`,
    fmp.transcript(symbol, pick.fiscalYear, pick.quarter),
  );
  return { meta, latest };
}

// ---------------------------------------------------------------------------
// EDGAR sub-flow
// ---------------------------------------------------------------------------

interface SectionJob {
  member: "item1a" | "mdna" | "tenQMdna";
  sectionName: ExtractedSection["sectionName"];
  spec: SectionSpec;
  /** Manifest severity when extraction hard-fails (10-K sections are critical). */
  failSeverity: "critical" | "warn";
}

const XBRL_FRESHNESS_TAGS = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "Revenues",
  "RevenuesNetOfInterestExpense",
  "InterestIncomeExpenseNet",
  "NetIncomeLoss",
  "Assets",
];

/**
 * Run the 4-layer extractor on a fetched filing document, completing exhibit
 * redirects (EX-13 via the index-headers TYPE map — never filename/size).
 * Extraction failures become gaps; the "not_required" outcome is severity info.
 */
async function runExtraction(
  edgar: EdgarClient,
  cik: number,
  filing: EdgarFiling,
  documentUrl: string,
  html: string,
  docFetchedAt: string,
  job: SectionJob,
  symbol: string,
  preparsed?: ParsedDocument,
): Promise<FetchResult<ExtractedSection>> {
  const field = `edgar.${job.member}(${symbol})`;
  const asOf = filing.reportDate !== "" ? filing.reportDate : filing.filingDate;

  const wrap = (
    text: string,
    method: ExtractedSection["method"],
    chars: number,
    srcUrl: string,
    marker?: "unchanged_from_10k",
  ): FetchResult<ExtractedSection> => {
    const data: ExtractedSection = {
      sectionName: job.sectionName,
      text,
      method,
      chars,
      accession: filing.accessionNumber,
      form: filing.form,
      filingDate: filing.filingDate,
      reportDate: asOf,
      documentUrl: srcUrl,
    };
    if (marker !== undefined) data.marker = marker;
    return {
      ok: true,
      value: {
        data,
        asOf,
        source: "edgar",
        endpoint: `${srcUrl} (${filing.form} Item ${job.spec.item})`,
        fetchedAt: docFetchedAt,
      },
    };
  };

  let res: ReturnType<typeof extractSection>;
  try {
    res = extractSection(html, job.spec, preparsed !== undefined ? { preparsed } : {});
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return gapResult(field, `section extraction threw: ${reason}`, job.failSeverity, [documentUrl]);
  }
  if (res.ok) return wrap(res.text, res.method, res.chars, documentUrl, res.marker);

  const err = res.error;
  if (err.kind === "exhibit_redirect" && err.exhibit !== undefined) {
    // Layer 3b completion: resolve the EX-13 sibling via the TYPE map.
    const idx = await settle(field, edgar.filingIndexHeaders(cik, filing.accessionNumber));
    if (!idx.ok) {
      return gapResult(
        field,
        `stub redirects to an exhibit but index-headers fetch failed: ${idx.gap.reason}`,
        job.failSeverity,
        [documentUrl],
      );
    }
    const doc = findDocumentByType(idx.value.data, err.exhibit.exhibitTypePrefix);
    if (doc === null) {
      return gapResult(
        field,
        `stub redirects to an exhibit but no ${err.exhibit.exhibitTypePrefix}* TYPE in the index-headers map`,
        job.failSeverity,
        [documentUrl, idx.value.endpoint],
      );
    }
    const exDoc = await settle(
      field,
      edgar.fetchFilingDocument(cik, { ...filing, primaryDocument: doc.filename }, { asOf }),
    );
    if (!exDoc.ok) {
      const attempted = exDoc.gap.attemptedSources ?? [];
      return gapResult(field, `EX-13 exhibit fetch failed: ${exDoc.gap.reason}`, job.failSeverity, [
        documentUrl,
        ...attempted,
      ]);
    }
    const exUrl = exDoc.value.endpoint;
    const exRes = extractFromExhibit(exDoc.value.data, {
      section: err.exhibit.section,
      quotedTitles: err.exhibit.quotedTitles,
    });
    if (exRes.ok) return wrap(exRes.text, exRes.method, exRes.chars, exUrl);
    return gapResult(
      field,
      `exhibit-redirect extraction failed: ${exRes.error.message}`,
      job.failSeverity,
      [documentUrl, exUrl],
    );
  }

  if (err.kind === "not_required") {
    return gapResult(field, `section not required for this filer: ${err.message}`, "info", [documentUrl]);
  }
  // Layer-4 loud hard-fail — surfaced as a gap, never a silent stub.
  return gapResult(
    field,
    `section extraction hard-failed (${err.kind}): ${err.message}`,
    job.failSeverity,
    [documentUrl],
  );
}

/** Newest exact-form filing from an already-fetched submissions payload. */
function filingFromSubmissions(
  sub: Sourced<EdgarSubmissions>,
  form: string,
  field: string,
  missingSeverity: ManifestEntry["severity"],
): FetchResult<EdgarFiling> {
  const hit = sub.data.recentFilings.find((f) => f.form === form);
  if (hit === undefined) {
    return gapResult(
      field,
      `no "${form}" among ${sub.data.recentFilings.length} recent filings (exact form match; older overflow pages not searched)`,
      missingSeverity,
      [sub.endpoint],
    );
  }
  const value: Sourced<EdgarFiling> = {
    data: hit,
    asOf: hit.reportDate !== "" ? hit.reportDate : hit.filingDate,
    source: "edgar",
    endpoint: sub.endpoint,
    fetchedAt: sub.fetchedAt,
  };
  if (sub.stale === true) value.stale = true;
  return { ok: true, value };
}

/**
 * Select the annual primary filing. A foreign private issuer may file Form
 * 20-F instead of Form 10-K; a 10-K remains preferred when both exist.
 */
export function selectAnnualFiling(
  sub: Sourced<EdgarSubmissions>,
  symbol: string,
): FetchResult<EdgarFiling> {
  const field = `edgar.latestTenK(${symbol})`;
  const tenK = filingFromSubmissions(sub, "10-K", field, "critical");
  if (tenK.ok) return tenK;
  const twentyF = filingFromSubmissions(sub, "20-F", field, "critical");
  if (twentyF.ok) return twentyF;
  // Neither on file: name both forms (reporting only the 20-F miss made a
  // domestic filer look foreign), and the one situation that leaves a listed
  // large cap with no annual report at all — a successor registrant (Form
  // 8-K12B; ExxonMobil Holdings Corp took over the XOM ticker in July 2026)
  // whose predecessor's filings sit under a CIK EDGAR does not link.
  const successor = sub.data.recentFilings.find((f) => f.form.trim() === "8-K12B");
  return gapResult(
    field,
    `no "10-K" or "20-F" among ${sub.data.recentFilings.length} recent filings (exact form match; older overflow pages not searched)` +
      (successor === undefined
        ? ""
        : `; the registrant is a successor issuer (Form 8-K12B filed ${successor.filingDate}) — its predecessor's annual reports live under another CIK that EDGAR does not link`),
    "critical",
    [sub.endpoint],
  );
}

/**
 * Select the latest standardized interim filing, falling back to Form 6-K as
 * provenance for a foreign private issuer. A 6-K is not treated as a 10-Q
 * because it has no standardized MD&A item.
 */
export function selectInterimFiling(
  sub: Sourced<EdgarSubmissions>,
  symbol: string,
): FetchResult<EdgarFiling> {
  const tenQ = filingFromSubmissions(sub, "10-Q", `edgar.latestTenQ(${symbol})`, "warn");
  if (tenQ.ok) return tenQ;
  return filingFromSubmissions(sub, "6-K", `edgar.latestTenQ(${symbol})`, "warn");
}

/** 8-Ks whose items[] carry the given item number (e.g. "4.01" auditor change). */
function eightKsWithItem(sub: Sourced<EdgarSubmissions>, item: string): FetchResult<EdgarFiling[]> {
  const hits = sub.data.recentFilings.filter(
    (f) =>
      f.form === "8-K" &&
      typeof f.items === "string" &&
      f.items
        .split(",")
        .map((s) => s.trim())
        .includes(item),
  );
  const value: Sourced<EdgarFiling[]> = {
    data: hits,
    asOf: hits[0] !== undefined ? hits[0].filingDate : sub.asOf,
    source: "edgar",
    endpoint: `${sub.endpoint} (8-K item ${item} scan)`,
    fetchedAt: sub.fetchedAt,
  };
  if (sub.stale === true) value.stale = true;
  return { ok: true, value };
}

/**
 * Max wall-clock ms for "parse the annual filing + extract the risk section" before the review section
 * (MD&A) is skipped with a disclosed gap instead of risking the route's
 * response-time budget (page.tsx sets maxDuration=120). Large bank filings
 * (e.g. JPM's ~12.9M-char 10-K) can otherwise blow past that ceiling.
 */
export const DEFAULT_EDGAR_SECTION_BUDGET_MS = 60_000;

async function buildEdgarBundle(
  symbol: string,
  profileCik: string | null,
  edgar: EdgarClient,
  progress: (msg: string) => void,
  nowIso: string,
  edgarSectionBudgetMs: number,
): Promise<EdgarBundle> {
  progress(`EDGAR: resolving CIK for ${symbol}`);
  let cikRes = await settle(`edgar.cik(${symbol})`, edgar.tickerToCik(symbol));
  if (!cikRes.ok && profileCik !== null && profileCik !== "") {
    // Fallback: FMP profile carries the CIK for most US filers.
    try {
      const cik10 = padCik(profileCik);
      const mapping: CikMapping = {
        cik10,
        cik: Number.parseInt(cik10, 10),
        ticker: symbol,
        title: symbol,
      };
      cikRes = {
        ok: true,
        value: {
          data: mapping,
          asOf: nowIso.slice(0, 10),
          source: "fmp",
          endpoint: "profile.cik (fallback after SEC company_tickers.json miss)",
          fetchedAt: nowIso,
        },
      };
    } catch {
      // profile.cik was malformed — keep the original gap.
    }
  }

  if (!cikRes.ok) {
    const dep = <T>(member: string, severity: ManifestEntry["severity"]): FetchResult<T> =>
      gapResult<T>(
        `edgar.${member}(${symbol})`,
        `EDGAR unavailable — CIK resolution failed: ${cikRes.ok ? "" : cikRes.gap.reason}`,
        severity,
      );
    return {
      cik: cikRes,
      latestTenK: dep("latestTenK", "warn"),
      latestTenQ: dep("latestTenQ", "warn"),
      item1a: dep("item1a", "critical"),
      mdna: dep("mdna", "critical"),
      tenQMdna: dep("tenQMdna", "warn"),
      auditorChange8Ks: dep("auditorChange8Ks", "warn"),
      nonReliance8Ks: dep("nonReliance8Ks", "warn"),
      companyFacts: dep("companyFacts", "warn"),
      xbrlSummary: null,
      sic: null,
      registrant: null,
    };
  }

  const cik = cikRes.value.data.cik;

  progress(`EDGAR: fetching submissions + companyfacts for CIK ${cikRes.value.data.cik10}`);
  const pSub = settle(`edgar.submissions(${symbol})`, edgar.submissions(cik));
  const pFacts = settle(`edgar.companyFacts(${symbol})`, edgar.companyFacts(cik));
  const sub = await pSub;

  let latestTenK: FetchResult<EdgarFiling>;
  let latestTenQ: FetchResult<EdgarFiling>;
  let auditorChange8Ks: FetchResult<EdgarFiling[]>;
  let nonReliance8Ks: FetchResult<EdgarFiling[]>;
  let item1a: FetchResult<ExtractedSection>;
  let mdna: FetchResult<ExtractedSection>;
  let tenQMdna: FetchResult<ExtractedSection>;

  if (sub.ok) {
    latestTenK = selectAnnualFiling(sub.value, symbol);
    latestTenQ = selectInterimFiling(sub.value, symbol);
    auditorChange8Ks = eightKsWithItem(sub.value, "4.01");
    nonReliance8Ks = eightKsWithItem(sub.value, "4.02");

    // Annual filing: one document fetch, two section extractions sharing ONE parse.
    // extractSection's hidden-block-strip + TOC/anchor parse is the expensive
    // part on large filings (e.g. JPM's ~12.9M-char 10-K); Item 1A and Item 7
    // come from the identical HTML, so parsing once and reusing it for both
    // avoids doing that work twice. Extraction runs sequentially (not
    // Promise.all — extractSection is synchronous/CPU-bound, so Promise.all
    // gave no real concurrency anyway) so elapsed time can be checked between
    // sections: if Item 1A alone already blew the budget, Item 7 is skipped
    // with an explicit gap instead of risking the route's response-time
    // ceiling.
    if (latestTenK.ok) {
      const filing = latestTenK.value.data;
      const annualRiskJob: SectionJob =
        filing.form === "20-F"
          ? { member: "item1a", sectionName: "item1A", spec: { form: "20-F", item: "3D" }, failSeverity: "critical" }
          : { member: "item1a", sectionName: "item1A", spec: { form: "10-K", item: "1A" }, failSeverity: "critical" };
      const annualMdnaJob: SectionJob =
        filing.form === "20-F"
          ? { member: "mdna", sectionName: "item7", spec: { form: "20-F", item: "5" }, failSeverity: "critical" }
          : { member: "mdna", sectionName: "item7", spec: { form: "10-K", item: "7" }, failSeverity: "critical" };
      progress(`EDGAR: extracting ${filing.form} Item ${annualRiskJob.spec.item} + Item ${annualMdnaJob.spec.item} (${filing.accessionNumber})`);
      const doc = await settle(
        `edgar.tenKDocument(${symbol})`,
        edgar.fetchFilingDocument(cik, filing, {
          asOf: filing.reportDate !== "" ? filing.reportDate : filing.filingDate,
        }),
      );
      if (doc.ok) {
        const docUrl = doc.value.endpoint;
        const html = doc.value.data;
        const parsedDoc = parseDocument(html);
        const t0 = Date.now();
        item1a = await runExtraction(
          edgar,
          cik,
          filing,
          docUrl,
          html,
          doc.value.fetchedAt,
          annualRiskJob,
          symbol,
          parsedDoc,
        );
        const elapsedMs = Date.now() - t0;
        if (elapsedMs > edgarSectionBudgetMs) {
          mdna = gapResult(
            `edgar.mdna(${symbol})`,
            `Item ${annualMdnaJob.spec.item} (MD&A) extraction skipped: parsing + Item ${annualRiskJob.spec.item} extraction took ${Math.round(elapsedMs / 1000)}s, ` +
              `exceeding the ${Math.round(edgarSectionBudgetMs / 1000)}s per-filing extraction budget. Deliberate ` +
              `bounded degrade to protect the route's response-time budget — not an extraction failure.`,
            "critical",
            [docUrl],
          );
        } else {
          mdna = await runExtraction(
            edgar,
            cik,
            filing,
            docUrl,
            html,
            doc.value.fetchedAt,
            annualMdnaJob,
            symbol,
            parsedDoc,
          );
        }
      } else {
        const attempted = doc.gap.attemptedSources;
        item1a = gapResult(
          `edgar.item1a(${symbol})`,
          `${filing.form} document fetch failed: ${doc.gap.reason}`,
          "critical",
          attempted,
        );
        mdna = gapResult(
          `edgar.mdna(${symbol})`,
          `${filing.form} document fetch failed: ${doc.gap.reason}`,
          "critical",
          attempted,
        );
      }
    } else {
      const reason = `no annual primary filing (10-K or 20-F) to extract from: ${latestTenK.gap.reason}`;
      item1a = gapResult(`edgar.item1a(${symbol})`, reason, "critical");
      mdna = gapResult(`edgar.mdna(${symbol})`, reason, "critical");
    }

    // 10-Q MD&A (Part I Item 2).
    if (latestTenQ.ok && latestTenQ.value.data.form === "10-Q") {
      const filing = latestTenQ.value.data;
      progress(`EDGAR: extracting 10-Q MD&A (${filing.accessionNumber})`);
      const doc = await settle(
        `edgar.tenQDocument(${symbol})`,
        edgar.fetchFilingDocument(cik, filing, {
          asOf: filing.reportDate !== "" ? filing.reportDate : filing.filingDate,
        }),
      );
      if (doc.ok) {
        const docUrl = doc.value.endpoint;
        tenQMdna = await runExtraction(
          edgar,
          cik,
          filing,
          docUrl,
          doc.value.data,
          doc.value.fetchedAt,
          { member: "tenQMdna", sectionName: "tenQItem2", spec: { form: "10-Q", item: "2" }, failSeverity: "warn" },
          symbol,
        );
      } else {
        tenQMdna = gapResult(
          `edgar.tenQMdna(${symbol})`,
          `10-Q document fetch failed: ${doc.gap.reason}`,
          "warn",
          doc.gap.attemptedSources,
        );
      }
    } else if (latestTenQ.ok && latestTenQ.value.data.form === "6-K") {
      tenQMdna = gapResult(
        `edgar.tenQMdna(${symbol})`,
        `latest interim filing is ${latestTenQ.value.data.form}; Form 6-K has no standardized Part I Item 2 MD&A, so no section was inferred`,
        "info",
        [latestTenQ.value.endpoint],
        true,
      );
    } else if (latestTenQ.ok) {
      tenQMdna = gapResult(
        `edgar.tenQMdna(${symbol})`,
        `latest interim filing had unexpected form ${latestTenQ.value.data.form}; no standardized Part I Item 2 MD&A was extracted`,
        "warn",
        [latestTenQ.value.endpoint],
      );
    } else {
      tenQMdna = gapResult(
        `edgar.tenQMdna(${symbol})`,
        `no 10-Q or confirmed 6-K interim filing to classify: ${latestTenQ.gap.reason}`,
        "warn",
      );
    }
  } else {
    const reason = `submissions unavailable: ${sub.gap.reason}`;
    latestTenK = gapResult(`edgar.latestTenK(${symbol})`, reason, "warn");
    latestTenQ = gapResult(`edgar.latestTenQ(${symbol})`, reason, "warn");
    auditorChange8Ks = gapResult(`edgar.auditorChange8Ks(${symbol})`, reason, "warn");
    nonReliance8Ks = gapResult(`edgar.nonReliance8Ks(${symbol})`, reason, "warn");
    item1a = gapResult(`edgar.item1a(${symbol})`, reason, "critical");
    mdna = gapResult(`edgar.mdna(${symbol})`, reason, "critical");
    tenQMdna = gapResult(`edgar.tenQMdna(${symbol})`, reason, "warn");
  }

  const companyFacts = await pFacts;
  let xbrlSummary: XbrlSummary | null = null;
  if (companyFacts.ok) {
    const facts = companyFacts.value.data;
    const usGaap = facts.facts["us-gaap"] ?? {};
    xbrlSummary = {
      entityName: facts.entityName,
      usGaapTagCount: Object.keys(usGaap).length,
      latestFactEnd: latestFactEnd(facts, XBRL_FRESHNESS_TAGS),
      bankTagging: looksLikeBankTagging(facts),
    };
  }

  return {
    cik: cikRes,
    latestTenK,
    latestTenQ,
    item1a,
    mdna,
    tenQMdna,
    auditorChange8Ks,
    nonReliance8Ks,
    companyFacts,
    xbrlSummary,
    // Altman's variant selection is SIC-decisive; FMP's profile has no SIC, so
    // the submissions payload is the only source and was previously discarded.
    sic: sub.ok ? sub.value.data.sic : null,
    // Registrant identity for the keyless profile: the name, listing venue,
    // jurisdiction and filed form mix a vendor profile would otherwise supply.
    registrant: sub.ok
      ? {
          name: sub.value.data.name,
          cik10: cikRes.value.data.cik10,
          sic: sub.value.data.sic,
          sicDescription: sub.value.data.sicDescription,
          exchanges: sub.value.data.exchanges.filter((e): e is string => typeof e === "string" && e !== ""),
          tickers: sub.value.data.tickers,
          fiscalYearEnd: sub.value.data.fiscalYearEnd,
          stateOfIncorporation: sub.value.data.stateOfIncorporation,
          forms: [...new Set(sub.value.data.recentFilings.map((f) => f.form))],
        }
      : null,
  };
}

/**
 * WS4 (D-11): the EDGAR half of a reserved-symbol run. `buildEdgarBundle` is
 * never called, so data.sec.gov is never asked about a fictional issuer — the
 * synthetic CIK `0000000000` in the DEMO profile fixture used to be sent on
 * every fixture report. Each member is disclosed absent with the reserved rule
 * as its reason.
 */
function reservedEdgarBundle(symbol: string): EdgarBundle {
  const gap = <T>(member: string): FetchResult<T> => ({
    ok: false,
    gap: reservedProviderGap(`edgar.${member}(${symbol})`, symbol, ["fixtures/edgar"]),
  });
  return {
    cik: gap("cik"),
    latestTenK: gap("latestTenK"),
    latestTenQ: gap("latestTenQ"),
    item1a: gap("item1a"),
    mdna: gap("mdna"),
    tenQMdna: gap("tenQMdna"),
    auditorChange8Ks: gap("auditorChange8Ks"),
    nonReliance8Ks: gap("nonReliance8Ks"),
    companyFacts: gap("companyFacts"),
    xbrlSummary: null,
    sic: null,
    registrant: null,
  };
}

// ---------------------------------------------------------------------------
// buildDataBundle
// ---------------------------------------------------------------------------

export interface BuildDataBundleOptions {
  /** Step-level progress messages (streamed to the UI by the job runner). */
  onProgress?: (msg: string) => void;
  /** One job-scoped cancellation/deadline signal for every live provider. */
  signal?: AbortSignal;
  /** Injectable clients/configs (tests, special flows). */
  fmp?: FmpClient;
  edgar?: EdgarClient;
  /** Keyless price/quote source for the EDGAR + Yahoo fallback layer. */
  yahoo?: YahooClient;
  /**
   * Fill core members FMP cannot serve from EDGAR + Yahoo once a CIK resolves.
   * Default true.
   */
  keyless?: boolean;
  fred?: FredConfig;
  /**
   * Explicit FRED fetcher override. When absent, production wraps FRED in the
   * durable api_cache; injecting `fred` (a config) alone takes the direct,
   * uncached path — the same way injecting `fmp`/`edgar` bypasses their caches.
   */
  fredFetch?: FredSeriesFetch;
  finnhub?: FinnhubConfig;
  finra?: FinraConfig;
  /** Injectable clock (deterministic windows/quarters in tests). */
  now?: () => Date;
  /** Years of EOD history (default 5). */
  eodYears?: number;
  /**
   * Per-filing EDGAR section-extraction time budget (ms) — see
   * DEFAULT_EDGAR_SECTION_BUDGET_MS. Overridable for tests/tuning.
   */
  edgarSectionBudgetMs?: number;
}

export async function buildDataBundle(
  symbol: string,
  opts: BuildDataBundleOptions = {},
): Promise<DataBundle> {
  const sym = symbol.trim().toUpperCase();
  const progress = opts.onProgress ?? ((): void => undefined);
  const now = opts.now ?? ((): Date => new Date());
  const nowDate = now();
  const builtAt = nowDate.toISOString();
  const today = builtAt.slice(0, 10);

  const cfg = getConfig();
  // WS4 (D-11): DEMO and DBNK are reserved. Every keyless provider below is
  // replaced by a disclosed gap and the EDGAR bundle is never built, so a
  // reserved-symbol report issues no request to any provider whatever keys are
  // configured — and an injected client is short-circuited too, so a test can
  // count the calls and see zero.
  const reserved = isReservedFixtureSymbol(sym);
  const configuredFmp = opts.fmp ?? createFmpClient({ cachedFetch: makeFmpCachedFetch(), signal: opts.signal });
  // A reserved symbol also reaches endpoints that carry no symbol (treasury
  // rates, the market risk premium), so the whole client drops its key rather
  // than relying on the per-request rule alone.
  const fmp = reserved ? configuredFmp.fixturesOnly() : configuredFmp;
  const edgar =
    opts.edgar ??
    createEdgarClient({ transport: createDbCachedEdgarTransport({ signal: opts.signal }) });
  // Yahoo's chart edge answers 429 to a client that declares nothing. When the
  // operator has configured a reachable EDGAR contact, reuse it so the same
  // identity that SEC access is declared under also identifies these requests;
  // otherwise the client's own honest default applies.
  const edgarContact = hasConfiguredEdgarIdentity() ? resolveEdgarUserAgent() : null;
  const yahoo =
    opts.yahoo ??
    createYahooClient({
      cachedFetch: makeYahooCachedFetch(),
      signal: opts.signal,
      userAgent:
        edgarContact === null
          ? undefined
          : `Mozilla/5.0 Thesis/1.0 equity-analyzer (${edgarContact})`,
    });
  const fredBase: FredConfig =
    opts.fred ?? (cfg.fredApiKey !== undefined ? { apiKey: cfg.fredApiKey } : {});
  const fredCfg: FredConfig = { ...fredBase, signal: opts.signal ?? fredBase.signal };
  // Production wraps FRED in the durable api_cache (fred.ts had TTLs defined but
  // never wired — 12–16 uncached live series/load). An injected `fred` config
  // (tests) takes the direct path, matching how injected fmp/edgar bypass theirs.
  const fredFetch: FredSeriesFetch = reserved
    ? (id): Promise<FetchResult<FredObservation[]>> =>
        Promise.resolve({ ok: false, gap: reservedProviderGap(`macro.${id.trim().toUpperCase()}`, sym, ["fred"]) })
    : opts.fredFetch ??
      (opts.fred !== undefined
        ? (id, o): Promise<FetchResult<FredObservation[]>> => fredSeries(id, o, fredCfg)
        : makeCachedFredSeries(fredCfg));
  const finnhubBase: FinnhubConfig =
    opts.finnhub ?? (cfg.finnhubApiKey !== undefined ? { apiKey: cfg.finnhubApiKey } : {});
  const finnhubCfg: FinnhubConfig = {
    ...finnhubBase,
    signal: opts.signal ?? finnhubBase.signal,
  };
  const finraBase: FinraConfig = opts.finra ?? {};
  const finraCfg: FinraConfig = { ...finraBase, signal: opts.signal ?? finraBase.signal };
  const finraTrendFetch: FinraShortInterestTrendFetch = reserved
    ? (s): Promise<FetchResult<ShortInterestPoint[]>> =>
        Promise.resolve({
          ok: false,
          gap: reservedProviderGap(`shortInterest.trend.${s.trim().toUpperCase()}`, sym, ["finra"]),
        })
    : opts.finra !== undefined
      ? (s, n): Promise<FetchResult<ShortInterestPoint[]>> => finraShortInterestTrend(s, n, finraCfg)
      : makeCachedFinraShortInterestTrend(finraCfg);
  const finnhubSentimentFetch: FinnhubInsiderSentimentFetch = reserved
    ? (s): Promise<FetchResult<InsiderSentimentMonth[]>> =>
        Promise.resolve({
          ok: false,
          gap: reservedProviderGap(`insiderSentiment.${s.trim().toUpperCase()}`, sym, ["finnhub"]),
        })
    : opts.finnhub !== undefined
      ? (s, from, to): Promise<FetchResult<InsiderSentimentMonth[]>> => insiderSentiment(s, from, to, finnhubCfg)
      : makeCachedFinnhubInsiderSentiment(finnhubCfg);

  if (reserved) {
    progress(`${sym}: reserved fixture symbol — synthetic contract fixtures only, no provider request`);
  } else if (fmp.fixtureMode) {
    progress("FMP: no API key — using synthetic contract fixtures for DEMO/DBNK");
  }

  // ---- profile first: sector drives ETF + FRED routing ----------------------
  progress(`fetch: profile ${sym}`);
  // `let`: the keyless layer below may replace this with an EDGAR + Yahoo
  // profile once the CIK resolves. `sectorName`/`profileCik`/`gicsSector` are
  // read from FMP's answer here because they route work that is already in
  // flight by the time the fallback can run.
  let profile = await settle(`fmp.profile(${sym})`, fmp.profile(sym));
  const profileRow = profile.ok ? profile.value.data.rows[0] : undefined;
  const sectorName = typeof profileRow?.sector === "string" ? profileRow.sector : null;
  const profileCik = typeof profileRow?.cik === "string" ? profileRow.cik : null;
  const sectorEtfSymbol = resolveSectorEtf(sectorName);
  const gicsSector = resolveGicsSector(sectorName);

  // ---- windows & quarter resolution -----------------------------------------
  const eodYears = opts.eodYears ?? EOD_YEARS;
  const eodFrom = isoDaysAgo(nowDate, Math.round(eodYears * 365.25));
  const newsFrom = isoDaysAgo(nowDate, 30);
  const filingsFrom = isoDaysAgo(nowDate, 365);
  const sentimentFrom = isoDaysAgo(nowDate, 730);
  const fredStart = isoDaysAgo(nowDate, Math.round(5 * 365.25));
  const q13 = resolve13FQuarter(nowDate);

  // ---- fire everything independent CONCURRENTLY -----------------------------
  // Provider token buckets pace the actual requests (http.ts limiters).
  progress("fetch: FMP statements, metrics, analysts, ownership, prices");
  const pQuote = settle(`fmp.quote(${sym})`, fmp.quote(sym));
  const pIncomeA = settle(`fmp.incomeStatement(${sym},annual)`, fmp.incomeStatement(sym, "annual", ANNUAL_PERIODS));
  const pIncomeQ = settle(`fmp.incomeStatement(${sym},quarter)`, fmp.incomeStatement(sym, "quarter", QUARTERLY_PERIODS));
  const pBalanceA = settle(`fmp.balanceSheet(${sym},annual)`, fmp.balanceSheet(sym, "annual", ANNUAL_PERIODS));
  const pBalanceQ = settle(`fmp.balanceSheet(${sym},quarter)`, fmp.balanceSheet(sym, "quarter", QUARTERLY_PERIODS));
  const pCashA = settle(`fmp.cashFlow(${sym},annual)`, fmp.cashFlow(sym, "annual", ANNUAL_PERIODS));
  const pCashQ = settle(`fmp.cashFlow(${sym},quarter)`, fmp.cashFlow(sym, "quarter", QUARTERLY_PERIODS));
  const pKeyMetrics = settle(`fmp.keyMetrics(${sym})`, fmp.keyMetrics(sym, "annual", ANNUAL_PERIODS));
  const pKeyMetricsTtm = settle(`fmp.keyMetricsTtm(${sym})`, fmp.keyMetricsTtm(sym));
  const pRatios = settle(`fmp.ratios(${sym})`, fmp.ratios(sym, "annual", ANNUAL_PERIODS));
  const pRatiosTtm = settle(`fmp.ratiosTtm(${sym})`, fmp.ratiosTtm(sym));
  const pGrowth = settle(`fmp.financialGrowth(${sym})`, fmp.financialGrowth(sym, "annual", ANNUAL_PERIODS));
  const pScores = settle(`fmp.financialScores(${sym})`, fmp.financialScores(sym));
  const pEv = settle(
    `fmp.enterpriseValues(${sym},quarter)`,
    fmp.enterpriseValues(sym, "quarter", QUARTERLY_PERIODS),
  );
  const pEstimates = settle(`fmp.analystEstimates(${sym})`, fmp.analystEstimates(sym, "annual", 0, 10));
  const pPtConsensus = settle(`fmp.priceTargetConsensus(${sym})`, fmp.priceTargetConsensus(sym));
  const pPtSummary = settle(`fmp.priceTargetSummary(${sym})`, fmp.priceTargetSummary(sym));
  const pGrades = settle(`fmp.gradesConsensus(${sym})`, fmp.gradesConsensus(sym));
  const pEarnings = settle(`fmp.earnings(${sym})`, fmp.earnings(sym, 40));
  const pInsiderTrades = settle(`fmp.insiderTradingSearch(${sym})`, fmp.insiderTradingSearch(sym, 0, 100));
  const pInsiderStats = settle(`fmp.insiderTradeStatistics(${sym})`, fmp.insiderTradeStatistics(sym));
  const pPositions = settle(
    `fmp.symbolPositionsSummary(${sym},${q13.year}Q${q13.quarter})`,
    fmp.symbolPositionsSummary(sym, q13.year, q13.quarter),
  );
  const pHolders = settle(
    `fmp.institutionalHolderAnalytics(${sym},${q13.year}Q${q13.quarter})`,
    fmp.institutionalHolderAnalytics(sym, q13.year, q13.quarter, 0, 50),
  );
  const pPeers = settle(`fmp.stockPeers(${sym})`, fmp.stockPeers(sym));
  const pSegProduct = settle(`fmp.revenueProductSegmentation(${sym})`, fmp.revenueProductSegmentation(sym, "annual"));
  const pSegGeo = settle(`fmp.revenueGeographicSegmentation(${sym})`, fmp.revenueGeographicSegmentation(sym, "annual"));
  const pExecs = settle(`fmp.keyExecutives(${sym})`, fmp.keyExecutives(sym));
  const pComp = settle(`fmp.executiveCompensation(${sym})`, fmp.executiveCompensation(sym));
  const pMcapHist = settle(`fmp.historicalMarketCap(${sym})`, fmp.historicalMarketCap(sym, eodFrom, today));
  const pFloat = settle(`fmp.sharesFloat(${sym})`, fmp.sharesFloat(sym));
  const pSecFilings = settle(`fmp.secFilingsSearch(${sym})`, fmp.secFilingsSearch(sym, filingsFrom, today, 0, 100));
  const pNews = settle(`fmp.stockNews(${sym})`, fmp.stockNews([sym], newsFrom, today, 0, 50));
  const pPress = settle(`fmp.pressReleases(${sym})`, fmp.pressReleases([sym], newsFrom, today, 0, 50));
  const pEod = settle(`fmp.historicalPriceEodFull(${sym})`, fmp.historicalPriceEodFull(sym, eodFrom, today));
  const pSpy = settle(
    `fmp.historicalPriceEodFull(${BENCHMARK_SYMBOL})`,
    fmp.historicalPriceEodFull(BENCHMARK_SYMBOL, eodFrom, today),
  );
  const pSectorEtf: Promise<FetchResult<FmpPayload<FmpEodBarRow>>> =
    sectorEtfSymbol !== null
      ? settle(`fmp.historicalPriceEodFull(${sectorEtfSymbol})`, fmp.historicalPriceEodFull(sectorEtfSymbol, eodFrom, today))
      : Promise.resolve(
          gapResult<FmpPayload<FmpEodBarRow>>(
            `benchmarkPrices.sectorEtf(${sym})`,
            sectorName === null
              ? "profile.sector unavailable — sector ETF benchmark not resolvable"
              : `FMP sector "${sectorName}" has no SPDR sector-ETF mapping`,
            "info",
          ),
        );
  const pTreasury = settle("fmp.treasuryRates", fmp.treasuryRates());
  const pMrp = settle("fmp.marketRiskPremium", fmp.marketRiskPremium());

  progress("fetch: FINRA short interest (partitions + rows)");
  const pShortTrend = settle(`finra.shortInterestTrend(${sym})`, finraTrendFetch(sym, 12));
  const pShort = pShortTrend.then((trend) => latestShortInterestFromTrend(sym, trend));

  progress("fetch: Finnhub insider sentiment (MSPR)");
  const pSentiment = settle(
    `finnhub.insiderSentiment(${sym})`,
    finnhubSentimentFetch(sym, sentimentFrom, today),
  );

  progress(`fetch: FRED macro (12 core series${gicsSector !== null ? ` + ${gicsSector} overlay` : ""})`);
  const macroCoreSpecs = CORE_SERIES.map((s) => ({ id: s.id, units: s.units }));
  const sectorSeriesIds = gicsSector !== null ? SECTOR_SERIES[gicsSector] : [];
  const macroSectorSpecs = sectorSeriesIds.map((id) => ({ id, units: "lin" as FredUnits }));
  const pMacroAll = fetchFredSeriesMap(
    dedupeFredSeriesSpecs([...macroCoreSpecs, ...macroSectorSpecs]),
    fredStart,
    fredFetch,
  );

  const pTranscript = buildTranscriptBundle(sym, fmp);
  const edgarSectionBudgetMs = opts.edgarSectionBudgetMs ?? DEFAULT_EDGAR_SECTION_BUDGET_MS;
  const pEdgar = reserved
    ? Promise.resolve(reservedEdgarBundle(sym))
    : buildEdgarBundle(sym, profileCik, edgar, progress, builtAt, edgarSectionBudgetMs);

  // ---- await + assemble (deterministic ordering applied here) ---------------
  let statements: StatementSet = {
    incomeAnnual: sortRows(await pIncomeA),
    incomeQuarterly: sortRows(await pIncomeQ),
    balanceAnnual: sortRows(await pBalanceA),
    balanceQuarterly: sortRows(await pBalanceQ),
    cashflowAnnual: sortRows(await pCashA),
    cashflowQuarterly: sortRows(await pCashQ),
    periods: { annualRequested: ANNUAL_PERIODS, quarterlyRequested: QUARTERLY_PERIODS },
  };

  let quote = await pQuote;
  const keyMetrics = sortRows(await pKeyMetrics);
  const keyMetricsTtm = await pKeyMetricsTtm;
  const ratios = sortRows(await pRatios);
  const ratiosTtm = await pRatiosTtm;
  const financialGrowth = sortRows(await pGrowth);
  const financialScores = await pScores;
  let enterpriseValues = sortRows(await pEv);
  const analystEstimates = sortRows(await pEstimates);
  const priceTargetConsensus = await pPtConsensus;
  const priceTargetSummary = await pPtSummary;
  const gradesConsensus = await pGrades;
  const earningsHistory = sortRows(await pEarnings);
  const earningsCalendarNext = deriveNextEarnings(earningsHistory, today, sym);
  const transcript = await pTranscript;
  const insiderTrades = sortRows(await pInsiderTrades, "transactionDate");
  const insiderStats = await pInsiderStats;
  const positionsSummary = sortRows(await pPositions);
  const topHolders = await pHolders;
  // positionsSummary is the authoritative coverage date for the institutional
  // validation family. Only fall back to topHolders when that endpoint has no
  // usable rows; combining dates from separate endpoints could label older
  // holdings with a newer quarter returned by the other endpoint.
  const institutionalRows =
    positionsSummary.ok && positionsSummary.value.data.rows.length > 0
      ? positionsSummary.value.data.rows
      : topHolders.ok
        ? topHolders.value.data.rows
        : [];
  const actual13F = derive13FCoverage(
    institutionalRows,
    q13,
    nowDate,
  );
  const peers = await pPeers;
  const segProduct = markSegmentationGapExpected(sortRows(await pSegProduct));
  const segGeo = markSegmentationGapExpected(sortRows(await pSegGeo));
  const executives = await pExecs;
  const compensation = sortRowsNumeric(await pComp, "year");
  let marketCapHistory = sortRows(await pMcapHist);
  let sharesFloat = await pFloat;
  const secFilings = sortRows(await pSecFilings, "filingDate");
  const news = sortRows(await pNews, "publishedDate");
  const pressReleases = sortRows(await pPress, "publishedDate");
  let eodPrices = sortRows(await pEod);
  let spyPrices = sortRows(await pSpy);
  let sectorEtfPrices = sortRows(await pSectorEtf);
  let resolvedSectorEtfSymbol = sectorEtfSymbol;
  const shortInterestRes = await pShort;
  const shortInterestTrendRes = await pShortTrend;
  const insiderSentimentRes = await pSentiment;
  const treasury = sortRows(await pTreasury);
  const marketRiskPremium = await pMrp;
  const macroAll = await pMacroAll;
  const macro: MacroBundle = {
    core: selectFredSeriesResults(macroCoreSpecs, macroAll),
    sector: selectFredSeriesResults(macroSectorSpecs, macroAll),
    gicsSector,
    attribution: FRED_ATTRIBUTION,
  };
  const edgarBundle = await pEdgar;

  // ---- keyless fallbacks: fill what FMP could not serve from EDGAR + Yahoo ---
  // Runs only after EDGAR resolved the ticker to a CIK, never overwrites an FMP
  // member that carries rows, and discloses every substitution as its own
  // `keyless.<member>` manifest entry.
  //
  // Issuer identity is what gates the ISSUER-BOUND members, not the layer as a
  // whole. buildEdgarBundle will synthesize a CIK from FMP's own profile when
  // company_tickers.json misses (`cik.value.source === "fmp"`); that is FMP
  // vouching for itself, and in fixture mode it is a synthetic number for a
  // fictional issuer. Serving that ticker's profile, statements or price
  // history from Yahoo would attach a real market's data to an identity nothing
  // independent confirmed. The rule is therefore: SEC's own ticker table made
  // the match (`source === "edgar"`), or the registrant SEC returned lists the
  // requested ticker itself. SEC merely ANSWERING for an FMP-supplied CIK is
  // not confirmation — it proves the CIK exists, not that this ticker belongs
  // to it, so a stale or reused CIK in an FMP profile would otherwise route
  // another registrant's statements, shares and market-cap history into this
  // report, each stamped `served by edgar`.
  //
  // SPY and the sector ETF are not issuer-bound: they are index instruments,
  // identical whoever this company turns out to be, and the spec calls for the
  // sector-ETF fallback specifically when a keyed plan refuses that symbol. So
  // the layer still runs for them with the issuer flag off.
  //
  // `!fmp.fixtureMode` guards that benchmark-only branch. With no FMP key AND
  // no EDGAR confirmation, the company half of the bundle is synthetic contract
  // fixtures for a fictional issuer (DEMO/DBNK); pulling live SPY bars alongside
  // it would put real market data and invented fundamentals in one bundle and
  // let Stage B compute a real relative-strength number for a company that does
  // not exist. It also keeps the fictional-fixture projection network-free.
  const keylessGaps: ManifestEntry[] = [];
  const edgarConfirmedIssuer =
    edgarBundle.cik.ok &&
    (edgarBundle.cik.value.source === "edgar" ||
      edgarBundle.registrant?.tickers.some((t) => t.trim().toUpperCase() === sym) === true);
  const runKeyless =
    opts.keyless !== false &&
    // A reserved symbol has no EDGAR bundle to confirm an issuer with, so this
    // is belt and braces: the layer is off for them by construction.
    !reserved &&
    edgarBundle.cik.ok &&
    (edgarConfirmedIssuer || !fmp.fixtureMode);
  if (runKeyless) {
    // The ONE fallible step in a function whose contract is "nothing throws".
    // keyless.ts wraps its network calls in `attempt`, but the XBRL statement
    // build, the beta regression and the SIC lookup run bare, so an unexpected
    // throw there would escape buildDataBundle itself. A failure of the
    // substitution layer must degrade to FMP's own results plus a disclosure.
    let keyless: KeylessOutcome | null = null;
    try {
      keyless = await applyKeylessFallbacks({
        symbol: sym,
        today,
        eodFrom,
        sectorEtfSymbol,
        fmp: {
          profile,
          quote,
          incomeAnnual: statements.incomeAnnual,
          incomeQuarterly: statements.incomeQuarterly,
          balanceAnnual: statements.balanceAnnual,
          balanceQuarterly: statements.balanceQuarterly,
          cashflowAnnual: statements.cashflowAnnual,
          cashflowQuarterly: statements.cashflowQuarterly,
          eodPrices,
          spy: spyPrices,
          sectorEtf: sectorEtfPrices,
          enterpriseValues,
          marketCapHistory,
          sharesFloat,
        },
        fmpKeyless: fmp.fixtureMode,
        edgarConfirmedIssuer,
        edgar: {
          cik: edgarBundle.cik,
          registrant: edgarBundle.registrant,
          companyFacts: edgarBundle.companyFacts,
        },
        yahoo,
        annualPeriods: ANNUAL_PERIODS,
        quarterlyPeriods: QUARTERLY_PERIODS,
        now,
        resolveSectorEtf,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      keylessGaps.push({
        field: "keyless",
        reason: `the keyless fallback layer threw and was abandoned: ${reason}; every member kept the result FMP returned and nothing was substituted`,
        severity: "warn",
        attemptedSources: ["edgar:companyfacts", "yahoo"],
      });
      progress(`keyless: layer failed (${reason}) — keeping FMP's results`);
    }

    if (keyless !== null) {
      const m = keyless.members;
      // A member the fallback left alone is the very object that went in; only a
      // genuinely new result is re-sorted, so a skipped run cannot perturb
      // anything (the fictional-fixture projection depends on that).
      const swap = <TRow extends FmpRawRow>(
        next: FetchResult<FmpPayload<TRow>>,
        prev: FetchResult<FmpPayload<TRow>>,
      ): FetchResult<FmpPayload<TRow>> => (next === prev ? prev : sortRows(next));

      profile = swap(m.profile, profile);
      quote = swap(m.quote, quote);
      statements = {
        ...statements,
        incomeAnnual: swap(m.incomeAnnual, statements.incomeAnnual),
        incomeQuarterly: swap(m.incomeQuarterly, statements.incomeQuarterly),
        balanceAnnual: swap(m.balanceAnnual, statements.balanceAnnual),
        balanceQuarterly: swap(m.balanceQuarterly, statements.balanceQuarterly),
        cashflowAnnual: swap(m.cashflowAnnual, statements.cashflowAnnual),
        cashflowQuarterly: swap(m.cashflowQuarterly, statements.cashflowQuarterly),
      };
      eodPrices = swap(m.eodPrices, eodPrices);
      spyPrices = swap(m.spy, spyPrices);
      sectorEtfPrices = swap(m.sectorEtf, sectorEtfPrices);
      resolvedSectorEtfSymbol = keyless.sectorEtfSymbol ?? sectorEtfSymbol;
      enterpriseValues = swap(m.enterpriseValues, enterpriseValues);
      marketCapHistory = swap(m.marketCapHistory, marketCapHistory);
      sharesFloat = swap(m.sharesFloat, sharesFloat);
      keylessGaps.push(...keyless.gaps);

      // FRED's sector overlay was routed from FMP's profile long before this
      // point, so a sector that only the keyless profile knows arrives too late
      // to fetch. The series are simply not in this bundle; say so rather than
      // let a reader assume the overlay was considered and found empty.
      if (gicsSector === null) {
        const keylessSector = profile.ok ? profile.value.data.rows[0]?.sector : undefined;
        const keylessGics = resolveGicsSector(
          typeof keylessSector === "string" ? keylessSector : null,
        );
        if (keylessGics !== null) {
          keylessGaps.push({
            field: "keyless.macroSectorOverlay",
            reason: `keyless profile resolved after macro routing; sector FRED overlay not fetched (sector ${keylessGics} was only known once the fallback layer filled the profile)`,
            severity: "info",
            attemptedSources: ["fred"],
            // Same rule as the substitution entries: structural on a plan with
            // no FMP key, an incident on a keyed one.
            expected: fmp.fixtureMode,
          });
        }
      }

      // Derivation notes are per-period bookkeeping ("this quarter had no debt
      // tag"), not missing-data disclosures: they belong in the run log, not the
      // manifest. The member-level failures they accompany are already gaps.
      for (const note of keyless.notes) progress(`keyless: ${note}`);
      progress(`keyless: replaced ${keyless.replaced.join(", ") || "nothing"}`);
    }
  } else if (opts.keyless !== false) {
    progress(
      `keyless: skipped — EDGAR did not confirm ${sym} as a registrant${fmp.fixtureMode ? " and FMP is serving fixtures, so even the benchmark series stay synthetic" : ""}`,
    );
  }

  const benchmarkPrices: BenchmarkPrices = {
    spy: spyPrices,
    sectorEtf: sectorEtfPrices,
    sectorEtfSymbol: resolvedSectorEtfSymbol,
  };

  progress("assemble: source + missing-data manifests");

  // The producer registry is discovered from the exact object returned below.
  // There is no independently keyed inventory that can drift or be mistyped.
  const bundleCore: DataBundleCore = {
    symbol: sym,
    builtAt,
    profile,
    quote,
    statements,
    keyMetrics,
    keyMetricsTtm,
    ratios,
    ratiosTtm,
    financialGrowth,
    financialScores,
    enterpriseValues,
    analystEstimates,
    priceTargetConsensus,
    priceTargetSummary,
    gradesConsensus,
    earningsHistory,
    earningsCalendarNext,
    transcript,
    insiderTrades,
    insiderStats,
    institutional: {
      year: actual13F.year,
      quarter: actual13F.quarter,
      quarterEnd: actual13F.quarterEnd,
      positionsSummary,
      topHolders,
    },
    peers,
    segmentation: { product: segProduct, geographic: segGeo },
    executives,
    compensation,
    marketCapHistory,
    sharesFloat,
    secFilings,
    news,
    pressReleases,
    eodPrices,
    benchmarkPrices,
    shortInterest: shortInterestRes,
    shortInterestTrend: shortInterestTrendRes,
    insiderSentiment: insiderSentimentRes,
    macro,
    treasury,
    marketRiskPremium,
    edgar: edgarBundle,
  };
  const discoveredEntries = Object.entries(collectFetchResultRegistry(bundleCore));
  const resultRegistry = Object.fromEntries([
    ...discoveredEntries.filter(([memberPath]) => !memberPath.startsWith("macro.")),
    ...discoveredEntries.filter(([memberPath]) => memberPath.startsWith("macro.")),
  ]);

  // ---- source manifest + legacy asOf view --------------------------------------
  const sourceManifest: Record<string, SourceManifestEntry> = {};
  for (const [name, result] of Object.entries(resultRegistry)) {
    if (!result.ok) continue;
    sourceManifest[name] = {
      provider: result.value.source,
      endpoint: result.value.endpoint,
      asOf: result.value.asOf,
      fetchedAt: result.value.fetchedAt,
      stale: result.value.stale === true,
    };
  }
  const asOf = Object.fromEntries(
    Object.entries(sourceManifest).map(([field, entry]) => [field, entry.asOf]),
  );

  // ---- gaps ---------------------------------------------------------------------
  const allResults = Object.values(resultRegistry);
  const gaps = mergeManifest(
    [
      ...allResults.filter((r): r is { ok: false; gap: ManifestEntry } => !r.ok).map((r) => r.gap),
      // A subscription that caps `limit` served fewer periods than the pipeline
      // asked for. The rows that arrived are real; what is missing is depth, and
      // every consumer that needs more history discloses its own shortfall. This
      // entry records WHY the history is short so a reader does not blame the
      // provider's data or the pipeline's math.
      ...Object.entries(resultRegistry).flatMap(([name, result]): ManifestEntry[] =>
        result.ok && isPlanLimited(result.value.data)
          ? [
              {
                field: `fmp.planLimit(${name})`,
                reason: `FMP subscription caps 'limit' at ${result.value.data.planLimit.applied}; served ${result.value.data.planLimit.applied} of ${result.value.data.planLimit.requested} requested periods, so history depth is truncated`,
                severity: "info",
                attemptedSources: [result.value.endpoint],
                expected: true,
              },
            ]
          : [],
      ),
      ...allResults.flatMap((result): ManifestEntry[] =>
        result.ok && result.value.staleReason === "empty-refresh-preserved"
          ? [
              {
                field: `cache.${result.value.source}.${result.value.endpoint}`,
                reason:
                  "provider refresh returned an anomalous empty body; retained last-good data within the absolute seven-day stale ceiling",
                severity: "warn",
                attemptedSources: [result.value.source, result.value.endpoint],
              },
            ]
          : [],
      ),
      // Every keyless substitution and every keyless failure, disclosed beside
      // the provider gaps. Empty whenever the fallback layer was off or skipped.
      ...keylessGaps,
      // WS4 (D-11): one entry naming the whole reserved-symbol rule, so a
      // reader of a DEMO/DBNK report is told that nothing here came from a
      // provider — not merely that individual members are missing.
      ...(reserved ? [reservedFixtureManifestEntry(sym)] : []),
    ],
  );

  progress(`done: bundle for ${sym} (${gaps.length} gap(s))`);

  return {
    ...bundleCore,
    sourceManifest,
    asOf,
    gaps,
  };
}
