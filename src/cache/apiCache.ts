/**
 * API response cache — serve-stale-while-revalidate per the provider data contract §3:
 * "always render cached data with its as-of date; refresh in background when
 * TTL expired."
 *
 * - fresh hit  → return cached Sourced<T>
 * - expired hit → return cached Sourced<T> with stale: true AND kick off a
 *   fire-and-forget background refresh (errors swallowed + logged)
 * - miss       → await fetcher, store, return
 *
 * Cache keys are deterministic: provider|endpoint|stable-sorted-params-JSON.
 * Server-only (imports src/db).
 */

import "server-only";

import { and, eq, lt, sql } from "drizzle-orm";
import { getDb, type ThesisDb } from "@/db";
import { apiCache, type NewApiCacheRow } from "@/db/schema";
import { decodeCacheBody, encodeCacheBody } from "@/cache/compression";
import type { DataSource, Sourced } from "@/types/core";

// ---------------------------------------------------------------------------
// TTL constants (seconds) — the provider data contract §3 "Cache TTL policy"
// ---------------------------------------------------------------------------

/**
 * Stand-in for "immutable — cache forever" (§3 rows for transcripts and SEC
 * filed documents). Finite so the INTEGER column and age math stay sane.
 */
const TEN_YEARS_SECONDS = 10 * 365 * 86_400; // 315,360,000

/**
 * REFERENCE TTL table (DATA_MAP §3). No production caller reads it — the
 * live TTLs are the constants in each provider client (FMP_TTLS in fmp.ts,
 * EDGAR_TTL in edgar.ts, ttlForFredSeries in fred.ts, FINRA_TTL_SECONDS in
 * finra.ts); when this table and a provider constant disagree, the provider
 * constant wins. Kept (and test-pinned) as the documented design intent.
 */
export const TTL = {
  /** §3: quotes / aftermarket / batch / index quotes — 15 min (FMP cycle "Real-Time"). */
  QUOTE: 900,
  /**
   * §3 design intent: EOD 24 h with a 15-min current-trading-day tail. The
   * tail is NOT implemented — the wired TTL is FMP_TTLS.historicalPriceEodFull
   * (flat 24 h in fmp.ts); this 900 encodes the aspirational tail only.
   */
  EOD: 900,
  /**
   * §3: statements, key-metrics, ratios, growth, scores, owner-earnings,
   * enterprise-values — 24 h. (A latest-financial-statements.dateAdded
   * invalidation channel was researched but is deliberately NOT wired — see
   * invalidate() below; restatements ride the 24 h TTL.)
   */
  FUNDAMENTALS: 86_400,
  /** §3: analyst estimates, price targets, grades, ratings, earnings — 24 h. */
  ESTIMATES: 86_400,
  /** §3: transcripts — immutable once final (fetch once, forever). */
  TRANSCRIPT: TEN_YEARS_SECONDS,
  /** §3: SEC filed documents / index-headers — immutable, cache forever. */
  FILINGS: TEN_YEARS_SECONDS,
  /** §3: insider trades / stats / 13D-G — 24 h. */
  INSIDER: 86_400,
  /** §3: 13F institutional ownership — 24 h. */
  THIRTEEN_F: 86_400,
  /** §3: news / press releases / 8-K feed — 6 h. */
  NEWS: 21_600,
  /**
   * §3: FMP economic indicators — 4 h (FMP cycle). FRED series do NOT read
   * this table: they use src/providers/fred.ts (ttlForFredSeries — 4 h
   * default, 2 h for the daily rates set FRED_TREASURY_SERIES).
   */
  MACRO: 14_400,
  /** §3: treasury rates (FMP) — 2 h (FMP cycle "2 Hours"). */
  TREASURY: 7_200,
  /** §3: sector & industry performance + P/E snapshots — 1 h (FMP cycle). */
  SECTOR: 3_600,
  /**
   * §3: FINRA partitions checked ~daily (publish events ~2×/month); rows are
   * valid until a newer partition appears.
   */
  SHORT_INTEREST: 86_400,
} as const satisfies Record<string, number>;

// ---------------------------------------------------------------------------
// Deterministic cache keys
// ---------------------------------------------------------------------------

