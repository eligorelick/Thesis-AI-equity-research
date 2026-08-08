import type {
  AspectScore,
  CompositeScore,
  ExecutiveEvidence,
  GradeStrip,
  ProjectionMetric,
  ProjectionPoint,
  ProjectionSeries,
  Projections,
  ScoreAspect,
  Scoring,
  TracedNumber,
} from "@/report/schema";
import type { ManifestEntry } from "@/types/core";

export type GradeSurfaceKey = keyof GradeStrip;
export type ScoreSurfaceKey = "composite" | ScoreAspect;
export type ProjectionPath = "historical" | "bull" | "base" | "bear" | "weighted";
export type ExecutiveEvidenceKey = keyof ExecutiveEvidence;
export type TracedNumberFieldKey = keyof TracedNumber;

type ReportSectionKey =
  | "verdict"
  | "fundamentals"
  | "valuation"
  | "technicals"
  | "balanceSheet"
  | "quality"
  | "leadership"
  | "competitive";

export interface GradeSurfaceDescriptor {
  readonly id: `grade:${GradeSurfaceKey}`;
  readonly key: GradeSurfaceKey;
  readonly label: string;
  readonly shortLabel: string;
  readonly sectionKey: ReportSectionKey;
  readonly optional: boolean;
}

export interface ScoreSurfaceDescriptor {
  readonly id: `score:${ScoreSurfaceKey}`;
  readonly key: ScoreSurfaceKey;
  readonly kind: "composite" | "aspect";
  readonly label: string;
  readonly sectionKey: ReportSectionKey;
}

export interface ScoreWeightDescriptor {
  readonly id: `score-weight:${ScoreAspect}`;
  readonly aspect: ScoreAspect;
  readonly label: string;
  readonly sectionKey: ReportSectionKey;
}

export interface ProjectionMetricDescriptor {
  readonly id: `projection-metric:${ProjectionMetric}`;
  readonly key: ProjectionMetric;
  readonly label: string;
}

export interface ProjectionPathDescriptor {
  readonly id: `projection-path:${ProjectionPath}`;
  readonly key: ProjectionPath;
  readonly label: string;
  readonly kind: "historical" | "scenario" | "weighted";
}

export interface ExecutiveEvidenceDescriptor {
  readonly id: `executive-evidence:${ExecutiveEvidenceKey}`;
  readonly key: ExecutiveEvidenceKey;
  readonly label: string;
}

export interface FieldDescriptor<K extends string> {
  readonly id: string;
  readonly key: K;
  readonly label: string;
  readonly optional: boolean;
}

export const GRADE_SURFACE_ORDER = [
  "fundamentals",
  "valuation",
  "technicals",
  "balanceSheet",
  "quality",
  "leadership",
  "moat",
] as const satisfies readonly GradeSurfaceKey[];

export const GRADE_SURFACES = [
  { id: "grade:fundamentals", key: "fundamentals", label: "Fundamentals", shortLabel: "F", sectionKey: "fundamentals", optional: false },
  { id: "grade:valuation", key: "valuation", label: "Valuation", shortLabel: "V", sectionKey: "valuation", optional: false },
  { id: "grade:technicals", key: "technicals", label: "Technicals", shortLabel: "T", sectionKey: "technicals", optional: false },
  { id: "grade:balanceSheet", key: "balanceSheet", label: "Balance Sheet", shortLabel: "BS", sectionKey: "balanceSheet", optional: true },
  { id: "grade:quality", key: "quality", label: "Quality / Red-Flags", shortLabel: "Q", sectionKey: "quality", optional: false },
  { id: "grade:leadership", key: "leadership", label: "Leadership", shortLabel: "L", sectionKey: "leadership", optional: false },
  { id: "grade:moat", key: "moat", label: "Moat", shortLabel: "M", sectionKey: "competitive", optional: false },
] as const satisfies readonly GradeSurfaceDescriptor[];

