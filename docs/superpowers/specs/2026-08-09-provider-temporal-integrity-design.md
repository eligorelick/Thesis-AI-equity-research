# Provider and Temporal Integrity Remediation Design

**Date:** 2026-08-09

**Audited commit:** `7b2eb51`

**Workstream:** 1 of 4

## Goal

Ensure that provider data enters the research pipeline only when its entity,
shape, domain, observation date, and cache suitability are proven. Invalid,
ambiguous, stale, or empty data must produce an accurate typed gap and must not
be cached as usable evidence.

This is the first of four ordered remediation workstreams:

1. provider identity, cache admission, dates, and freshness;
2. financial calculations, currencies, ADRs, and scenario consistency;
3. AI evidence provenance, claim safety, grades, and recommendation controls;
4. charts, formatting, lint scope, and final end-to-end verification.

The later workstreams depend on this one because financial and AI controls
cannot be reliable when the input boundary misstates identity, validity, or
time.

## Scope

This workstream corrects the following reproduced defects:

1. Finnhub insider sentiment accepts a wrong issuer, invalid month/year values,
   and MSPR outside its documented range.
2. EDGAR extraction retains valid `display:none` variants that use single
   quotes, unquoted attributes, capitalization, or spacing.
3. FMP admits schema-invalid HTTP-200 payloads to memory or SQLite cache before
   endpoint validation.
4. EDGAR tickers, submissions, and company-facts endpoints admit malformed or
   schema-invalid HTTP-200 bodies to cache before parsing and identity checks.
5. Stage A can label cached-stale financial statements as fresh because it
   checks fiscal-period recency but ignores the contributing envelopes' stale
   state.
6. the derived next-earnings datum replaces its observation date with the
   future event date.
7. EDGAR company facts uses the fetch date instead of the newest eligible fact
   period as its observation date.
8. FINRA treats a valid empty row array as malformed, making the existing
   informational no-data branch unreachable.

The workstream also protects the existing identity checks added in the earlier
audit remediation. It does not redesign provider clients, add data vendors,
perform FX conversion, change valuation formulas, alter LLM report schemas, or
modify chart presentation.

## Success criteria

A finding is complete only when all of the following are true:

1. the root cause is removed at the earliest reliable boundary;
2. a focused regression test fails against commit `7b2eb51` for the intended
   reason and passes after the fix;
3. invalid data cannot enter either memory cache or SQLite cache;
4. stale last-good fallback remains available only where the existing cache
   contract already permits it and its `stale` flag remains visible;
5. the returned typed gap accurately distinguishes invalid, unavailable, and
   valid-empty data;
6. downstream `sourceManifest` entries preserve observation time separately
   from event or fiscal period;
7. existing stored reports and database rows remain readable;
8. the focused provider suites and the repository's full verification contract
   pass from a clean install.

## Design principles

### Validate before admission

Transport success is not data success. An HTTP 200 is cacheable only after the
operation-specific parser proves JSON syntax, schema, requested-entity
identity, and any load-bearing domain constraints. Retrieval performs a
defense-in-depth validation so a legacy or corrupted cache row cannot bypass
the contract.

### Preserve identity and time together

Every successful `Sourced<T>` envelope retains the requested entity, provider,
endpoint, observation `asOf`, fetch timestamp, and stale state. A future event
date or a recent fetch timestamp never substitutes for the date the underlying
financial information describes.

### Missing, empty, and invalid are different states

A valid empty provider result means no observations were returned. It is not a
schema failure. Conversely, a malformed or wrong-entity response is never
treated as an empty result and never becomes a favorable zero.

### Fail closed without discarding last-good evidence

New invalid bodies are rejected. When the existing cache layer has a valid
last-good value inside its hard-stale window, it may return that value with
`stale: true`; otherwise the client emits a typed gap. The remediation does not
invent a replacement value.

## Architecture

### 1. Operation-owned cache admission

Provider operations remain responsible for interpreting their own response.
The cache adapters remain generic and accept a validator supplied by the
operation.

For FMP, extend `CachedFetchFn` with an optional semantic validator for the
cached `LiveExchange`. `makeFmpCachedFetch` passes it to the existing
`apiCache.cachedFetch.validateBody` hook. The live loader performs entity
validation, row normalization, and the endpoint's critical Zod schema before it
returns; this ensures a newly fetched invalid body throws a typed FMP validation
error before cache admission. The same pure validator runs on decoded cache
hits so a pre-remediation or corrupted entry is evicted and synchronously
refetched. The cache may continue storing the raw `LiveExchange`, preserving
raw-response diagnostics and the current cache format. Noncritical endpoints
keep their documented permissiveness unless they already define a schema; this
change must not impose an unrelated blanket schema migration.

