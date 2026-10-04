# Repository audit — 2026-10-03

Status: initial repository audit, UI selection and verified 2026-10-04 fixes
complete; F08 was unresolved at that checkpoint. The later
[recommendations ledger](2026-10-04-recommendations.md) records its replacement
protocol and current verification status. Current remains the default
with optional Research workspace in Settings. Earlier dated
audits and decisions remain historical evidence. The owner authorized merging
pull request #5 into `main` on 2026-10-04 after verification. Deployment remains
outside this authorization; the PR records the merge outcome and commit.

## Scope and baseline

Started from clean `main`, commit `4088d4b5902b8e7b4ea83ed383f617c39d6fb648`,
on branch `codex/2026-10-03-repository-audit`. Local environment: Windows,
Node 24.11.1, npm 11.6.2. Preserve private data, credentials, saved preferences,
report compatibility and useful audit history. No paid API inference.

Baseline `npm run verify` exited 0 before production edits:

| Gate | Baseline evidence |
| --- | --- |
| Dependency shape, TypeScript, ESLint | Passed |
| Product | 196 files; 4,462 passed, two opt-in live checks skipped; 36.25s |
| Integration | Four passed; 3.03s |
| Core coverage | Statements 96.42%, branches 90.61%, functions 99.10%, lines 97.52% |
| Risk coverage | Statements 94.21%, branches 87.15%, functions 96.90%, lines 96.16%; per-file floors passed |
| Production build | Passed; external Gemini/Chrome lookup caused tracing warnings |
| Dependency security audit | Zero vulnerabilities reported, including dev dependencies |

Timing is one local observation, not a benchmark. The baseline also emits Vite
future-native-loader compatibility notices and an expected lint-rule fixture
warning. Neither is a failing gate. The test fetch guard blocks external traffic
by default; CLI tests use temporary databases. No user database or credential
store was inspected or edited. Next's normal build loads local `.env` settings;
no private values were printed or submitted to a model/provider. Required online
dependency metadata is not inference.

## Coverage and execution plan

Inventory includes first-party `src`, scripts, configuration, CI, test/fixture
contracts and all 14 pre-existing maintained Markdown documents. Coverage here
distinguishes code review, focused regression evidence and broad suite execution;
passing coverage percentages do not prove financial correctness.

| Area | Review owner and focus | Status |
| --- | --- | --- |
| Providers, EDGAR, Stage A/B, compute, keyless/data bundle | Financial reviewer: dates, units, currencies, shares, formulas, access and provenance | Reviewed; targeted fixes and independent calculation cases |
| AI, model registry, scheduler/jobs, persistence/cache/settings, routes/security | Runtime reviewer: billing, identity, abort/recovery, request boundaries | Complete body review of assigned modules; focused regressions pass |
| Pages/components/charts | UI reviewer: source clarity, missing values, accessibility, navigation | Reviewed; error/contrast/gap repairs and selected optional workspace |
| Reports, exports, history, watchlist, Stage C, tooling/CI | Coordinator plus cross-review: integrity, evidence checks, escaping, release gates | Review and local integration checks complete |
| Markdown | Financial methodology/research, historical records, current setup/rights/privacy | All 14 existing documents reviewed; reconciliation below |
| UI choice | Current + two standalone interactive alternatives | Implemented current default plus optional Research workspace |
| Integration and delivery | Final checks, independent diff review, local smoke, PR | Local gates passed after UI follow-up; initial Linux/Windows CI passed |

## Findings and evidence

