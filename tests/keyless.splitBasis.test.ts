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
 * $25 are the same equity value — and where the basis of a figure cannot be
 * established the figure is withheld, never $4 billion or $250 million.
 */
const EQUITY_VALUE = 1_000_000_000;

const COVER = "EntityCommonStockSharesOutstanding";
const FLOAT = "EntityPublicFloat";
const DILUTED = "WeightedAverageNumberOfDilutedSharesOutstanding";
const Q1_2026 = { start: "2026-01-01", end: "2026-03-31" };
const FY2025 = { start: "2025-01-01", end: "2025-12-31", form: "10-K", filed: "2026-02-20" };

interface Pt { start?: string; end: string; val: number; form?: string; filed: string }

function facts(usGaap: Record<string, Pt[]>, dei: Record<string, Pt[]> = {}): CompanyFacts {
  const unit = (tag: string): string =>
    tag === SPLIT_RATIO_TAG ? "pure" : tag === FLOAT ? "USD" : /^EarningsPerShare/.test(tag) ? "USD/shares" : /Shares/.test(tag) ? "shares" : "USD";
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

function addDay(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

interface YahooSplit { session: string; numerator: number; denominator: number }

/**
 * Yahoo serving a daily close per `close(date)` over `bars`, a live price
 * `price` for the session `session`, and the split events `splits` (stamped at
 * the session's open, as the chart carries them). `failSplitList` answers the
 * full-history request with HTTP 429; `failAll` answers every request so.
 */
function yahoo(opts: {
  bars: string[];
  close: (date: string) => number;
  price: number;
  session: string;
  now: Date;
  splits?: YahooSplit[];
  failSplitList?: boolean;
  failAll?: boolean;
}) {
  const impl = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (opts.failAll === true || (opts.failSplitList === true && url.includes("range=max"))) {
      return new Response("Too Many Requests", { status: 429 });
    }
    const symbol = /chart\/([^?]+)/.exec(url)![1]!;
    const isQuote = url.includes("range=5d");
    const isFull = url.includes("range=max");
    const bars = isFull ? days("1995-01-01", opts.session).filter((d) => d.endsWith("-01") && /-(01|04|07|10)-/.test(d)) : isQuote ? opts.bars.slice(-5) : opts.bars;
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
    const events =
      opts.splits === undefined || opts.splits.length === 0
        ? {}
        : {
            events: {
              splits: Object.fromEntries(
                opts.splits.map((e) => {
                  const date = Date.parse(`${e.session}T13:30:00Z`) / 1000;
                  return [String(date), { date, numerator: e.numerator, denominator: e.denominator, splitRatio: `${e.numerator}:${e.denominator}` }];
                }),
              ),
            },
          };
    const body = { chart: { result: [{ meta, timestamp, ...events, indicators: { quote: [{ open: close, high: close, low: close, close, volume: close.map(() => 1000) }], adjclose: [{ adjclose: close }] } }], error: null } };
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
  /** When companyfacts was fetched (a stale cache serves an older payload). Defaults to `today`. */
  factsFetched?: string;
  /** Daily closes as the vendor serves them. */
  close: (date: string) => number;
  price: number;
  /** The live quote's session; defaults to `today`. */
  session?: string;
  bars?: string[];
  splits?: YahooSplit[];
  failSplitList?: boolean;
  failAll?: boolean;
  fmp?: Partial<KeylessMembers>;
}

function run(s: Scenario) {
  const now = new Date(`${s.today}T21:00:00Z`);
  const factsFetchedAt = `${s.factsFetched ?? s.today}T12:00:00.000Z`;
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
      companyFacts: { ok: true, value: { data: s.facts, asOf: (s.factsFetched ?? s.today), source: "edgar", endpoint: "companyfacts", fetchedAt: factsFetchedAt } },
    },
    yahoo: yahoo({
      bars: s.bars ?? days("2026-03-01", addDay(s.session ?? s.today, 0)),
      close: s.close,
      price: s.price,
      session: s.session ?? s.today,
      now,
      ...(s.splits !== undefined ? { splits: s.splits } : {}),
      ...(s.failSplitList === true ? { failSplitList: true } : {}),
      ...(s.failAll === true ? { failAll: true } : {}),
    }),
    annualPeriods: 4,
    quarterlyPeriods: 8,
    now: () => now,
    resolveSectorEtf: () => null,
  };
  return applyKeylessFallbacks(inputs);
}

