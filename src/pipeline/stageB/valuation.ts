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
import { metricPolicy } from "@/pipeline/stageB/sectorRouting";
import { linearRegressionSlope, yearsBetweenDates } from "@/pipeline/stageB/growth";

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
export const REVERSE_ROE_RANGE_PCT: readonly [number, number] = [0, 40];
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

/** Balance-sheet slice used by the DCF builder (FMP field names). */
export interface DcfBalanceRow {
  date: string;
  totalDebt: number | null;
  totalStockholdersEquity: number | null;
  cashAndShortTermInvestments: number | null;
}

export interface DcfAssumptionInputs {
  /** 3y revenue CAGR in percent (computed upstream from statements); null when unavailable. */
  revenueCagr3yPct: number | null;
  /** 5y revenue CAGR in percent — used only for the conservatism cross-check. */
  revenueCagr5yPct?: number | null;
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
  /** Latest balance sheet (FMP names) for sales-to-capital. */
  balance: DcfBalanceRow | null;
  marketCap: number | null;
}

export interface DcfAssumptions {
  startRevenue: Assumption<number>;
  /** Explicit horizon (default 10). */
  years: number;
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

  // --- Near-term growth: analyst 2y avg if available, else 3y CAGR ---------
  const analyst = analystTwoYearGrowthPct(inputs.analystEstimates, startRev, ttm?.date ?? null);
  notes.push(...analyst.notes);
  let g1: number;
  let g1Basis: string;
  if (analyst.value !== null) {
    g1 = analyst.value;
    g1Basis = `analyst consensus revenue, avg implied growth over next 2 fiscal years (through ${analyst.asOf ?? "?"})`;
  } else if (isNum(inputs.revenueCagr3yPct)) {
    g1 = inputs.revenueCagr3yPct;
    g1Basis = "3y historical revenue CAGR (no analyst estimates available)";
    if (isNum(inputs.revenueCagr5yPct) && Math.abs(inputs.revenueCagr3yPct - inputs.revenueCagr5yPct) > 5) {
      const smaller = Math.min(inputs.revenueCagr3yPct, inputs.revenueCagr5yPct);
      notes.push(
        `3y CAGR ${fmtNum(inputs.revenueCagr3yPct)}% vs 5y CAGR ${fmtNum(inputs.revenueCagr5yPct)}% differ by >5pp — took smaller ${fmtNum(smaller)}% (house rule: conservatism against re-acceleration)`,
      );
      g1 = smaller;
      g1Basis = "min(3y, 5y) historical revenue CAGR (>5pp divergence, conservatism house rule)";
    }
    gaps.push(
      gapEntry("valuation.dcf.analystGrowth", "no usable analyst revenue estimates — fell back to historical CAGR", "info"),
    );
  } else {
    gaps.push(
      gapEntry(
        "valuation.dcf.nearTermGrowth",
        "neither analyst estimates nor 3y revenue CAGR available — DCF growth path not buildable",
        "critical",
      ),
    );
    return { assumptions: null, notes, gaps };
  }
  g1 = clampWithNote(g1, NEAR_TERM_GROWTH_CLAMP_PP[0], NEAR_TERM_GROWTH_CLAMP_PP[1], "near-term growth (pct)", notes);

