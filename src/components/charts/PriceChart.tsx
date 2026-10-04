"use client";

/**
 * PriceChart — candlestick EOD price chart with SMA50 / SMA200 overlays, a
 * volume histogram pane, and optional golden/death cross markers.
 *
 * lightweight-charts v5 (installed 5.2.0). v5 replaces the v4
 * `addCandlestickSeries()/addLineSeries()/addHistogramSeries()` methods with a
 * single generic `chart.addSeries(SeriesDefinition, options, paneIndex?)`;
 * series markers moved from `series.setMarkers()` to the standalone
 * `createSeriesMarkers(series, markers)` plugin. Both are used below.
 *
 * Client component: the chart mounts into a ref'd container, sizes itself to
 * that container via a ResizeObserver, and disposes on unmount. All colors come
 * from the terminal theme (globals.css) so it reads as part of the panel.
 */

import { useEffect, useId, useMemo, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type DeepPartial,
  type HistogramData,
  type IChartApi,
  type ChartOptions,
  type LineData,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";

import { barDate, preparePricePlotData } from "./plotData";
import { ChartDataDisclosure } from "./ChartDataDisclosure";
export { toSortedBars } from "./plotData";
import { useUiDesign } from "@/appearance/UiDesignProvider";
import { chartPalette, type ChartPalette } from "./palette";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** One EOD bar. `time` OR `date` accepted; rows may be ASC or DESC (re-sorted). */
export interface PriceBar {
  /** ISO "YYYY-MM-DD" (or a longer datetime — truncated to the day). */
  date?: string;
  /** Alias for `date` (some callers name the field `time`). */
  time?: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface CrossMarker {
  date: string;
  type: "golden" | "death";
}

export interface PriceChartProps {
  rows: readonly PriceBar[];
  /**
   * Golden/death cross dates to mark. Usually the single latest cross from
   * TechnicalsResult.smaCross.lastCrossDate/lastCrossType.
   */
  crosses?: readonly CrossMarker[];
  /** Container height in px (default 360). */
  height?: number;
  /** Draw the SMA50 overlay (default true). */
  showSma50?: boolean;
  /** Draw the SMA200 overlay (default true; auto-skipped when < 200 rows). */
  showSma200?: boolean;
}

// ---------------------------------------------------------------------------
// Theme (kept in sync with globals.css)
// ---------------------------------------------------------------------------

const THEME = chartPalette("current");

// ---------------------------------------------------------------------------
// Pure helpers (data shaping)
// ---------------------------------------------------------------------------

/** Omit unavailable volume points without removing their price/candlestick bars. */
export function toVolumeHistogramData(
  bars: readonly PriceBar[],
  palette: ChartPalette = THEME,
): HistogramData<Time>[] {
  const out: HistogramData<Time>[] = [];
  for (const b of bars) {
    if (typeof b.volume !== "number" || !Number.isFinite(b.volume) || b.volume < 0) {
      continue;
    }
    out.push({
      time: barDate(b) as Time,
      value: b.volume,
      color: b.close >= b.open ? `${palette.pos}55` : `${palette.neg}55`,
    });
  }
  return out;
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
    rightPriceScale: {
      borderColor: THEME.border,
      scaleMargins: { top: 0.08, bottom: 0.28 },
    },
    timeScale: {
      borderColor: THEME.border,
      rightOffset: 4,
      fixLeftEdge: true,
      fixRightEdge: true,
    },
    handleScroll: true,
    handleScale: true,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PriceChart({
  rows,
  crosses,
  height = 360,
  showSma50 = true,
  showSma200 = true,
}: PriceChartProps) {
  const { design } = useUiDesign();
  const THEME = chartPalette(design);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const descriptionId = useId();

  // Sort/de-dup once per `rows` change; the effect (chart build) and the render
  // body (legend/SMA availability) both consume this instead of re-sorting.
  const model = useMemo(() => preparePricePlotData(rows, { showSma50, showSma200 }), [rows, showSma50, showSma200]);
  const bars = model.bars;
  const columns = ["Open", "High", "Low", "Close", "Volume", ...(model.sma50.length ? ["SMA50"] : []), ...(model.sma200.length ? ["SMA200"] : [])];
  const tableRows = useMemo(() => model.rows.map((row) => ({ date: row.date,
    values: [row.open, row.high, row.low, row.close, row.volume,
      ...(model.sma50.length ? [row.sma50] : []), ...(model.sma200.length ? [row.sma200] : [])] })), [model]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      ...chartOptions(height, THEME),
      width: container.clientWidth,
    });
    chartRef.current = chart;

    // --- Candlesticks --------------------------------------------------------
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: THEME.pos,
      downColor: THEME.neg,
      borderUpColor: THEME.pos,
      borderDownColor: THEME.neg,
      wickUpColor: THEME.pos,
      wickDownColor: THEME.neg,
      priceLineVisible: false,
    });
    candles.setData(model.candles as CandlestickData<Time>[]);

    // --- Volume histogram (overlaid on its own scale, bottom band) ----------
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      color: THEME.volume,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const barsByDate = new Map(bars.map((bar) => [barDate(bar), bar]));
    const volData = model.volume.map((point) => {
      const bar = barsByDate.get(point.time)!;
      return { ...point, time: point.time as Time, color: bar.close >= bar.open ? `${THEME.pos}55` : `${THEME.neg}55` };
    });
    volume.setData(volData);
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.78, bottom: 0 },
      borderVisible: false,
    });

    // --- SMA overlays --------------------------------------------------------
    if (showSma50 && bars.length >= 50) {
      const sma50 = chart.addSeries(LineSeries, {
        color: THEME.sma50,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        title: "SMA50",
      });
      sma50.setData(model.sma50 as LineData<Time>[]);
    }
    if (showSma200 && bars.length >= 200) {
      const sma200 = chart.addSeries(LineSeries, {
        color: THEME.sma200,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        title: "SMA200",
      });
      sma200.setData(model.sma200 as LineData<Time>[]);
    }

    // --- Cross markers -------------------------------------------------------
    if (crosses && crosses.length > 0) {
      const validDates = new Set(bars.map(barDate));
      const markers: SeriesMarker<Time>[] = crosses
        .filter((c) => validDates.has(c.date))
        .map((c) => ({
          time: c.date as Time,
          position: c.type === "golden" ? "belowBar" : "aboveBar",
          color: c.type === "golden" ? THEME.pos : THEME.neg,
          shape: c.type === "golden" ? "arrowUp" : "arrowDown",
          text: c.type === "golden" ? "GC" : "DC",
        }));
      if (markers.length > 0) createSeriesMarkers(candles, markers);
    }

    chart.timeScale().fitContent();

    // --- Responsive width ----------------------------------------------------
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
  }, [model, bars, crosses, height, showSma50, showSma200, THEME]);

  const has200 = bars.length >= 200;

  return (
    <div className="flex flex-col gap-1">
      <div
        ref={containerRef}
        className="w-full"
        style={{ height }}
        role="img"
        aria-label="Price candlestick chart with moving-average overlays and volume"
        aria-describedby={descriptionId}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[10px] text-faint">
        <LegendSwatch color={THEME.pos} label="up" />
        <LegendSwatch color={THEME.neg} label="down" />
        {showSma50 && bars.length >= 50 ? <LegendSwatch color={THEME.sma50} label="SMA50" /> : null}
        {showSma200 && has200 ? (
          <LegendSwatch color={THEME.sma200} label="SMA200" />
        ) : (
          <span className="text-faint">
            {showSma200 ? `SMA200 skipped (${bars.length} rows < 200)` : ""}
          </span>
        )}
        <span className="ml-auto text-faint">volume · lower band</span>
      </div>
      <p id={descriptionId} className="px-1 text-[10px] text-faint">Open Price data for exact dated values. Unavailable volume or moving averages remain unavailable.</p>
      <ChartDataDisclosure label="Price data" columns={columns} rows={tableRows}
        caption="Daily price observations; currency not recorded. Volume as reported."
        basis="OHLC, volume and enabled moving averages as plotted; unavailable cells contain no plotted observation. Values are not rounded." />
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-block h-2 w-3" style={{ backgroundColor: color }} aria-hidden />
      <span className="mono">{label}</span>
    </span>
  );
}
