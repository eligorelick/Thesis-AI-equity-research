import { describe, expect, it } from "vitest";

import { computeAltman, runForensics } from "@/pipeline/stageB/forensics";
import type { CompanyRoute } from "@/types/core";

/**
 * Two defects in the forensic layer, both about a caveat that never reaches
 * the reader:
 *
 *  1. `runForensics` aggregated GAPS from all five sub-computations but NOTES
 *     from only the support flags, so every house-rule caveat the four models
 *     produce — Altman's X4 clamp, its variant-selection rationale, Beneish and
 *     Piotroski's own notes — was dropped on the floor. `notes` is the only
 *     notes channel the report consumes.
 *
 *  2. Missing `retainedEarnings` was silently substituted with 0 for Altman's
 *     X2. X2 carries the second-largest coefficient (1.4 original / 3.26 Z"),
 *     and a company with a large accumulated DEFICIT has a negative X2, so
 *     substituting 0 moves it toward the SAFE zone — the one direction a
 *     solvency screen must never fail in. Its only mitigation was a note, and
 *     defect (1) meant that note was discarded.
 */
const route = (base: CompanyRoute["base"] = "general"): CompanyRoute => ({
  base,
  overlays: [],
  evidence: { sector: "Technology", industry: "Software" },
});

const BALANCE = {
  date: "2025-12-31",
  totalAssets: 1000,
  totalCurrentAssets: 400,
  totalCurrentLiabilities: 200,
  totalLiabilities: 600,
  retainedEarnings: 300,
  totalStockholdersEquity: 400,
};

const INCOME = {
  date: "2025-12-31",
  revenue: 900,
  ebit: 120,
  operatingIncome: 120,
  netIncome: 80,
};

describe("Altman X2 fails closed when retained earnings are absent", () => {
  it("scores normally when retainedEarnings is present", () => {
    const r = computeAltman({ balance: { ...BALANCE }, income: { ...INCOME }, marketCap: 2000 }, "original");

    expect(r.score).not.toBeNull();
  });

  it("suppresses the Z-score instead of substituting 0 for a missing X2", () => {
    const r = computeAltman(
      { balance: { ...BALANCE, retainedEarnings: null }, income: { ...INCOME }, marketCap: 2000 },
      "original",
    );

    // Fail closed, exactly like a missing X1/X3/X4/X5 component.
    expect(r.score).toBeNull();
    const re = r.gaps.find((g) => g.field === "forensics.altman.retainedEarnings");
    expect(re).toBeDefined();
    // An absent discriminant input is a warning, not an informational aside.
    expect(re?.severity).toBe("warn");
  });

  it("does not let a missing X2 flatter an accumulated-deficit company", () => {
    // True X2 here is strongly negative; substituting 0 would raise the score.
    const withDeficit = computeAltman(
      { balance: { ...BALANCE, retainedEarnings: -800 }, income: { ...INCOME }, marketCap: 2000 },
      "original",
    );
    const absent = computeAltman(
      { balance: { ...BALANCE, retainedEarnings: null }, income: { ...INCOME }, marketCap: 2000 },
      "original",
    );

    expect(withDeficit.score).not.toBeNull();
    // The absent case must not silently outscore the known-distressed case.
    expect(absent.score).toBeNull();
  });
});

describe("runForensics surfaces the models' own house-rule notes", () => {
  it("propagates sub-computation notes into ForensicsReport.notes", () => {
    const report = runForensics(route(), {
      income: [INCOME, { ...INCOME, date: "2024-12-31" }],
      balance: [BALANCE, { ...BALANCE, date: "2024-12-31" }],
      cashFlow: [
        { date: "2025-12-31", netIncome: 80, netCashProvidedByOperatingActivities: 100 },
        { date: "2024-12-31", netIncome: 70, netCashProvidedByOperatingActivities: 90 },
      ],
      marketCap: 2000,
    });

    // The variant-selection rationale is a note the reader needs in order to
    // interpret the score at all; it must not be dropped.
    expect(report.altmanSelection.notes.length).toBeGreaterThan(0);
    for (const note of report.altmanSelection.notes) {
      expect(report.notes).toContain(note);
    }
    for (const note of report.altman?.notes ?? []) {
      expect(report.notes).toContain(note);
    }
    for (const note of report.piotroski?.notes ?? []) {
      expect(report.notes).toContain(note);
    }
  });
});
