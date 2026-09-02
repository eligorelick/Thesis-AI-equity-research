# Analysis quality — design

**Date:** 2026-09-02
**Status:** implemented (2026-09-02). Every change below is covered by unit
tests, the audited fixture baseline carries dated allowlist entries for the
leaves that moved, and the live validation section records what a keyless
rerun of the affected issuers produced.
**Directive:** "improve the codebase to be the best possible equity analyzer
based on extensive research, testing, and data analysis."

## Problem

A 21-issuer keyless sweep on 2026-09-02 (AAPL, AGNC, AMZN, BAC, BRK-B, CAT,
GE, GOOGL, HD, JPM, KO, MET, MRNA, MSFT, NVDA, O, PFE, TSLA, TSM, WMT, XOM;
no FMP key, EDGAR + Yahoo only, `THESIS_DATA_DIR` isolated) completed for
every symbol and exposed six defects that lowered the quality of the
analysis rather than crashing it:

1. **Valuation carried no discrimination.** The DCF fair value sat 33% to 96%
   below the quote for every profitable large cap (MSFT −36%, KO −58%, WMT
   −62%, AMZN −71%, TSLA −96%; AAPL −64%, HD −46%, JPM −49% on the earlier
   run), and the valuation aspect graded 19 of 21 issuers D or F. The
   terminal value assumed ROIC = WACC for every issuer, so Apple at 92% ROIC,
   Home Depot at 22% and Coca-Cola at 18% were valued as if their returns
   collapsed to the cost of capital in year 11.
2. **Five issuers lost their DCF to tag coverage.** Caterpillar and GE file
   their income-statement interest line only under extension tags, so the
   keyless WACC had no cost of debt and the DCF was suppressed. Pfizer files
   no `OperatingIncomeLoss` line at all, so no EBIT margin was derivable.
3. **XOM lost every statement.** The ticker now maps to ExxonMobil Holdings
   Corp (CIK 2115436, a successor registrant created by a Form 8-K12B in
   July 2026). SEC returns its companyfacts `cik` as a string, the client's
   schema demanded a number, the whole payload was rejected, and the manifest
   said "companyfacts HTTP 200". The annual-filing lookup then reported only
   the 20-F miss, which made a Texas registrant read as a foreign filer.
4. **TSM's empty statements had no cause.** Its facts sit in the `ifrs-full`
   taxonomy; the manifest said only "0 candidate periods".
5. **JPMorgan's quality grade rested on two coin-flips.** The Piotroski
   F-score scored the bank 2/6 with both misses on the operating-cash-flow
   tests, which are not profitability or accrual signals for a bank.
6. **Macro figures could not be cited.** FRED values were registered with an
   empty unit, which the provenance registry reads as an index level, so a
   model citing the 10-year yield as "4.2 %" failed with a unit mismatch.
   Separately, numbers lifted from filing prose were logged as
   "unknown-source" even when the payload itself advertised the text source,
   and a bull or bear pass whose output failed schema validation was lost
   outright ($0.25 and both passes on the first haiku run of the day).

The same sweep, a keyless rerun after the first round of fixes, and one
haiku report on Caterpillar ($0.83, verification rate 0.82) exposed five
more:

7. **A bank got a derived EBIT.** With the operating-income stand-in in
   place, JPMorgan's keyless income statement gained "EBIT = pretax income +
   interest expense" — meaningless for a bank, whose interest expense is an
   operating cost.
8. **Pfizer's DCF extrapolated a collapse.** Its three-year revenue CAGR is
   negative (the COVID-product run-off) and its five-year CAGR positive; the
   growth anchor took the lower of the two and carried the run-off through
   the ten-year fade to the terminal rate (−88% versus the quote).
9. **Caterpillar's balance sheet was unusable.** Its 10-Q balance rows carry
   no us-gaap debt tag and no `StockholdersEquity` line (the filer tags only
   the total including the noncontrolling interest), and its 10-K carries
   the current debt only through the maturity schedule; the newest balance
   row had cash but no debt or equity, so invested capital, net debt and the
   DCF were suppressed while a whole fiscal-year row sat one period back.
10. **The verification pass rejected true citations on spelling.** In the
    Caterpillar report 15 of 85 traced numbers failed: all three
    balance-sheet cells and an interest-expense cell as `period-mismatch`
    (the judge wrote "total debt FY2025" for a cell registered as
    2025-12-31), the nine aspect-score citations and the RSI as
    `unit-mismatch` (the judge echoed "0-100 score" and "index (0-100)"),
    and the payrolls citation as `unknown-source` (PAYEMS, served in
    thousands, had no registrable unit and was never registered).
