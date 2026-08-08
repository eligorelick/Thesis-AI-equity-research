import { readFileSync } from "node:fs";
import path from "node:path";

import { buildDataCompleteness } from "@/report/completeness";
import {
  ReportSchema,
  type ProjectionMetric,
  type ProjectionPoint,
  type Report,
  type ScoreAspect,
  type TracedNumber,
} from "@/report/schema";
import {
  EXECUTIVE_EVIDENCE_GROUPS,
  PROJECTION_METRICS,
  PROJECTION_PATHS,
  SCORE_WEIGHTS,
  type ProjectionPath,
} from "@/report/surfaceManifest";

const FIXTURE_PATH = path.join(
  process.cwd(),
  "fixtures",
  "report",
  "DEMO-sample.json",
);

const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF"] as const;
const UNITS: Record<ProjectionMetric, string> = {
  revenue: "USD",
  operatingMargin: "percent",
  fcf: "USD",
  epsDiluted: "USD/share",
};

export function cloneTask28<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function loadTask28Fixture(): Report {
  return ReportSchema.parse(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")));
}

function trace(
  marker: string,
  value: number,
  unit: string,
  currency: string | null,
  verified: boolean | null,
  dateDay: number,
  period: string | null,
): TracedNumber {
  return {
    value,
    unit,
    currency,
    period,
    sourceId: `${marker}:source-id`,
    source: `${marker}:source-display`,
    asOf: `2026-07-${String(dateDay).padStart(2, "0")}`,
    verified,
    verificationNote: `${marker}:citation-note`,
  };
}

function projectionPoint(
  metric: ProjectionMetric,
  pathKey: ProjectionPath,
  pointIndex: number,
  metricIndex: number,
): ProjectionPoint {
  const historical = pathKey === "historical";
  const outerPeriod = historical
    ? `FY${2088 + pointIndex}`
    : `FY${2090 + pointIndex}`;
  const marker = `TASK28:${metric}:${pathKey}:${pointIndex}`;
  const ordinal = metricIndex * 100 + PROJECTION_PATHS.findIndex((path) => path.key === pathKey) * 10 + pointIndex;
  return {
    period: outerPeriod,
    value: trace(
      marker,
      10_000 + ordinal + 0.125,
      UNITS[metric],
      metric === "operatingMargin" ? null : CURRENCIES[metricIndex],
      [true, false, null][ordinal % 3] ?? null,
      (ordinal % 27) + 1,
      pointIndex === 0 ? outerPeriod : `${marker}:inner-period`,
    ),
  };
}

/**
 * A current schema-valid report with independently identifiable values in every
 * Task 28 surface. Consumers must render these values; tests never persist a
 * modified fixture back to disk.
 */
export function task28SentinelReport(): Report {
  const report = cloneTask28(loadTask28Fixture());
  report.meta.dataCompleteness = undefined;

  const scores = report.scores!;
  scores.composite.score = 72.625;
  scores.composite.band = "B";
  scores.composite.methodology = "TASK28:composite:methodology";
  scores.bandsVersion = "TASK28:BANDS:VERSION";
  for (const [aspectIndex, descriptor] of SCORE_WEIGHTS.entries()) {
    const aspect = descriptor.aspect;
    const score = scores.aspects[aspect];
    score.score = 61.125 + aspectIndex;
    score.band = (["A", "B", "C", "D", "F", "A", "B"] as const)[aspectIndex]!;
    score.weightPct = 1.25 + aspectIndex * 2.125;
    score.dataCompleteness = 0.51 + aspectIndex * 0.061;
    score.notApplicableReason = `TASK28:${aspect}:not-applicable-sentinel`;
    score.note = `TASK28:${aspect}:method-note-sentinel`;
    scores.composite.weights[aspect] = aspectIndex === 0 ? 0 : aspectIndex + 0.375;
    score.drivers = score.drivers.map((_, driverIndex) => {
      const marker = `TASK28:${aspect}:driver:${driverIndex}`;
      const driver = trace(
        marker,
        aspectIndex === 0 && driverIndex === 0
          ? 0
          : aspectIndex === 1 && driverIndex === 0
            ? -200.625
            : 100 * (aspectIndex + 1) + driverIndex + 0.375,
        `driver-unit-${aspectIndex}-${driverIndex}`,
        (aspectIndex + driverIndex) % 3 === 0 ? null : CURRENCIES[aspectIndex],
        [true, false, null][(aspectIndex + driverIndex) % 3] ?? null,
        ((aspectIndex * 3 + driverIndex) % 27) + 1,
        driverIndex % 2 === 0 ? `DRIVER-PERIOD-${aspectIndex}-${driverIndex}` : null,
      );
      if (driverIndex % 2 === 1) delete driver.sourceId;
      if ((aspectIndex + driverIndex) % 4 === 0) driver.asOf = null;
      if ((aspectIndex + driverIndex) % 3 === 2) delete driver.verificationNote;
      return driver;
    });
  }
  const firstDriver = scores.aspects.fundamentals.drivers[0]!;
  scores.aspects.fundamentals.drivers.push({
    ...firstDriver,
    value: 0.875,
    currency: "EUR",
    asOf: "2026-07-27",
    verificationNote: "TASK28:fundamentals:driver:duplicate-identity-note",
  });

  const firstExecutive = report.leadership.executives[0]!;
  firstExecutive.evidence = {};
  for (const [groupIndex, descriptor] of EXECUTIVE_EVIDENCE_GROUPS.entries()) {
    firstExecutive.evidence[descriptor.key] = [{
      text: `TASK28:evidence:${descriptor.key}:text`,
      label: (["FACT", "ESTIMATE", "JUDGMENT", "FACT"] as const)[groupIndex]!,
      sourceId: `TASK28:evidence:${descriptor.key}:source-id`,
      source: `TASK28:evidence:${descriptor.key}:source-display`,
      asOf: groupIndex === 3 ? null : `2026-06-0${groupIndex + 1}`,
    }];
  }
  const secondExecutive = report.leadership.executives[1]!;
  secondExecutive.evidence = {
    compensation: [{
      text: "TASK28:evidence:second-executive:compensation:text",
      label: "FACT",
      sourceId: "TASK28:evidence:second-executive:compensation:source-id",
      source: "TASK28:evidence:second-executive:compensation:source-display",
      asOf: "2026-06-09",
    }],
  };

  report.projections = {
    horizonYears: 7.25,
    scenarioWeights: { bull: 0.175, base: 0.625, bear: 0.2 },
    weightsVersion: "TASK28:PROJECTION-WEIGHTS:VERSION",
    notApplicableReason: "TASK28:projections:not-applicable-reason",
    series: PROJECTION_METRICS.map((metricDescriptor, metricIndex) => {
      const metric = metricDescriptor.key;
      const paths = Object.fromEntries(PROJECTION_PATHS.map((pathDescriptor) => [
        pathDescriptor.key,
        [0, 1].map((pointIndex) => projectionPoint(metric, pathDescriptor.key, pointIndex, metricIndex)),
      ])) as Record<ProjectionPath, ProjectionPoint[]>;
      return {
        metric,
        unit: UNITS[metric],
        historical: paths.historical,
        bull: paths.bull,
        base: paths.base,
        bear: paths.bear,
        weighted: paths.weighted,
        assumptions: [
          `TASK28:${metric}:assumption:0`,
          `TASK28:${metric}:assumption:1`,
        ],
        disclosures: [{
          field: `TASK28:${metric}:disclosure:field`,
          reason: `TASK28:${metric}:disclosure:reason`,
          severity: (["info", "warn", "critical", "info"] as const)[metricIndex]!,
          attemptedSources: [
            `TASK28:${metric}:disclosure:source:0`,
            `TASK28:${metric}:disclosure:source:1`,
          ],
          expected: ([true, false, undefined, true] as const)[metricIndex],
        }],
      };
    }),
  };

  report.appendix.sources = [
    {
      provider: "TASK28-provider-stale",
      endpoint: "TASK28-endpoint-stale",
      asOf: "2026-07-01T02:03:04.567Z",
      fetchedAt: "2026-07-02T03:04:05.678Z",
      stale: true,
    },
    {
      provider: "TASK28-provider-fresh",
      endpoint: "TASK28-endpoint-fresh",
      asOf: "2026-07-03T04:05:06.789Z",
      fetchedAt: "2026-07-04T05:06:07.890Z",
      stale: false,
    },
    {
      provider: "TASK28-provider-legacy",
      endpoint: "TASK28-endpoint-legacy",
      asOf: "2026-07-05T06:07:08.901Z",
      fetchedAt: "2026-07-06T07:08:09.012Z",
    },
  ];
  report.appendix.missingData = [
    {
      field: "TASK28:manifest:expected-true:field",
      reason: "TASK28:manifest:expected-true:reason",
      severity: "info",
      attemptedSources: ["TASK28:manifest:expected-true:source"],
      expected: true,
    },
    {
      field: "TASK28:manifest:expected-false:field",
      reason: "TASK28:manifest:expected-false:reason",
      severity: "warn",
      attemptedSources: ["TASK28:manifest:expected-false:source"],
      expected: false,
    },
    {
      field: "TASK28:manifest:expected-unknown:field",
      reason: "TASK28:manifest:expected-unknown:reason",
      severity: "info",
    },
  ];
  report.meta.dataCompleteness = buildDataCompleteness(report.appendix.missingData);
  report.meta.asOfMap = {
    "TASK28.asOfMap.alpha": "2026-01-02T03:04:05.678Z",
    "TASK28.asOfMap.beta": "2026-02-03T04:05:06.789Z",
  };
  report.appendix.verificationLog = [
    {
      claim: "1234.567 USD [TASK28:verification:verified:claim]",
      outcome: "verified",
      note: "TASK28:verification:verified:note",
      path: "TASK28.verification.verified.path",
      evidenceKind: "number",
      source: "TASK28:verification:verified:source",
      reason: "supported",
      traceKind: "payload-match",
    },
    {
      claim: "TASK28:verification:unverified:claim",
      outcome: "unverified",
      note: "TASK28:verification:unverified:note",
      path: "TASK28.verification.unverified.path",
      evidenceKind: "factual-claim",
      source: "TASK28:verification:unverified:source",
      reason: "period-mismatch",
      traceKind: "source-cited",
    },
    {
      claim: "TASK28:verification:removed:claim",
      outcome: "removed",
      note: "TASK28:verification:removed:note",
      path: "TASK28.verification.removed.path",
      evidenceKind: "judgment",
      source: "TASK28:verification:removed:source",
      reason: "unknown-source",
      traceKind: "untraced",
    },
    {
      claim: "TASK28:verification:computed:claim",
      outcome: "verified",
      note: "TASK28:verification:computed:note",
      path: "TASK28.verification.computed.path",
      evidenceKind: "number",
      source: "TASK28:verification:computed:source",
      reason: "supported",
      traceKind: "computed-derived",
    },
  ];

  return ReportSchema.parse(report);
}

export function task28AdversarialProjectionReport(): Report {
  const report = cloneTask28(task28SentinelReport());
  const series = report.projections!.series;
  series.reverse();
  for (const item of series) {
    item.historical.reverse();
    item.bull.reverse();
    item.base.reverse();
    item.bear.reverse();
    item.weighted.reverse();
  }

  const revenue = series.find((item) => item.metric === "revenue")!;
  const duplicate = cloneTask28(revenue.bull[0]!);
  duplicate.value = {
    ...duplicate.value,
    value: 98_765.4321,
    sourceId: "TASK28:duplicate:source-id",
    source: "TASK28:duplicate:source-display",
    verificationNote: "TASK28:duplicate:citation-note",
  };
  revenue.bull.splice(1, 0, duplicate);
  revenue.base = revenue.base.slice(0, 1);
  revenue.bear.push({
    period: "FY2087",
    value: trace(
      "TASK28:uneven:bear:extra",
      77_777.875,
      revenue.unit,
      "USD",
      false,
      26,
      "TASK28:uneven:bear:inner-period-conflict",
    ),
  });
  revenue.weighted[0] = {
    ...revenue.weighted[0]!,
    value: {
      ...revenue.weighted[0]!.value,
      unit: "TASK28:unit-conflict",
    },
  };
  const duplicateRevenue = cloneTask28(
    task28SentinelReport().projections!.series.find((item) => item.metric === "revenue")!,
  );
  duplicateRevenue.assumptions = ["TASK28:duplicate-series:revenue:assumption"];
  duplicateRevenue.disclosures = [{
    field: "TASK28:duplicate-series:revenue:disclosure:field",
    reason: "TASK28:duplicate-series:revenue:disclosure:reason",
    severity: "warn",
    attemptedSources: ["TASK28:duplicate-series:revenue:source"],
    expected: false,
  }];
  for (const descriptor of PROJECTION_PATHS) {
    duplicateRevenue[descriptor.key] = duplicateRevenue[descriptor.key].map((point, index) => ({
      ...point,
      value: {
        ...point.value,
        value: point.value.value + 50_000 + index,
        sourceId: `TASK28:duplicate-series:revenue:${descriptor.key}:${index}:source-id`,
        source: `TASK28:duplicate-series:revenue:${descriptor.key}:${index}:source-display`,
        verificationNote: `TASK28:duplicate-series:revenue:${descriptor.key}:${index}:note`,
      },
    }));
  }
  series.splice(series.indexOf(revenue) + 1, 0, duplicateRevenue);

  // Deliberately bypass schema alignment refinements: Task 28 renderers must
  // preserve malformed legacy/runtime arrays rather than truncate or join by
  // index. The original object still satisfies every leaf type.
  return report;
}

export function task28LegacyOptionalReport(): Report {
  const report = cloneTask28(task28SentinelReport());
  delete report.meta.dataCompleteness;
  report.appendix.verificationLog = [{
    claim: "TASK28:legacy:verification:required-only:claim",
    outcome: "unverified",
  }];
  report.meta.asOfMap = {};
  for (const source of report.appendix.sources) delete source.stale;
  report.scores!.composite.score = null;
  report.scores!.composite.band = null;
  report.scores!.aspects.fundamentals.score = null;
  report.scores!.aspects.fundamentals.band = null;
  for (const { score } of scoreAspects(report)) {
    for (const driver of score.drivers) {
      delete driver.currency;
      delete driver.period;
      delete driver.sourceId;
      delete driver.verificationNote;
    }
  }
  for (const series of report.projections!.series) {
    for (const descriptor of PROJECTION_PATHS) {
      for (const point of series[descriptor.key]) {
        delete point.value.currency;
        delete point.value.period;
        delete point.value.sourceId;
        delete point.value.verificationNote;
      }
    }
  }
  for (const executive of report.leadership.executives) {
    for (const descriptor of EXECUTIVE_EVIDENCE_GROUPS) {
      for (const claim of executive.evidence[descriptor.key] ?? []) delete claim.sourceId;
    }
  }
  return ReportSchema.parse(report);
}

export function task28LegacyMissingBlocksReport(): Report {
  const report = cloneTask28(task28SentinelReport());
  delete report.scores;
  delete report.projections;
  delete report.meta.dataCompleteness;
  delete report.appendix.verificationLog;
  report.meta.asOfMap = {};
  for (const source of report.appendix.sources) delete source.stale;
  for (const executive of report.leadership.executives) executive.evidence = {};
  return ReportSchema.parse(report);
}

export function task28MissingEpsReport(): Report {
  const report = cloneTask28(task28SentinelReport());
  const projections = report.projections!;
  projections.series = projections.series.filter((series) => series.metric !== "epsDiluted");
  const revenue = projections.series.find((series) => series.metric === "revenue")!;
  revenue.disclosures.push({
    field: "projections.eps.shareCountTrend",
    reason: "TASK28:missing-EPS:share-trend-disclosure",
    severity: "warn",
    attemptedSources: ["income-statement", "shares-float"],
    expected: false,
  });
  return ReportSchema.parse(report);
}

export function scoreAspects(report: Report): Array<{
  aspect: ScoreAspect;
  score: NonNullable<Report["scores"]>["aspects"][ScoreAspect];
}> {
  return SCORE_WEIGHTS.map(({ aspect }) => ({
    aspect,
    score: report.scores!.aspects[aspect],
  }));
}