export const GRADE_SURFACE_BY_KEY = {
  fundamentals: GRADE_SURFACES[0],
  valuation: GRADE_SURFACES[1],
  technicals: GRADE_SURFACES[2],
  balanceSheet: GRADE_SURFACES[3],
  quality: GRADE_SURFACES[4],
  leadership: GRADE_SURFACES[5],
  moat: GRADE_SURFACES[6],
} as const satisfies Record<GradeSurfaceKey, GradeSurfaceDescriptor>;

export const SCORE_SURFACE_ORDER = [
  "composite",
  "fundamentals",
  "valuation",
  "quality",
  "balanceSheet",
  "moat",
  "leadership",
  "technicals",
] as const satisfies readonly ScoreSurfaceKey[];

export const SCORE_ASPECT_ORDER = [
  "fundamentals",
  "valuation",
  "quality",
  "balanceSheet",
  "moat",
  "leadership",
  "technicals",
] as const satisfies readonly ScoreAspect[];

export const SCORE_SURFACES = [
  { id: "score:composite", key: "composite", kind: "composite", label: "Composite", sectionKey: "verdict" },
  { id: "score:fundamentals", key: "fundamentals", kind: "aspect", label: "Fundamentals", sectionKey: "fundamentals" },
  { id: "score:valuation", key: "valuation", kind: "aspect", label: "Valuation", sectionKey: "valuation" },
  { id: "score:quality", key: "quality", kind: "aspect", label: "Quality", sectionKey: "quality" },
  { id: "score:balanceSheet", key: "balanceSheet", kind: "aspect", label: "Balance Sheet", sectionKey: "balanceSheet" },
  { id: "score:moat", key: "moat", kind: "aspect", label: "Moat", sectionKey: "competitive" },
  { id: "score:leadership", key: "leadership", kind: "aspect", label: "Leadership", sectionKey: "leadership" },
  { id: "score:technicals", key: "technicals", kind: "aspect", label: "Technicals", sectionKey: "technicals" },
] as const satisfies readonly ScoreSurfaceDescriptor[];

export const SCORE_SURFACE_BY_KEY = {
  composite: SCORE_SURFACES[0],
  fundamentals: SCORE_SURFACES[1],
  valuation: SCORE_SURFACES[2],
  quality: SCORE_SURFACES[3],
  balanceSheet: SCORE_SURFACES[4],
  moat: SCORE_SURFACES[5],
  leadership: SCORE_SURFACES[6],
  technicals: SCORE_SURFACES[7],
} as const satisfies Record<ScoreSurfaceKey, ScoreSurfaceDescriptor>;

export const SCORE_WEIGHTS = [
  { id: "score-weight:fundamentals", aspect: "fundamentals", label: "Fundamentals", sectionKey: "fundamentals" },
  { id: "score-weight:valuation", aspect: "valuation", label: "Valuation", sectionKey: "valuation" },
  { id: "score-weight:quality", aspect: "quality", label: "Quality", sectionKey: "quality" },
  { id: "score-weight:balanceSheet", aspect: "balanceSheet", label: "Balance Sheet", sectionKey: "balanceSheet" },
  { id: "score-weight:moat", aspect: "moat", label: "Moat", sectionKey: "competitive" },
  { id: "score-weight:leadership", aspect: "leadership", label: "Leadership", sectionKey: "leadership" },
  { id: "score-weight:technicals", aspect: "technicals", label: "Technicals", sectionKey: "technicals" },
] as const satisfies readonly ScoreWeightDescriptor[];

export const SCORE_WEIGHT_BY_ASPECT = {
  fundamentals: SCORE_WEIGHTS[0],
  valuation: SCORE_WEIGHTS[1],
  quality: SCORE_WEIGHTS[2],
  balanceSheet: SCORE_WEIGHTS[3],
  moat: SCORE_WEIGHTS[4],
  leadership: SCORE_WEIGHTS[5],
  technicals: SCORE_WEIGHTS[6],
} as const satisfies Record<ScoreAspect, ScoreWeightDescriptor>;

