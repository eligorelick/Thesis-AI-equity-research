/**
 * Stage B — deterministic intrinsic per-share fair value (fairValue.ts).
 *
 * The report's valuation.dcf.perShare + upsidePct were LLM/judge-authored. This
 * resolves the route-appropriate DETERMINISTIC intrinsic per-share (FCFF DCF for
 * the general route; the book-value excess-return model for banks/insurers) and
 * its upside vs the current price, or SUPPRESSES it (never fabricates) when no
 * per-share model applies (REIT / pre-revenue / suppressed) or inputs are missing.
 * computed-derived provenance, not factual verification.
 */

import { describe, expect, it } from "vitest";

import {
  computeFairValue,
  FAIR_VALUE_METHOD_VERSION,
  type FairValueInputs,
} from "@/pipeline/stageB/fairValue";
import {
  buildDcfAssumptions,
  runDcf,
  excessReturnModel,
  reitValuation,
  type DcfAssumptions,
  type DcfResult,
  type ValuationResult,
} from "@/pipeline/stageB/valuation";

/* ------------------------------------------------------------------------ */

function buildDcf(): { assumptions: DcfAssumptions; dcf: DcfResult } {
  const built = buildDcfAssumptions({
    revenueCagr3yPct: 12,
    revenueCagr5yPct: 12,
    analystEstimates: null,
    waccPct: 9,
    riskFreePct: 4,
    incomeTtm: { date: "2025-12-31", revenue: 1000, operatingIncome: 300, incomeBeforeTax: 280, incomeTaxExpense: 60 },
    incomeHistory: [
      { date: "2023-12-31", revenue: 850, operatingIncome: 251, incomeBeforeTax: 231, incomeTaxExpense: 48 },
      { date: "2024-12-31", revenue: 920, operatingIncome: 276, incomeBeforeTax: 256, incomeTaxExpense: 54 },
      { date: "2025-12-31", revenue: 1000, operatingIncome: 300, incomeBeforeTax: 280, incomeTaxExpense: 60 },
    ],
    balance: { date: "2025-12-31", totalDebt: 200, totalStockholdersEquity: 800, cashAndShortTermInvestments: 300 },
    marketCap: 5000,
  });
  const assumptions = built.assumptions as DcfAssumptions;
  const dcf = runDcf(assumptions, { waccPct: 9, netDebt: -100, dilutedShares: 100 });
  return { assumptions, dcf };
}

const MULTIPLES = { multiples: [], sectorAppropriate: [], asOf: { quote: null, statements: null }, notes: [], gaps: [] };

function dcfValuation(over: Partial<Extract<ValuationResult, { kind: "dcf" }>> = {}): ValuationResult {
  const { assumptions, dcf } = buildDcf();
  return { kind: "dcf", route: "general", assumptions, dcf, sensitivity: null, reverseDcf: null, multiples: MULTIPLES, notes: [], gaps: [], ...over };
}

function excessReturnValuation(): ValuationResult {
  const er = excessReturnModel({
    bookValue: 1000,
    currentRoePct: 14,
    costOfEquityPct: 9,
    payoutRatioPct: 40,
    dilutedShares: 100,
    asOf: "2025-12-31",
  });
  expect(er.perShare).not.toBeNull();
  return { kind: "excess-return", route: "bank", excessReturn: er, multiples: MULTIPLES, notes: [], gaps: [] };
}

function reitValuationResult(): ValuationResult {
  const reit = reitValuation({ ffoApprox: 300, affoApprox: 250, sharePrice: 40, shares: 100, netDebt: 500 });
  return { kind: "reit", route: "reit", reit, multiples: MULTIPLES, notes: [], gaps: [] };
}

function makeInputs(over: Partial<FairValueInputs> = {}): FairValueInputs {
  return { valuation: dcfValuation(), currentPrice: 100, currency: "USD", asOf: "2026-07-06", ...over };
}

/* ------------------------------------------------------------------------ */

describe("fairValue — available", () => {
  it("general DCF route: perShare IS the deterministic DCF fair value, labeled fcff-dcf / computed-derived", () => {
    const inputs = makeInputs();
    const dcfPerShare = (inputs.valuation as Extract<ValuationResult, { kind: "dcf" }>).dcf!.perShare!;
    const r = computeFairValue(inputs);
    expect(r.status).toBe("available");
    expect(r.method).toBe("fcff-dcf");
    expect(r.methodVersion).toBe(FAIR_VALUE_METHOD_VERSION);
    expect(r.perShare).not.toBeNull();
    expect(r.perShare!.value).toBeCloseTo(Math.round(dcfPerShare * 100) / 100, 6);
    expect(r.perShare!.source).toBe("computed.valuation.dcf.perShare");
    expect(r.perShare!.unit).toBe("USD/share");
    expect(r.perShare!.verified).toBe(true); // computed provenance, NOT a correctness claim
  });

  it("computes upside vs the current price; null (not 0) when price missing", () => {
    const r = computeFairValue(makeInputs({ currentPrice: 100 }));
    expect(r.upsidePct).toBeCloseTo((r.perShare!.value / 100 - 1) * 100, 4);
    const noPrice = computeFairValue(makeInputs({ currentPrice: null }));
    expect(noPrice.upsidePct).toBeNull();
    expect(noPrice.status).toBe("available"); // per-share still computed
  });

  it("bank/insurer route: uses the deterministic excess-return per-share, labeled excess-return", () => {
    const inputs = makeInputs({ valuation: excessReturnValuation() });
    const erPerShare = (inputs.valuation as Extract<ValuationResult, { kind: "excess-return" }>).excessReturn.perShare!;
    const r = computeFairValue(inputs);
    expect(r.status).toBe("available");
    expect(r.method).toBe("excess-return");
    expect(r.perShare!.value).toBeCloseTo(Math.round(erPerShare * 100) / 100, 6);
    expect(r.perShare!.source).toBe("computed.valuation.excessReturn.perShare");
  });
});

describe("fairValue — suppressed (never fabricate)", () => {
  it("REIT route has no intrinsic per-share model → suppressed", () => {
    const r = computeFairValue(makeInputs({ valuation: reitValuationResult() }));
    expect(r.status).toBe("suppressed");
    expect(r.perShare).toBeNull();
    expect(r.upsidePct).toBeNull();
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("pre-revenue route → suppressed", () => {
    const r = computeFairValue(makeInputs({ valuation: { kind: "pre-revenue", route: "general", multiples: null, notes: [], gaps: [] } }));
    expect(r.status).toBe("suppressed");
    expect(r.perShare).toBeNull();
  });

  it("DCF route with a null per-share (net debt / shares / currency suppressed the bridge) → suppressed", () => {
    const noBridge = dcfValuation({ dcf: { ...buildDcf().dcf, perShare: null, equityValue: null } });
    const r = computeFairValue(makeInputs({ valuation: noBridge }));
    expect(r.status).toBe("suppressed");
    expect(r.perShare).toBeNull();
  });
});
