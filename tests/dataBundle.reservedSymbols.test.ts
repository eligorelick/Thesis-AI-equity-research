/**
 * D-11: `DEMO` and `DBNK` are reserved fixture symbols. A report for one of
 * them must issue no request to any provider — FMP, SEC EDGAR, Yahoo, FRED,
 * Finnhub or FINRA — whatever API keys are configured, and must say so in the
 * missing-data manifest.
 *
 * Every client here is injected with a transport that counts calls and then
 * fails, so "no request was made" is observed rather than assumed. Before this
 * rule a fixture run still sent the synthetic CIK `0000000000` to data.sec.gov,
 * and a keyed run sent DEMO and DBNK to the vendor.
 */
import { describe, expect, it } from "vitest";

import { buildDataBundle } from "@/pipeline/dataBundle";
import {
  RESERVED_FIXTURE_SYMBOLS,
  anyReservedFixtureSymbol,
  isReservedFixtureSymbol,
  reservedProviderGap,
} from "@/providers/reservedSymbols";
import { createEdgarClient, type EdgarTransport, type EdgarTransportResponse } from "@/providers/edgar";
import { createFmpClient } from "@/providers/fmp";
import { createYahooClient } from "@/providers/yahoo";
import { makeLimiter } from "@/providers/http";

const NOW = new Date("2026-07-06T00:00:00.000Z");

interface Counters {
  fmp: number;
  edgar: number;
  yahoo: number;
  fred: number;
  finnhub: number;
  finra: number;
  total: () => number;
}

function counters(): Counters {
  const c = { fmp: 0, edgar: 0, yahoo: 0, fred: 0, finnhub: 0, finra: 0 };
  return { ...c, total: (): number => c.fmp + c.edgar + c.yahoo + c.fred + c.finnhub + c.finra } as Counters;
}

/** Every injected transport records the call and then refuses, so a call is loud. */
function build(symbol: string, apiKey: string): { bundle: ReturnType<typeof buildDataBundle>; calls: Counters } {
  const calls = counters();
  const count = (key: keyof Omit<Counters, "total">): typeof fetch =>
    ((): Promise<Response> => {
      calls[key] += 1;
      return Promise.resolve(new Response("provider must not be called for a reserved symbol", { status: 599 }));
    }) as unknown as typeof fetch;

  const edgarTransport: EdgarTransport = {
    fetchText(): Promise<EdgarTransportResponse> {
      calls.edgar += 1;
      return Promise.resolve({
        status: 599,
        body: "EDGAR must not be called for a reserved symbol",
        fetchedAt: NOW.toISOString(),
        fromCache: false,
        stale: false,
      });
    },
  };

  const bundle = buildDataBundle(symbol, {
    now: () => NOW,
    eodYears: 1,
    fmp: createFmpClient({
      apiKey,
      fetchImpl: count("fmp"),
      limiter: makeLimiter(1_000_000, 1_000_000),
      now: () => NOW,
      timeoutMs: 1_000,
    }),
    edgar: createEdgarClient({ transport: edgarTransport }),
    yahoo: createYahooClient({
      fetchImpl: count("yahoo"),
      limiter: makeLimiter(1_000_000, 1_000_000),
      now: () => NOW,
      maxRetries: 0,
    }),
    fred: { fetchImpl: count("fred"), retryDelaysMs: [], minRequestIntervalMs: 0 },
    finnhub: { apiKey: "FINNHUB-KEY", fetchImpl: count("finnhub"), retryDelaysMs: [] },
    finra: { fetchImpl: count("finra"), retryDelaysMs: [], minRequestIntervalMs: 0 },
  });
  return { bundle, calls };
}

