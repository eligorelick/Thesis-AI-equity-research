import { describe, expect, it } from "vitest";

import { computeRote, tangibleCommonEquity } from "@/pipeline/stageB/returns";
import { metricPolicy } from "@/pipeline/stageB/sectorRouting";
import type { CompanyRoute } from "@/types/core";

/**
 * Return on tangible common equity — the capital-return measure for
 * deposit-funded balance sheets.
 *
 * The bank route already DECLARED it leads with "rote" and "tangibleCommonEquity"
 * and computed neither, so financial moat was scored on ROIC. ROIC's invested
 * capital is `debt + equity − cash`, and for a bank debt IS the raw material
 * while cash is an earning asset, so the denominator is meaningless — and
 * frequently non-positive, which made the metric vanish outright.
 */
const income = (netIncome: number, date = "2025-12-31", preferredDividendsPaid: number | null = -4) => ({
  date,
  preferredDividendsPaid,
  revenue: 1000,
  operatingIncome: 300,
  ebit: 300,
  incomeBeforeTax: 280,
  incomeTaxExpense: 60,
  netIncome,
});

const balance = (over: Record<string, unknown> = {}, date = "2025-12-31") => ({
  date,
  totalDebt: 200,
  totalStockholdersEquity: 1000,
  cashAndCashEquivalents: 50,
  totalAssets: 12_000,
  goodwill: 100,
  intangibleAssets: 50,
  preferredStock: 25,
  ...over,
});

describe("tangibleCommonEquity", () => {
  it("removes goodwill, other intangibles and preferred from common equity", () => {
    // 1000 − 100 − 50 − 25 = 825. Goodwill and intangibles absorb losses only
    // after common equity is gone; preferred ranks ahead of common.
    expect(tangibleCommonEquity(balance())).toBe(825);
  });

  it("treats undisclosed components as zero, not as unknown", () => {
    expect(
      tangibleCommonEquity({ date: "2025-12-31", totalStockholdersEquity: 1000 }),
    ).toBe(1000);
  });

  it("is null without total equity", () => {
    expect(tangibleCommonEquity({ date: "2025-12-31" })).toBeNull();
  });
});

describe("computeRote", () => {
  it("divides net income by AVERAGE tangible common equity", () => {
    const r = computeRote(
      [income(100), income(90, "2024-12-31")],
      [balance(), balance({ totalStockholdersEquity: 900 }, "2024-12-31")],
    );

    // TCE now 825, prior 725 ⇒ average 775. Net income available to COMMON is
    // 100 − 4 of preferred dividends = 96; 96 / 775 = 12.387…%.
    expect(r.latestRotePct).toBeCloseTo((96 / 775) * 100, 9);
    expect(r.latestTangibleCommonEquity).toBe(825);
    expect(r.asOf).toBe("2025-12-31");
  });

  it("falls back to the single period when there is no prior balance", () => {
    const r = computeRote([income(100)], [balance()]);

    expect(r.latestRotePct).toBeCloseTo((96 / 825) * 100, 9);
  });

  it("refuses a non-positive tangible base rather than returning a sign-flipped ratio", () => {
    // Goodwill and intangibles exceed common equity — the ratio is not merely
    // negative, it is meaningless, the same category error ROIC's guard refuses.
    const r = computeRote(
      [income(100)],
      [balance({ goodwill: 900, intangibleAssets: 200 })],
    );

    expect(r.latestRotePct).toBeNull();
    expect(r.notes.join(" ")).toMatch(/non-positive/i);
  });

  it("reports a warn gap when no year is computable", () => {
    const r = computeRote([income(100)], [balance({ totalStockholdersEquity: null })]);

    expect(r.latestRotePct).toBeNull();
    expect(r.gaps.some((g) => g.field === "returns.rote" && g.severity === "warn")).toBe(true);
  });

  it("returns the series oldest → newest, matching the ROIC convention", () => {
    const r = computeRote(
      [income(100), income(90, "2024-12-31"), income(80, "2023-12-31")],
      [balance(), balance({}, "2024-12-31"), balance({}, "2023-12-31")],
    );

    expect(r.series.map((y) => y.date)).toEqual(["2023-12-31", "2024-12-31", "2025-12-31"]);
  });
});

describe("exactly one capital-return measure is scored per route", () => {
  const route = (base: CompanyRoute["base"], sector: string | null = null): CompanyRoute => ({
    base,
    overlays: [],
    evidence: { sector, industry: null },
  });

  it("financial routes suppress ROIC and score ROTE", () => {
    for (const base of ["bank", "insurer", "reit-mortgage"] as const) {
      const { suppress } = metricPolicy(route(base));
      expect(suppress).toContain("roic");
      expect(suppress).toContain("roicVsWacc");
      expect(suppress).not.toContain("rote");
    }
  });

  it("a FIN-OTHER issuer KEEPS ROIC — the returns switch is narrower than the forensic one", () => {
    // Asset managers, exchanges and insurance brokers are fee-based: they have
    // ordinary invested capital, so ROIC is meaningful, and they often have no
    // tangible-equity base worth speaking of, so ROTE is uncomputable. Routing
    // them through the financial branch stripped ROIC and gave nothing back,
    // leaving moat scored on gross margin alone.
    const { suppress } = metricPolicy(route("general", "Financial Services"));

    expect(suppress).not.toContain("roic");
    expect(suppress).toContain("rote");
    // The FORENSIC suppression still applies to them — the two switches are
    // deliberately different.
    for (const signal of ["altmanZ", "beneishM", "accrualsRatio"]) {
      expect(suppress).toContain(signal);
    }
  });

  it("non-financial routes suppress ROTE and keep ROIC", () => {
    const { suppress } = metricPolicy(route("general", "Technology"));

    expect(suppress).toContain("rote");
    expect(suppress).not.toContain("roic");
  });
});

describe("ROTE nets preferred earnings out of the common return", () => {
  it("withholds ROTE when preferred is outstanding but its dividend is unavailable", () => {
    // The denominator already excludes preferred; crediting preferred earnings
    // to common would overstate ROTE for exactly the issuers this metric serves.
    const r = computeRote([income(100, "2025-12-31", null)], [balance()]);

    expect(r.latestRotePct).toBeNull();
    expect(r.notes.join(" ")).toMatch(/preferred/i);
  });

  it("uses total net income when there is no preferred outstanding", () => {
    const r = computeRote(
      [income(100, "2025-12-31", null)],
      [balance({ preferredStock: 0 })],
    );

    // TCE = 1000 − 100 − 50 − 0 = 850.
    expect(r.latestRotePct).toBeCloseTo((100 / 850) * 100, 9);
  });

  it("pairs income to balance by DATE, not by array position", () => {
    // Balance rows in a different order and with an extra year: positional
    // pairing would divide 2025 income by a 2023 equity base.
    const r = computeRote(
      [income(100, "2025-12-31"), income(90, "2024-12-31")],
      [
        balance({}, "2023-12-31"),
        balance({ totalStockholdersEquity: 900 }, "2024-12-31"),
        balance({}, "2025-12-31"),
      ],
    );

    expect(r.asOf).toBe("2025-12-31");
    expect(r.latestRotePct).toBeCloseTo((96 / 775) * 100, 9);
  });
});
