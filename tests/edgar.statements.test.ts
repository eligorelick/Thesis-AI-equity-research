import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { buildStatementsFromCompanyFacts } from "@/edgar/statements";
import type { CompanyFacts } from "@/edgar/xbrl";

interface Pt { start?: string; end: string; val: number; form?: string; fy?: number; fp?: string; filed?: string; accn?: string }

/** Build a companyfacts payload from `{ tag: [points] }` (unit USD unless the tag says otherwise). */
function facts(usGaap: Record<string, Pt[]>, dei: Record<string, Pt[]> = {}, units: Record<string, string> = {}): CompanyFacts {
  const toConcept = (tag: string, points: Pt[]) => ({
    label: tag,
    units: {
      [units[tag] ?? (tag.startsWith("EarningsPerShare") ? "USD/shares" : /Shares/.test(tag) ? "shares" : "USD")]: points.map((p, i) => ({
        start: p.start,
        end: p.end,
        val: p.val,
        accn: p.accn ?? `0000000000-26-${String(i).padStart(6, "0")}`,
        fy: p.fy ?? Number(p.end.slice(0, 4)),
        fp: p.fp ?? (p.start === undefined || dur(p) > 300 ? "FY" : "Q1"),
        form: p.form ?? (p.start === undefined || dur(p) > 300 ? "10-K" : "10-Q"),
        filed: p.filed ?? `${Number(p.end.slice(0, 4)) + (p.end >= `${p.end.slice(0, 4)}-10` ? 1 : 0)}-02-01`,
      })),
    },
  });
  return {
    cik: 320193,
    entityName: "Test Corp",
    facts: {
      "us-gaap": Object.fromEntries(Object.entries(usGaap).map(([t, p]) => [t, toConcept(t, p)])),
      dei: Object.fromEntries(Object.entries(dei).map(([t, p]) => [t, toConcept(t, p)])),
    },
  };
}
const dur = (p: Pt) => (p.start ? (Date.parse(p.end) - Date.parse(p.start)) / 86_400_000 : 0);

