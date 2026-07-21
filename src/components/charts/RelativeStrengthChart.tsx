"use client";

/**
 * RelativeStrengthChart — normalized (rebased-to-100) multi-line comparison of
 * the stock vs SPY vs its sector ETF over the available window.
 *
 * Each series is rebased to 100 at its own first finite/positive close
 * (rebaseTo100 in ./format), so the lines share a common baseline and the chart
 * reads as relative performance rather than absolute price. The stock draws in
 * the accent color; benchmarks in muted greys.
 *
 * lightweight-charts v5: `chart.addSeries(LineSeries, options)`. Client
 * component — mounts into a ref'd container, sizes via ResizeObserver, disposes
 * on unmount.
 */

import { useEffect, useMemo, useRef } from "react";
import {
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
  type DeepPartial,
  type IChartApi,
  type ChartOptions,
  type LineData,
  type Time,
} from "lightweight-charts";

import { rebaseTo100, type DatedClose } from "./format";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface RsRow {
  /** ISO "YYYY-MM-DD" (longer datetimes truncated to the day). */
  date: string;
  close: number;
}

export interface RsSeries {
  /** Legend label, e.g. "NVDA", "SPY", "XLK". */
  label: string;
  rows: readonly RsRow[];
  /**
   * Role controls color: "primary" = the stock (accent), "benchmark" = muted.
   * Defaults to "benchmark" for any series after the first.
   */
  role?: "primary" | "benchmark";
}

export interface RelativeStrengthChartProps {
  series: readonly RsSeries[];
  /** Container height in px (default 300). */
  height?: number;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const THEME = {
  bgPanel: "#0f141c",
  border: "#1f2937",
  fgFaint: "#5c6b80",
  accent: "#3ba7f5",
} as const;

/** Muted benchmark line colors, cycled by benchmark index. */
const BENCHMARK_COLORS = ["#8494a8", "#5c6b80", "#e8b339"] as const;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function normDate(d: string): string {
  return d.length > 10 ? d.slice(0, 10) : d;
}

function sortedUnique(rows: readonly RsRow[]): DatedClose[] {
  const clean: DatedClose[] = [];
  for (const r of rows) {
    const d = normDate(r.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    clean.push({ date: d, close: r.close });
  }
  clean.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const out: DatedClose[] = [];
  for (const r of clean) {
    if (out.length > 0 && out[out.length - 1].date === r.date) {
      out[out.length - 1] = r;
    } else {
      out.push(r);
    }
  }
  return out;
}

/** Rebased LineData for one series, dropping null-valued points. */
export function rebasedLineData(rows: readonly RsRow[]): LineData<Time>[] {
  const sorted = sortedUnique(rows);
  const rebased = rebaseTo100(sorted);
  const out: LineData<Time>[] = [];
  for (const p of rebased) {
    if (p.value !== null) out.push({ time: p.date as Time, value: p.value });
  }
  return out;
}

interface ResolvedSeries extends RsSeries {
  color: string;
}

/** Assign colors: first series (or any role:"primary") → accent; rest cycle greys. */
export function resolveSeriesColors(series: readonly RsSeries[]): ResolvedSeries[] {
  let benchIdx = 0;
  return series.map((s, i) => {
    const isPrimary = s.role === "primary" || (s.role === undefined && i === 0);
    const color = isPrimary
      ? THEME.accent
      : BENCHMARK_COLORS[benchIdx++ % BENCHMARK_COLORS.length];
    return { ...s, color };
  });
}

function chartOptions(height: number): DeepPartial<ChartOptions> {
  return {
    height,
    layout: {
      background: { type: ColorType.Solid, color: THEME.bgPanel },
      textColor: THEME.fgFaint,
      fontSize: 11,
      fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace",
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: THEME.border, style: LineStyle.Dotted },
      horzLines: { color: THEME.border, style: LineStyle.Dotted },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: THEME.fgFaint, width: 1, style: LineStyle.Dashed, labelBackgroundColor: THEME.border },
      horzLine: { color: THEME.fgFaint, width: 1, style: LineStyle.Dashed, labelBackgroundColor: THEME.border },
    },
    rightPriceScale: { borderColor: THEME.border, scaleMargins: { top: 0.1, bottom: 0.1 } },
    timeScale: { borderColor: THEME.border, fixLeftEdge: true, fixRightEdge: true },
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RelativeStrengthChart({ series, height = 300 }: RelativeStrengthChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const resolved = useMemo(() => resolveSeriesColors(series), [series]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      ...chartOptions(height),
      width: container.clientWidth,
    });
    chartRef.current = chart;

    for (const s of resolved) {
      const data = rebasedLineData(s.rows);
      if (data.length === 0) continue;
      const line = chart.addSeries(LineSeries, {
        color: s.color,
        lineWidth: s.role === "primary" || s.color === THEME.accent ? 2 : 1,
        priceLineVisible: false,
        lastValueVisible: true,
        title: s.label,
      });
      line.setData(data);
    }

    // Baseline at 100 on the first series' scale would clutter; instead a light
    // reference is conveyed by the shared rebasing. Fit content and go.
    chart.timeScale().fitContent();

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.floor(entry.contentRect.width);
        if (w > 0) chart.applyOptions({ width: w });
      }
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [resolved, height]);

  const anyData = resolved.some((s) => s.rows.length > 0);

  return (
    <div className="flex flex-col gap-1">
      <div
        ref={containerRef}
        className="w-full"
        style={{ height }}
        role="img"
        aria-label="Relative strength chart, rebased to 100"
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[10px] text-faint">
        {resolved.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-3" style={{ backgroundColor: s.color }} aria-hidden />
            <span className="mono">{s.label}</span>
          </span>
        ))}
        <span className="ml-auto text-faint">rebased to 100 · close-to-close</span>
      </div>
      {!anyData ? (
        <div className="px-1 text-[10px] text-faint">no price history available for comparison.</div>
      ) : null}
    </div>
  );
}
