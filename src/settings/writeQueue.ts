/**
 * Client-side serialized settings persistence.
 *
 * This module deliberately depends only on the client-safe settings contracts.
 * A write is never aborted: an aborted request does not prove that the server
 * did not commit it. Ambiguous outcomes are reconciled with a coherent GET
 * before any later write is allowed to start.
 */

import {
  ANALYSIS_MODEL_OPTIONS,
  EFFORT_LEVELS,
  isAnalysisModelSetting,
  isEffortLevel,
  isValidDatedAnalysisModel,
  type AnalysisModelOption,
  type AnalysisModelSetting,
  type EffectiveSettings,
  type EffortLevel,
  type SettingSource,
  type SettingsCapabilities,
  type SettingsPayload,
  type WritableSettings,
  type WritableSettingsAuthority,
  type WritableSettingsSources,
  type WriterState,
  type WriterStatus,
} from "@/settings/contracts";

const SETTINGS_URL = "/api/settings";
const RECOVERY_MISMATCH_ERROR = "settings changed; authoritative values were reloaded";
const RECOVERY_FAILED_ERROR = "settings could not be confirmed";
const UNSUPPORTED_MODEL_ERROR = "select a supported analysis model before saving";

function cloneEffectiveSettings(state: EffectiveSettings): EffectiveSettings {
  return {
    analysisModel: state.analysisModel,
    analysisEffort: state.analysisEffort,
  };
}

function cloneWritableSettings(state: WritableSettings): WritableSettings {
  return {
    analysisModel: state.analysisModel,
    analysisEffort: state.analysisEffort,
  };
}

function cloneSources(sources: WritableSettingsSources): WritableSettingsSources {
  return {
    analysisModel: sources.analysisModel,
    analysisEffort: sources.analysisEffort,
  };
}

function cloneAuthority(
  authority: WritableSettingsAuthority,
): WritableSettingsAuthority {
  return {
    state: cloneEffectiveSettings(authority.state),
    sources: cloneSources(authority.sources),
    revision: authority.revision,
    etag: authority.etag,
  };
}

function cloneWriterState(state: WriterState): WriterState {
  return {
    status: state.status,
    authority: cloneAuthority(state.authority),
    desired: cloneEffectiveSettings(state.desired),
    error: state.error,
  };
}

function settingsEqual(left: EffectiveSettings, right: EffectiveSettings): boolean {
  return left.analysisModel === right.analysisModel &&
    left.analysisEffort === right.analysisEffort;
}

export interface SettingsWriteQueueOptions {
  initial: WritableSettingsAuthority;
  write(
    desired: WritableSettings,
    ifMatch: string,
  ): Promise<WritableSettingsAuthority>;
  recover(signal: AbortSignal): Promise<WritableSettingsAuthority>;
  onState(state: WriterState): void;
}

export interface SettingsWriteQueue {
  setDesired(state: WritableSettings): void;
  flush(): Promise<void>;
  dispose(): void;
}

type ActiveOperation = "write" | "recover" | null;
type RecoveryPurpose = "reconcile-write" | "preflight-write";

/**
 * Serialize full-state writes and coalesce a busy writer to its latest intent.
 * Every value crossing the queue boundary is copied so neither a transport nor
 * a UI callback can mutate the queue's CAS authority or pending state.
 */
