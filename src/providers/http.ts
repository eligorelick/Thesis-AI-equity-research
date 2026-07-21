/**
 * Shared HTTP layer for all provider clients (server-only — never import from
 * client components).
 *
 * Responsibilities:
 *  - per-provider token-bucket rate limiting (`makeLimiter`, provider registry)
 *  - exponential backoff + jitter retries on 429 / 5xx / network errors (max 3)
 *  - NO retry on other 4xx (auth / plan errors are deterministic — DATA_MAP §1.1)
 *  - request timeout via AbortController
 *  - bandwidth accounting hook (bytes per provider — FMP has a 150 GB/30d cap)
 *
 * Throws only for hard transport failures after retries exhaust (and for
 * programming errors). HTTP error *statuses* are returned to the caller in the
 * HttpResult — the caller decides whether that is a data gap.
 */

import "server-only";

// ---------------------------------------------------------------------------
// Token-bucket limiter
// ---------------------------------------------------------------------------

export interface TokenBucketLimiter {
  readonly ratePerSec: number;
  readonly burst: number;
  /** Take `n` tokens, waiting as long as needed. Rejects only on misuse (n > burst). */
  take(n?: number): Promise<void>;
  /** Take `n` tokens if immediately available; returns false otherwise. */
  tryTake(n?: number): boolean;
  /** Milliseconds until `n` tokens would be available (0 if available now). */
  msUntilAvailable(n?: number): number;
}

