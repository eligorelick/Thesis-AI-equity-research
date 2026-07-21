/**
 * Stage A validation — pure unit tests on synthetic bundles (no network/db).
 *
 * Anchor values from Phase 0 research (the application contract §11):
 *  - AAPL FY2025: revenue 416.161B, net income 112.010B (accn 0000320193-25-000079)
 *  - JPM FY2025: net revenue 182.447B = NII 95.443B + NonII 87.004B (identity
 *    exact); net income 57.048B — the 57.000B DEF-14A rounded value is the
 *    dedup trap.
 */
import { describe, expect, it } from "vitest";
import type { FetchResult, ManifestEntry, Sourced } from "@/types/core";
import type { CompanyFacts } from "@/edgar/xbrl";
import {
  IDENTITY_TOLERANCE_PCT,
  IMPLAUSIBLE_ZERO_FIELDS,
  validateBundle,
  type ValidatableBundle,
  type ValidateBalanceRow,
  type ValidateIncomeRow,
} from "@/pipeline/stageA/validate";
import {
  derive13FCoverage,
  latestQuarterEndOnOrBefore,
  quarterEndIso,
  resolve13FQuarter,
} from "@/pipeline/types";

const NOW = new Date("2026-07-06T00:00:00Z");

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function ok<T>(data: T, asOf: string, extra: Partial<Sourced<T>> = {}): FetchResult<T> {
  return {
    ok: true,
    value: {
      data,
      asOf,
      source: "fmp",
      endpoint: "test://fixture",
      fetchedAt: "2026-07-05T12:00:00.000Z",
      ...extra,
    },
  };
}

function gap<T>(field: string, reason = "synthetic gap"): FetchResult<T> {
  const g: ManifestEntry = { field, reason, severity: "warn" };
  return { ok: false, gap: g };
}

interface XbrlPoint {
  start?: string;
  end: string;
  val: number;
  accn?: string;
  form?: string;
  filed?: string;
  fy?: number | null;
  fp?: string | null;
  frame?: string;
}

function xp(p: XbrlPoint): Record<string, unknown> {
  return {
    accn: "0000000000-26-000001",
    form: "10-K",
    filed: "2025-10-31",
    fy: 2025,
    fp: "FY",
    ...p,
  };
}

function makeFacts(tags: Record<string, Record<string, unknown>[]>, unit = "USD"): CompanyFacts {
  const usGaap: Record<string, unknown> = {};
  for (const [tag, points] of Object.entries(tags)) {
    usGaap[tag] = { label: tag, units: { [unit]: points } };
  }
  return { cik: 320193, entityName: "Test Co", facts: { "us-gaap": usGaap } };
}

/** AAPL-flavored default facts matching the default statement rows. */
function aaplFacts(): CompanyFacts {
  return makeFacts({
    RevenueFromContractWithCustomerExcludingAssessedTax: [
      xp({ start: "2024-09-29", end: "2025-09-27", val: 416_161_000_000 }),
      xp({ start: "2025-12-28", end: "2026-03-28", val: 111_184_000_000, form: "10-Q", filed: "2026-05-02", fp: "Q2" }),
    ],
    NetIncomeLoss: [
      xp({ start: "2024-09-29", end: "2025-09-27", val: 112_010_000_000 }),
      xp({ start: "2025-12-28", end: "2026-03-28", val: 30_000_000_000, form: "10-Q", filed: "2026-05-02", fp: "Q2" }),
    ],
  });
}

function annualIncomeRows(): ValidateIncomeRow[] {
  return [
    {
      date: "2025-09-27",
      period: "FY",
      fiscalYear: "2025",
      revenue: 416_161_000_000,
      netIncome: 112_010_000_000,
      interestExpense: 0, // FMP zero-for-undisclosed artifact (real AAPL sample)
      sellingGeneralAndAdministrativeExpenses: 27_023_000_000,
    },
  ];
}

function quarterlyIncomeRows(): ValidateIncomeRow[] {
  return [
    {
      date: "2026-03-28",
      period: "Q2",
      fiscalYear: "2026",
      revenue: 111_184_000_000,
      netIncome: 30_000_000_000,
      interestExpense: 500_000_000,
      sellingGeneralAndAdministrativeExpenses: 6_500_000_000,
    },
  ];
}

function balanceRows(): ValidateBalanceRow[] {
  return [
    { date: "2025-09-27", totalAssets: 100e9, totalLiabilities: 60e9, totalEquity: 40e9 },
    { date: "2024-09-28", totalAssets: 90e9, totalLiabilities: 55e9, totalEquity: 35e9 },
    { date: "2023-09-30", totalAssets: 80e9, totalLiabilities: 50e9, totalEquity: 30e9 },
    { date: "2022-09-24", totalAssets: 70e9, totalLiabilities: 45e9, totalEquity: 25e9 },
  ];
}

