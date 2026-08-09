# Audit remediation verification

- Verification window: 2026-08-08 through 2026-08-09
- Branch: `codex/audit-remediation`
- Audited base: `524d09e81b00b08fe6af386011d34759a5e02fc0`
- Tasks 1-31 head: `aece43b6a8e31bae027be2c1917dc6d5c4a8e9b3`
- Task 32 prerequisite commit: `d58d0902a2547cdfba89b7f25e8c442bfd61ac1f`
- Task 32 coverage-harness correction: `d7cb6ad7583582f70413ad142ac35d7712dbf05a`
- Task 32 seam-coverage commit: `1d8c8e6f8d8284a5074fc13c2f54d029a8f0d54e`
- Task 32 proxy EventSource seam commit: `3b7633655ccf94bb6bdcfba2369a1036da410fe2`
- Verified implementation head before the final documentation commit:
  `3b7633655ccf94bb6bdcfba2369a1036da410fe2`

Status: Task 32 prerequisite invariants are committed; all 26 fresh finding
rows, all 15 cross-task seams, all ten mutation spot checks, all local global
gates, and repository-scope/hash checks are complete. Two independent final
read-only reviews returned **C0 / I0 / M0 — READY**.

## Authority and limitations

The external audit named by the design,
`../Thesis-AI-equity-research-AUDIT_REPORT.md`, is absent from the accepted
workspace. The accepted design, implementation plan, SDD preflight/ledger, the
Tasks 1-31 reports, committed source/tests, and commit ancestry are therefore
the available authority. H1-H6, M1-M13, and L1-L3 are explicit in the accepted
design. A1 is the Task 17 M2-adjacent historical-EV risk. A2-A4 are explicit
design/task-title-derived adjacent risks, but their original external-audit
wording cannot be quoted or independently authenticated unless an accepted copy
is restored.

This document distinguishes historical RED/GREEN evidence from Task 32 fresh
evidence. Historical task reports are navigation aids, not substitutes for the
fresh commands required below. Every completed row has its own fresh result;
no row borrows another row's assertion.

Local workflow source/tests and local `npm run verify` evidence do not prove a
remote GitHub Actions run or repository branch-protection configuration. A
remote URL or observed protection rule will be recorded only if actually
inspected.

## Requirement evidence matrix

