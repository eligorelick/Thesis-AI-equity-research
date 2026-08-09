import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it, vi } from "vitest";

import { ReportView } from "@/components/report/ReportView";
import { reportToMarkdown } from "@/report/export/markdown";
import { reportToPrintBody } from "@/report/export/printHtml";
import type { Report, TracedNumber } from "@/report/schema";
import {
  cloneTask28,
  scoreAspects,
  task28AdversarialProjectionReport,
  task28LegacyMissingBlocksReport,
  task28LegacyOptionalReport,
  task28MissingEpsReport,
  task28SentinelReport,
} from "./helpers/task28Report";

const ASPECTS = [
  "fundamentals",
  "valuation",
  "quality",
  "balanceSheet",
  "moat",
  "leadership",
  "technicals",
] as const;
const EVIDENCE_GROUPS = [
  "guidanceVsActuals",
  "capitalAllocation",
  "insiderActivity",
  "compensation",
] as const;
const EVIDENCE_LABELS = [
  "Guidance vs actuals",
  "Capital allocation",
  "Insider activity",
  "Compensation",
] as const;
const METRICS = ["revenue", "operatingMargin", "fcf", "epsDiluted"] as const;
const METRIC_LABELS = [
  "Revenue",
  "Operating margin",
  "Free cash flow (FCFF)",
  "Diluted EPS",
] as const;
const PATHS = ["historical", "bull", "base", "bear", "weighted"] as const;
const PATH_LABELS = ["Historical", "Bull", "Base", "Bear", "Weighted"] as const;

interface Surfaces {
  live: string;
  markdown: string;
  print: string;
}

function renderSurfaces(report: Report): Surfaces {
  return {
    live: renderToStaticMarkup(createElement(ReportView, { report })),
    markdown: reportToMarkdown(report),
    print: reportToPrintBody(report),
  };
}

function values(surfaces: Surfaces): string[] {
  return [surfaces.live, surfaces.markdown, surfaces.print];
}

function entries(surfaces: Surfaces): Array<[keyof Surfaces, string]> {
  return [
    ["live", surfaces.live],
    ["markdown", surfaces.markdown],
    ["print", surfaces.print],
  ];
}

function occurrenceCount(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function assertOrder(value: string, expected: readonly string[]): void {
  let cursor = -1;
  for (const sentinel of expected) {
    const next = value.indexOf(sentinel, cursor + 1);
    expect(next, sentinel).toBeGreaterThan(cursor);
    cursor = next;
  }
}

function htmlRowContaining(value: string, needle: string): string {
  const index = value.indexOf(needle);
  expect(index, needle).toBeGreaterThanOrEqual(0);
  const start = value.lastIndexOf("<tr", index);
  const end = value.indexOf("</tr>", index);
  expect(start, `${needle} row start`).toBeGreaterThanOrEqual(0);
  expect(end, `${needle} row end`).toBeGreaterThan(index);
  return value.slice(start, end + 5);
}

function markdownRowContaining(value: string, needle: string): string {
  const row = value.split(/\r?\n/).find((line) => line.startsWith("|") && line.includes(needle));
  expect(row, needle).toBeDefined();
  return row!;
}

function sectionBetween(value: string, startNeedle: string, endNeedle: string): string {
  const start = value.indexOf(startNeedle);
  expect(start, startNeedle).toBeGreaterThanOrEqual(0);
  const end = value.indexOf(endNeedle, start + startNeedle.length);
  expect(end, endNeedle).toBeGreaterThan(start);
  return value.slice(start, end);
}

function rowWithin(value: string, needle: string, markdown: boolean): string {
  return markdown
    ? markdownRowContaining(value, needle)
    : htmlRowContaining(value, needle);
}

function tableCells(row: string, markdown: boolean): string[] {
  if (markdown) {
    return row
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
  }
  return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) =>
    match[1]!.replace(/<[^>]*>/g, "").trim()
  );
}

