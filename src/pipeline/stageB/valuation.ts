/**
 * Stage B — valuation engine (own DCF, sensitivity grid, reverse DCF,
 * multiples framework, sector-override models).
 *
 * PURE, deterministic TypeScript: no network, no db, no LLM. Inputs are plain
 * typed rows whose field names match FMP exactly (see the provider data contract §2.3/§2.5);
 * the integration agent wires the DataBundle into these interfaces.
 *
 * Conventions:
 * - Every rate/percentage field suffixed `Pct` is in PERCENT units (8 = 8%).
 *   Conversion to decimals happens only inside discounting math.
 * - Missing inputs never throw: results carry ManifestEntry-compatible gaps.
 * - FMP zero-for-undisclosed is treated as null where a zero is implausible.
 * - Every "house rule" (clamp/fade/guard) that fires is annotated in notes[].
 * - Full precision is returned everywhere; round only at display time.
 *
 * Methodology source: the valuation methodology (Damodaran-standard).
 */

import type { CompanyRoute, ManifestEntry, SectorRoute } from "@/types/core";
import { deriveFcf } from "@/pipeline/stageB/financialValues";
import { latestOnOrBeforeWithin } from "@/pipeline/stageB/asOfSelection";
import { metricPolicy } from "@/pipeline/stageB/sectorRouting";
import { linearRegressionSlope, yearsBetweenDates } from "@/pipeline/stageB/growth";
import {
  contiguousQuarterWindows,
  normalizeQuarterRows,
} from "@/pipeline/stageB/quarterWindows";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** Every DCF assumption carries its value plus a human-readable basis string. */
export interface Assumption<T> {
  value: T;
  basis: string;
}

/** House-rule constants (annotated in notes whenever they fire). */
export const DCF_HORIZON_YEARS = 10;
// Spec §2.2 (the valuation methodology line 276): clamp starting growth
// g_1 ∈ [−10%, +25%]. (Every other clamp here matches its spec value exactly;
// this one had drifted to [-15, 40], inflating the DCF for high-growth names
// with no analyst estimates — corrected back to spec.)
export const NEAR_TERM_GROWTH_CLAMP_PP: readonly [number, number] = [-10, 25];
export const S2C_CLAMP: readonly [number, number] = [0.5, 5.0];
export const TERMINAL_G_CAP_PCT = 2.5;

/**
 * Terminal excess-return house rule.
 *
 * The default terminal ROIC equals WACC: growth adds nothing after the
 * explicit horizon. That is McKinsey's recommendation for most firms and it
 * is what the 21-issuer keyless sweep of 2026-09-02 ran on — where it valued
 * every evidenced compounder (Apple at 92% ROIC, Home Depot 22%, Coca-Cola
 * 18%) as if its returns collapsed to the cost of capital in year 11, and
 * graded 19 of 21 large caps D or F on valuation. McKinsey (Valuation,
 * "Estimating continuing value") sets RONIC above WACC only for firms with
 * sustainable advantages, and its ROIC-persistence data show a top-quintile
 * spread over WACC roughly halving over 10-15 years rather than closing;
 * Damodaran allows perpetual excess returns only when they are modest.
 *
 * So: when ROIC exceeded WACC in every one of the last
 * TERMINAL_EXCESS_RETURN_MIN_YEARS+ fiscal years on record, half the median
 * spread is carried in perpetuity, capped at TERMINAL_EXCESS_RETURN_CAP_PP.
 * Anything short of that evidence keeps the default, and the reason is
 * written into the assumption notes.
 */
export const TERMINAL_EXCESS_RETURN_CAP_PP = 5;
export const TERMINAL_EXCESS_RETURN_MIN_YEARS = 4;
export const TERMINAL_EXCESS_RETURN_CARRY = 0.5;
/** Below this carried spread the evidence is noise; the default applies. */
export const TERMINAL_EXCESS_RETURN_MIN_PP = 0.5;
/** Base-case Gordon TV guard: require WACC − g_term ≥ 2.0pp (spec §2.3 line 313). */
export const TV_GUARD_PP = 2.0;
/**
 * Sensitivity-grid cells use a LOOSER guard than the base case: spec §3 (line
 * 385) renders a cell "n/m" only when WACC − g_term < 1.5%. Reusing the 2.0pp
 * base-case guard nulled corner cells the spec wants computed.
 */
export const GRID_TV_GUARD_PP = 1.5;
export const MARGIN_CLAMP_PP: readonly [number, number] = [-20, 45];
export const MARGIN_WARN_BAND_PP: readonly [number, number] = [0, 35];
export const MARGIN_FADE_YEARS = 5;
/** Dated margin slope needed to classify a clear improving/declining regime. */
export const MARGIN_TREND_THRESHOLD_PP_PER_YEAR = 0.5;
export const SENSITIVITY_STEPS_PP: readonly number[] = [-1, -0.5, 0, 0.5, 1];
export const REVERSE_GROWTH_RANGE_PCT: readonly [number, number] = [-20, 60];
export const REVERSE_MARGIN_RANGE_PCT: readonly [number, number] = [0, 60];
export const REVERSE_PRESCAN_POINTS = 17;
export const BISECTION_TOL_PP = 0.01; // 1bp of growth/margin
export const BISECTION_MAX_ITER = 80;
export const EXCESS_RETURN_YEARS = 10;
/**
 * Bisection bracket for the excess-return reverse solve.
 *
 * MUST span the reachable value range of the objective it inverts. When that
 * objective became the FADE path, [0, 40] stopped covering it: the invertible
 * window collapsed to roughly [0.60x, 2.79x] book, so a bank trading below
 * ~0.6x book (routine for a distressed or sub-book bank) and an insurer above
 * ~2.8x both fell outside the bracket and returned null — dropping the
 * 0.5-weight valuation signal entirely.
 *
 * A negative lower bound is not a modelling artefact: a loss-making issuer has
 * a genuinely negative ROE, and the solve must be able to say so.
 */
export const REVERSE_ROE_RANGE_PCT: readonly [number, number] = [-40, 80];
export const PAYOUT_CLAMP_PCT: readonly [number, number] = [0, 90];
export const MIN_PEERS_FOR_STATS = 4;
export const MIN_HISTORY_OBS_FOR_BAND = 8;
/** Full 5-year own-history window (deriveOwnHistory caps here). Below it, bands are flagged low-sample. */
export const FULL_OWN_HISTORY_OBS = 20;

const isNum = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** Guarded division: null on missing/zero/non-finite denominator. */
export function safeDiv(
  num: number | null | undefined,
  den: number | null | undefined,
): number | null {
  if (!isNum(num) || !isNum(den) || den === 0) return null;
  const r = num / den;
  return Number.isFinite(r) ? r : null;
}

/** FMP emits 0 for undisclosed items — null where a zero is implausible. */
const zeroAsNull = (v: number | null | undefined): number | null =>
  isNum(v) && v !== 0 ? v : null;

const posOrNull = (v: number | null | undefined): number | null =>
  isNum(v) && v > 0 ? v : null;

const fmtNum = (v: number): string => String(Math.round(v * 100) / 100);

const gapEntry = (
  field: string,
  reason: string,
  severity: ManifestEntry["severity"],
): ManifestEntry => ({ field, reason, severity });

/** Clamp with a note appended when the clamp actually fires. */
function clampWithNote(
  v: number,
  lo: number,
  hi: number,
  label: string,
  notes: string[],
): number {
  if (v < lo) {
    notes.push(`${label} clamped ${fmtNum(v)} -> ${fmtNum(lo)} (house rule range [${lo}, ${hi}])`);
    return lo;
  }
  if (v > hi) {
    notes.push(`${label} clamped ${fmtNum(v)} -> ${fmtNum(hi)} (house rule range [${lo}, ${hi}])`);
    return hi;
  }
  return v;
}

/**
 * Linear fade from startPct (year 1) to endPct (year `years`), inclusive.
 * Exported because reverseDcf's margin fallback rebuilds paths with it and
 * tests must reproduce the exact same construction.
 */
export function fadePath(startPct: number, endPct: number, years: number): number[] {
  if (years <= 0) return [];
  if (years === 1) return [endPct];
  return Array.from(
    { length: years },
    (_, i) => startPct + ((endPct - startPct) * i) / (years - 1),
  );
}

/** Linear-interpolated quantile (p in [0,1]) over finite values. */
export function quantile(values: number[], p: number): number | null {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const idx = Math.min(Math.max(p, 0), 1) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export const medianOf = (values: number[]): number | null => quantile(values, 0.5);

/**
 * Percentile rank (0–100) of v within values, linear interpolation between
 * order statistics (the valuation methodology §5.4). Needs >= 2 values.
 */
export function percentileRank(values: number[], v: number): number | null {
  const s = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length < 2 || !Number.isFinite(v)) return null;
  if (v <= s[0]) return 0;
  if (v >= s[s.length - 1]) return 100;
  for (let i = 0; i < s.length - 1; i++) {
    if (v >= s[i] && v <= s[i + 1]) {
      const frac = s[i + 1] === s[i] ? 0 : (v - s[i]) / (s[i + 1] - s[i]);
      return ((i + frac) / (s.length - 1)) * 100;
    }
  }
  return null; // unreachable for finite sorted input
}

// ---------------------------------------------------------------------------
// DCF assumptions
// ---------------------------------------------------------------------------

/** Annual analyst-estimate row (FMP /stable/analyst-estimates field names). */
export interface AnalystEstimateRow {
  /** Fiscal period end the estimate refers to (ISO). */
  date: string;
  revenueAvg: number | null;
}

/** Income-statement slice used by the DCF builder (FMP field names). */
export interface DcfIncomeRow {
  date: string;
  /** Four-quarter TTM or the latest audited annual statement when TTM is unavailable. */
  basis?: "ttm" | "annual";
  revenue: number | null;
  operatingIncome: number | null;
  incomeBeforeTax?: number | null;
  incomeTaxExpense?: number | null;
}

/** Selected whole balance-sheet slice used by the DCF builder (FMP field names). */
export interface DcfBalanceRow {
  date: string;
  basis: "quarter" | "annual";
  totalDebt: number | null;
  totalStockholdersEquity: number | null;
  cashAndShortTermInvestments: number | null;
}

/** WS6 (D-19): SBC treatment, with the reported FCF before and after it. */
export interface DcfSbcTreatment {
  beforeSbc: number | null;
  afterSbc: number | null;
  sbc: number | null;
  asOf: string | null;
  basis: string;
}

/**
 * WS6 (D-18): log-linear revenue trend over every annual year on record
 * (growth.ts `logLinearGrowth`). Structural, so the DCF does not depend on the
 * whole GrowthResult.
 */
export interface DcfRevenueTrend {
  growthPct: number | null;
  rSquared: number | null;
  n: number;
  startDate: string | null;
  endDate: string | null;
}

export interface DcfAssumptionInputs {
  /** 3y revenue CAGR in percent (computed upstream from statements); null when unavailable. */
  revenueCagr3yPct: number | null;
  /** 5y revenue CAGR in percent — one of the growth-anchor methods (D-18). */
  revenueCagr5yPct?: number | null;
  /**
   * WS6 (D-18): the log-linear regression method of the growth anchor. Absent
   * or null makes it an unavailable method, named as such in the basis.
   */
  revenueLogLinear?: DcfRevenueTrend | null;
  /**
   * WS6 (D-19): the WACC disclosure sentence (returns.ts `waccDisclosure`),
   * printed verbatim in the assumption block so the discount rate is never an
   * unattributed percentage.
   */
  waccBasis?: string | null;
  /**
   * WS6 (D-19): the reported free-cash-flow metric before and after the SBC
   * deduction (capital.ts). The FCFF DCF does not consume FCF — it projects
   * EBIT, which already expenses SBC — but the assumption block must show the
   * adjustment so the two numbers a reader sees are never silently different
   * definitions.
   */
  fcfSbc?: DcfSbcTreatment | null;
  /** Forward annual analyst estimates (FMP names); null/empty when uncovered. */
  analystEstimates: AnalystEstimateRow[] | null;
  waccPct: number;
  riskFreePct: number;
  /**
   * Statements' reportedCurrency (ADR guard, 2026-07-09 audit H3). When it
   * differs from quoteCurrency the DCF per-share would be in reported currency
   * against a quote-currency price — valueCompany suppresses the DCF instead
   * (mirroring the multiples currencyMismatch flag; no FX conversion).
   */
  reportedCurrency?: string | null;
  /** Listing/trading currency of the quote and market cap. */
  quoteCurrency?: string | null;
  /** Base income statement: four-quarter TTM, or an explicitly labeled annual fallback. */
  incomeTtm: DcfIncomeRow | null;
  /** Annual income history (any order; used for 5y median margin + trend). */
  incomeHistory: DcfIncomeRow[];
  /** Selected newest whole balance row; required invested-capital fields fail closed. */
  balance: DcfBalanceRow | null;
  marketCap: number | null;
  /**
   * Annual ROIC history (any order; the newest five count), the evidence
   * behind the terminal excess-return house rule. Omitted or null: the
   * terminal ROIC stays at WACC without comment.
   */
  roicHistory?: DcfRoicYear[] | null;
}

export interface DcfRoicYear {
  date: string;
  roicPct: number | null;
  /**
   * WS6 (D-19): that fiscal year's OWN WACC, recomputed from the risk-free
   * observation at its year end (returns.ts `waccByFiscalYear`). Absent or
   * null means the current WACC is applied to that year and the note says so.
   */
  waccPct?: number | null;
  /** Date of the risk-free observation behind `waccPct`. */
  waccAsOf?: string | null;
}

export interface TerminalRoic {
  roicTermPct: number;
  /** Excess return carried in perpetuity, percentage points above WACC (0 = default). */
  excessPp: number;
  basis: string;
  /** Why the default held when history was supplied; null when none is owed. */
  note: string | null;
  /**
   * WS6 (D-19): how each fiscal year's ROIC was compared to a cost of capital.
   * "per-year" when at least one year carried its own recomputed WACC,
   * "current" when the single current WACC was applied to every year,
   * "none" when no history was supplied.
   */
  waccBasis: "per-year" | "current" | "none";
  /** The comparison sentence, so the assumption block can state it verbatim. */
  waccBasisNote: string | null;
}

const TERMINAL_ROIC_DEFAULT_BASIS =
  "terminal ROIC = WACC (zero excess returns in perpetuity, HOUSE CONVENTION default — see docs/METHODOLOGY.md, \"Terminal value house convention\")";

/**
 * Apply the terminal excess-return HOUSE CONVENTION (see
 * TERMINAL_EXCESS_RETURN_CAP_PP). It is not a standard: it is this app's own
 * convention, and it is labelled as such wherever it is printed.
 *
 * WS6 (D-19): each fiscal year is compared to its OWN WACC when the caller
 * supplied one (recomputed from that year end's risk-free observation); years
 * without one fall back to the current WACC and the note says which happened.
 */
export function terminalRoic(waccPct: number, history: DcfRoicYear[] | null): TerminalRoic {
  const hold = (
    note: string | null,
    waccBasis: TerminalRoic["waccBasis"],
    waccBasisNote: string | null,
  ): TerminalRoic => ({
    roicTermPct: waccPct,
    excessPp: 0,
    basis: TERMINAL_ROIC_DEFAULT_BASIS,
    note,
    waccBasis,
    waccBasisNote,
  });
  if (history === null) return hold(null, "none", null);
  const years = history
    .filter((y): y is DcfRoicYear & { roicPct: number } => isNum(y.roicPct))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5);
  const n = years.length;
  // Each year against its own cost of capital when one was recomputed for it.
  const waccForYear = (y: DcfRoicYear): number => (isNum(y.waccPct) ? y.waccPct : waccPct);
  const perYear = years.filter((y) => isNum(y.waccPct));
  const currentOnly = years.filter((y) => !isNum(y.waccPct));
  // N5: with a history supplied but NO year carrying a computable ROIC there is
  // no ROIC-vs-WACC comparison at all, so blaming a missing per-year risk-free
  // observation misstated the cause. Report "none" and say nothing about rates;
  // the `n < TERMINAL_EXCESS_RETURN_MIN_YEARS` branch below already names the
  // real reason ("0 fiscal years of ROIC on record").
  const waccBasis: TerminalRoic["waccBasis"] =
    n === 0 ? "none" : perYear.length > 0 ? "per-year" : "current";
  const waccBasisNote =
    n === 0
      ? null
      : perYear.length === 0
      ? `ROIC-vs-WACC history compares every fiscal year to the CURRENT WACC ${fmtNum(waccPct)}% — no per-year risk-free observation was available to recompute a year-specific WACC`
      : `ROIC-vs-WACC history uses each fiscal year's own WACC, recomputed from that year end's risk-free observation (${perYear
          .map((y) => `${y.date}: ${fmtNum(waccForYear(y))}%${y.waccAsOf ? ` (rf as of ${y.waccAsOf})` : ""}`)
          .join(", ")})` +
        (currentOnly.length > 0
          ? `; the current WACC ${fmtNum(waccPct)}% was applied to ${currentOnly
              .map((y) => y.date)
              .join(", ")}, which had no usable risk-free observation`
          : "");
  if (n < TERMINAL_EXCESS_RETURN_MIN_YEARS) {
    return hold(
      `terminal ROIC held at WACC: ${n} fiscal year${n === 1 ? "" : "s"} of ROIC on record, ${TERMINAL_EXCESS_RETURN_MIN_YEARS} needed to evidence durable excess returns (house convention)`,
      waccBasis,
      waccBasisNote,
    );
  }
  const below = years.filter((y) => y.roicPct <= waccForYear(y));
  if (below.length > 0) {
    return hold(
      `terminal ROIC held at WACC: ROIC was at or below that year's WACC in ${below.length} of the last ${n} fiscal years (${below
        .map((y) => `${y.date}: ROIC ${fmtNum(y.roicPct)}% vs WACC ${fmtNum(waccForYear(y))}%`)
        .join("; ")}) — excess returns not evidenced as durable (house convention)`,
      waccBasis,
      waccBasisNote,
    );
  }
  const spreads = years.map((y) => y.roicPct - waccForYear(y));
  const median = medianOf(spreads) as number;
  const excess = Math.min(TERMINAL_EXCESS_RETURN_CAP_PP, TERMINAL_EXCESS_RETURN_CARRY * median);
  if (excess < TERMINAL_EXCESS_RETURN_MIN_PP) {
    return hold(
      `terminal ROIC held at WACC: ROIC exceeded WACC in all ${n} fiscal years but the median spread ${fmtNum(median)}pp is too thin to carry (house convention floor ${TERMINAL_EXCESS_RETURN_MIN_PP}pp)`,
      waccBasis,
      waccBasisNote,
    );
  }
  const oldest = years[n - 1].date;
  const newest = years[0].date;
  return {
    roicTermPct: waccPct + excess,
    excessPp: excess,
    basis:
      `terminal ROIC = WACC ${fmtNum(waccPct)}% + ${fmtNum(excess)}pp evidenced excess return: ROIC exceeded WACC in each of the last ${n} fiscal years ` +
      `(${oldest} to ${newest}, median spread ${fmtNum(median)}pp); half the spread is carried in perpetuity, capped at ${TERMINAL_EXCESS_RETURN_CAP_PP}pp ` +
      "(HOUSE CONVENTION after McKinsey's RONIC guidance and Damodaran's modest-excess-return cap — not a standard; see docs/METHODOLOGY.md)",
    note: null,
    waccBasis,
    waccBasisNote,
  };
}

/** WS6 (D-18): one method of the growth anchor and what it produced. */
export interface GrowthAnchorMethod {
  name: string;
  valuePct: number | null;
  /** Value with its fit statistics / window, or the reason it was unavailable. */
  detail: string;
}