interface BundleOverrides {
  incomeAnnual?: FetchResult<{ rows: ValidateIncomeRow[] }>;
  incomeQuarterly?: FetchResult<{ rows: ValidateIncomeRow[] }>;
  balanceAnnual?: FetchResult<{ rows: ValidateBalanceRow[] }>;
  quote?: FetchResult<unknown>;
  institutional?: ValidatableBundle["institutional"];
  companyFacts?: FetchResult<CompanyFacts>;
}

function makeBundle(overrides: BundleOverrides = {}): ValidatableBundle {
  return {
    symbol: "AAPL",
    quote: overrides.quote ?? ok({ rows: [{ price: 232.8 }] }, "2026-07-03"),
    statements: {
      incomeAnnual: overrides.incomeAnnual ?? ok({ rows: annualIncomeRows() }, "2025-09-27"),
      incomeQuarterly: overrides.incomeQuarterly ?? ok({ rows: quarterlyIncomeRows() }, "2026-03-28"),
      balanceAnnual: overrides.balanceAnnual ?? ok({ rows: balanceRows() }, "2025-09-27"),
    },
    institutional:
      overrides.institutional ??
      {
        year: 2026,
        quarter: 1,
        quarterEnd: "2026-03-31",
        positionsSummary: ok({ rows: [{ date: "2026-03-31" }] }, "2026-03-31"),
      },
    edgar: {
      companyFacts: overrides.companyFacts ?? ok(aaplFacts(), "2026-07-05"),
    },
  };
}

function check(bundle: ValidatableBundle, id: string) {
  const report = validateBundle(bundle, { now: NOW });
  const found = report.checks.find((c) => c.id === id);
  if (found === undefined) {
    throw new Error(`check "${id}" not found; have: ${report.checks.map((c) => c.id).join(", ")}`);
  }
  return { report, check: found };
}

describe("currency consistency (audit 2026-07-11 #6)", () => {
  const withCurrencies = (trading: string, reporting: string): ValidatableBundle => ({
    ...makeBundle({
      incomeAnnual: ok(
        {
          rows: [
            {
              date: "2025-09-27",
              period: "FY",
              fiscalYear: "2025",
              revenue: 100e9,
              netIncome: 20e9,
              reportedCurrency: reporting,
            },
          ],
        },
        "2025-09-27",
      ),
    }),
    profile: ok({ rows: [{ symbol: "X", currency: trading }] }, "2026-07-05"),
  });

  it("warns (read-only, no suppression) when reporting currency differs from trading currency", () => {
    const report = validateBundle(withCurrencies("USD", "TWD"), { now: NOW });
    const cc = report.checks.find((c) => c.id === "currencyConsistency");
    expect(cc?.status).toBe("warn");
    expect(report.gaps.some((g) => g.field === "validation.currencyMismatch" && g.severity === "warn")).toBe(true);
  });

  it("passes and emits no gap when reporting and trading currencies match", () => {
    const report = validateBundle(withCurrencies("USD", "USD"), { now: NOW });
    const cc = report.checks.find((c) => c.id === "currencyConsistency");
    expect(cc?.status).toBe("pass");
    expect(report.gaps.some((g) => g.field === "validation.currencyMismatch")).toBe(false);
  });

  it("skips when the profile trading currency is unavailable", () => {
    const report = validateBundle(makeBundle(), { now: NOW });
    const cc = report.checks.find((c) => c.id === "currencyConsistency");
    expect(cc?.status).toBe("skipped");
  });
});

describe("balance-sheet identity zero-liability handling", () => {
  it("does not manufacture a failure when zero liabilities are ambiguous", () => {
    const { check: result } = check(
      makeBundle({
        balanceAnnual: ok({
          rows: [{ date: "2025-09-27", totalAssets: 100, totalLiabilities: 0, totalEquity: 40 }],
        }, "2025-09-27"),
      }),
      "balanceSheetIdentity.2025-09-27",
    );
    expect(result.status).toBe("skipped");
    expect(result.detail).toMatch(/zero liabilities|ambiguous/i);
  });

  it("accepts a legitimate zero-liability identity when it balances", () => {
    const { check: result } = check(
      makeBundle({
        balanceAnnual: ok({
          rows: [{ date: "2025-09-27", totalAssets: 100, totalLiabilities: 0, totalEquity: 100 }],
        }, "2025-09-27"),
      }),
      "balanceSheetIdentity.2025-09-27",
    );
    expect(result.status).toBe("pass");
  });
});

describe("FMP-XBRL currency guard", () => {
  it("skips numeric cross-checks when statement and XBRL currencies differ", () => {
    const bundle = makeBundle({
      incomeAnnual: ok(
        {
          rows: [{
            date: "2025-09-27",
            period: "FY",
            fiscalYear: "2025",
            revenue: 100,
            netIncome: 20,
            reportedCurrency: "TWD",
          }],
        },
        "2025-09-27",
      ),
      companyFacts: ok(
        makeFacts({
          RevenueFromContractWithCustomerExcludingAssessedTax: [xp({ start: "2024-09-29", end: "2025-09-27", val: 100 })],
          NetIncomeLoss: [xp({ start: "2024-09-29", end: "2025-09-27", val: 20 })],
        }, "USD"),
        "2025-09-27",
      ),
    });
    const report = validateBundle(bundle, { now: NOW });
    const revenue = report.checks.find((c) => c.id === "xbrlCrossCheck.revenue.FY.2025-09-27");
    expect(revenue?.status).toBe("skipped");
    expect(revenue?.detail).toMatch(/currency/i);
  });
});

