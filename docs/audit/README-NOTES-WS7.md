# README notes — WS7 (the AI pipeline)

Facts the README must state after WS7 (decision D-20). WS7 does not edit
`README.md`; WS9 folds these in. Sentences below are written to be used close to
verbatim. Reconciliation rows addressed: R-05, R-06, R-40 (partly), V-01
(unaffected), and section C. R-57's "verify tolerance rules" bullet changes too.

## 1. Corrections to statements the README currently makes

**R-05 — "independent bull and bear analyses, then synthesis."** The
independence claim was only half true: the two analysts genuinely never saw each
other's output, but the judge always read BULL first and BEAR second, and nothing
bounded how long either case could be. Replace with:

> Two analysts build the bull and bear cases independently — neither sees the
> other's output, and the bear prompt forbids assuming a bull case exists. A
> third pass, the judge, then reads both and writes the report. Which case the
> judge reads first is drawn from the job id rather than fixed, so first position
> is not a standing advantage for one side, and the order actually used is
> printed in the report header. Both cases are held to the same 24,000-character
> cap and the judge is told both lengths, so a longer case cannot win on volume.
> Each analyst also scores its own side 1–5 against a stated rubric, and the
> judge is told it may discount a side that scored itself low or whose evidence
> does not support the score it claimed.

**R-06 — "verification without a model call."** Still true, and now does more
than count citations. Replace the second half with:

> The verification pass makes no model call. It measures citation coverage — can
> each figure be traced to the exact payload record or fetched URL it cites — and
> separately runs four consistency checks on the prose around those figures: a
> direction word ("rose", "fell") must match the sign of the change it is glued
> to, a period phrase that names a year must match the cited figure's period, a
> unit word ("%", "bps", "billion") must match the unit the payload registered,
> and a claim that names a person must cite a filing or a transcript rather than
> a web-search result. The report prints "checked" beside "cited" and never
> merges them: a figure can be perfectly cited by a sentence that contradicts it.

**R-57 — limitations, verify tolerance rules.** The fiscal-spelling tolerance
("FY2025" read as a 2025-12-31 period end) is unchanged and still applies, now to
the period check as well as the citation check. Add:

> Each check only evaluates the claim/figure pairs it can locate — it has to find
> the cited figure's value inside the sentence before it can judge the words
> around it. A low "checked" count therefore means little could be checked, not
> that everything passed, and the report shows the count rather than a bare rate.
> A bare quarter with no year ("in Q3") is not checked at all: without the
> issuer's fiscal calendar there is no way to decide which ISO period end it
> means.

## 2. New configuration row

`THESIS_JUDGE_ORDER` — add to the config table:

| Key | Default | What it does |
|---|---|---|
| `THESIS_JUDGE_ORDER` | `random` | Which order the judge reads the bull and bear cases in: `random` (drawn from the job id), `bull-first`, `bear-first`, or `both`. `both` runs the judge twice with the orders swapped and costs two judge passes per report. |

Prose to accompany it:

> `both` is the expensive setting. It runs the judge a second time with the two
> cases swapped and reconciles the pair: every A–F section grade and each
> scenario probability, compared to two decimals. The seeded-order pass is the
> report — the two runs are never averaged into a third the model never produced
> — and any field the mirrored run disagreed on is listed in the missing-data
> manifest as order-sensitive. Prose is not compared; two runs of a language
> model never write the same sentence, and demanding it would report a failure
> every time. Budget for roughly double the synthesis line of the cost breakdown.

## 3. New report metadata a reader will see

Add to whatever section describes the report header:

> The header carries a **judgement protocol** line: which case the judge read
> first and the seed that decided it, both case lengths against the shared cap
> and whether either was truncated, both analysts' self-assessed case strength,
> and — when it applies — that the judge ran on the same model family that wrote
> the two cases it graded. That last one is not a defect but it is not a second
> opinion either, and the report says so rather than letting a reader assume
> independence.

The appendix gains a **Deterministic checks** table beside the existing citation
coverage table, with a passed/checked count per check family.

## 4. Behavior worth one line in "Limitations"

> A case that exceeds the length cap is truncated before the judge sees it:
> trailing evidence, then catalysts, then risks, then drivers are dropped whole
> (never below one entry each, and the thesis is never emptied), and the
> missing-data manifest names what was removed. Truncation is disclosed, never
> silent — but a truncated case is still a case the judge read less of.

## 5. Not changed by WS7 (so the README must not claim it)

- The analyst repair attempt and the judge's two retries (R-40) are unchanged.
- `random` does not make the pipeline nondeterministic: the draw is seeded from
  the job id, so the same job always presents the same order, and a report
  regenerated as a new job may present the other one.
- Nothing about the order affects the deterministic Stage B numbers, which are
  computed before any model runs and injected after the judge pass.
