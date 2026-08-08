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
} as const;

function render(grades: readonly (typeof GRADES)[number][]): string {
  return renderToStaticMarkup(createElement(
    ReportReadyPanel as ComponentType<Record<string, unknown>>,
    { summary: { ...SUMMARY, grades }, dataOnly: false, totalCost: 1.25, steps: [] },
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
});