  // --- Terminal growth: min(2.5, rf) — Damodaran g <= rf rule --------------
  const gTerm = Math.min(TERMINAL_G_CAP_PCT, inputs.riskFreePct);
  const gTermBasis = `min(${TERMINAL_G_CAP_PCT}%, risk-free ${fmtNum(inputs.riskFreePct)}%) — house rule: nothing grows faster than rf forever`;
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
  if (ic === null || ic <= 0) {
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
  const s2cBasis = `${periodBasis} revenue / invested capital (totalDebt + totalStockholdersEquity - cashAndShortTermInvestments, as of ${bal?.date ?? "?"})`;

  // --- Terminal economics ----------------------------------------------------
  const roicTerm = inputs.waccPct;
  const reinvestRate = roicTerm > 0 ? gTerm / roicTerm : 0;

  const assumptions: DcfAssumptions = {
    startRevenue: { value: startRev, basis: `${periodBasis} revenue as of ${ttm?.date ?? "?"}` },
    years,
    growthPath: {
      value: growthPath,
      basis: `linear fade from ${fmtNum(g1)}% (${g1Basis}) to terminal ${fmtNum(gTerm)}% by year ${years}`,
    },
    ebitMarginPath: { value: marginPath, basis: marginBasis },
    taxRatePath: { value: taxRatePath, basis: taxBasis },
    salesToCapital: { value: s2c, basis: s2cBasis },
    terminal: {
      gTermPct: { value: gTerm, basis: gTermBasis },
      roicTermPct: { value: roicTerm, basis: "terminal ROIC = WACC (zero excess returns in perpetuity, house-rule default)" },
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
  for (let t = 1; t <= n; t++) {
    const g = growth[t - 1];
    const m = margins[t - 1];
    const tax = taxes[t - 1];
    const prev = rev;
    rev = prev * (1 + g / 100);
    const ebit = rev * (m / 100);
    const nopat = ebit * (1 - tax / 100);
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
      taxRatePct: tax,
      nopat,
      reinvestment,
      fcff,
      discountFactor,
      pv,
    });
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
  const nopatN1 = rev * (1 + gTerm / 100) * (marginTerm / 100) * (1 - taxTerm / 100);
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
}

/** Quarterly fundamentals merged per quarter by the caller (FMP names). */
export interface QuarterlyFundamentalsRow {
  date: string;
  revenue: number | null;
  operatingIncome: number | null;
  depreciationAndAmortization: number | null;
  netIncome: number | null;
  operatingCashFlow: number | null;
  capitalExpenditure: number | null;
  totalStockholdersEquity: number | null;
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
}

export interface OwnHistoryBand {
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

/** Rolling-4-quarter TTM multiples derived from raw statements + EV history. */
function deriveOwnHistory(
  quarters: QuarterlyFundamentalsRow[] | undefined,
  evRows: EnterpriseValuesRow[] | undefined,
): { series: HistorySeries; observations: number } {
  const series: HistorySeries = {};
  if (!quarters || quarters.length < 4 || !evRows || evRows.length === 0) {
    return { series, observations: 0 };
  }
  const qs = quarters.slice().sort((a, b) => b.date.localeCompare(a.date));
  const evByTime = evRows
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((r) => ({ t: Date.parse(r.date), row: r }));
  const push = (k: MultipleKey, v: number | null): void => {
    if (v !== null && v > 0) (series[k] ??= []).push(v);
  };
  const maxObs = Math.min(20, qs.length - 3);
  let observations = 0;
  for (let i = 0; i < maxObs; i++) {
    const window = qs.slice(i, i + 4);
    if (window.length < 4) break;
    const anchor = Date.parse(qs[i].date);
    if (!Number.isFinite(anchor)) continue;
    // Nearest EV row within 45 days of the quarter end.
    let ev: EnterpriseValuesRow | null = null;
    let best = Infinity;
    for (const { t, row } of evByTime) {
      const d = Math.abs(t - anchor);
      if (Number.isFinite(t) && d < best && d <= 45 * 86_400_000) {
        best = d;
        ev = row;
      }
    }
    if (!ev) continue;
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
    const ttmFcf = sum((r) =>
      isNum(r.operatingCashFlow) && isNum(r.capitalExpenditure)
        ? r.operatingCashFlow + r.capitalExpenditure // capex is negative in FMP
        : null,
    );
    const equity = qs[i].totalStockholdersEquity;
    let counted = false;
    const evVal = ev.enterpriseValue;
    const mcap = ev.marketCapitalization;
    const consider = (k: MultipleKey, v: number | null): void => {
      if (v !== null && v > 0) {
        push(k, v);
        counted = true;
      }
    };
    consider("evToSales", safeDiv(evVal, ttmRev));
    consider("evToEbitda", safeDiv(evVal, posOrNull(ttmEbitda)));
    consider("peTtm", safeDiv(mcap, posOrNull(ttmNi)));
    consider("priceToFcf", safeDiv(mcap, posOrNull(ttmFcf)));
    consider("priceToBook", safeDiv(mcap, posOrNull(equity)));
    if (counted) observations++;
  }
  return { series, observations };
}

/** Vendor pre-baked history mapped to our multiple keys. */
function vendorHistory(rows: VendorMultiplesRow[] | undefined): HistorySeries {
  const series: HistorySeries = {};
  if (!rows) return series;
  const push = (k: MultipleKey, v: number | null | undefined): void => {
    if (isNum(v) && v > 0) (series[k] ??= []).push(v);
  };
  for (const r of rows.slice(0, 20)) {
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
  const notedBasis = lowSample
    ? `${basis} — LOW SAMPLE (${values.length} quarters < 5y): p5/p95 track the tail observations (≈ observed range), not stable percentiles`
    : basis;
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
  const fcf =
    isNum(cf?.operatingCashFlow) && isNum(cf?.capitalExpenditure)
      ? cf.operatingCashFlow + cf.capitalExpenditure // FMP capex is negative
      : null;
  const equity = bal?.totalStockholdersEquity ?? null;
  const tbv =
    isNum(equity) && isNum(bal?.goodwill) && isNum(bal?.intangibleAssets)
      ? equity - bal.goodwill - bal.intangibleAssets
      : null;
  const ev =
    mcap !== null && bal && isNum(bal.totalDebt) && isNum(bal.cashAndShortTermInvestments)
      ? mcap +
        bal.totalDebt +
        (isNum(bal.preferredStock) ? bal.preferredStock : 0) +
        (isNum(bal.minorityInterest) ? bal.minorityInterest : 0) -
        bal.cashAndShortTermInvestments
      : null;
  if (ev === null) {
    gaps.push(gapEntry("valuation.multiples.enterpriseValue", "EV components missing (marketCap/totalDebt/cash) — EV multiples n/m", "info"));
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

  // --- Own-history bands ------------------------------------------------------
  const derived = deriveOwnHistory(inputs.quarterlyFundamentals, inputs.enterpriseValuesHistory);
  let history: HistorySeries;
  let historyBasis: string;
  if (derived.observations >= MIN_HISTORY_OBS_FOR_BAND) {
    history = derived.series;
    historyBasis = `per-quarter TTM multiples derived from raw statements + enterprise-values history (${derived.observations} quarters)`;
  } else if (!currencyMismatch && (inputs.keyMetricsHistory?.length ?? 0) > 0) {
    history = vendorHistory(inputs.keyMetricsHistory);
    historyBasis = "vendor pre-baked ratio history (FMP key-metrics/ratios quarterly) — derivation from raw statements not possible";
    notes.push("own-history bands built from vendor pre-baked multiples (raw derivation unavailable)");
  } else {
    history = {};
    historyBasis = "no usable multiple history";
    if (currencyMismatch && (inputs.keyMetricsHistory?.length ?? 0) > 0) {
      notes.push("vendor pre-baked multiple history skipped: currency mismatch (ADR) makes it untrustworthy");
    }
    gaps.push(gapEntry("valuation.multiples.ownHistory", `insufficient history (need ≥${MIN_HISTORY_OBS_FOR_BAND} quarters) to build own-history percentile bands (up to 5y)`, "info"));
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
    evToEbitda: `EV (mcap + totalDebt + preferred + minority - cash&STI, ${balanceBasisLabel}) / (operatingIncome + D&A), ${incomeBasisLabel}-computed — vendor ebitda field not trusted`,
    evToSales: `EV / revenue (${incomeBasisLabel})`,
    priceToFcf: `marketCap / (operatingCashFlow + capitalExpenditure) (${cashFlowBasisLabel}; FMP capex negative)`,
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
      ownHistory: bandFor(history[key], cur, historyBasis),
      peers: peerStats((inputs.peers ?? []).map((p) => p.multiples[key]), notes, key),
    };
  });
  // Negative denominators were already nulled via posOrNull; belt-and-braces:
  for (const m of multiples) {
    if (m.current !== null && m.current <= 0) {
      m.current = null;
      notes.push(`${m.key}: negative/zero multiple rendered n/m`);
    }
  }

  return {
    multiples,
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
  /** TTM ROE, percent. */
  currentRoePct: number | null;
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
}

export interface ExcessReturnResult {
  equityValue: number | null;
  perShare: number | null;
  /** equityValue / BV0 — sanity anchor vs (ROE - g)/(CoE - g). */
  impliedPToBv: number | null;
  roePathPct: Assumption<number[]>;
  payoutRatioPct: Assumption<number | null>;
  /** BV_0 .. BV_N under retention compounding. */
  bookValuePath: number[];
  /**
   * Year-N economic profit in currency: (ROE_N − CoE) · BV_{N-1}. Zero when ROE
   * fades to CoE (the default); nonzero only when a caller overrides the terminal
   * ROE via analystImpliedRoePct. Computed, never assumed.
   */
  terminalExcess: number | null;
  reverseSolve: { impliedSteadyRoePct: number | null; notes: string[] };
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
    bv = bv * (1 + roe * retention);
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
export function excessReturnModel(inputs: ExcessReturnInputs): ExcessReturnResult {
  const notes: string[] = [];
  const gaps: ManifestEntry[] = [];
  const years = inputs.years ?? EXCESS_RETURN_YEARS;
  const reverseNotes: string[] = [];

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
      terminalExcess: null,
      reverseSolve: { impliedSteadyRoePct: null, notes: ["skipped: no cost of equity"] },
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
      terminalExcess: null,
      reverseSolve: { impliedSteadyRoePct: null, notes: ["skipped: no book value"] },
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
      terminalExcess: null,
      reverseSolve: { impliedSteadyRoePct: null, notes: ["skipped: no payout history"] },
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
      terminalExcess: null,
      reverseSolve: { impliedSteadyRoePct: null, notes: ["skipped: no current ROE"] },
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
  const roeBasis = `linear fade from TTM ROE ${fmtNum(roeStart)}% to ${endBasis} by year ${years}`;
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

  // Reverse solve: constant steady-state ROE matching market cap (monotone in ROE).
  let impliedSteadyRoePct: number | null = null;
  const mcap = posOrNull(inputs.marketCap);
  if (mcap === null) {
    reverseNotes.push("skipped: market cap not provided");
  } else {
    const [lo, hi] = REVERSE_ROE_RANGE_PCT;
    const f = (roe: number): number =>
      excessReturnValue(bv0, Array.from({ length: years }, () => roe), coe, payout).equityValue - mcap;
    const fLo = f(lo);
    const fHi = f(hi);
    if (fLo > 0) {
      reverseNotes.push(`market cap below the ${lo}% ROE value — implied steady-state ROE < ${lo}%`);
    } else if (fHi < 0) {
      reverseNotes.push(`market cap above the ${hi}% ROE value — implied steady-state ROE > ${hi}% (price not justifiable on book returns)`);
    } else {
      const root = bisect(f, { lo, hi, fLo, fHi }, mcap);
      impliedSteadyRoePct = root;
      if (root !== null) {
        reverseNotes.push(`constant ROE over ${years} years (payout ${fmtNum(payout)}%, CoE ${fmtNum(coe)}%) matching market cap`);
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
  return {
    equityValue,
    perShare,
    impliedPToBv,
    roePathPct: { value: roePath, basis: roeBasis },
    payoutRatioPct: { value: payout, basis: payoutBasis },
    bookValuePath,
    terminalExcess,
    reverseSolve: { impliedSteadyRoePct, notes: reverseNotes },
    asOf: inputs.asOf ?? null,
    notes,
    gaps,
  };
}

// ---------------------------------------------------------------------------
// REIT valuation (P/FFO, P/AFFO, implied cap rate sketch)
// ---------------------------------------------------------------------------

export interface ReitInputs {
  /** FFO approx = netIncome + D&A (labeled approximate upstream). */
  ffoApprox: number | null;
  /** AFFO rough = FFO - |capex| (treats all capex as maintenance). */
  affoApprox: number | null;
  sharePrice: number | null;
  shares: number | null;
  netDebt: number | null;
  /** NOI approx = operatingIncome + D&A, when derivable. */
  noiApprox?: number | null;
  asOf?: string | null;
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
  notes: string[];
  gaps: ManifestEntry[];
}

/**
 * REIT valuation block: P/FFO + P/AFFO + implied-cap-rate sketch. Every value
 * is approximate by construction (FMP lacks gains-on-sale / maintenance-capex
 * / straight-line-rent lines) and labeled as such.
 */
export function reitValuation(inputs: ReitInputs): ReitValuationResult {
  const notes: string[] = [
    "FFO (approx.) = netIncome + D&A — gains on property sales / RE impairments not netted (FMP lacks the lines)",
    "AFFO (rough) = FFO - |capex| — treats ALL capex as maintenance (conservative)",
  ];
  const gaps: ManifestEntry[] = [];
  const price = posOrNull(inputs.sharePrice);
  const shares = posOrNull(inputs.shares);
  const mcap = price !== null && shares !== null ? price * shares : null;
  if (mcap === null) {
    gaps.push(gapEntry("valuation.reit.marketCap", "share price or share count missing", "warn"));
  }
  const ffo = posOrNull(inputs.ffoApprox);
  const affo = posOrNull(inputs.affoApprox);
  if (ffo === null) {
    gaps.push(gapEntry("valuation.reit.ffo", "FFO (approx.) missing or non-positive — P/FFO n/m", "warn"));
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

  if (route.base === "bank" || route.base === "insurer" || route.base === "reit-mortgage") {
    notes.push("FCFF DCF and FCFF reverse-DCF suppressed for financials (debt is raw material) — excess-return model used");
    if (route.base === "reit-mortgage") {
      notes.push("mortgage REIT routed to the book-value (excess-return) map per SPEC §6");
    }
    const er = inputs.excessReturn
      ? excessReturnModel(inputs.excessReturn)
      : excessReturnModel({ bookValue: null, currentRoePct: null, costOfEquityPct: null });
    if (!inputs.excessReturn) {
      gaps.push(gapEntry("valuation.excessReturn", "excess-return inputs not provided by caller", "critical"));
    }
    // Hoist model-level gaps (CoE/bookValue/payout/ROE suppression, …) so
    // they reach the merged manifest, mirroring the general branch's
    // gaps.push(...built.gaps) — otherwise a suppressed model is invisible in
    // the report appendix.
    gaps.push(...er.gaps);
    return { kind: "excess-return", route: route.base, excessReturn: er, multiples, notes, gaps };
  }

  if (route.base === "reit") {
    notes.push("FCFF DCF suppressed for equity REITs — P/FFO / P/AFFO + cap-rate sketch used (all approximate)");
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
  if (dcfIn === null || !isNum(inputs.waccPct)) {
    gaps.push(
      gapEntry("valuation.dcf", dcfIn === null ? "DCF inputs not provided by caller" : "WACC unavailable — DCF suppressed", "critical"),
    );
  } else if (dcfCurrencyMismatch) {
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
  } else {
    const built = buildDcfAssumptions(dcfIn);
    gaps.push(...built.gaps);
    notes.push(...built.notes);
    assumptions = built.assumptions;
    if (assumptions !== null) {
      const runOpts: DcfRunOptions = {
        waccPct: inputs.waccPct,
        netDebt: inputs.netDebt,
        dilutedShares: inputs.dilutedShares,
        minorityInterest: inputs.minorityInterest ?? null,
        preferred: inputs.preferred ?? null,
      };
      dcf = runDcf(assumptions, runOpts);
      sensitivity = sensitivityGrid(assumptions, runOpts);
      reverse = reverseDcf(inputs.currentPrice, assumptions, runOpts);
    }
  }
  return { kind: "dcf", route: route.base, assumptions, dcf, sensitivity, reverseDcf: reverse, multiples, notes, gaps };
}