/** JSON-compatible param values. `undefined` object entries are dropped. */
export type CacheParamValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | CacheParamValue[]
  | { [key: string]: CacheParamValue };

export type CacheParams = Record<string, CacheParamValue>;

/** JSON.stringify with recursively sorted object keys (order-insensitive). */
export function stableStringify(value: CacheParamValue): string {
  if (value === undefined) {
    throw new TypeError("Undefined cache-key values are not allowed inside arrays");
  }
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cache-key numbers must be finite");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
  return `{${entries.join(",")}}`;
}

/** cacheKey = provider|endpoint|stable-sorted params JSON. */
export function buildCacheKey(provider: string, endpoint: string, params: CacheParams): string {
  return `${provider}|${endpoint}|${stableStringify(params)}`;
}

// ---------------------------------------------------------------------------
// cachedFetch
// ---------------------------------------------------------------------------

export interface CachedFetchOptions<T> {
  /** Provider id — becomes Sourced.source. */
  provider: DataSource;
  /** Endpoint path/derivation — becomes Sourced.endpoint and keys invalidation. */
  endpoint: string;
  /** Request params; key order does not matter. */
  params: CacheParams;
  /** Freshness window in seconds (use the TTL constants above). */
  ttlSeconds: number;
  /**
   * Optional hard stale ceiling. Expired hits older than
   * `ttlSeconds + maxStaleSeconds` refresh synchronously and propagate fetch
   * errors instead of serving stale forever.
   */
  maxStaleSeconds?: number;
  /**
   * Performs the real fetch. `body` must be JSON-serializable; `asOf` is the
   * ISO date the datum is "as of" (NOT the fetch time). Data gaps must be
   * handled a layer above (FetchResult) — by the time cachedFetch is called
   * the fetcher either produces a body or throws a hard transport error.
   */
  fetcher: () => Promise<{ body: T; asOf: string }>;
  /**
   * Optional emptiness predicate. When supplied, a freshly-fetched body for
   * which this returns `true` will NOT overwrite an already-cached body for
   * which it returns `false` — i.e. a transient empty provider response (e.g.
   * FMP 200-`[]`) never clobbers a previously-good non-empty body for the full
   * TTL (M6). The write is suppressed only when a prior NON-empty row exists;
   * a first fetch always stores (so segmentation expected-empty caching keeps
   * working). Tradeoff: a genuinely delisted symbol that begins returning `[]`
   * keeps serving its last good body until the row is invalidated/purged —
   * accepted versus silently erasing live data on a blip.
   */
  isEmptyBody?: (body: T) => boolean;
}

/** Clamp TTLs into the INTEGER column ([0 .. ten years], Infinity → ten years). */
function normalizeTtl(ttlSeconds: number): number {
  if (Number.isNaN(ttlSeconds) || ttlSeconds < 0) return 0;
  if (!Number.isFinite(ttlSeconds)) return TEN_YEARS_SECONDS;
  return Math.min(Math.floor(ttlSeconds), TEN_YEARS_SECONDS);
}

function storeRow(db: ThesisDb, row: NewApiCacheRow): void {
  // Large bodies move into the bodyGz BLOB (src/cache/compression.ts). The
  // upsert must always set bodyGz too, or a body that shrinks below the
  // threshold would leave a stale BLOB shadowing the fresh TEXT.
  const enc = encodeCacheBody(row.bodyJson);
  const next: NewApiCacheRow = { ...row, bodyJson: enc.bodyJson, bodyGz: enc.bodyGz };
  db.insert(apiCache)
    .values(next)
    .onConflictDoUpdate({
      target: apiCache.cacheKey,
      set: {
        provider: next.provider,
        endpoint: next.endpoint,
        paramsJson: next.paramsJson,
        bodyJson: next.bodyJson,
        bodyGz: next.bodyGz,
        fetchedAt: next.fetchedAt,
        ttlSeconds: next.ttlSeconds,
        asOf: next.asOf,
      },
    })
    .run();
}

/**
 * Returns the existing cache row to KEEP when the freshly-fetched `nextBody` is
 * "empty" (per opts.isEmptyBody) and a prior NON-empty row is cached — so a
 * transient empty response never clobbers good data (M6). Returns null when no
 * predicate is configured, the next body is non-empty, there is no prior row,
 * the prior row is itself empty, or the prior row is undecodable (in which case
 * the empty is allowed through so the corrupt row self-heals). Handles the
 * compressed-row case: the prior body may live in bodyGz, so it is decoded.
 */
