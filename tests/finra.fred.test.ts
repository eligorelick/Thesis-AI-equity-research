/**
 * Pure-logic tests for the FINRA / FRED / Finnhub provider modules.
 * No network: everything here exercises exported pure helpers and
 * no-key/disabled gap paths (which return before any fetch).
 */

import { describe, expect, it, vi } from "vitest";

import {
  FINRA_DAYS_TO_COVER_SENTINEL,
  buildShortInterestQuery,
  latestSettlementDate,
  normalizeDaysToCover,
  parseShortInterestRows,
  pickLatestPartitions,
} from "@/providers/finra";
import {
  CORE_SERIES,
  FRED_ATTRIBUTION,
  FRED_TREASURY_TTL_SECONDS,
  FRED_TTL_SECONDS,
  SECTOR_SERIES,
  applyFredUnits,
  inferObsPerYear,
  parseFredCsv,
  series,
  ttlForFredSeries,
  type GicsSector,
} from "@/providers/fred";
import { insiderSentiment, usptoPatents } from "@/providers/finnhub";

// ---------------------------------------------------------------------------
// FINRA — filter body construction
// ---------------------------------------------------------------------------

describe("finra buildShortInterestQuery", () => {
  it("builds EQUAL compareFilters for a single settlement date", () => {
    const body = buildShortInterestQuery("aapl", ["2026-06-15"], 5);
    expect(body).toEqual({
      limit: 5,
      compareFilters: [
        { compareType: "EQUAL", fieldName: "symbolCode", fieldValue: "AAPL" },
        { compareType: "EQUAL", fieldName: "settlementDate", fieldValue: "2026-06-15" },
      ],
    });
    expect(body.domainFilters).toBeUndefined();
  });

  it("uses domainFilters IN for multiple settlement dates (trend query)", () => {
    const dates = ["2026-06-15", "2026-05-29", "2026-05-15"];
    const body = buildShortInterestQuery(" gme ", dates);
    expect(body.limit).toBe(5000);
    expect(body.compareFilters).toEqual([
      { compareType: "EQUAL", fieldName: "symbolCode", fieldValue: "GME" },
    ]);
    expect(body.domainFilters).toEqual([{ fieldName: "settlementDate", values: dates }]);
  });

  it("throws TypeError on programming errors (empty symbol / no dates)", () => {
    expect(() => buildShortInterestQuery("", ["2026-06-15"])).toThrow(TypeError);
    expect(() => buildShortInterestQuery("AAPL", [])).toThrow(TypeError);
  });
});

