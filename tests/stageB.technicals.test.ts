/**
 * Stage B technicals — golden tests. Pure, no network.
 *
 * RSI anchors are hand-computed exact rationals (Wilder smoothing, simple-avg
 * seed); MACD is checked against the closed-form steady state of an EMA on an
 * exponential (geometric) price series; ATR against crafted gap days.
 */

import { describe, expect, it } from "vitest";

import {
  atr14,
  computeTechnicals,
  emaSeries,
  macd,
  maxDrawdown,
  range52w,
  relativeStrength,
  rsi14,
  rsiSeries,
  sanitizeRows,
  shiftMonths,
  sma,
  smaCross,
  trueRanges,
  volumeTrend,
  type OhlcvRow,
} from "@/pipeline/stageB/technicals";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** Consecutive calendar-day rows from closes (o=h=l=c unless overridden). */
function mkRows(closes: number[], start = "2024-01-02", volume = 1_000): OhlcvRow[] {
  const t0 = Date.parse(`${start}T00:00:00Z`);
  return closes.map((c, i) => ({
    date: new Date(t0 + i * DAY_MS).toISOString().slice(0, 10),
    open: c,
    high: c,
    low: c,
    close: c,
    volume,
  }));
}

/** Rows ENDING at `end`, one per calendar day, close = f(dateIso). */
function mkRowsEnding(end: string, days: number, f: (date: string) => number): OhlcvRow[] {
  const tEnd = Date.parse(`${end}T00:00:00Z`);
  const out: OhlcvRow[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(tEnd - i * DAY_MS).toISOString().slice(0, 10);
    const c = f(date);
    out.push({ date, open: c, high: c, low: c, close: c, volume: 1_000 });
  }
  return out;
}

function range(n: number, f: (i: number) => number): number[] {
  return Array.from({ length: n }, (_, i) => f(i));
}

// ---------------------------------------------------------------------------
// SMA
// ---------------------------------------------------------------------------

describe("sma", () => {
  it("computes a rolling mean with null warmup", () => {
    const rows = mkRows([1, 2, 3, 4, 5, 6]);
    const s = sma(rows, 3);
    expect(s.map((p) => p.value)).toEqual([null, null, 2, 3, 4, 5]);
    expect(s[2].date).toBe(rows[2].date);
  });

  it("returns all nulls when the window exceeds history or n is invalid", () => {
    expect(sma(mkRows([1, 2]), 3).map((p) => p.value)).toEqual([null, null]);
    expect(sma(mkRows([1, 2]), 0).map((p) => p.value)).toEqual([null, null]);
  });
});

