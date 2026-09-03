# README notes — WS5 (sector routing and financial-company methodology)

Facts the README must carry after WS5. WS5 does not edit `README.md`; WS9 does.
Every statement below matches the code on branch `ws5-financials`.

## 1. Routing now reads XBRL evidence, not only SIC and industry

The README's routing description must say that a company's route comes from
three inputs, not two:

1. the vendor industry string (prefix match, case-insensitive),
2. the SEC SIC code from the EDGAR submissions payload, and
3. **tag evidence from EDGAR companyfacts** — what the filer actually reports.

Evidence rules (`src/pipeline/stageB/routingEvidence.ts`):

| Tags present | Route |
| --- | --- |
| deposits **and** (loans **or** net interest income) | bank |
| premiums earned **and** loss/policy reserves | insurer |
| `RealEstateInvestmentPropertyNet` (or at cost) | equity REIT |
| mortgage-backed securities **or** mortgage loans held for investment, **without** investment property, **and** corroborated by repo funding or a financial SIC/sector | mortgage REIT |

Every element in the mortgage-REIT groups names mortgage-backed securities or
mortgage loans. Generic elements (`AvailableForSaleSecuritiesDebtSecurities`,
`NotesReceivableNet` and their kin) are deliberately absent: a corporate
treasury's bond portfolio and a manufacturer's vendor financing are not evidence
of a mortgage REIT.

How the three inputs combine:

- Evidence **decides** when industry and SIC give no match — except for the
  mortgage-REIT rule, the only rule that fires on a single tag group, which must
  first be corroborated by repo funding
  (`SecuritiesSoldUnderAgreementsToRepurchase`) or by an already-financial SIC or
  sector. Uncorroborated, it is disclosed as `route.evidence.conflict` (`warn`)
  and changes nothing.
- Evidence **confirms** a match, and the routing note names the tags and values.
- Evidence that **disagrees** never silently overrides the declared
  classification. The route stays on industry/SIC and the disagreement is a
  `warn` manifest entry (`route.evidence.conflict`).
- A tag counts only when it carries a non-zero fact from a core form within 24
  months of the newest evidence fact, so a tag a filer abandoned years ago
  cannot classify it today.
- Missing companyfacts is disclosed (`route.evidence`, `info`) for financial
  candidates only, so an ordinary industrial's manifest is not padded.

## 2. SIC 6798 no longer decides equity vs mortgage REIT

SIC 6798 covers both REIT types and the two maps disagree about which metrics
mean anything. With no XBRL evidence and no explicit vendor sub-type, the route
is `reit` with sub-map **`undetermined`**, which withholds **both** families:

- FFO, AFFO, P/FFO, AFFO payout and the implied cap rate (these presume an
  equity REIT), and
- book value per share, the net interest spread and assets/equity leverage
  (these presume a mortgage REIT).

The reason is on the `route.reitSubmap` manifest entry. A keyless profile's
`REIT - Diversified` label is derived from SIC 6798 itself, so it is **not**
treated as a vendor sub-type.

## 3. Forensic indicators and their sector applicability

The README currently says (lines ~212-214) only that the Piotroski F-score
withholds its current-ratio, gross-margin and both operating-cash-flow signals
on the bank, insurer and mortgage-REIT routes. That is now incomplete. The full
list of what the app computes, and where each applies:

### Battery-level