describe("finra pickLatestPartitions", () => {
  const payload = {
    datasetGroup: "otcmarket",
    datasetName: "consolidatedshortinterest",
    partitionFields: ["settlementDate"],
    availablePartitions: [
      { partitions: ["2026-06-15"] },
      { partitions: ["2026-05-29"] },
      { partitions: ["2026-05-15"] },
      { partitions: ["2026-04-30"] },
    ],
  };

  it("extracts the latest n settlement dates, descending", () => {
    expect(pickLatestPartitions(payload, 2)).toEqual(["2026-06-15", "2026-05-29"]);
    expect(pickLatestPartitions(payload, 99)).toEqual([
      "2026-06-15",
      "2026-05-29",
      "2026-05-15",
      "2026-04-30",
    ]);
  });

  it("returns null on unrecognized payload shapes", () => {
    expect(pickLatestPartitions({ nope: true }, 1)).toBeNull();
    expect(pickLatestPartitions("<html>blocked</html>", 1)).toBeNull();
    expect(pickLatestPartitions({ availablePartitions: [] }, 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FINRA — 999.99 days-to-cover sentinel
// ---------------------------------------------------------------------------

describe("provider transport timeouts", () => {
  function trackClearTimeout(): { wasCleared: () => boolean; restore: () => void } {
    let cleared = false;
    const original = globalThis.clearTimeout.bind(globalThis);
    const spy = vi.spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
      cleared = true;
      return original(handle as Parameters<typeof clearTimeout>[0]);
    });
    return { wasCleared: () => cleared, restore: () => spy.mockRestore() };
  }

  it("keeps the FINRA timeout active until the JSON body is consumed", async () => {
    const tracker = trackClearTimeout();
    let clearedBeforeBody = true;
    try {
      const fetchImpl = () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => {
            clearedBeforeBody = tracker.wasCleared();
            return { availablePartitions: [{ partitions: ["2026-06-30"] }] };
          },
        } as Response);

      const result = await latestSettlementDate({
        fetchImpl,
        retryDelaysMs: [],
        minRequestIntervalMs: 0,
        timeoutMs: 1000,
      });

      expect(result.ok).toBe(true);
      expect(clearedBeforeBody).toBe(false);
    } finally {
      tracker.restore();
    }
  });

  it("keeps the FRED timeout active until the text body is consumed", async () => {
    const tracker = trackClearTimeout();
    let clearedBeforeBody = true;
    try {
      const fetchImpl = () =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: async () => {
            clearedBeforeBody = tracker.wasCleared();
            return "observation_date,DGS10\n2026-06-01,4.5\n";
          },
        } as Response);

      const result = await series("DGS10", {}, {
        fetchImpl,
        retryDelaysMs: [],
        minRequestIntervalMs: 0,
        timeoutMs: 1000,
      });

      expect(result.ok).toBe(true);
      expect(clearedBeforeBody).toBe(false);
    } finally {
      tracker.restore();
    }
  });

  it("keeps the Finnhub timeout active until the JSON body is consumed", async () => {
    const tracker = trackClearTimeout();
    let clearedBeforeBody = true;
    try {
      const fetchImpl = () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => {
            clearedBeforeBody = tracker.wasCleared();
            return { data: [{ year: 2026, month: 6, change: 10, mspr: 0.4 }] };
          },
        } as Response);

      const result = await insiderSentiment("AAPL", "2026-01-01", "2026-06-30", {
        apiKey: "TEST",
        fetchImpl,
        retryDelaysMs: [],
        maxRequestsPerMinute: 0,
        timeoutMs: 1000,
      });

      expect(result.ok).toBe(true);
      expect(clearedBeforeBody).toBe(false);
    } finally {
      tracker.restore();
    }
  });
});

describe("finra daysToCover sentinel handling", () => {
  it("maps the 999.99 sentinel to null and flags it", () => {
    expect(normalizeDaysToCover(FINRA_DAYS_TO_COVER_SENTINEL)).toEqual({
      value: null,
      sentinel: true,
    });
    expect(normalizeDaysToCover(2.76)).toEqual({ value: 2.76, sentinel: false });
    expect(normalizeDaysToCover(null)).toEqual({ value: null, sentinel: false });
    expect(normalizeDaysToCover(undefined)).toEqual({ value: null, sentinel: false });
  });

  it("normalizes sentinel rows in parseShortInterestRows with a disclosure note", () => {
    const liveShapedRow = {
      stockSplitFlag: null,
      previousShortPositionQuantity: 155886024,
      averageDailyVolumeQuantity: 52343843,
      issueName: "Apple Inc. Common Stock",
      currentShortPositionQuantity: 144248476,
      changePreviousNumber: -11637548,
      accountingYearMonthNumber: 20260615,
      settlementDate: "2026-06-15",
      marketClassCode: "NNM",
      symbolCode: "AAPL",
      daysToCoverQuantity: 2.76,
      issuerServicesGroupExchangeCode: "R",
      revisionFlag: null,
      changePercent: -7.47,
    };
    const sentinelRow = {
      ...liveShapedRow,
      symbolCode: "TINYOTC",
      daysToCoverQuantity: 999.99,
      averageDailyVolumeQuantity: 0,
    };

    const rows = parseShortInterestRows([liveShapedRow, sentinelRow]);
    expect(rows).not.toBeNull();
    const [aapl, tiny] = rows!.sort((a, b) => a.symbol.localeCompare(b.symbol));

    expect(aapl.daysToCoverQuantity).toBe(2.76);
    expect(aapl.daysToCoverSentinel).toBe(false);
    expect(aapl.notes).toEqual([]);
    expect(aapl.currentShortPositionQuantity).toBe(144248476);
    expect(aapl.marketClassCode).toBe("NNM");

    expect(tiny.daysToCoverQuantity).toBeNull();
    expect(tiny.daysToCoverSentinel).toBe(true);
    expect(tiny.notes.length).toBe(1);
    expect(tiny.notes[0]).toMatch(/999\.99/);
  });

  it("returns null for malformed row payloads", () => {
    expect(parseShortInterestRows({ error: "nope" })).toBeNull();
    expect(parseShortInterestRows([{ symbolCode: "AAPL" }])).toBeNull(); // missing required fields
  });

  it("sorts parsed rows ascending by settlementDate", () => {
    const mk = (settlementDate: string) => ({
      symbolCode: "AAPL",
      settlementDate,
      currentShortPositionQuantity: 1,
    });
    const rows = parseShortInterestRows([mk("2026-06-15"), mk("2026-04-30"), mk("2026-05-29")]);
    expect(rows!.map((r) => r.settlementDate)).toEqual([
      "2026-04-30",
      "2026-05-29",
      "2026-06-15",
    ]);
  });
});

