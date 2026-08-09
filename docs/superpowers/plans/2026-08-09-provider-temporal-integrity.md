# Provider and Temporal Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admit provider data only after entity, schema, domain, cache, and observation-time validation, while preserving typed gaps and valid stale fallback behavior.

**Architecture:** Keep the existing `FetchResult`, `Sourced`, provider-client, and generic cache boundaries. Provider operations supply pure semantic admission functions to the existing cache validators, revalidate decoded hits, and preserve observation dates separately from fetch/event dates. Each defect is fixed at its earliest reliable boundary and protected by an adversarial regression.

**Tech Stack:** TypeScript, Zod, Vitest, Next.js 16, Drizzle ORM, SQLite, native `fetch`/`Response` test doubles.

## Global Constraints

- Invalid, ambiguous, wrong-entity, or schema-invalid data must produce a typed gap and must not be cached as usable evidence.
- A valid stale last-good entry may be served only inside the existing hard-stale policy and must retain `stale: true`.
- `Sourced.asOf` is the underlying observation date; `Sourced.fetchedAt` is the transport/cache retrieval timestamp; future event dates remain in the datum.
- Missing, valid-empty, and malformed are distinct states. Never convert any of them into a favorable zero.
- Do not add providers, perform FX conversion, change valuation formulas, alter LLM report schemas, migrate saved reports, or redesign generic cache storage.
- Preserve the raw FMP `LiveExchange` cache representation and existing endpoint/source attribution.
- Company-fact observation dates admit only `10-K`, `10-Q`, `10-K/A`, `10-Q/A`, `20-F`, and `20-F/A` facts no later than the fetch date.
- Finnhub sentiment requires matching top-level and row symbols, integer year 1900-2100, month 1-12 inside the requested month range, and finite MSPR in `[-100, 100]`.
- Every production change follows red-green-refactor and receives a focused commit.

---

## File map

- `src/providers/fmp.ts`: define the FMP semantic-validation cache contract and validate critical live/cached bodies.
- `src/pipeline/dataBundle.ts`: adapt FMP semantic validators onto `apiCache.cachedFetch.validateBody`; preserve next-earnings observation time.
- `src/providers/edgar.ts`: parse and validate EDGAR JSON before memory/SQLite cache admission; source company facts from fact-period time.
- `src/edgar/xbrl.ts`: provide a pure latest eligible company-fact end-date resolver.
- `src/providers/finnhub.ts`: enforce insider-sentiment issuer and numeric-domain contracts.
- `src/edgar/extract.ts`: remove all supported `display:none` attribute variants before text/section extraction.
- `src/pipeline/stageA/validate.ts`: combine statement-period cadence with cache stale state.
- `src/providers/finra.ts`: distinguish valid empty arrays from malformed payloads.
- `tests/dataBundle.providerCache.test.ts`: FMP/Finnhub cache-admission regressions.
- `tests/edgar.client.test.ts`: EDGAR JSON cache admission and company-fact envelope tests.
- `tests/edgar.extract.test.ts`: hidden-content and hidden-decoy section tests.
- `tests/edgar.xbrl.test.ts`: eligible company-fact date tests.
- `tests/dataBundle.earnings.test.ts`: event-date versus observation-date tests.
- `tests/stageA.validate.test.ts`: stale statement-envelope freshness tests.
- `tests/finra.fred.test.ts` and `tests/risk.providers.coverage.test.ts`: FINRA and Finnhub domain/empty-provider behavior.
- `docs/superpowers/audits/2026-08-09-provider-temporal-integrity-verification.md`: final finding-to-evidence matrix.

---

### Task 1: FMP semantic validation before cache admission

**Files:**
- Modify: `src/providers/fmp.ts:41-58, 997-1045, 1129-1240`
- Modify: `src/pipeline/dataBundle.ts:175-213`
- Test: `tests/dataBundle.providerCache.test.ts`

**Interfaces:**
- Consumes: `apiCache.cachedFetch({ validateBody })`, existing `LiveExchange`, `CallSpec`, `normalizeRows`, `validateEntityBody`, and `validateCriticalRows`.
- Produces: `CachedFetchOptions<T> = { validateValue?: (value: T) => string | null }`; the fourth optional argument of `CachedFetchFn`; `fmpLiveExchangeProblem(spec, exchange, expectedScope): string | null`.

- [ ] **Step 1: Write the failing cold-cache and poisoned-cache tests**

Add the imports `buildCacheKey` from `@/cache/apiCache` and `fmpCacheKey` from `@/providers/fmp`, then add:

```ts
it("rejects schema-invalid FMP 200s before cache admission and refetches", async () => {
  let call = 0;
  const fetchImpl = vi.fn(async () => {
    call += 1;
    return call === 1
      ? jsonResponse([{ symbol: "AAPL", price: "not-a-number" }])
      : jsonResponse([{ symbol: "AAPL", price: 201 }]);
  });
  const client = createFmpClient({
    apiKey: "FMP-KEY",
    fetchImpl,
    limiter: makeLimiter(1000, 1000),
    cachedFetch: makeFmpCachedFetch(),
  });

  const rejected = await client.quote("AAPL");
  const recovered = await client.quote("AAPL");

  expect(rejected).toMatchObject({
    ok: false,
    gap: { reason: expect.stringMatching(/schema drift|number/i) },
  });
  expect(recovered).toMatchObject({ ok: true, value: { data: { rows: [{ price: 201 }] } } });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(cacheRows()).toHaveLength(1);
});

it("evicts a schema-invalid legacy FMP cache row before using it", async () => {
  const endpoint = fmpCacheKey("quote", { symbol: "AAPL" });
  const cacheKey = buildCacheKey("fmp", endpoint, {});
  handle.db.insert(apiCache).values({
    cacheKey,
    provider: "fmp",
    endpoint,
    paramsJson: "{}",
    bodyJson: JSON.stringify({
      body: [{ symbol: "AAPL", price: "poison" }],
      status: 200,
      fetchedAt: "2026-08-09T00:00:00.000Z",
      entityScope: { expectedSymbols: ["AAPL"], returnedSymbol: "required" },
    }),
    bodyGz: null,
    fetchedAt: new Date().toISOString(),
    ttlSeconds: 900,
    asOf: "2026-08-09",
  }).run();
  const fetchImpl = vi.fn(async () => jsonResponse([{ symbol: "AAPL", price: 202 }]));
  const client = createFmpClient({
    apiKey: "FMP-KEY",
    fetchImpl,
    limiter: makeLimiter(1000, 1000),
    cachedFetch: makeFmpCachedFetch(),
  });

  const result = await client.quote("AAPL");

  expect(result).toMatchObject({ ok: true, value: { data: { rows: [{ price: 202 }] } } });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(cacheRows()).toHaveLength(1);
});
```

