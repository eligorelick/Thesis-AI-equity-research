import type { ManifestEntry } from "@/types/core";

export interface DataCompleteness {
  state: "complete" | "degraded" | "blocked";
  criticalCount: number;
  warningCount: number;
  edgar: "available" | "missing";
  xbrl: "checked" | "skipped" | "failed";
  forensicValidation: "complete" | "provisional";
}

/** Summarize provider gaps without treating a missing response as valid data. */
export function buildDataCompleteness(
  gaps: readonly ManifestEntry[],
): DataCompleteness {
  const criticalCount = gaps.filter((gap) => gap.severity === "critical").length;
  const warningCount = gaps.filter((gap) => gap.severity === "warn").length;
  const edgarGaps = gaps.filter((gap) => /edgar|company.?facts/i.test(`${gap.field} ${gap.reason}`));
  const xbrlGaps = gaps.filter((gap) => /xbrl/i.test(`${gap.field} ${gap.reason}`));
  const xbrl = xbrlGaps.length === 0
    ? "checked" as const
    : xbrlGaps.every((gap) => /skip|not run|not checked/i.test(gap.reason))
      ? "skipped" as const
      : "failed" as const;
  const edgar = edgarGaps.length > 0 ? "missing" as const : "available" as const;

  return {
    state: criticalCount > 0 ? "blocked" : gaps.length > 0 ? "degraded" : "complete",
    criticalCount,
    warningCount,
    edgar,
    xbrl,
    forensicValidation: edgar === "missing" || xbrl !== "checked" ? "provisional" : "complete",
  };
}
