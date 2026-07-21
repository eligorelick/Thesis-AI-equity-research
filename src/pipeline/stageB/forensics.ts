/**
 * Stage B — Forensic accounting layer (pure, deterministic TypeScript).
 *
 * Altman Z (variant-aware), Beneish M (8-variable), Piotroski F (9 signals),
 * Sloan-style accrual ratios, and plain-English supporting red flags.
 *
 * All formulas, coefficients, and denominators are primary-source-verified in
 * the forensic methodology — that document is authoritative. Field names on
 * the input rows match FMP's stable-API statement responses exactly
 * (the provider data contract §2.3); the integration layer wires the DataBundle in.
 *
 * Contract (Stage B design rules):
 * - NO network, NO db, NO LLM. Plain typed inputs → typed results.
 * - Missing inputs never throw: partial results + ManifestEntry-compatible
 *   gap descriptions are returned so the report can disclose them.
 * - Every non-canonical ("house rule") threshold is annotated in the returned
 *   notes array — nothing is silently applied.
 * - Full precision is returned; rounding happens only inside display strings
 *   (flag messages / signal details).
 * - Annual statements only. Rows are expected newest-first (FMP default order).
 */

import type { CompanyRoute, ManifestEntry } from "@/types/core";

// ---------------------------------------------------------------------------
// Input row contracts — field names exactly as FMP names them (the provider data contract).
// All numeric fields are optional `number | null`: undefined and null are both
// treated as "missing". NOTE: FMP emits 0 for some undisclosed items; fields
// where 0 is implausible (SG&A, interest expense) are re-nulled internally.
// ---------------------------------------------------------------------------

/** Annual income-statement row (FMP `income-statement`, period=annual). */
export interface ForensicsIncomeRow {
  /** Fiscal period end (FMP `date`), ISO string. */
  date: string;
  fiscalYear?: string | null;
  period?: string | null;
  revenue?: number | null;
  costOfRevenue?: number | null;
  grossProfit?: number | null;
  sellingGeneralAndAdministrativeExpenses?: number | null;
  generalAndAdministrativeExpenses?: number | null;
  sellingAndMarketingExpenses?: number | null;
  depreciationAndAmortization?: number | null;
  ebit?: number | null;
  operatingIncome?: number | null;
  interestExpense?: number | null;
  incomeTaxExpense?: number | null;
  netIncome?: number | null;
  netIncomeFromContinuingOperations?: number | null;
  netIncomeFromDiscontinuedOperations?: number | null;
  totalOtherIncomeExpensesNet?: number | null;
}

/** Annual balance-sheet row (FMP `balance-sheet-statement`). Levels, not deltas. */
export interface ForensicsBalanceRow {
  /** Fiscal period end (FMP `date`), ISO string. */
  date: string;
  totalAssets?: number | null;
  totalCurrentAssets?: number | null;
  cashAndShortTermInvestments?: number | null;
  accountsReceivables?: number | null;
  netReceivables?: number | null;
  inventory?: number | null;
  propertyPlantEquipmentNet?: number | null;
  totalLiabilities?: number | null;
  totalCurrentLiabilities?: number | null;
  shortTermDebt?: number | null;
  longTermDebt?: number | null;
  taxPayables?: number | null;
  retainedEarnings?: number | null;
  totalStockholdersEquity?: number | null;
  totalEquity?: number | null;
  minorityInterest?: number | null;
  totalDebt?: number | null;
}

/** Annual cash-flow row (FMP `cash-flow-statement`). */
export interface ForensicsCashFlowRow {
  /** Fiscal period end (FMP `date`), ISO string. */
  date: string;
  netIncome?: number | null;
  depreciationAndAmortization?: number | null;
  netCashProvidedByOperatingActivities?: number | null;
  netCashProvidedByInvestingActivities?: number | null;
  commonStockIssuance?: number | null;
}

/** One fiscal year of aligned statements. Any statement may be missing. */
export interface ForensicsPeriod {
  income?: ForensicsIncomeRow | null;
  balance?: ForensicsBalanceRow | null;
  cashFlow?: ForensicsCashFlowRow | null;
}

// ---------------------------------------------------------------------------
// House rules — every non-canonical threshold, in one place. Each usage emits
// an annotation in the returned notes so the UI can distinguish canonical
// coefficients from house rules-of-thumb.
// ---------------------------------------------------------------------------

export const FORENSICS_HOUSE_RULES = {
  /** Receivables/inventory growth-gap vs revenue: warn above (pp). */
  growthGapWarnPp: 15,
  /** Receivables/inventory growth-gap vs revenue: red flag above (pp). */
  growthGapFlagPp: 25,
  /** Growth-gap flags require the numerator itself to have grown > this %. */
  minGrowthPct: 10,
  /** Suppress inventory growth-gap when revenue fell more than this % (overhang). */
  inventoryOverhangRevenueDeclinePct: -10,
  /** One-time items: |totalOtherIncomeExpensesNet| > this share of |operatingIncome|. */
  oneTimeItemsShareOfOperatingIncome: 0.1,
  /** "Serial one-timers" when breached in >= this many of the lookback years. */
  oneTimeSerialYears: 3,
  oneTimeLookbackYears: 5,
  /** Accrual-ratio bands (heuristic; Sloan 1996 is a decile result, no bright line). */
  accrualElevatedBand: 0.1,
  accrualRedBand: 0.2,
  /** Note when CF vs BS accrual ratios diverge by more than this (M&A/FX signal). */
  accrualDivergence: 0.1,
  /** Suppress growth flags when base-year revenue is below this floor (units = statement currency). */
  revenueFloor: 10_000_000,
  /** Altman X4 saturation cap when liabilities ~ 0 or extreme ratios (research §6.1). */
  altmanX4Cap: 20,
  /** Beneish ratio-index winsorization stand-in (research §2.5). */
  beneishIndexClamp: { min: 0.1, max: 10 },
  /** TATA is a level, not an index — separate clamp (house rule). */
  beneishTataClamp: { min: -1, max: 1 },
  /** DSRI above the manipulator-sample mean (Beneish Table 2) surfaces a flag. */
  dsriAmberLevel: 1.465,
  /** Piotroski equity-issuance de-minimis default: 0 = paper-strict (open question in notes). */
  piotroskiEquityIssuanceDeMinimisDefault: 0,
} as const;

// ---------------------------------------------------------------------------
// Numeric hygiene helpers
// ---------------------------------------------------------------------------

type Num = number | null | undefined;

/** undefined / NaN / ±Infinity → null. */
function nv(v: Num): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Strictly positive or null (guards TA-like denominators). */
function posOrNull(v: Num): number | null {
  const n = nv(v);
  return n !== null && n > 0 ? n : null;
}

/**
 * FMP zero-for-undisclosed policy: 0 treated as null for fields where a true
 * zero is implausible (interest expense, SG&A). SPEC §3 / DATA_MAP §1.1.
 */
function zeroAsNull(v: Num): number | null {
  const n = nv(v);
  return n === 0 ? null : n;
}

/** Division guarded against null and zero/non-finite denominators. */
function div(num: number | null, den: number | null): number | null {
  if (num === null || den === null || den === 0) return null;
  const r = num / den;
  return Number.isFinite(r) ? r : null;
}

/** YoY growth in percent; null when base is missing or non-positive. */
function growthPct(cur: number | null, prior: number | null): number | null {
  if (cur === null || prior === null || prior <= 0) return null;
  return (cur / prior - 1) * 100;
}

/** Delta cur − prior when both present. */
function delta(cur: Num, prior: Num): number | null {
  const c = nv(cur);
  const p = nv(prior);
  return c !== null && p !== null ? c - p : null;
}

function fmt1(v: number): string {
  return v.toFixed(1);
}

function gapEntry(
  field: string,
  reason: string,
  severity: ManifestEntry["severity"],
): ManifestEntry {
  return { field, reason, severity };
}

function periodDate(p: ForensicsPeriod | null | undefined): string | null {
  return p?.income?.date ?? p?.balance?.date ?? p?.cashFlow?.date ?? null;
}

/** Net income before extraordinary items: continuing ops, fallback netIncome. */
function continuingNetIncome(row: ForensicsIncomeRow | null | undefined): number | null {
  return nv(row?.netIncomeFromContinuingOperations) ?? nv(row?.netIncome);
}

/** Gross margin ratio: grossProfit/revenue, fallback (revenue − costOfRevenue)/revenue. */
function grossMarginRatio(
  row: ForensicsIncomeRow | null | undefined,
  sales: number | null,
): number | null {
  if (sales === null || sales <= 0) return null;
  const gp = nv(row?.grossProfit);
  if (gp !== null) return gp / sales;
  const cogs = nv(row?.costOfRevenue);
  if (cogs !== null) return (sales - cogs) / sales;
  return null;
}

// ===========================================================================
// 1. Altman Z-Score — three variants + selection rule
// ===========================================================================

export type AltmanVariant = "original" | "private" | "z2" | "z2-em";
export type AltmanZone = "safe" | "grey" | "distress";

export interface AltmanCoefficients {
  x1: number;
  x2: number;
  x3: number;
  x4: number;
  /** 0 means the variant drops X5 (Z″ family). */
  x5: number;
  constant: number;
}

/** Verified coefficients (Altman's own retrospective deck; research §1). */
export const ALTMAN_COEFFICIENTS = {
  original: { x1: 1.2, x2: 1.4, x3: 3.3, x4: 0.6, x5: 0.999, constant: 0 },
  private: { x1: 0.717, x2: 0.847, x3: 3.107, x4: 0.42, x5: 0.998, constant: 0 },
  z2: { x1: 6.56, x2: 3.26, x3: 6.72, x4: 1.05, x5: 0, constant: 0 },
  "z2-em": { x1: 6.56, x2: 3.26, x3: 6.72, x4: 1.05, x5: 0, constant: 3.25 },
} as const satisfies Record<AltmanVariant, AltmanCoefficients>;

/** Verified zone thresholds per variant (research §1.1–1.3). */
export const ALTMAN_ZONES = {
  original: { distressBelow: 1.81, safeAbove: 2.99 },
  private: { distressBelow: 1.23, safeAbove: 2.9 },
  z2: { distressBelow: 1.1, safeAbove: 2.6 },
  "z2-em": { distressBelow: 4.35, safeAbove: 5.85 },
} as const satisfies Record<AltmanVariant, { distressBelow: number; safeAbove: number }>;

