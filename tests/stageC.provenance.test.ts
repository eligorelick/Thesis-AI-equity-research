import { describe, expect, it } from "vitest";

import {
  canonicalizeFetchedUrl,
  canonicalizeTracedUnit,
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
});
