# Audit Remediation Design

**Date:** 2026-08-07

**Audit:** `../Thesis-AI-equity-research-AUDIT_REPORT.md`

**Audited commit:** `524d09e81b00b08fe6af386011d34759a5e02fc0`

**Implementation branch:** `codex/audit-remediation`

## Goal

Correct every high, medium, and low finding in the independent audit without
weakening Thesis's deterministic financial analysis, missing-data policy,
source traceability, local-first security model, or saved-report compatibility.

## Scope and success criteria

The work covers H1-H6, M1-M13, and L1-L3. A finding is complete only when:

1. its root cause is removed at the earliest reliable boundary;
2. a regression test fails against the audited implementation and passes after
   the change;
3. adjacent consumers cannot silently recreate the old behavior;
4. legacy stored reports remain readable without mutating persisted JSON;
5. typecheck, lint, product tests, coverage, build, and dependency audit pass;
6. user-owned `AUDIT_PROMPT.md` remains untouched. Its pre-implementation
   SHA-256 is
   `745B73F268A1EA11A5AE6F14447B65C467CC4554EF68E371F189BB723554148C`.

The implementation may add narrowly focused shared helpers and durable schema
fields/tables. It must not rewrite the valuation engine, introduce live trading,
invent missing financial values, or add unsourced FX conversion.

## Design principles

### Preserve identity, unit, time, and snapshot together

Provider data is trustworthy only when its requested entity, unit, observation
date, endpoint, and fetch time are all proven. These attributes must travel with
the data rather than be reconstructed downstream.

### Fail closed for financially load-bearing inputs

Unknown is not zero. Incompatible currencies, missing cash-flow components,
invalid quarter windows, stale price endpoints, or unsupported instrument types
must suppress the affected calculation and create a typed gap.

### Make paid work durable before declaring progress

An LLM step becomes complete only after its output and cost are durably and
idempotently stored. Resume behavior is derived from durable artifacts, not
from optimistic step labels.

### Prefer incremental repairs over a report-model rewrite

The current schemas, `FetchResult`, `Sourced`, missing-data manifest, and
deterministic Stage B modules remain the architecture. Shared helpers enforce
invariants at seams without replacing proven calculations.

## Architecture

### 1. Provider and provenance boundary

#### H1: Entity-bound provider responses

- Add canonical entity comparators for provider symbols and padded CIKs.
- Pass the expected entity into every scoped FMP, EDGAR, and FINRA validator.
- Reject an entire response when rows conflict with the request or contain
  multiple entities. Do not silently filter a mixed response.
- Validate inside cache loaders before insertion and validate again after cache
  retrieval so a pre-fix or corrupted row cannot bypass the contract.
- FMP statement rows that legitimately omit `symbol` remain usable only when
  the endpoint contract has no returned identity field and the response was
  obtained under a freshly validated request scope. Any present identity must
  match.
- EDGAR submissions and company facts must match the requested ten-digit CIK;
  filing paths must be checked against the selected filing/accession owner.
- FINRA rows must match the normalized requested symbol and requested date
  partition before date selection or deduplication.

Regression coverage includes wrong-only, mixed-entity, cold-cache, poisoned
cache, case/punctuation normalization, wrong CIK, and unexpected FINRA date
partition cases.

#### H2: First-class source metadata and currency

- Add a required source manifest to `DataBundle`, populated directly from every
  successful `Sourced` envelope. Each entry contains provider, real endpoint,
  observation `asOf`, `fetchedAt`, and stale state.
- Keep fiscal/forecast `period` separate from observation `asOf`.
- Preserve each statement row's `reportedCurrency` when Stage C extracts cells.
- Register a monetary value only when its row currency is known and
  unambiguous. Do not substitute the profile/trading currency.
- Build the Sources appendix from the source manifest. Remove provider guessing,
  dot-path-as-endpoint behavior, and `fetchedAt = asOf` reconstruction.
- Preserve Finnhub's full observation date and FMP treasury attribution.
- The verifier may adopt an omitted model currency only from the exact,
  correctly sourced registry entry. A supplied conflicting currency fails
  verification.

ADR, mixed-currency, forecast-period, Finnhub-month, treasury-provider, and
source-envelope round-trip tests protect the behavior.

#### M4: Unit-safe XBRL fallback arithmetic

- Resolve every fallback component with value, exact period, unit, accession,
  and form lineage.
- Sum only when all components have identical units and compatible exact
  contexts. Incompatible or unproven lineage returns a not-checkable gap.
- Preserve component provenance in the derived fact.
- Retain Stage A's existing statement/XBRL currency comparison as defense in
  depth.

#### M5: Semantic EDGAR validation and cache admission