/**
 * Zone classification. Boundary convention (deck gives strict inequalities on
 * both sides): scores exactly at a boundary fall in the grey zone.
 */
export function classifyAltmanZone(score: number, variant: AltmanVariant): AltmanZone {
  const z = ALTMAN_ZONES[variant];
  if (score < z.distressBelow) return "distress";
  if (score > z.safeAbove) return "safe";
  return "grey";
}

export interface AltmanComponents {
  /** Working capital / total assets. */
  x1: number | null;
  /** Retained earnings / total assets. */
  x2: number | null;
  /** EBIT / total assets. */
  x3: number | null;
  /** Market (original) or book (private/Z″) equity / total liabilities. */
  x4: number | null;
  /** Sales / total assets (null for Z″ variants — dropped by the model). */
  x5: number | null;
}

export interface AltmanInputs {
  balance: ForensicsBalanceRow;
  income: ForensicsIncomeRow;
  /** Market value of equity, same currency as the statements. Required for `original` X4. */
  marketCap?: number | null;
  /** As-of date of the market cap (should be same-period for historical trends). */
  marketCapAsOf?: string | null;
  /** Statements' reported currency (e.g. inc0.reportedCurrency). */
  reportedCurrency?: string | null;
  /**
   * Trading/quote currency of `marketCap` (e.g. profile.currency). When it differs
   * from `reportedCurrency` (the ADR case), marketCap and the statements are in
   * different currencies, so the market-equity X4 would mix currencies and is NOT
   * computable without an FX rate (which the pipeline lacks). The original variant
   * then suppresses X4/Z rather than emit a wrong number.
   */
  quoteCurrency?: string | null;
}

export interface AltmanResult {
  variant: AltmanVariant;
  score: number | null;
  zone: AltmanZone | null;
  thresholds: { distressBelow: number; safeAbove: number };
  components: AltmanComponents;
  notes: string[];
  gaps: ManifestEntry[];
  asOf: {
    balanceSheet: string | null;
    incomeStatement: string | null;
    marketCap: string | null;
  };
}

/**
 * Compute the requested Altman variant. Missing inputs produce a null score
 * plus gaps — never a throw. X4 saturates at ±20 (house rule) when total
 * liabilities are ~0 or ratios explode.
 */
export function computeAltman(inputs: AltmanInputs, variant: AltmanVariant): AltmanResult {
  const notes: string[] = [];
  const gaps: ManifestEntry[] = [];
  const coeffs = ALTMAN_COEFFICIENTS[variant];
  const thresholds = ALTMAN_ZONES[variant];
  const b = inputs.balance;
  const inc = inputs.income;
  const components: AltmanComponents = { x1: null, x2: null, x3: null, x4: null, x5: null };
  const asOf = {
    balanceSheet: b.date ?? null,
    incomeStatement: inc.date ?? null,
    marketCap: inputs.marketCapAsOf ?? null,
  };
  const result = (score: number | null): AltmanResult => ({
    variant,
    score,
    zone: score !== null ? classifyAltmanZone(score, variant) : null,
    thresholds,
    components,
    notes,
    gaps,
    asOf,
  });

  const ta = posOrNull(b.totalAssets);
  if (ta === null) {
    gaps.push(
      gapEntry(
        "forensics.altman.totalAssets",
        "totalAssets missing or non-positive — Z-score not computable",
        "critical",
      ),
    );
    return result(null);
  }

  let missing = false;

  // X1 — working capital / TA
  const ca = nv(b.totalCurrentAssets);
  const cl = nv(b.totalCurrentLiabilities);
  if (ca === null || cl === null) {
    missing = true;
    gaps.push(
      gapEntry(
        "forensics.altman.workingCapital",
        "totalCurrentAssets/totalCurrentLiabilities missing (unclassified balance sheet) — Z-score unavailable",
        "warn",
      ),
    );
  } else {
    components.x1 = (ca - cl) / ta;
  }

  // X2 — retained earnings / TA (null → 0 with explicit caveat, research §1.5)
  let re = nv(b.retainedEarnings);
  if (re === null) {
    re = 0;
    notes.push(
      "retainedEarnings missing — treated as 0 for X2 (field-missing caveat; research §1.5 fallback).",
    );
    gaps.push(
      gapEntry(
        "forensics.altman.retainedEarnings",
        "retainedEarnings missing — X2 computed with 0",
        "info",
      ),
    );
  }
  components.x2 = re / ta;

  // X3 — EBIT / TA with fallback chain ebit → operatingIncome → NI + tax + interest
  let ebit = nv(inc.ebit);
  if (ebit === null) {
    ebit = nv(inc.operatingIncome);
    if (ebit !== null) notes.push("EBIT missing — operatingIncome used for X3 (fallback).");
  }
  if (ebit === null) {
    const ni = nv(inc.netIncome);
    const tax = nv(inc.incomeTaxExpense);
    const interest = zeroAsNull(inc.interestExpense); // 0 = FMP undisclosed artifact
    if (ni !== null && tax !== null && interest !== null) {
      ebit = ni + tax + interest;
      notes.push(
        "EBIT reconstructed as netIncome + incomeTaxExpense + interestExpense (last-resort fallback).",
      );
    }
  }
  if (ebit === null) {
    missing = true;
    gaps.push(
      gapEntry(
        "forensics.altman.ebit",
        "ebit/operatingIncome missing and EBIT not reconstructable — X3 unavailable",
        "warn",
      ),
    );
  } else {
    components.x3 = ebit / ta;
  }

  // X4 — equity / total liabilities (market equity for original, book otherwise)
  let tl = nv(b.totalLiabilities);
  if (tl === null) {
    const te = nv(b.totalEquity);
    if (te !== null) {
      tl = ta - te;
      notes.push("totalLiabilities missing — derived as totalAssets − totalEquity (fallback).");
    }
  }
  let equityNumerator: number | null = null;
  if (variant === "original") {
    // ADR guard: the original X4 divides market equity by statement-currency total
    // liabilities. If the quote currency differs from the statements' currency
    // (e.g. a US-listed ADR whose books are in TWD), the two operands are in
    // different currencies and X4 is off by the FX rate. We have no FX rate to
    // convert, so suppress X4/Z rather than emit a wrong bankruptcy verdict
    // (mirrors the multiples path's currencyMismatch flag). Fail-safe: only when
    // BOTH currencies are known and differ.
    const currencyMismatch =
      typeof inputs.quoteCurrency === "string" &&
      typeof inputs.reportedCurrency === "string" &&
      inputs.quoteCurrency.toUpperCase() !== inputs.reportedCurrency.toUpperCase();
    if (currencyMismatch) {
      equityNumerator = null;
      notes.push(
        `ADR/currency mismatch: statements in ${inputs.reportedCurrency}, market cap in ${inputs.quoteCurrency} — original-variant X4 (market value of equity) would mix currencies; suppressed pending FX conversion.`,
      );
      gaps.push(
        gapEntry(
          "forensics.altman.currency",
          `reportedCurrency ${inputs.reportedCurrency} != quote currency ${inputs.quoteCurrency} (ADR case) — market-equity X4 needs FX conversion (pending); original-variant Z suppressed`,
          "warn",
        ),
      );
    } else {
      equityNumerator = posOrNull(inputs.marketCap);
      if (equityNumerator === null) {
        gaps.push(
          gapEntry(
            "forensics.altman.marketCap",
            "marketCap missing — original-variant X4 (market value of equity) unavailable",
            "warn",
          ),
        );
      }
    }
  } else {
    equityNumerator = nv(b.totalStockholdersEquity);
    if (equityNumerator === null) {
      const te = nv(b.totalEquity);
      if (te !== null) {
        equityNumerator = te - (nv(b.minorityInterest) ?? 0);
        notes.push(
          "totalStockholdersEquity missing — book equity derived as totalEquity − minorityInterest.",
        );
      }
    }
    if (equityNumerator === null) {
      gaps.push(
        gapEntry(
          "forensics.altman.bookEquity",
          "totalStockholdersEquity/totalEquity missing — book-equity X4 unavailable",
          "warn",
        ),
      );
    } else if (equityNumerator < 0) {
      notes.push(
        "RED flag: negative book equity — X4 is negative (equity wipe-out); economically meaningful, computed as-is.",
      );
    }
  }
  const cap = FORENSICS_HOUSE_RULES.altmanX4Cap;
  if (equityNumerator === null || tl === null) {
    missing = true;
    if (tl === null) {
      gaps.push(
        gapEntry(
          "forensics.altman.totalLiabilities",
          "totalLiabilities missing and not derivable — X4 unavailable",
          "warn",
        ),
      );
    }
  } else if (tl <= 0) {
    components.x4 = equityNumerator >= 0 ? cap : -cap;
    notes.push(
      `House rule: total liabilities <= 0 — X4 saturated at ${components.x4 >= 0 ? "+" : ""}${components.x4} (Altman's model was not built for debt-free extremes; research §6.1).`,
    );
  } else {
    let x4 = equityNumerator / tl;
    if (x4 > cap || x4 < -cap) {
      const clampedTo = x4 > cap ? cap : -cap;
      notes.push(
        `House rule: X4 ${x4.toFixed(2)} clamped to ${clampedTo} (saturation cap ±${cap}; research §6.1).`,
      );
      x4 = clampedTo;
    }
    components.x4 = x4;
  }

  // X5 — sales / TA (only original & private; Z″ drops it)
  if (coeffs.x5 !== 0) {
    const rev = nv(inc.revenue);
    if (rev === null) {
      missing = true;
      gaps.push(
        gapEntry("forensics.altman.revenue", "revenue missing — X5 unavailable", "warn"),
      );
    } else {
      components.x5 = rev / ta;
    }
  } else {
    notes.push(
      "X5 (sales/TA) is dropped by the Z″ model to remove industry asset-turnover effects.",
    );
  }
  if (variant === "z2-em") {
    notes.push(
      "Emerging-markets Z″ includes the +3.25 constant; zones 4.35/5.85 (arithmetically identical to 1.10/2.60 without it).",
    );
  }

  if (missing || components.x4 === null) return result(null);

  const score =
    coeffs.constant +
    coeffs.x1 * (components.x1 as number) +
    coeffs.x2 * (components.x2 as number) +
    coeffs.x3 * (components.x3 as number) +
    coeffs.x4 * (components.x4 as number) +
    (coeffs.x5 !== 0 ? coeffs.x5 * (components.x5 as number) : 0);
  return result(score);
}

