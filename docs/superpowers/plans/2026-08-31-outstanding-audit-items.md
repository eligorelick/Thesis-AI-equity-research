# Outstanding audit items — implementation plan

**Date:** 2026-08-31

**Status:** partially resolved. Tasks **B1** and **B3** are CLOSED — see
[`../audits/2026-08-31-analytical-integrity-verification.md`](../audits/2026-08-31-analytical-integrity-verification.md)
for the record. Tasks A1, A2 and B2 remain open; A1 is largely subsumed by that
verification document. The per-task checklists below are left as written so the
closure notes can be read against what was originally proposed.

**Scope:** the work that repository audit/plan documents still list as required
but which is genuinely not done, plus the repository-state items found while
verifying those documents. It deliberately does **not** re-open any confirmed
code defect: every finding in
[`../audits/2026-08-30-code-and-docs-audit.md`](../audits/2026-08-30-code-and-docs-audit.md)
is fixed and covered by a regression test, and `npm run verify` passes end to
end.

## How this list was derived

Each item below was checked against the working tree before being written down,
so none of them is inferred from prose alone:

| Claim | Check run | Result |
| --- | --- | --- |
| The 2026-08-09 verification document is missing | `ls docs/superpowers/audits/2026-08-09-provider-temporal-integrity-verification.md` | absent |
| Branch protection was never observed | `grep -n "branch protection" README.md docs/superpowers/audits/2026-08-07-remediation-verification.md` | README requires it; the audit records it as **NOT OBSERVED** |
| Task reports are unreachable from the repo | `find . -name "task-*-report.md"` | present only under `.worktrees/audit-remediation/.superpowers/…`, which is gitignored |
| This session's work is uncommitted | `git status --porcelain \| wc -l` | 80 entries |
| Branches diverge from `main` | `git rev-list --count main..<branch>` | `codex/financial-integrity` +113, `codex/provider-temporal-integrity` +24, `codex/audit-remediation` +0 |

---

## Part A — items an audit or plan document lists as required

### Task A1: Close out the 2026-08-09 provider/temporal workstream

**Problem.** `../plans/2026-08-09-provider-temporal-integrity.md` Task 8 requires
creating
`docs/superpowers/audits/2026-08-09-provider-temporal-integrity-verification.md`
with a finding-by-finding evidence matrix. That file does not exist. All eight
defects the plan targets **are** fixed, but by a different implementation than
the plan prescribes: there is no `fmpLiveExchangeProblem` and no `validateValue`
cache option, because FMP proves its endpoint contract inside the existing
`cachedFetch` loader (`FmpSchemaError`) and EDGAR JSON reuses the transport's
existing `validateBody` hook.

So the plan is simultaneously *achieved* (its defects are closed) and
*unexecuted* (its named artifacts and its verification step were never
produced). Leaving it in that state is what made the earlier documentation
misleading in the first place.

**Two honest options — this is a decision for the owner, not a default.**

- **A1-a (recommended): write the verification document as a supersession
  record.** State plainly that the workstream's defects were closed by a
  different implementation, map each of the eight defects to the code that now
  closes it and to its regression test, and record the verification actually
  run. Do **not** dress it up as execution of the plan's steps.
- **A1-b: retire the plan.** Replace the task bodies with a short note that the
  defects were closed elsewhere and keep the design document as the historical
  statement of intent.

A1-a preserves the audit trail the repository's conventions expect; A1-b is
cheaper and avoids a document describing steps nobody ran. Prefer A1-a.

- [ ] **Step 1: Choose A1-a or A1-b.** Do not proceed until this is decided —
      the two produce different documents.
- [ ] **Step 2 (A1-a): Re-run the evidence, do not reuse this session's output.**

```powershell
npx vitest run --config vitest.config.ts `
  tests/fred.bodyRead.test.ts tests/edgar.hiddenVariants.test.ts `
  tests/fmp.cacheAdmission.test.ts tests/edgar.jsonCacheAdmission.test.ts `
  tests/stageA.validate.test.ts tests/dataBundle.earnings.test.ts `
  tests/edgar.factObservationDate.test.ts tests/finra.fred.test.ts `
  tests/finnhub.sentimentContract.test.ts
