import { describe, expect, it } from "vitest";
import type { Sourced } from "@/types/core";
import {
  createEdgarClient,
  type EdgarFiling,
  type EdgarSubmissions,
  type EdgarTransport,
  type EdgarTransportResponse,
} from "@/providers/edgar";
import { createFmpClient } from "@/providers/fmp";
import { buildDataBundle, selectAnnualFiling, selectInterimFiling } from "@/pipeline/dataBundle";

function filing(form: string): EdgarFiling {
  return {
    accessionNumber: "0001234567-26-000001",
    form,
    filingDate: "2026-03-01",
    reportDate: "2025-12-31",
    primaryDocument: "annual.htm",
  };
}

function submissions(forms: string[]): Sourced<EdgarSubmissions> {
  return {
    data: {
      cik: "0001234567",
      name: "Foreign Issuer",
      sic: null,
      sicDescription: null,
      fiscalYearEnd: "1231",
      stateOfIncorporation: null,
      tickers: ["TSM"],
      exchanges: ["NYSE"],
      recentFilings: forms.map(filing),
      olderPages: [],
    },
    asOf: "2026-03-01",
    source: "edgar",
    endpoint: "submissions/CIK0001234567.json",
    fetchedAt: "2026-03-01T00:00:00.000Z",
  };
}

describe("selectAnnualFiling", () => {
  it("uses Form 20-F as the annual primary filing for an ADR without a 10-K", () => {
    const result = selectAnnualFiling(submissions(["20-F", "6-K"]), "TSM");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.data.form).toBe("20-F");
  });

  it("uses the SEC-reported 20-F even when the profile ADR flag is absent", () => {
    const result = selectAnnualFiling(submissions(["20-F"]), "FOREIGN");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.data.form).toBe("20-F");
  });

  it("prefers a 10-K when an ADR files both annual forms", () => {
    const result = selectAnnualFiling(submissions(["20-F", "10-K"]), "DUAL");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.data.form).toBe("10-K");
  });
});

describe("selectInterimFiling", () => {
  it("uses Form 6-K as provenance when a foreign issuer has no 10-Q", () => {
    const result = selectInterimFiling(submissions(["6-K"]), "TSM");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.data.form).toBe("6-K");
  });

  it("prefers a standardized 10-Q over Form 6-K", () => {
    const result = selectInterimFiling(submissions(["6-K", "10-Q"]), "DUAL");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.data.form).toBe("10-Q");
  });
});

describe("buildDataBundle EDGAR filing boundary", () => {
  it("contains a malformed selected filing as typed critical gaps without requesting its URL", async () => {
    const calls: string[] = [];
    const response = (body: string): EdgarTransportResponse => ({
      status: 200,
      body,
      fetchedAt: "2026-07-06T00:00:00.000Z",
      fromCache: false,
      stale: false,
    });
    const submissionsBody = JSON.stringify({
      cik: "0000000000",
      name: "Thesis Example Systems",
      sic: "7372",
      sicDescription: "Prepackaged Software",
      fiscalYearEnd: "1231",
      stateOfIncorporation: "CA",
      tickers: ["DEMO"],
      exchanges: ["TEST"],
      filings: {
        files: [],
        recent: {
          accessionNumber: ["0000000000-26-000001"],
          filingDate: ["2026-03-01"],
          reportDate: ["2025-12-31"],
          form: ["10-K"],
          primaryDocument: ["../escape.htm"],
        },
      },
    });
    const transport: EdgarTransport = {
      fetchText(url): Promise<EdgarTransportResponse> {
        calls.push(url);
        if (url.includes("company_tickers.json")) {
          return Promise.resolve(response(JSON.stringify({ "0": { cik_str: 0, ticker: "DEMO", title: "Thesis Example Systems" } })));
        }
        if (url.includes("submissions/CIK0000000000.json")) return Promise.resolve(response(submissionsBody));
        if (url.includes("companyfacts/CIK0000000000.json")) {
          return Promise.resolve(response(JSON.stringify({ cik: 0, entityName: "Thesis Example Systems", facts: {} })));
        }
        throw new Error(`unexpected EDGAR transport call: ${url}`);
      },
    };
    const noNetworkResponse = (): Promise<Response> =>
      Promise.resolve(new Response("not available in test", { status: 404 }));

    const bundle = await buildDataBundle("DEMO", {
      now: () => new Date("2026-07-06T00:00:00.000Z"),
      eodYears: 1,
      fmp: createFmpClient({ apiKey: "" }),
      edgar: createEdgarClient({ transport }),
      keyless: false,
      fred: { fetchImpl: noNetworkResponse, retryDelaysMs: [], minRequestIntervalMs: 0 },
      finnhub: { fetchImpl: noNetworkResponse, retryDelaysMs: [] },
      finra: { fetchImpl: noNetworkResponse, retryDelaysMs: [], minRequestIntervalMs: 0 },
    });

    expect(bundle.edgar.latestTenK.ok).toBe(true);
    expect(bundle.edgar.item1a.ok).toBe(false);
    expect(bundle.edgar.mdna.ok).toBe(false);
    if (!bundle.edgar.item1a.ok) {
      expect(bundle.edgar.item1a.gap.severity).toBe("critical");
      expect(bundle.edgar.item1a.gap.reason).toMatch(/unsafe primary document/i);
    }
    if (!bundle.edgar.mdna.ok) {
      expect(bundle.edgar.mdna.gap.severity).toBe("critical");
      expect(bundle.edgar.mdna.gap.reason).toMatch(/unsafe primary document/i);
    }
    expect(calls.some((url) => url.includes("Archives/edgar/data"))).toBe(false);
  });
});

describe("selectAnnualFiling — no annual form on file", () => {
  it("names both annual forms and the successor-issuer notice", () => {
    // ExxonMobil Holdings Corp (CIK 2115436) took over the XOM ticker in July
    // 2026 with an 8-K12B, a 10-Q and S-8s; the old wording reported only the
    // 20-F miss and made a Texas registrant look like a foreign filer.
    const result = selectAnnualFiling(submissions(["8-K12B", "10-Q", "8-K"]), "XOM");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gap.severity).toBe("critical");
      expect(result.gap.reason).toMatch(/^no "10-K" or "20-F" among 3 recent filings/);
      expect(result.gap.reason).toMatch(/successor issuer \(Form 8-K12B filed 2026-03-01\)/);
    }
  });

  it("reports a plain absence when there is no successor notice", () => {
    const result = selectAnnualFiling(submissions(["10-Q"]), "NEW");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gap.reason).toMatch(/^no "10-K" or "20-F" among 1 recent filings/);
      expect(result.gap.reason).not.toMatch(/successor/);
    }
  });
});
