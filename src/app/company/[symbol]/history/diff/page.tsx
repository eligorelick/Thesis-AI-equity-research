/**
 * /company/[symbol]/history/diff?a=&b= — the report diff view (the application contract §8).
 *
 * Loads two persisted reports by id, orders them chronologically (older →
 * newer, since diffReports is defined that way), runs {@link diffReports}, and
 * renders the deltas so they are instantly scannable:
 *   - grade changes: from → to, arrow + color by grade DIRECTION (A>B>…>F, so
 *     a move toward A is positive/green, toward F negative/red);
 *   - scenario price-target changes: from → to with a colored pctChange;
 *   - new / removed catalysts and risks (added = pos, removed = faint + strike);
 *   - a verdict-changed flag and the cost delta.
 *
 * Edge cases handled gracefully (no 500):
 *   - missing/invalid ?a or ?b (strict digits-only parse) → a friendly "pick
 *     two reports" state;
 *   - unknown / unparseable report id → an "unavailable" message;
 *   - an id that belongs to a DIFFERENT company than the route symbol → the
 *     same "unavailable" message (never a cross-company diff under this
 *     company's header);
 *   - a === b (same report) → a clear "same report" notice, no diff run;
 *   - a pair chosen out of order → silently reordered, with a small note.
 */

import Link from "next/link";

import { AppShell } from "@/components/shell";
import { GradeChip, Badge, Panel } from "@/components/ui";
import type { Grade } from "@/types/core";
import {
  loadReportPairForSymbol,
  orderPairChronologically,
  parseReportId,
  type LoadedReport,
} from "@/report/history";
import {
  diffReports,
  type GradeChange,
  type TargetChange,
  type ScoreChange,
  type ProjectionChange,
  type ReportDiff,
} from "@/report/diff";

export const dynamic = "force-dynamic";

/* ------------------------------------------------------------------------ *
 * Sidebar
 * ------------------------------------------------------------------------ */

