# Research notes: forensic models and financial-statement tagging

The forensic scores in this application are published academic models, not
inventions of this project. This document is the evidence base for them. The
source code cites it by section (`research §2.5` and so on), and a test asserts
that every citation resolves to a heading here, so the two cannot drift apart.

Three kinds of statement appear below, and they are never mixed:

- **Published.** A coefficient, threshold or definition taken from the original
  paper, with the citation. Changing one of these means departing from the
  model, and the report would no longer be entitled to use its name.
- **House rule.** A choice this project made where the literature is silent —
  a display band, a clamp, an edge case the original sample never contained.
  Every one is labelled as a house rule in the report itself, not only here.
- **Resolved ambiguity.** A point where published sources disagree or where
  secondary sources have propagated an error. The resolution and its reasoning
  are recorded so a reader can disagree with the specific decision.

A model is only as good as the population it was fitted on. Section 6 is the
list of cases where these models do not apply, and what the report does instead
of pretending otherwise.

---

## 1. Altman Z-Score

Edward Altman, *Financial Ratios, Discriminant Analysis and the Prediction of
Corporate Bankruptcy*, Journal of Finance 23(4), 1968, and the later variants
in Altman & Hotchkiss, *Corporate Financial Distress and Bankruptcy*, 3rd ed.,
2006.

**Published — coefficients.** Four variants, implemented in
`ALTMAN_COEFFICIENTS`:

| Variant | X1 | X2 | X3 | X4 | X5 | constant |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `original` (1968, public manufacturers) | 1.2 | 1.4 | 3.3 | 0.6 | 0.999 | 0 |
| `private` (Z′, private manufacturers) | 0.717 | 0.847 | 3.107 | 0.42 | 0.998 | 0 |
| `z2` (Z″, non-manufacturers) | 6.56 | 3.26 | 6.72 | 1.05 | — | 0 |
| `z2-em` (Z″ emerging markets) | 6.56 | 3.26 | 6.72 | 1.05 | — | 3.25 |

X1 working capital / total assets, X2 retained earnings / total assets, X3 EBIT
/ total assets, X4 equity / total liabilities, X5 sales / total assets.

Two details are frequently got wrong elsewhere. X5's coefficient in the
original model is **0.999**, not 1.0 — the rounding is harmless in practice but
the model is stated exactly. And the Z″ family **drops X5 entirely**: it was
removed precisely so the score would not reward or punish the asset turnover
that varies most across non-manufacturing industries. Implementations that
retain X5 in a Z″ are not computing a Z″.

X4 changes meaning by variant: **market** value of equity in `original`,
**book** value in the other three. Using book value in the original variant
(or market in the others) produces a number that is not the published model.

### 1.1 Original zones

**Published.** Distress below 1.81; safe above 2.99; between is grey.

### 1.2 Private (Z′) zones

**Published.** Distress below 1.23; safe above 2.90.

### 1.3 Z″ and Z″-EM zones

**Published (Z″).** Distress below 1.10; safe above 2.60.

**Resolved ambiguity (Z″-EM).** The emerging-market variant adds a constant of
3.25 so that a score of zero corresponds to a D-rated bond. Many secondary
sources then quote the *unshifted* 1.10 / 2.60 boundaries against the shifted
score, which classifies every company roughly one zone too healthy. This
project shifts the boundaries by the same constant — **4.35 / 5.85** — so that
`z2-em` and `z2` classify an identical company identically, which is the only
reading under which the constant is a rescaling rather than a thumb on the
scale.

**House rule — boundary convention.** Altman states both bounds as strict
inequalities, which leaves the boundary values themselves unassigned. A score
exactly on a boundary is classified **grey**, the more conservative of the two
readings on the safe side.

### 1.4 Variant selection

