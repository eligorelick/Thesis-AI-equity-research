import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import { ReportView } from "@/components/report/ReportView";
import { ReportMetaStrip } from "@/components/report/sections";
import { buildDataCompleteness } from "@/report/completeness";
import { reportToMarkdown } from "@/report/export/markdown";
import { reportToPrintBody } from "@/report/export/printHtml";
import type { DataCompleteness, Report } from "@/report/schema";
import type { ManifestEntry } from "@/types/core";
import {
  cloneTask28,
  task28SentinelReport,
} from "./helpers/task28Report";

interface RenderedSurfaces {
  live: string;
  markdown: string;
  print: string;
}

interface CompletenessScopes {
  liveMetaStrip: string;
  markdownCompletenessRow: string;
  printCompletenessRow: string;
}

interface ExpectedDimensions {
  state: "complete" | "degraded" | "blocked";
  critical: number;
  warnings: number;
  edgar: "available" | "missing";
  xbrl: "checked" | "skipped" | "failed";
  forensics: "complete" | "provisional";
}

const ANALYSIS_GAP: ManifestEntry = {
  field: "analysis.llm",
  reason: "TASK28:integration:first persisted analysis reason",
  severity: "critical",
  attemptedSources: ["TASK28:integration:analysis-source"],
};

const CONFIRMED_STOCK_CASES: Array<{
  name: string;
  gaps: ManifestEntry[];
} & ExpectedDimensions> = [
  {
    name: "complete",
    gaps: [],
    state: "complete",
    critical: 0,
    warnings: 0,
    edgar: "available",
    xbrl: "checked",
    forensics: "complete",
  },
  {
    name: "degraded",
    gaps: [
      {
        field: "shares.float",
        reason: "TASK28:integration:ordinary informational gap",
        severity: "info",
        expected: false,
      },
      {
        field: "fundamentals.revenue",
        reason: "TASK28:integration:ordinary warning gap",
        severity: "warn",
      },
      {
        field: "segments.structural",
        reason: "TASK28:integration:ordinary expected omission",
        severity: "info",
        expected: true,
      },
    ],
    state: "degraded",
    critical: 0,
    warnings: 1,
    edgar: "available",
    xbrl: "checked",
    forensics: "complete",
  },
  {
    name: "provider-blocked",
    gaps: [
      {
        field: "edgar.companyFacts",
        reason: "TASK28:integration:EDGAR request failed",
        severity: "critical",
      },
      {
        field: "edgar.xbrl",
        reason: "TASK28:integration:XBRL cross-check skipped",
        severity: "warn",
      },
    ],
    state: "blocked",
    critical: 1,
    warnings: 1,
    edgar: "missing",
    xbrl: "skipped",
    forensics: "provisional",
  },
];

function renderWithoutMutation(report: Report): RenderedSurfaces {
  const before = JSON.stringify(report);
  const rendered = {
    live: renderToStaticMarkup(createElement(ReportView, { report })),
    markdown: reportToMarkdown(report),
    print: reportToPrintBody(report),
  };
  expect(JSON.stringify(report)).toBe(before);
  return rendered;
}

