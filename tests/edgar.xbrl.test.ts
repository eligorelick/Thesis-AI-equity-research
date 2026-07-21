/**
 * XBRL concept-chain and deduplication tests built from compact SEC filing
 * excerpts in fixtures/edgar/.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkBankRevenueIdentity,
  crossCheck,
  dedupFactPoints,
  filterToCoreForms,
  getConcept,
  latestFactEnd,
  looksLikeBankTagging,
  parseFactPoints,
  type CompanyFacts,
  type FactPoint,
} from "@/edgar/xbrl";

const SAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "edgar");
const readJson = (name: string): unknown => JSON.parse(readFileSync(path.join(SAMPLES, name), "utf8"));

// ---------------------------------------------------------------------------
// Fixture -> CompanyFacts adapters
// ---------------------------------------------------------------------------

interface JpmFixture {
  cik: number;
  entityName: string;
  facts_us_gaap: Record<string, { label: string; unit: string; sample_points: unknown[] }>;
}

function jpmFacts(overrides?: (facts: Record<string, unknown>) => void): CompanyFacts {
  const raw = readJson("jpm_companyfacts_revenue_tags.json") as JpmFixture;
  const usGaap: Record<string, unknown> = {};
  for (const [tag, c] of Object.entries(raw.facts_us_gaap)) {
    usGaap[tag] = { label: c.label, units: { [c.unit]: c.sample_points } };
  }
  if (overrides) overrides(usGaap);
  return { cik: raw.cik, entityName: raw.entityName, facts: { "us-gaap": usGaap } };
}

function pt(p: Partial<FactPoint> & { end: string; val: number }): FactPoint {
  return {
    accn: "0000000000-26-000001",
    form: "10-K",
    filed: "2026-02-20",
    fy: 2025,
    fp: "FY",
    ...p,
  };
}

/** Build a minimal CompanyFacts from tag -> points (unit USD unless specified). */
function facts(tags: Record<string, FactPoint[]>, units: Record<string, string> = {}): CompanyFacts {
  const usGaap: Record<string, unknown> = {};
  for (const [tag, points] of Object.entries(tags)) {
    usGaap[tag] = { label: tag, units: { [units[tag] ?? "USD"]: points } };
  }
  return { cik: 1, entityName: "TEST CO", facts: { "us-gaap": usGaap } };
}

const FY2025 = { start: "2025-01-01", end: "2025-12-31" };
const Q1_2026 = { start: "2026-01-01", end: "2026-03-31" };

// ---------------------------------------------------------------------------
// THE CRITICAL DEDUP RULE (F14 + F24)
// ---------------------------------------------------------------------------

