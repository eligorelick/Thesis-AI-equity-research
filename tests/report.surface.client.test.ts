import { readFileSync } from "node:fs";
import path from "node:path";

import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import { ReportReadyPanel } from "@/app/company/[symbol]/GenerateReport";

const GRADES = [
  { key: "fundamentals", grade: "A", oneLineWhy: "fundamentals sentinel" },
  { key: "valuation", grade: "B", oneLineWhy: "valuation sentinel" },
  { key: "technicals", grade: "C", oneLineWhy: "technicals sentinel" },
  { key: "balanceSheet", grade: "D", oneLineWhy: "balance sentinel" },
  { key: "quality", grade: "F", oneLineWhy: "quality sentinel" },
  { key: "leadership", grade: "A", oneLineWhy: "leadership sentinel" },
  { key: "moat", grade: "B", oneLineWhy: "moat sentinel" },
] as const;
const LEGACY_DATA_ONLY_GRADES = GRADES
  .filter((grade) => grade.key !== "balanceSheet")
  .map((grade) => ({ ...grade, grade: "F" })) as readonly (typeof GRADES)[number][];

const SUMMARY = {
  reportId: 11,
  symbol: "AAPL",
  companyName: "Apple Inc.",
  model: "test-model",
  createdAt: "2026-08-08T00:00:00.000Z",
  costUsd: 1.25,
  verificationRate: 0.8,
  synthesis: "current synthesis",
  grades: GRADES,
  dataOnly: false,
  dataCompleteness: {
    state: "complete",
    criticalCount: 0,
    warningCount: 0,
    edgar: "available",
    xbrl: "checked",
    forensicValidation: "complete",
  },
  missingData: [],
} as const;

function render(grades: readonly (typeof GRADES)[number][]): string {
  return renderSummary({ ...SUMMARY, grades });
}

function renderSummary(summary: Record<string, unknown> | null, snapshotDataOnly = false): string {
  return renderToStaticMarkup(createElement(
    ReportReadyPanel as ComponentType<Record<string, unknown>>,
    { summary, dataOnly: snapshotDataOnly, totalCost: 1.25, steps: [] },
  ));
}