| ID | Classification | Evidence, change and disposition |
| --- | --- | --- |
| A01 | Confirmed defect; fixed | Latest-report and direct-ID readers returned another issuer's embedded body from a mismatched row. Guard latest/history/view/API export reads; corrected CLI refuses the mismatch before output. Matching dot/hyphen aliases still work; stored bytes remain unchanged. Regression fixtures formerly hiding mismatches now carry their intended issuer. |
| A02 | Confirmed data-loss defect | Corrected export silently truncated existing HTML/JSON, its source database, or a hard link to it. Four temporary-file regressions failed before repair. Reserve both destinations with exclusive creation before writing; refuse existing files and remove only newly created partial outputs. Fixed. |
| A03 | Confirmed financial defect; fixed | Missing-month price gaps counted as monthly beta observations; 23 actual pairs became 24 and passed the minimum. Count only adjacent months within the fixed 60-calendar-month window; retain OLS/log-return/Blume conventions. |
| A04 | Confirmed reliability defect; fixed | Cost reconciliation changed ledger totals without advancing job revisions, suppressing SSE updates. Advance each affected job once in the same transaction; no-op reconciliation stays unchanged. |
| A05 | Confirmed billing failure; fixed | Paused-continuation admission refusal discarded prior received usage. Return the typed refusal with prior billing evidence; regression retains $0.012, 1,000 input/output tokens, one actual ledger row, no new request/lease. |
| A06 | Confirmed text-integrity defect; fixed | Per-chunk Gemini decoding turned a split `é` into replacement characters. Stateful UTF-8 decoding preserves the response across arbitrary byte boundaries. |
| A07 | Confirmed financial defect; fixed | Reverse DCF omitted exact roots at the final grid point. Check every finite point, including inclusive bounds and a root beside an unavailable neighbor. Independent two-year FCFF cases recover +60% growth and +60% margin. |
| A08 | Confirmed financial defect; fixed | FRED CSV removed `.` observations before lagging, comparing the wrong periods. Retain missing slots internally and require both operands; regressions cover monthly change and year-on-year inflation. |
| A09 | Confirmed reliability defect; fixed | The filing extraction budget began after parsing. Start before parsing; a fake clock proves MD&A is withheld once parsing/Item 1A exhausts the budget. This is a between-phase soft budget, not parser preemption. |
| A10 | Confirmed billing fallback defect; fixed | Rebuilt billed errors lost presumed-spend and execution metadata when an adapter omitted its settlement callback. Preserve both fields; regression verifies ledger/artifact contents. |
| A11 | Confirmed usability defects; fixed | Watchlist deletion failures were silent and load failures looked empty. Show safe error/retry text and distinguish unavailable from successfully empty data. |
| A12 | Confirmed chart/accessibility defects; fixed | Lines bridged unknown values; faint text had 3.16–3.56:1 contrast. Preserve gap positions, stop bridging, and raise faint text to 5.19–5.86:1 on the three principal backgrounds. |
| A13 | Confirmed build inefficiency; repaired | External Gemini/Chrome discovery caused whole-project tracing warnings. Narrow runtime annotations keep those user-installed programs external; the final build passes without those warnings. No speedup is claimed. |
| A14 | Confirmed comparison defect; fixed | Verdict comparison removed punctuation like fuzzy title matching, hiding a change from −10% to +10%. Compare narrative with whitespace/case normalization while preserving financial punctuation; title matching stays unchanged. |
| A15 | Confirmed provenance display defect; fixed | Isolated browser generation showed EDGAR available for a reserved fixture that makes no provider calls. Expected fixture omissions now remain excluded from incident counts while EDGAR reads missing, XBRL skipped and forensics provisional. |
| A16 | Confirmed financial defect; fixed | ROIC, ROTE and DuPont averaged closing capital with a balance two years earlier or from a short transition stub. Require the existing 300–430-day fiscal-continuity range; otherwise use the disclosed single-period fallback with a warning. 364/371-day fiscal years still average. Independent case changes erroneous 80/600 ROIC to 80/1,000 = 8%. |
| D01 | Confirmed documentation defect | EDGAR-hosted issuer filings were incorrectly described as US government works with no license restrictions. Replaced with SEC dissemination guidance and the distinction between public access and authorship. |
| D02 | Confirmed financial explanations; fixed | Finance-lease amortization is within EBIT and added back in EBITDA; interest is below EBIT. FCFF is before debt service. Tangible leverage is not guaranteed below CET1. Currency mismatch withholds quote comparisons while model-currency per-share values can remain. Numeric model conventions stay unchanged. |

