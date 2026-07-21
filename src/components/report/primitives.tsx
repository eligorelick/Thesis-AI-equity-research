/**
 * Report-specific presentational primitives (the application contract §7/§8) — the provenance
 * layer of the full report UI. Every LLM claim and every figure renders WITH
 * its label / source / as-of, per the non-negotiable analysis rules (the application contract
 * §1): rule #2 (every claim labeled FACT|ESTIMATE|JUDGMENT) and rule #5 (every
 * figure carries its as-of date) are structural in the schema and surfaced
 * here.
 *
 * Server Component: everything below is static presentational markup (the
 * grade reasoning disclosure uses native <details>, no JS required). The one
 * genuinely interactive bit — the click-to-reveal claim source line — lives in
 * the small client island ./ClaimText.tsx, imported and rendered here as a
 * normal Server-Component-renders-Client-Component leaf. Theme tokens come
 * from globals.css.
 *
 * Formatting helpers live here too (formatNumber/formatCurrency/formatPct/
 * formatLargeNumber). They intentionally mirror the company-page formatters in
 * src/app/company/[symbol]/format.ts (fmtNum/fmtMoney/fmtPct/fmtBig) but that
 * module is another owner's file — we re-expose stable report-facing names and
 * add unit-aware rendering (%, ×, $, plain, large-compact) for TracedNumber.
 */

import type { ReactNode } from "react";

import { Badge, GradeChip, type Tone } from "@/components/ui";
import type {
  GradeBlock,
  SourcedClaim,
  TracedNumber,
} from "@/report/schema";
import { ClaimText } from "./ClaimText";

/* ======================================================================== *
 * Formatting helpers (tabular; render-boundary rounding only)
 * ======================================================================== */

/** Plain decimal with grouping. `n/a` for null/undefined/non-finite. */
export function formatNumber(
  v: number | null | undefined,
  digits = 2,
): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  return v.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** `$1,234.56`. */
export function formatCurrency(
  v: number | null | undefined,
  digits = 2,
): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  return `$${v.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

/** `12.3%`. Pass `signed` to force a leading `+` on positives. */
export function formatPct(
  v: number | null | undefined,
  digits = 1,
  signed = false,
): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  const sign = signed && v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}%`;
}

