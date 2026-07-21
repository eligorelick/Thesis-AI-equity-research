/**
 * Deterministic synthetic price/benchmark generator for the offline /report/sample
 * route, where no live EOD history exists but we still want the price + relative-
 * strength charts to mount so the full UI is viewable without an API key.
 *
 * Pure + seeded (no Math.random) so the sample renders identically every time and
 * SSR/CSR agree. Produces ~2 years of daily bars — enough to exercise SMA50 and to
 * show (but auto-skip) SMA200 without dominating the page.
 */

import type { PriceBar } from "./PriceChart";
import type { RsSeries } from "./RelativeStrengthChart";
import type {
  FundamentalsChartData,
  RevenueRow,
  MarginRow,
  FcfRow,
  ShareCountRow,
} from "./FundamentalsCharts";

/** Tiny deterministic PRNG (mulberry32) — stable across runs and environments. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ISO "YYYY-MM-DD" `n` weekdays before an anchor date (skips Sat/Sun). */
function weekdaySeries(anchorIso: string, count: number): string[] {
  const anchor = new Date(`${anchorIso}T00:00:00Z`);
  const days: string[] = [];
  const cursor = new Date(anchor.getTime());
  while (days.length < count) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return days.reverse();
}

interface SyntheticSeriesOptions {
  /** Latest (most recent) close the walk should end near. */
  endClose: number;
  /** Approximate total drift over the window, as a fraction (0.25 = +25%). */
  drift: number;
  /** Per-step volatility fraction. */
  vol: number;
  seed: number;
  dates: string[];
}

/** A seeded geometric-ish random walk anchored to end near `endClose`. */
function randomWalk(opts: SyntheticSeriesOptions): number[] {
  const { endClose, drift, vol, seed, dates } = opts;
  const rand = mulberry32(seed);
  const n = dates.length;
  // Start below the end by the drift so the series trends up to endClose.
  const startClose = endClose / (1 + drift);
  const closes: number[] = [];
  let price = startClose;
  const perStepDrift = Math.pow(1 + drift, 1 / Math.max(1, n - 1)) - 1;
  for (let i = 0; i < n; i++) {
    const shock = (rand() - 0.5) * 2 * vol;
    price = price * (1 + perStepDrift + shock);
    if (price <= 1) price = 1;
    closes.push(price);
  }
  // Renormalize so the final close lands exactly on endClose (clean legend value).
  const factor = endClose / closes[closes.length - 1];
  return closes.map((c) => c * factor);
}

/** Build synthetic OHLCV bars from a close walk (opens/highs/lows derived deterministically). */
function toBars(dates: string[], closes: number[], seed: number): PriceBar[] {
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const bars: PriceBar[] = [];
  for (let i = 0; i < dates.length; i++) {
    const close = closes[i];
    const prevClose = i > 0 ? closes[i - 1] : close;
    const open = prevClose * (1 + (rand() - 0.5) * 0.01);
    const high = Math.max(open, close) * (1 + rand() * 0.012);
    const low = Math.min(open, close) * (1 - rand() * 0.012);
    const volume = Math.round(4_000_000 + rand() * 8_000_000);
    bars.push({
      date: dates[i],
      open: round2(open),
      high: round2(high),
      low: round2(low),
      close: round2(close),
      volume,
    });
  }
  return bars;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export interface SyntheticMarketData {
  bars: PriceBar[];
  crosses: { date: string; type: "golden" | "death" }[];
  relativeStrength: RsSeries[];
}

/**
 * ~2y of deterministic daily data for a symbol plus SPY / sector-ETF benchmarks,
 * rebased-comparable for the relative-strength chart, with one golden-cross marker
 * placed at roughly the 70% mark of the window.
 */
export function syntheticMarketData(
  symbol: string,
  anchorIso = "2025-09-27",
  bars = 300,
): SyntheticMarketData {
  const dates = weekdaySeries(anchorIso, bars);

  const symClose = randomWalk({ endClose: 255, drift: 0.32, vol: 0.012, seed: 1337, dates });
  const spyClose = randomWalk({ endClose: 560, drift: 0.18, vol: 0.008, seed: 4242, dates });
  const xlkClose = randomWalk({ endClose: 240, drift: 0.24, vol: 0.01, seed: 909, dates });

  const symBars = toBars(dates, symClose, 1337);

  // Place a golden-cross marker at ~70% through the window (a real date
  // in-series). Guard the empty-window edge: dates[0] on a zero-bar series
  // would fabricate a { date: undefined } marker.
  const crossIdx = Math.floor(dates.length * 0.7);
  const crosses: { date: string; type: "golden" | "death" }[] =
    dates.length > 0 ? [{ date: dates[crossIdx] as string, type: "golden" }] : [];

  const relativeStrength: RsSeries[] = [
    {
      label: symbol,
      role: "primary",
      rows: dates.map((d, i) => ({ date: d, close: symClose[i] })),
    },
    {
      label: "SPY",
      role: "benchmark",
      rows: dates.map((d, i) => ({ date: d, close: spyClose[i] })),
    },
    {
      label: "XLK",
      role: "benchmark",
      rows: dates.map((d, i) => ({ date: d, close: xlkClose[i] })),
    },
  ];

  return { bars: symBars, crosses, relativeStrength };
}

// ---------------------------------------------------------------------------
// Synthetic fundamentals (revenue/margin/FCF/share-count) for /report/sample
// ---------------------------------------------------------------------------

/**
 * Deterministic ~8-fiscal-year fundamentals series for the offline sample. Loosely
 * AAPL-shaped (growing revenue, ~44% gross / ~30% op / ~25% net margins, strong FCF,
 * steady buybacks) so the four fundamentals charts render meaningfully without live
 * statements. Values are illustrative only.
 */
export function syntheticFundamentals(endFiscalYear = 2025, years = 8): FundamentalsChartData {
  const fy = (y: number): string => `${y}-09-30`;
  const startYear = endFiscalYear - years + 1;

  const revenue: RevenueRow[] = [];
  const margins: MarginRow[] = [];
  const fcf: FcfRow[] = [];
  const shareCount: ShareCountRow[] = [];

  // Revenue billions, growing ~7%/yr with mild wobble.
  let rev = 265;
  let prevRev: number | null = null;
  let shares = 17.0; // billions, declining via buybacks
  for (let i = 0; i < years; i++) {
    const y = startYear + i;
    const period = fy(y);
    const wobble = 1 + (i % 2 === 0 ? 0.02 : -0.005);
    rev = rev * (1.07 * wobble);
    const revB = Math.round(rev * 10) / 10;
    const yoy =
      prevRev !== null ? Math.round(((revB - prevRev) / prevRev) * 1000) / 10 : null;
    revenue.push({ period, revenue: revB * 1e9, yoyGrowthPct: yoy });
    prevRev = revB;

    const gross = 42 + i * 0.35;
    const op = 28 + i * 0.25;
    const net = 23 + i * 0.28;
    margins.push({
      period,
      grossPct: Math.round(gross * 10) / 10,
      operatingPct: Math.round(op * 10) / 10,
      netPct: Math.round(net * 10) / 10,
    });

    const fcfB = revB * (0.26 + i * 0.002);
    const conv = 105 + (i % 3) * 4;
    fcf.push({ period, fcf: Math.round(fcfB) * 1e9, conversionPct: conv });

    shares = shares * 0.975; // ~2.5%/yr buyback
    shareCount.push({ period, dilutedShares: Math.round(shares * 1e9) });
  }

  return { revenue, margins, fcf, shareCount };
}
