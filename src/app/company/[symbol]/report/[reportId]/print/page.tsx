/**
 * /company/[symbol]/report/[reportId]/print — a minimal, print-optimized full
 * report for dependency-free PDF export (the browser prints this page to PDF).
 *
 * Intentionally LIGHT (dark-on-light) and standalone: it does NOT render the
 * AppShell chrome (no sidebar/header/footer), so the printed page is clean
 * paper. The report body + print CSS come from the SHARED renderer
 * (src/report/export/printHtml.ts), so this page and the ?format=pdf route are
 * byte-identical in content.
 *
 * `?autoprint=1` mounts the tiny <AutoPrint> client component, which fires the
 * browser print dialog on load — this is what the "Export PDF" button opens.
 *
 * Server component: reads the report by id at request time; a malformed / missing
 * report degrades to a friendly light-themed message, never a 500. The
 * disclaimer is rendered inside the report body (meta.disclaimer), satisfying
 * the product requirement even though AppShell's footer is absent here.
 */

import type { Metadata } from "next";

import { getReportByIdForSymbol, parseReportId } from "@/report/history";
import { reportToPrintBody, PRINT_CSS } from "@/report/export/printHtml";
import { AutoPrint } from "@/components/report/AutoPrint";

// Reads persisted rows at request time — never statically pre-render.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Thesis — printable report",
};

export default async function PrintReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ symbol: string; reportId: string }>;
  searchParams: Promise<{ autoprint?: string }>;
}) {
  const { symbol: rawSymbol, reportId: rawId } = await params;
  const { autoprint } = await searchParams;
  const symbol = decodeURIComponent(rawSymbol).toUpperCase().trim();
  const reportId = parseReportId(rawId);

  const loaded = reportId !== null ? getReportByIdForSymbol(reportId, symbol) : null;

  // Friendly light-themed fallback (this page is not inside AppShell).
  if (loaded === null) {
    return (
      <>
        <style>{FALLBACK_CSS}</style>
        <main className="print-fallback">
          <h1>Report unavailable</h1>
          <p>
            No readable report was found for id <code>{rawId}</code>
            {` (${symbol})`}. It may not exist, or its stored content could not
            be parsed.
          </p>
        </main>
      </>
    );
  }

  const bodyHtml = reportToPrintBody(loaded.report);
  const shouldAutoPrint = autoprint === "1";

  return (
    <>
      <style>{PRINT_CSS}</style>
      {/* Body HTML is assembled from schema-validated report content with every
          interpolated string HTML-escaped in printHtml.ts (esc()); no
          user-controlled markup is injected. */}
      <div
        className="print-doc"
        dangerouslySetInnerHTML={{ __html: bodyHtml }}
      />
      {shouldAutoPrint && <AutoPrint />}
    </>
  );
}

const FALLBACK_CSS = `
:root { color-scheme: light; }
body { margin: 0; background: #fff; color: #16181d; font-family: Georgia, serif; }
.print-fallback { max-width: 40rem; margin: 4rem auto; padding: 0 1.5rem; }
.print-fallback h1 { font-size: 20pt; }
.print-fallback code { font-family: Consolas, monospace; background: #f1f3f6; padding: 1px 4px; }
`;