11. **A profitable bank was routed as unprofitable.** The unprofitable
    overlay triggers on negative TTM net income or negative TTM operating
    cash flow. JPMorgan reported negative operating cash flow in
    record-profit years (loan, deposit, trading-asset and reserve flows
    dominate a bank's OCF), so the overlay fired, the headline metrics were
    replaced by cash runway and burn, and the analyst passes were briefed on
    a loss-maker.

## Research basis

- McKinsey & Company, *Valuation: Measuring and Managing the Value of
  Companies*, chapter on estimating continuing value: the key value driver
  formula `Value = NOPAT (1 − g/RONIC) / (WACC − g)` with RONIC = WACC "for
  most companies", and RONIC above WACC only "for companies with sustainable
  competitive advantages (e.g., brands and patents)"; the same source's
  ROIC-persistence evidence shows top-quintile spreads over the cost of
  capital roughly halving over ten to fifteen years without closing.
- Damodaran, *Investment Valuation* and the "Closure in valuation" notes:
  excess returns in perpetuity are defensible only when modest; historical
  growth has little predictive value on its own, and an erratic history
  (sign changes between horizons) carries none — the stable rate is the
  defensible anchor; fundamental growth is reinvestment rate × return on
  capital.
- Piotroski (2000), *Value Investing: The Use of Historical Financial
  Statement Information to Separate Winners from Losers*: the F-score was
  built and tested on non-financial high book-to-market firms; the cash-flow
  and accrual signals presume an operating cash flow that measures earnings
  quality, which a bank's does not (loan, deposit, trading and reserve
  flows dominate it).
- SEC EDGAR: Form 8-K12B is the successor-issuer notice under Rule 12g-3;
  the successor's submissions and companyfacts carry no structured link to
  the predecessor's CIK. The companyfacts endpoint emits `"cik":320193` for
  long-standing registrants and `"cik":"2115436"` for one created in 2026.
  Caterpillar's companyfacts carry `InterestPaidNet`,
  `LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths` and
  `StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest`
  where most filers tag `InterestExpense`, `LongTermDebtCurrent` and
  `StockholdersEquity`.

## Changes

### 1. Terminal excess-return house rule (`src/pipeline/stageB/valuation.ts`)

`terminalRoic(waccPct, roicHistory)` decides the terminal ROIC:

- No history supplied → WACC, silently (the basis reads "terminal ROIC =
  WACC (zero excess returns in perpetuity, house-rule default)").
- Fewer than `TERMINAL_EXCESS_RETURN_MIN_YEARS` (4) fiscal years with a
  ROIC → WACC, with the note "terminal ROIC held at WACC: N fiscal years of
  ROIC on record, 4 needed to evidence durable excess returns (house rule)".
- Any of the newest five years at or below WACC → WACC, with a note naming
  the years.
- Otherwise `excess = min(5pp, 0.5 × median(ROIC − WACC))`; below 0.5pp the
  default holds with a "too thin to carry" note; else terminal ROIC =
  WACC + excess and the basis states the years, the median spread, the
  half-carry and the cap.

`DcfAssumptionInputs.roicHistory` carries the same annual ROIC series the
returns section reports (`compute.ts` passes `roic.series`); the valuation
context gained `roic: RoicResult`. The reinvestment rate stays `g / ROICterm`
(Damodaran consistency), so a higher terminal ROIC lowers terminal
reinvestment rather than inventing growth. The sensitivity grid varies WACC
and g around a fixed terminal ROIC. Effect on the sweep issuers is recorded
under live validation below.

### 2. Statement stand-ins (`src/edgar/statements.ts`, `src/pipeline/keyless.ts`)

A chain step may carry `disclose`; when it resolves, the statement records a
`Substitution { field, text, periods }` and the keyless orchestration files
an `info` manifest entry `keyless.<member>.<field>`. Three chains use it:

- `interestExpense` falls back to `InterestPaidNet` / `InterestPaid`.
- `operatingIncome` falls back to pretax income + interest expense through a
  new `sumAll` chain kind (every part must resolve). Bank-style filers
  (`looksLikeBankTagging`) keep the plain `OperatingIncomeLoss` chain
  (`BANK_OPERATING_INCOME_SPEC`): a bank's interest expense is an operating
  cost, so the sum is not its EBIT.
- `totalStockholdersEquity` falls back to
  `StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest`
  minus `MinorityInterest` (a `diff` step), then to that total alone.

The debt maturity schedule's
`LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths` joins the
`shortTermDebt` sum as a row-note stand-in: `resolveDebtOverlaps` keeps it
only when neither `LongTermDebtCurrent` nor the combined current tag resolved
for the period ("current maturities taken from the debt maturity schedule …
— no balance-sheet current-debt tag filed"), drops it beside either with a
note, and nets it out of a `LongTermDebt` total the same way it nets
`LongTermDebtCurrent`. The keyless-data-path spec (rule 6b) is the contract.

### 3. EDGAR robustness and honesty

- `companyFactsSchema.cik` accepts a number or a digit string
  (`src/edgar/xbrl.ts`).
- A body-check rejection reports the check's own reason instead of
  "companyfacts HTTP <status>" (`src/providers/edgar.ts`).
- `selectAnnualFiling` reports `no "10-K" or "20-F"` and appends the
  successor-issuer notice when a Form 8-K12B is on file
  (`src/pipeline/dataBundle.ts`).
- An empty statement member names its cause — IFRS reporting or a successor
  registrant — when one is known (`describeEmptyStatements` in
  `src/pipeline/keyless.ts`).

The predecessor's history is not fetched: EDGAR gives no structured link and
the accession prefix of the successor's own filings (`0000034088-…`, the old
Exxon CIK) is a filer-agent convention, not an identity claim. Until the
successor files its first 10-K, XOM's keyless statements stay a disclosed
gap.

### 4. Piotroski on financial routes (`src/pipeline/stageB/forensics.ts`)

With `financialsSuppressed`, the F-score withholds four signals — the
current ratio and gross margin it already withheld, plus F_CFO and
F_ACCRUAL — and reports out of the signals that remain (5 with three fiscal
years). The forensics note on the route says so.

### 5. Macro units (`src/providers/fred.ts`, `src/pipeline/stageC/payload.ts`)

`fredFigureUnit(seriesId, units)` returns `{ unit, scale, qualifier }`: "%"
for any percent-change transform (`pc1`, `pch`, `pca`, `cch`, `cca`),
otherwise the series' native unit (a table covering every core and sector
series) mapped onto the registry vocabulary. Rates, spreads and index levels
render as served ("%", "pp", "index"). A series FRED serves in a scaled or
per-quantity unit renders as a plain count or currency amount: payrolls and
housing starts in thousands become `count` × 1,000, vehicle sales in
millions `count` × 1,000,000, PCE and deposits in billions `USD` × 10⁹,
durable-goods orders and retail sales in millions `USD` × 10⁶, and the
commodity prices `USD` with the quantity named. The macro section renders
the scaled value (rounded to a whole number — FRED serves these series with
at most three decimals, so the rounding only removes float noise) and adds a
note, "Units: PAYEMS: persons (FRED serves thousands; shown ×1,000); …", for
every converted series. Figure labels, and hence registry ids
(`payload.macro.payems-core`), are unchanged. An unknown series still
renders with an empty unit, which the registry reads as an index.

### 6. Verification reason `text-source` (`src/pipeline/stageC/passes.ts`, `provenance.ts`, `src/report/schema.ts`)

A number whose source id is a registered payload-text citation is logged
with reason `text-source` instead of `unknown-source`. It stays unverified;
only the explanation changed. The report schema's reason enum gained the
value.

### 7. Analyst repair attempt (`src/pipeline/jobRunner.ts`, `src/pipeline/stageC/passes.ts`, `index.ts`)

When `runBullThenBear` fails and a side's output was received but rejected
by the schema (`bullRetryable` / `bearRetryable` on `BullBearPassFailure`,
with the rejected `rawText`), the runner makes one repair attempt
(`MAX_ANALYST_REPAIRS = 1`) for that side under a fresh settlement
checkpoint: `runAnalystPass(deps, side, settlement, beforeProviderLaunch,
validationFeedback)`
builds the same cached payload turn and tools plus a second user turn
carrying the error and the previous output (`buildAnalystRepairRunPassArgs`).
The sibling's paid output is kept. A transport failure, a refusal, or a
sibling that never launched still degrades to a data-only report; a failed
repair attempt is disclosed as "repair attempt after schema-invalid output
also failed: …". Each attempt is its own cost row and pass artifact, as the
judge's retries are.

### 8. No-trend growth anchor (`src/pipeline/stageB/valuation.ts`)

The near-term growth rate anchors on the lower of the three- and five-year
revenue CAGRs. When the two disagree in sign, the history holds a spike or a
collapse rather than a trend, and near-term growth is set to the terminal
rate (`g1 = gTerm`, computed first) with the basis "terminal growth rate (3y
and 5y historical revenue CAGRs disagree in sign — no trend to extrapolate,
house rule)" and a note naming both CAGRs. The min rule and its note are
unchanged when the signs agree.

