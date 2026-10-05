# Valuation methodology

What Thesis computes, from which inputs, under which conventions, and where a
convention is this project's own choice rather than a standard.

The implemented behavior below was checked against the source and synthetic
tests on 2026-10-05, including the report 1.9.0 / payload 1.10.0 changes. The historical literature citations remain the project's
research rationale; a passing test validates implementation behavior, not the
predictive validity of a model or a live provider's contract.

Two rules govern everything below. Reported numeric claims use provenance
records with source and as-of information where established; missing dates,
units or currency can prevent verification. Where a rule is a house convention rather than an established method, it
says so in the same breath as the number it produces — in the DCF assumption
block, in the report's missing-data manifest, or both.

Calendar conventions (report 1.9.0 / payload 1.10.0): keyless beta uses adjacent
regular US month-end session dates for both the issuer and SPY within the
60-month window. Weekends, month-end Memorial Day and Good Friday are accounted
for; early closes count as sessions. A missing final session withholds that
month rather than filling its price. Because a daily bar can still be intraday,
the keyless caller also withholds the current UTC observation day and any future
date from beta, including after market close until the next UTC day. Quotes and
chart histories retain those bars. Exceptional exchange closures and non-US
calendars are not modeled. Keyless FRED monthly, quarterly and annual changes
look up the required calendar period, so a wholly absent row cannot shift the
denominator. Daily/weekly/biweekly transformations retain observation-count lags;
frequency inference is approximate for sparse or irregular data. Neither this
alignment nor a report's as-of stamp provides historical publication cutoffs or
ALFRED vintages; current reports use the latest available data.

Sources referred to by name throughout:

- **Damodaran**, *Investment Valuation* and the annual implied-ERP dataset
  (`pages.stern.nyu.edu/~adamodar`), for the equity risk premium, the terminal
  growth constraint, the synthetic-rating spread table, and the treatment of
  stock-based compensation in *Stock Based Compensation: The Elephant in the
  Room*, and the notes on **valuing financial service firms** for the
  equity-side excess-return model and why free cash flow to the firm and
  enterprise value are not defined for them.
- **Koller, Goedhart and Wessels**, *Valuation: Measuring and Managing the
  Value of Companies* (McKinsey), for continuing value, RONIC, and the
  evidence on how return-on-capital advantages decay.
- **FRED** (Federal Reserve Bank of St. Louis), for the risk-free rate:
  series `DGS10` (10-Year Treasury Constant Maturity), alongside `DGS2`,
  `T10Y2Y`, `T10Y3M`, `EFFR`, `CPIAUCSL`, `CPILFESL`, `UNRATE`, `PAYEMS`,
  `T10YIE`, `BAMLH0A0HYM2` and `VIXCLS` in the macro dashboard.
- **NAREIT**, *Funds From Operations White Paper*, for the FFO definition and
  its restatements.
- **Piotroski (2000)**, *Value Investing: The Use of Historical Financial
  Statement Information to Separate Winners from Losers*, for the F-score, its
  nine signals and its non-financial estimation sample.
- **Altman (1968)**, *Financial Ratios, Discriminant Analysis and the
  Prediction of Corporate Bankruptcy*, with the Z' and Z" revisions in **Altman
  (2000)**, *Predicting Financial Distress of Companies*.
- **Beneish (1999)**, *The Detection of Earnings Manipulation*, for the
  M-score, its eight indices, and its exclusion of financial institutions
  (p. 5).
- **CFA Institute** curriculum guidance on quantitative methods, for the
  distinction between a percentile of a distribution and a rank within a
  small observed sample.

---

## Input eligibility, period selection and currency

Stage A fetches and checks a bundle; `src/pipeline/compute.ts` adapts that bundle
into the pure Stage B modules. Provider availability is not itself evidence
that every field can enter a calculation. A failed fetch, a successful empty
response, an unresolved share basis, an ambiguous restatement and an unsupported
business-model metric have different reasons in the missing-data manifest.

The keyless layer in `src/pipeline/keyless.ts` requires EDGAR registrant
confirmation before substituting issuer data. Under `auto`, usable FMP rows
stand and EDGAR can append strictly older whole rows per statement family;
`edgar` rebuilds the six statement members from filed facts; `fmp` disables
older-period and predecessor append, but currently still permits EDGAR
replacement of failed/empty members. No statement row splices FMP fields with
EDGAR fields; different statement families can have different sources for the
same fiscal period. Provenance therefore belongs to each row rather than a
promise of one provider for an entire period. See
`tests/dataBundle.historyDepth.test.ts` and `tests/keyless.test.ts`.

**Instrument boundary.** `classifyInstrumentSupport` in
`src/pipeline/stageB/instrumentSupport.ts` rejects a profile explicitly marked
`isEtf` or `isFund`. Company loading, report admission and Stage B enforce that
boundary; the workflow supports individual companies. False, absent or unknown
flags do not prove that a security is a company: the classifier permits those
inputs, so identification still depends on provider evidence. ADRs are a
company overlay, not an unsupported-instrument classification.

**Whole rows and restatements.** Annual and quarterly statement normalization
uses `src/pipeline/stageB/quarterWindows.ts`. A period end must be a real,
exact Gregorian `YYYY-MM-DD`. Duplicate rows for one period survive only when
one whole row is provably later than every other row using `acceptedDate`,
or `filingDate` when acceptance is absent. Date-only recency represents the
entire day; tied or overlapping intervals, invalid recency, or missing recency
reject the whole duplicate period. Values are not selected field by field
from conflicting restatements.

**TTM.** The newest four normalized quarters are usable only when consecutive
period ends are 70–135 days apart and the newest-to-oldest period-end span is
250–320 days. If an earlier quarter is available, an interval under 70 days
into the oldest slot rejects that slot as a transition/stub period. A long gap
before the window alone does not reject it: earlier history can be missing.
The newest window drives the current TTM; the pipeline does not relabel an older
valid window as current after the newest one fails. Relevant calculations fall
back to the explicitly dated annual statement or become unavailable. Each
summed field needs all four numeric inputs; weighted-average share counts use
a four-quarter average rather than a sum. Own-history construction scans older
candidate windows separately and can retain valid windows beyond rejected ones.

**Currency evidence.** Income, cash-flow and balance rows carry their own
presentation currency. An unlabeled row may use another statement's label only
when fiscal period and filing identity establish that it is from the same
filing. Date coincidence alone and the latest annual currency are insufficient
evidence for an unlabeled quarter. Conflicting labels within that filing fail
closed. A TTM sum requires all quarters to be established in one currency.

The model uses the established TTM income currency when it agrees with the
latest annual income currency, or when that annual label is unknown; otherwise
it uses the annual currency. Cash-flow TTM must match that model currency.
Each family of history is truncated at its first incompatible
or unestablished currency observation. Growth, return denominators, capital
series, projections and own-history calculations therefore do not cross a
presentation-currency change. A dimensionless margin within one statement may
still be shown on a row that cannot enter a cross-period money calculation.
Original statement rows remain available in their own currency or labeled
unknown. No FX series or automatic conversion is supplied.

`src/pipeline/stageB/priceCurrency.ts` permits a model/quote comparison only
when both currencies are known three-letter codes and equal. Unknown currency
is an unproven comparison as well as a known mismatch. This withholds price
multiples, market-cap reverse valuations, market-value capital weights and
upside calculations. An equity-only intrinsic figure that does not require
the quote can remain in statement currency; FCFF valuation also depends on
the WACC's market-value weights. Same-currency checks do not independently
resolve ADR ordinary-share/receipt ratios: established share basis remains a
separate prerequisite.

**Analyst-estimate currency.** `src/pipeline/estimateCurrency.ts` requires the
estimate row's own `reportedCurrency`/`currency` or a documented provider
convention. The provider-convention constant is currently null. A matching
listing currency does not establish an estimate's currency. All estimate rows
must share the model currency to enter the consensus growth method; otherwise
they are disclosed as currency unknown or incompatible and excluded. Monetary
estimate/target fields with unknown currency cannot become verified money
merely because they are present in the payload.

These contracts are covered by `tests/stageB.quarterWindows.test.ts`,
`tests/stageB.ttm.compute.test.ts`, `tests/currency.quarterEvidence.test.ts`,
`tests/currency.annualCompatibility.test.ts`,
`tests/currency.priceComparison.test.ts` and
`tests/currency.analystEstimates.test.ts`.

## WACC inputs

The discount rate is never printed as a bare percentage. Every input is named
with its source and its date, in the DCF assumption block (`WACC (discount
rate)` row) and in the report's computed-returns notes.

