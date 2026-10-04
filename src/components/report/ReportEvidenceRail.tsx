import type { Report } from "@/report/schema";
import { deriveReportCompletenessPresentation } from "@/report/completeness";
import { REPORT_SECTION_MANIFEST } from "@/report/sectionManifest";
import { sectionAnchorId } from "./primitives";

/** Recorded snapshot context; no new fetch, confidence score or inferred date. */
export function ReportEvidenceRail({ report }: { report: Report }) {
  const completeness = deriveReportCompletenessPresentation(report.meta.dataCompleteness, report.appendix.missingData);
  const dates = Object.entries(report.meta.asOfMap);
  return (
    <aside className="workspace-evidence-rail" aria-label="Report evidence and gaps">
      <h2 className="text-[14px] font-semibold">Evidence &amp; gaps</h2>
      <p className="mt-2 text-[12px] text-muted">Report snapshot · {report.meta.symbol}</p>
      <dl className="mt-2 space-y-2 text-[12px]">
        <div><dt className="text-faint">Generated</dt><dd className="mono break-words">{report.meta.generatedAt}</dd></div>
        <div><dt className="text-faint">Analysis model</dt><dd className="break-words">{report.meta.model}</dd></div>
      </dl>
      <p className="mt-3 text-[12px] text-muted">{completeness.statusText}</p>
      <p className="mt-2 text-[11px] text-faint">Incident counts follow the report&apos;s completeness policy. Recorded entries below also include expected and fixture omissions.</p>
      <details className="mt-3">
        <summary className="cursor-pointer text-[12px] font-medium">Recorded gaps ({report.appendix.missingData.length})</summary>
        <ul className="mt-2 max-h-72 space-y-3 overflow-y-auto text-[12px]">
          {report.appendix.missingData.map((gap, index) => (
            <li key={`${gap.field}-${index}`}>
              <span className="block break-words font-medium">{gap.field}</span>
              <span className="block text-faint">{gap.severity}{gap.expected ? " · expected omission" : ""}</span>
              <span className="block break-words text-muted">{gap.reason}</span>
            </li>
          ))}
        </ul>
      </details>
      <details className="mt-3">
        <summary className="cursor-pointer text-[12px] font-medium">Observation dates ({dates.length})</summary>
        <dl className="mt-2 max-h-60 space-y-2 overflow-y-auto text-[11px]">
          {dates.map(([source, date]) => <div key={source}><dt className="break-words text-faint">{source}</dt><dd className="mono break-words">{date}</dd></div>)}
        </dl>
        {dates.length === 0 && <p className="mt-2 text-[12px] text-muted">Observation dates were not recorded.</p>}
      </details>
      <p className="mt-3 text-[11px] text-faint">{report.appendix.sources.length} recorded source entries. Citation coverage describes traceability, not correctness.</p>
      <a href={`#${sectionAnchorId("appendix")}`} className="mt-2 block text-[12px] text-accent underline">Open sources &amp; full manifest</a>
      <nav aria-label="Report sections" className="mt-4 grid gap-1 border-t border-edge pt-3">
        {REPORT_SECTION_MANIFEST.map((section) => <a key={section.key} className="rounded px-1 py-1 text-[12px] text-muted hover:bg-raised hover:text-accent" href={`#${sectionAnchorId(section.key)}`}>{section.label}</a>)}
      </nav>
    </aside>
  );
}