export interface AltmanClassification {
  sector?: string | null;
  industry?: string | null;
  /** SIC code as a string (EDGAR submissions `sic` / FMP sec-profile `sicCode`). */
  sicCode?: string | null;
}

export interface AltmanVariantSelection {
  /** null = do not compute (financials — excluded from the Z family). */
  variant: AltmanVariant | null;
  notes: string[];
}

/**
 * Variant-selection rule (research §1.4):
 * - financials (bank/insurer routes, mortgage REITs, sector "Financial
 *   Services", SIC 6000–6799) → no Z-score, with an explanatory note;
 * - SIC 2000–3999 → manufacturer → original 1968 Z;
 * - emerging-market listing → Z″ + 3.25 constant (zones 4.35/5.85);
 * - everything else → Z″ without the constant (zones 1.10/2.60).
 * Without a SIC code, manufacturer status is inferred from sector/industry
 * strings (house heuristic, annotated).
 */
export function selectAltmanVariant(
  route: CompanyRoute,
  classification?: AltmanClassification,
  isEmergingMarket = false,
): AltmanVariantSelection {
  const notes: string[] = [];
  const sector = classification?.sector ?? route.evidence.sector;
  const industry = classification?.industry ?? route.evidence.industry;
  const sicRaw = classification?.sicCode ?? route.evidence.sic ?? null;
  const sicNum =
    sicRaw !== null && sicRaw !== undefined && sicRaw.trim() !== "" && Number.isFinite(Number(sicRaw))
      ? Number(sicRaw)
      : null;

  if (route.base === "bank" || route.base === "insurer") {
    notes.push(
      "Altman Z is not defined for financial companies — banks/insurers were excluded from every Z-model estimation sample (deposit-funded leverage makes X1/X4 meaningless). Showing sector health metrics instead.",
    );
    return { variant: null, notes };
  }
  if (route.base === "reit-mortgage") {
    notes.push(
      "Altman Z not computed for mortgage REITs — financially structured (SIC 6500–6799 range falls inside Altman's financial exclusion).",
    );
    return { variant: null, notes };
  }
  if (sector !== null && sector !== undefined && sector.trim().toLowerCase() === "financial services") {
    notes.push(
      'Altman Z not computed: FMP sector "Financial Services" (financials excluded from the Z family; research §6.3).',
    );
    return { variant: null, notes };
  }
  if (sicNum !== null && sicNum >= 6000 && sicNum <= 6799 && route.base !== "reit") {
    notes.push(
      `Altman Z not computed: SIC ${sicNum} is in the financial range 6000–6799 (research §6.3 classifier).`,
    );
    return { variant: null, notes };
  }

  let manufacturer = false;
  if (sicNum !== null) {
    manufacturer = sicNum >= 2000 && sicNum <= 3999;
    notes.push(
      `Variant selected by SIC ${sicNum}: ${manufacturer ? "manufacturer (2000–3999) → original 1968 Z" : "non-manufacturer → Z″"}.`,
    );
  } else {
    const sectorIsManufacturing =
      sector !== null &&
      sector !== undefined &&
      ["industrials", "basic materials"].includes(sector.trim().toLowerCase());
    const industryIsManufacturing =
      industry !== null && industry !== undefined && /manufactur/i.test(industry);
    manufacturer = sectorIsManufacturing || industryIsManufacturing;
    notes.push(
      `House heuristic: no SIC code available — manufacturer status inferred from sector/industry strings (${manufacturer ? "manufacturer → original Z" : "non-manufacturer → Z″"}).`,
    );
  }

  if (route.base === "reit") {
    notes.push(
      "Caution: equity REITs typically carry SIC 6500–6798 (inside Altman's financial exclusion range under a strict SIC rule) — Z″ shown per SPEC routing but interpret with caution.",
    );
  }

  if (isEmergingMarket) {
    notes.push(
      "Emerging-market listing — Z″ + 3.25 (Altman–Hartzell–Peck 1995) used regardless of manufacturer status; zones 4.35/5.85.",
    );
    return { variant: "z2-em", notes };
  }
  return { variant: manufacturer ? "original" : "z2", notes };
}

// ===========================================================================
// 2. Beneish M-Score — 8-variable unweighted-probit model
// ===========================================================================

/**
 * Verified against Beneish (1999) Table 3 Panel A. TATA coefficient is 4.679
 * (the circulating 4.697 is a transcription error). The 5-variable model has
 * no primary source and is deliberately NOT implemented (research §2.4).
 */
export const BENEISH_COEFFICIENTS = {
  intercept: -4.84,
  dsri: 0.92,
  gmi: 0.528,
  aqi: 0.404,
  sgi: 0.892,
  depi: 0.115,
  sgai: -0.172,
  tata: 4.679,
  lvgi: -0.327,
} as const;

/** Both published conventions; three-band display rule (research §2.3). */
export const BENEISH_THRESHOLDS = { unlikelyBelow: -2.22, flagAbove: -1.78 } as const;

export type BeneishVerdict = "unlikely" | "grey" | "flag";

/** M < −2.22 → unlikely; −2.22 ≤ M ≤ −1.78 → grey; M > −1.78 → flag. */
export function classifyBeneishVerdict(m: number): BeneishVerdict {
  if (m < BENEISH_THRESHOLDS.unlikelyBelow) return "unlikely";
  if (m > BENEISH_THRESHOLDS.flagAbove) return "flag";
  return "grey";
}

export type BeneishIndexName =
  | "DSRI"
  | "GMI"
  | "AQI"
  | "SGI"
  | "DEPI"
  | "SGAI"
  | "TATA"
  | "LVGI";

export interface BeneishIndices {
  dsri: number | null;
  gmi: number | null;
  aqi: number | null;
  sgi: number | null;
  depi: number | null;
  sgai: number | null;
  /** Level (not an index); cash-flow construction (NI continuing − CFO)/TA_t. */
  tata: number | null;
  lvgi: number | null;
}

export interface BeneishResult {
  score: number | null;
  verdict: BeneishVerdict | null;
  /** Values actually used in M (after neutralization/clamping). */
  indices: BeneishIndices;
  /** Diagnostic-only balance-sheet TATA (Hribar–Collins caveats apply). */
  tataBalanceSheet: number | null;
  /** Indices set to neutral 1.0 (Beneish's own missing-data convention). */
  neutralized: BeneishIndexName[];
  /** Indices clamped by the winsorization stand-in (house rule). */
  clamped: BeneishIndexName[];
  notes: string[];
  gaps: ManifestEntry[];
  asOf: { current: string | null; prior: string | null };
}

/**
 * Beneish M on two consecutive fiscal years (annual data only — quarterly is
 * non-canonical). Missing index inputs → neutral 1.0 with a note (paper p.12
 * convention). If TATA is not computable, M is reported unavailable (it
 * carries the largest coefficient). Not valid for financial companies —
 * suppression happens in runForensics.
 */
