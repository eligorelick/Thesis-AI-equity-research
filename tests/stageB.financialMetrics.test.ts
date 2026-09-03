/**
 * WS5 (D-17) — route metrics for financial companies, and NAREIT FFO/AFFO.
 *
 * `BASE_POLICIES.lead` promised NIM, the efficiency ratio, the combined ratio,
 * book value per share, the net interest spread and leverage for a long time
 * while nothing computed any of them, so a bank report led with metrics it did
 * not have. These tests pin the two rules that make the computation honest:
 *
 *  - a named metric is computed only from the figures its definition calls for
 *    (NIM needs EARNING assets, not total assets), and
 *  - a stand-in is published under its own name, never the name it stands in
 *    for (tangible leverage is not CET1).
 *
 * Pure and offline — companyfacts payloads are built in the test.
 */

import { describe, expect, it } from "vitest";

import {
  computeFinancialMetrics,
  computeNareitFfo,
  type FinancialMetricsInputs,
  type RouteMetric,
} from "@/pipeline/stageB/financialMetrics";
import { RouteMetricsSchema } from "@/report/schema";
import type { CompanyFacts } from "@/edgar/xbrl";
import type { FetchResult } from "@/types/core";

interface Pt {
  end: string;
  val: number;
  start?: string;
}

const FY = { start: "2025-01-01", end: "2025-12-31" };

function facts(usGaap: Record<string, Pt[]>): CompanyFacts {
  const concept = (tag: string, points: Pt[]) => ({
    label: tag,
    units: {
      USD: points.map((p, i) => ({
        ...(p.start !== undefined ? { start: p.start } : {}),
        end: p.end,
        val: p.val,
        accn: `0000000000-26-${String(i).padStart(6, "0")}`,
        fy: Number(p.end.slice(0, 4)),
        fp: "FY",
        form: "10-K",
        filed: `${Number(p.end.slice(0, 4)) + 1}-02-15`,
      })),
    },
  });
  return {
    cik: 19617,
    entityName: "Test Financial",
    facts: {
      "us-gaap": Object.fromEntries(
        Object.entries(usGaap).map(([tag, points]) => [tag, concept(tag, points)]),
      ),
    },
  };
}

function okFacts(usGaap: Record<string, Pt[]>): FetchResult<CompanyFacts> {
  return {
    ok: true,
    value: {
      data: facts(usGaap),
      asOf: "2025-12-31",
      source: "edgar",
      endpoint: "xbrl/companyfacts",
      fetchedAt: "2026-07-06T00:00:00.000Z",
    },
  };
}

const factsGap: FetchResult<CompanyFacts> = {
  ok: false,
  gap: { field: "edgar.companyFacts(BNK)", reason: "companyfacts HTTP 503", severity: "warn" },
};

function find(metrics: RouteMetric[], key: string): RouteMetric {
  const m = metrics.find((x) => x.key === key);
  if (m === undefined) throw new Error(`metric ${key} not produced`);
  return m;
}

/** Balance/income rows shaped as Stage B already builds them (newest first). */
function bankInputs(over: Partial<FinancialMetricsInputs> = {}): FinancialMetricsInputs {
  return {
    companyFacts: okFacts({
      InterestIncomeExpenseNet: [{ ...FY, val: 60_000 }],
      NoninterestIncome: [{ ...FY, val: 53_000 }],
      NoninterestExpense: [{ ...FY, val: 67_800 }],
      Deposits: [
        { end: "2025-12-31", val: 2_000_000 },
        { end: "2024-12-31", val: 1_800_000 },
      ],
      InterestExpenseDeposits: [{ ...FY, val: 38_000 }],
      LoansAndLeasesReceivableNetReportedAmount: [{ end: "2025-12-31", val: 1_000_000 }],
      ProvisionForLoanLeaseAndOtherLosses: [{ ...FY, val: 5_600 }],
      FinancingReceivableExcludingAccruedInterestNonaccrualStatus: [{ end: "2025-12-31", val: 7_500 }],
    }),
    balance: [
      {
        date: "2025-12-31",
        totalAssets: 3_400_000,
        totalStockholdersEquity: 300_000,
        goodwill: 50_000,
        intangibleAssets: 10_000,
        preferredStock: 20_000,
      },
      { date: "2024-12-31", totalAssets: 3_200_000, totalStockholdersEquity: 290_000 },
    ],
    income: [{ date: "2025-12-31", revenue: 113_000, netIncome: 30_000 }],
    shares: 8_000,
    sharesBasis: "statements:income.weightedAverageShsOutDil",
    ...over,
  };
}

