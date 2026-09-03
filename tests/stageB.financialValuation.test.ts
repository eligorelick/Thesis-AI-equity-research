/**
 * WS5 (D-17) — the equity model for financial routes, and the REIT valuation.
 *
 * The excess-return model already summed (ROE − CoE) x prior book equity over a
 * faded path; what a reader could not see was the model's shape — the horizon,
 * the fade and the discount rate were only inferable from one basis string —
 * or the pairing a financial is actually judged on, P/TBV against ROTE. Both
 * are now explicit. The justified multiple is a STABLE-GROWTH cross-check: it
 * assumes ROTE persists in perpetuity while the forward model fades ROE to the
 * cost of equity, so the two rest on different assumptions and can disagree —
 * and its growth rate obeys the same cap the DCF terminal value obeys.
 *
 * Pure and offline.
 */

import { describe, expect, it } from "vitest";

import {
  excessReturnModel,
  reitValuation,
  valueCompany,
  JUSTIFIED_PTBV_MIN_SPREAD_PP,
  type MultiplesFrameworkInputs,
} from "@/pipeline/stageB/valuation";
import type { CompanyRoute } from "@/types/core";

const BASE = {
  bookValue: 1_000,
  currentRoePct: 15,
  costOfEquityPct: 10,
  years: 10,
  payoutRatioPct: 50,
  dilutedShares: 100,
} as const;

describe("excessReturnModel — the model's shape is stated, not implied", () => {
  it("prints the horizon, the fade and the discount rate as assumptions in their own right", () => {
    const r = excessReturnModel(BASE);

    expect(r.horizonYears.value).toBe(10);
    expect(r.horizonYears.basis).toContain("explicit 10-year horizon");
    expect(r.horizonYears.basis).toContain("faded LINEARLY to the cost of equity");
    expect(r.horizonYears.basis).toContain("NO continuing value");

    expect(r.costOfEquityPct.value).toBe(10);
    expect(r.costOfEquityPct.basis).toContain("ONLY discount rate");
    // The reason a WACC is wrong here is stated, not assumed known.
    expect(r.costOfEquityPct.basis).toContain("raw material");

    expect(r.openingBookValue.value).toBe(1_000);
    expect(r.openingBookValue.basis).toContain("BV0");
  });

  it("keeps the horizon assumption on a suppressed model so the reader sees what was not built", () => {
    const r = excessReturnModel({ ...BASE, costOfEquityPct: null });

    expect(r.equityValue).toBeNull();
    expect(r.horizonYears.value).toBe(10);
    expect(r.horizonYears.basis).toContain("model not built");
    expect(r.costOfEquityPct.value).toBeNull();
    expect(r.costOfEquityPct.basis).toContain("suppressed rather than discounting at a defaulted rate");
  });

  it("computes the equity value from the stated inputs (arithmetic pinned by hand)", () => {
    // Two-year horizon so the sum is checkable: fadePath(15, 10, 2) = [15, 10].
    //   Y1 excess (0.15 − 0.10) x 1000 = 50; PV 50/1.1 = 45.4545...
    //   BV1 = 1000 x (1 + 0.15 x 0.5) = 1075
    //   Y2 excess (0.10 − 0.10) x 1075 = 0
    //   value = 1000 + 45.4545... = 1045.4545...
    const r = excessReturnModel({ ...BASE, years: 2 });

    expect(r.equityValue).toBeCloseTo(1_045.4545454545455, 6);
    expect(r.bookValuePath).toEqual([1_000, 1_075, 1_128.75]);
    expect(r.terminalExcess).toBe(0);
  });
});