export function computeBeneish(current: ForensicsPeriod, prior: ForensicsPeriod): BeneishResult {
  const notes: string[] = [];
  const gaps: ManifestEntry[] = [];
  const neutralized: BeneishIndexName[] = [];
  const clamped: BeneishIndexName[] = [];
  const indices: BeneishIndices = {
    dsri: null,
    gmi: null,
    aqi: null,
    sgi: null,
    depi: null,
    sgai: null,
    tata: null,
    lvgi: null,
  };
  const asOf = { current: periodDate(current), prior: periodDate(prior) };
  const base = (score: number | null): BeneishResult => ({
    score,
    verdict: score !== null ? classifyBeneishVerdict(score) : null,
    indices,
    tataBalanceSheet: null,
    neutralized,
    clamped,
    notes,
    gaps,
    asOf,
  });

  const salesT = posOrNull(current.income?.revenue);
  const salesP = posOrNull(prior.income?.revenue);
  if (salesT === null || salesP === null) {
    gaps.push(
      gapEntry(
        "forensics.beneish",
        "pre-revenue/near-zero or undisclosed revenue — manipulation indices not meaningful (research §6.1)",
        "warn",
      ),
    );
    return base(null);
  }

  // --- raw index construction (null = not computable) ---

  // DSRI — same receivables field in BOTH years (accountsReceivables preferred)
  let recT: number | null = null;
  let recP: number | null = null;
  const arT = nv(current.balance?.accountsReceivables);
  const arP = nv(prior.balance?.accountsReceivables);
  if (arT !== null && arP !== null) {
    recT = arT;
    recP = arP;
  } else {
    const nrT = nv(current.balance?.netReceivables);
    const nrP = nv(prior.balance?.netReceivables);
    if (nrT !== null && nrP !== null) {
      recT = nrT;
      recP = nrP;
      notes.push(
        "DSRI computed on netReceivables (accountsReceivables unavailable in both years) — same field used in both years.",
      );
    }
  }
  const dsriRaw = div(div(recT, salesT), div(recP, salesP));

  // GMI — prior-year margin in the NUMERATOR (deterioration ⇒ GMI > 1)
  const gmT = grossMarginRatio(current.income, salesT);
  const gmP = grossMarginRatio(prior.income, salesP);
  let gmiRaw: number | null = null;
  let gmiNegative = false;
  if (gmT !== null && gmP !== null) {
    if (gmT <= 0 || gmP <= 0) {
      gmiNegative = true;
    } else {
      gmiRaw = gmP / gmT;
    }
  }

  // AQI — AQ = 1 − (CA + net PPE)/TA
  const assetQuality = (bal: ForensicsBalanceRow | null | undefined): number | null => {
    const ca = nv(bal?.totalCurrentAssets);
    const ppe = nv(bal?.propertyPlantEquipmentNet);
    const ta = posOrNull(bal?.totalAssets);
    if (ca === null || ppe === null || ta === null) return null;
    return 1 - (ca + ppe) / ta;
  };
  const aqT = assetQuality(current.balance);
  const aqP = assetQuality(prior.balance);
  let aqiRaw: number | null = null;
  let aqiZeroDenominator = false;
  if (aqT !== null && aqP !== null) {
    if (Math.abs(aqP) < 1e-12) {
      aqiZeroDenominator = true; // Beneish's own convention: AQI = 1
    } else {
      aqiRaw = aqT / aqP;
    }
  }

  // SGI
  const sgiRaw = salesT / salesP;

  // DEPI — depreciation rate slowdown ⇒ DEPI > 1; CF D&A preferred, IS fallback
  const depRate = (p: ForensicsPeriod): number | null => {
    const da =
      posOrNull(p.cashFlow?.depreciationAndAmortization) ??
      posOrNull(p.income?.depreciationAndAmortization);
    const ppe = nv(p.balance?.propertyPlantEquipmentNet);
    if (da === null || ppe === null) return null;
    const den = da + ppe;
    return den > 0 ? da / den : null;
  };
  const drT = depRate(current);
  const drP = depRate(prior);
  const depiRaw = drT !== null && drP !== null && drT > 0 ? drP / drT : null;

  // SGAI — SG&A zero treated as undisclosed; fallback G&A + S&M
  const sgaOf = (row: ForensicsIncomeRow | null | undefined): number | null => {
    const combined = zeroAsNull(row?.sellingGeneralAndAdministrativeExpenses);
    if (combined !== null) return combined;
    const ga = zeroAsNull(row?.generalAndAdministrativeExpenses);
    const sm = zeroAsNull(row?.sellingAndMarketingExpenses);
    if (ga === null && sm === null) return null;
    return (ga ?? 0) + (sm ?? 0);
  };
  const sgaT = sgaOf(current.income);
  const sgaP = sgaOf(prior.income);
  if (
    sgaT !== null &&
    zeroAsNull(current.income?.sellingGeneralAndAdministrativeExpenses) === null
  ) {
    notes.push(
      "SGAI: SG&A built from generalAndAdministrativeExpenses + sellingAndMarketingExpenses (combined field unavailable/zero).",
    );
  }
  const sgaiRaw = div(div(sgaT, salesT), div(sgaP, salesP));

  // LVGI — (LTD + current liabilities)/TA
  const leverage = (bal: ForensicsBalanceRow | null | undefined): number | null => {
    const ltd = nv(bal?.longTermDebt);
    const cl = nv(bal?.totalCurrentLiabilities);
    const ta = posOrNull(bal?.totalAssets);
    if (ltd === null || cl === null || ta === null) return null;
    return (ltd + cl) / ta;
  };
  const levT = leverage(current.balance);
  const levP = leverage(prior.balance);
  const lvgiRaw = levT !== null && levP !== null && levP > 0 ? levT / levP : null;

  // TATA — PRIMARY: cash-flow construction (Hribar–Collins; Thesis decision §2.2)
  const niT = continuingNetIncome(current.income);
  if (niT !== null && nv(current.income?.netIncomeFromContinuingOperations) === null) {
    notes.push("TATA: netIncomeFromContinuingOperations unavailable — netIncome used (fallback).");
  }
  const cfoT = nv(current.cashFlow?.netCashProvidedByOperatingActivities);
  const taT = posOrNull(current.balance?.totalAssets);
  let tata: number | null = null;
  if (niT !== null && cfoT !== null && taT !== null) {
    tata = (niT - cfoT) / taT;
    notes.push(
      "TATA uses the cash-flow construction (NI from continuing ops − CFO)/TA_t (Hribar–Collins 2002); balance-sheet construction reported as diagnostic only.",
    );
    const { min, max } = FORENSICS_HOUSE_RULES.beneishTataClamp;
    if (tata < min || tata > max) {
      const to = tata < min ? min : max;
      notes.push(
        `House rule: TATA ${tata.toFixed(4)} clamped to ${to} (level-variable winsorization stand-in [${min}, ${max}]).`,
      );
      clamped.push("TATA");
      tata = to;
    }
  } else {
    gaps.push(
      gapEntry(
        "forensics.beneish.tata",
        "TATA not computable (needs net income, operating cash flow, total assets) — M-score unavailable: TATA carries the largest coefficient (research §2.4)",
        "critical",
      ),
    );
  }

  // Diagnostic balance-sheet TATA (original 1999 Table 2 construction)
  let tataBalanceSheet: number | null = null;
  {
    const dCA = delta(current.balance?.totalCurrentAssets, prior.balance?.totalCurrentAssets);
    const dCash = delta(
      current.balance?.cashAndShortTermInvestments,
      prior.balance?.cashAndShortTermInvestments,
    );
    const dCL = delta(
      current.balance?.totalCurrentLiabilities,
      prior.balance?.totalCurrentLiabilities,
    );
    const dSTD = delta(current.balance?.shortTermDebt, prior.balance?.shortTermDebt);
    const dTP = delta(current.balance?.taxPayables, prior.balance?.taxPayables);
    const daT = nv(current.cashFlow?.depreciationAndAmortization);
    if (
      dCA !== null &&
      dCash !== null &&
      dCL !== null &&
      dSTD !== null &&
      dTP !== null &&
      daT !== null &&
      taT !== null
    ) {
      tataBalanceSheet = (dCA - dCash - (dCL - dSTD - dTP) - daT) / taT;
      notes.push(
        "Diagnostic balance-sheet TATA uses shortTermDebt as a proxy for current maturities of LTD (broader — includes notes payable).",
      );
    }
  }

  // --- neutralization (Beneish's own convention, p.12) + clamping (house rule) ---
  const { min: clampMin, max: clampMax } = FORENSICS_HOUSE_RULES.beneishIndexClamp;
  const resolveIndex = (
    name: BeneishIndexName,
    raw: number | null,
    neutralReason?: string,
  ): number => {
    if (raw === null) {
      neutralized.push(name);
      notes.push(
        `${name} set to neutral 1.0 — ${neutralReason ?? "inputs missing"} (Beneish's own missing-data convention, paper p.12).`,
      );
      return 1;
    }
    if (raw < clampMin || raw > clampMax) {
      const to = raw < clampMin ? clampMin : clampMax;
      clamped.push(name);
      notes.push(
        `House rule: ${name} ${raw.toFixed(4)} clamped to ${to} (winsorization stand-in [${clampMin}, ${clampMax}]; research §2.5).`,
      );
      return to;
    }
    return raw;
  };

  if (gmiNegative) {
    notes.push(
      "RED flag: negative gross margin in at least one year — economically worse than any GMI reading; GMI neutralized (research §6.1).",
    );
  }
  indices.dsri = resolveIndex("DSRI", dsriRaw);
  indices.gmi = resolveIndex("GMI", gmiRaw, gmiNegative ? "negative gross margin" : undefined);
  indices.aqi = resolveIndex(
    "AQI",
    aqiZeroDenominator ? null : aqiRaw,
    aqiZeroDenominator ? "prior-year asset-quality denominator is zero" : undefined,
  );
  indices.sgi = resolveIndex("SGI", sgiRaw);
  indices.depi = resolveIndex("DEPI", depiRaw);
  indices.sgai = resolveIndex("SGAI", sgaiRaw);
  indices.lvgi = resolveIndex("LVGI", lvgiRaw);
  indices.tata = tata;

  let score: number | null = null;
  if (tata !== null) {
    const c = BENEISH_COEFFICIENTS;
    score =
      c.intercept +
      c.dsri * indices.dsri +
      c.gmi * indices.gmi +
      c.aqi * indices.aqi +
      c.sgi * indices.sgi +
      c.depi * indices.depi +
      c.sgai * indices.sgai +
      c.tata * tata +
      c.lvgi * indices.lvgi;
    notes.push(
      "The model detects overstatement, not understatement — a very negative M does not prove conservative accounting.",
    );
  }

  const out = base(score);
  return { ...out, tataBalanceSheet };
}

// ===========================================================================
// 3. Piotroski F-Score — 9 binary signals, paper denominators
// ===========================================================================

export type PiotroskiSignalName =
  | "roaPositive"
  | "cfoPositive"
  | "roaImproved"
  | "accrualQuality"
  | "leverageDown"
  | "liquidityUp"
  | "noEquityIssuance"
  | "marginUp"
  | "turnoverUp";

export interface PiotroskiSignal {
  /** 1 = pass, 0 = fail, null = not evaluable (excluded from outOf). */
  value: 0 | 1 | null;
  detail: string;
}

export interface PiotroskiOptions {
  /**
   * Equity-issuance de-minimis (statement currency units). Default 0 =
   * paper-strict "no common equity issued". The research notes leave a 1%-of-
   * market-cap tolerance as an open question — any non-zero value is a house
   * rule and gets annotated.
   */
  equityIssuanceDeMinimis?: number;
}

export interface PiotroskiResult {
  score: number | null;
  /** Number of evaluable signals (9 with 3 fiscal years, 7 with 2). */
  outOf: number;
  signals: Record<PiotroskiSignalName, PiotroskiSignal>;
  notes: string[];
  gaps: ManifestEntry[];
  asOf: { current: string | null; prior: string | null; prior2: string | null };
}

/**
 * Piotroski (2000) §2.3 — exact paper denominators: beginning-of-year total
 * assets for ROA/CFO/accrual/turnover, AVERAGE total assets for leverage.
 * With only 2 fiscal years, ΔROA and Δturnover are omitted and the score is
 * reported out of 7 (research §6.2).
 */
