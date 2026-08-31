# Code and documentation audit — 2026-08-30

> **Follow-up 2026-08-31.** Every confirmed finding in this audit is now fixed —
> all 36 locations, including the eight defects of the 2026-08-09
> provider/temporal workstream that this document originally deferred to an
> unmerged branch, and the two findings it first left as judgement calls. Each
> fix was reproduced with a failing test first. See "Second pass" and "Third
> pass" below. `npm run verify` passes end to end.

- Audited commit: `8ff1671` (branch `main`)
- Scope: `main` only. The unmerged branches `codex/provider-temporal-integrity`
  (24 commits ahead) and `codex/financial-integrity` (113 commits ahead) were
  **not** merged, audited, or modified.
- Method: two adversarial multi-agent passes. Documentation claims were
  extracted per doc section, each verified against source, and each alleged
  inaccuracy put to three independent refuters. Code defects were found by two
  lenses per subsystem plus six cross-module seam hunters, then each candidate
  faced three refuters with distinct lenses (reproduce / tests-and-intent /
  impact). A finding survives only if fewer than two of three refuters refute
  it.

## Result

`npm run verify` passes end to end (exit 0): dependency shape, typecheck, lint,
product suite, DB CLI integration, both coverage contracts, production build,
and `npm audit --include=dev --audit-level=low` (0 vulnerabilities).

At the start of this audit it did **not** pass — see "Repository gates" below.

Runtime smoke against `npm start`: `/`, `/report/sample`, `/company/DEMO`,
`/company/DBNK`, and `/settings` all return 200 and render; a cross-origin
`POST /api/report` and a forged `Host` are both rejected 403; `GET` on the
mutating report route returns 405; the server log is clean apart from the
expected fail-closed EDGAR contact notice.

## Repository gates repaired

Both of these failed on `8ff1671` before any other change.

1. **`npm run lint` (1744 errors).** `eslint.config.mjs` used root-relative
   ignore globs, so ESLint descended into the gitignored `.worktrees/*/.next`
   build output. Tracked source was always clean. Ignores are now `**/`-prefixed
   and `.worktrees/`, `coverage/`, and `tmp/` are excluded.
2. **`npm test` (`tests/repository.release.test.ts`).** Commits `c36a9b6` and
   `8ff1671` added the two 2026-08-09 provider-integrity documents without
   adding them to the release markdown allowlist, so the "publishes only the
   exact tracked release allowlist" assertion failed. Replaying the check at
   `7b2eb51` (clean), `c36a9b6` (1 file), and `8ff1671` (2 files) confirms the
   failure was pre-existing and not introduced here.

## Code defects fixed

Each was reproduced with a failing test first, then fixed, then re-verified.
As a mutation check, reverting `src/providers/fred.ts`, `src/edgar/extract.ts`
and `src/pipeline/dataBundle.ts` together turned exactly their six tests red
while the control assertions stayed green. The `src/db/index.ts` fix was proven
separately (an `EBUSY` unlink failure without it); the `jobRunner.ts` row is a
display-string fix with no dedicated test.

| Location | Defect | Regression test |
| --- | --- | --- |
| `src/providers/fred.ts:322` | `await res.text().catch(() => "")` converted a mid-body read failure into a successful empty 200. That returned out of the retry loop (skipping every retry), and on the keyed path returned before the keyless `fredgraph.csv` fallback, reporting a timeout as `unknown series id?`. A caller abort was swallowed into a gap instead of propagating. Both sibling clients (`finnhub`, `finra`) already retry this case. | `tests/fred.bodyRead.test.ts` |
| `src/edgar/extract.ts:797` | `parseQuotedTitles` used one character class for every quote style, so a straight apostrophe closed a double-quoted run: `"Management's Discussion and Analysis…"` yielded the fragment `Management`. `buildSynonyms` ranks stub titles above the generic synonyms and Route 1 matches by substring, so that fragment could select the wrong exhibit section. Ordinary possessives could also fabricate a title. | `tests/edgar.quotedTitles.test.ts` |
| `src/pipeline/dataBundle.ts:204` | The M6 last-good-cache guard recognised only `[]` as empty. A zero-length 200 body parses to `body: null` in the FMP loader, so an anomalous refresh overwrote good statement/price data for a full TTL. A value that is not a `LiveExchange` envelope is still correctly not treated as empty. | `tests/dataBundle.emptyRefresh.test.ts` |
| `src/db/index.ts:387` | A pragma or `bootstrapSchema` failure left the SQLite connection open. `getDb()` memoizes only on success, so each later call opened and stranded another lock-holding handle. Proven by an `EBUSY: resource busy or locked` unlink failure without the fix. | `tests/db.bootstrapFailure.test.ts` |
| `src/pipeline/stageB/valuation.ts` (financials route) | The general DCF route suppresses its per-share value when `reportedCurrency` differs from the quote currency, but the `bank` / `insurer` / `reit-mortgage` excess-return route had no such guard. An ADR bank with TWD books and a USD quote produced `perShare = 5.42` (TWD) graded against a USD price and published it as `available`. Now suppressed with a critical `valuation.excessReturn.currency` gap, which also fixes the company page's "vs price" cell (it renders `n/a` once `perShare` is null). | `tests/stageB.adrExcessReturn.test.ts` |
| `scripts/run-security-audit.mjs` | The self-invocation guard compared `import.meta.url` (symlink-resolved by Node) against a merely `path.resolve`d `argv[1]`. Under a symlinked or junctioned checkout the two differ, `main()` never runs, and the security gate exits 0 without auditing. `argv[1]` is now realpath-resolved. | covered by `tests/securityAudit.test.ts` |
| `src/pipeline/jobRunner.ts:548` | The user-visible "not reached" step detail contained a mojibake em dash (`â€"`, UTF-8 `—` decoded as Latin-1). | — |