- [ ] **Step 2: Run the focused tests and confirm the old behavior**

Run:

```powershell
npx vitest run --config vitest.config.ts tests/dataBundle.providerCache.test.ts
```

Expected: FAIL. The first invalid quote remains cached so the second call does not recover, and the seeded poison is returned as a schema gap without refetching.

- [ ] **Step 3: Extend the FMP cache interface and centralize semantic validation**

In `src/providers/fmp.ts`, use this exact cache option shape:

```ts
export interface CachedFetchOptions<T> {
  validateValue?: (value: T) => string | null;
}

export type CachedFetchFn = <T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  options?: CachedFetchOptions<T>,
) => Promise<CachedFetchResult<T>>;
```

Add a typed validation error and one pure problem resolver near the FMP error classes:

```ts
class FmpSchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FmpSchemaValidationError";
  }
}

function fmpLiveExchangeProblem(
  spec: CallSpec,
  exchange: LiveExchange,
  expectedScope: FmpEntityScope | undefined,
): string | null {
  const body = exchange.body;
  if (expectedScope !== undefined) {
    if (exchange.entityScope !== undefined && !matchingEntityScope(expectedScope, exchange.entityScope)) {
      return `FMP cached request scope did not match ${expectedScope.expectedSymbols.join(", ")}`;
    }
    const identity = validateEntityBody(body, expectedScope, exchange.entityScope !== undefined);
    if (identity !== null) return identity;
  }
  if (Array.isArray(body) && body.some((row) => !isRecord(row))) {
    return `FMP provider schema drift in ${spec.method}: response array contains a non-object row`;
  }
  const rows = normalizeRows<FmpRawRow>(body, spec.allowObjectBody === true);
  if (Array.isArray(body) && body.length === 0) return null;
  if (rows.length === 0) {
    return "FMP returned an unrecognized body where rows were expected";
  }
  const critical = validateCriticalRows(spec.method, rows);
  return critical.ok ? null : critical.reason;
}
```

Inside the live loader, construct the `LiveExchange`, call the resolver, and throw before returning:

```ts
const live: LiveExchange = {
  body,
  status: res.status,
  fetchedAt: this.now().toISOString(),
  ...(expectedEntityScope === undefined ? {} : { entityScope: expectedEntityScope }),
};
const problem = fmpLiveExchangeProblem(spec, live, expectedEntityScope);
if (problem !== null) throw new FmpSchemaValidationError(problem);
return live;
```

Pass the same resolver as the fourth `cachedFetch` argument and map `FmpSchemaValidationError` to the existing warning gap. Keep the existing post-read normalization and critical-row parsing as defense in depth.

```ts
exchange = await this.cachedFetch<LiveExchange>(
  cacheKey,
  ttlMs,
  async () => {
    // existing fetch/parse plus the pre-return validation above
  },
  {
    validateValue: (value) => fmpLiveExchangeProblem(spec, value, expectedEntityScope),
  },
);
```

In `makeFmpCachedFetch`, accept the fourth argument and bridge it onto the generic cache:

```ts
return async <T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  options?: { validateValue?: (value: T) => string | null },
): Promise<CachedFetchResult<T>> => {
  // existing lazy import and options
  const sourced = await cachedFetch<T>({
    provider: "fmp",
    endpoint: key,
    params: {},
    ttlSeconds: Math.max(0, Math.floor(ttlMs / 1000)),
    maxStaleSeconds: PROVIDER_MAX_STALE_SECONDS,
    fetcher: async () => ({ body: await loader(), asOf: new Date().toISOString().slice(0, 10) }),
    ...(options?.validateValue === undefined
      ? {}
      : { validateBody: options.validateValue }),
    isEmptyBody: (value: T): boolean => {
      const inner = (value as { body?: unknown }).body;
      return Array.isArray(inner) && inner.length === 0;
    },
  });
  // preserve the existing envelope reconstruction
};
```

Keep this existing `isEmptyBody` behavior unchanged.

- [ ] **Step 4: Run focused and adjacent tests**

Run:

```powershell
npx vitest run --config vitest.config.ts tests/dataBundle.providerCache.test.ts tests/fmp.client.test.ts tests/db.cache.test.ts
npm run typecheck
```

Expected: PASS with no invalid cache row surviving and no type errors.

- [ ] **Step 5: Commit the FMP admission fix**

```powershell
git add src/providers/fmp.ts src/pipeline/dataBundle.ts tests/dataBundle.providerCache.test.ts
git commit -m "fix: validate FMP bodies before cache admission"
```

---

### Task 2: EDGAR JSON parsing and identity validation before cache admission

**Files:**
- Modify: `src/providers/edgar.ts:542-620, 1193-1325, 1520-1550`
- Test: `tests/edgar.client.test.ts`
- Test: `tests/db.cache.test.ts`

