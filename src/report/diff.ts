/**
 * Report diffing — compares two saved reports (the application contract §8 "Report history:
 * diff view between any two dates — grade changes, target changes, new/removed
 * catalysts and risks").
 *
 * `a` is the OLDER report, `b` the NEWER one. Changes are described as the move
 * from `a` to `b`.
 *
 * Catalysts and risks are matched across the two reports by fuzzy title
 * similarity (normalized-Levenshtein ≥ 0.8) so a lightly reworded title
 * ("China demand slowdown" → "China demand slow-down") is treated as the same
 * item that persisted, not one removed + one added. The Levenshtein routine is
 * implemented inline — no dependencies.
 */

import type { Grade } from "@/types/core";
import type { Report } from "./schema";

/* ------------------------------------------------------------------------ *
 * Fuzzy title matching (inline Levenshtein — no deps)
 * ------------------------------------------------------------------------ */

/** Title-similarity threshold: at/above this, two titles are "the same". */
export const TITLE_SIMILARITY_THRESHOLD = 0.8;

/** Lowercase, collapse whitespace, strip surrounding punctuation/hyphens. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Classic Wagner–Fischer Levenshtein edit distance between two strings.
 * Two-row rolling buffer — O(n·m) time, O(min(n,m)) space.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Ensure `a` is the shorter string to minimize the row buffer.
  if (a.length > b.length) {
    const tmp = a;
    a = b;
    b = tmp;
  }
  let prev = new Array<number>(a.length + 1);
  let curr = new Array<number>(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;
  for (let j = 1; j <= b.length; j++) {
    curr[0] = j;
    const bj = b.charCodeAt(j - 1);
    for (let i = 1; i <= a.length; i++) {
      const cost = a.charCodeAt(i - 1) === bj ? 0 : 1;
      const del = prev[i] + 1;
      const ins = curr[i - 1] + 1;
      const sub = prev[i - 1] + cost;
      curr[i] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[a.length];
}

/**
 * Normalized similarity in [0, 1]: 1 − editDistance / maxLen, over the
 * normalized titles. Two empty/identical titles score 1.
 */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

/**
 * Greedy best-match pairing of two titled lists. Returns, for each item in
 * `bList`, the index of its best match in `aList` (or -1 if no match clears the
 * threshold), and the set of `aList` indices that were matched. Each `a` index
 * is claimed at most once (highest-similarity `b` wins).
 */
function matchByTitle<T extends { title: string }>(
  aList: readonly T[],
  bList: readonly T[],
): { matchForB: number[]; matchedA: Set<number> } {
  const matchForB = new Array<number>(bList.length).fill(-1);
  const matchedA = new Set<number>();
  // Compute all candidate pairs above threshold, then assign greedily by score.
  const pairs: { bi: number; ai: number; score: number }[] = [];
  for (let bi = 0; bi < bList.length; bi++) {
    for (let ai = 0; ai < aList.length; ai++) {
      const score = titleSimilarity(bList[bi].title, aList[ai].title);
      if (score >= TITLE_SIMILARITY_THRESHOLD) {
        pairs.push({ bi, ai, score });
      }
    }
  }
  pairs.sort((p, q) => q.score - p.score);
  const bTaken = new Set<number>();
  for (const { bi, ai } of pairs) {
    if (bTaken.has(bi) || matchedA.has(ai)) continue;
    matchForB[bi] = ai;
    matchedA.add(ai);
    bTaken.add(bi);
  }
  return { matchForB, matchedA };
}

/* ------------------------------------------------------------------------ *
 * Diff result shape
 * ------------------------------------------------------------------------ */

export interface GradeChange {
  section: string;
  from: Grade;
  to: Grade;
}

export interface TargetChange {
  scenario: "bull" | "base" | "bear";
  fromValue: number;
  toValue: number;
  /** (to − from) / |from|, or null when `from` is 0 (undefined pct). */
  pctChange: number | null;
}

/** A change in a deterministic aspect (or composite) score, a → b. */
export interface ScoreChange {
  /** "composite" or an aspect key. */
  aspect: string;
  from: number | null;
  to: number | null;
  fromBand: Grade | null;
  toBand: Grade | null;
}

/** A change in a weighted forward projection at a horizon, a → b. */
export interface ProjectionChange {
  metric: string;
  period: string;
  fromValue: number;
  toValue: number;
  /** (to − from) / |from|, or null when `from` is 0. */
  pctChange: number | null;
}

export interface ReportDiff {
  gradeChanges: GradeChange[];
  targetChanges: TargetChange[];
  scoreChanges: ScoreChange[];
  projectionChanges: ProjectionChange[];
  newCatalysts: string[];
  removedCatalysts: string[];
  newRisks: string[];
  removedRisks: string[];
  verdictChanged: boolean;
  costDelta: number;
}

/* ------------------------------------------------------------------------ *
 * diffReports
 * ------------------------------------------------------------------------ */

/**
 * The graded sections and how to read each grade off a Report. `get` may return
 * null (balanceSheet is optional on 1.0.0 reports); a null on either side skips
 * that section's grade diff.
 */