describe("reserved fixture symbols", () => {
  it("recognises the two reserved strings in any casing and nothing else", () => {
    expect([...RESERVED_FIXTURE_SYMBOLS]).toEqual(["DEMO", "DBNK"]);
    expect(isReservedFixtureSymbol("demo")).toBe(true);
    expect(isReservedFixtureSymbol(" DBNK ")).toBe(true);
    expect(isReservedFixtureSymbol("AAPL")).toBe(false);
    expect(isReservedFixtureSymbol(null)).toBe(false);
  });

  it("names the reserved rule on a short-circuited member, with or without attempted sources", () => {
    // N3 put this module under the risk coverage floor; the no-sources branch
    // of the gap builder had never been exercised.
    const withSources = reservedProviderGap("macro.DGS10", " demo ", ["fred"]);
    expect(withSources).toMatchObject({ field: "macro.DGS10", severity: "info", expected: true, attemptedSources: ["fred"] });
    expect(withSources.reason).toMatch(/^DEMO is a reserved fixture symbol/);
    const bare = reservedProviderGap("shortInterest", "dbnk");
    expect(bare.attemptedSources).toBeUndefined();
    expect(bare.reason).toMatch(/^DBNK is a reserved fixture symbol/);
    expect(anyReservedFixtureSymbol(["AAPL", "MSFT"])).toBe(false);
    expect(anyReservedFixtureSymbol(["AAPL", "demo"])).toBe(true);
  });

  for (const symbol of RESERVED_FIXTURE_SYMBOLS) {
    for (const [label, apiKey] of [
      ["without an FMP key", ""],
      ["with an FMP key", "LIVE-KEY-THAT-MUST-NOT-BE-USED"],
    ] as const) {
      it(`makes no provider request for ${symbol} ${label}`, async () => {
        const { bundle: pending, calls } = build(symbol, apiKey);
        const bundle = await pending;

        expect(calls.total()).toBe(0);
        expect(calls).toMatchObject({ fmp: 0, edgar: 0, yahoo: 0, fred: 0, finnhub: 0, finra: 0 });

        // The profile still renders, from the synthetic contract fixture.
        expect(bundle.profile.ok).toBe(true);
        if (bundle.profile.ok) {
          expect(bundle.profile.value.endpoint).toContain("[FIXTURE]");
          expect(bundle.profile.value.data.rows[0]?.symbol).toBe(symbol);
        }

        // The manifest names the rule, once, as an expected disclosure.
        const reservedEntries = bundle.gaps.filter((gap) => gap.field.startsWith("fixture.reserved"));
        expect(reservedEntries).toHaveLength(1);
        expect(reservedEntries[0]).toMatchObject({
          field: `fixture.reserved(${symbol})`,
          severity: "info",
          expected: true,
        });
        expect(reservedEntries[0]!.reason).toMatch(/no request was made to fmp, edgar, yahoo, fred, finnhub, finra/);

        // EDGAR is disclosed absent rather than queried with the fixture's
        // synthetic CIK, and nothing claims an HTTP exchange that never happened.
        expect(bundle.edgar.cik.ok).toBe(false);
        expect(bundle.edgar.registrant).toBeNull();
        const edgarGaps = bundle.gaps.filter((gap) => gap.field.startsWith("edgar."));
        expect(edgarGaps.length).toBeGreaterThan(0);
        for (const gap of edgarGaps) {
          expect(gap.reason).toMatch(/reserved fixture symbol/);
          expect(gap.reason).not.toMatch(/HTTP \d/);
        }

        // No keyless substitution can run without an EDGAR-confirmed issuer.
        expect(bundle.gaps.some((gap) => gap.field.startsWith("keyless."))).toBe(false);
      });
    }
  }

  it("leaves a symbol that is not reserved on the live path", async () => {
    // The rule is symbol-scoped, not a blanket switch: the same keyed client
    // that never calls out for DEMO does call out for AAPL. (One client-level
    // request, not a whole bundle: a bundle of refused live calls spends the
    // retry budget of every endpoint.)
    const calls = counters();
    const client = createFmpClient({
      apiKey: "LIVE-KEY-THAT-MUST-NOT-BE-USED",
      fetchImpl: ((): Promise<Response> => {
        calls.fmp += 1;
        return Promise.resolve(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
      }) as unknown as typeof fetch,
      limiter: makeLimiter(1_000_000, 1_000_000),
      now: () => NOW,
      timeoutMs: 1_000,
    });
    await client.profile("AAPL");
    expect(calls.fmp).toBe(1);
    await client.profile("DEMO");
    expect(calls.fmp).toBe(1);
  });
});
