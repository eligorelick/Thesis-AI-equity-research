# Decisions

Every behavior, cost, data, or security design choice is recorded here before it
is implemented. Each entry lists the options considered, the risks across
correctness, user cost, data integrity, security, backward compatibility and
reversibility, the choice, and why. Reversible and disclosed beats clever.

Format: `D-nn (WSn) Title` → Options / Risks / Choice / Why / Disclosure.

---

## D-01 (WS1) Model registry as a checked-in JSON file

- **Options**: (a) keep the hard-coded `PRICING` map in `src/providers/anthropic.ts`; (b) a checked-in `config/models.json` plus a typed loader, refreshed by an explicit script; (c) fetch `GET /v1/models` at runtime.
- **Risks**: (a) drifts silently and cannot carry lifecycle or cache prices; (c) makes cost bounds depend on a live call and breaks offline tests; (b) can go stale, but staleness is visible (snapshot date) and the refresh is one command.
- **Choice**: (b). `config/models.json` with id, family, generation, context window, max output, effort support and levels, sampling support, prices (input, output, cache write 5-min/1-h, cache read), snapshot date, lifecycle. Loader `src/models/registry.ts`. `npm run models:refresh` rebuilds from `GET /v1/models` plus a pricing table checked against the pricing page; it is never run by tests and never by my session (paid/live call rule).
- **Why**: deterministic, offline, reviewable diffs, and the registry is the single source for request shaping, reservations and the README allow-list.
- **Disclosure**: report execution metadata carries the registry snapshot date.

## D-02 (WS1) Dated model IDs

- **Options**: (a) keep accepting `alias-YYYYMMDD` for every alias; (b) reject dated IDs for 4.6+ families, accept the dated Haiku 4.5 ID and its alias; (c) reject all dated IDs.
- **Risks**: (a) sends IDs that do not exist and 404s at the provider after a reservation was taken; (c) breaks the one real dated ID (`claude-haiku-4-5-20251001`); (b) needs a migration path for stored settings that hold a dated value.
- **Choice**: (b). Validation at settings write and at model resolution, with a message naming the accepted forms. A stored dated value for a 4.6+ family is treated as invalid at resolution: the run degrades to a data-only report with the reason named, exactly like any other rejected value today, and the settings page shows the message on load.
- **Why**: verified fact: from 4.6 onward the dateless ID is the pinned snapshot; dated variants do not exist.
- **Disclosure**: execution metadata adjustment `model-rejected` with the message; `tests/jobScheduler.test.ts:2527` is changed because it pinned the wrong behavior.

## D-03 (WS1) `auto` policy

- **Options**: (a) keep opus-5 → opus-4-8 → sonnet-5 → fable-5; (b) same order with `claude-fable-5-1` inserted before `claude-fable-5` at the end; (c) prefer Fable 5.1 first.
- **Risks**: (c) changes the default away from Opus 5 and multiplies cost by two; owner decision required. (b) keeps the documented default.
- **Choice**: (b). Order: `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5`, `claude-fable-5-1`, `claude-fable-5`. Fable models are last because they are the most expensive and the policy already ranked Fable behind Sonnet 5.
- **Why**: the brief requires `auto` to include Fable 5.1 and forbids changing the Opus 5 default without the owner.

## D-04 (WS1) Cache multipliers from the registry

- **Choice**: per-model cache-write (1.25 × for the 5-minute `ephemeral` blocks the code sends; 2.0 × only if a 1-hour TTL is ever requested) and cache-read prices come from the registry. The flat `CACHE_READ_MULTIPLIER = 0.1` is retired.
- **Why**: Fable 5.1 cache read is $0.25/MTok (0.025 ×), not 0.1 ×.
- **Reversibility**: the registry can carry the old ratio per model.

## D-05 (WS1) `max_tokens` shaping

- **Options**: (a) keep 64k analyst / 96k judge constants; (b) at effort `high`, `xhigh`, `max` set `max_tokens` to the registry's max-output for the model, otherwise keep the pass constants (still bounded by the registry); (c) always registry max.
- **Risks**: (b) raises the per-request output cap and therefore the reservation at high+; (c) raises it for every effort.
- **Choice**: (b), bounded above by the registry max output in every case.
- **Why**: the brief; a higher effort is the case where truncation is most likely and most expensive to repair.
- **Disclosure**: the pricing table names the caps used per effort.