// ---------------------------------------------------------------------------
// FRED — fredgraph.csv parsing
// ---------------------------------------------------------------------------

describe("fred parseFredCsv", () => {
  it("parses the live-verified header + rows", () => {
    const csv = [
      "observation_date,DGS10",
      "2026-06-29,4.38",
      "2026-06-30,4.44",
      "2026-07-01,4.48",
      "",
    ].join("\n");
    expect(parseFredCsv(csv)).toEqual([
      { date: "2026-06-29", value: 4.38 },
      { date: "2026-06-30", value: 4.44 },
      { date: "2026-07-01", value: 4.48 },
    ]);
  });

  it('skips "." missing-value rows and empty cells', () => {
    const csv = [
      "observation_date,DGS10",
      "2026-06-29,4.38",
      "2026-06-30,.",
      "2026-07-01,",
      "2026-07-02,4.50",
    ].join("\r\n"); // CRLF tolerated
    expect(parseFredCsv(csv)).toEqual([
      { date: "2026-06-29", value: 4.38 },
      { date: "2026-07-02", value: 4.5 },
    ]);
  });

  it("returns null for non-CSV bodies (e.g. the HTML 404 page for a bad id)", () => {
    expect(parseFredCsv("<html><body>Not Found</body></html>")).toBeNull();
    expect(parseFredCsv("")).toBeNull();
  });

  it("skips malformed rows without failing the whole parse", () => {
    const csv = ["observation_date,UNRATE", "garbage line", "2026-06-01,4.2"].join("\n");
    expect(parseFredCsv(csv)).toEqual([{ date: "2026-06-01", value: 4.2 }]);
  });
});

describe("fred client-side units transforms (keyless mode)", () => {
  const monthly = [
    { date: "2025-01-01", value: 100 },
    { date: "2025-02-01", value: 102 },
    { date: "2025-03-01", value: 104 },
    { date: "2025-04-01", value: 103 },
    { date: "2025-05-01", value: 105 },
    { date: "2025-06-01", value: 106 },
    { date: "2025-07-01", value: 107 },
    { date: "2025-08-01", value: 108 },
    { date: "2025-09-01", value: 109 },
    { date: "2025-10-01", value: 110 },
    { date: "2025-11-01", value: 111 },
    { date: "2025-12-01", value: 112 },
    { date: "2026-01-01", value: 113 },
  ];

  it("infers observations-per-year from spacing", () => {
    expect(inferObsPerYear(monthly)).toBe(12);
    expect(
      inferObsPerYear([
        { date: "2026-06-29", value: 1 },
        { date: "2026-06-30", value: 1 },
        { date: "2026-07-01", value: 1 },
      ]),
    ).toBe(260); // daily
    expect(
      inferObsPerYear([
        { date: "2025-01-01", value: 1 },
        { date: "2025-04-01", value: 1 },
        { date: "2025-07-01", value: 1 },
      ]),
    ).toBe(4); // quarterly
  });

  it("chg = x(t) - x(t-1)", () => {
    const out = applyFredUnits(monthly, "chg");
    expect(out[0]).toEqual({ date: "2025-02-01", value: 2 });
    expect(out.length).toBe(monthly.length - 1);
  });

  it("pc1 = YoY percent change using n obs/yr lag", () => {
    const out = applyFredUnits(monthly, "pc1");
    expect(out.length).toBe(1); // only 2026-01-01 has a value 12 months back
    expect(out[0].date).toBe("2026-01-01");
    expect(out[0].value).toBeCloseTo(13, 10); // (113/100 - 1) * 100
  });

  it("lin passes rows through unchanged", () => {
    expect(applyFredUnits(monthly, "lin")).toEqual(monthly);
  });
});

