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

const OPTS = { symbol: "AAPL", cik: "0000320193", annualPeriods: 10, quarterlyPeriods: 24 };

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
      outstanding: { value: 14_776, asOf: "2025-10-17" },
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
