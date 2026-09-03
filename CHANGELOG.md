# Changelog

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
- A successor registrant's predecessor is found again. The lookup read the
  8-K12B's submission header and stopped, on the premise that it co-registers
  the predecessor. The recorded SEC response for the case this was built for
  names one filer, itself — so nothing resolved, and the only fixture was
  hand-built in the shape the code expected. The predecessor is now found by
  reading a short ranked list of the registrant's submission headers, capped at
  four requests, and the disclosure names the filing that actually co-registered
  rather than assuming it was the 8-K12B.
