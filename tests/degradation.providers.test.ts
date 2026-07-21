/**
 * Provider-outage degradation tests (Phase 4 gate, the application contract §10):
 *
 *   "simulated FMP/Finnhub outage produces a gracefully degraded report with
 *    disclosed gaps — never fabricated data."
 *
 * These drive the REAL buildDataBundle with FAILING / PARTIAL provider clients
 * injected (FMP live-mode with a controlled fetchImpl, a fake EdgarTransport,
 * and FRED/Finnhub/FINRA configs with a controlled fetchImpl) and assert:
 *   - the bundle still BUILDS (no throw — SPEC §3 rule #4),
 *   - every gap is DISCLOSED in bundle.gaps (mergeManifest) at the right severity,
 *   - providers that are still up populate what they can,
 *   - downstream compute (runStageB) + validation (validateBundle) +
 *     payload assembly (assembleContextPayload) tolerate the gaps and NEVER
 *     invent a number in place of a real absence.
 *
 * NO live network: every provider is injected. NO 'any'. Deterministic clock.
 */

import { describe, expect, it } from "vitest";

import { buildDataBundle } from "@/pipeline/dataBundle";
import { runStageB } from "@/pipeline/compute";
import { validateBundle } from "@/pipeline/stageA/validate";
import { assembleContextPayload } from "@/pipeline/stageC/payload";
import { createEdgarClient, type EdgarTransport, type EdgarTransportResponse } from "@/providers/edgar";
import { createFmpClient, type FmpClient } from "@/providers/fmp";
import { makeLimiter } from "@/providers/http";
import type { FredConfig } from "@/providers/fred";
import type { FinnhubConfig } from "@/providers/finnhub";
import type { FinraConfig } from "@/providers/finra";
import type { DataBundle } from "@/pipeline/types";
import type { ManifestEntry } from "@/types/core";

/* ------------------------------------------------------------------------ *
 * Deterministic clock + shared build options
 * ------------------------------------------------------------------------ */

const NOW = new Date("2026-07-06T00:00:00.000Z");
const now = (): Date => NOW;

/** A wide-open limiter so the ~40 FMP calls never wait on the shared token bucket. */
const fastLimiter = makeLimiter(1_000_000, 1_000_000);

/* ------------------------------------------------------------------------ *
 * Fake fetch responses (typed; no 'any')
 * ------------------------------------------------------------------------ */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

/** An FMP "Error Message" body — 401 so http.ts does NOT retry (auth is deterministic). */
function fmpErrorResponse(message: string): Response {
  return jsonResponse({ "Error Message": message }, 401);
}

/* ------------------------------------------------------------------------ *
 * FMP client factories (REAL FmpClient, controlled fetchImpl → live mode)
 * ------------------------------------------------------------------------ */

type FmpRouter = (url: URL) => Response;

/**
 * Build a real FmpClient in LIVE mode (apiKey set) whose transport is a
 * synchronous router over the request URL. No cache, fast limiter, no retries
 * that matter (all error bodies are 401 = non-retriable).
 */
function makeFmp(router: FmpRouter): FmpClient {
  const fetchImpl: typeof fetch = (input) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    return Promise.resolve(router(url));
  };
  return createFmpClient({
    apiKey: "TEST-KEY",
    limiter: fastLimiter,
    fetchImpl,
    now,
    timeoutMs: 5_000,
  });
}

/** Every FMP endpoint errors — the provider is entirely down. */
function fmpEntirelyDown(): FmpClient {
  return makeFmp(() => fmpErrorResponse("FMP is unreachable (simulated outage)"));
}

/** The `endpoint` segment after /stable/ (e.g. "income-statement", "profile"). */
function fmpEndpoint(url: URL): string {
  const m = /\/stable\/(.+)$/.exec(url.pathname);
  return m ? m[1] : url.pathname;
}

/* ------------------------------------------------------------------------ *
 * EDGAR transport fakes (the EdgarTransport interface is a clean 1-method seam)
 * ------------------------------------------------------------------------ */

function edgarResponse(status: number, body: string): EdgarTransportResponse {
  return { status, body, fetchedAt: NOW.toISOString(), fromCache: false, stale: false };
}

/** Every EDGAR request 503s — SEC/data.sec.gov entirely down. */
function edgarDownTransport(): EdgarTransport {
  return {
    // 503 → EdgarClient.request throws EdgarHttpError; the bundle's settle() traps it as a gap.
    // Use 404 instead so we get clean per-field gaps (no throw path) — both must degrade,
    // but 404 exercises the "returned gap" branch deterministically.
    fetchText: () => Promise.resolve(edgarResponse(404, "not found")),
  };
}

/** Substring-routed EDGAR transport (unmatched URLs 404) — for scenarios needing multiple live endpoints. */
function edgarRouterTransport(routes: Record<string, { status?: number; body: string }>): EdgarTransport {
  return {
    fetchText(url): Promise<EdgarTransportResponse> {
      const hit = Object.entries(routes).find(([k]) => url.includes(k));
      if (hit === undefined) return Promise.resolve(edgarResponse(404, "not found"));
      return Promise.resolve(edgarResponse(hit[1].status ?? 200, hit[1].body));
    },
  };
}

