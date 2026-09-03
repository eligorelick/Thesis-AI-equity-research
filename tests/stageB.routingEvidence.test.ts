/**
 * WS5 (D-16) — sector routing from XBRL evidence.
 *
 * SIC and the vendor industry string are both classifications ABOUT a filer;
 * the tags it actually files are what it does. SIC 6798 is the sharp case: it
 * covers equity and mortgage REITs alike, and the two maps disagree about which
 * metrics mean anything, so routing on the SIC alone published FFO for a
 * mortgage REIT (or book-value spread metrics for a shopping-centre landlord)
 * on no evidence. These tests pin: evidence decides when industry/SIC do not,
 * a conflict is disclosed rather than silently overridden, and an
 * unseparable REIT is routed `undetermined` with BOTH metric families withheld.
 *
 * Pure and offline — companyfacts payloads are built in the test.
 */

import { describe, expect, it } from "vitest";

import {
  deriveRoutingEvidence,
  ROUTING_EVIDENCE_RECENCY_MONTHS,
} from "@/pipeline/stageB/routingEvidence";
import {
  metricPolicy,
  degradationPlan,
  routeCompany,
  type RoutingProfile,
  type RoutingStatements,
} from "@/pipeline/stageB/sectorRouting";
import type { CompanyFacts } from "@/edgar/xbrl";
import type { FetchResult } from "@/types/core";

const TODAY = "2026-07-06";

interface Pt {
  end: string;
  val: number;
  start?: string;
  form?: string;
  filed?: string;
}

/** Minimal companyfacts payload: `{ tag: [points] }`, USD, core forms. */
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
        form: p.form ?? "10-K",
        filed: p.filed ?? `${Number(p.end.slice(0, 4)) + 1}-02-15`,
      })),
    },
  });
  return {
    cik: 1234567,
    entityName: "Test Registrant",
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
  gap: {
    field: "edgar.companyFacts(X)",
    reason: "companyfacts HTTP 404",
    severity: "warn",
  },
};

/** A bank's tags: deposits plus loans and net interest income. */
const BANK_FACTS = {
  Deposits: [{ end: "2025-12-31", val: 2_018_729_000_000 }],
  LoansAndLeasesReceivableNetReportedAmount: [{ end: "2025-12-31", val: 1_100_000_000_000 }],
  InterestIncomeExpenseNet: [{ end: "2025-12-31", start: "2025-01-01", val: 60_096_000_000 }],
};

/** An insurer's tags: premiums earned plus loss reserves. */
const INSURER_FACTS = {
  PremiumsEarnedNet: [{ end: "2025-12-31", start: "2025-01-01", val: 51_000_000_000 }],
  LiabilityForClaimsAndClaimsAdjustmentExpense: [{ end: "2025-12-31", val: 78_000_000_000 }],
};

/** An equity REIT: investment property on the balance sheet. */
const EQUITY_REIT_FACTS = {
  RealEstateInvestmentPropertyNet: [{ end: "2025-12-31", val: 24_000_000_000 }],
};

/** A mortgage REIT: MBS and repo funding, and NO investment property. */
const MORTGAGE_REIT_FACTS = {
  MortgageBackedSecuritiesAvailableForSaleFairValueDisclosure: [
    { end: "2025-12-31", val: 65_000_000_000 },
  ],
  SecuritiesSoldUnderAgreementsToRepurchase: [{ end: "2025-12-31", val: 58_000_000_000 }],
};

function profile(over: Partial<RoutingProfile> = {}): RoutingProfile {
  return {
    sector: null,
    industry: null,
    isAdr: false,
    isEtf: false,
    isFund: false,
    ipoDate: "2000-01-01",
    country: "US",
    currency: "USD",
    sic: null,
    ...over,
  };
}

function statements(): RoutingStatements {
  return {
    incomeTtm: {
      date: "2026-03-31",
      revenue: 50_000_000_000,
      netIncome: 8_000_000_000,
      reportedCurrency: "USD",
    },
    incomeAnnual: {
      date: "2025-12-31",
      revenue: 48_000_000_000,
      netIncome: 7_500_000_000,
      reportedCurrency: "USD",
    },
    cashflowTtm: { date: "2026-03-31", operatingCashFlow: 9_000_000_000 },
    cashflowAnnual: { date: "2025-12-31", operatingCashFlow: 8_800_000_000 },
    availableQuarters: 40,
  };
}