describe("manifest-driven GenerateReport report-ready panel", () => {
  it("uses the exported report-ready renderer in the live summary branch", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src", "app", "company", "[symbol]", "GenerateReport.tsx"),
      "utf8",
    );
    const liveCalls = source.match(/<ReportReadyPanel\b[^>]*>/g) ?? [];
    expect(liveCalls).toHaveLength(1);
    expect(liveCalls[0]).toContain("summary={summary}");
    const occurrences = source.match(/summary\.grades\.map/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(source).not.toMatch(/from\s+["']@\/report\/schema["']/);
    expect(source).toContain("hasExactKeys(value, DATA_COMPLETENESS_FIELD_ORDER)");
    expect(source).not.toMatch(/const\s+DATA_COMPLETENESS_KEYS\b/);
  });

  it("renders descriptor labels for all seven canonical grades instead of raw keys", () => {
    const html = render(GRADES);
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
      const next = html.indexOf(`>${label}<`);
      expect(next, label).toBeGreaterThan(cursor);
      cursor = next;
    }
    expect(html).not.toContain(">balanceSheet<");
    expect(html).toContain("lg:grid-cols-7");
  });

  it("omits only absent optional balance for a validated legacy summary", () => {
    const html = render(GRADES.filter((grade) => grade.key !== "balanceSheet"));
    expect(html).not.toContain(">Balance Sheet<");
    expect(html).not.toContain(">balanceSheet<");
    for (const label of ["Fundamentals", "Valuation", "Technicals", "Quality / Red-Flags", "Leadership", "Moat"]) {
      expect(html).toContain(`>${label}<`);
    }
  });

  it("renders the persisted analysis reason and exact additional actionable-gap count", () => {
    const html = renderSummary({
      ...SUMMARY,
      grades: LEGACY_DATA_ONLY_GRADES,
      dataOnly: true,
      dataCompleteness: {
        state: "blocked",
        criticalCount: 1,
        warningCount: 0,
        edgar: "available",
        xbrl: "checked",
        forensicValidation: "complete",
      },
      missingData: [
        {
          field: "analysis.llm",
          reason: "TASK28:persisted:analysis-reason",
          severity: "critical",
          attemptedSources: ["anthropic"],
        },
        {
          field: "llm.bull",
          reason: "TASK28:persisted:additional-gap",
          severity: "info",
          expected: false,
        },
        {
          field: "projections.eps.shareCountTrend",
          reason: "TASK28:persisted:expected-disclosure",
          severity: "warn",
          expected: true,
        },
      ],
    }, false);
    expect(html).toContain("data-only");
    expect(html).not.toContain(">analyzed<");
    expect(html).toContain("No completed multi-pass analysis");
    expect(html).toContain("TASK28:persisted:analysis-reason");
    expect(html).toContain("1 additional data gap");
    expect(html).not.toMatch(/did not run|no reasoning/i);
    expect(html).not.toContain("computed metrics are still complete");
    expect(html).not.toContain("Deterministic data is complete");
  });

  it("uses persisted analyzed truth after arrival but keeps the snapshot cost", () => {
    const html = renderSummary({ ...SUMMARY, costUsd: 0.4, dataOnly: false }, true);
    expect(html).toContain(">analyzed<");
    expect(html).not.toContain("data-only");
    expect(html).toContain("$1.2500");
    expect(html).not.toContain("$0.4000");
  });

  it("renders malformed compact truth as unknown rather than analyzed or data-only", () => {
    const html = renderSummary({
      ...SUMMARY,
      grades: [],
      dataOnly: null,
      dataCompleteness: null,
      missingData: null,
    });
    expect(html).toContain("completeness unknown");
    expect(html).toMatch(/not recorded|not confirmed/i);
    expect(html).not.toContain(">analyzed<");
    expect(html).not.toContain("data-only");
    expect(html).not.toMatch(/full (data )?coverage/i);
  });

  it("surfaces structurally valid but inconsistent persisted completeness as unknown", () => {
    const html = renderSummary({
      ...SUMMARY,
      dataCompleteness: { ...SUMMARY.dataCompleteness, warningCount: 99 },
      missingData: [],
    });
    expect(html).toContain(">analyzed<");
    expect(html).toContain("completeness unknown");
    expect(html).toMatch(/not confirmed|could not be confirmed/i);
    expect(html).not.toMatch(/full (data )?coverage/i);
    expect(html).not.toContain("Deterministic data is complete");
  });

  it("surfaces parseable legacy missing metadata as unknown without changing analyzed truth", () => {
    const html = renderSummary({
      ...SUMMARY,
      dataCompleteness: null,
      missingData: [{
        field: "shares.float",
        reason: "TASK28:legacy:metadata-not-recorded",
        severity: "info",
        expected: false,
      }],
    });
    expect(html).toContain(">analyzed<");
    expect(html).toContain("completeness unknown");
    expect(html).toMatch(/not recorded|not confirmed/i);
    expect(html).toContain("TASK28:legacy:metadata-not-recorded");
    expect(html).not.toContain("data-only");
    expect(html).not.toMatch(/full (data )?coverage/i);
    expect(html).not.toContain("Deterministic data is complete");
  });

  it("keeps legacy analysis.llm data-only while marking absent completeness metadata unknown", () => {
    const html = renderSummary({
      ...SUMMARY,
      grades: LEGACY_DATA_ONLY_GRADES,
      dataOnly: true,
      dataCompleteness: null,
      missingData: [{
        field: "analysis.llm",
        reason: "TASK28:legacy:data-only:metadata-not-recorded",
        severity: "critical",
        attemptedSources: ["anthropic"],
      }],
    });
    expect(html).toContain("data-only");
    expect(html).toContain("completeness unknown");
    expect(html).toContain("No completed multi-pass analysis");
    expect(html).toMatch(/not recorded|not confirmed/i);
    expect(html).toContain("TASK28:legacy:data-only:metadata-not-recorded");
    expect(html).not.toMatch(/did not run|no reasoning/i);
    expect(html).not.toContain(">analyzed<");
    expect(html).not.toMatch(/full (data )?coverage/i);
    expect(html).not.toContain("Deterministic data is complete");
  });

  it("renders confirmed complete and blocked provider states with all six persisted leaves", () => {
    const completeHtml = renderSummary(SUMMARY);
    expect(completeHtml).toContain("completeness confirmed");
    expect(completeHtml).toContain("complete");
    expect(completeHtml).toContain("0 critical");
    expect(completeHtml).toContain("0 warning");
    expect(completeHtml).toContain("EDGAR available");
    expect(completeHtml).toContain("XBRL checked");
    expect(completeHtml).toContain("forensic validation complete");

    const blockedHtml = renderSummary({
      ...SUMMARY,
      dataCompleteness: {
        state: "blocked",
        criticalCount: 1,
        warningCount: 1,
        edgar: "missing",
        xbrl: "skipped",
        forensicValidation: "provisional",
      },
      missingData: [
        {
          field: "edgar.companyFacts",
          reason: "TASK28:blocked:company-facts",
          severity: "critical",
          attemptedSources: ["sec"],
        },
        {
          field: "edgar.xbrl",
          reason: "TASK28:blocked:xbrl skipped",
          severity: "warn",
        },
      ],
    });
    expect(blockedHtml).toContain(">analyzed<");
    expect(blockedHtml).toContain("completeness confirmed");
    expect(blockedHtml).toContain("blocked");
    expect(blockedHtml).toContain("1 critical");
    expect(blockedHtml).toContain("1 warning");
    expect(blockedHtml).toContain("EDGAR missing");
    expect(blockedHtml).toContain("XBRL skipped");
    expect(blockedHtml).toContain("forensic validation provisional");
    expect(blockedHtml).not.toContain("Deterministic data is complete");
  });

  it("uses deterministic-complete wording only for confirmed analysis.llm-only metadata", () => {
    const html = renderSummary({
      ...SUMMARY,
      grades: LEGACY_DATA_ONLY_GRADES,
      dataOnly: true,
      dataCompleteness: {
        state: "blocked",
        criticalCount: 1,
        warningCount: 0,
        edgar: "available",
        xbrl: "checked",
        forensicValidation: "complete",
      },
      missingData: [{
        field: "analysis.llm",
        reason: "TASK28:confirmed:analysis-only",
        severity: "critical",
        attemptedSources: ["anthropic"],
      }],
    });
    expect(html).toContain("data-only");
    expect(html).toContain("TASK28:confirmed:analysis-only");
    expect(html).toContain("Deterministic data is complete");
    expect(html).not.toMatch(/did not run|no reasoning/i);
  });

  it("uses snapshot truth only before a persisted summary arrives", () => {
    const html = renderSummary(null, true);
    expect(html).toContain("data-only");
    expect(html).toContain("No completed multi-pass analysis");
    expect(html).not.toMatch(/did not run|no reasoning/i);
    expect(html).not.toContain(">analyzed<");
  });
});