describe("bank route metrics", () => {
  it("computes the efficiency ratio from the noninterest split the filings carry", () => {
    const r = computeFinancialMetrics("bank", bankInputs());
    const eff = find(r.metrics, "efficiencyRatio");

    // 67,800 / (60,000 + 53,000) = 60.0%
    expect(eff.value).toBeCloseTo(60, 9);
    expect(eff.withheldReason).toBeNull();
    expect(eff.asOf).toBe("2025-12-31");
    expect(eff.sources).toContain("edgar:companyfacts us-gaap/NoninterestExpense");
    expect(eff.basis).toContain("noninterest expense 67800");
  });

  it("withholds NIM rather than dividing by total assets, and names the honest denominator separately", () => {
    // The defect this prevents: net interest income over TOTAL assets is not a
    // net interest margin — premises, goodwill and other non-earning assets sit
    // in the denominator, so the figure lands well below a real NIM. Publishing
    // it as "NIM" would misstate a named bank metric.
    const r = computeFinancialMetrics("bank", bankInputs());
    const nim = find(r.metrics, "nim");

    expect(nim.value).toBeNull();
    expect(nim.withheldReason).toContain("earning-assets element");
    expect(nim.withheldReason).toContain("understate the margin");

    const proxy = find(r.metrics, "niiToAverageAssets");
    // 60,000 / ((3,400,000 + 3,200,000)/2) = 1.8181...%
    expect(proxy.value).toBeCloseTo((60_000 / 3_300_000) * 100, 9);
    expect(proxy.proxy).toBe(true);
    expect(proxy.label).toBe("net interest income / average total assets");
    expect(proxy.basis).toContain("NOT the net interest margin");
  });

  it("computes a true NIM when the filer actually tags earning assets", () => {
    const r = computeFinancialMetrics(
      "bank",
      bankInputs({
        companyFacts: okFacts({
          InterestIncomeExpenseNet: [{ ...FY, val: 60_000 }],
          InterestEarningAssets: [
            { end: "2025-12-31", val: 2_000_000 },
            { end: "2024-12-31", val: 1_800_000 },
          ],
        }),
      }),
    );
    const nim = find(r.metrics, "nim");

    // 60,000 / ((2,000,000 + 1,800,000)/2) = 3.157894...%
    expect(nim.value).toBeCloseTo((60_000 / 1_900_000) * 100, 9);
    expect(nim.withheldReason).toBeNull();
    expect(nim.basis).toContain("average earning assets");
    // With a real NIM on file the proxy is not published at all.
    expect(r.metrics.some((m) => m.key === "niiToAverageAssets")).toBe(false);
  });

  it("labels the CET1 stand-in as leverage, never as a capital ratio", () => {
    const r = computeFinancialMetrics("bank", bankInputs());
    const cet1 = find(r.metrics, "cet1Reported");
    const proxy = find(r.metrics, "tangibleLeverage");

    expect(cet1.value).toBeNull();
    expect(cet1.withheldReason).toContain("no CET1 element");
    expect(cet1.withheldReason).toContain("NOT a substitute");

    // TCE = 300,000 − 50,000 − 10,000 − 20,000 = 220,000
    // tangible assets = 3,400,000 − 50,000 − 10,000 = 3,340,000
    expect(proxy.value).toBeCloseTo((220_000 / 3_340_000) * 100, 9);
    expect(proxy.proxy).toBe(true);
    expect(proxy.label).toBe("tangible common equity / tangible assets");
    expect(proxy.basis).toContain("does not risk-weight");
  });

  it("uses a reported CET1 when the filer tags one, normalising a filed fraction", () => {
    const asFraction = computeFinancialMetrics(
      "bank",
      bankInputs({
        companyFacts: okFacts({
          CommonEquityTierOneCapitalToRiskWeightedAssets: [{ end: "2025-12-31", val: 0.152 }],
        }),
      }),
    );
    const cet1 = find(asFraction.metrics, "cet1Reported");
    expect(cet1.value).toBeCloseTo(15.2, 9);
    expect(cet1.basis).toContain("filed as a fraction");
    // The proxy is not published beside a real CET1.
    expect(asFraction.metrics.some((m) => m.key === "tangibleLeverage")).toBe(false);

    const asPercent = computeFinancialMetrics(
      "bank",
      bankInputs({
        companyFacts: okFacts({
          CommonEquityTierOneCapitalToRiskWeightedAssets: [{ end: "2025-12-31", val: 15.2 }],
        }),
      }),
    );
    expect(find(asPercent.metrics, "cet1Reported").value).toBeCloseTo(15.2, 9);
  });

  it("computes the NPL ratio, provisions/loans and the deposit cost from tagged figures", () => {
    const r = computeFinancialMetrics("bank", bankInputs());

    // 7,500 / 1,000,000 = 0.75%
    expect(find(r.metrics, "nplRatio").value).toBeCloseTo(0.75, 9);
    // 5,600 / 1,000,000 = 0.56%
    expect(find(r.metrics, "provisionsToLoans").value).toBeCloseTo(0.56, 9);
    // 38,000 / ((2,000,000 + 1,800,000)/2) = 2.0%
    expect(find(r.metrics, "depositCost").value).toBeCloseTo(2, 9);
    expect(find(r.metrics, "depositCost").basis).toContain("average of the current and prior");
  });

  it("withholds every tag-dependent metric with its own reason when companyfacts are unavailable", () => {
    const r = computeFinancialMetrics("bank", bankInputs({ companyFacts: factsGap }));

    for (const key of ["nim", "efficiencyRatio", "nplRatio", "provisionsToLoans", "depositCost"]) {
      const m = find(r.metrics, key);
      expect(m.value, key).toBeNull();
      expect(m.withheldReason, key).not.toBeNull();
    }
    // Every withholding reaches the manifest...
    expect(r.gaps.some((g) => g.field === "financialMetrics.efficiencyRatio")).toBe(true);
    expect(r.gaps.every((g) => g.severity === "info")).toBe(true);
    // ...and the balance-sheet-only stand-in still computes, because it needs no tags.
    expect(find(r.metrics, "tangibleLeverage").value).not.toBeNull();
    expect(r.notes.some((n) => n.includes("companyfacts HTTP 503"))).toBe(true);
  });

  it("never throws on empty statements — it withholds", () => {
    const r = computeFinancialMetrics("bank", {
      companyFacts: null,
      balance: [],
      income: [],
    });

    expect(r.metrics.length).toBeGreaterThan(0);
    expect(r.metrics.every((m) => m.value === null)).toBe(true);
    expect(r.metrics.every((m) => m.withheldReason !== null)).toBe(true);
  });
});

