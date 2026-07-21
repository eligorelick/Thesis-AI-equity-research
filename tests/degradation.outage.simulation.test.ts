/**
 * Mid-pipeline outage simulation (Phase 4 gate, the application contract §10):
 *
 *   "simulated outage → graceful degradation"
 *
 * These model a provider that WORKS on its first call(s) and then goes down
 * partway through the run, and assert that buildDataBundle still returns a
 * COHERENT PARTIAL bundle: the data fetched before the outage is intact, every
 * post-outage failure is a DISCLOSED gap, nothing is fabricated, and the whole
 * thing never throws.
 *
 * Two independent seams are exercised:
 *   1. FMP goes down after its first successful call (profile is fetched first
 *      and deterministically, before the concurrent fan-out — so "first call
 *      succeeds, the rest fail" is reproducible).
 *   2. EDGAR resolves CIK + submissions, then the filing-document fetches fail
 *      (a mid-flow SEC outage) — CIK/submissions survive, section extraction
 *      degrades to disclosed gaps.
 *
 * NO network, NO 'any', deterministic clock. FMP error bodies use HTTP 401 so
 * http.ts treats them as non-retriable (fast, no backoff sleeps).
 */

import { describe, expect, it } from "vitest";

import { buildDataBundle } from "@/pipeline/dataBundle";
import { runStageB } from "@/pipeline/compute";
import { validateBundle } from "@/pipeline/stageA/validate";
import { assembleContextPayload } from "@/pipeline/stageC/payload";
import {
  createEdgarClient,
  type EdgarTransport,
  type EdgarTransportResponse,
} from "@/providers/edgar";
import { createFmpClient, type FmpClient } from "@/providers/fmp";
import { makeLimiter } from "@/providers/http";
import type { FredConfig } from "@/providers/fred";
import type { FinnhubConfig } from "@/providers/finnhub";
import type { FinraConfig } from "@/providers/finra";
import type { DataBundle } from "@/pipeline/types";
import type { FetchResult } from "@/types/core";

/* ------------------------------------------------------------------------ *
 * Deterministic clock + fast limiter
 * ------------------------------------------------------------------------ */

const NOW = new Date("2026-07-06T00:00:00.000Z");
const now = (): Date => NOW;
const fastLimiter = makeLimiter(1_000_000, 1_000_000);

/* ------------------------------------------------------------------------ *
 * Response builders
 * ------------------------------------------------------------------------ */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
/** 401 FMP "Error Message" body → non-retriable → fast gap. */
function fmpErrorResponse(message: string): Response {
  return jsonResponse({ "Error Message": message }, 401);
}
function fmpEndpoint(url: URL): string {
  const m = /\/stable\/(.+)$/.exec(url.pathname);
  return m ? m[1] : url.pathname;
}

/* ------------------------------------------------------------------------ *
 * FMP client that succeeds for the FIRST call, then goes down
 * ------------------------------------------------------------------------ */

interface OutageFmp {
  client: FmpClient;
  /** How many FMP HTTP calls were made in total. */
  callCount(): number;
}

/**
 * A real FmpClient whose transport succeeds for the first `okCalls` requests
 * (returning a valid profile for the profile endpoint, benign empty arrays for
 * others), then returns an FMP error for every subsequent request — simulating
 * a provider that drops mid-run. `profile` is the bundle's first, sequential FMP
 * call, so it is deterministically inside the ok window.
 */
function makeMidOutageFmp(okCalls: number): OutageFmp {
  let calls = 0;
  const router = (url: URL): Response => {
    calls += 1;
    const ep = fmpEndpoint(url);
    if (calls > okCalls) {
      return fmpErrorResponse(`FMP went down mid-run (call #${calls})`);
    }
    if (ep === "profile") {
      return jsonResponse([
        { symbol: "AAPL", companyName: "Apple Inc.", sector: "Technology", currency: "USD", country: "US", cik: "0000320193" },
      ]);
    }
    return jsonResponse([]);
  };
  const fetchImpl: typeof fetch = (input) =>
    Promise.resolve(router(new URL(typeof input === "string" ? input : input.toString())));
  const client = createFmpClient({ apiKey: "TEST-KEY", limiter: fastLimiter, fetchImpl, now, timeoutMs: 5_000 });
  return { client, callCount: () => calls };
}

