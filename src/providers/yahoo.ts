/**
 * Yahoo Finance chart endpoint — the keyless price source.
 *
 * Used only for members FMP could not serve (no key, empty, 402, refused
 * symbol) and only after EDGAR resolved the ticker to a real registrant. The
 * endpoint is unofficial: requests carry a browser-style User-Agent (the
 * server answers 429 without one), are rate-limited to 2/s, cached in the
 * durable api_cache, and every failure degrades to a disclosed gap.
 *
 * Contract with the rest of the pipeline: rows are FMP-shaped
 * (FmpEodBarRow / FmpQuoteRow) so Stage B is source-agnostic. `close` is the
 * split-adjusted close (Yahoo's `close` series) to match FMP's
 * "split-adjusted close only" contract; the dividend-adjusted `adjclose` is
 * carried as `adjClose` and not consumed.
 *
 * One fetch path only (`chartRaw`): the query actually put on the wire uses
 * epoch bounds and an events selector, while the endpoint recorded for
 * provenance and used as the cache key stays readable ISO — a human reading
 * the sources appendix should see the date range that was asked for.
 */

import "server-only";

import { z } from "zod";

import {
  fetchWithPolicy,
  HttpTransportError,
  type FetchPolicy,
  type TokenBucketLimiter,
  makeLimiter,
} from "@/providers/http";
import {
  deriveAsOf,
  type CachedFetchFn,
  type CachedFetchResult,
  type FmpEodBarRow,
  type FmpPayload,
  type FmpQuoteRow,
} from "@/providers/fmp";
import type { FetchResult, ManifestEntry, Sourced } from "@/types/core";

const DEFAULT_BASE_URL = "https://query1.finance.yahoo.com";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY_SECONDS = 86_400;

export const YAHOO_TTLS = { history: 24 * HOUR, quote: 15 * MINUTE } as const;

/**
 * Yahoo refuses the chart endpoint (HTTP 429) to clients that send no
 * User-Agent, so one is mandatory. It identifies Thesis honestly while keeping
 * the browser-shaped prefix the edge expects.
 */
export const YAHOO_DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Thesis-research/1.0 (local-first equity research; keyless price fallback)";

/** Production throttle for an unofficial endpoint: deliberately conservative. */
const DEFAULT_RATE_PER_SEC = 2;
const DEFAULT_BURST = 2;

export interface YahooMeta {
  symbol: string;
  currency: string | null;
  exchangeName: string | null;
  fullExchangeName: string | null;
  longName: string | null;
  /** "EQUITY" | "ETF" | ... */
  instrumentType: string | null;
  /** YYYY-MM-DD */
  firstTradeDate: string | null;
  regularMarketPrice: number | null;
  /** ISO datetime */
  regularMarketTime: string | null;
  regularMarketDayHigh: number | null;
  regularMarketDayLow: number | null;
  regularMarketVolume: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  chartPreviousClose: number | null;
}

export interface YahooClientConfig {
  fetchImpl?: typeof fetch;
  limiter?: TokenBucketLimiter;
  cachedFetch?: CachedFetchFn;
  now?: () => Date;
  userAgent?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  baseUrl?: string;
  /** Retries after the first attempt on 429/5xx/network. Transport default is 3. */
  maxRetries?: number;
  /** Base delay for the transport's exponential backoff. Transport default is 500 ms. */
  retryBaseDelayMs?: number;
}

/** FMP spells share classes "BRK.B"; Yahoo spells them "BRK-B". */
export function yahooSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\./g, "-");
}

const nullableNumber = z.number().finite().nullish();
const metaSchema = z.looseObject({
  symbol: z.string(),
  currency: z.string().nullish(),
  exchangeName: z.string().nullish(),
  fullExchangeName: z.string().nullish(),
  instrumentType: z.string().nullish(),
  firstTradeDate: nullableNumber,
  regularMarketTime: nullableNumber,
  gmtoffset: nullableNumber,
  regularMarketPrice: nullableNumber,
  regularMarketDayHigh: nullableNumber,
  regularMarketDayLow: nullableNumber,
  regularMarketVolume: nullableNumber,
  fiftyTwoWeekHigh: nullableNumber,
  fiftyTwoWeekLow: nullableNumber,
  chartPreviousClose: nullableNumber,
  longName: z.string().nullish(),
  shortName: z.string().nullish(),
});
const seriesSchema = z.array(z.number().finite().nullable());
const chartSchema = z.object({
  chart: z.object({
    result: z
      .array(
        z.looseObject({
          meta: metaSchema,
          timestamp: z.array(z.number()).optional(),
          indicators: z.looseObject({
            quote: z.array(
              z.looseObject({
                open: seriesSchema.optional(),
                high: seriesSchema.optional(),
                low: seriesSchema.optional(),
                close: seriesSchema.optional(),
                volume: seriesSchema.optional(),
              }),
            ),
            adjclose: z.array(z.looseObject({ adjclose: seriesSchema.optional() })).optional(),
          }),
        }),
      )
      .nullable(),
    error: z
      .looseObject({ code: z.string().nullish(), description: z.string().nullish() })
      .nullable(),
  }),
});
type Chart = z.infer<typeof chartSchema>;
type ChartResult = NonNullable<Chart["chart"]["result"]>[number];

