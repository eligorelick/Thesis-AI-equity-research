/**
 * Server-only environment config for Thesis.
 *
 * Parses .env values with zod once and caches the result. API keys NEVER
 * reach the client — importing this module from client code throws at
 * module-evaluation time through Next's `server-only` marker, with the runtime
 * `typeof window` guard retained as defense in depth outside Next builds.
 *
 * No key present is a designed-for state (the application contract Phase 1 entry): keyed
 * providers run in fixture mode / return explicit gaps, keyless providers
 * (EDGAR, FINRA, fredgraph.csv) stay fully live.
 */

import "server-only";

import { z } from "zod";

import {
  ANTHROPIC_REQUEST_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_SECONDS,
  JOB_HEARTBEAT_MS,
  MIN_JOB_LEASE_SECONDS,
  MIN_PAID_PASS_LEASE_SECONDS,
  PAID_LEASE_RENEWAL_DIVISOR,
} from "@/pipeline/leaseTiming";

if (typeof window !== "undefined") {
  throw new Error(
    "@/config/env is server-only: it holds API keys and must never be imported from client components.",
  );
}

/** "" or whitespace-only -> undefined; otherwise the trimmed value. */
const optionalSecret = z
  .string()
  .optional()
  .transform((v) => {
    const trimmed = v?.trim();
    return trimmed ? trimmed : undefined;
  });

