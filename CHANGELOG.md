# Changelog

## Unreleased — full codebase audit of 2026-09-06

Every source file, test and document was read against the others; 232
findings from independent reviewers were verified one by one, and the slices
no reviewer reached were audited directly. The record is
[`docs/superpowers/audits/2026-09-06-full-codebase-audit.md`](docs/superpowers/audits/2026-09-06-full-codebase-audit.md);
the conventions it changed are D-24 to D-27 in
[`docs/audit/DECISIONS.md`](docs/audit/DECISIONS.md). What follows is what a
reader of the previous release notices.

### You may need to act

- **`npm run costs:reconcile` now works.** It targeted a Cost API path that
  does not exist and read amounts in cents as dollars, so it had never lowered
  a presumed row. If you carry presumed spend from an earlier crash, run it
  again with `ANTHROPIC_ADMIN_KEY` set.
- **`.env.example` gained `NEXT_TELEMETRY_DISABLED=1`.** The Next.js CLI that
  `npm run dev` and `npm run build` invoke sends anonymous usage telemetry
  unless opted out; the app itself still sends nothing. Copy the line into an
  existing `.env`, or run `npx next telemetry disable` once for the machine.
- **`npm run audit:deltas -- --write` now needs `--group` for a leaf that
  moved again**, not only for a new one: a value that changed since it was
  blessed is a new change and the old reason does not describe it.
- **`AGENTS.md` and `CLAUDE.md` are gitignored.** `next dev` regenerates them
  and the release allowlist forbids tracking them.
- **Every run's report changes shape slightly.** New disclosures print on the
  page (the stored disclaimer beside the grades; the ROIC lease basis; the
  WACC's debt and coverage basis; the grid's held excess; the news-section
  truncation note; N beside every own-history rank as "rank X/100 of N
  quarters"), one score band moved (a partially evidenced Piotroski signal
  now enters the quality aspect at the weight its evidence supports), and the
  audited-fixture comparison carries dated groups for every leaf that moved.

### Fixed — money and the provider

- A mid-stream connection failure surfaced as a bare SDK error that the retry
  classifier rejected, so the pass rejected instead of retrying; a signal
  abort during a retry backoff could hang the analyst orchestration forever;
  a `pause_turn` resumption ran without the idle guard on a hard 600 s client
  timeout; a fallback-served message was priced at the serving model's rate
  for every token; the reported `max_tokens` was the pass constant rather
  than the limit sent. All repaired, each with a test.
- A deliberately aborted stream settled at the `message_start` snapshot as an
  `actual` row; it now settles what was reported plus the presumed remainder,
  flagged presumed, like a dead stream.
- The scheduler: presumed rows are stamped with the lease's own acquisition
  time (an overnight sweep zeroed real spend against the wrong day); a late
  settlement on an expired, unswept lease is accepted; `settleRequestCost`
  versions the snapshot so the SSE stream delivers the change; an
  over-reservation records the measured cost before raising; the reconciler
  counts already-reconciled presumptions as accounted; bucket bounds are
  normalised.
- The runner: the presumed-spend disclosure and discarded-attempt marking
  read every generation; a Stage B exception is filed as a critical
  `pipeline.compute` gap instead of vanishing; the admission lease is dropped
  only after the durable write commits; the verify checkpoint's admission is
  registered.

### Fixed — the analysis

- Stage B: the three fundamentals-dependent bases now agree — invested
  capital, the WACC's debt leg and the enterprise-value bridge remove the
  same operating-lease slice; interest expense and EBIT come from one
  statement basis; one Blume constant serves the WACC and the keyless beta.
  Every DCF re-run (bull, base, bear, the projection fan) bridges on the
  bridge the base case used, and the sensitivity grid holds the terminal
  excess rather than the terminal level. The EBIT-margin ceiling never binds
  below a margin the issuer has earned. Graded signals carry an evidence
  fraction. Restatement double-rows collapse in the returns and capital
  series. The REIT cap rate uses the house enterprise value; the own-history
  P/FFO band is withheld when the current FFO is a different construction.
- Stage C: the judge is no longer told it may search the web; the
  named-individual rule admits the payload's own executive and insider rows
  and states both sides of the rule; the per-claim case cap is measured on
  the serialised text and tightened from the originals; a truncation never
  overruns its budget and the news section discloses clipped rows; the
  data-only report prints FRED units and scales, net segment shares, an exact
  coverage figure and "placeholder" wherever a letter is not a grade; the
  consistency checks read the id's final segment, admit bare magnitude
  words, and skip capitalised direction words inside proper nouns; a job
  cancel no longer relabels both analyst sides as sibling-abandoned.
