# Full codebase audit — 2026-09-06

**Status:** complete. Every section below is written; the closing verify run
is recorded in §1 step 5.
**Directive:** "Audit the entire codebase and ensure everything is the best
possible and based on extensive research/evidence/testing. Ensure no errors or
mistakes in the code or logic. And make sure all docs are 100% accurate to the
current codebase."

## 1. Method

1. **Baseline.** On the working tree as found (commit `94560ac` plus an
   uncommitted change to the stream idle guard, analyst-pass admission ordering,
   sibling abort, and the README cost table): `npm run typecheck` clean,
   `npm run lint` clean, `npm run test:product` 162 files / 3751 tests passing,
   2 skipped.
2. **Finder pass.** The repository was partitioned into 20 code slices, 11
   document slices and 3 evidence-base slices. Each slice was read in full by an
   independent reviewer with the instruction to report only evidenced defects
   (a wrong formula, a race, an invariant that can be violated, a comment or doc
   that misdescribes behaviour, a test pinning wrong behaviour, a choice not
   supported by evidence). 28 finder passes completed before the session limit
   interrupted the run; nine slices were read twice by independent reviewers,
   which is used below as cross-validation. 232 findings were reported.
3. **Verification.** Every finding is verified here by reading the cited code
   with its callers and tests, and where a runtime claim is made, by
   reproducing it. A finding is marked **confirmed**, **refuted** (with the
   reason), or **partly confirmed**. The slices no finder reached (the in-flight
   diff, tooling and CI, every document except the README, and the three
   evidence-base areas) are audited directly in sections 5–7.
4. **Remediation.** Confirmed defects are fixed in the same change, with a
   regression test where the defect was in code, and every document that
   describes the changed behaviour is updated in the same pass. Section 8 is
   the log.
5. **Close.** `npm run verify` on the finished tree, end to end: dependency
   shape verified; typecheck and lint clean; product suite 163 files / 3934
   tests passing, 2 skipped (from 162 / 3751 at the baseline: one test file
   and 183 tests added); integration suite 4 passing; core coverage contract
   95.85% statements / 89.57% branches / 99.09% functions / 96.95% lines
   against floors of 90 / 84 / 95 / 93; risk contract 93.88 / 86.00 / 96.75 /
   95.78 overall with every file above its per-file floors (dataOnlyReport.ts,
   which entered the contract in §3.9, at 82.4% branches after the test in
   §8.17); production build compiled; security audit 0 vulnerabilities.
