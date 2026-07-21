/**
 * Unit tests for src/components/charts/format.ts — the pure formatters and
 * data-shaping helpers behind the chart components. NO DOM / no chart rendering:
 * everything here is a pure function.
 */

import { describe, expect, it } from "vitest";
import {
  EM_DASH,
  compactCurrency,
  compactNumber,
  fiscalYear,
  heatmapColor,
  heatmapRange,
  money,
  multiple,
  normalizeToRange,
  pct,
  price,
  rebaseTo100,
  signedPct,
  smaSeries,
  type DatedClose,
} from "@/components/charts/format";

/* ------------------------------------------------------------------------ *
 * compactNumber / compactCurrency
 * ------------------------------------------------------------------------ */

describe("compactNumber", () => {
  it("scales into T/B/M/K with one decimal by default", () => {
    expect(compactNumber(1_230_000_000_000)).toBe("1.2T");
    expect(compactNumber(45_600_000_000)).toBe("45.6B");
    expect(compactNumber(789_000_000)).toBe("789.0M");
    expect(compactNumber(12_300)).toBe("12.3K");
  });

  it("drops decimals for plain values >= 100", () => {
    expect(compactNumber(123.456)).toBe("123");
    expect(compactNumber(42.5)).toBe("42.5");
  });

  it("carries the sign into scaled output", () => {
    expect(compactNumber(-2_500_000_000)).toBe("-2.5B");
  });

  it("returns em-dash for null / undefined / non-finite", () => {
    expect(compactNumber(null)).toBe(EM_DASH);
    expect(compactNumber(undefined)).toBe(EM_DASH);
    expect(compactNumber(Number.NaN)).toBe(EM_DASH);
    expect(compactNumber(Number.POSITIVE_INFINITY)).toBe(EM_DASH);
  });

  it("honors a custom digit count", () => {
    expect(compactNumber(1_234_000_000, 2)).toBe("1.23B");
  });
});

describe("compactCurrency", () => {
  it("prefixes a dollar sign and keeps the sign outside", () => {
    expect(compactCurrency(45_600_000_000)).toBe("$45.6B");
    expect(compactCurrency(-1_200_000_000)).toBe("-$1.2B");
  });
  it("null → em-dash", () => {
    expect(compactCurrency(null)).toBe(EM_DASH);
  });
});

/* ------------------------------------------------------------------------ *
 * pct / signedPct / price / money / multiple / fiscalYear
 * ------------------------------------------------------------------------ */

describe("pct & signedPct", () => {
  it("formats percent without forcing a sign", () => {
    expect(pct(12.34)).toBe("12.3%");
    expect(pct(-4.5)).toBe("-4.5%");
  });
  it("signedPct forces a leading + for non-negatives", () => {
    expect(signedPct(12.34)).toBe("+12.3%");
    expect(signedPct(0)).toBe("+0.0%");
    expect(signedPct(-4.5)).toBe("-4.5%");
  });
  it("null → em-dash", () => {
    expect(pct(null)).toBe(EM_DASH);
    expect(signedPct(undefined)).toBe(EM_DASH);
  });
});

describe("price & money", () => {
  it("price fixes 2 decimals with grouping", () => {
    expect(price(1234.5)).toBe("1,234.50");
  });
  it("money prefixes a dollar and handles negatives", () => {
    expect(money(1234.5)).toBe("$1,234.50");
    expect(money(-12.3)).toBe("-$12.30");
  });
  it("null → em-dash", () => {
    expect(price(null)).toBe(EM_DASH);
    expect(money(Number.NaN)).toBe(EM_DASH);
  });
});

describe("multiple", () => {
  it("appends a times sign", () => {
    expect(multiple(12.34)).toBe("12.3×");
  });
  it("null → n/m", () => {
    expect(multiple(null)).toBe("n/m");
    expect(multiple(Number.POSITIVE_INFINITY)).toBe("n/m");
  });
});

describe("fiscalYear", () => {
  it("takes the leading 4 chars", () => {
    expect(fiscalYear("2025-09-28")).toBe("2025");
    expect(fiscalYear("2024-12-31T00:00:00")).toBe("2024");
  });
  it("passes through short/absent input", () => {
    expect(fiscalYear(null)).toBe(EM_DASH);
    expect(fiscalYear("")).toBe(EM_DASH);
  });
});

/* ------------------------------------------------------------------------ *
 * rebaseTo100
 * ------------------------------------------------------------------------ */

describe("rebaseTo100", () => {
  it("sets the first finite/positive close to 100 and scales the rest", () => {
    const rows: DatedClose[] = [
      { date: "2025-01-01", close: 50 },
      { date: "2025-01-02", close: 55 },
      { date: "2025-01-03", close: 45 },
    ];
    const out = rebaseTo100(rows);
    expect(out[0].value).toBe(100);
    expect(out[1].value).toBeCloseTo(110, 6);
    expect(out[2].value).toBeCloseTo(90, 6);
  });

  it("skips leading non-finite/non-positive closes when choosing the base", () => {
    const rows: DatedClose[] = [
      { date: "2025-01-01", close: Number.NaN },
      { date: "2025-01-02", close: 0 },
      { date: "2025-01-03", close: 20 },
      { date: "2025-01-04", close: 30 },
    ];
    const out = rebaseTo100(rows);
    expect(out[0].value).toBeNull();
    expect(out[1].value).toBeNull();
    expect(out[2].value).toBe(100);
    expect(out[3].value).toBeCloseTo(150, 6);
  });

  it("maps interior non-finite closes to null without breaking the base", () => {
    const rows: DatedClose[] = [
      { date: "2025-01-01", close: 10 },
      { date: "2025-01-02", close: Number.NaN },
      { date: "2025-01-03", close: 12 },
    ];
    const out = rebaseTo100(rows);
    expect(out[0].value).toBe(100);
    expect(out[1].value).toBeNull();
    expect(out[2].value).toBeCloseTo(120, 6);
  });

  it("empty input → empty output", () => {
    expect(rebaseTo100([])).toEqual([]);
  });

  it("does not mutate the input", () => {
    const rows: DatedClose[] = [{ date: "2025-01-01", close: 10 }];
    const snapshot = JSON.parse(JSON.stringify(rows));
    rebaseTo100(rows);
    expect(rows).toEqual(snapshot);
  });
});

