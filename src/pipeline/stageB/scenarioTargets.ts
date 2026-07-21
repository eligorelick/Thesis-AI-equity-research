/**
 * Stage B — deterministic bull/base/bear scenario price targets.
 *
 * PURE, deterministic TypeScript: no network, no DB, no LLM. This is the
 * authority for the headline scenario targets, which used to be authored by the
 * judge/LLM (2026-07-11 scenario-credibility checkpoint). The construction:
 *
 *  - base target = the deterministic FCFF-DCF fair value per share
 *    (valuation.dcf.perShare) — reused, never recomputed, so it can never
 *    disagree with the DCF page;
 *  - bull / bear re-run the SAME exported runDcf with a sample-σ growth shift
 *    from consecutive company history and a margin shift scaled by the observed
 *    growth/margin correlation. This module and projections.ts share
 *    scenarioDispersion + perturbScenarioAssumptions, so the target band and
 *    projection fan cannot disagree on what "bull"/"bear" mean;
 *  - the EV→equity→per-share bridge (net debt, minority, preferred, diluted
 *    shares) is runDcf's own, so all three scenarios use one consistent bridge.
 *
 * Every target is a `computed-derived` TracedNumber (source
 * "computed.scenarioTargets.<scenario>") — calculation traceability, NOT factual
 * verification. It is a DCF sensitivity range, deliberately NOT a narrative-matched
 * analyst target; the LLM keeps the qualitative narrative but no longer owns the
 * number. When the route is non-DCF, or WACC / the base per-share bridge are
 * unavailable, the whole block is `status:"suppressed"` with empty targets and a
 * disclosing missingReasons[] — a target is SUPPRESSED, never fabricated.
 */

import {
  runDcf,
  type DcfRunOptions,
  type ValuationResult,
} from "@/pipeline/stageB/valuation";
import {
  DISPERSION_K,
  perturbScenarioAssumptions,
  scenarioDispersion,
  type ProjectionIncomeRow,
} from "@/pipeline/stageB/projections";
import type { CompanyRouteResult } from "@/pipeline/stageB/sectorRouting";
import type { ManifestEntry } from "@/types/core";
import type { ScenarioTarget, ScenarioTargets, TracedNumber } from "@/report/schema";

/** Method id stamped into the block. */
export const SCENARIO_TARGET_METHOD = "dcf-dispersion" as const;
/** Versioned method prior — bump when the construction changes. */
export const SCENARIO_TARGET_METHOD_VERSION = "SCENARIO_TARGETS_2026_07B" as const;

export interface ScenarioTargetsInputs {
  route: CompanyRouteResult;
  /** The valuation result — only the general DCF route yields per-share targets. */
  valuation: ValuationResult;
  waccPct: number | null;
  netDebt: number | null;
  dilutedShares: number | null;
  /** Equity-bridge claims senior to common; 0 when absent (mirrors valueCompany). */
  minorityInterest?: number | null;
  preferred?: number | null;
  /** Annual income history (any order) — for the ±σ dispersion (shared with the fan). */
  incomeHistory: ProjectionIncomeRow[];
  /** Current price for upside %; null ⇒ upside unknown (never defaulted). */
  currentPrice: number | null;
  /** Currency label for the per-share unit. */
  currency: string;
  asOf: string;
}

const isNum = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

const round2 = (v: number): number => Math.round(v * 100) / 100;

function suppressed(missingReasons: ManifestEntry[], basis: string[]): ScenarioTargets {
  return {
    status: "suppressed",
    method: SCENARIO_TARGET_METHOD,
    methodVersion: SCENARIO_TARGET_METHOD_VERSION,
    basis,
    dispersion: null,
    targets: [],
    missingReasons,
  };
}