function route(
  p: Partial<RoutingProfile>,
  companyFacts: FetchResult<CompanyFacts> | null,
) {
  return routeCompany(profile(p), statements(), {
    today: TODAY,
    evidence: companyFacts === null ? null : deriveRoutingEvidence(companyFacts),
  });
}

describe("deriveRoutingEvidence — tag presence with values and periods", () => {
  it("reads deposits, loans and net interest income as bank evidence with values and period ends", () => {
    const e = deriveRoutingEvidence(okFacts(BANK_FACTS));

    expect(e.available).toBe(true);
    expect(e.suggests).toBe("bank");
    expect(e.asOf).toBe("2025-12-31");
    const deposits = e.bank.find((s) => s.tag === "Deposits");
    expect(deposits?.value).toBe(2_018_729_000_000);
    expect(deposits?.end).toBe("2025-12-31");
    expect(e.basis).toContain("Deposits");
    expect(e.basis).toContain("→ bank");
  });

  it("requires BOTH a deposit tag and a loan/NII tag before it calls a filer a bank", () => {
    // An industrial can hold customer deposits without being a bank; a single
    // tag is a line item, not a business model.
    const depositsOnly = deriveRoutingEvidence(
      okFacts({ Deposits: [{ end: "2025-12-31", val: 500_000_000 }] }),
    );

    expect(depositsOnly.suggests).toBeNull();
    expect(depositsOnly.bank).toEqual([]);
  });

  it("reads premiums earned with loss reserves as insurer evidence", () => {
    const e = deriveRoutingEvidence(okFacts(INSURER_FACTS));

    expect(e.suggests).toBe("insurer");
    expect(e.basis).toContain("PremiumsEarnedNet");
    expect(e.basis).toContain("LiabilityForClaimsAndClaimsAdjustmentExpense");
  });

  it("separates the REIT sub-maps: investment property is equity, MBS without it is mortgage", () => {
    expect(deriveRoutingEvidence(okFacts(EQUITY_REIT_FACTS)).reitSubmap).toBe("equity");
    expect(deriveRoutingEvidence(okFacts(MORTGAGE_REIT_FACTS)).reitSubmap).toBe("mortgage");
    // A hybrid that files investment property is NOT a mortgage REIT: the
    // property tag decides, exactly as D-16 specifies.
    const hybrid = deriveRoutingEvidence(
      okFacts({ ...EQUITY_REIT_FACTS, ...MORTGAGE_REIT_FACTS }),
    );
    expect(hybrid.reitSubmap).toBe("equity");
    expect(hybrid.mortgageReit).toEqual([]);
  });

  it("ignores a tag the filer abandoned years ago", () => {
    // A retired tag must not classify a filer today. The deposit fact is older
    // than the recency window measured from the newest evidence fact.
    const stale = deriveRoutingEvidence(
      okFacts({
        Deposits: [{ end: "2014-12-31", val: 10_000_000_000 }],
        RealEstateInvestmentPropertyNet: [{ end: "2025-12-31", val: 9_000_000_000 }],
      }),
    );

    expect(stale.suggests).toBe("reit");
    expect(stale.bank).toEqual([]);
    expect(ROUTING_EVIDENCE_RECENCY_MONTHS).toBe(24);
  });

  it("treats a zero-valued tag as absent, and reports a failed payload as unavailable", () => {
    const zeroed = deriveRoutingEvidence(
      okFacts({
        Deposits: [{ end: "2025-12-31", val: 0 }],
        InterestIncomeExpenseNet: [{ end: "2025-12-31", start: "2025-01-01", val: 0 }],
      }),
    );
    expect(zeroed.suggests).toBeNull();

    const missing = deriveRoutingEvidence(factsGap);
    expect(missing.available).toBe(false);
    expect(missing.unavailableReason).toContain("companyfacts HTTP 404");
    expect(missing.suggests).toBeNull();

    const notFetched = deriveRoutingEvidence(null);
    expect(notFetched.available).toBe(false);
    expect(notFetched.unavailableReason).toContain("not fetched");
  });
});

