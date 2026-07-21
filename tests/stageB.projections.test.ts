/**
 * Stage B — weighted forward projections (projections.ts).
 *
 * The key invariant: the BASE projection path IS the DCF's own forward path
 * (so the projection page can never contradict the valuation page). Also covers
 * scenario ordering (bull ≥ base ≥ bear), the probability-weighted blend, EPS
 * derivation + graceful skip, TracedNumber provenance, and route/degradation
 * not-applicable paths.
 */

import { describe, expect, it } from "vitest";

import {
  computeProjections,
  PROJECTION_WEIGHTS,
  PROJECTION_HORIZON_YEARS,
  PROJECTION_WEIGHTS_VERSION,
  scenarioDispersion,
  type ProjectionsInputs,
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

const INCOME_HISTORY = [
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
    incomeHistory: INCOME_HISTORY.map((r) => ({ date: r.date, revenue: r.revenue, operatingIncome: r.ebit, incomeBeforeTax: r.ebit - 20, incomeTaxExpense: (r.ebit - 20) * 0.21 })),
    balance: { date: "2025-12-31", totalDebt: 200, totalStockholdersEquity: 800, cashAndShortTermInvestments: 300 },
    marketCap: 5000,
  });
  expect(built.assumptions).not.toBeNull();
  const assumptions = built.assumptions as DcfAssumptions;
  const dcf = runDcf(assumptions, { waccPct: 9, netDebt: -100, dilutedShares: 100 });
  return { assumptions, dcf };
}

function dcfValuation(): ValuationResult {
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
  };
}

function makeInputs(over: Partial<ProjectionsInputs> = {}): ProjectionsInputs {
  return {
    route: route(),
    valuation: dcfValuation(),
    waccPct: 9,
    netDebt: -100,
    dilutedShares: 100,
    incomeHistory: INCOME_HISTORY,
    fcfHistory: [
      { date: "2023-12-31", fcf: 150 },
      { date: "2024-12-31", fcf: 170 },
      { date: "2025-12-31", fcf: 190 },
    ],
    shareCountAnnualizedPct: -2,
    currency: "USD",
    asOf: "2026-07-06",
    ...over,
  };
}

const byMetric = (p: ReturnType<typeof computeProjections>, m: string) => p.series.find((s) => s.metric === m)!;

/* ------------------------------------------------------------------------ */

describe("projections — structure", () => {
  it("produces revenue, operatingMargin, fcf, epsDiluted series over the horizon", () => {
    const p = computeProjections(makeInputs());
    expect(p.notApplicableReason).toBeNull();
    expect(p.horizonYears).toBe(PROJECTION_HORIZON_YEARS);
    expect(p.weightsVersion).toBe(PROJECTION_WEIGHTS_VERSION);
    expect(p.series.map((s) => s.metric).sort()).toEqual(["epsDiluted", "fcf", "operatingMargin", "revenue"]);
    for (const s of p.series) {
      expect(s.base.length).toBe(PROJECTION_HORIZON_YEARS);
      expect(s.bull.length).toBe(PROJECTION_HORIZON_YEARS);
      expect(s.bear.length).toBe(PROJECTION_HORIZON_YEARS);
      expect(s.weighted.length).toBe(PROJECTION_HORIZON_YEARS);
    }
  });

  it("forward numbers are TracedNumbers sourced under computed.projections.*", () => {
    const rev = byMetric(computeProjections(makeInputs()), "revenue");
    const pt = rev.weighted[0];
    expect(pt.value.source).toBe("computed.projections.revenue.weighted");
    expect(pt.value.verified).toBe(true);
    expect(pt.value.unit).toBe("USD");
    expect(pt.period).toMatch(/^FY\d{4}$/);
  });
});

describe("projections — DCF consistency (the load-bearing invariant)", () => {
  it("the base path equals the DCF's own forward path", () => {
    const { dcf } = buildDcf();
    const p = computeProjections(makeInputs());
    const rev = byMetric(p, "revenue");
    for (let i = 0; i < PROJECTION_HORIZON_YEARS; i++) {
      expect(rev.base[i].value.value).toBeCloseTo(Math.round(dcf.yearRows[i].revenue * 100) / 100, 2);
    }
    const margin = byMetric(p, "operatingMargin");
    for (let i = 0; i < PROJECTION_HORIZON_YEARS; i++) {
      expect(margin.base[i].value.value).toBeCloseTo(Math.round(dcf.yearRows[i].ebitMarginPct * 100) / 100, 2);
    }
  });
});

