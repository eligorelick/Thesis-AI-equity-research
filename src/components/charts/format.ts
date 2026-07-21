/**
 * Chart-specific tabular formatters and pure data-shaping helpers.
 *
 * Presentational + pure: no DOM, no charting-library imports, no React. Every
 * export here is unit-tested in tests/charts.format.test.ts. Rounding happens
 * only at the render boundary (these formatters); the underlying data is never
 * mutated.
 *
 * The company page already ships a `format.ts` in src/app/company/[symbol];
 * these are the CHART variants — axis-tick oriented (shorter, integer-biased),
 * plus the data-shaping helpers the charts need (rebase-to-100, SMA overlays,
 * heatmap color scale) that don't belong in a display-only util.
 */

// ---------------------------------------------------------------------------
// Tabular formatters (axis ticks, tooltips)
// ---------------------------------------------------------------------------

const EN_DASH = "–"; // – for ranges
const EM_DASH = "—"; // — for null cells

/**
 * Compact large-number formatter for axis ticks / tooltips: 1.2T / 45.6B /
 * 789M / 12.3K. Fewer decimals than the page-level `fmtBig` so axis labels stay
 * short. Returns "—" for null/non-finite.
 */
export function compactNumber(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return EM_DASH;
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(digits)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(digits)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(digits)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(digits)}K`;
  return `${sign}${abs.toFixed(abs >= 100 ? 0 : digits)}`;
}

/** Compact currency: prefixes a `$`. */
export function compactCurrency(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return EM_DASH;
  const sign = v < 0 ? "-" : "";
  const body = compactNumber(Math.abs(v), digits);
  return `${sign}$${body}`;
}

/** Percent tick: "12.3%" (no forced sign). */
export function pct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return EM_DASH;
  return `${v.toFixed(digits)}%`;
}

/** Signed percent tick: "+12.3%" / "-4.5%". */
export function signedPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return EM_DASH;
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

/** Plain price with fixed decimals (tooltip): "123.45". */
export function price(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return EM_DASH;
  return v.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Money with `$`: "$123.45". */
export function money(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return EM_DASH;
  const sign = v < 0 ? "-" : "";
  return `${sign}$${price(Math.abs(v), digits)}`;
}

/** Multiple: "12.3×"; "n/m" when null (matches page convention). */
export function multiple(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/m";
  return `${v.toFixed(digits)}×`;
}

/** "YYYY" from an ISO date/datetime; em-dash when absent/too short. */
export function fiscalYear(iso: string | null | undefined): string {
  if (!iso || iso.length < 4) return iso ? iso : EM_DASH;
  return iso.slice(0, 4);
}

export { EN_DASH, EM_DASH };

// ---------------------------------------------------------------------------
// Rebase to 100 (relative-strength chart)
// ---------------------------------------------------------------------------

export interface DatedClose {
  /** ISO "YYYY-MM-DD" (longer strings tolerated; only ordering matters). */
  date: string;
  close: number;
}

export interface RebasedPoint {
  date: string;
  /** close / firstClose * 100, or null when un-rebasable. */
  value: number | null;
}

/**
 * Rebase a close series to 100 at its first finite, positive close. Points
 * before the base (or with non-finite closes) map to null. Deterministic and
 * total — never throws, never mutates the input.
 *
 * Used by RelativeStrengthChart to overlay the stock vs SPY vs sector ETF on a
 * common 100 baseline regardless of absolute price level.
 */
export function rebaseTo100(rows: readonly DatedClose[]): RebasedPoint[] {
  let base: number | null = null;
  const out: RebasedPoint[] = [];
  for (const r of rows) {
    const c = r.close;
    if (base === null) {
      if (Number.isFinite(c) && c > 0) {
        base = c;
        out.push({ date: r.date, value: 100 });
      } else {
        out.push({ date: r.date, value: null });
      }
      continue;
    }
    out.push({
      date: r.date,
      value: Number.isFinite(c) && c > 0 ? (c / base) * 100 : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Simple moving average (price-chart overlay)
// ---------------------------------------------------------------------------

export interface DatedValue {
  date: string;
  value: number | null;
}

/**
 * Simple moving average over a numeric close series; value is null until `n`
 * values are available. Non-finite closes break the window (the SMA at that
 * index and until the window refills is null) — this mirrors the price chart's
 * need to not draw a bogus average across a data hole.
 *
 * `n <= 0` or non-integer `n` yields all-null (with the dates preserved).
 */
export function smaSeries(
  rows: readonly DatedClose[],
  n: number,
): DatedValue[] {
  const out: DatedValue[] = rows.map((r) => ({ date: r.date, value: null }));
  if (!Number.isInteger(n) || n <= 0) return out;
  let sum = 0;
  let count = 0; // finite closes currently in the window
  const window: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i].close;
    const finite = Number.isFinite(c);
    window.push(finite ? c : Number.NaN);
    if (finite) {
      sum += c;
      count += 1;
    }
    if (window.length > n) {
      const dropped = window.shift() as number;
      if (Number.isFinite(dropped)) {
        sum -= dropped;
        count -= 1;
      }
    }
    // Emit only when the window is full AND every member is finite.
    if (window.length === n && count === n) {
      out[i] = { date: rows[i].date, value: sum / n };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Heatmap color scale (DCF sensitivity grid)
// ---------------------------------------------------------------------------

/**
 * Map a per-share value into a [0,1] normalized position within [min,max],
 * where 0 = worst (min) and 1 = best (max). Returns null for null/non-finite
 * inputs. When min == max (degenerate range) every finite cell maps to 0.5.
 */
export function normalizeToRange(
  v: number | null,
  min: number,
  max: number,
): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (max === min) return 0.5;
  const t = (v - min) / (max - min);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Green(high)→amber(mid)→red(low) background for a normalized [0,1] position.
 * Returns a `rgba(...)` string using the theme's --pos/--warn/--neg hues at a
 * low alpha so cell text stays legible on the dark panel. `null` → transparent.
 *
 * Colors are the resolved RGB of the CSS variables (kept in sync with
 * globals.css): --pos #2ecc8f, --warn #e8b339, --neg #f0525f.
 */
export function heatmapColor(t: number | null, alpha = 0.22): string {
  if (t === null || !Number.isFinite(t)) return "transparent";
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  // Two-stop gradient: red(0) → amber(0.5) → green(1).
  const neg: RGB = [240, 82, 95]; // --neg
  const warn: RGB = [232, 179, 57]; // --warn
  const pos: RGB = [46, 204, 143]; // --pos
  const rgb =
    clamped <= 0.5
      ? lerpRgb(neg, warn, clamped / 0.5)
      : lerpRgb(warn, pos, (clamped - 0.5) / 0.5);
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

type RGB = [number, number, number];

function lerpRgb(a: RGB, b: RGB, t: number): RGB {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return [
    Math.round(a[0] + (b[0] - a[0]) * clamped),
    Math.round(a[1] + (b[1] - a[1]) * clamped),
    Math.round(a[2] + (b[2] - a[2]) * clamped),
  ];
}

export interface HeatmapRange {
  min: number;
  max: number;
}

/**
 * Min/max of the finite per-share cells in a flat/nested cell list. Returns
 * null when there are no finite cells (grid entirely un-priced). Used to set
 * the heatmap's color-scale domain before mapping each cell.
 */
export function heatmapRange(
  values: ReadonlyArray<number | null>,
): HeatmapRange | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let seen = false;
  for (const v of values) {
    if (v === null || !Number.isFinite(v)) continue;
    seen = true;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return seen ? { min, max } : null;
}
