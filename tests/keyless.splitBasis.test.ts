import { describe, expect, it } from "vitest";
import { SPLIT_RATIO_TAG } from "@/edgar/splits";
import { applyKeylessFallbacks, type KeylessInputs, type KeylessMembers } from "@/pipeline/keyless";
import { createYahooClient } from "@/providers/yahoo";
import { makeLimiter } from "@/providers/http";
import type { CompanyFacts } from "@/edgar/xbrl";
import type { FetchResult } from "@/types/core";
import type { FmpPayload, FmpRawRow } from "@/providers/fmp";

/**
 * Keyless market values across stock splits. Every expectation is written out
 * by hand from the scenario, not recomputed through the code under test: an
 * issuer worth one billion dollars is worth one billion dollars whichever share
 * basis it is counted on — 10,000,000 shares at $100 and 40,000,000 shares at
 * $25 are the same equity value, and a pre-split count priced at a
 * split-adjusted close has to land on it too.
 */
const EQUITY_VALUE = 1_000_000_000;

const COVER = "EntityCommonStockSharesOutstanding";
const FLOAT = "EntityPublicFloat";
const DILUTED = "WeightedAverageNumberOfDilutedSharesOutstanding";
const Q1_2026 = { start: "2026-01-01", end: "2026-03-31" };

interface Pt { start?: string; end: string; val: number; form?: string; filed: string }

function facts(usGaap: Record<string, Pt[]>, dei: Record<string, Pt[]> = {}): CompanyFacts {
  const unit = (tag: string): string => (tag === SPLIT_RATIO_TAG ? "pure" : tag === FLOAT ? "USD" : /Shares/.test(tag) ? "shares" : "USD");
  const concept = (tag: string, points: Pt[]) => ({
    label: tag,
    units: {
      [unit(tag)]: points.map((p, i) => ({
        start: p.start,
        end: p.end,
        val: p.val,
        accn: `0000000000-26-${tag.slice(0, 6)}${i}`,
        fy: Number(p.end.slice(0, 4)),
        fp: "Q2",
        form: p.form ?? "10-Q",
        filed: p.filed,
      })),
    },
  });
  return {
    cik: 999001,
    entityName: "Split Test Corp",
    facts: {
      "us-gaap": Object.fromEntries(Object.entries(usGaap).map(([t, p]) => [t, concept(t, p)])),
      dei: Object.fromEntries(Object.entries(dei).map(([t, p]) => [t, concept(t, p)])),
    },
  };
}

