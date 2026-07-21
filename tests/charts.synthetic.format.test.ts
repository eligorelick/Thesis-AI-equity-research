/**
 * Unit tests for two pure presentation modules (no network, no DB):
 *
 *  - src/components/charts/synthetic.ts — the deterministic seeded generator
 *    behind /report/sample: syntheticMarketData (bars/crosses/relative
 *    strength) and syntheticFundamentals (revenue/margins/FCF/share count).
 *    Determinism is the module's contract (SSR/CSR must agree), so identical
 *    calls must be deep-equal.
 *
 *  - src/app/company/[symbol]/format.ts — display formatters (fmtNum, fmtPct,
 *    fmtSignedPct, fmtBig, fmtMoney, fmtX, upsidePct): main paths plus the
 *    null/undefined/non-finite sentinels ("n/a" / "n/m" / null).
 */

import { describe, expect, it } from "vitest";

import {
  syntheticMarketData,
  syntheticFundamentals,
} from "@/components/charts/synthetic";
import {
  fmtNum,
  fmtPct,
  fmtSignedPct,
  fmtBig,
  fmtMoney,
  fmtX,
  upsidePct,
} from "@/app/company/[symbol]/format";

/* ------------------------------------------------------------------------ *
 * syntheticMarketData
 * ------------------------------------------------------------------------ */