/** A September fiscal year like Apple's: FY2025 = 2024-09-29..2025-09-27, three 10-Qs with 3-month + YTD income and YTD-only cash flow. */
function appleLike(): CompanyFacts {
  const fyStart = "2024-09-29";
  const fyEnd = "2025-09-27";
  const q1 = "2024-12-28";
  const q2 = "2025-03-29";
  const q3 = "2025-06-28";
  return facts(
    {
      RevenueFromContractWithCustomerExcludingAssessedTax: [
        { start: fyStart, end: fyEnd, val: 400, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" },
        { start: fyStart, end: q1, val: 120, form: "10-Q", fp: "Q1", fy: 2025, filed: "2025-01-31" },
        { start: fyStart, end: q2, val: 210, form: "10-Q", fp: "Q2", fy: 2025, filed: "2025-05-02" },
        { start: "2024-12-29", end: q2, val: 90, form: "10-Q", fp: "Q2", fy: 2025, filed: "2025-05-02" },
        { start: fyStart, end: q3, val: 300, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
        { start: "2025-03-30", end: q3, val: 90, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
        // prior year, for the annual list
        { start: "2023-10-01", end: "2024-09-28", val: 380, form: "10-K", fp: "FY", fy: 2024, filed: "2024-11-01" },
      ],
      NetIncomeLoss: [
        { start: fyStart, end: fyEnd, val: 100, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" },
        { start: fyStart, end: q1, val: 30, form: "10-Q", fp: "Q1", fy: 2025, filed: "2025-01-31" },
        { start: fyStart, end: q2, val: 55, form: "10-Q", fp: "Q2", fy: 2025, filed: "2025-05-02" },
        { start: "2024-12-29", end: q2, val: 25, form: "10-Q", fp: "Q2", fy: 2025, filed: "2025-05-02" },
        { start: fyStart, end: q3, val: 78, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
        { start: "2025-03-30", end: q3, val: 23, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
        { start: "2023-10-01", end: "2024-09-28", val: 90, form: "10-K", fp: "FY", fy: 2024, filed: "2024-11-01" },
      ],
      CostOfRevenue: [{ start: fyStart, end: fyEnd, val: 220, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      OperatingIncomeLoss: [{ start: fyStart, end: fyEnd, val: 130, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      DepreciationDepletionAndAmortization: [{ start: fyStart, end: fyEnd, val: 12, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      InterestExpense: [{ start: fyStart, end: fyEnd, val: 4, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest: [{ start: fyStart, end: fyEnd, val: 128, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      EarningsPerShareDiluted: [
        { start: fyStart, end: fyEnd, val: 7.5, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" },
        { start: fyStart, end: q1, val: 2.3, form: "10-Q", fp: "Q1", fy: 2025, filed: "2025-01-31" },
        { start: fyStart, end: q3, val: 5.9, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
        { start: "2025-03-30", end: q3, val: 1.7, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
      ],
      WeightedAverageNumberOfDilutedSharesOutstanding: [
        { start: fyStart, end: fyEnd, val: 15_000, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" },
        { start: "2025-03-30", end: q3, val: 14_900, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
      ],
      Assets: [
        { end: fyEnd, val: 360, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" },
        { end: q1, val: 340, form: "10-Q", fp: "Q1", fy: 2025, filed: "2025-01-31" },
        { end: q2, val: 345, form: "10-Q", fp: "Q2", fy: 2025, filed: "2025-05-02" },
        { end: q3, val: 350, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
        { end: "2024-09-28", val: 365, form: "10-K", fp: "FY", fy: 2024, filed: "2024-11-01" },
      ],
      StockholdersEquity: [{ end: fyEnd, val: 65, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      Liabilities: [{ end: fyEnd, val: 295, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      CashAndCashEquivalentsAtCarryingValue: [{ end: fyEnd, val: 30, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      ShortTermInvestments: [{ end: fyEnd, val: 25, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      LongTermDebtNoncurrent: [{ end: fyEnd, val: 80, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      LongTermDebtCurrent: [{ end: fyEnd, val: 10, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      CommercialPaper: [{ end: fyEnd, val: 5, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      NetCashProvidedByUsedInOperatingActivities: [
        { start: fyStart, end: fyEnd, val: 110, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" },
        { start: fyStart, end: q1, val: 50, form: "10-Q", fp: "Q1", fy: 2025, filed: "2025-01-31" },
        { start: fyStart, end: q2, val: 80, form: "10-Q", fp: "Q2", fy: 2025, filed: "2025-05-02" },
        { start: fyStart, end: q3, val: 95, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
      ],
      PaymentsToAcquirePropertyPlantAndEquipment: [
        { start: fyStart, end: fyEnd, val: 12, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" },
        { start: fyStart, end: q1, val: 2, form: "10-Q", fp: "Q1", fy: 2025, filed: "2025-01-31" },
        { start: fyStart, end: q2, val: 5, form: "10-Q", fp: "Q2", fy: 2025, filed: "2025-05-02" },
        { start: fyStart, end: q3, val: 8, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
      ],
      PaymentsForRepurchaseOfCommonStock: [{ start: fyStart, end: fyEnd, val: 90, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      PaymentsOfDividends: [{ start: fyStart, end: fyEnd, val: 15, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
    },
    {
      EntityCommonStockSharesOutstanding: [
        { end: "2025-10-17", val: 14_776, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" },
        { end: "2025-07-18", val: 14_900, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
      ],
      EntityPublicFloat: [{ end: "2025-03-28", val: 3_000_000, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
    },
  );
}

/** Merge extra us-gaap concepts into an existing payload (same point encoding as `facts`). */
function addTags(f: CompanyFacts, extra: Record<string, Pt[]>): CompanyFacts {
  return {
    ...f,
    facts: { ...f.facts, "us-gaap": { ...f.facts["us-gaap"], ...facts(extra).facts["us-gaap"] } },
  };
}

const OPTS = { symbol: "AAPL", cik: "0000320193", annualPeriods: 10, quarterlyPeriods: 24 };

/** FY2025 balance-sheet instant with the appleLike() filing labels. */
const FY25_INSTANT = { end: "2025-09-27", form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" } as const;

describe("buildStatementsFromCompanyFacts — annual rows", () => {
  it("builds FMP-shaped annual income rows newest first with computed totals only from present operands", () => {
    const built = buildStatementsFromCompanyFacts(appleLike(), OPTS);
    const rows = built.incomeAnnual.rows;
    expect(rows.map((r) => r.date)).toEqual(["2025-09-27", "2024-09-28"]);
    const fy25 = rows[0]!;
    expect(fy25).toMatchObject({
      symbol: "AAPL",
      cik: "0000320193",
      reportedCurrency: "USD",
      fiscalYear: "2025",
      period: "FY",
      filingDate: "2025-10-31",
      revenue: 400,
      costOfRevenue: 220,
      grossProfit: 180,
      operatingIncome: 130,
      depreciationAndAmortization: 12,
      ebitda: 142,
      interestExpense: 4,
      incomeBeforeTax: 128,
      ebit: 132,
      netIncome: 100,
      epsDiluted: 7.5,
      weightedAverageShsOutDil: 15_000,
    });
    expect(fy25.incomeTaxExpense).toBeNull();
    // FY2024 has revenue and net income only: nothing else is invented.
    expect(rows[1]).toMatchObject({ revenue: 380, netIncome: 90, grossProfit: null, ebitda: null, ebit: null });
  });

  it("builds balance rows from instants and derives debt, net debt and cash totals per the rules", () => {
    const built = buildStatementsFromCompanyFacts(appleLike(), OPTS);
    const fy25 = built.balanceAnnual.rows.find((r) => r.date === "2025-09-27")!;
    expect(fy25).toMatchObject({
      totalAssets: 360,
      totalStockholdersEquity: 65,
      totalLiabilities: 295,
      cashAndCashEquivalents: 30,
      shortTermInvestments: 25,
      cashAndShortTermInvestments: 55,
      longTermDebt: 80,
      shortTermDebt: 15, // LongTermDebtCurrent 10 + CommercialPaper 5 (sumAny)
      totalDebt: 95,
      netDebt: 65,
    });
    expect(fy25.totalEquity).toBeNull(); // MinorityInterest absent → not invented
    expect(built.balanceAnnual.notes.some((n) => /shortTermDebt.*sum of present components/.test(n))).toBe(true);
    const fy24 = built.balanceAnnual.rows.find((r) => r.date === "2024-09-28")!;
    expect(fy24.totalAssets).toBe(365);
    expect(fy24.totalDebt).toBeNull();
  });

  it("builds cash-flow rows with FMP sign conventions and free cash flow", () => {
    const built = buildStatementsFromCompanyFacts(appleLike(), OPTS);
    const fy25 = built.cashflowAnnual.rows[0]!;
    expect(fy25).toMatchObject({
      date: "2025-09-27",
      netIncome: 100,
      operatingCashFlow: 110,
      netCashProvidedByOperatingActivities: 110,
      capitalExpenditure: -12,
      investmentsInPropertyPlantAndEquipment: -12,
      freeCashFlow: 98,
      commonStockRepurchased: -90,
      netDividendsPaid: -15,
      commonDividendsPaid: -15,
    });
  });
});

describe("buildStatementsFromCompanyFacts — quarterly rows", () => {
  it("uses tagged 3-month income facts, derives the missing quarter from YTD and the fourth from FY − YTD", () => {
    const built = buildStatementsFromCompanyFacts(appleLike(), OPTS);
    const rows = built.incomeQuarterly.rows;
    expect(rows.map((r) => r.date)).toEqual(["2025-09-27", "2025-06-28", "2025-03-29", "2024-12-28"]);
    const [q4, q3, q2, q1] = rows as [typeof rows[0], typeof rows[0], typeof rows[0], typeof rows[0]];
    expect(q1).toMatchObject({ period: "Q1", revenue: 120, netIncome: 30, fiscalYear: "2025" });
    expect(q1.derivation).toBeUndefined();
    expect(q2).toMatchObject({ period: "Q2", revenue: 90, netIncome: 25 }); // tagged 3-month
    expect(q3).toMatchObject({ period: "Q3", revenue: 90, netIncome: 23, epsDiluted: 1.7, weightedAverageShsOutDil: 14_900 });
    expect(q4).toMatchObject({ period: "Q4", revenue: 100, netIncome: 22, derivation: "fy-minus-ytd", epsDiluted: 1.6 });
    expect(q4.weightedAverageShsOutDil).toBeNull(); // share counts are never subtracted
    expect(q4.derivedFrom).toEqual(expect.arrayContaining([expect.stringMatching(/2025-09-27/), expect.stringMatching(/2025-06-28/)]));
    expect(built.incomeQuarterly.notes.some((n) => /Q4.*FY − YTD/.test(n))).toBe(true);
  });

  it("derives every cash-flow quarter after the first from year-to-date differences", () => {
    const built = buildStatementsFromCompanyFacts(appleLike(), OPTS);
    const rows = built.cashflowQuarterly.rows;
    expect(rows.map((r) => [r.date, r.operatingCashFlow, r.capitalExpenditure, r.freeCashFlow, r.derivation ?? null])).toEqual([
      ["2025-09-27", 15, -4, 11, "fy-minus-ytd"],
      ["2025-06-28", 15, -3, 12, "ytd-difference"],
      ["2025-03-29", 30, -3, 27, "ytd-difference"],
      ["2024-12-28", 50, -2, 48, null],
    ]);
  });

  it("builds a balance row at every quarter end and the fiscal year end", () => {
    const built = buildStatementsFromCompanyFacts(appleLike(), OPTS);
    expect(built.balanceQuarterly.rows.map((r) => [r.date, r.totalAssets, r.period])).toEqual([
      ["2025-09-27", 360, "Q4"],
      ["2025-06-28", 350, "Q3"],
      ["2025-03-29", 345, "Q2"],
      ["2024-12-28", 340, "Q1"],
      ["2024-09-28", 365, "Q4"],
    ]);
  });

  it("never derives a quarter when an operand is missing", () => {
    const f = appleLike();
    // Remove the Q2 YTD net-income point: Q2 net income is still tagged 3-month, but Q3's derivation is unaffected;
    // remove the 3-month Q2 revenue and its YTD to force a gap for Q2 revenue.
    const rev = (f.facts["us-gaap"]!.RevenueFromContractWithCustomerExcludingAssessedTax as { units: { USD: { start?: string; end: string }[] } }).units.USD;
    const kept = rev.filter((p) => !(p.end === "2025-03-29"));
    (f.facts["us-gaap"]!.RevenueFromContractWithCustomerExcludingAssessedTax as { units: { USD: unknown[] } }).units.USD = kept;
    const built = buildStatementsFromCompanyFacts(f, OPTS);
    const q2 = built.incomeQuarterly.rows.find((r) => r.date === "2025-03-29")!;
    expect(q2.revenue).toBeNull();
    expect(q2.netIncome).toBe(25);
    // Q3 revenue had its own 3-month point, so it survives.
    expect(built.incomeQuarterly.rows.find((r) => r.date === "2025-06-28")!.revenue).toBe(90);
  });

  it("keeps the latest filing's value for a restated period and prefers an amendment on a tie", () => {
    const f = appleLike();
    const ni = (f.facts["us-gaap"]!.NetIncomeLoss as { units: { USD: { start?: string; end: string; val: number; form: string; filed: string; accn: string }[] } }).units.USD;
    ni.push({ start: "2024-09-29", end: "2025-09-27", val: 101, form: "10-K/A", filed: "2025-10-31", accn: "0000000000-25-000901" } as never);
    ni.push({ start: "2024-09-29", end: "2025-09-27", val: 99, form: "10-K", filed: "2025-09-30", accn: "0000000000-25-000902" } as never);
    const built = buildStatementsFromCompanyFacts(f, OPTS);
    expect(built.incomeAnnual.rows[0]!.netIncome).toBe(101);
  });
});

describe("buildStatementsFromCompanyFacts — edge cases", () => {
  it("tolerates a 53-week year and a quarter end shifted by up to three days", () => {
    const f = appleLike();
    const assets = (f.facts["us-gaap"]!.Assets as { units: { USD: { end: string }[] } }).units.USD;
    assets.find((p) => p.end === "2025-06-28")!.end = "2025-06-30"; // instant reported two days later
    const built = buildStatementsFromCompanyFacts(f, OPTS);
    expect(built.balanceQuarterly.rows.some((r) => r.date === "2025-06-30" && r.totalAssets === 350)).toBe(true);
    // The income 3-month point still attaches to that quarter end.
    expect(built.incomeQuarterly.rows.find((r) => r.date === "2025-06-30")?.revenue ?? built.incomeQuarterly.rows.find((r) => r.date === "2025-06-28")?.revenue).toBe(90);
  });

  it("uses the bank revenue chain for bank-style tagging", () => {
    const f = facts({
      InterestIncomeExpenseNet: [{ start: "2025-01-01", end: "2025-12-31", val: 90, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" }],
      NoninterestIncome: [{ start: "2025-01-01", end: "2025-12-31", val: 60, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" }],
      NetIncomeLoss: [{ start: "2025-01-01", end: "2025-12-31", val: 50, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" }],
      Assets: [{ end: "2025-12-31", val: 4000, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" }],
      Deposits: [{ end: "2025-12-31", val: 2500, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" }],
    });
    const built = buildStatementsFromCompanyFacts(f, { ...OPTS, symbol: "BANK" });
    expect(built.incomeAnnual.rows[0]).toMatchObject({ revenue: 150, netInterestIncome: 90, netIncome: 50 });
    expect(built.balanceAnnual.rows[0]).toMatchObject({ deposits: 2500 });
    expect(built.incomeAnnual.notes.some((n) => /bank revenue chain/.test(n))).toBe(true);
  });

  it("reports currency from the fact unit and flags a 20-F filer", () => {
    const f = facts(
      {
        Revenues: [{ start: "2025-01-01", end: "2025-12-31", val: 500, form: "20-F", fp: "FY", fy: 2025, filed: "2026-03-20" }],
        NetIncomeLoss: [{ start: "2025-01-01", end: "2025-12-31", val: 40, form: "20-F", fp: "FY", fy: 2025, filed: "2026-03-20" }],
        Assets: [{ end: "2025-12-31", val: 900, form: "20-F", fp: "FY", fy: 2025, filed: "2026-03-20" }],
      },
      {},
      { Revenues: "EUR", NetIncomeLoss: "EUR", Assets: "EUR" },
    );
    const built = buildStatementsFromCompanyFacts(f, { ...OPTS, symbol: "SAP" });
    expect(built.incomeAnnual.rows[0]!.reportedCurrency).toBe("EUR");
    expect(built.reportedCurrency).toBe("EUR");
    expect(built.filesTwentyF).toBe(true);
    expect(built.incomeQuarterly.rows).toEqual([]);
    expect(built.incomeQuarterly.gaps[0]?.reason).toMatch(/no quarterly/i);
  });

  it("exposes cover-page shares and float, newest first, and returns empty results with gaps for an empty payload", () => {
    const built = buildStatementsFromCompanyFacts(appleLike(), OPTS);
    expect(built.shares).toEqual({
      outstanding: {
        value: 14_776,
        asOf: "2025-10-17",
        basis: "dei cover page",
        // WS4: the cover count now names the filing it came from, because a
        // multi-class count is the SUM of that filing's per-class facts.
        filing: { accn: "0000000000-26-000000", filed: "2025-10-31", form: "10-K" },
      },
      publicFloat: { value: 3_000_000, asOf: "2025-03-28" },
    });
    const empty = buildStatementsFromCompanyFacts({ cik: 1, entityName: "Empty", facts: {} }, OPTS);
    expect(empty.incomeAnnual.rows).toEqual([]);
    expect(empty.incomeAnnual.gaps[0]).toMatchObject({ field: "edgar.statements.income(AAPL,annual)", severity: "warn" });
    expect(empty.shares).toEqual({ outstanding: null, publicFloat: null });
  });

  it("ignores facts from non-core forms and honours the period limits", () => {
    const f = appleLike();
    const rev = (f.facts["us-gaap"]!.RevenueFromContractWithCustomerExcludingAssessedTax as { units: { USD: { form: string; end: string; val: number }[] } }).units.USD;
    rev.push({ start: "2022-10-02", end: "2023-09-30", val: 370, form: "8-K", filed: "2023-11-01", accn: "0000000000-23-000001" } as never);
    const built = buildStatementsFromCompanyFacts(f, { ...OPTS, annualPeriods: 1, quarterlyPeriods: 2 });
    expect(built.incomeAnnual.rows.map((r) => r.date)).toEqual(["2025-09-27"]);
    expect(built.incomeQuarterly.rows).toHaveLength(2);
  });
});

describe("buildStatementsFromCompanyFacts — chain and derivation coverage", () => {
  /** Calendar fiscal year: three tagged 3-month revenue quarters and NO year-to-date revenue facts. */
  function calendarQuarters(): CompanyFacts {
    const fyStart = "2025-01-01";
    const fyEnd = "2025-12-31";
    const k = { form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-20" } as const;
    const annual = (val: number): Pt[] => [{ start: fyStart, end: fyEnd, val, ...k }];
    return facts({
      Revenues: [
        { start: fyStart, end: fyEnd, val: 1000, ...k },
        { start: fyStart, end: "2025-03-31", val: 200, form: "10-Q", fp: "Q1", fy: 2025, filed: "2025-05-01" },
        { start: "2025-04-01", end: "2025-06-30", val: 250, form: "10-Q", fp: "Q2", fy: 2025, filed: "2025-08-01" },
        { start: "2025-07-01", end: "2025-09-30", val: 260, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-11-01" },
      ],
      NetIncomeLoss: annual(100),
      Assets: [
        { end: fyEnd, val: 900, ...k },
        { end: "2025-09-30", val: 880, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-11-01" },
        { end: "2025-06-30", val: 870, form: "10-Q", fp: "Q2", fy: 2025, filed: "2025-08-01" },
        { end: "2025-03-31", val: 860, form: "10-Q", fp: "Q1", fy: 2025, filed: "2025-05-01" },
      ],
      LongTermDebt: [{ end: fyEnd, val: 300, ...k }],
      ResearchAndDevelopmentExpense: annual(60),
      SellingAndMarketingExpense: [
        { start: fyStart, end: fyEnd, val: 30, ...k },
        { start: fyStart, end: "2025-03-31", val: 6, form: "10-Q", fp: "Q1", fy: 2025, filed: "2025-05-01" },
        { start: fyStart, end: "2025-06-30", val: 14, form: "10-Q", fp: "Q2", fy: 2025, filed: "2025-08-01" },
        { start: fyStart, end: "2025-09-30", val: 22, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-11-01" },
      ],
      GeneralAndAdministrativeExpense: [
        { start: fyStart, end: fyEnd, val: 45, ...k },
        { start: fyStart, end: "2025-03-31", val: 10, form: "10-Q", fp: "Q1", fy: 2025, filed: "2025-05-01" },
        { start: fyStart, end: "2025-06-30", val: 21, form: "10-Q", fp: "Q2", fy: 2025, filed: "2025-08-01" },
        { start: fyStart, end: "2025-09-30", val: 33, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-11-01" },
      ],
      EarningsPerShareBasic: annual(2.5),
      WeightedAverageNumberOfSharesOutstandingBasic: annual(40_000),
      NetCashProvidedByUsedInOperatingActivities: [
        { start: fyStart, end: fyEnd, val: 400, ...k },
        { start: fyStart, end: "2025-03-31", val: 90, form: "10-Q", fp: "Q1", fy: 2025, filed: "2025-05-01" },
        // No Q2 year-to-date point: Q2 and Q3 must stay unresolved rather than be guessed.
        { start: fyStart, end: "2025-09-30", val: 300, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-11-01" },
      ],
      ProceedsFromIssuanceOfLongTermDebt: annual(150),
      RepaymentsOfLongTermDebt: annual(40),
      ProceedsFromIssuanceOfCommonStock: annual(20),
      PaymentsForRepurchaseOfCommonStock: annual(70),
      PaymentsOfDividendsPreferredStockAndPreferenceStock: annual(8),
      NetCashProvidedByUsedInInvestingActivities: annual(-120),
      NetCashProvidedByUsedInFinancingActivities: annual(-180),
      IncomeTaxesPaidNet: annual(25),
      InterestPaidNet: annual(11),
    });
  }

  it("derives the fourth quarter from FY − (Q1+Q2+Q3) when no year-to-date fact exists", () => {
    const built = buildStatementsFromCompanyFacts(calendarQuarters(), { ...OPTS, symbol: "CAL" });
    const rows = built.incomeQuarterly.rows;
    expect(rows.map((r) => [r.date, r.period, r.revenue])).toEqual([
      ["2025-12-31", "Q4", 290], // 1000 − (200 + 250 + 260)
      ["2025-09-30", "Q3", 260],
      ["2025-06-30", "Q2", 250],
      ["2025-03-31", "Q1", 200],
    ]);
    expect(rows[0]).toMatchObject({ derivation: "fy-minus-quarters", netIncome: null, eps: null, weightedAverageShsOut: null });
    expect(built.incomeQuarterly.notes.some((n) => /FY − \(Q1\+Q2\+Q3\)/.test(n))).toBe(true);
    // A summed field made of two derived components keeps the derivation and both operands.
    expect(rows[1]).toMatchObject({ sellingGeneralAndAdministrativeExpenses: 20, derivation: "ytd-difference" }); // (22−14) + (33−21)
    expect(rows[1]!.derivedFrom).toEqual(expect.arrayContaining([expect.stringMatching(/SellingAndMarketingExpense/)]));
  });

  it("resolves diff, sign-flipped and alias cash-flow fields and notes a partial debt sum", () => {
    const built = buildStatementsFromCompanyFacts(calendarQuarters(), { ...OPTS, symbol: "CAL" });
    expect(built.cashflowAnnual.rows[0]).toMatchObject({
      operatingCashFlow: 400,
      netDebtIssuance: 110, // 150 − 40
      netStockIssuance: -50, // 20 − 70
      commonStockRepurchased: -70,
      preferredDividendsPaid: -8,
      investingCashFlow: -120,
      financingCashFlow: -180,
      incomeTaxesPaid: 25,
      interestPaid: 11,
      capitalExpenditure: null,
      freeCashFlow: null, // capex absent: never invented
    });
    expect(built.incomeAnnual.rows[0]).toMatchObject({
      sellingGeneralAndAdministrativeExpenses: 75, // 30 + 45 (sum step)
      researchAndDevelopmentExpenses: 60,
      operatingExpenses: 135,
      eps: 2.5,
      weightedAverageShsOut: 40_000,
      ebit: null,
    });
    const balance = built.balanceAnnual.rows[0]!;
    expect(balance).toMatchObject({ longTermDebt: 300, shortTermDebt: null, totalDebt: 300, netDebt: null });
    expect(built.balanceAnnual.notes.some((n) => /totalDebt.*sum of present components/.test(n))).toBe(true);
    // Cash-flow quarters without a year-to-date operand are omitted, not guessed.
    expect(built.cashflowQuarterly.rows.map((r) => [r.date, r.operatingCashFlow])).toEqual([
      ["2025-12-31", 100], // 400 − 300
      ["2025-03-31", 90],
    ]);
  });

  it("prefers the fiscal-year end when a 10-Q instant lands within the date tolerance of it", () => {
    const f = appleLike();
    const assets = (f.facts["us-gaap"]!.Assets as { units: { USD: { end: string; val: number }[] } }).units.USD;
    assets.push({ end: "2025-09-29", val: 359, form: "10-Q", fp: "Q1", fy: 2026, filed: "2025-11-05", accn: "0000000000-25-000777" } as never);
    const built = buildStatementsFromCompanyFacts(f, OPTS);
    // The cluster collapses onto the 10-K year end, and the closest instant wins.
    expect(built.balanceQuarterly.rows[0]).toMatchObject({ date: "2025-09-27", totalAssets: 360, period: "Q4" });
    expect(built.balanceQuarterly.rows.some((r) => r.date === "2025-09-29")).toBe(false);
  });

  it("falls back to the previous quarter end when no anchor duration spans the quarter", () => {
    const f = facts({
      Revenues: [{ start: "2024-01-01", end: "2024-12-31", val: 500, form: "10-K", fp: "FY", fy: 2024, filed: "2025-02-20" }],
      NetIncomeLoss: [{ start: "2024-01-01", end: "2024-12-31", val: 50, form: "10-K", fp: "FY", fy: 2024, filed: "2025-02-20" }],
      Assets: [
        { end: "2024-12-31", val: 700, form: "10-K", fp: "FY", fy: 2024, filed: "2025-02-20" },
        { end: "2025-03-31", val: 710, form: "10-Q", fp: "FY", fy: 2025, filed: "2025-05-05" },
        { end: "2025-06-30", val: 720, form: "10-Q", fp: "FY", fy: 2025, filed: "2025-08-05" },
        { end: "2022-05-31", val: 600, form: "10-Q", fp: "FY", fy: 2022, filed: "2022-07-05" },
      ],
    });
    const built = buildStatementsFromCompanyFacts(f, { ...OPTS, symbol: "STUB" });
    expect(built.balanceQuarterly.rows.map((r) => [r.date, r.period, r.totalAssets])).toEqual([
      ["2025-06-30", "Q1", 720], // window inferred from the previous quarter end
      ["2025-03-31", "Q1", 710],
      ["2024-12-31", "Q4", 700],
      ["2022-05-31", "Q4", 600], // no window and no predecessor at all
    ]);
    expect(built.incomeQuarterly.rows).toEqual([]);
  });

  it("drops a sum component reported in another currency", () => {
    const f = facts(
      {
        InterestIncomeExpenseNet: [{ start: "2025-01-01", end: "2025-12-31", val: 90, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" }],
        NoninterestIncome: [{ start: "2025-01-01", end: "2025-12-31", val: 60, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" }],
        NetIncomeLoss: [{ start: "2025-01-01", end: "2025-12-31", val: 50, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" }],
        Assets: [{ end: "2025-12-31", val: 4000, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" }],
      },
      {},
      { NoninterestIncome: "EUR" },
    );
    const built = buildStatementsFromCompanyFacts(f, { ...OPTS, symbol: "MIXED" });
    expect(built.incomeAnnual.rows[0]).toMatchObject({ revenue: null, netInterestIncome: 90, netIncome: 50, reportedCurrency: "USD" });
  });

  it("reuses a neighbouring fiscal-year start when the year end is dated by an instant", () => {
    const f = facts({
      Revenues: [{ start: "2025-01-01", end: "2025-12-29", val: 800, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-25" }],
      NetIncomeLoss: [{ start: "2025-01-01", end: "2025-12-29", val: 80, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-25" }],
      Assets: [{ end: "2025-12-31", val: 1200, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-25" }],
    });
    const built = buildStatementsFromCompanyFacts(f, { ...OPTS, symbol: "OFFSET" });
    expect(built.incomeAnnual.rows.map((r) => [r.date, r.revenue, r.netIncome])).toEqual([["2025-12-31", 800, 80]]);
    expect(built.balanceAnnual.rows[0]).toMatchObject({ date: "2025-12-31", totalAssets: 1200 });
  });
});

describe("buildStatementsFromCompanyFacts — comparative copies carried in a later filing", () => {
  // The JPM mechanic (fixtures/edgar/jpm_companyfacts_revenue_tags.json): the FY2025 year-end
  // Assets/Deposits instants exist BOTH as the 10-K original {fy:2025, fp:"FY", filed:"2026-02-13"}
  // and as the Q1-2026 10-Q comparative {fy:2026, fp:"Q1", filed:"2026-05-01"}. max(filed) keeps
  // the 10-Q copy, whose fy/fp describe the 10-Q, not the fiscal year it restates.
  it("keeps the restated value but labels the row from the filing that first reported the period", () => {
    const f = facts({
      Revenues: [{ start: "2025-01-01", end: "2025-12-31", val: 182_447, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" }],
      NetIncomeLoss: [{ start: "2025-01-01", end: "2025-12-31", val: 57_048, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" }],
      Assets: [
        { end: "2025-12-31", val: 4_424_900, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" },
        { end: "2025-12-31", val: 4_424_950, form: "10-Q", fp: "Q1", fy: 2026, filed: "2026-05-01" },
      ],
      Deposits: [
        { end: "2025-12-31", val: 2_559_320, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" },
        { end: "2025-12-31", val: 2_559_400, form: "10-Q", fp: "Q1", fy: 2026, filed: "2026-05-01" },
      ],
    });
    const built = buildStatementsFromCompanyFacts(f, { ...OPTS, symbol: "JPM" });
    expect(built.balanceAnnual.rows).toHaveLength(1);
    expect(built.balanceAnnual.rows[0]).toMatchObject({
      date: "2025-12-31",
      totalAssets: 4_424_950, // the later filing's value still wins (max(filed) dedup)
      deposits: 2_559_400,
      fiscalYear: "2025", // ...but not its fy
      period: "FY",
      filingDate: "2026-02-13", // ...nor its filing date
      acceptedDate: "2026-02-13",
    });
    // The year end is still discovered even though the deduped Assets instant now looks like a 10-Q.
    expect(built.balanceQuarterly.rows[0]).toMatchObject({ date: "2025-12-31", period: "Q4", filingDate: "2026-02-13" });
  });

  it("keeps the fiscal-year label when the next 10-K carries the period as an FY comparative", () => {
    const f = facts({
      Revenues: [
        { start: "2025-01-01", end: "2025-12-31", val: 182_447, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" },
        // FY2026's 10-K restates FY2025 and stamps the comparative with ITS OWN fy/fp.
        { start: "2025-01-01", end: "2025-12-31", val: 182_500, form: "10-K", fp: "FY", fy: 2026, filed: "2027-02-12" },
      ],
      NetIncomeLoss: [
        { start: "2025-01-01", end: "2025-12-31", val: 57_048, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" },
        { start: "2025-01-01", end: "2025-12-31", val: 57_100, form: "10-K", fp: "FY", fy: 2026, filed: "2027-02-12" },
      ],
      Assets: [{ end: "2025-12-31", val: 4_424_900, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" }],
    });
    const built = buildStatementsFromCompanyFacts(f, { ...OPTS, symbol: "JPM" });
    expect(built.incomeAnnual.rows[0]).toMatchObject({
      date: "2025-12-31",
      revenue: 182_500, // restated value wins
      netIncome: 57_100,
      fiscalYear: "2025", // label comes from the original 10-K, not the fy:2026 comparative
      period: "FY",
      filingDate: "2026-02-13",
    });
  });

  it("ignores fy on a stale comparative when no original filing of the period survives", () => {
    const f = facts({
      // Only the FY2026 10-K's comparative of FY2025 is present: its fy is a year too high and its
      // filing lag (~410 days) shows it is not this period's own report.
      Revenues: [{ start: "2025-01-01", end: "2025-12-31", val: 182_500, form: "10-K", fp: "FY", fy: 2026, filed: "2027-02-12" }],
      NetIncomeLoss: [{ start: "2025-01-01", end: "2025-12-31", val: 57_100, form: "10-K", fp: "FY", fy: 2026, filed: "2027-02-12" }],
      Assets: [{ end: "2025-12-31", val: 4_424_900, form: "10-K", fp: "FY", fy: 2026, filed: "2027-02-12" }],
    });
    const built = buildStatementsFromCompanyFacts(f, { ...OPTS, symbol: "JPM" });
    expect(built.incomeAnnual.rows[0]).toMatchObject({
      date: "2025-12-31",
      fiscalYear: "2025", // from the period end, not from fy:2026
      filingDate: "2027-02-12", // the only filing there is
    });
  });
});

/* ---------------------------------------------------------------------------
 * Task 8 — gaps found running the keyless path live on AAPL and JPM.
 * ------------------------------------------------------------------------- */

describe("buildStatementsFromCompanyFacts — lease obligations belong in total debt", () => {
  it("sums the operating and finance lease liabilities into capitalLeaseObligations and totalDebt", () => {
    // FMP's totalDebt for Apple FY2025 is shortTermDebt + longTermDebt +
    // capitalLeaseObligations, and netDebt = totalDebt − cash. Apple tags the
    // noncurrent operating portion and a finance-lease total.
    const built = buildStatementsFromCompanyFacts(
      addTags(appleLike(), {
        OperatingLeaseLiabilityCurrent: [{ ...FY25_INSTANT, val: 1.6 }],
        OperatingLeaseLiabilityNoncurrent: [{ ...FY25_INSTANT, val: 10.91 }],
        FinanceLeaseLiability: [{ ...FY25_INSTANT, val: 1.23 }],
      }),
      OPTS,
    );
    const fy25 = built.balanceAnnual.rows.find((r) => r.date === "2025-09-27")!;
    expect(fy25).toMatchObject({
      capitalLeaseObligations: 13.74, // (1.6 + 10.91) + 1.23
      shortTermDebt: 15,
      longTermDebt: 80,
      totalDebt: 108.74,
      netDebt: 78.74, // totalDebt − cashAndCashEquivalents (30)
    });
  });

  it("prefers a tagged operating-lease total over the current + noncurrent split", () => {
    const built = buildStatementsFromCompanyFacts(
      addTags(appleLike(), {
        OperatingLeaseLiability: [{ ...FY25_INSTANT, val: 12 }],
        OperatingLeaseLiabilityCurrent: [{ ...FY25_INSTANT, val: 1.6 }],
        OperatingLeaseLiabilityNoncurrent: [{ ...FY25_INSTANT, val: 10.91 }],
        FinanceLeaseLiabilityCurrent: [{ ...FY25_INSTANT, val: 0.4 }],
        FinanceLeaseLiabilityNoncurrent: [{ ...FY25_INSTANT, val: 0.8 }],
      }),
      OPTS,
    );
    expect(built.balanceAnnual.rows.find((r) => r.date === "2025-09-27")).toMatchObject({
      capitalLeaseObligations: 13.2, // 12 (tagged total) + (0.4 + 0.8)
      totalDebt: 108.2,
    });
  });

  it("uses finance leases alone when no operating lease is tagged, and discloses the absent half", () => {
    const built = buildStatementsFromCompanyFacts(
      addTags(appleLike(), {
        FinanceLeaseLiabilityCurrent: [{ ...FY25_INSTANT, val: 0.4 }],
        FinanceLeaseLiabilityNoncurrent: [{ ...FY25_INSTANT, val: 0.8 }],
      }),
      OPTS,
    );
    expect(built.balanceAnnual.rows.find((r) => r.date === "2025-09-27")).toMatchObject({
      capitalLeaseObligations: 1.2,
      totalDebt: 96.2,
      netDebt: 66.2,
    });
    expect(
      built.balanceAnnual.notes.some(
        (n) => /capitalLeaseObligations/.test(n) && /absent and excluded: operatingLeaseLiability/.test(n),
      ),
    ).toBe(true);
  });

  it("leaves totalDebt unchanged when no lease liability is tagged at all", () => {
    const built = buildStatementsFromCompanyFacts(appleLike(), OPTS);
    const fy25 = built.balanceAnnual.rows.find((r) => r.date === "2025-09-27")!;
    expect(fy25.capitalLeaseObligations).toBeNull();
    expect(fy25).toMatchObject({ totalDebt: 95, netDebt: 65 });
    expect(
      built.balanceAnnual.notes.some(
        (n) => /^totalDebt /.test(n) && /absent and excluded: capitalLeaseObligations/.test(n),
      ),
    ).toBe(true);
  });
});

describe("buildStatementsFromCompanyFacts — multi-class share counts", () => {
  /** Strip the dei cover-page count, as companyfacts does for a per-class reporter. */
  function withoutDeiShares(f: CompanyFacts): CompanyFacts {
    const dei = { ...(f.facts["dei"] as Record<string, unknown>) };
    delete dei["EntityCommonStockSharesOutstanding"];
    return { ...f, facts: { ...f.facts, dei } };
  }

  it("falls back to the balance-sheet all-classes total when no dei cover count exists", () => {
    // GOOGL/BRK.B/FOXA file their cover counts DIMENSIONED by class and
    // companyfacts carries no dimensional facts, so the dei concept is absent
    // entirely. Without this fallback those issuers get no market cap, no
    // enterprise value and no market-cap history at all.
    const built = buildStatementsFromCompanyFacts(
      addTags(withoutDeiShares(appleLike()), {
        CommonStockSharesOutstanding: [
          { end: "2025-06-28", val: 12_100, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-08-01" },
          { end: "2025-09-27", val: 12_230, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" },
        ],
      }),
      OPTS,
    );
    expect(built.shares.outstanding).toEqual({
      value: 12_230,
      asOf: "2025-09-27",
      basis: "balance sheet CommonStockSharesOutstanding",
    });
  });

  it("prefers the dei cover count when the filer files both", () => {
    const built = buildStatementsFromCompanyFacts(
      addTags(appleLike(), {
        CommonStockSharesOutstanding: [{ end: "2025-09-27", val: 12_230, form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" }],
      }),
      OPTS,
    );
    expect(built.shares.outstanding).toEqual({
      value: 14_776,
      asOf: "2025-10-17",
      basis: "dei cover page",
      filing: { accn: "0000000000-26-000000", filed: "2025-10-31", form: "10-K" },
    });
  });

  it("stays null when neither concept is filed", () => {
    expect(buildStatementsFromCompanyFacts(withoutDeiShares(appleLike()), OPTS).shares.outstanding).toBeNull();
  });
});

describe("buildStatementsFromCompanyFacts — debt chain overlaps", () => {
  /** A filer with no debt tags at all; each case adds only the tags it is about. */
  function bare(extra: Record<string, Pt[]>): CompanyFacts {
    const k = { form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-20" } as const;
    return facts({
      Revenues: [{ start: "2025-01-01", end: "2025-12-31", val: 1_000, ...k }],
      Assets: [{ end: "2025-12-31", val: 5_000, ...k }],
      CashAndCashEquivalentsAtCarryingValue: [{ end: "2025-12-31", val: 100, ...k }],
      ...extra,
    });
  }
  const at = (val: number): Pt[] => [{ end: "2025-12-31", val, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-20" }];
  const row = (f: CompanyFacts) => buildStatementsFromCompanyFacts(f, { ...OPTS, symbol: "X" }).balanceAnnual;

  it("counts finance leases once when longTermDebt came from the combined debt-and-leases tag", () => {
    // `LongTermDebtAndCapitalLeaseObligations` already contains the finance
    // leases that `capitalLeaseObligations` resolves again from
    // `FinanceLeaseLiability`, so adding both double-counted them in totalDebt.
    const built = row(
      bare({
        LongTermDebtAndCapitalLeaseObligations: [...at(500)],
        FinanceLeaseLiability: [...at(30)],
        OperatingLeaseLiability: [...at(70)],
      }),
    );
    const fy = built.rows[0]!;
    expect(fy.longTermDebt).toBe(500);
    // The published lease figure is still the full operating + finance total.
    expect(fy.capitalLeaseObligations).toBe(100);
    // ...but only the operating half is added: 500 + 70, not 500 + 100.
    expect(fy.totalDebt).toBe(570);
    expect(fy.netDebt).toBe(470);
    expect(
      built.notes.some(
        (n) =>
          /^totalDebt 2025-12-31:/.test(n) &&
          /already includes finance lease obligations/.test(n) &&
          /only the operating-lease liability is added/.test(n),
      ),
    ).toBe(true);
    expect(built.notes).toContain("longTermDebt 2025-12-31: from LongTermDebtAndCapitalLeaseObligations");
  });

  it("adds the whole lease liability when the noncurrent debt tag excludes leases", () => {
    const built = row(
      bare({
        LongTermDebtNoncurrent: [...at(500)],
        FinanceLeaseLiability: [...at(30)],
        OperatingLeaseLiability: [...at(70)],
      }),
    );
    expect(built.rows[0]).toMatchObject({ longTermDebt: 500, capitalLeaseObligations: 100, totalDebt: 600 });
    expect(built.notes.some((n) => /already includes finance lease obligations/.test(n))).toBe(false);
  });

  it("nets current maturities out of longTermDebt when the us-gaap total resolved", () => {
    // `LongTermDebt` is the total INCLUDING current maturities, and
    // `shortTermDebt` sums `LongTermDebtCurrent` — so the current portion was
    // counted twice in totalDebt.
    const built = row(bare({ LongTermDebt: [...at(500)], LongTermDebtCurrent: [...at(40)] }));
    const fy = built.rows[0]!;
    expect(fy.shortTermDebt).toBe(40);
    expect(fy.longTermDebt).toBe(460); // 500 total − 40 current maturities
    expect(fy.totalDebt).toBe(500); // counted once
    expect(built.notes).toContain("longTermDebt 2025-12-31: LongTermDebt less current maturities (LongTermDebtCurrent 40)");
  });

  it("keeps the LongTermDebt total and says so when no current maturities are filed", () => {
    const built = row(bare({ LongTermDebt: [...at(500)] }));
    expect(built.rows[0]).toMatchObject({ longTermDebt: 500, shortTermDebt: null, totalDebt: 500 });
    expect(
      built.notes.some((n) => /^longTermDebt 2025-12-31:/.test(n) && /current maturities may be included/.test(n)),
    ).toBe(true);
  });

  it("does not add commercial paper on top of short-term borrowings", () => {
    // Commercial paper is conventionally a component of ShortTermBorrowings.
    const built = row(
      bare({ ShortTermBorrowings: [...at(120)], CommercialPaper: [...at(50)], LongTermDebtCurrent: [...at(30)] }),
    );
    const fy = built.rows[0]!;
    expect(fy.shortTermDebt).toBe(150); // 30 + 120, not 30 + 120 + 50
    expect(fy.totalDebt).toBe(150);
    expect(
      built.notes.some(
        (n) =>
          /^shortTermDebt 2025-12-31:/.test(n) &&
          /CommercialPaper excluded/.test(n) &&
          /conventionally a component of ShortTermBorrowings/.test(n),
      ),
    ).toBe(true);
  });

  it("still sums commercial paper when the filer tags no short-term borrowings", () => {
    const built = row(bare({ CommercialPaper: [...at(50)], LongTermDebtCurrent: [...at(30)] }));
    expect(built.rows[0]).toMatchObject({ shortTermDebt: 80, totalDebt: 80 });
    // The composition note lists the tags in the order the D-13 chain checks
    // them: short-term borrowings, commercial paper, then current maturities.
    expect(built.notes).toContain("shortTermDebt 2025-12-31: from CommercialPaper + LongTermDebtCurrent");
  });

  it("names the winning tags for the three debt fields on every row", () => {
    const built = row(
      bare({
        DebtCurrent: [...at(20)],
        LongTermDebtNoncurrent: [...at(500)],
        OperatingLeaseLiabilityCurrent: [...at(5)],
        OperatingLeaseLiabilityNoncurrent: [...at(25)],
      }),
    );
    expect(built.notes).toContain("shortTermDebt 2025-12-31: from DebtCurrent");
    expect(built.notes).toContain("longTermDebt 2025-12-31: from LongTermDebtNoncurrent");
    expect(built.notes).toContain(
      "capitalLeaseObligations 2025-12-31: from OperatingLeaseLiabilityCurrent + OperatingLeaseLiabilityNoncurrent",
    );
  });

  it("keeps Apple FY2025 at the FMP total debt of 112.377B", () => {
    // The house number every band was calibrated against:
    // shortTermDebt 20.329 + longTermDebt 78.328 + leases 13.720.
    const k = { form: "10-K", fp: "FY", fy: 2025, filed: "2025-10-31" } as const;
    const instant = (val: number): Pt[] => [{ end: "2025-09-27", val, ...k }];
    const built = buildStatementsFromCompanyFacts(
      addTags(appleLike(), {
        LongTermDebtNoncurrent: instant(78.328),
        LongTermDebtCurrent: instant(10.6),
        CommercialPaper: instant(9.729),
        OperatingLeaseLiabilityCurrent: instant(1.6),
        OperatingLeaseLiabilityNoncurrent: instant(10.89),
        FinanceLeaseLiability: instant(1.23),
      }),
      OPTS,
    );
    expect(built.balanceAnnual.rows.find((r) => r.date === "2025-09-27")).toMatchObject({
      shortTermDebt: 20.329,
      longTermDebt: 78.328,
      capitalLeaseObligations: 13.72,
      totalDebt: 112.377,
    });
  });
});

describe("buildStatementsFromCompanyFacts — cash-only filers", () => {
  /** Home Depot / McDonald's / UPS shape: one "Cash and cash equivalents" line, no marketable securities. */
  function cashOnly(extra: Record<string, Pt[]> = {}): CompanyFacts {
    const k = { form: "10-K", fp: "FY", fy: 2025, filed: "2026-03-01" } as const;
    return facts({
      Revenues: [{ start: "2025-01-01", end: "2025-12-31", val: 160_000, ...k }],
      NetIncomeLoss: [{ start: "2025-01-01", end: "2025-12-31", val: 15_000, ...k }],
      Assets: [{ end: "2025-12-31", val: 96_000, ...k }],
      CashAndCashEquivalentsAtCarryingValue: [{ end: "2025-12-31", val: 1_650, ...k }],
      LongTermDebtNoncurrent: [{ end: "2025-12-31", val: 44_000, ...k }],
      ...extra,
    });
  }

  it("reports cashAndShortTermInvestments as the cash figure and names the absent component", () => {
    const built = buildStatementsFromCompanyFacts(cashOnly(), { ...OPTS, symbol: "HD" });
    const fy25 = built.balanceAnnual.rows[0]!;
    expect(fy25.shortTermInvestments).toBeNull();
    // Before this, a strict `add` returned null here and the DCF equity bridge
    // was suppressed for every filer that tags no short-term-investment concept.
    expect(fy25.cashAndShortTermInvestments).toBe(1_650);
    expect(fy25.cashAndShortTermInvestments).toBe(fy25.cashAndCashEquivalents);
    expect(
      built.balanceAnnual.notes.some(
        (n) =>
          /^cashAndShortTermInvestments 2025-12-31:/.test(n) &&
          /sum of present components \(cashAndCashEquivalents\)/.test(n) &&
          /absent and excluded: shortTermInvestments/.test(n),
      ),
    ).toBe(true);
  });

  it("still sums both components, with no note, when the filer tags short-term investments", () => {
    const built = buildStatementsFromCompanyFacts(
      cashOnly({
        ShortTermInvestments: [{ end: "2025-12-31", val: 350, form: "10-K", fp: "FY", fy: 2025, filed: "2026-03-01" }],
      }),
      { ...OPTS, symbol: "HD" },
    );
    expect(built.balanceAnnual.rows[0]).toMatchObject({
      cashAndCashEquivalents: 1_650,
      shortTermInvestments: 350,
      cashAndShortTermInvestments: 2_000,
    });
    expect(built.balanceAnnual.notes.some((n) => /^cashAndShortTermInvestments /.test(n))).toBe(false);
  });

  it("leaves cashAndShortTermInvestments null when neither component is tagged", () => {
    const k = { form: "10-K", fp: "FY", fy: 2025, filed: "2026-03-01" } as const;
    const built = buildStatementsFromCompanyFacts(
      facts({
        Revenues: [{ start: "2025-01-01", end: "2025-12-31", val: 160_000, ...k }],
        Assets: [{ end: "2025-12-31", val: 96_000, ...k }],
      }),
      { ...OPTS, symbol: "HD" },
    );
    expect(built.balanceAnnual.rows[0]!.cashAndShortTermInvestments).toBeNull();
  });
});

describe("buildStatementsFromCompanyFacts — bank cash tags", () => {
  /** JPM: CashAndCashEquivalentsAtCarryingValue is stale (last 2018); the live tags are these. */
  function bankCash(extra: Record<string, Pt[]> = {}): CompanyFacts {
    const k = { form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" } as const;
    return facts({
      InterestIncomeExpenseNet: [{ start: "2025-01-01", end: "2025-12-31", val: 92_000, ...k }],
      NoninterestIncome: [{ start: "2025-01-01", end: "2025-12-31", val: 90_447, ...k }],
      NetIncomeLoss: [{ start: "2025-01-01", end: "2025-12-31", val: 57_048, ...k }],
      Assets: [{ end: "2025-12-31", val: 4_424_900, ...k }],
      CashAndDueFromBanks: [{ end: "2025-12-31", val: 21_740, ...k }],
      InterestBearingDepositsInBanks: [{ end: "2025-12-31", val: 321_600, ...k }],
      CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents: [{ end: "2025-12-31", val: 343_340, ...k }],
      ...extra,
    });
  }

  it("resolves cash from CashAndDueFromBanks and short-term investments from InterestBearingDepositsInBanks", () => {
    const built = buildStatementsFromCompanyFacts(bankCash(), { ...OPTS, symbol: "JPM" });
    expect(built.balanceAnnual.rows[0]).toMatchObject({
      cashAndCashEquivalents: 21_740,
      shortTermInvestments: 321_600,
      // Matches the restricted-cash catch-all total, which is no longer what cash resolves to.
      cashAndShortTermInvestments: 343_340,
    });
  });

  it("still prefers CashAndCashEquivalentsAtCarryingValue when the filer tags it for the period", () => {
    const built = buildStatementsFromCompanyFacts(
      bankCash({
        CashAndCashEquivalentsAtCarryingValue: [
          { end: "2025-12-31", val: 25_000, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" },
        ],
      }),
      { ...OPTS, symbol: "JPM" },
    );
    expect(built.balanceAnnual.rows[0]).toMatchObject({
      cashAndCashEquivalents: 25_000,
      shortTermInvestments: 321_600,
      cashAndShortTermInvestments: 346_600,
    });
  });
});

describe("buildStatementsFromCompanyFacts — FMP field names Stage B reads", () => {
  const K = { form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-20" } as const;
  const annual = (val: number): Pt[] => [{ start: "2025-01-01", end: "2025-12-31", val, ...K }];
  const instant = (val: number): Pt[] => [{ end: "2025-12-31", val, ...K }];

  function fmpNamed(): CompanyFacts {
    return facts({
      Revenues: annual(1000),
      NetIncomeLoss: annual(100),
      Assets: instant(900),
      NonoperatingIncomeExpense: annual(-15),
      IncomeLossFromContinuingOperations: annual(105),
      IncomeLossFromDiscontinuedOperationsNetOfTax: annual(-5),
      GeneralAndAdministrativeExpense: annual(45),
      SellingAndMarketingExpense: annual(30),
      AccountsReceivableNetCurrent: instant(120),
      AccruedIncomeTaxesCurrent: instant(9),
      NetCashProvidedByUsedInOperatingActivities: annual(400),
      NetCashProvidedByUsedInInvestingActivities: annual(-120),
      NetCashProvidedByUsedInFinancingActivities: annual(-180),
      ProceedsFromIssuanceOfCommonStock: annual(20),
    });
  }

  it("emits the income-statement names Stage B's forensics mappers read", () => {
    const built = buildStatementsFromCompanyFacts(fmpNamed(), { ...OPTS, symbol: "FMPN" });
    expect(built.incomeAnnual.rows[0]).toMatchObject({
      totalOtherIncomeExpensesNet: -15,
      netIncomeFromContinuingOperations: 105,
      netIncomeFromDiscontinuedOperations: -5,
      generalAndAdministrativeExpenses: 45,
      sellingAndMarketingExpenses: 30,
      // The SG&A sum step still folds the two components together.
      sellingGeneralAndAdministrativeExpenses: 75,
    });
  });

  it("emits accountsReceivables beside netReceivables and taxPayables on the balance sheet", () => {
    const built = buildStatementsFromCompanyFacts(fmpNamed(), { ...OPTS, symbol: "FMPN" });
    expect(built.balanceAnnual.rows[0]).toMatchObject({
      netReceivables: 120,
      accountsReceivables: 120,
      taxPayables: 9,
    });
  });

  it("emits the FMP investing/financing cash-flow names so the accruals ratio can compute", () => {
    const built = buildStatementsFromCompanyFacts(fmpNamed(), { ...OPTS, symbol: "FMPN" });
    const cf = built.cashflowAnnual.rows[0]!;
    // forensics.ts reads cashFlow.netCashProvidedByInvestingActivities; the key
    // must EXIST, not merely be reachable under the old investingCashFlow name.
    expect(Object.keys(cf)).toEqual(
      expect.arrayContaining([
        "netCashProvidedByInvestingActivities",
        "netCashProvidedByFinancingActivities",
        "commonStockIssuance",
      ]),
    );
    expect(cf).toMatchObject({
      netIncome: 100,
      netCashProvidedByOperatingActivities: 400,
      netCashProvidedByInvestingActivities: -120,
      netCashProvidedByFinancingActivities: -180,
      investingCashFlow: -120, // legacy key kept
      financingCashFlow: -180,
      commonStockIssuance: 20,
    });
  });

  it("falls back to TaxesPayableCurrent and leaves every unresolved name null", () => {
    const built = buildStatementsFromCompanyFacts(
      facts({
        Revenues: annual(1000),
        NetIncomeLoss: annual(100),
        Assets: instant(900),
        TaxesPayableCurrent: instant(7),
      }),
      { ...OPTS, symbol: "FMPN" },
    );
    expect(built.balanceAnnual.rows[0]).toMatchObject({
      taxPayables: 7,
      accountsReceivables: null,
      netReceivables: null,
    });
    expect(built.incomeAnnual.rows[0]).toMatchObject({
      totalOtherIncomeExpensesNet: null,
      netIncomeFromContinuingOperations: null,
      netIncomeFromDiscontinuedOperations: null,
      generalAndAdministrativeExpenses: null,
      sellingAndMarketingExpenses: null,
    });
  });
});

describe("buildStatementsFromCompanyFacts — bank interest tags", () => {
  const K = { form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" } as const;
  const annual = (val: number): Pt[] => [{ start: "2025-01-01", end: "2025-12-31", val, ...K }];

  /** JPM tags neither InterestExpense nor InterestAndDebtExpense — only the *Operating pair. */
  function bankInterest(extra: Record<string, Pt[]> = {}): CompanyFacts {
    return facts({
      InterestIncomeExpenseNet: annual(95_400),
      NoninterestIncome: annual(87_047),
      NetIncomeLoss: annual(57_048),
      Assets: [{ end: "2025-12-31", val: 4_424_900, ...K }],
      InterestExpenseOperating: annual(97_900),
      InterestIncomeOperating: annual(193_300),
      ...extra,
    });
  }

  it("resolves interest expense and income from the *Operating tags a bank files", () => {
    const built = buildStatementsFromCompanyFacts(bankInterest(), { ...OPTS, symbol: "JPM" });
    // Without these the keyless WACC raised a CRITICAL
    // returns.wacc.interestExpense gap the FMP path never shows.
    expect(built.incomeAnnual.rows[0]).toMatchObject({
      interestExpense: 97_900,
      interestIncome: 193_300,
      netInterestIncome: 95_400,
    });
  });

  it("keeps the non-operating tag when a filer reports both", () => {
    const built = buildStatementsFromCompanyFacts(
      bankInterest({ InterestExpense: annual(4_100), InvestmentIncomeInterest: annual(900) }),
      { ...OPTS, symbol: "JPM" },
    );
    expect(built.incomeAnnual.rows[0]).toMatchObject({
      interestExpense: 4_100,
      interestIncome: 900,
    });
  });

  it("does not derive an EBIT from pretax income plus interest on a bank-tagged filer", () => {
    // Interest expense is a bank's cost of funds; pretax + interest is not an
    // EBIT (the first keyless rerun handed JPMorgan 72B + 97.9B as one).
    const built = buildStatementsFromCompanyFacts(
      bankInterest({ IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest: annual(72_000) }),
      { ...OPTS, symbol: "JPM" },
    );
    expect(built.incomeAnnual.rows[0]).toMatchObject({ operatingIncome: null, incomeBeforeTax: 72_000 });
    expect(built.incomeAnnual.substitutions).toEqual([]);
  });
});

describe("buildStatementsFromCompanyFacts — current maturities tagged together with finance leases", () => {
  const k = { form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-20" } as const;
  const at = (val: number): Pt[] => [{ end: "2025-12-31", val, ...k }];
  const row = (extra: Record<string, Pt[]>) =>
    buildStatementsFromCompanyFacts(
      facts({
        Revenues: [{ start: "2025-01-01", end: "2025-12-31", val: 1_000, ...k }],
        Assets: [{ end: "2025-12-31", val: 5_000, ...k }],
        CashAndCashEquivalentsAtCarryingValue: [{ end: "2025-12-31", val: 100, ...k }],
        ...extra,
      }),
      { ...OPTS, symbol: "X" },
    ).balanceAnnual;

  it("counts the combined current portion once when the noncurrent tag also carries finance leases", () => {
    // Home Depot's shape: current installments are tagged
    // LongTermDebtAndCapitalLeaseObligationsCurrent (debt + finance leases), the
    // noncurrent tag is LongTermDebtAndCapitalLeaseObligations, and the lease
    // liabilities are tagged in full. The finance leases then sit in the two
    // debt tags exactly once, so only the operating leases join the sum.
    const built = row({
      LongTermDebtAndCapitalLeaseObligations: at(500),
      LongTermDebtAndCapitalLeaseObligationsCurrent: at(40),
      FinanceLeaseLiability: at(30),
      FinanceLeaseLiabilityCurrent: at(5),
      OperatingLeaseLiability: at(70),
    });
    expect(built.rows[0]).toMatchObject({ shortTermDebt: 40, longTermDebt: 500, capitalLeaseObligations: 100, totalDebt: 610 });
    expect(built.notes).toContain("shortTermDebt 2025-12-31: from LongTermDebtAndCapitalLeaseObligationsCurrent");
    expect(built.notes.some((n) => /netted out of the lease component/.test(n))).toBe(false);
  });

  it("nets the finance-lease slice of the combined current portion out of the lease component", () => {
    const built = row({
      LongTermDebtNoncurrent: at(500),
      LongTermDebtAndCapitalLeaseObligationsCurrent: at(40),
      FinanceLeaseLiability: at(30),
      FinanceLeaseLiabilityCurrent: at(5),
      OperatingLeaseLiability: at(70),
    });
    // 40 + 500 + (100 − 5): the 5 of current finance leases is already inside the 40.
    expect(built.rows[0]).toMatchObject({ shortTermDebt: 40, longTermDebt: 500, capitalLeaseObligations: 100, totalDebt: 635 });
    expect(built.notes.some((n) => /^totalDebt 2025-12-31:/.test(n) && /netted out of the lease component/.test(n))).toBe(true);
  });

  it("says so when the finance-lease slice cannot be separated", () => {
    const built = row({
      LongTermDebtNoncurrent: at(500),
      LongTermDebtAndCapitalLeaseObligationsCurrent: at(40),
      FinanceLeaseLiability: at(30),
      OperatingLeaseLiability: at(70),
    });
    expect(built.rows[0]).toMatchObject({ shortTermDebt: 40, capitalLeaseObligations: 100, totalDebt: 640 });
    expect(built.notes.some((n) => /^totalDebt 2025-12-31:/.test(n) && /may be counted twice/.test(n))).toBe(true);
  });

  it("drops the combined current portion when LongTermDebtCurrent is tagged beside it", () => {
    const built = row({
      LongTermDebtNoncurrent: at(500),
      LongTermDebtCurrent: at(35),
      LongTermDebtAndCapitalLeaseObligationsCurrent: at(40),
    });
    expect(built.rows[0]).toMatchObject({ shortTermDebt: 35, longTermDebt: 500, totalDebt: 535 });
    expect(
      built.notes.some((n) => /^shortTermDebt 2025-12-31:/.test(n) && /LongTermDebtAndCapitalLeaseObligationsCurrent excluded/.test(n)),
    ).toBe(true);
  });
});

/** Append points to concepts `f` already has (`addTags` replaces a concept wholesale). */
function withPoints(f: CompanyFacts, extra: Record<string, Pt[]>): CompanyFacts {
  type Concept = { units: Record<string, unknown[]> };
  const base = f.facts["us-gaap"] as Record<string, Concept | undefined>;
  const merged: Record<string, unknown> = { ...base };
  for (const [tag, concept] of Object.entries(facts(extra).facts["us-gaap"] as Record<string, Concept>)) {
    const cur = base[tag];
    if (cur === undefined) {
      merged[tag] = concept;
      continue;
    }
    const units: Record<string, unknown[]> = { ...cur.units };
    for (const [unit, pts] of Object.entries(concept.units)) units[unit] = [...(units[unit] ?? []), ...pts];
    merged[tag] = { ...cur, units };
  }
  return { ...f, facts: { ...f.facts, "us-gaap": merged } };
}

describe("buildStatementsFromCompanyFacts — stock splits", () => {
  const SPLIT_TAG = "StockholdersEquityNoteStockSplitConversionRatio1";
  /** Apple's 4-for-1 split of 2020-08-28 with the FY2019 diluted count as first filed and as restated. */
  const split2020 = {
    [SPLIT_TAG]: [{ end: "2020-08-28", val: 4, form: "10-K", fp: "FY", fy: 2020, filed: "2020-10-30" }],
    WeightedAverageNumberOfDilutedSharesOutstanding: [
      { start: "2018-09-30", end: "2019-09-28", val: 4_648_913_000, form: "10-K", fp: "FY", fy: 2019, filed: "2019-10-31" },
      { start: "2018-09-30", end: "2019-09-28", val: 18_595_651_000, form: "10-K", fp: "FY", fy: 2020, filed: "2020-10-30" },
    ],
  };
  /** FY2016 as Apple filed it in 2016: pre-split EPS and share count, never restated in a later core form. */
  const fy2016 = { start: "2015-09-27", end: "2016-09-24", form: "10-K", fp: "FY", fy: 2016, filed: "2016-10-26" } as const;

  it("carries per-share and share-count facts filed before a split to the current share basis, money facts untouched", () => {
    const built = buildStatementsFromCompanyFacts(
      withPoints(appleLike(), {
        ...split2020,
        RevenueFromContractWithCustomerExcludingAssessedTax: [{ ...fy2016, val: 215_639 }],
        NetIncomeLoss: [{ ...fy2016, val: 45_687 }],
        EarningsPerShareDiluted: [{ ...fy2016, val: 8.31 }],
        WeightedAverageNumberOfDilutedSharesOutstanding: [
          ...split2020.WeightedAverageNumberOfDilutedSharesOutstanding,
          { ...fy2016, val: 5_500_281_000 },
        ],
      }),
      OPTS,
    );
    const rows = built.incomeAnnual.rows;
    expect(rows.map((r) => r.date)).toEqual(["2025-09-27", "2024-09-28", "2016-09-24"]);
    expect(rows[2]).toMatchObject({
      revenue: 215_639,
      netIncome: 45_687,
      epsDiluted: 2.0775,
      weightedAverageShsOutDil: 22_001_124_000,
    });
    // Filed after the split: already on the current basis, scaled by 1.
    expect(rows[0]).toMatchObject({ epsDiluted: 7.5, weightedAverageShsOutDil: 15_000 });
    expect(built.splits.events).toEqual([{ date: "2020-08-28", ratio: 4, tagged: 4, evidence: 4 }]);
    const note = `stock split 4-for-1 on 2020-08-28 (${SPLIT_TAG}, confirmed by restated share counts ×4): per-share and share-count facts filed before that date are restated to the post-split basis`;
    expect(built.splits.notes).toEqual([{ date: "2020-08-28", text: note, severity: "info" }]);
    for (const result of [built.incomeAnnual, built.incomeQuarterly, built.balanceAnnual, built.balanceQuarterly]) {
      expect(result.notes).toContain(note);
    }
    expect(built.cashflowAnnual.notes).not.toContain(note);
  });

  it("does not rescale a period whose dedup winner was already filed post-split", () => {
    const fy2018 = { start: "2017-10-01", end: "2018-09-29" };
    const built = buildStatementsFromCompanyFacts(
      withPoints(appleLike(), {
        ...split2020,
        RevenueFromContractWithCustomerExcludingAssessedTax: [
          { ...fy2018, val: 265_595, form: "10-K", fp: "FY", fy: 2018, filed: "2018-11-05" },
        ],
        NetIncomeLoss: [{ ...fy2018, val: 59_531, form: "10-K", fp: "FY", fy: 2018, filed: "2018-11-05" }],
        EarningsPerShareDiluted: [
          { ...fy2018, val: 11.91, form: "10-K", fp: "FY", fy: 2018, filed: "2018-11-05" },
          { ...fy2018, val: 2.98, form: "10-K", fp: "FY", fy: 2020, filed: "2020-10-30" },
        ],
      }),
      OPTS,
    );
    const fy18 = built.incomeAnnual.rows.find((r) => r.date === "2018-09-29");
    expect(fy18?.epsDiluted).toBe(2.98);
    expect(fy18?.fiscalYear).toBe("2018");
  });

  it("reports no splits and adds no notes when the concept is absent", () => {
    const built = buildStatementsFromCompanyFacts(appleLike(), OPTS);
    expect(built.splits).toEqual({ events: [], notes: [] });
    expect(built.incomeAnnual.rows[0]?.epsDiluted).toBe(7.5);
  });
});

describe("buildStatementsFromCompanyFacts — income-statement fallbacks", () => {
  const K = { form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" } as const;
  const annual = (val: number): Pt[] => [{ start: "2025-01-01", end: "2025-12-31", val, ...K }];
  const base = (extra: Record<string, Pt[]>): CompanyFacts =>
    facts({
      Revenues: annual(64_000),
      NetIncomeLoss: annual(6_200),
      Assets: [{ end: "2025-12-31", val: 210_000, ...K }],
      ...extra,
    });

  it("stands cash interest paid in for an interest-expense line the filer tags only by extension", () => {
    // Caterpillar and GE file no us-gaap interest-expense tag (extension tags
    // only) but both file InterestPaidNet; without it the keyless WACC, and
    // with it the whole DCF, vanished behind "cost of debt cannot be inferred".
    const built = buildStatementsFromCompanyFacts(
      base({ OperatingIncomeLoss: annual(11_151), InterestPaidNet: annual(1_842) }),
      { ...OPTS, symbol: "CAT" },
    );
    expect(built.incomeAnnual.rows[0]).toMatchObject({ interestExpense: 1_842, operatingIncome: 11_151 });
    expect(built.incomeAnnual.substitutions).toEqual([
      { field: "interestExpense", periods: ["2025-12-31"], text: expect.stringMatching(/^cash interest paid .*InterestPaidNet/) },
    ]);
  });

  it("prefers the income-statement interest tag over cash interest paid when both exist", () => {
    const built = buildStatementsFromCompanyFacts(
      base({ OperatingIncomeLoss: annual(11_151), InterestExpense: annual(2_671), InterestPaidNet: annual(2_739) }),
      { ...OPTS, symbol: "PFE" },
    );
    expect(built.incomeAnnual.rows[0]).toMatchObject({ interestExpense: 2_671 });
    expect(built.incomeAnnual.substitutions).toEqual([]);
  });

  it("derives EBIT as pretax income plus interest expense when no operating-income tag is filed", () => {
    // Pfizer reports no OperatingIncomeLoss line at all; the DCF was "not buildable".
    const built = buildStatementsFromCompanyFacts(
      base({
        IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest: annual(7_520),
        InterestExpense: annual(2_671),
      }),
      { ...OPTS, symbol: "PFE" },
    );
    expect(built.incomeAnnual.rows[0]).toMatchObject({ operatingIncome: 10_191, interestExpense: 2_671, incomeBeforeTax: 7_520 });
    expect(built.incomeAnnual.substitutions).toEqual([
      { field: "operatingIncome", periods: ["2025-12-31"], text: expect.stringMatching(/^EBIT derived as pretax income \+ interest expense/) },
    ]);
  });

  it("derives EBIT through the cash-interest stand-in and discloses each substitution under its own field", () => {
    // GE: no OperatingIncomeLoss and no us-gaap interest line, but pretax income and InterestPaidNet.
    const built = buildStatementsFromCompanyFacts(
      base({
        IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest: annual(10_000),
        InterestPaidNet: annual(882),
      }),
      { ...OPTS, symbol: "GE" },
    );
    expect(built.incomeAnnual.rows[0]).toMatchObject({ operatingIncome: 10_882, interestExpense: 882 });
    expect(built.incomeAnnual.substitutions.map((s) => s.field).sort()).toEqual(["interestExpense", "operatingIncome"]);
  });

  it("leaves operating income null when neither an operating-income nor an interest figure exists", () => {
    const built = buildStatementsFromCompanyFacts(
      base({ IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest: annual(7_520) }),
      { ...OPTS, symbol: "PFE" },
    );
    expect(built.incomeAnnual.rows[0]).toMatchObject({ operatingIncome: null, interestExpense: null });
    expect(built.incomeAnnual.substitutions).toEqual([]);
  });

  it("lists every period a substitution served, newest first", () => {
    const two = (a: number, b: number): Pt[] => [
      { start: "2025-01-01", end: "2025-12-31", val: a, ...K },
      { start: "2024-01-01", end: "2024-12-31", val: b, form: "10-K", fp: "FY", fy: 2024, filed: "2025-02-14" },
    ];
    const built = buildStatementsFromCompanyFacts(
      facts({
        Revenues: two(64_000, 60_000),
        NetIncomeLoss: two(6_200, 5_000),
        Assets: [
          { end: "2025-12-31", val: 210_000, ...K },
          { end: "2024-12-31", val: 200_000, form: "10-K", fp: "FY", fy: 2024, filed: "2025-02-14" },
        ],
        OperatingIncomeLoss: two(11_151, 10_000),
        InterestPaidNet: two(1_842, 1_700),
      }),
      { ...OPTS, symbol: "CAT" },
    );
    expect(built.incomeAnnual.substitutions).toEqual([
      { field: "interestExpense", periods: ["2025-12-31", "2024-12-31"], text: expect.any(String) },
    ]);
  });
});


describe("buildStatementsFromCompanyFacts — Caterpillar-style balance sheets", () => {
  const k = { form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-20" } as const;
  const at = (val: number): Pt[] => [{ end: "2025-12-31", val, ...k }];
  function catLike(extra: Record<string, Pt[]>): CompanyFacts {
    return facts({
      Revenues: [{ start: "2025-01-01", end: "2025-12-31", val: 64_000, ...k }],
      Assets: at(98_585),
      CashAndCashEquivalentsAtCarryingValue: at(9_980),
      ...extra,
    });
  }
  const build = (f: CompanyFacts) => buildStatementsFromCompanyFacts(f, { ...OPTS, symbol: "CAT" });

  it("derives parent equity from the total including noncontrolling interest less that interest", () => {
    const built = build(catLike({ StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest: at(21_318), MinorityInterest: at(18) }));
    expect(built.balanceAnnual.rows[0]).toMatchObject({ totalStockholdersEquity: 21_300, totalEquity: 21_318, minorityInterest: 18 });
    expect(built.balanceAnnual.substitutions).toEqual([
      { field: "totalStockholdersEquity", periods: ["2025-12-31"], text: expect.stringMatching(/^stockholders' equity derived as total equity including noncontrolling interest minus/) },
    ]);
  });

  it("lets the total including noncontrolling interest stand in when no interest is tagged", () => {
    const built = build(catLike({ StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest: at(21_318) }));
    expect(built.balanceAnnual.rows[0]).toMatchObject({ totalStockholdersEquity: 21_318 });
    expect(built.balanceAnnual.substitutions[0]?.text).toMatch(/^total equity including noncontrolling interest stands in/);
  });

  it("prefers the filed StockholdersEquity line and records nothing", () => {
    const built = build(catLike({ StockholdersEquity: at(21_000), StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest: at(21_318), MinorityInterest: at(318) }));
    expect(built.balanceAnnual.rows[0]).toMatchObject({ totalStockholdersEquity: 21_000 });
    expect(built.balanceAnnual.substitutions).toEqual([]);
  });

  it("takes current maturities from the debt maturity schedule when no balance-sheet current-maturities tag was filed", () => {
    // House rule D-13: DebtCurrent, then the balance-sheet current-debt lines;
    // the maturity schedule is a NOTE disclosure, so it stands in only for the
    // current-maturities component and only when that component's own tags miss.
    const built = build(catLike({
      LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths: at(7_120),
      LongTermDebtNoncurrent: at(30_696),
    }));
    const fy = built.balanceAnnual.rows[0]!;
    expect(fy.shortTermDebt).toBe(7_120);
    expect(fy.longTermDebt).toBe(30_696);
    expect(fy.totalDebt).toBe(37_816);
    expect(built.balanceAnnual.notes.some((n) => /current maturities taken from the debt maturity schedule \(LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths 7120\).*CURRENT MATURITIES ONLY.*filed annually only/.test(n))).toBe(true);
    // The stand-in is disclosed per period, not only in the run log.
    expect(built.balanceAnnual.substitutions).toEqual([
      {
        field: "shortTermDebt",
        periods: ["2025-12-31"],
        text: expect.stringMatching(/^current maturities of long-term debt from the debt maturity schedule/),
      },
    ]);
  });

  it("adds the schedule figure BESIDE short-term borrowings, which are a different instrument", () => {
    // Caterpillar FY2024 as filed: short-term borrowings 5,514 AND current
    // maturities of long-term debt 7,120, total current debt 12,634. CAT tags
    // the current maturities only by extension, so the only us-gaap source for
    // them is the maturity schedule. Treating that schedule as a step of the
    // whole chain dropped them the moment ShortTermBorrowings resolved and
    // published 5,514 — understating total debt by 7.12B (16.4%), straight
    // into net debt, EV, invested capital, ROIC and the DCF equity bridge.
    const built = build(catLike({
      ShortTermBorrowings: at(5_514),
      LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths: at(7_120),
      LongTermDebtNoncurrent: at(30_696),
    }));
    const fy = built.balanceAnnual.rows[0]!;
    expect(fy.shortTermDebt).toBe(12_634);
    expect(fy.totalDebt).toBe(43_330);
    expect(
      built.balanceAnnual.notes.some((n) =>
        /current maturities taken from the debt maturity schedule \(LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths 7120\).*CURRENT MATURITIES ONLY/.test(n),
      ),
    ).toBe(true);
    // The stand-in is still disclosed on the field it served, per period.
    expect(built.balanceAnnual.substitutions).toEqual([
      {
        field: "shortTermDebt",
        periods: ["2025-12-31"],
        text: expect.stringMatching(/^current maturities of long-term debt from the debt maturity schedule/),
      },
    ]);
  });

  it("does not double-count the schedule figure when a balance-sheet current-maturities tag resolved beside borrowings", () => {
    // Both components tagged on the balance sheet: 5,514 + 7,000 = 12,514, and
    // the schedule's 7,120 is named as excluded rather than added on top.
    const built = build(catLike({
      ShortTermBorrowings: at(5_514),
      LongTermDebtCurrent: at(7_000),
      LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths: at(7_120),
      LongTermDebtNoncurrent: at(30_696),
    }));
    const fy = built.balanceAnnual.rows[0]!;
    expect(fy.shortTermDebt).toBe(12_514);
    expect(fy.totalDebt).toBe(43_210);
    expect(built.balanceAnnual.substitutions).toEqual([]);
    expect(
      built.balanceAnnual.notes.some((n) =>
        /LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths excluded — the balance sheet's own current-debt tag resolved/.test(n),
      ),
    ).toBe(true);
  });

  it("says the schedule figure was left out when it could not be combined with the tags that resolved", () => {
    // The schedule filed in another currency: `sumAnyOf` drops the part rather
    // than adding euros to dollars, and the row says what it may be missing.
    const built = build(
      facts(
        {
          Revenues: [{ start: "2025-01-01", end: "2025-12-31", val: 64_000, ...k }],
          Assets: at(98_585),
          CashAndCashEquivalentsAtCarryingValue: at(9_980),
          ShortTermBorrowings: at(5_514),
          LongTermDebtNoncurrent: at(30_696),
          LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths: at(7_120),
        },
        {},
        { LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths: "EUR" },
      ),
    );
    const fy = built.balanceAnnual.rows[0]!;
    expect(fy.shortTermDebt).toBe(5_514);
    expect(
      built.balanceAnnual.notes.some((n) =>
        /did NOT enter the sum.*could not be combined with the tags that did resolve \(ShortTermBorrowings\)/.test(n),
      ),
    ).toBe(true);
  });

  it("drops the schedule figure beside a balance-sheet current-debt tag", () => {
    const built = build(catLike({
      LongTermDebtCurrent: at(7_000),
      LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths: at(7_120),
      LongTermDebtNoncurrent: at(30_696),
    }));
    expect(built.balanceAnnual.rows[0]).toMatchObject({ shortTermDebt: 7_000, totalDebt: 37_696 });
    expect(built.balanceAnnual.notes.some((n) => /LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths excluded — the balance sheet's own current-debt tag resolved/.test(n))).toBe(true);
  });

  it("nets the schedule figure out of a LongTermDebt total so the current portion counts once", () => {
    const built = build(catLike({
      LongTermDebt: at(37_816),
      LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths: at(7_120),
    }));
    expect(built.balanceAnnual.rows[0]).toMatchObject({ shortTermDebt: 7_120, longTermDebt: 30_696, totalDebt: 37_816 });
    expect(built.balanceAnnual.notes).toContain(
      "longTermDebt 2025-12-31: LongTermDebt less current maturities (LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths 7120)",
    );
  });
});

/* ---------------------------------------------------------------------------
 * WS4 — versioned tag synonyms, EBIT non-operating adjustments, multi-class
 * share counts, the duplicate-period rule and one filing lineage per derived
 * quarter.
 * ------------------------------------------------------------------------- */

describe("buildStatementsFromCompanyFacts — per-tag interest stand-in wording", () => {
  const K = { form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" } as const;
  const annual = (val: number): Pt[] => [{ start: "2025-01-01", end: "2025-12-31", val, ...K }];
  const base = (extra: Record<string, Pt[]>): CompanyFacts =>
    facts({
      Revenues: annual(64_000),
      NetIncomeLoss: annual(6_200),
      Assets: [{ end: "2025-12-31", val: 210_000, ...K }],
      OperatingIncomeLoss: annual(11_151),
      ...extra,
    });

  it("says InterestPaidNet EXCLUDES capitalized interest", () => {
    const built = buildStatementsFromCompanyFacts(base({ InterestPaidNet: annual(1_842) }), { ...OPTS, symbol: "CAT" });
    expect(built.incomeAnnual.rows[0]!.interestExpense).toBe(1_842);
    const text = built.incomeAnnual.substitutions[0]!.text;
    expect(text).toMatch(/net of capitalized interest/);
    expect(text).toMatch(/EXCLUDES the interest capitalized into assets/);
  });

  it("says InterestPaid INCLUDES capitalized interest", () => {
    const built = buildStatementsFromCompanyFacts(base({ InterestPaid: annual(1_900) }), { ...OPTS, symbol: "CAT" });
    expect(built.incomeAnnual.rows[0]!.interestExpense).toBe(1_900);
    const text = built.incomeAnnual.substitutions[0]!.text;
    expect(text).toMatch(/gross/);
    expect(text).toMatch(/INCLUDES the interest capitalized into assets/);
  });

  it("prefers the net cash tag over the gross one when a filer files both", () => {
    const built = buildStatementsFromCompanyFacts(
      base({ InterestPaidNet: annual(1_842), InterestPaid: annual(1_900) }),
      { ...OPTS, symbol: "CAT" },
    );
    expect(built.incomeAnnual.rows[0]!.interestExpense).toBe(1_842);
    expect(built.incomeAnnual.substitutions[0]!.text).toMatch(/InterestPaidNet/);
  });
});

describe("buildStatementsFromCompanyFacts — derived EBIT subtracts non-operating items", () => {
  const K = { form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" } as const;
  const annual = (val: number): Pt[] => [{ start: "2025-01-01", end: "2025-12-31", val, ...K }];
  const pretax = (extra: Record<string, Pt[]>): CompanyFacts =>
    facts({
      Revenues: annual(64_000),
      NetIncomeLoss: annual(6_200),
      Assets: [{ end: "2025-12-31", val: 210_000, ...K }],
      IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest: annual(7_520),
      InterestExpense: annual(2_671),
      ...extra,
    });
  const ebit = (f: CompanyFacts) => buildStatementsFromCompanyFacts(f, { ...OPTS, symbol: "PFE" }).incomeAnnual;

  it("removes the non-operating aggregate and equity-method results from the derivation", () => {
    const built = ebit(pretax({ NonoperatingIncomeExpense: annual(900), IncomeLossFromEquityMethodInvestments: annual(300) }));
    // 7,520 + 2,671 - 900 - 300
    expect(built.rows[0]!.operatingIncome).toBe(8_991);
    expect(built.substitutions[0]!.text).toMatch(
      /non-operating items subtracted from the derivation: NonoperatingIncomeExpense, IncomeLossFromEquityMethodInvestments/,
    );
  });

  it("does not subtract InvestmentIncomeInterest twice when the aggregate that contains it resolved", () => {
    const built = ebit(pretax({ NonoperatingIncomeExpense: annual(900), InvestmentIncomeInterest: annual(400) }));
    expect(built.rows[0]!.operatingIncome).toBe(9_291); // 7,520 + 2,671 - 900 only
    expect(built.substitutions[0]!.text).toMatch(
      /not subtracted separately because the aggregate already contains them: InvestmentIncomeInterest/,
    );
  });

  it("subtracts investment income on its own when the filer tags no aggregate", () => {
    const built = ebit(pretax({ InvestmentIncomeInterest: annual(400) }));
    expect(built.rows[0]!.operatingIncome).toBe(9_791); // 7,520 + 2,671 - 400
  });

  it("names the unavailable adjustments as the error band when none is filed", () => {
    const built = ebit(pretax({}));
    expect(built.rows[0]!.operatingIncome).toBe(10_191);
    expect(built.substitutions[0]!.text).toMatch(
      /error band — the filer tags none of NonoperatingIncomeExpense, InvestmentIncomeInterest, IncomeLossFromEquityMethodInvestments/,
    );
  });

  it("never derives an EBIT for a bank-style filer", () => {
    const bank = facts({
      RevenuesNetOfInterestExpense: annual(180_000),
      InterestIncomeExpenseNet: annual(90_000),
      NetIncomeLoss: annual(57_000),
      Assets: [{ end: "2025-12-31", val: 4_400_000, ...K }],
      IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest: annual(72_000),
      InterestExpense: annual(97_900),
      NonoperatingIncomeExpense: annual(500),
    });
    const built = buildStatementsFromCompanyFacts(bank, { ...OPTS, symbol: "JPM" });
    expect(built.incomeAnnual.rows[0]!.operatingIncome).toBeNull();
    expect(built.incomeAnnual.substitutions).toEqual([]);
  });
});

describe("buildStatementsFromCompanyFacts — multi-class cover-page share counts", () => {
  const multiClass = (): CompanyFacts =>
    JSON.parse(
      readFileSync(path.join(process.cwd(), "fixtures", "edgar", "multiclass_companyfacts.json"), "utf8"),
    ) as CompanyFacts;

  it("sums the per-class counts of one filing and discloses the breakdown", () => {
    const built = buildStatementsFromCompanyFacts(multiClass(), { ...OPTS, symbol: "TCEH", cik: "0009900001" });
    expect(built.shares.outstanding).toMatchObject({
      value: 10_000_000,
      asOf: "2026-02-13",
      basis: "dei cover page",
      classes: [5_000_000, 3_000_000, 2_000_000],
    });
    expect(built.shares.outstanding?.filing).toMatchObject({ accn: "0009900001-26-000004", form: "10-K" });
  });

  it("carries no class breakdown for a single-class filer", () => {
    const built = buildStatementsFromCompanyFacts(appleLike(), OPTS);
    expect(built.shares.outstanding).toMatchObject({ value: 14_776, basis: "dei cover page" });
    expect(built.shares.outstanding?.classes).toBeUndefined();
  });

  it("counts a byte-identical repeat of one class once", () => {
    const f = multiClass();
    const unit = (f.facts.dei!.EntityCommonStockSharesOutstanding as { units: { shares: unknown[] } }).units.shares;
    unit.push(structuredClone(unit[0]));
    const built = buildStatementsFromCompanyFacts(f, { ...OPTS, symbol: "TCEH", cik: "0009900001" });
    expect(built.shares.outstanding?.value).toBe(10_000_000);
  });

  it("discloses that a collapsed repeat may be a second class with the same count (N1)", () => {
    // Companyfacts drops the class dimension, so two classes with identical
    // counts are byte-identical facts. The repeat is still counted once — but
    // the ambiguity is stated rather than resolved silently.
    const f = multiClass();
    const unit = (f.facts.dei!.EntityCommonStockSharesOutstanding as { units: { shares: unknown[] } }).units.shares;
    unit.push(structuredClone(unit[0]));
    const built = buildStatementsFromCompanyFacts(f, { ...OPTS, symbol: "TCEH", cik: "0009900001" });
    const [note] = built.shares.outstanding!.classNotes!;
    expect(note).toMatch(/carries 4 dei:EntityCommonStockSharesOutstanding facts for 2026-02-13 but only 3 distinct value/);
    expect(note).toMatch(/indistinguishable from a SECOND SHARE CLASS/);
    expect(note).toMatch(/understates the registered shares/);
  });

  it("adds no class caveat when every per-class count is distinct and comparable", () => {
    const built = buildStatementsFromCompanyFacts(multiClass(), { ...OPTS, symbol: "TCEH", cik: "0009900001" });
    expect(built.shares.outstanding?.classNotes).toBeUndefined();
  });

  it("warns when one class dwarfs another by more than a hundredfold (N2)", () => {
    // Berkshire's shape: the B class converts 1:1500 to an A share, so a raw
    // sum of the two counts is an order of magnitude away from economic
    // ownership and companyfacts carries no conversion ratio.
    const built = buildStatementsFromCompanyFacts(
      facts(
        {
          Revenues: [{ start: "2025-01-01", end: "2025-12-31", val: 1_000, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-20" }],
          Assets: [{ end: "2025-12-31", val: 5_000, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-20" }],
        },
        {
          EntityCommonStockSharesOutstanding: [
            { end: "2026-02-13", val: 550_000, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-20", accn: "0000000000-26-000001" },
            { end: "2026-02-13", val: 1_290_000_000, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-20", accn: "0000000000-26-000001" },
          ],
        },
      ),
      { ...OPTS, symbol: "BRKB" },
    );
    expect(built.shares.outstanding?.value).toBe(1_290_550_000);
    const [note] = built.shares.outstanding!.classNotes!;
    expect(note).toMatch(/differ by a factor of 2345/);
    expect(note).toMatch(/SAME per-share economics/);
    expect(note).toMatch(/must not be read as economically weighted ownership/);
  });
});

describe("buildStatementsFromCompanyFacts — duplicate periods and restatements", () => {
  const K = { form: "10-K", fp: "FY", fy: 2025 } as const;
  const restated = (originalRevenue: number, revisedRevenue: number): CompanyFacts =>
    facts({
      Revenues: [
        { start: "2025-01-01", end: "2025-12-31", val: originalRevenue, ...K, filed: "2026-02-13", accn: "0000000000-26-000001" },
        { start: "2025-01-01", end: "2025-12-31", val: revisedRevenue, ...K, filed: "2027-02-12", accn: "0000000000-27-000001" },
      ],
      NetIncomeLoss: [
        { start: "2025-01-01", end: "2025-12-31", val: 57_048, ...K, filed: "2026-02-13", accn: "0000000000-26-000001" },
      ],
      Assets: [{ end: "2025-12-31", val: 4_424_900, ...K, filed: "2026-02-13", accn: "0000000000-26-000001" }],
    });

  it("keeps the last-filed value, retains the superseded one as original, and flags a material move", () => {
    const built = buildStatementsFromCompanyFacts(restated(182_447, 190_000), { ...OPTS, symbol: "JPM" });
    const row = built.incomeAnnual.rows[0] as Record<string, unknown>;
    expect(row.revenue).toBe(190_000);
    expect(row.original).toMatchObject({
      revenue: { value: 182_447, accn: "0000000000-26-000001", filed: "2026-02-13", form: "10-K" },
    });
    expect(built.incomeAnnual.restatements).toEqual([
      {
        date: "2025-12-31",
        field: "revenue",
        original: 182_447,
        restated: 190_000,
        changePct: expect.closeTo(4.1399, 3),
        originalFiling: { accn: "0000000000-26-000001", filed: "2026-02-13", form: "10-K" },
        restatedFiling: { accn: "0000000000-27-000001", filed: "2027-02-12", form: "10-K" },
      },
    ]);
    expect(row.restatement).toEqual(built.incomeAnnual.restatements);
    expect(built.incomeAnnual.notes.some((n) => /revenue restated from 182447 .* to 190000 .*\+4\.14%/.test(n))).toBe(true);
  });

  it("keeps the original value but raises no flag for a move within one percent", () => {
    const built = buildStatementsFromCompanyFacts(restated(182_447, 183_000), { ...OPTS, symbol: "JPM" });
    const row = built.incomeAnnual.rows[0] as Record<string, unknown>;
    expect(row.revenue).toBe(183_000);
    expect((row.original as Record<string, { value: number }>).revenue.value).toBe(182_447);
    expect(built.incomeAnnual.restatements).toEqual([]);
    expect(row.restatement).toBeUndefined();
  });

  it("adds neither key when no period was refiled with a different value", () => {
    const built = buildStatementsFromCompanyFacts(appleLike(), OPTS);
    const row = built.incomeAnnual.rows[0] as Record<string, unknown>;
    expect(row.original).toBeUndefined();
    expect(built.incomeAnnual.restatements).toEqual([]);
    expect(built.balanceAnnual.restatements).toEqual([]);
  });
});

describe("buildStatementsFromCompanyFacts — one filing lineage per derived quarter", () => {
  /** FY revenue plus Q3 year-to-date revenue, optionally restated in a later filing. */
  const lineage = (opts: { originalYtd: boolean; laterYtd: boolean }): CompanyFacts => {
    const rows: Pt[] = [
      { start: "2025-01-01", end: "2025-12-31", val: 400, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13", accn: "0000000000-26-000001" },
    ];
    if (opts.originalYtd) {
      rows.push({ start: "2025-01-01", end: "2025-09-30", val: 300, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-10-30", accn: "0000000000-25-000003" });
    }
    if (opts.laterYtd) {
      rows.push({ start: "2025-01-01", end: "2025-09-30", val: 280, form: "10-Q", fp: "Q3", fy: 2025, filed: "2026-05-01", accn: "0000000000-26-000009" });
    }
    return facts({
      Revenues: rows,
      NetIncomeLoss: [{ start: "2025-01-01", end: "2025-12-31", val: 100, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" }],
      Assets: [
        { end: "2025-12-31", val: 900, form: "10-K", fp: "FY", fy: 2025, filed: "2026-02-13" },
        { end: "2025-09-30", val: 880, form: "10-Q", fp: "Q3", fy: 2025, filed: "2025-10-30" },
      ],
    });
  };
  const q4Revenue = (f: CompanyFacts): { value: number | null; notes: string[] } => {
    const built = buildStatementsFromCompanyFacts(f, { ...OPTS, symbol: "LIN" });
    const row = built.incomeQuarterly.rows.find((r) => r.date === "2025-12-31");
    return { value: row?.revenue ?? null, notes: built.incomeQuarterly.notes };
  };

  it("derives the fourth quarter from the year-to-date copy the annual filing itself reported", () => {
    expect(q4Revenue(lineage({ originalYtd: true, laterYtd: false })).value).toBe(100); // 400 - 300
  });

  it("keeps using that copy when a LATER filing restated the year-to-date figure", () => {
    // The dedup winner for the year-to-date period is the 2026-05-01 copy (280),
    // but it belongs to a filing the 10-K could not have known about: netting it
    // against the 10-K FY figure would publish a quarter neither filing reported.
    expect(q4Revenue(lineage({ originalYtd: true, laterYtd: true })).value).toBe(100);
  });

  it("refuses the derivation, and says why, when every year-to-date copy is younger than the annual fact", () => {
    const out = q4Revenue(lineage({ originalYtd: false, laterYtd: true }));
    expect(out.value).toBeNull();
    expect(
      out.notes.some((n) =>
        /Revenues 2025-12-31: FY − YTD not derived — no year-to-date fact filed on or before the 10-K of 2026-02-13 .*mix two filing lineages/.test(n),
      ),
    ).toBe(true);
  });
});
