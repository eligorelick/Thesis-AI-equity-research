/**
 * Shared HTTP layer tests — token bucket, backoff math, retry policy,
 * bandwidth accounting. No network: fetch is injected.
 */
import { describe, expect, it } from "vitest";
import {
  computeBackoffMs,
  fetchWithPolicy,
  getBandwidthTotals,
  getProviderLimiter,
  HttpRequestAbortedError,
  HttpTransportError,
  makeLimiter,
  parseRetryAfterMs,
  resetBandwidthTotals,
  setBandwidthRecorder,
} from "@/providers/http";

const FAST = { limiter: makeLimiter(10_000, 10_000), sleepImpl: async () => {} };

function respondingFetch(responses: Array<{ status: number; body: string }>): {
  fetch: typeof fetch;
  calls: () => number;
} {
  let i = 0;
  const impl = (async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (!r) throw new Error("no response configured");
    return new Response(r.body, { status: r.status });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls: () => i };
}

describe("makeLimiter (token bucket)", () => {
  it("allows burst then refills at ratePerSec (fake clock)", () => {
    let t = 0;
    const limiter = makeLimiter(2, 4, () => t); // 2 tokens/s, burst 4
    expect(limiter.tryTake()).toBe(true);
    expect(limiter.tryTake()).toBe(true);
    expect(limiter.tryTake()).toBe(true);
    expect(limiter.tryTake()).toBe(true);
    expect(limiter.tryTake()).toBe(false); // burst exhausted
    expect(limiter.msUntilAvailable()).toBe(500); // 1 token at 2/s = 500ms

    t += 500;
    expect(limiter.tryTake()).toBe(true);
    expect(limiter.tryTake()).toBe(false);

    t += 10_000; // long idle → refill caps at burst
    expect(limiter.tryTake(4)).toBe(true);
    expect(limiter.tryTake()).toBe(false);
  });

  it("rejects invalid construction and over-burst takes", async () => {
    expect(() => makeLimiter(0, 5)).toThrow();
    expect(() => makeLimiter(5, 0)).toThrow();
    await expect(makeLimiter(1, 2).take(3)).rejects.toThrow(/burst/);
  });

  it("registry returns one shared limiter per provider", () => {
    const a = getProviderLimiter("fmp");
    const b = getProviderLimiter("fmp");
    expect(a).toBe(b);
    expect(getProviderLimiter("edgar")).not.toBe(a);
  });

  it("fmp default burst admits one full company-page volley without refill waits", () => {
    // A cold /company/[symbol] load fires ~38 FMP calls concurrently (profile,
    // quote, 6 statement sets, metrics/ratios/growth/scores/EV, analyst pack,
    // insiders, 13F, segments, execs, 3 EOD histories, treasury, MRP,
    // transcript dates + body). The sustained rate stays at the documented
    // ≤10 req/s policy; burst must cover the one-shot volley or a first visit
    // serializes ~3s behind the refill rate (the "10 s to open a ticker" stall).
    const fmp = getProviderLimiter("fmp");
    expect(fmp.ratePerSec).toBe(10);
    expect(fmp.burst).toBeGreaterThanOrEqual(40);
  });

  it("fred default burst admits one sector-overlay volley at the documented ≤2 req/s", () => {
    // First ticker in a GICS sector adds ≤6 sector FRED series on top of the
    // (usually cached) core set. Burst 2 serialized that tail ~0.5 s per series
    // on top of fredgraph latency; burst 8 admits the overlay in one shot while
    // sustained draw stays at the documented ≤2 req/s (~120/min reported cap).
    const fred = getProviderLimiter("fred");
    expect(fred.ratePerSec).toBe(2);
    expect(fred.burst).toBeGreaterThanOrEqual(8);
  });
});

describe("computeBackoffMs / parseRetryAfterMs", () => {
  it("grows exponentially with equal jitter and respects the cap", () => {
    // random() = 1 → full raw value; random() = 0 → half
    expect(computeBackoffMs(0, 500, 15_000, () => 1)).toBe(500);
    expect(computeBackoffMs(1, 500, 15_000, () => 1)).toBe(1000);
    expect(computeBackoffMs(2, 500, 15_000, () => 1)).toBe(2000);
    expect(computeBackoffMs(0, 500, 15_000, () => 0)).toBe(250);
    expect(computeBackoffMs(10, 500, 15_000, () => 1)).toBe(15_000); // capped
  });

  it("parses delta-seconds Retry-After and caps it", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs("9999")).toBe(30_000); // capped
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("not-a-date-or-number")).toBeNull();
  });
});

