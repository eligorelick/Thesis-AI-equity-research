import { describe, expect, it } from "vitest";
import {
  discoverStockSplits,
  LEGAL_BEFORE_SESSION_MAX_DAYS,
  sameShareBasis,
  shareBasisFactor,
  shareCountOnBasis,
  SPLIT_RATIO_TAG,
  type StockSplits,
} from "@/edgar/splits";
import { mergeSplitEvidence, unavailableSplitEvidence, type VendorSplitEvidence } from "@/providers/splitEvents";
import type { CompanyFacts } from "@/edgar/xbrl";

interface Pt { start?: string; end: string; val: number; form?: string; filed: string; accn?: string }

/** Build a companyfacts payload from `{ tag: [points] }`, unit per tag (default USD). */
function facts(usGaap: Record<string, Pt[]>, units: Record<string, string> = {}, dei: Record<string, Pt[]> = {}): CompanyFacts {
  const toConcept = (tag: string, points: Pt[]) => ({
    label: tag,
    units: {
      [units[tag] ?? (/Shares/.test(tag) ? "shares" : "USD")]: points.map((p, i) => ({
        start: p.start,
        end: p.end,
        val: p.val,
        accn: p.accn ?? `0000000000-26-${String(i).padStart(6, "0")}`,
        fy: Number(p.filed.slice(0, 4)),
        fp: "FY",
        form: p.form ?? "10-K",
        filed: p.filed,
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

const DILUTED = "WeightedAverageNumberOfDilutedSharesOutstanding";
/** The analysis date: after every split tagged in this file except the explicitly future ones. */
const AS_OF = "2026-09-30";
const FY2019 = { start: "2018-09-30", end: "2019-09-28" };
const EVERYTHING = [{ from: "1990-01-02", to: AS_OF }];

/** A retrieved vendor list covering every session to AS_OF, with these first split-adjusted sessions. */
type Retrieved = Extract<VendorSplitEvidence, { status: "retrieved" }>;
function vendor(...events: [session: string, numerator: number, denominator: number][]): Retrieved {
  return {
    status: "retrieved",
    source: "test:vendor",
    events: events.map(([session, numerator, denominator]) => ({ session, numerator, denominator, ratio: numerator / denominator })),
    coverage: EVERYTHING,
  };
}
const NONE = vendor();

function discover(f: CompanyFacts, evidence: VendorSplitEvidence, asOf = AS_OF): StockSplits {
  return discoverStockSplits(f, { asOf, vendor: evidence });
}

/** The factor a statement figure filed on `filed` takes on the basis of the session `day`; NaN when withheld. */
function factor(s: StockSplits, filed: string, day = AS_OF): number {
  const b = shareBasisFactor(s, filed, null, day);
  return "withheld" in b ? Number.NaN : b.factor;
}

/** Apple's 4:1: FY2019 diluted shares as first filed, then restated one year later. */
function appleSplit2020(extra: Record<string, Pt[]> = {}): CompanyFacts {
  return facts(
    {
      [SPLIT_RATIO_TAG]: [{ end: "2020-08-28", val: 4, filed: "2020-10-30" }],
      [DILUTED]: [
        { ...FY2019, val: 4_648_913_000, filed: "2019-10-31" },
        { ...FY2019, val: 18_595_651_000, filed: "2020-10-30" },
      ],
      ...extra,
    },
    { [SPLIT_RATIO_TAG]: "pure" },
  );
}
/** Apple's first split-adjusted sessions: 2014-06-09 (7:1) and 2020-08-31 (4:1). */
const APPLE_VENDOR = vendor(["2014-06-09", 7, 1], ["2020-08-31", 4, 1]);
/** Only the 2020 split, for fixtures that tag only that one (a vendor-only 2014 split would otherwise apply too). */
const APPLE_2020 = vendor(["2020-08-31", 4, 1]);

describe("discoverStockSplits — ratio and direction", () => {
  it("finds nothing and scales by 1 when neither the filer nor the vendor lists a split", () => {
    const splits = discover(facts({ [DILUTED]: [{ ...FY2019, val: 100, filed: "2019-10-31" }] }), NONE);
    expect(splits.events).toEqual([]);
    expect(splits.unresolved).toEqual([]);
    expect(splits.notes).toEqual([]);
    expect(factor(splits, "2015-01-01")).toBe(1);
  });

  it("applies a forward split to facts filed before its legal effect and leaves later filings alone", () => {
    const splits = discover(appleSplit2020(), APPLE_2020);
    expect(splits.events).toEqual([
      {
        date: "2020-08-28",
        ratio: 4,
        tagged: 4,
        evidence: 4,
        contextDates: ["2020-08-28"],
        announced: "2020-10-30",
        firstAdjustedSession: "2020-08-31",
        sessionWindow: { from: "2020-08-31", to: "2020-08-31" },
        legalFrom: "2020-08-24",
        sources: ["edgar", "vendor"],
      },
    ]);
    expect(factor(splits, "2019-10-31")).toBe(4);
    expect(factor(splits, "2016-10-26")).toBe(4);
    expect(factor(splits, "2020-10-30")).toBe(1);
    // Filed on the tagged date itself, between the earliest legal effectiveness
    // and the first split-adjusted session: its side of the split is unknown.
    expect(factor(splits, "2020-08-28")).toBeNaN();
    // Before the first split-adjusted session the pre-split count stays as filed.
    expect(factor(splits, "2019-10-31", "2020-08-28")).toBe(1);
  });

  it("compounds several splits for filings that predate all of them", () => {
    const FY2013 = { start: "2012-09-30", end: "2013-09-28" };
    const splits = discover(
      appleSplit2020({
        [SPLIT_RATIO_TAG]: [
          { end: "2020-08-28", val: 4, filed: "2020-10-30" },
          { end: "2014-06-06", val: 7, filed: "2014-07-23", form: "10-Q" },
        ],
        [DILUTED]: [
          { ...FY2019, val: 4_648_913_000, filed: "2019-10-31" },
          { ...FY2019, val: 18_595_651_000, filed: "2020-10-30" },
          { ...FY2013, val: 931_662_000, filed: "2013-10-30" },
          { ...FY2013, val: 6_521_634_000, filed: "2014-10-27" },
        ],
      }),
      APPLE_VENDOR,
    );
    expect(splits.events.map((e) => [e.date, e.ratio, e.firstAdjustedSession])).toEqual([
      ["2014-06-06", 7, "2014-06-09"],
      ["2020-08-28", 4, "2020-08-31"],
    ]);
    expect(factor(splits, "2013-10-30")).toBe(28);
    expect(factor(splits, "2014-10-27")).toBe(4);
    expect(factor(splits, "2021-01-28")).toBe(1);
  });

  it("inverts a reverse split that the filer tagged as its whole-number ratio", () => {
    const FY2020 = { start: "2020-01-01", end: "2020-12-31" };
    const splits = discover(
      facts(
        {
          [SPLIT_RATIO_TAG]: [{ end: "2021-08-02", val: 8, filed: "2021-10-26", form: "10-Q" }],
          [DILUTED]: [
            { ...FY2020, val: 8_760_000_000, filed: "2021-02-12" },
            { ...FY2020, val: 1_095_000_000, filed: "2022-02-11" },
          ],
        },
        { [SPLIT_RATIO_TAG]: "pure" },
      ),
      vendor(["2021-08-02", 1, 8]),
    );
    expect(splits.events.map((e) => [e.ratio, e.tagged, e.evidence, e.firstAdjustedSession])).toEqual([[0.125, 8, 0.125, "2021-08-02"]]);
    expect(factor(splits, "2021-02-12")).toBe(0.125);
    expect(splits.notes[0]!.text).toMatch(/1-for-8 .*tagged as 8, restated share counts show ×0\.125/);
  });

  it("takes the direction from the vendor's numerator and denominator when no restatement shows it", () => {
    const splits = discover(
      facts({ [SPLIT_RATIO_TAG]: [{ end: "2023-03-01", val: 10, filed: "2023-05-10", form: "10-Q" }] }, { [SPLIT_RATIO_TAG]: "pure" }),
      vendor(["2023-03-02", 1, 10]),
    );
    expect(splits.events.map((e) => [e.ratio, e.tagged, e.evidence])).toEqual([[0.1, 10, null]]);
    expect(factor(splits, "2022-02-01")).toBe(0.1);
    expect(splits.notes[0]!.text).toMatch(/1-for-10 tagged for 2023-03-01 .* as 10, read as 0\.1 from test:vendor's 1:10/);
  });

  it("does not apply a tagged ratio that the restated share counts contradict, and withholds what rests on it", () => {
    const splits = discover(appleSplit2020({ [SPLIT_RATIO_TAG]: [{ end: "2020-08-28", val: 3, filed: "2020-10-30" }] }), APPLE_2020);
    expect(splits.events).toEqual([]);
    expect(splits.unresolved).toHaveLength(1);
    expect(splits.notes).toEqual([
      {
        date: "2020-08-28",
        severity: "warn",
        text: `stock split ratio 3 tagged for 2020-08-28 (${SPLIT_RATIO_TAG}) NOT applied: share counts restated across that date moved by ×4, which matches neither 3 nor 1/3; per-share and share-count facts filed before it are withheld wherever they would meet a price`,
      },
    ]);
    // The vendor's 2020-08-31 event is consumed by the disputed tag: never applied a second time.
    expect(factor(splits, "2019-10-31")).toBeNaN();
    expect(factor(splits, "2020-10-30")).toBe(1);
  });

  it("does not apply a date whose filings disagree on the ratio", () => {
    const splits = discover(
      appleSplit2020({
        [SPLIT_RATIO_TAG]: [
          { end: "2020-08-28", val: 4, filed: "2020-10-30" },
          { end: "2020-08-28", val: 2, filed: "2021-01-28", form: "10-Q" },
        ],
      }),
      APPLE_2020,
    );
    expect(splits.events).toEqual([]);
    expect(splits.notes.map((n) => [n.date, n.severity])).toEqual([["2020-08-28", "warn"]]);
    expect(splits.notes[0]!.text).toMatch(/NOT applied: filings disagree on the ratio \(2, 4\)/);
  });

  it("ignores a ratio of 1, non-positive or non-finite values, and reads the concept from any form", () => {
    const splits = discover(
      facts(
        {
          [SPLIT_RATIO_TAG]: [
            { end: "2019-01-01", val: 1, filed: "2019-02-01" },
            { end: "2019-06-01", val: 0, filed: "2019-07-01" },
            { end: "2019-09-01", val: -2, filed: "2019-10-01" },
            { end: "2022-07-15", val: 20, filed: "2022-07-18", form: "8-K" },
          ],
        },
        { [SPLIT_RATIO_TAG]: "pure" },
      ),
      vendor(["2022-07-18", 20, 1]),
    );
    expect(splits.events.map((e) => [e.date, e.ratio])).toEqual([["2022-07-15", 20]]);
  });

  it("uses only restatements filed before the NEXT split as evidence for an older split", () => {
    const FY2013 = { start: "2012-09-30", end: "2013-09-28" };
    const splits = discover(
      appleSplit2020({
        [SPLIT_RATIO_TAG]: [
          { end: "2020-08-28", val: 4, filed: "2020-10-30" },
          { end: "2014-06-06", val: 7, filed: "2014-10-27" },
        ],
        [DILUTED]: [
          { ...FY2019, val: 4_648_913_000, filed: "2019-10-31" },
          { ...FY2019, val: 18_595_651_000, filed: "2020-10-30" },
          { ...FY2013, val: 931_662_000, filed: "2013-10-30" },
          { ...FY2013, val: 6_521_634_000, filed: "2014-10-27" },
          { ...FY2013, val: 26_086_536_000, filed: "2020-10-30" },
        ],
      }),
      APPLE_VENDOR,
    );
    expect(splits.events.map((e) => [e.date, e.ratio, e.evidence])).toEqual([
      ["2014-06-06", 7, 7],
      ["2020-08-28", 4, 4],
    ]);
  });
});

describe("discoverStockSplits — repeated and near-duplicate tags", () => {
  const FY2024 = { start: "2023-01-30", end: "2024-01-28" };
  /** NVIDIA-shaped: a 10-for-1 tagged 2024-06-07, the FY2024 diluted count as first filed and as restated. */
  function split2024(extra: Record<string, Pt[]>): CompanyFacts {
    return facts(
      {
        [SPLIT_RATIO_TAG]: [{ end: "2024-06-07", val: 10, filed: "2024-08-28", form: "10-Q" }],
        [DILUTED]: [
          { ...FY2024, val: 2_494_000_000, filed: "2024-02-21" },
          { ...FY2024, val: 24_940_000_000, filed: "2025-02-26" },
        ],
        ...extra,
      },
      { [SPLIT_RATIO_TAG]: "pure" },
    );
  }
  const NVDA_VENDOR = vendor(["2024-06-10", 10, 1]);

  it("merges the same ratio tagged for two context dates a few days apart into one split", () => {
    const splits = discover(
      split2024({
        [SPLIT_RATIO_TAG]: [
          { end: "2024-06-07", val: 10, filed: "2024-08-28", form: "10-Q" },
          { end: "2024-06-10", val: 10, filed: "2024-11-20", form: "10-Q" },
        ],
      }),
      NVDA_VENDOR,
    );
    expect(splits.events.map((e) => [e.date, e.ratio, e.contextDates])).toEqual([["2024-06-07", 10, ["2024-06-07", "2024-06-10"]]]);
    expect(factor(splits, "2024-02-21")).toBe(10);
  });

  it("reads the same ratio tagged again a quarter later, with nothing restated in between, as the same split", () => {
    const splits = discover(
      split2024({
        [SPLIT_RATIO_TAG]: [
          { end: "2024-06-07", val: 10, filed: "2024-08-28", form: "10-Q" },
          { end: "2024-10-27", val: 10, filed: "2024-11-20", form: "10-Q" },
        ],
      }),
      NVDA_VENDOR,
    );
    expect(splits.events.map((e) => [e.date, e.ratio])).toEqual([["2024-06-07", 10]]);
    expect(factor(splits, "2024-02-21")).toBe(10);
    expect(splits.notes.find((n) => n.date === "2024-10-27")!.text).toBe(
      `stock split ratio 10 tagged again for 2024-10-27 (${SPLIT_RATIO_TAG}) is the 10-for-1 split of 2024-06-07 restated, not a further split; not applied again`,
    );
  });

  it("reads a re-tag whose own restatement factor is 1 as the same split, not a contradiction", () => {
    const Q2 = { start: "2024-04-29", end: "2024-07-28" };
    const splits = discover(
      split2024({
        [SPLIT_RATIO_TAG]: [
          { end: "2024-06-07", val: 10, filed: "2024-08-28", form: "10-Q" },
          { end: "2025-01-26", val: 10, filed: "2025-02-26" },
        ],
        [DILUTED]: [
          { ...FY2024, val: 2_494_000_000, filed: "2024-02-21" },
          { ...FY2024, val: 24_940_000_000, filed: "2024-08-28", form: "10-Q" },
          { ...Q2, val: 24_848_000_000, filed: "2024-08-28", form: "10-Q" },
          { ...Q2, val: 24_848_000_000, filed: "2025-02-26" },
        ],
      }),
      NVDA_VENDOR,
    );
    expect(splits.events.map((e) => [e.date, e.ratio])).toEqual([["2024-06-07", 10]]);
    expect(splits.notes.find((n) => n.date === "2025-01-26")!.text).toMatch(/tagged again for 2025-01-26 .* is the 10-for-1 split of 2024-06-07 restated/);
  });

  it("reads a ratio re-tagged in every later filing as the same split, however long the chain runs", () => {
    const retags = ["2024-10-27", "2025-01-26", "2025-04-27", "2025-07-27", "2025-10-26", "2026-01-25"];
    const splits = discover(
      split2024({
        [SPLIT_RATIO_TAG]: [
          { end: "2024-06-07", val: 10, filed: "2024-08-28", form: "10-Q" },
          ...retags.map((end) => ({ end, val: 10, filed: end, form: "10-Q" })),
        ],
      }),
      NVDA_VENDOR,
    );
    expect(splits.events.map((e) => [e.date, e.ratio])).toEqual([["2024-06-07", 10]]);
    expect(factor(splits, "2024-02-21")).toBe(10);
    expect(splits.notes.filter((n) => /tagged again/.test(n.text))).toHaveLength(retags.length);
  });

  it("does not apply the same ratio again, years later, when no restated share count can tell a further split from a stale re-tag", () => {
    const splits = discover(
      split2024({
        [SPLIT_RATIO_TAG]: [
          { end: "2024-06-07", val: 10, filed: "2024-08-28", form: "10-Q" },
          { end: "2026-06-07", val: 10, filed: "2026-08-28", form: "10-Q" },
        ],
      }),
      NVDA_VENDOR,
    );
    expect(splits.events.map((e) => [e.date, e.ratio])).toEqual([["2024-06-07", 10]]);
    const later = splits.notes.find((n) => n.date === "2026-06-07")!;
    expect(later.severity).toBe("warn");
    expect(later.text).toMatch(/NOT applied: the same ratio was already applied for 2024-06-07/);
    // Anything filed before that unresolved tag is withheld on today's basis.
    expect(factor(splits, "2024-02-21")).toBeNaN();
  });

  it("applies a second split of the same ratio when restated share counts and the vendor confirm it", () => {
    const FY2025 = { start: "2024-01-29", end: "2025-01-26" };
    const splits = discover(
      split2024({
        [SPLIT_RATIO_TAG]: [
          { end: "2024-06-07", val: 10, filed: "2024-08-28", form: "10-Q" },
          { end: "2026-06-07", val: 10, filed: "2026-08-28", form: "10-Q" },
        ],
        [DILUTED]: [
          { ...FY2024, val: 2_494_000_000, filed: "2024-02-21" },
          { ...FY2024, val: 24_940_000_000, filed: "2025-02-26" },
          { ...FY2025, val: 24_500_000_000, filed: "2025-02-26" },
          { ...FY2025, val: 245_000_000_000, filed: "2026-08-28", form: "10-Q" },
        ],
      }),
      vendor(["2024-06-10", 10, 1], ["2026-06-08", 10, 1]),
    );
    expect(splits.events.map((e) => [e.date, e.ratio, e.evidence, e.firstAdjustedSession])).toEqual([
      ["2024-06-07", 10, 10, "2024-06-10"],
      ["2026-06-07", 10, 10, "2026-06-08"],
    ]);
    expect(factor(splits, "2024-02-21")).toBe(100);
  });
});

describe("split timing — NVIDIA's 10-for-1 of June 2024 (reference case)", () => {
  // Reviewer-supplied reference (Form 8-K of 2024-06-07, accession
  // 0001045810-24-000144): legally effective 2024-06-07 at 4:01 p.m. Eastern;
  // split-adjusted trading began 2024-06-10. Companyfacts tags the ratio for
  // 2024-06-07 (10-Q filed 2024-08-28) and 2024-06-10 (10-Q filed 2024-11-20).
  const Q1FY25 = { start: "2024-01-29", end: "2024-04-28" };
  const nvda = facts(
    {
      [SPLIT_RATIO_TAG]: [
        { end: "2024-06-07", val: 10, filed: "2024-08-28", form: "10-Q" },
        { end: "2024-06-10", val: 10, filed: "2024-11-20", form: "10-Q" },
      ],
      [DILUTED]: [
        // Q1 FY2025 as filed 2024-05-29 (pre-split) and as restated a year later.
        { ...Q1FY25, val: 2_494_000_000, filed: "2024-05-29", form: "10-Q" },
        { ...Q1FY25, val: 24_940_000_000, filed: "2025-05-28", form: "10-Q" },
      ],
    },
    { [SPLIT_RATIO_TAG]: "pure" },
  );
  const splits = discover(nvda, vendor(["2024-06-10", 10, 1]));

  it("keeps the context dates, the announcement and the first split-adjusted session apart", () => {
    expect(splits.events).toEqual([
      {
        date: "2024-06-07",
        ratio: 10,
        tagged: 10,
        evidence: 10,
        contextDates: ["2024-06-07", "2024-06-10"],
        announced: "2024-08-28",
        firstAdjustedSession: "2024-06-10",
        sessionWindow: { from: "2024-06-10", to: "2024-06-10" },
        legalFrom: "2024-06-03",
        sources: ["edgar", "vendor"],
      },
    ]);
    expect(LEGAL_BEFORE_SESSION_MAX_DAYS).toBe(7);
  });

  it("prices the 2024-06-07 session (legally effective after its close) on the pre-split basis", () => {
    // The Q1 count filed 2024-05-29 against the 2024-06-07 close: as filed.
    expect(shareCountOnBasis(splits, 2_494_000_000, "2024-05-29", null, "2024-06-07")).toEqual({ value: 2_494_000_000 });
    // Against the first split-adjusted session, 2024-06-10: ten times.
    expect(shareCountOnBasis(splits, 2_494_000_000, "2024-05-29", null, "2024-06-10")).toEqual({ value: 24_940_000_000 });
    expect(sameShareBasis(splits, "2024-06-07", "2024-06-10")).toMatch(/first traded between 2024-06-07 and 2024-06-10/);
    expect(sameShareBasis(splits, "2024-06-10", "2024-09-30")).toBeNull();
  });

  it("withholds a count filed between legal effect and the first split-adjusted session", () => {
    // A filing of 2024-06-07 could state either basis (effective 4:01 p.m. that day).
    expect(shareCountOnBasis(splits, 24_940_000_000, "2024-06-07", null, "2024-06-10")).toMatchObject({
      withheld: expect.stringMatching(/filed 2024-06-07, between the earliest legal effectiveness \(2024-06-03\) and the first split-adjusted session/),
    });
  });

  it("before companyfacts carries the tag, applies the vendor's event alone (fresh facts lacking the event)", () => {
    const beforeTag = facts({ [DILUTED]: [{ ...Q1FY25, val: 2_494_000_000, filed: "2024-05-29", form: "10-Q" }] });
    const early = discover(beforeTag, { ...vendor(["2024-06-10", 10, 1]), coverage: [{ from: "1999-01-22", to: "2024-06-12" }] }, "2024-06-12");
    expect(early.events.map((e) => [e.date, e.ratio, e.sources, e.legalFrom])).toEqual([["2024-06-10", 10, ["vendor"], "2024-06-03"]]);
    expect(shareCountOnBasis(early, 2_494_000_000, "2024-05-29", null, "2024-06-12")).toEqual({ value: 24_940_000_000 });
    // …and on the weekend after legal effect, before split-adjusted trading, nothing moves.
    const weekend = discover(beforeTag, { ...vendor(), coverage: [{ from: "1999-01-22", to: "2024-06-07" }] }, "2024-06-08");
    expect(shareCountOnBasis(weekend, 2_494_000_000, "2024-05-29", null, "2024-06-07")).toEqual({ value: 2_494_000_000 });
  });
});

describe("split timing — dates the filer tagged are not trading dates", () => {
  it("P1: an approval tagged 2026-09-10 is not taken as the trading date; the quote's session stays pre-split", () => {
    // The 8-K tags the approval; split-adjusted trading has not begun by 2026-09-30.
    const f = facts({ [SPLIT_RATIO_TAG]: [{ end: "2026-09-10", val: 4, filed: "2026-09-11", form: "8-K" }] }, { [SPLIT_RATIO_TAG]: "pure" });
    const splits = discover(f, vendor());
    expect(splits.events.map((e) => [e.firstAdjustedSession, e.sessionWindow])).toEqual([[null, { from: "2026-10-01", to: "2026-11-09" }]]);
    // The vendor covered every session to 2026-09-30 and listed nothing: not traded yet.
    expect(shareCountOnBasis(splits, 10_000_000, "2026-08-05", "2026-07-24", "2026-09-30")).toEqual({ value: 10_000_000 });
    expect(splits.notes[0]!.text).toMatch(/No vendor session pins its first split-adjusted session .* taken to fall within 2026-10-01 … 2026-11-09/);
  });

  it("P1 without vendor coverage of the quote's session: the basis cannot be established, so the count is withheld", () => {
    const f = facts({ [SPLIT_RATIO_TAG]: [{ end: "2026-09-10", val: 4, filed: "2026-09-11", form: "8-K" }] }, { [SPLIT_RATIO_TAG]: "pure" });
    const splits = discover(f, { ...vendor(), coverage: [{ from: "1990-01-02", to: "2026-09-01" }] });
    expect(shareCountOnBasis(splits, 10_000_000, "2026-08-05", "2026-07-24", "2026-09-30")).toMatchObject({
      withheld: expect.stringMatching(/not every session from 2026-08-05 to 2026-09-30/),
    });
  });

  it("the original case: a split filed 2026-09-01 for 2027-01-15 does not move a 2026-09-30 share count", () => {
    const f = facts({ [SPLIT_RATIO_TAG]: [{ end: "2027-01-15", val: 4, filed: "2026-09-01", form: "8-K" }] }, { [SPLIT_RATIO_TAG]: "pure" });
    const splits = discover(f, vendor());
    expect(shareCountOnBasis(splits, 10_000_000, "2026-08-05", "2026-07-24", "2026-09-30")).toEqual({ value: 10_000_000 });
    // Once it has traded (vendor pins 2027-01-19), the same count is carried across it.
    const later = discover(f, { ...vendor(["2027-01-19", 4, 1]), coverage: [{ from: "1990-01-02", to: "2027-02-01" }] }, "2027-02-01");
    expect(shareCountOnBasis(later, 10_000_000, "2026-08-05", "2026-07-24", "2027-02-01")).toEqual({ value: 40_000_000 });
  });

  it("a tagged split the covering vendor list does not contain is conflicting evidence: not applied, withheld", () => {
    const splits = discover(appleSplit2020(), NONE);
    expect(splits.events).toEqual([]);
    expect(splits.unresolved).toHaveLength(1);
    expect(splits.notes[0]!.text).toMatch(/NOT applied: test:vendor covers every session from 2020-08-21 to 2020-10-27 and lists no split in them/);
    expect(factor(splits, "2019-10-31")).toBeNaN();
  });

  it("a vendor event of another ratio in the tagged split's window is a conflict, never two splits", () => {
    const splits = discover(appleSplit2020(), vendor(["2020-08-31", 2, 1]));
    expect(splits.events).toEqual([]);
    expect(splits.notes[0]!.text).toMatch(/NOT applied: test:vendor lists 2-for-1 first traded 2020-08-31 within 2020-08-21 … 2020-10-27, which does not match/);
  });

  it("a cover count measured before a split and filed after it is of unknown basis", () => {
    const splits = discover(appleSplit2020(), APPLE_2020);
    expect(shareCountOnBasis(splits, 10_000_000, "2020-09-10", "2020-08-14", AS_OF)).toMatchObject({
      withheld: expect.stringMatching(/measured 2020-08-14, before the 4-for-1 split first traded 2020-08-31, and filed 2020-09-10, after it/),
    });
    // Measured after the first split-adjusted session: post-split, never scaled again.
    expect(shareCountOnBasis(splits, 40_000_000, "2020-10-30", "2020-10-16", AS_OF)).toEqual({ value: 40_000_000 });
  });
});

describe("split evidence — missing and merged vendor answers", () => {
  it("an unavailable vendor list never reads as 'no splits': every count is withheld", () => {
    const splits = discover(facts({}), unavailableSplitEvidence("test:vendor", "HTTP 429"));
    expect(splits.vendor).toEqual({ status: "unavailable", source: "test:vendor", reason: "HTTP 429" });
    expect(shareCountOnBasis(splits, 10_000_000, "2026-08-05", null, AS_OF)).toEqual({
      withheld: "no vendor split list is available (test:vendor: HTTP 429), so a split between 2026-08-05 and 2026-09-30 cannot be ruled out",
    });
    expect(splits.notes).toEqual([expect.objectContaining({ severity: "warn", date: AS_OF })]);
  });

  it("a count filed before the vendor's coverage begins is withheld", () => {
    const splits = discover(facts({}), { ...vendor(), coverage: [{ from: "2021-09-01", to: AS_OF }] });
    expect(shareCountOnBasis(splits, 1, "2019-10-31", null, AS_OF)).toMatchObject({ withheld: expect.stringMatching(/covers 2021-09-01 … 2026-09-30, not every session from 2019-10-31/) });
    expect(shareCountOnBasis(splits, 1, "2022-10-31", null, AS_OF)).toEqual({ value: 1 });
  });

  it("merges several vendor answers without duplicating an event both describe", () => {
    const daily: VendorSplitEvidence = { ...vendor(["2024-06-10", 10, 1]), source: "daily", coverage: [{ from: "2021-09-30", to: "2026-09-29" }] };
    const full: VendorSplitEvidence = { ...vendor(["2021-07-20", 4, 1], ["2024-06-10", 10, 1]), source: "full", coverage: [{ from: "1999-01-22", to: "2026-09-30" }] };
    const merged = mergeSplitEvidence([full, daily, unavailableSplitEvidence("quote", "not requested")]);
    expect(merged.status === "retrieved" && merged.events.map((e) => e.session)).toEqual(["2021-07-20", "2024-06-10"]);
    const splits = discover(facts({}), merged);
    expect(splits.events.map((e) => [e.date, e.ratio, e.sources])).toEqual([
      ["2021-07-20", 4, ["vendor"]],
      ["2024-06-10", 10, ["vendor"]],
    ]);
    expect(factor(splits, "2021-01-01")).toBe(40);
    expect(mergeSplitEvidence([unavailableSplitEvidence("a", "x"), unavailableSplitEvidence("b", "y")])).toEqual({
      status: "unavailable",
      source: "a + b",
      reason: "a: x; b: y",
    });
  });
});
