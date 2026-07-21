/**
 * Finnhub client — deliberately thin (the provider contract §1.7).
 *
 * Server-only. Free tier justifies exactly ONE adapter:
 * - insiderSentiment (MSPR) — always on; unique derived signal FMP lacks.
 * - usptoPatents / lobbying / govSpending — optional sector-conditional
 *   modules behind `enableSectorModules` (default OFF).
 *
 * Everything else on Finnhub is redundant with FMP Ultimate or premium-gated.
 * Short interest was REMOVED from Finnhub entirely → see providers/finra.ts.
 *
 * Auth: `X-Finnhub-Token` header (keeps the key out of URLs/logs).
 * Limits: free tier 60 calls/min (sliding-window limiter below); hard global
 * cap 30 calls/s; 429 on exceed. No key → { ok: false, gap } — never a throw.
 */

import "server-only";

import { z } from "zod";
import type { FetchResult, ManifestEntry, Sourced } from "@/types/core";

/** Cache TTL for insider sentiment, seconds (24 h). */
export const FINNHUB_TTL_SECONDS = 86400;

/** Cache TTL for sector modules (patents/lobbying/gov-spending), seconds (7 d). */
export const FINNHUB_SECTOR_MODULE_TTL_SECONDS = 604800;

const DEFAULT_BASE_URL = "https://finnhub.io/api/v1";
const DEFAULT_RETRY_DELAYS_MS = [1000, 4000];
const DEFAULT_MAX_PER_MINUTE = 60;
const DEFAULT_TIMEOUT_MS = 15_000;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface FinnhubConfig {
  /** FINNHUB_API_KEY. Absent → every call returns a gap ("Finnhub key missing"). */
  apiKey?: string;
  /**
   * Master switch for the optional sector-conditional modules
   * (usptoPatents, lobbying, govSpending). Default false: calls return an
   * "info" gap without touching the network.
   */
  enableSectorModules?: boolean;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** Backoff delays between retries of transient failures. [] disables retries. */
  retryDelaysMs?: number[];
  /** Client-side request budget per rolling minute. Default 60 (free tier). */
  maxRequestsPerMinute?: number;
  /** Per-attempt timeout. 0 disables AbortController timeout. */
  timeoutMs?: number;
  /** Job/request cancellation, composed with each per-attempt timeout. */
  signal?: AbortSignal;
}

/** One month of Finnhub insider sentiment. MSPR ∈ [-100, +100]. */
export interface InsiderSentimentMonth {
  year: number;
  month: number;
  /** Net insider share change for the month. */
  change: number | null;
  /** Monthly Share Purchase Ratio — Finnhub's aggregate insider signal. */
  mspr: number | null;
}

/** USPTO patent record (sector module; 250 records/call). */
export interface UsptoPatentRecord {
  applicationNumber: string | null;
  description: string | null;
  filingDate: string | null;
  filingStatus: string | null;
  patentNumber: string | null;
  patentType: string | null;
  publicationDate: string | null;
  url: string | null;
}

/** Senate/House lobbying record (sector module). */
export interface LobbyingRecord {
  name: string | null;
  description: string | null;
  expenses: number | null;
  income: number | null;
  date: string | null;
  period: string | null;
  year: number | null;
  documentUrl: string | null;
}

/** USASpending federal award (sector module; API carries recent data only). */
export interface GovSpendingAward {
  recipientName: string | null;
  awardingAgencyName: string | null;
  awardingSubAgencyName: string | null;
  totalValue: number | null;
  actionDate: string | null;
  awardDescription: string | null;
  permalink: string | null;
}

// ---------------------------------------------------------------------------
// Rate limiter (sliding window) + transport
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

const requestStamps: number[] = [];
async function acquireSlot(maxPerMinute: number, signal?: AbortSignal): Promise<void> {
  if (maxPerMinute <= 0) return;
  for (;;) {
    const now = Date.now();
    while (requestStamps.length > 0 && now - requestStamps[0] >= 60_000) {
      requestStamps.shift();
    }
    if (requestStamps.length < maxPerMinute) {
      requestStamps.push(now);
      return;
    }
    const oldest = requestStamps[0];
    await sleep(Math.max(50, oldest + 60_000 - now), signal);
  }
}

