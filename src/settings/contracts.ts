/**
 * Client-safe contracts for the two writable analysis settings.
 *
 * It is shared by the API boundary and the Settings page, so all imports here
 * must remain browser-safe and free of runtime infrastructure dependencies.
 */

import {
  activeModelIds,
  explainRejectedModelId,
  isRegistryDatedSnapshot,
  resolveRegistryModel,
} from "@/models/registry";

/** "auto" plus every active registry id (config/models.json), in registry order. */
export const ANALYSIS_MODEL_OPTIONS: readonly string[] = ["auto", ...activeModelIds()];

export type AnalysisModelOption = string;

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const DEFAULT_ANALYSIS_EFFORT: EffortLevel = "high";

/** A dated provider snapshot the registry lists (only the Haiku 4.5 family has one). */
export type DatedAnalysisModel = string & { readonly __datedAnalysisModel: unique symbol };

/**
 * Values a caller may submit. A listed dated snapshot is carry-forward only:
 * kept when it is already the current value, never offered as a new choice.
 * Dated ids the registry does not list (every family from the 4.6 generation
 * on) are invalid, not carry-forward.
 */
export type AnalysisModelSetting = AnalysisModelOption | DatedAnalysisModel;

export function isAnalysisModelOption(value: unknown): value is AnalysisModelOption {
  return typeof value === "string" &&
    (ANALYSIS_MODEL_OPTIONS as readonly string[]).includes(value);
}

export function isValidDatedAnalysisModel(value: unknown): value is DatedAnalysisModel {
  return typeof value === "string" && isRegistryDatedSnapshot(value);
}

/**
 * Why a model value is not accepted, or null when it is ("auto", an active
 * registry id, or a listed dated snapshot). Browser-safe.
 */
export function explainAnalysisModel(value: string): string | null {
  if (value === "auto" || resolveRegistryModel(value) !== null) return null;
  return explainRejectedModelId(value);
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
  /**
   * `THESIS_RESUME_ON_START` as the server resolved it. False means startup
   * held queued work, which is the only situation in which the Settings page
   * offers its "resume queued work" control.
   */
  resumeOnStart: boolean;
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
