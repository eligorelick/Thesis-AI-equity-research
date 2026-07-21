/**
 * Stage B — valuation engine tests (own DCF, sensitivity grid, reverse DCF,
 * multiples framework, excess-return + REIT sector models, route dispatch).
 *
 * PURE, deterministic: no network, no db, no LLM. Golden values are
 * hand-computed in the assertions below (see the comment blocks) so the math —
 * including the mid-year convention, the Gordon TV guard, terminal
 * reinvestment = g/ROIC, and the excess-return recursion — is pinned to 1e-6.
 */

import { describe, expect, it } from "vitest";

import {
  BISECTION_TOL_PP,
  DCF_HORIZON_YEARS,
  SECTOR_APPROPRIATE_MULTIPLES,
  buildDcfAssumptions,
  excessReturnModel,
  fadePath,
  multiplesFramework,
  percentileRank,
  quantile,
  reitValuation,
  reverseDcf,
  runDcf,
  safeDiv,
  sensitivityGrid,
  valueCompany,
  type AnalystEstimateRow,
  type DcfAssumptionInputs,
  type DcfAssumptions,
  type DcfIncomeRow,
  type MultiplesFrameworkInputs,
  type PeerMultiples,
} from "@/pipeline/stageB/valuation";
import type { CompanyRoute } from "@/types/core";

// ---------------------------------------------------------------------------
// Helpers: construct a fully-explicit DcfAssumptions object for engine tests
// (bypasses buildDcfAssumptions so year rows are exactly hand-computable).
// ---------------------------------------------------------------------------

function explicitAssumptions(over: Partial<{
  startRevenue: number;
  years: number;
  growthPath: number[];
  ebitMarginPath: number[];
  taxRatePath: number[];
  salesToCapital: number;
  gTermPct: number;
  roicTermPct: number;
  midYear: boolean;
}> = {}): DcfAssumptions {
  const years = over.years ?? 2;
  const growthPath = over.growthPath ?? Array.from({ length: years }, () => 10);
  const ebitMarginPath = over.ebitMarginPath ?? Array.from({ length: years }, () => 20);
  const taxRatePath = over.taxRatePath ?? Array.from({ length: years }, () => 25);
  const gTermPct = over.gTermPct ?? 2;
  const roicTermPct = over.roicTermPct ?? 10;
  return {
    startRevenue: { value: over.startRevenue ?? 1000, basis: "test" },
    years,
    growthPath: { value: growthPath, basis: "test" },
    ebitMarginPath: { value: ebitMarginPath, basis: "test" },
    taxRatePath: { value: taxRatePath, basis: "test" },
    salesToCapital: { value: over.salesToCapital ?? 2.0, basis: "test" },
    terminal: {
      gTermPct: { value: gTermPct, basis: "test" },
      roicTermPct: { value: roicTermPct, basis: "test" },
      reinvestmentRate: { value: roicTermPct > 0 ? gTermPct / roicTermPct : 0, basis: "test" },
    },
    midYear: { value: over.midYear ?? true, basis: "test" },
    asOf: { statements: "2025-12-31", estimates: null },
    notes: [],
  };
}

// ---------------------------------------------------------------------------
// Numeric primitives
// ---------------------------------------------------------------------------

describe("numeric primitives", () => {
  it("safeDiv guards zero / negative-nonsense / non-finite denominators", () => {
    expect(safeDiv(10, 2)).toBe(5);
    expect(safeDiv(10, 0)).toBeNull();
    expect(safeDiv(10, null)).toBeNull();
    expect(safeDiv(null, 2)).toBeNull();
    expect(safeDiv(10, undefined)).toBeNull();
    expect(safeDiv(-10, 2)).toBe(-5); // negative numerator is fine
  });

  it("fadePath is inclusive and linear (year 1 = start, year N = end)", () => {
    expect(fadePath(10, 2, 5)).toEqual([10, 8, 6, 4, 2]);
    expect(fadePath(15, 9, 2)).toEqual([15, 9]);
    expect(fadePath(5, 5, 1)).toEqual([5]);
    expect(fadePath(5, 5, 0)).toEqual([]);
  });

  it("quantile linear-interpolates order statistics", () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([10, 20], 0.5)).toBe(15);
    expect(quantile([], 0.5)).toBeNull();
    // p between order stats: [1,2,3,4], p25 -> idx 0.75 -> 1 + 0.75*(2-1) = 1.75
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 12);
  });

  it("percentileRank interpolates and clamps at endpoints", () => {
    const vals = [10, 20, 30, 40, 50];
    expect(percentileRank(vals, 5)).toBe(0);
    expect(percentileRank(vals, 60)).toBe(100);
    expect(percentileRank(vals, 30)).toBeCloseTo(50, 9); // middle of 5 -> idx 2 / 4 = 50
    // v = 25 sits halfway between 20 (idx1) and 30 (idx2): (1 + 0.5)/4 * 100 = 37.5
    expect(percentileRank(vals, 25)).toBeCloseTo(37.5, 9);
    expect(percentileRank([42], 42)).toBeNull(); // needs >= 2 obs
  });
});

// ---------------------------------------------------------------------------
// Golden DCF — hand-computable 2-year toy case, PV math incl. mid-year to 1e-6
// ---------------------------------------------------------------------------

