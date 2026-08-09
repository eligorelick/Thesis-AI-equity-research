import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SONNET_5_INTRO_PRICING,
  _resetAnthropicForTests,
  assertPricedModel,
  effectivePricingFor,
  modelContextTokenLimit,
  pricedModelAlias,
  resumeIfPaused,
  validateRunPassOptions,
  type RunPassOptions,
} from "@/providers/anthropic";
import {
  govSpending,
  insiderSentiment,
  lobbying,
  usptoPatents,
  type FinnhubConfig,
} from "@/providers/finnhub";
import {
  latestSettlementDate,
  pickLatestPartitions,
  shortInterest,
  shortInterestTrend,
  validateShortInterestScope,
  type FinraConfig,
  type ShortInterestPoint,
} from "@/providers/finra";
import {
  applyFredUnits,
  inferObsPerYear,
  latestValue,
  series,
  type FredConfig,
  type FredObservation,
  type FredUnits,
} from "@/providers/fred";
import {
  fetchWithPolicy,
  fetchWithRedirectPolicy,
  getBandwidthTotals,
  getProviderLimiter,
  HttpRequestAbortedError,
  makeLimiter,
  parseRetryAfterMs,
  resetBandwidthTotals,
  setBandwidthRecorder,
  setProviderLimiter,
} from "@/providers/http";
import {
  dedupeFredSeriesSpecs,
  deriveNextEarnings,
  buildDataBundle,
  makeCachedFinraShortInterestTrend,
  makeCachedFinnhubInsiderSentiment,
  makeCachedFredSeries,
  makeFmpCachedFetch,
  resolveGicsSector,
  resolveSectorEtf,
  selectAnnualFiling,
  selectInterimFiling,
} from "@/pipeline/dataBundle";
import { pipelinePasses } from "@/pipeline/stageC";
import type { ContextPayload, PayloadSection } from "@/pipeline/stageC/payload";
import type { AnalystCase } from "@/report/schema";
import type { PassDeps } from "@/pipeline/jobRunner";
import {
  createEdgarClient,
  type EdgarFiling,
  type EdgarSubmissions,
  type EdgarTransport,
  type EdgarTransportResponse,
} from "@/providers/edgar";
import { createFmpClient, type FmpEarningsRow, type FmpPayload } from "@/providers/fmp";
import type { Sourced } from "@/types/core";

interface CachedFetchOptions {
  fetcher(): Promise<{ body: unknown; asOf: string }>;
  isEmptyBody?(value: unknown): boolean;
}

const cacheMocks = vi.hoisted(() => ({
  cachedFetch: vi.fn(),
}));

vi.mock("@/cache/apiCache", () => ({
  cachedFetch: cacheMocks.cachedFetch,
}));

const FETCHED_AT = "2026-08-08T12:00:00.000Z";
const FAST_FINNHUB: Omit<FinnhubConfig, "fetchImpl"> = {
  apiKey: "FINNHUB-TEST",
  enableSectorModules: true,
  retryDelaysMs: [],
  maxRequestsPerMinute: 0,
  timeoutMs: 0,
};
const FAST_FINRA: Omit<FinraConfig, "fetchImpl"> = {
  retryDelaysMs: [],
  minRequestIntervalMs: 0,
  timeoutMs: 0,
};
const FAST_FRED: Omit<FredConfig, "fetchImpl"> = {
  retryDelaysMs: [],
  minRequestIntervalMs: 0,
  timeoutMs: 0,
};

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sourced<T>(data: T, over: Partial<Sourced<T>> = {}): Sourced<T> {
  return {
    data,
    asOf: "2026-06-30",
    source: "fmp",
    endpoint: "fixture://provider",
    fetchedAt: FETCHED_AT,
    ...over,
  };
}

beforeEach(() => {
  cacheMocks.cachedFetch.mockReset();
  cacheMocks.cachedFetch.mockImplementation(async (rawOptions: CachedFetchOptions) => {
    const fetched = await rawOptions.fetcher();
    return {
      data: fetched.body,
      asOf: fetched.asOf,
      fetchedAt: FETCHED_AT,
      stale: true,
      staleReason: "fixture-stale",
    };
  });
});

afterEach(() => {
  _resetAnthropicForTests();
  setBandwidthRecorder(null);
  resetBandwidthTotals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Anthropic finite request contracts", () => {
  it("recognizes only exact aliases or eight-digit snapshots and applies dated pricing", () => {
    expect(pricedModelAlias("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(pricedModelAlias("claude-sonnet-5-20260808")).toBe("claude-sonnet-5");
    expect(pricedModelAlias("claude-sonnet-5-latest")).toBeNull();
    expect(assertPricedModel("claude-opus-4-8-20260808")).toBe("claude-opus-4-8");
    expect(() => assertPricedModel("unpriced-model")).toThrow(/unsupported model/);
    expect(effectivePricingFor("unpriced-model")).toBeUndefined();
    expect(effectivePricingFor("claude-sonnet-5", new Date("2026-08-31T23:59:59Z"))).toEqual(
      SONNET_5_INTRO_PRICING,
    );
    expect(effectivePricingFor("claude-sonnet-5", new Date("2026-09-01T00:00:00Z"))).not.toEqual(
      SONNET_5_INTRO_PRICING,
    );
    expect(modelContextTokenLimit("claude-haiku-4-5")).toBe(200_000);
    expect(modelContextTokenLimit("claude-opus-4-8")).toBe(1_000_000);
  });

  it("rejects invalid output and web-search exposure before provider launch", () => {
    const base: RunPassOptions = {
      model: "claude-opus-4-8",
      system: "system",
      messages: [{ role: "user", content: "prompt" }],
      tools: [],
      outputSchema: { type: "object" },
      maxTokens: 1,
      field: "llm.bull",
    };
    expect(() => validateRunPassOptions(base)).not.toThrow();
    expect(() => validateRunPassOptions({ ...base, maxTokens: 64_001 })).toThrow(/max_tokens/);
    expect(() =>
      validateRunPassOptions({
        ...base,
        tools: [{ type: "web_search_20260318", name: "web_search", max_uses: 0 }],
      }),
    ).toThrow(/positive integer/);
    expect(() =>
      validateRunPassOptions({
        ...base,
        field: "llm.judge",
        tools: [{ type: "web_search_20260318", name: "web_search", max_uses: 1 }],
      }),
    ).toThrow(/judge request cannot enable web search/);
  });

  it("returns an already completed public resumption message unchanged", async () => {
    const message = anthropicMessage(analystCase());

    await expect(
      resumeIfPaused({} as Anthropic, {} as never, message as never),
    ).resolves.toBe(message);
  });

  it("unwraps the provider cause when a paused public resumption fails", async () => {
    const failure = new Error("resume provider failed");
    const create = vi.fn(async (_params: unknown) => {
      void _params;
      throw failure;
    });
    const client = { beta: { messages: { create } } } as unknown as Anthropic;
    const baseMessage = anthropicMessage(analystCase());
    const paused = {
      ...baseMessage,
      content: baseMessage.content,
      stop_reason: "pause_turn",
    };
    const params = {
      messages: [{ role: "user", content: "original prompt" }],
    } as never;

    await expect(resumeIfPaused(client, params, paused as never)).rejects.toBe(failure);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      messages: [
        { role: "user", content: "original prompt" },
        { role: "assistant", content: paused.content },
      ],
    });
  });
});

