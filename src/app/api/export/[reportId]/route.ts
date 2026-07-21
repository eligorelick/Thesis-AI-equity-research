/**
 * GET /api/export/[reportId] — download a persisted report as a shareable file.
 *
 *   ?format=md  (default) → text/markdown attachment (reportToMarkdown), the
 *                clean, complete, deterministic Markdown rendering.
 *   ?format=pdf          → a self-contained, print-optimized HTML document
 *                (light background, print CSS) that the browser prints to PDF.
 *                NO new dependencies — the "PDF" is produced by the browser's
 *                own print-to-PDF from this HTML. (The dedicated print *page*
 *                at /company/[symbol]/report/[reportId]/print is the richer
 *                surface with auto-print; this route is the dependency-free
 *                fallback so an export link works even without the page.)
 *
 * Server-only (nodejs runtime). 400 on a malformed report id (strict — digits
 * only, so "12abc"/"12.9"/"1e5" are rejected rather than truncated to another
 * report's id) or an unknown format; 404 on an unknown id; 422 when the row
 * exists but its stored JSON is missing or unparseable.
 */

import { getReportRecordById, parseReportId } from "@/report/history";
import { reportToMarkdown } from "@/report/export/markdown";
import { reportToPrintHtml } from "@/report/export/printHtml";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Filesystem-safe slug for the download filename. */
function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "report";
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ reportId: string }> },
): Promise<Response> {
  const { reportId: reportIdRaw } = await params;
  const reportId = parseReportId(reportIdRaw);
  if (reportId === null) {
    return jsonError("invalid report id — must be a plain decimal integer", 400);
  }

  const format = (new URL(request.url).searchParams.get("format") ?? "md")
    .toLowerCase()
    .trim();
  if (format !== "md" && format !== "pdf") {
    return jsonError(`unknown format "${format}" — use md or pdf`, 400);
  }

  const record = getReportRecordById(reportId);
  if (record.kind === "missing") {
    return jsonError(`report ${reportId} not found`, 404);
  }
  if (record.kind === "unparseable") {
    // The id IS known — the row exists but its stored content cannot be
    // rendered. 422, not 404, per this route's contract.
    return jsonError(
      `report ${reportId} exists but its stored content is missing or unparseable — cannot export`,
      422,
    );
  }

  const { report } = record;
  const base = `${slug(report.meta.symbol)}-report-${reportId}`;

  if (format === "md") {
    const md = reportToMarkdown(report);
    return new Response(md, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${base}.md"`,
        "Cache-Control": "no-store",
      },
    });
  }

  // format === "pdf": self-contained print-optimized HTML.
  const html = reportToPrintHtml(report, { autoPrint: true });
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // inline so the browser renders it (and its print dialog can fire),
      // rather than downloading raw HTML.
      "Content-Disposition": `inline; filename="${base}.html"`,
      "Cache-Control": "no-store",
    },
  });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
