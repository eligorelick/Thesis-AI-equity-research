# Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct H1-H6, M1-M13, and L1-L3 from the 2026-08-07 independent audit while preserving financially sound deterministic analysis and legacy report readability.

**Implementation workspace:** `.worktrees/audit-remediation` on `codex/audit-remediation`.

**Architecture:** Strengthen the existing provider → bundle → validation → deterministic compute → optional LLM → persistence → report pipeline at its seams. Entity, unit, time, snapshot, and paid-attempt metadata become explicit contracts; invalid or missing financial inputs fail closed. Changes are incremental and protected by cross-layer regression tests rather than a valuation-engine rewrite.

**Tech Stack:** TypeScript 6, Next.js 16 App Router, React 19, Vitest 4, Drizzle ORM, better-sqlite3, Zod 4, GitHub Actions on Node 20.

## Global Constraints

- Treat `../Thesis-AI-equity-research-AUDIT_REPORT.md` and `docs/superpowers/specs/2026-08-07-audit-remediation-design.md` as the requirements.
- Do not modify, delete, stage, or commit user-owned `AUDIT_PROMPT.md` or `.env`.
- Unknown financial data is never zero; suppress a calculation and emit a typed gap when a load-bearing input is absent or incompatible.
- Do not add unsourced FX conversion. The USD pre-revenue threshold runs only on proven USD statement data.
- Do not change established valuation methodology beyond the audited wiring errors. In particular, use the newest whole balance row; do not add invested-capital averaging.
- ETFs and funds never enter company DCF, company grading, paid Anthropic passes, or company-report persistence.
- Provider data is accepted only when requested entity, unit, period, endpoint, observation date, and fetch time are proven.
- Existing stored report JSON remains immutable; safe-read transformations operate on clones and legacy schema reads remain supported.
- Every behavior change follows RED → GREEN → REFACTOR. Record the failing command/output before production edits and the passing command/output afterward.
- Tests use injected transports/fixtures; do not make live FMP, FINRA, FRED, Finnhub, SEC, or Anthropic requests.
- Each task is committed separately after its focused tests, typecheck, and lint pass. Do not bundle unrelated cleanup.
- Completion requires zero known `npm audit` vulnerabilities plus typecheck, lint, default and single-worker product suites, isolated DB integration tests, expanded coverage, and production build.
- The user-owned `AUDIT_PROMPT.md` baseline SHA-256 is `745B73F268A1EA11A5AE6F14447B65C467CC4554EF68E371F189BB723554148C`; final verification compares the file bytes to this value rather than relying on Git to see an untracked file.

## File structure

New focused modules:

- `src/pipeline/stageB/instrumentSupport.ts` — supported-company discriminator.
- `src/pipeline/stageB/financialValues.ts` — null-safe derived financial values.
- `src/pipeline/stageB/quarterWindows.ts` — normalized contiguous fiscal windows.
- `src/pipeline/stageB/asOfSelection.ts` — on-or-before point-in-time selection.
- `src/pipeline/jobArtifacts.ts` — durable per-pass artifacts and resume derivation.
- `src/pipeline/jobScheduler.ts` — durable queue, leases, permits, and spend gates.
- `src/pipeline/jobState.ts` — revisioned job mutations/events.
- `src/app/requestSecurity.ts` and `src/proxy.ts` — request-wide Host/Fetch Metadata policy.
- `src/pipeline/companyLoad.ts` — bounded same-symbol company-load coordination.
- `src/components/report/PersistedReportView.tsx` — chart-free persisted report boundary.
- `src/report/surfaceManifest.ts` — shared grade/score/projection/evidence manifests.
- `src/settings/writeQueue.ts` — serialized last-intent settings writer.
- `src/report/export/markdownEscape.ts` — context-specific Markdown serialization.
- `vitest.integration.config.ts` and `.github/workflows/ci.yml` — deterministic integration and CI gates.

---

### Task 1: Patch the vulnerable dependency graph (L2)

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: current npm registry and official advisory ranges.
- Produces: installed `next@16.3.0`, `eslint-config-next@16.3.0`, `postcss@8.5.26`, `sharp@0.35.3`, patched brace-expansion lines, and `js-yaml>=4.3.1`.

- [ ] **Step 1: Capture the failing security gate**

Run:

```powershell
npm audit --audit-level=low
```

Expected: exit 1 with vulnerable entries for Next/PostCSS/Sharp/brace-expansion/js-yaml.

- [ ] **Step 2: Update direct packages and lock resolution**

Set exact compatible direct ranges together:

```json
{
  "dependencies": {
    "next": "^16.3.0"
  },
  "devDependencies": {
    "eslint-config-next": "^16.3.0",
    "postcss": "^8.5.26"
  }
}
```

Run `npm install --package-lock-only`. Prefer compatible owning-package resolution for Sharp, brace-expansion, and js-yaml. Add a narrow npm override only for a branch that remains vulnerable after lock refresh; never force one incompatible brace-expansion major across all consumers.

- [ ] **Step 3: Verify the actual installed tree**

```powershell
npm ci
npm ls next eslint-config-next postcss sharp brace-expansion js-yaml --all
npm audit --audit-level=low
npm run typecheck
npm run lint
npm test -- --maxWorkers=1
npm run build
```

Expected: every command exits 0; Sharp resolves to at least 0.35.0, brace-expansion to at least 1.1.18 or 5.0.9 per branch, and js-yaml to at least 4.3.1.

- [ ] **Step 4: Commit**

```powershell
git add package.json package-lock.json
git commit -m "chore: patch audited dependency vulnerabilities"
```

### Task 2: Bind FMP responses and cached bodies to requested symbols (H1)

**Files:**
- Modify: `src/symbol.ts`
- Modify: `src/providers/fmp.ts`
- Test: `tests/fmp.client.test.ts`
- Test: `tests/dataBundle.providerCache.test.ts`

**Interfaces:**
- Produces:

```ts
export function canonicalEntitySymbol(value: string): string;
export function sameEntitySymbol(expected: string, actual: string): boolean;

interface FmpEntityScope {
  expectedSymbols: readonly string[];
  returnedSymbol: "required" | "optional";
}
```

- `CallSpec` gains `entityScope?: FmpEntityScope`.
- Cached live envelopes record validated request scope; bodies are revalidated after cache reads.

- [ ] **Step 1: Write failing identity tests**

Add tests named:

```ts
it("rejects a wrong-symbol quote before cachedFetch can store it", async () => {
  // Request AAPL; injected 200 body is [{ symbol: "MSFT", price: 999 }].
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.gap.severity).toBe("critical");
    expect(result.gap.reason).toContain("AAPL");
    expect(result.gap.reason).toContain("MSFT");
  }
  expect(cacheWrites).toBe(0);
});

it("rejects a mixed-entity batch instead of filtering it", async () => {
  // Requested AAPL/MSFT but returned AAPL/GOOG.
  expect(result.ok).toBe(false);
});

it("rejects a poisoned cache hit", async () => {
  // Cache scope says AAPL while body contains MSFT.
  expect(result.ok).toBe(false);
});

it("normalizes only dot-hyphen provider aliases", () => {
  expect(sameEntitySymbol("BRK.B", "brk-b")).toBe(true);
  expect(sameEntitySymbol("BRK.B", "BRKB")).toBe(false);
});
```

Also prove a symbol-less statement row succeeds only with a matching validated request scope.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/fmp.client.test.ts -t "wrong-symbol|mixed-entity|poisoned cache|symbol-less|dot-hyphen"
```

Expected: failures demonstrate current wrong/mixed bodies are accepted and cache validation metadata is absent.

- [ ] **Step 3: Implement request- and cache-bound validation**

Canonicalize by trim + uppercase + `.`/`-` equivalence only. Validate every present returned symbol. Required-symbol endpoints reject omission; optional-symbol endpoints accept omission only when the validated request scope is present. Validate inside the cache loader before insertion and after retrieval.

- [ ] **Step 4: Run GREEN and subsystem tests**

```powershell
npx vitest run tests/fmp.client.test.ts tests/dataBundle.providerCache.test.ts
npm run typecheck
npm run lint
```

- [ ] **Step 5: Commit**

```powershell
git add src/symbol.ts src/providers/fmp.ts tests/fmp.client.test.ts tests/dataBundle.providerCache.test.ts
git commit -m "fix: bind FMP data to requested symbols"
```

### Task 3: Bind EDGAR and FINRA responses to requested entities (H1)

**Files:**
- Modify: `src/providers/edgar.ts`
- Modify: `src/providers/finra.ts`
- Test: `tests/edgar.client.test.ts`
- Test: `tests/finra.fred.test.ts`

**Interfaces:**
- Produces:

```ts
export function sameCik(expected: number | string, actual: number | string): boolean;
export function validateShortInterestScope(
  rows: readonly ShortInterestPoint[],
  expectedSymbol: string,
  expectedSettlementDates: ReadonlySet<string>,
): { ok: true; rows: ShortInterestPoint[] } | { ok: false; reason: string };
```

- [ ] **Step 1: Write failing scoped-response tests**

```ts
it("submissions rejects a response for a different padded CIK", async () => {
  // Request 320193, body identifies 0000789019.
  expect(result.ok).toBe(false);
});

it("companyFacts rejects a response for a different CIK", async () => {
  expect(result.ok).toBe(false);
});

it("short interest rejects wrong and mixed symbols before deduplication", async () => {
  // AAPL request contains an MSFT row on a requested date.
  expect(result.ok).toBe(false);
});