| ID | Requirement and design source | Owning task/report/commit chain | Root-cause boundary and unique historical RED regression | Task 32 focused command/result | Residual limitation |
| --- | --- | --- | --- | --- | --- |
| H1 | Entity-bound provider responses; design `H1` | Tasks 2-3; `task-2-report.md`, `task-3-report.md`; `89c9a68..f179bf3`, `405124b` | `validateEntityBody`, `sameCik`, `validateShortInterestScope`; unique regressions: `rejects a wrong-symbol object before cachedFetch can store it`, `submissions rejects a response for a different padded CIK`, and `short interest rejects mixed symbols before deduplication` | `F-H1`; **GREEN** — 3 files; 3 passed/251 skipped; 0.484 s; exit 0 | FMP rows may omit identity only for an endpoint contract that has no identity field and a freshly validated request scope; any present identity must match. |
| H2 | First-class source metadata, statement currency, and observation time; design `H2` | Tasks 4-5; `task-4-report.md`, `task-5-report.md`; `09ef9ef`, `3a99984..e679d99` | `DataBundle.sourceManifest`, Stage C registry assembly, explicit provider/computed provenance kind; unique regressions: `preserves real source envelopes and deduplicates only identical tuples`, `preserves an ADR statement row's reported currency and verifies only the matching identity`, and `retains timeless computed figures with deterministic computation snapshot identity` | `F-H2`; **GREEN** — 3 files (2 passed/1 skipped); 4 passed/267 skipped; 1.81 s; exit 0 | Legacy source `stale` is readable as unknown. No guessed FX conversion is introduced. |
| H3 | Unsupported funds/ETFs stop before company analysis and paid work; design `H3` | Task 10; `task-10-report.md`; `8c32e41..3fe5662` | `classifyInstrumentSupport`, `UnsupportedInstrumentError`, runner and page guards; unique regression: `terminalizes an unsupported ETF before paid work` | `F-H3`; **GREEN** — 3 files; 3 passed/202 skipped; 2.72 s; exit 0 | Historical costs are preserved; the invariant is zero new company/LLM work for an unsupported instrument. |
| H4 | One point-in-time DCF capital anchor; design `H4` | Task 11; `task-11-report.md`; `bcf5359` | Existing whole-row `balPoint`/`balPointBasis` now constructs `DcfBalanceRow`; unique regression: `sales-to-capital uses the newest complete whole balance point with quarterly provenance (audit H4)` | `F-H4`; **GREEN** — 2 files; 2 passed/153 skipped; 0.543 s; exit 0 | WACC's separate annual-debt prerequisite remains unchanged; no averaging or methodology rewrite occurred. |
| H5 | Null-preserving derived finance and EPS suppression; design `H5` | Tasks 12-13; `task-12-report.md`, `task-13-report.md`; `9fecca5..4719263`, `7c9e728` | `deriveFcf`, `computeRunway`, `buildEpsSeries`; unique regressions: `returns null unless both inputs and their sum are finite`, `missing capex suppresses burn and emits one precise input gap`, and `suppresses EPS when the share-count trend is missing but preserves a finite zero trend` | `F-H5`; **GREEN** — 3 files; 11 passed/121 skipped; 0.385 s; exit 0 | WACC weight, DuPont margin, and technical volume are independently evidenced as A2-A4 rather than inferred from this row. |
| H6 | Coherent persisted report snapshot; design `H6` | Task 25; `task-25-report.md`; `e3ba3b` | `PersistedReportView` exact `{ report }` boundary; unique regression: `delegates both persisted routes to one exact report-only boundary` | `F-H6`; **GREEN** — 1 file; 1 passed/5 skipped; 1.48 s; exit 0 | Historical chart inputs are intentionally not persisted; current charts remain separately labeled live analysis. |
| M1 | USD-only pre-revenue overlay; design `M1` | Task 15; `task-15-report.md`; `d0e1b9d..5062fe6` | `normalizeReportedCurrency`, `routeCompany` observation selection and finite guards; unique regression: `skips only the pre-revenue overlay and discloses non-USD currency for $label` | `F-M1`; **GREEN** — 2 files; 12 passed/160 skipped; 0.606 s; exit 0 | Non-USD/unknown/mixed input is disclosed and skipped; no spot or guessed FX conversion exists. |
| M2 | Valid normalized contiguous historical TTM windows; design `M2` | Task 16; `task-16-report.md`; `d82619b` | `normalizeQuarterRows`, `quarterWindowViolation`, `contiguousQuarterWindows`; unique regression: `returns five valid windows and three deterministic rejections after a middle quarter is removed` | `F-M2`; **GREEN** — 3 files; 5 passed/174 skipped; 0.516 s; exit 0 | Historical EV time selection is isolated as A1; M2 covers statement normalization, contiguity, and usable-window scanning. |
| M3 | Aligned price-relative strength; design `M3` | Task 18; `task-18-report.md`; `7d8fd13` | `alignRelativeStrengthWindow`, `relativeStrength`; unique regression: `uses the same exact start/end observations for hand-calculated 3/6/12-month price-relative strength` | `F-M3`; **GREEN** — 2 files; 3 passed/79 skipped; 0.348 s; exit 0 | Metric is split-adjusted close-to-close price return; dividends are explicitly excluded. |
| M4 | Unit/context/lineage-safe XBRL fallback arithmetic; design `M4` | Task 6; `task-6-report.md`; `d3dbace` | `getConcept` computed-sum compatibility gate; unique regressions: `rejects a computed fallback with USD and EUR components` and `treats an incompatible mixed-unit bank sum as not-checkable` | `F-M4`; **GREEN** — 2 files; 3 passed/90 skipped; 0.359 s; exit 0 | Incompatible lineage advances to a later fallback or becomes an explicit not-checkable gap; no partial sum is invented. |
| M5 | Semantic EDGAR metadata/body validation and cache admission; design `M5` | Tasks 7-8; `task-7-report.md`, `task-8-report.md`; `90acd28..685285c`, `db0652a..8df5500` | submissions admission, `fetchFilingDocument`, `filingDocumentBodyProblem`, memory/SQLite validators; unique regressions: `submissions rejects an unknown loose parallel array such as fileNumber when its length differs`, `never returns a pre-upgrade ... poisoned durable filing and self-heals`, and the two `%s`-parameterized Unicode-stable U+0130 raw-text-offset templates (four element cases each; eight instantiated tests) | `F-M5`; **GREEN** — 4 files; 13 passed/213 skipped; 0.877 s; exit 0 | Live EDGAR smoke is opt-in and must remain off during provider-free verification; fixture/injected transport coverage is authoritative locally. |
| M6 | Central immutable safe reads for legacy reports; design `M6` | Task 9; `task-9-report.md`; `2304145` | `parseStoredReportWithSafety`, `sanitizeLegacyEntityConflicts`, same-mode revalidation; unique regression: `sanitizes direct, ID, diff-pair, Markdown, and print reads without changing stored bytes` | `F-M6`; **GREEN** — 4 files; 10 passed/176 skipped; 1.25 s; exit 0 | Sanitization is read-time and idempotent; persisted JSON bytes are deliberately not rewritten. |
| M7 | Durable pass artifacts and authoritative resume state; design `M7` | Tasks 19-21; `task-19-report.md`, `task-20-report.md`, `task-21-report.md`; `ab92ef9`, `dd3f336..becf03b`, `8fa8e09..0d04e71` | `persistPassSettlementInTransaction`, `computeJobResumePlan`, queued source-generation rederivation; unique regressions: `persists bull artifact and cost before unresolved bear settles`, `duplicate settlement callback bills exactly once`, and `reconciles real-facade verify recovery from the local ledger before early persistence` | `F-M7`; **GREEN** — 2 files (1 passed/1 skipped); 4 passed/296 skipped; 1.81 s; exit 0 | A process killed after an external provider charges but before usage reaches the app is irreducible without provider reconciliation/idempotency. |
| M8 | Request-wide Host/Fetch-Metadata security and bounded heavy loads; design `M8` | Task 24; `task-24-report.md`; `77df956` | `assertAllowedHost`, `assertHeavyGetMetadata`, `createCompanyLoadCoordinator`; unique regressions: `rejects a forged non-loopback Host even when Origin and Fetch Metadata are absent` and `singleflights concurrent normalized requests for one symbol` | `F-M8`; **GREEN** — 3 files; 21 passed/111 skipped; 1.55 s; exit 0 | Default trust is loopback only; one exact configured LAN authority is operationally allowed. |
| M9 | Durable global scheduler, paid leases, and spend backpressure; design `M9` | Tasks 19 and 22; `task-19-report.md`, `task-22-report.md`; `ab92ef9`, `fbbd532` | `claimNextQueuedJob`, `acquirePaidPassLease`, `authorizePaidPassLaunch`, `settlePaidPassLease`; unique regressions: `serializes simultaneous per-job spend admissions with exactly one reservation and no lock leak` and `cancel-first/settle-second preserves reservation until immutable settlement and cannot mutate current projections` | `F-M9`; **GREEN** — 2 files; 7 passed/261 skipped; 3.49 s; exit 0 | SQLite authority is cross-connection/process; unseen external provider charges remain the same M7 boundary. |
| M10 | Complete versioned history transitions; design `M10` | Task 26; `task-26-report.md`; `87e9462` | `diffReports` union/collision/compatibility model and route-used `DiffBody`; unique regressions: `reports score blocks added and removed and score null values became available or unavailable` and `compares every point on every projection path including years two and four` | `F-M10`; **GREEN** — 2 files; 6 passed/184 skipped; 1.22 s; exit 0 | Duplicate/incompatible identities are localized as not comparable; unambiguous siblings remain available. |
| M11 | Shared report-surface manifests and complete audit trails; design `M11` | Tasks 27-28; `task-27-report.md`, `task-28-report.md`; `b39456e`, `8b2428c` | `surfaceManifest.ts` descriptors/helpers consumed by render/export/diff/Stage C; unique regressions: `routes every audited consumer through the client/server-safe surface manifest` and `renders every Task 28 audit family through latest, saved, and print pages without mutation` | `F-M11`; **GREEN** — 4 files (3 passed/1 skipped); 3 passed/266 skipped; 2.49 s; exit 0 | Legacy optional fields are omitted, never fabricated; present duplicates/conflicts remain visible or fail closed. |
| M12 | Enforceable CI, coverage, release, dependency/audit, and deterministic DB pools; design `M12` | Task 31; `task-31-report.md`; `aece43b` | shared Vitest constants/configs, tracked release oracle, risk manifest, dependency/security wrappers, isolated DB CLI; unique regressions: `partitions every tracked test through the real static Vitest CLI`, `causally enforces each file even when aggregate coverage passes`, and `bootstraps a Unicode/spaced SQLite path without provider credentials and cleans up` | `F-M12`; **GREEN** — focused: 4 files/30 passed, 3.76 s; integration: 1 file/4 passed, 2.51 s; both exit 0 | Local workflow/verify evidence is not an observed remote CI run. Branch protection requiring `CI / full` is documented but not yet externally observed. |
| M13 | Last-intent, versioned settings persistence; design `M13` | Task 29; `task-29-report.md`; `efb58aa` | `createSettingsWriteQueue`, settings route `BEGIN IMMEDIATE` revision/ETag CAS, runner snapshot capture; unique regressions: `serializes A then latest C, coalesces B, chains the acknowledged ETag, and never renders old A` and `captures one coherent model/effort revision before asynchronous model resolution` | `F-M13`; **GREEN** — 4 files (3 passed/1 skipped); 3 passed/275 skipped; 1.85 s; exit 0 | Existing arbitrary legacy model text stays visible for repair; new unadvertised models remain rejected. |
| L1 | Context-safe Markdown export; design `L1` | Task 30; `task-30-report.md`; `20a62ce` | explicit `markdownProse`/heading/list/table/blockquote/code/source serializers and all sinks; unique regressions: `neutralizes active HTML, links, images, autolinks, and injected block grammar while keeping text visible` and `matches direct poison rendering byte-for-byte without mutating stored report JSON` | `F-L1`; **GREEN** — 2 files; 4 passed/53 skipped; 1.28 s; exit 0 | Serializers are deterministic raw-input boundaries, deliberately not idempotent double-escapers. |
| L2 | Patched dependency graph; design `L2` | Tasks 1 and 31; `task-1-report.md`, `task-31-report.md`; `d1e3726`, `aece43b` | exact lock and installed-tree dependency-shape collectors plus fail-closed dev audit wrapper; unique regressions: `validates the installed tree and catches missing, wrong, and nested extra versions` and `preserves advisory failures and fails closed on registry/spawn outages` | `F-L2`; **GREEN** — 2 files/12 passed; 1.93 s; exit 0 | npm registry access for `npm ci`/audit is an explicit tooling boundary, separate from provider/model credentials. |
| L3 | Revisioned, race-free SSE handshake and cleanup; design `L3` | Tasks 19 and 23; `task-19-report.md`, `task-23-report.md`; `ab92ef9`, `1040891` | `mutateJobSnapshotInTransaction`, coherent `getJobSnapshot`, snapshot-only SSE; unique regressions: `subscribes before its authoritative read and never emits a stale handshake snapshot`, `reads job revision and ledger cost from one coherent SQLite snapshot`, and `request abort invokes unsubscribe and clears each timer once` | `F-L3`; **GREEN** — 3 files; 8 passed/31 skipped; 6.15 s; exit 0 | Local hints are invalidations only; polling supplies cross-process truth. Terminal streams remain open while durable settlements are pending. |
| A1 | Historical EV must be on or before the TTM anchor; Task 17 M2-adjacent risk | Task 17; `task-17-report.md`; `de65c43` | `latestOnOrBeforeWithin` wired to own-history multiples; unique regression: `uses the latest enterprise value on or before each TTM end instead of a closer future row` | `F-A1`; **GREEN** — 2 files; 4 passed/109 skipped; 0.358 s; exit 0 | Eligible prior rows must be within the documented inclusive 45-day tolerance; no future row is allowed. |
| A2 | Missing technical volume remains null and preserves price rows; inferred adjacent risk from design `H5`/Task 14 | Task 14; `task-14-report.md`; `24bd92d` | provider adapter, `sanitizeRows`, `volumeTrend`, `toVolumeHistogramData`; unique regression: `missing volume preserves symbol and benchmark price history while disclosing the unavailable volume trend` | `F-A2`; **GREEN** — 3 files; 10 passed/150 skipped; 0.611 s; exit 0 | Original external-audit wording is unavailable. Literal observed zero remains valid and distinct from missing. |
| A3 | Null WACC weights render `n/a` at the real company callsite; inferred adjacent risk from design `H5`/Task 14 | Task 14 plus Task 32 prerequisite; `task-14-report.md`; `24bd92d`; `d58d090` | `fmtFractionPct` at the company-page WACC equity/debt weight callsites; historical generic regression `renders missing and non-finite fractions as n/a before scaling`; committed real-callsite regression `audit A3 preserves null WACC weights through computeWacc and renders n/a at the live company-page callsite` proves `computeWacc` returns two null weights and the live panel renders `n/a / n/a`, never `0.0% / 0.0%`. Pre-commit focused/full-file/type/lint and targeted mutation evidence was reported GREEN. | `F-A3`; **GREEN** — 1 file; 1 passed/5 skipped; 1.49 s; exit 0 | Original external-audit wording is unavailable. Generic formatter coverage alone is explicitly insufficient; the real-callsite regression remains distinct from A4. |
| A4 | Null DuPont net margin renders `n/a` at the real company callsite; inferred adjacent risk from design `H5`/Task 14 | Task 14 plus Task 32 prerequisite; `task-14-report.md`; `24bd92d`; `d58d090` | `fmtFractionPct` at the company-page DuPont margin callsite; historical generic regression `renders missing and non-finite fractions as n/a before scaling`; committed real-callsite regression `audit A4 preserves a null DuPont margin through computeDupont and renders n/a at the live company-page callsite` proves a null input margin remains null while finite turnover/leverage survive and the live panel renders `n/a`, never `0.0%`. Pre-commit focused/full-file/type/lint and targeted mutation evidence was reported GREEN. | `F-A4`; **GREEN** — 1 file; 1 passed/5 skipped; 1.49 s; exit 0 | Original external-audit wording is unavailable. This row does not reuse A3's assertion. |

