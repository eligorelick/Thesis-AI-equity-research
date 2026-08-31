import { describe, expect, it, vi } from "vitest";

import { insiderSentiment } from "@/providers/finnhub";

/**
 * Insider sentiment drives a forensic signal, so it must be bound to the issuer
 * that was requested and to MSPR's documented domain. The schema previously
 * discarded the response's `symbol` entirely and accepted any finite number for
 * year, month and mspr, so a wrong-issuer payload — or a month of 99, or an
 * MSPR of 5000 — was admitted as this company's data.
 */
const CONFIG = {
  apiKey: "FINNHUB-KEY",
  retryDelaysMs: [] as number[],
  minRequestIntervalMs: 0,
  timeoutMs: 0,
};

function respond(body: unknown) {
  return {
    ...CONFIG,
    fetchImpl: vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  };
}

const month = (over: Record<string, unknown> = {}) => ({
  symbol: "AAPL",
  year: 2026,
  month: 6,
  change: 10,
  mspr: 3.5,
  ...over,
});

const ok = (rows: unknown[]) => ({ symbol: "AAPL", data: rows });

describe("Finnhub insider-sentiment contract", () => {
  it("accepts a well-formed, issuer-matched response", async () => {
    const r = await insiderSentiment("AAPL", "2026-01-01", "2026-07-31", respond(ok([month()])));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data).toEqual([{ year: 2026, month: 6, change: 10, mspr: 3.5 }]);
  });

  it("rejects a response for a different issuer", async () => {
    const r = await insiderSentiment(
      "AAPL",
      "2026-01-01",
      "2026-07-31",
      respond({ symbol: "MSFT", data: [month({ symbol: "MSFT" })] }),
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.gap.reason).toMatch(/issuer|symbol/i);
  });

  it("rejects a row belonging to a different issuer", async () => {
    const r = await insiderSentiment(
      "AAPL",
      "2026-01-01",
      "2026-07-31",
      respond(ok([month(), month({ symbol: "MSFT" })])),
    );

    expect(r.ok).toBe(false);
  });

  it("rejects an impossible month", async () => {
    const r = await insiderSentiment(
      "AAPL",
      "2026-01-01",
      "2026-07-31",
      respond(ok([month({ month: 99 })])),
    );

    expect(r.ok).toBe(false);
  });

  it("rejects an implausible year", async () => {
    const r = await insiderSentiment(
      "AAPL",
      "2026-01-01",
      "2026-07-31",
      respond(ok([month({ year: 1 })])),
    );

    expect(r.ok).toBe(false);
  });

  it("rejects an MSPR outside its documented -100..100 range", async () => {
    const r = await insiderSentiment(
      "AAPL",
      "2026-01-01",
      "2026-07-31",
      respond(ok([month({ mspr: 5000 })])),
    );

    expect(r.ok).toBe(false);
  });

  it("still accepts a null mspr (reported but unavailable)", async () => {
    const r = await insiderSentiment(
      "AAPL",
      "2026-01-01",
      "2026-07-31",
      respond(ok([month({ mspr: null })])),
    );

    expect(r.ok).toBe(true);
  });

  it("treats a valid empty series as informational no-data, not malformed", async () => {
    const r = await insiderSentiment("AAPL", "2026-01-01", "2026-07-31", respond(ok([])));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.gap.severity).toBe("info");
  });
});