export function computeScenarioTargets(inputs: ScenarioTargetsInputs): ScenarioTargets {
  const { valuation, currency, asOf } = inputs;

  // Only the general FCFF-DCF route has a per-share intrinsic value to perturb.
  // Banks/insurers/REITs/pre-revenue/dcf-suppressed → no target (SPEC §6).
  if (valuation.kind !== "dcf") {
    return suppressed(
      [
        {
          field: "valuation.scenarioTargets",
          reason: `deterministic scenario price targets are modelled only on the general DCF route; this company routed to "${valuation.kind}" — targets suppressed`,
          severity: "info",
        },
      ],
      [`Scenario price targets unavailable: the ${valuation.kind} route has no FCFF per-share to perturb.`],
    );
  }

  if (!isNum(inputs.waccPct)) {
    return suppressed(
      [
        {
          field: "valuation.scenarioTargets.wacc",
          reason: "WACC unavailable — cannot re-run the DCF for scenario targets",
          severity: "warn",
        },
      ],
      ["Scenario price targets unavailable: WACC could not be computed."],
    );
  }

  const assumptions = valuation.assumptions;
  const baseDcf = valuation.dcf;
  if (assumptions === null || baseDcf === null || !isNum(baseDcf.perShare)) {
    return suppressed(
      [
        {
          field: "valuation.scenarioTargets",
          reason:
            "base DCF per-share unavailable (assumptions/DCF not built, or net debt / diluted shares / the ADR currency guard suppressed the equity bridge) — scenario targets suppressed rather than fabricated",
          severity: "warn",
        },
      ],
      ["Scenario price targets unavailable: the base DCF per-share is not computable."],
    );
  }
  // A non-positive base DCF per-share (enterprise value ≤ net debt — a distressed
  // or heavily levered name) means the DCF itself values the equity at or below
  // zero. A ±σ fan around a non-positive base is not meaningful: the bear extreme
  // also floors at 0 while base stays negative, which would publish base BELOW
  // bear and hand a reader the risk direction backwards. Suppress the fan with
  // disclosure; the headline DCF page still shows the (negative) fair value.
  if (baseDcf.perShare <= 0) {
    return suppressed(
      [
        {
          field: "valuation.scenarioTargets",
          reason:
            "base DCF per-share is non-positive (enterprise value at or below net debt) — a scenario fan around a non-positive equity value is not meaningful; suppressed rather than published with a degenerate ordering",
          severity: "warn",
        },
      ],
      [
        "Scenario price targets unavailable: the base DCF values the equity at or below zero, so a bull/bear fan is not meaningful.",
      ],
    );
  }

  // Company-history sample dispersion and observed covariance — shared with the fan.
  const disp = scenarioDispersion(inputs.incomeHistory);
  if (disp.sigmaGrowth === null || disp.sigmaMargin === null) {
    return suppressed(
      [
        {
          field: "valuation.scenarioTargets.dispersion",
          reason:
            "at least four consecutive annual revenue observations and three margin observations are required for sample dispersion — scenario targets suppressed instead of using house defaults",
          severity: "warn",
        },
      ],
      ["Scenario targets unavailable: company-specific dispersion evidence is too thin."],
    );
  }
  // A (near-)flat growth OR margin history makes the sample correlation
  // undefined: scenarioDispersion.correlation() returns 0 on an exactly-flat
  // series and a spurious value on a float-noise-flat one (e.g. a constant-margin
  // company can report a phantom 0.29 correlation). Treat a σ that rounds to
  // 0.00pp as no measurable dispersion so the joint shock is not scaled by a
  // meaningless correlation — report the correlation as unavailable and disclose,
  // rather than presenting a phantom fan around the base.
  const dispersionDegenerate =
    round2(disp.sigmaGrowth) === 0 || round2(disp.sigmaMargin) === 0;
  const effectiveCorr = dispersionDegenerate ? null : disp.growthMarginCorrelation;

  const dg = DISPERSION_K * disp.sigmaGrowth;
  const dm = DISPERSION_K * disp.sigmaMargin * (effectiveCorr ?? 0);
  const sigmaSource = "own-history" as const;

  const missingReasons: ManifestEntry[] = [];
  if (disp.growthMarginCorrelation === null) {
    missingReasons.push({
      field: "valuation.scenarioTargets.dispersion.covariance",
      reason:
        "insufficient paired history to estimate growth/margin covariance — scenario margin delta held at zero rather than assuming perfect correlation",
      severity: "warn",
    });
  } else if (dispersionDegenerate) {
    missingReasons.push({
      field: "valuation.scenarioTargets.dispersion.degenerate",
      reason:
        "revenue-growth or operating-margin history shows negligible dispersion (σ rounds to 0.00pp) — the growth/margin correlation is undefined and the bull/bear band collapses toward the base; reported as no measurable dispersion rather than a calibrated fan",
      severity: "info",
    });
  }

  const opts: DcfRunOptions = {
    waccPct: inputs.waccPct,
    netDebt: inputs.netDebt,
    dilutedShares: inputs.dilutedShares,
    minorityInterest: inputs.minorityInterest ?? null,
    preferred: inputs.preferred ?? null,
  };

  const tn = (name: ScenarioTarget["name"], value: number): TracedNumber => ({
    value: round2(value),
    unit: `${currency}/share`,
    // computed.* ⇒ the verify pass classifies this computed-derived (provenance,
    // not correctness). verified:true == "traced to computed inputs", the same
    // convention projections.ts uses for its estimates — NOT a factual claim.
    source: `computed.scenarioTargets.${name}`,
    asOf,
    verified: true,
  });

  const upsideOf = (perShare: TracedNumber | null): number | null =>
    perShare !== null && isNum(inputs.currentPrice) && inputs.currentPrice > 0
      ? (perShare.value / inputs.currentPrice - 1) * 100
      : null;

  const mk = (
    name: ScenarioTarget["name"],
    perShareValue: number | null,
    growthDeltaPp: number,
    marginDeltaPp: number,
  ): ScenarioTarget => {
    const perShare = isNum(perShareValue) ? tn(name, perShareValue) : null;
    return { name, perShare, upsidePct: upsideOf(perShare), growthDeltaPp, marginDeltaPp };
  };

  // base = the deterministic DCF fair value (reused). bull/bear re-run the SAME
  // engine with ±σ-shifted growth/margin paths and the SAME equity bridge.
  const rawUpPerShare = runDcf(perturbScenarioAssumptions(assumptions, dg, dm), opts).perShare; // +growth / +margin·corr
  const rawDownPerShare = runDcf(perturbScenarioAssumptions(assumptions, -dg, -dm), opts).perShare; // −growth / −margin·corr

  // With a NEGATIVE growth/margin correlation dm < 0, so the +growth run can land
  // BELOW the −growth run (the margin shock dominates the growth shock), which
  // would publish "bull" beneath "bear" and hand a reader the risk direction
  // backwards. Order the two extremes by per-share value so the higher is always
  // labelled bull; each scenario keeps the growth/margin deltas of the path that
  // produced it. base (the DCF fair value) is untouched, so it can never disagree
  // with the DCF page.
  let optimistic = { value: rawUpPerShare, growthDeltaPp: dg, marginDeltaPp: dm };
  let pessimistic = { value: rawDownPerShare, growthDeltaPp: -dg, marginDeltaPp: -dm };
  let orderingInverted = false;
  if (isNum(rawUpPerShare) && isNum(rawDownPerShare) && rawDownPerShare > rawUpPerShare) {
    optimistic = { value: rawDownPerShare, growthDeltaPp: -dg, marginDeltaPp: -dm };
    pessimistic = { value: rawUpPerShare, growthDeltaPp: dg, marginDeltaPp: dm };
    orderingInverted = true;
  }
  if (orderingInverted) {
    missingReasons.push({
      field: "valuation.scenarioTargets.ordering",
      reason:
        "negative growth/margin correlation inverted the raw ±σ construction (the margin shock dominated the growth shock); bull/bear were re-labelled by per-share value so the published bull is never below bear, and each scenario's growth/margin deltas describe the path that produced it",
      severity: "warn",
    });
  }

  // Limited-liability common equity cannot be worth less than 0: a heavily levered
  // −σ re-run can bridge enterprise value below net debt and yield a negative
  // per-share (and an upside below −100%), which is economically impossible. Floor
  // the published perturbed extremes at 0 (upside then bottoms at exactly −100%);
  // base is left as the DCF fair value so the card can never disagree with the DCF
  // page.
  const floorAtZero = (v: number | null): { value: number | null; floored: boolean } =>
    isNum(v) && v < 0 ? { value: 0, floored: true } : { value: v, floored: false };
  const bull = floorAtZero(optimistic.value);
  const bear = floorAtZero(pessimistic.value);
  const flooredNames = [bull.floored ? "bull" : null, bear.floored ? "bear" : null].filter(
    (n): n is string => n !== null,
  );
  if (flooredNames.length > 0) {
    missingReasons.push({
      field: "valuation.scenarioTargets.floor",
      reason: `${flooredNames.join(" and ")} scenario enterprise value falls at or below net debt — the DCF equity bridge is non-positive; per-share target floored at 0 and upside capped at −100% (common equity cannot be worth less than nothing)`,
      severity: "warn",
    });
  }

  const targets: ScenarioTarget[] = [
    mk("bull", bull.value, optimistic.growthDeltaPp, optimistic.marginDeltaPp),
    mk("base", baseDcf.perShare, 0, 0),
    mk("bear", bear.value, pessimistic.growthDeltaPp, pessimistic.marginDeltaPp),
  ];

  const basis = [
    "base target = the deterministic FCFF-DCF fair value per share (computed.valuation.dcf.perShare).",
    `bull/bear re-run the SAME DCF with growth shifted ±${round2(dg)}pp and margin shifted ±${round2(dm)}pp; margin sample σ is scaled by observed growth/margin correlation (${effectiveCorr === null ? "unavailable" : round2(effectiveCorr)}), not assumed perfectly correlated. Targets are labelled by per-share value, so the higher scenario is always bull and per-share is floored at 0.`,
    "Targets are computed-derived DCF sensitivities, not source-verified facts or empirically calibrated outcome probabilities.",
  ];

  return {
    status: "available",
    method: SCENARIO_TARGET_METHOD,
    methodVersion: SCENARIO_TARGET_METHOD_VERSION,
    basis,
    dispersion: {
      growthSigmaPp: round2(disp.sigmaGrowth),
      marginSigmaPp: round2(disp.sigmaMargin),
      sigmaSource,
      growthMarginCorrelation: effectiveCorr,
    },
    targets,
    missingReasons,
  };
}
