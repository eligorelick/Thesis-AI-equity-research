/**
 * Deterministic, version-aware comparison of two persisted reports.
 *
 * The first report is the older/source endpoint and the second is the
 * newer/target endpoint. The function is pure: it never mutates either report
 * and its result contains only JSON-safe values.
 */

import type { Grade } from "@/types/core";
import { normalizeSymbol, sameEntitySymbol } from "@/symbol";
import type {
  ProjectionMetric,
  Report,
  ScoreAspect,
  TracedNumber,
} from "./schema";

/* ------------------------------------------------------------------------ *
 * Fuzzy title matching
 * ------------------------------------------------------------------------ */

export const TITLE_SIMILARITY_THRESHOLD = 0.8;

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (a.length > b.length) {
    const swap = a;
    a = b;
    b = swap;
  }
  let previous = new Array<number>(a.length + 1);
  let current = new Array<number>(a.length + 1);
  for (let index = 0; index <= a.length; index += 1) previous[index] = index;
  for (let right = 1; right <= b.length; right += 1) {
    current[0] = right;
    const rightCode = b.charCodeAt(right - 1);
    for (let left = 1; left <= a.length; left += 1) {
      const cost = a.charCodeAt(left - 1) === rightCode ? 0 : 1;
      current[left] = Math.min(
        previous[left] + 1,
        current[left - 1] + 1,
        previous[left - 1] + cost,
      );
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[a.length];
}

export function titleSimilarity(a: string, b: string): number {
  const normalizedA = normalizeTitle(a);
  const normalizedB = normalizeTitle(b);
  if (normalizedA === normalizedB) return 1;
  const maximumLength = Math.max(normalizedA.length, normalizedB.length);
  if (maximumLength === 0) return 1;
  return 1 - levenshtein(normalizedA, normalizedB) / maximumLength;
}

function matchByTitle<T extends { title: string }>(
  fromItems: readonly T[],
  toItems: readonly T[],
): { matchForTo: number[]; matchedFrom: Set<number> } {
  const matchForTo = new Array<number>(toItems.length).fill(-1);
  const matchedFrom = new Set<number>();
  const candidates: { toIndex: number; fromIndex: number; similarity: number }[] = [];
  for (let toIndex = 0; toIndex < toItems.length; toIndex += 1) {
    for (let fromIndex = 0; fromIndex < fromItems.length; fromIndex += 1) {
      const similarity = titleSimilarity(
        toItems[toIndex]!.title,
        fromItems[fromIndex]!.title,
      );
      if (similarity >= TITLE_SIMILARITY_THRESHOLD) {
        candidates.push({ toIndex, fromIndex, similarity });
      }
    }
  }
  candidates.sort(
    (left, right) =>
      right.similarity - left.similarity ||
      left.toIndex - right.toIndex ||
      left.fromIndex - right.fromIndex,
  );
  const matchedTo = new Set<number>();
  for (const candidate of candidates) {
    if (
      matchedTo.has(candidate.toIndex) ||
      matchedFrom.has(candidate.fromIndex)
    ) {
      continue;
    }
    matchForTo[candidate.toIndex] = candidate.fromIndex;
    matchedFrom.add(candidate.fromIndex);
    matchedTo.add(candidate.toIndex);
  }
  return { matchForTo, matchedFrom };
}

/* ------------------------------------------------------------------------ *
 * Public result contract
 * ------------------------------------------------------------------------ */

export type TransitionKind =
  | "changed"
  | "added"
  | "removed"
  | "became-available"
  | "became-unavailable";

export type ComparisonState = "comparable" | "not-comparable";
export type ComparisonStatus = "changed" | "unchanged" | "not-comparable";
export type SourceFreshness = "fresh" | "stale" | "unknown";
export type ProjectionPath = "historical" | "bull" | "base" | "bear" | "weighted";
export type GradeSection =
  | "fundamentals"
  | "valuation"
  | "technicals"
  | "quality"
  | "leadership"
  | "moat"
  | "balanceSheet";
export type ScoreIdentity = "composite" | ScoreAspect;
export type TargetScenario = "bull" | "base" | "bear";

export type DiffReasonCode =
  | "invalid-entity"
  | "entity-mismatch"
  | "missing-from-report-version"
  | "missing-to-report-version"
  | "from-report-version-conflict"
  | "to-report-version-conflict"
  | "report-version-mismatch"
  | "missing-from-spec-version"
  | "missing-to-spec-version"
  | "from-spec-metadata-conflict"
  | "to-spec-metadata-conflict"
  | "spec-version-mismatch"
  | "duplicate-driver-identity"
  | "duplicate-target-identity"
  | "duplicate-projection-identity"
  | "projection-period-conflict"
  | "unit-mismatch"
  | "currency-mismatch"
  | "period-mismatch";

export interface VersionedDiffContext {
  fromReportVersion: string;
  toReportVersion: string;
  fromSpecVersion: string | null;
  toSpecVersion: string | null;
}

export interface DiffComparison {
  comparison: ComparisonState;
  reasons: DiffReasonCode[];
}

interface TransitionComparison extends DiffComparison {
  transition: TransitionKind;
}

export interface TracedValueSnapshot {
  value: number | null;
  unit: string | null;
  currency: string | null;
  period: string | null;
  sourceId: string | null;
  source: string | null;
  asOf: string | null;
  verified: boolean | null;
  verificationNote: string | null;
  seriesUnit: string | null;
}

export interface GradeChange extends TransitionComparison {
  section: GradeSection;
  from: Grade | null;
  to: Grade | null;
}

export interface ScoreEndpoint {
  value: number | null;
  band: Grade | null;
}

export interface ScoreChange extends TransitionComparison {
  aspect: ScoreIdentity;
  from: ScoreEndpoint | null;
  to: ScoreEndpoint | null;
  fromValue: number | null;
  toValue: number | null;
  fromBand: Grade | null;
  toBand: Grade | null;
}

export interface CompositeWeightChange extends TransitionComparison {
  aspect: ScoreAspect;
  fromValue: number | null;
  toValue: number | null;
}

export interface DriverChange extends TransitionComparison {
  aspect: ScoreAspect;
  sourceKey: string;
  unit: string;
  period: string;
  from: TracedValueSnapshot | null;
  to: TracedValueSnapshot | null;
  fromValue: number | null;
  toValue: number | null;
  pctChange: number | null;
}

export interface TargetChange extends TransitionComparison {
  scenario: TargetScenario;
  from: TracedValueSnapshot | null;
  to: TracedValueSnapshot | null;
  fromValue: number | null;
  toValue: number | null;
  pctChange: number | null;
}

export interface ProjectionChange extends TransitionComparison {
  path: ProjectionPath;
  metric: ProjectionMetric;
  period: string;
  from: TracedValueSnapshot | null;
  to: TracedValueSnapshot | null;
  fromValue: number | null;
  toValue: number | null;
  pctChange: number | null;
}

export interface TextTransition extends TransitionComparison {
  title: string;
  from: string | null;
  to: string | null;
}

export interface VerdictChange extends TransitionComparison {
  from: string;
  to: string;
}

export interface CostChange extends TransitionComparison {
  fromValue: number;
  toValue: number;
  delta: number;
}

export interface FamilyComparisons {
  grades: DiffComparison;
  scores: DiffComparison;
  weights: DiffComparison;
  drivers: DiffComparison;
  targets: DiffComparison;
  projections: Record<ProjectionPath, DiffComparison>;
  catalysts: DiffComparison;
  risks: DiffComparison;
  verdict: DiffComparison;
  cost: DiffComparison;
}

export interface ReportDiff {
  context: VersionedDiffContext;
  comparisonStatus: ComparisonStatus;
  notComparableReasons: DiffReasonCode[];
  familyComparisons: FamilyComparisons;
  sourceFreshness: { from: SourceFreshness; to: SourceFreshness };
  gradeChanges: GradeChange[];
  scoreChanges: ScoreChange[];
  weightChanges: CompositeWeightChange[];
  driverChanges: DriverChange[];
  targetChanges: TargetChange[];
  projectionChanges: ProjectionChange[];
  catalystChanges: TextTransition[];
  riskChanges: TextTransition[];
  verdictChange: VerdictChange | null;
  costChange: CostChange | null;
  newCatalysts: string[];
  removedCatalysts: string[];
  newRisks: string[];
  removedRisks: string[];
  verdictChanged: boolean;
  costDelta: number;
}

/* ------------------------------------------------------------------------ *
 * Normalization and comparison helpers
 * ------------------------------------------------------------------------ */

const GRADE_SECTIONS: {
  section: GradeSection;
  get: (report: Report) => Grade | null;
}[] = [
  { section: "fundamentals", get: (report) => report.verdict.gradeStrip.fundamentals.grade },
  { section: "valuation", get: (report) => report.verdict.gradeStrip.valuation.grade },
  { section: "technicals", get: (report) => report.verdict.gradeStrip.technicals.grade },
  { section: "quality", get: (report) => report.verdict.gradeStrip.quality.grade },
  { section: "leadership", get: (report) => report.verdict.gradeStrip.leadership.grade },
  { section: "moat", get: (report) => report.verdict.gradeStrip.moat.grade },
  {
    section: "balanceSheet",
    get: (report) => report.verdict.gradeStrip.balanceSheet?.grade ?? null,
  },
];

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

const ASPECT_KEYS = SCORE_KEYS.filter((key) => key !== "composite");
const PROJECTION_PATHS: ProjectionPath[] = [
  "historical",
  "bull",
  "base",
  "bear",
  "weighted",
];

type RuntimeTrace = Omit<TracedNumber, "value"> & { value: number | null };
type RuntimeScore = {
  score: number | null;
  band: Grade | null;
  drivers?: RuntimeTrace[];
};
type RuntimeScoring = {
  composite: RuntimeScore & {
    weights: Partial<Record<ScoreAspect, number | null | undefined>>;
  };
  aspects: Record<ScoreAspect, RuntimeScore>;
};
type RuntimeProjectionPoint = { period: string; value: RuntimeTrace };
type RuntimeProjectionSeries = {
  metric: ProjectionMetric;
  unit: string;
  historical: RuntimeProjectionPoint[];
  bull: RuntimeProjectionPoint[];
  base: RuntimeProjectionPoint[];
  bear: RuntimeProjectionPoint[];
  weighted: RuntimeProjectionPoint[];
};

function uniqueReasons(reasons: readonly DiffReasonCode[]): DiffReasonCode[] {
  return [...new Set(reasons)];
}

function comparisonFor(reasons: readonly DiffReasonCode[]): DiffComparison {
  const normalized = uniqueReasons(reasons);
  return {
    comparison: normalized.length === 0 ? "comparable" : "not-comparable",
    reasons: normalized,
  };
}

function orderedUnion<T>(from: readonly T[], to: readonly T[]): T[] {
  return [...new Set([...from, ...to])];
}

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function knownVersion(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizedContext(context: VersionedDiffContext): VersionedDiffContext {
  return {
    fromReportVersion: context.fromReportVersion,
    toReportVersion: context.toReportVersion,
    fromSpecVersion: context.fromSpecVersion,
    toSpecVersion: context.toSpecVersion,
  };
}

function versionReasons(
  fromReport: Report,
  toReport: Report,
  context: VersionedDiffContext,
): DiffReasonCode[] {
  const reasons: DiffReasonCode[] = [];
  const fromEmbeddedReport = fromReport.meta.pipelineVersion;
  const toEmbeddedReport = toReport.meta.pipelineVersion;
  const fromEmbeddedSpec = fromReport.meta.specVersion;
  const toEmbeddedSpec = toReport.meta.specVersion;

  if (!knownVersion(context.fromReportVersion) || !knownVersion(fromEmbeddedReport)) {
    reasons.push("missing-from-report-version");
  } else if (context.fromReportVersion !== fromEmbeddedReport) {
    reasons.push("from-report-version-conflict");
  }
  if (!knownVersion(context.toReportVersion) || !knownVersion(toEmbeddedReport)) {
    reasons.push("missing-to-report-version");
  } else if (context.toReportVersion !== toEmbeddedReport) {
    reasons.push("to-report-version-conflict");
  }
  if (
    knownVersion(context.fromReportVersion) &&
    knownVersion(context.toReportVersion) &&
    context.fromReportVersion !== context.toReportVersion
  ) {
    reasons.push("report-version-mismatch");
  }

  if (!knownVersion(context.fromSpecVersion) || !knownVersion(fromEmbeddedSpec)) {
    reasons.push("missing-from-spec-version");
  } else if (context.fromSpecVersion !== fromEmbeddedSpec) {
    reasons.push("from-spec-metadata-conflict");
  }
  if (!knownVersion(context.toSpecVersion) || !knownVersion(toEmbeddedSpec)) {
    reasons.push("missing-to-spec-version");
  } else if (context.toSpecVersion !== toEmbeddedSpec) {
    reasons.push("to-spec-metadata-conflict");
  }
  if (
    knownVersion(context.fromSpecVersion) &&
    knownVersion(context.toSpecVersion) &&
    context.fromSpecVersion !== context.toSpecVersion
  ) {
    reasons.push("spec-version-mismatch");
  }
  return uniqueReasons(reasons);
}

function sourceFreshness(report: Report): SourceFreshness {
  const sources = report.appendix.sources;
  if (sources.some((source) => source.stale === true)) return "stale";
  if (sources.length > 0 && sources.every((source) => source.stale === false)) {
    return "fresh";
  }
  return "unknown";
}

function snapshot(
  trace: RuntimeTrace | TracedNumber,
  seriesUnit: string | null = null,
): TracedValueSnapshot {
  const runtime = trace as RuntimeTrace;
  return {
    value: runtime.value ?? null,
    unit: runtime.unit ?? null,
    currency: runtime.currency ?? null,
    period: runtime.period ?? null,
    sourceId: runtime.sourceId ?? null,
    source: runtime.source ?? null,
    asOf: runtime.asOf ?? null,
    verified: runtime.verified ?? null,
    verificationNote: runtime.verificationNote ?? null,
    seriesUnit,
  };
}

function sameSnapshot(
  from: TracedValueSnapshot,
  to: TracedValueSnapshot,
): boolean {
  return (
    from.value === to.value &&
    from.unit === to.unit &&
    from.currency === to.currency &&
    from.period === to.period &&
    from.sourceId === to.sourceId &&
    from.source === to.source &&
    from.asOf === to.asOf &&
    from.verified === to.verified &&
    from.verificationNote === to.verificationNote &&
    from.seriesUnit === to.seriesUnit
  );
}

function dimensionReasons(
  from: TracedValueSnapshot,
  to: TracedValueSnapshot,
  includePeriod = true,
): DiffReasonCode[] {
  const reasons: DiffReasonCode[] = [];
  if (
    from.unit !== to.unit ||
    from.seriesUnit !== to.seriesUnit ||
    (from.seriesUnit !== null && from.unit !== from.seriesUnit) ||
    (to.seriesUnit !== null && to.unit !== to.seriesUnit)
  ) {
    reasons.push("unit-mismatch");
  }
  if (from.currency !== to.currency) reasons.push("currency-mismatch");
  if (includePeriod && from.period !== to.period) reasons.push("period-mismatch");
  return uniqueReasons(reasons);
}

function transitionFor(
  fromPresent: boolean,
  toPresent: boolean,
  fromValue: number | null,
  toValue: number | null,
): TransitionKind {
  if (!fromPresent) return "added";
  if (!toPresent) return "removed";
  if (fromValue === null && toValue !== null) return "became-available";
  if (fromValue !== null && toValue === null) return "became-unavailable";
  return "changed";
}

function percentageChange(
  from: TracedValueSnapshot | null,
  to: TracedValueSnapshot | null,
  transition: TransitionKind,
  comparison: ComparisonState,
): number | null {
  if (
    transition !== "changed" ||
    comparison !== "comparable" ||
    from === null ||
    to === null ||
    from.value === null ||
    to.value === null ||
    from.value === to.value ||
    from.value === 0
  ) {
    return null;
  }
  return (to.value - from.value) / Math.abs(from.value);
}

function transitionComparison(
  transition: TransitionKind,
  reasons: readonly DiffReasonCode[],
): TransitionComparison {
  return { transition, ...comparisonFor(reasons) };
}

function emptyFamilyComparisons(reasons: readonly DiffReasonCode[]): FamilyComparisons {
  const comparison = comparisonFor(reasons);
  return {
    grades: { ...comparison, reasons: [...comparison.reasons] },
    scores: { ...comparison, reasons: [...comparison.reasons] },
    weights: { ...comparison, reasons: [...comparison.reasons] },
    drivers: { ...comparison, reasons: [...comparison.reasons] },
    targets: { ...comparison, reasons: [...comparison.reasons] },
    projections: {
      historical: { ...comparison, reasons: [...comparison.reasons] },
      bull: { ...comparison, reasons: [...comparison.reasons] },
      base: { ...comparison, reasons: [...comparison.reasons] },
      bear: { ...comparison, reasons: [...comparison.reasons] },
      weighted: { ...comparison, reasons: [...comparison.reasons] },
    },
    catalysts: { ...comparison, reasons: [...comparison.reasons] },
    risks: { ...comparison, reasons: [...comparison.reasons] },
    verdict: { ...comparison, reasons: [...comparison.reasons] },
    cost: { ...comparison, reasons: [...comparison.reasons] },
  };
}

function emptyReportDiff(
  context: VersionedDiffContext,
  reasons: readonly DiffReasonCode[],
  from: Report,
  to: Report,
): ReportDiff {
  const normalizedReasons = uniqueReasons(reasons);
  return {
    context: normalizedContext(context),
    comparisonStatus: "not-comparable",
    notComparableReasons: normalizedReasons,
    familyComparisons: emptyFamilyComparisons(normalizedReasons),
    sourceFreshness: { from: sourceFreshness(from), to: sourceFreshness(to) },
    gradeChanges: [],
    scoreChanges: [],
    weightChanges: [],
    driverChanges: [],
    targetChanges: [],
    projectionChanges: [],
    catalystChanges: [],
    riskChanges: [],
    verdictChange: null,
    costChange: null,
    newCatalysts: [],
    removedCatalysts: [],
    newRisks: [],
    removedRisks: [],
    verdictChanged: false,
    costDelta: 0,
  };
}

interface DriverIndex {
  entries: Map<string, { aspect: ScoreAspect; sourceKey: string; unit: string; period: string; trace: RuntimeTrace }>;
  order: string[];
  ambiguous: Set<string>;
  duplicate: boolean;
}

function indexDrivers(scoring: RuntimeScoring | undefined): DriverIndex {
  const entries = new Map<
    string,
    { aspect: ScoreAspect; sourceKey: string; unit: string; period: string; trace: RuntimeTrace }
  >();
  const order: string[] = [];
  const duplicates = new Set<string>();
  if (scoring) {
    for (const aspect of ASPECT_KEYS) {
      for (const trace of scoring.aspects[aspect]?.drivers ?? []) {
        const sourceKey = trace.sourceId ?? trace.source;
        const period = trace.period ?? "";
        const key = JSON.stringify([aspect, sourceKey, trace.unit, period]);
        if (entries.has(key)) {
          duplicates.add(key);
          continue;
        }
        entries.set(key, { aspect, sourceKey, unit: trace.unit, period, trace });
        order.push(key);
      }
    }
  }
  for (const key of duplicates) entries.delete(key);
  return {
    entries,
    order: order.filter((key) => entries.has(key)),
    ambiguous: duplicates,
    duplicate: duplicates.size > 0,
  };
}

interface TargetIndex {
  entries: Map<TargetScenario, RuntimeTrace | null>;
  order: TargetScenario[];
  ambiguous: Set<TargetScenario>;
  duplicate: boolean;
}

function indexTargets(report: Report): TargetIndex {
  const entries = new Map<TargetScenario, RuntimeTrace | null>();
  const order: TargetScenario[] = [];
  const duplicates = new Set<TargetScenario>();
  for (const scenario of report.valuation.scenarios) {
    const key = scenario.name;
    if (entries.has(key)) {
      duplicates.add(key);
      continue;
    }
    entries.set(key, scenario.priceTarget as RuntimeTrace | null);
    order.push(key);
  }
  for (const key of duplicates) entries.delete(key);
  return {
    entries,
    order: order.filter((key) => entries.has(key)),
    ambiguous: duplicates,
    duplicate: duplicates.size > 0,
  };
}

interface IndexedProjection {
  path: ProjectionPath;
  metric: ProjectionMetric;
  period: string;
  seriesUnit: string;
  point: RuntimeProjectionPoint;
  periodConflict: boolean;
  unitConflict: boolean;
}

interface ProjectionIndex {
  entries: Map<string, IndexedProjection>;
  order: string[];
  ambiguousKeys: Set<string>;
  duplicateMetrics: Set<ProjectionMetric>;
  duplicatePaths: Set<ProjectionPath>;
  periodConflictPaths: Set<ProjectionPath>;
  unitConflictPaths: Set<ProjectionPath>;
}

function indexProjections(report: Report): ProjectionIndex {
  const entries = new Map<string, IndexedProjection>();
  const order: string[] = [];
  const duplicateKeys = new Set<string>();
  const duplicatePaths = new Set<ProjectionPath>();
  const duplicateMetrics = new Set<ProjectionMetric>();
  const periodConflictPaths = new Set<ProjectionPath>();
  const unitConflictPaths = new Set<ProjectionPath>();
  const seriesSeen = new Map<ProjectionMetric, number>();
  const projections = report.projections as
    | { series: RuntimeProjectionSeries[] }
    | undefined;

  for (const series of projections?.series ?? []) {
    seriesSeen.set(series.metric, (seriesSeen.get(series.metric) ?? 0) + 1);
  }
  for (const [metric, count] of seriesSeen) {
    if (count > 1) duplicateMetrics.add(metric);
  }
  for (const series of projections?.series ?? []) {
    const duplicateSeries = (seriesSeen.get(series.metric) ?? 0) > 1;
    for (const path of PROJECTION_PATHS) {
      if (duplicateSeries) duplicatePaths.add(path);
      for (const point of series[path] ?? []) {
        const key = JSON.stringify([path, series.metric, point.period]);
        const periodConflict =
          point.value.period !== null &&
          point.value.period !== undefined &&
          point.value.period !== point.period;
        const unitConflict = point.value.unit !== series.unit;
        if (periodConflict) periodConflictPaths.add(path);
        if (unitConflict) unitConflictPaths.add(path);
        if (entries.has(key) || duplicateSeries) {
          duplicateKeys.add(key);
          duplicatePaths.add(path);
          continue;
        }
        entries.set(key, {
          path,
          metric: series.metric,
          period: point.period,
          seriesUnit: series.unit,
          point,
          periodConflict,
          unitConflict,
        });
        order.push(key);
      }
    }
  }
  for (const key of duplicateKeys) entries.delete(key);
  return {
    entries,
    order: order.filter((key) => entries.has(key)),
    ambiguousKeys: duplicateKeys,
    duplicateMetrics,
    duplicatePaths,
    periodConflictPaths,
    unitConflictPaths,
  };
}

/* ------------------------------------------------------------------------ *
 * Main comparison
 * ------------------------------------------------------------------------ */

export function diffReports(
  fromReport: Report,
  toReport: Report,
  context: VersionedDiffContext,
): ReportDiff {
  const fromEntity = normalizeSymbol(fromReport.meta.symbol);
  const toEntity = normalizeSymbol(toReport.meta.symbol);
  const entityReasons: DiffReasonCode[] = [];
  if (fromEntity === null || toEntity === null) {
    entityReasons.push("invalid-entity");
  } else if (!sameEntitySymbol(fromEntity, toEntity)) {
    entityReasons.push("entity-mismatch");
  }
  const globalReasons = uniqueReasons([
    ...entityReasons,
    ...versionReasons(fromReport, toReport, context),
  ]);
  if (entityReasons.length > 0) {
    return emptyReportDiff(context, globalReasons, fromReport, toReport);
  }

  const gradeChanges: GradeChange[] = [];
  for (const section of GRADE_SECTIONS) {
    const from = section.get(fromReport);
    const to = section.get(toReport);
    if (from === to) continue;
    const transition =
      from === null ? "added" : to === null ? "removed" : "changed";
    gradeChanges.push({
      section: section.section,
      from,
      to,
      ...transitionComparison(transition, globalReasons),
    });
  }

  const fromScoring = fromReport.scores as RuntimeScoring | undefined;
  const toScoring = toReport.scores as RuntimeScoring | undefined;
  const scoreChanges: ScoreChange[] = [];
  for (const aspect of SCORE_KEYS) {
    const fromScore =
      aspect === "composite"
        ? fromScoring?.composite
        : fromScoring?.aspects[aspect];
    const toScore =
      aspect === "composite" ? toScoring?.composite : toScoring?.aspects[aspect];
    if (!fromScore && !toScore) continue;
    const fromEndpoint = fromScore
      ? { value: fromScore.score, band: fromScore.band }
      : null;
    const toEndpoint = toScore ? { value: toScore.score, band: toScore.band } : null;
    if (
      fromEndpoint &&
      toEndpoint &&
      fromEndpoint.value === toEndpoint.value &&
      fromEndpoint.band === toEndpoint.band
    ) {
      continue;
    }
    const transition = transitionFor(
      fromEndpoint !== null,
      toEndpoint !== null,
      fromEndpoint?.value ?? null,
      toEndpoint?.value ?? null,
    );
    scoreChanges.push({
      aspect,
      from: fromEndpoint,
      to: toEndpoint,
      fromValue: fromEndpoint?.value ?? null,
      toValue: toEndpoint?.value ?? null,
      fromBand: fromEndpoint?.band ?? null,
      toBand: toEndpoint?.band ?? null,
      ...transitionComparison(transition, globalReasons),
    });
  }

  const fromWeights = fromScoring?.composite.weights;
  const toWeights = toScoring?.composite.weights;
  const weightKeys = orderedUnion(
    fromWeights ? (Object.keys(fromWeights) as ScoreAspect[]) : [],
    toWeights ? (Object.keys(toWeights) as ScoreAspect[]) : [],
  );
  const weightChanges: CompositeWeightChange[] = [];
  for (const aspect of weightKeys) {
    const fromPresent = fromWeights !== undefined && hasOwn(fromWeights, aspect);
    const toPresent = toWeights !== undefined && hasOwn(toWeights, aspect);
    const fromValue = fromPresent ? fromWeights![aspect] ?? null : null;
    const toValue = toPresent ? toWeights![aspect] ?? null : null;
    if (fromPresent && toPresent && fromValue === toValue) continue;
    const transition = transitionFor(fromPresent, toPresent, fromValue, toValue);
    weightChanges.push({
      aspect,
      fromValue,
      toValue,
      ...transitionComparison(transition, globalReasons),
    });
  }

  const fromDrivers = indexDrivers(fromScoring);
  const toDrivers = indexDrivers(toScoring);
  const driverFamilyReasons: DiffReasonCode[] = [
    ...(fromDrivers.duplicate || toDrivers.duplicate
      ? (["duplicate-driver-identity"] as DiffReasonCode[])
      : []),
  ];
  const driverChanges: DriverChange[] = [];
  for (const key of orderedUnion(fromDrivers.order, toDrivers.order)) {
    if (fromDrivers.ambiguous.has(key) || toDrivers.ambiguous.has(key)) continue;
    const fromEntry = fromDrivers.entries.get(key);
    const toEntry = toDrivers.entries.get(key);
    if (!fromEntry && !toEntry) continue;
    const from = fromEntry ? snapshot(fromEntry.trace) : null;
    const to = toEntry ? snapshot(toEntry.trace) : null;
    if (from && to && sameSnapshot(from, to)) continue;
    const transition = transitionFor(
      from !== null,
      to !== null,
      from?.value ?? null,
      to?.value ?? null,
    );
    const localReasons = from && to
      ? dimensionReasons(from, to, false).filter(
          (reason) => reason === "currency-mismatch",
        )
      : [];
    const recordReasons = uniqueReasons([...globalReasons, ...localReasons]);
    const comparison = comparisonFor(recordReasons);
    const identity = fromEntry ?? toEntry!;
    driverChanges.push({
      aspect: identity.aspect,
      sourceKey: identity.sourceKey,
      unit: identity.unit,
      period: identity.period,
      from,
      to,
      fromValue: from?.value ?? null,
      toValue: to?.value ?? null,
      pctChange: percentageChange(from, to, transition, comparison.comparison),
      transition,
      ...comparison,
    });
  }

  const fromTargets = indexTargets(fromReport);
  const toTargets = indexTargets(toReport);
  const targetFamilyReasons: DiffReasonCode[] = [
    ...(fromTargets.duplicate || toTargets.duplicate
      ? (["duplicate-target-identity"] as DiffReasonCode[])
      : []),
  ];
  const targetOrder = orderedUnion<TargetScenario>(
    ["bull", "base", "bear"],
    orderedUnion(fromTargets.order, toTargets.order),
  ).filter(
    (scenario) =>
      fromTargets.entries.has(scenario) || toTargets.entries.has(scenario),
  );
  const targetChanges: TargetChange[] = [];
  for (const scenario of targetOrder) {
    if (
      fromTargets.ambiguous.has(scenario) ||
      toTargets.ambiguous.has(scenario)
    ) {
      continue;
    }
    const fromScenarioPresent = fromTargets.entries.has(scenario);
    const toScenarioPresent = toTargets.entries.has(scenario);
    const fromTrace = fromTargets.entries.get(scenario);
    const toTrace = toTargets.entries.get(scenario);
    const from = fromTrace ? snapshot(fromTrace) : null;
    const to = toTrace ? snapshot(toTrace) : null;
    if (
      fromScenarioPresent &&
      toScenarioPresent &&
      ((from === null && to === null) ||
        (from !== null && to !== null && sameSnapshot(from, to)))
    ) {
      continue;
    }
    const transition = transitionFor(
      fromScenarioPresent,
      toScenarioPresent,
      from?.value ?? null,
      to?.value ?? null,
    );
    const recordReasons = uniqueReasons([
      ...globalReasons,
      ...(from && to ? dimensionReasons(from, to) : []),
    ]);
    const comparison = comparisonFor(recordReasons);
    targetChanges.push({
      scenario,
      from,
      to,
      fromValue: from?.value ?? null,
      toValue: to?.value ?? null,
      pctChange: percentageChange(from, to, transition, comparison.comparison),
      transition,
      ...comparison,
    });
  }

  const fromProjections = indexProjections(fromReport);
  const toProjections = indexProjections(toReport);
  const projectionFamilyReasons: Record<ProjectionPath, DiffReasonCode[]> = {
    historical: [],
    bull: [],
    base: [],
    bear: [],
    weighted: [],
  };
  for (const path of PROJECTION_PATHS) {
    if (
      fromProjections.duplicatePaths.has(path) ||
      toProjections.duplicatePaths.has(path)
    ) {
      projectionFamilyReasons[path].push("duplicate-projection-identity");
    }
    if (
      fromProjections.periodConflictPaths.has(path) ||
      toProjections.periodConflictPaths.has(path)
    ) {
      projectionFamilyReasons[path].push("projection-period-conflict");
    }
    if (
      fromProjections.unitConflictPaths.has(path) ||
      toProjections.unitConflictPaths.has(path)
    ) {
      projectionFamilyReasons[path].push("unit-mismatch");
    }
  }
  const projectionChanges: ProjectionChange[] = [];
  for (const key of orderedUnion(fromProjections.order, toProjections.order)) {
    const fromEntry = fromProjections.entries.get(key);
    const toEntry = toProjections.entries.get(key);
    if (!fromEntry && !toEntry) continue;
    const identity = fromEntry ?? toEntry!;
    if (
      fromProjections.ambiguousKeys.has(key) ||
      toProjections.ambiguousKeys.has(key) ||
      fromProjections.duplicateMetrics.has(identity.metric) ||
      toProjections.duplicateMetrics.has(identity.metric)
    ) {
      continue;
    }
    const from = fromEntry
      ? snapshot(fromEntry.point.value, fromEntry.seriesUnit)
      : null;
    const to = toEntry ? snapshot(toEntry.point.value, toEntry.seriesUnit) : null;
    if (from && to && sameSnapshot(from, to)) {
      continue;
    }
    const transition = transitionFor(
      from !== null,
      to !== null,
      from?.value ?? null,
      to?.value ?? null,
    );
    const localReasons: DiffReasonCode[] = [
      ...(from && to ? dimensionReasons(from, to, false) : []),
      ...(fromEntry?.periodConflict || toEntry?.periodConflict
        ? (["projection-period-conflict"] as DiffReasonCode[])
        : []),
    ];
    if (
      (from && from.seriesUnit !== null && from.unit !== from.seriesUnit) ||
      (to && to.seriesUnit !== null && to.unit !== to.seriesUnit)
    ) {
      localReasons.push("unit-mismatch");
    }
    const recordReasons = uniqueReasons([...globalReasons, ...localReasons]);
    const comparison = comparisonFor(recordReasons);
    projectionChanges.push({
      path: identity.path,
      metric: identity.metric,
      period: identity.period,
      from,
      to,
      fromValue: from?.value ?? null,
      toValue: to?.value ?? null,
      pctChange: percentageChange(from, to, transition, comparison.comparison),
      transition,
      ...comparison,
    });
  }

  const catalystMatch = matchByTitle(
    fromReport.catalystsRisks.catalysts,
    toReport.catalystsRisks.catalysts,
  );
  const newCatalysts = toReport.catalystsRisks.catalysts
    .filter((_, index) => catalystMatch.matchForTo[index] === -1)
    .map((item) => item.title);
  const removedCatalysts = fromReport.catalystsRisks.catalysts
    .filter((_, index) => !catalystMatch.matchedFrom.has(index))
    .map((item) => item.title);
  const catalystChanges: TextTransition[] = [
    ...removedCatalysts.map((title) => ({
      title,
      from: title,
      to: null,
      ...transitionComparison("removed", globalReasons),
    })),
    ...newCatalysts.map((title) => ({
      title,
      from: null,
      to: title,
      ...transitionComparison("added", globalReasons),
    })),
  ];

  const riskMatch = matchByTitle(
    fromReport.catalystsRisks.risks,
    toReport.catalystsRisks.risks,
  );
  const newRisks = toReport.catalystsRisks.risks
    .filter((_, index) => riskMatch.matchForTo[index] === -1)
    .map((item) => item.title);
  const removedRisks = fromReport.catalystsRisks.risks
    .filter((_, index) => !riskMatch.matchedFrom.has(index))
    .map((item) => item.title);
  const riskChanges: TextTransition[] = [
    ...removedRisks.map((title) => ({
      title,
      from: title,
      to: null,
      ...transitionComparison("removed", globalReasons),
    })),
    ...newRisks.map((title) => ({
      title,
      from: null,
      to: title,
      ...transitionComparison("added", globalReasons),
    })),
  ];

  const verdictChanged =
    normalizeTitle(fromReport.verdict.synthesis) !==
    normalizeTitle(toReport.verdict.synthesis);
  const verdictChange: VerdictChange | null = verdictChanged
    ? {
        from: fromReport.verdict.synthesis,
        to: toReport.verdict.synthesis,
        ...transitionComparison("changed", globalReasons),
      }
    : null;
  const costDelta = toReport.meta.costUsd - fromReport.meta.costUsd;
  const costChange: CostChange | null =
    costDelta === 0
      ? null
      : {
          fromValue: fromReport.meta.costUsd,
          toValue: toReport.meta.costUsd,
          delta: costDelta,
          ...transitionComparison("changed", globalReasons),
        };

  const familyComparisons: FamilyComparisons = {
    grades: comparisonFor(globalReasons),
    scores: comparisonFor(globalReasons),
    weights: comparisonFor(globalReasons),
    drivers: comparisonFor([
      ...globalReasons,
      ...driverFamilyReasons,
      ...driverChanges.flatMap((change) => change.reasons),
    ]),
    targets: comparisonFor([
      ...globalReasons,
      ...targetFamilyReasons,
      ...targetChanges.flatMap((change) => change.reasons),
    ]),
    projections: {
      historical: comparisonFor([
        ...globalReasons,
        ...projectionFamilyReasons.historical,
        ...projectionChanges
          .filter((change) => change.path === "historical")
          .flatMap((change) => change.reasons),
      ]),
      bull: comparisonFor([
        ...globalReasons,
        ...projectionFamilyReasons.bull,
        ...projectionChanges
          .filter((change) => change.path === "bull")
          .flatMap((change) => change.reasons),
      ]),
      base: comparisonFor([
        ...globalReasons,
        ...projectionFamilyReasons.base,
        ...projectionChanges
          .filter((change) => change.path === "base")
          .flatMap((change) => change.reasons),
      ]),
      bear: comparisonFor([
        ...globalReasons,
        ...projectionFamilyReasons.bear,
        ...projectionChanges
          .filter((change) => change.path === "bear")
          .flatMap((change) => change.reasons),
      ]),
      weighted: comparisonFor([
        ...globalReasons,
        ...projectionFamilyReasons.weighted,
        ...projectionChanges
          .filter((change) => change.path === "weighted")
          .flatMap((change) => change.reasons),
      ]),
    },
    catalysts: comparisonFor(globalReasons),
    risks: comparisonFor(globalReasons),
    verdict: comparisonFor(globalReasons),
    cost: comparisonFor(globalReasons),
  };

  const notComparableReasons = uniqueReasons([
    ...globalReasons,
    ...driverFamilyReasons,
    ...targetFamilyReasons,
    ...PROJECTION_PATHS.flatMap((path) => projectionFamilyReasons[path]),
    ...driverChanges.flatMap((change) => change.reasons),
    ...targetChanges.flatMap((change) => change.reasons),
    ...projectionChanges.flatMap((change) => change.reasons),
  ]);
  const hasChanges =
    gradeChanges.length > 0 ||
    scoreChanges.length > 0 ||
    weightChanges.length > 0 ||
    driverChanges.length > 0 ||
    targetChanges.length > 0 ||
    projectionChanges.length > 0 ||
    catalystChanges.length > 0 ||
    riskChanges.length > 0 ||
    verdictChanged ||
    costDelta !== 0;

  return {
    context: normalizedContext(context),
    comparisonStatus:
      notComparableReasons.length > 0
        ? "not-comparable"
        : hasChanges
          ? "changed"
          : "unchanged",
    notComparableReasons,
    familyComparisons,
    sourceFreshness: {
      from: sourceFreshness(fromReport),
      to: sourceFreshness(toReport),
    },
    gradeChanges,
    scoreChanges,
    weightChanges,
    driverChanges,
    targetChanges,
    projectionChanges,
    catalystChanges,
    riskChanges,
    verdictChange,
    costChange,
    newCatalysts,
    removedCatalysts,
    newRisks,
    removedRisks,
    verdictChanged,
    costDelta,
  };
}
