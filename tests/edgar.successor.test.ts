/**
 * Successor registrants (D-14).
 *
 * A holding-company reorganization creates a NEW SEC registrant that takes the
 * listed ticker and files a Form 8-K12B. Its own companyfacts payload starts at
 * the reorganization, so every long-window growth rate and multi-year average
 * in a report measured a few months of history — or produced nothing — with no
 * explanation. The predecessor's CIK appears in exactly one machine-readable
 * place: the FILER blocks of that 8-K12B's submission header.
 *
 * The `xom_successor_*` fixtures ARE recorded SEC responses, fetched once on
 * 2026-09-03 with the owner's authorisation: the submissions payload for CIK
 * 2115436 and the submission headers of its 8-K12B (0001193125-26-291990), its
 * 10-Q (0000034088-26-000093) and its POSASR (0001193125-26-292453). They
 * disproved this module's original premise — the 8-K12B names ONE filer, itself
 * — which is why the predecessor is now resolved by scanning a ranked list.
 * `successor_8k12b_index_headers.html` remains hand-built
 * (`synthetic-structure`), covering the branch where an 8-K12B does
 * co-register. No test in this file makes a network request.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SUCCESSOR_FORM,
  hasCoRegistrantFileNumber,
  predecessorCandidates,
  predecessorFromFilers,
  predecessorManifestEntry,
  predecessorUnresolvedEntry,
  usGaapConceptCount,
  type PredecessorFacts,
} from "@/edgar/successor";
import {
  EdgarClient,
  parseFilers,
  parseIndexHeaders,
  type EdgarSubmissions,
  type EdgarTransport,
  type EdgarTransportResponse,
} from "@/providers/edgar";
import { applyKeylessFallbacks, type KeylessInputs, type KeylessMembers } from "@/pipeline/keyless";
import { createYahooClient } from "@/providers/yahoo";
import { makeLimiter } from "@/providers/http";
import type { CompanyFacts } from "@/edgar/xbrl";
import type { FetchResult } from "@/types/core";
import type { FmpPayload, FmpRawRow } from "@/providers/fmp";

const SAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "edgar");
const sample = (name: string): string => readFileSync(path.join(SAMPLES, name), "utf8");
const SUCCESSOR_INDEX = "successor_8k12b_index_headers.html";
/** Recorded 2026-09-03 from data.sec.gov and www.sec.gov. See the file docstring. */
const REAL_8K12B = "xom_successor_8k12b_index_headers.html";
const REAL_10Q = "xom_successor_10q_index_headers.html";
const REAL_POSASR = "xom_successor_posasr_index_headers.html";
const REAL_SUBMISSIONS = "xom_successor_submissions.json";

const SUCCESSOR_CIK = "0002115436";
const PREDECESSOR_CIK = "0000034088";
const NOW = new Date("2026-09-01T00:00:00Z");

