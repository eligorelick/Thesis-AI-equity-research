/**
 * An analyst estimate's (or price target's) currency comes only from its OWN
 * evidence — a currency on the row — or a documented provider convention
 * (FMP documents none). A listing currency that happens to match the
 * statements' is not evidence. The one rule governs:
 *
 *  - the financial calculations: the DCF's analyst-consensus growth case sets
 *    FY1 estimated revenue against statement revenue, so it is used only
 *    when the estimates are established in the model currency;
 *  - the AI input and its numeric evidence registry (and so verification):
 *    an estimate is registered only in its own established currency.
 *
 * Fixture: tests/helpers/currencyBundle.ts completeCurrencyBundle — USD
 * statements, debt-free, estimates FY2026 revenue 1,300 and FY2027 1,450.
 */
import { describe, expect, it } from "vitest";

import { runStageB, type ComputedMetrics } from "@/pipeline/compute";
import type { ValidationReport } from "@/pipeline/stageA/validate";
import { assembleContextPayload } from "@/pipeline/stageC/payload";
import { collectTracedNumbers, runVerifyPass, type PassDeps } from "@/pipeline/stageC/passes";
import type { JudgeOutput } from "@/report/schema";

import { M, completeCurrencyBundle, type CurrencyBundleOptions } from "./helpers/currencyBundle";

const VALIDATION = { checks: [], flags: [], gaps: [] } as unknown as ValidationReport;

function run(opts: CurrencyBundleOptions): ComputedMetrics {
  return runStageB(completeCurrencyBundle(opts));
}

/** Every currency-dependent growth and valuation output an estimate could move. */
function valuationOutputs(c: ComputedMetrics) {
  if (c.valuation.kind !== "dcf") throw new Error(`expected the DCF route, got ${c.valuation.kind}`);
  return {
    growthAnchor: c.valuation.assumptions?.growthAnchor,
    growthPath: c.valuation.assumptions?.growthPath,
    dcfPerShare: c.valuation.dcf?.perShare,
    sensitivity: c.valuation.sensitivity?.perShare,
    fairValue: c.fairValue.perShare?.value,
    projections: c.projections.series.map((s) => [s.metric, s.base.map((p) => p.value.value)]),
  };
}

function analystCase(c: ComputedMetrics): string {
  return c.valuation.kind === "dcf" ? JSON.stringify(c.valuation.assumptions?.growthAnchor) : "";
}

describe("an estimate without its own currency changes no calculation", () => {
  for (const [label, listing] of [
    ["known USD statements, unknown listing currency", null],
    ["USD listing matching USD statements", "USD"],
  ] as const) {
    it(`${label}: adding an unlabelled estimate leaves growth and valuation identical`, () => {
      const without = run({ profileCurrency: listing, estimates: false });
      const withUnlabelled = run({ profileCurrency: listing });
      expect(without.valuation.kind).toBe("dcf");
      expect(valuationOutputs(withUnlabelled)).toEqual(valuationOutputs(without));
      expect(analystCase(withUnlabelled)).toMatch(/analyst-consensus case[^}]*unavailable/);
      expect(withUnlabelled.gaps.find((g) => g.field === "valuation.analystEstimates.currency")?.reason).toMatch(
        /no currency of their own/,
      );
    });
  }

  it("an estimate in another currency than the model's is not used either", () => {
    const without = run({ estimates: false });
    const eur = run({ estimateCurrency: "EUR" });
    expect(valuationOutputs(eur)).toEqual(valuationOutputs(without));
    expect(eur.gaps.find((g) => g.field === "valuation.analystEstimates.currency")?.reason).toMatch(/EUR[^|]*USD/);
  });
});

describe("positive control: estimates whose own rows say USD", () => {
  it("enter the growth anchor as the analyst-consensus case", () => {
    const without = run({ estimates: false });
    const usd = run({ estimateCurrency: "USD" });
    // FY1 1,300 against TTM revenue 1,200 over 275 days (annualized) and
    // FY2 1,450 / FY1 1,300 − 1 = 11.54%: available, so the anchor moves.
    expect(analystCase(usd)).toMatch(/analyst-consensus case/);
    expect(analystCase(usd)).not.toMatch(/analyst-consensus case[^}]*unavailable/);
    expect(valuationOutputs(usd).dcfPerShare).not.toBe(valuationOutputs(without).dcfPerShare);
    expect(usd.gaps.some((g) => g.field === "valuation.analystEstimates.currency")).toBe(false);
  });
});

describe("AI input, registry and verification follow the same rule", () => {
  function assembled(opts: CurrencyBundleOptions) {
    const bundle = completeCurrencyBundle(opts);
    return assembleContextPayload(bundle, runStageB(bundle), VALIDATION);
  }
  function estimateFigure(payload: ReturnType<typeof assembled>, label: string) {
    const f = payload.estimates.figures.find((x) => x.label === label);
    if (f === undefined) throw new Error(`no ${label}`);
    return f;
  }

  it("matching USD listing and statements do not register an unlabelled estimate as USD", async () => {
    const payload = assembled({ profileCurrency: "USD" });
    const est = estimateFigure(payload, "est revenue 2026-12-31");
    expect(est.value).toBe(1300 * M);
    expect(est.currency).toBeNull();
    expect(est.provenanceId).toBeUndefined();
    expect(estimateFigure(payload, "price target consensus").provenanceId).toBeUndefined();
    const [cited] = collectTracedNumbers(
      (
        await runVerifyPass({} as PassDeps, payload, {
          numbers: [{ value: 1300 * M, unit: "currency", currency: "USD", source: "payload.estimates.est-revenue-2026-12-31", asOf: "2026-07-01", verified: null }],
        } as unknown as JudgeOutput)
      ).verifiedReport,
    );
    expect(cited?.verified).toBe(false);
  });

  it("registers and verifies estimates and targets in the currency their own rows state", async () => {
    const payload = assembled({ profileCurrency: "USD", estimateCurrency: "USD", priceTargetCurrency: "USD" });
    const est = estimateFigure(payload, "est revenue 2026-12-31");
    expect(est.currency).toBe("USD");
    const record = payload.provenanceRegistry!.find((r) => r.id === est.provenanceId);
    expect(record).toMatchObject({ value: 1300 * M, currency: "USD" });
    expect(payload.provenanceRegistry!.find((r) => r.id === estimateFigure(payload, "price target consensus").provenanceId))
      .toMatchObject({ value: 120, currency: "USD" });
    const [cited] = collectTracedNumbers(
      (
        await runVerifyPass({} as PassDeps, payload, {
          numbers: [{ value: 1300 * M, unit: "currency", source: est.provenanceId, asOf: record!.asOf, verified: null }],
        } as unknown as JudgeOutput)
      ).verifiedReport,
    );
    expect(cited).toMatchObject({ verified: true, currency: "USD" });
  });
});
