import { describe, expect, it } from "vitest";
import { discoverStockSplits, SPLIT_RATIO_TAG } from "@/edgar/splits";
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
const FY2019 = { start: "2018-09-30", end: "2019-09-28" };

/** Apple's 4:1 split of 2020-08-28: FY2019 diluted shares as first filed, then restated one year later. */
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

describe("discoverStockSplits", () => {
  it("finds nothing and scales by 1 when the split ratio concept is absent", () => {
    const splits = discoverStockSplits(facts({ [DILUTED]: [{ ...FY2019, val: 100, filed: "2019-10-31" }] }));
    expect(splits.events).toEqual([]);
    expect(splits.notes).toEqual([]);
    expect(splits.factorFor("2015-01-01")).toBe(1);
  });

  it("applies a forward split to facts filed before it and leaves later filings alone", () => {
    const splits = discoverStockSplits(appleSplit2020());
    expect(splits.events).toEqual([{ date: "2020-08-28", ratio: 4, tagged: 4, evidence: 4 }]);
    expect(splits.factorFor("2019-10-31")).toBe(4);
    expect(splits.factorFor("2016-10-26")).toBe(4);
    // A filing made on the split date already reports post-split figures.
    expect(splits.factorFor("2020-08-28")).toBe(1);
    expect(splits.factorFor("2020-10-30")).toBe(1);
    expect(splits.notes).toEqual([
      {
        date: "2020-08-28",
        severity: "info",
        text: `stock split 4-for-1 on 2020-08-28 (${SPLIT_RATIO_TAG}, confirmed by restated share counts ×4): per-share and share-count facts filed before that date are restated to the post-split basis`,
      },
    ]);
  });

  it("compounds several splits, newest last, for filings that predate all of them", () => {
    const FY2013 = { start: "2012-09-30", end: "2013-09-28" };
    const splits = discoverStockSplits(
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
    );
    expect(splits.events.map((e) => [e.date, e.ratio])).toEqual([
      ["2014-06-06", 7],
      ["2020-08-28", 4],
    ]);
    expect(splits.factorFor("2013-10-30")).toBe(28);
    expect(splits.factorFor("2014-10-27")).toBe(4);
    expect(splits.factorFor("2021-01-28")).toBe(1);
  });

  it("inverts a reverse split that the filer tagged as its whole-number ratio", () => {
    const FY2020 = { start: "2020-01-01", end: "2020-12-31" };
    const splits = discoverStockSplits(
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
    );
    expect(splits.events).toEqual([{ date: "2021-08-02", ratio: 0.125, tagged: 8, evidence: 0.125 }]);
    expect(splits.factorFor("2021-02-12")).toBe(0.125);
    expect(splits.notes[0]!.text).toMatch(/1-for-8 .*tagged as 8, restated share counts show ×0\.125/);
  });

  it("skips a tagged ratio that the restated share counts contradict, and says so", () => {
    const splits = discoverStockSplits(
      appleSplit2020({
        [SPLIT_RATIO_TAG]: [{ end: "2020-08-28", val: 3, filed: "2020-10-30" }],
      }),
    );
    expect(splits.events).toEqual([]);
    expect(splits.factorFor("2019-10-31")).toBe(1);
    expect(splits.notes).toEqual([
      {
        date: "2020-08-28",
        severity: "warn",
        text: `stock split ratio 3 tagged for 2020-08-28 (${SPLIT_RATIO_TAG}) NOT applied: share counts restated across that date moved by ×4, which matches neither 3 nor 1/3; per-share and share-count facts filed before it are left as filed`,
      },
    ]);
  });

  it("marks only the unapplied ratios as warnings", () => {
    const applied = discoverStockSplits(appleSplit2020());
    expect(applied.notes.map((n) => n.severity)).toEqual(["info"]);
    const disagreeing = discoverStockSplits(
      appleSplit2020({
        [SPLIT_RATIO_TAG]: [
          { end: "2020-08-28", val: 4, filed: "2020-10-30" },
          { end: "2020-08-28", val: 2, filed: "2021-01-28", form: "10-Q" },
        ],
      }),
    );
    expect(disagreeing.notes.map((n) => [n.date, n.severity])).toEqual([["2020-08-28", "warn"]]);
  });

  it("skips a date whose filings disagree on the ratio", () => {
    const splits = discoverStockSplits(
      appleSplit2020({
        [SPLIT_RATIO_TAG]: [
          { end: "2020-08-28", val: 4, filed: "2020-10-30" },
          { end: "2020-08-28", val: 2, filed: "2021-01-28", form: "10-Q" },
        ],
      }),
    );
    expect(splits.events).toEqual([]);
    expect(splits.notes[0]!.text).toMatch(/NOT applied: filings disagree on the ratio \(2, 4\)/);
  });

  it("trusts the tagged ratio as filed when no share count was restated across the split", () => {
    const forward = discoverStockSplits(
      facts({ [SPLIT_RATIO_TAG]: [{ end: "2022-07-15", val: 20, filed: "2022-07-29", form: "10-Q" }] }, { [SPLIT_RATIO_TAG]: "pure" }),
    );
    expect(forward.events).toEqual([{ date: "2022-07-15", ratio: 20, tagged: 20, evidence: null }]);
    expect(forward.notes[0]!.text).toMatch(/20-for-1 on 2022-07-15 .*no restated share count to confirm it/);

    const reverse = discoverStockSplits(
      facts({ [SPLIT_RATIO_TAG]: [{ end: "2023-03-01", val: 0.1, filed: "2023-05-10", form: "10-Q" }] }, { [SPLIT_RATIO_TAG]: "pure" }),
    );
    expect(reverse.events).toEqual([{ date: "2023-03-01", ratio: 0.1, tagged: 0.1, evidence: null }]);
    expect(reverse.factorFor("2022-02-01")).toBe(0.1);
    expect(reverse.notes[0]!.text).toMatch(/1-for-10 on 2023-03-01/);
  });

  it("ignores a ratio of 1, non-positive or non-finite values, and reads the concept from any form", () => {
    const splits = discoverStockSplits(
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
    );
    expect(splits.events.map((e) => [e.date, e.ratio])).toEqual([["2022-07-15", 20]]);
  });

  it("uses only restatements filed before the NEXT split as evidence for an older split", () => {
    // FY2013 was restated once after the 7:1 (×7) and again after the 4:1 (×28 in total).
    // The ×28 restatement must not be read as contradicting the 7:1.
    const FY2013 = { start: "2012-09-30", end: "2013-09-28" };
    const splits = discoverStockSplits(
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
    );
    expect(splits.events.map((e) => [e.date, e.ratio, e.evidence])).toEqual([
      ["2014-06-06", 7, 7],
      ["2020-08-28", 4, 4],
    ]);
  });
});

