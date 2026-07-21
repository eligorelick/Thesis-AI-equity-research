/**
 * Stage B — Cash & capital: FCF + conversion, capex intensity/trajectory,
 * maintenance-vs-growth capex heuristic, net debt/EBITDA, interest coverage,
 * SBC ratios, diluted share-count trend, buyback price analysis.
 *
 * Pure, deterministic TypeScript: no network, no DB, no LLM (the application contract §4).
 * Input rows use FMP's exact field names (the provider data contract §2.3/§2.4). Sign quirks
 * honored: capitalExpenditure and commonStockRepurchased are NEGATIVE outflows.
 * FMP zero-for-undisclosed: interestExpense === 0 is treated as null.
 *
 * Missing inputs never throw — partial results + ManifestEntry-compatible gaps.
 * House-rule thresholds are annotated in notes, never silently applied.
 * Full precision returned; round only at display time.
 */

import type { ManifestEntry } from "@/types/core";
import {
  hasIrregularAnnualSpacing,
  isFiniteNumber,
  linearRegressionSlope,
  sortNewestFirst,
  yearsBetweenDates,
} from "@/pipeline/stageB/growth";
import { resolveNetDebt, type NetDebtResolution } from "@/pipeline/stageB/netDebt";

// ---------------------------------------------------------------------------
// Input interfaces — FMP field names (the provider data contract §2.3/§2.4)
// ---------------------------------------------------------------------------

export interface CapitalIncomeRow {
  /** Fiscal period end, ISO yyyy-mm-dd. */
  date: string;
  revenue?: number | null;
  operatingIncome?: number | null;
  ebit?: number | null;
  /** FMP-computed = ebit + D&A; used only as fallback when cash-flow D&A is missing. */
  ebitda?: number | null;
  /** FMP zero-for-undisclosed applies (AAPL artifact) — 0 treated as null here. */
  interestExpense?: number | null;
  netIncome?: number | null;
  weightedAverageShsOutDil?: number | null;
  /** Basic weighted-avg shares — matches marketCap's (undiluted) base for the buyback proxy. */
  weightedAverageShsOut?: number | null;
}

export interface CapitalCashFlowRow {
  /** Fiscal period end, ISO yyyy-mm-dd. */
  date: string;
  netIncome?: number | null;
  depreciationAndAmortization?: number | null;
  stockBasedCompensation?: number | null;
  operatingCashFlow?: number | null;
  /** NEGATIVE in FMP (freeCashFlow = operatingCashFlow + capitalExpenditure). */
  capitalExpenditure?: number | null;
  freeCashFlow?: number | null;
  /** NEGATIVE in FMP (cash outflow). */
  commonStockRepurchased?: number | null;
}

export interface CapitalBalanceRow {
  /** Fiscal period end, ISO yyyy-mm-dd. */
  date: string;
  totalDebt?: number | null;
  /** FMP: netDebt = totalDebt − cash (short-term investments NOT netted). */
  netDebt?: number | null;
  cashAndCashEquivalents?: number | null;
  shortTermInvestments?: number | null;
  cashAndShortTermInvestments?: number | null;
}

/** One row of FMP /stable/historical-market-capitalization. */
export interface MarketCapPoint {
  date: string;
  marketCap: number | null;
}