describe("syntheticMarketData", () => {
  it("is deterministic: identical calls produce deep-equal output", () => {
    const a = syntheticMarketData("AAPL");
    const b = syntheticMarketData("AAPL");
    expect(a).toEqual(b);
  });

  it("produces the requested number of weekday-only, strictly ascending bars", () => {
    const { bars } = syntheticMarketData("AAPL", "2025-09-27", 300);
    expect(bars).toHaveLength(300);
    for (const bar of bars) {
      const dow = new Date(`${bar.date}T00:00:00Z`).getUTCDay();
      expect(dow).not.toBe(0); // never Sunday
      expect(dow).not.toBe(6); // never Saturday
    }
    const dates = bars.map((b) => b.date);
    expect(dates).toEqual([...dates].sort());
    expect(new Set(dates).size).toBe(dates.length); // strictly ascending: sorted + unique
    // Anchor 2025-09-27 is a Saturday: the last bar is the prior weekday.
    expect(bars[bars.length - 1].date).toBe("2025-09-26");
  });

  it("renormalizes the walk so the final close lands exactly on the anchor close (255)", () => {
    const { bars } = syntheticMarketData("AAPL");
    expect(bars[bars.length - 1].close).toBe(255);
  });

  it("emits internally-consistent OHLCV bars (high >= open/close >= low, positive volume)", () => {
    const { bars } = syntheticMarketData("MSFT", "2025-09-27", 60);
    for (const bar of bars) {
      expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close));
      expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close));
      expect(bar.low).toBeGreaterThan(0);
      expect(bar.volume).toBeGreaterThan(0);
      expect(Number.isInteger(bar.volume)).toBe(true);
    }
  });

  it("places one golden-cross marker at ~70% of the window, on an in-series date", () => {
    const data = syntheticMarketData("AAPL", "2025-09-27", 100);
    expect(data.crosses).toEqual([{ date: data.bars[70].date, type: "golden" }]);
  });

  it("builds primary + SPY/XLK benchmark relative-strength series aligned to the bar dates", () => {
    const data = syntheticMarketData("NVDA", "2025-09-27", 50);
    expect(data.relativeStrength.map((s) => s.label)).toEqual(["NVDA", "SPY", "XLK"]);
    expect(data.relativeStrength.map((s) => s.role)).toEqual([
      "primary",
      "benchmark",
      "benchmark",
    ]);
    for (const series of data.relativeStrength) {
      expect(series.rows).toHaveLength(50);
      expect(series.rows.map((r) => r.date)).toEqual(data.bars.map((b) => b.date));
    }
    // Benchmark walks are renormalized to their own anchor closes.
    const spy = data.relativeStrength[1].rows;
    const xlk = data.relativeStrength[2].rows;
    expect(spy[spy.length - 1].close).toBeCloseTo(560, 8);
    expect(xlk[xlk.length - 1].close).toBeCloseTo(240, 8);
  });

  it("edge: a single-bar window still ends exactly on the anchor close", () => {
    const data = syntheticMarketData("AAPL", "2025-09-27", 1);
    expect(data.bars).toHaveLength(1);
    expect(data.bars[0].close).toBe(255);
    expect(data.relativeStrength[0].rows).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------ *
 * syntheticFundamentals
 * ------------------------------------------------------------------------ */

describe("syntheticFundamentals", () => {
  it("is deterministic and defaults to 8 fiscal years ending 2025-09-30", () => {
    const a = syntheticFundamentals();
    expect(a).toEqual(syntheticFundamentals());
    expect(a.revenue).toHaveLength(8);
    expect(a.margins).toHaveLength(8);
    expect(a.fcf).toHaveLength(8);
    expect(a.shareCount).toHaveLength(8);
    expect(a.revenue[0].period).toBe("2018-09-30");
    expect(a.revenue[7].period).toBe("2025-09-30");
  });

  it("first year has null YoY growth; later years carry numeric growth", () => {
    const { revenue } = syntheticFundamentals();
    expect(revenue[0].yoyGrowthPct).toBeNull();
    for (const row of revenue.slice(1)) {
      expect(typeof row.yoyGrowthPct).toBe("number");
    }
  });

  it("revenue grows, margins stay in plausible bands, FCF positive, shares shrink via buybacks", () => {
    const { revenue, margins, fcf, shareCount } = syntheticFundamentals();
    // The row interfaces allow null (real statements can have gaps), but the
    // synthetic generator always fills every field — assert that first, then
    // the non-null assertions below are safe.
    expect(revenue.every((r) => r.revenue !== null)).toBe(true);
    expect(shareCount.every((s) => s.dilutedShares !== null)).toBe(true);
    expect(margins.every((m) => m.grossPct !== null && m.operatingPct !== null && m.netPct !== null)).toBe(true);
    for (let i = 1; i < revenue.length; i++) {
      expect(revenue[i].revenue).toBeGreaterThan(revenue[i - 1].revenue!);
      expect(shareCount[i].dilutedShares).toBeLessThan(shareCount[i - 1].dilutedShares!);
    }
    for (const m of margins) {
      expect(m.grossPct).toBeGreaterThan(m.operatingPct!);
      expect(m.operatingPct).toBeGreaterThan(m.netPct!);
      expect(m.netPct).toBeGreaterThan(0);
      expect(m.grossPct).toBeLessThan(100);
    }
    for (const f of fcf) {
      expect(f.fcf).toBeGreaterThan(0);
      expect(f.conversionPct).toBeGreaterThan(0);
    }
  });

  it("honors custom end year and year count", () => {
    const data = syntheticFundamentals(2023, 3);
    expect(data.revenue.map((r) => r.period)).toEqual([
      "2021-09-30",
      "2022-09-30",
      "2023-09-30",
    ]);
  });

  it("edge: years = 0 yields empty series (no crash)", () => {
    const data = syntheticFundamentals(2025, 0);
    expect(data.revenue).toEqual([]);
    expect(data.margins).toEqual([]);
    expect(data.fcf).toEqual([]);
    expect(data.shareCount).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ *
 * format.ts
 * ------------------------------------------------------------------------ */

describe("fmtNum", () => {
  it("formats with grouping and fixed digits", () => {
    expect(fmtNum(1234.567)).toBe("1,234.57");
    expect(fmtNum(1234.567, 0)).toBe("1,235");
    expect(fmtNum(0)).toBe("0.00");
    expect(fmtNum(-1234.5)).toBe("-1,234.50");
  });

  it("sentinels: null / undefined / NaN / Infinity -> n/a", () => {
    expect(fmtNum(null)).toBe("n/a");
    expect(fmtNum(undefined)).toBe("n/a");
    expect(fmtNum(Number.NaN)).toBe("n/a");
    expect(fmtNum(Infinity)).toBe("n/a");
  });
});

describe("fmtPct / fmtSignedPct", () => {
  it("fmtPct renders unsigned percentages (negative keeps its minus)", () => {
    expect(fmtPct(12.34)).toBe("12.3%");
    expect(fmtPct(-5)).toBe("-5.0%");
    expect(fmtPct(0)).toBe("0.0%");
    expect(fmtPct(7.777, 2)).toBe("7.78%");
    expect(fmtPct(null)).toBe("n/a");
    expect(fmtPct(Number.NaN)).toBe("n/a");
  });

  it("fmtSignedPct prefixes + on non-negative values", () => {
    expect(fmtSignedPct(12.34)).toBe("+12.3%");
    expect(fmtSignedPct(0)).toBe("+0.0%");
    expect(fmtSignedPct(-5)).toBe("-5.0%");
    expect(fmtSignedPct(undefined)).toBe("n/a");
  });
});

describe("fmtBig", () => {
  it("scales T / B / M / K / raw with the documented digit counts", () => {
    expect(fmtBig(1.234e12)).toBe("1.23T");
    expect(fmtBig(45.6e9)).toBe("45.60B");
    expect(fmtBig(789e6)).toBe("789.00M");
    expect(fmtBig(12_345)).toBe("12.3K");
    expect(fmtBig(999.99)).toBe("999.99");
    expect(fmtBig(0)).toBe("0.00");
  });

  it("boundaries land on the larger unit exactly at the threshold", () => {
    expect(fmtBig(1e3)).toBe("1.0K");
    expect(fmtBig(1e6)).toBe("1.00M");
    expect(fmtBig(1e9)).toBe("1.00B");
    expect(fmtBig(1e12)).toBe("1.00T");
    expect(fmtBig(999_999)).toBe("1000.0K"); // just under 1M stays in K (rounded)
  });

  it("keeps the sign outside the scaled magnitude", () => {
    expect(fmtBig(-45.6e9)).toBe("-45.60B");
    expect(fmtBig(-12_345)).toBe("-12.3K");
  });

  it("sentinels -> n/a", () => {
    expect(fmtBig(null)).toBe("n/a");
    expect(fmtBig(undefined)).toBe("n/a");
    expect(fmtBig(Number.NaN)).toBe("n/a");
    expect(fmtBig(-Infinity)).toBe("n/a");
  });
});

describe("fmtMoney", () => {
  it("prefixes $ with grouping", () => {
    expect(fmtMoney(1234.5)).toBe("$1,234.50");
    expect(fmtMoney(0.125, 3)).toBe("$0.125");
  });

  it("negative values render as $-… (sign INSIDE the currency prefix — current behavior)", () => {
    expect(fmtMoney(-5)).toBe("$-5.00");
  });

  it("sentinels -> n/a", () => {
    expect(fmtMoney(null)).toBe("n/a");
    expect(fmtMoney(Number.NaN)).toBe("n/a");
  });
});

describe("fmtX", () => {
  it("renders multiples with the × suffix", () => {
    expect(fmtX(2.5)).toBe("2.5×");
    expect(fmtX(28.37, 2)).toBe("28.37×");
    expect(fmtX(-1.2)).toBe("-1.2×");
  });

  it("uses the n/m sentinel (not n/a) for missing/non-finite", () => {
    expect(fmtX(null)).toBe("n/m");
    expect(fmtX(undefined)).toBe("n/m");
    expect(fmtX(Number.NaN)).toBe("n/m");
  });
});

describe("upsidePct", () => {
  it("computes percentage upside/downside vs price", () => {
    expect(upsidePct(180, 150)).toBeCloseTo(20, 10);
    expect(upsidePct(140, 200)).toBeCloseTo(-30, 10);
    expect(upsidePct(150, 150)).toBe(0);
  });

  it("null on missing inputs, zero price, or non-finite values", () => {
    expect(upsidePct(null, 150)).toBeNull();
    expect(upsidePct(180, null)).toBeNull();
    expect(upsidePct(180, 0)).toBeNull();
    expect(upsidePct(Number.NaN, 150)).toBeNull();
    expect(upsidePct(180, Infinity)).toBeNull();
  });
});