**Interfaces:**
- Consumes: `EdgarTransport.fetchText(..., { validateBody })`, `tickerEntrySchema`, `submissionsSchema`, `companyFactsSchema`, and `sameCik`.
- Produces: internal `BodyParseResult<T>` plus `parseTickerMapBody`, `parseSubmissionsBody`, and `parseCompanyFactsBody`; each parser is used both by `validateBody` and after retrieval.

- [ ] **Step 1: Write malformed-then-valid memory and SQLite cache tests**

Add a helper that returns sequential bodies:

```ts
function sequentialFetch(bodies: string[]): { fetchFn: typeof fetch; calls: () => number } {
  let index = 0;
  const fetchFn = (async () => {
    const body = bodies[Math.min(index, bodies.length - 1)] ?? "";
    index += 1;
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  return { fetchFn, calls: () => index };
}
```

In `tests/edgar.client.test.ts`, cover all three JSON operations:

```ts
it("does not memory-cache malformed EDGAR JSON operations", async () => {
  const validTickers = sample("company_tickers_excerpt.json");
  const validSubmissions = sample("aapl_submissions_truncated.json");
  const validFacts = JSON.stringify({
    cik: 320193,
    entityName: "Apple Inc.",
    facts: {
      "us-gaap": {
        Revenues: {
          label: "Revenues",
          units: { USD: [{ end: "2025-09-27", val: 1, accn: "0000320193-25-000079", fy: 2025, fp: "FY", form: "10-K", filed: "2025-10-31" }] },
        },
      },
    },
  });
  for (const [invoke, valid] of [
    [(client: EdgarClient) => client.tickerToCik("AAPL"), validTickers],
    [(client: EdgarClient) => client.submissions(320193), validSubmissions],
    [(client: EdgarClient) => client.companyFacts(320193), validFacts],
  ] as const) {
    const sequence = sequentialFetch(["{bad json", valid]);
    const client = new EdgarClient({
      transport: createDefaultEdgarTransport({ fetchFn: sequence.fetchFn, maxRps: 1000 }),
    });
    expect((await invoke(client)).ok).toBe(false);
    expect((await invoke(client)).ok).toBe(true);
    expect(sequence.calls()).toBe(2);
  }
});
```

In `tests/db.cache.test.ts`, add the durable-cache proof for submissions:

```ts
it("does not SQLite-cache malformed EDGAR submissions", async () => {
  let call = 0;
  const fetchFn = vi.fn(async () => {
    call += 1;
    return new Response(
      call === 1 ? "{bad json" : readFileSync(path.join(process.cwd(), "fixtures/edgar/aapl_submissions_truncated.json"), "utf8"),
      { status: 200 },
    );
  });
  const client = new EdgarClient({ transport: createDbCachedEdgarTransport({ fetchFn }) });

  expect((await client.submissions(320193)).ok).toBe(false);
  expect((await client.submissions(320193)).ok).toBe(true);
  expect(fetchFn).toHaveBeenCalledTimes(2);
  expect(handle.db.select().from(apiCache).all()).toHaveLength(1);
});
```

Import `EdgarClient` and `readFileSync` where required.

- [ ] **Step 2: Run the focused tests and verify the cache poison**

Run:

```powershell
npx vitest run --config vitest.config.ts tests/edgar.client.test.ts tests/db.cache.test.ts
```

Expected: FAIL because the first HTTP-200 body is cached before the client parses it; the second call does not refetch.

- [ ] **Step 3: Extract operation-owned parsers and wire `validateBody`**

Use one result type:

```ts
type BodyParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string };

function bodyProblem<T>(parse: BodyParseResult<T>): string | null {
  return parse.ok ? null : parse.reason;
}
```

Extract the current JSON/schema/semantic logic into these exact signatures:

```ts
function parseTickerMapBody(body: string): BodyParseResult<Map<string, CikMapping>>;
function parseSubmissionsBody(body: string, expectedCik: string): BodyParseResult<EdgarSubmissions>;
function parseCompanyFactsBody(body: string, expectedCik: string): BodyParseResult<CompanyFacts>;
```

`parseTickerMapBody` must reject invalid JSON, non-record roots, or a map with no valid `tickerEntrySchema` entries. It must retain the existing `normalizeSymbol` filtering so Unicode-expanding aliases remain ignored rather than shadowing valid ASCII entries.

`parseSubmissionsBody` must contain every current post-fetch check: schema, expected CIK, equal parallel arrays, accession/date validity, safe primary-document basename, and admitted-accession construction. Return the fully normalized `EdgarSubmissions` only after all checks pass.

`parseCompanyFactsBody` must check JSON, `companyFactsSchema`, and expected CIK, then return the normalized `CompanyFacts` object.

Wire each operation like this:

```ts
const expectedCik = padCik(cik);
const res = await this.request(
  url,
  EDGAR_TTL.submissions,
  (body) => bodyProblem(parseSubmissionsBody(body, expectedCik)),
);
if (!res.ok) {
  return this.gap(
    `edgar.submissions(${cik})`,
    res.bodyProblem ?? `submissions HTTP ${res.status}`,
    [url],
    res.bodyProblem === undefined ? "warn" : "critical",
  );
}
const parsed = parseSubmissionsBody(res.body, expectedCik);
if (!parsed.ok) return this.gap(`edgar.submissions(${cik})`, parsed.reason, [url], "critical");
const data = parsed.data;
```

Use the corresponding parser in ticker and company-facts operations. Do not remove the post-read parse: it is the defense against a transport implementation that ignores `validateBody`.

- [ ] **Step 4: Run EDGAR, cache, and type tests**

```powershell
npx vitest run --config vitest.config.ts tests/edgar.client.test.ts tests/db.cache.test.ts tests/dataBundle.edgarForms.test.ts
npm run typecheck
```

Expected: PASS, including existing semantic submissions and stale-last-good tests.