## Focused command ledger

Every command below ran with CI mode, live EDGAR smoke disabled, and
provider/model credentials absent. Each `npx vitest` command had
`--reporter=dot` appended; the integration script ran as written. Registry
access was not needed for these focused commands. All 26 independently filtered
rows exited 0; exact counts and durations are recorded in the matrix above.

- `F-H1`: `npx vitest run tests/fmp.client.test.ts tests/edgar.client.test.ts tests/finra.fred.test.ts -t "wrong-symbol object before|different padded CIK|mixed symbols before deduplication"`
- `F-H2`: `npx vitest run tests/stageC.payload.passes.test.ts tests/report.history.export.test.ts tests/report.export.printHtml.test.ts -t "source envelopes|ADR statement row's reported currency|timeless computed"`
- `F-H3`: `npx vitest run tests/stageB.instrumentSupport.test.ts tests/jobRunner.test.ts tests/company.page.unsupported.test.ts -t "rejects an ETF before company computation|terminalizes an unsupported ETF before paid work|renders the company-only explanation"`
- `F-H4`: `npx vitest run tests/stageB.ttm.compute.test.ts tests/stageB.valuation.test.ts -t "sales-to-capital uses the newest complete whole balance point|selected annual balance date and frequency"`
- `F-H5`: `npx vitest run tests/stageB.financialValues.test.ts tests/stageB.sectorRouting.test.ts tests/stageB.projections.test.ts -t "both inputs and their sum are finite|missing capex suppresses burn|share-count trend is missing"`
- `F-H6`: `npx vitest run tests/company.report.presentation.test.ts -t "delegates both persisted routes to one exact report-only boundary"`
- `F-M1`: `npx vitest run tests/stageB.sectorRouting.test.ts tests/stageB.ttm.compute.test.ts -t "non-USD currency|selected non-USD TTM|reported currency"`
- `F-M2`: `npx vitest run tests/stageB.quarterWindows.test.ts tests/stageB.ttm.compute.test.ts tests/stageB.valuation.test.ts -t "five valid windows and three deterministic rejections|missing middle quarter|scans beyond invalid early anchors"`
- `F-M3`: `npx vitest run tests/stageB.technicals.test.ts tests/stageB.grading.test.ts -t "same exact start/end observations|exact common start|relative strength driver isolation"`
- `F-M4`: `npx vitest run tests/edgar.xbrl.test.ts tests/stageA.validate.test.ts -t "USD and EUR components|exact period start or end mismatches|mixed-unit bank sum"`
- `F-M5`: `npx vitest run tests/edgar.client.test.ts tests/db.cache.test.ts tests/dataBundle.edgarForms.test.ts tests/report.completeness.test.ts -t "unknown loose parallel array|pre-upgrade.*poisoned durable|Unicode-stable raw-text|malformed selected filing|confirmed 6-K"`
- `F-M6`: `npx vitest run tests/report.legacyEntitySafety.test.ts tests/report.history.export.test.ts tests/report.query.test.ts tests/api.routes.export.test.ts -t "legacy entity|immutable|uncovered"`
- `F-M7`: `npx vitest run tests/jobRunner.test.ts tests/stageC.payload.passes.test.ts -t "persists bull artifact|duplicate settlement callback|schema-valid judge artifact|real-facade verify recovery"`
- `F-M8`: `npx vitest run tests/api.routes.sameOrigin.test.ts tests/companyLoad.test.ts tests/company.page.unsupported.test.ts -t "forged non-loopback Host|cross-site|singleflights concurrent|bounds different-symbol"`
- `F-M9`: `npx vitest run tests/jobScheduler.test.ts tests/jobRunner.test.ts -t "simultaneous per-job spend admissions|simultaneous rolling-budget|cancel-first/settle-second|provider boundary"`
- `F-M10`: `npx vitest run tests/report.history.export.test.ts tests/report.schema.test.ts -t "added and removed|became available|every point on every projection path|cross-entity"`
- `F-M11`: `npx vitest run tests/report.format.shared.test.ts tests/report.history.export.test.ts tests/company.report.presentation.test.ts tests/stageC.payload.passes.test.ts -t "audited consumer.*surface manifest|Task 28 audit family|canonical manifest orders"`
- `F-M12`: `npx vitest run tests/repository.release.test.ts tests/risk.coverage.test.ts tests/dependencyShape.test.ts tests/securityAudit.test.ts` and `npm run test:integration`
- `F-M13`: `npx vitest run tests/settings.writeQueue.test.ts tests/api.routes.settings.test.ts tests/settings.page.test.ts tests/jobRunner.test.ts -t "serializes A then latest C|atomically writes the full pair|coherent model/effort revision"`
- `F-L1`: `npx vitest run tests/report.markdownEscape.test.ts tests/report.markdown.integration.test.ts -t "neutralizes raw HTML|neutralizes active HTML|stored report JSON|legacy poisoned report"`
- `F-L2`: `npx vitest run tests/dependencyShape.test.ts tests/securityAudit.test.ts`
- `F-L3`: `npx vitest run tests/jobState.test.ts tests/api.routes.stream.test.ts tests/company.generateReport.stream.test.ts -t "exactly one increment|coherent SQLite snapshot|subscribes before|cleanup|pending canceled terminal"`
- `F-A1`: `npx vitest run tests/stageB.asOfSelection.test.ts tests/stageB.valuation.test.ts -t "on or before|future EV|zero-day tolerance"`
- `F-A2`: `npx vitest run tests/stageB.technicals.test.ts tests/charts.map.test.ts tests/stageB.ttm.compute.test.ts -t "missing volume|volume histogram|provider volume"`
- `F-A3`: `npx vitest run tests/company.report.presentation.test.ts -t "audit A3 preserves null WACC weights through computeWacc and renders n/a at the live company-page callsite"`
- `F-A4`: `npx vitest run tests/company.report.presentation.test.ts -t "audit A4 preserves a null DuPont margin through computeDupont and renders n/a at the live company-page callsite"`

## Cross-task acceptance inventory

| Seam | Owning tasks and root symbols | Causal evidence to run | State / residual |
| --- | --- | --- | --- |
| Scheduler settlement -> revision -> SSE atomicity | Tasks 22-23; `settlePaidPassLease`, `mutateJobSnapshotInTransaction`, `getJobSnapshot`, stream `GET` | `S1`; exact settlement/revision/coherent-snapshot/pending-settlement filters | **GREEN** — S1a 1 passed/180 skipped, 1.86 s; S1b 2 passed/14 skipped, 6.28 s; both exit 0. |
| Proxy/RSC/SSE compatibility | Tasks 23-24 and Task 32 closure `3b76336`; `proxy`, `assertHeavyGetMetadata`, SSE snapshot route | `S2`; exact RSC/prefetch admission, EventSource-shaped report-stream proxy admission/Host rejection, and SSE baseline/replay/cleanup filters | **GREEN** — S2a 3 passed/89 skipped, 1.69 s; S2b 3 passed/13 skipped, 1.56 s; both exit 0. The local Host-only proxy path is now directly causal; remote deployment behavior is not inferred. |
| Coordinated live loads vs provider-free saved reports | Tasks 24-25; `createCompanyLoadCoordinator`, `PersistedReportView`; seam closure `1d8c8e6` | `S3`; exact live singleflight and saved report-only boundary filters; the saved assertion now proves the live body makes one bundle/Stage B call and `SavedReportPage` adds none | **GREEN** — S3a 1 passed/15 skipped, 1.42 s; S3b 1 passed/5 skipped, 1.47 s; both exit 0. |
| Central row/meta entity guard shared by persisted and diff paths | Tasks 9 and 26; `parseStoredReportWithSafety`, history scoped identity checks, `diffReports` | `S4`; exact row/meta mismatch, immutable multi-sink sanitation, and cross-entity diff filters | **GREEN** — 3 passed/124 skipped, 1.54 s, exit 0. |
| Task 26-28 shared key unions | Tasks 26-28; `surfaceManifest.ts`, `diffReports`, report renderers | `S5`; exact shared-consumer, detail-render, score/weight/driver/projection-union filters | **GREEN** — S5a 1 passed/16 skipped, 1.15 s; S5b 2 passed/9 skipped, 1.00 s; S5c 4 passed/123 skipped, 1.22 s; all exit 0. |
| Task 28 fields through Task 30 serializers | Tasks 28 and 30; audit descriptors plus context serializers | `S6`; exact Task 28 Markdown serialization and all-surface nonmutation filters | **GREEN** — S6a 1 passed/19 skipped, 1.20 s; S6b 1 passed/5 skipped, 1.83 s; both exit 0. |
| Coherent settings revision captured by Task 22 job | Tasks 22 and 29; runner settings snapshot before async model resolution | `S7`; exact coherent model/effort capture filter under the scheduler-compatible runner path | **GREEN** — 1 passed/180 skipped, 1.80 s, exit 0. |
| Task 9 sanitation/byte preservation across later views | Tasks 9, 26, 28, 30; central safe read and later consumers | `S8`; exact latest/diff/export/Markdown sanitation and byte-preservation filters | **GREEN** — S8a 1 passed/9 skipped, 0.860 s; S8b 1 passed/126 skipped, 1.33 s; S8c 1 passed/42 skipped, 1.07 s; S8d 1 passed/19 skipped, 1.18 s; all exit 0. |
| Unsupported instruments acquire no leases | Tasks 10 and 22; instrument gate before scheduler paid permit; seam closure `1d8c8e6` | `S9`; `terminalizes an unsupported ETF before paid work with zero durable leases, artifacts, costs, reports, or provider/model/pass calls` | **GREEN** — fresh S9 1 passed/180 skipped, 1.81 s, exit 0 (closure-focused run 1.90 s); the regression directly queries both durable lease/artifact tables and all paid/provider/model/pass boundaries. |
| Source identity/currency/as-of through diff/render | Tasks 4-5, 26-28; source manifest, registry identity, diff/render descriptors | `S10`; exact source-envelope, ADR currency/as-of, diff provenance, and audit-render filters | **GREEN** — 2 files; 4 passed/242 skipped, 1.80 s, exit 0. |
| Task 20/21 recovery under Task 22/23 authority | Tasks 20-23; artifacts/resume plan, scheduler lineage, canonical revision writes | `S11`; exact process-cache loss, late settlement, ledger reconciliation, and wire-visible revision filters | **GREEN** — 4 passed/177 skipped, 1.89 s, exit 0. |
| Task 31 risk coverage includes every new source | Task 31; literal `RISK_SOURCE_MANIFEST` two-way equality | `S12`; exact two-way manifest filter plus real risk coverage | **GREEN** — manifest 1 passed/3 skipped, 0.383 s, exit 0; full risk gate GREEN with every per-file floor. Task 32 added no production source. |
| Task 4 producer registry parity | Task 4 source-manifest producer and Task 27/28 consumers; Task 32 prerequisite `d58d090` | `S13`; exact returned producer/source-or-gap parity, macro-order, and return-shaped registry filters | **GREEN** — 3/3 passed, 0.583 s, exit 0. `collectFetchResultRegistry(bundleCore)` recursively discovers the actual returned producer shape; the one registry drives both exact successful-source parity and failed-gap parity, while non-macro-before-macro ordering preserves historical manifest order. |
| Corrected CLI remains safe and covered | Tasks 9 and 31; `parseStoredReportWithSafety`, refactored callable CLI | `S14`; exact import/parse/success/failure/immutability/executable matrix; risk gate includes the CLI | **GREEN** — 5/5 passed, 1.68 s, exit 0; full risk gate also GREEN. |
| Local workflow vs observed remote enforcement | Task 31 workflow/release tests and README | `S15`; exact local workflow parity and branch-protection documentation filters | Local evidence **GREEN** — 2 passed/12 skipped, 0.257 s, exit 0; remote CI/protection **NOT OBSERVED**. |