/** WS6 (D-18): median-of-methods near-term growth anchor. */
export interface GrowthAnchor {
  /**
   * The year-one growth the DCF actually fades from — the median of the
   * available methods AFTER the near-term clamp (WS6 review, SHOULD-FIX 1).
   * It used to carry the pre-clamp median, so the assumption table could print
   * a 65% anchor beside a 25% year-one growth taken from the same anchor.
   */
  pointPct: number;
  /**
   * The pre-clamp median, present ONLY when the clamp actually moved the value.
   * Undefined means the anchor is the median untouched.
   */
  preClampMedianPct?: number;
  /** Min..max across the available methods; null when only one was available. */
  rangePct: [number, number] | null;
  methods: GrowthAnchorMethod[];
  /** Names of the methods that could not be computed. */
  unavailable: string[];
  basis: string;
}

export interface DcfAssumptions {
  startRevenue: Assumption<number>;
  /** Explicit horizon (default 10). */
  years: number;
  /** WS6 (D-19): the discount rate with every input named. */
  wacc: Assumption<number>;
  /** WS6 (D-19): SBC treatment, with the reported FCF before and after it. */
  sbc: Assumption<DcfSbcTreatment>;
  /** WS6 (D-18): the growth anchor's methods, point estimate and range. */
  growthAnchor: GrowthAnchor;
  /** Revenue growth per explicit year, percent, length === years. */
  growthPath: Assumption<number[]>;
  /** EBIT margin per explicit year, percent, length === years. */
  ebitMarginPath: Assumption<number[]>;
  /** Company-specific effective tax rate per explicit year, percent. */
  taxRatePath: Assumption<number[]>;
  salesToCapital: Assumption<number>;
  terminal: {
    gTermPct: Assumption<number>;
    /** Terminal ROIC, percent — default = WACC (zero excess returns). */
    roicTermPct: Assumption<number>;
    /** Terminal reinvestment rate as a FRACTION of NOPAT: g / ROIC. */
    reinvestmentRate: Assumption<number>;
  };
  midYear: Assumption<boolean>;
  asOf: { statements: string | null; estimates: string | null };
  notes: string[];
}

export interface BuildDcfAssumptionsResult {
  assumptions: DcfAssumptions | null;
  notes: string[];
  gaps: ManifestEntry[];
}

// Day-count handling for the TTM→FY1 analyst leg (2026-07-09 audit L3): the
// TTM window and the FY1 estimate are both 12-month figures whose END DATES
// are offset by the TTM→FY1 span, so the raw ratio is growth over that span —
// treating a 3–9 month offset as a full-year rate depresses the whole fade
// path for mid-fiscal-year runs.
const DAYS_PER_YEAR = 365.25;
const LEG_DAY_MS = 24 * 3600 * 1000;
/** Below this span the partial-period ratio is too noisy to annualize — skip the leg. */
const ANALYST_LEG_MIN_DAYS = 90;
/** Spans in this band are an aligned fiscal year (52/53-week calendars) — the ratio IS the annual rate. */
const ANALYST_LEG_ALIGNED_DAYS: readonly [number, number] = [351, 380];

/** Average analyst-implied revenue growth over the next ~2 fiscal years, percent. */
function analystTwoYearGrowthPct(
  rows: AnalystEstimateRow[] | null,
  ttmRevenue: number | null,
  ttmDate: string | null,
): { value: number | null; asOf: string | null; notes: string[] } {
  const notes: string[] = [];
  if (!rows || rows.length === 0) return { value: null, asOf: null, notes };
  const future = rows
    .filter((r) => posOrNull(r.revenueAvg) !== null && (!ttmDate || r.date > ttmDate))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 2);
  if (future.length === 0) return { value: null, asOf: null, notes };
  const growths: number[] = [];
  const base = posOrNull(ttmRevenue);
  if (base !== null) {
    const ratio = (future[0].revenueAvg as number) / base;
    const t0 = ttmDate !== null ? Date.parse(ttmDate) : Number.NaN;
    const t1 = Date.parse(future[0].date);
    const days =
      Number.isFinite(t0) && Number.isFinite(t1) ? Math.round((t1 - t0) / LEG_DAY_MS) : null;
    if (
      days === null ||
      (days >= ANALYST_LEG_ALIGNED_DAYS[0] && days <= ANALYST_LEG_ALIGNED_DAYS[1])
    ) {
      // Aligned full fiscal year (or no day-count derivable): raw ratio is the annual rate.
      growths.push((ratio - 1) * 100);
    } else if (days < ANALYST_LEG_MIN_DAYS) {
      notes.push(
        `analyst year-1 growth leg skipped: TTM end ${ttmDate} to FY1 end ${future[0].date} spans only ${days} days (< ${ANALYST_LEG_MIN_DAYS}) — too noisy to annualize; FY1→FY2 leg used alone`,
      );
    } else {
      const annualized = (Math.pow(ratio, DAYS_PER_YEAR / days) - 1) * 100;
      notes.push(
        `analyst year-1 growth leg annualized by day-count: ${fmtNum((ratio - 1) * 100)}% over ${days} days (TTM end ${ttmDate} → FY1 end ${future[0].date}) → ${fmtNum(annualized)}%/yr`,
      );
      growths.push(annualized);
    }
  }
  if (future.length === 2) {
    growths.push(((future[1].revenueAvg as number) / (future[0].revenueAvg as number) - 1) * 100);
  }
  if (growths.length === 0) return { value: null, asOf: null, notes };
  return {
    value: growths.reduce((a, b) => a + b, 0) / growths.length,
    asOf: future[future.length - 1].date,
    notes,
  };
}

/**
 * Build the base-case DCF assumption block. Every assumption carries
 * {value, basis}; every clamp/fallback fired lands in notes[]; missing inputs
 * produce gaps and — when the base is unusable — a null assumptions object.
 */
