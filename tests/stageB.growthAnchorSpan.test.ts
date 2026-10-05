/**
 * D-39: a growth-anchor CAGR method counts only when its measured span is its
 * window (±0.25 years, the same rule grading applies).
 *
 * Before the fix, a company with two years of annual history fed its one
 * two-year CAGR to the DCF anchor twice — once labelled "3y revenue CAGR" and
 * once "5y revenue CAGR" — beside the regression over the same three points.
 * The degraded CAGR series itself stays disclosed (D-37); only the anchor
 * declines to read it as a window it is not.
 *
 * Fixture: tests/helpers/currencyBundle.ts completeCurrencyBundle — annual
 * revenue 1,000 / 900 / 800 / 700 (FY2025 → FY2022), estimates removed so the
 * analyst-consensus method is unavailable.
 */
import { describe, expect, it } from "vitest";

import { runStageB, type ComputedMetrics } from "@/pipeline/compute";
import type { DataBundle } from "@/pipeline/types";
import type { GrowthAnchor } from "@/pipeline/stageB/valuation";

import { completeCurrencyBundle } from "./helpers/currencyBundle";

/** The bundle with only its newest `years` annual income rows. */
function withAnnualIncomeRows(years: number): DataBundle {
  const bundle = completeCurrencyBundle({ estimates: false });
  const income = bundle.statements.incomeAnnual as unknown as {
    value: { data: { rows: unknown[] } };
  };
  income.value.data.rows = income.value.data.rows.slice(0, years);
  return bundle;
}

function anchorOf(c: ComputedMetrics): GrowthAnchor {
  if (c.valuation.kind !== "dcf") throw new Error(`expected the DCF route, got ${c.valuation.kind}`);
  const anchor = c.valuation.assumptions?.growthAnchor;
  if (!anchor) throw new Error("expected a growth anchor");
  return anchor;
}

function method(anchor: GrowthAnchor, name: string) {
  const found = anchor.methods.find((m) => m.name === name);
  if (!found) throw new Error(`no ${name} method`);
  return found;
}

describe("growth anchor CAGR methods require their own window span (D-39)", () => {
  it("excludes a two-year CAGR from both the 3y and 5y methods and states the measured span", () => {
    const computed = runStageB(withAnnualIncomeRows(3));
    // The degraded series is still there, labelled with its actual span.
    const threeYear = computed.growth.revenueCagrs.find((c) => c.windowYears === 3);
    expect(threeYear?.actualYears).toBeCloseTo(2, 6);
    expect(threeYear?.cagrPct).not.toBeNull();

    const anchor = anchorOf(computed);
    for (const [name, window] of [["3y revenue CAGR", 3], ["5y revenue CAGR", 5]] as const) {
      const m = method(anchor, name);
      expect(m.valuePct).toBeNull();
      expect(m.detail).toBe(
        `unavailable: measured span 2.00 years, not the ${window}-year window (±0.25-year tolerance)`,
      );
      expect(anchor.unavailable).toContain(name);
    }
    const regression = method(anchor, "log-linear revenue regression");
    expect(regression.valuePct).not.toBeNull();
    expect(anchor.pointPct).toBe(regression.valuePct);
    expect(anchor.rangePct).toBeNull();
    expect(anchor.basis).toMatch(/^median of 1 available growth method = /);
  });

  it("keeps a 3y CAGR whose span is three years and excludes the 5y window it cannot fill", () => {
    const computed = runStageB(withAnnualIncomeRows(4));
    const anchor = anchorOf(computed);
    const threeYear = method(anchor, "3y revenue CAGR");
    const expected = computed.growth.revenueCagrs.find((c) => c.windowYears === 3)?.cagrPct;
    expect(expected).toBeTypeOf("number");
    expect(threeYear.valuePct).toBe(expected);
    expect(method(anchor, "5y revenue CAGR").detail).toBe(
      "unavailable: measured span 3.00 years, not the 5-year window (±0.25-year tolerance)",
    );
  });
});
