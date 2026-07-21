/**
 * FRED (St. Louis Fed) macro client — dual-mode.
 *
 * Server-only.
 * (a) Authenticated v1: GET api.stlouisfed.org/fred/series/observations with
 *     `api_key` query param + `file_type=json` (default output is XML!).
 *     Observation values are STRINGS; missing = "." — skipped here.
 *     Server-side transforms via `units` (pc1 = YoY, chg, ...).
 * (b) Keyless fallback: fred.stlouisfed.org/graph/fredgraph.csv?id=SERIES —
 *     undocumented but LIVE-verified (2026-07-05/06). Single series only
 *     (`cosd` is ignored on multi-id requests). "." / empty rows skipped.
 *     `units` transforms are computed CLIENT-SIDE from the official ALFRED
 *     formulas when in CSV mode (FRED cannot apply them keyless); derived
 *     growth rates may differ marginally from FRED's own (rounded inputs).
 *
 * Rate policy: ≤2 req/s sustained; exponential backoff on 429 (docs publish no
 * number; ~120/min widely reported). See the provider data contract §1.4, the macro-series contract.
 */

import "server-only";

import { z } from "zod";
import type { FetchResult, ManifestEntry, Sourced } from "@/types/core";

/**
 * Mandatory FRED attribution — must be displayed verbatim, visibly, in the app.
 */
export const FRED_ATTRIBUTION =
  "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.";

/** Default cache TTL for FRED series, seconds (4 h). */
export const FRED_TTL_SECONDS = 14400;

/** Faster TTL for daily treasury/rates series, seconds (2 h). */
export const FRED_TREASURY_TTL_SECONDS = 7200;

/** Daily rates series that take the faster treasury TTL. */
export const FRED_TREASURY_SERIES: ReadonlySet<string> = new Set([
  "DGS10",
  "DGS2",
  "DFII10",
  "T10Y2Y",
  "T10Y3M",
  "T10YIE",
  "EFFR",
]);

/** Cache TTL for a given series id, seconds. */
export function ttlForFredSeries(id: string): number {
  return FRED_TREASURY_SERIES.has(id.toUpperCase()) ? FRED_TREASURY_TTL_SECONDS : FRED_TTL_SECONDS;
}

/**
 * Third-party copyrighted series (notes contain "Copyright"): fine for personal
 * use; redistribution/publication requires the owner's permission.
 */
export const FRED_COPYRIGHT_SERIES: ReadonlySet<string> = new Set([
  "BAMLH0A0HYM2", // ICE Data Indices
  "VIXCLS", // Cboe
  "CSUSHPINSA", // S&P Dow Jones Indices
  "PCOPPUSDM", // IMF
  "UMCSENT", // University of Michigan
]);

/** FRED `units` transformation codes (ALFRED growth formulas). */
export type FredUnits = "lin" | "chg" | "ch1" | "pch" | "pc1" | "pca" | "cch" | "cca" | "log";

export interface FredSeriesSpec {
  id: string;
  label: string;
  /** Transform the dashboard applies (pc1 = YoY %, chg = period change). */
  units: FredUnits;
}

/**
 * The 12-series core macro dashboard (the macro-series contract §8, all IDs
 * LIVE-verified 2026-07-05).
 */
export const CORE_SERIES: readonly FredSeriesSpec[] = [
  { id: "DGS10", label: "10-Year Treasury Constant Maturity", units: "lin" },
  { id: "DGS2", label: "2-Year Treasury Constant Maturity", units: "lin" },
  { id: "T10Y2Y", label: "10Y minus 2Y Treasury Spread", units: "lin" },
  { id: "T10Y3M", label: "10Y minus 3M Treasury Spread", units: "lin" },
  { id: "EFFR", label: "Effective Federal Funds Rate (daily)", units: "lin" },
  { id: "CPIAUCSL", label: "CPI-U All Items, YoY %", units: "pc1" },
  { id: "CPILFESL", label: "Core CPI (ex food & energy), YoY %", units: "pc1" },
  { id: "UNRATE", label: "Unemployment Rate", units: "lin" },
  { id: "PAYEMS", label: "Nonfarm Payrolls, monthly change (thous.)", units: "chg" },
  { id: "T10YIE", label: "10-Year Breakeven Inflation", units: "lin" },
  { id: "BAMLH0A0HYM2", label: "ICE BofA US High Yield OAS", units: "lin" },
  { id: "VIXCLS", label: "CBOE Volatility Index (VIX)", units: "lin" },
];

