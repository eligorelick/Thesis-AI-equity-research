import { describe, expect, it } from "vitest";

import {
  citationSourceId,
  collapseDuplicateLegacyCitationDates,
  parseCitationRef,
  serializeCitationRef,
  type CitationRef,
} from "@/pipeline/stageC/citations";

describe("structured citation references", () => {
  const ref: CitationRef = { sourceId: "computed.x", asOf: "2026-07-21" };

  it("collapses only deterministic duplicate legacy dates", () => {
    expect(collapseDuplicateLegacyCitationDates(
      "60958000000 USD [payload.segments.product · 2025-12-31 · 2025-12-31]",
    )).toBe("60958000000 USD [payload.segments.product · 2025-12-31]");
    expect(collapseDuplicateLegacyCitationDates(
      "claim [source · 2025-12-31 · 2026-01-01]",
    )).toBe("claim [source · 2025-12-31 · 2026-01-01]");
  });

  it("serializes and parses an exact source/date reference", () => {
    expect(serializeCitationRef(ref)).toBe("[computed.x · 2026-07-21]");
    expect(parseCitationRef(serializeCitationRef(ref))).toEqual(ref);
    expect(parseCitationRef("computed.x · 2026-07-21")).toEqual(ref);
  });

  it("round-trips a timeless citation", () => {
    const timeless = { sourceId: "computed.methodology", asOf: null } as const;
    expect(parseCitationRef(serializeCitationRef(timeless))).toEqual(timeless);
  });

  it("rejects duplicated dates and malformed source ids", () => {
    expect(parseCitationRef("computed.x · 2026-07-21 · 2026-07-21")).toBeNull();
    expect(parseCitationRef("[computed.x · 2026-07-21] · 2026-07-21")).toBeNull();
    expect(parseCitationRef("[computed.x · 2026-02-30]")).toBeNull();
    expect(parseCitationRef("[ ]")).toBeNull();
  });

  it("prefers structured sourceId and reads legacy source fields without guessing", () => {
    expect(citationSourceId({ sourceId: "payload.quote.price", asOf: "2026-07-20" })).toBe(
      "payload.quote.price",
    );
    expect(citationSourceId({ source: "[payload.quote.price · 2026-07-20]", asOf: "2026-07-20" })).toBe(
      "payload.quote.price",
    );
    expect(citationSourceId({ source: "payload.quote.price", asOf: "2026-07-20" })).toBe(
      "payload.quote.price",
    );
    expect(
      citationSourceId({ source: "payload.quote.price · 2026-07-20 · 2026-07-20", asOf: "2026-07-20" }),
    ).toBeNull();
  });
});
