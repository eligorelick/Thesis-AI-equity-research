import { describe, expect, expectTypeOf, it } from "vitest";

import {
  AspectScoreSchema,
  CompositeScoreSchema,
  DataCompletenessSchema,
  ExecutiveEvidenceSchema,
  GradeStripSchema,
  ManifestEntrySchema,
  ProjectionMetricSchema,
  ProjectionPointSchema,
  ProjectionSeriesSchema,
  ProjectionsSchema,
  ScoreAspectSchema,
  ScoringSchema,
  SourceEntrySchema,
  TracedNumberSchema,
  VerificationLogEntrySchema,
  type GradeStrip,
  type ProjectionSeries,
  type ScoreAspect,
  type TracedNumber,
} from "@/report/schema";
import type { GradeStripCell as ApiGradeStripCell } from "@/app/api/report/view/[reportId]/route";
import type { GradeSection } from "@/report/diff";
import type { GradeStripCell as HistoryGradeStripCell, GradeStripKey } from "@/report/history";
import type { WatchlistGrades } from "@/watchlist/watchlist";
import {
  ASPECT_SCORE_FIELD_BY_KEY,
  ASPECT_SCORE_FIELD_ORDER,
  ASPECT_SCORE_FIELDS,
  AS_OF_MAP_FIELD_BY_KEY,
  AS_OF_MAP_FIELD_ORDER,
  AS_OF_MAP_FIELDS,
  COMPOSITE_SCORE_FIELD_BY_KEY,
  COMPOSITE_SCORE_FIELD_ORDER,
  COMPOSITE_SCORE_FIELDS,
  DATA_COMPLETENESS_FIELD_BY_KEY,
  DATA_COMPLETENESS_FIELD_ORDER,
  DATA_COMPLETENESS_FIELDS,
  EXECUTIVE_EVIDENCE_BY_KEY,
  EXECUTIVE_EVIDENCE_GROUPS,
  EXECUTIVE_EVIDENCE_ORDER,
  GRADE_SURFACE_BY_KEY,
  GRADE_SURFACE_ORDER,
  GRADE_SURFACES,
  MANIFEST_ENTRY_FIELD_BY_KEY,
  MANIFEST_ENTRY_FIELD_ORDER,
  MANIFEST_ENTRY_FIELDS,
  PROJECTION_DISCLOSURE_FIELD_BY_KEY,
  PROJECTION_DISCLOSURE_FIELD_ORDER,
  PROJECTION_DISCLOSURE_FIELDS,
  PROJECTION_METRIC_BY_KEY,
  PROJECTION_METRIC_ORDER,
  PROJECTION_METRICS,
  PROJECTION_PATH_BY_KEY,
  PROJECTION_PATH_ORDER,
  PROJECTION_PATHS,
  PROJECTION_POINT_FIELD_BY_KEY,
  PROJECTION_POINT_FIELD_ORDER,
  PROJECTION_POINT_FIELDS,
  PROJECTION_ROOT_FIELD_BY_KEY,
  PROJECTION_ROOT_FIELD_ORDER,
  PROJECTION_ROOT_FIELDS,
  PROJECTION_SCENARIO_WEIGHT_BY_KEY,
  PROJECTION_SCENARIO_WEIGHT_ORDER,
  PROJECTION_SCENARIO_WEIGHTS,
  PROJECTION_SERIES_FIELD_BY_KEY,
  PROJECTION_SERIES_FIELD_ORDER,
  PROJECTION_SERIES_FIELDS,
  SCORE_ASPECT_ORDER,
  SCORE_SURFACE_BY_KEY,
  SCORE_SURFACE_ORDER,
  SCORE_SURFACES,
  SCORE_WEIGHT_BY_ASPECT,
  SCORE_WEIGHTS,
  SOURCE_ENTRY_FIELD_BY_KEY,
  SOURCE_ENTRY_FIELD_ORDER,
  SOURCE_ENTRY_FIELDS,
  SCORING_FIELD_BY_KEY,
  SCORING_FIELD_ORDER,
  SCORING_FIELDS,
  TRACED_NUMBER_FIELD_BY_KEY,
  TRACED_NUMBER_FIELD_ORDER,
  TRACED_NUMBER_FIELDS,
  VERIFICATION_LOG_FIELD_BY_KEY,
  VERIFICATION_LOG_FIELD_ORDER,
  VERIFICATION_LOG_FIELDS,
  gradeSurfaceEntries,
  isCanonicalGradeSurfaceKeySequence,
  orderedProjectionSeries,
  projectionPeriodRows,
  projectionPointIdentity,
  scoreDriverIdentity,
  type ExecutiveEvidenceKey,
  type GradeSurfaceKey,
  type ProjectionPath,
  type ScoreSurfaceKey,
  type TracedNumberFieldKey,
} from "@/report/surfaceManifest";

const GRADE_ORDER = [
  "fundamentals",
  "valuation",
  "technicals",
  "balanceSheet",
  "quality",
  "leadership",
  "moat",
] as const;

