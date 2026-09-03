# Remediation report

What the 2026-09-02 audit asked for, what was built, and what was not. Every
claim here is checkable against a commit; where a criterion was not met the
reason is stated rather than the criterion quietly dropped.

Read alongside:

- [`README-RECONCILIATION.md`](README-RECONCILIATION.md) — the 60 README claims
  the work started from, each with file-and-line evidence and a verdict.
- [`DECISIONS.md`](DECISIONS.md) — D-01 to D-23, the options considered and why
  each was chosen.
- [`PROGRESS.md`](PROGRESS.md) — the state of the work as it ran.

## How the work was done

**Phase 0 established what the code does before trusting either the README or
the audit.** Sixty README claims were checked against the code. Forty were true,
eleven needed verification in code that the audit had not done, and seven
discrepancies turned up that the audit had missed, including a flat cache-read
multiplier applied to every model, a reference table of cache TTLs that nothing
read, and a Node 24 requirement justified by native type stripping that the
harness does not actually use.

**Nine workstreams.** Three that touch the money-and-safety layer ran in series
on `main` because they share the scheduler and the provider: the model registry,
presumed spend under failure, and per-request cost admission. Six independent
ones ran in parallel on isolated worktrees with declared file ownership: the
data layer, sector routing, valuation inputs, the AI pipeline, security and
privacy, and the documentation. Each branch merged only with the full gate
green.

**Every workstream was then reviewed by a reader with no history with it.** The
reviewer saw the diff, the acceptance criteria and a fixed checklist, and was
told to judge only what the diff showed. That step changed the outcome
materially: it found nine blockers across five workstreams, none of which the
implementing agent had noticed, and three of them were pinned as correct
behaviour by a test that agent had just written. The findings and their repairs
are recorded per workstream below.

**The gate** is `npm run verify`: dependency shape, typecheck, lint, the product
suite, the database CLI suite, both coverage contracts, a production build and
the security audit. The product suite is offline whatever `.env` contains, and
no paid or live provider call was made at any point in this work.

## Status by workstream

Each entry lists what the criteria asked for, whether it was met, and what the
independent review then found. A criterion counts as met only when a test proves
it on the path production takes.

### WS1 — the model registry (D-01 to D-06)

**Met.** Model ids, prices, context and output limits, effort support, thinking
rules, the web-search tool variant and the judge floor live in
`config/models.json`, validated by zod at import, and drive request shaping,
pricing, the allow-list and `auto`. No sampling parameter is ever sent; effort
goes only to models the registry says accept it; thinking is never disabled; and
`max_tokens` rises to the model's ceiling at effort high and above. A dated
snapshot id is rejected for every model but Haiku 4.5, naming the id to use
instead. `npm run models:refresh` diffs the registry against the published list
and prices without sending a model request.

The review found the disclosure half of D-02 unimplemented — a rejected model
had no execution-metadata adjustment, and the settings page showed a generic
label rather than the actionable message the code already produced — and four
values the registry should have owned still hard-coded in three places. Both
repaired.

### WS2 — spend under failure (D-07 to D-09)

**Met.** An expired unsettled reservation is recorded at its reserved maximum
rather than vanishing, and lowered only by evidence: a late settlement for the
same attempt, or `npm run costs:reconcile` against the Usage and Cost API. Four
lease-timing invariants are asserted at startup, so a process configured to lose
a healthy job mid-run refuses to start. Every paid pass streams behind an idle
guard that abandons a provider which accepts a request and then goes silent,
settling the usage it reported plus a presumed remainder.

The review found that remainder outside the reconciliation model entirely —
invisible to both halves of the arithmetic, so an Opus 5 stream that died after
a thousand output tokens left a permanent $3.17 row nothing could lower — and
D-07's disclosure clause unimplemented: nothing in the report or the manifest
mentioned presumed spend at all. Both repaired.

### WS3 — per-request cost admission (D-10)

**Met, after two blockers.** Each provider request is admitted against the spend
caps on its own, the SDK's own retries are off so the ladder is ours, and the
pass worst case is reported rather than reserved — which is what turns a job cap
from runaway protection into a usable budget.