## D-06 (WS1) Haiku route

- **Choice**: analyst passes on `claude-haiku-4-5` never send effort (registry says unsupported) and ignore `ANALYSIS_EFFORT`; the judge floors to `claude-sonnet-5` and honors `ANALYSIS_EFFORT`. The `model-floor` disclosure names requested and effective models and says which effort applied to each pass.
- **Why**: brief; matches current behavior, adds the naming.

## D-07 (WS2) Lease expiry without settlement is presumed spent

- **Options**: (a) keep deleting expired `job_llm_leases` rows (reservation vanishes); (b) convert an expired unsettled reservation into a `cost_log` row of kind `presumed` at the reserved maximum, reconciled downward only from a later `usage` block or the Admin Usage & Cost API; (c) keep the lease row forever.
- **Risks**: (a) spend can be lost from the caps after a crash; (b) over-counts until reconciled, which is the safe direction; needs an additive schema column; (c) blocks capacity forever.
- **Choice**: (b). `cost_log` gains nullable `settlementKind` (`actual` | `presumed`) and `reconciledAt`. Additive migration; existing rows read as `actual`. Reconciliation from `usage` happens when the owning process reports late; Admin API reconciliation is a scheduler task that runs only when `ANTHROPIC_ADMIN_KEY` is set.
- **Why**: brief; caps must hold across crash and restart.
- **Disclosure**: report cost metadata and the manifest entry `cost.presumed` list presumed rows.

## D-08 (WS2) Lease invariants validated at startup