**House rule.** The published models do not tell you which variant to use for
an arbitrary issuer; the selection rule is this project's, and the report names
the variant it used. In order: a financial company gets no Z at all (§6.3); an
issuer whose market capitalisation is unavailable, or is quoted in a different
currency from its statements, cannot use `original` and falls back to a
book-equity variant; a manufacturer uses `original`; everything else uses `z2`.
`z2-em` is used where the issuer's filings are in an emerging-market context.

The currency check matters more than it sounds. For an ADR whose statements are
in one currency and whose quote is in another, computing X4 as market cap over
total liabilities silently divides two different currencies. There is no FX
rate in the pipeline, so the report **withholds** the original-variant Z rather
than publish a number that is wrong by an exchange rate.

---

## 2. Beneish M-Score

Messod Beneish, *The Detection of Earnings Manipulation*, Financial Analysts
Journal 55(5), 1999.

**Published — coefficients.** The eight-variable model, from Table 3:

```
M = −4.84 + 0.920·DSRI + 0.528·GMI + 0.404·AQI + 0.892·SGI
          + 0.115·DEPI − 0.172·SGAI + 4.679·TATA − 0.327·LVGI
```

**Resolved ambiguity — the TATA coefficient.** A large number of secondary
sources give TATA as **4.697**. The correct value is **4.679**; 4.697 is a
digit transposition that has propagated widely. TATA carries the largest
coefficient in the model, so the error is not cosmetic. This project uses
4.679.

### 2.1 The eight indices

**Published.** Each index compares the current year to the prior year, so the
model needs two consecutive fiscal years and reports nothing from one.

| Index | Compares | Reads as manipulation when |
| --- | --- | --- |
| DSRI | Days sales in receivables | Receivables grow faster than sales |
| GMI | Gross margin, prior ÷ current | Margin deteriorates |
| AQI | Non-current assets other than PP&E ÷ total assets | Asset quality softens (more capitalised cost) |
| SGI | Sales growth | Growth is high — a pressure proxy, not a fault |
| DEPI | Depreciation rate, prior ÷ current | Depreciation slows (useful lives extended) |
| SGAI | SG&A ÷ sales | SG&A rises disproportionately (negative coefficient) |
| TATA | Total accruals ÷ total assets | Earnings outrun cash |
| LVGI | Leverage | Leverage rises (negative coefficient) |

SGI deserves its own caution: growth is not misconduct. It is in the model
because growth creates the *incentive* to sustain a trend, which is why fast
growers trip the M-score routinely and why a flagged score is a prompt to look,
never a finding.

### 2.2 The estimation sample

**Published.** The model was fitted on 74 manipulators identified from SEC
enforcement actions between 1982 and 1992, against a control sample of
Compustat non-manipulators. Two consequences follow and are stated wherever the
score appears: the base rate of manipulation in that sample is far higher than
in a random listed company today, so a flag carries a high false-positive rate;
and the sample was drawn under pre-2000 accounting standards, before ASC 606
and ASC 842 changed how revenue and leases reach the statements the indices are
computed from.

### 2.3 Thresholds

**Published — both conventions.** Beneish's paper supports two cutoffs
depending on the relative cost of false positives and false negatives: −1.78 is
the commonly cited screening threshold, −2.22 the more conservative one.

**House rule — three bands.** Rather than pick one and discard the
information, the report shows three: M < −2.22 *unlikely*, −2.22 ≤ M ≤ −1.78
*grey*, M > −1.78 *flagged*. The grey band is exactly the region where the two
published conventions disagree, and labelling it as such is more honest than
resolving it by fiat.

An M-score above the threshold is **not** evidence of manipulation. It says the
issuer's accruals and ratio dynamics resemble those of the manipulator sample
in Beneish's data. Fast-growing, acquisitive, and turnaround companies trip it
routinely. The report says this wherever the score appears.

### 2.4 What is deliberately not implemented

**The five-variable M-score is not implemented.** A reduced form circulates
widely, but it has no primary source in Beneish (1999) and its coefficients
cannot be traced to a published table. This project computes the eight-variable
model or nothing.

