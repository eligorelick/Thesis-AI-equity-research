// tests/stageB.betaEstimate.test.ts
import { describe, expect, it } from "vitest";
import {
  BETA_MIN_MONTHS,
  blumeAdjust,
  estimateBeta,
  isMonthComplete,
  monthEndCloses,
} from "@/pipeline/stageB/betaEstimate";

/**
 * Daily closes for `months` COMPLETE calendar months (every weekday through
 * the month's last weekday) where the symbol's monthly log return is beta ×
 * benchmark's. Complete months matter: the estimator drops a month whose
 * last observation is not in the month's closing days (audit 2026-09-06).
 */
function series(months: number, beta: number, start = "2021-01-04") {
  const symbol: { date: string; close: number }[] = [];
  const bench: { date: string; close: number }[] = [];
  let s = 100;
  let b = 100;
  const d = new Date(`${start}T00:00:00Z`);
  for (let m = 0; m < months; m++) {
    const benchReturn = ((m % 5) - 2) * 0.02; // −4%, −2%, 0, +2%, +4% pattern
    const month = d.getUTCMonth();
    while (d.getUTCMonth() === month) {
      if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
        const iso = d.toISOString().slice(0, 10);
        symbol.push({ date: iso, close: s });
        bench.push({ date: iso, close: b });
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }
    b *= Math.exp(benchReturn);
    s *= Math.exp(beta * benchReturn);
  }
  return { symbol, bench };
}