const GRADE_SECTIONS: {
  section: string;
  get: (r: Report) => Grade | null;
}[] = [
  { section: "fundamentals", get: (r) => r.verdict.gradeStrip.fundamentals.grade },
  { section: "valuation", get: (r) => r.verdict.gradeStrip.valuation.grade },
  { section: "technicals", get: (r) => r.verdict.gradeStrip.technicals.grade },
  { section: "quality", get: (r) => r.verdict.gradeStrip.quality.grade },
  { section: "leadership", get: (r) => r.verdict.gradeStrip.leadership.grade },
  { section: "moat", get: (r) => r.verdict.gradeStrip.moat.grade },
  { section: "balanceSheet", get: (r) => r.verdict.gradeStrip.balanceSheet?.grade ?? null },
];

/** The composite + seven scored aspects, and how to read each score off a Report. */
const SCORE_KEYS = [
  "composite",
  "fundamentals",
  "valuation",
  "quality",
  "balanceSheet",
  "moat",
  "leadership",
  "technicals",
] as const;

/** Weighted-projection horizons to diff (y1 / y3 / y5 by index). */
const PROJECTION_HORIZON_INDICES = [0, 2, 4] as const;

/**
 * Diff two reports. `a` is the older report, `b` the newer; every field
 * describes the move a → b.
 */
export function diffReports(a: Report, b: Report): ReportDiff {
  // --- grade changes ------------------------------------------------------
  const gradeChanges: GradeChange[] = [];
  for (const { section, get } of GRADE_SECTIONS) {
    const from = get(a);
    const to = get(b);
    if (from === null || to === null) continue; // aspect absent on one side
    if (from !== to) gradeChanges.push({ section, from, to });
  }

  // --- score changes (deterministic composite + aspects) ------------------
  const scoreChanges: ScoreChange[] = [];
  if (a.scores && b.scores) {
    const sa = a.scores;
    const sb = b.scores;
    for (const key of SCORE_KEYS) {
      const from = key === "composite" ? sa.composite : sa.aspects[key];
      const to = key === "composite" ? sb.composite : sb.aspects[key];
      const scoreMoved =
        (from.score === null ? null : Math.round(from.score)) !==
        (to.score === null ? null : Math.round(to.score));
      if (scoreMoved || from.band !== to.band) {
        scoreChanges.push({
          aspect: key,
          from: from.score,
          to: to.score,
          fromBand: from.band,
          toBand: to.band,
        });
      }
    }
  }

  // --- projection changes (weighted path at y1/y3/y5) ---------------------
  const projectionChanges: ProjectionChange[] = [];
  if (a.projections && b.projections) {
    for (const seriesB of b.projections.series) {
      const seriesA = a.projections.series.find((s) => s.metric === seriesB.metric);
      if (!seriesA) continue;
      for (const i of PROJECTION_HORIZON_INDICES) {
        const pa = seriesA.weighted[i];
        const pb = seriesB.weighted[i];
        if (!pa || !pb || pa.period !== pb.period) continue;
        const fromValue = pa.value.value;
        const toValue = pb.value.value;
        if (fromValue === toValue) continue;
        projectionChanges.push({
          metric: seriesB.metric,
          period: pb.period,
          fromValue,
          toValue,
          pctChange: fromValue === 0 ? null : (toValue - fromValue) / Math.abs(fromValue),
        });
      }
    }
  }

  // --- scenario target changes -------------------------------------------
  const targetChanges: TargetChange[] = [];
  for (const name of ["bull", "base", "bear"] as const) {
    const sa = a.valuation.scenarios.find((s) => s.name === name);
    const sb = b.valuation.scenarios.find((s) => s.name === name);
    if (sa === undefined || sb === undefined) continue;
    // Either target null = suppressed in one of the reports — nothing to diff.
    if (sa.priceTarget === null || sb.priceTarget === null) continue;
    const fromValue = sa.priceTarget.value;
    const toValue = sb.priceTarget.value;
    if (fromValue === toValue) continue;
    const pctChange =
      fromValue === 0 ? null : (toValue - fromValue) / Math.abs(fromValue);
    targetChanges.push({ scenario: name, fromValue, toValue, pctChange });
  }

  // --- catalysts (fuzzy title match) -------------------------------------
  const catA = a.catalystsRisks.catalysts;
  const catB = b.catalystsRisks.catalysts;
  const catMatch = matchByTitle(catA, catB);
  const newCatalysts = catB
    .filter((_, bi) => catMatch.matchForB[bi] === -1)
    .map((c) => c.title);
  const removedCatalysts = catA
    .filter((_, ai) => !catMatch.matchedA.has(ai))
    .map((c) => c.title);

  // --- risks (fuzzy title match) -----------------------------------------
  const riskA = a.catalystsRisks.risks;
  const riskB = b.catalystsRisks.risks;
  const riskMatch = matchByTitle(riskA, riskB);
  const newRisks = riskB
    .filter((_, bi) => riskMatch.matchForB[bi] === -1)
    .map((r) => r.title);
  const removedRisks = riskA
    .filter((_, ai) => !riskMatch.matchedA.has(ai))
    .map((r) => r.title);

  // --- verdict synthesis + cost ------------------------------------------
  const verdictChanged =
    normalizeTitle(a.verdict.synthesis) !== normalizeTitle(b.verdict.synthesis);
  const costDelta = b.meta.costUsd - a.meta.costUsd;

  return {
    gradeChanges,
    targetChanges,
    scoreChanges,
    projectionChanges,
    newCatalysts,
    removedCatalysts,
    newRisks,
    removedRisks,
    verdictChanged,
    costDelta,
  };
}