- EDGAR: `Revenues` precedes the ASC-606 elements in every chain; Form 40-F
  is a core form; a split re-tag is measured from the previous one; the
  successor's own-history test is an annual core-form fact.
- Providers and cache: an object body on an array endpoint is refused before
  admission; the plan-limit gate records only a limit the vendor answered in
  full; the keyless quote's previous close comes from the chart's own
  penultimate bar; HOUST and TOTALSA name their annual-rate basis; response
  bodies are capped at 64 MiB and never re-downloaded on retry; concurrent
  cache misses share one fetch.
- Found by the one paid run made after the audit (AAPL on Haiku at low
  effort, $0.60): the WACC row printed the Blume weights as raw floats, and
  the named-individual manifest sentence described the rule before the audit
  widened it. Both fixed.

### Fixed — the app

The in-app report prints the stored disclaimer; share-count bars start at
zero; the projection fan's bridge row shows only the historical value; the
page refreshes when a job completes; the own-history label matches the
exports; the sidebar's remove control is no longer nested in the link; the
report tabs have tab semantics and arrow-key switching; the returns panel
shows the module's spread or "n/a" rather than a fabricated one; the
home and settings banners say what a keyless run actually serves.

### Tooling and tests

Every script's "am I the entry point?" test resolves symlinks, so a release
gate cannot silently no-op on a linked checkout. The live-smoke opt-in
narrows the offline guard to `sec.gov` only. Six risk-bearing modules joined
the per-file coverage contract and a walk of src/ fails the build when a
module is in neither contract. The runner's analyst admission is asserted on
the real pass runner. The audited-fixture helper's label and hash are
corrected.

### Documentation

README, METHODOLOGY, RESEARCH, PRIVACY, DECISIONS (Revised notes on D-09,
D-20, D-22), the remediation report and the pricing generator were corrected
where they had drifted; 130+ code comments and twenty user-visible strings
that cited section numbers of retired design documents now cite a living
heading or none. Retired audit records and notes were removed; the 2026-09-06
audit document is the record that supersedes them.

## Unreleased — per-request admission restored, effort-aware idle guard

Found by a live run on 2026-09-03: AMZN on `claude-fable-5-1` at effort `max`.
The bull pass reported five output tokens, went quiet while the model reasoned,
was abandoned by the 120-second idle guard, and settled at $6.86 — of which
$6.40 was a presumed remainder of 127,995 output tokens the run has no evidence
were ever generated. The job produced no report. Three defects, one chain:

- **Per-request cost admission was silently off for both analyst passes.**
  `runBullThenBear` built each request's arguments BEFORE the `beforePass` hook
  the runner registers that pass's admission in, so the arguments captured
  `undefined`. Every provider request in the streaming path — the production
  path — therefore ran outside the per-request reserve/settle machinery
  introduced with `THESIS_RESERVATION_MODE=request`. The mocked pipeline tests
  called the hook in the right order, so nothing caught it. The judge pass was
  never affected. Arguments are now built after the hook, as the non-streaming
  fallback always did.
- **A presumed cost was recorded as an actual one.** With no per-request
  admission, `settleIdleRequest` returned early and the pass settlement wrote
  the figure with `settlementKind: "actual"`, which `npm run costs:reconcile`
  will not lower. Restoring admission restores the `presumed` marking the
  reconciler needs.
- **The stream idle guard was blind to the signal that proves a request is
  alive.** Anthropic keeps a long stream warm with SSE `ping` events, and the
  Anthropic SDK discards them before any listener runs
  (`core/streaming.js`: `if (sse.event === 'ping') continue;`) — while undici's
  ~300-second idle body timeout counts them as socket traffic and does not. The
  guard also cannot see that the model is working: Thesis never asks for
  thinking summaries, so reasoning produces no stream events on any model. At a
  flat 120 seconds it therefore pre-empted a working detector with a blind one
  and killed healthy paid passes mid-reasoning.

  `THESIS_STREAM_IDLE_SECONDS` now defaults to **300** — at undici's window, so
  a dead connection is caught by the layer that can see pings and retried,
  leaving this guard as the backstop for a socket kept warm by pings that never
  produces anything. Effort scales the base (×1 low/medium, ×2 high, ×3 xhigh,
  ×4 max), bounded by the model stage deadline rather than by
  `ANTHROPIC_REQUEST_TIMEOUT_MS`: that timeout is armed around the fetch, which
  for a streaming request resolves when the response headers arrive, so it
  bounds how long the provider may take to answer and not how long the stream
  may run. Zero still disables the guard. At the settings that produced the
  loss — Fable 5.1 at effort `max` — the limit is now 20 minutes of application
  silence rather than two.

