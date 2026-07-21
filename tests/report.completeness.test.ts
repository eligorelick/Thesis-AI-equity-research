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
});
