/**
 * The successor-registrant second hop, driven end to end through
 * `buildDataBundle` against RECORDED SEC payloads (WS4, D-14).
 *
 * The unit that broke was not the parsing — it was the choice of which filing
 * to read. `resolvePredecessor` read the 8-K12B's submission header and stopped,
 * on the stated premise that the 8-K12B co-registers the predecessor. SEC's
 * actual response for the case the feature was built for names one filer,
 * itself, so the feature resolved nothing for ExxonMobil and no test noticed:
 * the only fixture was hand-built in the shape the code expected.
 *
 * These tests drive the loop with the real headers. `fixtures/edgar/xom_*` were
 * recorded on 2026-09-03 with the owner's authorisation; no test here makes a
 * network request.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildDataBundle } from "@/pipeline/dataBundle";
import { createEdgarClient, type EdgarTransport, type EdgarTransportResponse } from "@/providers/edgar";
import { createFmpClient } from "@/providers/fmp";
import { createYahooClient, type YahooClient } from "@/providers/yahoo";
import { makeLimiter } from "@/providers/http";
import type { CompanyFacts } from "@/edgar/xbrl";
import type { FinraConfig } from "@/providers/finra";
import type { FinnhubConfig } from "@/providers/finnhub";
import type { FredConfig } from "@/providers/fred";

const NOW = new Date("2026-09-03T00:00:00.000Z");
const SAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "edgar");
const sample = (name: string): string => readFileSync(path.join(SAMPLES, name), "utf8");

const SUCCESSOR_CIK = 2115436;
const PREDECESSOR_CIK = 34088;
const EIGHT_K_12B = "0001193125-26-291990";
const TEN_Q = "0000034088-26-000093";

/** A companyfacts payload with `count` us-gaap concepts. */
function factsWith(cik: number, entityName: string, count: number): CompanyFacts {
  const concepts: Record<string, { label: string; units: Record<string, unknown[]> }> = {};
  for (let i = 0; i < count; i++) {
    concepts[`Concept${i}`] = {
      label: `Concept${i}`,
      units: {
        USD: [
          {
            start: "2024-01-01",
            end: "2024-12-31",
            val: 1_000 + i,
            accn: "0000034088-25-000010",
            fy: 2024,
            fp: "FY",
            form: "10-K",
            filed: "2025-02-01",
          },
        ],
      },
    };
  }
  return { cik, entityName, facts: { "us-gaap": concepts } };
}

interface TransportLog {
  urls: string[];
}

/**
 * Serves the recorded XOM payloads. `predecessorFacts` decides what
 * companyfacts CIK0000034088 returns, so a test can make the co-registrant
 * useless and watch the scan carry on.
 */
function xomTransport(log: TransportLog, opts?: { predecessorFacts?: CompanyFacts | null }): EdgarTransport {
  const body = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));
  const respond = (value: unknown): Promise<EdgarTransportResponse> =>
    Promise.resolve({ status: 200, body: body(value), fetchedAt: NOW.toISOString(), fromCache: false, stale: false });
  const missing = (): Promise<EdgarTransportResponse> =>
    Promise.resolve({ status: 404, body: "not found", fetchedAt: NOW.toISOString(), fromCache: false, stale: false });
  const predecessorFacts =
    opts?.predecessorFacts === undefined ? factsWith(PREDECESSOR_CIK, "EXXON MOBIL CORP", 40) : opts.predecessorFacts;

  return {
    fetchText(url: string): Promise<EdgarTransportResponse> {
      log.urls.push(url);
      if (url.includes("company_tickers.json")) {
        return respond({ "0": { cik_str: SUCCESSOR_CIK, ticker: "XOM", title: "ExxonMobil Holdings Corp" } });
      }
      if (url.includes("submissions/CIK0002115436.json")) return respond(sample("xom_successor_submissions.json"));
      // The successor's own payload starts at the reorganization: no us-gaap.
      if (url.includes("companyfacts/CIK0002115436.json")) {
        return respond({ cik: SUCCESSOR_CIK, entityName: "ExxonMobil Holdings Corp", facts: {} });
      }
      if (url.includes("companyfacts/CIK0000034088.json")) {
        return predecessorFacts === null ? missing() : respond(predecessorFacts);
      }
      if (url.includes(EIGHT_K_12B.replace(/-/g, "")) && url.includes("index-headers")) {
        return respond(sample("xom_successor_8k12b_index_headers.html"));
      }
      if (url.includes(TEN_Q.replace(/-/g, "")) && url.includes("index-headers")) {
        return respond(sample("xom_successor_10q_index_headers.html"));
      }
      if (url.includes("000119312526292453") && url.includes("index-headers")) {
        return respond(sample("xom_successor_posasr_index_headers.html"));
      }
      return missing();
    },
  };
}

