# README notes — WS4 (data layer)

Facts from the WS4 remediation that the README needs to state. WS4 does not edit
`README.md`; this file is the handover. Each entry names the behaviour, the code
that implements it, and the wording the README should carry.

## 1. Reserved fixture symbols (D-11)

`DEMO` and `DBNK` are reserved. A report for either issues **no request to any
provider** — FMP, SEC EDGAR, Yahoo, FRED, Finnhub, FINRA — whatever API keys are
configured. Previously they were only "fixtures while no FMP key is set", so a
fixture run still sent the synthetic CIK `0000000000` to data.sec.gov and a keyed
run sent the two names to the vendor.

README should say: the demo symbols are reserved strings served entirely from
`fixtures/fmp`, they cannot resolve to a real ticker, and every reserved run
carries the manifest entry `fixture.reserved(DEMO)` / `fixture.reserved(DBNK)`
declaring that the figures are invented demonstration data.

Code: `src/providers/reservedSymbols.ts`, `src/providers/fmp.ts`
(`fixturesOnly()`), `src/pipeline/dataBundle.ts`.

## 2. Statement source policy — `THESIS_STATEMENT_SOURCE` (D-12)

New optional env key, documented in `.env.example`. Values:

- `auto` (default) — FMP first; when the plan truncates the history (entry plans
  cap `limit` at 5 periods) the older periods are backfilled from SEC EDGAR
  `companyfacts`. Backfilled rows carry `source: "edgar"` and their own
  `sourceEndpoint`; **no period mixes the two sources** (a period served by the
  vendor is never overwritten or blended). The endpoint string of a backfilled
  statement reads `<fmp endpoint> + <edgar endpoint> (older periods)`.
- `fmp` — FMP only; a plan-truncated history stays truncated.
- `edgar` — EDGAR `companyfacts` only; FMP's statement rows are ignored.

Any other value is rejected at startup. Backfill needs a resolvable CIK, so it
applies to real US filers; `EDGAR_CONTACT` must be set for the live EDGAR path.

Every backfill is disclosed twice: a row note, and the info manifest entry
`statements.backfill.<member>` naming how many periods each source served.

Code: `src/config/env.ts` (`// WS4 (D-12)` block), `src/pipeline/keyless.ts`,
`src/pipeline/dataBundle.ts`.

## 3. Versioned tag synonyms

The us-gaap element names the EDGAR statement chains resolve now live in one
versioned module stamped with the taxonomy year it was reviewed against
(`TAG_SYNONYMS_TAXONOMY`, `TAG_SYNONYMS_REVIEWED_ON`). A future taxonomy review
changes one file. `src/edgar/statements.ts` holds no second copy of the names —
a test fails if a bare element-name literal reappears there.

Interest expense is disclosed per tag rather than generically: the cash-flow
stand-ins say whether the figure **excludes** capitalized interest
(`InterestPaidNet`) or **includes** it (`InterestPaid`), because the WACC cost of
debt divides by it.

Code: `src/edgar/tagSynonyms.ts`.

## 4. Derived operating income excludes non-operating items

When a filer reports no `OperatingIncomeLoss`, the stand-in is derived from
pre-tax income and then has `NonoperatingIncomeExpense`,
`InvestmentIncomeInterest` (only when the aggregate is absent — it is a
component of it) and `IncomeLossFromEquityMethodInvestments` subtracted, so
investment income does not inflate EBIT. The adjustment is disclosed on the row.
It is never applied to bank-style filers, whose interest and investment income
are operating revenue.

## 5. Short-term debt reads the balance sheet before the maturity schedule (D-13)

`shortTermDebt` now resolves `DebtCurrent`, then the sum of
`ShortTermBorrowings` + `CommercialPaper` + `LongTermDebtCurrent`, and only if
all of those are absent falls back to the "due next year" line of the debt
maturity schedule. The schedule figure is current maturities only and is often
filed annually, so it is a last resort and is labelled as such. When the balance
sheet answers and a schedule figure also exists, the row note names the schedule
amount that was **not** added and what the reported figure may omit.

## 6. Multi-class share counts

Cover-page `dei:EntityCommonStockSharesOutstanding` facts are summed per
accession and date, so a multi-class filer's total is the sum of its classes
rather than whichever class the parser happened to see last. The count carries
the number of classes summed and the accession it came from.

The sum is disclosed: the info manifest entry
`keyless.sharesOutstanding.classes` names the filing, lists the unnamed
per-class counts and their total, and states that companyfacts carries no class
dimension, so per-class analysis is out of reach keylessly.

## 7. Restatements

Statement periods are deduplicated last-filed-wins; when a later filing changes a
material line (revenue, net income, total assets, equity, operating cash flow) by
more than 1%, the superseded value is retained as the `original` and the change
is reported as a restatement with both filing references.

Restatements now reach the report: the manifest field
`keyless.<member>.restatements` is a `warn` naming each restated line, the
first-reported and last-filed values, the signed change, and both accession
numbers with their filing dates. The statement shows the last-filed value.

## 8. Public float carries its own measurement date

`dei:EntityPublicFloat` is a dollar amount measured on a single cover-page date
— for a 10-K, the last business day of the most recently completed second fiscal
quarter — and refreshed once a year. Converting it to a share count needs a
price, and using the latest price rescales the count by every price move since
that date.

The keyless `sharesFloat` row now carries `publicFloatUsd`, `publicFloatAsOf`
and `publicFloatStale` beside `floatShares`/`freeFloat`; `publicFloatAsOf` is
the float's own date and is deliberately different from the row's `date`, which
is the share count's as-of. The manifest field
`keyless.sharesFloat.publicFloat` states the conversion in all cases and rises
from `info` to `warn` when the float is more than six months older than the
analysis date, which is the common case. It is also a `warn` when no float fact
was filed or no price was available, in which case `floatShares` and
`freeFloat` are absent rather than guessed.

README should say that a keyless free-float percentage is derived, not
reported, and is only as current as its measurement date.

## 9. SEC fair-access limits are pinned by tests

The EDGAR client sends the declared `EDGAR_CONTACT` User-Agent on every request
and paces itself at `EDGAR_MAX_RPS` (5) through the shared "edgar" token-bucket
limiter, under SEC's published 10 requests/second ceiling. A 403 *or* a 429 is
treated as SEC's rate-limit signal: the client enters a ten-minute cooldown and
raises a retryable error, and while the cooldown is open it makes no further
requests at all rather than retrying into the limit.

Only the User-Agent and the 403 branch had tests; the rate, the burst, the
per-request header and the 429 branch are now pinned too
(`tests/edgar.client.test.ts`, "EDGAR fair-access limits (WS4)").

<!-- Sections continue as later WS4 units land. -->
