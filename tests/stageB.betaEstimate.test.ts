// tests/stageB.betaEstimate.test.ts
import { describe, expect, it } from "vitest";
import { estimateBeta, monthEndCloses } from "@/pipeline/stageB/betaEstimate";

/** Daily closes for `months` months where the symbol's monthly log return is beta × benchmark's. */
function series(months: number, beta: number, start = "2021-01-04") {
  const symbol: { date: string; close: number }[] = [];
  const bench: { date: string; close: number }[] = [];
  let s = 100;
  let b = 100;
  const d = new Date(`${start}T00:00:00Z`);
  for (let m = 0; m < months; m++) {
    const benchReturn = ((m % 5) - 2) * 0.02; // −4%, −2%, 0, +2%, +4% pattern
    for (let day = 0; day < 20; day++) {
      d.setUTCDate(d.getUTCDate() + 1);
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      const iso = d.toISOString().slice(0, 10);
      symbol.push({ date: iso, close: s });
      bench.push({ date: iso, close: b });
    }
    b *= Math.exp(benchReturn);
    s *= Math.exp(beta * benchReturn);
    // advance to the next month
    d.setUTCMonth(d.getUTCMonth() + 1, 1);
  }
  return { symbol, bench };
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
});
