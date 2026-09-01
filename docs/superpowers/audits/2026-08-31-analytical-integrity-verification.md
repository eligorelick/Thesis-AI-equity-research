# Analytical integrity audit — verification record

**Date:** 2026-08-31
**Scope:** the quantitative core (`src/pipeline/stageB/`), the providers and
EDGAR extraction that feed it, and the report surfaces that publish it.
**Baseline:** `7d4966c` ("cleaning")
**Head:** the commits listed below, plus four remediation commits that correct
defects found by auditing this work itself (see "Verification of this work").
**Gate:** `npm run verify` exits 0 at every commit except `228f32f`, which is
recorded as a failure below.

---

## Why this document exists

`docs/superpowers/audits/2026-08-30-code-and-docs-audit.md` was written by the
same agent that made the changes it describes. This record is the result of
treating that document as a claim rather than as evidence, re-deriving the
findings from the code, and then auditing the analytical core itself.

It supersedes Task B1 of
[`../plans/2026-08-31-outstanding-audit-items.md`](../plans/2026-08-31-outstanding-audit-items.md)
(the working tree is landed) and records the decision for Task B3 (the unmerged
branches).

---

## Method

Four adversarial passes, all structured so that no finding reaches this document
on one agent's say-so. Passes 3 and 4 audit THIS SESSION'S OWN CHANGES; their
results are in "Verification of this work" below.

**Pass 1 — 45 agents, ~4.9M tokens, 1,515 tool calls.** Twelve finders, one per
dimension of the analytical core, each required to cite `file:line`, quote the
offending code, state the correct formula with its published source, and give a
concrete failure scenario. Findings were deduplicated across dimensions, then
each was verified by **two independent agents with different briefs**: a skeptic
instructed to refute it and to default to "refuted" when uncertain, and an
impact assessor judging whether it materially changes a published number. A
finding was confirmed only when both agreed.

**Pass 2 — 48 agents, ~3.3M tokens, 995 tool calls.** The lower-severity
findings Pass 1 did not have verification budget for, re-checked against the
tree *after* Pass 1's fixes had landed, so that anything already resolved was
classified as such rather than re-reported.

| | Findings | Confirmed | Already fixed | Refuted |
| --- | ---: | ---: | ---: | ---: |
| Pass 1 (top 16 by severity) | 16 | 14 | — | 2 |
| Pass 2 (remaining 48) | 48 | 24 | 4 | 20 |
| **Total unique** | **64** | **38** | 4 | 22 |

All 38 confirmed defects are fixed. Per-agent evidence, including the refutations,
is preserved in the workflow journals under
`.claude/projects/*/subagents/workflows/`.

---

## What was wrong, by class

### Research-methodology errors

The most consequential class: code that implements a published model incorrectly.

- **Altman variant selection never received a SIC code** (`cb2be5e`).
  `compute.ts` passed neither `sic` to `routeCompany` nor `sicCode` to the
  forensics classification, and FMP's profile carries no SIC at all, so the
  SIC-decisive branch was dead code and every company fell to a sector-string
  heuristic. Altman (1968, *Journal of Finance* 23(4)) is estimated on
  publicly-traded **manufacturers** and puts the **market** value of equity in
  X4; Z″ (Altman 1983; Altman–Hartzell–Peck 1995) drops X5 and substitutes
  **book** equity. Philip Morris (SIC 2111), Apple (3571), Intel (3674), Nike
  (3021) and Coca-Cola (2086) match neither heuristic branch and were scored on
  the wrong model. EDGAR submissions already carried the SIC and the bundle
  discarded it.