## Cross-task seam command ledger

The coordinator/runner executed every command below with its exact unique title
filter and `--reporter=dot`. Results are recorded in the corresponding
cross-task inventory rows above.

### S1 — Scheduler settlement, revision, and SSE atomicity

```powershell
npx vitest run tests/jobRunner.test.ts -t "commits paid cost and its terminal step in one wire-visible revision" --reporter=dot
npx vitest run tests/api.routes.stream.test.ts -t "reads job revision and ledger cost from one coherent SQLite snapshot|keeps a canceled stream open until a retained paid settlement reaches the client" --reporter=dot
```

### S2 — Proxy/RSC/SSE compatibility

```powershell
npx vitest run tests/api.routes.sameOrigin.test.ts -t "allows same-origin RSC/prefetch metadata|allows top-level and same-origin heavy loads, including RSC prefetch|keeps an EventSource-shaped report stream on the Host-only proxy path" --reporter=dot
npx vitest run tests/api.routes.stream.test.ts -t "always emits a revision-zero baseline with an SSE id even when Last-Event-ID is newer|retains lenient legacy data-only report parsing used by snapshot replay|request abort invokes unsubscribe and clears each timer once" --reporter=dot
```

Commit `3b76336` sends an EventSource-shaped `/api/report/job-sse/stream` request
through the real `proxy`: a valid Host-only request reaches middleware-next,
while the same request with a forged Host receives 403. Temporarily broadening
the heavy-route policy to include `/stream` made that assertion RED (403 instead
of 200); the exact inverse restored GREEN. Remote deployment behavior remains
outside local evidence.

### S3 — Coordinated live loads vs provider-free saved reports

```powershell
npx vitest run tests/company.page.unsupported.test.ts -t "coalesces the entire concurrent company load for one normalized symbol" --reporter=dot
npx vitest run tests/company.report.presentation.test.ts -t "delegates both persisted routes to one exact report-only boundary" --reporter=dot
```

Commit `1d8c8e6` strengthened the same uniquely named boundary assertion: the
live company body must make exactly one bundle/Stage B call and rendering
`SavedReportPage` must not increment either provider-side counter. Focused
closure result: 1 passed/5 skipped, 1.49 s, exit 0; fresh S3b result:
1 passed/5 skipped, 1.47 s, exit 0.

### S4 — Central entity guard across persisted and diff paths

```powershell
npx vitest run tests/report.history.export.test.ts -t "rejects a row-to-embedded symbol mismatch without mutating persisted bytes|sanitizes direct, ID, diff-pair, Markdown, and print reads without changing stored bytes|returns not comparable and no deltas for direct cross-entity reports while accepting dot-hyphen aliases" --reporter=dot
```

### S5 — Task 26-28 shared key unions

```powershell
npx vitest run tests/report.format.shared.test.ts -t "routes every audited consumer through the client/server-safe surface manifest" --reporter=dot
npx vitest run tests/report.surface.detail.test.ts -t "renders composite methodology, all aspect fields, independent weights, and every raw driver trace|renders all 4 metrics x 5 paths as raw provenance rows plus every root and series field" --reporter=dot
npx vitest run tests/report.history.export.test.ts -t "keeps unique composite and aspect score endpoints including composite availability|reports unique sentinels for every weight across all transition kinds|reports every aspect driver by tuple identity, provenance, and all transition kinds|compares every point on every projection path including years two and four" --reporter=dot
```

### S6 — Task 28 fields through Task 30 serializers

```powershell
npx vitest run tests/report.markdown.integration.test.ts -t "serializes Task 28 table leaves and a dual-context completeness reason exactly once" --reporter=dot
npx vitest run tests/company.report.presentation.test.ts -t "renders every Task 28 audit family through latest, saved, and print pages without mutation" --reporter=dot
```

### S7 — Coherent settings revision captured by the job

```powershell
npx vitest run tests/jobRunner.test.ts -t "captures one coherent model/effort revision before asynchronous model resolution" --reporter=dot
```

### S8 — Sanitation and byte preservation across later views

```powershell
npx vitest run tests/report.query.test.ts -t "latest query applies legacy entity safety without mutating reportJson" --reporter=dot
npx vitest run tests/report.history.export.test.ts -t "sanitizes direct, ID, diff-pair, Markdown, and print reads without changing stored bytes" --reporter=dot
npx vitest run tests/api.routes.export.test.ts -t "renders Task 28 score, evidence, projection, and provenance sentinels through both persisted export routes" --reporter=dot
npx vitest run tests/report.markdown.integration.test.ts -t "matches direct poison rendering byte-for-byte without mutating stored report JSON" --reporter=dot
```

### S9 — Unsupported instruments acquire no leases

```powershell
npx vitest run tests/jobRunner.test.ts -t "terminalizes an unsupported ETF before paid work with zero durable leases, artifacts, costs, reports, or provider/model/pass calls" --reporter=dot
```

Commit `1d8c8e6` closes the former gap: the renamed assertion directly proves
zero `job_llm_leases`, `job_pass_artifacts`, reports, cost rows, preflight/model,
provider, and pass calls. Focused closure result: 1 passed/180 skipped, 1.90 s,
exit 0; fresh S9 result: 1 passed/180 skipped, 1.81 s, exit 0.

### S10 — Source identity, currency, and as-of through diff/render

```powershell
npx vitest run tests/stageC.payload.passes.test.ts tests/report.history.export.test.ts -t "preserves real source envelopes and deduplicates only identical tuples|preserves an ADR statement row's reported currency and verifies only the matching identity|reports every aspect driver by tuple identity, provenance, and all transition kinds|renders source envelopes in Markdown and React appendices" --reporter=dot
```

### S11 — Task 20/21 recovery under Task 22/23 authority

```powershell
npx vitest run tests/jobRunner.test.ts -t "queued resume re-derives a source synthesize artifact after process-cache loss|queued resume includes a late source analyst settlement before worker dispatch|reconciles real-facade verify recovery from the local ledger before early persistence|commits paid cost and its terminal step in one wire-visible revision" --reporter=dot
```

### S12 — Task 31 risk coverage includes every new source

```powershell
npx vitest run tests/risk.coverage.test.ts -t "uses the exact literal audited source manifest in both directions" --reporter=dot
npm run test:coverage:risk
```

### S13 — Task 4 producer registry parity and order

```powershell
npx vitest run tests/dataBundle.producerRegistry.test.ts -t "keeps every returned FetchResult producer in exactly one source-or-gap registry|preserves source-manifest insertion order across macro producers|derives source and gap views from the actual return-shaped bundle core" --reporter=dot
```

