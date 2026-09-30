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
/** The analysis date: after every split tagged in this file except the explicitly future ones. */
const AS_OF = "2026-09-30";
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
    const splits = discoverStockSplits(facts({ [DILUTED]: [{ ...FY2019, val: 100, filed: "2019-10-31" }] }), AS_OF);
    expect(splits.events).toEqual([]);
    expect(splits.notes).toEqual([]);
    expect(splits.factorFor("2015-01-01")).toBe(1);
  });

  it("applies a forward split to facts filed before it and leaves later filings alone", () => {
    const splits = discoverStockSplits(appleSplit2020(), AS_OF);
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
      AS_OF,
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
      AS_OF,
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
      AS_OF,
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
    const applied = discoverStockSplits(appleSplit2020(), AS_OF);
    expect(applied.notes.map((n) => n.severity)).toEqual(["info"]);
    const disagreeing = discoverStockSplits(
      appleSplit2020({
        [SPLIT_RATIO_TAG]: [
          { end: "2020-08-28", val: 4, filed: "2020-10-30" },
          { end: "2020-08-28", val: 2, filed: "2021-01-28", form: "10-Q" },
        ],
      }),
      AS_OF,
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
      AS_OF,
    );
    expect(splits.events).toEqual([]);
    expect(splits.notes[0]!.text).toMatch(/NOT applied: filings disagree on the ratio \(2, 4\)/);
  });

  it("trusts the tagged ratio as filed when no share count was restated across the split", () => {
    const forward = discoverStockSplits(
      facts({ [SPLIT_RATIO_TAG]: [{ end: "2022-07-15", val: 20, filed: "2022-07-29", form: "10-Q" }] }, { [SPLIT_RATIO_TAG]: "pure" }),
      AS_OF,
    );
    expect(forward.events).toEqual([{ date: "2022-07-15", ratio: 20, tagged: 20, evidence: null }]);
    expect(forward.notes[0]!.text).toMatch(/20-for-1 on 2022-07-15 .*no restated share count to confirm it/);

    const reverse = discoverStockSplits(
      facts({ [SPLIT_RATIO_TAG]: [{ end: "2023-03-01", val: 0.1, filed: "2023-05-10", form: "10-Q" }] }, { [SPLIT_RATIO_TAG]: "pure" }),
      AS_OF,
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
      AS_OF,
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
      AS_OF,
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
      AS_OF,
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
      AS_OF,
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
      AS_OF,
    );
    expect(splits.events.map((e) => [e.date, e.ratio])).toEqual([["2024-06-07", 10]]);
    expect(splits.notes[1]!.text).toMatch(/tagged again for 2025-01-26 .* is the 10-for-1 split of 2024-06-07 restated/);
  });

  it("reads a ratio re-tagged in every later filing as the same split, however long the chain runs", () => {
    // 2026-01-25 is 597 days after the split: outside the repeat window
    // measured from the EVENT, inside it measured from the previous re-tag.
    // Measured from the event, the sixth re-tag was applied as a second
    // 10-for-1 and every pre-2024 share count was scaled by 100.
    const retags = ["2024-10-27", "2025-01-26", "2025-04-27", "2025-07-27", "2025-10-26", "2026-01-25"];
    const splits = discoverStockSplits(
      split2024({
        [SPLIT_RATIO_TAG]: [
          { end: "2024-06-07", val: 10, filed: "2024-08-28", form: "10-Q" },
          ...retags.map((end) => ({ end, val: 10, filed: end, form: "10-Q" })),
        ],
      }),
      AS_OF,
    );
    expect(splits.events.map((e) => [e.date, e.ratio])).toEqual([["2024-06-07", 10]]);
    expect(splits.factorFor("2024-02-21")).toBe(10);
    expect(splits.notes.filter((n) => /tagged again/.test(n.text))).toHaveLength(retags.length);
  });

  it("does not apply the same ratio again, years later, when no restated share count can tell a further split from a stale re-tag", () => {
    const splits = discoverStockSplits(
      split2024({
        [SPLIT_RATIO_TAG]: [
          { end: "2024-06-07", val: 10, filed: "2024-08-28", form: "10-Q" },
          { end: "2026-06-07", val: 10, filed: "2026-08-28", form: "10-Q" },
        ],
      }),
      AS_OF,
    );
    expect(splits.events.map((e) => [e.date, e.ratio])).toEqual([["2024-06-07", 10]]);
    expect(splits.factorFor("2024-02-21")).toBe(10);
    const later = splits.notes.find((n) => n.date === "2026-06-07")!;
    expect(later.severity).toBe("warn");
    expect(later.text).toMatch(/NOT applied: the same ratio was already applied for 2024-06-07/);
  });

  it("applies a second split of the same ratio when restated share counts confirm it", () => {
    const FY2025 = { start: "2024-01-29", end: "2025-01-26" };
    const splits = discoverStockSplits(
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
      AS_OF,
    );
    expect(splits.events.map((e) => [e.date, e.ratio, e.evidence])).toEqual([
      ["2024-06-07", 10, 10],
      ["2026-06-07", 10, 10],
    ]);
    expect(splits.factorFor("2024-02-21")).toBe(100);
  });
});

