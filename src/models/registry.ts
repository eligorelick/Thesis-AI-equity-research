/**
 * Model registry — the single offline source for every Anthropic model Thesis
 * may call: ids, lifecycle, context and output limits, effort and sampling
 * support, thinking behavior, refusal fallback, web-search tool variant, and
 * prices (input, output, cache write at both TTLs, cache read).
 *
 * The data lives in `config/models.json` (checked in, stamped with a snapshot
 * date). `npm run models:refresh` rebuilds that file from the Models API and
 * the pricing page; nothing at runtime or in tests ever fetches it. The JSON
 * is validated here at import time so a malformed registry fails fast.
 *
 * BROWSER-SAFE: this module imports only the JSON and zod, so the settings
 * contracts can advertise the same allow-list the provider enforces.
 */

import { z } from "zod";

import registryJson from "../../config/models.json";

export const REGISTRY_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type RegistryEffortLevel = (typeof REGISTRY_EFFORT_LEVELS)[number];

const ModelPricingSchema = z
  .object({
    /** USD per million input tokens. */
    inputPerMTok: z.number().positive(),
    /** USD per million output tokens (thinking is billed as output). */
    outputPerMTok: z.number().positive(),
    /** USD per million tokens written to the 5-minute prompt cache. */
    cacheWrite5mPerMTok: z.number().positive(),
    /** USD per million tokens written to the 1-hour prompt cache. */
    cacheWrite1hPerMTok: z.number().positive(),
    /** USD per million tokens read from the prompt cache. */
    cacheReadPerMTok: z.number().positive(),
  })
  .strict();
export type RegistryModelPricing = z.infer<typeof ModelPricingSchema>;

const RegistryModelSchema = z
  .object({
    id: z.string().regex(/^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/),
    family: z.enum(["fable", "opus", "sonnet", "haiku"]),
    generation: z.string().min(1),
    displayName: z.string().min(1),
    lifecycle: z.enum(["active", "deprecated", "retired"]),
    releasedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    /** Dated ids that exist for this entry. Empty from the 4.6 generation on. */
    datedSnapshotIds: z.array(z.string()),
    contextWindowTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    effort: z
      .object({
        supported: z.boolean(),
        levels: z.array(z.enum(REGISTRY_EFFORT_LEVELS)),
      })
      .strict(),
    sampling: z
      .object({ temperature: z.boolean(), topP: z.boolean(), topK: z.boolean() })
      .strict(),
    thinking: z
      .object({
        /** always-on: never send the param; adaptive: adaptive thinking; none: unsupported. */
        mode: z.enum(["always-on", "adaptive", "none"]),
        /** Whether `thinking: {type: "adaptive"}` is sent explicitly. */
        sendParam: z.boolean(),
      })
      .strict(),
    serverSideFallback: z
      .object({ beta: z.string().min(1), model: z.string().min(1) })
      .strict()
      .nullable(),
    webSearchToolType: z.string().regex(/^web_search_\d{8}$/),
    pricing: ModelPricingSchema,
    notes: z.array(z.string()),
  })
  .strict();
export type RegistryModel = z.infer<typeof RegistryModelSchema>;

