/**
 * Stage B — sector routing, composable overlays, metric policy and the
 * report-degradation plan.
 *
 * PURE, deterministic TypeScript: no network, no db, no LLM. Inputs are plain
 * typed rows whose field names mirror FMP exactly (the provider data contract §2.2/§2.3):
 * profile {sector, industry, isAdr, isEtf, isFund, ipoDate, country, currency},
 * statement rows {date, revenue, netIncome, operatingCashFlow,
 * capitalExpenditure, cashAndCashEquivalents, shortTermInvestments,
 * cashAndShortTermInvestments, weightedAverageShsOutDil}.
 *
 * Routing evidence and rules: the sector-routing methodology §1 (industry-prefix
 * matching FIRST, case-insensitive, trimmed; SIC fallback; overlays compose),
 * the application contract §6 (route table incl. hard suppressions) and §13.7 (unprofitable /
 * pre-revenue house rules).
 *
 * Contract rules honored here:
 * - Missing inputs NEVER throw — partial results + ManifestEntry gaps.
 *   (TypeError is thrown only for programming errors, e.g. unparseable
 *   `opts.today`, matching the provider-module convention.)
 * - Every house-rule threshold is annotated in a returned notes array.
 * - Full precision returned; rounding is a display concern.
 */

import type {
  CompanyRoute,
  ManifestEntry,
  SectorOverlay,
  SectorRoute,
} from "@/types/core";

// ---------------------------------------------------------------------------
// House-rule constants (every one of these is annotated in returned notes)
// ---------------------------------------------------------------------------

/** Pre-revenue overlay floor: TTM revenue below this → pre-revenue (SPEC §13.7). */
export const PRE_REVENUE_TTM_REVENUE_FLOOR_USD = 10_000_000;

/** Recent-IPO overlay: ipoDate within this many months of `today` (SPEC §6). */
export const RECENT_IPO_WINDOW_MONTHS = 24;

/** Recent-IPO overlay: fewer than this many quarterly statements (SPEC §6). */
export const RECENT_IPO_MIN_QUARTERS = 8;

/** Burn rate is averaged over at most this many most-recent quarters. */
export const BURN_WINDOW_MAX_QUARTERS = 4;

/** Calendar days per quarter used for exhaustion-date math (365.25 / 4). */
export const DAYS_PER_QUARTER = 365.25 / 4;

/** Dilution context looks back ~2 years (in days) of share-count history. */
export const DILUTION_LOOKBACK_DAYS = 730;

/** Relative-strength benchmark for every route. */
export const SPY_BENCHMARK = "SPY";

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Input interfaces (integration agent wires the DataBundle into these)
// ---------------------------------------------------------------------------

/** Routing slice of FMP `/stable/profile` (field names exactly as FMP names them). */
export interface RoutingProfile {
  sector: string | null;
  industry: string | null;
  isAdr: boolean | null;
  isEtf: boolean | null;
  isFund: boolean | null;
  /** ISO date, e.g. "1980-12-12". */
  ipoDate: string | null;
  country: string | null;
  currency: string | null;
  /**
   * Optional SIC fallback (FMP `sec-profile.sicCode` / `all-industry-classification`
   * or EDGAR submissions `sic`). Used only when the industry string gives no match.
   */
  sic?: string | null;
}

/** Minimal income-statement row (FMP field names). `date` = fiscal period end. */
export interface RoutingIncomeRow {
  date?: string | null;
  revenue: number | null;
  netIncome: number | null;
}

/** Minimal cash-flow row (FMP field names). */
export interface RoutingCashflowRow {
  date?: string | null;
  operatingCashFlow: number | null;
}

/** Latest statements needed for overlay evaluation. */
export interface RoutingStatements {
  /** FMP `/stable/income-statement-ttm` row (or 4-quarter sum), null when unavailable. */
  incomeTtm: RoutingIncomeRow | null;
  /** Latest FY income statement row — fallback basis when TTM is unavailable. */
  incomeAnnual: RoutingIncomeRow | null;
  cashflowTtm: RoutingCashflowRow | null;
  cashflowAnnual: RoutingCashflowRow | null;
  /** Count of quarterly income-statement rows available (history depth), null if unknown. */
  availableQuarters: number | null;
}

export interface RouteOptions {
  /** ISO date used for IPO-recency math — passed in for determinism. */
  today: string;
}

/** routeCompany result: a CompanyRoute plus provenance, notes and gap entries. */
export interface CompanyRouteResult extends CompanyRoute {
  /** House-rule annotations and routing rationale (rendered in the appendix). */
  notes: string[];
  /** ManifestEntry-compatible gap descriptions for anything not evaluable. */
  gaps: ManifestEntry[];
  /** As-of dates of the inputs that drove overlay decisions. */
  asOf: {
    today: string;
    incomeTtm: string | null;
    incomeAnnual: string | null;
    cashflowTtm: string | null;
    cashflowAnnual: string | null;
  };
}

// ---------------------------------------------------------------------------
// Date helpers (UTC, deterministic)
// ---------------------------------------------------------------------------

function parseIsoDateUtc(iso: string | null | undefined): number | null {
  if (typeof iso !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? t : null;
}

function addMonthsUtc(ms: number, months: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate());
}

function isoDateFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function normStr(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/** Parse a leading 4-digit SIC code out of "6021" or "6021 NATIONAL COMMERCIAL BANKS". */
function parseSic(sic: string | null): number | null {
  if (sic === null) return null;
  const m = /^(\d{4})/.exec(sic.trim());
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// routeCompany — base route (industry-prefix FIRST) + composable overlays
// ---------------------------------------------------------------------------

export function routeCompany(
  profile: RoutingProfile,
  statements: RoutingStatements,
  opts: RouteOptions,
): CompanyRouteResult {
  const todayMs = parseIsoDateUtc(opts.today);
  if (todayMs === null) {
    throw new TypeError(`routeCompany: opts.today is not an ISO date: "${opts.today}"`);
  }

  const notes: string[] = [];
  const gaps: ManifestEntry[] = [];

  const sectorRaw = normStr(profile.sector);
  const industryRaw = normStr(profile.industry);
  const sicRaw = normStr(profile.sic ?? null);
  const sectorLc = sectorRaw?.toLowerCase() ?? null;
  const industryLc = industryRaw?.toLowerCase() ?? null;

  // ---- base route: industry-prefix matching FIRST, case-insensitive, trimmed
  let base: SectorRoute = "general";
  let baseMatched = false;

  if (profile.isEtf === true || profile.isFund === true) {
    notes.push(
      "profile.isEtf/isFund is true — funds/ETFs are out of scope for company routing " +
        "(the sector-routing methodology §1.3); no company report should be generated.",
    );
    gaps.push({
      field: "route.base",
      reason: "instrument is an ETF/fund — the company report pipeline does not support funds",
      severity: "critical",
    });
    baseMatched = true; // deliberate: skip further matching
  } else if (industryLc !== null && industryLc.startsWith("banks")) {
    base = "bank";
    baseMatched = true;
  } else if (industryLc !== null && industryLc.startsWith("insurance")) {
    if (industryLc.includes("broker")) {
      // Insurance brokers (Marsh, Aon, AJG) are fee-based, NOT balance-sheet
      // businesses, so EBITDA margins / EV-EBITDA / organic growth are valid and
      // the insurer map's EV/EBITDA suppression would wrongly hide them. Route to
      // GENERAL per the sector-routing methodology §3 ("Brokers → route to GENERAL map").
      base = "general";
      baseMatched = true;
      notes.push(
        "industry 'Insurance - Brokers' routed to the GENERAL map (not insurer): brokers are " +
          "fee-based, not balance-sheet businesses, so EBITDA-margin / EV-EBITDA / organic-growth " +
          "metrics are valid (the sector-routing methodology §3).",
      );
    } else {
      base = "insurer";
      baseMatched = true;
    }
  } else if (industryLc !== null && industryLc.startsWith("reit")) {
    base = industryLc.includes("mortgage") ? "reit-mortgage" : "reit";
    baseMatched = true;
    if (base === "reit-mortgage") {
      notes.push(
        "mortgage REIT routed to the book-value submap (P/B, dividend yield, spread, leverage) — " +
          "FFO/NOI largely irrelevant (the sector-routing methodology §4).",
      );
    }
  } else {
    // SIC fallback — only when the industry string gave no match.
    const sic = parseSic(sicRaw);
    if (sic !== null && sic >= 6020 && sic <= 6199) {
      base = "bank";
      baseMatched = true;
      notes.push(`base route 'bank' from SIC ${sicRaw} (6020–6199) — industry string gave no match.`);
    } else if (sic !== null && sic >= 6300 && sic <= 6499) {
      base = "insurer";
      baseMatched = true;
      notes.push(`base route 'insurer' from SIC ${sicRaw} (6300–6499) — industry string gave no match.`);
    } else if (sic === 6798) {
      base = "reit";
      baseMatched = true;
      notes.push(
        `base route 'reit' from SIC ${sicRaw} (6798) — mortgage-REIT submap cannot be determined ` +
          "from SIC alone; routed to the equity-REIT map.",
      );
    } else if (sectorLc === "financial services" || sectorLc === "financial") {
      base = "general";
      baseMatched = true;
      notes.push(
        "sector 'Financial Services' without a bank/insurance/REIT industry — routed to the general " +
          "map (FIN-OTHER treatment: book-value-tilted, NOT the bank map; the sector-routing methodology §1.3).",
      );
    }
  }

  if (!baseMatched && sectorRaw === null && industryRaw === null) {
    gaps.push({
      field: "route.base",
      reason:
        "profile.sector and profile.industry missing and SIC unavailable/unmatched — defaulted to the general map",
      severity: "warn",
      attemptedSources: ["fmp:/stable/profile", "edgar:submissions.sic"],
    });
  }

  // ---- overlays (composable, evaluated independently; fixed output order)
  const overlays: SectorOverlay[] = [];

  // unprofitable: TTM netIncome < 0 OR TTM operatingCashFlow < 0
  let niBasis: "ttm" | "annual" | null = null;
  let ni: number | null = null;
  if (statements.incomeTtm && statements.incomeTtm.netIncome !== null) {
    ni = statements.incomeTtm.netIncome;
    niBasis = "ttm";
  } else if (statements.incomeAnnual && statements.incomeAnnual.netIncome !== null) {
    ni = statements.incomeAnnual.netIncome;
    niBasis = "annual";
    notes.push(
      "TTM net income unavailable — unprofitable overlay evaluated on the latest annual net income" +
        (statements.incomeAnnual.date ? ` (as of ${statements.incomeAnnual.date})` : "") +
        ".",
    );
  }

  let ocfBasis: "ttm" | "annual" | null = null;
  let ocf: number | null = null;
  if (statements.cashflowTtm && statements.cashflowTtm.operatingCashFlow !== null) {
    ocf = statements.cashflowTtm.operatingCashFlow;
    ocfBasis = "ttm";
  } else if (statements.cashflowAnnual && statements.cashflowAnnual.operatingCashFlow !== null) {
    ocf = statements.cashflowAnnual.operatingCashFlow;
    ocfBasis = "annual";
    notes.push(
      "TTM operating cash flow unavailable — unprofitable overlay evaluated on the latest annual OCF" +
        (statements.cashflowAnnual.date ? ` (as of ${statements.cashflowAnnual.date})` : "") +
        ".",
    );
  }

  if (ni === null && ocf === null) {
    gaps.push({
      field: "route.overlays.unprofitable",
      reason: "netIncome and operatingCashFlow unavailable on both TTM and annual bases — overlay not evaluated",
      severity: "warn",
      attemptedSources: ["fmp:/stable/income-statement(-ttm)", "fmp:/stable/cash-flow-statement(-ttm)"],
    });
  } else if ((ni !== null && ni < 0) || (ocf !== null && ocf < 0)) {
    overlays.push("unprofitable");
    notes.push(
      `unprofitable overlay applied: netIncome=${ni === null ? "n/a" : ni} (${niBasis ?? "n/a"}), ` +
        `operatingCashFlow=${ocf === null ? "n/a" : ocf} (${ocfBasis ?? "n/a"}). ` +
        "Trigger (house rule, SPEC §13.7): TTM netIncome < 0 OR TTM operatingCashFlow < 0.",
    );
  }

  // pre-revenue: TTM revenue < $10M (house rule)
  let revBasis: "ttm" | "annual" | null = null;
  let rev: number | null = null;
  if (statements.incomeTtm && statements.incomeTtm.revenue !== null) {
    rev = statements.incomeTtm.revenue;
    revBasis = "ttm";
  } else if (statements.incomeAnnual && statements.incomeAnnual.revenue !== null) {
    rev = statements.incomeAnnual.revenue;
    revBasis = "annual";
    notes.push("TTM revenue unavailable — pre-revenue overlay evaluated on the latest annual revenue.");
  }
  if (rev === null) {
    gaps.push({
      field: "route.overlays.preRevenue",
      reason: "revenue unavailable on both TTM and annual bases — pre-revenue overlay not evaluated",
      severity: "warn",
      attemptedSources: ["fmp:/stable/income-statement(-ttm)"],
    });
  } else if (rev < PRE_REVENUE_TTM_REVENUE_FLOOR_USD) {
    overlays.push("pre-revenue");
    notes.push(
      `house rule: pre-revenue overlay — ${revBasis} revenue ${rev} < $${PRE_REVENUE_TTM_REVENUE_FLOOR_USD.toLocaleString("en-US")} ` +
        "floor (SPEC §13.7; annotated house rule, revisit with data).",
    );
  }

  // recent-ipo overlay: applied ONLY when a VERIFIED ipoDate falls within the
  // recency window (SPEC §6). Sparse quarterly history is NOT evidence of a
  // recent IPO — a mature issuer with incomplete data coverage is "insufficient
  // historical coverage", disclosed as a gap, and NEVER routed as a recent IPO
  // (audit 2026-07-11 finding #4). Treating missing history as a listing event
  // mis-framed old companies (e.g. AAPL with < 8 fixture quarters) as IPOs and
  // suppressed the wrong metrics. History depth still drives the honest
  // degradation of long-window CAGRs/technicals via their own insufficiency
  // flags — it just no longer asserts an IPO that did not occur.
  const ipoRaw = normStr(profile.ipoDate);
  let recentByDate = false;
  let ipoDateVerified = false;
  if (ipoRaw !== null) {
    const ipoMs = parseIsoDateUtc(ipoRaw);
    if (ipoMs === null) {
      notes.push(`ipoDate "${ipoRaw}" unparseable — IPO recency by date not evaluated.`);
    } else {
      ipoDateVerified = true;
      recentByDate = addMonthsUtc(ipoMs, RECENT_IPO_WINDOW_MONTHS) >= todayMs;
    }
  }
  const q = statements.availableQuarters;
  const qKnown = typeof q === "number" && Number.isFinite(q);
  const thinHistory = qKnown && (q as number) < RECENT_IPO_MIN_QUARTERS;

  if (recentByDate) {
    overlays.push("recent-ipo");
    notes.push(
      `recent-ipo overlay applied: verified ipoDate ${ipoRaw} within ${RECENT_IPO_WINDOW_MONTHS} months of ` +
        `${opts.today} (house rule, SPEC §6).` +
        (thinHistory
          ? ` ${q} quarterly statements available (< ${RECENT_IPO_MIN_QUARTERS}) — consistent with a recent listing.`
          : ""),
    );
  } else if (thinHistory) {
    // Verified-old OR unconfirmable ipoDate but shallow history: NOT a recent
    // IPO. Disclose insufficient historical coverage so long-window metrics
    // degrade honestly without asserting a listing event that did not occur.
    const ipoContext = ipoDateVerified
      ? `verified ipoDate ${ipoRaw} is older than ${RECENT_IPO_WINDOW_MONTHS} months`
      : "ipoDate is unavailable, so a recent listing cannot be confirmed";
    notes.push(
      `insufficient historical coverage: only ${q} quarterly statement(s) available ` +
        `(< ${RECENT_IPO_MIN_QUARTERS}), but ${ipoContext} — treated as incomplete data coverage, NOT a ` +
        `recent-IPO overlay (audit 2026-07-11 finding #4). Long-window CAGRs/technicals degrade via their own ` +
        `insufficiency flags.`,
    );
    gaps.push({
      field: "route.insufficientHistory",
      reason:
        `only ${q} quarterly statement(s) available (< ${RECENT_IPO_MIN_QUARTERS}); ${ipoContext} — ` +
        `insufficient historical coverage, not a recent IPO`,
      severity: "info",
      attemptedSources: ["fmp:/stable/income-statement?period=quarter", "fmp:/stable/profile.ipoDate"],
    });
  } else if (ipoRaw === null && !qKnown) {
    gaps.push({
      field: "route.overlays.recentIpo",
      reason: "ipoDate and quarterly history depth both unavailable — recent-IPO overlay not evaluable",
      severity: "info",
      attemptedSources: ["fmp:/stable/profile.ipoDate", "fmp:/stable/income-statement?period=quarter"],
    });
  }

  // adr: keyed strictly on profile.isAdr
  if (profile.isAdr === true) {
    overlays.push("adr");
    notes.push(
      "adr overlay applied (profile.isAdr). ADR ratio comes from the static ADR_RATIOS map " +
        "(no FMP field exists — the provider data contract §4.10); unknown ADRs are disclosed as gaps.",
    );
  } else {
    const country = normStr(profile.country)?.toUpperCase() ?? null;
    if (country !== null && country !== "US" && country !== "USA" && country !== "UNITED STATES") {
      notes.push(
        `country "${country}" is non-US but profile.isAdr is not true — foreign-issuer caveats may still ` +
          "apply (reporting cadence, currency); adr overlay keys on profile.isAdr only.",
      );
    }
  }

  return {
    base,
    overlays,
    evidence: { sector: sectorRaw, industry: industryRaw, sic: sicRaw },
    notes,
    gaps,
    asOf: {
      today: opts.today,
      incomeTtm: statements.incomeTtm?.date ?? null,
      incomeAnnual: statements.incomeAnnual?.date ?? null,
      cashflowTtm: statements.cashflowTtm?.date ?? null,
      cashflowAnnual: statements.cashflowAnnual?.date ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// ADR_RATIOS — static, research-verified map (the sector-routing methodology §7)
// ---------------------------------------------------------------------------

export interface AdrRatioEntry {
  /** Ordinary (home-market) shares represented by 1 ADS. TSM: 1 ADS = 5 ordinary. */
  ordinarySharesPerAds: number;
  /** Home-jurisdiction dividend withholding percent (indicative; verify per treaty). */
  withholdingPct: number | null;
  /** Home country (ISO-ish label). */
  country: string;
  /** Provenance of the ratio. */
  source: string;
}

/**
 * Only ratios verified against primary sources belong here. Everything else
 * goes through the lookupAdrRatio gap path (LLM/F-6/depositary lookup later).
 */
export const ADR_RATIOS: Readonly<Record<string, AdrRatioEntry>> = {
  TSM: {
    ordinarySharesPerAds: 5,
    withholdingPct: 21,
    country: "TW",
    source: "TSMC IR Jan-2026",
  },
};

export type AdrRatioLookup =
  | { ok: true; symbol: string; ratio: AdrRatioEntry }
  | { ok: false; gap: ManifestEntry };

/** Look up a covered ADR's ratio; unknown symbols return a disclosed gap. */
export function lookupAdrRatio(symbol: string): AdrRatioLookup {
  const sym = symbol.trim().toUpperCase();
  const ratio: AdrRatioEntry | undefined =
    sym.length > 0 && Object.hasOwn(ADR_RATIOS, sym) ? ADR_RATIOS[sym] : undefined;
  if (ratio === undefined) {
    return {
      ok: false,
      gap: {
        field: "adr.ratio",
        reason:
          `unknown ADR ratio for "${sym.length > 0 ? sym : symbol}" — not in the static ADR_RATIOS map; ` +
          "per-ADS figures (EPS × ratio / FX) cannot be reconstructed until the ratio is sourced " +
          "(depositary bank / company IR / F-6 filing)",
        severity: "warn",
        attemptedSources: ["static:ADR_RATIOS"],
      },
    };
  }
  return { ok: true, symbol: sym, ratio };
}

// ---------------------------------------------------------------------------
// SECTOR_ETF_MAP — 11 FMP sectors -> SPDR sector ETFs + SPY benchmark
// ---------------------------------------------------------------------------

export interface SectorEtfEntry {
  etf: string;
  benchmark: typeof SPY_BENCHMARK;
}

/** Keys are the 11 FMP sector strings (the provider data contract §2.5 enum; frozen day-1). */
export const SECTOR_ETF_MAP: Readonly<Record<string, SectorEtfEntry>> = {
  "Basic Materials": { etf: "XLB", benchmark: SPY_BENCHMARK },
  "Communication Services": { etf: "XLC", benchmark: SPY_BENCHMARK },
  "Consumer Cyclical": { etf: "XLY", benchmark: SPY_BENCHMARK },
  "Consumer Defensive": { etf: "XLP", benchmark: SPY_BENCHMARK },
  Energy: { etf: "XLE", benchmark: SPY_BENCHMARK },
  "Financial Services": { etf: "XLF", benchmark: SPY_BENCHMARK },
  Healthcare: { etf: "XLV", benchmark: SPY_BENCHMARK },
  Industrials: { etf: "XLI", benchmark: SPY_BENCHMARK },
  "Real Estate": { etf: "XLRE", benchmark: SPY_BENCHMARK },
  Technology: { etf: "XLK", benchmark: SPY_BENCHMARK },
  Utilities: { etf: "XLU", benchmark: SPY_BENCHMARK },
};

export type SectorEtfLookup =
  | { ok: true; sector: string; etf: string; benchmark: typeof SPY_BENCHMARK }
  | { ok: false; benchmark: typeof SPY_BENCHMARK; gap: ManifestEntry };

/** Case-insensitive, trimmed sector→ETF lookup. SPY benchmark always available. */
export function lookupSectorEtf(sector: string | null | undefined): SectorEtfLookup {
  const s = normStr(sector ?? null);
  if (s !== null) {
    const lc = s.toLowerCase();
    for (const [key, entry] of Object.entries(SECTOR_ETF_MAP)) {
      if (key.toLowerCase() === lc) {
        return { ok: true, sector: key, etf: entry.etf, benchmark: entry.benchmark };
      }
    }
  }
  return {
    ok: false,
    benchmark: SPY_BENCHMARK,
    gap: {
      field: "technicals.relativeStrength.sectorEtf",
      reason: `sector "${s ?? "(missing)"}" has no SPDR ETF mapping — relative strength computed vs ${SPY_BENCHMARK} only`,
      severity: "info",
      attemptedSources: ["static:SECTOR_ETF_MAP"],
    },
  };
}

// ---------------------------------------------------------------------------
// metricPolicy — suppress/lead lists per SPEC §6 table (hard product rules)
// ---------------------------------------------------------------------------

export interface MetricPolicy {
  /** Metric ids the UI/report builder must NEVER display for this route. */
  suppress: string[];
  /** Metric ids the report leads with for this route. */
  lead: string[];
}

const BASE_POLICIES: Readonly<Record<SectorRoute, { suppress: readonly string[]; lead: readonly string[] }>> = {
  general: {
    suppress: [],
    lead: ["revenueCagr", "grossMargin", "operatingMargin", "roicVsWacc", "fcfYield", "evEbitda", "pe"],
  },
  // SPEC §6: banks never show EV/EBITDA, current ratio, FCF DCF, Altman/Beneish
  // (FMP emits garbage/zeros for these on banks — verified in FMP's own docs example).
  bank: {
    suppress: [
      "evEbitda",
      "evToSales",
      "netDebt",
      "netDebtToEbitda",
      "currentRatio",
      "quickRatio",
      "grossMargin",
      "inventoryTurnover",
      "debtToEquity",
      "fcfDcf",
      "fcfYield",
      "altmanZ",
      "beneishM",
    ],
    lead: [
      "pTbv",
      "tangibleCommonEquity",
      "rote",
      "nimApprox",
      "efficiencyRatio",
      "provisionForCreditLosses",
      "cet1Reported",
      "depositMix",
      "pe",
    ],
  },
  insurer: {
    // grossMargin: FMP's revenue−costOfRevenue is meaningless on a premium/claims
    // income statement (insurers are judged on combined/loss/expense ratios), same
    // rationale as the bank route — do not let it drive the moat score.
    suppress: ["evEbitda", "evToSales", "fcfDcf", "currentRatio", "quickRatio", "grossMargin", "altmanZ", "beneishM"],
    lead: [
      "combinedRatio",
      "lossRatio",
      "expenseRatio",
      "priceToBook",
      "priceToBookExAoci",
      "roe",
      "reserveDevelopment",
      "investmentYield",
    ],
  },
  reit: {
    suppress: ["pe", "peg", "epsGrowth", "fcfDcf", "currentRatio"],
    lead: [
      "ffoApprox",
      "affoApprox",
      "pFfo",
      "affoPayoutRatio",
      "netDebtToEbitdare",
      "impliedCapRate",
      "dividendYield",
    ],
  },
  // Mortgage REITs: bank-flavored book-value submap (the sector-routing methodology §4).
  // grossMargin is meaningless on a net-interest-spread income statement (same as
  // the bank/insurer routes) — suppress so it cannot drive the moat score.
  "reit-mortgage": {
    suppress: ["evEbitda", "currentRatio", "fcfDcf", "ffoApprox", "affoApprox", "pFfo", "grossMargin", "altmanZ", "beneishM"],
    lead: ["priceToBook", "bookValuePerShare", "dividendYield", "netInterestSpread", "leverageAssetsToEquity"],
  },
};

const OVERLAY_POLICIES: Readonly<Record<SectorOverlay, { suppress: readonly string[]; lead: readonly string[] }>> = {
  // the sector-routing methodology §5 overlay behavior.
  unprofitable: {
    suppress: ["pe", "peg", "fcfDcf", "dividendSafety", "piotroskiF", "beneishM"],
    lead: ["cashRunway", "quarterlyBurn", "dilutionRate", "cashVsMarketCap", "evToSales", "goingConcern"],
  },
  "pre-revenue": {
    suppress: ["pe", "peg", "evEbitda", "evToSales", "psRatio", "fcfDcf", "grossMargin", "piotroskiF", "beneishM"],
    lead: ["cashRunway", "quarterlyBurn", "dilutionRate", "cashVsMarketCap", "milestones", "goingConcern"],
  },
  // the sector-routing methodology §6 degradations.
  "recent-ipo": {
    suppress: ["cagr5y", "cagr10y", "sma200", "fiftyTwoWeekRange", "beta", "seasonality", "beneishM", "piotroskiF"],
    lead: ["sinceIpoGrowth", "lockupCountdown", "analystCoverageCount"],
  },
  adr: {
    suppress: [],
    lead: ["adrRatio", "withholdingGrossYield"],
  },
};

/**
 * Metric display policy for a route (or a full CompanyRoute with overlays).
 * The UI and report builder consult this — e.g. a bank report can NEVER
 * display EV/EBITDA (hard product rule; suppress wins over lead).
 */
export function metricPolicy(route: SectorRoute | CompanyRoute): MetricPolicy {
  const base: SectorRoute = typeof route === "string" ? route : route.base;
  const overlays: readonly SectorOverlay[] = typeof route === "string" ? [] : route.overlays;

  const suppress = new Set<string>(BASE_POLICIES[base].suppress);
  const lead: string[] = [...BASE_POLICIES[base].lead];
  for (const overlay of overlays) {
    for (const s of OVERLAY_POLICIES[overlay].suppress) suppress.add(s);
    lead.push(...OVERLAY_POLICIES[overlay].lead);
  }
  const seen = new Set<string>();
  const leadFinal: string[] = [];
  for (const m of lead) {
    if (!suppress.has(m) && !seen.has(m)) {
      seen.add(m);
      leadFinal.push(m);
    }
  }
  return { suppress: [...suppress], lead: leadFinal };
}

// ---------------------------------------------------------------------------
// degradationPlan — which sections/metrics degrade + disclosure strings
// ---------------------------------------------------------------------------

export type DegradationAction = "suppress" | "replace" | "annotate";

export interface DegradationItem {
  /** Report section or metric id, e.g. "fundamentals.cagr" or "valuation". */
  target: string;
  action: DegradationAction;
  /** What replaces the target when action = "replace". */
  replacement?: string;
  /** Disclosure string rendered in the report. */
  disclosure: string;
}

export interface DegradationPlan {
  route: SectorRoute;
  overlays: SectorOverlay[];
  items: DegradationItem[];
  notes: string[];
  gaps: ManifestEntry[];
}

export function degradationPlan(
  route: SectorRoute,
  overlays: readonly SectorOverlay[],
  availableQuarters: number | null,
): DegradationPlan {
  const items: DegradationItem[] = [];
  const notes: string[] = [];
  const gaps: ManifestEntry[] = [];
  const qStr =
    typeof availableQuarters === "number" && Number.isFinite(availableQuarters)
      ? `${availableQuarters} quarters`
      : "an unknown number of quarters";

  // ---- route-driven degradations (SPEC §6 table)
  if (route === "bank") {
    items.push(
      {
        target: "valuation.evEbitda",
        action: "suppress",
        disclosure:
          "EV/EBITDA is never shown for banks: debt is a bank's raw material, so enterprise value is " +
          "meaningless (FMP's own docs example shows negative EV for a profitable bank). Replaced by P/TBV, P/E, ROTE.",
      },
      {
        target: "fundamentals.currentRatio",
        action: "suppress",
        disclosure:
          "Current/quick ratio have no meaning on a bank balance sheet (FMP returns 0) — deposit mix and " +
          "reported capital ratios shown instead.",
      },
      {
        target: "valuation.dcf",
        action: "replace",
        replacement: "excess-return-model",
        disclosure:
          "FCF DCF replaced by the excess-return model on tangible common equity " +
          "(BV0 + sum of (ROTE − CoE) · TCE / (1 + CoE)^t) — bank FCF swings with loan growth and deposit flows.",
      },
      {
        target: "forensics",
        action: "replace",
        replacement: "bank-health-metrics",
        disclosure:
          "Altman Z and Beneish M are not computed for financials — bank health metrics shown instead " +
          "(CET1 as reported by the company, TCE/assets, provisions trend).",
      },
      {
        target: "leadership.cet1Ratio",
        action: "annotate",
        disclosure:
          "CET1 is unavailable from FMP and EDGAR XBRL — displayed as reported by the company (filing " +
          "extraction) with a source link, and flagged.",
      },
    );
  } else if (route === "insurer") {
    items.push(
      {
        target: "valuation.evEbitda",
        action: "suppress",
        disclosure: "EV/EBITDA suppressed for insurers — investment leverage pollutes enterprise value.",
      },
      {
        target: "valuation.dcf",
        action: "replace",
        replacement: "excess-return-or-ddm",
        disclosure:
          "FCF DCF replaced by excess-return / dividend-discount framing — reserve timing distorts insurer CFO.",
      },
      {
        target: "fundamentals.combinedRatio",
        action: "annotate",
        disclosure:
          "Company-reported combined ratio is the gold standard; any in-house XBRL computation is an " +
          "approximation (GAAP vs statutory denominator) and labeled as such.",
      },
    );
  } else if (route === "reit") {
    items.push(
      {
        target: "fundamentals.eps",
        action: "replace",
        replacement: "ffo-affo",
        disclosure:
          "GAAP EPS / P/E de-emphasized for REITs (real-estate depreciation is non-economic) — FFO/AFFO lead; " +
          "the Thesis computation is labeled 'FFO (Thesis approx.)' and shown against company-reported FFO when available.",
      },
      {
        target: "valuation.dcf",
        action: "replace",
        replacement: "p-ffo-and-nav",
        disclosure: "Valuation framed on P/FFO multiples, AFFO payout and an implied-cap-rate/NAV sketch.",
      },
    );
  } else if (route === "reit-mortgage") {
    items.push({
      target: "fundamentals.ffo",
      action: "suppress",
      disclosure:
        "FFO/NOI largely irrelevant for mortgage REITs — book-value submap leads: P/B, dividend yield, " +
        "net interest spread, leverage.",
    });
  }

  // ---- overlay-driven degradations
  for (const overlay of overlays) {
    if (overlay === "recent-ipo") {
      items.push(
        {
          target: "fundamentals.cagr",
          action: "suppress",
          disclosure:
            `No 5y/10y CAGRs: only ${qStr} of history available (recent-ipo overlay: IPO within ` +
            `${RECENT_IPO_WINDOW_MONTHS} months or < ${RECENT_IPO_MIN_QUARTERS} quarterly statements). ` +
            "Showing since-IPO growth with an explicit period-count badge instead.",
        },
        {
          target: "outlook.analystEstimates",
          action: "annotate",
          disclosure:
            "Analyst estimate coverage is typically thin for ~25–40 days post-IPO (quiet period): shown as " +
            '"thin coverage (N analysts)", never as consensus-as-truth.',
        },
        {
          target: "technicals.sma200",
          action: "suppress",
          disclosure:
            "200-day moving average requires 200 trading days — suppressed; since-IPO high/low shown instead " +
            "of the 52-week range.",
        },
        {
          target: "technicals.beta",
          action: "annotate",
          disclosure: 'Beta is unreliable with under ~1–2 years of returns — greyed out with "insufficient history".',
        },
        {
          target: "forensics",
          action: "annotate",
          disclosure:
            `Beneish M needs YoY pairs and Piotroski F needs a prior year — computed only where legitimate; ` +
            `the rest labeled "needs >= ${RECENT_IPO_MIN_QUARTERS} quarters".`,
        },
        {
          target: "catalysts.lockup",
          action: "annotate",
          disclosure:
            "Lockup expiration estimated as ipoDate + 180 days unless the prospectus clause was extracted — " +
            'labeled "estimated (standard 180-day term) — verify in prospectus".',
        },
      );
      if (!(typeof availableQuarters === "number" && Number.isFinite(availableQuarters))) {
        gaps.push({
          field: "degradation.availableQuarters",
          reason: "quarterly history depth unknown — CAGR windows degraded conservatively",
          severity: "info",
        });
      }
    } else if (overlay === "pre-revenue") {
      items.push(
        {
          target: "valuation",
          action: "replace",
          replacement: "runway-framing",
          disclosure:
            "Valuation section replaced by runway framing: cash runway, quarterly burn trend, dilution path, " +
            "cash vs market cap, milestones and going-concern status. Trigger (house rule): TTM revenue < " +
            `$${PRE_REVENUE_TTM_REVENUE_FLOOR_USD.toLocaleString("en-US")}.`,
        },
        {
          target: "valuation.multiples",
          action: "suppress",
          disclosure:
            "Revenue/earnings multiples (P/E, PEG, EV/EBITDA, EV/S, P/S) suppressed — no meaningful revenue base yet.",
        },
      );
    } else if (overlay === "unprofitable") {
      items.push(
        {
          target: "valuation.dcf",
          action: "replace",
          replacement: "scenario-runway-framing",
          disclosure:
            "DCF on negative current FCF suppressed — replaced by scenario/runway framing (unprofitable overlay: " +
            "TTM netIncome < 0 OR TTM operatingCashFlow < 0).",
        },
        {
          target: "header.metrics",
          action: "replace",
          replacement: "runway-burn-dilution",
          disclosure:
            "Headline metric box replaced with: cash runway, burn trend, dilution rate, cash vs market cap, " +
            "EV/S (if revenue), going-concern status.",
        },
        {
          target: "forensics.piotroskiBeneish",
          action: "suppress",
          disclosure: "Piotroski F and Beneish M suppressed — largely meaningless for loss-making companies.",
        },
      );
    } else if (overlay === "adr") {
      items.push(
        {
          target: "header.dividendYield",
          action: "annotate",
          disclosure:
            "Dividend yield shown GROSS — foreign withholding applies (see ADR ratio map for the rate); " +
            "depositary pass-through fees (typ. $0.01–$0.05/ADS) also reduce net dividends.",
        },
        {
          target: "fundamentals.currency",
          action: "annotate",
          disclosure:
            "Statements are in reportedCurrency while the ADR quotes in USD — per-ADS figures use " +
            "eps_local × ADR ratio / FX; never divide the USD price by local-currency EPS.",
        },
        {
          target: "meta.reportingCadence",
          action: "annotate",
          disclosure:
            "Foreign private issuers file 20-F annually + 6-K ad hoc (no 10-Q) — thinner quarterly data is " +
            "expected, not a data error.",
        },
      );
    }
  }

  if (overlays.length === 0 && route === "general") {
    notes.push("no degradations: general route with no overlays.");
  }

  return { route, overlays: [...overlays], items, notes, gaps };
}

// ---------------------------------------------------------------------------
// computeRunway — cash + STI over average quarterly burn (+ dilution context)
// ---------------------------------------------------------------------------

/** Latest balance-sheet row (FMP field names, the provider data contract §2.3). */
export interface RunwayBalanceInput {
  /** Fiscal period end (as-of date of the liquidity figure). */
  date: string;
  cashAndCashEquivalents: number | null;
  shortTermInvestments: number | null;
  /** FMP's combined field — preferred when present. */
  cashAndShortTermInvestments?: number | null;
}

/** Quarterly cash-flow row (FMP field names; capitalExpenditure is NEGATIVE). */
export interface RunwayCashflowQuarter {
  date: string;
  operatingCashFlow: number | null;
  capitalExpenditure: number | null;
}

/** Quarterly diluted share count (income statement `weightedAverageShsOutDil`). */
export interface ShareCountQuarter {
  date: string;
  weightedAverageShsOutDil: number | null;
}

export interface RunwayDilution {
  sharesLatest: number;
  sharesLatestAsOf: string;
  sharesPrior: number;
  sharesPriorAsOf: string;
  spanDays: number;
  /** Total growth over the span, as a fraction (0.2 = +20%). */
  totalGrowth: number;
  /** Annualized growth (CAGR) over the span, as a fraction. */
  annualizedGrowth: number;
}

export interface RunwayResult {
  /** null when burn could not be determined at all. */
  burning: boolean | null;
  /** Average quarterly burn in USD (positive) when burning; null otherwise. */
  avgQuarterlyBurn: number | null;
  /** Number of quarters used in the burn average (0 when none usable). */
  burnWindowQuarters: number;
  /** Fiscal-period-end dates of the quarters used (provenance). */
  burnWindowDates: string[];
  /** Strict liquidity: cash + short-term investments. */
  liquidAssets: number | null;
  liquidAssetsBasis: "cashAndShortTermInvestments" | "cash+shortTermInvestments" | null;
  liquidAssetsAsOf: string | null;
  /** Full-precision runway in quarters; null when not burning or not computable. */
  runwayQuarters: number | null;
  /** Estimated ISO date liquidity is exhausted (balance date + runway). */
  estimatedExhaustionDate: string | null;
  /** ~2-year diluted-share-count growth context; null when history insufficient. */
  dilution: RunwayDilution | null;
  notes: string[];
  gaps: ManifestEntry[];
}

export function computeRunway(
  balance: RunwayBalanceInput,
  cashflowQuarterly: readonly RunwayCashflowQuarter[],
  shareCountQuarterly?: readonly ShareCountQuarter[],
): RunwayResult {
  const notes: string[] = [];
  const gaps: ManifestEntry[] = [];

  notes.push(
    "burn = -(operatingCashFlow + capitalExpenditure) per quarter; FMP capitalExpenditure is negative, " +
      `so the sum is FCF (the sector-routing methodology §5). Averaged over the last <= ${BURN_WINDOW_MAX_QUARTERS} ` +
      `usable quarters (house rule); quarter length = ${DAYS_PER_QUARTER} days (365.25/4).`,
  );
  notes.push(
    "strict liquidity variant: cashAndShortTermInvestments only — longTermInvestments deliberately excluded (house rule).",
  );

  // ---- liquid assets
  let liquidAssets: number | null = null;
  let liquidAssetsBasis: RunwayResult["liquidAssetsBasis"] = null;
  if (typeof balance.cashAndShortTermInvestments === "number") {
    liquidAssets = balance.cashAndShortTermInvestments;
    liquidAssetsBasis = "cashAndShortTermInvestments";
  } else if (balance.cashAndCashEquivalents !== null || balance.shortTermInvestments !== null) {
    liquidAssets = (balance.cashAndCashEquivalents ?? 0) + (balance.shortTermInvestments ?? 0);
    liquidAssetsBasis = "cash+shortTermInvestments";
    if (balance.cashAndCashEquivalents === null) {
      notes.push("cashAndCashEquivalents missing — treated as 0 in the liquidity sum.");
    }
    if (balance.shortTermInvestments === null) {
      notes.push("shortTermInvestments missing — treated as 0 in the liquidity sum.");
    }
  } else {
    gaps.push({
      field: "runway.liquidAssets",
      reason: "cashAndCashEquivalents, shortTermInvestments and cashAndShortTermInvestments all missing",
      severity: "warn",
      attemptedSources: ["fmp:/stable/balance-sheet-statement"],
    });
  }

  // ---- burn window
  const dated = cashflowQuarterly
    .map((row) => ({ row, ms: parseIsoDateUtc(row.date) }))
    .filter((x): x is { row: RunwayCashflowQuarter; ms: number } => x.ms !== null)
    .sort((a, b) => b.ms - a.ms);
  if (dated.length < cashflowQuarterly.length) {
    notes.push(`${cashflowQuarterly.length - dated.length} cash-flow row(s) dropped for unparseable dates.`);
  }

  const window: { date: string; fcf: number }[] = [];
  for (const { row } of dated) {
    if (window.length >= BURN_WINDOW_MAX_QUARTERS) break;
    const ocf = row.operatingCashFlow;
    const capex = row.capitalExpenditure;
    if (ocf === null) {
      notes.push(`quarter ${row.date}: operatingCashFlow missing — excluded from the burn window.`);
      continue;
    }
    if (ocf === 0 && (capex === 0 || capex === null)) {
      notes.push(
        `quarter ${row.date}: operatingCashFlow and capitalExpenditure both 0 — treated as undisclosed ` +
          "(FMP zero-for-undisclosed policy) and excluded from the burn window.",
      );
      continue;
    }
    if (capex === null) {
      notes.push(`quarter ${row.date}: capitalExpenditure missing — treated as 0 for burn math.`);
    }
    window.push({ date: row.date, fcf: ocf + (capex ?? 0) });
  }

  let burning: boolean | null = null;
  let avgQuarterlyBurn: number | null = null;
  let runwayQuarters: number | null = null;
  let estimatedExhaustionDate: string | null = null;

  if (window.length === 0) {
    gaps.push({
      field: "runway.avgQuarterlyBurn",
      reason: "no usable quarterly cash-flow rows (operatingCashFlow missing or undisclosed on every row)",
      severity: "warn",
      attemptedSources: ["fmp:/stable/cash-flow-statement?period=quarter"],
    });
  } else {
    if (window.length < BURN_WINDOW_MAX_QUARTERS) {
      notes.push(
        `burn averaged over only ${window.length} quarter(s) — house rule prefers ${BURN_WINDOW_MAX_QUARTERS}.`,
      );
    }
    const avgFcf = window.reduce((sum, w) => sum + w.fcf, 0) / window.length;
    if (avgFcf >= 0) {
      burning = false;
      notes.push(
        `not burning: average (operatingCashFlow + capitalExpenditure) over the last ${window.length} ` +
          `quarter(s) = ${avgFcf} >= 0 — self-funding; runway not computed (house rule: runway only when burning).`,
      );
    } else {
      burning = true;
      avgQuarterlyBurn = -avgFcf;
      if (liquidAssets !== null) {
        runwayQuarters = liquidAssets / avgQuarterlyBurn;
        const balanceMs = parseIsoDateUtc(balance.date);
        if (balanceMs === null) {
          notes.push(`balance date "${balance.date}" unparseable — exhaustion date not estimated.`);
        } else {
          estimatedExhaustionDate = isoDateFromMs(
            balanceMs + runwayQuarters * DAYS_PER_QUARTER * MS_PER_DAY,
          );
        }
      }
    }
  }

  // ---- dilution context: diluted share-count growth over ~2 years
  let dilution: RunwayDilution | null = null;
  const shareRows = (shareCountQuarterly ?? [])
    .map((row) => ({ row, ms: parseIsoDateUtc(row.date) }))
    .filter(
      (x): x is { row: ShareCountQuarter; ms: number } =>
        x.ms !== null &&
        typeof x.row.weightedAverageShsOutDil === "number" &&
        x.row.weightedAverageShsOutDil > 0,
    )
    .sort((a, b) => b.ms - a.ms);

  if (shareRows.length === 0) {
    gaps.push({
      field: "runway.dilution",
      reason: "no usable weightedAverageShsOutDil history provided — dilution context unavailable",
      severity: "info",
      attemptedSources: ["fmp:/stable/income-statement?period=quarter"],
    });
  } else if (shareRows.length === 1) {
    gaps.push({
      field: "runway.dilution",
      reason: "only one share-count point available — dilution growth needs at least two",
      severity: "info",
    });
  } else {
    const latest = shareRows[0];
    const targetMs = latest.ms - DILUTION_LOOKBACK_DAYS * MS_PER_DAY;
    let prior = shareRows[1];
    let bestDist = Math.abs(prior.ms - targetMs);
    for (const candidate of shareRows.slice(2)) {
      const dist = Math.abs(candidate.ms - targetMs);
      if (dist < bestDist) {
        prior = candidate;
        bestDist = dist;
      }
    }
    const spanDays = (latest.ms - prior.ms) / MS_PER_DAY;
    if (spanDays <= 0) {
      gaps.push({
        field: "runway.dilution",
        reason: "share-count rows share the same date — dilution growth not computable",
        severity: "info",
      });
    } else {
      if (spanDays < 365) {
        notes.push(
          `share-count history spans only ${spanDays} day(s) (< 1 year) — annualized dilution is unreliable.`,
        );
      }
      const sharesLatest = latest.row.weightedAverageShsOutDil as number;
      const sharesPrior = prior.row.weightedAverageShsOutDil as number;
      const ratio = sharesLatest / sharesPrior;
      dilution = {
        sharesLatest,
        sharesLatestAsOf: latest.row.date,
        sharesPrior,
        sharesPriorAsOf: prior.row.date,
        spanDays,
        totalGrowth: ratio - 1,
        annualizedGrowth: Math.pow(ratio, 365.25 / spanDays) - 1,
      };
    }
  }

  return {
    burning,
    avgQuarterlyBurn,
    burnWindowQuarters: window.length,
    burnWindowDates: window.map((w) => w.date),
    liquidAssets,
    liquidAssetsBasis,
    liquidAssetsAsOf: liquidAssets !== null ? balance.date : null,
    runwayQuarters,
    estimatedExhaustionDate,
    dilution,
    notes,
    gaps,
  };
}