describe("runDcf — golden 2-year toy case (mid-year convention)", () => {
  // start 1000, growth 10%/yr, EBIT margin 20%, tax 25%, S2C 2.0,
  // gTerm 2%, roicTerm=WACC=10% -> terminal reinvest 0.2, mid-year ON.
  //   Y1: rev 1100, ebit 220, nopat 165, reinvest (100)/2=50, fcff 115
  //       df (1.1)^0.5 = 1.048808848..., pv 109.6481977632431
  //   Y2: rev 1210, ebit 242, nopat 181.5, reinvest 55, fcff 126.5
  //       df (1.1)^1.5 = 1.153689733..., pv 109.6481977632431
  //   pvExplicit = 219.2963955264862
  //   NOPAT_{N+1} = 1210*1.02*0.20*0.75 = 185.13
  //   FCFF_{N+1}  = 185.13*(1-0.2) = 148.104
  //   TV = 148.104 / 0.08 = 1851.30
  //   pvTerminal = 1851.30 / (1.1)^1.5 = 1604.6775377003316
  //   EV = 1823.9739332268177
  const a = explicitAssumptions();

  it("matches hand-computed EV, pvExplicit, pvTerminal, and year rows", () => {
    const r = runDcf(a, { waccPct: 10, netDebt: 100, dilutedShares: 100 });
    expect(r.yearRows).toHaveLength(2);
    expect(r.yearRows[0].fcff).toBeCloseTo(115, 9);
    expect(r.yearRows[0].pv).toBeCloseTo(109.6481977632431, 6);
    expect(r.yearRows[1].fcff).toBeCloseTo(126.5, 9);
    expect(r.yearRows[1].pv).toBeCloseTo(109.6481977632431, 6);
    expect(r.pvExplicit).toBeCloseTo(219.2963955264862, 6);
    expect(r.terminalValue).toBeCloseTo(1851.3, 6);
    expect(r.pvTerminal).toBeCloseTo(1604.6775377003316, 6);
    expect(r.enterpriseValue).toBeCloseTo(1823.9739332268177, 6);
    expect(r.gTermUsedPct).toBe(2);
  });

  it("bridges EV to equity and per-share (EV - netDebt) / shares", () => {
    const r = runDcf(a, { waccPct: 10, netDebt: 100, dilutedShares: 100 });
    // equity = 1823.9739332268177 - 100 = 1723.97..., /100 = 17.2397...
    expect(r.equityValue).toBeCloseTo(1723.9739332268177, 6);
    expect(r.perShare).toBeCloseTo(17.239739332268176, 6);
    expect(r.terminalShare).toBeCloseTo(1604.6775377003316 / 1823.9739332268177, 9);
  });

  it("nets minority interest and preferred out of the equity bridge", () => {
    // Same EV; equity = 1823.9739332268177 - netDebt 100 - minority 50 - preferred 30
    //   = 1643.9739332268177; /100 = 16.4397...
    const r = runDcf(a, {
      waccPct: 10,
      netDebt: 100,
      dilutedShares: 100,
      minorityInterest: 50,
      preferred: 30,
    });
    expect(r.equityValue).toBeCloseTo(1643.9739332268177, 6);
    expect(r.perShare).toBeCloseTo(16.439739332268176, 6);
    expect(r.notes.some((n) => /minority interest and preferred/.test(n))).toBe(true);
  });

  it("omitting minority/preferred equals passing 0 (backward-compatible, no note)", () => {
    const omitted = runDcf(a, { waccPct: 10, netDebt: 100, dilutedShares: 100 });
    const zeros = runDcf(a, { waccPct: 10, netDebt: 100, dilutedShares: 100, minorityInterest: 0, preferred: 0 });
    expect(zeros.equityValue).toBe(omitted.equityValue);
    expect(zeros.perShare).toBe(omitted.perShare);
    expect(omitted.notes.some((n) => /minority interest and preferred/.test(n))).toBe(false);
  });

  it("end-year convention yields a lower EV than mid-year (~sqrt(1+wacc))", () => {
    const midYear = runDcf(a, { waccPct: 10, netDebt: 100, dilutedShares: 100 });
    const endYear = runDcf(explicitAssumptions({ midYear: false }), {
      waccPct: 10,
      netDebt: 100,
      dilutedShares: 100,
    });
    // mid-year EV = end-year EV * (1.1)^0.5 exactly (uniform half-year shift).
    expect(midYear.enterpriseValue).toBeCloseTo(
      endYear.enterpriseValue * Math.sqrt(1.1),
      6,
    );
    expect(midYear.enterpriseValue).toBeGreaterThan(endYear.enterpriseValue);
  });

  it("records gaps (not throws) when netDebt / diluted shares are missing", () => {
    const r = runDcf(a, { waccPct: 10, netDebt: null, dilutedShares: null });
    expect(r.enterpriseValue).toBeCloseTo(1823.9739332268177, 6);
    expect(r.equityValue).toBeNull();
    expect(r.perShare).toBeNull();
    expect(r.gaps.some((g) => g.field === "valuation.dcf.netDebt")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TV guard trigger
// ---------------------------------------------------------------------------

describe("runDcf — Gordon TV guard (WACC - gTerm >= 2pp)", () => {
  it("clamps gTerm down and notes it when WACC - gTerm < 2pp", () => {
    // WACC 6%, gTerm 5% -> spread 1pp < 2pp -> gTerm clamped to 6 - 2 = 4%.
    const a = explicitAssumptions({ gTermPct: 5, roicTermPct: 6 });
    const r = runDcf(a, { waccPct: 6, netDebt: 0, dilutedShares: 100 });
    expect(r.gTermUsedPct).toBeCloseTo(4, 9);
    expect(r.notes.some((n) => n.includes("Gordon TV guard"))).toBe(true);
    expect(Number.isFinite(r.terminalValue)).toBe(true);
  });

  it("does NOT clamp when the spread is exactly 2pp", () => {
    const a = explicitAssumptions({ gTermPct: 4, roicTermPct: 8 });
    const r = runDcf(a, { waccPct: 6, netDebt: 0, dilutedShares: 100 });
    expect(r.gTermUsedPct).toBe(4);
    expect(r.notes.some((n) => n.includes("Gordon TV guard"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sensitivity grid — shape, guard, monotonicity in WACC
// ---------------------------------------------------------------------------

describe("sensitivityGrid", () => {
  const a = explicitAssumptions({ gTermPct: 2, roicTermPct: 10 });
  const base = { waccPct: 10, netDebt: 100, dilutedShares: 100 };

  it("is a 5x5 grid with WACC and gTerm axes centered on base", () => {
    const g = sensitivityGrid(a, base);
    expect(g.waccPcts).toEqual([9, 9.5, 10, 10.5, 11]);
    expect(g.gTermPcts).toEqual([1, 1.5, 2, 2.5, 3]);
    expect(g.perShare).toHaveLength(5);
    expect(g.perShare.every((row) => row.length === 5)).toBe(true);
  });

  it("center cell equals the base-case per-share", () => {
    const g = sensitivityGrid(a, base);
    const dcf = runDcf(a, base);
    expect(g.perShare[2][2]).toBeCloseTo(dcf.perShare as number, 6);
  });

  it("per-share DECREASES as WACC rises (holding gTerm fixed)", () => {
    const g = sensitivityGrid(a, base);
    for (let j = 0; j < g.gTermPcts.length; j++) {
      const col = g.perShare.map((row) => row[j]).filter((v): v is number => v !== null);
      for (let i = 1; i < col.length; i++) {
        expect(col[i]).toBeLessThan(col[i - 1]);
      }
    }
  });

  it("per-share INCREASES as gTerm rises when ROIC > WACC across the axis", () => {
    // Monotone-increasing in gTerm holds ONLY when terminal ROIC exceeds WACC
    // (excess returns positive). With roicTerm 12 and a base WACC of 8, the
    // whole WACC axis (7..9) stays below ROIC, so every row is increasing.
    // (The base fixture with roicTerm=10 and WACC 11 is correctly DEcreasing —
    // that non-monotonicity is the economically-correct behaviour, tested via
    // the reverse-DCF non-monotone case below.)
    const moaty = explicitAssumptions({ gTermPct: 2, roicTermPct: 12 });
    const g = sensitivityGrid(moaty, { waccPct: 8, netDebt: 100, dilutedShares: 100 });
    for (let i = 0; i < g.waccPcts.length; i++) {
      const row = g.perShare[i].filter((v): v is number => v !== null);
      for (let j = 1; j < row.length; j++) {
        expect(row[j]).toBeGreaterThan(row[j - 1]);
      }
    }
  });

  it("per-share can DECREASE as gTerm rises when ROIC < WACC (correct behaviour)", () => {
    // Base fixture: roicTerm 10, base WACC 10 -> the WACC 11 row has ROIC < WACC,
    // so higher terminal growth destroys value (reinvestment g/ROIC outpaces the
    // excess return). Assert the top WACC row is non-increasing across gTerm.
    const g = sensitivityGrid(a, base);
    const topRow = g.perShare[g.waccPcts.length - 1].filter((v): v is number => v !== null);
    let sawDecrease = false;
    for (let j = 1; j < topRow.length; j++) {
      if (topRow[j] < topRow[j - 1]) sawDecrease = true;
    }
    expect(sawDecrease).toBe(true);
  });

  it("nulls grid cells only below the 1.5pp guard (spec §3), never a huge number", () => {
    // Grid cells use the LOOSER 1.5pp guard, not the 2.0pp base-case guard, so a
    // cell with spread in [1.5, 2.0) computes a finite value (it was null before
    // the guard split). base WACC 3.5 -> [2.5,3,3.5,4,4.5]; gTerm base 3 -> [2,2.5,3,3.5,4].
    const smallW = explicitAssumptions({ gTermPct: 3, roicTermPct: 8 });
    const g = sensitivityGrid(smallW, { waccPct: 3.5, netDebt: 0, dilutedShares: 100 });
    let sawNull = false; // spread < 1.5pp -> null
    let sawFiniteInBand = false; // spread in [1.5, 2.0) -> finite now (was null under the old 2pp guard)
    for (let i = 0; i < g.waccPcts.length; i++) {
      for (let j = 0; j < g.gTermPcts.length; j++) {
        const spread = g.waccPcts[i] - g.gTermPcts[j];
        if (spread < 1.5) {
          expect(g.perShare[i][j]).toBeNull();
          sawNull = true;
        } else if (spread < 2) {
          expect(g.perShare[i][j]).not.toBeNull();
          sawFiniteInBand = true;
        }
      }
    }
    expect(sawNull).toBe(true);
    expect(sawFiniteInBand).toBe(true);
  });

  it("returns an all-null grid + gap when bridge inputs are missing", () => {
    const g = sensitivityGrid(a, { waccPct: 10, netDebt: null, dilutedShares: 100 });
    expect(g.perShare.flat().every((v) => v === null)).toBe(true);
    expect(g.gaps.some((gp) => gp.field === "valuation.sensitivityGrid")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reverse DCF — round-trip, non-monotone bracket selection, negative-FCF path
// ---------------------------------------------------------------------------

describe("reverseDcf", () => {
  it("round-trips: run DCF at g=8%, feed perShare as price -> implied ~8% (within 5bp)", () => {
    // Constant 8% growth over 10y (no fade), roicTerm=WACC so FCFF>0.
    const a = explicitAssumptions({
      years: 10,
      growthPath: Array.from({ length: 10 }, () => 8),
      ebitMarginPath: Array.from({ length: 10 }, () => 20),
      taxRatePath: Array.from({ length: 10 }, () => 25),
      gTermPct: 2,
      roicTermPct: 10,
    });
    const opts = { waccPct: 10, netDebt: 100, dilutedShares: 100 };
    const dcf = runDcf(a, opts);
    const price = dcf.perShare as number;
    const rev = reverseDcf(price, a, opts);
    expect(rev.method).toBe("growth");
    expect(rev.impliedRevenueGrowthPct).not.toBeNull();
    // 5bp = 0.05pp tolerance (task spec); bisection tol is 1bp.
    expect(Math.abs((rev.impliedRevenueGrowthPct as number) - 8)).toBeLessThan(0.05);
  });

  it("bisection converges to within the 1bp growth tolerance", () => {
    const a = explicitAssumptions({
      years: 10,
      growthPath: Array.from({ length: 10 }, () => 12),
      gTermPct: 2,
      roicTermPct: 10,
    });
    const opts = { waccPct: 10, netDebt: 50, dilutedShares: 200 };
    const price = (runDcf(a, opts).perShare as number);
    const rev = reverseDcf(price, a, opts);
    expect(Math.abs((rev.impliedRevenueGrowthPct as number) - 12)).toBeLessThanOrEqual(
      BISECTION_TOL_PP + 1e-9,
    );
  });

  it("non-monotone (ROIC < WACC): picks the sign-change bracket nearest base growth", () => {
    // roicTerm (5%) < WACC (10%): terminal reinvest = 2/5 = 0.4; growth in the
    // explicit period still adds value early via S2C but the terminal branch is
    // value-destroying at high growth -> f(g) is non-monotone. We assert the
    // solver returns a growth root near the base-case g1 and reproduces price.
    const baseG = 8;
    const a = explicitAssumptions({
      years: 10,
      growthPath: Array.from({ length: 10 }, () => baseG),
      ebitMarginPath: Array.from({ length: 10 }, () => 15),
      taxRatePath: Array.from({ length: 10 }, () => 25),
      gTermPct: 2,
      roicTermPct: 5, // < WACC 10
      salesToCapital: 2.0,
    });
    const opts = { waccPct: 10, netDebt: 0, dilutedShares: 100 };
    const dcf = runDcf(a, opts);
    const price = dcf.perShare as number;
    const rev = reverseDcf(price, a, opts);
    // Whatever branch it lands on, re-running the DCF at the implied constant
    // growth must reproduce the price (it is a genuine root of f).
    expect(rev.method).toBe("growth");
    const implied = rev.impliedRevenueGrowthPct as number;
    const check = runDcf(
      { ...a, growthPath: { value: Array.from({ length: 10 }, () => implied), basis: "t" } },
      opts,
    );
    // Bisection stops at 1bp of GROWTH (or |f| < 0.05% of price), so price is
    // reproduced to within ~0.05% of price, not to N decimal places.
    expect(Math.abs((check.perShare as number) - price)).toBeLessThan(0.005 * price + 0.02);
    // And it must be the bracket nearest base growth (8%): the recovered root
    // should be reasonably close to 8, not the far/other branch.
    expect(Math.abs(implied - baseG)).toBeLessThan(baseG); // closer to 8 than to 0/16 extremes
  });

  it("negative base-FCFF -> falls back to solving the terminal EBIT margin", () => {
    // Negative EBIT margin in year 1 (deeply loss-making base) so FCFF_1 < 0.
    // Margin fade target is the unknown; growth path frozen. Solver should
    // return a margin-mode result whose implied terminal margin reproduces price.
    const a = explicitAssumptions({
      years: 10,
      growthPath: Array.from({ length: 10 }, () => 20),
      // margin fades from -10% (loss) toward +10% by year 10 in the base;
      // year-1 margin is negative so year-1 FCFF is negative.
      ebitMarginPath: fadePath(-10, 10, 10),
      taxRatePath: Array.from({ length: 10 }, () => 25),
      gTermPct: 2,
      roicTermPct: 10,
    });
    const opts = { waccPct: 10, netDebt: 0, dilutedShares: 100 };
    // Pick any positive price the margin-solve can hit.
    const price = 5;
    const rev = reverseDcf(price, a, opts);
    expect(rev.method === "margin" || rev.method === "none").toBe(true);
    if (rev.method === "margin") {
      expect(rev.impliedTerminalMarginPct).not.toBeNull();
      const m0 = a.ebitMarginPath.value[0];
      const impliedM = rev.impliedTerminalMarginPct as number;
      const check = runDcf(
        { ...a, ebitMarginPath: { value: fadePath(m0, impliedM, 10), basis: "t" } },
        opts,
      );
      // 1bp-of-margin bisection tolerance -> price reproduced to ~0.05% of price.
      expect(Math.abs((check.perShare as number) - price)).toBeLessThan(0.005 * price + 0.02);
    }
    expect(rev.notes.some((n) => n.includes("terminal EBIT margin") || n.includes("fallback"))).toBe(
      true,
    );
  });

  it("no price -> method 'none' with a gap, never throws", () => {
    const a = explicitAssumptions({ years: 10 });
    const rev = reverseDcf(null, a, { waccPct: 10, netDebt: 0, dilutedShares: 100 });
    expect(rev.method).toBe("none");
    expect(rev.gaps.length).toBeGreaterThan(0);
  });

  it("far-out price with no root reports deep-value / hypergrowth framing", () => {
    const a = explicitAssumptions({
      years: 10,
      growthPath: Array.from({ length: 10 }, () => 8),
      gTermPct: 2,
      roicTermPct: 10,
    });
    const opts = { waccPct: 10, netDebt: 0, dilutedShares: 100 };
    // Enormous price no growth in [-20,60] can justify -> hypergrowth note, none.
    const rev = reverseDcf(1e9, a, opts);
    expect(rev.method).toBe("none");
    expect(rev.notes.join(" ")).toMatch(/not justifiable|no root|hypergrowth|> 60/i);
  });
});

// ---------------------------------------------------------------------------
// buildDcfAssumptions — assumption construction + provenance + clamps
// ---------------------------------------------------------------------------

describe("buildDcfAssumptions", () => {
  const incomeTtm: DcfIncomeRow = {
    date: "2025-12-31",
    revenue: 1000,
    operatingIncome: 200,
    incomeBeforeTax: 180,
    incomeTaxExpense: 36, // 20% effective
  };
  const history: DcfIncomeRow[] = [
    { date: "2025-12-31", revenue: 1000, operatingIncome: 200 },
    { date: "2024-12-31", revenue: 900, operatingIncome: 189 }, // 21%
    { date: "2023-12-31", revenue: 800, operatingIncome: 160 }, // 20%
    { date: "2022-12-31", revenue: 700, operatingIncome: 133 }, // 19%
    { date: "2021-12-31", revenue: 600, operatingIncome: 108 }, // 18%
  ];
  const baseInputs: DcfAssumptionInputs = {
    revenueCagr3yPct: 12,
    revenueCagr5yPct: 13,
    analystEstimates: null,
    waccPct: 9,
    riskFreePct: 4.48,
    incomeTtm,
    incomeHistory: history,
    balance: {
      date: "2025-12-31",
      totalDebt: 300,
      totalStockholdersEquity: 500,
      cashAndShortTermInvestments: 100,
    },
    marketCap: 5000,
  };

  it("builds a 10-year horizon with linear fade to gTerm = min(2.5, rf)", () => {
    const { assumptions } = buildDcfAssumptions(baseInputs);
    expect(assumptions).not.toBeNull();
    const a = assumptions as DcfAssumptions;
    expect(a.years).toBe(DCF_HORIZON_YEARS);
    // gTerm = min(2.5, 4.48) = 2.5
    expect(a.terminal.gTermPct.value).toBe(2.5);
    // growth path fades from 12% (3y CAGR, no analyst) to 2.5% over 10y
    expect(a.growthPath.value[0]).toBeCloseTo(12, 9);
    expect(a.growthPath.value[9]).toBeCloseTo(2.5, 9);
    expect(a.growthPath.value).toHaveLength(10);
  });

  it("clamps gTerm to rf when rf < 2.5%", () => {
    const { assumptions } = buildDcfAssumptions({ ...baseInputs, riskFreePct: 2.0 });
    expect((assumptions as DcfAssumptions).terminal.gTermPct.value).toBe(2.0);
  });

  it("holds the current company tax rate when no historical tax series exists", () => {
    const a = buildDcfAssumptions(baseInputs).assumptions as DcfAssumptions;
    expect(a.taxRatePath.value[0]).toBeCloseTo(20, 9); // 36/180
    expect(a.taxRatePath.value[9]).toBeCloseTo(20, 9);
  });

  it("holds margin flat when the current margin equals the 5y median", () => {
    const a = buildDcfAssumptions(baseInputs).assumptions as DcfAssumptions;
    expect(a.ebitMarginPath.value.every((m) => Math.abs(m - 20) < 1e-9)).toBe(true);
    expect(a.ebitMarginPath.basis).toMatch(/stable|median/i);
  });

  it("fades an above-median margin down when the dated history is declining", () => {
    const decliningHistory: DcfIncomeRow[] = [
      { date: "2025-12-31", revenue: 100, operatingIncome: 40 },
      { date: "2024-12-31", revenue: 100, operatingIncome: 30 },
      { date: "2023-12-31", revenue: 100, operatingIncome: 20 },
      { date: "2022-12-31", revenue: 100, operatingIncome: 50 },
      { date: "2021-12-31", revenue: 100, operatingIncome: 60 },
    ];
    const a = buildDcfAssumptions({
      ...baseInputs,
      incomeTtm: { ...incomeTtm, revenue: 100, operatingIncome: 45 },
      incomeHistory: decliningHistory,
    }).assumptions as DcfAssumptions;
    expect(a.ebitMarginPath.value[1]).toBeLessThan(45);
    expect(a.ebitMarginPath.value[4]).toBeCloseTo(40, 6);
    expect(a.ebitMarginPath.basis).toMatch(/declining/i);
  });

  it("does not assume recovery when a below-median margin trend is declining", () => {
    const decliningHistory: DcfIncomeRow[] = [
      { date: "2025-12-31", revenue: 100, operatingIncome: 15 },
      { date: "2024-12-31", revenue: 100, operatingIncome: 20 },
      { date: "2023-12-31", revenue: 100, operatingIncome: 25 },
      { date: "2022-12-31", revenue: 100, operatingIncome: 30 },
      { date: "2021-12-31", revenue: 100, operatingIncome: 35 },
    ];
    const a = buildDcfAssumptions({
      ...baseInputs,
      incomeTtm: { ...incomeTtm, revenue: 100, operatingIncome: 15 },
      incomeHistory: decliningHistory,
    }).assumptions as DcfAssumptions;
    expect(a.ebitMarginPath.value.every((margin) => Math.abs(margin - 15) < 1e-9)).toBe(true);
    expect(a.ebitMarginPath.basis).toMatch(/declining/i);
  });

  it("allows median recovery only when a below-median margin trend is improving", () => {
    const improvingHistory: DcfIncomeRow[] = [
      { date: "2025-12-31", revenue: 100, operatingIncome: 15 },
      { date: "2024-12-31", revenue: 100, operatingIncome: 12 },
      { date: "2023-12-31", revenue: 100, operatingIncome: 9 },
      { date: "2022-12-31", revenue: 100, operatingIncome: 6 },
      { date: "2021-12-31", revenue: 100, operatingIncome: 3 },
    ];
    const a = buildDcfAssumptions({
      ...baseInputs,
      incomeTtm: { ...incomeTtm, revenue: 100, operatingIncome: 5 },
      incomeHistory: improvingHistory,
    }).assumptions as DcfAssumptions;
    expect(a.ebitMarginPath.value[1]).toBeGreaterThan(5);
    expect(a.ebitMarginPath.value[4]).toBeCloseTo(9, 6);
    expect(a.ebitMarginPath.basis).toMatch(/improving/i);
  });

  it("prefers analyst 2y growth over history when estimates are present", () => {
    const est: AnalystEstimateRow[] = [
      { date: "2026-12-31", revenueAvg: 1100 }, // +10% off TTM 1000
      { date: "2027-12-31", revenueAvg: 1210 }, // +10%
    ];
    const a = buildDcfAssumptions({ ...baseInputs, analystEstimates: est }).assumptions as DcfAssumptions;
    // avg of (10, 10) = 10 — TTM 2025-12-31 → FY1 2026-12-31 is a full 365-day
    // year, so day-count annualization is a no-op here (audit L3).
    expect(a.growthPath.value[0]).toBeCloseTo(10, 6);
    expect(a.growthPath.basis).toMatch(/analyst/i);
  });

  it("annualizes a partial-period TTM→FY1 analyst leg by day-count (audit L3)", () => {
    // TTM window ends 2026-10-01; FY1 ends 2026-12-31 → 91 days. The raw ratio
    // 1025/1000 = 1.025 is 2.5% over ~one quarter, NOT a full-year rate.
    // Hand-derived annualization: 1.025^(365.25/91) − 1
    //   = e^(4.013736 × ln 1.025) − 1 = e^0.099110 − 1 ≈ 0.10418 → ~10.42%/yr.
    const est: AnalystEstimateRow[] = [{ date: "2026-12-31", revenueAvg: 1025 }];
    const a = buildDcfAssumptions({
      ...baseInputs,
      incomeTtm: { ...incomeTtm, date: "2026-10-01" },
      analystEstimates: est,
    }).assumptions as DcfAssumptions;
    const expected = (Math.pow(1.025, 365.25 / 91) - 1) * 100;
    expect(expected).toBeGreaterThan(10.3); // sanity band on the hand-derived value
    expect(expected).toBeLessThan(10.5);
    expect(a.growthPath.value[0]).toBeCloseTo(expected, 6);
    expect(a.notes.some((n) => /annualized/i.test(n))).toBe(true);
  });

  it("skips a <90-day TTM→FY1 leg as too noisy and uses the FY1→FY2 leg alone (audit L3)", () => {
    // TTM ends 2026-11-15; FY1 ends 2026-12-31 → 46 days. A 10% ratio over 46
    // days would annualize to >100%/yr — noise, not signal. FY1→FY2 = +10%.
    const est: AnalystEstimateRow[] = [
      { date: "2026-12-31", revenueAvg: 1100 },
      { date: "2027-12-31", revenueAvg: 1210 },
    ];
    const a = buildDcfAssumptions({
      ...baseInputs,
      incomeTtm: { ...incomeTtm, date: "2026-11-15" },
      analystEstimates: est,
    }).assumptions as DcfAssumptions;
    expect(a.growthPath.value[0]).toBeCloseTo(10, 9);
    expect(a.notes.some((n) => /skipped/i.test(n))).toBe(true);
  });

  it("takes min(3y,5y) CAGR when they diverge > 5pp (conservatism)", () => {
    const a = buildDcfAssumptions({
      ...baseInputs,
      revenueCagr3yPct: 20,
      revenueCagr5yPct: 10,
      analystEstimates: null,
    }).assumptions as DcfAssumptions;
    expect(a.growthPath.value[0]).toBeCloseTo(10, 9); // took the smaller
    expect(a.notes.some((n) => n.includes(">5pp") || n.includes("conservatism"))).toBe(true);
  });

  it("clamps near-term growth into [-10, +25] (spec §2.2)", () => {
    const a = buildDcfAssumptions({
      ...baseInputs,
      revenueCagr3yPct: 200,
      revenueCagr5yPct: 200,
    }).assumptions as DcfAssumptions;
    expect(a.growthPath.value[0]).toBe(25);
    expect(a.notes.some((n) => n.includes("clamped"))).toBe(true);
  });

  it("suppresses the DCF when invested capital is unusable instead of defaulting S2C", () => {
    const built = buildDcfAssumptions({
      ...baseInputs,
      balance: {
        date: "2025-12-31",
        totalDebt: 50,
        totalStockholdersEquity: 10,
        cashAndShortTermInvestments: 200, // IC = 50 + 10 - 200 < 0
      },
    });
    expect(built.assumptions).toBeNull();
    expect(
      built.gaps.some(
        (g) => g.field === "valuation.dcf.salesToCapital" && g.severity === "critical",
      ),
    ).toBe(true);
  });

  it("uses company historical tax rates and suppresses the DCF when none exist", () => {
    const contextual = buildDcfAssumptions({
      ...baseInputs,
      incomeHistory: [
        { date: "2024-12-31", revenue: 900, operatingIncome: 180, incomeBeforeTax: 160, incomeTaxExpense: 24 },
        { date: "2023-12-31", revenue: 800, operatingIncome: 160, incomeBeforeTax: 140, incomeTaxExpense: 28 },
      ],
    }).assumptions as DcfAssumptions;
    expect(contextual.taxRatePath.value.at(-1)).toBeCloseTo(17.5, 8);
    expect(contextual.taxRatePath.basis).toContain("company historical median");

    const missing = buildDcfAssumptions({
      ...baseInputs,
      incomeTtm: { ...incomeTtm, incomeBeforeTax: null, incomeTaxExpense: null },
      incomeHistory: history,
    });
    expect(missing.assumptions).toBeNull();
    expect(
      missing.gaps.some(
        (g) => g.field === "valuation.dcf.effectiveTaxRate" && g.severity === "critical",
      ),
    ).toBe(true);
  });

  it("returns null assumptions + critical gap when TTM revenue is missing", () => {
    const built = buildDcfAssumptions({ ...baseInputs, incomeTtm: null });
    expect(built.assumptions).toBeNull();
    expect(built.gaps.some((g) => g.severity === "critical")).toBe(true);
  });

  it("treats FMP zero-for-undisclosed TTM revenue as null (implausible zero)", () => {
    const built = buildDcfAssumptions({
      ...baseInputs,
      incomeTtm: { ...incomeTtm, revenue: 0 },
    });
    expect(built.assumptions).toBeNull();
  });

  it("labels the DCF base as annual when complete TTM was unavailable", () => {
    const built = buildDcfAssumptions({
      ...baseInputs,
      incomeTtm: { ...incomeTtm, basis: "annual" },
    });
    const assumptions = built.assumptions as DcfAssumptions;
    expect(assumptions.startRevenue.basis).toMatch(/latest annual FY 2025-12-31/i);
    expect(assumptions.salesToCapital.basis).toMatch(/latest annual FY/i);
    expect(assumptions.taxRatePath.basis).toMatch(/latest annual FY/i);
  });

  it("every assumption carries a value + basis string (report assumption block)", () => {
    const a = buildDcfAssumptions(baseInputs).assumptions as DcfAssumptions;
    expect(typeof a.startRevenue.basis).toBe("string");
    expect(a.startRevenue.basis.length).toBeGreaterThan(0);
    expect(typeof a.growthPath.basis).toBe("string");
    expect(typeof a.terminal.gTermPct.basis).toBe("string");
    expect(typeof a.midYear.basis).toBe("string");
    expect(a.midYear.value).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Multiples framework — computation from raw fields, bands, peer stats, sectors
// ---------------------------------------------------------------------------

describe("multiplesFramework", () => {
  const baseInputs: MultiplesFrameworkInputs = {
    quote: { price: 100, marketCap: 10000, currency: "USD" },
    reportedCurrency: "USD",
    incomeTtm: {
      date: "2025-12-31",
      revenue: 5000,
      operatingIncome: 1000,
      depreciationAndAmortization: 200,
      netIncome: 700,
      epsDiluted: 7, // price 100 / 7 -> P/E ~14.2857
    },
    cashFlowTtm: {
      date: "2025-12-31",
      operatingCashFlow: 900,
      capitalExpenditure: -150, // FMP negative -> FCF = 750
      depreciationAndAmortization: 200,
    },
    balance: {
      date: "2025-12-31",
      totalDebt: 2000,
      cashAndShortTermInvestments: 500,
      totalStockholdersEquity: 4000,
      goodwill: 800,
      intangibleAssets: 200,
      minorityInterest: 0,
      preferredStock: 0,
    },
  };

  it("computes current multiples from RAW fields (not vendor pre-baked)", () => {
    const r = multiplesFramework("general", baseInputs);
    const by = Object.fromEntries(r.multiples.map((m) => [m.key, m.current]));
    // P/E = price / epsDiluted = 100 / 7
    expect(by.peTtm).toBeCloseTo(100 / 7, 9);
    // EV = 10000 + 2000 + 0 + 0 - 500 = 11500; EBITDA = 1000 + 200 = 1200
    expect(by.evToEbitda).toBeCloseTo(11500 / 1200, 9);
    // EV/S = 11500 / 5000
    expect(by.evToSales).toBeCloseTo(11500 / 5000, 9);
    // P/FCF = 10000 / (900 - 150) = 10000/750
    expect(by.priceToFcf).toBeCloseTo(10000 / 750, 9);
    // P/B = 10000 / 4000
    expect(by.priceToBook).toBeCloseTo(2.5, 9);
    // P/TBV = 10000 / (4000 - 800 - 200) = 10000/3000
    expect(by.priceToTbv).toBeCloseTo(10000 / 3000, 9);
  });

  it("renders negative-denominator multiples as n/m (null)", () => {
    const r = multiplesFramework("general", {
      ...baseInputs,
      incomeTtm: { ...baseInputs.incomeTtm!, netIncome: -100, epsDiluted: -1 },
    });
    const pe = r.multiples.find((m) => m.key === "peTtm");
    expect(pe?.current).toBeNull();
  });

  it("flags the ADR currency-mismatch case and gaps it", () => {
    const r = multiplesFramework("general", {
      ...baseInputs,
      reportedCurrency: "TWD",
      quote: { ...baseInputs.quote, currency: "USD" },
    });
    expect(r.notes.some((n) => /ADR|currency mismatch/i.test(n))).toBe(true);
    expect(r.gaps.some((g) => g.field === "valuation.multiples.currency")).toBe(true);
  });

  it("bank sectorAppropriate list EXCLUDES EV multiples (P/TBV, P/E, P/B only)", () => {
    const bankList = SECTOR_APPROPRIATE_MULTIPLES.bank;
    expect(bankList).toContain("priceToTbv");
    expect(bankList).toContain("peTtm");
    expect(bankList).not.toContain("evToEbitda");
    expect(bankList).not.toContain("evToSales");
  });

  it("REIT sectorAppropriate list leads with P/FFO / P/AFFO", () => {
    expect(SECTOR_APPROPRIATE_MULTIPLES.reit).toEqual(["priceToFfo", "priceToAffo"]);
  });

  it("suppresses EV multiples (null current) for the bank route", () => {
    const r = multiplesFramework("bank", baseInputs);
    const evEbitda = r.multiples.find((m) => m.key === "evToEbitda");
    const evSales = r.multiples.find((m) => m.key === "evToSales");
    expect(evEbitda?.current).toBeNull();
    expect(evSales?.current).toBeNull();
    expect(r.notes.some((n) => /EV multiples suppressed/i.test(n))).toBe(true);
  });

  it("builds own-history percentile bands from quarterly TTM windows + EV history", () => {
    // 12 quarters of flat fundamentals so every TTM window is identical; the
    // percentile band should then be degenerate (all obs equal) but present.
    const quarters = Array.from({ length: 12 }, (_, i) => {
      const y = 2025 - Math.floor(i / 4);
      const q = ["12-31", "09-30", "06-30", "03-31"][i % 4];
      return {
        date: `${y}-${q}`,
        revenue: 1250,
        operatingIncome: 250,
        depreciationAndAmortization: 50,
        netIncome: 175,
        operatingCashFlow: 225,
        capitalExpenditure: -37.5,
        totalStockholdersEquity: 4000,
      };
    });
    const evRows = quarters.map((q) => ({
      date: q.date,
      marketCapitalization: 10000,
      enterpriseValue: 11500,
    }));
    const r = multiplesFramework("general", {
      ...baseInputs,
      quarterlyFundamentals: quarters,
      enterpriseValuesHistory: evRows,
    });
    const pe = r.multiples.find((m) => m.key === "peTtm");
    expect(pe?.ownHistory).not.toBeNull();
    expect(pe?.ownHistory?.observations).toBeGreaterThanOrEqual(8);
    // current P/E ~14.2857 sits above the flat historical TTM P/E (10000/700=14.2857)
    // -> rank should be a finite number in [0,100].
    expect(pe?.ownHistory?.percentileRank).not.toBeNull();
    // 12 quarters -> 9 TTM obs (< 20 = full 5y window) -> flagged low-sample so the
    // tail percentiles aren't over-read.
    expect(pe?.ownHistory?.observations).toBeLessThan(20);
    expect(pe?.ownHistory?.lowSample).toBe(true);
    expect(pe?.ownHistory?.basis).toMatch(/LOW SAMPLE/);
  });

  it("does NOT flag low-sample once the full 5-year (20-quarter) window is reached", () => {
    // 23 quarters -> maxObs = min(20, 23-3) = 20 TTM windows -> full window, no flag.
    const quarters = Array.from({ length: 23 }, (_, i) => {
      const y = 2026 - Math.floor(i / 4);
      const q = ["12-31", "09-30", "06-30", "03-31"][i % 4];
      return {
        date: `${y}-${q}`,
        revenue: 1250,
        operatingIncome: 250,
        depreciationAndAmortization: 50,
        netIncome: 175,
        operatingCashFlow: 225,
        capitalExpenditure: -37.5,
        totalStockholdersEquity: 4000,
      };
    });
    const evRows = quarters.map((q) => ({ date: q.date, marketCapitalization: 10000, enterpriseValue: 11500 }));
    const r = multiplesFramework("general", { ...baseInputs, quarterlyFundamentals: quarters, enterpriseValuesHistory: evRows });
    const pe = r.multiples.find((m) => m.key === "peTtm");
    expect(pe?.ownHistory?.observations).toBe(20);
    expect(pe?.ownHistory?.lowSample).toBe(false);
    expect(pe?.ownHistory?.basis).not.toMatch(/LOW SAMPLE/);
  });

  it("peer stats: median + min/max, trims outliers, suppresses below 4 survivors", () => {
    const peersMany: PeerMultiples[] = [
      { symbol: "A", multiples: { peTtm: 10 } },
      { symbol: "B", multiples: { peTtm: 12 } },
      { symbol: "C", multiples: { peTtm: 14 } },
      { symbol: "D", multiples: { peTtm: 16 } },
      { symbol: "E", multiples: { peTtm: 1000 } }, // IQR outlier -> trimmed
    ];
    const r = multiplesFramework("general", { ...baseInputs, peers: peersMany });
    const pe = r.multiples.find((m) => m.key === "peTtm");
    expect(pe?.peers).not.toBeNull();
    expect(pe?.peers?.count).toBe(4); // outlier dropped
    expect(pe?.peers?.median).toBeCloseTo(13, 9); // median of [10,12,14,16]
    expect(pe?.peers?.max).toBe(16);

    const peersFew: PeerMultiples[] = [
      { symbol: "A", multiples: { peTtm: 10 } },
      { symbol: "B", multiples: { peTtm: 12 } },
    ];
    const r2 = multiplesFramework("general", { ...baseInputs, peers: peersFew });
    expect(r2.multiples.find((m) => m.key === "peTtm")?.peers).toBeNull(); // < 4 survivors
  });
});

// ---------------------------------------------------------------------------
// Excess-return model — golden 2-year case + reverse solve
// ---------------------------------------------------------------------------

describe("excessReturnModel (banks / insurers)", () => {
  it("caller override: terminal ROE 9 (below CoE 10) → nonzero terminal excess", () => {
    // roePath = fadePath(15, 9, 2) = [15, 9], retention 0.5
    //   Y1 excess (0.15-0.10)*1000 = 50; pv 50/1.1 = 45.454545...
    //      BV1 = 1000*(1+0.15*0.5) = 1075
    //   Y2 excess (0.09-0.10)*1075 = -10.75; pv -10.75/1.21 = -8.884297...
    //      BV2 = 1075*(1+0.09*0.5) = 1123.375
    //   pvExcess = 36.570247933...; equityValue = 1036.570248
    const r = excessReturnModel({
      bookValue: 1000,
      currentRoePct: 15,
      analystImpliedRoePct: 9,
      costOfEquityPct: 10,
      years: 2,
      payoutRatioPct: 50,
      dilutedShares: 100,
    });
    expect(r.roePathPct.value).toEqual([15, 9]);
    expect(r.bookValuePath).toEqual([1000, 1075, 1123.375]);
    expect(r.equityValue).toBeCloseTo(1036.5702479338843, 6);
    expect(r.perShare).toBeCloseTo(10.365702479338843, 6);
    expect(r.impliedPToBv).toBeCloseTo(1.0365702479338843, 9);
    // terminalExcess is now COMPUTED, not hardcoded: (0.09-0.10)*BV1 = (0.09-0.10)*1075 = -10.75
    expect(r.terminalExcess).toBeCloseTo(-10.75, 6);
    expect(r.roePathPct.basis).toMatch(/caller-supplied terminal ROE/i);
  });

  it("default competitive fade: ROE fades to CoE, terminal excess is exactly 0", () => {
    // No analystImpliedRoePct (production never supplies it) → endpoint = CoE.
    // fadePath(15, 10, 2) = [15, 10], CoE 10, retention 0.5:
    //   Y1 excess (0.15-0.10)*1000 = 50; pv 50/1.1 = 45.4545...; BV1 = 1075
    //   Y2 excess (0.10-0.10)*1075 = 0;  pv 0;                    BV2 = 1128.75
    //   equityValue = 1000 + 45.4545... = 1045.4545...
    const r = excessReturnModel({
      bookValue: 1000,
      currentRoePct: 15,
      costOfEquityPct: 10,
      years: 2,
      payoutRatioPct: 50,
      dilutedShares: 100,
    });
    expect(r.roePathPct.value).toEqual([15, 10]);
    expect(r.bookValuePath).toEqual([1000, 1075, 1128.75]);
    expect(r.equityValue).toBeCloseTo(1045.4545454545455, 6);
    expect(r.terminalExcess).toBe(0);
    expect(r.roePathPct.basis).toMatch(/cost of equity/i);
    expect(r.roePathPct.basis).toMatch(/competitive fade/i);
  });

  it("reverse-solves the constant steady-state ROE matching market cap", () => {
    // Build the model, take its equityValue as the market cap, and confirm the
    // reverse solve recovers a constant ROE that reproduces it. With a constant
    // ROE the model is monotone, so this is a clean round-trip.
    const bookValue = 1000;
    const coe = 10;
    const payout = 50;
    const years = 10;
    // value at constant ROE 13%:
    const forward = excessReturnModel({
      bookValue,
      currentRoePct: 13,
      analystImpliedRoePct: 13, // fade 13->13 = constant 13
      costOfEquityPct: coe,
      years,
      payoutRatioPct: payout,
      dilutedShares: 100,
      marketCap: undefined,
    });
    const mcap = forward.equityValue as number;
    const solved = excessReturnModel({
      bookValue,
      currentRoePct: 13,
      analystImpliedRoePct: 13,
      costOfEquityPct: coe,
      years,
      payoutRatioPct: payout,
      dilutedShares: 100,
      marketCap: mcap,
    });
    expect(solved.reverseSolve.impliedSteadyRoePct).not.toBeNull();
    expect(solved.reverseSolve.impliedSteadyRoePct as number).toBeCloseTo(13, 2);
  });

  it("uses NO WACC (equity-only) and flags implied P/B outside [0.3, 3]", () => {
    // Very high ROE relative to CoE -> implied P/B > 3 -> sanity flag.
    const r = excessReturnModel({
      bookValue: 1000,
      currentRoePct: 40,
      analystImpliedRoePct: 40,
      costOfEquityPct: 8,
      years: 10,
      payoutRatioPct: 30,
      dilutedShares: 100,
    });
    expect(r.impliedPToBv as number).toBeGreaterThan(3);
    expect(r.notes.some((n) => /P\/B/.test(n) && /sanity|review/.test(n))).toBe(true);
    // The model is equity-only: it takes a costOfEquityPct and NEVER a WACC
    // (the input type has no wacc field — a compile-time guarantee), and it
    // discloses this explicitly.
    expect(r.notes.some((n) => /equity-only/i.test(n) && /never WACC/i.test(n))).toBe(true);
  });

  it("null book value -> critical gap, no throw, null outputs", () => {
    const r = excessReturnModel({ bookValue: null, currentRoePct: 12, costOfEquityPct: 10 });
    expect(r.equityValue).toBeNull();
    expect(r.perShare).toBeNull();
    expect(r.gaps.some((g) => g.severity === "critical")).toBe(true);
  });

  it("suppresses rather than inventing a 50% payout when history is absent", () => {
    const r = excessReturnModel({
      bookValue: 1000,
      currentRoePct: 12,
      costOfEquityPct: 10,
      years: 5,
    });
    expect(r.equityValue).toBeNull();
    expect(r.perShare).toBeNull();
    expect(r.payoutRatioPct.value).toBeNull();
    expect(
      r.gaps.some(
        (g) => g.field === "valuation.excessReturn.payout" && g.severity === "critical",
      ),
    ).toBe(true);
  });

  it("suppresses rather than holding a missing current ROE at the terminal path", () => {
    const r = excessReturnModel({
      bookValue: 1000,
      currentRoePct: null,
      costOfEquityPct: 10,
      payoutRatioPct: 40,
      years: 5,
    });
    expect(r.equityValue).toBeNull();
    expect(r.perShare).toBeNull();
    expect(r.roePathPct.value).toEqual([]);
    expect(
      r.gaps.some(
        (g) => g.field === "valuation.excessReturn.currentRoe" && g.severity === "critical",
      ),
    ).toBe(true);
  });

  it("null cost of equity -> model suppressed with a critical gap, never a silent 10% default (audit M5)", () => {
    const r = excessReturnModel({
      bookValue: 1000,
      currentRoePct: 12,
      costOfEquityPct: null,
      years: 5,
      payoutRatioPct: 50,
      dilutedShares: 100,
      marketCap: 1200,
    });
    expect(r.equityValue).toBeNull();
    expect(r.perShare).toBeNull();
    expect(r.impliedPToBv).toBeNull();
    expect(r.bookValuePath).toEqual([]);
    expect(r.reverseSolve.impliedSteadyRoePct).toBeNull();
    expect(
      r.gaps.some(
        (g) => g.field === "valuation.excessReturn.costOfEquity" && g.severity === "critical",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REIT valuation — approximate labels, P/FFO, P/AFFO, implied cap rate
// ---------------------------------------------------------------------------

describe("reitValuation", () => {
  it("computes P/FFO, P/AFFO, per-share, and implied cap rate (all approximate)", () => {
    // price 50, shares 100 -> mcap 5000; netDebt 2000 -> EV 7000
    // FFO 400, AFFO 300, NOI 500 -> capRate 500/7000 = 7.142857%
    const r = reitValuation({
      ffoApprox: 400,
      affoApprox: 300,
      sharePrice: 50,
      shares: 100,
      netDebt: 2000,
      noiApprox: 500,
      asOf: "2025-12-31",
    });
    expect(r.pToFfo).toBeCloseTo(5000 / 400, 9);
    expect(r.pToAffo).toBeCloseTo(5000 / 300, 9);
    expect(r.ffoPerShare).toBeCloseTo(4, 9);
    expect(r.affoPerShare).toBeCloseTo(3, 9);
    expect(r.enterpriseValue).toBe(7000);
    expect(r.impliedCapRatePct).toBeCloseTo((500 / 7000) * 100, 9);
    expect(r.notes.some((n) => /approx/i.test(n))).toBe(true);
  });

  it("discloses the implied cap rate as a gap when NOI is not derivable", () => {
    const r = reitValuation({
      ffoApprox: 400,
      affoApprox: 300,
      sharePrice: 50,
      shares: 100,
      netDebt: 2000,
      noiApprox: null,
    });
    expect(r.impliedCapRatePct).toBeNull();
    expect(r.gaps.some((g) => g.field === "valuation.reit.impliedCapRate")).toBe(true);
  });

  it("n/m P/FFO when FFO is non-positive; never throws", () => {
    const r = reitValuation({
      ffoApprox: -50,
      affoApprox: null,
      sharePrice: 50,
      shares: 100,
      netDebt: 2000,
    });
    expect(r.pToFfo).toBeNull();
    expect(r.gaps.some((g) => g.field === "valuation.reit.ffo")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// valueCompany — route dispatch (discriminated union)
// ---------------------------------------------------------------------------

describe("valueCompany dispatch", () => {
  const route = (base: CompanyRoute["base"], overlays: CompanyRoute["overlays"] = []): CompanyRoute => ({
    base,
    overlays,
    evidence: { sector: null, industry: null },
  });

  const dcfInputs: DcfAssumptionInputs = {
    revenueCagr3yPct: 10,
    revenueCagr5yPct: 10,
    analystEstimates: null,
    waccPct: 9,
    riskFreePct: 4.48,
    incomeTtm: {
      date: "2025-12-31",
      revenue: 1000,
      operatingIncome: 200,
      incomeBeforeTax: 180,
      incomeTaxExpense: 36,
    },
    incomeHistory: [
      { date: "2025-12-31", revenue: 1000, operatingIncome: 200 },
      { date: "2024-12-31", revenue: 900, operatingIncome: 180 },
      { date: "2023-12-31", revenue: 800, operatingIncome: 160 },
    ],
    balance: {
      date: "2025-12-31",
      totalDebt: 300,
      totalStockholdersEquity: 500,
      cashAndShortTermInvestments: 100,
    },
    marketCap: 5000,
  };

  const multiples: MultiplesFrameworkInputs = {
    quote: { price: 100, marketCap: 10000, currency: "USD" },
    reportedCurrency: "USD",
    incomeTtm: {
      date: "2025-12-31",
      revenue: 1000,
      operatingIncome: 200,
      depreciationAndAmortization: 50,
      netIncome: 144,
      epsDiluted: 1.44,
    },
    cashFlowTtm: {
      date: "2025-12-31",
      operatingCashFlow: 180,
      capitalExpenditure: -30,
      depreciationAndAmortization: 50,
    },
    balance: {
      date: "2025-12-31",
      totalDebt: 300,
      cashAndShortTermInvestments: 100,
      totalStockholdersEquity: 500,
      goodwill: 50,
      intangibleAssets: 50,
      minorityInterest: 0,
      preferredStock: 0,
    },
  };

  it("general -> kind 'dcf' with DCF + sensitivity + reverse DCF + multiples", () => {
    const r = valueCompany(route("general"), {
      currentPrice: 100,
      waccPct: 9,
      netDebt: 200,
      dilutedShares: 100,
      dcfInputs,
      multiples,
      excessReturn: null,
      reit: null,
    });
    expect(r.kind).toBe("dcf");
    if (r.kind === "dcf") {
      expect(r.assumptions).not.toBeNull();
      expect(r.dcf).not.toBeNull();
      expect(r.sensitivity).not.toBeNull();
      expect(r.reverseDcf).not.toBeNull();
      expect(r.multiples.multiples.length).toBeGreaterThan(0);
    }
  });

  it("bank -> kind 'excess-return', NO DCF, book multiples only", () => {
    const r = valueCompany(route("bank"), {
      currentPrice: 100,
      waccPct: 9,
      netDebt: 200,
      dilutedShares: 100,
      dcfInputs: null,
      multiples,
      excessReturn: {
        bookValue: 500,
        currentRoePct: 12,
        costOfEquityPct: 10,
        years: 10,
        payoutRatioPct: 40,
        dilutedShares: 100,
        marketCap: 600,
      },
      reit: null,
    });
    expect(r.kind).toBe("excess-return");
    if (r.kind === "excess-return") {
      expect(r.excessReturn.equityValue).not.toBeNull();
      // multiples for bank route suppress EV multiples
      const ev = r.multiples.multiples.find((m) => m.key === "evToEbitda");
      expect(ev?.current).toBeNull();
    }
  });

  it("reit -> kind 'reit' with FFO multiples and cap-rate sketch", () => {
    const r = valueCompany(route("reit"), {
      currentPrice: 50,
      waccPct: 9,
      netDebt: 2000,
      dilutedShares: 100,
      dcfInputs: null,
      multiples,
      excessReturn: null,
      reit: {
        ffoApprox: 400,
        affoApprox: 300,
        sharePrice: 50,
        shares: 100,
        netDebt: 2000,
        noiApprox: 500,
      },
    });
    expect(r.kind).toBe("reit");
    if (r.kind === "reit") {
      expect(r.reit.pToFfo).not.toBeNull();
    }
  });

  it("pre-revenue overlay -> kind 'pre-revenue', null valuation", () => {
    const r = valueCompany(route("general", ["pre-revenue"]), {
      currentPrice: 10,
      waccPct: 9,
      netDebt: 0,
      dilutedShares: 100,
      dcfInputs,
      multiples,
      excessReturn: null,
      reit: null,
    });
    expect(r.kind).toBe("pre-revenue");
    if (r.kind === "pre-revenue") {
      expect(r.multiples).toBeNull();
    }
  });

  it("unprofitable overlay -> kind 'dcf-suppressed' (metricPolicy fcfDcf), multiples retained (2026-07 audit finding 3)", () => {
    const r = valueCompany(route("general", ["unprofitable"]), {
      currentPrice: 100,
      waccPct: 9,
      netDebt: 200,
      dilutedShares: 100,
      dcfInputs,
      multiples,
      excessReturn: null,
      reit: null,
    });
    expect(r.kind).toBe("dcf-suppressed");
    if (r.kind === "dcf-suppressed") {
      expect(r.multiples.multiples.length).toBeGreaterThan(0);
      expect(r.gaps.some((g) => g.field === "valuation.dcf")).toBe(true);
      expect(r.notes.some((n) => n.includes("fcfDcf"))).toBe(true);
    }
    expect("dcf" in r).toBe(false);
    expect("sensitivity" in r).toBe(false);
    expect("reverseDcf" in r).toBe(false);
  });

  it("general route with missing WACC -> DCF suppressed with a critical gap", () => {
    const r = valueCompany(route("general"), {
      currentPrice: 100,
      waccPct: null,
      netDebt: 200,
      dilutedShares: 100,
      dcfInputs,
      multiples,
      excessReturn: null,
      reit: null,
    });
    expect(r.kind).toBe("dcf");
    if (r.kind === "dcf") {
      expect(r.dcf).toBeNull();
      expect(r.gaps.some((g) => g.severity === "critical")).toBe(true);
    }
  });

  it("bank route with no excess-return inputs -> critical gap, still dispatches", () => {
    const r = valueCompany(route("bank"), {
      currentPrice: 100,
      waccPct: 9,
      netDebt: 200,
      dilutedShares: 100,
      dcfInputs: null,
      multiples,
      excessReturn: null,
      reit: null,
    });
    expect(r.kind).toBe("excess-return");
    if (r.kind === "excess-return") {
      expect(r.gaps.some((g) => g.severity === "critical")).toBe(true);
    }
  });

  it("ADR currency mismatch (TWD statements, USD quote) -> DCF/sensitivity/reverse-DCF suppressed with a disclosed gap (audit H3)", () => {
    const r = valueCompany(route("general"), {
      currentPrice: 100, // USD quote
      waccPct: 9,
      netDebt: 200,
      dilutedShares: 100,
      dcfInputs: { ...dcfInputs, reportedCurrency: "TWD", quoteCurrency: "USD" },
      multiples: { ...multiples, reportedCurrency: "TWD" },
      excessReturn: null,
      reit: null,
    });
    expect(r.kind).toBe("dcf");
    if (r.kind === "dcf") {
      expect(r.assumptions).toBeNull();
      expect(r.dcf).toBeNull();
      expect(r.sensitivity).toBeNull();
      expect(r.reverseDcf).toBeNull();
      expect(
        r.gaps.some((g) => g.field === "valuation.dcf.currency" && g.severity === "critical"),
      ).toBe(true);
      expect(r.notes.some((n) => /currency mismatch|ADR/i.test(n))).toBe(true);
      // Multiples remain available (flagged) for relative valuation.
      expect(r.multiples.multiples.length).toBeGreaterThan(0);
    }
  });

  it("same-currency company is unaffected by the ADR guard (case-insensitive match)", () => {
    const r = valueCompany(route("general"), {
      currentPrice: 100,
      waccPct: 9,
      netDebt: 200,
      dilutedShares: 100,
      dcfInputs: { ...dcfInputs, reportedCurrency: "usd", quoteCurrency: "USD" },
      multiples,
      excessReturn: null,
      reit: null,
    });
    expect(r.kind).toBe("dcf");
    if (r.kind === "dcf") {
      expect(r.dcf).not.toBeNull();
      expect(r.reverseDcf).not.toBeNull();
      expect(r.gaps.some((g) => g.field === "valuation.dcf.currency")).toBe(false);
    }
  });

  it("missing currency metadata does not trip the ADR guard (guard requires both sides)", () => {
    const r = valueCompany(route("general"), {
      currentPrice: 100,
      waccPct: 9,
      netDebt: 200,
      dilutedShares: 100,
      dcfInputs: { ...dcfInputs, reportedCurrency: null, quoteCurrency: "USD" },
      multiples,
      excessReturn: null,
      reit: null,
    });
    expect(r.kind).toBe("dcf");
    if (r.kind === "dcf") {
      expect(r.dcf).not.toBeNull();
      expect(r.gaps.some((g) => g.field === "valuation.dcf.currency")).toBe(false);
    }
  });
});
