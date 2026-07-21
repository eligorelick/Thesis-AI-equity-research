/**
 * Stage B — deterministic intrinsic per-share fair value.
 *
 * PURE, deterministic TypeScript. This is the authority for the report's DCF-card
 * headline (valuation.dcf.perShare + upsidePct), which used to be authored by the
 * judge/LLM (2026-07-11 DCF-credibility checkpoint). It resolves the ROUTE-
 * APPROPRIATE deterministic per-share already computed by valueCompany — reused,
 * never recomputed, so it can never disagree with the valuation engine:
 *
 *  - general route  → the FCFF DCF fair value (computed.valuation.dcf.perShare);
 *  - bank/insurer   → the book-value excess-return per-share
 *                     (computed.valuation.excessReturn.perShare) — NO WACC/FCFF;
 *  - equity REIT / pre-revenue / dcf-suppressed → NO per-share intrinsic model
 *                     (REITs use P/FFO; pre-revenue has none) → SUPPRESSED.
 *
 * upsidePct = (perShare / current price − 1)·100, or null when the price or the
 * per-share is missing (never defaulted). The per-share is a `computed-derived`
 * TracedNumber (source "computed.valuation.*") — calculation traceability, NOT
 * factual verification. When no model applies or the equity bridge was suppressed
 * (net debt / diluted shares / ADR currency guard), the whole block is
 * `status:"suppressed"` with a null per-share and a disclosing reasons[] — a fair
 * value is SUPPRESSED, never fabricated.
 */

import type { DcfAssumptions, ValuationResult } from "@/pipeline/stageB/valuation";
import type { ManifestEntry } from "@/types/core";
import type { DcfAssumption, FairValue, SensitivityCell, TracedNumber } from "@/report/schema";

/** Versioned method prior — bump when the resolution changes. */
export const FAIR_VALUE_METHOD_VERSION = "FAIR_VALUE_2026_07" as const;

export interface FairValueInputs {
  /** The route-dispatched valuation result (carries the per-route per-share). */
  valuation: ValuationResult;
  /** Current price for upside %; null ⇒ upside unknown (never defaulted). */
  currentPrice: number | null;
  /** Currency label for the per-share unit. */
  currency: string;
  asOf: string;
}

const isNum = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

const round2 = (v: number): number => Math.round(v * 100) / 100;

function suppressed(reasons: ManifestEntry[], basis: string[]): FairValue {
  return {
    status: "suppressed",
    method: null,
    methodVersion: FAIR_VALUE_METHOD_VERSION,
    perShare: null,
    upsidePct: null,
    basis,
    reasons,
  };
}

export function computeFairValue(inputs: FairValueInputs): FairValue {
  const { valuation, currency, asOf } = inputs;

  // Resolve the route-appropriate deterministic per-share, its method + source tag.
  let perShareValue: number | null = null;
  let method: "fcff-dcf" | "excess-return" | null = null;
  let source = "";
  let methodLabel = "";
  if (valuation.kind === "dcf") {
    method = "fcff-dcf";
    source = "computed.valuation.dcf.perShare";
    methodLabel = "FCFF discounted-cash-flow fair value (NOPAT − sales-to-capital reinvestment, Gordon terminal, EV→equity bridge)";
    perShareValue = valuation.dcf?.perShare ?? null;
  } else if (valuation.kind === "excess-return") {
    method = "excess-return";
    source = "computed.valuation.excessReturn.perShare";
    methodLabel = "book-value excess-return fair value (BV0 + Σ PV(ROE − cost of equity), no WACC/FCFF)";
    perShareValue = valuation.excessReturn.perShare;
  }

  if (method === null || !isNum(perShareValue)) {
    const reason =
      valuation.kind === "reit"
        ? "equity REITs are valued on P/FFO and P/AFFO multiples — no DCF-style per-share intrinsic value is modelled (SPEC §6)"
        : valuation.kind === "pre-revenue"
          ? "pre-revenue company — no meaningful intrinsic per-share model in v1"
          : valuation.kind === "dcf-suppressed"
            ? "intrinsic per-share DCF suppressed for this route/overlay (e.g. structurally negative free cash flow) — see missing-data"
            : "deterministic intrinsic per-share unavailable — the model was not built, or net debt / diluted shares / the ADR currency guard suppressed the equity bridge";
    // Not-applicable routes are info; a suppressed bridge on a modellable route is a warn.
    const severity: ManifestEntry["severity"] =
      valuation.kind === "reit" || valuation.kind === "pre-revenue" ? "info" : "warn";
    return suppressed(
      [{ field: "valuation.dcf.perShare", reason, severity }],
      [`Intrinsic value per share unavailable: ${reason}.`],
    );
  }

  const perShare: TracedNumber = {
    value: round2(perShareValue),
    unit: `${currency}/share`,
    // computed.* ⇒ the verify pass classifies this computed-derived (provenance,
    // not correctness). verified:true == "traced to computed inputs", the same
    // convention projections/scenarioTargets use — NOT a factual claim.
    source,
    asOf,
    verified: true,
  };
  const upsidePct =
    isNum(inputs.currentPrice) && inputs.currentPrice > 0
      ? (perShare.value / inputs.currentPrice - 1) * 100
      : null;

  return {
    status: "available",
    method,
    methodVersion: FAIR_VALUE_METHOD_VERSION,
    perShare,
    upsidePct,
    basis: [
      `Intrinsic value per share = the deterministic ${methodLabel}.`,
      "Computed-derived (source computed.valuation.*), not a source-verified analyst target — the LLM interprets it but does not author the number.",
    ],
    reasons: [],
  };
}