const SCORE_ORDER = [
  "composite",
  "fundamentals",
  "valuation",
  "quality",
  "balanceSheet",
  "moat",
  "leadership",
  "technicals",
] as const;

const ASPECT_ORDER = [
  "fundamentals",
  "valuation",
  "quality",
  "balanceSheet",
  "moat",
  "leadership",
  "technicals",
] as const;

const METRIC_ORDER = ["revenue", "operatingMargin", "fcf", "epsDiluted"] as const;
const PATH_ORDER = ["historical", "bull", "base", "bear", "weighted"] as const;
const EVIDENCE_ORDER = [
  "guidanceVsActuals",
  "capitalAllocation",
  "insiderActivity",
  "compensation",
] as const;
const TRACE_ORDER = [
  "value",
  "unit",
  "currency",
  "period",
  "sourceId",
  "source",
  "asOf",
  "verified",
  "verificationNote",
] as const;

const SCORING_ORDER = ["aspects", "composite", "bandsVersion"] as const;
const ASPECT_SCORE_ORDER = [
  "score",
  "band",
  "weightPct",
  "dataCompleteness",
  "drivers",
  "notApplicableReason",
  "note",
] as const;
const COMPOSITE_SCORE_ORDER = ["score", "band", "weights", "methodology"] as const;
const PROJECTION_ROOT_ORDER = [
  "horizonYears",
  "scenarioWeights",
  "weightsVersion",
  "series",
  "notApplicableReason",
] as const;
const PROJECTION_SERIES_ORDER = [
  "metric",
  "unit",
  "historical",
  "bull",
  "base",
  "bear",
  "weighted",
  "assumptions",
  "disclosures",
] as const;
const PROJECTION_POINT_ORDER = ["period", "value"] as const;
const PROJECTION_DISCLOSURE_ORDER = [
  "field",
  "reason",
  "severity",
  "attemptedSources",
  "expected",
] as const;
const SOURCE_ENTRY_ORDER = ["provider", "endpoint", "asOf", "fetchedAt", "stale"] as const;
const VERIFICATION_LOG_ORDER = [
  "claim",
  "outcome",
  "note",
  "path",
  "evidenceKind",
  "source",
  "reason",
  "traceKind",
] as const;
const AS_OF_MAP_ORDER = ["field", "asOf"] as const;
const DATA_COMPLETENESS_ORDER = [
  "state",
  "criticalCount",
  "warningCount",
  "edgar",
  "xbrl",
  "forensicValidation",
] as const;

function keysOfShape(schema: { shape: Record<string, unknown> }): string[] {
  return Object.keys(schema.shape);
}

function ids(rows: readonly { id: string }[]): string[] {
  return rows.map((row) => row.id);
}