const RegistrySchema = z
  .object({
    snapshotDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sources: z.record(z.string(), z.string()),
    webSearchUsdPerThousand: z.number().positive(),
    autoPreference: z.array(z.string()).min(1),
    models: z.array(RegistryModelSchema).min(1),
  })
  .strict()
  .superRefine((registry, ctx) => {
    const ids = new Set<string>();
    for (const model of registry.models) {
      if (ids.has(model.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate model id ${model.id}` });
      }
      ids.add(model.id);
      for (const dated of model.datedSnapshotIds) {
        if (!new RegExp(`^${model.id}-\\d{8}$`).test(dated)) {
          ctx.addIssue({ code: "custom", message: `dated id ${dated} is not ${model.id}-YYYYMMDD` });
        }
      }
      if (model.effort.supported !== model.effort.levels.length > 0) {
        ctx.addIssue({ code: "custom", message: `${model.id}: effort.levels must be non-empty exactly when effort is supported` });
      }
      if (model.thinking.mode !== "adaptive" && model.thinking.sendParam) {
        ctx.addIssue({ code: "custom", message: `${model.id}: only adaptive thinking may send a param` });
      }
      if (model.maxOutputTokens > model.contextWindowTokens) {
        ctx.addIssue({ code: "custom", message: `${model.id}: maxOutputTokens exceeds the context window` });
      }
    }
    for (const model of registry.models) {
      const fallback = model.serverSideFallback?.model;
      if (fallback !== undefined && !ids.has(fallback)) {
        ctx.addIssue({ code: "custom", message: `${model.id}: fallback model ${fallback} is not in the registry` });
      }
    }
    for (const preferred of registry.autoPreference) {
      const entry = registry.models.find((m) => m.id === preferred);
      if (entry === undefined) {
        ctx.addIssue({ code: "custom", message: `autoPreference names unknown model ${preferred}` });
      } else if (entry.lifecycle !== "active") {
        ctx.addIssue({ code: "custom", message: `autoPreference names non-active model ${preferred}` });
      }
    }
  });
export type ModelRegistry = z.infer<typeof RegistrySchema>;

/** Parse and validate a registry document (exported so tests and the refresh script share it). */
export function parseModelRegistry(document: unknown): ModelRegistry {
  const parsed = RegistrySchema.safeParse(document);
  if (!parsed.success) {
    throw new Error(`config/models.json is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

export const MODEL_REGISTRY: ModelRegistry = parseModelRegistry(registryJson);
export const REGISTRY_SNAPSHOT_DATE: string = MODEL_REGISTRY.snapshotDate;

/** Active entries in registry order. */
export function activeModels(): readonly RegistryModel[] {
  return MODEL_REGISTRY.models.filter((m) => m.lifecycle === "active");
}

/** Active ids in registry order — the allow-list for ANALYSIS_MODEL. */
export function activeModelIds(): readonly string[] {
  return activeModels().map((m) => m.id);
}

/** Every id a caller may write: active ids plus their listed dated snapshots. */
export function acceptedModelIds(): readonly string[] {
  return activeModels().flatMap((m) => [m.id, ...m.datedSnapshotIds]);
}

/** The `auto` preference order (all active). */
export function autoPreferenceIds(): readonly string[] {
  return MODEL_REGISTRY.autoPreference;
}

export interface ResolvedRegistryModel {
  entry: RegistryModel;
  /** The id as requested (may be a listed dated snapshot). */
  requestedId: string;
  viaDatedSnapshot: boolean;
}

/**
 * Resolve an id to its active registry entry: the exact id, or one of the
 * dated snapshot ids the entry lists. Anything else is null.
 */
export function resolveRegistryModel(id: string): ResolvedRegistryModel | null {
  for (const entry of activeModels()) {
    if (id === entry.id) return { entry, requestedId: id, viaDatedSnapshot: false };
    if (entry.datedSnapshotIds.includes(id)) return { entry, requestedId: id, viaDatedSnapshot: true };
  }
  return null;
}

/** Whether `id` is a dated snapshot the registry lists (never inferred from shape). */
export function isRegistryDatedSnapshot(id: string): boolean {
  return resolveRegistryModel(id)?.viaDatedSnapshot === true;
}

/**
 * Why an id is not accepted, in one sentence a user can act on. The dated
 * case is called out explicitly because older docs implied that any
 * `alias-YYYYMMDD` form exists; from the 4.6 generation on it does not.
 */
export function explainRejectedModelId(id: string): string {
  const accepted = acceptedModelIds().join(", ");
  const dated = /^(claude-[a-z0-9-]+?)-(\d{8})$/.exec(id);
  if (dated !== null) {
    const base = resolveRegistryModel(dated[1]!);
    if (base !== null && !base.viaDatedSnapshot) {
      return (
        `unsupported model "${id}": dated snapshot ids do not exist for ${base.entry.displayName} — ` +
        `from the 4.6 generation on the dateless id is the pinned snapshot; use "${base.entry.id}"`
      );
    }
  }
  const latest = /^(claude-[a-z0-9-]+?)-latest$/.exec(id);
  if (latest !== null && resolveRegistryModel(latest[1]!) !== null) {
    return `unsupported model "${id}": "-latest" aliases are not accepted; use "${latest[1]}"`;
  }
  return (
    `unsupported model "${id}": not in the model registry (config/models.json, snapshot ${REGISTRY_SNAPSHOT_DATE}); ` +
    `accepted ids: ${accepted}`
  );
}

/** Resolve or throw with {@link explainRejectedModelId}. */
export function assertRegistryModel(id: string): ResolvedRegistryModel {
  const resolved = resolveRegistryModel(id);
  if (resolved === null) throw new Error(explainRejectedModelId(id));
  return resolved;
}

/** Cache-write price multiplier over base input for a TTL. */
export function cacheWriteMultiplier(entry: RegistryModel, ttl: "5m" | "1h"): number {
  const price = ttl === "5m" ? entry.pricing.cacheWrite5mPerMTok : entry.pricing.cacheWrite1hPerMTok;
  return price / entry.pricing.inputPerMTok;
}

/** Whether an effort level is at least `high` (the tier that raises max_tokens to the registry ceiling). */
export function isHighOrAboveEffort(effort: RegistryEffortLevel | undefined): boolean {
  return effort === "high" || effort === "xhigh" || effort === "max";
}
