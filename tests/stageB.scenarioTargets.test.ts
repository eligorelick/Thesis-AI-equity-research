/**
 * Stage B — deterministic scenario price targets (scenarioTargets.ts).
 *
 * The invariant this checkpoint establishes: bull/base/bear headline price
 * targets are COMPUTED (base = the deterministic DCF fair value; bull/bear = the
 * same DCF re-run with growth + operating-margin paths shifted ±1·σ of the
 * company's OWN historical dispersion — the identical construction used by the
 * projection fan), NOT authored by the judge/LLM. Missing inputs SUPPRESS the
 * targets rather than fabricating them. Every target is `computed-derived`
 * provenance, not a factual-verification claim.
 */

import { describe, expect, it } from "vitest";

import {
  computeScenarioTargets,
  SCENARIO_TARGET_METHOD_VERSION,
  type ScenarioTargetsInputs,
} from "@/pipeline/stageB/scenarioTargets";
import {
  scenarioDispersion,
  DISPERSION_K,
  type ProjectionIncomeRow,
} from "@/pipeline/stageB/projections";
import {
  buildDcfAssumptions,
  runDcf,
  type DcfAssumptions,
  type DcfResult,
  type ValuationResult,
} from "@/pipeline/stageB/valuation";
import type { CompanyRouteResult } from "@/pipeline/stageB/sectorRouting";
import type { SectorRoute } from "@/types/core";

/* ------------------------------------------------------------------------ *
 * Fixtures — a REAL DCF built from the production valuation functions.
 * ------------------------------------------------------------------------ */

function route(base: SectorRoute = "general"): CompanyRouteResult {
  return {
    base,
    overlays: [],
    evidence: { sector: null, industry: null },
    notes: [],
    gaps: [],
    asOf: { today: "2026-07-06", incomeTtm: null, incomeAnnual: null, cashflowTtm: null, cashflowAnnual: null },
  };
}

const INCOME_HISTORY: ProjectionIncomeRow[] = [
  { date: "2021-12-31", revenue: 700, ebit: 196, netIncome: 140, epsDiluted: 1.3 },
  { date: "2022-12-31", revenue: 780, ebit: 226, netIncome: 160, epsDiluted: 1.5 },
  { date: "2023-12-31", revenue: 850, ebit: 251, netIncome: 178, epsDiluted: 1.7 },
  { date: "2024-12-31", revenue: 920, ebit: 276, netIncome: 196, epsDiluted: 1.9 },
  { date: "2025-12-31", revenue: 1000, ebit: 300, netIncome: 214, epsDiluted: 2.1 },
];

function buildDcf(): { assumptions: DcfAssumptions; dcf: DcfResult } {
  const built = buildDcfAssumptions({
    revenueCagr3yPct: 12,
    revenueCagr5yPct: 12,
    analystEstimates: null,
    waccPct: 9,
    riskFreePct: 4,
    incomeTtm: { date: "2025-12-31", revenue: 1000, operatingIncome: 300, incomeBeforeTax: 280, incomeTaxExpense: 60 },
    incomeHistory: INCOME_HISTORY.map((r) => ({ date: r.date, revenue: r.revenue, operatingIncome: r.ebit, incomeBeforeTax: (r.ebit ?? 0) - 20, incomeTaxExpense: ((r.ebit ?? 0) - 20) * 0.21 })),
    balance: { date: "2025-12-31", totalDebt: 200, totalStockholdersEquity: 800, cashAndShortTermInvestments: 300 },
    marketCap: 5000,
  });
  expect(built.assumptions).not.toBeNull();
  const assumptions = built.assumptions as DcfAssumptions;
  const dcf = runDcf(assumptions, { waccPct: 9, netDebt: -100, dilutedShares: 100 });
  return { assumptions, dcf };
}