/** Subset of FMP /stable/quote used here. */
export interface QuoteInput {
  price: number | null;
  /** Unix seconds (FMP quote.timestamp) — provenance only. */
  timestamp?: number | null;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface FcfYearRow {
  date: string;
  fcf: number | null;
  netIncome: number | null;
  /** FCF / net income (fraction). Null when NI ≤ 0 (denominator guard). */
  fcfConversion: number | null;
  note?: string;
}

export interface CapexYearRow {
  date: string;
  /** Absolute capex (positive, currency units). */
  capex: number | null;
  revenue: number | null;
  /** |capex| / revenue × 100. Null when revenue ≤ 0. */
  capexToRevenuePct: number | null;
  /** |capex| / D&A. Null when D&A missing or ≤ 0. */
  capexToDA: number | null;
}

export interface BuybackYearRow {
  date: string;
  /** Dollars spent on buybacks that fiscal year (positive). */
  repurchased: number;
  /** Average daily market cap over the fiscal year (from marketCapHistory). */
  avgMarketCap: number | null;
  /** avgMarketCap / basic weighted-avg shares — the year's average price proxy. */
  avgPriceProxy: number | null;
  /** repurchased / avgPriceProxy — implied shares bought. */
  sharesProxy: number | null;
  note?: string;
}

export interface ShareCountTrend {
  /** Total % change of diluted weighted-average shares over the window (negative = shrinking). */
  trendPct: number | null;
  /** Annualized % change over the actual span. */
  annualizedPct: number | null;
  direction: "buyback" | "dilution" | "flat" | null;
  startDate: string | null;
  endDate: string | null;
  startShares: number | null;
  endShares: number | null;
  actualYears: number | null;
  note?: string;
}

export interface CapitalResult {
  /** Latest statement date used — provenance anchor. */
  asOf: string | null;
  fcf: {
    /** Oldest → newest, up to 5 fiscal years. */
    series: FcfYearRow[];
    latestFcf: number | null;
    latestConversion: number | null;
  };
  capexIntensity: {
    /** Oldest → newest, up to 5 fiscal years. */
    series: CapexYearRow[];
    latestPct: number | null;
    /** Least-squares slope of capex/revenue % per year (trajectory). */
    slopePctPtsPerYear: number | null;
  };
  maintenanceVsGrowthCapex: {
    capexToDALatest: number | null;
    capexToDA5yAvg: number | null;
    /** min(|capex|, D&A) — the heuristic maintenance share. */
    impliedMaintenanceCapex: number | null;
    /** max(0, |capex| − D&A) — the heuristic growth share. */
    impliedGrowthCapex: number | null;
    note: string;
  };
  netDebtToEbitda: {
    value: number | null;
    netDebt: number | null;
    ebitda: number | null;
    asOf: string | null;
    resolution: NetDebtResolution;
    note?: string;
  };
  interestCoverage: {
    /** EBIT / interest expense. Null when interest is 0-as-null or missing. */
    value: number | null;
    ebit: number | null;
    interestExpense: number | null;
    note?: string;
  };
  sbc: {
    latest: number | null;
    /** SBC / revenue × 100. */
    pctOfRevenue: number | null;
    /** SBC / FCF × 100. Null when FCF ≤ 0. */
    pctOfFcf: number | null;
    note?: string;
  };
  shareCount: ShareCountTrend;
  buybackPriceAnalysis: {
    /** Total buyback dollars across analyzed years (positive). */
    totalRepurchased: number;
    /** Dollar-weighted average price-paid proxy across analyzed years. */
    avgPricePaidProxy: number | null;
    currentPrice: number | null;
    /** (currentPrice − avgPricePaidProxy) / avgPricePaidProxy × 100 (positive = bought below today's price). */
    premiumDiscountPct: number | null;
    years: BuybackYearRow[];
    note: string;
  };
  notes: string[];
  gaps: ManifestEntry[];
}

// ---------------------------------------------------------------------------
// House-rule constants
// ---------------------------------------------------------------------------

/** Series depth for FCF/capex/buyback analysis. */
export const CAPITAL_SERIES_MAX_YEARS = 5;
/** Share-count window (years). */
export const SHARE_TREND_WINDOW_YEARS = 5;
/** Total change within ±this % over the window counts as "flat" (house rule). */
export const SHARE_TREND_FLAT_BAND_PCT = 1.0;

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;

const MAINT_CAPEX_HEURISTIC_NOTE =
  "HEURISTIC: maintenance capex approximated by D&A (maintenance = min(|capex|, D&A), growth = max(0, |capex| − D&A)); actual split is not disclosed in standardized statements";

const BUYBACK_HEURISTIC_NOTE =
  "HEURISTIC: assumes shares were repurchased at each fiscal year's average price proxy (average daily market cap ÷ weighted-average diluted shares); actual execution prices are not disclosed";

function fmt(n: number): string {
  return String(Number(n.toFixed(4)));
}

/** FMP zero-for-undisclosed: interest expense of exactly 0 is implausible → null. */
function zeroAsNull(v: number | null | undefined): number | null {
  if (!isFiniteNumber(v)) return null;
  return v === 0 ? null : v;
}

// ---------------------------------------------------------------------------
// computeCapital
// ---------------------------------------------------------------------------

export function computeCapital(
  income: ReadonlyArray<CapitalIncomeRow>,
  cashflow: ReadonlyArray<CapitalCashFlowRow>,
  balance: ReadonlyArray<CapitalBalanceRow>,
  marketCapHistory: ReadonlyArray<MarketCapPoint>,
  quote: QuoteInput,
): CapitalResult {
  const notes: string[] = [];
  const gaps: ManifestEntry[] = [];

  const inc = sortNewestFirst(income);
  const cf = sortNewestFirst(cashflow);
  const bal = sortNewestFirst(balance);

  if (inc.length === 0) {
    gaps.push({
      field: "capital.incomeStatement",
      reason: "no annual income-statement rows provided",
      severity: "critical",
    });
  }
  if (cf.length === 0) {
    gaps.push({
      field: "capital.cashFlow",
      reason: "no annual cash-flow rows provided — FCF/capex/SBC/buyback metrics unavailable",
      severity: "critical",
    });
  }
  if (bal.length === 0) {
    gaps.push({
      field: "capital.balanceSheet",
      reason: "no balance-sheet rows provided — net debt metrics unavailable",
      severity: "warn",
    });
  }

  const asOf = inc[0]?.date ?? cf[0]?.date ?? bal[0]?.date ?? null;
  const incomeByDate = new Map(inc.map((r) => [r.date, r]));

  // --- FCF + conversion ---------------------------------------------------------
  const fcfSeries: FcfYearRow[] = [];
  {
    const rows = cf.slice(0, CAPITAL_SERIES_MAX_YEARS).reverse(); // oldest → newest
    for (const r of rows) {
      const rowNotes: string[] = [];
      let fcf: number | null = null;
      if (isFiniteNumber(r.freeCashFlow)) {
        fcf = r.freeCashFlow;
      } else if (isFiniteNumber(r.operatingCashFlow) && isFiniteNumber(r.capitalExpenditure)) {
        fcf = r.operatingCashFlow + r.capitalExpenditure; // capex negative
        rowNotes.push("FCF derived as operatingCashFlow + capitalExpenditure");
      }
      const ni = isFiniteNumber(r.netIncome)
        ? r.netIncome
        : isFiniteNumber(incomeByDate.get(r.date)?.netIncome)
          ? (incomeByDate.get(r.date)?.netIncome as number)
          : null;
      let conversion: number | null = null;
      if (fcf !== null && ni !== null) {
        if (ni <= 0) {
          rowNotes.push("net income ≤ 0 — FCF conversion not meaningful");
        } else {
          conversion = fcf / ni;
        }
      }
      fcfSeries.push({
        date: r.date,
        fcf,
        netIncome: ni,
        fcfConversion: conversion,
        note: rowNotes.length > 0 ? rowNotes.join("; ") : undefined,
      });
    }
  }
  const latestFcfRow = fcfSeries.length > 0 ? fcfSeries[fcfSeries.length - 1] : null;

  // --- Capex intensity + trajectory ----------------------------------------------
  const capexSeries: CapexYearRow[] = [];
  {
    const rows = cf.slice(0, CAPITAL_SERIES_MAX_YEARS).reverse();
    for (const r of rows) {
      const capexAbs = isFiniteNumber(r.capitalExpenditure) ? Math.abs(r.capitalExpenditure) : null;
      const revenue = incomeByDate.get(r.date)?.revenue;
      const rev = isFiniteNumber(revenue) && revenue > 0 ? revenue : null;
      const da =
        isFiniteNumber(r.depreciationAndAmortization) && r.depreciationAndAmortization > 0
          ? r.depreciationAndAmortization
          : null;
      capexSeries.push({
        date: r.date,
        capex: capexAbs,
        revenue: isFiniteNumber(revenue) ? revenue : null,
        capexToRevenuePct: capexAbs !== null && rev !== null ? (capexAbs / rev) * 100 : null,
        capexToDA: capexAbs !== null && da !== null ? capexAbs / da : null,
      });
    }
  }
  const latestCapexRow = capexSeries.length > 0 ? capexSeries[capexSeries.length - 1] : null;
  const oldestCapexDate = capexSeries[0]?.date;
  const capexSlope = linearRegressionSlope(
    capexSeries.map((p) => ({
      x: oldestCapexDate === undefined ? null : yearsBetweenDates(oldestCapexDate, p.date),
      y: p.capexToRevenuePct,
    })),
  );
  if (capexSlope === null && capexSeries.length > 0) {
    notes.push("capex-intensity slope requires ≥3 non-null annual points (house rule)");
  }
  if (hasIrregularAnnualSpacing(capexSeries.map((p) => p.date))) {
    notes.push("capex-intensity history has irregular fiscal spacing — slope uses actual elapsed fiscal years");
  }

  // --- Maintenance vs growth capex heuristic ---------------------------------------
  let impliedMaintenance: number | null = null;
  let impliedGrowth: number | null = null;
  if (latestCapexRow !== null && latestCapexRow.capex !== null) {
    const latestCf: CapitalCashFlowRow | undefined = cf.length > 0 ? cf[0] : undefined;
    const daRaw = latestCf?.depreciationAndAmortization;
    const da = isFiniteNumber(daRaw) && daRaw > 0 ? daRaw : null;
    if (da !== null) {
      impliedMaintenance = Math.min(latestCapexRow.capex, da);
      impliedGrowth = Math.max(0, latestCapexRow.capex - da);
    } else if (cf.length > 0) {
      gaps.push({
        field: "capital.maintenanceCapex",
        reason: "depreciationAndAmortization missing/≤0 on latest cash-flow row — capex split heuristic unavailable",
        severity: "info",
      });
    }
  }
  const capexToDAValues = capexSeries
    .map((p) => p.capexToDA)
    .filter((v): v is number => isFiniteNumber(v));
  const capexToDA5yAvg =
    capexToDAValues.length > 0
      ? capexToDAValues.reduce((s, v) => s + v, 0) / capexToDAValues.length
      : null;

  // --- Net debt / EBITDA ------------------------------------------------------------
  let netDebtToEbitda: CapitalResult["netDebtToEbitda"] = {
    value: null,
    netDebt: null,
    ebitda: null,
    asOf: null,
    resolution: resolveNetDebt({}),
  };
  {
    const ndNotes: string[] = [];
    const latestBal: CapitalBalanceRow | undefined = bal.length > 0 ? bal[0] : undefined;
    const resolution = resolveNetDebt({
      date: latestBal?.date,
      totalDebt: latestBal?.totalDebt,
      cashAndCashEquivalents: latestBal?.cashAndCashEquivalents,
      shortTermInvestments: latestBal?.shortTermInvestments,
      cashAndShortTermInvestments: latestBal?.cashAndShortTermInvestments,
      vendorNetDebt: latestBal?.netDebt,
    });
    const netDebt = resolution.value;
    ndNotes.push(`${resolution.version}: ${resolution.reason}`);
    // EBITDA: own computation preferred (operatingIncome + cash-flow D&A), vendor fallback noted.
    const latestInc: CapitalIncomeRow | undefined = inc.length > 0 ? inc[0] : undefined;
    const cfMatch = latestInc !== undefined ? cf.find((r) => r.date === latestInc.date) : undefined;
    let ebitda: number | null = null;
    const ebitLatest = latestInc !== undefined
      ? isFiniteNumber(latestInc.operatingIncome)
        ? latestInc.operatingIncome
        : isFiniteNumber(latestInc.ebit)
          ? latestInc.ebit
          : null
      : null;
    if (
      ebitLatest !== null &&
      cfMatch !== undefined &&
      isFiniteNumber(cfMatch.depreciationAndAmortization)
    ) {
      ebitda = ebitLatest + cfMatch.depreciationAndAmortization;
      ndNotes.push("EBITDA computed as operatingIncome + cash-flow D&A (latest FY, not TTM)");
    } else if (latestInc !== undefined && isFiniteNumber(latestInc.ebitda)) {
      ebitda = latestInc.ebitda;
      ndNotes.push("vendor ebitda field used (own operatingIncome + D&A not computable)");
    }
    let value: number | null = null;
    if (netDebt !== null && ebitda !== null) {
      if (ebitda <= 0) {
        ndNotes.push("EBITDA ≤ 0 — net debt/EBITDA not meaningful");
      } else {
        value = netDebt / ebitda;
      }
    } else if (bal.length > 0 || inc.length > 0) {
      gaps.push({
        field: "capital.netDebtToEbitda",
        reason: `missing ${netDebt === null ? "net debt" : "EBITDA"} input`,
        severity: "info",
      });
    }
    netDebtToEbitda = {
      value,
      netDebt,
      ebitda,
      asOf: latestBal?.date ?? null,
      resolution,
      note: ndNotes.length > 0 ? ndNotes.join("; ") : undefined,
    };
  }

  // --- Interest coverage ---------------------------------------------------------------
  let interestCoverage: CapitalResult["interestCoverage"] = {
    value: null,
    ebit: null,
    interestExpense: null,
  };
  {
    const latestInc: CapitalIncomeRow | undefined = inc.length > 0 ? inc[0] : undefined;
    if (latestInc !== undefined) {
      const ebit = isFiniteNumber(latestInc.operatingIncome)
        ? latestInc.operatingIncome
        : isFiniteNumber(latestInc.ebit)
          ? latestInc.ebit
          : null;
      const intRaw = latestInc.interestExpense;
      const intExp = zeroAsNull(intRaw);
      let note: string | undefined;
      let value: number | null = null;
      if (intExp === null) {
        note =
          intRaw === 0
            ? "interestExpense = 0 treated as undisclosed (FMP zero-for-undisclosed) — coverage n/m"
            : "interest expense missing — coverage n/m";
        gaps.push({
          field: "capital.interestCoverage",
          reason: note,
          severity: "info",
        });
      } else if (intExp < 0) {
        note = "negative interest expense (net interest income?) — coverage n/m";
      } else if (ebit !== null) {
        value = ebit / intExp;
      }
      interestCoverage = { value, ebit, interestExpense: intExp, note };
    }
  }

  // --- SBC ratios ------------------------------------------------------------------------
  let sbc: CapitalResult["sbc"] = { latest: null, pctOfRevenue: null, pctOfFcf: null };
  {
    const latestCf: CapitalCashFlowRow | undefined = cf.length > 0 ? cf[0] : undefined;
    if (latestCf !== undefined) {
      const sbcNotes: string[] = [];
      const sbcVal = isFiniteNumber(latestCf.stockBasedCompensation)
        ? latestCf.stockBasedCompensation
        : null;
      if (sbcVal === null) {
        gaps.push({
          field: "capital.sbc",
          reason: "stockBasedCompensation missing on latest cash-flow row",
          severity: "info",
        });
      }
      const revenue = incomeByDate.get(latestCf.date)?.revenue;
      let pctOfRevenue: number | null = null;
      if (sbcVal !== null && isFiniteNumber(revenue) && revenue > 0) {
        pctOfRevenue = (sbcVal / revenue) * 100;
      } else if (sbcVal !== null) {
        sbcNotes.push("revenue missing or ≤ 0 — SBC % of revenue unavailable");
      }
      let pctOfFcf: number | null = null;
      const latestFcf = latestFcfRow?.fcf ?? null;
      if (sbcVal !== null && latestFcf !== null) {
        if (latestFcf <= 0) {
          sbcNotes.push("FCF ≤ 0 — SBC % of FCF not meaningful");
        } else {
          pctOfFcf = (sbcVal / latestFcf) * 100;
        }
      }
      sbc = {
        latest: sbcVal,
        pctOfRevenue,
        pctOfFcf,
        note: sbcNotes.length > 0 ? sbcNotes.join("; ") : undefined,
      };
    }
  }

  // --- Diluted share-count 5y trend ---------------------------------------------------------
  let shareCount: ShareCountTrend = {
    trendPct: null,
    annualizedPct: null,
    direction: null,
    startDate: null,
    endDate: null,
    startShares: null,
    endShares: null,
    actualYears: null,
  };
  {
    const shareRows = inc
      .map((r) => ({ date: r.date, shares: r.weightedAverageShsOutDil }))
      .filter((r): r is { date: string; shares: number } => isFiniteNumber(r.shares) && r.shares > 0);
    if (shareRows.length >= 2) {
      const end = shareRows[0]; // newest
      const startIdx = Math.min(SHARE_TREND_WINDOW_YEARS, shareRows.length - 1);
      const start = shareRows[startIdx];
      let years = startIdx;
      const dateSpan =
        (Date.parse(end.date) - Date.parse(start.date)) / MS_PER_YEAR;
      const trendNotes: string[] = [
        `flat band = ±${SHARE_TREND_FLAT_BAND_PCT}% total change over the window (house rule)`,
      ];
      if (Number.isFinite(dateSpan) && Math.abs(dateSpan - years) > 0.6) {
        trendNotes.push(
          `irregular fiscal spacing: index-implied ${years}y vs date-implied ${fmt(dateSpan)}y — date-based span used`,
        );
        years = dateSpan;
      }
      if (startIdx < SHARE_TREND_WINDOW_YEARS) {
        trendNotes.push(
          `requested ${SHARE_TREND_WINDOW_YEARS}y window, only ${fmt(years)}y of share history available`,
        );
      }
      const trendPct = (end.shares / start.shares - 1) * 100;
      const annualizedPct =
        years > 0 ? (Math.pow(end.shares / start.shares, 1 / years) - 1) * 100 : null;
      const direction: ShareCountTrend["direction"] =
        Math.abs(trendPct) <= SHARE_TREND_FLAT_BAND_PCT
          ? "flat"
          : trendPct < 0
            ? "buyback"
            : "dilution";
      shareCount = {
        trendPct,
        annualizedPct,
        direction,
        startDate: start.date,
        endDate: end.date,
        startShares: start.shares,
        endShares: end.shares,
        actualYears: years,
        note: trendNotes.join("; "),
      };
    } else if (inc.length > 0) {
      gaps.push({
        field: "capital.shareCountTrend",
        reason: "fewer than two periods of weightedAverageShsOutDil — share trend unavailable",
        severity: "warn",
      });
    }
  }

  // --- Buyback price analysis (heuristic) -----------------------------------------------------
  const buybackYears: BuybackYearRow[] = [];
  let totalRepurchased = 0;
  let weightedDollars = 0;
  let weightedShares = 0;
  {
    const mcaps = sortNewestFirst(
      marketCapHistory.filter((p): p is { date: string; marketCap: number } =>
        isFiniteNumber(p.marketCap),
      ),
    );
    const rows = cf.slice(0, CAPITAL_SERIES_MAX_YEARS); // newest first
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      const repurchased =
        isFiniteNumber(r.commonStockRepurchased) && r.commonStockRepurchased < 0
          ? -r.commonStockRepurchased
          : 0;
      if (repurchased <= 0) continue;
      totalRepurchased += repurchased;

      // Fiscal window: (previous row date, this row date]; oldest row falls back to date − 1y.
      const endMs = Date.parse(r.date);
      const prevDate = i + 1 < cf.length ? cf[i + 1].date : null;
      const startMs = prevDate !== null ? Date.parse(prevDate) : endMs - MS_PER_YEAR;
      const inWindow = mcaps.filter((p) => {
        const t = Date.parse(p.date);
        return Number.isFinite(t) && t > startMs && t <= endMs;
      });
      const avgMarketCap =
        inWindow.length > 0
          ? inWindow.reduce((s, p) => s + p.marketCap, 0) / inWindow.length
          : null;
      // Recover the average price from marketCap. FMP marketCap = price × shares
      // OUTSTANDING (a basic/actual base), so divide by BASIC weighted-avg shares;
      // DILUTED (≥ basic) would inflate the denominator and understate the price
      // paid — flattering buyback timing. Fall back to diluted only when basic is
      // absent (no worse than the previous behaviour), and disclose it.
      const incRow = incomeByDate.get(r.date);
      const sharesBasic = incRow?.weightedAverageShsOut;
      const sharesDiluted = incRow?.weightedAverageShsOutDil;
      const hasBasic = isFiniteNumber(sharesBasic) && sharesBasic > 0;
      const usedDilutedFallback = !hasBasic && isFiniteNumber(sharesDiluted) && sharesDiluted > 0;
      const shares = hasBasic ? sharesBasic : sharesDiluted;
      const rowNotes: string[] = [];
      let avgPriceProxy: number | null = null;
      let sharesProxy: number | null = null;
      if (avgMarketCap === null) {
        rowNotes.push("no market-cap history inside the fiscal window");
      } else if (!isFiniteNumber(shares) || shares <= 0) {
        rowNotes.push("basic/diluted weighted-avg shares missing — price proxy unavailable");
      } else {
        if (usedDilutedFallback) {
          rowNotes.push("basic shares missing — used diluted (slightly understates the price paid)");
        }
        avgPriceProxy = avgMarketCap / shares;
        sharesProxy = repurchased / avgPriceProxy;
        weightedDollars += repurchased;
        weightedShares += sharesProxy;
      }
      buybackYears.push({
        date: r.date,
        repurchased,
        avgMarketCap,
        avgPriceProxy,
        sharesProxy,
        note: rowNotes.length > 0 ? rowNotes.join("; ") : undefined,
      });
    }
    buybackYears.reverse(); // oldest → newest for display consistency
  }
  const avgPricePaidProxy = weightedShares > 0 ? weightedDollars / weightedShares : null;
  const currentPrice = isFiniteNumber(quote.price) && quote.price > 0 ? quote.price : null;
  if (currentPrice === null && totalRepurchased > 0) {
    gaps.push({
      field: "capital.buybackPriceAnalysis",
      reason: "current quote price missing — buyback premium/discount unavailable",
      severity: "info",
    });
  }
  const premiumDiscountPct =
    avgPricePaidProxy !== null && avgPricePaidProxy > 0 && currentPrice !== null
      ? ((currentPrice - avgPricePaidProxy) / avgPricePaidProxy) * 100
      : null;
  if (avgPricePaidProxy !== null && weightedDollars < totalRepurchased) {
    notes.push(
      `buyback price proxy covers ${fmt((weightedDollars / totalRepurchased) * 100)}% of buyback dollars (some years lack market-cap/share data)`,
    );
  }

  return {
    asOf,
    fcf: {
      series: fcfSeries,
      latestFcf: latestFcfRow?.fcf ?? null,
      latestConversion: latestFcfRow?.fcfConversion ?? null,
    },
    capexIntensity: {
      series: capexSeries,
      latestPct: latestCapexRow?.capexToRevenuePct ?? null,
      slopePctPtsPerYear: capexSlope,
    },
    maintenanceVsGrowthCapex: {
      capexToDALatest: latestCapexRow?.capexToDA ?? null,
      capexToDA5yAvg,
      impliedMaintenanceCapex: impliedMaintenance,
      impliedGrowthCapex: impliedGrowth,
      note: MAINT_CAPEX_HEURISTIC_NOTE,
    },
    netDebtToEbitda,
    interestCoverage,
    sbc,
    shareCount,
    buybackPriceAnalysis: {
      totalRepurchased,
      avgPricePaidProxy,
      currentPrice,
      premiumDiscountPct,
      years: buybackYears,
      note: BUYBACK_HEURISTIC_NOTE,
    },
    notes,
    gaps,
  };
}
