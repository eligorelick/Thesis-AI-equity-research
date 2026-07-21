/**
 * /report/sample — dev route that renders the full report UI (ReportView)
 * from the bundled DEMO fixture (fixtures/report/DEMO-sample.json), with NO
 * live pipeline or LLM. It lets the report surface be built and viewed offline.
 *
 * Server component: reads the fixture from disk at request time and parses it
 * through ReportSchema (the same contract the pipeline persists against), then
 * hands the validated Report to the client ReportView. A malformed fixture
 * degrades to a friendly error rather than a 500.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import Link from "next/link";

import { AppShell } from "@/components/shell";
import { ReportView } from "@/components/report/ReportView";
import { FundamentalsChartGrid, TechnicalsChartPanel } from "@/components/charts/lazy";
import { syntheticFundamentals, syntheticMarketData } from "@/components/charts/synthetic";
import { ReportSchema, type Report } from "@/report/schema";

// Reads from disk at request time — never statically pre-render.
export const dynamic = "force-dynamic";

interface LoadResult {
  report: Report | null;
  error: string | null;
}

function loadSampleReport(): LoadResult {
  try {
    const filePath = path.join(
      process.cwd(),
      "fixtures",
      "report",
      "DEMO-sample.json",
    );
    const raw = readFileSync(filePath, "utf8");
    const parsed = ReportSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return {
        report: null,
        error: `fixture failed ReportSchema validation: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      };
    }
    return { report: parsed.data, error: null };
  } catch (err) {
    return {
      report: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function Sidebar() {
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="border border-edge bg-bg">
        <div className="border-b border-edge px-2 py-1.5">
          <span className="mono text-[11px] uppercase tracking-[0.14em] text-muted">
            sample report
          </span>
        </div>
        <div className="px-2 py-1.5 text-[11px] text-muted">
          <span className="mono text-fg">DEMO</span>
          <span className="text-faint"> · synthetic fixture</span>
        </div>
      </div>
      <Link
        href="/company/DEMO"
        className="px-2 text-[11px] text-accent hover:underline"
      >
        → DEMO company slice
      </Link>
      <Link href="/" className="px-2 text-[11px] text-accent hover:underline">
        ← home
      </Link>
    </div>
  );
}

export default function ReportSamplePage() {
  const { report, error } = loadSampleReport();

  // Synthetic, deterministic chart data so the full UI (price/RS/fundamentals
  // charts) is viewable offline without a live pipeline or API key.
  const market = syntheticMarketData(report?.meta.symbol ?? "DEMO");
  const fundamentals = syntheticFundamentals();

  return (
    <AppShell sidebar={<Sidebar />}>
      {report ? (
        <ReportView
          report={report}
          technicalsChart={
            <TechnicalsChartPanel
              bars={market.bars}
              crosses={market.crosses}
              relativeStrength={market.relativeStrength}
            />
          }
          fundamentalsChart={
            <div className="p-3">
              <FundamentalsChartGrid data={fundamentals} />
            </div>
          }
        />
      ) : (
        <div className="mx-auto max-w-2xl p-6">
          <div className="border border-neg/40 bg-neg/10 px-4 py-3 text-[12px] text-neg">
            <div className="mono font-semibold">sample report unavailable</div>
            <p className="mt-1 text-muted">{error}</p>
          </div>
        </div>
      )}
    </AppShell>
  );
}