/** Compact magnitude: `3.50T` / `45.61B` / `789.00M` / `12.3K`. Tabular. */
export function formatLargeNumber(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(2)}`;
}

/** `1.8×`. `n/m` (not meaningful) for null. */
export function formatMultiple(
  v: number | null | undefined,
  digits = 1,
): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/m";
  return `${v.toFixed(digits)}×`;
}

/**
 * Render a {@link TracedNumber}'s value according to its declared `unit`.
 * Unit strings are as-reported free-text; we pattern-match the common ones and
 * fall back to a plain number + the raw unit suffix.
 */
export function formatTracedValue(n: TracedNumber): string {
  const u = n.unit.trim().toLowerCase();
  if (u === "%" || u === "pct" || u === "percent") return formatPct(n.value);
  if (u === "x" || u === "×" || u === "multiple") return formatMultiple(n.value);
  if (u === "usd" || u === "$" || u === "usd/share" || u === "$/share")
    return formatCurrency(n.value);
  if (u === "usd_large" || u === "usd-large" || u === "$_large")
    return `$${formatLargeNumber(n.value)}`;
  if (u === "large" || u === "count_large") return formatLargeNumber(n.value);
  if (u === "bps") return `${formatNumber(n.value, 0)} bps`;
  if (u === "years" || u === "yr" || u === "y")
    return `${formatNumber(n.value, 1)}y`;
  if (u === "" || u === "number" || u === "count")
    return formatNumber(n.value, Number.isInteger(n.value) ? 0 : 2);
  // Unknown unit — show the number and append the raw unit for transparency.
  return `${formatNumber(n.value)} ${n.unit}`;
}

/* ======================================================================== *
 * Small shared bits
 * ======================================================================== */

/**
 * A minimal details/summary disclosure with a consistent chevron. Native
 * <details> keeps it keyboard-accessible with zero state wiring; the summary
 * is the always-visible trigger.
 */
function Disclosure({
  trigger,
  children,
  open,
}: {
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details className="group" open={open}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden">
        <span className="mono select-none text-[10px] text-faint transition-transform group-open:rotate-90">
          ▸
        </span>
        {trigger}
      </summary>
      {children}
    </details>
  );
}

/** A vertical list of claims. */
export function ClaimList({
  claims,
  empty = "—",
}: {
  claims: readonly SourcedClaim[];
  empty?: ReactNode;
}) {
  if (claims.length === 0) {
    return <div className="text-[11px] text-faint">{empty}</div>;
  }
  return (
    <div className="flex flex-col gap-2">
      {claims.map((c, i) => (
        <ClaimText key={i} claim={c} />
      ))}
    </div>
  );
}

/* ======================================================================== *
 * TracedFigure — a TracedNumber with unit + citation-coverage indicator
 * ======================================================================== */

/**
 * Citation-coverage indicator (PROVENANCE, not correctness): a subtle check when
 * the number traced to a citation or a payload value (`verified === true`), a
 * warn dot when it could not (`false`, with the note in the tooltip), and a
 * faint hollow dot when the pass has not run yet (`null`). A ✓ means "traceable
 * to a source", NOT "confirmed correct". Source + as-of live in the title.
 */
export function VerificationDot({ n }: { n: TracedNumber }) {
  if (n.verified === true) {
    return (
      <span
        className="mono text-[10px] text-pos"
        title={`citation-traced${n.verificationNote ? ` · ${n.verificationNote}` : ""}`}
        aria-label="citation-traced"
      >
        ✓
      </span>
    );
  }
  if (n.verified === false) {
    return (
      <span
        className="mono text-[10px] text-warn"
        title={`not citation-traced${n.verificationNote ? ` · ${n.verificationNote}` : ""}`}
        aria-label="not citation-traced"
      >
        ●
      </span>
    );
  }
  return (
    <span
      className="mono text-[10px] text-faint"
      title="citation check not run"
      aria-label="citation check not run"
    >
      ○
    </span>
  );
}

/**
 * Renders a {@link TracedNumber}: formatted tabular value (unit-aware) + the
 * citation-coverage indicator, with source/as-of on hover (and an optional click to
 * reveal them inline). `tone` colors the figure; defaults to neutral.
 */
export function TracedFigure({
  n,
  tone = "neutral",
  className,
  showProvenance = false,
}: {
  n: TracedNumber;
  tone?: Tone;
  className?: string;
  showProvenance?: boolean;
}) {
  const toneClass: Record<Tone, string> = {
    neutral: "text-fg",
    pos: "text-pos",
    neg: "text-neg",
    warn: "text-warn",
    accent: "text-accent",
    muted: "text-muted",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 ${className ?? ""}`}
      title={`${n.source}${n.asOf ? ` · as of ${n.asOf}` : ""}`}
    >
      <span className={`mono ${toneClass[tone]}`}>{formatTracedValue(n)}</span>
      <VerificationDot n={n} />
      {showProvenance && (
        <span className="mono text-[9px] text-faint">{n.asOf ?? ""}</span>
      )}
    </span>
  );
}

/**
 * A key figure "cell": small label, the traced value, and the as-of stamp —
 * for the keyNumbers blocks inside grade reasoning and section headers.
 */
export function TracedStat({
  label,
  n,
  tone = "neutral",
}: {
  label: ReactNode;
  n: TracedNumber;
  tone?: Tone;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 border border-edge bg-raised px-2 py-1.5">
      <div className="truncate text-[9px] uppercase tracking-[0.1em] text-faint">
        {label}
      </div>
      <TracedFigure n={n} tone={tone} className="text-[13px]" />
      {n.asOf && (
        <div className="mono text-[9px] text-faint">as of {n.asOf}</div>
      )}
    </div>
  );
}