export function createSettingsWriteQueue(
  options: SettingsWriteQueueOptions,
): SettingsWriteQueue {
  let authority = cloneAuthority(options.initial);
  let desired: EffectiveSettings = cloneEffectiveSettings(authority.state);
  let operation: ActiveOperation = null;
  let recoveryController: AbortController | null = null;
  let disposed = false;
  let requiresPreflightRecovery = false;
  const flushWaiters = new Set<() => void>();

  function emit(status: WriterStatus, error: string | null = null): void {
    if (disposed) return;
    const state: WriterState = {
      status,
      authority: cloneAuthority(authority),
      desired: cloneEffectiveSettings(desired),
      error,
    };
    // Give observers a disposable object. Internal state never escapes.
    options.onState(cloneWriterState(state));
  }

  function resolveFlushWaiters(): void {
    if (operation !== null) return;
    for (const resolve of flushWaiters) resolve();
    flushWaiters.clear();
  }

  function finish(): void {
    operation = null;
    recoveryController = null;
    resolveFlushWaiters();
  }

  function finishDisposed(): void {
    finish();
  }

  function beginRecovery(purpose: RecoveryPurpose): void {
    operation = "recover";
    const controller = new AbortController();
    recoveryController = controller;
    emit("recovering");

    void (async () => {
      try {
        const recovered = cloneAuthority(await options.recover(controller.signal));
        if (disposed) {
          finishDisposed();
          return;
        }

        authority = recovered;
        requiresPreflightRecovery = false;

        if (purpose === "preflight-write") {
          if (settingsEqual(authority.state, desired)) {
            desired = cloneEffectiveSettings(authority.state);
            emit("saved");
            finish();
            return;
          }

          if (!isAnalysisModelSetting(desired.analysisModel) ||
              !isEffortLevel(desired.analysisEffort)) {
            desired = cloneEffectiveSettings(authority.state);
            emit("error", UNSUPPORTED_MODEL_ERROR);
            finish();
            return;
          }

          beginWrite({
            analysisModel: desired.analysisModel,
            analysisEffort: desired.analysisEffort,
          });
          return;
        }

        if (settingsEqual(authority.state, desired)) {
          desired = cloneEffectiveSettings(authority.state);
          emit("saved");
        } else {
          // The server is authoritative after an ambiguous outcome. Discard
          // every queued full-state tail instead of replaying stale intent.
          desired = cloneEffectiveSettings(authority.state);
          emit("error", RECOVERY_MISMATCH_ERROR);
        }
        finish();
      } catch {
        if (disposed) {
          finishDisposed();
          return;
        }

        // We do not know whether the failed POST committed. Restore the last
        // confirmed authority for display, drop the tail, and require a fresh
        // GET before a later explicit edit may POST.
        desired = cloneEffectiveSettings(authority.state);
        requiresPreflightRecovery = true;
        emit("error", RECOVERY_FAILED_ERROR);
        finish();
      }
    })();
  }

  function beginWrite(next: WritableSettings): void {
    operation = "write";
    const inFlight = cloneWritableSettings(next);
    const ifMatch = authority.etag;
    emit("saving");

    void (async () => {
      try {
        // The adapter receives its own copy and cannot mutate inFlight.
        const response = cloneAuthority(
          await options.write(cloneWritableSettings(inFlight), ifMatch),
        );
        if (disposed) {
          finishDisposed();
          return;
        }

        if (!settingsEqual(response.state, inFlight)) {
          beginRecovery("reconcile-write");
          return;
        }

        // This response is the internal CAS base for a coalesced tail. The
        // visible desired state remains the latest user choice.
        authority = response;
        requiresPreflightRecovery = false;

        if (settingsEqual(desired, inFlight)) {
          desired = cloneEffectiveSettings(response.state);
          emit("saved");
          finish();
          return;
        }

        if (!isAnalysisModelSetting(desired.analysisModel) ||
            !isEffortLevel(desired.analysisEffort)) {
          desired = cloneEffectiveSettings(authority.state);
          emit("error", UNSUPPORTED_MODEL_ERROR);
          finish();
          return;
        }

        beginWrite({
          analysisModel: desired.analysisModel,
          analysisEffort: desired.analysisEffort,
        });
      } catch {
        if (disposed) {
          finishDisposed();
          return;
        }
        beginRecovery("reconcile-write");
      }
    })();
  }

  emit("idle");

  return {
    setDesired(state): void {
      if (disposed) return;
      desired = cloneWritableSettings(state);

      if (operation === "write") {
        emit("saving");
        return;
      }
      if (operation === "recover") {
        emit("recovering");
        return;
      }
      if (requiresPreflightRecovery) {
        beginRecovery("preflight-write");
        return;
      }
      beginWrite(cloneWritableSettings(state));
    },

    flush(): Promise<void> {
      if (operation === null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        flushWaiters.add(resolve);
      });
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      recoveryController?.abort();
      if (operation === null) resolveFlushWaiters();
    },
  };
}

export interface SettingsModelDisplayOption {
  value: string;
  carryOnly: boolean;
  unsupported: boolean;
}

/** Keep a current legacy/datetime value visible even when it is not advertised. */
export function settingsModelOptionsForDisplay(
  current: string,
  advertised: readonly AnalysisModelOption[],
): SettingsModelDisplayOption[] {
  const options = advertised.map((value) => ({
    value,
    carryOnly: false,
    unsupported: false,
  }));
  if (advertised.includes(current as AnalysisModelOption)) return options;
  return [
    {
      value: current,
      carryOnly: isValidDatedAnalysisModel(current),
      unsupported: !isValidDatedAnalysisModel(current),
    },
    ...options,
  ];
}

export type SettingsPageControllerStatus = "loading" | "ready" | "error";

export interface SettingsPageControllerState {
  status: SettingsPageControllerStatus;
  payload: SettingsPayload | null;
  writer: WriterState | null;
  error: string | null;
}