// ---------------------------------------------------------------------------
// Calendar helpers (shared 13F quarter-resolution rule)
// ---------------------------------------------------------------------------

describe("resolve13FQuarter", () => {
  it("picks the latest quarter ended >= 45 days ago", () => {
    expect(resolve13FQuarter(new Date("2026-07-06T00:00:00Z"))).toEqual({
      year: 2026,
      quarter: 1,
      quarterEnd: "2026-03-31",
    });
  });

  it("flips exactly at quarter end + 45 days", () => {
    // Q1 2026 ends 2026-03-31; +45 d = 2026-05-15.
    expect(resolve13FQuarter(new Date("2026-05-15T00:00:00Z")).quarter).toBe(1);
    expect(resolve13FQuarter(new Date("2026-05-14T23:00:00Z"))).toEqual({
      year: 2025,
      quarter: 4,
      quarterEnd: "2025-12-31",
    });
  });

  it("crosses year boundaries", () => {
    expect(resolve13FQuarter(new Date("2026-01-20T00:00:00Z"))).toEqual({
      year: 2025,
      quarter: 3,
      quarterEnd: "2025-09-30",
    });
  });
});

describe("derive13FCoverage", () => {
  it("uses the latest valid returned row date instead of the requested quarter", () => {
    expect(
      derive13FCoverage(
        [{ date: "2025-12-31" }, { date: "not-a-date" }, { date: "2026-03-31" }],
        { year: 2026, quarter: 2, quarterEnd: "2026-06-30" },
        new Date("2026-07-06T00:00:00Z"),
      ),
    ).toEqual({ year: 2026, quarter: 1, quarterEnd: "2026-03-31" });
  });

  it("falls back to the requested quarter when returned dates are invalid or future-dated", () => {
    expect(
      derive13FCoverage(
        [{ date: "2026-12-31" }, { date: "bad" }],
        { year: 2026, quarter: 2, quarterEnd: "2026-06-30" },
        new Date("2026-07-06T00:00:00Z"),
      ),
    ).toEqual({ year: 2026, quarter: 2, quarterEnd: "2026-06-30" });
  });
});

describe("quarter helpers", () => {
  it("quarterEndIso maps quarters to calendar ends", () => {
    expect(quarterEndIso(2026, 1)).toBe("2026-03-31");
    expect(quarterEndIso(2026, 4)).toBe("2026-12-31");
  });

  it("latestQuarterEndOnOrBefore returns the latest quarter end not after the date", () => {
    expect(latestQuarterEndOnOrBefore(new Date("2026-03-08T00:00:00Z"))).toBe("2025-12-31");
    expect(latestQuarterEndOnOrBefore(new Date("2026-03-31T00:00:00Z"))).toBe("2026-03-31");
    expect(latestQuarterEndOnOrBefore(new Date("2026-01-01T00:00:00Z"))).toBe("2025-12-31");
  });
});

// ---------------------------------------------------------------------------
// 1. Balance-sheet identity
// ---------------------------------------------------------------------------

