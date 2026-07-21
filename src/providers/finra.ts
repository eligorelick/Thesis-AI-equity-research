/**
 * FINRA Query API client — consolidated equity short interest.
 *
 * Server-only. Dataset: otcMarket/consolidatedShortInterest (all exchange-listed
 * + OTC equities, 5 rolling years). LIVE-verified unauthenticated 2026-07-06:
 * both the partitions GET and the filtered POST return 200 with no credentials.
 * FINRA's docs officially describe OAuth2 client-credentials — public access may
 * tighten at any time, so an `authToken` config hook is provided; when set it is
 * sent as `Authorization: Bearer <token>` (the documented FIP scheme).
 *
 * Conventions (the provider data contract §1.3, §2.14):
 * - Latest cycle CANNOT be found by sorting (sortFields → HTTP 400 unless every
 *   partition key is pinned EQUAL). Use the /partitions endpoint instead.
 * - `daysToCoverQuantity` uses sentinel 999.99 when ADV ≈ 0 → normalized to
 *   null with a disclosure note.
 * - Data gaps return { ok: false, gap } — never thrown.
 */

import "server-only";

import { z } from "zod";
import type { FetchResult, ManifestEntry, Sourced } from "@/types/core";

/** Cache TTL for FINRA responses (partitions + rows), seconds. */
export const FINRA_TTL_SECONDS = 86400;

/** FINRA emits this in `daysToCoverQuantity` when average daily volume ≈ 0. */
export const FINRA_DAYS_TO_COVER_SENTINEL = 999.99;

/** Max partitions a trend query will span (~6 months at 2 cycles/month). */
export const FINRA_MAX_TREND_PARTITIONS = 12;

const DEFAULT_BASE_URL = "https://api.finra.org";
const DATA_PATH = "/data/group/otcMarket/name/consolidatedShortInterest";
const PARTITIONS_PATH = "/partitions/group/otcMarket/name/consolidatedShortInterest";
const DEFAULT_RETRY_DELAYS_MS = [500, 2000];
const DEFAULT_MIN_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 15_000;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface FinraConfig {
  /**
   * Future-proofing hook: FINRA's documented access model is OAuth2 (FIP).
   * If/when public access closes, set the Bearer token here — no other code
   * changes needed. Currently unnecessary (live-verified keyless).
   */
  authToken?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** Backoff delays between retries of transient failures. [] disables retries. */
  retryDelaysMs?: number[];
  /** Minimum spacing between FINRA requests (politeness). 0 disables. */
  minRequestIntervalMs?: number;
  /** Per-attempt timeout. 0 disables AbortController timeout. */
  timeoutMs?: number;
  /** Job/request cancellation, composed with each per-attempt timeout. */
  signal?: AbortSignal;
}

/** One short-interest settlement-cycle row, normalized. Field names mirror FINRA's. */
export interface ShortInterestPoint {
  symbol: string;
  issueName: string | null;
  /** Settlement date of the reporting cycle (YYYY-MM-DD). This is the datum's asOf. */
  settlementDate: string;
  /** Headline shares short. */
  currentShortPositionQuantity: number;
  previousShortPositionQuantity: number | null;
  changePreviousNumber: number | null;
  changePercent: number | null;
  averageDailyVolumeQuantity: number | null;
  /** Days to cover; null when FINRA's 999.99 sentinel was present (ADV ≈ 0). */
  daysToCoverQuantity: number | null;
  /** True when 999.99 sentinel was replaced with null — render "n/m". */
  daysToCoverSentinel: boolean;
  /** Listing venue code, e.g. NYSE, NNM. */
  marketClassCode: string | null;
  /** Disclosure notes attached during normalization (e.g. sentinel handling). */
  notes: string[];
}