it("short interest rejects dates outside requested partitions", async () => {
  expect(result.ok).toBe(false);
});
```

Retain a control proving the later same-symbol revision for one settlement date wins.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/edgar.client.test.ts -t "different.*CIK"
npx vitest run tests/finra.fred.test.ts -t "wrong-symbol|mixed symbols|requested partitions|revision"
```

- [ ] **Step 3: Implement exact CIK/symbol/date validation before selection**

Compare padded ten-digit CIKs. Validate all FINRA rows against normalized symbol and requested settlement-date membership before selecting or deduplicating. Reject the whole response on conflict.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/edgar.client.test.ts tests/finra.fred.test.ts
npm run typecheck
npm run lint
git add src/providers/edgar.ts src/providers/finra.ts tests/edgar.client.test.ts tests/finra.fred.test.ts
git commit -m "fix: bind EDGAR and FINRA data to request scope"
```

### Task 4: Preserve source envelopes through DataBundle and report appendices (H2)

**Files:**
- Modify: `src/pipeline/types.ts`
- Modify: `src/pipeline/dataBundle.ts`
- Modify: `src/pipeline/stageC/passes.ts`
- Modify: `src/pipeline/jobRunner.ts`
- Modify: `src/report/schema.ts`
- Modify: `src/components/report/sections.tsx`
- Modify: `src/report/export/markdown.ts`
- Modify: `src/report/export/printHtml.ts`
- Test: `tests/stageC.payload.passes.test.ts`
- Test: `tests/jobRunner.test.ts`
- Test: `tests/report.history.export.test.ts`
- Test: `tests/report.export.printHtml.test.ts`

**Interfaces:**
- Produces:

```ts
export interface SourceManifestEntry {
  provider: DataSource;
  endpoint: string;
  asOf: string;
  fetchedAt: string;
  stale: boolean;
}

export interface DataBundle {
  // existing fields
  sourceManifest: Record<string, SourceManifestEntry>;
}
```

- `SourceEntrySchema` gains optional `stale` for legacy reads; new reports always write it.

- [ ] **Step 1: Write failing source round-trip tests**

```ts
expect(buildSources(bundle)).toContainEqual({
  provider: "fmp",
  endpoint: "/stable/treasury-rates",
  asOf: "2026-07-04",
  fetchedAt: "2026-07-05T18:30:00.000Z",
  stale: true,
});
expect(buildSources(bundle)).not.toContainEqual(
  expect.objectContaining({ provider: "fred", endpoint: "treasury" }),
);
```

Add the same expectations for data-only reports and sentinel assertions in React, Markdown, and print source appendices.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/stageC.payload.passes.test.ts -t "source envelopes"
npx vitest run tests/jobRunner.test.ts -t "data-only.*source"
```

Expected: provider/endpoint/fetch timestamp are currently guessed or reconstructed.

- [ ] **Step 3: Populate and consume the manifest**

Record source metadata at the exact point each successful `Sourced` value enters the bundle. Derive legacy `asOf` compatibility fields from the manifest. Delete provider guessing and `fetchedAt = asOf` logic. Sort/deduplicate only identical envelope tuples.

- [ ] **Step 4: Verify renderers and commit**

```powershell
npx vitest run tests/stageC.payload.passes.test.ts tests/jobRunner.test.ts tests/report.history.export.test.ts tests/report.export.printHtml.test.ts
npm run typecheck
npm run lint
git add src/pipeline/types.ts src/pipeline/dataBundle.ts src/pipeline/stageC/passes.ts src/pipeline/jobRunner.ts src/report/schema.ts src/components/report/sections.tsx src/report/export/markdown.ts src/report/export/printHtml.ts tests/stageC.payload.passes.test.ts tests/jobRunner.test.ts tests/report.history.export.test.ts tests/report.export.printHtml.test.ts
git commit -m "fix: preserve provider source envelopes end to end"
```

### Task 5: Preserve statement currency and separate period from observation time (H2)

**Files:**
- Modify: `src/pipeline/stageC/payload.ts`
- Modify: `src/pipeline/stageC/passes.ts`
- Test: `tests/stageC.payload.passes.test.ts`
- Test: `tests/stageC.provenance.test.ts`

**Interfaces:**

```ts
interface PayloadFigure {
  provenanceId?: string;
  label: string;
  value: number | string | null;
  unit: string;
  currency: string | null;
  period: string | null;
  source: string;
  asOf: string | null;
}

interface StatementCell {
  period: string;
  value: number | null;
  currency: string | null;
  asOf: string;
  provenanceId?: string;
}
```

- Bump `PAYLOAD_VERSION` from `1.2.0` to `1.3.0`.

- [ ] **Step 1: Write failing ADR/date tests**

Use a USD-traded/TWD-reporting fixture:

```ts
expect(revenueRecord.currency).toBe("TWD");
expect(verify(omittedCurrencyCitation).verified).toBe(true);
expect(verify(explicitUsdCitation).verified).toBe(false);
expect(coverage).toBe(0.5);
```

Also assert:

```ts
expect(fy2027.period).toBe("2027-09-30");
expect(fy2027.asOf).toBe("2026-07-01");
expect(finnhubJune.asOf).toBe("2026-06-01");
expect(finnhubJune.asOf).not.toBe(bundle.builtAt.slice(0, 10));
```

Unknown-currency monetary records must be absent while nonmonetary share records remain.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/stageC.payload.passes.test.ts -t "ADR statement|unknown currency|forecast period|Finnhub|builtAt"
```

- [ ] **Step 3: Implement explicit currency/period/asOf propagation**

Statement cells use their row `reportedCurrency`. Forecast period is not observation time. Never replace an invalid/missing provider observation date with `builtAt`; suppress that registry record.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/stageC.provenance.test.ts tests/stageC.payload.passes.test.ts
npm run typecheck
npm run lint
git add src/pipeline/stageC/payload.ts src/pipeline/stageC/passes.ts tests/stageC.payload.passes.test.ts tests/stageC.provenance.test.ts
git commit -m "fix: preserve financial currency and observation time"
```

### Task 6: Reject mixed-unit or incompatible-context XBRL sums (M4)

**Files:**
- Modify: `src/edgar/xbrl.ts`
- Test: `tests/edgar.xbrl.test.ts`
- Test: `tests/stageA.validate.test.ts`

**Interfaces:**
- `ConceptValue` gains optional component provenance:

```ts
components?: Array<{
  tag: string;
  value: number;
  unit: string;
  point: FactPoint;
}>;
```

- [ ] **Step 1: Write failing arithmetic tests**

```ts
it("rejects a computed fallback with USD and EUR components", () => {
  // 100 USD + 50 EUR must not become 150 EUR.
  expect(result.ok).toBe(false);
});

it("rejects exact-period and accession-lineage mismatches", () => {
  expect(periodMismatch.ok).toBe(false);
  expect(accessionMismatch.ok).toBe(false);
});

it("preserves a compatible bank fallback", () => {
  expect(result).toMatchObject({ ok: true, value: 150, unit: "USD" });
  expect(result.components).toHaveLength(2);
});
```

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/edgar.xbrl.test.ts -t "computed fallback|exact period|accession lineage|compatible bank"
```

- [ ] **Step 3: Enforce unit/context/lineage equality before arithmetic**

Collect all components first. Require identical unit, exact start/end, accession, and form. On incompatibility continue the documented fallback chain; if no later rule resolves, return not-checkable.

- [ ] **Step 4: Verify Stage A degradation and commit**

```powershell
npx vitest run tests/edgar.xbrl.test.ts tests/stageA.validate.test.ts
npm run typecheck
npm run lint
git add src/edgar/xbrl.ts tests/edgar.xbrl.test.ts tests/stageA.validate.test.ts
git commit -m "fix: require compatible XBRL sum components"
```

### Task 7: Validate EDGAR submissions semantically and contain filing URL errors (M5)

**Files:**
- Modify: `src/providers/edgar.ts`
- Modify: `src/pipeline/dataBundle.ts`
- Test: `tests/edgar.client.test.ts`
- Test: `tests/dataBundle.edgarForms.test.ts`

**Interfaces:**

```ts
export function filingDocumentBodyProblem(body: string): string | null;

class EdgarClient {
  fetchFilingDocument(
    cik: number | string,
    filing: EdgarFiling,
    opts?: { asOf?: string },
  ): Promise<FetchResult<string>>;
}
```

- [ ] **Step 1: Write failing schema/boundary tests**

Add tests for unequal parallel arrays, malformed accession, invalid filing date, unsafe primary document, accession owned by another CIK, and a malformed selected filing that currently rejects `buildDataBundle`.

Use exact validators:

```ts
const accession = /^\d{10}-\d{2}-\d{6}$/;
// primaryDocument: nonempty basename; reject /, \\, ".", and "..".
```

Assert invalid metadata returns a typed critical gap and the injected transport is never called.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/edgar.client.test.ts -t "parallel arrays|malformed accession|filing date|primary document|owned by another"
npx vitest run tests/dataBundle.edgarForms.test.ts -t "malformed selected filing"
```

- [ ] **Step 3: Refine schemas and move URL construction behind FetchResult**

All required and present optional arrays must match `accessionNumber.length`. `buildDataBundle` calls `fetchFilingDocument`, never raw URL construction.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/edgar.client.test.ts tests/dataBundle.edgarForms.test.ts
npm run typecheck
npm run lint
git add src/providers/edgar.ts src/pipeline/dataBundle.ts tests/edgar.client.test.ts tests/dataBundle.edgarForms.test.ts
git commit -m "fix: validate EDGAR filing metadata at the boundary"
```

### Task 8: Reject blank EDGAR cache bodies and mark expected 6-K omissions (M5)

**Files:**
- Modify: `src/providers/edgar.ts`
- Modify: `src/pipeline/dataBundle.ts`
- Test: `tests/edgar.client.test.ts`
- Test: `tests/db.cache.test.ts`
- Test: `tests/report.completeness.test.ts`

**Interfaces:**
- `EdgarTransport.fetchText` accepts:

```ts
validateBody?: (body: string) => string | null;
```

- [ ] **Step 1: Write failing admission/completeness tests**

```ts
it("does not cache a blank HTTP-200 filing on cold miss", async () => {
  // Body is " \r\n\t ".
  expect(result.ok).toBe(false);
  expect(cacheRows).toHaveLength(0);
});

