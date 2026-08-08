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

const envSchema = z.object({
  FMP_API_KEY: optionalSecret,
  FINNHUB_API_KEY: optionalSecret,
  FRED_API_KEY: optionalSecret,
  ANTHROPIC_API_KEY: optionalSecret,
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
  // Strictly greater than the provider's 600-second hard request timeout.
  THESIS_PAID_PASS_LEASE_SECONDS: positiveIntegerEnv(900, 600, MAX_NODE_TIMER_SECONDS),
  THESIS_JOB_LEASE_SECONDS: positiveIntegerEnv(900, 0, MAX_NODE_TIMER_SECONDS),
  // VERIFY_MODEL was removed (SPEC §12): verification is deterministic
  // numeric-source tracing and never calls a model. A leftover env var is
  // simply ignored.
});

export interface ThesisConfig {
  fmpApiKey: string | undefined;
  finnhubApiKey: string | undefined;
  fredApiKey: string | undefined;
  anthropicApiKey: string | undefined;
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
  maxActiveJobs: number;
  maxActiveLlmCalls: number;
  maxJobCostUsd: number | null;
  maxRollingCostUsd: number | null;
  rollingCostWindowMs: number;
  paidPassLeaseTtlMs: number;
  jobLeaseTtlMs: number;
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
    analysisModel: parsed.ANALYSIS_MODEL,
    hasFmpKey: parsed.FMP_API_KEY !== undefined,
    hasFinnhubKey: parsed.FINNHUB_API_KEY !== undefined,
    hasFredKey: parsed.FRED_API_KEY !== undefined,
    hasAnthropicKey: parsed.ANTHROPIC_API_KEY !== undefined,
    fixtureMode: parsed.FMP_API_KEY === undefined,
    maxActiveJobs: parsed.THESIS_MAX_ACTIVE_JOBS,
    maxActiveLlmCalls: parsed.THESIS_MAX_ACTIVE_LLM_CALLS,
    maxJobCostUsd: parsed.THESIS_MAX_JOB_COST_USD,
    maxRollingCostUsd: parsed.THESIS_MAX_ROLLING_COST_USD,
    rollingCostWindowMs: parsed.THESIS_ROLLING_COST_WINDOW_MINUTES * 60_000,
    paidPassLeaseTtlMs: parsed.THESIS_PAID_PASS_LEASE_SECONDS * 1_000,
    jobLeaseTtlMs: parsed.THESIS_JOB_LEASE_SECONDS * 1_000,
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