/* ------------------------------------------------------------------------ *
 * smaSeries
 * ------------------------------------------------------------------------ */

describe("smaSeries", () => {
  it("is null until n values, then the trailing average", () => {
    const rows: DatedClose[] = [10, 20, 30, 40, 50].map((c, i) => ({
      date: `2025-01-0${i + 1}`,
      close: c,
    }));
    const out = smaSeries(rows, 3);
    expect(out.map((p) => p.value)).toEqual([null, null, 20, 30, 40]);
  });

  it("preserves dates alongside values", () => {
    const rows: DatedClose[] = [
      { date: "2025-01-01", close: 2 },
      { date: "2025-01-02", close: 4 },
    ];
    const out = smaSeries(rows, 2);
    expect(out[1]).toEqual({ date: "2025-01-02", value: 3 });
  });

  it("emits null across a window that contains a non-finite close", () => {
    const rows: DatedClose[] = [
      { date: "d1", close: 10 },
      { date: "d2", close: Number.NaN },
      { date: "d3", close: 30 },
      { date: "d4", close: 40 },
      { date: "d5", close: 50 },
    ];
    const out = smaSeries(rows, 3).map((p) => p.value);
    // windows [d1,d2,d3] and [d2,d3,d4] contain the NaN → null; [d3,d4,d5] ok.
    expect(out).toEqual([null, null, null, null, 40]);
  });

  it("n <= 0 or non-integer → all null with dates preserved", () => {
    const rows: DatedClose[] = [{ date: "d1", close: 10 }];
    expect(smaSeries(rows, 0).map((p) => p.value)).toEqual([null]);
    expect(smaSeries(rows, 2.5).map((p) => p.value)).toEqual([null]);
    expect(smaSeries(rows, 0)[0].date).toBe("d1");
  });

  it("history shorter than n → all null (skip-SMA200 case)", () => {
    const rows: DatedClose[] = [
      { date: "d1", close: 10 },
      { date: "d2", close: 20 },
    ];
    expect(smaSeries(rows, 200).every((p) => p.value === null)).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * normalizeToRange / heatmapColor / heatmapRange
 * ------------------------------------------------------------------------ */

describe("normalizeToRange", () => {
  it("maps min→0, max→1, midpoint→0.5", () => {
    expect(normalizeToRange(10, 10, 30)).toBe(0);
    expect(normalizeToRange(30, 10, 30)).toBe(1);
    expect(normalizeToRange(20, 10, 30)).toBe(0.5);
  });
  it("clamps out-of-range inputs to [0,1]", () => {
    expect(normalizeToRange(5, 10, 30)).toBe(0);
    expect(normalizeToRange(40, 10, 30)).toBe(1);
  });
  it("degenerate range (min==max) → 0.5 for finite input", () => {
    expect(normalizeToRange(10, 10, 10)).toBe(0.5);
  });
  it("null / non-finite → null", () => {
    expect(normalizeToRange(null, 0, 1)).toBeNull();
    expect(normalizeToRange(Number.NaN, 0, 1)).toBeNull();
    expect(normalizeToRange(5, Number.NaN, 1)).toBeNull();
  });
});

describe("heatmapColor", () => {
  it("null → transparent", () => {
    expect(heatmapColor(null)).toBe("transparent");
    expect(heatmapColor(Number.NaN)).toBe("transparent");
  });
  it("0 → red hue, 1 → green hue, 0.5 → amber hue", () => {
    expect(heatmapColor(0)).toBe("rgba(240, 82, 95, 0.22)");
    expect(heatmapColor(1)).toBe("rgba(46, 204, 143, 0.22)");
    expect(heatmapColor(0.5)).toBe("rgba(232, 179, 57, 0.22)");
  });
  it("interpolates between stops", () => {
    // Quarter point between red(0) and amber(0.5).
    expect(heatmapColor(0.25)).toBe("rgba(236, 131, 76, 0.22)");
  });
  it("clamps and honors a custom alpha", () => {
    expect(heatmapColor(2, 0.5)).toBe("rgba(46, 204, 143, 0.5)");
    expect(heatmapColor(-1, 0.5)).toBe("rgba(240, 82, 95, 0.5)");
  });
});

describe("heatmapRange", () => {
  it("returns min/max of the finite cells", () => {
    expect(heatmapRange([10, null, 5, 30, Number.NaN])).toEqual({
      min: 5,
      max: 30,
    });
  });
  it("single finite cell → min==max", () => {
    expect(heatmapRange([null, 42, null])).toEqual({ min: 42, max: 42 });
  });
  it("no finite cells → null", () => {
    expect(heatmapRange([null, Number.NaN])).toBeNull();
    expect(heatmapRange([])).toBeNull();
  });
});
