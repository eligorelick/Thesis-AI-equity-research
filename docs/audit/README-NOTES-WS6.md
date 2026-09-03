# README notes — WS6 (valuation inputs and disclosure)

Facts the README must state after WS6 (decisions D-18 and D-19). WS6 does not
edit `README.md`; WS9 folds these in. Sentences below are written to be used
close to verbatim. Reconciliation rows addressed: R-02, R-29, R-31, R-32,
R-60 (the WACC-inputs half).

Full detail lives in [`docs/METHODOLOGY.md`](../METHODOLOGY.md); the README
should link to it rather than restate it.

## 1. Corrections to statements the README currently makes

**R-32 — near-term growth.** The README says near-term growth is the lower of
the three- and five-year revenue CAGRs, and that a sign disagreement between
them sets growth to the terminal rate. Both rules are retired. Replace with:

> Near-term revenue growth is the median of every method the data supports — a
> log-linear regression over all annual revenue years (reported with its R² and
> the number of years), the three- and five-year CAGRs, and an
> analyst-consensus case when estimates are available. The range across those
> methods is shown alongside the point estimate, and any method that could not
> be computed is named.

**R-31 — terminal ROIC.** The README describes the terminal rule without
saying whose rule it is. Replace with:

> Terminal return on invested capital defaults to the cost of capital. Where
> ROIC exceeded WACC in each of the last four or more fiscal years, half the
> median spread is carried in perpetuity, capped at 5 percentage points. This
> is a house convention, not a standard, and the report labels it as one.
> Each fiscal year is compared to its own cost of capital, recomputed from that
> year end's risk-free observation, wherever one is available; otherwise the
> report says the current WACC was applied to every year.

**R-29 — own-history multiples.** The README calls the figure a percentile.
Replace with:

> The own-history figure is a rank among N quarters (8 to 20 observations), not
> a percentile — that many observations cannot estimate one. The report states
> N alongside the rank.

**R-02 — disclaimer.** The README says the app does not provide buy/sell/hold
ratings, but does not mention the letter grades and scenario price targets it
does emit. The disclaimer now reads:

> Informational only — not investment advice. This report contains A-F letter
> grades and scenario price targets; both are model outputs derived from the
> data and assumptions disclosed here, and neither is a recommendation to buy,
> sell, or hold any security.

The README's safety section should quote it and add: *the grades and scenario
targets are deterministic outputs of the disclosed inputs, not ratings, and no
price target in the report is authored by a person or by the model.*

**R-60 — WACC inputs.** These were not stated anywhere. Add:

> The discount rate names every input it is built from: the risk-free series
> and its observation date (FRED `DGS10`, or the provider's 10-year treasury
> rate), the equity-risk-premium source and date (the provider's US premium, or
> a dated Damodaran implied-ERP fallback that is rejected once it is more than
> 210 days old), the Blume-adjusted beta, the cost-of-debt method actually used
> (effective, historical, or a synthetic rating), the effective tax rate and
> where it came from, and the market-value equity/debt weights. Terminal growth
> is capped at the risk-free rate.

## 2. New behaviour to describe

**Free cash flow is reported after stock-based compensation.**

> Free cash flow subtracts stock-based compensation by default: it is a real
> cost of employing people, settled in shares rather than cash. Both figures
> are reported — before and after — and a year that discloses no SBC is left
> unadjusted and says so.

**Dilution.**

> Dilution from outstanding awards is shown as the gap between diluted and
> basic weighted-average shares, with its as-of date; a missing count is
> disclosed rather than treated as zero.

**Enterprise value and the lease option.**

> Enterprise value is market capitalisation plus total debt, preferred stock
> and minority interest, less cash and short-term investments. Operating lease
> liabilities are excluded by default, because under ASC 842 the operating-lease
> cost is already inside EBITDA and counting the liability in EV as well would
> double-count it. Set `THESIS_EV_INCLUDE_LEASES=1` to include them; the report
> then warns that EV/EBITDA is no longer comparable to the default basis. Both
> enterprise values are shown either way, and the DCF equity bridge follows the
> same convention.

## 3. Configuration table

One new environment variable, documented in `.env.example`:

| Key | Default | Effect |
| --- | --- | --- |
| `THESIS_EV_INCLUDE_LEASES` | unset (off) | `1` counts lease liabilities in enterprise value and in the DCF equity bridge. Any other value leaves the default in place. |

## 4. Docs link

The README should link `docs/METHODOLOGY.md` from its methodology or
"how it works" section: it documents the WACC inputs, the growth anchor, the
fade and horizon, the terminal-value house convention, FCF and SBC, dilution,
the EV bridge, multiples and own-history ranks, and the disclaimer's scope,
each with its sources named.

## 5. Known gap for WS9 to sanity-check after integration

The report's multiples table carries the own-history rank but not N; N is
published per multiple in the computed valuation notes instead. Adding N as a
column would mean a new field on `MultipleRowSchema`, which the judge shares
and whose optional-parameter budget is guarded by a test — see the follow-up
in WS6's final report. If WS7 adds it, the README can say N is shown in the
table itself.