describe("route metrics satisfy the report contract", () => {
  it("every computed and withheld metric parses against RouteMetricsSchema", () => {
    // The schema is what a report can carry; a metric shape Stage B produces
    // but the report cannot represent would be dropped silently at assembly.
    for (const route of ["bank", "insurer", "reit-mortgage"] as const) {
      const computed = computeFinancialMetrics(route, bankInputs());
      const parsed = RouteMetricsSchema.safeParse({
        route: computed.route,
        metrics: computed.metrics,
        notes: computed.notes,
        asOf: computed.asOf,
      });
      expect(parsed.success, `${route}: ${parsed.error?.message ?? ""}`).toBe(true);
    }

    // Including the all-withheld case, which is the one a degraded report hits.
    const bare = computeFinancialMetrics("bank", {
      companyFacts: null,
      balance: [],
      income: [],
    });
    expect(
      RouteMetricsSchema.safeParse({
        route: bare.route,
        metrics: bare.metrics,
        notes: bare.notes,
        asOf: bare.asOf,
      }).success,
    ).toBe(true);
  });
});

describe("insurer route metrics", () => {
  function insurerInputs(over: Partial<FinancialMetricsInputs> = {}): FinancialMetricsInputs {
    return {
      companyFacts: okFacts({
        PremiumsEarnedNet: [{ ...FY, val: 50_000 }],
        PolicyholderBenefitsAndClaimsIncurredNet: [{ ...FY, val: 32_000 }],
        OtherUnderwritingExpense: [{ ...FY, val: 9_000 }],
        DeferredPolicyAcquisitionCostAmortizationExpense: [{ ...FY, val: 5_000 }],
        LiabilityForUnpaidClaimsAndClaimsAdjustmentExpenseIncurredClaimsPriorYears: [
          { ...FY, val: -1_200 },
        ],
      }),
      balance: [{ date: "2025-12-31", totalAssets: 400_000, totalStockholdersEquity: 80_000 }],
      income: [{ date: "2025-12-31", revenue: 60_000, netIncome: 6_000 }],
      ...over,
    };
  }

  it("computes loss, expense and combined ratios, naming the GAAP earned-premium denominator", () => {
    const r = computeFinancialMetrics("insurer", insurerInputs());

    // loss 32,000/50,000 = 64%; expense (9,000+5,000)/50,000 = 28%; combined 92%
    expect(find(r.metrics, "lossRatio").value).toBeCloseTo(64, 9);
    expect(find(r.metrics, "expenseRatio").value).toBeCloseTo(28, 9);
    const combined = find(r.metrics, "combinedRatio");
    expect(combined.value).toBeCloseTo(92, 9);
    expect(combined.proxy).toBe(true);
    expect(combined.basis).toContain("company-reported combined ratio");
    expect(combined.basis).toContain("premiums WRITTEN");
  });

  it("withholds the combined ratio when either half is missing rather than reporting it partial", () => {
    // A combined ratio missing its expense half would read as if underwriting
    // cost 64% of premiums when the real figure is 92% — a materially
    // flattering error, so the metric is withheld outright.
    const r = computeFinancialMetrics(
      "insurer",
      insurerInputs({
        companyFacts: okFacts({
          PremiumsEarnedNet: [{ ...FY, val: 50_000 }],
          PolicyholderBenefitsAndClaimsIncurredNet: [{ ...FY, val: 32_000 }],
        }),
      }),
    );

    expect(find(r.metrics, "lossRatio").value).toBeCloseTo(64, 9);
    const combined = find(r.metrics, "combinedRatio");
    expect(combined.value).toBeNull();
    expect(combined.withheldReason).toContain("expense ratio");
    expect(combined.withheldReason).toContain("understate underwriting cost");
  });

  it("does not add commission and fee INCOME to underwriting expense", () => {
    // InsuranceCommissionsAndFees is a credit-balance revenue element. Summing
    // it into underwriting expense inflated both ratios: on these figures it
    // published a 37% expense ratio and a 97% combined ratio instead of 28% and
    // 92%. Tagging it must change nothing.
    const r = computeFinancialMetrics(
      "insurer",
      insurerInputs({
        companyFacts: okFacts({
          PremiumsEarnedNet: [{ ...FY, val: 50_000 }],
          PolicyholderBenefitsAndClaimsIncurredNet: [{ ...FY, val: 32_000 }],
          OtherUnderwritingExpense: [{ ...FY, val: 9_000 }],
          DeferredPolicyAcquisitionCostAmortizationExpense: [{ ...FY, val: 5_000 }],
          InsuranceCommissionsAndFees: [{ ...FY, val: 4_500 }],
        }),
      }),
    );

    const expense = find(r.metrics, "expenseRatio");
    expect(expense.value).toBeCloseTo(28, 9);
    expect(expense.basis).not.toContain("InsuranceCommissionsAndFees");
    expect(find(r.metrics, "combinedRatio").value).toBeCloseTo(92, 9);
  });

  it("withholds the expense ratio on a PARTIAL component sum, naming the missing component", () => {
    // With only the deferred-acquisition-cost amortisation tagged, the old
    // any-component-resolves rule published a 12% expense ratio and a 77%
    // combined ratio — an underwriter that does not exist.
    const r = computeFinancialMetrics(
      "insurer",
      insurerInputs({
        companyFacts: okFacts({
          PremiumsEarnedNet: [{ ...FY, val: 50_000 }],
          PolicyholderBenefitsAndClaimsIncurredNet: [{ ...FY, val: 32_000 }],
          DeferredPolicyAcquisitionCostAmortizationExpense: [{ ...FY, val: 6_000 }],
        }),
      }),
    );

    const expense = find(r.metrics, "expenseRatio");
    expect(expense.value).toBeNull();
    expect(expense.withheldReason).toContain("OtherUnderwritingExpense");
    expect(expense.withheldReason).toContain("PARTIAL component sum");
    // ...and the combined ratio follows it into the withheld column, never zero.
    const combined = find(r.metrics, "combinedRatio");
    expect(combined.value).toBeNull();
    expect(combined.withheldReason).toContain("expense ratio");
    expect(
      r.gaps.some((g) => g.field === "financialMetrics.expenseRatio"),
    ).toBe(true);
  });

  it("reports prior-year reserve development with its sign convention stated", () => {
    const development = find(computeFinancialMetrics("insurer", insurerInputs()).metrics, "reserveDevelopment");

    expect(development.value).toBe(-1_200);
    expect(development.basis).toContain("favourable release");
  });
});