The review found two failures the suite could not see, because no test drove the
real runner-side admission. Per-request cost rows could not be paired with their
pass artifact, so every paid pass was marked corrupt on resume and a crash or
retry re-ran the entire run — $2.34 on Opus 5, each time, bounded only by a cap
that is unset by default. And a pass lease occupied a paid slot alongside its
own first request, so `THESIS_MAX_ACTIVE_LLM_CALLS=1` — the value `.env.example`
recommends as conservative — never sent a request at all, while the default of 2
serialised the analyst passes into a missed prompt cache. Both repaired, each
with a test that drives the real scheduler rather than a stand-in.

### WS4 — the data layer (D-11 to D-15)

**Eleven of twelve met.** Reserved fixture symbols reach no provider whatever
keys are set; EDGAR backfills history an FMP plan truncates, with per-period
provenance and no period mixing sources; tag synonyms carry a taxonomy year and
a review date; derived operating income subtracts non-operating items and is
never derived for a bank; multi-class cover shares are summed with the breakdown
disclosed; public float carries its own measurement date; restatements are
flagged against the value they replaced; successor registrants reach their
predecessor's history through a co-registrant filer list and refuse to guess
between co-registrants; EDGAR stays inside its fair-access limits and backs off on 403
and 429 alike; and beta reports its basis, standard error, R-squared and Blume
adjustment.

**Deferred: insider trades (SEC Form 4) keylessly.** Form 4s are filed by the
reporting person rather than the issuer, so a keyless implementation needs a
separate per-insider query and a document parse per filing — dozens of requests
per report against a five-per-second budget, a new parser and a fixture corpus.
A partial set would read as an insider-selling signal rather than a gap, which
is worse than none. The member stays a disclosed gap and the README says so.

The review found short-term debt dropping the current maturities of long-term
debt whenever a filer also tagged short-term borrowings, understating
Caterpillar's total debt by $7.1B, with the workstream's own new test pinning
the wrong figure as correct. It also found a multi-class share sum applied to
the spot count but not the series that feeds market-cap history, and — predating
all of this work — the declared SEC contact identity travelling in Yahoo's
User-Agent, where nobody asked for it and no document said it went.

**The successor lookup was reading the wrong filing.** With the owner's
approval the real SEC payloads for CIK 2115436 were recorded on 2026-09-03, and
they disprove the mechanism the criterion names. ExxonMobil Holdings' own
8-K12B (0001193125-26-291990) carries a single FILER block — itself. The
co-registration is on the filings the two entities made jointly afterwards: the
10-Q 0000034088-26-000093 and the POSASR 0001193125-26-292453 each name both
CIKs. So the feature resolved nothing for the issuer it was built for, and no
test caught it because the only fixture was hand-built in the shape the code
expected — the failure mode the brief warns about, arriving through the
criterion itself rather than around it.

The 8-K12B is now the trigger only. `predecessorCandidates` ranks the
submission headers worth reading — the 8-K12B, then periodic reports newest
first, then filings riding on another registrant's registration statement, with
employee-plan amendments last — and the scan reads them in order, capped at four
requests, until one names exactly one other party that has filed history of its
own. On the recorded data the answer arrives at the second request. Four
recorded payloads are committed; the hand-built fixture stays, now covering the
branch where an 8-K12B does co-register, and its header says so. The
end-to-end scan is driven by `tests/dataBundle.successor.test.ts`, which fails
against the old single-read behaviour.

One review finding reached past the workstream's file boundary and was closed
afterwards on the Stage B baseline: `ebit` was filled from pre-tax income plus
interest expense and fell back to operating income only when that sum was
unavailable, so the raw sum won whenever both operands existed. That bypassed
the non-operating adjustment, the bank guard and the containment withholding all
at once — a figure the derivation had just refused was published under the one
name valuation reads. EBIT now follows operating income and nothing else, and is
withheld with its reason where operating income could not be derived.

### WS5 — sector routing and financial companies (D-16, D-17)