describe("smaCross", () => {
  it("detects a death cross on a rise-then-fall series (fast=2, slow=3)", () => {
    const rows = mkRows([1, 2, 3, 2, 1]);
    const st = smaCross(rows, 2, 3);
    // i2: sma2=2.5 vs sma3=2 (+); i4: sma2=1.5 vs sma3=2 (−) → death at i4
    expect(st.state).toBe("death");
    expect(st.lastCrossType).toBe("death");
    expect(st.lastCrossDate).toBe(rows[4].date);
    expect(st.sma50).toBeCloseTo(1.5, 12);
    expect(st.sma200).toBeCloseTo(2, 12);
  });

  it("exact equality then same sign is NOT a cross", () => {
    // fast=1 (close), slow=2: signs +, 0, + → no cross
    const rows = mkRows([1, 2, 2, 3]);
    const st = smaCross(rows, 1, 2);
    expect(st.lastCrossDate).toBeNull();
    expect(st.lastCrossType).toBeNull();
    expect(st.state).toBe("golden");
  });

  it("exact equality then opposite sign IS a cross, dated at the sign flip", () => {
    // signs +, 0, − → death recorded on the day the sign turns negative
    const rows = mkRows([1, 2, 2, 1]);
    const st = smaCross(rows, 1, 2);
    expect(st.lastCrossType).toBe("death");
    expect(st.lastCrossDate).toBe(rows[3].date);
    expect(st.state).toBe("death");
  });

  it("no cross when fast stays above slow; <slow rows yields none/null", () => {
    const up = smaCross(mkRows(range(250, (i) => i + 1)), 50, 200);
    expect(up.state).toBe("golden");
    expect(up.lastCrossDate).toBeNull();
    expect(up.sma200).not.toBeNull();

    const short = smaCross(mkRows(range(150, (i) => i + 1)), 50, 200);
    expect(short.sma200).toBeNull();
    expect(short.state).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// RSI — hand-computed exact rationals (assert to 1e-6)
// ---------------------------------------------------------------------------

describe("rsiSeries / rsi14", () => {
  it("all-gain seed gives RSI 100, then Wilder-smoothed losses (exact rationals)", () => {
    // 14 consecutive +1 changes → avgGain=1, avgLoss=0 → RSI=100
    const closes = range(15, (i) => 100 + i);
    // then two −1 changes:
    // avgGain=13/14, avgLoss=1/14 → RSI = 100·13/14
    // avgGain=169/196, avgLoss=27/196 → RSI = 100·169/196
    closes.push(113, 112);
    const s = rsiSeries(closes, 14);
    expect(s[13]).toBeNull();
    expect(s[14]).toBeCloseTo(100, 6);
    expect(s[15]).toBeCloseTo((100 * 13) / 14, 6); // 92.857142857...
    expect(s[16]).toBeCloseTo((100 * 169) / 196, 6); // 86.224489795...
  });

  it("mixed hand-computed sequence matches to 1e-6", () => {
    const closes = [10, 11, 10.5, 11.5, 12, 11, 11, 12.5, 13, 12, 12.5, 13.5, 14, 13, 13.5, 14.5, 12];
    // seed gains sum 7.0, losses sum 3.5 → avgGain 0.5, avgLoss 0.25 → RSI 200/3
    // +1: avgGain 7.5/14, avgLoss 3.25/14 → RSI 100·7.5/10.75
    // −2.5: avgGain 97.5/196, avgLoss 77.25/196 → RSI 100·97.5/174.75
    const s = rsiSeries(closes, 14);
    expect(s[14]).toBeCloseTo(200 / 3, 6);
    expect(s[15]).toBeCloseTo((100 * 7.5) / 10.75, 6); // 69.767441860...
    expect(s[16]).toBeCloseTo((100 * 97.5) / 174.75, 6); // 55.793991416...
  });

  it("all-decline series pins RSI at 0; flat series returns the documented 50", () => {
    const down = rsiSeries(range(16, (i) => 100 - i), 14);
    expect(down[15]).toBeCloseTo(0, 12);
    const flat = rsiSeries(range(16, () => 100), 14);
    expect(flat[15]).toBe(50);
  });

  it("rsi14 over rows returns latest value + asOf, null when rows ≤ period", () => {
    const rows = mkRows(range(15, (i) => 100 + i));
    const r = rsi14(rows);
    expect(r.value).toBeCloseTo(100, 6);
    expect(r.asOf).toBe(rows[14].date);
    expect(rsi14(mkRows(range(14, (i) => 100 + i))).value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// EMA + MACD — synthetic exponential series (closed-form steady state)
// ---------------------------------------------------------------------------

describe("emaSeries", () => {
  it("seeds with the SMA of the first n values", () => {
    const e = emaSeries([1, 2, 3, 4, 5], 3);
    expect(e[0]).toBeNull();
    expect(e[1]).toBeNull();
    expect(e[2]).toBe(2); // SMA seed
    // k = 0.5: 4·0.5 + 2·0.5 = 3; 5·0.5 + 3·0.5 = 4
    expect(e[3]).toBeCloseTo(3, 12);
    expect(e[4]).toBeCloseTo(4, 12);
  });
});

describe("macd", () => {
  it("matches the closed-form steady state on an exponential series", () => {
    const g = 1.001;
    const closes = range(320, (i) => 100 * g ** i);
    const rows = mkRows(closes);
    const snap = macd(rows, 12, 26, 9);
    // For p_i = p0·g^i, EMA_n(i)/p_i → k·g/(g−1+k) with k = 2/(n+1)
    const f = (n: number) => {
      const k = 2 / (n + 1);
      return (k * g) / (g - 1 + k);
    };
    const lastClose = closes[closes.length - 1];
    const expectedMacd = lastClose * (f(12) - f(26));
    expect(snap.macd).not.toBeNull();
    expect(snap.signal).not.toBeNull();
    expect(snap.macd as number).toBeCloseTo(expectedMacd, expectedMacd * 1e-6 < 1e-6 ? 6 : 6);
    expect(Math.abs((snap.macd as number) / expectedMacd - 1)).toBeLessThan(1e-6);
    // signal is EMA9 of a geometric MACD series → same steady-state ratio
    const expectedSignal = (snap.macd as number) * f(9);
    expect(Math.abs((snap.signal as number) / expectedSignal - 1)).toBeLessThan(1e-6);
    expect(snap.histogram as number).toBeCloseTo((snap.macd as number) - (snap.signal as number), 12);
    expect(snap.macd as number).toBeGreaterThan(0);
    expect(snap.histogram as number).toBeGreaterThan(0);
    expect(snap.state).toBe("bullish");
    expect(snap.asOf).toBe(rows[rows.length - 1].date);
  });

  it("detects a bearish crossover after a rise-then-fall and reports recency", () => {
    // exponential rise (decisively positive histogram) then an ACCELERATING
    // decline (−1%, −2%, −3%, …) so |MACD| keeps growing and the histogram
    // stays negative after the bearish signal-line cross
    const closes = range(80, (i) => 100 * 1.005 ** i);
    let p = closes[closes.length - 1];
    for (let i = 0; i < 20; i++) {
      p *= 1 - 0.01 * (i + 1);
      closes.push(p);
    }
    const snap = macd(mkRows(closes));
    expect(snap.state).toBe("bearish");
    expect(snap.lastCrossoverType).toBe("bearish");
    expect(snap.lastCrossoverDate).not.toBeNull();
    expect(snap.barsSinceCrossover).not.toBeNull();
    expect(snap.barsSinceCrossover as number).toBeGreaterThanOrEqual(0);
    expect(snap.histogram as number).toBeLessThan(0);
  });

  it("degrades to nulls when history < slow period", () => {
    const snap = macd(mkRows(range(20, (i) => 100 + i)));
    expect(snap.macd).toBeNull();
    expect(snap.signal).toBeNull();
    expect(snap.histogram).toBeNull();
    expect(snap.state).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// ATR — true-range gap days + Wilder smoothing
// ---------------------------------------------------------------------------

describe("trueRanges / atr14", () => {
  it("true range picks the gap vs previous close", () => {
    const rows: OhlcvRow[] = [
      { date: "2024-01-02", open: 10, high: 10.5, low: 9.5, close: 10, volume: 1 },
      // gap up: h−l = 1, |h−prevC| = 5, |l−prevC| = 4 → TR 5
      { date: "2024-01-03", open: 14.5, high: 15, low: 14, close: 14.5, volume: 1 },
      // gap down: h−l = 0.5, |h−prevC| = 6.5, |l−prevC| = 7 → TR 7
      { date: "2024-01-04", open: 7.8, high: 8, low: 7.5, close: 7.9, volume: 1 },
    ];
    const trs = trueRanges(rows);
    expect(trs.map((t) => t.tr)).toEqual([5, 7]);
    expect(trs[0].date).toBe("2024-01-03");
  });

  it("Wilder ATR: simple-average seed then (prev·13 + TR)/14", () => {
    // 16 rows → 15 TRs. Constant close 100, h/l = ±0.5 → TR = 1 for the first
    // 14 TRs (seed = 1); final bar is a shock with TR 15 → ATR = (1·13+15)/14 = 2.
    const rows: OhlcvRow[] = [];
    const t0 = Date.parse("2024-01-02T00:00:00Z");
    for (let i = 0; i < 15; i++) {
      rows.push({
        date: new Date(t0 + i * DAY_MS).toISOString().slice(0, 10),
        open: 100,
        high: 100.5,
        low: 99.5,
        close: 100,
        volume: 1,
      });
    }
    rows.push({
      date: new Date(t0 + 15 * DAY_MS).toISOString().slice(0, 10),
      open: 100,
      high: 110,
      low: 95,
      close: 100,
      volume: 1,
    });
    const a = atr14(rows);
    expect(a.atr).toBeCloseTo(2, 12);
    expect(a.atrPctOfClose).toBeCloseTo(2, 12);
    expect(a.asOf).toBe(rows[15].date);
  });

  it("returns nulls when fewer than period+1 rows", () => {
    const a = atr14(mkRows(range(14, (i) => 100 + i)));
    expect(a.atr).toBeNull();
    expect(a.atrPctOfClose).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 52-week range
// ---------------------------------------------------------------------------

describe("range52w", () => {
  it("uses only the trailing 12 calendar months and positions the close", () => {
    // 400 daily rows; a 300 spike on day 0 falls OUTSIDE the 12mo window.
    const rows = mkRows(range(400, () => 100));
    rows[0] = { ...rows[0], high: 300, low: 100, close: 100, open: 100 };
    const iHigh = 300; // inside window
    const iLow = 350;
    rows[iHigh] = { ...rows[iHigh], high: 200 };
    rows[iLow] = { ...rows[iLow], low: 50 };
    rows[399] = { ...rows[399], close: 125 };
    const r = range52w(rows);
    expect(r.high52w).toBe(200);
    expect(r.low52w).toBe(50);
    expect(r.highDate).toBe(rows[iHigh].date);
    expect(r.lowDate).toBe(rows[iLow].date);
    expect(r.pctFromHigh).toBeCloseTo(-37.5, 10);
    expect(r.pctFromLow).toBeCloseTo(150, 10);
    expect(r.positionPct).toBeCloseTo(50, 10);
    expect(r.distanceFromHigh).toBeCloseTo(-75, 10);
    expect(r.distanceFromLow).toBeCloseTo(75, 10);
    expect(r.asOf).toBe(rows[399].date);
  });

  it("guards a degenerate zero-width range", () => {
    const r = range52w(mkRows(range(10, () => 100)));
    expect(r.positionPct).toBeNull(); // high == low
    expect(r.pctFromHigh).toBeCloseTo(0, 12);
    expect(r.pctFromLow).toBeCloseTo(0, 12);
  });

  it("returns nulls on empty input", () => {
    expect(range52w([]).high52w).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Relative strength
// ---------------------------------------------------------------------------

describe("relativeStrength", () => {
  it("computes 12mo total-return differential in pct points (step series)", () => {
    const end = "2026-06-30";
    const cutoff12 = shiftMonths(end, -12); // 2025-06-30
    expect(cutoff12).toBe("2025-06-30");
    const sym = mkRowsEnding(end, 400, (d) => (d <= cutoff12 ? 100 : 200));
    const spy = mkRowsEnding(end, 400, (d) => (d <= cutoff12 ? 100 : 110));
    const rs = relativeStrength(sym, spy, "SPY");
    const p12 = rs.points.find((p) => p.months === 12);
    const p6 = rs.points.find((p) => p.months === 6);
    expect(p12?.symbolReturnPct).toBeCloseTo(100, 10);
    expect(p12?.benchmarkReturnPct).toBeCloseTo(10, 10);
    expect(p12?.differentialPctPoints).toBeCloseTo(90, 10);
    // both series are flat inside the 6mo window → differential 0
    expect(p6?.differentialPctPoints).toBeCloseTo(0, 10);
    expect(rs.notes.join(" ")).toMatch(/approximate total return/i);
  });

  it("degrades with gaps when history is too short or benchmark missing", () => {
    const sym = mkRows(range(100, (i) => 100 + i)); // ~3.3 months of calendar days
    const rs = relativeStrength(sym, [], "SPY");
    const p12 = rs.points.find((p) => p.months === 12);
    expect(p12?.symbolReturnPct).toBeNull();
    expect(p12?.differentialPctPoints).toBeNull();
    expect(rs.gaps.some((g) => g.field === "technicals.relativeStrength.SPY")).toBe(true);
    expect(rs.gaps.some((g) => /12-month window/.test(g.reason))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Volume trend
// ---------------------------------------------------------------------------

describe("volumeTrend", () => {
  it("compares 20d vs 90d averages and labels by house thresholds", () => {
    const rows = mkRows(range(100, () => 100));
    for (let i = 0; i < 100; i++) rows[i] = { ...rows[i], volume: i >= 80 ? 2_000 : 1_000 };
    const v = volumeTrend(rows);
    expect(v.avg20d).toBeCloseTo(2_000, 10);
    expect(v.avg90d).toBeCloseTo(110_000 / 90, 10);
    expect(v.ratio).toBeCloseTo(2_000 / (110_000 / 90), 10);
    expect(v.state).toBe("rising");
  });

  it("returns nulls when fewer than 90 rows", () => {
    const v = volumeTrend(mkRows(range(50, () => 100)));
    expect(v.avg20d).not.toBeNull();
    expect(v.avg90d).toBeNull();
    expect(v.ratio).toBeNull();
    expect(v.state).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Max drawdown
// ---------------------------------------------------------------------------

describe("maxDrawdown", () => {
  it("finds depth, peak/trough dates, and recovery on a crafted series", () => {
    // 200 flat days (so the series spans >1y), then rise 100→200, fall to 120
    // (−40%), recover to 210 — the drama all inside the trailing 12 months
    const closes = [
      ...range(200, () => 100),
      ...range(50, (i) => 100 + (i * 100) / 49), // ends at 200
      ...range(40, (i) => 200 - (i + 1) * 2), // ends at 120
      ...range(90, (i) => 120 + (i + 1) * 1), // ends at 210
    ];
    const rows = mkRows(closes);
    const dd = maxDrawdown(rows, 1);
    expect(dd.depthPct).toBeCloseTo(40, 10);
    expect(dd.peakDate).toBe(rows[249].date);
    expect(dd.troughDate).toBe(rows[289].date);
    expect(dd.recovered).toBe(true);
    expect(dd.insufficientHistory).toBe(false);
  });

  it("reports not-recovered and flags insufficient history for long windows", () => {
    const closes = [...range(50, (i) => 100 + i), ...range(50, (i) => 149 - 2 * i)];
    const rows = mkRows(closes); // 100 days ≪ 3 years
    const dd = maxDrawdown(rows, 3);
    expect(dd.recovered).toBe(false);
    expect(dd.insufficientHistory).toBe(true);
    expect(dd.depthPct).toBeGreaterThan(0);
  });

  it("returns depth 0 with null dates on a monotonic rise, nulls on empty input", () => {
    const dd = maxDrawdown(mkRows(range(30, (i) => 100 + i)), 1);
    expect(dd.depthPct).toBe(0);
    expect(dd.peakDate).toBeNull();
    expect(dd.recovered).toBeNull();
    expect(maxDrawdown([], 1).depthPct).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sanitizeRows
// ---------------------------------------------------------------------------

describe("sanitizeRows", () => {
  it("drops invalid rows and re-sorts descending input with a note", () => {
    const good = mkRows([1, 2, 3]);
    const bad: OhlcvRow = { date: "not-a-date", open: 1, high: 1, low: 1, close: 1, volume: 1 };
    const zero: OhlcvRow = { date: "2024-06-01", open: 1, high: 1, low: 1, close: 0, volume: 1 };
    const { rows, notes } = sanitizeRows([...good].reverse().concat(bad, zero), "symbol");
    expect(rows.map((r) => r.close)).toEqual([1, 2, 3]);
    expect(notes.some((n) => /re-sorted/.test(n))).toBe(true);
    expect(notes.some((n) => /dropped 2 row/.test(n))).toBe(true);
  });

  it("truncates datetime strings to the day", () => {
    const { rows } = sanitizeRows(
      [{ date: "2024-01-02 00:00:00", open: 1, high: 1, low: 1, close: 1, volume: 1 }],
      "symbol",
    );
    expect(rows[0].date).toBe("2024-01-02");
  });
});

// ---------------------------------------------------------------------------
// computeTechnicals — assembly, degradation, flags
// ---------------------------------------------------------------------------

describe("computeTechnicals", () => {
  it("happy path: populated read, key levels, flags, and no critical gaps", () => {
    const closes = range(420, (i) => 100 * 1.001 ** i);
    const rows = mkRows(closes);
    const spy = mkRows(range(420, (i) => 100 * 1.0005 ** i));
    const sector = mkRows(range(420, (i) => 100 * 1.0007 ** i));
    const res = computeTechnicals(rows, spy, sector, "XLK");
    expect(res.asOf).toBe(rows[419].date);
    expect(res.lastClose).toBeCloseTo(closes[419], 10);
    expect(res.read.trend).toBe("uptrend");
    expect(res.read.keyLevels.sma50).not.toBeNull();
    expect(res.read.keyLevels.sma200).not.toBeNull();
    expect(res.read.keyLevels.high52w).not.toBeNull();
    expect(res.smaCross.state).toBe("golden");
    expect(res.rsi14).not.toBeNull();
    expect(res.macd.macd).not.toBeNull();
    expect(res.atr14.atr).not.toBeNull();
    expect(res.drawdowns).toHaveLength(3);
    expect(res.read.flags.length).toBeGreaterThan(0);
    expect(res.read.relativeStrength).toMatch(/vs SPY/);
    expect(res.read.relativeStrength).toMatch(/XLK/);
    expect(res.gaps.every((g) => g.severity !== "critical")).toBe(true);
    // house rules are annotated, never silent
    expect(res.notes.some((n) => /House rules/.test(n))).toBe(true);
    expect(res.notes.some((n) => /approximate total return/i.test(n))).toBe(true);
  });

  it("<200 rows degrades gracefully: null SMA200 + IPO-overlay gap and flag", () => {
    const rows = mkRows(range(150, (i) => 100 + i));
    const res = computeTechnicals(rows, [], [], null);
    expect(res.smaCross.sma200).toBeNull();
    expect(res.read.keyLevels.sma200).toBeNull();
    expect(res.gaps.some((g) => g.field === "technicals.sma200" && /recent-IPO/.test(g.reason))).toBe(true);
    expect(res.read.flags.some((f) => /SMA200 and long-window technicals unavailable/.test(f))).toBe(true);
    // SPY benchmark missing → warn gap; sector unrouted → info gap
    expect(res.gaps.some((g) => g.field === "technicals.relativeStrength.SPY" && g.severity === "warn")).toBe(true);
    expect(res.gaps.some((g) => g.field === "technicals.relativeStrength.sector" && g.severity === "info")).toBe(true);
    // still produces a trend read from SMA50 (house rule, annotated)
    expect(res.read.trend).not.toBe("insufficient-data");
    expect(res.notes.some((n) => /SMA50-only/.test(n))).toBe(true);
  });

  it("empty input never throws: critical gap + insufficient-data read", () => {
    const res = computeTechnicals([], [], [], null);
    expect(res.asOf).toBeNull();
    expect(res.lastClose).toBeNull();
    expect(res.rowsUsed).toBe(0);
    expect(res.read.trend).toBe("insufficient-data");
    expect(res.read.momentum).toBe("insufficient-data");
    expect(res.gaps.some((g) => g.field === "technicals" && g.severity === "critical")).toBe(true);
  });

  it("death-cross flag carries the cross date in plain English", () => {
    // long uptrend then hard downtrend → death cross somewhere in the fall
    const closes = [...range(260, (i) => 100 + i * 0.5), ...range(160, (i) => 230 - i * 0.8)];
    const res = computeTechnicals(mkRows(closes), [], [], null);
    expect(res.smaCross.state).toBe("death");
    expect(res.smaCross.lastCrossDate).not.toBeNull();
    const flag = res.read.flags.find((f) => /death cross on \d{4}-\d{2}-\d{2}/.test(f));
    expect(flag).toBeDefined();
    expect(flag).toMatch(/below SMA200/);
    expect(res.read.trend).toBe("downtrend");
  });

  it("unsorted input is re-sorted defensively with a note and same numbers", () => {
    const rows = mkRows(range(60, (i) => 100 + i));
    const sortedRes = computeTechnicals(rows, [], [], null);
    const shuffled = [...rows].reverse();
    const res = computeTechnicals(shuffled, [], [], null);
    expect(res.notes.some((n) => /re-sorted/.test(n))).toBe(true);
    expect(res.smaCross.sma50).toBeCloseTo(sortedRes.smaCross.sma50 as number, 12);
    expect(res.asOf).toBe(sortedRes.asOf);
  });
});

// ---------------------------------------------------------------------------
// shiftMonths (calendar-window helper)
// ---------------------------------------------------------------------------

describe("shiftMonths", () => {
  it("clamps day-of-month and crosses year boundaries", () => {
    expect(shiftMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(shiftMonths("2024-03-31", -1)).toBe("2024-02-29"); // leap year
    expect(shiftMonths("2026-01-15", -3)).toBe("2025-10-15");
    expect(shiftMonths("2026-06-30", -12)).toBe("2025-06-30");
  });
});
