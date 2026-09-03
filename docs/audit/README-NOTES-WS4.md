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

**README correction.** The current text says the demo symbols are "served only
when no `FMP_API_KEY` is configured" and that for them "EDGAR is still queried
for filings as on any run". Both are now false: they are served from fixtures
whatever keys are set, and EDGAR is not queried for them at all. The exact
replacement wording is in §13.1 and §13.2.

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
changes one file. Neither `src/edgar/statements.ts` nor
`src/pipeline/keyless.ts` holds a second copy of the names — a test fails if a
bare element-name literal reappears in either (N6: `keyless.ts` kept its own
`DEI_SHARES_TAG` literal, and the scan covered `statements.ts` alone).

Interest expense is disclosed per tag rather than generically: the cash-flow
stand-ins say whether the figure **excludes** capitalized interest
(`InterestPaidNet`) or **includes** it (`InterestPaid`), because the WACC cost of
debt divides by it.

Code: `src/edgar/tagSynonyms.ts`.

## 4. Derived operating income excludes non-operating items

When a filer reports no `OperatingIncomeLoss`, the stand-in is derived from
pre-tax income plus interest expense and then has `NonoperatingIncomeExpense`,
`InvestmentIncomeInterest` (only when the aggregate is absent — it is a
component of it) and `IncomeLossFromEquityMethodInvestments` subtracted, so
investment income does not inflate EBIT. The adjustment is disclosed on the row,
naming WHICH pretax element and WHICH interest element served. It is never
applied to bank-style filers, whose interest and investment income are operating
revenue.

Two gates on that subtraction (extraction-correctness review, SHOULD-FIX 3):

- `IncomeLossFromEquityMethodInvestments` is NOT subtracted when the pretax
  element that served is
  `IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments`,
  which is measured before equity-method results by definition.
- The whole derivation is WITHHELD when the interest resolved from
  `InterestExpenseNonoperating` beside a filed `NonoperatingIncomeExpense`; see
  §7b. Otherwise the disclosure carries the caveat that the aggregate may
  already contain the interest being added back.

## 5. Short-term debt reads the balance sheet before the maturity schedule (D-13)

`shortTermDebt` resolves `DebtCurrent` first. Failing that it is the SUM OF TWO
COMPONENTS, because short-term borrowings and the current maturities of
long-term debt are different instruments and a filer can tag one without the
other:

- **short-term borrowings** — `ShortTermBorrowings` + `CommercialPaper`;
- **current maturities of long-term debt** — `LongTermDebtCurrent` or
  `LongTermDebtAndCapitalLeaseObligationsCurrent`, and only if BOTH of those
  miss, the "due next year" line of the debt maturity schedule.

The schedule figure is current maturities only and is often filed annually, so
it stands in for that component alone and is labelled as such on every row it
serves. `resolveDebtOverlaps` case 5 nets it out whenever a balance-sheet
current-maturities tag did resolve, so it is never counted twice, and the row
note names the schedule amount either way.

**Corrected 2026-09-02 (extraction-correctness review, BLOCKER).** Until then the
schedule was a step of the WHOLE chain, reached only when all four
balance-sheet tags missed. A filer that tagged `ShortTermBorrowings` while
tagging its current maturities only by extension lost the current maturities
entirely: Caterpillar FY2024 published short-term debt 5,514 against a filed
12,634 and total debt 36,210 against 43,330 — 7.12B, 16.4% low, into net debt,
enterprise value, invested capital, ROIC, leverage and the DCF equity bridge.

## 6. Multi-class share counts

Cover-page `dei:EntityCommonStockSharesOutstanding` facts are summed per
accession and date, so a multi-class filer's total is the sum of its classes
rather than whichever class the parser happened to see last. The count carries
the number of classes summed and the accession it came from.