it("preserves last-good filing when refresh is blank", async () => {
  expect(result.value.data).toContain("GOOD");
  expect(storedBody).toContain("GOOD");
});

it("marks only confirmed 6-K structural MD&A omission expected", () => {
  expect(gap).toMatchObject({ field: "edgar.tenQMdna", expected: true });
  expect(completeness.status).toBe("complete");
});
```

An unexplained missing 10-Q remains actionable/degraded.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/edgar.client.test.ts tests/db.cache.test.ts -t "blank HTTP-200|last-good filing|implausible"
npx vitest run tests/report.completeness.test.ts -t "confirmed 6-K|unexplained"
```

- [ ] **Step 3: Validate before both cache layers write**

Run body validation before in-memory insertion and inside the SQLite cache loader. A semantic validation failure never overwrites last-good content. Accept only plausible nonblank filing/index content appropriate to the requested operation.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/edgar.client.test.ts tests/db.cache.test.ts tests/report.completeness.test.ts
npm run typecheck
npm run lint
git add src/providers/edgar.ts src/pipeline/dataBundle.ts tests/edgar.client.test.ts tests/db.cache.test.ts tests/report.completeness.test.ts
git commit -m "fix: harden EDGAR cache admission and expected gaps"
```

### Task 9: Apply immutable legacy entity safety to every normal read (M6)

**Files:**
- Modify: `src/report/legacyEntitySafety.ts`
- Modify: `src/report/history.ts`
- Modify: `src/report/export/correctedCli.ts`
- Test: `tests/report.legacyEntitySafety.test.ts`
- Test: `tests/report.history.export.test.ts`
- Test: `tests/report.query.test.ts`
- Test: `tests/api.routes.report.test.ts`
- Test: `tests/api.routes.export.test.ts`

**Interfaces:**

```ts
export interface SafeStoredReport {
  report: Report;
  readMode: "strict" | "legacy";
  withheldCount: number;
  issues: EntityIssue[];
}

export function parseStoredReportWithSafety(
  reportJson: string | null,
): SafeStoredReport | null;
```

`parseStoredReport` delegates and returns `.report`.

- [ ] **Step 1: Write the failing all-surface parity test**

Persist a schema-valid LLY report containing `TRIUMPH evaluates Foundayo`. Assert that `parseStoredReport`, latest query, ID query, diff pair, report-view API, Markdown, and print output all omit the phrase and contain a critical `legacy.entityValidation` disclosure.

Then prove persistence immutability:

```ts
expect(dbReportJsonAfterReads).toBe(insertedJsonByteForByte);
```

Controls: clean LLY is idempotent, AAPL is unchanged, malformed reports remain null/422, and a lenient legacy report remains readable.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/report.legacyEntitySafety.test.ts tests/report.history.export.test.ts tests/report.query.test.ts tests/api.routes.report.test.ts tests/api.routes.export.test.ts -t "legacy entity|immutable|uncovered"
```

- [ ] **Step 3: Centralize clone-sanitize-revalidate**

Resolve the entity registry from `report.meta.symbol`, sanitize a structured clone, and revalidate with the same strict/legacy read mode. Do not mutate the database row. Route corrected CLI through the same helper.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/report.legacyEntitySafety.test.ts tests/report.history.export.test.ts tests/report.query.test.ts tests/api.routes.report.test.ts tests/api.routes.export.test.ts
npm run typecheck
npm run lint
git add src/report/legacyEntitySafety.ts src/report/history.ts src/report/export/correctedCli.ts tests/report.legacyEntitySafety.test.ts tests/report.history.export.test.ts tests/report.query.test.ts tests/api.routes.report.test.ts tests/api.routes.export.test.ts
git commit -m "fix: sanitize legacy entity conflicts on every read"
```

### Task 10: Stop ETFs and funds before company analysis or paid work (H3)

**Files:**
- Create: `src/pipeline/stageB/instrumentSupport.ts`
- Modify: `src/pipeline/compute.ts`
- Modify: `src/pipeline/jobRunner.ts`
- Modify: `src/pipeline/events.ts`
- Modify: `src/app/api/report/[jobId]/stream/route.ts`
- Modify: `src/app/company/[symbol]/page.tsx`
- Test: `tests/stageB.instrumentSupport.test.ts`
- Test: `tests/jobRunner.test.ts`
- Test: `tests/api.routes.stream.test.ts`

**Interfaces:**

```ts
export type UnsupportedInstrumentKind = "etf" | "fund" | "etf-fund";
export type InstrumentSupport =
  | { supported: true; kind: "company" }
  | { supported: false; kind: UnsupportedInstrumentKind; reason: string };

export function classifyInstrumentSupport(
  input: { isEtf?: boolean | null; isFund?: boolean | null } | null,
): InstrumentSupport;
```

Add terminal unsupported job/event state carrying instrument kind and message.

- [ ] **Step 1: Write failing classifier/job/SSE tests**

For an ETF bundle with an Anthropic key:

```ts
expect(result.status).toBe("unsupported");
expect(result.reportId).toBeNull();
expect(result.totalCostUsd).toBe(0);
expect(paidPassCalls).toEqual([]);
expect(db.select().from(reports).all()).toHaveLength(0);
expect(db.select().from(costLog).all()).toHaveLength(0);
```

Assert the company page renders an unsupported explanation and never invokes `runStageB`/`GenerateReport`. SSE replay treats unsupported as terminal.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/stageB.instrumentSupport.test.ts tests/jobRunner.test.ts tests/api.routes.stream.test.ts -t "unsupported"
```

- [ ] **Step 3: Implement early and defensive support gates**

Classify immediately after profile validation and again at the job boundary before Stage C payload or paid dispatch. Mark downstream steps skipped with the typed reason; do not persist a company report.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/stageB.instrumentSupport.test.ts tests/jobRunner.test.ts tests/api.routes.stream.test.ts
npm run typecheck
npm run lint
git add src/pipeline/stageB/instrumentSupport.ts src/pipeline/compute.ts src/pipeline/jobRunner.ts src/pipeline/events.ts src/app/api/report/[jobId]/stream/route.ts src/app/company/[symbol]/page.tsx tests/stageB.instrumentSupport.test.ts tests/jobRunner.test.ts tests/api.routes.stream.test.ts
git commit -m "fix: stop unsupported funds before company analysis"
```

### Task 11: Use one current point-in-time balance in DCF (H4)

**Files:**
- Modify: `src/pipeline/compute.ts`
- Modify: `src/pipeline/stageB/valuation.ts`
- Test: `tests/stageB.ttm.compute.test.ts`
- Test: `tests/stageB.valuation.test.ts`

**Interfaces:**
- Extend the DCF balance input with `basis: "quarter" | "annual"`; construct it from existing `balPoint`.

- [ ] **Step 1: Write the hand-derived failing wiring test**

```ts
// TTM revenue = 1000.
// New quarterly IC = 280 debt + 520 equity - 120 cash = 680.
expect(assumptions.salesToCapital.value).toBeCloseTo(1000 / 680, 12);
expect(assumptions.salesToCapital.value).toBeCloseTo(1.4705882352941178, 12);
expect(assumptions.salesToCapital.basis).toContain("2026-03-31");
expect(assumptions.salesToCapital.basis).toContain("quarter");
```

The audited annual-anchor result is `1000 / 700 = 1.4285714285714286`.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/stageB.ttm.compute.test.ts -t "sales-to-capital"
```

- [ ] **Step 3: Reuse `balPoint` without methodology expansion**

Pass the newer whole row into `buildDcfAssumptions` and include date/frequency in basis. Do not average balances or mix rows.

- [ ] **Step 4: Verify DCF subsystem and commit**

```powershell
npx vitest run tests/stageB.ttm.compute.test.ts tests/stageB.valuation.test.ts tests/stageB.fairValue.test.ts tests/stageB.dcfDisplay.test.ts
npm run typecheck
npm run lint
git add src/pipeline/compute.ts src/pipeline/stageB/valuation.ts tests/stageB.ttm.compute.test.ts tests/stageB.valuation.test.ts
git commit -m "fix: align DCF capital with current balance point"
```

### Task 12: Centralize null-safe FCF and runway/liquidity behavior (H5)

**Files:**
- Create: `src/pipeline/stageB/financialValues.ts`
- Modify: `src/pipeline/stageB/sectorRouting.ts`
- Modify: `src/pipeline/stageB/growth.ts`
- Modify: `src/pipeline/stageB/capital.ts`
- Modify: `src/pipeline/stageB/valuation.ts`
- Modify: `src/components/charts/map.ts`
- Test: `tests/stageB.financialValues.test.ts`
- Test: `tests/stageB.sectorRouting.test.ts`
- Test: `tests/charts.map.test.ts`

**Interfaces:**

```ts
export function deriveFcf(
  operatingCashFlow: number | null | undefined,
  capitalExpenditure: number | null | undefined,
): number | null;
```

- [ ] **Step 1: Write failing null-semantics tests**

```ts
expect(deriveFcf(6000, -1000)).toBe(5000);
expect(deriveFcf(6000, null)).toBeNull();
expect(deriveFcf(null, -1000)).toBeNull();
expect(deriveFcf(Number.NaN, -1000)).toBeNull();
```