Focused report tests: five original regressions failed, then 56 tests passed
after repair. One existing watchlist test seeded a DEMO body under AAPL; corrected
the fixture identity while preserving its grade/quote assertions. No production
validation or coverage threshold was weakened. Independent review caught an
export rollback edge case: a locked partial file masked the original disk-write
error and stopped sibling cleanup. A failing regression preceded best-effort
per-file cleanup; locked partial files can still remain, without replacing
pre-existing files.

Financial reference case: cash flows 300 and 480, terminal cash flow 470.016,
discount rate 10%, terminal growth 2%, 100 shares give per-share value
`300/1.1/100 + (480 + 470.016/0.08)/1.1²/100 = 55.249586776859495`.
Reverse valuation now recovers the generating +60% growth bound. Missing-month
cases independently count 23 and 58 valid adjacent return pairs. The standard
DEMO fixture's numeric output is unchanged: five repinned historical-comparison
paths contain the spec version and four corrected lease disclosures only;
the former EDGAR-available delta is removed because reserved fixtures have no
EDGAR evidence. Numeric outputs remained unchanged in the initial audit; the
2026-10-04 follow-up below deliberately withholds an unsupported acceleration.
Report 1.7.0 and payload 1.8.0 separate prior calculation conventions; old saved
reports retain their bytes and remain readable under compatibility rules.

## UI comparison

`public/audit-ui/index.html` is an offline simulation with a simplified current
layout, Research workspace and Decision brief. All share fictional DEMO/DBNK,
baseline/critical-gap/stale/data-only conditions and report, evidence, history,
AI-settings and export interactions. No provider request, personal-data storage
or production redesign is performed by the demos. The owner selected the current
design as default, with Research workspace available through Settings.

| Option | Benefit | Tradeoff |
| --- | --- | --- |
| Current terminal | Familiar compact panels and dense metrics | More reading density; evidence requires expansion |
| Research workspace | Reading and source context together, clearer snapshot hierarchy | More space; source rail stacks on narrow screens |
| Decision brief | Research question, disconfirming evidence and gaps first | Detailed metrics need more scrolling |

The current demo approximates the existing design; it is not a pixel-identical
replica. All options use the same illustrative workflow and data conditions.
Keyboard interaction, cancellation, history selection, the PDF preview dialog
and 390px alternatives were checked in the in-app browser. No actual PDF print
job was dispatched. Decision brief remains a comparison prototype only.

Selected implementation: Settings → Appearance offers Current (default) and
Research workspace. A `thesis-ui-design` cookie stores only the enumerated design
for 180 days, scoped to the browser host; server rendering reads it to avoid an
initial wrong-design flash. The choice applies immediately. A blocked write is
reported as visit-only, with a warning that reload may restore the prior design.
The workspace adds light panels, responsive navigation and an evidence rail
derived from the same report, including recorded gaps, dates and section links.
Canvas chart palettes and SVG tokens follow the design without changing values.
Analysis settings, saved report bytes and print/export renderers stay independent.
No appearance action launches inference or refreshes financial inputs.

Eighteen new unit/SSR cases cover default/malformed preferences, persistence and
refusal, initial rendering, rail isolation, disclosures and unchanged chart values.
The new pure-display modules are explicitly classified outside risk coverage;
existing risk sources and thresholds remain intact. Independent review covered
119 distinct passing tests across ten files. It found and corrected a test-only
fixture construction error before final verification. Palette calculations give
workspace secondary text 5.22–5.94:1 contrast on its three main backgrounds,
and sidebar secondary text 5.38–7.45:1 on its two backgrounds. Browser review
also caught hardcoded warning/error hues bypassing those tokens; workspace-only
CSS maps them to the darker warning/error palette. These checks do not constitute
an accessibility certification.

An isolated copy also exercised the real app: home, DEMO/DBNK company views,
data-only generation and persistence, saved reports, two-report history/diff,
AI-off settings, the synthetic sample and print page. Markdown/print-HTML
endpoints returned 200; regenerated DEMO displayed EDGAR missing in both UI and
exports. AI steps were skipped with $0 and no fallback. The copy used temporary
data/AI directories, blank provider settings and an external-fetch block. Its
linked dependencies needed temporary Turbopack-root/Tailwind-source settings
after harness compilation failures; these are not production edits. The smoke
server was stopped; the separate comparison demo remains available locally.

