/**
 * Persistent application settings. Arbitrary key/value helpers remain
 * available for cache/legacy callers; the analysis model + effort pair also
 * has a coherent, versioned compare-and-swap contract.
 *
 * Precedence: settings table -> live environment -> hard default.
 */

import "server-only";

import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb, type ThesisDb } from "@/db";
import { settings } from "@/db/schema";
import {
  DEFAULT_ANALYSIS_EFFORT,
  isAnalysisModelOption,
  isEffortLevel,
  isValidDatedAnalysisModel,
  type EffortLevel,
  type SettingSource,
  type WritableSettings,
  type WritableSettingsAuthority,
} from "@/settings/contracts";

export {
  DEFAULT_ANALYSIS_EFFORT,
  EFFORT_LEVELS,
  type EffortLevel,
} from "@/settings/contracts";

/** Well-known setting keys. */
export const SETTING_KEYS = {
  analysisModel: "analysisModel",
  analysisEffort: "analysisEffort",
} as const;

/** Non-secret monotonic version for the writable pair. */
export const WRITABLE_SETTINGS_REVISION_KEY = "__writableSettingsRevision";

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

/** Upserts an arbitrary setting. */
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

function envOrUndefined(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function getAnalysisModelSetting(): string {
  return getSetting(SETTING_KEYS.analysisModel, envOrUndefined("ANALYSIS_MODEL") ?? "auto");
}

export function getAnalysisEffortSetting(): EffortLevel {
  const raw = getSetting(
    SETTING_KEYS.analysisEffort,
    envOrUndefined("ANALYSIS_EFFORT") ?? DEFAULT_ANALYSIS_EFFORT,
  );
  const normalized = raw.trim().toLowerCase();
  return isEffortLevel(normalized) ? normalized : DEFAULT_ANALYSIS_EFFORT;
}

interface WritableRows {
  analysisModel?: string;
  analysisEffort?: string;
  revision?: string;
}

function readWritableRows(db: ThesisDb): WritableRows {
  const rows = db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, [
      SETTING_KEYS.analysisModel,
      SETTING_KEYS.analysisEffort,
      WRITABLE_SETTINGS_REVISION_KEY,
    ]))
    .all();
  const result: WritableRows = {};
  for (const row of rows) {
    if (row.key === SETTING_KEYS.analysisModel) result.analysisModel = row.value;
    else if (row.key === SETTING_KEYS.analysisEffort) result.analysisEffort = row.value;
    else if (row.key === WRITABLE_SETTINGS_REVISION_KEY) result.revision = row.value;
  }
  return result;
}

function parseRevision(raw: string | undefined): number {
  if (raw === undefined) return 0;
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new Error("invalid writable-settings revision");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("invalid writable-settings revision");
  }
  return value;
}

function resolveValue(
  row: string | undefined,
  envName: string,
  fallback: string,
): { value: string; source: SettingSource } {
  if (row !== undefined) return { value: row, source: "database" };
  const env = envOrUndefined(envName);
  if (env !== undefined) return { value: env, source: "environment" };
  return { value: fallback, source: "default" };
}

function authorityEtag(
  revision: number,
  analysisModel: string,
  analysisEffort: EffortLevel,
  modelSource: SettingSource,
  effortSource: SettingSource,
): string {
  const canonical = JSON.stringify([
    revision,
    analysisModel,
    analysisEffort,
    modelSource,
    effortSource,
  ]);
  return `"${createHash("sha256").update(canonical).digest("hex")}"`;
}

function authorityFromRows(rows: WritableRows): WritableSettingsAuthority {
  const model = resolveValue(rows.analysisModel, "ANALYSIS_MODEL", "auto");
  const rawEffort = resolveValue(
    rows.analysisEffort,
    "ANALYSIS_EFFORT",
    DEFAULT_ANALYSIS_EFFORT,
  );
  const normalizedEffort = rawEffort.value.trim().toLowerCase();
  const analysisEffort = isEffortLevel(normalizedEffort)
    ? normalizedEffort
    : DEFAULT_ANALYSIS_EFFORT;
  const revision = parseRevision(rows.revision);
  return {
    state: {
      analysisModel: model.value,
      analysisEffort,
    },
    sources: {
      analysisModel: model.source,
      analysisEffort: rawEffort.source,
    },
    revision,
    etag: authorityEtag(
      revision,
      model.value,
      analysisEffort,
      model.source,
      rawEffort.source,
    ),
  };
}

/** Reads both writable values and their revision from one SQL snapshot. */
export function getWritableSettingsAuthority(
  db: ThesisDb = getDb(),
): WritableSettingsAuthority {
  return authorityFromRows(readWritableRows(db));
}

export type WritableSettingsCasResult =
  | { ok: true; authority: WritableSettingsAuthority }
  | { ok: false; reason: "stale"; authority: WritableSettingsAuthority }
  | { ok: false; reason: "invalid"; authority: WritableSettingsAuthority };

function upsertInTransaction(db: ThesisDb, key: string, value: string): void {
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

/**
 * Atomically compares an opaque authority tag, validates the desired pair in
 * the context of the current model, applies both values, and advances exactly
 * one logical revision. The committed authority is built before releasing the
 * immediate writer lock.
 */
export function compareAndSwapWritableSettings(
  desired: WritableSettings,
  ifMatch: string,
  db: ThesisDb = getDb(),
): WritableSettingsCasResult {
  return db.transaction(
    (transaction) => {
      const tx = transaction as ThesisDb;
      const current = authorityFromRows(readWritableRows(tx));
      if (current.etag !== ifMatch) {
        return { ok: false, reason: "stale", authority: current } as const;
      }

      const modelAllowed = isAnalysisModelOption(desired.analysisModel) || (
        desired.analysisModel === current.state.analysisModel &&
        isValidDatedAnalysisModel(current.state.analysisModel)
      );
      if (!modelAllowed || !isEffortLevel(desired.analysisEffort)) {
        return { ok: false, reason: "invalid", authority: current } as const;
      }

      if (current.revision === Number.MAX_SAFE_INTEGER) {
        throw new Error("writable-settings revision overflow");
      }

      if (desired.analysisModel !== current.state.analysisModel) {
        upsertInTransaction(tx, SETTING_KEYS.analysisModel, desired.analysisModel);
      }
      if (desired.analysisEffort !== current.state.analysisEffort) {
        upsertInTransaction(tx, SETTING_KEYS.analysisEffort, desired.analysisEffort);
      }
      upsertInTransaction(
        tx,
        WRITABLE_SETTINGS_REVISION_KEY,
        String(current.revision + 1),
      );

      return {
        ok: true,
        authority: authorityFromRows(readWritableRows(tx)),
      } as const;
    },
    { behavior: "immediate" },
  );
}