- [ ] **Step 5: Commit the EDGAR JSON admission fix**

```powershell
git add src/providers/edgar.ts tests/edgar.client.test.ts tests/db.cache.test.ts
git commit -m "fix: validate EDGAR JSON before cache admission"
```

---

### Task 3: Finnhub insider-sentiment identity and domain enforcement

**Files:**
- Modify: `src/providers/finnhub.ts:45-58, 219-276`
- Modify: `tests/risk.providers.coverage.test.ts:232-390`
- Modify: `tests/dataBundle.providerCache.test.ts:130-190`

**Interfaces:**
- Consumes: requested normalized symbol and ISO `from`/`to` dates.
- Produces: the existing normalized `InsiderSentimentMonth` output after a response schema proves that the discarded provider identity fields are issuer-bound and domain-valid.

- [ ] **Step 1: Add failing issuer/domain tests and update valid fixtures**

Update every syntactically valid sentiment fixture—including empty and retry
responses—to include top-level and row `symbol`. Add:

```ts
it.each([
  ["wrong top-level symbol", { symbol: "MSFT", data: [{ symbol: "MSFT", year: 2026, month: 6, change: 1, mspr: 1 }] }],
  ["wrong row symbol", { symbol: "AAPL", data: [{ symbol: "MSFT", year: 2026, month: 6, change: 1, mspr: 1 }] }],
  ["month 13", { symbol: "AAPL", data: [{ symbol: "AAPL", year: 2026, month: 13, change: 1, mspr: 1 }] }],
  ["fractional month", { symbol: "AAPL", data: [{ symbol: "AAPL", year: 2026, month: 6.5, change: 1, mspr: 1 }] }],
  ["MSPR above range", { symbol: "AAPL", data: [{ symbol: "AAPL", year: 2026, month: 6, change: 1, mspr: 100.01 }] }],
  ["outside requested months", { symbol: "AAPL", data: [{ symbol: "AAPL", year: 2024, month: 12, change: 1, mspr: 1 }] }],
])("rejects insider sentiment with %s", async (_name, body) => {
  const result = await insiderSentiment("AAPL", "2025-01-01", "2026-07-31", {
    ...FAST_FINNHUB,
    fetchImpl: async () => jsonResponse(body),
  });
  expect(result).toMatchObject({ ok: false, gap: { severity: "warn" } });
});

it("accepts Finnhub month and MSPR boundary values", async () => {
  const result = await insiderSentiment("AAPL", "2026-01-01", "2026-12-31", {
    ...FAST_FINNHUB,
    fetchImpl: async () => jsonResponse({
      symbol: "AAPL",
      data: [
        { symbol: "AAPL", year: 2026, month: 1, change: 0, mspr: -100 },
        { symbol: "AAPL", year: 2026, month: 12, change: 0, mspr: 100 },
      ],
    }),
  });
  expect(result.ok).toBe(true);
});
```

In the cache-wrapper suite, add invalid-then-valid behavior and assert two network calls and one cache row.

- [ ] **Step 2: Run the focused tests and prove invalid success**

```powershell
npx vitest run --config vitest.config.ts tests/risk.providers.coverage.test.ts tests/dataBundle.providerCache.test.ts
```

Expected: FAIL because wrong symbols, month 13, and MSPR 100.01 currently produce `ok: true`.

- [ ] **Step 3: Enforce the exact response contract**

Change the row/interface and schema to:

```ts
export interface InsiderSentimentMonth {
  year: number;
  month: number;
  change: number | null;
  mspr: number | null;
}

const insiderSentimentSchema = z.object({
  symbol: z.string().trim().min(1),
  data: z.array(z.object({
    symbol: z.string().trim().min(1),
    year: z.number().int().min(1900).max(2100),
    month: z.number().int().min(1).max(12),
    change: z.number().finite().nullish(),
    mspr: z.number().finite().min(-100).max(100).nullish(),
  }).passthrough()),
}).passthrough();
```

After parsing, validate identity and month scope before sorting:

```ts
if (!sameEntitySymbol(sym, parsed.data.symbol)) {
  return gap(field, `Finnhub symbol ${parsed.data.symbol} did not match requested ${sym}`, "warn", ["finnhub"]);
}
const fromMonth = from.slice(0, 7);
const toMonth = to.slice(0, 7);
for (const row of parsed.data.data) {
  const observationMonth = `${row.year}-${String(row.month).padStart(2, "0")}`;
  if (!sameEntitySymbol(sym, row.symbol)) {
    return gap(field, `Finnhub row symbol ${row.symbol} did not match requested ${sym}`, "warn", ["finnhub"]);
  }
  if (observationMonth < fromMonth || observationMonth > toMonth) {
    return gap(field, `Finnhub observation ${observationMonth} fell outside ${fromMonth}..${toMonth}`, "warn", ["finnhub"]);
  }
}
```

Add `sameEntitySymbol` from `@/symbol` to the provider imports.

Normalize nullish `change`/`mspr` to null. The normalized public month rows may
keep their existing shape after the response and every source row have passed
identity validation. Reject the entire response on one invalid row.

- [ ] **Step 4: Run focused and degradation suites**

```powershell
npx vitest run --config vitest.config.ts tests/risk.providers.coverage.test.ts tests/dataBundle.providerCache.test.ts tests/finra.fred.test.ts tests/degradation.providers.test.ts
npm run typecheck
```

Expected: PASS and successful cached fixtures contain issuer symbols.

- [ ] **Step 5: Commit the Finnhub contract fix**

```powershell
git add src/providers/finnhub.ts tests/risk.providers.coverage.test.ts tests/dataBundle.providerCache.test.ts
git commit -m "fix: bind Finnhub sentiment to issuer and domain"
```

---

### Task 4: Remove all valid EDGAR `display:none` variants

**Files:**
- Modify: `src/edgar/extract.ts:179-205`
- Test: `tests/edgar.extract.test.ts:55-100`