## Documentation corrected

216 claims were extracted from `README.md` and the five `docs/superpowers/`
documents and checked individually; a fine-grained second pass checked every
task block of the two large plans. Twenty-one corrections were applied. The
most consequential:

- **`README.md` `ANALYSIS_MODEL`** was documented as any "Anthropic model ID".
  `resolveModel` accepts `auto` — which it resolves itself, short-circuiting
  before any assertion — plus the four priced aliases and their eight-digit
  dated snapshots, which it checks with `assertPricedModel`. (`auto` is not a
  priced alias: calling `assertPricedModel("auto")` directly would throw.)
  Anything else throws, and `jobRunner` catches it by marking all four LLM steps
  skipped and returning a data-only report. The table row and a new paragraph
  now state the accepted set and that failure mode. `.env.example` gained the
  same note.
- **CI claims.** The 2026-08-07 plan and design both said CI runs on Node 20.
  `.github/workflows/ci.yml` runs `full` on Node 24 LTS, with a Node 20
  compatibility job and a Windows Node 24 smoke job that run only the product
  and integration suites.
- **Task 22's `jobScheduler` interface block** declared a `releaseJobLease`
  export that does not exist and gave wrong signatures for
  `claimNextQueuedJob`, `renewJobLease`, `acquirePaidPassLease`,
  `renewPaidPassLease`, and `releaseUnbilledPaidPassLease`, plus an incomplete
  `SchedulerLimits` and `PaidPassAcquireResult`. Replaced with the shipped API;
  job-lease release happens through fence-checked `terminalizeClaim`.
- **Task 29's `createSettingsWriteQueue`** signature was replaced with the real
  `SettingsWriteQueueOptions` / `SettingsWriteQueue` interfaces.
- Several test snippets asserted against the wrong shape (`getConcept` returns
  `FetchResult<ConceptValue>`, so fields live at `result.value.data`;
  `buildDataCompleteness` returns `state`, not `status`; relative strength
  exposes `points[].differentialPctPoints`, not `threeMonth.differentialPct`),
  and four SSE and one settlement test name did not match any real test.
- `ProjectionSeries.disclosures` replaced a non-existent top-level
  `Projections.disclosures` (`ProjectionsSchema` is `.strict()`).
- Status blocks were added to each of the four pre-existing plan/design
  documents, recording their implementation state on `main`, because the
  unticked `- [ ]` boxes made a completed plan and an unstarted plan look
  identical. (Three were added in the first pass; the 2026-08-07 design gained
  one later. Two initially said "not implemented"; both were updated once the
  work landed — see the second pass below.)

## Findings the first pass left open (all since closed)

> The 2026-08-09 provider/temporal workstream was listed here as live on `main`
> and deferred to an unmerged branch. All eight are now fixed on `main` — see
> the second-pass section below. This audit had independently re-found three of
> those eight from the code alone, which is why they were treated as real rather
> than as plan-only claims.

### Third pass — the remaining findings

The code audit confirmed defects at 36 distinct locations (102 candidates, 49
confirmed, 53 refuted, 0 unadjudicated, across 342 agents). All of them are now
fixed. The final tranche:

| Location | Defect | Fix | Regression test |
| --- | --- | --- | --- |
| `src/pipeline/stageB/grading.ts` | `accrualsRatioAbs` was the only quality signal with no `suppressedBy` tag, so no route policy could exclude it | Tagged `accrualsRatio` and suppressed on `bank`/`insurer`/`reit-mortgage`. The Sloan ratio is scaled by net operating assets, and NOA subtracts (totalLiabilities − totalDebt) — for a bank that is deposits, its raw material — so this is the same category error the route already avoids for `netDebt`, `fcfDcf`, Altman and Beneish. Bank quality applicability moves 0.72 → 0.57 and the hand-derived composite weight 78.97 → 75.07 | `tests/stageB.grading.test.ts` |
| `src/pipeline/stageC/payload.ts` | Unvalidated provider dates reached `validateCitationRegistry`, whose throw is not caught before the runner's unexpected-failure path, so one bad date terminated the whole job | Normalized at the producer: `registerCitation` maps an unusable date to `null`, keeping the source citable while the assembler invariant stays strictly fail-loud | `tests/stageC.citationDateSafety.test.ts` |
| `src/pipeline/jobRunner.ts` (persistDataOnly) | `markSkipped` only moves a PENDING step, so a pass that failed while RUNNING stayed "running" on a job the client was told was done | Every non-terminal LLM step is swept at the single common exit | `tests/jobRunner.test.ts` |
| `src/pipeline/jobRunner.ts` + `jobArtifacts.ts` | A synthesize-reuse resume verified against an empty analyst evidence set, understating citation coverage | The resume plan now carries `analystFetchedUrls` from the durable artifacts, so verify sees the evidence the run actually gathered even when `bull`/`bear` are superseded | `tests/jobRunner.test.ts` |
| `src/edgar/extract.ts` | The Layer-1 title-only fallback bounded its slice only by other title anchors, so an item-numbered anchor in between did not stop it and the slice ran into a later item | Bounds by the next anchor of ANY entry, as the item-numbered branch already did | `tests/edgar.extract.test.ts` |
| `src/report/export/markdown.ts` | The cost appendix rendered four decimals and totalled UNROUNDED values, so sub-cent steps printed as $0.0000 and the Total need not equal the rows | Uses the shared `formatCostUsd` and `roundedDisplayedCostTotal`, which the on-screen and print surfaces already used | `tests/report.markdownCostTotal.test.ts` |
| `src/report/export/markdown.ts`, `printHtml.ts` | Both exports dropped `forensicScores.notApplicableReason`, so an export reader saw a bare dash with no explanation | Both render a "Not applicable" column | `tests/report.forensicNotApplicable.test.ts` |
| `src/components/charts/FundamentalsCharts.tsx` | A currency axis formatted with `digits=0` labelled a 1.5e9 gridline "$2B" — a label that misstates its own line and can collide with its neighbour | A shared `currencyAxisTick` keeps one decimal | `tests/charts.axisTicks.test.ts` |
| `src/watchlist/watchlist.ts` | The key was only uppercased, so `BRK.B` and `BRK-B` created two rows for one company — and both now resolve to the same report | Adds and removes fold the share-class alias while preserving the stored spelling that provider lookups use | `tests/watchlist.aliasDedupe.test.ts` |

The grading change is the one judgement call in this tranche: it moves every
bank, insurer and mortgage-REIT composite. It is recorded here rather than
buried because the owner may want to revisit the weighting, even though
suppressing the signal is consistent with the route's own stated rationale.

## Second pass — 2026-08-31

Eleven more confirmed findings were fixed, each RED-first. Two findings were
examined and deliberately **not** changed (recorded below), and the previously
listed `src/report/query.ts` and `src/watchlist/watchlist.ts` items turned out to
share one root cause, as did four separate entity-alias findings.