describe("Finnhub adapters", () => {
  it("normalizes all four successful endpoint payloads and derives literal as-of dates", async () => {
    const requestedUrls: URL[] = [];
    const fetchImpl = vi.fn(async (input: string | URL, _init?: RequestInit) => {
      void _init;
      const requested = new URL(String(input));
      requestedUrls.push(requested);
      const path = requested.pathname;
      if (path.endsWith("/stock/insider-sentiment")) {
        return jsonResponse({
          data: [
            { year: 2026, month: 6, change: null, mspr: 3.5 },
            { year: 2025, month: 12 },
          ],
        });
      }
      if (path.endsWith("/stock/uspto-patent")) {
        return jsonResponse({
          data: [
            {
              applicationNumber: "A-1",
              description: "chip",
              filingDate: "2026-05-02T13:00:00Z",
              filingStatus: "pending",
              patentNumber: "P-1",
              patentType: "utility",
              publicationDate: "2026-06-03",
              url: "https://patents.example/1",
            },
            { filingDate: "not-an-iso-date" },
          ],
        });
      }
      if (path.endsWith("/stock/lobbying")) {
        return jsonResponse({
          data: [
            {
              name: "Registrant",
              description: "filing",
              expenses: 12,
              income: 3,
              date: "2026-04-20T00:00:00Z",
              period: "Q2",
              year: 2026,
              documentUrl: "https://lobby.example/1",
            },
            {},
          ],
        });
      }
      if (path.endsWith("/stock/usa-spending")) {
        return jsonResponse({
          data: [
            {
              recipientName: "Issuer",
              awardingAgencyName: "Agency",
              awardingSubAgencyName: "Subagency",
              totalValue: 42,
              actionDate: "2026-07-04T12:00:00Z",
              awardDescription: "award",
              permalink: "https://spending.example/1",
            },
            {},
          ],
        });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    const config = { ...FAST_FINNHUB, fetchImpl };

    const sentiment = await insiderSentiment(" aapl ", "2025-01-01", "2026-07-31", config);
    const patents = await usptoPatents("nvda", "2026-01-01", "2026-07-31", config);
    const lobby = await lobbying("lmt", "2026-01-01", "2026-07-31", config);
    const spending = await govSpending("ba", "2026-01-01", "2026-07-31", config);

    expect(sentiment).toMatchObject({
      ok: true,
      value: {
        asOf: "2026-06-01",
        data: [
          { year: 2025, month: 12, change: null, mspr: null },
          { year: 2026, month: 6, change: null, mspr: 3.5 },
        ],
      },
    });
    expect(patents).toMatchObject({
      ok: true,
      value: { asOf: "2026-05-02", data: [{ filingDate: "2026-05-02" }, { filingDate: "not-an-iso-date" }] },
    });
    expect(lobby).toMatchObject({
      ok: true,
      value: { asOf: "2026-04-20", data: [{ date: "2026-04-20" }, { date: null }] },
    });
    expect(spending).toMatchObject({
      ok: true,
      value: { asOf: "2026-07-04", data: [{ actionDate: "2026-07-04" }, { actionDate: null }] },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    for (const call of fetchImpl.mock.calls) {
      expect(call[1]?.headers).toMatchObject({ "X-Finnhub-Token": "FINNHUB-TEST" });
    }
    expect(
      requestedUrls.map((url) => [
        url.pathname,
        url.searchParams.get("symbol"),
        url.searchParams.get("from"),
        url.searchParams.get("to"),
      ]),
    ).toEqual([
      ["/api/v1/stock/insider-sentiment", "AAPL", "2025-01-01", "2026-07-31"],
      ["/api/v1/stock/uspto-patent", "NVDA", "2026-01-01", "2026-07-31"],
      ["/api/v1/stock/lobbying", "LMT", "2026-01-01", "2026-07-31"],
      ["/api/v1/stock/usa-spending", "BA", "2026-01-01", "2026-07-31"],
    ]);
  });

  it("distinguishes empty, malformed, auth, premium, transient, and retry outcomes", async () => {
    const empty = await insiderSentiment("AAPL", "2026-01-01", "2026-07-31", {
      ...FAST_FINNHUB,
      fetchImpl: async () => jsonResponse({ data: [] }),
    });
    expect(empty).toMatchObject({ ok: false, gap: { severity: "info" } });

    for (const call of [
      () => usptoPatents("AAPL", "2026-01-01", "2026-07-31", {
        ...FAST_FINNHUB,
        fetchImpl: async () => jsonResponse({ data: "wrong" }),
      }),
      () => lobbying("AAPL", "2026-01-01", "2026-07-31", {
        ...FAST_FINNHUB,
        fetchImpl: async () => jsonResponse({}, 401),
      }),
      () => govSpending("AAPL", "2026-01-01", "2026-07-31", {
        ...FAST_FINNHUB,
        fetchImpl: async () => jsonResponse({}, 403),
      }),
    ]) {
      await expect(call()).resolves.toMatchObject({ ok: false, gap: { attemptedSources: ["finnhub"] } });
    }

    let attempts = 0;
    const retry = await insiderSentiment("AAPL", "2026-01-01", "2026-07-31", {
      ...FAST_FINNHUB,
      retryDelaysMs: [0],
      fetchImpl: async () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse({ busy: true }, 503)
          : jsonResponse({ data: [{ year: 2026, month: 7, change: 1, mspr: 2 }] });
      },
    });
    expect(retry.ok).toBe(true);
    expect(attempts).toBe(2);

    const enabledWithoutKey = await lobbying("AAPL", "2026-01-01", "2026-07-31", {
      enableSectorModules: true,
    });
    expect(enabledWithoutKey).toMatchObject({ ok: false, gap: { reason: "Finnhub key missing", severity: "warn" } });
  });
});

describe("FINRA adapters", () => {
  const row = (date: string, quantity: number, symbolCode = "AAPL") => ({
    symbolCode,
    issueName: null,
    settlementDate: date,
    currentShortPositionQuantity: quantity,
  });

  it("sends scoped authenticated requests and returns latest and trend provenance", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("/partitions/")) {
        return jsonResponse({
          availablePartitions: [
            { partitions: ["2026-06-30", "invalid"] },
            { partitions: ["2026-06-15", "2026-06-30"] },
          ],
        });
      }
      const body = JSON.parse(String(init?.body)) as {
        compareFilters?: Array<{ fieldName: string; fieldValue: string }>;
        domainFilters?: Array<{ fieldName: string; values: string[] }>;
      };
      const requestedDates =
        body.domainFilters?.find((filter) => filter.fieldName === "settlementDate")?.values ??
        body.compareFilters
          ?.filter((filter) => filter.fieldName === "settlementDate")
          .map((filter) => filter.fieldValue) ??
        [];
      return jsonResponse([
        row("2026-06-15", 90),
        row("2026-06-30", 100),
        row("2026-06-30", 110),
      ].filter((candidate) => requestedDates.includes(candidate.settlementDate)));
    });
    const config = {
      ...FAST_FINRA,
      authToken: "TOKEN",
      baseUrl: "https://finra.example",
      fetchImpl,
    };

    const latestDate = await latestSettlementDate(config);
    const latest = await shortInterest(" aapl ", config);
    const trend = await shortInterestTrend("aapl", 99, config);

    expect(latestDate).toMatchObject({ ok: true, value: { data: "2026-06-30", asOf: "2026-06-30" } });
    expect(latest).toMatchObject({ ok: true, value: { data: { currentShortPositionQuantity: 110 } } });
    expect(trend).toMatchObject({
      ok: true,
      value: {
        asOf: "2026-06-30",
        data: [
          { settlementDate: "2026-06-15", currentShortPositionQuantity: 90 },
          { settlementDate: "2026-06-30", currentShortPositionQuantity: 110 },
        ],
      },
    });
    expect(requests.every(({ init }) => new Headers(init?.headers).get("authorization") === "Bearer TOKEN")).toBe(true);
    const posted = requests.find(({ init }) => init?.method === "POST");
    expect(JSON.parse(String(posted?.init?.body))).toEqual({
      limit: 5,
      compareFilters: [
        { compareType: "EQUAL", fieldName: "symbolCode", fieldValue: "AAPL" },
        { compareType: "EQUAL", fieldName: "settlementDate", fieldValue: "2026-06-30" },
      ],
    });
  });

  it("fails closed on malformed partitions, rows, scope, and non-transient transport", async () => {
    expect(pickLatestPartitions({ availablePartitions: [{ partitions: ["bad"] }] }, 0)).toBeNull();
    expect(
      pickLatestPartitions(
        { availablePartitions: [{ partitions: ["2026-06-30", "2026-06-30", "2026-06-15"] }] },
        0,
      ),
    ).toEqual(["2026-06-30"]);

    const point: ShortInterestPoint = {
      symbol: "AAPL",
      issueName: null,
      settlementDate: "2026-06-30",
      currentShortPositionQuantity: 1,
      previousShortPositionQuantity: null,
      changePreviousNumber: null,
      changePercent: null,
      averageDailyVolumeQuantity: null,
      daysToCoverQuantity: null,
      daysToCoverSentinel: false,
      marketClassCode: null,
      notes: [],
    };
    expect(validateShortInterestScope([point], "AAPL", new Set(["2026-06-30"]))).toEqual({
      ok: true,
      rows: [point],
    });
    expect(validateShortInterestScope([point], "AAPL", new Set(["2026-06-15"]))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("outside"),
    });

    const malformedPartitions = await latestSettlementDate({
      ...FAST_FINRA,
      fetchImpl: async () => jsonResponse({ nope: true }),
    });
    expect(malformedPartitions).toMatchObject({ ok: false, gap: { severity: "warn" } });

    const denied = await latestSettlementDate({
      ...FAST_FINRA,
      fetchImpl: async () => jsonResponse({ denied: true }, 403),
    });
    expect(denied).toMatchObject({ ok: false, gap: { reason: expect.stringContaining("HTTP 403") } });

    const malformedRows = await shortInterest("AAPL", {
      ...FAST_FINRA,
      fetchImpl: async (input) =>
        String(input).includes("/partitions/")
          ? jsonResponse({ availablePartitions: [{ partitions: ["2026-06-30"] }] })
          : jsonResponse({ not: "rows" }),
    });
    expect(malformedRows).toMatchObject({ ok: false, gap: { reason: expect.stringContaining("unrecognized") } });
  });

  it("retries transient and unparseable responses but preserves the final gap", async () => {
    let calls = 0;
    const recovered = await latestSettlementDate({
      ...FAST_FINRA,
      retryDelaysMs: [0, 0],
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return jsonResponse({ busy: true }, 500);
        if (calls === 2) return new Response("not-json", { status: 200 });
        return jsonResponse({ availablePartitions: [{ partitions: ["2026-06-30"] }] });
      },
    });
    expect(recovered.ok).toBe(true);
    expect(calls).toBe(3);

    const networkGap = await latestSettlementDate({
      ...FAST_FINRA,
      fetchImpl: async () => {
        throw "offline";
      },
    });
    expect(networkGap).toMatchObject({ ok: false, gap: { reason: expect.stringContaining("offline") } });
  });
});