function expectTableCell(row: string, expected: string, markdown: boolean): void {
  expect(tableCells(row, markdown), `table cell ${expected}`).toContain(expected);
}

function citationLabel(value: TracedNumber["verified"]): string {
  return value === true ? "citation-traced" : value === false ? "uncited" : "not checked";
}

function assertTracedRow(
  surfaces: Surfaces,
  trace: TracedNumber,
  rowNeedle: string,
  outerPeriod?: string,
  seriesUnit?: string,
  identityLabels: readonly string[] = [],
): void {
  for (const [surface, output] of entries(surfaces)) {
    const row = surface === "markdown"
      ? markdownRowContaining(output, rowNeedle)
      : htmlRowContaining(output, rowNeedle);
    expectTableCell(row, String(trace.value), surface === "markdown");
    expect(row).toContain(trace.unit);
    expect(row).toContain(trace.currency ?? "n/a");
    expect(row).toContain(trace.period ?? "n/a");
    expect(row).toContain(trace.sourceId ?? "n/a");
    expect(row).toContain(trace.source);
    expect(row).toContain(trace.asOf ?? "n/a");
    expect(row).toContain(citationLabel(trace.verified));
    expect(row).toContain(trace.verificationNote ?? "n/a");
    if (outerPeriod !== undefined) expect(row).toContain(outerPeriod);
    if (seriesUnit !== undefined) expect(row).toContain(seriesUnit);
    for (const label of identityLabels) expect(row).toContain(label);
  }
}