describe("parseFilers / parseIndexHeaders", () => {
  it("reads both FILER blocks of a successor's 8-K12B, successor first", () => {
    const index = parseIndexHeaders(sample(SUCCESSOR_INDEX));
    expect(index.filers).toEqual([
      { cik10: SUCCESSOR_CIK, name: "EXAMPLE SUCCESSOR HOLDINGS CORP" },
      { cik10: PREDECESSOR_CIK, name: "EXAMPLE PREDECESSOR CORP" },
    ]);
    // The ordinary document map is unaffected by the second FILER block.
    expect(index.typeByFilename["successor-8k12b.htm"]).toBe("8-K12B");
    expect(index.filedAsOf).toBe("2026-07-01");
  });

  it("reads a single filer from an ordinary 10-K header", () => {
    const index = parseIndexHeaders(sample("wfc_index_headers_excerpt.html"));
    expect(index.filers).toEqual([{ cik10: "0000072971", name: "WELLS FARGO & COMPANY/MN" }]);
  });

  it("zero-pads short CIKs and lists each registrant once", () => {
    const header = [
      "COMPANY CONFORMED NAME:\tALPHA CORP",
      "CENTRAL INDEX KEY:\t\t320193",
      "COMPANY CONFORMED NAME:\tALPHA CORP",
      "CENTRAL INDEX KEY:\t\t0000320193",
      "COMPANY CONFORMED NAME:\tBETA CORP",
      "CENTRAL INDEX KEY:\t\t34088",
    ].join("\n");
    expect(parseFilers(header)).toEqual([
      { cik10: "0000320193", name: "ALPHA CORP" },
      { cik10: "0000034088", name: "BETA CORP" },
    ]);
  });

  it("returns no filers for a header that carries none", () => {
    expect(parseFilers("ACCESSION NUMBER: 0000000000-26-000001\nFORM TYPE: 10-K")).toEqual([]);
  });

  it("reads only the FILER blocks, never a SUBJECT COMPANY or a REPORTING-OWNER", () => {
    // On a Schedule 13D or a Form 4 the header carries other parties with a
    // name/CIK pair of their own. Scanning the whole header would return one of
    // them as a co-registrant, and `predecessorFromFilers` reads "exactly one
    // party besides the successor" as the predecessor's identity.
    const header = [
      "ACCESSION NUMBER:\t0000000000-26-000001",
      "CONFORMED SUBMISSION TYPE:\tSC 13D",
      "",
      "SUBJECT COMPANY:",
      "\tCOMPANY DATA:",
      "\t\tCOMPANY CONFORMED NAME:\t\tTARGET CORP",
      "\t\tCENTRAL INDEX KEY:\t\t0000027419",
      "",
      "FILED BY:",
      "\tCOMPANY DATA:",
      "\t\tCOMPANY CONFORMED NAME:\t\tACTIVIST FUND LP",
      "\t\tCENTRAL INDEX KEY:\t\t0001234567",
      "",
      "FILER:",
      "\tCOMPANY DATA:",
      "\t\tCOMPANY CONFORMED NAME:\t\tREGISTRANT CORP",
      "\t\tCENTRAL INDEX KEY:\t\t0000320193",
    ].join("\n");
    expect(parseFilers(header)).toEqual([{ cik10: "0000320193", name: "REGISTRANT CORP" }]);
  });
});

describe("predecessorFromFilers", () => {
  const successor = { cik10: SUCCESSOR_CIK, name: "EXAMPLE SUCCESSOR HOLDINGS CORP" };
  const predecessor = { cik10: PREDECESSOR_CIK, name: "EXAMPLE PREDECESSOR CORP" };

  it("picks the single co-registrant that is not the successor", () => {
    expect(predecessorFromFilers([successor, predecessor], SUCCESSOR_CIK)).toEqual({
      cik10: PREDECESSOR_CIK,
      name: "EXAMPLE PREDECESSOR CORP",
    });
    // Filed order does not matter.
    expect(predecessorFromFilers([predecessor, successor], SUCCESSOR_CIK)?.cik10).toBe(PREDECESSOR_CIK);
  });

  it("resolves nothing when the successor filed alone", () => {
    expect(predecessorFromFilers([successor], SUCCESSOR_CIK)).toBeNull();
    expect(predecessorFromFilers([], SUCCESSOR_CIK)).toBeNull();
    expect(predecessorFromFilers(undefined, SUCCESSOR_CIK)).toBeNull();
  });

  it("refuses to choose between two co-registrants rather than guessing", () => {
    const other = { cik10: "0000000123", name: "THIRD PARTY CORP" };
    expect(predecessorFromFilers([successor, predecessor, other], SUCCESSOR_CIK)).toBeNull();
  });

  it("counts the us-gaap concepts that decide whether a second hop is needed", () => {
    expect(usGaapConceptCount(null)).toBe(0);
    expect(usGaapConceptCount({ cik: 1, entityName: "X", facts: {} })).toBe(0);
    expect(usGaapConceptCount({ cik: 1, entityName: "X", facts: { "us-gaap": { Assets: {} } } })).toBe(1);
  });
});