For EDGAR, every JSON operation supplies `validateBody` to the transport:

- tickers: JSON parse plus ticker-map schema;
- submissions: JSON parse, submissions schema, and requested ten-digit CIK;
- company facts: JSON parse, company-facts schema, and requested ten-digit CIK.

`createDefaultEdgarTransport` and `createDbCachedEdgarTransport` already reject
a body when `validateBody` returns a problem. The operations will use that hook
before either memory or SQLite admission, then retain their existing parse and
identity checks after retrieval. Filing text continues to use its existing
semantic body validator.

Validation failures do not poison a cold cache. A malformed-then-valid sequence
must perform a second provider request and succeed. A failed refresh may reuse
only a previously validated last-good row under the existing stale policy.

### 2. Finnhub insider-sentiment contract

Replace the shape-only sentiment schema with a response schema that retains the
top-level symbol and validates every row:

- top-level symbol is required and must equal the normalized requested symbol;
- every row symbol is required and must also match;
- `year` is an integer from 1900 through 2100, and the resulting observation
  month must fall within the inclusive requested `from`/`to` months;
- `month` is an integer from 1 through 12;
- `mspr` is nullable, finite, and within `[-100, 100]`;
- `change` is nullable and finite.

Reject the whole response on any identity or domain violation. Do not filter
bad rows out of a mixed response, because that would conceal provider drift.
Only a fully valid successful result reaches
`makeCachedFinnhubInsiderSentiment`. Its `asOf` is the latest valid observation
month represented as that month's first day, matching the current monthly-data
convention.

### 3. EDGAR hidden-content removal

Keep `stripHiddenBlocks` as the single preprocessing boundary used by filing
and exhibit extraction, but replace its double-quote/lowercase-only style match
with attribute parsing that recognizes:

- double-quoted, single-quoted, and unquoted `style` values;
- case-insensitive `display` and `none` tokens;
- optional whitespace around the colon;
- semicolon-delimited declarations where `display:none` is not first.

Remove the entire hidden element block before `htmlToText` and before section
heading selection. Existing `hidden` attributes and hidden-tag handling remain
intact. The implementation must not delete visible content merely containing
the words `display` or `none` outside a style declaration.

### 4. Observation-date semantics

`Sourced.asOf` continues to mean the date of the underlying observation, not
the fetch date and not a future event period.

For `deriveNextEarnings`:

- keep the selected future event date in `value.data.date`;
- preserve `earnings.value.asOf` in the derived envelope;
- preserve `fetchedAt`, endpoint lineage, provider, and stale state.

For EDGAR company facts:

- derive `asOf` from the maximum eligible fact `end` date in the parsed facts;
- eligibility requires a valid ISO date no later than `fetchedAt` and one of
  the existing `CORE_FACT_FORMS`: `10-K`, `10-Q`, `10-K/A`, `10-Q/A`, `20-F`,
  or `20-F/A`;
- do not use future frames, malformed dates, or a fetch timestamp as the fact
  observation date;
- if no eligible fact end exists, return a typed data-quality gap rather than a
  successful envelope that appears current;
- retain the actual network/cache fetch time in `fetchedAt`.

The source manifest consumes these envelopes without reconstructing either
date.

### 5. Stage A freshness aggregation

Fundamentals freshness combines two independent facts:

1. fiscal-period recency, using the newest qualifying statement end; and
2. cache freshness, using the `stale` flag on the successful
   `incomeAnnual`/`incomeQuarterly` envelopes from which
   `newestStatementEnd` selects its qualifying rows.

The result is:

- `pass` only when fiscal periods are recent enough and all contributing
  envelopes are not stale;
- `warn` when fiscal periods are recent but at least one contributing envelope
  is stale;
- the existing stale-period severity when the newest period itself is old;
- not-checkable when no qualifying statement period exists.

The warning names the stale provider inputs, appears in gaps, and agrees with
the source manifest. A stale flag is never cleared merely because a statement's
fiscal year is recent.

### 6. FINRA valid-empty semantics

`parseShortInterestRows` returns:

- `[]` for a valid empty array;
- parsed points for a valid nonempty array or recognized wrapper;
- `null` for an unrecognized or malformed payload.

