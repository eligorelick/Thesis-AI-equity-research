/**
 * EDGAR client tests: pure URL/CIK/accession helpers, index-headers parsing
 * (the exhibit-type map), fake-transport client behavior (caching semantics,
 * 403-cooldown), and an OPT-IN 2-request live smoke test that runs ONLY when
 * EDGAR_LIVE_SMOKE=1 is set — `npm test` makes zero network requests
 * unconditionally, regardless of EDGAR_CONTACT being configured.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EDGAR_USER_AGENT,
  hasConfiguredEdgarIdentity,
  EdgarClient,
  EdgarRateLimitError,
  type EdgarTransport,
  type EdgarTransportResponse,
  archivesUrl,
  createDefaultEdgarTransport,
  resolveEdgarUserAgent,
  createEdgarClient,
  dashAccession,
  findDocumentByType,
  indexHeadersUrl,
  isExhibitType,
  padCik,
  parseIndexHeaders,
  stripAccessionDashes,
  unpadCik,
} from "@/providers/edgar";

const SAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "edgar");
const sample = (name: string): string => readFileSync(path.join(SAMPLES, name), "utf8");

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("CIK / accession helpers", () => {
  it("padCik zero-pads to 10 digits; unpadCik strips", () => {
    expect(padCik(320193)).toBe("0000320193");
    expect(padCik("19617")).toBe("0000019617");
    expect(padCik("CIK0000320193")).toBe("0000320193");
    expect(unpadCik("0000320193")).toBe("320193");
    expect(() => padCik("not-a-cik")).toThrow();
  });

  it("stripAccessionDashes / dashAccession round-trip and validate", () => {
    expect(stripAccessionDashes("0000320193-25-000079")).toBe("000032019325000079");
    expect(dashAccession("000032019325000079")).toBe("0000320193-25-000079");
    expect(() => stripAccessionDashes("bogus")).toThrow();
  });

  it("archivesUrl uses UNPADDED cik + dash-stripped accession (live-verified form)", () => {
    expect(archivesUrl("0000320193", "0000320193-25-000079", "aapl-20250927.htm")).toBe(
      "https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm",
    );
    expect(indexHeadersUrl(39092, "0001437749-26-020323")).toBe(
      "https://www.sec.gov/Archives/edgar/data/39092/000143774926020323/0001437749-26-020323-index-headers.html",
    );
  });
});

describe("parseIndexHeaders (exhibit TYPE map)", () => {
  it("parses the FRD index-headers: unescapes SGML, maps ex_919086.htm -> EX-13.1", () => {
    const idx = parseIndexHeaders(sample("frd_10k_index_headers.html"));
    expect(idx.documents.length).toBeGreaterThanOrEqual(5);
    expect(idx.typeByFilename["frd20260331_10k.htm"]).toBe("10-K");
    expect(idx.typeByFilename["ex_919086.htm"]).toBe("EX-13.1");
    expect(idx.periodOfReport).toBe("2026-03-31");
    expect(idx.filedAsOf).toBe("2026-06-11");
    expect(findDocumentByType(idx, "EX-13")?.filename).toBe("ex_919086.htm");
  });

  it("parses the WFC excerpt: the EX-13 is NAMED like a primary doc (F17 — never use filename heuristics)", () => {
    const idx = parseIndexHeaders(sample("wfc_index_headers_excerpt.html"));
    expect(idx.typeByFilename["wfc-20251231.htm"]).toBe("EX-13");
    expect(idx.typeByFilename["wfc-20251231_d2.htm"]).toBe("10-K");
    expect(findDocumentByType(idx, "EX-13")?.filename).toBe("wfc-20251231.htm");
  });

  it("isExhibitType matches by prefix, never exact string", () => {
    expect(isExhibitType("EX-13", "EX-13")).toBe(true);
    expect(isExhibitType("EX-13.1", "EX-13")).toBe(true);
    expect(isExhibitType("EX-31.A", "EX-31")).toBe(true);
    expect(isExhibitType("EX-10.A", "EX-13")).toBe(false);
    expect(isExhibitType("EX-13", "EX-1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Client with fake transport (no network)
// ---------------------------------------------------------------------------

function fakeTransport(routes: Record<string, { status?: number; body: string }>): {
  transport: EdgarTransport;
  calls: { url: string; ttlMs: number }[];
} {
  const calls: { url: string; ttlMs: number }[] = [];
  const transport: EdgarTransport = {
    fetchText(url, { ttlMs }): Promise<EdgarTransportResponse> {
      calls.push({ url, ttlMs });
      const hit = Object.entries(routes).find(([k]) => url.includes(k));
      if (hit === undefined) {
        return Promise.resolve({ status: 404, body: "not found", fetchedAt: new Date().toISOString(), fromCache: false, stale: false });
      }
      return Promise.resolve({
        status: hit[1].status ?? 200,
        body: hit[1].body,
        fetchedAt: "2026-07-06T12:00:00.000Z",
        fromCache: false,
        stale: false,
      });
    },
  };
  return { transport, calls };
}

describe("EdgarClient (fake transport)", () => {
  it("tickerToCik resolves AAPL and normalizes BRK.B -> BRK-B", async () => {
    const { transport } = fakeTransport({ "company_tickers.json": { body: sample("company_tickers_excerpt.json") } });
    const client = new EdgarClient({ transport });
    const aapl = await client.tickerToCik("aapl");
    expect(aapl.ok).toBe(true);
    if (aapl.ok) {
      expect(aapl.value.data.cik10).toBe("0000320193");
      expect(aapl.value.data.cik).toBe(320193);
      expect(aapl.value.data.title).toBe("Apple Inc.");
      expect(aapl.value.source).toBe("edgar");
    }
    const brk = await client.tickerToCik("BRK.B");
    expect(brk.ok).toBe(true);
    if (brk.ok) expect(brk.value.data.cik).toBe(1067983);
    const nope = await client.tickerToCik("ZZZZZZ");
    expect(nope.ok).toBe(false);
    if (!nope.ok) expect(nope.gap.severity).toBe("warn");
  });

  it("submissions + latestFiling: exact form match on parallel arrays (sample has 10-Q but NO 10-K in recent 40)", async () => {
    const { transport } = fakeTransport({ "submissions/CIK0000320193.json": { body: sample("aapl_submissions_truncated.json") } });
    const client = new EdgarClient({ transport });
    const sub = await client.submissions(320193);
    expect(sub.ok).toBe(true);
    if (sub.ok) {
      expect(sub.value.data.name).toBe("Apple Inc.");
      expect(sub.value.data.sic).toBe("3571");
      expect(sub.value.data.fiscalYearEnd).toBe("0926");
      expect(sub.value.data.recentFilings.length).toBe(40);
    }
    const tenQ = await client.latestFiling(320193, "10-Q");
    expect(tenQ.ok).toBe(true);
    if (tenQ.ok) {
      expect(tenQ.value.data.accessionNumber).toBe("0000320193-26-000013");
      expect(tenQ.value.data.primaryDocument).toBe("aapl-20260328.htm");
      expect(tenQ.value.asOf).toBe(tenQ.value.data.filingDate);
    }
    // Amendment-distinct exact matching: no "10-K" in the truncated sample -> gap, not a 10-K/A mixup.
    const tenK = await client.latestFiling(320193, "10-K");
    expect(tenK.ok).toBe(false);
  });

  it("filingIndexHeaders builds the TYPE map through the client", async () => {
    const { transport, calls } = fakeTransport({ "-index-headers.html": { body: sample("frd_10k_index_headers.html") } });
    const client = new EdgarClient({ transport });
    const idx = await client.filingIndexHeaders(39092, "0001437749-26-020323");
    expect(idx.ok).toBe(true);
    if (idx.ok) {
      expect(idx.value.data.typeByFilename["ex_919086.htm"]).toBe("EX-13.1");
      expect(idx.value.asOf).toBe("2026-06-11"); // FILED AS OF DATE from the SGML header
    }
    expect(calls[0].url).toBe("https://www.sec.gov/Archives/edgar/data/39092/000143774926020323/0001437749-26-020323-index-headers.html");
  });

  it("404s become manifest gaps, never throws", async () => {
    const { transport } = fakeTransport({});
    const client = new EdgarClient({ transport });
    const r = await client.companyFacts(999999999);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.gap.reason).toContain("404");
      expect(r.gap.attemptedSources?.[0]).toContain("companyfacts/CIK0999999999");
    }
  });

  it("403 = rate-limit signal: throws retryable EdgarRateLimitError and enters cooldown", async () => {
    const { transport, calls } = fakeTransport({ "submissions/": { status: 403, body: "Request Rate Threshold Exceeded" } });
    const client = new EdgarClient({ transport, cooldownMs: 60_000 });
    await expect(client.submissions(320193)).rejects.toBeInstanceOf(EdgarRateLimitError);
    expect(client.cooldownRemainingMs()).toBeGreaterThan(0);
    // Second call fails fast WITHOUT hitting the transport again.
    const callsBefore = calls.length;
    await expect(client.submissions(320193)).rejects.toBeInstanceOf(EdgarRateLimitError);
    expect(calls.length).toBe(callsBefore);
    try {
      await client.submissions(320193);
    } catch (e) {
      expect((e as EdgarRateLimitError).retryable).toBe(true);
      expect((e as EdgarRateLimitError).retryAfterMs).toBeGreaterThan(0);
    }
  });

  it("fullTextSearch builds params and parses ES hits into accession+filename", async () => {
    const es = JSON.stringify({
      took: 3,
      hits: {
        total: { value: 287, relation: "eq" },
        hits: [
          {
            _id: "0001640334-26-000241:acbm_10k.htm",
            _source: { ciks: ["0001622996"], display_names: ["ACRO BIOMEDICAL CO., LTD."], form: "10-K", file_date: "2026-02-11", file_type: "10-K" },
          },
        ],
      },
    });
    const { transport, calls } = fakeTransport({ "efts.sec.gov/LATEST/search-index": { body: es } });
    const client = new EdgarClient({ transport });
    const r = await client.fullTextSearch('"supply chain disruption"', { forms: "10-K", ciks: 320193, startdt: "2026-01-01", enddt: "2026-07-01" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.data.total).toBe(287);
      expect(r.value.data.hits[0].accession).toBe("0001640334-26-000241");
      expect(r.value.data.hits[0].filename).toBe("acbm_10k.htm");
      expect(r.value.data.hits[0].form).toBe("10-K");
    }
    const url = new URL(calls[0].url);
    expect(url.hostname).toBe("efts.sec.gov");
    expect(url.searchParams.get("q")).toBe('"supply chain disruption"');
    expect(url.searchParams.get("ciks")).toBe("0000320193");
    expect(url.searchParams.get("dateRange")).toBe("custom");
  });

  it("fetchFilingDoc refuses non-SEC hosts (programming error -> throw)", async () => {
    const { transport } = fakeTransport({});
    const client = new EdgarClient({ transport });
    await expect(client.fetchFilingDoc("https://evil.example.com/doc.htm")).rejects.toThrow(/non-SEC host/);
  });
});

describe("default transport (injected fetchFn — no network)", () => {
  it("sends the declared User-Agent and caches 200s within TTL", async () => {
    let hits = 0;
    let seenUa = "";
    const fetchFn: typeof fetch = (_input, init) => {
      hits++;
      const headers = init?.headers as Record<string, string>;
      seenUa = headers["User-Agent"];
      return Promise.resolve(new Response("BODY", { status: 200 }));
    };
    const t = createDefaultEdgarTransport({ fetchFn, maxRps: 1000 });
    const a = await t.fetchText("https://www.sec.gov/x", { ttlMs: 60_000 });
    const b = await t.fetchText("https://www.sec.gov/x", { ttlMs: 60_000 });
    expect(hits).toBe(1);
    expect(a.fromCache).toBe(false);
    expect(b.fromCache).toBe(true);
    expect(b.body).toBe("BODY");
    expect(seenUa).toBe(EDGAR_USER_AGENT);
  });

  it("resolveEdgarUserAgent() honors EDGAR_CONTACT and falls back to a placeholder", () => {
    const prev = process.env.EDGAR_CONTACT;
    try {
      process.env.EDGAR_CONTACT = "Jane Doe jane@example.com";
      expect(resolveEdgarUserAgent()).toBe("Jane Doe jane@example.com");
      delete process.env.EDGAR_CONTACT;
      expect(resolveEdgarUserAgent()).toContain("@example.com");
      process.env.EDGAR_CONTACT = "   ";
      expect(resolveEdgarUserAgent()).toContain("@example.com");
    } finally {
      if (prev === undefined) delete process.env.EDGAR_CONTACT;
      else process.env.EDGAR_CONTACT = prev;
    }
  });

  it("requires a reachable non-placeholder identity for live SEC acquisition", async () => {
    expect(hasConfiguredEdgarIdentity("Jane Doe jane@research.example.org")).toBe(false);
    expect(hasConfiguredEdgarIdentity("Thesis Research contact@example.com")).toBe(false);
    expect(hasConfiguredEdgarIdentity("jane@real-research.com")).toBe(false);
    expect(hasConfiguredEdgarIdentity("Jane Doe jane@firm.invalid")).toBe(false);
    expect(hasConfiguredEdgarIdentity("Jane Doe jane@real-research.com")).toBe(true);
    expect(hasConfiguredEdgarIdentity("no email here")).toBe(false);

    const original = process.env.EDGAR_CONTACT;
    try {
      delete process.env.EDGAR_CONTACT;
      const transport = createDefaultEdgarTransport({ maxRps: 1000 });
      await expect(
        transport.fetchText("https://www.sec.gov/identity-check", { ttlMs: 0 }),
      ).rejects.toThrow(/EDGAR_CONTACT/);
    } finally {
      if (original === undefined) delete process.env.EDGAR_CONTACT;
      else process.env.EDGAR_CONTACT = original;
    }
  });

  it("retries 5xx up to 3 attempts", async () => {
    let hits = 0;
    const fetchFn: typeof fetch = () => {
      hits++;
      return Promise.resolve(new Response("BAD", { status: 500 }));
    };
    const t = createDefaultEdgarTransport({ fetchFn, maxRps: 1000, retryBaseMs: 1 });
    const r = await t.fetchText("https://www.sec.gov/y", { ttlMs: 1 });
    expect(hits).toBe(3);
    expect(r.status).toBe(500);
  });

  it("serves the stale cached copy when the network dies after a successful fetch", async () => {
    let phase: "ok" | "throw" = "ok";
    let hits = 0;
    const fetchFn: typeof fetch = () => {
      hits++;
      if (phase === "throw") return Promise.reject(new TypeError("fetch failed"));
      return Promise.resolve(new Response("GOOD", { status: 200 }));
    };
    const t = createDefaultEdgarTransport({ fetchFn, maxRps: 1000, retryBaseMs: 1 });
    await t.fetchText("https://www.sec.gov/z", { ttlMs: 1 }); // cache, then let it expire
    phase = "throw";
    await new Promise((r) => setTimeout(r, 10));
    const r = await t.fetchText("https://www.sec.gov/z", { ttlMs: 1 });
    expect(hits).toBe(4); // 1 initial + 3 failed attempts
    expect(r.stale).toBe(true);
    expect(r.body).toBe("GOOD");
  });
});

// ---------------------------------------------------------------------------
// LIVE smoke test — OPT-IN ONLY (EDGAR_LIVE_SMOKE=1). Skipped otherwise, so
// the mocked suite never touches the network even with EDGAR_CONTACT set.
// When opted in: exactly 2 keyless requests (tickerToCik + submissions) with
// the declared UA at ≤5 req/s, and any network/gap failure FAILS the test —
// that is the point of opting in (no swallow-and-return).
// ---------------------------------------------------------------------------

describe.runIf(process.env.EDGAR_LIVE_SMOKE === "1")(
  "live smoke (2 requests, opt-in via EDGAR_LIVE_SMOKE=1)",
  () => {
    it("tickerToCik(AAPL) + submissions(AAPL) against real EDGAR", { timeout: 45_000 }, async () => {
      const client = createEdgarClient();

      // Request 1: ticker → CIK mapping. A gap or transport error is a FAILURE.
      const mapping = await client.tickerToCik("AAPL");
      if (!mapping.ok) throw new Error(`tickerToCik(AAPL) gap: ${mapping.gap.reason}`);
      expect(mapping.value.data.cik).toBe(320193);
      expect(mapping.value.data.cik10).toBe("0000320193");

      // Request 2: submissions for the resolved CIK.
      const sub = await client.submissions(mapping.value.data.cik10);
      if (!sub.ok) throw new Error(`submissions(AAPL) gap: ${sub.gap.reason}`);
      expect(sub.value.data.name.toLowerCase()).toContain("apple");
      expect(sub.value.data.recentFilings.length).toBeGreaterThan(100);
      const forms = new Set(sub.value.data.recentFilings.map((f) => f.form));
      expect(forms.has("10-K") || forms.has("10-Q")).toBe(true);
    });
  },
);
