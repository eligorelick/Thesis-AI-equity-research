/**
 * Pure-function coverage for scripts/reconcile-presumed-costs.mjs. The
 * script's main() only runs when it is the entry point, so importing it here
 * makes no request; the Cost API mapping is exercised with the documented
 * response shape and the paging loop with a fake fetch.
 *
 * Audit 2026-09-06 (§5): the script had targeted `cost_reports` (the API
 * serves `cost_report`) and read `amount` — the lowest currency unit, cents
 * for USD — as dollars, so the upper bound it computed was a hundred times
 * too high and no presumed row could ever be lowered; it also read one page
 * of at most seven daily buckets and stopped. These tests pin the path, the
 * unit and the paging.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts", "reconcile-presumed-costs.mjs");

interface Bucket {
  startTime: string;
  endTime: string;
  reportedUsd: number;
}

interface ReconcileModule {
  COST_API_URL: string;
  ANTHROPIC_VERSION: string;
  COST_API_PAGE_LIMIT: number;
  COST_API_MAX_PAGES: number;
  LOWEST_UNITS_PER_USD: number;
  bucketsFromCostReport(page: unknown): Bucket[];
  fetchCostReport(
    adminKey: string,
    startTime: string,
    endTime: string,
    fetchImpl?: (input: URL, init?: RequestInit) => Promise<Response>,
  ): Promise<Bucket[]>;
}

async function load(): Promise<ReconcileModule> {
  return (await import(pathToFileURL(SCRIPT).href)) as ReconcileModule;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Usage & Cost API mapping", () => {
  it("sums every result in a bucket, converts the lowest currency unit to dollars and keeps the window", async () => {
    const { bucketsFromCostReport, LOWEST_UNITS_PER_USD } = await load();
    expect(LOWEST_UNITS_PER_USD).toBe(100);
    const buckets = bucketsFromCostReport({
      data: [
        {
          starting_at: "2026-09-01T00:00:00Z",
          ending_at: "2026-09-02T00:00:00Z",
          // The documented example: "123.45" in USD is $1.2345.
          results: [{ amount: "123.45", currency: "USD" }, { amount: 250 }],
        },
        {
          starting_at: "2026-09-02T00:00:00Z",
          ending_at: "2026-09-03T00:00:00Z",
          results: [{ cost: { amount: 400 } }],
        },
      ],
    });
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({ startTime: "2026-09-01T00:00:00Z", endTime: "2026-09-02T00:00:00Z" });
    // (123.45 + 250) cents; binary floating point lands a hair under 3.7345.
    expect(buckets[0]!.reportedUsd).toBeCloseTo(3.7345, 9);
    expect(buckets[1]).toEqual({ startTime: "2026-09-02T00:00:00Z", endTime: "2026-09-03T00:00:00Z", reportedUsd: 4 });
  });

  it("skips entries without a usable window and treats unreadable amounts as zero", async () => {
    const { bucketsFromCostReport } = await load();
    expect(bucketsFromCostReport({
      data: [
        { ending_at: "2026-09-02T00:00:00Z", results: [{ amount: 500 }] },
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

  it("targets the organization cost report (singular) on a pinned API version", async () => {
    const { COST_API_URL, ANTHROPIC_VERSION, COST_API_PAGE_LIMIT } = await load();
    expect(COST_API_URL).toBe("https://api.anthropic.com/v1/organizations/cost_report");
    expect(ANTHROPIC_VERSION).toBe("2023-06-01");
    // The API's maximum buckets per page; the default is seven.
    expect(COST_API_PAGE_LIMIT).toBe(31);
  });
});

describe("fetchCostReport", () => {
  it("asks for daily buckets over the window at the page maximum, with the admin key in a header, and follows next_page", async () => {
    const { fetchCostReport, ANTHROPIC_VERSION } = await load();
    const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn(async (url: URL, init?: RequestInit) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return jsonResponse({
          data: [
            { starting_at: "2026-08-01T00:00:00Z", ending_at: "2026-08-02T00:00:00Z", results: [{ amount: "100" }] },
          ],
          has_more: true,
          next_page: "page_two",
        });
      }
      return jsonResponse({
        data: [
          { starting_at: "2026-08-02T00:00:00Z", ending_at: "2026-08-03T00:00:00Z", results: [{ amount: "50" }] },
        ],
        has_more: false,
        next_page: null,
      });
    });

    const buckets = await fetchCostReport("sk-ant-admin-test", "2026-08-01T00:00:00Z", "2026-09-07T00:00:00Z", fetchImpl);

    expect(buckets).toEqual([
      { startTime: "2026-08-01T00:00:00Z", endTime: "2026-08-02T00:00:00Z", reportedUsd: 1 },
      { startTime: "2026-08-02T00:00:00Z", endTime: "2026-08-03T00:00:00Z", reportedUsd: 0.5 },
    ]);
    expect(calls).toHaveLength(2);
    const first = calls[0]!.url;
    expect(first.origin + first.pathname).toBe("https://api.anthropic.com/v1/organizations/cost_report");
    expect(first.searchParams.get("starting_at")).toBe("2026-08-01T00:00:00Z");
    expect(first.searchParams.get("ending_at")).toBe("2026-09-07T00:00:00Z");
    expect(first.searchParams.get("bucket_width")).toBe("1d");
    expect(first.searchParams.get("limit")).toBe("31");
    expect(first.searchParams.has("page")).toBe(false);
    expect(calls[1]!.url.searchParams.get("page")).toBe("page_two");
    for (const call of calls) {
      const headers = call.init?.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("sk-ant-admin-test");
      expect(headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
      // The key travels in a header only, never in the URL.
      expect(call.url.href).not.toContain("sk-ant-admin-test");
    }
  });

  it("fails on a non-2xx response with the status, and refuses to page forever", async () => {
    const { fetchCostReport, COST_API_MAX_PAGES } = await load();
    await expect(
      fetchCostReport("k", "2026-08-01T00:00:00Z", "2026-09-07T00:00:00Z", async () => jsonResponse({ error: "no" }, 404)),
    ).rejects.toThrow(/cost_report responded 404/);

    let pages = 0;
    const endless = async (): Promise<Response> => {
      pages++;
      return jsonResponse({ data: [], has_more: true, next_page: `p${pages}` });
    };
    await expect(
      fetchCostReport("k", "2026-08-01T00:00:00Z", "2026-09-07T00:00:00Z", endless),
    ).rejects.toThrow(/still had more pages/);
    expect(pages).toBe(COST_API_MAX_PAGES);
  });
});
