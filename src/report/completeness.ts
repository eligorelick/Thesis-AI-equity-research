import type { ManifestEntry } from "@/types/core";
import type { DataCompleteness as PersistedDataCompleteness } from "@/report/schema";

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
  // Expected structural omissions (for example, a non-standardized filing
  // section that is intentionally absent for an issuer) are disclosures, not
  // provider failures. Exclude them from headline completeness states while
  // retaining them in the report's detailed manifest.
  const actionableGaps = gaps.filter((gap) => gap.expected !== true);
  const criticalCount = actionableGaps.filter((gap) => gap.severity === "critical").length;
  const warningCount = actionableGaps.filter((gap) => gap.severity === "warn").length;
  // A `keyless.*` entry reports on the EDGAR + Yahoo SUBSTITUTION layer, not on
  // EDGAR's availability, and it names its sources in prose ("served by edgar
  // (companyfacts→income-statement)"). Classifying those as EDGAR gaps inverted
  // the meaning: a keyed run that successfully filled its statements FROM
  // companyfacts — the best possible EDGAR outcome — reported `edgar: "missing"`
  // and downgraded forensics to "provisional". When EDGAR really is unavailable
  // its own `edgar.*` member gaps are in this same manifest and still classify.
  const isKeylessEntry = (gap: ManifestEntry): boolean =>
    gap.field === "keyless" || gap.field.startsWith("keyless.");
  const edgarGaps = actionableGaps.filter(
    (gap) => !isKeylessEntry(gap) && /edgar|company.?facts/i.test(`${gap.field} ${gap.reason}`),
  );
  const xbrlGaps = actionableGaps.filter((gap) => /xbrl/i.test(`${gap.field} ${gap.reason}`));
  // "failed" must mean the cross-check RAN and disagreed — not that it could
  // not be performed. Stage A already encodes that distinction in severity: a
  // not-checkable period (no XBRL fact resolved, mixed currency) files an
  // `info` gap, while a real FMP↔XBRL disagreement files a `warn`. Classifying
  // on prose alone reported "failed" for reports that were merely never
  // cross-checked (e.g. a legacy report's "No XBRL/company-facts cross-check is
  // recorded", or "no XBRL fact matched period end=…").
  const xbrlCheckFailed = xbrlGaps.some(
    (gap) =>
      (gap.severity === "warn" || gap.severity === "critical") &&
      !/skip|not run|not checked|not checkable|no[t]?\s[^.]*\bcross-check\b|no xbrl fact/i.test(
        gap.reason,
      ),
  );
  const xbrl = xbrlGaps.length === 0
    ? "checked" as const
    : xbrlCheckFailed
      ? "failed" as const
      : "skipped" as const;
  const edgar = edgarGaps.length > 0 ? "missing" as const : "available" as const;

  return {
    state: criticalCount > 0 ? "blocked" : actionableGaps.length > 0 ? "degraded" : "complete",
    criticalCount,
    warningCount,
    edgar,
    xbrl,
    forensicValidation: edgar === "missing" || xbrl !== "checked" ? "provisional" : "complete",
  };
}

export type CompletenessMetadataStatus = "confirmed" | "missing" | "inconsistent";

export interface ReportCompletenessPresentation {
  metadataStatus: CompletenessMetadataStatus;
  dataOnly: boolean;
  analysisReason: string | null;
  actionableGapCount: number;
  additionalActionableGapCount: number;
  expectedGapCount: number;
  informationalActionableGapCount: number;
  state: PersistedDataCompleteness["state"] | "unknown";
  criticalCount: number | "unknown";
  warningCount: number | "unknown";
  edgar: PersistedDataCompleteness["edgar"] | "unknown";
  xbrl: PersistedDataCompleteness["xbrl"] | "unknown";
  forensicValidation: PersistedDataCompleteness["forensicValidation"] | "unknown";
  bannerText: string | null;
  manifestText: string;
  statusText: string;
}

