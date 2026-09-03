/**
 * WS4 (D-11): the placeholder ticker here is EXMP, not DEMO. DEMO and DBNK are
 * reserved fixture symbols that short-circuit every provider, so they cannot
 * stand in for an ordinary ticker in a test about provider behaviour.
 */
/**
 * Bundle-level behaviour of the FMP subscription `limit` cap: statement
 * history is served within the cap, and the truncation is disclosed as a
 * manifest entry that names the member and the depth actually served.
 */
import { afterEach, describe, expect, it } from "vitest";

import { buildDataBundle } from "@/pipeline/dataBundle";
import {
  createEdgarClient,
  type EdgarTransport,
  type EdgarTransportResponse,
} from "@/providers/edgar";
import { createFmpClient, resetFmpPlanLimits, type FmpClient } from "@/providers/fmp";
import type { FinraConfig } from "@/providers/finra";
import type { FinnhubConfig } from "@/providers/finnhub";
import type { FredConfig } from "@/providers/fred";
import { makeLimiter } from "@/providers/http";

const NOW = new Date("2026-07-06T00:00:00.000Z");
const CAP = 5;
const QUARTER_ENDS = ["2026-03-31", "2025-12-31", "2025-09-30", "2025-06-30", "2025-03-31"];
const CAP_MESSAGE =
  "Premium Query Parameter: 'Special Parameters : The values for 'limit' must be between 0 and 5 based on your current subscription. Please visit our subscription page to upgrade your plan at https://financialmodelingprep.com/";

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

function statementRows(count: number, period: string, field: string): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    symbol: "EXMP",
    date: period === "annual" ? `${2025 - i}-12-31` : QUARTER_ENDS[i] ?? `${2024 - i}-03-31`,
    reportedCurrency: "USD",
    [field]: 100 + i,
  }));
}

function makeCappedFmp(): { client: FmpClient; calls: URL[] } {
  const calls: URL[] = [];
  const fetchImpl: typeof fetch = (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw);
    calls.push(url);
    const endpoint = fmpEndpoint(url);
    const period = url.searchParams.get("period") ?? "annual";
    const limit = Number(url.searchParams.get("limit") ?? "0");
    if (limit > CAP) {
      return Promise.resolve(new Response(CAP_MESSAGE, { status: 402, headers: { "content-type": "text/plain" } }));
    }
    const served = Math.min(limit || CAP, CAP);
    if (endpoint === "income-statement") return Promise.resolve(jsonResponse(statementRows(served, period, "revenue")));
    if (endpoint === "balance-sheet-statement") return Promise.resolve(jsonResponse(statementRows(served, period, "totalStockholdersEquity")));
    if (endpoint === "cash-flow-statement") return Promise.resolve(jsonResponse(statementRows(served, period, "operatingCashFlow")));
    return Promise.resolve(jsonResponse({ "Error Message": "not available in plan-limit test" }, 401));
  };
  return {
    calls,
    client: createFmpClient({
      apiKey: "PLAN-LIMIT-BUNDLE-KEY",
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
        body: "not available in plan-limit test",
        fetchedAt: NOW.toISOString(),
        fromCache: false,
        stale: false,
      });
    },
  };
}

function noNetworkConfigs(): { fred: FredConfig; finnhub: FinnhubConfig; finra: FinraConfig } {
  const unavailableText: ConfigFetch = () =>
    Promise.resolve(new Response("not available in plan-limit test", { status: 404 }));
  const unavailableJson: ConfigFetch = () =>
    Promise.resolve(jsonResponse({ error: "not available in plan-limit test" }, 404));
  return {
    fred: { fetchImpl: unavailableText, retryDelaysMs: [], minRequestIntervalMs: 0 },
    finnhub: { apiKey: "TEST-KEY", fetchImpl: unavailableJson, retryDelaysMs: [] },
    finra: { fetchImpl: unavailableJson, retryDelaysMs: [], minRequestIntervalMs: 0 },
  };
}

afterEach(() => {
  resetFmpPlanLimits();
});

describe("buildDataBundle under an FMP subscription limit cap", () => {
  it("serves every statement feed within the cap and discloses the truncated depth", async () => {
    const { client, calls } = makeCappedFmp();
    const bundle = await buildDataBundle("EXMP", {
      now: () => NOW,
      eodYears: 0,
      fmp: client,
      edgar: createEdgarClient({ transport: noNetworkEdgar() }),
      ...noNetworkConfigs(),
    });

    const statements = bundle.statements;
    for (const feed of [statements.incomeAnnual, statements.balanceAnnual, statements.cashflowAnnual]) {
      expect(feed.ok).toBe(true);
      if (!feed.ok) continue;
      expect(feed.value.data.rows).toHaveLength(CAP);
      expect(feed.value.data.planLimit).toEqual({ requested: 10, applied: CAP });
      expect(feed.value.endpoint).toContain(`limit=${CAP}`);
    }
    for (const feed of [statements.incomeQuarterly, statements.balanceQuarterly, statements.cashflowQuarterly]) {
      expect(feed.ok).toBe(true);
      if (!feed.ok) continue;
      expect(feed.value.data.planLimit).toEqual({ requested: 24, applied: CAP });
    }

    // Every capped feed is disclosed once, as an expected info entry that
    // names the served depth, so a reader knows why history is short.
    const disclosures = bundle.gaps.filter((gap) => gap.field.startsWith("fmp.planLimit("));
    expect(disclosures.map((gap) => gap.field).sort()).toEqual([
      "fmp.planLimit(statements.balanceAnnual)",
      "fmp.planLimit(statements.balanceQuarterly)",
      "fmp.planLimit(statements.cashflowAnnual)",
      "fmp.planLimit(statements.cashflowQuarterly)",
      "fmp.planLimit(statements.incomeAnnual)",
      "fmp.planLimit(statements.incomeQuarterly)",
    ]);
    for (const gap of disclosures) {
      expect(gap.severity).toBe("info");
      expect(gap.expected).toBe(true);
      expect(gap.reason).toMatch(/caps 'limit' at 5; served 5 of (10|24) requested periods/);
    }

    // The cap is learned once per key: at most one refused request per feed,
    // and the rest of the run is clamped up front.
    const refused = calls.filter((url) => Number(url.searchParams.get("limit") ?? "0") > CAP);
    expect(refused.length).toBeLessThanOrEqual(6);
    const statementCalls = calls.filter((url) =>
      ["income-statement", "balance-sheet-statement", "cash-flow-statement"].includes(fmpEndpoint(url)),
    );
    expect(statementCalls.filter((url) => url.searchParams.get("limit") === String(CAP))).toHaveLength(6);
  });
});