describe("FRED transforms and transport", () => {
  it("covers every official units transform and all frequency buckets", () => {
    const frequencies: Array<{ rows: FredObservation[]; expected: number }> = [
      { rows: [{ date: "2026-01-01", value: 1 }], expected: 1 },
      { rows: [{ date: "2026-01-01", value: 1 }, { date: "2026-01-08", value: 2 }], expected: 52 },
      { rows: [{ date: "2026-01-01", value: 1 }, { date: "2026-01-15", value: 2 }], expected: 26 },
      { rows: [{ date: "2026-01-01", value: 1 }, { date: "2026-02-01", value: 2 }], expected: 12 },
      { rows: [{ date: "2026-01-01", value: 1 }, { date: "2026-04-01", value: 2 }], expected: 4 },
      { rows: [{ date: "2025-01-01", value: 1 }, { date: "2026-01-01", value: 2 }], expected: 1 },
    ];
    for (const { rows, expected } of frequencies) expect(inferObsPerYear(rows)).toBe(expected);
    expect(inferObsPerYear([{ date: "bad", value: 1 }, { date: "also-bad", value: 2 }])).toBe(1);

    const rows = [
      { date: "2025-01-01", value: 100 },
      { date: "2026-01-01", value: 121 },
    ];
    const expected: Record<FredUnits, number> = {
      lin: 100,
      log: Math.log(100),
      chg: 21,
      ch1: 21,
      pch: 21,
      pc1: 21,
      pca: 21,
      cch: (Math.log(121) - Math.log(100)) * 100,
      cca: (Math.log(121) - Math.log(100)) * 100,
    };
    for (const units of Object.keys(expected) as FredUnits[]) {
      expect(applyFredUnits(rows, units)[0]?.value).toBeCloseTo(expected[units], 10);
    }
    expect(applyFredUnits([{ date: "2026-01-01", value: -1 }], "log")).toEqual([]);
    expect(applyFredUnits([{ date: "2025-01-01", value: 0 }, { date: "2026-01-01", value: 1 }], "pch")).toEqual([]);
    expect(applyFredUnits([{ date: "2025-01-01", value: -1 }, { date: "2026-01-01", value: 1 }], "pca")).toEqual([]);
    expect(applyFredUnits([{ date: "2025-01-01", value: -1 }, { date: "2026-01-01", value: 1 }], "cch")).toEqual([]);
  });

  it("uses keyed JSON with query bounds and filters missing observations", async () => {
    const urls: string[] = [];
    const result = await series(" dgs10 ", { start: "2026-01-01", end: "2026-07-31", units: "chg" }, {
      ...FAST_FRED,
      apiKey: "FRED-KEY",
      fetchImpl: async (input) => {
        urls.push(String(input));
        return jsonResponse({
          observations: [
            { date: "2026-06-01", value: "." },
            { date: "2026-06-02", value: "not-number" },
            { date: "2026-06-03", value: "4.5" },
          ],
        });
      },
    });
    expect(result).toMatchObject({ ok: true, value: { asOf: "2026-06-03", data: [{ value: 4.5 }] } });
    const url = new URL(urls[0]);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      series_id: "DGS10",
      api_key: "FRED-KEY",
      observation_start: "2026-01-01",
      observation_end: "2026-07-31",
      units: "chg",
    });
  });

  it("falls back from keyed failures and distinguishes malformed, empty, and transport gaps", async () => {
    let calls = 0;
    const fallback = await series("CPIAUCSL", { units: "chg" }, {
      ...FAST_FRED,
      apiKey: "BAD-KEY",
      fetchImpl: async (input) => {
        calls += 1;
        return String(input).includes("api.stlouisfed.org")
          ? jsonResponse({ error: "bad key" }, 400)
          : new Response("observation_date,CPIAUCSL\n2026-01-01,100\n2026-02-01,102\n", { status: 200 });
      },
    });
    expect(fallback).toMatchObject({
      ok: true,
      value: { data: [{ date: "2026-02-01", value: 2 }], endpoint: expect.stringContaining("computed client-side") },
    });
    expect(calls).toBe(2);

    const malformedKeyed = await series("DGS10", {}, {
      ...FAST_FRED,
      apiKey: "KEY",
      fetchImpl: async () => new Response("not-json", { status: 200 }),
    });
    expect(malformedKeyed).toMatchObject({ ok: false, gap: { reason: expect.stringContaining("unrecognized payload") } });

    const emptyKeyed = await series("DGS10", {}, {
      ...FAST_FRED,
      apiKey: "KEY",
      fetchImpl: async () => jsonResponse({ observations: [{ date: "2026-01-01", value: "." }] }),
    });
    expect(emptyKeyed).toMatchObject({ ok: false, gap: { severity: "info" } });

    const nonCsv = await series("DGS10", {}, {
      ...FAST_FRED,
      fetchImpl: async () => new Response("<html>missing</html>", { status: 200 }),
    });
    expect(nonCsv).toMatchObject({ ok: false, gap: { reason: expect.stringContaining("non-CSV") } });

    const emptyCsv = await series("DGS10", {}, {
      ...FAST_FRED,
      fetchImpl: async () => new Response("observation_date,DGS10\n2026-01-01,.\n", { status: 200 }),
    });
    expect(emptyCsv).toMatchObject({ ok: false, gap: { severity: "info" } });

    const failed = await series("DGS10", {}, {
      ...FAST_FRED,
      fetchImpl: async () => new Response("denied", { status: 403 }),
    });
    expect(failed).toMatchObject({ ok: false, gap: { reason: expect.stringContaining("HTTP 403") } });
    await expect(series("", {}, FAST_FRED)).rejects.toThrow(/invalid series id/);
    await expect(series("A,B", {}, FAST_FRED)).rejects.toThrow(/single series only/);
  });

  it("returns the latest observation and propagates an upstream gap", async () => {
    const ok = await latestValue("DGS10", {
      ...FAST_FRED,
      fetchImpl: async () => new Response("observation_date,DGS10\n2026-06-01,4.1\n2026-06-02,4.2\n", { status: 200 }),
    });
    expect(ok).toMatchObject({ ok: true, value: { data: { date: "2026-06-02", value: 4.2 }, asOf: "2026-06-02" } });

    const gap = await latestValue("DGS10", {
      ...FAST_FRED,
      fetchImpl: async () => new Response("denied", { status: 403 }),
    });
    expect(gap.ok).toBe(false);
  });

  it("retries after a real backoff, aborts an in-flight backoff, and contains unreadable bodies", async () => {
    let retryAttempts = 0;
    const retry = await series("DGS10", {}, {
      ...FAST_FRED,
      retryDelaysMs: [1],
      fetchImpl: async () => {
        retryAttempts += 1;
        return retryAttempts === 1
          ? new Response("busy", { status: 500 })
          : new Response("observation_date,DGS10\n2026-06-02,4.2\n", { status: 200 });
      },
    });
    expect(retry).toMatchObject({ ok: true, value: { asOf: "2026-06-02" } });
    expect(retryAttempts).toBe(2);

    const abort = new AbortController();
    let abortAttempts = 0;
    const aborted = series("DGS10", {}, {
      ...FAST_FRED,
      retryDelaysMs: [1_000],
      signal: abort.signal,
      fetchImpl: async () => {
        abortAttempts += 1;
        return new Response("busy", { status: 500 });
      },
    });
    setTimeout(() => abort.abort(new Error("stop FRED retry")), 10);
    await expect(aborted).rejects.toThrow(/stop FRED retry/);
    expect(abortAttempts).toBe(1);

    const unreadable = await series("DGS10", {}, {
      ...FAST_FRED,
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => {
            throw new Error("body unavailable");
          },
        }) as unknown as Response,
    });
    expect(unreadable).toMatchObject({ ok: false, gap: { attemptedSources: ["fred"] } });
  });
});

