import {
  LLY_ENTITY_REGISTRY,
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
import type { Report } from "@/report/schema";

export interface LegacyEntitySafetyResult {
  report: Report;
  withheldCount: number;
  issues: EntityIssue[];
}

/**
 * Build an in-memory, read-only-safe view of a legacy report. Unsafe
 * statements are withheld whole and disclosed; no entity name is guessed or
 * silently replaced, and the persisted report/database is never mutated.
 */
export function sanitizeLegacyEntityConflicts(
  report: Report,
  registry: EntityRegistry = LLY_ENTITY_REGISTRY,
): LegacyEntitySafetyResult {
  const cloned = structuredClone(report);
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
        output.sourceId = normalizedSource;
        output.source = normalizedSource;
        output.asOf = normalizedAsOf;
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
          `Canonical registry entities: ${registry.records.map((record) => record.canonicalName).join("; ")}. Unsafe legacy statements are withheld, not rewritten.`,
      });
    }
  }
  const deduped = new Map<string, EntityIssue>();
  for (const issue of issues) {
    deduped.set(`${issue.code}\u0000${issue.recordId}\u0000${issue.observed}`, issue);
  }
  return { report: safe, withheldCount, issues: [...deduped.values()] };
}
