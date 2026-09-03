/**
 * Pure-function coverage for scripts/reconcile-presumed-costs.mjs. The
 * script's main() only runs when it is the entry point, so importing it here
 * makes no request; the Cost API mapping is exercised with a recorded-shape
 * payload.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts", "reconcile-presumed-costs.mjs");

interface ReconcileModule {
  COST_API_URL: string;
  ANTHROPIC_VERSION: string;
  bucketsFromCostReport(page: unknown): Array<{ startTime: string; endTime: string; reportedUsd: number }>;
}

async function load(): Promise<ReconcileModule> {
  return (await import(pathToFileURL(SCRIPT).href)) as ReconcileModule;
}

describe("Usage & Cost API mapping", () => {
  it("sums every result in a bucket and keeps the reported window", async () => {
    const { bucketsFromCostReport } = await load();
    expect(bucketsFromCostReport({
      data: [
        {
          starting_at: "2026-09-01T00:00:00Z",
          ending_at: "2026-09-02T00:00:00Z",
          results: [{ amount: "1.25" }, { amount: 2.5 }],
        },
        {
          starting_at: "2026-09-02T00:00:00Z",
          ending_at: "2026-09-03T00:00:00Z",
          results: [{ cost: { amount: 4 } }],
        },
      ],
    })).toEqual([
      { startTime: "2026-09-01T00:00:00Z", endTime: "2026-09-02T00:00:00Z", reportedUsd: 3.75 },
      { startTime: "2026-09-02T00:00:00Z", endTime: "2026-09-03T00:00:00Z", reportedUsd: 4 },
    ]);
  });

  it("skips entries without a usable window and treats unreadable amounts as zero", async () => {
    const { bucketsFromCostReport } = await load();
    expect(bucketsFromCostReport({
      data: [
        { ending_at: "2026-09-02T00:00:00Z", results: [{ amount: 5 }] },
        { starting_at: "2026-09-01T00:00:00Z", ending_at: "2026-09-02T00:00:00Z", results: [{ amount: "n/a" }] },
        { starting_at: "2026-09-03T00:00:00Z", ending_at: "2026-09-04T00:00:00Z" },
      ],
    })).toEqual([
      { startTime: "2026-09-01T00:00:00Z", endTime: "2026-09-02T00:00:00Z", reportedUsd: 0 },
      { startTime: "2026-09-03T00:00:00Z", endTime: "2026-09-04T00:00:00Z", reportedUsd: 0 },
    ]);
    expect(bucketsFromCostReport({})).toEqual([]);
    expect(bucketsFromCostReport(null)).toEqual([]);
  });

  it("targets the organization cost report on a pinned API version", async () => {
    const { COST_API_URL, ANTHROPIC_VERSION } = await load();
    expect(COST_API_URL).toBe("https://api.anthropic.com/v1/organizations/cost_reports");
    expect(ANTHROPIC_VERSION).toBe("2023-06-01");
  });
});
