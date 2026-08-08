import { describe, expect, it } from "vitest";

import { buildDataBundle } from "@/pipeline/dataBundle";
import {
  createEdgarClient,
  type EdgarTransport,
  type EdgarTransportResponse,
} from "@/providers/edgar";
import { createFmpClient, type FmpClient } from "@/providers/fmp";
import type { FinraConfig } from "@/providers/finra";
import type { FinnhubConfig } from "@/providers/finnhub";
import type { FredConfig } from "@/providers/fred";
import { makeLimiter } from "@/providers/http";

const NOW = new Date("2026-07-06T00:00:00.000Z");
type ConfigFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fmpEndpoint(url: URL): string {
  return /\/stable\/(.+)$/.exec(url.pathname)?.[1] ?? url.pathname;
}

function makeRecordingFmp(): {
  client: FmpClient;
  calls: URL[];
} {
  const calls: URL[] = [];
  const fetchImpl: typeof fetch = (input) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = new URL(raw);
    calls.push(url);
    const endpoint = fmpEndpoint(url);
    const period = url.searchParams.get("period");
    const date = period === "annual" ? "2025-12-31" : "2026-03-31";

    if (endpoint === "income-statement") {
      return Promise.resolve(jsonResponse([{ symbol: "DEMO", date, revenue: 100 }]));
    }
    if (endpoint === "balance-sheet-statement") {
      return Promise.resolve(jsonResponse([{ symbol: "DEMO", date, totalStockholdersEquity: 100 }]));
    }
    if (endpoint === "cash-flow-statement") {
      return Promise.resolve(jsonResponse([{ symbol: "DEMO", date, operatingCashFlow: 25 }]));
    }
    if (endpoint === "enterprise-values") {
      return Promise.resolve(
        jsonResponse([{ symbol: "DEMO", date, marketCapitalization: 400, enterpriseValue: 450 }]),
      );
    }
    return Promise.resolve(jsonResponse({ "Error Message": "not available in depth test" }, 401));
  };

  return {
    calls,
    client: createFmpClient({
      apiKey: "TEST-KEY",
      fetchImpl,
      limiter: makeLimiter(1_000_000, 1_000_000),
      now: () => NOW,
      timeoutMs: 5_000,
    }),
  };
}

function noNetworkEdgar(): EdgarTransport {
  return {
    fetchText(): Promise<EdgarTransportResponse> {
      return Promise.resolve({
        status: 404,
        body: "not available in depth test",
        fetchedAt: NOW.toISOString(),
        fromCache: false,
        stale: false,
      });
    },
  };
}

function noNetworkConfigs(): {
  fred: FredConfig;
  finnhub: FinnhubConfig;
  finra: FinraConfig;
} {
  const unavailableText: ConfigFetch = () =>
    Promise.resolve(new Response("not available in depth test", { status: 404 }));
  const unavailableJson: ConfigFetch = () =>
    Promise.resolve(jsonResponse({ error: "not available in depth test" }, 404));
  return {
    fred: { fetchImpl: unavailableText, retryDelaysMs: [], minRequestIntervalMs: 0 },
    finnhub: { apiKey: "TEST-KEY", fetchImpl: unavailableJson, retryDelaysMs: [] },
    finra: { fetchImpl: unavailableJson, retryDelaysMs: [], minRequestIntervalMs: 0 },
  };
}

async function buildWith(client: FmpClient) {
  return buildDataBundle("DEMO", {
    now: () => NOW,
    eodYears: 0,
    fmp: client,
    edgar: createEdgarClient({ transport: noNetworkEdgar() }),
    ...noNetworkConfigs(),
  });
}

function endpointCalls(calls: readonly URL[], endpoint: string): URL[] {
  return calls.filter((url) => fmpEndpoint(url) === endpoint);
}

