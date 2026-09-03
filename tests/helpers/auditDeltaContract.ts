/**
 * The delta contract behind the Task 32 audited fixture comparison.
 *
 * The comparison proves one sentence: the projection this tree computes equals
 * the projection the audited commit computed, plus a list of changes somebody
 * wrote down on purpose. This module holds the machinery for that sentence, and
 * `tests/fixtures/audit-intended-deltas.json` holds the list.
 *
 * The list left the test file when the remediation made it long enough that
 * nobody would read it inline. Nothing about the guarantee changed: every
 * listed path still pins BOTH the audited value and the current one, the listed
 * set must equal the differing set exactly, and the audited projection plus the
 * listed changes must reconstruct the current projection byte for byte. Three
 * things were added:
 *
 *   - `afterMissing`, for a leaf the audited projection has and this one does
 *     not. Without it a change that removes a key or shortens an array cannot
 *     be expressed at all, only worked around.
 *   - groups. Every delta belongs to one, and every group states which decision
 *     record caused it and why in a sentence. A path cannot be blessed without
 *     a reason attached to it.
 *   - `manifestIdentity`, which pins the missing-data manifest by entry name
 *     rather than by array position: which gap entries appeared, which
 *     disappeared, which changed. Positional diffing reports an insertion as
 *     hundreds of shifted leaves, and a reviewer cannot see the five real
 *     changes inside that. This is checked in addition to, not instead of, the
 *     positional contract.
 *
 * `scripts/audit-deltas.mjs` regenerates the list. It refuses to invent a
 * reason: a path nobody has classified must be assigned to a named group by
 * whoever runs it.
 */

export type AuditJsonPrimitive = null | boolean | number | string;
export type AuditJsonValue =
  | AuditJsonPrimitive
  | AuditJsonValue[]
  | { [key: string]: AuditJsonValue };

/** One leaf that legitimately differs between the audited and current projections. */
export type IntendedDelta =
  | { path: string; before: AuditJsonValue; after: AuditJsonValue }
  | { path: string; beforeMissing: true; after: AuditJsonValue }
  | { path: string; before: AuditJsonValue; afterMissing: true };

export interface IntendedDeltaGroup {
  /** Stable slug, used by the regenerator to place newly differing paths. */
  name: string;
  /** Decision records that caused this group, e.g. ["D-11", "D-18"]. */
  decisions: string[];
  /** Why these leaves moved, in a sentence a reviewer can check. */
  reason: string;
  deltas: IntendedDelta[];
}