/* ------------------------------------------------------------------------ *
 * EDGAR transport that resolves CIK + submissions, then drops
 * ------------------------------------------------------------------------ */

function edgarResponse(status: number, body: string): EdgarTransportResponse {
  return { status, body, fetchedAt: NOW.toISOString(), fromCache: false, stale: false };
}

const COMPANY_TICKERS = JSON.stringify({
  "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
});

const SUBMISSIONS = JSON.stringify({
  cik: "0000320193",
  name: "Apple Inc.",
  sic: "3571",
  sicDescription: "Electronic Computers",
  fiscalYearEnd: "0927",
  stateOfIncorporation: "CA",
  tickers: ["AAPL"],
  exchanges: ["Nasdaq"],
  filings: {
    recent: {
      accessionNumber: ["0000320193-25-000079"],
      filingDate: ["2025-10-31"],
      reportDate: ["2025-09-27"],
      form: ["10-K"],
      primaryDocument: ["aapl-20250927.htm"],
      primaryDocDescription: ["10-K"],
      isInlineXBRL: [1],
      items: [""],
      acceptanceDateTime: ["2025-10-31T18:01:00.000Z"],
    },
    files: [],
  },
});

/**
 * EDGAR transport that serves company_tickers.json + submissions successfully,
 * then fails (404) for the filing-document fetch and companyfacts — a mid-flow
 * SEC outage. CIK + latest 10-K row survive; Item 1A / MD&A / XBRL degrade to
 * disclosed gaps.
 */
function makeMidOutageEdgarTransport(): EdgarTransport {
  return {
    fetchText: (url: string): Promise<EdgarTransportResponse> => {
      if (url.includes("company_tickers.json")) return Promise.resolve(edgarResponse(200, COMPANY_TICKERS));
      if (url.includes("/submissions/")) return Promise.resolve(edgarResponse(200, SUBMISSIONS));
      // Everything else (filing docs, companyfacts, index-headers) is DOWN.
      return Promise.resolve(edgarResponse(404, "not found"));
    },
  };
}

/* ------------------------------------------------------------------------ *
 * Keyless / benign provider stubs for the non-focus providers
 * ------------------------------------------------------------------------ */

type ConfigFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function fredUp(): FredConfig {
  const fetchImpl: ConfigFetch = (input) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const id = url.searchParams.get("id") ?? "SERIES";
    return Promise.resolve(new Response(`observation_date,${id}\n2026-06-01,4.5\n`, { status: 200 }));
  };
  return { fetchImpl, retryDelaysMs: [], minRequestIntervalMs: 0 };
}
function finnhubNoKey(): FinnhubConfig {
  return { retryDelaysMs: [] };
}
function finraDown(): FinraConfig {
  const fetchImpl: ConfigFetch = () => Promise.resolve(jsonResponse({ error: "down" }, 500));
  return { fetchImpl, retryDelaysMs: [], minRequestIntervalMs: 0 };
}

/* ------------------------------------------------------------------------ *
 * Coherence helpers
 * ------------------------------------------------------------------------ */

/** Flatten every top-level FetchResult member of the bundle for ok/gap tallying. */
function topLevelResults(bundle: DataBundle): FetchResult<unknown>[] {
  return [
    bundle.profile,
    bundle.quote,
    bundle.statements.incomeAnnual,
    bundle.statements.balanceAnnual,
    bundle.statements.cashflowAnnual,
    bundle.keyMetricsTtm,
    bundle.ratiosTtm,
    bundle.analystEstimates,
    bundle.priceTargetConsensus,
    bundle.gradesConsensus,
    bundle.eodPrices,
    bundle.treasury,
    bundle.marketRiskPremium,
    bundle.shortInterest,
    bundle.insiderSentiment,
    bundle.edgar.cik,
    bundle.edgar.item1a,
    bundle.edgar.companyFacts,
  ];
}