Both FINRA request paths then reach their existing informational no-row branch
for `[]`. Malformed non-array bodies remain warnings. Cache behavior for a
valid empty FINRA result remains unchanged because empty is a legitimate
provider observation, not a transport failure.

## Data flow

```text
HTTP response
  -> operation parser + schema + expected-entity/domain validation
  -> cache admission only on success
  -> defense-in-depth validation after cache retrieval
  -> Sourced<T> with observation asOf, fetchedAt, endpoint, provider, stale
  -> DataBundle and sourceManifest
  -> Stage A freshness checks
  -> later finance and AI workstreams
```

Hidden EDGAR content follows a parallel text path:

```text
filing HTML
  -> semantic body admission
  -> stripHiddenBlocks
  -> htmlToText / heading selection
  -> visible filing evidence only
```

## Error handling and compatibility

- Provider and validation failures remain `FetchResult` gaps; no new exception
  crosses `buildDataBundle`.
- Wrong-entity responses use an identity-mismatch reason. Syntax/schema/domain
  failures use a schema-drift or malformed-response reason. Valid empty FINRA
  uses the existing informational no-data reason.
- Invalid new bodies are never written over last-good cache entries.
- Existing cache tables and keys require no migration. Post-read validation
  prevents an old invalid entry from becoming trusted; the next successful
  refresh replaces it through normal cache behavior.
- No saved-report schema changes are required.
- Existing endpoint attribution and stale flags remain additive and backward
  compatible.

## Test strategy

Every production change follows red-green-refactor:

1. add the minimal regression;
2. run it against `7b2eb51` and confirm the intended failure;
3. implement one boundary fix;
4. rerun the focused test and adjacent provider suite;
5. run mutation cases that could recreate the old behavior.

Required regressions are:

### Finnhub

- requested AAPL with top-level MSFT;
- matching top-level symbol with a mismatched row symbol;
- month 0 and 13, fractional month/year, and MSPR outside both range limits;
- valid boundary values for months 1/12 and MSPR -100/100;
- invalid response is not cached; a following valid response refetches.

### EDGAR extraction and JSON admission

- single-quoted, unquoted, uppercase, spaced, and multi-declaration
  `display:none` blocks are removed;
- a visible style containing unrelated `display`/`none` text remains;
- a hidden decoy Item heading cannot win `extractSection` selection;
- malformed-then-valid tickers, submissions, and company-facts bodies refetch;
- schema-invalid and wrong-CIK bodies are not admitted;
- a stale last-good body is returned only with `stale: true` when the existing
  hard-stale policy permits it.

### Time and freshness

- a next event dated 2026-09-01 from an envelope observed 2026-08-09 preserves
  `asOf: 2026-08-09` and keeps `data.date: 2026-09-01`;
- company facts fetched in 2026 with newest eligible fact ending in 2025 uses
  the 2025 date as `asOf` and the 2026 timestamp as `fetchedAt`;
- malformed/future-only company-fact dates produce a gap;
- a recent statement period with any contributing `stale: true` envelope does
  not pass Stage A freshness;
- recent non-stale and old-period controls preserve existing outcomes.

### FINRA

- `[]` reaches the informational no-row result;
- valid wrapper/nonempty cases remain successful;
- malformed objects and non-arrays remain warnings.

## Verification contract

This workstream is not complete until fresh output proves:

- every required regression failed before its fix and passes afterward;
- all provider, cache, EDGAR extraction, data-bundle, and Stage A suites pass;
- `npm run typecheck` passes;
- application-source lint passes and the later tooling workstream makes the
  repository-level lint command immune to local `.worktrees` artifacts;
- product, integration, risk-coverage, build, dependency, and security gates
  pass;
- an isolated production smoke test still serves the report and settings/API
  routes without using the user's normal database or provider credentials;
- `git diff --check` and repository status show only intentional changes.

Passing the current test suite alone is insufficient: completion requires the
adversarial cases above and a finding-by-finding evidence matrix.

## External contract basis

- Finnhub's official OpenAPI definition for `/stock/insider-sentiment` includes
  response and row symbol identity and documents MSPR in `[-100, 100]`.
- SEC submissions and company-facts endpoints are scoped by ten-digit CIK, and
  company facts carry fiscal period-end dates separately from retrieval time.
- The project's `Sourced<T>` contract defines `asOf` as the datum's observation
  date and `fetchedAt` as transport/cache retrieval time.
