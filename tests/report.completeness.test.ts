import { describe, expect, it } from "vitest";

import {
  buildDataCompleteness,
  deriveReportCompletenessPresentation,
} from "@/report/completeness";
import type { DataCompleteness } from "@/report/schema";
import type { ManifestEntry } from "@/types/core";

describe("report data completeness", () => {
  it("blocks critical EDGAR gaps and marks forensic conclusions provisional", () => {
    expect(
      buildDataCompleteness([
        {
          field: "edgar.companyFacts",
          reason: "EDGAR request failed",
          severity: "critical",
          attemptedSources: ["sec"],
        },
        {
          field: "edgar.xbrl",
          reason: "XBRL cross-check skipped because company facts were unavailable",
          severity: "warn",
        },
      ]),
    ).toEqual({
      state: "blocked",
      criticalCount: 1,
      warningCount: 1,
      edgar: "missing",
      xbrl: "skipped",
      forensicValidation: "provisional",
    });
  });

  it("does not read a keyless substitution as an EDGAR outage on a keyed plan", () => {
    // A keyed plan whose statements FMP refused were filled FROM companyfacts:
    // `expected` is false (the substitution is an incident on a paid plan) and
    // the reason names edgar, but EDGAR was the source that SUCCEEDED here.
    const gaps: ManifestEntry[] = [
      {
        field: "keyless.incomeAnnual",
        reason:
          "served by edgar (companyfacts→income-statement(annual)) because FMP returned unparseable body (HTTP 402)",
        severity: "info",
        expected: false,
      },
      {
        field: "keyless.macroSectorOverlay",
        reason:
          "keyless profile resolved after macro routing; sector FRED overlay not fetched (sector Information Technology was only known once the fallback layer filled the profile)",
        severity: "info",
        expected: false,
      },
      {
        field: "keyless",
        reason:
          "the keyless fallback layer threw and was abandoned: boom; every member kept the result FMP returned and nothing was substituted",
        severity: "warn",
        attemptedSources: ["edgar:companyfacts", "yahoo"],
      },
    ];
    expect(buildDataCompleteness(gaps)).toEqual({
      state: "degraded",
      criticalCount: 0,
      warningCount: 1,
      edgar: "available",
      xbrl: "checked",
      forensicValidation: "complete",
    });
  });

  it("still reports a real EDGAR outage alongside a keyless substitution", () => {
    // The exclusion is scoped to the `keyless.*` namespace: EDGAR's own member
    // gap is in the same manifest and still classifies the run as missing.
    expect(
      buildDataCompleteness([
        {
          field: "keyless.incomeAnnual",
          reason: "EDGAR companyfacts unavailable: EDGAR HTTP 503",
          severity: "warn",
        },
        {
          field: "edgar.companyFacts(AAPL)",
          reason: "EDGAR HTTP 503",
          severity: "warn",
        },
      ]),
    ).toMatchObject({ edgar: "missing", forensicValidation: "provisional" });
  });

  it("reports a complete state when no provider gap was recorded", () => {
    expect(buildDataCompleteness([])).toEqual({
      state: "complete",
      criticalCount: 0,
      warningCount: 0,
      edgar: "available",
      xbrl: "checked",
      forensicValidation: "complete",
    });
  });

  it("marks only a confirmed 6-K structural MD&A omission expected", () => {
    const gap = {
      field: "edgar.tenQMdna",
      reason: "confirmed Form 6-K has no standardized Part I Item 2 MD&A",
      severity: "info" as const,
      expected: true,
    };
    expect(gap).toMatchObject({ field: "edgar.tenQMdna", expected: true });
    expect(buildDataCompleteness([gap])).toEqual({
      state: "complete",
      criticalCount: 0,
      warningCount: 0,
      edgar: "available",
      xbrl: "checked",
      forensicValidation: "complete",
    });
  });

  it("keeps an unexplained missing 10-Q MD&A actionable and degraded", () => {
    expect(
      buildDataCompleteness([
        {
          field: "edgar.tenQMdna",
          reason: "no 10-Q was found in recent submissions",
          severity: "warn",
        },
      ]),
    ).toEqual({
      state: "degraded",
      criticalCount: 0,
      warningCount: 1,
      edgar: "missing",
      xbrl: "checked",
      forensicValidation: "provisional",
    });
  });
});

const ANALYSIS_ONLY: ManifestEntry[] = [{
  field: "analysis.llm",
  reason: "TASK28:first persisted analysis reason",
  severity: "critical",
  attemptedSources: ["anthropic"],
}];

const RECOMPUTE = Symbol("recompute persisted completeness");
const MISSING = Symbol("persisted completeness missing");

