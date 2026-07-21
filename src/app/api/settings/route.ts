/**
 * GET/POST /api/settings — analysis model + effort persisted via
 * @/settings/settings.
 *
 * Setting keys (shared contract — LLM pass modules read the same keys via
 * @/settings/settings SETTING_KEYS):
 *   SETTING_KEYS.analysisModel  : "auto" | model id  (fallback: env ANALYSIS_MODEL, default "auto")
 *   SETTING_KEYS.analysisEffort : EFFORT_LEVELS member (fallback: env ANALYSIS_EFFORT, default "high")
 *
 * The former verifyModel key was removed (verification is deterministic and
 * never calls a model — SPEC §12); a stale client POSTing it is silently
 * ignored (z.object strips unknown keys).
 *
 * Capability flags are read-only here — keys live in .env only.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/app/api/sameOrigin";
import { getConfig } from "@/config/env";
import {
  EFFORT_LEVELS,
  SETTING_KEYS,
  getAnalysisEffortSetting,
  getAnalysisModelSetting,
  setSetting,
} from "@/settings/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Selectable models (the application contract §5 / §13.1). "auto" = best available. */
const ANALYSIS_MODEL_OPTIONS = [
  "auto",
  "claude-haiku-4-5",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
] as const;

const postBody = z.object({
  analysisModel: z.enum(ANALYSIS_MODEL_OPTIONS).optional(),
  analysisEffort: z.enum(EFFORT_LEVELS).optional(),
});

interface SettingsPayload {
  analysisModel: string;
  analysisModelOptions: readonly string[];
  analysisEffort: string;
  analysisEffortOptions: readonly string[];
  capabilities: {
    hasFmpKey: boolean;
    hasFinnhubKey: boolean;
    hasFredKey: boolean;
    hasAnthropicKey: boolean;
    fixtureMode: boolean;
  };
}

function currentPayload(): SettingsPayload {
  const config = getConfig();
  return {
    analysisModel: getAnalysisModelSetting(),
    analysisModelOptions: ANALYSIS_MODEL_OPTIONS,
    analysisEffort: getAnalysisEffortSetting(),
    analysisEffortOptions: EFFORT_LEVELS,
    capabilities: {
      hasFmpKey: config.hasFmpKey,
      hasFinnhubKey: config.hasFinnhubKey,
      hasFredKey: config.hasFredKey,
      hasAnthropicKey: config.hasAnthropicKey,
      fixtureMode: config.fixtureMode,
    },
  };
}

export async function GET(): Promise<NextResponse<SettingsPayload>> {
  return NextResponse.json(currentPayload());
}

export async function POST(request: Request): Promise<NextResponse> {
  // CSRF trust boundary: a cross-site browser page must not be able to flip
  // the analysis model/effort (cost levers). Rejects before parsing.
  const crossSite = assertSameOrigin(request);
  if (crossSite !== null) return crossSite;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { error: "request body must be JSON" },
      { status: 400 },
    );
  }

  const parsed = postBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid settings", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  if (parsed.data.analysisModel !== undefined) {
    setSetting(SETTING_KEYS.analysisModel, parsed.data.analysisModel);
  }
  if (parsed.data.analysisEffort !== undefined) {
    setSetting(SETTING_KEYS.analysisEffort, parsed.data.analysisEffort);
  }

  return NextResponse.json(currentPayload());
}