**TATA is required.** When total accruals cannot be computed — net income,
operating cash flow or total assets missing — the whole M-score is withheld
rather than computed from seven indices. TATA carries the largest coefficient
in the model, so dropping it does not degrade the score gracefully; it produces
a different model wearing the same name.

### 2.5 Winsorization stand-in

**House rule.** Beneish winsorized the ratio indices against his estimation
sample. That sample is not available, so its bounds cannot be reproduced.
Instead each index is clamped to **[0.1, 10]** and TATA to **[−1, 1]**, and any
clamp that binds is disclosed in the report naming the raw value.

This is a stand-in, not the paper's procedure, and it is labelled as one. Its
purpose is narrow: a denominator near zero (a company with almost no
receivables in the prior year, say) can produce an index in the thousands,
which would dominate the score arithmetically without carrying any economic
meaning. The clamp bounds that arithmetic; it does not reproduce Beneish's
distributional treatment.

### 2.6 Bank total-revenue tags

**Evidence — verified against filings.** A bank's total revenue is not tagged
where a non-financial's is. The tags that carry it, in the order the extractor
tries them:

1. `Revenues` — JPM tags total net revenue here (annual only).
2. `RevenuesNetOfInterestExpense`.
3. `InterestIncomeExpenseNet + NoninterestIncome` — the computed identity,
   verified exactly at JPM, BAC, WFC and C.

ASC-606 tags (`RevenueFromContractWithCustomer*`) come **last** for a bank, not
first. A bank that tags entity-level fee revenue under ASC 606 would otherwise
resolve to the fee-only figure, which excludes net interest income — the
largest component of a bank's revenue. This is the difference between reporting
a bank's revenue and reporting its fee income.

### 2.7 The tag that is deliberately excluded

**Evidence — verified against filings.**
`InterestAndDividendIncomeOperating` is **never** used as a revenue source. At
BAC, WFC and C it carries **gross** interest income, not net of interest
expense. Treating it as revenue overstates a bank's top line by the whole
interest-expense line, which for a large bank is a double-digit-percentage
error, and it flows into every margin, multiple and growth rate downstream.

---

## 3. Piotroski F-Score

Joseph Piotroski, *Value Investing: The Use of Historical Financial Statement
Information to Separate Winners from Losers*, Journal of Accounting Research
38, 2000.

**Published — nine binary signals**, one point each:

*Profitability* — ROA positive; operating cash flow positive; ROA improved
year over year; operating cash flow exceeds net income (the accrual signal).

*Leverage, liquidity and source of funds* — long-term debt to assets fell; the
current ratio improved; no new common equity was issued.

*Operating efficiency* — gross margin improved; asset turnover improved.

**Published — scaling.** ROA is net income **before extraordinary items**
divided by **beginning-of-year** total assets, not average and not end-of-year.
Both details are load-bearing: end-of-year scaling systematically penalises a
company that grew its balance sheet during the year, which inverts the signal
for exactly the fast-growing companies the score is meant to evaluate.

---

## 4. Accrual ratios

Richard Sloan, *Do Stock Prices Fully Reflect Information in Accruals and Cash
Flows About Future Earnings?*, The Accounting Review 71(3), 1996; Hribar &
Collins, *Errors in Estimating Accruals*, Journal of Accounting Research 40(1),
2002; Richardson, Sloan, Soliman & Tuna on accrual reliability, 2005.

**Published — the cash-flow approach is primary.** Accruals are computed as
(net income − operating cash flow − investing cash flow) scaled by net
operating assets. Hribar & Collins showed that the older balance-sheet approach
(differencing successive balance sheets) introduces measurement error whenever
a non-operating event moves the balance sheet — acquisitions, divestitures,
currency translation. Both are computed and reported; the cash-flow figure is
the primary one, and a divergence between them is itself disclosed, because it
is a reliable marker of M&A or FX activity in the period.

### 4.1 What the accrual anomaly is