| Location | Defect | Regression test |
| --- | --- | --- |
| `src/pipeline/stageB/valuation.ts` (financials route) | ADR currency guard was missing on the excess-return route — see the first-pass table. | `tests/stageB.adrExcessReturn.test.ts` |
| `src/pipeline/stageC/entityValidation.ts` | Alias matching was case-insensitive, so the trial acronyms ACHIEVE / ATTAIN / TRIUMPH / TRANSCEND matched those words used as ordinary verbs. That raised a spurious `primary-source-required` issue and made the legacy read-time sanitizer replace correct analyst prose with a "Legacy statement withheld" placeholder. ALL-CAPS acronym aliases now match case-sensitively; mixed-case names (retatrutide, Orna Therapeutics) still do not. One fix, four findings. | `tests/stageC.entityAliasCase.test.ts`, `tests/report.legacyEntitySafety.test.ts` |
| `src/report/query.ts` | `getLatestDoneReport` compared symbols exactly while `listReportsForSymbol` and `listRunRefsForSymbol` both fold case and the dot/hyphen share-class alias in SQL, so History and the watchlist could list runs for a report the company page reported as missing. This changed a previously pinned contract; `tests/report.query.test.ts` now documents the new one. | `tests/report.symbolAlias.test.ts` |
| `src/report/completeness.ts` | `xbrl: "failed"` asserts the cross-check ran and disagreed, but the classifier matched prose and so reported "failed" for checks that could not run — including a legacy report whose gap literally says no cross-check is recorded. It now keys on the severity Stage A already assigns (`info` = not checkable, `warn` = real disagreement). | `tests/report.completenessXbrl.test.ts` |
| `src/report/export/markdown.ts` | The export reimplemented value formatting instead of using the canonical `formatFinancialValue`. It had no `currency` alias (those figures printed as a bare number with the word "currency" appended) and no magnitude scaling for `usd`, so one figure read `$13,500,000,000.00` in Markdown and `$13.50B` on screen and in print. Now delegated, so all three surfaces agree. | `tests/report.history.export.test.ts` |
| `src/app/api/report/[jobId]/stream/route.ts` | Next answers HEAD by running GET and dropping the body, so a HEAD probe built the SSE stream, registered a job subscriber and armed the poll/heartbeat timers that a bodiless response never cancels. An explicit HEAD now allocates nothing. | `tests/api.routes.streamHead.test.ts` |
| `src/components/charts/RelativeStrengthChart.tsx` | Each series was rebased to 100 at its OWN first bar, so a stock with three years of history and a benchmark with ten both started at 100 on different dates — the comparison a relative-strength chart exists to make was measured from unrelated origins. All series now share one origin. | `tests/charts.relativeStrengthRebase.test.ts` |
| `src/pipeline/stageB/valuation.ts` (multiples) | A multiple rendered n/m for a negative/zero value kept the own-history percentile computed from that same value, so the report showed a rank (typically 0th) for a figure it simultaneously called meaningless. The distribution (p5..p95) is unaffected and stays. | `tests/stageB.valuation.test.ts` |
| `src/pipeline/stageB/projections.ts` | The projection fan draws one FCF line whose history is the reported LEVERED figure and whose forecast is UNLEVERED FCFF, while the assumption text asserted the whole series was FCFF. The text now names each half and a `projections.fcf.basisChange` disclosure records that the seam is a change of measure, not a forecast of improvement. | `tests/stageB.projections.test.ts` |
| `src/pipeline/stageB/technicals.ts` | MACD(12,26,9) produces a signal line from the 34th row, but the availability gap fired below 35, so at exactly 34 rows the report disclosed a warn-severity "signal line unavailable" for a signal it had computed. | `tests/stageB.macdGapThreshold.test.ts` |
| `src/pipeline/compute.ts` | The runway model anchored liquidity on the newest quarterly balance row even when the newest annual row was more recent — the ordinary case once a 10-K is filed but the matching quarter is not. It now picks by date. | `tests/compute.runwayAnchor.test.ts` |
| `src/report/export/correctedCli.ts` | The JSON sidecar path was derived by replacing an `.html`/`.htm` suffix, so an `--out` without one made the replace a no-op and the JSON overwrote the HTML deliverable the summary still advertised. | `tests/report.correctedCliOutPath.test.ts` |

### The 2026-08-09 provider/temporal workstream — all eight closed

The first pass reported these eight as live on `main` and deferred them to the
unmerged `codex/provider-temporal-integrity` branch. They have since been fixed
directly on `main`, at the same boundaries the design identifies but with a
smaller implementation that reuses mechanisms already in the codebase.

