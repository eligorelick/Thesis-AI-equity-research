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
 * ANTHROPIC_API_KEY) and reads one thing from the paid account: the Cost
 * report (`GET /v1/organizations/cost_report`) for the window from the oldest
 * unreconciled presumption to tomorrow, in daily buckets, following the
 * report's own paging until the window is covered.
 *
 * The Cost API reports totals per time bucket, not per request, so the only
 * sound inference is an upper bound: within a bucket, presumed spend cannot
 * exceed the reported total less the settlements already recorded there. A
 * row is only ever lowered.
 *
 * Amounts arrive in the currency's LOWEST unit as decimal strings — cents for
 * USD, so `"123.45"` is $1.2345 — and are converted here; the reconciler
 * works in dollars (audit 2026-09-06, §5: the script read them as dollars and
 * targeted `cost_reports`, a path the API does not serve, so it had never
 * lowered a row).
 *
 * Nothing in the app calls this: reconciliation is an operator action, so no
 * report path ever makes an Admin API request.
 */

import { isEntryPoint } from "./lib/entrypoint.mjs";

export const COST_API_URL = "https://api.anthropic.com/v1/organizations/cost_report";
export const ANTHROPIC_VERSION = "2023-06-01";
/** Buckets per page: the API's maximum. */
export const COST_API_PAGE_LIMIT = 31;
/** Pages followed before giving up: 24 × 31 daily buckets, two years. */
export const COST_API_MAX_PAGES = 24;
/** Cost-report amounts are in the lowest currency unit (cents for USD). */
export const LOWEST_UNITS_PER_USD = 100;

/** Read one result's amount (lowest currency unit) as a finite number, else 0. */
function lowestUnitAmount(result) {
  const raw = result?.amount ?? result?.cost?.amount ?? 0;
  const amount = Number(raw);
  return Number.isFinite(amount) ? amount : 0;
}

/** Map one Cost API page to the bucket shape the reconciler consumes (USD). */
export function bucketsFromCostReport(page) {
  const buckets = [];
  for (const entry of page?.data ?? []) {
    const startTime = typeof entry.starting_at === "string" ? entry.starting_at : null;
    const endTime = typeof entry.ending_at === "string" ? entry.ending_at : null;
    if (startTime === null || endTime === null) continue;
    let reportedLowestUnits = 0;
    for (const result of entry.results ?? []) {
      reportedLowestUnits += lowestUnitAmount(result);
    }
    buckets.push({ startTime, endTime, reportedUsd: reportedLowestUnits / LOWEST_UNITS_PER_USD });
  }
  return buckets;
}

/**
 * Fetch every daily bucket in [startTime, endTime), following `next_page`
 * until `has_more` is false or the page cap is reached. Returns the buckets
 * oldest first, as the API serves them.
 */
export async function fetchCostReport(adminKey, startTime, endTime, fetchImpl = fetch) {
  const buckets = [];
  let page;
  for (let pages = 0; pages < COST_API_MAX_PAGES; pages++) {
    const url = new URL(COST_API_URL);
    url.searchParams.set("starting_at", startTime);
    url.searchParams.set("ending_at", endTime);
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", String(COST_API_PAGE_LIMIT));
    if (page !== undefined) url.searchParams.set("page", page);
    const response = await fetchImpl(url, {
      headers: { "x-api-key": adminKey, "anthropic-version": ANTHROPIC_VERSION },
    });
    if (!response.ok) {
      throw new Error(`${COST_API_URL} responded ${response.status}`);
    }
    const body = await response.json();
    buckets.push(...bucketsFromCostReport(body));
    if (body?.has_more !== true || typeof body?.next_page !== "string" || body.next_page.length === 0) {
      return buckets;
    }
    page = body.next_page;
  }
  throw new Error(
    `${COST_API_URL} still had more pages after ${COST_API_MAX_PAGES}; narrow the window`,
  );
}

async function main(argv) {
  const write = argv.includes("--write");
  // The validated config is the single reader of ANTHROPIC_ADMIN_KEY: it
  // trims, treats a blank value as absent, and fails loudly on a malformed
  // environment before any paid-account read is attempted.
  const { getConfig } = await import("../src/config/env.ts");
  const adminKey = getConfig().anthropicAdminKey;
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

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