describe("discoverStockSplits — repeated and near-duplicate tags", () => {
  const FY2024 = { start: "2023-01-30", end: "2024-01-28" };
  /** A 10-for-1 split of 2024-06-07 with the FY2024 diluted count as first filed and as restated. */
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

  it("merges the same ratio tagged for two context dates a few days apart into one split", () => {
    const splits = discoverStockSplits(
      split2024({
        [SPLIT_RATIO_TAG]: [
          { end: "2024-06-07", val: 10, filed: "2024-08-28", form: "10-Q" },
          { end: "2024-06-10", val: 10, filed: "2024-11-20", form: "10-Q" },
        ],
      }),
    );
    expect(splits.events.map((e) => [e.date, e.ratio])).toEqual([["2024-06-07", 10]]);
    expect(splits.factorFor("2024-02-21")).toBe(10);
  });

  it("reads the same ratio tagged again a quarter later, with nothing restated in between, as the same split", () => {
    const splits = discoverStockSplits(
      split2024({
        [SPLIT_RATIO_TAG]: [
          { end: "2024-06-07", val: 10, filed: "2024-08-28", form: "10-Q" },
          { end: "2024-10-27", val: 10, filed: "2024-11-20", form: "10-Q" },
        ],
      }),
    );
    expect(splits.events.map((e) => [e.date, e.ratio])).toEqual([["2024-06-07", 10]]);
    expect(splits.factorFor("2024-02-21")).toBe(10);
    expect(splits.notes[1]!.text).toBe(
      `stock split ratio 10 tagged again for 2024-10-27 (${SPLIT_RATIO_TAG}) is the 10-for-1 split of 2024-06-07 restated, not a further split; not applied again`,
    );
  });

  it("reads a re-tag whose own restatement factor is 1 as the same split, not a contradiction", () => {
    const Q2 = { start: "2024-04-29", end: "2024-07-28" };
    const splits = discoverStockSplits(
      split2024({
        [SPLIT_RATIO_TAG]: [
          { end: "2024-06-07", val: 10, filed: "2024-08-28", form: "10-Q" },
          { end: "2025-01-26", val: 10, filed: "2025-02-26" },
        ],
        [DILUTED]: [
          { ...FY2024, val: 2_494_000_000, filed: "2024-02-21" },
          { ...FY2024, val: 24_940_000_000, filed: "2024-08-28", form: "10-Q" },
          // The Q2 count, filed after the split and again a quarter later, unchanged.
          { ...Q2, val: 24_848_000_000, filed: "2024-08-28", form: "10-Q" },
          { ...Q2, val: 24_848_000_000, filed: "2025-02-26" },
        ],
      }),
    );
    expect(splits.events.map((e) => [e.date, e.ratio])).toEqual([["2024-06-07", 10]]);
    expect(splits.notes[1]!.text).toMatch(/tagged again for 2025-01-26 .* is the 10-for-1 split of 2024-06-07 restated/);
  });
});
