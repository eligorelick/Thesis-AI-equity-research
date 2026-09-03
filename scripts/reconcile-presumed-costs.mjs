/**
 * Reconcile presumed spend against Anthropic's reported totals.
 *
 *   npm run costs:reconcile            # show what would change
 *   npm run costs:reconcile -- --write # apply it
 *
 * A paid pass whose lease expired without settling is recorded at its full
 * reserved maximum (DECISIONS D-07). A late settlement replaces that
 * automatically; this script is the other route, for a process that never
 * came back. It needs ANTHROPIC_ADMIN_KEY (an Admin API key, distinct from
 * ANTHROPIC_API_KEY) and makes exactly one paid-account read: the Usage &
 * Cost API for the window covering the oldest unreconciled presumption.
 *
 * The Cost API reports totals per time bucket, not per request, so the only
 * sound inference is an upper bound: within a bucket, presumed spend cannot
 * exceed the reported total less the settlements already recorded there. A row
 * is only ever lowered.
 *
 * Nothing in the app calls this: reconciliation is an operator action, so no
 * report path ever makes an Admin API request.
 */

import { pathToFileURL } from "node:url";

export const COST_API_URL = "https://api.anthropic.com/v1/organizations/cost_reports";
export const ANTHROPIC_VERSION = "2023-06-01";

/** Map one Cost API page to the bucket shape the reconciler consumes. */
export function bucketsFromCostReport(page) {
  const buckets = [];
  for (const entry of page?.data ?? []) {
    const startTime = typeof entry.starting_at === "string" ? entry.starting_at : null;
    const endTime = typeof entry.ending_at === "string" ? entry.ending_at : null;
    if (startTime === null || endTime === null) continue;
    let reportedUsd = 0;
    for (const result of entry.results ?? []) {
      const amount = Number(result?.amount ?? result?.cost?.amount ?? 0);
      if (Number.isFinite(amount)) reportedUsd += amount;
    }
    buckets.push({ startTime, endTime, reportedUsd });
  }
  return buckets;
}

async function fetchCostReport(adminKey, startTime, endTime) {
  const url = new URL(COST_API_URL);
  url.searchParams.set("starting_at", startTime);
  url.searchParams.set("ending_at", endTime);
  url.searchParams.set("bucket_width", "1d");
  const response = await fetch(url, {
    headers: { "x-api-key": adminKey, "anthropic-version": ANTHROPIC_VERSION },
  });
  if (!response.ok) {
    throw new Error(`${COST_API_URL} responded ${response.status}`);
  }
  return bucketsFromCostReport(await response.json());
}

async function main(argv) {
  const write = argv.includes("--write");
  const adminKey = process.env.ANTHROPIC_ADMIN_KEY?.trim();
  const scheduler = await import("../src/pipeline/jobScheduler.ts");
  const presumed = scheduler.listPresumedCosts();
  if (presumed.length === 0) {
    console.log("costs:reconcile — no unreconciled presumed spend");
    return 0;
  }
  console.log(`costs:reconcile — ${presumed.length} unreconciled presumed row(s):`);
  for (const row of presumed) {
    console.log(`  ${row.createdAt} ${row.jobId} ${row.pass} ${row.model} $${row.costUsd.toFixed(6)}`);
  }
  if (!adminKey) {
    console.log("  ANTHROPIC_ADMIN_KEY is not set — nothing to compare against.");
    console.log("  Set it to read the Usage & Cost API, or leave these as the conservative maximum.");
    return 0;
  }
  const oldest = presumed[0].createdAt;
  const startTime = `${oldest.slice(0, 10)}T00:00:00Z`;
  const endTime = new Date(Date.now() + 86_400_000).toISOString();
  const buckets = await fetchCostReport(adminKey, startTime, endTime);
  console.log(`  read ${buckets.length} reported cost bucket(s) from ${startTime}`);
  if (!write) {
    console.log("  dry run — pass --write to apply the reconciliation");
    return 0;
  }
  const applied = scheduler.reconcilePresumedCostsAgainstReportedTotals(buckets);
  if (applied.length === 0) {
    console.log("  reported totals already cover the presumed rows; nothing lowered");
    return 0;
  }
  for (const change of applied) {
    console.log(`  ${change.jobId} ${change.pass}: $${change.fromUsd.toFixed(6)} -> $${change.toUsd.toFixed(6)}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