describe("projections — scenarios", () => {
  it("rejects nonconsecutive fiscal gaps from historical dispersion", () => {
    const consecutive = scenarioDispersion([
      { date: "2019-12-31", revenue: 100, ebit: 20, netIncome: null, epsDiluted: null },
      { date: "2020-12-31", revenue: 130, ebit: 25, netIncome: null, epsDiluted: null },
      { date: "2021-12-31", revenue: 135, ebit: 29, netIncome: null, epsDiluted: null },
      { date: "2022-12-31", revenue: 180, ebit: 36, netIncome: null, epsDiluted: null },
    ]);
    const gapped = scenarioDispersion([
      { date: "2019-12-31", revenue: 100, ebit: 20, netIncome: null, epsDiluted: null },
      { date: "2020-12-31", revenue: 130, ebit: 25, netIncome: null, epsDiluted: null },
      { date: "2024-12-31", revenue: 135, ebit: 29, netIncome: null, epsDiluted: null },
      { date: "2025-12-31", revenue: 180, ebit: 36, netIncome: null, epsDiluted: null },
    ]);
    expect(consecutive.growthDefaulted).toBe(false);
    expect(gapped.growthDefaulted).toBe(true);
    expect(gapped.marginDefaulted).toBe(true);
    expect(gapped.irregularHistory).toBe(true);
  });

  it("bull >= base >= bear for revenue and the weighted path is the documented blend", () => {
    const rev = byMetric(computeProjections(makeInputs()), "revenue");
    for (let i = 0; i < PROJECTION_HORIZON_YEARS; i++) {
      expect(rev.bull[i].value.value).toBeGreaterThanOrEqual(rev.base[i].value.value);
      expect(rev.base[i].value.value).toBeGreaterThanOrEqual(rev.bear[i].value.value);
      const blend =
        PROJECTION_WEIGHTS.bull * rev.bull[i].value.value +
        PROJECTION_WEIGHTS.base * rev.base[i].value.value +
        PROJECTION_WEIGHTS.bear * rev.bear[i].value.value;
      expect(rev.weighted[i].value.value).toBeCloseTo(Math.round(blend * 100) / 100, 1);
    }
  });

  it("thin revenue history suppresses the scenario fan instead of using a default", () => {
    const p = computeProjections(makeInputs({ incomeHistory: [{ date: "2025-12-31", revenue: 1000, ebit: 300, netIncome: 214, epsDiluted: 2.1 }] }));
    expect(p.series).toEqual([]);
    expect(p.notApplicableReason).toMatch(/four consecutive|suppressed/i);
  });

  it("suppresses the fan when margin dispersion cannot be measured", () => {
    // Revenue present every year (measurable growth σ) but EBIT only on the latest row.
    const hist = INCOME_HISTORY.map((r, i) => ({ ...r, ebit: i === INCOME_HISTORY.length - 1 ? r.ebit : null }));
    const p = computeProjections(makeInputs({ incomeHistory: hist }));
    expect(p.series).toEqual([]);
    expect(p.notApplicableReason).toMatch(/margin dispersion|suppressed/i);
  });

  it("the weighted path lies within the scenario range for EVERY metric (incl. the FCF crossover)", () => {
    const p = computeProjections(makeInputs());
    for (const s of p.series) {
      for (let i = 0; i < p.horizonYears; i++) {
        const lo = Math.min(s.bull[i].value.value, s.bear[i].value.value);
        const hi = Math.max(s.bull[i].value.value, s.bear[i].value.value);
        expect(s.weighted[i].value.value).toBeGreaterThanOrEqual(lo - 1e-6);
        expect(s.weighted[i].value.value).toBeLessThanOrEqual(hi + 1e-6);
      }
    }
    // FCF can legitimately invert near-term (bull reinvests more) — it's disclosed in the assumptions.
    const fcf = byMetric(p, "fcf");
    expect(fcf.assumptions.some((a) => /can cross/i.test(a))).toBe(true);
  });

  it("forward labels track the DCF's TTM base period (mid-year filer not mislabelled early)", () => {
    // Base fixture: TTM date 2025-12-31 → forward starts FY2026 regardless of annual tail.
    const rev = byMetric(computeProjections(makeInputs()), "revenue");
    expect(rev.base[0].period).toBe("FY2026");
  });
});

describe("projections — EPS derivation", () => {
  it("derives EPS from the forward operating path over trended shares", () => {
    const eps = byMetric(computeProjections(makeInputs()), "epsDiluted");
    expect(eps.unit).toBe("USD/share");
    expect(eps.base.every((pt) => pt.value.value > 0)).toBe(true);
    // Buybacks (-2%/yr) lift EPS growth above net-income growth over time.
    expect(eps.base[4].value.value).toBeGreaterThan(eps.base[0].value.value);
  });

  it("skips EPS (no crash) when diluted shares are missing", () => {
    const p = computeProjections(makeInputs({ dilutedShares: null }));
    expect(p.series.some((s) => s.metric === "epsDiluted")).toBe(false);
    // The other three series still project.
    expect(p.series.length).toBe(3);
  });
});

describe("projections — not applicable", () => {
  it("returns a reason for a non-DCF (financial) route", () => {
    const val: ValuationResult = { kind: "excess-return", route: "bank", excessReturn: {} as never, multiples: {} as never, notes: [], gaps: [] };
    const p = computeProjections(makeInputs({ route: route("bank"), valuation: val }));
    expect(p.series).toHaveLength(0);
    expect(p.notApplicableReason).toMatch(/general route/i);
  });

  it("returns a reason when the DCF could not be built", () => {
    const val = dcfValuation();
    (val as { assumptions: DcfAssumptions | null }).assumptions = null;
    (val as { dcf: DcfResult | null }).dcf = null;
    const p = computeProjections(makeInputs({ valuation: val }));
    expect(p.notApplicableReason).toMatch(/unavailable/i);
  });
});