/** Every failed FetchResult's gap must carry a non-empty reason (disclosure). */
function everyGapDisclosed(results: FetchResult<unknown>[]): boolean {
  return results.every((r) => r.ok || (r.gap.reason.length > 0 && r.gap.field.length > 0));
}

/* ------------------------------------------------------------------------ *
 * 1. FMP goes down after its first successful call
 * ------------------------------------------------------------------------ */

describe("mid-pipeline outage: FMP drops after the first call", () => {
  it("returns a coherent partial bundle — profile survives, later calls are disclosed gaps, no throw", async () => {
    const fmp = makeMidOutageFmp(1); // only the first FMP call (profile) succeeds
    const bundle = await buildDataBundle("AAPL", {
      now,
      eodYears: 1,
      fmp: fmp.client,
      edgar: createEdgarClient({ transport: makeMidOutageEdgarTransport() }),
      fred: fredUp(),
      finra: finraDown(),
      finnhub: finnhubNoKey(),
    });

    // No throw → we reached here with a bundle.
    expect(bundle.symbol).toBe("AAPL");

    // The pre-outage datum (profile) is intact and coherent.
    expect(bundle.profile.ok).toBe(true);
    if (bundle.profile.ok) {
      expect(bundle.profile.value.data.rows[0]?.companyName).toBe("Apple Inc.");
    }

    // Post-outage FMP members are gaps (disclosed), not fabricated data.
    expect(bundle.quote.ok).toBe(false);
    expect(bundle.statements.incomeAnnual.ok).toBe(false);
    expect(bundle.analystEstimates.ok).toBe(false);
    expect(bundle.eodPrices.ok).toBe(false);

    // Coherence: a mix of ok + gap members, EVERY gap disclosed with a reason.
    const results = topLevelResults(bundle);
    const okCount = results.filter((r) => r.ok).length;
    const gapCount = results.filter((r) => !r.ok).length;
    expect(okCount).toBeGreaterThan(0); // something survived (profile, FRED-macro-adjacent, etc.)
    expect(gapCount).toBeGreaterThan(0); // the outage produced disclosed gaps
    expect(okCount + gapCount).toBe(results.length); // no member is undefined/half-built
    expect(everyGapDisclosed(results)).toBe(true);

    // More than one FMP call was attempted (the outage happened mid-run, not at call 0).
    expect(fmp.callCount()).toBeGreaterThan(1);

    // Manifest is deterministically ordered and enumerates the FMP outage gaps.
    expect(bundle.gaps.length).toBeGreaterThan(0);
    expect(bundle.gaps.some((g) => g.field.startsWith("fmp."))).toBe(true);
  });

  it("downstream compute + validation + payload survive the partial bundle without fabricating", async () => {
    const bundle = await buildDataBundle("AAPL", {
      now,
      eodYears: 1,
      fmp: makeMidOutageFmp(1).client,
      edgar: createEdgarClient({ transport: makeMidOutageEdgarTransport() }),
      fred: fredUp(),
      finra: finraDown(),
      finnhub: finnhubNoKey(),
    });

    const computed = runStageB(bundle);
    const validation = validateBundle(bundle, { now: NOW });
    const payload = assembleContextPayload(bundle, computed, validation);

    // Sector route still resolved from the surviving profile.
    expect(computed.route.evidence.sector).toBe("Technology");
    // No statements → growth degrades to DISCLOSED NULLS, never fabricated CAGRs.
    // The CAGR windows still exist as structural placeholders, but every value is
    // null (a disclosed absence) — not one invented number.
    expect(computed.growth.revenueCagrs.every((c) => c.cagrPct === null)).toBe(true);
    expect(computed.growth.revenueCagrs.every((c) => c.endDate === null)).toBe(true);
    expect(computed.gaps.length).toBeGreaterThan(0);
    // Payload discloses the outage gaps and renders absent figures as null.
    expect(payload.missingData.length).toBeGreaterThan(0);
    expect(payload.quote.figures.every((f) => f.value === null)).toBe(true);
    // Company name survived into the payload from the pre-outage profile.
    expect(payload.companyName).toBe("Apple Inc.");
  });

  it("outage window can be widened — first three FMP calls succeed, the rest degrade", async () => {
    const fmp = makeMidOutageFmp(3);
    const bundle = await buildDataBundle("AAPL", {
      now,
      eodYears: 1,
      fmp: fmp.client,
      edgar: createEdgarClient({ transport: makeMidOutageEdgarTransport() }),
      fred: fredUp(),
      finra: finraDown(),
      finnhub: finnhubNoKey(),
    });
    // Profile (call #1) is inside the window and survives.
    expect(bundle.profile.ok).toBe(true);
    // Still a coherent partial bundle with disclosed gaps and no throw.
    const results = topLevelResults(bundle);
    expect(everyGapDisclosed(results)).toBe(true);
    expect(results.some((r) => !r.ok)).toBe(true);
    expect(fmp.callCount()).toBeGreaterThan(3);
  });
});

