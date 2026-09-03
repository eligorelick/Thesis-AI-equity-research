# README notes — WS6 (valuation inputs and disclosure)

Facts the README must state after WS6 (decisions D-18 and D-19). WS6 does not
edit `README.md`; WS9 folds these in. Sentences below are written to be used
close to verbatim. Reconciliation rows addressed: R-02, R-29, R-31, R-32,
R-60 (the WACC-inputs half).

Full detail lives in [`docs/METHODOLOGY.md`](../METHODOLOGY.md); the README
should link to it rather than restate it.

## 1. Corrections to statements the README currently makes

**R-32 — near-term growth. REQUIRED CORRECTION — the README still documents
the retired rule.** `README.md` (in the DCF paragraph, currently around line
202) reads:

> Near-term growth anchors on the lower of the three- and five-year revenue
> CAGRs; when the two disagree in sign the history holds a spike or a collapse
> rather than a trend, and near-term growth is set to the terminal rate
> instead.

Both rules are retired. That sentence must be replaced, verbatim, with:

> Near-term revenue growth is the median of every method the data supports — a
> log-linear regression over all annual revenue years (reported with its R² and
> the number of years), the three- and five-year CAGRs, and an
> analyst-consensus case when estimates are available. The range across those
> methods is shown alongside the point estimate, and any method that could not
> be computed is named. The median is then clamped to the house range of −10%
> to +25%; when the clamp moves it, the assumption block prints the clamped
> anchor and says which median it was clamped from.

**R-31 — terminal ROIC.** The README describes the terminal rule without
saying whose rule it is. Replace with:

> Terminal return on invested capital defaults to the cost of capital. Where
> ROIC exceeded WACC in each of the last four or more fiscal years, half the
> median spread is carried in perpetuity, capped at 5 percentage points. This
> is a house convention, not a standard, and the report labels it as one.
> Each fiscal year is compared to its own cost of capital, recomputed from that
> year end's risk-free observation, wherever one is available; otherwise the
> report says the current WACC was applied to every year.

**R-29 — own-history multiples. REQUIRED CORRECTION — the README still
documents the retired rule.** `README.md` (the paragraph that ends the
FMP-plan-limits section, currently around line 188) reads:

> Five fiscal years still support the growth, returns, forensic, DCF and
> scoring modules; own-history multiple percentiles need eight quarters and are
> withheld until the plan supplies them.

That sentence must be replaced, verbatim, with:

> Five fiscal years still support the growth, returns, forensic, DCF and
> scoring modules; the own-history multiple rank needs eight quarters and is
> withheld until the plan supplies them.

And the README must say what the figure is, wherever it first describes the
multiples table:

> The own-history figure is a rank among N quarters (8 to 20 observations), not
> a percentile — that many observations cannot estimate one. N is printed
> beside the rank, so the table reads "rank 62 of 12 quarters".

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
> are reported — before and after — every row that prints one says which it is,
> and a year that discloses no SBC is left unadjusted and says so. Price to free
> cash flow uses the **before**-SBC figure, the same basis as the own-history
> distribution it is ranked in, and renders as "P/FCF (before SBC)". The
> balance-sheet grade's FCF-conversion metric also uses the before-SBC ratio,
> the definition its band was calibrated on, so stock-based compensation is
> charged to the score exactly once — by the separate "SBC as a percentage of
> free cash flow" metric.

**Dilution.**

> Dilution from outstanding awards is shown as the gap between diluted and
> basic weighted-average shares, with its as-of date; it appears in the
> capital figures and in the data-only report's capital-allocation notes, and a
> missing count is disclosed there and in the missing-data manifest rather than
> treated as zero.

**Enterprise value and the lease option.**

> Enterprise value is market capitalisation plus total debt, preferred stock
> and minority interest, less cash and short-term investments. The
> **operating**-lease liability is excluded by default, because under ASC 842
> the operating-lease cost is already inside EBIT and EBITDA and counting the
> liability in EV as well would double-count it. The **finance**-lease
> liability is not excluded: finance-lease cost is right-of-use amortisation
> plus interest, both outside EBIT, so that liability is debt in both frames and
> stays in enterprise value and in net debt. Where the two cannot be separated —
> the FMP route publishes one combined figure — no lease adjustment is made and
> the report says so rather than removing an unknown mix. Set
> `THESIS_EV_INCLUDE_LEASES=1` to keep the operating slice in; the report then
> warns that EV/EBITDA is no longer comparable to the default basis. Both
> enterprise values are computed either way, the own-history rank is built on
> the same lease basis as the current multiple, and the DCF equity bridge
> follows the identical convention.

## 3. Configuration table

One new environment variable, documented in `.env.example`:

| Key | Default | Effect |
| --- | --- | --- |
| `THESIS_EV_INCLUDE_LEASES` | unset (off) | `1` keeps the **operating**-lease liability in enterprise value and in the DCF equity bridge. It never affects the finance-lease liability, which is debt in both frames either way. Any other value leaves the default in place. |

## 4. Docs link

The README should link `docs/METHODOLOGY.md` from its methodology or
"how it works" section: it documents the WACC inputs, the growth anchor, the
fade and horizon, the terminal-value house convention, FCF and SBC, dilution,
the EV bridge, multiples and own-history ranks, and the disclaimer's scope,
each with its sources named.

## 5. Closed since the first draft of these notes

**N in the multiples table — now shipped.** These notes previously recorded it
as a known gap on the grounds that a new `MultipleRowSchema` field would cost
one slot of the judge request's guarded optional-parameter budget. The WS6
financial-correctness review shipped it instead: the row carries
`ownHistoryObservations`, and because the judge never authors this table (the
pipeline replaces it wholesale) the field is stripped from the request schema
the same way `verified` already is, leaving that budget unchanged at 20. The
README may state plainly that the table shows "rank 62 of 12 quarters".

## 6. Later corrections from the WS6 review

These supersede anything above that conflicts with them.

- **Leases in enterprise value.** Only the operating slice is removed, never
  the combined figure — see the enterprise-value paragraph in section 2, which
  has been rewritten. Any README sentence saying "operating leases are excluded"
  without naming the finance slice is incomplete.
- **The near-term growth clamp.** The README must not describe the growth
  anchor without the clamp: the printed anchor is the clamped value, and the
  assumption row says which median it was clamped from.
- **"Percentile" is gone from every reader-visible surface**, including the
  score-drivers table, whose rank drivers are now named `peOwnHistoryRank`,
  `priceToTbvOwnHistoryRank` and `pFfoOwnHistoryRank`.
- **Both enterprise values are basis-string content, not an assumption row.**
  The README should not promise a with/without-leases row in the assumption
  table; the figures appear in the EV bridge basis, which is quoted into the
  EV/EBITDA and EV/sales basis lines and the DCF equity-bridge note.