Runway cases:

```ts
// $500m liquidity, OCF -$40m, capex missing.
expect(result.burning).toBeNull();
expect(result.runwayQuarters).toBeNull();
expect(result.burnWindowQuarters).toBe(0);
expect(result.gaps).toEqual(expect.arrayContaining([
  expect.objectContaining({ field: "runway.capitalExpenditure" }),
]));

// With capex -$10m, burn = $50m and runway = 10 quarters.
expect(withCapex.avgQuarterlyBurn).toBe(50_000_000);
expect(withCapex.runwayQuarters).toBe(10);
```

Cash `$300m` plus missing STI must suppress combined liquidity/runway with `runway.liquidAssets`, not claim `$300m`. Chart OCF `6000` with missing capex yields null FCF/conversion.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/stageB.financialValues.test.ts
npx vitest run tests/stageB.sectorRouting.test.ts -t "runway"
npx vitest run tests/charts.map.test.ts -t "FCF"
```

- [ ] **Step 3: Replace sibling zero fallbacks with the shared helper**

Use only finite OCF+capex pairs. A liquidity sum is available only when both components are known. Emit one precise gap per suppressed calculation.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/stageB.financialValues.test.ts tests/stageB.sectorRouting.test.ts tests/stageB.growth.returns.capital.test.ts tests/stageB.valuation.test.ts tests/charts.map.test.ts
npm run typecheck
npm run lint
git add src/pipeline/stageB/financialValues.ts src/pipeline/stageB/sectorRouting.ts src/pipeline/stageB/growth.ts src/pipeline/stageB/capital.ts src/pipeline/stageB/valuation.ts src/components/charts/map.ts tests/stageB.financialValues.test.ts tests/stageB.sectorRouting.test.ts tests/charts.map.test.ts
git commit -m "fix: preserve missing cash flow and liquidity inputs"
```

### Task 13: Suppress EPS projections when share trend is unavailable (H5)

**Files:**
- Modify: `src/pipeline/stageB/projections.ts`
- Test: `tests/stageB.projections.test.ts`

**Interfaces:**
- Reuse the existing required `Projections.disclosures: ManifestEntry[]`; do not add a second warning channel or loosen the saved-report schema.

- [ ] **Step 1: Write the failing missing-share-trend test**

```ts
const p = computeProjections(makeInputs({ shareCountAnnualizedPct: null }));
expect(p.series.some((s) => s.metric === "epsDiluted")).toBe(false);
expect(p.disclosures).toContainEqual(
  expect.objectContaining({
    field: "projections.eps.shareCountTrend",
    severity: "warn",
  }),
);
expect(JSON.stringify(p)).not.toContain("0%/yr (buyback/dilution history)");
```

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/stageB.projections.test.ts -t "share-count trend"
```

- [ ] **Step 3: Suppress EPS rather than invent a flat-share scenario**

When share trend is null, omit EPS series and add the disclosure. Do not introduce a new user assumption in this remediation.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/stageB.projections.test.ts
npm run typecheck
npm run lint
git add src/pipeline/stageB/projections.ts tests/stageB.projections.test.ts
git commit -m "fix: suppress EPS when share trend is missing"
```

### Task 14: Preserve null volume, WACC weights, and DuPont margin (H5)

**Files:**
- Modify: `src/pipeline/stageB/technicals.ts`
- Modify: `src/pipeline/compute.ts`
- Modify: `src/components/charts/PriceChart.tsx`
- Modify: `src/components/charts/map.ts`
- Modify: `src/app/company/[symbol]/format.ts`
- Modify: `src/app/company/[symbol]/page.tsx`
- Test: `tests/stageB.technicals.test.ts`
- Test: `tests/charts.map.test.ts`
- Create: `tests/company.format.test.ts`

**Interfaces:**
- `OhlcvRow.volume` and `PriceBar.volume` become `number | null`.
- Produce:

```ts
export function fmtFractionPct(
  value: number | null | undefined,
  digits?: number,
): string;
```

- [ ] **Step 1: Write failing null-volume/UI tests**

```ts
expect(toPriceBars([{ date: "2026-01-02", open: 10, high: 12, low: 9, close: 11 }])[0].volume)
  .toBeNull();
expect(result.volumeTrend.avg90d).toBeNull();
expect(result.volumeTrend.ratio).toBeNull();
expect(result.volumeTrend.state).toBeNull();
expect(fmtFractionPct(null)).toBe("n/a");
expect(fmtFractionPct(0.25)).toBe("25.0%");
```

Histogram points with null volume are omitted; price bars remain.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/stageB.technicals.test.ts -t "missing volume"
npx vitest run tests/charts.map.test.ts -t "volume"
npx vitest run tests/company.format.test.ts
```

- [ ] **Step 3: Propagate null and use the formatter**

Never convert absent EOD volume to zero before deterministic analysis. A required mean-volume window containing missing volume yields null. Render null WACC/DuPont values as `n/a`.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/stageB.technicals.test.ts tests/charts.map.test.ts tests/company.format.test.ts
npm run typecheck
npm run lint
git add src/pipeline/stageB/technicals.ts src/pipeline/compute.ts src/components/charts/PriceChart.tsx src/components/charts/map.ts src/app/company/[symbol]/format.ts src/app/company/[symbol]/page.tsx tests/stageB.technicals.test.ts tests/charts.map.test.ts tests/company.format.test.ts
git commit -m "fix: keep missing technical and ratio values null"
```

### Task 15: Make the pre-revenue threshold currency-safe (M1)

**Files:**
- Modify: `src/pipeline/compute.ts`
- Modify: `src/pipeline/stageB/sectorRouting.ts`
- Test: `tests/stageB.sectorRouting.test.ts`
- Test: `tests/stageB.ttm.compute.test.ts`

**Interfaces:**
- Add normalized `reportedCurrency: string | null` to routing/TTM income rows. TTM currency exists only when all contributing quarters agree.

- [ ] **Step 1: Write failing USD/non-USD tests**

```ts
expect(routeUsd(9_999_999).overlays).toContain("pre-revenue");
expect(routeUsd(10_000_000).overlays).not.toContain("pre-revenue");

const jpy = routeWithCurrency(500_000_000, "JPY");
expect(jpy.overlays).not.toContain("pre-revenue");
expect(jpy.gaps).toContainEqual(
  expect.objectContaining({ field: "route.overlays.preRevenue.currency" }),
);
```

Mixed USD/JPY TTM quarters produce null currency, a currency gap, and no threshold decision.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/stageB.sectorRouting.test.ts -t "currency"
npx vitest run tests/stageB.ttm.compute.test.ts -t "reported currency"
```

- [ ] **Step 3: Gate the USD rule on proven USD data**

Propagate currency without conversion. Non-USD/unknown/mixed values skip only the pre-revenue overlay and disclose why.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/stageB.sectorRouting.test.ts tests/stageB.ttm.compute.test.ts
npm run typecheck
npm run lint
git add src/pipeline/compute.ts src/pipeline/stageB/sectorRouting.ts tests/stageB.sectorRouting.test.ts tests/stageB.ttm.compute.test.ts
git commit -m "fix: gate pre-revenue routing on USD statements"
```

### Task 16: Share normalized contiguous-quarter window logic (M2)

**Files:**
- Create: `src/pipeline/stageB/quarterWindows.ts`
- Modify: `src/pipeline/compute.ts`
- Modify: `src/pipeline/stageB/valuation.ts`
- Create: `tests/stageB.quarterWindows.test.ts`
- Test: `tests/stageB.valuation.test.ts`
- Test: `tests/stageB.ttm.compute.test.ts`

**Interfaces:**

```ts
export interface FiscalDatedRow {
  date?: unknown;
  acceptedDate?: unknown;
  filingDate?: unknown;
}
export function normalizeQuarterRows<T extends FiscalDatedRow>(
  rows: readonly T[],
): { rows: T[]; rejected: Array<{ period: string; reason: string }> };
export function quarterWindowViolation(
  rows: readonly { date?: unknown }[],
): string | null;
export function contiguousQuarterWindows<T extends { date?: unknown }>(
  rows: readonly T[],
  maxValid: number,
): { windows: T[][]; rejected: Array<{ anchor: string; reason: string }> };
```

- [ ] **Step 1: Write failing normalization/history tests**

Twelve contiguous quarters with revenue 25 and EV 400 create nine observations all equal to 4:

```ts
expect(history.observations).toBe(9);
expect(history.p5).toBe(4);
expect(history.p50).toBe(4);
expect(history.p95).toBe(4);
```

Removing a middle quarter leaves five valid windows, below the minimum eight, so own-history is null with `valuation.multiples.ownHistory` gap. Duplicate periods select uniquely latest accepted/filing timestamp; ambiguous duplicates are rejected.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/stageB.quarterWindows.test.ts
npx vitest run tests/stageB.valuation.test.ts -t "contiguous"
```

- [ ] **Step 3: Extract and reuse the current-TTM validator**

Scan candidate windows until the configured number of valid observations is reached; do not limit by raw indices. Carry rejected-window disclosures.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/stageB.quarterWindows.test.ts tests/stageB.valuation.test.ts tests/stageB.ttm.compute.test.ts
npm run typecheck
npm run lint
git add src/pipeline/stageB/quarterWindows.ts src/pipeline/compute.ts src/pipeline/stageB/valuation.ts tests/stageB.quarterWindows.test.ts tests/stageB.valuation.test.ts tests/stageB.ttm.compute.test.ts
git commit -m "fix: require contiguous quarters for historical TTM"
```

