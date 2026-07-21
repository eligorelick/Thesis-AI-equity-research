/**
 * GET /api/report/view/[reportId] — compact report summary for the "report
 * ready" panel the GenerateReport client renders once a job finishes.
 *
 * Returns just what the compact panel needs (verdict synthesis + grade strip +
 * verification rate + cost + the data-only signal), read from the persisted
 * reports row — NOT the full Report (full rendering is a later UI wave). Parses
 * the stored reportJson defensively so a malformed row degrades to a friendly
 * payload rather than a 500.
 *
 * 400 when the report id is malformed (strict — digits only, so "12abc"/
 * "12.9"/"1e5" are rejected rather than truncated to another report's id);
 * 404 when the report id is unknown. Server-only (nodejs runtime).
 */

import { NextResponse } from "next/server";
import { getReportRecordById, parseReportId } from "@/report/history";
import type { Report } from "@/report/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A single grade in the compact strip. */
export interface GradeStripCell {
  key: string;
  grade: string;
  oneLineWhy: string;
}

/** The compact summary shape the GenerateReport panel consumes. */
export interface ReportSummary {
  reportId: number;
  symbol: string;
  companyName: string;
  model: string;
  createdAt: string;
  costUsd: number | null;
  verificationRate: number | null;
  synthesis: string;
  grades: GradeStripCell[];
  /** True when this is a data-only report (LLM analysis did not run). */
  dataOnly: boolean;
}

const GRADE_KEYS = [
  "fundamentals",
  "valuation",
  "technicals",
  "quality",
  "leadership",
  "moat",
] as const;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ reportId: string }> },
): Promise<NextResponse<ReportSummary | { error: string }>> {
  const { reportId: reportIdRaw } = await params;
  const reportId = parseReportId(reportIdRaw);
  if (reportId === null) {
    return NextResponse.json(
      { error: "invalid report id — must be a plain decimal integer" },
      { status: 400 },
    );
  }

  const record = getReportRecordById(reportId);
  if (record.kind === "missing") {
    return NextResponse.json({ error: `no report with id ${reportId}` }, { status: 404 });
  }

  // Per this route's contract, a row whose stored JSON is missing/unparseable
  // degrades to a friendly 200 payload (report: null path below) — the panel
  // shows "content unavailable" rather than an error.
  const row = record.row;
  const report: Report | null = record.kind === "ok" ? record.report : null;

  const grades: GradeStripCell[] = report
    ? GRADE_KEYS.map((key) => {
        const cell = report.verdict.gradeStrip[key];
        return { key, grade: cell.grade, oneLineWhy: cell.oneLineWhy };
      })
    : [];

  const dataOnly =
    report?.appendix.missingData.some((m) => m.field === "analysis.llm") ?? true;

  return NextResponse.json({
    reportId,
    symbol: row.symbol,
    companyName: report?.meta.companyName ?? row.symbol,
    model: row.model,
    createdAt: row.createdAt,
    costUsd: row.costUsd,
    verificationRate: row.verificationRate,
    synthesis: report?.verdict.synthesis ?? "Report content unavailable.",
    grades,
    dataOnly,
  });
}
