import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GradeReasoning } from "@/components/report/primitives";
import { CatalystsRisksPanel, CompositeScorecard, GradeStripBar } from "@/components/report/sections";
import { gradeDisplayLabel, gradeForDisplay } from "@/report/assessment";
import { extractGradeStrip } from "@/report/history";
import { diffReports } from "@/report/diff";
import { reportToMarkdown } from "@/report/export/markdown";
import { reportToPrintBody } from "@/report/export/printHtml";
import { judgeOutputToJsonSchema, ReportSchema } from "@/report/schema";
import { task28SentinelReport } from "./helpers/task28Report";

describe("assessment presentation", () => {
  it("withholds unsupported headline letters consistently in the live view, history and diff", () => {
    const report = task28SentinelReport();
    const block = { ...report.verdict.gradeStrip.quality, grade: "A" as const, assessmentStatus: "limited-evidence" as const,
      oneLineWhy: "Not assessed — limited evidence. Raw deterministic score 96/100 on 10% of intended signals." };
    report.verdict.gradeStrip.quality = block;
    report.quality.graded = block;
    report.scores!.aspects.quality = { ...report.scores!.aspects.quality, score: 96, band: "A", dataCompleteness: 0.1 };
    expect(ReportSchema.safeParse(report).success).toBe(true);
    expect(gradeForDisplay(block)).toBeNull();
    expect(gradeDisplayLabel(block)).toBe("Not assessed — limited evidence");
    const section = renderToStaticMarkup(createElement(GradeReasoning, { title: "Quality", block }));
    expect(section).toContain('aria-label="not assessed"');
    expect(section).not.toContain('aria-label="grade A"');
    expect(renderToStaticMarkup(createElement(GradeStripBar, { gradeStrip: report.verdict.gradeStrip }))).toContain('aria-label="not assessed"');
    expect(renderToStaticMarkup(createElement(CompositeScorecard, { scores: report.scores! }))).toContain("limited evidence");
    expect(extractGradeStrip(report).find((cell) => cell.key === "quality")?.grade).toBeNull();
    const previous = structuredClone(report);
    previous.verdict.gradeStrip.quality.grade = "D";
    expect(diffReports(previous, report, {
      fromReportVersion: previous.meta.pipelineVersion, toReportVersion: report.meta.pipelineVersion,
      fromSpecVersion: previous.meta.specVersion, toSpecVersion: report.meta.specVersion,
    }).gradeChanges).toEqual([]);
    expect(JSON.stringify(judgeOutputToJsonSchema())).not.toContain("assessmentStatus");
  });

  it("hides previously persisted placeholder letters without rewriting the underlying record", () => {
    const block = task28SentinelReport().verdict.gradeStrip.moat;
    block.grade = "D";
    block.oneLineWhy = "Not scored — no applicable signals. The letter D is a placeholder, not an assessment.";
    expect(gradeForDisplay(block)).toBeNull();
    block.grade = "F";
    block.oneLineWhy = "Not graded — Stage B did not run; no completed analyst assessment is available.";
    expect(gradeForDisplay(block)).toBeNull();
    block.grade = "A";
    block.oneLineWhy = "Deterministic score 96/100 (band A) on 10% of intended signals; no analyst pass ran.";
    expect(gradeForDisplay(block)).toBeNull();
    block.oneLineWhy = "Deterministic score 96/100 (band A) on 75% of intended signals; no analyst pass ran.";
    expect(gradeForDisplay(block)).toBe("A");
  });

  it("does not display empty risk matrices or historical template coverage as completed analysis", () => {
    const report = task28SentinelReport();
    report.appendix.missingData.push({ field: "analysis.llm", reason: "Bull request failed", severity: "critical" });
    report.catalystsRisks = { catalysts: [], risks: [] };
    report.appendix.provenanceCoverage = { numeric: { supported: 7, total: 7, rate: 1 }, factualClaims: { supported: 7, total: 7, rate: 1 }, judgments: { cited: 0, total: 0, rate: null } };
    const live = renderToStaticMarkup(createElement(CatalystsRisksPanel, { catalystsRisks: report.catalystsRisks, dataOnly: true }));
    expect(live).toContain("Not assessed");
    expect(live).not.toContain("none identified");
    expect(live).not.toContain("0 catalysts");
    expect(live).not.toContain("<table");
    for (const text of [reportToMarkdown(report), reportToPrintBody(report)]) {
      expect(text).toContain("No completed citation-check pass");
      expect(text).not.toContain("7/7 (100%)");
      expect(text).toContain("Empty lists do not establish");
    }
  });
});
