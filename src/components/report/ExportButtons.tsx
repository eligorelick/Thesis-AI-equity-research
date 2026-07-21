"use client";

/**
 * ExportButtons — the "Export MD" / "Export PDF" pair the integrator mounts on
 * the report/company pages (the application contract §8 export).
 *
 *   - Export MD  → navigates to /api/export/[reportId]?format=md, which returns
 *     a text/markdown attachment (the browser downloads it).
 *   - Export PDF → opens the light print page
 *     /company/[symbol]/report/[reportId]/print?autoprint=1 in a new tab, which
 *     auto-fires the browser print dialog (dependency-free PDF via print-to-PDF).
 *
 * Pure client interactivity — no data fetching, no server-only imports. Styled
 * to match the dense terminal UI (this component renders on the dark app pages,
 * NOT on the light print page). Takes only the ids/symbol it needs as props.
 */

import { useState } from "react";

export function ExportButtons({
  reportId,
  symbol,
  className,
}: {
  reportId: number;
  symbol: string;
  /** Optional extra classes for the wrapper (layout at the mount site). */
  className?: string;
}) {
  const [busy, setBusy] = useState<null | "md" | "pdf">(null);

  const sym = encodeURIComponent(symbol);
  const mdHref = `/api/export/${reportId}?format=md`;
  const printHref = `/company/${sym}/report/${reportId}/print?autoprint=1`;

  const onExportMd = (): void => {
    setBusy("md");
    // Trigger a download without navigating away: a transient anchor click.
    const a = document.createElement("a");
    a.href = mdHref;
    a.rel = "noopener";
    // `download` hints the filename; the route's Content-Disposition is
    // authoritative and carries the symbol-derived name.
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => setBusy(null), 600);
  };

  const onExportPdf = (): void => {
    setBusy("pdf");
    window.open(printHref, "_blank", "noopener,noreferrer");
    window.setTimeout(() => setBusy(null), 600);
  };

  return (
    <div className={`flex items-center gap-1.5 ${className ?? ""}`}>
      <ExportButton
        onClick={onExportMd}
        busy={busy === "md"}
        label="Export MD"
        title="Download the full report as Markdown"
      />
      <ExportButton
        onClick={onExportPdf}
        busy={busy === "pdf"}
        label="Export PDF"
        title="Open a print-optimized page and print to PDF"
      />
    </div>
  );
}

function ExportButton({
  onClick,
  busy,
  label,
  title,
}: {
  onClick: () => void;
  busy: boolean;
  label: string;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={title}
      className="mono border border-edge-strong px-2 py-1 text-[10px] uppercase tracking-[0.1em] text-muted transition-colors hover:border-accent hover:text-accent disabled:cursor-wait disabled:opacity-60"
    >
      {busy ? "…" : label}
    </button>
  );
}