describe("discoverStockSplits — effective dates and share basis as of the analysis date", () => {
  const Q1_2026 = { start: "2026-01-01", end: "2026-03-31" };
  /** Q1 2026 diluted count as first filed (pre-split) and as restated after a split of 2026-06-15. */
  const restated = (before: number, after: number): Pt[] => [
    { ...Q1_2026, val: before, filed: "2026-05-05", form: "10-Q" },
    { ...Q1_2026, val: after, filed: "2026-08-05", form: "10-Q" },
  ];

  it("does not apply a split filed 2026-09-01 but effective 2027-01-15 as of 2026-09-30", () => {
    const f = facts(
      {
        [SPLIT_RATIO_TAG]: [{ end: "2027-01-15", val: 4, filed: "2026-09-01", form: "8-K" }],
        [DILUTED]: [{ ...Q1_2026, val: 10_000_000, filed: "2026-05-05", form: "10-Q" }],
      },
      { [SPLIT_RATIO_TAG]: "pure" },
    );
    const splits = discoverStockSplits(f, "2026-09-30");
    expect(splits.events).toEqual([]);
    expect(splits.pending).toEqual([{ date: "2027-01-15", tagged: 4 }]);
    expect(splits.unresolved).toEqual([]);
    // The older count stays exactly as filed: no factor of 4.
    expect(splits.factorFor("2026-05-05")).toBe(1);
    expect(splits.factorFor("2026-09-01")).toBe(1);
    expect(splits.shareCountBasisIssue("2026-07-24", "2026-08-05")).toBeNull();
    expect(splits.sourceBasisIssue("2026-09-30")).toBeNull();
    expect(splits.notes).toEqual([
      {
        date: "2027-01-15",
        severity: "info",
        text: `stock split ratio 4 tagged for 2027-01-15 (${SPLIT_RATIO_TAG}) is not yet effective as of 2026-09-30: not applied — share counts, per-share facts and prices stay on the pre-split basis until that date`,
      },
    ]);

    // Once the effective date has passed, the same tag applies to everything filed before it.
    const later = discoverStockSplits(f, "2027-02-01");
    expect(later.pending).toEqual([]);
    expect(later.events).toEqual([{ date: "2027-01-15", ratio: 4, tagged: 4, evidence: null }]);
    expect(later.factorFor("2026-05-05")).toBe(4);
    expect(later.factorFor("2027-01-15")).toBe(1);
  });

  it("applies a split dated exactly on the analysis date", () => {
    const splits = discoverStockSplits(
      facts({ [SPLIT_RATIO_TAG]: [{ end: "2026-09-30", val: 2, filed: "2026-09-30", form: "8-K" }] }, { [SPLIT_RATIO_TAG]: "pure" }),
      "2026-09-30",
    );
    expect(splits.events.map((e) => [e.date, e.ratio])).toEqual([["2026-09-30", 2]]);
    expect(splits.factorFor("2026-08-05")).toBe(2);
  });

  it("scales a 4-for-1 forward split so 10M pre-split shares become 40M", () => {
    const splits = discoverStockSplits(
      facts(
        { [SPLIT_RATIO_TAG]: [{ end: "2026-06-15", val: 4, filed: "2026-08-05", form: "10-Q" }], [DILUTED]: restated(10_000_000, 40_000_000) },
        { [SPLIT_RATIO_TAG]: "pure" },
      ),
      "2026-09-30",
    );
    expect(splits.events).toEqual([{ date: "2026-06-15", ratio: 4, tagged: 4, evidence: 4 }]);
    expect(10_000_000 * splits.factorFor("2026-05-05")).toBe(40_000_000);
    // Already on the post-split basis: filed on or after the split, never scaled again.
    expect(40_000_000 * splits.factorFor("2026-08-05")).toBe(40_000_000);
    expect(40_000_000 * splits.factorFor("2026-06-15")).toBe(40_000_000);
  });

  it("scales a 1-for-10 reverse split tagged as 0.1 so 100M pre-split shares become 10M", () => {
    const splits = discoverStockSplits(
      facts(
        { [SPLIT_RATIO_TAG]: [{ end: "2026-06-15", val: 0.1, filed: "2026-08-05", form: "10-Q" }], [DILUTED]: restated(100_000_000, 10_000_000) },
        { [SPLIT_RATIO_TAG]: "pure" },
      ),
      "2026-09-30",
    );
    expect(splits.events).toEqual([{ date: "2026-06-15", ratio: 0.1, tagged: 0.1, evidence: 0.1 }]);
    expect(100_000_000 * splits.factorFor("2026-05-05")).toBe(10_000_000);
    expect(10_000_000 * splits.factorFor("2026-08-05")).toBe(10_000_000);
  });

  it("names a cover count measured before a split but filed after it as of unknown basis", () => {
    const splits = discoverStockSplits(
      facts(
        { [SPLIT_RATIO_TAG]: [{ end: "2026-06-15", val: 4, filed: "2026-08-05", form: "10-Q" }], [DILUTED]: restated(10_000_000, 40_000_000) },
        { [SPLIT_RATIO_TAG]: "pure" },
      ),
      "2026-09-30",
    );
    expect(splits.shareCountBasisIssue("2026-06-10", "2026-06-20")).toBe(
      "the share count was measured 2026-06-10, before the 4-for-1 split of 2026-06-15, but filed 2026-06-20, after it, so whether it is stated on the pre- or post-split basis cannot be established",
    );
    // Measured and filed on the same side of the split: the basis is known.
    expect(splits.shareCountBasisIssue("2026-04-24", "2026-05-05")).toBeNull();
    expect(splits.shareCountBasisIssue("2026-06-15", "2026-06-20")).toBeNull();
    // A statement figure filed after the split is restated to it (ASC 260 / SAB Topic 4C).
    expect(splits.shareCountBasisIssue(null, "2026-06-20")).toBeNull();
  });

  it("names a source split-adjusted before an applied split as off the share basis", () => {
    const splits = discoverStockSplits(
      facts(
        { [SPLIT_RATIO_TAG]: [{ end: "2026-06-15", val: 4, filed: "2026-08-05", form: "10-Q" }], [DILUTED]: restated(10_000_000, 40_000_000) },
        { [SPLIT_RATIO_TAG]: "pure" },
      ),
      "2026-09-30",
    );
    expect(splits.sourceBasisIssue("2026-06-10")).toBe(
      "the source figure is split-adjusted only as of 2026-06-10, before the 4-for-1 split of 2026-06-15, while the share counts are on the post-split basis of 2026-09-30",
    );
    expect(splits.sourceBasisIssue("2026-06-15")).toBeNull();
    expect(splits.sourceBasisIssue("2026-09-30")).toBeNull();
  });

  it("does not apply a split whose tagged dates fall on both sides of the analysis date, and withholds every basis", () => {
    const splits = discoverStockSplits(
      facts(
        {
          [SPLIT_RATIO_TAG]: [
            { end: "2026-09-20", val: 3, filed: "2026-09-21", form: "8-K" },
            { end: "2026-10-20", val: 3, filed: "2026-09-21", form: "8-K" },
          ],
        },
        { [SPLIT_RATIO_TAG]: "pure" },
      ),
      "2026-09-30",
    );
    expect(splits.events).toEqual([]);
    expect(splits.pending).toEqual([]);
    expect(splits.unresolved).toEqual([{ from: "2026-09-20", to: "2026-10-20" }]);
    expect(splits.factorFor("2026-08-05")).toBe(1);
    expect(splits.notes[0]).toMatchObject({ date: "2026-09-20", severity: "warn" });
    expect(splits.notes[0]!.text).toMatch(/filings also date it 2026-10-20, after 2026-09-30, so whether it had taken effect by 2026-09-30 cannot be established/);
    expect(splits.shareCountBasisIssue(null, "2026-09-25")).toMatch(
      /^the share count was filed 2026-09-25, before the split tagged 2026-09-20 and 2026-10-20 .* its share basis at 2026-09-30 is unknown$/,
    );
    expect(splits.sourceBasisIssue("2026-09-30")).toMatch(
      /^the source figure is split-adjusted only as of 2026-09-30, before the split tagged 2026-09-20 and 2026-10-20 /,
    );
  });

  it("marks share counts filed before a ratio the filings dispute as of unknown basis, and later ones as known", () => {
    const splits = discoverStockSplits(appleSplit2020({ [SPLIT_RATIO_TAG]: [
      { end: "2020-08-28", val: 4, filed: "2020-10-30" },
      { end: "2020-08-28", val: 5, filed: "2021-10-29" },
    ] }), AS_OF);
    expect(splits.events).toEqual([]);
    expect(splits.unresolved).toEqual([{ from: "2020-08-28", to: "2020-08-28" }]);
    expect(splits.shareCountBasisIssue(null, "2019-10-31")).toMatch(/^the share count was filed 2019-10-31, before the split tagged 2020-08-28 /);
    expect(splits.shareCountBasisIssue(null, "2020-10-30")).toBeNull();
    expect(splits.sourceBasisIssue("2020-08-27")).toMatch(/before the split tagged 2020-08-28 /);
    expect(splits.sourceBasisIssue("2026-09-30")).toBeNull();
  });

  it("finds no basis issue at all when no split was tagged", () => {
    const splits = discoverStockSplits(facts({ [DILUTED]: [{ ...Q1_2026, val: 10_000_000, filed: "2026-05-05" }] }), "2026-09-30");
    expect(splits).toMatchObject({ asOf: "2026-09-30", events: [], pending: [], unresolved: [], notes: [] });
    expect(splits.factorFor("2020-01-01")).toBe(1);
    expect(splits.shareCountBasisIssue("2026-04-24", "2026-05-05")).toBeNull();
    expect(splits.sourceBasisIssue("2020-01-01")).toBeNull();
  });
});