describe("shared provider HTTP edge behavior", () => {
  it("uses explicit registry overrides and contains throwing bandwidth hooks", async () => {
    const limiter = makeLimiter(1000, 10);
    setProviderLimiter("coverage-provider", limiter);
    expect(getProviderLimiter("coverage-provider")).toBe(limiter);
    const fallback = getProviderLimiter("coverage-fallback");
    expect(fallback).toMatchObject({ ratePerSec: 2, burst: 2 });

    resetBandwidthTotals();
    const globalRecorder = vi.fn(() => {
      throw new Error("global accounting failed");
    });
    const localRecorder = vi.fn(() => {
      throw new Error("local accounting failed");
    });
    setBandwidthRecorder(globalRecorder);
    const result = await fetchWithPolicy("https://provider.test/data", undefined, {
      provider: "coverage-provider",
      limiter,
      maxRetries: 0,
      timeoutMs: 1000,
      fetchImpl: async () => new Response("\u{1F600}", { status: 200 }),
      onBytes: localRecorder,
    });
    expect(result.bytes).toBe(4);
    expect(getBandwidthTotals()["coverage-provider"]).toBe(4);
    expect(globalRecorder).toHaveBeenCalledWith(
      "coverage-provider",
      4,
      "https://provider.test/data",
    );
    expect(localRecorder).toHaveBeenCalledWith(
      "coverage-provider",
      4,
      "https://provider.test/data",
    );
  });

  it("parses HTTP-date retry windows and blocks unsafe or incomplete redirects", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T00:00:00Z"));
    expect(parseRetryAfterMs("Sat, 08 Aug 2026 00:00:02 GMT")).toBe(2000);
    expect(parseRetryAfterMs("Fri, 07 Aug 2026 00:00:00 GMT")).toBe(0);
    vi.useRealTimers();

    for (const response of [
      new Response(null, { status: 302 }),
      new Response(null, { status: 302, headers: { location: "https://other.example/path" } }),
      new Response(null, { status: 302, headers: { location: "http://provider.test/path" } }),
      new Response(null, { status: 302, headers: { location: "http://[invalid" } }),
    ]) {
      let blockedCalls = 0;
      const blocked = await fetchWithRedirectPolicy(
        "https://provider.test/start",
        undefined,
        async () => {
          blockedCalls += 1;
          if (blockedCalls > 1) throw new Error("blocked redirect must not be followed");
          return response.clone();
        },
      );
      expect(blocked.status).toBe(302);
      expect(blockedCalls).toBe(1);
    }

    let calls = 0;
    const capped = await fetchWithRedirectPolicy(
      "https://provider.test/start",
      undefined,
      async () => {
        calls += 1;
        return new Response(null, { status: 302, headers: { location: "/again" } });
      },
      1,
    );
    expect(capped.status).toBe(302);
    expect(calls).toBe(2);
  });

  it("cancels during retry sleep and never starts a second attempt", async () => {
    const abort = new AbortController();
    let attempts = 0;
    let releaseSleep!: () => void;
    const sleepStarted = new Promise<void>((resolve) => {
      releaseSleep = resolve;
    });
    const pending = fetchWithPolicy("https://provider.test/retry", undefined, {
      provider: "coverage-abort",
      limiter: makeLimiter(1000, 10),
      signal: abort.signal,
      maxRetries: 1,
      fetchImpl: async () => {
        attempts += 1;
        return new Response("busy", { status: 503 });
      },
      sleepImpl: async () => {
        releaseSleep();
        await new Promise<void>(() => undefined);
      },
    });
    await sleepStarted;
    abort.abort(new Error("cancel during backoff"));

    await expect(pending).rejects.toBeInstanceOf(HttpRequestAbortedError);
    expect(attempts).toBe(1);
  });
});

