/**
 * Client-safe contracts for the two writable analysis settings.
 *
 * It is shared by the API boundary and the Settings page, so all imports here
 * must remain browser-safe and free of runtime infrastructure dependencies.
 */

export const ANALYSIS_MODEL_OPTIONS = [
  "auto",
  "claude-haiku-4-5",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
] as const;

export type AnalysisModelOption = (typeof ANALYSIS_MODEL_OPTIONS)[number];

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const DEFAULT_ANALYSIS_EFFORT: EffortLevel = "high";

const DATED_MODEL_FAMILIES = [
  "claude-haiku-4-5",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
] as const;

/** A provider model snapshot whose priced family and date shape are known. */
export type DatedAnalysisModel = string & { readonly __datedAnalysisModel: unique symbol };

/** Values a caller may submit. Unlisted dated models are carry-forward only. */
export type AnalysisModelSetting = AnalysisModelOption | DatedAnalysisModel;

export function isAnalysisModelOption(value: unknown): value is AnalysisModelOption {
  return typeof value === "string" &&
    (ANALYSIS_MODEL_OPTIONS as readonly string[]).includes(value);
}

export function isValidDatedAnalysisModel(value: unknown): value is DatedAnalysisModel {
  if (typeof value !== "string") return false;
  return DATED_MODEL_FAMILIES.some((family) =>
    new RegExp(`^${family}-\\d{8}$`).test(value),
  );
}

export function isAnalysisModelSetting(value: unknown): value is AnalysisModelSetting {
  return isAnalysisModelOption(value) || isValidDatedAnalysisModel(value);
}

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" &&
    (EFFORT_LEVELS as readonly string[]).includes(value);
}

export type SettingSource = "database" | "environment" | "default";

/** Effective values may contain an arbitrary legacy model that needs repair. */
export interface EffectiveSettings {
  analysisModel: string;
  analysisEffort: EffortLevel;
}

/** Exact full desired state accepted by the writer. */
export interface WritableSettings {
  analysisModel: AnalysisModelSetting;
  analysisEffort: EffortLevel;
}

export interface WritableSettingsSources {
  analysisModel: SettingSource;
  analysisEffort: SettingSource;
}

export interface WritableSettingsAuthority {
  state: EffectiveSettings;
  sources: WritableSettingsSources;
  revision: number;
  /** Strong quoted opaque entity tag. */
  etag: string;
}

export interface SettingsCapabilities {
  hasFmpKey: boolean;
  hasFinnhubKey: boolean;
  hasFredKey: boolean;
  hasAnthropicKey: boolean;
  fixtureMode: boolean;
}

/** Additive GET/POST representation; secrets never cross this boundary. */
export interface SettingsPayload extends EffectiveSettings {
  analysisModelOptions: readonly AnalysisModelOption[];
  analysisEffortOptions: readonly EffortLevel[];
  sources: WritableSettingsSources;
  revision: number;
  capabilities: SettingsCapabilities;
}

export type WriterStatus = "idle" | "saving" | "recovering" | "saved" | "error";

export interface WriterState {
  status: WriterStatus;
  authority: WritableSettingsAuthority;
  desired: EffectiveSettings;
  error: string | null;
}