The SAME rule applies to every period of the share-count series, not only the
newest point (`coverShareCountsByPeriod`, used by both `latestSharesOutstanding`
and `sharesOutstandingSeries`). Within a period the dei facts are the
registrant's share classes and are summed; across filings a repeated period is
a refiling and stays deduplicated by max(`filed`). The `us-gaap`
balance-sheet fallback is a single all-classes fact and is only ever
deduplicated.

The sum is disclosed: the info manifest entry
`keyless.sharesOutstanding.classes` names the filing, lists the unnamed
per-class counts and their total, says the same rule feeds the market-cap
history and the enterprise values, and states that companyfacts carries no class
dimension, so per-class analysis is out of reach keylessly.

Two things the sum cannot establish from this source are `warn` entries of their
own, `keyless.sharesOutstanding.classes.caveat1` / `caveat2`:

- a value that REPEATS inside one filing is counted once, and companyfacts
  cannot distinguish that from a second class with an identical count;
- a class more than a hundredfold larger than another is flagged, because a raw
  sum assumes equal per-share economics and companyfacts carries no conversion
  ratio (Berkshire's B shares convert 1:1500 to an A share).

**Corrected 2026-09-02 (extraction-correctness review, SHOULD-FIX 2).** The spot
count summed the classes while the series deduplicated them, so one report
contradicted itself: on the three-class fixture at a 50 dollar close the profile
showed a 500M market cap and the same day's history point 250M.

## 7. Restatements and re-presentations

Statement periods are deduplicated last-filed-wins; when a later filing changes a
material line (revenue, net income, total assets, equity, operating cash flow) by
more than 1%, the superseded value is retained as the `original` and the change
is reported with both filing references.

They reach the report: the manifest field `keyless.<member>.restatements` is a
`warn` naming each changed line, the first-reported and last-filed values, the
signed change, and both accession numbers with their filing dates. The statement
shows the last-filed value.

Two wording points, both from the extraction-correctness review of 2026-09-02:

- A comparative RE-PRESENTED for discontinued operations or a change of
  reportable segments moves exactly like a correction, and companyfacts carries
  nothing that separates the two. The row note and the manifest reason say
  "restated or re-presented" and tell the reader to read a CHANGE between
  filings, not necessarily an error the filer admitted (N7).
- A change against an original of ZERO has no percentage. `Restatement.changePct`
  is `number | null` and null is the deliberate sentinel; it used to be
  `Infinity`, which rendered as "Infinity%" in a manifest reason and serialised
  to an accidental `null` in the row (N4).

## 7a. Every EDGAR row is disclosed, wherever it was appended

A stand-in, a withheld figure or a restatement is disclosed for the periods it
actually served, on all THREE paths that put EDGAR rows into a member:

| Path | Manifest fields |
| --- | --- |
| Full substitution (FMP served nothing) | `keyless.<member>.<field>` |
| Plan-limit backfill (older periods, §2) | `keyless.<member>.backfill.<field>` |
| Predecessor history (§11) | `keyless.<member>.predecessor.<field>` |

Withheld figures are `warn` under `…withheld.<field>`; stand-ins are `info`.

**Corrected 2026-09-02 (SHOULD-FIX 4).** The backfill and predecessor paths took
rows from a build result and appended them while discarding its substitutions,
notes and restatements. On the entry-tier plan this project runs, years six to
ten of every statement come from EDGAR, so a derived EBIT, a cash-interest
stand-in or a maturity-schedule debt figure could sit in a report with no
manifest entry and no note at all.

A row appended into another payload's envelope also carries its own
`sourceFetchedAt` (and `sourceAsOf` for the backfill), because the envelope's
fetched-at and as-of describe the vendor's fetch (N9).

## 7b. Figures the builder refuses to publish

`StatementRowsResult.withheld` carries fields left null ON PURPOSE, with the
reason, and the keyless layer files each as a `warn`. Two rules populate it:

- **A derived EBIT that would double-count interest.** The stand-in is pretax
  income + interest expense, less the non-operating items the filer tagged. When
  the interest resolved from `InterestExpenseNonoperating` — a taxonomy child of
  `NonoperatingIncomeExpense` — and that aggregate also resolved, the derivation
  adds back an interest expense the aggregate already removed and overstates
  EBIT by exactly that interest, so no figure is published. Where the
  containment cannot be established from the tags the figure stands and the
  disclosure carries the caveat, because companyfacts has no presentation
  linkbase (SHOULD-FIX 3).
- **A derived quarter with negative revenue.** A quarter built by subtracting
  year-to-date figures can come out negative when the two operands do not
  describe the same thing. Negative quarterly revenue is not a figure any filer
  reported, so it becomes a disclosed gap naming the two periods it came from.
  A NEGATIVE FIGURE A FILER ACTUALLY REPORTED is never second-guessed.

The same review also gated the equity-method adjustment on WHICH pretax element
served: `IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments`
is measured BEFORE equity-method results, so subtracting them removed money the
base never held (pretax-before-equity 5,000, equity income 300, interest 200
published 4,900 instead of 5,200). The derivation description now names the
pretax element and the interest element that served.

## 8. Public float carries its own measurement date

`dei:EntityPublicFloat` is a dollar amount measured on a single cover-page date
— for a 10-K, the last business day of the most recently completed second fiscal
quarter — and refreshed once a year. Converting it to a share count needs a
price, and using the latest price rescales the count by every price move since
that date.

The conversion uses THE CLOSE ON OR BEFORE THE FLOAT'S OWN MEASUREMENT DATE, so
both sides of the division are dated the same day. The latest quote is the
fallback only when the price history reaches no further back than that date, and
that case is a `warn` in its own right.

The keyless `sharesFloat` row carries `publicFloatUsd`, `publicFloatAsOf`,
`publicFloatStale`, `publicFloatPrice`, `publicFloatPriceDate` and
`publicFloatPriceBasis` beside `floatShares`/`freeFloat`; `publicFloatAsOf` is
the float's own date and is deliberately different from the row's `date`, which
is the share count's as-of. The manifest field
`keyless.sharesFloat.publicFloat` states the conversion and its price date in
all cases, and is a `warn` when the float is more than six months older than the
analysis date (the common case — the company may have issued or retired shares
since), when the latest quote had to stand in for the measurement-date close,
when no float fact was filed, or when no price was available at all; in the last
two cases `floatShares` and `freeFloat` are absent rather than guessed.

**Corrected 2026-09-02 (SHOULD-FIX 6).** The conversion divided by the LATEST
quote while the float's as-of is typically the prior June 30, so the share count
was rescaled by every price move since: an issuer whose stock doubled reported
half its float shares and a free float falling from about 90% to about 45%.

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

## 9a. The declared SEC contact never leaves the SEC channel

`EDGAR_CONTACT` is the operator's real name and email, declared for SEC's
fair-access policy. The data bundle used to reuse it as Yahoo's `User-Agent`,
sending personal data to a provider that never asked for it and that
`docs/PRIVACY.md` does not list as a recipient. Yahoo now gets the client's own
neutral `YAHOO_DEFAULT_USER_AGENT`, which names the product only.
`docs/PRIVACY.md` already described that behaviour and now describes it
truthfully; it states the guarantee explicitly.

Fixed 2026-09-02 (extraction-correctness review). It predates WS4.

## 10. Beta: adjusted returns, uncertainty, and the Blume figure (D-15)

The keyless beta is the OLS slope of monthly log returns on the benchmark's over
the shared month-ends of the last five years, and it needs at least 24 monthly
observations or it is a disclosed gap rather than a number. Three changes:

- Returns are built from the **dividend-adjusted** close when both the symbol
  and the benchmark carry one (Yahoo's chart `adjclose`). A price-only series
  understates a dividend payer's return in every ex-dividend month. The two
  series are never mixed: if either lacks an adjusted close anywhere in the
  window, the whole regression falls back to closing prices and the manifest
  entry becomes a `warn` saying so. FMP's EOD endpoint carries no adjusted
  close, so a keyed run currently takes the price-only path.
- The **OLS standard error** of the slope is reported beside R², in the profile
  note and on the profile row (`betaStandardError`, `betaRSquared`,
  `betaMonths`, `betaBasis`).
- The **Blume mean-reversion adjustment** (2/3 × raw + 1/3) is reported beside
  the raw slope as `betaBlume`, never in place of it.

The methodology entry is `profile.beta.method`; the failure entry stays
`profile.beta`.

## 11. Successor registrants keep their predecessor's history (D-14)

A holding-company reorganization creates a new SEC registrant that takes over
the listed ticker and files a Form 8-K12B. Its own `companyfacts` payload starts
at the reorganization, and neither `submissions` nor `companyfacts` links it to
the predecessor's CIK, so every long-window growth rate and multi-year average
measured a few months of history — or produced nothing — with no explanation.

Thesis now resolves the link. When a registrant has an 8-K12B on file **and** its
own companyfacts carry no us-gaap concepts, two extra EDGAR requests run: the
8-K12B's submission header, whose FILER blocks co-register the predecessor and
are the only machine-readable connection between the two CIKs, and then the
predecessor's companyfacts. Periods strictly older than anything the successor
filed are appended, each row tagged `predecessor: true` with `predecessorCik`,
and the statement's endpoint gains `[predecessor CIK …] (pre-reorganization
periods)`. No period is ever duplicated or blended.

The manifest field is `edgar.predecessor`: an expected `info` naming both
entities, the linking accession and the span supplied, and stating that the
older periods were filed by a different legal entity so a change of accounting
policy or perimeter at the reorganization is not visible as a restatement. When
the registrant is a successor **that carries no us-gaap concepts of its own** and
no predecessor could be resolved — a header with no single co-registrant, or a
failed fetch — the same field is a `warn` saying every multi-year figure covers
only the successor's own history. A CIK is never guessed from a company name.

**Corrected 2026-09-02 (SHOULD-FIX 5).** `resolvePredecessor` returns null both
when the registrant is not a successor and when it IS one that already carries
its own history, and the keyless layer could not tell them apart — so a
successor that had carried its XBRL forward got a warning saying every
multi-year figure measured only its own filing history while that history was
present and complete.

Only the FILER blocks of the 8-K12B's submission header are scanned for the
co-registrant. Scanning the whole header worked for an 8-K12B, whose only
parties are the co-registrants, but on other form types it would pick up the
SUBJECT COMPANY of a Schedule 13D or the ISSUER of a Form 4 as though it were
one (N8).

**README correction.** The current text lists a successor registrant among the
issuers whose statements stay empty "because the predecessor's history sits
under a CIK that EDGAR does not link". That is now only true when the
predecessor cannot be resolved; the ordinary case is that the history is
present and tagged. The exact replacement wording is in §13.4.

## 11a. Coverage floor for the modules WS4 carved out

`src/edgar/tagSynonyms.ts`, `src/edgar/successor.ts` and
`src/providers/reservedSymbols.ts` are in `RISK_SOURCE_MANIFEST`
(`vitest.shared.ts`), so the per-file 85/75/85/85 gate applies to them. Logic
that moved out of the audited `statements.ts` kept its floor, and the
reserved-symbol safety guard has one for the first time (N3).

## 12. Insider trades (Form 4) have no keyless source

Assessed and not implemented. A keyless equivalent of FMP's insider-trades
endpoint would mean listing every Form 4 a registrant's officers and directors
filed (a separate EDGAR browse or full-text-search query, since Form 4s are
filed by the reporting *person*, not the issuer), fetching each one's
`ownershipDocument` XML, and parsing transaction codes, dates, prices and
post-transaction holdings — dozens of extra requests per report against SEC's
fair-access limit, plus a new parser and its own fixture corpus. That is well
past the "only if modest" bar, and a partial implementation would be worse than
none: an insider-selling signal computed from an incomplete set of Form 4s reads
as evidence rather than as a gap.

The sentence for the README, verbatim:

> Insider trades (SEC Form 4) are **not implemented keylessly**: without an FMP
> key the member stays a disclosed gap in the missing-data manifest.

**README correction.** That sentence has never reached `README.md` — it exists
only in this handover file, so the README's "Without an FMP subscription"
section still leaves a reader to infer the Form 4 gap from a list. See §13.3.

## 13. Required README corrections (verbatim replacements)

Three statements in `README.md` are false as of 2026-09-02. WS4 does not edit
`README.md`; each correction below gives the EXACT text to find and the EXACT
text to put in its place.

### 13.1 The demo symbols are reserved, not key-dependent

**Find** (the paragraph beginning "`DEMO` and `DBNK` resolve to fixtures"):

> `DEMO` and `DBNK` resolve to fixtures **only while no `FMP_API_KEY` is
> configured**. Once a key is set, they are treated as ordinary symbols and sent
> to the live provider, which does not list them — so the pages render as
> near-empty disclosed gaps rather than the demo company. To see the fixtures
> again with a key in your `.env`, start the server with `FMP_API_KEY=""`.
> `/report/sample` is static and always renders, key or no key.

**Replace with:**

> `DEMO` and `DBNK` are **reserved strings**. They are served entirely from the
> fictional contract fixtures in `fixtures/fmp` whatever API keys are
> configured, they are never sent to any provider — not FMP, SEC EDGAR, Yahoo,
> FRED, Finnhub or FINRA — and they cannot resolve to a real ticker, so no
> future listing of either symbol can turn a demo page into a report about a
> real company. Every reserved run carries the manifest entry
> `fixture.reserved(DEMO)` / `fixture.reserved(DBNK)` declaring that the figures
> are invented demonstration data. `/report/sample` is static and always
> renders, key or no key.

### 13.2 EDGAR is not queried for the demo symbols either

**Find** (in *Without an FMP subscription*, the sentence beginning "`DEMO` and
`DBNK` remain the fictional fixtures"):

> `DEMO` and `DBNK` remain the fictional fixtures, served only when no
> `FMP_API_KEY` is configured; they never reach the keyless layer, so no Yahoo
> request is made for them, while EDGAR is still queried for filings as on any
> run.

**Replace with:**

> `DEMO` and `DBNK` remain the fictional fixtures whatever keys are configured;
> they never reach the keyless layer and no request is made for them to any
> provider, EDGAR included — the filings a real run would fetch are disclosed
> absent in the manifest instead.

### 13.3 The Form 4 gap has no sentence in the README at all

**Find** (in *Without an FMP subscription*, the paragraph beginning "Analyst
estimates and price targets"), the phrase:

> Analyst estimates and price targets, grades consensus, peers, insider trades
> and statistics, 13F institutional ownership, news and press releases,

**Replace with** the same paragraph, followed by this sentence as its own
paragraph:

> Insider trades (SEC Form 4) are **not implemented keylessly**: without an FMP
> key the member stays a disclosed gap in the missing-data manifest.

### 13.4 (also true, lower priority) The successor-registrant example

**Find** (in the paragraph about issuers whose statements stay empty):

> a successor registrant created by a reorganization (a Form 8-K12B on file and
> no annual report yet; the predecessor's history sits under a CIK that EDGAR
> does not link, as with ExxonMobil Holdings Corp from July 2026).

**Replace with:**

> a successor registrant created by a reorganization whose predecessor could not
> be resolved (a Form 8-K12B on file and no annual report yet). The ordinary
> case is now that the predecessor's history IS reached, through the 8-K12B's
> co-registered FILER blocks, and appended as rows tagged `predecessor`; only a
> header naming no single co-registrant, or a failed fetch, leaves the
> statements empty, and the manifest says which happened.

<!-- Sections continue as later WS4 units land. -->
