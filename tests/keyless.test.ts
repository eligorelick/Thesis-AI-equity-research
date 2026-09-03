import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { buildStatementsFromCompanyFacts } from "@/edgar/statements";
import {
  applyKeylessFallbacks,
  isUsJurisdiction,
  lastCloseOnOrBefore,
  needsFallback,
  sharesOnOrBefore,
  sharesOutstandingSeries,
  type KeylessInputs,
  type KeylessMembers,
} from "@/pipeline/keyless";
import { classifyInstrumentSupport } from "@/pipeline/stageB/instrumentSupport";
import { createYahooClient, type YahooClient } from "@/providers/yahoo";
import { makeLimiter } from "@/providers/http";
import type { CompanyFacts } from "@/edgar/xbrl";
import type { FetchResult } from "@/types/core";
import type { FmpPayload, FmpRawRow } from "@/providers/fmp";

const NOW = new Date("2026-09-01T00:00:00Z");
const gap = <T extends FmpRawRow>(field: string, reason = "no API key + no fixture"): FetchResult<FmpPayload<T>> => ({
  ok: false,
  gap: { field, reason, severity: "warn" },
});
const okRows = <T extends FmpRawRow>(rows: T[], endpoint = "/stable/x"): FetchResult<FmpPayload<T>> => ({
  ok: true,
  value: {
    data: { rows, raw: null },
    asOf: "2026-09-01",
    source: "fmp",
    endpoint,
    fetchedAt: NOW.toISOString(),
  },
});

function allGaps(): KeylessMembers {
  return {
    profile: gap("fmp.profile(AAPL)"),
    quote: gap("fmp.quote(AAPL)"),
    incomeAnnual: gap("fmp.incomeStatement(AAPL,annual)"),
    incomeQuarterly: gap("fmp.incomeStatement(AAPL,quarter)"),
    balanceAnnual: gap("fmp.balanceSheet(AAPL,annual)"),
    balanceQuarterly: gap("fmp.balanceSheet(AAPL,quarter)"),
    cashflowAnnual: gap("fmp.cashFlow(AAPL,annual)"),
    cashflowQuarterly: gap("fmp.cashFlow(AAPL,quarter)"),
    eodPrices: gap("fmp.historicalPriceEodFull(AAPL)"),
    spy: gap("fmp.historicalPriceEodFull(SPY)"),
    sectorEtf: gap(
      "fmp.historicalPriceEodFull(XLK)",
      "FMP returned unparseable body (HTTP 402): symbol not available",
    ),
    enterpriseValues: gap("fmp.enterpriseValues(AAPL,quarter)"),
    marketCapHistory: gap("fmp.historicalMarketCap(AAPL)"),
    sharesFloat: gap("fmp.sharesFloat(AAPL)"),
  };
}

// ---------------------------------------------------------------------------
// companyfacts fixture — `facts` and `appleLike` are copied verbatim from
// tests/edgar.statements.test.ts (tests never import from each other here).
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

/** Minimal Apple-like facts: two fiscal years, one 10-Q quarter, dei shares. */
function appleFacts(): CompanyFacts {
  return appleLike();
}

/** Yahoo fake serving 5y of synthetic daily bars for any symbol and a quote meta. */
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

function inputs(over: Partial<KeylessInputs> = {}): KeylessInputs {
  return {
    symbol: "AAPL",
    today: "2026-09-01",
    eodFrom: "2021-09-01",
    sectorEtfSymbol: null,
    fmp: allGaps(),
    fmpKeyless: true,
    statementSource: "auto",
    edgarConfirmedIssuer: true,
    edgar: {
      cik: { ok: true, value: { data: { cik10: "0000320193", cik: 320193, ticker: "AAPL", title: "Apple Inc." }, asOf: "2026-09-01", source: "edgar", endpoint: "company_tickers.json", fetchedAt: NOW.toISOString() } },
      registrant: { name: "Apple Inc.", cik10: "0000320193", sic: "3571", sicDescription: "ELECTRONIC COMPUTERS", exchanges: ["Nasdaq"], tickers: ["AAPL"], fiscalYearEnd: "0927", stateOfIncorporation: "CA", forms: ["10-K", "10-Q", "8-K"] },
      companyFacts: { ok: true, value: { data: appleFacts(), asOf: "2025-09-27", source: "edgar", endpoint: "companyfacts", fetchedAt: NOW.toISOString() } },
    },
    yahoo: fakeYahoo(),
    annualPeriods: 10,
    quarterlyPeriods: 24,
    now: () => NOW,
    resolveSectorEtf: (sector) => (sector === "Technology" ? "XLK" : null),
    ...over,
  };
}

describe("needsFallback", () => {
  it("is true for a gap or an empty ok result and false for rows", () => {
    expect(needsFallback(gap("x"))).toBe(true);
    expect(needsFallback(okRows([]))).toBe(true);
    expect(needsFallback(okRows([{ a: 1 }]))).toBe(false);
  });
});

describe("pure keyless helpers", () => {
  it("takes the last close on or before a date and nothing from an empty or all-later series", () => {
    const rows = [
      { date: "2025-02-01", close: 3 },
      { date: "2025-01-15", close: 2 },
      { date: "2024-12-31", close: 1 },
    ];
    expect(lastCloseOnOrBefore(rows, "2025-06-01")).toBe(3);
    expect(lastCloseOnOrBefore(rows, "2025-01-20")).toBe(2);
    expect(lastCloseOnOrBefore(rows, "2024-12-31")).toBe(1);
    expect(lastCloseOnOrBefore(rows, "2024-01-01")).toBeNull();
    expect(lastCloseOnOrBefore([], "2025-01-01")).toBeNull();
    expect(lastCloseOnOrBefore([{ date: "2025-01-02" }, { date: "2025-01-01", close: 7 }], "2025-01-03")).toBe(7);
  });

  it("takes the latest share cover date on or before a date and falls back to the earliest", () => {
    const points = [
      { value: 100, asOf: "2025-01-31" },
      { value: 110, asOf: "2025-07-31" },
    ];
    expect(sharesOnOrBefore(points, "2025-12-31")).toBe(110);
    expect(sharesOnOrBefore(points, "2025-02-01")).toBe(100);
    expect(sharesOnOrBefore(points, "2020-01-01")).toBe(100);
    expect(sharesOnOrBefore([], "2025-01-01")).toBeNull();
  });

  it("recognises the 50 states, DC and the five territories and nothing else", () => {
    expect(isUsJurisdiction("CA")).toBe(true);
    expect(isUsJurisdiction("DE")).toBe(true);
    expect(isUsJurisdiction("DC")).toBe(true);
    expect(isUsJurisdiction("PR")).toBe(true);
    expect(isUsJurisdiction("MP")).toBe(true);
    expect(isUsJurisdiction("L3")).toBe(false);
    expect(isUsJurisdiction("E9")).toBe(false);
    expect(isUsJurisdiction(null)).toBe(false);
  });
});

