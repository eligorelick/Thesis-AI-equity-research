# Sector routing and financial-company methodology (WS5)

This section is written for merging into `docs/METHODOLOGY.md` at integration.
It documents decisions D-16 and D-17: how a company is routed, how the equity
model works, which route metrics are computed, how FFO and AFFO are defined, and
which forensic batteries apply where.

Sources cited by name where they are the authority for a rule:

- **NAREIT**, *Funds From Operations White Paper* (the FFO definition and its
  restatements) — the FFO/AFFO rules below.
- **Piotroski (2000)**, *Value Investing: The Use of Historical Financial
  Statement Information to Separate Winners from Losers* — the F-score, its nine
  signals and its non-financial estimation sample.
- **Altman (1968)**, *Financial Ratios, Discriminant Analysis and the Prediction
  of Corporate Bankruptcy*, and **Altman (2000)**, *Predicting Financial
  Distress of Companies* (the Z′ and Z″ revisions) — the Z-score variants and
  their exclusion of financial firms.
- **Beneish (1999)**, *The Detection of Earnings Manipulation* — the M-score,
  its eight indices, and its exclusion of financial institutions (p. 5).
- **Damodaran**, *Investment Valuation* and the accompanying notes on **valuing
  financial service firms** — the equity-side excess-return model, the reason
  FCFF and enterprise value are not defined for financials, and the
  justified-price-to-book identity.

## 1. Routing

### 1.1 Three inputs, in order

A company's base route is decided by the vendor industry string, the SEC SIC
code, and tag evidence read from EDGAR companyfacts.

1. **Industry prefix** (case-insensitive, trimmed): `Banks…` → bank,
   `Insurance…` → insurer (except `Insurance - Brokers`, which is fee-based and
   goes to the general map), `REIT…` → REIT.
2. **SIC fallback**, consulted only when the industry string gives no match:
   6020-6199 → bank, 6300-6499 → insurer, 6798 → REIT (sub-map undecided, see
   §1.3), sector "Financial Services" without a matching industry → the general
   map (the FIN-OTHER treatment).
3. **XBRL evidence** (`src/pipeline/stageB/routingEvidence.ts`), read-only from
   the bundle's companyfacts payload.

### 1.2 What the tags decide

| Evidence | Conclusion |
| --- | --- |
| deposits **and** (loans **or** net interest income) | bank |
| premiums earned **and** loss or policy reserves | insurer |
| `RealEstateInvestmentPropertyNet` / `…AtCost` | equity REIT |
| mortgage-backed securities **or** loans held for investment, **and no** investment property | mortgage REIT |

Three deliberate properties:

- **A single line item is not a business model.** Deposits alone do not make a
  filer a bank; a loan or net-interest-income tag must accompany them. An
  industrial holding customer deposits is not misrouted.
- **A retired tag cannot classify a filer today.** A tag counts only when its
  newest non-zero fact, from a core form (10-K/10-Q/20-F and their amendments,
  after the max-`filed` dedup), falls within 24 months of the newest evidence
  fact on file.
- **The property tag wins for hybrids.** A REIT that files investment property
  *and* mortgage assets is an equity REIT; the mortgage classification requires
  the absence of investment property.

### 1.3 Evidence confirms or contradicts; it does not silently override

- Neither industry nor SIC matched → evidence **decides** the base route, and
  the note names the tags, their values, their period ends, and the industry and
  SIC inputs that failed to decide.
- Industry/SIC matched and evidence agrees → the note records the confirmation.
- Industry/SIC matched and evidence disagrees → **the declared classification
  stands**, and the disagreement is filed as `route.evidence.conflict` (`warn`).
  A vendor string and an SEC code are evidence too; the honest outcome is a
  disclosed conflict, not a silent re-route.
- Companyfacts unavailable → `route.evidence` (`info`), raised only for
  financial candidates, so an ordinary industrial's manifest is not padded with
  a check that was never relevant.

### 1.4 The REIT sub-map, and why SIC 6798 cannot decide it

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

## 2. Valuing a financial company

### 2.1 What is withheld, and why