export function computePiotroski(
  current: ForensicsPeriod,
  prior: ForensicsPeriod,
  prior2?: ForensicsPeriod | null,
  options?: PiotroskiOptions,
): PiotroskiResult {
  const notes: string[] = [];
  const gaps: ManifestEntry[] = [];
  const na = (detail: string): PiotroskiSignal => ({ value: null, detail });
  const sig = (pass: boolean, detail: string): PiotroskiSignal => ({
    value: pass ? 1 : 0,
    detail,
  });

  const taBeginT = posOrNull(prior.balance?.totalAssets); // TA at end of t−1
  const taBeginP = prior2 ? posOrNull(prior2.balance?.totalAssets) : null; // TA at end of t−2
  const niT = continuingNetIncome(current.income);
  const niP = continuingNetIncome(prior.income);
  const cfoT = nv(current.cashFlow?.netCashProvidedByOperatingActivities);
  const revT = posOrNull(current.income?.revenue);
  const revP = posOrNull(prior.income?.revenue);

  // 1. F_ROA — NI before extraordinary items / beginning-of-year TA > 0
  const roaT = div(niT, taBeginT);
  const s1 =
    roaT !== null
      ? sig(roaT > 0, `ROA ${(roaT * 100).toFixed(2)}% (NI / beginning-of-year TA)`)
      : na("net income or beginning-of-year total assets missing");

  // 2. F_CFO — CFO / beginning-of-year TA > 0
  const cfoScaled = div(cfoT, taBeginT);
  const s2 =
    cfoScaled !== null
      ? sig(cfoScaled > 0, `CFO/TA_begin ${(cfoScaled * 100).toFixed(2)}%`)
      : na("operating cash flow or beginning-of-year total assets missing");

  // 3. F_ΔROA — needs TA at t−2 (3rd fiscal year)
  let s3: PiotroskiSignal;
  const roaP = div(niP, taBeginP);
  if (!prior2) {
    s3 = na("requires total assets at t−2 (3rd fiscal year) — omitted");
  } else if (roaT === null || roaP === null) {
    s3 = na("prior-year ROA not computable (missing NI or TA at t−2)");
  } else {
    s3 = sig(
      roaT > roaP,
      `ΔROA ${((roaT - roaP) * 100).toFixed(2)}pp (${(roaP * 100).toFixed(2)}% → ${(roaT * 100).toFixed(2)}%)`,
    );
  }

  // 4. F_ACCRUAL — CFO > ROA on the same TA_begin denominator ⇔ CFO_t > NI_t
  const s4 =
    niT !== null && cfoT !== null && taBeginT !== null
      ? sig(cfoT > niT, `CFO ${cfoT} vs NI ${niT} (accruals ${niT - cfoT < 0 ? "<" : ">="} 0)`)
      : na("net income, CFO, or beginning-of-year total assets missing");

  // 5. F_ΔLEVER — LTD / AVERAGE total assets fell (paper uses average TA here)
  let s5: PiotroskiSignal;
  {
    const ltdT = nv(current.balance?.longTermDebt);
    const ltdP = nv(prior.balance?.longTermDebt);
    const taT = posOrNull(current.balance?.totalAssets);
    const taP = posOrNull(prior.balance?.totalAssets);
    if (ltdT === null || ltdP === null || taT === null || taP === null) {
      s5 = na("longTermDebt or totalAssets missing");
    } else if (ltdT === 0 && ltdP === 0) {
      s5 = sig(true, "zero long-term debt in both years — point awarded");
      notes.push(
        "ΔLEVER: zero long-term debt in both years — point awarded (no deterioration; common-practice convention, non-canonical detail).",
      );
    } else {
      const avgT = (taT + taP) / 2;
      let avgP: number;
      if (taBeginP !== null) {
        avgP = (taP + taBeginP) / 2;
      } else {
        avgP = taP;
        notes.push(
          "ΔLEVER: prior-year average TA proxied by end-of-year TA (no t−2 balance sheet) — annotated proxy.",
        );
      }
      const lT = ltdT / avgT;
      const lP = ltdP / avgP;
      s5 = sig(
        lT < lP,
        `LTD/avg TA ${(lP * 100).toFixed(2)}% → ${(lT * 100).toFixed(2)}% (average-TA denominator per the paper)`,
      );
    }
  }

  // 6. F_ΔLIQUID — current ratio rose
  const crT = div(nv(current.balance?.totalCurrentAssets), posOrNull(current.balance?.totalCurrentLiabilities));
  const crP = div(nv(prior.balance?.totalCurrentAssets), posOrNull(prior.balance?.totalCurrentLiabilities));
  const s6 =
    crT !== null && crP !== null
      ? sig(crT > crP, `current ratio ${crP.toFixed(2)} → ${crT.toFixed(2)}`)
      : na("current assets/liabilities missing");

  // 7. EQ_OFFER — no common equity issued (CF commonStockIssuance)
  let s7: PiotroskiSignal;
  {
    const deMin = options?.equityIssuanceDeMinimis ??
      FORENSICS_HOUSE_RULES.piotroskiEquityIssuanceDeMinimisDefault;
    let iss = nv(current.cashFlow?.commonStockIssuance);
    if (iss === null) {
      iss = 0;
      notes.push(
        "EQ_OFFER: commonStockIssuance missing — treated as no issuance (verify against diluted share-count trend).",
      );
      gaps.push(
        gapEntry(
          "forensics.piotroski.commonStockIssuance",
          "commonStockIssuance missing — equity-issuance test assumed no issuance",
          "info",
        ),
      );
    }
    if (deMin > 0) {
      notes.push(
        `House rule: equity-issuance de-minimis of ${deMin} applied (paper is strict no-issuance; threshold left open in research notes).`,
      );
    }
    s7 = sig(iss <= deMin, `commonStockIssuance ${iss}${deMin > 0 ? ` vs de-minimis ${deMin}` : ""}`);
  }

  // 8. F_ΔMARGIN — gross margin ratio rose
  const gmT = grossMarginRatio(current.income, revT);
  const gmP = grossMarginRatio(prior.income, revP);
  const s8 =
    gmT !== null && gmP !== null
      ? sig(gmT > gmP, `gross margin ${(gmP * 100).toFixed(2)}% → ${(gmT * 100).toFixed(2)}%`)
      : na("gross margin not computable (revenue/grossProfit/costOfRevenue missing)");

  // 9. F_ΔTURN — sales / beginning-of-year TA rose (needs TA at t−2)
  let s9: PiotroskiSignal;
  if (!prior2) {
    s9 = na("requires total assets at t−2 (3rd fiscal year) — omitted");
  } else {
    const turnT = div(revT, taBeginT);
    const turnP = div(revP, taBeginP);
    s9 =
      turnT !== null && turnP !== null
        ? sig(
            turnT > turnP,
            `asset turnover ${turnP.toFixed(3)} → ${turnT.toFixed(3)} (beginning-of-year TA denominators per the paper)`,
          )
        : na("revenue or beginning-of-year total assets missing");
  }

  if (!prior2) {
    notes.push(
      "Only 2 fiscal years supplied — ΔROA and Δturnover unavailable; F-score reported out of 7 (research §6.2).",
    );
  }

  const signals: Record<PiotroskiSignalName, PiotroskiSignal> = {
    roaPositive: s1,
    cfoPositive: s2,
    roaImproved: s3,
    accrualQuality: s4,
    leverageDown: s5,
    liquidityUp: s6,
    noEquityIssuance: s7,
    marginUp: s8,
    turnoverUp: s9,
  };

  let score: number | null = null;
  let outOf = 0;
  for (const s of Object.values(signals)) {
    if (s.value !== null) {
      outOf += 1;
      score = (score ?? 0) + s.value;
    }
  }
  if (outOf < 9) {
    const missing = (Object.entries(signals) as [PiotroskiSignalName, PiotroskiSignal][])
      .filter(([, s]) => s.value === null)
      .map(([name]) => name);
    gaps.push(
      gapEntry(
        "forensics.piotroski",
        `signals not evaluable: ${missing.join(", ")} — score reported out of ${outOf}`,
        "info",
      ),
    );
  }

  return {
    score,
    outOf,
    signals,
    notes,
    gaps,
    asOf: {
      current: periodDate(current),
      prior: periodDate(prior),
      prior2: prior2 ? periodDate(prior2) : null,
    },
  };
}

// ===========================================================================
// 4. Accrual ratios (Sloan / Richardson et al. / CFA formulations)
// ===========================================================================

export type AccrualBand = "unremarkable" | "elevated" | "red";
export type AccrualScaler = "avgNOA" | "avgTotalAssets";

/** House-rule bands (research §4.3 — heuristic, not canonical). */
export function classifyAccrualBand(ratio: number): AccrualBand {
  const a = Math.abs(ratio);
  if (a < FORENSICS_HOUSE_RULES.accrualElevatedBand) return "unremarkable";
  if (a < FORENSICS_HOUSE_RULES.accrualRedBand) return "elevated";
  return "red";
}

export interface AccrualsResult {
  /** PRIMARY: (NI − CFO − CFI) / scaler (cash-flow approach, Hribar–Collins). */
  cashFlowAccrualRatio: number | null;
  /** SECONDARY: ΔNOA / scaler (balance-sheet approach). */
  balanceSheetAccrualRatio: number | null;
  aggregateAccrualsCashFlow: number | null;
  aggregateAccrualsBalanceSheet: number | null;
  noaCurrent: number | null;
  noaPrior: number | null;
  scaler: AccrualScaler | null;
  scalerValue: number | null;
  /** Band on the primary (cash-flow) ratio — house rule, annotated. */
  band: AccrualBand | null;
  notes: string[];
  gaps: ManifestEntry[];
  asOf: { current: string | null; prior: string | null };
}

/**
 * NOA = (totalAssets − cashAndShortTermInvestments) − (totalLiabilities − totalDebt).
 * Primary ratio is the cash-flow construction; balance-sheet ratio is a
 * secondary diagnostic (large divergence between the two is itself an M&A/FX
 * signal). NOA ≤ 0 → rescale by average total assets (annotated).
 */