### S14 — Corrected CLI remains safe and covered

```powershell
npx vitest run tests/report.correctedCli.test.ts -t "is import-safe and exposes callable parsing/export entry points|parses absolute and relative arguments strictly|writes exact HTML, newline-terminated JSON, and machine-readable summary|closes the database and cleans safely after missing-report, schema, and write failures|keeps the package export:corrected entry point executable" --reporter=dot
```

### S15 — Local workflow vs remote enforcement

```powershell
npx vitest run tests/repository.release.test.ts -t "keeps the workflow in exact verify parity across supported lanes|documents supported CI, Node 20 residual compatibility, and branch protection" --reporter=dot
```

This proves only local workflow/documentation state. Remote CI and the required
`CI / full` branch-protection rule remain **NOT OBSERVED**.

## Review and rereview correction inventory

Each entry below names the follow-up commit and a unique regression that must be
selected in the Task 32 fresh evidence. Entries grouped under one commit are
distinct corrections, not one borrowed assertion.

`CP` below is the fresh canonical product phase of `npm run verify`: 95 files,
2,731 passed/1 skipped, 21.72 s, exit 0. A `CP` citation always repeats the
retained unique correction test(s) it executed; filtered `F-*`, seam `S*`, and
mutation `MU*` evidence is cited in addition where available.

| Task / correction | Follow-up commit | Unique regression | Fresh state |
| --- | --- | --- | --- |
| Task 2: wrong-symbol FMP object bodies bypassed array-only identity scanning | `f179bf3` | `rejects a wrong-symbol object before cachedFetch can store it` | **GREEN** — `F-H1` selected the named regression; `MU1` independently made it RED then restored it GREEN; CP retained it. |
| Task 4: future producer enumeration can drift from source-manifest projection | `d58d090` | exact returned-producer/source-or-gap parity, macro insertion-order, and single return-shaped registry regressions in `dataBundle.producerRegistry.test.ts` | Prerequisite proof **COMMITTED**; fresh S13 3/3 GREEN in 0.583 s, exit 0. |
| Task 5: strict provider date gate removed timeless computed provenance | `e679d99` | `retains timeless computed figures with deterministic computation snapshot identity` | **GREEN** — `F-H2` selected the named timeless-computed regression (4 passed/267 skipped across its files); CP retained it. |
| Task 7: fixed parallel-field list and literal accession-owner rule were incomplete | `685285c` | `submissions rejects an unknown loose parallel array such as fileNumber when its length differs`; agent-filed accession compatibility control | **GREEN** — `F-M5` selected the unknown-parallel-array regression; CP executed that test and the retained accession compatibility control. |
| Task 8 R1: pre-upgrade durable poison, weak body plausibility, and unsafe SEC host acceptance | `05127a4` | `never returns a pre-upgrade ... poisoned durable filing and self-heals`; `non-HTTPS or non-SEC`; arbitrary-markup classifier test | **GREEN** — `F-M5` selected the pre-upgrade durable-poison regression; CP executed it plus the retained non-HTTPS/non-SEC and arbitrary-markup tests. |
| Task 8 R2: maintenance shell and namespace-prefix assumptions | `449b02d` | bound-XBRL namespace and official scheduled-maintenance tests | **GREEN** — broad Group 1 and CP executed the retained bound-XBRL namespace and official scheduled-maintenance regressions. |
| Task 8 R3: regex namespace tokenizer bypasses | `89ec854` | namespace-tokenizer, NBSP/reserved namespace/DOCTYPE/Unicode-prefix tests | **GREEN** — broad Group 1 and CP executed the retained tokenizer, NBSP/reserved-namespace, DOCTYPE, and Unicode-prefix regressions. |
| Task 8 R4: hidden regions/attributes could drive admission or index parsing | `3e74a99` | `sanitized index admission does not cache a hidden-only fake index` and safe-href side-channel test | **GREEN** — broad Group 1 and CP executed the named hidden-only index-admission and safe-href side-channel regressions. |
| Task 8 R5: transformed-string offsets broke U+0130 raw-text handling | `8df5500` | two `%s`-parameterized Unicode-stable U+0130 raw-text-offset templates, each instantiated for `script`, `style`, `title`, and `textarea` (eight tests total) | **GREEN** — `F-M5` selected all eight U+0130 raw-offset instantiations; CP retained them. |
| Task 10: TypeScript resume union was not a runtime allowlist | `3fe5662` | `rejects runtime unsupported resume claims without mutating terminal metadata` | **GREEN** — CP executed the named runtime-resume allowlist regression; `F-H3` and `S9` separately proved unsupported pre-paid boundaries. |
| Task 12 R1: signed subnormal mean, invalid Gregorian dates, inaccurate overflow disclosure | `e4045e0` | negative-subnormal `computeRunway`, impossible-date, and component-overflow reason tests | **GREEN** — broad Group 3 and CP executed the retained negative-subnormal, impossible-date, and component-overflow reason regressions. |
| Task 12 R2: mixed-scale residual loss and invalid balance-date provenance | `4719263` | normalized-residual order cases and invalid balance-date `liquidAssetsAsOf` test | **GREEN** — broad Group 3 and CP executed the retained normalized-residual order cases and invalid `liquidAssetsAsOf` regression. |
| Task 15: direct runtime malformed revenue bypass/throw | `5062fe6` | invalid-revenue matrix including Symbol plus finite-zero compatibility | **GREEN** — broad Group 3 and CP executed the retained Symbol-inclusive invalid-revenue matrix and finite-zero compatibility control; `F-M1` separately proved currency gating. |
| Task 16: per-multiple caps/fallback depth, malformed old rows, absent EV disclosure | `d82619b` | `continues per multiple...`; `chooses raw or vendor history per multiple`; `scans beyond...`; `enterprise-value history is...`; `partial metric while another...` | **GREEN** — `F-M2` selected the retained scan-beyond-invalid regression; broad Group 3 and CP executed all five named per-multiple/source/history/disclosure regressions. |
| Task 18: Gregorian-underflow cutoff and symmetric endpoint freshness | `7d8fd13` | `fails closed when a relative strength cutoff would cross before Gregorian year 1` plus symbol/benchmark 7/8-day cases | **GREEN** — broad Group 3 and CP executed the Gregorian-underflow and both endpoint-freshness regressions; `MU7` causally proved the 7/8-day boundary RED/GREEN. |
| Task 20 R1: unlaunched steps, fabricated failure artifacts, duplicate judge replay mutation | `9fe691f` | unlaunched-bear skipped-state, markerless predispatch no-artifact, and duplicate old-judge no-op tests | **GREEN** — broad Group 4 and CP executed the retained unlaunched-bear, markerless-predispatch, and duplicate-old-judge regressions. |
| Task 20 R2: attempted-provider provenance fabricated launches | `becf03b` | pre-dispatch report attempted-source empty vs launched-unbilled compatibility | **GREEN** — broad Group 4 and CP executed the retained pre-dispatch-empty and launched-unbilled attempted-source compatibility cases. |
| Task 21 precommit: provenance, digest/report races, client request fence, verify/synthesize ordering | `8fa8e09` | current analyst provenance; unrecoverable digest race; report appears after preparation; job-A authority; durable verify/synthesize-without-prerequisites tests | **GREEN** — broad Group 4 and CP executed each retained analyst-provenance, digest/report-race, request-fence, and durable prerequisite-order regression; `S11` independently selected recovery/race seams. |
| Task 21 postcommit: recovered verify accounting/config/ledger execution mismatch | `0d04e71` | `reconciles real-facade verify recovery from the local ledger before early persistence` and repeated prior-generation ledger test | **GREEN** — `F-M7` and `S11` selected the named real-facade ledger reconciliation; broad Group 4 and CP also executed the repeated prior-generation ledger regression. |
| Task 22: final split-transaction POST admission race and earlier scheduler findings | `fbbd532` | atomic expired/live same-symbol POST/retry admission tests plus named scheduler race matrix | **GREEN** — broad Group 4 and CP executed the retained atomic same-symbol POST/retry admission and scheduler race matrix; `F-M9` and `S1` independently selected paid-admission/settlement boundaries. |
| Task 23: fabricated live `settlementsPending:true` frame accepted | `1040891` | complete snapshot-shape decoder test rejecting malformed high revision | **GREEN** — broad Group 4 and CP executed the named malformed-high-revision snapshot decoder; `S1`/`S2` covered wire semantics and `MU9` causally proved handshake ordering. |
| Task 24: Unicode ingress, bounded admission, double-decode, EDGAR ticker shadowing | `77df956` | invalid-Unicode route/provider/watchlist matrix; `fails fast at maxQueued zero`; installed Next decode test; EDGAR invalid-map tests | **GREEN** — broad Group 4 and CP executed the retained invalid-Unicode, zero-queue, installed-Next decode, and EDGAR-map regressions; `F-M8` selected Host/metadata/singleflight boundaries. |
| Task 25: stale wording/link title implied live chart injection | `e3ba3b` | shared report-only boundary and saved-route title/presentation test | **GREEN** — `F-H6` selected the shared report-only boundary; `S3` selected it again with causal zero-provider counts; CP retained the saved-route title/presentation regression. |
| Task 26: localized reasons, one-sided duplicates, period/unit/entity/legacy-read compatibility | `87e9462` | localized duplicate target/driver tests, period/unit not-comparable tests, canonical-history and 4/4 legacy export/view regressions | **GREEN** — `F-M10`, `S4`, and `S5` selected diff/entity/union boundaries; broad Group 5 and CP executed the retained localized-duplicate, period/unit, canonical-history, and four legacy-view regressions. |
| Task 27: legacy/current column drift, grade acceptance, projection bridge/Stage C ambiguity | `b39456e` | seven-grade history order, historical/forward bridge, duplicate projection conflict, and Stage C endpoint-period tests | **GREEN** — `F-M11` and `S5` selected shared-manifest/union evidence; broad Groups 2/5 and CP executed the retained grade-order, projection-bridge/conflict, and Stage C endpoint-period regressions. |
| Task 28: empty projections, exact decimals, completeness truth, real-client descriptors, Markdown boundary, React keys | `8b2428c` | empty-series audit root, raw completeness decimals, client decoder descriptor, multiline blockquote, and duplicate-key regressions | **GREEN** — `F-M11`, `S5`, `S6`, and `S8` selected all-surface/serializer evidence; broad Group 5 and CP executed the retained empty-series, exact-decimal, decoder, blockquote, and duplicate-key regressions. |
| Task 29: obs-text ETags, strict response decode, SSR attribute order, terminal load-error truth | `efb58aa` | corresponding settings API/queue/page named regressions | **GREEN** — `F-M13` and `S7` selected queue/revision capture; broad Group 5 and CP executed the retained obs-text ETag, strict decode, SSR-order, and terminal-error regressions. |
| Task 30: UTF-16 oracle and CommonMark closing-fence/backslash hardening | `20a62ce` | `keeps the structural oracle aligned around astral text and CommonMark code fences` plus code-fence parity cases | **GREEN** — CP executed the named UTF-16/astral structural-oracle and closing-fence parity regressions; `F-L1` selected unsafe grammar boundaries and `MU10` causally proved inline escaping. |
| Task 31: tracked release/CI/config/coverage/dependency/audit/DB/corrected-CLI false-green hardening | `aece43b` | `repository.release`, `risk.coverage`, `dependencyShape`, `securityAudit`, `db.cli`, and `report.correctedCli` causal matrices (each retained separately) | **GREEN** — `F-M12`, `F-L2`, and `S12`-`S15` selected each retained matrix; CP and canonical verify passed dependency, product/integration, core/risk coverage, build, and security audit. |
| Task 32 coverage harness: isolated comparator passed but exceeded the default outer timeout under full V8 coverage contention | `d7cb6ad` | exact comparator assertions unchanged; child process capped at 20 s and only this Vitest case receives a 30 s outer ceiling | Focused comparator 1/1 GREEN in 2.53 s; targeted ESLint and `git diff --check` GREEN; combined core/risk coverage rerun GREEN with all aggregate and per-file floors satisfied. |
| Task 32 seam audit: saved-route zero-provider behavior and unsupported zero durable paid state were implied but not causally asserted | `1d8c8e6` | saved boundary now proves no bundle/Stage B increment; renamed unsupported test queries zero leases, artifacts, costs, reports, and every provider/model/pass/preflight call | Both focused assertions **GREEN** (1.49 s and 1.90 s); TypeScript, targeted ESLint, and `git diff --check` GREEN. |
| Task 32 proxy seam audit: EventSource-shaped report streams had component coverage but no direct trip through the real Host-only proxy path | `3b76336` | `keeps an EventSource-shaped report stream on the Host-only proxy path` admits the valid stream request and rejects its forged-Host twin | S2a **GREEN** — 3 passed/89 skipped in 1.69 s. A temporary heavy-route-policy broadening made the assertion RED (403 instead of 200); its exact inverse restored GREEN. Broad Group 4 and final canonical product verification retained the assertion. |

