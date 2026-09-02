/**
 * buildDataBundle with the keyless (EDGAR + Yahoo) fallback layer wired in.
 *
 * The fixtures are the committed ones: `facts`/`appleLike` are copied verbatim
 * from tests/edgar.statements.test.ts and `fakeYahoo` from tests/keyless.test.ts
 * (tests never import from each other here).
 */
import { describe, expect, it } from "vitest";

import { runStageB } from "@/pipeline/compute";
import { buildDataBundle } from "@/pipeline/dataBundle";
import { UnsupportedInstrumentError } from "@/pipeline/stageB/instrumentSupport";
import {
  createEdgarClient,
  type EdgarTransport,
  type EdgarTransportResponse,
} from "@/providers/edgar";
import { createFmpClient } from "@/providers/fmp";
import { createYahooClient, type YahooClient } from "@/providers/yahoo";
import { makeLimiter } from "@/providers/http";
import type { CompanyFacts } from "@/edgar/xbrl";
import type { FinraConfig } from "@/providers/finra";
import type { FinnhubConfig } from "@/providers/finnhub";
import type { FredConfig } from "@/providers/fred";

const NOW = new Date("2026-09-01T00:00:00.000Z");

// ---------------------------------------------------------------------------
// companyfacts fixture (verbatim from tests/edgar.statements.test.ts)
// ---------------------------------------------------------------------------

interface Pt { start?: string; end: string; val: number; form?: string; fy?: number; fp?: string; filed?: string; accn?: string }

/** Build a companyfacts payload from `{ tag: [points] }` (unit USD unless the tag says otherwise). */
function facts(usGaap: Record<string, Pt[]>, dei: Record<string, Pt[]> = {}, units: Record<string, string> = {}): CompanyFacts {
  const toConcept = (tag: string, points: Pt[]) => ({
    label: tag,
    units: {
      [units[tag] ?? (tag.startsWith("EarningsPerShare") ? "USD/shares" : /Shares/.test(tag) ? "shares" : "USD")]: points.map((p, i) => ({
        start: p.start,
        end: p.end,
        val: p.val,
        accn: p.accn ?? `0000000000-26-${String(i).padStart(6, "0")}`,
        fy: p.fy ?? Number(p.end.slice(0, 4)),
        fp: p.fp ?? (p.start === undefined || dur(p) > 300 ? "FY" : "Q1"),
        form: p.form ?? (p.start === undefined || dur(p) > 300 ? "10-K" : "10-Q"),
        filed: p.filed ?? `${Number(p.end.slice(0, 4)) + (p.end >= `${p.end.slice(0, 4)}-10` ? 1 : 0)}-02-01`,
      })),
    },
  });
  return {
    cik: 320193,
    entityName: "Test Corp",
    facts: {
      "us-gaap": Object.fromEntries(Object.entries(usGaap).map(([t, p]) => [t, toConcept(t, p)])),
      dei: Object.fromEntries(Object.entries(dei).map(([t, p]) => [t, toConcept(t, p)])),
    },
  };
}
const dur = (p: Pt) => (p.start ? (Date.parse(p.end) - Date.parse(p.start)) / 86_400_000 : 0);

