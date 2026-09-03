# README reconciliation (Phase 0)

Date: 2026-09-02. Baseline commit: `9d137fa`. Every row cites the code that was
opened to reach the verdict. Nothing below is inferred from the README, the
brief, or memory alone.

Verdicts:

- **TRUE**: the README sentence describes what the code does.
- **STALE**: the README matches the code, but the code itself is wrong against
  the facts verified on 2026-09-02, so both must change.
- **PARTIAL**: part of the sentence holds; the rest does not.
- **FALSE**: the code does something else.
- **UNVERIFIED**: could not be checked offline (external link, live service).

Actions name the workstream that owns the change. "WS9" alone means only the
README wording changes.

## A. README claims

| # | README claim (line) | Code (file:line) | Verdict | Action |
|---|---|---|---|---|
| R-01 | Local-first app with history, comparison, watchlist, Markdown export, print-to-PDF (3-6) | `src/app/api/watchlist`, `src/app/api/export/[reportId]/route.ts:42` (`format` = md or print), `src/report/export/printHtml.ts` | TRUE | none |
| R-02 | "Does not provide buy/sell/hold ratings" (8-11); disclaimer text | `src/report/schema.ts:386` `DISCLAIMER_TEXT` = "Informational only — not investment advice."; reports emit A–F aspect grades (`src/pipeline/stageB/grading.ts`) and scenario price targets (`src/pipeline/stageB/valuation.ts` scenarios) | PARTIAL | WS6: disclaimer names what is emitted (grades, scenario targets); WS9 README |
| R-03 | Fetches from FMP, EDGAR, Yahoo, FINRA, FRED, Finnhub (15-16) | `src/providers/{fmp,edgar,yahoo,finra,fred,finnhub}.ts` | TRUE | none |
| R-04 | Validates freshness, balance-sheet identities, FMP vs XBRL (17-18) | `src/pipeline/stageA/validate.ts:5,42,197`; `src/edgar/xbrl.ts` `crossCheck` | TRUE | none |
| R-05 | "Independent" bull and bear analyses then synthesis (22-23) | `src/pipeline/stageC/passes.ts:1015-1146` `runBullThenBear` (bear launched after the bull's first token; bear prompt forbids assuming a bull); judge sees BULL then BEAR in a fixed order `passes.ts:1163-1198` | PARTIAL | WS7: randomized/recorded order, length caps, `case_strength` |
| R-06 | Every number carries source path and as-of date; verification without a model call (24-25) | `src/pipeline/stageC/index.ts` `verifyCapability: { billable: false }`, `bindDeterministicReportProvenance`; `passes.ts:1622-1839` `runVerifyPass` | TRUE | WS7 adds direction/period/unit checks |
| R-07 | Requires Node.js 24 LTS; Node 20 unsupported because workers rely on Node 24 type stripping (33-38) | `package.json` `engines.node = ">=20.9.0"`; no Node-24-only API found (`grep node:sqlite / strip-types` empty); `.github/workflows/ci.yml` runs Node 24 only | FALSE (engines contradict the README; type stripping is default from Node 22.18) | WS9: engines `>=22.18.0`, README sentence rewritten |
| R-08 | Quick start shows PowerShell first (40-47) | n/a | TRUE but not the required order | WS9: bash first, PowerShell second |
| R-09 | Keyless mode: no `FMP_API_KEY` + `EDGAR_CONTACT` serves real tickers from EDGAR and Yahoo (49-52, 113-118) | `src/config/env.ts` `fixtureMode: parsed.FMP_API_KEY === undefined`; `src/pipeline/dataBundle.ts:1550-1700` keyless swap; `src/pipeline/keyless.ts` | TRUE | none |
| R-10 | `/report/sample` static; `DEMO`/`DBNK` fixtures only while no key; with a key they go to the live provider (58-68) | `src/providers/fmp.ts:17,1035` fixtures only in fixture mode; `dataBundle.ts:1365` progress line; `env.ts` empty string → undefined | TRUE today | WS4: reserved fixture symbols never reach any provider (D-11); WS9 |
| R-11 | `FMP_API_KEY=""` restores fixtures (67) | `src/config/env.ts` `blank()` maps empty to undefined | TRUE | WS9: state it explicitly in quick start |
| R-12 | Without `EDGAR_CONTACT` live EDGAR is disabled (72-76, 220-222) | `src/providers/edgar.ts` `hasConfiguredEdgarIdentity`, `createDefaultEdgarTransport` throws `EdgarIdentityError` | TRUE | none |
| R-13 | Dev and prod bind to `127.0.0.1` (85) | `package.json` scripts `next dev -H 127.0.0.1`, `next start -H 127.0.0.1` | TRUE | none |
| R-14 | Config table rows (92-111) | `src/config/env.ts:109-120`: `THESIS_MAX_ACTIVE_JOBS` 1, `THESIS_MAX_ACTIVE_LLM_CALLS` 2, `THESIS_PAID_PASS_LEASE_SECONDS` default 900 exclusive-min 600 max 2147483, `THESIS_JOB_LEASE_SECONDS` default 900 exclusive-min 0; FRED keyless CSV `src/providers/fred.ts:9,265` | TRUE | WS9: generate the table from the schema (`npm run docs:config`); new keys from WS2/3/4/8 |
| R-15 | `ANALYSIS_MODEL` accepts `auto` or one priced alias (99) | `src/providers/anthropic.ts:130-158` `PRICING`, `PRICED_MODEL_ALIASES`, `pricedModelAlias` | PARTIAL (also accepts dated forms; rejects `claude-fable-5-1`) | WS1 |
| R-16 | Keyless member table and provenance labels (120-124) | `src/pipeline/keyless.ts` `applyKeylessFallbacks` | TRUE | none |
| R-17 | Beta from five years of monthly returns vs SPY; market cap = price × shares (126-127) | `src/pipeline/stageB/betaEstimate.ts` `BETA_MAX_MONTHS=60`, `BETA_MIN_MONTHS=24`, OLS on close-to-close log returns, returns `rSquared`, no SE; `keyless.ts` profile | TRUE (not dividend-adjusted, no SE, Blume not shown beside raw) | WS4 |
| R-18 | YTD-difference quarter derivation marked `derivation` (127-131) | `src/edgar/statements.ts:1212-1264` `quarterResolver`, `1539-1610` `buildStatementRows` | TRUE | none |
| R-19 | Interest-expense stand-in = cash interest paid (`InterestPaidNet`) when no us-gaap interest line (131-133) | `statements.ts:236-254` chain: `InterestExpense`, `InterestExpenseNonoperating`, `InterestExpenseDebt`, `InterestAndDebtExpense`, `InterestExpenseOperating`; then `InterestPaidNet`, `InterestPaid` | TRUE (README omits `InterestPaid`; the disclosure says the cash figure "includes interest capitalized", which is wrong for `InterestPaidNet`, a net-of-capitalized figure) | WS4: per-tag wording; versioned synonym module |
| R-20 | Operating-income stand-in = pretax income + interest expense, not on bank-style filers (133-136) | `statements.ts:314-331` `INCOME_CHAINS.operatingIncome` `sumAll`; `src/edgar/xbrl.ts:528-535` `looksLikeBankTagging` | TRUE (no subtraction of non-operating items) | WS4 |
| R-21 | Equity stand-in (136-139) | `statements.ts` `BALANCE_CHAINS.totalStockholdersEquity` diff/fallback | TRUE | none |
| R-22 | Maturity-schedule next-twelve-months figure stands in for short-term debt when no current-debt line (140-143) | `statements.ts:458-469` (`DebtCurrent` first, then `sumAny` of `LongTermDebtCurrent`, `ShortTermBorrowings`, `CommercialPaper`, combined tag, maturities), `1368-1473` `resolveDebtOverlaps` | TRUE (maturities can be summed with `ShortTermBorrowings`; note does not say "annual-only") | WS4 |
| R-23 | Split restatement disclosed as `keyless.stockSplits` (143-147) | `src/edgar/splits.ts`; `statements.ts:1714-1855` returns `splits` | TRUE | none |
| R-24 | IFRS and 8-K12B successor registrants leave statements empty, manifest names the case (149-155) | `keyless.ts:897-914` `describeEmptyStatements`; `src/providers/edgar.ts` `companyFactsSchema` accepts string cik | TRUE | WS4: successor → predecessor companyfacts as `predecessor` rows; README |
| R-25 | No keyless source for estimates, insider trades, 13F, news, transcripts, compensation, segments, earnings calendar (157-162) | `grep "Form 4"` in `src/providers/edgar.ts` empty; `keyless.ts` members list | TRUE | WS4: Form 4 or explicit "not implemented keylessly" list |
| R-26 | Yahoo requests carry a User-Agent, are rate-limited and cached (164-166) | `src/providers/yahoo.ts:231-248`; `src/providers/http.ts` `DEFAULT_PROVIDER_RATES.yahoo` 2/s | TRUE | WS8: data-rights statement |
| R-27 | `DEMO`/`DBNK` never reach the keyless layer; no Yahoo request; "EDGAR is still queried for filings as on any run" (168-171) | `dataBundle.ts:1580-1590` `runKeyless` requires an EDGAR-confirmed issuer in fixture mode; the EDGAR bundle is built for every symbol (`fixtures/fmp/profile/DEMO.json` carries cik `0000000000`) | TRUE today; violates the WS4 criterion | WS4 (D-11) |
| R-28 | Entry-tier plan caps read from FMP's rejection, truncated depth in manifest, restricted endpoints become gaps (175-183) | `src/providers/fmp.ts` plan-limit adaptation (`fmp.planLimit` manifest entries) | TRUE | WS4: EDGAR backfill of truncated history + `THESIS_STATEMENT_SOURCE` |
| R-29 | "own-history multiple percentiles need eight quarters" (187-189) | `valuation.ts` `MIN_HISTORY_OBS_FOR_BAND = 8`, `percentileRank`; `src/report/schema.ts:645` `own5yPercentile` | TRUE | WS6: relabel as rank among N quarters |
| R-30 | Data-only report carries every Stage B result (191-196) | `src/pipeline/jobRunner.ts` data-only path; `assembleReport` | TRUE | none |
| R-31 | Terminal ROIC rule: fade to WACC unless ROIC > WACC in each of the last four+ years, then half the median spread capped at 5 pp (198-201) | `valuation.ts:287-325` `terminalRoic` (compares every year to the single current `waccPct`) | TRUE (house rule; single-year WACC) | WS6: label as house convention; per-year WACC when FRED allows |
| R-32 | Near-term growth = lower of 3y/5y revenue CAGR; sign disagreement → terminal rate (201-204) | `valuation.ts:423-650` `buildDcfAssumptions` (472-479) | TRUE | WS6: retire; log-linear + median-of-methods |
| R-33 | Balance-row selection rule (204-208) | `src/pipeline/compute.ts` (commit 582eb24 "whole-row balance anchor") | TRUE | none |
| R-34 | Assumption block states which rule applied; design note path (209-212) | `valuation.ts` assumptions notes; `docs/superpowers/specs/2026-09-02-analysis-quality-design.md` exists | TRUE | WS9: link `docs/METHODOLOGY.md` instead |
| R-35 | Piotroski on financial routes withholds current-ratio, gross-margin and both CFO signals (212-215) | `src/pipeline/stageB/forensics.ts:1109-1316` `computePiotroski` `financialsSuppressed` (leverageDown and turnoverUp still scored) | TRUE | WS5: withhold ΔLEVER/ΔTURN with reason |
| R-36 | Unprofitable overlay on financial routes triggers on negative net income alone (215-218) | `src/pipeline/stageB/sectorRouting.ts:199-508` overlays | TRUE | none |
| R-37 | `ANALYSIS_MODEL` accepts five aliases, "optionally as an eight-digit dated snapshot such as `claude-opus-5-20260115`" (224-230) | `anthropic.ts:143-158` `pricedModelAlias` regex `^alias-\d{8}$` for every alias | STALE (dated IDs do not exist for 4.6+ families; `claude-fable-5-1` is missing) | WS1 |
| R-38 | `auto` prefers opus-5, opus-4-8, sonnet-5, fable-5 (230-232) | `anthropic.ts:72-77` `PREFERENCE_ORDER` | TRUE (no Fable 5.1) | WS1 |
| R-39 | Haiku judge raised to Sonnet 5, disclosed as `model-floor` (234-237) | `passes.ts:324-326` `judgeModelFor`, `JUDGE_MODEL_FLOOR`; `src/report/execution.ts` `buildExecutionMetadataEntry` | TRUE | WS1: disclosure names both models and effort handling |
| R-40 | One analyst repair attempt; judge two retries; transport failures and refusals not repaired (239-245) | `passes.ts` `MAX_JUDGE_RETRIES = 2`; analyst repair (commit 10aa8ab); `anthropic.ts:1275-1352` transport loop (3 attempts) plus SDK `maxRetries: 5` | TRUE | WS3 restructures retries |
| R-41 | Settings precedence DB → env → default (247-249) | `src/settings/settings.ts` `resolveValue` | TRUE | WS8: document reset path; add `npm run settings:reset` |
| R-42 | Durable leases across processes; startup drains queue; single wake timer (251-254) | `src/pipeline/jobSchedulerBootstrap.ts`, `src/instrumentation.ts`; `jobScheduler.ts:697-745` `earliestDurableWake` | TRUE | WS8: `THESIS_RESUME_ON_START` |
| R-43 | Reservation = 108 × maximum cost of one capped request (255-259) | `anthropic.ts:251-308` `maximumPassCostUsd`; `PASS_BILLING_EXPOSURE_MULTIPLIER` = 6 × 3 × 6 | TRUE | WS3 replaces with per-request reservations |
| R-44 | Reservation table figures (261-267) | Recomputed from the formula: Haiku $70.20/$373.68; Sonnet 5 $347.76/$373.68; Opus $856.44/$934.20; Fable 5 $1,704.24/$1,868.40 | TRUE | WS3: generated table (`npm run docs:pricing`) |
| R-45 | Job cap near actual cost rejects every job; $1.43 Haiku run measured 2026-09-01 (269-277) | Admission `jobScheduler.ts:916-1035` compares `jobSettled + jobReserved + reserve > cap`; measured figure from the 2026-09-01 run log | TRUE | WS3: $5 cap admits a Sonnet 5 fixture run |
| R-46 | Deterministic verify reserves $0; a launched call retains its reservation until settlement or lease expiry (279-285) | `maximumPassCostUsd` verify branch; `jobScheduler.ts:286-299` `pruneExpiredPaidLeases` deletes expired reservations | TRUE (expiry silently releases the reservation) | WS2: presumed-spent on expiry |
| R-47 | SQLite stored locally outside the repo (289-291) | `env.ts` `THESIS_DATA_DIR`/`THESIS_DB_PATH` app-data default | TRUE | WS9: retention and deletion path |
| R-48 | What leaves the machine (293-296) | `EDGAR_USER_AGENT` built from `EDGAR_CONTACT` on every SEC request (`edgar.ts`); filing excerpts and ticker context in the Stage C payload (`src/pipeline/stageC/payload.ts`); model-issued web search (`anthropic.ts` `WEB_SEARCH_TOOL_TYPE`) | PARTIAL (none of the three are named) | WS8 |
| R-49 | Single-user, no auth, loopback only (298-301) | `src/app/requestSecurity.ts` `assertSameOrigin` loopback rule | TRUE | none |
| R-50 | Security advisory link (303-305) | external URL | UNVERIFIED | none |
| R-51 | "The server's PDF-format endpoint returns print-ready HTML" (314-316) | `src/app/api/export/[reportId]/route.ts:42` `?format=print` | TRUE but misnamed | WS9: say `?format=print` |
| R-52 | Pipeline order fetch → validate → compute → bull → bear → synthesize → verify (318-322) | `jobRunner.ts` step order; bull and bear overlap in the streaming path (`runBullThenBear`) | TRUE | WS9: note the overlap |
| R-53 | Commands list (331-346) | `package.json` scripts (`test:product`, `test:watch`, `export:corrected` exist and are unlisted) | PARTIAL | WS9: generated commands table |
| R-54 | Test suite makes no network requests whatever `.env` contains; `EDGAR_LIVE_SMOKE` opt-in issues two requests (352-361) | `tests/setup/noLiveNetwork.ts`; `tests/edgar.client.test.ts` live smoke gated on `EDGAR_LIVE_SMOKE` | TRUE | none |
| R-55 | CI runs Node 24 plus a Windows smoke run (363-366) | `.github/workflows/ci.yml` | TRUE | WS9 (engines note) |
| R-56 | Project layout (370-376) | `ls fixtures` → `edgar`, `fmp`, `report` | TRUE | WS9: add `config/`, `docs/` |
| R-57 | Limitations: three stand-ins; IFRS/successor empty; verify tolerance rules (380-404) | as R-19 to R-24 and `runVerifyPass` | TRUE today | WS4/WS7 change the behavior; WS9 rewrites |
| R-58 | License and data rights (412-417) | `LICENSE` MIT; no Yahoo/FMP terms named | PARTIAL | WS8 |
| R-59 | README length 417 lines; unwrapped lines at 171, 183-186, 209, 255 | n/a | FALSE against the under-250-line, wrapped criterion | WS9 |
| R-60 | Not stated anywhere: cache TTLs, freshness thresholds, retention, deletion path, architecture overview, forensic indicator sector applicability, WACC inputs | `src/cache/apiCache.ts:24-80` (reference table; live TTLs in each provider), `src/cache/maintenance.ts` (purge after ttl + 30 days), `src/pipeline/stageA/validate.ts` freshness | missing | WS5/WS6/WS9 |

## B. `[verify in code]` items from the brief

| # | Item | Code (file:line) | Finding | Action |
|---|---|---|---|---|
| V-01 | WS1: are `temperature`/`top_p`/`top_k` sent today? | `anthropic.ts:671-702` `buildPassParams` | Never sent. Params: model, max_tokens, system, messages, tools, thinking, output_config, betas | WS1: request-shaping test per family pins this |
| V-02 | WS1: effort sent to an unsupported model? | `anthropic.ts` `supportsEffort` → `src/report/execution.ts` `modelSupportsEffort` (false for haiku and `claude-sonnet-4-5`); `effort-stripped` adjustment | Dropped for Haiku and disclosed | WS1: registry-driven |
| V-03 | WS1: thinking disabled at xhigh/max? | `anthropic.ts:636-647` `thinkingConfigFor` (adaptive for opus-4-8/opus-5; omitted otherwise; never `disabled`) | Never disabled | WS1: test pins it |
| V-04 | WS1: `max_tokens` from registry? | `anthropic.ts:543-554` `requestOutputTokenLimit`; `passes.ts` `ANALYST_MAX_TOKENS = 64_000`, `JUDGE_MAX_TOKENS = 96_000` | Fixed constants, not effort- or registry-driven | WS1 (D-05) |
| V-05 | WS2: does lease renewal exist while a paid call is in flight? | `jobRunner.ts:882-1080` `createSettlementCheckpoint` (`setInterval(renewPaidPassLease, TTL/4)`, aborts on lost authority); job heartbeat `jobRunner.ts:2305` (5 min, TTL 900 s ≥ 2 × 300 s) | Exists. TTL ≥ 2 × heartbeat holds for the defaults | WS2: startup invariant check (D-08) |
| V-06 | WS2: wake timer never re-claims a job whose paid lease is live | `jobScheduler.ts:372-545` `claimQueuedJobInternal` skips retries while an ancestor paid lease is live; `tests/jobScheduler.test.ts:465,494,937` | Holds for retry lineage; an expired job lease with a live paid lease errors the job and blocks the retry until the paid lease expires | WS2: two-process test |
| V-07 | WS4: interest tags | `statements.ts:242` | All five brief tags present; `InterestPaidNet`/`InterestPaid` stand-in after all miss | WS4: note wording per tag |
| V-08 | WS4: `NonoperatingIncomeExpense`, `InvestmentIncomeInterest`, `IncomeLossFromEquityMethodInvestments` names | `statements.ts` `totalOtherIncomeExpensesNet: NonoperatingIncomeExpense`; `:336` `InvestmentIncomeInterest` in the interest-income chain; the equity-method tag appears only inside the long pretax tag name | Present in the taxonomy; not subtracted from the operating-income stand-in | WS4 |
| V-09 | WS4: short-term debt tag order | `statements.ts:458-469` | `DebtCurrent` first; then `sumAny` of `LongTermDebtCurrent`, `ShortTermBorrowings`, `CommercialPaper`, combined, maturities | WS4: maturities only after all four miss (D-13) |
| V-10 | WS5: financial routes withhold FCFF DCF, reverse DCF, ROIC−WACC, EV/EBITDA | `sectorRouting.ts:700-760` `BASE_POLICIES` bank/insurer/reit-mortgage suppress `evEbitda`, `fcfDcf`, `altmanZ`, `beneishM`, `accrualsRatio`; `valuation.ts:2352-2530` `valueCompany` dispatches financial routes to `excessReturnModel` (1989-2195) | DCF/EV/EBITDA withheld; excess-return model exists; reverse DCF and ROIC−WACC suppression to be confirmed per route by WS5; route metrics (NIM, efficiency, CET1, NPL, combined ratio, BV/share, spread, leverage) listed as `lead` but not computed | WS5 |
| V-11 | WS8: tests cover foreign-origin form POST and fetch | `tests/api.routes.sameOrigin.test.ts:183-196,743-769` (`Sec-Fetch-Site: cross-site`, cross-site Origin, route-level 403 for `/api/report`) | Cross-site fetch covered; no test with a form-encoded body plus `Sec-Fetch-Mode: navigate`; requests with neither Fetch Metadata nor Origin are allowed with no token (`:175`) | WS8 |

## C. Discrepancies beyond the brief

1. Cache-read pricing is a flat 0.1 × input (`anthropic.ts` `CACHE_READ_MULTIPLIER`); Fable 5.1 reads at $0.25/MTok (0.025 ×). The WS1 registry carries per-model cache prices.
2. `apiCache.ts` keeps a reference TTL table that no production caller reads; the live TTLs are per-provider constants. WS9 documents the live values, not the reference table.
3. `tests/jobScheduler.test.ts:2527` pins acceptance of eight-digit dated snapshots for every alias. WS1 changes that test (reason recorded in the commit message).
4. Fixture profiles carry synthetic CIKs (`0000000000`, `0000000001`) that the EDGAR bundle would send to `data.sec.gov` on a fixture run. WS4 (D-11).
5. No `fixtures/edgar` payload exists for CIK 2115436; a recorded fixture needs an owner-approved live fetch. WS4 builds a structurally faithful hand-written fixture and the remediation report marks recording as deferred.
6. `web_search_20260318` (code) vs `web_search_20260209` (SDK skill cache). The live run on 2026-09-01 used the code's type successfully; left unchanged, noted as a follow-up to re-verify on the next owner-approved live run.
7. `README.md:36-38` justifies Node 24 with "workers that rely on Node 24's native type stripping"; Node 22.18 strips types by default and nothing in the harness pins 24.