| Indicator | Where it applies | Where it is withheld, and why |
| --- | --- | --- |
| **Altman Z** (variants: original 1968, Z' private, Z″, Z″+3.25 emerging-market) | general route; equity REITs, with a caution note | bank, insurer, mortgage REIT; also any issuer whose sector is "Financial Services" or whose SIC falls in 6000-6499 or 6700-6799 (equity REITs excepted). Every Z-model estimation sample excluded financial institutions: deposit-funded leverage makes X1 (working capital) and X4 (equity/liabilities) meaningless. Reason reaches the manifest as `forensics.altmanZ`. |
| **Beneish M** (8-variable, with its DSRI/GMI/AQI/SGI/DEPI/SGAI/LVGI/TATA indices) | general route; equity REITs | same financial classifications. Beneish (1999) excluded financial institutions from the estimation sample (paper p.5), and the indices read receivables, gross margin, asset quality and depreciation, none of which carries the same meaning on a financial balance sheet. Manifest: `forensics.beneishM`. |
| **Sloan-style accrual ratios** (cash-flow and balance-sheet variants, with bands) | general route; equity REITs | same financial classifications. The scaler is net operating assets, which subtracts (total liabilities − total debt); for a bank that is its deposits, i.e. its raw material, so the ratio would measure funding mix rather than earnings quality. Manifest: `forensics.accrualsRatio`. |
| **Piotroski F** | every route, but on two different scales — see below | never withheld outright |
| **Plain-English support flags** (receivables growth gap, inventory growth gap, one-time items and "serial one-timers", elevated DSRI) | all routes | individually skipped when their inputs are missing, each with a note |
| **SEC Form 8-K Item 4.02** (non-reliance / restatement) and **Item 4.01** (auditor change) | all routes | surfaced as forensic notes and manifest entries whenever the filings exist |

### Piotroski F, signal by signal

The score is reported over the signals that remain, **with its own denominator**,
and the result carries a `variant` and a `label` so a reduced score is never read
against the 9-point scale. Three scales exist:

| Signal | General route | FIN-OTHER (asset manager, exchange, insurance broker) | Bank / insurer / mortgage REIT |
| --- | --- | --- | --- |
| ROA > 0 | scored | scored | scored |
| CFO > 0 | scored | **withheld** | **withheld** |
| ΔROA > 0 | scored | scored | scored |
| CFO > net income (accrual quality) | scored | **withheld** | **withheld** |
| ΔLEVER (long-term debt / assets fell) | scored | scored | **withheld** |
| ΔLIQUID (current ratio rose) | scored | **withheld** | **withheld** |
| No equity issuance | scored | scored | scored |
| ΔMARGIN (gross margin rose) | scored | **withheld** | **withheld** |
| ΔTURN (asset turnover rose) | scored | scored | **withheld** |
| **Scale** | **9** | **5** | **3** |

Reasons, in the wording the report carries:

- **CFO signals** — a bank's operating cash flow is dominated by loan, deposit,
  trading-asset and reserve flows, so it is neither a profitability nor an
  accrual-quality signal.
- **Current ratio** — an unclassified financial balance sheet has no meaningful
  current/non-current split.
- **Gross margin** — revenue − cost of revenue is meaningless on a
  net-interest-spread or premium income statement.
- **ΔLEVER** — treats debt as a solvency burden, but for these routes debt is an
  input, and the funding that matters (deposits, policy reserves, repo) is not
  long-term debt at all. A bank shrinking bond issuance while deposits grow
  would score a deleveraging point it did not earn.
- **ΔTURN** — reads revenue/assets as operating efficiency, but a financial
  company's assets *are* its revenue-generating book, so the ratio tracks the
  rate environment and balance-sheet mix.

The FIN-OTHER column matters: those issuers are fee-based with ordinary balance
sheets, so ΔLEVER and ΔTURN are **kept** for them. This mirrors the existing
ROTE-vs-ROIC switch, which is deliberately narrower than the forensic
classifier.

## 4. Financial routes withhold four valuation models, each with a reason

On the bank, insurer and mortgage-REIT routes the report withholds, and says
why in both the notes and the missing-data manifest:

| Withheld | Manifest key | Reason in short |
| --- | --- | --- |
| FCFF/WACC DCF | `valuation.dcf` | free cash flow to the firm subtracts debt service from an operating cash flow that, here, *is* financing activity |
| FCFF reverse DCF | `valuation.reverseDcf` | inverts the same model, so it inherits the same category error |
| EV/EBITDA | `valuation.evEbitda` | enterprise value adds debt and subtracts cash, both operating items here (a profitable bank can show a negative EV) |
| ROIC − WACC | `returns.roicVsWacc` | invested capital (debt + equity − cash) is undefined when deposits, reserves or repo fund the assets and cash is itself an earning asset |

Equity REITs additionally withhold a **net-income DCF** (`valuation.netIncomeDcf`):
GAAP net income is struck after real-estate depreciation, a non-cash charge on
assets that typically hold or gain value.

## 5. What replaces them

- **Bank / insurer / mortgage REIT** — an excess-return equity model:
  `book equity + Σ (ROE − cost of equity) × prior-year book equity, discounted
  at the cost of equity` over an explicit 10-year horizon, with ROE faded
  linearly to the cost of equity so terminal excess is zero and **no continuing
  value is added**. The discount rate is the cost of equity, never a WACC. The
  report also shows **P/TBV against ROTE**, both on the tangible base, beside a
  stable-growth cross-check `(ROTE − g) / (CoE − g)` with
  `g = min(ROTE × retention, 2.5% terminal-growth cap, risk-free rate)` — the
  same growth ceiling the DCF terminal value obeys. That cross-check assumes
  ROTE persists in perpetuity while the forward model fades ROE to the cost of
  equity, so the two can disagree and the report says so rather than claiming
  they cannot. It is withheld rather than clamped when `g` approaches the cost of
  equity and the ratio diverges.
- **Equity REIT** — FFO and AFFO per the NAREIT definition, and P/FFO. Both are
  measured on the latest **fiscal year** — every component, including the
  statement fallbacks, so the figure is never a hybrid of a fiscal-year net
  income and a trailing depreciation — and the REIT block's as-of is that
  period end.

## 6. Route metrics are computed now, not merely listed

The route table has named NIM, the efficiency ratio, the combined ratio, book
value per share, the net interest spread and leverage since it was written,
while nothing computed any of them. They are now computed from the filer's own
XBRL tags where the definition allows, and withheld with a stated reason
otherwise (`src/pipeline/stageB/financialMetrics.ts`). Withheld metrics reach
the manifest as `financialMetrics.<key>`.

| Route | Metrics |
| --- | --- |
| Bank | NIM, net interest income / average total assets (labeled stand-in), efficiency ratio, CET1 as reported **or** tangible common equity / tangible assets (labeled stand-in), NPL ratio, provisions / loans, cost of deposits |
| Insurer | loss ratio, expense ratio (both `OtherUnderwritingExpense` **and** `DeferredPolicyAcquisitionCostAmortizationExpense` required; commission and fee INCOME is not an expense), combined ratio, prior-year reserve development |
| Mortgage REIT | book value per share, leverage (assets / equity), net interest spread — withheld, because the interest-expense numerator covers every borrowing while the only funding balance on file is repo — with a repo-funded stand-in published under its own name and marked a proxy |

Two rules the README should state, because they are what make the figures
trustworthy:

1. **A named metric is computed only from the figures its definition calls
   for.** A true net interest margin divides by average *earning* assets;
   us-gaap has no standard concept for those, and total assets include premises
   and goodwill. NIM is therefore withheld unless the filer tags earning assets,
   and the denominator that *is* available is published beside it as "net
   interest income / average total assets" with the difference stated.
2. **A stand-in is published under its own name.** CET1 is a risk-weighted
   regulatory ratio; where none is tagged, tangible common equity over tangible
   assets appears as a *leverage* ratio and never as a capital ratio.

The combined ratio is withheld outright when either half is missing: a
loss-ratio-only figure reads materially flattering. The expense ratio applies
the same rule one level down — a partial sum of its two components is withheld
naming the missing one, rather than published as a complete figure.

## 7. Statements that are now wrong in the README

- Any claim that the Piotroski financial variant withholds *four* signals: it
  withholds four for FIN-OTHER issuers and **six** on the deposit-, float- or
  repo-funded routes.
- Any claim that SIC 6798 routes to the equity-REIT map: it now routes to `reit`
  with an `undetermined` sub-map unless evidence or an explicit vendor sub-type
  decides.
- Any claim that FFO is always "netIncome + D&A": it is the NAREIT definition
  where the filer's tags allow, and the approximation is labeled as such,
  including which direction it errs in. Two components can stand in — total
  depreciation for real-estate depreciation, and the generic asset-impairment
  charge for the real-estate impairment — and both leave FFO at or above the
  definition.

## 8. Where the route metrics reach a reader

`Report.routeMetrics` (optional, `RouteMetricsSchema` in `src/report/schema.ts`)
is populated at report assembly from `computed.financialMetrics` plus the
excess-return model's P/TBV-against-ROTE reading, by `routeMetricsBlock` in
`src/pipeline/compute.ts`. Both assembly paths fill it —
`assembleReport` (`src/pipeline/stageC/passes.ts`) and `enrichDataOnlyReport`
(`src/pipeline/stageC/dataOnlyReport.ts`) — and the field is absent entirely on
routes with no route metrics, so a general report is unchanged.

It renders inside the Valuation section on all three surfaces: the live report
(`ValuationSection` in `src/components/report/sections.tsx`), the Markdown export
and the print HTML. Every row shows its value or the word **withheld** beside the
REASON it was withheld, and a stand-in is marked as one. The same figures reach
the analyst payload: the excess-return horizon, the cost of equity, the opening
book value, P/TBV, ROTE and the justified multiple are all payload figures.

Withheld metrics also continue to reach the missing-data manifest as
`financialMetrics.<key>`.
