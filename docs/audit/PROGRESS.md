# Remediation progress

Read this, `DECISIONS.md`, and `git log` before resuming.

## Status

| Workstream | State | Branch | Notes |
|---|---|---|---|
| Phase 0 reconciliation | done | main | `README-RECONCILIATION.md` (60 claims, 11 verify items, 7 extra discrepancies) |
| WS1 model registry / request shaping | next | main | D-01..D-06 |
| WS2 leases / spend under failure | pending (after WS1) | main | D-07..D-09 |
| WS3 per-request admission | pending (after WS2) | main | D-10 |
| WS4 data layer | pending (subagent, worktree) | `ws4-data-layer` | D-11..D-15 |
| WS5 sector routing / financials | pending (subagent, worktree) | `ws5-financials` | D-16, D-17 |
| WS6 valuation inputs / disclosure | pending (subagent, worktree) | `ws6-valuation` | D-18, D-19 |
| WS7 AI pipeline | pending (subagent, after WS1 merges) | `ws7-pipeline` | D-20 |
| WS8 security / privacy / compliance | pending (subagent, worktree) | `ws8-security` | D-21 |
| WS9 README / docs | last (me) | main | D-22 |

## Plan

Serialized on the scheduler and provider layer (mine, in order): WS1 → WS2 → WS3.
Each lands on `main` with the full gate before the next starts.

Independent, spawned in parallel on worktrees from `main` as soon as Phase 0 is
committed: WS4, WS5, WS6, WS8. WS7 branches after WS1 merges because both edit
`src/pipeline/stageC/passes.ts` and `src/report/execution.ts`.

File ownership (a workstream edits only these; anything else is a follow-up note):

- WS1: `src/providers/anthropic.ts`, `src/providers/modelRegistry.ts` (new), `config/models.json` (new), `scripts/models-refresh.ts` (new), `src/settings/contracts.ts`, `src/report/execution.ts`, `src/pipeline/stageC/passes.ts` (judge/analyst request args only), tests for those.
- WS2/WS3: `src/pipeline/jobScheduler.ts`, `src/pipeline/jobRunner.ts`, `src/db/schema.ts` (additive), `src/config/env.ts` (lease and reservation keys), `src/providers/anthropic.ts` (retry loop, streaming), `scripts/docs-pricing.ts`, tests.
- WS4: `src/edgar/**`, `src/providers/edgar.ts`, `src/pipeline/keyless.ts`, `src/pipeline/dataBundle.ts` (fixture gating, backfill), `src/pipeline/stageB/betaEstimate.ts`, `src/providers/fmp.ts` (reserved symbols only), `src/config/env.ts` (`THESIS_STATEMENT_SOURCE` block only), `fixtures/edgar/**`, tests.
- WS5: `src/pipeline/stageB/sectorRouting.ts`, `src/pipeline/stageB/forensics.ts`, `src/pipeline/stageB/financialMetrics.ts` (new), `src/pipeline/stageB/valuation.ts` (only `excessReturnModel`, `reitValuation`, `valueCompany` route dispatch), `src/pipeline/stageB/returns.ts` (ROTE/P-TBV only), `docs/audit/ws5-methodology.md` (merged into `docs/METHODOLOGY.md` at integration), tests.
- WS6: `src/pipeline/stageB/growth.ts`, `src/pipeline/stageB/valuation.ts` (DCF, terminal, bridge, multiples, labels), `src/pipeline/stageB/capital.ts`, `src/pipeline/stageB/returns.ts` (WACC disclosure, per-year history), `src/pipeline/compute.ts` (wiring only), `src/report/schema.ts` (labels, disclaimer), `docs/METHODOLOGY.md` (new), tests.
- WS7: `src/pipeline/stageC/**` (except request-arg builders WS1 owns), `src/report/schema.ts` (`case_strength`, metadata), `src/report/execution.ts` (shared-family note), tests.
- WS8: `src/app/requestSecurity.ts`, `src/app/api/sameOrigin.ts`, `src/pipeline/jobSchedulerBootstrap.ts`, `src/app/api/jobs/resume` (new), `src/config/env.ts` (`THESIS_RESUME_ON_START` block only), `scripts/settings-reset.ts` (new), `docs/PRIVACY.md` and `docs/DATA-RIGHTS.md` (new; README sections in WS9 link them), tests.
- WS9: `README.md`, `CHANGELOG.md`, `scripts/docs-*.ts`, `tests/docs.lint.test.ts`, `package.json` engines.

Subagents do not edit `README.md`; they record README-impacting facts in
`docs/audit/README-NOTES-WS<n>.md` for WS9.

Gate after every merge: `npm run verify`; offline fixture reports for `DEMO`,
`DBNK`, `/report/sample` render; doc-lint (once it exists).

## Done

- 2026-09-02: Phase 0 read (README, env schema, providers, pipeline stages A/B/C, scheduler, runner, analysis modules, tests, specs). Reconciliation, decisions, progress written.

## Next

1. Commit Phase 0.
2. Spawn WS4, WS5, WS6, WS8 subagents on worktrees.
3. Start WS1.

## Open questions for the owner (asked at the end of the turn, never mid-task)

1. Measured end-to-end cost figures for the README pricing table require a live paid run. Without approval the table carries estimates only, labeled as such.
2. Recording the real SEC payloads for CIK 2115436 (successor registrant) requires a live EDGAR fetch; until then the test fixture is hand-built.
3. `auto` default and default effort are unchanged (Opus 5, `high`).
