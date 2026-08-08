import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import { ProjectionFanChart } from "@/components/charts/ProjectionFanChart";
import { ReportView } from "@/components/report/ReportView";
import {
  CompositeScorecard,
  GradeStripBar,
  LeadershipSection,
  ProjectionsSection,
} from "@/components/report/sections";
import { ScorePill } from "@/components/ui";

import {
  formatCostUsd,
  formatFinancialValue,
  formatVerificationClaim,
  roundedDisplayedCostTotal,
} from "@/report/format";
import { ReportSchema, type ProjectionSeries, type Report } from "@/report/schema";

type ElementProps = Record<string, unknown> & { children?: ReactNode };

function elementsWithin(node: ReactNode): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(elementsWithin);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<ElementProps>;
  return [element, ...elementsWithin(element.props.children)];
}

function fixtureReport(): Report {
  return ReportSchema.parse(
    JSON.parse(
      readFileSync(
        path.join(process.cwd(), "fixtures", "report", "DEMO-sample.json"),
        "utf8",
      ),
    ),
  );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("shared report formatting", () => {
  it.each([
    [60_958_000_000, "USD", "$60.96B"],
    [3_450_000_000, "currency", "$3.45B"],
    [274.125, "USD/share", "$274.13"],
    [18.234, "%", "18.2%"],
    [1.82, "x", "1.8×"],
  ])("formats %s %s as %s", (value, unit, expected) => {
    expect(formatFinancialValue(value as number, unit as string)).toBe(expected);
  });

  it("makes displayed step costs add exactly to the displayed total", () => {
    const rows = [0.1111114, 0.2222226, 0.3333337];
    expect(rows.map(formatCostUsd)).toEqual(["$0.111111", "$0.222223", "$0.333334"]);
    expect(formatCostUsd(roundedDisplayedCostTotal(rows))).toBe("$0.666668");
  });

  it("formats legacy verification claims without raw USD or duplicate dates", () => {
    expect(formatVerificationClaim(
      "60958000000 USD [payload.segments.product · 2025-12-31 · 2025-12-31]",
    )).toBe("$60.96B [payload.segments.product · 2025-12-31]");
  });
});

describe("manifest-driven real report consumers", () => {
  it("renders all seven grade surfaces once in canonical order through sections and ReportView", () => {
    const report = fixtureReport();
    const strip = renderToStaticMarkup(
      createElement(GradeStripBar, { gradeStrip: report.verdict.gradeStrip }),
    );
    const labels = [
      "Fundamentals",
      "Valuation",
      "Technicals",
      "Balance Sheet",
      "Quality / Red-Flags",
      "Leadership",
      "Moat",
    ];
    let cursor = -1;
    for (const label of labels) {
      const next = strip.indexOf(`>${label}<`);
      expect(next, label).toBeGreaterThan(cursor);
      expect(strip.match(new RegExp(`>${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}<`, "g"))).toHaveLength(1);
      cursor = next;
    }
    expect(strip).toContain("grid-cols-7");

    const full = renderToStaticMarkup(createElement(ReportView, { report }));
    expect(full).toContain(report.verdict.gradeStrip.balanceSheet!.oneLineWhy);
    expect(full).toContain("Balance Sheet &amp; Capital");
  });

  it("omits only the optional balance grade for a legacy report without fabricating a chip", () => {
    const report = fixtureReport();
    delete report.verdict.gradeStrip.balanceSheet;
    const strip = renderToStaticMarkup(
      createElement(GradeStripBar, { gradeStrip: report.verdict.gradeStrip }),
    );
    expect(strip).not.toContain(">Balance Sheet<");
    for (const label of ["Fundamentals", "Valuation", "Technicals", "Quality / Red-Flags", "Leadership", "Moat"]) {
      expect(strip).toContain(`>${label}<`);
    }
  });

  it("passes composite plus all seven aspect score sentinels through the real scorecard in canonical order", () => {
    const report = fixtureReport();
    const scores = clone(report.scores!);
    scores.composite.score = 63.75;
    const aspectOrder = [
      "fundamentals",
      "valuation",
      "quality",
      "balanceSheet",
      "moat",
      "leadership",
      "technicals",
    ] as const;
    const expected = [
      ["Fundamentals", 0],
      ["Valuation", 11.25],
      ["Quality", 22.5],
      ["Balance Sheet", 33.75],
      ["Moat", 44.125],
      ["Leadership", 55.5],
      ["Technicals", 66.875],
    ] as const;
    expected.forEach(([, score], index) => {
      scores.aspects[aspectOrder[index]!].score = score;
    });
    const expectedBytes = JSON.stringify(scores);

    const tree = CompositeScorecard({ scores });
    const scorePills = elementsWithin(tree).filter((element) => element.type === ScorePill);
    expect(scorePills.map((element) => element.props.score)).toEqual(expected.map(([, score]) => score));
    expect(scorePills.map((element) => element.props.score)).toContain(0);
    expect(scorePills.map((element) => element.props.score)).toContain(44.125);

    const html = renderToStaticMarkup(tree);
    expect(html).toContain(">64<");
    let cursor = -1;
    for (const [label] of expected) {
      const next = html.indexOf(`>${label}<`);
      expect(next, label).toBeGreaterThan(cursor);
      cursor = next;
    }
    expect(JSON.stringify(scores)).toBe(expectedBytes);
  });

  it("orders actual projection cards by metric without dropping a real series", () => {
    const report = fixtureReport();
    const reversed = clone(report.projections!);
    const revenueA = clone(reversed.series.find((series) => series.metric === "revenue")!);
    revenueA.unit = "revenue-a";
    const revenueB = clone(revenueA);
    revenueB.unit = "revenue-b-duplicate";
    const operatingMargin = clone(reversed.series.find((series) => series.metric === "operatingMargin")!);
    const fcf = clone(reversed.series.find((series) => series.metric === "fcf")!);
    const eps = clone(reversed.series.find((series) => series.metric === "epsDiluted")!);
    reversed.series = [eps, revenueA, fcf, revenueB, operatingMargin];
    const reversedBytes = JSON.stringify(reversed);
    const tree = ProjectionsSection({ projections: reversed, index: 12 });
    expect(JSON.stringify(reversed)).toBe(reversedBytes);
    const renderedSeries = elementsWithin(tree)
      .map((element) => element.props.series)
      .filter((series): series is ProjectionSeries =>
        typeof series === "object" && series !== null && "metric" in series,
      );
    expect(renderedSeries.map((series) => `${series.metric}:${series.unit}`)).toEqual([
      "revenue:revenue-a",
      "revenue:revenue-b-duplicate",
      `operatingMargin:${operatingMargin.unit}`,
      `fcf:${fcf.unit}`,
      `epsDiluted:${eps.unit}`,
    ]);
    expect(renderedSeries).toHaveLength(reversed.series.length);

    const labels = reversed.series.map((series) => {
      const html = renderToStaticMarkup(ProjectionFanChart({ series }));
      return [series.metric, html] as const;
    });
    for (const [metric, html] of labels) {
      expect(html, metric).toContain({
        revenue: "Revenue",
        operatingMargin: "Operating margin",
        fcf: "Free cash flow (FCFF)",
        epsDiluted: "Diluted EPS",
      }[metric]);
    }

    const withoutEps = clone(reversed);
    withoutEps.series = withoutEps.series.filter((series) => series.metric !== "epsDiluted");
    const legacyTree = ProjectionsSection({ projections: withoutEps, index: 12 });
    const legacyMetrics = elementsWithin(legacyTree)
      .map((element) => element.props.series)
      .filter((series): series is ProjectionSeries =>
        typeof series === "object" && series !== null && "metric" in series,
      )
      .map((series) => series.metric);
    expect(legacyMetrics).toEqual(["revenue", "revenue", "operatingMargin", "fcf"]);
  });

  it("joins ProjectionFanChart paths by period across reorders and rolling horizons", () => {
    const report = fixtureReport();
    const series = clone(
      report.projections!.series.find((candidate) => candidate.metric === "revenue")!,
    );
    const forwardPaths = ["bull", "base", "bear", "weighted"] as const;
    const expectedByPath = Object.fromEntries(forwardPaths.map((path, pathIndex) => {
      const byPeriod = new Map<string, number>();
      series[path].forEach((point, pointIndex) => {
        point.value.value = (pathIndex + 1) * 10_000 + pointIndex + 1;
        byPeriod.set(point.period, point.value.value);
      });
      series[path].reverse();
      return [path, byPeriod];
    })) as Record<(typeof forwardPaths)[number], Map<string, number>>;
    series.historical.reverse();
    const extra = clone(series.weighted.at(-1)!);
    extra.period = "FY2099";
    extra.value.period = "FY2099";
    extra.value.value = 2_099;
    series.weighted.push(extra);
    const seriesBytes = JSON.stringify(series);

    const tree = ProjectionFanChart({ series });
    expect(JSON.stringify(series)).toBe(seriesBytes);
    const chart = elementsWithin(tree).find((element) => Array.isArray(element.props.data));
    expect(chart).toBeDefined();
    const rows = chart!.props.data as Array<Record<string, number | string | null>>;
    for (const path of forwardPaths) {
      for (const [period, value] of expectedByPath[path]) {
        expect(rows.find((row) => row.period === period)?.[path], `${path}:${period}`).toBe(value);
      }
    }
    expect(rows.find((row) => row.period === "FY2099")).toMatchObject({
      period: "FY2099",
      weighted: 2_099,
      bull: null,
      base: null,
      bear: null,
    });
    expect(rows.filter((row) => row.hist !== null).map((row) => row.period)).toEqual(
      [...series.historical].map((point) => point.period).sort(),
    );
    const latestHistorical = [...series.historical]
      .sort((left, right) => left.period < right.period ? -1 : left.period > right.period ? 1 : 0)
      .at(-1)!;
    expect(rows.find((row) => row.period === latestHistorical.period)).toMatchObject({
      hist: latestHistorical.value.value,
      bull: latestHistorical.value.value,
      base: latestHistorical.value.value,
      bear: latestHistorical.value.value,
      weighted: latestHistorical.value.value,
      band: [latestHistorical.value.value, latestHistorical.value.value],
    });
    const firstForward = [...expectedByPath.base.keys()].sort()[0]!;
    expect(elementsWithin(tree).some((element) => element.props.x === firstForward)).toBe(true);
  });

  it("renders historical-only and forward-only projection series without fabricating the other side", () => {
    const report = fixtureReport();
    const source = clone(
      report.projections!.series.find((candidate) => candidate.metric === "revenue")!,
    );
    const historicalOnly = clone(source);
    historicalOnly.bull = [];
    historicalOnly.base = [];
    historicalOnly.bear = [];
    historicalOnly.weighted = [];
    const historicalTree = ProjectionFanChart({ series: historicalOnly });
    const historicalRows = elementsWithin(historicalTree)
      .find((element) => Array.isArray(element.props.data))!.props.data as Array<Record<string, unknown>>;
    expect(historicalRows.map((row) => row.period)).toEqual(
      [...source.historical].map((point) => point.period).sort(),
    );
    expect(historicalRows.every((row) => row.hist !== null)).toBe(true);
    expect(historicalRows.every((row) => row.bull === null && row.base === null
      && row.bear === null && row.weighted === null)).toBe(true);

    const forwardOnly = clone(source);
    forwardOnly.historical = [];
    const forwardTree = ProjectionFanChart({ series: forwardOnly });
    const forwardRows = elementsWithin(forwardTree)
      .find((element) => Array.isArray(element.props.data))!.props.data as Array<Record<string, unknown>>;
    expect(forwardRows.length).toBeGreaterThan(0);
    expect(forwardRows.every((row) => row.hist === null)).toBe(true);
    expect(forwardRows.some((row) => row.base !== null)).toBe(true);
  });

  it("preserves overlapping forward values and never bridges an earlier horizon from later history", () => {
    const report = fixtureReport();
    const source = clone(
      report.projections!.series.find((candidate) => candidate.metric === "revenue")!,
    );
    const latestHistoricalPeriod = [...source.historical]
      .map((point) => point.period)
      .sort()
      .at(-1)!;
    const sentinels = { bull: 91_001, base: 91_002, bear: 91_003, weighted: 91_004 } as const;
    for (const path of ["bull", "base", "bear", "weighted"] as const) {
      const overlap = clone(source[path][0]!);
      overlap.period = latestHistoricalPeriod;
      overlap.value.period = latestHistoricalPeriod;
      overlap.value.value = sentinels[path];
      source[path].push(overlap);
    }
    const overlapTree = ProjectionFanChart({ series: source });
    const overlapRows = elementsWithin(overlapTree)
      .find((element) => Array.isArray(element.props.data))!.props.data as Array<Record<string, unknown>>;
    expect(overlapRows.find((row) => row.period === latestHistoricalPeriod)).toMatchObject(sentinels);

    const earlier = clone(source);
    for (const path of ["bull", "base", "bear", "weighted"] as const) {
      earlier[path].forEach((point, index) => {
        point.period = `FY19${String(index).padStart(2, "0")}`;
        point.value.period = point.period;
      });
    }
    const earlierTree = ProjectionFanChart({ series: earlier });
    const earlierRows = elementsWithin(earlierTree)
      .find((element) => Array.isArray(element.props.data))!.props.data as Array<Record<string, unknown>>;
    expect(earlierRows.find((row) => row.period === latestHistoricalPeriod)).toMatchObject({
      bull: null,
      base: null,
      bear: null,
      weighted: null,
    });
  });

  it("renders duplicate or inner-period-conflicted projection points as unavailable instead of selecting one", () => {
    const report = fixtureReport();
    const series = clone(
      report.projections!.series.find((candidate) => candidate.metric === "revenue")!,
    );
    const ambiguousPeriod = series.bull[0]!.period;
    const duplicate = clone(series.bull[0]!);
    duplicate.value.value = 999_001;
    series.bull.push(duplicate);
    const conflictedPeriod = series.base[1]!.period;
    series.base[1]!.value.period = "FY1900";
    const unitConflictPeriod = series.weighted[2]!.period;
    series.weighted[2]!.value.unit = "shares";
    const seriesBytes = JSON.stringify(series);

    const tree = ProjectionFanChart({ series });
    expect(JSON.stringify(series)).toBe(seriesBytes);
    const chart = elementsWithin(tree).find((element) => Array.isArray(element.props.data));
    const rows = chart!.props.data as Array<Record<string, unknown>>;
    expect(rows.find((row) => row.period === ambiguousPeriod)?.bull).toBeNull();
    expect(rows.find((row) => row.period === ambiguousPeriod)?.band).toBeNull();
    expect(rows.find((row) => row.period === conflictedPeriod)?.base).toBeNull();
    expect(rows.find((row) => row.period === unitConflictPeriod)?.weighted).toBeNull();
    expect(rows.some((row) => row.period === "FY1900")).toBe(false);
    expect(rows.flatMap((row) => Object.values(row))).not.toContain(999_001);
  });

  it("renders every executive evidence group for multiple executives in manifest order", () => {
    const report = fixtureReport();
    const first = clone(report.leadership.executives[0]!);
    first.name = "Executive One";
    first.evidence = {
      guidanceVsActuals: [{ text: "GUIDANCE_SENTINEL", label: "FACT", source: "guidance", asOf: null }],
      capitalAllocation: [{ text: "CAPITAL_SENTINEL", label: "FACT", source: "capital", asOf: null }],
      insiderActivity: [{ text: "INSIDER_SENTINEL", label: "FACT", source: "insider", asOf: null }],
      compensation: [{ text: "COMPENSATION_SENTINEL", label: "FACT", source: "comp", asOf: null }],
    };
    const second = clone(first);
    second.name = "Executive Two";
    second.evidence = {
      compensation: [{ text: "SECOND_COMP_SENTINEL", label: "FACT", source: "second-comp", asOf: null }],
    };
    report.leadership.executives = [first, second];
    const html = renderToStaticMarkup(
      createElement(LeadershipSection, { leadership: report.leadership, index: 8 }),
    );
    const firstStart = html.indexOf("Executive One");
    const secondStart = html.indexOf("Executive Two");
    const firstCard = html.slice(firstStart, secondStart);
    const secondCard = html.slice(secondStart, html.indexOf(">insider activity<", secondStart));
    let cursor = -1;
    for (const token of [
      "guidance vs actuals", "GUIDANCE_SENTINEL",
      "capital allocation", "CAPITAL_SENTINEL",
      "insider activity", "INSIDER_SENTINEL",
      "compensation", "COMPENSATION_SENTINEL",
    ]) {
      const next = firstCard.indexOf(token);
      expect(next, token).toBeGreaterThan(cursor);
      cursor = next;
    }
    expect(secondCard).toContain(">compensation<");
    expect(secondCard).toContain("SECOND_COMP_SENTINEL");
    expect(secondCard).not.toContain(">guidance vs actuals<");
    expect(secondCard).not.toContain(">capital allocation<");
    expect(secondCard).not.toContain(">insider activity<");
    for (const sentinel of [
      "GUIDANCE_SENTINEL",
      "CAPITAL_SENTINEL",
      "INSIDER_SENTINEL",
      "COMPENSATION_SENTINEL",
    ]) {
      expect(html.match(new RegExp(sentinel, "g"))).toHaveLength(1);
    }
  });

  it("routes every audited consumer through the client/server-safe surface manifest", () => {
    const consumers = [
      "src/components/report/sections.tsx",
      "src/components/charts/ProjectionFanChart.tsx",
      "src/report/export/markdown.ts",
      "src/report/export/printHtml.ts",
      "src/report/history.ts",
      "src/app/company/[symbol]/history/page.tsx",
      "src/report/diff.ts",
      "src/app/company/[symbol]/history/diff/diff-body.tsx",
      "src/watchlist/watchlist.ts",
      "src/components/watchlist/Sidebar.tsx",
      "src/app/page.tsx",
      "src/app/api/report/view/[reportId]/route.ts",
      "src/app/company/[symbol]/GenerateReport.tsx",
      "src/pipeline/stageC/payload.ts",
      "src/pipeline/stageC/index.ts",
    ];
    for (const consumer of consumers) {
      const source = readFileSync(path.join(process.cwd(), consumer), "utf8");
      expect(source, consumer).toContain("@/report/surfaceManifest");
    }

    const forbiddenLocals: Record<string, RegExp[]> = {
      "src/components/report/sections.tsx": [
        /\b(?:export\s+)?const\s+(?:GRADE_STRIP_KEYS|GRADE_TO_SECTION|SCORE_ASPECTS|evidenceGroups)\b/,
      ],
      "src/components/charts/ProjectionFanChart.tsx": [
        /\bconst\s+METRIC_LABEL\b/,
        /rows\.push\(\{\s*label:\s*"(?:actual|bull|base|bear|weighted)"/,
      ],
      "src/report/export/markdown.ts": [
        /\bconst\s+(?:SCORE_ROWS|PROJECTION_METRIC_LABEL|stripRows)\b/,
        /\["Period",\s*"Bull",\s*"Base",\s*(?:"Weighted",\s*"Bear"|"Bear",\s*"Weighted")\]/,
      ],
      "src/report/export/printHtml.ts": [
        /\bconst\s+(?:SCORE_ROWS|PROJECTION_METRIC_LABEL|stripRows)\b/,
        /\["Period",\s*"Bull",\s*"Base",\s*(?:"Weighted",\s*"Bear"|"Bear",\s*"Weighted")\]/,
      ],
      "src/report/history.ts": [/\bexport\s+const\s+GRADE_STRIP_KEYS\b/],
      "src/app/company/[symbol]/history/page.tsx": [/fund\/val\/tech\/qual\/lead\/moat/],
      "src/report/diff.ts": [
        /\bconst\s+(?:GRADE_SECTIONS|SCORE_KEYS|ASPECT_KEYS|PROJECTION_PATHS)\b/,
      ],
      "src/app/company/[symbol]/history/diff/diff-body.tsx": [
        /\bconst\s+(?:SECTION_LABELS|METRIC_LABELS)\b/,
      ],
      "src/watchlist/watchlist.ts": [/return\s*\{\s*fundamentals:\s*strip\.fundamentals/s],
      "src/components/watchlist/Sidebar.tsx": [/\bconst\s+GRADE_ORDER\b/],
      "src/app/page.tsx": [/\bconst\s+HOME_GRADE_ORDER\b/],
      "src/app/api/report/view/[reportId]/route.ts": [/\bconst\s+GRADE_KEYS\b/],
      "src/pipeline/stageC/payload.ts": [
        /Object\.keys\((?:sc|scores)\.aspects\)/,
        /\bconst\s+scenarios\s*=\s*\["historical"/,
      ],
      "src/pipeline/stageC/index.ts": [
        /\bconst\s+scenarios\s*=\s*\["historical"/,
      ],
    };
    for (const [consumer, patterns] of Object.entries(forbiddenLocals)) {
      const source = readFileSync(path.join(process.cwd(), consumer), "utf8");
      for (const pattern of patterns) {
        expect(source, `${consumer}: ${pattern}`).not.toMatch(pattern);
      }
    }

    const diffBodySource = readFileSync(
      path.join(
        process.cwd(),
        "src/app/company/[symbol]/history/diff/diff-body.tsx",
      ),
      "utf8",
    );
    const driverRenderer = diffBodySource.slice(
      diffBodySource.indexOf("function driverRow"),
      diffBodySource.indexOf("function targetRow"),
    );
    expect(driverRenderer).toContain("SCORE_SURFACE_BY_KEY[change.aspect]");
    expect(driverRenderer).not.toContain("SCORE_WEIGHT_BY_ASPECT");

    const manifestSource = readFileSync(
      path.join(process.cwd(), "src", "report", "surfaceManifest.ts"),
      "utf8",
    );
    const schemaImports = manifestSource.match(
      /^import[^;]*from\s+["']@\/report\/schema["'];?$/gm,
    ) ?? [];
    expect(schemaImports).toHaveLength(1);
    expect(schemaImports[0]).toMatch(/^import\s+type\b/);
    expect(manifestSource).not.toMatch(/(?:from\s+["']zod["']|server-only|@\/db)/);
    expect(manifestSource).not.toMatch(
      /(?:Object\.(?:keys|values|fromEntries)|\.shape\b|\.options\b)/,
    );
  });
});
