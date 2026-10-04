import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GradeReasoning } from "@/components/report/primitives";
import { CatalystsRisksPanel, CompositeScorecard, GradeStripBar } from "@/components/report/sections";
import { applyReportAssessmentStatus, gradeDisplayLabel, gradeForDisplay } from "@/report/assessment";
import { parseStoredReportWithSafety } from "@/report/legacyEntitySafety";
import { extractGradeStrip } from "@/report/history";
import { diffReports } from "@/report/diff";
import { reportToMarkdown } from "@/report/export/markdown";
import { reportToPrintBody } from "@/report/export/printHtml";
import { judgeOutputToJsonSchema, ReportSchema } from "@/report/schema";
import { task28SentinelReport } from "./helpers/task28Report";

describe("assessment presentation", () => {
  it("withholds sparse full-AI headlines on immutable stored reads across sections, history, and exports", () => {
    const report = task28SentinelReport();
    const narrative = "JUDGMENT: Retain the computed band, explicitly qualified by sparse coverage.";
    report.verdict.gradeStrip.quality = { ...report.verdict.gradeStrip.quality, grade: "A", oneLineWhy: narrative };
    report.quality.graded = { ...report.quality.graded, grade: "A", oneLineWhy: "A narrow favorable signal, not comprehensive quality assurance." };
    report.balanceSheet.graded = { ...report.quality.graded, grade: "C", oneLineWhy: "Mandatory neutral placeholder, no computed band is available." };
    report.verdict.gradeStrip.balanceSheet = { ...report.balanceSheet.graded };
    report.scores!.aspects.quality = { ...report.scores!.aspects.quality, score: 96, band: "A", dataCompleteness: 0.05 };
    report.scores!.aspects.balanceSheet = { ...report.scores!.aspects.balanceSheet, score: null, band: null, dataCompleteness: 0 };
    report.scores!.aspects.moat = { ...report.scores!.aspects.moat, score: 80, band: "B", dataCompleteness: 0.1 };
    const original = JSON.stringify(report);
    expect(report.appendix.missingData.some((gap) => gap.field === "analysis.llm")).toBe(false);
    const safe = parseStoredReportWithSafety(original)?.report;
    expect(safe).toBeDefined();
    if (!safe) return;
    for (const [strip, section] of [
      [safe.verdict.gradeStrip.quality, safe.quality.graded],
      [safe.verdict.gradeStrip.balanceSheet!, safe.balanceSheet.graded!],
      [safe.verdict.gradeStrip.moat, safe.competitive.moatGraded],
    ]) {
      expect(gradeForDisplay(strip!)).toBeNull();
      expect(section!.assessmentStatus).toBe(strip!.assessmentStatus);
      expect(renderToStaticMarkup(createElement(GradeReasoning, { title: "Assessment", block: section! }))).toContain('aria-label="not assessed"');
    }
    expect(safe.quality.graded).toEqual({ ...report.quality.graded, assessmentStatus: "limited-evidence" });
    expect(safe.verdict.gradeStrip.quality).toEqual({ ...report.verdict.gradeStrip.quality, assessmentStatus: "limited-evidence" });
    expect(safe.balanceSheet.graded?.assessmentStatus).toBe("not-assessed");
    expect(safe.scores).toEqual(report.scores);
    expect(extractGradeStrip(safe).filter((cell) => ["quality", "balanceSheet", "moat"].includes(cell.key)).every((cell) => cell.grade === null)).toBe(true);
    for (const text of [reportToMarkdown(safe), reportToPrintBody(safe)]) {
      expect(text).toContain("Not assessed — limited evidence");
      expect(text).toContain(narrative);
    }
    expect(JSON.stringify(report)).toBe(original);
    expect(applyReportAssessmentStatus(safe)).toEqual(safe);
  });

  it("keeps supported grades at the coverage boundary and never upgrades an existing withheld assessment", () => {
    const report = task28SentinelReport();
    report.scores!.aspects.quality.dataCompleteness = 0.5;
    report.verdict.gradeStrip.quality.assessmentStatus = "not-assessed";
    report.scores!.aspects.valuation.dataCompleteness = 0.5;
    const safe = applyReportAssessmentStatus(report);
    expect(safe.quality.graded.assessmentStatus).toBe("not-assessed");
    expect(gradeForDisplay(safe.verdict.gradeStrip.valuation)).toBe(report.verdict.gradeStrip.valuation.grade);
    delete report.scores;
    expect(applyReportAssessmentStatus(report)).toEqual(report);
  });

  it("withholds when either deterministic score or band is unavailable without fabricating optional legacy blocks", () => {
    const report = task28SentinelReport();
    report.scores!.aspects.quality.band = null;
    report.scores!.aspects.valuation.score = null;
    report.scores!.aspects.balanceSheet.score = null;
    delete report.verdict.gradeStrip.balanceSheet;
    delete report.balanceSheet.graded;
    const safe = applyReportAssessmentStatus(report);
    expect(safe.quality.graded.assessmentStatus).toBe("not-assessed");
    expect(safe.valuation.graded.assessmentStatus).toBe("not-assessed");
    expect(safe.verdict.gradeStrip.balanceSheet).toBeUndefined();
    expect(safe.balanceSheet.graded).toBeUndefined();
  });

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