describe("data-bundle provider boundaries", () => {
  it("normalizes sector routing and earnings without mutating source rows", () => {
    expect(resolveSectorEtf(null)).toBeNull();
    expect(resolveSectorEtf(" Technology ")).toBe("XLK");
    expect(resolveSectorEtf("Unknown Sector")).toBeNull();
    expect(resolveGicsSector(undefined)).toBeNull();
    expect(resolveGicsSector(" healthcare ")).toBe("Health Care");
    expect(resolveGicsSector("Unknown Sector")).toBeNull();

    const rows: FmpEarningsRow[] = [
      { date: "2026-08-20", epsActual: null },
      { date: "2026-09-01T12:00:00Z", epsActual: null },
      { date: "2026-08-15", epsActual: null },
      { date: "2026-07-01", epsActual: 1 },
      { date: "2026-02-30", epsActual: null },
      { date: "9999-99-99", epsActual: null },
      { date: 42, epsActual: null } as unknown as FmpEarningsRow,
    ];
    const before = structuredClone(rows);
    const result = deriveNextEarnings(
      { ok: true, value: sourced<FmpPayload<FmpEarningsRow>>({ rows, raw: rows }, { stale: true }) },
      "2026-08-01",
      "AAPL",
    );
    expect(result).toMatchObject({ ok: true, value: { asOf: "2026-08-15", stale: true } });
    expect(rows).toEqual(before);

    const upstreamGap = deriveNextEarnings(
      { ok: false, gap: { field: "earnings", reason: "offline", severity: "warn" } },
      "2026-08-01",
      "AAPL",
    );
    expect(upstreamGap).toMatchObject({ ok: false, gap: { reason: expect.stringContaining("offline") } });
  });

  it("dedupes normalized FRED identities while preserving distinct units", () => {
    const input = [
      { id: " dgs10 ", units: "lin" as const },
      { id: "DGS10", units: "lin" as const },
      { id: "dgs10", units: "chg" as const },
    ];
    const before = structuredClone(input);
    expect(dedupeFredSeriesSpecs(input)).toEqual([
      { id: "DGS10", units: "lin" },
      { id: "DGS10", units: "chg" },
    ]);
    expect(input).toEqual(before);
  });

  it("selects exact annual/interim forms with stale and filing-date provenance", () => {
    const filing = (form: string, reportDate = ""): EdgarFiling => ({
      accessionNumber: `${form}-accession`,
      form,
      filingDate: "2026-03-01",
      reportDate,
      primaryDocument: "filing.htm",
    });
    const submissions = (forms: EdgarFiling[]): Sourced<EdgarSubmissions> => ({
      data: {
        cik: "0000000001",
        name: "Issuer",
        sic: null,
        sicDescription: null,
        fiscalYearEnd: null,
        stateOfIncorporation: null,
        tickers: ["ADR"],
        exchanges: ["NYSE"],
        recentFilings: forms,
        olderPages: [],
      },
      asOf: "2026-03-01",
      source: "edgar",
      endpoint: "edgar://submissions",
      fetchedAt: FETCHED_AT,
      stale: true,
    });

    expect(selectAnnualFiling(submissions([filing("20-F")]), "ADR")).toMatchObject({
      ok: true,
      value: { asOf: "2026-03-01", stale: true, data: { form: "20-F" } },
    });
    expect(selectInterimFiling(submissions([filing("6-K", "2026-02-28")]), "ADR")).toMatchObject({
      ok: true,
      value: { asOf: "2026-02-28", data: { form: "6-K" } },
    });
    expect(selectAnnualFiling(submissions([]), "NONE")).toMatchObject({ ok: false, gap: { severity: "critical" } });
    expect(selectInterimFiling(submissions([]), "NONE")).toMatchObject({ ok: false, gap: { severity: "warn" } });
  });

  it("preserves cache freshness metadata and contains provider gaps", async () => {
    const fmpFetch = makeFmpCachedFetch();
    const value = await fmpFetch("profile/AAPL", 1999, async () => ({ body: [] }));
    expect(value).toMatchObject({ stale: true, staleReason: "fixture-stale", fetchedAt: FETCHED_AT });
    const cacheOptions = cacheMocks.cachedFetch.mock.calls[0]?.[0] as CachedFetchOptions;
    expect(cacheOptions.isEmptyBody?.({ body: [] })).toBe(true);
    expect(cacheOptions.isEmptyBody?.({ body: [1] })).toBe(false);
    expect(cacheOptions.isEmptyBody?.("not-an-envelope")).toBe(false);

    const fredFetch = makeCachedFredSeries({
      ...FAST_FRED,
      fetchImpl: async () => new Response("observation_date,DGS10\n2026-08-01,4.25\n", { status: 200 }),
    });
    expect(await fredFetch("dgs10", { units: "lin" })).toMatchObject({
      ok: true,
      value: { stale: true, source: "fred", asOf: "2026-08-01" },
    });

    const finraFetch = makeCachedFinraShortInterestTrend({
      ...FAST_FINRA,
      fetchImpl: async () => jsonResponse({ denied: true }, 403),
    });
    expect(await finraFetch("aapl", 0)).toMatchObject({ ok: false, gap: { attemptedSources: ["finra"] } });

    const finnhubNoKey = makeCachedFinnhubInsiderSentiment({});
    expect(await finnhubNoKey("aapl", "2026-01-01", "2026-08-01")).toMatchObject({
      ok: false,
      gap: { reason: "Finnhub key missing" },
    });
  });

  it("reconstructs successful cached provider values and propagates hard cache failures", async () => {
    cacheMocks.cachedFetch
      .mockResolvedValueOnce({
        data: {
          obs: [{ date: "2026-08-01", value: 4.25 }],
          endpoint: "fredgraph.csv?id=DGS10",
          source: "fred",
        },
        asOf: "2026-08-01",
        fetchedAt: FETCHED_AT,
        stale: false,
      })
      .mockResolvedValueOnce({
        data: {
          rows: [{ symbol: "AAPL", settlementDate: "2026-07-31", currentShortPositionQuantity: 10 }],
          endpoint: "finra://short-interest/AAPL",
        },
        asOf: "2026-07-31",
        fetchedAt: FETCHED_AT,
        stale: true,
      })
      .mockResolvedValueOnce({
        data: {
          months: [{ year: 2026, month: 7, change: 1, mspr: 2 }],
          endpoint: "finnhub://insider-sentiment/AAPL",
        },
        asOf: "2026-07-01",
        fetchedAt: FETCHED_AT,
        stale: true,
      });

    const fredFetch = makeCachedFredSeries({ apiKey: "FRED-KEY" });
    const fredResult = await fredFetch(" dgs10 ", { start: "2026-01-01" });
    expect(fredResult).toMatchObject({
      ok: true,
      value: { data: [{ date: "2026-08-01", value: 4.25 }] },
    });
    expect(fredResult).not.toHaveProperty("value.stale");
    const fredOptions = cacheMocks.cachedFetch.mock.calls[0]?.[0] as {
      params: Record<string, unknown>;
    };
    expect(fredOptions.params).toEqual({
      authMode: "keyed",
      start: "2026-01-01",
      end: null,
      units: "lin",
    });

    const finraFetch = makeCachedFinraShortInterestTrend({});
    await expect(finraFetch(" aapl ")).resolves.toMatchObject({
      ok: true,
      value: { data: [{ settlementDate: "2026-07-31" }], stale: true },
    });
    const finnhubFetch = makeCachedFinnhubInsiderSentiment({ apiKey: "FINNHUB-KEY" });
    const finnhubResult = await finnhubFetch(" aapl ", "2026-01-01", "2026-08-01");
    expect(finnhubResult).toMatchObject({
      ok: true,
      value: { data: [{ year: 2026, month: 7 }], stale: true },
    });

    for (const failingFetch of [
      () => makeCachedFredSeries({})("DGS10", {}),
      () => makeCachedFinraShortInterestTrend({})("AAPL"),
      () =>
        makeCachedFinnhubInsiderSentiment({ apiKey: "FINNHUB-KEY" })(
          "AAPL",
          "2026-01-01",
          "2026-08-01",
        ),
    ]) {
      cacheMocks.cachedFetch.mockRejectedValueOnce(new Error("cache unavailable"));
      await expect(failingFetch()).rejects.toThrow("cache unavailable");
    }

    const fredGapFetch = makeCachedFredSeries({
      ...FAST_FRED,
      fetchImpl: async () => new Response("denied", { status: 403 }),
    });
    await expect(fredGapFetch("DGS10", {})).resolves.toMatchObject({
      ok: false,
      gap: { attemptedSources: ["fred"] },
    });

    const finnhubGapFetch = makeCachedFinnhubInsiderSentiment({
      ...FAST_FINNHUB,
      fetchImpl: async () => jsonResponse({ denied: true }, 403),
    });
    await expect(
      finnhubGapFetch("AAPL", "2026-01-01", "2026-08-01"),
    ).resolves.toMatchObject({
      ok: false,
      gap: { attemptedSources: ["finnhub"] },
    });
  });

  it("classifies foreign and standardized interim filings when document fetches fail", async () => {
    const noNetwork = async (): Promise<Response> =>
      new Response("provider unavailable", { status: 404 });
    const buildWithForms = async (forms: readonly string[]) => {
      const calls: string[] = [];
      const response = (body: string, status = 200): EdgarTransportResponse => ({
        status,
        body,
        fetchedAt: FETCHED_AT,
        fromCache: false,
        stale: false,
      });
      const submissionsBody = JSON.stringify({
        cik: "0000000000",
        name: "Thesis Example Systems",
        sic: "7372",
        sicDescription: "Prepackaged Software",
        fiscalYearEnd: "1231",
        stateOfIncorporation: "CA",
        tickers: ["DEMO"],
        exchanges: ["TEST"],
        filings: {
          files: [],
          recent: {
            accessionNumber: forms.map((_, index) => `0000000000-26-00000${index + 1}`),
            filingDate: forms.map((_, index) => `2026-0${index + 2}-01`),
            reportDate: forms.map(() => "2025-12-31"),
            form: [...forms],
            primaryDocument: forms.map((_, index) => `filing-${index + 1}.htm`),
          },
        },
      });
      const transport: EdgarTransport = {
        fetchText(url): Promise<EdgarTransportResponse> {
          calls.push(url);
          if (url.includes("company_tickers.json")) {
            return Promise.resolve(
              response(
                JSON.stringify({
                  "0": { cik_str: 0, ticker: "DEMO", title: "Thesis Example Systems" },
                }),
              ),
            );
          }
          if (url.includes("submissions/CIK0000000000.json")) {
            return Promise.resolve(response(submissionsBody));
          }
          if (url.includes("companyfacts/CIK0000000000.json")) {
            return Promise.resolve(
              response(
                JSON.stringify({ cik: 0, entityName: "Thesis Example Systems", facts: {} }),
              ),
            );
          }
          if (url.includes("Archives/edgar/data")) {
            return Promise.resolve(response("filing unavailable", 404));
          }
          throw new Error(`unexpected EDGAR transport call: ${url}`);
        },
      };

      const bundle = await buildDataBundle("DEMO", {
        now: () => new Date("2026-08-08T12:00:00.000Z"),
        eodYears: 1,
        fmp: createFmpClient({ apiKey: "" }),
        edgar: createEdgarClient({ transport }),
        fred: {
          fetchImpl: noNetwork,
          retryDelaysMs: [],
          minRequestIntervalMs: 0,
          timeoutMs: 0,
        },
        finnhub: { fetchImpl: noNetwork, retryDelaysMs: [], timeoutMs: 0 },
        finra: {
          fetchImpl: noNetwork,
          retryDelaysMs: [],
          minRequestIntervalMs: 0,
          timeoutMs: 0,
        },
      });
      return { bundle, calls };
    };

    const foreign = await buildWithForms(["20-F", "6-K"]);
    expect(foreign.bundle.edgar.latestTenK).toMatchObject({
      ok: true,
      value: { data: { form: "20-F" } },
    });
    expect(foreign.bundle.edgar.latestTenQ).toMatchObject({
      ok: true,
      value: { data: { form: "6-K" } },
    });
    expect(foreign.bundle.edgar.item1a).toMatchObject({
      ok: false,
      gap: { severity: "critical", reason: expect.stringMatching(/20-F document fetch failed/) },
    });
    expect(foreign.bundle.edgar.tenQMdna).toMatchObject({
      ok: false,
      gap: { severity: "info", expected: true, reason: expect.stringMatching(/6-K/) },
    });
    expect(foreign.calls.filter((url) => url.includes("Archives/edgar/data"))).toHaveLength(1);

    const domestic = await buildWithForms(["10-K", "10-Q"]);
    expect(domestic.bundle.edgar.latestTenQ).toMatchObject({
      ok: true,
      value: { data: { form: "10-Q" } },
    });
    expect(domestic.bundle.edgar.tenQMdna).toMatchObject({
      ok: false,
      gap: { severity: "warn", reason: expect.stringMatching(/10-Q document fetch failed/) },
    });
    expect(domestic.calls.filter((url) => url.includes("Archives/edgar/data"))).toHaveLength(2);
  });
});