export const PROJECTION_METRIC_ORDER = [
  "revenue",
  "operatingMargin",
  "fcf",
  "epsDiluted",
] as const satisfies readonly ProjectionMetric[];

export const PROJECTION_METRICS = [
  { id: "projection-metric:revenue", key: "revenue", label: "Revenue" },
  { id: "projection-metric:operatingMargin", key: "operatingMargin", label: "Operating margin" },
  { id: "projection-metric:fcf", key: "fcf", label: "Free cash flow (FCFF)" },
  { id: "projection-metric:epsDiluted", key: "epsDiluted", label: "Diluted EPS" },
] as const satisfies readonly ProjectionMetricDescriptor[];

export const PROJECTION_METRIC_BY_KEY = {
  revenue: PROJECTION_METRICS[0],
  operatingMargin: PROJECTION_METRICS[1],
  fcf: PROJECTION_METRICS[2],
  epsDiluted: PROJECTION_METRICS[3],
} as const satisfies Record<ProjectionMetric, ProjectionMetricDescriptor>;

export const PROJECTION_PATH_ORDER = [
  "historical",
  "bull",
  "base",
  "bear",
  "weighted",
] as const satisfies readonly ProjectionPath[];

export const PROJECTION_PATHS = [
  { id: "projection-path:historical", key: "historical", label: "Historical", kind: "historical" },
  { id: "projection-path:bull", key: "bull", label: "Bull", kind: "scenario" },
  { id: "projection-path:base", key: "base", label: "Base", kind: "scenario" },
  { id: "projection-path:bear", key: "bear", label: "Bear", kind: "scenario" },
  { id: "projection-path:weighted", key: "weighted", label: "Weighted", kind: "weighted" },
] as const satisfies readonly ProjectionPathDescriptor[];

export const PROJECTION_PATH_BY_KEY = {
  historical: PROJECTION_PATHS[0],
  bull: PROJECTION_PATHS[1],
  base: PROJECTION_PATHS[2],
  bear: PROJECTION_PATHS[3],
  weighted: PROJECTION_PATHS[4],
} as const satisfies Record<ProjectionPath, ProjectionPathDescriptor>;

export const EXECUTIVE_EVIDENCE_ORDER = [
  "guidanceVsActuals",
  "capitalAllocation",
  "insiderActivity",
  "compensation",
] as const satisfies readonly ExecutiveEvidenceKey[];

export const EXECUTIVE_EVIDENCE_GROUPS = [
  { id: "executive-evidence:guidanceVsActuals", key: "guidanceVsActuals", label: "Guidance vs actuals" },
  { id: "executive-evidence:capitalAllocation", key: "capitalAllocation", label: "Capital allocation" },
  { id: "executive-evidence:insiderActivity", key: "insiderActivity", label: "Insider activity" },
  { id: "executive-evidence:compensation", key: "compensation", label: "Compensation" },
] as const satisfies readonly ExecutiveEvidenceDescriptor[];

export const EXECUTIVE_EVIDENCE_BY_KEY = {
  guidanceVsActuals: EXECUTIVE_EVIDENCE_GROUPS[0],
  capitalAllocation: EXECUTIVE_EVIDENCE_GROUPS[1],
  insiderActivity: EXECUTIVE_EVIDENCE_GROUPS[2],
  compensation: EXECUTIVE_EVIDENCE_GROUPS[3],
} as const satisfies Record<ExecutiveEvidenceKey, ExecutiveEvidenceDescriptor>;

export const TRACED_NUMBER_FIELD_ORDER = [
  "value",
  "unit",
  "currency",
  "period",
  "sourceId",
  "source",
  "asOf",
  "verified",
  "verificationNote",
] as const satisfies readonly TracedNumberFieldKey[];