type Outcome = Awaited<ReturnType<typeof applyKeylessFallbacks>>;
const profileCap = (out: Outcome): unknown => (out.members.profile.ok ? out.members.profile.value.data.rows[0]!.marketCap : "no profile");
const quoteCap = (out: Outcome): unknown => (out.members.quote.ok ? out.members.quote.value.data.rows[0]!.marketCap : "no quote");
const history = (out: Outcome) => (out.members.marketCapHistory.ok ? out.members.marketCapHistory.value.data.rows : []);
const gapFor = (out: Outcome, field: string) => out.gaps.find((g) => g.field === field);

/** A 4-for-1 whose first split-adjusted session was 2026-06-15, confirmed by the Q1 diluted count restated from 10M to 40M. */
const FORWARD_SPLIT_EVENT: YahooSplit = { session: "2026-06-15", numerator: 4, denominator: 1 };
function forwardSplit(cover: Pt[], extraDei: Record<string, Pt[]> = {}, extraGaap: Record<string, Pt[]> = {}): CompanyFacts {
  return facts(
    {
      ...extraGaap,
      [SPLIT_RATIO_TAG]: [{ end: "2026-06-12", val: 4, filed: "2026-08-05" }],
      [DILUTED]: [
        { ...Q1_2026, val: 10_000_000, filed: "2026-05-05" },
        { ...Q1_2026, val: 40_000_000, filed: "2026-08-05" },
        { ...FY2025, val: 10_000_000 },
      ],
      // FY2025 as filed in the 10-K of 2026-02-20, before the split: the
      // statements carry a 2025-12-31 row whose 10M diluted count is pre-split.
      RevenueFromContractWithCustomerExcludingAssessedTax: [{ ...FY2025, val: 2_000 }],
      NetIncomeLoss: [{ ...FY2025, val: 80 }],
      WeightedAverageNumberOfSharesOutstandingBasic: [{ ...FY2025, val: 9_500_000 }],
    },
    { [COVER]: cover, ...extraDei },
  );
}
const PRE_AND_POST_SPLIT_COVERS: Pt[] = [
  { end: "2026-04-24", val: 10_000_000, filed: "2026-05-05" },
  { end: "2026-07-24", val: 40_000_000, filed: "2026-08-05" },
];