- **Choice**: fail fast at config parse when any of these fails: `THESIS_PAID_PASS_LEASE_SECONDS ≥ 2 × paid heartbeat` (heartbeat = TTL / 4, so this holds by construction and is asserted); `THESIS_JOB_LEASE_SECONDS ≥ THESIS_PAID_PASS_LEASE_SECONDS` (a job claim must outlive any single paid attempt's lease so that job reconciliation never precedes paid-lease expiry); `THESIS_PAID_PASS_LEASE_SECONDS > provider request timeout + idle margin`.
- **Why**: brief; today only the provider-timeout relation is pinned by a test.
- **Backward compat**: defaults (900/900) satisfy all three.

## D-09 (WS2) Streaming with idle timeout

- **Choice**: every paid pass streams (the 16k-token threshold is removed); an idle timeout (default 120 s without an event, `THESIS_STREAM_IDLE_SECONDS`) aborts the stream. A dead stream settles the usage reported so far plus the worst case for the remainder as `presumed` until reconciled.
- **Why**: brief; SDK requires streaming for long requests anyway.

## D-10 (WS3) Per-request admission

- **Options**: (a) keep the 108 × per-pass reservation; (b) `maxRetries: 0`, own retry loop, each attempt reserved and settled separately, feature flag `THESIS_RESERVATION_MODE=request|pass` for one release.
- **Risks**: (b) more scheduler transactions per pass; retry timing moves into our loop (same delays as today); a request that times out after send is presumed spent until reconciled.
- **Choice**: (b), default `request`. Reserve `input_cap × input_price × cache_mult + output_cap × output_price + search_cap × 0.01`. Admission: `settled + live reservations + this request ≤ caps`; live exposure ≤ `THESIS_MAX_ACTIVE_LLM_CALLS × one request max`. Pass-level worst case is reported, not reserved.
- **Why**: brief; makes `THESIS_MAX_JOB_COST_USD=5` usable.
- **Reversibility**: `pass` mode keeps the old bound for one release.

## D-11 (WS4) Reserved fixture symbols

- **Options**: (a) keep DEMO/DBNK as fixtures only without a key and live symbols with one; (b) reserve `DEMO` and `DBNK`: always served from fixtures, never sent to FMP, EDGAR, Yahoo, FRED, Finnhub or FINRA, whatever the key state; (c) rename fixtures to an impossible ticker shape.
- **Risks**: (a) a fixture run makes SEC requests with a synthetic CIK and, with a key, sends the names to FMP; (c) breaks bookmarks and tests; (b) changes the with-key behavior the README documents.
- **Choice**: (b). A reserved-symbol list in one module; the data bundle short-circuits every provider for them and records `fixture.reserved` in the manifest. EDGAR filings for fixture symbols come from `fixtures/edgar` or are disclosed as absent.
- **Why**: brief ("no network request at all"; "cannot collide with real tickers"). Reservation makes collision impossible by construction.

## D-12 (WS4) `THESIS_STATEMENT_SOURCE`

- **Choice**: `auto` (default): FMP first; when FMP's plan truncates history, older periods are backfilled from EDGAR companyfacts with per-row `source: "edgar"` provenance and a manifest entry naming the depth served by each source. `fmp`: never backfill. `edgar`: EDGAR only, FMP statements ignored.
- **Why**: brief. Backfilled rows are never mixed inside one period.

## D-13 (WS4) Duplicate periods, restatements, short-term debt order

- **Choice**: duplicate-period rule: last-filed wins (max `filed`, then max accession); the superseded value is retained as `original` on the row; a `restatement` forensic flag fires when a material line (revenue, net income, total assets, equity, operating cash flow) moves by more than 1% of its prior value. Derived Q4 uses one filing lineage (the 10-K's FY fact minus that lineage's YTD facts) or discloses that it cannot. Short-term debt: `ShortTermBorrowings`, `CommercialPaper`, `DebtCurrent`, `LongTermDebtCurrent` resolved first (existing overlap rules kept); the maturity-schedule figure is used only when all four miss, and the note says it is current maturities only and may be annual-only.
- **Why**: brief; the overlap handling already in `resolveDebtOverlaps` stays.

## D-14 (WS4) Successor registrants and offline fixtures

- **Choice**: when submissions show an 8-K12B and no annual report, resolve the predecessor CIK from a co-registrant list, pull its companyfacts, and emit rows tagged `predecessor` with the predecessor CIK in provenance. The test uses a hand-built fixture shaped like the SEC index for CIK 2115436, marked `synthetic-structure` in its header; recording the live payload is deferred to an owner-approved fetch.
- **Why**: the no-live-network rule applies to my session and to tests.
- **Revised 2026-09-03, after the owner approved the fetch**: the recorded payloads disprove the mechanism this decision assumed. ExxonMobil Holdings' own 8-K12B (0001193125-26-291990) carries a SINGLE filer block — itself — so reading that one filing resolved nothing for the issuer the feature was built for, and the hand-built fixture had encoded the shape the code expected rather than the shape SEC serves. The co-registration is on the filings the two entities made jointly afterwards: the 10-Q 0000034088-26-000093 and the POSASR 0001193125-26-292453 each name both CIKs. The 8-K12B is now the trigger only; `predecessorCandidates` ranks the headers worth reading (8-K12B, then periodic reports newest first, then filings carrying a co-registrant file number, employee-plan amendments last) and `resolvePredecessor` reads them in order, capped at four, until one names exactly one other party that has filed history of its own. Four recorded payloads are committed under `fixtures/edgar/xom_successor_*`; the synthetic fixture stays, now covering the branch where an 8-K12B does co-register.

## D-15 (WS4) Beta

- **Choice**: monthly total returns from dividend-adjusted closes (Yahoo `adjclose` when present, else disclosed as price-only); minimum 24 observations else withheld and disclosed; report OLS standard error and R²; Blume-adjusted shown beside raw; WACC keeps using the Blume beta as today.
- **Why**: brief.

## D-16 (WS5) Sector routing with XBRL evidence

- **Choice**: routing combines SIC/industry with tag evidence from companyfacts (deposits, loans, net interest income → bank; premiums, loss reserves → insurer; MBS/loan assets and no investment property → mortgage REIT; `RealEstateInvestmentPropertyNet` plus REIT status → equity REIT). SIC 6798 with no evidence routes to `reit` with sub-map `undetermined`, which withholds both FFO-based and book-value-based metrics with a reason. The routing note lists the evidence used.
- **Why**: brief; SIC 6798 covers both REIT types.

## D-17 (WS5) Financial-route metrics and forensics

- **Choice**: equity model value = book equity + Σ discounted (ROE − CoE) × prior book with ROE faded to CoE over the horizon; P/TBV vs ROTE; route metrics computed from statements where tags allow, withheld with reason otherwise. Piotroski on financial routes: ΔLEVER and ΔTURN withheld with reason; the score is reported over the remaining signals with its own denominator. Altman Z and Beneish M stay withheld on financial routes. Nothing is removed; every withheld metric carries a reason.
- **Why**: brief; removal would need an owner decision.

## D-18 (WS6) Growth anchor

- **Choice**: methods: log-linear regression slope over all available years, 3y and 5y CAGR, consensus-anchored growth when FMP estimates exist. Point estimate = median of available methods; range shown. Linear fade to terminal over the explicit 10-year horizon. "Lower of 3y/5y" retired. Sign-disagreement rule retired in favor of the regression slope, whose fit statistics are shown.
- **Why**: brief.

## D-19 (WS6) WACC disclosure, terminal rule, SBC, EV bridge, labels

- **Choice**: assumption block lists the FRED risk-free series and date, ERP source and date, cost-of-debt method, tax-rate choice, market-value weights; terminal growth ≤ rf by default (already `min(2.5, rf)`). Terminal ROIC rule kept and labeled "house convention"; ROIC-vs-WACC history uses each year's WACC when a FRED rf for that year is available, otherwise the note says the current WACC was used. FCF subtracts SBC by default; dilution from outstanding awards shown. EV bridge keeps debt, cash, NCI, preferred; operating lease liability is an off-by-default disclosed option (`THESIS_EV_INCLUDE_LEASES=1`) applied consistently to EV/EBITDA. `own5yPercentile` relabeled "rank among N quarters" in the schema label and UI. Disclaimer names grades and scenario targets.
- **Why**: brief.

## D-20 (WS7) Bull/bear order and judge inputs

- **Choice**: `THESIS_JUDGE_ORDER=random|bull-first|bear-first|both`, default `random`, seeded from the job id so it is reproducible and recorded in report metadata. `both` runs the judge twice with swapped order and reconciles (documented as twice the judge cost). Bull and bear are length-capped (registry-bounded output tokens plus a word cap in the prompt) and the judge is told both lengths. Analyst schema gains `case_strength` (1-5) and the judge may discount a weak side. Verify adds deterministic direction/period/unit checks and reports coverage and checked separately. Claims about named individuals are restricted to filings and transcripts. Metadata notes when judge and analysts share a model family.
- **Why**: brief; `random` is the cheaper default.

## D-21 (WS8) CSRF, resume-on-start, settings reset

- **Choice**: keep the existing guard; add route-level tests for a cross-site form POST (navigate mode) and a cross-site fetch. When both Fetch Metadata and Origin are missing, require a token: minted at startup into `<data dir>/csrf-token` and accepted via `X-Thesis-Token`; browsers never need it. `THESIS_RESUME_ON_START` (default `1`); when `0`, bootstrap does not kick the scheduler and queued paid work waits for `POST /api/jobs/resume` or the Settings page. `npm run settings:reset -- --yes` deletes stored settings rows.
- **Why**: brief; token path only touches header-less clients.

## D-22 (WS9) Node requirement and generated docs

- **Choice**: `engines.node = ">=22.18.0"`; CI stays on 24 and the README says so. `npm run docs:config`, `docs:commands`, `docs:pricing` regenerate marked README sections; a doc-lint test compares the generated output to the checked-in README. `CHANGELOG.md` with migration notes.
- **Why**: brief; nothing in the harness needs 24.

## D-23 (integration) The audited fixture comparison's delta contract

- **Options**: (a) regenerate `tests/fixtures/audit-baseline-stageb-report.json` against a new audited commit, retiring the link to 524d09e; (b) keep the baseline and extend the contract so it can express what the remediation did; (c) relax the comparison to ignore the two gap manifests.
- **Choice**: (b). `afterMissing` was added for a leaf the audited projection has and this one does not, without which a removed key or a shortened array cannot be expressed at all. The list moved to `tests/fixtures/audit-intended-deltas.json` and is grouped: every group names the decision records that caused it and carries a reason, and `npm run audit:deltas` refuses to classify a newly differing leaf on its own. A `manifestIdentity` block pins the two gap manifests by entry name as well as by position.
- **Why**: (a) throws away the evidence the comparison exists to provide, which is that this tree still computes what the audited commit computed apart from changes somebody wrote down. (c) is the failure mode the test was built to prevent. The remediation legitimately moves 709 leaves; without grouping and an identity view nobody would read them, and a contract nobody reads is a rubber stamp.
- **Risk**: the list is long enough that a real regression could hide inside a group. Mitigated by the identity view, by the per-group reason, and by the fresh-context review of each workstream's diff.
- **Also fixed**: dotted paths could not address an object key containing a dot (`asOfMap["edgar.cik"]`), reading as absent on both sides and slipping past the value checks. Keys now escape their dots and backslashes.
