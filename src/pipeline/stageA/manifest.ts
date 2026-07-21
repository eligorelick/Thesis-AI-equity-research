/**
 * Missing-data manifest utilities (the application contract §3): every gap is disclosed, never
 * papered over. This module merges gap lists from many sources (provider
 * FetchResults, validation, structural seeds) into one deduped,
 * severity-ordered manifest for the report appendix.
 *
 * Pure — no network, no db.
 */

import type { ManifestEntry } from "@/types/core";

// ---------------------------------------------------------------------------
// Severity ranking
// ---------------------------------------------------------------------------

const RANK: Record<ManifestEntry["severity"], number> = {
  info: 0,
  warn: 1,
  critical: 2,
};

/** Numeric rank for a severity: info=0 < warn=1 < critical=2. */
export function severityRank(severity: ManifestEntry["severity"]): number {
  return RANK[severity];
}

// ---------------------------------------------------------------------------
// mergeManifest
// ---------------------------------------------------------------------------

/** Accepted inputs: single entries, arrays, or nothing (null/undefined skipped). */
export type ManifestSource = ManifestEntry | ManifestEntry[] | null | undefined;

function dedupeSources(
  a: string[] | undefined,
  b: string[] | undefined,
): string[] | undefined {
  if (a === undefined && b === undefined) return undefined;
  const out: string[] = [];
  for (const s of [...(a ?? []), ...(b ?? [])]) {
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Merge any number of gap sources into one manifest:
 *  - deduped by `field`, keeping the HIGHEST severity entry (its reason wins);
 *  - `attemptedSources` are unioned across duplicates (order-preserving);
 *  - deterministic output: severity DESC, then field ASC.
 *
 * Input entries are never mutated.
 */
export function mergeManifest(...sources: ManifestSource[]): ManifestEntry[] {
  const byField = new Map<string, ManifestEntry>();

  for (const source of sources) {
    if (source === null || source === undefined) continue;
    const entries = Array.isArray(source) ? source : [source];
    for (const entry of entries) {
      const current = byField.get(entry.field);
      if (current === undefined) {
        byField.set(entry.field, { ...entry });
        continue;
      }
      const mergedSources = dedupeSources(current.attemptedSources, entry.attemptedSources);
      if (severityRank(entry.severity) > severityRank(current.severity)) {
        const winner: ManifestEntry = { ...entry };
        if (mergedSources !== undefined) winner.attemptedSources = mergedSources;
        byField.set(entry.field, winner);
      } else if (mergedSources !== undefined) {
        current.attemptedSources = mergedSources;
      }
    }
  }

  return [...byField.values()].sort((a, b) => {
    const bySeverity = severityRank(b.severity) - severityRank(a.severity);
    if (bySeverity !== 0) return bySeverity;
    return a.field < b.field ? -1 : a.field > b.field ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// renderManifestSummary
// ---------------------------------------------------------------------------

export interface ManifestSummary {
  total: number;
  bySeverity: { critical: number; warn: number; info: number };
  /** One-line human-readable summary for the report header/appendix. */
  line: string;
}

/** Counts by severity + a rendered one-liner. */
export function renderManifestSummary(entries: readonly ManifestEntry[]): ManifestSummary {
  const bySeverity = { critical: 0, warn: 0, info: 0 };
  for (const e of entries) bySeverity[e.severity]++;
  const line =
    `${entries.length} data gap(s): ${bySeverity.critical} critical, ` +
    `${bySeverity.warn} warning(s), ${bySeverity.info} informational`;
  return { total: entries.length, bySeverity, line };
}