/** Every calendar day from `from` to `to`, inclusive. */
function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (let ms = Date.parse(`${from}T00:00:00Z`); ms <= Date.parse(`${to}T00:00:00Z`); ms += 86_400_000) {
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Yahoo serving a daily close per `close(date)` over `bars` and a live price
 * `price` for the session `session`. `close` is whatever basis the test says
 * the vendor served; the client passes it through untouched.
 */
function yahoo(opts: { bars: string[]; close: (date: string) => number; price: number; session: string; now: Date }) {
  const impl = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const symbol = /chart\/([^?]+)/.exec(url)![1]!;
    const bars = url.includes("range=5d") ? opts.bars.slice(-5) : opts.bars;
    const timestamp = bars.map((d) => Date.parse(`${d}T13:30:00Z`) / 1000);
    const close = bars.map((d) => opts.close(d));
    const meta = {
      currency: "USD",
      symbol,
      exchangeName: "NMS",
      fullExchangeName: "NasdaqGS",
      instrumentType: "EQUITY",
      firstTradeDate: 345479400,
      regularMarketTime: Date.parse(`${opts.session}T20:00:00Z`) / 1000,
      gmtoffset: -14400,
      regularMarketPrice: opts.price,
      chartPreviousClose: opts.price,
      longName: "Split Test Corp",
    };
    const body = { chart: { result: [{ meta, timestamp, indicators: { quote: [{ open: close, high: close, low: close, close, volume: close.map(() => 1000) }], adjclose: [{ adjclose: close }] } }], error: null } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return createYahooClient({ fetchImpl: impl, limiter: makeLimiter(1000, 1000), now: () => opts.now, maxRetries: 0 });
}

const gap = <T extends FmpRawRow>(field: string): FetchResult<FmpPayload<T>> => ({
  ok: false,
  gap: { field, reason: "no API key + no fixture", severity: "warn" },
});
const vendorRows = <T extends FmpRawRow>(rows: T[], fetchedAt: string): FetchResult<FmpPayload<T>> => ({
  ok: true,
  value: { data: { rows, raw: null }, asOf: rows[0]?.["date"] as string, source: "fmp", endpoint: "/stable/x", fetchedAt },
});

function allGaps(): KeylessMembers {
  return {
    profile: gap("fmp.profile(SPLT)"),
    quote: gap("fmp.quote(SPLT)"),
    incomeAnnual: gap("fmp.incomeStatement(SPLT,annual)"),
    incomeQuarterly: gap("fmp.incomeStatement(SPLT,quarter)"),
    balanceAnnual: gap("fmp.balanceSheet(SPLT,annual)"),
    balanceQuarterly: gap("fmp.balanceSheet(SPLT,quarter)"),
    cashflowAnnual: gap("fmp.cashFlow(SPLT,annual)"),
    cashflowQuarterly: gap("fmp.cashFlow(SPLT,quarter)"),
    eodPrices: gap("fmp.historicalPriceEodFull(SPLT)"),
    spy: gap("fmp.historicalPriceEodFull(SPY)"),
    sectorEtf: gap("fmp.historicalPriceEodFull(XLK)"),
    enterpriseValues: gap("fmp.enterpriseValues(SPLT,quarter)"),
    marketCapHistory: gap("fmp.historicalMarketCap(SPLT)"),
    sharesFloat: gap("fmp.sharesFloat(SPLT)"),
  };
}

interface Scenario {
  today: string;
  facts: CompanyFacts;
  /** Daily closes as the vendor serves them. */
  close: (date: string) => number;
  price: number;
  /** The live quote's session; defaults to `today`. */
  session?: string;
  bars?: string[];
  fmp?: Partial<KeylessMembers>;
}

function run(s: Scenario) {
  const now = new Date(`${s.today}T21:00:00Z`);
  const inputs: KeylessInputs = {
    symbol: "SPLT",
    today: s.today,
    eodFrom: "2026-03-01",
    sectorEtfSymbol: null,
    fmp: { ...allGaps(), ...s.fmp },
    fmpKeyless: true,
    statementSource: "auto",
    edgarConfirmedIssuer: true,
    edgar: {
      cik: { ok: true, value: { data: { cik10: "0000999001", cik: 999001, ticker: "SPLT", title: "Split Test Corp" }, asOf: s.today, source: "edgar", endpoint: "company_tickers.json", fetchedAt: now.toISOString() } },
      registrant: { name: "Split Test Corp", cik10: "0000999001", sic: "3571", sicDescription: "ELECTRONIC COMPUTERS", exchanges: ["Nasdaq"], tickers: ["SPLT"], fiscalYearEnd: "1231", stateOfIncorporation: "DE", forms: ["10-K", "10-Q", "8-K"] },
      companyFacts: { ok: true, value: { data: s.facts, asOf: s.today, source: "edgar", endpoint: "companyfacts", fetchedAt: now.toISOString() } },
    },
    yahoo: yahoo({ bars: s.bars ?? days("2026-03-01", addDay(s.today, -1)), close: s.close, price: s.price, session: s.session ?? s.today, now }),
    annualPeriods: 4,
    quarterlyPeriods: 8,
    now: () => now,
    resolveSectorEtf: () => null,
  };
  return applyKeylessFallbacks(inputs);
}

function addDay(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

type Outcome = Awaited<ReturnType<typeof applyKeylessFallbacks>>;
const profileCap = (out: Outcome): unknown => (out.members.profile.ok ? out.members.profile.value.data.rows[0]!.marketCap : "no profile");
const quoteCap = (out: Outcome): unknown => (out.members.quote.ok ? out.members.quote.value.data.rows[0]!.marketCap : "no quote");
const history = (out: Outcome) => (out.members.marketCapHistory.ok ? out.members.marketCapHistory.value.data.rows : []);
const gapFor = (out: Outcome, field: string) => out.gaps.find((g) => g.field === field);

/** A 4-for-1 split effective 2026-06-15, confirmed by the Q1 diluted count restated from 10M to 40M. */
function forwardSplit(cover: Pt[], extraDei: Record<string, Pt[]> = {}): CompanyFacts {
  return facts(
    {
      [SPLIT_RATIO_TAG]: [{ end: "2026-06-15", val: 4, filed: "2026-08-05" }],
      [DILUTED]: [
        { ...Q1_2026, val: 10_000_000, filed: "2026-05-05" },
        { ...Q1_2026, val: 40_000_000, filed: "2026-08-05" },
      ],
    },
    { [COVER]: cover, ...extraDei },
  );
}
const PRE_AND_POST_SPLIT_COVERS: Pt[] = [
  { end: "2026-04-24", val: 10_000_000, filed: "2026-05-05" },
  { end: "2026-07-24", val: 40_000_000, filed: "2026-08-05" },
];

describe("keyless market values across stock splits", () => {
  it("the example holds: 10M shares at $100 and 40M shares at $25 are both $1B", () => {
    expect(10_000_000 * 100).toBe(EQUITY_VALUE);
    expect(40_000_000 * 25).toBe(EQUITY_VALUE);
    expect(100_000_000 * 10).toBe(EQUITY_VALUE);
  });

  it("no-split control: 10M shares at $100 is $1B on every figure, with no split entries", async () => {
    const out = await run({
      today: "2026-09-30",
      facts: facts({}, { [COVER]: [{ end: "2026-07-24", val: 10_000_000, filed: "2026-08-05" }] }),
      close: () => 100,
      price: 100,
    });
    expect(profileCap(out)).toBe(EQUITY_VALUE);
    expect(quoteCap(out)).toBe(EQUITY_VALUE);
    expect(history(out).length).toBeGreaterThan(200);
    expect(history(out).every((r) => r.marketCap === EQUITY_VALUE)).toBe(true);
    expect(out.gaps.filter((g) => /stockSplits|shareBasis|\.marketCap$/.test(g.field))).toEqual([]);
  });

  it("future split: tagged 2026-09-01 for 2027-01-15, it is not applied on 2026-09-30 — $1B, not $4B", async () => {
    const future = facts(
      { [SPLIT_RATIO_TAG]: [{ end: "2027-01-15", val: 4, filed: "2026-09-01", form: "8-K" }] },
      { [COVER]: [{ end: "2026-07-24", val: 10_000_000, filed: "2026-08-05" }] },
    );
    const out = await run({ today: "2026-09-30", facts: future, close: () => 100, price: 100 });
    expect(profileCap(out)).toBe(EQUITY_VALUE);
    expect(quoteCap(out)).toBe(EQUITY_VALUE);
    expect(history(out).every((r) => r.marketCap === EQUITY_VALUE)).toBe(true);
    expect(gapFor(out, "keyless.stockSplits(2027-01-15)")).toMatchObject({ severity: "info", expected: true });
    expect(gapFor(out, "keyless.stockSplits(2027-01-15)")!.reason).toMatch(/not yet effective as of 2026-09-30: not applied/);

    // After the effective date the vendor's closes are split-adjusted ($25) and
    // the 10M cover count filed before the split counts as 40M.
    const after = await run({ today: "2027-02-01", facts: future, close: () => 25, price: 25 });
    expect(profileCap(after)).toBe(EQUITY_VALUE);
    expect(history(after).every((r) => r.marketCap === EQUITY_VALUE)).toBe(true);
  });

  it("forward split: pre-split 10M at split-adjusted $25 and post-split 40M at $25 are both $1B", async () => {
    const out = await run({ today: "2026-09-30", facts: forwardSplit(PRE_AND_POST_SPLIT_COVERS), close: () => 25, price: 25 });
    expect(profileCap(out)).toBe(EQUITY_VALUE);
    expect(quoteCap(out)).toBe(EQUITY_VALUE);
    const rows = history(out);
    expect(rows.find((r) => r.date === "2026-05-01")).toEqual({ symbol: "SPLT", date: "2026-05-01", marketCap: EQUITY_VALUE });
    expect(rows.find((r) => r.date === "2026-08-01")).toEqual({ symbol: "SPLT", date: "2026-08-01", marketCap: EQUITY_VALUE });
    expect(rows.every((r) => r.marketCap === EQUITY_VALUE)).toBe(true);
  });

  it("reverse split: 100M pre-split shares at split-adjusted $100 are 10M post-split shares — $1B", async () => {
    const reverse = facts(
      {
        // Tagged as the whole number, as filers do; the restatement shows ×0.1.
        [SPLIT_RATIO_TAG]: [{ end: "2026-06-15", val: 10, filed: "2026-08-05" }],
        [DILUTED]: [
          { ...Q1_2026, val: 100_000_000, filed: "2026-05-05" },
          { ...Q1_2026, val: 10_000_000, filed: "2026-08-05" },
        ],
      },
      {
        [COVER]: [
          { end: "2026-04-24", val: 100_000_000, filed: "2026-05-05" },
          { end: "2026-07-24", val: 10_000_000, filed: "2026-08-05" },
        ],
      },
    );
    const out = await run({ today: "2026-09-30", facts: reverse, close: () => 100, price: 100 });
    expect(profileCap(out)).toBe(EQUITY_VALUE);
    expect(history(out).find((r) => r.date === "2026-05-01")!.marketCap).toBe(EQUITY_VALUE);
    expect(history(out).every((r) => r.marketCap === EQUITY_VALUE)).toBe(true);
  });

  it("already-adjusted vendor share counts are not scaled again", async () => {
    // FMP served the Q1 diluted count on 2026-09-30, after the split, already on
    // the post-split basis (40M); EDGAR knows about the split. 40M × $25 = $1B,
    // not 160M × $25.
    const balance = vendorRows([{ symbol: "SPLT", date: "2026-03-31", totalDebt: 0, cashAndCashEquivalents: 0 }], "2026-09-30T20:00:00Z");
    const income = vendorRows([{ symbol: "SPLT", date: "2026-03-31", weightedAverageShsOutDil: 40_000_000 }], "2026-09-30T20:00:00Z");
    const out = await run({
      today: "2026-09-30",
      facts: forwardSplit(PRE_AND_POST_SPLIT_COVERS),
      close: () => 25,
      price: 25,
      fmp: { balanceQuarterly: balance, incomeQuarterly: income },
    });
    expect(out.members.enterpriseValues.ok && out.members.enterpriseValues.value.data.rows).toEqual([
      {
        symbol: "SPLT",
        date: "2026-03-31",
        stockPrice: 25,
        numberOfShares: 40_000_000,
        marketCapitalization: EQUITY_VALUE,
        addTotalDebt: 0,
        minusCashAndCashEquivalents: 0,
        enterpriseValue: EQUITY_VALUE,
      },
    ]);
  });

  it("withholds an enterprise value whose vendor share count predates a split the prices reflect", async () => {
    // Served 2026-06-01, before the split: 10M is the pre-split count, and the
    // $25 close is split-adjusted. 10M × $25 would report $250M.
    const balance = vendorRows([{ symbol: "SPLT", date: "2026-03-31", totalDebt: 0, cashAndCashEquivalents: 0 }], "2026-06-01T20:00:00Z");
    const income = vendorRows([{ symbol: "SPLT", date: "2026-03-31", weightedAverageShsOutDil: 10_000_000 }], "2026-06-01T20:00:00Z");
    const out = await run({
      today: "2026-09-30",
      facts: forwardSplit(PRE_AND_POST_SPLIT_COVERS),
      close: () => 25,
      price: 25,
      fmp: { balanceQuarterly: balance, incomeQuarterly: income },
    });
    expect(out.members.enterpriseValues.ok).toBe(false);
    expect(gapFor(out, "keyless.enterpriseValues")!.reason).toMatch(/1 withheld for their share basis/);
    expect(gapFor(out, "keyless.enterpriseValues.shareBasis")).toMatchObject({ severity: "warn" });
    expect(gapFor(out, "keyless.enterpriseValues.shareBasis")!.reason).toBe(
      "1 quarterly enterprise value(s) withheld (2026-03-31) because price and share count could not be put on one share basis: the source figure is split-adjusted only as of 2026-06-01, before the 4-for-1 split of 2026-06-15, while the share counts are on the post-split basis of 2026-09-30",
    );
  });

  it("withholds every history-derived figure when the price series was served before a split", async () => {
    // A cached series from 2026-06-10 carries the unadjusted $100 closes; the
    // share counts are on the post-split basis, so close × shares would be $4B.
    const stale = vendorRows(
      days("2026-03-01", "2026-06-10").reverse().map((date) => ({ symbol: "SPLT", date, close: 100 })),
      "2026-06-10T21:00:00Z",
    );
    const balance = vendorRows([{ symbol: "SPLT", date: "2026-03-31", totalDebt: 0, cashAndCashEquivalents: 0 }], "2026-09-30T20:00:00Z");
    const out = await run({
      today: "2026-09-30",
      facts: forwardSplit(PRE_AND_POST_SPLIT_COVERS, { [FLOAT]: [{ end: "2026-03-31", val: 500_000_000, filed: "2026-08-05" }] }),
      close: () => 25,
      price: 25,
      fmp: { eodPrices: stale, balanceQuarterly: balance },
    });
    const why = "the source figure is split-adjusted only as of 2026-06-10, before the 4-for-1 split of 2026-06-15, while the share counts are on the post-split basis of 2026-09-30";
    expect(out.members.marketCapHistory.ok).toBe(false);
    expect(gapFor(out, "keyless.marketCapHistory")!.reason).toBe(`market-cap history withheld: the price history is not on the share counts' basis — ${why}`);
    expect(out.members.enterpriseValues.ok).toBe(false);
    expect(gapFor(out, "keyless.enterpriseValues")!.reason).toBe(`enterprise values withheld: the price history is not on the share counts' basis — ${why}`);
    // The float's $500M ÷ the stale $100 close would be 5M pre-split shares
    // against 40M post-split outstanding: a 12.5% free float instead of 50%.
    const float = out.members.sharesFloat.ok ? out.members.sharesFloat.value.data.rows[0]! : null;
    expect(float).toMatchObject({ outstandingShares: 40_000_000, floatShares: null, freeFloat: null });
    expect(gapFor(out, "keyless.sharesFloat.publicFloat")!.reason).toContain(`withheld because the price that would convert it is not on the share counts' basis: ${why}`);
    // The live quote is on the post-split basis: the spot figure stands.
    expect(profileCap(out)).toBe(EQUITY_VALUE);
  });

  it("withholds the history when the price series' retrieval date is unknown and a split was applied", async () => {
    const undated = vendorRows([{ symbol: "SPLT", date: "2026-09-29", close: 25 }], "");
    const out = await run({ today: "2026-09-30", facts: forwardSplit(PRE_AND_POST_SPLIT_COVERS), close: () => 25, price: 25, fmp: { eodPrices: undated } });
    expect(out.members.marketCapHistory.ok).toBe(false);
    expect(gapFor(out, "keyless.marketCapHistory")!.reason).toMatch(/the date its source split-adjusted it is unknown$/);
  });

  it("withholds a spot market cap priced on a quote from before the split", async () => {
    // Split tagged in an 8-K for 2026-06-15; the analysis runs 2026-06-20 but the
    // quote is a stale $100 from the 2026-06-12 session.
    const f = facts(
      { [SPLIT_RATIO_TAG]: [{ end: "2026-06-15", val: 4, filed: "2026-06-16", form: "8-K" }] },
      { [COVER]: [{ end: "2026-04-24", val: 10_000_000, filed: "2026-05-05" }] },
    );
    const out = await run({ today: "2026-06-20", facts: f, close: () => 25, price: 100, session: "2026-06-12" });
    expect(profileCap(out)).toBeNull();
    expect(quoteCap(out)).toBeUndefined();
    expect(gapFor(out, "keyless.profile.marketCap")!.reason).toBe(
      "1 market cap withheld (2026-06-12) because price and share count could not be put on one share basis: the source figure is split-adjusted only as of 2026-06-12, before the 4-for-1 split of 2026-06-15, while the share counts are on the post-split basis of 2026-06-20",
    );
    expect(gapFor(out, "keyless.quote.marketCap")).toMatchObject({ severity: "warn" });
    // The split-adjusted history is on the post-split basis: 10M × 4 × $25.
    expect(history(out).every((r) => r.marketCap === EQUITY_VALUE)).toBe(true);
  });

  it("withholds figures resting on a cover count measured before a split and filed after it", async () => {
    // Measured 2026-06-10, five days before the split, filed 2026-06-20: the
    // 10M could be the pre-split count (then 40M today) or already restated.
    // As filed it would report 10M × $25 = $250M.
    const out = await run({
      today: "2026-09-30",
      facts: forwardSplit(
        [
          { end: "2026-04-24", val: 10_000_000, filed: "2026-05-05" },
          { end: "2026-06-10", val: 10_000_000, filed: "2026-06-20" },
        ],
        { [FLOAT]: [{ end: "2026-03-31", val: 500_000_000, filed: "2026-06-20" }] },
      ),
      close: () => 25,
      price: 25,
    });
    const why = "the share count was measured 2026-06-10, before the 4-for-1 split of 2026-06-15, but filed 2026-06-20, after it, so whether it is stated on the pre- or post-split basis cannot be established";
    expect(profileCap(out)).toBeNull();
    expect(quoteCap(out)).toBeUndefined();
    expect(gapFor(out, "keyless.profile.marketCap")!.reason).toContain(why);
    expect(gapFor(out, "keyless.quote.marketCap")!.reason).toContain(why);
    // Days the 2026-04-24 count governs are on a known basis: 40M × $25.
    const rows = history(out);
    expect(rows.find((r) => r.date === "2026-06-09")!.marketCap).toBe(EQUITY_VALUE);
    expect(rows.every((r) => r.marketCap === EQUITY_VALUE)).toBe(true);
    expect(rows.some((r) => r.date! >= "2026-06-10")).toBe(false);
    expect(gapFor(out, "keyless.marketCapHistory.shareBasis")!.reason).toBe(
      `${days("2026-06-10", "2026-09-29").length} market-cap day(s) withheld (2026-06-10 … 2026-09-29) because price and share count could not be put on one share basis: ${why}`,
    );
    // $500M ÷ $25 = 20M float shares is on a known basis; its share of an
    // outstanding count of unknown basis is not.
    const float = out.members.sharesFloat.ok ? out.members.sharesFloat.value.data.rows[0]! : null;
    expect(float).toMatchObject({ floatShares: 20_000_000, freeFloat: null });
    expect(gapFor(out, "keyless.sharesFloat.freeFloat")!.reason).toContain(why);
  });

  it("withholds every market value when a split's tagged dates straddle the analysis date", async () => {
    const f = facts(
      {
        [SPLIT_RATIO_TAG]: [
          { end: "2026-09-20", val: 3, filed: "2026-09-21", form: "8-K" },
          { end: "2026-10-20", val: 3, filed: "2026-09-21", form: "8-K" },
        ],
      },
      { [COVER]: [{ end: "2026-07-24", val: 10_000_000, filed: "2026-08-05" }] },
    );
    const out = await run({ today: "2026-09-30", facts: f, close: () => 100, price: 100 });
    expect(profileCap(out)).toBeNull();
    expect(quoteCap(out)).toBeUndefined();
    expect(out.members.marketCapHistory.ok).toBe(false);
    expect(gapFor(out, "keyless.stockSplits(2026-09-20)")).toMatchObject({ severity: "warn", expected: false });
    expect(gapFor(out, "keyless.marketCapHistory")!.reason).toMatch(/before the split tagged 2026-09-20 and 2026-10-20/);
  });
});