**Interfaces:**
- Consumes: raw filing/exhibit HTML.
- Produces: unchanged `stripHiddenBlocks(html: string): string`, with style-attribute recognition isolated in `hasDisplayNone(openingTag: string): boolean`.

- [ ] **Step 1: Add failing parameterized and hidden-decoy tests**

```ts
it.each([
  ["single quoted", "<div style='display:none'>HIDDEN</div><p>VISIBLE</p>"],
  ["unquoted", "<div style=display:none>HIDDEN</div><p>VISIBLE</p>"],
  ["uppercase and spaced", '<div style="DISPLAY: NONE">HIDDEN</div><p>VISIBLE</p>'],
  ["later declaration", '<div style="color:red; display : none; font-size:1px">HIDDEN</div><p>VISIBLE</p>'],
])("removes %s display-none markup", (_name, html) => {
  expect(htmlToText(stripHiddenBlocks(html))).toBe("VISIBLE");
});

it("does not remove visible content with unrelated display/none text", () => {
  const html = '<div style="display:block" data-note="none">DISPLAY NONE VISIBLE</div>';
  expect(htmlToText(stripHiddenBlocks(html))).toBe("DISPLAY NONE VISIBLE");
});

it("does not let a hidden Item heading win section extraction", () => {
  const html = [
    "<div style='DISPLAY: NONE'><h2>Item 1A. Risk Factors</h2>HIDDEN DECOY</div>",
    `<h2>Item 1A. Risk Factors</h2>${para(3000, "VISIBLE_RISK")}`,
    `<h2>Item 1B. Unresolved Staff Comments</h2>${para(3000, "BOUNDARY")}`,
  ].join("\n");
  const result = extractSection(html, { form: "10-K", item: "1A" });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.text).toContain("VISIBLE_RISK");
    expect(result.text).not.toContain("HIDDEN DECOY");
  }
});
```

- [ ] **Step 2: Run extraction tests and confirm hidden text survives**

```powershell
npx vitest run --config vitest.config.ts tests/edgar.extract.test.ts
```

Expected: FAIL for single-quoted, unquoted, and uppercase/spaced cases.

- [ ] **Step 3: Implement quote-aware style detection without broad text matching**

Add:

```ts
function hasDisplayNone(openingTag: string): boolean {
  const style = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(openingTag);
  const declarations = style?.[1] ?? style?.[2] ?? style?.[3];
  if (declarations === undefined) return false;
  return declarations
    .split(";")
    .some((declaration) => /^\s*display\s*:\s*none\s*$/i.test(declaration));
}
```

Replace the style-specific opening-tag regex with a general opening-tag scan and
gate the existing balanced removal on the helper:

```ts
const openRe = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
// inside the existing while loop, before writing to `parts`:
if (!hasDisplayNone(m[0])) continue;
```

This applies to paired blocks and self-closing elements. Retain the existing
stack/depth behavior for nested hidden blocks and the linear-time test. Do not
run the style regex against text nodes.

- [ ] **Step 4: Run extraction and EDGAR client suites**

```powershell
npx vitest run --config vitest.config.ts tests/edgar.extract.test.ts tests/edgar.client.test.ts
npm run typecheck
```

Expected: PASS, including the existing 3,500-hidden-tag performance bound.

- [ ] **Step 5: Commit the hidden-content fix**

```powershell
git add src/edgar/extract.ts tests/edgar.extract.test.ts
git commit -m "fix: remove hidden EDGAR style variants"
```

---

### Task 5: Preserve provider observation dates for earnings and company facts

**Files:**
- Modify: `src/edgar/xbrl.ts:61-75, 518-530`
- Modify: `src/providers/edgar.ts:1520-1550`
- Modify: `src/pipeline/dataBundle.ts:575-605`
- Test: `tests/edgar.xbrl.test.ts`
- Test: `tests/edgar.client.test.ts`
- Test: `tests/dataBundle.earnings.test.ts`

**Interfaces:**
- Consumes: parsed `CompanyFacts`, a fetch-date ISO string, and an upstream earnings `Sourced<FmpPayload<FmpEarningsRow>>`.
- Produces: `latestEligibleCompanyFactEnd(facts, notAfterIso): string | null`; derived earnings with upstream `asOf` and future event in `data.date`.

- [ ] **Step 1: Add failing pure date and envelope tests**

In `tests/edgar.xbrl.test.ts`:

```ts
it("finds the newest eligible core-form fact end not after the fetch date", () => {
  const companyFacts = facts({
    Revenues: [
      pt({ end: "2025-09-27", val: 1, form: "10-K" }),
      pt({ end: "2025-12-31", val: 2, form: "DEF 14A" }),
      pt({ end: "2099-12-31", val: 3, form: "10-Q" }),
      pt({ end: "2026-03-28", val: 4, form: "10-Q" }),
    ],
  });
  expect(latestEligibleCompanyFactEnd(companyFacts, "2026-08-09")).toBe("2026-03-28");
});

it("returns null when company facts have no eligible period end", () => {
  const companyFacts = facts({
    Revenues: [pt({ end: "not-a-date", val: 1, form: "10-K" })],
  });
  expect(latestEligibleCompanyFactEnd(companyFacts, "2026-08-09")).toBeNull();
});
```

Add `latestEligibleCompanyFactEnd` to the existing `@/edgar/xbrl` import list.

In `tests/edgar.client.test.ts`, add a company-facts response fetched at
`2026-07-06T12:00:00.000Z` whose newest core fact ends `2025-09-27`; expect
`value.asOf === "2025-09-27"` and
`value.fetchedAt === "2026-07-06T12:00:00.000Z"`. Add an invalid-then-valid
`createDefaultEdgarTransport` case whose first body has no eligible facts and
whose second body has the 2025 10-K fact; expect the first call to be a gap, the
second to succeed, and the fetch count to equal two.