Damodaran's treatment of financial service firms is the authority for the
central point: for a bank, an insurer or a mortgage REIT, debt is **raw
material**, not financing. Four consequences, each withheld with a stated reason
in the notes and the missing-data manifest:

| Withheld | Manifest key | Reason |
| --- | --- | --- |
| FCFF/WACC DCF | `valuation.dcf` | free cash flow to the firm subtracts debt service from an operating cash flow that here *is* financing activity |
| FCFF reverse DCF | `valuation.reverseDcf` | inverts the same model; the growth or margin it solves for inherits the same category error |
| EV/EBITDA | `valuation.evEbitda` | enterprise value adds debt and subtracts cash, both operating items here — a profitable bank can show a negative EV |
| ROIC − WACC | `returns.roicVsWacc` | invested capital (debt + equity − cash) is undefined when deposits, policy reserves or repo fund the assets and cash is itself an earning asset |

Equity REITs additionally withhold a **net-income DCF**
(`valuation.netIncomeDcf`): GAAP net income is struck after real-estate
depreciation, a large non-cash charge against assets that typically hold or gain
value, so discounting it understates the company. FFO exists precisely because
of this.

### 2.2 The excess-return equity model

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
- **Opening book value `BV0`** — the latest total stockholders' equity. Later
  years compound at `ROE × retention`, where retention is `1 − payout`. A loss is
  retained in full: `roe × retention` on a negative ROE would return a fraction
  of the loss to book value, which is arithmetically a capital injection.
- **Payout** — dividends plus net buybacks over net income, three-year average
  from the annual cash-flow statements. Missing history suppresses the model
  rather than assuming a universal payout.

The model also reverse-solves the **starting** ROE that reproduces the current
market cap, under the same fade the forward path uses. Inverting a *different*
model (a flat ROE, as an earlier version did) made the solved figure
systematically low, because a flat path is worth more than a fading one, and
biased every financial toward "the market is too pessimistic". A clean property
follows from the identity: an issuer priced at book solves to exactly the cost
of equity.

### 2.3 P/TBV against ROTE

The multiple a financial is actually read on is price to **tangible** book, and
the return that justifies it is return on **tangible** common equity. Both use
the same denominator — equity less goodwill, other intangibles and preferred —
because goodwill absorbs losses only after common equity is gone, and pairing a
book-value multiple with a tangible-equity return would compare two different
bases. A goodwill-heavy acquirer at 1.0× book can be at 2.0× tangible book.

The justified multiple is the residual-income identity the forward model already
assumes:

```
justified P/TBV = (ROTE − g) / (CoE − g),   g = ROTE × retention
```

It is **withheld, never clamped**, when `CoE − g` falls below 0.5pp: the ratio
diverges through infinity there, and any number it produced would be an artefact
of the arithmetic rather than a valuation. When ROTE, the cost of equity or the
payout history is missing, the multiple is still shown and the justified figure
is withheld with its reason.

## 3. Route metrics

`src/pipeline/stageB/financialMetrics.ts` computes the figures each financial
route leads with, from the filer's own XBRL tags, read-only. Two rules govern
every metric:

1. **A named metric is computed only from the figures its definition calls
   for.** Where those figures are not on file the metric is **withheld with a
   reason**, which reaches the manifest as `financialMetrics.<key>`.
2. **A stand-in is published under its own name**, never the name of the metric
   it stands in for, and is marked `proxy`.

### 3.1 Banks

