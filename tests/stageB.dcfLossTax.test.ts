import { describe, expect, it } from "vitest";

import { runDcf, type DcfAssumptions } from "@/pipeline/stageB/valuation";

/**
 * NOPAT = EBIT x (1 - t) applied to a NEGATIVE EBIT credits the firm a cash tax
 * refund of |EBIT| x t that it never receives. That shrinks the modelled loss
 * and inflates the DCF — on exactly the unprofitable issuers whose valuation is
 * least certain. The asymmetry was visible one line away: reinvestment was
 * already floored at 0.
 *
 * Losses now earn no refund and are instead carried forward to shelter later
 * taxable income inside the explicit horizon.
 */
const a = (v: number) => ({ value: v, basis: "test" });
const arr = (v: number[]) => ({ value: v, basis: "test" });

function assumptions(marginPath: number[], taxPct = 25): DcfAssumptions {
  const years = marginPath.length;
  return {
    startRevenue: a(1000),
    years,
    wacc: a(9),
    sbc: {
      value: { beforeSbc: null, afterSbc: null, sbc: null, asOf: null, basis: "test" },
      basis: "test",
    },
    growthAnchor: {
      pointPct: 0,
      rangePct: null,
      methods: [{ name: "test", valuePct: 0, detail: "test" }],
      unavailable: [],
      basis: "test",
    },
    growthPath: arr(marginPath.map(() => 0)),
    ebitMarginPath: arr(marginPath),
    taxRatePath: arr(marginPath.map(() => taxPct)),
    salesToCapital: a(2),
    terminal: {
      gTermPct: a(2),
      roicTermPct: a(12),
      reinvestmentRate: a(2 / 12),
    },
    midYear: { value: false, basis: "test" },
    asOf: { statements: "2025-12-31", estimates: null },
    notes: [],
  };
}

const RUN = { waccPct: 9, netDebt: 0, dilutedShares: 100 };

describe("DCF does not credit a tax refund on operating losses", () => {
  it("a loss year's NOPAT equals its EBIT (no refund)", () => {
    const y1 = runDcf(assumptions([-10, -10, -10, -10, -10]), RUN).yearRows[0];

    expect(y1).toBeDefined();
    if (!y1) return;
    expect(y1.ebit).toBeLessThan(0);
    // A refund would make nopat = ebit * 0.75, i.e. LESS negative than ebit.
    expect(y1.nopat).toBeCloseTo(y1.ebit, 6);
    expect(y1.taxRatePct).toBe(0);
  });

  it("a profitable year is taxed normally when there is no loss to carry", () => {
    const y1 = runDcf(assumptions([20, 20, 20, 20, 20]), RUN).yearRows[0];

    expect(y1).toBeDefined();
    if (!y1) return;
    expect(y1.nopat).toBeCloseTo(y1.ebit * 0.75, 6);
    expect(y1.taxRatePct).toBeCloseTo(25, 6);
  });

  it("carries a loss forward to shelter a later profitable year", () => {
    // Year 1 loses 100; year 2 earns 100 and should pay no tax on it.
    const r = runDcf(assumptions([-10, 10, 10, 10, 10]), RUN);
    const y1 = r.yearRows[0];
    const y2 = r.yearRows[1];

    expect(y1 && y2).toBeTruthy();
    if (!y1 || !y2) return;
    expect(y1.nopat).toBeCloseTo(y1.ebit, 6);
    // The carried-forward loss fully shelters year 2's equal-sized profit.
    expect(y2.nopat).toBeCloseTo(y2.ebit, 6);
    expect(y2.taxRatePct).toBeCloseTo(0, 6);
  });

  it("is strictly more conservative than the old refund behaviour on loss years", () => {
    const r = runDcf(assumptions([-10, -10, 5, 5, 5]), RUN);

    for (const y of r.yearRows) {
      if (y.ebit < 0) expect(y.nopat).toBeLessThanOrEqual(y.ebit * 0.75);
    }
  });
});
