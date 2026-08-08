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
  filingDocumentBodyProblem,
  findDocumentByType,
  indexHeadersUrl,
  isExhibitType,
  padCik,
  parseIndexHeaders,
  parseIndexHtm,
  stripAccessionDashes,
  unpadCik,
  type EdgarFiling,
} from "@/providers/edgar";

const SAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "edgar");
const sample = (name: string): string => readFileSync(path.join(SAMPLES, name), "utf8");

const HIDDEN_MARKUP_CASES: ReadonlyArray<readonly [string, (content: string) => string]> = [
  ["comment", (content) => `<html><body><!--${content}--><p>Hello world</p></body></html>`],
  ["CDATA", (content) => `<![CDATA[${content}]]><html><body>Hello world</body></html>`],
  ["processing instruction", (content) => `<?sample ${content}?><html><body>Hello world</body></html>`],
  ["DOCTYPE entity", (content) => `<!DOCTYPE html [<!ENTITY sample '${content}'>]><html><body>Hello world</body></html>`],
  ["script", (content) => `<html><script>${content}</script><body>Hello world</body></html>`],
  ["style", (content) => `<html><style>${content}</style><body>Hello world</body></html>`],
  ["title", (content) => `<html><title>${content}</title><body>Hello world</body></html>`],
  ["textarea", (content) => `<html><textarea>${content}</textarea><body>Hello world</body></html>`],
  ["prefixed script", (content) => `<html><h:script>${content}</h:script><body>Hello world</body></html>`],
];

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

  it("submissions rejects a response for a different padded CIK", async () => {
    const body = sample("aapl_submissions_truncated.json").replace(
      '"cik": "0000320193"',
      '"cik": "0000789019"',
    );
    const { transport } = fakeTransport({ "submissions/CIK0000320193.json": { body } });
    const client = new EdgarClient({ transport });

    const result = await client.submissions(320193);

    expect(result.ok).toBe(false);
  });

  it.each([
    "filingDate",
    "reportDate",
    "form",
    "primaryDocument",
    "primaryDocDescription",
    "isInlineXBRL",
    "isXBRL",
    "items",
    "acceptanceDateTime",
  ])("submissions rejects unequal parallel arrays when %s is shorter", async (field) => {
    const body = JSON.parse(sample("aapl_submissions_truncated.json")) as {
      filings: { recent: Record<string, unknown[]> };
    };
    body.filings.recent[field] = body.filings.recent[field].slice(0, -1);
    const { transport } = fakeTransport({
      "submissions/CIK0000320193.json": { body: JSON.stringify(body) },
    });
    const client = new EdgarClient({ transport });

    const result = await client.submissions(320193);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gap.severity).toBe("critical");
      expect(result.gap.reason).toMatch(/parallel array/i);
      expect(result.gap.reason).toContain(field);
    }
  });

  it("submissions rejects an unknown loose parallel array such as fileNumber when its length differs", async () => {
    const body = JSON.parse(sample("aapl_submissions_truncated.json")) as {
      filings: { recent: Record<string, unknown[]> };
    };
    body.filings.recent.fileNumber = body.filings.recent.fileNumber.slice(0, -1);
    const { transport } = fakeTransport({
      "submissions/CIK0000320193.json": { body: JSON.stringify(body) },
    });
    const client = new EdgarClient({ transport });

    const result = await client.submissions(320193);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gap.severity).toBe("critical");
      expect(result.gap.reason).toMatch(/parallel array/i);
      expect(result.gap.reason).toContain("fileNumber");
    }
  });

  it.each([
    ["malformed accession metadata", "accessionNumber", "0000320193-26-00001", /malformed accession/i],
    ["invalid filing date metadata", "filingDate", "2026-02-30", /invalid filing date/i],
    ["invalid report date metadata", "reportDate", "2025-02-29", /invalid report date/i],
  ])("submissions rejects $0", async (_label, field, value, reason) => {
    const body = JSON.parse(sample("aapl_submissions_truncated.json")) as {
      filings: { recent: Record<string, unknown[]> };
    };
    body.filings.recent[field][0] = value;
    const { transport } = fakeTransport({
      "submissions/CIK0000320193.json": { body: JSON.stringify(body) },
    });
    const client = new EdgarClient({ transport });

    const result = await client.submissions(320193);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gap.severity).toBe("critical");
      expect(result.gap.reason).toMatch(reason);
    }
  });

  it.each([
    ["malformed accession", { accessionNumber: "0000320193-26-00001" }, /malformed accession/i],
    ["filing date", { filingDate: "2026-02-30" }, /invalid filing date/i],
    ["primary document is empty", { primaryDocument: "" }, /unsafe primary document/i],
    ["primary document is a path", { primaryDocument: "nested/annual.htm" }, /unsafe primary document/i],
    ["primary document is a Windows path", { primaryDocument: "nested\\annual.htm" }, /unsafe primary document/i],
    ["primary document is dot", { primaryDocument: "." }, /unsafe primary document/i],
    ["primary document is dot-dot", { primaryDocument: ".." }, /unsafe primary document/i],
    ["accession is owned by another CIK", { accessionNumber: "0000789019-26-000001" }, /not admitted/i],
  ])("fetchFilingDocument rejects $0 before transport", async (_label, override, reason) => {
    const { transport, calls } = fakeTransport({});
    const client = new EdgarClient({ transport });
    const filing: EdgarFiling = {
      accessionNumber: "0000320193-26-000001",
      form: "10-K",
      filingDate: "2026-03-01",
      reportDate: "2025-12-31",
      primaryDocument: "annual.htm",
      ...override,
    };

    const result = await client.fetchFilingDocument(320193, filing);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gap.severity).toBe("critical");
      expect(result.gap.reason).toMatch(reason);
    }
    expect(calls).toHaveLength(0);
  });

  it("fetchFilingDocument constructs the contained SEC Archives URL for valid metadata", async () => {
    const { transport, calls } = fakeTransport({ "annual.htm": { body: "<html><body>Annual filing</body></html>" } });
    const client = new EdgarClient({ transport });
    const filing: EdgarFiling = {
      accessionNumber: "0000320193-26-000001",
      form: "10-K",
      filingDate: "2026-03-01",
      reportDate: "2025-12-31",
      primaryDocument: "annual.htm",
    };

    const result = await client.fetchFilingDocument(320193, filing);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/annual.htm",
    );
  });

  it("fetchFilingDocument accepts an agent-filed accession only after identity-validated submissions admission", async () => {
    const { transport, calls } = fakeTransport({
      "submissions/CIK0000320193.json": { body: sample("aapl_submissions_truncated.json") },
      "ef20071035_8k.htm": { body: "<html><body>Agent-filed AAPL 8-K</body></html>" },
      "agent-exhibit.htm": { body: "<html><body>Exhibit 99.1 under admitted accession</body></html>" },
    });
    const client = new EdgarClient({ transport });
    const submissions = await client.submissions(320193);
    expect(submissions.ok).toBe(true);
    if (!submissions.ok) return;
    const filing = submissions.value.data.recentFilings.find(
      (row) => row.accessionNumber === "0001140361-26-015711",
    );
    expect(filing).toBeDefined();
    if (filing === undefined) return;

    const result = await client.fetchFilingDocument(320193, filing);

    expect(result.ok).toBe(true);
    expect(calls.at(-1)?.url).toBe(
      "https://www.sec.gov/Archives/edgar/data/320193/000114036126015711/ef20071035_8k.htm",
    );

    const exhibit = await client.fetchFilingDocument(320193, {
      ...filing,
      primaryDocument: "agent-exhibit.htm",
    });
    expect(exhibit.ok).toBe(true);
    expect(calls.at(-1)?.url).toBe(
      "https://www.sec.gov/Archives/edgar/data/320193/000114036126015711/agent-exhibit.htm",
    );
  });

  it("does not partially admit agent-filed accessions from an invalid submissions payload", async () => {
    const body = JSON.parse(sample("aapl_submissions_truncated.json")) as {
      filings: { recent: Record<string, unknown[]> };
    };
    body.filings.recent.fileNumber = body.filings.recent.fileNumber.slice(0, -1);
    const { transport, calls } = fakeTransport({
      "submissions/CIK0000320193.json": { body: JSON.stringify(body) },
      "ef20071035_8k.htm": { body: "must not be fetched" },
    });
    const client = new EdgarClient({ transport });
    const submissions = await client.submissions(320193);
    expect(submissions.ok).toBe(false);
    const filing: EdgarFiling = {
      accessionNumber: "0001140361-26-015711",
      form: "8-K",
      filingDate: "2026-04-20",
      reportDate: "2026-04-20",
      primaryDocument: "ef20071035_8k.htm",
    };

    const result = await client.fetchFilingDocument(320193, filing);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.gap.reason).toMatch(/not admitted/i);
    expect(calls).toHaveLength(1);
  });

  it("filingDocumentBodyProblem rejects an empty 200 body without excluding valid text filings", () => {
    expect(filingDocumentBodyProblem(" \r\n\t ")).toMatch(/empty/i);
    expect(filingDocumentBodyProblem("<html><body>Annual filing</body></html>")).toBeNull();
    expect(filingDocumentBodyProblem("<SEC-DOCUMENT>plain-text filing</SEC-DOCUMENT>")).toBeNull();
  });

  it("fetchFilingDocument turns an empty 200 body into a typed critical gap", async () => {
    const { transport, calls } = fakeTransport({ "annual.htm": { body: " \n " } });
    const client = new EdgarClient({ transport });
    const filing: EdgarFiling = {
      accessionNumber: "0000320193-26-000001",
      form: "10-K",
      filingDate: "2026-03-01",
      reportDate: "2025-12-31",
      primaryDocument: "annual.htm",
    };

    const result = await client.fetchFilingDocument(320193, filing);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gap.severity).toBe("critical");
      expect(result.gap.reason).toMatch(/empty/i);
    }
    expect(calls).toHaveLength(1);
  });

  it("companyFacts rejects a response for a different CIK", async () => {
    const { transport } = fakeTransport({
      "companyfacts/CIK0000320193.json": {
        body: JSON.stringify({ cik: 789019, entityName: "MICROSOFT CORPORATION", facts: {} }),
      },
    });
    const client = new EdgarClient({ transport });

    const result = await client.companyFacts(320193);

    expect(result.ok).toBe(false);
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

  it.each([
    "https://notsec.gov/doc.htm",
    "https://sec.gov.evil.example/doc.htm",
    "http://www.sec.gov/doc.htm",
  ])("fetchFilingDoc refuses a non-HTTPS or non-SEC URL before transport: %s", async (url) => {
    const { transport, calls } = fakeTransport({});
    const client = new EdgarClient({ transport });
    await expect(client.fetchFilingDoc(url)).rejects.toThrow(/HTTPS|SEC host/i);
    expect(calls).toHaveLength(0);
  });

  it.each(["https://sec.gov/doc.htm", "https://www.sec.gov/doc.htm", "https://data.sec.gov/doc.htm"])(
    "fetchFilingDoc accepts a legitimate HTTPS SEC host: %s",
    async (url) => {
      const { transport, calls } = fakeTransport({ "doc.htm": { body: "Annual report filing disclosure" } });
      const client = new EdgarClient({ transport });

      const result = await client.fetchFilingDoc(url);

      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(1);
    },
  );
});