**Met, after two blockers.** Routing reads XBRL tag evidence alongside the SIC
code and the industry label, and evidence that contradicts the declared
classification is disclosed rather than acted on; SIC 6798 alone never decides
equity versus mortgage REIT. Financial routes withhold the FCFF discounted cash
flow, the reverse DCF, EV/EBITDA and ROIC-minus-WACC, each with a reason
reaching the notes and the manifest, and value the company on excess returns to
equity instead. Route metrics are computed where the tags allow the definition
and withheld under their own name otherwise. Piotroski reports a financial
variant scored over its own denominator, and Altman Z, Beneish M and the accrual
ratios stay withheld because every estimation sample behind them excluded
financial institutions.

The review found the evidence router treating a corporate bond portfolio or
vendor financing as proof of a mortgage REIT — which would have routed Apple or
Deere to that map, suppressing the discounted cash flow and leading the report
with book value per share — and a justified price-to-tangible-book multiple that
was a Gordon perpetuity presented as agreeing with a model that has none,
publishing 7.45x where the pipeline's own fair value implied 1.2x. Both
repaired, along with four other numbers that could be wrong rather than absent.

### WS6 — valuation inputs and disclosure (D-18, D-19)

**Met, after two blockers.** The growth anchor is the median of the available
methods with its range shown and every unavailable method named; the terminal
rule is labelled a house convention wherever it prints, and each fiscal year is
compared to its own cost of capital where a risk-free observation exists; WACC
names every input with its source and date; free cash flow is reported after
stock-based compensation with the before figure beside it; the enterprise-value
bridge is explicit with a disclosed off-by-default lease option; an own-history
figure is a rank among N quarters with N shown; and the disclaimer names what
the report actually emits.

The review found enterprise value removing the entire lease liability when EBIT
and EBITDA are before finance-lease cost — so the finance slice, which is debt
in both frames, was being netted out — and an own-history rank comparing a
lease-excluded current multiple against a lease-inclusive history, the exact
invariant that file documents at the top of the function. Both repaired, along
with a stock-compensation penalty being charged twice to the balance-sheet
grade.

### WS7 — the AI pipeline (D-20)

**Met.** The judge no longer always reads the bull case first: the order is
drawn from the job id, so a run reproduces exactly while first position stops
being a standing advantage, and the order is recorded in metadata, in a sentence
a reader sees, and in the manifest. `both` runs the judge twice with the orders
swapped and reconciles the section grades and scenario probabilities, keeping
the seeded pass rather than averaging, and disclosing each field the mirrored
run disagreed on. Both cases share one length cap, the judge is told both
lengths, and truncation is disclosed. Each analyst scores its own case against a
stated rubric. Verification gained deterministic direction, period and unit
checks reported separately from citation coverage, and claims naming a person
are restricted to filings, transcripts and payload figures — the leadership
prompt previously pointed the model at web search for exactly those claims.

The review found the shared-model-family disclosure dead on the production path
(computed from an empty list, so it could never fire), completeness metadata
invalidated by the act of adding a check disclosure, a thrown mirrored judge
attempt discarding an already-paid primary, and three classes of false positive
in the new checks — including any correct sentence about a lower-is-better
metric. All of it is repaired and merged (`f94d9a4`); the merge commit lists
the fixes. Three of them are worth naming here: the family disclosure is now
stamped from the runner's own execution list at a single choke point covering
the primary path, the unverified fallback and durable verify recovery;
`dataCompleteness` is recomputed at both sites that edit the manifest, which
also closes a pre-existing defect where any run with presumed spend carried
inconsistent completeness metadata; and a thrown mirrored attempt is routed to
the existing "reconciliation not performed" path, so the primary stands and
settles once at what it cost.

`THESIS_JUDGE_ORDER=both` also sized its spend for one order. The pass worst
case and the pass reservation now take a per-pass judge request count, and
`.env.example` says `both` assumes the default request mode. The generated
README cost table is unchanged: it prints the analyst pass worst case, not the
judge's.

### WS8 — security, privacy and compliance (D-21)

**Met.** State-changing routes reject cross-site requests, and a request with
neither Fetch Metadata nor a matching Origin needs a token minted at startup.
`THESIS_RESUME_ON_START=0` holds queued paid work until an explicit resume.
`npm run settings:reset` hands precedence back to the environment and refuses to
act without `--yes`. `docs/DATA-RIGHTS.md` states each provider's terms and
`docs/PRIVACY.md` states exactly what leaves the machine, where the database
lives and how to delete it.

