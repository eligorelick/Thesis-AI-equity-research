/**
 * Regenerate the audited fixture comparison's intended-delta list.
 *
 *   npm run audit:deltas                          # report what moved
 *   npm run audit:deltas -- --write --group <name>  # rewrite the list
 *
 * The list lives in `tests/fixtures/audit-intended-deltas.json` and is the
 * written record of every leaf where this tree's Stage B projection differs
 * from the audited commit's. Regenerating drops paths that no longer differ
 * and keeps every path whose pinned values are unchanged in its group. Two
 * kinds of path must be assigned to a named group with `--group`, whose reason
 * a human then has to write: a path nobody has classified, and a path already
 * classified whose `before`/`after` no longer match what was blessed — a value
 * that moved again is a new change, and the old reason does not describe it
 * (audit 2026-09-06, F199: the regenerator used to re-pin such a value under
 * the old reason without a word). The script cannot invent a reason, which is
 * the point: nothing gets blessed without somebody saying why.
 *
 * No network, no provider call: the projection is rebuilt from the checked-in
 * fixtures exactly as the test rebuilds it.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isEntryPoint } from "./lib/entrypoint.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, "..");
export const DELTA_PATH = path.join(ROOT, "tests", "fixtures", "audit-intended-deltas.json");
export const BASELINE_PATH = path.join(ROOT, "tests", "fixtures", "audit-baseline-stageb-report.json");

/** Stable hash of a projection, so a delta list cannot drift onto another baseline. */
export function projectionSha256(canonical) {
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Rebuild the delta file. Pure: every input is passed in, so the whole
 * classification rule is testable without running the projection.
 */
export function regenerate({ baseline, current, existing, targetGroup, generatedAt, contract }) {
  const { diffPaths, readJsonPath, comparePaths, canonicalJson, computeManifestIdentity } = contract;
  const differing = [...diffPaths(baseline, current)].sort(comparePaths);
  const differingSet = new Set(differing);

  const groupOfPath = new Map();
  for (const group of existing.groups) {
    for (const delta of group.deltas) groupOfPath.set(delta.path, group.name);
  }

  const deltaFor = (p) => {
    const before = readJsonPath(baseline, p);
    const after = readJsonPath(current, p);
    const delta = { path: p };
    if (before.exists) delta.before = before.value;
    else delta.beforeMissing = true;
    if (after.exists) delta.after = after.value;
    else delta.afterMissing = true;
    return delta;
  };
  const pinned = (delta) =>
    canonicalJson({
      before: delta.before,
      beforeMissing: delta.beforeMissing === true,
      after: delta.after,
      afterMissing: delta.afterMissing === true,
    });
  const existingDelta = new Map();
  for (const group of existing.groups) {
    for (const delta of group.deltas) existingDelta.set(delta.path, delta);
  }

  const unclassified = differing.filter((p) => !groupOfPath.has(p));
  const reclassified = differing.filter((p) => {
    const prior = existingDelta.get(p);
    return prior !== undefined && pinned(prior) !== pinned(deltaFor(p));
  });
  if (unclassified.length > 0 || reclassified.length > 0) {
    if (targetGroup === undefined) {
      const parts = [];
      if (unclassified.length > 0) parts.push(`${unclassified.length} newly differing path(s) belong to no group`);
      if (reclassified.length > 0) {
        parts.push(
          `${reclassified.length} already-classified path(s) moved since they were blessed, so their group's reason no longer describes them`,
        );
      }
      throw new Error(
        `${parts.join("; ")}; rerun with --group <name>.\n` +
          `First few: ${[...unclassified, ...reclassified].slice(0, 8).join(", ")}`,
      );
    }
    for (const p of unclassified) groupOfPath.set(p, targetGroup);
    for (const p of reclassified) groupOfPath.set(p, targetGroup);
  }

  const buckets = new Map();
  for (const group of existing.groups) buckets.set(group.name, []);
  if (targetGroup !== undefined && !buckets.has(targetGroup)) buckets.set(targetGroup, []);

  for (const p of differing) {
    buckets.get(groupOfPath.get(p)).push(deltaFor(p));
  }

  const knownGroups = new Map(existing.groups.map((group) => [group.name, group]));
  const groups = [];
  for (const [name, deltas] of buckets) {
    if (deltas.length === 0) continue;
    const known = knownGroups.get(name);
    groups.push({
      name,
      decisions: known?.decisions ?? [],
      reason: known?.reason ?? "",
      deltas: deltas.sort((left, right) => comparePaths(left.path, right.path)),
    });
  }

  const dropped = [];
  for (const group of existing.groups) {
    for (const delta of group.deltas) {
      if (!differingSet.has(delta.path)) dropped.push(delta.path);
    }
  }

  const file = {
    againstBaseline: {
      auditedBaseCommit: existing.againstBaseline.auditedBaseCommit,
      projectionSha256: projectionSha256(canonicalJson(baseline)),
    },
    generatedAt,
    keyedArrays: existing.keyedArrays,
    manifestIdentity: computeManifestIdentity(baseline, current, existing.keyedArrays),
    groups,
  };
  return { file, added: unclassified, reclassified, dropped };
}

function parseArgs(argv) {
  const groupIndex = argv.indexOf("--group");
  return {
    write: argv.includes("--write"),
    targetGroup: groupIndex >= 0 ? argv[groupIndex + 1] : undefined,
  };
}

async function main(argv) {
  const { write, targetGroup } = parseArgs(argv);
  const contract = await import("../tests/helpers/auditDeltaContract.ts");
  const { buildAuditFixtureComparison } = await import("../tests/helpers/auditFixtureComparison.ts");

  for (const key of ["FMP_API_KEY", "FINNHUB_API_KEY", "FRED_API_KEY", "ANTHROPIC_API_KEY", "EDGAR_CONTACT"]) {
    delete process.env[key];
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).projection;
  const existing = JSON.parse(readFileSync(DELTA_PATH, "utf8"));
  const { projection } = await buildAuditFixtureComparison({
    fmpFixtures: path.join(ROOT, "fixtures", "fmp"),
    reportFixture: path.join(ROOT, "fixtures", "report", "DEMO-sample.json"),
  });

  const { file, added, reclassified, dropped } = regenerate({
    baseline,
    current: projection,
    existing,
    targetGroup,
    generatedAt: new Date().toISOString().slice(0, 10),
    contract,
  });

  const total = file.groups.reduce((sum, group) => sum + group.deltas.length, 0);
  console.log(`audit:deltas — ${total} intended deltas across ${file.groups.length} groups`);
  for (const group of file.groups) {
    console.log(`  ${group.deltas.length.toString().padStart(4)}  ${group.name}`);
  }
  if (added.length > 0) console.log(`  newly classified into ${targetGroup}: ${added.length}`);
  if (reclassified.length > 0) console.log(`  moved since blessed, reclassified into ${targetGroup}: ${reclassified.length}`);
  if (dropped.length > 0) console.log(`  no longer differing, dropped: ${dropped.length}`);
  for (const group of file.groups) {
    if (group.reason.trim().length === 0) {
      console.log(`  ! group ${group.name} still needs a reason and its decision records`);
    }
  }

  if (!write) {
    console.log("(dry run; pass --write to rewrite the list)");
    return 0;
  }
  writeFileSync(DELTA_PATH, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  console.log(`audit:deltas — rewrote ${DELTA_PATH}`);
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
