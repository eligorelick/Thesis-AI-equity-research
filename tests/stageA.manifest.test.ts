/**
 * Stage A manifest utilities — pure unit tests (no network, no db).
 */
import { describe, expect, it } from "vitest";
import type { ManifestEntry } from "@/types/core";
import {
  mergeManifest,
  renderManifestSummary,
  severityRank,
} from "@/pipeline/stageA/manifest";

function entry(
  field: string,
  severity: ManifestEntry["severity"],
  reason = `reason for ${field}`,
  attemptedSources?: string[],
): ManifestEntry {
  const e: ManifestEntry = { field, reason, severity };
  if (attemptedSources !== undefined) e.attemptedSources = attemptedSources;
  return e;
}

describe("severityRank", () => {
  it("orders info < warn < critical", () => {
    expect(severityRank("info")).toBeLessThan(severityRank("warn"));
    expect(severityRank("warn")).toBeLessThan(severityRank("critical"));
  });
});

describe("mergeManifest", () => {
  it("dedupes by field keeping the highest severity (its reason wins)", () => {
    const merged = mergeManifest(
      [entry("a", "info", "info reason")],
      [entry("a", "critical", "critical reason")],
      [entry("a", "warn", "warn reason")],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].severity).toBe("critical");
    expect(merged[0].reason).toBe("critical reason");
  });

  it("keeps the FIRST entry on equal severity (reason preserved)", () => {
    const merged = mergeManifest(
      [entry("a", "warn", "first"), entry("a", "warn", "second")],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].reason).toBe("first");
  });

  it("unions attemptedSources across duplicates without duplicates", () => {
    const merged = mergeManifest(
      [entry("a", "info", "r1", ["s1", "s2"])],
      [entry("a", "warn", "r2", ["s2", "s3"])],
    );
    expect(merged[0].attemptedSources).toEqual(["s1", "s2", "s3"]);
    expect(merged[0].severity).toBe("warn");
  });

  it("accepts single entries, arrays, null and undefined sources", () => {
    const merged = mergeManifest(
      entry("solo", "info"),
      null,
      undefined,
      [entry("listed", "warn")],
    );
    expect(merged.map((e) => e.field).sort()).toEqual(["listed", "solo"]);
  });

  it("sorts output severity DESC then field ASC (deterministic)", () => {
    const merged = mergeManifest([
      entry("zeta", "info"),
      entry("alpha", "info"),
      entry("mid", "warn"),
      entry("boom", "critical"),
    ]);
    expect(merged.map((e) => e.field)).toEqual(["boom", "mid", "alpha", "zeta"]);
  });

  it("does not mutate input entries", () => {
    const original = entry("a", "info", "r", ["s1"]);
    const other = entry("a", "critical", "r2", ["s2"]);
    mergeManifest([original], [other]);
    expect(original.attemptedSources).toEqual(["s1"]);
    expect(other.attemptedSources).toEqual(["s2"]);
    expect(original.severity).toBe("info");
  });

  it("returns [] for no inputs", () => {
    expect(mergeManifest()).toEqual([]);
    expect(mergeManifest([], null)).toEqual([]);
  });
});

describe("renderManifestSummary", () => {
  it("counts by severity and renders a one-liner", () => {
    const summary = renderManifestSummary([
      entry("a", "critical"),
      entry("b", "warn"),
      entry("c", "warn"),
      entry("d", "info"),
    ]);
    expect(summary.total).toBe(4);
    expect(summary.bySeverity).toEqual({ critical: 1, warn: 2, info: 1 });
    expect(summary.line).toContain("4 data gap(s)");
    expect(summary.line).toContain("1 critical");
    expect(summary.line).toContain("2 warning(s)");
    expect(summary.line).toContain("1 informational");
  });

  it("handles empty manifests", () => {
    const summary = renderManifestSummary([]);
    expect(summary.total).toBe(0);
    expect(summary.bySeverity).toEqual({ critical: 0, warn: 0, info: 0 });
  });
});