export function buildDcfAssumptions(inputs: DcfAssumptionInputs): BuildDcfAssumptionsResult {
  const notes: string[] = [];
  const gaps: ManifestEntry[] = [];
  const years = DCF_HORIZON_YEARS;

  const ttm = inputs.incomeTtm;
  const periodBasis = ttm?.basis === "annual" ? `latest annual FY ${ttm.date}` : "TTM";
  const startRev = posOrNull(zeroAsNull(ttm?.revenue));
  if (startRev === null) {
    gaps.push(
      gapEntry(
        "valuation.dcf.startRevenue",
        "base-period revenue missing or non-positive (FMP zero-for-undisclosed treated as null) — DCF not buildable",
        "critical",
      ),
    );
    return { assumptions: null, notes, gaps };
  }

  // --- Terminal growth: min(2.5, rf) — Damodaran g <= rf rule --------------
  // Computed first: the near-term anchor falls back to it when revenue
  // history shows no trend.
  const gTerm = Math.min(TERMINAL_G_CAP_PCT, inputs.riskFreePct);
  // N6: criterion (b) asks for "house convention" wherever the terminal rule
  // prints; the terminal ROIC basis already says it, this one said "house rule".
  const gTermBasis = `min(${TERMINAL_G_CAP_PCT}%, risk-free ${fmtNum(inputs.riskFreePct)}%) — HOUSE CONVENTION: nothing grows faster than rf forever`;

  // --- Near-term growth: MEDIAN OF METHODS (WS6, D-18) ---------------------
  // Retired here: "lower of the 3Y/5Y CAGR" and the sign-disagreement rule
  // that set g1 = gTerm. Both let one window decide ten years of growth: the
  // min rule extrapolated whichever window happened to be worse, and the
  // sign rule threw the history away entirely. The replacement runs every
  // method the data supports — a log-linear regression over ALL annual years
  // (reported with its R2 and n, so an erratic history shows up as a poor fit
  // instead of moving the anchor), the 3-year and 5-year CAGRs, and the
  // analyst-consensus case when estimates exist — and takes the MEDIAN, with
  // the full range shown. Each method's value, and every method that was
  // unavailable, is named in the basis.
  const analyst = analystTwoYearGrowthPct(inputs.analystEstimates, startRev, ttm?.date ?? null);
  notes.push(...analyst.notes);

  const methods: GrowthAnchorMethod[] = [];
  const trend = inputs.revenueLogLinear ?? null;
  if (trend && isNum(trend.growthPct)) {
    methods.push({
      name: "log-linear revenue regression",
      valuePct: trend.growthPct,
      detail:
        `${fmtNum(trend.growthPct)}%/yr fitted over ${trend.n} annual years` +
        `${trend.startDate && trend.endDate ? ` (${trend.startDate} to ${trend.endDate})` : ""}` +
        `${isNum(trend.rSquared) ? `, R2 ${fmtNum(trend.rSquared)}` : ", R2 unavailable"}`,
    });
  } else {
    methods.push({
      name: "log-linear revenue regression",
      valuePct: null,
      detail: `unavailable: ${trend === null ? "no annual revenue trend supplied" : "fewer than 3 positive annual revenue observations"}`,
    });
  }
  if (isNum(inputs.revenueCagr3yPct)) {
    methods.push({ name: "3y revenue CAGR", valuePct: inputs.revenueCagr3yPct, detail: `${fmtNum(inputs.revenueCagr3yPct)}%` });
  } else {
    methods.push({ name: "3y revenue CAGR", valuePct: null, detail: "unavailable: no 3-year revenue CAGR" });
  }
  if (isNum(inputs.revenueCagr5yPct)) {
    methods.push({ name: "5y revenue CAGR", valuePct: inputs.revenueCagr5yPct, detail: `${fmtNum(inputs.revenueCagr5yPct)}%` });
  } else {
    methods.push({ name: "5y revenue CAGR", valuePct: null, detail: "unavailable: no 5-year revenue CAGR" });
  }
  if (analyst.value !== null) {
    methods.push({
      name: "analyst-consensus case",
      valuePct: analyst.value,
      detail: `${fmtNum(analyst.value)}% (average implied growth over the next 2 fiscal years, through ${analyst.asOf ?? "?"})`,
    });
  } else {
    methods.push({
      name: "analyst-consensus case",
      valuePct: null,
      detail: "unavailable: no usable analyst revenue estimates",
    });
  }

  const available = methods.filter((m): m is GrowthAnchorMethod & { valuePct: number } => isNum(m.valuePct));
  const unavailable = methods.filter((m) => !isNum(m.valuePct)).map((m) => m.name);
  if (available.length === 0) {
    gaps.push(
      gapEntry(
        "valuation.dcf.nearTermGrowth",
        `no growth-anchor method available (${unavailable.join("; ")}) — DCF growth path not buildable`,
        "critical",
      ),
    );
    return { assumptions: null, notes, gaps };
  }
  const values = available.map((m) => m.valuePct);
  const point = medianOf(values) as number;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const rangePct: [number, number] | null = available.length > 1 ? [lo, hi] : null;
  // WS6 review (SHOULD-FIX 1): clamp FIRST, then describe. The basis used to be
  // built from the pre-clamp median and then attached to the clamped value, so
  // a 65% median printed a basis sentence that said 25% and then said 65%.
  const g1 = clampWithNote(
    point,
    NEAR_TERM_GROWTH_CLAMP_PP[0],
    NEAR_TERM_GROWTH_CLAMP_PP[1],
    "near-term growth (pct)",
    notes,
  );
  const clampFired = g1 !== point;
  const clampSentence = clampFired
    ? ` CLAMPED to ${fmtNum(g1)}%: the near-term growth house rule bounds year-one growth to [${NEAR_TERM_GROWTH_CLAMP_PP[0]}%, ${NEAR_TERM_GROWTH_CLAMP_PP[1]}%], and the DCF fades from the clamped value, not the median.`
    : "";
  const anchorBasis =
    `median of ${available.length} available growth method${available.length === 1 ? "" : "s"} = ${fmtNum(point)}%` +
    `${rangePct === null ? " (single method; no range)" : `, range ${fmtNum(lo)}% to ${fmtNum(hi)}%`}` +
    ` — methods: ${methods.map((m) => `${m.name} ${m.detail}`).join("; ")}` +
    ` (house rule, WS6 D-18: median of methods; the former "lower of the 3y/5y CAGR" and sign-disagreement rules are RETIRED).` +
    clampSentence;
  notes.push(`Near-term growth anchor: ${anchorBasis}`);
  if (unavailable.length > 0) {
    gaps.push(
      gapEntry(
        "valuation.dcf.growthAnchor",
        `growth-anchor method(s) unavailable: ${unavailable.join(", ")} — the point estimate is the median of the ${available.length} that were computable`,
        "info",
      ),
    );
  }
  if (analyst.value === null) {
    gaps.push(
      gapEntry("valuation.dcf.analystGrowth", "no usable analyst revenue estimates — the consensus-anchored method was excluded from the median", "info"),
    );
  }

  const g1Basis =
    `median of the available growth methods (${available.map((m) => `${m.name} ${fmtNum(m.valuePct)}%`).join(", ")})` +
    (clampFired
      ? ` = ${fmtNum(point)}%, clamped to ${fmtNum(g1)}% by the near-term growth house rule range [${NEAR_TERM_GROWTH_CLAMP_PP[0]}%, ${NEAR_TERM_GROWTH_CLAMP_PP[1]}%]`
      : "");
  const growthAnchor: GrowthAnchor = {
    pointPct: g1,
    ...(clampFired ? { preClampMedianPct: point } : {}),
    rangePct,
    methods,
    unavailable,
    basis: anchorBasis,
  };

  const growthPath = fadePath(g1, gTerm, years);

  // --- EBIT margin path -----------------------------------------------------
  const ttmMarginRaw = safeDiv(ttm?.operatingIncome ?? null, startRev);
  const histMarginPoints = inputs.incomeHistory
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5)
    .flatMap((r) => {
      const margin = safeDiv(r.operatingIncome, posOrNull(zeroAsNull(r.revenue)));
      return margin === null ? [] : [{ date: r.date, marginPct: margin * 100 }];
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  const histMargins = histMarginPoints.map((point) => point.marginPct);
  const median5y = medianOf(histMargins);
  const oldestMarginDate = histMarginPoints[0]?.date;
  const marginSlope = linearRegressionSlope(
    histMarginPoints.map((point) => ({
      x: oldestMarginDate === undefined ? null : yearsBetweenDates(oldestMarginDate, point.date),
      y: point.marginPct,
    })),
  );

  let m0 = ttmMarginRaw !== null ? ttmMarginRaw * 100 : null;
  if (m0 === null && median5y !== null) {
    m0 = median5y;
    notes.push("TTM EBIT margin unavailable — base margin set to 5y median (fallback)");
    gaps.push(gapEntry("valuation.dcf.ttmEbitMargin", "TTM operatingIncome or revenue missing", "warn"));
  }
  if (m0 === null) {
    gaps.push(
      gapEntry("valuation.dcf.ebitMargin", "no EBIT margin derivable from TTM or history — DCF not buildable", "critical"),
    );
    return { assumptions: null, notes, gaps };
  }

  let marginPath: number[];
  let marginBasis: string;
  if (median5y === null) {
    marginPath = Array.from({ length: years }, () => m0 as number);
    marginBasis = `held flat at current ${fmtNum(m0)}% (no 5y margin history for a fade target)`;
    gaps.push(gapEntry("valuation.dcf.marginTarget", "no annual margin history — margin held flat", "info"));
  } else {
    const regime = marginSlope === null
      ? "stable/insufficient-history"
      : marginSlope > MARGIN_TREND_THRESHOLD_PP_PER_YEAR
        ? "improving"
        : marginSlope < -MARGIN_TREND_THRESHOLD_PP_PER_YEAR
          ? "declining"
          : "stable";
    const targetMargin = regime === "improving"
      ? Math.max(m0, median5y)
      : regime === "declining"
        ? Math.min(m0, median5y)
        : median5y;
    const slopeBasis = marginSlope === null ? "unavailable" : `${fmtNum(marginSlope)}pp/year`;
    const fade = fadePath(m0, targetMargin, Math.min(MARGIN_FADE_YEARS, years));
    marginPath = Array.from({ length: years }, (_, i) =>
      i < fade.length ? fade[i] : targetMargin,
    );
    marginBasis = targetMargin === m0
      ? `held flat at current ${fmtNum(m0)}% under ${regime} dated-margin regime (5y median ${fmtNum(median5y)}%, slope ${slopeBasis})`
      : `fade current ${fmtNum(m0)}% -> ${fmtNum(targetMargin)}% by year ${Math.min(MARGIN_FADE_YEARS, years)} under ${regime} dated-margin regime (5y median ${fmtNum(median5y)}%, slope ${slopeBasis}), flat thereafter`;
    notes.push(
      `EBIT margin regime ${regime}: dated 5y slope ${slopeBasis}; target ${fmtNum(targetMargin)}% versus current ${fmtNum(m0)}% and median ${fmtNum(median5y)}%`,
    );
  }
  marginPath = marginPath.map((m) =>
    clampWithNote(m, MARGIN_CLAMP_PP[0], MARGIN_CLAMP_PP[1], "EBIT margin (pct)", notes),
  );
  if (marginPath.some((m) => m < MARGIN_WARN_BAND_PP[0] || m > MARGIN_WARN_BAND_PP[1])) {
    notes.push(
      `EBIT margin path leaves [${MARGIN_WARN_BAND_PP[0]}%, ${MARGIN_WARN_BAND_PP[1]}%] — unusual outside software; review (house-rule warning)`,
    );
  }

  // --- Tax rate path: company history, never a universal domicile assumption -
  const pretax = zeroAsNull(ttm?.incomeBeforeTax);
  const taxExp = ttm?.incomeTaxExpense ?? null;
  const currentTaxRate =
    pretax !== null && pretax > 0 && isNum(taxExp) && taxExp >= 0
      ? clampWithNote((taxExp / pretax) * 100, 0, 35, "effective tax rate (pct)", notes)
      : null;
  const historicalTaxRates = inputs.incomeHistory.flatMap((row): number[] => {
    const rowPretax = zeroAsNull(row.incomeBeforeTax);
    const rowTax = row.incomeTaxExpense ?? null;
    if (rowPretax === null || rowPretax <= 0 || !isNum(rowTax) || rowTax < 0) return [];
    return [Math.min(35, Math.max(0, (rowTax / rowPretax) * 100))];
  });
  const terminalTaxRate = medianOf(historicalTaxRates) ?? currentTaxRate;
  if (currentTaxRate === null && terminalTaxRate === null) {
    gaps.push(
      gapEntry(
        "valuation.dcf.effectiveTaxRate",
        "no positive-pre-tax current or historical company tax rate — DCF suppressed instead of assuming a universal marginal rate",
        "critical",
      ),
    );
    return { assumptions: null, notes, gaps };
  }
  const tEff = currentTaxRate ?? (terminalTaxRate as number);
  const taxTerminal = terminalTaxRate as number;
  const taxBasis = historicalTaxRates.length > 0
    ? `${periodBasis} effective rate ${fmtNum(tEff)}% fading to company historical median ${fmtNum(taxTerminal)}% by year ${years}`
    : `${periodBasis} effective rate ${fmtNum(tEff)}% held flat; no historical/domicile marginal tax dataset available`;
  const taxRatePath = fadePath(tEff, taxTerminal, years);

  // --- Sales-to-capital ------------------------------------------------------
  const bal = inputs.balance;
  const ic =
    bal && isNum(bal.totalDebt) && isNum(bal.totalStockholdersEquity) && isNum(bal.cashAndShortTermInvestments)
      ? bal.totalDebt + bal.totalStockholdersEquity - bal.cashAndShortTermInvestments
      : null;
  if (bal === null || ic === null || ic <= 0) {
    gaps.push(
      gapEntry(
        "valuation.dcf.salesToCapital",
        `${ic === null ? "balance-sheet fields missing for invested capital" : "invested capital <= 0"} — DCF suppressed instead of using a universal capital-efficiency default`,
        "critical",
      ),
    );
    return { assumptions: null, notes, gaps };
  }
  const s2c = clampWithNote(startRev / ic, S2C_CLAMP[0], S2C_CLAMP[1], "sales-to-capital", notes);
  const s2cBasis = `${periodBasis} revenue / invested capital (totalDebt + totalStockholdersEquity - cashAndShortTermInvestments, ${bal.basis} balance as of ${bal.date})`;

  // --- Terminal economics ----------------------------------------------------
  const terminal = terminalRoic(inputs.waccPct, inputs.roicHistory ?? null);
  if (terminal.note !== null) notes.push(terminal.note);
  // WS6 (D-19): say which cost of capital each ROIC year was measured against,
  // in the notes AND in the manifest when it was not the year's own WACC.
  if (terminal.waccBasisNote !== null) notes.push(terminal.waccBasisNote);
  if (terminal.waccBasis === "current") {
    gaps.push(
      gapEntry(
        "valuation.dcf.terminalRoic.waccBasis",
        "no per-fiscal-year risk-free observation was available, so the ROIC-vs-WACC evidence behind the terminal excess-return house convention compares every fiscal year to the CURRENT WACC",
        "info",
      ),
    );
  }
  const roicTerm = terminal.roicTermPct;
  const reinvestRate = roicTerm > 0 ? gTerm / roicTerm : 0;

  // WS6 (D-19): SBC treatment, stated in the assumption block with the size of
  // the adjustment to the reported free-cash-flow metric.
  const sbcInfo = inputs.fcfSbc ?? null;
  const sbcBasis =
    sbcInfo === null || sbcInfo.beforeSbc === null
      ? "Stock-based compensation is expensed inside the EBIT this DCF projects, so it is never added back here; the reported free-cash-flow metric subtracts it as well (house default). The FCFF path derives from revenue, EBIT margin and reinvestment, not from the free-cash-flow metric, so the two are consistent but not the same series."
      : sbcInfo.sbc === null
        ? `Stock-based compensation is expensed inside the EBIT this DCF projects, so it is never added back here; the reported free-cash-flow metric subtracts it as well (house default). The FCFF path derives from revenue, EBIT margin and reinvestment, not from the free-cash-flow metric, so the two are consistent but not the same series. Reported free cash flow as of ${sbcInfo.asOf ?? "?"}: ${fmtNum(sbcInfo.beforeSbc)}, UNADJUSTED — stock-based compensation was not disclosed.`
        : `Stock-based compensation is expensed inside the EBIT this DCF projects, so it is never added back here; the reported free-cash-flow metric subtracts it as well (house default). The FCFF path derives from revenue, EBIT margin and reinvestment, not from the free-cash-flow metric, so the two are consistent but not the same series. Reported free cash flow as of ${sbcInfo.asOf ?? "?"}: ${fmtNum(sbcInfo.beforeSbc)} before SBC → ${fmtNum(sbcInfo.afterSbc as number)} after subtracting SBC of ${fmtNum(sbcInfo.sbc)}.`;
  notes.push(sbcBasis);

  const assumptions: DcfAssumptions = {
    startRevenue: { value: startRev, basis: `${periodBasis} revenue as of ${ttm?.date ?? "?"}` },
    years,
    wacc: {
      value: inputs.waccPct,
      basis: inputs.waccBasis ?? `WACC ${fmtNum(inputs.waccPct)}% (inputs not supplied to the assumption block)`,
    },
    sbc: {
      value: inputs.fcfSbc ?? {
        beforeSbc: null,
        afterSbc: null,
        sbc: null,
        asOf: null,
        basis: "free-cash-flow SBC treatment not supplied to the assumption block",
      },
      basis: sbcBasis,
    },
    growthAnchor,
    growthPath: {
      value: growthPath,
      basis:
        `linear fade over the explicit ${years}-year horizon from ${fmtNum(g1)}% (${g1Basis}) to the terminal rate ${fmtNum(gTerm)}% in year ${years}; ` +
        anchorBasis,
    },
    ebitMarginPath: { value: marginPath, basis: marginBasis },
    taxRatePath: { value: taxRatePath, basis: taxBasis },
    salesToCapital: { value: s2c, basis: s2cBasis },
    terminal: {
      gTermPct: { value: gTerm, basis: gTermBasis },
      roicTermPct: {
        value: roicTerm,
        basis: terminal.waccBasisNote === null ? terminal.basis : `${terminal.basis}; ${terminal.waccBasisNote}`,
      },
      reinvestmentRate: {
        value: reinvestRate,
        basis: "terminal reinvestment = gTerm / ROICterm (Damodaran consistency rule)",
      },
    },
    midYear: { value: true, basis: "mid-year discounting convention ON by default (cash flows arrive through the year)" },
    asOf: { statements: ttm?.date ?? null, estimates: analyst.asOf },
    notes,
  };
  return { assumptions, notes, gaps };
}

// ---------------------------------------------------------------------------
// DCF engine
// ---------------------------------------------------------------------------

export interface DcfRunOptions {
  waccPct: number;
  /** Net debt in reporting-currency units (totalDebt - cash...); null = gap. */
  netDebt: number | null;
  dilutedShares: number | null;
  /**
   * Minority (non-controlling) interest — a claim senior to common equity, netted
   * out of EV in the bridge. Undisclosed ⇒ omit/null ⇒ treated as 0 (FMP convention,
   * mirroring the multiples-path EV definition). Never part of net debt.
   */
  minorityInterest?: number | null;
  /** Preferred equity — same treatment as minority interest above. */
  preferred?: number | null;
}

export interface DcfYearRow {
  year: number;
  revenue: number;
  growthPct: number;
  ebitMarginPct: number;
  ebit: number;
  taxRatePct: number;
  nopat: number;
  reinvestment: number;
  fcff: number;
  discountFactor: number;
  pv: number;
}

export interface DcfResult {
  enterpriseValue: number;
  equityValue: number | null;
  perShare: number | null;
  pvExplicit: number;
  pvTerminal: number;
  /** pvTerminal / enterpriseValue (share of value in the terminal). */
  terminalShare: number | null;
  terminalValue: number;
  /** Terminal growth actually used after the TV guard (pct). */
  gTermUsedPct: number;
  yearRows: DcfYearRow[];
  notes: string[];
  gaps: ManifestEntry[];
}

interface DcfCoreOverrides {
  growthPathPct?: number[];
  ebitMarginPathPct?: number[];
  gTermPct?: number;
  /** "clamp": pull gTerm down to wacc - guardPp and note; "null": return null. */
  guardMode: "clamp" | "null";
  /** WACC − gTerm minimum (pp) before the TV guard fires. Default TV_GUARD_PP (2.0pp). */
  guardPp?: number;
}

interface DcfCoreOutput {
  pvExplicit: number;
  pvTerminal: number;
  terminalValue: number;
  enterpriseValue: number;
  gTermUsedPct: number;
  yearRows: DcfYearRow[];
  notes: string[];
}

/** Shared DCF evaluation. Cash-flow path derives only from assumptions (+overrides). */
function dcfCore(
  a: DcfAssumptions,
  waccPct: number,
  o: DcfCoreOverrides,
): DcfCoreOutput | null {
  const notes: string[] = [];
  const n = a.years;
  const growth = o.growthPathPct ?? a.growthPath.value;
  const margins = o.ebitMarginPathPct ?? a.ebitMarginPath.value;
  const taxes = a.taxRatePath.value;
  const midYear = a.midYear.value;
  const w = waccPct / 100;
  if (w <= -1) return null; // degenerate discount rate

  const guardPp = o.guardPp ?? TV_GUARD_PP;
  let gTerm = o.gTermPct ?? a.terminal.gTermPct.value;
  if (waccPct - gTerm < guardPp) {
    if (o.guardMode === "null") return null;
    const clamped = waccPct - guardPp;
    notes.push(
      `Gordon TV guard: WACC ${fmtNum(waccPct)}% - gTerm ${fmtNum(gTerm)}% < ${guardPp}pp — gTerm reduced to ${fmtNum(clamped)}% (house rule)`,
    );
    gTerm = clamped;
  }

  const s2c = a.salesToCapital.value;
  const yearRows: DcfYearRow[] = [];
  let rev = a.startRevenue.value;
  let pvExplicit = 0;
  // Net-operating-loss balance carried across the explicit horizon.
  let nolBalance = 0;
  let nolUsed = false;
  for (let t = 1; t <= n; t++) {
    const g = growth[t - 1];
    const m = margins[t - 1];
    const tax = taxes[t - 1];
    const prev = rev;
    rev = prev * (1 + g / 100);
    const ebit = rev * (m / 100);
    // A loss year earns no cash tax REFUND. `ebit * (1 - t)` applied to a
    // negative EBIT credits the firm |EBIT| x t of cash it never receives,
    // shrinking the modelled loss and inflating the DCF — on exactly the
    // unprofitable issuers whose valuation is least certain. Note the
    // deliberate asymmetry one line below: reinvestment is already floored at 0.
    // Losses are instead carried forward and shelter later taxable income,
    // which is standard DCF practice; no jurisdictional cap is modelled.
    let nopat: number;
    // Report the rate actually applied, so ebit/taxRatePct/nopat stay
    // internally consistent for a reader auditing the year rows.
    let effectiveTaxPct: number;
    if (ebit <= 0) {
      nopat = ebit;
      nolBalance += -ebit;
      effectiveTaxPct = 0;
    } else if (nolBalance <= 0) {
      // Unchanged arithmetic, deliberately: the overwhelming majority of
      // issuers project no loss year, and rearranging this expression would
      // shift their results in the last floating-point digit for no reason.
      nopat = ebit * (1 - tax / 100);
      effectiveTaxPct = tax;
    } else {
      const sheltered = Math.min(ebit, nolBalance);
      nolBalance -= sheltered;
      nolUsed = true;
      nopat = ebit - (ebit - sheltered) * (tax / 100);
      effectiveTaxPct = ((ebit - nopat) / ebit) * 100;
    }
    const reinvestment = Math.max(0, (rev - prev) / s2c);
    const fcff = nopat - reinvestment;
    const discountFactor = Math.pow(1 + w, midYear ? t - 0.5 : t);
    const pv = fcff / discountFactor;
    pvExplicit += pv;
    yearRows.push({
      year: t,
      revenue: rev,
      growthPct: g,
      ebitMarginPct: m,
      ebit,
      taxRatePct: effectiveTaxPct,
      nopat,
      reinvestment,
      fcff,
      discountFactor,
      pv,
    });
  }

  if (nolUsed) {
    notes.push(
      "Projected operating losses earn no cash tax refund; they are carried forward and shelter later " +
        "taxable income within the explicit horizon (no jurisdictional carryforward cap modelled). " +
        "Year rows report the effective rate actually applied.",
    );
  }
  if (nolBalance > 0) {
    notes.push(
      "Unused net operating losses remain at the end of the explicit horizon; no residual tax asset is " +
        "credited to the terminal value (conservative).",
    );
  }

  // Terminal: FCFF_{N+1} = NOPAT_{N+1} * (1 - g/ROICterm); TV = FCFF_{N+1}/(WACC - g)
  const roicTerm = a.terminal.roicTermPct.value;
  let reinvestRate: number;
  if (roicTerm > 0) {
    reinvestRate = gTerm / roicTerm;
    if (reinvestRate > 1) {
      notes.push(
        `terminal reinvestment rate g/ROIC = ${fmtNum(reinvestRate)} > 1 — clamped to 1 (house rule; terminal FCFF floored at 0)`,
      );
      reinvestRate = 1;
    }
  } else {
    reinvestRate = 0;
    notes.push("terminal ROIC <= 0 — terminal reinvestment set to 0 (house rule)");
  }
  const marginTerm = margins[n - 1];
  const taxTerm = taxes[n - 1];
  // Same rule as the explicit years: a negative terminal EBIT is not handed a
  // tax refund.
  const ebitN1 = rev * (1 + gTerm / 100) * (marginTerm / 100);
  const nopatN1 = ebitN1 > 0 ? ebitN1 * (1 - taxTerm / 100) : ebitN1;
  const fcffN1 = nopatN1 * (1 - reinvestRate);
  const terminalValue = fcffN1 / ((waccPct - gTerm) / 100);
  const pvTerminal = terminalValue / Math.pow(1 + w, midYear ? n - 0.5 : n);

  return {
    pvExplicit,
    pvTerminal,
    terminalValue,
    enterpriseValue: pvExplicit + pvTerminal,
    gTermUsedPct: gTerm,
    yearRows,
    notes,
  };
}

/**
 * EV → equity → per-share bridge. Equity = EV − net debt − minority interest −
 * preferred equity, mirroring the multiples-path EV definition (which ADDS
 * preferred + minority to market cap). Undisclosed minority/preferred are 0 (FMP
 * convention). Net debt is required — without it EV cannot be bridged.
 */
function bridgeToPerShare(
  enterpriseValue: number,
  netDebt: number | null,
  dilutedShares: number | null,
  gaps: ManifestEntry[],
  minorityInterest: number | null = null,
  preferred: number | null = null,
): { equityValue: number | null; perShare: number | null } {
  if (!isNum(netDebt)) {
    gaps.push(
      gapEntry("valuation.dcf.netDebt", "net debt unavailable — enterprise value cannot be bridged to equity", "warn"),
    );
    return { equityValue: null, perShare: null };
  }
  const equityValue =
    enterpriseValue - netDebt - (isNum(minorityInterest) ? minorityInterest : 0) - (isNum(preferred) ? preferred : 0);
  const shares = posOrNull(dilutedShares);
  if (shares === null) {
    gaps.push(
      gapEntry("valuation.dcf.dilutedShares", "diluted share count missing or non-positive — per-share value unavailable", "warn"),
    );
    return { equityValue, perShare: null };
  }
  return { equityValue, perShare: equityValue / shares };
}

/**
 * Run the FCFF DCF: mid-year convention per assumptions, Gordon terminal with
 * the WACC - g >= 2pp guard (clamps g down and notes it).
 */
export function runDcf(assumptions: DcfAssumptions, opts: DcfRunOptions): DcfResult {
  const gaps: ManifestEntry[] = [];
  const core = dcfCore(assumptions, opts.waccPct, { guardMode: "clamp" });
  if (core === null) {
    // Only reachable for degenerate WACC (<= -100%); keep a total-function shape.
    return {
      enterpriseValue: 0,
      equityValue: null,
      perShare: null,
      pvExplicit: 0,
      pvTerminal: 0,
      terminalShare: null,
      terminalValue: 0,
      gTermUsedPct: assumptions.terminal.gTermPct.value,
      yearRows: [],
      notes: ["DCF not evaluable at the supplied WACC (degenerate discount rate)"],
      gaps: [gapEntry("valuation.dcf", "degenerate WACC input", "critical")],
    };
  }
  const { equityValue, perShare } = bridgeToPerShare(
    core.enterpriseValue,
    opts.netDebt,
    opts.dilutedShares,
    gaps,
    opts.minorityInterest ?? null,
    opts.preferred ?? null,
  );
  const notes = [...core.notes];
  if ((isNum(opts.minorityInterest) && opts.minorityInterest !== 0) || (isNum(opts.preferred) && opts.preferred !== 0)) {
    notes.push("equity bridge nets minority interest and preferred equity out of EV (in addition to net debt)");
  }
  return {
    enterpriseValue: core.enterpriseValue,
    equityValue,
    perShare,
    pvExplicit: core.pvExplicit,
    pvTerminal: core.pvTerminal,
    terminalShare: safeDiv(core.pvTerminal, core.enterpriseValue),
    terminalValue: core.terminalValue,
    gTermUsedPct: core.gTermUsedPct,
    yearRows: core.yearRows,
    notes,
    gaps,
  };
}

// ---------------------------------------------------------------------------
// Sensitivity grid
// ---------------------------------------------------------------------------

export interface SensitivityGrid {
  /** Row axis: WACC values (pct), base +/- 1 in 0.5 steps. */
  waccPcts: number[];
  /** Column axis: terminal growth values (pct), base +/- 1 in 0.5 steps. */
  gTermPcts: number[];
  /** perShare[i][j] for waccPcts[i] x gTermPcts[j]; null where TV guard violated. */
  perShare: (number | null)[][];
  notes: string[];
  gaps: ManifestEntry[];
}

/**
 * 5x5 per-share sensitivity: WACC +/-1pp x gTerm +/-1pp in 0.5 steps. The
 * cash-flow path is held fixed; only discounting + terminal are recomputed.
 * Cells violating the grid TV guard (WACC - g < 1.5pp, spec §3) are null, never
 * a huge number — a looser bound than the 2.0pp base-case guard on purpose.
 */
export function sensitivityGrid(assumptions: DcfAssumptions, base: DcfRunOptions): SensitivityGrid {
  const notes: string[] = [
    `grid cells with WACC - gTerm < ${GRID_TV_GUARD_PP}pp rendered null (Gordon TV guard, spec §3)`,
  ];
  const gaps: ManifestEntry[] = [];
  const waccPcts = SENSITIVITY_STEPS_PP.map((s) => base.waccPct + s);
  const gTermPcts = SENSITIVITY_STEPS_PP.map((s) => assumptions.terminal.gTermPct.value + s);
  if (!isNum(base.netDebt) || posOrNull(base.dilutedShares) === null) {
    gaps.push(
      gapEntry(
        "valuation.sensitivityGrid",
        "net debt or diluted shares missing — per-share sensitivity not computable",
        "warn",
      ),
    );
    return {
      waccPcts,
      gTermPcts,
      perShare: waccPcts.map(() => gTermPcts.map(() => null)),
      notes,
      gaps,
    };
  }
  const perShare = waccPcts.map((w) =>
    gTermPcts.map((g) => {
      const core = dcfCore(assumptions, w, { gTermPct: g, guardMode: "null", guardPp: GRID_TV_GUARD_PP });
      if (core === null) return null;
      const bridged = bridgeToPerShare(
        core.enterpriseValue,
        base.netDebt,
        base.dilutedShares,
        [],
        base.minorityInterest ?? null,
        base.preferred ?? null,
      );
      return bridged.perShare;
    }),
  );
  return { waccPcts, gTermPcts, perShare, notes, gaps };
}

// ---------------------------------------------------------------------------
// Reverse DCF (market-implied growth / terminal margin)
// ---------------------------------------------------------------------------

export interface ReverseDcfResult {
  method: "growth" | "margin" | "none";
  /** Constant explicit-horizon revenue growth (pct) that justifies the price. */
  impliedRevenueGrowthPct: number | null;
  /** Market-implied terminal EBIT margin (pct) — margin-fallback mode. */
  impliedTerminalMarginPct: number | null;
  notes: string[];
  gaps: ManifestEntry[];
}

interface Bracket {
  lo: number;
  hi: number;
  fLo: number;
  fHi: number;
}

/** Uniform pre-scan grid (17 points) over [lo, hi]. */
function prescanGrid(lo: number, hi: number): number[] {
  return Array.from(
    { length: REVERSE_PRESCAN_POINTS },
    (_, i) => lo + ((hi - lo) * i) / (REVERSE_PRESCAN_POINTS - 1),
  );
}

/** All sign-change brackets of f over the grid (skips non-evaluable points). */
function findBrackets(xs: number[], fs: (number | null)[]): Bracket[] {
  const brackets: Bracket[] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const a = fs[i];
    const b = fs[i + 1];
    if (a === null || b === null) continue;
    if (a === 0) brackets.push({ lo: xs[i], hi: xs[i], fLo: a, fHi: a });
    if (a * b < 0) brackets.push({ lo: xs[i], hi: xs[i + 1], fLo: a, fHi: b });
  }
  return brackets;
}

