/**
 * Stage B — deterministic DCF display (assumptions rows + sensitivity cells).
 *
 * The report's valuation.dcf.assumptions + sensitivityGrid were LLM/judge-
 * transcribed. computeDcfDisplay reshapes the DETERMINISTIC Stage B DcfAssumptions
 * + SensitivityGrid into the report's display shapes, so the valuation card shows
 * the real computed inputs — or EMPTY when no FCFF DCF applies to the route
 * (banks/insurers use the excess-return model; REIT/pre-revenue have no per-share
 * DCF), never judge-fabricated DCF assumptions.
 */

import { describe, expect, it } from "vitest";

import { computeDcfDisplay } from "@/pipeline/stageB/fairValue";
import {
  buildDcfAssumptions,
  runDcf,
  sensitivityGrid,
  excessReturnModel,
  reitValuation,
  type DcfAssumptions,
  type ValuationResult,
} from "@/pipeline/stageB/valuation";

const MULTIPLES = { multiples: [], sectorAppropriate: [], asOf: { quote: null, statements: null }, notes: [], gaps: [] };

function builtAssumptions(): DcfAssumptions {
  const built = buildDcfAssumptions({
    revenueCagr3yPct: 12,
    revenueCagr5yPct: 12,
    analystEstimates: null,
    waccPct: 9,
    riskFreePct: 4,
    incomeTtm: { date: "2025-12-31", revenue: 1000, operatingIncome: 300, incomeBeforeTax: 280, incomeTaxExpense: 60 },
    incomeHistory: [
      { date: "2024-12-31", revenue: 920, operatingIncome: 276, incomeBeforeTax: 256, incomeTaxExpense: 54 },
      { date: "2025-12-31", revenue: 1000, operatingIncome: 300, incomeBeforeTax: 280, incomeTaxExpense: 60 },
    ],
    balance: { date: "2025-12-31", totalDebt: 200, totalStockholdersEquity: 800, cashAndShortTermInvestments: 300 },
    marketCap: 5000,
  });
  return built.assumptions as DcfAssumptions;
}

function dcfValuation(over: Partial<Extract<ValuationResult, { kind: "dcf" }>> = {}): ValuationResult {
  const assumptions = builtAssumptions();
  const opts = { waccPct: 9, netDebt: -100, dilutedShares: 100 };
  return {
    kind: "dcf",
    route: "general",
    assumptions,
    dcf: runDcf(assumptions, opts),
    sensitivity: sensitivityGrid(assumptions, opts),
    reverseDcf: null,
    multiples: MULTIPLES,
    notes: [],
    gaps: [],
    ...over,
  };
}

describe("computeDcfDisplay — general DCF route", () => {
  it("builds deterministic assumption rows carrying the DcfAssumptions basis strings", () => {
    const valuation = dcfValuation();
    const a = (valuation as Extract<ValuationResult, { kind: "dcf" }>).assumptions!;
    const display = computeDcfDisplay(valuation);

    expect(display.assumptions.length).toBeGreaterThanOrEqual(6);
    const byName = new Map(display.assumptions.map((r) => [r.name.toLowerCase(), r]));
    // The rows cover the load-bearing DCF inputs, and carry the deterministic basis.
    const growth = [...byName.values()].find((r) => r.name.toLowerCase().includes("growth") && !r.name.toLowerCase().includes("terminal"))!;
    expect(growth).toBeDefined();
    expect(growth.basis).toBe(a.growthPath.basis);
    const s2c = [...byName.values()].find((r) => r.name.toLowerCase().includes("sales-to-capital"))!;
    expect(s2c.basis).toBe(a.salesToCapital.basis);
    const term = [...byName.values()].find((r) => r.name.toLowerCase().includes("terminal growth"))!;
    expect(term.basis).toBe(a.terminal.gTermPct.basis);
    // Every row is a plain {name, value, basis} string triple.
    for (const r of display.assumptions) {
      expect(typeof r.name).toBe("string");
      expect(typeof r.value).toBe("string");
      expect(typeof r.basis).toBe("string");
    }
  });

  it("flattens the deterministic sensitivity grid into cells matching the computed matrix", () => {
    const valuation = dcfValuation();
    const grid = (valuation as Extract<ValuationResult, { kind: "dcf" }>).sensitivity!;
    const display = computeDcfDisplay(valuation);
    expect(display.sensitivityGrid.length).toBe(grid.waccPcts.length * grid.gTermPcts.length);
    // Spot-check the corner cells map (waccPcts[i], gTermPcts[j], perShare[i][j]).
    const first = display.sensitivityGrid[0];
    expect(first.waccPct).toBe(grid.waccPcts[0]);
    expect(first.gTermPct).toBe(grid.gTermPcts[0]);
    expect(first.perShare).toBe(grid.perShare[0][0]);
  });
});

describe("computeDcfDisplay — no FCFF DCF for the route → empty (never fabricated)", () => {
  it("excess-return (bank/insurer) route → empty assumptions + grid", () => {
    const er = excessReturnModel({ bookValue: 1000, currentRoePct: 14, costOfEquityPct: 9, dilutedShares: 100 });
    const valuation: ValuationResult = { kind: "excess-return", route: "bank", excessReturn: er, multiples: MULTIPLES, notes: [], gaps: [] };
    const display = computeDcfDisplay(valuation);
    expect(display.assumptions).toEqual([]);
    expect(display.sensitivityGrid).toEqual([]);
  });

  it("REIT route → empty", () => {
    const reit = reitValuation({ ffoApprox: 300, affoApprox: 250, sharePrice: 40, shares: 100, netDebt: 500 });
    const valuation: ValuationResult = { kind: "reit", route: "reit", reit, multiples: MULTIPLES, notes: [], gaps: [] };
    const display = computeDcfDisplay(valuation);
    expect(display.assumptions).toEqual([]);
    expect(display.sensitivityGrid).toEqual([]);
  });

  it("pre-revenue route → empty", () => {
    const display = computeDcfDisplay({ kind: "pre-revenue", route: "general", multiples: null, notes: [], gaps: [] });
    expect(display.assumptions).toEqual([]);
    expect(display.sensitivityGrid).toEqual([]);
  });

  it("general route but DCF suppressed (null assumptions/sensitivity) → empty", () => {
    const display = computeDcfDisplay(dcfValuation({ assumptions: null, dcf: null, sensitivity: null }));
    expect(display.assumptions).toEqual([]);
    expect(display.sensitivityGrid).toEqual([]);
  });
});
