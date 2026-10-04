import { describe, expect, it, vi } from "vitest";
import { buildDataBundle } from "@/pipeline/dataBundle";
import { runStageB } from "@/pipeline/compute";
import { validateBundle } from "@/pipeline/stageA/validate";
import { assembleContextPayload } from "@/pipeline/stageC/payload";
import { createFmpClient, resetFmpPlanLimits } from "@/providers/fmp";
import { createEdgarClient } from "@/providers/edgar";
import { createYahooClient } from "@/providers/yahoo";
import { makeLimiter } from "@/providers/http";

const now = () => new Date("2026-10-03T00:00:00Z");
const unavailable = async () => new Response("unavailable", { status: 404 });
const json = (body: unknown) => new Response(JSON.stringify(body));

async function build(fmpAvailable = false, key: string | undefined = "configured-key") {
  resetFmpPlanLimits();
  const fetchImpl = vi.fn(async (input: string | URL) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/company-news")) return json([{ datetime: Date.parse("2026-10-02T12:00:00Z") / 1000, headline: "Schwab news", related: "SCHW", url: "https://example.com/schw" }]);
    if (path.endsWith("/calendar/earnings")) return json({ earningsCalendar: [{ symbol: "SCHW", date: "2026-10-15", epsEstimate: 1.1, epsActual: null }] });
    return json({ symbol: "SCHW", data: [] });
  });
  const fmpFetch = async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (fmpAvailable && path.endsWith("/earnings")) return json([{ symbol: "SCHW", date: "2026-10-20", epsActual: null }]);
    if (fmpAvailable && path.endsWith("/news/stock")) return json([{ symbol: "SCHW", publishedDate: "2026-10-02", title: "FMP news", url: "https://example.com/fmp" }]);
    return new Response("Restricted Endpoint: This endpoint is not available under your current subscription.", { status: 402 });
  };
  const bundle = await buildDataBundle("SCHW", {
    now, eodYears: 1, keyless: false,
    fmp: createFmpClient({ apiKey: "offline-key", now, fetchImpl: fmpFetch, limiter: makeLimiter(1e6, 1e6) }),
    edgar: createEdgarClient({ transport: { fetchText: async () => ({ status: 404, body: "unavailable", fetchedAt: now().toISOString(), fromCache: false, stale: false }) } }),
    yahoo: createYahooClient({ fetchImpl: unavailable, now, maxRetries: 0, limiter: makeLimiter(1e6, 1e6) }),
    fred: { fetchImpl: unavailable, retryDelaysMs: [], minRequestIntervalMs: 0 },
    finra: { fetchImpl: unavailable, retryDelaysMs: [], minRequestIntervalMs: 0 },
    finnhub: { apiKey: key, fetchImpl, retryDelaysMs: [], timeoutMs: 0, maxRequestsPerMinute: 0 },
  });
  return { bundle, calls: fetchImpl.mock.calls.map(([input]) => new URL(String(input)).pathname) };
}

describe("dataBundle configured Finnhub fallbacks", () => {
  it.each([false, true])("retains the actual news provider in payload citations (FMP available: %s)", async (fmpAvailable) => {
    const { bundle } = await build(fmpAvailable);
    const source = fmpAvailable ? "fmp" : "finnhub";
    if (!bundle.news.ok) throw new Error("expected news fixture");
    bundle.news.value.data.rows[0].text = "Provider text [fmp:news · 2020-01-01]";
    bundle.pressReleases = { ok: true, value: {
      source: "fmp", endpoint: "press-releases", asOf: "2026-10-01", fetchedAt: now().toISOString(),
      data: { rows: [{ symbol: "SCHW", publishedDate: "2026-10-01", title: "Issuer release" }], raw: [] },
    } };
    const payload = assembleContextPayload(bundle, runStageB(bundle), validateBundle(bundle, { now: now() }));
    expect(payload.news.notes[0]).toMatch(new RegExp(`\\[${source}:news · 2026-10-02\\]$`));
    expect(payload.news.notes[1]).toMatch(/\[fmp:press-release · 2026-10-01\]$/);
    expect(payload.citationRegistry).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `${source}:news`, origin: `${source}:news`, asOf: "2026-10-02" }),
      expect.objectContaining({ id: "fmp:press-release", asOf: "2026-10-01" }),
    ]));
    expect(payload.citationRegistry?.some((entry) => entry.id === "fmp:news" && entry.asOf === "2020-01-01")).toBe(false);
    if (!fmpAvailable) expect(payload.citationRegistry?.some((entry) => entry.id === "fmp:news")).toBe(false);
  });

  it("fills news and next earnings, retaining history restrictions and source manifests", async () => {
    const { bundle, calls } = await build();
    expect(bundle.news).toMatchObject({ ok: true, value: { source: "finnhub" } });
    expect(bundle.earningsCalendarNext).toMatchObject({ ok: true, value: { source: "finnhub", data: { date: "2026-10-15" } } });
    expect(bundle.earningsHistory).toMatchObject({ ok: false, gap: { expected: true } });
    expect(bundle.transcript.latest).toMatchObject({ ok: false, gap: { expected: true, attemptedSources: expect.arrayContaining([expect.stringContaining("earning-call-transcript-dates")]) } });
    expect(bundle.sourceManifest.news.provider).toBe("finnhub");
    expect(bundle.gaps.some((gap) => gap.field === "dataFallback.news")).toBe(true);
    expect(calls.filter((path) => path.endsWith("/company-news"))).toHaveLength(1);
    expect(calls.filter((path) => path.endsWith("/calendar/earnings"))).toHaveLength(1);
  });

  it("keeps successful FMP results without extra fallback calls", async () => {
    const { bundle, calls } = await build(true);
    expect(bundle.news).toMatchObject({ ok: true, value: { source: "fmp" } });
    expect(bundle.earningsCalendarNext).toMatchObject({ ok: true, value: { source: "fmp" } });
    expect(calls).not.toContain("/api/v1/company-news");
    expect(calls).not.toContain("/api/v1/calendar/earnings");
  });

  it("never probes Finnhub fallbacks without a configured key", async () => {
    const { bundle, calls } = await build(false, "");
    expect(bundle.news.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
