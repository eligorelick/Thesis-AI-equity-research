# Valuation methodology

What Thesis computes, from which inputs, under which conventions, and where a
convention is this project's own choice rather than a standard.

Two rules govern everything below. Every number carries a source and an as-of
date. Where a rule is a house convention rather than an established method, it
says so in the same breath as the number it produces — in the DCF assumption
block, in the report's missing-data manifest, or both.

Sources referred to by name throughout:

- **Damodaran**, *Investment Valuation* and the annual implied-ERP dataset
  (`pages.stern.nyu.edu/~adamodar`), for the equity risk premium, the terminal
  growth constraint, the synthetic-rating spread table, and the treatment of
  stock-based compensation in *Stock Based Compensation: The Elephant in the
  Room*.
- **Koller, Goedhart and Wessels**, *Valuation: Measuring and Managing the
  Value of Companies* (McKinsey), for continuing value, RONIC, and the
  evidence on how return-on-capital advantages decay.
- **FRED** (Federal Reserve Bank of St. Louis), for the risk-free rate:
  series `DGS10` (10-Year Treasury Constant Maturity), alongside `DGS2`,
  `T10Y2Y`, `T10Y3M`, `EFFR`, `CPIAUCSL`, `CPILFESL`, `UNRATE`, `PAYEMS`,
  `T10YIE`, `BAMLH0A0HYM2` and `VIXCLS` in the macro dashboard.
- **CFA Institute** curriculum guidance on quantitative methods, for the
  distinction between a percentile of a distribution and a rank within a
  small observed sample.

---

## WACC inputs

The discount rate is never printed as a bare percentage. Every input is named
with its source and its date, in the DCF assumption block (`WACC (discount
rate)` row) and in the report's computed-returns notes.

| Input | Source | Convention |
| --- | --- | --- |
| Risk-free rate | FMP treasury rates (`year10`), else **FRED `DGS10`** | The series id and the observation date are both stated. |
| Equity risk premium | FMP market-risk-premium (US `totalEquityRiskPremium`), else the dated **Damodaran** implied-ERP fallback | The fallback carries its own publication date and is rejected once it is older than 210 days rather than used stale. A value outside [3%, 25%] is treated as implausible and falls back. |
| Beta | Provider profile beta, **Blume-adjusted** (0.67·raw + 0.33), clamped to [0.6, 2.0] | Raw beta outside (0, 4] is unusable and the WACC fails closed rather than inventing market exposure. |
| Cost of equity | rf + beta × ERP | Clamped to [rf + 2.5%, 25%]. |
| Cost of debt | `effective` (interest expense ÷ average total debt), `historical` (the issuer's last year that still disclosed interest), or `synthetic` (rf + rating spread from interest coverage, Damodaran's January 2026 table) | The method actually used is named. An effective rate outside [rf − 1, rf + 19] is rejected in favour of the synthetic rating. Debt below 2% of assets is treated as noise. |
| Tax rate | Observed effective rate (ratios TTM, else annual ratios, else TTM tax expense ÷ pre-tax income) | Clamped to [0%, 35%]. Where it came from is named. No universal statutory rate is ever assumed. |
| Weights | Market value of equity (market capitalisation) and book total debt as a market-value proxy, averaged over the latest two balance sheets | Stated as E% / D%. When the statements' currency differs from the quote currency (the ADR case) the weights are suppressed rather than silently mixed. |

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

## Growth anchor

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
and disclosed as a `valuation.dcf.growthAnchor` manifest entry. The result is
clamped to [−10%, +25%], and a clamp that fires is annotated.

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
effective rate to the company's own historical median. Cash flows are
discounted on the **mid-year convention**.

Terminal growth is **min(2.5%, risk-free rate)** — nothing grows faster than
the risk-free rate in perpetuity (Damodaran). A Gordon guard requires
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

So: when ROIC exceeded the WACC in **each of the last four or more fiscal
years on record**, half the median spread is carried in perpetuity, capped at
**5 percentage points**. A carried spread below 0.5pp is treated as noise and
the default holds. Anything short of that evidence keeps the default, and the
reason is written into the assumption notes. This follows McKinsey's RONIC
guidance (a top-quintile ROIC advantage roughly halves over 10–15 years rather
than closing) and Damodaran's allowance of perpetual excess returns only when
they are modest.

Each fiscal year is compared to **its own** WACC where one could be recomputed
(see *WACC inputs* above); otherwise the current WACC is applied to every year
and the note says exactly that. Terminal reinvestment is g ÷ ROIC_terminal,
Damodaran's consistency rule.

---

## FCF and SBC

**Free cash flow subtracts stock-based compensation by default.** The
cash-flow statement adds SBC back to operating cash flow because no cash left
the building that period, but the expense is real: it is settled in newly
issued shares, and the bill lands on existing holders as dilution. Damodaran's
treatment in *Stock Based Compensation: The Elephant in the Room* is to treat
it as an operating expense that should not be added back.

Both figures are reported and never conflated:

- `fcfBeforeSbc` — operating cash flow + capital expenditure (capex arrives
  negative), the vendor convention.
- `fcf` — the same figure less SBC, the house default.

A year with no disclosed SBC is left unadjusted, says so per row, and raises an
info-level `capital.fcf.sbc` manifest entry, so an unadjusted year is never
silently compared with an adjusted one. SBC as a percentage of FCF is measured
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
as-of date and the overhang in percent. A missing count is disclosed
(`capital.dilution`), never assumed to be zero. Awards that are antidilutive in
a loss year are excluded from the diluted count by the filer, so a loss-making
issuer's overhang understates the award pool; the note says this.

Separately, the five-year diluted share-count trend reports buyback, dilution
or flat (within ±1%), annualised over the span actually available.

Per-share values use the weighted-average diluted count from the newer of the
latest quarterly and latest annual income statement; when only the annual count
is available, the report says the figure may lag recent buybacks or issuance.

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

**The OPERATING-lease liability is excluded by default; the finance-lease
liability is not.** The option to keep the operating slice in is
`THESIS_EV_INCLUDE_LEASES=1`. The split is the whole point. Under US GAAP
(ASC 842) operating-lease cost stays in operating expenses, so EBIT and EBITDA
are already *after* it and adding that liability to EV as well double-counts the
leases in EV/EBITDA. Finance-lease cost is *not* in either figure: it is split
between right-of-use amortisation, which EBITDA adds back, and interest, which
sits below EBIT. The finance-lease liability is therefore debt in both frames
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
`ownHistoryObservations`, and Markdown, print HTML and the app all read "rank 62
of 12 quarters". A report persisted before that field existed still parses and
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

<!-- WS5 fills this section at integration: bank, insurer and mortgage-REIT
     routing, the excess-return model, ROTE and P/TBV, and which forensic
     models are withheld for financial classifications and why. -->

*Placeholder — to be completed with the sector-routing and financial-metrics
methodology.*

---

## Disclaimer scope

Every report carries this text verbatim:

> Informational only — not investment advice. This report contains A-F letter
> grades and scenario price targets; both are model outputs derived from the
> data and assumptions disclosed here, and neither is a recommendation to buy,
> sell, or hold any security.

The disclaimer names what the report actually emits. It grades six aspects on
an A–F scale and prints bull, base and bear scenario price targets; both are
deterministic model outputs computed from the inputs disclosed above, and both
are only as good as those inputs. Neither is a rating. The report contains no
buy, sell or hold recommendation, no allocation directive, and no price target
authored by a person.

Renderers print the disclaimer stored on the report as written, so a report
generated under an earlier version keeps the text that was in force when it was
produced.