describe("default transport (injected fetchFn — no network)", () => {
  it("does not cache a blank HTTP-200 filing on a cold memory-cache miss", async () => {
    let phase: "blank" | "valid" = "blank";
    let hits = 0;
    const fetchFn: typeof fetch = () => {
      hits++;
      return Promise.resolve(
        new Response(
          phase === "blank" ? " \r\n\t " : "<html><body>Valid annual filing disclosure</body></html>",
          { status: 200 },
        ),
      );
    };
    const transport = createDefaultEdgarTransport({ fetchFn, maxRps: 1000 });
    const url = "https://www.sec.gov/Archives/edgar/data/320193/cold.htm";

    await expect(
      transport.fetchText(url, { ttlMs: 60_000, validateBody: filingDocumentBodyProblem }),
    ).rejects.toThrow(/empty/i);

    phase = "valid";
    const recovered = await transport.fetchText(url, {
      ttlMs: 60_000,
      validateBody: filingDocumentBodyProblem,
    });
    expect(recovered.body).toContain("Valid annual filing");
    expect(recovered.fromCache).toBe(false);
    expect(hits).toBe(2);
  });

  it("preserves last-good memory-cache filing when refresh is blank or implausible", async () => {
    let body = "<html><body>GOOD annual filing disclosure</body></html>";
    let hits = 0;
    const fetchFn: typeof fetch = () => {
      hits++;
      return Promise.resolve(new Response(body, { status: 200 }));
    };
    const transport = createDefaultEdgarTransport({ fetchFn, maxRps: 1000 });
    const url = "https://www.sec.gov/Archives/edgar/data/320193/refresh.htm";
    const opts = { ttlMs: 1, validateBody: filingDocumentBodyProblem };

    await transport.fetchText(url, opts);
    await new Promise((resolve) => setTimeout(resolve, 10));
    body = "<html><head><title>Page Not Found</title></head><body>File not found</body></html>";
    const preserved = await transport.fetchText(url, opts);

    expect(preserved.body).toContain("GOOD");
    expect(preserved.stale).toBe(true);
    expect(preserved.fromCache).toBe(true);
    expect(hits).toBe(2);
  });

  it("accepts filing structures and meaningful untagged plain text", () => {
    expect(
      filingDocumentBodyProblem(
        '<?xml version="1.0"?><xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance"></xbrli:xbrl>',
      ),
    ).toBeNull();
    expect(
      filingDocumentBodyProblem(
        "UNITED STATES SECURITIES AND EXCHANGE COMMISSION annual report filing disclosure.",
      ),
    ).toBeNull();
    expect(
      filingDocumentBodyProblem(
        "Management described durable customer demand, improving operating margins, and the principal uncertainties affecting next year's results.",
      ),
    ).toBeNull();
  });

  it.each([
    [
      "alternate instance prefix",
      '<inst:xbrl xmlns:inst="http://www.xbrl.org/2003/instance"><inst:context id="c"/></inst:xbrl>',
    ],
    [
      "default instance namespace",
      '<xbrl xmlns="http://www.xbrl.org/2003/instance"><context id="c"/></xbrl>',
    ],
    [
      "2013 inline prefix",
      '<html xmlns:alt="http://www.xbrl.org/2013/inlineXBRL"><alt:header></alt:header></html>',
    ],
    [
      "2008 inline prefix",
      "<html xmlns:legacy='http://www.xbrl.org/2008/inlineXBRL'><legacy:nonnumeric>Example</legacy:nonnumeric></html>",
    ],
    [
      "inline tuple element",
      '<html xmlns:report="http://www.xbrl.org/2013/inlineXBRL"><report:tuple name="example"></report:tuple></html>',
    ],
  ])("accepts bound XBRL namespaces with a non-normative %s", (_label, body) => {
    expect(filingDocumentBodyProblem(body)).toBeNull();
  });

  it.each(HIDDEN_MARKUP_CASES)(
    "sanitized semantic admission ignores a filing keyword hidden in %s",
    (_label, wrap) => {
      expect(filingDocumentBodyProblem(wrap("Annual filing disclosure"))).toMatch(/implausible/i);
    },
  );

  it.each(HIDDEN_MARKUP_CASES)(
    "sanitized semantic admission ignores SGML filing structure hidden in %s",
    (_label, wrap) => {
      const hiddenSgml = "<DOCUMENT>\n<TYPE>10-K\n<SEQUENCE>1\n<FILENAME>hidden.htm\n<TEXT>";
      expect(filingDocumentBodyProblem(wrap(hiddenSgml))).toMatch(/implausible/i);
    },
  );

  it.each(HIDDEN_MARKUP_CASES)(
    "sanitized index parsing ignores an SGML document hidden in %s",
    (_label, wrap) => {
      const hiddenSgml = "<DOCUMENT>\n<TYPE>10-K\n<SEQUENCE>1\n<FILENAME>hidden.htm\n<TEXT>";
      expect(parseIndexHeaders(wrap(hiddenSgml)).documents).toEqual([]);
    },
  );

  it("sanitized semantic admission ignores hidden SEC errors without rejecting visible filing prose", () => {
    const body = [
      "<html><body>",
      "<!-- EDGAR is currently unavailable. Page Not Found. -->",
      "<script>Temporarily unavailable. Please try again later.</script>",
      "<p>The registrant reported durable customer demand, improving operating margins, and disciplined capital allocation while management monitored principal market risks.</p>",
      "</body></html>",
    ].join("");

    expect(filingDocumentBodyProblem(body)).toBeNull();
  });

  it.each([
    "Your request originates from an undeclared automated tool",
    "OK",
  ])("sanitized semantic admission applies known SEC error patterns to actual titles: %s", (title) => {
    const body = [
      `<html><head><title>${title}</title></head><body>`,
      "<p>This site provides public company filing information, investor education resources, policy materials, and additional guidance for market participants.</p>",
      "</body></html>",
    ].join("");
    expect(filingDocumentBodyProblem(body)).toMatch(/error|placeholder/i);
  });

  it("sanitized semantic admission does not synthesize a filing identifier across an omitted region", () => {
    expect(filingDocumentBodyProblem("<html><body>10-<!-- hidden -->K</body></html>"))
      .toMatch(/implausible/i);
  });

  it("sanitized semantic admission preserves word boundaries across ordinary tags", () => {
    expect(filingDocumentBodyProblem("<html><body><span>Annual</span><span>filing</span></body></html>"))
      .toBeNull();
  });

  it("sanitized semantic admission and index parsers ignore fake markup inside quoted attributes", () => {
    const hiddenSgml = "<DOCUMENT><TYPE>10-K<SEQUENCE>1<FILENAME>hidden.htm<TEXT>";
    const body = `<html data-sample="${hiddenSgml}"><body>Hello world</body></html>`;
    expect(filingDocumentBodyProblem(body)).toMatch(/implausible/i);
    expect(parseIndexHeaders(body).documents).toEqual([]);
    const escapedBody = `<html data-sample="${hiddenSgml.replaceAll("<", "&lt;").replaceAll(">", "&gt;")}"><body>Hello world</body></html>`;
    expect(filingDocumentBodyProblem(escapedBody)).toMatch(/implausible/i);
    expect(parseIndexHeaders(escapedBody).documents).toEqual([]);
    for (const hrefSample of [hiddenSgml, hiddenSgml.replaceAll("<", "&lt;").replaceAll(">", "&gt;")]) {
      const hrefBody = `<html><body><a href='${hrefSample}'>Hello world</a></body></html>`;
      expect(filingDocumentBodyProblem(hrefBody)).toMatch(/implausible/i);
      expect(parseIndexHeaders(hrefBody).documents).toEqual([]);
    }

    const hiddenRow =
      '<tr><td>9</td><td>Hidden</td><td><a href="hidden.htm">hidden.htm</a></td><td>EX-99</td><td>9</td></tr>';
    expect(parseIndexHtm(`<html><body><div data-sample='${hiddenRow}'>Hello world</div></body></html>`).documents)
      .toEqual([]);
    const escapedRow = hiddenRow.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    expect(parseIndexHtm(`<html><body><div data-sample='${escapedRow}'>Hello world</div></body></html>`).documents)
      .toEqual([]);
  });

  it.each([
    '<Error><Code>AccessDenied</Code></Error>',
    '&lt;Error&gt;&lt;Code&gt;AccessDenied&lt;/Code&gt;&lt;/Error&gt;',
    "Your request originates from an undeclared automated tool",
  ])("sanitized semantic admission ignores an error sample in a quoted attribute: %s", (sampleText) => {
    const visibleProse =
      "The registrant described durable demand, improving margins, disciplined investment, and principal risks that could affect future operating results.";
    expect(filingDocumentBodyProblem(`<html data-sample="${sampleText}"><body>${visibleProse}</body></html>`))
      .toBeNull();
  });

  it("sanitized index parsers retain visible rows and discard earlier hidden rows", () => {
    const hiddenSgml = "&lt;DOCUMENT&gt;\n&lt;TYPE&gt;EX-99\n&lt;SEQUENCE&gt;9\n&lt;FILENAME&gt;hidden.htm\n&lt;TEXT&gt;";
    const visibleSgml = "&lt;DOCUMENT&gt;\n&lt;TYPE&gt;10-K\n&lt;SEQUENCE&gt;1\n&lt;FILENAME&gt;annual.htm\n&lt;TEXT&gt;";
    const headers = parseIndexHeaders(
      `<html><body><!--${hiddenSgml}--><pre>${visibleSgml}</pre></body></html>`,
    );
    expect(headers.documents).toEqual([
      { type: "10-K", sequence: "1", filename: "annual.htm", description: undefined },
    ]);

    const html = parseIndexHtm(
      '<html><body><script><table><tr><td>9</td><td>Hidden</td><td><a href="hidden.htm">hidden.htm</a></td><td>EX-99</td><td>9</td></tr></table></script>' +
        '<table><tr><td>1</td><td>Annual report</td><td><a href="annual.htm">annual.htm</a></td><td>10-K</td><td>100</td></tr></table></body></html>',
    );
    expect(html.documents).toEqual([
      { type: "10-K", sequence: "1", filename: "annual.htm", description: "Annual report" },
    ]);
  });

  it("sanitized HTML index parsing preserves a safe href outside admission content", () => {
    const html = parseIndexHtm(
      '<html><body><table><tr><td>1</td><td>Annual report</td><td><a href="/Archives/edgar/data/320193/annual.htm">Inline XBRL Viewer</a></td><td>10-K</td><td>100</td></tr></table></body></html>',
    );
    expect(html.documents).toEqual([
      { type: "10-K", sequence: "1", filename: "annual.htm", description: "Annual report" },
    ]);
  });

  it("sanitized index admission does not cache a hidden-only fake index", async () => {
    const hiddenSgml = "<DOCUMENT>\n<TYPE>10-K\n<SEQUENCE>1\n<FILENAME>hidden.htm\n<TEXT>";
    let headerHits = 0;
    let fallbackHits = 0;
    const fetchFn: typeof fetch = (input) => {
      if (String(input).endsWith("-index-headers.html")) {
        headerHits++;
        return Promise.resolve(new Response(`<html><body><!--${hiddenSgml}--></body></html>`, { status: 200 }));
      }
      fallbackHits++;
      return Promise.resolve(new Response("<html><body>Hello world</body></html>", { status: 200 }));
    };
    const client = new EdgarClient({
      transport: createDefaultEdgarTransport({ fetchFn, maxRps: 1000 }),
    });

    const first = await client.filingIndexHeaders(320193, "0000320193-26-000001");
    const second = await client.filingIndexHeaders(320193, "0000320193-26-000001");

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(headerHits).toBe(2);
    expect(fallbackHits).toBe(2);
  });

  it.each([
    [
      "HTML table",
      '<script><table><tr><th>Document</th><th>Type</th></tr><tr><td><a href="hidden.htm">hidden.htm</a></td><td>10-K</td></tr></table></script>',
    ],
    [
      "plain-text index",
      "<!-- ACCESSION NUMBER 0000320193-26-000001 PUBLIC DOCUMENT COUNT 1 FILENAME hidden.htm -->",
    ],
    [
      "quoted-attribute plain-text index",
      '<div data-sample="ACCESSION NUMBER 0000320193-26-000001 PUBLIC DOCUMENT COUNT 1 FILENAME hidden.htm"></div>',
    ],
    [
      "href-attribute plain-text index",
      '<a href="ACCESSION NUMBER 0000320193-26-000001 PUBLIC DOCUMENT COUNT 1 FILENAME hidden.htm">details</a>',
    ],
    [
      "href-attribute SGML index",
      "<a href='<DOCUMENT><TYPE>10-K<SEQUENCE>1<FILENAME>hidden.htm<TEXT>'>details</a>",
    ],
  ])("sanitized index admission ignores a hidden-only %s shape", async (_label, hiddenIndex) => {
    const visibleProse =
      "<p>Management described durable demand, improving margins, disciplined investment, and principal risks that could affect future operating results.</p>";
    let fallbackHits = 0;
    const fetchFn: typeof fetch = (input) => {
      if (String(input).endsWith("-index-headers.html")) {
        return Promise.resolve(new Response("<html><body>Hello world</body></html>", { status: 200 }));
      }
      fallbackHits++;
      return Promise.resolve(
        new Response(`<html><body>${hiddenIndex}${visibleProse}</body></html>`, { status: 200 }),
      );
    };
    const client = new EdgarClient({
      transport: createDefaultEdgarTransport({ fetchFn, maxRps: 1000 }),
    });

    const first = await client.filingIndexHeaders(320193, "0000320193-26-000001");
    const second = await client.filingIndexHeaders(320193, "0000320193-26-000001");

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(fallbackHits).toBe(2);
  });

  it("treats a self-closing script token as raw text under HTML semantics", () => {
    const body = '<html><script/><z:header xmlns:z="http://www.xbrl.org/2013/inlineXBRL"></script><body>Hello world</body></html>';
    expect(filingDocumentBodyProblem(body)).toMatch(/implausible/i);
  });

  it.each([
    ["U+200C", "\u200Csample"],
    ["U+2163", "\u2163sample"],
  ])("accepts XML 1.0 NameStart prefixes beginning with %s", (_label, prefix) => {
    const body = `<html xmlns:${prefix}="http://www.xbrl.org/2013/inlineXBRL"><${prefix}:header/></html>`;
    expect(filingDocumentBodyProblem(body)).toBeNull();
  });

  it.each([
    ["unbound prefix", "<foo:xbrl></foo:xbrl>"],
    ["wrong prefix binding", '<foo:xbrl xmlns:foo="https://example.com/not-xbrl"></foo:xbrl>'],
    ["wrong conventional-prefix binding", '<xbrli:xbrl xmlns:xbrli="https://example.com/not-xbrl"></xbrli:xbrl>'],
    [
      "lookalike namespace attribute",
      '<foo:xbrl data-xmlns:foo="http://www.xbrl.org/2003/instance"></foo:xbrl>',
    ],
    ["unbound default local name", "<xbrl></xbrl>"],
    [
      "unused valid declaration",
      '<html xmlns:inst="http://www.xbrl.org/2003/instance"><body>Hello world</body></html>',
    ],
    [
      "bound XBRL code sample inside a comment",
      '<html><body><!-- <inst:xbrl xmlns:inst="http://www.xbrl.org/2003/instance"></inst:xbrl> --><p>Hello world</p></body></html>',
    ],
    [
      "bound XBRL code sample inside a script",
      '<html><script type="text/plain"><inst:xbrl xmlns:inst="http://www.xbrl.org/2003/instance"></inst:xbrl></script><body>Hello world</body></html>',
    ],
  ])("rejects unbound XBRL lookalikes: %s", (_label, body) => {
    expect(filingDocumentBodyProblem(body)).toMatch(/implausible/i);
  });

  it.each([
    [
      "xmlns text inside another attribute value",
      '<html data-note="prefix xmlns:z=\'http://www.xbrl.org/2013/inlineXBRL\' suffix"><z:header/></html>',
    ],
    [
      "uppercase XMLNS spelling",
      '<html XMLNS:z="http://www.xbrl.org/2013/inlineXBRL"><z:header/></html>',
    ],
    [
      "leading namespace URI whitespace",
      '<html xmlns:z=" http://www.xbrl.org/2013/inlineXBRL"><z:header/></html>',
    ],
    [
      "trailing namespace URI whitespace",
      '<html xmlns:z="http://www.xbrl.org/2013/inlineXBRL "><z:header/></html>',
    ],
    [
      "processing-instruction sample",
      '<?sample value=\'<z:header xmlns:z="http://www.xbrl.org/2013/inlineXBRL"/>\'?><html><body>Hello world</body></html>',
    ],
    [
      "DOCTYPE internal entity sample",
      '<!DOCTYPE html [<!ENTITY sample \'<z:header xmlns:z="http://www.xbrl.org/2013/inlineXBRL"/>\'>]><html><body>Hello world</body></html>',
    ],
    [
      "NBSP before a namespace equals sign",
      '<html xmlns:z\u00a0="http://www.xbrl.org/2013/inlineXBRL"><z:header/></html>',
    ],
    [
      "reserved xmlns prefix",
      '<html xmlns:xmlns="http://www.xbrl.org/2013/inlineXBRL" xmlns:real="http://www.xbrl.org/2013/inlineXBRL"><real:header/></html>',
    ],
    [
      "reserved xml prefix rebound",
      '<html xmlns:xml="http://www.xbrl.org/2013/inlineXBRL" xmlns:real="http://www.xbrl.org/2013/inlineXBRL"><real:header/></html>',
    ],
    [
      "XMLNS namespace URI binding",
      '<html xmlns:bad="http://www.w3.org/2000/xmlns/" xmlns:real="http://www.xbrl.org/2013/inlineXBRL"><real:header/></html>',
    ],
    [
      "DOCTYPE comment containing a fake subset terminator",
      '<!DOCTYPE html [<!-- ]> --><z:header xmlns:z="http://www.xbrl.org/2013/inlineXBRL"/> ]><html><body>Hello world</body></html>',
    ],
    [
      "DOCTYPE processing instruction containing a fake subset terminator",
      '<!DOCTYPE html [<?sample ]> ?><z:header xmlns:z="http://www.xbrl.org/2013/inlineXBRL"/> ]><html><body>Hello world</body></html>',
    ],
    [
      "prefixed script code sample",
      '<html><h:script><z:header xmlns:z="http://www.xbrl.org/2013/inlineXBRL"/></h:script><body>Hello world</body></html>',
    ],
    [
      "textarea code sample",
      '<html><textarea><z:header xmlns:z="http://www.xbrl.org/2013/inlineXBRL"/></textarea><body>Hello world</body></html>',
    ],
  ])("namespace tokenizer rejects declaration confusion: %s", (_label, body) => {
    expect(filingDocumentBodyProblem(body)).toMatch(/implausible|malformed/i);
  });

  it.each([
    [
      "comment",
      '<html><body><!-- <z:header xmlns:z="http://www.xbrl.org/2013/inlineXBRL"><p>Annual filing disclosure</p></body></html>',
    ],
    [
      "CDATA",
      '<![CDATA[<z:header xmlns:z="http://www.xbrl.org/2013/inlineXBRL"><html><body>Annual filing disclosure</body></html>',
    ],
    [
      "script",
      '<html><script><z:header xmlns:z="http://www.xbrl.org/2013/inlineXBRL"></scriptless><body>Annual filing disclosure</body></html>',
    ],
    [
      "style",
      '<html><style><z:header xmlns:z="http://www.xbrl.org/2013/inlineXBRL"></styleless><body>Annual filing disclosure</body></html>',
    ],
    ["closing tag", "<html><body>Annual filing disclosure</body></"],
  ])("namespace tokenizer rejects an unterminated ignored %s region", (_label, body) => {
    expect(filingDocumentBodyProblem(body)).toMatch(/malformed/i);
  });

  it.each([
    [
      "quoted unrelated > and xmlns text",
      '<html data-note="literal > xmlns:fake=\'not-a-declaration\' text" xmlns:real=\'http://www.xbrl.org/2013/inlineXBRL\'><real:header/></html>',
    ],
    [
      "nested instance binding",
      '<outer xmlns:inst="http://www.xbrl.org/2003/instance"><inner><inst:xbrl/></inner></outer>',
    ],
    [
      "nested default binding",
      '<outer><inner xmlns="http://www.xbrl.org/2003/instance"><xbrl/></inner></outer>',
    ],
    [
      "nearest valid redeclaration",
      '<outer xmlns:z="https://example.com/not-xbrl"><inner xmlns:z="http://www.xbrl.org/2013/inlineXBRL"><z:numerator/></inner></outer>',
    ],
    [
      "Unicode namespace prefix",
      '<html xmlns:δοκιμή="http://www.xbrl.org/2013/inlineXBRL"><δοκιμή:header/></html>',
    ],
  ])("namespace tokenizer accepts safe valid structure: %s", (_label, body) => {
    expect(filingDocumentBodyProblem(body)).toBeNull();
  });

  it("namespace tokenizer honors a nearer non-XBRL redeclaration", () => {
    const body = '<outer xmlns:z="http://www.xbrl.org/2013/inlineXBRL"><inner xmlns:z="https://example.com/not-xbrl"><z:header/></inner></outer>';
    expect(filingDocumentBodyProblem(body)).toMatch(/implausible/i);
  });

  it("rejects minimal arbitrary markup and branded SEC maintenance or XML error envelopes", () => {
    expect(filingDocumentBodyProblem("OK")).toMatch(/error|placeholder/i);
    expect(filingDocumentBodyProblem("<html><body>Hello world</body></html>")).toMatch(/implausible/i);
    expect(filingDocumentBodyProblem("<html><header>General highlights</header></html>"))
      .toMatch(/implausible/i);
    expect(filingDocumentBodyProblem("<html><title>Page Not Found</title><body>File not found</body></html>"))
      .toMatch(/error|placeholder/i);
    expect(
      filingDocumentBodyProblem(
        "<html><head><title>SEC.gov | EDGAR Maintenance</title></head><body>EDGAR is currently unavailable. Please try again later.</body></html>",
      ),
    ).toMatch(/error|maintenance|placeholder/i);
    expect(
      filingDocumentBodyProblem(
        '<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Request denied</Message></Error>',
      ),
    ).toMatch(/error|implausible/i);
  });

  it("rejects the official SEC scheduled maintenance site shell", () => {
    const body = [
      "<html><head><title>Scheduled Maintenance – SEC.gov</title></head><body>",
      "<header>U.S. Securities and Exchange Commission SEC.gov</header>",
      "<h1>Scheduled Maintenance</h1>",
      "<h2>Forms Unavailable During Maintenance</h2>",
      "<p>Some forms and filing tools are unavailable while scheduled maintenance is completed. Please return after the maintenance window.</p>",
      "<footer>Accessibility, privacy, investor information, and contact links.</footer>",
      "</body></html>",
    ].join("");

    expect(filingDocumentBodyProblem(body)).toMatch(/maintenance|error|placeholder/i);
  });

  it("accepts a genuine issuer filing discussion of scheduled maintenance", () => {
    const body = [
      "<html><body><h2>Operational Reliability</h2>",
      "<p>The registrant performs scheduled maintenance on manufacturing equipment and cloud systems. ",
      "Management staggers this work across facilities, maintains backup capacity, and monitors customer service levels to reduce disruption.</p>",
      "</body></html>",
    ].join("");

    expect(filingDocumentBodyProblem(body)).toBeNull();
  });

  it("rejects an implausible index body before caching and falls back to the valid HTML index", async () => {
    let headerHits = 0;
    let fallbackHits = 0;
    const fetchFn: typeof fetch = (input) => {
      const url = String(input);
      if (url.endsWith("-index-headers.html")) {
        headerHits++;
        return Promise.resolve(
          new Response("<html><title>Page Not Found</title><body>File not found</body></html>", {
            status: 200,
          }),
        );
      }
      fallbackHits++;
      return Promise.resolve(
        new Response(
          '<html><head><title>SEC.gov | EDGAR Filing Documents for Example Issuer</title></head>' +
            '<div class="site-notice">Forms Unavailable During Maintenance in another SEC.gov service.</div>' +
            '<table><tr><th>Seq</th><th>Description</th><th>Document</th><th>Type</th><th>Size</th></tr>' +
            '<tr><td>1</td><td>Annual report</td><td><a href="annual.htm">annual.htm</a></td><td>10-K</td><td>100</td></tr></table></html>',
          { status: 200 },
        ),
      );
    };
    const client = new EdgarClient({
      transport: createDefaultEdgarTransport({ fetchFn, maxRps: 1000 }),
    });

    const first = await client.filingIndexHeaders(320193, "0000320193-26-000001");
    const second = await client.filingIndexHeaders(320193, "0000320193-26-000001");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok) expect(first.value.data.typeByFilename["annual.htm"]).toBe("10-K");
    expect(headerHits).toBe(2);
    expect(fallbackHits).toBe(1);
  });

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
