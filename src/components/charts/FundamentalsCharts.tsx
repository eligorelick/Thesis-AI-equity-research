"use client";

/**
 * FundamentalsCharts — recharts (v3) trend charts for the fundamentals section:
 *   - RevenueTrendChart : revenue bars + YoY-growth line (secondary axis)
 *   - MarginTrendChart  : gross / operating / net margin lines
 *   - FcfChart          : FCF bars + FCF-conversion line (secondary axis)
 *   - ShareCountChart   : diluted share-count trend (buybacks vs dilution)
 *
 * Each takes a small, explicit row type (defined + exported here); the page
 * integrator maps ComputedMetrics into these. Dense (~220px), dark-themed,
 * tabular ticks, muted grid, panel-colored tooltip. No chart-junk.
 *
 * Client component (recharts renders in the browser). Colors come from the
 * terminal theme (globals.css), inlined as constants so the SVG is standalone.
 */

import type { ReactNode } from "react";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";

import { compactCurrency, fiscalYear, pct, signedPct } from "./format";

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const THEME = {
  bgRaised: "#151c26",
  border: "#1f2937",
  borderStrong: "#2b3648",
  fg: "#d5dce6",
  fgMuted: "#8494a8",
  fgFaint: "#5c6b80",
  accent: "#3ba7f5",
  pos: "#2ecc8f",
  neg: "#f0525f",
  warn: "#e8b339",
} as const;

const CHART_HEIGHT = 220;
const AXIS_FONT = 10;
const MONO = "ui-monospace, 'Cascadia Code', Consolas, monospace";

// ---------------------------------------------------------------------------
// Row input types (the integrator maps ComputedMetrics → these)
// ---------------------------------------------------------------------------

export interface RevenueRow {
  /** Period label; fiscal year is taken from its leading 4 chars. */
  period: string;
  revenue: number | null;
  /** Year-over-year growth, percent (nullable for the earliest year). */
  yoyGrowthPct: number | null;
}

export interface MarginRow {
  period: string;
  grossPct: number | null;
  operatingPct: number | null;
  netPct: number | null;
}

export interface FcfRow {
  period: string;
  fcf: number | null;
  /** FCF / net income (or / OCF), percent — "conversion". */
  conversionPct: number | null;
}

export interface ShareCountRow {
  period: string;
  /** Diluted weighted-average shares outstanding. */
  dilutedShares: number | null;
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const gridProps = {
  stroke: THEME.border,
  strokeDasharray: "2 3",
  vertical: false,
} as const;

function xAxisProps(dataKey = "period") {
  return {
    dataKey,
    tick: { fill: THEME.fgFaint, fontSize: AXIS_FONT, fontFamily: MONO },
    tickFormatter: (v: string) => fiscalYear(v),
    axisLine: { stroke: THEME.border },
    tickLine: { stroke: THEME.border },
    minTickGap: 4,
  } as const;
}

/** Chart title strip above each mini-chart. */
function ChartTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1 text-[10px] uppercase tracking-[0.1em] text-faint">{children}</div>
  );
}

interface TipRow {
  label: string;
  value: string;
  color: string;
}

type TipFormat = (key: string, value: number | null) => TipRow | null;

/**
 * Panel-styled tooltip renderer, shared by all charts via a formatter map.
 * Returns a render function for recharts' `content` prop; the general
 * ValueType/NameType generics match what recharts infers (no per-chart cast).
 */
function themedTooltip(format: TipFormat) {
  return function TooltipContent(
    props: TooltipContentProps<ValueType, NameType>,
  ): ReactNode {
    const { active, label, payload } = props;
    if (!active || !payload || payload.length === 0) return null;
    const rows: TipRow[] = [];
    for (const p of payload) {
      const key = typeof p.dataKey === "string" ? p.dataKey : String(p.dataKey ?? "");
      const raw = typeof p.value === "number" ? p.value : null;
      const row = format(key, raw);
      if (row) rows.push(row);
    }
    if (rows.length === 0) return null;
    return (
      <div
        className="border px-2 py-1 text-[10px] shadow-lg"
        style={{ backgroundColor: THEME.bgRaised, borderColor: THEME.borderStrong }}
      >
        <div className="mono mb-0.5" style={{ color: THEME.fg }}>
          {fiscalYear(typeof label === "string" ? label : String(label ?? ""))}
        </div>
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-1.5 w-1.5" style={{ backgroundColor: r.color }} aria-hidden />
              <span style={{ color: THEME.fgMuted }}>{r.label}</span>
            </span>
            <span className="mono" style={{ color: THEME.fg }}>{r.value}</span>
          </div>
        ))}
      </div>
    );
  };
}

