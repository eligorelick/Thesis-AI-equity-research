import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { GET as exportGET } from "@/app/api/export/[reportId]/route";
import { ReportView } from "@/components/report/ReportView";
import { createDatabase, setDbForTests, type DatabaseHandle } from "@/db";
import { reports } from "@/db/schema";
import { buildDataCompleteness } from "@/report/completeness";
import { reportToMarkdown } from "@/report/export/markdown";
import { reportToPrintHtml } from "@/report/export/printHtml";
import {
  DisagreementSchema,
  MoatAssessmentSchema,
  ReportSchema,
  REPORT_SPEC_VERSION,
  SourcedClaimSchema,
  type Report,
} from "@/report/schema";
import { task28SentinelReport } from "./helpers/task28Report";

const FIXTURE_PATH = path.join(
  process.cwd(),
  "fixtures",
  "report",
  "DEMO-sample.json",
);

const FIXED_AUTOPRINT_SCRIPT =
  '<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},250);});</script>';

function loadFixtureReport(): Report {
  return ReportSchema.parse(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")));
}

interface PoisonRegistryEntry {
  path: string;
  context: string;
  safe: string;
  poison: string;
  apply(report: Report, value: string): void;
}

const POISON_REGISTRY: readonly PoisonRegistryEntry[] = [
  {
    path: "meta.companyName",
    context: "heading",
    safe: "P30HEADING safe",
    poison: "P30HEADING <h1 data-p30=heading>visible</h1>\n# P30INJECTEDHEADING",
    apply: (report, value) => { report.meta.companyName = value; },
  },
  {
    path: "meta.symbol",
    context: "heading/report-symbol",
    safe: "P30SYMBOLSAFE",
    poison: "P30SYMBOL<script data-p30=symbol>bad</script>",
    apply: (report, value) => { report.meta.symbol = value; },
  },
  {
    path: "verdict.synthesis",
    context: "prose",
    safe: "P30PROSE safe",
    poison: "P30PROSE <script data-p30=prose>alert(30)</script> "
      + "[P30LINK](javascript:alert(30)) ![P30IMAGE](https://p30.invalid/image) "
      + "<https://p30.invalid/angle> https://p30.invalid/bare www.p30.invalid p30@p30.invalid "
      + "<img data-p30=prose-sink src=https://p30.invalid/raw "
      + "style=background:url(javascript:alert(30))><!--comment-->",
    apply: (report, value) => { report.verdict.synthesis = value; },
  },
  {
    path: "fundamentals.graded.oneLineWhy",
    context: "emphasis/grade-why",
    safe: "P30GRADEWHY safe",
    poison: "P30GRADEWHY <em data-p30=grade-why>bad</em> *P30GRADEEMPHASIS*",
    apply: (report, value) => { report.fundamentals.graded.oneLineWhy = value; },
  },
  {
    path: "fundamentals.graded.interpretation",
    context: "prose/grade-interpretation",
    safe: "P30GRADEINTERPRETATION safe",
    poison: "P30GRADEINTERPRETATION <script data-p30=grade-interpretation>bad</script>",
    apply: (report, value) => { report.fundamentals.graded.interpretation = value; },
  },
  {
    path: "valuation.scenarios[0].assumptions[0]",
    context: "list-item",
    safe: "P30LIST safe",
    poison: "P30LIST\n- P30INJECTEDLIST\n1. P30INJECTEDNUMBER",
    apply: (report, value) => { report.valuation.scenarios[0]!.assumptions[0] = value; },
  },
  {
    path: "valuation.scenarios[0].whatWouldHaveToBeTrue[0]",
    context: "list-item/scenario-condition",
    safe: "P30WHTBT safe",
    poison: "P30WHTBT <script data-p30=whtbt>bad</script>\n- P30WHTBTLIST",
    apply: (report, value) => {
      report.valuation.scenarios[0]!.whatWouldHaveToBeTrue[0] = value;
    },
  },
  {
    path: "valuation.scenarios[0].horizon",
    context: "heading/scenario-horizon",
    safe: "P30HORIZON safe",
    poison: "P30HORIZON <h2 data-p30=scenario-horizon>bad</h2>\n# P30HORIZONHEADING",
    apply: (report, value) => { report.valuation.scenarios[0]!.horizon = value; },
  },
  {
    path: "valuation.scenarios[0].priceTarget.unit",
    context: "heading/traced-scenario-target-unit",
    safe: "P30TARGETUNIT safe",
    poison: "P30TARGETUNIT <img data-p30=scenario-target-unit src=x>",
    apply: (report, value) => { report.valuation.scenarios[0]!.priceTarget!.unit = value; },
  },
  {
    path: "valuation.dcf.perShare.unit",
    context: "prose/traced-dcf-unit",
    safe: "P30DCFUNIT safe",
    poison: "P30DCFUNIT <img data-p30=dcf-unit src=x>",
    apply: (report, value) => { report.valuation.dcf.perShare!.unit = value; },
  },
  {
    path: "valuation.reverseDcf.impliedMetric",
    context: "prose/reverse-dcf-metric",
    safe: "P30IMPLIEDMETRIC safe",
    poison: "P30IMPLIEDMETRIC <img data-p30=implied-metric src=x>",
    apply: (report, value) => { report.valuation.reverseDcf.impliedMetric = value; },
  },
  {
    path: "valuation.reverseDcf.narrative",
    context: "prose/valuation-narrative",
    safe: "P30VALUENARRATIVE safe",
    poison: "P30VALUENARRATIVE <script data-p30=value-narrative>bad</script>",
    apply: (report, value) => { report.valuation.reverseDcf.narrative = value; },
  },
  {
    path: "scenarioTargets.method",
    context: "prose/valuation-method",
    safe: "P30VALUEMETHOD safe",
    poison: "P30VALUEMETHOD [P30METHODLINK](javascript:alert(30))",
    apply: (report, value) => { report.scenarioTargets!.method = value; },
  },
  {
    path: "scenarioTargets.basis[0]",
    context: "prose/valuation-joined-basis",
    safe: "P30VALUEBASIS safe",
    poison: "P30VALUEBASIS <style data-p30=value-basis>bad</style>",
    apply: (report, value) => { report.scenarioTargets!.basis[0] = value; },
  },
  {
    path: "fairValue.reasons[0].reason",
    context: "prose/valuation-joined-reasons",
    safe: "P30VALUEREASON safe",
    poison: "P30VALUEREASON <img data-p30=value-reason src=x>",
    apply: (report, value) => { report.fairValue!.reasons[0]!.reason = value; },
  },
  {
    path: "meta.disclaimer",
    context: "blockquote",
    safe: "P30QUOTE safe",
    poison: "P30QUOTE\n> P30INJECTEDQUOTE\n---",
    apply: (report, value) => { report.meta.disclaimer = value; },
  },
  {
    path: "macro.fredAttribution",
    context: "blockquote/fred-attribution",
    safe: "P30FRED safe",
    poison: "P30FRED <script data-p30=fred>bad</script>\n> P30FREDQUOTE",
    apply: (report, value) => { report.macro.fredAttribution = value; },
  },
  {
    path: "business.whatTheySell[0].sourceId",
    context: "source-code-label",
    safe: "P30CODE safe",
    poison: "P30CODE one`tick ``two``` [P30CODELINK](javascript:alert(30)) "
      + "<img data-p30=code src=x>",
    apply: (report, value) => { report.business.whatTheySell[0]!.sourceId = value; },
  },
  {
    path: "business.whatTheySell[0].source",
    context: "source-code-label/legacy-source",
    safe: "P30SOURCE safe",
    poison: "P30SOURCE one`tick [P30SOURCELINK](javascript:alert(30)) "
      + "<img data-p30=source src=x>",
    apply: (report, value) => { report.business.whatTheySell[0]!.source = value; },
  },
  {
    path: "leadership.executives[0].name",
    context: "heading/executive-name",
    safe: "P30EXECNAME safe",
    poison: "P30EXECNAME <h3 data-p30=exec-name>bad</h3>\n# P30EXECNAMEHEADING",
    apply: (report, value) => { report.leadership.executives[0]!.name = value; },
  },
  {
    path: "leadership.executives[0].title",
    context: "heading/executive-title",
    safe: "P30EXECTITLE safe",
    poison: "P30EXECTITLE <img data-p30=exec-title src=x>",
    apply: (report, value) => { report.leadership.executives[0]!.title = value; },
  },
  {
    path: "scores.aspects.fundamentals.drivers[0].verificationNote",
    context: "table/task28-score-driver",
    safe: "P30DRIVER safe",
    poison: String.raw`P30DRIVER <style data-p30=driver>bad</style> \| P30DRIVERPIPE`,
    apply: (report, value) => {
      report.scores!.aspects.fundamentals.drivers[0]!.verificationNote = value;
    },
  },
  {
    path: "scores.composite.methodology",
    context: "table+prose/score-method",
    safe: "P30SCOREMETHOD safe",
    poison: "P30SCOREMETHOD <script data-p30=score-method>bad</script>",
    apply: (report, value) => { report.scores!.composite.methodology = value; },
  },
  {
    path: "scores.bandsVersion",
    context: "prose/score-version",
    safe: "P30SCOREVERSION safe",
    poison: "P30SCOREVERSION <style data-p30=score-version>bad</style>",
    apply: (report, value) => { report.scores!.bandsVersion = value; },
  },
  {
    path: "projections.series[0].unit",
    context: "heading+table/projection-series-unit",
    safe: "P30SERIESUNIT safe",
    poison: "P30SERIESUNIT <h4 data-p30=series-unit>bad</h4>\n# P30SERIESUNITHEADING",
    apply: (report, value) => { report.projections!.series[0]!.unit = value; },
  },
  {
    path: "projections.series[0].historical[0].value.unit",
    context: "traced-value+table/projection-point-unit",
    safe: "P30POINTUNIT safe",
    poison: String.raw`P30POINTUNIT <img data-p30=point-unit src=x> \| POINTUNITPIPE`,
    apply: (report, value) => {
      report.projections!.series[0]!.historical[0]!.value.unit = value;
    },
  },
  {
    path: "projections.series[0].assumptions[0]",
    context: "list-item+table/task28-projection-assumption",
    safe: "P30PROJASSUME safe",
    poison: "P30PROJASSUME <script data-p30=projection-assumption>bad</script> | ASSUMPTIONPIPE",
    apply: (report, value) => { report.projections!.series[0]!.assumptions[0] = value; },
  },
  {
    path: "projections.series[0].disclosures[0].reason",
    context: "table/task28-projection",
    safe: "P30PROJECTION safe",
    poison: String.raw`P30PROJECTION <img data-p30=projection src=x> \| P30PROJECTIONPIPE`,
    apply: (report, value) => { report.projections!.series[0]!.disclosures[0]!.reason = value; },
  },
  {
    path: "projections.notApplicableReason",
    context: "table/projection-not-applicable-reason",
    safe: "P30PROJECTIONNA safe",
    poison: String.raw`P30PROJECTIONNA <script data-p30=projection-na>bad</script> \| PROJECTIONNAPIPE`,
    apply: (report, value) => { report.projections!.notApplicableReason = value; },
  },
  {
    path: "leadership.executives[0].evidence.guidanceVsActuals[0].text",
    context: "list-item/task28-evidence",
    safe: "P30EVIDENCE safe",
    poison: "P30EVIDENCE <script data-p30=evidence>bad</script>\n> P30EVIDENCEQUOTE",
    apply: (report, value) => {
      report.leadership.executives[0]!.evidence.guidanceVsActuals![0]!.text = value;
    },
  },
  {
    path: "technicals.read.trend",
    context: "manual-list/technical-read",
    safe: "P30TECHNICAL safe",
    poison: "P30TECHNICAL <script data-p30=technical>bad</script>\n- P30TECHNICALLIST",
    apply: (report, value) => { report.technicals.read.trend = value; },
  },
  {
    path: "technicals.read.momentum",
    context: "manual-list/technical-momentum",
    safe: "P30MOMENTUM safe",
    poison: "P30MOMENTUM <img data-p30=momentum src=x>",
    apply: (report, value) => { report.technicals.read.momentum = value; },
  },
  {
    path: "technicals.read.keyLevels",
    context: "manual-list/technical-key-levels",
    safe: "P30KEYLEVELS safe",
    poison: "P30KEYLEVELS <style data-p30=key-levels>bad</style>",
    apply: (report, value) => { report.technicals.read.keyLevels = value; },
  },
  {
    path: "technicals.read.relativeStrength",
    context: "manual-list/technical-relative-strength",
    safe: "P30RELSTRENGTH safe",
    poison: "P30RELSTRENGTH <script data-p30=relative-strength>bad</script>",
    apply: (report, value) => { report.technicals.read.relativeStrength = value; },
  },
  {
    path: "competitive.moatAssessment[0].reasoning[0].text",
    context: "manual-list/moat-joined-reasoning",
    safe: "P30MOAT safe",
    poison: "P30MOAT <img data-p30=moat src=x>\n> P30MOATQUOTE",
    apply: (report, value) => {
      report.competitive.moatAssessment[0]!.reasoning[0]!.text = value;
    },
  },
  {
    path: "competitive.marketShareDirection",
    context: "prose/market-share-direction",
    safe: "P30MARKETSHARE safe",
    poison: "P30MARKETSHARE <script data-p30=market-share>bad</script>",
    apply: (report, value) => { report.competitive.marketShareDirection = value; },
  },
  {
    path: "disagreements[0].topic",
    context: "manual-list/disagreement-topic",
    safe: "P30DISAGREEMENTTOPIC safe",
    poison: "P30DISAGREEMENTTOPIC <img data-p30=disagreement-topic src=x>",
    apply: (report, value) => { report.disagreements[0]!.topic = value; },
  },
  {
    path: "disagreements[0].bullView",
    context: "manual-list/disagreement-view",
    safe: "P30DISAGREEMENT safe",
    poison: "P30DISAGREEMENT <style data-p30=disagreement>bad</style>\n1. P30DISAGREEMENTLIST",
    apply: (report, value) => { report.disagreements[0]!.bullView = value; },
  },
  {
    path: "disagreements[0].bearView",
    context: "manual-list/disagreement-bear-view",
    safe: "P30DISAGREEMENTBEAR safe",
    poison: "P30DISAGREEMENTBEAR <img data-p30=disagreement-bear src=x>",
    apply: (report, value) => { report.disagreements[0]!.bearView = value; },
  },
  {
    path: "disagreements[0].judgeResolution",
    context: "manual-list/disagreement-judge-resolution",
    safe: "P30DISAGREEMENTJUDGE safe",
    poison: "P30DISAGREEMENTJUDGE <script data-p30=disagreement-judge>bad</script>",
    apply: (report, value) => { report.disagreements[0]!.judgeResolution = value; },
  },
  {
    path: "appendix.sources[0].endpoint",
    context: "table/task28-appendix",
    safe: "P30APPENDIX safe",
    poison: String.raw`P30APPENDIX <img data-p30=appendix src=x> \| P30APPENDIXPIPE`,
    apply: (report, value) => { report.appendix.sources[0]!.endpoint = value; },
  },
  {
    path: "appendix.missingData[0].reason",
    context: "blockquote+table/task28-completeness",
    safe: "P30COMPLETE safe",
    poison: "P30COMPLETE <script data-p30=completeness>bad</script>\n# P30COMPLETEHEADING",
    apply: (report, value) => {
      report.appendix.missingData[0] = {
        field: "analysis.llm",
        reason: value,
        severity: "critical",
        attemptedSources: ["P30ONCEalpha", "P30ONCEbeta"],
        expected: false,
      };
    },
  },
];

function addOptionalValuationSurfaces(report: Report): void {
  report.scenarioTargets = {
    status: "available",
    method: "P30VALUEMETHOD seed",
    methodVersion: "P30_SCENARIO_TARGETS_VERSION",
    basis: ["P30VALUEBASIS seed"],
    dispersion: {
      growthSigmaPp: 1,
      marginSigmaPp: 1,
      sigmaSource: "own-history",
    },
    targets: [],
    missingReasons: [],
  };
  report.fairValue = {
    status: "suppressed",
    method: null,
    methodVersion: "P30_FAIR_VALUE_VERSION",
    perShare: null,
    upsidePct: null,
    basis: ["P30 fair-value fallback basis"],
    reasons: [{
      field: "valuation.fairValue",
      reason: "P30VALUEREASON seed",
      severity: "warn",
      attemptedSources: ["computed.valuation"],
      expected: false,
    }],
  };
}

function consumerReport(
  poisoned: boolean,
  poisonedPaths: readonly string[] = POISON_REGISTRY.map((entry) => entry.path),
): Report {
  const report = task28SentinelReport();
  addOptionalValuationSurfaces(report);
  for (const entry of POISON_REGISTRY) {
    entry.apply(report, poisoned && poisonedPaths.includes(entry.path) ? entry.poison : entry.safe);
  }
  const poisonCompleteness = poisoned
    && poisonedPaths.includes("appendix.missingData[0].reason");
  report.appendix.missingData[0]!.attemptedSources = poisonCompleteness
    ? [String.raw`P30ONCE\|one`, "P30ONCE*two*|tail"]
    : ["P30ONCEone", "P30ONCEtwo"];
  report.meta.dataCompleteness = buildDataCompleteness(report.appendix.missingData);
  return ReportSchema.parse(report);
}

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

/** Mask valid CommonMark code spans while preserving line positions. */
function maskCodeSpans(value: string): string {
  // Keep indexes in UTF-16 code units so they stay aligned with isEscaped().
  const chars = value.split("");
  let cursor = 0;
  while (cursor < chars.length) {
    if (chars[cursor] !== "`" || isEscaped(value, cursor)) {
      cursor += 1;
      continue;
    }
    let openingEnd = cursor;
    while (chars[openingEnd] === "`") openingEnd += 1;
    const fenceLength = openingEnd - cursor;
    let search = openingEnd;
    let closingEnd = -1;
    while (search < chars.length) {
      // Backslashes have no escaping role inside an open CommonMark code span.
      if (chars[search] !== "`") {
        search += 1;
        continue;
      }
      let runEnd = search;
      while (chars[runEnd] === "`") runEnd += 1;
      if (runEnd - search === fenceLength) {
        closingEnd = runEnd;
        break;
      }
      search = runEnd;
    }
    if (closingEnd < 0) {
      cursor = openingEnd;
      continue;
    }
    for (let index = cursor; index < closingEnd; index += 1) {
      if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
    }
    cursor = closingEnd;
  }
  return chars.join("");
}

function unescapedMatches(value: string, pattern: RegExp, significantOffset = 0): string[] {
  return Array.from(value.matchAll(pattern))
    .filter((match) => !isEscaped(value, match.index! + significantOffset))
    .map((match) => match[0]);
}

function activeTablePipes(line: string): number {
  let count = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "|" && !isEscaped(line, index)) count += 1;
  }
  return count;
}