function dcfValuation(over: Partial<Extract<ValuationResult, { kind: "dcf" }>> = {}): ValuationResult {
  const { assumptions, dcf } = buildDcf();
  return {
    kind: "dcf",
    route: "general",
    assumptions,
    dcf,
    sensitivity: null,
    reverseDcf: null,
    multiples: { multiples: [], sectorAppropriate: [], asOf: { quote: null, statements: null }, notes: [], gaps: [] },
    notes: [],
    gaps: [],
    ...over,
  };
}

function makeInputs(over: Partial<ScenarioTargetsInputs> = {}): ScenarioTargetsInputs {
  return {
    route: route(),
    valuation: dcfValuation(),
    waccPct: 9,
    netDebt: -100,
    dilutedShares: 100,
    minorityInterest: null,
    preferred: null,
    incomeHistory: INCOME_HISTORY,
    currentPrice: 120,
    currency: "USD",
    asOf: "2026-07-06",
    ...over,
  };
}

const targetFor = (r: ReturnType<typeof computeScenarioTargets>, name: "bull" | "base" | "bear") =>
  r.targets.find((t) => t.name === name)!;

/* ------------------------------------------------------------------------ */

describe("scenarioTargets — available (general DCF route)", () => {
  it("produces three computed targets with base = the deterministic DCF fair value", () => {
    const inputs = makeInputs();
    const r = computeScenarioTargets(inputs);
    expect(r.status).toBe("available");
    expect(r.method).toBe("dcf-dispersion");
    expect(r.methodVersion).toBe(SCENARIO_TARGET_METHOD_VERSION);
    expect(r.targets.map((t) => t.name).sort()).toEqual(["base", "bear", "bull"]);

    const dcfPerShare = (inputs.valuation as Extract<ValuationResult, { kind: "dcf" }>).dcf!.perShare!;
    const base = targetFor(r, "base");
    expect(base.perShare).not.toBeNull();
    // Base target IS the deterministic DCF per-share (not recomputed, not LLM).
    expect(base.perShare!.value).toBeCloseTo(Math.round(dcfPerShare * 100) / 100, 6);
    expect(base.growthDeltaPp).toBe(0);
    expect(base.marginDeltaPp).toBe(0);
  });

  it("orders bull >= base >= bear in per-share value", () => {
    const r = computeScenarioTargets(makeInputs());
    const bull = targetFor(r, "bull").perShare!.value;
    const base = targetFor(r, "base").perShare!.value;
    const bear = targetFor(r, "bear").perShare!.value;
    expect(bull).toBeGreaterThanOrEqual(base);
    expect(base).toBeGreaterThanOrEqual(bear);
  });

  it("labels every target TracedNumber computed-derived (source computed.scenarioTargets.*), never factually verified-as-correct", () => {
    const r = computeScenarioTargets(makeInputs());
    for (const t of r.targets) {
      expect(t.perShare).not.toBeNull();
      expect(t.perShare!.source).toBe(`computed.scenarioTargets.${t.name}`);
      expect(t.perShare!.unit).toBe("USD/share");
      // verified:true here means "traced to computed inputs" (provenance), the
      // same convention projections uses — NOT a correctness assertion.
      expect(t.perShare!.verified).toBe(true);
    }
  });

  it("derives bull/bear deltas from the company's own dispersion — the SAME σ the projection fan uses", () => {
    const inputs = makeInputs();
    const disp = scenarioDispersion(inputs.incomeHistory);
    const r = computeScenarioTargets(inputs);
    expect(r.dispersion).not.toBeNull();
    expect(r.dispersion!.sigmaSource).toBe("own-history");
    // bull/bear growth delta === ±DISPERSION_K·σ_growth (identical construction).
    expect(targetFor(r, "bull").growthDeltaPp).toBeCloseTo(DISPERSION_K * disp.sigmaGrowth!, 6);
    expect(targetFor(r, "bear").growthDeltaPp).toBeCloseTo(-DISPERSION_K * disp.sigmaGrowth!, 6);
    expect(targetFor(r, "bull").marginDeltaPp).toBeCloseTo(
      DISPERSION_K * disp.sigmaMargin! * (disp.growthMarginCorrelation ?? 0),
      6,
    );
  });

  it("computes upside vs the current price for each target", () => {
    const r = computeScenarioTargets(makeInputs({ currentPrice: 100 }));
    const base = targetFor(r, "base");
    expect(base.upsidePct).not.toBeNull();
    expect(base.upsidePct!).toBeCloseTo((base.perShare!.value / 100 - 1) * 100, 4);
  });

  it("returns null upside (not 0) when the current price is missing", () => {
    const r = computeScenarioTargets(makeInputs({ currentPrice: null }));
    expect(targetFor(r, "base").upsidePct).toBeNull();
    expect(r.status).toBe("available"); // targets still computed; only upside unknown
  });

  it("suppresses targets when history is too thin instead of using a house default", () => {
    const r = computeScenarioTargets(makeInputs({ incomeHistory: [INCOME_HISTORY[0]] }));
    expect(r.status).toBe("suppressed");
    expect(r.dispersion).toBeNull();
    expect(r.targets).toEqual([]);
    expect(r.missingReasons.some((g) => g.field.includes("dispersion"))).toBe(true);
  });
});

