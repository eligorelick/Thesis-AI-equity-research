import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildDataBundle } from "@/pipeline/dataBundle";
import type { DataBundle } from "@/pipeline/types";
import {
  createEdgarClient,
  type EdgarTransport,
  type EdgarTransportResponse,
} from "@/providers/edgar";
import { createFmpClient } from "@/providers/fmp";
import { makeLimiter } from "@/providers/http";
import type { FetchResult } from "@/types/core";

const NOW = new Date("2026-07-06T00:00:00.000Z");
const REGISTRY_METADATA = new Set(["sourceManifest", "asOf", "gaps"]);

type ConfigFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
type SuccessfulFetchResult = Extract<FetchResult<unknown>, { ok: true }>;
type FailedFetchResult = Extract<FetchResult<unknown>, { ok: false }>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function unavailableEdgar(): EdgarTransport {
  return {
    fetchText(): Promise<EdgarTransportResponse> {
      return Promise.resolve({
        status: 404,
        body: "not available in producer-registry test",
        fetchedAt: NOW.toISOString(),
        fromCache: false,
        stale: false,
      });
    },
  };
}

function isFetchResult(value: unknown): value is FetchResult<unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.ok === true
    ? Object.prototype.hasOwnProperty.call(candidate, "value")
    : candidate.ok === false && Object.prototype.hasOwnProperty.call(candidate, "gap");
}

function returnedFetchResults(bundle: DataBundle): Map<string, FetchResult<unknown>> {
  const results = new Map<string, FetchResult<unknown>>();

  const visit = (value: unknown, memberPath: string): void => {
    if (isFetchResult(value)) {
      results.set(memberPath, value);
      return;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    for (const [member, child] of Object.entries(value)) {
      if (memberPath === "" && REGISTRY_METADATA.has(member)) continue;
      visit(child, memberPath === "" ? member : `${memberPath}.${member}`);
    }
  };

  visit(bundle, "");
  return results;
}

/**
 * WS4 (D-11): the placeholder ticker is EXMP, not DEMO. DEMO and DBNK are
 * reserved fixture symbols whose runs query no provider at all, so they can no
 * longer exercise the producer registry — which is about how provider results,
 * successful and failed, are indexed. The keyed FMP client below serves one
 * profile carrying a CIK (so `edgar.cik` still resolves through the profile
 * fallback, as it used to through the DEMO fixture) and refuses the rest.
 */
async function buildDeterministicBundle(): Promise<DataBundle> {
  const unavailableJson: ConfigFetch = () =>
    Promise.resolve(jsonResponse({ error: "not available in producer-registry test" }, 404));
  const fmpImpl: typeof fetch = ((input: string | URL | Request) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const endpoint = new URL(raw).pathname.replace(/^.*\/stable\//, "");
    // Three endpoints answer, so the manifest has successful producers on both
    // sides of the macro block the ordering assertion probes; the rest are
    // deterministic 401 gaps.
    if (endpoint === "profile") {
      return Promise.resolve(jsonResponse([{ symbol: "EXMP", cik: "0000000123", sector: "Technology" }]));
    }
    if (endpoint === "treasury-rates") {
      return Promise.resolve(jsonResponse([{ date: "2026-07-06", month1: 5, year10: 4.2 }]));
    }
    if (endpoint === "market-risk-premium") {
      return Promise.resolve(jsonResponse([{ country: "United States", totalEquityRiskPremium: 5.5 }]));
    }
    return Promise.resolve(jsonResponse({ "Error Message": "not available in producer-registry test" }, 401));
  }) as unknown as typeof fetch;

  return buildDataBundle("EXMP", {
    now: () => NOW,
    eodYears: 0,
    // The registry is about how PROVIDER results are indexed; the keyless
    // substitution layer adds `keyless.*` disclosures that belong to no
    // producer, and on a keyed plan it would run for the benchmark series.
    keyless: false,
    fmp: createFmpClient({
      apiKey: "PRODUCER-REGISTRY-KEY",
      fetchImpl: fmpImpl,
      limiter: makeLimiter(1_000_000, 1_000_000),
      now: () => NOW,
      timeoutMs: 1_000,
    }),
    edgar: createEdgarClient({ transport: unavailableEdgar() }),
    fredFetch: (seriesId) =>
      Promise.resolve({
        ok: true,
        value: {
          data: [{ date: "2026-07-01", value: 1 }],
          asOf: "2026-07-01",
          source: "fred",
          endpoint: `/series/${seriesId}`,
          fetchedAt: NOW.toISOString(),
        },
      }),
    finnhub: { apiKey: "TEST-KEY", fetchImpl: unavailableJson, retryDelaysMs: [] },
    finra: { fetchImpl: unavailableJson, retryDelaysMs: [], minRequestIntervalMs: 0 },
  });
}

describe("buildDataBundle producer registry", () => {
  it("keeps every returned FetchResult producer in exactly one source-or-gap registry", async () => {
    const bundle = await buildDeterministicBundle();
    const results = returnedFetchResults(bundle);
    const successful = [...results].filter(
      (entry): entry is [string, SuccessfulFetchResult] => entry[1].ok,
    );
    const failed = [...results].filter(
      (entry): entry is [string, FailedFetchResult] => !entry[1].ok,
    );

    expect(successful.length).toBeGreaterThan(0);
    expect(failed.length).toBeGreaterThan(0);
    expect(Object.keys(bundle.sourceManifest).sort()).toEqual(
      successful.map(([memberPath]) => memberPath).sort(),
    );

    for (const [memberPath, result] of successful) {
      expect(bundle.sourceManifest[memberPath]).toEqual({
        provider: result.value.source,
        endpoint: result.value.endpoint,
        asOf: result.value.asOf,
        fetchedAt: result.value.fetchedAt,
        stale: result.value.stale === true,
      });
    }

    const disclosedProducerGaps = new Set(
      bundle.gaps
        .filter((gap) => !gap.field.startsWith("cache."))
        .map((gap) => gap.field),
    );
    expect(disclosedProducerGaps).toEqual(new Set(failed.map(([, result]) => result.gap.field)));
  });

  it("preserves source-manifest insertion order across macro producers", async () => {
    const bundle = await buildDeterministicBundle();
    const sourcePaths = Object.keys(bundle.sourceManifest);
    const orderedSentinels = [
      "treasury",
      "marketRiskPremium",
      "edgar.cik",
      sourcePaths.find((memberPath) => memberPath.startsWith("macro.core.")),
      sourcePaths.find((memberPath) => memberPath.startsWith("macro.sector.")),
    ];

    expect(orderedSentinels.every((memberPath) => memberPath !== undefined)).toBe(true);
    const positions = orderedSentinels.map((memberPath) => sourcePaths.indexOf(memberPath!));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it("derives source and gap views from the actual return-shaped bundle core", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src", "pipeline", "dataBundle.ts"),
      "utf8",
    );

    expect(source.match(/const bundleCore\b/g)).toHaveLength(1);
    expect(source.match(/const resultRegistry\b/g)).toHaveLength(1);
    expect(source).toContain("collectFetchResultRegistry(bundleCore)");
    expect(source).toContain("Object.entries(resultRegistry)");
    expect(source).toContain("Object.values(resultRegistry)");
    expect(source).not.toContain("const put =");
    expect(source).not.toMatch(/const allResults\s*:[^=]+\s*=\s*\[/);
    expect(source).not.toMatch(/const resultRegistry[^=]*=\s*\{/);
    expect(source).not.toMatch(/resultRegistry\s*\[/);
  });
});