function fakeYahoo(): YahooClient {
  const empty = {
    ok: true as const,
    value: {
      data: { rows: [], raw: null },
      asOf: "2026-09-03",
      source: "yahoo",
      endpoint: "/v8/finance/chart/XOM",
      fetchedAt: NOW.toISOString(),
    },
  };
  const client = createYahooClient({ limiter: makeLimiter(1, 1) }) as unknown as Record<string, unknown>;
  return {
    ...client,
    dailyHistory: () => Promise.resolve(empty),
    meta: () => Promise.resolve(empty),
    quote: () => Promise.resolve(empty),
  } as unknown as YahooClient;
}

function noNetworkConfigs(): { fred: FredConfig; finnhub: FinnhubConfig; finra: FinraConfig } {
  const unavailable = (): Promise<Response> => Promise.resolve(new Response("not available", { status: 404 }));
  return {
    fred: { fetchImpl: unavailable, retryDelaysMs: [], minRequestIntervalMs: 0 },
    finnhub: { apiKey: "TEST-KEY", fetchImpl: unavailable, retryDelaysMs: [] },
    finra: { fetchImpl: unavailable, retryDelaysMs: [] },
  };
}

async function xomBundle(opts?: { predecessorFacts?: CompanyFacts | null }): Promise<{
  predecessor: { cik10: string; name: string | null; via: { accession: string; form: string } } | null;
  headerReads: string[];
}> {
  const log: TransportLog = { urls: [] };
  const bundle = await buildDataBundle("XOM", {
    now: () => NOW,
    fmp: createFmpClient({ apiKey: "", fixturesDir: "fixtures/fmp" }),
    edgar: createEdgarClient({ transport: xomTransport(log, opts) }),
    yahoo: fakeYahoo(),
    ...noNetworkConfigs(),
  });
  const predecessor = bundle.edgar.predecessor;
  return {
    predecessor:
      predecessor === null
        ? null
        : { cik10: predecessor.cik10, name: predecessor.name, via: { accession: predecessor.via.accession, form: predecessor.via.form } },
    headerReads: log.urls.filter((url) => url.includes("index-headers")),
  };
}

describe("resolving a successor's predecessor from recorded SEC payloads", () => {
  it("reads past the 8-K12B, which names only the successor, to the co-registered 10-Q", async () => {
    const { predecessor, headerReads } = await xomBundle();
    expect(predecessor).toEqual({
      cik10: "0000034088",
      name: "EXXON MOBIL CORP",
      // NOT the 8-K12B. That filing triggered the search and answered nothing.
      via: { accession: TEN_Q, form: "10-Q" },
    });
    // Exactly two headers were read, in rank order, and the search stopped at
    // the first that co-registered.
    expect(headerReads).toHaveLength(2);
    expect(headerReads[0]).toContain(EIGHT_K_12B);
    expect(headerReads[1]).toContain(TEN_Q);
  });

  it("does not adopt a co-registrant whose own payload carries no history", async () => {
    // A co-registrant can be a financing subsidiary with nothing to contribute.
    // Taking it would replace a disclosed gap with an empty answer.
    const { predecessor, headerReads } = await xomBundle({ predecessorFacts: factsWith(PREDECESSOR_CIK, "EXXON MOBIL CORP", 0) });
    expect(predecessor).toBeNull();
    // And the scan carried on rather than stopping at the first co-registrant:
    // the POSASR was read too, and it names the same party.
    expect(headerReads.length).toBeGreaterThan(2);
  });

  it("degrades to a disclosed gap when the predecessor's facts cannot be fetched", async () => {
    const { predecessor } = await xomBundle({ predecessorFacts: null });
    expect(predecessor).toBeNull();
  });
});
