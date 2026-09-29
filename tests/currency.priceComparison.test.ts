/**
 * A statement-derived value may be compared with the quote only when both are
 * in one KNOWN currency. Unknown or different currencies must not produce an
 * upside, a price-based multiple, a reverse valuation, a market-value weight
 * or a grade built on one — and no FX conversion is invented. Values that do
 * not touch the quote (the DCF per share, the sensitivity grid, FFO per share)
 * are independently valid and stay.
 */
import { describe, expect, it } from "vitest";

import { runStageB, type ComputedMetrics } from "@/pipeline/compute";

import { currencyBundle, type CurrencyBundleOptions } from "./helpers/currencyBundle";

const UNLABELLED = [null, null, null, null] as const;
/** Statements with no currency anywhere: the model currency is unknown. */
const UNKNOWN_MODEL: CurrencyBundleOptions = { annualCurrency: null, quarterCurrencies: UNLABELLED };

function run(opts: CurrencyBundleOptions): ComputedMetrics {
  return runStageB(currencyBundle({ debt: 0, ...opts }));
}

function dcf(c: ComputedMetrics) {
  if (c.valuation.kind !== "dcf") throw new Error(`expected dcf, got ${c.valuation.kind}`);
  return c.valuation;
}

/** Current price-based multiples that were computed. */
function pricedMultiples(c: ComputedMetrics): string[] {
  const v = c.valuation;
  const stats = "multiples" in v && v.multiples ? v.multiples.multiples : [];
  return stats.filter((m) => m.current !== null).map((m) => m.key);
}

function dcfUpsideSignal(c: ComputedMetrics): number | null {
  const driver = c.scores.aspects.valuation.drivers.find((d) => /dcfUpside/.test(d.source));
  return driver?.value ?? null;
}

describe("price comparisons need one known currency", () => {
  const usd = run({});
  const jpy = run({ profileCurrency: "JPY", annualCurrency: "JPY" });

  it("controls: USD and JPY statements against a same-currency quote compare normally", () => {
    for (const c of [usd, jpy]) {
      expect(c.fairValue.upsidePct).not.toBeNull();
      expect(dcf(c).reverseDcf?.impliedRevenueGrowthPct ?? null).not.toBeNull();
      expect(pricedMultiples(c).length).toBeGreaterThan(0);
      expect(dcfUpsideSignal(c)).not.toBeNull();
      expect(c.gaps.some((g) => g.field === "valuation.priceComparison.currency")).toBe(false);
    }
  });

  for (const [label, opts] of [
    ["unknown model currency vs a USD quote", UNKNOWN_MODEL],
    ["a USD model vs an unknown quote currency", { profileCurrency: null }],
    ["TWD statements vs a USD quote", { annualCurrency: "TWD", quarterCurrencies: ["TWD", "TWD", "TWD", "TWD"] }],
  ] as const) {
    it(`${label}: no upside, reverse DCF, price multiple or upside grade signal`, () => {
      const c = run(opts);
      expect(c.fairValue.upsidePct).toBeNull();
      if (c.valuation.kind === "dcf") expect(c.valuation.reverseDcf).toBeNull();
      expect(pricedMultiples(c)).toEqual([]);
      expect(dcfUpsideSignal(c)).toBeNull();
      for (const target of c.scenarioTargets.status === "available" ? c.scenarioTargets.targets : []) {
        expect(target.upsidePct).toBeNull();
      }
      expect(c.gaps.find((g) => g.field === "valuation.priceComparison.currency")?.reason).toMatch(
        /quote|price/i,
      );
    });
  }

  it("keeps the price-free DCF: withholding the comparison changes no per-share value", () => {
    // Same USD statements, quote currency unknown: only the comparisons go.
    const unknownQuote = run({ profileCurrency: null });
    expect(dcf(unknownQuote).dcf?.perShare).toBeCloseTo(dcf(usd).dcf!.perShare!, 9);
    expect(dcf(unknownQuote).sensitivity?.perShare).toEqual(dcf(usd).sensitivity?.perShare);
    expect(unknownQuote.fairValue.perShare?.value).toBe(usd.fairValue.perShare?.value);
    // An unknown model currency still values the company (on the annual
    // statement, its TTM being unestablished); it just cannot be priced.
    expect(dcf(run(UNKNOWN_MODEL)).dcf?.perShare ?? null).not.toBeNull();
  });

  it("does not weight a market cap against a balance of unknown currency in the WACC", () => {
    const leveredUsd = runStageB(currencyBundle({}));
    const leveredUnknown = runStageB(currencyBundle(UNKNOWN_MODEL));
    expect(leveredUsd.returns.wacc.weightEquity).not.toBeNull();
    expect(leveredUnknown.returns.wacc.weightEquity).toBeNull();
    expect(leveredUnknown.returns.wacc.waccPct).toBeNull();
    // The currency-free legs stay.
    expect(leveredUnknown.returns.wacc.costOfEquityPct).toBe(leveredUsd.returns.wacc.costOfEquityPct);
    expect(leveredUnknown.gaps.find((g) => g.field === "returns.wacc.weights.currency")?.reason).toMatch(/unknown/);
  });

  it("does not score Altman's market-equity X4 against liabilities of unknown currency", () => {
    // A manufacturer (SIC 3571) is scored on the original, market-equity Z,
    // whose X4 is the market cap over total liabilities.
    const usdMaker = run({ sic: "3571" });
    const unknownMaker = run({ sic: "3571", ...UNKNOWN_MODEL });
    expect(usdMaker.forensics.altman?.variant).toBe("original");
    // 10,000M market cap / 1,500M total liabilities.
    expect(usdMaker.forensics.altman?.components.x4).toBeCloseTo(10_000 / 1_500, 9);
    expect(usdMaker.gaps.some((g) => g.field === "forensics.altman.currency")).toBe(false);
    expect(unknownMaker.forensics.altman?.components.x4 ?? null).toBeNull();
    expect(unknownMaker.gaps.some((g) => g.field === "forensics.altman.currency")).toBe(true);
  });
});

describe("REIT price multiples", () => {
  it("withholds P/FFO and the implied cap rate when the currencies are not comparable, and keeps FFO", () => {
    const usd = run({ reit: true });
    const unknown = run({ reit: true, ...UNKNOWN_MODEL });
    if (usd.valuation.kind !== "reit" || unknown.valuation.kind !== "reit") {
      throw new Error("expected the REIT route");
    }
    expect(usd.valuation.reit.pToFfo).not.toBeNull();
    expect(unknown.valuation.reit.pToFfo).toBeNull();
    expect(unknown.valuation.reit.impliedCapRatePct).toBeNull();
    expect(unknown.valuation.reit.ffoPerShare).toBe(usd.valuation.reit.ffoPerShare);
  });
});
