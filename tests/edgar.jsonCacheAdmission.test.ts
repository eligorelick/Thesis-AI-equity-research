import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createDefaultEdgarTransport, createEdgarClient } from "@/providers/edgar";

/**
 * Filing text supplied a `validateBody` so a bad document never entered the
 * cache, but the JSON endpoints — tickers, submissions, companyfacts — did not.
 * A malformed or wrong-entity HTTP 200 was therefore written to the cache and
 * only rejected after retrieval, so the poisoned row was served for its whole
 * TTL. A malformed-then-valid sequence must refetch and succeed.
 */
function jsonResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

const VALID_SUBMISSIONS = readFileSync(
  path.join(process.cwd(), "fixtures", "edgar", "aapl_submissions_truncated.json"),
  "utf8",
);

function client(fetchFn: typeof fetch) {
  return createEdgarClient({
    transport: createDefaultEdgarTransport({ fetchFn, maxRps: 1000 }),
  });
}

describe("EDGAR JSON bodies are validated before cache admission", () => {
  it("does not cache a malformed submissions body, then recovers", async () => {
    let phase: "bad" | "good" = "bad";
    const fetchFn = vi.fn(async () =>
      jsonResponse(phase === "bad" ? "{ not json" : VALID_SUBMISSIONS),
    ) as unknown as typeof fetch;
    const c = client(fetchFn);

    const rejected = await c.submissions(320193);
    expect(rejected.ok).toBe(false);

    phase = "good";
    const recovered = await c.submissions(320193);
    expect(recovered.ok).toBe(true);
    // Two live requests: the malformed body was never admitted, so the second
    // call was a cold miss rather than a poisoned cache hit.
    expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
  });

  it("does not cache a submissions body for the wrong CIK", async () => {
    const wrongCik = JSON.stringify({ ...JSON.parse(VALID_SUBMISSIONS), cik: 789019 });
    let phase: "wrong" | "right" = "wrong";
    const fetchFn = vi.fn(async () =>
      jsonResponse(phase === "wrong" ? wrongCik : VALID_SUBMISSIONS),
    ) as unknown as typeof fetch;
    const c = client(fetchFn);

    const rejected = await c.submissions(320193);
    expect(rejected.ok).toBe(false);

    phase = "right";
    const recovered = await c.submissions(320193);
    expect(recovered.ok).toBe(true);
    expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
  });

  it("does not cache a companyfacts body for the wrong CIK", async () => {
    const facts = (cik: number) =>
      JSON.stringify({ cik, entityName: "Apple Inc.", facts: { "us-gaap": {} } });
    let phase: "wrong" | "right" = "wrong";
    const fetchFn = vi.fn(async () =>
      jsonResponse(phase === "wrong" ? facts(789019) : facts(320193)),
    ) as unknown as typeof fetch;
    const c = client(fetchFn);

    expect((await c.companyFacts(320193)).ok).toBe(false);

    phase = "right";
    expect((await c.companyFacts(320193)).ok).toBe(true);
    expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
  });
});