### Task 17: Select historical enterprise value only on or before period end (M2 adjacent)

**Files:**
- Create: `src/pipeline/stageB/asOfSelection.ts`
- Modify: `src/pipeline/stageB/valuation.ts`
- Create: `tests/stageB.asOfSelection.test.ts`
- Test: `tests/stageB.valuation.test.ts`

**Interfaces:**

```ts
export function latestOnOrBeforeWithin<T extends { date: string }>(
  rows: readonly T[],
  asOf: string,
  maxAgeDays: number,
): T | null;
```

- [ ] **Step 1: Write the failing look-ahead test**

For period end `2025-03-31`, rows `2025-04-01` and `2025-03-28` must select `2025-03-28`. With only the future row, return null. Preserve the existing 45-day maximum age.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/stageB.asOfSelection.test.ts tests/stageB.valuation.test.ts -t "future EV|on or before"
```

- [ ] **Step 3: Replace absolute-nearest EV selection**

Filter to dates on/before `asOf`, choose latest, and reject when older than `maxAgeDays`.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/stageB.asOfSelection.test.ts tests/stageB.valuation.test.ts
npm run typecheck
npm run lint
git add src/pipeline/stageB/asOfSelection.ts src/pipeline/stageB/valuation.ts tests/stageB.asOfSelection.test.ts tests/stageB.valuation.test.ts
git commit -m "fix: remove look-ahead from historical multiples"
```

### Task 18: Align security and benchmark price-relative-strength windows (M3)

**Files:**
- Modify: `src/pipeline/stageB/technicals.ts`
- Modify: `src/pipeline/stageB/grading.ts`
- Test: `tests/stageB.technicals.test.ts`
- Test: `tests/stageB.grading.test.ts`

**Interfaces:**
- Add `RS_START_TOLERANCE_DAYS = 7` and a focused aligned-window helper returning either aligned endpoints or a reason.

- [ ] **Step 1: Write failing sparse/aligned-window tests**

Sparse two-point histories from the audit must return null for 3m/6m/12m returns and differentials, with window gaps. A start eight calendar days before cutoff is invalid.

Hand-derived aligned expectations:

```ts
expect(rs.threeMonth.differentialPct).toBeCloseTo(4.329004329, 8);
// security 120/110 - 1 = 9.090909%; benchmark 110/105 - 1 = 4.761905%.
expect(rs.sixMonth.differentialPct).toBeCloseTo(10, 10);
expect(rs.twelveMonth.differentialPct).toBeCloseTo(40, 10);
```

A stale benchmark end invalidates the window. Null 6m differential creates neither an outperformance flag nor a `relStrength6m` grade driver.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/stageB.technicals.test.ts -t "relative strength"
npx vitest run tests/stageB.grading.test.ts -t "relative strength"
```

- [ ] **Step 3: Implement common-end/common-start alignment**

Use the latest common end within tolerance of both series endpoints, then a common on-or-before start within seven days of each target cutoff. Label all output/notes as price return, not total return.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/stageB.technicals.test.ts tests/stageB.grading.test.ts
npm run typecheck
npm run lint
git add src/pipeline/stageB/technicals.ts src/pipeline/stageB/grading.ts tests/stageB.technicals.test.ts tests/stageB.grading.test.ts
git commit -m "fix: align price-relative-strength windows"
```

### Task 19: Add durable job revision, lease, artifact, and attempt schema (M7/M9/L3)

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/index.ts`
- Create: `tests/db.jobs.migration.test.ts`

**Interfaces:**
- Add to `jobs`: `runGeneration`, `revision`, `queuedAt`, `leaseOwner`, `leaseExpiresAt`, `heartbeatAt`, `notBefore`, `maxCostUsd`.
- Add to `cost_log`: `runGeneration`, `attemptId`, with a unique billed-attempt/pass key.
- Create `job_pass_artifacts` keyed by `(jobId, runGeneration, attemptId, pass)` with outcome JSON, telemetry/cost JSON, and `settledAt`.
- Create `job_llm_leases` keyed by `permitId`, with `jobId`, `runGeneration`, `attemptId`, `pass`, `leaseOwner`, `reservedCostUsd`, `acquiredAt`, and `leaseExpiresAt`, plus a unique generation/attempt/pass key. A live row is both the cross-process LLM permit and the durable per-pass spend reservation.
- Index `cost_log.createdAt` for the configured rolling spend window.

- [ ] **Step 1: Write failing migration/constraint tests**

Create a database with the audited legacy schema, run bootstrap, and assert:

```ts
expect(job.runGeneration).toBe(0);
expect(job.revision).toBe(0);
expect(job.leaseOwner).toBeNull();
expect(llmLease.leaseExpiresAt).toBeGreaterThan(llmLease.acquiredAt);
expect(llmLease.reservedCostUsd).toBe(MAXIMUM_PASS_COST_USD);
```

Insert duplicate artifact/billed-attempt/paid-pass-lease keys and expect unique-constraint rejection. Prove LLM permits and spend reservations survive a fresh database connection and expired rows are indexed for reclamation. Run two conditional revision updates and prove atomic `revision = revision + 1` behavior.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/db.jobs.migration.test.ts
```

- [ ] **Step 3: Implement additive idempotent migration and matching Drizzle schema**

Update bootstrap DDL and schema in lockstep. Existing rows get safe defaults. Use explicit indexes for queue claim, job-lease expiry, LLM-lease expiry, job artifacts, and cost lookup.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/db.jobs.migration.test.ts tests/db.paths.test.ts tests/db.cache.test.ts
npm run typecheck
npm run lint
git add src/db/schema.ts src/db/index.ts tests/db.jobs.migration.test.ts
git commit -m "feat: add durable job attempt and artifact schema"
```

### Task 20: Persist each paid pass settlement and cost atomically (M7)

**Files:**
- Create: `src/pipeline/jobArtifacts.ts`
- Modify: `src/pipeline/jobRunner.ts`
- Modify: `src/pipeline/stageC/index.ts`
- Modify: `src/pipeline/stageC/passes.ts`
- Test: `tests/jobRunner.test.ts`
- Test: `tests/stageC.payload.passes.test.ts`

**Interfaces:**

```ts
export type DurablePass = "bull" | "bear" | "synthesize" | "verify";
export type PassSettlement<T> =
  | { outcome: "success"; data: T; telemetry: PassTelemetry }
  | { outcome: "failure"; failure: SerializedPassFailure; telemetry: PassTelemetry };
export type PassSettlementHook<T> =
  (settlement: PassSettlement<T>) => void | Promise<void>;
```

- [ ] **Step 1: Write failing durability/idempotency tests**

Add tests named:

- `persists bull artifact and cost before unresolved bear settles`
- `late settlement after cancellation cannot mutate a newer generation`
- `duplicate settlement callback bills exactly once`
- `persists schema-valid judge artifact before verify starts`

For the first test, resolve bull, keep bear pending, cancel, and assert one bull artifact plus one bull cost row exist before aggregate completion.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/jobRunner.test.ts tests/stageC.payload.passes.test.ts -t "persists bull|late settlement|duplicate settlement|judge artifact"
```

- [ ] **Step 3: Implement per-side awaited settlement hooks**

Persist artifact and cost in one transaction. Duplicate unique keys are no-ops after validating stored identity. A callback may write its immutable artifact for its own generation but may update steps/events only when the generation is current. Mark pass done after commit.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/jobRunner.test.ts tests/stageC.payload.passes.test.ts
npm run typecheck
npm run lint
git add src/pipeline/jobArtifacts.ts src/pipeline/jobRunner.ts src/pipeline/stageC/index.ts src/pipeline/stageC/passes.ts tests/jobRunner.test.ts tests/stageC.payload.passes.test.ts
git commit -m "fix: checkpoint paid passes at durable boundaries"
```

### Task 21: Derive resume state from durable artifacts and report existence (M7)

**Files:**
- Modify: `src/pipeline/jobArtifacts.ts`
- Modify: `src/pipeline/jobRunner.ts`
- Create: `src/pipeline/jobStore.ts`
- Modify: `src/app/api/report/[jobId]/route.ts`
- Modify: `src/app/api/report/[jobId]/retry/route.ts`
- Modify: `src/app/company/[symbol]/GenerateReport.tsx`
- Test: `tests/jobRunner.test.ts`
- Test: `tests/api.routes.report.test.ts`

**Interfaces:**

```ts
export interface JobResumeState {
  resumable: boolean;
  reusablePasses: DurablePass[];
  rerunPasses: DurablePass[];
  reason: string;
}
export function computeJobResumeState(input: ResumeArtifacts): JobResumeState;
```

- [ ] **Step 1: Write failing resume-authority tests**

Assert synthesize-step `done` with no report/judge artifact remains resumable; a linked persisted report is not; compatible legacy bull/bear snapshots resume when no artifacts exist; stale-generation artifacts never control current status. API JSON exposes the exact `resumable` value, and the client shows Retry solely from that field.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/jobRunner.test.ts tests/api.routes.report.test.ts -t "resume|resumable|legacy snapshots"
```

- [ ] **Step 3: Implement one authoritative resume calculation**