function Sidebar({ symbol }: { symbol: string }) {
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="border border-edge bg-bg">
        <div className="border-b border-edge px-2 py-1.5">
          <span className="mono text-[11px] uppercase tracking-[0.14em] text-muted">
            diff
          </span>
        </div>
        <div className="px-2 py-1.5 text-[11px] text-muted">
          <span className="mono text-fg">{symbol}</span>
        </div>
      </div>
      <Link
        href={`/company/${encodeURIComponent(symbol)}/history`}
        className="px-2 text-[11px] text-accent hover:underline"
      >
        ← report history
      </Link>
      <Link href="/" className="px-2 text-[11px] text-accent hover:underline">
        ← home
      </Link>
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Grade direction helpers (A best … F worst)
 * ------------------------------------------------------------------------ */

const GRADE_ORDINAL: Record<Grade, number> = { A: 0, B: 1, C: 2, D: 3, F: 4 };

/** +1 improvement (toward A), -1 downgrade (toward F), 0 no move. */
function gradeDirection(from: Grade, to: Grade): 1 | -1 | 0 {
  const d = GRADE_ORDINAL[to] - GRADE_ORDINAL[from];
  if (d < 0) return 1; // ordinal decreased → grade improved
  if (d > 0) return -1;
  return 0;
}

const SECTION_LABELS: Record<string, string> = {
  composite: "Composite",
  fundamentals: "Fundamentals",
  valuation: "Valuation",
  technicals: "Technicals",
  quality: "Quality",
  balanceSheet: "Balance Sheet",
  leadership: "Leadership",
  moat: "Moat",
};

const PROJECTION_METRIC_LABELS: Record<string, string> = {
  revenue: "Revenue",
  operatingMargin: "Op. margin",
  fcf: "FCF",
  epsDiluted: "EPS",
};

/* ------------------------------------------------------------------------ *
 * Header strip — the two reports being compared
 * ------------------------------------------------------------------------ */

function CompareHeader({
  older,
  newer,
  swapped,
}: {
  older: LoadedReport;
  newer: LoadedReport;
  swapped: boolean;
}) {
  return (
    <div className="border border-edge bg-panel">
      <div className="flex flex-wrap items-stretch divide-x divide-edge">
        <ReportStamp label="older (A)" loaded={older} />
        <div className="flex items-center px-3 text-[13px] text-faint">→</div>
        <ReportStamp label="newer (B)" loaded={newer} />
      </div>
      {swapped ? (
        <div className="border-t border-edge px-3 py-1.5 text-[10px] text-faint">
          Selected reports were out of chronological order; reordered so deltas
          read older → newer.
        </div>
      ) : null}
    </div>
  );
}

function ReportStamp({ label, loaded }: { label: string; loaded: LoadedReport }) {
  const r = loaded.row;
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-3 py-2">
      <span className="text-[9px] uppercase tracking-[0.1em] text-faint">
        {label}
      </span>
      <span className="mono text-[13px] text-fg">
        #{r.id} · {r.createdAt.slice(0, 10)}
      </span>
      <span className="mono text-[10px] text-faint">
        {r.model.replace(/^claude-/, "")}
        {r.costUsd === null ? "" : ` · $${r.costUsd.toFixed(2)}`}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Grade changes
 * ------------------------------------------------------------------------ */

function GradeChangeRow({ change }: { change: GradeChange }) {
  const dir = gradeDirection(change.from, change.to);
  const arrow = dir === 1 ? "▲" : dir === -1 ? "▼" : "→";
  const tone =
    dir === 1 ? "text-pos" : dir === -1 ? "text-neg" : "text-muted";
  return (
    <div className="flex items-center gap-2 border border-edge bg-raised px-2.5 py-1.5">
      <span className="mono w-24 shrink-0 text-[11px] uppercase tracking-[0.08em] text-muted">
        {SECTION_LABELS[change.section] ?? change.section}
      </span>
      <GradeChip grade={change.from} />
      <span className={`mono text-[13px] leading-none ${tone}`}>{arrow}</span>
      <GradeChip grade={change.to} />
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Target changes
 * ------------------------------------------------------------------------ */

const SCENARIO_TONE: Record<TargetChange["scenario"], string> = {
  bull: "text-pos",
  base: "text-accent",
  bear: "text-neg",
};

function TargetChangeRow({ change }: { change: TargetChange }) {
  const up = change.toValue > change.fromValue;
  const flat = change.toValue === change.fromValue;
  const deltaTone = flat ? "text-muted" : up ? "text-pos" : "text-neg";
  const pct =
    change.pctChange === null
      ? "—"
      : `${change.pctChange >= 0 ? "+" : ""}${(change.pctChange * 100).toFixed(1)}%`;
  return (
    <div className="flex items-center gap-2 border border-edge bg-raised px-2.5 py-1.5">
      <span
        className={`mono w-14 shrink-0 text-[11px] uppercase tracking-[0.08em] ${
          SCENARIO_TONE[change.scenario]
        }`}
      >
        {change.scenario}
      </span>
      <span className="mono text-[12px] text-muted">
        ${change.fromValue.toFixed(2)}
      </span>
      <span className="mono text-[11px] text-faint">→</span>
      <span className="mono text-[12px] text-fg">
        ${change.toValue.toFixed(2)}
      </span>
      <span className={`mono ml-auto text-[12px] ${deltaTone}`}>{pct}</span>
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Score changes (deterministic composite + aspects)
 * ------------------------------------------------------------------------ */

function ScoreChangeRow({ change }: { change: ScoreChange }) {
  const from = change.from === null ? "n/a" : String(Math.round(change.from));
  const to = change.to === null ? "n/a" : String(Math.round(change.to));
  const up = (change.to ?? 0) > (change.from ?? 0);
  const tone = change.to === change.from ? "text-muted" : up ? "text-pos" : "text-neg";
  const arrow = change.to === change.from ? "→" : up ? "▲" : "▼";
  return (
    <div className="flex items-center gap-2 border border-edge bg-raised px-2.5 py-1.5">
      <span className="mono w-24 shrink-0 text-[11px] uppercase tracking-[0.08em] text-muted">
        {SECTION_LABELS[change.aspect] ?? change.aspect}
      </span>
      <span className="mono text-[12px] text-muted">
        {from}
        {change.fromBand ? ` ${change.fromBand}` : ""}
      </span>
      <span className={`mono text-[12px] ${tone}`}>{arrow}</span>
      <span className={`mono text-[12px] ${tone}`}>
        {to}
        {change.toBand ? ` ${change.toBand}` : ""}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Projection changes (weighted path at a horizon)
 * ------------------------------------------------------------------------ */

function ProjectionChangeRow({ change }: { change: ProjectionChange }) {
  const up = change.toValue > change.fromValue;
  const flat = change.toValue === change.fromValue;
  const tone = flat ? "text-muted" : up ? "text-pos" : "text-neg";
  const pct =
    change.pctChange === null
      ? "—"
      : `${change.pctChange >= 0 ? "+" : ""}${(change.pctChange * 100).toFixed(1)}%`;
  return (
    <div className="flex items-center gap-2 border border-edge bg-raised px-2.5 py-1.5">
      <span className="mono w-28 shrink-0 text-[11px] uppercase tracking-[0.08em] text-muted">
        {PROJECTION_METRIC_LABELS[change.metric] ?? change.metric} · {change.period}
      </span>
      <span className={`mono ml-auto text-[12px] ${tone}`}>{pct}</span>
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Catalyst / risk lists (added = pos, removed = faint + strikethrough)
 * ------------------------------------------------------------------------ */

function ItemList({
  title,
  added,
  removed,
}: {
  title: string;
  added: string[];
  removed: string[];
}) {
  const hasAny = added.length > 0 || removed.length > 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.1em] text-faint">
        <span>{title}</span>
        <span className="text-pos">+{added.length}</span>
        <span className="text-faint">−{removed.length}</span>
      </div>
      {!hasAny ? (
        <div className="text-[11px] text-faint">no changes</div>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {added.map((t, i) => (
            <li
              key={`a-${i}`}
              className="flex items-start gap-1.5 text-[11px] leading-snug text-pos"
            >
              <span className="mono shrink-0">+</span>
              <span className="text-fg">{t}</span>
            </li>
          ))}
          {removed.map((t, i) => (
            <li
              key={`r-${i}`}
              className="flex items-start gap-1.5 text-[11px] leading-snug"
            >
              <span className="mono shrink-0 text-faint">−</span>
              <span className="text-faint line-through">{t}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * The diff body
 * ------------------------------------------------------------------------ */

function DiffBody({ diff }: { diff: ReportDiff }) {
  const noGradeChanges = diff.gradeChanges.length === 0;
  const noTargetChanges = diff.targetChanges.length === 0;
  const costTone =
    diff.costDelta > 0 ? "text-neg" : diff.costDelta < 0 ? "text-pos" : "text-muted";

  return (
    <div className="flex flex-col gap-3">
      {/* Top-line flags */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={diff.verdictChanged ? "warn" : "muted"}>
          verdict {diff.verdictChanged ? "changed" : "unchanged"}
        </Badge>
        <span className="mono text-[11px] text-muted">
          cost Δ{" "}
          <span className={costTone}>
            {diff.costDelta >= 0 ? "+" : ""}
            ${diff.costDelta.toFixed(2)}
          </span>
        </span>
        <span className="mono text-[11px] text-faint">
          {diff.gradeChanges.length} grade · {diff.targetChanges.length} target ·{" "}
          {diff.newCatalysts.length + diff.removedCatalysts.length} catalyst ·{" "}
          {diff.newRisks.length + diff.removedRisks.length} risk changes
        </span>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="grade changes">
          {noGradeChanges ? (
            <div className="text-[11px] text-faint">
              No grade changed across the six sections.
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {diff.gradeChanges.map((c) => (
                <GradeChangeRow key={c.section} change={c} />
              ))}
            </div>
          )}
        </Panel>

        <Panel title="scenario target changes">
          {noTargetChanges ? (
            <div className="text-[11px] text-faint">
              No scenario price target changed.
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {diff.targetChanges.map((c) => (
                <TargetChangeRow key={c.scenario} change={c} />
              ))}
            </div>
          )}
        </Panel>

        <Panel title="score changes">
          {diff.scoreChanges.length === 0 ? (
            <div className="text-[11px] text-faint">
              No deterministic score changed.
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {diff.scoreChanges.map((c) => (
                <ScoreChangeRow key={c.aspect} change={c} />
              ))}
            </div>
          )}
        </Panel>

        <Panel title="projection changes (weighted)">
          {diff.projectionChanges.length === 0 ? (
            <div className="text-[11px] text-faint">
              No weighted projection changed.
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {diff.projectionChanges.map((c) => (
                <ProjectionChangeRow key={`${c.metric}-${c.period}`} change={c} />
              ))}
            </div>
          )}
        </Panel>

        <Panel title="catalysts">
          <ItemList
            title="catalysts"
            added={diff.newCatalysts}
            removed={diff.removedCatalysts}
          />
        </Panel>

        <Panel title="risks">
          <ItemList
            title="risks"
            added={diff.newRisks}
            removed={diff.removedRisks}
          />
        </Panel>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Friendly error states
 * ------------------------------------------------------------------------ */

function Notice({
  symbol,
  title,
  body,
}: {
  symbol: string;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="border border-warn/40 bg-warn/10 px-4 py-3">
      <div className="mono text-[13px] font-semibold text-warn">{title}</div>
      <p className="mt-1 text-[12px] text-muted">{body}</p>
      <Link
        href={`/company/${encodeURIComponent(symbol)}/history`}
        className="mt-2 inline-block text-[11px] text-accent hover:underline"
      >
        → back to report history
      </Link>
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------------ */

export default async function DiffPage({
  params,
  searchParams,
}: {
  params: Promise<{ symbol: string }>;
  searchParams: Promise<{ a?: string; b?: string }>;
}) {
  const { symbol: rawSymbol } = await params;
  const { a: aRaw, b: bRaw } = await searchParams;
  const symbol = decodeURIComponent(rawSymbol).toUpperCase().trim();

  // Strict digits-only parse (shared with the API routes): "12abc"/"12.9"/
  // "1e5" are invalid, not silently truncated to a different report's id.
  const aId = parseReportId(aRaw);
  const bId = parseReportId(bRaw);

  const header = (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h1 className="mono text-[16px] font-semibold tracking-[0.08em] text-fg">
        {symbol} <span className="text-faint">· report diff</span>
      </h1>
      <Link
        href={`/company/${encodeURIComponent(symbol)}/history`}
        className="text-[11px] text-accent hover:underline"
      >
        ← history
      </Link>
    </div>
  );

  // Missing/invalid ids.
  if (aId === null || bId === null) {
    return (
      <AppShell sidebar={<Sidebar symbol={symbol} />}>
        <div className="mx-auto flex max-w-4xl flex-col gap-3 p-4">
          {header}
          <Notice
            symbol={symbol}
            title="pick two reports to compare"
            body={
              <>
                This view needs two report ids in the URL (
                <span className="mono">?a=&lt;older&gt;&amp;b=&lt;newer&gt;</span>
                ). Use the compare control on the history page.
              </>
            }
          />
        </div>
      </AppShell>
    );
  }

  // Same report selected.
  if (aId === bId) {
    return (
      <AppShell sidebar={<Sidebar symbol={symbol} />}>
        <div className="mx-auto flex max-w-4xl flex-col gap-3 p-4">
          {header}
          <Notice
            symbol={symbol}
            title="same report selected"
            body={
              <>
                Report <span className="mono">#{aId}</span> was chosen for both
                sides — there is nothing to diff. Pick two different reports.
              </>
            }
          />
        </div>
      </AppShell>
    );
  }

  let pair;
  try {
    // Symbol-scoped load: both reports must belong to this route's company,
    // so ?a=/?b= ids from another ticker can never render a cross-company
    // diff under this symbol's header.
    pair = loadReportPairForSymbol(aId, bId, symbol);
  } catch {
    pair = null;
  }

  // One or both ids unknown / unparseable / belonging to another company.
  if (pair === null) {
    return (
      <AppShell sidebar={<Sidebar symbol={symbol} />}>
        <div className="mx-auto flex max-w-4xl flex-col gap-3 p-4">
          {header}
          <Notice
            symbol={symbol}
            title="report unavailable"
            body={
              <>
                At least one of reports <span className="mono">#{aId}</span> or{" "}
                <span className="mono">#{bId}</span> does not exist, could not
                be read, or is not a <span className="mono">{symbol}</span>{" "}
                report. Pick two saved reports from the history.
              </>
            }
          />
        </div>
      </AppShell>
    );
  }

  const { older, newer, swapped } = orderPairChronologically(pair);
  const diff = diffReports(older.report, newer.report);

  return (
    <AppShell sidebar={<Sidebar symbol={symbol} />}>
      <div className="mx-auto flex max-w-5xl flex-col gap-3 p-4">
        {header}
        <CompareHeader older={older} newer={newer} swapped={swapped} />
        <DiffBody diff={diff} />
      </div>
    </AppShell>
  );
}