/** Body shape for the FINRA data POST. */
export interface FinraQueryBody {
  limit: number;
  compareFilters: { compareType: "EQUAL"; fieldName: string; fieldValue: string }[];
  domainFilters?: { fieldName: string; values: string[] }[];
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Normalize FINRA's days-to-cover, mapping the 999.99 sentinel (ADV ≈ 0) to null.
 */
export function normalizeDaysToCover(value: number | null | undefined): {
  value: number | null;
  sentinel: boolean;
} {
  if (value === null || value === undefined) return { value: null, sentinel: false };
  // Compare with tolerance — the sentinel arrives as the float 999.99.
  if (Math.abs(value - FINRA_DAYS_TO_COVER_SENTINEL) < 1e-6) {
    return { value: null, sentinel: true };
  }
  return { value, sentinel: false };
}

/**
 * Build the POST body for consolidatedShortInterest.
 * One settlement date → EQUAL compareFilter (required for any future sorting);
 * several dates → domainFilters IN (LIVE-verified 2026-07-06).
 */
export function buildShortInterestQuery(
  symbol: string,
  settlementDates: readonly string[],
  limit = 5000,
): FinraQueryBody {
  const sym = symbol.trim().toUpperCase();
  if (sym.length === 0) throw new TypeError("buildShortInterestQuery: empty symbol");
  if (settlementDates.length === 0) {
    throw new TypeError("buildShortInterestQuery: at least one settlementDate required");
  }
  const body: FinraQueryBody = {
    limit,
    compareFilters: [{ compareType: "EQUAL", fieldName: "symbolCode", fieldValue: sym }],
  };
  if (settlementDates.length === 1) {
    body.compareFilters.push({
      compareType: "EQUAL",
      fieldName: "settlementDate",
      fieldValue: settlementDates[0],
    });
  } else {
    body.domainFilters = [{ fieldName: "settlementDate", values: [...settlementDates] }];
  }
  return body;
}

const partitionsSchema = z.object({
  availablePartitions: z.array(z.object({ partitions: z.array(z.string()) })),
});

/**
 * Extract the latest `n` settlement dates (descending) from the partitions
 * endpoint payload. Returns null when the payload shape is unrecognized.
 */
export function pickLatestPartitions(payload: unknown, n: number): string[] | null {
  const parsed = partitionsSchema.safeParse(payload);
  if (!parsed.success) return null;
  const dates = parsed.data.availablePartitions
    .flatMap((p) => p.partitions)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (dates.length === 0) return null;
  const unique = [...new Set(dates)].sort().reverse();
  return unique.slice(0, Math.max(1, n));
}

const finraRowSchema = z.object({
  symbolCode: z.string(),
  issueName: z.string().nullish(),
  settlementDate: z.string(),
  currentShortPositionQuantity: z.number(),
  previousShortPositionQuantity: z.number().nullish(),
  changePreviousNumber: z.number().nullish(),
  changePercent: z.number().nullish(),
  averageDailyVolumeQuantity: z.number().nullish(),
  daysToCoverQuantity: z.number().nullish(),
  marketClassCode: z.string().nullish(),
});

/**
 * Parse + normalize FINRA data rows. Returns null when the payload is not an
 * array of recognizable rows (caller converts to a gap).
 */
export function parseShortInterestRows(payload: unknown): ShortInterestPoint[] | null {
  if (!Array.isArray(payload)) return null;
  const out: ShortInterestPoint[] = [];
  for (const raw of payload) {
    const parsed = finraRowSchema.safeParse(raw);
    if (!parsed.success) return null;
    const r = parsed.data;
    const dtc = normalizeDaysToCover(r.daysToCoverQuantity);
    const notes: string[] = [];
    if (dtc.sentinel) {
      notes.push(
        "daysToCoverQuantity was FINRA sentinel 999.99 (average daily volume ≈ 0) — value withheld, render as n/m",
      );
    }
    out.push({
      symbol: r.symbolCode,
      issueName: r.issueName ?? null,
      settlementDate: r.settlementDate,
      currentShortPositionQuantity: r.currentShortPositionQuantity,
      previousShortPositionQuantity: r.previousShortPositionQuantity ?? null,
      changePreviousNumber: r.changePreviousNumber ?? null,
      changePercent: r.changePercent ?? null,
      averageDailyVolumeQuantity: r.averageDailyVolumeQuantity ?? null,
      daysToCoverQuantity: dtc.value,
      daysToCoverSentinel: dtc.sentinel,
      marketClassCode: r.marketClassCode ?? null,
      notes,
    });
  }
  // Ascending by settlement date; on duplicates (revisions) the later row wins downstream.
  out.sort((a, b) => a.settlementDate.localeCompare(b.settlementDate));
  return out;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

let nextFreeAt = 0;
async function throttle(minIntervalMs: number, signal?: AbortSignal): Promise<void> {
  if (minIntervalMs <= 0) return;
  const now = Date.now();
  const startAt = Math.max(now, nextFreeAt);
  nextFreeAt = startAt + minIntervalMs;
  if (startAt > now) await sleep(startAt - now, signal);
}

interface FinraHttpResult {
  ok: boolean;
  status: number;
  body: unknown;
  /** Human-readable failure summary when ok=false. */
  failure?: string;
}

async function finraRequest(
  path: string,
  init: { method: "GET" } | { method: "POST"; body: FinraQueryBody },
  config: FinraConfig,
): Promise<FinraHttpResult> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const retries = config.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${config.baseUrl ?? DEFAULT_BASE_URL}${path}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.authToken) headers.Authorization = `Bearer ${config.authToken}`;
  if (init.method === "POST") headers["Content-Type"] = "application/json";