function EmptyChart({ height = CHART_HEIGHT }: { height?: number }) {
  return (
    <div
      className="flex items-center justify-center border border-edge bg-raised text-[10px] text-faint"
      style={{ height }}
    >
      no data
    </div>
  );
}

function hasAny<T>(rows: readonly T[], keys: (keyof T)[]): boolean {
  return rows.some((r) =>
    keys.some((k) => {
      const v = r[k];
      return typeof v === "number" && Number.isFinite(v);
    }),
  );
}

// ---------------------------------------------------------------------------
// RevenueTrendChart
// ---------------------------------------------------------------------------

export function RevenueTrendChart({ rows }: { rows: readonly RevenueRow[] }) {
  const tipFormat = (key: string, v: number | null): TipRow | null => {
    if (v === null) return null;
    if (key === "revenue") return { label: "revenue", value: compactCurrency(v), color: THEME.accent };
    if (key === "yoyGrowthPct") return { label: "yoy growth", value: signedPct(v), color: THEME.pos };
    return null;
  };
  return (
    <div>
      <ChartTitle>revenue &amp; yoy growth</ChartTitle>
      {rows.length === 0 || !hasAny(rows, ["revenue"]) ? (
        <EmptyChart />
      ) : (
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <ComposedChart data={rows as RevenueRow[]} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis {...xAxisProps()} />
            <YAxis
              yAxisId="rev"
              tick={{ fill: THEME.fgFaint, fontSize: AXIS_FONT, fontFamily: MONO }}
              tickFormatter={(v: number) => compactCurrency(v, 0)}
              axisLine={{ stroke: THEME.border }}
              tickLine={{ stroke: THEME.border }}
              width={48}
            />
            <YAxis
              yAxisId="yoy"
              orientation="right"
              tick={{ fill: THEME.fgFaint, fontSize: AXIS_FONT, fontFamily: MONO }}
              tickFormatter={(v: number) => pct(v, 0)}
              axisLine={{ stroke: THEME.border }}
              tickLine={{ stroke: THEME.border }}
              width={40}
            />
            <Tooltip
              cursor={{ fill: "#ffffff08" }}
              content={themedTooltip(tipFormat)}
            />
            <Bar yAxisId="rev" dataKey="revenue" fill={THEME.accent} fillOpacity={0.55} isAnimationActive={false} />
            <Line
              yAxisId="yoy"
              type="monotone"
              dataKey="yoyGrowthPct"
              stroke={THEME.pos}
              strokeWidth={1.5}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MarginTrendChart
// ---------------------------------------------------------------------------

export function MarginTrendChart({ rows }: { rows: readonly MarginRow[] }) {
  const tipFormat = (key: string, v: number | null): TipRow | null => {
    if (v === null) return null;
    if (key === "grossPct") return { label: "gross", value: pct(v), color: THEME.accent };
    if (key === "operatingPct") return { label: "operating", value: pct(v), color: THEME.warn };
    if (key === "netPct") return { label: "net", value: pct(v), color: THEME.pos };
    return null;
  };
  return (
    <div>
      <ChartTitle>margin trend</ChartTitle>
      {rows.length === 0 || !hasAny(rows, ["grossPct", "operatingPct", "netPct"]) ? (
        <EmptyChart />
      ) : (
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <ComposedChart data={rows as MarginRow[]} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis {...xAxisProps()} />
            <YAxis
              tick={{ fill: THEME.fgFaint, fontSize: AXIS_FONT, fontFamily: MONO }}
              tickFormatter={(v: number) => pct(v, 0)}
              axisLine={{ stroke: THEME.border }}
              tickLine={{ stroke: THEME.border }}
              width={40}
            />
            <Tooltip
              cursor={{ stroke: THEME.fgFaint, strokeDasharray: "3 3" }}
              content={themedTooltip(tipFormat)}
            />
            <Line type="monotone" dataKey="grossPct" stroke={THEME.accent} strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
            <Line type="monotone" dataKey="operatingPct" stroke={THEME.warn} strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
            <Line type="monotone" dataKey="netPct" stroke={THEME.pos} strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FcfChart
// ---------------------------------------------------------------------------

export function FcfChart({ rows }: { rows: readonly FcfRow[] }) {
  const tipFormat = (key: string, v: number | null): TipRow | null => {
    if (v === null) return null;
    if (key === "fcf") return { label: "fcf", value: compactCurrency(v), color: THEME.accent };
    if (key === "conversionPct") return { label: "conversion", value: pct(v), color: THEME.warn };
    return null;
  };
  return (
    <div>
      <ChartTitle>free cash flow &amp; conversion</ChartTitle>
      {rows.length === 0 || !hasAny(rows, ["fcf"]) ? (
        <EmptyChart />
      ) : (
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <ComposedChart data={rows as FcfRow[]} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis {...xAxisProps()} />
            <YAxis
              yAxisId="fcf"
              tick={{ fill: THEME.fgFaint, fontSize: AXIS_FONT, fontFamily: MONO }}
              tickFormatter={(v: number) => compactCurrency(v, 0)}
              axisLine={{ stroke: THEME.border }}
              tickLine={{ stroke: THEME.border }}
              width={48}
            />
            <YAxis
              yAxisId="conv"
              orientation="right"
              tick={{ fill: THEME.fgFaint, fontSize: AXIS_FONT, fontFamily: MONO }}
              tickFormatter={(v: number) => pct(v, 0)}
              axisLine={{ stroke: THEME.border }}
              tickLine={{ stroke: THEME.border }}
              width={40}
            />
            <Tooltip
              cursor={{ fill: "#ffffff08" }}
              content={themedTooltip(tipFormat)}
            />
            <Bar yAxisId="fcf" dataKey="fcf" isAnimationActive={false}>
              {(rows as FcfRow[]).map((r, i) => (
                <Cell
                  key={i}
                  fill={r.fcf !== null && r.fcf < 0 ? THEME.neg : THEME.accent}
                  fillOpacity={0.55}
                />
              ))}
            </Bar>
            <Line
              yAxisId="conv"
              type="monotone"
              dataKey="conversionPct"
              stroke={THEME.warn}
              strokeWidth={1.5}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ShareCountChart
// ---------------------------------------------------------------------------

export function ShareCountChart({ rows }: { rows: readonly ShareCountRow[] }) {
  // Color each bar green when shares fell vs the prior year (buybacks), red when
  // they rose (dilution). The earliest bar has no prior → neutral accent.
  const priors = new Map<number, number | null>();
  const arr = rows as ShareCountRow[];
  for (let i = 0; i < arr.length; i++) {
    priors.set(i, i > 0 ? arr[i - 1].dilutedShares : null);
  }
  const tipFormat = (key: string, v: number | null): TipRow | null => {
    if (v === null || key !== "dilutedShares") return null;
    return { label: "diluted shares", value: compactCurrency(v, 1).replace("$", ""), color: THEME.fgMuted };
  };
  return (
    <div>
      <ChartTitle>diluted share count</ChartTitle>
      {rows.length === 0 || !hasAny(rows, ["dilutedShares"]) ? (
        <EmptyChart />
      ) : (
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <ComposedChart data={arr} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis {...xAxisProps()} />
            <YAxis
              tick={{ fill: THEME.fgFaint, fontSize: AXIS_FONT, fontFamily: MONO }}
              tickFormatter={(v: number) => compactCurrency(v, 1).replace("$", "")}
              axisLine={{ stroke: THEME.border }}
              tickLine={{ stroke: THEME.border }}
              width={44}
              domain={["auto", "auto"]}
            />
            <Tooltip
              cursor={{ fill: "#ffffff08" }}
              content={themedTooltip(tipFormat)}
            />
            <Bar dataKey="dilutedShares" isAnimationActive={false}>
              {arr.map((r, i) => {
                const prior = priors.get(i) ?? null;
                let fill: string = THEME.accent;
                if (prior !== null && r.dilutedShares !== null) {
                  fill = r.dilutedShares < prior ? THEME.pos : r.dilutedShares > prior ? THEME.neg : THEME.accent;
                }
                return <Cell key={i} fill={fill} fillOpacity={0.55} />;
              })}
            </Bar>
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Convenience grid wrapper (optional) — dense 2-up layout
// ---------------------------------------------------------------------------

export interface FundamentalsChartData {
  revenue: readonly RevenueRow[];
  margins: readonly MarginRow[];
  fcf: readonly FcfRow[];
  shareCount: readonly ShareCountRow[];
}

export function FundamentalsChartGrid({ data }: { data: FundamentalsChartData }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <RevenueTrendChart rows={data.revenue} />
      <MarginTrendChart rows={data.margins} />
      <FcfChart rows={data.fcf} />
      <ShareCountChart rows={data.shareCount} />
    </div>
  );
}