- **A doomed run kept paying for its second analyst pass.** Once one side fails
  unrepairably the runner's `recoverable` test is false and the job degrades to
  a data-only report whatever the sibling does — but `runBullThenBear` awaited
  both sides regardless. On 2026-09-03 bull was abandoned at 19:05:00 and bear
  billed on until the user cancelled it by hand at 19:13:12: eight minutes of
  paid output for a report that could no longer be written. A side that ends the
  run now stops its sibling at once — the sibling is not launched at all if it
  had not started, and is aborted mid-stream if it had, settling only what it
  actually billed. A schema-invalid output is still repairable, so it never
  stops the sibling. The provider now flags a caller abort (`error.aborted`) so
  a pass we stopped on purpose is reported as abandoned rather than as a
  provider fault, and a side that failed on its own in the same instant keeps
  its own message.

The README cost table also published one estimate for all five effort levels
while the ceiling a pass bills against doubles at `high`. It now carries an
**analyst output ceiling** column showing that step per model (Fable 5.1:
$3.20 → $6.40), and says plainly that the estimated run is measured at effort
`high` and does not scale above it.

## Unreleased — 2026-09-02 audit remediation

The 2026-09-02 README audit found stale documentation, unusable spend caps, gaps
in the keyless data path, valuation conventions that were not disclosed as
conventions, an AI judge with a fixed reading order, and no statement of what
leaves the machine. This release is the remediation. Nine workstreams, each
reviewed afterwards by a reader with no history with it;
[`docs/audit/REMEDIATION-REPORT.md`](docs/audit/REMEDIATION-REPORT.md) walks
every acceptance criterion and
[`docs/audit/DECISIONS.md`](docs/audit/DECISIONS.md) records why each choice was
made.

The remediation ran from 2026-09-02 to 2026-09-03 and closed with a live
measurement: one paid Opus 5 run, whose findings are in this changelog.

### You may need to act

- **`ANALYSIS_MODEL` no longer accepts a dated snapshot** for any model but
  Haiku 4.5. From Claude 4.6 onward the dateless id *is* the pinned snapshot, so
  `claude-opus-5-20260115` never existed; it is now rejected at model resolution
  with the id to use instead, and the run degrades to a data-only report rather
  than failing silently. Set `ANALYSIS_MODEL=claude-opus-5`.
- **Spend caps changed meaning, in your favour.** A reservation is now one
  provider request's maximum rather than a whole pass's worst case, so
  `THESIS_MAX_JOB_COST_USD` can sit near real spend — a few dollars — where
  before any workable value rejected every job. `THESIS_RESERVATION_MODE=pass`
  restores the old behaviour for one release.
- **Lease minimums are enforced at startup.** `THESIS_PAID_PASS_LEASE_SECONDS`
  must exceed 660 (the 600-second provider timeout plus the margin an abandoned
  stream needs) and must not exceed `THESIS_JOB_LEASE_SECONDS`. A process whose
  configuration violates either refuses to start rather than losing a healthy
  job mid-run. The defaults, 900 and 900, satisfy both.
- **Scripts and non-browser clients need a token.** State-changing routes reject
  a request carrying neither browser Fetch Metadata nor a matching `Origin`.
  Browsers are unaffected; curl must send `X-Thesis-Token` with the contents of
  the `csrf-token` file the server writes at startup and names on stdout.
- **`DEMO` and `DBNK` are reserved.** They are served from fixtures whatever
  keys are configured, and reach no provider at all. Previously a configured FMP
  key sent them to the vendor as ordinary symbols.
- **`THESIS_JUDGE_ORDER=both` reserves twice as much in pass mode.** It issues a
  second, mirrored judge request per attempt, and only the default
  `THESIS_RESERVATION_MODE=request` admits and settles each one on its own. In
  pass mode the judge reservation now doubles to cover both, because nothing
  admits them separately — a `THESIS_MAX_JOB_COST_USD` sized against the old
  single-order bound will reject those jobs. The default mode is unaffected.
- **Node 22.18 is the floor** (`engines.node`). CI tests Node 24.

### Added

- `config/models.json`: a checked-in model registry — ids, prices, context and
  output limits, effort support, thinking rules, the web-search tool variant and
  the judge floor — that drives request shaping, pricing, the allow-list and
  `auto`. `npm run models:refresh` diffs it against the published list without
  sending a model request.
- Presumed spend: a paid reservation whose lease expires without settling is
  recorded at its reserved maximum rather than vanishing, and lowered only by
  evidence — a late settlement, or `npm run costs:reconcile` against the Usage
  and Cost API. It reaches the report and the missing-data manifest.