describe("routeCompany — XBRL evidence decides when industry and SIC do not", () => {
  it("routes a bank on tag evidence alone, naming the tags and the classification inputs", () => {
    const r = route({ sector: null, industry: null, sic: null }, okFacts(BANK_FACTS));

    expect(r.base).toBe("bank");
    const note = r.notes.find((n) => n.startsWith("base route 'bank' from XBRL evidence"));
    expect(note).toBeDefined();
    // The note states the evidence used (tag names and values) AND the
    // SIC/industry inputs that failed to decide.
    expect(note).toContain("Deposits 2018729000000");
    expect(note).toContain("InterestIncomeExpenseNet");
    expect(note).toContain("industry string missing");
    expect(note).toContain("SIC missing");
  });

  it("routes an insurer and a mortgage REIT on tag evidence alone", () => {
    expect(route({}, okFacts(INSURER_FACTS)).base).toBe("insurer");
    const mreit = route({}, okFacts(MORTGAGE_REIT_FACTS));
    expect(mreit.base).toBe("reit-mortgage");
    expect(mreit.reitSubmap).toBe("mortgage");
  });

  it("confirms an industry-derived route against the tags", () => {
    const r = route(
      { sector: "Financial Services", industry: "Banks - Diversified" },
      okFacts(BANK_FACTS),
    );

    expect(r.base).toBe("bank");
    expect(
      r.notes.some((n) => n.includes("consistent with the 'bank' route") && n.includes("Deposits")),
    ).toBe(true);
  });

  it("discloses a conflict without overriding the vendor/SEC classification", () => {
    // Industry says bank, the tags say insurer. Routing keeps the declared
    // classification — a vendor string and an SEC code are evidence too — but
    // the disagreement reaches the notes and the manifest as a warning.
    const r = route(
      { sector: "Financial Services", industry: "Banks - Regional" },
      okFacts(INSURER_FACTS),
    );

    expect(r.base).toBe("bank");
    expect(r.notes.some((n) => n.includes("CONFLICTS with the 'bank' route"))).toBe(true);
    const gap = r.gaps.find((g) => g.field === "route.evidence.conflict");
    expect(gap?.severity).toBe("warn");
    expect(gap?.reason).toContain("insurer");
  });

  it("discloses missing companyfacts on a financial candidate, and stays silent for an industrial", () => {
    const bank = route({ sector: "Financial Services", industry: "Banks - Regional" }, factsGap);
    expect(bank.base).toBe("bank");
    expect(bank.notes.some((n) => n.startsWith("routing evidence:"))).toBe(true);
    const gap = bank.gaps.find((g) => g.field === "route.evidence");
    expect(gap?.severity).toBe("info");
    expect(gap?.reason).toContain("companyfacts HTTP 404");

    // An ordinary industrial is not a financial candidate: no evidence note and
    // no gap, so the manifest is not padded on every non-financial report.
    const industrial = route({ sector: "Technology", industry: "Consumer Electronics" }, factsGap);
    expect(industrial.base).toBe("general");
    expect(industrial.gaps.some((g) => g.field === "route.evidence")).toBe(false);
    expect(industrial.notes.some((n) => n.startsWith("routing evidence:"))).toBe(false);
  });
});

