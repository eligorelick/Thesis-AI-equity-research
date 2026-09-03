# Remediation progress

Read this, `DECISIONS.md`, and `git log` before resuming.

## Status

| Workstream | State | Branch | Merged at | Notes |
|---|---|---|---|---|
| Phase 0 reconciliation | done | main | aa33266 | `README-RECONCILIATION.md` (60 claims, 11 verify items, 7 extra discrepancies) |
| WS1 model registry / request shaping | done | main | c639a8c | D-01..D-06; `config/models.json` + `src/models/registry.ts` drive shaping, prices, allow-list |
| WS2 leases / spend under failure | done | main | ddd30b0 | D-07..D-09; presumed spend, lease invariants, stream idle guard |
| WS3 per-request admission | done | main | 6d8343f | D-10; one reservation and one cost row per provider request |
| WS5 sector routing / financials | merged | main | b058dff | D-16, D-17; subagent reported nine of nine criteria met |
| WS6 valuation inputs / disclosure | merged | main | 8e88364 | D-18, D-19; eight of eight met, one residual (N is not a column in the multiples table) |
| WS7 AI pipeline | merged | main | 82f12b9 | D-20; shared-family disclosure, completeness metadata, judge mirroring |
| WS8 security / privacy / compliance | merged | main | 1c5d771 | D-21; five of five met |
| WS4 data layer | merged | main | 8d3b3b3 | D-11..D-15; eleven of twelve criteria met, Form 4 deferred with a disclosed gap |
| Fresh-context reviews | done (4 subagents) | main | — | WS1-3: 2 blockers, 4 should-fix, 8 nits. WS5: 2 blockers, 5 should-fix, 5 nits. WS6: 2 blockers, 5 should-fix, 9 nits. WS8: 3 should-fix, 6 nits |
| Fresh-context review of WS4 | done | main | — | 1 blocker (Caterpillar total debt 16% low), 7 should-fix, 9 nits, plus a pre-existing leak of the EDGAR contact into Yahoo's User-Agent |
| Fresh-context review of WS7 | done | main | — | 3 blockers, 6 should-fix, 4 nits; one sub-claim of a finding was wrong and is recorded as such |
| Review fixes: WS8 | merged | main | e6b854f | Offline guard closed in two suites, settings CAS counter preserved, the token's reach described honestly |
| Review fixes: WS5 | merged | main | a20d9c0 | Mortgage-REIT misrouting, the justified multiple's growth cap, four wrong-rather-than-absent numbers, route metrics wired to a reader |
| Review fixes: WS6 | merged | main | 2d4487d | Finance leases back in enterprise value, the own-history rank on one basis, SBC charged once |
| Review fixes: WS1-3 | merged | main | 8a7cd92 | Resume no longer re-bills, a pass lease no longer blocks its own first request, presumed spend disclosed |
| Review fixes: WS4 | merged | main | af2cef6 | Caterpillar total debt, statement-source gaps, the Yahoo User-Agent leak |
| Review fixes: WS7 | merged | main | f94d9a4 | Shared-family disclosure live on the production path, completeness metadata recomputed, a paid primary survives a thrown mirror, four false-positive checks, `both` sized for two requests |
| Paid run (owner-approved) | done | main | — | Opus 5 / MSFT / $5.31, 99.3% verified. Confirmed the WS7 family warning and per-request settlement live; exposed the schema-repair follow-ups |
| WS4 follow-up: successor lookup | done | main | — | Owner-approved live SEC recording disproved D-14's mechanism: the 8-K12B names one filer. The predecessor is found by a ranked, capped header scan |
| WS4 follow-up: EBIT | done | main | d68ac63 | `ebit` follows operating income only; the refused figure no longer reaches the DCF under a second name |
| WS9 README and docs | done | main | 89f698f | D-22; 250 lines, three generated blocks, doc-lint test, CHANGELOG, engines 22.18 |
| Audited delta contract | done | main | 57cdee7 | D-23; `npm run audit:deltas`, grouped reasons, manifest identity, escaped path keys |

## Plan

Serialized on the scheduler and provider layer (mine, in order): WS1 -> WS2 -> WS3.
Each landed on `main` with the full gate before the next started.

Independent, spawned in parallel on worktrees from `main` as soon as Phase 0 was
committed: WS4, WS5, WS6, WS8. WS7 branched after WS1 merged because both edit
`src/pipeline/stageC/passes.ts` and `src/report/execution.ts`.

File ownership (a workstream edits only these; anything else is a follow-up note):

