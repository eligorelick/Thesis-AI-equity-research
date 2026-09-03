# Remediation report

What the 2026-09-02 audit asked for, what was built, and what was not. Every
claim here is checkable against a commit; where a criterion was not met the
reason is stated rather than the criterion quietly dropped.

Read alongside:

- [`README-RECONCILIATION.md`](README-RECONCILIATION.md) — the 60 README claims
  the work started from, each with file-and-line evidence and a verdict.
- [`DECISIONS.md`](DECISIONS.md) — D-01 to D-23, the options considered and why
  each was chosen.
- [`PROGRESS.md`](PROGRESS.md) — the state of the work as it ran.

## How the work was done

**Phase 0 established what the code does before trusting either the README or
the audit.** Sixty README claims were checked against the code. Forty were true,
eleven needed verification in code that the audit had not done, and seven
discrepancies turned up that the audit had missed, including a flat cache-read
multiplier applied to every model, a reference table of cache TTLs that nothing
read, and a Node 24 requirement justified by native type stripping that the
harness does not actually use.

**Nine workstreams.** Three that touch the money-and-safety layer ran in series
on `main` because they share the scheduler and the provider: the model registry,
presumed spend under failure, and per-request cost admission. Six independent
ones ran in parallel on isolated worktrees with declared file ownership: the
data layer, sector routing, valuation inputs, the AI pipeline, security and
privacy, and the documentation. Each branch merged only with the full gate
green.

**Every workstream was then reviewed by a reader with no history with it.** The
reviewer saw the diff, the acceptance criteria and a fixed checklist, and was
told to judge only what the diff showed. That step changed the outcome
materially: it found two blockers in the money layer, two in sector routing and
two in valuation, none of which the implementing agent had noticed. The findings
and their repairs are recorded per workstream below.

**The gate** is `npm run verify`: dependency shape, typecheck, lint, the product
suite, the database CLI suite, both coverage contracts, a production build and
the security audit. The product suite is offline whatever `.env` contains, and
no paid or live provider call was made at any point in this work.

## Status by workstream

<!-- Filled in as each workstream's repairs land. -->

## What was deferred, and why

<!-- Filled in at the end. -->

## Open questions for the owner

1. Measured end-to-end cost figures require a live paid run. Until one is
   authorised the cost table is a calculation from the registry's published
   rates, labelled as one, beside the single measured run of 2026-09-01.
2. Recording the real SEC payloads for the successor registrant (CIK 2115436)
   requires a live EDGAR fetch. Until then that fixture is hand-built from the
   documented response shape and marked synthetic.
3. `auto` still prefers Opus 5 and the default effort is still `high`. Changing
   either is an owner decision, not a remediation.
