import { describe, expect, it } from "vitest";

import { buildDataCompleteness } from "@/report/completeness";

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