export function computeAccruals(current: ForensicsPeriod, prior: ForensicsPeriod): AccrualsResult {
  const notes: string[] = [];
  const gaps: ManifestEntry[] = [];

  const noaOf = (bal: ForensicsBalanceRow | null | undefined): number | null => {
    const ta = nv(bal?.totalAssets);
    const cash = nv(bal?.cashAndShortTermInvestments);
    const tl = nv(bal?.totalLiabilities);
    const debt = nv(bal?.totalDebt);
    if (ta === null || cash === null || tl === null || debt === null) return null;
    return ta - cash - (tl - debt);
  };
  const noaT = noaOf(current.balance);
  const noaP = noaOf(prior.balance);
  const taT = posOrNull(current.balance?.totalAssets);
  const taP = posOrNull(prior.balance?.totalAssets);

  const niT = nv(current.cashFlow?.netIncome) ?? nv(current.income?.netIncome);
  const cfoT = nv(current.cashFlow?.netCashProvidedByOperatingActivities);
  const cfiT = nv(current.cashFlow?.netCashProvidedByInvestingActivities);

  const aggCF = niT !== null && cfoT !== null && cfiT !== null ? niT - cfoT - cfiT : null;
  if (aggCF === null) {
    gaps.push(
      gapEntry(
        "forensics.accruals.cashFlow",
        "netIncome/CFO/CFI missing — cash-flow aggregate accruals unavailable",
        "warn",
      ),
    );
  }
  const aggBS = noaT !== null && noaP !== null ? noaT - noaP : null;
  if (aggBS === null) {
    gaps.push(
      gapEntry(
        "forensics.accruals.balanceSheet",
        "NOA inputs (totalAssets, cashAndShortTermInvestments, totalLiabilities, totalDebt) missing in one or both years",
        "info",
      ),
    );
  }

  // Scaler: average NOA; fall back to average TA when NOA ≤ 0 or unavailable
  let scaler: AccrualScaler | null = null;
  let scalerValue: number | null = null;
  const avgNoa = noaT !== null && noaP !== null ? (noaT + noaP) / 2 : null;
  if (avgNoa !== null && avgNoa > 0) {
    scaler = "avgNOA";
    scalerValue = avgNoa;
  } else if (taT !== null && taP !== null) {
    scaler = "avgTotalAssets";
    scalerValue = (taT + taP) / 2;
    notes.push(
      "House rule: NOA ≤ 0 or unavailable — accrual ratios rescaled by average total assets (research §4.3 edge case).",
    );
  } else {
    gaps.push(
      gapEntry(
        "forensics.accruals.scaler",
        "neither average NOA nor average total assets available — accrual ratios not computable",
        "warn",
      ),
    );
  }

  const cfRatio = div(aggCF, scalerValue);
  const bsRatio = div(aggBS, scalerValue);
  const band = cfRatio !== null ? classifyAccrualBand(cfRatio) : null;
  if (band !== null) {
    notes.push(
      "House-rule bands: |ratio| < 10% unremarkable, 10–20% elevated, > 20% red flag (heuristic — Sloan 1996 is a decile-ranking result with no canonical bright line).",
    );
  }
  if (
    cfRatio !== null &&
    bsRatio !== null &&
    Math.abs(cfRatio - bsRatio) > FORENSICS_HOUSE_RULES.accrualDivergence
  ) {
    notes.push(
      `Cash-flow vs balance-sheet accrual ratios diverge by ${(Math.abs(cfRatio - bsRatio) * 100).toFixed(1)}pp — balance-sheet deltas may reflect M&A/divestiture/FX rather than earnings quality (Hribar–Collins 2002); house-rule divergence threshold 10pp.`,
    );
  }

  return {
    cashFlowAccrualRatio: cfRatio,
    balanceSheetAccrualRatio: bsRatio,
    aggregateAccrualsCashFlow: aggCF,
    aggregateAccrualsBalanceSheet: aggBS,
    noaCurrent: noaT,
    noaPrior: noaP,
    scaler: scalerValue !== null ? scaler : null,
    scalerValue,
    band,
    notes,
    gaps,
    asOf: { current: periodDate(current), prior: periodDate(prior) },
  };
}

// ===========================================================================
// 5. Supporting red flags (plain-English layer)
// ===========================================================================

export type FlagSeverity = "info" | "warn" | "flag";

export interface ForensicFlag {
  id: string;
  severity: FlagSeverity;
  /** Plain-English sentence: numbers first, hedged interpretation second. */
  message: string;
  /** Underlying metric values, full precision. */
  metrics: Record<string, number | null>;
  /** The threshold rule that fired, spelled out. */
  rule: string;
  /** All growth-comparison thresholds here are house heuristics, not canon. */
  heuristic: true;
  /** Statement dates used. */
  asOf: string[];
}

export interface SupportFlagsInputs {
  /** Annual income rows, newest first. */
  income: Array<ForensicsIncomeRow | null>;
  /** Annual balance rows, newest first (levels — NOT cash-flow deltas). */
  balance: Array<ForensicsBalanceRow | null>;
}

export interface SupportFlagsOptions {
  /** Base-year revenue floor below which growth flags are suppressed. */
  revenueFloor?: number;
  /** Whether the first two aligned periods are consecutive fiscal years. */
  periodsConsecutive?: boolean;
}

export interface SupportFlagsResult {
  flags: ForensicFlag[];
  notes: string[];
  gaps: ManifestEntry[];
}

/**
 * Receivables-vs-revenue, inventory-vs-revenue, and one-time-items heuristics
 * (SPEC §4; research §5). Every threshold is a house rule and is repeated in
 * each flag's `rule` string. Growth flags are suppressed when the base-year
 * revenue is below the floor (percentage growth is meaningless).
 */
export function computeSupportFlags(
  inputs: SupportFlagsInputs,
  options?: SupportFlagsOptions,
): SupportFlagsResult {
  const flags: ForensicFlag[] = [];
  const notes: string[] = [];
  const gaps: ManifestEntry[] = [];
  const H = FORENSICS_HOUSE_RULES;
  const floor = options?.revenueFloor ?? H.revenueFloor;

  const incT = inputs.income[0] ?? null;
  const incP = options?.periodsConsecutive === false ? null : (inputs.income[1] ?? null);
  const balT = inputs.balance[0] ?? null;
  const balP = options?.periodsConsecutive === false ? null : (inputs.balance[1] ?? null);

  const revT = nv(incT?.revenue);
  const revPrior = nv(incP?.revenue);
  const growthDates = [incP?.date, incT?.date].filter((d): d is string => typeof d === "string");

  let revGrowth: number | null = null;
  // When revenue growth is not computable we remember WHY, so the receivables-
  // and inventory-vs-revenue growth-gap flags emit a disclosed gap instead of
  // being skipped silently (consistent with the rest of the module).
  let revBaseGap: string | null = null;
  if (revT === null) {
    revBaseGap =
      "latest-year revenue missing — receivables-vs-revenue and inventory-vs-revenue growth-gap flags not evaluated";
  } else if (revPrior === null) {
    revBaseGap =
      "prior-year revenue missing — receivables-vs-revenue and inventory-vs-revenue growth-gap flags not evaluated";
  } else if (revPrior <= 0) {
    notes.push(
      `House rule: prior-year revenue ${revPrior} is non-positive — growth-comparison flags suppressed (percentage growth is meaningless on a non-positive base).`,
    );
    revBaseGap =
      "prior-year revenue non-positive — receivables-vs-revenue and inventory-vs-revenue growth-gap flags not evaluated";
  } else if (revPrior < floor) {
    notes.push(
      `House rule: base-year revenue ${revPrior} below floor ${floor} — growth-comparison flags suppressed (percentage growth is meaningless on a tiny base).`,
    );
    revBaseGap = `prior-year revenue ${revPrior} below floor ${floor} — receivables-vs-revenue and inventory-vs-revenue growth-gap flags suppressed`;
  } else {
    revGrowth = growthPct(revT, revPrior);
  }

  // --- Receivables vs revenue (channel stuffing / loosened credit) ---
  if (incT && incP && balT && balP) {
    // Two aligned periods exist but the revenue base can't scale a growth rate —
    // disclose it as a gap rather than silently returning no flags.
    if (revGrowth === null && revBaseGap !== null) {
      gaps.push(gapEntry("forensics.flags.revenueBase", revBaseGap, "info"));
    }
    let arT = nv(balT.accountsReceivables);
    let arP = nv(balP.accountsReceivables);
    if (arT === null || arP === null) {
      arT = nv(balT.netReceivables);
      arP = nv(balP.netReceivables);
    }
    const arGrowth = growthPct(arT, arP);
    if (arGrowth !== null && revGrowth !== null) {
      const gapPp = arGrowth - revGrowth;
      if (gapPp > H.growthGapWarnPp && arGrowth > H.minGrowthPct) {
        flags.push({
          id: "receivables-vs-revenue",
          severity: gapPp > H.growthGapFlagPp ? "flag" : "warn",
          message: `Receivables grew ${fmt1(arGrowth)}% while revenue grew ${fmt1(revGrowth)}% — possible channel stuffing or loosened credit terms.`,
          metrics: { receivablesGrowthPct: arGrowth, revenueGrowthPct: revGrowth, gapPp },
          rule: `house rule: receivables growth − revenue growth > ${H.growthGapWarnPp}pp (warn) / > ${H.growthGapFlagPp}pp (flag), with receivables growth > ${H.minGrowthPct}%`,
          heuristic: true,
          asOf: growthDates,
        });
      }
    } else if (arT === null || arP === null) {
      gaps.push(
        gapEntry(
          "forensics.flags.receivables",
          "accountsReceivables/netReceivables missing — receivables-vs-revenue flag not evaluated",
          "info",
        ),
      );
    }

    // --- Inventory vs revenue (DIO trend / overhang) ---
    const invT = nv(balT.inventory);
    const invP = nv(balP.inventory);
    const invGrowth = growthPct(invT, invP);
    const rawRevGrowth = growthPct(revT, revPrior);
    if (invGrowth !== null && rawRevGrowth !== null && rawRevGrowth < H.inventoryOverhangRevenueDeclinePct) {
      // Demand collapse mechanically inflates DIO — different message.
      if (invGrowth > 0) {
        flags.push({
          id: "inventory-overhang",
          severity: "info",
          message: `Revenue fell ${fmt1(Math.abs(rawRevGrowth))}% while inventory grew ${fmt1(invGrowth)}% — inventory overhang from a demand decline; growth-gap heuristics suppressed.`,
          metrics: { inventoryGrowthPct: invGrowth, revenueGrowthPct: rawRevGrowth },
          rule: `house rule: growth-gap comparison suppressed when revenue growth < ${H.inventoryOverhangRevenueDeclinePct}%`,
          heuristic: true,
          asOf: growthDates,
        });
      }
    } else if (invGrowth !== null && revGrowth !== null) {
      const gapPp = invGrowth - revGrowth;
      if (gapPp > H.growthGapWarnPp && invGrowth > H.minGrowthPct) {
        flags.push({
          id: "inventory-vs-revenue",
          severity: gapPp > H.growthGapFlagPp ? "flag" : "warn",
          message: `Inventory grew ${fmt1(invGrowth)}% while revenue grew ${fmt1(revGrowth)}% — risk of obsolescence write-downs or over-production absorbing fixed costs into inventory (margin inflation).`,
          metrics: { inventoryGrowthPct: invGrowth, revenueGrowthPct: revGrowth, gapPp },
          rule: `house rule: inventory growth − revenue growth > ${H.growthGapWarnPp}pp (warn) / > ${H.growthGapFlagPp}pp (flag), with inventory growth > ${H.minGrowthPct}%`,
          heuristic: true,
          asOf: growthDates,
        });
      }
    }
  } else {
    gaps.push(
      gapEntry(
        "forensics.flags.growth",
        "fewer than 2 aligned annual income/balance rows — growth-comparison flags not evaluated",
        "info",
      ),
    );
  }

  // --- One-time items (serial "one-timers") ---
  const lookback = inputs.income.slice(0, H.oneTimeLookbackYears);
  // Count DISTINCT fiscal years, not rows: an FMP restatement double-row (same
  // fiscal date twice) must not inflate the evaluated/breach counts and let the
  // serial "one-timer" flag fire on only two genuinely distinct breach years.
  const evaluatedYears = new Set<string>();
  const breachYearSet = new Set<string>();
  let latestShare: number | null = null;
  for (const [i, row] of lookback.entries()) {
    if (row === null) continue;
    const oi = zeroAsNull(row.operatingIncome); // 0 operating income → cannot scale
    const other = nv(row.totalOtherIncomeExpensesNet);
    if (oi === null || other === null) continue;
    const share = Math.abs(other) / Math.abs(oi);
    if (i === 0) latestShare = share;
    if (evaluatedYears.has(row.date)) continue; // duplicate fiscal year — count once
    evaluatedYears.add(row.date);
    if (share > H.oneTimeItemsShareOfOperatingIncome) breachYearSet.add(row.date);
  }
  const evaluated = evaluatedYears.size;
  const breaches = breachYearSet.size;
  const breachYears = [...breachYearSet];
  if (evaluated > 0) {
    if (breaches >= H.oneTimeSerialYears) {
      flags.push({
        id: "serial-one-time-items",
        severity: "flag",
        message: `Non-operating/"other" items exceeded 10% of operating income in ${breaches} of the last ${evaluated} fiscal years — recurring "one-time" charges suggest core profitability may be overstated.`,
        metrics: { breachYearsCount: breaches, evaluatedYears: evaluated },
        rule: `house rule: |totalOtherIncomeExpensesNet| > ${H.oneTimeItemsShareOfOperatingIncome * 100}% of |operatingIncome| in >= ${H.oneTimeSerialYears} of the last ${H.oneTimeLookbackYears} fiscal years`,
        heuristic: true,
        asOf: breachYears,
      });
    } else if (latestShare !== null && latestShare > H.oneTimeItemsShareOfOperatingIncome) {
      flags.push({
        id: "one-time-items",
        severity: "warn",
        message: `"Other" income/expense items were ${fmt1(latestShare * 100)}% of operating income in the latest fiscal year — warrants a check for one-time items.`,
        metrics: { otherItemsShareOfOperatingIncomePct: latestShare * 100 },
        rule: `house rule: |totalOtherIncomeExpensesNet| > ${H.oneTimeItemsShareOfOperatingIncome * 100}% of |operatingIncome|`,
        heuristic: true,
        asOf: incT?.date ? [incT.date] : [],
      });
    }
  }

  // --- Discontinued operations recurring (research §5.4 companion rule) ---
  const discoYears = lookback
    .filter((r): r is ForensicsIncomeRow => {
      if (r === null) return false;
      const d = nv(r.netIncomeFromDiscontinuedOperations);
      return d !== null && d !== 0;
    })
    .map((r) => r.date);
  if (lookback.length > 0 && discoYears.length >= 2) {
    flags.push({
      id: "recurring-discontinued-ops",
      severity: "warn",
      message: `Discontinued operations affected results in ${discoYears.length} of the last ${lookback.length} fiscal years — recurring portfolio churn complicates run-rate earnings.`,
      metrics: { discontinuedOpsYears: discoYears.length, lookbackYears: lookback.length },
      rule: "house rule: netIncomeFromDiscontinuedOperations nonzero in >= 2 of the last 5 fiscal years",
      heuristic: true,
      asOf: discoYears,
    });
  }

  return { flags, notes, gaps };
}

