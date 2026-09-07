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
 *  1. `THESIS_JOB_LEASE_SECONDS ≥ MIN_JOB_LEASE_SECONDS` (600 s, two beats of
 *     the legacy fixed heartbeat below). The runner does NOT renew on that
 *     heartbeat: it renews the job claim every TTL / JOB_LEASE_RENEWAL_DIVISOR,
 *     so a claim always has four beats of slack whatever the TTL, and the
 *     floor is in practice subsumed by invariants 3 and 4 (a job TTL is never
 *     shorter than a paid TTL, which is never shorter than the provider
 *     timeout). It is kept as the range floor the config has always applied.
 *  2. `THESIS_PAID_PASS_LEASE_SECONDS × 1000 ≥ 2 × paid renewal interval`.
 *     The paid renewal interval is TTL / PAID_LEASE_RENEWAL_DIVISOR, so this
 *     holds for any divisor ≥ 2; it is asserted rather than assumed so a
 *     future divisor change cannot silently break it.
 *  3. `THESIS_JOB_LEASE_SECONDS ≥ THESIS_PAID_PASS_LEASE_SECONDS`. A paid
 *     lease outliving its parent job claim would let the claim be reconciled
 *     while a provider call is still in flight and still billing.
 *  4. `THESIS_PAID_PASS_LEASE_SECONDS × 1000 > ANTHROPIC_REQUEST_TIMEOUT_MS +
 *     STREAM_IDLE_TIMEOUT_MARGIN_MS`. The lease must outlive the longest wait
 *     for response headers the provider can hold open, plus the margin the
 *     idle-timeout abort needs to settle. Every paid request streams, and for
 *     a stream the request timeout bounds only that wait: once the response
 *     has started, silence is bounded per event by the idle guard
 *     (THESIS_STREAM_IDLE_SECONDS, scaled by effort) and the lease is renewed
 *     every TTL / PAID_LEASE_RENEWAL_DIVISOR while the request is in flight
 *     (invariant 2), so a healthy generation may run far longer than the
 *     timeout without the lease ever lapsing.
 */

/**
 * Legacy fixed job-claim heartbeat. The runner no longer renews on this
 * cadence (see JOB_LEASE_RENEWAL_DIVISOR); it survives as the basis of
 * MIN_JOB_LEASE_SECONDS and as the time unit a few runner tests advance by.
 */
export const JOB_HEARTBEAT_MS = 5 * 60 * 1000;

/** The job claim is renewed every TTL / this while the runner owns the job. */
export const JOB_LEASE_RENEWAL_DIVISOR = 4;

/** Paid-pass leases are renewed every TTL / this while a call is in flight. */
export const PAID_LEASE_RENEWAL_DIVISOR = 4;

/** Hard timeout for one provider HTTP request. */
export const ANTHROPIC_REQUEST_TIMEOUT_MS = 600_000;

/**
 * Default idle gap that aborts a stalled stream (THESIS_STREAM_IDLE_SECONDS),
 * BEFORE the provider scales it by analysis effort.
 *
 * 300s, not 120s, because the app's guard must never fire before the transport
 * layer's own — which is the one that can actually tell a dead connection from
 * a thinking model. Anthropic keeps a long stream warm with SSE `ping` events,
 * and undici's ~300s idle body timeout sees them (they are bytes on the
 * socket), so a genuinely dead connection errors there and retries. The
 * Anthropic SDK, by contrast, DISCARDS pings before they reach a listener
 * (`core/streaming.js`: `if (sse.event === 'ping') continue;`), so the app's
 * guard is blind to exactly the signal that proves the request is alive.
 *
 * At 120s the guard therefore pre-empted a working detector with a broken one
 * and killed healthy paid passes: 2026-09-03, AMZN on claude-fable-5-1 at
 * effort max, abandoned mid-reasoning and settled at a presumed 127,995
 * output tokens. Sitting at or above undici's window leaves dead connections
 * to the layer that can see them, and leaves this guard as the backstop for
 * the case undici cannot catch — a socket kept warm by pings that never
 * produces anything.
 */
export const DEFAULT_STREAM_IDLE_SECONDS = 300;

/**
 * Outer bound on the effort-scaled idle limit: the deadline of the model stage
 * that owns the request. A guard that outlived its own stage would never fire.
 */
export const MODEL_STAGE_DEADLINE_MS = 45 * 60 * 1000;

/**
 * Head-room the paid lease keeps beyond the request timeout so an aborted
 * stream can settle its reported usage before the lease expires.
 */
export const STREAM_IDLE_TIMEOUT_MARGIN_MS = 60_000;

/** Smallest paid-pass lease TTL that satisfies invariants 2 and 4, in seconds. */
export const MIN_PAID_PASS_LEASE_SECONDS = Math.ceil(
  (ANTHROPIC_REQUEST_TIMEOUT_MS + STREAM_IDLE_TIMEOUT_MARGIN_MS) / 1000,
);

/** Smallest job-claim lease TTL the config accepts (invariant 1), in seconds. */
export const MIN_JOB_LEASE_SECONDS = (2 * JOB_HEARTBEAT_MS) / 1000;