function completenessMatches(
  persisted: PersistedDataCompleteness,
  recomputed: PersistedDataCompleteness,
): boolean {
  return persisted.state === recomputed.state
    && persisted.criticalCount === recomputed.criticalCount
    && persisted.warningCount === recomputed.warningCount
    && persisted.edgar === recomputed.edgar
    && persisted.xbrl === recomputed.xbrl
    && persisted.forensicValidation === recomputed.forensicValidation;
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Reconcile persisted completeness metadata with the raw manifest before any
 * renderer describes the report as complete. Missing or stale metadata stays
 * explicitly unknown; it is never silently replaced with a recomputation.
 */
export function deriveReportCompletenessPresentation(
  persisted: PersistedDataCompleteness | undefined,
  gaps: readonly ManifestEntry[],
): ReportCompletenessPresentation {
  const recomputed = buildDataCompleteness(gaps);
  const metadataStatus: CompletenessMetadataStatus = persisted === undefined
    ? "missing"
    : completenessMatches(persisted, recomputed)
      ? "confirmed"
      : "inconsistent";
  const analysisEntries = gaps.filter((gap) => gap.field === "analysis.llm");
  const analysisReason = analysisEntries[0]?.reason ?? null;
  const actionable = gaps.filter((gap) => gap.expected !== true);
  const additionalActionable = actionable.filter((gap) => gap.field !== "analysis.llm");
  const expectedGapCount = gaps.filter((gap) => gap.expected === true).length;
  const informationalActionableGapCount = additionalActionable.filter(
    (gap) => gap.severity === "info",
  ).length;

  const statusText = metadataStatus === "confirmed"
    ? `Completeness confirmed: state ${persisted!.state}; critical ${persisted!.criticalCount}; warnings ${persisted!.warningCount}; EDGAR ${persisted!.edgar}; XBRL ${persisted!.xbrl}; forensics ${persisted!.forensicValidation}.`
    : metadataStatus === "missing"
      ? "Completeness unknown: persisted completeness metadata was not recorded."
      : "Completeness unknown: persisted completeness metadata could not be confirmed against the missing-data manifest.";

  const manifestParts: string[] = [];
  if (gaps.length === 0) {
    manifestParts.push("No missing-data entries recorded.");
  } else {
    manifestParts.push(countLabel(actionable.length, "actionable gap", "actionable gaps"));
    if (expectedGapCount > 0) {
      manifestParts.push(countLabel(expectedGapCount, "expected disclosure", "expected disclosures"));
    }
  }
  if (metadataStatus !== "confirmed") manifestParts.push(statusText);

  let bannerText: string | null = null;
  if (analysisReason !== null) {
    const prefix = `No completed multi-pass analysis. ${analysisReason}`;
    if (metadataStatus === "confirmed" && additionalActionable.length === 0) {
      bannerText = `${prefix} Deterministic data is complete.`;
    } else if (metadataStatus === "confirmed") {
      bannerText = `${prefix} ${countLabel(additionalActionable.length, "additional data gap", "additional data gaps")} recorded.`;
    } else {
      bannerText = `${prefix} ${statusText}`;
    }
  }

  return {
    metadataStatus,
    dataOnly: analysisReason !== null,
    analysisReason,
    actionableGapCount: actionable.length,
    additionalActionableGapCount: additionalActionable.length,
    expectedGapCount,
    informationalActionableGapCount,
    state: metadataStatus === "confirmed" ? persisted!.state : "unknown",
    criticalCount: metadataStatus === "confirmed" ? persisted!.criticalCount : "unknown",
    warningCount: metadataStatus === "confirmed" ? persisted!.warningCount : "unknown",
    edgar: metadataStatus === "confirmed" ? persisted!.edgar : "unknown",
    xbrl: metadataStatus === "confirmed" ? persisted!.xbrl : "unknown",
    forensicValidation: metadataStatus === "confirmed"
      ? persisted!.forensicValidation
      : "unknown",
    bannerText,
    manifestText: manifestParts.join(" "),
    statusText,
  };
}