Validate artifact schemas and payload fingerprint. Prefer current-generation artifacts, fall back to validated legacy columns only when no artifact exists, and use `reportId` plus actual report row to determine completion. Delete duplicated client step-shape inference.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/jobRunner.test.ts tests/api.routes.report.test.ts
npm run typecheck
npm run lint
git add src/pipeline/jobArtifacts.ts src/pipeline/jobRunner.ts src/pipeline/jobStore.ts src/app/api/report/[jobId]/route.ts src/app/api/report/[jobId]/retry/route.ts src/app/company/[symbol]/GenerateReport.tsx tests/jobRunner.test.ts tests/api.routes.report.test.ts
git commit -m "fix: derive retry state from durable job artifacts"
```

### Task 22: Add a durable global job/LLM scheduler and spend gates (M9)

**Files:**
- Create: `src/pipeline/jobScheduler.ts`
- Modify: `src/pipeline/jobRunner.ts`
- Modify: `src/pipeline/jobArtifacts.ts`
- Modify: `src/pipeline/stageC/index.ts`
- Modify: `src/pipeline/stageC/passes.ts`
- Modify: `src/providers/anthropic.ts`
- Modify: `src/app/api/report/route.ts`
- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Create: `tests/jobScheduler.test.ts`
- Test: `tests/api.routes.report.test.ts`
- Test: `tests/anthropic.test.ts`

**Interfaces:**

```ts
export interface SchedulerLimits {
  maxActiveJobs: number;
  maxActiveLlmCalls: number;
  maxRollingCostUsd: number | null;
  rollingCostWindowMs: number;
  paidPassLeaseTtlMs: number;
}

export function claimNextQueuedJob(workerId: string, now: Date): ClaimedJob | null;
export function renewJobLease(claim: JobClaim, now: Date): boolean;
export function releaseJobLease(claim: JobClaim): void;
export function acquirePaidPassLease(
  claim: JobClaim,
  pass: DurablePass,
  maximumNextPassUsd: number,
  now: Date,
  limits: SchedulerLimits,
): { acquired: true; lease: PaidPassLease } |
   { acquired: false; reason: "capacity" | "job-budget" | "rolling-budget" };
export function renewPaidPassLease(lease: PaidPassLease, now: Date): boolean;
export function releaseUnbilledPaidPassLease(lease: PaidPassLease): void;
```

- [ ] **Step 1: Write failing concurrency/recovery/spend tests**

Prove two schedulers cannot claim the same row; active job/LLM limits hold across distinct symbols; bull and bear each await their own permit before launch; a long call renews its permit/reservation before the original expiry; renewal failure aborts the provider call; an expired lease is reclaimed once and a stale owner cannot renew or settle it; queued cancellation performs no provider/LLM work; and all failure paths release leases/permits and dispatch the next job.

For spend, use two simultaneous bull/bear acquisitions one cent below the per-job cap and prove exactly one reservation succeeds. Repeat against the rolling-window cap from two database connections. Assert each decision atomically sums settled `cost_log` rows plus all live `reservedCostUsd` rows, an expired reservation stops counting only after reclamation, actual settlement plus artifact insertion deletes the reservation in the same transaction, and an unbilled failure releases it. The configured `maximumNextPassUsd` must be a tested upper bound derived from model token/search caps; actual cost above it is an invariant failure, not silently accepted.

Expose and validate `THESIS_MAX_ACTIVE_JOBS`, `THESIS_MAX_ACTIVE_LLM_CALLS`, `THESIS_MAX_JOB_COST_USD`, `THESIS_MAX_ROLLING_COST_USD`, `THESIS_ROLLING_COST_WINDOW_MINUTES`, and `THESIS_PAID_PASS_LEASE_SECONDS`. Add provider-cost tests showing each pass reservation covers its bounded input/output/cache-write/search/retry maximum for every selectable model and that the provider's hard call timeout is strictly below the paid-pass lease TTL.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/jobScheduler.test.ts tests/api.routes.report.test.ts tests/anthropic.test.ts -t "claim|limit|per-pass|renew|expiry|queued cancellation|spend cap|reservation|maximum pass cost|release"
```

- [ ] **Step 3: Implement SQLite claims and dispatcher**

Report POST enqueues and kicks the dispatcher rather than directly detaching `runJob`. Use conditional updates fenced by generation/lease owner. Heartbeat running job leases and reclaim expired ones. Before each independent bull, bear, synthesize, or verify launch, await `acquirePaidPassLease`; never acquire once around the combined analyst operation. In one `BEGIN IMMEDIATE` transaction, prune expired rows, count active LLM rows, sum per-job and configured rolling-window settled-plus-reserved spend, and insert the capacity/cost lease only when every limit allows it. Renew below one-third of TTL while the call is active, keep the provider hard timeout below TTL, and abort on failed renewal. Atomically settle actual cost/artifact and delete the exact fenced lease, or release it on an unbilled exit. Document conservative limits, rolling-window duration, strict maximum-pass estimates, and environment keys.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/jobScheduler.test.ts tests/jobRunner.test.ts tests/api.routes.report.test.ts tests/anthropic.test.ts
npm run typecheck
npm run lint
git add src/pipeline/jobScheduler.ts src/pipeline/jobRunner.ts src/pipeline/jobArtifacts.ts src/pipeline/stageC/index.ts src/pipeline/stageC/passes.ts src/providers/anthropic.ts src/app/api/report/route.ts src/config/env.ts .env.example README.md tests/jobScheduler.test.ts tests/api.routes.report.test.ts tests/anthropic.test.ts
git commit -m "feat: schedule report jobs with durable backpressure"
```

### Task 23: Make SSE replay revisioned and cleanup idempotent (L3)

**Files:**
- Create: `src/pipeline/jobState.ts`
- Modify: `src/pipeline/events.ts`
- Modify: `src/pipeline/jobRunner.ts`
- Modify: `src/app/api/report/[jobId]/stream/route.ts`
- Test: `tests/api.routes.stream.test.ts`

**Interfaces:**
- `JobSnapshot` and every `JobEvent` carry `revision: number`.
- All durable job mutations increment revision atomically through `jobState`.

- [ ] **Step 1: Write failing handshake/cleanup tests**

Add tests named:

- `does not emit a stale pre-subscribe snapshot`
- `drops duplicate and regressing revisions`
- `closes immediately when request signal is already aborted`
- `reader cancel unsubscribes and clears heartbeat exactly once`

Force a queued→running transition in the handshake gap and assert the client receives running revision, not only queued.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/api.routes.stream.test.ts -t "stale pre-subscribe|revision|already aborted|reader cancel"
```

- [ ] **Step 3: Subscribe before replay and unify cleanup**

Subscribe, read a fresh snapshot, emit it, and ignore events whose revision is not greater than the last emitted revision. Treat unsupported/canceled/error/done as terminal. Share one idempotent cleanup among abort, `ReadableStream.cancel`, terminal event, enqueue failure, and heartbeat failure.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/api.routes.stream.test.ts tests/jobRunner.test.ts
npm run typecheck
npm run lint
git add src/pipeline/jobState.ts src/pipeline/events.ts src/pipeline/jobRunner.ts src/app/api/report/[jobId]/stream/route.ts tests/api.routes.stream.test.ts
git commit -m "fix: make job streams revisioned and leak-free"
```

### Task 24: Guard every request and coordinate heavy company loads (M8)

**Files:**
- Create: `src/app/requestSecurity.ts`
- Create: `src/proxy.ts`
- Create: `src/pipeline/companyLoad.ts`
- Modify: `src/app/api/sameOrigin.ts`
- Modify: `src/app/company/[symbol]/page.tsx`
- Test: `tests/api.routes.sameOrigin.test.ts`
- Create: `tests/companyLoad.test.ts`

**Interfaces:**

```ts
export function assertAllowedHost(request: Request): Response | null;
export function assertHeavyGetMetadata(request: Request): Response | null;
export function createCompanyLoadCoordinator<T>(options: {
  maxConcurrent: number;
  negativeTtlMs: number;
  load(symbol: string): Promise<T | null>;
}): (symbol: string) => Promise<T | null>;
```

- [ ] **Step 1: Write failing request/singleflight tests**

Assert a forged non-loopback Host is rejected even without Origin and before DB/provider spies run. Loopback/configured LAN hosts pass. Cross-site iframe/subresource company GET fails while top-level navigation and headerless local clients pass. Two concurrent normalized same-symbol loads invoke loader once. Unknown symbol is negative-cached only for configured TTL; different symbols honor `maxConcurrent`.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/api.routes.sameOrigin.test.ts tests/companyLoad.test.ts
```

- [ ] **Step 3: Implement request-wide defense plus local coordinator**

`proxy.ts` applies Host guard broadly and heavy Fetch Metadata policy before routing. Keep mutation Origin checks in handlers. Do not rely on proxy alone for sensitive mutation authorization. Normalize symbols through existing symbol validation.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/api.routes.sameOrigin.test.ts tests/companyLoad.test.ts tests/api.routes.report.test.ts tests/api.routes.export.test.ts
npm run typecheck
npm run lint
npm run build
git add src/app/requestSecurity.ts src/proxy.ts src/pipeline/companyLoad.ts src/app/api/sameOrigin.ts src/app/company/[symbol]/page.tsx tests/api.routes.sameOrigin.test.ts tests/companyLoad.test.ts
git commit -m "fix: protect local GET surfaces and bound company loads"
```

### Task 25: Separate persisted reports from live charts (H6)

**Files:**
- Create: `src/components/report/PersistedReportView.tsx`
- Modify: `src/app/company/[symbol]/page.tsx`
- Modify: `src/app/company/[symbol]/report/[reportId]/page.tsx`
- Create: `tests/company.report.presentation.test.ts`

**Interfaces:**

```tsx
export function PersistedReportView({ report }: { report: Report }) {
  return <ReportView report={report} />;
}
```

The component accepts no chart/live-bundle props.

- [ ] **Step 1: Write failing persisted-surface parity tests**

Assert both company latest-report tab and saved-run route delegate to the same chart-free boundary with exactly `{ report }`. Assert the persisted report tree contains no current `TechnicalsChartPanel`/`FundamentalsCharts`; live analysis still renders them with its own as-of label.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/company.report.presentation.test.ts
```