describe("shared report surface manifest", () => {
  it("pins every public domain to the actual schema key set and an independent literal order", () => {
    expect([...GRADE_SURFACE_ORDER]).toEqual(GRADE_ORDER);
    expect([...SCORE_SURFACE_ORDER]).toEqual(SCORE_ORDER);
    expect([...SCORE_ASPECT_ORDER]).toEqual(ASPECT_ORDER);
    expect([...PROJECTION_METRIC_ORDER]).toEqual(METRIC_ORDER);
    expect([...PROJECTION_PATH_ORDER]).toEqual(PATH_ORDER);
    expect([...EXECUTIVE_EVIDENCE_ORDER]).toEqual(EVIDENCE_ORDER);
    expect([...TRACED_NUMBER_FIELD_ORDER]).toEqual(TRACE_ORDER);

    expect(new Set(GRADE_SURFACE_ORDER)).toEqual(new Set(keysOfShape(GradeStripSchema)));
    expect(new Set(SCORE_ASPECT_ORDER)).toEqual(new Set(ScoreAspectSchema.options));
    expect(new Set(SCORE_ASPECT_ORDER)).toEqual(
      new Set(keysOfShape(ScoringSchema.shape.aspects)),
    );
    expect(new Set(SCORE_ASPECT_ORDER)).toEqual(
      new Set(keysOfShape(CompositeScoreSchema.shape.weights)),
    );
    expect(new Set(PROJECTION_METRIC_ORDER)).toEqual(new Set(ProjectionMetricSchema.options));
    expect(new Set(EXECUTIVE_EVIDENCE_ORDER)).toEqual(
      new Set(keysOfShape(ExecutiveEvidenceSchema)),
    );
    expect(new Set(TRACED_NUMBER_FIELD_ORDER)).toEqual(
      new Set(keysOfShape(TracedNumberSchema)),
    );

    expect(GRADE_SURFACES.map((entry) => entry.key)).toEqual(GRADE_ORDER);
    expect(SCORE_SURFACES.map((entry) => entry.key)).toEqual(SCORE_ORDER);
    expect(SCORE_WEIGHTS.map((entry) => entry.aspect)).toEqual(ASPECT_ORDER);
    expect(PROJECTION_METRICS.map((entry) => entry.key)).toEqual(METRIC_ORDER);
    expect(PROJECTION_PATHS.map((entry) => entry.key)).toEqual(PATH_ORDER);
    expect(EXECUTIVE_EVIDENCE_GROUPS.map((entry) => entry.key)).toEqual(EVIDENCE_ORDER);
    expect(TRACED_NUMBER_FIELDS.map((entry) => entry.key)).toEqual(TRACE_ORDER);
  });

  it("uses exact stable semantic IDs, unique short labels, and complete exact maps", () => {
    expect(GRADE_SURFACES).toEqual([
      { id: "grade:fundamentals", key: "fundamentals", label: "Fundamentals", shortLabel: "F", sectionKey: "fundamentals", optional: false },
      { id: "grade:valuation", key: "valuation", label: "Valuation", shortLabel: "V", sectionKey: "valuation", optional: false },
      { id: "grade:technicals", key: "technicals", label: "Technicals", shortLabel: "T", sectionKey: "technicals", optional: false },
      { id: "grade:balanceSheet", key: "balanceSheet", label: "Balance Sheet", shortLabel: "BS", sectionKey: "balanceSheet", optional: true },
      { id: "grade:quality", key: "quality", label: "Quality / Red-Flags", shortLabel: "Q", sectionKey: "quality", optional: false },
      { id: "grade:leadership", key: "leadership", label: "Leadership", shortLabel: "L", sectionKey: "leadership", optional: false },
      { id: "grade:moat", key: "moat", label: "Moat", shortLabel: "M", sectionKey: "competitive", optional: false },
    ]);
    expect(SCORE_SURFACES).toEqual([
      { id: "score:composite", key: "composite", kind: "composite", label: "Composite", sectionKey: "verdict" },
      { id: "score:fundamentals", key: "fundamentals", kind: "aspect", label: "Fundamentals", sectionKey: "fundamentals" },
      { id: "score:valuation", key: "valuation", kind: "aspect", label: "Valuation", sectionKey: "valuation" },
      { id: "score:quality", key: "quality", kind: "aspect", label: "Quality", sectionKey: "quality" },
      { id: "score:balanceSheet", key: "balanceSheet", kind: "aspect", label: "Balance Sheet", sectionKey: "balanceSheet" },
      { id: "score:moat", key: "moat", kind: "aspect", label: "Moat", sectionKey: "competitive" },
      { id: "score:leadership", key: "leadership", kind: "aspect", label: "Leadership", sectionKey: "leadership" },
      { id: "score:technicals", key: "technicals", kind: "aspect", label: "Technicals", sectionKey: "technicals" },
    ]);
    expect(SCORE_WEIGHTS).toEqual(
      SCORE_SURFACES.slice(1).map(({ key, label, sectionKey }) => ({
        id: `score-weight:${key}`,
        aspect: key,
        label,
        sectionKey,
      })),
    );
    expect(PROJECTION_METRICS).toEqual([
      { id: "projection-metric:revenue", key: "revenue", label: "Revenue" },
      { id: "projection-metric:operatingMargin", key: "operatingMargin", label: "Operating margin" },
      { id: "projection-metric:fcf", key: "fcf", label: "Free cash flow (FCFF)" },
      { id: "projection-metric:epsDiluted", key: "epsDiluted", label: "Diluted EPS" },
    ]);
    expect(PROJECTION_PATHS).toEqual([
      { id: "projection-path:historical", key: "historical", label: "Historical", kind: "historical" },
      { id: "projection-path:bull", key: "bull", label: "Bull", kind: "scenario" },
      { id: "projection-path:base", key: "base", label: "Base", kind: "scenario" },
      { id: "projection-path:bear", key: "bear", label: "Bear", kind: "scenario" },
      { id: "projection-path:weighted", key: "weighted", label: "Weighted", kind: "weighted" },
    ]);
    expect(EXECUTIVE_EVIDENCE_GROUPS).toEqual([
      { id: "executive-evidence:guidanceVsActuals", key: "guidanceVsActuals", label: "Guidance vs actuals" },
      { id: "executive-evidence:capitalAllocation", key: "capitalAllocation", label: "Capital allocation" },
      { id: "executive-evidence:insiderActivity", key: "insiderActivity", label: "Insider activity" },
      { id: "executive-evidence:compensation", key: "compensation", label: "Compensation" },
    ]);
    expect(TRACED_NUMBER_FIELDS).toEqual([
      { id: "traced-number-field:value", key: "value", label: "Value", optional: false },
      { id: "traced-number-field:unit", key: "unit", label: "Unit", optional: false },
      { id: "traced-number-field:currency", key: "currency", label: "Currency", optional: true },
      { id: "traced-number-field:period", key: "period", label: "Period", optional: true },
      { id: "traced-number-field:sourceId", key: "sourceId", label: "Source ID", optional: true },
      { id: "traced-number-field:source", key: "source", label: "Source", optional: false },
      { id: "traced-number-field:asOf", key: "asOf", label: "As of", optional: false },
      { id: "traced-number-field:verified", key: "verified", label: "Citation traced", optional: false },
      { id: "traced-number-field:verificationNote", key: "verificationNote", label: "Citation note", optional: true },
    ]);
    expect(GRADE_SURFACE_BY_KEY).toEqual(
      Object.fromEntries(GRADE_SURFACES.map((entry) => [entry.key, entry])),
    );
    expect(SCORE_SURFACE_BY_KEY).toEqual(
      Object.fromEntries(SCORE_SURFACES.map((entry) => [entry.key, entry])),
    );
    expect(SCORE_WEIGHT_BY_ASPECT).toEqual(
      Object.fromEntries(SCORE_WEIGHTS.map((entry) => [entry.aspect, entry])),
    );
    expect(PROJECTION_METRIC_BY_KEY).toEqual(
      Object.fromEntries(PROJECTION_METRICS.map((entry) => [entry.key, entry])),
    );
    expect(PROJECTION_PATH_BY_KEY).toEqual(
      Object.fromEntries(PROJECTION_PATHS.map((entry) => [entry.key, entry])),
    );
    expect(EXECUTIVE_EVIDENCE_BY_KEY).toEqual(
      Object.fromEntries(EXECUTIVE_EVIDENCE_GROUPS.map((entry) => [entry.key, entry])),
    );
    expect(TRACED_NUMBER_FIELD_BY_KEY).toEqual(
      Object.fromEntries(TRACED_NUMBER_FIELDS.map((entry) => [entry.key, entry])),
    );
    expect(ids(GRADE_SURFACES)).toEqual(GRADE_ORDER.map((key) => `grade:${key}`));
    expect(ids(SCORE_SURFACES)).toEqual(SCORE_ORDER.map((key) => `score:${key}`));
    expect(ids(SCORE_WEIGHTS)).toEqual(
      ASPECT_ORDER.map((key) => `score-weight:${key}`),
    );
    expect(ids(PROJECTION_METRICS)).toEqual(
      METRIC_ORDER.map((key) => `projection-metric:${key}`),
    );
    expect(ids(PROJECTION_PATHS)).toEqual(
      PATH_ORDER.map((key) => `projection-path:${key}`),
    );
    expect(ids(EXECUTIVE_EVIDENCE_GROUPS)).toEqual(
      EVIDENCE_ORDER.map((key) => `executive-evidence:${key}`),
    );
    expect(ids(TRACED_NUMBER_FIELDS)).toEqual(
      TRACE_ORDER.map((key) => `traced-number-field:${key}`),
    );

    const everyId = [
      ...ids(GRADE_SURFACES),
      ...ids(SCORE_SURFACES),
      ...ids(SCORE_WEIGHTS),
      ...ids(PROJECTION_METRICS),
      ...ids(PROJECTION_PATHS),
      ...ids(EXECUTIVE_EVIDENCE_GROUPS),
      ...ids(TRACED_NUMBER_FIELDS),
      ...ids(SCORING_FIELDS),
      ...ids(ASPECT_SCORE_FIELDS),
      ...ids(COMPOSITE_SCORE_FIELDS),
      ...ids(PROJECTION_ROOT_FIELDS),
      ...ids(PROJECTION_SCENARIO_WEIGHTS),
      ...ids(PROJECTION_SERIES_FIELDS),
      ...ids(PROJECTION_POINT_FIELDS),
      ...ids(PROJECTION_DISCLOSURE_FIELDS),
      ...ids(SOURCE_ENTRY_FIELDS),
      ...ids(VERIFICATION_LOG_FIELDS),
      ...ids(AS_OF_MAP_FIELDS),
      ...ids(DATA_COMPLETENESS_FIELDS),
    ];
    expect(new Set(everyId).size).toBe(everyId.length);
    expect(new Set(GRADE_SURFACES.map((entry) => entry.shortLabel)).size).toBe(
      GRADE_SURFACES.length,
    );
    expect(GRADE_SURFACE_BY_KEY.balanceSheet).toMatchObject({
      optional: true,
      sectionKey: "balanceSheet",
      shortLabel: "BS",
    });
    expect(GRADE_SURFACES.filter((entry) => entry.optional).map((entry) => entry.key)).toEqual([
      "balanceSheet",
    ]);
    expect(GRADE_SURFACE_BY_KEY.moat.sectionKey).toBe("competitive");
    expect(SCORE_SURFACE_BY_KEY.composite).toMatchObject({
      kind: "composite",
      sectionKey: "verdict",
    });
    expect(SCORE_SURFACES.slice(1).every((entry) => entry.kind === "aspect")).toBe(true);
    expect(SCORE_WEIGHT_BY_ASPECT.balanceSheet.id).toBe("score-weight:balanceSheet");
    expect(PROJECTION_METRIC_BY_KEY.operatingMargin.label).toBe("Operating margin");
    expect(PROJECTION_PATH_BY_KEY.historical.kind).toBe("historical");
    expect(PROJECTION_PATH_BY_KEY.bull.kind).toBe("scenario");
    expect(PROJECTION_PATH_BY_KEY.weighted.kind).toBe("weighted");
    expect(EXECUTIVE_EVIDENCE_BY_KEY.guidanceVsActuals.label).toBe(
      "Guidance vs actuals",
    );
    expect(TRACED_NUMBER_FIELD_BY_KEY.verificationNote.optional).toBe(true);
  });

  it("pins Task28-ready score and projection root/leaf fields to their actual schemas", () => {
    expect(SCORING_FIELD_ORDER).toEqual(SCORING_ORDER);
    expect(ASPECT_SCORE_FIELD_ORDER).toEqual(ASPECT_SCORE_ORDER);
    expect(COMPOSITE_SCORE_FIELD_ORDER).toEqual(COMPOSITE_SCORE_ORDER);
    expect(PROJECTION_ROOT_FIELD_ORDER).toEqual(PROJECTION_ROOT_ORDER);
    expect(PROJECTION_SERIES_FIELD_ORDER).toEqual(PROJECTION_SERIES_ORDER);
    expect(PROJECTION_POINT_FIELD_ORDER).toEqual(PROJECTION_POINT_ORDER);
    expect(PROJECTION_DISCLOSURE_FIELD_ORDER).toEqual(PROJECTION_DISCLOSURE_ORDER);
    const fieldCases = [
      [SCORING_FIELD_ORDER, SCORING_FIELDS, SCORING_FIELD_BY_KEY, ScoringSchema],
      [ASPECT_SCORE_FIELD_ORDER, ASPECT_SCORE_FIELDS, ASPECT_SCORE_FIELD_BY_KEY, AspectScoreSchema],
      [COMPOSITE_SCORE_FIELD_ORDER, COMPOSITE_SCORE_FIELDS, COMPOSITE_SCORE_FIELD_BY_KEY, CompositeScoreSchema],
      [PROJECTION_ROOT_FIELD_ORDER, PROJECTION_ROOT_FIELDS, PROJECTION_ROOT_FIELD_BY_KEY, ProjectionsSchema],
      [PROJECTION_SERIES_FIELD_ORDER, PROJECTION_SERIES_FIELDS, PROJECTION_SERIES_FIELD_BY_KEY, ProjectionSeriesSchema],
      [PROJECTION_POINT_FIELD_ORDER, PROJECTION_POINT_FIELDS, PROJECTION_POINT_FIELD_BY_KEY, ProjectionPointSchema],
      [PROJECTION_DISCLOSURE_FIELD_ORDER, PROJECTION_DISCLOSURE_FIELDS, PROJECTION_DISCLOSURE_FIELD_BY_KEY, ManifestEntrySchema],
      [DATA_COMPLETENESS_FIELD_ORDER, DATA_COMPLETENESS_FIELDS, DATA_COMPLETENESS_FIELD_BY_KEY, DataCompletenessSchema],
    ] as const;

    for (const [order, fields, byKey, schema] of fieldCases) {
      expect(fields.map((entry) => entry.key)).toEqual(order);
      expect(new Set(order)).toEqual(new Set(keysOfShape(schema)));
      expect(new Set(Object.values(byKey).map((entry) => entry.id)).size).toBe(order.length);
      expect(Object.values(byKey).every((entry) => entry.id.includes("-field:"))).toBe(true);
      expect(byKey).toEqual(Object.fromEntries(fields.map((entry) => [entry.key, entry])));
    }

    expect([...PROJECTION_SCENARIO_WEIGHT_ORDER]).toEqual(["bull", "base", "bear"]);
    expect(new Set(PROJECTION_SCENARIO_WEIGHT_ORDER)).toEqual(
      new Set(keysOfShape(ProjectionsSchema.shape.scenarioWeights)),
    );
    expect(PROJECTION_SCENARIO_WEIGHTS.map((entry) => entry.key)).toEqual([
      "bull",
      "base",
      "bear",
    ]);
    expect(Object.keys(PROJECTION_SCENARIO_WEIGHT_BY_KEY)).toEqual([
      "bull",
      "base",
      "bear",
    ]);
    expect(PROJECTION_SCENARIO_WEIGHT_BY_KEY).toEqual(
      Object.fromEntries(PROJECTION_SCENARIO_WEIGHTS.map((entry) => [entry.key, entry])),
    );
    expect(ids(SCORING_FIELDS)).toEqual(SCORING_ORDER.map((key) => `scoring-field:${key}`));
    expect(ids(ASPECT_SCORE_FIELDS)).toEqual(
      ASPECT_SCORE_ORDER.map((key) => `aspect-score-field:${key}`),
    );
    expect(ids(COMPOSITE_SCORE_FIELDS)).toEqual(
      COMPOSITE_SCORE_ORDER.map((key) => `composite-score-field:${key}`),
    );
    expect(ids(PROJECTION_ROOT_FIELDS)).toEqual(
      PROJECTION_ROOT_ORDER.map((key) => `projection-root-field:${key}`),
    );
    expect(ids(PROJECTION_SCENARIO_WEIGHTS)).toEqual(
      ["bull", "base", "bear"].map((key) => `projection-scenario-weight:${key}`),
    );
    expect(ids(PROJECTION_SERIES_FIELDS)).toEqual(
      PROJECTION_SERIES_ORDER.map((key) => `projection-series-field:${key}`),
    );
    expect(ids(PROJECTION_POINT_FIELDS)).toEqual(
      PROJECTION_POINT_ORDER.map((key) => `projection-point-field:${key}`),
    );
    expect(ids(PROJECTION_DISCLOSURE_FIELDS)).toEqual(
      PROJECTION_DISCLOSURE_ORDER.map((key) => `projection-disclosure-field:${key}`),
    );
  });

  it("pins source, manifest, verification-log, and as-of-map audit fields without duplicate manifests", () => {
    expect(SOURCE_ENTRY_FIELD_ORDER).toEqual(SOURCE_ENTRY_ORDER);
    expect(VERIFICATION_LOG_FIELD_ORDER).toEqual(VERIFICATION_LOG_ORDER);
    expect(AS_OF_MAP_FIELD_ORDER).toEqual(AS_OF_MAP_ORDER);
    expect(new Set(SOURCE_ENTRY_FIELD_ORDER)).toEqual(new Set(keysOfShape(SourceEntrySchema)));
    expect(new Set(VERIFICATION_LOG_FIELD_ORDER)).toEqual(
      new Set(keysOfShape(VerificationLogEntrySchema)),
    );
    expect(SOURCE_ENTRY_FIELDS).toEqual([
      { id: "source-entry-field:provider", key: "provider", label: "Provider", optional: false },
      { id: "source-entry-field:endpoint", key: "endpoint", label: "Endpoint", optional: false },
      { id: "source-entry-field:asOf", key: "asOf", label: "As of", optional: false },
      { id: "source-entry-field:fetchedAt", key: "fetchedAt", label: "Fetched at", optional: false },
      { id: "source-entry-field:stale", key: "stale", label: "Stale", optional: true },
    ]);
    expect(VERIFICATION_LOG_FIELDS).toEqual([
      { id: "verification-log-field:claim", key: "claim", label: "Claim", optional: false },
      { id: "verification-log-field:outcome", key: "outcome", label: "Outcome", optional: false },
      { id: "verification-log-field:note", key: "note", label: "Note", optional: true },
      { id: "verification-log-field:path", key: "path", label: "Path", optional: true },
      { id: "verification-log-field:evidenceKind", key: "evidenceKind", label: "Evidence kind", optional: true },
      { id: "verification-log-field:source", key: "source", label: "Source", optional: true },
      { id: "verification-log-field:reason", key: "reason", label: "Reason", optional: true },
      { id: "verification-log-field:traceKind", key: "traceKind", label: "Trace kind", optional: true },
    ]);
    expect(AS_OF_MAP_FIELDS).toEqual([
      { id: "as-of-map-field:field", key: "field", label: "Field", optional: false },
      { id: "as-of-map-field:asOf", key: "asOf", label: "As of", optional: false },
    ]);
    expect(SOURCE_ENTRY_FIELD_BY_KEY).toEqual(
      Object.fromEntries(SOURCE_ENTRY_FIELDS.map((entry) => [entry.key, entry])),
    );
    expect(VERIFICATION_LOG_FIELD_BY_KEY).toEqual(
      Object.fromEntries(VERIFICATION_LOG_FIELDS.map((entry) => [entry.key, entry])),
    );
    expect(AS_OF_MAP_FIELD_BY_KEY).toEqual(
      Object.fromEntries(AS_OF_MAP_FIELDS.map((entry) => [entry.key, entry])),
    );
    expect(MANIFEST_ENTRY_FIELD_ORDER).toBe(PROJECTION_DISCLOSURE_FIELD_ORDER);
    expect(MANIFEST_ENTRY_FIELDS).toBe(PROJECTION_DISCLOSURE_FIELDS);
    expect(MANIFEST_ENTRY_FIELD_BY_KEY).toBe(PROJECTION_DISCLOSURE_FIELD_BY_KEY);
  });

  it("pins the client-safe persisted completeness field manifest", () => {
    expect(DATA_COMPLETENESS_FIELD_ORDER).toEqual(DATA_COMPLETENESS_ORDER);
    expect(new Set(DATA_COMPLETENESS_FIELD_ORDER)).toEqual(
      new Set(keysOfShape(DataCompletenessSchema)),
    );
    expect(DATA_COMPLETENESS_FIELDS).toEqual([
      { id: "data-completeness-field:state", key: "state", label: "State", optional: false },
      { id: "data-completeness-field:criticalCount", key: "criticalCount", label: "Critical count", optional: false },
      { id: "data-completeness-field:warningCount", key: "warningCount", label: "Warning count", optional: false },
      { id: "data-completeness-field:edgar", key: "edgar", label: "EDGAR", optional: false },
      { id: "data-completeness-field:xbrl", key: "xbrl", label: "XBRL", optional: false },
      { id: "data-completeness-field:forensicValidation", key: "forensicValidation", label: "Forensic validation", optional: false },
    ]);
    expect(DATA_COMPLETENESS_FIELD_BY_KEY).toEqual(
      Object.fromEntries(DATA_COMPLETENESS_FIELDS.map((entry) => [entry.key, entry])),
    );
    expect(ids(DATA_COMPLETENESS_FIELDS)).toEqual(
      DATA_COMPLETENESS_ORDER.map((key) => `data-completeness-field:${key}`),
    );
  });

  it("keeps compile-time map keys equal to the schema-derived domain unions", () => {
    expectTypeOf<keyof typeof GRADE_SURFACE_BY_KEY>().toEqualTypeOf<GradeSurfaceKey>();
    expectTypeOf<GradeSurfaceKey>().toEqualTypeOf<keyof GradeStrip>();
    expectTypeOf<ApiGradeStripCell["key"]>().toEqualTypeOf<GradeSurfaceKey>();
    expectTypeOf<HistoryGradeStripCell["key"]>().toEqualTypeOf<GradeSurfaceKey>();
    expectTypeOf<GradeStripKey>().toEqualTypeOf<GradeSurfaceKey>();
    expectTypeOf<keyof WatchlistGrades>().toEqualTypeOf<GradeSurfaceKey>();
    expectTypeOf<GradeSection>().toEqualTypeOf<GradeSurfaceKey>();
    expectTypeOf<keyof typeof SCORE_SURFACE_BY_KEY>().toEqualTypeOf<ScoreSurfaceKey>();
    expectTypeOf<keyof typeof SCORE_WEIGHT_BY_ASPECT>().toEqualTypeOf<ScoreAspect>();
    expectTypeOf<keyof typeof PROJECTION_PATH_BY_KEY>().toEqualTypeOf<ProjectionPath>();
    expectTypeOf<keyof typeof EXECUTIVE_EVIDENCE_BY_KEY>().toEqualTypeOf<ExecutiveEvidenceKey>();
    expectTypeOf<keyof typeof TRACED_NUMBER_FIELD_BY_KEY>().toEqualTypeOf<TracedNumberFieldKey>();
    expectTypeOf<TracedNumberFieldKey>().toEqualTypeOf<keyof TracedNumber>();
  });

  it("emits optional balance once in canonical position and never fabricates it for legacy reports", () => {
    const block = (grade: "A" | "B") => ({
      grade,
      oneLineWhy: `${grade} sentinel`,
      reasoning: [],
      confidence: "high" as const,
      keyNumbers: [],
    });
    const current: GradeStrip = {
      fundamentals: block("A"),
      valuation: block("A"),
      technicals: block("A"),
      quality: block("A"),
      leadership: block("A"),
      moat: block("A"),
      balanceSheet: block("B"),
    };
    const legacy = { ...current, balanceSheet: undefined };

    expect(gradeSurfaceEntries(current).map((entry) => entry.descriptor.key)).toEqual(
      GRADE_ORDER,
    );
    expect(gradeSurfaceEntries(current)[3]?.block.grade).toBe("B");
    expect(gradeSurfaceEntries(legacy).map((entry) => entry.descriptor.key)).toEqual([
      "fundamentals",
      "valuation",
      "technicals",
      "quality",
      "leadership",
      "moat",
    ]);
    expect(legacy.balanceSheet).toBeUndefined();

    expect(isCanonicalGradeSurfaceKeySequence([...GRADE_ORDER])).toBe(true);
    expect(
      isCanonicalGradeSurfaceKeySequence(GRADE_ORDER.filter((key) => key !== "balanceSheet")),
    ).toBe(true);
    expect(isCanonicalGradeSurfaceKeySequence([])).toBe(false);
    expect(isCanonicalGradeSurfaceKeySequence(["quality"])).toBe(false);
    expect(
      isCanonicalGradeSurfaceKeySequence([
        "fundamentals",
        "valuation",
        "technicals",
        "quality",
        "balanceSheet",
        "leadership",
        "moat",
      ]),
    ).toBe(false);
  });

  it("iterates all seven composite weights without coercing zero or fractional values", () => {
    const weights: Record<ScoreAspect, number> = {
      fundamentals: 0,
      valuation: 0.0125,
      quality: 0.0375,
      balanceSheet: 0.125,
      moat: 0.1875,
      leadership: 0.2625,
      technicals: 0.375,
    };
    const before = JSON.stringify(weights);
    expect(SCORE_WEIGHTS.map(({ aspect }) => [aspect, weights[aspect]])).toEqual([
      ["fundamentals", 0],
      ["valuation", 0.0125],
      ["quality", 0.0375],
      ["balanceSheet", 0.125],
      ["moat", 0.1875],
      ["leadership", 0.2625],
      ["technicals", 0.375],
    ]);
    expect(JSON.stringify(weights)).toBe(before);
  });

  it("uses collision-safe JSON identities for drivers and projection points", () => {
    const trace = (source: string, unit: string, period: string | null): TracedNumber => ({
      value: 1,
      unit,
      currency: null,
      period,
      source,
      asOf: null,
      verified: null,
    });
    const collisionA = trace("a|b", "c", "d");
    const collisionB = trace("a", "b|c", "d");
    const naiveIdentity = (value: TracedNumber) =>
      ["quality", value.sourceId ?? value.source, value.unit, value.period ?? ""].join("|");
    expect(naiveIdentity(collisionA)).toBe(naiveIdentity(collisionB));
    expect(scoreDriverIdentity("quality", collisionA)).not.toBe(
      scoreDriverIdentity("quality", collisionB),
    );
    collisionA.sourceId = "stable-id";
    collisionA.source = "changed display provenance";
    const identityBeforeProvenanceOnlyChanges = scoreDriverIdentity("quality", collisionA);
    collisionA.value = 99;
    collisionA.currency = "USD";
    collisionA.asOf = "2026-08-08";
    collisionA.verified = true;
    collisionA.verificationNote = "changed note";
    expect(scoreDriverIdentity("quality", collisionA)).toBe(
      JSON.stringify(["quality", "stable-id", "c", "d"]),
    );
    expect(scoreDriverIdentity("quality", collisionA)).toBe(
      identityBeforeProvenanceOnlyChanges,
    );
    expect(scoreDriverIdentity("valuation", collisionA)).not.toBe(
      scoreDriverIdentity("quality", collisionA),
    );
    expect(projectionPointIdentity("revenue", "weighted", "FY2030")).toBe(
      JSON.stringify(["revenue", "weighted", "FY2030"]),
    );
    expect(projectionPointIdentity("revenue", "bull", "FY2030")).not.toBe(
      projectionPointIdentity("revenue", "weighted", "FY2030"),
    );
    const nullPeriod = trace("stable", "x", null);
    const undefinedPeriod = { ...nullPeriod, period: undefined };
    expect(scoreDriverIdentity("moat", nullPeriod)).toBe(
      scoreDriverIdentity("moat", undefinedPeriod),
    );
  });

  it("orders real projection series canonically without dropping duplicates or mutating input", () => {
    const makeSeries = (metric: ProjectionSeries["metric"], marker: string) => ({
      metric,
      unit: marker,
      historical: [],
      bull: [],
      base: [],
      bear: [],
      weighted: [],
      assumptions: [],
      disclosures: [],
    }) satisfies ProjectionSeries;
    const input = [
      makeSeries("epsDiluted", "eps-first"),
      makeSeries("revenue", "revenue-a"),
      makeSeries("fcf", "fcf"),
      makeSeries("revenue", "revenue-b"),
      makeSeries("operatingMargin", "margin"),
    ];
    const before = structuredClone(input);

    const first = orderedProjectionSeries(input);
    const second = orderedProjectionSeries(input);
    expect(first.map((series) => `${series.metric}:${series.unit}`)).toEqual([
      "revenue:revenue-a",
      "revenue:revenue-b",
      "operatingMargin:margin",
      "fcf:fcf",
      "epsDiluted:eps-first",
    ]);
    expect(first).toEqual(second);
    expect(first).toHaveLength(input.length);
    expect(input).toEqual(before);
  });

  it("joins projection points by metric/path/period instead of array index and preserves ambiguity", () => {
    const point = (period: string, value: number, innerPeriod: string | null = period) => ({
      period,
      value: {
        value,
        unit: "USD",
        currency: "USD" as const,
        period: innerPeriod,
        source: `projection-${value}`,
        asOf: "2026-08-08",
        verified: true,
      },
    });
    const series = {
      metric: "revenue",
      unit: "USD",
      historical: [point("FY2024", 24), point("FY2023", 23)],
      bull: [point("FY2026", 126), point("FY2025", 125), point("FY2025", 925)],
      base: [point("FY2025", 115), point("FY2026", 116, "FY-CONFLICT")],
      bear: [point("FY2026", 106)],
      weighted: [point("FY2027", 117), point("FY2025", 112)],
      assumptions: ["sentinel"],
      disclosures: [],
    } satisfies ProjectionSeries;
    const before = structuredClone(series);

    const rows = projectionPeriodRows(series);
    expect(rows.map((row) => row.period)).toEqual([
      "FY2023",
      "FY2024",
      "FY2025",
      "FY2026",
      "FY2027",
    ]);
    expect(rows.find((row) => row.period === "FY2023")!.points.historical[0]!.value.value).toBe(23);
    expect(rows.find((row) => row.period === "FY2024")!.points.historical[0]!.value.value).toBe(24);
    const fy2025 = rows.find((row) => row.period === "FY2025")!;
    expect(Object.keys(fy2025.points)).toEqual(PATH_ORDER);
    expect(fy2025.points.bull.map((entry) => entry.value.value)).toEqual([125, 925]);
    expect(fy2025.points.base.map((entry) => entry.value.value)).toEqual([115]);
    expect(fy2025.points.bear).toEqual([]);
    expect(fy2025.points.weighted.map((entry) => entry.value.value)).toEqual([112]);
    expect(rows.find((row) => row.period === "FY2026")!.points.base[0]!.value.period).toBe(
      "FY-CONFLICT",
    );
    expect(projectionPeriodRows(series)).toEqual(rows);
    expect(series).toEqual(before);
  });
});