- **The excess-return reverse solve inverted no model** (`ad48e3e`). It held ROE
  constant for ten years and then stopped accruing residual income — neither the
  competitive fade the forward model assumes nor the perpetuity "steady state"
  promises. Because a flat path is worth more than a fading one, the solved
  figure came out systematically low, and `grading.ts` subtracts it directly
  from the current ROE at 0.5 weight of the valuation aspect, biasing every
  bank, insurer and mortgage REIT toward "cheap". It now inverts the forward
  model exactly. The fade was chosen over the Gordon closed form because ROE
  mean-reversion toward the cost of capital is the robust empirical finding
  (Fama–French 2000; Nissim–Penman 2001), because the closed form carries a pole
  at *g → r* and a degenerate full-retention case, and because a reverse solve
  that does not invert the model beside it produces contradictory conclusions on
  one screen.

- **ROIC invested capital used a third cash convention** (`12a5978`). It
  subtracted `cashAndCashEquivalents` alone while the house net-debt resolver and
  the DCF's own sales-to-capital basis string both net cash + short-term
  investments — so one company carried two invested-capital definitions and ROIC
  was understated for any issuer holding liquidity in T-bills. The audit fixture
  moves 36.46% → 40.06%.

- **The DCF credited a tax refund on operating losses** (`1453014`).
  `NOPAT = EBIT × (1 − t)` applied to a negative EBIT hands the firm
  `|EBIT| × t` of cash it never receives. Losses now carry forward as an NOL that
  shelters later taxable income; the no-loss path keeps its exact original
  expression so unaffected issuers are bit-identical.

- **Beneish SGAI and DEPI mixed source definitions across years** (`81d6b98`).
  Each resolved its input basis per row, so one year could use the combined SG&A
  field while the other summed G&A + S&M, or one year could take cash-flow D&A
  and the other income-statement D&A. The index then measured a change of
  *source* as a change in overhead discipline or depreciation policy. DSRI
  already resolved its basis once for the pair; SGAI and DEPI now do too.

- **Piotroski scored two structurally meaningless signals for financials**
  (`81d6b98`): the current ratio (a financial balance sheet has no meaningful
  current/non-current split) and the gross margin (revenue − costOfRevenue is
  meaningless on a net-interest-spread income statement) — both hard-suppressed
  elsewhere in the same codebase. Two coin-flips inside a 9-point score
  presented as a solvency read.

- **CAPM used the US equity risk premium for every issuer** (`5f84a92`),
  discarding the country risk premium FMP supplies per country in the same
  payload, and understating cost of equity for every foreign issuer.

- **Financial moat was scored on ROIC** (`805e740`). Invested capital is
  `debt + equity − cash`; for a deposit-funded institution debt *is* the raw
  material and cash is an earning asset, so the denominator is undefined and
  frequently non-positive. The bank route already declared it leads with `rote`
  and `tangibleCommonEquity` and computed neither. Both are now computed and
  financial routes score return on tangible common equity instead.

### Silent defaults that assert something untrue

- Missing retained earnings became `X2 = 0` in Altman (`dfc208c`). X2 carries the
  second-largest coefficient, and a company with an accumulated deficit has a
  strongly negative X2, so the substitution moved it toward the **safe** zone —
  the one direction a solvency screen must never fail in. Its only mitigation
  was a note, and `runForensics` was discarding this model's notes before they
  reached the report.
- Every monetary figure rendered a hardcoded `$` (`e83d147`), and
  `projectionCurrency` defaulted to `"USD"` (`a45449a`), so a TWD or CHF issuer's
  figures were labelled US dollars on no evidence.
- The provenance registry stamped the profile **trading** currency onto
  statement-derived computed figures (`a45449a`), so an ADR's DCF per-share
  contradicted the statement cells it was computed from.

### Promises the code did not keep

- The bank route declared forensics `"replace"`d by "bank-health-metrics (CET1,
  TCE/assets, provisions trend)" — none of which anything computed, while
  `grading.ts` stated plainly that capital adequacy is "not modelled in v1"
  (`a0159fe`). A reader was told a bank had been screened for solvency when it
  had not been screened at all.
- The recent-IPO plan promised to grey out `technicals.beta`, which does not
  exist, while the beta actually consumed (the vendor profile beta feeding CAPM)
  went undegraded and undisclosed (`a0159fe`).