| Metric | Definition | When withheld |
| --- | --- | --- |
| Net interest margin | net interest income / average **earning** assets | whenever the filer tags no earning-assets element. us-gaap carries no standard average-earning-assets concept, and total assets include premises, goodwill and other non-earning items, so dividing by them would understate the margin. |
| Net interest income / average total assets | the honest denominator that *is* available | published as a labeled stand-in beside a withheld NIM, stating that it sits below a true NIM |
| Efficiency ratio | noninterest expense / (net interest income + noninterest income) | when the noninterest split is not tagged. This split exists in the filings even though vendor income statements omit it. |
| CET1 | company-reported CET1 capital / risk-weighted assets | when no CET1 element is tagged (it is often only in the regulatory-capital footnote text) |
| Tangible leverage | (equity − goodwill − intangibles − preferred) / (assets − goodwill − intangibles) | the labeled stand-in for CET1; it does **not** risk-weight assets, so it is not comparable to a regulatory capital ratio and is always the more conservative read |
| NPL ratio | nonaccrual loans / total loans | when nonaccrual loans are filed only by loan class (dimensional facts companyfacts does not expose as a total) |
| Provisions / loans | provision for credit losses / total loans | when neither the provision element nor its component sum resolves |
| Cost of deposits | interest expense on deposits / average deposits | when `InterestExpenseDeposits` is untagged — total interest expense covers borrowings too and would overstate it |

### 3.2 Insurers

| Metric | Definition |
| --- | --- |
| Loss ratio | incurred claims / premiums earned |
| Expense ratio | underwriting expenses / premiums earned |
| Combined ratio | loss ratio + expense ratio |
| Reserve development | incurred claims attributable to prior accident years; positive is adverse, negative is a favourable release |

The denominator is **GAAP premiums earned**. A statutory expense ratio divides by
premiums *written*, so the computed figure is not directly comparable to a
statutory filing, and the company-reported combined ratio remains the gold
standard — the computed one is labeled a computation. The combined ratio is
**withheld outright when either half is missing**: a loss-ratio-only figure
reads materially flattering (64% where the real combined figure is 92%).

### 3.3 Mortgage REITs

| Metric | Definition |
| --- | --- |
| Book value per share | (total equity − preferred) / shares |
| Leverage | total assets / total equity |
| Net interest spread | interest income / average total assets − interest expense / interest-bearing funding (repurchase agreements) |

Total assets is a fair yield denominator here — unlike at a bank — because a
mortgage REIT's assets are interest-earning securities and loans. The spread is
withheld when either leg or its balance is missing; a one-legged figure would
misstate it.

## 4. FFO and AFFO (NAREIT)

FFO follows the NAREIT white-paper definition:

```
FFO = net income (GAAP)
    + real-estate depreciation and amortization
    − gains on sales of property
    + impairments of depreciable real estate
```

Applied exactly where the filer tags the components. Where **real-estate**
depreciation is not tagged separately, total depreciation and amortization is
added back instead, and the figure is labeled **approximate** with the direction
of the error stated: NAREIT adds back only the real-estate portion, so the
approximation sits at or above the definition. Untagged gains and impairments are
treated as zero and the note says so, rather than being guessed.

AFFO subtracts recurring (maintenance) capital expenditure and straight-line
rent where the filer tags them. Where it does not, AFFO falls back to
`FFO − all capital expenditure` and is disclosed as a **conservative floor**,
since development spending is subtracted too.

P/FFO and P/AFFO are computed from these figures. When the REIT sub-map is
`undetermined` (§1.4) every FFO-based figure is withheld.

## 5. Forensic batteries by route

Piotroski (2000) built the F-score on non-financial firms; Altman excluded
financial institutions from every Z-model estimation sample; Beneish (1999)
excluded them from the M-score sample (p. 5). The routing layer honours those
sample definitions rather than producing a number outside them.

### 5.1 Altman Z, Beneish M, accrual ratios

All three are withheld on the bank, insurer and mortgage-REIT routes, and on any
issuer whose sector is "Financial Services" or whose SIC falls in 6000-6499 or
6700-6799 (equity REITs excepted, with a caution note). Each files its reason in
the manifest — `forensics.altmanZ`, `forensics.beneishM`,
`forensics.accrualsRatio` — because a blank cell with no reason reads as a fetch
that failed rather than as a deliberate refusal.

SIC major group 65 (real-estate operators, agents and managers) is deliberately
outside the exclusion band: those are ordinary operating companies with
inventory, receivables and a working-capital cycle.

### 5.2 Piotroski F, on three scales

The score is reported over the signals that remain, with its own denominator,
and the result carries a variant and a label so a reduced score is never read
against the 9-point scale.

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
