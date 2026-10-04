"use client";

/**
 * RelativeStrengthChart — normalized (rebased-to-100) multi-line comparison of
 * the stock vs SPY vs its sector ETF over the available window.
 *
 * Each series is rebased to 100 at its first finite/positive close within the
 * shared comparison window. Sparse histories can have different baseline
 * dates, disclosed in the data alternative. The stock draws in
 * the accent color; benchmarks in muted greys.
 *
 * lightweight-charts v5: `chart.addSeries(LineSeries, options)`. Client
 * component — mounts into a ref'd container, sizes via ResizeObserver, disposes
 * on unmount.
 */

import { useEffect, useId, useMemo, useRef } from "react";
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

import { prepareRelativeStrengthPlotData } from "./plotData";
import { ChartDataDisclosure } from "./ChartDataDisclosure";
export { commonStartDate, rebasedLineData } from "./plotData";
import { useUiDesign } from "@/appearance/UiDesignProvider";
import { chartPalette, type ChartPalette } from "./palette";

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
  fgFaint: "#7f8fa4",
  accent: "#3ba7f5",
} as const;

/** Muted benchmark line colors, cycled by benchmark index. */
const BENCHMARK_COLORS = ["#8494a8", "#7f8fa4", "#e8b339"] as const;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

interface ResolvedSeries extends RsSeries {
  color: string;
}

/** Assign colors: first series (or any role:"primary") → accent; rest cycle greys. */
export function resolveSeriesColors(series: readonly RsSeries[], palette?: ChartPalette): ResolvedSeries[] {
  const colors = palette ? [palette.fgMuted, palette.fgFaint, palette.warn] : BENCHMARK_COLORS;
  let benchIdx = 0;
  return series.map((s, i) => {
    const isPrimary = s.role === "primary" || (s.role === undefined && i === 0);
    const color = isPrimary
      ? (palette?.accent ?? THEME.accent)
      : colors[benchIdx++ % colors.length];
    return { ...s, color };
  });
}

function chartOptions(height: number, THEME: ChartPalette): DeepPartial<ChartOptions> {
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
  const { design } = useUiDesign();
  const THEME = chartPalette(design);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const resolved = useMemo(() => resolveSeriesColors(series, THEME), [series, THEME]);
  const model = useMemo(() => prepareRelativeStrengthPlotData(series), [series]);
  const descriptionId = useId();
  const basis = `Comparison window starts ${model.startDate ?? "not available"}; each series is indexed to 100 at its first usable close within that window. `
    + model.series.map((item) => `${item.label}: baseline ${item.baseDate ?? "unavailable"}`).join("; ")
    + ". Unavailable cells contain no plotted observation; lines may span omitted observations. Values are not rounded.";

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      ...chartOptions(height, THEME),
      width: container.clientWidth,
    });
    chartRef.current = chart;

    // Preserve the shared comparison-window cutoff and each line's actual
    // first usable observation; those individual bases are disclosed below.
    for (const [index, s] of resolved.entries()) {
      const data = model.series[index]!.data;
      if (data.length === 0) continue;
      const line = chart.addSeries(LineSeries, {
        color: s.color,
        lineWidth: s.role === "primary" || s.color === THEME.accent ? 2 : 1,
        priceLineVisible: false,
        lastValueVisible: true,
        title: s.label,
      });
      line.setData(data as LineData<Time>[]);
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
  }, [resolved, model, height, THEME]);

  const anyData = resolved.some((s) => s.rows.length > 0);

  return (
    <div className="flex flex-col gap-1">
      <div
        ref={containerRef}
        className="w-full"
        style={{ height }}
        role="img"
        aria-label="Relative strength chart, rebased to 100"
        aria-describedby={descriptionId}
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
      <p id={descriptionId} className="px-1 text-[10px] text-faint">Open Relative-strength data for exact index values, dates and individual baselines.</p>
      <ChartDataDisclosure label="Relative-strength data" columns={model.series.map((item) => item.label)} rows={model.rows}
        caption="Relative strength · index values (100 at each recorded baseline)" basis={basis} />
      {!anyData ? (
        <div className="px-1 text-[10px] text-faint">no price history available for comparison.</div>
      ) : null}
    </div>
  );
}