/** The first two weekdays of the month after `lastIso`. */
function nextMonthStub(lastIso: string): [string, string] {
  const d = new Date(`${lastIso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1, 1);
  const days: string[] = [];
  while (days.length < 2) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return [days[0]!, days[1]!];
}

describe("estimateBeta", () => {
  it("recovers a known slope from monthly log returns", () => {
    const { symbol, bench } = series(40, 1.3);
    const result = estimateBeta(symbol, bench);
    expect(result.beta).not.toBeNull();
    expect(result.beta!).toBeCloseTo(1.3, 6);
    expect(result.rSquared!).toBeCloseTo(1, 6);
    expect(result.months).toBe(39); // 40 month-ends → 39 returns
    expect(result.gap).toBeNull();
    expect(result.note).toMatch(/39 monthly/);
  });

  it("uses at most 60 months and reports the window it measured", () => {
    const { symbol, bench } = series(80, 0.8);
    const result = estimateBeta(symbol, bench);
    expect(result.months).toBe(60);
    expect(result.beta!).toBeCloseTo(0.8, 6);
    expect(result.windowStart! < result.windowEnd!).toBe(true);
  });

  it("refuses fewer than 24 months and says so", () => {
    const { symbol, bench } = series(18, 1.1);
    const result = estimateBeta(symbol, bench);
    expect(result.beta).toBeNull();
    expect(result.gap?.field).toBe("profile.beta");
    expect(result.gap?.reason).toMatch(/17 monthly returns.*24/);
  });

  it("aligns on shared month-ends and ignores months only one series has", () => {
    const { symbol, bench } = series(40, 1.0);
    const trimmedBench = bench.filter((row) => row.date >= "2021-06-01");
    const result = estimateBeta(symbol, trimmedBench);
    expect(result.beta!).toBeCloseTo(1.0, 6);
    expect(result.months).toBeLessThan(39);
  });

  it("returns null beta with a gap when the benchmark has no variance", () => {
    const { symbol } = series(30, 1.0);
    const flat = symbol.map((row) => ({ date: row.date, close: 100 }));
    const result = estimateBeta(symbol, flat);
    expect(result.beta).toBeNull();
    expect(result.gap?.reason).toMatch(/variance/);
  });

  it("monthEndCloses keeps the last trading day of each month, newest first", () => {
    const { symbol } = series(3, 1.0);
    const ends = monthEndCloses(symbol);
    expect(ends).toHaveLength(3);
    expect(ends[0]!.date > ends[1]!.date).toBe(true);
    for (const end of ends) expect(symbol.some((r) => r.date === end.date)).toBe(true);
  });

  // Audit 2026-09-06: a history that ends on the fetch date closes with a stub
  // of a few sessions, and one earnings day regressed at the weight of a full
  // month moved the slope by a tenth. The month in progress is not a monthly
  // observation.
  it("excludes the month in progress: a two-session stub is not a monthly return", () => {
    const { symbol, bench } = series(40, 1.3);
    const last = symbol[symbol.length - 1]!.date;
    const [d1, d2] = nextMonthStub(last);
    const s0 = symbol[symbol.length - 1]!.close;
    const b0 = bench[bench.length - 1]!.close;
    // An idiosyncratic −20% move over two sessions, benchmark flat.
    const sym = [...symbol, { date: d1, close: s0 * 0.85 }, { date: d2, close: s0 * 0.8 }];
    const ben = [...bench, { date: d1, close: b0 }, { date: d2, close: b0 }];
    const result = estimateBeta(sym, ben);
    expect(result.months).toBe(39);
    expect(result.beta!).toBeCloseTo(1.3, 6);
    expect(result.windowEnd).toBe(last);
    expect(result.note).toMatch(new RegExp(`partial month ${d1.slice(0, 7)} in progress is excluded`));
  });

  it("keeps a month whose last observation falls in its closing days", () => {
    expect(isMonthComplete("2024-11-29")).toBe(true); // Thanksgiving Friday close
    expect(isMonthComplete("2021-05-28")).toBe(true); // Memorial Day on the 31st
    expect(isMonthComplete("2024-05-02")).toBe(false);
    expect(isMonthComplete("2024-05-20")).toBe(false);
  });
});

/**
 * D-15. Three things a discount rate depends on that the estimator used to
 * leave out: the price basis (a dividend payer's return is understated in
 * every ex-dividend month if only the close is used), the uncertainty of the
 * slope, and the mean-reversion adjustment vendors publish.
 */
describe("estimateBeta — D-15 basis, uncertainty and the Blume adjustment", () => {
  /**
   * Same construction as `series`, but the ADJUSTED series carries the true
   * relationship while the raw closes carry a different one: whichever basis
   * the estimator picks is then visible in the slope it returns.
   */
  function twoBasisSeries(months: number, adjBeta: number, closeBeta: number) {
    const symbol: { date: string; close: number; adjClose: number }[] = [];
    const bench: { date: string; close: number; adjClose: number }[] = [];
    let sAdj = 100;
    let sClose = 100;
    let b = 100;
    const d = new Date("2021-01-04T00:00:00Z");
    for (let m = 0; m < months; m++) {
      const benchReturn = ((m % 5) - 2) * 0.02;
      const month = d.getUTCMonth();
      while (d.getUTCMonth() === month) {
        if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
          const iso = d.toISOString().slice(0, 10);
          symbol.push({ date: iso, close: sClose, adjClose: sAdj });
          // The benchmark's two bases move together, so only the symbol's choice
          // of basis changes the measured slope.
          bench.push({ date: iso, close: b, adjClose: b });
        }
        d.setUTCDate(d.getUTCDate() + 1);
      }
      b *= Math.exp(benchReturn);
      sAdj *= Math.exp(adjBeta * benchReturn);
      sClose *= Math.exp(closeBeta * benchReturn);
    }
    return { symbol, bench };
  }

  it("regresses the dividend-adjusted closes when both series carry them", () => {
    const { symbol, bench } = twoBasisSeries(40, 1.4, 0.6);
    const result = estimateBeta(symbol, bench);
    expect(result.basis).toBe("dividend-adjusted close");
    expect(result.beta!).toBeCloseTo(1.4, 6);
    expect(result.note).toMatch(/dividend-adjusted closes/);
    expect(result.disclosure?.severity).toBe("info");
    expect(result.disclosure?.expected).toBe(true);
  });

  it("falls back to closing prices, and says so as a warning, when the benchmark has no adjusted series", () => {
    const { symbol, bench } = twoBasisSeries(40, 1.4, 0.6);
    const priceOnlyBench = bench.map((row) => ({ date: row.date, close: row.close }));
    const result = estimateBeta(symbol, priceOnlyBench);
    // The unadjusted relationship is what it measured: it did NOT mix an
    // adjusted symbol series with an unadjusted benchmark.
    expect(result.basis).toBe("close");
    expect(result.beta!).toBeCloseTo(0.6, 6);
    expect(result.disclosure?.severity).toBe("warn");
    expect(result.disclosure?.expected).toBeUndefined();
    expect(result.disclosure?.reason).toMatch(/ex-dividend date understates the return/);
  });

  it("falls back to closing prices when the adjusted series covers only part of the window", () => {
    const { symbol, bench } = twoBasisSeries(40, 1.4, 0.6);
    // One session in the window loses its adjusted close: a basis that changes
    // part-way through the window is not a basis.
    // A whole month loses its adjusted closes — including its month-end, which
    // is the only session the estimator reads.
    const patchy = symbol.map((row) =>
      row.date.startsWith("2021-03") ? { date: row.date, close: row.close } : row,
    );
    const result = estimateBeta(patchy, bench);
    expect(result.basis).toBe("close");
    expect(result.beta!).toBeCloseTo(0.6, 6);
  });

  it("reports the OLS standard error, which is ~0 for a perfect fit and grows with noise", () => {
    const exact = series(40, 1.3);
    const clean = estimateBeta(exact.symbol, exact.bench);
    // Not exactly zero: the residual sum of squares is a difference of two
    // large sums, so a perfect fit leaves floating-point dust.
    expect(clean.standardError!).toBeLessThan(1e-6);
    expect(clean.rSquared!).toBeCloseTo(1, 6);

    // Same slope, with an idiosyncratic wobble the benchmark cannot explain.
    const { symbol, bench } = series(40, 1.3);
    const noisy = symbol.map((row, i) => ({ date: row.date, close: row.close * (1 + (i % 7) * 0.01) }));
    const result = estimateBeta(noisy, bench);
    expect(result.standardError!).toBeGreaterThan(clean.standardError!);
    expect(result.rSquared!).toBeLessThan(1);
    expect(result.note).toMatch(/± \d+\.\d{3} \(OLS standard error\)/);
    expect(result.disclosure?.reason).toMatch(/standard error \d+\.\d{3}, R² \d+\.\d{3}/);
  });

  it("reports the Blume adjustment beside the raw slope, never in place of it", () => {
    const { symbol, bench } = series(40, 1.6);
    const result = estimateBeta(symbol, bench);
    expect(result.beta!).toBeCloseTo(1.6, 6);
    expect(result.betaBlume!).toBeCloseTo(blumeAdjust(1.6), 6);
    expect(result.betaBlume!).toBeCloseTo((2 / 3) * 1.6 + 1 / 3, 6);
    // Both numbers appear, and the raw one first.
    expect(result.note.indexOf("1.600")).toBeLessThan(result.note.indexOf("Blume-adjusted"));
    expect(result.disclosure?.reason).toMatch(/reported beside the raw slope, not in place of it/);
    // A beta of exactly 1 is its own Blume value: the adjustment pulls toward 1.
    expect(blumeAdjust(1)).toBeCloseTo(1, 12);
  });

  it("carries no beta, no error, no Blume value and no method disclosure below the minimum sample", () => {
    const { symbol, bench } = series(BETA_MIN_MONTHS - 2, 1.1);
    const result = estimateBeta(symbol, bench);
    expect(result.beta).toBeNull();
    expect(result.standardError).toBeNull();
    expect(result.betaBlume).toBeNull();
    expect(result.disclosure).toBeNull();
    expect(result.gap?.reason).toMatch(new RegExp(`${BETA_MIN_MONTHS} required`));
  });
});
