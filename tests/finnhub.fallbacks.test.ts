import { describe, expect, it, vi } from "vitest";
import { companyNews, earningsCalendar } from "@/providers/finnhub";

const config = (body: unknown, status = 200) => ({
  apiKey: "offline-finnhub-key",
  maxRequestsPerMinute: 0,
  timeoutMs: 0,
  retryDelaysMs: [],
  fetchImpl: vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify(body), { status })),
});
const article = { datetime: Date.parse("2026-10-01T12:00:00Z") / 1000, headline: "Schwab update", related: "SCHW", source: "Publisher", summary: "News summary", url: "https://example.com/schw" };
const release = { symbol: "SCHW", date: "2026-10-15", epsEstimate: 1.1, epsActual: null, revenueEstimate: 5e9, revenueActual: null };

describe("configured Finnhub fallbacks", () => {
  it("maps validated company news with original URLs and Finnhub provenance", async () => {
    const cfg = config([article]);
    const result = await companyNews("SCHW", "2026-09-01", "2026-10-02", cfg);
    expect(result).toMatchObject({ ok: true, value: { source: "finnhub", data: { rows: [{ symbol: "SCHW", title: "Schwab update", publishedDate: "2026-10-01T12:00:00.000Z", url: article.url, text: "News summary" }] } } });
    expect(String(cfg.fetchImpl.mock.calls[0]?.[0])).toContain("/company-news?symbol=SCHW&from=2026-09-01&to=2026-10-02");
    expect(cfg.fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ "X-Finnhub-Token": "offline-finnhub-key" });
  });

  it("withholds mismatched issuer news and unsafe article links", async () => {
    for (const row of [{ ...article, related: "MSFT" }, { ...article, url: "javascript:alert(1)" }]) {
      const result = await companyNews("SCHW", "2026-09-01", "2026-10-02", config([row]));
      expect(result.ok).toBe(false);
    }
  });

  it("filters news outside the requested window and discloses an empty result", async () => {
    const result = await companyNews("SCHW", "2026-10-02", "2026-10-03", config([article]));
    expect(result.ok).toBe(false);
  });

  it("maps calendar estimates without inventing reported values or a future observation date", async () => {
    const result = await earningsCalendar("SCHW", "2026-10-01", "2026-12-31", config({ earningsCalendar: [release] }));
    expect(result).toMatchObject({ ok: true, value: { source: "finnhub", data: { rows: [{ symbol: "SCHW", date: "2026-10-15", epsEstimated: 1.1, epsActual: null, revenueEstimated: 5e9 }] } } });
    if (result.ok) expect(result.value.asOf).toBe(result.value.fetchedAt.slice(0, 10));
  });

  it("rejects malformed calendars and wrong issuers", async () => {
    for (const body of [{ error: "denied" }, { earningsCalendar: [{ ...release, symbol: "MSFT" }] }, { earningsCalendar: [{ ...release, date: "2026-02-30" }] }, { earningsCalendar: [{ ...release, epsEstimate: "1.1" }] }]) {
      expect((await earningsCalendar("SCHW", "2026-01-01", "2026-12-31", config(body))).ok).toBe(false);
    }
  });

  it("does not send requests without a configured key", async () => {
    const cfg = { ...config([]), apiKey: undefined };
    expect((await companyNews("SCHW", "2026-10-01", "2026-10-03", cfg)).ok).toBe(false);
    expect((await earningsCalendar("SCHW", "2026-10-01", "2026-12-31", cfg)).ok).toBe(false);
    expect(cfg.fetchImpl).not.toHaveBeenCalled();
  });

  it("classifies actual access refusals as expected without retrying", async () => {
    const cfg = config({ error: "You don't have access to this resource." }, 403);
    const result = await companyNews("SCHW", "2026-10-01", "2026-10-03", cfg);
    expect(result).toMatchObject({ ok: false, gap: { expected: true, attemptedSources: ["finnhub", "/company-news"] } });
    expect(cfg.fetchImpl).toHaveBeenCalledTimes(1);
  });
});