describe("mortgage-REIT route metrics", () => {
  function mreitInputs(over: Partial<FinancialMetricsInputs> = {}): FinancialMetricsInputs {
    return {
      companyFacts: okFacts({
        InterestAndDividendIncomeOperating: [{ ...FY, val: 3_000 }],
        InterestExpense: [{ ...FY, val: 1_800 }],
        SecuritiesSoldUnderAgreementsToRepurchase: [{ end: "2025-12-31", val: 60_000 }],
      }),
      balance: [
        { date: "2025-12-31", totalAssets: 80_000, totalStockholdersEquity: 10_000, preferredStock: 1_000 },
        { date: "2024-12-31", totalAssets: 76_000, totalStockholdersEquity: 9_500 },
      ],
      income: [{ date: "2025-12-31", netIncome: 800 }],
      shares: 900,
      sharesBasis: "statements:income.weightedAverageShsOutDil",
      ...over,
    };
  }

  it("computes book value per share, leverage and the net interest spread over their own denominators", () => {
    const r = computeFinancialMetrics("reit-mortgage", mreitInputs());

    // (10,000 − 1,000) / 900 = 10.0
    expect(find(r.metrics, "bookValuePerShare").value).toBeCloseTo(10, 9);
    // 80,000 / 10,000 = 8.0x
    expect(find(r.metrics, "leverageAssetsToEquity").value).toBeCloseTo(8, 9);

    // yield 3,000/78,000 = 3.846...%; cost 1,800/60,000 = 3.0%; spread 0.846...pp
    const spread = find(r.metrics, "netInterestSpread");
    expect(spread.value).toBeCloseTo((3_000 / 78_000) * 100 - 3, 9);
    expect(spread.basis).toContain("unlike at a bank");
  });

  it("withholds the spread when a funding balance is missing rather than reporting one leg", () => {
    const r = computeFinancialMetrics(
      "reit-mortgage",
      mreitInputs({
        companyFacts: okFacts({
          InterestAndDividendIncomeOperating: [{ ...FY, val: 3_000 }],
          InterestExpense: [{ ...FY, val: 1_800 }],
        }),
      }),
    );
    const spread = find(r.metrics, "netInterestSpread");

    expect(spread.value).toBeNull();
    expect(spread.withheldReason).toContain("repurchase agreements");
    // The balance-sheet metrics are unaffected.
    expect(find(r.metrics, "bookValuePerShare").value).toBeCloseTo(10, 9);
  });
});