/** The 11 GICS sectors. */
export type GicsSector =
  | "Energy"
  | "Materials"
  | "Industrials"
  | "Consumer Discretionary"
  | "Consumer Staples"
  | "Health Care"
  | "Financials"
  | "Information Technology"
  | "Communication Services"
  | "Utilities"
  | "Real Estate";

/**
 * GICS sector → FRED series ids (the macro-series contract §9, all LIVE-verified
 * 2026-07-05). Fetched on demand for the routed sector, on top of CORE_SERIES.
 */
export const SECTOR_SERIES: Record<GicsSector, readonly string[]> = {
  Energy: ["DCOILWTICO", "DHHNGSP", "DCOILBRENTEU", "GASREGW"],
  Materials: ["PPIACO", "PCOPPUSDM", "WPU101"],
  Industrials: ["INDPRO", "DGORDER", "TSIFRGHT"],
  "Consumer Discretionary": ["RSAFS", "UMCSENT", "TOTALSA", "PCEDG"],
  "Consumer Staples": ["PCE", "PCEND", "CPIAUCSL"],
  "Health Care": ["CPIMEDSL", "CES6562000001"],
  Financials: ["T10Y2Y", "EFFR", "FEDFUNDS", "DRTSCILM", "DPSACBW027SBOG", "BAMLH0A0HYM2"],
  "Information Technology": ["DGS10", "DFII10", "NASDAQCOM"],
  "Communication Services": ["DFII10", "NASDAQCOM", "UMCSENT"],
  Utilities: ["DGS10", "IPUTIL", "DHHNGSP", "APU000072610"],
  "Real Estate": ["HOUST", "MORTGAGE30US", "CSUSHPINSA", "CUSR0000SEHA"],
};

/** One parsed observation. `date` is the PERIOD START (May 2026 CPI = 2026-05-01). */
export interface FredObservation {
  date: string;
  value: number;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface FredConfig {
  /** FRED_API_KEY (32-char lowercase alnum). Absent → keyless fredgraph.csv fallback. */
  apiKey?: string;
  fetchImpl?: FetchLike;
  /** Backoff delays between retries of transient failures. [] disables retries. */
  retryDelaysMs?: number[];
  /** Minimum spacing between FRED requests. 0 disables. Default 500 ms (≤2 req/s). */
  minRequestIntervalMs?: number;
  /** Per-attempt timeout. 0 disables AbortController timeout. */
  timeoutMs?: number;
  /** Job/request cancellation, composed with each per-attempt timeout. */
  signal?: AbortSignal;
}

export interface FredSeriesOptions {
  /** observation_start, YYYY-MM-DD. */
  start?: string;
  /** observation_end, YYYY-MM-DD. */
  end?: string;
  /** Transformation; default lin. In keyless CSV mode it is computed client-side. */
  units?: FredUnits;
}

const API_BASE = "https://api.stlouisfed.org/fred/series/observations";
const CSV_BASE = "https://fred.stlouisfed.org/graph/fredgraph.csv";
const DEFAULT_RETRY_DELAYS_MS = [500, 2000];
const DEFAULT_MIN_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Parse a fredgraph.csv body. Header row: `observation_date,SERIES_ID`.
 * Missing values ("." or empty cells) are skipped. Returns null when the body
 * is not recognizable CSV (e.g. an HTML 404 page for an unknown series id).
 */
export function parseFredCsv(csv: string): FredObservation[] | null {
  const lines = csv.split(/\r?\n/);
  const header = lines[0]?.trim() ?? "";
  if (!header.toLowerCase().startsWith("observation_date")) return null;
  const out: FredObservation[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    const comma = line.indexOf(",");
    if (comma === -1) continue;
    const date = line.slice(0, comma).trim();
    const raw = line.slice(comma + 1).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (raw === "." || raw === "") continue; // missing observation
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    out.push({ date, value });
  }
  return out;
}

/**
 * Infer observations-per-year from row spacing, per the ALFRED formula table:
 * Daily=260, Weekly=52, Biweekly=26, Monthly=12, Quarterly=4, Annual=1.
 */
export function inferObsPerYear(rows: readonly FredObservation[]): number {
  if (rows.length < 2) return 1;
  const gaps: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const a = Date.parse(rows[i - 1].date);
    const b = Date.parse(rows[i].date);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
      gaps.push((b - a) / 86_400_000);
    }
  }
  if (gaps.length === 0) return 1;
  gaps.sort((x, y) => x - y);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (median <= 4) return 260; // daily (no weekend rows)
  if (median <= 9) return 52; // weekly
  if (median <= 17) return 26; // biweekly
  if (median <= 45) return 12; // monthly
  if (median <= 135) return 4; // quarterly
  return 1; // annual
}

