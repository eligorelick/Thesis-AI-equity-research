import { describe, expect, it } from "vitest";

import { latestEligibleFactEnd, type CompanyFacts } from "@/edgar/xbrl";

/**
 * A companyfacts envelope was stamped with the date it was FETCHED, so the
 * observation date moved every time the cache refreshed even though the
 * underlying filings had not changed — and a company that last reported a year
 * ago looked as freshly observed as one that reported yesterday.
 *
 * The observation date is the newest period end actually present in the facts,
 * restricted to the core forms the extractor already trusts and never later
 * than the fetch date.
 */
function facts(points: Array<Record<string, unknown>>): CompanyFacts {
  return {
    cik: 320193,
    entityName: "Example Inc",
    facts: {
      "us-gaap": {
        Revenues: { label: "Revenues", units: { USD: points } },
      },
    },
  };
}

const point = (over: Record<string, unknown> = {}) => ({
  end: "2025-12-31",
  val: 100,
  accn: "0000320193-26-000001",
  form: "10-K",
  filed: "2026-02-01",
  ...over,
});

describe("latestEligibleFactEnd", () => {
  it("returns the newest core-form period end", () => {
    const resolved = latestEligibleFactEnd(
      facts([point({ end: "2024-12-31" }), point({ end: "2025-09-30", form: "10-Q" }), point()]),
      "2026-08-31",
    );

    expect(resolved).toBe("2025-12-31");
  });

  it("ignores non-core forms such as 8-K and 6-K", () => {
    const resolved = latestEligibleFactEnd(
      facts([point({ end: "2025-12-31" }), point({ end: "2026-06-30", form: "6-K" })]),
      "2026-08-31",
    );

    expect(resolved).toBe("2025-12-31");
  });

  it("never returns a period end later than the fetch date", () => {
    const resolved = latestEligibleFactEnd(
      facts([point({ end: "2025-12-31" }), point({ end: "2099-12-31" })]),
      "2026-08-31",
    );

    expect(resolved).toBe("2025-12-31");
  });

  it("accepts amended and foreign annual forms", () => {
    expect(latestEligibleFactEnd(facts([point({ form: "10-K/A" })]), "2026-08-31")).toBe("2025-12-31");
    expect(latestEligibleFactEnd(facts([point({ form: "20-F" })]), "2026-08-31")).toBe("2025-12-31");
  });

  it("returns null when no eligible fact exists", () => {
    expect(latestEligibleFactEnd(facts([]), "2026-08-31")).toBeNull();
    expect(latestEligibleFactEnd(facts([point({ form: "8-K" })]), "2026-08-31")).toBeNull();
  });

  it("tolerates malformed points without throwing", () => {
    const resolved = latestEligibleFactEnd(
      facts([{ nope: true }, "junk" as unknown as Record<string, unknown>, point()]),
      "2026-08-31",
    );

    expect(resolved).toBe("2025-12-31");
  });
});