In `tests/dataBundle.earnings.test.ts`, change the first test and add stale propagation:

```ts
expect(result.ok).toBe(true);
if (result.ok) {
  expect(result.value.asOf).toBe("2026-07-05");
  expect(result.value.data.date).toBe("2026-08-01T00:00:00Z");
}

const staleInput = earnings([{ date: "2026-09-01", epsActual: null }]);
if (staleInput.ok) staleInput.value.stale = true;
const staleResult = deriveNextEarnings(staleInput, "2026-07-06", "AAPL");
expect(staleResult).toMatchObject({ ok: true, value: { asOf: "2026-07-05", stale: true } });
```

- [ ] **Step 2: Run date tests and confirm future/fetch-date mislabeling**

```powershell
npx vitest run --config vitest.config.ts tests/edgar.xbrl.test.ts tests/edgar.client.test.ts tests/dataBundle.earnings.test.ts
```

Expected: FAIL because next earnings uses the future event date and company facts uses `fetchedAt.slice(0, 10)`.

- [ ] **Step 3: Implement a pure latest eligible fact resolver**

In `src/edgar/xbrl.ts`, add:

```ts
function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

export function latestEligibleCompanyFactEnd(
  facts: CompanyFacts,
  notAfterIso: string,
): string | null {
  if (!isIsoCalendarDate(notAfterIso)) return null;
  let latest: string | null = null;
  for (const namespace of Object.values(facts.facts)) {
    for (const rawConcept of Object.values(namespace)) {
      const concept = conceptFactsSchema.safeParse(rawConcept);
      if (!concept.success) continue;
      for (const rawPoints of Object.values(concept.data.units)) {
        for (const rawPoint of rawPoints) {
          const point = factPointSchema.safeParse(rawPoint);
          if (!point.success) continue;
          const end = point.data.end;
          if (!CORE_FACT_FORMS.has(point.data.form.trim())) continue;
          if (!isIsoCalendarDate(end) || end > notAfterIso) continue;
          if (latest === null || end > latest) latest = end;
        }
      }
    }
  }
  return latest;
}
```

In `src/providers/edgar.ts`, add a temporal admission wrapper around Task 2's
parser:

```ts
function companyFactsTemporalBodyProblem(
  body: string,
  expectedCik: string,
  notAfterIso: string,
): string | null {
  const parsed = parseCompanyFactsBody(body, expectedCik);
  if (!parsed.ok) return parsed.reason;
  return latestEligibleCompanyFactEnd(parsed.data, notAfterIso) === null
    ? "companyfacts had no eligible core-form fact period"
    : null;
}
```

Capture `requestDate = new Date().toISOString().slice(0, 10)` before calling
`this.request` and supply this wrapper as `validateBody`; this prevents an
empty/future-only body from entering either cache. After retrieval, call
`latestEligibleCompanyFactEnd(facts, res.fetchedAt.slice(0, 10))`. Return a
warning data-quality gap if it returns null; otherwise pass the result to
`this.sourced` as `asOf`.

In `deriveNextEarnings`, replace `asOf: next.date` with:

```ts
asOf: earnings.value.asOf,
```

Do not alter `next.row.date`, `fetchedAt`, endpoint lineage, or stale propagation.

- [ ] **Step 4: Run date, bundle, manifest, and type tests**

```powershell
npx vitest run --config vitest.config.ts tests/edgar.xbrl.test.ts tests/edgar.client.test.ts tests/dataBundle.earnings.test.ts tests/stageA.manifest.test.ts tests/dataBundle.producerRegistry.test.ts
npm run typecheck
```

Expected: PASS with period, event, observation, and fetch timestamps distinct.

- [ ] **Step 5: Commit the observation-date fix**

```powershell
git add src/edgar/xbrl.ts src/providers/edgar.ts src/pipeline/dataBundle.ts tests/edgar.xbrl.test.ts tests/edgar.client.test.ts tests/dataBundle.earnings.test.ts
git commit -m "fix: preserve provider observation dates"
```

---

### Task 6: Include cache stale state in Stage A fundamentals freshness

**Files:**
- Modify: `src/pipeline/stageA/validate.ts:621-675`
- Test: `tests/stageA.validate.test.ts:751-782`

**Interfaces:**
- Consumes: successful `incomeAnnual` and `incomeQuarterly` envelopes and the existing fiscal-cadence result.
- Produces: `staleness.fundamentals` status `pass`, `warn`, `fail`, or `skipped` with a matching typed gap/flag.

- [ ] **Step 1: Add failing stale-envelope tests and a fresh control**

```ts
it("warns when a recent contributing annual statement was served stale", () => {
  const staleAnnual = ok(
    { rows: annualIncomeRows() },
    "2025-09-27",
    { stale: true, staleReason: "empty-refresh-preserved" },
  );
  const { report, check: c } = check(
    makeBundle({ incomeAnnual: staleAnnual }),
    "staleness.fundamentals",
  );
  expect(c.status).toBe("warn");
  expect(c.detail).toMatch(/incomeAnnual|served past TTL|stale/i);
  expect(report.gaps).toContainEqual(expect.objectContaining({
    field: "validation.staleness.fundamentals",
    severity: "warn",
  }));
});

it("warns when the newest quarterly statement was served stale", () => {
  const staleQuarterly = ok(
    { rows: quarterlyIncomeRows() },
    "2026-03-28",
    { stale: true },
  );
  const { check: c } = check(
    makeBundle({ incomeQuarterly: staleQuarterly }),
    "staleness.fundamentals",
  );
  expect(c.status).toBe("warn");
});

it("keeps a recent non-stale fundamentals result as pass", () => {
  expect(check(makeBundle(), "staleness.fundamentals").check.status).toBe("pass");
});
```

