/**
 * GET/POST /api/settings — coherent, versioned authority for the analysis
 * model + effort pair. Capability flags remain additive and read-only.
 */

import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/app/api/sameOrigin";
import { getConfig } from "@/config/env";
import {
  ANALYSIS_MODEL_OPTIONS,
  EFFORT_LEVELS,
  isEffortLevel,
  type SettingsPayload,
  type WritableSettings,
  type WritableSettingsAuthority,
} from "@/settings/contracts";
import {
  compareAndSwapWritableSettings,
  getWritableSettingsAuthority,
} from "@/settings/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;
const MAX_MODEL_LENGTH = 512;

function payloadFor(authority: WritableSettingsAuthority): SettingsPayload {
  const config = getConfig();
  return {
    ...authority.state,
    analysisModelOptions: ANALYSIS_MODEL_OPTIONS,
    analysisEffortOptions: EFFORT_LEVELS,
    sources: { ...authority.sources },
    revision: authority.revision,
    capabilities: {
      hasFmpKey: config.hasFmpKey,
      hasFinnhubKey: config.hasFinnhubKey,
      hasFredKey: config.hasFredKey,
      hasAnthropicKey: config.hasAnthropicKey,
      fixtureMode: config.fixtureMode,
      resumeOnStart: config.resumeOnStart,
    },
  };
}

function authorityResponse(
  authority: WritableSettingsAuthority,
  status = 200,
): NextResponse<SettingsPayload> {
  return NextResponse.json(payloadFor(authority), {
    status,
    headers: {
      ...NO_STORE_HEADERS,
      ETag: authority.etag,
    },
  });
}

function errorResponse(error: string, status: number): NextResponse<{ error: string }> {
  return NextResponse.json({ error }, { status, headers: NO_STORE_HEADERS });
}

/** Exactly one RFC entity-tag with a strong validator (quoted opaque bytes). */
function isSingleStrongEtag(value: string | null): value is string {
  return value !== null && /^"(?:[\x21\x23-\x7e\x80-\xff])*"$/.test(value);
}

function parseStructuralBody(value: unknown): WritableSettings | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "analysisEffort" || keys[1] !== "analysisModel") {
    return null;
  }
  if (
    typeof record.analysisModel !== "string" ||
    record.analysisModel.length === 0 ||
    record.analysisModel.length > MAX_MODEL_LENGTH ||
    !isEffortLevel(record.analysisEffort)
  ) {
    return null;
  }
  // Model support is contextual (an existing dated model may be carried), so
  // compareAndSwapWritableSettings validates it only after the CAS comparison.
  return {
    analysisModel: record.analysisModel,
    analysisEffort: record.analysisEffort,
  } as WritableSettings;
}

export async function GET(): Promise<NextResponse> {
  try {
    return authorityResponse(getWritableSettingsAuthority());
  } catch {
    return errorResponse("settings storage failure", 500);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  // The origin/Host trust boundary must run before headers, body parsing, or DB.
  const crossSite = assertSameOrigin(request);
  if (crossSite !== null) return crossSite;

  const ifMatch = request.headers.get("if-match");
  if (!isSingleStrongEtag(ifMatch)) {
    return errorResponse("a strong If-Match header is required", 428);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse("request body must be JSON", 400);
  }

  const desired = parseStructuralBody(raw);
  if (desired === null) return errorResponse("invalid settings", 400);

  try {
    const result = compareAndSwapWritableSettings(desired, ifMatch);
    if (!result.ok) {
      if (result.reason === "stale") return authorityResponse(result.authority, 412);
      return errorResponse("invalid settings", 400);
    }
    return authorityResponse(result.authority);
  } catch {
    return errorResponse("settings storage failure", 500);
  }
}