type FinnhubHttp =
  | { ok: true; body: unknown }
  | { ok: false; failure: string; status: number };

async function finnhubRequest(
  path: string,
  params: Record<string, string>,
  config: FinnhubConfig,
): Promise<FinnhubHttp> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const retries = config.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const search = new URLSearchParams(params);
  const url = `${config.baseUrl ?? DEFAULT_BASE_URL}${path}?${search.toString()}`;

  let lastFailure = "no attempt made";
  let lastStatus = 0;
  for (let attempt = 0; attempt <= retries.length; attempt++) {
    config.signal?.throwIfAborted();
    if (attempt > 0) await sleep(retries[attempt - 1], config.signal);
    await acquireSlot(config.maxRequestsPerMinute ?? DEFAULT_MAX_PER_MINUTE, config.signal);
    let res: Response;
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      res = await fetchImpl(url, {
        headers: { "X-Finnhub-Token": config.apiKey ?? "", Accept: "application/json" },
        signal:
          controller && config.signal
            ? AbortSignal.any([controller.signal, config.signal])
            : controller?.signal ?? config.signal,
      });
      lastStatus = res.status;
      if (res.ok) {
        try {
          return { ok: true, body: (await res.json()) as unknown };
        } catch {
          lastFailure = `HTTP ${res.status} with unparseable JSON body`;
          continue;
        }
      }
      if (res.status === 401) return { ok: false, failure: "Finnhub key rejected (HTTP 401)", status: 401 };
      if (res.status === 403) {
        return { ok: false, failure: "Finnhub endpoint premium-gated for this key (HTTP 403)", status: 403 };
      }
      lastFailure = `HTTP ${res.status} on ${path}`;
      if (res.status !== 429 && res.status < 500) break; // non-transient
    } catch (err) {
      config.signal?.throwIfAborted();
      lastFailure = `network error: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return { ok: false, failure: lastFailure, status: lastStatus };
}

function finnhubGap(
  field: string,
  reason: string,
  severity: ManifestEntry["severity"],
): ManifestEntry {
  return { field, reason, severity, attemptedSources: ["finnhub"] };
}

function sourced<T>(data: T, asOf: string, endpoint: string): Sourced<T> {
  return { data, asOf, source: "finnhub", endpoint, fetchedAt: new Date().toISOString() };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function assertIsoDate(value: string, param: string): void {
  if (!ISO_DATE.test(value)) {
    throw new TypeError(`finnhub: ${param} must be YYYY-MM-DD, got "${value}"`);
  }
}

// ---------------------------------------------------------------------------
// Insider sentiment (MSPR) — always-on adapter
// ---------------------------------------------------------------------------

const insiderSentimentSchema = z.object({
  data: z.array(
    z.object({
      year: z.number(),
      month: z.number(),
      change: z.number().nullish(),
      mspr: z.number().nullish(),
    }),
  ),
});

/**
 * GET /stock/insider-sentiment — monthly MSPR series (US companies only).
 * asOf = latest covered month (first of month). No key → gap.
 */
export async function insiderSentiment(
  symbol: string,
  from: string,
  to: string,
  config: FinnhubConfig = {},
): Promise<FetchResult<InsiderSentimentMonth[]>> {
  const sym = symbol.trim().toUpperCase();
  const field = `insiderSentiment.${sym}`;
  assertIsoDate(from, "from");
  assertIsoDate(to, "to");
  if (!config.apiKey) {
    return { ok: false, gap: finnhubGap(field, "Finnhub key missing", "warn") };
  }

  const res = await finnhubRequest("/stock/insider-sentiment", { symbol: sym, from, to }, config);
  if (!res.ok) {
    return {
      ok: false,
      gap: finnhubGap(field, `insider sentiment unavailable: ${res.failure}`, "warn"),
    };
  }
  const parsed = insiderSentimentSchema.safeParse(res.body);
  if (!parsed.success) {
    return {
      ok: false,
      gap: finnhubGap(field, "insider sentiment payload had an unrecognized shape", "warn"),
    };
  }
  const months: InsiderSentimentMonth[] = parsed.data.data
    .map((m) => ({ year: m.year, month: m.month, change: m.change ?? null, mspr: m.mspr ?? null }))
    .sort((a, b) => a.year - b.year || a.month - b.month);
  if (months.length === 0) {
    return {
      ok: false,
      gap: finnhubGap(field, `no insider sentiment data for ${sym} in ${from}..${to}`, "info"),
    };
  }
  const latest = months[months.length - 1];
  const asOf = `${latest.year}-${String(latest.month).padStart(2, "0")}-01`;
  return {
    ok: true,
    value: sourced(months, asOf, `finnhub.io/api/v1/stock/insider-sentiment?symbol=${sym}`),
  };
}

// ---------------------------------------------------------------------------
// Optional sector modules (default OFF via config.enableSectorModules)
// ---------------------------------------------------------------------------

function sectorModuleGate(
  field: string,
  config: FinnhubConfig,
): ManifestEntry | null {
  if (!config.enableSectorModules) {
    return finnhubGap(
      field,
      "Finnhub sector module disabled (enableSectorModules=false)",
      "info",
    );
  }
  if (!config.apiKey) return finnhubGap(field, "Finnhub key missing", "warn");
  return null;
}

/** Newest ISO date across rows, falling back to the request's `to` bound. */
function newestDate(dates: (string | null)[], fallback: string): string {
  let max = "";
  for (const d of dates) {
    if (d !== null && ISO_DATE.test(d) && d > max) max = d;
  }
  return max !== "" ? max : fallback;
}

const usptoSchema = z.object({
  data: z.array(
    z.object({
      applicationNumber: z.string().nullish(),
      description: z.string().nullish(),
      filingDate: z.string().nullish(),
      filingStatus: z.string().nullish(),
      patentNumber: z.string().nullish(),
      patentType: z.string().nullish(),
      publicationDate: z.string().nullish(),
      url: z.string().nullish(),
    }),
  ),
});

/**
 * GET /stock/uspto-patent — innovation-cadence signal (tech/pharma routes).
 * Sector-conditional: gated behind enableSectorModules (default off).
 * Free tier caps at 250 records/call.
 */
export async function usptoPatents(
  symbol: string,
  from: string,
  to: string,
  config: FinnhubConfig = {},
): Promise<FetchResult<UsptoPatentRecord[]>> {
  const sym = symbol.trim().toUpperCase();
  const field = `sectorModules.usptoPatents.${sym}`;
  assertIsoDate(from, "from");
  assertIsoDate(to, "to");
  const gate = sectorModuleGate(field, config);
  if (gate) return { ok: false, gap: gate };

  const res = await finnhubRequest("/stock/uspto-patent", { symbol: sym, from, to }, config);
  if (!res.ok) {
    return { ok: false, gap: finnhubGap(field, `USPTO patents unavailable: ${res.failure}`, "info") };
  }
  const parsed = usptoSchema.safeParse(res.body);
  if (!parsed.success) {
    return { ok: false, gap: finnhubGap(field, "USPTO patents payload had an unrecognized shape", "info") };
  }
  const records: UsptoPatentRecord[] = parsed.data.data.map((r) => ({
    applicationNumber: r.applicationNumber ?? null,
    description: r.description ?? null,
    filingDate: normalizeDateish(r.filingDate),
    filingStatus: r.filingStatus ?? null,
    patentNumber: r.patentNumber ?? null,
    patentType: r.patentType ?? null,
    publicationDate: normalizeDateish(r.publicationDate),
    url: r.url ?? null,
  }));
  const asOf = newestDate(records.map((r) => r.filingDate ?? r.publicationDate), to);
  return {
    ok: true,
    value: sourced(records, asOf, `finnhub.io/api/v1/stock/uspto-patent?symbol=${sym}`),
  };
}

const lobbyingSchema = z.object({
  data: z.array(
    z.object({
      name: z.string().nullish(),
      description: z.string().nullish(),
      expenses: z.number().nullish(),
      income: z.number().nullish(),
      date: z.string().nullish(),
      period: z.string().nullish(),
      year: z.number().nullish(),
      documentUrl: z.string().nullish(),
    }),
  ),
});

/**
 * GET /stock/lobbying — Senate/House reported lobbying (regulated sectors:
 * defense, pharma, energy). Gated behind enableSectorModules (default off).
 */
export async function lobbying(
  symbol: string,
  from: string,
  to: string,
  config: FinnhubConfig = {},
): Promise<FetchResult<LobbyingRecord[]>> {
  const sym = symbol.trim().toUpperCase();
  const field = `sectorModules.lobbying.${sym}`;
  assertIsoDate(from, "from");
  assertIsoDate(to, "to");
  const gate = sectorModuleGate(field, config);
  if (gate) return { ok: false, gap: gate };

  const res = await finnhubRequest("/stock/lobbying", { symbol: sym, from, to }, config);
  if (!res.ok) {
    return { ok: false, gap: finnhubGap(field, `lobbying data unavailable: ${res.failure}`, "info") };
  }
  const parsed = lobbyingSchema.safeParse(res.body);
  if (!parsed.success) {
    return { ok: false, gap: finnhubGap(field, "lobbying payload had an unrecognized shape", "info") };
  }
  const records: LobbyingRecord[] = parsed.data.data.map((r) => ({
    name: r.name ?? null,
    description: r.description ?? null,
    expenses: r.expenses ?? null,
    income: r.income ?? null,
    date: normalizeDateish(r.date),
    period: r.period ?? null,
    year: r.year ?? null,
    documentUrl: r.documentUrl ?? null,
  }));
  const asOf = newestDate(records.map((r) => r.date), to);
  return {
    ok: true,
    value: sourced(records, asOf, `finnhub.io/api/v1/stock/lobbying?symbol=${sym}`),
  };
}

const govSpendingSchema = z.object({
  data: z.array(
    z.object({
      recipientName: z.string().nullish(),
      awardingAgencyName: z.string().nullish(),
      awardingSubAgencyName: z.string().nullish(),
      totalValue: z.number().nullish(),
      actionDate: z.string().nullish(),
      awardDescription: z.string().nullish(),
      permalink: z.string().nullish(),
    }),
  ),
});

/**
 * GET /stock/usa-spending — federal contract awards (defense/aerospace/gov-IT).
 * Gated behind enableSectorModules (default off). NOTE: the API carries recent
 * data only — deep history requires USASpending bulk downloads; disclose this.
 */
export async function govSpending(
  symbol: string,
  from: string,
  to: string,
  config: FinnhubConfig = {},
): Promise<FetchResult<GovSpendingAward[]>> {
  const sym = symbol.trim().toUpperCase();
  const field = `sectorModules.govSpending.${sym}`;
  assertIsoDate(from, "from");
  assertIsoDate(to, "to");
  const gate = sectorModuleGate(field, config);
  if (gate) return { ok: false, gap: gate };

  const res = await finnhubRequest("/stock/usa-spending", { symbol: sym, from, to }, config);
  if (!res.ok) {
    return { ok: false, gap: finnhubGap(field, `government spending data unavailable: ${res.failure}`, "info") };
  }
  const parsed = govSpendingSchema.safeParse(res.body);
  if (!parsed.success) {
    return { ok: false, gap: finnhubGap(field, "government spending payload had an unrecognized shape", "info") };
  }
  const records: GovSpendingAward[] = parsed.data.data.map((r) => ({
    recipientName: r.recipientName ?? null,
    awardingAgencyName: r.awardingAgencyName ?? null,
    awardingSubAgencyName: r.awardingSubAgencyName ?? null,
    totalValue: r.totalValue ?? null,
    actionDate: normalizeDateish(r.actionDate),
    awardDescription: r.awardDescription ?? null,
    permalink: r.permalink ?? null,
  }));
  const asOf = newestDate(records.map((r) => r.actionDate), to);
  return {
    ok: true,
    value: sourced(records, asOf, `finnhub.io/api/v1/stock/usa-spending?symbol=${sym}`),
  };
}

/** Trim a date-ish string to YYYY-MM-DD when it starts with one; else pass/null. */
function normalizeDateish(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const head = value.slice(0, 10);
  return ISO_DATE.test(head) ? head : value;
}