/** company_tickers.json body with a single ticker->CIK entry. */
function tickerMapBody(symbol: string, cik: number, title: string): string {
  return JSON.stringify({ "0": { cik_str: cik, ticker: symbol, title } });
}

/* ------------------------------------------------------------------------ *
 * FRED / Finnhub / FINRA config factories (controlled fetchImpl)
 * ------------------------------------------------------------------------ */

type ConfigFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** FRED down: every fredgraph.csv / API request 500s (transient → retried, then gap). */
function fredDown(): FredConfig {
  const fetchImpl: ConfigFetch = () => Promise.resolve(textResponse("upstream error", 500));
  return { fetchImpl, retryDelaysMs: [], minRequestIntervalMs: 0 };
}

/** FRED up (keyless CSV): returns a minimal valid observation series for any id. */
function fredUp(): FredConfig {
  const fetchImpl: ConfigFetch = (input) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const id = url.searchParams.get("id") ?? "SERIES";
    const csv = `observation_date,${id}\n2026-05-01,4.4\n2026-06-01,4.5\n`;
    return Promise.resolve(textResponse(csv, 200));
  };
  return { fetchImpl, retryDelaysMs: [], minRequestIntervalMs: 0 };
}

/** Finnhub with no key → every call returns a gap without touching the network. */
function finnhubNoKey(): FinnhubConfig {
  const fetchImpl: ConfigFetch = () =>
    Promise.reject(new Error("finnhub fetch must not be called without a key"));
  return { fetchImpl, retryDelaysMs: [] };
}

/** Finnhub keyed but the endpoint 500s (transient) → disclosed gap. */
function finnhubDown(): FinnhubConfig {
  const fetchImpl: ConfigFetch = () => Promise.resolve(jsonResponse({ error: "down" }, 500));
  return { apiKey: "FH-KEY", fetchImpl, retryDelaysMs: [], maxRequestsPerMinute: 0 };
}

/** FINRA down: partitions GET 500s → short interest becomes a disclosed gap. */
function finraDown(): FinraConfig {
  const fetchImpl: ConfigFetch = () => Promise.resolve(jsonResponse({ error: "down" }, 500));
  return { fetchImpl, retryDelaysMs: [], minRequestIntervalMs: 0 };
}

/** FINRA up: partitions + data POST both return valid shapes. */
function finraUp(): FinraConfig {
  const fetchImpl: ConfigFetch = (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/partitions/")) {
      return Promise.resolve(
        jsonResponse({ availablePartitions: [{ partitions: ["2026-06-15", "2026-06-30"] }] }),
      );
    }
    // data POST
    void init;
    return Promise.resolve(
      jsonResponse([
        {
          symbolCode: "AAPL",
          issueName: "APPLE INC",
          settlementDate: "2026-06-30",
          currentShortPositionQuantity: 100_000_000,
          previousShortPositionQuantity: 95_000_000,
          changePreviousNumber: 5_000_000,
          changePercent: 5.3,
          averageDailyVolumeQuantity: 50_000_000,
          daysToCoverQuantity: 2,
          marketClassCode: "NNM",
        },
      ]),
    );
  };
  return { fetchImpl, retryDelaysMs: [], minRequestIntervalMs: 0 };
}

/* ------------------------------------------------------------------------ *
 * Small assertion helpers over bundle.gaps
 * ------------------------------------------------------------------------ */

function gapFields(bundle: DataBundle): string[] {
  return bundle.gaps.map((g) => g.field);
}

function findGap(bundle: DataBundle, field: string): ManifestEntry | undefined {
  return bundle.gaps.find((g) => g.field === field);
}

function hasGapMatching(bundle: DataBundle, re: RegExp): boolean {
  return bundle.gaps.some((g) => re.test(g.field));
}

/** True when a FetchResult member is an "ok" (populated) result. */
function isOk(res: { ok: boolean }): boolean {
  return res.ok;
}

/* ------------------------------------------------------------------------ *
 * Scenario 1 — FMP entirely down (EDGAR/FINRA/FRED still up)
 * ------------------------------------------------------------------------ */