- [ ] **Step 2: Run Stage A tests and prove stale inputs pass incorrectly**

```powershell
npx vitest run --config vitest.config.ts tests/stageA.validate.test.ts
```

Expected: FAIL because both stale-envelope cases currently return `pass`.

- [ ] **Step 3: Aggregate contributing stale envelopes into the check**

Inside `checkStaleness`, derive labels only from successful inputs:

```ts
const staleFundamentalInputs = [
  ["incomeAnnual", bundle.statements.incomeAnnual] as const,
  ["incomeQuarterly", bundle.statements.incomeQuarterly] as const,
].flatMap(([name, result]) => result.ok && result.value.stale === true ? [name] : []);
```

When a statement end exists, choose status in this order:

```ts
const status: ValidationCheck["status"] = stale
  ? "fail"
  : staleFundamentalInputs.length > 0
    ? "warn"
    : "pass";
```

Append the stale input names to `detail`. If the period is current but cache inputs are stale, add one `warn` gap and a `STALE FUNDAMENTALS CACHE` flag. If the period is already stale, retain the existing `fail` gap and include the cache-stale names without duplicating the same gap field.

- [ ] **Step 4: Run Stage A and manifest suites**

```powershell
npx vitest run --config vitest.config.ts tests/stageA.validate.test.ts tests/stageA.manifest.test.ts
npm run typecheck
```

Expected: PASS with source manifest and Stage A freshness no longer contradicting each other.

- [ ] **Step 5: Commit the freshness fix**

```powershell
git add src/pipeline/stageA/validate.ts tests/stageA.validate.test.ts
git commit -m "fix: disclose stale fundamental cache inputs"
```

---

### Task 7: Distinguish valid empty FINRA rows from malformed responses

**Files:**
- Modify: `src/providers/finra.ts:178-215, 400-475`
- Test: `tests/finra.fred.test.ts:198-280`
- Test: `tests/risk.providers.coverage.test.ts:393-540`

**Interfaces:**
- Consumes: FINRA row payloads from the data endpoint.
- Produces: `parseShortInterestRows([]) === []`; existing informational no-row gaps in `shortInterest` and `shortInterestTrend` become reachable.

- [ ] **Step 1: Add failing parser and provider-path tests**

```ts
it("returns an empty array for a valid empty FINRA payload", () => {
  expect(parseShortInterestRows([])).toEqual([]);
});
```

In the FINRA adapter suite:

```ts
it("reports valid empty FINRA data as informational no-data", async () => {
  const fetchImpl = async (input: string | URL): Promise<Response> =>
    String(input).includes("/partitions/")
      ? jsonResponse({ availablePartitions: [{ partitions: ["2026-06-30"] }] })
      : jsonResponse([]);

  const latest = await shortInterest("AAPL", { ...FAST_FINRA, fetchImpl });
  const trend = await shortInterestTrend("AAPL", 12, { ...FAST_FINRA, fetchImpl });

  expect(latest).toMatchObject({
    ok: false,
    gap: { severity: "info", reason: expect.stringMatching(/no FINRA short interest row/i) },
  });
  expect(trend).toMatchObject({
    ok: false,
    gap: { severity: "info", reason: expect.stringMatching(/no FINRA short interest rows/i) },
  });
});
```

Retain the existing malformed-object test as the negative control.

- [ ] **Step 2: Run FINRA tests and confirm empty is mislabeled malformed**

```powershell
npx vitest run --config vitest.config.ts tests/finra.fred.test.ts tests/risk.providers.coverage.test.ts
```

Expected: FAIL because `parseShortInterestRows([])` returns `null` and both provider paths report a warning about unrecognized shape.

- [ ] **Step 3: Return `[]` before the nonempty-row guard**

At the start of the direct-array branch in `parseShortInterestRows`, add:

```ts
if (Array.isArray(payload) && payload.length === 0) return [];
```

Leave malformed non-array and invalid nonempty-array behavior unchanged. No caller change is needed: both callers already test for an empty scoped result and create the correct informational gaps.

- [ ] **Step 4: Run FINRA, cache-wrapper, and type tests**

```powershell
npx vitest run --config vitest.config.ts tests/finra.fred.test.ts tests/risk.providers.coverage.test.ts tests/dataBundle.providerCache.test.ts
npm run typecheck
```

Expected: PASS and valid empty responses remain distinct from malformed responses.

- [ ] **Step 5: Commit the FINRA empty-state fix**

```powershell
git add src/providers/finra.ts tests/finra.fred.test.ts tests/risk.providers.coverage.test.ts
git commit -m "fix: preserve valid empty FINRA responses"
```

---

### Task 8: Verify the complete provider/temporal workstream and record evidence

**Files:**
- Create: `docs/superpowers/audits/2026-08-09-provider-temporal-integrity-verification.md`
- Verify only: all files changed in Tasks 1-7

**Interfaces:**
- Consumes: the eight design findings and every focused regression from Tasks 1-7.
- Produces: a finding-by-finding evidence matrix and fresh full-repository verification output.

- [ ] **Step 1: Run all focused adversarial suites together**

```powershell
npx vitest run --config vitest.config.ts tests/dataBundle.providerCache.test.ts tests/fmp.client.test.ts tests/db.cache.test.ts tests/edgar.client.test.ts tests/edgar.extract.test.ts tests/edgar.xbrl.test.ts tests/dataBundle.earnings.test.ts tests/stageA.validate.test.ts tests/stageA.manifest.test.ts tests/finra.fred.test.ts tests/risk.providers.coverage.test.ts
```

Expected: all focused files and tests pass with no unexpected stderr.

- [ ] **Step 2: Run mutation probes for each repaired invariant**

Temporarily mutate one value at a time in the test data—not production code—and confirm the relevant test fails for the intended assertion:

