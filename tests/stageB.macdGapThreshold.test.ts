import { describe, expect, it } from "vitest";

import { computeTechnicals, macd } from "@/pipeline/stageB/technicals";

/**
 * MACD(12, 26, 9) needs 26 closes for the MACD line and 9 more MACD values for
 * its signal EMA, so the signal exists from the 34th row. The availability gap
 * fired below 35, so at exactly 34 rows the report disclosed a warn-severity
 * "MACD signal line unavailable" for a signal it had in fact computed.
 */
function rows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100 + i,
    volume: 1_000,
  }));
}

const macdGaps = (n: number) =>
  computeTechnicals(rows(n), [], [], null).gaps.filter(
    (g) => g.field === "technicals.macd",
  );

describe("MACD availability gap matches the real signal threshold", () => {
  it("computes a signal line at 34 rows", () => {
    expect(macd(rows(34)).signal).not.toBeNull();
    expect(macd(rows(33)).signal).toBeNull();
  });

  it("does not disclose the signal as unavailable once it exists", () => {
    expect(macdGaps(34)).toEqual([]);
  });

  it("still discloses it while it genuinely cannot be computed", () => {
    expect(macdGaps(33)).toHaveLength(1);
    expect(macdGaps(33)[0]?.reason).toMatch(/MACD signal line unavailable/);
  });
});