- Refine submissions schemas for accession, filing date, report date, safe
  primary-document basename, and equal parallel-array lengths.
- Move filing URL construction behind a provider operation that returns
  `FetchResult`; malformed values degrade instead of throwing through bundle
  construction.
- Reject blank or implausible HTTP-200 filing documents before both in-memory
  and SQLite cache insertion. Blank refreshes preserve last-good content.
- Mark only confirmed 6-K structural MD&A omissions `expected: true`; unexplained
  10-Q/10-K omissions remain actionable.

#### M6: Central safe reads for legacy reports

- Apply `sanitizeLegacyEntityConflicts` in `parseStoredReport` after strict or
  lenient schema parsing, using the symbol/version registry.
- Sanitize a clone, revalidate it under the applicable read mode, and leave the
  stored JSON immutable.
- Route the corrected-export CLI through the same safe-read function.
- Verify identical safe output through latest, saved, history, diff, API,
  Markdown, and print reads.

### 2. Deterministic finance boundary

#### H3: Unsupported instrument discriminator

- Introduce a pure `classifyInstrumentSupport` result with supported-company
  and unsupported-fund/ETF variants before Stage B company routing.
- The company surface shows an explicit unsupported/data-only explanation.
- The job boundary defensively terminates with a typed unsupported outcome
  before payload assembly, Anthropic calls, report persistence, or cost logging.
- No company DCF, multiples, grades, or narrative are generated for funds.

#### H4: One point-in-time DCF capital anchor

- Use the same newest complete whole balance row already selected for current
  net debt and point-in-time multiples when constructing DCF invested capital.
- Carry its date and annual/quarterly basis into DCF notes/provenance.
- Do not add averaging or a new methodology in this fix.

The wiring regression uses hand-derived capital and sales-to-capital values so
it cannot mirror the implementation.

#### H5: Null-preserving derived finance

- Add one `deriveFcf(operatingCashFlow, capitalExpenditure)` helper that returns
  null unless both inputs are finite.
- Runway uses only quarters with both OCF and capex. Missing capex creates a gap;
  it is never zero.
- Liquidity/runway requires both cash and short-term investments when the
  calculation claims to use their sum. Missing STI suppresses the combined
  result rather than becoming zero.
- Missing historical share trend suppresses EPS projections unless an explicit
  flat-share house assumption is separately selected and labeled. It is never
  described as historical 0% dilution.
- Chart FCF/conversion, WACC weights, DuPont margin, and volume preserve null;
  views render `n/a` or omit points.
- Stop converting missing EOD volume to zero before deterministic technical
  analysis.

#### M1: Currency-safe pre-revenue overlay

- Propagate validated statement currency into routing.
- Evaluate the USD 10 million rule only for USD statements.
- For non-USD, unknown, or mixed currency, skip the overlay and emit a specific
  currency gap. No spot or guessed FX conversion is introduced.
- A future FX feature must use a sourced period-average rate for the revenue
  flow and is outside this remediation.

#### M2: Valid historical TTM windows

- Extract the proven current-TTM quarter normalization/contiguity logic into a
  focused shared helper.
- Deduplicate a fiscal period by latest accepted/filing timestamp only when
  recency can be proven; otherwise reject the ambiguous period.
- Historical multiple windows require four contiguous quarters and scan until
  the configured number of valid observations is reached.
- Select enterprise value on or before the period end within a documented
  tolerance; never choose a future observation merely because it is closer.
- Disclose rejected windows and suppress percentiles below the minimum valid
  sample.

#### M3: Aligned price-relative strength

- Align security and benchmark to a common end date.
- Select target starts on or before each cutoff within seven calendar days;
  otherwise return null and a gap for that window.
- A stale/mismatched end invalidates the differential instead of merely adding
  a note.
- Null differentials cannot create flags or grading drivers.
- Label outputs price-relative strength because the current source lacks
  dividends; do not imply total-return comparison.

### 3. Snapshot, report, and user-surface boundary

#### H6: Coherent persisted reports

- Remove newly fetched chart injection from the persisted-report tab.
- Keep current charts in the separately labeled live-analysis surface with its
  own as-of information.
- The same report ID must render the same report tree on company and saved-run
  routes.
- Persisting historical chart inputs is intentionally avoided because it would
  require a broad report-schema migration without improving existing reports.

#### M10: Complete history transitions

- Model grade, score, target, and projection transitions as `changed`, `added`,
  `removed`, `became-available`, or `became-unavailable`.
- Allow nullable before/after values where transition semantics require them.
- Join projections by metric plus period over the union of keys, not array
  index.
- Include source and target report/spec versions and distinguish unchanged from
  not-comparable in the UI.