export function makeLimiter(
  ratePerSec: number,
  burst: number,
  now: () => number = () => Date.now(),
): TokenBucketLimiter {
  if (!(ratePerSec > 0) || !(burst > 0)) {
    throw new Error(`makeLimiter: ratePerSec and burst must be > 0 (got ${ratePerSec}, ${burst})`);
  }
  let tokens = burst;
  let last = now();

  const refill = (): void => {
    const t = now();
    if (t > last) {
      tokens = Math.min(burst, tokens + ((t - last) / 1000) * ratePerSec);
      last = t;
    }
  };

  return {
    ratePerSec,
    burst,
    tryTake(n = 1): boolean {
      refill();
      if (tokens >= n) {
        tokens -= n;
        return true;
      }
      return false;
    },
    msUntilAvailable(n = 1): number {
      refill();
      if (tokens >= n) return 0;
      return Math.ceil(((n - tokens) / ratePerSec) * 1000);
    },
    async take(n = 1): Promise<void> {
      if (n > burst) {
        throw new Error(`TokenBucketLimiter.take(${n}) exceeds burst capacity ${burst}`);
      }
      for (;;) {
        refill();
        if (tokens >= n) {
          tokens -= n;
          return;
        }
        const waitMs = Math.max(Math.ceil(((n - tokens) / ratePerSec) * 1000), 5);
        await sleep(waitMs);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Per-provider limiter registry
// ---------------------------------------------------------------------------

/**
 * Default client-side throttles per DATA_MAP §1 policies:
 *  fmp:     ≤10 req/s sustained (well under Ultimate 3,000/min). Burst 40 =
 *           one cold /company/[symbol] volley (~38 concurrent calls) admitted
 *           without queuing behind the refill rate; worst-case minute is
 *           40 + 600 sustained ≪ 3,000. Burst 10 serialized every first visit
 *           ~3 s behind the bucket.
 *  edgar:   ≤5 req/s (official max 10/s; we stay at half)
 *  finra:   generous docs allowance; Thesis uses ~2 calls/report
 *  fred:    ≤2 req/s sustained (~120/min widely reported). Burst 8 = one
 *           sector-overlay volley (≤6 series) admitted at once; burst 2 added
 *           ~0.5 s/series of queueing to the first ticker in each sector.
 *  finnhub: 60 calls/min free tier → 1/s
 */
const DEFAULT_PROVIDER_RATES: Record<string, { ratePerSec: number; burst: number }> = {
  fmp: { ratePerSec: 10, burst: 40 },
  edgar: { ratePerSec: 5, burst: 5 },
  finra: { ratePerSec: 5, burst: 5 },
  fred: { ratePerSec: 2, burst: 8 },
  finnhub: { ratePerSec: 1, burst: 5 },
};

const FALLBACK_RATE = { ratePerSec: 2, burst: 2 };

const limiterRegistry = new Map<string, TokenBucketLimiter>();

/** Get (creating on first use) the shared limiter for a provider. */
export function getProviderLimiter(provider: string): TokenBucketLimiter {
  let limiter = limiterRegistry.get(provider);
  if (!limiter) {
    const rate = DEFAULT_PROVIDER_RATES[provider] ?? FALLBACK_RATE;
    limiter = makeLimiter(rate.ratePerSec, rate.burst);
    limiterRegistry.set(provider, limiter);
  }
  return limiter;
}

/** Override a provider's limiter (e.g. tighter throttle after live verification). */
export function setProviderLimiter(provider: string, limiter: TokenBucketLimiter): void {
  limiterRegistry.set(provider, limiter);
}

// ---------------------------------------------------------------------------
// Bandwidth accounting
// ---------------------------------------------------------------------------

export type BandwidthRecorder = (provider: string, bytes: number, url: string) => void;

let bandwidthRecorder: BandwidthRecorder | null = null;
const bandwidthTotals = new Map<string, number>();

/** Register a hook invoked with (provider, bytes, url) for every response body read. */
export function setBandwidthRecorder(recorder: BandwidthRecorder | null): void {
  bandwidthRecorder = recorder;
}

/** Cumulative body bytes per provider for this process (in-memory tally). */
export function getBandwidthTotals(): Record<string, number> {
  return Object.fromEntries(bandwidthTotals);
}

export function resetBandwidthTotals(): void {
  bandwidthTotals.clear();
}

function recordBandwidth(provider: string, bytes: number, url: string): void {
  bandwidthTotals.set(provider, (bandwidthTotals.get(provider) ?? 0) + bytes);
  if (bandwidthRecorder) {
    try {
      bandwidthRecorder(provider, bytes, url);
    } catch {
      // accounting hooks must never break a fetch
    }
  }
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

/**
 * Exponential backoff with equal jitter:
 *   raw = baseMs * 2^attempt, capped at maxMs
 *   delay = raw/2 + random() * raw/2
 * `attempt` is 0-based (0 = first retry).
 */
export function computeBackoffMs(
  attempt: number,
  baseMs = 500,
  maxMs = 15_000,
  random: () => number = Math.random,
): number {
  const raw = Math.min(baseMs * 2 ** attempt, maxMs);
  return Math.round(raw / 2 + random() * (raw / 2));
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into ms, capped. */
export function parseRetryAfterMs(headerValue: string | null, capMs = 30_000): number | null {
  if (!headerValue) return null;
  const secs = Number(headerValue);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, capMs);
  const dateMs = Date.parse(headerValue);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? Math.min(delta, capMs) : 0;
  }
  return null;
}

// ---------------------------------------------------------------------------
// fetchWithPolicy
// ---------------------------------------------------------------------------

export interface FetchPolicy {
  /** Provider id — keys the rate limiter and bandwidth tally ("fmp", "edgar", ...). */
  provider: string;
  /** Per-attempt timeout (AbortController). Default 30 s. */
  timeoutMs?: number;
  /** Job/request cancellation signal, composed with RequestInit.signal and the timeout. */
  signal?: AbortSignal;
  /** Max retries AFTER the initial attempt on 429/5xx/network. Default 3. */
  maxRetries?: number;
  /** Base delay for exponential backoff. Default 500 ms. */
  retryBaseDelayMs?: number;
  /** Override the shared provider limiter (tests / special flows). */
  limiter?: TokenBucketLimiter;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-call bandwidth hook, called in addition to the global recorder. */
  onBytes?: BandwidthRecorder;
  /** Injectable sleep (tests). */
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface HttpResult {
  url: string;
  status: number;
  ok: boolean;
  headers: Headers;
  bodyText: string;
  /** Decoded body size in bytes (what we count against bandwidth caps). */
  bytes: number;
  /** Total attempts made (1 = no retries needed). */
  attempts: number;
}

/**
 * Fetch a provider URL without allowing native redirect handling to cross an
 * origin (or downgrade HTTPS). Provider API keys and bearer tokens must never
 * be sent to a redirect target that the provider did not explicitly own.
 * Same-origin redirects are followed for compatibility with provider edge
 * caches; cross-origin redirects are returned as the original 3xx response so
 * callers can surface a normal provider gap.
 */
export async function fetchWithRedirectPolicy(
  input: string | URL,
  init: RequestInit | undefined,
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response> = fetch,
  maxRedirects = 5,
): Promise<Response> {
  let current = new URL(String(input));
  const origin = current.origin;
  const originalProtocol = current.protocol;
  let currentInit: RequestInit = { ...init, redirect: "manual" };

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const response = await fetchImpl(current.toString(), currentInit);
    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    if (hop === maxRedirects) return response;

    let target: URL;
    try {
      target = new URL(location, current);
    } catch {
      return response;
    }

    // Provider defaults are HTTPS. Permit HTTP only for loopback test/dev
    // endpoints, never for a remote host.
    const loopback = target.hostname === "localhost" || target.hostname === "127.0.0.1" || target.hostname === "[::1]";
    if (target.protocol !== originalProtocol || (target.protocol !== "https:" && !loopback)) return response;
    if (target.origin !== origin) return response;

    // Match Fetch's method rewriting for legacy 301/302/303 redirects while
    // preserving the body for 307/308. This avoids replaying a POST body to a
    // redirected path that the provider intended to receive as a GET.
    if ([301, 302, 303].includes(response.status)) {
      const method = (currentInit.method ?? "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") {
        const nextHeaders = new Headers(currentInit.headers);
        nextHeaders.delete("content-length");
        nextHeaders.delete("content-type");
        currentInit = { ...currentInit, method: "GET", body: undefined, headers: nextHeaders };
      }
    }
    current = target;
  }
  return new Response(null, { status: 508, statusText: "redirect loop" });
}

/** Hard transport failure after retries exhausted (network error / timeout). */
export class HttpTransportError extends Error {
  readonly url: string;
  readonly provider: string;
  readonly attempts: number;
  constructor(message: string, opts: { url: string; provider: string; attempts: number; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.name = "HttpTransportError";
    this.url = opts.url;
    this.provider = opts.provider;
    this.attempts = opts.attempts;
  }
}

/** Caller/job cancellation. Unlike a transport failure, this is never retried. */
export class HttpRequestAbortedError extends Error {
  readonly url: string;
  readonly provider: string;
  readonly attempts: number;
  constructor(message: string, opts: { url: string; provider: string; attempts: number; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.name = "HttpRequestAbortedError";
    this.url = opts.url;
    this.provider = opts.provider;
    this.attempts = opts.attempts;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Fetch with per-provider rate limiting, retries and bandwidth accounting.
 *
 * - Waits on the provider token bucket before every attempt.
 * - Retries 429 / 5xx / network failures with exponential backoff + jitter
 *   (honoring Retry-After when present), up to `maxRetries` (default 3).
 * - Does NOT retry other 4xx (401/402/403 auth & plan errors are deterministic).
 * - Reads the full body text; returns status + body for ALL HTTP responses
 *   (including the final 429/5xx after retries) — callers map those to gaps.
 * - Throws HttpTransportError only when the network/timeout failure persists
 *   through all retries.
 */
export async function fetchWithPolicy(
  url: string,
  init: RequestInit | undefined,
  policy: FetchPolicy,
): Promise<HttpResult> {
  const {
    provider,
    timeoutMs = 30_000,
    signal: policySignal,
    maxRetries = 3,
    retryBaseDelayMs = 500,
    limiter = getProviderLimiter(provider),
    fetchImpl = fetch,
    onBytes,
    sleepImpl = sleep,
  } = policy;

  const externalSignals = [init?.signal, policySignal].filter(
    (candidate): candidate is AbortSignal => candidate !== null && candidate !== undefined,
  );
  const externalSignal = combineSignals(externalSignals);

  let attempts = 0;
  let lastResult: HttpResult | null = null;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    throwIfExternallyAborted(externalSignal, url, provider, attempts);
    await limiter.take(1);
    throwIfExternallyAborted(externalSignal, url, provider, attempts);
    attempts++;

    const timeoutController = new AbortController();
    const timer = setTimeout(
      () => timeoutController.abort(new Error(`timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const attemptSignal = combineSignals(
      externalSignal === undefined
        ? [timeoutController.signal]
        : [externalSignal, timeoutController.signal],
    );

    try {
      const response = await fetchWithRedirectPolicy(
        url,
        { ...init, signal: attemptSignal },
        fetchImpl,
      );
      const bodyText = await response.text();
      const bytes = byteLength(bodyText);
      recordBandwidth(provider, bytes, url);
      if (onBytes) {
        try {
          onBytes(provider, bytes, url);
        } catch {
          /* hooks never break fetches */
        }
      }

      const result: HttpResult = {
        url,
        status: response.status,
        ok: response.ok,
        headers: response.headers,
        bodyText,
        bytes,
        attempts,
      };

      if (!isRetriableStatus(response.status)) return result;

      lastResult = result;
      if (attempt < maxRetries) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        const backoff = computeBackoffMs(attempt, retryBaseDelayMs);
        await waitBeforeRetry(
          Math.max(retryAfterMs ?? 0, backoff),
          sleepImpl,
          externalSignal,
          url,
          provider,
          attempts,
        );
      }
    } catch (err) {
      if (externalSignal?.aborted) {
        throw abortedError(url, provider, attempts, externalSignal.reason ?? err);
      }
      lastError = err;
      if (attempt < maxRetries) {
        await waitBeforeRetry(
          computeBackoffMs(attempt, retryBaseDelayMs),
          sleepImpl,
          externalSignal,
          url,
          provider,
          attempts,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastResult) return lastResult; // retriable HTTP status persisted — caller's call
  throw new HttpTransportError(
    `fetch failed for ${provider} after ${attempts} attempt(s): ${errorMessage(lastError)}`,
    { url, provider, attempts, cause: lastError },
  );
}

function combineSignals(signals: AbortSignal[]): AbortSignal | undefined {
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

function throwIfExternallyAborted(
  signal: AbortSignal | undefined,
  url: string,
  provider: string,
  attempts: number,
): void {
  if (signal?.aborted) throw abortedError(url, provider, attempts, signal.reason);
}

function abortedError(
  url: string,
  provider: string,
  attempts: number,
  cause: unknown,
): HttpRequestAbortedError {
  return new HttpRequestAbortedError(
    `fetch canceled for ${provider} after ${attempts} attempt(s): ${errorMessage(cause)}`,
    { url, provider, attempts, cause },
  );
}

async function sleepWithSignal(
  ms: number,
  sleepImpl: (ms: number) => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await sleepImpl(ms);
    return;
  }
  if (signal.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");

  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    sleepImpl(ms).then(
      () => {
        cleanup();
        resolve();
      },
      (err: unknown) => {
        cleanup();
        reject(err);
      },
    );
  });
}

async function waitBeforeRetry(
  ms: number,
  sleepImpl: (ms: number) => Promise<void>,
  signal: AbortSignal | undefined,
  url: string,
  provider: string,
  attempts: number,
): Promise<void> {
  try {
    await sleepWithSignal(ms, sleepImpl, signal);
  } catch (err) {
    if (signal?.aborted) throw abortedError(url, provider, attempts, signal.reason ?? err);
    throw err;
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
