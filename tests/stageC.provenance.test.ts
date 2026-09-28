import { describe, expect, it } from "vitest";

import {
  canonicalizeFetchedUrl,
  canonicalizeTracedUnit,
  periodsAgree,
  calculateCoverage,
  matchProvenanceRecord,
  validateCitationRegistry,
  validateProvenanceRegistry,
  type NumericProvenanceRecord,
} from "@/pipeline/stageC/provenance";

const record: NumericProvenanceRecord = {
  id: "payload.quote.price",
  kind: "provider",
  value: 187.32,
  unit: "currency-per-share",
  currency: "USD",
  period: null,
  asOf: "2026-07-18",
  origin: "fmp:quote",
  formulaVersion: null,
  displayPrecision: 2,
};

const candidate = {
  value: 187.32,
  unit: "currency-per-share" as const,
  currency: "USD",
  period: null,
  asOf: "2026-07-18",
  source: "payload.quote.price",
};

describe("exact provenance matching", () => {
  it("accepts a fully matching registered value", () => {
    expect(matchProvenanceRecord(candidate, [record])).toEqual({ ok: true, record });
  });

  it("rejects a fabricated source even when every numeric dimension matches", () => {
    expect(
      matchProvenanceRecord({ ...candidate, source: "fmp:invented-path" }, [record]),
    ).toEqual({ ok: false, reason: "unknown-source" });
  });

  it.each([
    ["value", { value: 188.32 }, "value-mismatch"],
    ["unit", { unit: "percent" as const }, "unit-mismatch"],
    ["currency", { currency: "EUR" }, "currency-mismatch"],
    ["period", { period: "FY2025" }, "period-mismatch"],
    ["date", { asOf: "2026-07-17" }, "date-mismatch"],
  ])("rejects a %s mismatch", (_field, change, reason) => {
    expect(matchProvenanceRecord({ ...candidate, ...change }, [record])).toMatchObject({
      ok: false,
      reason,
    });
  });

  it("allows only the record's declared display-rounding tolerance", () => {
    expect(matchProvenanceRecord({ ...candidate, value: 187.324 }, [record])).toMatchObject({
      ok: true,
    });
    expect(matchProvenanceRecord({ ...candidate, value: 187.326 }, [record])).toMatchObject({
      ok: false,
      reason: "value-mismatch",
    });
  });
});

describe("provenance registry validation", () => {
  it("accepts a faithful rounding that lands exactly on the tolerance (audit 2026-09-06, F180/F196)", () => {
    // 187.32455 rendered at 4 dp is 187.3246 (or 187.3245 under half-even):
    // both differ from the record by exactly 0.00005, the tolerance itself, and
    // binary float noise used to push the subtraction a few ulps over it.
    const tie: NumericProvenanceRecord = { ...record, value: 187.32455, displayPrecision: 4 };
    for (const value of [187.3246, 187.3245]) {
      expect(matchProvenanceRecord({ ...candidate, value }, [tie])).toMatchObject({ ok: true });
    }
    expect(matchProvenanceRecord({ ...candidate, value: 187.3247 }, [tie])).toMatchObject({
      ok: false,
      reason: "value-mismatch",
    });
  });

  it("rejects duplicate IDs", () => {
    expect(() => validateProvenanceRegistry([record, { ...record }])).toThrow(
      "Duplicate provenance ID: payload.quote.price",
    );
  });

  it("requires computed records to declare a formula version", () => {
    expect(() =>
      validateProvenanceRegistry([{ ...record, kind: "computed", formulaVersion: null }]),
    ).toThrow("Computed provenance requires a formula version: payload.quote.price");
  });

  it("rejects malformed dates, currencies, and precision", () => {
    expect(() => validateProvenanceRegistry([{ ...record, asOf: "07/18/2026" }])).toThrow(
      "Invalid provenance date: payload.quote.price",
    );
    expect(() => validateProvenanceRegistry([{ ...record, currency: "usd" }])).toThrow(
      "Invalid provenance currency: payload.quote.price",
    );
    expect(() => validateProvenanceRegistry([{ ...record, displayPrecision: -1 }])).toThrow(
      "Invalid provenance precision: payload.quote.price",
    );
  });
});

describe("citation registry validation", () => {
  const citation = {
    id: "edgar:10-K item1A",
    kind: "payload-text" as const,
    asOf: "2025-09-27",
    origin: "edgar:10-K item1A",
  };

  it("accepts an exact payload text citation", () => {
    expect(() => validateCitationRegistry([citation])).not.toThrow();
  });

  it("rejects duplicate source/date pairs and malformed dates", () => {
    expect(() => validateCitationRegistry([citation, citation])).toThrow(
      "Duplicate citation record: edgar:10-K item1A",
    );
    expect(() => validateCitationRegistry([{ ...citation, asOf: "09/27/2025" }])).toThrow(
      "Invalid citation date: edgar:10-K item1A",
    );
  });
});

describe("fetched URL canonicalization", () => {
  it("keeps query identity and removes fragments", () => {
    expect(canonicalizeFetchedUrl("HTTPS://Example.COM/a?q=1#section")).toBe(
      "https://example.com/a?q=1",
    );
  });

  it("rejects malformed and non-HTTP URLs", () => {
    expect(canonicalizeFetchedUrl("not a url")).toBeNull();
    expect(canonicalizeFetchedUrl("javascript:alert(1)")).toBeNull();
    expect(canonicalizeFetchedUrl("ftp://example.com/a")).toBeNull();
  });
});