function presentation(
  gaps: readonly ManifestEntry[],
  persisted: DataCompleteness | typeof RECOMPUTE | typeof MISSING = RECOMPUTE,
) {
  return deriveReportCompletenessPresentation(
    persisted === RECOMPUTE
      ? buildDataCompleteness(gaps)
      : persisted === MISSING
        ? undefined
        : persisted,
    gaps,
  );
}

function expectNoCompletenessOverclaim(value: string): void {
  expect(value).not.toMatch(/computed metrics are still complete/i);
  expect(value).not.toMatch(/full (data )?coverage/i);
  expect(value).not.toMatch(/deterministic data is complete/i);
}

describe("Task 28 completeness presentation truth table", () => {
  it("allows deterministic-complete copy only for analysis.llm-only with exactly consistent metadata", () => {
    const result = presentation(ANALYSIS_ONLY);
    expect(result).toMatchObject({
      metadataStatus: "confirmed",
      dataOnly: true,
      analysisReason: "TASK28:first persisted analysis reason",
      actionableGapCount: 1,
      additionalActionableGapCount: 0,
      expectedGapCount: 0,
      state: "blocked",
      criticalCount: 1,
      warningCount: 0,
      edgar: "available",
      xbrl: "checked",
      forensicValidation: "complete",
    });
    expect(result.bannerText).toContain("No completed multi-pass analysis");
    expect(result.bannerText).toContain("Deterministic data is complete");
    expect(result.bannerText).not.toContain("no reasoning");
  });

  it("counts every non-expected severity and only excludes exact analysis.llm from additional gaps", () => {
    const gaps: ManifestEntry[] = [
      ...ANALYSIS_ONLY,
      { field: "analysis.llm", reason: "TASK28:second reason must not win", severity: "warn" },
      { field: "llm.bull", reason: "bull pass unavailable", severity: "warn", expected: false },
      { field: "llm.bear", reason: "bear pass unavailable", severity: "info" },
      { field: "fundamentals.revenue", reason: "provider gap", severity: "critical" },
      { field: "business.structural", reason: "issuer does not report", severity: "info", expected: true },
    ];
    const result = presentation(gaps);
    expect(result).toMatchObject({
      metadataStatus: "confirmed",
      dataOnly: true,
      analysisReason: "TASK28:first persisted analysis reason",
      actionableGapCount: 5,
      additionalActionableGapCount: 3,
      expectedGapCount: 1,
      informationalActionableGapCount: 1,
    });
    expect(result.bannerText).toContain("3 additional data gaps");
    expectNoCompletenessOverclaim(result.bannerText!);
  });

  it("uses singular additional-gap grammar and never overclaims completeness", () => {
    const result = presentation([
      ...ANALYSIS_ONLY,
      { field: "llm.bull", reason: "one additional gap", severity: "info" },
    ]);
    expect(result.additionalActionableGapCount).toBe(1);
    expect(result.bannerText).toContain("1 additional data gap");
    expect(result.bannerText).not.toContain("1 additional data gaps");
    expectNoCompletenessOverclaim(result.bannerText!);
  });

  it("still permits deterministic-complete copy when every non-analysis disclosure is expected", () => {
    const result = presentation([
      ...ANALYSIS_ONLY,
      { field: "segments.structural", reason: "issuer does not report", severity: "info", expected: true },
    ]);
    expect(result).toMatchObject({
      additionalActionableGapCount: 0,
      expectedGapCount: 1,
    });
    expect(result.bannerText).toContain("Deterministic data is complete");
  });

  it("treats expected-only disclosures as non-actionable but keeps them visible", () => {
    const gaps: ManifestEntry[] = [{
      field: "segments.geographic",
      reason: "not reported by issuer",
      severity: "info",
      expected: true,
    }];
    const result = presentation(gaps);
    expect(result).toMatchObject({
      metadataStatus: "confirmed",
      dataOnly: false,
      actionableGapCount: 0,
      additionalActionableGapCount: 0,
      expectedGapCount: 1,
      state: "complete",
    });
    expect(result.bannerText).toBeNull();
    expect(result.manifestText).toContain("1 expected disclosure");
  });

  it("makes absent legacy metadata unknown even when the manifest is empty or analysis-only", () => {
    const empty = presentation([], MISSING);
    expect(empty).toMatchObject({
      metadataStatus: "missing",
      dataOnly: false,
      state: "unknown",
      criticalCount: "unknown",
      warningCount: "unknown",
      edgar: "unknown",
      xbrl: "unknown",
      forensicValidation: "unknown",
      bannerText: null,
    });
    expect(empty.manifestText).toContain("No missing-data entries recorded");
    expect(empty.manifestText).toMatch(/not recorded|not confirmed/i);
    expect(empty.manifestText).not.toMatch(/full (data )?coverage/i);

    const dataOnly = presentation(ANALYSIS_ONLY, MISSING);
    expect(dataOnly).toMatchObject({
      metadataStatus: "missing",
      dataOnly: true,
      state: "unknown",
      criticalCount: "unknown",
      warningCount: "unknown",
    });
    expect(dataOnly.bannerText).toMatch(/not recorded|not confirmed/i);
    expectNoCompletenessOverclaim(dataOnly.bannerText!);

    const nonempty = presentation([
      { field: "shares.float", reason: "not supplied", severity: "info" },
    ], MISSING);
    expect(nonempty).toMatchObject({
      metadataStatus: "missing",
      dataOnly: false,
      actionableGapCount: 1,
      state: "unknown",
      criticalCount: "unknown",
      warningCount: "unknown",
      bannerText: null,
    });
    expect(nonempty.manifestText).toContain("1 actionable gap");
    expectNoCompletenessOverclaim(nonempty.manifestText);
  });

  it.each([
    ["state", "complete"],
    ["criticalCount", 99],
    ["warningCount", 99],
    ["edgar", "missing"],
    ["xbrl", "failed"],
    ["forensicValidation", "provisional"],
  ] as const)("requires exact persisted/recomputed parity for %s", (field, wrong) => {
    const recomputed = buildDataCompleteness(ANALYSIS_ONLY);
    const inconsistent = { ...recomputed, [field]: wrong } as DataCompleteness;
    const result = presentation(ANALYSIS_ONLY, inconsistent);
    expect(result).toMatchObject({
      metadataStatus: "inconsistent",
      dataOnly: true,
      state: "unknown",
      criticalCount: "unknown",
      warningCount: "unknown",
      edgar: "unknown",
      xbrl: "unknown",
      forensicValidation: "unknown",
    });
    expect(result.bannerText).toMatch(/not confirmed|could not be confirmed/i);
    expectNoCompletenessOverclaim(result.bannerText!);
  });

  it("keeps no-analysis inconsistent metadata unknown without inventing a banner", () => {
    const gaps: ManifestEntry[] = [{
      field: "shares.float",
      reason: "not supplied",
      severity: "info",
    }];
    const persisted = { ...buildDataCompleteness(gaps), state: "complete" as const };
    const result = presentation(gaps, persisted);
    expect(result).toMatchObject({
      metadataStatus: "inconsistent",
      dataOnly: false,
      state: "unknown",
      criticalCount: "unknown",
      warningCount: "unknown",
      bannerText: null,
    });
    expectNoCompletenessOverclaim(result.statusText);
  });

  it.each([
    {
      name: "complete",
      gaps: [] as ManifestEntry[],
      state: "complete",
      critical: 0,
      warnings: 0,
      edgar: "available",
      xbrl: "checked",
      forensics: "complete",
    },
    {
      name: "degraded by actionable info",
      gaps: [{ field: "shares.float", reason: "not supplied", severity: "info" }] as ManifestEntry[],
      state: "degraded",
      critical: 0,
      warnings: 0,
      edgar: "available",
      xbrl: "checked",
      forensics: "complete",
    },
    {
      name: "blocked",
      gaps: [
        { field: "edgar.companyFacts", reason: "EDGAR request failed", severity: "critical" },
        { field: "edgar.xbrl", reason: "XBRL not checked", severity: "warn" },
      ] as ManifestEntry[],
      state: "blocked",
      critical: 1,
      warnings: 1,
      edgar: "missing",
      xbrl: "skipped",
      forensics: "provisional",
    },
  ])("shows confirmed $name state and exact stock-data dimensions without a data-only banner", (testCase) => {
    const result = presentation(testCase.gaps);
    expect(result).toMatchObject({
      metadataStatus: "confirmed",
      dataOnly: false,
      state: testCase.state,
      criticalCount: testCase.critical,
      warningCount: testCase.warnings,
      edgar: testCase.edgar,
      xbrl: testCase.xbrl,
      forensicValidation: testCase.forensics,
      bannerText: null,
    });
    expect(result.statusText).toContain(testCase.state);
    expect(result.statusText).toContain(`critical ${testCase.critical}`);
    expect(result.statusText).toContain(`warnings ${testCase.warnings}`);
    expect(result.statusText).toContain(`EDGAR ${testCase.edgar}`);
    expect(result.statusText).toContain(`XBRL ${testCase.xbrl}`);
    expect(result.statusText).toContain(`forensics ${testCase.forensics}`);
  });

  it("is deterministic and does not mutate persisted metadata or manifest order", () => {
    const gaps: ManifestEntry[] = [
      ...ANALYSIS_ONLY,
      { field: "llm.bull", reason: "additional", severity: "info" },
    ];
    const persisted = buildDataCompleteness(gaps);
    const before = JSON.stringify({ persisted, gaps });
    expect(presentation(gaps, persisted)).toEqual(presentation(gaps, persisted));
    expect(JSON.stringify({ persisted, gaps })).toBe(before);
  });
});