- [ ] **Step 3: Introduce the shared boundary and remove chart injection**

Move only persisted report rendering. Do not remove charts from live deterministic analysis and do not migrate report schema.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/company.report.presentation.test.ts tests/report.fixture.test.ts
npm run typecheck
npm run lint
git add src/components/report/PersistedReportView.tsx src/app/company/[symbol]/page.tsx src/app/company/[symbol]/report/[reportId]/page.tsx tests/company.report.presentation.test.ts
git commit -m "fix: keep persisted reports on one snapshot"
```

### Task 26: Model complete versioned report-diff transitions (M10)

**Files:**
- Modify: `src/report/diff.ts`
- Modify: `src/app/company/[symbol]/history/diff/page.tsx`
- Test: `tests/report.history.export.test.ts`

**Interfaces:**

```ts
export type TransitionKind =
  | "changed"
  | "added"
  | "removed"
  | "became-available"
  | "became-unavailable";

export interface VersionedDiffContext {
  fromReportVersion: string;
  toReportVersion: string;
  fromSpecVersion: string | null;
  toSpecVersion: string | null;
}
```

Grade/score/target/projection transition endpoints become nullable where required.
Score diffs include composite/aspect results, the union of composite weight keys, and the union of driver identities keyed by `(aspect, sourceId ?? source, unit, period ?? "")`. Driver transitions compare value and traced provenance rather than array position.

- [ ] **Step 1: Write failing availability/rolling-horizon tests**

Add unique sentinels for every composite weight and every aspect driver. Assert changed, added, removed, became-available, and became-unavailable weight/driver transitions appear in the diff model and UI. Reordering an otherwise identical driver array must not create a false change.

Cover optional balance grade added/removed, score block absent→present, scenario target null↔value, projection metric added/removed, and FY2026–30 rolling to FY2027–31. Join projections by `(metric, period)` and assert nonoverlapping periods appear as added/removed. A version mismatch is surfaced; UI distinguishes `unchanged` from `not comparable`.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/report.history.export.test.ts -t "added|removed|became|rolled|not comparable|version"
```

- [ ] **Step 3: Compare unions rather than shared-only values**

Build union keys for grades, scores, composite weights, traced aspect drivers, targets, and projection metric/period points. Emit explicit transitions for null/absence and driver provenance changes. Preserve existing changed-value calculations.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/report.history.export.test.ts tests/report.schema.test.ts
npm run typecheck
npm run lint
git add src/report/diff.ts src/app/company/[symbol]/history/diff/page.tsx tests/report.history.export.test.ts
git commit -m "fix: report all history availability transitions"
```

### Task 27: Share grade, score, projection, and evidence surface manifests (M11)

**Files:**
- Create: `src/report/surfaceManifest.ts`
- Modify: `src/components/report/sections.tsx`
- Modify: `src/report/history.ts`
- Modify: `src/report/diff.ts`
- Modify: `src/watchlist/watchlist.ts`
- Modify: `src/components/watchlist/Sidebar.tsx`
- Modify: `src/app/page.tsx`
- Modify: `src/app/api/report/view/[reportId]/route.ts`
- Test: `tests/report.format.shared.test.ts`
- Test: `tests/report.history.export.test.ts`
- Test: `tests/watchlist.test.ts`
- Test: `tests/api.routes.report.test.ts`

**Interfaces:**
- Produce typed manifests for all seven grade-strip keys (including optional `balanceSheet`), eight score keys, seven composite-weight keys, traced driver identity/fields, executive-evidence groups, and projection metric/path kinds.

- [ ] **Step 1: Write failing unique-sentinel consumption tests**

Assign a unique sentinel to every manifest leaf. Assert the balance-sheet grade, every score weight, every traced driver, and each manifest key are consumed by live grade strip, home/watchlist/sidebar summaries, history, report-ready API, and diff. The test iterates the manifest, not hard-coded duplicate key lists, and fails when a consumer omits a key.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/report.format.shared.test.ts tests/report.history.export.test.ts tests/watchlist.test.ts tests/api.routes.report.test.ts -t "manifest|balance sheet|sentinel"
```

- [ ] **Step 3: Replace renderer-local field lists with shared manifests**

Keep formatting functions consumer-specific but source key/label/order from one typed manifest. Update diff union logic to consume the same keys.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/report.format.shared.test.ts tests/report.history.export.test.ts tests/watchlist.test.ts tests/api.routes.report.test.ts
npm run typecheck
npm run lint
git add src/report/surfaceManifest.ts src/components/report/sections.tsx src/report/history.ts src/report/diff.ts src/watchlist/watchlist.ts src/components/watchlist/Sidebar.tsx src/app/page.tsx src/app/api/report/view/[reportId]/route.ts tests/report.format.shared.test.ts tests/report.history.export.test.ts tests/watchlist.test.ts tests/api.routes.report.test.ts
git commit -m "refactor: share audited report surface manifests"
```

### Task 28: Render complete evidence/provenance and honest completeness copy (M11)

**Files:**
- Modify: `src/components/report/ReportView.tsx`
- Modify: `src/components/report/sections.tsx`
- Modify: `src/report/export/markdown.ts`
- Modify: `src/report/export/printHtml.ts`
- Modify: `src/app/company/[symbol]/GenerateReport.tsx`
- Test: `tests/report.history.export.test.ts`
- Test: `tests/report.export.printHtml.test.ts`
- Test: `tests/report.completeness.test.ts`

**Interfaces:**
- Consumes the Task 27 surface manifests and existing schema leaves.
- Produces visible score weights/drivers, executive evidence, projection history/scenario paths, per-point source/as-of/verification, and disclosures in UI and both exports.

- [ ] **Step 1: Write failing renderer parity tests**

Use unique sentinels for every score driver/weight, three executive evidence claims, historical and forward projection points, source IDs, as-of dates, citation/verification state, and disclosure. Assert each sentinel appears in live rendered markup, Markdown, and print HTML.

Completeness copy cases:

```ts
expect(incompleteDataOnlyBanner).not.toContain("computed metrics are still complete");
expect(incompleteDataOnlyBanner).toContain("additional data gaps");
expect(completeDataOnlyBanner).toContain("deterministic data is complete");
```

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/report.history.export.test.ts tests/report.export.printHtml.test.ts tests/report.completeness.test.ts -t "driver|weight|executive evidence|projection provenance|data-only banner|sentinel"
```

- [ ] **Step 3: Render every manifest field and derive copy from completeness**

Use collapsible/compact tables in UI and readable tables in exports. Do not fabricate provenance for points without it. Base banner wording on `meta.dataCompleteness` and actual actionable-gap counts, not merely `analysis.llm`.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/report.history.export.test.ts tests/report.export.printHtml.test.ts tests/report.completeness.test.ts tests/report.fixture.test.ts
npm run typecheck
npm run lint
git add src/components/report/ReportView.tsx src/components/report/sections.tsx src/report/export/markdown.ts src/report/export/printHtml.ts src/app/company/[symbol]/GenerateReport.tsx tests/report.history.export.test.ts tests/report.export.printHtml.test.ts tests/report.completeness.test.ts
git commit -m "fix: expose report evidence and honest completeness"
```

### Task 29: Serialize full-state settings writes to preserve last intent (M13)

**Files:**
- Create: `src/settings/writeQueue.ts`
- Modify: `src/app/settings/page.tsx`
- Modify: `src/settings/settings.ts`
- Modify: `src/app/api/settings/route.ts`
- Create: `tests/settings.writeQueue.test.ts`
- Test: `tests/api.routes.settings.test.ts`

**Interfaces:**

```ts
export interface WritableSettings {
  analysisModel: AnalysisModelSetting;
  analysisEffort: EffortLevel;
}

export function createSettingsWriteQueue(options: {
  write(state: WritableSettings): Promise<WritableSettings>;
  recover(): Promise<WritableSettings>;
  onState(state: WriterState): void;
}): { setDesired(state: WritableSettings): void; flush(): Promise<void> };
```

- [ ] **Step 1: Write failing deferred-response/transaction tests**

Simulate rapid A→B→C. Assert requests are A then C (B coalesced), A's response cannot replace C, and saved appears only after C returns. On A failure, authoritative state is refetched before another save. Server failure between keys rolls back both values.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/settings.writeQueue.test.ts tests/api.routes.settings.test.ts
```

- [ ] **Step 3: Implement one in-flight full-state writer and transactional endpoint**

POST accepts a strict full settings object. Write both keys in one DB transaction. The client queues only the latest desired state and reconciles on error.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/settings.writeQueue.test.ts tests/api.routes.settings.test.ts tests/env.test.ts
npm run typecheck
npm run lint
git add src/settings/writeQueue.ts src/app/settings/page.tsx src/settings/settings.ts src/app/api/settings/route.ts tests/settings.writeQueue.test.ts tests/api.routes.settings.test.ts
git commit -m "fix: serialize settings writes by last intent"
```

### Task 30: Neutralize Markdown structure and raw HTML by context (L1)

**Files:**
- Create: `src/report/export/markdownEscape.ts`
- Modify: `src/report/export/markdown.ts`
- Modify: `src/app/api/export/[reportId]/route.ts`
- Test: `tests/report.history.export.test.ts`
- Test: `tests/api.routes.export.test.ts`

**Interfaces:**

```ts
export function markdownProse(value: string): string;
export function markdownHeading(value: string): string;
export function markdownListItem(value: string): string;
export function markdownTableCell(value: string): string;
export function markdownBlockquote(value: string): string;
export function markdownCodeSpan(value: string): string;
export function markdownSourceLabel(value: string): string;
```

- [ ] **Step 1: Write failing poison-string tests**

Inject `<script>alert(1)</script>`, `# injected`, `- injected`, `[click](javascript:alert(1))`, `![image](https://evil)`, backtick runs, pipes/newlines, and blockquotes into every schema-valid interpolation context. Assert output contains no literal HTML tag, active injected link/image, new heading/list/blockquote, broken table, or unterminated code span.