/** A September fiscal year like Apple's: FY2025 = 2024-09-29..2025-09-27, three 10-Qs with 3-month + YTD income and YTD-only cash flow. */
function appleLike(): CompanyFacts {
  const fyStart = "2024-09-29";
  const fyEnd = "2025-09-27";
  const q1 = "2024-12-28";
  const q2 = "2025-03-29";
  const q3 = "2025-06-28";
  return facts(
    {
      RevenueFromContractWithCustomerExcludingAssessedTax: [
        { start: fyStart, end: fyEnd, val: 400, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" },
        { start: fyStart, end: q1, val: 120, form: "10-Q", fp: "Q1", fy: 2025, filed: "2025-01-31" },
        { start: fyStart, end: q2, val: 210, form: "10-Q", fp: "Q2", fy: 2025, filed: "2025-05-02" },
        { start: "2024-12-29", end: q2, val: 90, form: "10-Q", fp: "Q2", fy: 2025, filed: "2025-05-02" },
        { start: fyStart, end: q3, val: 300, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
        { start: "2025-03-30", end: q3, val: 90, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
        // prior year, for the annual list
        { start: "2023-10-01", end: "2024-09-28", val: 380, form: "10-K", fp: "FY", fy: 2024, filed: "2024-11-01" },
      ],
      NetIncomeLoss: [
        { start: fyStart, end: fyEnd, val: 100, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" },
        { start: fyStart, end: q1, val: 30, form: "10-Q", fp: "Q1", fy: 2025, filed: "2025-01-31" },
        { start: fyStart, end: q2, val: 55, form: "10-Q", fp: "Q2", fy: 2025, filed: "2025-05-02" },
        { start: "2024-12-29", end: q2, val: 25, form: "10-Q", fp: "Q2", fy: 2025, filed: "2025-05-02" },
        { start: fyStart, end: q3, val: 78, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
        { start: "2025-03-30", end: q3, val: 23, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
        { start: "2023-10-01", end: "2024-09-28", val: 90, form: "10-K", fp: "FY", fy: 2024, filed: "2024-11-01" },
      ],
      CostOfRevenue: [{ start: fyStart, end: fyEnd, val: 220, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      OperatingIncomeLoss: [{ start: fyStart, end: fyEnd, val: 130, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      DepreciationDepletionAndAmortization: [{ start: fyStart, end: fyEnd, val: 12, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      InterestExpense: [{ start: fyStart, end: fyEnd, val: 4, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest: [{ start: fyStart, end: fyEnd, val: 128, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      EarningsPerShareDiluted: [
        { start: fyStart, end: fyEnd, val: 7.5, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" },
        { start: fyStart, end: q1, val: 2.3, form: "10-Q", fp: "Q1", fy: 2025, filed: "2025-01-31" },
        { start: fyStart, end: q3, val: 5.9, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
        { start: "2025-03-30", end: q3, val: 1.7, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
      ],
      WeightedAverageNumberOfDilutedSharesOutstanding: [
        { start: fyStart, end: fyEnd, val: 15_000, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" },
        { start: "2025-03-30", end: q3, val: 14_900, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
      ],
      Assets: [
        { end: fyEnd, val: 360, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" },
        { end: q1, val: 340, form: "10-Q", fp: "Q1", fy: 2025, filed: "2025-01-31" },
        { end: q2, val: 345, form: "10-Q", fp: "Q2", fy: 2025, filed: "2025-05-02" },
        { end: q3, val: 350, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
        { end: "2024-09-28", val: 365, form: "10-K", fp: "FY", fy: 2024, filed: "2024-11-01" },
      ],
      StockholdersEquity: [{ end: fyEnd, val: 65, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      Liabilities: [{ end: fyEnd, val: 295, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      CashAndCashEquivalentsAtCarryingValue: [{ end: fyEnd, val: 30, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      ShortTermInvestments: [{ end: fyEnd, val: 25, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      LongTermDebtNoncurrent: [{ end: fyEnd, val: 80, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      LongTermDebtCurrent: [{ end: fyEnd, val: 10, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      CommercialPaper: [{ end: fyEnd, val: 5, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      NetCashProvidedByUsedInOperatingActivities: [
        { start: fyStart, end: fyEnd, val: 110, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" },
        { start: fyStart, end: q1, val: 50, form: "10-Q", fp: "Q1", fy: 2025, filed: "2025-01-31" },
        { start: fyStart, end: q2, val: 80, form: "10-Q", fp: "Q2", fy: 2025, filed: "2025-05-02" },
        { start: fyStart, end: q3, val: 95, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
      ],
      PaymentsToAcquirePropertyPlantAndEquipment: [
        { start: fyStart, end: fyEnd, val: 12, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" },
        { start: fyStart, end: q1, val: 2, form: "10-Q", fp: "Q1", fy: 2025, filed: "2025-01-31" },
        { start: fyStart, end: q2, val: 5, form: "10-Q", fp: "Q2", fy: 2025, filed: "2025-05-02" },
        { start: fyStart, end: q3, val: 8, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
      ],
      PaymentsForRepurchaseOfCommonStock: [{ start: fyStart, end: fyEnd, val: 90, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      PaymentsOfDividends: [{ start: fyStart, end: fyEnd, val: 15, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
    },
    {
      EntityCommonStockSharesOutstanding: [
        { end: "2025-10-17", val: 14_776, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" },
        { end: "2025-07-18", val: 14_900, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
      ],
      EntityPublicFloat: [{ end: "2025-03-28", val: 3_000_000, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
    },
  );
}

function appleFacts(): CompanyFacts {
  return appleLike();
}

/** Yahoo fake serving 5y of synthetic daily bars for any symbol and a quote meta (verbatim from tests/keyless.test.ts). */
function fakeYahoo(opts: { fail?: Set<string>; instrumentType?: string } = {}) {
  const impl = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const symbol = /chart\/([^?]+)/.exec(url)![1]!;
    if (opts.fail?.has(symbol)) return new Response("Too Many Requests", { status: 429 });
    const isQuote = url.includes("range=5d");
    const start = Date.UTC(2021, 8, 1, 13, 30) / 1000;
    const n = isQuote ? 5 : 1250;
    const timestamp = Array.from({ length: n }, (_, i) => start + i * 86400);
    const close = timestamp.map((_, i) => (symbol === "SPY" ? 400 : 150) * Math.exp(0.0002 * i));
    return new Response(JSON.stringify({ chart: { result: [{ meta: { currency: "USD", symbol, exchangeName: "NMS", fullExchangeName: "NasdaqGS", instrumentType: opts.instrumentType ?? "EQUITY", firstTradeDate: 345479400, regularMarketTime: timestamp[n - 1]! + 23400, gmtoffset: -14400, regularMarketPrice: close[n - 1], regularMarketDayHigh: 1, regularMarketDayLow: 1, regularMarketVolume: 5, fiftyTwoWeekHigh: 1, fiftyTwoWeekLow: 1, chartPreviousClose: 1, longName: "Apple Inc." }, timestamp, indicators: { quote: [{ open: close, high: close, low: close, close, volume: close.map(() => 1000) }], adjclose: [{ adjclose: close }] } }], error: null } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return createYahooClient({ fetchImpl: impl, limiter: makeLimiter(1000, 1000), now: () => NOW, maxRetries: 0 });
}

/** EDGAR transport serving company_tickers.json, submissions and companyfacts for AAPL; 404 otherwise. */
function edgarTransport(): EdgarTransport {
  return {
    fetchText(url: string): Promise<EdgarTransportResponse> {
      const ok = (body: unknown): EdgarTransportResponse => ({ status: 200, body: JSON.stringify(body), fetchedAt: NOW.toISOString(), fromCache: false, stale: false });
      if (url.includes("company_tickers.json")) return Promise.resolve(ok({ "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } }));
      if (url.includes("submissions/CIK0000320193.json")) return Promise.resolve(ok({ cik: "320193", name: "Apple Inc.", sic: "3571", sicDescription: "ELECTRONIC COMPUTERS", fiscalYearEnd: "0927", stateOfIncorporation: "CA", tickers: ["AAPL"], exchanges: ["Nasdaq"], filings: { recent: { accessionNumber: ["0000320193-25-000079"], filingDate: ["2025-10-31"], reportDate: ["2025-09-27"], form: ["10-K"], primaryDocument: ["aapl-20250927.htm"] }, files: [] } }));
      if (url.includes("companyfacts/CIK0000320193.json")) return Promise.resolve(ok(appleFacts()));
      return Promise.resolve({ status: 404, body: "not found", fetchedAt: NOW.toISOString(), fromCache: false, stale: false });
    },
  };
}

/**
 * A Yahoo client whose payload explodes the moment the orchestrator reads its
 * rows. The fault has to land OUTSIDE keyless.ts's own `attempt` wrapper —
 * `attempt` only guards the fetch itself, while the XBRL build, the beta
 * regression and the row reads that follow run bare.
 */
function explodingYahoo(): YahooClient {
  const boom = {
    ok: true,
    value: {
      data: {
        get rows(): never {
          throw new Error("poisoned keyless payload");
        },
        raw: null,
      },
      asOf: "2026-09-01",
      source: "yahoo",
      endpoint: "/v8/finance/chart/AAPL",
      fetchedAt: NOW.toISOString(),
    },
  };
  return {
    dailyHistory: () => Promise.resolve(boom),
    meta: () => Promise.resolve(boom),
    quote: () => Promise.resolve(boom),
  } as unknown as YahooClient;
}

function noNetworkConfigs(): { fred: FredConfig; finnhub: FinnhubConfig; finra: FinraConfig } {
  const unavailable = (): Promise<Response> => Promise.resolve(new Response("not available", { status: 404 }));
  return {
    fred: { fetchImpl: unavailable, retryDelaysMs: [], minRequestIntervalMs: 0 },
    finnhub: { apiKey: "TEST-KEY", fetchImpl: unavailable, retryDelaysMs: [] },
    finra: { fetchImpl: unavailable, retryDelaysMs: [], minRequestIntervalMs: 0 },
  };
}

describe("buildDataBundle without an FMP key", () => {
  it("serves profile, quote, statements, prices and derived capitalization from EDGAR and Yahoo", async () => {
    const bundle = await buildDataBundle("AAPL", {
      now: () => NOW,
      fmp: createFmpClient({ apiKey: "", fixturesDir: "fixtures/fmp" }),
      edgar: createEdgarClient({ transport: edgarTransport() }),
      yahoo: fakeYahoo(),
      ...noNetworkConfigs(),
    });
    expect(bundle.profile.ok && bundle.profile.value.source).toBe("computed");
    expect(bundle.profile.ok && bundle.profile.value.data.rows[0]).toMatchObject({ companyName: "Apple Inc.", sector: "Technology" });
    expect(bundle.quote.ok && bundle.quote.value.source).toBe("yahoo");
    expect(bundle.statements.incomeAnnual.ok && bundle.statements.incomeAnnual.value.source).toBe("edgar");
    expect(bundle.statements.incomeAnnual.ok && bundle.statements.incomeAnnual.value.data.rows[0]!.revenue).toBe(400);
    expect(bundle.eodPrices.ok && bundle.eodPrices.value.source).toBe("yahoo");
    expect(bundle.benchmarkPrices.spy.ok).toBe(true);
    expect(bundle.benchmarkPrices.sectorEtfSymbol).toBe("XLK");
    expect(bundle.benchmarkPrices.sectorEtf.ok).toBe(true);
    expect(bundle.enterpriseValues.ok && bundle.enterpriseValues.value.source).toBe("computed");
    expect(bundle.edgar.registrant?.sic).toBe("3571");
    expect(bundle.sourceManifest["statements.incomeAnnual"]?.provider).toBe("edgar");
    expect(bundle.sourceManifest["eodPrices"]?.provider).toBe("yahoo");
    const keyless = bundle.gaps.filter((g) => g.field.startsWith("keyless."));
    expect(keyless.length).toBeGreaterThanOrEqual(10);
    expect(keyless.every((g) => g.severity === "info" && g.expected === true)).toBe(true);
    // The original "no API key + no fixture" gaps for replaced members are gone.
    expect(bundle.gaps.some((g) => g.field === "fmp.incomeStatement(AAPL,annual)")).toBe(false);
    // Statements keep the bundle's newest-first ordering after the swap.
    const annualDates = bundle.statements.incomeAnnual.ok
      ? bundle.statements.incomeAnnual.value.data.rows.map((r) => r.date)
      : [];
    expect(annualDates).toEqual([...annualDates].sort().reverse());
  });

  it("refuses a fund: an ETF instrumentType reaches runStageB as UnsupportedInstrumentError", async () => {
    // ETF trusts are SEC registrants with tickers and 10-K filings, so they
    // clear the issuer gate and the keyless layer builds a profile for them.
    // The instrument guard has to see the fund, exactly as on the FMP path.
    const bundle = await buildDataBundle("AAPL", {
      now: () => NOW,
      fmp: createFmpClient({ apiKey: "", fixturesDir: "fixtures/fmp" }),
      edgar: createEdgarClient({ transport: edgarTransport() }),
      yahoo: fakeYahoo({ instrumentType: "ETF" }),
      ...noNetworkConfigs(),
    });
    expect(bundle.profile.ok && bundle.profile.value.data.rows[0]).toMatchObject({ isEtf: true, isFund: false });
    expect(() => runStageB(bundle)).toThrow(UnsupportedInstrumentError);
  });

  it("respects keyless: false", async () => {
    const bundle = await buildDataBundle("AAPL", {
      now: () => NOW,
      fmp: createFmpClient({ apiKey: "", fixturesDir: "fixtures/fmp" }),
      edgar: createEdgarClient({ transport: edgarTransport() }),
      yahoo: fakeYahoo(),
      keyless: false,
      ...noNetworkConfigs(),
    });
    expect(bundle.statements.incomeAnnual.ok).toBe(false);
    expect(bundle.gaps.some((g) => g.field.startsWith("keyless."))).toBe(false);
  });

  it("adds no gap and no note at all when EDGAR never confirmed the issuer", async () => {
    // DEMO's CIK comes from the FMP fixture profile, not from SEC's ticker
    // table, and SEC answers nothing for it — so no independent source ties the
    // ticker to an issuer and the layer must not run. The fictional-fixture
    // projection (tests/audit.fixtureComparison.test.ts) depends on this: the
    // manifest must stay identical to a run with the layer switched off.
    const noCik = (): EdgarTransport => ({
      fetchText: () =>
        Promise.resolve({ status: 404, body: "not found", fetchedAt: NOW.toISOString(), fromCache: false, stale: false }),
    });
    const opts = {
      now: (): Date => NOW,
      eodYears: 0,
      yahoo: fakeYahoo(),
      ...noNetworkConfigs(),
    };
    const withKeyless = await buildDataBundle("DEMO", {
      ...opts,
      fmp: createFmpClient({ apiKey: "", fixturesDir: "fixtures/fmp" }),
      edgar: createEdgarClient({ transport: noCik() }),
    });
    const withoutKeyless = await buildDataBundle("DEMO", {
      ...opts,
      fmp: createFmpClient({ apiKey: "", fixturesDir: "fixtures/fmp" }),
      edgar: createEdgarClient({ transport: noCik() }),
      keyless: false,
    });
    // `fetchedAt` is wall-clock on a fixture read, so provenance is compared on
    // the fields a substitution would actually move.
    const provenance = (b: typeof withKeyless): Record<string, string> =>
      Object.fromEntries(
        Object.entries(b.sourceManifest).map(([field, e]) => [
          field,
          `${e.provider} ${e.endpoint} ${e.asOf}`,
        ]),
      );
    expect(withKeyless.gaps).toEqual(withoutKeyless.gaps);
    expect(provenance(withKeyless)).toEqual(provenance(withoutKeyless));
    expect(withKeyless.gaps.some((g) => g.field.startsWith("keyless."))).toBe(false);
  });

  it("still builds, and discloses a warn gap, when the keyless layer throws", async () => {
    const bundle = await buildDataBundle("AAPL", {
      now: () => NOW,
      fmp: createFmpClient({ apiKey: "", fixturesDir: "fixtures/fmp" }),
      edgar: createEdgarClient({ transport: edgarTransport() }),
      yahoo: explodingYahoo(),
      ...noNetworkConfigs(),
    });
    // buildDataBundle's contract is that nothing throws: reaching here is the
    // assertion. The failure is disclosed, not swallowed.
    const failure = bundle.gaps.find((g) => g.field === "keyless");
    expect(failure?.severity).toBe("warn");
    expect(failure?.reason).toMatch(/poisoned keyless payload/);
    // FMP's own results are untouched — no member was half-substituted.
    expect(bundle.statements.incomeAnnual.ok).toBe(false);
    expect(bundle.profile.ok).toBe(false);
    expect(bundle.eodPrices.ok).toBe(false);
    expect(bundle.gaps.some((g) => g.field.startsWith("keyless."))).toBe(false);
  });

  it("fills only SPY and the sector ETF when a keyed plan refuses them and EDGAR is down", async () => {
    // EDGAR 404s everything, so the CIK is the one FMP's own profile carries and
    // no independent source confirms the issuer. The benchmark series are index
    // instruments that assert nothing about this company, so they still fall
    // back; the company's own members stay exactly as FMP left them.
    const fmpFetch: typeof fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const endpoint = /\/stable\/(.+)$/.exec(url.pathname)![1]!;
      const symbol = url.searchParams.get("symbol");
      const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (endpoint === "profile") return json([{ symbol: "AAPL", companyName: "Apple Inc.", sector: "Technology", currency: "USD", country: "US", cik: "0000320193" }]);
      if (endpoint === "historical-price-eod/full" && symbol === "AAPL") return json([{ symbol, date: "2026-09-01", open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
      if (endpoint === "historical-price-eod/full") return new Response("Premium Query Parameter: 'Special Endpoint : This value set for 'symbol' is not available under your current subscription", { status: 402 });
      return json({ "Error Message": "not in this test" }, 401);
    }) as unknown as typeof fetch;
    const edgarDown: EdgarTransport = {
      fetchText: () =>
        Promise.resolve({ status: 404, body: "not found", fetchedAt: NOW.toISOString(), fromCache: false, stale: false }),
    };
    const bundle = await buildDataBundle("AAPL", {
      now: () => NOW,
      eodYears: 0,
      fmp: createFmpClient({ apiKey: "KEYED", fetchImpl: fmpFetch, limiter: makeLimiter(1e6, 1e6), now: () => NOW }),
      edgar: createEdgarClient({ transport: edgarDown }),
      yahoo: fakeYahoo(),
      ...noNetworkConfigs(),
    });
    expect(bundle.edgar.cik.ok && bundle.edgar.cik.value.source).toBe("fmp");
    expect(bundle.benchmarkPrices.spy.ok && bundle.benchmarkPrices.spy.value.source).toBe("yahoo");
    expect(bundle.benchmarkPrices.sectorEtf.ok && bundle.benchmarkPrices.sectorEtf.value.source).toBe("yahoo");
    expect(bundle.gaps.find((g) => g.field === "keyless.sectorEtf")?.reason).toMatch(/HTTP 402/);
    // Nothing issuer-bound was substituted, and nothing claims it was tried.
    expect(bundle.statements.incomeAnnual.ok).toBe(false);
    expect(bundle.enterpriseValues.ok).toBe(false);
    expect(bundle.gaps.filter((g) => g.field.startsWith("keyless.")).map((g) => g.field).sort()).toEqual([
      "keyless.sectorEtf",
      "keyless.spy",
    ]);
  });

  it("serves a refused sector ETF from Yahoo on a keyed plan while keeping FMP statements", async () => {
    // FMP fake: statements + profile + AAPL prices OK, XLK refused with the plan's 402 text.
    const fmpFetch: typeof fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const endpoint = /\/stable\/(.+)$/.exec(url.pathname)![1]!;
      const symbol = url.searchParams.get("symbol");
      const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (endpoint === "profile") return json([{ symbol: "AAPL", companyName: "Apple Inc.", sector: "Technology", industry: "Consumer Electronics", price: 300, marketCap: 4e12, beta: 1.1, currency: "USD", country: "US", cik: "0000320193", isEtf: false, isFund: false, isAdr: false }]);
      if (endpoint === "quote") return json([{ symbol: "AAPL", price: 300, marketCap: 4e12, timestamp: 1756684800 }]);
      if (endpoint === "income-statement") return json([{ symbol: "AAPL", date: "2025-09-27", revenue: 400e9, reportedCurrency: "USD" }]);
      if (endpoint === "historical-price-eod/full" && symbol === "XLK") return new Response("Premium Query Parameter: 'Special Endpoint : This value set for 'symbol' is not available under your current subscription", { status: 402 });
      if (endpoint === "historical-price-eod/full") return json([{ symbol, date: "2026-09-01", open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
      return json({ "Error Message": "not in this test" }, 401);
    }) as unknown as typeof fetch;
    const bundle = await buildDataBundle("AAPL", {
      now: () => NOW,
      eodYears: 0,
      fmp: createFmpClient({ apiKey: "KEYED", fetchImpl: fmpFetch, limiter: makeLimiter(1e6, 1e6), now: () => NOW }),
      edgar: createEdgarClient({ transport: edgarTransport() }),
      yahoo: fakeYahoo(),
      ...noNetworkConfigs(),
    });
    expect(bundle.statements.incomeAnnual.ok && bundle.statements.incomeAnnual.value.source).toBe("fmp");
    expect(bundle.benchmarkPrices.sectorEtf.ok && bundle.benchmarkPrices.sectorEtf.value.source).toBe("yahoo");
    const g = bundle.gaps.find((x) => x.field === "keyless.sectorEtf");
    // A keyed plan makes the substitution unexpected: `expected` is never true.
    expect(g?.expected).not.toBe(true);
    expect(g?.reason).toMatch(/HTTP 402/);
  });
});