function readable(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&mdash;|&#8212;/g, "—")
    .replace(/&amp;/g, "&")
    .replace(/[*_`#|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function eachSurface(
  rendered: RenderedSurfaces,
  assertion: (text: string, surface: keyof RenderedSurfaces) => void,
): void {
  for (const [surface, value] of Object.entries(rendered) as Array<
    [keyof RenderedSurfaces, string]
  >) {
    assertion(readable(value), surface);
  }
}

function completenessScopes(
  report: Report,
  rendered: RenderedSurfaces,
): CompletenessScopes {
  const before = JSON.stringify(report);
  const liveMetaStrip = renderToStaticMarkup(
    createElement(ReportMetaStrip, { report }),
  );
  expect(JSON.stringify(report)).toBe(before);

  const markdownBoundary = rendered.markdown.indexOf("\n## 1. Verdict");
  expect(markdownBoundary).toBeGreaterThan(0);
  const markdownHeader = rendered.markdown.slice(0, markdownBoundary);
  const printHeader = rendered.print.match(
    /<header class="report-header">[\s\S]*?<\/header>/,
  )?.[0];
  expect(printHeader).toBeDefined();
  const markdownCompletenessRow = markdownHeader.match(
    /^\|\s*Data completeness\s*\|[^\r\n]*\|$/im,
  )?.[0] ?? "";
  const printCompletenessRow = printHeader?.match(
    /<tr><td>Data completeness<\/td>[\s\S]*?<\/tr>/i,
  )?.[0] ?? "";

  return {
    liveMetaStrip,
    markdownCompletenessRow,
    printCompletenessRow,
  };
}

function eachCompletenessScope(
  scopes: CompletenessScopes,
  assertion: (text: string, scope: keyof CompletenessScopes) => void,
): void {
  for (const [scope, value] of Object.entries(scopes) as Array<
    [keyof CompletenessScopes, string]
  >) {
    const text = readable(value);
    expect(text, scope).toMatch(/Data completeness/i);
    assertion(text, scope);
  }
}

function reportWithCompleteness(
  gaps: readonly ManifestEntry[],
  persisted: DataCompleteness | undefined,
): Report {
  const report = cloneTask28(task28SentinelReport());
  report.appendix.missingData = gaps.map((gap) => ({
    ...gap,
    attemptedSources: gap.attemptedSources
      ? [...gap.attemptedSources]
      : undefined,
  }));
  if (persisted === undefined) {
    delete report.meta.dataCompleteness;
  } else {
    report.meta.dataCompleteness = { ...persisted };
  }
  return report;
}

function expectNoLegacyOverclaim(text: string): void {
  expect(text).not.toMatch(/no reasoning/i);
  expect(text).not.toMatch(/computed metrics are still complete/i);
  expect(text).not.toMatch(/full (data )?coverage/i);
}

function expectUnknownCompleteness(text: string): void {
  expect(text).toMatch(/completeness unknown/i);
  expect(text).not.toMatch(/completeness confirmed/i);
  expect(text).not.toMatch(/deterministic data is complete/i);
  expectNoLegacyOverclaim(text);
}

function expectConfirmedScopes(
  scopes: CompletenessScopes,
  expected: ExpectedDimensions,
): void {
  eachCompletenessScope(scopes, (text, scope) => {
    expect(text, scope).toMatch(/completeness confirmed/i);
    expect(text, scope).toMatch(new RegExp(`state ${expected.state}`, "i"));
    expect(text, scope).toMatch(new RegExp(`critical ${expected.critical}`, "i"));
    expect(text, scope).toMatch(new RegExp(`warnings ${expected.warnings}`, "i"));
    expect(text, scope).toMatch(new RegExp(`EDGAR ${expected.edgar}`, "i"));
    expect(text, scope).toMatch(new RegExp(`XBRL ${expected.xbrl}`, "i"));
    expect(text, scope).toMatch(new RegExp(`forensics ${expected.forensics}`, "i"));
  });
}

function expectUnknownScopes(scopes: CompletenessScopes): void {
  eachCompletenessScope(scopes, (text) => {
    expectUnknownCompleteness(text);
  });
}

describe("Task 28 completeness across live, Markdown, and print report surfaces", () => {
  it("routes multiline persisted analysis reasons through one Markdown blockquote boundary", () => {
    const gap: ManifestEntry = {
      ...ANALYSIS_GAP,
      reason: "TASK28:analysis:first line\nTASK28:analysis:second | structural",
    };
    const report = reportWithCompleteness([gap], buildDataCompleteness([gap]));
    const before = JSON.stringify(report);
    const markdown = reportToMarkdown(report);
    const banner = markdown.split(/\r?\n/).find((line) =>
      line.startsWith("> ") && line.includes("No completed multi-pass analysis"));
    expect(banner).toContain(
      "TASK28:analysis:first line TASK28:analysis:second \\| structural",
    );
    expect(markdown).not.toMatch(/^TASK28:analysis:second/m);
    expect(JSON.stringify(report)).toBe(before);
  });

  it("shows the persisted analysis reason and deterministic-complete qualification for confirmed analysis-only reports", () => {
    const report = reportWithCompleteness(
      [ANALYSIS_GAP],
      buildDataCompleteness([ANALYSIS_GAP]),
    );
    const rendered = renderWithoutMutation(report);
    expectConfirmedScopes(completenessScopes(report, rendered), {
      state: "blocked",
      critical: 1,
      warnings: 0,
      edgar: "available",
      xbrl: "checked",
      forensics: "complete",
    });

    eachSurface(rendered, (text, surface) => {
      expect(text, surface).toContain(ANALYSIS_GAP.reason);
      expect(text, surface).toContain("No completed multi-pass analysis");
      expect(text, surface).toContain("Deterministic data is complete");
      expect(text, surface).toMatch(/completeness confirmed/i);
      expect(text, surface).toMatch(/state blocked/i);
      expect(text, surface).toMatch(/critical 1/i);
      expect(text, surface).toMatch(/warnings 0/i);
      expect(text, surface).toMatch(/EDGAR available/i);
      expect(text, surface).toMatch(/XBRL checked/i);
      expect(text, surface).toMatch(/forensics complete/i);
      expectNoLegacyOverclaim(text);
    });
  });

  it("reports exactly one additional actionable gap without a deterministic-complete overclaim", () => {
    const gaps: ManifestEntry[] = [
      ANALYSIS_GAP,
      {
        field: "llm.bull",
        reason: "TASK28:integration:one actionable bull gap",
        severity: "info",
        expected: false,
      },
      {
        field: "segments.structural",
        reason: "TASK28:integration:expected issuer omission",
        severity: "info",
        expected: true,
      },
    ];
    const report = reportWithCompleteness(gaps, buildDataCompleteness(gaps));
    const rendered = renderWithoutMutation(report);
    expectConfirmedScopes(completenessScopes(report, rendered), {
      state: "blocked",
      critical: 1,
      warnings: 0,
      edgar: "available",
      xbrl: "checked",
      forensics: "complete",
    });

    eachSurface(rendered, (text, surface) => {
      expect(text, surface).toContain(ANALYSIS_GAP.reason);
      expect(text, surface).toContain("1 additional data gap");
      expect(text, surface).not.toContain("1 additional data gaps");
      expect(text, surface).toContain("TASK28:integration:one actionable bull gap");
      expect(text, surface).toContain("TASK28:integration:expected issuer omission");
      expect(text, surface).not.toMatch(/deterministic data is complete/i);
      expectNoLegacyOverclaim(text);
    });
  });

  it("keeps analysis-only legacy reports data-only but marks absent completeness metadata unknown", () => {
    const report = reportWithCompleteness([ANALYSIS_GAP], undefined);
    const rendered = renderWithoutMutation(report);
    expectUnknownScopes(completenessScopes(report, rendered));

    eachSurface(rendered, (text, surface) => {
      expect(text, surface).toContain(ANALYSIS_GAP.reason);
      expect(text, surface).toContain("No completed multi-pass analysis");
      expectUnknownCompleteness(text);
      expect(text, surface).not.toMatch(/critical 1|warnings 0|EDGAR available|XBRL checked|forensics complete/i);
    });
  });

  it("marks inconsistent persisted completeness unknown instead of trusting stale dimensions", () => {
    const recomputed = buildDataCompleteness([ANALYSIS_GAP]);
    const inconsistent: DataCompleteness = {
      ...recomputed,
      warningCount: 99,
    };
    const report = reportWithCompleteness([ANALYSIS_GAP], inconsistent);
    const rendered = renderWithoutMutation(report);
    expectUnknownScopes(completenessScopes(report, rendered));

    eachSurface(rendered, (text, surface) => {
      expect(text, surface).toContain(ANALYSIS_GAP.reason);
      expect(text, surface).toContain("No completed multi-pass analysis");
      expectUnknownCompleteness(text);
      expect(text, surface).not.toMatch(/warnings 99/i);
    });
  });

  it("describes an empty legacy manifest as unrecorded rather than full coverage", () => {
    const report = reportWithCompleteness([], undefined);
    const rendered = renderWithoutMutation(report);
    expectUnknownScopes(completenessScopes(report, rendered));

    eachSurface(rendered, (text, surface) => {
      expect(text, surface).toContain("No missing-data entries recorded");
      expect(text, surface).toMatch(/not recorded|not confirmed/i);
      expectUnknownCompleteness(text);
      expect(text, surface).not.toContain("No completed multi-pass analysis");
    });
  });

  it.each(CONFIRMED_STOCK_CASES)("shows exact confirmed stock-data dimensions for ordinary $name reports", (testCase) => {
    const report = reportWithCompleteness(
      testCase.gaps,
      buildDataCompleteness(testCase.gaps),
    );
    const rendered = renderWithoutMutation(report);
    expectConfirmedScopes(completenessScopes(report, rendered), testCase);

    eachSurface(rendered, (text, surface) => {
      expect(text, surface).toMatch(/completeness confirmed/i);
      expect(text, surface).toMatch(new RegExp(`state ${testCase.state}`, "i"));
      expect(text, surface).toMatch(new RegExp(`critical ${testCase.critical}`, "i"));
      expect(text, surface).toMatch(new RegExp(`warnings ${testCase.warnings}`, "i"));
      expect(text, surface).toMatch(new RegExp(`EDGAR ${testCase.edgar}`, "i"));
      expect(text, surface).toMatch(new RegExp(`XBRL ${testCase.xbrl}`, "i"));
      expect(text, surface).toMatch(new RegExp(`forensics ${testCase.forensics}`, "i"));
      expect(text, surface).not.toContain("No completed multi-pass analysis");
      expect(text, surface).not.toMatch(/deterministic data is complete/i);
      expectNoLegacyOverclaim(text);
    });
  });
});