- `THESIS_STATEMENT_SOURCE`, backfilling statement history from SEC EDGAR when
  an FMP plan truncates it, with per-period provenance.
- Successor registrants reach their predecessor's history: the 8-K12B says the
  registrant is a successor, and the predecessor is found in the co-registrant
  list of the filings the two entities made jointly. Multi-class share counts
  are summed; public float carries its own measurement date; restatements are
  flagged against the value they replaced.
- Sector routing reads XBRL tag evidence, not only the SIC code and industry
  label. Financial routes withhold the models whose assumptions they break and
  value the company on excess returns to equity instead.
- `THESIS_JUDGE_ORDER`: the judge's reading order is drawn from the job id
  rather than fixed at bull-first, and `both` runs it twice and reconciles.
- Deterministic consistency checks in the verification pass: direction, period
  and unit words are checked against the figure the sentence cites, reported
  separately from citation coverage.
- `THESIS_RESUME_ON_START=0` holds queued paid work until an explicit resume.
- [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md),
  [`docs/PRIVACY.md`](docs/PRIVACY.md) and
  [`docs/DATA-RIGHTS.md`](docs/DATA-RIGHTS.md).

### Changed

- Every paid pass streams, behind an idle guard (`THESIS_STREAM_IDLE_SECONDS`)
  that abandons a provider which accepts a request and then goes silent.
- Near-term growth is the median of the available methods, not the lower of two
  CAGRs; the sign-disagreement rule is retired.
- Free cash flow is reported after stock-based compensation, with the before
  figure beside it.
- Enterprise value excludes the operating-lease liability only — the finance
  slice is debt in a frame that measures EBIT before finance-lease cost — and
  the own-history rank is built on the same basis as the current multiple.
- The own-history multiple figure is a rank among N quarters, not a percentile,
  and N is printed beside it.
- The disclaimer names what the report emits: letter grades and scenario price
  targets, neither a recommendation.
- The README is generated where it can be: its configuration, commands and cost
  tables come from `.env.example`, `package.json` and the model registry, and a
  doc-lint test fails if the checked-in file drifts from them.

### Fixed

- A crash or retry no longer re-bills a whole run: per-request cost rows are
  paired with their pass artifact, so durable resume works again.
- `THESIS_MAX_ACTIVE_LLM_CALLS=1` can now send a request at all, and the default
  of 2 no longer serialises the bull and bear passes into a lost prompt cache.
- Ordinary industrials with a treasury portfolio are no longer routed to the
  mortgage-REIT map.
- Short-term debt keeps the current maturities of long-term debt.
- The declared SEC contact identity no longer travels in Yahoo requests.
- `npm test` and `npm run test:integration` no longer spawn a package manager
  that can reach the network.
- EBIT is the issuer's operating income. It was pre-tax income plus interest
  expense whenever both were filed, which reintroduced every non-operating item
  the operating-income derivation removes and published a figure that
  derivation had refused outright for a bank or a double-counted interest
  add-back. Where operating income cannot be derived, EBIT is withheld and
  named in the missing-data manifest.
- The shared-model-family disclosure now fires on the production path. It was
  computed from a list that is empty there, so a run whose judge and analyst
  shared a model family never said so.
- Disclosing a failed consistency check no longer invalidates the completeness
  metadata computed from the same manifest. The same repair closes a run with
  presumed spend reporting itself inconsistent.
- A mirrored judge request that throws no longer discards the already-billed
  primary; the primary stands, settles once, and the failure is disclosed.
- Four consistency checks stopped flagging correct prose: a lower-is-better
  metric described correctly, a percentage coinciding with a scaled figure, a
  bare quarter read as a two-digit year, and person claims accepting any
  citation in the payload.
- A pass that was rejected and re-run now says so. The report billed twice for
  one result and showed two rows for the same step with nothing to distinguish
  them; the wasted row is marked `discarded` and the manifest names what it
  cost. The failure itself — a zod error that quotes the model's own rejected
  output — is recorded against the run rather than copied into the report.
- A schema rejection is diagnosable after the fact. The validation error naming
  the field and the rejected value was dropped when the failure was written to
  the pass artifact, leaving only the category behind.
- A successor registrant's predecessor is found again. The lookup read the
  8-K12B's submission header and stopped, on the premise that it co-registers
  the predecessor. The recorded SEC response for the case this was built for
  names one filer, itself — so nothing resolved, and the only fixture was
  hand-built in the shape the code expected. The predecessor is now found by
  reading a short ranked list of the registrant's submission headers, capped at
  four requests, and the disclosure names the filing that actually co-registered
  rather than assuming it was the 8-K12B.
