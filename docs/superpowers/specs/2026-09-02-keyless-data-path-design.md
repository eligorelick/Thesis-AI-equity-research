# Keyless data path — design

**Date:** 2026-09-02
**Status:** implemented on `feat/keyless-data-path` (2026-09-02). Live keyless verification, no FMP key, isolated data directory: AAPL resolved through EDGAR; six statement members from company facts, prices from Yahoo, profile/enterprise values/market-cap history computed; forensics, multiples, a DCF and the composite score produced; free cash flow, capex intensity, operating margins, net debt and technicals identical to the FMP-based run, with ten fiscal years of history where the entry-tier FMP plan served five. JPM took the bank route with return on tangible common equity and the excess-return valuation. A fictional ticker rendered the not-found page. Deviations from this design: the fallback gate is issuer identity (EDGAR-sourced CIK, registrant, or company facts) rather than "a CIK exists", because the fixtures carry placeholder CIKs; the SPY and sector-ETF fallbacks also run for keyed plans without issuer confirmation; the profile does not carry a fiscal year end; total debt includes lease obligations to match FMP; bank cash and interest tags were added; current ROE falls back to the DuPont figure; financial routes skip cost-of-debt inference; `isEtf`/`isFund` come from Yahoo's `instrumentType` rather than from a "no core forms on file" rule, which would have marked 40-F filers and newly listed issuers unsupported; `cashAndShortTermInvestments` sums whichever of cash and short-term investments a filer tags, rather than requiring both; the debt chains record which tag won each field and net out three us-gaap overlaps (combined debt-and-leases against a separate finance-lease tag, the `LongTermDebt` total against `LongTermDebtCurrent`, and `CommercialPaper` inside `ShortTermBorrowings`) so `totalDebt` counts each obligation once, with the composition in the row notes.

**Original status:** approved for implementation (owner directive of 2026-09-02: "make sure it works if users don't have an FMP subscription")
**Plan:** [`../plans/2026-09-02-keyless-data-path.md`](../plans/2026-09-02-keyless-data-path.md)

## Problem

Without `FMP_API_KEY`, the pipeline serves only the two fictional fixtures
(`DEMO`, `DBNK`); every real ticker renders as unknown. With an entry-tier
key, FMP refuses some endpoints outright and some symbols (the SPDR sector
ETFs) on price history. A user without a paid subscription therefore gets no
report at all, even though every statement the analyzer needs is public.

The goal: a complete deterministic report for any US-listed SEC registrant
with no paid data subscription, from public sources, with the same
provenance, validation and disclosed-gap discipline the FMP path has.

## Sources

| Need | Keyless source | Requirement |
| --- | --- | --- |
| Ticker → CIK, name, SIC, exchange, fiscal year end | SEC EDGAR `company_tickers.json` + submissions | `EDGAR_CONTACT` (truthful identity, already required) |
| Income statement, balance sheet, cash flow (annual + quarterly) | SEC EDGAR XBRL `companyfacts` | same |
| Shares outstanding, public float | `dei:EntityCommonStockSharesOutstanding`, `dei:EntityPublicFloat` | same |
| Daily OHLCV for the symbol, SPY and the sector ETF; quote | Yahoo Finance chart endpoint (`query1.finance.yahoo.com/v8/finance/chart/<symbol>`) | none; a browser-style `User-Agent` is mandatory (429 without) |
| Risk-free rate, macro | FRED CSV (already keyless) | none |
| Equity risk premium | `ERP_FALLBACK` constant (already exists, dated) | none |

Not available keylessly and left as disclosed gaps: analyst estimates and
price targets, grades consensus, peers, insider trades and statistics, 13F
ownership, news and press releases, transcripts, executive compensation,
segmentation, earnings calendar, and FMP's derived key-metrics / ratios /
financial-growth rows (Stage B computes its own from the statements).

Yahoo's chart endpoint is unofficial. It is used only when FMP cannot serve
the member, requests are rate-limited (2/s) and cached in the durable
`api_cache`, and every failure degrades to a disclosed gap. The README says
so plainly.

## Approach

**Per-member fallback**, chosen over (a) a separate keyless bundle builder,
which duplicates the pipeline and does nothing for entry-tier keys, and (b)
replacing FMP outright, which drops the paid-only members for users who have
them.