/**
 * A response Yahoo answered but we refuse to treat as data (error envelope,
 * schema drift, unparseable body, HTTP error). Thrown from inside the cache
 * loader so a bad body is never written to the durable cache.
 */
class YahooResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YahooResponseError";
  }
}

type ChartFetch =
  | { ok: true; result: ChartResult; endpoint: string; fetchedAt: string }
  | { ok: false; reason: string; endpoint: string };

function gap<T>(
  field: string,
  reason: string,
  attemptedSources: string[],
  severity: ManifestEntry["severity"] = "warn",
): FetchResult<T> {
  return { ok: false, gap: { field, reason, severity, attemptedSources } };
}

/** Calendar date of a session in the exchange's own offset (never the UTC date). */
function sessionDate(epoch: number, gmtoffset: number | null | undefined): string {
  return new Date((epoch + (gmtoffset ?? 0)) * 1000).toISOString().slice(0, 10);
}

function epochSeconds(isoDay: string): number {
  return Math.floor(Date.parse(`${isoDay}T00:00:00Z`) / 1000);
}

function num(value: number | null | undefined): number | null {
  return typeof value === "number" ? value : null;
}

function metaOf(result: ChartResult): YahooMeta {
  const m = result.meta;
  return {
    symbol: m.symbol,
    currency: m.currency ?? null,
    exchangeName: m.exchangeName ?? null,
    fullExchangeName: m.fullExchangeName ?? null,
    longName: m.longName ?? m.shortName ?? null,
    instrumentType: m.instrumentType ?? null,
    firstTradeDate:
      typeof m.firstTradeDate === "number" ? sessionDate(m.firstTradeDate, m.gmtoffset) : null,
    regularMarketPrice: num(m.regularMarketPrice),
    regularMarketTime:
      typeof m.regularMarketTime === "number"
        ? new Date(m.regularMarketTime * 1000).toISOString()
        : null,
    regularMarketDayHigh: num(m.regularMarketDayHigh),
    regularMarketDayLow: num(m.regularMarketDayLow),
    regularMarketVolume: num(m.regularMarketVolume),
    fiftyTwoWeekHigh: num(m.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: num(m.fiftyTwoWeekLow),
    chartPreviousClose: num(m.chartPreviousClose),
  };
}

function chartEndpoint(ySymbol: string, query: string): string {
  return `/v8/finance/chart/${encodeURIComponent(ySymbol)}?${query}`;
}

export class YahooClient {
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly limiter: TokenBucketLimiter;
  private readonly cachedFetch: CachedFetchFn;
  private readonly now: () => Date;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly signal: AbortSignal | undefined;
  private readonly baseUrl: string;
  private readonly maxRetries: number | undefined;
  private readonly retryBaseDelayMs: number | undefined;

  constructor(config: YahooClientConfig = {}) {
    this.fetchImpl = config.fetchImpl;
    this.limiter = config.limiter ?? makeLimiter(DEFAULT_RATE_PER_SEC, DEFAULT_BURST);
    this.cachedFetch = config.cachedFetch ?? (async (_key, _ttl, loader) => ({ value: await loader() }));
    this.now = config.now ?? (() => new Date());
    this.userAgent = config.userAgent ?? YAHOO_DEFAULT_USER_AGENT;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.signal = config.signal;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxRetries = config.maxRetries;
    this.retryBaseDelayMs = config.retryBaseDelayMs;
  }

  /**
   * The only fetch path. `wireQuery` is what Yahoo receives; `displayEndpoint`
   * is what provenance and the cache key record.
   */
  private async chartRaw(
    ySymbol: string,
    wireQuery: string,
    displayEndpoint: string,
    ttlMs: number,
  ): Promise<ChartFetch> {
    const url = `${this.baseUrl}/v8/finance/chart/${encodeURIComponent(ySymbol)}?${wireQuery}`;
    const cacheKey = `yahoo:${displayEndpoint}`;
    let exchange: CachedFetchResult<{ result: ChartResult; fetchedAt: string }>;
    try {
      exchange = await this.cachedFetch(cacheKey, ttlMs, async () => {
        const policy: FetchPolicy = {
          provider: "yahoo",
          timeoutMs: this.timeoutMs,
          signal: this.signal,
          limiter: this.limiter,
          ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
          ...(this.maxRetries === undefined ? {} : { maxRetries: this.maxRetries }),
          ...(this.retryBaseDelayMs === undefined
            ? {}
            : { retryBaseDelayMs: this.retryBaseDelayMs }),
        };
        const res = await fetchWithPolicy(
          url,
          { headers: { "user-agent": this.userAgent, accept: "application/json" } },
          policy,
        );
        let body: unknown;
        try {
          body = res.bodyText.length > 0 ? (JSON.parse(res.bodyText) as unknown) : null;
        } catch {
          throw new YahooResponseError(
            `Yahoo returned unparseable body (HTTP ${res.status}) for ${displayEndpoint}: ${res.bodyText.slice(0, 200)}`,
          );
        }
        const parsed = chartSchema.safeParse(body);
        if (!parsed.success) {
          throw new YahooResponseError(
            `Yahoo provider schema drift for ${displayEndpoint}: ${parsed.error.issues[0]?.message ?? "invalid body"} (HTTP ${res.status})`,
          );
        }
        const chart = parsed.data.chart;
        // The error envelope carries the actionable reason (delisted, unknown
        // symbol) and is checked before the raw status so the gap reads well.
        if (chart.error) {
          throw new YahooResponseError(
            `Yahoo error for ${displayEndpoint}: ${chart.error.code ?? "?"}: ${chart.error.description ?? "no description"} (HTTP ${res.status})`,
          );
        }
        if (!res.ok) {
          throw new YahooResponseError(
            `Yahoo HTTP ${res.status} for ${displayEndpoint}: ${res.bodyText.slice(0, 200)}`,
          );
        }
        const result = chart.result?.[0];
        if (result === undefined) {
          throw new YahooResponseError(`Yahoo returned no chart result for ${displayEndpoint}`);
        }
        return { result, fetchedAt: this.now().toISOString() };
      });
    } catch (err) {
      if (err instanceof YahooResponseError) {
        return { ok: false, reason: err.message, endpoint: displayEndpoint };
      }
      if (err instanceof HttpTransportError) {
        return {
          ok: false,
          reason: `Yahoo transport failure for ${displayEndpoint}: ${err.message}`,
          endpoint: displayEndpoint,
        };
      }
      throw err;
    }
    return {
      ok: true,
      result: exchange.value.result,
      endpoint: displayEndpoint,
      fetchedAt: exchange.fetchedAt ?? exchange.value.fetchedAt,
    };
  }

  async dailyHistory(
    symbol: string,
    from: string,
    to: string,
  ): Promise<FetchResult<FmpPayload<FmpEodBarRow>>> {
    const field = `yahoo.dailyHistory(${symbol.trim().toUpperCase()})`;
    const ySymbol = yahooSymbol(symbol);
    // Yahoo's period2 is exclusive; include the `to` session by adding a day.
    const displayEndpoint = chartEndpoint(ySymbol, `interval=1d&period1=${from}&period2=${to}`);
    const wire = `interval=1d&period1=${epochSeconds(from)}&period2=${epochSeconds(to) + DAY_SECONDS}&events=div%2Csplits`;
    const fetched = await this.chartRaw(ySymbol, wire, displayEndpoint, YAHOO_TTLS.history);
    if (!fetched.ok) return gap(field, fetched.reason, [fetched.endpoint]);

    const { result, endpoint, fetchedAt } = fetched;
    const quote = result.indicators.quote[0];
    const stamps = result.timestamp ?? [];
    const adj = result.indicators.adjclose?.[0]?.adjclose ?? [];
    const rows: FmpEodBarRow[] = [];
    for (let i = 0; i < stamps.length; i++) {
      const open = quote?.open?.[i] ?? null;
      const high = quote?.high?.[i] ?? null;
      const low = quote?.low?.[i] ?? null;
      const close = quote?.close?.[i] ?? null;
      const volume = quote?.volume?.[i] ?? null;
      // A halted or not-yet-settled session comes back as nulls. Emitting it as
      // a zero bar would poison every return, drawdown and moving average.
      if (close === null || open === null || high === null || low === null) continue;
      rows.push({
        symbol: ySymbol,
        date: sessionDate(stamps[i]!, result.meta.gmtoffset),
        open,
        high,
        low,
        close,
        volume: volume ?? 0,
        adjClose: adj[i] ?? null,
      });
    }
    if (rows.length === 0) {
      return gap(field, `Yahoo returned no daily bars for ${endpoint}`, [endpoint]);
    }
    // FMP serves EOD newest-first; Stage B relies on that ordering.
    rows.sort((a, b) => (a.date! < b.date! ? 1 : a.date! > b.date! ? -1 : 0));

    const sourced: Sourced<FmpPayload<FmpEodBarRow>> = {
      data: { rows, raw: null },
      asOf: deriveAsOf(rows, fetchedAt),
      source: "yahoo",
      endpoint,
      fetchedAt,
    };
    return { ok: true, value: sourced };
  }

  async meta(symbol: string): Promise<FetchResult<YahooMeta>> {
    const field = `yahoo.meta(${symbol.trim().toUpperCase()})`;
    const ySymbol = yahooSymbol(symbol);
    const query = "range=5d&interval=1d";
    const endpoint = chartEndpoint(ySymbol, query);
    const fetched = await this.chartRaw(ySymbol, query, endpoint, YAHOO_TTLS.quote);
    if (!fetched.ok) return gap(field, fetched.reason, [fetched.endpoint]);

    const meta = metaOf(fetched.result);
    const asOf =
      meta.regularMarketTime !== null
        ? sessionDate(
            Math.floor(Date.parse(meta.regularMarketTime) / 1000),
            fetched.result.meta.gmtoffset,
          )
        : fetched.fetchedAt.slice(0, 10);
    return {
      ok: true,
      value: {
        data: meta,
        asOf,
        source: "yahoo",
        endpoint: fetched.endpoint,
        fetchedAt: fetched.fetchedAt,
      },
    };
  }

  async quote(symbol: string): Promise<FetchResult<FmpPayload<FmpQuoteRow>>> {
    const field = `yahoo.quote(${symbol.trim().toUpperCase()})`;
    const metaRes = await this.meta(symbol);
    if (!metaRes.ok) return { ok: false, gap: { ...metaRes.gap, field } };

    const m = metaRes.value.data;
    if (m.regularMarketPrice === null || m.regularMarketPrice <= 0) {
      return gap(field, `Yahoo chart meta carried no regularMarketPrice for ${m.symbol}`, [
        metaRes.value.endpoint,
      ]);
    }
    const prev = m.chartPreviousClose;
    // The FMP row types spell "the vendor did not send this" as `undefined`,
    // and consumers are written against that. A `null` in a declared numeric
    // field would survive an `!== undefined` guard and then arithmetic would
    // silently turn it into 0 — exactly the "0 means not disclosed" trap this
    // pipeline exists to avoid. So declared fields are omitted when absent;
    // only the extra keys admitted by the index signature (`currency`,
    // `adjClose`) carry an explicit null, where every consumer must narrow
    // `unknown` anyway.
    const row: FmpQuoteRow = {
      symbol: m.symbol,
      name: m.longName ?? undefined,
      price: m.regularMarketPrice,
      change: prev !== null ? m.regularMarketPrice - prev : undefined,
      changePercentage:
        prev !== null && prev > 0 ? (m.regularMarketPrice / prev - 1) * 100 : undefined,
      volume: m.regularMarketVolume ?? undefined,
      dayLow: m.regularMarketDayLow ?? undefined,
      dayHigh: m.regularMarketDayHigh ?? undefined,
      yearHigh: m.fiftyTwoWeekHigh ?? undefined,
      yearLow: m.fiftyTwoWeekLow ?? undefined,
      // Yahoo's chart meta has no share count; a keyless market cap must come
      // from EDGAR shares outstanding, never be invented here.
      marketCap: undefined,
      exchange: m.exchangeName ?? undefined,
      previousClose: prev ?? undefined,
      currency: m.currency,
      timestamp:
        m.regularMarketTime !== null
          ? Math.floor(Date.parse(m.regularMarketTime) / 1000)
          : undefined,
    };
    return {
      ok: true,
      value: {
        data: { rows: [row], raw: null },
        asOf: metaRes.value.asOf,
        source: "yahoo",
        endpoint: metaRes.value.endpoint,
        fetchedAt: metaRes.value.fetchedAt,
      },
    };
  }
}

export function createYahooClient(config: YahooClientConfig = {}): YahooClient {
  return new YahooClient(config);
}
