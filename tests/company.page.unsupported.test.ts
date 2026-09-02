import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pageHarness = vi.hoisted(() => ({
  bundle: null as unknown,
  buildDataBundle: vi.fn<(symbol: string) => Promise<unknown>>(),
  runStageB: vi.fn(),
  generateReport: vi.fn(() => null),
  getLatestDoneReport: vi.fn(() => null),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/pipeline/dataBundle", () => ({
  buildDataBundle: pageHarness.buildDataBundle,
}));
vi.mock("@/pipeline/stageA/validate", () => ({
  validateBundle: vi.fn(() => ({ checks: [], flags: [], gaps: [] })),
}));
vi.mock("@/pipeline/compute", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/pipeline/compute")>();
  return { ...actual, runStageB: pageHarness.runStageB };
});
vi.mock("@/report/query", () => ({
  getLatestDoneReport: pageHarness.getLatestDoneReport,
}));
vi.mock("@/app/company/[symbol]/GenerateReport", () => ({
  GenerateReport: pageHarness.generateReport,
}));

import CompanyPage, { CompanyBody } from "@/app/company/[symbol]/page";

/** An `edgar.cik` FetchResult that resolved — the ticker is a known registrant. */
function resolvedCik(symbol: string): unknown {
  return {
    ok: true,
    value: {
      data: { cik10: "0000000001", cik: 1, ticker: symbol, title: symbol },
      asOf: "2026-08-07",
      source: "edgar",
      endpoint: "company_tickers.json",
      fetchedAt: "2026-08-07T00:00:00.000Z",
    },
  };
}

/** An `edgar.cik` gap — `reason` decides whether the miss is confirmed or merely unreached. */
function cikGap(symbol: string, reason: string): unknown {
  return { ok: false, gap: { field: `edgar.cik(${symbol})`, reason, severity: "warn" } };
}

const NO_FMP_PROFILE = {
  ok: false,
  gap: {
    field: "fmp.profile",
    reason: "no API key + no fixture",
    severity: "warn",
    attemptedSources: ["fmp", "profile"],
  },
};