describe("computeNareitFfo — the NAREIT definition, and what stands in for it", () => {
  const REIT_FY = { start: "2025-01-01", end: "2025-12-31" };

  it("applies the definition exactly when real-estate depreciation, gains and impairments are tagged", () => {
    const r = computeNareitFfo({
      companyFacts: okFacts({
        NetIncomeLoss: [{ ...REIT_FY, val: 400 }],
        DepreciationAndAmortizationRealEstate: [{ ...REIT_FY, val: 900 }],
        GainLossOnSaleOfProperties: [{ ...REIT_FY, val: 120 }],
        ImpairmentOfRealEstate: [{ ...REIT_FY, val: 60 }],
        PaymentsForCapitalImprovements: [{ ...REIT_FY, val: 150 }],
        StraightLineRent: [{ ...REIT_FY, val: 40 }],
      }),
      periodEnd: "2025-12-31",
      netIncome: 400,
      depreciationAndAmortization: 950,
    });

    // 400 + 900 − 120 + 60 = 1,240
    expect(r.ffo).toBe(1_240);
    expect(r.ffoApproximate).toBe(false);
    expect(r.ffoBasis).toContain("gains on property sales 120");
    // AFFO = 1,240 − 150 − 40 = 1,050
    expect(r.affo).toBe(1_050);
    expect(r.affoApproximate).toBe(false);
    expect(r.gaps).toEqual([]);
  });

  it("labels FFO approximate when only total D&A is on file, and says which way it errs", () => {
    const r = computeNareitFfo({
      companyFacts: okFacts({
        NetIncomeLoss: [{ ...REIT_FY, val: 400 }],
        DepreciationDepletionAndAmortization: [{ ...REIT_FY, val: 950 }],
      }),
      periodEnd: "2025-12-31",
      netIncome: 400,
      depreciationAndAmortization: 950,
      capitalExpenditure: -200,
    });

    expect(r.ffo).toBe(1_350);
    expect(r.ffoApproximate).toBe(true);
    expect(r.ffoBasis).toContain("APPROXIMATE");
    expect(r.ffoBasis).toContain("at or above the definition");
    expect(r.gaps.some((g) => g.field === "valuation.reit.ffo.realEstateDepreciation")).toBe(true);
    // AFFO falls back to all-capex and is disclosed as a conservative floor.
    expect(r.affo).toBe(1_150);
    expect(r.affoApproximate).toBe(true);
    expect(r.affoBasis).toContain("conservative floor");
  });

  it("falls back to the statement rows when companyfacts are unavailable", () => {
    const r = computeNareitFfo({
      companyFacts: factsGap,
      periodEnd: "2025-12-31",
      netIncome: 400,
      depreciationAndAmortization: 950,
      capitalExpenditure: -200,
    });

    expect(r.ffo).toBe(1_350);
    expect(r.sources).toContain("statements:income.netIncome");
    expect(r.ffoApproximate).toBe(true);
  });

  it("withholds FFO rather than guessing when the depreciation add-back is missing entirely", () => {
    const r = computeNareitFfo({
      companyFacts: factsGap,
      periodEnd: "2025-12-31",
      netIncome: 400,
      depreciationAndAmortization: null,
    });

    expect(r.ffo).toBeNull();
    expect(r.affo).toBeNull();
    expect(r.gaps.some((g) => g.field === "valuation.reit.ffo" && g.severity === "warn")).toBe(true);
  });
});