export interface ManifestIdentity {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface IntendedDeltaFile {
  againstBaseline: {
    auditedBaseCommit: string;
    /** SHA-256 of the canonical audited projection this list was written against. */
    projectionSha256: string;
  };
  generatedAt: string;
  /** Array paths whose entries carry a unique `field`, pinned by name below. */
  keyedArrays: string[];
  manifestIdentity: Record<string, ManifestIdentity>;
  groups: IntendedDeltaGroup[];
}

const DECISION_PATTERN = /^(D-\d{2}|WS[1-9]|pre-remediation)$/;
const MINIMUM_REASON_LENGTH = 60;

export function isRecord(value: AuditJsonValue): value is { [key: string]: AuditJsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Paths are dotted, and object keys in this projection can themselves contain
 * dots: the as-of map is keyed by source names like `edgar.cik`. A key's dots
 * and backslashes are therefore escaped, so `asOfMap.edgar\.cik` addresses the
 * one key and `asOfMap.edgar.cik` addresses a nested pair. Without this a
 * dotted key silently reads as absent, which is how it went unnoticed until a
 * new source name arrived.
 */
export function encodeSegment(key: string): string {
  return key.replaceAll("\\", "\\\\").replaceAll(".", "\\.");
}

export function splitPath(dottedPath: string): string[] {
  const segments: string[] = [];
  let current = "";
  for (let index = 0; index < dottedPath.length; index++) {
    const character = dottedPath[index];
    if (character === "\\" && index + 1 < dottedPath.length) {
      current += dottedPath[index + 1];
      index++;
      continue;
    }
    if (character === ".") {
      segments.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  segments.push(current);
  return segments;
}

export function canonicalJson(value: AuditJsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Every leaf path where the two documents disagree. Arrays are compared by
 * index, so an insertion reports every following element: that is deliberate,
 * because position is part of what a reader sees.
 */
export function diffPaths(
  before: AuditJsonValue,
  after: AuditJsonValue,
  prefix = "",
): string[] {
  if (Array.isArray(before) && Array.isArray(after)) {
    const paths: string[] = [];
    const sharedLength = Math.min(before.length, after.length);
    for (let index = 0; index < sharedLength; index++) {
      paths.push(...diffPaths(before[index], after[index], `${prefix}.${index}`));
    }
    for (let index = sharedLength; index < Math.max(before.length, after.length); index++) {
      paths.push(`${prefix}.${index}`);
    }
    return paths;
  }
  if (Array.isArray(before) || Array.isArray(after)) return [prefix];
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => {
      const encoded = encodeSegment(key);
      const child = prefix.length > 0 ? `${prefix}.${encoded}` : encoded;
      if (!(key in before) || !(key in after)) return [child];
      return diffPaths(before[key], after[key], child);
    });
  }
  return Object.is(before, after) ? [] : [prefix];
}

export function readJsonPath(
  root: AuditJsonValue,
  dottedPath: string,
): { exists: boolean; value: AuditJsonValue | undefined } {
  let cursor: AuditJsonValue = root;
  for (const key of splitPath(dottedPath)) {
    if (Array.isArray(cursor)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
        return { exists: false, value: undefined };
      }
      cursor = cursor[index];
      continue;
    }
    if (!isRecord(cursor) || !Object.hasOwn(cursor, key)) {
      return { exists: false, value: undefined };
    }
    cursor = cursor[key];
  }
  return { exists: true, value: cursor };
}

function parentOf(
  root: AuditJsonValue,
  keys: string[],
  dottedPath: string,
): AuditJsonValue {
  let cursor: AuditJsonValue = root;
  for (const key of keys) {
    if (Array.isArray(cursor)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
        throw new Error(`missing JSON path ${dottedPath}`);
      }
      cursor = cursor[index];
      continue;
    }
    if (!isRecord(cursor) || !(key in cursor)) {
      throw new Error(`missing JSON path ${dottedPath}`);
    }
    cursor = cursor[key];
  }
  return cursor;
}

export function setJsonPath(
  root: AuditJsonValue,
  dottedPath: string,
  value: AuditJsonValue,
): void {
  const keys = splitPath(dottedPath);
  const cursor = parentOf(root, keys.slice(0, -1), dottedPath);
  const finalKey = keys.at(-1)!;
  if (Array.isArray(cursor)) {
    const index = Number(finalKey);
    if (!Number.isInteger(index) || index < 0 || index > cursor.length) {
      throw new Error(`missing JSON path ${dottedPath}`);
    }
    if (index === cursor.length) cursor.push(value);
    else cursor[index] = value;
    return;
  }
  if (!isRecord(cursor)) throw new Error(`non-object JSON parent ${dottedPath}`);
  cursor[finalKey] = value;
}

/**
 * Remove a leaf. An array element may only be removed from the tail, which is
 * the only shape `diffPaths` can report: it compares the shared prefix and then
 * lists the surplus indices of the longer array.
 */
export function deleteJsonPath(root: AuditJsonValue, dottedPath: string): void {
  const keys = splitPath(dottedPath);
  const cursor = parentOf(root, keys.slice(0, -1), dottedPath);
  const finalKey = keys.at(-1)!;
  if (Array.isArray(cursor)) {
    const index = Number(finalKey);
    if (index !== cursor.length - 1) {
      throw new Error(
        `cannot remove ${dottedPath}: only the last element of an array may be removed`,
      );
    }
    cursor.pop();
    return;
  }
  if (!isRecord(cursor) || !(finalKey in cursor)) {
    throw new Error(`missing JSON path ${dottedPath}`);
  }
  delete cursor[finalKey];
}

/** Sort paths so numeric array indices order numerically, not lexically. */
export function comparePaths(left: string, right: string): number {
  const a = splitPath(left);
  const b = splitPath(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const x = a[index];
    const y = b[index];
    if (x === y) continue;
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isInteger(nx) && Number.isInteger(ny)) return nx - ny;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * Validate the file's shape and return every delta in it. Throws rather than
 * returning a verdict: a malformed contract must fail the suite, not soften it.
 */
export function flattenDeltaFile(file: IntendedDeltaFile): IntendedDelta[] {
  if (file.groups.length === 0) throw new Error("intended-delta file lists no groups");
  const seenNames = new Set<string>();
  const seenPaths = new Map<string, string>();
  const deltas: IntendedDelta[] = [];
  for (const group of file.groups) {
    if (seenNames.has(group.name)) throw new Error(`duplicate delta group ${group.name}`);
    seenNames.add(group.name);
    if (group.decisions.length === 0) {
      throw new Error(`delta group ${group.name} names no decision record`);
    }
    for (const decision of group.decisions) {
      if (!DECISION_PATTERN.test(decision)) {
        throw new Error(`delta group ${group.name} cites an unknown decision ${decision}`);
      }
    }
    if (group.reason.trim().length < MINIMUM_REASON_LENGTH) {
      throw new Error(
        `delta group ${group.name} needs a reason of at least ${MINIMUM_REASON_LENGTH} characters`,
      );
    }
    if (/\bTODO\b|\bTBD\b/i.test(group.reason)) {
      throw new Error(`delta group ${group.name} still carries a placeholder reason`);
    }
    if (group.deltas.length === 0) {
      throw new Error(`delta group ${group.name} lists no deltas; delete the group instead`);
    }
    for (const delta of group.deltas) {
      const previous = seenPaths.get(delta.path);
      if (previous !== undefined) {
        throw new Error(`${delta.path} is listed twice: in ${previous} and in ${group.name}`);
      }
      seenPaths.set(delta.path, group.name);
      const hasBefore = "before" in delta;
      const hasAfter = "after" in delta;
      if (hasBefore === ("beforeMissing" in delta)) {
        throw new Error(`${delta.path} must carry exactly one of before / beforeMissing`);
      }
      if (hasAfter === ("afterMissing" in delta)) {
        throw new Error(`${delta.path} must carry exactly one of after / afterMissing`);
      }
      deltas.push(delta);
    }
  }
  return deltas;
}

function describeSetDifference(actual: string[], expected: string[]): string {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const unlisted = actual.filter((path) => !expectedSet.has(path));
  const stale = expected.filter((path) => !actualSet.has(path));
  const sample = (paths: string[]): string =>
    paths.length <= 12 ? paths.join(", ") : `${paths.slice(0, 12).join(", ")} … and ${paths.length - 12} more`;
  const lines: string[] = [];
  if (unlisted.length > 0) {
    lines.push(`${unlisted.length} differing but unlisted: ${sample(unlisted)}`);
  }
  if (stale.length > 0) {
    lines.push(`${stale.length} listed but no longer differing: ${sample(stale)}`);
  }
  return lines.join("\n");
}

/**
 * The whole contract: the listed paths are exactly the differing paths, each
 * one pins both values, and the audited projection plus the list reconstructs
 * the current projection.
 */
export function assertExactDeltaContract(
  before: AuditJsonValue,
  after: AuditJsonValue,
  deltas: readonly IntendedDelta[],
): void {
  const actual = [...diffPaths(before, after)].sort(comparePaths);
  const expected = deltas.map((delta) => delta.path).sort(comparePaths);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`fixture delta contract mismatch\n${describeSetDifference(actual, expected)}`);
  }