describe("fetchWithPolicy retry policy", () => {
  it("retries 429 then succeeds", async () => {
    const { fetch, calls } = respondingFetch([
      { status: 429, body: "slow down" },
      { status: 429, body: "slow down" },
      { status: 200, body: "[]" },
    ]);
    const res = await fetchWithPolicy("https://x.test/a", undefined, {
      provider: "test-retry-429",
      fetchImpl: fetch,
      ...FAST,
    });
    expect(res.status).toBe(200);
    expect(res.attempts).toBe(3);
    expect(calls()).toBe(3);
  });

  it("retries 5xx up to maxRetries then returns the last response (no throw)", async () => {
    const { fetch, calls } = respondingFetch([{ status: 503, body: "unavailable" }]);
    const res = await fetchWithPolicy("https://x.test/b", undefined, {
      provider: "test-retry-5xx",
      fetchImpl: fetch,
      maxRetries: 3,
      ...FAST,
    });
    expect(res.status).toBe(503);
    expect(res.attempts).toBe(4); // initial + 3 retries
    expect(calls()).toBe(4);
  });

  it("does NOT retry non-429 4xx (auth/plan errors are deterministic)", async () => {
    for (const status of [400, 401, 402, 403, 404]) {
      const { fetch, calls } = respondingFetch([{ status, body: "{}" }]);
      const res = await fetchWithPolicy("https://x.test/c", undefined, {
        provider: "test-4xx",
        fetchImpl: fetch,
        ...FAST,
      });
      expect(res.status).toBe(status);
      expect(calls()).toBe(1);
    }
  });

  it("throws HttpTransportError after persistent network failure", async () => {
    const impl = (async () => {
      throw new TypeError("fetch failed: network down");
    }) as unknown as typeof fetch;
    await expect(
      fetchWithPolicy("https://x.test/d", undefined, {
        provider: "test-network",
        fetchImpl: impl,
        maxRetries: 2,
        ...FAST,
      }),
    ).rejects.toThrow(HttpTransportError);
  });

  it("preserves a caller AbortSignal and never retries a canceled request", async () => {
    const caller = new AbortController();
    let calls = 0;
    const impl = ((_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === null || signal === undefined) {
          reject(new Error("fetch received no signal"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => reject(signal.reason ?? new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }) as typeof fetch;

    const pending = fetchWithPolicy(
      "https://x.test/cancel",
      { signal: caller.signal },
      {
        provider: "test-caller-abort",
        fetchImpl: impl,
        maxRetries: 3,
        ...FAST,
      },
    );
    await Promise.resolve();
    caller.abort(new Error("job canceled by user"));

    await expect(pending).rejects.toThrow(HttpRequestAbortedError);
    expect(calls).toBe(1);
  });

  it("rejects an already-aborted policy signal before starting transport", async () => {
    const job = new AbortController();
    job.abort(new Error("job deadline exceeded"));
    let calls = 0;
    const impl = (async () => {
      calls++;
      return new Response("[]", { status: 200 });
    }) as typeof fetch;

    await expect(
      fetchWithPolicy("https://x.test/deadline", undefined, {
        provider: "test-policy-abort",
        fetchImpl: impl,
        signal: job.signal,
        ...FAST,
      }),
    ).rejects.toThrow(HttpRequestAbortedError);
    expect(calls).toBe(0);
  });

  it("records bandwidth per provider and fires the hook", async () => {
    resetBandwidthTotals();
    const seen: Array<[string, number]> = [];
    setBandwidthRecorder((provider, bytes) => seen.push([provider, bytes]));
    try {
      const { fetch } = respondingFetch([{ status: 200, body: "0123456789" }]);
      const res = await fetchWithPolicy("https://x.test/e", undefined, {
        provider: "test-bytes",
        fetchImpl: fetch,
        ...FAST,
      });
      expect(res.bytes).toBe(10);
      expect(getBandwidthTotals()["test-bytes"]).toBe(10);
      expect(seen).toEqual([["test-bytes", 10]]);
    } finally {
      setBandwidthRecorder(null);
      resetBandwidthTotals();
    }
  });
});