- Peer comparison is fully implemented downstream and nothing ever populates
  `peers`, so an empty peer column read as "no comparable peers found" — a claim
  about the market that was never evaluated (`a0159fe`).
- The Item 4.01 (auditor change) and Item 4.02 (**non-reliance / restatement**)
  8-K feeds were fetched, parsed and stored, and a repo-wide grep found zero
  consumers (`228f32f`).

### Evidence discarded, or discarded too eagerly

- `runForensics` aggregated gaps from all five sub-computations but notes from
  only one, dropping every model's house-rule caveat — the Altman variant
  rationale, the Hribar–Collins (2002) TATA construction, Sloan's lack of a
  canonical bright line (`dfc208c`).
- A single off-annual interval anywhere in the history nulled the **entire**
  scenario dispersion, suppressing the projections fan and the scenario targets
  built on it (`e6ac59b`).
- The EDGAR stub detector hard-failed a correctly extracted full-length MD&A
  (`e901304`), and the cross-reference rejection dropped genuine Item 1A headers
  that used the standard SEC preamble (`a005c66`).
- FIN-OTHER financials were penalised on 43% of quality weight for forensics the
  pipeline itself refuses to compute (`4dafde1`), and a `"fiftyTwoWeekRange"` /
  `"sma200"` suppression was inert because no signal carried the tag
  (`ef9b032`, `56de08d`).

---

## Commit-by-commit record

| Commit | Change |
| --- | --- |
| `31348d3` | Hoist model gaps through the ADR currency guard |
| `67be183` | Bound `display:none` to a declaration start |
| `4dafde1` | Stop penalising FIN-OTHER financials for withheld forensics |
| `dfc208c` | Surface model caveats; stop assuming zero retained earnings |
| `12a5978` | Correct ROIC invested capital; guard WACC currency |
| `e83d147` | Render monetary figures in their actual currency |
| `e901304` | Bound the stub phrase test so real sections are not discarded |
| `1453014` | Stop crediting a tax refund on projected operating losses |
| `ef9b032` | Require a full year before reporting a 52-week range |
| `ad48e3e` | Make the excess-return reverse solve invert its own model |
| `cb2be5e` | Deliver the SEC SIC to Altman variant selection |
| `356ed4d` | Collapse restated annual periods before building any series |
| `fa28a1e` | Rank EV multiples against a consistently defined EV history |
| `522d079` | Derive P/FFO and P/AFFO own-history for equity REITs |
| `56de08d` | Align scenario margin bounds; tag three unpoliced signals |
| `5537ca5` | Stop a false 5-year drawdown gap; disclose the 1-year one |
| `a0159fe` | Stop promising three capabilities the pipeline does not have |
| `81d6b98` | One basis per Beneish index; withhold Piotroski's financial garbage |
| `a005c66` | Stop rejecting genuine Item 1A headers as cross-references |
| `4a277c7` | `relationship-conflict` requires a conflict, not co-occurrence |
| `5f84a92` | Disclose short CAGR horizons; price foreign equity risk |
| `a73fadc` | Align peer columns by metric; label moat judgments |
| `a45449a` | Never default a denomination; stamp statements in their own |
| `e6ac59b` | Stop vetoing the whole dispersion over one irregular gap |
| `af5238e` | Validate the oldest quarter's duration in a TTM window |
| `af6ade4` | Detect a reporting currency that changes mid-history |
| `228f32f` | Read the 8-K feeds; make the exhibit boundary a fallback |
| `122867b` | Cover the exhibit boundary branches |
| `805e740` | Score financial moat on return on tangible common equity |

---

## Deliberate contract changes

Each of these overwrote a pinned expectation. The rationale is recorded in the
test file at the assertion, not only here.

