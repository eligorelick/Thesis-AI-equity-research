/**
 * Dense terminal-grade UI primitives used app-wide.
 *
 * Presentational only — no hooks, no data fetching, no server imports.
 * Safe to render from both server and client components. Theme tokens come
 * from src/app/globals.css (bg-panel, border-edge, text-muted, --grade-*).
 */

import type { ReactNode } from "react";
import type { Grade, ManifestEntry } from "@/types/core";

export type Tone = "neutral" | "pos" | "neg" | "warn" | "accent" | "muted";

const toneText: Record<Tone, string> = {
  neutral: "text-fg",
  pos: "text-pos",
  neg: "text-neg",
  warn: "text-warn",
  accent: "text-accent",
  muted: "text-muted",
};

const toneBadge: Record<Tone, string> = {
  neutral: "border-edge-strong text-muted",
  pos: "border-pos/40 text-pos",
  neg: "border-neg/40 text-neg",
  warn: "border-warn/40 text-warn",
  accent: "border-accent/40 text-accent",
  muted: "border-edge text-faint",
};

/** Uppercase micro-heading for panel sections. */
export function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted">
      {children}
    </h2>
  );
}

/** Bordered panel with a dense title bar and optional right-side slot. */
export function Panel({
  title,
  right,
  children,
}: {
  title: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border border-edge bg-panel">
      <div className="flex items-center justify-between gap-2 border-b border-edge px-3 py-1.5">
        <SectionHeading>{title}</SectionHeading>
        {right !== undefined && (
          <div className="flex items-center gap-2 text-[11px] text-muted">
            {right}
          </div>
        )}
      </div>
      <div className="px-3 py-2">{children}</div>
    </section>
  );
}

/** Label-over-value stat, with optional delta line. Value is tabular/mono. */
export function StatCell({
  label,
  value,
  delta,
  tone = "neutral",
}: {
  label: ReactNode;
  value: ReactNode;
  delta?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-2 py-1">
      <div className="truncate text-[10px] uppercase tracking-[0.1em] text-faint">
        {label}
      </div>
      <div className={`mono truncate text-[15px] leading-tight ${toneText[tone]}`}>
        {value}
      </div>
      {delta !== undefined && (
        <div className={`mono text-[11px] ${toneText[tone]}`}>{delta}</div>
      )}
    </div>
  );
}

/** A–F grade chip, color-coded via the --grade-* CSS variables. */
export function GradeChip({ grade }: { grade: Grade }) {
  const color = `var(--grade-${grade.toLowerCase()})`;
  return (
    <span
      className="mono inline-flex h-5 w-5 items-center justify-center border text-[12px] font-semibold leading-none"
      style={{
        color,
        borderColor: color,
        backgroundColor: "color-mix(in srgb, " + color + " 12%, transparent)",
      }}
      aria-label={`grade ${grade}`}
    >
      {grade}
    </span>
  );
}

/**
 * A 0–100 aspect/composite score pill, colored by its A–F band via the
 * `--grade-*` CSS variables (matching {@link GradeChip}). Renders `n/a` when the
 * aspect was not scored for the route. Deterministic, presentational.
 */
export function ScorePill({
  score,
  band,
}: {
  score: number | null;
  band: Grade | null;
}) {
  if (score === null || band === null) {
    return (
      <span
        className="mono inline-flex items-center border border-edge px-1.5 py-px text-[11px] leading-none text-faint"
        title="not scored for this route"
      >
        n/a
      </span>
    );
  }
  const color = `var(--grade-${band.toLowerCase()})`;
  return (
    <span
      className="mono inline-flex items-center gap-1 border px-1.5 py-px text-[12px] font-semibold leading-none"
      style={{
        color,
        borderColor: color,
        backgroundColor: "color-mix(in srgb, " + color + " 12%, transparent)",
      }}
      aria-label={`score ${Math.round(score)} of 100, grade ${band}`}
    >
      {Math.round(score)}
      <span className="text-[9px] opacity-80">{band}</span>
    </span>
  );
}

/** Small inline status badge. */
export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <span
      className={`mono inline-flex items-center gap-1 border px-1.5 py-px text-[10px] uppercase tracking-[0.08em] ${toneBadge[tone]}`}
    >
      {children}
    </span>
  );
}

export interface Column<Row> {
  /** Stable key for the column (React key + header id). */
  key: string;
  header: ReactNode;
  align?: "left" | "right" | "center";
  render: (row: Row) => ReactNode;
}

const alignClass = {
  left: "text-left",
  right: "text-right",
  center: "text-center",
} as const;

/**
 * Minimal dense typed table. Numerals are tabular globally (globals.css);
 * right-align numeric columns via `align: "right"`.
 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  empty = "no data",
}: {
  columns: ReadonlyArray<Column<Row>>;
  rows: ReadonlyArray<Row>;
  /** Stable row key; defaults to the row index. */
  rowKey?: (row: Row, index: number) => string;
  empty?: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b border-edge-strong">
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={`px-2 py-1 text-[10px] font-medium uppercase tracking-[0.1em] text-faint ${alignClass[col.align ?? "left"]}`}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="px-2 py-3 text-center text-[11px] text-faint"
              >
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr
                key={rowKey ? rowKey(row, i) : i}
                className="border-b border-edge last:border-b-0 hover:bg-raised"
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`px-2 py-1 ${alignClass[col.align ?? "left"]}`}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Provenance stamp — every rendered figure carries its as-of date. */
export function AsOf({ date, stale }: { date: string; stale?: boolean }) {
  return (
    <span
      className={`mono whitespace-nowrap text-[10px] ${stale ? "text-warn" : "text-faint"}`}
      title={stale ? `as of ${date} — past TTL, refresh pending` : `as of ${date}`}
    >
      as of {date}
      {stale ? " · stale" : ""}
    </span>
  );
}

const severityTone: Record<ManifestEntry["severity"], Tone> = {
  info: "muted",
  warn: "warn",
  critical: "neg",
};

/** Missing-data manifest line — gaps are disclosed, never papered over. */
export function GapNotice({ entry }: { entry: ManifestEntry }) {
  return (
    <div className="flex items-start gap-2 border border-edge bg-raised px-2 py-1.5">
      <Badge tone={severityTone[entry.severity]}>{entry.severity}</Badge>
      <div className="min-w-0 text-[11px] leading-snug">
        <span className="mono text-fg">{entry.field}</span>
        <span className="text-muted"> — {entry.reason}</span>
        {entry.attemptedSources && entry.attemptedSources.length > 0 && (
          <div className="mono mt-0.5 text-[10px] text-faint">
            tried: {entry.attemptedSources.join(", ")}
          </div>
        )}
      </div>
    </div>
  );
}