describe("excessReturnModel — P/TBV against ROTE", () => {
  it("divides market cap by TANGIBLE common equity and pairs it with ROTE", () => {
    const r = excessReturnModel({
      ...BASE,
      marketCap: 1_800,
      tangibleCommonEquity: 900,
      rotePct: 16,
    });
    const p = r.priceToTangibleBookVsRote;

    // 1,800 / 900 = 2.0x against ROTE 16%.
    expect(p.pTbv).toBeCloseTo(2, 9);
    expect(p.rotePct).toBe(16);
    // g = ROTE 16% x retention 50% = 8%, CAPPED at the 2.5% terminal-growth
    // ceiling (no risk-free rate supplied); justified = (16 − 2.5)/(10 − 2.5)
    // = 1.80x. Uncapped this read 4.00x against a forward-model equity value of
    // 1.26x tangible book — a multiple the model on the same page contradicts.
    expect(p.justifiedPTbv).toBeCloseTo(1.8, 9);
    expect(p.premiumToJustified).toBeCloseTo(0.2, 9);
    expect(p.withheldReason).toBeNull();
    expect(p.basis).toContain("Justified P/TBV");
  });

  it("caps the sustainable growth rate at the risk-free rate, as the DCF terminal value does", () => {
    const r = excessReturnModel({
      ...BASE,
      marketCap: 1_800,
      tangibleCommonEquity: 900,
      rotePct: 16,
      riskFreePct: 2,
    });
    const p = r.priceToTangibleBookVsRote;

    // g = min(ROTE 16% x retention 50% = 8%, cap 2.5%, risk-free 2%) = 2%;
    // justified = (16 − 2)/(10 − 2) = 1.75x.
    expect(p.justifiedPTbv).toBeCloseTo(1.75, 9);
    expect(p.basis).toContain("risk-free 2%");
    expect(p.basis).toContain("nothing grows faster than rf forever");
    expect(p.basis).toContain("capped");
  });

  it("does not claim the stable-growth cross-check and the fading forward model must agree", () => {
    // The basis used to assert they use "the same residual-income identity the
    // forward model assumes, so the two readings cannot disagree". They do not:
    // the forward model fades ROE to the cost of equity over ten years and adds
    // no continuing value, while this identity assumes ROTE in perpetuity.
    const r = excessReturnModel({
      ...BASE,
      marketCap: 1_800,
      tangibleCommonEquity: 900,
      rotePct: 16,
    });
    const p = r.priceToTangibleBookVsRote;

    expect(p.basis).not.toContain("cannot disagree");
    expect(p.basis).toContain("STABLE-GROWTH cross-check");
    expect(p.basis).toContain("can disagree");
  });

  it("keeps a well-earning regional bank's justified multiple in the same world as its fair value", () => {
    // The reviewer's worked case: ROTE 14%, CoE 10%, payout 33%. Uncapped,
    // g = 9.38% gave a justified 7.45x, so a bank at 1.5x tangible book printed
    // a premium of −5.95x while the pipeline's own excess-return fair value said
    // it was roughly fairly priced.
    const r = excessReturnModel({
      ...BASE,
      currentRoePct: 14,
      payoutRatioPct: 33,
      marketCap: 1_350,
      tangibleCommonEquity: 900,
      rotePct: 14,
    });
    const p = r.priceToTangibleBookVsRote;

    expect(p.pTbv).toBeCloseTo(1.5, 9);
    // g capped at 2.5%; justified = (14 − 2.5)/(10 − 2.5) = 1.5333x.
    expect(p.justifiedPTbv).toBeCloseTo(11.5 / 7.5, 9);
    expect(p.premiumToJustified).toBeCloseTo(1.5 - 11.5 / 7.5, 9);
    expect(Math.abs(p.premiumToJustified as number)).toBeLessThan(0.1);
  });

  it("refuses plain book equity as a stand-in for the tangible base", () => {
    // A goodwill-heavy acquirer at 1.0x BOOK can be at 2.0x TANGIBLE book, and
    // ROTE is computed on the tangible base — pairing the two denominators
    // would flatter exactly the balance sheets this metric exists to police.
    const r = excessReturnModel({ ...BASE, marketCap: 1_800, rotePct: 16 });
    const p = r.priceToTangibleBookVsRote;

    expect(p.pTbv).toBeNull();
    expect(p.withheldReason).toContain("tangible common equity unavailable");
    expect(p.withheldReason).toContain("flatter a goodwill-heavy balance sheet");
    expect(
      r.gaps.some((g) => g.field === "valuation.excessReturn.priceToTangibleBook"),
    ).toBe(true);
  });

  it("withholds the justified multiple when growth approaches the cost of equity", () => {
    // g = min(ROTE 5% x retention 50% = 2.5%, the 2.5% cap) = 2.5%, only 0.3pp
    // below CoE 2.8% — the ratio (ROTE − g)/(CoE − g) diverges through infinity
    // here, so any number it produced would be an artefact of the arithmetic.
    // (Before g was capped, an ordinary 19% ROTE reached this guard; now only a
    // cost of equity below the terminal-growth ceiling can.)
    const r = excessReturnModel({
      ...BASE,
      currentRoePct: 5,
      costOfEquityPct: 2.8,
      marketCap: 1_800,
      tangibleCommonEquity: 900,
      rotePct: 5,
    });
    const p = r.priceToTangibleBookVsRote;

    expect(p.pTbv).toBeCloseTo(2, 9);
    expect(p.justifiedPTbv).toBeNull();
    expect(p.withheldReason).toContain("diverges");
    expect(JUSTIFIED_PTBV_MIN_SPREAD_PP).toBe(0.5);
  });

  it("shows the multiple without the justified figure when ROTE is unavailable", () => {
    const r = excessReturnModel({ ...BASE, marketCap: 1_800, tangibleCommonEquity: 900 });
    const p = r.priceToTangibleBookVsRote;

    expect(p.pTbv).toBeCloseTo(2, 9);
    expect(p.justifiedPTbv).toBeNull();
    expect(p.withheldReason).toContain("return on tangible common equity");
  });
});

