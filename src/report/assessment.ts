import type { GradeBlock } from "@/report/schema";
import type { Grade } from "@/types/core";

/** Presentation threshold only: raw scores and the composite calculation stay unchanged. */
export const MIN_HEADLINE_EVIDENCE = 0.5;

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
