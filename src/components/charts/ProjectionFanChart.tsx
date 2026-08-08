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
import {
  PROJECTION_METRIC_BY_KEY,
  PROJECTION_PATHS,
  projectionCellPoint,
  projectionPeriodRows,
  type ProjectionPath,
} from "@/report/surfaceManifest";

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
  const data = projectionPeriodRows(series).map((row): FanDatum => {
    const value = (path: ProjectionPath): number | null =>
      projectionCellPoint(row, path, series.unit)?.value.value ?? null;
    const hist = value("historical");
    const bull = value("bull");
    const base = value("base");
    const bear = value("bear");
    const weighted = value("weighted");
    const band: [number, number] | null = bull !== null && bear !== null
      ? [Math.min(bull, bear), Math.max(bull, bear)]
      : null;
    return { period: row.period, hist, band, base, weighted, bull, bear };
  }).filter((row) => row.hist !== null || row.bull !== null || row.base !== null
    || row.bear !== null || row.weighted !== null);
  const firstForwardIndex = data.findIndex((row) => row.bull !== null || row.base !== null
    || row.bear !== null || row.weighted !== null);
  const firstForward = firstForwardIndex < 0 ? null : data[firstForwardIndex]!.period;
  // Bridge: repeat the last historical point as the anchor of the forward lines
  // so the weighted/base lines connect visually to history.
  let anchorIndex = -1;
  for (let index = data.length - 1; index >= 0; index -= 1) {
    if (data[index]!.hist !== null) {
      anchorIndex = index;
      break;
    }
  }
  const anchor = anchorIndex < 0 ? null : data[anchorIndex]!;
  if (anchor && firstForwardIndex >= 0 && anchorIndex < firstForwardIndex) {
    const value = anchor.hist!;
    anchor.base = value;
    anchor.weighted = value;
    anchor.band = [value, value];
    anchor.bull = value;
    anchor.bear = value;
  }
  return { data, firstForward };
}

function fanValue(data: FanDatum, path: ProjectionPath): number | null {
  return path === "historical" ? data.hist : data[path];
}

function fanColor(path: ProjectionPath): string {
  if (path === "bull") return THEME.pos;
  if (path === "bear") return THEME.neg;
  if (path === "weighted") return THEME.accent;
  if (path === "base") return THEME.fgMuted;
  return THEME.fg;
}

function tooltip(metric: ProjectionSeries["metric"]) {
  return function TooltipContent(props: TooltipContentProps<ValueType, NameType>) {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    const d = props.payload[0]?.payload as FanDatum | undefined;
    if (!d) return null;
    const rows = PROJECTION_PATHS.map((descriptor) => ({
      descriptor,
      value: fanValue(d, descriptor.key),
    })).filter((row) => row.value !== null);
    return (
      <div style={{ background: THEME.bgRaised, border: `1px solid ${THEME.borderStrong}`, padding: "6px 8px", fontFamily: MONO, fontSize: 11 }}>
        <div style={{ color: THEME.fgFaint, marginBottom: 2 }}>{d.period}</div>
        {rows.map((row) => (
          <div key={row.descriptor.id} style={{ color: fanColor(row.descriptor.key), display: "flex", gap: 8, justifyContent: "space-between" }}>
            <span>{row.descriptor.label.toLowerCase()}</span>
            <span>{formatValue(metric, row.value)}</span>
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
        <span className="text-[10px] uppercase tracking-[0.1em] text-faint">{PROJECTION_METRIC_BY_KEY[series.metric].label}</span>
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