describe("degradation: FMP entirely down", () => {
  it("builds a bundle, enumerates every FMP-sourced gap, keeps other providers, invents nothing", async () => {
    const bundle = await buildDataBundle("AAPL", {
      now,
      eodYears: 1,
      fmp: fmpEntirelyDown(),
      edgar: createEdgarClient({ transport: edgarDownTransport() }),
      fred: fredUp(),
      finra: finraUp(),
      finnhub: finnhubNoKey(),
    });

    // No throw is proven by reaching here; the bundle exists.
    expect(bundle.symbol).toBe("AAPL");
    expect(Array.isArray(bundle.gaps)).toBe(true);

    // Every FMP-sourced member is a gap (disclosed), not fabricated data.
    expect(bundle.profile.ok).toBe(false);
    expect(bundle.quote.ok).toBe(false);
    expect(bundle.statements.incomeAnnual.ok).toBe(false);
    expect(bundle.statements.balanceAnnual.ok).toBe(false);
    expect(bundle.statements.cashflowAnnual.ok).toBe(false);
    expect(bundle.keyMetricsTtm.ok).toBe(false);
    expect(bundle.ratiosTtm.ok).toBe(false);
    expect(bundle.analystEstimates.ok).toBe(false);
    expect(bundle.priceTargetConsensus.ok).toBe(false);
    expect(bundle.gradesConsensus.ok).toBe(false);
    expect(bundle.eodPrices.ok).toBe(false);
    expect(bundle.treasury.ok).toBe(false);
    expect(bundle.marketRiskPremium.ok).toBe(false);
    expect(bundle.transcript.meta.ok).toBe(false);
    expect(bundle.transcript.latest.ok).toBe(false);

    // The manifest enumerates the FMP-sourced fields explicitly.
    const fields = gapFields(bundle);
    for (const f of [
      "fmp.profile(AAPL)",
      "fmp.quote(AAPL)",
      "fmp.incomeStatement(AAPL,annual)",
      "fmp.balanceSheet(AAPL,annual)",
      "fmp.cashFlow(AAPL,annual)",
      "fmp.analystEstimates(AAPL,annual)",
      "fmp.gradesConsensus(AAPL)",
      "fmp.historicalPriceEodFull(AAPL)",
      "fmp.treasuryRates",
      "fmp.marketRiskPremium",
    ]) {
      expect(fields).toContain(f);
    }

    // The FMP-down gaps carry the simulated-outage reason (disclosed, not silent).
    const profileGap = findGap(bundle, "fmp.profile(AAPL)");
    expect(profileGap).toBeDefined();
    expect(profileGap?.reason).toMatch(/FMP|simulated outage|HTTP 401/i);

    // FRED is still up → macro core series populated (NOT gaps).
    const macroCore = Object.values(bundle.macro.core);
    expect(macroCore.length).toBeGreaterThan(0);
    expect(macroCore.some(isOk)).toBe(true);

    // FINRA is still up → short interest populated with a REAL settlement date.
    expect(bundle.shortInterest.ok).toBe(true);
    if (bundle.shortInterest.ok) {
      expect(bundle.shortInterest.value.data.settlementDate).toBe("2026-06-30");
    }

    // Nothing fabricated: no FMP member carries invented numeric rows.
    expect(bundle.profile.ok).toBe(false);
    // A gap has no `value`, so there is no place for an invented number to hide.
    expect(profileGap && "value" in (profileGap as object)).toBeFalsy();
  });

  it("downstream compute + validation + payload tolerate a fully FMP-degraded bundle", async () => {
    const bundle = await buildDataBundle("AAPL", {
      now,
      eodYears: 1,
      fmp: fmpEntirelyDown(),
      edgar: createEdgarClient({ transport: edgarDownTransport() }),
      fred: fredUp(),
      finra: finraUp(),
      finnhub: finnhubNoKey(),
    });

    // runStageB must not throw and must surface gaps rather than fabricated metrics.
    const computed = runStageB(bundle);
    expect(computed.symbol).toBe("AAPL");
    expect(Array.isArray(computed.gaps)).toBe(true);
    expect(computed.gaps.length).toBeGreaterThan(0);

    const validation = validateBundle(bundle, { now: NOW });
    // With no FMP statements + no companyfacts, the identity + XBRL checks skip, never fail-crash.
    expect(validation.checks.some((c) => c.status === "skipped")).toBe(true);
    // Every check has a well-formed status (validation degraded, it did not throw/half-build).
    expect(validation.checks.every((c) => ["pass", "fail", "skipped"].includes(c.status))).toBe(true);

    // Payload assembly is pure + total: it renders without throwing and discloses gaps.
    const payload = assembleContextPayload(bundle, computed, validation);
    expect(payload.symbol).toBe("AAPL");
    expect(payload.missingData.length).toBeGreaterThan(0);
    // The quote section renders each absent figure as a disclosed null, not a fake number.
    expect(payload.quote.figures.every((f) => f.value === null)).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * Scenario 2 — Finnhub down (insider sentiment) — single disclosed gap
 * ------------------------------------------------------------------------ */

describe("degradation: Finnhub insider sentiment down", () => {
  it("files a single disclosed insiderSentiment gap while FMP/EDGAR/FRED/FINRA stay intact", async () => {
    const bundle = await buildDataBundle("AAPL", {
      now,
      eodYears: 1,
      // FMP up enough to not add noise: return empty arrays (info gaps) for everything
      // except keep it distinct — we only assert on the Finnhub gap here.
      fmp: makeFmp((url) => {
        // A live "empty array" body is a benign info gap; keeps FMP from dominating the manifest.
        void fmpEndpoint(url);
        return jsonResponse([]);
      }),
      edgar: createEdgarClient({ transport: edgarDownTransport() }),
      fred: fredUp(),
      finra: finraUp(),
      finnhub: finnhubDown(),
    });

    expect(bundle.insiderSentiment.ok).toBe(false);
    // Exactly one Finnhub gap, sourced to finnhub, disclosed in the manifest.
    const finnhubGaps = bundle.gaps.filter((g) => (g.attemptedSources ?? []).includes("finnhub"));
    expect(finnhubGaps.length).toBe(1);
    expect(finnhubGaps[0].field).toMatch(/insiderSentiment/i);

    // FINRA short interest is unaffected by the Finnhub outage.
    expect(bundle.shortInterest.ok).toBe(true);
    // FRED macro still populated.
    expect(Object.values(bundle.macro.core).some(isOk)).toBe(true);
  });

  it("no Finnhub key → insider sentiment is a disclosed gap, never a fabricated series", async () => {
    const bundle = await buildDataBundle("AAPL", {
      now,
      eodYears: 1,
      fmp: makeFmp(() => jsonResponse([])),
      edgar: createEdgarClient({ transport: edgarDownTransport() }),
      fred: fredUp(),
      finra: finraUp(),
      finnhub: finnhubNoKey(),
    });
    expect(bundle.insiderSentiment.ok).toBe(false);
    if (!bundle.insiderSentiment.ok) {
      expect(bundle.insiderSentiment.gap.reason).toMatch(/key missing/i);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * Scenario 3 — EDGAR down (filings/XBRL) — cross-check 'skipped', no crash
 * ------------------------------------------------------------------------ */

describe("degradation: EDGAR down (filings + companyfacts)", () => {
  it("makes item1a/mdna/xbrl gaps and the XBRL cross-check reports 'skipped' (not fail)", async () => {
    const bundle = await buildDataBundle("AAPL", {
      now,
      eodYears: 1,
      // FMP up with a valid profile (so a CIK exists) but EDGAR itself is down.
      fmp: makeFmp((url) => {
        if (fmpEndpoint(url) === "profile") {
          return jsonResponse([
            { symbol: "AAPL", companyName: "Apple Inc.", sector: "Technology", cik: "0000320193", currency: "USD", country: "US" },
          ]);
        }
        return jsonResponse([]);
      }),
      edgar: createEdgarClient({ transport: edgarDownTransport() }),
      fred: fredUp(),
      finra: finraUp(),
      finnhub: finnhubNoKey(),
    });

    // EDGAR-derived members are gaps.
    expect(bundle.edgar.item1a.ok).toBe(false);
    expect(bundle.edgar.mdna.ok).toBe(false);
    expect(bundle.edgar.companyFacts.ok).toBe(false);
    expect(bundle.edgar.xbrlSummary).toBeNull();

    // item1a / mdna are the critical-severity gaps EDGAR outage produces.
    const item1aGap = findGap(bundle, "edgar.item1a(AAPL)");
    expect(item1aGap?.severity).toBe("critical");

    // Validation's XBRL cross-check is SKIPPED (companyfacts unavailable), never a false 'fail'.
    const validation = validateBundle(bundle, { now: NOW });
    const xbrlChecks = validation.checks.filter((c) => c.id.startsWith("xbrlCrossCheck"));
    expect(xbrlChecks.length).toBeGreaterThan(0);
    expect(xbrlChecks.every((c) => c.status === "skipped")).toBe(true);
    expect(xbrlChecks.some((c) => c.status === "fail")).toBe(false);

    // The whole pipeline still runs without a crash.
    const computed = runStageB(bundle);
    const payload = assembleContextPayload(bundle, computed, validation);
    expect(payload.filings.length).toBe(0); // no filings excerpts — disclosed absence, not fake text
    expect(hasGapMatching(bundle, /^edgar\./)).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * Scenario 4 — FRED down — macro gaps, report macro section degrades
 * ------------------------------------------------------------------------ */

describe("degradation: FRED down", () => {
  it("turns every macro series into a disclosed gap while other providers stay up", async () => {
    const bundle = await buildDataBundle("AAPL", {
      now,
      eodYears: 1,
      fmp: makeFmp((url) => {
        if (fmpEndpoint(url) === "profile") {
          return jsonResponse([{ symbol: "AAPL", companyName: "Apple Inc.", sector: "Technology", currency: "USD" }]);
        }
        return jsonResponse([]);
      }),
      edgar: createEdgarClient({ transport: edgarDownTransport() }),
      fred: fredDown(),
      finra: finraUp(),
      finnhub: finnhubNoKey(),
    });

    // Every core macro series is a gap (FRED is down).
    const coreResults = Object.values(bundle.macro.core);
    expect(coreResults.length).toBeGreaterThan(0);
    expect(coreResults.every((r) => !r.ok)).toBe(true);

    // The macro gaps are enumerated in the manifest, sourced to fred.
    const fredGaps = bundle.gaps.filter((g) => (g.attemptedSources ?? []).includes("fred"));
    expect(fredGaps.length).toBeGreaterThan(0);
    expect(fredGaps.every((g) => g.field.startsWith("macro."))).toBe(true);

    // The macro section of the payload degrades to zero figures (disclosed), not fabricated values.
    const computed = runStageB(bundle);
    const validation = validateBundle(bundle, { now: NOW });
    const payload = assembleContextPayload(bundle, computed, validation);
    expect(payload.macro.figures.length).toBe(0);
    // FRED attribution note is still present (rendered verbatim even when degraded).
    expect(payload.macro.notes.join(" ")).toContain("FRED");
  });
});

/* ------------------------------------------------------------------------ *
 * Scenario 5 — Partial FMP: statements present, estimates/transcripts missing
 * ------------------------------------------------------------------------ */

describe("degradation: partial FMP (statements up, estimates/transcripts down)", () => {
  /** Statements + profile + quote succeed; estimates/targets/transcripts error. */
  function partialFmp(): FmpClient {
    const income = [
      { date: "2025-09-27", fiscalYear: "2025", period: "FY", revenue: 416161000000, grossProfit: 190000000000, operatingIncome: 127000000000, ebit: 127000000000, netIncome: 112010000000, epsDiluted: 7.1, weightedAverageShsOutDil: 15100000000, interestExpense: 3900000000, incomeBeforeTax: 130000000000, incomeTaxExpense: 18000000000, depreciationAndAmortization: 11500000000, reportedCurrency: "USD" },
      { date: "2024-09-28", fiscalYear: "2024", period: "FY", revenue: 391035000000, grossProfit: 180683000000, operatingIncome: 123216000000, ebit: 123216000000, netIncome: 93736000000, epsDiluted: 6.08, weightedAverageShsOutDil: 15400000000, interestExpense: 3800000000, incomeBeforeTax: 123485000000, incomeTaxExpense: 29749000000, depreciationAndAmortization: 11445000000, reportedCurrency: "USD" },
    ];
    const balance = [
      { date: "2025-09-27", totalAssets: 365000000000, totalLiabilities: 300000000000, totalStockholdersEquity: 65000000000, totalEquity: 65000000000, totalDebt: 100000000000, netDebt: 70000000000, cashAndShortTermInvestments: 55000000000 },
      { date: "2024-09-28", totalAssets: 364980000000, totalLiabilities: 308030000000, totalStockholdersEquity: 56950000000, totalEquity: 56950000000, totalDebt: 106629000000, netDebt: 76686000000, cashAndShortTermInvestments: 65171000000 },
    ];
    const cashflow = [
      { date: "2025-09-27", operatingCashFlow: 118000000000, capitalExpenditure: -11000000000, freeCashFlow: 107000000000, stockBasedCompensation: 12000000000, netIncome: 112010000000, depreciationAndAmortization: 11500000000 },
      { date: "2024-09-28", operatingCashFlow: 118254000000, capitalExpenditure: -9447000000, freeCashFlow: 108807000000, stockBasedCompensation: 11688000000, netIncome: 93736000000, depreciationAndAmortization: 11445000000 },
    ];
    return makeFmp((url) => {
      const ep = fmpEndpoint(url);
      if (ep === "profile") {
        return jsonResponse([{ symbol: "AAPL", companyName: "Apple Inc.", sector: "Technology", currency: "USD", country: "US" }]);
      }
      if (ep === "quote") {
        return jsonResponse([{ symbol: "AAPL", price: 210, marketCap: 3150000000000, dayLow: 208, dayHigh: 212, yearLow: 164, yearHigh: 260, volume: 44000000 }]);
      }
      if (ep === "income-statement") return jsonResponse(income);
      if (ep === "balance-sheet-statement") return jsonResponse(balance);
      if (ep === "cash-flow-statement") return jsonResponse(cashflow);
      // Everything analyst/estimate/transcript-shaped is DOWN.
      if (ep === "analyst-estimates" || ep === "price-target-consensus" || ep === "price-target-summary") {
        return fmpErrorResponse("estimates endpoint down (simulated)");
      }
      if (ep === "earning-call-transcript-dates" || ep === "earning-call-transcript") {
        return fmpErrorResponse("transcript endpoint down (simulated)");
      }
      // Remaining endpoints: benign empty arrays (info gaps).
      return jsonResponse([]);
    });
  }

  it("keeps valuation/outlook inputs from statements while disclosing the estimate/transcript gaps", async () => {
    const bundle = await buildDataBundle("AAPL", {
      now,
      eodYears: 1,
      fmp: partialFmp(),
      edgar: createEdgarClient({ transport: edgarDownTransport() }),
      fred: fredUp(),
      finra: finraUp(),
      finnhub: finnhubNoKey(),
    });

    // Statements populated → downstream valuation has real fundamentals to work with.
    expect(bundle.statements.incomeAnnual.ok).toBe(true);
    expect(bundle.statements.balanceAnnual.ok).toBe(true);
    expect(bundle.statements.cashflowAnnual.ok).toBe(true);

    // The specific degraded inputs are disclosed gaps.
    expect(bundle.analystEstimates.ok).toBe(false);
    expect(bundle.priceTargetConsensus.ok).toBe(false);
    expect(bundle.transcript.latest.ok).toBe(false);

    const fields = gapFields(bundle);
    expect(fields).toContain("fmp.analystEstimates(AAPL,annual)");
    expect(fields).toContain("fmp.priceTargetConsensus(AAPL)");
    // Transcript dates failing cascades into a derived transcript gap (info severity).
    expect(fields.some((f) => /transcript/i.test(f))).toBe(true);

    // Compute runs on the real statements: growth CAGRs / valuation produce real numbers, not gaps for statements.
    const computed = runStageB(bundle);
    expect(computed.growth.revenueCagrs.length).toBeGreaterThan(0);
    // The revenue CAGR endDate traces to the FY2025 statement — a real, sourced number.
    const cagr = computed.growth.revenueCagrs[0];
    expect(cagr.endDate).toBe("2025-09-27");

    // Payload: estimates section discloses missing estimates rather than inventing them.
    const validation = validateBundle(bundle, { now: NOW });
    const payload = assembleContextPayload(bundle, computed, validation);
    // No fabricated price-target figure snuck in (estimates section has no consensus figure).
    const hasConsensus = payload.estimates.figures.some((f) => f.label === "price target consensus");
    expect(hasConsensus).toBe(false);
    // But statement-derived numbers ARE present (income statement extract block exists).
    expect(payload.statements.some((b) => b.title.includes("Income statement"))).toBe(true);
  });

  it("marks empty segmentation results as EXPECTED structural gaps (not incidents)", async () => {
    const bundle = await buildDataBundle("AAPL", {
      now,
      eodYears: 1,
      fmp: partialFmp(), // segmentation endpoints return empty arrays
      edgar: createEdgarClient({ transport: edgarDownTransport() }),
      fred: fredUp(),
      finra: finraUp(),
      finnhub: finnhubNoKey(),
    });

    expect(bundle.segmentation.geographic.ok).toBe(false);
    expect(bundle.segmentation.product.ok).toBe(false);
    for (const seg of [bundle.segmentation.geographic, bundle.segmentation.product]) {
      if (!seg.ok) {
        expect(seg.gap.expected).toBe(true);
        expect(seg.gap.severity).toBe("info");
        expect(seg.gap.reason).toMatch(/does not report this revenue segmentation/);
      }
    }
    // A hard-down endpoint is NOT marked expected — that is a real incident.
    if (!bundle.analystEstimates.ok) {
      expect(bundle.analystEstimates.gap.expected).toBeUndefined();
    }
  });
});

/* ------------------------------------------------------------------------ *
 * Scenario 6 — FINRA down — short interest degrades, rest intact
 * ------------------------------------------------------------------------ */

describe("degradation: FINRA down", () => {
  it("files short-interest gaps sourced to finra while FMP/FRED stay up", async () => {
    const bundle = await buildDataBundle("AAPL", {
      now,
      eodYears: 1,
      fmp: makeFmp((url) => {
        if (fmpEndpoint(url) === "profile") {
          return jsonResponse([{ symbol: "AAPL", companyName: "Apple Inc.", sector: "Technology", currency: "USD" }]);
        }
        return jsonResponse([]);
      }),
      edgar: createEdgarClient({ transport: edgarDownTransport() }),
      fred: fredUp(),
      finra: finraDown(),
      finnhub: finnhubNoKey(),
    });

    expect(bundle.shortInterest.ok).toBe(false);
    expect(bundle.shortInterestTrend.ok).toBe(false);
    const finraGaps = bundle.gaps.filter((g) => (g.attemptedSources ?? []).includes("finra"));
    expect(finraGaps.length).toBeGreaterThan(0);
    expect(finraGaps.every((g) => /shortInterest/i.test(g.field))).toBe(true);

    // Other providers still populated their members.
    expect(bundle.profile.ok).toBe(true);
    expect(Object.values(bundle.macro.core).some(isOk)).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * Scenario 7 — foreign private issuer EDGAR coverage: Form 20-F is the
 * annual primary filing, irrespective of an FMP-derived ADR flag. Its Item
 * 3.D risk factors and Item 5 operating/financial review are extracted;
 * Form 6-K is retained as interim provenance but never guessed to contain a
 * standardized Part I Item 2 MD&A section.
 * ------------------------------------------------------------------------ */

function foreignIssuerSubmissionsBody(): string {
  return JSON.stringify({
    cik: "1046179",
    name: "Foreign Private Issuer Co",
    filings: {
      recent: {
        accessionNumber: ["0001046179-26-000010", "0001046179-26-000005"],
        filingDate: ["2026-04-15", "2026-01-10"],
        reportDate: ["2025-12-31", "2025-12-31"],
        form: ["20-F", "6-K"],
        primaryDocument: ["fpi-20251231_20f.htm", "fpi-6k.htm"],
      },
    },
  });
}

function syntheticTwentyFDoc(): string {
  const risk = "Foreign-issuer risk-factor prose about markets, operations, and regulation. ".repeat(60);
  const mdna = "Operating and financial-review prose discussing results, liquidity, and outlook. ".repeat(60);
  return [
    "<table>",
    `<tr><td><a href="#f20_3d">Item 3.D.</a></td><td><a href="#f20_3d">Risk Factors.</a></td></tr>`,
    `<tr><td><a href="#f20_4">Item 4.</a></td><td><a href="#f20_4">Information on the Company.</a></td></tr>`,
    `<tr><td><a href="#f20_5">Item 5.</a></td><td><a href="#f20_5">Operating and Financial Review and Prospects.</a></td></tr>`,
    `<tr><td><a href="#f20_6">Item 6.</a></td><td><a href="#f20_6">Directors, Senior Management and Employees.</a></td></tr>`,
    "</table>",
    `<div id="f20_3d"></div><h2>Item 3.D. Risk Factors</h2><div>${risk}</div>`,
    `<div id="f20_4"></div><h2>Item 4. Information on the Company</h2><div>${risk}</div>`,
    `<div id="f20_5"></div><h2>Item 5. Operating and Financial Review and Prospects</h2><div>${mdna}</div>`,
    `<div id="f20_6"></div><h2>Item 6. Directors, Senior Management and Employees</h2><div>${mdna}</div>`,
  ].join("\n");
}

describe("degradation: foreign-private-issuer EDGAR coverage", () => {
  it("uses a 20-F without an ADR profile flag, extracts its annual sections, and preserves a 6-K provenance gap", async () => {
    const bundle = await buildDataBundle("FPI", {
      now,
      eodYears: 1,
      fmp: makeFmp((url) => {
        if (fmpEndpoint(url) === "profile") {
          return jsonResponse([
            { symbol: "FPI", companyName: "Foreign Private Issuer Co", sector: "Technology", currency: "USD", country: "TW" },
          ]);
        }
        return jsonResponse([]);
      }),
      edgar: createEdgarClient({
        transport: edgarRouterTransport({
          "company_tickers.json": { body: tickerMapBody("FPI", 1046179, "Foreign Private Issuer Co") },
          "submissions/CIK0001046179.json": { body: foreignIssuerSubmissionsBody() },
          "fpi-20251231_20f.htm": { body: syntheticTwentyFDoc() },
        }),
      }),
      fred: fredUp(),
      finra: finraUp(),
      finnhub: finnhubNoKey(),
    });

    expect(bundle.edgar.latestTenK.ok).toBe(true);
    expect(bundle.edgar.item1a.ok).toBe(true);
    expect(bundle.edgar.mdna.ok).toBe(true);
    expect(bundle.edgar.latestTenQ.ok).toBe(true);
    expect(bundle.edgar.tenQMdna.ok).toBe(false);
    if (bundle.edgar.latestTenK.ok) expect(bundle.edgar.latestTenK.value.data.form).toBe("20-F");
    if (bundle.edgar.item1a.ok) {
      expect(bundle.edgar.item1a.value.data.form).toBe("20-F");
      expect(bundle.edgar.item1a.value.data.text).toContain("Foreign-issuer risk-factor prose");
    }
    if (bundle.edgar.mdna.ok) {
      expect(bundle.edgar.mdna.value.data.form).toBe("20-F");
      expect(bundle.edgar.mdna.value.data.text).toContain("Operating and financial-review prose");
    }
    if (bundle.edgar.latestTenQ.ok) expect(bundle.edgar.latestTenQ.value.data.form).toBe("6-K");
    if (!bundle.edgar.tenQMdna.ok) {
      expect(bundle.edgar.tenQMdna.gap.severity).toBe("info");
      expect(bundle.edgar.tenQMdna.gap.reason).toMatch(/no standardized Part I Item 2 MD&A/i);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * Scenario 8 — 10-K extraction time budget (JPM performance fix,
 * 2026-07 audit finding 1): Item 1A + Item 7 share ONE document parse,
 * and Item 7 (MD&A) is skipped with an explicit gap — never a hang — when
 * the budget is already exhausted after Item 1A.
 * ------------------------------------------------------------------------ */

function syntheticTenKDoc(): string {
  const risk = "Risk factor prose. The Company faces a variety of market and operational risks. ".repeat(80);
  const mdna = "Management's discussion prose. Results of operations improved year over year. ".repeat(80);
  return [
    "<table>",
    `<tr><td><a href="#s_1a">Item 1A.</a></td><td><a href="#s_1a">Risk Factors.</a></td></tr>`,
    `<tr><td><a href="#s_7">Item 7.</a></td><td><a href="#s_7">Management's Discussion and Analysis.</a></td></tr>`,
    "</table>",
    `<div id="s_1a"></div><div><span style="font-weight:700">Item 1A. Risk Factors.</span></div>`,
    `<div>${risk}</div>`,
    `<div id="s_7"></div><div><span style="font-weight:700">Item 7. Management&#8217;s Discussion and Analysis of Financial Condition and Results of Operations.</span></div>`,
    `<div>${mdna}</div>`,
  ].join("\n");
}

function tenKSubmissionsBody(): string {
  return JSON.stringify({
    cik: "1234567",
    name: "Synthetic Filer Inc",
    filings: {
      recent: {
        accessionNumber: ["0001234567-26-000001"],
        filingDate: ["2026-02-15"],
        reportDate: ["2025-12-31"],
        form: ["10-K"],
        primaryDocument: ["synth-10k.htm"],
      },
    },
  });
}

describe("degradation: EDGAR 10-K extraction time budget (JPM performance fix)", () => {
  it("Item 1A and Item 7 both extract successfully within the default budget (parse-once reuse)", async () => {
    const bundle = await buildDataBundle("SYNF", {
      now,
      eodYears: 1,
      fmp: makeFmp((url) => {
        if (fmpEndpoint(url) === "profile") {
          return jsonResponse([{ symbol: "SYNF", companyName: "Synthetic Filer Inc", sector: "Technology", currency: "USD" }]);
        }
        return jsonResponse([]);
      }),
      edgar: createEdgarClient({
        transport: edgarRouterTransport({
          "company_tickers.json": { body: tickerMapBody("SYNF", 1234567, "Synthetic Filer Inc") },
          "submissions/CIK0001234567.json": { body: tenKSubmissionsBody() },
          "synth-10k.htm": { body: syntheticTenKDoc() },
        }),
      }),
      fred: fredUp(),
      finra: finraUp(),
      finnhub: finnhubNoKey(),
    });

    expect(bundle.edgar.item1a.ok).toBe(true);
    expect(bundle.edgar.mdna.ok).toBe(true);
  });

  it("skips Item 7 with a disclosed, honestly-labeled gap when the section budget is exhausted", async () => {
    const bundle = await buildDataBundle("SYNF", {
      now,
      eodYears: 1,
      edgarSectionBudgetMs: -1, // any elapsed time (including 0ms) exceeds this, forcing the skip branch deterministically
      fmp: makeFmp((url) => {
        if (fmpEndpoint(url) === "profile") {
          return jsonResponse([{ symbol: "SYNF", companyName: "Synthetic Filer Inc", sector: "Technology", currency: "USD" }]);
        }
        return jsonResponse([]);
      }),
      edgar: createEdgarClient({
        transport: edgarRouterTransport({
          "company_tickers.json": { body: tickerMapBody("SYNF", 1234567, "Synthetic Filer Inc") },
          "submissions/CIK0001234567.json": { body: tenKSubmissionsBody() },
          "synth-10k.htm": { body: syntheticTenKDoc() },
        }),
      }),
      fred: fredUp(),
      finra: finraUp(),
      finnhub: finnhubNoKey(),
    });

    // Item 1A still extracts normally — only Item 7 (the second, budget-checked section) is skipped.
    expect(bundle.edgar.item1a.ok).toBe(true);
    expect(bundle.edgar.mdna.ok).toBe(false);
    if (!bundle.edgar.mdna.ok) {
      expect(bundle.edgar.mdna.gap.severity).toBe("critical");
      expect(bundle.edgar.mdna.gap.reason).toMatch(/skipped/i);
      expect(bundle.edgar.mdna.gap.reason).toMatch(/budget/i);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * Scenario 9 — weekend/holiday EOD "no new bar yet" recovery (audit H1):
 * the 5-year EOD window ends on today, and for this era chunkDateRange puts
 * the newest chunk at exactly {today, today}. On a weekend that chunk returns
 * [] because no bar is published yet. The stock, SPY, and sector-ETF series
 * share the window — all three must recover their history through the prior
 * close instead of erasing EVERY technical.
 * ------------------------------------------------------------------------ */

describe("degradation: weekend/holiday EOD run (H1 no-new-bar recovery)", () => {
  // 2026-01-05 is a Monday but the point is the chunk boundary: with a 5-year
  // window the newest chunk collapses to {2026-01-05, 2026-01-05}; simulate it
  // returning [] (no bar published for the run day yet).
  const RUN_NOW = new Date("2026-01-05T00:00:00.000Z");
  const RUN_TODAY = "2026-01-05";

  function weekendEodFmp(): FmpClient {
    return makeFmp((url) => {
      const ep = fmpEndpoint(url);
      if (ep === "profile") {
        return jsonResponse([
          { symbol: "AAPL", companyName: "Apple Inc.", sector: "Technology", currency: "USD", country: "US" },
        ]);
      }
      if (ep === "historical-price-eod/full") {
        // The newest chunk asks for to === RUN_TODAY and has no bar yet → [].
        // Every older chunk (to < RUN_TODAY) returns real bars through the
        // prior close. Symbol-agnostic, so AAPL + SPY + XLK all behave alike.
        const to = url.searchParams.get("to");
        if (to === RUN_TODAY) return jsonResponse([]);
        return jsonResponse([
          { symbol: "SYM", date: "2026-01-02", close: 100 },
          { symbol: "SYM", date: "2025-12-31", close: 99 },
          { symbol: "SYM", date: "2025-12-30", close: 98 },
        ]);
      }
      return jsonResponse([]);
    });
  }

  it("recovers stock, SPY, and sector-ETF prices through the prior close (disclosed)", async () => {
    const bundle = await buildDataBundle("AAPL", {
      now: () => RUN_NOW,
      eodYears: 5, // force the multi-chunk split that collapses the newest chunk
      fmp: weekendEodFmp(),
      edgar: createEdgarClient({ transport: edgarDownTransport() }),
      fred: fredUp(),
      finra: finraUp(),
      finnhub: finnhubNoKey(),
    });

    // Before the fix an empty {today,today} chunk refused the WHOLE series.
    expect(bundle.eodPrices.ok).toBe(true);
    expect(bundle.benchmarkPrices.spy.ok).toBe(true);
    expect(bundle.benchmarkPrices.sectorEtf.ok).toBe(true);

    if (bundle.eodPrices.ok) {
      // History is preserved and the fallback is disclosed, not silent.
      expect(bundle.eodPrices.value.data.rows.length).toBeGreaterThan(0);
      expect(bundle.eodPrices.value.endpoint).toContain("no published bar yet");
      // asOf reflects the real last close, never the empty run-day.
      expect(bundle.eodPrices.value.asOf).toBe("2026-01-02");
    }
  });
});