export interface SettingsPageControllerOptions {
  fetcher?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  onState(state: SettingsPageControllerState): void;
}

export interface SettingsPageController {
  start(): Promise<void>;
  setDesired(state: WritableSettings): void;
  setAnalysisModel(model: AnalysisModelSetting): void;
  setAnalysisEffort(effort: EffortLevel): void;
  flush(): Promise<void>;
  dispose(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isSettingSource(value: unknown): value is SettingSource {
  return value === "database" || value === "environment" || value === "default";
}

function decodeSources(value: unknown): WritableSettingsSources | null {
  if (!isRecord(value) ||
      !hasExactKeys(value, ["analysisModel", "analysisEffort"]) ||
      !isSettingSource(value.analysisModel) ||
      !isSettingSource(value.analysisEffort)) {
    return null;
  }
  return {
    analysisModel: value.analysisModel,
    analysisEffort: value.analysisEffort,
  };
}

function decodeCapabilities(value: unknown): SettingsCapabilities | null {
  const keys = [
    "hasFmpKey",
    "hasFinnhubKey",
    "hasFredKey",
    "hasAnthropicKey",
    "fixtureMode",
    "resumeOnStart",
  ] as const;
  if (!isRecord(value) || !hasExactKeys(value, keys)) return null;
  for (const key of keys) {
    if (typeof value[key] !== "boolean") return null;
  }
  return {
    hasFmpKey: value.hasFmpKey as boolean,
    hasFinnhubKey: value.hasFinnhubKey as boolean,
    hasFredKey: value.hasFredKey as boolean,
    hasAnthropicKey: value.hasAnthropicKey as boolean,
    fixtureMode: value.fixtureMode as boolean,
    resumeOnStart: value.resumeOnStart as boolean,
  };
}

function exactStringArray(
  value: unknown,
  expected: readonly string[],
): boolean {
  return Array.isArray(value) && value.length === expected.length &&
    value.every((entry, index) => entry === expected[index]);
}

function decodeSettingsPayload(value: unknown): SettingsPayload | null {
  const keys = [
    "analysisModel",
    "analysisModelOptions",
    "analysisEffort",
    "analysisEffortOptions",
    "sources",
    "revision",
    "capabilities",
  ] as const;
  if (!isRecord(value) || !hasExactKeys(value, keys)) return null;
  if (typeof value.analysisModel !== "string" ||
      !isEffortLevel(value.analysisEffort) ||
      !exactStringArray(value.analysisModelOptions, ANALYSIS_MODEL_OPTIONS) ||
      !exactStringArray(value.analysisEffortOptions, EFFORT_LEVELS) ||
      !Number.isSafeInteger(value.revision) ||
      (value.revision as number) < 0) {
    return null;
  }
  const sources = decodeSources(value.sources);
  const capabilities = decodeCapabilities(value.capabilities);
  if (sources === null || capabilities === null) return null;
  return {
    analysisModel: value.analysisModel,
    analysisModelOptions: [...ANALYSIS_MODEL_OPTIONS],
    analysisEffort: value.analysisEffort,
    analysisEffortOptions: [...EFFORT_LEVELS],
    sources,
    revision: value.revision as number,
    capabilities,
  };
}

function isStrongEntityTag(value: string | null): value is string {
  if (value === null || value.length < 2 || value[0] !== '"' ||
      value[value.length - 1] !== '"') {
    return false;
  }
  for (let index = 1; index < value.length - 1; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x21 || (code >= 0x23 && code <= 0x7e) || code >= 0x80) {
      continue;
    }
    return false;
  }
  return true;
}

interface DecodedSettingsResponse {
  payload: SettingsPayload;
  authority: WritableSettingsAuthority;
}

async function decodeSettingsResponse(
  response: Response,
): Promise<DecodedSettingsResponse> {
  if (!response.ok) throw new Error("settings request failed");
  const etag = response.headers.get("etag");
  if (!isStrongEntityTag(etag)) throw new Error("invalid settings ETag");
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error("invalid settings response");
  }
  const payload = decodeSettingsPayload(raw);
  if (payload === null) throw new Error("invalid settings response");
  return {
    payload,
    authority: {
      state: {
        analysisModel: payload.analysisModel,
        analysisEffort: payload.analysisEffort,
      },
      sources: cloneSources(payload.sources),
      revision: payload.revision,
      etag,
    },
  };
}

function clonePayload(payload: SettingsPayload): SettingsPayload {
  return {
    analysisModel: payload.analysisModel,
    analysisModelOptions: [...payload.analysisModelOptions],
    analysisEffort: payload.analysisEffort,
    analysisEffortOptions: [...payload.analysisEffortOptions],
    sources: cloneSources(payload.sources),
    revision: payload.revision,
    capabilities: { ...payload.capabilities },
  };
}