/* ======================================================================== *
 * GradeReasoning — expandable full reasoning behind a grade
 * ======================================================================== */

const CONFIDENCE_TONE: Record<GradeBlock["confidence"], Tone> = {
  high: "pos",
  medium: "warn",
  low: "neg",
};

/**
 * The full reasoning behind a {@link GradeBlock}: the grade chip, one-line why,
 * confidence, then (expandable) the reasoning claims + the key numbers. Used
 * both inline at the top of each graded section and as the scroll-anchor target
 * of the sticky grade strip.
 *
 * `defaultOpen` opens the reasoning immediately (used when a grade chip in the
 * strip deep-links to this section).
 */
export function GradeReasoning({
  title,
  block,
  defaultOpen = false,
}: {
  title: ReactNode;
  block: GradeBlock;
  defaultOpen?: boolean;
}) {
  return (
    <div className="border border-edge-strong bg-raised">
      <div className="flex items-center gap-2 border-b border-edge px-2.5 py-1.5">
        <GradeChip grade={block.grade} />
        <span className="mono text-[11px] uppercase tracking-[0.12em] text-muted">
          {title}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <span className="text-[9px] uppercase tracking-[0.1em] text-faint">
            conf
          </span>
          <Badge tone={CONFIDENCE_TONE[block.confidence]}>
            {block.confidence}
          </Badge>
        </span>
      </div>
      <div className="px-2.5 py-2">
        <p className="text-[12px] leading-snug text-fg">{block.oneLineWhy}</p>
        {block.interpretation && (
          <p className="mt-1.5 border-l-2 border-edge-strong pl-2 text-[12px] leading-relaxed text-muted">
            {block.interpretation}
          </p>
        )}

        <div className="mt-2">
          <Disclosure
            open={defaultOpen}
            trigger={
              <span className="mono text-[10px] uppercase tracking-[0.1em] text-faint hover:text-accent">
                reasoning ({block.reasoning.length}) · key numbers (
                {block.keyNumbers.length})
              </span>
            }
          >
            <div className="mt-2 flex flex-col gap-3">
              {block.reasoning.length > 0 && (
                <div className="flex flex-col gap-2">
                  <ClaimList claims={block.reasoning} />
                </div>
              )}
              {block.keyNumbers.length > 0 && (
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
                  {block.keyNumbers.map((n, i) => (
                    <TracedStat key={i} label={n.source.split(/[.:/]/).pop() ?? "value"} n={n} />
                  ))}
                </div>
              )}
            </div>
          </Disclosure>
        </div>
      </div>
    </div>
  );
}

/* ======================================================================== *
 * ScenarioCard — bull / base / bear valuation scenario
 * ======================================================================== */

const SCENARIO_META: Record<
  "bull" | "base" | "bear",
  { tone: Tone; label: string }
> = {
  bull: { tone: "pos", label: "bull" },
  base: { tone: "accent", label: "base" },
  bear: { tone: "neg", label: "bear" },
};