describe("applyKeylessFallbacks", () => {
  it("fills every core member from EDGAR and Yahoo with provenance and expected info gaps", async () => {
    const out = await applyKeylessFallbacks(inputs());
    const m = out.members;
    expect(m.profile.ok && m.profile.value.source).toBe("computed");
    if (!m.profile.ok) return;
    const profile = m.profile.value.data.rows[0]!;
    expect(profile).toMatchObject({ symbol: "AAPL", companyName: "Apple Inc.", sector: "Technology", industry: "Computer Hardware", currency: "USD", country: "US", isEtf: false, isFund: false, isAdr: false, ipoDate: "1980-12-12", cik: "0000320193" });
    expect(profile.price).toBeGreaterThan(0);
    expect(profile.marketCap).toBeCloseTo(profile.price! * 14_776, 3);
    expect(typeof profile.beta).toBe("number");
    expect(m.quote.ok && m.quote.value.source).toBe("yahoo");
    expect(m.quote.ok && m.quote.value.data.rows[0]!.marketCap).toBeCloseTo(profile.price! * 14_776, 3);
    expect(m.incomeAnnual.ok && m.incomeAnnual.value.source).toBe("edgar");
    expect(m.incomeAnnual.ok && m.incomeAnnual.value.endpoint).toBe("companyfacts→income-statement(annual)");
    expect(m.incomeAnnual.ok && m.incomeAnnual.value.asOf).toBe("2025-09-27");
    expect(m.incomeAnnual.ok && m.incomeAnnual.value.data.rows[0]!.revenue).toBe(400);
    expect(m.balanceQuarterly.ok && m.balanceQuarterly.value.data.rows.length).toBeGreaterThan(0);
    expect(m.eodPrices.ok && m.eodPrices.value.data.rows.length).toBeGreaterThan(1000);
    expect(m.spy.ok && m.spy.value.source).toBe("yahoo");
    expect(m.sectorEtf.ok && m.sectorEtf.value.source).toBe("yahoo");
    expect(out.sectorEtfSymbol).toBe("XLK");
    expect(m.enterpriseValues.ok && m.enterpriseValues.value.source).toBe("computed");
    if (m.enterpriseValues.ok) {
      const ev = m.enterpriseValues.value.data.rows[0]!;
      expect(ev.date).toBe("2025-09-27");
      // No diluted share count on the derived Q4 income row, so the cover-page
      // count within 60 days of the period end is used: 14,776 @ 2025-10-17.
      expect(ev.numberOfShares).toBe(14_776);
      expect(ev.addTotalDebt).toBe(95);
      expect(ev.minusCashAndCashEquivalents).toBe(30);
      expect(ev.marketCapitalization).toBeCloseTo(ev.stockPrice! * 14_776, 6);
      expect(ev.enterpriseValue).toBeCloseTo(ev.marketCapitalization! + ev.addTotalDebt! - ev.minusCashAndCashEquivalents!, 6);
    }
    expect(m.marketCapHistory.ok && m.marketCapHistory.value.data.rows.length).toBeGreaterThan(1000);
    expect(m.sharesFloat.ok && m.sharesFloat.value.data.rows[0]).toMatchObject({ outstandingShares: 14_776 });
    expect(out.replaced.sort()).toEqual(Object.keys(allGaps()).sort());
    const fields = out.gaps.map((g) => g.field);
    expect(fields).toContain("keyless.incomeAnnual");
    // WS4: narrowed from "every gap" to "every member-replacement gap". The
    // fixture's cover-page public float is measured 2025-03-28 against an
    // analysis date of 2026-09-01, and a stale float is now its own `warn`
    // entry (asserted below), so the happy path is no longer info-only.
    const replacements = out.gaps.filter((g) => /^keyless\.[a-zA-Z]+$/.test(g.field));
    expect(replacements.length).toBeGreaterThan(0);
    expect(replacements.every((g) => g.severity === "info" && g.expected === true)).toBe(true);
    expect(out.gaps.find((g) => g.field === "keyless.profile")?.reason).toMatch(/served by computed .* because FMP no API key \+ no fixture/);
  });

  it("never overwrites an FMP member that has rows, and marks gaps as unexpected on a keyed plan", async () => {
    // WS4 (D-12) changed the expectation from "the member is the same object"
    // to "the vendor's own rows are untouched": under `auto`, periods OLDER
    // than the oldest vendor row are backfilled from companyfacts. The vendor
    // period itself is never rebuilt or merged.
    const fmp = allGaps();
    fmp.incomeAnnual = okRows([{ date: "2025-09-27", revenue: 1 }]);
    const out = await applyKeylessFallbacks(inputs({ fmp, fmpKeyless: false }));
    const rows = out.members.incomeAnnual.ok ? out.members.incomeAnnual.value.data.rows : [];
    expect(rows[0]).toEqual({ date: "2025-09-27", revenue: 1 });
    expect(rows.slice(1).every((row) => row.source === "edgar")).toBe(true);
    expect(out.gaps.filter((g) => g.field === "statements.backfill.incomeAnnual")).toHaveLength(1);
    // WS4: scoped to the member-replacement gaps `keyless.<member>`, which are
    // the ones whose expectedness depends on whether the plan is keyless. The
    // methodology disclosures added since (profile.beta.method,
    // keyless.sharesFloat.publicFloat) describe how a number was computed and
    // are structural on any plan.
    expect(
      out.gaps
        .filter((g) => /^keyless\.[a-zA-Z]+$/.test(g.field))
        .every((g) => g.expected === undefined || g.expected === false),
    ).toBe(true);
    expect(out.gaps.find((g) => g.field === "keyless.sectorEtf")?.reason).toMatch(/HTTP 402/);
  });

  it("leaves the vendor member untouched under THESIS_STATEMENT_SOURCE=fmp", async () => {
    const fmp = allGaps();
    fmp.incomeAnnual = okRows([{ date: "2025-09-27", revenue: 1 }]);
    const out = await applyKeylessFallbacks(inputs({ fmp, fmpKeyless: false, statementSource: "fmp" }));
    expect(out.members.incomeAnnual).toBe(fmp.incomeAnnual);
    expect(out.replaced).not.toContain("incomeAnnual");
    expect(out.gaps.some((g) => g.field.startsWith("statements.backfill."))).toBe(false);
  });

  it("backfills only periods the vendor did not serve, with per-row provenance and a depth disclosure", async () => {
    const fmp = allGaps();
    // A capped plan: one annual period served of ten requested.
    fmp.incomeAnnual = {
      ok: true,
      value: {
        data: { rows: [{ date: "2025-09-27", revenue: 1 }], raw: null, planLimit: { requested: 10, applied: 1 } },
        asOf: "2025-09-27",
        source: "fmp",
        endpoint: "/stable/income-statement?limit=1",
        fetchedAt: NOW.toISOString(),
      },
    };
    const out = await applyKeylessFallbacks(inputs({ fmp, fmpKeyless: false }));
    expect(out.members.incomeAnnual.ok).toBe(true);
    if (!out.members.incomeAnnual.ok) return;
    const rows = out.members.incomeAnnual.value.data.rows;
    expect(rows.map((row) => row.date)).toEqual(["2025-09-27", "2024-09-28"]);
    expect(rows[0]!.source).toBeUndefined();
    expect(rows[1]).toMatchObject({
      source: "edgar",
      sourceEndpoint: "companyfacts→income-statement(annual)",
      revenue: 380,
    });
    expect(out.members.incomeAnnual.value.endpoint).toBe(
      "/stable/income-statement?limit=1 + companyfacts→income-statement(annual) (older periods)",
    );
    const entry = out.gaps.find((g) => g.field === "statements.backfill.incomeAnnual");
    expect(entry).toMatchObject({ severity: "info", expected: true });
    expect(entry?.reason).toMatch(/FMP served 1 period\(s\) back to 2025-09-27/);
    expect(entry?.reason).toMatch(/caps 'limit' at 1, so 1 of 10 requested periods arrived/);
    expect(entry?.reason).toMatch(/supplied 1 older period\(s\), 2024-09-28 to 2024-09-28/);
    expect(entry?.reason).toMatch(/No period mixes the two sources/);
  });

  it("rebuilds every statement member from companyfacts under THESIS_STATEMENT_SOURCE=edgar", async () => {
    const fmp = allGaps();
    fmp.incomeAnnual = okRows([{ date: "2025-09-27", revenue: 1 }]);
    fmp.balanceAnnual = okRows([{ date: "2025-09-27", totalAssets: 2 }]);
    const out = await applyKeylessFallbacks(inputs({ fmp, fmpKeyless: false, statementSource: "edgar" }));
    expect(out.members.incomeAnnual.ok && out.members.incomeAnnual.value.source).toBe("edgar");
    expect(out.members.incomeAnnual.ok && out.members.incomeAnnual.value.data.rows[0]!.revenue).toBe(400);
    expect(out.members.balanceAnnual.ok && out.members.balanceAnnual.value.source).toBe("edgar");
    expect(out.replaced).toContain("incomeAnnual");
    expect(out.gaps.some((g) => g.field.startsWith("statements.backfill."))).toBe(false);
  });

  it("leaves the FMP gap in place and records the keyless failure when Yahoo is unavailable", async () => {
    const out = await applyKeylessFallbacks(inputs({ yahoo: fakeYahoo({ fail: new Set(["AAPL", "SPY", "XLK"]) }) }));
    expect(out.members.eodPrices.ok).toBe(false);
    if (out.members.eodPrices.ok) return;
    expect(out.members.eodPrices.gap.reason).toBe("no API key + no fixture");
    expect(out.members.eodPrices.gap.attemptedSources).toEqual(expect.arrayContaining([expect.stringMatching(/yahoo/)]));
    expect(out.gaps.find((g) => g.field === "keyless.eodPrices")?.severity).toBe("warn");
    // Statements still come from EDGAR; the profile still exists but without price-derived fields.
    expect(out.members.incomeAnnual.ok).toBe(true);
    expect(out.members.profile.ok && out.members.profile.value.data.rows[0]!.price).toBeNull();
    expect(out.members.profile.ok && out.members.profile.value.data.rows[0]!.marketCap).toBeNull();
    // No Yahoo meta: currency falls back to the filed reporting currency and the
    // exchange to the registrant's.
    expect(out.members.profile.ok && out.members.profile.value.data.rows[0]).toMatchObject({ currency: "USD", exchange: "Nasdaq", exchangeFullName: null, ipoDate: null });
    expect(out.gaps.some((g) => g.field === "profile.beta")).toBe(true);
    expect(out.members.enterpriseValues.ok).toBe(false);
    expect(out.members.marketCapHistory.ok).toBe(false);
    // Float needs a price to turn the filed dollar float into shares.
    expect(out.members.sharesFloat.ok && out.members.sharesFloat.value.data.rows[0]).toMatchObject({ outstandingShares: 14_776, floatShares: null, freeFloat: null });
  });

  it("fills only the benchmark series when EDGAR did not confirm the issuer", async () => {
    // A keyed plan whose EDGAR lookup failed but whose FMP profile supplied a
    // CIK: SPY and the sector ETF are the same instruments whoever this company
    // is, so they still substitute. Nothing that would assert an issuer identity
    // is attempted — and no gap is filed for an attempt that never happened.
    const base = inputs({
      edgarConfirmedIssuer: false,
      fmpKeyless: false,
      sectorEtfSymbol: "XLK",
      edgar: {
        ...inputs().edgar,
        registrant: null,
        companyFacts: { ok: false, gap: { field: "edgar.companyFacts(AAPL)", reason: "EDGAR HTTP 503", severity: "warn" } },
      },
    });
    const out = await applyKeylessFallbacks(base);
    expect(out.replaced.sort()).toEqual(["sectorEtf", "spy"]);
    expect(out.members.spy.ok && out.members.spy.value.source).toBe("yahoo");
    expect(out.members.sectorEtf.ok && out.members.sectorEtf.value.source).toBe("yahoo");
    // Every issuer-bound member keeps FMP's untouched result, by identity.
    for (const member of ["profile", "quote", "incomeAnnual", "balanceQuarterly", "cashflowAnnual", "eodPrices", "enterpriseValues", "marketCapHistory", "sharesFloat"] as const) {
      expect(out.members[member]).toBe(base.fmp[member]);
    }
    // ...and no keyless entry claims those were tried.
    expect(out.gaps.map((g) => g.field).sort()).toEqual(["keyless.sectorEtf", "keyless.spy"]);
    expect(out.notes.some((n) => /limited to the benchmark series/.test(n))).toBe(true);
  });

  it("attempts nothing at all when the issuer is unconfirmed and FMP already served the benchmarks", async () => {
    const fmp = allGaps();
    fmp.spy = okRows([{ symbol: "SPY", date: "2026-08-31", close: 400 }]);
    fmp.sectorEtf = okRows([{ symbol: "XLK", date: "2026-08-31", close: 200 }]);
    const out = await applyKeylessFallbacks(inputs({ fmp, edgarConfirmedIssuer: false }));
    expect(out.replaced).toEqual([]);
    expect(out.gaps).toEqual([]);
  });

  it("blames the FMP profile, not a SIC lookup that never ran, for an unresolved sector ETF", async () => {
    // Unconfirmed issuer means no registrant and no SIC taxonomy lookup, so the
    // disclosure must not claim EDGAR's submissions were consulted.
    // An unconfirmed issuer is exactly the shape buildDataBundle passes: no
    // registrant, so no SIC to map, and FMP's profile supplied no sector either.
    const out = await applyKeylessFallbacks(
      inputs({
        edgarConfirmedIssuer: false,
        fmpKeyless: false,
        sectorEtfSymbol: null,
        edgar: { ...inputs().edgar, registrant: null },
      }),
    );
    const g = out.gaps.find((entry) => entry.field === "keyless.sectorEtf");
    expect(g?.severity).toBe("warn");
    expect(g?.reason).toMatch(/FMP's profile carried no mappable sector/);
    expect(g?.attemptedSources).toEqual(["fmp:profile.sector"]);
    expect(g?.attemptedSources).not.toContain("edgar:submissions.sic");
  });

  it("does nothing when EDGAR did not resolve the ticker", async () => {
    const fmp = allGaps();
    const out = await applyKeylessFallbacks(inputs({ fmp, edgar: { cik: { ok: false, gap: { field: "edgar.cik(DEMO)", reason: 'ticker "DEMO" not in SEC company_tickers.json', severity: "warn" } }, registrant: null, companyFacts: { ok: false, gap: { field: "x", reason: "n/a", severity: "warn" } } } }));
    expect(out.members).toEqual(fmp);
    expect(out.replaced).toEqual([]);
    expect(out.gaps).toEqual([]);
    expect(out.notes[0]).toMatch(/skipped/);
  });

  it("reports the beta regression's R-squared in the profile note", async () => {
    // betaEstimate computes rSquared and nothing surfaced it; the spec lists R²
    // reporting, and the fit is what says how much of the move the benchmark
    // explains.
    const out = await applyKeylessFallbacks(inputs());
    const note = out.notes.find((n) => /^profile: beta /.test(n));
    // WS4 (D-15) widened the note: the standard error and the Blume-adjusted
    // value now sit between the slope and the sample size.
    expect(note).toMatch(/^profile: beta -?\d+\.\d{3} ± \d+\.\d{3} \(OLS standard error\), Blume-adjusted -?\d+\.\d{3}, from \d+ monthly log returns/);
    expect(note).toMatch(/\(R² \d\.\d{2}\)$/);
  });

  it("classifies an ETF from Yahoo's instrumentType so the instrument guard refuses it", async () => {
    // SPY, QQQ and the closed-end trusts are SEC registrants with tickers and
    // 10-K filings, so they clear the issuer gate and the whole keyless
    // fallback runs for them. Hard-coding isEtf/isFund false meant
    // `classifyInstrumentSupport` could never refuse one on a keyless run.
    const out = await applyKeylessFallbacks(
      inputs({ symbol: "SPY", yahoo: fakeYahoo({ instrumentType: "ETF" }) }),
    );
    expect(out.members.profile.ok).toBe(true);
    if (!out.members.profile.ok) return;
    const profile = out.members.profile.value.data.rows[0]!;
    expect(profile).toMatchObject({ isEtf: true, isFund: false });
    expect(classifyInstrumentSupport(profile as { isEtf?: boolean; isFund?: boolean })).toMatchObject({
      supported: false,
      kind: "etf",
    });
    expect(out.notes.some((n) => n === "profile: instrument type ETF (Yahoo chart meta)")).toBe(true);
    expect(out.gaps.some((g) => g.field === "profile.instrumentType")).toBe(false);
  });

  it.each([
    ["MUTUALFUND", "fund"],
    ["CLOSEDEND", "fund"],
  ])("classifies %s as a fund the instrument guard refuses", async (instrumentType, kind) => {
    const out = await applyKeylessFallbacks(inputs({ yahoo: fakeYahoo({ instrumentType }) }));
    expect(out.members.profile.ok).toBe(true);
    if (!out.members.profile.ok) return;
    const profile = out.members.profile.value.data.rows[0]!;
    expect(profile).toMatchObject({ isEtf: false, isFund: true });
    expect(classifyInstrumentSupport(profile as { isEtf?: boolean; isFund?: boolean })).toMatchObject({
      supported: false,
      kind,
    });
  });

  it("leaves both flags false for an EQUITY and records the type in the profile note", async () => {
    const out = await applyKeylessFallbacks(inputs({ yahoo: fakeYahoo({ instrumentType: "EQUITY" }) }));
    expect(out.members.profile.ok).toBe(true);
    if (!out.members.profile.ok) return;
    const profile = out.members.profile.value.data.rows[0]!;
    expect(profile).toMatchObject({ isEtf: false, isFund: false });
    expect(classifyInstrumentSupport(profile as { isEtf?: boolean; isFund?: boolean })).toMatchObject({
      supported: true,
    });
    expect(out.notes.some((n) => n === "profile: instrument type EQUITY (Yahoo chart meta)")).toBe(true);
    expect(out.gaps.some((g) => g.field === "profile.instrumentType")).toBe(false);
  });

  it("discloses that the instrument was not classified when Yahoo's meta is unavailable", async () => {
    const out = await applyKeylessFallbacks(
      inputs({ yahoo: fakeYahoo({ fail: new Set(["AAPL", "SPY", "XLK"]) }) }),
    );
    expect(out.members.profile.ok).toBe(true);
    if (!out.members.profile.ok) return;
    expect(out.members.profile.value.data.rows[0]).toMatchObject({ isEtf: false, isFund: false });
    const g = out.gaps.find((entry) => entry.field === "profile.instrumentType");
    expect(g?.severity).toBe("info");
    expect(g?.reason).toMatch(/not classified .* Yahoo meta unavailable; treated as a company/);
    expect(g?.attemptedSources).toEqual(["yahoo:chart(meta.instrumentType)"]);
    expect(out.notes.some((n) => /^profile: instrument type /.test(n))).toBe(false);
  });

  it("builds shares, market cap and history from the balance-sheet total for a per-class reporter", async () => {
    // A registrant that reports cover counts per share class (GOOGL, BRK.B,
    // FOXA) files them DIMENSIONED, and companyfacts carries no dimensional
    // facts — so `dei:EntityCommonStockSharesOutstanding` is absent altogether
    // while the non-dimensional all-classes balance-sheet total is present.
    const facts = appleFacts();
    const dei = { ...(facts.facts["dei"] as Record<string, unknown>) };
    delete dei["EntityCommonStockSharesOutstanding"];
    const usGaap = facts.facts["us-gaap"] as Record<string, unknown>;
    usGaap["CommonStockSharesOutstanding"] = {
      label: "CommonStockSharesOutstanding",
      units: {
        shares: [
          { end: "2024-09-28", val: 12_000, accn: "a-1", fy: 2024, fp: "FY", form: "10-K", filed: "2024-11-01" },
          { end: "2025-09-27", val: 12_230, accn: "a-2", fy: 2025, fp: "FY", form: "10-K", filed: "2025-10-31" },
        ],
      },
    };
    const out = await applyKeylessFallbacks(
      inputs({
        edgar: {
          ...inputs().edgar,
          companyFacts: { ok: true, value: { data: { ...facts, facts: { ...facts.facts, dei } }, asOf: "2025-09-27", source: "edgar", endpoint: "companyfacts", fetchedAt: NOW.toISOString() } },
        },
      }),
    );
    expect(out.members.profile.ok).toBe(true);
    if (!out.members.profile.ok) return;
    const profile = out.members.profile.value.data.rows[0]!;
    expect(profile.marketCap).toBeCloseTo(profile.price! * 12_230, 3);
    expect(out.notes.some((n) => /^profile: market cap from the balance sheet CommonStockSharesOutstanding share count \(12230 at 2025-09-27\)$/.test(n))).toBe(true);
    // The whole series, not just the latest point, feeds the daily history.
    expect(out.members.marketCapHistory.ok).toBe(true);
    if (out.members.marketCapHistory.ok) {
      const rows = out.members.marketCapHistory.value.data.rows;
      expect(rows.length).toBeGreaterThan(1000);
      const oldest = rows[rows.length - 1]!;
      expect(oldest.marketCap).toBeGreaterThan(0);
    }
    expect(out.notes).toContain(
      "keyless market-cap history: share counts from the balance sheet CommonStockSharesOutstanding",
    );
    // The rendered endpoint strings name the concept that served the count.
    expect(out.members.marketCapHistory.ok && out.members.marketCapHistory.value.endpoint).toBe(
      "derived:market-cap(close×us-gaap:CommonStockSharesOutstanding)",
    );
    expect(out.members.profile.value.endpoint).toBe(
      "derived:profile(edgar:submissions + yahoo:chart + us-gaap:CommonStockSharesOutstanding)",
    );
    expect(out.notes).toContain(
      "keyless enterprise values: fallback share counts from the balance sheet CommonStockSharesOutstanding",
    );
    expect(out.members.sharesFloat.ok && out.members.sharesFloat.value.endpoint).toBe(
      "companyfacts→shares-float(us-gaap:CommonStockSharesOutstanding + dei:EntityPublicFloat)",
    );
    expect(out.members.sharesFloat.ok && out.members.sharesFloat.value.data.rows[0]).toMatchObject({
      outstandingShares: 12_230,
      date: "2025-09-27",
    });
  });

  it("prefers the dei cover count and names it in the notes when both concepts exist", async () => {
    const out = await applyKeylessFallbacks(inputs());
    expect(out.members.profile.ok && out.members.profile.value.endpoint).toBe(
      "derived:profile(edgar:submissions + yahoo:chart + dei:shares)",
    );
    expect(out.members.marketCapHistory.ok && out.members.marketCapHistory.value.endpoint).toBe(
      "derived:market-cap(close×dei:shares)",
    );
    expect(out.notes).toContain("profile: market cap from the dei cover page share count (14776 at 2025-10-17)");
    expect(out.notes).toContain("keyless market-cap history: share counts from the dei cover page");
    expect(out.members.sharesFloat.ok && out.members.sharesFloat.value.endpoint).toBe(
      "companyfacts→shares-float(dei:EntityCommonStockSharesOutstanding + dei:EntityPublicFloat)",
    );
  });

  it("flags a 20-F filer as an ADR and leaves country null for a foreign incorporation", async () => {
    const facts = appleFacts();
    for (const concept of Object.values(facts.facts["us-gaap"]!)) {
      for (const pts of Object.values((concept as { units: Record<string, { form: string }[]> }).units)) for (const p of pts) if (p.form === "10-K") p.form = "20-F";
    }
    const out = await applyKeylessFallbacks(inputs({ edgar: { ...inputs().edgar, registrant: { ...inputs().edgar.registrant!, stateOfIncorporation: "L3", forms: ["20-F", "6-K"] }, companyFacts: { ok: true, value: { data: facts, asOf: "2025-09-27", source: "edgar", endpoint: "companyfacts", fetchedAt: NOW.toISOString() } } } }));
    expect(out.members.profile.ok && out.members.profile.value.data.rows[0]).toMatchObject({ isAdr: true, country: null });
  });

  it("does not flag a since-converted domestic filer as an ADR on one historical 20-F", async () => {
    // The submissions form list spans up to a thousand filings, so it can carry
    // a 20-F the registrant stopped filing years ago. The statements the profile
    // actually reports are 10-K/10-Q, so `isAdr` must be false.
    const out = await applyKeylessFallbacks(
      inputs({
        edgar: {
          ...inputs().edgar,
          registrant: { ...inputs().edgar.registrant!, forms: ["10-K", "10-Q", "8-K", "20-F"] },
        },
      }),
    );
    expect(out.members.profile.ok && out.members.profile.value.data.rows[0]!.isAdr).toBe(false);
  });

  it("falls back to the submissions form list only when no statements could be built", async () => {
    const out = await applyKeylessFallbacks(
      inputs({
        edgar: {
          ...inputs().edgar,
          registrant: { ...inputs().edgar.registrant!, forms: ["20-F", "6-K"] },
          companyFacts: { ok: false, gap: { field: "edgar.companyFacts(AAPL)", reason: "EDGAR HTTP 503", severity: "warn" } },
        },
      }),
    );
    expect(out.members.profile.ok && out.members.profile.value.data.rows[0]!.isAdr).toBe(true);
  });

  it("keeps the six statement gaps when companyfacts is unavailable and records the EDGAR attempt", async () => {
    const out = await applyKeylessFallbacks(
      inputs({
        edgar: {
          ...inputs().edgar,
          companyFacts: { ok: false, gap: { field: "edgar.companyFacts(AAPL)", reason: "EDGAR HTTP 503", severity: "warn" } },
        },
      }),
    );
    const income = out.members.incomeAnnual;
    expect(income.ok).toBe(false);
    if (income.ok) return;
    expect(income.gap.reason).toMatch(/no API key \+ no fixture.*EDGAR HTTP 503/);
    expect(income.gap.attemptedSources).toContain("edgar:companyfacts");
    expect(out.gaps.find((g) => g.field === "keyless.cashflowQuarterly")?.severity).toBe("warn");
    expect(out.replaced).not.toContain("balanceAnnual");
    // Prices are independent of companyfacts and still arrive.
    expect(out.members.eodPrices.ok).toBe(true);
    // Without dei shares nothing capitalization-derived can be built.
    expect(out.members.marketCapHistory.ok).toBe(false);
    expect(out.members.sharesFloat.ok).toBe(false);
    expect(out.members.profile.ok && out.members.profile.value.data.rows[0]!.marketCap).toBeNull();
  });

  it("skips an enterprise-value period rather than fabricating an operand", async () => {
    // The fixture's three 10-Q periods file total assets only, so debt and cash
    // are genuinely absent there; only the fiscal-year end has every operand.
    const out = await applyKeylessFallbacks(inputs());
    expect(out.members.enterpriseValues.ok && out.members.enterpriseValues.value.data.rows.map((r) => r.date)).toEqual(["2025-09-27"]);
    for (const date of ["2025-06-28", "2025-03-29", "2024-12-28"]) {
      expect(out.notes).toContain(`keyless enterprise value ${date} skipped: no totalDebt, no cashAndCashEquivalents`);
    }
  });

  it("cannot build a profile without a registrant and says so", async () => {
    const out = await applyKeylessFallbacks(inputs({ edgar: { ...inputs().edgar, registrant: null } }));
    expect(out.members.profile.ok).toBe(false);
    expect(out.gaps.find((g) => g.field === "keyless.profile")?.severity).toBe("warn");
    expect(out.gaps.find((g) => g.field === "keyless.profile")?.reason).toMatch(/registrant/);
    // The sector ETF is unresolvable without a SIC, so that member stays gapped too.
    expect(out.sectorEtfSymbol).toBeNull();
    expect(out.members.sectorEtf.ok).toBe(false);
    // Statements and prices are unaffected.
    expect(out.members.incomeAnnual.ok).toBe(true);
    expect(out.members.eodPrices.ok).toBe(true);
  });

  it("turns a thrown keyless fetch into a disclosed gap instead of a rejection", async () => {
    const throwing = {
      dailyHistory: () => Promise.reject(new Error("socket hang up")),
      meta: () => Promise.reject(new Error("socket hang up")),
      quote: () => Promise.reject("not an Error"),
    } as unknown as YahooClient;
    const out = await applyKeylessFallbacks(inputs({ yahoo: throwing }));
    expect(out.members.eodPrices.ok).toBe(false);
    expect(out.gaps.find((g) => g.field === "keyless.eodPrices")?.reason).toMatch(/threw: socket hang up/);
    expect(out.gaps.find((g) => g.field === "keyless.quote")?.reason).toMatch(/threw: not an Error/);
    // The EDGAR half of the fallback is untouched by a broken price source.
    expect(out.members.incomeAnnual.ok).toBe(true);
    expect(out.members.sharesFloat.ok).toBe(true);
  });

  it("keeps the FMP gap when companyfacts holds no usable facts for a statement", async () => {
    const empty = facts({});
    const out = await applyKeylessFallbacks(
      inputs({
        edgar: {
          ...inputs().edgar,
          companyFacts: { ok: true, value: { data: empty, asOf: "2026-09-01", source: "edgar", endpoint: "companyfacts", fetchedAt: NOW.toISOString() } },
        },
      }),
    );
    const income = out.members.incomeAnnual;
    expect(income.ok).toBe(false);
    if (income.ok) return;
    expect(income.gap.reason).toMatch(/no API key \+ no fixture; EDGAR companyfacts produced no incomeAnnual rows/);
    expect(income.gap.attemptedSources).toContain("edgar:companyfacts");
    expect(out.gaps.find((g) => g.field === "keyless.balanceQuarterly")?.severity).toBe("warn");
    expect(out.replaced).not.toContain("cashflowAnnual");
    // No shares either, so nothing capitalization-derived can be built.
    expect(out.members.sharesFloat.ok).toBe(false);
    expect(out.members.enterpriseValues.ok).toBe(false);
  });

  it("derives capitalization from FMP prices when only the derived members are missing", async () => {
    const fmp = allGaps();
    fmp.eodPrices = okRows([
      { symbol: "AAPL", date: "2025-06-27", close: 200 },
      { symbol: "AAPL", date: "2025-03-28", close: 190 },
      { symbol: "AAPL", date: "2024-12-27", close: 180 },
    ]);
    const out = await applyKeylessFallbacks(inputs({ fmp, sectorEtfSymbol: "XLK" }));
    expect(out.members.eodPrices).toBe(fmp.eodPrices);
    expect(out.replaced).not.toContain("eodPrices");
    expect(out.members.enterpriseValues.ok && out.members.enterpriseValues.value.data.rows[0]).toMatchObject({
      date: "2025-09-27",
      stockPrice: 200,
      numberOfShares: 14_776,
      marketCapitalization: 200 * 14_776,
      addTotalDebt: 95,
      minusCashAndCashEquivalents: 30,
      enterpriseValue: 200 * 14_776 + 95 - 30,
    });
    expect(out.members.marketCapHistory.ok && out.members.marketCapHistory.value.data.rows).toEqual([
      { symbol: "AAPL", date: "2025-06-27", marketCap: 200 * 14_900 },
      { symbol: "AAPL", date: "2025-03-28", marketCap: 190 * 14_900 },
      { symbol: "AAPL", date: "2024-12-27", marketCap: 180 * 14_900 },
    ]);
  });
});

describe("sharesOutstandingSeries", () => {
  it("carries cover counts filed before a split to the current share basis and names the split", () => {
    const SPLIT_TAG = "StockholdersEquityNoteStockSplitConversionRatio1";
    const series = sharesOutstandingSeries(
      facts(
        {
          [SPLIT_TAG]: [{ end: "2020-08-28", val: 4, filed: "2020-10-30" }],
          WeightedAverageNumberOfDilutedSharesOutstanding: [
            { start: "2018-09-30", end: "2019-09-28", val: 4_648_913_000, filed: "2019-10-31" },
            { start: "2018-09-30", end: "2019-09-28", val: 18_595_651_000, filed: "2020-10-30" },
          ],
        },
        {
          EntityCommonStockSharesOutstanding: [
            { end: "2019-10-18", val: 4_443_265_000, filed: "2019-10-31" },
            { end: "2020-10-16", val: 17_001_802_000, filed: "2020-10-30" },
          ],
        },
        { [SPLIT_TAG]: "pure" },
      ),
    );
    expect(series.basis).toBe("dei cover page");
    expect(series.points).toEqual([
      { value: 17_773_060_000, asOf: "2019-10-18" },
      { value: 17_001_802_000, asOf: "2020-10-16" },
    ]);
    expect(series.splits.map((e) => [e.date, e.ratio])).toEqual([["2020-08-28", 4]]);
  });

  it("leaves a series without a split concept exactly as filed", () => {
    const series = sharesOutstandingSeries(appleFacts());
    expect(series.splits).toEqual([]);
    expect(series.points.map((p) => p.value)).toEqual([14_900, 14_776]);
  });

  it("sums the per-class cover counts of EVERY period, not only the newest", () => {
    // The spot count summed the classes while this series deduplicated them, so
    // one report showed a 500M spot market cap and a same-day history point of
    // 250M; for an Alphabet-shaped issuer the whole series was about half.
    const multiClass = JSON.parse(
      readFileSync(path.join(process.cwd(), "fixtures", "edgar", "multiclass_companyfacts.json"), "utf8"),
    ) as CompanyFacts;
    const series = sharesOutstandingSeries(multiClass);
    expect(series.basis).toBe("dei cover page");
    expect(series.points).toEqual([
      { value: 7_800_000, asOf: "2025-02-14" }, // 4,800,000 + 3,000,000
      { value: 10_000_000, asOf: "2026-02-13" }, // 5,000,000 + 3,000,000 + 2,000,000
    ]);
    // ...and the newest series point is the very number the spot count publishes.
    const built = buildStatementsFromCompanyFacts(multiClass, {
      symbol: "TCEH",
      cik: "0009900001",
      annualPeriods: 10,
      quarterlyPeriods: 24,
    });
    expect(series.points[series.points.length - 1]!.value).toBe(built.shares.outstanding!.value);
  });

  it("keeps deduplicating a REFILED period rather than summing it", () => {
    // Two filings of one cover date are a refiling, not two classes: max(filed)
    // wins and nothing is added.
    const series = sharesOutstandingSeries(
      facts(
        { Assets: [{ end: "2026-02-13", val: 5_000 }] },
        {
          EntityCommonStockSharesOutstanding: [
            { end: "2026-02-13", val: 900, filed: "2026-02-20", accn: "0000000000-26-000001" },
            { end: "2026-02-13", val: 950, filed: "2026-03-20", accn: "0000000000-26-000002" },
          ],
        },
      ),
    );
    expect(series.points).toEqual([{ value: 950, asOf: "2026-02-13" }]);
  });
});

describe("applyKeylessFallbacks — stock split disclosure", () => {
  const SPLIT_TAG = "StockholdersEquityNoteStockSplitConversionRatio1";
  /** appleFacts() plus a tagged split and the FY2019 diluted count as first filed and as restated. */
  function withSplit(tagged: number): CompanyFacts {
    const f = appleFacts();
    const usGaap = f.facts["us-gaap"] as Record<string, { units: Record<string, unknown[]> }>;
    usGaap[SPLIT_TAG] = {
      units: { pure: [{ end: "2020-08-28", val: tagged, accn: "s-1", fy: 2020, fp: "FY", form: "10-K", filed: "2020-10-30" }] },
    };
    usGaap["WeightedAverageNumberOfDilutedSharesOutstanding"]!.units["shares"]!.push(
      { start: "2018-09-30", end: "2019-09-28", val: 4_648_913_000, accn: "s-2", fy: 2019, fp: "FY", form: "10-K", filed: "2019-10-31" },
      { start: "2018-09-30", end: "2019-09-28", val: 18_595_651_000, accn: "s-3", fy: 2020, fp: "FY", form: "10-K", filed: "2020-10-30" },
    );
    return f;
  }
  const run = (facts: CompanyFacts) =>
    applyKeylessFallbacks(
      inputs({
        edgar: {
          ...inputs().edgar,
          companyFacts: { ok: true, value: { data: facts, asOf: "2025-09-27", source: "edgar", endpoint: "companyfacts", fetchedAt: NOW.toISOString() } },
        },
      }),
    );

  it("records an applied split in the manifest as an expected info entry", async () => {
    const out = await run(withSplit(4));
    expect(out.gaps.filter((g) => g.field.startsWith("keyless.stockSplits"))).toEqual([
      {
        field: "keyless.stockSplits(2020-08-28)",
        reason: `stock split 4-for-1 on 2020-08-28 (${SPLIT_TAG}, confirmed by restated share counts ×4): per-share and share-count facts filed before that date are restated to the post-split basis`,
        severity: "info",
        attemptedSources: [`edgar:companyfacts us-gaap/${SPLIT_TAG}`],
        expected: true,
      },
    ]);
  });

  it("records a ratio it could not apply as an unexpected warning", async () => {
    const out = await run(withSplit(3));
    const entry = out.gaps.find((g) => g.field.startsWith("keyless.stockSplits"));
    expect(entry).toMatchObject({ field: "keyless.stockSplits(2020-08-28)", severity: "warn", expected: false });
    expect(entry?.reason).toMatch(/^stock split ratio 3 tagged for 2020-08-28 .* NOT applied: share counts restated across that date moved by ×4/);
  });

  it("adds no split entry when the concept is absent", async () => {
    const out = await run(appleFacts());
    expect(out.gaps.some((g) => g.field.startsWith("keyless.stockSplits"))).toBe(false);
  });
});

describe("applyKeylessFallbacks — concept substitution disclosure", () => {
  const run = (facts: CompanyFacts) =>
    applyKeylessFallbacks(
      inputs({
        edgar: {
          ...inputs().edgar,
          companyFacts: { ok: true, value: { data: facts, asOf: "2025-09-27", source: "edgar", endpoint: "companyfacts", fetchedAt: NOW.toISOString() } },
        },
      }),
    );

  it("records a stand-in concept as an expected info entry naming the statement, the field and the periods", async () => {
    const f = appleFacts();
    const usGaap = f.facts["us-gaap"] as Record<string, unknown>;
    usGaap["InterestPaidNet"] = usGaap["InterestExpense"];
    delete usGaap["InterestExpense"];
    const out = await run(f);
    const entry = out.gaps.find((g) => g.field === "keyless.incomeAnnual.interestExpense");
    expect(entry).toMatchObject({ severity: "info", expected: true, attemptedSources: ["edgar:companyfacts"] });
    expect(entry?.reason).toMatch(/^cash interest paid .*InterestPaidNet.* \(periods: 2025-09-27\)$/);
  });

  it("adds no substitution entry when every concept resolved from its own tag", async () => {
    const out = await run(appleFacts());
    expect(out.gaps.some((g) => /^keyless\.(income|balance|cashflow)(Annual|Quarterly)\./.test(g.field))).toBe(false);
  });
});

describe("applyKeylessFallbacks — why a parsable companyfacts yields no statements", () => {
  const withFacts = (facts: CompanyFacts, forms: string[]) =>
    applyKeylessFallbacks(
      inputs({
        edgar: {
          ...inputs().edgar,
          registrant: { ...inputs().edgar.registrant!, forms },
          companyFacts: { ok: true, value: { data: facts, asOf: "2025-09-27", source: "edgar", endpoint: "companyfacts", fetchedAt: NOW.toISOString() } },
        },
      }),
    );

  it("names IFRS reporting when the facts carry ifrs-full concepts and no us-gaap ones", async () => {
    const facts: CompanyFacts = {
      cik: 1046179,
      entityName: "TAIWAN SEMICONDUCTOR MANUFACTURING CO LTD",
      facts: { "ifrs-full": { Revenue: { label: "Revenue", units: { TWD: [] } } }, dei: {} },
    };
    const out = await withFacts(facts, ["20-F", "6-K"]);
    const entry = out.gaps.find((g) => g.field === "keyless.incomeAnnual");
    expect(entry?.reason).toMatch(/^EDGAR companyfacts produced no incomeAnnual rows: .*; the issuer reports under IFRS \(1 ifrs-full concepts, 0 us-gaap\) and the keyless statement builder reads us-gaap only$/);
  });

  it("names a successor issuer when the registrant has a Form 8-K12B and no annual facts", async () => {
    const facts: CompanyFacts = { cik: 2115436, entityName: "Exxon Mobil Corporation", facts: { "us-gaap": {}, dei: {} } };
    const out = await withFacts(facts, ["8-K12B", "10-Q", "8-K"]);
    const entry = out.gaps.find((g) => g.field === "keyless.incomeAnnual");
    expect(entry?.reason).toMatch(/; the registrant is a successor issuer \(Form 8-K12B on file\) whose predecessor's XBRL history sits under another CIK that EDGAR does not link$/);
  });

  it("adds no cause when the facts are simply thin", async () => {
    const facts: CompanyFacts = { cik: 1, entityName: "Thin Co", facts: { "us-gaap": {}, dei: {} } };
    const out = await withFacts(facts, ["10-K", "10-Q"]);
    const entry = out.gaps.find((g) => g.field === "keyless.incomeAnnual");
    expect(entry?.reason).not.toMatch(/IFRS|successor/);
  });
});

/**
 * The cover-page public float is a DOLLAR amount measured on one date — the
 * last business day of the issuer's most recently completed second fiscal
 * quarter — and refreshed once a year. Turning it into a share count needs a
 * price, and using the latest price rescales the count by every move since
 * that date. The figure therefore carries its own measurement date, separate
 * from the share count's, and is flagged when the two dates are far apart.
 */
describe("applyKeylessFallbacks — public float measurement date", () => {
  /** Replace the fixture's EntityPublicFloat with one measured on `end`. */
  function withFloatDate(end: string, val = 3_000_000): CompanyFacts {
    const f = appleFacts();
    const concept = f.facts["dei"]!["EntityPublicFloat"] as { units: Record<string, Record<string, unknown>[]> };
    const unit = Object.keys(concept.units)[0]!;
    concept.units[unit] = [{ ...concept.units[unit]![0]!, end, val }];
    return f;
  }
  const withFacts = (facts: CompanyFacts): KeylessInputs =>
    inputs({
      edgar: {
        ...inputs().edgar,
        companyFacts: { ok: true, value: { data: facts, asOf: "2025-09-27", source: "edgar", endpoint: "companyfacts", fetchedAt: NOW.toISOString() } },
      },
    });

  it("labels the float row with its own measurement date, distinct from the share count's", async () => {
    const out = await applyKeylessFallbacks(inputs());
    const row = out.members.sharesFloat.ok ? out.members.sharesFloat.value.data.rows[0]! : null;
    expect(row).toMatchObject({
      outstandingShares: 14_776,
      date: "2025-10-17", // the cover-page SHARE COUNT date
      publicFloatUsd: 3_000_000,
      publicFloatAsOf: "2025-03-28", // the FLOAT's own, earlier date
    });
    expect(row!.floatShares).toBeGreaterThan(0);
    expect(out.notes.some((n) => n.includes("public float 3000000 USD measured 2025-03-28"))).toBe(true);
  });

  it("flags a float measured more than six months before the analysis date", async () => {
    const out = await applyKeylessFallbacks(inputs()); // float 2025-03-28, today 2026-09-01
    const entry = out.gaps.find((g) => g.field === "keyless.sharesFloat.publicFloat")!;
    expect(entry.severity).toBe("warn");
    expect(entry.expected).toBeUndefined();
    expect(entry.reason).toMatch(/measured 2025-03-28 \(17 months before the analysis date\)/);
    expect(entry.reason).toMatch(/more than 6 months/);
    expect(out.members.sharesFloat.ok && out.members.sharesFloat.value.data.rows[0]!.publicFloatStale).toBe(true);
  });

  it("does not flag a float measured within six months, but still names the date", async () => {
    const out = await applyKeylessFallbacks(withFacts(withFloatDate("2026-06-30")));
    const entry = out.gaps.find((g) => g.field === "keyless.sharesFloat.publicFloat")!;
    expect(entry.severity).toBe("info");
    expect(entry.expected).toBe(true);
    expect(entry.reason).toMatch(/measured 2026-06-30 \(2 months before the analysis date\)/);
    expect(entry.reason).toMatch(/within 6 months/);
    expect(out.members.sharesFloat.ok && out.members.sharesFloat.value.data.rows[0]!.publicFloatStale).toBe(false);
  });

  it("says the float share count is absent when no EntityPublicFloat fact was filed", async () => {
    const f = appleFacts();
    delete f.facts["dei"]!["EntityPublicFloat"];
    const out = await applyKeylessFallbacks(withFacts(f));
    const entry = out.gaps.find((g) => g.field === "keyless.sharesFloat.publicFloat")!;
    expect(entry.severity).toBe("warn");
    expect(entry.reason).toMatch(/no dei:EntityPublicFloat fact/);
    const row = out.members.sharesFloat.ok ? out.members.sharesFloat.value.data.rows[0]! : null;
    // The outstanding count still stands on its own; only the float is absent.
    expect(row).toMatchObject({ outstandingShares: 14_776, floatShares: null, freeFloat: null, publicFloatAsOf: null });
  });
});

/**
 * Two things companyfacts knows that the manifest used to drop on the floor: a
 * material line a later filing restated, and a cover-page share count that is
 * the sum of several unnamed share classes.
 */
describe("applyKeylessFallbacks — restatements and multi-class share counts", () => {
  const withFacts = (f: CompanyFacts): KeylessInputs =>
    inputs({
      edgar: {
        ...inputs().edgar,
        companyFacts: { ok: true, value: { data: f, asOf: "2025-09-27", source: "edgar", endpoint: "companyfacts", fetchedAt: NOW.toISOString() } },
      },
    });

  it("reports a restated material line, both filings and the direction of the change", async () => {
    const f = appleFacts();
    const revenue = f.facts["us-gaap"]!["RevenueFromContractWithCustomerExcludingAssessedTax"] as {
      units: Record<string, Record<string, unknown>[]>;
    };
    const unit = Object.keys(revenue.units)[0]!;
    // FY2024 was first reported as 380 in the FY2024 10-K and carried at 400 as
    // a comparative in the FY2025 10-K: a 5.3% restatement of revenue.
    revenue.units[unit] = [
      ...revenue.units[unit]!,
      { start: "2023-10-01", end: "2024-09-28", val: 400, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31", accn: "0000320193-25-000010" },
    ];
    const out = await applyKeylessFallbacks(withFacts(f));
    const entry = out.gaps.find((g) => g.field === "keyless.incomeAnnual.restatements")!;
    expect(entry.severity).toBe("warn");
    expect(entry.reason).toMatch(/1 material line\(s\) restated by more than 1%/);
    expect(entry.reason).toMatch(/2024-09-28 revenue 380 → 400 \(\+5\.3%/);
    expect(entry.reason).toMatch(/first 10-K .* filed 2024-11-01/);
    expect(entry.reason).toMatch(/restated in 10-K 0000320193-25-000010 filed 2025-10-31/);
    // The row carries the last-filed value and keeps the first-reported one.
    const row = out.members.incomeAnnual.ok
      ? out.members.incomeAnnual.value.data.rows.find((r) => r["date"] === "2024-09-28")!
      : null;
    expect(row!["revenue"]).toBe(400);
    expect(out.notes.some((n) => n.startsWith("incomeAnnual: 1 restated material line"))).toBe(true);
  });

  it("adds no restatement entry when every period was filed once", async () => {
    const out = await applyKeylessFallbacks(inputs());
    expect(out.gaps.some((g) => g.field.endsWith(".restatements"))).toBe(false);
  });

  it("sums the per-class cover counts and names the parts, the filing and the total", async () => {
    const f = appleFacts();
    const shares = f.facts["dei"]!["EntityCommonStockSharesOutstanding"] as {
      units: Record<string, Record<string, unknown>[]>;
    };
    const unit = Object.keys(shares.units)[0]!;
    const common = { end: "2025-10-17", form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31", accn: "0000320193-25-000099" };
    // Three unnamed classes in one filing: companyfacts drops the dimension.
    shares.units[unit] = [
      { ...common, val: 9_000 },
      { ...common, val: 4_000 },
      { ...common, val: 1_776 },
    ];
    const out = await applyKeylessFallbacks(withFacts(f));
    const entry = out.gaps.find((g) => g.field === "keyless.sharesOutstanding.classes")!;
    expect(entry.severity).toBe("info");
    expect(entry.expected).toBe(true);
    expect(entry.reason).toMatch(/10-K 0000320193-25-000099 \(filed 2025-10-31\)/);
    expect(entry.reason).toMatch(/3 unnamed counts \(9000 \+ 4000 \+ 1776\) are summed to 14776 as of 2025-10-17/);
    expect(out.notes).toContain("keyless share count: 3 share classes summed (9000 + 4000 + 1776 = 14776 at 2025-10-17)");
    // The summed total is what every derived figure then uses.
    expect(out.members.sharesFloat.ok && out.members.sharesFloat.value.data.rows[0]!.outstandingShares).toBe(14_776);
  });

  it("adds no class entry when the cover count came from a single fact", async () => {
    const out = await applyKeylessFallbacks(inputs());
    expect(out.gaps.some((g) => g.field === "keyless.sharesOutstanding.classes")).toBe(false);
  });

  it("files the class caveats as warns in the manifest and in the notes", async () => {
    // A repeated count that may be a second class (N1) AND a hundredfold class
    // ratio a raw sum cannot represent (N2), in one filing.
    const f = appleFacts();
    const shares = f.facts["dei"]!["EntityCommonStockSharesOutstanding"] as {
      units: Record<string, Record<string, unknown>[]>;
    };
    const unit = Object.keys(shares.units)[0]!;
    const common = { end: "2025-10-17", form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31", accn: "0000320193-25-000099" };
    shares.units[unit] = [
      { ...common, val: 1_000_000 },
      { ...common, val: 1_000 },
      { ...common, val: 1_000 },
    ];
    const out = await applyKeylessFallbacks(withFacts(f));
    const caveats = out.gaps.filter((g) => g.field.startsWith("keyless.sharesOutstanding.classes.caveat"));
    expect(caveats.map((g) => g.severity)).toEqual(["warn", "warn"]);
    expect(caveats[0]!.reason).toMatch(/indistinguishable from a SECOND SHARE CLASS/);
    expect(caveats[1]!.reason).toMatch(/differ by a factor of 1000/);
    // Rule: every caveat reaches the notes as well as the manifest.
    for (const caveat of caveats) {
      expect(out.notes).toContain(`keyless share count: ${caveat.reason}`);
    }
  });

  it("files no class caveat for a plain multi-class filing", async () => {
    const f = appleFacts();
    const shares = f.facts["dei"]!["EntityCommonStockSharesOutstanding"] as {
      units: Record<string, Record<string, unknown>[]>;
    };
    const unit = Object.keys(shares.units)[0]!;
    const common = { end: "2025-10-17", form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31", accn: "0000320193-25-000099" };
    shares.units[unit] = [
      { ...common, val: 9_000 },
      { ...common, val: 4_000 },
      { ...common, val: 1_776 },
    ];
    const out = await applyKeylessFallbacks(withFacts(f));
    expect(out.gaps.some((g) => g.field.startsWith("keyless.sharesOutstanding.classes.caveat"))).toBe(false);
  });
});
