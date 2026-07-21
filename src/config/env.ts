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