function existingRowToPreserve<T>(
  db: ThesisDb,
  cacheKey: string,
  nextBody: T,
  opts: CachedFetchOptions<T>,
): { asOf: string; fetchedAt: string; body: T } | null {
  if (opts.isEmptyBody === undefined || !opts.isEmptyBody(nextBody)) return null;
  const existing = db.select().from(apiCache).where(eq(apiCache.cacheKey, cacheKey)).get();
  if (existing === undefined) return null;
  let prevBody: T;
  try {
    prevBody = JSON.parse(decodeCacheBody(existing)) as T;
  } catch {
    return null; // undecodable prior row — let the empty replace it (self-heal)
  }
  if (opts.isEmptyBody(prevBody)) return null; // no good data to protect
  return { asOf: existing.asOf, fetchedAt: existing.fetchedAt, body: prevBody };
}

/** Keys whose last refresh was an anomalous empty response we deliberately retained. */
const preservedEmptyRefreshes = new Set<string>();

/** In-flight background refreshes, deduped by cacheKey. */
const inFlightRefreshes = new Map<string, Promise<void>>();

function startBackgroundRefresh<T>(cacheKey: string, opts: CachedFetchOptions<T>): void {
  if (inFlightRefreshes.has(cacheKey)) return; // one refresh per key at a time
  const refresh = (async () => {
    const fetched = await opts.fetcher();
    const db = getDb();
    // Never let a transient empty refresh clobber a previously-good body (M6).
    if (existingRowToPreserve(db, cacheKey, fetched.body, opts) !== null) {
      preservedEmptyRefreshes.add(cacheKey);
      console.warn(`[apiCache] empty refresh preserved last-good data for ${cacheKey}`);
      return;
    }
    preservedEmptyRefreshes.delete(cacheKey);
    storeRow(db, {
      cacheKey,
      provider: opts.provider,
      endpoint: opts.endpoint,
      paramsJson: stableStringify(opts.params),
      bodyJson: JSON.stringify(fetched.body),
      fetchedAt: new Date().toISOString(),
      ttlSeconds: normalizeTtl(opts.ttlSeconds),
      asOf: fetched.asOf,
    });
  })()
    .catch((err: unknown) => {
      // Fire-and-forget: the caller already has stale data with its as-of
      // date. Swallow, log, and let the next request retry.
      console.warn(
        `[apiCache] background refresh failed for ${cacheKey}:`,
        err instanceof Error ? err.message : err,
      );
    })
    .finally(() => {
      inFlightRefreshes.delete(cacheKey);
    });
  inFlightRefreshes.set(cacheKey, refresh);
}

/**
 * Awaits all currently in-flight background refreshes (tests, graceful
 * shutdown). Never rejects — refresh errors are already swallowed.
 */
export async function flushPendingRefreshes(): Promise<void> {
  while (inFlightRefreshes.size > 0) {
    await Promise.allSettled([...inFlightRefreshes.values()]);
  }
}

/**
 * Serve-stale-while-revalidate cached fetch (the provider data contract §3).
 *
 * Freshness is judged against the caller's `ttlSeconds` (not the TTL stored
 * at write time), so TTL policy changes take effect without a cache flush.
 * Throws only on a cache MISS whose fetcher throws (hard transport failure) —
 * an expired hit never throws; it serves stale and revalidates in background.
 */