describe("the client surfaces the filers through filingIndexHeaders", () => {
  it("carries both CIKs from the fetched header, without a second request", async () => {
    let calls = 0;
    const transport: EdgarTransport = {
      fetchText(): Promise<EdgarTransportResponse> {
        calls++;
        return Promise.resolve({
          status: 200,
          body: sample(SUCCESSOR_INDEX),
          fetchedAt: NOW.toISOString(),
          fromCache: false,
          stale: false,
        });
      },
    };
    const client = new EdgarClient({ transport });
    const index = await client.filingIndexHeaders(SUCCESSOR_CIK, "0002115436-26-000001");
    expect(index.ok).toBe(true);
    if (!index.ok) return;
    expect(calls).toBe(1);
    expect(predecessorFromFilers(index.value.data.filers, SUCCESSOR_CIK)?.cik10).toBe(PREDECESSOR_CIK);
  });
});

describe("the RECORDED ExxonMobil succession", () => {
  const filersOf = (fixture: string): { cik10: string; name: string | null }[] =>
    parseIndexHeaders(sample(fixture)).filers ?? [];

  it("shows the 8-K12B naming ONE filer — the successor alone", () => {
    // The premise this feature was built on. SEC serves a single FILER block
    // for the filing whose entire purpose is the succession, so reading it and
    // stopping resolves nothing for the issuer the feature exists to serve.
    expect(filersOf(REAL_8K12B)).toEqual([{ cik10: SUCCESSOR_CIK, name: "ExxonMobil Holdings Corp" }]);
    expect(predecessorFromFilers(filersOf(REAL_8K12B), SUCCESSOR_CIK)).toBeNull();
  });

  it("finds the co-registration on the jointly filed 10-Q and POSASR", () => {
    for (const fixture of [REAL_10Q, REAL_POSASR]) {
      expect(filersOf(fixture)).toEqual([
        { cik10: PREDECESSOR_CIK, name: "EXXON MOBIL CORP" },
        { cik10: SUCCESSOR_CIK, name: "ExxonMobil Holdings Corp" },
      ]);
      expect(predecessorFromFilers(filersOf(fixture), SUCCESSOR_CIK)).toEqual({
        cik10: PREDECESSOR_CIK,
        name: "EXXON MOBIL CORP",
      });
    }
  });

  it("reads the file number that marks a co-registered filing", () => {
    expect(hasCoRegistrantFileNumber("333-293558-01")).toBe(true);
    expect(hasCoRegistrantFileNumber("033-51107-01")).toBe(true);
    expect(hasCoRegistrantFileNumber("001-43384")).toBe(false);
    expect(hasCoRegistrantFileNumber(undefined)).toBe(false);
  });

  describe("candidate ranking against the real filing list", () => {
    const submissions = async (): Promise<EdgarSubmissions> => {
      const transport: EdgarTransport = {
        fetchText(): Promise<EdgarTransportResponse> {
          return Promise.resolve({
            status: 200,
            body: sample(REAL_SUBMISSIONS),
            fetchedAt: NOW.toISOString(),
            fromCache: false,
            stale: false,
          });
        },
      };
      const result = await new EdgarClient({ transport }).submissions(2115436);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("submissions fixture did not parse");
      return result.value.data;
    };

    it("carries each filing's SEC file number through the parse", async () => {
      const sub = await submissions();
      expect(sub.recentFilings).toHaveLength(29);
      const posasr = sub.recentFilings.find((f) => f.form === "POSASR");
      expect(posasr?.fileNumber).toBe("333-293558-01");
      expect(sub.recentFilings.find((f) => f.form === "8-K12B")?.fileNumber).toBe("001-43384");
    });

    it("puts the 8-K12B first and the co-registering 10-Q second", async () => {
      const sub = await submissions();
      const ranked = predecessorCandidates(sub.recentFilings, 4);
      expect(ranked.map((f) => [f.form, f.accessionNumber])).toEqual([
        // The trigger: cheap to try, and it answers for issuers that do
        // co-register on it. This one does not.
        ["8-K12B", "0001193125-26-291990"],
        // The answer, at the second request.
        ["10-Q", "0000034088-26-000093"],
        // Then the broad shelf amendment, which also co-registers, before the
        // employee-plan amendments, which do not.
        ["POSASR", "0001193125-26-292453"],
        // Twenty-three S-8 POS amendments share a filing date; the accession
        // breaks the tie so the order is stable across runs.
        ["S-8 POS", "0001193125-26-292689"],
      ]);
    });

    it("never offers a filing that has neither a periodic form nor a co-registrant file number", async () => {
      const sub = await submissions();
      const ranked = predecessorCandidates(sub.recentFilings, 99);
      const plain8Ks = sub.recentFilings.filter((f) => f.form === "8-K");
      expect(plain8Ks.length).toBeGreaterThan(0);
      for (const filing of plain8Ks) {
        expect(ranked.map((f) => f.accessionNumber)).not.toContain(filing.accessionNumber);
      }
      // Every S-8 POS is offered, but only after the two that co-register.
      expect(ranked.slice(0, 3).map((f) => f.form)).toEqual(["8-K12B", "10-Q", "POSASR"]);
    });

    it("returns nothing when asked for nothing", async () => {
      const sub = await submissions();
      expect(predecessorCandidates(sub.recentFilings, 0)).toEqual([]);
      expect(predecessorCandidates([], 4)).toEqual([]);
    });
  });
});