function emptyPayload(): ContextPayload {
  const section = (title: string): PayloadSection => ({ title, figures: [], notes: [] });
  return {
    payloadVersion: "1.3.0",
    symbol: "AAPL",
    companyName: "Issuer",
    route: { base: "general", overlays: [], sector: null, industry: null },
    quote: section("Quote"),
    computed: [],
    statements: [],
    estimates: section("Estimates"),
    peers: section("Peers"),
    insiders: section("Insiders"),
    institutional: section("Institutional"),
    leadership: section("Leadership"),
    shortInterest: section("Short interest"),
    segments: section("Segments"),
    macro: section("Macro"),
    transcript: null,
    filings: [],
    news: section("News"),
    validationFlags: [],
    missingData: [],
    asOfMap: {},
  };
}

function analystCase(): AnalystCase {
  return {
    thesis: [{ text: "case", label: "JUDGMENT", source: "payload", asOf: null }],
    keyDrivers: [],
    risksToCase: [],
    catalysts: [],
    priceTarget: { value: 100, horizon: "12mo", assumptions: [] },
    evidence: [],
  };
}

function anthropicMessage(output: unknown): Record<string, unknown> {
  return {
    id: "msg_coverage",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-8",
    content: [{ type: "text", text: JSON.stringify(output), citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      inference_geo: null,
      iterations: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
  };
}

function streamingClient(outputs: unknown[]): Anthropic {
  let index = 0;
  return {
    beta: {
      messages: {
        stream: () => {
          const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
          const add = (name: string, callback: (...args: unknown[]) => void) => {
            listeners.set(name, [...(listeners.get(name) ?? []), callback]);
          };
          const message = anthropicMessage(outputs[Math.min(index++, outputs.length - 1)]);
          const final = new Promise<Record<string, unknown>>((resolve) => {
            queueMicrotask(() => {
              for (const callback of listeners.get("streamEvent") ?? []) {
                callback({ type: "message_start", message });
              }
              for (const callback of listeners.get("end") ?? []) callback();
              resolve(message);
            });
          });
          return {
            on: (name: string, callback: (...args: unknown[]) => void) => {
              add(name, callback);
              return undefined;
            },
            once: (name: string, callback: (...args: unknown[]) => void) => {
              add(name, callback);
              return undefined;
            },
            finalMessage: () => final,
          };
        },
        create: async () => {
          throw new Error("unexpected non-streaming request");
        },
      },
    },
  } as unknown as Anthropic;
}

describe("Stage C provider adapter branches", () => {
  it("preflights deterministic, analyst, and synthesis requests without launching a provider", async () => {
    const deps: PassDeps<ContextPayload> = {
      analysisModel: "claude-opus-4-8",
      effort: "medium",
      payload: emptyPayload(),
    };
    const passResult = {
      data: analystCase(),
      model: "claude-opus-4-8",
      costUsd: 0.01,
      fallbackUsed: false,
      usage: { input_tokens: 1, output_tokens: 1 },
      webSearches: 0,
      fetchedUrls: [],
    };

    const preflightPass = pipelinePasses.preflightPass;
    expect(preflightPass).toBeTypeOf("function");
    if (!preflightPass) throw new Error("Stage C preflight contract missing");
    expect(() =>
      preflightPass(deps, {
        pass: "verify",
        judgeOutput: {} as never,
        evidence: { fetchedUrls: [] },
      }),
    ).not.toThrow();
    expect(() => preflightPass(deps, { pass: "bull" })).not.toThrow();
    expect(() =>
      preflightPass(deps, {
        pass: "synthesize",
        bull: passResult,
        bear: passResult,
        validationFeedback: "repair",
      }),
    ).not.toThrow();
  });

  it("maps one-sided analyst success and preserves schema failure detail", async () => {
    _resetAnthropicForTests(streamingClient([analystCase(), {}]));
    const deps: PassDeps<ContextPayload> = {
      analysisModel: "claude-opus-4-8",
      payload: emptyPayload(),
    };

    const success = await pipelinePasses.runAnalystPass?.(deps, "bull");
    expect(success).toMatchObject({
      data: { priceTarget: { value: 100 } },
      model: "claude-opus-4-8",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    await expect(pipelinePasses.runAnalystPass?.(deps, "bear")).rejects.toThrow(/schema|invalid|failed/i);
  });

  it("reports a mixed bull/bear settlement without discarding the successful side", async () => {
    _resetAnthropicForTests(streamingClient([analystCase(), {}]));
    const deps: PassDeps<ContextPayload> = {
      analysisModel: "claude-opus-4-8",
      payload: emptyPayload(),
    };

    await expect(pipelinePasses.runBullThenBear(deps)).rejects.toMatchObject({
      bull: { data: { priceTarget: { value: 100 } } },
      bearError: expect.stringMatching(/schema|invalid|failed/i),
      bullLaunched: true,
      bearLaunched: true,
    });
  });
});
