"use client";

/**
 * ProjectionFanChart — a recharts (v3) "fan" for one weighted-projection series
 * (src/report/schema.ts ProjectionSeries): historical actuals as a solid line,
 * then a shaded bull↔bear band with the display-prior-weighted path drawn
 * through it, split from history by a "now" reference line.
 *
 * Dense (~200px), dark-themed to match FundamentalsCharts. Client component
 * (recharts renders in the browser). Colors are inlined so the SVG is standalone.
 */

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";

import type { ProjectionSeries } from "@/report/schema";

const THEME = {
  border: "#1f2937",
  fg: "#d5dce6",
  fgMuted: "#8494a8",
  fgFaint: "#5c6b80",
  accent: "#3ba7f5",
  pos: "#2ecc8f",
  neg: "#f0525f",
  bgRaised: "#151c26",
  borderStrong: "#2b3648",
} as const;

const CHART_HEIGHT = 200;
const AXIS_FONT = 10;
const MONO = "ui-monospace, 'Cascadia Code', Consolas, monospace";

const METRIC_LABEL: Record<ProjectionSeries["metric"], string> = {
  revenue: "Revenue",
  operatingMargin: "Operating margin",
  fcf: "Free cash flow (FCFF)",
  epsDiluted: "Diluted EPS",
};

/** Format a value by the series metric (compact currency, %, or plain). */
function formatValue(metric: ProjectionSeries["metric"], v: number | null, digits = 2): string {
  if (v === null || !Number.isFinite(v)) return "n/a";
  if (metric === "operatingMargin") return `${v.toFixed(1)}%`;
  if (metric === "epsDiluted") return v.toFixed(2);
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(digits)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(digits)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(digits)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(Math.min(1, digits))}K`;
  return `${sign}${abs.toFixed(digits)}`;
}

/** Terser format for axis ticks (no decimals on large magnitudes). */
function formatAxis(metric: ProjectionSeries["metric"], v: number | null): string {
  if (metric === "operatingMargin") return v === null ? "" : `${v.toFixed(0)}%`;
  return formatValue(metric, v, 0);
}

interface FanDatum {
  period: string;
  hist: number | null;
  band: [number, number] | null; // [bear, bull]
  base: number | null;
  weighted: number | null;
  bull: number | null;
  bear: number | null;
}

function buildData(series: ProjectionSeries): { data: FanDatum[]; firstForward: string | null } {
  const val = (pts: ProjectionSeries["historical"], i: number): number | null => pts[i]?.value.value ?? null;
  const data: FanDatum[] = [];
  for (const h of series.historical) {
    data.push({ period: h.period, hist: h.value.value, band: null, base: null, weighted: null, bull: null, bear: null });
  }
  const firstForward = series.base[0]?.period ?? null;
  // Bridge: repeat the last historical point as the anchor of the forward lines
  // so the weighted/base lines connect visually to history.
  const lastHist = series.historical.at(-1);
  if (lastHist && series.base.length > 0) {
    const anchor = data[data.length - 1];
    anchor.base = lastHist.value.value;
    anchor.weighted = lastHist.value.value;
    anchor.band = [lastHist.value.value, lastHist.value.value];
    anchor.bull = lastHist.value.value;
    anchor.bear = lastHist.value.value;
  }
  for (let i = 0; i < series.base.length; i++) {
    const bull = val(series.bull, i);
    const bear = val(series.bear, i);
    // Band is the scenario RANGE [min, max] — for FCF the higher-growth (bull)
    // path can dip below the bear path near-term (more reinvestment), so we must
    // not assume bull is the upper edge or the Area renders inverted/degenerate.
    const band: [number, number] | null =
      bull !== null && bear !== null ? [Math.min(bull, bear), Math.max(bull, bear)] : null;
    data.push({
      period: series.base[i].period,
      hist: null,
      band,
      base: val(series.base, i),
      weighted: val(series.weighted, i),
      bull,
      bear,
    });
  }
  return { data, firstForward };
}

function tooltip(metric: ProjectionSeries["metric"]) {
  return function TooltipContent(props: TooltipContentProps<ValueType, NameType>) {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    const d = props.payload[0]?.payload as FanDatum | undefined;
    if (!d) return null;
    const rows: { label: string; value: string; color: string }[] = [];
    if (d.hist !== null) rows.push({ label: "actual", value: formatValue(metric, d.hist), color: THEME.fg });
    if (d.bull !== null) rows.push({ label: "bull", value: formatValue(metric, d.bull), color: THEME.pos });
    if (d.weighted !== null) rows.push({ label: "weighted", value: formatValue(metric, d.weighted), color: THEME.accent });
    if (d.base !== null) rows.push({ label: "base", value: formatValue(metric, d.base), color: THEME.fgMuted });
    if (d.bear !== null) rows.push({ label: "bear", value: formatValue(metric, d.bear), color: THEME.neg });
    return (
      <div style={{ background: THEME.bgRaised, border: `1px solid ${THEME.borderStrong}`, padding: "6px 8px", fontFamily: MONO, fontSize: 11 }}>
        <div style={{ color: THEME.fgFaint, marginBottom: 2 }}>{d.period}</div>
        {rows.map((r) => (
          <div key={r.label} style={{ color: r.color, display: "flex", gap: 8, justifyContent: "space-between" }}>
            <span>{r.label}</span>
            <span>{r.value}</span>
          </div>
        ))}
      </div>
    );
  };
}

export function ProjectionFanChart({ series }: { series: ProjectionSeries }) {
  const { data, firstForward } = buildData(series);
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-[0.1em] text-faint">{METRIC_LABEL[series.metric]}</span>
        <span className="mono text-[9px] text-faint">{series.unit}</span>
      </div>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <ComposedChart data={data} margin={{ top: 6, right: 8, bottom: 2, left: 0 }}>
          <CartesianGrid stroke={THEME.border} strokeDasharray="2 3" vertical={false} />
          <XAxis
            dataKey="period"
            tick={{ fill: THEME.fgFaint, fontSize: AXIS_FONT, fontFamily: MONO }}
            axisLine={{ stroke: THEME.border }}
            tickLine={{ stroke: THEME.border }}
            minTickGap={4}
          />
          <YAxis
            tick={{ fill: THEME.fgFaint, fontSize: AXIS_FONT, fontFamily: MONO }}
            axisLine={{ stroke: THEME.border }}
            tickLine={{ stroke: THEME.border }}
            width={52}
            tickFormatter={(v: number) => formatAxis(series.metric, v)}
          />
          <Tooltip content={tooltip(series.metric)} />
          {firstForward && (
            <ReferenceLine x={firstForward} stroke={THEME.borderStrong} strokeDasharray="3 3" />
          )}
          {/* Bull↔bear band. */}
          <Area
            dataKey="band"
            stroke="none"
            fill={THEME.accent}
            fillOpacity={0.12}
            isAnimationActive={false}
            connectNulls
          />
          {/* Scenario edges (faint) so the range reads even if the band fill is subtle. */}
          <Line dataKey="bull" stroke={THEME.pos} strokeWidth={1} dot={false} strokeOpacity={0.6} isAnimationActive={false} connectNulls />
          <Line dataKey="bear" stroke={THEME.neg} strokeWidth={1} dot={false} strokeOpacity={0.6} isAnimationActive={false} connectNulls />
          {/* Weighted expected path. */}
          <Line dataKey="weighted" stroke={THEME.accent} strokeWidth={2} strokeDasharray="4 2" dot={false} isAnimationActive={false} connectNulls />
          {/* Historical actuals. */}
          <Line dataKey="hist" stroke={THEME.fg} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