**Published.** Sloan's finding is about *persistence*, not fraud: the accrual
component of earnings persists less into future earnings than the cash-flow
component, and prices behave as though investors do not distinguish them. A
high-accrual company is one whose reported earnings lean on estimates that have
not yet turned into cash. That may be aggressive accounting, or an ordinary
working-capital build in a growing business — the ratio does not know which,
and the report does not claim to.

### 4.2 Which formulation is used

**Published.** Two are computed. The cash-flow approach (Hribar–Collins) is
primary; the balance-sheet approach (ΔNOA) is reported beside it. Where they
diverge materially the divergence is itself disclosed, because the gap between
them is a reliable marker of an acquisition, a divestiture or currency
translation in the period rather than of accounting behaviour.

### 4.3 Bands and edge cases

**House rule — the bands.** Sloan's result is a **decile** result: the extreme
accrual deciles underperform. It contains no bright line, and any threshold is
therefore a display convention, not a finding. This project uses |ratio| < 0.10
*unremarkable*, < 0.20 *elevated*, otherwise *red*, and labels them heuristic
wherever they appear.

**House rule — the scaler.** Net operating assets can be zero or negative,
which makes the ratio meaningless or sign-flipped. Where NOA ≤ 0 or is
unavailable, the ratio is rescaled by **average total assets** and the
substitution is disclosed on the number.

---

## 5. Supporting red flags

**All house rules.** None of the flags in this section is a published model.
They are heuristics over the filed statements, every one of which states its
own threshold in the report next to the flag it produced, and every one of
which is marked `heuristic`. They exist to surface a pattern for a reader to
investigate, never to score a company.

Growth-based flags are suppressed entirely when base-year revenue is below a
floor, because a percentage change on a near-zero base is arithmetic noise
rather than a signal.

### 5.1 Receivables tie-in

**House rule.** Receivables growing materially faster than revenue is
surfaced as its own flag *even when the M-score is benign*. DSRI is one of
eight indices inside a weighted sum, so a genuine receivables problem can be
offset by the other seven and disappear into an unremarkable M. The flag is
the same underlying observation, reported where it cannot be averaged away.

### 5.2 Inventory

**House rule.** Two flags. `inventory-vs-revenue` fires when inventory grows
materially faster than revenue — the classic precursor to a write-down, and the
inventory analogue of the receivables tie-in above. `inventory-overhang` fires
on a sustained elevated level rather than a single year's growth, because a
one-year build ahead of a product launch is ordinary and a multi-year one is
not.

### 5.3 One-time items

**House rule.** `one-time-items` fires when items presented as non-recurring
are material to the period. `serial-one-time-items` fires when they recur
across years, which is the more informative of the two: an item that appears
every year is a cost of doing business being presented as an exception, and it
inflates every "adjusted" figure built on top of it.

### 5.4 Recurring discontinued operations

**House rule.** Discontinued operations affecting results in **two or more of
the last five fiscal years** raises a flag. A single discontinued operation is
an ordinary corporate event and says nothing. A company that reports one most
years is continuously reshaping its perimeter, which makes run-rate earnings
and every year-over-year comparison harder to trust — including the ones the
other models in this document depend on.

---

## 6. Applicability, edge cases, and where these models break

This section is the most important one in the document. Every model above was
fitted on a population, and the failure mode that matters is applying one
outside its population and reporting the result as though it meant something.

### 6.1 Degenerate inputs

**House rule — Altman X4 saturation.** X4 is equity over total liabilities. As
liabilities approach zero the ratio approaches infinity, and Altman's model was
never fitted on debt-free companies. X4 is capped at **±20** and the cap is
disclosed. A debt-free company is not a company with an infinitely safe Z; it
is a company the model has nothing to say about, and the cap makes the score
stop growing rather than pretend to measure something.

**House rule — near-zero revenue.** The Beneish indices are ratios of ratios of
revenue. Below a revenue floor they are not meaningful and the manipulation
indices are withheld rather than computed.