describe("reitValuation — the basis it prints is the basis it used", () => {
  const BASE_REIT = {
    ffoApprox: 400,
    affoApprox: 300,
    sharePrice: 50,
    shares: 100,
    netDebt: 2_000,
    noiApprox: 500,
  };

  it("prints the supplied NAREIT basis instead of the old fixed disclaimer", () => {
    const r = reitValuation({
      ...BASE_REIT,
      ffoBasis: "FFO (NAREIT) = net income 400 + real-estate depreciation and amortization 900 − gains on property sales 120 + impairments 60 = 1240.",
      affoBasis: "AFFO = FFO 1240 − recurring capital expenditure 150 − straight-line rent 40 = 1050.",
      ffoApproximate: false,
    });

    expect(r.pToFfo).toBeCloseTo(5_000 / 400, 9);
    expect(r.notes[0]).toContain("FFO (NAREIT)");
    expect(r.notes.join(" ")).toContain("recurring capital expenditure");
    // The old unconditional "gains ... not netted" claim is gone when they WERE netted.
    expect(r.notes.join(" ")).not.toContain("FMP lacks the lines");
    expect(r.withheldReason).toBeNull();
  });

  it("labels an approximate FFO and says which way it errs", () => {
    const r = reitValuation({ ...BASE_REIT, ffoApproximate: true });

    expect(r.notes.join(" ")).toContain("labeled APPROXIMATE");
    expect(r.notes.join(" ")).toContain("at or above the NAREIT definition");
  });

  it("withholds every FFO-based figure when the REIT sub-map is undetermined", () => {
    // P/FFO on a mortgage REIT is meaningless, and SIC 6798 alone cannot say
    // which type this is — so publishing it would assert a business model.
    const r = reitValuation({
      ...BASE_REIT,
      submap: "undetermined",
      submapReason: "SIC 6798 covers both equity and mortgage REITs and companyfacts were unavailable",
    });

    expect(r.pToFfo).toBeNull();
    expect(r.pToAffo).toBeNull();
    expect(r.ffoPerShare).toBeNull();
    expect(r.affoPerShare).toBeNull();
    expect(r.impliedCapRatePct).toBeNull();
    expect(r.withheldReason).toContain("SIC 6798");
    const gap = r.gaps.find((g) => g.field === "valuation.reit.submap");
    expect(gap?.severity).toBe("warn");
    expect(r.notes.join(" ")).toContain("presumes an equity REIT");
  });

  it("computes normally once the sub-map is resolved", () => {
    const r = reitValuation({ ...BASE_REIT, submap: "equity" });

    expect(r.pToFfo).toBeCloseTo(12.5, 9);
    expect(r.withheldReason).toBeNull();
  });
});

describe("valueCompany — financial routes state every withheld model", () => {
  const route = (base: CompanyRoute["base"]): CompanyRoute => ({
    base,
    overlays: [],
    evidence: { sector: null, industry: null },
  });

  const multiples: MultiplesFrameworkInputs = {
    quote: { price: 100, marketCap: 10_000, currency: "USD" },
    reportedCurrency: "USD",
    incomeTtm: {
      date: "2025-12-31",
      revenue: 1_000,
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

  it("withholds the FCFF DCF, the reverse DCF, EV/EBITDA and ROIC−WACC with a reason each", () => {
    for (const base of ["bank", "insurer", "reit-mortgage"] as const) {
      const r = valueCompany(route(base), {
        currentPrice: 100,
        waccPct: 9,
        netDebt: 200,
        dilutedShares: 100,
        dcfInputs: null,
        multiples,
        excessReturn: { ...BASE },
        reit: null,
      });

      expect(r.kind, base).toBe("excess-return");
      for (const field of [
        "valuation.dcf",
        "valuation.reverseDcf",
        "valuation.evEbitda",
        "returns.roicVsWacc",
      ]) {
        const gap = r.gaps.find((g) => g.field === field);
        expect(gap, `${base}/${field}`).toBeDefined();
        // A reason, not a bare "unavailable".
        expect(gap?.reason.length ?? 0, `${base}/${field}`).toBeGreaterThan(60);
        expect(gap?.reason, `${base}/${field}`).toContain(base);
      }
    }
  });

  it("withholds the net-income DCF on the equity-REIT route with the depreciation reason", () => {
    const r = valueCompany(route("reit"), {
      currentPrice: 100,
      waccPct: 9,
      netDebt: 200,
      dilutedShares: 100,
      dcfInputs: null,
      multiples,
      excessReturn: null,
      reit: {
        ffoApprox: 400,
        affoApprox: 300,
        sharePrice: 50,
        shares: 100,
        netDebt: 2_000,
      },
    });

    expect(r.kind).toBe("reit");
    const gap = r.gaps.find((g) => g.field === "valuation.netIncomeDcf");
    expect(gap?.reason).toContain("real-estate depreciation");
    expect(gap?.reason).toContain("NAREIT");
  });
});