describe("Task 28 complete report surfaces", () => {
  it("pins the literal score/evidence/projection domain and every raw sentinel", () => {
    const report = task28SentinelReport();
    expect(Object.keys(report.scores!.aspects)).toEqual(ASPECTS);
    expect(Object.keys(report.scores!.composite.weights)).toEqual(ASPECTS);
    expect(Object.keys(report.leadership.executives[0]!.evidence)).toEqual(EVIDENCE_GROUPS);
    expect(report.projections!.series.map((series) => series.metric)).toEqual(METRICS);
    for (const series of report.projections!.series) {
      expect(PATHS.map((path) => series[path].length)).toEqual([2, 2, 2, 2, 2]);
    }
  });

  it("renders composite methodology, all aspect fields, independent weights, and every raw driver trace", () => {
    const report = task28SentinelReport();
    const before = JSON.stringify(report);
    const surfaces = renderSurfaces(report);

    for (const output of values(surfaces)) {
      expect(output).toContain("TASK28:composite:methodology");
      expect(output).toContain("TASK28:BANDS:VERSION");
      expect(output).toContain("Composite weights");
      expect(output).toContain("Aspect scores");
      expect(output).toContain("Score drivers");
      const scoreStart = output.includes("composite scorecard")
        ? "composite scorecard"
        : "Scorecard (deterministic)";
      const composite = sectionBetween(output, scoreStart, "Composite weights");
      const compositeRow = rowWithin(
        composite,
        "TASK28:composite:methodology",
        output === surfaces.markdown,
      );
      expectTableCell(compositeRow, "72.625", output === surfaces.markdown);
      expectTableCell(compositeRow, "B", output === surfaces.markdown);
      assertOrder(sectionBetween(output, "Composite weights", "Aspect scores"), [
        "Fundamentals",
        "Valuation",
        "Quality",
        "Balance Sheet",
        "Moat",
        "Leadership",
        "Technicals",
      ]);
      assertOrder(sectionBetween(output, "Aspect scores", "Score drivers"), [
        "Fundamentals",
        "Valuation",
        "Quality",
        "Balance Sheet",
        "Moat",
        "Leadership",
        "Technicals",
      ]);
    }

    for (const { aspect, score } of scoreAspects(report)) {
      for (const [surface, output] of entries(surfaces)) {
        const aspectRow = rowWithin(
          sectionBetween(output, "Aspect scores", "Score drivers"),
          `TASK28:${aspect}:method-note-sentinel`,
          surface === "markdown",
        );
        expectTableCell(aspectRow, String(score.score), surface === "markdown");
        expectTableCell(aspectRow, score.band!, surface === "markdown");
        expectTableCell(aspectRow, String(score.weightPct), surface === "markdown");
        expectTableCell(
          aspectRow,
          String(score.dataCompleteness),
          surface === "markdown",
        );
        expect(aspectRow).toContain(`TASK28:${aspect}:not-applicable-sentinel`);
        expect(aspectRow).toContain(`TASK28:${aspect}:method-note-sentinel`);

        const weightRow = rowWithin(
          sectionBetween(output, "Composite weights", "Aspect scores"),
          ({
            fundamentals: "Fundamentals",
            valuation: "Valuation",
            quality: "Quality",
            balanceSheet: "Balance Sheet",
            moat: "Moat",
            leadership: "Leadership",
            technicals: "Technicals",
          } as const)[aspect],
          surface === "markdown",
        );
        expectTableCell(
          weightRow,
          String(report.scores!.composite.weights[aspect]),
          surface === "markdown",
        );
      }
      expect(score.drivers.length, aspect).toBeGreaterThanOrEqual(2);
      for (const driver of score.drivers) {
        assertTracedRow(
          surfaces,
          driver,
          driver.verificationNote?.includes("duplicate-identity-note")
            ? driver.verificationNote
            : driver.source,
        );
      }
    }
    for (const output of values(surfaces)) {
      expect(occurrenceCount(output, "TASK28:fundamentals:driver:0:source-display")).toBe(2);
      expect(occurrenceCount(output, "TASK28:fundamentals:driver:duplicate-identity-note")).toBe(1);
    }
    expect(JSON.stringify(report)).toBe(before);
  });

  it("renders all four optional executive evidence groups with distinct source identities", () => {
    const report = task28SentinelReport();
    const before = JSON.stringify(report);
    const surfaces = renderSurfaces(report);
    for (const output of values(surfaces)) {
      const firstExecutive = report.leadership.executives[0]!;
      const secondExecutive = report.leadership.executives[1]!;
      const firstScope = sectionBetween(output, firstExecutive.name, secondExecutive.name);
      const secondStart = output.indexOf(secondExecutive.name);
      const leadershipInsiderClaim = report.leadership.insiderSummary[0]!.text;
      const leadershipInsiderClaimStart = output.indexOf(leadershipInsiderClaim, secondStart);
      const secondEnd = output.lastIndexOf("Insider activity", leadershipInsiderClaimStart);
      expect(secondStart).toBeGreaterThanOrEqual(0);
      expect(leadershipInsiderClaimStart).toBeGreaterThan(secondStart);
      expect(secondEnd).toBeGreaterThan(secondStart);
      const secondScope = output.slice(secondStart, secondEnd);
      for (const [index, group] of EVIDENCE_GROUPS.entries()) {
        const claim = firstExecutive.evidence[group]![0]!;
        expect(occurrenceCount(output, claim.text)).toBe(1);
        expect(occurrenceCount(firstScope, EVIDENCE_LABELS[index]!)).toBe(1);
        expect(firstScope).toContain(claim.text);
        expect(firstScope).toContain(claim.label);
        expect(firstScope).toContain(claim.sourceId!);
        expect(firstScope).toContain(claim.source);
        expect(firstScope).toContain(claim.asOf ?? "n/a");
        expect(secondScope).not.toContain(claim.text);
      }
      const secondClaim = report.leadership.executives[1]!.evidence.compensation![0]!;
      expect(occurrenceCount(output, secondClaim.text)).toBe(1);
      expect(secondScope).toContain(secondClaim.text);
      expect(secondScope).toContain(secondClaim.label);
      expect(secondScope).toContain(secondClaim.sourceId!);
      expect(secondScope).toContain(secondClaim.source);
      expect(secondScope).toContain(secondClaim.asOf!);
      expect(occurrenceCount(secondScope, "Compensation")).toBe(1);
      for (const absentLabel of EVIDENCE_LABELS.slice(0, 3)) {
        expect(secondScope).not.toContain(absentLabel);
      }
    }
    expect(JSON.stringify(report)).toBe(before);
  });

  it("renders all 4 metrics x 5 paths as raw provenance rows plus every root and series field", () => {
    const report = task28SentinelReport();
    const before = JSON.stringify(report);
    const surfaces = renderSurfaces(report);
    const projections = report.projections!;

    for (const [surface, output] of entries(surfaces)) {
      expect(output).toContain("unbacktested display prior");
      expect(output).toContain("Projection audit trail");
      const projectionAudit = sectionBetween(output, "Projection audit trail", "Macro");
      expectTableCell(
        rowWithin(projectionAudit, "Horizon years", surface === "markdown"),
        String(projections.horizonYears),
        surface === "markdown",
      );
      expectTableCell(
        rowWithin(projectionAudit, "Weights version", surface === "markdown"),
        projections.weightsVersion,
        surface === "markdown",
      );
      expectTableCell(
        rowWithin(projectionAudit, "Not applicable reason", surface === "markdown"),
        projections.notApplicableReason!,
        surface === "markdown",
      );
      for (const [weightKey, weightLabel] of [
        ["bull", "Bull scenario weight"],
        ["base", "Base scenario weight"],
        ["bear", "Bear scenario weight"],
      ] as const) {
        expectTableCell(
          rowWithin(projectionAudit, weightLabel, surface === "markdown"),
          String(projections.scenarioWeights[weightKey]),
          surface === "markdown",
        );
      }
      assertOrder(projectionAudit, METRIC_LABELS);
    }

    for (const [metricIndex, metric] of METRICS.entries()) {
      const series = projections.series.find((candidate) => candidate.metric === metric)!;
      for (const [surface, output] of entries(surfaces)) {
        const projectionAudit = sectionBetween(output, "Projection audit trail", "Macro");
        const metricStart = projectionAudit.indexOf(METRIC_LABELS[metricIndex]!);
        const nextMetric = METRIC_LABELS[metricIndex + 1];
        const metricEnd = nextMetric === undefined
          ? projectionAudit.length
          : projectionAudit.indexOf(nextMetric, metricStart + METRIC_LABELS[metricIndex]!.length);
        expect(metricStart).toBeGreaterThanOrEqual(0);
        expect(metricEnd).toBeGreaterThan(metricStart);
        const metricScope = projectionAudit.slice(metricStart, metricEnd);
        assertOrder(metricScope, PATH_LABELS);
        for (const pathLabel of PATH_LABELS) {
          expect(occurrenceCount(metricScope, pathLabel), pathLabel).toBe(2);
        }
        for (const assumption of series.assumptions) expect(metricScope).toContain(assumption);
        const disclosure = series.disclosures[0]!;
        const disclosureRow = rowWithin(metricScope, disclosure.field, surface === "markdown");
        expect(disclosureRow).toContain(disclosure.reason);
        expect(disclosureRow).toContain(disclosure.severity);
        for (const source of disclosure.attemptedSources ?? []) expect(disclosureRow).toContain(source);
        expect(disclosureRow).toContain(
          disclosure.expected === undefined ? "unknown" : disclosure.expected ? "yes" : "no",
        );
      }
      for (const path of PATHS) {
        for (const point of series[path]) {
          assertTracedRow(
            surfaces,
            point.value,
            point.value.source,
            point.period,
            series.unit,
            [METRIC_LABELS[metricIndex]!, PATH_LABELS[PATHS.indexOf(path)]!],
          );
        }
      }
      expect(metricIndex).toBeLessThan(METRICS.length);
    }
    expect(JSON.stringify(report)).toBe(before);
  });

  it("renders full source, manifest, verification-log, and as-of-map leaves verbatim", () => {
    const report = task28SentinelReport();
    const before = JSON.stringify(report);
    const surfaces = renderSurfaces(report);

    for (const [surface, output] of entries(surfaces)) {
      for (const source of report.appendix.sources) {
        const row = rowWithin(output, source.provider, surface === "markdown");
        expect(row).toContain(source.provider);
        expect(row).toContain(source.endpoint);
        expect(row).toContain(source.asOf);
        expect(row).toContain(source.fetchedAt);
        expect(row).toContain(source.stale === undefined ? "unknown" : source.stale ? "yes" : "no");
      }
      for (const gap of report.appendix.missingData) {
        const row = rowWithin(output, gap.field, surface === "markdown");
        expect(row).toContain(gap.field);
        expect(row).toContain(gap.severity);
        expect(row).toContain(gap.reason);
        for (const attempted of gap.attemptedSources ?? []) expect(row).toContain(attempted);
        expect(row).toContain(gap.expected === undefined ? "unknown" : gap.expected ? "yes" : "no");
      }
      for (const [field, asOf] of Object.entries(report.meta.asOfMap)) {
        const row = rowWithin(output, field, surface === "markdown");
        expect(row).toContain(asOf);
      }
      for (const log of report.appendix.verificationLog ?? []) {
        const renderedClaim = surface === "markdown"
          ? log.claim.replace(/[\[\]]/g, "\\$&")
          : log.claim;
        const row = rowWithin(output, renderedClaim, surface === "markdown");
        expect(row).toContain(renderedClaim);
        expect(row).toContain(log.outcome === "verified" ? "cited" : log.outcome === "unverified" ? "uncited" : "removed");
        expect(row).toContain(log.note!);
        expect(row).toContain(log.path!);
        expect(row).toContain(log.evidenceKind!);
        expect(row).toContain(log.source!);
        expect(row).toContain(log.reason!);
        expect(row).toContain(log.traceKind!);
      }
    }
    expect(JSON.stringify(report)).toBe(before);
  });

  it("preserves reordered, uneven, duplicate, and conflicted raw projection rows without mutation", () => {
    const report = task28AdversarialProjectionReport();
    const before = JSON.stringify(report);
    const reactErrors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      reactErrors.push(args.map(String).join(" "));
    });
    let surfaces: Surfaces;
    try {
      surfaces = renderSurfaces(report);
    } finally {
      errorSpy.mockRestore();
    }
    expect(reactErrors.join("\n")).not.toMatch(/unique ["']key["']|same key/i);

    for (const output of values(surfaces)) {
      assertOrder(output, [
        "TASK28:revenue:historical:1:source-display",
        "TASK28:operatingMargin:historical:1:source-display",
        "TASK28:fcf:historical:1:source-display",
        "TASK28:epsDiluted:historical:1:source-display",
      ]);
      assertOrder(output, [
        "TASK28:revenue:bull:1:source-display",
        "TASK28:duplicate:source-display",
        "TASK28:revenue:bull:0:source-display",
      ]);
      expect(output).toContain("TASK28:uneven:bear:extra:source-display");
      expect(output).toContain("TASK28:uneven:bear:inner-period-conflict");
      expect(output).toContain("TASK28:unit-conflict");
      expect(output).toContain("TASK28:duplicate-series:revenue:assumption");
      expect(output).toContain("TASK28:duplicate-series:revenue:disclosure:field");
    }
    const duplicateSeries = report.projections!.series.find((series) =>
      series.assumptions.includes("TASK28:duplicate-series:revenue:assumption"))!;
    expect(PATHS.map((path) => duplicateSeries[path].length)).toEqual([2, 2, 2, 2, 2]);
    for (const path of PATHS) {
      for (const point of duplicateSeries[path]) {
        assertTracedRow(
          surfaces,
          point.value,
          point.value.source,
          point.period,
          duplicateSeries.unit,
          ["Revenue", PATH_LABELS[PATHS.indexOf(path)]!],
        );
        for (const output of values(surfaces)) {
          expect(occurrenceCount(output, point.value.source)).toBe(1);
        }
      }
      for (const output of values(surfaces)) {
        assertOrder(output, duplicateSeries[path].map((point) => point.value.source));
      }
    }
    expect(JSON.stringify(report)).toBe(before);
  });

  it("keeps absent EPS absent and renders the Task 13 share-trend disclosure once", () => {
    const report = task28MissingEpsReport();
    const before = JSON.stringify(report);
    const surfaces = renderSurfaces(report);
    expect(report.projections!.series.map((series) => series.metric)).toEqual([
      "revenue",
      "operatingMargin",
      "fcf",
    ]);
    for (const output of values(surfaces)) {
      const projectionAudit = sectionBetween(output, "Projection audit trail", "Macro");
      expect(occurrenceCount(output, "projections.eps.shareCountTrend")).toBe(1);
      expect(output).toContain("TASK28:missing-EPS:share-trend-disclosure");
      expect(projectionAudit).not.toContain("TASK28:epsDiluted:historical:0:source-display");
      expect(projectionAudit).not.toContain("Diluted EPS");
    }
    expect(JSON.stringify(report)).toBe(before);
  });

  it("renders every projection root field when a present projection block has no series", () => {
    const report = task28SentinelReport();
    report.projections!.series = [];
    report.projections!.notApplicableReason = "TASK28:empty-series:not-applicable";
    const before = JSON.stringify(report);
    const surfaces = renderSurfaces(report);

    for (const [surface, output] of entries(surfaces)) {
      const audit = sectionBetween(output, "Projection audit trail", "Macro");
      for (const [label, expected] of [
        ["Horizon years", String(report.projections!.horizonYears)],
        ["Bull scenario weight", String(report.projections!.scenarioWeights.bull)],
        ["Base scenario weight", String(report.projections!.scenarioWeights.base)],
        ["Bear scenario weight", String(report.projections!.scenarioWeights.bear)],
        ["Weights version", report.projections!.weightsVersion],
        ["Series", "0"],
        ["Not applicable reason", "TASK28:empty-series:not-applicable"],
      ] as const) {
        expectTableCell(
          rowWithin(audit, label, surface === "markdown"),
          expected,
          surface === "markdown",
        );
      }
      for (const metricLabel of METRIC_LABELS) expect(audit).not.toContain(metricLabel);
    }
    expect(JSON.stringify(report)).toBe(before);
  });

  it("does not fabricate nested optional provenance for legacy traces and claims", () => {
    const report = task28LegacyOptionalReport();
    const before = JSON.stringify(report);
    const surfaces = renderSurfaces(report);
    const driver = report.scores!.aspects.fundamentals.drivers[0]!;
    const point = report.projections!.series.find((series) => series.metric === "revenue")!.historical[0]!;
    const claim = report.leadership.executives[0]!.evidence.guidanceVsActuals![0]!;
    for (const [surface, output] of entries(surfaces)) {
      const driverRow = rowWithin(output, driver.source, surface === "markdown");
      expect(driverRow).toContain(driver.source);
      expect(occurrenceCount(driverRow, "n/a")).toBeGreaterThanOrEqual(5);
      const pointRow = rowWithin(output, point.value.source, surface === "markdown");
      expect(pointRow).toContain(point.value.source);
      expect(occurrenceCount(pointRow, "n/a")).toBeGreaterThanOrEqual(4);
      const claimStart = output.indexOf(claim.text);
      expect(claimStart).toBeGreaterThanOrEqual(0);
      const claimEnd = output.indexOf("Capital allocation", claimStart);
      expect(claimEnd).toBeGreaterThan(claimStart);
      const claimScope = output.slice(claimStart, claimEnd);
      expect(claimScope).toContain(claim.source);
      expect(claimScope).toContain("n/a");
      const scoreStart = output.includes("composite scorecard")
        ? "composite scorecard"
        : "Scorecard (deterministic)";
      const composite = sectionBetween(output, scoreStart, "Composite weights");
      const compositeRow = rowWithin(
        composite,
        "TASK28:composite:methodology",
        surface === "markdown",
      );
      expect(tableCells(compositeRow, surface === "markdown").filter((cell) => cell === "n/a"))
        .toHaveLength(2);
      const fundamentalsRow = rowWithin(
        sectionBetween(output, "Aspect scores", "Score drivers"),
        "TASK28:fundamentals:method-note-sentinel",
        surface === "markdown",
      );
      expect(tableCells(fundamentalsRow, surface === "markdown").filter((cell) => cell === "n/a"))
        .toHaveLength(2);
      const legacyLog = report.appendix.verificationLog![0]!;
      const logRow = rowWithin(output, legacyLog.claim, surface === "markdown");
      expect(logRow).toContain("uncited");
      expect(tableCells(logRow, surface === "markdown").filter((cell) => cell === "n/a").length)
        .toBeGreaterThanOrEqual(6);
      expect(output).not.toContain("undefined");
    }
    expect(JSON.stringify(report)).toBe(before);
  });

  it("keeps legacy optional score, projection, evidence, and completeness blocks absent", () => {
    const report = task28LegacyMissingBlocksReport();
    const before = cloneTask28(report);
    const surfaces = renderSurfaces(report);
    for (const output of values(surfaces)) {
      expect(output).not.toContain("Composite weights");
      expect(output).not.toContain("Projection audit trail");
      expect(output).not.toContain("TASK28:evidence:");
      expect(output).not.toContain("undefined");
    }
    expect(report).toEqual(before);
  });

  it("escapes a newly exposed unsafe leaf in JSX and print while using Markdown table boundaries", () => {
    const report = task28SentinelReport();
    const poisons = {
      driver: '<script data-task28="driver">alert(28)</script> | driver',
      evidence: '<script data-task28="evidence">alert(28)</script> | evidence',
      assumption: '<script data-task28="assumption">alert(28)</script> | assumption',
      disclosure: '<script data-task28="disclosure">alert(28)</script> | disclosure',
      source: '<script data-task28="source">alert(28)</script> | source',
      log: '<script data-task28="log">alert(28)</script> | log',
      asOfMap: '<script data-task28="asof">alert(28)</script> | asof',
    };
    report.scores!.aspects.fundamentals.drivers[0]!.source = poisons.driver;
    report.leadership.executives[0]!.evidence.guidanceVsActuals![0]!.text = poisons.evidence;
    report.projections!.series[0]!.assumptions[0] = poisons.assumption;
    report.projections!.series[0]!.disclosures[0]!.reason = poisons.disclosure;
    report.appendix.sources[0]!.endpoint = poisons.source;
    report.appendix.verificationLog![0]!.note = poisons.log;
    report.meta.asOfMap = { [poisons.asOfMap]: "2026-08-08T01:02:03.456Z" };
    const before = JSON.stringify(report);
    const surfaces = renderSurfaces(report);
    for (const poison of Object.values(poisons)) {
      const escaped = poison
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      expect(surfaces.live).toContain(escaped);
      expect(surfaces.live).not.toContain(poison);
      expect(surfaces.print).toContain(escaped);
      expect(surfaces.print).not.toContain(poison);
    }
    for (const expected of [
      String.raw`\<script data-task28="driver"\>alert(28)\</script\> \| driver`,
      String.raw`\<script data-task28="disclosure"\>alert(28)\</script\> \| disclosure`,
      String.raw`\<script data-task28="source"\>alert(28)\</script\> \| source`,
      String.raw`\<script data-task28="log"\>alert(28)\</script\> \| log`,
      String.raw`\<script data-task28="asof"\>alert(28)\</script\> \| asof`,
    ]) {
      expect(surfaces.markdown).toContain(expected);
    }
    expect(JSON.stringify(report)).toBe(before);
  });
});