describe("buildDataBundle canonical quarterly history depth", () => {
  it("requests 24 statement quarters and 24 quarterly EV rows without adding provider calls", async () => {
    const { client, calls } = makeRecordingFmp();

    const bundle = await buildWith(client);
    const income = endpointCalls(calls, "income-statement");
    const balance = endpointCalls(calls, "balance-sheet-statement");
    const cash = endpointCalls(calls, "cash-flow-statement");
    const enterpriseValues = endpointCalls(calls, "enterprise-values");

    const historyCalls = [...income, ...balance, ...cash, ...enterpriseValues]
      .map((url) =>
        `${fmpEndpoint(url)} ${url.searchParams.get("period")} ${url.searchParams.get("limit")}`,
      )
      .sort();
    expect(historyCalls).toEqual([
      "balance-sheet-statement annual 10",
      "balance-sheet-statement quarter 24",
      "cash-flow-statement annual 10",
      "cash-flow-statement quarter 24",
      "enterprise-values quarter 24",
      "income-statement annual 10",
      "income-statement quarter 24",
    ]);
    for (const statementCalls of [income, balance, cash]) {
      expect(statementCalls).toHaveLength(2);
      expect(
        statementCalls.map((url) => ({
          period: url.searchParams.get("period"),
          limit: url.searchParams.get("limit"),
        })),
      ).toEqual(
        expect.arrayContaining([
          { period: "annual", limit: "10" },
          { period: "quarter", limit: "24" },
        ]),
      );
    }
    expect(enterpriseValues).toHaveLength(1);
    expect(enterpriseValues[0].searchParams.get("period")).toBe("quarter");
    expect(enterpriseValues[0].searchParams.get("limit")).toBe("24");
    expect(bundle.statements.periods).toEqual({ annualRequested: 10, quarterlyRequested: 24 });
    expect(bundle.sourceManifest).toMatchObject({
      "statements.incomeAnnual": {
        provider: "fmp",
        endpoint: "/stable/income-statement?limit=10&period=annual&symbol=DEMO",
        asOf: "2025-12-31",
      },
      "statements.incomeQuarterly": {
        provider: "fmp",
        endpoint: "/stable/income-statement?limit=24&period=quarter&symbol=DEMO",
        asOf: "2026-03-31",
      },
      "statements.balanceAnnual": {
        provider: "fmp",
        endpoint: "/stable/balance-sheet-statement?limit=10&period=annual&symbol=DEMO",
        asOf: "2025-12-31",
      },
      "statements.balanceQuarterly": {
        provider: "fmp",
        endpoint: "/stable/balance-sheet-statement?limit=24&period=quarter&symbol=DEMO",
        asOf: "2026-03-31",
      },
      "statements.cashflowAnnual": {
        provider: "fmp",
        endpoint: "/stable/cash-flow-statement?limit=10&period=annual&symbol=DEMO",
        asOf: "2025-12-31",
      },
      "statements.cashflowQuarterly": {
        provider: "fmp",
        endpoint: "/stable/cash-flow-statement?limit=24&period=quarter&symbol=DEMO",
        asOf: "2026-03-31",
      },
    });
    expect(bundle.sourceManifest.enterpriseValues).toMatchObject({
      provider: "fmp",
      endpoint: "/stable/enterprise-values?limit=24&period=quarter&symbol=DEMO",
      asOf: "2026-03-31",
    });
    expect(bundle.gaps.some((gap) => /incomeStatement|balanceSheet|cashFlow|enterpriseValues/.test(gap.field))).toBe(false);
  });

  it("labels a thrown quarterly EV request as quarterly rather than annual or periodless", async () => {
    const { client, calls } = makeRecordingFmp();
    const realEnterpriseValues = client.enterpriseValues.bind(client);
    let successfulEndpoint: string | null = null;
    client.enterpriseValues = async (
      symbol: string,
      period: "annual" | "quarter" = "annual",
      limit = 10,
    ) => {
      const result = await realEnterpriseValues(symbol, period, limit);
      if (result.ok) successfulEndpoint = result.value.endpoint;
      throw new Error("forced post-fetch integration failure");
    };

    const bundle = await buildWith(client);

    expect(endpointCalls(calls, "enterprise-values")).toHaveLength(1);
    expect(successfulEndpoint).toBe(
      "/stable/enterprise-values?limit=24&period=quarter&symbol=DEMO",
    );
    expect(bundle.enterpriseValues.ok).toBe(false);
    if (bundle.enterpriseValues.ok) throw new Error("expected enterprise-values gap");
    expect(bundle.enterpriseValues.gap.field).toBe("fmp.enterpriseValues(DEMO,quarter)");
    expect(bundle.gaps).toContainEqual(
      expect.objectContaining({ field: "fmp.enterpriseValues(DEMO,quarter)" }),
    );
    expect(bundle.sourceManifest.enterpriseValues).toBeUndefined();
    expect(bundle.gaps.some((gap) => gap.field === "fmp.enterpriseValues(DEMO,annual)")).toBe(false);
    expect(bundle.gaps.some((gap) => gap.field === "fmp.enterpriseValues(DEMO)")).toBe(false);
  });
});