/** Bracket whose midpoint is closest to `anchor` (economically meaningful branch). */
function nearestBracket(brackets: Bracket[], anchor: number): Bracket | null {
  if (brackets.length === 0) return null;
  let best = brackets[0];
  let bestDist = Math.abs((best.lo + best.hi) / 2 - anchor);
  for (const b of brackets.slice(1)) {
    const d = Math.abs((b.lo + b.hi) / 2 - anchor);
    if (d < bestDist) {
      best = b;
      bestDist = d;
    }
  }
  return best;
}

/** Derivative-free bisection to BISECTION_TOL_PP (or |f| < 0.05% of price). */
function bisect(
  f: (x: number) => number | null,
  bracket: Bracket,
  price: number,
): number | null {
  let { lo, hi, fLo } = bracket;
  if (lo === hi) return lo; // exact grid root
  const fTol = 0.0005 * Math.abs(price);
  for (let iter = 0; iter < BISECTION_MAX_ITER && hi - lo > BISECTION_TOL_PP; iter++) {
    const mid = (lo + hi) / 2;
    const fMid = f(mid);
    if (fMid === null) return null; // guard tripped mid-bracket — cannot refine
    if (Math.abs(fMid) < fTol) return mid;
    if (fLo * fMid <= 0) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return (lo + hi) / 2;
}

/**
 * Reverse DCF: what constant explicit-horizon revenue growth justifies the
 * current price, everything else frozen at base case? Pre-scans f(g) on a
 * 17-point grid over [-20, +60] (value is non-monotone in growth when
 * ROIC < WACC — picks the sign-change bracket whose midpoint is nearest the
 * base-case year-1 growth), then bisects to 1bp. If no bracket exists or the
 * base-year FCFF is negative, falls back to solving the market-implied
 * terminal EBIT margin over [0, 60] with the same machinery.
 */
export function reverseDcf(
  currentPrice: number | null,
  assumptions: DcfAssumptions,
  opts: DcfRunOptions,
): ReverseDcfResult {
  const notes: string[] = [];
  const gaps: ManifestEntry[] = [];
  const none = (why: string): ReverseDcfResult => {
    notes.push(why);
    return { method: "none", impliedRevenueGrowthPct: null, impliedTerminalMarginPct: null, notes, gaps };
  };

  const price = posOrNull(currentPrice);
  if (price === null) {
    gaps.push(gapEntry("valuation.reverseDcf", "current price missing — nothing to invert", "warn"));
    return none("reverse DCF skipped: no current price");
  }
  if (!isNum(opts.netDebt) || posOrNull(opts.dilutedShares) === null) {
    gaps.push(
      gapEntry("valuation.reverseDcf", "net debt or diluted shares missing — per-share value not computable", "warn"),
    );
    return none("reverse DCF skipped: equity bridge inputs missing");
  }

  const n = assumptions.years;
  const perShareAt = (overrides: Omit<DcfCoreOverrides, "guardMode">): number | null => {
    const core = dcfCore(assumptions, opts.waccPct, { ...overrides, guardMode: "clamp" });
    if (core === null) return null;
    return bridgeToPerShare(
      core.enterpriseValue,
      opts.netDebt,
      opts.dilutedShares,
      [],
      opts.minorityInterest ?? null,
      opts.preferred ?? null,
    ).perShare;
  };

  // Base-year FCFF sign check (negative-FCF companies skip the growth solve).
  const baseRows = dcfCore(assumptions, opts.waccPct, { guardMode: "clamp" });
  const baseFcff1 = baseRows?.yearRows[0]?.fcff ?? null;
  const baseG1 = assumptions.growthPath.value[0];

  const solveGrowth = (): ReverseDcfResult | null => {
    const [lo, hi] = REVERSE_GROWTH_RANGE_PCT;
    const xs = prescanGrid(lo, hi);
    const fG = (g: number): number | null => {
      const v = perShareAt({ growthPathPct: Array.from({ length: n }, () => g) });
      return v === null ? null : v - price;
    };
    const fs = xs.map(fG);
    const brackets = findBrackets(xs, fs);
    if (brackets.length === 0) {
      const fLo = fs[0];
      const fHi = fs[fs.length - 1];
      if (fLo !== null && fLo > 0) {
        notes.push(
          `market price implies < ${lo}%/yr revenue growth — deep-value/distress framing (no root on pre-scan grid)`,
        );
      } else if (fHi !== null && fHi < 0) {
        notes.push(
          `market price implies > ${hi}%/yr revenue growth — not justifiable on these margins (no root on pre-scan grid)`,
        );
      } else {
        notes.push("no sign change of f(growth) on the 17-point pre-scan grid");
      }
      return null;
    }
    if (brackets.length > 1) {
      notes.push(
        `f(growth) non-monotone: ${brackets.length} sign-change brackets on the pre-scan grid — picked the bracket nearest base-case growth ${fmtNum(baseG1)}% (house rule)`,
      );
    }
    const bracket = nearestBracket(brackets, baseG1);
    if (bracket === null) return null;
    const root = bisect(fG, bracket, price);
    if (root === null) return null;
    notes.push(
      `implied CONSTANT revenue growth over ${n} explicit years (no fade); all other assumptions frozen at base case`,
    );
    return { method: "growth", impliedRevenueGrowthPct: root, impliedTerminalMarginPct: null, notes, gaps };
  };

  const solveMargin = (): ReverseDcfResult | null => {
    const [lo, hi] = REVERSE_MARGIN_RANGE_PCT;
    const m0 = assumptions.ebitMarginPath.value[0];
    const xs = prescanGrid(lo, hi);
    const fM = (m: number): number | null => {
      const v = perShareAt({ ebitMarginPathPct: fadePath(m0, m, n) });
      return v === null ? null : v - price;
    };
    const fs = xs.map(fM);
    const brackets = findBrackets(xs, fs);
    if (brackets.length === 0) {
      const fHi = fs[fs.length - 1];
      if (fHi !== null && fHi < 0) {
        notes.push(
          `even a ${hi}% terminal EBIT margin does not justify the price — years-to-breakeven framing applies (fallback B)`,
        );
      } else {
        notes.push("no sign change of f(terminal margin) on the pre-scan grid");
      }
      return null;
    }
    const anchor = assumptions.ebitMarginPath.value[n - 1];
    if (brackets.length > 1) {
      notes.push(
        `f(margin) has ${brackets.length} brackets — picked the one nearest base terminal margin ${fmtNum(anchor)}% (house rule)`,
      );
    }
    const bracket = nearestBracket(brackets, anchor);
    if (bracket === null) return null;
    const root = bisect(fM, bracket, price);
    if (root === null) return null;
    notes.push(
      `market-implied steady-state (terminal) EBIT margin, fading from current ${fmtNum(m0)}% over ${n} years; growth path frozen at base case`,
    );
    return { method: "margin", impliedRevenueGrowthPct: null, impliedTerminalMarginPct: root, notes, gaps };
  };

  if (baseFcff1 !== null && baseFcff1 <= 0) {
    notes.push(
      "base-year FCFF <= 0 — revenue-growth inversion unreliable; solving market-implied terminal EBIT margin instead (fallback A)",
    );
    const viaMargin = solveMargin();
    if (viaMargin) return viaMargin;
    return none("reverse DCF: margin fallback found no root");
  }

  const viaGrowth = solveGrowth();
  if (viaGrowth) return viaGrowth;
  notes.push("growth inversion found no bracket — attempting terminal-margin fallback (fallback A)");
  const viaMargin = solveMargin();
  if (viaMargin) return viaMargin;
  return none("reverse DCF: no root in growth [-20, 60] nor terminal margin [0, 60]");
}

// ---------------------------------------------------------------------------
// Multiples framework
// ---------------------------------------------------------------------------

export type MultipleKey =
  | "peTtm"
  | "evToEbitda"
  | "evToSales"
  | "priceToFcf"
  | "priceToBook"
  | "priceToTbv"
  | "priceToFfo"
  | "priceToAffo";

/** Sector -> valid multiples (the application contract §6; banks NEVER get EV multiples). */
export const SECTOR_APPROPRIATE_MULTIPLES: Record<SectorRoute, MultipleKey[]> = {
  general: ["peTtm", "evToEbitda", "evToSales", "priceToFcf", "priceToBook"],
  bank: ["peTtm", "priceToTbv", "priceToBook"],
  insurer: ["priceToBook", "peTtm", "priceToTbv"],
  reit: ["priceToFfo", "priceToAffo"],
  "reit-mortgage": ["priceToBook", "peTtm", "priceToTbv"],
};

export interface MultiplesQuoteInputs {
  price: number | null;
  marketCap: number | null;
  /** Listing/trading currency (e.g. "USD"). */
  currency?: string | null;
}

/** TTM income statement slice (FMP names). */
export interface MultiplesIncomeTtm {
  date: string;
  /**
   * Period basis of this slice: "ttm" (4 complete quarters) or "annual"
   * (latest FY substituted when TTM was suppressed — incomplete quarterly
   * data). Drives honest basis labels on the multiples; defaults to "ttm"
   * when absent (legacy callers).
   */
  basis?: "ttm" | "annual";
  revenue: number | null;
  operatingIncome: number | null;
  depreciationAndAmortization?: number | null;
  netIncome: number | null;
  epsDiluted: number | null;
}

/** TTM cash-flow slice (FMP names; capitalExpenditure is NEGATIVE). */
export interface MultiplesCashFlowTtm {
  date: string;
  /** Period basis — see MultiplesIncomeTtm.basis. */
  basis?: "ttm" | "annual";
  operatingCashFlow: number | null;
  capitalExpenditure: number | null;
  depreciationAndAmortization?: number | null;
}

/** Latest balance sheet slice (FMP names). */
export interface MultiplesBalance {
  date: string;
  /**
   * Which statement period the row came from: "quarter" (latest quarterly
   * balance sheet — the preferred point-in-time anchor, 2026-07-09 audit M4) or
   * "annual" (whole-row fallback). Drives honest basis labels; absent on
   * legacy callers ⇒ generic "latest" label.
   */
  basis?: "quarter" | "annual";
  totalDebt: number | null;
  cashAndShortTermInvestments: number | null;
  totalStockholdersEquity: number | null;
  goodwill: number | null;
  intangibleAssets: number | null;
  minorityInterest: number | null;
  preferredStock: number | null;
  /**
   * WS6 (D-19): TOTAL lease liabilities (FMP `capitalLeaseObligations`, which
   * carries the operating AND finance lease liability; the EDGAR statements
   * builder resolves the same field). FMP's `totalDebt` is documented as
   * shortTermDebt + longTermDebt + capitalLeaseObligations, so this figure is
   * ALREADY inside `totalDebt`. Context for the bridge's disclosure only — the
   * EV adjustment reads `operatingLeaseLiability` below, never this.
   */
  capitalLeaseObligations?: number | null;
  /**
   * WS6 review (BLOCKER 1): the OPERATING slice of the lease liability, the
   * ONLY slice the EV bridge may remove. Under ASC 842 operating-lease cost
   * stays in operating expenses, so EBIT and EBITDA are already AFTER it;
   * finance-lease cost is split between right-of-use amortisation (added back
   * in EBITDA) and interest (below EBIT), so EBIT and EBITDA are BEFORE it and
   * the finance-lease liability is debt in both frames. Null when the split is
   * unavailable (the FMP route publishes one combined figure): enterprise value
   * is then reported as-is and the `enterpriseValue.leases` gap says so, rather
   * than removing an unknown mix of operating and finance leases.
   */
  operatingLeaseLiability?: number | null;
}

/** Quarterly fundamentals merged per quarter by the caller (FMP names). */
export interface QuarterlyFundamentalsRow {
  date: string;
  acceptedDate?: unknown;
  filingDate?: unknown;
  revenue: number | null;
  operatingIncome: number | null;
  depreciationAndAmortization: number | null;
  netIncome: number | null;
  operatingCashFlow: number | null;
  capitalExpenditure: number | null;
  totalStockholdersEquity: number | null;
  /**
   * INCOME-statement D&A only. `depreciationAndAmortization` above may fall
   * back to the cash-flow figure, which is a different quantity; the REIT FFO
   * history must use the same basis as the current ffoApprox.
   */
  incomeDepreciationAndAmortization?: number | null;
  /**
   * Balance components of the HOUSE enterprise value, so the own-history EV is
   * built from the same definition as the current one. FMP's
   * `enterpriseValue` omits preferred stock and minority interest and nets only
   * cash, so ranking today's house EV against a history of vendor EVs compared
   * two different quantities.
   */
  totalDebt?: number | null;
  cashAndShortTermInvestments?: number | null;
  preferredStock?: number | null;
  minorityInterest?: number | null;
  /**
   * WS6 review (BLOCKER 2): the quarter's OPERATING lease liability, so the
   * own-history EV carries the SAME lease adjustment as the current one. A
   * lease-adjusted current multiple ranked against an unadjusted history
   * compared two definitions and biased the printed rank. Null when the
   * quarter's balance sheet does not resolve the split — the window's EV
   * multiples are then dropped rather than ranked on the wrong basis.
   */
  operatingLeaseLiability?: number | null;
}

/** FMP /stable/enterprise-values row (quarterly history). */
export interface EnterpriseValuesRow {
  date: string;
  marketCapitalization: number | null;
  enterpriseValue: number | null;
}

/** Pre-baked vendor ratio history (FMP key-metrics / ratios quarterly rows). */
export interface VendorMultiplesRow {
  date: string;
  evToSales?: number | null;
  evToEBITDA?: number | null;
  priceToEarningsRatio?: number | null;
  priceToBookRatio?: number | null;
  priceToFreeCashFlowRatio?: number | null;
}

/** Peer multiples computed upstream from peers' quotes/ratios-ttm. */
export interface PeerMultiples {
  symbol: string;
  multiples: Partial<Record<MultipleKey, number | null>>;
}

export interface MultiplesFrameworkInputs {
  quote: MultiplesQuoteInputs;
  /** Statements' reportedCurrency — mismatch vs quote.currency flags the ADR case. */
  reportedCurrency?: string | null;
  incomeTtm: MultiplesIncomeTtm | null;
  cashFlowTtm: MultiplesCashFlowTtm | null;
  balance: MultiplesBalance | null;
  /** Quarterly merged fundamentals (>= 8 rows enables derived TTM history). */
  quarterlyFundamentals?: QuarterlyFundamentalsRow[];
  enterpriseValuesHistory?: EnterpriseValuesRow[];
  /** Vendor pre-baked ratio history — used only when derivation impossible AND currencies match. */
  keyMetricsHistory?: VendorMultiplesRow[];
  peers?: PeerMultiples[];
  /** REIT-only: FFO/AFFO totals provided by the caller (labeled approximate upstream). */
  ffoApprox?: number | null;
  affoApprox?: number | null;
  /**
   * WS6 (D-19): keep the OPERATING-lease liability in enterprise value
   * (THESIS_EV_INCLUDE_LEASES=1). OFF by default, because under US GAAP
   * (ASC 842) the operating-lease cost stays in operating expenses, so EBIT and
   * EBITDA are already AFTER it — adding that liability to EV as well would
   * double-count the leases in EV/EBITDA. It never touches the FINANCE-lease
   * liability (WS6 review, BLOCKER 1): EBIT and EBITDA are BEFORE finance-lease
   * cost, so that liability is debt in every frame and never leaves EV.
   */
  includeLeasesInEv?: boolean;
}

/** WS6 (D-19): the EV bridge, both ways, with the convention stated. Only the
 * OPERATING slice ever moves between the two (WS6 review, BLOCKER 1). */
export interface EnterpriseValueBridge {
  /** The EV actually used by the EV multiples. */
  value: number | null;
  /** EV with the OPERATING lease liability removed (the house default). */
  excludingLeases: number | null;
  /** EV as reported: every lease liability left inside totalDebt. */
  includingLeases: number | null;
  /**
   * The liability actually removed by `excludingLeases` — the OPERATING slice
   * only (WS6 review, BLOCKER 1). Null when the split is unavailable, in which
   * case EV is reported as-is and the leases gap states the reason.
   */
  leaseLiability: number | null;
  /** Operating + finance lease liability where disclosed; context only. */
  totalLeaseLiability?: number | null;
  /** Finance slice, which stays inside EV on BOTH bases; context only. */
  financeLeaseLiability?: number | null;
  includeLeases: boolean;
  basis: string;
}

export interface OwnHistoryBand {
  /**
   * WS6 (D-19): RANK AMONG `observations` QUARTERS (0-100), not a percentile.
   * The field name is kept for backward compatibility; every label built from
   * it says "rank among N quarters", with N = `observations`.
   */
  percentileRank: number | null;
  /**
   * 5th percentile of up to 20 quarterly observations. NOTE: because the window
   * caps at 20 (deriveOwnHistory), the quantile index 0.05·(n−1) stays inside the
   * OUTERMOST cell for all n ≤ 20 — so p5 tracks the near-minimum (2nd-smallest
   * obs), NOT a stable tail percentile. Read together with `lowSample`.
   */
  p5: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  /** 95th percentile — same caveat as p5: tracks the near-maximum at these sizes. */
  p95: number | null;
  observations: number;
  basis: string;
  /**
   * True when the window is shorter than a full 5 years (< 20 quarters), i.e. the
   * p5/p95 tails are especially thin. When true the basis carries a LOW SAMPLE note.
   */
  lowSample?: boolean;
}

export interface PeerStats {
  median: number | null;
  min: number | null;
  max: number | null;
  count: number;
}

export interface MultipleStat {
  key: MultipleKey;
  /** Current multiple; null = n/m (negative/zero denominator or missing input). */
  current: number | null;
  basis: string;
  ownHistory: OwnHistoryBand | null;
  peers: PeerStats | null;
}

export interface MultiplesResult {
  multiples: MultipleStat[];
  /** WS6 (D-19): the enterprise-value bridge, both ways. */
  enterpriseValue: EnterpriseValueBridge;
  sectorAppropriate: MultipleKey[];
  asOf: { quote: string | null; statements: string | null };
  notes: string[];
  gaps: ManifestEntry[];
}

/** Trimmed peer stats: drop n/m and 1.5x-IQR outliers; suppress below 4 survivors. */
function peerStats(values: (number | null | undefined)[], notes: string[], key: string): PeerStats | null {
  const clean = values.filter((v): v is number => isNum(v) && v > 0);
  if (clean.length === 0) return null;
  const q1 = quantile(clean, 0.25);
  const q3 = quantile(clean, 0.75);
  let trimmed = clean;
  if (q1 !== null && q3 !== null) {
    const iqr = q3 - q1;
    trimmed = clean.filter((v) => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr);
  }
  if (trimmed.length < MIN_PEERS_FOR_STATS) {
    notes.push(
      `${key}: only ${trimmed.length} usable peers after n/m + 1.5x-IQR trim — peer comparison suppressed (house rule: never show a <${MIN_PEERS_FOR_STATS}-peer median)`,
    );
    return null;
  }
  return {
    median: medianOf(trimmed),
    min: Math.min(...trimmed),
    max: Math.max(...trimmed),
    count: trimmed.length,
  };
}

type HistorySeries = Partial<Record<MultipleKey, number[]>>;

interface OwnHistoryDerivation {
  series: HistorySeries;
  observations: number;
  rejectedPeriods: Array<{ period: string; reason: string }>;
  rejectedWindows: Array<{ anchor: string; reason: string }>;
  unusableWindows: Array<{ anchor: string; reason: string }>;
  /**
   * WS6 review (BLOCKER 2): windows whose EV could not be put on the current
   * EV's lease basis (no operating-lease liability on that quarter's balance
   * sheet while the current EV removes one). Their EV multiples are dropped.
   */
  leaseBasisMismatchWindows: string[];
}

const DERIVED_HISTORY_KEYS: readonly MultipleKey[] = [
  "evToSales",
  "evToEbitda",
  "peTtm",
  "priceToFcf",
  "priceToBook",
];
const OWN_HISTORY_EV_MAX_AGE_DAYS = 45;

/** Rolling-4-quarter TTM multiples derived from raw statements + EV history. */
function deriveOwnHistory(
  quarters: QuarterlyFundamentalsRow[] | undefined,
  evRows: EnterpriseValuesRow[] | undefined,
  derivedKeys: readonly MultipleKey[] = DERIVED_HISTORY_KEYS,
  /**
   * WS6 review (BLOCKER 2): true when the CURRENT enterprise value removed the
   * operating-lease liability, so every historical window must remove its own.
   */
  removeOperatingLease = false,
): OwnHistoryDerivation {
  const series: HistorySeries = {};
  const normalized = normalizeQuarterRows(quarters ?? []);
  const candidates = contiguousQuarterWindows(normalized.rows, normalized.rows.length);
  if (candidates.windows.length === 0) {
    return {
      series,
      observations: 0,
      rejectedPeriods: normalized.rejected,
      rejectedWindows: candidates.rejected,
      unusableWindows: [],
      leaseBasisMismatchWindows: [],
    };
  }
  const unusableWindows: Array<{ anchor: string; reason: string }> = [];
  const leaseBasisMismatchWindows: string[] = [];
  const push = (key: MultipleKey, value: number): void => {
    const values = (series[key] ??= []);
    if (values.length < FULL_OWN_HISTORY_OBS) values.push(value);
  };
  for (const window of candidates.windows) {
    if (derivedKeys.every((key) => (series[key]?.length ?? 0) >= FULL_OWN_HISTORY_OBS)) break;
    const ev = latestOnOrBeforeWithin(
      evRows ?? [],
      window[0].date,
      OWN_HISTORY_EV_MAX_AGE_DAYS,
    );
    if (!ev) {
      unusableWindows.push({
        anchor: window[0].date,
        reason:
          "no enterprise-values history row on or before the TTM period end within 45 calendar days (future rows are ineligible); historical multiple window unavailable",
      });
      continue;
    }
    const sum = (f: (r: QuarterlyFundamentalsRow) => number | null): number | null => {
      let acc = 0;
      for (const r of window) {
        const v = f(r);
        if (!isNum(v)) return null;
        acc += v;
      }
      return acc;
    };
    const ttmRev = posOrNull(sum((r) => r.revenue));
    const ttmEbitda = sum((r) =>
      isNum(r.operatingIncome) && isNum(r.depreciationAndAmortization)
        ? r.operatingIncome + r.depreciationAndAmortization
        : null,
    );
    const ttmNi = sum((r) => r.netIncome);
    const ttmFcf = sum((r) => deriveFcf(r.operatingCashFlow, r.capitalExpenditure));
    const equity = window[0].totalStockholdersEquity;
    const mcap = ev.marketCapitalization;
    // Build the historical EV from the SAME components as the current one
    // rather than trusting the vendor field, which omits preferred stock and
    // minority interest and nets cash only. Ranking a house EV against a
    // history of vendor EVs put a definitional gap into every EV percentile.
    // Undisclosed preferred/minority are treated as 0, matching the current
    // path's FMP convention; debt and cash are required, and when they are
    // absent the EV-based multiples for this window are simply not produced
    // (the equity-based ones below are unaffected because they use mcap).
    const b = window[0];
    // WS6 review (BLOCKER 2): the SAME lease adjustment the current EV carries.
    // Only the operating slice leaves EV (BLOCKER 1), and a window that cannot
    // supply its own operating-lease liability while the current EV removed one
    // is dropped rather than ranked against a different definition.
    const windowOperatingLease =
      isNum(b.operatingLeaseLiability) && b.operatingLeaseLiability !== 0
        ? Math.abs(b.operatingLeaseLiability)
        : null;
    const leaseBasisMatches = !removeOperatingLease || windowOperatingLease !== null;
    if (!leaseBasisMatches) leaseBasisMismatchWindows.push(b.date);
    const evVal =
      leaseBasisMatches && isNum(mcap) && isNum(b.totalDebt) && isNum(b.cashAndShortTermInvestments)
        ? mcap +
          b.totalDebt +
          (isNum(b.preferredStock) ? b.preferredStock : 0) +
          (isNum(b.minorityInterest) ? b.minorityInterest : 0) -
          b.cashAndShortTermInvestments -
          (removeOperatingLease ? (windowOperatingLease as number) : 0)
        : null;
    // FFO/AFFO, derived exactly as the CURRENT values are (compute.ts builds
    // ffoApprox = netIncome + D&A and affoApprox = ffoApprox - |capex|). Without
    // these, `priceToFfo`/`priceToAffo` had no derived source at all, so every
    // equity REIT's only two multiples carried no own-history band, its
    // valuation aspect scored null, and its composite was permanently shrunk
    // for evidence the pipeline could have computed all along.
    // INCOME-statement D&A only, matching how compute.ts builds the CURRENT
    // ffoApprox (ttmInc.depreciationAndAmortization, no cash-flow fallback).
    // mergeQuarterly falls back to the cash-flow figure, so allowing it here
    // ranked a current P/FFO built on one D&A definition against a history
    // built on another.
    const ttmDa = sum((r) => r.incomeDepreciationAndAmortization ?? null);
    const ttmCapex = sum((r) => r.capitalExpenditure);
    const ttmFfo = isNum(ttmNi) && isNum(ttmDa) ? ttmNi + ttmDa : null;
    const ttmAffo = isNum(ttmFfo) && isNum(ttmCapex) ? ttmFfo - Math.abs(ttmCapex) : null;
    const values: Partial<Record<MultipleKey, number | null>> = {
      evToSales: safeDiv(evVal, ttmRev),
      evToEbitda: safeDiv(evVal, posOrNull(ttmEbitda)),
      peTtm: safeDiv(mcap, posOrNull(ttmNi)),
      priceToFcf: safeDiv(mcap, posOrNull(ttmFcf)),
      priceToBook: safeDiv(mcap, posOrNull(equity)),
      priceToFfo: safeDiv(mcap, posOrNull(ttmFfo)),
      priceToAffo: safeDiv(mcap, posOrNull(ttmAffo)),
    };
    const stillNeeded = derivedKeys.filter(
      (key) => (series[key]?.length ?? 0) < FULL_OWN_HISTORY_OBS,
    );
    const unavailable = derivedKeys.filter((key) => {
      const value = values[key];
      return value === null || value === undefined || value <= 0;
    });
    for (const key of stillNeeded) {
      const value = values[key];
      if (value !== null && value !== undefined && value > 0) push(key, value);
    }
    if (unavailable.length > 0) {
      unusableWindows.push({
        anchor: window[0].date,
        reason: `${unavailable.length === derivedKeys.length ? "historical multiple window unavailable" : "partial historical multiple window"}: no positive/computable ${unavailable.join(", ")}`,
      });
    }
  }
  const observations = Math.max(0, ...DERIVED_HISTORY_KEYS.map((key) => series[key]?.length ?? 0));
  return {
    series,
    observations,
    rejectedPeriods: normalized.rejected,
    rejectedWindows: candidates.rejected,
    unusableWindows,
    leaseBasisMismatchWindows,
  };
}

function ownHistoryWindowGap(derived: OwnHistoryDerivation): ManifestEntry | null {
  const total = derived.rejectedPeriods.length + derived.rejectedWindows.length + derived.unusableWindows.length;
  if (total === 0) return null;
  const details = [
    ...derived.rejectedPeriods.map(({ period, reason }) => `period ${period}: ${reason}`),
    ...derived.rejectedWindows.map(({ anchor, reason }) => `window ${anchor}: ${reason}`),
    ...derived.unusableWindows.map(({ anchor, reason }) => `window ${anchor}: ${reason}`),
  ];
  const shown = details.slice(0, 8);
  const omitted = details.length - shown.length;
  return gapEntry(
    "valuation.multiples.ownHistory.windows",
    `${derived.rejectedPeriods.length} rejected fiscal period(s), ${derived.rejectedWindows.length} rejected quarter window(s), and ${derived.unusableWindows.length} financially partial/unusable window(s): ${shown.join("; ")}${omitted > 0 ? `; +${omitted} more` : ""}`,
    "info",
  );
}

/** Vendor pre-baked history mapped to our multiple keys. */
function vendorHistory(rows: VendorMultiplesRow[] | undefined): HistorySeries {
  const series: HistorySeries = {};
  if (!rows) return series;
  const push = (k: MultipleKey, v: number | null | undefined): void => {
    const values = (series[k] ??= []);
    if (isNum(v) && v > 0 && values.length < FULL_OWN_HISTORY_OBS) values.push(v);
  };
  for (const r of rows) {
    push("evToSales", r.evToSales);
    push("evToEbitda", r.evToEBITDA);
    push("peTtm", r.priceToEarningsRatio);
    push("priceToBook", r.priceToBookRatio);
    push("priceToFcf", r.priceToFreeCashFlowRatio);
  }
  return series;
}

function bandFor(values: number[] | undefined, current: number | null, basis: string): OwnHistoryBand | null {
  if (!values || values.length < MIN_HISTORY_OBS_FOR_BAND) return null;
  // With the derivation capped at 20 quarterly obs, quantile idx 0.05·(n−1) < 1 for
  // all n ≤ 20, so p5/p95 are interpolated within the outermost cell — they track the
  // near-min/near-max (≈ observed range), not stable tail percentiles. Flag thin
  // windows so p5/p95 aren't over-read; the median/quartiles stay robust.
  const lowSample = values.length < FULL_OWN_HISTORY_OBS;
  // WS6 (D-19): the headline figure is a RANK AMONG N QUARTERS, never a
  // percentile of a distribution - 8-20 observations cannot estimate one.
  const observationBasis =
    `${basis} (${values.length} observations). The reported figure is a RANK AMONG ${values.length} QUARTERS ` +
    "(0-100 by linear interpolation between order statistics), not a percentile of a distribution: " +
    "the sample is far too small for that, and a rank within the observed sample is what it actually measures.";
  const notedBasis = lowSample
    ? `${observationBasis} LOW SAMPLE (${values.length} quarterly observations < 5y): p5/p95 track the tail observations (≈ observed range), not stable quantiles.`
    : observationBasis;
  return {
    percentileRank: current !== null ? percentileRank(values, current) : null,
    p5: quantile(values, 0.05),
    p25: quantile(values, 0.25),
    p50: quantile(values, 0.5),
    p75: quantile(values, 0.75),
    p95: quantile(values, 0.95),
    observations: values.length,
    basis: notedBasis,
    lowSample,
  };
}

/**
 * Current multiples computed from raw FMP fields (never trusting pre-baked
 * ratios for the current print), own-history 5y percentile bands, and trimmed
 * peer stats. `sectorAppropriate` tells the UI which multiples are valid for
 * the route (banks never get EV multiples; REITs lead with P/FFO).
 */
export function multiplesFramework(
  route: SectorRoute,
  inputs: MultiplesFrameworkInputs,
): MultiplesResult {
  const notes: string[] = [];
  const gaps: ManifestEntry[] = [];
  const inc = inputs.incomeTtm;
  const cf = inputs.cashFlowTtm;
  const bal = inputs.balance;
  const mcap = posOrNull(inputs.quote.marketCap);
  const price = posOrNull(inputs.quote.price);

  const currencyMismatch =
    typeof inputs.quote.currency === "string" &&
    typeof inputs.reportedCurrency === "string" &&
    inputs.quote.currency.toUpperCase() !== inputs.reportedCurrency.toUpperCase();
  if (currencyMismatch) {
    notes.push(
      `ADR/currency mismatch: statements in ${inputs.reportedCurrency}, quote in ${inputs.quote.currency} — computed multiples mix currencies (indicative only); vendor pre-baked history NOT trusted`,
    );
    gaps.push(
      gapEntry(
        "valuation.multiples.currency",
        `reportedCurrency ${inputs.reportedCurrency} != quote currency ${inputs.quote.currency} (ADR case) — FX conversion pending, multiples flagged`,
        "warn",
      ),
    );
  }
  if (mcap === null) {
    gaps.push(gapEntry("valuation.multiples.marketCap", "market cap missing — most multiples not computable", "warn"));
  }

  // --- Raw building blocks (zero-for-undisclosed handled where implausible) --
  const revenue = posOrNull(zeroAsNull(inc?.revenue));
  const dAndA = isNum(inc?.depreciationAndAmortization)
    ? inc.depreciationAndAmortization
    : isNum(cf?.depreciationAndAmortization)
      ? cf.depreciationAndAmortization
      : null;
  const ebitda =
    isNum(inc?.operatingIncome) && isNum(dAndA) ? inc.operatingIncome + dAndA : null;
  if (inc && !isNum(dAndA)) {
    gaps.push(gapEntry("valuation.multiples.ebitda", "depreciationAndAmortization missing — EBITDA (computed) unavailable", "info"));
  }
  const fcf = deriveFcf(cf?.operatingCashFlow, cf?.capitalExpenditure);
  const equity = bal?.totalStockholdersEquity ?? null;
  const tbv =
    isNum(equity) && isNum(bal?.goodwill) && isNum(bal?.intangibleAssets)
      ? equity - bal.goodwill - bal.intangibleAssets
      : null;
  // WS6 (D-19): the EV bridge, computed BOTH ways and disclosed.
  // Base = market cap + total debt + preferred + minority interest − cash and
  // short-term investments. FMP's totalDebt already contains the lease
  // liability, so the default (leases NOT in EV) subtracts it back out.
  const evIncludingLeases =
    mcap !== null && bal && isNum(bal.totalDebt) && isNum(bal.cashAndShortTermInvestments)
      ? mcap +
        bal.totalDebt +
        (isNum(bal.preferredStock) ? bal.preferredStock : 0) +
        (isNum(bal.minorityInterest) ? bal.minorityInterest : 0) -
        bal.cashAndShortTermInvestments
      : null;
  // WS6 review (BLOCKER 1): ONLY the operating-lease liability may leave EV.
  // Under ASC 842 operating-lease cost sits in operating expenses, so EBIT and
  // EBITDA are already AFTER it. Finance-lease cost is not: it is split between
  // right-of-use amortisation (added back in EBITDA) and interest (below EBIT),
  // so both earnings frames are BEFORE it and the finance-lease liability is
  // debt in both. Removing the combined figure understated net debt (Apple
  // FY2025: ~1.2bn of finance leases) and overstated equity value.
  const totalLeaseLiability =
    isNum(bal?.capitalLeaseObligations) && bal.capitalLeaseObligations !== 0
      ? Math.abs(bal.capitalLeaseObligations)
      : null;
  const leaseLiability =
    isNum(bal?.operatingLeaseLiability) && bal.operatingLeaseLiability !== 0
      ? Math.abs(bal.operatingLeaseLiability)
      : null;
  const financeLeaseLiability =
    totalLeaseLiability !== null && leaseLiability !== null
      ? Math.max(0, totalLeaseLiability - leaseLiability)
      : null;
  const includeLeases = inputs.includeLeasesInEv === true;
  const evExcludingLeases =
    evIncludingLeases === null
      ? null
      : leaseLiability === null
        ? evIncludingLeases
        : evIncludingLeases - leaseLiability;
  const ev = includeLeases ? evIncludingLeases : evExcludingLeases;
  const evBridgeBasis =
    (includeLeases
      ? "Enterprise value INCLUDES the operating-lease liability (THESIS_EV_INCLUDE_LEASES=1). "
      : "Enterprise value EXCLUDES the OPERATING-lease liability (house default; set THESIS_EV_INCLUDE_LEASES=1 to keep it). ") +
    "EV = market cap + total debt + preferred stock + minority interest − cash and short-term investments" +
    (leaseLiability === null
      ? totalLeaseLiability === null
        ? "; lease liabilities were not disclosed separately, so they could not be separated from totalDebt and EV is reported as-is"
        : `; a total lease liability of ${fmtNum(totalLeaseLiability)} is disclosed but its operating slice is not, so no lease adjustment was made and EV is reported as-is`
      : `, ${includeLeases ? "keeping" : "less"} an OPERATING lease liability of ${fmtNum(leaseLiability)}` +
        (financeLeaseLiability === null || financeLeaseLiability === 0
          ? ""
          : `; the finance-lease liability of ${fmtNum(financeLeaseLiability)} STAYS in EV on both bases`) +
        " (both already inside totalDebt under FMP's definition)") +
    ". EV/EBITDA uses this same EV. Under US GAAP (ASC 842) operating-lease cost stays in operating expenses, so EBIT and EBITDA are already AFTER it" +
    (includeLeases
      ? ", and keeping the operating-lease liability in EV pairs a lease-INCLUSIVE numerator with a lease-EXPENSED denominator — not comparable to the default basis, and the caller's explicit choice."
      : ", so removing the operating-lease liability keeps numerator and denominator on the same basis.") +
    " Finance-lease cost is NOT in EBIT: it is right-of-use amortisation (added back in EBITDA) plus interest (below EBIT), so the finance-lease liability is debt in both frames and is never removed." +
    (evIncludingLeases === null || evExcludingLeases === null
      ? ""
      : ` EV excluding the operating-lease liability ${fmtNum(evExcludingLeases)}; EV as reported ${fmtNum(evIncludingLeases)}.`);
  const enterpriseValue: EnterpriseValueBridge = {
    value: ev,
    excludingLeases: evExcludingLeases,
    includingLeases: evIncludingLeases,
    leaseLiability,
    totalLeaseLiability,
    financeLeaseLiability,
    includeLeases,
    basis: evBridgeBasis,
  };
  notes.push(evBridgeBasis);
  if (ev === null) {
    gaps.push(gapEntry("valuation.multiples.enterpriseValue", "EV components missing (marketCap/totalDebt/cash) — EV multiples n/m", "info"));
  } else if (leaseLiability === null) {
    gaps.push(
      gapEntry(
        "valuation.multiples.enterpriseValue.leases",
        totalLeaseLiability === null
          ? "lease liabilities (capitalLeaseObligations) not disclosed — they could not be separated from totalDebt, so enterprise value is reported as-is and any lease liability inside totalDebt stays in EV regardless of THESIS_EV_INCLUDE_LEASES"
          : `lease liabilities of ${fmtNum(totalLeaseLiability)} are disclosed only as a combined operating + finance figure (the FMP route publishes no split) — only the OPERATING slice may be netted out of EV, so enterprise value is reported as-is rather than removing an unknown mix`,
        "info",
      ),
    );
  } else if (includeLeases) {
    gaps.push(
      gapEntry(
        "valuation.multiples.enterpriseValue.leases",
        `THESIS_EV_INCLUDE_LEASES=1: enterprise value keeps the operating-lease liability of ${fmtNum(leaseLiability)} while EBITDA remains after operating-lease cost (ASC 842) — EV/EBITDA is not comparable to the default basis`,
        "warn",
      ),
    );
  }

  const financialsRoute = route === "bank" || route === "insurer" || route === "reit-mortgage";
  if (financialsRoute) {
    notes.push("EV multiples suppressed for financials — debt is raw material, EV is meaningless (house rule per SPEC §6)");
  }

  // --- Current multiples from raw fields ------------------------------------
  const current: Partial<Record<MultipleKey, number | null>> = {
    peTtm:
      price !== null && posOrNull(inc?.epsDiluted) !== null
        ? price / (inc?.epsDiluted as number)
        : safeDiv(mcap, posOrNull(inc?.netIncome)),
    priceToFcf: safeDiv(mcap, posOrNull(fcf)),
    priceToBook: safeDiv(mcap, posOrNull(equity)),
    priceToTbv: safeDiv(mcap, posOrNull(tbv)),
    evToEbitda: financialsRoute ? null : safeDiv(ev, posOrNull(ebitda)),
    evToSales: financialsRoute ? null : safeDiv(ev, revenue),
    priceToFfo: safeDiv(mcap, posOrNull(inputs.ffoApprox)),
    priceToAffo: safeDiv(mcap, posOrNull(inputs.affoApprox)),
  };
  if (route === "reit" && posOrNull(inputs.ffoApprox) === null) {
    gaps.push(gapEntry("valuation.multiples.priceToFfo", "FFO (approx.) not provided by caller — P/FFO unavailable", "warn"));
  }

  // Peer comparison is fully specified downstream — PeerStats, the n/m + IQR
  // trim, the minimum-peer house rule, and both export surfaces render it — but
  // nothing upstream ever populates `peers`, so every peer median is null on
  // every report. Disclose that as a typed gap rather than let a permanently
  // empty section read as "no comparable peers found", which is a factual claim
  // about the market that was never actually evaluated.
  if ((inputs.peers ?? []).length === 0) {
    notes.push(
      "Peer multiples are not supplied by the pipeline in this version — the peer median/IQR columns are " +
        "unavailable for every multiple. This is a missing input, NOT a finding that the company has no peers.",
    );
    gaps.push(
      gapEntry(
        "valuation.multiples.peers",
        "peer multiples not supplied to the valuation stage — peer medians unavailable (not evaluated)",
        "info",
      ),
    );
  }

  // --- Own-history bands ------------------------------------------------------
  // Equity REITs are scored on P/FFO and P/AFFO alone, so those must be derived
  // for them; deriving them for every issuer would make the window scan chase
  // series no other route consumes.
  const derivedKeys: readonly MultipleKey[] =
    route === "reit" ? [...DERIVED_HISTORY_KEYS, "priceToFfo", "priceToAffo"] : DERIVED_HISTORY_KEYS;
  // WS6 review (BLOCKER 2): the own-history EV must be built from the SAME
  // definition as the current one — the file's own invariant. `removeOperatingLease`
  // is true exactly when the current EV removed an operating-lease liability.
  const removeOperatingLease = !includeLeases && leaseLiability !== null;
  const derived = deriveOwnHistory(
    inputs.quarterlyFundamentals,
    inputs.enterpriseValuesHistory,
    derivedKeys,
    removeOperatingLease,
  );
  const windowGap = ownHistoryWindowGap(derived);
  if (windowGap) gaps.push(windowGap);
  if (derived.leaseBasisMismatchWindows.length > 0) {
    const detail =
      `${derived.leaseBasisMismatchWindows.length} historical quarter window(s) (${derived.leaseBasisMismatchWindows.slice(0, 8).join(", ")}` +
      `${derived.leaseBasisMismatchWindows.length > 8 ? `, +${derived.leaseBasisMismatchWindows.length - 8} more` : ""}) ` +
      "disclose no operating-lease liability while the current enterprise value removes one — their EV/EBITDA and EV/sales were dropped rather than ranked against a lease-inclusive history";
    notes.push(`own-history EV lease basis: ${detail}`);
    gaps.push(gapEntry("valuation.multiples.ownHistory.evLeaseBasis", detail, "info"));
  }
  const history: HistorySeries = {};
  const historyBasisByKey: Partial<Record<MultipleKey, string>> = {};
  const derivedBasis =
    "per-quarter TTM multiples derived from four normalized contiguous fiscal quarters of raw statements + the latest enterprise value and market capitalization on or before each TTM period end (maximum age 45 calendar days; future observations are ineligible)";
  const vendorBasis = "vendor pre-baked ratio history (FMP key-metrics/ratios quarterly) — derivation from raw statements not possible for this multiple";
  const vendor = !currencyMismatch ? vendorHistory(inputs.keyMetricsHistory) : {};
  // WS6 review (BLOCKER 2): the vendor's pre-baked EV ratios are built on the
  // vendor's own lease-INCLUSIVE enterprise value. Ranking a lease-adjusted
  // current multiple inside that distribution compares two definitions, so when
  // the adjustment fired the vendor EV bands are withheld rather than published
  // on a basis the current number does not share.
  const vendorEvKeys: readonly MultipleKey[] = ["evToEbitda", "evToSales"];
  if (removeOperatingLease && vendorEvKeys.some((key) => (vendor[key]?.length ?? 0) > 0)) {
    for (const key of vendorEvKeys) delete vendor[key];
    const reason =
      "vendor pre-baked EV/EBITDA and EV/sales history is built on the vendor's lease-INCLUSIVE enterprise value, " +
      "while the current EV removes the operating-lease liability — the vendor EV bands are withheld rather than ranking the current multiple inside a differently-defined distribution";
    notes.push(reason);
    gaps.push(gapEntry("valuation.multiples.ownHistory.evLeaseBasis", reason, "info"));
  }
  const historyKeys: readonly MultipleKey[] = [
    ...DERIVED_HISTORY_KEYS,
    "priceToTbv",
    "priceToFfo",
    "priceToAffo",
  ];
  let usedVendor = false;
  for (const key of historyKeys) {
    const ownValues = derived.series[key];
    const vendorValues = vendor[key];
    if ((ownValues?.length ?? 0) >= MIN_HISTORY_OBS_FOR_BAND) {
      history[key] = ownValues;
      historyBasisByKey[key] =
        derivedBasis +
        (removeOperatingLease && vendorEvKeys.includes(key)
          ? ". Each historical enterprise value removes that quarter's OWN operating-lease liability, the same adjustment the current EV carries"
          : "");
    } else if ((vendorValues?.length ?? 0) >= MIN_HISTORY_OBS_FOR_BAND) {
      history[key] = vendorValues;
      historyBasisByKey[key] = vendorBasis;
      usedVendor = true;
    }
  }
  if (usedVendor) {
    notes.push("own-history bands built from vendor pre-baked multiples (raw derivation unavailable)");
  }
  if (!historyKeys.some((key) => (history[key]?.length ?? 0) >= MIN_HISTORY_OBS_FOR_BAND)) {
    if (currencyMismatch && (inputs.keyMetricsHistory?.length ?? 0) > 0) {
      notes.push("vendor pre-baked multiple history skipped: currency mismatch (ADR) makes it untrustworthy");
    }
    gaps.push(gapEntry("valuation.multiples.ownHistory", `insufficient history (need ≥${MIN_HISTORY_OBS_FOR_BAND} quarters) to rank the current multiple among the issuer's own quarters (window up to 5y)`, "info"));
  }

  // --- Assemble ---------------------------------------------------------------
  const universalKeys: MultipleKey[] = ["peTtm", "evToEbitda", "evToSales", "priceToFcf", "priceToBook", "priceToTbv"];
  const keys: MultipleKey[] =
    route === "reit" ? [...universalKeys, "priceToFfo", "priceToAffo"] : universalKeys;
  // Honest period labels: when TTM was suppressed upstream (incomplete
  // quarterly data) the income/cash-flow slice is the latest ANNUAL row — the
  // multiples table must say so instead of claiming "(TTM)".
  const incomeBasisLabel =
    inputs.incomeTtm?.basis === "annual"
      ? `latest annual FY ${inputs.incomeTtm.date} — TTM suppressed`
      : "TTM";
  const cashFlowBasisLabel =
    inputs.cashFlowTtm?.basis === "annual"
      ? `latest annual FY ${inputs.cashFlowTtm.date} — TTM suppressed`
      : "TTM";
  if (inputs.incomeTtm?.basis === "annual") {
    notes.push(
      "income-derived multiples use the latest ANNUAL statement — TTM was suppressed (incomplete quarterly data)",
    );
  }
  if (inputs.cashFlowTtm?.basis === "annual") {
    notes.push(
      "cash-flow-derived multiples use the latest ANNUAL statement — TTM was suppressed (incomplete quarterly data)",
    );
  }
  // Honest balance-period label (2026-07-09 audit M4): say WHICH balance row
  // anchors the point-in-time multiples instead of a vague "(latest)".
  const balanceBasisLabel =
    bal?.basis === "quarter"
      ? `latest quarterly balance sheet ${bal.date}`
      : bal?.basis === "annual"
        ? `latest annual balance sheet ${bal.date}`
        : "latest";
  const basisByKey: Record<MultipleKey, string> = {
    peTtm: `price / epsDiluted (${incomeBasisLabel}); fallback marketCap / netIncome (${incomeBasisLabel})`,
    evToEbitda: `EV / (operatingIncome + D&A), ${incomeBasisLabel}-computed — vendor ebitda field not trusted. ${evBridgeBasis} Balance basis: ${balanceBasisLabel}.`,
    evToSales: `EV / revenue (${incomeBasisLabel}). ${evBridgeBasis}`,
    priceToFcf:
      `marketCap / (operatingCashFlow + capitalExpenditure) (${cashFlowBasisLabel}; FMP capex negative) — free cash flow BEFORE ` +
      "stock-based compensation, the vendor convention, which is also the basis of the own-history distribution this multiple is " +
      "ranked in. The capital block's house-default free cash flow subtracts SBC and is a DIFFERENT figure; the two are never mixed (WS6 review, SHOULD-FIX 4)",

    priceToBook: `marketCap / totalStockholdersEquity (${balanceBasisLabel})`,
    priceToTbv: `marketCap / (equity - goodwill - intangibleAssets) (${balanceBasisLabel})`,
    priceToFfo: "marketCap / FFO (approx., caller-provided)",
    priceToAffo: "marketCap / AFFO (rough, caller-provided)",
  };
  const multiples: MultipleStat[] = keys.map((key) => {
    const cur = current[key] ?? null;
    return {
      key,
      current: cur,
      basis: basisByKey[key],
      ownHistory: bandFor(history[key], cur, historyBasisByKey[key] ?? "no usable multiple history"),
      peers: peerStats((inputs.peers ?? []).map((p) => p.multiples[key]), notes, key),
    };
  });
  // WS6 (D-19): state N per multiple. The report's multiples table carries the
  // rank but not the window size, so the sentence that makes the number
  // readable - "rank among N quarters", never "percentile" - is published here.
  for (const m of multiples) {
    const band = m.ownHistory;
    if (band === null || band.percentileRank === null) continue;
    notes.push(
      `${m.key}: the own-history figure is a RANK AMONG ${band.observations} QUARTERS of this issuer's own history ` +
        `(${fmtNum(band.percentileRank)} on a 0-100 scale), not a percentile of a distribution - ${band.observations} observations ` +
        "cannot estimate percentiles, and a rank within the observed sample is what it measures.",
    );
  }

  // Negative denominators were already nulled via posOrNull; belt-and-braces:
  for (const m of multiples) {
    if (m.current !== null && m.current <= 0) {
      m.current = null;
      // The own-history rank was computed from this value before it was ruled
      // not-meaningful, so it must go too — otherwise the report shows a
      // rank (typically 0) for a multiple it prints as n/m. The
      // distribution (p5..p95, observations) is independent of `current` and
      // stays.
      if (m.ownHistory !== null) m.ownHistory = { ...m.ownHistory, percentileRank: null };
      notes.push(`${m.key}: negative/zero multiple rendered n/m`);
    }
  }

  return {
    multiples,
    enterpriseValue,
    sectorAppropriate: SECTOR_APPROPRIATE_MULTIPLES[route],
    asOf: { quote: null, statements: inc?.date ?? bal?.date ?? null },
    notes,
    gaps,
  };
}

// ---------------------------------------------------------------------------
// Excess-return model (banks / insurers) — Damodaran equity-only model
// ---------------------------------------------------------------------------

export interface ExcessReturnInputs {
  /** BV0 = totalStockholdersEquity, latest (FMP name). */
  bookValue: number | null;
  /** Current ROE, percent — TTM unless `currentRoeBasis` says otherwise. */
  currentRoePct: number | null;
  /**
   * Which figure `currentRoePct` actually is. The keyless path has no FMP
   * key-metrics-TTM row and falls back to the latest fiscal-year DuPont ROE
   * (net income / average fiscal-year equity), so the printed assumption must
   * not keep calling that "TTM ROE". Defaults to `"ttm"`.
   */
  currentRoeBasis?: "ttm" | "fiscal-year-dupont";
  /** Fiscal-year end the DuPont ROE is measured at; only read for that basis. */
  currentRoeAsOf?: string | null;
  /**
   * Optional caller override of the TERMINAL ROE (percent). The default terminal
   * ROE is the cost of equity (competitive fade → zero terminal excess); a value
   * above CoE asserts persistent excess returns. NOT populated by the production
   * pipeline (see compute.ts) — the default competitive fade applies in practice.
   */
  analystImpliedRoePct?: number | null;
  /**
   * Cost of equity, percent. Null (e.g. risk-free-rate fetch failed upstream)
   * SUPPRESSES the model with a critical gap — a discount rate is never
   * defaulted (2026-07-09 audit M5; mirrors the DCF's WACC guard).
   */
  costOfEquityPct: number | null;
  /** Explicit horizon; default 10. */
  years?: number;
  /** Dividend + buyback payout as % of net income; missing history suppresses. */
  payoutRatioPct?: number | null;
  dilutedShares?: number | null;
  /** Reverse-solve target (market cap in same currency units as bookValue). */
  marketCap?: number | null;
  asOf?: string | null;
  /**
   * WS5: tangible common equity (equity − goodwill − other intangibles −
   * preferred) for the P/TBV-against-ROTE pairing. Optional; without it the
   * pairing is withheld with a reason rather than falling back to plain book
   * value, which would flatter a goodwill-heavy acquirer.
   */
  tangibleCommonEquity?: number | null;
  /** WS5: return on tangible common equity, percent — the return P/TBV is read against. */
  rotePct?: number | null;
}

/** WS5: the multiple a financial's price is actually read on, beside the return that justifies it. */
export interface PriceToTangibleBookVsRote {
  /** market cap / tangible common equity. */
  pTbv: number | null;
  /** Return on tangible common equity, percent. */
  rotePct: number | null;
  /**
   * The multiple the return justifies under the same residual-income identity
   * the forward model uses: (ROTE − g) / (CoE − g), with g the sustainable
   * growth rate ROTE × retention. Null when the identity does not hold.
   */
  justifiedPTbv: number | null;
  /** pTbv − justifiedPTbv; positive = the market pays more than the return supports. */
  premiumToJustified: number | null;
  basis: string;
  /** Non-null when the pairing (or the justified multiple) was withheld. */
  withheldReason: string | null;
}

export interface ExcessReturnResult {
  equityValue: number | null;
  perShare: number | null;
  /** equityValue / BV0 — sanity anchor vs (ROE - g)/(CoE - g). */
  impliedPToBv: number | null;
  roePathPct: Assumption<number[]>;
  payoutRatioPct: Assumption<number | null>;
  /** WS5: the explicit horizon the excess returns are summed over. */
  horizonYears: Assumption<number>;
  /** WS5: the discount rate — the cost of EQUITY, never a WACC. */
  costOfEquityPct: Assumption<number | null>;
  /** WS5: opening book equity the model builds on. */
  openingBookValue: Assumption<number | null>;
  /** WS5: P/TBV against ROTE — the pairing a financial is actually judged on. */
  priceToTangibleBookVsRote: PriceToTangibleBookVsRote;
  /** BV_0 .. BV_N under retention compounding. */
  bookValuePath: number[];
  /**
   * Year-N economic profit in currency: (ROE_N − CoE) · BV_{N-1}. Zero when ROE
   * fades to CoE (the default); nonzero only when a caller overrides the terminal
   * ROE via analystImpliedRoePct. Computed, never assumed.
   */
  terminalExcess: number | null;
  reverseSolve: { impliedCurrentRoePct: number | null; notes: string[] };
  asOf: string | null;
  notes: string[];
  gaps: ManifestEntry[];
}

/** Core: BV_t = BV_{t-1}(1 + ROE_t * retention); value = BV0 + sum PV(excess). */
function excessReturnValue(
  bv0: number,
  roePathPct: number[],
  coePct: number,
  payoutPct: number,
): { equityValue: number; bookValuePath: number[] } {
  const coe = coePct / 100;
  const retention = 1 - payoutPct / 100;
  const bookValuePath: number[] = [bv0];
  let bv = bv0;
  let pvExcess = 0;
  for (let t = 1; t <= roePathPct.length; t++) {
    const roe = roePathPct[t - 1] / 100;
    const excess = (roe - coe) * bv;
    pvExcess += excess / Math.pow(1 + coe, t);
    // A LOSS is retained in full. `roe * retention` on a negative ROE returns a
    // fraction of the loss to book value — arithmetically a capital injection
    // proportional to the loss, because `payout x negative earnings` is a
    // negative dividend. Dividends are not negative; a loss reduces book value
    // by its whole amount. Only positive earnings are shared with holders.
    const bvGrowth = roe < 0 ? roe : roe * retention;
    bv = bv * (1 + bvGrowth);
    bookValuePath.push(bv);
  }
  return { equityValue: bv0 + pvExcess, bookValuePath };
}

/**
 * Excess-return equity model for banks/insurers (NO WACC, NO FCFF anywhere):
 * EquityValue = BV0 + sum_t (ROE_t - CoE) * BV_{t-1} / (1 + CoE)^t, with ROE
 * fading from current TTM ROE to the cost of equity by the terminal year, so
 * terminal excess returns are zero (the equity-side analogue of the DCF core's
 * terminal ROIC = WACC). A caller MAY override the terminal ROE
 * (analystImpliedRoePct) to assert persistent excess; the override is reflected
 * honestly in `terminalExcess` and the basis string. Also reverse-solves the
 * constant steady-state ROE that reproduces the current market cap.
 */
/**
 * WS5: P/TBV read against ROTE — the pair a bank, insurer or mortgage REIT is
 * actually judged on, and the one the route's `lead` list has named all along.
 *
 * Tangible common equity is the denominator, not book equity: goodwill and
 * other intangibles absorb losses only after common equity is gone, so a
 * goodwill-heavy acquirer trading at 1.0x BOOK can be at 2.0x tangible book,
 * and comparing that multiple against a return computed on tangible equity
 * (ROTE) would be comparing two different denominators.
 *
 * The justified multiple is the residual-income identity the forward model
 * already assumes, (ROTE − g) / (CoE − g), with g = ROTE × retention. It is
 * withheld — never clamped — when CoE − g is not comfortably positive, because
 * the ratio explodes through infinity there and any number it produced would be
 * an artefact of the arithmetic rather than a valuation.
 */
export const JUSTIFIED_PTBV_MIN_SPREAD_PP = 0.5;

function priceToTangibleBookVsRote(
  inputs: ExcessReturnInputs,
  coePct: number | null,
  payoutPct: number | null,
): PriceToTangibleBookVsRote {
  const tce = posOrNull(inputs.tangibleCommonEquity);
  const mcap = posOrNull(inputs.marketCap);
  const rotePct = isNum(inputs.rotePct) ? inputs.rotePct : null;
  const empty = (reason: string, basis: string): PriceToTangibleBookVsRote => ({
    pTbv: null,
    rotePct,
    justifiedPTbv: null,
    premiumToJustified: null,
    basis,
    withheldReason: reason,
  });

  if (tce === null) {
    return empty(
      "tangible common equity unavailable or not positive — P/TBV withheld rather than substituting book equity, which would flatter a goodwill-heavy balance sheet",
      "market cap / tangible common equity, against return on tangible common equity",
    );
  }
  if (mcap === null) {
    return empty(
      "market cap unavailable — P/TBV not computable",
      "market cap / tangible common equity, against return on tangible common equity",
    );
  }
  const pTbv = mcap / tce;

  if (rotePct === null || coePct === null || payoutPct === null) {
    const missing =
      rotePct === null
        ? "return on tangible common equity"
        : coePct === null
          ? "cost of equity"
          : "payout history (needed for the retention rate in g)";
    return {
      pTbv,
      rotePct,
      justifiedPTbv: null,
      premiumToJustified: null,
      basis: `P/TBV = market cap ${mcap} / tangible common equity ${tce} = ${fmtNum(pTbv)}x`,
      withheldReason: `${missing} unavailable — the justified multiple (ROTE − g)/(CoE − g) was not computed, so the multiple is shown without the return that would justify it`,
    };
  }

  const retention = 1 - payoutPct / 100;
  const g = (rotePct / 100) * retention * 100;
  const spread = coePct - g;
  if (spread < JUSTIFIED_PTBV_MIN_SPREAD_PP) {
    return {
      pTbv,
      rotePct,
      justifiedPTbv: null,
      premiumToJustified: null,
      basis:
        `P/TBV = market cap ${mcap} / tangible common equity ${tce} = ${fmtNum(pTbv)}x, against ROTE ${fmtNum(rotePct)}%`,
      withheldReason:
        `sustainable growth g = ROTE ${fmtNum(rotePct)}% x retention ${fmtNum(retention * 100)}% = ${fmtNum(g)}% leaves ` +
        `only ${fmtNum(spread)}pp below the cost of equity ${fmtNum(coePct)}% (floor ${JUSTIFIED_PTBV_MIN_SPREAD_PP}pp) — ` +
        "the justified multiple (ROTE − g)/(CoE − g) diverges there, so it is withheld rather than reported as a very large number",
    };
  }
  const justifiedPTbv = (rotePct - g) / spread;
  return {
    pTbv,
    rotePct,
    justifiedPTbv,
    premiumToJustified: pTbv - justifiedPTbv,
    basis:
      `P/TBV = market cap ${mcap} / tangible common equity ${tce} = ${fmtNum(pTbv)}x, against ROTE ${fmtNum(rotePct)}%. ` +
      `Justified P/TBV = (ROTE ${fmtNum(rotePct)}% − g ${fmtNum(g)}%) / (CoE ${fmtNum(coePct)}% − g ${fmtNum(g)}%) = ` +
      `${fmtNum(justifiedPTbv)}x, where g = ROTE x retention ${fmtNum(retention * 100)}% — the same residual-income ` +
      "identity the forward model assumes, so the two readings cannot disagree.",
    withheldReason: null,
  };
}

export function excessReturnModel(inputs: ExcessReturnInputs): ExcessReturnResult {
  const notes: string[] = [];
  const gaps: ManifestEntry[] = [];
  const years = inputs.years ?? EXCESS_RETURN_YEARS;
  const reverseNotes: string[] = [];
  // WS5: the horizon, the discount rate and the opening book value are printed
  // as assumptions in their own right — the model's shape was previously only
  // inferable from the ROE-path basis string.
  const horizonBasis = (built: boolean): string =>
    built
      ? `explicit ${years}-year horizon: the excess return (ROE − cost of equity) x prior-year book equity is ` +
        `discounted year by year to year ${years}. ROE is faded LINEARLY to the cost of equity over exactly that ` +
        "horizon, so the year-N excess is zero and NO continuing value is added beyond it."
      : `explicit ${years}-year horizon (model not built)`;
  const coeSupplied = isNum(inputs.costOfEquityPct) ? inputs.costOfEquityPct : null;
  const unbuiltAssumptions = {
    horizonYears: { value: years, basis: horizonBasis(false) },
    costOfEquityPct: {
      value: coeSupplied,
      basis:
        coeSupplied === null
          ? "not supplied — the model is suppressed rather than discounting at a defaulted rate"
          : `cost of equity ${fmtNum(coeSupplied)}% (CAPM, upstream); the model never uses a WACC`,
    },
    openingBookValue: {
      value: posOrNull(inputs.bookValue),
      basis:
        posOrNull(inputs.bookValue) === null
          ? "totalStockholdersEquity missing or non-positive"
          : "latest total stockholders' equity (BV0)",
    },
    priceToTangibleBookVsRote: priceToTangibleBookVsRote(inputs, coeSupplied, null),
  } satisfies Pick<
    ExcessReturnResult,
    "horizonYears" | "costOfEquityPct" | "openingBookValue" | "priceToTangibleBookVsRote"
  >;

  // 2026-07-09 audit M5: a null cost of equity used to be silently defaulted to
  // 10% upstream. Suppress instead — the discount rate is load-bearing, exactly
  // like the DCF path's WACC guard.
  if (!isNum(inputs.costOfEquityPct)) {
    gaps.push(
      gapEntry(
        "valuation.excessReturn.costOfEquity",
        "cost of equity unavailable (risk-free rate / CAPM inputs missing upstream) — excess-return valuation suppressed rather than defaulting a discount rate",
        "critical",
      ),
    );
    return {
      equityValue: null,
      perShare: null,
      impliedPToBv: null,
      roePathPct: { value: [], basis: "not built (no cost of equity)" },
      payoutRatioPct: { value: null, basis: "not built (no cost of equity)" },
      bookValuePath: [],
      ...unbuiltAssumptions,
      terminalExcess: null,
      reverseSolve: { impliedCurrentRoePct: null, notes: ["skipped: no cost of equity"] },
      asOf: inputs.asOf ?? null,
      notes,
      gaps,
    };
  }
  const coe = inputs.costOfEquityPct;

  const bv0 = posOrNull(inputs.bookValue);
  if (bv0 === null) {
    gaps.push(
      gapEntry("valuation.excessReturn.bookValue", "totalStockholdersEquity missing or non-positive — excess-return model not computable", "critical"),
    );
    return {
      equityValue: null,
      perShare: null,
      impliedPToBv: null,
      roePathPct: { value: [], basis: "not built (no book value)" },
      payoutRatioPct: { value: null, basis: "not built (no book value)" },
      bookValuePath: [],
      ...unbuiltAssumptions,
      terminalExcess: null,
      reverseSolve: { impliedCurrentRoePct: null, notes: ["skipped: no book value"] },
      asOf: inputs.asOf ?? null,
      notes,
      gaps,
    };
  }

  if (!isNum(inputs.payoutRatioPct)) {
    gaps.push(
      gapEntry(
        "valuation.excessReturn.payout",
        "company payout history unavailable — excess-return valuation suppressed rather than assuming a universal payout ratio",
        "critical",
      ),
    );
    return {
      equityValue: null,
      perShare: null,
      impliedPToBv: null,
      roePathPct: { value: [], basis: "not built (no payout history)" },
      payoutRatioPct: { value: null, basis: "not built (no payout history)" },
      bookValuePath: [],
      ...unbuiltAssumptions,
      terminalExcess: null,
      reverseSolve: { impliedCurrentRoePct: null, notes: ["skipped: no payout history"] },
      asOf: inputs.asOf ?? null,
      notes,
      gaps,
    };
  }
  const payout = clampWithNote(
    inputs.payoutRatioPct,
    PAYOUT_CLAMP_PCT[0],
    PAYOUT_CLAMP_PCT[1],
    "payout ratio (pct)",
    notes,
  );
  const payoutBasis = "caller-provided (dividends + net buybacks / net income, 3y avg upstream)";

  // Competitive fade: ROE fades to the cost of equity by the terminal year, so
  // terminal excess returns are zero — the equity-side analogue of the DCF
  // core's terminal ROIC = WACC. A caller MAY override the terminal ROE
  // (analystImpliedRoePct); that asserts persistent excess and is surfaced
  // honestly below. Production never supplies it, so the default fade applies.
  if (!isNum(inputs.currentRoePct)) {
    gaps.push(
      gapEntry(
        "valuation.excessReturn.currentRoe",
        "current company ROE unavailable — excess-return valuation suppressed rather than substituting the terminal ROE path",
        "critical",
      ),
    );
    return {
      equityValue: null,
      perShare: null,
      impliedPToBv: null,
      roePathPct: { value: [], basis: "not built (no current ROE)" },
      payoutRatioPct: { value: payout, basis: payoutBasis },
      bookValuePath: [],
      ...unbuiltAssumptions,
      terminalExcess: null,
      reverseSolve: { impliedCurrentRoePct: null, notes: ["skipped: no current ROE"] },
      asOf: inputs.asOf ?? null,
      notes,
      gaps,
    };
  }
  const roeStart = inputs.currentRoePct;
  const overrideTerminal = isNum(inputs.analystImpliedRoePct);
  const endRoe = overrideTerminal ? (inputs.analystImpliedRoePct as number) : coe;
  const endBasis = overrideTerminal
    ? `caller-supplied terminal ROE ${fmtNum(endRoe)}% (persistent excess asserted)`
    : `cost of equity ${fmtNum(coe)}% (competitive fade — zero terminal excess)`;
  const startBasis =
    inputs.currentRoeBasis === "fiscal-year-dupont"
      ? `${inputs.currentRoeAsOf != null ? `FY ${inputs.currentRoeAsOf} ` : ""}DuPont ROE`
      : "TTM ROE";
  const roeBasis = `linear fade from ${startBasis} ${fmtNum(roeStart)}% to ${endBasis} by year ${years}`;
  const roePath = fadePath(roeStart, endRoe, years);

  const { equityValue, bookValuePath } = excessReturnValue(bv0, roePath, coe, payout);
  const shares = posOrNull(inputs.dilutedShares);
  const perShare = shares !== null ? equityValue / shares : null;
  if (shares === null) {
    gaps.push(gapEntry("valuation.excessReturn.dilutedShares", "diluted shares missing — per-share value unavailable", "info"));
  }
  const impliedPToBv = safeDiv(equityValue, bv0);
  if (impliedPToBv !== null && (impliedPToBv > 3 || impliedPToBv < 0.3)) {
    notes.push(`implied P/B ${fmtNum(impliedPToBv)} outside [0.3, 3] sanity band — review assumptions (house-rule flag)`);
  }

  // Reverse solve: the STARTING ROE which, under this model's own competitive
  // fade, reproduces the market cap. Monotone in the starting ROE.
  //
  // It previously held ROE CONSTANT for `years` and then stopped accruing
  // residual income — neither a fade (what the forward model assumes) nor a
  // perpetuity (what "steady state" promises), so it inverted no model at all.
  // Two things make the fade the right choice rather than the Gordon closed
  // form:
  //   - Empirically, ROE mean-reverts toward the cost of capital (Fama-French
  //     2000; Nissim-Penman 2001). A perpetual constant excess ROE is the
  //     assumption the forward path explicitly refuses.
  //   - grading.ts compares this number DIRECTLY against `roePathPct.value[0]`
  //     (the current ROE) at 0.5 weight of the valuation aspect. That
  //     subtraction is only meaningful if both sides are the same quantity —
  //     a starting ROE under identical dynamics. Holding ROE constant made the
  //     solved value systematically LOW (a flat path is worth more than a
  //     fading one, so less ROE was needed to reach the price), which biased
  //     every bank, insurer and mortgage REIT toward "market too pessimistic".
  //
  // A clean property follows: the model returns exactly book value when ROE
  // equals the cost of equity, so an issuer priced at book solves to CoE.
  let impliedCurrentRoePct: number | null = null;
  const mcap = posOrNull(inputs.marketCap);
  if (mcap === null) {
    reverseNotes.push("skipped: market cap not provided");
  } else {
    const [lo, hi] = REVERSE_ROE_RANGE_PCT;
    const f = (roe: number): number =>
      // Fade to the SAME terminal target the forward path uses. Hard-wiring CoE
      // here re-opened the apples-to-apples defect this solve exists to close
      // whenever a caller overrode the terminal ROE.
      excessReturnValue(bv0, fadePath(roe, endRoe, years), coe, payout).equityValue - mcap;
    const fLo = f(lo);
    const fHi = f(hi);
    if (fLo > 0) {
      reverseNotes.push(`market cap below the ${lo}% starting-ROE value — implied ROE < ${lo}%`);
    } else if (fHi < 0) {
      reverseNotes.push(`market cap above the ${hi}% starting-ROE value — implied ROE > ${hi}% (price not justifiable on book returns)`);
    } else {
      const root = bisect(f, { lo, hi, fLo, fHi }, mcap);
      impliedCurrentRoePct = root;
      if (root !== null) {
        reverseNotes.push(`starting ROE fading to ${endBasis} over ${years} years (payout ${fmtNum(payout)}%) matching market cap — comparable to the current ROE, same dynamics as the forward path`);
      }
    }
  }

  // Terminal excess = year-N economic profit (ROE_N − CoE)·BV_{N-1}, undiscounted,
  // in currency. Zero by construction when the fade lands on CoE (the default).
  const terminalExcess =
    roePath.length > 0
      ? ((roePath[roePath.length - 1] - coe) / 100) * bookValuePath[bookValuePath.length - 2]
      : 0;
  notes.push(
    overrideTerminal
      ? `excess-return model: equity-only (CoE, never WACC); terminal ROE overridden to ${fmtNum(endRoe)}% — terminal excess ${fmtNum(terminalExcess)} (currency), NOT zero`
      : "excess-return model: equity-only (CoE, never WACC); ROE fades to CoE so terminal excess returns = 0",
  );
  // WS5: the P/TBV-against-ROTE pairing, now that the payout (and hence the
  // retention rate inside g) is known.
  const pTbvVsRote = priceToTangibleBookVsRote(inputs, coe, payout);
  if (pTbvVsRote.withheldReason !== null && pTbvVsRote.pTbv === null) {
    gaps.push(
      gapEntry("valuation.excessReturn.priceToTangibleBook", pTbvVsRote.withheldReason, "info"),
    );
  }
  return {
    equityValue,
    perShare,
    impliedPToBv,
    roePathPct: { value: roePath, basis: roeBasis },
    payoutRatioPct: { value: payout, basis: payoutBasis },
    horizonYears: { value: years, basis: horizonBasis(true) },
    costOfEquityPct: {
      value: coe,
      basis:
        `cost of equity ${fmtNum(coe)}% (CAPM, upstream) — the ONLY discount rate in this model: the excess returns ` +
        "are equity flows, so a WACC would discount them at a blended rate that includes the cost of deposits, " +
        "policy reserves or repo, which are this company's raw material rather than its financing.",
    },
    openingBookValue: {
      value: bv0,
      basis: `opening book equity BV0 = latest total stockholders' equity ${bv0}${inputs.asOf != null ? ` as of ${inputs.asOf}` : ""}; each later year's book value compounds at ROE x retention`,
    },
    priceToTangibleBookVsRote: pTbvVsRote,
    bookValuePath,
    terminalExcess,
    reverseSolve: { impliedCurrentRoePct, notes: reverseNotes },
    asOf: inputs.asOf ?? null,
    notes,
    gaps,
  };
}

// ---------------------------------------------------------------------------
// REIT valuation (P/FFO, P/AFFO, implied cap rate sketch)
// ---------------------------------------------------------------------------

export interface ReitInputs {
  /**
   * FFO. When `ffoBasis` says so this is the NAREIT computation (net income +
   * real-estate D&A − gains on property sales + impairments); otherwise it is
   * the netIncome + D&A approximation.
   */
  ffoApprox: number | null;
  /** AFFO — recurring capex and straight-line rent when tagged, else FFO − all capex. */
  affoApprox: number | null;
  sharePrice: number | null;
  shares: number | null;
  netDebt: number | null;
  /** NOI approx = operatingIncome + D&A, when derivable. */
  noiApprox?: number | null;
  asOf?: string | null;
  /** WS5: how FFO was actually built, printed instead of the fixed disclaimer. */
  ffoBasis?: string | null;
  /** WS5: how AFFO was actually built. */
  affoBasis?: string | null;
  /** WS5: true when FFO added back total D&A because real-estate D&A is untagged. */
  ffoApproximate?: boolean;
  /** WS5: true when AFFO could not subtract recurring capex / straight-line rent. */
  affoApproximate?: boolean;
  /**
   * WS5 (D-16): the REIT sub-map. "undetermined" withholds every FFO-based
   * figure, because publishing them would assert an equity REIT on no evidence.
   */
  submap?: "equity" | "mortgage" | "undetermined" | null;
  /** WS5: the routing reason for an undetermined sub-map, repeated on each withheld figure. */
  submapReason?: string | null;
}

export interface ReitValuationResult {
  pToFfo: number | null;
  pToAffo: number | null;
  ffoPerShare: number | null;
  affoPerShare: number | null;
  /** NOI(approx) / EV, percent — labeled sketch. */
  impliedCapRatePct: number | null;
  enterpriseValue: number | null;
  asOf: string | null;
  /** WS5: non-null when every FFO-based figure was withheld, with the reason. */
  withheldReason: string | null;
  notes: string[];
  gaps: ManifestEntry[];
}

/**
 * REIT valuation block: P/FFO + P/AFFO + implied-cap-rate sketch.
 *
 * WS5: FFO and AFFO now arrive already computed (see
 * `computeNareitFfo` in stageB/financialMetrics.ts), which applies the NAREIT
 * definition where the filer's tags allow and labels the figure approximate
 * where they do not. This function prints the basis it is given rather than a
 * fixed disclaimer that was wrong whenever the definition DID apply.
 *
 * When the equity-vs-mortgage sub-map is undetermined every FFO-based figure is
 * withheld: P/FFO on a mortgage REIT is meaningless, and asserting an equity
 * REIT on the strength of SIC 6798 alone is exactly what D-16 forbids.
 */
export function reitValuation(inputs: ReitInputs): ReitValuationResult {
  const notes: string[] = [];
  const gaps: ManifestEntry[] = [];

  if (inputs.submap === "undetermined") {
    const reason =
      inputs.submapReason ??
      "the REIT sub-map is undetermined (SIC 6798 covers equity and mortgage REITs alike and no XBRL evidence separated them)";
    notes.push(
      `FFO, AFFO, P/FFO, P/AFFO and the implied cap rate are all WITHHELD: ${reason}. FFO presumes an equity REIT — ` +
        "on a mortgage REIT it is not a meaningful figure — so publishing it here would assert a business model the " +
        "evidence does not support. The book-value metrics a mortgage REIT leads with are withheld for the mirror " +
        "reason.",
    );
    gaps.push(
      gapEntry(
        "valuation.reit.submap",
        `REIT valuation withheld: ${reason} — FFO/AFFO/P-FFO presume an equity REIT and book-value metrics presume a mortgage REIT; neither family is published`,
        "warn",
      ),
    );
    return {
      pToFfo: null,
      pToAffo: null,
      ffoPerShare: null,
      affoPerShare: null,
      impliedCapRatePct: null,
      enterpriseValue: null,
      asOf: inputs.asOf ?? null,
      withheldReason: reason,
      notes,
      gaps,
    };
  }

  notes.push(
    inputs.ffoBasis ??
      "FFO (approx.) = netIncome + D&A — gains on property sales / RE impairments not netted (no tagged lines)",
  );
  notes.push(
    inputs.affoBasis ?? "AFFO (rough) = FFO - |capex| — treats ALL capex as maintenance (conservative)",
  );
  if (inputs.ffoApproximate === true) {
    notes.push(
      "FFO is labeled APPROXIMATE: total depreciation and amortization was added back because the filer tags no " +
        "separate real-estate depreciation, so the figure sits at or above the NAREIT definition.",
    );
  }
  const price = posOrNull(inputs.sharePrice);
  const shares = posOrNull(inputs.shares);
  const mcap = price !== null && shares !== null ? price * shares : null;
  if (mcap === null) {
    gaps.push(gapEntry("valuation.reit.marketCap", "share price or share count missing", "warn"));
  }
  const ffo = posOrNull(inputs.ffoApprox);
  const affo = posOrNull(inputs.affoApprox);
  if (ffo === null) {
    gaps.push(gapEntry("valuation.reit.ffo", "FFO missing or non-positive — P/FFO n/m", "warn"));
  }
  const ev = mcap !== null && isNum(inputs.netDebt) ? mcap + inputs.netDebt : null;
  if (ev === null) {
    gaps.push(gapEntry("valuation.reit.enterpriseValue", "net debt or market cap missing — EV/implied cap rate unavailable", "info"));
  }
  const noi = posOrNull(inputs.noiApprox);
  let impliedCapRatePct: number | null = null;
  if (noi !== null && ev !== null && ev > 0) {
    impliedCapRatePct = (noi / ev) * 100;
    notes.push("implied cap rate = NOI(approx = operatingIncome + D&A) / EV — a sketch, not an appraisal");
  } else {
    gaps.push(gapEntry("valuation.reit.impliedCapRate", "NOI not derivable (or EV missing) — implied cap rate disclosed as gap", "info"));
  }
  return {
    pToFfo: safeDiv(mcap, ffo),
    pToAffo: safeDiv(mcap, affo),
    ffoPerShare: safeDiv(ffo, shares),
    affoPerShare: safeDiv(affo, shares),
    impliedCapRatePct,
    enterpriseValue: ev,
    asOf: inputs.asOf ?? null,
    withheldReason: null,
    notes,
    gaps,
  };
}

// ---------------------------------------------------------------------------
// valueCompany — route dispatcher
// ---------------------------------------------------------------------------

export interface ValuationBundleInputs {
  currentPrice: number | null;
  waccPct: number | null;
  netDebt: number | null;
  dilutedShares: number | null;
  /** Minority interest / preferred equity for the DCF equity bridge (0 when absent). */
  minorityInterest?: number | null;
  preferred?: number | null;
  /**
   * WS6 (D-19): TOTAL lease liabilities (FMP `capitalLeaseObligations`), already
   * inside `totalDebt` and therefore inside `netDebt`. Null when undisclosed.
   * Disclosure context only — the bridge adjusts by `operatingLeaseLiability`.
   */
  leaseLiability?: number | null;
  /**
   * WS6 review (BLOCKER 1): the OPERATING slice, the only one the equity bridge
   * may net out of net debt. EBIT and EBITDA are before finance-lease cost
   * (right-of-use amortisation + interest), so the finance-lease liability is
   * debt in both frames. Null when the split is unavailable ⇒ net debt is used
   * as reported.
   */
  operatingLeaseLiability?: number | null;
  /** WS6 (D-19): THESIS_EV_INCLUDE_LEASES — keep leases in the EV bridge. */
  includeLeasesInEv?: boolean;
  /** General route: DCF assumption inputs (null when not applicable). */
  dcfInputs: DcfAssumptionInputs | null;
  multiples: MultiplesFrameworkInputs;
  /** Bank/insurer route (null otherwise). */
  excessReturn: ExcessReturnInputs | null;
  /** Equity REIT route (null otherwise). */
  reit: ReitInputs | null;
}

export type ValuationResult =
  | {
      kind: "dcf";
      route: SectorRoute;
      assumptions: DcfAssumptions | null;
      dcf: DcfResult | null;
      sensitivity: SensitivityGrid | null;
      reverseDcf: ReverseDcfResult | null;
      multiples: MultiplesResult;
      notes: string[];
      gaps: ManifestEntry[];
    }
  | {
      kind: "excess-return";
      route: SectorRoute;
      excessReturn: ExcessReturnResult;
      multiples: MultiplesResult;
      notes: string[];
      gaps: ManifestEntry[];
    }
  | {
      kind: "reit";
      route: SectorRoute;
      reit: ReitValuationResult;
      multiples: MultiplesResult;
      notes: string[];
      gaps: ManifestEntry[];
    }
  | {
      kind: "pre-revenue";
      route: SectorRoute;
      multiples: null;
      notes: string[];
      gaps: ManifestEntry[];
    }
  | {
      /**
       * General route, but metricPolicy suppresses fcfDcf for this route's
       * overlays (currently: "unprofitable" — structurally negative FCF makes
       * an FCFF-based intrinsic-value model unreliable). Unlike "pre-revenue",
       * multiples ARE still meaningful here (only pe/peg/fcfDcf/dividendSafety/
       * piotroskiF/beneishM are suppressed, not multiples generally), so
       * `multiples` is a real MultiplesResult, not null.
       */
      kind: "dcf-suppressed";
      route: SectorRoute;
      multiples: MultiplesResult;
      notes: string[];
      gaps: ManifestEntry[];
    };

/**
 * Dispatch per sector route: general -> DCF + sensitivity + reverse DCF +
 * multiples; bank/insurer/mortgage-REIT -> excess-return + book multiples
 * (NO DCF); equity REIT -> reitValuation + FFO multiples; pre-revenue overlay
 * -> null valuation (runway framing handled by a different module).
 */
export function valueCompany(route: CompanyRoute, inputs: ValuationBundleInputs): ValuationResult {
  const notes: string[] = [];
  const gaps: ManifestEntry[] = [];

  if (route.overlays.includes("pre-revenue")) {
    notes.push(
      "pre-revenue: DCF, reverse DCF and multiples suppressed (denominators zero/negative); runway + scenario framing handled elsewhere",
    );
    gaps.push(gapEntry("valuation", "pre-revenue company — no meaningful intrinsic-value model in v1", "info"));
    return { kind: "pre-revenue", route: route.base, multiples: null, notes, gaps };
  }

  const multiples = multiplesFramework(route.base, inputs.multiples);
  // Hoist the multiples model's own gaps (peers, ownHistory, priceToFfo) into
  // the valuation manifest, mirroring the excess-return and REIT hoists below.
  // Without this the peers gap added earlier never reached the missing-data
  // manifest, so a permanently empty peer column still had no disclosure.
  gaps.push(...multiples.gaps);

  if (route.base === "bank" || route.base === "insurer" || route.base === "reit-mortgage") {
    notes.push("FCFF DCF and FCFF reverse-DCF suppressed for financials (debt is raw material) — excess-return model used");
    // WS5 (V-10): the three FCFF-derived outputs and the ROIC−WACC spread are
    // all withheld on this route, and each now says so in the manifest as well
    // as the notes. They were structurally absent before — nothing computed
    // them — but an absence with no stated reason reads to a report reader as
    // missing data rather than as a deliberate methodological refusal.
    gaps.push(
      gapEntry(
        "valuation.dcf",
        `FCFF DCF withheld on the '${route.base}' route: free cash flow to the firm subtracts debt service from an operating cash flow that, for a deposit-, float- or repo-funded balance sheet, IS financing activity — the equity excess-return model is used instead`,
        "info",
      ),
      gapEntry(
        "valuation.reverseDcf",
        `FCFF reverse DCF withheld on the '${route.base}' route: it inverts the same FCFF model, so the growth or margin it would solve for inherits the same category error — the excess-return model's reverse solve (the starting ROE that reproduces the market cap) is reported instead`,
        "info",
      ),
      gapEntry(
        "valuation.evEbitda",
        `EV/EBITDA withheld on the '${route.base}' route: enterprise value adds debt and subtracts cash, both of which are operating items here, so the multiple is not defined (a profitable bank can show a negative EV)`,
        "info",
      ),
      gapEntry(
        "returns.roicVsWacc",
        `ROIC − WACC withheld on the '${route.base}' route: invested capital (debt + equity − cash) is undefined when deposits, policy reserves or repo fund the assets and cash is itself an earning asset — return on tangible common equity against the cost of equity is the value-creation read instead`,
        "info",
      ),
    );
    if (route.base === "reit-mortgage") {
      notes.push("mortgage REIT routed to the book-value (excess-return) map per SPEC §6");
    }
    const er = inputs.excessReturn
      ? excessReturnModel(inputs.excessReturn)
      : excessReturnModel({ bookValue: null, currentRoePct: null, costOfEquityPct: null });
    if (!inputs.excessReturn) {
      gaps.push(gapEntry("valuation.excessReturn", "excess-return inputs not provided by caller", "critical"));
    }
    // ADR currency guard, the excess-return twin of the DCF guard below. The
    // per-share value is in the statements' reportedCurrency while the price it
    // is graded against is the quote currency, so on a mismatch the upside is
    // off by the FX rate. Suppress the per-share (and the market-cap reverse
    // solve, which compares equity value to a quote-currency market cap) rather
    // than publish a mixed-currency comparison. No FX conversion attempted.
    const erReported = inputs.multiples.reportedCurrency;
    const erQuote = inputs.multiples.quote.currency;
    if (
      typeof erReported === "string" &&
      typeof erQuote === "string" &&
      erReported.toUpperCase() !== erQuote.toUpperCase()
    ) {
      notes.push(
        `ADR/currency mismatch: statements in ${erReported}, quote in ${erQuote} — excess-return per-share and reverse solve suppressed ` +
          `(per-share intrinsic value would be in ${erReported} against a ${erQuote} price; no FX conversion attempted). ` +
          "See multiples (flagged) for relative valuation.",
      );
      gaps.push(
        gapEntry(
          "valuation.excessReturn.currency",
          `reportedCurrency ${erReported} != quote currency ${erQuote} (ADR case) — excess-return per-share suppressed rather than comparing mixed-currency per-share vs price`,
          "critical",
        ),
      );
      const guarded: ExcessReturnResult = {
        ...er,
        perShare: null,
        reverseSolve: {
          impliedCurrentRoePct: null,
          notes: [
            ...er.reverseSolve.notes,
            `reverse solve suppressed: market cap is in ${erQuote} while book value is in ${erReported}`,
          ],
        },
      };
      // Hoist the model-level gaps on this path too. Suppressing the per-share
      // does not make the CoE/bookValue/payout/ROE gaps irrelevant — an ADR is
      // exactly where the reader needs to see everything else that was missing,
      // so returning early without them made a degraded model MORE opaque than
      // the unguarded path below.
      gaps.push(...er.gaps);
      return { kind: "excess-return", route: route.base, excessReturn: guarded, multiples, notes, gaps };
    }
    // Hoist model-level gaps (CoE/bookValue/payout/ROE suppression, …) so
    // they reach the merged manifest, mirroring the general branch's
    // gaps.push(...built.gaps) — otherwise a suppressed model is invisible in
    // the report appendix.
    gaps.push(...er.gaps);
    return { kind: "excess-return", route: route.base, excessReturn: er, multiples, notes, gaps };
  }

  if (route.base === "reit") {
    notes.push("FCFF DCF suppressed for equity REITs — P/FFO / P/AFFO + cap-rate sketch used");
    // WS5 (criterion e): a net-income DCF is withheld on this route with the
    // reason, not merely omitted. Real-estate depreciation is a large non-cash
    // charge against a REIT's GAAP net income, so discounting that net income
    // would value the company on an earnings figure the industry itself
    // replaces with FFO.
    gaps.push(
      gapEntry(
        "valuation.netIncomeDcf",
        "net-income DCF withheld on the equity-REIT route: GAAP net income is struck after real-estate depreciation, a non-cash charge on assets that typically hold or gain value, so discounting it would understate the company — FFO/AFFO and P/FFO are used instead, per the NAREIT definition",
        "info",
      ),
    );
    const reit = inputs.reit
      ? reitValuation(inputs.reit)
      : reitValuation({ ffoApprox: null, affoApprox: null, sharePrice: null, shares: null, netDebt: null });
    if (!inputs.reit) {
      gaps.push(gapEntry("valuation.reit", "REIT inputs not provided by caller", "critical"));
    }
    gaps.push(...reit.gaps);
    return { kind: "reit", route: route.base, reit, multiples, notes, gaps };
  }

  // General route: DCF + sensitivity + reverse DCF + multiples — unless
  // metricPolicy suppresses fcfDcf for this route's overlays (currently:
  // "unprofitable"), in which case an FCFF-based intrinsic-value model isn't
  // meaningful and we skip it entirely rather than returning a DCF the
  // report's own display policy says shouldn't be shown.
  if (metricPolicy(route).suppress.includes("fcfDcf")) {
    notes.push(
      "fcfDcf suppressed by metric policy (unprofitable overlay) — DCF/sensitivity/reverse-DCF not modelled; " +
        "free cash flow is structurally negative, making an FCFF-based intrinsic-value model unreliable. " +
        "See multiples below for relative valuation.",
    );
    gaps.push(
      gapEntry(
        "valuation.dcf",
        "DCF suppressed for unprofitable overlay — FCFF-based intrinsic value is not meaningful when free " +
          "cash flow is structurally negative",
        "info",
      ),
    );
    return { kind: "dcf-suppressed", route: route.base, multiples, notes, gaps };
  }
  let assumptions: DcfAssumptions | null = null;
  let dcf: DcfResult | null = null;
  let sensitivity: SensitivityGrid | null = null;
  let reverse: ReverseDcfResult | null = null;
  // ADR currency guard (2026-07-09 audit H3): the per-share DCF value is in the
  // statements' reportedCurrency while the price it is graded against is in the
  // quote currency. On a mismatch (e.g. TSM: TWD statements, USD quote) the
  // upside would be off by the FX rate (~+800% for TSM) — suppress the DCF,
  // reverse-DCF and sensitivity grid with a disclosed gap, exactly as the
  // multiples framework flags its currencyMismatch. No FX conversion attempted.
  const dcfIn = inputs.dcfInputs;
  const dcfCurrencyMismatch =
    dcfIn !== null &&
    typeof dcfIn.reportedCurrency === "string" &&
    typeof dcfIn.quoteCurrency === "string" &&
    dcfIn.reportedCurrency.toUpperCase() !== dcfIn.quoteCurrency.toUpperCase();
  // Currency is checked FIRST because it is the root cause, not a symptom: an
  // ADR's WACC is itself suppressed for the same mismatch (the equity weight
  // would divide a quote-currency market cap by a reporting-currency debt
  // balance), so testing `waccPct` first would report the generic "WACC
  // unavailable" and hide the specific, actionable reason from the valuation
  // section entirely.
  if (dcfCurrencyMismatch) {
    notes.push(
      `ADR/currency mismatch: statements in ${dcfIn.reportedCurrency}, quote in ${dcfIn.quoteCurrency} — DCF, sensitivity grid and reverse DCF suppressed ` +
        `(per-share intrinsic value would be in ${dcfIn.reportedCurrency} against a ${dcfIn.quoteCurrency} price; no FX conversion attempted). ` +
        "See multiples (flagged) for relative valuation.",
    );
    gaps.push(
      gapEntry(
        "valuation.dcf.currency",
        `reportedCurrency ${dcfIn.reportedCurrency} != quote currency ${dcfIn.quoteCurrency} (ADR case) — DCF/reverse-DCF suppressed rather than comparing mixed-currency per-share vs price`,
        "critical",
      ),
    );
  } else if (dcfIn === null || !isNum(inputs.waccPct)) {
    gaps.push(
      gapEntry("valuation.dcf", dcfIn === null ? "DCF inputs not provided by caller" : "WACC unavailable — DCF suppressed", "critical"),
    );
  } else {
    const built = buildDcfAssumptions(dcfIn);
    gaps.push(...built.gaps);
    notes.push(...built.notes);
    assumptions = built.assumptions;
    if (assumptions !== null) {
      // WS6 (D-19): the DCF equity bridge follows the SAME lease convention as
      // the multiples EV. Net debt is built from totalDebt, which already
      // contains the lease liabilities, so the default subtracts the OPERATING
      // slice back out and THESIS_EV_INCLUDE_LEASES=1 keeps it. Both bridges
      // are stated.
      // WS6 review (BLOCKER 1): only the OPERATING slice leaves net debt. The
      // finance-lease liability stays, because EBIT and EBITDA are before
      // finance-lease cost and the DCF's FCFF is built on that EBIT.
      const totalLeaseLiability =
        isNum(inputs.leaseLiability) && inputs.leaseLiability !== 0 ? Math.abs(inputs.leaseLiability) : null;
      const leaseLiability =
        isNum(inputs.operatingLeaseLiability) && inputs.operatingLeaseLiability !== 0
          ? Math.abs(inputs.operatingLeaseLiability)
          : null;
      const financeLeaseLiability =
        totalLeaseLiability !== null && leaseLiability !== null
          ? Math.max(0, totalLeaseLiability - leaseLiability)
          : null;
      const includeLeases = inputs.includeLeasesInEv === true;
      const netDebtIncludingLeases = inputs.netDebt;
      const netDebtExcludingLeases =
        isNum(netDebtIncludingLeases) && leaseLiability !== null
          ? netDebtIncludingLeases - leaseLiability
          : netDebtIncludingLeases;
      const netDebtForBridge = includeLeases ? netDebtIncludingLeases : netDebtExcludingLeases;
      if (isNum(netDebtIncludingLeases)) {
        notes.push(
          `DCF equity bridge: EV − net debt − minority interest − preferred equity. ` +
            (leaseLiability === null
              ? totalLeaseLiability === null
                ? "Lease liabilities were not disclosed separately, so they could not be separated from total debt; net debt is used as reported."
                : `A total lease liability of ${fmtNum(totalLeaseLiability)} is disclosed but its operating slice is not, so no lease adjustment was made; net debt is used as reported.`
              : `Net debt as reported ${fmtNum(netDebtIncludingLeases)}; less the OPERATING lease liability ${fmtNum(netDebtExcludingLeases as number)}; ` +
                `${includeLeases ? "KEEPING" : "REMOVING"} the operating-lease liability of ${fmtNum(leaseLiability)} (house default removes it; THESIS_EV_INCLUDE_LEASES=1 keeps it)` +
                (financeLeaseLiability === null || financeLeaseLiability === 0
                  ? ". "
                  : `; the finance-lease liability of ${fmtNum(financeLeaseLiability)} stays in net debt on both bases. `) +
                "Operating-lease cost is inside the EBIT this DCF projects (ASC 842), so its liability is not debt here; finance-lease cost is right-of-use amortisation plus interest, both OUTSIDE that EBIT, so its liability is."),
        );
      }
      const runOpts: DcfRunOptions = {
        waccPct: inputs.waccPct,
        netDebt: netDebtForBridge,
        dilutedShares: inputs.dilutedShares,
        minorityInterest: inputs.minorityInterest ?? null,
        preferred: inputs.preferred ?? null,
      };
      dcf = runDcf(assumptions, runOpts);
      sensitivity = sensitivityGrid(assumptions, runOpts);
      reverse = reverseDcf(inputs.currentPrice, assumptions, runOpts);
      // Hoist the DCF and reverse-DCF model gaps too. The earlier hoist covered
      // only the multiples channel, so a suppressed equity bridge or an
      // unsolvable reverse DCF stayed invisible in the manifest — the same
      // defect, on the model that carries the headline number.
      gaps.push(...dcf.gaps, ...reverse.gaps);
    }
  }
  return { kind: "dcf", route: route.base, assumptions, dcf, sensitivity, reverseDcf: reverse, multiples, notes, gaps };
}