describe("coverage arithmetic", () => {
  it("uses null rather than perfect coverage for an empty denominator", () => {
    expect(calculateCoverage(0, 0)).toEqual({ supported: 0, total: 0, rate: null });
  });

  it("returns the exact supported fraction", () => {
    expect(calculateCoverage(2, 4)).toEqual({ supported: 2, total: 4, rate: 0.5 });
  });
});

describe("canonical traced units", () => {
  it.each([
    ["USD", null, { unit: "currency", currency: "USD" }],
    ["USD/share", null, { unit: "currency-per-share", currency: "USD" }],
    ["currency", "EUR", { unit: "currency", currency: "EUR" }],
    ["%", null, { unit: "percent", currency: null }],
    ["pp", null, { unit: "percentage-points", currency: null }],
    ["pp/yr", null, { unit: "percentage-points-per-year", currency: null }],
  ])("canonicalizes %s", (unit, currency, expected) => {
    expect(canonicalizeTracedUnit(unit, currency)).toEqual(expected);
  });

  it("fails closed for an unknown unit", () => {
    expect(canonicalizeTracedUnit("widgets per fortnight", null)).toBeNull();
  });

  it("fails closed when a bare ISO unit contradicts the declared currency (audit 2026-09-06, F181)", () => {
    expect(canonicalizeTracedUnit("EUR", "USD")).toBeNull();
    expect(canonicalizeTracedUnit("EUR/share", "USD")).toBeNull();
    expect(canonicalizeTracedUnit("EUR", "EUR")).toEqual({ unit: "currency", currency: "EUR" });
    expect(canonicalizeTracedUnit("EUR/share", "eur")).toEqual({ unit: "currency-per-share", currency: "EUR" });
  });

  it.each([
    // The payload's own aspect-score spelling and the two spellings a live
    // haiku run (2026-09-02) echoed back, which stranded every grade-strip key
    // number as unit-mismatch.
    ["0-100 (grade B, completeness 0.9)", { unit: "score", currency: null }],
    ["0-100 score", { unit: "score", currency: null }],
    ["index (0-100)", { unit: "index", currency: null }],
    // A scale qualifier is stripped too; the value match catches the ×1e6.
    ["USD (millions)", { unit: "currency", currency: "USD" }],
    ["count", { unit: "count", currency: null }],
  ])("reads a qualified unit spelling %s", (unit, expected) => {
    expect(canonicalizeTracedUnit(unit, null)).toEqual(expected);
  });
});

describe("period agreement", () => {
  // The third column is the issuer's own fiscal label for the registered row
  // (the statement row's fiscalYear/period), or null when none is known.
  it.each([
    ["2025-12-31", "2025-12-31", null],
    ["total debt 2025-12-31", "2025-12-31", null],
    ["revenue FY2027E", "FY2027E", null],
    ["fy27", "FY2027E", null],
    ["FY2025", "2025-12-31", "FY2025"],
    ["total debt FY2025", "2025-12-31", "FY2025"],
    ["fy25", "2025-12-31", "FY2025"],
    ["2025", "2025-12-31", "FY2025"],
    ["Q2 2026", "2026-06-30", "Q2 FY2026"],
    ["cash+STI Q2 2026", "2026-06-30", "Q2 FY2026"],
    // Apple's Q1 FY2026 ended 2025-12-27: its own label says so.
    ["Q1 FY2026", "2025-12-27", "Q1 FY2026"],
    ["first quarter of fiscal 2026", "2025-12-27", "Q1 FY2026"],
    // A 52/53-week year that runs into January still closes calendar Q4.
    ["Q4 2025", "2026-01-03", "Q4 FY2025"],
    ["Q4 FY2025", "2025-03-31", "Q4 FY2025"],
  ])("reads %s as the registered period %s (issuer label %s)", (supplied, registered, issuer) => {
    expect(periodsAgree(supplied, registered, issuer)).toBe(true);
  });

  it.each([
    ["FY2024", "2025-12-31", "FY2025"],
    ["FY2024 vs FY2025", "2025-12-31", "FY2025"],
    ["2025-12-31 vs 2024-12-31", "2025-12-31", "FY2025"],
    ["FY1999", "FY2027", null],
    ["trailing twelve months", "2025-12-31", "FY2025"],
    // Same year, different period: another date, a quarter against a year,
    // the wrong quarter.
    ["2025-03-31", "2025-12-31", "FY2025"],
    ["Q1 2025", "2025-12-31", "FY2025"],
    ["Q3 2025", "2025-12-31", "Q4 FY2025"],
    ["H1 2025", "2025-06-30", "Q2 FY2025"],
    ["Q4 FY2025", "2025-03-31", "FY2025"],
    // No issuer calendar: a fiscal spelling cannot be matched to a date.
    ["FY2025", "2025-12-31", null],
    ["Q2 2026", "2026-06-30", null],
    ["Q1 FY2026", "2025-12-27", null],
    ["Q4 2025", "2025-03-31", null],
    // A spelling that could be a calendar period must close where the record
    // ends: a September-year issuer's Q1 FY2025 (ended 2024-12-28) is not
    // calendar Q1 2025, and its FY2025 is not calendar 2025.
    ["Q1 2025", "2024-12-28", "Q1 FY2025"],
    ["2025", "2025-09-27", "FY2025"],
    ["Q4 2025", "2025-03-31", "Q4 FY2025"],
  ])("rejects %s against the registered period %s (issuer label %s)", (supplied, registered, issuer) => {
    expect(periodsAgree(supplied, registered, issuer)).toBe(false);
  });

  it("treats an omitted period, or a record without one, as agreement", () => {
    expect(periodsAgree(null, "2025-12-31")).toBe(true);
    expect(periodsAgree(undefined, "2025-12-31")).toBe(true);
    expect(periodsAgree("anything", null)).toBe(true);
  });
});