The review found a test that spawned a package manager inside `npm test`, which
escapes the in-process offline guard and can reach the npm registry, and a reset
that deleted the monotonic counter behind the settings compare-and-swap, letting
a stale browser tab's conditional write be accepted over a newer value. Both
repaired, along with comments and documents that described the token as local
access control when it is a browser-CSRF boundary.

### WS9 — the documentation

**Met.** The README is 250 lines and three of its sections are generated: the
configuration table from `.env.example`, the commands table from `package.json`,
the cost table from the model registry and the reservation code.
`tests/docs.lint.test.ts` fails if the checked-in file drifts from any of them,
if a link points at a missing file, if it grows past 250 lines, or if a retired
rule reappears in the prose. `docs/METHODOLOGY.md` is one document rather than
two. `CHANGELOG.md` leads with what a reader may have to act on. `engines.node`
is 22.18.0.

## What was deferred, and why

1. **Insider trades keylessly (WS4, criterion k).** The cost is dozens of extra
   requests per report and a new parser, and a partial answer would read as a
   signal rather than a gap. Disclosed as a gap instead.
2. **Measured cost figures.** The README's cost table is a calculation from the
   registry's published rates, labelled as one, beside the single measured run
   of 2026-09-01. Measuring the rest needs a live paid run.
3. **A recorded fixture for the successor registrant.** CIK 2115436's real SEC
   payloads need a live EDGAR fetch; the fixture is hand-built from the
   documented response shape and marked synthetic.

## Follow-ups outside the criteria

These were found during the work and deliberately not acted on, because each is
a change the criteria did not ask for:

- A quarterly figure derived by subtracting year-to-date values can still be
  negative for a filer whose restated comparative moves the wrong way; WS4's
  repair guards revenue specifically.
- `THESIS_RESERVATION_MODE=pass`, kept for one release as a fallback, has no
  end-to-end test asserting the pass-level reservation still holds. It should
  get one before the fallback is dropped.
- Equity-REIT and general routes list lead metric ids that name no emitted
  metric, the same defect WS5's review corrected on the bank route.
- Nothing renders presumed spend beside the cost total in the report view; the
  disclosure reaches a reader through the manifest entry only.
- The emitted JSON schema's "no unions" invariant was passing by construction in
  one place and by luck in another until WS7 found it. Its neighbours deserve
  the same check.
- `PERIOD_PATTERNS`'s `FY` pattern still allows an optional century, so "FY 15%"
  matches "FY 15" the same way "Q1 15%" did before the WS7 fix. The shape does
  not occur in real prose, but it is the same defect.
- `src/pipeline/jobRunner.ts` now imports `stageC/judgeProtocol` at build time,
  which transitively pulls `stageC/payload.ts` for `fnv1a32`. Moving that hash
  into a leaf module would keep the runner's dependency surface as narrow as its
  own JSDoc note claims.
- A judge protocol reconstructed on a durable resume re-derives the order from
  the resuming process's `THESIS_JUDGE_ORDER`. An operator who changes the
  setting between the run and the resume gets a reconstructed order that may not
  be the one the judge read. The disclosure names the setting it used, so it is
  not silent; persisting the protocol on the synthesize artifact would remove
  the ambiguity, at the cost of an envelope-version bump.
- `tests/jobRunner.test.ts` counts `getConfig` calls to assert that no provider
  or model boundary is crossed. The count has been incremented three times for
  unrelated reasons; the surrounding assertions pin the property directly and
  the counter should go.

## Open questions for the owner

1. Measured end-to-end cost figures require a live paid run. Until one is
   authorised the cost table is a calculation from the registry's published
   rates, labelled as one, beside the single measured run of 2026-09-01.
2. Recording the real SEC payloads for the successor registrant (CIK 2115436)
   requires a live EDGAR fetch. Until then that fixture is hand-built from the
   documented response shape and marked synthetic.
3. `auto` still prefers Opus 5 and the default effort is still `high`. Changing
   either is an owner decision, not a remediation.