function blank(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

const MAX_NODE_TIMER_SECONDS = 2_147_483;
const MAX_ROLLING_WINDOW_MINUTES = 52_560_000; // 100 years; safely inside the JS Date range.
const MAX_EXACT_MICRO_USD = BigInt(Number.MAX_SAFE_INTEGER);

function positiveIntegerEnv(
  defaultValue: number,
  minimumExclusive = 0,
  maximumInclusive = Number.MAX_SAFE_INTEGER,
) {
  return z.string().optional().transform((raw, ctx) => {
    const value = blank(raw);
    if (value === undefined) return defaultValue;
    if (!/^\d+$/.test(value)) {
      ctx.addIssue({ code: "custom", message: "must be a positive base-10 integer" });
      return z.NEVER;
    }
    const parsed = Number(value);
    if (
      !Number.isSafeInteger(parsed) ||
      parsed <= minimumExclusive ||
      parsed > maximumInclusive
    ) {
      ctx.addIssue({
        code: "custom",
        message: `must be a safe integer greater than ${minimumExclusive} and at most ${maximumInclusive}`,
      });
      return z.NEVER;
    }
    return parsed;
  });
}

function optionalUsdCapEnv() {
  return z.string().optional().transform((raw, ctx) => {
    const value = blank(raw);
    if (value === undefined) return null;
    const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
    if (match === null) {
      ctx.addIssue({ code: "custom", message: "must be a nonnegative ordinary decimal with at most six places" });
      return z.NEVER;
    }
    const whole = BigInt(match[1]);
    const fraction = (match[2] ?? "").padEnd(6, "0");
    const microUsd = whole * 1_000_000n + BigInt(fraction);
    if (microUsd > MAX_EXACT_MICRO_USD) {
      ctx.addIssue({ code: "custom", message: "USD cap exceeds exact micro-USD range" });
      return z.NEVER;
    }
    const parsed = Number(value);
    const canonical = `${whole.toString()}.${fraction}`;
    if (!Number.isFinite(parsed) || parsed.toFixed(6) !== canonical) {
      ctx.addIssue({ code: "custom", message: "USD cap cannot be represented as exact micro-USD" });
      return z.NEVER;
    }
    return parsed;
  });
}

// WS8: startup hold and the non-browser request token (docs/PRIVACY.md).
function binaryFlagEnv(defaultValue: boolean) {
  return z.string().optional().transform((raw, ctx) => {
    const value = blank(raw);
    if (value === undefined) return defaultValue;
    if (value === "1") return true;
    if (value === "0") return false;
    ctx.addIssue({ code: "custom", message: "must be 1 or 0" });
    return z.NEVER;
  });
}

/** Blank -> undefined; otherwise the trimmed path exactly as written. */
const optionalPath = z.string().optional().transform((raw) => blank(raw));
// end WS8

const envSchema = z.object({
  FMP_API_KEY: optionalSecret,
  FINNHUB_API_KEY: optionalSecret,
  FRED_API_KEY: optionalSecret,
  ANTHROPIC_API_KEY: optionalSecret,
  /**
   * Optional Admin API key. Only used by `npm run costs:reconcile`, which
   * reconciles presumed spend downward against the Usage & Cost API. Never
   * read on a report path.
   */
  ANTHROPIC_ADMIN_KEY: optionalSecret,
  /** "auto" = best available, resolved via the Models API (the application contract §5). */
  ANALYSIS_MODEL: z
    .string()
    .optional()
    .transform((v) => {
      const trimmed = v?.trim();
      return trimmed ? trimmed : "auto";
    }),
  THESIS_MAX_ACTIVE_JOBS: positiveIntegerEnv(1),
  THESIS_MAX_ACTIVE_LLM_CALLS: positiveIntegerEnv(2),
  THESIS_MAX_JOB_COST_USD: optionalUsdCapEnv(),
  THESIS_MAX_ROLLING_COST_USD: optionalUsdCapEnv(),
  THESIS_ROLLING_COST_WINDOW_MINUTES: positiveIntegerEnv(
    1_440,
    0,
    MAX_ROLLING_WINDOW_MINUTES,
  ),
  // --- WS4 (D-12) ------------------------------------------------------------
  /**
   * Where statement history comes from.
   *  - `auto` (default): FMP first; when its plan truncates history, older
   *    periods are backfilled from SEC EDGAR companyfacts, with per-row
   *    provenance and a manifest entry naming the depth each source served. No
   *    period ever mixes sources.
   *  - `fmp`: FMP only; a truncated history stays truncated.
   *  - `edgar`: EDGAR companyfacts only; FMP's statement rows are ignored.
   * An unrecognized value is rejected at parse, like every other key here.
   */
  THESIS_STATEMENT_SOURCE: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const value = blank(raw)?.toLowerCase();
      if (value === undefined) return "auto" as const;
      if (value === "auto" || value === "fmp" || value === "edgar") return value;
      ctx.addIssue({ code: "custom", message: 'must be one of "auto", "fmp" or "edgar"' });
      return z.NEVER;
    }),
  // --- end WS4 ---------------------------------------------------------------
  // Must outlive the provider's hard request timeout plus the margin an
  // aborted stream needs to settle (see src/pipeline/leaseTiming.ts).
  THESIS_PAID_PASS_LEASE_SECONDS: positiveIntegerEnv(
    900,
    MIN_PAID_PASS_LEASE_SECONDS - 1,
    MAX_NODE_TIMER_SECONDS,
  ),
  // Must cover at least two job-claim heartbeats, and must never be shorter
  // than the paid-pass lease it parents.
  THESIS_JOB_LEASE_SECONDS: positiveIntegerEnv(
    900,
    MIN_JOB_LEASE_SECONDS - 1,
    MAX_NODE_TIMER_SECONDS,
  ),
  /**
   * Gap with no stream event that aborts a stalled paid request. This is the
   * ONLY parser for the variable: the provider reads the validated value from
   * this config rather than re-reading and re-parsing the environment with a
   * second, wider range. 0 is accepted and disables the idle guard, which is
   * why the exclusive minimum is -1.
   */
  THESIS_STREAM_IDLE_SECONDS: positiveIntegerEnv(DEFAULT_STREAM_IDLE_SECONDS, -1, 3_600),
  /**
   * How paid work is admitted against the spend caps (DECISIONS D-10).
   *  - "request" (default): every provider request reserves its own maximum
   *    and settles its own usage, so a cap can be set near real spend.
   *  - "pass": the pre-remediation bound — one reservation per pass covering
   *    every retry and resumption it could make. Kept for one release so a
   *    deployment can fall back without a downgrade.
   */
  THESIS_RESERVATION_MODE: z
    .string()
    .optional()
    .transform((v, ctx) => {
      const value = blank(v) ?? "request";
      if (value !== "request" && value !== "pass") {
        ctx.addIssue({ code: "custom", message: 'must be "request" or "pass"' });
        return z.NEVER;
      }
      return value;
    }),
  // WS8
  /** "1" (default) kicks the scheduler at startup; "0" holds queued paid work for an explicit resume. */
  THESIS_RESUME_ON_START: binaryFlagEnv(true),
  /** Full path of the X-Thesis-Token file; blank means `<data dir>/csrf-token`. */
  THESIS_TOKEN_FILE: optionalPath,
  // end WS8
  // WS6 (D-19): include lease liabilities in enterprise value and in the DCF
  // equity bridge. OFF by default: under US GAAP (ASC 842) the operating-lease
  // cost stays in operating expenses, so EBITDA is already after it and adding
  // the lease liability to EV as well double-counts the leases in EV/EBITDA.
  // Any value other than "1" (including unset) leaves it off.
  THESIS_EV_INCLUDE_LEASES: z
    .string()
    .optional()
    .transform((v) => blank(v) === "1"),
  // VERIFY_MODEL was removed (SPEC §12): verification is deterministic
  // numeric-source tracing and never calls a model. A leftover env var is
  // simply ignored.
}).superRefine((parsed, ctx) => {
  // Lease invariants (DECISIONS D-08). A process that starts with these
  // violated would either lose a healthy job to reconciliation mid-run or
  // keep billing after its claim was handed to someone else, so startup
  // fails fast instead.
  const paidMs = parsed.THESIS_PAID_PASS_LEASE_SECONDS * 1_000;
  const jobMs = parsed.THESIS_JOB_LEASE_SECONDS * 1_000;
  if (jobMs < 2 * JOB_HEARTBEAT_MS) {
    ctx.addIssue({
      code: "custom",
      path: ["THESIS_JOB_LEASE_SECONDS"],
      message: `must be at least ${MIN_JOB_LEASE_SECONDS} seconds: two job-claim heartbeats of ${JOB_HEARTBEAT_MS / 1_000}s`,
    });
  }
  if (paidMs < 2 * (paidMs / PAID_LEASE_RENEWAL_DIVISOR)) {
    ctx.addIssue({
      code: "custom",
      path: ["THESIS_PAID_PASS_LEASE_SECONDS"],
      message: "must be at least twice the paid-pass renewal interval",
    });
  }
  if (paidMs <= ANTHROPIC_REQUEST_TIMEOUT_MS) {
    ctx.addIssue({
      code: "custom",
      path: ["THESIS_PAID_PASS_LEASE_SECONDS"],
      message: `must exceed the ${ANTHROPIC_REQUEST_TIMEOUT_MS / 1_000}s provider request timeout`,
    });
  }
  if (jobMs < paidMs) {
    ctx.addIssue({
      code: "custom",
      path: ["THESIS_JOB_LEASE_SECONDS"],
      message: `must be at least THESIS_PAID_PASS_LEASE_SECONDS (${parsed.THESIS_PAID_PASS_LEASE_SECONDS}s): a paid-pass lease must never outlive its parent job claim`,
    });
  }
});