export const TRACED_NUMBER_FIELDS = [
  { id: "traced-number-field:value", key: "value", label: "Value", optional: false },
  { id: "traced-number-field:unit", key: "unit", label: "Unit", optional: false },
  { id: "traced-number-field:currency", key: "currency", label: "Currency", optional: true },
  { id: "traced-number-field:period", key: "period", label: "Period", optional: true },
  { id: "traced-number-field:sourceId", key: "sourceId", label: "Source ID", optional: true },
  { id: "traced-number-field:source", key: "source", label: "Source", optional: false },
  { id: "traced-number-field:asOf", key: "asOf", label: "As of", optional: false },
  { id: "traced-number-field:verified", key: "verified", label: "Citation traced", optional: false },
  { id: "traced-number-field:verificationNote", key: "verificationNote", label: "Citation note", optional: true },
] as const satisfies readonly FieldDescriptor<TracedNumberFieldKey>[];

export const TRACED_NUMBER_FIELD_BY_KEY = {
  value: TRACED_NUMBER_FIELDS[0],
  unit: TRACED_NUMBER_FIELDS[1],
  currency: TRACED_NUMBER_FIELDS[2],
  period: TRACED_NUMBER_FIELDS[3],
  sourceId: TRACED_NUMBER_FIELDS[4],
  source: TRACED_NUMBER_FIELDS[5],
  asOf: TRACED_NUMBER_FIELDS[6],
  verified: TRACED_NUMBER_FIELDS[7],
  verificationNote: TRACED_NUMBER_FIELDS[8],
} as const satisfies Record<TracedNumberFieldKey, FieldDescriptor<TracedNumberFieldKey>>;

export type ScoringFieldKey = keyof Scoring;
export const SCORING_FIELD_ORDER = [
  "aspects",
  "composite",
  "bandsVersion",
] as const satisfies readonly ScoringFieldKey[];
export const SCORING_FIELDS = [
  { id: "scoring-field:aspects", key: "aspects", label: "Aspect scores", optional: false },
  { id: "scoring-field:composite", key: "composite", label: "Composite score", optional: false },
  { id: "scoring-field:bandsVersion", key: "bandsVersion", label: "Score bands version", optional: false },
] as const satisfies readonly FieldDescriptor<ScoringFieldKey>[];
export const SCORING_FIELD_BY_KEY = {
  aspects: SCORING_FIELDS[0],
  composite: SCORING_FIELDS[1],
  bandsVersion: SCORING_FIELDS[2],
} as const satisfies Record<ScoringFieldKey, FieldDescriptor<ScoringFieldKey>>;

export type AspectScoreFieldKey = keyof AspectScore;
export const ASPECT_SCORE_FIELD_ORDER = [
  "score",
  "band",
  "weightPct",
  "dataCompleteness",
  "drivers",
  "notApplicableReason",
  "note",
] as const satisfies readonly AspectScoreFieldKey[];
export const ASPECT_SCORE_FIELDS = [
  { id: "aspect-score-field:score", key: "score", label: "Score", optional: false },
  { id: "aspect-score-field:band", key: "band", label: "Band", optional: false },
  { id: "aspect-score-field:weightPct", key: "weightPct", label: "Weight", optional: false },
  { id: "aspect-score-field:dataCompleteness", key: "dataCompleteness", label: "Data completeness", optional: false },
  { id: "aspect-score-field:drivers", key: "drivers", label: "Drivers", optional: false },
  { id: "aspect-score-field:notApplicableReason", key: "notApplicableReason", label: "Not applicable reason", optional: false },
  { id: "aspect-score-field:note", key: "note", label: "Method note", optional: false },
] as const satisfies readonly FieldDescriptor<AspectScoreFieldKey>[];
export const ASPECT_SCORE_FIELD_BY_KEY = {
  score: ASPECT_SCORE_FIELDS[0],
  band: ASPECT_SCORE_FIELDS[1],
  weightPct: ASPECT_SCORE_FIELDS[2],
  dataCompleteness: ASPECT_SCORE_FIELDS[3],
  drivers: ASPECT_SCORE_FIELDS[4],
  notApplicableReason: ASPECT_SCORE_FIELDS[5],
  note: ASPECT_SCORE_FIELDS[6],
} as const satisfies Record<AspectScoreFieldKey, FieldDescriptor<AspectScoreFieldKey>>;