describe("scenarioTargets — suppressed (never fabricate)", () => {
  it("suppresses on a non-DCF route (bank/insurer/REIT/pre-revenue)", () => {
    const r = computeScenarioTargets(
      makeInputs({
        valuation: { kind: "pre-revenue", route: "general", multiples: null, notes: [], gaps: [] },
      }),
    );
    expect(r.status).toBe("suppressed");
    expect(r.targets).toEqual([]);
    expect(r.missingReasons.length).toBeGreaterThan(0);
  });

  it("suppresses when WACC is unavailable", () => {
    const r = computeScenarioTargets(makeInputs({ waccPct: null }));
    expect(r.status).toBe("suppressed");
    expect(r.targets).toEqual([]);
    expect(r.missingReasons.some((g) => g.reason.toLowerCase().includes("wacc"))).toBe(true);
  });

  it("suppresses when the base DCF per-share is unavailable (e.g. net debt / shares missing)", () => {
    const noBridge = dcfValuation({ dcf: { ...buildDcf().dcf, perShare: null, equityValue: null } });
    const r = computeScenarioTargets(makeInputs({ valuation: noBridge, netDebt: null }));
    expect(r.status).toBe("suppressed");
    expect(r.targets).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ *
 * Regression: ordering / floor / degeneracy invariants (2026-07-20 audit).
 * ------------------------------------------------------------------------ */

// A DCF whose base per-share is the SAME netDebt as the scenario re-runs, so the
// base target is consistent with the perturbed extremes (production always passes
// one net-debt figure to both). Used to force a heavily-levered bear bridge.
function buildDcfWithNetDebt(netDebt: number): { assumptions: DcfAssumptions; dcf: DcfResult } {
  const built = buildDcfAssumptions({
    revenueCagr3yPct: 12,
    revenueCagr5yPct: 12,
    analystEstimates: null,
    waccPct: 9,
    riskFreePct: 4,
    incomeTtm: { date: "2025-12-31", revenue: 1000, operatingIncome: 300, incomeBeforeTax: 280, incomeTaxExpense: 60 },
    incomeHistory: INCOME_HISTORY.map((r) => ({ date: r.date, revenue: r.revenue, operatingIncome: r.ebit, incomeBeforeTax: (r.ebit ?? 0) - 20, incomeTaxExpense: ((r.ebit ?? 0) - 20) * 0.21 })),
    balance: { date: "2025-12-31", totalDebt: 200, totalStockholdersEquity: 800, cashAndShortTermInvestments: 300 },
    marketCap: 5000,
  });
  const assumptions = built.assumptions as DcfAssumptions;
  const dcf = runDcf(assumptions, { waccPct: 9, netDebt, dilutedShares: 100 });
  return { assumptions, dcf };
}

// Anti-correlated history: high-growth years carry LOW margins and vice-versa, so
// the growth/margin correlation is strongly negative and the margin shock (σ≈6.3pp)
// dominates the growth shock (σ≈2.3pp). Under the RAW ±σ construction the +growth
// run (lower margin) lands BELOW the −growth run (higher margin), i.e. bull < bear.
const ANTI_CORRELATED_HISTORY: ProjectionIncomeRow[] = [
  { date: "2021-12-31", revenue: 1000, ebit: 400, netIncome: 200, epsDiluted: 2.0 }, // margin 40%
  { date: "2022-12-31", revenue: 1120, ebit: 268.8, netIncome: 130, epsDiluted: 1.3 }, // g 12%,  margin 24%
  { date: "2023-12-31", revenue: 1210, ebit: 387.2, netIncome: 190, epsDiluted: 1.9 }, // g 8.0%, margin 32%
  { date: "2024-12-31", revenue: 1330, ebit: 372.4, netIncome: 180, epsDiluted: 1.8 }, // g 9.9%, margin 28%
  { date: "2025-12-31", revenue: 1420, ebit: 511.2, netIncome: 250, epsDiluted: 2.5 }, // g 6.8%, margin 36%
];

// Perfectly geometric revenue (constant 10%/yr) and constant 30% margin — margin
// sample σ is ~0, so the growth/margin correlation is mathematically undefined
// (scenarioDispersion.correlation() returns a spurious number on the float-noise-
// flat series).
const FLAT_MARGIN_HISTORY: ProjectionIncomeRow[] = [
  { date: "2021-12-31", revenue: 1000, ebit: 300, netIncome: 200, epsDiluted: 2.0 },
  { date: "2022-12-31", revenue: 1100, ebit: 330, netIncome: 220, epsDiluted: 2.2 },
  { date: "2023-12-31", revenue: 1210, ebit: 363, netIncome: 242, epsDiluted: 2.4 },
  { date: "2024-12-31", revenue: 1331, ebit: 399.3, netIncome: 266, epsDiluted: 2.66 },
  { date: "2025-12-31", revenue: 1464.1, ebit: 439.23, netIncome: 293, epsDiluted: 2.93 },
];

describe("scenarioTargets — ordering / floor / degeneracy invariants", () => {
  it("re-labels bull/bear by value so a negative growth/margin correlation never publishes bull < bear", () => {
    const inputs = makeInputs({ incomeHistory: ANTI_CORRELATED_HISTORY });
    const disp = scenarioDispersion(ANTI_CORRELATED_HISTORY);
    // Precondition: correlation is strongly negative (the trigger for inversion).
    expect(disp.growthMarginCorrelation).not.toBeNull();
    expect(disp.growthMarginCorrelation!).toBeLessThan(-0.9);

    const r = computeScenarioTargets(inputs);
    const bull = targetFor(r, "bull").perShare!.value;
    const base = targetFor(r, "base").perShare!.value;
    const bear = targetFor(r, "bear").perShare!.value;
    // Enforced invariant (pre-fix this fixture produced bull ≈ 38.95 < bear ≈ 47.56).
    expect(bull).toBeGreaterThanOrEqual(base);
    expect(base).toBeGreaterThanOrEqual(bear);
    expect(bull).toBeGreaterThan(bear); // a real, non-degenerate spread

    // The re-label swaps the deltas: the HIGHER-value scenario (bull) is the one
    // with LOWER growth + HIGHER margin (the −growth run), because margins here are
    // countercyclical. Deltas describe the path that produced each value.
    expect(targetFor(r, "bull").growthDeltaPp).toBeCloseTo(-DISPERSION_K * disp.sigmaGrowth!, 6);
    expect(targetFor(r, "bull").marginDeltaPp).toBeGreaterThan(0);
    expect(targetFor(r, "bear").growthDeltaPp).toBeCloseTo(DISPERSION_K * disp.sigmaGrowth!, 6);
    expect(targetFor(r, "bear").marginDeltaPp).toBeLessThan(0);

    // The inversion is disclosed, not silent.
    expect(r.missingReasons.some((g) => g.field === "valuation.scenarioTargets.ordering")).toBe(true);
  });

  it("floors a negative bear per-share at 0 and caps upside at −100%, disclosed", () => {
    // netDebt 4200 sits between the −σ (bear) enterprise value and the base EV, so
    // the raw bear equity bridge is negative (≈ −$0.99/sh pre-fix).
    const { assumptions, dcf } = buildDcfWithNetDebt(4200);
    const valuation: ValuationResult = {
      kind: "dcf", route: "general", assumptions, dcf, sensitivity: null, reverseDcf: null,
      multiples: { multiples: [], sectorAppropriate: [], asOf: { quote: null, statements: null }, notes: [], gaps: [] },
      notes: [], gaps: [],
    };
    const r = computeScenarioTargets(makeInputs({ valuation, netDebt: 4200 }));
    expect(r.status).toBe("available");

    const bear = targetFor(r, "bear");
    // Hand-derived: raw bear equity/share < 0 → floored to exactly 0; upside =
    // (0 / 120 − 1)·100 = −100 exactly (never below).
    expect(bear.perShare!.value).toBe(0);
    expect(bear.upsidePct).toBe(-100);

    const bull = targetFor(r, "bull").perShare!.value;
    const base = targetFor(r, "base").perShare!.value;
    expect(bull).toBeGreaterThanOrEqual(base);
    expect(base).toBeGreaterThanOrEqual(0); // base still the positive DCF fair value (≈ 1.4)
    expect(r.missingReasons.some((g) => g.field === "valuation.scenarioTargets.floor")).toBe(true);
  });

  it("suppresses the whole fan when the base DCF per-share is non-positive (no base-below-bear inversion)", () => {
    // netDebt 4600 pushes enterprise value below net debt, so the BASE DCF
    // per-share is itself negative (≈ −$2.60). Flooring only bull/bear at 0 while
    // leaving base raw would publish base BELOW bear (0) — the risk direction
    // backwards. The fan is suppressed instead; the DCF page still shows the
    // negative fair value.
    const { assumptions, dcf } = buildDcfWithNetDebt(4600);
    expect(dcf.perShare!).toBeLessThan(0); // precondition: base equity value < 0
    const valuation: ValuationResult = {
      kind: "dcf", route: "general", assumptions, dcf, sensitivity: null, reverseDcf: null,
      multiples: { multiples: [], sectorAppropriate: [], asOf: { quote: null, statements: null }, notes: [], gaps: [] },
      notes: [], gaps: [],
    };
    const r = computeScenarioTargets(makeInputs({ valuation, netDebt: 4600 }));
    expect(r.status).toBe("suppressed");
    expect(r.targets).toEqual([]);
    expect(
      r.missingReasons.some((g) => g.reason.toLowerCase().includes("non-positive")),
    ).toBe(true);
  });

  it("reports a degenerate correlation as unavailable (null), not a spurious measured value", () => {
    const disp = scenarioDispersion(FLAT_MARGIN_HISTORY);
    // scenarioDispersion itself emits a spurious non-null correlation on the flat
    // margin series (float-noise variance passes its varianceY>0 guard)...
    expect(disp.growthMarginCorrelation).not.toBeNull();
    expect(round2(disp.sigmaMargin ?? 1)).toBe(0); // margin σ rounds to 0.00pp

    const r = computeScenarioTargets(makeInputs({ incomeHistory: FLAT_MARGIN_HISTORY }));
    // ...but the scenario block reports it as unavailable and holds the margin
    // shock at zero, disclosing the degeneracy.
    expect(r.dispersion!.growthMarginCorrelation).toBeNull();
    expect(targetFor(r, "bull").marginDeltaPp).toBeCloseTo(0, 10);
    expect(r.missingReasons.some((g) => g.field === "valuation.scenarioTargets.dispersion.degenerate")).toBe(true);
  });
});

const round2 = (v: number): number => Math.round(v * 100) / 100;
