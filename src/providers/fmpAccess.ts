/** Response-driven FMP access observations. Never infers a subscription tier. */
import "server-only";

import { createHash } from "node:crypto";

export const FMP_ACCESS_TTL_MS = 15 * 60_000;
const MAX_OBSERVATIONS = 2_048;
const MAX_PROBES = 256;

export type FmpRestrictionScope = "endpoint" | "symbol";

/** Only explicit vendor messages establish reusable subscription restrictions. */
export function parseFmpRestriction(message: string): FmpRestrictionScope | null {
  // A symbol refusal must never become an endpoint-wide refusal, including
  // when a future vendor message also happens to mention "Restricted Endpoint".
  if (/\b(?:value\s+set|values?)\s+for\s+['"]?symbols?['"]?\s+is\s+not available under your current subscription\b/i.test(message)) {
    return "symbol";
  }
  if (/^\s*Restricted Endpoint:\s*This endpoint is not available under your current subscription\b/i.test(message)) {
    return "endpoint";
  }
  return null;
}

export class FmpAccessError extends Error {
  constructor(readonly scope: FmpRestrictionScope, readonly status: number) {
    const unavailable = scope === "endpoint"
      ? "Restricted Endpoint; this endpoint is unavailable with this key"
      : "this symbol is unavailable on this endpoint with this key";
    super(`FMP subscription (HTTP ${status}): ${unavailable}. Use other available sources; access is rechecked after 15 minutes.`);
    this.name = "FmpAccessError";
  }
}

interface Observation {
  /** Absent after an admitted response: endpoint discovery has completed. */
  refusal?: FmpAccessError;
  expiresAt: number;
}

const observations = new Map<string, Observation>();
const probes = new Map<string, Promise<void>>();

/** Credentials never appear in map keys, cache keys, or user-facing gaps. */
export function fmpAccessKey(apiKey: string, baseUrl: string): string {
  return createHash("sha256").update(JSON.stringify([baseUrl, apiKey])).digest("hex");
}

export function resetFmpAccess(): void {
  observations.clear();
  probes.clear();
}

function read(key: string, now: number): Observation | undefined {
  const value = observations.get(key);
  if (value !== undefined && value.expiresAt <= now) {
    observations.delete(key);
    return undefined;
  }
  return value;
}

function remember(key: string, refusal: FmpAccessError | undefined, now: number): void {
  for (const [storedKey, value] of observations) {
    if (value.expiresAt <= now) observations.delete(storedKey);
  }
  observations.delete(key);
  while (observations.size >= MAX_OBSERVATIONS) {
    const oldest = observations.keys().next().value;
    if (oldest === undefined) break;
    observations.delete(oldest);
  }
  observations.set(key, { refusal, expiresAt: now + FMP_ACCESS_TTL_MS });
}

interface AccessRequest {
  key: string;
  endpoint: string;
  /** Exact symbol or batch parameter; never attribute a batch refusal to its members. */
  symbols?: string;
  now: () => number;
  signal?: AbortSignal;
}

/** A waiter's cancellation must never release or cancel another request's probe. */
function waitForProbe(pending: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return pending;
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      () => { cleanup(); resolve(); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}

/**
 * Must run INSIDE the response-cache loader. Cache hits retain their original
 * freshness and remain usable even when live refreshes are restricted. Errors
 * throw before cache admission, so refusals cannot replace successful data.
 *
 * First discovery is serialized per key/endpoint. Once an admitted response
 * proves the endpoint answered, different symbols proceed independently, but
 * requests for one symbol still share a gate so annual/quarterly and EOD
 * windows cannot all pay for the same refusal. Waiting requests recheck the
 * learned restriction instead of receiving another query's response body.
 */
export async function withFmpAccess<T>(request: AccessRequest, loader: () => Promise<T>): Promise<T> {
  const endpointKey = JSON.stringify([request.key, request.endpoint]);
  const symbolKey = request.symbols === undefined
    ? undefined
    : JSON.stringify([request.key, request.endpoint, request.symbols]);

  for (;;) {
    request.signal?.throwIfAborted();
    const now = request.now();
    const endpoint = read(endpointKey, now);
    const refusal = endpoint?.refusal ?? (symbolKey === undefined ? undefined : read(symbolKey, now)?.refusal);
    if (refusal !== undefined) throw refusal;

    const probeKey = endpoint === undefined ? endpointKey : symbolKey ?? endpointKey;
    const pending = probes.get(probeKey);
    if (pending !== undefined) {
      await waitForProbe(pending, request.signal);
      continue;
    }

    let release = () => {};
    const probe = new Promise<void>((resolve) => { release = resolve; });
    // Bound coordination memory too. At unusually high cardinality, allow a
    // normal fetch rather than rejecting data or retaining unbounded gates.
    const tracked = probes.size < MAX_PROBES;
    if (tracked) probes.set(probeKey, probe);
    try {
      const value = await loader();
      remember(endpointKey, undefined, request.now());
      if (symbolKey !== undefined) observations.delete(symbolKey);
      return value;
    } catch (err) {
      if (err instanceof FmpAccessError) {
        if (err.scope === "endpoint") remember(endpointKey, err, request.now());
        else if (symbolKey !== undefined) remember(symbolKey, err, request.now());
      }
      throw err;
    } finally {
      if (tracked && probes.get(probeKey) === probe) probes.delete(probeKey);
      release();
    }
  }
}