**House rule — negative gross margin.** GMI compares gross margin between two
years. When margin is negative in either year the index is not interpretable —
a move from −50% to −10% is a large improvement that GMI reads as
deterioration. GMI is neutralised and a red flag is raised instead, on the
grounds that a negative gross margin is economically worse than any GMI reading
could convey.

### 6.2 Short history

**House rule.** The Piotroski signals ΔROA and Δasset turnover need three
fiscal years, because they compare a change to the prior change. With only two
years available the score is reported **out of 7**, with the denominator stated
and the two missing signals named. It is never reported out of 9 with the
missing signals scored as zero, which would understate a company for having a
short filing history rather than for anything about its finances.

### 6.3 Financial companies

**Published — the exclusion is the authors'.** Altman excluded financial firms
from his estimation sample. Piotroski's sample was non-financial value stocks.
These are not this project's judgements about applicability; they are the
boundaries of the original studies.

The reasons are structural, not conservative. A bank's balance sheet is its
business: working capital over total assets (Altman X1) has no meaning when
deposits are the operating liability. Operating cash flow at a bank is
dominated by loan origination, deposit flows and trading, so it is not a
profitability signal (Piotroski) and swamps operating accruals entirely
(Sloan).

What the report does:

- **Altman Z is not computed at all** for a financial company — identified by
  sector or by SIC in the 6000–6799 range — and the reason is disclosed.
- **Accrual ratios are suppressed** for financial companies.
- **The Piotroski operating-cash-flow signal is withheld**, and where the
  F-score is shown for a financial company it carries the validation-sample
  caveat on the number itself.
- **Sector routing** carries the same caveat, so a financial company's route
  never presents these scores as though the models had been validated on it.

The alternative — computing them anyway and letting a reader assume they mean
what they mean for an industrial — is the single most common way these scores
are misused in practice.

---

## 7. Valuation inputs

The forensic models above are published in full. The discount rate is not: a
WACC is assembled from several sources, each with its own convention, and the
assembly is where most of the discretion lives. [`METHODOLOGY.md`](METHODOLOGY.md)
states what the code does; this section states where each convention comes from
and how much authority it carries.

### 7.1 Beta and the mean-reversion adjustment

**Published — the finding.** Marshall Blume, *On the Assessment of Risk*,
Journal of Finance 26(1), 1971: estimated betas revert toward the market beta
of 1 over time, so a raw historical slope is a biased forecast of the future
one.

**Resolved ambiguity — which adjustment.** Two formulas both travel under
Blume's name and they are not the same:

| | Formula | What it is |
| --- | --- | --- |
| Blume (1971) | 0.371 + 0.635·β | His fitted regression, on 1960s US data |
| Bloomberg | 0.333 + 0.667·β | The standardised convention built on that finding |

This project uses the **Bloomberg 2/3–1/3 weighting**, which is the industry
convention and what practitioners mean by "adjusted beta". The two differ by a
few hundredths across the normal range, so the choice is not material to a
valuation — but the label is routinely used as though the convention *were*
Blume's estimate, which implies a precision it does not have. The report prints
the formula (`0.667·raw + 0.333`) beside the name so a reader can see exactly
which one ran.

Neither is an estimate for this issuer or this period. Blume's coefficients
came from 1960s US data, and the 2/3 weighting is a rounded convention on top
of them.

**House rule — clamps.** The adjusted beta is clamped to [0.6, 2.0], and a raw
beta outside (0, 4] is treated as unusable: the WACC fails closed rather than
inventing market exposure from a broken regression. A negative or near-zero
raw beta usually means the return series is wrong, not that the company is
uncorrelated with the market.

### 7.2 Risk-free rate and equity risk premium

**Published — the ERP source.** Aswath Damodaran's implied equity risk premium,
which is forward-looking (backed out of index prices and expected cash flows)
rather than a historical average. The provider's own US premium is preferred
when available; the Damodaran figure is the dated fallback.

