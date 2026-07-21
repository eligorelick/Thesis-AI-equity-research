/**
 * SensitivityHeatmap — presentational heatmap table for the DCF WACC-by-terminal
 * -growth per-share grid. Rows = WACC %, columns = terminal growth %; each cell
 * is the intrinsic per-share value at that (WACC, g) pair, colored green(high)→
 * red(low) across the grid's own min/max. Null cells render as an em-dash; the
 * base-case cell (baseWacc × baseG) is outlined.
 *
 * Pure/presentational — no hooks, no charting library, no server imports. Safe
 * to render from a server OR client component (matches the ui.tsx primitives).
 * The color scale + range come from ./format (unit-tested there).
 */

import { EM_DASH, heatmapColor, heatmapRange, money, normalizeToRange, pct } from "./format";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** One grid cell — matches src/report/schema.ts SensitivityCell. */
export interface SensitivityCell {
  waccPct: number;
  gTermPct: number;
  /** Per-share intrinsic value; null when un-priced at this pair. */
  perShare: number | null;
}

export interface SensitivityHeatmapProps {
  /** Flat cell list (the schema stores the 5×5 grid flattened). */
  cells: readonly SensitivityCell[];
  /** Ordered WACC axis (rows). If omitted, derived from the cells. */
  waccAxis?: readonly number[];
  /** Ordered terminal-growth axis (columns). If omitted, derived from the cells. */
  gAxis?: readonly number[];
  /** Base-case WACC — the matching row/col cell is outlined. */
  baseWacc?: number | null;
  /** Base-case terminal growth — the matching row/col cell is outlined. */
  baseG?: number | null;
  /** Per-share decimals (default 0 — dense). */
  digits?: number;
}

// ---------------------------------------------------------------------------
// Pure axis + lookup helpers (exported for potential reuse/testing)
// ---------------------------------------------------------------------------

/** Sorted-unique numeric axis derived from a cell field. */
export function deriveAxis(
  cells: readonly SensitivityCell[],
  field: "waccPct" | "gTermPct",
): number[] {
  const set = new Set<number>();
  for (const c of cells) {
    const v = c[field];
    if (Number.isFinite(v)) set.add(v);
  }
  return [...set].sort((a, b) => a - b);
}

/** ~equality for axis matching (floats from the DCF grid). */
const AXIS_EPS = 1e-6;
function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= AXIS_EPS;
}

function lookup(
  cells: readonly SensitivityCell[],
  wacc: number,
  g: number,
): number | null {
  for (const c of cells) {
    if (near(c.waccPct, wacc) && near(c.gTermPct, g)) return c.perShare;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SensitivityHeatmap({
  cells,
  waccAxis,
  gAxis,
  baseWacc = null,
  baseG = null,
  digits = 0,
}: SensitivityHeatmapProps) {
  const rows = waccAxis && waccAxis.length > 0 ? [...waccAxis] : deriveAxis(cells, "waccPct");
  const cols = gAxis && gAxis.length > 0 ? [...gAxis] : deriveAxis(cells, "gTermPct");

  if (rows.length === 0 || cols.length === 0) {
    return (
      <div className="border border-edge bg-raised px-2 py-3 text-center text-[11px] text-faint">
        no sensitivity grid available
      </div>
    );
  }

  const range = heatmapRange(cells.map((c) => c.perShare));

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="border-b border-edge-strong">
            <th
              className="mono px-2 py-1 text-left text-[10px] font-medium tracking-[0.06em] text-faint"
              scope="col"
            >
              wacc \ g
            </th>
            {cols.map((g) => {
              const isBaseCol = baseG !== null && near(g, baseG);
              return (
                <th
                  key={g}
                  scope="col"
                  className={`mono px-2 py-1 text-right text-[10px] font-medium tracking-[0.06em] ${
                    isBaseCol ? "text-accent" : "text-faint"
                  }`}
                >
                  {pct(g, 1)}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((w) => {
            const isBaseRow = baseWacc !== null && near(w, baseWacc);
            return (
              <tr key={w} className="border-b border-edge last:border-b-0">
                <th
                  scope="row"
                  className={`mono px-2 py-1 text-left text-[10px] font-normal ${
                    isBaseRow ? "text-accent" : "text-faint"
                  }`}
                >
                  {pct(w, 1)}
                </th>
                {cols.map((g) => {
                  const v = lookup(cells, w, g);
                  const isBaseCell =
                    isBaseRow && baseG !== null && near(g, baseG);
                  const t = range ? normalizeToRange(v, range.min, range.max) : null;
                  const bg = heatmapColor(t);
                  return (
                    <td
                      key={g}
                      className={`mono px-2 py-1 text-right ${v === null ? "text-faint" : "text-fg"}`}
                      style={{
                        backgroundColor: bg,
                        outline: isBaseCell ? "1px solid var(--accent)" : undefined,
                        outlineOffset: isBaseCell ? "-1px" : undefined,
                      }}
                      aria-label={
                        v === null
                          ? `WACC ${w}% growth ${g}%: no value`
                          : `WACC ${w}% growth ${g}%: ${money(v, digits)} per share`
                      }
                    >
                      {v === null ? EM_DASH : money(v, digits)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-1 flex items-center gap-2 px-1 text-[10px] text-faint">
        <span>per share · rows = WACC %, cols = terminal g %</span>
        <span className="ml-auto inline-flex items-center gap-1">
          <span className="inline-block h-2 w-3" style={{ backgroundColor: heatmapColor(0) }} aria-hidden />
          <span>low</span>
          <span className="inline-block h-2 w-3" style={{ backgroundColor: heatmapColor(1) }} aria-hidden />
          <span>high</span>
        </span>
      </div>
    </div>
  );
}
