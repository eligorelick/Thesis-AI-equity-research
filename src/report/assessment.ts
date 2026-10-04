import type { GradeBlock, Report } from "@/report/schema";
import { GRADE_SURFACES } from "@/report/surfaceManifest";
import type { Grade } from "@/types/core";

/** Presentation threshold only: raw scores and the composite calculation stay unchanged. */
export const MIN_HEADLINE_EVIDENCE = 0.5;

/**
 * Apply the same evidence floor to every headline, including completed AI
 * reports. Letters, narratives and scores remain intact for audit. Stored
 * reports use this immutable view; no historical bytes need to be rewritten.
 */
export function applyReportAssessmentStatus(report: Report): Report {
  // Truly older reports have no deterministic evidence map to evaluate.
  if (report.scores === undefined) return report;
  const normalized = structuredClone(report);
  for (const { key, sectionKey } of GRADE_SURFACES) {
    const aspect = report.scores.aspects[key];
    const strip = normalized.verdict.gradeStrip[key];
    const section = sectionKey === "competitive" ? normalized.competitive.moatGraded : normalized[sectionKey].graded;
    const statuses = [strip?.assessmentStatus, section?.assessmentStatus];
    const unavailable = aspect == null || aspect.score === null || aspect.band === null;
    // Existing withheld assessments can become more restrictive, never less.
    const status = unavailable || statuses.includes("not-assessed")
      ? "not-assessed"
      : aspect.dataCompleteness < MIN_HEADLINE_EVIDENCE || statuses.includes("limited-evidence")
        ? "limited-evidence"
        : undefined;
    if (status === undefined) continue;
    if (strip !== undefined) strip.assessmentStatus = status;
    if (section !== undefined) section.assessmentStatus = status;
  }
  return normalized;
}

export function gradeForDisplay(block: GradeBlock): Grade | null {
  if (block.assessmentStatus === "not-assessed" || block.assessmentStatus === "limited-evidence") return null;
  // Previously saved data-only reports used required placeholder letters. Do not
  // promote those canonical disclosures back into an apparent assessment.
  if (/^(?:Not scored|Not graded|Not assessed|LLM analysis did not run)/i.test(block.oneLineWhy)) return null;
  const legacyCoverage = /on (\d+)% of intended signals; no analyst pass ran/.exec(block.oneLineWhy);
  if (legacyCoverage && Number(legacyCoverage[1]) < MIN_HEADLINE_EVIDENCE * 100) return null;
  return block.grade;
}

export function gradeDisplayLabel(block: GradeBlock): string {
  if (gradeForDisplay(block) !== null) return block.grade;
  return block.assessmentStatus === "limited-evidence" || /on (\d+)% of intended signals/.test(block.oneLineWhy)
    ? "Not assessed — limited evidence"
    : "Not assessed";
}