#### M11: Shared report-surface manifests

- Define shared manifests for grade-strip keys, score aspects/drivers/weights,
  projection values/provenance/disclosures/history, and executive evidence.
- Use them in live UI, Markdown, print, summary APIs, watchlist/home/history,
  and diff code.
- Diff score weights and driver unions explicitly, including added, removed,
  available/unavailable, value, and traced-provenance transitions.
- Render the optional balance-sheet grade everywhere other grade-strip cells
  appear.
- Derive data-only banner wording from `meta.dataCompleteness` and actual gap
  counts; never claim completeness solely because `analysis.llm` is missing.
- Add unique-sentinel parity tests so omission of any schema leaf is visible.

#### M13: Last-intent settings persistence

- The client maintains one in-flight full-settings write, coalesces subsequent
  choices, and sends the latest desired state only after the prior write
  settles. This guarantees final request order instead of merely hiding stale
  responses.
- The server validates and writes the complete settings object transactionally.
- Only the response for the current desired state may display “saved.” Errors
  re-fetch authoritative state before retry/continued editing.

#### L1: Context-safe Markdown

- Introduce explicit serializers for prose, headings, lists, tables,
  blockquotes, links/source labels, and code spans.
- Neutralize raw HTML and Markdown structure characters according to context.
- Continue serving as an attachment and add `X-Content-Type-Options: nosniff`.
- Poison-string tests cover raw HTML, headings, links/images, backticks,
  multiline text, pipes, and source/provider strings in every interpolation
  context.

### 4. Paid-job durability, scheduling, and streaming

#### M7: Durable pass artifacts and authoritative resume state

- Add a `job_pass_artifacts` table keyed by job, run generation, attempt ID, and
  pass. It stores validated output/failure, full usage/cost data, and settlement
  timestamp with a uniqueness constraint for exact-once accounting.
- Persist each bull/bear settlement and its cost in one transaction from a
  per-side callback; do not wait for the sibling aggregate.
- Add a monotonically increasing run generation. Late callbacks from canceled
  or superseded attempts may record only their own immutable artifact and may
  not mutate current steps or emit current-run events.
- Persist a schema-valid judge artifact before verification.
- A step is marked done only after its artifact is durable. Report persistence
  and `reportId` determine completed synthesis/report state.
- Compute one `resumable` field server-side from durable compatible artifacts
  and report existence. The UI consumes it without duplicating state logic.
- Existing `bullJson`/`bearJson` columns remain readable during migration and
  are converted or used as a compatibility fallback.

#### M9: Durable global scheduler and spend backpressure

- Extend job state with queue/lease metadata: queued time, lease owner,
  lease expiry, heartbeat, run generation, and optional not-before time.
- Claim jobs atomically in SQLite under a configurable global active-job and
  active-LLM limit. Default limits remain conservative for a local workstation.
- Acquire a distinct durable paid-pass lease for each bull, bear, synthesize,
  and verify launch. Bull and bear never share one permit. Renew each lease
  while its provider call is active, fence renewal/settlement by exact
  generation/attempt/pass/owner identity, and abort the call if renewal fails.
  The provider hard timeout remains shorter than the lease TTL.
- Recover expired leases, dispatch the next queued job after completion, and
  allow queued cancellation without starting provider or LLM work.
- Reserve each pass's conservative maximum cost in the same SQLite transaction
  that checks global LLM capacity, per-job settled-plus-reserved spend, and
  rolling-window settled-plus-reserved spend. Settle actual cost and delete the
  reservation atomically with its durable artifact; release an unbilled
  reservation on every pre-call/failure exit. This prevents parallel bull/bear
  launches from independently passing a near-cap check.
- Add optional per-job and rolling-window spend caps that fail before launching
  a pass whose tested hard maximum would exceed either cap.
- Keep provider token buckets as a lower-level rate guard.

#### L3: Race-free SSE handshake and cleanup

- Add a monotonic persisted job revision to snapshots and emitted events.
- Subscribe before reading/replaying the snapshot, then ignore duplicate or
  older revisions.
- Check `request.signal.aborted` before registering resources.
- Use one idempotent cleanup path for abort, stream `cancel()`, terminal event,
  enqueue failure, heartbeat cleanup, and unsubscribe.

### 5. Request-wide local security

#### M8: Host, Fetch Metadata, and heavy-load protection

- Add a request-wide `proxy.ts` guard that unconditionally accepts only
  loopback hosts or the exact configured `THESIS_ALLOWED_HOST`.
- Retain route-level `assertSameOrigin` for mutations; security-sensitive
  authorization never depends solely on proxy behavior.