| Contract | Change |
| --- | --- |
| Altman X2 (`tests/stageB.forensics.test.ts`) | Missing retained earnings suppresses the Z-score instead of scoring an assumed 0 |
| Stage C payload fingerprint | Moved four times: forensic notes (+1,580 bytes), ROIC cash basis, peers gap, CAGR horizon notes, ROTE |
| Audit fixture delta allowlist | 45 registered deltas across five changes |
| Bank route-applicable ceiling | 78.97 → 75.07 → 64.22; the no-shrinkage invariant is asserted and holds throughout |
| Reverse-solve round trip | Now exact against the forward model; a company priced at book solves to exactly CoE |
| Moat drivers for financials | ROIC pair → ROTE, at identical total weight |
| Markdown moat rendering | Flattened prose → the shared claim renderer, with label, as-of and citation |

---

## Corrections made to this session's own work

Recorded because an audit that reports only other people's errors is not
credible.

1. **`228f32f` was pushed red.** It added the named-boundary/all-caps-fallback
   split in `extractFromExhibit` without covering both arms, dropping
   `src/edgar/extract.ts` branch coverage to 74.61% against a 75% gate. The
   suite passed; the *gate* did not, and the exit code was not checked. Fixed in
   `122867b`.
2. **Three over-corrections were caught and backed out before landing.**
   Routing ROIC through the strict net-debt resolver suppressed it whenever
   short-term investments were merely unreported (five existing tests failed);
   rejecting TTM windows whose *prior* row was distant confused missing history
   with a short quarter (dropped a valid window from several fixtures); and
   suppressing `roicLevel` for banks before ROTE existed would have left the moat
   aspect with no evidence at all.
3. **One audit finding was implemented narrower than proposed.** Pass 2
   recommended suppressing ROIC entirely for financial routes. That was correct
   in principle and premature in sequence: it is now done, but only after
   `805e740` built the replacement measure.

---

## Task B3 — the unmerged branches

**Decision: `codex/financial-integrity` and `codex/provider-temporal-integrity`
are superseded for every area they overlap. Both branches are RETAINED, not
deleted. Neither should be merged.**

Evidence:

- `codex/financial-integrity` is ~110 commits ahead of the `8ff1671` merge base
  (`codex/provider-temporal-integrity` is contained within it).
- It contains **none** of the 38 defect fixes recorded above. Spot-checked:
  no SIC plumbing (`grep sicCode` → 0 hits), `impliedSteadyRoePct` still solved
  on a flat path, and `returns.ts:904` codifies the **wrong** ROIC cash
  convention as a documented house rule
  (`invested capital = totalDebt + totalStockholdersEquity − cashAndCashEquivalents`)
  — the precise defect `12a5978` corrects.
- Conflicts against `main` grew from 15 files at the start of this work to **26**,
  now including every core analytical file: `forensics.ts`, `grading.ts`,
  `growth.ts`, `projections.ts`, `returns.ts`, `scenarioTargets.ts`,
  `sectorRouting.ts`, `valuation.ts`, `payload.ts`, `compute.ts`.

Merging would resolve those conflicts in favour of a tree that predates 38
verified fixes. The branch's distinct themes — statement-currency provenance,
forensic evidence provenance, judgment-safety boundaries — are worth mining, but
only as **individually re-audited cherry-picks onto current `main`**, never as a
merge. That is a separate project with its own verification.

---

## Verification of this work, and what it revealed

The changes above were themselves audited, twice, because a fix written quickly
against complex financial code is not self-evidently correct.

| Pass | Scope | Agents | Findings | Confirmed |
| --- | --- | ---: | ---: | ---: |
| 1 | Analytical core, baseline `7d4966c` | 45 | 16 verified of 64 | 14 |
| 2 | The 48 Pass-1 did not verify, re-checked post-fix | 48 | 48 | 24 |
| 3 | **This session's own 31 commits** | 45 | 35 | **29** |
| 4 | **The Pass-3 remediation commits** | 27 | 20 | **15** |