export type CompositeScoreFieldKey = keyof CompositeScore;
export const COMPOSITE_SCORE_FIELD_ORDER = [
  "score",
  "band",
  "weights",
  "methodology",
] as const satisfies readonly CompositeScoreFieldKey[];
export const COMPOSITE_SCORE_FIELDS = [
  { id: "composite-score-field:score", key: "score", label: "Score", optional: false },
  { id: "composite-score-field:band", key: "band", label: "Band", optional: false },
  { id: "composite-score-field:weights", key: "weights", label: "Weights", optional: false },
  { id: "composite-score-field:methodology", key: "methodology", label: "Methodology", optional: false },
] as const satisfies readonly FieldDescriptor<CompositeScoreFieldKey>[];
export const COMPOSITE_SCORE_FIELD_BY_KEY = {
  score: COMPOSITE_SCORE_FIELDS[0],
  band: COMPOSITE_SCORE_FIELDS[1],
  weights: COMPOSITE_SCORE_FIELDS[2],
  methodology: COMPOSITE_SCORE_FIELDS[3],
} as const satisfies Record<CompositeScoreFieldKey, FieldDescriptor<CompositeScoreFieldKey>>;

export type ProjectionRootFieldKey = keyof Projections;
export const PROJECTION_ROOT_FIELD_ORDER = [
  "horizonYears",
  "scenarioWeights",
  "weightsVersion",
  "series",
  "notApplicableReason",
] as const satisfies readonly ProjectionRootFieldKey[];
export const PROJECTION_ROOT_FIELDS = [
  { id: "projection-root-field:horizonYears", key: "horizonYears", label: "Horizon years", optional: false },
  { id: "projection-root-field:scenarioWeights", key: "scenarioWeights", label: "Scenario weights", optional: false },
  { id: "projection-root-field:weightsVersion", key: "weightsVersion", label: "Weights version", optional: false },
  { id: "projection-root-field:series", key: "series", label: "Series", optional: false },
  { id: "projection-root-field:notApplicableReason", key: "notApplicableReason", label: "Not applicable reason", optional: false },
] as const satisfies readonly FieldDescriptor<ProjectionRootFieldKey>[];
export const PROJECTION_ROOT_FIELD_BY_KEY = {
  horizonYears: PROJECTION_ROOT_FIELDS[0],
  scenarioWeights: PROJECTION_ROOT_FIELDS[1],
  weightsVersion: PROJECTION_ROOT_FIELDS[2],
  series: PROJECTION_ROOT_FIELDS[3],
  notApplicableReason: PROJECTION_ROOT_FIELDS[4],
} as const satisfies Record<ProjectionRootFieldKey, FieldDescriptor<ProjectionRootFieldKey>>;

export type ProjectionScenarioWeightKey = keyof Projections["scenarioWeights"];
export const PROJECTION_SCENARIO_WEIGHT_ORDER = [
  "bull",
  "base",
  "bear",
] as const satisfies readonly ProjectionScenarioWeightKey[];
export const PROJECTION_SCENARIO_WEIGHTS = [
  { id: "projection-scenario-weight:bull", key: "bull", label: "Bull", optional: false },
  { id: "projection-scenario-weight:base", key: "base", label: "Base", optional: false },
  { id: "projection-scenario-weight:bear", key: "bear", label: "Bear", optional: false },
] as const satisfies readonly FieldDescriptor<ProjectionScenarioWeightKey>[];
export const PROJECTION_SCENARIO_WEIGHT_BY_KEY = {
  bull: PROJECTION_SCENARIO_WEIGHTS[0],
  base: PROJECTION_SCENARIO_WEIGHTS[1],
  bear: PROJECTION_SCENARIO_WEIGHTS[2],
} as const satisfies Record<ProjectionScenarioWeightKey, FieldDescriptor<ProjectionScenarioWeightKey>>;