/**
 * Apply a FRED `units` transformation client-side (official ALFRED formulas).
 * Used only in keyless CSV mode; the keyed API transforms server-side.
 * Rows must be ascending by date with missing observations already removed.
 */
export function applyFredUnits(
  rows: readonly FredObservation[],
  units: FredUnits,
): FredObservation[] {
  if (units === "lin") return [...rows];
  if (units === "log") {
    return rows.filter((r) => r.value > 0).map((r) => ({ date: r.date, value: Math.log(r.value) }));
  }
  const n = inferObsPerYear(rows);
  const lag = units === "ch1" || units === "pc1" ? n : 1;
  const out: FredObservation[] = [];
  for (let i = lag; i < rows.length; i++) {
    const x = rows[i].value;
    const prev = rows[i - lag].value;
    let value: number;
    switch (units) {
      case "chg":
      case "ch1":
        value = x - prev;
        break;
      case "pch":
      case "pc1":
        if (prev === 0) continue;
        value = (x / prev - 1) * 100;
        break;
      case "pca":
        if (prev === 0 || x / prev <= 0) continue;
        value = ((x / prev) ** n - 1) * 100;
        break;
      case "cch":
        if (x <= 0 || prev <= 0) continue;
        value = (Math.log(x) - Math.log(prev)) * 100;
        break;
      case "cca":
        if (x <= 0 || prev <= 0) continue;
        value = (Math.log(x) - Math.log(prev)) * 100 * n;
        break;
    }
    out.push({ date: rows[i].date, value });
  }
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

interface HttpText {
  ok: boolean;
  status: number;
  text: string;
  failure?: string;
}

async function fredRequest(url: string, config: FredConfig): Promise<HttpText> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const retries = config.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
        headers: { Accept: "application/json, text/csv, */*" },
        signal:
          controller && config.signal
            ? AbortSignal.any([controller.signal, config.signal])
            : controller?.signal ?? config.signal,
      });
      const text = await res.text().catch(() => "");
      if (res.ok) return { ok: true, status: res.status, text };
      lastFailure = `HTTP ${res.status}`;
      // 429 (rate) / 423 (locked) / 5xx are transient; other 4xx will not improve.
      if (res.status !== 429 && res.status !== 423 && res.status < 500) {
        return { ok: false, status: res.status, text, failure: lastFailure };
      }
    } catch (err) {
      config.signal?.throwIfAborted();
      lastFailure = `network error: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return { ok: false, status: 0, text: "", failure: lastFailure };
}

const observationsSchema = z.object({
  observations: z.array(z.object({ date: z.string(), value: z.string() })),
});

function gap(id: string, reason: string, severity: ManifestEntry["severity"]): ManifestEntry {
  return { field: `macro.${id}`, reason, severity, attemptedSources: ["fred"] };
}

function sourced<T>(data: T, asOf: string, endpoint: string): Sourced<T> {
  return { data, asOf, source: "fred", endpoint, fetchedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch observations for one FRED series.
 * Keyed → v1 API (server-side `units`). Keyless (or keyed call failing
 * transiently) → fredgraph.csv fallback with client-side `units`.
 * Missing ("." ) observations are skipped. asOf = latest observation date.
 */
export async function series(
  id: string,
  opts: FredSeriesOptions = {},
  config: FredConfig = {},
): Promise<FetchResult<FredObservation[]>> {
  const seriesId = id.trim().toUpperCase();
  if (seriesId.length === 0 || seriesId.includes(",")) {
    // Multi-id requests silently ignore cosd on fredgraph.csv — programming error.
    throw new TypeError(`fred.series: invalid series id "${id}" (single series only)`);
  }
  const units = opts.units ?? "lin";

  if (config.apiKey) {
    const params = new URLSearchParams({
      series_id: seriesId,
      api_key: config.apiKey,
      file_type: "json",
      sort_order: "asc",
    });
    if (opts.start) params.set("observation_start", opts.start);
    if (opts.end) params.set("observation_end", opts.end);
    if (units !== "lin") params.set("units", units);
    const res = await fredRequest(`${API_BASE}?${params.toString()}`, config);
    if (res.ok) {
      let body: unknown;
      try {
        body = JSON.parse(res.text) as unknown;
      } catch {
        body = undefined;
      }
      const parsed = observationsSchema.safeParse(body);
      if (!parsed.success) {
        return { ok: false, gap: gap(seriesId, `FRED API returned an unrecognized payload for ${seriesId}`, "warn") };
      }
      const rows: FredObservation[] = [];
      for (const o of parsed.data.observations) {
        if (o.value === ".") continue; // missing observation
        const value = Number(o.value);
        if (!Number.isFinite(value)) continue;
        rows.push({ date: o.date, value });
      }
      if (rows.length === 0) {
        return { ok: false, gap: gap(seriesId, `FRED series ${seriesId} returned no numeric observations in range`, "info") };
      }
      const endpoint = `api.stlouisfed.org/fred/series/observations?series_id=${seriesId}${units !== "lin" ? `&units=${units}` : ""}`;
      return { ok: true, value: sourced(rows, rows[rows.length - 1].date, endpoint) };
    }
    if (res.status === 400) {
      // Bad/unregistered key or bad series id — fall through to keyless CSV.
    }
    // Keyed path failed → attempt keyless fallback below.
  }

  // Keyless fallback: fredgraph.csv (undocumented; dev/degraded mode).
  const csvParams = new URLSearchParams({ id: seriesId });
  if (opts.start) csvParams.set("cosd", opts.start);
  if (opts.end) csvParams.set("coed", opts.end);
  const res = await fredRequest(`${CSV_BASE}?${csvParams.toString()}`, config);
  if (!res.ok) {
    const via = config.apiKey ? "FRED API and fredgraph.csv fallback both failed" : "fredgraph.csv (keyless mode) failed";
    return { ok: false, gap: gap(seriesId, `${via}: ${res.failure ?? "unknown failure"}`, "warn") };
  }
  const parsed = parseFredCsv(res.text);
  if (parsed === null) {
    return {
      ok: false,
      gap: gap(seriesId, `fredgraph.csv returned non-CSV for ${seriesId} (unknown series id?)`, "warn"),
    };
  }
  const rows = units === "lin" ? parsed : applyFredUnits(parsed, units);
  if (rows.length === 0) {
    return { ok: false, gap: gap(seriesId, `FRED series ${seriesId} has no numeric observations in range`, "info") };
  }
  const endpoint =
    `fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}` +
    (units !== "lin" ? ` (units=${units} computed client-side)` : "");
  return { ok: true, value: sourced(rows, rows[rows.length - 1].date, endpoint) };
}

/**
 * Latest numeric value of a series (levels, no transform). Looks back ~2 years
 * so quarterly series (e.g. DRTSCILM) still resolve. asOf = observation date.
 */
export async function latestValue(
  id: string,
  config: FredConfig = {},
): Promise<FetchResult<FredObservation>> {
  const start = new Date(Date.now() - 730 * 86_400_000).toISOString().slice(0, 10);
  const result = await series(id, { start }, config);
  if (!result.ok) return result;
  const rows = result.value.data;
  const last = rows[rows.length - 1];
  return { ok: true, value: { ...result.value, data: last, asOf: last.date } };
}