describe("mortgage-REIT evidence is specific, and needs corroboration to re-route", () => {
  it("does not route an ordinary technology issuer to the mortgage-REIT map on a corporate bond portfolio", () => {
    // AvailableForSaleSecuritiesDebtSecurities is what any corporate treasury
    // tags for its bond portfolio. Routing Apple/Alphabet/Microsoft to
    // 'reit-mortgage' on that tag suppressed the DCF, the reverse DCF,
    // EV/EBITDA and ROIC−WACC and led the report with book value per share.
    const e = deriveRoutingEvidence(
      okFacts({
        AvailableForSaleSecuritiesDebtSecurities: [{ end: "2025-12-31", val: 120_000_000_000 }],
      }),
    );
    expect(e.suggests).toBeNull();
    expect(e.reitSubmap).toBeNull();

    const r = route(
      { sector: "Technology", industry: "Computer Hardware", sic: "3571" },
      okFacts({
        AvailableForSaleSecuritiesDebtSecurities: [{ end: "2025-12-31", val: 120_000_000_000 }],
      }),
    );
    expect(r.base).toBe("general");
    expect(r.reitSubmap).toBeNull();
  });

  it("does not route an industrial to the mortgage-REIT map on vendor financing receivables", () => {
    // NotesReceivableNet is vendor financing (Deere, Caterpillar); it is a bank
    // /industrial receivable, not a mortgage-REIT loan book.
    const e = deriveRoutingEvidence(
      okFacts({ NotesReceivableNet: [{ end: "2025-12-31", val: 40_000_000_000 }] }),
    );
    expect(e.suggests).toBeNull();

    const r = route(
      { sector: "Industrials", industry: "Farm & Heavy Construction Machinery", sic: "3531" },
      okFacts({ NotesReceivableNet: [{ end: "2025-12-31", val: 40_000_000_000 }] }),
    );
    expect(r.base).toBe("general");
  });

  it("still routes a genuine agency mortgage REIT on its MBS and repo funding", () => {
    const e = deriveRoutingEvidence(okFacts(MORTGAGE_REIT_FACTS));
    expect(e.suggests).toBe("reit-mortgage");
    expect(e.mortgageFunding.map((s) => s.tag)).toContain(
      "SecuritiesSoldUnderAgreementsToRepurchase",
    );

    const r = route({ sector: null, industry: null, sic: null }, okFacts(MORTGAGE_REIT_FACTS));
    expect(r.base).toBe("reit-mortgage");
    expect(r.reitSubmap).toBe("mortgage");
  });

  it("discloses uncorroborated mortgage-asset tags instead of re-routing on them", () => {
    // Real MBS tags, but no repo funding and a non-financial SIC/sector: the one
    // evidence rule that fires on a single tag group does not get to move the
    // route by itself.
    const r = route(
      { sector: "Industrials", industry: "Conglomerates", sic: "3531" },
      okFacts({
        MortgageBackedSecuritiesAvailableForSaleFairValueDisclosure: [
          { end: "2025-12-31", val: 3_000_000_000 },
        ],
      }),
    );

    expect(r.base).toBe("general");
    expect(
      r.notes.some((n) => n.includes("NOTHING corroborates it") && n.includes("reit-mortgage")),
    ).toBe(true);
    const gap = r.gaps.find((g) => g.field === "route.evidence.conflict");
    expect(gap?.severity).toBe("warn");
    expect(gap?.reason).toContain("uncorroborated");
  });

  it("lets a financial SIC corroborate mortgage assets even without repo funding", () => {
    const r = route(
      { sector: "Real Estate", industry: null, sic: "6798" },
      okFacts({
        MortgageBackedSecuritiesAvailableForSaleFairValueDisclosure: [
          { end: "2025-12-31", val: 3_000_000_000 },
        ],
      }),
    );
    expect(r.base).toBe("reit-mortgage");
    expect(r.reitSubmap).toBe("mortgage");
  });
});

