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

import { useEffect, useMemo, useRef } from "react";
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

import { smaSeries, type DatedClose } from "./format";

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
  volume: number;
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

const THEME = {
  bgPanel: "#0f141c",
  border: "#1f2937",
  fg: "#d5dce6",
  fgFaint: "#5c6b80",
  pos: "#2ecc8f",
  neg: "#f0525f",
  accent: "#3ba7f5",
  warn: "#e8b339",
  sma50: "#3ba7f5", // accent
  sma200: "#e8b339", // warn
  volume: "#2b3648", // border-strong, dim
} as const;

// ---------------------------------------------------------------------------
// Pure helpers (data shaping)
// ---------------------------------------------------------------------------

function barDate(b: PriceBar): string {
  const raw = b.date ?? b.time ?? "";
  return raw.length > 10 ? raw.slice(0, 10) : raw;
}

/** Sanitize + sort ASC + de-dup by date (lightweight-charts requires strict ASC unique times). */
export function toSortedBars(rows: readonly PriceBar[]): PriceBar[] {
  const clean: PriceBar[] = [];
  for (const b of rows) {
    const d = barDate(b);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (
      !Number.isFinite(b.open) ||
      !Number.isFinite(b.high) ||
      !Number.isFinite(b.low) ||
      !Number.isFinite(b.close)
    ) {
      continue;
    }
    clean.push({ ...b, date: d });
  }
  clean.sort((a, b) => (barDate(a) < barDate(b) ? -1 : barDate(a) > barDate(b) ? 1 : 0));
  // De-dup: keep the last bar for a given day.
  const out: PriceBar[] = [];
  for (const b of clean) {
    const d = barDate(b);
    if (out.length > 0 && barDate(out[out.length - 1]) === d) {
      out[out.length - 1] = b;
    } else {
      out.push(b);
    }
  }
  return out;
}

function lineDataFrom(
  bars: readonly PriceBar[],
  n: number,
): LineData<Time>[] {
  const closes: DatedClose[] = bars.map((b) => ({ date: barDate(b), close: b.close }));
  const sma = smaSeries(closes, n);
  const out: LineData<Time>[] = [];
  for (const p of sma) {
    if (p.value !== null) out.push({ time: p.date as Time, value: p.value });
  }
  return out;
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);

  // Sort/de-dup once per `rows` change; the effect (chart build) and the render
  // body (legend/SMA availability) both consume this instead of re-sorting.
  const bars = useMemo(() => toSortedBars(rows), [rows]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      ...chartOptions(height),
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
    const candleData: CandlestickData<Time>[] = bars.map((b) => ({
      time: barDate(b) as Time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }));
    candles.setData(candleData);

    // --- Volume histogram (overlaid on its own scale, bottom band) ----------
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      color: THEME.volume,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const volData: HistogramData<Time>[] = bars.map((b) => ({
      time: barDate(b) as Time,
      value: Number.isFinite(b.volume) ? b.volume : 0,
      color: b.close >= b.open ? `${THEME.pos}55` : `${THEME.neg}55`,
    }));
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
      sma50.setData(lineDataFrom(bars, 50));
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
      sma200.setData(lineDataFrom(bars, 200));
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
  }, [bars, crosses, height, showSma50, showSma200]);

  const has200 = bars.length >= 200;

  return (
    <div className="flex flex-col gap-1">
      <div
        ref={containerRef}
        className="w-full"
        style={{ height }}
        role="img"
        aria-label="Price candlestick chart with moving-average overlays and volume"
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