| Input | Source | Convention |
| --- | --- | --- |
| Risk-free rate | FMP treasury rates (`year10`), else **FRED `DGS10`** | The series id and the observation date are both stated. |
| Equity risk premium | FMP market-risk-premium `totalEquityRiskPremium` for the issuer's domicile, with country-code/name alias matching; an absent or conflicting domicile row falls back to the unambiguous US row with disclosure, then the dated **Damodaran US** implied-ERP fallback if the selected input is missing or implausible | Conflicting distinct premiums for one country are not chosen by array order. The static fallback is 4.18%, dated 2026-07-01 in `returns.ts`; it requires a valid analysis date, cannot post-date that analysis, and expires after 210 days. A value outside [3%, 25%] falls back. This domicile rule is a house assumption, not an estimate of geographic revenue exposure. |
| Beta | Provider profile beta, **mean-reversion adjusted** (0.667·raw + 0.333 — the Bloomberg 2/3–1/3 weighting of Blume's finding, not his fitted 0.371 + 0.635·β; see [RESEARCH §7.1](RESEARCH.md)), clamped to [0.6, 2.0] | Raw beta outside (0, 4] is unusable and the WACC fails closed rather than inventing market exposure. One set of constants serves the WACC and the keyless beta estimate, so a report prints one adjusted beta. |
| Cost of equity | rf + beta × ERP | Clamped to [rf + 2.5%, 25%]. |
| Cost of debt | `effective` (interest expense ÷ average debt), `historical` (the issuer's last year that still disclosed interest), or `synthetic` (rf + rating spread from interest coverage, Damodaran's January 2026 table) | The method actually used is named. An effective rate outside [rf − 1, rf + 19] is rejected in favour of the synthetic rating. Debt below 2% of assets is treated as noise, and the note says whether a synthetic rating then ran. Interest expense and the EBIT it is scored against come from **one** statement basis — the trailing twelve months when both are available, else the latest annual statement for both legs — and the basis is named; a mixed pair is the last resort and is labelled as such. |
| Tax rate | Select the first ratios-TTM row, or the first annual-ratios row when no TTM row exists; use its effective-rate field, otherwise TTM tax expense ÷ pre-tax income | A present TTM row lacking tax does not cause a second lookup in annual ratios. Clamped to [0%, 35%]. Where it came from is named. No universal statutory rate is assumed. |
| Weights | Market value of equity (market capitalisation) and book debt as a market-value proxy: total debt **less the operating-lease liability** where the balance sheet discloses it (the EV bridge's lease rule, below), averaged over the two quarter-ends of the trailing-twelve-month window when the interest figure is TTM, else over the latest two fiscal-year ends | Stated as E% / D%, with the pair of balances and the lease basis named. When the statements' currency differs from the quote currency (the ADR case) the weights are suppressed rather than silently mixed. On the financial routes, which value on the cost of equity alone, a WACC-only shortfall is disclosed as a warning rather than blocking the report. |

The final WACC is clamped to [max(6%, rf + 1%), 20%]; a clamp that moves the
rate by 0.5pp or more is disclosed in the manifest, because it materially
changes the discount rate.

**Per-fiscal-year WACC.** The ROIC-versus-WACC history recomputes the WACC at
each fiscal year end from the risk-free observation on or before that date,
holding beta, ERP, the E/D weights and the tax rate constant. A *synthetic*
cost of debt moves with the risk-free rate, because it is rf + spread; an
observed effective rate is held, because it is a fact about that issuer's debt.
An observation more than 14 days before a year end is not that year's rate and
is rejected. Years that cannot be recomputed are named, and the note then says
the current WACC was applied to them. FRED history is fetched five years back,
so roughly five fiscal years can carry their own rate.

---

## Growth, annual returns and capital diagnostics

`src/pipeline/stageB/growth.ts` reports requested 1/3/5/10-year revenue,
diluted-EPS and before-SBC FCF CAGRs as `(end/start)^(1/years) − 1`.
Non-positive endpoints or sign flips withhold the CAGR. Short history degrades
to the available span, with `actualYears` and dates shown. A material difference
between row-count span and elapsed-date span (more than 0.1 years) uses elapsed
years and records irregularity. Margin trends use gross/operating/net income
over positive revenue, up to ten annual observations, and OLS slopes in
percentage points per elapsed year with at least three usable points. Named
valuation/scoring consumers separately check that a degraded CAGR actually
matches the window they require.

`src/pipeline/stageB/returns.ts` computes up to five annual return observations.
ROIC is annual `EBIT × (1 − observed effective tax rate) / invested capital`,
with the tax rate clamped to [0%, 35%], invested capital equal to debt plus
stockholders' equity less cash and short-term investments, and the operating
lease adjustment described below. An unavailable observed tax rate withholds
that year's NOPAT/ROIC; non-positive invested capital is not interpreted as
an exceptional return. This historical NOPAT is separate from the forward
DCF's projected loss-carryforward logic.

When short-term investments are genuinely unreported, returns can instead net
cash alone and disclose that narrower invested-capital basis. Conflicting
combined cash/component values do not qualify for this fallback; they withhold
the affected invested capital and return.

ROTE is income available to common / average tangible common equity, with
preferred allocations required when preferred equity is outstanding. Tangible
common equity subtracts goodwill, other intangibles and preferred from equity.
DuPont reports `net margin × asset turnover × equity multiplier = ROE`, where
the factors are NI/revenue, revenue/average assets and average assets/average
equity. Matching annual return balances use the 45-day tolerance in `returns.ts` and
adjacent annual averaging rule below. Missing eligible prior balances use a
disclosed single-period denominator. ROTE is retained on the financial routes
where ROIC is inapplicable; it is not computed by substituting a vendor ROE.

`src/pipeline/stageB/capital.ts` derives capex/revenue, capex/D&A, before- and
after-SBC FCF conversion, share trends, SBC intensity, interest coverage and
net debt/EBITDA where the route permits them. Conversion requires positive
net income, and leverage requires positive EBITDA. Maintenance capex
`min(abs(capex), D&A)` and growth capex `max(0, abs(capex) − D&A)` are house
heuristics, not a filed maintenance/development split.

Buyback price discipline is a proxy: within each fiscal cash-flow window,
average the available market-cap history and divide by basic weighted-average
shares (diluted fallback disclosed). Negative repurchase cash flow is converted
to positive dollars spent; implied shares bought equal spend / proxy price.
The aggregate price is total covered spend / total implied shares. Its
premium/discount is `(current price − proxy paid price) / proxy paid price`;
positive means the current price exceeds the proxy paid price. Partial dollar
coverage is disclosed. It is not the actual transaction-price record and is
withheld for ADRs or unmatched/unknown quote/statement currencies.
See `tests/stageB.growth.returns.capital.test.ts`,
`tests/stageB.returnsCurrencyAndIc.test.ts` and `tests/stageB.rote.test.ts`.

## Growth anchor

The separate **revenue acceleration** diagnostic is latest YoY growth minus
the three-year revenue CAGR. Its benchmark must span three actual years within
±0.05 years for fiscal-calendar variation. A degraded two-year CAGR or a four-year
span cannot serve as that benchmark: the benchmark, difference and direction
are withheld with a manifest explanation. The underlying CAGR series still
discloses its available span; the valuation methods below keep their own rules.

Near-term revenue growth is the **median of every method the data supports**,
with the full range shown and each method's value named:

1. **Log-linear regression** of ln(revenue) on elapsed years, over *all*
   annual years on record. Reported with its slope, R² and n. Using every year
   means a spike or a collapse inside the window shows up as a poor fit rather
   than moving the anchor.
2. **Three-year revenue CAGR**.
3. **Five-year revenue CAGR**.
4. **Analyst-consensus case**, when FMP analyst estimates exist: the average
   implied growth over the next two fiscal years. The first leg is annualised
   by day count when the TTM window and the first estimated year end are not a
   full year apart, and is skipped entirely below 90 days as too noisy.

The point estimate is the median; the range is min..max across the available
methods. Methods that could not be computed are named in the assumption block
and disclosed as a `valuation.dcf.growthAnchor` manifest entry.

A three- or five-year CAGR enters the anchor only when its measured span is
its window: a CAGR whose `actualYears` differs from the window by more than
0.25 years (`CAGR_SPAN_TOLERANCE_YEARS`, the tolerance grading uses, applied
through `windowCagr` in `growth.ts`) is excluded and listed as unavailable with
its measured span, e.g. "measured span 2.00 years, not the 3-year window". With
two annual years of history both windows are excluded rather than counting one
two-year rate twice. The degraded CAGR series is still displayed with its span.

The median is then **clamped to [−10%, +25%]**, and the anchor the report
prints is the clamped value — the same number the growth path fades from.
When the clamp moves it, the anchor's basis says so, the growth-path basis
repeats it, and the assumption row reads "25.0% (…, clamped from the 65.0%
median)". Nothing prints the pre-clamp median as if it were the anchor.

**Three of the four methods read the same series.** The regression, the 3-year
CAGR and the 5-year CAGR are all functions of the same annual revenue history,
so when all four are available, three inputs reflect correlated historical
evidence. For four inputs the median averages the two middle values; consensus
outside the historical range can still change which historical pair is averaged
(5%, 10%, 15%, 100% gives 12.5%, versus a historical-only median of 10%). Every
available method receives one place in the sorted median, but those places are
not independent votes. When only one method is eligible, including consensus,
it supplies the anchor alone, subject to the same clamp; no range is available.
The printed method count, unavailable methods and range disclose these limits.

**Two rules were retired here, and the assumption block says so.** The former
"lower of the 3Y/5Y CAGR" rule let whichever window happened to be worse
decide ten years of growth — that is a coin flip on the window, not
conservatism. The former sign-disagreement rule replaced the anchor with the
terminal rate whenever the two windows disagreed in sign, discarding the whole
revenue history on the strength of two endpoints. Both are gone; the
regression's R² is where an erratic history now shows up.

---

## Fade and horizon

The explicit horizon is **10 years**, stated in years in the assumption block.
Growth fades linearly from the anchor in year 1 to the terminal rate in year
10. The EBIT margin fades from the current margin to a target over 5 years and
is held flat thereafter; the target is the five-year median, or the better/
worse of median and current under a dated improving/declining margin regime
(a slope of more than ±0.5pp per year). The tax rate fades from the observed
effective rate to the company's own historical median; when no current rate
can be observed (a pre-tax loss, a missing tax line) the path is held at that
median and the basis says so. Cash flows are discounted on the **mid-year
convention**.

**Two guards bound the paths.** The EBIT-margin path is held inside
[−20%, ceiling], where the ceiling is 45% or the highest margin in the
issuer's own five-year history, whichever is higher — a cap that never binds
below a margin the company has demonstrably earned (the TTM figure is not
evidence for its own cap), and one note when it binds. Sales-to-capital is
held inside [0.5, 5]. Both are broken-input guards in the sense of
[RESEARCH §7.5](RESEARCH.md), not views on what a company can earn: they exist
so that a mis-scaled statement cannot print a confident number.

EBIT itself is the issuer's operating income: the filed line where the filer
reports one, otherwise a derivation from pre-tax income that adds back interest
expense and removes the non-operating results the filing discloses. It is never
pre-tax income plus interest on its own. That sum reintroduces every
non-operating item the derivation removed, and where the derivation is refused
outright — a bank, where interest is an operating cost, or a non-operating
aggregate that already contains the interest being added back — EBIT is
withheld and named in the missing-data manifest rather than published under a
second name.

Terminal growth is **min(2.5%, risk-free rate)** — nothing grows faster than
the risk-free rate in perpetuity (Damodaran). Like the terminal-ROIC rule below
it prints as a HOUSE CONVENTION, in those words, wherever it appears. A Gordon guard requires
WACC − g ≥ 2.0pp in the base case (1.5pp in the sensitivity grid, where a
tighter guard would blank cells the grid exists to show); when it binds, g is
pulled down and the note says so.

---

## Terminal value house convention

**This is a house convention, not a standard, and it is labelled as such
wherever it is printed.**

The default terminal ROIC equals the WACC: growth adds nothing after the
explicit horizon. That is the Koller/Goedhart/Wessels recommendation for most
firms. Applied to every issuer, however, it values an evidenced compounder as
if its returns collapsed to the cost of capital in year 11.

So: the implementation sorts computable annual ROIC observations newest-first
and inspects at most five. When ROIC exceeded the applicable WACC in **all of
at least four of those observations**, half the median spread is carried in perpetuity, capped at
**5 percentage points**. A carried spread below 0.5pp is treated as noise and
the default holds. Anything short of that evidence keeps the default, and the
reason is written into the assumption notes. Missing-ROIC years are excluded
before this test, and the helper does not require that the retained annual
dates are consecutive; this is evidence from available observations, not proof
of four uninterrupted years. This follows McKinsey's RONIC
guidance (a top-quintile ROIC advantage roughly halves over 10–15 years rather
than closing) and Damodaran's allowance of perpetual excess returns only when
they are modest.

Each fiscal year is compared to **its own** WACC where one could be recomputed
(see *WACC inputs* above); otherwise the current WACC is applied to that missing
year and the note names the fallback years. Any year that could not be recomputed also
reaches the missing-data manifest as `returns.wacc.history`, including the
partial case where only some years are missing. When a history is supplied but
no year carries a computable ROIC there is no comparison at all, and the note
says that — not that a risk-free observation was missing.

The per-year WACCs are always recomputed from **FRED `DGS10`**, while the
current WACC prefers the provider's own 10-year treasury rate and falls back to
`DGS10`. When those two differ, the returns notes say so explicitly: the newest
fiscal year's own WACC can then differ from the current one because the two
rates come from different series, not because the rate moved.

Terminal reinvestment is g ÷ ROIC_terminal, Damodaran's consistency rule.

---

**The sensitivity grid keeps the excess, not the level.** Each cell of the
WACC × g grid re-runs the DCF with the terminal ROIC at that cell's WACC plus
the base case's evidenced excess, so a row one point below the base WACC does
not earn a phantom point of excess return and the g-axis reads the same way in
every row; the grid note states the excess it held.

## FCF and SBC

**Free cash flow subtracts stock-based compensation by default.** The
cash-flow statement adds SBC back to operating cash flow because no cash left
the building that period, but the expense is real: it is settled in newly
issued shares, and the bill lands on existing holders as dilution. Damodaran's
treatment in *Stock Based Compensation: The Elephant in the Room* is to treat
it as an operating expense that should not be added back.

Both figures are reported and never conflated:

- `fcfBeforeSbc` — a finite supplied `freeCashFlow` value takes precedence;
  otherwise operating cash flow + capital expenditure (capex arrives negative)
  is derived and labeled. This is the before-SBC vendor convention.
- `fcf` — the same figure less SBC, the house default.

For a row with computable FCF, missing or numeric-zero SBC is treated as
undisclosed by this implementation and left unadjusted, with a note on that row. The info-level
`capital.fcf.sbc` manifest entry applies when the latest row has computable FCF
but no usable SBC; older affected rows have row notes rather than separate
manifest entries. A negative SBC credit is retained with its sign and increases
after-SBC FCF. SBC as a percentage of FCF is measured
against the **before** figure: dividing SBC by an FCF it has already been
subtracted from would count it twice.

Every surface that prints a free-cash-flow figure names which one it is. The
payload and the data-only report label the rows "after SBC, house default" and
"before SBC, vendor convention", and both series are shown. Two conversion
ratios are published the same way, and the **before**-SBC one is the ratio the
balance-sheet grade scores, under a driver named `fcfConversionBeforeSbc`: that
is the definition the conversion band was calibrated on, and grading the
after-SBC ratio against it would charge the same expense twice, because SBC as a
percentage of free cash flow is already one of the five scored metrics. The
aspect note states the definition. Price to free cash flow uses the **before**
figure — the same basis as the own-history distribution it is ranked in — and is
labelled "P/FCF (before SBC)" wherever it renders, with the basis string saying
that the capital block's house-default figure is a different number.

The FCFF discounted-cash-flow model projects revenue, EBIT margin and
reinvestment. SBC is already an operating expense inside that EBIT, so it is
never added back there either. The DCF and the free-cash-flow metric are
consistent, but they are not the same series, and the assumption block says so.

---

## Dilution

Dilution from outstanding awards is reported as the gap between the **diluted**
and **basic** weighted-average share counts of the latest fiscal year, with the
as-of date and the overhang in percent. It reaches readers as a capital figure
in the Stage C payload and as a capital-allocation note in the data-only
report, and the note is emitted in BOTH states — the unavailable case says so
in words rather than going silent. A missing count is disclosed
(`capital.dilution`), never assumed to be zero.

Stock-based compensation is subtracted from free cash flow **with the sign the
filer reported**. The us-gaap element is a positive add-back inside operating
cash flow, so a negative figure is a net credit — forfeiture reversals
exceeding the period's awards — and it is added back rather than charged. Awards that are antidilutive in
a loss year are excluded from the diluted count by the filer, so a loss-making
issuer's overhang understates the award pool; the note says this.

Separately, the five-year diluted share-count trend reports buyback, dilution
or flat (within ±1%), annualised over the span actually available.

Per-share values use the weighted-average diluted count from the newer of the
latest quarterly and latest annual income statement; when only the annual count
is available, the report says the figure may lag recent buybacks or issuance.

---

## Stock splits and the share basis

A share count or per-share figure is used only on the share basis of the price
it meets, and withheld when that basis cannot be established (decision D-30 in
[`docs/audit/DECISIONS.md`](audit/DECISIONS.md); code in `src/edgar/splits.ts`).

**Dates.** A split has an announcement (the earliest filing that tags it), a
record date, a legal-effective moment, and a first split-adjusted trading
session; the filer's XBRL context date for
`us-gaap:StockholdersEquityNoteStockSplitConversionRatio1` may be any of them
and is treated as accounting context only. NVIDIA's 10-for-1 of 2024 is the
reference case: legally effective 2024-06-07 at 4:01 p.m. Eastern (Form 8-K,
accession 0001045810-24-000144), first split-adjusted session 2024-06-10,
tagged in companyfacts for both dates.

- The **first split-adjusted session** comes only from the price vendor's split
  event. A quote is on the basis of its own session; a split-adjusted history is
  on the basis of the last session it was adjusted through.
- Without a vendor event, the first session is bounded to 7 days before the
  earliest context date through 60 days after the latest one (narrowed by the
  sessions the vendor covered without listing it); a price dated or a count
  filed inside the bound is withheld.
- **Legal effectiveness** decides a filing's side: a statement figure filed
  after it is restated to the split (ASC 260, SAB Topic 4C). It is taken to fall
  no earlier than the earliest context date or 7 days before the first
  split-adjusted session (NVIDIA: 3 days); a figure filed between that bound and
  the first session is withheld. A cover-page count is a count as of its own
  date, so one measured before the split and filed after it is withheld.
- A split both sources describe is applied once. A split only the vendor lists
  (companyfacts carries the ratio only from the next periodic report) is applied
  from the vendor's event. A tagged split the vendor's covering list does not
  contain, or lists with another ratio, is unresolved, and every figure filed
  before it is withheld.
- Vendor events within 7 days of each other describe one split. When they
  disagree on the ratio or the session (Yahoo's daily history says 4-for-1 and
  its full list 5-for-1), the split is unresolved and its figures are withheld;
  the descriptions are never compounded. Identical descriptions are one event.
- Each retrieved answer retains its own source, events and coverage. If one
  answer lists a split that another covering answer omits or describes with a
  different ratio, the event is unresolved regardless of how far apart the
  reported dates are. A merged list cannot turn contradictory answers into
  multiple splits. A request that does not cover the event, or failed, does
  not contradict it. Warnings name the individual answers that disagree.
  A count measured before an unresolved event remains withheld even if its
  filing came afterward; the later filing alone does not establish its basis.
- A vendor list that was not retrieved establishes nothing: without one, and for
  any day it does not cover, no filed share count is put on a price's basis.
  Coverage spans join only where they overlap or touch; a gap of any length,
  weekend or not, is uncovered, and a session after the coverage ends is too.
- A Yahoo split event whose numerator or denominator is zero, negative or equal
  to the other makes that answer's split list unavailable (its prices stand).

**What is withheld, and what stands.** Withheld figures are left empty at the
source — EPS and share counts on the statement rows, the keyless market cap,
market-cap history, enterprise values and free float — so no downstream
calculation can rebuild them: EPS growth, P/E from EPS, DCF and excess-return
per share, the reverse DCF, REIT price × shares (P/FFO, P/AFFO), the share-count
trend, dilution, the grades built on them, and the AI payload all read the empty
value. Figures that need no share count (revenue, margins, free cash flow,
capex, EV/sales on a vendor market cap) are unaffected.

**Provider conventions, mapped to the fields used.** "Documented" means stated
by the provider; "tested" means exercised by a test in this repository. No test
here calls a live provider: every tested behaviour is on synthetic responses.

| Source and field | Adjustment basis | Documented | Tested here |
| --- | --- | --- | --- |
| FMP `historical-price-eod/full` `close` | split-adjusted, as of the day served | yes — FMP FAQ (site.financialmodelingprep.com/faqs, as read by the reviewer on 2026-09-30; not fetchable from the build environment): "close is split-adjusted" | synthetic rows: a series served before a split is priced on that day's basis (`tests/keyless.splitBasis.test.ts`) |
| FMP `adjClose` | splits and dividends | yes — same FAQ | not used by this code |
| FMP `quote`/`profile` `price`, `marketCap` | the quote's own session | current values; the FAQ's history statement does not apply | vendor market cap used as served (P/E fallback), unverified |
| FMP `shares-float` `outstandingShares`, `enterprise-values` `numberOfShares` | "historical prices and shares outstanding are adjusted for splits" | by the FAQ's wording, which names no endpoint or field | not tested |
| FMP `income-statement` `eps`, `epsDiluted`, `weightedAverageShsOut`, `weightedAverageShsOutDil` | not stated by the FAQ | **no** | for a row for a period before a known split, each field is kept only when it matches the filer's same field on the same basis (±3% relative to the filer's magnitude; zero must match exactly); no absolute EPS allowance can approve a large proportional difference in a small amount. A field that does not match, or that the filer does not state, is withheld on its own, and EPS is never rebuilt from net income (`guardVendorShareFields`) |
| FMP `key-metrics`, `ratios` (own-history multiples) | ratios of price to per-share figures; basis-invariant only if both sides share one | not stated | not tested |
| FMP `analyst-estimates` `epsAvg` | not stated | **no** | not tested; shown as "currency unknown" and not registered (D-28) |
| Yahoo chart `close` | adjusted for the splits the same answer lists | no published contract (unofficial endpoint) | synthetic responses only |
| Yahoo chart `adjclose` | splits and dividends | no published contract | synthetic responses only (beta) |
| Yahoo chart `events.splits` | dated by the first split-adjusted session; `numerator`/`denominator` post:pre | no published contract | synthetic responses only (`tests/yahoo.client.test.ts`) |
| SEC companyfacts share and per-share facts | as filed, each with its own filing date | SEC | `tests/edgar.splits.test.ts`, `tests/edgar.statements.test.ts` |