// WS4 (D-12): the accepted values of THESIS_STATEMENT_SOURCE.
export type StatementSource = "auto" | "fmp" | "edgar";

export interface ThesisConfig {
  fmpApiKey: string | undefined;
  finnhubApiKey: string | undefined;
  fredApiKey: string | undefined;
  anthropicApiKey: string | undefined;
  anthropicAdminKey: string | undefined;
  /** Model id or "auto" (default). */
  analysisModel: string;
  // Capability flags — provider clients and pages branch on these instead of
  // touching raw keys.
  hasFmpKey: boolean;
  hasFinnhubKey: boolean;
  hasFredKey: boolean;
  hasAnthropicKey: boolean;
  /** True when no FMP key is configured — FMP clients serve fixtures/gaps. */
  fixtureMode: boolean;
  // WS4 (D-12): statement-history source policy.
  statementSource: StatementSource;
  maxActiveJobs: number;
  maxActiveLlmCalls: number;
  maxJobCostUsd: number | null;
  maxRollingCostUsd: number | null;
  rollingCostWindowMs: number;
  paidPassLeaseTtlMs: number;
  jobLeaseTtlMs: number;
  streamIdleTimeoutMs: number;
  reservationMode: "request" | "pass";
  // WS8
  /** False only when THESIS_RESUME_ON_START=0: startup does not kick the scheduler. */
  resumeOnStart: boolean;
  /** THESIS_TOKEN_FILE override; undefined means `<data dir>/csrf-token`. */
  tokenFile: string | undefined;
  // end WS8
  // WS6 (D-19)
  /** THESIS_EV_INCLUDE_LEASES=1 — count lease liabilities in enterprise value. */
  evIncludeLeases: boolean;
}