describe("balance-sheet identity", () => {
  it("passes when assets = liabilities + equity exactly", () => {
    const { check: c } = check(makeBundle(), "balanceSheetIdentity.2025-09-27");
    expect(c.status).toBe("pass");
    expect(c.deltaPct).toBe(0);
  });

  it("passes at 0.4% delta and fails at 0.6% (0.5% tolerance edge)", () => {
    const passRow: ValidateBalanceRow = {
      date: "2025-09-27",
      totalAssets: 100e9,
      totalLiabilities: 60e9,
      totalEquity: 39.6e9, // |100 - 99.6| / 100 = 0.4%
    };
    const failRow: ValidateBalanceRow = {
      date: "2025-09-27",
      totalAssets: 100e9,
      totalLiabilities: 60e9,
      totalEquity: 39.4e9, // 0.6%
    };
    const passCheck = check(
      makeBundle({ balanceAnnual: ok({ rows: [passRow] }, "2025-09-27") }),
      "balanceSheetIdentity.2025-09-27",
    ).check;
    expect(passCheck.status).toBe("pass");
    expect(passCheck.deltaPct).toBeCloseTo(0.4, 6);

    const { report, check: failCheck } = check(
      makeBundle({ balanceAnnual: ok({ rows: [failRow] }, "2025-09-27") }),
      "balanceSheetIdentity.2025-09-27",
    );
    expect(failCheck.status).toBe("fail");
    expect(failCheck.deltaPct).toBeCloseTo(0.6, 6);
    expect(
      report.gaps.some((g) => g.field === "validation.balanceSheetIdentity.2025-09-27"),
    ).toBe(true);
  });

  it("checks only the latest 4 annual periods", () => {
    const rows = balanceRows();
    rows.push({ date: "2021-09-25", totalAssets: 60e9, totalLiabilities: 60e9, totalEquity: 60e9 }); // wildly broken 5th
    const report = validateBundle(makeBundle({ balanceAnnual: ok({ rows }, "2025-09-27") }), { now: NOW });
    const identityChecks = report.checks.filter((c) => c.id.startsWith("balanceSheetIdentity."));
    expect(identityChecks).toHaveLength(4);
    expect(identityChecks.some((c) => c.id.includes("2021-09-25"))).toBe(false);
  });

  it("falls back to totalStockholdersEquity + minorityInterest when totalEquity is 0 (undisclosed)", () => {
    const row: ValidateBalanceRow = {
      date: "2025-09-27",
      totalAssets: 100e9,
      totalLiabilities: 60e9,
      totalEquity: 0,
      totalStockholdersEquity: 38e9,
      minorityInterest: 2e9,
    };
    const { check: c } = check(
      makeBundle({ balanceAnnual: ok({ rows: [row] }, "2025-09-27") }),
      "balanceSheetIdentity.2025-09-27",
    );
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("totalStockholdersEquity+minorityInterest");
  });

  it("skips (with a gap) when totalAssets is missing or zero", () => {
    const row: ValidateBalanceRow = { date: "2025-09-27", totalLiabilities: 60e9, totalEquity: 40e9 };
    const { report, check: c } = check(
      makeBundle({ balanceAnnual: ok({ rows: [row] }, "2025-09-27") }),
      "balanceSheetIdentity.2025-09-27",
    );
    expect(c.status).toBe("skipped");
    expect(report.gaps.some((g) => g.field.includes("balanceSheetIdentity.2025-09-27"))).toBe(true);
  });

  it("skips entirely (with a gap) when the balance sheet is a gap", () => {
    const { report, check: c } = check(
      makeBundle({ balanceAnnual: gap("fmp.balanceSheet(AAPL,annual)") }),
      "balanceSheetIdentity",
    );
    expect(c.status).toBe("skipped");
    expect(report.gaps.some((g) => g.field === "validation.balanceSheetIdentity")).toBe(true);
  });

  it("annotates the tolerance as a house rule in flags", () => {
    const report = validateBundle(makeBundle(), { now: NOW });
    expect(report.flags.some((f) => f.includes(`${IDENTITY_TOLERANCE_PCT}%`) && f.includes("House rule"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. FMP ↔ XBRL cross-check
// ---------------------------------------------------------------------------

describe("FMP↔XBRL cross-check", () => {
  it("passes on the AAPL FY2025 anchor values (revenue 416.161B, NI 112.010B)", () => {
    const report = validateBundle(makeBundle(), { now: NOW });
    const rev = report.checks.find((c) => c.id === "xbrlCrossCheck.revenue.FY.2025-09-27");
    const ni = report.checks.find((c) => c.id === "xbrlCrossCheck.netIncome.FY.2025-09-27");
    expect(rev?.status).toBe("pass");
    expect(rev?.deltaPct).toBe(0);
    expect(ni?.status).toBe("pass");
    expect(ni?.deltaPct).toBe(0);
  });

  it("cross-checks the latest quarter with a Q duration hint", () => {
    const report = validateBundle(makeBundle(), { now: NOW });
    const rev = report.checks.find((c) => c.id === "xbrlCrossCheck.revenue.Q.2026-03-28");
    expect(rev?.status).toBe("pass");
    expect(rev?.deltaPct).toBe(0);
  });

  it("passes at 0.4% deviation and fails at 0.6% (0.5% tolerance edge)", () => {
    const facts = makeFacts({
      RevenueFromContractWithCustomerExcludingAssessedTax: [
        xp({ start: "2024-09-29", end: "2025-09-27", val: 100e9 }),
      ],
      NetIncomeLoss: [xp({ start: "2024-09-29", end: "2025-09-27", val: 25e9 })],
    });
    const rowsFor = (revenue: number): ValidateIncomeRow[] => [
      { date: "2025-09-27", period: "FY", revenue, netIncome: 25e9 },
    ];

    const passReport = validateBundle(
      makeBundle({
        companyFacts: ok(facts, "2026-07-05"),
        incomeAnnual: ok({ rows: rowsFor(100.4e9) }, "2025-09-27"),
        incomeQuarterly: gap("fmp.incomeStatement(AAPL,quarter)"),
      }),
      { now: NOW },
    );
    const passCheck = passReport.checks.find((c) => c.id === "xbrlCrossCheck.revenue.FY.2025-09-27");
    expect(passCheck?.status).toBe("pass");
    expect(passCheck?.deltaPct).toBeCloseTo(0.4, 6);

    const failReport = validateBundle(
      makeBundle({
        companyFacts: ok(facts, "2026-07-05"),
        incomeAnnual: ok({ rows: rowsFor(100.6e9) }, "2025-09-27"),
        incomeQuarterly: gap("fmp.incomeStatement(AAPL,quarter)"),
      }),
      { now: NOW },
    );
    const failCheck = failReport.checks.find((c) => c.id === "xbrlCrossCheck.revenue.FY.2025-09-27");
    expect(failCheck?.status).toBe("fail");
    expect(failCheck?.deltaPct).toBeCloseTo(0.6, 6);
    expect(failReport.gaps.some((g) => g.field.includes("xbrlCrossCheck.revenue.FY"))).toBe(true);
  });

  it("O-style: netIncome resolved via the ProfitLoss fallback (NCI/consolidated nuance) downgrades a >0.5% mismatch to 'warn', not 'fail' (2026-07 audit finding 9)", () => {
    // NO NetIncomeLoss tag for this period at all — forces resolution through
    // the ProfitLoss fallback, exactly like the live O Q1-2026 case (FMP
    // 311,766,000 vs XBRL ProfitLoss 320,935,000, Δ≈2.857%, tolerance 0.5%).
    const facts = makeFacts({
      ProfitLoss: [xp({ start: "2026-01-01", end: "2026-03-31", val: 320_935_000, form: "10-Q", filed: "2026-05-08", fp: "Q1" })],
    });
    const report = validateBundle(
      makeBundle({
        companyFacts: ok(facts, "2026-07-05"),
        incomeAnnual: gap("fmp.incomeStatement(O,annual)"),
        incomeQuarterly: ok({ rows: [{ date: "2026-03-31", period: "Q1", revenue: 400_000_000, netIncome: 311_766_000 }] }, "2026-03-31"),
      }),
      { now: NOW },
    );
    const ni = report.checks.find((c) => c.id === "xbrlCrossCheck.netIncome.Q.2026-03-31");
    expect(ni?.status).toBe("warn");
    expect(ni?.deltaPct).toBeCloseTo(2.8569648059575927, 6); // tolerance number itself is unchanged
    expect(ni?.detail).toContain("ProfitLoss");
    expect(ni?.detail).toMatch(/consolidated|noncontrolling/i);
    expect(report.gaps.some((g) => g.field.includes("xbrlCrossCheck.netIncome.Q") && g.severity === "warn")).toBe(true);
  });

  it("control: the SAME magnitude mismatch resolved via primary NetIncomeLoss keeps 'fail' (downgrade is scoped to the ProfitLoss fallback only)", () => {
    const facts = makeFacts({
      NetIncomeLoss: [xp({ start: "2026-01-01", end: "2026-03-31", val: 320_935_000, form: "10-Q", filed: "2026-05-08", fp: "Q1" })],
    });
    const report = validateBundle(
      makeBundle({
        companyFacts: ok(facts, "2026-07-05"),
        incomeAnnual: gap("fmp.incomeStatement(O,annual)"),
        incomeQuarterly: ok({ rows: [{ date: "2026-03-31", period: "Q1", revenue: 400_000_000, netIncome: 311_766_000 }] }, "2026-03-31"),
      }),
      { now: NOW },
    );
    const ni = report.checks.find((c) => c.id === "xbrlCrossCheck.netIncome.Q.2026-03-31");
    expect(ni?.status).toBe("fail");
    expect(ni?.detail).toContain("NetIncomeLoss");
  });

  it("resolves JPM FY2025 revenue via the bank chain (NII 95.443B + NonII 87.004B = 182.447B)", () => {
    // No RevenueFromContractWithCustomer*, no Revenues → chain must fall
    // through to the computed NII+NonII sum (verified identity, SPEC §11).
    const facts = makeFacts({
      InterestIncomeExpenseNet: [
        xp({ start: "2025-01-01", end: "2025-12-31", val: 95_443_000_000, filed: "2026-02-20", accn: "jpm-10k" }),
      ],
      NoninterestIncome: [
        xp({ start: "2025-01-01", end: "2025-12-31", val: 87_004_000_000, filed: "2026-02-20", accn: "jpm-10k" }),
      ],
      NetIncomeLoss: [
        xp({ start: "2025-01-01", end: "2025-12-31", val: 57_048_000_000, filed: "2026-02-20", accn: "jpm-10k" }),
        // The DEF 14A dedup trap: rounded value, filed LATER, carries a frame.
        xp({
          start: "2025-01-01",
          end: "2025-12-31",
          val: 57_000_000_000,
          form: "DEF 14A",
          filed: "2026-04-01",
          fy: null,
          fp: null,
          frame: "CY2025",
          accn: "jpm-def14a",
        }),
      ],
    });
    const jpmIncome: ValidateIncomeRow[] = [
      { date: "2025-12-31", period: "FY", revenue: 182_447_000_000, netIncome: 57_048_000_000 },
    ];
    const report = validateBundle(
      makeBundle({
        companyFacts: ok(facts, "2026-07-05"),
        incomeAnnual: ok({ rows: jpmIncome }, "2025-12-31"),
        incomeQuarterly: gap("fmp.incomeStatement(JPM,quarter)"),
      }),
      { now: NOW },
    );

    const rev = report.checks.find((c) => c.id === "xbrlCrossCheck.revenue.FY.2025-12-31");
    expect(rev?.status).toBe("pass");
    expect(rev?.deltaPct).toBe(0);
    expect(rev?.detail).toContain("InterestIncomeExpenseNet+NoninterestIncome");
    expect(rev?.detail).toContain("computed sum");

    // Dedup must pick the 10-K exact value, NOT the later-filed DEF 14A rounding.
    const ni = report.checks.find((c) => c.id === "xbrlCrossCheck.netIncome.FY.2025-12-31");
    expect(ni?.status).toBe("pass");
    expect(ni?.deltaPct).toBe(0);
    expect(ni?.detail).toContain("10-K filed 2026-02-20");

    expect(report.flags.some((f) => f.includes("Bank-style XBRL tagging"))).toBe(true);
  });

  it("skips with a gap when companyfacts is unavailable", () => {
    const report = validateBundle(
      makeBundle({ companyFacts: gap("edgar.companyFacts(AAPL)") }),
      { now: NOW },
    );
    const c = report.checks.find((x) => x.id === "xbrlCrossCheck");
    expect(c?.status).toBe("skipped");
    expect(report.gaps.some((g) => g.field === "validation.xbrlCrossCheck")).toBe(true);
  });

  it("treats FMP zero revenue as undisclosed and skips instead of comparing", () => {
    const rows: ValidateIncomeRow[] = [{ date: "2025-09-27", period: "FY", revenue: 0, netIncome: 112_010_000_000 }];
    const report = validateBundle(
      makeBundle({ incomeAnnual: ok({ rows }, "2025-09-27") }),
      { now: NOW },
    );
    const rev = report.checks.find((c) => c.id === "xbrlCrossCheck.revenue.FY.2025-09-27");
    expect(rev?.status).toBe("skipped");
    expect(report.gaps.some((g) => g.field.includes("xbrlCrossCheck.revenue.FY") && g.severity === "info")).toBe(true);
  });

  it("flags a lagging companyfacts snapshot (Citi F23 pattern)", () => {
    const staleFacts = makeFacts({
      RevenueFromContractWithCustomerExcludingAssessedTax: [
        xp({ start: "2024-07-01", end: "2025-06-30", val: 50e9 }),
      ],
    });
    const report = validateBundle(
      makeBundle({ companyFacts: ok(staleFacts, "2026-07-05") }),
      { now: NOW },
    );
    expect(report.flags.some((f) => f.includes("lags"))).toBe(true);
  });

  it("M7: a Dec-FY filer with only FY XBRL data does not false-fail the quarter cross-check", () => {
    // FMP has a Q4 statement row (3-month) ending 2025-12-31; XBRL companyfacts
    // holds ONLY the 12-month FY point (real Dec-FY filer between its 10-K and
    // next 10-Q). The quarter cross-check must be SKIPPED (not-checkable), never
    // a spurious ~300% "FMP and XBRL disagree" fail.
    const facts = makeFacts({
      RevenueFromContractWithCustomerExcludingAssessedTax: [
        xp({ start: "2025-01-01", end: "2025-12-31", val: 400e9 }), // FY 12-month only
      ],
      NetIncomeLoss: [xp({ start: "2025-01-01", end: "2025-12-31", val: 100e9 })],
    });
    const report = validateBundle(
      makeBundle({
        companyFacts: ok(facts, "2026-07-05"),
        incomeAnnual: gap("fmp.incomeStatement(X,annual)"),
        incomeQuarterly: ok(
          { rows: [{ date: "2025-12-31", period: "Q4", revenue: 110e9, netIncome: 28e9 }] },
          "2025-12-31",
        ),
      }),
      { now: NOW },
    );
    const rev = report.checks.find((c) => c.id === "xbrlCrossCheck.revenue.Q.2025-12-31");
    expect(rev?.status).toBe("skipped");
    expect(rev?.detail).toContain("not checkable");
    // No cross-check "fail" anywhere, and no "disagree" gap.
    expect(report.checks.some((c) => c.id.startsWith("xbrlCrossCheck") && c.status === "fail")).toBe(false);
    const g = report.gaps.find((x) => x.field.includes("xbrlCrossCheck.revenue.Q"));
    expect(g?.severity).toBe("info");
    expect(report.gaps.some((x) => /disagree/i.test(x.reason))).toBe(false);
  });

  it("L1: a bank-routed filer's revenue cross-check uses total revenue, not RFC fee-only", () => {
    // Regional bank tags entity-level ASC-606 fee revenue under RFC (fee-only,
    // 1.2B) while true total net revenue is 5.0B (Revenues). FMP reports the 5.0B
    // total. Without bank routing the cross-check compares 5.0B vs 1.2B and
    // false-warns; with bank routing it resolves the Revenues total and passes.
    const bankFacts = makeFacts({
      RevenueFromContractWithCustomerExcludingAssessedTax: [
        xp({ start: "2024-01-01", end: "2024-12-31", val: 1_200_000_000 }),
      ],
      Revenues: [xp({ start: "2024-01-01", end: "2024-12-31", val: 5_000_000_000 })],
      InterestIncomeExpenseNet: [xp({ start: "2024-01-01", end: "2024-12-31", val: 3_800_000_000 })],
      NoninterestIncome: [xp({ start: "2024-01-01", end: "2024-12-31", val: 1_200_000_000 })],
      NetIncomeLoss: [xp({ start: "2024-01-01", end: "2024-12-31", val: 900_000_000 })],
    });
    const bundle: ValidatableBundle = {
      ...makeBundle({
        companyFacts: ok(bankFacts, "2026-07-05"),
        incomeAnnual: ok(
          { rows: [{ date: "2024-12-31", period: "FY", revenue: 5_000_000_000, netIncome: 900_000_000 }] },
          "2024-12-31",
        ),
        incomeQuarterly: gap("fmp.incomeStatement(RGNL,quarter)"),
      }),
      profile: ok({ rows: [{ symbol: "RGNL", sector: "Financial Services", industry: "Banks - Regional" }] }, "2026-07-05"),
    };
    const report = validateBundle(bundle, { now: NOW });
    const rev = report.checks.find((c) => c.id === "xbrlCrossCheck.revenue.FY.2024-12-31");
    expect(rev?.status).toBe("pass");
    expect(rev?.deltaPct).toBe(0);
    expect(rev?.detail).toContain("Revenues");
    expect(report.flags.some((f) => f.includes("bank revenue chain"))).toBe(true);
  });

  it("L1: the SAME bank facts WITHOUT financial routing false-warn on RFC fee-only revenue (proves the fix is load-bearing)", () => {
    const bankFacts = makeFacts({
      RevenueFromContractWithCustomerExcludingAssessedTax: [
        xp({ start: "2024-01-01", end: "2024-12-31", val: 1_200_000_000 }),
      ],
      Revenues: [xp({ start: "2024-01-01", end: "2024-12-31", val: 5_000_000_000 })],
      NetIncomeLoss: [xp({ start: "2024-01-01", end: "2024-12-31", val: 900_000_000 })],
    });
    const report = validateBundle(
      makeBundle({
        companyFacts: ok(bankFacts, "2026-07-05"),
        incomeAnnual: ok(
          { rows: [{ date: "2024-12-31", period: "FY", revenue: 5_000_000_000, netIncome: 900_000_000 }] },
          "2024-12-31",
        ),
        incomeQuarterly: gap("fmp.incomeStatement(RGNL,quarter)"),
      }),
      { now: NOW },
    );
    const rev = report.checks.find((c) => c.id === "xbrlCrossCheck.revenue.FY.2024-12-31");
    // No profile + RFC present (so looksLikeBankTagging is also false) → default
    // RFC-first chain resolves fee-only 1.2B → 5.0B vs 1.2B mismatch → fail.
    expect(rev?.status).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// 3. Staleness
// ---------------------------------------------------------------------------

describe("staleness", () => {
  it("passes fundamentals cadence when the newest statement covers the expected quarter", () => {
    const { check: c } = check(makeBundle(), "staleness.fundamentals");
    expect(c.status).toBe("pass");
  });

  it("flags fundamentals more than one filing cycle behind (~120 d after quarter end)", () => {
    // Newest statement 2025-09-27; at 2026-07-06 the expected coverage is
    // through 2025-12-31 (latest quarter end ≥120 d old) → stale.
    const { report, check: c } = check(
      makeBundle({ incomeQuarterly: gap("fmp.incomeStatement(AAPL,quarter)") }),
      "staleness.fundamentals",
    );
    expect(c.status).toBe("fail");
    expect(report.flags.some((f) => f.startsWith("STALE FUNDAMENTALS"))).toBe(true);
    expect(report.gaps.some((g) => g.field === "validation.staleness.fundamentals")).toBe(true);
  });

  it("tolerates 52/53-week fiscal ends slightly before the calendar quarter end", () => {
    // Newest 2025-12-27 vs expected 2025-12-31 → within the ±10 d slack, not stale.
    const rows: ValidateIncomeRow[] = [{ date: "2025-12-27", period: "Q1", revenue: 1e9, netIncome: 1e8 }];
    const { check: c } = check(
      makeBundle({
        incomeAnnual: gap("fmp.incomeStatement(AAPL,annual)"),
        incomeQuarterly: ok({ rows }, "2025-12-27"),
        companyFacts: gap("edgar.companyFacts(AAPL)"),
      }),
      "staleness.fundamentals",
    );
    expect(c.status).toBe("pass");
  });

  it("flags a quote served past its TTL (stale-while-revalidate)", () => {
    const { report, check: c } = check(
      makeBundle({ quote: ok({ rows: [] }, "2026-07-03", { stale: true }) }),
      "staleness.quote",
    );
    expect(c.status).toBe("fail");
    expect(report.flags.some((f) => f.startsWith("STALE QUOTE"))).toBe(true);
  });

  it("flags a quote whose asOf is older than 7 days", () => {
    const { check: c } = check(makeBundle({ quote: ok({ rows: [] }, "2026-06-20") }), "staleness.quote");
    expect(c.status).toBe("fail");
  });

  it("passes a fresh quote", () => {
    const { check: c } = check(makeBundle(), "staleness.quote");
    expect(c.status).toBe("pass");
  });

  it("flags 13F data older than the latest filed cycle (quarter end + 45 d)", () => {
    const { report, check: c } = check(
      makeBundle({
        institutional: {
          year: 2025,
          quarter: 4,
          quarterEnd: "2025-12-31",
          positionsSummary: ok({ rows: [{ date: "2025-12-31" }] }, "2025-12-31"),
        },
      }),
      "staleness.institutional13F",
    );
    expect(c.status).toBe("fail");
    expect(report.flags.some((f) => f.startsWith("STALE 13F"))).toBe(true);
  });

  it("passes 13F at the expected cycle (2026 Q1 as of 2026-07-06)", () => {
    const { check: c } = check(makeBundle(), "staleness.institutional13F");
    expect(c.status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// 4. Zero-as-null sweep
// ---------------------------------------------------------------------------

describe("zero-as-null sweep", () => {
  it("marks implausible zeros (interestExpense=0) as undisclosed with an info gap", () => {
    const report = validateBundle(makeBundle(), { now: NOW });
    const g = report.gaps.find(
      (x) => x.field === "statements.incomeAnnual[2025-09-27].interestExpense",
    );
    expect(g).toBeDefined();
    expect(g?.severity).toBe("info");
    expect(g?.reason).toContain("undisclosed");
    expect(
      report.checks.some((c) => c.id === "zeroAsNull.incomeAnnual.interestExpense.2025-09-27"),
    ).toBe(true);
  });

  it("does not flag plausible non-zero values", () => {
    const report = validateBundle(makeBundle(), { now: NOW });
    expect(
      report.gaps.some((g) =>
        g.field.includes("sellingGeneralAndAdministrativeExpenses"),
      ),
    ).toBe(false);
  });

  it("only sweeps the LATEST row of each statement set", () => {
    const rows: ValidateIncomeRow[] = [
      { date: "2025-09-27", period: "FY", revenue: 1e9, netIncome: 1e8, interestExpense: 5e7, sellingGeneralAndAdministrativeExpenses: 1e8 },
      { date: "2024-09-28", period: "FY", revenue: 1e9, netIncome: 1e8, interestExpense: 0 },
    ];
    const report = validateBundle(
      makeBundle({
        incomeAnnual: ok({ rows }, "2025-09-27"),
        companyFacts: gap("edgar.companyFacts(AAPL)"),
      }),
      { now: NOW },
    );
    expect(report.gaps.some((g) => g.field.includes("[2024-09-28]"))).toBe(false);
  });

  it("annotates the policy as a house rule", () => {
    const report = validateBundle(makeBundle(), { now: NOW });
    expect(
      report.flags.some(
        (f) => f.includes("House rule") && IMPLAUSIBLE_ZERO_FIELDS.every((field) => f.includes(field)),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateBundle end-to-end
// ---------------------------------------------------------------------------

describe("validateBundle", () => {
  it("produces a full report on a healthy synthetic bundle", () => {
    const report = validateBundle(makeBundle(), { now: NOW });
    expect(report.checks.length).toBeGreaterThan(6);
    expect(report.checks.filter((c) => c.status === "fail" && c.id.startsWith("balanceSheetIdentity"))).toHaveLength(0);
    expect(report.flags.some((f) => f.includes("House rule"))).toBe(true);
  });

  it("never throws on an all-gaps bundle — everything skips with gaps", () => {
    const bundle: ValidatableBundle = {
      symbol: "GHOST",
      quote: gap("fmp.quote(GHOST)"),
      statements: {
        incomeAnnual: gap("fmp.incomeStatement(GHOST,annual)"),
        incomeQuarterly: gap("fmp.incomeStatement(GHOST,quarter)"),
        balanceAnnual: gap("fmp.balanceSheet(GHOST,annual)"),
      },
      institutional: {
        year: 2026,
        quarter: 1,
        quarterEnd: "2026-03-31",
        positionsSummary: gap("fmp.symbolPositionsSummary(GHOST)"),
      },
      edgar: { companyFacts: gap("edgar.companyFacts(GHOST)") },
    };
    const report = validateBundle(bundle, { now: NOW });
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.checks.every((c) => c.status === "skipped")).toBe(true);
    expect(report.gaps.length).toBeGreaterThan(0);
  });

  it("full precision deltas are returned (rounding is display-time only)", () => {
    const row: ValidateBalanceRow = {
      date: "2025-09-27",
      totalAssets: 3e9,
      totalLiabilities: 2e9,
      totalEquity: 0.999e9, // delta = 0.001/3 = 0.0333...%
    };
    const { check: c } = check(
      makeBundle({ balanceAnnual: ok({ rows: [row] }, "2025-09-27") }),
      "balanceSheetIdentity.2025-09-27",
    );
    expect(c.deltaPct).toBeCloseTo(100 / 3000, 10);
  });
});