describe("keyless market values across stock splits: controls", () => {
  it("the example holds: 10M shares at $100, 40M at $25 and 100M at $10 are all $1B", () => {
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

  it("forward split: a pre-split 10M at the split-adjusted $25 and the post-split 40M at $25 are both $1B", async () => {
    const out = await run({ today: "2026-09-30", facts: forwardSplit(PRE_AND_POST_SPLIT_COVERS), close: () => 25, price: 25, splits: [FORWARD_SPLIT_EVENT] });
    expect(profileCap(out)).toBe(EQUITY_VALUE);
    expect(quoteCap(out)).toBe(EQUITY_VALUE);
    const rows = history(out);
    expect(rows.find((r) => r.date === "2026-05-01")).toEqual({ symbol: "SPLT", date: "2026-05-01", marketCap: EQUITY_VALUE });
    expect(rows.find((r) => r.date === "2026-08-01")).toEqual({ symbol: "SPLT", date: "2026-08-01", marketCap: EQUITY_VALUE });
    expect(rows.every((r) => r.marketCap === EQUITY_VALUE)).toBe(true);
    // The statements' pre-split year is on the same basis: 38M basic (9.5M × 4), not 9.5M or 152M.
    expect(out.members.incomeAnnual.ok && out.members.incomeAnnual.value.data.rows.find((r) => r.date === "2025-12-31")?.weightedAverageShsOut).toBe(38_000_000);
  });

  it("reverse split: 100M pre-split shares at the split-adjusted $100 are 10M post-split shares — $1B", async () => {
    const reverse = facts(
      {
        // Tagged as the whole number, as filers do; the restatement and the vendor's 1:10 both show ×0.1.
        [SPLIT_RATIO_TAG]: [{ end: "2026-06-12", val: 10, filed: "2026-08-05" }],
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
    const out = await run({ today: "2026-09-30", facts: reverse, close: () => 100, price: 100, splits: [{ session: "2026-06-15", numerator: 1, denominator: 10 }] });
    expect(profileCap(out)).toBe(EQUITY_VALUE);
    expect(history(out).find((r) => r.date === "2026-05-01")!.marketCap).toBe(EQUITY_VALUE);
    expect(history(out).every((r) => r.marketCap === EQUITY_VALUE)).toBe(true);
  });
});

describe("P1 (permanent): a tagged date that is not the trading date", () => {
  // The 8-K tags the board's approval on 2026-09-10; the shares have not yet
  // traded split-adjusted by 2026-09-30 and the market prices 10M at $100.
  const approved = facts(
    { [SPLIT_RATIO_TAG]: [{ end: "2026-09-10", val: 4, filed: "2026-09-11", form: "8-K" }] },
    { [COVER]: [{ end: "2026-07-24", val: 10_000_000, filed: "2026-08-05" }] },
  );

  it("keeps the market cap at $1B, not $4B, while the vendor lists no split through the quote's session", async () => {
    const out = await run({ today: "2026-09-30", facts: approved, close: () => 100, price: 100 });
    expect(profileCap(out)).toBe(EQUITY_VALUE);
    expect(quoteCap(out)).toBe(EQUITY_VALUE);
    expect(history(out).every((r) => r.marketCap === EQUITY_VALUE)).toBe(true);
    expect(gapFor(out, "keyless.stockSplits(2026-09-10)")!.reason).toMatch(/No vendor session pins its first split-adjusted session .* taken to fall within 2026-10-01 … 2026-11-09/);
  });

  it("withholds the market cap, rather than guessing, when no vendor list covers the quote's session", async () => {
    const out = await run({ today: "2026-09-30", facts: approved, close: () => 100, price: 100, failAll: true });
    expect(profileCap(out)).not.toBe(4 * EQUITY_VALUE);
    expect(profileCap(out)).toBeNull();
    expect(out.members.sharesFloat.ok).toBe(false);
    expect(gapFor(out, "keyless.sharesFloat")!.reason).toMatch(/withheld because their split basis on 2026-09-30 could not be established: no vendor split list is available/);
  });

  it("the original case: a split filed 2026-09-01 for 2027-01-15 does not move the 2026-09-30 market cap", async () => {
    const future = facts(
      { [SPLIT_RATIO_TAG]: [{ end: "2027-01-15", val: 4, filed: "2026-09-01", form: "8-K" }] },
      { [COVER]: [{ end: "2026-07-24", val: 10_000_000, filed: "2026-08-05" }] },
    );
    const out = await run({ today: "2026-09-30", facts: future, close: () => 100, price: 100 });
    expect(profileCap(out)).toBe(EQUITY_VALUE);
    expect(history(out).every((r) => r.marketCap === EQUITY_VALUE)).toBe(true);
  });
});

describe("P2 (permanent): a split the market has priced but companyfacts does not carry", () => {
  // 4-for-1, first split-adjusted session 2026-09-15. Yahoo lists it and its
  // closes and quote are split-adjusted ($25); the ratio will be tagged only
  // in the next 10-Q, so companyfacts holds the pre-split 10M cover count.
  const untagged = facts({}, { [COVER]: [{ end: "2026-07-24", val: 10_000_000, filed: "2026-08-05" }] });
  const SEPT_SPLIT: YahooSplit = { session: "2026-09-15", numerator: 4, denominator: 1 };

  it("fresh facts lacking the event: $1B, not $250M", async () => {
    const out = await run({ today: "2026-09-30", facts: untagged, close: () => 25, price: 25, splits: [SEPT_SPLIT] });
    expect(profileCap(out)).toBe(EQUITY_VALUE);
    expect(quoteCap(out)).toBe(EQUITY_VALUE);
    expect(history(out).every((r) => r.marketCap === EQUITY_VALUE)).toBe(true);
    expect(gapFor(out, "keyless.stockSplits(2026-09-15)")).toMatchObject({ severity: "info", expected: true });
  });

  it("stale facts (a payload fetched before the split) lacking the event: still $1B", async () => {
    const out = await run({ today: "2026-09-30", facts: untagged, factsFetched: "2026-09-10", close: () => 25, price: 25, splits: [SEPT_SPLIT] });
    expect(profileCap(out)).toBe(EQUITY_VALUE);
    expect(history(out).every((r) => r.marketCap === EQUITY_VALUE)).toBe(true);
  });

  it("both sources describing the same split apply it once: $1B, not $4B", async () => {
    const tagged = facts(
      {
        [SPLIT_RATIO_TAG]: [{ end: "2026-09-11", val: 4, filed: "2026-09-29", form: "8-K" }],
      },
      { [COVER]: [{ end: "2026-07-24", val: 10_000_000, filed: "2026-08-05" }] },
    );
    const out = await run({ today: "2026-09-30", facts: tagged, close: () => 25, price: 25, splits: [SEPT_SPLIT] });
    expect(profileCap(out)).toBe(EQUITY_VALUE);
    expect(out.gaps.filter((g) => g.field.startsWith("keyless.stockSplits"))).toHaveLength(1);
  });

  it("a failed full split list still leaves the recent sessions covered by the daily history and the quote", async () => {
    const out = await run({ today: "2026-09-30", facts: untagged, close: () => 25, price: 25, splits: [SEPT_SPLIT], failSplitList: true });
    expect(profileCap(out)).toBe(EQUITY_VALUE);
  });

  it("with no split list at all, withholds instead of pricing 10M at $25", async () => {
    const out = await run({ today: "2026-09-30", facts: untagged, close: () => 25, price: 25, splits: [SEPT_SPLIT], failAll: true });
    expect(profileCap(out)).not.toBe(250_000_000);
    expect(profileCap(out)).toBeNull();
  });
});

describe("keyless market values: stale sources and ambiguous counts", () => {
  it("already-adjusted vendor share counts are not scaled again", async () => {
    // FMP served FY2025 after the split, already on the post-split basis
    // (40M diluted, EPS 2.00). Each field agrees with the filer's own carried
    // to that basis: 10M as filed × 4 = 40M, and diluted EPS $8.00 as filed
    // (80 / 10M) ÷ 4 = $2.00. Kept exactly as served: not 160M, not $0.50.
    const annual = vendorRows([{ symbol: "SPLT", date: "2025-12-31", revenue: 2_000, weightedAverageShsOutDil: 40_000_000, epsDiluted: 2 }], "2026-09-30T20:00:00Z");
    const out = await run({
      today: "2026-09-30",
      facts: forwardSplit(PRE_AND_POST_SPLIT_COVERS, {}, { EarningsPerShareDiluted: [{ ...FY2025, val: 8 }] }),
      close: () => 25,
      price: 25,
      splits: [FORWARD_SPLIT_EVENT],
      fmp: { incomeAnnual: annual },
    });
    expect(out.members.incomeAnnual.ok && out.members.incomeAnnual.value.data.rows[0]).toMatchObject({ weightedAverageShsOutDil: 40_000_000, epsDiluted: 2 });
    expect(gapFor(out, "keyless.incomeAnnual.shareBasis")).toBeUndefined();
  });

  it("a matching diluted count does not vouch for an EPS the filer never stated", async () => {
    // The same post-split row, but companyfacts carries no diluted EPS for
    // FY2025: the 40M count is shown to be on the basis, the $2.00 is not, and
    // it is not rebuilt from net income. Count kept, EPS withheld.
    const annual = vendorRows([{ symbol: "SPLT", date: "2025-12-31", revenue: 2_000, weightedAverageShsOutDil: 40_000_000, epsDiluted: 2 }], "2026-09-30T20:00:00Z");
    const out = await run({
      today: "2026-09-30",
      facts: forwardSplit(PRE_AND_POST_SPLIT_COVERS),
      close: () => 25,
      price: 25,
      splits: [FORWARD_SPLIT_EVENT],
      fmp: { incomeAnnual: annual },
    });
    const row = out.members.incomeAnnual.ok ? out.members.incomeAnnual.value.data.rows[0]! : null;
    expect(row).toMatchObject({ revenue: 2_000, weightedAverageShsOutDil: 40_000_000 });
    expect(row!.epsDiluted).toBeUndefined();
    expect(gapFor(out, "keyless.incomeAnnual.shareBasis")!.reason).toMatch(/1 field\(s\) in 1 vendor row\(s\) \(2025-12-31 … 2025-12-31; epsDiluted\) withheld.*no filed epsDiluted for 2025-12-31 on the 2026-09-30 basis/);
  });

  it("withholds a vendor row's EPS and share counts when they are still on the pre-split basis", async () => {
    // Served 2026-06-01, before the split: 10M against the filer's 40M on the
    // 2026-09-30 basis; priced at $25 it would read $250M.
    const annual = vendorRows([{ symbol: "SPLT", date: "2025-12-31", revenue: 2_000, weightedAverageShsOutDil: 10_000_000, epsDiluted: 8 }], "2026-06-01T20:00:00Z");
    const out = await run({
      today: "2026-09-30",
      facts: forwardSplit(PRE_AND_POST_SPLIT_COVERS),
      close: () => 25,
      price: 25,
      splits: [FORWARD_SPLIT_EVENT],
      fmp: { incomeAnnual: annual },
    });
    const row = out.members.incomeAnnual.ok ? out.members.incomeAnnual.value.data.rows[0]! : null;
    expect(row).toMatchObject({ revenue: 2_000 });
    expect(row!.epsDiluted).toBeUndefined();
    expect(row!.weightedAverageShsOutDil).toBeUndefined();
    expect(gapFor(out, "keyless.incomeAnnual.shareBasis")!.reason).toMatch(/the vendor's diluted count for 2025-12-31 \(10000000\) differs from the filer's \(40000000\) on the 2026-09-30 basis/);
  });

  it("withholds a pre-split vendor row that no filed count can test, and the EV falls to a count on the closes' basis", async () => {
    // No quarterly statement row is filed for 2026-03-31 in this fixture, so
    // FMP's quarterly 40M cannot be shown to be split-adjusted: withheld. The
    // enterprise value then uses the cover count on the closes' basis: 40M × $25.
    const balance = vendorRows([{ symbol: "SPLT", date: "2026-03-31", totalDebt: 0, cashAndCashEquivalents: 0 }], "2026-09-30T20:00:00Z");
    const income = vendorRows([{ symbol: "SPLT", date: "2026-03-31", weightedAverageShsOutDil: 40_000_000, epsDiluted: 0.5 }], "2026-09-30T20:00:00Z");
    const out = await run({
      today: "2026-09-30",
      facts: forwardSplit(PRE_AND_POST_SPLIT_COVERS),
      close: () => 25,
      price: 25,
      splits: [FORWARD_SPLIT_EVENT],
      fmp: { balanceQuarterly: balance, incomeQuarterly: income },
    });
    expect(out.members.incomeQuarterly.ok && out.members.incomeQuarterly.value.data.rows[0]!.weightedAverageShsOutDil).toBeUndefined();
    expect(gapFor(out, "keyless.incomeQuarterly.shareBasis")!.reason).toMatch(/no filed diluted count for 2026-03-31 on the 2026-09-30 basis to test the vendor's 40000000/);
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

  it("withholds every history-derived figure when the price series was served before a split", async () => {
    // A cached FMP series from 2026-06-10 carries the unadjusted $100 closes.
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
      splits: [FORWARD_SPLIT_EVENT],
      fmp: { eodPrices: stale, balanceQuarterly: balance },
    });
    // On the stale series' own basis the pre-split counts are right: 10M × $100.
    expect(history(out).length).toBeGreaterThan(0);
    expect(history(out).every((r) => r.marketCap === EQUITY_VALUE)).toBe(true);
    // The statements' diluted count (40M, on the quote's basis) cannot meet those closes.
    expect(out.members.enterpriseValues.ok).toBe(true);
    expect(out.members.enterpriseValues.ok && out.members.enterpriseValues.value.data.rows[0]!.marketCapitalization).toBe(EQUITY_VALUE);
    // $500M ÷ the stale $100 close is 5M PRE-split float shares against 40M
    // post-split outstanding: withheld rather than published as 12.5%.
    const float = out.members.sharesFloat.ok ? out.members.sharesFloat.value.data.rows[0]! : null;
    expect(float).toMatchObject({ outstandingShares: 40_000_000, floatShares: null, freeFloat: null });
    expect(gapFor(out, "keyless.sharesFloat.publicFloat")!.reason).toMatch(/withheld because the price that would convert it is not on the share counts' basis: the 4-for-1 split first traded 2026-06-15 first traded between 2026-06-10 and 2026-09-30/);
    expect(profileCap(out)).toBe(EQUITY_VALUE);
  });

  it("withholds a spot market cap priced on a quote from before the split", async () => {
    // First split-adjusted session 2026-06-15; the analysis runs 2026-06-20 on
    // a stale $100 quote from the 2026-06-12 session while the statements are
    // on the post-split basis of a fresher FMP quote.
    const f = facts({}, { [COVER]: [{ end: "2026-04-24", val: 10_000_000, filed: "2026-05-05" }] });
    const fmpQuote = vendorRows([{ symbol: "SPLT", date: "2026-06-19", price: 25 }], "2026-06-19T20:00:00Z");
    const out = await run({ today: "2026-06-20", facts: f, close: () => 25, price: 100, session: "2026-06-12", bars: days("2026-03-01", "2026-06-19"), splits: [FORWARD_SPLIT_EVENT], fmp: { quote: fmpQuote } });
    expect(profileCap(out)).toBeNull();
    expect(gapFor(out, "keyless.profile.marketCap")!.reason).toMatch(/^1 market cap withheld \(2026-06-12\) because price and share count could not be put on one share basis: the 4-for-1 split first traded 2026-06-15 first traded between 2026-06-12 and 2026-06-19/);
    // The split-adjusted history is on the post-split basis: 10M × 4 × $25.
    expect(history(out).every((r) => r.marketCap === EQUITY_VALUE)).toBe(true);
  });

  it("leaves out a cover count measured before a split and filed after it, and prices on the prior known count", async () => {
    // Measured 2026-06-05, before the split could be legally effective, filed
    // 2026-06-20 after it first traded: it could be either basis. As filed,
    // 10M × $25 = $250M.
    const out = await run({
      today: "2026-09-30",
      facts: forwardSplit([
        { end: "2026-04-24", val: 10_000_000, filed: "2026-05-05" },
        { end: "2026-06-05", val: 10_000_000, filed: "2026-06-20" },
      ]),
      close: () => 25,
      price: 25,
      splits: [FORWARD_SPLIT_EVENT],
    });
    // The spot count falls back to the 2026-04-24 count carried across the split: 40M × $25.
    expect(profileCap(out)).toBe(EQUITY_VALUE);
    expect(gapFor(out, "keyless.statements.shareBasis")!.reason).toMatch(/the count was measured 2026-06-05, before the 4-for-1 split first traded 2026-06-15, and filed 2026-06-20, after it/);
    const rows = history(out);
    expect(rows.find((r) => r.date === "2026-06-04")!.marketCap).toBe(EQUITY_VALUE);
    expect(rows.every((r) => r.marketCap === EQUITY_VALUE)).toBe(true);
    expect(rows.some((r) => r.date! >= "2026-06-05")).toBe(false);
    expect(gapFor(out, "keyless.marketCapHistory.shareBasis")!.reason).toContain(`${days("2026-06-05", "2026-09-30").length} market-cap day(s) withheld (2026-06-05 … 2026-09-30)`);
  });

  it("withholds every market value when the tag and a covering vendor list disagree", async () => {
    const f = facts(
      { [SPLIT_RATIO_TAG]: [{ end: "2026-06-12", val: 3, filed: "2026-08-05" }] },
      { [COVER]: [{ end: "2026-04-24", val: 10_000_000, filed: "2026-05-05" }] },
    );
    // The vendor covers 2026 and lists no split: the 3:1 tag is unresolved.
    const out = await run({ today: "2026-09-30", facts: f, close: () => 100, price: 100 });
    expect(profileCap(out)).toBeNull();
    expect(gapFor(out, "keyless.stockSplits(2026-06-12)")).toMatchObject({ severity: "warn", expected: false });
    expect(out.members.marketCapHistory.ok).toBe(false);
  });
});
