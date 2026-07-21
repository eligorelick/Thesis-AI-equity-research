/**
 * Persistent app settings (settings table). Values set here OVERRIDE .env at
 * read time — the Settings page writes through setSetting() and the pipeline
 * reads through the typed helpers.
 *
 * Precedence: settings table → environment variable → hard default.
 * Server-only (imports src/db).
 */

import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { settings } from "@/db/schema";

/** Well-known setting keys. */
export const SETTING_KEYS = {
  /** Anthropic model for analysis passes (the application contract §5); "auto" = resolve best. */
  analysisModel: "analysisModel",
  /** `output_config.effort` for the LLM passes; one of EFFORT_LEVELS. */
  analysisEffort: "analysisEffort",
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS] | (string & {});

/** Reads a setting; returns `fallback` when the key has never been set. */
export function getSetting(key: SettingKey, fallback: string): string {
  const row = getDb()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .get();
  return row?.value ?? fallback;
}

/** Upserts a setting. */
export function setSetting(key: SettingKey, value: string): void {
  getDb()
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

/** Removes a setting so reads fall back to env / defaults again. */
export function deleteSetting(key: SettingKey): void {
  getDb().delete(settings).where(eq(settings.key, key)).run();
}

/** Non-empty trimmed env value, else undefined. */
function envOrUndefined(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Analysis model (the application contract §5). Precedence: settings table → ANALYSIS_MODEL
 * env → "auto" (= best available, resolved via the Models API in preference
 * order claude-opus-4-8 → claude-sonnet-5 → claude-fable-5).
 *
 * NOTE: the former verifyModel setting was removed (SPEC §12) — verification
 * is fully deterministic numeric-source tracing and never calls a model. A
 * stray "verifyModel" row in an existing settings table is harmless (nothing
 * reads it); old persisted reports keep their meta.verifyModel label.
 */
export function getAnalysisModelSetting(): string {
  return getSetting(SETTING_KEYS.analysisModel, envOrUndefined("ANALYSIS_MODEL") ?? "auto");
}

/* ------------------------------------------------------------------------ *
 * Analysis effort (`output_config.effort`)
 * ------------------------------------------------------------------------ */

/** Valid `output_config.effort` levels, cheapest first. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * Default effort for all LLM passes. "high" is the API default and the
 * quality-first choice; thinking tokens (billed as output) are the largest
 * single cost component per pass (measured 2026-07-09: analyst passes ~22–29K
 * output tokens of which only ~4–6K is the case JSON; judge ~43K of which
 * ~25–30K is the report JSON), so effort is THE cost/quality knob.
 */
export const DEFAULT_ANALYSIS_EFFORT: EffortLevel = "high";

/**
 * Effort for the LLM passes. Precedence: settings table → ANALYSIS_EFFORT env
 * → "high" (the Anthropic API contract §9 env design). An unrecognized value
 * SANITIZES to the default rather than throwing — a hand-edited env var or
 * settings row must degrade a knob, never brick every report (same philosophy
 * as the model-resolution degrade path in jobRunner).
 */
export function getAnalysisEffortSetting(): EffortLevel {
  const raw = getSetting(
    SETTING_KEYS.analysisEffort,
    envOrUndefined("ANALYSIS_EFFORT") ?? DEFAULT_ANALYSIS_EFFORT,
  );
  const normalized = raw.trim().toLowerCase();
  return (EFFORT_LEVELS as readonly string[]).includes(normalized)
    ? (normalized as EffortLevel)
    : DEFAULT_ANALYSIS_EFFORT;
}