  let lastFailure = "no attempt made";
  for (let attempt = 0; attempt <= retries.length; attempt++) {
    config.signal?.throwIfAborted();
    if (attempt > 0) await sleep(retries[attempt - 1], config.signal);
    await throttle(config.minRequestIntervalMs ?? DEFAULT_MIN_INTERVAL_MS, config.signal);
    let res: Response;
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      res = await fetchImpl(url, {
        method: init.method,
        headers,
        body: init.method === "POST" ? JSON.stringify(init.body) : undefined,
        signal:
          controller && config.signal
            ? AbortSignal.any([controller.signal, config.signal])
            : controller?.signal ?? config.signal,
      });
      if (res.ok) {
        try {
          return { ok: true, status: res.status, body: (await res.json()) as unknown };
        } catch {
          lastFailure = `HTTP ${res.status} with unparseable JSON body`;
          continue;
        }
      }
      lastFailure = `HTTP ${res.status} on ${init.method} ${path}`;
      // Retry only transient statuses; 4xx (except 429) will not improve.
      if (res.status !== 429 && res.status < 500) break;
    } catch (err) {
      config.signal?.throwIfAborted();
      lastFailure = `network error: ${err instanceof Error ? err.message : String(err)}`;
      continue; // transient — retry
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return { ok: false, status: 0, body: undefined, failure: lastFailure };
}

function accessGap(field: string, detail: string): ManifestEntry {
  return {
    field,
    reason: `short interest unavailable (FINRA access failed): ${detail}`,
    severity: "warn",
    attemptedSources: ["finra"],
  };
}

function sourced<T>(data: T, asOf: string, endpoint: string): Sourced<T> {
  return { data, asOf, source: "finra", endpoint, fetchedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the most recent published settlement date (partition). Cache 24 h.
 */
export async function latestSettlementDate(
  config: FinraConfig = {},
): Promise<FetchResult<string>> {
  const result = await fetchPartitions(1, "shortInterest.settlementDate", config);
  if (!result.ok) return result;
  return {
    ok: true,
    value: sourced(result.dates[0], result.dates[0], `api.finra.org${PARTITIONS_PATH}`),
  };
}

type PartitionsResult =
  | { ok: true; dates: string[] }
  | { ok: false; gap: ManifestEntry };

async function fetchPartitions(
  n: number,
  gapField: string,
  config: FinraConfig,
): Promise<PartitionsResult> {
  const res = await finraRequest(PARTITIONS_PATH, { method: "GET" }, config);
  if (!res.ok) return { ok: false, gap: accessGap(gapField, res.failure ?? "unknown failure") };
  const dates = pickLatestPartitions(res.body, n);
  if (dates === null) {
    return {
      ok: false,
      gap: accessGap(gapField, "partitions endpoint returned an unrecognized payload shape"),
    };
  }
  return { ok: true, dates };
}

/**
 * Latest short-interest row for a symbol (2 requests: partitions + data POST).
 * asOf = the FINRA settlementDate — reports must label it as such (data is
 * inherently 9–24 days stale; twice-monthly cycle published ~8–11 days after
 * settlement).
 */
export async function shortInterest(
  symbol: string,
  config: FinraConfig = {},
): Promise<FetchResult<ShortInterestPoint>> {
  const sym = symbol.trim().toUpperCase();
  const field = `shortInterest.${sym}`;
  const partitions = await fetchPartitions(1, field, config);
  if (!partitions.ok) return partitions;
  const settlementDate = partitions.dates[0];

  const res = await finraRequest(
    DATA_PATH,
    { method: "POST", body: buildShortInterestQuery(sym, [settlementDate], 5) },
    config,
  );
  if (!res.ok) return { ok: false, gap: accessGap(field, res.failure ?? "unknown failure") };

  const rows = parseShortInterestRows(res.body);
  if (rows === null) {
    return { ok: false, gap: accessGap(field, "data endpoint returned an unrecognized payload shape") };
  }
  const row = rows[rows.length - 1];
  if (!row) {
    return {
      ok: false,
      gap: {
        field,
        reason: `no FINRA short interest row for ${sym} at settlement ${settlementDate} (unlisted, new issue, or symbol mismatch)`,
        severity: "info",
        attemptedSources: ["finra"],
      },
    };
  }
  return { ok: true, value: sourced(row, row.settlementDate, `api.finra.org${DATA_PATH}`) };
}

/**
 * Short-interest trend over the trailing `nPartitions` settlement cycles
 * (max 12 ≈ 6 months). One partitions GET + one domainFilters POST.
 * Rows ascend by settlementDate; asOf = latest settlementDate present.
 */
export async function shortInterestTrend(
  symbol: string,
  nPartitions = FINRA_MAX_TREND_PARTITIONS,
  config: FinraConfig = {},
): Promise<FetchResult<ShortInterestPoint[]>> {
  const sym = symbol.trim().toUpperCase();
  const field = `shortInterest.trend.${sym}`;
  const n = Math.min(Math.max(1, Math.floor(nPartitions)), FINRA_MAX_TREND_PARTITIONS);

  const partitions = await fetchPartitions(n, field, config);
  if (!partitions.ok) return partitions;

  const res = await finraRequest(
    DATA_PATH,
    { method: "POST", body: buildShortInterestQuery(sym, partitions.dates, 5000) },
    config,
  );
  if (!res.ok) return { ok: false, gap: accessGap(field, res.failure ?? "unknown failure") };

  const rows = parseShortInterestRows(res.body);
  if (rows === null) {
    return { ok: false, gap: accessGap(field, "data endpoint returned an unrecognized payload shape") };
  }
  // Dedupe by settlementDate — later rows (revisions) win.
  const bySettlement = new Map<string, ShortInterestPoint>();
  for (const row of rows) bySettlement.set(row.settlementDate, row);
  const deduped = [...bySettlement.values()];
  if (deduped.length === 0) {
    return {
      ok: false,
      gap: {
        field,
        reason: `no FINRA short interest rows for ${sym} across the last ${n} settlement cycles`,
        severity: "info",
        attemptedSources: ["finra"],
      },
    };
  }
  const asOf = deduped[deduped.length - 1].settlementDate;
  return { ok: true, value: sourced(deduped, asOf, `api.finra.org${DATA_PATH}`) };
}