describe("the disclosure wording", () => {
  const predecessor: PredecessorFacts = {
    cik10: PREDECESSOR_CIK,
    name: "EXAMPLE PREDECESSOR CORP",
    facts: { cik: 34088, entityName: "EXAMPLE PREDECESSOR CORP", facts: {} },
    endpoint: "companyfacts/CIK0000034088.json",
    via: {
      accession: "0000034088-26-000093",
      form: "10-Q",
      filed: "2026-08-03",
      successorFormAccession: "0002115436-26-000001",
    },
    fetchedAt: NOW.toISOString(),
  };

  it("names both entities, the linking filing, and what the join cannot show", () => {
    const entry = predecessorManifestEntry(predecessor, SUCCESSOR_CIK, 12, "2016-12-31", "2025-12-31");
    expect(entry.field).toBe("edgar.predecessor");
    expect(entry.severity).toBe("info");
    expect(entry.expected).toBe(true);
    expect(entry.reason).toContain(SUCCESSOR_CIK);
    expect(entry.reason).toContain(PREDECESSOR_CIK);
    expect(entry.reason).toContain(SUCCESSOR_FORM);
    // Both accessions appear, and they are DIFFERENT filings: the 8-K12B made
    // the registrant a successor, the 10-Q is what named the predecessor.
    expect(entry.reason).toContain("0002115436-26-000001");
    expect(entry.reason).toContain("0000034088-26-000093");
    expect(entry.reason).toMatch(/its 10-Q 0000034088-26-000093, filed 2026-08-03 co-registers/);
    expect(entry.reason).toMatch(/12 older period\(s\), 2016-12-31 to 2025-12-31/);
    expect(entry.reason).toMatch(/different legal entity/);
  });

  it("warns, rather than staying silent, when the predecessor could not be resolved", () => {
    const entry = predecessorUnresolvedEntry(SUCCESSOR_CIK, "0002115436-26-000001", "the header named one filer");
    expect(entry.severity).toBe("warn");
    expect(entry.reason).toMatch(/only the successor's own filing history/);
  });
});

// ---------------------------------------------------------------------------
// The keyless layer: predecessor periods appended, tagged and disclosed.
// ---------------------------------------------------------------------------

const gap = <T extends FmpRawRow>(field: string): FetchResult<FmpPayload<T>> => ({
  ok: false,
  gap: { field, reason: "no API key + no fixture", severity: "warn" },
});

function allGaps(): KeylessMembers {
  return {
    profile: gap("fmp.profile(XMPL)"),
    quote: gap("fmp.quote(XMPL)"),
    incomeAnnual: gap("fmp.incomeStatement(XMPL,annual)"),
    incomeQuarterly: gap("fmp.incomeStatement(XMPL,quarter)"),
    balanceAnnual: gap("fmp.balanceSheet(XMPL,annual)"),
    balanceQuarterly: gap("fmp.balanceSheet(XMPL,quarter)"),
    cashflowAnnual: gap("fmp.cashFlow(XMPL,annual)"),
    cashflowQuarterly: gap("fmp.cashFlow(XMPL,quarter)"),
    eodPrices: gap("fmp.historicalPriceEodFull(XMPL)"),
    spy: gap("fmp.historicalPriceEodFull(SPY)"),
    sectorEtf: gap("fmp.historicalPriceEodFull(XLE)"),
    enterpriseValues: gap("fmp.enterpriseValues(XMPL,quarter)"),
    marketCapHistory: gap("fmp.historicalMarketCap(XMPL)"),
    sharesFloat: gap("fmp.sharesFloat(XMPL)"),
  };
}

/** Annual us-gaap facts for the fiscal years `years`, filed the following February. */
function annualFacts(cik: number, name: string, years: number[]): CompanyFacts {
  const point = (year: number, val: number) => ({
    start: `${year}-01-01`,
    end: `${year}-12-31`,
    val,
    accn: `${String(cik).padStart(10, "0")}-${String(year + 1).slice(2)}-000001`,
    fy: year,
    fp: "FY",
    form: "10-K",
    filed: `${year + 1}-02-15`,
  });
  const instant = (year: number, val: number) => ({
    end: `${year}-12-31`,
    val,
    accn: `${String(cik).padStart(10, "0")}-${String(year + 1).slice(2)}-000001`,
    fy: year,
    fp: "FY",
    form: "10-K",
    filed: `${year + 1}-02-15`,
  });
  const usd = (points: unknown[]) => ({ label: "x", units: { USD: points } });
  return {
    cik,
    entityName: name,
    facts: {
      "us-gaap": {
        Revenues: usd(years.map((y, i) => point(y, 1000 + i * 100))),
        NetIncomeLoss: usd(years.map((y, i) => point(y, 100 + i * 10))),
        Assets: usd(years.map((y, i) => instant(y, 5000 + i * 100))),
        StockholdersEquity: usd(years.map((y, i) => instant(y, 2000 + i * 50))),
        Liabilities: usd(years.map((y, i) => instant(y, 3000 + i * 50))),
        NetCashProvidedByUsedInOperatingActivities: usd(years.map((y, i) => point(y, 200 + i * 10))),
      },
    },
  };
}

function inputs(over: Partial<KeylessInputs> = {}): KeylessInputs {
  const yahoo = createYahooClient({
    fetchImpl: (() => Promise.resolve(new Response("no", { status: 599 }))) as unknown as typeof fetch,
    limiter: makeLimiter(1000, 1000),
    now: () => NOW,
    maxRetries: 0,
  });
  const successorFacts = annualFacts(2115436, "EXAMPLE SUCCESSOR HOLDINGS CORP", [2026]);
  return {
    symbol: "XMPL",
    today: "2026-09-01",
    eodFrom: "2021-09-01",
    sectorEtfSymbol: null,
    fmp: allGaps(),
    fmpKeyless: true,
    statementSource: "auto",
    edgarConfirmedIssuer: true,
    edgar: {
      cik: {
        ok: true,
        value: {
          data: { cik10: SUCCESSOR_CIK, cik: 2115436, ticker: "XMPL", title: "Example Successor Holdings Corp" },
          asOf: "2026-09-01",
          source: "edgar",
          endpoint: "company_tickers.json",
          fetchedAt: NOW.toISOString(),
        },
      },
      registrant: {
        name: "EXAMPLE SUCCESSOR HOLDINGS CORP",
        cik10: SUCCESSOR_CIK,
        sic: "2911",
        sicDescription: "PETROLEUM REFINING",
        exchanges: ["NYSE"],
        tickers: ["XMPL"],
        fiscalYearEnd: "1231",
        stateOfIncorporation: "NJ",
        forms: ["8-K12B", "10-Q"],
      },
      companyFacts: {
        ok: true,
        value: {
          data: successorFacts,
          asOf: "2026-12-31",
          source: "edgar",
          endpoint: "companyfacts",
          fetchedAt: NOW.toISOString(),
        },
      },
      predecessor: {
        cik10: PREDECESSOR_CIK,
        name: "EXAMPLE PREDECESSOR CORP",
        facts: annualFacts(34088, "EXAMPLE PREDECESSOR CORP", [2021, 2022, 2023, 2024, 2025]),
        endpoint: "companyfacts/CIK0000034088.json",
        via: {
          accession: "0002115436-26-000001",
          form: SUCCESSOR_FORM,
          filed: "2026-07-01",
          successorFormAccession: "0002115436-26-000001",
        },
        fetchedAt: NOW.toISOString(),
      },
    },
    yahoo,
    annualPeriods: 10,
    quarterlyPeriods: 24,
    now: () => NOW,
    resolveSectorEtf: () => null,
    ...over,
  };
}

describe("applyKeylessFallbacks — a successor registrant's pre-reorganization history", () => {
  it("appends the predecessor's older years, tags every row, and leaves the successor's own untouched", async () => {
    const out = await applyKeylessFallbacks(inputs());
    const rows = out.members.incomeAnnual.ok ? out.members.incomeAnnual.value.data.rows : [];
    const dates = rows.map((row) => row["date"]).sort();
    expect(dates).toEqual(["2021-12-31", "2022-12-31", "2023-12-31", "2024-12-31", "2025-12-31", "2026-12-31"]);

    const own = rows.find((row) => row["date"] === "2026-12-31")!;
    expect(own["predecessor"]).toBeUndefined();
    const inherited = rows.filter((row) => row["date"]! < "2026-01-01");
    expect(inherited).toHaveLength(5);
    for (const row of inherited) {
      expect(row["predecessor"]).toBe(true);
      expect(row["predecessorCik"]).toBe(PREDECESSOR_CIK);
      expect(row["source"]).toBe("edgar");
    }
    expect(out.members.incomeAnnual.ok && out.members.incomeAnnual.value.endpoint).toContain(
      `[predecessor CIK ${PREDECESSOR_CIK}]`,
    );
    expect(out.notes.some((n) => n.startsWith("incomeAnnual: 5 pre-reorganization period(s)"))).toBe(true);
  });

  it("files one manifest entry naming both CIKs and the span it supplied", async () => {
    const out = await applyKeylessFallbacks(inputs());
    const entries = out.gaps.filter((g) => g.field === "edgar.predecessor");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.severity).toBe("info");
    expect(entries[0]!.reason).toContain(PREDECESSOR_CIK);
    expect(entries[0]!.reason).toMatch(/2021-12-31 to 2025-12-31/);
  });

  it("never duplicates a period both entities reported", async () => {
    // The predecessor also filed FY2026 — the year of the reorganization.
    const overlapping = inputs();
    const predecessor = overlapping.edgar.predecessor!;
    const out = await applyKeylessFallbacks(
      inputs({
        edgar: {
          ...overlapping.edgar,
          predecessor: {
            ...predecessor,
            facts: annualFacts(34088, "EXAMPLE PREDECESSOR CORP", [2024, 2025, 2026]),
          },
        },
      }),
    );
    const rows = out.members.incomeAnnual.ok ? out.members.incomeAnnual.value.data.rows : [];
    const dates = rows.map((row) => row["date"]);
    expect(dates.filter((d) => d === "2026-12-31")).toHaveLength(1);
    expect(rows.find((row) => row["date"] === "2026-12-31")!["predecessor"]).toBeUndefined();
    expect(dates.sort()).toEqual(["2024-12-31", "2025-12-31", "2026-12-31"]);
  });

  it("adds no rows when no predecessor was resolved", async () => {
    const base = inputs();
    const out = await applyKeylessFallbacks(
      inputs({ edgar: { ...base.edgar, predecessor: null } }),
    );
    const rows = out.members.incomeAnnual.ok ? out.members.incomeAnnual.value.data.rows : [];
    expect(rows.map((row) => row["date"])).toEqual(["2026-12-31"]);
    expect(rows.every((row) => row["predecessor"] === undefined)).toBe(true);
    // This successor carries its OWN us-gaap history (FY2026), so no hop was
    // ever attempted and nothing was lost: there is nothing to warn about. The
    // warn for the case where history IS missing is asserted below.
    expect(out.gaps.some((g) => g.field === "edgar.predecessor")).toBe(false);
  });

  it("does not reach for a predecessor when EDGAR has not confirmed the issuer", async () => {
    const out = await applyKeylessFallbacks(inputs({ edgarConfirmedIssuer: false }));
    expect(out.gaps.some((g) => g.field === "edgar.predecessor")).toBe(false);
  });

  it("warns when the registrant is a successor with NO history of its own and no predecessor was resolved", async () => {
    // "This company is four months old" and "we could not reach the other
    // ninety years" look identical in the numbers; only the manifest separates
    // them. RETARGETED: the fixture successor used to keep its own us-gaap
    // facts, so the old test asserted the warning in the one case where nothing
    // was missing. The registrant here files an 8-K12B and no us-gaap concept
    // at all — the case `resolvePredecessor` actually hops for.
    const base = inputs();
    const empty: CompanyFacts = { cik: 2115436, entityName: "EXAMPLE SUCCESSOR HOLDINGS CORP", facts: {} };
    const out = await applyKeylessFallbacks(
      inputs({
        edgar: {
          ...base.edgar,
          predecessor: null,
          companyFacts: {
            ok: true,
            value: { data: empty, asOf: "2026-09-01", source: "edgar", endpoint: "companyfacts", fetchedAt: NOW.toISOString() },
          },
        },
      }),
    );
    const entry = out.gaps.find((g) => g.field === "edgar.predecessor")!;
    expect(entry.severity).toBe("warn");
    expect(entry.reason).toMatch(/successor issuer \(Form 8-K12B\)/);
    expect(entry.reason).toMatch(/only the successor's own filing history/);
  });

  it("files no warning for a successor that carries its own us-gaap history", async () => {
    // The other null case: the reorganized entity carried the XBRL forward, so
    // the second hop was never attempted and the multi-year figures are whole.
    const base = inputs();
    const out = await applyKeylessFallbacks(inputs({ edgar: { ...base.edgar, predecessor: null } }));
    expect(out.gaps.some((g) => g.field === "edgar.predecessor")).toBe(false);
    expect(out.members.incomeAnnual.ok && out.members.incomeAnnual.value.data.rows.length).toBeGreaterThan(0);
  });

  it("discloses a stand-in that served only a PREDECESSOR period", async () => {
    // SHOULD-FIX 4: the predecessor path appended rows and discarded the
    // substitutions, notes and restatements built with them.
    const base = inputs();
    const predecessor = base.edgar.predecessor!;
    const facts = annualFacts(34088, "EXAMPLE PREDECESSOR CORP", [2024, 2025]);
    const usGaap = facts.facts["us-gaap"] as Record<string, { units: Record<string, unknown[]> }>;
    // No OperatingIncomeLoss and no income-statement interest tag: EBIT is
    // derived, and the interest term comes from the cash-flow supplement.
    for (const [tag, val] of [
      ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", 300],
      ["InterestPaidNet", 20],
    ] as const) {
      usGaap[tag] = {
        units: {
          USD: [2024, 2025].map((y) => ({
            start: `${y}-01-01`,
            end: `${y}-12-31`,
            val,
            accn: `0000034088-${String(y + 1).slice(2)}-000001`,
            fy: y,
            fp: "FY",
            form: "10-K",
            filed: `${y + 1}-02-15`,
          })),
        },
      };
    }
    const out = await applyKeylessFallbacks(
      inputs({ edgar: { ...base.edgar, predecessor: { ...predecessor, facts } } }),
    );
    const sub = out.gaps.find((g) => g.field === "keyless.incomeAnnual.predecessor.operatingIncome")!;
    expect(sub.severity).toBe("info");
    expect(sub.reason).toMatch(/^EBIT derived as pretax income/);
    expect(sub.reason).toMatch(/periods: 2025-12-31, 2024-12-31/);
    expect(sub.reason).toMatch(/pre-reorganization period\(s\) filed by the predecessor registrant, CIK 0000034088/);
    const interest = out.gaps.find((g) => g.field === "keyless.incomeAnnual.predecessor.interestExpense")!;
    expect(interest.reason).toMatch(/cash interest paid net of capitalized interest/);
  });

  it("files no successor warning for an ordinary registrant", async () => {
    const base = inputs();
    const out = await applyKeylessFallbacks(
      inputs({
        edgar: {
          ...base.edgar,
          registrant: { ...base.edgar.registrant!, forms: ["10-K", "10-Q"] },
          predecessor: null,
        },
      }),
    );
    expect(out.gaps.some((g) => g.field === "edgar.predecessor")).toBe(false);
  });
});