function structuralSignature(markdown: string): string[] {
  const masked = maskCodeSpans(markdown);
  const signature: string[] = [];
  for (const [index, line] of masked.split("\n").entries()) {
    if (/^#{1,6}(?:[ \t]|$)/.test(line)) signature.push(`${index}:heading:${line.match(/^#+/)![0].length}`);
    if (/^ {0,3}>[ \t]?/.test(line)) signature.push(`${index}:blockquote`);
    if (/^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/.test(line)) signature.push(`${index}:list`);
    if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) signature.push(`${index}:fence`);
    if (/^ {0,3}(?:[-*_][ \t]*){3,}$/.test(line)) signature.push(`${index}:rule`);
    if (/^ {0,3}\[[^\]]+\]:/.test(line)) signature.push(`${index}:reference`);
  }
  return signature;
}

function tablePipeSignature(markdown: string): string[] {
  return maskCodeSpans(markdown)
    .split("\n")
    .map((line, index) => ({ index, line, pipes: activeTablePipes(line) }))
    .filter(({ line, pipes }) => pipes > 0 && line.startsWith("|"))
    .map(({ index, pipes }) => `${index}:${pipes}`);
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function poisonMarker(entry: PoisonRegistryEntry): string {
  const marker = entry.poison.match(/^P30[A-Z]+/)?.[0];
  if (!marker) throw new Error(`missing poison marker for ${entry.path}`);
  return marker;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

describe("real report consumers use context-safe Markdown boundaries", () => {
  it("keeps the structural oracle aligned around astral text and CommonMark code fences", () => {
    const masked = maskCodeSpans("😀 \\`escaped\\` `<script data-p30=code>` `tail\\`");

    expect(masked).toContain("😀 \\`escaped\\`");
    expect(masked).not.toContain("<script data-p30=code>");
    expect(masked).not.toContain("tail\\");
  });

  it("keeps the unique path-to-context poison registry schema-valid and complete", () => {
    expect(POISON_REGISTRY.map((entry) => entry.path)).toEqual([
      "meta.companyName",
      "meta.symbol",
      "verdict.synthesis",
      "fundamentals.graded.oneLineWhy",
      "fundamentals.graded.interpretation",
      "valuation.scenarios[0].assumptions[0]",
      "valuation.scenarios[0].whatWouldHaveToBeTrue[0]",
      "valuation.scenarios[0].horizon",
      "valuation.scenarios[0].priceTarget.unit",
      "valuation.dcf.perShare.unit",
      "valuation.reverseDcf.impliedMetric",
      "valuation.reverseDcf.narrative",
      "scenarioTargets.method",
      "scenarioTargets.basis[0]",
      "fairValue.reasons[0].reason",
      "meta.disclaimer",
      "macro.fredAttribution",
      "business.whatTheySell[0].sourceId",
      "business.whatTheySell[0].source",
      "leadership.executives[0].name",
      "leadership.executives[0].title",
      "scores.aspects.fundamentals.drivers[0].verificationNote",
      "scores.composite.methodology",
      "scores.bandsVersion",
      "projections.series[0].unit",
      "projections.series[0].historical[0].value.unit",
      "projections.series[0].assumptions[0]",
      "projections.series[0].disclosures[0].reason",
      "projections.notApplicableReason",
      "leadership.executives[0].evidence.guidanceVsActuals[0].text",
      "technicals.read.trend",
      "technicals.read.momentum",
      "technicals.read.keyLevels",
      "technicals.read.relativeStrength",
      "competitive.moatAssessment[0].reasoning[0].text",
      "competitive.marketShareDirection",
      "disagreements[0].topic",
      "disagreements[0].bullView",
      "disagreements[0].bearView",
      "disagreements[0].judgeResolution",
      "appendix.sources[0].endpoint",
      "appendix.missingData[0].reason",
    ]);
    expect(new Set(POISON_REGISTRY.map(poisonMarker)).size).toBe(POISON_REGISTRY.length);
    expect(POISON_REGISTRY.every((entry) => entry.context.length > 0)).toBe(true);
    expect(ReportSchema.safeParse(consumerReport(true)).success).toBe(true);
  });

  it("neutralizes active HTML, links, images, autolinks, and injected block grammar while keeping text visible", () => {
    const safe = reportToMarkdown(consumerReport(false));
    const markdown = reportToMarkdown(consumerReport(true));
    const outsideCode = maskCodeSpans(markdown);

    for (const entry of POISON_REGISTRY) {
      expect(markdown, entry.path).toContain(poisonMarker(entry));
    }
    expect(unescapedMatches(outsideCode, /(?:<!--[\s\S]*?-->|<\/?[A-Za-z][^>\n]*>)/g)).toEqual([]);
    expect(unescapedMatches(outsideCode, /!?\[[^\]\n]*\]\([^\n)]*\)/g, 0)).toEqual([]);
    expect(unescapedMatches(outsideCode, /<(?:https?|mailto):[^>]+>/gi)).toEqual([]);
    expect(outsideCode).not.toMatch(/https?:\/\/p30\.invalid|www\.p30\.invalid|p30@p30\.invalid/);
    expect(structuralSignature(markdown)).toEqual(structuralSignature(safe));

    expect(markdown).toContain(String.raw`\<script data-p30=prose\>alert(30)\</script\>`);
    expect(markdown).toContain(String.raw`\[P30LINK\](javascript\:alert(30))`);
    expect(markdown).toContain(String.raw`!\[P30IMAGE\](https\://p30.invalid/image)`);
    expect(markdown).toContain(String.raw`\<https\://p30.invalid/angle\>`);
    expect(markdown).toContain(String.raw`https\://p30.invalid/bare`);
    expect(markdown).toContain(String.raw`www\.p30.invalid`);
    expect(markdown).toContain(String.raw`p30\@p30.invalid`);
    expect(markdown).toContain(String.raw`\# P30INJECTEDHEADING`);
    expect(markdown).toContain("P30INJECTEDLIST");
    expect(markdown).toContain("P30INJECTEDQUOTE");
    expect(markdown).toContain(
      "````source id: P30CODE one`tick ``two``` [P30CODELINK](javascript:alert(30)) "
        + "<img data-p30=code src=x>````",
    );
  });

  it("serializes Task 28 table leaves and a dual-context completeness reason exactly once", () => {
    const tablePaths = [
      "scores.aspects.fundamentals.drivers[0].verificationNote",
      "projections.series[0].historical[0].value.unit",
      "projections.series[0].assumptions[0]",
      "projections.series[0].disclosures[0].reason",
      "projections.notApplicableReason",
      "appendix.sources[0].endpoint",
      "appendix.missingData[0].reason",
    ];
    const safe = reportToMarkdown(consumerReport(false, tablePaths));
    const markdown = reportToMarkdown(consumerReport(true, tablePaths));
    const reason = String.raw`P30COMPLETE \<script data-p30=completeness\>bad\</script\> \# P30COMPLETEHEADING`;

    expect(tablePipeSignature(markdown)).toEqual(tablePipeSignature(safe));
    expect(markdown).toContain(String.raw`P30DRIVER \<style data-p30=driver\>bad\</style\> \\\| P30DRIVERPIPE`);
    expect(markdown).toContain(String.raw`P30POINTUNIT \<img data-p30=point-unit src=x\> \\\| POINTUNITPIPE`);
    expect(markdown).toContain(String.raw`P30PROJECTION \<img data-p30=projection src=x\> \\\| P30PROJECTIONPIPE`);
    expect(markdown).toContain(String.raw`P30PROJECTIONNA \<script data-p30=projection-na\>bad\</script\> \\\| PROJECTIONNAPIPE`);
    expect(markdown).toContain(String.raw`P30APPENDIX \<img data-p30=appendix src=x\> \\\| P30APPENDIXPIPE`);
    expect(markdown).toContain(String.raw`P30ONCE\\\|one, P30ONCE\*two\*\|tail`);
    expect(countOccurrences(markdown, reason)).toBe(2);
    expect(markdown).not.toContain(String.raw`P30ONCE\\\\\\\|one`);
  });

  it("serializes one Task 28 projection assumption once in its list and once in its audit table", () => {
    const path = "projections.series[0].assumptions[0]";
    const markdown = reportToMarkdown(consumerReport(true, [path]));
    const listLine = String.raw`- P30PROJASSUME \<script data-p30=projection-assumption\>bad\</script\> | ASSUMPTIONPIPE`;
    const tableLine = String.raw`| P30PROJASSUME \<script data-p30=projection-assumption\>bad\</script\> \| ASSUMPTIONPIPE |`;

    expect(markdown).toContain(listLine);
    expect(markdown).toContain(tableLine);
    expect(countOccurrences(markdown, "P30PROJASSUME")).toBe(2);
  });

  it("serializes a present empty projection block's not-applicable reason in prose and its audit table", () => {
    const report = consumerReport(true, ["projections.notApplicableReason"]);
    report.projections!.series = [];
    const parsed = ReportSchema.parse(report);
    const before = JSON.stringify(parsed);
    const markdown = reportToMarkdown(parsed);

    expect(markdown).toContain(
      String.raw`_Not applicable: P30PROJECTIONNA \<script data-p30=projection-na\>bad\</script\> \\| PROJECTIONNAPIPE_`,
    );
    expect(markdown).toContain(
      String.raw`| Not applicable reason | P30PROJECTIONNA \<script data-p30=projection-na\>bad\</script\> \\\| PROJECTIONNAPIPE |`,
    );
    expect(countOccurrences(markdown, "P30PROJECTIONNA")).toBe(2);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it("escapes the opposite fair-value and scenario-target disclosure branches from raw data", () => {
    const report = consumerReport(false);
    report.fairValue = {
      status: "available",
      method: "fcff-dcf",
      methodVersion: "P30_FAIR_VALUE_AVAILABLE_VERSION",
      perShare: report.valuation.dcf.perShare,
      upsidePct: report.valuation.dcf.upsidePct,
      basis: ["P30FAIRAVAILABLE <style data-p30=fair-available>bad</style>"],
      reasons: [],
    };
    report.scenarioTargets = {
      status: "suppressed",
      method: "P30 suppressed scenario method",
      methodVersion: "P30_SCENARIO_TARGETS_SUPPRESSED_VERSION",
      basis: ["P30 suppressed fallback basis"],
      dispersion: null,
      targets: [],
      missingReasons: [{
        field: "valuation.scenarioTargets",
        reason: "P30SCENARIOSUPPRESSED <script data-p30=scenario-suppressed>bad</script>",
        severity: "warn",
        attemptedSources: ["computed.scenarioTargets"],
        expected: false,
      }],
    };
    const parsed = ReportSchema.parse(report);
    const before = JSON.stringify(parsed);
    const markdown = reportToMarkdown(parsed);

    expect(markdown).toContain(
      String.raw`_P30FAIRAVAILABLE \<style data-p30=fair-available\>bad\</style\>_`,
    );
    expect(markdown).toContain(
      String.raw`_Scenario price targets suppressed — P30SCENARIOSUPPRESSED \<script data-p30=scenario-suppressed\>bad\</script\>_`,
    );
    expect(countOccurrences(markdown, "P30FAIRAVAILABLE")).toBe(1);
    expect(countOccurrences(markdown, "P30SCENARIOSUPPRESSED")).toBe(1);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it("escapes basis fallbacks when suppressed valuation reason arrays are empty", () => {
    const report = consumerReport(false);
    report.fairValue = {
      status: "suppressed",
      method: null,
      methodVersion: "P30_FAIR_VALUE_FALLBACK_VERSION",
      perShare: null,
      upsidePct: null,
      basis: ["P30FAIRFALLBACK <style data-p30=fair-fallback>bad</style>"],
      reasons: [],
    };
    report.scenarioTargets = {
      status: "suppressed",
      method: "P30 suppressed scenario method",
      methodVersion: "P30_SCENARIO_TARGETS_FALLBACK_VERSION",
      basis: ["P30SCENARIOFALLBACK <script data-p30=scenario-fallback>bad</script>"],
      dispersion: null,
      targets: [],
      missingReasons: [],
    };
    const parsed = ReportSchema.parse(report);
    const before = JSON.stringify(parsed);
    const markdown = reportToMarkdown(parsed);

    expect(markdown).toContain(
      String.raw`_Intrinsic value per share suppressed — P30FAIRFALLBACK \<style data-p30=fair-fallback\>bad\</style\>_`,
    );
    expect(markdown).toContain(
      String.raw`_Scenario price targets suppressed — P30SCENARIOFALLBACK \<script data-p30=scenario-fallback\>bad\</script\>_`,
    );
    expect(countOccurrences(markdown, "P30FAIRFALLBACK")).toBe(1);
    expect(countOccurrences(markdown, "P30SCENARIOFALLBACK")).toBe(1);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it("delegates schema-controlled claim, moat, and disagreement chunks without raw escape gaps", () => {
    const report = consumerReport(false);
    const claim = report.business.whatTheySell[0]!;
    claim.text = "P30CONTROLLEDCLAIM";
    claim.label = "FACT";
    claim.asOf = "2099-12-31";
    claim.sourceId = "P30CONTROLLEDID";
    claim.source = "P30CONTROLLEDSOURCE";
    const moat = report.competitive.moatAssessment[0]!;
    moat.source = "networkEffects";
    moat.strength = "wide";
    moat.reasoning[0]!.text = "P30CONTROLLEDMOAT";
    const disagreement = report.disagreements[0]!;
    disagreement.topic = "P30CONTROLLEDTOPIC";
    disagreement.bullView = "P30CONTROLLEDBULL";
    disagreement.bearView = "P30CONTROLLEDBEAR";
    disagreement.kind = "entity";
    disagreement.judgeResolution = "P30CONTROLLEDJUDGE";
    const parsed = ReportSchema.parse(report);
    const markdown = reportToMarkdown(parsed);

    expect(markdown).toContain(
      "- **[FACT]** P30CONTROLLEDCLAIM _(as of 2099-12-31)_ "
        + "`source id: P30CONTROLLEDID` `src: P30CONTROLLEDSOURCE`",
    );
    // CONTRACT CHANGED 2026-08-31. Moat reasoning used to be flattened to
    // `- **networkEffects** (wide): <joined claim texts>`, which stripped every
    // label, as-of date and citation from what is a model JUDGMENT — so it read
    // as a sourced fact. It now goes through the same claim renderer as
    // whatTheySell above, under a heading naming the source and strength.
    expect(markdown).toContain("#### networkEffects (wide)");
    expect(markdown).toContain("P30CONTROLLEDMOAT");
    expect(markdown).not.toContain("- **networkEffects** (wide): P30CONTROLLEDMOAT");
    expect(markdown).toContain("- **P30CONTROLLEDTOPIC** (entity)");
    expect(markdown).toContain("  - Judge: P30CONTROLLEDJUDGE");

    expect(SourcedClaimSchema.safeParse({
      text: "x",
      label: "<script>",
      source: "x",
      asOf: "2099-12-31",
    }).success).toBe(false);
    expect(SourcedClaimSchema.safeParse({
      text: "x",
      label: "FACT",
      source: "x",
      asOf: "<script>",
    }).success).toBe(false);
    expect(MoatAssessmentSchema.safeParse({
      source: "<script>",
      strength: "wide",
      reasoning: [],
    }).success).toBe(false);
    expect(MoatAssessmentSchema.safeParse({
      source: "scale",
      strength: "<script>",
      reasoning: [],
    }).success).toBe(false);
    expect(DisagreementSchema.safeParse({
      topic: "x",
      bullView: "x",
      bearView: "x",
      kind: "<script>",
      judgeResolution: "x",
    }).success).toBe(false);
  });

  // WS6 review (SHOULD-FIX 3): a bare "rank 62" is not a rank a reader can read.
  // N reached only the Stage C payload notes; every rendered surface now prints
  // it, and a report written before the review (no N) still renders and parses.
  it("prints N beside the own-history rank in Markdown and print HTML, and degrades cleanly without it", () => {
    const report = loadFixtureReport();
    report.valuation.multiples = [
      { name: "P/E (TTM)", current: 11.2, peerMedian: 10.5, own5yPercentile: 62, ownHistoryObservations: 12, sectorAppropriate: true },
      { name: "P/FCF (before SBC)", current: 18, peerMedian: null, own5yPercentile: 40, sectorAppropriate: true },
    ];
    expect(ReportSchema.safeParse(report).success).toBe(true);
    const markdown = reportToMarkdown(report);
    expect(markdown).toContain("rank 62/100 of 12 quarters");
    // The legacy row (no N persisted) still renders, without inventing one.
    expect(markdown).toContain("rank 40/100");
    expect(markdown).not.toContain("rank 40/100 of");
    const html = reportToPrintHtml(report, { autoPrint: false });
    expect(html).toContain("rank 62/100 of 12 quarters");
  });

  it("remains deterministic, non-mutating, and terminated by exactly one LF", () => {
    const report = consumerReport(true);
    const before = JSON.stringify(report);
    const first = reportToMarkdown(report);
    const second = reportToMarkdown(report);

    expect(second).toBe(first);
    expect(JSON.stringify(report)).toBe(before);
    expect(first.endsWith("\n")).toBe(true);
    expect(first.endsWith("\n\n")).toBe(false);
    expect(first).not.toContain("\r");
  });

  it("lets React JSX escape report HTML independently of Markdown serialization", () => {
    const report = consumerReport(true);
    const before = JSON.stringify(report);
    const html = renderToStaticMarkup(createElement(ReportView, { report }));
    expect(html).not.toMatch(/<(?:script|style|img|h[1-6]|em)\b[^>]*\bdata-p30=/i);
    expect(html).not.toMatch(/<a\b[^>]*\bhref=[^>]*(?:javascript:|p30\.invalid)/i);
    expect(html).not.toMatch(/<(?:img|iframe|script)\b[^>]*\bsrc=[^>]*(?:javascript:|p30\.invalid)/i);
    expect(html).not.toMatch(/<[A-Za-z][^>]*\bstyle=[^>]*(?:javascript:|p30)/i);
    for (const entry of POISON_REGISTRY.filter((item) => [
      "verdict.synthesis",
      "scores.aspects.fundamentals.drivers[0].verificationNote",
      "projections.series[0].disclosures[0].reason",
      "leadership.executives[0].evidence.guidanceVsActuals[0].text",
      "appendix.sources[0].endpoint",
      "appendix.missingData[0].reason",
    ].includes(item.path))) {
      expect(html, entry.path).toContain(escapeHtml(entry.poison));
    }
    expect(JSON.stringify(report)).toBe(before);
  });

  it("lets print HTML escape report data while emitting only the exact fixed auto-print script", () => {
    const report = consumerReport(true);
    const before = JSON.stringify(report);
    const html = reportToPrintHtml(report, { autoPrint: true });
    const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [];

    expect(scripts).toEqual([FIXED_AUTOPRINT_SCRIPT]);
    expect(html).not.toMatch(/<(?:script|style|img|h[1-6]|em)\b[^>]*\bdata-p30=/i);
    expect(html).not.toMatch(/<a\b[^>]*\bhref=[^>]*(?:javascript:|p30\.invalid)/i);
    expect(html).not.toMatch(/<(?:img|iframe|script)\b[^>]*\bsrc=[^>]*(?:javascript:|p30\.invalid)/i);
    expect(html).not.toMatch(/<[A-Za-z][^>]*\bstyle=[^>]*(?:javascript:|p30)/i);
    for (const entry of POISON_REGISTRY.filter((item) => [
      "verdict.synthesis",
      "scores.aspects.fundamentals.drivers[0].verificationNote",
      "projections.series[0].disclosures[0].reason",
      "leadership.executives[0].evidence.guidanceVsActuals[0].text",
      "appendix.sources[0].endpoint",
      "appendix.missingData[0].reason",
    ].includes(item.path))) {
      expect(html, entry.path).toContain(escapeHtml(entry.poison));
    }
    expect(JSON.stringify(report)).toBe(before);
  });
});

let handle: DatabaseHandle;

beforeEach(() => {
  handle = createDatabase(":memory:");
  setDbForTests(handle.db);
});

afterEach(() => {
  setDbForTests(null);
  handle.sqlite.close();
});

function seedReport(report: Report): number {
  return handle.db.insert(reports).values({
    symbol: report.meta.symbol,
    createdAt: report.meta.generatedAt,
    model: report.meta.model,
    status: "done",
    reportJson: JSON.stringify(report),
    verificationRate: report.meta.verificationRate,
    costUsd: report.meta.costUsd,
    specVersion: REPORT_SPEC_VERSION,
  }).returning({ id: reports.id }).get().id;
}

function seedRawReport(reportJson: string | null): number {
  return handle.db.insert(reports).values({
    symbol: "DEMO",
    createdAt: "2026-08-08T00:00:00.000Z",
    model: "claude-opus-4-8",
    status: "done",
    reportJson,
    verificationRate: null,
    costUsd: null,
    specVersion: REPORT_SPEC_VERSION,
  }).returning({ id: reports.id }).get().id;
}

function exportRequest(
  reportId: string,
  format?: string,
): [Request, { params: Promise<{ reportId: string }> }] {
  const query = format === undefined ? "" : `?format=${format}`;
  return [
    new Request(`http://localhost/api/export/${reportId}${query}`),
    { params: Promise.resolve({ reportId }) },
  ];
}

function expectNosniff(response: Response): void {
  expect.soft(response.headers.get("x-content-type-options")).toBe("nosniff");
}

function expectSuccessHeaders(response: Response): void {
  expect.soft(response.headers.get("cache-control")).toBe("no-store");
  expectNosniff(response);
}

describe("persisted Markdown and PDF export boundaries", () => {
  it("matches direct poison rendering byte-for-byte without mutating stored report JSON", async () => {
    const report = consumerReport(true);
    const storedBytes = JSON.stringify(report);
    const id = seedReport(report);
    const expectedMarkdown = reportToMarkdown(report);
    const expectedPrint = reportToPrintHtml(report, { autoPrint: true });

    const markdownResponse = await exportGET(...exportRequest(String(id), "md"));
    const printResponse = await exportGET(...exportRequest(String(id), "pdf"));
    const markdown = await markdownResponse.text();
    const print = await printResponse.text();

    expect(markdown).toBe(expectedMarkdown);
    expect(print).toBe(expectedPrint);

    const stored = handle.db.select({ reportJson: reports.reportJson })
      .from(reports)
      .where(eq(reports.id, id))
      .get();
    expect(stored?.reportJson).toBe(storedBytes);

    expect(markdownResponse.status).toBe(200);
    expect(markdownResponse.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(markdownResponse.headers.get("content-disposition")).toBe(
      `attachment; filename="P30SYMBOL-script-data-p30-symbol-bad-script-report-${id}.md"`,
    );
    expectSuccessHeaders(markdownResponse);

    expect(printResponse.status).toBe(200);
    expect(printResponse.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(printResponse.headers.get("content-disposition")).toBe(
      `inline; filename="P30SYMBOL-script-data-p30-symbol-bad-script-report-${id}.html"`,
    );
    expectSuccessHeaders(printResponse);
  });

  it("keeps a schema-legacy poisoned report inert without rewriting its stored bytes", async () => {
    const legacy = JSON.parse(JSON.stringify(loadFixtureReport())) as Report;
    legacy.meta.symbol = "LEGACY";
    legacy.fundamentals.commentary[0]!.asOf = "2026-06";
    legacy.verdict.synthesis =
      "P30LEGACY <script data-p30=legacy>bad</script>\n# P30LEGACYHEADING";
    const storedBytes = JSON.stringify(legacy);
    expect(ReportSchema.safeParse(legacy).success).toBe(false);
    const id = seedRawReport(storedBytes);

    const markdownResponse = await exportGET(...exportRequest(String(id), "md"));
    const printResponse = await exportGET(...exportRequest(String(id), "pdf"));
    const markdown = await markdownResponse.text();
    const print = await printResponse.text();

    expect(markdownResponse.status).toBe(200);
    expect(printResponse.status).toBe(200);
    expect(markdown).toContain(
      String.raw`P30LEGACY \<script data-p30=legacy\>bad\</script\> \# P30LEGACYHEADING`,
    );
    expect(markdown).not.toContain("<script data-p30=legacy>");
    expect(print).toContain(
      "P30LEGACY &lt;script data-p30=legacy&gt;bad&lt;/script&gt;",
    );
    expect(print).toContain("# P30LEGACYHEADING");
    expect(print).not.toContain("<script data-p30=legacy>");
    expectSuccessHeaders(markdownResponse);
    expectSuccessHeaders(printResponse);

    const stored = handle.db.select({ reportJson: reports.reportJson })
      .from(reports)
      .where(eq(reports.id, id))
      .get();
    expect(stored?.reportJson).toBe(storedBytes);
  });

  it.each([
    ["invalid report id", 400, () => exportRequest("12abc")],
    ["unknown format", 400, () => {
      const id = seedReport(loadFixtureReport());
      return exportRequest(String(id), "csv");
    }],
    ["missing report", 404, () => exportRequest("999999")],
    ["corrupt stored JSON", 422, () => exportRequest(String(seedRawReport("{ broken")))],
    ["schema-invalid stored JSON", 422, () => exportRequest(String(seedRawReport('{"hello":"world"}')))],
    ["null stored JSON", 422, () => exportRequest(String(seedRawReport(null)))],
  ] as const)("sets hardened JSON headers for every %s error", async (_label, status, request) => {
    const response = await exportGET(...request());

    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBeNull();
    expectNosniff(response);
    expect(await response.json()).toEqual({ error: expect.any(String) });
  });
});
