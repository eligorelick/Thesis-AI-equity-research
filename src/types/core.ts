/**
 * Core shared contracts for Thesis. Every module builds against these types —
 * change them only with a corresponding the design rationale entry.
 */

/** Every externally sourced datum carries its provenance and as-of date. */
export interface Sourced<T> {
  data: T;
  /** ISO date the datum is "as of" (fiscal period end, quote time, etc.) */
  asOf: string;
  /** Provider id: fmp | edgar | finra | fred | finnhub | anthropic | computed */
  source: DataSource;
  /** Endpoint or derivation that produced it (for the appendix/traceability) */
  endpoint: string;
  /** ISO timestamp when we fetched/computed it */
  fetchedAt: string;
  /** True when served past its TTL (stale-while-revalidate) */
  stale?: boolean;
  /** Why stale data was retained, when the cache knows a specific condition. */
  staleReason?: "empty-refresh-preserved";
}

export type DataSource =
  | "fmp"
  | "edgar"
  | "finra"
  | "fred"
  | "finnhub"
  | "anthropic"
  | "computed";

/** Missing-data manifest entry — gaps are disclosed, never papered over. */
export interface ManifestEntry {
  /** Dot-path of the report field or dataset, e.g. "leadership.cet1Ratio" */
  field: string;
  reason: string;
  severity: "info" | "warn" | "critical";
  /** Where we looked */
  attemptedSources?: string[];
  /**
   * True for known structural gaps (e.g. an issuer that simply doesn't report
   * geographic segmentation): disclosed but counted separately so recurring
   * non-incidents don't inflate the headline gap count on every report.
   */
  expected?: boolean;
}

/** Pipeline steps streamed to the UI. Order is fixed. */
export const PIPELINE_STEPS = [
  "fetch",
  "validate",
  "compute",
  "bull",
  "bear",
  "synthesize",
  "verify",
] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export interface StepProgress {
  step: PipelineStep;
  status: "pending" | "running" | "done" | "error" | "skipped";
  startedAt?: string;
  finishedAt?: string;
  detail?: string;
  /** Running USD cost attributable to this step (LLM passes) */
  costUsd?: number;
}

/** Sector routing result (see the application contract §6). Overlays compose over the base. */
export type SectorRoute =
  | "general"
  | "bank"
  | "insurer"
  | "reit"
  | "reit-mortgage";
export type SectorOverlay = "unprofitable" | "pre-revenue" | "recent-ipo" | "adr";

export interface CompanyRoute {
  base: SectorRoute;
  overlays: SectorOverlay[];
  /** FMP sector/industry strings that produced the route, for the appendix */
  evidence: { sector: string | null; industry: string | null; sic?: string | null };
}

/** Grades used across the report. */
export type Grade = "A" | "B" | "C" | "D" | "F";

/** Claim labels — every LLM claim carries one (non-negotiable rule #2). */
export type ClaimLabel = "FACT" | "ESTIMATE" | "JUDGMENT";

/** Result envelope for provider calls that may legitimately have no data. */
export type FetchResult<T> =
  | { ok: true; value: Sourced<T> }
  | { ok: false; gap: ManifestEntry };