// ===========================================================================
// 6. Orchestration — runForensics
// ===========================================================================

export interface ForensicsInputs {
  /** Annual income statements, newest first (FMP order). */
  income: ForensicsIncomeRow[];
  /** Annual balance sheets, newest first. */
  balance: ForensicsBalanceRow[];
  /** Annual cash-flow statements, newest first. */
  cashFlow: ForensicsCashFlowRow[];
  /** Market value of equity in statement currency (original-variant Altman X4). */
  marketCap?: number | null;
  marketCapAsOf?: string | null;
  /** Statements' reported currency; with quoteCurrency, flags the ADR mismatch for X4. */
  reportedCurrency?: string | null;
  /** Trading/quote currency of marketCap (differs from reportedCurrency for ADRs). */
  quoteCurrency?: string | null;
  /** Overrides route.evidence for variant selection / financial detection. */
  classification?: AltmanClassification;
  isEmergingMarket?: boolean;
  /** Piotroski equity-issuance de-minimis (default 0 = paper-strict). */
  equityIssuanceDeMinimis?: number;
}

/** Maximum statement-date difference allowed within one fiscal period. */
export const FORENSIC_PERIOD_ALIGNMENT_TOLERANCE_DAYS = 7;
/** 52/53-week and conventional annual filers fit inside this continuity window. */
export const CONSECUTIVE_FISCAL_PERIOD_DAYS: readonly [number, number] = [300, 430];
/**
 * A "consecutive" gap shorter than this many days is a materially sub-annual
 * transition stub (e.g. a ~10-month fiscal-year-change period). The window's
 * 300-day floor still accepts it (fail-open per the module's disclose-don't-drop
 * stance), but the YoY comparison built on a stub distorts Beneish/Piotroski
 * deltas, so it is disclosed with a note + gap rather than silently trusted.
 * A normal 52/53-week fiscal year is ~364–371 days; 340 excludes only true stubs.
 */
export const SUB_ANNUAL_CONTINUITY_DISCLOSURE_DAYS = 340;

type StatementKind = "income" | "balance" | "cashFlow";

function fiscalDateEpoch(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const epoch = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(epoch) ? epoch : null;
}

/**
 * Count of finite numeric fields on a statement row — a deterministic
 * completeness proxy used to pick the survivor when two rows share a
 * fiscal-period end (FMP restatement double-rows). The more-complete row wins;
 * ties keep the first-encountered row (rows are processed newest-first).
 */
function rowCompleteness(
  row: ForensicsIncomeRow | ForensicsBalanceRow | ForensicsCashFlowRow,
): number {
  let count = 0;
  for (const value of Object.values(row)) {
    if (typeof value === "number" && Number.isFinite(value)) count += 1;
  }
  return count;
}

/**
 * Join annual statements by fiscal-period end. Rows outside the explicit date
 * tolerance remain in separate periods; they are never cross-paired by index.
 */
export function alignForensicPeriods(
  inputs: Pick<ForensicsInputs, "income" | "balance" | "cashFlow">,
): ForensicsPeriod[] {
  type StatementRow = ForensicsIncomeRow | ForensicsBalanceRow | ForensicsCashFlowRow;
  const records: Array<{ kind: StatementKind; row: StatementRow; epoch: number }> = [];
  const add = (kind: StatementKind, rows: readonly StatementRow[]) => {
    for (const row of rows) {
      const epoch = fiscalDateEpoch(row.date);
      if (epoch !== null) records.push({ kind, row, epoch });
    }
  };
  add("income", inputs.income);
  add("balance", inputs.balance);
  add("cashFlow", inputs.cashFlow);

  const kindOrder: Record<StatementKind, number> = { income: 0, balance: 1, cashFlow: 2 };
  records.sort((a, b) => b.epoch - a.epoch || kindOrder[a.kind] - kindOrder[b.kind]);

  const setSlot = (
    period: Required<ForensicsPeriod>,
    kind: StatementKind,
    row: StatementRow,
  ) => {
    if (kind === "income") period.income = row as ForensicsIncomeRow;
    else if (kind === "balance") period.balance = row as ForensicsBalanceRow;
    else period.cashFlow = row as ForensicsCashFlowRow;
  };

  const toleranceMs = FORENSIC_PERIOD_ALIGNMENT_TOLERANCE_DAYS * 86_400_000;
  const clusters: Array<{ anchorEpoch: number; period: Required<ForensicsPeriod> }> = [];
  for (const record of records) {
    // Attach to the nearest existing cluster within tolerance, EVEN IF that
    // statement kind is already filled. A second same-kind row sharing a
    // fiscal-period end is an FMP restatement double-row (DATA_MAP §1.1): it must
    // be DEDUPED into the existing period, never spawned as a phantom cluster.
    // A phantom would sort between the real consecutive years and gate out every
    // change-based metric (Beneish/Piotroski deltas/accruals/growth flags) with a
    // spurious "not consecutive" reason even though a valid prior year exists.
    const cluster = clusters.find(
      (candidate) => Math.abs(candidate.anchorEpoch - record.epoch) <= toleranceMs,
    );
    if (cluster === undefined) {
      const period: Required<ForensicsPeriod> = { income: null, balance: null, cashFlow: null };
      setSlot(period, record.kind, record.row);
      clusters.push({ anchorEpoch: record.epoch, period });
      continue;
    }
    const existing = cluster.period[record.kind];
    if (existing === null || rowCompleteness(record.row) > rowCompleteness(existing)) {
      setSlot(cluster.period, record.kind, record.row);
    }
  }

  return clusters
    .sort((a, b) => b.anchorEpoch - a.anchorEpoch)
    .map((cluster) => cluster.period);
}

/** Elapsed days between two aligned fiscal periods (current − prior), or null. */
function fiscalPeriodElapsedDays(
  current: ForensicsPeriod,
  prior: ForensicsPeriod,
): number | null {
  const currentDate = periodDate(current);
  const priorDate = periodDate(prior);
  if (currentDate === null || priorDate === null) return null;
  const currentEpoch = fiscalDateEpoch(currentDate);
  const priorEpoch = fiscalDateEpoch(priorDate);
  if (currentEpoch === null || priorEpoch === null) return null;
  return (currentEpoch - priorEpoch) / 86_400_000;
}