export async function cachedFetch<T>(opts: CachedFetchOptions<T>): Promise<Sourced<T>> {
  const { provider, endpoint, params, ttlSeconds, fetcher } = opts;
  const cacheKey = buildCacheKey(provider, endpoint, params);
  const db = getDb();

  async function fetchStoreReturn(): Promise<Sourced<T>> {
    const fetched = await fetcher();
    const fetchedAt = new Date().toISOString();
    // This path is used for misses, corrupt-row self-healing, and synchronous
    // refreshes beyond the hard stale ceiling. At the ceiling the fetched body
    // is authoritative even when it is empty: retaining the old row here could
    // serve delisted or withdrawn data indefinitely. Empty refresh preservation
    // is limited to the background stale-while-revalidate path above.
    preservedEmptyRefreshes.delete(cacheKey);
    storeRow(db, {
      cacheKey,
      provider,
      endpoint,
      paramsJson: stableStringify(params),
      bodyJson: JSON.stringify(fetched.body),
      fetchedAt,
      ttlSeconds: normalizeTtl(ttlSeconds),
      asOf: fetched.asOf,
    });
    return {
      data: fetched.body,
      asOf: fetched.asOf,
      source: provider,
      endpoint,
      fetchedAt,
    };
  }

  const row = db.select().from(apiCache).where(eq(apiCache.cacheKey, cacheKey)).get();

  if (row) {
    let data: T;
    try {
      data = JSON.parse(decodeCacheBody(row)) as T;
    } catch {
      // Corrupt/undecodable cached body (bad gzip BLOB or truncated JSON):
      // drop the poisoned row and self-heal via a fresh fetch instead of
      // throwing synchronously and crash-looping the job until TTL expiry
      // (L6). Nothing sensitive is logged (the body could hold provider data).
      db.delete(apiCache).where(eq(apiCache.cacheKey, cacheKey)).run();
      return fetchStoreReturn();
    }
    const ageSeconds = (Date.now() - Date.parse(row.fetchedAt)) / 1000;
    const fresh = Number.isFinite(ageSeconds) && ageSeconds <= ttlSeconds;
    const tooStale =
      opts.maxStaleSeconds !== undefined &&
      (!Number.isFinite(ageSeconds) || ageSeconds > ttlSeconds + Math.max(0, opts.maxStaleSeconds));
    const sourced: Sourced<T> = {
      data,
      asOf: row.asOf,
      source: provider,
      endpoint,
      fetchedAt: row.fetchedAt,
    };
    if (fresh) return sourced;
    if (tooStale) return fetchStoreReturn();
    startBackgroundRefresh(cacheKey, opts);
    return {
      ...sourced,
      stale: true,
      ...(preservedEmptyRefreshes.has(cacheKey)
        ? { staleReason: "empty-refresh-preserved" as const }
        : {}),
    };
  }

  // Miss — fetch, store, return. Fetcher errors propagate to the caller.
  preservedEmptyRefreshes.delete(cacheKey);
  return fetchStoreReturn();
}

// ---------------------------------------------------------------------------
// Maintenance helpers
// ---------------------------------------------------------------------------

/**
 * Deletes all cache rows for `provider` whose endpoint starts with
 * `endpointPrefix` (empty prefix = every row for the provider). Returns the
 * number of rows deleted.
 *
 * NOTE (audit 2026-07-11 #6): this is a maintenance utility with NO production
 * caller today — it is intentionally NOT wired to a
 * latest-financial-statements.dateAdded restatement trigger (the provider data contract §3 once
 * described that as a use case). FMP restatements are currently picked up by the
 * normal 24h fundamentals TTL (serve-stale + background refresh) plus the
 * EDGAR XBRL max(filed) dedup, which already prefers the latest restated value.
 * A dateAdded-triggered invalidate() would need an empty-body/last-good
 * safeguard (see M6) to avoid deleting good rows on a provider blip; until that
 * exists, do not treat this hook as live restatement protection.
 */
export function invalidate(provider: DataSource | string, endpointPrefix = ""): number {
  const db = getDb();
  const escaped = endpointPrefix.replace(/[\\%_]/g, (m) => `\\${m}`);
  const result = db
    .delete(apiCache)
    .where(
      and(
        eq(apiCache.provider, provider),
        sql`${apiCache.endpoint} LIKE ${`${escaped}%`} ESCAPE '\\'`,
      ),
    )
    .run();
  return result.changes;
}

/**
 * Deletes every cache row fetched more than `maxAgeSeconds` ago, regardless
 * of TTL. Manual housekeeping only — beware that transcripts/filings are
 * intentionally cached "forever"; purging them just costs a refetch.
 * Returns the number of rows deleted.
 */
export function purgeOlderThan(maxAgeSeconds: number): number {
  const cutoffIso = new Date(Date.now() - maxAgeSeconds * 1000).toISOString();
  const result = getDb().delete(apiCache).where(lt(apiCache.fetchedAt, cutoffIso)).run();
  return result.changes;
}