export function ScenarioCard({
  name,
  probability,
  priceTarget,
  horizon,
  assumptions,
  whatWouldHaveToBeTrue,
}: {
  name: "bull" | "base" | "bear";
  probability: number | null;
  priceTarget: TracedNumber | null;
  horizon: string;
  assumptions: readonly string[];
  whatWouldHaveToBeTrue: readonly string[];
}) {
  const meta = SCENARIO_META[name];
  const borderColor =
    meta.tone === "pos"
      ? "border-pos/40"
      : meta.tone === "neg"
        ? "border-neg/40"
        : "border-accent/40";
  return (
    <div className={`flex flex-col border ${borderColor} bg-panel`}>
      <div className="flex items-center justify-between gap-2 border-b border-edge px-2.5 py-1.5">
        <Badge tone={meta.tone}>{meta.label}</Badge>
        <span className="mono text-[11px] text-muted">
          {probability === null ? "p = n/a" : `p = ${(probability * 100).toFixed(0)}%`}
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-2 border-b border-edge px-2.5 py-2">
        {priceTarget ? (
          <TracedFigure n={priceTarget} tone={meta.tone} className="text-[18px]" />
        ) : (
          // Deterministic target suppressed (insufficient valuation inputs) —
          // show "unavailable", never a fabricated number.
          <span className="mono text-[13px] text-faint">target unavailable</span>
        )}
        <span className="mono text-[10px] text-faint">{horizon}</span>
      </div>
      {probability === null ? (
        <div className="border-b border-edge px-2.5 py-1 text-[10px] text-faint">
          scenario probability unavailable
        </div>
      ) : (
        <ProbabilityBar value={probability} tone={meta.tone} />
      )}
      <div className="flex flex-col gap-2 px-2.5 py-2">
        <div>
          <div className="mb-1 text-[9px] uppercase tracking-[0.1em] text-faint">
            assumptions
          </div>
          <ul className="flex flex-col gap-0.5">
            {assumptions.map((a, i) => (
              <li key={i} className="text-[11px] leading-snug text-muted">
                · {a}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="mb-1 text-[9px] uppercase tracking-[0.1em] text-faint">
            what would have to be true
          </div>
          <ul className="flex flex-col gap-0.5">
            {whatWouldHaveToBeTrue.map((w, i) => (
              <li key={i} className="text-[11px] leading-snug text-fg">
                → {w}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/* ======================================================================== *
 * ProbabilityBar — a thin weighted bar
 * ======================================================================== */

export function ProbabilityBar({
  value,
  tone = "accent",
}: {
  value: number;
  tone?: Tone;
}) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const color =
    tone === "pos"
      ? "var(--pos)"
      : tone === "neg"
        ? "var(--neg)"
        : tone === "warn"
          ? "var(--warn)"
          : "var(--accent)";
  return (
    <div className="h-1 w-full bg-bg" role="presentation">
      <div
        className="h-full"
        style={{ width: `${pct}%`, backgroundColor: color }}
      />
    </div>
  );
}

/**
 * A labelled horizontal share bar (used for segment revenue shares and own-5y
 * percentile bars). `pct` is 0–100.
 */
export function ShareBar({
  pct,
  tone = "accent",
  label,
}: {
  pct: number | null;
  tone?: Tone;
  label?: ReactNode;
}) {
  const clamped = pct === null ? 0 : Math.max(0, Math.min(100, pct));
  const color =
    tone === "pos"
      ? "var(--pos)"
      : tone === "neg"
        ? "var(--neg)"
        : tone === "warn"
          ? "var(--warn)"
          : "var(--accent)";
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 min-w-[3rem] flex-1 bg-bg">
        <div
          className="h-full"
          style={{ width: `${clamped}%`, backgroundColor: color }}
        />
      </div>
      <span className="mono w-12 shrink-0 text-right text-[10px] text-muted">
        {label ?? (pct === null ? "n/a" : `${pct.toFixed(0)}%`)}
      </span>
    </div>
  );
}

/* ======================================================================== *
 * HeatmapCell — value colored green→red across [min,max]
 * ======================================================================== */

/**
 * A single sensitivity-grid cell. Background interpolates green (high) → amber
 * (mid) → red (low) by the value's position in [min,max]. `null` renders a
 * faint dash. `format` maps the value to display text (defaults to $ rounded).
 */
export function HeatmapCell({
  value,
  min,
  max,
  format = (v) => formatCurrency(v, 0),
  highlight = false,
}: {
  value: number | null;
  min: number;
  max: number;
  format?: (v: number) => string;
  highlight?: boolean;
}) {
  if (value === null || !Number.isFinite(value)) {
    return (
      <td className="mono px-2 py-1 text-right text-[11px] text-faint">—</td>
    );
  }
  const span = max - min;
  const t = span > 0 ? Math.max(0, Math.min(1, (value - min) / span)) : 0.5;
  // Green (pos) at t=1, red (neg) at t=0, amber (warn) mid — mix in bg so text
  // stays legible.
  const hi = "46, 204, 143"; // --pos
  const mid = "232, 179, 57"; // --warn
  const lo = "240, 82, 95"; // --neg
  const rgb =
    t >= 0.5
      ? lerpRgb(mid, hi, (t - 0.5) * 2)
      : lerpRgb(lo, mid, t * 2);
  return (
    <td
      className={`mono px-2 py-1 text-right text-[11px] text-fg ${highlight ? "outline outline-1 outline-accent" : ""}`}
      style={{ backgroundColor: `rgba(${rgb}, 0.28)` }}
    >
      {format(value)}
    </td>
  );
}

function lerpRgb(a: string, b: string, t: number): string {
  const pa = a.split(",").map((x) => Number(x.trim()));
  const pb = b.split(",").map((x) => Number(x.trim()));
  const c = pa.map((x, i) => Math.round(x + (pb[i] - x) * t));
  return c.join(", ");
}

/* ======================================================================== *
 * SeverityProbMatrix — risks placed on a severity × probability grid
 * ======================================================================== */

type LowMedHigh = "high" | "medium" | "low";

export interface MatrixItem {
  title: string;
  severity: LowMedHigh;
  probability: LowMedHigh;
}

const AXIS_ORDER: LowMedHigh[] = ["high", "medium", "low"];

/**
 * A 3×3 severity (rows) × probability (cols) grid. Cells in the high/high
 * corner are tinted red, low/low green; each cell lists the risks that land in
 * it. A compact, scannable risk map (the application contract §7.10).
 */
export function SeverityProbMatrix({ items }: { items: readonly MatrixItem[] }) {
  const cellItems = (sev: LowMedHigh, prob: LowMedHigh): MatrixItem[] =>
    items.filter((it) => it.severity === sev && it.probability === prob);

  // Corner heat: sum of axis ranks (high=2..low=0); 0..4 → green..red.
  const rank: Record<LowMedHigh, number> = { high: 2, medium: 1, low: 0 };
  const cellBg = (sev: LowMedHigh, prob: LowMedHigh): string => {
    const score = rank[sev] + rank[prob]; // 0..4
    const t = score / 4;
    const hi = "46, 204, 143";
    const mid = "232, 179, 57";
    const lo = "240, 82, 95";
    const rgb = t <= 0.5 ? lerpRgb(hi, mid, t * 2) : lerpRgb(mid, lo, (t - 0.5) * 2);
    return `rgba(${rgb}, 0.14)`;
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            <th className="px-2 py-1 text-left text-[9px] uppercase tracking-[0.1em] text-faint">
              sev \ prob
            </th>
            {AXIS_ORDER.map((p) => (
              <th
                key={p}
                className="px-2 py-1 text-center text-[9px] uppercase tracking-[0.1em] text-faint"
              >
                {p}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {AXIS_ORDER.map((sev) => (
            <tr key={sev} className="border-t border-edge">
              <td className="px-2 py-1 text-[9px] uppercase tracking-[0.1em] text-faint">
                {sev}
              </td>
              {AXIS_ORDER.map((prob) => {
                const cell = cellItems(sev, prob);
                return (
                  <td
                    key={prob}
                    className="border-l border-edge px-1.5 py-1 align-top"
                    style={{ backgroundColor: cellBg(sev, prob) }}
                  >
                    {cell.length === 0 ? (
                      <span className="text-faint">·</span>
                    ) : (
                      <ul className="flex flex-col gap-0.5">
                        {cell.map((it, i) => (
                          <li
                            key={i}
                            className="leading-snug text-fg"
                            title={it.title}
                          >
                            {it.title}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ======================================================================== *
 * sectionAnchorId — stable anchor id for a section
 * ======================================================================== */

/** Normalize a section key into a DOM id / anchor hash. */
export function sectionAnchorId(key: string): string {
  return `report-${key}`;
}