FMP remains the primary source for every member. After the FMP calls settle,
a keyless layer fills each core member FMP could not serve — no key, empty
body, HTTP 402, refused symbol — with its own provenance (`source: "edgar"`,
`"yahoo"` or `"computed"`) and a manifest entry naming the replacement and
FMP's reason. Precondition: EDGAR resolves the ticker to a CIK. The fictional
fixtures resolve to nothing, so they never reach Yahoo and their reports stay
byte-identical.

## Components

### `src/providers/yahoo.ts` — `YahooClient`

- `dailyHistory(symbol, from, to)` → `FetchResult<FmpPayload<FmpEodBarRow>>`.
  Rows `{ date, open, high, low, close, volume, adjClose }`, date DESC. `close`
  is the split-adjusted close (Yahoo's `close` series), matching FMP's
  "split-adjusted close only" contract; `adjClose` (dividend-adjusted) is
  carried as an extra field and not consumed. Null bars are dropped. Range is
  requested with `period1`/`period2` epoch seconds.
- `quote(symbol)` → `FetchResult<FmpPayload<FmpQuoteRow>>` from the chart
  `meta` (`regularMarketPrice`, `regularMarketTime` → `timestamp`,
  `currency`, `exchangeName`, `longName` → `name`, `regularMarketDayHigh/Low`,
  `fiftyTwoWeekHigh/Low` → `yearHigh/yearLow`, `chartPreviousClose`,
  `regularMarketVolume`). `marketCap` is left null; the profile builder fills
  it from shares.
- `meta(symbol)` → `{ currency, exchange, longName, instrumentType, firstTradeDate }`
  for profile derivation (same request as `quote`, one cache entry).
- Symbol mapping: uppercase; `.` → `-` (FMP `BRK.B` → Yahoo `BRK-B`). Response
  validated with zod; `chart.error` or a missing result → gap.
- Transport: `fetchWithPolicy` with `provider: "yahoo"`, a 2 req/s limiter,
  `User-Agent` set from `EDGAR_CONTACT` when configured and a fixed
  browser-style string otherwise. Durable caching through the same
  `cachedFetch` adapter FMP uses (`provider: "yahoo"`); TTL 1 day for history,
  15 minutes for the quote. Fixture mode: none — the client is only invoked
  after EDGAR resolved a real CIK.

### `src/edgar/statements.ts` — `buildStatementsFromCompanyFacts`

Pure. Input: `CompanyFacts`, `{ symbol, cik, annualPeriods, quarterlyPeriods }`.
Output: `{ incomeAnnual, incomeQuarterly, balanceAnnual, balanceQuarterly,
cashflowAnnual, cashflowQuarterly }` as FMP-row-shaped arrays (date DESC) plus
`notes` and `gaps`.

Rules:

1. Facts from core forms only (`CORE_FACT_FORMS`), one value per period by
   `dedupFactPoints` (max `filed`, amendments win ties).
2. Annual rows: duration facts 300–400 days ending at a fiscal year end that
   has a `10-K`/`20-F` point for at least one anchor concept (revenue, net
   income or assets). `period: "FY"`, `fiscalYear` from the point's `fy` when
   its `fp` is `FY`, else the end date's year.
3. Quarterly income rows: 3-month (70–110 day) duration facts. Where a
   quarter has only a year-to-date fact, the quarter is derived as
   `YTD_n − YTD_(n−1)` within the same fiscal year. The fourth quarter is
   derived as `FY − YTD_Q3` (or `FY − (Q1+Q2+Q3)`). Derived rows carry
   `derivation: "ytd-difference" | "fy-minus-ytd"` and a note; a derivation is
   attempted only when every operand exists for the same concept.
4. Quarterly cash-flow rows: cash-flow facts are year-to-date in 10-Qs, so
   every quarter after Q1 is `YTD_n − YTD_(n−1)`, Q4 is `FY − YTD_Q3`.
5. Balance-sheet rows: instant facts at each 10-Q/10-K period end.
6. Per-share figures (EPS) are never derived by subtraction across periods
   except Q4 (`FY − YTD_Q3`), matching FMP's convention; weighted share counts
   are taken only when tagged for the period.
7. Missing concepts are `null`, never `0`. Computed fields exist only when
   every operand is present: `grossProfit = revenue − costOfRevenue`,
   `ebitda = operatingIncome + depreciationAndAmortization`,
   `ebit = incomeBeforeTax + interestExpense` (else `operatingIncome`),
   `totalDebt = shortTermDebt + longTermDebt` (each term may be a tagged
   total or a sum of components), `netDebt = totalDebt − cashAndCashEquivalents`,
   `cashAndShortTermInvestments = cash + shortTermInvestments` unless tagged,
   `totalEquity = stockholdersEquity + minorityInterest` unless tagged,
   `totalLiabilities = assets − totalEquity` unless tagged,
   `freeCashFlow = operatingCashFlow + capitalExpenditure` (capex NEGATIVE),
   `commonStockRepurchased` and dividends NEGATIVE (outflows), matching FMP.
8. `reportedCurrency` from the fact unit (`USD`, `EUR`, …); a concept whose
   only unit is not a currency is skipped for monetary fields.
9. `filingDate` = `filed`, `acceptedDate` = `filed`, `cik`, `symbol`.

Concept chains per field are a documented table in the module (first match
per period wins, same as `CONCEPT_CHAINS`). Bank-style filers resolve revenue
through the existing bank chain when `looksLikeBankTagging` is true.

### `src/edgar/sic.ts` — `sectorIndustryForSic`

SIC → `{ sector, industry }` in FMP's taxonomy so routing, the sector ETF
map and FRED sector routing work unchanged. Specific codes first (6021/6022
→ `Banks - Regional`/`Banks - Diversified`, 6035/6036 → `Banks - Regional`,
6311–6411 → `Insurance - …` by line, 6798 → `REIT - Diversified`, 6211 →
`Capital Markets`, 6282 → `Asset Management`, 6141/6153/6159/6162/6163 →
`Credit Services`/`Mortgage Finance`), then the SIC major group (two digits)
→ sector plus a descriptive industry. Unknown → `{ sector: null, industry: null }`.

### `src/pipeline/stageB/betaEstimate.ts` — `estimateBeta`

Pure OLS slope of the symbol's monthly log returns on SPY's, over the last 60
month-ends both series share; needs ≥ 24 months; returns
`{ beta, months, windowStart, windowEnd, rSquared }` or a gap. Consumed by the
profile builder only when FMP supplied no beta.

### `src/pipeline/keyless.ts` — orchestration

`applyKeylessFallbacks(sym, fmpResults, { edgar, yahoo, now, notes, gaps })`
returns replacements for: `profile`, `quote`, the six statement members,
`eodPrices`, `benchmarkPrices.spy`, `benchmarkPrices.sectorEtf`,
`enterpriseValues`, `marketCapHistory`, `sharesFloat`.

- Profile: EDGAR submissions (name, cik, SIC → sector/industry, exchange,
  fiscal year end, `isAdr` = files 20-F), Yahoo meta (currency, exchange name,
  `firstTradeDate` → `ipoDate`), `price` = Yahoo quote, `marketCap` = price ×
  latest `dei:EntityCommonStockSharesOutstanding` (else latest diluted
  weighted shares), `beta` = `estimateBeta` result. `isEtf` =
  Yahoo meta `instrumentType === "ETF"`, `isFund` = `"MUTUALFUND"` or
  `"CLOSEDEND"`, so `classifyInstrumentSupport` refuses a fund on the keyless
  path as it does on the keyed one; when the meta is unavailable both stay
  false and an `info` gap `profile.instrumentType` discloses that the
  instrument was not classified.
  `country` = `US` when the submissions' state of incorporation is a US
  state or `DC`, else null (ERP falls back to the US premium with the
  existing disclosed gap).
- Quote: Yahoo meta plus `marketCap` from shares.
- Statements: `buildStatementsFromCompanyFacts` on the already-fetched
  companyfacts.
- Prices: Yahoo daily history for the symbol, SPY and the sector ETF; the
  sector ETF fallback also applies when FMP refuses that symbol on a keyed
  plan.
- Enterprise values (quarterly): for each quarterly balance row, `stockPrice`
  = last Yahoo close on or before the period end, `numberOfShares` = the
  period's diluted weighted shares (else dei shares nearest the date),
  `marketCapitalization`, `addTotalDebt`, `minusCashAndCashEquivalents`,
  `enterpriseValue`.
- Market-cap history (daily): Yahoo close × piecewise dei shares (each cover
  date applies forward).
- Shares float: `outstandingShares` from dei, `floatShares` from
  `dei:EntityPublicFloat / price` when both exist.

Every replacement carries `Sourced.source` of `edgar`, `yahoo` or `computed`
and an `endpoint` that names the derivation (`companyfacts→income-statement(annual)`,
`chart→historical-price-eod/full`, `derived:enterprise-values(balance×close×shares)`).
Every replacement adds an `info` manifest entry
`keyless.<member>` — "served by <source> (<endpoint>) because FMP <reason>",
`expected: true` when no FMP key is configured. When the keyless source also
fails, the original FMP gap stands and the keyless failure is appended to
`attemptedSources`.

### `src/pipeline/dataBundle.ts` wiring

The EDGAR bundle (CIK, submissions, companyfacts) is awaited before the
fallback step. Fallbacks run only when `cik.ok`. `DataSource` gains
`"yahoo"`; `BuildDataBundleOptions` gains `yahoo?: YahooClient` for tests.
The `keyless` option `false` disables the layer (tests that assert pure FMP
gaps).

### `src/pipeline/stageA/validate.ts`

When the annual (or quarterly) income statement's `source` is `edgar`, the
FMP↔XBRL cross-check for that period records `status: "passed"` with detail
"statements are XBRL-sourced; the cross-check is an identity" and emits no
gap, so `dataCompleteness.xbrl` is `checked` and forensics are `complete`.

### `src/app/company/[symbol]/page.tsx`

A symbol is confirmed unknown when FMP returns its empty-array reason **or**
FMP is keyless and EDGAR's ticker lookup found no registrant. Both render the
existing not-found page instead of an empty report.

### Configuration and documentation

`EDGAR_CONTACT` is the only requirement for keyless operation. README gains a
"Without an FMP subscription" section listing what is served from where and
what stays a gap; `.env.example` says the same at the FMP key. The Yahoo
dependency is named as unofficial and best-effort.

## Data flow (keyless AAPL)

1. FMP fixture mode: profile/quote/statements/prices return "no API key + no
   fixture" gaps.
2. EDGAR: `AAPL` → CIK 320193 → submissions (Apple Inc., SIC 3571, NASDAQ,
   FYE 09) → companyfacts.
3. Yahoo: `AAPL`, `SPY`, `XLK` five-year daily history; `AAPL` quote meta.
4. Keyless layer builds profile (Technology / Consumer Electronics via SIC
   3571, price 325.13, market cap = price × 14.59B dei shares, beta from
   returns), quote, statements (10 FY, 24 quarters where filed), prices,
   enterprise values, market-cap history, float.
5. Stage A validates (XBRL identity), Stage B computes as today, the report
   persists with `edgar`/`yahoo` provenance and `keyless.*` info gaps.

## Error handling

Nothing throws for missing data. Yahoo 429/blocked/schema drift → gap; EDGAR
403 cooldown is honoured by the existing transport; a companyfacts payload
with no core-form facts → statement gaps with the reason. Derived rows are
never produced from partial operands.

## Testing

- `tests/yahoo.client.test.ts`: chart parsing, symbol mapping, null-bar
  drop, date ordering, quote/meta extraction, 429 and schema-drift gaps, UA
  header, cache key stability.
- `tests/edgar.statements.test.ts`: synthetic companyfacts covering 3-month
  + YTD income facts, YTD-only cash flow, Q4 derivation, restatement dedup,
  52/53-week fiscal years, missing components → null, computed-field
  operand rules, currency from unit, bank revenue chain, 20-F filer.
- `tests/edgar.sic.test.ts`: specific codes, major groups, unknown.
- `tests/stageB.betaEstimate.test.ts`: known slope, alignment, minimum window.
- `tests/keyless.test.ts`: orchestration with fake EDGAR/Yahoo — profile,
  quote, statements, EV, market-cap history, float, provenance, manifest
  entries, "keyless source also failed" path, fixture symbols skipped.
- `tests/dataBundle.keyless.test.ts`: `buildDataBundle` with a keyless FMP
  client, fake EDGAR transport and fake Yahoo → members present with
  `edgar`/`yahoo` sources; a keyed FMP whose sector ETF is refused → Yahoo
  serves it.
- `tests/stageA.validate.test.ts`: XBRL identity pass.
- `tests/company.page.unsupported.test.ts`: keyless unknown symbol → not
  found.
- Coverage: `yahoo.ts`, `edgar/statements.ts`, `edgar/sic.ts`,
  `pipeline/keyless.ts` join `RISK_SOURCE_MANIFEST` (85/75/85/85 per file);
  `betaEstimate.ts` falls under the Stage B core thresholds.
- Live verification: `FMP_API_KEY=""` end-to-end report for AAPL and one
  bank (JPM) in an isolated data directory; the audit fixture comparison
  stays byte-identical (fixtures resolve no CIK).