**House rule — staleness.** An implied ERP more than **210 days** old is
rejected rather than used. An ERP is a market observation, not a constant, and
a year-old one can be a full percentage point wrong after a repricing — which
moves a terminal value by far more than it sounds.

**House rule — plausibility band.** An ERP outside [3%, 25%] is treated as a
data error and falls back. This is a sanity bound on the input, not a view
about what the premium should be.

### 7.3 Cost of debt

**Published — the synthetic rating.** Damodaran's interest-coverage-to-spread
table maps an issuer's coverage ratio to a credit spread over the risk-free
rate. It is the standard approach for an issuer with no rated public debt.

**House rules.** Three, all disclosed on the number: the effective rate
(interest expense ÷ average total debt) is preferred where it is plausible;
"plausible" is [rf − 1, rf + 19] percentage points, outside which the synthetic
rating is used instead; and debt below **2% of assets** is treated as noise,
because an effective rate computed on a trivial balance is arithmetic rather
than a cost of capital. The method that actually ran is always named.

### 7.4 Terminal value

**Published — the constraint.** No company can grow faster than the economy in
perpetuity, so the terminal growth rate cannot exceed the risk-free rate
(Damodaran). This is the one part of a DCF where a small input error compounds
without limit, and it is the most common way a discounted cash flow is made to
say whatever its author wants.

**House rule — the cap.** Terminal growth is **min(2.5%, risk-free rate)**. The
risk-free bound is the published constraint; the 2.5% is this project's, and
the report labels it a HOUSE CONVENTION in those words wherever it appears.

**House rule — the Gordon guard.** The base case requires WACC − g ≥ 2.0
percentage points (1.5 in the sensitivity grid, where a tighter guard would
blank the cells the grid exists to show). As the denominator approaches zero
the terminal value approaches infinity; the guard bounds that, and when it
binds the report says so rather than printing the result.

**House rule — terminal ROIC.** Returns fade to the cost of capital by default.
Where ROIC exceeded WACC in each of the last four or more fiscal years, half
the median spread is carried in perpetuity, capped at 5 percentage points. This
is a convention about competitive advantage, not a finding, and it is labelled
as one.

### 7.5 What the clamps are and are not

Every bound in this section — the beta clamp, the ERP band, the cost-of-debt
plausibility range, the WACC clamp of [max(6%, rf + 1%), 20%] — exists to stop
a **broken input** producing a confident number. None of them is a view about
what a company's cost of capital should be.

The distinction matters when one binds. A clamp that moves the WACC by 0.5
percentage points or more is disclosed in the manifest, because at that point
the discount rate is partly this project's convention rather than the issuer's
data, and a reader is entitled to know which.

---

## What would improve this

Honest gaps in the evidence base, listed so they are not mistaken for settled:

- The Beneish winsorization (§2.5) is a stand-in. Reproducing the paper's
  treatment would require its estimation sample.
- The accrual bands (§4.3) are display conventions over a decile result. A
  defensible improvement would rank an issuer against a contemporaneous
  cross-section rather than against fixed cut-offs.
- The Altman variant-selection rule (§1.4) is this project's, and the
  manufacturer test that drives it is a classification over SIC codes rather
  than a judgement about the business.
- Every red flag in §5 is a heuristic with a hand-set threshold. None has been
  validated against an outcome sample, and the report says so rather than
  implying a hit rate none of them has earned.
- The beta (§7.1) is a historical regression with a conventional shrinkage
  applied. A forward-looking or peer-relative beta would be better justified for
  an issuer whose business has changed inside the estimation window, and the
  report currently discloses the standard error and R² rather than acting on
  them.
- The terminal-growth cap and the terminal-ROIC fade (§7.4) are conventions
  chosen for defensibility, not fitted to anything. They are the two inputs a
  reader should override first if they disagree, which is why both are labelled
  in the report rather than buried here.