API assertions:

```ts
expect(response.headers.get("content-disposition")).toContain("attachment");
expect(response.headers.get("x-content-type-options")).toBe("nosniff");
```

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/report.history.export.test.ts tests/api.routes.export.test.ts -t "poison|Markdown|nosniff"
```

- [ ] **Step 3: Route every untrusted interpolation through its serializer**

Fixed template syntax remains unchanged. Neutralize raw HTML and line-leading structural characters; choose safe code-span fences longer than any input backtick run. Table cells escape pipes and collapse newlines.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run tests/report.history.export.test.ts tests/api.routes.export.test.ts tests/report.export.printHtml.test.ts
npm run typecheck
npm run lint
git add src/report/export/markdownEscape.ts src/report/export/markdown.ts src/app/api/export/[reportId]/route.ts tests/report.history.export.test.ts tests/api.routes.export.test.ts
git commit -m "fix: serialize Markdown export safely by context"
```

### Task 31: Add enforceable CI, risk coverage, and deterministic DB integration (M12)

**Files:**
- Modify: `package.json`
- Modify: `vitest.config.ts`
- Create: `vitest.risk.config.ts`
- Create: `vitest.integration.config.ts`
- Create: `.github/workflows/ci.yml`
- Modify: `tests/db.cli.test.ts`
- Modify: `tests/repository.release.test.ts`
- Modify: `README.md`

**Interfaces:**
- `npm run test:integration` runs DB CLI tests with fork isolation, `fileParallelism:false`, `maxWorkers:1`, and 15-second test timeout.
- `vitest.config.ts` and `vitest.risk.config.ts` explicitly exclude `tests/db.cli.test.ts`; `vitest.integration.config.ts` includes only that file. Product and integration file sets are mutually exclusive.
- Product and risk configs use `isolate:true`; no hoisted mock may leak between files through a shared module registry.
- `npm run test:coverage:core` preserves the existing Stage B/schema floors (90% statements, 84% branches, 95% functions, 93% lines).
- `npm run test:coverage:risk` covers the newly audited provider, provenance, orchestration, report, settings, and security scope with floors of 85% statements, 75% branches, 85% functions, and 85% lines.
- `npm run test:coverage` runs both coverage contracts; neither contract may lower or exclude a floor to make CI green.
- `npm run verify` mirrors required CI gates and includes risk-based coverage plus build and audit.

- [ ] **Step 1: Write failing release/config contract tests**

Update the release test to inspect tracked files only and assert:

```ts
expect(trackedFiles).toContain(".github/workflows/ci.yml");
expect(trackedFiles).toContain("docs/superpowers/specs/2026-08-07-audit-remediation-design.md");
expect(trackedFiles).toContain("docs/superpowers/plans/2026-08-07-audit-remediation.md");
expect(packageJson.scripts.verify).toContain("test:coverage");
expect(packageJson.scripts.verify).toContain("test:integration");
expect(productConfig.test.exclude).toContain("tests/db.cli.test.ts");
expect(riskConfig.test.exclude).toContain("tests/db.cli.test.ts");
expect(integrationConfig.test.include).toEqual(["tests/db.cli.test.ts"]);
expect(productConfig.test.isolate).toBe(true);
expect(riskConfig.test.isolate).toBe(true);
```

The presence of untracked `AUDIT_PROMPT.md` must not affect the tracked release inventory.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run tests/repository.release.test.ts
npm run test:integration
```

Expected: workflow/scripts/config are absent before implementation.

- [ ] **Step 3: Add CI and expand risk-based coverage**

GitHub Actions on Node 20 runs clean install, dependency-shape check, typecheck, lint, product tests, integration tests, both coverage contracts, build, and `npm audit --audit-level=low`. Keep the current `vitest.config.ts` include and thresholds as the core contract while excluding `tests/db.cli.test.ts` and restoring `isolate:true`. Add `vitest.risk.config.ts` for provider identity, Stage A/C provenance, job artifacts/scheduler/state, report query/diff/export, settings queue, and request security at exactly 85/75/85/85, also excluding the DB CLI file and using `isolate:true`. Make `vitest.integration.config.ts` include only `tests/db.cli.test.ts`; add a config/list-files assertion proving the product and integration pools do not overlap. If a module cannot meet a floor, add behavioral tests; do not exclude the audited module or reduce either contract.

- [ ] **Step 4: Verify DB flake isolation**

```powershell
npm run test:integration
npm run test:integration
npm test
npm test
```

Expected: four clean runs; the DB CLI test no longer shares the high-concurrency product pool.

- [ ] **Step 5: Verify full local CI contract and commit**

```powershell
npm ci
npm run verify
npm audit --audit-level=low
git add package.json package-lock.json vitest.config.ts vitest.risk.config.ts vitest.integration.config.ts .github/workflows/ci.yml tests/db.cli.test.ts tests/repository.release.test.ts README.md docs/superpowers/specs/2026-08-07-audit-remediation-design.md docs/superpowers/plans/2026-08-07-audit-remediation.md
git commit -m "ci: enforce audited quality and security gates"
```

### Task 32: Perform the requirement-by-requirement completion audit

**Files:**
- Create: `docs/superpowers/audits/2026-08-07-remediation-verification.md`
- Modify only if evidence exposes an uncorrected finding: the corresponding production/test files from Tasks 1-31.

**Interfaces:**
- Produces a matrix with one row for H1-H6, M1-M13, L1-L3 and the four adjacent risks. Each row names root-cause code, regression test, focused command, result, and residual limitation.

- [ ] **Step 1: Re-read authoritative requirements**

Read the external audit, design spec, implementation plan, SDD ledger, and final branch diff. Create the matrix with all 26 required rows before running commands; no row may be inferred from another finding's test.

- [ ] **Step 2: Run focused finding suites**

```powershell
npx vitest run tests/fmp.client.test.ts tests/edgar.client.test.ts tests/finra.fred.test.ts tests/dataBundle.providerCache.test.ts tests/dataBundle.edgarForms.test.ts tests/edgar.xbrl.test.ts tests/stageA.validate.test.ts
npx vitest run tests/stageC.provenance.test.ts tests/stageC.payload.passes.test.ts tests/report.legacyEntitySafety.test.ts tests/report.completeness.test.ts
npx vitest run tests/stageB.instrumentSupport.test.ts tests/stageB.financialValues.test.ts tests/stageB.quarterWindows.test.ts tests/stageB.asOfSelection.test.ts tests/stageB.sectorRouting.test.ts tests/stageB.ttm.compute.test.ts tests/stageB.valuation.test.ts tests/stageB.projections.test.ts tests/stageB.technicals.test.ts tests/stageB.grading.test.ts tests/charts.map.test.ts tests/company.format.test.ts
npx vitest run tests/db.jobs.migration.test.ts tests/jobScheduler.test.ts tests/jobRunner.test.ts tests/api.routes.stream.test.ts tests/api.routes.sameOrigin.test.ts tests/companyLoad.test.ts
npx vitest run tests/company.report.presentation.test.ts tests/report.history.export.test.ts tests/report.export.printHtml.test.ts tests/report.format.shared.test.ts tests/watchlist.test.ts tests/settings.writeQueue.test.ts tests/api.routes.settings.test.ts tests/api.routes.export.test.ts tests/api.routes.report.test.ts
```

- [ ] **Step 3: Run all fresh global gates**

```powershell
npm ci
npm run typecheck
npm run lint
npm test
npx vitest run --maxWorkers=1
npm run test:integration
npm run test:coverage
npm run build
npm audit --audit-level=low
npm ls next eslint-config-next postcss sharp brace-expansion js-yaml --all
git diff --check
git status --short
$auditPromptPath = Join-Path (Split-Path -Parent (git rev-parse --path-format=absolute --git-common-dir)) "AUDIT_PROMPT.md"
$expectedAuditPromptHash = "745B73F268A1EA11A5AE6F14447B65C467CC4554EF68E371F189BB723554148C"
$actualAuditPromptHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $auditPromptPath).Hash
if ($actualAuditPromptHash -ne $expectedAuditPromptHash) { throw "AUDIT_PROMPT.md changed after the remediation baseline was recorded" }
```

Expected: all gates exit 0; dependency tree is patched; the byte-level `AUDIT_PROMPT.md` hash matches its recorded pre-implementation baseline; only intended tracked files are changed relative to merge base.

- [ ] **Step 4: Run mutation-oriented spot checks**

For each high-risk invariant, use `apply_patch` to introduce one minimal mutation in the isolated implementation worktree and prove its focused regression test fails: wrong provider symbol, wrong registry currency, mixed XBRL unit, annual DCF anchor, `?? 0` FCF, noncontiguous TTM, stale relative-strength start, non-durable pass callback, stale SSE replay, and unsafe Markdown. Immediately reverse that same mutation with `apply_patch`, rerun the test green, and confirm `git diff` contains no mutation residue before continuing.

- [ ] **Step 5: Complete the verification document and commit**

Record exact command timestamps, exit codes, test counts, coverage, audit result, and every matrix row's evidence. Any missing/weak row returns to the owning task; do not mark complete.

```powershell
git add docs/superpowers/audits/2026-08-07-remediation-verification.md
git commit -m "docs: record audit remediation verification"
```