| # | Defect | Fix | Regression test |
| --- | --- | --- | --- |
| 1 | Finnhub insider sentiment accepted a wrong issuer, impossible month/year, and out-of-range MSPR | The response schema now keeps the issuer Finnhub echoes at the top level and on every row and binds it to the requested symbol via `sameEntitySymbol`; year, month and MSPR are bounded to their documented domains | `tests/finnhub.sentimentContract.test.ts` |
| 2 | EDGAR extraction kept `display:none` blocks spelled with single quotes, no quotes, or non-lowercase | One matcher now covers every quoting and casing variant, plus namespaced/hyphenated tag names (`ix:nonFraction`) whose names were truncated at the colon. A leading `\s` keeps a `data-style` decoy on visible content from being stripped | `tests/edgar.hiddenVariants.test.ts` |
| 3 | FMP admitted schema-invalid HTTP 200s to memory and SQLite before endpoint validation | The endpoint contract is proved INSIDE the `cachedFetch` loader and throws `FmpSchemaError`, mirroring how `validateEntityBody` already kept wrong-symbol bodies out. A legitimately empty response stays cacheable | `tests/fmp.cacheAdmission.test.ts` |
| 4 | EDGAR tickers/submissions/company-facts admitted malformed or wrong-CIK bodies to cache before parsing | Each supplies a `validateBody` to the transport hook filing text already used, running the same JSON, schema and CIK checks early enough to keep the body out of the cache | `tests/edgar.jsonCacheAdmission.test.ts` |
| 5 | Stage A labelled cached-stale statements fresh because it checked only fiscal-period recency | A `staleness.fundamentalsCache` check reports the contributing envelopes' own stale state, exactly as the neighbouring quote check already did. Fixture-mode envelopes are excluded: their `stale: true` marks "never current data", not a cache-TTL overrun | `tests/stageA.validate.test.ts` |
| 6 | The derived next-earnings datum replaced its observation date with the future event date | `asOf` is inherited from the parent envelope; the event date stays in the datum, so downstream freshness comparisons stop treating it as newer than data observed later | `tests/dataBundle.earnings.test.ts`, `tests/risk.providers.coverage.test.ts` |
| 7 | EDGAR company facts used the fetch date as its observation date | `latestEligibleFactEnd` resolves the newest core-form period end no later than the fetch date, falling back to the fetch date only when no eligible fact exists | `tests/edgar.factObservationDate.test.ts` |
| 8 | FINRA treated a valid empty row array as malformed, making the informational no-data branch unreachable | An empty array returns `[]`; only a payload whose rows were all unparseable returns null. The informational branch is now reachable and covered | `tests/finra.fred.test.ts` |

Two of these changed contracts that existing tests pinned — the earnings `asOf`
and the report-symbol lookup. Both pinned tests were updated in place with a
comment recording what changed and why, rather than being deleted.

### Two findings first deferred, then fixed

Both were initially left alone and are recorded here because the reasoning
changed on a second look:

- **`accrualsRatioAbs` untagged.** First judged a modelling opinion. Re-examining
  the ratio's own definition settled it: NOA subtracts
  (totalLiabilities − totalDebt), which for a bank is deposits — its raw
  material. That is precisely the rationale the route already gives for
  suppressing `netDebt` and `fcfDcf` on financials, so suppressing the accrual
  signal there follows the codebase's stated principle rather than a preference.
  Fixed, with the hand-derived bank weight recomputed in the test.
- **Markdown cost total.** First judged a coin-flip between misstating spend and
  adding noise. That was wrong: `formatCostUsd` and `roundedDisplayedCostTotal`
  already existed and were already used by the on-screen and print surfaces —
  the project had made this decision, and only the Markdown exporter had not
  adopted it. Fixed by using them.

## Reproducing

```powershell
npm ci
npm run verify
```

All 22 regression suites this audit added can be run alone:

```powershell
npx vitest run --config vitest.config.ts `
  tests/api.routes.streamHead.test.ts `
  tests/charts.axisTicks.test.ts `
  tests/charts.relativeStrengthRebase.test.ts `
  tests/compute.runwayAnchor.test.ts `
  tests/dataBundle.emptyRefresh.test.ts `
  tests/db.bootstrapFailure.test.ts `
  tests/edgar.factObservationDate.test.ts `
  tests/edgar.hiddenVariants.test.ts `
  tests/edgar.quotedTitles.test.ts `
  tests/finnhub.sentimentContract.test.ts `
  tests/fmp.cacheAdmission.test.ts `
  tests/fred.bodyRead.test.ts `
  tests/report.completenessXbrl.test.ts `
  tests/report.correctedCliOutPath.test.ts `
  tests/report.forensicNotApplicable.test.ts `
  tests/report.markdownCostTotal.test.ts `
  tests/report.symbolAlias.test.ts `
  tests/stageB.adrExcessReturn.test.ts `
  tests/stageB.macdGapThreshold.test.ts `
  tests/stageC.citationDateSafety.test.ts `
  tests/stageC.entityAliasCase.test.ts `
  tests/watchlist.aliasDedupe.test.ts
```

Several fixes are additionally covered by assertions added to existing suites
(`tests/edgar.jsonCacheAdmission.test.ts`, `tests/stageB.grading.test.ts`,
`tests/stageB.projections.test.ts`, `tests/stageB.valuation.test.ts`,
`tests/jobRunner.test.ts`, `tests/report.legacyEntitySafety.test.ts`,
`tests/finra.fred.test.ts`, `tests/dataBundle.earnings.test.ts`,
`tests/edgar.extract.test.ts`, `tests/report.history.export.test.ts`,
`tests/report.query.test.ts`), which `npm run verify` covers.