function areConsecutiveFiscalPeriods(current: ForensicsPeriod, prior: ForensicsPeriod): boolean {
  const elapsedDays = fiscalPeriodElapsedDays(current, prior);
  if (elapsedDays === null) return false;
  return (
    elapsedDays >= CONSECUTIVE_FISCAL_PERIOD_DAYS[0] &&
    elapsedDays <= CONSECUTIVE_FISCAL_PERIOD_DAYS[1]
  );
}

export interface ForensicsReport {
  altmanSelection: AltmanVariantSelection;
  altman: AltmanResult | null;
  beneish: BeneishResult | null;
  piotroski: PiotroskiResult | null;
  accruals: AccrualsResult | null;
  flags: ForensicFlag[];
  notes: string[];
  /** Aggregated manifest entries from every sub-computation. */
  gaps: ManifestEntry[];
}

/**
 * True when Altman Z / Beneish M / accrual ratios must be suppressed:
 * bank/insurer/mortgage-REIT routes, FMP sector "Financial Services", or
 * SIC 6000–6799 (except the equity-REIT route, which SPEC §6 keeps on the
 * general forensic map with a caution). Piotroski is still computed for
 * financials (all 9 inputs exist) with a validation-sample caveat.
 */
export function isFinancialForensicsSuppressed(
  route: CompanyRoute,
  classification?: AltmanClassification,
): boolean {
  if (route.base === "bank" || route.base === "insurer" || route.base === "reit-mortgage") {
    return true;
  }
  const sector = classification?.sector ?? route.evidence.sector;
  if (sector !== null && sector !== undefined && sector.trim().toLowerCase() === "financial services") {
    return true;
  }
  const sicRaw = classification?.sicCode ?? route.evidence.sic ?? null;
  const sicNum =
    sicRaw !== null && sicRaw !== undefined && sicRaw.trim() !== "" && Number.isFinite(Number(sicRaw))
      ? Number(sicRaw)
      : null;
  return sicNum !== null && sicNum >= 6000 && sicNum <= 6799 && route.base !== "reit";
}

/**
 * Orchestrates the full forensic layer for one company. Statements are joined
 * by fiscal-period date within an explicit tolerance, and every change-based
 * metric requires consecutive annual periods.
 */
export function runForensics(route: CompanyRoute, inputs: ForensicsInputs): ForensicsReport {
  const notes: string[] = [];
  const gaps: ManifestEntry[] = [];

  const periods = alignForensicPeriods(inputs);
  const emptyPeriod = (): ForensicsPeriod => ({ income: null, balance: null, cashFlow: null });
  const cur = periods[0] ?? emptyPeriod();
  const hasPeriod = (p: ForensicsPeriod): boolean =>
    p.income != null || p.balance != null || p.cashFlow != null;
  const priorCandidate = periods[1] ?? emptyPeriod();
  const priorConsecutive = hasPeriod(priorCandidate) && areConsecutiveFiscalPeriods(cur, priorCandidate);
  const pri = priorConsecutive ? priorCandidate : emptyPeriod();
  const prior2Candidate = periods[2] ?? emptyPeriod();
  const pri2 = priorConsecutive && hasPeriod(prior2Candidate) && areConsecutiveFiscalPeriods(pri, prior2Candidate)
    ? prior2Candidate
    : null;

  for (const [index, period] of periods.slice(0, 2).entries()) {
    const missing = (["income", "balance", "cashFlow"] as const).filter((kind) => period[kind] == null);
    if (missing.length > 0) {
      const date = periodDate(period) ?? "unknown";
      notes.push(
        `Statement alignment: fiscal period ${date} has no matched ${missing.join("/")} row within ±${FORENSIC_PERIOD_ALIGNMENT_TOLERANCE_DAYS} days.`,
      );
      gaps.push(
        gapEntry(
          "forensics.statementAlignment",
          `aligned fiscal period ${index + 1} (${date}) missing ${missing.join(", ")} statement row(s)`,
          "warn",
        ),
      );
    }
  }
  if (hasPeriod(priorCandidate) && !priorConsecutive) {
    notes.push(
      `Fiscal continuity: ${periodDate(cur) ?? "latest"} and ${periodDate(priorCandidate) ?? "prior"} are not consecutive annual periods — change-based forensic metrics suppressed.`,
    );
    gaps.push(
      gapEntry(
        "forensics.fiscalContinuity",
        "latest two aligned statement periods are not consecutive fiscal years — Beneish, Piotroski, accrual, and growth-comparison outputs suppressed",
        "warn",
      ),
    );
  } else if (priorConsecutive) {
    // The 300-day floor accepts a sub-annual transition stub as "consecutive".
    // We still compute the YoY forensics (disclose-don't-drop), but flag that the
    // comparison spans a materially sub-annual period so it is read with caution.
    const elapsed = fiscalPeriodElapsedDays(cur, priorCandidate);
    if (elapsed !== null && elapsed < SUB_ANNUAL_CONTINUITY_DISCLOSURE_DAYS) {
      const days = Math.round(elapsed);
      notes.push(
        `Fiscal continuity: ${periodDate(priorCandidate) ?? "prior"} → ${periodDate(cur) ?? "latest"} spans only ~${days} days (materially sub-annual transition stub, < ${SUB_ANNUAL_CONTINUITY_DISCLOSURE_DAYS}d) — Beneish/Piotroski deltas and accruals are computed on a short year; read the YoY comparison with caution.`,
      );
      gaps.push(
        gapEntry(
          "forensics.fiscalContinuity.subAnnual",
          `latest two aligned periods are ~${days} days apart (< ${SUB_ANNUAL_CONTINUITY_DISCLOSURE_DAYS}d) — a sub-annual transition stub; change-based YoY forensic comparisons are distorted`,
          "info",
        ),
      );
    }
  }

  const classification: AltmanClassification = inputs.classification ?? {
    sector: route.evidence.sector,
    industry: route.evidence.industry,
    sicCode: route.evidence.sic ?? null,
  };
  const suppressed = isFinancialForensicsSuppressed(route, classification);

  // --- Altman ---
  const altmanSelection = selectAltmanVariant(
    route,
    classification,
    inputs.isEmergingMarket ?? false,
  );
  let altman: AltmanResult | null = null;
  if (altmanSelection.variant !== null) {
    if (cur.balance && cur.income) {
      altman = computeAltman(
        {
          balance: cur.balance,
          income: cur.income,
          marketCap: inputs.marketCap ?? null,
          marketCapAsOf: inputs.marketCapAsOf ?? null,
          reportedCurrency: inputs.reportedCurrency ?? null,
          quoteCurrency: inputs.quoteCurrency ?? null,
        },
        altmanSelection.variant,
      );
    } else {
      gaps.push(
        gapEntry(
          "forensics.altman",
          "latest balance sheet and/or income statement missing — Z-score not computed",
          "warn",
        ),
      );
    }
  }

  // --- Beneish ---
  let beneish: BeneishResult | null = null;
  if (suppressed) {
    notes.push(
      "Beneish M-score not computed: financial company (Beneish excluded financial institutions from the model's estimation sample, paper p.5).",
    );
  } else if (!hasPeriod(pri)) {
    gaps.push(
      gapEntry(
        "forensics.beneish",
        "fewer than 2 fiscal years of statements — Beneish M requires two consecutive fiscal years",
        "warn",
      ),
    );
  } else {
    beneish = computeBeneish(cur, pri);
  }

  // --- Piotroski (still computed for financials, with a caveat) ---
  let piotroski: PiotroskiResult | null = null;
  if (!hasPeriod(pri)) {
    gaps.push(
      gapEntry(
        "forensics.piotroski",
        "fewer than 2 fiscal years of statements — Piotroski denominators need beginning-of-year total assets",
        "warn",
      ),
    );
  } else {
    piotroski = computePiotroski(cur, pri, pri2, {
      equityIssuanceDeMinimis: inputs.equityIssuanceDeMinimis ?? undefined,
    });
    if (suppressed) {
      notes.push(
        "Piotroski F-score shown for a financial company — note the model was validated on non-financial value stocks (research §6.3).",
      );
    }
  }

  // --- Accruals ---
  let accruals: AccrualsResult | null = null;
  if (suppressed) {
    notes.push(
      "Accrual ratios suppressed for financial companies — financial-asset flows swamp operating accruals (research §6.3).",
    );
  } else if (hasPeriod(pri)) {
    accruals = computeAccruals(cur, pri);
  } else {
    gaps.push(
      gapEntry(
        "forensics.accruals",
        "fewer than 2 fiscal years of statements — accrual ratios unavailable",
        "info",
      ),
    );
  }

  // --- Plain-English flags ---
  const support = computeSupportFlags(
    {
      income: periods.map((period) => period.income ?? null),
      balance: periods.map((period) => period.balance ?? null),
    },
    { periodsConsecutive: priorConsecutive },
  );
  const flags = [...support.flags];
  notes.push(...support.notes);

  // DSRI tie-in (research §5.1): surface receivables behavior even if M is benign.
  if (
    beneish !== null &&
    beneish.indices.dsri !== null &&
    !beneish.neutralized.includes("DSRI") &&
    beneish.indices.dsri > FORENSICS_HOUSE_RULES.dsriAmberLevel
  ) {
    flags.push({
      id: "dsri-elevated",
      severity: "warn",
      message: `Days-sales-in-receivables index (DSRI) is ${beneish.indices.dsri.toFixed(2)} — above the manipulator-sample mean of ${FORENSICS_HOUSE_RULES.dsriAmberLevel} (Beneish Table 2), even independent of the overall M-score.`,
      metrics: { dsri: beneish.indices.dsri },
      rule: `DSRI > ${FORENSICS_HOUSE_RULES.dsriAmberLevel} (manipulator-sample mean, Beneish 1999 Table 2)`,
      heuristic: true,
      asOf: [beneish.asOf.current, beneish.asOf.prior].filter((d): d is string => d !== null),
    });
  }

  gaps.push(
    ...support.gaps,
    ...(altman?.gaps ?? []),
    ...(beneish?.gaps ?? []),
    ...(piotroski?.gaps ?? []),
    ...(accruals?.gaps ?? []),
  );

  return { altmanSelection, altman, beneish, piotroski, accruals, flags, notes, gaps };
}