function cloneControllerState(
  state: SettingsPageControllerState,
): SettingsPageControllerState {
  return {
    status: state.status,
    payload: state.payload === null ? null : clonePayload(state.payload),
    writer: state.writer === null ? null : cloneWriterState(state.writer),
    error: state.error,
  };
}

/**
 * Pure page controller used by the route component. It owns initial/recovery
 * GET cancellation and delegates all mutation ordering to the queue above.
 */
export function createSettingsPageController(
  options: SettingsPageControllerOptions,
): SettingsPageController {
  const fetcher = options.fetcher ?? fetch;
  let disposed = false;
  let initialController: AbortController | null = null;
  let starting: Promise<void> | null = null;
  let queue: SettingsWriteQueue | null = null;
  let latestPayload: SettingsPayload | null = null;
  let latestWriter: WriterState | null = null;

  function publish(state: SettingsPageControllerState): void {
    if (disposed) return;
    options.onState(cloneControllerState(state));
  }

  function payloadForWriter(writer: WriterState): SettingsPayload | null {
    if (latestPayload === null) return null;
    return {
      ...clonePayload(latestPayload),
      analysisModel: writer.desired.analysisModel,
      analysisEffort: writer.desired.analysisEffort,
      sources: cloneSources(writer.authority.sources),
      revision: writer.authority.revision,
    };
  }

  function publishWriter(writer: WriterState): void {
    latestWriter = cloneWriterState(writer);
    publish({
      status: "ready",
      payload: payloadForWriter(writer),
      writer,
      error: writer.error,
    });
  }

  async function readAuthority(signal: AbortSignal): Promise<WritableSettingsAuthority> {
    const decoded = await decodeSettingsResponse(await fetcher(SETTINGS_URL, {
      cache: "no-store",
      signal,
    }));
    latestPayload = clonePayload(decoded.payload);
    return cloneAuthority(decoded.authority);
  }

  async function writeAuthority(
    desiredState: WritableSettings,
    ifMatch: string,
  ): Promise<WritableSettingsAuthority> {
    const decoded = await decodeSettingsResponse(await fetcher(SETTINGS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "if-match": ifMatch,
      },
      body: JSON.stringify(desiredState),
    }));
    if (!settingsEqual(decoded.authority.state, desiredState)) {
      throw new Error("settings response did not acknowledge desired state");
    }
    latestPayload = clonePayload(decoded.payload);
    return cloneAuthority(decoded.authority);
  }

  function publishUnsupportedModelError(): void {
    if (latestWriter === null) return;
    const failed: WriterState = {
      status: "error",
      authority: cloneAuthority(latestWriter.authority),
      desired: cloneEffectiveSettings(latestWriter.authority.state),
      error: UNSUPPORTED_MODEL_ERROR,
    };
    publishWriter(failed);
  }

  function setDesired(state: WritableSettings): void {
    if (disposed || queue === null) return;
    if (!isAnalysisModelSetting(state.analysisModel) ||
        !isEffortLevel(state.analysisEffort)) {
      publishUnsupportedModelError();
      return;
    }
    queue.setDesired(cloneWritableSettings(state));
  }

  return {
    start(): Promise<void> {
      if (starting !== null) return starting;
      publish({ status: "loading", payload: null, writer: null, error: null });
      initialController = new AbortController();
      starting = (async () => {
        try {
          const initial = await readAuthority(initialController!.signal);
          if (disposed) return;
          queue = createSettingsWriteQueue({
            initial,
            write: writeAuthority,
            recover: readAuthority,
            onState: publishWriter,
          });
        } catch {
          if (disposed) return;
          latestPayload = null;
          latestWriter = null;
          publish({
            status: "error",
            payload: null,
            writer: null,
            error: "failed to load settings",
          });
        } finally {
          initialController = null;
        }
      })();
      return starting;
    },

    setDesired,

    setAnalysisModel(model): void {
      if (latestWriter === null) return;
      setDesired({
        analysisModel: model,
        analysisEffort: latestWriter.desired.analysisEffort,
      });
    },

    setAnalysisEffort(effort): void {
      if (latestWriter === null) return;
      if (!isAnalysisModelSetting(latestWriter.desired.analysisModel)) {
        publishUnsupportedModelError();
        return;
      }
      setDesired({
        analysisModel: latestWriter.desired.analysisModel,
        analysisEffort: effort,
      });
    },

    async flush(): Promise<void> {
      if (starting !== null) await starting;
      await queue?.flush();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      initialController?.abort();
      queue?.dispose();
    },
  };
}