export type ProjectionSeriesFieldKey = keyof ProjectionSeries;
export const PROJECTION_SERIES_FIELD_ORDER = [
  "metric",
  "unit",
  "historical",
  "bull",
  "base",
  "bear",
  "weighted",
  "assumptions",
  "disclosures",
] as const satisfies readonly ProjectionSeriesFieldKey[];
export const PROJECTION_SERIES_FIELDS = [
  { id: "projection-series-field:metric", key: "metric", label: "Metric", optional: false },
  { id: "projection-series-field:unit", key: "unit", label: "Unit", optional: false },
  { id: "projection-series-field:historical", key: "historical", label: "Historical", optional: false },
  { id: "projection-series-field:bull", key: "bull", label: "Bull", optional: false },
  { id: "projection-series-field:base", key: "base", label: "Base", optional: false },
  { id: "projection-series-field:bear", key: "bear", label: "Bear", optional: false },
  { id: "projection-series-field:weighted", key: "weighted", label: "Weighted", optional: false },
  { id: "projection-series-field:assumptions", key: "assumptions", label: "Assumptions", optional: false },
  { id: "projection-series-field:disclosures", key: "disclosures", label: "Disclosures", optional: false },
] as const satisfies readonly FieldDescriptor<ProjectionSeriesFieldKey>[];
export const PROJECTION_SERIES_FIELD_BY_KEY = {
  metric: PROJECTION_SERIES_FIELDS[0],
  unit: PROJECTION_SERIES_FIELDS[1],
  historical: PROJECTION_SERIES_FIELDS[2],
  bull: PROJECTION_SERIES_FIELDS[3],
  base: PROJECTION_SERIES_FIELDS[4],
  bear: PROJECTION_SERIES_FIELDS[5],
  weighted: PROJECTION_SERIES_FIELDS[6],
  assumptions: PROJECTION_SERIES_FIELDS[7],
  disclosures: PROJECTION_SERIES_FIELDS[8],
} as const satisfies Record<ProjectionSeriesFieldKey, FieldDescriptor<ProjectionSeriesFieldKey>>;

export type ProjectionPointFieldKey = keyof ProjectionPoint;
export const PROJECTION_POINT_FIELD_ORDER = [
  "period",
  "value",
] as const satisfies readonly ProjectionPointFieldKey[];
export const PROJECTION_POINT_FIELDS = [
  { id: "projection-point-field:period", key: "period", label: "Period", optional: false },
  { id: "projection-point-field:value", key: "value", label: "Value", optional: false },
] as const satisfies readonly FieldDescriptor<ProjectionPointFieldKey>[];
export const PROJECTION_POINT_FIELD_BY_KEY = {
  period: PROJECTION_POINT_FIELDS[0],
  value: PROJECTION_POINT_FIELDS[1],
} as const satisfies Record<ProjectionPointFieldKey, FieldDescriptor<ProjectionPointFieldKey>>;

export type ProjectionDisclosureFieldKey = keyof ManifestEntry;
export const PROJECTION_DISCLOSURE_FIELD_ORDER = [
  "field",
  "reason",
  "severity",
  "attemptedSources",
  "expected",
] as const satisfies readonly ProjectionDisclosureFieldKey[];
export const PROJECTION_DISCLOSURE_FIELDS = [
  { id: "projection-disclosure-field:field", key: "field", label: "Field", optional: false },
  { id: "projection-disclosure-field:reason", key: "reason", label: "Reason", optional: false },
  { id: "projection-disclosure-field:severity", key: "severity", label: "Severity", optional: false },
  { id: "projection-disclosure-field:attemptedSources", key: "attemptedSources", label: "Attempted sources", optional: true },
  { id: "projection-disclosure-field:expected", key: "expected", label: "Expected gap", optional: true },
] as const satisfies readonly FieldDescriptor<ProjectionDisclosureFieldKey>[];
export const PROJECTION_DISCLOSURE_FIELD_BY_KEY = {
  field: PROJECTION_DISCLOSURE_FIELDS[0],
  reason: PROJECTION_DISCLOSURE_FIELDS[1],
  severity: PROJECTION_DISCLOSURE_FIELDS[2],
  attemptedSources: PROJECTION_DISCLOSURE_FIELDS[3],
  expected: PROJECTION_DISCLOSURE_FIELDS[4],
} as const satisfies Record<ProjectionDisclosureFieldKey, FieldDescriptor<ProjectionDisclosureFieldKey>>;