npm run verify
```

- [ ] **Step 3 (A1-a): Write the matrix.** One row per defect: the defect as the
      design states it, the code that closes it, the regression test, and the
      command output above. Where the shipped approach diverges from the plan,
      say so in the row rather than in a footnote.
- [ ] **Step 4: Add the new file to `ALLOWED_MARKDOWN` in
      `tests/repository.release.test.ts`.** The release contract rejects any
      tracked Markdown outside that allowlist; adding a document without this
      step fails `npm test`.
- [ ] **Step 5: Update the status notes** in the 2026-08-09 plan and design to
      point at whichever document Step 1 chose.

**Verification:** `npm run verify` exits 0 and
`npx vitest run --config vitest.config.ts tests/repository.release.test.ts`
passes with the new file tracked.

---

### Task A2: Configure branch protection for `CI / full`

**Problem.** `README.md:205-206` states that repository administrators must
configure branch protection requiring the `CI / full` check, and
`../audits/2026-08-07-remediation-verification.md:594` records that branch
protection remains **NOT OBSERVED**. The M12 row of that audit carries the same
residual limitation. Nothing in the repository can satisfy this: a workflow
cannot grant itself protection.

Until it is configured, every gate this repository invests in — the eight
`npm run verify` steps, the coverage contracts, the release oracle — can be
bypassed by a direct push to `main`.

- [ ] **Step 1: Confirm the exact check name.** The job id is `full` in
      `.github/workflows/ci.yml`, which GitHub surfaces as `CI / full`. Confirm
      the rendered name on a real run before configuring the rule against it, so
      the branch-protection rule does not silently match nothing.
- [ ] **Step 2: Configure the rule** on `main`: require status checks to pass,
      select `CI / full`, and require branches to be up to date before merging.
- [ ] **Step 3: Record the observation.** Add a dated line to the 2026-08-07
      verification audit replacing **NOT OBSERVED** with what was actually seen
      (who configured it, when, and the rule as displayed). Do not mark it
      observed on the strength of having *requested* it.

**Verification:** a pull request with a deliberately failing test cannot be
merged. This is the only check that proves the rule is live; the audit should
record the result of actually trying it.

---

## Part B — repository-state items found while verifying the documents

These are not listed in any audit. They are recorded here because they affect
whether the audited state is the state anyone else will see.

### Task B1: Land the current working tree — **CLOSED 2026-08-31**

> **Resolution.** The working tree was landed, but NOT as this task proposed.
> It had already been committed as a single 81-file commit (`7d4966c`,
> "cleaning") and pushed to `origin/main` before the work below could be done,
> so Steps 1–3 could not be applied to it: a pushed commit cannot be split
> retroactively, and its message cannot carry the behaviour-change callouts.
>
> What was done instead: the change set was re-derived from
> `git show 7d4966c` and reviewed as code (Step 1's intent), and every
> subsequent change landed in small reviewable commits with the behaviour
> changes stated in the message (Steps 2–3's intent). `npm run verify` was run
> on the committed tree at every commit (Step 4).
>
> One of the three behaviour changes this task lists was also **stated
> incorrectly** in it: the accrual suppression does not move
> bank/insurer/mortgage-REIT grades downward. 78.97 → 75.07 is the
> route-applicable *ceiling*, and lowering it RAISES completeness and therefore
> REDUCES shrinkage toward 50 — good banks grade higher. See the verification
> document.

**Problem.** `git status --porcelain` reports 80 entries and `git log -1` is
still `8ff1671`. Every fix and every document correction described in the
2026-08-30 audit exists only in this working tree. A fresh clone gets none of
it, and the audit document describes code that is not in any commit.

- [ ] **Step 1: Re-read the diff before committing anything.**
      `git diff HEAD -- src/ scripts/` is ~33 files; it should be reviewed as
      code, not accepted because tests pass.
- [ ] **Step 2: Split into reviewable commits** along the seams the audit
      already uses — repository gates, then provider/temporal defects, then the
      remaining code defects, then documentation. A single 80-file commit is not
      reviewable, and several changes alter financial output.
- [ ] **Step 3: Call out the behaviour changes in the commit messages.** Three
      change what users see and deserve to be findable in `git log`:
      bank/insurer/mortgage-REIT composite grades move (accrual suppression),
      ADR bank fair values become suppressed rather than wrong, and the Markdown
      export's number formatting now matches the on-screen report.
- [ ] **Step 4: Run `npm run verify` on the committed tree**, not only on the
      working tree.

### Task B2: Make the task-report references resolvable

**Problem.** The 2026-08-07 verification audit cites `task-1-report.md` …
`task-32-report.md` as its owning evidence chain. Those files exist only at
`.worktrees/audit-remediation/.superpowers/sdd/2026-08-07-audit-remediation/`,
inside two separately gitignored directories, and `git log --all --diff-filter=A`
shows they were never committed. A reader of the repository cannot follow the
citation.

The audit already calls them "navigation aids, not substitutes for the fresh
commands", so the evidence does not depend on them — but a citation that cannot
be resolved should say where it points.

- [ ] **Step 1: Choose.** Either (a) add one sentence to the audit's "Authority
      and limitations" section giving the path and noting it is an untracked
      local artifact, or (b) commit the reports under `docs/superpowers/sdd/`.
      Option (b) requires extending `ALLOWED_MARKDOWN` for 32 files and should
      only be taken if the reports are genuinely wanted in the release.
      Option (a) is recommended.
- [ ] **Step 2: Apply the chosen change and re-run the release contract test.**

### Task B3: Decide the fate of the unmerged branches — **CLOSED 2026-08-31**

> **Decision: both `codex/*` branches are SUPERSEDED and RETAINED. Neither is
> to be merged; neither is deleted.**
>
> Step 2's concern — "a merge could silently revert a repaired invariant" — is
> exactly what the evidence shows. `codex/financial-integrity` contains NONE of
> the 38 defect fixes since verified on `main`, and `returns.ts:904` there
> codifies the WRONG ROIC cash convention as a documented house rule. Conflicts
> against `main` have grown from 15 files to 26 and now cover every core
> analytical file.
>
> Its distinct themes (statement-currency provenance, forensic evidence
> provenance, judgment-safety boundaries) are worth mining as individually
> re-audited cherry-picks onto current `main` — never as a merge. Full evidence
> in the verification document.
>
> Step 4 is done, and extended: the fully-merged `codex/audit-remediation` and
> `fix/audit-review-corrections` branches are deleted (both contained in `main`)
> and all three `.worktrees/` checkouts removed. The two superseded `codex/*`
> branch refs are retained, so no commit is unreachable.

**Problem.** `codex/financial-integrity` is 113 commits ahead of `main` and
`codex/provider-temporal-integrity` is 24 ahead; both have `main` as an
ancestor. `codex/audit-remediation` is fully merged (0 ahead) and its worktree
is now dead weight.

The provider/temporal branch is no longer needed to close the eight defects —
they are fixed on `main` by a different implementation — but it has never been
read, and `codex/financial-integrity` (a fourth workstream, "financial
integrity") has never been evaluated at all. Neither should be merged blind, and
neither should be deleted without being read.

- [ ] **Step 1: Review `codex/financial-integrity`'s own design/plan documents**
      to establish what it claims to fix, before reading its diff.
- [ ] **Step 2: Check for overlap with the fixes already on `main`** —
      especially valuation, grading and provider admission, where this session
      changed behaviour. A merge could silently revert a repaired invariant.
- [ ] **Step 3: Decide per branch:** merge, cherry-pick specific commits, or
      close. Record the decision and the reason.
- [ ] **Step 4: Remove the `codex/audit-remediation` worktree** once its branch
      is confirmed merged (`git worktree remove .worktrees/audit-remediation`).
      Note that ESLint's ignore list was widened to cover `.worktrees/**`, so a
      stale worktree no longer breaks `npm run lint` — but it still costs disk
      and confuses `find`.

---

## What this plan deliberately does not include

- **Re-opening closed defects.** All 36 confirmed audit findings are fixed with
  regression tests; re-litigating them would be churn.
- **The bank accrual weighting.** Suppressing `accrualsRatio` on financial
  routes follows the route's own stated rationale, but it moves every bank,
  insurer and mortgage-REIT composite. If the owner disagrees with that
  modelling call, reverting it is a one-line change to
  `src/pipeline/stageB/sectorRouting.ts` plus the hand-derived weight in
  `tests/stageB.grading.test.ts` — but it is a modelling decision, not a defect,
  and it should be made deliberately rather than folded into this plan.
- **New feature work.** Nothing here adds capability; every item either closes a
  documented obligation or makes the repository's own state honest.