After the selection, the isolated preview was restarted with the final UI and
left available at `http://127.0.0.1:4318/settings`, with Current selected. The
in-app browser disconnected; a fresh Chrome tab exercised only that temporary
app, without inspecting unrelated tabs or browser stores. Switching, saved
feedback, reload, client navigation and restoration to Current passed. Workspace
rendered the same saved DEMO gaps/dates, with expandable details and a working
Appendix keyboard link; the desktop rail scrolls within the viewport. At
390×844 the page had no horizontal overflow and navigation toggled by keyboard
with matching `aria-expanded`. Existing canvas charts and known SVG points
rendered. DBNK retained missing-assessment/unknown-completeness disclosures.
New DEMO report #4 remained data-only with $0, skipped AI and no paid fallback;
history comparison to #3 remained unchanged. Twenty isolated HTTP route checks
returned 200 across both designs; malformed design values fell back to Current.
Markdown was identical across choices and the print page stayed white with no
shell or evidence rail. Actual PDF printing and real cookie-blocking browser
configuration were not exercised; blocked writes have unit/render tests.

## Sources and applicability

- [Node 24 file-system flags](https://nodejs.org/docs/latest-v24.x/api/fs.html#file-system-flags):
  exclusive creation prevents replacement of an existing destination, including
  link aliases. Applied to A02's synchronous local export; no claim of atomic
  two-file publication across power loss or network filesystems.
- [Next.js cookies](https://nextjs.org/docs/app/api-reference/functions/cookies)
  and [MDN document.cookie](https://developer.mozilla.org/en-US/docs/Web/API/Document/cookie):
  server cookie reads support initial appearance selection; browser writes store
  this non-secret preference. Reading cookies in the root layout makes its pages
  dynamically rendered, a tradeoff for showing the selected design immediately.
- [SEC dissemination and access policy](https://www.sec.gov/about/privacy-information)
  and [17 USC 105](https://www.copyright.gov/title17/92chap1.html#105): support D01's
  corrected description; do not treat hosting as government authorship.
- [FRED terms](https://fred.stlouisfed.org/legal/): include series-specific rights
  and AI-development/training restrictions. Applicability to each inference use
  is unresolved; documentation discloses this instead of asserting permission.
- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing):
  current published Opus 5.5, Sonnet 5.5 and Fable 5.1 prices/cache rates match
  the checked-in registry. No live inference or account access inferred.
- [ALFRED growth formulas](https://alfred.stlouisfed.org/help#growth_formulas):
  lag indices represent periods, supporting A08. Truly absent irregular CSV
  rows remain a separate frequency-inference limitation.
- [Morningstar equity data definitions](https://morningstardirect.morningstar.com/clientcomm/DataDefinitions_EquityandExecutive.pdf):
  monthly return/window reference for A03; the 24-observation minimum and log
  returns remain Thesis house choices, not exact vendor equivalence.
- [FASB ASC 842 update](https://storage.fasb.org/ASU_2016-02_Section_A.pdf),
  section 842-20-45-4, and [Damodaran on financial firms](https://pages.stern.nyu.edu/~adamodar/pdfiles/papers/finfirm09.pdf):
  support the finance-lease and FCFF explanation corrections. No new model
  calibration or investment conclusion is inferred.
- OpenAI [sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
  and [models/inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
  were checked against the existing OAuth/Responses implementation; no paid API
  substitution or live account-grant claim.

## Cleanup, documentation and limits

Removed only the unused direct `@eslint/eslintrc` development dependency:
reference search found the historical flat-config comment, while current config
imports Next's native flat arrays. `npm ls` confirms ESLint still uses the same
3.3.6 transitive package. No resolved dependency changes. The comparison-lock
hash metadata is updated; historical base/source/fixture/projection hashes stay
pinned. No obsolete production module was established safe to delete. Retained
legacy report readers, timestamp aliases, the local Next glob adapter, synthetic
fixtures and historical audits because their callers, tests or compatibility
purpose remain. No private data/settings/credentials were deleted.

| Maintained Markdown | Reconciliation |
| --- | --- |
| README | Appearance option documented; generated command table matches export refusal; routing description permits corroborated financial-label refinement; source-evidence wording avoids a universal completeness claim. Existing 270-line limit retained. |
| CHANGELOG | Current audit added; earlier development batches explicitly dated/historical guidance. |
| CLAUDE-USAGE | Checked registry/official pricing, fallback-only dual-model reserve, per-request admission, reconciliation versus persisted report costs. |
| PRIVACY | Corrected public peer/benchmark payload scope, request-origin conditions and Gemini's Chrome requirement; appearance cookie scope, lifetime, clearing and blocked-save behavior documented. |
| DATA-RIGHTS | Corrected EDGAR authorship; distinguish access from Yahoo/FMP redistribution permission; disclose FRED restrictions and unresolved inference applicability. |
| METHODOLOGY | Seven grades, lease/FCFF/CET1 explanations reconciled with code. |
| RESEARCH | Beta calendar conventions, Altman fallback, Piotroski asset history and SEC ticker-map/SIC distinction corrected. Historical empirical studies not independently replicated. |
| DECISIONS | D-35 records audit changes, D-36 records the owner's UI selection and storage tradeoffs; later entries override dated model defaults. |
| REMEDIATION-REPORT | Historical banner; initial offline work distinguished from later recorded paid experiments. |
| 2026-09-06 audit | Historical banner; dated counts/models/findings remain evidence. |
| Four design specs (2026-08-07, 08-09, and two 09-02) | Each explicitly historical; superseding implementation/deviation notes distinguish plans from current behavior. |
| This audit | Current coverage, evidence, dispositions and remaining limits. |

Link sweep of 39 external endpoints returned 31 HTTP 200 responses; the GitHub
advisory-creation link redirects to login. FRED API-key/terms requests timed out;
FMP terms, SEC policy/API docs/two issuer filings, and ChatGPT usage returned 403.
These are unverified by that sweep, not proven dead links. SEC policy and FRED
terms content were separately readable through research tools. Reachability
does not verify page claims, login-only content or URL fragments. Repository
doc checks validate generated sections and local heading/reference contracts.

## Review depth, deferred work and verification limits

All 163 original first-party source files, 12 script files, build/CI configuration
and test/fixture inventories were considered. The selected UI follow-up adds six
source files, bringing the source inventory to 169; an independent reviewer read
all six, both new test files and all changed UI/chart/CSS code. Runtime ownership covered complete
module bodies; financial and Stage C review combined body reads with function
outlines and focused high-risk paths. Large financial modules received uneven
depth: some assumption/history/provider-parser branches were sampled. A second
pass read every executable body in forensics, returns, sector routing and
EDGAR statements; report schema/history/diff/completeness/legacy safety, both
export renderers, surface manifest and watchlist received full body review. This is
a repository-wide review, not exhaustive line-by-line proof. Tests were read
deeply around changes and contracts; not every existing assertion was manually
reviewed. Independent review covers the changed finance/persistence code and
the coordinator reviewed the runtime and UI changes.

Deferred recommendations and limits:

- The retained Current design still reserves a fixed 256px rail; Research
  workspace adds responsive navigation. Numeric provenance tooltips, small type,
  below-xl section navigation, canvas alternatives and more live announcements
  remain usability recommendations, not a full accessibility certification.
- Existing beta day-26 completion heuristic and frequency inference for truly
  absent FRED rows merit calendar-aware follow-up; no new failure case beyond
  the repaired explicit-gap inputs is claimed here.
- Additional targeted cases for invalid as-of strings, irregular growth labels
  and incomplete statement components were recommended. The follow-up addresses
  invalid dates, acceleration horizons, credential shape and future IPO dates;
  it confirms a separate stale-recovery race. Malicious local cache decompression
  limits and standalone forensic restatement alignment remain deferred;
  historic coefficients/static ADR
  assumptions were not all independently refreshed from primary sources.
- Lower-priority presentation follow-ups at the initial audit: the judge note
  overstated its cap and scenario/catalyst/risk metadata was partly hidden;
  both are addressed in the follow-up below. Duplicate
  scenario names remain schema-permitted and explicitly diagnosed by comparison.
- No live provider entitlement/invoice reconciliation, OAuth approval, Gemini
  inference, broad cross-issuer reconciliation or empirical financial-model
  calibration was performed. Existing keyless history remains an approximation,
  not a point-in-time backtest. House assumptions remain disclosed choices.
- Windows is the local execution platform. Initial CI passed Linux/Windows;
  macOS credential storage and every filesystem failure cannot be certified
  from this run. Locked export remnants and power-loss two-file publication
  remain limitations; existing destination bytes are protected.
- Future Vite native-loader notices are pre-existing and unsuppressed. Model
  quality, screen-reader usability and every browser/OS combination remain
  unverified. No paid API inference, merge or deployment occurred.

## Initial audit and UI verification

`npm run verify` exited 0 on the repaired code after the integrated run exposed
four test-contract failures. Two were stale version assertions; two export
fixtures violated the newly enforced issuer boundary. Updated coherent fixture
identities retain the malicious rendering payloads, and a new test explicitly
rejects poisoned issuer symbols. No check was disabled or threshold lowered.

| Gate | Final evidence | Baseline comparison |
| --- | --- | --- |
| Dependency shape, TypeScript, ESLint | Passed | Same gates |
| Product | 200 files, 4,522 passed, two opt-in live checks skipped; 28.39s | +60 passing tests, four new files |
| Integration | Four passed; 2.64s | Same four checks |
| Core coverage | 96.45% statements, 90.65% branches, 99.10% functions, 97.53% lines | All at or above baseline |
| Risk coverage | 94.23% statements, 87.20% branches, 96.90% functions, 96.17% lines | All at or above baseline; per-file floors passed |
| Production build | Passed; tracing warnings removed | Compile 2.2s versus 1.945s; single observations, no performance claim |
| Dependency security audit | Zero reported vulnerabilities, including dev dependencies | Same result; point-in-time package advisory check |

Local detailed logs are in ignored `tmp/audit-baseline.log`,
`tmp/audit-final-verify2.log`, `tmp/audit-workspace-verify.log` (final selected UI),
and the reviewer `tmp/audit-*.md` records. The final production build occurred
after the workspace status-color correction. This tracked document preserves
the reviewable summary and limitations; remote CI is separate from local results.
No guaranteed accuracy or absence of regressions is claimed.

## Follow-up — 2026-10-04

The owner requested another pass for fixes supported by evidence. Starting point:
clean `0003d64`, with 4,522 product tests, four integration tests and final
Linux/Windows CI passing. Current remains the default; Research workspace stays
optional. No private data inspection, paid inference, merge or deployment.

Plan: reproduce candidate date-validation and credential-store failures using
synthetic/temp inputs; repair only demonstrated boundaries. Correct the judge
length-limit disclosure and expose already-recorded scenario/catalyst evidence
where the UI drops it. Each change gets a focused regression or rendering check,
independent review and the required full verification. Retain unconfirmed
calendar, parser, model-calibration and platform hypotheses as explicit limits.

| ID | Evidence and disposition |
| --- | --- |
| F01 | Confirmed disclosure defect; repaired. A protected 30,000-character citation left a 30,313-character case against a 24,000 target, but the reader note claimed both cases were capped and metadata claimed truncation with no content change. Bull/bear regressions preceded actual-change counting, over-target manifest entries and exact excess disclosures. Independent review added escaped-text and mixed-null historical metadata cases: retain known facts, identify the missing side and do not fabricate replay. Protected citations and request admission stay intact. |
| F02 | Confirmed routing defect; repaired. IPO dates after the observation date, or with garbage suffixes, triggered recent-IPO treatment. Require a calendar-valid date on/before the observation date; future/invalid inputs produce a gap and ordinary insufficient-history handling. Preserve the 24-month threshold and shared timestamp parser used for balance/runway evidence. |
| F03 | Confirmed validation defect; repaired. NaN comparisons let invalid quote/newest-statement dates pass freshness; date coercion also accepted impossible calendar days. Validate full stamps and calendar dates, fail with a specific diagnostic, and retain the existing calendar-day age basis for valid offsets. Leap-day, hour, suffix and offset cases are covered; this does not introduce price suppression or UTC-age policy changes. |
| F04 | Confirmed financial-label defect; repaired. A requested 3y CAGR with actual span 2y or 4y was used as a three-year acceleration benchmark. Withhold benchmark/delta/direction unless the span is within ±0.05y of three years. Keep degraded CAGR series; 52/53-week cases remain supported. |
| F05 | Confirmed persistence defect; repaired. Valid JSON with malformed consumed token/profile/selection fields reached callbacks and could be rewritten. Thirteen failing cases preceded v1 shape validation before mutation. Preserve signed-out/expired registrations, historical valid model IDs and unknown fields; malformed bytes remain untouched and errors reveal no credential content. |
| F06 | Confirmed lock-acquisition defect; repaired. PID write/close I/O failures leaked the descriptor/lock before the normal finally block. Close and remove the acquired lock on failure, preserve the original error if cleanup is denied, and prove retry succeeds. An unremovable filesystem remnant can still remain. |
| F07 | Demonstrable provenance improvement; implemented. Native target disclosures expose source identity, observation date and period in both designs; legacy missing metadata is explicit. Catalyst expected dates/direction/significance and risk source/severity/probability are labeled separately from reasoning citations. Ten failing rendering cases preceded the change; escaped source strings remain text. |
| F08 | Confirmed concurrency race; unresolved. A stale-recovery contender can read a dead PID, another contender replace that lock, then the first unlink the new live owner's lock and enter concurrently. A controlled filesystem-interleaving test reproduces it; no real multi-process stress run or observed user incident is claimed. A safe atomic ownership protocol needs separate cross-platform design and verification; a stat/PID recheck would only narrow the race. Ordinary single-server ownership and live-lock timeout remain, but do not prove atomic recovery. |

Independent growth calculation: 100→144 revenue gives a two-year CAGR of 20%,
a four-year CAGR of 9.5445115010%, or a three-year CAGR of 12.9243234657%.
With latest 110→144 growth of 30.9090909091%, the valid three-year acceleration
is 17.9847674434 percentage points. The other horizons are unavailable as that
benchmark, rather than producing an incorrectly labeled comparison.

Report 1.8.0 and payload 1.9.0 separate these financial/date-evidence conventions.
DEMO's actual history is two years (2023-12-31→2025-12-31); its former benchmark
9.1089451180%, difference −0.4132929441pp and `accelerating=false` become null.
The new intended-delta group has 86 positional changes, largely the insertion
of one gap into two sorted manifests. Reconstructing the previous and current
projections from the immutable baseline and comparing manifests by field proves
only `growth.revenueAcceleration.threeYearCagr` was added. Other numeric outputs
and underlying CAGR series are unchanged; baseline hashes remain pinned.

References: [RFC 3339 §§5.6–5.7](https://www.rfc-editor.org/rfc/rfc3339#section-5.6)
supports Gregorian date and qualified timestamp validation (not a claim of full
RFC extension/leap-second support); [Node 24 closeSync](https://nodejs.org/docs/latest-v24.x/api/fs.html#fsclosesyncfd)
supports explicit descriptor cleanup. House financial thresholds are unchanged.

Cross-review covered the finance date-parser callers, fiscal-horizon handling,
credential compatibility/unknown metadata, actual shortening and partly recorded
protocols. Focused groups passed: 419 finance tests; 80 runtime/cache tests,
including three real OS temporary-store checks; 199 UI/render/export tests and
217 judge/export tests (these groups overlap). Browser spot checks in the isolated
app verified keyboard target disclosures and visible catalyst/risk labels in
Current and Research workspace. No private data, live inference or PDF print job.

Remaining work is F08 plus the explicitly deferred hypotheses above. A universal
decompression cap was not imposed: the 64 MiB HTTP policy does not cover every
provider or bound serialized cache JSON, so historical compatibility is unproven.
F08 reproduction uses a temporary owner-only store and an existing lock with a
dead PID. During the contender's liveness probe, replace that lock's content with
a live writer's PID, then return `ESRCH` for the original PID. The contender
removes the replaced path and enters its callback; the expected assertion that
it remains excluded fails. This deterministically simulates the interleaving;
it does not run two real concurrent processes. A future repair must preserve
exclusion across stale-owner replacement, PID reuse and interrupted acquisition
on each supported OS, without deleting a live writer's lock.
Detailed local evidence is retained in ignored `tmp/audit-followup-*.md` and logs;
the intentionally failing stale-interleaving reproduction remains in ignored tmp.

Final follow-up `npm run verify` exited 0. The first full run exposed two stale
version assertions in the job persistence and Stage C fingerprint tests; exact
expectations were updated to the new report/payload versions. Their 220 tests
passed before the full rerun. No gate, assertion scope or coverage floor was
weakened. Local detail: `tmp/audit-followup-verify2.log`.

| Gate | Follow-up evidence | Comparison to `0003d64` |
| --- | --- | --- |
| Dependency shape, TypeScript, ESLint | Passed | Same gates |
| Product | 201 files; 4,580 passed, two opt-in live checks skipped; 26.82s | +58 passing tests, one new test file |
| Integration | Four passed; 2.42s | Same checks |
| Core coverage | 96.48% statements, 90.68% branches, 99.10% functions, 97.55% lines | Same or higher |
| Risk coverage | 94.24% statements, 87.25% branches, 96.90% functions, 96.17% lines | Same or higher; per-file floors passed |
| Production build | Passed; compiled in 2.7s | Single observation; no performance claim |
| Dependency security audit | Zero reported vulnerabilities, including dev dependencies | Point-in-time advisory check |

Affected maintained guidance was reconciled in README, CHANGELOG, METHODOLOGY,
PRIVACY, DECISIONS and this audit. The full run includes documentation, release
inventory and immutable-baseline contracts. Linux/Windows CI results for the
delivered commit are recorded on pull request #5 separately from this local run.

## Merge verification — 2026-10-04

The owner authorized merging after verification. The production changes at
`5b5cca4` passed [PR CI](https://github.com/eligorelick/Thesis-AI-equity-research/actions/runs/37183970733)
on Linux (full checks) and Windows (product/integration). The unchanged
[push CI](https://github.com/eligorelick/Thesis-AI-equity-research/actions/runs/37183968106)
also passed after one Windows retry. Its first attempt timed out at 8,376ms in
the export-cleanup test's existing 5,000ms limit, with no assertion mismatch.
The same case took 438ms in PR CI, 294ms in a passing local 13-test export
recheck and 515ms on retry. Export code, fixture and test were unchanged by the
follow-up. Investigation found no unbounded loop or causal link to that patch;
the exact source of the temporary delay remains unverified. No timeout,
assertion or coverage threshold was relaxed.

Pre-merge local verification reran all 4,580 product tests (two opt-in live
checks skipped) and four integration tests. The first parallel product run hit
another existing 5,000ms limit while a Next ESLint regression launched its real
lint subprocess (5,879ms, no assertion mismatch). All 28 tests in that unchanged
file then passed, with the affected case taking 342ms. The full product rerun
used Windows CI's `--maxWorkers=1` setting and passed in 169.06s. The precise
source of the timing variation was not established; no test limit was changed.
Logs: ignored `tmp/audit-merge-product*.log`, `tmp/audit-merge-eslint-recheck.log`
and `tmp/audit-merge-integration.log`.

A fresh isolated browser check used source matching the proposed production
code (apart from the documented preview-only build configuration). Research
workspace persisted across reload; DEMO report #5 completed with all AI passes
skipped, zero cost, spec 1.8.0 and the corrected two-year-history acceleration
gap. Its saved view and actual Markdown download retained these disclosures.
History kept report #4 (spec 1.7.0) readable and labeled its comparison with #5
not comparable because the spec versions differ. Current was restored after
testing. No private data or live provider inference was used; actual PDF
printing and comprehensive accessibility/platform testing remain unverified.

The merge-readiness documentation update preserves the confirmed F08 race and
all deferred recommendations above. `Unreleased` changelog headings remain
appropriate: merging source does not publish a packaged release or deploy it.
Final branch checks and the merge commit are linked from
[pull request #5](https://github.com/eligorelick/Thesis-AI-equity-research/pull/5).