/* ------------------------------------------------------------------------ *
 * 2. EDGAR drops after CIK + submissions resolve
 * ------------------------------------------------------------------------ */

describe("mid-pipeline outage: EDGAR drops after CIK + submissions", () => {
  it("keeps CIK + latest 10-K row, degrades Item 1A / MD&A / XBRL to disclosed gaps", async () => {
    // FMP fully up here so profile/statements do not add noise; EDGAR is the focus.
    const fmp = makeMidOutageFmp(9999); // never trips → FMP stays up
    const bundle = await buildDataBundle("AAPL", {
      now,
      eodYears: 1,
      fmp: fmp.client,
      edgar: createEdgarClient({ transport: makeMidOutageEdgarTransport() }),
      fred: fredUp(),
      finra: finraDown(),
      finnhub: finnhubNoKey(),
    });

    // CIK resolved (company_tickers.json served before the outage).
    expect(bundle.edgar.cik.ok).toBe(true);
    if (bundle.edgar.cik.ok) {
      expect(bundle.edgar.cik.value.data.cik).toBe(320193);
    }
    // Submissions served → the latest 10-K filing row is present.
    expect(bundle.edgar.latestTenK.ok).toBe(true);
    if (bundle.edgar.latestTenK.ok) {
      expect(bundle.edgar.latestTenK.value.data.form).toBe("10-K");
    }

    // The filing-document fetch is down → Item 1A / MD&A are disclosed gaps,
    // and their severity is critical (10-K sections are load-bearing).
    expect(bundle.edgar.item1a.ok).toBe(false);
    expect(bundle.edgar.mdna.ok).toBe(false);
    if (!bundle.edgar.item1a.ok) {
      expect(bundle.edgar.item1a.gap.severity).toBe("critical");
      expect(bundle.edgar.item1a.gap.reason.length).toBeGreaterThan(0);
    }

    // companyfacts is down → xbrlSummary is null (no fabricated summary).
    expect(bundle.edgar.companyFacts.ok).toBe(false);
    expect(bundle.edgar.xbrlSummary).toBeNull();

    // Validation cross-check SKIPS on the missing companyfacts (never a false fail).
    const validation = validateBundle(bundle, { now: NOW });
    const xbrl = validation.checks.filter((c) => c.id.startsWith("xbrlCrossCheck"));
    expect(xbrl.length).toBeGreaterThan(0);
    expect(xbrl.every((c) => c.status !== "fail")).toBe(true);

    // Whole run stays coherent + throw-free through payload assembly.
    const computed = runStageB(bundle);
    const payload = assembleContextPayload(bundle, computed, validation);
    // No filing excerpts (disclosed absence), not fabricated text.
    expect(payload.filings.length).toBe(0);
    expect(bundle.gaps.some((g) => g.field.startsWith("edgar."))).toBe(true);
  });
});
