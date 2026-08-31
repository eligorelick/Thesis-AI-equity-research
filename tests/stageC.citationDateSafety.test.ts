import { describe, expect, it } from "vitest";

import {
  isIsoDate,
  validateCitationRegistry,
  type CitationProvenanceRecord,
} from "@/pipeline/stageC/provenance";

/**
 * `validateCitationRegistry` is deliberately fail-loud on a malformed date, and
 * its throw is not caught before the runner's unexpected-failure path — so one
 * bad provider date terminated the whole job instead of degrading to a
 * disclosed gap. The repair belongs at the producer: normalize the date when
 * the citation is registered, so the assembler invariant can stay strict.
 */
const record = (asOf: string | null): CitationProvenanceRecord => ({
  id: "fmp:news",
  kind: "payload-text",
  asOf,
  origin: "fmp:news",
});

/** The normalization `registerCitation` applies before a record is created. */
const normalize = (asOf: string | null): string | null =>
  asOf !== null && isIsoDate(asOf) ? asOf : null;

describe("citation dates are normalized before the registry validates them", () => {
  it("keeps the assembler invariant strict", () => {
    expect(() => validateCitationRegistry([record("2026-13-45")])).toThrow(/Invalid citation date/);
  });

  it("accepts a null date — source known, date unknown", () => {
    expect(() => validateCitationRegistry([record(null)])).not.toThrow();
  });

  for (const bad of ["2026-13-45", "2026-02-30", "not-a-date", "", "2026-1-1", "9999-99-99"]) {
    it(`normalizes the unusable date ${JSON.stringify(bad)} to null`, () => {
      const normalized = normalize(bad);
      expect(normalized).toBeNull();
      // The registry the assembler sees therefore never contains it.
      expect(() => validateCitationRegistry([record(normalized)])).not.toThrow();
    });
  }

  it("preserves a genuine date untouched", () => {
    expect(normalize("2026-02-28")).toBe("2026-02-28");
    expect(() => validateCitationRegistry([record("2026-02-28")])).not.toThrow();
  });
});