## Provider-free financial no-regression fixture comparison

Prerequisite status: **committed in `d58d090`; fresh focused and core/risk gate
evidence is GREEN**. Mutation, repository-scope, and protected-hash evidence is
recorded below.

`tests/audit.fixtureComparison.test.ts` and its checked-in reusable helper,
`tests/helpers/auditFixtureComparison.ts`, run the real
`buildDataBundle("DEMO")`, Stage A validation, `runStageB`, and
`assembleReport` path. FMP reads only the 33 committed synthetic JSON fixtures;
the report fixture is parsed to a schema-valid fixed `JudgeOutput`; both clocks
are fixed. Global, FMP, and Finnhub live-fetch counters must remain exactly
zero, while deterministic FINRA, EDGAR, and FRED gap transports must actually
be exercised. The assembled report must retain zero cost and model
`synthetic-fixture`, so this comparison has no provider or model boundary.

The projection contains the complete Stage B result and complete deterministic
assembled report. Only raw provider source envelopes are replaced by an
explicit sentinel because dedicated provenance suites own those payloads. The
bundle-derived symbol, company name, and quote price remain independent fixture
controls. Inputs are snapshotted before the first Stage B and report calls,
those calls must not mutate bundle/computed/judge inputs, and an independent
structured-clone rerun must produce the identical projection. Recursive JSON
domain checks reject non-finite numbers, non-plain objects, decorated/sparse
arrays, symbols, and other non-JSON values before serialization; meaningful
`undefined` members are preserved as an explicit `$auditUndefined` sentinel.

The immutable baseline,
`tests/fixtures/audit-baseline-stageb-report.json`, was emitted by actual
execution in a detached checkout of audited commit
`524d09e81b00b08fe6af386011d34759a5e02fc0`, whose exact tree is
`3210ac4f6e04a81e44ebdfd6989ecf721cb0e2a0`. The detached checkout first ran
`npm ci` against its own package lock and used its own `node_modules`; provider
environment variables were blank, `NODE_OPTIONS=--conditions=react-server`,
and the committed helper was supplied to that checkout's `tsx` CLI through
stdin. No comparison values were reverse-applied. The generator provenance
pins:

- helper SHA-256
  `73e890f2ec86463f5c86cb220e7ee65c8955ba4e0fdcbbc7eea6baff5e035bfe`;
- audited-base package-lock blob
  `66f7242846b6d20cfe99e21400d2dada27bbfbfd` (SHA-256
  `3d5b11eb8976ba9910a7380219456494877329afca4195ee1c3245d5551f260b`)
  and comparison package-lock blob
  `39e4ec59aca9f54e0bc6a65e4b47fd877256fea0` (SHA-256
  `ce4a76f83725daaa7de40138771136873ef35ff39c00c0cf5918b7de6636c57e`);
- generation runtime Node `v24.11.1` and npm `11.6.2`;
- audited entrypoint blobs `ca2efa5a8b191a45eb879142d5ec738777691eaf`
  (`dataBundle.ts`), `835d6dab9b892fbb9905fd3393a7600215e9c3ab`
  (`compute.ts`), `11b36ed190e872c27621c0c79dbd34bb4a9b43da`
  (`stageC/passes.ts`), and `891d66275b154aa2b4f1f1b32961382eaa0e72ad`
  (`report/schema.ts`);
- report-fixture SHA-256
  `e98dbece14978fa5662db016e002ab5b4706b24ac0cf5bbe0408c9f17c969c88`
  and path/NUL-framed FMP-tree SHA-256
  `2d4278a6d73453ea372bf655f299e9b8709b627098214ce5d0d3c2190aa3c7d9`.

The exact compact audited projection is 95,172 bytes with SHA-256
`b41263f84f16bbe7e5961de6c8c2af0a099b8a37897571e37b109ed5f8d4a9a2`;
the generator's newline-terminated emission is 95,173 bytes. A clean detached
base reproduction matched it byte-for-byte after the final tree correction.
The committed pretty-printed baseline document is 153,910 bytes with SHA-256
`9428d633dfd3a64fd57f48264be7a03bad4ebe000ef0ec7e666ce96b3a3a8046`.

Arrays are recursively compared by index. The observed current-vs-audited diff
must equal a literal, bidirectional **31-leaf** allowlist, with the exact audited
and current value pinned for every leaf:

- ten routing/fallback leaves cover the disclosed annual fallbacks for missing
  TTM income, cash flow, and revenue plus their route notes/as-of state;
- two H4/Task 11 leaves add the selected quarterly balance frequency to the
  Stage B and assembled-report DCF sales-to-capital basis;
- sixteen M3/Task 18 leaves replace the inaccurate total-return/no-SPY wording,
  clear the unavailable benchmark as-of and symbol-only returns, and add exact
  null aligned-window endpoints across the Stage B and report gap surfaces;
- three A2/Task 14 leaves pin the finite-safe volume means and ratio, including
  their expected floating-point deltas.

The contract reconstructs the entire current projection from the audited
projection plus those exact delta records and then deep-compares it. Separate
negative controls prove rejection of an unlisted quote drift, a missing intended
delta, and an arbitrary third value at an allowlisted path. The prerequisite
comparison passed repeatedly, including after the final audited-tree correction;
TypeScript, targeted ESLint, `git diff --check`, and exact detached-base
regeneration were also reported GREEN before `d58d090`. Those runs establish
prerequisite provenance only and are not substituted for fresh Task 32 gates.