- WS1: `src/providers/anthropic.ts`, `src/models/registry.ts` (new), `config/models.json` (new), `scripts/models-refresh.mjs` (new), `src/settings/contracts.ts`, `src/report/execution.ts`, `src/pipeline/stageC/passes.ts` (judge/analyst request args only), tests for those.
- WS2/WS3: `src/pipeline/jobScheduler.ts`, `src/pipeline/jobRunner.ts`, `src/db/schema.ts` (additive), `src/config/env.ts` (lease and reservation keys), `src/providers/anthropic.ts` (retry loop, streaming), `scripts/docs-pricing.mjs`, `scripts/reconcile-presumed-costs.mjs`, tests.
- WS4: `src/edgar/**`, `src/providers/edgar.ts`, `src/pipeline/keyless.ts`, `src/pipeline/dataBundle.ts` (fixture gating, backfill), `src/pipeline/stageB/betaEstimate.ts`, `src/providers/fmp.ts` (reserved symbols only), `src/config/env.ts` (`THESIS_STATEMENT_SOURCE` block only), `fixtures/edgar/**`, tests.
- WS5: `src/pipeline/stageB/sectorRouting.ts`, `src/pipeline/stageB/forensics.ts`, `src/pipeline/stageB/financialMetrics.ts` (new), `src/pipeline/stageB/valuation.ts` (only `excessReturnModel`, `reitValuation`, `valueCompany` route dispatch), `src/pipeline/stageB/returns.ts` (ROTE/P-TBV only), `docs/METHODOLOGY.md` (its sector-routing sections, folded in at integration), tests.
- WS6: `src/pipeline/stageB/growth.ts`, `src/pipeline/stageB/valuation.ts` (DCF, terminal, bridge, multiples, labels), `src/pipeline/stageB/capital.ts`, `src/pipeline/stageB/returns.ts` (WACC disclosure, per-year history), `src/pipeline/compute.ts` (wiring only), `src/report/schema.ts` (labels, disclaimer), `docs/METHODOLOGY.md` (new), tests.
- WS7: `src/pipeline/stageC/**` (except the request-arg builders WS1 owns), `src/report/schema.ts` (`case_strength`, metadata), `src/report/execution.ts` (shared-family note), tests.
- WS8: `src/app/requestSecurity.ts`, `src/app/api/sameOrigin.ts`, `src/pipeline/jobSchedulerBootstrap.ts`, `src/app/api/jobs/resume` (new), `src/config/env.ts` (`THESIS_RESUME_ON_START` block only), `scripts/settings-reset.ts` (new), `docs/PRIVACY.md` and `docs/DATA-RIGHTS.md` (new; README sections in WS9 link them), tests.
- WS9: `README.md`, `CHANGELOG.md`, `scripts/docs-*.mjs`, `tests/docs.lint.test.ts`, `package.json` engines.

Subagents do not edit `README.md`; they record README-impacting facts in
`docs/audit/README-NOTES-WS<n>.md` for WS9.

Gate after every merge: `npm test`, `npm run test:integration`,
`npm run test:coverage`, `npm run typecheck`, `npm run lint`. Doc-lint joins the
gate once WS9 creates it.

## Done

- 2026-09-02: Phase 0 read (README, env schema, providers, pipeline stages A/B/C, scheduler, runner, analysis modules, tests, specs). Reconciliation, decisions, progress written. Commit aa33266.
- 2026-09-02: WS1. `config/models.json` (snapshot 2026-09-02) plus a zod-validated registry drive request shaping, pricing, the allow-list and `auto` preference. `npm run models:refresh` diffs the registry against a fetched price list without sending a model request. Commit c639a8c.
- 2026-09-02: WS2. Expired unsettled reservations settle as presumed spend (`cost_log.settlementKind`), reconciled downward by a late settlement or the Usage and Cost API; four lease invariants are asserted at startup; every pass streams behind an idle guard. Commit ddd30b0.
- 2026-09-02: WS3. `THESIS_RESERVATION_MODE=request` (default) admits and settles each provider request on its own lease, the SDK's own retries are off, and the pass worst case is reported rather than reserved. Commit 6d8343f.
- 2026-09-02: merged WS8 (1c5d771), WS5 (b058dff) and WS6 (8e88364). Full gate green after each: 3423 then 3451 product tests, 4 integration, both coverage contracts.
- 2026-09-02: merged WS4 (8d3b3b3), the audited delta contract (57cdee7), WS7 (82f12b9) and the WS8, WS5, WS6 and WS1-3 review fixes (e6b854f, a20d9c0, 2d4487d, 8a7cd92). Full gate green after each.
- 2026-09-02: WS9. README at 250 lines with three generated blocks, `tests/docs.lint.test.ts`, CHANGELOG, WS5's separate methodology note folded into `docs/METHODOLOGY.md` and deleted (811fb74, 89f698f). Remediation report 80b2b99.
- 2026-09-02: merged the WS4 review fixes (af2cef6). 3716 product tests.
- 2026-09-03: merged the WS7 review fixes (f94d9a4) and regenerated the README configuration block the new `.env.example` prose moved (60b29e3). Full gate green: 3727 product tests, 4 integration, both coverage contracts, build, `audit:security` 0 vulnerabilities.
- 2026-09-03: the one WS4 follow-up the fix agent could not own — `ebit` bypassing the adjusted derivation — closed on the Stage B baseline (d68ac63). Two tests that encoded the retired rule changed with it; `docs/METHODOLOGY.md` states the EBIT basis. The audited projection did not move.

## Next

All nine workstreams, their fresh-context reviews and every review fix are
merged, and the full gate is green on the result.

Nothing is outstanding. All nine workstreams, their reviews and every review
fix are merged; the worktrees are removed, the EDGAR payloads are recorded and
the authorised paid run is measured and folded into the README. Two follow-ups
the paid run exposed are listed in the remediation report.

## Open questions for the owner (asked at the end of the turn, never mid-task)

1. ~~Measured end-to-end cost figures require a live paid run.~~ **Approved and done, 2026-09-03**: Opus 5, MSFT, $5.31, in the README table beside the Haiku figure. Every pass was schema-rejected once and repaired, so six requests bought three results; see the remediation report.
2. ~~Recording the real SEC payloads for CIK 2115436 requires a live EDGAR fetch.~~ **Approved and done, 2026-09-03.** The recording disproved D-14's mechanism; see the revised decision and `fixtures/edgar/xom_successor_*`.
3. `auto` default and default effort are unchanged (Opus 5, `high`).