---

## EV bridge

Enterprise value is computed the same way everywhere it is used:

```
EV = market capitalisation
   + total debt
   + preferred stock
   + minority interest (non-controlling interests)
   - cash and short-term investments
```

Preferred and minority interests are claims senior to common equity, so they
belong in EV; undisclosed means zero, following the provider's convention. The
DCF's equity bridge is the same identity read backwards: equity value =
EV − net debt − minority interest − preferred equity.

`src/pipeline/stageB/netDebt.ts` owns the `NET_DEBT_V1` resolver: debt minus
the combined cash-and-short-term-investments field, or minus both separately
disclosed cash components when the combined field is unavailable. Negative
total debt, absent debt, missing cash components, or contradictory combined
cash evidence withholds house net debt. Combined cash below reported cash,
or disagreement with the component sum beyond `max(1, abs(combined) × 1e-6)`
is a conflict; it cannot fall back to a narrower cash-only convention. Vendor
net debt is diagnostic evidence only, because it can omit short-term investments.
The anchor compares the latest quarterly and annual whole rows. It selects the
newer unless that row lacks finite debt, stockholders' equity or combined cash
and the older row has all three; then it uses the older whole row with a note
and info gap. When neither is complete, the newer remains selected and missing
inputs withhold affected results. The bridge never assembles debt and cash from
different fiscal periods.