/**
 * Pure parser — exported for tests. Takes any env-shaped record and returns
 * the full config with capability flags derived.
 */
export function parseEnv(
  env: Record<string, string | undefined>,
): ThesisConfig {
  const parsed = envSchema.parse(env);
  const config: ThesisConfig = {
    fmpApiKey: parsed.FMP_API_KEY,
    finnhubApiKey: parsed.FINNHUB_API_KEY,
    fredApiKey: parsed.FRED_API_KEY,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    anthropicAdminKey: parsed.ANTHROPIC_ADMIN_KEY,
    analysisModel: parsed.ANALYSIS_MODEL,
    hasFmpKey: parsed.FMP_API_KEY !== undefined,
    hasFinnhubKey: parsed.FINNHUB_API_KEY !== undefined,
    hasFredKey: parsed.FRED_API_KEY !== undefined,
    hasAnthropicKey: parsed.ANTHROPIC_API_KEY !== undefined,
    fixtureMode: parsed.FMP_API_KEY === undefined,
    statementSource: parsed.THESIS_STATEMENT_SOURCE,
    maxActiveJobs: parsed.THESIS_MAX_ACTIVE_JOBS,
    maxActiveLlmCalls: parsed.THESIS_MAX_ACTIVE_LLM_CALLS,
    maxJobCostUsd: parsed.THESIS_MAX_JOB_COST_USD,
    maxRollingCostUsd: parsed.THESIS_MAX_ROLLING_COST_USD,
    rollingCostWindowMs: parsed.THESIS_ROLLING_COST_WINDOW_MINUTES * 60_000,
    paidPassLeaseTtlMs: parsed.THESIS_PAID_PASS_LEASE_SECONDS * 1_000,
    jobLeaseTtlMs: parsed.THESIS_JOB_LEASE_SECONDS * 1_000,
    streamIdleTimeoutMs: parsed.THESIS_STREAM_IDLE_SECONDS * 1_000,
    reservationMode: parsed.THESIS_RESERVATION_MODE,
    // WS8
    resumeOnStart: parsed.THESIS_RESUME_ON_START,
    tokenFile: parsed.THESIS_TOKEN_FILE,
    // end WS8
    // WS6 (D-19)
    evIncludeLeases: parsed.THESIS_EV_INCLUDE_LEASES,
  };
  return Object.freeze(config);
}

let cached: ThesisConfig | undefined;

/** Parsed process.env, cached for the lifetime of the server process. */
export function getConfig(): ThesisConfig {
  if (cached === undefined) {
    cached = parseEnv(process.env);
  }
  return cached;
}

/** Test hook: drop the cache so the next getConfig() re-reads process.env. */
export function resetConfigCache(): void {
  cached = undefined;
}
