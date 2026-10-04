/** One numeric preparation for each canvas and its accessible data alternative.
 * No network, palette, currency guesses, interpolation or value rounding.
 */
import { rebaseTo100, smaSeries, type DatedClose } from "./format";
import type { PriceBar } from "./PriceChart";
import type { RsRow, RsSeries } from "./RelativeStrengthChart";

export interface PlotPoint { time: string; value: number }
export function barDate(bar: PriceBar): string {
  const raw = bar.date ?? bar.time ?? "";
  return raw.length > 10 ? raw.slice(0, 10) : raw;
}

/** Existing chart policy: finite OHLC, ISO-shaped dates, last duplicate wins. */
export function toSortedBars(rows: readonly PriceBar[]): PriceBar[] {
  const clean = rows.filter((bar) => /^\d{4}-\d{2}-\d{2}$/.test(barDate(bar))
    && [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite))
    .map((bar) => ({ ...bar, date: barDate(bar) }))
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const out: PriceBar[] = [];
  for (const bar of clean) {
    if (out.length && barDate(out[out.length - 1]!) === bar.date) out[out.length - 1] = bar;
    else out.push(bar);
  }
  return out;
}

export function preparePricePlotData(rows: readonly PriceBar[], options: { showSma50?: boolean; showSma200?: boolean } = {}) {
  const bars = toSortedBars(rows);
  const candles = bars.map((bar) => ({ time: barDate(bar), open: bar.open, high: bar.high, low: bar.low, close: bar.close }));
  const volume = bars.filter((bar) => typeof bar.volume === "number" && Number.isFinite(bar.volume) && bar.volume >= 0)
    .map((bar) => ({ time: barDate(bar), value: bar.volume! }));
  const closes = bars.map((bar) => ({ date: barDate(bar), close: bar.close }));
  const line = (n: number, enabled: boolean) => enabled && bars.length >= n
    ? smaSeries(closes, n).filter((point) => point.value !== null).map((point) => ({ time: point.date, value: point.value! })) : [];
  const sma50 = line(50, options.showSma50 ?? true);
  const sma200 = line(200, options.showSma200 ?? true);
  const values = (points: readonly PlotPoint[]) => new Map(points.map((point) => [point.time, point.value]));
  const volumeByDate = values(volume), sma50ByDate = values(sma50), sma200ByDate = values(sma200);
  return { bars, candles, volume, sma50, sma200, rows: candles.map((point) => ({
    date: point.time, open: point.open, high: point.high, low: point.low, close: point.close,
    volume: volumeByDate.get(point.time) ?? null,
    sma50: sma50ByDate.get(point.time) ?? null, sma200: sma200ByDate.get(point.time) ?? null,
  })) };
}

function normDate(date: string): string { return date.length > 10 ? date.slice(0, 10) : date; }
function sortedUnique(rows: readonly RsRow[]): DatedClose[] {
  const clean = rows.map((row) => ({ date: normDate(row.date), close: row.close }))
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date))
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const out: DatedClose[] = [];
  for (const row of clean) {
    if (out.length && out[out.length - 1]!.date === row.date) out[out.length - 1] = row;
    else out.push(row);
  }
  return out;
}

/** Comparison cutoff; an individual series can start later if this date is absent. */
export function commonStartDate(series: readonly { rows: readonly RsRow[] }[]): string | null {
  let latest: string | null = null;
  for (const item of series) {
    const first = sortedUnique(item.rows).find((row) => Number.isFinite(row.close) && row.close > 0)?.date;
    if (first !== undefined && (latest === null || first > latest)) latest = first;
  }
  return latest;
}

/** Retain existing plot behavior: null rebased points are not submitted to the line. */
export function rebasedLineData(rows: readonly RsRow[], startDate?: string | null): PlotPoint[] {
  const scoped = sortedUnique(rows).filter((row) => startDate == null || row.date >= startDate);
  return rebaseTo100(scoped).filter((point) => point.value !== null)
    .map((point) => ({ time: point.date, value: point.value! }));
}

export function prepareRelativeStrengthPlotData(series: readonly RsSeries[]) {
  const startDate = commonStartDate(series);
  const prepared = series.map((item) => {
    const data = rebasedLineData(item.rows, startDate);
    return { label: item.label, data, baseDate: data[0]?.time ?? null };
  });
  const dates = [...new Set(series.flatMap((item) => sortedUnique(item.rows)
    .filter((row) => startDate === null || row.date >= startDate).map((row) => row.date)))].sort();
  const lookups = prepared.map((item) => new Map(item.data.map((point) => [point.time, point.value])));
  return { startDate, series: prepared, rows: dates.map((date) => ({ date, values: lookups.map((lookup) => lookup.get(date) ?? null) })) };
}
