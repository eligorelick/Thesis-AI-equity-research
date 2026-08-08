import {
  getEntityRegistry,
  validateEntityText,
  type EntityIssue,
  type EntityRegistry,
} from "@/pipeline/stageC/entityValidation";
import { buildDataCompleteness } from "@/report/completeness";
import {
  citationAsOf,
  citationSourceId,
  type CitationCarrier,
} from "@/pipeline/stageC/citations";
import {
  ReportSchema,
  withLenientLegacyRead,
  type Report,
} from "@/report/schema";

export interface LegacyEntitySafetyResult {
  report: Report;
  withheldCount: number;
  issues: EntityIssue[];
}

export interface SafeStoredReport extends LegacyEntitySafetyResult {
  readMode: "strict" | "legacy";
}

/** Validate a report with exactly the mode selected by its original stored read. */
export function validateStoredReportInReadMode(
  value: unknown,
  readMode: SafeStoredReport["readMode"],
): Report | null {
  const parsed = readMode === "strict"
    ? ReportSchema.safeParse(value)
    : withLenientLegacyRead(() => ReportSchema.safeParse(value));
  return parsed.success ? parsed.data : null;
}

/**
 * Parse one immutable stored-report view, sanitize it against the issuer's
 * canonical entity registry, then revalidate it under the original read mode.
 */
export function parseStoredReportWithSafety(
  reportJson: string | null,
): SafeStoredReport | null {
  if (reportJson === null) return null;
  try {
    const raw: unknown = JSON.parse(reportJson);
    const strict = ReportSchema.safeParse(raw);
    const readMode: SafeStoredReport["readMode"] = strict.success ? "strict" : "legacy";
    const parsed = strict.success
      ? strict.data
      : validateStoredReportInReadMode(raw, "legacy");
    if (parsed === null) return null;

    const safety = sanitizeLegacyEntityConflicts(
      parsed,
      getEntityRegistry(parsed.meta.symbol),
    );
    const revalidated = validateStoredReportInReadMode(safety.report, readMode);
    if (revalidated === null) return null;
    return {
      report: revalidated,
      readMode,
      withheldCount: safety.withheldCount,
      issues: safety.issues,
    };
  } catch {
    return null;
  }
}

/**
 * Build an in-memory, read-only-safe view of a legacy report. Unsafe
 * statements are withheld whole and disclosed; no entity name is guessed or
 * silently replaced, and the persisted report/database is never mutated.
 */
export function sanitizeLegacyEntityConflicts(
  report: Report,
  registry: EntityRegistry | null = getEntityRegistry(report.meta.symbol),
): LegacyEntitySafetyResult {
  const cloned = structuredClone(report);
  if (registry === null) {
    return { report: cloned, withheldCount: 0, issues: [] };
  }
  if (cloned.meta.symbol.toUpperCase() !== registry.symbol.toUpperCase()) {
    return { report: cloned, withheldCount: 0, issues: [] };
  }

  const issues: EntityIssue[] = [];
  let withheldCount = 0;
  let invalidCitationCount = 0;
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      const found = validateEntityText(value, registry, null).issues.filter(
        (issue) => issue.code !== "primary-source-required",
      );
      if (found.length === 0) return value;
      issues.push(...found);
      withheldCount += 1;
      const canonical = [...new Set(found.map((issue) => issue.canonicalName))].join(", ");
      const codes = [...new Set(found.map((issue) => issue.code))].join(", ");
      return `Legacy statement withheld: unresolved ${codes} conflict. Canonical primary-source reference: ${canonical}. See the missing-data manifest.`;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== "object") return value;
    const carrier = value as CitationCarrier;
    const hasCitationShape = typeof carrier.source === "string" && "asOf" in value;
    const normalizedSource = hasCitationShape ? citationSourceId(carrier) : null;
    const normalizedAsOf = hasCitationShape ? citationAsOf(carrier) : null;
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) output[key] = walk(nested);
    if (hasCitationShape) {
      if (normalizedSource !== null) {
        const sourceNeedsNormalization =
          normalizedSource !== carrier.source ||
          (typeof carrier.sourceId === "string" && carrier.sourceId !== normalizedSource) ||
          (carrier.asOf === null && normalizedAsOf !== null);
        if (sourceNeedsNormalization) {
          output.sourceId = normalizedSource;
          output.source = normalizedSource;
          output.asOf = normalizedAsOf ?? output.asOf;
        }
      } else {
        invalidCitationCount += 1;
        delete output.sourceId;
        output.source = "unsupported:legacy-citation";
        if ("verified" in output) {
          output.verified = false;
          output.verificationNote = `${typeof output.verificationNote === "string" ? `${output.verificationNote}; ` : ""}[unverified] ambiguous legacy citation`;
        }
      }
    }
    return output;
  };

  const safe = walk(cloned) as Report;
  if (withheldCount > 0 || invalidCitationCount > 0) {
    safe.appendix.missingData = [
      ...(withheldCount > 0 ? [{
        field: "legacy.entityValidation",
        reason: `${withheldCount} legacy statement(s) were withheld because canonical entity or drug–trial validation failed; stored data was not changed`,
        severity: "critical" as const,
        attemptedSources: ["canonical entity registry"],
      }] : []),
      ...(invalidCitationCount > 0 ? [{
        field: "legacy.citationValidation",
        reason: `${invalidCitationCount} ambiguous legacy citation(s) were marked unsupported; stored data was not changed`,
        severity: "warn" as const,
      }] : []),
      ...safe.appendix.missingData.filter((gap) =>
        gap.field !== "legacy.entityValidation" && gap.field !== "legacy.citationValidation"
      ),
    ];
    safe.meta.dataCompleteness = buildDataCompleteness(safe.appendix.missingData);
    if (withheldCount > 0 && !safe.disagreements.some((item) => item.kind === "entity")) {
      safe.disagreements.push({
        topic: "Legacy entity and trial associations",
        bullView: "The persisted analyst cases contained conflicting entity names and relationships.",
        bearView: "The persisted analyst cases contained conflicting entity names and relationships.",
        kind: "entity",
        judgeResolution:
          "The canonical primary-source entity registry was applied. Unsafe legacy statements are withheld, not rewritten.",
      });
    }
  }
  const deduped = new Map<string, EntityIssue>();
  for (const issue of issues) {
    deduped.set(`${issue.code}\u0000${issue.recordId}\u0000${issue.observed}`, issue);
  }
  return { report: safe, withheldCount, issues: [...deduped.values()] };
}