describe("dedup rule: form filter BEFORE max(filed)", () => {
  it("JPM FY2025 net income returns the 10-K 57,048 — NOT the later-filed rounded DEF 14A 57,000 (F14)", () => {
    const r = getConcept(jpmFacts(), "netIncome", { period: FY2025 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.value).toBe(57_048_000_000);
    expect(r.value.data.form).toBe("10-K");
    expect(r.value.data.accn).toBe("0001628280-26-008131");
    expect(r.value.data.tag).toBe("NetIncomeLoss");
    expect(r.value.asOf).toBe("2025-12-31");
    expect(r.value.source).toBe("edgar");
  });

  it("filterToCoreForms drops DEF 14A and 8-K points even when frame-bearing and latest-filed (F24)", () => {
    const points: FactPoint[] = [
      pt({ start: "2025-01-01", end: "2025-12-31", val: 57_048_000_000, form: "10-K", filed: "2026-02-13" }),
      pt({ start: "2025-01-01", end: "2025-12-31", val: 57_000_000_000, form: "DEF 14A", filed: "2026-04-06", frame: "CY2025", fy: null, fp: null }),
      pt({ start: "2025-01-01", end: "2025-12-31", val: 57_100_000_000, form: "8-K", filed: "2026-05-01" }),
    ];
    const kept = filterToCoreForms(points);
    expect(kept).toHaveLength(1);
    expect(kept[0].val).toBe(57_048_000_000);
  });

  it("retains audited 20-F facts but still rejects unstandardized 6-K points", () => {
    const points: FactPoint[] = [
      pt({ start: "2025-01-01", end: "2025-12-31", val: 100, form: "20-F", filed: "2026-03-01" }),
      pt({ start: "2026-01-01", end: "2026-03-31", val: 30, form: "6-K", filed: "2026-05-01" }),
    ];
    const kept = filterToCoreForms(points);
    expect(kept).toHaveLength(1);
    expect(kept[0].form).toBe("20-F");
  });

  it("within core forms, max(filed) wins per period group (10-Q re-report vs original 10-K)", () => {
    const points: FactPoint[] = [
      pt({ end: "2025-12-31", val: 100, form: "10-K", filed: "2026-02-13" }),
      pt({ end: "2025-12-31", val: 100, form: "10-Q", filed: "2026-05-01" }),
      pt({ end: "2026-03-31", val: 200, form: "10-Q", filed: "2026-05-01" }),
    ];
    const deduped = dedupFactPoints(points).sort((a, b) => a.end.localeCompare(b.end));
    expect(deduped).toHaveLength(2);
    expect(deduped[0].filed).toBe("2026-05-01");
  });

  it("amendments (10-K/A) beat the original on equal filed date and are kept by the form filter", () => {
    const points: FactPoint[] = [
      pt({ end: "2025-12-31", val: 1, form: "10-K", filed: "2026-02-13" }),
      pt({ end: "2025-12-31", val: 2, form: "10-K/A", filed: "2026-03-01" }),
    ];
    const deduped = dedupFactPoints(points);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].val).toBe(2);
  });

  it("parseFactPoints tolerates null fy/fp (DEF 14A rows) and skips malformed rows", () => {
    const parsed = parseFactPoints([
      { end: "2025-12-31", val: 1, accn: "a", form: "10-K", filed: "2026-01-01", fy: null, fp: null },
      { bogus: true },
      "not an object",
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].fy).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Revenue chain (JPM fixture)
// ---------------------------------------------------------------------------

describe("revenue chain on JPM companyfacts", () => {
  it("FY2025: RevenueFromContractWithCustomer* absent -> Revenues (182,447 $M)", () => {
    const r = getConcept(jpmFacts(), "revenue", { period: FY2025 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.value).toBe(182_447_000_000);
    expect(["Revenues", "RevenuesNetOfInterestExpense"]).toContain(r.value.data.tag);
    expect(r.value.data.computed).toBe(false);
  });

  it("Q1-2026: Revenues has no quarterly point -> falls through to RevenuesNetOfInterestExpense", () => {
    const r = getConcept(jpmFacts(), "revenue", { period: Q1_2026 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.value).toBe(49_836_000_000);
    expect(r.value.data.tag).toBe("RevenuesNetOfInterestExpense");
  });

  it("computed NII+NonII fallback fires when both revenue head tags are removed (identity 95,443+87,004=182,447)", () => {
    const f = jpmFacts((usGaap) => {
      delete usGaap["Revenues"];
      delete usGaap["RevenuesNetOfInterestExpense"];
    });
    const r = getConcept(f, "revenue", { period: FY2025 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.value).toBe(182_447_000_000);
    expect(r.value.data.computed).toBe(true);
    expect(r.value.data.tag).toBe("InterestIncomeExpenseNet+NoninterestIncome");
    expect(r.value.data.components).toHaveLength(2);
  });

  it("stale InterestAndDividendIncomeOperating (2012) is NEVER used for current-period revenue", () => {
    const f = jpmFacts((usGaap) => {
      delete usGaap["Revenues"];
      delete usGaap["RevenuesNetOfInterestExpense"];
      delete usGaap["InterestIncomeExpenseNet"];
      delete usGaap["NoninterestIncome"];
    });
    const r = getConcept(f, "revenue", { period: FY2025 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.gap.reason).toContain("no XBRL fact matched");
    expect(r.gap.severity).toBe("warn");
  });
});

// ---------------------------------------------------------------------------
// Other JPM concepts: instants, EPS units, deposits
// ---------------------------------------------------------------------------

describe("JPM concept lookups", () => {
  it("assets (instant) at 2026-03-31 = 4,900,475 $M", () => {
    const r = getConcept(jpmFacts(), "assets", { period: { end: "2026-03-31" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.value).toBe(4_900_475_000_000);
  });

  it("deposits at 2025-12-31 = 2,559,320 $M (10-K + identical 10-Q re-report deduped)", () => {
    const r = getConcept(jpmFacts(), "deposits", { period: { end: "2025-12-31" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.value).toBe(2_559_320_000_000);
    // max(filed) picked the 10-Q re-report — same value, later filing.
    expect(r.value.data.filed).toBe("2026-05-01");
  });

  it("diluted EPS FY2025 = 20.02 in USD/shares", () => {
    const r = getConcept(jpmFacts(), "dilutedEps", { period: FY2025 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.value).toBe(20.02);
    expect(r.value.data.unit).toBe("USD/shares");
  });

  it("provision FY2025 via ProvisionForLoanLeaseAndOtherLosses = 14,212 $M", () => {
    const r = getConcept(jpmFacts(), "provisionForCreditLosses", { period: FY2025 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.value).toBe(14_212_000_000);
    expect(r.value.data.tag).toBe("ProvisionForLoanLeaseAndOtherLosses");
  });

  it("52/53-week tolerance: ±3 days on period end", () => {
    const f = facts({ Assets: [pt({ end: "2025-09-27", val: 371_082_000_000 })] });
    const hit = getConcept(f, "assets", { period: { end: "2025-09-30" } });
    expect(hit.ok).toBe(true);
    const miss = getConcept(f, "assets", { period: { end: "2025-10-15" } });
    expect(miss.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bank matrix (BAC / WFC / C) — per-bank chain behavior
// ---------------------------------------------------------------------------

interface MatrixFixture {
  fy2025_fixtures: {
    BAC: Record<string, number>;
    WFC: Record<string, number>;
    C: Record<string, number>;
  };
}

const matrix = readJson("bank_xbrl_tag_matrix.json") as MatrixFixture;

function bacFacts(): CompanyFacts {
  const v = matrix.fy2025_fixtures.BAC;
  return facts({
    Revenues: [pt({ ...FY2025, val: v["Revenues"] })],
    InterestIncomeExpenseNet: [pt({ ...FY2025, val: v["InterestIncomeExpenseNet"] })],
    NoninterestIncome: [pt({ ...FY2025, val: v["NoninterestIncome"] })],
    NetIncomeLoss: [pt({ ...FY2025, val: v["NetIncomeLoss"] })],
    // BAC F25: standard provision tags are STALE (2019) — must fall through to the computed sum.
    ProvisionForLoanLeaseAndOtherLosses: [pt({ start: "2019-01-01", end: "2019-12-31", val: 3_590_000_000, filed: "2020-02-19" })],
    FinancingReceivableExcludingAccruedInterestCreditLossExpenseReversal: [pt({ ...FY2025, val: 5_595_000_000 })],
    OffBalanceSheetCreditLossLiabilityCreditLossExpenseReversal: [pt({ ...FY2025, val: 80_000_000 })],
    Assets: [pt({ end: "2025-12-31", val: v["Assets@2025-12-31"] })],
  });
}

describe("bank chains (BAC/WFC/C matrix)", () => {
  it("BAC revenue resolves via Revenues (RevenuesNetOfInterestExpense absent) = 113,097 $M", () => {
    const r = getConcept(bacFacts(), "revenue", { period: FY2025 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.value).toBe(113_097_000_000);
    expect(r.value.data.tag).toBe("Revenues");
  });

  it("BAC provision falls through stale tags to the COMPUTED sum 5,595+80 = 5,675 $M (F25)", () => {
    const r = getConcept(bacFacts(), "provisionForCreditLosses", { period: FY2025 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.value).toBe(matrix.fy2025_fixtures.BAC["provision_computed"]);
    expect(r.value.data.computed).toBe(true);
  });

  it("WFC revenue resolves via RevenuesNetOfInterestExpense (Revenues stale 2020) = 83,699 $M", () => {
    const v = matrix.fy2025_fixtures.WFC;
    const f = facts({
      Revenues: [pt({ start: "2020-07-01", end: "2020-09-30", val: 18_862_000_000, filed: "2020-11-03" })],
      RevenuesNetOfInterestExpense: [pt({ ...FY2025, val: v["RevenuesNetOfInterestExpense"] })],
    });
    const r = getConcept(f, "revenue", { period: FY2025 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.value).toBe(83_699_000_000);
    expect(r.value.data.tag).toBe("RevenuesNetOfInterestExpense");
  });

  it("C provision resolves via ProvisionForLoanLossesExpensed = 9,497 $M", () => {
    const v = matrix.fy2025_fixtures.C;
    const f = facts({
      ProvisionForLoanLeaseAndOtherLosses: [pt({ start: "2019-01-01", end: "2019-09-30", val: 2_088_000_000, filed: "2019-11-01" })],
      ProvisionForLoanLossesExpensed: [pt({ ...FY2025, val: v["ProvisionForLoanLossesExpensed"] })],
    });
    const r = getConcept(f, "provisionForCreditLosses", { period: FY2025 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.value).toBe(9_497_000_000);
    expect(r.value.data.tag).toBe("ProvisionForLoanLossesExpensed");
  });

  it("bank revenue identity NII + NonII == total net revenue holds on the JPM fixture", () => {
    const chk = checkBankRevenueIdentity(jpmFacts(), FY2025);
    expect(chk).not.toBeNull();
    expect(chk?.holds).toBe(true);
    expect(chk?.nii).toBe(95_443_000_000);
    expect(chk?.nonII).toBe(87_004_000_000);
    expect(chk?.revenue).toBe(182_447_000_000);
  });

  it("C freshness gap (F23) is visible via latestFactEnd", () => {
    const f = facts({ NetIncomeLoss: [pt({ ...FY2025, val: 14_306_000_000 })] });
    expect(latestFactEnd(f, ["NetIncomeLoss", "Revenues"])).toBe("2025-12-31");
  });
});

// ---------------------------------------------------------------------------
// Bank detection & crossCheck
// ---------------------------------------------------------------------------

describe("looksLikeBankTagging", () => {
  it("true for JPM (no RFC*, has RevenuesNetOfInterestExpense/InterestIncomeExpenseNet)", () => {
    expect(looksLikeBankTagging(jpmFacts())).toBe(true);
  });

  it("false when RevenueFromContractWithCustomerExcludingAssessedTax exists (AAPL-style)", () => {
    const f = facts({
      RevenueFromContractWithCustomerExcludingAssessedTax: [pt({ start: "2024-09-29", end: "2025-09-27", val: 416_161_000_000 })],
    });
    expect(looksLikeBankTagging(f)).toBe(false);
  });
});

describe("crossCheck", () => {
  it("exact match", () => {
    expect(crossCheck(57_048_000_000, 57_048_000_000)).toEqual({ match: true, deltaPct: 0 });
  });

  it("the DEF 14A rounding delta (57,000 vs 57,048) is ~0.084% — inside the default 0.5% tolerance", () => {
    const r = crossCheck(57_000_000_000, 57_048_000_000);
    expect(r.match).toBe(true);
    expect(r.deltaPct).toBeGreaterThan(0.08);
    expect(r.deltaPct).toBeLessThan(0.09);
  });

  it("tighter tolerance flags the same delta", () => {
    expect(crossCheck(57_000_000_000, 57_048_000_000, 0.05).match).toBe(false);
  });

  it("handles zero XBRL values without dividing by zero", () => {
    expect(crossCheck(100, 0).match).toBe(false);
    expect(crossCheck(100, 0).deltaPct).toBe(100);
    expect(crossCheck(0, 0)).toEqual({ match: true, deltaPct: 0 });
  });
});

// ---------------------------------------------------------------------------
// Ambiguity + duration-hint gating: duration groups sharing an end date
// ---------------------------------------------------------------------------

describe("duration disambiguation and hint gating", () => {
  // A real Dec-FY 10-K files ONLY the 12-month FY revenue under Revenues; it
  // does NOT file a separate 3-month Q4 duration context ending at fiscal-year
  // end (the earlier fixture fabricated one, masking finding M7).
  const fyOnly = facts({
    Revenues: [pt({ start: "2025-01-01", end: "2025-12-31", val: 400, form: "10-K", filed: "2026-02-13" })],
  });

  // Realistic multi-duration: a 10-Q files BOTH the 3-month current quarter and
  // the year-to-date context, ending the SAME date (Q3 + 9-month YTD).
  const qAndYtd = facts({
    Revenues: [
      pt({ start: "2025-07-01", end: "2025-09-30", val: 100, form: "10-Q", filed: "2025-11-01" }), // 3-month
      pt({ start: "2025-01-01", end: "2025-09-30", val: 300, form: "10-Q", filed: "2025-11-01" }), // 9-month YTD
    ],
  });

  it("explicit start selects the exact duration row", () => {
    const q3 = getConcept(qAndYtd, "revenue", { period: { start: "2025-07-01", end: "2025-09-30" } });
    expect(q3.ok && q3.value.data.value).toBe(100);
  });

  it("durationHint Q picks the 3-month row when a YTD shares the end date", () => {
    const q = getConcept(qAndYtd, "revenue", { period: { end: "2025-09-30", durationHint: "Q" } });
    expect(q.ok && q.value.data.value).toBe(100);
  });

  it("durationHint FY on a Dec-FY filer returns the 12-month figure", () => {
    const fy = getConcept(fyOnly, "revenue", { period: { end: "2025-12-31", durationHint: "FY" } });
    expect(fy.ok && fy.value.data.value).toBe(400);
  });

  it("no hint with two duration groups: deterministic longest-duration pick, flagged with a note", () => {
    const r = getConcept(qAndYtd, "revenue", { period: { end: "2025-09-30" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.value).toBe(300); // longest (9-month YTD)
    expect(r.value.data.note).toContain("ambiguous");
  });

  // M7 regression: a Q cross-check on a Dec-FY filer whose only near-end fact is
  // the 12-month FY point must NOT silently return the annual figure as a
  // quarter (that produced a spurious ~300% "FMP and XBRL disagree" gap).
  it("M7: durationHint Q with only a 12-month candidate resolves no fact (not-checkable), never the FY value", () => {
    const r = getConcept(fyOnly, "revenue", { period: { end: "2025-12-31", durationHint: "Q" } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.gap.reason).toContain("no XBRL fact matched");
  });

  // Symmetric guard: an FY check must not match a lone quarterly point.
  it("M7: durationHint FY with only a 3-month candidate resolves no fact", () => {
    const qOnly = facts({
      Revenues: [pt({ start: "2026-01-01", end: "2026-03-31", val: 100, form: "10-Q", filed: "2026-05-01" })],
    });
    const r = getConcept(qOnly, "revenue", { period: { end: "2026-03-31", durationHint: "FY" } });
    expect(r.ok).toBe(false);
  });

  // Instants (no start — e.g. Assets) must still resolve under a hint: their
  // period length is unknowable, so the duration gate must let them through.
  it("instant concepts pass the duration gate regardless of hint", () => {
    const inst = facts({ Assets: [pt({ end: "2025-12-31", val: 900 })] });
    const r = getConcept(inst, "assets", { period: { end: "2025-12-31", durationHint: "Q" } });
    expect(r.ok && r.value.data.value).toBe(900);
  });
});

// ---------------------------------------------------------------------------
// L1: bank revenue chain — total-revenue tags before ASC-606 RFC fee tags
// ---------------------------------------------------------------------------

describe("bank revenue chain (L1)", () => {
  // A regional bank that ALSO tags entity-level ASC-606 fee revenue under
  // RevenueFromContractWithCustomerExcludingAssessedTax (fee-only — EXCLUDES
  // net interest income) alongside a true total-revenue Revenues tag.
  const regionalBank = (): CompanyFacts =>
    facts({
      RevenueFromContractWithCustomerExcludingAssessedTax: [pt({ ...FY2025, val: 1_200_000_000 })], // fee-only
      Revenues: [pt({ ...FY2025, val: 5_000_000_000 })], // total net revenue
      InterestIncomeExpenseNet: [pt({ ...FY2025, val: 3_800_000_000 })],
      NoninterestIncome: [pt({ ...FY2025, val: 1_200_000_000 })],
    });

  it("default chain resolves the RFC fee-only figure (the L1 pitfall)", () => {
    const r = getConcept(regionalBank(), "revenue", { period: FY2025 });
    expect(r.ok && r.value.data.value).toBe(1_200_000_000);
    expect(r.ok && r.value.data.tag).toBe("RevenueFromContractWithCustomerExcludingAssessedTax");
  });

  it("bankRevenue mode prefers the total-revenue Revenues tag over RFC fee-only", () => {
    const r = getConcept(regionalBank(), "revenue", { period: FY2025, bankRevenue: true });
    expect(r.ok && r.value.data.value).toBe(5_000_000_000);
    expect(r.ok && r.value.data.tag).toBe("Revenues");
  });

  it("bankRevenue mode still falls through to RFC when no bank total-revenue tag exists", () => {
    const feeOnly = facts({
      RevenueFromContractWithCustomerExcludingAssessedTax: [pt({ ...FY2025, val: 1_200_000_000 })],
    });
    const r = getConcept(feeOnly, "revenue", { period: FY2025, bankRevenue: true });
    expect(r.ok && r.value.data.value).toBe(1_200_000_000);
    expect(r.ok && r.value.data.tag).toBe("RevenueFromContractWithCustomerExcludingAssessedTax");
  });

  it("bankRevenue mode uses the NII+NonII computed sum when only components exist", () => {
    const composed = facts({
      RevenueFromContractWithCustomerExcludingAssessedTax: [pt({ ...FY2025, val: 1_200_000_000 })],
      InterestIncomeExpenseNet: [pt({ ...FY2025, val: 3_800_000_000 })],
      NoninterestIncome: [pt({ ...FY2025, val: 1_200_000_000 })],
    });
    const r = getConcept(composed, "revenue", { period: FY2025, bankRevenue: true });
    expect(r.ok && r.value.data.value).toBe(5_000_000_000);
    expect(r.ok && r.value.data.computed).toBe(true);
  });

  it("bankRevenue mode does not affect non-revenue concepts", () => {
    const composed = facts({ NetIncomeLoss: [pt({ ...FY2025, val: 900_000_000 })] });
    const r = getConcept(composed, "netIncome", { period: FY2025, bankRevenue: true });
    expect(r.ok && r.value.data.value).toBe(900_000_000);
    expect(r.ok && r.value.data.tag).toBe("NetIncomeLoss");
  });
});