describe("routeCompany — SIC 6798 never decides the REIT sub-map alone (D-16)", () => {
  it("SIC 6798 with no evidence routes 'reit' with sub-map undetermined and withholds both families", () => {
    const r = route({ sector: null, industry: null, sic: "6798" }, factsGap);

    expect(r.base).toBe("reit");
    expect(r.reitSubmap).toBe("undetermined");
    const note = r.notes.find((n) => n.startsWith("REIT sub-map UNDETERMINED"));
    expect(note).toBeDefined();
    expect(note).toContain("cannot separate a mortgage REIT from an equity REIT");
    const gap = r.gaps.find((g) => g.field === "route.reitSubmap");
    expect(gap?.severity).toBe("warn");
    expect(gap?.reason).toContain("FFO/AFFO");
    expect(gap?.reason).toContain("net interest spread");

    // Both metric families are withheld — the equity-REIT set AND the
    // mortgage-REIT set — because publishing either asserts a business model.
    const { suppress } = metricPolicy(r);
    for (const withheld of ["ffoApprox", "affoApprox", "pFfo", "bookValuePerShare", "netInterestSpread", "leverageAssetsToEquity"]) {
      expect(suppress, withheld).toContain(withheld);
    }
  });

  it("SIC 6798 WITH evidence resolves the sub-map instead of withholding", () => {
    const equity = route({ sic: "6798" }, okFacts(EQUITY_REIT_FACTS));
    expect(equity.base).toBe("reit");
    expect(equity.reitSubmap).toBe("equity");
    expect(metricPolicy(equity).suppress).not.toContain("pFfo");
    expect(
      equity.notes.some((n) => n.includes("REIT sub-map 'equity' from XBRL evidence")),
    ).toBe(true);

    const mortgage = route({ sic: "6798" }, okFacts(MORTGAGE_REIT_FACTS));
    expect(mortgage.base).toBe("reit-mortgage");
    expect(mortgage.reitSubmap).toBe("mortgage");
    // The mortgage map withholds FFO by its own base policy.
    expect(metricPolicy(mortgage).suppress).toContain("pFfo");
  });

  it("a keyless SIC-derived industry label carries no sub-type and stays undetermined", () => {
    // The keyless profile derives `REIT - Diversified` from SIC 6798 itself, so
    // treating it as a vendor sub-type would launder the SIC into evidence it
    // is not.
    const r = route({ sector: "Real Estate", industry: "REIT - Diversified", sic: "6798" }, factsGap);

    expect(r.reitSubmap).toBe("undetermined");
    expect(r.notes.some((n) => n.includes("the SIC 6798 label, no vendor sub-type"))).toBe(true);
  });

  it("an explicit vendor sub-type still decides when companyfacts are unavailable", () => {
    const equity = route({ sector: "Real Estate", industry: "REIT - Industrial", sic: "6798" }, factsGap);
    expect(equity.base).toBe("reit");
    expect(equity.reitSubmap).toBe("equity");

    const mortgage = route({ sector: "Real Estate", industry: "REIT - Mortgage" }, factsGap);
    expect(mortgage.base).toBe("reit-mortgage");
    expect(mortgage.reitSubmap).toBe("mortgage");
  });

  it("flags a vendor mortgage sub-map that contradicts filed investment property", () => {
    const r = route({ sector: "Real Estate", industry: "REIT - Mortgage" }, okFacts(EQUITY_REIT_FACTS));

    expect(r.base).toBe("reit-mortgage");
    expect(r.reitSubmap).toBe("mortgage");
    expect(r.gaps.some((g) => g.field === "route.reitSubmap.conflict")).toBe(true);
  });
});

describe("degradationPlan — withheld financial models carry their reason", () => {
  it("bank, insurer and mortgage-REIT routes disclose the reverse DCF and ROIC−WACC withholding", () => {
    for (const base of ["bank", "insurer", "reit-mortgage"] as const) {
      const plan = degradationPlan(base, [], 40);
      const targets = plan.items.map((i) => i.target);
      expect(targets, base).toContain("valuation.reverseDcf");
      expect(targets, base).toContain("returns.roicVsWacc");

      const reverse = plan.items.find((i) => i.target === "valuation.reverseDcf");
      expect(reverse?.action).toBe("suppress");
      expect(reverse?.disclosure).toContain("FCFF");

      const spread = plan.items.find((i) => i.target === "returns.roicVsWacc");
      expect(spread?.disclosure).toContain("invested capital");

      // ...and the metric policy withholds all four models named in V-10.
      const { suppress } = metricPolicy(base);
      for (const withheld of ["fcfDcf", "reverseDcf", "evEbitda"]) {
        expect(suppress, `${base}/${withheld}`).toContain(withheld);
      }
      expect(metricPolicy({ base, overlays: [], evidence: { sector: null, industry: null } }).suppress).toContain(
        "roicVsWacc",
      );
    }
  });

  it("an undetermined REIT sub-map states why both metric families are withheld", () => {
    const plan = degradationPlan("reit", [], 40, "undetermined");
    const item = plan.items.find((i) => i.target === "valuation.reit");

    expect(item?.action).toBe("suppress");
    expect(item?.disclosure).toContain("FFO");
    expect(item?.disclosure).toContain("book value per share");

    // A resolved sub-map carries no such item.
    expect(
      degradationPlan("reit", [], 40, "equity").items.some((i) => i.target === "valuation.reit"),
    ).toBe(false);
  });
});