describe("company page — unsupported instruments", () => {
  beforeEach(() => {
    pageHarness.buildDataBundle.mockReset();
    pageHarness.buildDataBundle.mockImplementation(async () => pageHarness.bundle);
    pageHarness.runStageB.mockClear();
    pageHarness.generateReport.mockClear();
    pageHarness.getLatestDoneReport.mockClear();
    pageHarness.bundle = {
      symbol: "SPY",
      builtAt: "2026-08-07T00:00:00.000Z",
      profile: {
        ok: true,
        value: {
          data: {
            rows: [
              {
                symbol: "SPY",
                companyName: "SPDR S&P 500 ETF Trust",
                isEtf: true,
                isFund: false,
              },
            ],
            raw: {},
          },
          asOf: "2026-08-07",
          source: "fmp",
          endpoint: "profile",
          fetchedAt: "2026-08-07T00:00:00.000Z",
          stale: false,
        },
      },
      // `isConfirmedUnknownProfile` now consults EDGAR's ticker table before it
      // calls a keyless miss a 404, so every stub carries an `edgar.cik`.
      edgar: { cik: resolvedCik("SPY") },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["decoded Unicode ß", "ß"],
    ["decoded Unicode ſ", "ſ"],
    ["decoded Unicode ﬀ", "ﬀ"],
    ["encoded residue from a double-encoded URL", "%41APL"],
    ["stray percent residue", "%"],
  ])("rejects %s before it can select or load another ticker", async (_label, routeSymbol) => {
      await expect(
        CompanyPage({ params: Promise.resolve({ symbol: routeSymbol }) }),
      ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
      expect(pageHarness.buildDataBundle).not.toHaveBeenCalled();
    });

  it.each([
    ["AAPL (including a decoded single-encoded URL)", "AAPL", "AAPL"],
    ["lowercase aapl", "aapl", "AAPL"],
    ["dot class brk.b", "brk.b", "BRK.B"],
    ["hyphen class bf-b", "bf-b", "BF-B"],
  ])("accepts %s as %s", async (_label, routeSymbol, expected) => {
    const page = await CompanyPage({ params: Promise.resolve({ symbol: routeSymbol }) });
    expect(page).toBeDefined();
    expect(JSON.stringify(page)).toContain(`\"symbol\":\"${expected}\"`);
    expect(pageHarness.buildDataBundle).not.toHaveBeenCalled();
  });

  it("renders the company-only explanation before Stage B, old reports, charts, or GenerateReport", async () => {
    const html = renderToStaticMarkup(await CompanyBody({ symbol: "SPY" }));

    expect(html).toMatch(/SPY/);
    expect(html).toMatch(/not supported/i);
    expect(html).toMatch(/individual compan/i);
    expect(pageHarness.runStageB).not.toHaveBeenCalled();
    expect(pageHarness.getLatestDoneReport).not.toHaveBeenCalled();
    expect(pageHarness.generateReport).not.toHaveBeenCalled();
  });

  it("coalesces the entire concurrent company load for one normalized symbol", async () => {
    let resolveBundle!: (value: unknown) => void;
    const pendingBundle = new Promise<unknown>((resolve) => {
      resolveBundle = resolve;
    });
    pageHarness.buildDataBundle.mockImplementation(() => pendingBundle);

    const first = CompanyBody({ symbol: "ONCE" });
    const second = CompanyBody({ symbol: "ONCE" });
    await Promise.resolve();
    await Promise.resolve();
    const callsBeforeResolve = pageHarness.buildDataBundle.mock.calls.length;

    resolveBundle({
      symbol: "ONCE",
      builtAt: "2026-08-07T00:00:00.000Z",
      profile: {
        ok: false,
        gap: {
          field: "fmp.profile",
          reason: "FMP request failed: connection reset",
          severity: "critical",
          attemptedSources: ["fmp", "profile"],
        },
      },
      edgar: { cik: resolvedCik("ONCE") },
    });
    await Promise.all([first, second]);
    expect(callsBeforeResolve).toBe(1);
    expect(pageHarness.runStageB).toHaveBeenCalledTimes(1);
    expect(pageHarness.getLatestDoneReport).toHaveBeenCalledTimes(1);
  });

  it("bounds different-symbol company loads to the production concurrency of two", async () => {
    const symbols = ["AAA", "BBB", "CCC"];
    const gates = new Map(
      symbols.map((symbol) => {
        let resolve!: (value: unknown) => void;
        const promise = new Promise<unknown>((done) => {
          resolve = done;
        });
        return [symbol, { promise, resolve }] as const;
      }),
    );
    pageHarness.buildDataBundle.mockImplementation((symbol) => gates.get(symbol)!.promise);

    const loads = symbols.map((symbol) => CompanyBody({ symbol }));
    await Promise.resolve();
    await Promise.resolve();
    const beforeRelease = pageHarness.buildDataBundle.mock.calls.map(([symbol]) => symbol);

    gates.get("AAA")!.resolve({ ...(pageHarness.bundle as object), symbol: "AAA" });
    await loads[0];
    await Promise.resolve();
    await Promise.resolve();
    const afterRelease = pageHarness.buildDataBundle.mock.calls.map(([symbol]) => symbol);

    gates.get("BBB")!.resolve({ ...(pageHarness.bundle as object), symbol: "BBB" });
    gates.get("CCC")!.resolve({ ...(pageHarness.bundle as object), symbol: "CCC" });
    await Promise.all(loads);
    expect(beforeRelease).toEqual(["AAA", "BBB"]);
    expect(afterRelease).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("negative-caches an exact semantic profile miss for 15 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T00:00:00.000Z"));
    pageHarness.bundle = {
      ...(pageHarness.bundle as object),
      symbol: "MISS",
      profile: {
        ok: false,
        gap: {
          field: "fmp.profile",
          reason: "FMP returned an empty array (no data for this query)",
          severity: "info",
          attemptedSources: ["fmp", "profile"],
        },
      },
    };

    await CompanyBody({ symbol: "MISS" });
    await CompanyBody({ symbol: "MISS" });
    expect(pageHarness.buildDataBundle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(15_000);
    await CompanyBody({ symbol: "MISS" });
    expect(pageHarness.buildDataBundle).toHaveBeenCalledTimes(2);
  });

  it("does not negative-cache a transient profile transport gap", async () => {
    pageHarness.bundle = {
      ...(pageHarness.bundle as object),
      symbol: "RETRY",
      profile: {
        ok: false,
        gap: {
          field: "fmp.profile",
          reason: "FMP request failed: connection reset",
          severity: "critical",
          attemptedSources: ["fmp", "profile"],
        },
      },
    };

    await CompanyBody({ symbol: "RETRY" });
    await CompanyBody({ symbol: "RETRY" });
    expect(pageHarness.buildDataBundle).toHaveBeenCalledTimes(2);
  });

  it("retries and renders the fixture-mode no-profile gap instead of caching it as unknown", async () => {
    pageHarness.bundle = {
      ...(pageHarness.bundle as object),
      symbol: "NOFIX",
      profile: {
        ok: false,
        gap: {
          field: "fmp.profile",
          reason: "no API key + no fixture",
          severity: "warn",
          attemptedSources: ["fmp", "profile"],
        },
      },
    };

    const first = renderToStaticMarkup(await CompanyBody({ symbol: "NOFIX" }));
    const second = renderToStaticMarkup(await CompanyBody({ symbol: "NOFIX" }));
    expect(pageHarness.buildDataBundle).toHaveBeenCalledTimes(2);
    expect(first).toContain("no API key + no fixture");
    expect(second).toContain("no API key + no fixture");
  });

  it("renders the not-found page for a keyless symbol SEC's ticker table does not list", async () => {
    pageHarness.bundle = {
      ...(pageHarness.bundle as object),
      symbol: "KLMISS",
      profile: NO_FMP_PROFILE,
      edgar: { cik: cikGap("KLMISS", 'ticker "KLMISS" not in SEC company_tickers.json') },
    };

    const html = renderToStaticMarkup(await CompanyBody({ symbol: "KLMISS" }));
    expect(html).toMatch(/ticker not found/i);
    // The confirmed miss renders no provider gap line — nothing failed, the
    // ticker simply does not exist.
    expect(html).not.toContain("no API key + no fixture");
    // ...and it is negative-cached like any other confirmed unknown.
    await CompanyBody({ symbol: "KLMISS" });
    expect(pageHarness.buildDataBundle).toHaveBeenCalledTimes(1);
  });

  it("renders the disclosed-gap page, not a 404, when EDGAR was merely unreachable", async () => {
    pageHarness.bundle = {
      ...(pageHarness.bundle as object),
      symbol: "KLCOOL",
      profile: NO_FMP_PROFILE,
      edgar: {
        cik: cikGap(
          "KLCOOL",
          "fetch failed: EDGAR rate-limited (403) at https://www.sec.gov/files/company_tickers.json; back off ~10 min",
        ),
      },
    };

    const html = renderToStaticMarkup(await CompanyBody({ symbol: "KLCOOL" }));
    expect(html).toContain("no API key + no fixture");
    await CompanyBody({ symbol: "KLCOOL" });
    expect(pageHarness.buildDataBundle).toHaveBeenCalledTimes(2);
  });

  it("does not cache a near-match gap that merely contains the empty-array reason", async () => {
    pageHarness.bundle = {
      ...(pageHarness.bundle as object),
      symbol: "NEAR",
      profile: {
        ok: false,
        gap: {
          field: "fmp.profile",
          reason:
            "fetch failed after provider said: FMP returned an empty array (no data for this query)",
          severity: "critical",
          attemptedSources: ["fmp", "profile"],
        },
      },
    };

    await CompanyBody({ symbol: "NEAR" });
    await CompanyBody({ symbol: "NEAR" });
    expect(pageHarness.buildDataBundle).toHaveBeenCalledTimes(2);
  });
});