  for (const delta of deltas) {
    const baselineValue = readJsonPath(before, delta.path);
    if ("beforeMissing" in delta) {
      if (baselineValue.exists) {
        throw new Error(`expected audited path to be absent: ${delta.path}`);
      }
    } else if (
      !baselineValue.exists ||
      canonicalJson(baselineValue.value!) !== canonicalJson(delta.before)
    ) {
      throw new Error(`unexpected audited value at ${delta.path}`);
    }
    const currentValue = readJsonPath(after, delta.path);
    if ("afterMissing" in delta) {
      if (currentValue.exists) {
        throw new Error(`expected current path to be absent: ${delta.path}`);
      }
    } else if (
      !currentValue.exists ||
      canonicalJson(currentValue.value!) !== canonicalJson(delta.after)
    ) {
      throw new Error(`unexpected current value at ${delta.path}`);
    }
  }

  // Writes first, in path order so a new array element lands after the one
  // before it; removals last, deepest index first, so an array shortens from
  // its tail.
  const reconstructed = structuredClone(before);
  const writes = deltas
    .filter((delta) => !("afterMissing" in delta))
    .sort((left, right) => comparePaths(left.path, right.path));
  for (const delta of writes) {
    setJsonPath(reconstructed, delta.path, (delta as { after: AuditJsonValue }).after);
  }
  const removals = deltas
    .filter((delta) => "afterMissing" in delta)
    .sort((left, right) => comparePaths(right.path, left.path));
  for (const delta of removals) {
    deleteJsonPath(reconstructed, delta.path);
  }
  if (canonicalJson(reconstructed) !== canonicalJson(after)) {
    throw new Error("current projection differs from audited baseline plus exact intended deltas");
  }
}

function entriesByField(
  value: AuditJsonValue | undefined,
): Map<string, AuditJsonValue> | null {
  if (!Array.isArray(value)) return null;
  const byField = new Map<string, AuditJsonValue>();
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.field !== "string") return null;
    if (byField.has(entry.field)) return null;
    byField.set(entry.field, entry);
  }
  return byField;
}

/**
 * The same two manifests compared by entry name instead of by position: which
 * gap entries appeared, which went away, which changed their text or sources.
 * This is what a reviewer actually reads; the positional contract above is what
 * proves nothing else moved.
 */
export function computeManifestIdentity(
  before: AuditJsonValue,
  after: AuditJsonValue,
  keyedArrays: readonly string[],
): Record<string, ManifestIdentity> {
  const identity: Record<string, ManifestIdentity> = {};
  for (const arrayPath of keyedArrays) {
    const beforeEntries = entriesByField(readJsonPath(before, arrayPath).value);
    const afterEntries = entriesByField(readJsonPath(after, arrayPath).value);
    if (beforeEntries === null || afterEntries === null) {
      throw new Error(`${arrayPath} is not an array of entries with a unique field`);
    }
    const added = [...afterEntries.keys()].filter((field) => !beforeEntries.has(field)).sort();
    const removed = [...beforeEntries.keys()].filter((field) => !afterEntries.has(field)).sort();
    const changed = [...afterEntries.keys()]
      .filter(
        (field) =>
          beforeEntries.has(field) &&
          canonicalJson(beforeEntries.get(field)!) !== canonicalJson(afterEntries.get(field)!),
      )
      .sort();
    identity[arrayPath] = { added, removed, changed };
  }
  return identity;
}
