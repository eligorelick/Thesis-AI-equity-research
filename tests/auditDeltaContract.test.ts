/**
 * The machinery behind the audited fixture comparison, exercised on small
 * documents so each rule is visible. The comparison itself runs in
 * tests/audit.fixtureComparison.test.ts against the real projection; this file
 * proves the contract rejects what it claims to reject. No network.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  type AuditJsonValue,
  type IntendedDelta,
  type IntendedDeltaFile,
  assertExactDeltaContract,
  computeManifestIdentity,
  diffPaths,
  encodeSegment,
  flattenDeltaFile,
  readJsonPath,
  splitPath,
} from "./helpers/auditDeltaContract";

const SCRIPT = path.join(process.cwd(), "scripts", "audit-deltas.mjs");

interface DeltaScript {
  regenerate(input: {
    baseline: AuditJsonValue;
    current: AuditJsonValue;
    existing: IntendedDeltaFile;
    targetGroup?: string;
    generatedAt: string;
    contract: unknown;
  }): { file: IntendedDeltaFile; added: string[]; dropped: string[] };
  projectionSha256(canonical: string): string;
}

async function loadScript(): Promise<DeltaScript> {
  return (await import(pathToFileURL(SCRIPT).href)) as DeltaScript;
}

function group(deltas: IntendedDelta[], overrides: Partial<IntendedDeltaFile["groups"][number]> = {}) {
  return {
    name: "example",
    decisions: ["D-11"],
    reason:
      "A reason long enough to be worth reading, naming the change and the decision record that caused it.",
    deltas,
    ...overrides,
  };
}

function file(groups: IntendedDeltaFile["groups"]): IntendedDeltaFile {
  return {
    againstBaseline: { auditedBaseCommit: "524d09e", projectionSha256: "0".repeat(64) },
    generatedAt: "2026-09-02",
    keyedArrays: [],
    manifestIdentity: {},
    groups,
  };
}

describe("delta paths", () => {
  it("escapes a key that itself contains a dot, so the two shapes stay distinguishable", () => {
    const nested = { asOfMap: { edgar: { cik: "2026-01-01" } } };
    const flat = { asOfMap: { "edgar.cik": "2026-01-01" } };
    expect(diffPaths(nested, flat).sort()).toEqual([
      "asOfMap.edgar",
      "asOfMap.edgar\\.cik",
    ]);
    expect(readJsonPath(flat, "asOfMap.edgar\\.cik").value).toBe("2026-01-01");
    expect(readJsonPath(flat, "asOfMap.edgar.cik").exists).toBe(false);
    expect(readJsonPath(nested, "asOfMap.edgar.cik").value).toBe("2026-01-01");
    expect(splitPath(encodeSegment("a.b") + ".c")).toEqual(["a.b", "c"]);
    expect(splitPath(encodeSegment("back\\slash"))).toEqual(["back\\slash"]);
  });

  it("reports a surplus array element and a key present on only one side", () => {
    expect(diffPaths({ xs: [1, 2] }, { xs: [1, 2, 3] })).toEqual(["xs.2"]);
    expect(diffPaths({ a: 1 }, { a: 1, b: 2 })).toEqual(["b"]);
  });
});

describe("the exact delta contract", () => {
  const before = { keep: 1, drop: "gone", xs: ["a", "b", "c"] };
  const after = { keep: 1, xs: ["a"], added: true };

  it("reconstructs the current document from the audited one plus the listed changes", () => {
    const deltas: IntendedDelta[] = [
      { path: "drop", before: "gone", afterMissing: true },
      { path: "xs.1", before: "b", afterMissing: true },
      { path: "xs.2", before: "c", afterMissing: true },
      { path: "added", beforeMissing: true, after: true },
    ];
    expect(() => assertExactDeltaContract(before, after, deltas)).not.toThrow();
  });

  it("refuses a differing leaf nobody listed, and names it", () => {
    const deltas: IntendedDelta[] = [
      { path: "drop", before: "gone", afterMissing: true },
      { path: "xs.1", before: "b", afterMissing: true },
      { path: "xs.2", before: "c", afterMissing: true },
    ];
    expect(() => assertExactDeltaContract(before, after, deltas)).toThrow(/differing but unlisted: added/);
  });

  it("refuses a listed leaf that no longer differs", () => {
    const deltas: IntendedDelta[] = [
      { path: "drop", before: "gone", afterMissing: true },
      { path: "xs.1", before: "b", afterMissing: true },
      { path: "xs.2", before: "c", afterMissing: true },
      { path: "added", beforeMissing: true, after: true },
      { path: "keep", before: 1, after: 2 },
    ];
    expect(() => assertExactDeltaContract(before, after, deltas)).toThrow(
      /listed but no longer differing: keep/,
    );
  });

  it("refuses a pinned value that does not match the document it claims to describe", () => {
    const wrongBefore: IntendedDelta[] = [
      { path: "drop", before: "something else", afterMissing: true },
      { path: "xs.1", before: "b", afterMissing: true },
      { path: "xs.2", before: "c", afterMissing: true },
      { path: "added", beforeMissing: true, after: true },
    ];
    expect(() => assertExactDeltaContract(before, after, wrongBefore)).toThrow(
      /unexpected audited value at drop/,
    );
    const wrongAfter: IntendedDelta[] = [
      { path: "drop", before: "gone", afterMissing: true },
      { path: "xs.1", before: "b", afterMissing: true },
      { path: "xs.2", before: "c", afterMissing: true },
      { path: "added", beforeMissing: true, after: false },
    ];
    expect(() => assertExactDeltaContract(before, after, wrongAfter)).toThrow(
      /unexpected current value at added/,
    );
  });

  it("refuses a leaf claimed absent that is present", () => {
    expect(() =>
      assertExactDeltaContract({ a: 1 }, { a: 2 }, [{ path: "a", beforeMissing: true, after: 2 }]),
    ).toThrow(/expected audited path to be absent: a/);
    expect(() =>
      assertExactDeltaContract({ a: 1 }, { a: 2 }, [{ path: "a", before: 1, afterMissing: true }]),
    ).toThrow(/expected current path to be absent: a/);
  });
});

describe("the delta file", () => {
  it("accepts a well-formed file and returns every delta in it", () => {
    const deltas = flattenDeltaFile(file([group([{ path: "a", before: 1, after: 2 }])]));
    expect(deltas).toEqual([{ path: "a", before: 1, after: 2 }]);
  });

  it("refuses a group with no reason, a placeholder reason, or no decision record", () => {
    const one: IntendedDelta[] = [{ path: "a", before: 1, after: 2 }];
    expect(() => flattenDeltaFile(file([group(one, { reason: "too short" })]))).toThrow(
      /needs a reason of at least/,
    );
    expect(() =>
      flattenDeltaFile(
        file([
          group(one, {
            reason: "TODO: work out why these leaves moved before the next release ships to anyone.",
          }),
        ]),
      ),
    ).toThrow(/placeholder reason/);
    expect(() => flattenDeltaFile(file([group(one, { decisions: [] })]))).toThrow(
      /names no decision record/,
    );
    expect(() => flattenDeltaFile(file([group(one, { decisions: ["whatever"] })]))).toThrow(
      /unknown decision whatever/,
    );
  });

  it("refuses a path listed in two groups, a duplicate group name, and an empty group", () => {
    const one: IntendedDelta[] = [{ path: "a", before: 1, after: 2 }];
    expect(() =>
      flattenDeltaFile(file([group(one, { name: "first" }), group(one, { name: "second" })])),
    ).toThrow(/a is listed twice: in first and in second/);
    expect(() =>
      flattenDeltaFile(file([group(one, { name: "same" }), group(one, { name: "same" })])),
    ).toThrow(/duplicate delta group same/);
    expect(() => flattenDeltaFile(file([group([])]))).toThrow(/lists no deltas/);
    expect(() => flattenDeltaFile(file([]))).toThrow(/lists no groups/);
  });

  it("refuses a delta that claims a value and absence at once", () => {
    const contradictory = [{ path: "a", before: 1, beforeMissing: true, after: 2 }] as unknown as IntendedDelta[];
    expect(() => flattenDeltaFile(file([group(contradictory)]))).toThrow(
      /exactly one of before \/ beforeMissing/,
    );
  });
});

describe("the manifest identity view", () => {
  it("names the entries that appeared, went away and changed, ignoring their positions", () => {
    const before = { gaps: [{ field: "a", reason: "x" }, { field: "b", reason: "y" }] };
    const after = { gaps: [{ field: "c", reason: "z" }, { field: "a", reason: "x2" }] };
    expect(computeManifestIdentity(before, after, ["gaps"])).toEqual({
      gaps: { added: ["c"], removed: ["b"], changed: ["a"] },
    });
  });

  it("refuses an array whose entries have no unique field to be keyed by", () => {
    expect(() => computeManifestIdentity({ gaps: [{ field: "a" }, { field: "a" }] }, { gaps: [] }, ["gaps"])).toThrow(
      /not an array of entries with a unique field/,
    );
  });
});

describe("the regenerator", () => {
  it("refreshes pinned values, drops leaves that stopped differing, and keeps each path in its group", async () => {
    const { regenerate } = await loadScript();
    const contract = await import("./helpers/auditDeltaContract");
    const existing = file([
      group([
        { path: "a", before: 1, after: 2 },
        { path: "stale", before: 1, after: 2 },
      ]),
    ]);
    const { file: rebuilt, added, dropped } = regenerate({
      baseline: { a: 1, stale: 1 },
      current: { a: 99, stale: 1 },
      existing,
      generatedAt: "2026-09-03",
      contract,
    });
    expect(added).toEqual([]);
    expect(dropped).toEqual(["stale"]);
    expect(rebuilt.groups).toHaveLength(1);
    expect(rebuilt.groups[0].deltas).toEqual([{ path: "a", before: 1, after: 99 }]);
    expect(rebuilt.groups[0].reason).toBe(existing.groups[0].reason);
    expect(rebuilt.generatedAt).toBe("2026-09-03");
  });

  it("will not classify a newly differing leaf on its own", async () => {
    const { regenerate } = await loadScript();
    const contract = await import("./helpers/auditDeltaContract");
    const existing = file([group([{ path: "a", before: 1, after: 2 }])]);
    expect(() =>
      regenerate({
        baseline: { a: 1, fresh: 1 },
        current: { a: 2, fresh: 7 },
        existing,
        generatedAt: "2026-09-03",
        contract,
      }),
    ).toThrow(/belong to no group; rerun with --group/);

    const { file: rebuilt, added } = regenerate({
      baseline: { a: 1, fresh: 1 },
      current: { a: 2, fresh: 7 },
      existing,
      targetGroup: "newly-seen",
      generatedAt: "2026-09-03",
      contract,
    });
    expect(added).toEqual(["fresh"]);
    const fresh = rebuilt.groups.find((entry) => entry.name === "newly-seen")!;
    expect(fresh.deltas).toEqual([{ path: "fresh", before: 1, after: 7 }]);
    // Left blank on purpose: a human writes it, and flattenDeltaFile refuses
    // the file until they do.
    expect(fresh.reason).toBe("");
    expect(fresh.decisions).toEqual([]);
    expect(() => flattenDeltaFile(rebuilt)).toThrow(/names no decision record/);
  });
});