/* ------------------------------------------------------------------------ *
 * Deterministic DCF display (assumptions rows + sensitivity cells)
 *
 * Reshapes the DETERMINISTIC Stage B DcfAssumptions + SensitivityGrid into the
 * report's display shapes so the valuation card shows the real computed inputs,
 * not judge-transcribed ones. Only the general FCFF-DCF route has these; every
 * other route (excess-return / REIT / pre-revenue / suppressed) returns EMPTY —
 * there is no FCFF DCF to show, so nothing is fabricated. Mirrors the company
 * page's AssumptionTable / SensitivityGridTable transforms.
 * ------------------------------------------------------------------------ */

const pct1 = (v: number): string => `${(Math.round(v * 10) / 10).toFixed(1)}%`;
const num2 = (v: number): string => (Math.round(v * 100) / 100).toFixed(2);
/** Compact large-number formatter for the start-revenue row. */
function big(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  return String(Math.round(v));
}

function assumptionRows(a: DcfAssumptions): DcfAssumption[] {
  const g = a.growthPath.value;
  const m = a.ebitMarginPath.value;
  return [
    { name: "start revenue", value: big(a.startRevenue.value), basis: a.startRevenue.basis },
    { name: "revenue growth (yr1 → yrN)", value: `${pct1(g[0])} → ${pct1(g[g.length - 1])}`, basis: a.growthPath.basis },
    { name: "EBIT margin (yr1 → yrN)", value: `${pct1(m[0])} → ${pct1(m[m.length - 1])}`, basis: a.ebitMarginPath.basis },
    { name: "sales-to-capital", value: num2(a.salesToCapital.value), basis: a.salesToCapital.basis },
    { name: "terminal growth", value: pct1(a.terminal.gTermPct.value), basis: a.terminal.gTermPct.basis },
    { name: "terminal ROIC", value: pct1(a.terminal.roicTermPct.value), basis: a.terminal.roicTermPct.basis },
  ];
}

export interface DcfDisplay {
  assumptions: DcfAssumption[];
  sensitivityGrid: SensitivityCell[];
}

export function computeDcfDisplay(valuation: ValuationResult): DcfDisplay {
  // Only the general FCFF-DCF route carries DCF assumptions + a WACC×g grid.
  if (valuation.kind !== "dcf" || valuation.assumptions === null) {
    return { assumptions: [], sensitivityGrid: [] };
  }
  const assumptions = assumptionRows(valuation.assumptions);
  const grid = valuation.sensitivity;
  const sensitivityGrid: SensitivityCell[] = [];
  if (grid !== null) {
    grid.waccPcts.forEach((w, i) => {
      grid.gTermPcts.forEach((gt, j) => {
        sensitivityGrid.push({ waccPct: w, gTermPct: gt, perShare: grid.perShare[i]?.[j] ?? null });
      });
    });
  }
  return { assumptions, sensitivityGrid };
}