**The OPERATING-lease liability is excluded by default; the finance-lease
liability is not.** The option to keep the operating slice in is
`THESIS_EV_INCLUDE_LEASES=1`. The split is the whole point. Under US GAAP
(ASC 842) operating-lease cost stays in operating expenses, so EBIT and EBITDA
are already *after* it and adding that liability to EV as well double-counts the
leases in EV/EBITDA. Finance-lease cost is split between right-of-use
amortisation, which is included in EBIT and added back in EBITDA, and interest,
which sits below EBIT ([ASC 842, 842-20-45-4](https://storage.fasb.org/ASU_2016-02_Section_A.pdf)). The finance-lease liability remains financing debt in both frames
and stays in enterprise value and in net debt, always. The provider's
`totalDebt` contains both, so the default subtracts the operating slice back out
and leaves the finance slice where it is.

Only the EDGAR route resolves the split: the lease chain there sums a separately
resolved operating and finance liability, and the operating slice is published
as its own balance-sheet field. FMP publishes one combined
`capitalLeaseObligations` and no split, so on that route **no lease adjustment
is made at all** — enterprise value is reported as-is and an info-level
`valuation.multiples.enterpriseValue.leases` manifest entry says that removing
the combined figure would strip an unknown amount of finance-lease debt out of
EV. The same entry fires when no lease liability is disclosed at all. Nothing is
guessed, and nothing unknown is netted.

Both enterprise values — as reported, and less the operating-lease liability —
are computed, together with the total lease liability and its finance slice.
They are published in the EV bridge basis string, which is a computed valuation
note and is quoted verbatim into the EV/EBITDA and EV/sales basis lines and into
the DCF equity-bridge note; there is no separate assumption-block row for them.
Turning the option on raises a warning-level manifest entry stating that
EV/EBITDA then pairs a lease-inclusive numerator with a lease-expensed
denominator and is not comparable to the default basis. The DCF equity bridge
follows the identical convention through net debt, so the two can never
disagree.

**Invested capital and the WACC's debt leg share the lease basis.** ROIC's
invested capital (debt + equity − cash and short-term investments, with the
disclosed cash-only fallback when investments are unreported) and the
average debt behind the effective cost of debt and the E/D weights remove the
same operating-lease slice by default and keep it when the option is on, so
the discount rate, the return on capital and the enterprise value are on one
basis: NOPAT and interest expense are both after operating-lease cost under
ASC 842, and a lease-inclusive denominator understated ROIC for every
lease-heavy issuer (a discount retailer: 6% on the inclusive base against 11%
on the consistent one) and could push the effective rate below the acceptance
band. Where no split is disclosed the ROIC notes say the provider's total
debt, lease liabilities included, was used unadjusted.

**Annual return denominators require adjacent balances.** ROIC, ROTE and
DuPont average the closing balance with the balance matched to the next older
annual income period only when the two balances are 300–430 days apart, the
same fiscal-continuity range used by the forensic layer. This accommodates
52/53-week calendars. A missing year or a shorter transition stub uses the
existing single-period denominator and records a warning instead of silently
averaging capital from nonconsecutive years.

**The own-history enterprise value carries the same adjustment.** Each
historical quarter window removes *its own* operating-lease liability whenever
the current EV removed one, so the rank compares like with like. A window whose
balance sheet discloses no operating-lease liability cannot be put on that basis;
its EV/EBITDA and EV/sales are dropped from the distribution — never ranked
against a differently-defined history — and the count of dropped windows is
disclosed as `valuation.multiples.ownHistory.evLeaseBasis`. The vendor's
pre-baked EV ratios are built on the vendor's own lease-inclusive enterprise
value, so when the adjustment fires those bands are withheld under the same
manifest entry rather than published on a basis the current number does not
share.

---

## Multiples and own-history ranks

Current multiples are computed from raw statement fields, never from a
vendor's pre-baked ratio. Which multiples are meaningful depends on the route:
banks and insurers never get EV multiples, because debt is their raw material;
equity REITs lead with P/FFO and P/AFFO.

The own-history figure is a **rank among N quarters**, not a percentile. The
window is 8 to 20 quarterly observations — far too few to estimate a
percentile of a distribution, and CFA Institute guidance is to describe such a
figure as a rank within the observed sample. The numeric field keeps its
historical name for backward compatibility with persisted reports, but its
description, every rendered label, the basis strings and the missing-data
reason all say rank.

**N is rendered beside the rank**, not left in a note: the multiples row carries
`ownHistoryObservations`, and every surface prints it the same way — "rank
62/100 of 12 quarters" in the Markdown and print-HTML exports and on the app's
own-history bar (the app had dropped the "/100", so a 0–100 rank read as a rank
among the quarters; audit 2026-09-06, F214). A report persisted before that field existed still parses and
still renders, without inventing an N. The field is optional in Zod for exactly
that reason and is stripped from the judge's request schema — the judge never
authors this table (`applyMultiples` replaces it wholesale from computed
numbers), so carrying it costs nothing against the request schema's
optional-parameter budget. The score drivers built from the rank are named
`peOwnHistoryRank`, `priceToTbvOwnHistoryRank` and `pFfoOwnHistoryRank` with
unit `rank`, the valuation aspect note says rank, and the Stage C prompt
instructs the model in the same terms, so the narrative cannot call it a
percentile either.

Fewer than 8 quarters produces no rank at all. Fewer than 20 (a full five
years) flags the window as low-sample, because at those sizes the 5th and 95th
percentiles track the near-minimum and near-maximum rather than stable
quantiles; the median and quartiles remain robust. A multiple rendered "n/m"
(a negative or zero denominator) loses its rank too, so the report can never
show a rank for a number it declines to print.

Peer medians are trimmed of n/m values and 1.5×IQR outliers and suppressed
below four surviving peers. Peer multiples are not currently supplied by the
pipeline; that is disclosed as a missing input, not reported as a finding that
the company has no peers.

---

## Financial-company routes

How a company is routed, what each route withholds and why, how a financial is
valued instead, which route metrics are computed, and how FFO and AFFO are
defined. Decisions D-16 and D-17.

### Routing

#### Three inputs, in order

A company's base route is decided by the vendor industry string, the SEC SIC
code, and tag evidence read from EDGAR companyfacts.

1. **Industry prefix** (case-insensitive, trimmed): `Banks…` → bank,
   `Insurance…` → insurer (except `Insurance - Brokers`, which is fee-based and
   goes to the general map), `REIT…` → REIT.
2. **SIC fallback**, consulted only when there is no industry string at all. A
   known industry that matched no prefix — credit services, mortgage finance,
   asset management, exchanges, and every
   non-financial industry — is a decided classification and goes to the
   general map (the FIN-OTHER treatment); the SIC is not consulted behind it.
   With no industry: 6020-6036 (depository institutions; major group 61,
   non-depository credit, has no deposits and stays FIN-OTHER) → bank,
   6300-6399 (insurance carriers) → insurer, 6400-6499 (agents, brokers and
   service) → the general map, 6798 → REIT (sub-map undecided; see *The REIT
   sub-map* below),
   sector "Financial Services" → the general map.
3. **XBRL evidence** (`src/pipeline/stageB/routingEvidence.ts`), read-only from
   the bundle's companyfacts payload. Broad financial labels (`Capital Markets`,
   `Financial - Capital Markets`, `Financial Conglomerates` and diversified
   financial-services labels) are refined to the bank map when recent deposits
   and loans or net interest income corroborate a deposit-funded business.
   Explicit fee-based insurance-broker industry or SIC classifications retain
   their general route; conflicting evidence is disclosed. No ticker overrides
   are used.

#### What the tags decide

| Evidence | Conclusion |
| --- | --- |
| deposits **and** (loans **or** net interest income) | bank |
| premiums earned **and** loss or policy reserves | insurer |
| `RealEstateInvestmentPropertyNet` / `…AtCost` | equity REIT |
| mortgage-backed securities **or** mortgage loans held for investment, **and no** investment property, **corroborated** (see below) | mortgage REIT |

Deliberate properties:

- **A single line item is not a business model.** Deposits alone do not make a
  filer a bank; a loan or net-interest-income tag must accompany them. An
  industrial holding customer deposits is not misrouted.
- **The tags in a group name the business model.** The mortgage-REIT groups
  carry only elements whose names are mortgage-specific
  (`MortgageBackedSecurities…`, `MortgageLoansOnRealEstate…`,
  `LoansReceivableHeldForInvestmentNet`). Generic elements —
  `AvailableForSaleSecuritiesDebtSecurities` and its two spellings, which is
  what any corporate treasury tags for its bond portfolio, and
  `NotesReceivableNet` / `LoansAndLeasesReceivableNetReportedAmount` /
  `FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLoss`,
  which is what a manufacturer with vendor financing tags — are **not** in them.
  They were, and they routed ordinary industrials to the mortgage-REIT map,
  which suppresses the DCF, the reverse DCF, EV/EBITDA and ROIC−WACC, drops
  Piotroski to three signals and leads the report with book value per share.
- **Two rules fire on a single tag group.** Evidence sets a route where no
  classification has decided one, or refines a broad financial label using the
  corroborated bank rule above. Bank evidence needs two groups and insurer
  evidence needs two; the equity-REIT rule (investment property) and the
  mortgage-REIT rule fire on one. The mortgage rule is the weakest evidence the
  module produces: before it may SET a base route, either the repo funding a
  levered mortgage book cannot run without
  (`SecuritiesSoldUnderAgreementsToRepurchase`) or an already-financial
  SIC/sector must corroborate it. Either single-group rule may set a route
  only on a profile with no industry string, or one whose SIC or sector already
  says "financial"; against a declared non-financial industry and SIC (a
  taxable real-estate operator that tags investment property, an industrial
  with vendor financing) the tags are filed as `route.evidence.conflict`
  (`warn`) and the route is left where it was.
- **A retired tag cannot classify a filer today.** A tag counts only when its
  newest non-zero fact, from a core form (10-K/10-Q/20-F/40-F and their amendments,
  after the max-`filed` dedup), falls within 24 months of the newest evidence
  fact on file.
- **The property tag wins for hybrids.** A REIT that files investment property
  *and* mortgage assets is an equity REIT; the mortgage classification requires
  the absence of investment property.

#### Evidence confirms or contradicts; it does not silently override

- Neither industry nor SIC matched → evidence **decides** the base route, and
  the note names the tags, their values, their period ends, and the industry and
  SIC inputs that failed to decide. Two qualifications: the mortgage-REIT rule
  fires on a single tag group and must first be corroborated (*What the tags
  decide*); and
  "neither matched" means there is no industry string, or the SIC or sector
  already says "financial" — a known non-financial industry beside a
  non-financial SIC is itself a classification (major groups 65 and 66,
  real-estate operators and developers, are not financial for this purpose),
  and evidence against it is filed as `route.evidence.conflict` and changes
  nothing.
- Industry/SIC matched and evidence agrees → the note records the confirmation.
- A broad financial label with corroborated bank evidence → refine to bank,
  explicitly naming the label and supporting facts in the route note.
- A specific industry/SIC matched and evidence disagrees → **the declared classification
  stands**, and the disagreement is filed as `route.evidence.conflict` (`warn`).
  A vendor string and an SEC code are evidence too; the honest outcome is a
  disclosed conflict, not a silent re-route.
- Companyfacts unavailable → `route.evidence` (`info`), raised only for
  financial candidates, so an ordinary industrial's manifest is not padded with
  a check that was never relevant.

#### The REIT sub-map, and why SIC 6798 cannot decide it

SIC 6798 is "Real Estate Investment Trusts" and covers equity and mortgage REITs
alike. The two maps disagree about which metrics are meaningful: FFO is the
equity REIT's earnings measure and is close to meaningless for a mortgage REIT,
whose assets are marked securities and whose headline is book value.

The sub-map is therefore decided by evidence or by an explicit vendor sub-type,
never by the SIC:

- `RealEstateInvestmentPropertyNet` present → **equity**.
- Mortgage assets present without investment property → **mortgage**.
- Vendor industry naming a sub-type (`REIT - Mortgage`, `REIT - Industrial`) →
  that sub-map. A vendor mortgage label contradicted by filed investment
  property is kept but flagged (`route.reitSubmap.conflict`).
- Otherwise → **`undetermined`**.

A keyless profile derives its industry string from the SIC map itself, so
`REIT - Diversified` on SIC 6798 carries no information beyond the SIC and is
**not** read as a vendor sub-type. Treating it as one would launder the SIC into
evidence it is not.

`undetermined` withholds **both** metric families — FFO, AFFO, P/FFO, the AFFO
payout ratio and the implied cap rate on one side; book value per share, the net
interest spread and assets/equity leverage on the other — with the reason on the
`route.reitSubmap` manifest entry. Publishing either set would assert a business
model the evidence does not support.

### Valuing a financial company

#### What is withheld, and why

Damodaran's treatment of financial service firms is the authority for the
central point: for a bank, an insurer or a mortgage REIT, debt is **raw
material**, not financing. Four consequences, each withheld with a stated reason
in the notes and the missing-data manifest:

| Withheld | Manifest key | Reason |
| --- | --- | --- |
| FCFF/WACC DCF | `valuation.dcf` | FCFF is before debt service, but debt, cash and reinvestment cannot be separated reliably into operating and financing items for these balance sheets ([Damodaran](https://pages.stern.nyu.edu/~adamodar/pdfiles/papers/finfirm09.pdf)) |
| FCFF reverse DCF | `valuation.reverseDcf` | inverts the same model; the growth or margin it solves for inherits the same category error |
| EV/EBITDA | `valuation.evEbitda` | enterprise value adds debt and subtracts cash, both operating items here — a profitable bank can show a negative EV |
| ROIC − WACC | `returns.roicVsWacc` | invested capital (debt + equity − cash) is undefined when deposits, policy reserves or repo fund the assets and cash is itself an earning asset |

Industrial FCF, FCF conversion and growth, P/FCF, net debt/EBITDA, EBIT interest
coverage, maintenance-capex heuristics, and gross/operating-margin scoring are
also withheld on these routes. Their missing inputs are not treated as data
failures. Common-share issuance, repurchases, dilution and SBC/revenue remain
useful and are retained.

Equity REITs additionally withhold a **net-income DCF**
(`valuation.netIncomeDcf`): GAAP net income is struck after real-estate
depreciation, a large non-cash charge against assets that typically hold or gain
value, so discounting it understates the company. FFO exists precisely because
of this.

#### The excess-return equity model

The replacement is an equity-side residual-income model — Damodaran's excess
return model, stated as:

```
Equity value = BV0 + Σ_{t=1..N}  (ROE_t − CoE) × BV_{t−1} / (1 + CoE)^t
```

with, all printed as assumptions in their own right:

- **Horizon `N`** — explicit, 10 years by default. The excess return is
  discounted year by year to year `N`, and **no continuing value is added**
  beyond it.
- **Fade** — ROE fades **linearly** from the current ROE to the cost of equity
  over exactly that horizon, so the year-`N` excess return is zero by
  construction. This is the equity-side analogue of the DCF core's terminal
  ROIC = WACC rule, and it is why no terminal value is needed. A caller may
  override the terminal ROE to assert persistent excess; the override is
  reflected honestly in a non-zero `terminalExcess` and in the basis string.
  Production never supplies it.
- **Discount rate** — the **cost of equity**, never a WACC. A WACC would blend
  in the cost of deposits, policy reserves or repo, which are this company's raw
  material rather than its financing. A null cost of equity **suppresses** the
  model with a critical gap rather than defaulting a rate.
- **Opening book value `BV0`** — banks use annual tangible common equity
  (stockholders' equity less goodwill, other intangibles and preferred stock)
  with the matching fiscal-year ROTE. Insurers and mortgage REITs use annual
  common book equity (stockholders' equity less preferred stock), with earnings
  available to common divided by average common equity. Return and opening
  book value share a dated fiscal-year basis; vendor total-equity ROE is never
  substituted into a common-equity valuation. Later
  years compound at `ROE × retention`, where retention is `1 − payout`. A loss is
  retained in full: `roe × retention` on a negative ROE would return a fraction
  of the loss to book value, which is arithmetically a capital injection.
- **Common earnings and payout** — use filed income available to common first;
  otherwise deduct disclosed preferred distributions from net income. When
  preferred stock is outstanding and the adjustment is unavailable, withhold
  the return and model rather than credit preferred earnings to common. Payout
  is common dividends plus net common buybacks over income available to common,
  averaging up to three years with at least two usable years. Missing history suppresses the model
  rather than assuming a universal payout.
  If preferred stock is outstanding and SEC facts give only aggregate cash
  dividends, the total is not labeled common dividends. A preferred earnings
  allocation is not a cash payment. Common payout and the valuation remain
  unavailable without sufficient separate cash-distribution evidence; ROTE and
  tangible book metrics remain available when their own inputs are established.

The model also reverse-solves the **starting** ROE that reproduces the current
market cap, under the same fade the forward path uses. Inverting a *different*
model (a flat ROE, as an earlier version did) made the solved figure
systematically low, because a flat path is worth more than a fading one, and
biased every financial toward "the market is too pessimistic". A clean property
follows from the identity: an issuer priced at book solves to exactly the cost
of equity.

#### P/TBV against ROTE

The multiple a financial is actually read on is price to **tangible** book, and
the return that justifies it is return on **tangible** common equity. Both use
the same denominator — equity less goodwill, other intangibles and preferred —
because goodwill absorbs losses only after common equity is gone, and pairing a
book-value multiple with a tangible-equity return would compare two different
bases. A goodwill-heavy acquirer at 1.0× book can be at 2.0× tangible book.

The current multiple names its balance date; the annual return and model name
their fiscal-year date. Preferred stock is deducted in both tangible bases.
Undisclosed preferred is treated as zero and that convention is disclosed.
Statements reconstructed from EDGAR companyfacts cannot independently verify
themselves: their FMP↔XBRL check is marked skipped with an informational identity
disclosure. Balance-sheet identities and other independent checks still run.

The justified multiple is a **stable-growth cross-check**, in the Gordon form of
the residual-income identity:

```
justified P/TBV = (ROTE − g) / (CoE − g),
g = min(ROTE × retention, terminal-growth cap 2.5%, risk-free rate)
```

Two things it is **not**:

- It is **not the forward model read as a multiple.** *The excess-return equity
  model* fades ROE linearly to the cost of equity over ten years and adds no
  continuing value; this identity
  assumes ROTE persists in perpetuity. They rest on different assumptions and
  can legitimately disagree — the difference is the value of persistence, and
  the basis string says so. (An earlier version of this section, and of the
  basis string, claimed the two "cannot disagree". That was false: at ROTE 16%,
  CoE 10% and a 50% payout the forward model reads 1.26× tangible book while the
  uncapped identity read 4.00×.)
- It is **not exempt from the house growth rule.** `g` obeys the same ceiling the
  DCF terminal value obeys — nothing grows faster than the risk-free rate
  forever. Uncapped, `g = ROTE × retention` reached 9.4% for a regional bank at
  ROTE 14% with a one-third payout, giving a justified 7.45×, so a bank at 1.5×
  tangible book printed a premium of −5.95× while the pipeline's own fair value
  called it roughly fairly priced. Capped, the same bank reads 1.53×. When no
  risk-free rate is supplied the cap is the 2.5% terminal-growth ceiling alone,
  and the basis string says which bound applied.

The multiple is **withheld, never clamped**, when `CoE − g` falls below 0.5pp:
the ratio diverges through infinity there, and any number it produced would be an
artefact of the arithmetic rather than a valuation. When ROTE, the cost of equity
or the payout history is missing, the multiple is still shown and the justified
figure is withheld with its reason.

### Route metrics

`src/pipeline/stageB/financialMetrics.ts` computes the figures each financial
route leads with, from the filer's own XBRL tags, read-only. Two rules govern
every metric:

1. **A named metric is computed only from the figures its definition calls
   for.** Where those figures are not on file the metric is **withheld with a
   reason**, which reaches the manifest as `financialMetrics.<key>`.
2. **A stand-in is published under its own name**, never the name of the metric
   it stands in for, and is marked `proxy`.

#### Banks

| Metric | Definition | When withheld |
| --- | --- | --- |
| Net interest margin | net interest income / average **earning** assets | whenever the filer tags no earning-assets element. us-gaap carries no standard average-earning-assets concept, and total assets include premises, goodwill and other non-earning items, so dividing by them would understate the margin. |
| Net interest income / average total assets | the honest denominator that *is* available | published as a labeled stand-in beside a withheld NIM, stating that it sits below a true NIM |
| Efficiency ratio | noninterest expense / (net interest income + noninterest income) | when the noninterest split is not tagged. This split exists in the filings even though vendor income statements omit it. |
| CET1 | company-reported CET1 capital / risk-weighted assets | when no CET1 element is tagged (it is often only in the regulatory-capital footnote text) |
| Tangible leverage | (equity − goodwill − intangibles − preferred) / (assets − goodwill − intangibles) | the labeled stand-in for CET1; its numerator and denominator differ from regulatory CET1, so it is not comparable and has no guaranteed ordering relative to it. [Basel risk weights](https://www.bis.org/committees/bcbs/basel-framework/standard/cre/20/inforce/2023-01-01/published/2022-12-08) can exceed 100%. |
| NPL ratio | nonaccrual loans / total loans | when nonaccrual loans are filed only by loan class (dimensional facts companyfacts does not expose as a total) |
| Provisions / loans | provision for credit losses / total loans | when neither the provision element nor its component sum resolves |
| Cost of deposits | interest expense on deposits / average deposits | when `InterestExpenseDeposits` is untagged — total interest expense covers borrowings too and would overstate it |

#### Insurers

| Metric | Definition |
| --- | --- |
| Loss ratio | incurred claims / premiums earned |
| Expense ratio | (other underwriting expense **+** deferred-policy-acquisition-cost amortisation) / premiums earned — **both** components required |
| Combined ratio | loss ratio + expense ratio |
| Reserve development | incurred claims attributable to prior accident years; positive is adverse, negative is a favourable release |

The expense ratio's numerator is the sum of `OtherUnderwritingExpense` and
`DeferredPolicyAcquisitionCostAmortizationExpense`, and **both** must resolve.
A partial component sum is not a total: an insurer tagging only the
acquisition-cost amortisation would publish a 12% expense ratio and a 77%
combined ratio — an underwriter that does not exist — so the ratio is withheld
naming the component that is missing. `InsuranceCommissionsAndFees` is not in
the numerator: it is a credit-balance revenue element, and summing it inflated
both the expense and combined ratios.

The denominator is **GAAP premiums earned**. A statutory expense ratio divides by
premiums *written*, so the computed figure is not directly comparable to a
statutory filing, and the company-reported combined ratio remains the gold
standard — the computed one is labeled a computation. The combined ratio is
**withheld outright when either half is missing**: a loss-ratio-only figure
reads materially flattering (64% where the real combined figure is 92%).

#### Mortgage REITs

| Metric | Definition |
| --- | --- |
| Book value per share | (total equity − preferred) / shares |
| Leverage | total assets / total equity |
| Net interest spread | interest income / average earning assets − interest expense / average interest-bearing liabilities — **withheld**, see below |
| Net interest spread (repo-funded) | interest income / average total assets − **total** interest expense / **average** repurchase agreements — the labeled stand-in |

Total assets is a fair yield denominator here — unlike at a bank — because a
mortgage REIT's assets are interest-earning securities and loans. The funding
leg is a different matter: companyfacts exposes only the repurchase-agreement
balance, while the interest-expense numerator covers every borrowing the REIT
runs. Dividing one by the other overstates the cost of funds and can flip the
sign of the spread — interest income 3.9bn on average assets 75bn against
interest expense 3.0bn over 50bn of repo prints −0.8% for a company reporting a
positive spread. So the named metric is **withheld** and the repo-funded
computation is published under its own name and marked a proxy, exactly as NIM
gives way to net interest income over average total assets. Both legs are
averaged over the current and prior period ends, so the two halves use the same
denominator convention. Either figure is withheld when a leg or its balance is
missing; a one-legged figure would misstate it.

### FFO and AFFO (NAREIT)

The app reconstructs the following components of NAREIT FFO:

```
FFO = net income (GAAP)
    + real-estate depreciation and amortization
    − gains on sales of property
    + impairments of depreciable real estate
```

The result is always **approximate**: affiliate/joint-venture adjustments are
not fully reconciled, nor is consolidated income reconciled to the common,
noncontrolling and preferred interests needed for a common-equity valuation.
NAREIT requires the affiliate adjustments but does not prescribe one ownership
attribution for every presentation. The app cannot claim equality with a
filer's FFO, or a guaranteed direction of error. Two component stand-ins can
individually increase the reconstruction:

- Where **real-estate** depreciation is not tagged separately, total
  depreciation and amortization is added back; NAREIT adds back only the
  real-estate portion.
- Where the **real-estate impairment** element is not tagged, the generic
  `AssetImpairmentCharges` is added back; NAREIT adds back only impairments of
  depreciable real estate, so a goodwill write-down inside that charge does not
  belong in FFO. `ImpairmentOfInvestments` — a securities write-down — is not in
  the chain at all.

The gain the definition subtracts is a gain on selling **real estate**:
`GainLossOnSaleOfProperties`, `GainsLossesOnSalesOfInvestmentRealEstate` (the
element most equity REITs use), `GainLossOnSaleOfRealEstate` and the
net-of-tax spelling. The generic `GainLossOnDispositionOfAssets1` is not one of
them — it covers disposals NAREIT does not exclude. Untagged gains and
impairments are treated as zero and the note says so, naming the direction: a
disposition gain the filer did not tag leaves FFO overstated by that gain.

AFFO subtracts recurring (maintenance) capital expenditure and straight-line
rent where the filer tags them. Where it does not, AFFO falls back to
`FFO − all capital expenditure`, which also subtracts development spending.
AFFO inherits FFO's approximation and omits some issuer-specific adjustments;
neither fallback is a guaranteed bound on the issuer's AFFO.

For example, Realty Income's [2025 reconciliation](https://www.sec.gov/Archives/edgar/data/726728/000072672826000009/realtyincomeq42025supple.htm)
contains unconsolidated-entity and noncontrolling-interest adjustments. Even
using its real-estate-only components, the app's unreconciled formula is
USD 12.105 million below common FFO, disproving an unconditional upper bound.

The implied cap rate divides NOI by the **house enterprise value** — market
capitalisation + net debt + preferred + minority interest, less the
operating-lease slice by default — the same definition the multiples and the
DCF bridge use, so a report carries one EV. The own-history P/FFO and P/AFFO
bands are built from net income + D&A per rolling four quarters, the only
construction quarterly statements support; when the current FFO adjusts
additional NAREIT components (a property-sale gain, an impairment or real-estate-only depreciation
netted) the bands are withheld with `valuation.multiples.ownHistory.ffoBasis`
rather than rank one definition inside another.

FFO is measured on **one** period: the latest fiscal year. Every XBRL component
resolves at that period end, so the statement fallbacks are read from the same
fiscal year rather than from a trailing window — a fiscal-year net income against
trailing depreciation is a hybrid of two periods, not a figure. The REIT
valuation block carries that period end as its as-of, and the notes say that the
share price in P/FFO is current while the FFO it divides is up to three quarters
old.

P/FFO and P/AFFO are computed from these figures. When the REIT sub-map is
`undetermined` (*The REIT sub-map*, above) every FFO-based figure is withheld.

### Forensic batteries by route

Piotroski (2000) built the F-score on non-financial firms; Altman excluded
financial institutions from every Z-model estimation sample; Beneish (1999)
excluded them from the M-score sample (p. 5). The routing layer honours those
sample definitions rather than producing a number outside them.

#### Altman Z, Beneish M, accrual ratios

All three are withheld on the bank, insurer and mortgage-REIT routes, and on any
issuer whose sector is "Financial Services" or whose SIC falls in 6000-6499 or
6700-6799 (equity REITs excepted, with a caution note). Each files its reason in
the manifest — `forensics.altmanZ`, `forensics.beneishM`,
`forensics.accrualsRatio` — because a blank cell with no reason reads as a fetch
that failed rather than as a deliberate refusal.

SIC major group 65 (real-estate operators, agents and managers) is deliberately
outside the exclusion band: those are ordinary operating companies with
inventory, receivables and a working-capital cycle.

#### Piotroski F, on three scales

The score is reported over the signals that remain, with its own denominator,
and the result carries a variant and a label so a reduced score is never read
against the 9-point scale. The label's withheld count is derived from the
signals that are actually null and names them, so a data gap that drops a
further signal is never reported as one of the route's own withholdings. In the
composite score the Piotroski signal is banded on the fraction achieved but
weighted by the share of the nine signals that were evaluable, and the
shortfall counts against the quality aspect's data completeness — two
coin-flip signals cannot swing the aspect the way nine do.

| Scale | Applies to | Signals withheld |
| --- | --- | --- |
| 9 | general route | none |
| 5 | FIN-OTHER: sector "Financial Services" or a financial SIC, but routed to the general map (asset managers, exchanges, insurance brokers) | CFO > 0, CFO > net income, current ratio, gross margin |
| 3 | bank, insurer, mortgage REIT | the four above **plus** ΔLEVER and ΔTURN |

Reasons:

- **The two cash-flow signals** presume an operating cash flow that measures
  earnings quality. A bank's is dominated by loan, deposit, trading-asset and
  reserve flows. (JPMorgan scored 2/6 in the 2026-09-02 keyless sweep with both
  misses on these tests.)
- **The current ratio** presumes a current/non-current split an unclassified
  financial balance sheet does not have.
- **Gross margin** presumes a cost of revenue; revenue − cost of revenue is
  meaningless on a net-interest-spread or premium income statement.
- **ΔLEVER** treats long-term debt over assets as a solvency burden. On these
  routes debt is an input, and the funding that matters — deposits, policy
  reserves, repo — is not long-term debt at all, so a falling ratio is a
  funding-mix change. A bank shrinking bond issuance while deposits grow would
  score a deleveraging point it did not earn.
- **ΔTURN** reads revenue over assets as operating efficiency. A financial
  company's assets *are* its revenue-generating book, so the ratio tracks the
  rate environment and balance-sheet mix; it falls when a bank adds low-yield
  liquidity.

The 5-signal scale exists because the FIN-OTHER issuers are fee-based with
ordinary balance sheets: their debt is debt and their assets are not their
revenue-generating book, so ΔLEVER and ΔTURN still mean what the paper says.
This mirrors the ROTE-vs-ROIC switch, which is likewise narrower than the
forensic classifier.

Nothing is dropped silently at any scale: each withheld signal keeps its reason
on the signal itself, the manifest entry names every withheld signal and the
denominator used, and the notes state that the score is not comparable to a
9-point F-score.

---

## FCFF arithmetic, sensitivity and reverse valuation

`src/pipeline/stageB/valuation.ts` returns full-precision model values. Rates
ending in `Pct` are percentage units (8 means 8%); the debt tax shield uses
a fractional effective rate. Display rounding does not feed the DCF engine.

For each explicit year `t`, with rates converted to fractions:

```
revenue_t = revenue_(t-1) × (1 + growth_t)
EBIT_t = revenue_t × EBIT_margin_t
reinvestment_t = max(0, (revenue_t − revenue_(t-1)) / sales_to_capital)
FCFF_t = NOPAT_t − reinvestment_t
PV_t = FCFF_t / (1 + WACC)^(t − 0.5)
```

The reinvestment floor means shrinking revenue releases no capital in this
model. NOPAT is EBIT less cash tax: a loss earns no cash tax refund. Projected
losses accumulate a net-operating-loss balance and shelter later positive EBIT
inside the explicit horizon. No jurisdictional carryforward limits, opening
tax-loss asset or residual tax asset in the terminal value are modeled. The
year rows report the effective tax rate actually applied, including shelter.

The continuing value uses the last explicit margin and tax assumption:

```
EBIT_(N+1) = revenue_N × (1 + terminal_growth) × margin_N
NOPAT_(N+1) = EBIT_(N+1) × (1 − tax_N), if EBIT_(N+1) > 0
             EBIT_(N+1), otherwise
terminal_FCFF = NOPAT_(N+1) × (1 − terminal_growth / terminal_ROIC)
terminal_value = terminal_FCFF / (WACC − terminal_growth)
PV_terminal = terminal_value / (1 + WACC)^(N − 0.5)
EV = sum(PV_t) + PV_terminal
```

The mid-year timing applies to the terminal discount as well as explicit cash
flows. Terminal reinvestment greater than 100% is capped at 100% with a note;
non-positive terminal ROIC substitutes zero reinvestment with a note. Negative
terminal growth is not floored here. Missing net debt prevents EV-to-equity
bridging; missing/non-positive diluted shares prevents per-share valuation.
Preferred and minority claims are subtracted separately, with null treated as
zero. The bridge recorded on the base result is reused by scenario reruns.

The **5 × 5 sensitivity grid** uses WACC and terminal-growth offsets of
−1, −0.5, 0, +0.5 and +1 percentage points. It holds explicit paths fixed and
retains the base terminal excess spread above each cell's own WACC. A cell
inside the 1.5pp Gordon guard is null, rather than moved to a different growth
rate. Sensitivity growth is an axis experiment; it is not a new base-case
terminal-growth recommendation.

The **reverse DCF** first searches constant explicit-horizon revenue growth
over [−20%, 60%], retaining the base margins, taxes, sales-to-capital, terminal
assumptions and bridge. This constant growth is a different path from the
forward DCF's fading growth and is labeled accordingly. A 17-point prescan
finds exact roots or sign-change intervals; multiple branches choose the
interval nearest base year-one growth. Bisection stops at 0.01pp interval
width, 80 iterations, or valuation error under 0.05% of price. A non-positive
year-one base FCFF skips that inversion; no growth root also falls back to
solving a terminal EBIT margin in [0%, 60%], with a margin fade over the full
explicit horizon and the base growth path held. Failure to bracket either
quantity reports no solution and explains the range; it does not extrapolate
an answer. See `tests/stageB.valuation.test.ts`,
`tests/stageB.dcfLossTax.test.ts` and `tests/stageB.dcfDisplay.test.ts`.

## Overlays and cash runway

`src/pipeline/stageB/sectorRouting.ts` composes overlays with the base business
route. **Unprofitable** means negative selected net income or negative selected
operating cash flow, with dated annual fallbacks when TTM is unavailable.
For banks, insurers and mortgage REITs, negative OCF alone cannot trigger it:
funding flows are operating cash flows on those balance sheets. The overlay
suppresses the general FCFF DCF; it is a house applicability rule and does not
establish that every future cash flow will be negative.

**Pre-revenue** means selected revenue below USD 10 million. The threshold is
evaluated only on established USD statements; a foreign-currency amount is
not compared with the dollar cutoff. Missing revenue does not imply zero.
**Recent IPO** requires an actual, valid, non-future IPO date within 24 months
of the bundle's analysis date. Fewer than eight quarters alone is incomplete
coverage, not proof of a recent listing. The overlays replace or suppress
inapplicable long-history and valuation sections with disclosed reasons.

Runway uses the newest whole quarterly/annual balance as its liquidity anchor,
cash plus short-term investments (with supported balance-sheet fallbacks), and
up to four usable recent cash-flow quarters. Average quarterly burn is the
negative of mean `(OCF + signed capex)`, using **before-SBC** cash flow.
It does not average only loss-making quarters: positive quarters remain in
the average. Missing component rows are excluded with reasons; a mean at or
above zero is self-funding and has no exhaustion estimate. Runway quarters
equal liquidity / average burn, and exhaustion date is anchored on the
balance date plus `runway × 365.25/4` days. Burn quarters must share an
established currency and liquidity must share that currency before the ratio
can be published. The estimate assumes unchanged burn and no financing, asset
sales or operating response. See `tests/compute.runwayAnchor.test.ts`,
`tests/stageB.sectorRouting.test.ts` and `tests/currency.stageB.test.ts`.

## Projections, scenario targets and intrinsic-value display

`src/pipeline/stageB/projections.ts` displays the first five years of the
general-route DCF's explicit path, with up to four annual historical points.
Revenue, operating margin and FCFF come from the DCF year rows. Forward EPS
equals EBIT times the median historical net-income/positive-EBIT ratio, divided
by diluted shares compounded at the measured annualized share-count trend.
A missing positive share anchor, conversion history or share trend withholds
EPS rather than assuming flat shares. Fiscal labels advance from the DCF's
statement anchor, so a TTM-anchored path need not start from the last annual
fiscal-year label.

Sample revenue-growth dispersion uses at least three positive, approximately
annual growth intervals (0.7–1.3 elapsed years); sample operating-margin
dispersion uses at least three margin levels. Off-annual revenue pairs are
excluded individually, so surviving intervals can still support a fan.
Growth sigma is capped at 25pp and margin sigma at 12pp. The joint shock is
`dg = sigma_growth` and `dm = sigma_margin × correlation(growth, margin)`
from at least three paired annual observations. Missing correlation leaves
scenario margins at base with disclosure. The scenario perturbation gives
the growth and margin bounds headroom for the requested shock; it does not
simply reapply the narrower base-case clamps. Neither sigma nor the band is
a fitted confidence interval.

The versioned `UNBACKTESTED_SCENARIO_PRIOR_2026_07` weighted projection is
25% bull + 50% base + 25% bear. These are display weights, not estimated
probabilities. The orchestrator supplies `capital.fcf.series[].fcf` as the
chart's historical FCF: levered cash flow after the house SBC deduction where
disclosed, unadjusted where SBC is absent. Its forward FCF is unlevered FCFF;
the seam is disclosed
as a change of basis, not a forecast improvement. Scenario FCF paths can
cross because growth also requires reinvestment.

`src/pipeline/stageB/scenarioTargets.ts` reruns the same DCF and base equity
bridge for two joint shocks. It labels the more valuable extreme bull and
the less valuable one bear, retaining the deltas that produced each. Negative
correlation can therefore make the bull target's growth delta negative.
The base target reuses the DCF per-share. Perturbed targets are floored at
zero with a warning. A non-positive base DCF per-share suppresses the entire
target block; thin dispersion, unavailable WACC/bridge and non-DCF routes
also suppress it. Sigma rounding to 0.00pp in either series makes target
correlation unavailable and gives a degenerate-dispersion disclosure. The fan
and targets share the dispersion helper, but the target labels are ordered
by valuation while chart paths retain their growth-shock labels.

`src/pipeline/stageB/fairValue.ts` resolves the deterministic route value:
FCFF DCF for general companies and excess-return equity value for financial
routes. Equity REITs, pre-revenue and DCF-suppressed routes have no intrinsic
per-share card in this implementation. The published card floors a negative
model value at zero and discloses the raw result; raw valuation arithmetic
can remain negative. Upside uses the published rounded per-share divided by
the comparable positive current price, minus one. Unknown/unmatched price
currency prevents upside. Scenario targets are present-value DCF
sensitivities, not twelve-month analyst forecasts. The horizon label beside
each target is set in code (`SCENARIO_TARGET_HORIZON` in `passes.ts`):
"explicit DCF horizon" when a computed target exists for that scenario and
"n/a" otherwise, on AI and data-only reports alike; the judge does not set it. `verified: true` on these
computed records means traced to deterministic inputs, not predictive or
independent factual verification.

See `tests/stageB.projections.test.ts`, `tests/stageB.scenarioTargets.test.ts`,
`tests/projection.operatingIncome.test.ts` and `tests/stageB.fairValue.test.ts`.

## Numeric grades and completeness

`src/pipeline/stageB/grading.ts` owns versioned house bands
(`SCORE_BANDS_2026_07`). Each metric is mapped to 0–100 by piecewise-linear
interpolation between the source's named breakpoints and held at endpoint
scores beyond them. A/B/C/D/F thresholds are 85/70/55/40; there is no E.
These bands have not been outcome-backtested.

| Aspect | General weight | Financial weight | Equity-REIT weight | Quantitative evidence |
| --- | ---: | ---: | ---: | --- |
| Fundamentals | 20 | 15 | 15 | Revenue/EPS/FCF growth and operating-margin slope |
| Valuation | 20 | 22 | 25 | DCF upside, reverse-implied growth and own-history ranks; financials use implied-vs-current starting ROE and book ranks; equity REITs use FFO/AFFO rank |
| Quality | 15 | 26 | 15 | ROIC−WACC and applicable forensic models |
| Balance sheet | 15 | 10 | 15 | Net debt/EBITDA, interest coverage, before-SBC FCF conversion, SBC/FCF, share trend |
| Moat | 15 | 15 | 15 | ROIC level/stability and gross margin; financials substitute ROTE level/stability |
| Leadership | 10 | 7 | 10 | Buyback-price proxy, applicable return spread, share trend, SBC/revenue |
| Technicals | 5 | 5 | 5 | SMA gap, RSI-14, 52-week position and six-month SPY-relative return |

The financial vector covers banks, insurers and mortgage REITs. Their numeric
balance-sheet aspect is explicitly unscored: route metrics can compute capital
information, but the scoring engine has no calibrated capital-adequacy signal.
Moat and leadership scores are quantitative proxies, not a finding about the
company's competitive advantage or management competence.

An aspect is the weighted mean of available, route-permitted signal scores.
Its `dataCompleteness` is used signal weight / all intended signal weight;
Piotroski's used weight is additionally scaled by `outOf/9`. Missing data
contributes no score but reduces completeness; zero available evidence yields
a null score. The composite first weights each available aspect by its route
weight times that completeness. Its coverage ceiling excludes wholly
route-inapplicable aspects and signal weight suppressed by route policy.
If `R` is that evidence-weighted mean and `C` is available weight / the
route-applicable ceiling, the published composite is `50 + (R − 50) × C`.
Thus sparse favorable evidence shrinks toward neutral; full route-applicable
coverage leaves the mean unchanged. A null composite is retained when no
aspect has evidence. This score completeness is distinct from the report's
provider/XBRL, citation and consistency coverage measures.

Altman values are mapped onto the original model's 1.81/2.99 zones before
scoring, so different variants share comparable grade bands. Scoring growth
prefers a genuine 5Y CAGR, then 3Y, then 1Y; a span differing by more than
0.25 years is excluded as that named window. The stricter revenue-acceleration
benchmark has its own ±0.05-year rule. See `tests/stageB.grading.test.ts`.

## Technical indicators

`src/pipeline/stageB/technicals.ts` computes indicators locally from supplied
EOD OHLCV; it does not use FMP indicator endpoints. Invalid dates and unusable
prices are dropped and rows are sorted ascending. Unavailable volume becomes
null and preserves valid price observations; a volume average requires the
entire recent window rather than treating missing volume as zero.

SMA uses 50/200 trading rows. RSI-14 and ATR-14 use Wilder smoothing, seeded
by the simple mean of their first 14 changes/true ranges; a flat RSI is 50.
ATR true range is `max(high−low, |high−prior close|, |low−prior close|)` from
the second bar. EMA is SMA-seeded with multiplier `2/(n+1)`; MACD uses
12/26 EMAs and a nine-observation signal EMA. SMA and MACD crosses ignore
exact-zero spreads and require reversal of the last nonzero sign.

52-week ranges and 1/3/5-year drawdowns use calendar dates rather than a
fixed row count, with seven-day start tolerance. The range requires adequate
calendar coverage, and drawdown discloses incomplete history. Relative
strength is the stock's close-price return minus benchmark return in percentage
points over 3/6/12 calendar months. Endpoints must be shared dates and within
seven days of each series' latest observation; starts are shared dates on or
before the requested cutoff, with seven-day tolerance. Conflicting same-date
closes cannot establish an endpoint. These are price returns, not dividend
total returns. Volume trend compares complete 20-row and 90-row averages:
at least 1.2 is rising, at most 0.8 falling, otherwise flat. RSI 70/30, proximity
to highs/lows, recent crossover and drawdown flags are house display rules,
not return forecasts. See `tests/stageB.technicals.test.ts`,
`tests/stageB.range52wHistory.test.ts` and
`tests/charts.relativeStrengthRebase.test.ts`.

## Stage A checks and report verification

`src/pipeline/stageA/validate.ts` checks up to four annual balance-sheet
identities with a 0.5%-of-assets tolerance. Total equity including minority
interest is preferred; otherwise stockholders' equity plus disclosed minority
interest is used. Legitimately negative equity is retained. Missing identity
inputs are skipped with reasons, not passed.

Revenue/net-income FMP↔XBRL checks cover the latest annual and quarterly
periods at a 0.5% tolerance, using the applicable tag chains and filed currency.
EDGAR-reconstructed rows are marked as the same source and skipped for that
cross-check: comparing a number to the facts that produced it is not independent
verification. A total consolidated-income fallback versus vendor common-income
figure carries a basis caution. Staleness checks separately consider filing
cadence, stale statement-cache envelopes, quote as-of dates (seven days),
and the last institutional quarter whose 45-day deadline passed. ADR cadence
allows a half-year reporting interval instead of assuming domestic 10-Qs.
Fixture staleness markers denote synthetic mode and do not count as cache-TTL
failures. Implausible zero interest expense/SG&A values are recorded as
undisclosed. Validation describes gaps and cautions; it does not certify every
input or force the whole report to stop on every failed check.
See `tests/stageA.validate.test.ts`, `tests/report.completenessXbrl.test.ts`
and `tests/stageA.manifest.test.ts`.

`src/pipeline/stageC/payload.ts` builds numeric and citation registries from
eligible provider/filing evidence and computed outputs. The bull/bear and
judge passes interpret that context. Deterministic scores, multiples,
projections, scenario targets, intrinsic value, DCF assumptions and grid cells
are injected from Stage B; a model-authored replacement is not the authority
for those tables. AI narrative grades and qualitative case text remain model
judgments and can diverge from numeric bands when explained.

Verification in `src/pipeline/stageC/passes.ts` and `provenance.ts` matches
source identity, value, compatible unit/currency and as-of/period. A fetched
web URL can establish citation retrieval, not numeric correctness. A computed
record is `computed-derived`; a forecast never becomes an observed fact
because its calculation can be traced. Unresolved claims remain disclosed,
and retrieved citation dates do not permit arbitrary report dates to verify.

`src/pipeline/stageC/consistency.ts` separately checks locally identifiable
direction words against signed changes, year phrases against cited record
years, unit words against record families, and sourcing of named individuals.
The period-word check compares years only; it does not adjudicate fiscal
quarters. A number that cannot be located confidently in its sentence is
unchecked, not guessed. Coverage and checked counts accompany the results,
so these checks are not a comprehensive proof that the narrative is true.

`src/pipeline/stageC/dataOnlyReport.ts` preserves available deterministic
sections and missing reasons when AI is unavailable or a pass fails. The
report's execution metadata distinguishes requested mode and actual outcome;
data-only does not mean a complete provider bundle. Historical stored reports
retain their original computation and version stamps; changing this document
does not recompute them. See `tests/stageC.deterministicInjection.test.ts`,
`tests/stageC.provenance.test.ts`, `tests/stageC.verifyChecks.test.ts`,
`tests/degradation.report.test.ts` and `tests/report.executionMetadata.test.ts`.

## Disclaimer scope

New reports carry this text verbatim; historical reports retain the disclaimer
saved when they were generated:

> Informational only — not investment advice. This report contains A-F letter
> grades and scenario price targets; both are model outputs derived from the
> data and assumptions disclosed here, and neither is a recommendation to buy,
> sell, or hold any security.

The disclaimer names the report's output families. Seven aspects have
deterministic numeric scores and A–F bands when applicable evidence supports
them; AI reports additionally carry model-authored qualitative grades. Data-only
reports do not invent narrative assessments, and unsupported aspects can remain
unscored. Bull, base and bear scenario price targets are deterministic model
outputs only when the DCF and dispersion evidence support them; otherwise the
target block is suppressed with reasons. Neither kind of grade is a
recommendation. The report contains no
buy, sell or hold recommendation, no allocation directive, and no price target
authored by a person.

Renderers print the disclaimer stored on the report as written, so a report
generated under an earlier version keeps the text that was in force when it was
produced.