- For heavy company loads, allow top-level navigation and headerless local
  clients but reject cross-site embed/subresource Fetch Metadata combinations
  before providers or the database are touched.
- Add process-wide same-symbol singleflight and short negative caching for
  unknown symbols. Global job/bundle limits provide broader backpressure.

### 6. Dependencies and enforceable quality gates

#### L2: Patched dependency graph

- Upgrade Next and `eslint-config-next` together to 16.3.0, PostCSS to 8.5.26,
  and resolve Next's optional Sharp dependency to 0.35.3 through the supported
  dependency graph.
- Refresh transitive brace-expansion to patched 1.1.18/5.0.9 lines and js-yaml
  to at least 4.3.1 through owning packages when possible. Use a narrow override
  only if the owning dependency cannot resolve its compatible patched version.
- Recreate the locked install with `npm ci`, inspect `npm ls`, and require
  `npm audit` to report zero known vulnerabilities. Do not accept a direct
  package bump if the installed transitive tree remains vulnerable.

#### M12: CI, coverage, and deterministic test pools

- Add checked-in GitHub Actions CI on supported Node 20 with clean install,
  typecheck, lint, product tests, risk-based coverage, production build, and
  audit.
- Make `npm run verify` execute the same required gates, including coverage.
- Keep explicit typecheck as a required predecessor even if Next build remains
  configured to avoid duplicate checking.
- Expand coverage first to entity/provenance providers, Stage A/C, job
  durability, report query/diff/export, settings, and API/security routes.
- Separate native database CLI integration tests into a single-worker pool with
  an evidence-based timeout rather than relying on load-sensitive defaults.
- Restore per-file module isolation in product and risk pools. The audited
  baseline's `isolate:false` lets hoisted route mocks leak through the shared
  module registry and produces order-dependent `jobRunner` results; the isolated
  single-worker baseline passes all 1,461 product assertions.
- Update the release-contract test to inspect tracked release contents without
  failing on unrelated user-owned untracked files, and explicitly allow/require
  the CI workflow and remediation documentation.

## Schema and compatibility strategy

- SQLite bootstrap DDL and Drizzle schema change together.
- New columns are added idempotently for existing databases; new tables use
  `CREATE TABLE IF NOT EXISTS` plus indexes/unique constraints.
- Existing reports remain immutable and readable through central sanitation.
- Existing jobs with legacy analyst snapshots remain resumable when their
  payload fingerprint matches; new attempts write artifact rows.
- Global LLM concurrency and spend reservations are represented together by
  durable, expiring `job_llm_leases` rows keyed to one generation/attempt/pass.
  Permit acquisition prunes expired rows, counts live rows, and sums settled
  plus reserved spend in the same SQLite transaction, so separate application
  processes obey one concurrency and budget decision. Lease renewal preserves
  the reservation during long calls; settlement writes the artifact/cost and
  removes the lease atomically.
- Report JSON changes remain additive/optional where legacy reads require it.
  Current-save validation remains strict.

## Test strategy

Every production behavior follows red-green-refactor:

1. Write one minimal behavior test with independently derived expected values.
2. Run it and confirm the audited implementation fails for the intended reason.
3. Apply one root-cause fix.
4. Run the focused test and its subsystem suite.
5. Run mutation checks for wrong entity, unit, date, branch, missing/null input,
   stale attempt, and omitted surface.

Cross-layer tests will cover provider-to-cache identity, bundle-to-Stage-C
provenance, route-to-job unsupported instruments, pass-to-database durability,
stored-report parity, request guards before side effects, and UI/export field
parity.

## Final verification contract

Completion requires fresh evidence from:

- `npm ci`
- `npm run typecheck`
- `npm run lint`
- focused tests for every finding
- default-concurrency product suite
- single-worker product suite
- isolated database integration suite
- expanded `npm run test:coverage`
- `npm run build`
- `npm audit`
- `npm ls next postcss sharp brace-expansion js-yaml`
- repository status review plus a SHA-256 comparison against the recorded
  pre-implementation `AUDIT_PROMPT.md` baseline
- a finding-by-finding audit matrix mapping H1-H6, M1-M13, and L1-L3 to code
  and passing tests

## External research basis

- SEC EDGAR APIs scope submissions and company facts by ten-digit CIK and keep
  XBRL facts separated by unit.
- XBRL calculation requirements require matching contexts and units for valid
  summation relationships.
- Current valuation guidance favors the most recent coherent information and
  constructs trailing results from the latest four quarters.
- Current official advisories identify patched floors for Next.js, PostCSS,
  Sharp, brace-expansion, and js-yaml; the installed dependency tree, not the
  manifest alone, is the acceptance evidence.