// ---------------------------------------------------------------------------
// FRED — dashboard + sector map completeness
// ---------------------------------------------------------------------------

describe("fred series catalogs", () => {
  const ALL_GICS: GicsSector[] = [
    "Energy",
    "Materials",
    "Industrials",
    "Consumer Discretionary",
    "Consumer Staples",
    "Health Care",
    "Financials",
    "Information Technology",
    "Communication Services",
    "Utilities",
    "Real Estate",
  ];

  it("SECTOR_SERIES covers all 11 GICS sectors with non-empty series lists", () => {
    expect(Object.keys(SECTOR_SERIES).sort()).toEqual([...ALL_GICS].sort());
    for (const sector of ALL_GICS) {
      const ids = SECTOR_SERIES[sector];
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(id).toMatch(/^[A-Z0-9]+$/); // FRED ids are uppercase alphanumeric
      }
    }
  });

  it("spot-checks research-verified sector series", () => {
    expect(SECTOR_SERIES.Energy).toContain("DCOILWTICO");
    expect(SECTOR_SERIES.Financials).toContain("DRTSCILM");
    expect(SECTOR_SERIES["Real Estate"]).toContain("MORTGAGE30US");
    expect(SECTOR_SERIES["Health Care"]).toContain("CES6562000001");
  });

  it("CORE_SERIES is the exact 12-series dashboard", () => {
    expect(CORE_SERIES.map((s) => s.id)).toEqual([
      "DGS10",
      "DGS2",
      "T10Y2Y",
      "T10Y3M",
      "EFFR",
      "CPIAUCSL",
      "CPILFESL",
      "UNRATE",
      "PAYEMS",
      "T10YIE",
      "BAMLH0A0HYM2",
      "VIXCLS",
    ]);
    // Transforms per research §8: CPI series YoY, payrolls monthly change.
    const units = new Map(CORE_SERIES.map((s) => [s.id, s.units]));
    expect(units.get("CPIAUCSL")).toBe("pc1");
    expect(units.get("CPILFESL")).toBe("pc1");
    expect(units.get("PAYEMS")).toBe("chg");
    expect(units.get("DGS10")).toBe("lin");
  });

  it("treasury series get the faster TTL", () => {
    expect(ttlForFredSeries("DGS10")).toBe(FRED_TREASURY_TTL_SECONDS);
    expect(ttlForFredSeries("effr")).toBe(FRED_TREASURY_TTL_SECONDS);
    expect(ttlForFredSeries("CPIAUCSL")).toBe(FRED_TTL_SECONDS);
  });

  it("carries the mandatory FRED attribution verbatim", () => {
    expect(FRED_ATTRIBUTION).toBe(
      "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.",
    );
  });
});

// ---------------------------------------------------------------------------
// Finnhub — no-key / disabled-module gap paths (no network involved)
// ---------------------------------------------------------------------------

describe("finnhub gap behavior without a key", () => {
  it("insiderSentiment returns the 'Finnhub key missing' gap", async () => {
    const result = await insiderSentiment("AAPL", "2025-07-01", "2026-07-01", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gap.reason).toBe("Finnhub key missing");
      expect(result.gap.field).toBe("insiderSentiment.AAPL");
      expect(result.gap.attemptedSources).toEqual(["finnhub"]);
    }
  });

  it("sector modules are disabled by default (before the key check)", async () => {
    const result = await usptoPatents("NVDA", "2026-01-01", "2026-07-01", { apiKey: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gap.reason).toMatch(/sector module disabled/);
      expect(result.gap.severity).toBe("info");
    }
  });

  it("rejects malformed date params as programming errors", async () => {
    await expect(insiderSentiment("AAPL", "07/01/2025", "2026-07-01", {})).rejects.toThrow(
      TypeError,
    );
  });
});