Prerequisite focused command:
`npx vitest run tests/audit.fixtureComparison.test.ts --reporter=verbose` —
final prerequisite rerun: 1 file, 1 test, exit 0; its pre-commit duration is
not reused as fresh Task 32 gate evidence.

## Execution ledger

Verification ran on Windows in PowerShell with Node `v24.11.1`, npm `11.6.2`,
and `CI=1`. `FMP_API_KEY`, `FINNHUB_API_KEY`, `FRED_API_KEY`, and
`ANTHROPIC_API_KEY` were absent. `EDGAR_LIVE_SMOKE` was not enabled. Thus the
test and verification phases were provider/model-credential-free and made no
opt-in live EDGAR smoke requests.

### Wall-clock timestamp ledger

Unless an entry includes a full timestamp, each time in the next four tables
expands to `2026-08-08T<time>-07:00` (America/Los_Angeles). Durations elsewhere
in this document are Vitest-reported command durations; wrapper endpoints are
identified explicitly.

| Broad command | Start |
| --- | --- |
| Group 1 | `23:06:13` |
| Group 2 | `23:06:26` |
| Group 3 | `23:06:38` |
| Group 4 final-HEAD rerun | `2026-08-08T23:59:55.6796619-07:00`; wrapper end `2026-08-09T00:00:09.8209814-07:00` |
| Group 5 | `23:07:12` |
| Final-HEAD single-worker product lane | `2026-08-09T00:18:40.4813008-07:00`; wrapper end `2026-08-09T00:20:04.5776460-07:00` |

| Finding command | Start | Finding command | Start |
| --- | --- | --- | --- |
| `F-H1` | `23:07:50` | `F-H2` | `23:07:52` |
| `F-H3` final exact-title rerun | `23:45:34` | `F-H4` | `23:07:58` |
| `F-H5` | `23:08:00` | `F-H6` | `23:08:02` |
| `F-M1` | `23:08:31` | `F-M2` | `23:08:33` |
| `F-M3` | `23:08:35` | `F-M4` | `23:08:37` |
| `F-M5` | `23:08:39` | `F-M6` | `23:08:41` |
| `F-M7` | `23:09:11` | `F-M8` | `23:09:14` |
| `F-M9` | `23:09:17` | `F-M10` | `23:09:22` |
| `F-M11` | `23:09:24` | `F-M12a` focused | `23:09:28` |
| `F-M12b` integration | `23:09:33` | `F-M13` | `23:09:37` |
| `F-L1` | `23:10:01` | `F-L2` | `23:10:03` |
| `F-L3` | `23:10:07` | `F-A1` | `23:10:14` |
| `F-A2` | `23:10:16` | `F-A3` | `23:10:18` |
| `F-A4` | `23:10:21` |  |  |

| Seam command | Start | Seam command | Start |
| --- | --- | --- | --- |
| `S1a` | `23:20:53` | `S1b` | `23:20:56` |
| `S2a` final proxy rerun | `23:56:09` | `S2b` final companion rerun | `23:56:12` |
| `S3a` | `23:21:10` | `S3b` | `23:21:13` |
| `S4` | `23:21:16` | `S5a` | `23:21:39` |
| `S5b` | `23:21:41` | `S5c` | `23:21:44` |
| `S6a` | `23:21:46` | `S6b` | `23:21:49` |
| `S7` | `23:21:52` | `S8a` | `23:21:55` |
| `S8b` | `23:21:58` | `S8c` | `23:22:01` |
| `S8d` | `23:22:03` | `S9` | `23:22:06` |
| `S10` | `23:22:30` | `S11` | `23:22:33` |
| `S12a` manifest | `23:22:36` | `S13` | `23:22:38` |
| `S14` | `23:22:40` | `S15` | `23:22:43` |

`S12b` is the real risk-coverage command. It ran again as the risk phase inside
the final canonical wrapper from `2026-08-09T00:00:22.5469043-07:00` through
`2026-08-09T00:03:13.0377815-07:00`; that wrapper captured a phase duration but
did not emit a separate wall-clock start line for the nested command.

| Mutation | RED start | Restored GREEN start |
| --- | --- | --- |
| `MU1` | `23:24:53` | `23:25:12` |
| `MU2` | `23:25:37` | `23:25:52` |
| `MU3` | `23:26:15` | `23:26:25` |
| `MU4` | `23:26:59` | `23:27:15` |
| `MU5` | `23:27:40` | `23:28:01` |
| `MU6` | `23:28:34` | `23:28:46` |
| `MU7` | `23:29:21` | `23:29:35` |
| `MU8` | `23:30:09` | `23:30:22` |
| `MU9` | `23:30:54` | `23:31:16` |
| `MU10` | `23:31:46` | `23:32:00` |

The initial unrelated `MU6` filter started at `23:28:19` and stayed GREEN; it
is recorded for completeness but is not counted as causal mutation evidence.

### Fresh broad focused groups

These are the five literal Task 32 plan Step 2 commands with only
`--reporter=dot` appended. All exited 0:

1. `npx vitest run tests/fmp.client.test.ts tests/edgar.client.test.ts tests/finra.fred.test.ts tests/dataBundle.providerCache.test.ts tests/dataBundle.edgarForms.test.ts tests/edgar.xbrl.test.ts tests/stageA.validate.test.ts --reporter=dot` — 7 files, 358 passed/1 skipped, 5.02 s.
2. `npx vitest run tests/stageC.provenance.test.ts tests/stageC.payload.passes.test.ts tests/report.legacyEntitySafety.test.ts tests/report.completeness.test.ts --reporter=dot` — 4 files/170 passed, 2.31 s.
3. `npx vitest run tests/stageB.instrumentSupport.test.ts tests/stageB.financialValues.test.ts tests/stageB.quarterWindows.test.ts tests/stageB.asOfSelection.test.ts tests/stageB.sectorRouting.test.ts tests/stageB.ttm.compute.test.ts tests/stageB.valuation.test.ts tests/stageB.projections.test.ts tests/stageB.technicals.test.ts tests/stageB.grading.test.ts tests/charts.map.test.ts tests/company.format.test.ts --reporter=dot` — 12 files/466 passed, 0.844 s.
4. `npx vitest run tests/db.jobs.migration.test.ts tests/jobScheduler.test.ts tests/jobRunner.test.ts tests/api.routes.stream.test.ts tests/api.routes.sameOrigin.test.ts tests/companyLoad.test.ts --reporter=dot` — final implementation HEAD, 6 files/409 passed, 12.58 s; wrapper start `2026-08-08T23:59:55.6796619-07:00`, end `2026-08-09T00:00:09.8209814-07:00`, exit 0.
5. `npx vitest run tests/company.report.presentation.test.ts tests/report.history.export.test.ts tests/report.export.printHtml.test.ts tests/report.format.shared.test.ts tests/watchlist.test.ts tests/settings.writeQueue.test.ts tests/api.routes.settings.test.ts tests/api.routes.export.test.ts tests/api.routes.report.test.ts --reporter=dot` — 9 files/354 passed, 11.02 s.

The 26 independently filtered `F-*` commands also all exited 0; their exact
file/test/skip counts and durations are recorded in the requirement matrix.

### Fresh global gates

The final canonical `npm run verify` ran on implementation HEAD
`3b7633655ccf94bb6bdcfba2369a1036da410fe2` from
`2026-08-09T00:00:22.5469043-07:00` through
`2026-08-09T00:03:13.0377815-07:00` (170.4908772 s wrapper elapsed) and exited
0 in exact script order:

- dependency-shape validation, TypeScript, and the full ESLint gate passed;
- product: 95 files, 2,731 passed/1 skipped, 21.72 s;
- integration: 1 file/4 passed, 2.55 s;
- core coverage: 95 files, 2,731 passed/1 skipped, 20.01 s;
  S95.24/B89.73/F99.30/L96.50;
- risk coverage: 95 files, 2,731 passed/1 skipped;
  S92.48/B84.70/F96.20/L94.54, with every per-file floor satisfied;
- Next production build passed; and
- `audit:security` reported 0 vulnerabilities.

The independently required serialized product lane also ran on final
implementation HEAD. Exact command:
`npx vitest run --maxWorkers=1 --reporter=dot`. It ran from
`2026-08-09T00:18:40.4813008-07:00` through
`2026-08-09T00:20:04.5776460-07:00`, passed 95 files with 2,731 passed/1
skipped in 82.58 s, and exited 0. This is distinct from the normally pooled
product phase inside `npm run verify`.

The standalone dependency/toolchain refresh immediately before the later
test-only proxy seam commit also exited 0 at every step. The later canonical
run re-executed each applicable gate on final implementation HEAD:

| Command | Start | End | Result |
| --- | --- | --- | --- |
| `npm ci` | `2026-08-08T23:49:14.1888205-07:00` | `2026-08-08T23:50:08.7985029-07:00` | 497 packages installed; 0 vulnerabilities |
| `npm run check:dependencies` | `2026-08-08T23:50:08.7995034-07:00` | `2026-08-08T23:50:10.7304764-07:00` | PASS |
| `npm run typecheck` | `2026-08-08T23:50:10.7304764-07:00` | `2026-08-08T23:50:15.2533421-07:00` | PASS |
| `npm run lint` | `2026-08-08T23:50:15.2533421-07:00` | `2026-08-08T23:51:09.8338375-07:00` | PASS |
| `npm run build` | `2026-08-08T23:51:09.8338375-07:00` | `2026-08-08T23:51:29.5297276-07:00` | PASS |
| `npm audit --audit-level=low` | `2026-08-08T23:51:29.5307277-07:00` | `2026-08-08T23:51:30.7817208-07:00` | 0 vulnerabilities |
| `npm ls next react react-dom eslint-config-next --depth=0` | `2026-08-08T23:51:30.7817208-07:00` | `2026-08-08T23:51:32.4143807-07:00` | `next@16.3.0`, `react@19.2.7`, `react-dom@19.2.7`, `eslint-config-next@16.3.0`; exit 0 |

### Mutation-oriented spot checks

Each mutation is applied only in the isolated implementation worktree, selected
by one exact causal regression, reversed with the exact inverse patch, rerun
GREEN, and checked with `git diff --exit-code -- <target>` before the next
mutation starts.

| ID | Minimal mutation and exact causal regression | Observed RED | Restored GREEN / residue |
| --- | --- | --- | --- |
| MU1 | `src/providers/fmp.ts`: remove the entity-mismatch negation. Command: `npx vitest run tests/fmp.client.test.ts -t "rejects a wrong-symbol object before cachedFetch can store it" --reporter=dot` | 1 failed/57 skipped: wrong-symbol `critical` severity became `info` | 1 passed/57 skipped; exact inverse; target diff clean |
| MU2 | `src/pipeline/stageC/payload.ts`: force statement registry currency to `USD`. Command: `npx vitest run tests/stageC.payload.passes.test.ts -t "preserves an ADR statement row's reported currency and verifies only the matching identity" --reporter=dot` | 1 failed/118 skipped: observed `USD` instead of `TWD` | 1 passed/118 skipped; exact inverse; target diff clean |
| MU3 | `src/edgar/xbrl.ts`: remove the same-unit condition. Command: `npx vitest run tests/edgar.xbrl.test.ts -t "rejects a computed fallback with USD and EUR components" --reporter=dot` | 1 failed/44 skipped: observed `true` instead of `false` | 1 passed/44 skipped; exact inverse; target diff clean |
| MU4 | `src/pipeline/compute.ts`: choose annual-first `bal0 ?? balQ`. Command: `npx vitest run tests/stageB.ttm.compute.test.ts -t "sales-to-capital uses the newest complete whole balance point with quarterly provenance" --reporter=dot` | 1 failed/64 skipped: ratio 1.42857 instead of 1.47058 | 1 passed/64 skipped; exact inverse; target diff clean |
| MU5 | `src/pipeline/stageB/sectorRouting.ts`: collapse missing capex with `ocf + (capex ?? 0)`. Command: `npx vitest run tests/stageB.sectorRouting.test.ts -t "missing capex suppresses burn and emits one precise input gap" --reporter=dot` | 1 failed/106 skipped: `burning` became `true` instead of `null` | 1 passed/106 skipped; exact inverse; target diff clean |
| MU6 | `src/pipeline/stageB/quarterWindows.ts`: bypass the violation for a length-four window. Command: `npx vitest run tests/stageB.quarterWindows.test.ts -t "returns five valid windows and three deterministic rejections after a middle quarter is removed" --reporter=dot` | 1 failed/23 skipped: 8 windows instead of 5. An initial unrelated TTM filter stayed GREEN and is not counted as mutation evidence. | 1 passed/23 skipped; exact inverse; target diff clean |
| MU7 | `src/pipeline/stageB/technicals.ts`: widen start tolerance by one day. Command: `npx vitest run tests/stageB.technicals.test.ts -t "accepts an exact-common start 7 days before cutoff and rejects 8 days" --reporter=dot` | 1 failed/55 skipped: the 8-day series was accepted | 1 passed/55 skipped; exact inverse; target diff clean |
| MU8 | `src/pipeline/jobArtifacts.ts`: change `await hook(settlement)` to `void hook(settlement)`. Command: `npx vitest run tests/stageC.index.test.ts -t "settles deterministic verify as an awaited unbillable artifact" --reporter=dot` | 1 failed/11 skipped: verify appeared settled early (`true` instead of `false`) | 1 passed/11 skipped; exact inverse; target diff clean |
| MU9 | `src/app/api/report/[jobId]/stream/route.ts`: move subscription below the first authoritative refresh. Command: `npx vitest run tests/api.routes.stream.test.ts -t "subscribes before its authoritative read and never emits a stale handshake snapshot" --reporter=dot` | 1 failed/15 skipped: no running frame was emitted | 1 passed/15 skipped; exact inverse; target diff clean |
| MU10 | `src/report/export/markdownEscape.ts`: remove the `INLINE_ESCAPES.has(char)` branch. Command: `npx vitest run tests/report.markdownEscape.test.ts -t "neutralizes raw HTML, inline syntax, entities, links, images, and bare autolinks visibly" --reporter=dot` | 1 failed/36 skipped: active raw Markdown grammar was emitted | 1 passed/36 skipped; exact inverse; target diff clean |

All ten causal mutations completed RED -> exact inverse -> GREEN. Final
`git diff --check` passed, and post-mutation status contained only the untracked
audit document.

The first core-coverage attempt before `d7cb6ad` reached 94/95 files and 2,729
passed/1 skipped, then the comparator exceeded its 5 s outer test timeout after
9.174 s under full V8 contention; the same assertion passed in isolation in
2.17 s. Commit `d7cb6ad` added only a 20 s child-process cap and 30 s outer
ceiling to that test. Its focused rerun passed 1/1 in 2.53 s, targeted ESLint
and `git diff --check` passed, and the combined coverage rerun above then passed
without assertion, configuration, manifest, or threshold changes.

Commit `1d8c8e6` closed two static seam-audit gaps without production changes.
The provider-free saved-report boundary passed 1/1 (5 skipped) in 1.49 s; the
unsupported zero-lease/artifact/cost/report/provider/model/pass regression
passed 1/1 (180 skipped) in 1.90 s. TypeScript, targeted ESLint, and
`git diff --check` also passed for that test-only correction.

Commit `3b76336` closed the remaining proxy/EventSource seam with one test-only
regression. The final S2a rerun passed 3/89 in 1.69 s and the unchanged S2b
companion passed 3/13 in 1.56 s. The final Group 4 rerun and canonical product
phase retained that regression. All 15 cross-task seam rows therefore passed
their exact `S1`-`S15` evidence; every command exited 0.

### Repository scope and protected hashes

After canonical verify and restoration of its generated `next-env.d.ts` line:

- `git merge-base 524d09e81b00b08fe6af386011d34759a5e02fc0
  3b7633655ccf94bb6bdcfba2369a1036da410fe2` returned the audited base, and
  `git merge-base --is-ancestor` exited 0;
- the ancestry contains 50 remediation commits after the base; review of the
  ordered commit subjects and changed-path inventory covered the complete
  Tasks 1-32 chain;
- `git diff --name-only 524d09e81b00b08fe6af386011d34759a5e02fc0..3b7633655ccf94bb6bdcfba2369a1036da410fe2`
  returned 179 changed paths: 84 under `tests`, 82 under `src`, two each under
  `docs` and `scripts`, and one each for `.env.example`, `.github`, `README.md`,
  `package.json`, `package-lock.json`, and the four Vitest configuration files;
  the reviewed ancestry and path scope matched the accepted Tasks 1-32 work;
- `git diff --check` exited 0;
- `git status --short` contained only `?? docs/superpowers/audits/`, this final
  verification document;
- worktree `next-env.d.ts` and `HEAD:next-env.d.ts` both resolved to Git blob
  `9edff1c7cacb3bfac9a1eadcf6f51eaa99565e38`;
- `package-lock.json` remained Git blob
  `39e4ec59aca9f54e0bc6a65e4b47fd877256fea0`, SHA-256
  `CE4A76F83725DAAA7DE40138771136873EF35FF39C00C0CF5918B7DE6636C57E`;
- protected `AUDIT_PROMPT.md` remained SHA-256
  `745B73F268A1EA11A5AE6F14447B65C467CC4554EF68E371F189BB723554148C`.

All local gates, scope checks, and protected-byte checks are complete. Remote CI
and branch protection remain **NOT OBSERVED**; this document does not infer them
from local workflow tests.

### Final independent delta rereview

Both independent reviewers examined implementation HEAD
`3b7633655ccf94bb6bdcfba2369a1036da410fe2` plus the complete documentation
refresh: the direct proxy/EventSource regression and mutation proof, exact
H3/S2 and Group 4 reruns, final canonical and single-worker gates, the timestamp
ledger, merge-base/ancestry/path inventory, protected hashes, comparator
provenance, and remote-state boundary.

- Final technical review: **C0 / I0 / M0 — READY**. It confirmed all 26 matrix
  rows, 15 seams, ten mutations, final-head gates, scope, hashes, and stated
  limitations, with no hidden production drift or mutation residue.
- Final evidence review: **C0 / I0 / M0 — READY**. It independently reconciled
  every finding command, correction entry, test/path reference, timestamp,
  comparator claim, scope count, protected hash, and provider/remote boundary,
  with no credential/home-path leak, whitespace error, or stale completion
  claim.