Passes 3 and 4 are the important rows. **The work that fixed 38 defects
introduced 29 of its own, and the work that fixed those introduced 15 more.**
Every confirmed finding was a real defect with a reproduced wrong output, not a
style objection.

The defects the later passes found are the same shapes as the originals:

- **Fixes that were inert.** The domicile ERP lookup compared FMP's ISO-2
  profile code against its country NAMES, so it could never match and every
  foreign issuer kept the US premium — the exact defect it was written to close.
- **Fixes that over-corrected.** Routing FIN-OTHER issuers through the financial
  returns branch stripped their ROIC and gave them a ROTE that is uncomputable
  for a fee-based business, leaving moat scored on gross margin alone.
- **Fixes that opened the opposite hole.** Exempting a trial whenever its
  registered drug appeared anywhere in the text stopped the false positives and
  started missing real misattributions in a later sentence.
- **Fixes applied to one path of several.** The oldest-quarter gate reached
  `ttmIncome` but not `ttmCashFlow`; the gap hoist reached the multiples channel
  but not the DCF; the projection history was deduped but `dcfIncomeHistory` was
  not.
- **Guards that fired on the wrong condition.** The Z' substitution triggered on
  ANY null Altman score, so a transient missing market cap published the
  private-firm variant as a listed issuer's distress verdict.

### What this means for the reliability of this record

All 29 Pass-3 findings and the high-severity Pass-4 findings are fixed. But the
sequence 14 → 24 → 29 → 15 does not extrapolate to zero, and no claim is made
here that the tree is defect-free. What can be said precisely:

- `npm run verify` passes at every commit (one exception, recorded below).
- Every fix carries a regression test, and where practical the test was shown to
  FAIL against the unfixed code.
- Each pass found fewer defects in absolute terms than the surface it reviewed,
  and Pass 4's confirmations skew markedly lower in severity than Pass 1's.
- The remaining Pass-4 findings not yet actioned are listed under
  "What remains" below rather than quietly dropped.

An audit that reported convergence to zero after four passes would be the least
credible thing in this document.

### One finding was deliberately NOT actioned

Pass 4 argued that leveraged broker-dealers should receive ROTE rather than
ROIC, which directly contradicts Pass 3's finding that fee-based FIN-OTHER
issuers should keep ROIC. Both are correct for their sub-type, and FMP's data
does not reliably distinguish a leveraged broker-dealer from an asset manager.
The switch stays gated on base route — simple, defensible and stable — rather
than oscillating between two audits. This is a genuine modelling limit, recorded
here instead of being papered over.

## What remains

- **Bank-specific metrics beyond ROTE.** `nimApprox`, `efficiencyRatio` and
  `provisionForCreditLosses` remain in the bank route's `lead` list and are not
  computed. `lead` currently has **no consumers**, so this misleads no reader
  today, but the list is a standing promise. `netInterestIncome` and
  `interestIncome` are available on the FMP income statement, so NIM is
  derivable; CET1 is not available from FMP at all and would need the filing text.
- **Score-band backtesting.** Every band table, including the new
  `ROTE_LEVEL_BAND`, is a versioned house rule. None has been validated against
  realised outcomes.
- **Branch reconciliation** as described above.
- **Unactioned Pass-4 findings**, all medium or low: the CAGR over-long-span fix
  is disclosure-only (the numeric consumers still read a 4-year rate under a 3y
  label); `splitSentences` fragments at abbreviations and semicolons, so the
  entity check can both miss and misfire on prose containing "Phase 3." or a
  semicolon; the widened reverse-ROE bracket applies the payout ratio to loss
  years; the SGAI note asserts G&A + S&M even when the pair-resolved basis used
  only one component; conflicting vendor ERP rows are disclosed as "no vendor
  row"; and the quality aspect note still claims Altman/accruals/Beneish on
  routes that suppress all three.
- **Task A2** (branch protection for `CI / full`) is a repository-administration
  action outside the codebase.
