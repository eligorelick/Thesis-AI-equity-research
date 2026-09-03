/**
 * Lease and request timing constants shared by the config validator, the job
 * runner and the Anthropic provider.
 *
 * These live in their own module so `src/config/env.ts` can enforce the
 * relationships between them at startup without importing the server-only
 * provider or the job runner. Everything here is a plain number: no imports,
 * no side effects, safe to pull into any layer.
 *
 * The invariants the config enforces (DECISIONS D-08):
 *
 *  1. `THESIS_JOB_LEASE_SECONDS × 1000 ≥ 2 × JOB_HEARTBEAT_MS`. The runner
 *     renews the job claim once per heartbeat; a TTL shorter than two beats
 *     can expire between them, and another process would reconcile a healthy
 *     running job as abandoned.
 *  2. `THESIS_PAID_PASS_LEASE_SECONDS × 1000 ≥ 2 × paid renewal interval`.
 *     The paid renewal interval is TTL / PAID_LEASE_RENEWAL_DIVISOR, so this
 *     holds for any divisor ≥ 2; it is asserted rather than assumed so a
 *     future divisor change cannot silently break it.
 *  3. `THESIS_JOB_LEASE_SECONDS ≥ THESIS_PAID_PASS_LEASE_SECONDS`. A paid
 *     lease outliving its parent job claim would let the claim be reconciled
 *     while a provider call is still in flight and still billing.
 *  4. `THESIS_PAID_PASS_LEASE_SECONDS × 1000 > ANTHROPIC_REQUEST_TIMEOUT_MS +
 *     STREAM_IDLE_TIMEOUT_MARGIN_MS`. The lease must outlive the longest
 *     request the provider can hold open, plus the margin the idle-timeout
 *     abort needs to settle.
 */

/** Interval between durable job-claim heartbeats in the runner. */
export const JOB_HEARTBEAT_MS = 5 * 60 * 1000;

/** Paid-pass leases are renewed every TTL / this while a call is in flight. */
export const PAID_LEASE_RENEWAL_DIVISOR = 4;

/** Hard timeout for one provider HTTP request. */
export const ANTHROPIC_REQUEST_TIMEOUT_MS = 600_000;

/** Default idle gap that aborts a stalled stream (THESIS_STREAM_IDLE_SECONDS). */
export const DEFAULT_STREAM_IDLE_SECONDS = 120;

/**
 * Head-room the paid lease keeps beyond the request timeout so an aborted
 * stream can settle its reported usage before the lease expires.
 */
export const STREAM_IDLE_TIMEOUT_MARGIN_MS = 60_000;

/** Smallest paid-pass lease TTL that satisfies invariants 2 and 4, in seconds. */
export const MIN_PAID_PASS_LEASE_SECONDS = Math.ceil(
  (ANTHROPIC_REQUEST_TIMEOUT_MS + STREAM_IDLE_TIMEOUT_MARGIN_MS) / 1000,
);

/** Smallest job-claim lease TTL that satisfies invariant 1, in seconds. */
export const MIN_JOB_LEASE_SECONDS = (2 * JOB_HEARTBEAT_MS) / 1000;