type GradeBlock = NonNullable<GradeStrip[GradeSurfaceKey]>;

export function gradeSurfaceEntries(strip: GradeStrip): Array<{
  descriptor: (typeof GRADE_SURFACES)[number];
  block: GradeBlock;
}> {
  const entries: Array<{
    descriptor: (typeof GRADE_SURFACES)[number];
    block: GradeBlock;
  }> = [];
  for (const descriptor of GRADE_SURFACES) {
    const block = strip[descriptor.key];
    if (block !== undefined) entries.push({ descriptor, block });
  }
  return entries;
}

export function isCanonicalGradeSurfaceKeySequence(keys: readonly string[]): boolean {
  if (keys.length === GRADE_SURFACE_ORDER.length) {
    return keys.every((key, index) => key === GRADE_SURFACE_ORDER[index]);
  }
  if (keys.length !== GRADE_SURFACE_ORDER.length - 1) return false;
  let keyIndex = 0;
  for (const descriptor of GRADE_SURFACES) {
    if (descriptor.optional) continue;
    if (keys[keyIndex] !== descriptor.key) return false;
    keyIndex += 1;
  }
  return true;
}

export function orderedProjectionSeries<T extends { readonly metric: string }>(
  input: readonly T[],
): T[] {
  const ordered: T[] = [];
  const consumed = new Set<number>();
  for (const metric of PROJECTION_METRIC_ORDER) {
    for (let index = 0; index < input.length; index += 1) {
      if (input[index]?.metric !== metric) continue;
      ordered.push(input[index]!);
      consumed.add(index);
    }
  }
  for (let index = 0; index < input.length; index += 1) {
    if (!consumed.has(index)) ordered.push(input[index]!);
  }
  return ordered;
}

export function scoreDriverIdentity(
  aspect: ScoreAspect,
  driver: Pick<TracedNumber, "sourceId" | "source" | "unit" | "period">,
): string {
  return JSON.stringify([
    aspect,
    driver.sourceId ?? driver.source,
    driver.unit,
    driver.period ?? "",
  ]);
}

export function projectionPointIdentity(
  metric: ProjectionMetric,
  path: ProjectionPath,
  period: string,
): string {
  return JSON.stringify([metric, path, period]);
}

export interface ProjectionPeriodRow {
  readonly period: string;
  readonly points: {
    readonly historical: readonly ProjectionPoint[];
    readonly bull: readonly ProjectionPoint[];
    readonly base: readonly ProjectionPoint[];
    readonly bear: readonly ProjectionPoint[];
    readonly weighted: readonly ProjectionPoint[];
  };
}

export function projectionPeriodRows(series: ProjectionSeries): ProjectionPeriodRow[] {
  const periods = new Set<string>();
  for (const path of PROJECTION_PATH_ORDER) {
    for (const point of series[path]) periods.add(point.period);
  }
  const sortedPeriods = [...periods].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0);
  return sortedPeriods.map((period) => ({
    period,
    points: {
      historical: series.historical.filter((point) => point.period === period),
      bull: series.bull.filter((point) => point.period === period),
      base: series.base.filter((point) => point.period === period),
      bear: series.bear.filter((point) => point.period === period),
      weighted: series.weighted.filter((point) => point.period === period),
    },
  }));
}

export function projectionCellPoint(
  row: ProjectionPeriodRow,
  path: ProjectionPath,
  seriesUnit: string,
): ProjectionPoint | null {
  const points = row.points[path];
  if (points.length !== 1) return null;
  const point = points[0]!;
  if (point.value.period != null && point.value.period !== row.period) return null;
  if (point.value.unit !== seriesUnit) return null;
  return point;
}