```text
FMP price: 201 -> "bad"
EDGAR submissions CIK: 0000320193 -> 0000789019
Finnhub row symbol: AAPL -> MSFT
EDGAR style: display:none -> display:block (visible control)
company-fact form: 10-K -> DEF 14A
earnings source asOf: 2026-07-05 -> 2026-07-04
statement stale: true -> false
FINRA payload: [] -> { error: "bad" }
```

Restore each test immediately after confirming the expected failure. Run `git diff --check` afterward; only intentional final changes may remain.

- [ ] **Step 3: Run the repository verification contract**

```powershell
npm ci
npm run check:dependencies
npm run typecheck
npx eslint . --ignore-pattern ".worktrees/**"
npm run test:product -- --reporter=dot
npm run test:integration -- --reporter=dot
npm run test:coverage
npm run build
npm run audit:security
git diff --check
```

Expected: every command exits 0. The explicit lint ignore is temporary evidence until workstream 4 fixes the repository-level lint scope; do not claim `npm run verify` itself passes unless that later fix is present.

- [ ] **Step 4: Run an isolated production smoke test**

Start the built server with a temporary database under `$env:TEMP`, blank provider/model credentials, and a non-user port. Verify:

```text
GET /                 -> 200 HTML containing "Thesis"
GET /report/sample    -> 200 HTML containing "SYNTHETIC" and "Informational only"
GET /settings         -> 200 HTML containing "Settings"
GET /api/settings     -> 200 JSON
GET /api/watchlist    -> 200 JSON
```

Use this PowerShell harness:

```powershell
$smokeRoot = Join-Path $env:TEMP ("thesis-provider-smoke-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $smokeRoot | Out-Null
$env:THESIS_DB_PATH = Join-Path $smokeRoot "smoke.db"
$env:FMP_API_KEY = ""
$env:FRED_API_KEY = ""
$env:FINNHUB_API_KEY = ""
$env:ANTHROPIC_API_KEY = ""
$port = Get-Random -Minimum 31000 -Maximum 32000
while (Test-NetConnection -ComputerName 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue) {
  $port = Get-Random -Minimum 31000 -Maximum 32000
}
$stdout = Join-Path $smokeRoot "stdout.log"
$stderr = Join-Path $smokeRoot "stderr.log"
$server = Start-Process -FilePath node -ArgumentList @(
  "node_modules/next/dist/bin/next", "start", "-p", [string]$port
) -WorkingDirectory (Get-Location) -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $stdout -RedirectStandardError $stderr
try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
      $probe = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 2
      if ($probe.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
  }
  if (-not $ready) { throw "production server did not become ready" }
  $routes = @(
    @{ Path="/"; Marker="Thesis" },
    @{ Path="/report/sample"; Marker="SYNTHETIC" },
    @{ Path="/settings"; Marker="Settings" },
    @{ Path="/api/settings"; Marker="analysis" },
    @{ Path="/api/watchlist"; Marker="watchlist" }
  )
  foreach ($route in $routes) {
    $response = Invoke-WebRequest -Uri ("http://127.0.0.1:$port" + $route.Path) -UseBasicParsing -TimeoutSec 15
    if ($response.StatusCode -ne 200 -or $response.Content -notmatch [regex]::Escape($route.Marker)) {
      throw "smoke failure at $($route.Path)"
    }
  }
  if ((Get-Content -Raw $stderr).Trim().Length -gt 0) { throw "production stderr was not empty" }
} finally {
  if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force }
}
if (Test-NetConnection -ComputerName 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue) {
  throw "production smoke port remained open"
}
$resolvedSmoke = [IO.Path]::GetFullPath($smokeRoot)
$resolvedTemp = [IO.Path]::GetFullPath($env:TEMP).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $resolvedSmoke.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFileName($resolvedSmoke) -notlike "thesis-provider-smoke-*") {
  throw "refusing to remove unverified smoke directory"
}
Remove-Item -LiteralPath $resolvedSmoke -Recurse -Force
```

Stop the exact spawned process and verify the port is closed. Never use the
default database path for this smoke test.

- [ ] **Step 5: Write the evidence matrix**

Create the audit file with one row per finding and the exact test names below:

```markdown
| ID | Invariant | Production boundary | Regression |
|---|---|---|---|
| P1 | Finnhub issuer/domain | `src/providers/finnhub.ts` | `rejects insider sentiment with wrong top-level symbol` |
| P2 | EDGAR hidden content | `src/edgar/extract.ts` | `removes single quoted display-none markup` |
| P3 | FMP pre-cache schema | `src/providers/fmp.ts` | `rejects schema-invalid FMP 200s before cache admission and refetches` |
| P4 | EDGAR pre-cache JSON | `src/providers/edgar.ts` | `does not SQLite-cache malformed EDGAR submissions` |
| P5 | Stage A cache stale | `src/pipeline/stageA/validate.ts` | `warns when a recent contributing annual statement was served stale` |
| P6 | Earnings observation time | `src/pipeline/dataBundle.ts` | `ignores malformed dates instead of treating them as future events` |
| P7 | Company-fact observation time | `src/edgar/xbrl.ts` | `finds the newest eligible core-form fact end not after the fetch date` |
| P8 | FINRA valid empty | `src/providers/finra.ts` | `reports valid empty FINRA data as informational no-data` |
```

After the table, record the exact focused and full-gate commands, exit codes,
test counts, commit range, environment, Node/npm versions, and any expected
skipped tests. Do not write a successful result from memory.

- [ ] **Step 6: Commit the verification evidence**

```powershell
git add docs/superpowers/audits/2026-08-09-provider-temporal-integrity-verification.md
git commit -m "docs: verify provider temporal integrity"
```

- [ ] **Step 7: Review repository state**

```powershell
git status --short
git log --oneline -10
git diff c36a9b6 --check
```

Expected: clean status, intentional task commits only, and no whitespace errors.