6. **Live confirmation (2026-09-07).** With the owner's authorisation, one paid
   report on the finished tree: AAPL, `ANALYSIS_MODEL=claude-haiku-4-5`,
   `ANALYSIS_EFFORT=low`, `THESIS_MAX_JOB_COST_USD=4.9`, an isolated data
   directory, the entry-tier FMP key plus EDGAR, FRED, Finnhub and FINRA. The
   job finished in 5 min 8 s at $0.5977 (bull $0.1051 and bear $0.1234 on
   Haiku, judge $0.3692 on the Sonnet 5 floor), three requests, none
   repaired, every cost row settled `actual`, no lease left behind; the bear
   pass fired 20 s after the bull's first token (the prompt-cache gate);
   verification rate 100%; data completeness degraded with 0 critical and 10
   warnings (eight are the plan's 402 restrictions); the judge read the bear
   case first under `random`. The exports and the page carry the audit's
   disclosures (§8.21). Two defects the offline audit had not caught surfaced
   in the rendered report and are fixed in §8.21.

## 2. Finder coverage

| Slice | Passes | Findings reported |
| --- | ---: | ---: |
| providers/anthropic + leaseTiming + registry + env | 1 | 6 |
| jobRunner (admission) | 1 | 5 |
| jobRunner (lifecycle) + jobSteps + jobState + events | 1 | 6 |
| jobScheduler + store + artifacts + db | 2 | 13 |
| stageC/passes + index | 2 | 12 |
| stageC/payload + prompts + judgeProtocol + dataOnlyReport + provenance | 2 | 21 |
| stageC/citations + consistency + entityValidation | 1 | 14 |
| stageB/valuation + fairValue + scenarioTargets + projections | 2 | 17 |
| stageB/forensics + grading | 2 | 22 |
| stageB/returns + capital + growth + netDebt + betaEstimate + financialMetrics | 2 | 23 |
| stageB/sectorRouting + technicals + quarterWindows + stageA | 1 | 8 |
| compute + dataBundle + companyLoad + keyless | 1 | 6 |
| edgar/* + providers/edgar | 2 | 19 |
| providers/fmp, yahoo, finnhub, finra, fred, http + cache | 2 | 12 |
| report/* | 1 | 13 |
| app/api + requestSecurity + settings + watchlist | 2 | 6 |
| app/**/*.tsx + components | 1 | 14 |
| test-suite integrity | 1 | 9 |
| README.md | 1 | 6 |
| in-flight diff, tooling/CI, CHANGELOG, .env.example, METHODOLOGY, RESEARCH, PRIVACY, DATA-RIGHTS, specs, audit records, code comments, evidence base | 0 | audited directly below |

## 3. Verified findings by subsystem

Legend: **C** confirmed, **P** partly confirmed, **R** refuted (reason given).
"Fix" names the change recorded in §8. Finding numbers (F1–F232) index the
finder inventory; the same defect reported by two independent reviewers is
listed once with both numbers.

### 3.1 Anthropic provider, stage C passes, job runner, scheduler

| # | File:line | Finding | Verdict | Fix |
| --- | --- | --- | --- | --- |
| F7 | providers/anthropic.ts:494 | Mid-stream connection failures (undici body timeout, socket reset, premature EOF) surface as a bare `AnthropicError`, which `isRetryableTransportError` rejects; the pass result REJECTS instead of resolving a typed transport failure, no retry, usage dropped | C: `BetaMessageStream.#handleError` wraps non-SDK errors in a bare `AnthropicError` with `cause`, and the catch branch throws any non-`APIError` cause | bare stream errors classified as transport failures; the `cause` chain is walked for connection codes; a post-headers failure is presumed, not released |
| F8 / F157 / F155 | anthropic.ts:1879, passes.ts:1204 | A signal abort during the transport-retry backoff rejects `result` and never settles `firstToken`; `runBullThenBear` can wait forever | C: the backoff sleep sits inside the catch block with no handler | backoff abort caught: `firstToken` settles "abort", a typed aborted result carries prior billed attempts; the orchestrator races `firstToken` with the result |
| F9 | anthropic.ts:1462 | `pause_turn` resumption is a non-streaming `create()` with a hard 600 s client timeout and no idle guard; a resumed turn past 10 minutes is killed client-side while the server keeps billing, presumed at the maximum, then retried | C: `resumeIfPausedWithUsage` read; the SDK skips its own non-streaming guard when `timeout` is set | resumption streams through the same idle-guarded path as the first request |
| F10 | anthropic.ts:935 | A fallback-served message is priced at the serving model's rate for every token although `usage.iterations` carries the declined hop at its own price | C: SDK `BetaFallbackMessageIterationUsage` carries per-hop `model` and tokens | priced per iteration when the hops sum to the message usage |
| F11 | leaseTiming.ts:23, config/env.ts, .env.example | Invariant 4 and the README say the 600 s timeout bounds "the longest request the provider can hold open"; for a stream it bounds time-to-headers only | C (documentation) | invariant, config message and `.env.example` reworded; README regenerated |
| F12 | anthropic.ts:1261 | `max_tokens` gap and `error.maxTokens` report the pass constant while the request sent `effectiveMaxTokens` | C | the sent limit is reported |
| F151 / F160 | passes.ts:1289 | Sibling-abort relabel applied after the settlement hook persisted the raw provider message | C | relabel applied inside the settlement chain |
| F152 / F159 | passes.ts:1185 | A job-level abort relabels BOTH sides as abandoned because of the sibling | C | the sibling is aborted with a sentinel reason; no relabel when the job signal aborted |
| F153 | passes.ts:1750 | `THESIS_JUDGE_ORDER=both`: the mirrored request on a validation retry carries the primary's repair-in-place feedback, so reconciliation compares two repairs of one document | C | on a retry the mirror is not run and reconciliation is disclosed as not performed |
| F154 / F46 | passes.ts:1102, anthropic.ts:1860 | A deliberately aborted stream settles at the `message_start` snapshot as an `actual` row; generated-then-abandoned output is under-recorded and can never be reconciled | C (design): D-09 presumes the remainder for a dead stream and an abort after generation started has the same unknown | an abort after `message_start` settles reported usage plus the presumed remainder, flagged presumed; comment corrected |
| F156 / F161 | tests | No deterministic test for bear backing out after its lease, the sequential short-circuit, or the relabel guard | C | tests added |
| F158 | passes.ts:694 | Casing normalizer omits `entity`, so `kind: "Entity"` burns a paid judge retry | C | `entity` added |
| F162 | passes.ts:2856 | Standalone `runJudgeVerifyAssemble` under `both` sends one request while the framing promises two and stamps `setting=both` with no reconciliation | C | standalone path forces a single-order presentation |
| F44 | jobRunner.ts:4188 | Presumed-spend disclosure filtered to the current generation while `meta.costUsd` sums every generation | C: `sumLoggedCost` is by job id | filtered by job id |
| F45 | jobRunner.ts:4078 | Discarded-attempt marking reads current-generation artifacts only | C | every generation's artifacts read |
| F47 | jobRunner.ts:3514 | `settleMissingSide` labels every retryable rejection `schema`; the facade records `parse` for non-JSON | C (low) | the facade passes the failure kind (`bullFailureKind`/`bearFailureKind`) and the runner records it |
| F48 | jobRunner.ts:2956 | Verify checkpoint's per-request admission never registered (latent: production verify is not billable) | C (latent) | registered |
| F49 | jobRunner.ts:2637 | Stage B exception recorded nowhere in the persisted data-only report; the `analysis.llm` reason claims pass errors are in the manifest | C | compute failure filed as a critical `pipeline.compute` gap with a specific reason; model-resolution and launch-authority paths get their own reasons |
| F50 | tests | No test for the Stage B-throws branch | C | test added |
| F51 | jobRunner.ts:3131 | Assembly failure over a reused synthesize artifact reports "after 3 attempt(s)" after one provider-free attempt | C | actual attempt count and reused-artifact wording |
| F52 | jobRunner.ts:1149 | `admission.settle/release` drop the request lease from the renewal map before the durable write; a thrown write loses the measured usage and the lease expires into a presumed maximum | C | map entry removed only after the write commits |
| F53 | jobRunner.ts:2174 | `resume` JSDoc says a missing snapshot "starts fresh"; a terminal row without a plan throws | C | JSDoc corrected |
| F54 | leaseTiming.ts:12 | Invariant 1 describes a 5-minute heartbeat; the runner renews at TTL/4 | C | invariant and config message corrected |
| F68 / F76 | jobScheduler.ts:353 | Presumed rows stamped at sweep time; reconciliation buckets by `createdAt`, so an overnight sweep zeroes real spend against the wrong day | C | presumed row stamped with the lease's own `acquiredAt` |
| F69 / F77 | jobScheduler.ts:1681 | A late pass settlement is refused while the expired lease row still exists but accepted once any unrelated prune has presumed it; a zero-reservation (request-mode) pass lease is always refused after expiry, so the pass artifact is lost and a resume re-bills | C | an expired, unswept exact lease is settled directly (same end state as presume-then-settle); request rows `<attemptId>#rN` count as settlement authority for a swept zero-reservation pass lease |
| F70 | jobScheduler.ts:526 | `settleRequestCost` deletes the lease and adds cost without versioning the snapshot, finalizing a terminal job or waking the pump; the SSE stream never delivers the change | C | finalizes, versions and pumps like the other deletion paths |
| F71 / F78 | jobScheduler.ts:473 | Over-reservation throws before recording the measured (higher) cost; the lease later presumes the lower maximum | C | measured row committed first, then the invariant error is raised |
| F72 | jobScheduler.ts:614 | Reconciler excludes already-reconciled presumed rows from the bucket's accounted total, so a second run over-counts | C | accounted total is every row that is not an unreconciled presumption |
| F73 / F79 | jobScheduler.ts:604 | Bucket bounds compared as raw strings; RFC 3339 bounds without milliseconds mis-bucket the first second of every day | C | bounds normalised |
| F74 / F80 | db/schema.ts:235 | `attemptId` comment calls NULL transitional; it is load-bearing for presumed rows | C | comment corrected |
| F75 | tests | No cross-bucket sweep/reconcile test | C | test added |

### 3.2 Report layer, API routes, data bundle

| # | File:line | Finding | Verdict | Fix |
| --- | --- | --- | --- | --- |
| F55 | report/schema.ts:148 | The rating gate's own message ("buy/sell/hold rating language …") matches the rating-label pattern, so a manifest reason quoting a rating rejection fails `ReportSchema` and the data-only report is sterilised to a shell | C: `noBuySellHold(NO_RATING_MESSAGE) === false` on the old wording | message reworded so it never matches; exported and pinned by a test |
| F56 | report/schema.ts:119 | First-person and "recommend" patterns have no operational-object exclusion; the docstring's own ALLOWED examples ("hold the line on costs", "hold margins steady") are rejected, and "buy now, pay later" fails every fintech report | C: probe against the patterns | negative lookahead for operational objects and product wording; battery extended both ways |
| F57 | report/schema.ts:159 | `sourceId` scanned while the identical `source` is exempt, so a cited URL slug ("…strong-buy…") fails a pass | C | `sourceId` and `attemptedSources` exempt |
| F58 | export/markdown.ts:642, printHtml.ts:601, charts/SensitivityHeatmap | Sensitivity grid prints "$" regardless of the per-share currency | C | cells formatted in the currency of `valuation.dcf.perShare` on all three surfaces |
| F59 | export/markdown.ts:573 | Route-metrics cells escaped twice (stand-in marker becomes literal `\_`) | C: `markdownProse` then `markdownTableCell` | raw cells handed to the table; plain "(stand-in)" marker |
| F60 | export/markdown.ts:1134 | Header "Cost (USD)" prints `meta.costUsd` (4 dp) while its own appendix total, print and live sum the rows (6 dp) | C | header uses the displayed row total |
| F61 | export/markdown.ts:1008 | Hard-coded section numbers (12 Macro, 13 Appendix, "1b"/"11b") disagree with the shared manifest, print and live view | C | headings built from `REPORT_SECTION_MANIFEST`; Scorecard is a sub-heading of Verdict as on print |
| F62 | export/markdown.ts:1118 | Markdown never renders `meta.execution` (judge floor, effort stripped, fallback, model rejected) | C | "Pass execution" row added, same text as print |
| F63 | export/correctedCli.ts:100 | Corrected export overwrites persisted execution entries and drops `discarded` flags | C | persisted execution kept when present; discarded marking carried by ledger position |
| F64 | report/execution.ts:74 | Model-floor disclosure inferred from a haiku→sonnet family pair on every step instead of the registry floor on synthesize | C | keyed on `judgeFloorModelId()` and `step === "synthesize"` |
| F65 | report/format.ts:52 | `formatLargeNumber` picks the scale before rounding ("1000.0K", "1000.00B") | C | scale chosen on the rounded mantissa |
| F66 | report/format.ts:18 | Pipeline units (shares, pp, pp/yr, rsi, rank, score, fraction, z, days, quarters) fall to the generic "2 decimals + word" fallback | C (payload.ts emits them) | rendered on their own terms |
| F67 | tests/report.query.test.ts:433 | Comment says the query has no id tiebreak; it orders by `createdAt DESC, id DESC` | C | comment corrected |
| F13 | api/report/route.ts:16 | JSDoc says the build never hard-depends on stageC and an absent module degrades | C: resolvePasses uses a static-specifier import | JSDoc corrected |
| F14 | GenerateReport.tsx:7 | Header says POST answers 409 for an active job; it answers 202 `existing: true` | C | header corrected |
| F15 | jobRunner.ts:1520 | `isSymbolJobActive` JSDoc says POST rejects duplicates; only the retry route uses it | C | JSDoc corrected |
| F16 | api/report/[jobId]/stream/route.ts:141 | SSE heartbeat re-arm untested | C | test: two heartbeats over 30 s, subscriber released on abort |
| F17 | app/requestSecurity.ts:153 | `THESIS_ALLOWED_HOST=host:80` never matches the bare Host browsers send; every request 403s | C: `sameAuthority` compares ports literally while the Origin path folds defaults | default port folded by request protocol; `.env.example`/README say so; tests |
| F18 | api/report/[jobId]/retry/route.ts:49 | Status gate runs before `reconcileExpiredJobClaims`, so a job whose worker died is "still active" forever | C | reconcile runs before the row read; tests for an expired and a live target |
| F19 | pipeline/keyless.ts:528 | Under `edgar` mode the manifest says "FMP returned no rows" when rows arrived, and files the configured substitution as unexpected | C | reason names the policy; `expected: true` |
| F20 | pipeline/keyless.ts:768 | A member EDGAR cannot build silently keeps FMP's rows under `edgar` mode | C (docs say rows are ignored) | member becomes a gap naming the withheld vendor rows; env.ts and README-NOTES-WS4 state it |
| F21 | pipeline/keyless.ts:914 | `fmp` mode still appends EDGAR predecessor rows | C (D-12 "never backfill") | predecessor append skipped under `fmp`, disclosed as an expected info entry |
| F22 | pipeline/dataBundle.ts:1964 | After a backfill the plan-limit entry still says "history depth is truncated" | C | entry reworded when the member's endpoint carries "(older periods)"; `planLimitManifestEntry` exported and unit-tested |
| F23 | pipeline/keyless.ts:234 | A plan-clamped 5-row market-cap history counts as served; the keyless derivation never runs | C: the process-wide clamp applies to the date-range `historicalMarketCap` spec (`limit: 5000`) | older days derived (close × filed shares) and appended with `source: "computed"`, disclosed like a statement backfill |
| F24 | pipeline/compute.ts:1121 | Altman market cap stamped with the income-statement date as its as-of | C | as-of taken from the envelope that supplied the figure |
### 3.3 EDGAR: XBRL statements, extraction, splits, SIC, successor lookup

| # | File:line | Finding | Verdict | Fix |
| --- | --- | --- | --- | --- |
| F25 | edgar/statements.ts:2316 | The statements builder selects the bank chain by tagging alone (`looksLikeBankTagging` needs the ASC-606 tags ABSENT); a bank that tags its fee revenue under ASC 606 publishes fee income as revenue, with every margin, multiple and growth rate downstream wrong | C | `StatementBuildOptions.bankRevenue`; `keyless.ts` sets it from the registrant's SIC (`bankStatementRouting`, bank industries only) for the issuer's and the predecessor's builds; the note names which rule fired |
| F26 | edgar/xbrl.ts:528 | "re-confirmed at JPM/BAC/WFC/C" on the tagging heuristic contradicts statements.ts ("at BAC/WFC/C RFC carries fee-only revenue"); the fixtures hold JPM evidence only | C | both comments reworded to what the fixtures show; the heuristic is described as a tagging test, not a bank test |
| F27 | edgar/tagSynonyms.ts:44, xbrl.ts:110 | The ASC-606 element precedes `Revenues`; a filer tagging both for one period (a lessor, an oil major's "total revenues and other income") resolves the subset while the vendor reports the total | C (taxonomy definitions) | `Revenues` first in both chains; RESEARCH.md §2.8 records the evidence; resolution stays period-scoped, so AAPL after FY2018 still resolves the ASC-606 element |
| F28 | edgar/statements.ts:813 | Reporter/dedup keys are exact `start\|end`, so a period re-reported a day off its original never links to it for labels or `original` | P | not changed: the value lookups already tolerate ±3 days and pick the latest copy (F35 fixed the cross-check side); a tolerant reporter link would also merge a genuine transition period with its neighbour. No fixture shows a filer re-dating a period |
| F29, F43 | edgar/statements.ts:1174 | A sign-flipped field keeps its `original` unsigned: a buyback restated from 90 to 95 compares −95 against 90 and raises a −206% restatement flag for a 5.6% change | C | `original.value` carries the row's sign |
| F30, F41 | edgar/statements.ts:1888 | An own-period 10-Q's `fy` is ignored, so the newest quarters of a non-calendar filer (filed after its last 10-K) carry the calendar year | C | a 10-Q's `fy` is trusted for a quarterly row inside the own-report lag window; comparatives in later 10-Qs still fall back |
| F31 | edgar/extract.ts:855 | `NOT_REQUIRED_RE` is end-anchored; "Not required for smaller reporting companies." is reported as a stub, not as not-required | C | the smaller-reporting-company / Rule 12b-2 wording is matched inside a short body |
| F32 | edgar/extract.ts:1370 | Every quoted stub title outranks the generic synonyms for whatever section is being extracted; a stub quoting both targets hands the MD&A title to the risk-factor search | C | a quoted title naming another section kind is dropped |
| F33 | edgar/successor.ts:145 | "Has its own history" is any us-gaap concept; a successor's first 10-Q fills the concept list and blocks the predecessor hop that the whole mechanism exists for | C | `hasOwnAnnualHistory` (an annual core-form duration fact) at both hops and the keyless warning gate |
| F34 | edgar/statements.ts:747 | `commonDividendsPaid` aliases `netDividendsPaid` (the total); a preferred issuer's common dividend is overstated by the preferred coupon | C | own chain: common element, else total less preferred (disclosed), else total |
| F35 | edgar/xbrl.ts:330 | With an explicit start, several surviving copies of one period return in payload order | C | latest filed, amendment on a tie, then accession |
| F36 | edgar/statements.ts:252, xbrl.ts:215 | Quarter band 70–110 days rejects a 16/17-week fourth quarter (Costco's 12-12-12-16 calendar) as a tagged quarter, breaks the previous-quarter link, and fails the cross-check's Q hint | C | band 70–125 (`QUARTER_DURATION_DAYS`, shared) |
| F37 | edgar/splits.ts:265 | The repeat window is measured from the applied event; a ratio re-tagged in every later filing walks out of it and is applied a second time on no evidence | C | measured from the previous same-ratio tag; a same-ratio tag with no restated evidence after an applied event is a `warn` and never applied |
| F38 | edgar/extract.ts:908 | The mini-TOC redirect treats an all-caps peer as an equal boundary; an all-caps subsection truncates the MD&A and returns the fragment as ok | C | named boundary first, all-caps fallback disclosed (as the exhibit path already did) |
| F39 | edgar/xbrl.ts:76 | Form 40-F is not a core form; a multijurisdictional filer builds no statements and "no 10-K or 20-F" reads as no annual report | C | 40-F/40-F/A core; annual-form set, fiscal-year label, ADR flag, `selectAnnualFiling` third choice, gap wording |
| F40 | edgar/statements.ts:28 | Invariant 3 says a restated FY is never netted against an unrestated YTD "or vice versa"; the code nets the minuend against the lineage copy, and refuses only when no copy filed on or before the minuend exists | C (wording) | invariant reworded to the behaviour |
| F42 | edgar/sic.ts:208 | Major group 49 maps the 495x sanitary-service codes (Waste Management, Republic Services, Clean Harbors) to Utilities | C | 4953/4955/4959 → Industrials / Waste Management |

### 3.4 Stage B forensics and grading (F81–F102)

Two finders covered forensics.ts independently; where both reported the same
defect the row lists both numbers. Verdict codes as in §3.1. The remediation
is §8.11; the audited-fixture leaves it moved are the delta group
`forensics-and-grading-audit-2026-09-06` (decision D-24).

| # | File:line | Finding | Verdict | Fix |
| --- | --- | --- | --- | --- |
| F81, F94, F82 | forensics.ts:1271; the test at stageB.forensics.test.ts:710 | Piotroski EQ_OFFER coerces a missing `commonStockIssuance` to 0 and awards the point; every sibling signal returns not-evaluable. Probe: deleting the field scores 9/9. The keyless path resolves one element only, so a filer tagging its proceeds elsewhere gets a free point | C | `na(...)`, denominator reduced, gap reworded "not evaluated (signal withheld, denominator reduced)"; the test now expects null and out of 8 |
| F83, F99 | forensics.ts:756 | RESEARCH §6.1 says the Beneish indices are withheld below a revenue floor; the code withheld only at revenue ≤ 0. Probe: $20k → $5M clamps SGI to 10, SGAI to 0.1 and prints a "flag" M-score with no gap | C | `BeneishOptions.revenueFloor` (default the house floor of 10M, applied to either year, gap names the floor and both revenues); `ForensicsInputs.revenueFloor` forwards it; toy-scale fixtures pass 0 |
| F84 | grading.ts:672 | A reduced Piotroski battery (2/2 on a two-year bank) is banded on the nine-signal breakpoints at full weight and full data completeness: a 76-point swing on two binary tests | C | `Signal.evidenceFraction` scales a signal's weight in `scoreAspect`; Piotroski passes `outOf / 9`, so completeness falls with the withheld signals (D-24) |
| F85, F95 | RESEARCH.md §1.4 vs forensics.ts:2098 | The evidence base says a missing market cap falls back to a book-equity Z; the code deliberately withholds the Z and substitutes Z′ only on a currency mismatch | C (docs) | §1.4 rewritten to the behaviour: a currency mismatch is structural and falls back to Z′; a missing market cap is usually transient and the Z is withheld with a gap |
| F86, F96 | RESEARCH.md §5.2 vs forensics.ts:1670 | §5.2 describes `inventory-overhang` as a sustained multi-year level test; the code fires it on a one-year revenue decline with inventory still growing, and no level test exists | C (docs) | §5.2 describes the implemented demand-decline rule and says the growth-gap comparison is suppressed when it fires |
| F87, F97 | forensics.ts:1319 | The two-year note says "F-score reported out of 7" on a FIN-OTHER issuer whose denominator is 3 (probe: label "3 of 9", note "out of 7") | C | both two-year notes follow the tally and interpolate the actual denominator |
| F88 | forensics.ts:394 | The last-resort X3 reconstruction starts from total net income, discontinued operations included: probe +0.40 on Z″ from a 60-of-80 discontinued result | C | `continuingNetIncome(inc)`, note reworded |
| F89 | forensics.ts:1360 | The comment says the payload/UI render `PiotroskiResult.label`; nothing consumed it, so the "financial variant … withheld" wording never reached a reader | C | payload.ts uses the label as the figure's label; the comment names the consumer and the grading weight |
| F90, F100 | forensics.ts:1938, :567; RESEARCH.md §6.3 | An orphaned JSDoc and the `selectAltmanVariant` JSDoc state the financial band as 6000–6799 and Piotroski as fully computed for financials; the code excludes major group 65 and withholds four or six signals | C | orphaned block deleted; JSDoc and the SIC note say 6000–6499 or 6700–6799; RESEARCH §6.3 likewise |
| F91 | forensics.ts:577; RESEARCH.md §1.4 | `z2-em` is implemented but no caller sets `isEmergingMarket`; §1.4 said it "is used" for emerging-market issuers | C (docs) | §1.4 says the variant exists for callers and is never selected automatically |
| F92 | forensics.ts:835 | DEPI is built from combined depreciation and amortisation; Beneish defines the rate on depreciation of PP&E, and nothing said so | C | note on the number when both rates exist; RESEARCH §2.1 "House rule — the DEPI basis" |
| F93 | grading.ts:681 | The `altmanZ` driver publishes the value rescaled to the original scale, in unit "z", so the drivers table disagrees with the forensic card for every non-original variant | C | driver renamed `altmanZOriginalScale`; the quality note says the band grades the original-scale figure |
| F98 | forensics.ts:1669 | `inventory-overhang` tests the unfloored revenue growth, so it fires in the same result that announces growth flags are suppressed for a sub-floor base | C | the flag uses the floored `revGrowth`; `rawRevGrowth` removed |
| F101 | forensics.ts:2104 | The Z′ substitution on an ADR re-appends every note and gap the private computation already emitted (the EBIT-fallback note printed twice) | C | only notes and gaps the private result lacks are appended |
| F102 | compute.ts:1121 | `AltmanResult.asOf.marketCap` carried the income-statement date while X4 used the current quote's market cap | C | the as-of is the profile's or quote's own date; the audited fixture's leaf moved from 2025-12-31 to 2026-07-06 (D-24 group) |

### 3.5 Stage B returns, capital, growth, beta, net debt, REIT metrics (F103–F125)

Two finders covered returns.ts and capital.ts independently; duplicate
findings share a row. The remediation is §8.12; the audited-fixture leaves
that moved are the delta group `returns-capital-audit-2026-09-06`
(decision D-25).

| # | File:line | Finding | Verdict | Fix |
| --- | --- | --- | --- | --- |
| F103 | returns.ts:1177, :646, :772 | Invested capital, the effective cost of debt and the debt weight use the provider's lease-inclusive `totalDebt` against a NOPAT, EBIT and interest expense that are already after operating-lease cost (ASC 842); the EV bridge removes that slice by default and nothing here did. A discount retailer's ROIC read 6% instead of 11% and its effective Rd fell below the band | C | `ReturnsBalanceRow.operatingLeaseLiability` (EDGAR route) is removed from invested capital and from the WACC's debt average, on the same `THESIS_EV_INCLUDE_LEASES` switch as the EV bridge; the notes state the basis and say when no split is disclosed (FMP). `priorYearCostOfDebt` on the same basis |
| F104, F117 | financialMetrics.ts:244 | `PaymentsToDevelopRealEstateAssets` (development spending) was summed as "recurring capital expenditure" and the AFFO marked exact; a developer REIT's AFFO was understated by its whole pipeline | C | recurring tags are `PaymentsForCapitalImprovements` only; a development-only filer falls to the disclosed approximate all-capex floor |
| F105 | returns.ts:556, :721, :756 | On a financial route the tax-shield, market-cap and ADR-currency WACC gaps stayed critical (blocking the report) although the same function had already downgraded the interest-expense gap because no financial route consumes a WACC | C | one `waccGapSeverity` for every WACC-only gap (tax shield, weights, currency, unavailable cost of debt): warn on a financial route with the reason saying why, critical elsewhere |
| F106 | capital.ts:795 | The buyback price proxy divides reporting-currency repurchases by a quote-currency, per-ordinary-share price and compares it with a per-ADS quote; every other market-cap consumer guards the ADR case, this did not (a 2:1 ADS reads as a 100% discount) | C | `CapitalOptions` (reported/quote currency, ADR flag); on a mismatch or an ADR the proxy and the premium/discount are withheld with a note and an info gap |
| F107 | capital.ts:343 | Cash-flow rows joined to income rows by exact date string; a one-day fiscal drift silently nulled capex intensity, SBC % of revenue, own EBITDA and the buyback proxy with no gap (compute.ts and returns.ts already tolerate ±5 days) | C | `rowForDate` (±5 days) for every join; an unmatched cash-flow year is named once as `capital.statementJoin` |
| F108, F118 | returns.ts:1306 | ROTE treated a vendor `preferredDividendsPaid` of 0 as disclosed while preferred stock was outstanding, crediting the preferred coupon to common on exactly the issuers the metric exists for | C | a 0 beside outstanding preferred is undisclosed (the interest-expense convention); ROTE withheld with a note saying so |
| F109 | growth.ts:339 | A 0.6-year spacing tolerance let a six-month transition period be annualised as a full year with no note; the share-count trend used the same figure | C | `IRREGULAR_SPACING_TOLERANCE_YEARS` = 0.1 (a 52/53-week calendar is 0.02); capital.ts imports the constant; the stub compounds over its real span and is annotated |
| F110, F121 | betaEstimate.ts:126 | The month in progress entered the regression as a full monthly return; a two-session earnings move shifted the slope by a tenth in the probe, on every run not on a month end | C | `isMonthComplete` (last observation on or after the 26th); the newest month of either series is dropped otherwise and the note names it |
| F111 | returns.ts:639 | The de-minimis note said "synthetic rating used" unconditionally, beside "cost of debt and WACC unavailable" | C | the note is written after the synthetic path and names what ran |
| F112, F123 | returns.ts:673; compute.ts:1557 | The coverage note said "on TTM" whatever the caller supplied, and the two annual fallbacks were independent, so a TTM EBIT could be scored against a fiscal-year interest expense (a notch of rating) under that label | C | one statement basis for both legs in compute.ts (TTM when both, else annual for both, mixed as the labelled last resort); `WaccInputs.currentCoverageBasis` printed in the note |
| F113, F119 | returns.ts:1381 | The ROIC headline note described a cash-only invested capital and cited "§2.2" of a document that does not exist, while the series netted cash + short-term investments | C | note states the basis that runs (NET_DEBT_V1, cash + STI, the lease rule, METHODOLOGY "EV bridge") |
| F114, F120 | returns.ts:127; betaEstimate.ts:87; METHODOLOGY.md:54 | Two Blume weightings (0.67/0.33 and 2/3–1/3) printed two unequal "Blume-adjusted" betas for one raw slope in a keyless report; RESEARCH §7.1 said the report prints 0.667·raw + 0.333 and the WACC did not | C | returns.ts imports the constants from betaEstimate.ts; both notes print 0.667·raw + 0.333; METHODOLOGY says one constant pair; the anchor test is 1.28 (D-25) |
| F115 | returns.ts:1369, :1273, :1504 | ROIC, ROTE and DuPont iterated raw annual rows: a restated fiscal year entered twice (the duplicate on a single-period base) and the balance lookup could pick the superseded copy; four distinct years plus a duplicate satisfied the terminal-ROIC rule's "four fiscal years" | C | `normalizeAnnualRows` (the growth module's rule) in all three, rejected periods as gaps, the collapse noted; `filingDate`/`acceptedDate` carried through compute.ts |
| F116 | capital.ts:316 | The same duplicate in computeCapital summed buyback dollars twice and double-weighted the year in the capex slope | C | `normalizeAnnual` on all three statement lists |
| F122 | returns.ts:646; compute.ts:928 | TTM interest expense was divided by the average of two fiscal-year-END balances, up to three quarters stale (a debt issue after year end doubled the measured rate) | C | with a TTM numerator, `totalDebtSnapshot` averages the quarter-end balances at the TTM window's ends; the basis string names the pair (`WaccInputs.totalDebtBasis`, `WaccResult.debtBasis`, disclosure block) |
| F124 | netDebt.ts:87 | The combined-cash conflict check ran only when both components were present; a combined field of 0 beside cash 100 was accepted and overstated net debt by the whole cash balance | C | a combined field below the cash balance is a conflict whether or not short-term investments are reported |
| F125 | capital.ts:511 | Own EBITDA accepted a cash-flow D&A of 0 (EBITDA = EBIT) and never consulted the vendor field the file falls back to elsewhere | C | D&A must be positive; otherwise the vendor `ebitda` with a note naming the placeholder |

### 3.6 Stage B sector routing, technicals, staleness (F126–F133)

One finder covered sectorRouting.ts, routingEvidence.ts, technicals.ts and
the Stage A staleness check. The remediation is §8.13. No audited-fixture
leaf moved (the fixture is a plain non-financial filer with a full price
history).

| # | File:line | Finding | Verdict | Fix |
| --- | --- | --- | --- | --- |
| F126 | sectorRouting.ts:293 | The SIC fallback band 6020–6199 sent non-depository credit institutions (61xx: consumer finance, mortgage bankers, business credit) to the bank map, contradicting sic.ts, validate.ts and the SEC major-group table the module cites; a card issuer with no deposits was graded on deposit and NII signals it cannot have | C | the bank band is the depository classes only (6020–6036); 6300–6399 insurer, 6400–6499 general (fee-based), 6798 REIT, everything else in 60–67 general; the sector string "Financial Services" alone decides general |
| F127 | sectorRouting.ts:358 | XBRL evidence silently re-routed a profile whose industry, SIC and sector were all NON-financial (a real-estate operator with one `RealEstateInvestmentPropertyNet` tag became a REIT); the single-tag equity-REIT rule needed no corroboration | C | a known non-financial industry beside a non-financial SIC is itself a classification (`classificationDecidedNonFinancial`; `sicIsFinancial` is 6000–6499 ∪ 6700–6799, so real-estate operators 65xx/66xx are not financial for this purpose); evidence against it is filed as `route.evidence.conflict` and changes nothing; evidence decides only where industry is absent or the SIC/sector already says financial |
| F128 | routingEvidence.ts:16 | The header called the mortgage-REIT rule "the one rule that fires on a single tag group"; the equity-REIT rule also does | C | header rewritten: two single-group rules, and only the mortgage one needs corroboration because it re-routes between two financial maps |
| F129 | tests/stageB.sectorRouting.test.ts:145 | The test pinned "SIC 6411 → insurer"; 6411 is Insurance Agents, Brokers & Service, the fee-based class the module deliberately keeps on the general map | C | test asserts 6411 → general and 6331 → insurer |
| F130 | technicals.ts:1327 | A short price history (a vendor cap, a keyless window) was reported as a "(recent-IPO overlay)" in a user-facing flag and a manifest gap the LLM reads, so a 40-year filer was described as newly listed | C | the gap and the flag say "insufficient price history (N sessions, need M)" and name no listing event; the recent-IPO wording is reserved for the profile's IPO date |
| F131 | technicals.ts:1373 | The deep-drawdown flag was labelled "Max 1y drawdown" when the window was shorter than a year, the same false statement `range52w` had already been fixed for | C | the flag names the window it measured ("max drawdown over the N-session window") |
| F132 | stageA/validate.ts:669 | Fundamentals staleness assumed a 10-Q cadence, so a semi-annual 20-F filer (ADR) read "STALE FUNDAMENTALS — more than one filing cycle behind" for most of every year | C | `ValidateProfileRow.isAdr`; an ADR is judged against the half-year cadence (`FOREIGN_PRIVATE_ISSUER_HALF_YEAR_DAYS` = 183; limit 313 days) and the reason names the cadence assumed |
| F133 | sectorRouting.ts:1301 | The recent-IPO, pre-revenue and unprofitable degradation disclosures promised replacements nothing computes (since-IPO high/low and growth, lock-up timing, cash-runway years) | C | each disclosure names only what the pipeline actually withholds and what it substitutes; nothing is promised that is not built |

### 3.7 Stage B valuation, scenarios, projections, fair value (F134–F150)

Two finders covered valuation.ts, scenarioTargets.ts, projections.ts and
fairValue.ts independently; duplicate findings share a row. The remediation is
§8.14; the audited-fixture leaves that moved are the delta group
`valuation-routing-audit-2026-09-06` (decision D-26).

| # | File:line | Finding | Verdict | Fix |
| --- | --- | --- | --- | --- |
| F134, F143 | scenarioTargets.ts:200, compute.ts:1317 | The bull and bear targets bridged with the raw net debt compute.ts held while the base DCF bridged with net debt less the operating-lease liability, so once the lease adjustment fired a bull target could be published below the base fair value | C | `DcfResult.bridge` (net debt, diluted shares, minority, preferred) is the bridge the base actually used; scenario targets and the projection fan read it from the result and the separate inputs are gone (D-26) |
| F135 | tests/stageB.scenarioTargets.test.ts:221 | The ordering invariant was pinned only under a fixture that could not reproduce the lease-adjusted bridge | C | the suite builds the targets from a base result whose bridge differs from the raw inputs and asserts bear ≤ base ≤ bull |
| F136, F144 | projections.ts:428 | The assumption line always said the base path was "anchored to analyst consensus", with no analyst estimates present | C | the line is generated from `growthAnchor` and names the methods that actually anchored it |
| F137, F145 | projections.ts:389 | The manifest entry said "scenario fan suppressed" while the fan was produced | C | info-level: "N nonconsecutive fiscal interval(s) excluded from the growth and correlation dispersion — the scenario fan is built from the remaining annual steps"; `ScenarioDispersion.skippedPairs` carries the count |
| F138 | valuation.ts:83 | The EBIT-margin clamp [−20%, 45%] and sales-to-capital clamp [0.5, 5] bind materially (a payments network lost a third of its DCF to the 45% ceiling) and appeared in no methodology document | C | the ceiling is 45% or the issuer's own five-year maximum, whichever is higher, with one note when it binds; METHODOLOGY "Two guards bound the paths" and RESEARCH §7.5 list both as broken-input guards |
| F139, F149 | specs/2026-09-02-analysis-quality-design.md:233 | The dated spec still described the "lower of 3y/5y CAGR" and sign-disagreement growth rules as implemented; D-18 retired both | C | superseded notes at §1, §8, the tests list, the PFE/GE rows and the closing paragraph |
| F140, F146 | valuation.ts:823 | The tax basis printed "TTM effective rate X%" when the TTM rate was not computable and X was the historical median | C | basis says "effective rate not computable (pre-tax income ≤ 0 or tax expense missing) — held at the company historical median X% for all N years"; `valuation.dcf.ttmTaxRate` info gap |
| F141, F147 | valuation.ts:3059 | The REIT implied cap rate divided NOI by market cap + net debt only, omitting preferred, minority interest and the lease convention the multiples and the DCF bridge use — two enterprise values in one report | C | `ReitInputs` carry preferred, minority and the operating-lease liability with `includeLeasesInEv`; the note prints the components and names it the house definition |
| F142 | fairValue.ts:118 | A DCF that valued the equity below zero published a negative per-share and an upside below −100% while the sibling module asserted common equity cannot be worth less than zero | C | the per-share is floored at 0 under limited liability, `valuation.dcf.perShare.floor` (warn) carries the unfloored figure and the basis line says so |
| F148 | valuation.ts:1919 | The own-history P/FFO rank compared a NAREIT fiscal-year FFO (gains, impairments and real-estate-only depreciation netted) against a net income + total D&A rolling-TTM history; the parity comment was stale | C | `NareitFfoResult.netIncomePlusTotalDa` says whether the current figure is the same construction as the history; when it is not, the P/FFO and P/AFFO bands are withheld with `valuation.multiples.ownHistory.ffoBasis` |
| F150 | valuation.ts:1256 | The sensitivity grid held the terminal ROIC level fixed while varying the WACC, so a −1pp WACC row earned a phantom +1pp excess and the g-axis reversed sign across rows under the default rule | C | each cell holds the base case's excess (terminal ROIC − WACC) at its own WACC; the note states the excess held; a zero-excess grid is non-decreasing in g in every row |

### 3.8 Stage C prompts, judge protocol, payload, data-only report, verification (F163–F197)

Three finders covered prompts.ts, judgeProtocol.ts, payload.ts,
dataOnlyReport.ts, provenance.ts, consistency.ts, entityValidation.ts and
legacyEntitySafety.ts; duplicate findings share a row. The remediation is
§8.15. The payload fingerprint pin moved with the Stage B wording changes of
§8.12 and §8.14, not with this slice: none of these changes touches the
prompt bytes of the audited fixture (its news rows sit inside the budget, so
no news disclosure note is added).

| # | File:line | Finding | Verdict | Fix |
| --- | --- | --- | --- | --- |
| F163, F173 | prompts.ts:149 | The analyst prompt stated a truncation order (catalysts, then risks, then drivers) the pipeline does not apply: evidence is dropped first and the thesis last | C | the prompt names the order `TRIM_ORDER` applies: evidence entries first, then catalysts, risks, drivers |
| F164 | judgeProtocol.ts:255 | With a 40-char floor the text-shortening stage replaced every claim, the thesis included, with a bare marker; a case whose bulk sat outside the claim texts was made LONGER by the "shortening" and still reported as capped | C | `MIN_CLAIM_TEXT_CHARS` = 160; lengths are measured serialized (the marker's line breaks escape to two characters each); the budget tightens from the original texts until the case fits or the floor is reached; a case still over the cap says so in the disclosure |
| F165 | payload.ts:280 | `truncateWithDisclosure` returned a marker-only string longer than `maxChars` when the budget was smaller than the marker | C | when the counted marker plus one character does not fit, the bare `…[TRUNCATED]` marker is used, itself cut to the budget; the result never exceeds `maxChars` |
| F166 | tests/stageC.judgeProtocol.test.ts:761 | No test exercised evidence-first dropping or bulk outside the trimmed arrays | C | three tests: evidence drops first with the claims untouched; a single 30,000-char thesis is shortened, not erased; a case whose bulk is one huge source string reports the residual |
| F167, F177 | dataOnlyReport.ts:619 | Data-only segment shares divided by the positive values only and nulled negative rows; the LLM path divides by the net total, so the same feed gave different shares on the two paths | C | the same net denominator as `applySegmentShares`; an elimination row carries a negative share and the shares add to 100; a test asserts byte-equality with the LLM path |
| F168, F176 | dataOnlyReport.ts:590 | Every data-only macro row was stamped "index" at the raw served value: CPI YoY read as an index and payrolls were 1,000× short | C | `macroTraced` applies `fredFigureUnit` (percent transforms → "%", scaled series → count/currency × scale, levels → index), the conversion the payload applies |
| F169 | dataOnlyReport.ts:700 | The coverage rate was rounded to 4 dp while the schema pins `rate === supported / total`; latent, because on that path the rate was always 1 or null | C | `calculateCoverage` (exact fraction) |
| F170 | dataOnlyReport.ts:755 | Every data-only grade block showed a letter grade while its reasoning said the section was "ungraded" | C | the flag claim says no analyst grade exists and that any letter is the deterministic band or a placeholder stated as such; the bare stub's "F" is named a schema placeholder |
| F171 | payload.ts:964 | News and press-release rows were clipped mid-line and later rows dropped with no disclosure, against the module's own rule | C | one untagged note per section run: "…[TRUNCATED N snippet(s) clipped mid-line; M row(s) omitted to fit the 6000-char news budget]" |
| F172 | prompts.ts:112 | The leadership guidance appended to the judge framing said "web search for deals"; the judge request carries no tools | C | `buildLeadershipGuidance({ webSearch })`: the judge copy says the pass has no web search and reads the deals as the analyst cases cite them |
| F174 | judgeProtocol.ts:649 | The reader-facing protocol note said the order was "drawn from seed" and "not fixed to one side" when `THESIS_JUDGE_ORDER` pinned it | C | a pinned setting says the order is fixed by configuration and that the seed is recorded but was not drawn; the recovered-protocol sentence follows the same rule |
| F175 | dataOnlyReport.ts:193 | A not-scored aspect was shown with the letter D and the words "the neutral midpoint, not an assessment" | C (wording) | the letter stays D — the schema requires a letter and 50/100 is the band the composite's own regularisation point falls in — and the sentence names it a placeholder shown because the schema requires one |
| F178 | prompts.ts:112 | The guidance asked for a "dividend history" and a "computed ROIC series" the payload does not carry, while forbidding the only other source | C | the inputs name what the payload holds: the growth-and-margins and returns figures, the statement extracts, the buyback-price analysis and the cash-flow extract, read against the titleSince dates |
| F179 | dataOnlyReport.ts:771 | The balance-sheet grade was computed but never placed on the verdict strip, one column short of the LLM path | C | `gradeStrip.balanceSheet` |
| F180, F196 | provenance.ts:284 | A faithful 4-dp rendering failed the trace when the fifth decimal was exactly 5: the tolerance equalled the maximum rounding error and float noise pushed the tie over it | C | a relative slack of 1e-9 beyond the display tolerance; a tie passes, the next digit fails |
| F181 | provenance.ts:121 | A bare ISO unit ("EUR") overrode a conflicting explicit currency, so a number labelled EUR verified against a USD record | C | a unit that names a currency must agree with the declared one; a conflict fails closed |
| F182 | dataOnlyReport.ts:703 | Factual and judgment coverage read 100% without any check, in the report whose manifest says no verification ran | C | a claim is supported when its source is a `computed.*` path or a provider tag; the flag claim's `pipeline` source is not, so the judgment rate is below 1 and exact |
| F183 | payload.ts:64 | The budget comment described a 60K-char transcript ≈ 15K tokens; the constant is 18,000 | C | comment corrected (18K chars ≈ 4.5K tokens) and it names the news disclosure |
| F184 | legacyEntitySafety.ts:95 | The stored-report sanitizer withheld the judge's own kind=entity disagreement — whose bull/bear views restate the disputed association by instruction — and marked every clean LLY report "blocked" on every read | C | an entity-kind disagreement with a judge resolution is left verbatim; the walk continues elsewhere |
| F185 | consistency.ts:314 | A bare scale word ("15.2 billion") was classified as money, inadmissible for a `shares` record, failing correct share-count prose | C | a bare scale word is a `magnitude`, admissible wherever money or shares are |
| F186 | consistency.ts:426 | `isDeltaRecord` read "growth" from the section and origin, so every margin LEVEL under `computed.growth-margins.*` was a delta | C | only the id's final segment (the figure's own label slug) is read, after a uniqueId suffix is dropped |
| F187 | consistency.ts:503 | "Dr Pepper" and "Dr. Reddy's" were named individuals, so every claim naming such an issuer was rejected unless it cited a filing | C | `ConsistencyInput.organizationNames` (the issuer and its peers from the payload); an honorific match inside one is a company |
| F188 | consistency.ts:626 | A claim about a person that cited the payload's own key-executive or insider-trade row — the rows the names are harvested from — was rejected as unsourced | C | `isPayloadPersonRowSource` (`fmp:key-executives`, `fmp:insider-trades`) is admissible beside filings, transcripts and registry figures; prompt and README say so |
| F189 | consistency.ts:662 | The period check ran on sentences where the cited figure was never located, against the module's stated locate-first rule and the README | C | the period check sits below the located guard |
| F190 | consistency.ts:6 | The header and the schema JSDoc promised a quarter-vs-fiscal-year catch the check cannot make (a bare quarter is skipped; "Q3 2025" agrees with a 2025-12-31 record) | C | both say the check compares YEARS |
| F191 | consistency.ts:378 | "lower"/"down"/"higher"/"up" were fixed-sign words, but "growth came in lower, 6.4%" is second-order | C | a comma, colon, dash or parenthesis between the word and the number breaks the delta reading |
| F192 | consistency.ts:370 | "Advanced" inside "Advanced Micro Devices" was a +1 direction word | C | a capitalised direction word beside another capitalised word is a proper noun |
| F193 | entityValidation.ts:234 | `splitSentences` broke on "vs." before a capitalised drug name and the fragment raised a relationship conflict | C | "vs.", "e.g.", "i.e." and the corporate suffixes are not sentence ends |
| F194 | legacyEntitySafety.ts:101 | `withheldCount` double-counted a withheld claim the verification log carried a copy of | C | distinct withheld texts are counted |
| F195 | entityValidation.ts:360 | A relationship conflict on an orforglipron trial resolved only when the judge wrote "Foundayo (orforglipron)" verbatim | C | naming either alternate of a parenthesised canonical name resolves it |
| F197 | tests/stageC.verifyChecks.test.ts:139 | The direction and unit tests used invented ids, so the false positives of the real id/origin shapes were invisible | C | tests use `computed.growth-margins.gross-margin-latest` with origin `computed.growth.margins.gross`, the uniqueId suffix and the shares/magnitude case |

### 3.9 Test-suite integrity (F198–F206)

One finder read the guard, the release test, the coverage manifests, the
audited-fixture machinery and the runner tests. The remediation is §8.16.

| # | File:line | Finding | Verdict | Fix |
| --- | --- | --- | --- | --- |
| F198 | passes.ts:1185 | A job-level cancel relabelled BOTH analyst sides as "abandoned because the sibling failed unrecoverably" | C (duplicate of F152/F159) | fixed in §8.2: the relabel requires the sibling-abandon sentinel as the abort reason and `deps.signal` not aborted; the runner-level cancel test pins it |
| F199 | tests/fixtures/audit-intended-deltas.json:3519 | The regenerator re-pinned an already-classified leaf whose value moved, under the old reason, so D-23's "nothing gets blessed without somebody saying why" held only for a path's first appearance | C | `regenerate()` treats a classified path whose pinned before/after no longer match as needing `--group`; the CLI reports "moved since blessed"; tests/auditDeltaContract.test.ts pins the refusal and the move |
| F200 | vitest.shared.ts:24 | Six risk modules sat outside both coverage manifests (compute.ts, models/registry.ts, leaseTiming.ts, stageC/consistency.ts, dataOnlyReport.ts, judgeProtocol.ts), one below the branch floor, and the "both directions" test compared the manifest to a verbatim copy | C | all six added to `RISK_SOURCE_MANIFEST` and the expected list; a walk of src/**/*.ts asserts every file is audited, core-covered or in a named exemption list with a reason; dataOnlyReport.ts entered the contract below its branch floor (72.65% against 75) and tests/degradation.report.test.ts gained a case covering the executive rows, the margin-solve reverse-DCF narrative, the buyback and share-count sentences and a fair value without a quote (82.4%) |
| F201 | tests/repository.release.test.ts:454 | AGENTS.md (regenerated by `next dev`) says to commit itself; the release allowlist fails the moment it is tracked | C | `.gitignore` lists AGENTS.md and CLAUDE.md with the reason; the release set stays the documented one |
| F202 | tests/jobRunner.test.ts:2065 | Every runner admission test replaced `runBullThenBear` with a mock that encoded the hook order itself, which is how the production build that captured `undefined` stayed invisible | C | one runner-level test drives `runJob` through the real `pipelinePasses` with only the provider boundary faked and asserts both analyst requests carry the checkpoint admission; writing it exposed that the provider mock lacked `validateRunPassOptions` (a harness gap, now supplied) |
| F203 | tests/setup/noLiveNetwork.ts:69 | `EDGAR_LIVE_SMOKE=1` disabled the guard for the whole suite | C | the opt-in passes `sec.gov` hosts only; everything else keeps the guard; the test pins a Yahoo URL and a look-alike host rejected under the opt-in |
| F204 | tests/setup/noLiveNetwork.ts:9 | The guard covers the vitest fork only; worker threads and child processes run unguarded and the header did not say so | C | the two TypeScript worker fixtures import the guard; the header states the process-local scope and names the child processes it cannot reach |
| F205 | src/providers/anthropic.ts:1723 | The `aborted: true` transport flag the relabel depends on was never asserted on the provider path | P | the finder read the tree before §8.1: tests/anthropic.test.ts now asserts `error.aborted` on three abort paths (after generation started, during a retry backoff, before the first token); no further change |
| F206 | tests/helpers/auditFixtureComparison.ts:243 | The `assertUnchanged` label "bundle before Stage B" bracketed validateBundle AND runStageB | C | label "bundle across validateBundle + runStageB"; `helperSha256` re-pinned in the baseline and the test |

### 3.10 App and components (F207–F220)

One finder read the app routes, pages and components. The remediation is
§8.17. None of these changes touches a persisted value; they change what the
page shows and how it is announced.

| # | File:line | Finding | Verdict | Fix |
| --- | --- | --- | --- | --- |
| F207 | components/report/sections.tsx:2143 | The in-app report never rendered `report.meta.disclaimer`; only the short footer appeared beside seven letter grades and three price targets, while the Markdown and print exports printed the stored sentence | C | `ReportMetaStrip` prints the stored disclaimer verbatim; tests/report.surface.detail.test.ts asserts it on the live surface beside the two exports |
| F208 | app/page.tsx:173 | The fixture-mode banner ("No current market data is shown") contradicted the keyless live path (EDGAR + Yahoo) | C | both banners say which fields are gaps without an FMP key and that real US filers are still served live from SEC EDGAR and Yahoo once EDGAR_CONTACT is set |
| F209 | app/page.tsx:198 | The build-status row labelled FMP_API_KEY "(FMP Ultimate)"; README and .env.example say any plan | C | "any FMP plan; lower tiers cap history at 5 periods" |
| F210 | app/page.tsx:208 | The FRED row said the fredgraph.csv fallback applies "in dev"; it applies whenever the key is absent or the API fails | C | wording matches fred.ts |
| F211 | components/charts/FundamentalsCharts.tsx:388 | The share-count bars drew from a non-zero auto domain, so a 16% buyback read as an 87% collapse | C | the `domain` prop is gone; bars start at zero like the revenue and FCF charts |
| F212 | components/charts/ProjectionFanChart.tsx:112 | The history→forward bridge copied the last actual into the scenario keys, so the tooltip showed four fabricated scenario values at a historical period | C | the bridge row is flagged and the tooltip lists only the historical value for it |
| F213 | app/company/[symbol]/GenerateReport.tsx:689 | After a job completed nothing re-rendered the server tree, so the "full report" tab, its label and the sidebar grades kept the previous report | C | `router.refresh()` in a transition on the `done` snapshot |
| F214 | components/report/sections.tsx:893 | The own-history column printed "rank 85 of 12 quarters" for a 0–100 percentile rank; the exports print "rank 85/100 of 12 quarters" | C | the live label matches the exports |
| F215 | components/report/ReportView.tsx:11 | ReportView and the panel JSDoc said the Catalysts & Risks panel is pinned above the numbered sections; it renders at manifest position 10 | C | both comments describe the actual placement |
| F216 | components/report/primitives.tsx:12 | Two headers described ClaimText as a hydrating client island; it is a Server Component using native `<details>` | C | both headers say so and name the only client leaves (chart panels, ExportButtons) |
| F217 | app/page.tsx:125 | Home called `getWatchlistView()` twice in parallel (sidebar and panel) with no dedupe, doubling FMP quote and earnings requests on a cache miss | C | `getWatchlistView` is wrapped in React's `cache`, so one request shares one enrichment; a pass-through outside a server render |
| F218 | components/watchlist/Sidebar.tsx:124 | The remove `<button>` was nested inside the row `<Link>`; invalid interactive nesting, and the link's accessible name absorbed "remove AAPL" | C | the button is a positioned sibling of the link; the preventDefault/stopPropagation workaround is gone |
| F219 | app/company/[symbol]/ReportTabs.tsx:58 | The tab buttons exposed no tab semantics; the active tab was colour only | C | `role="tablist"`/`tab`/`tabpanel`, `aria-selected`, `aria-controls`, roving `tabIndex`, arrow-key switching |
| F220 | app/company/[symbol]/page.tsx:345 | The returns panel fabricated a ROIC−WACC spread from an older-year ROIC when the module returned null, above the module's own "spread unavailable" note | C | the spread cell shows the module's figure or "n/a"; the ROIC cell keeps its dated fallback because it prints the year |

### 3.11 Vendor clients and cache (F221–F232)

Two finders read the provider clients and the cache independently; duplicate
findings share a row. The remediation is §8.18.

| # | File:line | Finding | Verdict | Fix |
| --- | --- | --- | --- | --- |
| F221 | providers/fmp.ts:1344 | A non-error HTTP 200 OBJECT body on an optional-scope endpoint passed the entity check, normalised to zero rows and — not being an empty array — overwrote the last-good statement row for the full TTL | C | the loader throws `FmpSchemaError` for an object body on an array endpoint before admission; tests/fmp.cacheAdmission.test.ts pins that nothing is stored and the next call recovers |
| F222, F230 | providers/http.ts:108 | The registry declared FRED/FINRA/Finnhub limiters, a "burst 8 admits one sector-overlay volley" rationale and a test pinning it, while those clients bypass `fetchWithPolicy` and pace themselves | C | the three rows, the rationale and the test are gone; the header says which clients the registry governs and how the others pace; the test pins the fallback for the three |
| F223, F227 | providers/fmp.ts:1254 | Any successful first limit-bearing request — even one within the cap, or one answered from the cache — recorded an "uncapped" sentinel and disabled the gate, so the next wave paid one 402 per call | C | `planLimitProven` records only a limit the VENDOR answered in full; a larger limit still probes, serialized; two tests pin a within-cap first request and a cache-hit probe each followed by an over-cap wave with exactly one refusal |
| F224 | providers/fred.ts:209 | HOUST and TOTALSA are seasonally adjusted ANNUAL rates rendered as plain counts with a qualifier that dropped the basis | C | the qualifiers name the annual-rate basis; the unit table test pins both |
| F225, F226 | providers/yahoo.ts:450, tests/yahoo.client.test.ts:441 | The keyless quote derived previousClose/change from `chartPreviousClose`, which under `range=5d` is the close BEFORE the five-day window (verified live by the finder: a −2.5% day read as +0.08%), and the test pinned it | C | `YahooMeta.previousSessionClose` is read from the chart's own bars (the penultimate close when the latest bar is the current session); `chartPreviousClose` is kept under its real name and used only when the chart holds a single bar; the tests assert the fixture's own penultimate close |
| F228 | providers/yahoo.ts:371 | The comment said an unsettled session arrives as nulls; an in-progress session is reported to arrive as an ordinary bar and is kept | P | the comment states the limitation and why it is recorded rather than filtered (not verifiable on a Sunday, §9); no filtering added |
| F229 | providers/http.ts:394 | `response.text()` materialised any body a provider or same-origin redirect target streamed; only the 30 s timeout bounded it, and the retry loop repeated the download | C | `FetchPolicy.maxBodyBytes` (default 64 MiB): a declared Content-Length over the cap is refused unread, an undeclared body is abandoned at the cap, `HttpBodyTooLargeError` is never retried; three tests |
| F231 | cache/apiCache.ts:389 | Concurrent cache misses for one key each ran the fetcher; only background refreshes were single-flight | C | `inFlightMisses` shares one fetch between concurrent misses (and the too-stale and self-heal paths); tests/db.cache.test.ts pins one fetcher call for two callers |
| F232 | tests/fmp.cacheAdmission.test.ts:49 | The ms→s TTL conversion between the clients and the cache was pinned by no test | C | the stored `ttlSeconds` of an FMP quote row and a Yahoo meta row are asserted against `FMP_TTLS.quote / 1000` and `YAHOO_TTLS.quote / 1000` |

### 3.12 README (F1–F6)

One finder enumerated 96 checkable README claims. The remediation is §8.19;
the README line cap moved from 264 to 270 on the record
(tests/docs.lint.test.ts) for the six lines these fixes needed.

| # | Line | Finding | Verdict | Fix |
| --- | --- | --- | --- | --- |
| F1 | 197 | "The only outbound traffic goes to the providers you configure" omitted the Next.js CLI's anonymous telemetry, which `npm run dev`/`build` send unless opted out | C | `.env.example` ships `NEXT_TELEMETRY_DISABLED=1` (Next loads `.env` before it constructs its telemetry client — `build/index.js` line 487 vs 552); README and docs/PRIVACY.md disclose the CLI telemetry and both opt-outs |
| F2 | 20 | "on a route decided by what the filer actually tags" overstated XBRL evidence; industry and SIC decide first and tags decide only where they are silent (§3.6) | C | the bullet says so |
| F3 | 175 | "it is reported, not reserved" is true only in `THESIS_RESERVATION_MODE=request` | C | the generated pricing paragraph names the mode and says pass mode reserves it whole |
| F4 | 148 | The named-individual sentence understated both sides of the rule (a registry figure also passes; any non-filing source fails, not only a web search) | C | rewritten with §8.15's rule: filing, transcript, registry figure or the payload's own executive rows; any other source, or none, fails |
| F5 | 42 | "each says so in the manifest" was not true of `/report/sample`, whose manifest says synthetic but not "no provider reached" | C | "the two company slices say so in the manifest and the sample is labelled synthetic throughout" |
| F6 | 189 | The measured run costs ($1.43; $5.31 / $2.66 on MSFT) cannot be verified from the repository | P | the sentence says they are the maintainer's own runs and not reproducible from the repository; the figures themselves are left as reported (§9) |

## 4. In-flight change review

The working tree carried one uncommitted change on top of `94560ac` when the
audit began: the CHANGELOG entry *per-request admission restored, effort-aware
idle guard* and the code behind it (src/providers/anthropic.ts,
src/pipeline/stageC/passes.ts, src/pipeline/jobRunner.ts,
src/pipeline/leaseTiming.ts, src/config/env.ts, scripts/docs-pricing.mjs,
.env.example, README.md and five test files). It was reviewed as a diff, with
its CHANGELOG claims checked one by one against the code.

**What the change did, and whether the claims hold.**

| Claim (CHANGELOG) | Code | Verdict |
| --- | --- | --- |
| `runBullThenBear` built each request's arguments before the runner's `beforePass` hook registered that pass's admission, so both analyst requests ran outside per-request admission | passes.ts builds the arguments after the hook; the non-streaming fallback always did | holds — but nothing at the runner level proved it (F202, §3.9); the runner-level test now drives the real pass runner and asserts the admission on both requests |
| A presumed cost was recorded as an actual one when admission was absent | `settleIdleRequest` returns early without admission; restoring admission restores the `presumed` marking | holds |
| `THESIS_STREAM_IDLE_SECONDS` defaults to 300, scaled ×1/×1/×2/×3/×4 by effort and bounded by the model stage deadline; the SDK discards SSE pings before any listener runs | env.ts `DEFAULT_STREAM_IDLE_SECONDS`; anthropic.ts `STREAM_IDLE_EFFORT_MULTIPLIER` and `streamIdleTimeoutMsFor` clamp to `MODEL_STAGE_DEADLINE_MS`; the SDK's `core/streaming.js` skips `ping` | holds |
| A side that ends the run stops its sibling at once; a deliberate abort is reported as abandoned (`error.aborted`), and a side that failed on its own keeps its own message | passes.ts sibling abort; anthropic.ts `aborted` flag | the intent holds; the implementation shipped with three defects, below |
| The README cost table gained an analyst-output-ceiling column and says the estimate is measured at effort `high` | scripts/docs-pricing.mjs; README regenerated | holds (the pricing sentences were further corrected in §8.19) |

**Defects found inside the change** (all confirmed by finders and fixed in
§8.1–§8.2):

- F8 / F157 / F155 — a signal abort during the provider's transport-retry
  backoff rejected the result and never settled `firstToken`, so the sibling
  orchestration could wait forever. The backoff sleep now observes the signal;
  a typed aborted result carries the attempts billed so far, and the
  orchestrator races `firstToken` with the result.
- F151 / F160 — the sibling-abort relabel ran after the settlement hook had
  already persisted the raw provider message; it now runs inside the
  settlement chain.
- F152 / F159 (F198) — a job-level cancel relabelled BOTH sides as "abandoned
  because the sibling failed"; the sibling is now aborted with a sentinel
  reason and the relabel requires that sentinel and an un-aborted job signal.
- F154 / F46 — an abort after generation had started settled the
  `message_start` snapshot as an `actual` row, under-recording output nobody
  could reconcile; it now settles reported usage plus the presumed remainder,
  flagged presumed, which is the same rule D-09 applies to a dead stream.
- F205 — the `error.aborted` flag the relabel depends on had no provider-side
  assertion; three abort paths are now asserted in tests/anthropic.test.ts.

The CHANGELOG entry itself remains accurate after these fixes: every
behaviour it describes is what the code does. The audit's own entry (§8.20)
follows it in the file.

## 5. Tooling and CI

No finder reached this slice; it was read directly: package.json (scripts,
engines), .github/workflows/ci.yml, vitest.config.ts,
vitest.integration.config.ts, vitest.risk.config.ts, vitest.shared.ts,
eslint.config.mjs, tsconfig.json, next.config.ts and the eight scripts in
scripts/. The remediation is §8.20.

### 5.1 The verify chain and CI

`npm run verify` runs, in order: `check:dependencies` (lock-edge walk and
exact-version pins, then `npm ls` of the same packages), `typecheck`, `lint`,
`test:product` (forks, isolated, 50% workers so the scheduler tests' own
worker threads are not starved), `test:integration` (the database CLI suite,
serial, in its own process), `test:coverage` (the core Stage B contract at
90/84/95/93 and the per-file risk contract at 85/75/85/85 over
`RISK_SOURCE_MANIFEST`), `build` and `audit:security` (`npm audit
--include=dev --audit-level=low`). The `full` CI job runs exactly that chain
on Ubuntu / Node 24 with `npm ci`; a `windows-smoke` job runs the product
suite single-worker and the integration suite. `next.config.ts` sets
`typescript.ignoreBuildErrors` so the build does not repeat the typecheck;
the comment says so and CI runs `typecheck` before `build`, so nothing is
lost. `engines.node` is `>=22.18.0` (D-22). The chain was run end to end at
the close of this audit (§1).

### 5.2 Findings

| # | File:line | Finding | Verdict | Fix |
| --- | --- | --- | --- | --- |
| T1 | scripts/reconcile-presumed-costs.mjs:26 | The Cost API request targeted `/v1/organizations/cost_reports`; the endpoint is `cost_report` (singular), so every keyed run failed with "responded 404". Verified against the platform documentation on 2026-09-06 (the only external read this audit made). | C | path corrected; tests/reconcilePresumedCosts.test.ts pins it |
| T2 | scripts/reconcile-presumed-costs.mjs:31 | `amount` is documented as the currency's LOWEST unit as a decimal string (`"123.45"` in USD is $1.2345); the script summed it as dollars, so the upper bound it computed was a hundred times too high and no presumed row could ever have been lowered — the safe direction, but the feature did not work | C | amounts are summed in the lowest unit and divided by 100; the test uses the documented example |
| T3 | scripts/reconcile-presumed-costs.mjs:58 | One request, no paging: the default `limit` is 7 daily buckets, so only the first week after the oldest presumed row was ever read, and the header claimed "exactly one paid-account read" as a virtue | C | `fetchCostReport` asks for 31 buckets per page and follows `next_page` up to 24 pages (two years), refusing beyond that; the header says so; a fake-fetch test pins the parameters, the header-only key and the cap |
| T4 | scripts/check-dependency-shape.mjs:265 (+ docs-config, docs-pricing, audit-deltas, models-refresh, reconcile, settings-reset) | The "am I the entry point?" guard compared `pathToFileURL(process.argv[1])` with `import.meta.url`; Node resolves symlinks for the latter and not the former, so on a symlinked checkout (macOS /tmp, a CI cache, a Windows junction) the script exits 0 without running. run-security-audit.mjs alone carried the fix, with a comment explaining exactly this. For `check:dependencies` that is a release gate silently passing | C (latent; CI checks out a plain path) | one helper, scripts/lib/entrypoint.mjs `isEntryPoint`, used by all eight scripts; tests/scriptEntrypoint.test.ts creates a real directory junction and asserts both symlink modes |
| T5 | tests/jobRunner.test.ts:4423 | The `getConfig` call-count pin (a stand-in for "no provider or model boundary crossed", already listed as a follow-up in docs/audit/REMEDIATION-REPORT.md) broke when §8.12 gave `computeReturns` its own read of `THESIS_EV_INCLUDE_LEASES` | C | the flag is read once in `runStageB` and handed to both the returns and the valuation blocks, which is also the "read once per run" the comment promises; the pin stays at 4 |

Checked and found sound: the lock-edge walk resolves `node_modules` the way
Node does and skips optional peers; `APPROVED_VERSIONS` matches
package.json's ranges; the security audit runs at the release threshold with
dev dependencies; docs-config.mjs enforces both README contracts (every
validated key documented, every user-facing script described) and the
doc-lint test compares its output to the checked-in file; models-refresh.mjs
never runs from tests, keeps every hand-maintained registry field and reports
pricing rows it could not parse rather than guessing (its 400-character
window over the pricing page is a heuristic, and says so); settings-reset.ts
preserves the two bookkeeping rows, refuses to act without `--yes`, and treats
an unopenable database as an error rather than "nothing to reset";
audit-deltas.mjs is covered in §3.9 (F199).

Observations, not defects: the Windows job is a smoke job by design (no
lint, coverage or build); there is no automated dependency-update
configuration, which `check:dependencies`'s exact pins make a deliberate
manual step; the risk contract's `autoUpdate: false` is correct.

## 6. Documentation accuracy

Every tracked document was read against the code it describes. The README
is §3.12. The remediation is §8.19–§8.20.

### 6.1 docs/METHODOLOGY.md (842 lines)

Read in full. Every stated constant was located in the code and compared:
beta clamp [0.6, 2.0] and raw bound (0, 4] (`BETA_CLAMP`, `BETA_RAW_MAX`);
the Blume weights 2/3–1/3 (`BLUME_RAW_WEIGHT`); cost-of-equity clamp
[rf + 2.5, 25]; the effective-Rd band [rf − 1, rf + 19] and the 2%-of-assets
de-minimis rule; tax clamp [0, 0.35]; WACC clamp [max(6, rf + 1), 20] and the
0.5pp materiality; the ERP fallback age (210 days) and band; the per-year
risk-free window (14 days) and the five-year FRED history
(`dataBundle.ts:1577`); the growth-anchor clamp [−10, 25], the 90-day analyst
leg and the two-year consensus window; the 10-year horizon, the 5-year margin
fade, the ±0.5pp trend threshold, the margin clamp [−20, 45-or-own-maximum]
and the sales-to-capital clamp [0.5, 5]; terminal growth min(2.5, rf) with
the 2.0pp / 1.5pp Gordon guards; the terminal-excess rule (four years, half
the median spread, 5pp cap, 0.5pp floor); own-history 8 and 20 observations;
peer stats (four survivors, 1.5×IQR); the SIC bands 6020–6036, 6300–6399,
6400–6499, 6798 and the 6000–6499 / 6700–6799 forensic band; the 24-month
tag-recency window; the core forms including 40-F; the P/TBV 0.5pp spread
floor; the 10-year excess-return horizon; the Damodaran spread table dated
January 2026; the disclaimer text verbatim (`REPORT_DISCLAIMER`). All agree.

Two inaccuracies, fixed:

- The own-history sentence said the app's bar prints "rank 62 of 12
  quarters" and the exports "rank 62/100 of 12 quarters". After F214 (§3.10)
  every surface prints the "/100" form; the sentence now says so and records
  why the app's label changed.
- Four cross-references pointed at section numbers the document no longer
  has ("see §1.3", "(§1.2)", "§2.2 fades ROE", "(§1.4)"), left over from a
  numbered predecessor. Each now names the heading it means.

### 6.2 docs/RESEARCH.md (596 lines)

Read in full. The published constants were compared with the code: the four
Altman variants (`ALTMAN_COEFFICIENTS`, including 0.999 for X5, the dropped X5
in Z″, the +3.25 EM constant and its shifted zones 4.35 / 5.85), the Beneish
coefficients (`BENEISH_COEFFICIENTS`, TATA 4.679) and thresholds (−2.22 /
−1.78), the index clamp [0.1, 10] and TATA clamp [−1, 1], the Altman X4 cap
(±20), the accrual bands (0.10 / 0.20), the two-of-five discontinued-
operations rule, the manufacturer SIC band 2000–3999, the financial band, the
Piotroski out-of-7 short-history variant and the beginning-of-year scaling.
All agree. The doc-lint test already asserts that every `research §n.m`
citation in the code resolves to a heading here.

One inaccuracy, fixed: §6.3 said Altman Z is "not computed at all" for a
financial company identified by SIC 6000–6499 / 6700–6799, but
`selectAltmanVariant` shows Z″ with a caution note on the equity-REIT route
(SIC 6798 is inside the band; an equity REIT is an operating landlord), which
METHODOLOGY already stated. The same bullet understated the Piotroski
withholdings (only the operating-cash-flow signal was named); it now lists
them per route and points at METHODOLOGY's three-scale table.

### 6.3 docs/PRIVACY.md and docs/DATA-RIGHTS.md

Every host, header, path and constant was checked: the three SEC hosts and
`hasConfiguredEdgarIdentity`; the FMP `apikey` header and the canonical
query that strips it; `YAHOO_DEFAULT_USER_AGENT`; the FRED `api_key`
parameter and the keyless `fredgraph.csv` host; the Finnhub header; the
FINRA host; `MAX_PROVIDER_WEB_SEARCHES` (8); the `server-only` marker and the
`window` guard in env.ts; the three platform data directories in
db/paths.ts; `requestTokenPath` and the startup line in instrumentation.ts;
the 30-day purge margin, the 24-hour sweep guard and `VACUUM`; the ten-year
filing and transcript TTLs. Both documents are accurate; PRIVACY gained the
CLI-telemetry paragraph in §8.19 (F1).

### 6.4 docs/audit/DECISIONS.md and REMEDIATION-REPORT.md

Decision records are history, so where the code has moved on a dated
**Revised** note is appended (the precedent is D-14) rather than the record
rewritten:

- D-09 recorded a 120 s idle default; the 2026-09-03 change made it 300 s,
  effort-scaled and stage-deadline-bounded (§4).
- D-20 said claims about named individuals are restricted to filings and
  transcripts; the rule as enforced (§8.15) also admits a registry figure and
  the payload's own executive and insider rows.
- D-22 named a `docs:commands` script that never existed; `docs:config`
  renders both tables.
- D-24, D-25, D-26 were added by this audit.

The remediation report said DECISIONS holds D-01 to D-23 and that the README
is 250 lines under a 250-line cap; both sentences now note the later state.
Its follow-ups list remains accurate; the `getConfig` counter it flags is
still in place (T5).

### 6.5 CHANGELOG.md, .env.example, the specs

The *Unreleased* entry's claims are verified in §4. The audit's entry is
appended below it (§8.20). `.env.example` is the source of the README's
generated configuration table; the doc-lint test proves they agree, and the
Privacy section was added in §8.19. The four design specs under
docs/superpowers/specs are dated records: each carries a status header and,
where the code diverged, a deviations paragraph — the keyless-data-path spec
already cites this audit's §3.3 and the analysis-quality spec its grid
change. They were not re-verified sentence by sentence (§9).

### 6.6 Code comments and user-visible strings that cited retired documents

An earlier documentation pass had replaced the names of deleted design
documents (a specification, a data map, provider and API "contracts") with
generic phrases but kept their section numbers, leaving 130+ citations such
as "the application contract §8", "SPEC §6", "DATA_MAP §1.1" and "the
sector-routing methodology §1.3" that point nowhere. About twenty of them
were user-visible: routing and validation notes that reach the report and
the manifest, the rating-gate error message, and two lines of the analyst
prompt itself ("SPEC §1 rule #1"). Every one was rewritten to cite a living
heading (docs/METHODOLOGY.md or docs/RESEARCH.md) where one exists, or to
drop the dead number where none does. The prompt change moves the payload
pin by −46 bytes (recorded in tests/stageC.payload.passes.test.ts), and two
Stage B notes of the audited fixture, so the change is recorded as D-27 and the
delta group `docs-references-audit-2026-09-06`. Section
labels of the report's own numbered sections (`§7.1 verdict` …) are the
on-screen numbering and were kept.

## 7. Evidence base

"Based on extensive research/evidence/testing" was audited as three
questions: does every published model the code names carry its published
constants; is every house rule labelled as one where it prints; and does the
evidence the code cites still hold.

**Published models.** The forensic constants in the code were compared with
docs/RESEARCH.md (§6.2) and, from memory of the primary sources, with the
papers: Altman (1968) 1.2 / 1.4 / 3.3 / 0.6 / 0.999; Z′ 0.717 / 0.847 / 3.107
/ 0.420 / 0.998; Z″ 6.56 / 3.26 / 6.72 / 1.05 with the emerging-market
constant 3.25 (Altman, Hartzell and Peck, 1995); Beneish (1999) −4.84 +
0.920·DSRI + 0.528·GMI + 0.404·AQI + 0.892·SGI + 0.115·DEPI − 0.172·SGAI +
4.679·TATA − 0.327·LVGI with the −1.78 / −2.22 cutoffs; Piotroski (2000) nine
signals on beginning-of-year assets. All agree. RESEARCH's resolved
ambiguities (the TATA transposition, the shifted EM zones, the five-variable
M-score being a different 1997 model) are correctly reasoned and the code
follows them. The valuation conventions the code attributes to Damodaran
(terminal growth bounded by the risk-free rate, reinvestment g ÷ ROIC, the
synthetic-rating spread, the equity excess-return model for financials, SBC
as an operating expense), to Koller–Goedhart–Wessels (continuing value, the
RONIC fade), to NAREIT (the FFO definition) and to Blume (mean reversion of
betas) are standard readings of those sources; the Bloomberg 2/3–1/3
weighting is correctly separated from Blume's own fitted line.

**House rules.** Every clamp, band, floor and cap the code applies is one of:
(a) named in METHODOLOGY or RESEARCH as a house rule with its rationale
(§6.1–§6.2 list them); (b) printed as "house rule" or "HOUSE CONVENTION" on
the number it produced; or (c) disclosed in the missing-data manifest when it
binds materially (the WACC's 0.5pp rule; the margin ceiling note; the grid
note). The audit found and fixed the places where a house rule was presented
as something else: the Stage C "F" placeholders that read as grades (§8.15),
the "1000.0K" magnitude rule (F65), the pinned-order protocol note that said
an order was drawn when it was configured (F174), and the notes that cited a
specification as if it were an authority (§6.6).

**Cited evidence.** Live facts the code relies on were checked where the
audit could: the Cost API path and unit (§5, fetched); Yahoo's
`chartPreviousClose` semantics (F225, verified live by the finder);
`fredgraph.csv` units for HOUST and TOTALSA (F224); the SDK's discarding of
SSE pings and its `BetaMessageStream` error wrapping (F7, read in
node_modules). Facts that could not be re-verified offline are listed in §9:
the Damodaran spread table dated January 2026 (recorded as fetched
2026-07-05), the registry prices in config/models.json (the `models:refresh`
dry run is the tool), and Blume's fitted coefficients as quoted in RESEARCH
§7.1.

**Testing.** Every confirmed code defect in §3 and §5 has a regression test
in the same change (the §8 logs name them). The suite-integrity slice (§3.9)
also closed the two gaps that let defects hide: the runner admission tests
that mocked the hook order, and the risk-coverage manifest that omitted six
risk-bearing modules; the src/ walk now fails the build when a module is in
neither coverage contract nor the exemption list.

## 8. Remediation log

Each entry: what changed, why, and the test that pins it. Suites named here
were run after the change; the counts are the run's own output.

### 8.1 Anthropic provider (src/providers/anthropic.ts)

- Stream failures that the SDK wraps in a bare `AnthropicError` (undici body
  timeout, socket reset, premature EOF, "stream ended without producing a
  message") are now classified as retryable transport failures; the `cause`
  chain is walked for connection error codes. A post-headers failure settles
  as presumed spend rather than being released (D-07). Tests: "classifies a
  stream death …", "retries a bare mid-stream error under admission".
- An abort during the transport-retry backoff settles `firstToken` with
  "abort" and resolves a typed transport failure flagged `aborted: true`
  that carries the usage the earlier attempts billed. Tests: "abort during
  backoff …", "carries billed usage through a backoff abort".
- An abort after `message_start` settles reported usage plus the presumed
  remainder, flagged presumed (D-09), instead of an `actual` row at one
  output token. Test: "abort after message_start settles presumed".
- `pause_turn` resumption streams under the same idle guard as the first
  request (`streamFinalMessage`); a dead resumed stream settles like any dead
  stream. Test: "abandons a resumed turn that goes idle".
- Per-hop pricing when `usage.iterations` accounts for the whole message.
  Test: "prices a fallback-served message per iteration".
- `max_tokens` truncation reports the limit actually sent
  (`effectiveMaxTokens`). Test: "reports the sent ceiling at effort high".
- The request's reservation is no longer released from the attempt's
  `finally` once the request has been dispatched; a settlement write that
  fails twice leaves the reservation to expire into presumed spend (D-07).
- `PassError.aborted` added to the public failure shape.
- Suite: tests/anthropic.test.ts — 88 passed.

### 8.2 Stage C passes (src/pipeline/stageC/passes.ts)

- Sibling abandonment: the run aborts the surviving side with a
  `SiblingAbandonedSignal` sentinel; the "abandoned because the sibling
  failed" relabel is applied only when that sentinel (not the job signal) was
  the reason and the provider reports `aborted`, and it is applied INSIDE the
  settlement chain so the durable artifact carries the same text. `firstToken`
  is raced with the side's result so a side that dies before its first token
  cannot hang the run. Tests: "backs bear out after its permit gate …",
  "never opens a bear request on the sequential path …", "keeps each side's
  own failure message …", "does not relabel either side when the job signal
  …", "settles an abandoned side under the abandonment label …".
- `kind: "Entity"` is normalised like the other two disagreement kinds.
  Test: "normalizes the casing of the entity disagreement kind".
- Under `THESIS_JUDGE_ORDER=both`, a validation retry does not run the
  mirrored pass and discloses the reconciliation as not performed (a mirror
  anchored on the primary's repair turn is not an independent draw). Test:
  tests/stageC.judgeProtocol.test.ts "does not run the mirrored pass on a
  repair-in-place retry".
- The standalone `runJudgeVerifyAssemble` path narrows `both` to the seeded
  single order and discloses why. Test: "narrows a `both` setting …".
- Suites: tests/stageC.payload.passes.test.ts, tests/stageC.judgeProtocol.test.ts,
  tests/anthropic.test.ts — 258 passed together.

### 8.3 Job scheduler (src/pipeline/jobScheduler.ts) and schema

- Presumed rows are dated at the lease's `acquiredAt`. Test: "dates a
  presumption at the lease's acquisition so a later sweep still reconciles
  against the right day" (acquire 23:50Z, sweep 09:00Z next day, reconcile
  against both days: lowered to the acquisition day's remainder, not to 0).
- `settleRequestCost` commits a measured cost above the reservation before
  raising `PaidPassOverReservationError` (`inserted: true`); versions the
  parent snapshot (finalizing a terminal parent whose last lease it was) and
  wakes the pump. Tests: "commits a measured cost above the reservation before
  throwing the invariant", "versions the snapshot so a canceled job's pending
  settlement and cost reach the client", "versions a running job's snapshot
  …".
- Reconciliation normalises bucket bounds to one ISO representation and
  subtracts already-reconciled presumptions from the accounted total. Tests:
  "keeps a row from the first second of a day in that day's bucket …",
  "subtracts already-reconciled presumptions …".
- `settlePaidPassLease` accepts an expired, unswept exact lease and accepts a
  request-mode pass whose $0 lease was swept when `<attemptId>#rN` request
  rows exist; the "stale" refusal remains for an attempt with no lease, no
  presumption and no requests. Tests: "accepts a request-mode pass whose $0
  lease was swept …", "accepts an expired exact lease before any sweep …";
  tests/jobScheduler.test.ts "captures settlement authority after a blocking
  writer lock and still records the late settlement", "records a late
  settlement against an expired, unswept exact lease without backdating
  authority" (both rewritten from refusal to acceptance; the no-backdating
  property is now pinned on `createdAt`/`updatedAt`).
- `cost_log.attemptId` comment states that NULL is deliberate on presumed rows.
- Suites: tests/jobScheduler.test.ts, tests/scheduler.presumedSpend.test.ts —
  108 passed.

### 8.4 Job runner (src/pipeline/jobRunner.ts), artifacts, facade

- Presumed-spend disclosure and discarded-attempt marking span every
  generation of the job (new `readJobPassArtifactLineage` in jobArtifacts).
  Tests: "discloses an earlier generation's presumed spend in the generation
  that reports the total", "marks a prior generation's rejected attempt in
  the generation that reports the total".
- Request-lease identity leaves the renewal map only after the settlement
  write commits; an over-reservation commit is removed and rethrown. Test:
  "commits a request's measured cost above its reservation and then fails the
  pass loudly".
- Verify checkpoint's admission registered before launch. Test: "registers
  the verify pass's request admission before launching a billable verify".
- Stage B exception filed as a critical `pipeline.compute` manifest entry with
  a compute-specific `analysis.llm` reason; the launch-authority and
  model-resolution degradations carry their own reasons (new exported
  constants `LLM_FAILURE_DATA_ONLY_REASON`, `COMPUTE_FAILURE_DATA_ONLY_REASON`).
  Tests: "records the compute exception in the manifest …", assertions added
  to the launch-authority and model-resolution tests.
- Assembly failure over a reused synthesize artifact is reported as one
  provider-free attempt with the reused-artifact wording. Test: "names a
  single provider-free assembly attempt …".
- The facade passes each side's failure kind; the runner's fallback settlement
  records it (parse vs schema). Test: "classifies a not-JSON rejection the
  adapter did not settle as the adapter would".
- `resume` JSDoc corrected; job-claim renewal cadence named by
  `JOB_LEASE_RENEWAL_DIVISOR`.
- Suite: tests/jobRunner.test.ts — 202 passed.

### 8.5 Lease timing, config, .env.example, README

- leaseTiming invariants 1 and 4 reworded to what the runner and provider do;
  `JOB_HEARTBEAT_MS` documented as legacy; env.ts message no longer claims a
  5-minute heartbeat; `.env.example` lease paragraphs corrected; README
  config block regenerated (`npm run docs:config -- --write`).
- Suites: tests/env.test.ts, tests/docs.lint.test.ts,
  tests/repository.release.test.ts, tests/docsPricing.test.ts — 67 passed.

### 8.6 Report layer (schema gate, exporters, formatting, corrected CLI)

- Rating gate: `NO_RATING_MESSAGE` reworded and exported; operational-object
  lookahead on the first-person and "recommend" patterns; "now"/"in" added to
  the bare-label and sentence-initial exclusions; `sourceId` and
  `attemptedSources` exempt from the recursive scan. Tests: battery extended
  (six new ALLOWS, three new REJECTS), "does not itself match the rating
  patterns", "does not scan the machine citation identity …".
- Markdown export: headings from the shared section manifest (Scorecard as a
  sub-heading of Verdict, Projections 12, Macro 13, Appendix 14); route-metrics
  cells serialised once; header cost is the displayed row total; "Pass
  execution" row. Tests updated/added in tests/report.history.export.test.ts,
  tests/report.markdownCostTotal.test.ts, tests/report.surface.detail.test.ts.
- Sensitivity grid in the per-share currency on Markdown, print and the live
  heatmap (`formatMoneyAmount`, `moneyIn`). Test: "renders the DCF sensitivity
  grid in the per-share currency, on both exports".
- `formatLargeNumber` rounding carry; pipeline units rendered on their own
  terms. Tests in tests/report.format.shared.test.ts.
- Corrected CLI keeps persisted execution entries and discarded flags.
- Model-floor disclosure keyed on the registry floor and the synthesize step.
  Test: "does not label an analyst pass with the judge floor".
- Suites: 14 report/API files — 529 passed.

### 8.7 API routes and request security

- `assertAllowedHost` folds a default port by request protocol; retry route
  reconciles expired owners before reading the target; JSDoc/header comments
  corrected on the report route, GenerateReport and `isSymbolJobActive`.
  Tests: "folds an explicit default port in THESIS_ALLOWED_HOST …",
  "reconciles the target's own expired owner …", "keeps a running target
  whose lease is live as a retry conflict", "sends a heartbeat comment every
  15 s …".
- Suites: tests/api.routes.sameOrigin.test.ts, tests/api.routes.report.test.ts,
  tests/api.routes.stream.test.ts — passed (176 with the surface test).

### 8.8 Data bundle (keyless fallbacks, plan limits, compute provenance)

- `edgar` mode: policy-named reason, `expected: true`, vendor rows withheld
  (gap `statements.<member>`) when EDGAR cannot build a member; `fmp` mode:
  no predecessor append (info entry); plan-clamped market-cap history extended
  with derived older days (`marketCapHistory.backfill`); plan-limit entry
  reworded after a backfill; Altman market-cap as-of from its own envelope.
  Docs: env.ts statement-source comment and `.env.example` (the WS4 handover
  note that also carried it was retired with the other consumed notes, §8.10).
  Tests: four new/extended tests in tests/keyless.test.ts, two in
  tests/dataBundle.planLimit.test.ts, one in tests/stageB.ttm.compute.test.ts.
- Suites: tests/keyless.test.ts, tests/dataBundle.planLimit.test.ts,
  tests/stageB.ttm.compute.test.ts, tests/dataBundle.keyless.test.ts,
  tests/dataBundle.successor.test.ts, tests/env.test.ts,
  tests/docs.lint.test.ts — 203 passed.

### 8.9 EDGAR extraction, statements, splits, SIC, successor lookup

- Bank routing by industry: `StatementBuildOptions.bankRevenue`;
  `bankStatementRouting` (keyless.ts) sets it from the registrant's SIC for the
  issuer's and the predecessor's builds; the row note names which rule fired.
  `Revenues` precedes the ASC-606 elements in `REVENUE_TAGS` and
  `CONCEPT_CHAINS.revenue`; RESEARCH.md §2.8 records the taxonomy evidence.
  The `looksLikeBankTagging` and `BANK_REVENUE_SPEC` comments now state the
  fixture evidence.
- Statements: signed `original` on sign-flipped fields; own-period 10-Q `fy`
  for quarterly rows; quarter band 70–125 days (`QUARTER_DURATION_DAYS`, one
  constant for statements.ts and xbrl.ts); explicit-start match by latest
  filing; Form 40-F/40-F/A core forms (annual-form set, label, ADR flag,
  `selectAnnualFiling`, gap wording); `commonDividendsPaid` chain (own
  element, total less preferred disclosed, else total); invariant 3 reworded.
- Splits: repeat window measured from the previous same-ratio tag; a
  same-ratio tag on no restated evidence after an applied event is a `warn`.
- Extraction: `NOT_REQUIRED_RE` matches the smaller-reporting-company wording;
  the mini-TOC redirect bounds on a named boundary first and discloses the
  all-caps fallback; `buildSynonyms` drops a quoted title naming another
  section kind.
- SIC 4953/4955/4959 → Industrials / Waste Management.
- Successor: `hasOwnAnnualHistory` replaces the concept count at both hops
  (`resolvePredecessor` in dataBundle.ts, the keyless warning gate).
- Docs: METHODOLOGY.md core-form list; RESEARCH.md §2.8; the keyless design
  spec (rules 2–3, bank routing, ADR flag, gap wording, deviations paragraph);
  the provider temporal-integrity spec's core-form list; `.env.example`
  statement-source modes (README regenerated).
- Tests: tests/edgar.statements.test.ts (six new), tests/edgar.xbrl.test.ts
  (five new, one rewritten), tests/edgar.extract.test.ts (four new),
  tests/edgar.splits.test.ts (three new), tests/edgar.sic.test.ts,
  tests/edgar.successor.test.ts, tests/dataBundle.successor.test.ts (two new),
  tests/dataBundle.edgarForms.test.ts, tests/keyless.test.ts (two new),
  tests/stageA.validate.test.ts (the L1 load-bearing test retargeted to the
  bank the routing now exists for).
- Suites: 14 files (EDGAR, keyless, data bundle, Stage A validate, docs lint,
  release) — 426 passed.
- Not changed: F28 (§3.3).

### 8.10 Documentation set pruned (owner's instruction, 2026-09-06)

Deleted with `git rm`, with the release allowlist and every inbound link
updated in the same change:

- The three earlier audit records
  (`docs/superpowers/audits/2026-08-07-remediation-verification.md`,
  `2026-08-30-code-and-docs-audit.md`,
  `2026-08-31-analytical-integrity-verification.md`): every finding they
  record was closed before this audit began, and this audit re-verified the
  same code from the tree rather than from their conclusions.
- The four executed implementation plans (`docs/superpowers/plans/`):
  step-by-step task lists whose code excerpts no longer match the tree (the
  keyless plan still specified the 70–110-day quarter band). Design intent
  stays in the specs, decisions in DECISIONS.md.
- The six README handover notes (`docs/audit/README-NOTES-WS123.md`, `-WS4`,
  `-WS5`, `-WS6`, `-WS7`, `-WS8`): inputs to the WS9 README rewrite, recorded
  as done on 2026-09-02; README.md, METHODOLOGY.md, PRIVACY.md and
  DATA-RIGHTS.md carry their facts. The WS4 note's statement-source paragraph,
  updated earlier in this audit, now lives in `.env.example` and env.ts.
- `docs/audit/README-RECONCILIATION.md` (Phase 0, baseline `9d137fa`, line
  references into the 2026-09-02 tree) and `docs/audit/PROGRESS.md` (the
  remediation status board, "Nothing is outstanding"): superseded by this
  record. REMEDIATION-REPORT.md's "read alongside" list now points here and
  says what the R-nn/V-nn row numbers it cites referred to.

Kept: DECISIONS.md (cited from code as D-nn), REMEDIATION-REPORT.md (linked
from the changelog), the four design specs (intent plus recorded deviations),
METHODOLOGY.md, RESEARCH.md, PRIVACY.md, DATA-RIGHTS.md, README.md,
CHANGELOG.md and this record. `tests/repository.release.test.ts` lists exactly
this set.

### 8.11 Stage B forensics and grading (src/pipeline/stageB/forensics.ts, grading.ts)

- Piotroski: a missing `commonStockIssuance` is not evaluable (`na`), the gap
  says the signal was withheld and the denominator reduced; the two-year notes
  follow the tally and print the denominator actually used; the label comment
  names its consumers.
- Beneish: `BeneishOptions.revenueFloor` (default `FORENSICS_HOUSE_RULES.revenueFloor`)
  withholds the indices when either year's revenue is below the floor, with a
  gap naming the floor and both revenues; a DEPI note states the combined D&A
  basis on the number. `ForensicsInputs.revenueFloor` forwards the floor to
  `computeBeneish` and `computeSupportFlags`.
- Altman: the X3 reconstruction uses `continuingNetIncome`; the
  `selectAltmanVariant` JSDoc and SIC note state the band as 6000–6499 or
  6700–6799; the orphaned JSDoc is gone; the Z′ substitution appends only what
  the private computation did not already say; the market-cap as-of is the
  quote's own date.
- Support flags: `inventory-overhang` honours the revenue floor and the
  non-positive-base guard through `revGrowth`.
- Grading: `Signal.evidenceFraction` (default 1) multiplies a signal's weight
  in `scoreAspect`, so a signal built on fewer tests than its scale implies
  enters at a lower weight and lowers the aspect's data completeness; the
  Piotroski signal passes `outOf / 9`. The Altman driver is
  `altmanZOriginalScale`; the quality note says what the band grades.
- Stage C payload: the Piotroski figure's label is `PiotroskiResult.label`.
- Docs: RESEARCH.md §1.4 (currency mismatch → Z′, missing market cap
  withheld, `z2-em` never auto-selected), §2.1 (DEPI basis), §2.8 (the
  default revenue chain's order, from §8.9), §5.2 (the implemented overhang
  rule), §6.3 (the SIC band); METHODOLOGY.md Piotroski section (evidence
  weighting). DECISIONS.md D-24 records the weighting rule.
- Audited fixture: 14 leaves moved (quality score 88.62 → 88.24, completeness
  1 → 0.95, driver name, Beneish note order, the forensics accrual-band note's
  position, the Altman market-cap as-of); allowlisted as
  `forensics-and-grading-audit-2026-09-06` with D-24 as its decision.
- Tests: tests/stageB.forensics.test.ts (seven new: EQ_OFFER not evaluable,
  two-year denominators, Beneish floor, DEPI note, X3 continuing income, Z′
  de-duplication, overhang floor; `TOY_FLOOR` passed by the toy-scale
  fixtures), tests/stageB.grading.test.ts (two new), the payload fingerprint
  pin updated with a dated comment.
- Suites: tests/stageB.forensics.test.ts, tests/stageB.grading.test.ts,
  tests/stageC.payload.passes.test.ts — 252 passed;
  tests/audit.fixtureComparison.test.ts, tests/auditDeltaContract.test.ts —
  16 passed.

### 8.12 Stage B returns, capital, growth, beta, net debt, REIT metrics

- Lease basis (D-25): `ReturnsBalanceRow.operatingLeaseLiability`;
  `investedCapital` removes it unless `RoicOptions.includeOperatingLeases`
  (compute.ts passes `THESIS_EV_INCLUDE_LEASES`); `bookDebtOnLeaseBasis` in
  compute.ts serves `totalDebtSnapshot` and `priorYearCostOfDebt`; the ROIC
  and WACC notes state the basis; METHODOLOGY "EV bridge" gains the paragraph
  "Invested capital and the WACC's debt leg share the lease basis".
- One statement basis for the coverage ratio (compute.ts `computeReturns`):
  TTM interest and EBIT when both exist, else the annual statement for both
  legs (noted), else the labelled mixed pair; `WaccInputs.currentCoverageBasis`
  printed in the synthetic-rating note. `totalDebtSnapshot` averages the
  quarter-end balances at the TTM window's ends when the numerator is TTM, the
  fiscal-year-end pair otherwise; `WaccInputs.totalDebtBasis` →
  `WaccResult.debtBasis` → the weights note and the disclosure block.
- One Blume constant pair: returns.ts re-exports `BLUME_RAW_WEIGHT` from
  betaEstimate.ts and derives `BLUME_MEAN_WEIGHT` from `BLUME_MARKET_WEIGHT`;
  both notes print 0.667·raw + 0.333; METHODOLOGY WACC-inputs beta row.
- Financial-route severities: `waccGapSeverity` (warn on a financial route,
  critical elsewhere) for the tax-shield, weights, currency and
  unavailable-cost-of-debt gaps, each reason ending with why.
- De-minimis note written after the synthetic path (`deMinimisNote`).
- ROTE: a 0 preferred dividend beside outstanding preferred is undisclosed.
- Restatements: `normalizeAnnualRows` (returns.ts) in computeRoic,
  computeRote, computeDupont; `normalizeAnnual` (capital.ts) in
  computeCapital; the rows carry `acceptedDate`/`filingDate` from compute.ts.
- Capital: `rowForDate` (±5 days) for every income/cash-flow join plus the
  `capital.statementJoin` info gap; own EBITDA requires D&A > 0, else the
  vendor field with a note; `CapitalOptions` (reported/quote currency, ADR)
  suppress the buyback price proxy; the share-count trend uses
  `IRREGULAR_SPACING_TOLERANCE_YEARS`.
- Growth: `IRREGULAR_SPACING_TOLERANCE_YEARS` 0.6 → 0.1 with the reasoning.
- Beta: `isMonthComplete`; the month in progress is dropped from both series
  and named in the note.
- Net debt: a combined field below the cash balance is a conflict.
- REIT: `RECURRING_CAPEX_TAGS` = `PaymentsForCapitalImprovements`.
- Audited fixture: 52 leaves moved (the Blume constant: beta 1.067 → 1.0667,
  WACC 9.2559 → 9.2545, every discount factor and sensitivity column; the
  ROIC notes; `wacc.debtBasis`); allowlisted as
  `returns-capital-audit-2026-09-06` with D-25.
- Tests: tests/stageB.growth.returns.capital.test.ts (five new describes —
  lease basis, restatements, financial-route severities, WACC notes and
  bases, computeCapital; the Blume anchors retargeted to 2/3–1/3; a
  transition-period and a 52/53-week CAGR case), tests/stageB.rote.test.ts
  (three new), tests/stageB.netDebt.test.ts (one new),
  tests/stageB.betaEstimate.test.ts (fixtures generate complete months; two
  new), tests/stageB.financialMetrics.test.ts (one new),
  tests/stageB.ttm.compute.test.ts (the annual-fallback test retargeted to
  the one-basis rule and the debt-basis string).
- Suites: 11 files (returns/capital, ROTE, net debt, beta, financial metrics,
  currency/IC, prior-year cost of debt, growth restatement, TTM compute, REIT
  FFO history, docs lint) — 315 passed; fixture comparison, delta contract,
  docs lint, release — 42 passed.

### 8.13 Stage B sector routing, technicals, staleness

- SIC fallback (sectorRouting.ts): applies only when the industry string is
  null; 6020–6036 bank, 6300–6399 insurer, 6400–6499 general, 6798 REIT,
  sector "Financial Services" general. `sicIsFinancial` = 6000–6499 ∪
  6700–6799 (major groups 65 and 66 are real-estate operators, not
  financial for routing).
- Decided classifications: `classificationDecidedNonFinancial` — a known
  non-financial industry beside a non-financial SIC; evidence against it is
  `route.evidence.conflict` and changes nothing. The conflict branch requires
  `!uncorroboratedMortgageEvidence` so the uncorroborated-mortgage rule keeps
  its own disclosure. METHODOLOGY routing bullets: the SIC-fallback item, the
  "Two rules fire on a single tag group" bullet and the evidence bullet.
- routingEvidence.ts header names both single-group rules and why only the
  mortgage one is corroborated.
- technicals.ts: the sma200 gap and flag read "insufficient price history";
  the drawdown flag names its window.
- stageA/validate.ts: `FOREIGN_PRIVATE_ISSUER_HALF_YEAR_DAYS` = 183,
  `ValidateProfileRow.isAdr`, the ADR branch of `checkStaleness` (313-day
  limit) with the cadence in the reason.
- Degradation disclosures reworded to what is withheld and substituted.
- Tests: tests/stageB.sectorRouting.test.ts (6411 → general, 6331 → insurer,
  depository band, decided non-financial industry), tests/stageB.routingEvidence.test.ts
  (evidence still decides beside a financial SIC with no industry string;
  uncorroborated mortgage evidence), tests/stageB.technicals.test.ts,
  tests/stageA.validate.test.ts (ADR half-year cadence).

### 8.14 Stage B valuation, scenarios, projections, fair value

- One equity bridge (D-26): `DcfBridge` / `DcfResult.bridge` set by
  `runDcf`; `ScenarioTargetsInputs` and `ProjectionsInputs` no longer take
  net debt, minority or preferred (projections still takes `dilutedShares`
  for the per-share history); `runScenario` and the scenario targets read
  `baseDcf.bridge`; compute.ts passes nothing separately.
- Sensitivity grid: per-cell `terminalExcessPp` = base terminal ROIC − base
  WACC, held at each cell's WACC; note "terminal ROIC held at WACC + Xpp in
  every cell (the house convention defines it relative to the discount
  rate)". METHODOLOGY paragraph "The sensitivity grid keeps the excess, not
  the level"; the analysis-quality spec's grid sentence updated.
- Margin ceiling: `Math.max(MARGIN_CLAMP_PP[1], max(histMargins))` with one
  note naming the raised ceiling; METHODOLOGY "Two guards bound the paths";
  RESEARCH §7.5 lists the margin and sales-to-capital guards.
- Tax basis: fallback wording plus the `valuation.dcf.ttmTaxRate` info gap.
- REIT: `ReitInputs.preferredStock`, `minorityInterest`,
  `operatingLeaseLiability`, `includeLeasesInEv`; the implied-cap-rate EV is
  the house EV and the note prints its components; METHODOLOGY FFO section
  paragraph on the house EV and the own-history basis.
- Own-history P/FFO: `MultiplesFrameworkInputs.ffoHistoryComparable`
  (compute.ts passes `nareitFfo.netIncomePlusTotalDa` on the REIT route);
  bands withheld with `valuation.multiples.ownHistory.ffoBasis` otherwise.
- Fair value: negative per-share floored at 0 with
  `valuation.dcf.perShare.floor` (warn) and a basis line.
- Projections: assumption text from `growthAnchor`;
  `ScenarioDispersion.skippedPairs`; the spacing disclosure is info-level
  and says the fan is built from the remaining steps.
- Spec 2026-09-02-analysis-quality-design.md: superseded notes for the
  retired growth rules (D-18).
- Tests: tests/stageB.valuation.test.ts (bridge, grid excess and
  monotonicity, margin ceiling, tax basis, REIT EV, P/FFO withholding),
  tests/stageB.scenarioTargets.test.ts (ordering under a lease-adjusted
  bridge), tests/stageB.projections.test.ts, tests/stageB.fairValue.test.ts.
- Audited fixture: `stageB.valuation.dcf.bridge` (new leaf) and one new
  sensitivity note, blessed in `valuation-routing-audit-2026-09-06` (D-26).
  The payload pin (tests/stageC.payload.passes.test.ts) moved to
  `1.3.0:077da5bf` / 90,808 prompt bytes / provenance `098ebead` / finance
  `8f4e494c` with the §8.12 and §8.14 wording changes; the registered
  provenance ids, citations and computed-figure labels are unchanged.

### 8.15 Stage C prompts, judge protocol, payload, data-only report, verification

- prompts.ts: the truncation order sentence matches `TRIM_ORDER`;
  `buildLeadershipGuidance({ webSearch })` — the judge copy says the pass has
  no web search; the inputs name the payload's actual leadership evidence;
  the named-individual rule admits the payload's key-executive and
  insider-trade rows.
- judgeProtocol.ts: `MIN_CLAIM_TEXT_CHARS` = 160; serialized-length budget
  tightened from the original texts; a case still over the cap discloses the
  residual; the pinned-order protocol note says the order is fixed by
  configuration and the seed is recorded but was not drawn.
- payload.ts: `truncateWithDisclosure` never exceeds its budget (bare marker
  fallback); the news section adds one untagged disclosure note when rows
  are clipped or omitted; the budget comment states the real arithmetic.
- dataOnlyReport.ts: `macroTraced` (FRED units and scale via
  `fredFigureUnit`); net segment denominator; `calculateCoverage` with
  supported = pipeline-owned source (`computed.*`, `fmp:`, `edgar:`, `fred:`,
  `yahoo:`); `gradeStrip.balanceSheet`; the not-scored placeholder wording.
  jobRunner.ts `buildDataOnlyReport`: the flag claim and the bare stub's
  "F" are stated as placeholders.
- consistency.ts: `magnitude` unit family; `isDeltaRecord` reads the id's
  final segment; `ConsistencyInput.organizationNames` (passes.ts
  `payloadOrganizationNames`: issuer plus peer names); `isPayloadPersonRowSource`;
  locate-first period check; punctuation breakers; proper-noun skip for
  capitalised direction words; header and schema JSDoc say the period check
  compares years.
- provenance.ts: relative slack on the display tolerance; a bare ISO unit
  must agree with the declared currency.
- entityValidation.ts: `splitSentences` keeps "vs.", "e.g.", "i.e." and the
  corporate suffixes; `validateJudgeEntityResolution` accepts either
  alternate of a parenthesised canonical name.
- legacyEntitySafety.ts: entity-kind disagreements with a judge resolution
  are left verbatim; `withheldCount` counts distinct texts.
- README verification paragraph rewritten to the rule as enforced.
- Tests: tests/stageC.verifyChecks.test.ts (nine new cases with the real id
  shapes), tests/stageC.judgeProtocol.test.ts (three cap cases, the pinned
  and random note wording), tests/stageC.payload.passes.test.ts (budget
  invariant, news disclosure), tests/stageC.provenance.test.ts (tie,
  currency conflict), tests/stageC.entityAliasCase.test.ts ("vs."),
  tests/stageC.entities.lly.test.ts (alternates),
  tests/report.legacyEntitySafety.test.ts (judge record, distinct count),
  tests/degradation.report.test.ts (macro units, segment shares, placeholder
  wording, balance-sheet strip, exact coverage).

### 8.16 Test-suite integrity

- scripts/audit-deltas.mjs `regenerate()`: a classified path whose pinned
  before/after moved is `reclassified` and needs `--group` like a new path;
  the header comment and CLI output say so. tests/auditDeltaContract.test.ts:
  the unchanged-path case and the moved-path refusal/move case.
- tests/setup/noLiveNetwork.ts: `isLiveSmokeUrl` (sec.gov and subdomains);
  the header states the process-local scope. tests/setup.noLiveNetwork.test.ts
  pins the narrowed opt-in. tests/fixtures/jobSchedulerRaceWorker.ts and
  paidPassCrashWorker.ts import the guard.
- vitest.shared.ts `RISK_SOURCE_MANIFEST` and tests/risk.coverage.test.ts:
  six modules added; `COVERAGE_EXEMPT_SOURCES` with reasons; the src/ walk.
- tests/jobRunner.test.ts: the provider mock supplies
  `validateRunPassOptions`; the runner-level test "carries the runner's
  checkpoint admission on the real analyst requests (D-10)".
- tests/helpers/auditFixtureComparison.ts label; `helperSha256` re-pinned
  (`48af864a…26d7`) in tests/fixtures/audit-baseline-stageb-report.json and
  tests/audit.fixtureComparison.test.ts.
- .gitignore: AGENTS.md and CLAUDE.md.
- Lint: the unused `netDebtProj`/balance-anchor pair in compute.ts (left by
  §8.14's bridge change), an unused import in returns.ts and one in
  tests/stageB.growth.returns.capital.test.ts removed; the `router`
  dependency added to GenerateReport's stream callback.

### 8.17 App and components

- components/report/sections.tsx: the disclaimer line in `ReportMetaStrip`;
  the `rank X/100 of N quarters` label; the header and the Catalysts & Risks
  JSDoc. components/report/ReportView.tsx and primitives.tsx headers.
- app/page.tsx and app/settings/SettingsPageView.tsx banners; the FMP and
  FRED key rows.
- components/charts/FundamentalsCharts.tsx: share-count `domain` removed.
  components/charts/ProjectionFanChart.tsx: `FanDatum.bridge` and the tooltip
  filter.
- app/company/[symbol]/GenerateReport.tsx: `useRouter` + `router.refresh()`
  on the `done` snapshot. app/company/[symbol]/page.tsx: the spread cell.
  app/company/[symbol]/ReportTabs.tsx: tab semantics.
- components/watchlist/Sidebar.tsx and RemoveButton.tsx: sibling control.
  src/watchlist/watchlist.ts: `getWatchlistView` wrapped in React `cache`.
- Tests: tests/report.surface.detail.test.ts (disclaimer on every surface);
  tests/degradation.report.test.ts (the data-only branches the risk floor
  demanded, F200);
  tests/charts.synthetic.format.test.ts re-pinned to §8.6's rounded-scale
  `formatLargeNumber` (it had pinned "1000.0K", the defect F65 removed).

### 8.18 Vendor clients and cache

- providers/fmp.ts: object-body drift rejected in the loader;
  `planLimitProven` + `VendorObservation` replace the "uncapped" sentinel;
  `resetFmpPlanLimits` clears both maps.
- providers/http.ts: registry rows for fred/finra/finnhub removed and the
  header rewritten; `FetchPolicy.maxBodyBytes`, `DEFAULT_MAX_BODY_BYTES`,
  `HttpBodyTooLargeError`, `readBodyText`; the error is never retried.
- providers/fred.ts: SAAR qualifiers for HOUST and TOTALSA.
- providers/yahoo.ts: `YahooMeta.previousSessionClose`,
  `previousSessionClose(result)`, the quote's `prev` selection, the
  dailyHistory comment.
- cache/apiCache.ts: `inFlightMisses` single-flight for misses, too-stale
  refreshes and self-heal refetches.
- Tests: tests/fmp.cacheAdmission.test.ts (object body; TTL units for FMP and
  Yahoo), tests/fmp.planLimit.test.ts (within-cap probe; cache-hit probe),
  tests/fmp.http.test.ts (registry fallback; three body-cap cases),
  tests/finra.fred.test.ts (HOUST/TOTALSA), tests/yahoo.client.test.ts (prior
  session close, null-skip, single-bar fallback, zero previous close),
  tests/db.cache.test.ts (single flight).

### 8.19 README, .env.example, PRIVACY, pricing generator

- README.md: the routing bullet; the three-slice sentence; the verification
  paragraph (§8.15); the "Running it safely" paragraph; the configuration
  table (`NEXT_TELEMETRY_DISABLED` row, generated) and the pricing block
  (reservation-mode sentence, maintainer's-runs sentence, generated).
- scripts/docs-pricing.mjs: the two sentences. `.env.example`: the Privacy
  section. docs/PRIVACY.md: the CLI telemetry paragraph.
- tests/docs.lint.test.ts: the line cap 264 → 270 with the six lines named.

### 8.20 Tooling, CI and the document set (§4–§7)

- scripts/reconcile-presumed-costs.mjs: `COST_API_URL` singular; amounts
  converted from the lowest currency unit; `fetchCostReport(adminKey, start,
  end, fetchImpl)` pages at 31 buckets up to 24 pages; the header states all
  three. tests/reconcilePresumedCosts.test.ts rewritten (unit, path, paging,
  header-only key, page cap).
- scripts/lib/entrypoint.mjs `isEntryPoint` (both symlink modes); used by
  audit-deltas, check-dependency-shape, docs-config, docs-pricing,
  models-refresh, reconcile-presumed-costs, run-security-audit and
  settings-reset. tests/scriptEntrypoint.test.ts (a real junction).
- src/pipeline/compute.ts: `THESIS_EV_INCLUDE_LEASES` read once in
  `runStageB`, passed to `computeReturns` and via `ValuationCtx.evIncludeLeases`
  to `computeValuation`. tests/risk.providers.coverage.test.ts: the paused
  public resumption test fakes `beta.messages.stream` (the resumption has
  streamed since D-09 / F9) and asserts the request-level timeout.
- docs/METHODOLOGY.md: the own-history label sentence; four heading
  cross-references. docs/RESEARCH.md §6.3: the equity-REIT exception and the
  per-route Piotroski withholdings. docs/audit/DECISIONS.md: Revised notes on
  D-09, D-20, D-22. docs/audit/REMEDIATION-REPORT.md: the decision range and
  the README cap.
- Dead section citations (§6.6): src/pipeline/stageB/{valuation, returns,
  sectorRouting, growth, capital, forensics, grading, projections,
  scenarioTargets, fairValue, technicals}.ts, src/pipeline/stageA/{validate,
  manifest}.ts, src/pipeline/stageC/{passes, payload, prompts}.ts,
  src/pipeline/{compute, dataBundle, jobRunner, types}.ts,
  src/providers/{anthropic, edgar, finnhub, finra, fmp, fred, http}.ts,
  src/cache/apiCache.ts, src/config/env.ts, src/db/schema.ts,
  src/edgar/{extract, xbrl}.ts, src/report/{schema, history}.ts,
  src/report/export/markdown.ts, src/components/report/{ReportView, sections,
  primitives, ExportButtons}.tsx, src/components/watchlist/{Sidebar,
  RunsDisclosure}.tsx, src/watchlist/watchlist.ts, src/types/core.ts, two app
  routes, and eleven test files' descriptions. The payload pin re-pinned
  (fingerprint `1.3.0:406fa4f6`, 90 762 prompt bytes, financeHash `87fbd94c`).
- docs/audit/DECISIONS.md: D-27. tests/fixtures/audit-intended-deltas.json:
  group `docs-references-audit-2026-09-06` (two note leaves).
- CHANGELOG.md: the audit's entry.

### 8.21 Live-run findings (2026-09-07)

- src/pipeline/stageB/returns.ts `BETA_METHOD_LABEL`: the WACC assumption
  row printed the Blume weights as raw floats ("0.6666666666666666·raw +
  0.3333333333333333") once §8.12 made the WACC read the 2/3–1/3 constants
  from betaEstimate.ts; the label now formats them to three decimals, as the
  clamp note and docs/METHODOLOGY.md already did. The four audited-fixture
  leaves carrying the label moved again and were re-blessed under
  `returns-capital-audit-2026-09-06`; the payload pin moved by −26 bytes
  (tests/stageC.payload.passes.test.ts says why).
- src/pipeline/stageC/consistency.ts: the `verify.check.namedIndividual`
  manifest sentence still said "a source outside filings and transcripts"
  after §8.15 widened the rule to registry figures and the payload's own
  executive and insider rows; it now states the rule as enforced. The check
  itself fired correctly on the live run: a sentence naming the chief
  executive cited an aggregate Finnhub insider-sentiment row, which is none
  of the admitted sources.
- Confirmed on the live report and page: the stored disclaimer in the meta
  strip (F207), the tab semantics (F219), the judge-order sentence for a
  drawn order (F174), the terminal-ROIC house-convention label, the EV lease
  manifest entry on the FMP route, the own-history rank withheld below eight
  quarters, no dead document citations anywhere in the 185 KB Markdown
  export, and no browser console errors on load.

## 9. What was not done

Listed so that nothing below is mistaken for verified.

1. **Live verification.** No provider was called and no paid request was
   made (the repository's no-live-network rule applies to the audit as it
   does to the tests). The one external read was the Cost API reference page
   (§5, T1–T3). Consequences: F228 (a Yahoo chart's in-progress session bar)
   is recorded as a limitation in a comment, not filtered, because it could
   not be observed on the day the audit ran; F6's measured run costs ($1.43;
   $5.31 / $2.66 on MSFT) are labelled as the maintainer's own runs and left
   as reported; the Damodaran spread table (January 2026), the registry
   prices in config/models.json and Blume's fitted coefficients as quoted in
   RESEARCH §7.1 were not re-fetched from their sources.
   One live paid run was made after the audit closed (§1 step 6); it is a
   single issuer on the cheapest route, not the sweep §9 item 2 of the
   remediation report still calls for.
2. **Finder coverage.** 28 of 34 finder passes completed before the session
   limit; the six slices no finder reached (the in-flight diff, tooling and
   CI, every document except the README, the evidence base) were audited
   directly in §4–§7 by one reader rather than by two independent ones.
3. **The design specs** under docs/superpowers/specs were confirmed to carry
   status headers and deviation paragraphs, not re-verified sentence by
   sentence; they are dated records and say so.
4. **Retired-document phrases.** The dead section numbers are gone (§6.6),
   but about forty comments still use the generic placeholders an earlier
   pass introduced ("the application contract", "the EDGAR extraction
   contract", "the cost model"). They are readable and no longer claim a
   location; rewording them to plain descriptions is cosmetic and was left.
5. **The `getConfig` call-count pin** in tests/jobRunner.test.ts (T5) still
   stands as a proxy for "no provider or model boundary crossed"; the
   surrounding assertions pin that property directly and the counter could
   go, as the remediation report already notes.
6. **CI shape.** The Windows job is a smoke job (no lint, coverage or build),
   and dependency updates are manual by design; neither was changed.
7. **Coverage of src/pipeline/stageC/dataOnlyReport.ts** joined the per-file
   risk contract in §3.9; the final verify run (§1) is where its branch floor
   was measured, and the result is recorded there.
8. **Cosmetic and structural follow-ups** the remediation report lists
   (moving `fnv1a32` out of payload.ts, persisting the judge protocol on the
   synthesize artifact, the `FY` period pattern's optional century) were not
   in the audit's scope and remain open.