### 9. Balance anchor fallback (`src/pipeline/compute.ts`)

`pickBalanceAnchor(quarterly, annual)` returns the point-in-time balance row
the valuation reads for net debt, invested capital and the EV bridge: the
newer of the latest quarterly and annual rows (fields are never mixed across
periods), unless that row lacks any of `totalDebt`,
`totalStockholdersEquity` and `cashAndShortTermInvestments` while the older
row carries all three. Caterpillar's 10-Q rows carry equity (through the
stand-in) and cash but no debt tag at all, so a rule that kept any partly
filled newest row still suppressed its DCF; a whole fiscal-year row up to
three quarters old is the disclosed compromise. The fallback is a valuation
note ("balance anchor: the newest balance row (quarter <date>) lacks
totalDebt, so net debt, invested capital and the EV bridge use the annual
row as of <date>, the newest row carrying totalDebt, totalStockholdersEquity
and cashAndShortTermInvestments") and an `info` gap
`valuation.balanceAnchor`. When neither row is whole the newest stands. The
projections' balance point uses the same pick.

### 10. Verification tolerance for spelling (`src/pipeline/stageC/provenance.ts`, `passes.ts`, `prompts.ts`)

Registry ids are unique, so the id pins the record; unit, currency, period
and as-of are cross-checks on the model's reading. Two spellings the prompt
never renders as citable tags are now read as the registry's:

- `canonicalizeTracedUnit` strips a trailing parenthetical before matching,
  so "0-100 (grade B, completeness 0.9)", "0-100 score" and "index (0-100)"
  canonicalize to `score`, `score` and `index`. A scale qualifier such as
  "USD (millions)" is stripped too and caught by the value match.
- `periodsAgree(supplied, registered)` accepts equality, containment, or the
  same set of calendar years (four-digit years and `FY25` forms), so
  "FY2025", "Q2 2026" and "total debt FY2025" agree with 2025-12-31 or
  2026-06-30 while "FY2024" does not. The verify loop adopts the registry's
  spelling on the persisted number and logs "exact provenance record matched
  (period "total debt FY2025" read as 2025-12-31)". A period naming another
  year still fails `period-mismatch`. Fiscal years ending outside December
  keep the calendar-year rule (Apple's "Q1 FY2026" against 2025-12-27 does
  not agree), which is why the shared rules now say: "`period` is the period
  exactly as the payload renders it (a statement column's ISO period end, a
  projection's FY label); omit it when the figure shows none."

### 11. Unprofitable overlay on financial routes (`src/pipeline/stageB/sectorRouting.ts`)

On the `bank`, `insurer` and `reit-mortgage` bases operating cash flow is not
a profitability signal (the same balance-sheet gate as the ROTE/ROIC switch
in `metricPolicy`), so the overlay is evaluated on net income alone: negative
net income still applies it, with the note ending "(net income only on the
'<base>' route)"; a negative OCF with non-negative net income records
"unprofitable overlay not applied: operating cash flow … is negative, but on
the '<base>' route OCF is dominated by loan, deposit, trading-asset and
reserve flows and is not a profitability signal (house rule); net income …
is the only trigger there."; and a financial company with no net income on
either basis records the `route.overlays.unprofitable` gap as not evaluated
even when an OCF exists. General routes are unchanged.

## Tests

- `tests/stageB.sectorRouting.test.ts` — negative OCF alone does not trigger
  the overlay on a bank, insurer or mortgage-REIT route; negative net income
  still does; a bank with no net income on either basis records the overlay
  as not evaluated even when OCF exists.
- `tests/stageB.valuation.test.ts` — `terminalRoic` (default, cap, modest
  spread, one year below, short history, thin spread, newest-five window),
  the assumption-block integration (higher EV for an evidenced compounder;
  hold note when history falls short), and the sign-disagreement growth rule.
- `tests/edgar.statements.test.ts`, `tests/keyless.test.ts`,
  `tests/edgar.client.test.ts`, `tests/dataBundle.edgarForms.test.ts` — the
  stand-ins (interest, EBIT, the bank guard, equity), the maturities
  stand-in and its overlap cases, the manifest entries, the string cik, the
  successor and IFRS wording.
- `tests/compute.runwayAnchor.test.ts` — `pickBalanceAnchor` (newer whole
  row, fallback naming the lacking field, every lacking field listed, newest
  kept when the older row is not whole either, both bare, one row).
- `tests/stageB.ttm.compute.test.ts` — the net-debt convention tests now
  expect the whole annual row to anchor when the newest quarterly row lacks a
  field (bridge 200, never the vendor 210 nor cash-as-zero 280), plus a case
  with no whole row anywhere where net debt stays unavailable and the vendor
  figure is still rejected.
- `tests/stageB.forensics.test.ts` — the four withheld signals on a
  financial route, nine on a general one.
- `tests/finra.fred.test.ts` — every catalogued series maps to a registrable
  unit; `fredFigureUnit` per transform and native unit.
- `tests/stageC.provenance.test.ts` — qualified unit spellings;
  `periodsAgree` agreement, rejection and omission cases.
- `tests/stageC.payload.passes.test.ts` — macro units in the payload and the
  registry (rates, and scaled counts, commodity prices and billions with the
  conversion note), a cited yield and a cited payrolls figure tracing, the
  fiscal-spelling period tracing with its log note while another year still
  fails, `text-source`, and the repair request's byte-identical cache
  prefix.
- `tests/jobRunner.test.ts` — repair succeeds then synthesizes (both bear
  attempts billed), repair fails → data-only with the second failure named,
  non-schema failure not repaired.
- `tests/audit.fixtureComparison.test.ts` — three dated allowlist entries
  for the terminal-ROIC hold note (the DEMO fixture has two fiscal years of
  ROIC, so the default held and only the disclosure is new).

## Live validation

Keyless rerun on 2026-09-02 (same isolated database as the sweep, no FMP
key, EDGAR + Yahoo, data-only). "Before" is the sweep or the first rerun of
the day; "after" is the build carrying every change above.

| Issuer | Before | After |
| --- | --- | --- |
| CAT | no DCF (WACC had no cost of debt; then invested capital missing) | DCF $201.02 (−74.5% vs quote); terminal ROIC = WACC 9.93% + 2.95pp (ROIC > WACC 2021–2025, median spread 5.91pp); interest and equity stand-ins in the manifest; balance anchor fell back to the 2025-12-31 annual row because the 2026-06-30 10-Q row lacks totalDebt (`valuation.balanceAnchor` info gap) |
| PFE | no DCF; then −88% (negative 3y CAGR extrapolated) | DCF $8.82 (−69.4%); near-term growth = terminal 2.5% under the no-trend rule; EBIT stand-in disclosed |
| GE | no DCF | DCF $104.03 (−68.6%); no-trend rule applied; `valuation.dcf.ttmEbitMargin` still a gap: GE files `InterestPaidNet` only in its 10-K, so the quarterly rows have no interest figure and the EBIT stand-in resolves for no recent quarter (annual EBIT is derived; TTM is not) |
| JPM | −49%, with a derived "EBIT" on the bank income statement | −49.3%; no operating-income stand-in on the bank route |
| AAPL | −64% | −62.0%; terminal ROIC = WACC 9.04% + 5pp (cap; median spread 70.44pp) |
| KO | −58% | −50.6%; terminal ROIC = WACC 6.56% + 4.81pp (median spread 9.62pp) |
| HD | −46% | −38.9%; +5pp (cap; median spread 25.49pp) |
| MSFT | −36% | −31.0%; +5pp (cap; median spread 29.35pp) |
| XOM | every statement lost ("companyfacts HTTP 200") | statements still empty, manifest names the successor registrant (Form 8-K12B) and the 10-K/20-F miss |
| TSM | "0 candidate periods" | statements still empty, manifest names IFRS (334 `ifrs-full` concepts, 0 us-gaap) |

The valuation aspect still grades F for most of these issuers. What remains
is WACC of 9–10% against a 2.5% terminal rate and a growth anchor on the
lower of two historical CAGRs — conservatism with a stated basis, not a
data defect. Any further move needs its own citable rule.

Haiku report on CAT (`ANALYSIS_MODEL=claude-haiku-4-5`, judge floored to
Sonnet, keyless data), before and after the verification changes:

| | Before (report 1) | After (report 2) |
| --- | --- | --- |
| cost | $0.83 | $1.04 |
| traced numbers | 85 | 206 |
| verified | 70 (rate 0.82) | 206 (rate 1.00) |
| unit-mismatch | 10 (nine aspect-score citations as "0-100 score", the RSI as "index (0-100)") | 0 |
| period-mismatch | 4 (three balance-sheet cells and one interest-expense cell written with labels such as "total debt FY2025") | 0 |
| unknown-source | 1 (`fred:PAYEMS`, unregistered) | 0 |

In the second report the judge wrote every period as the payload renders it,
so no citation needed the fiscal-spelling reading (the log shows zero "read
as" notes); the tolerance stays as the guard for a model that does not. The
analyst repair path was not exercised: both analyst passes validated on the
first attempt in both runs.
