# Claude models and AI usage

This page describes the checked-in implementation. The Claude registry in
[`config/models.json`](../config/models.json) is stamped **2026-10-03**; its
entries are the app's configured capabilities and cost assumptions, not a
guarantee of current provider availability, account access, or invoice prices.
See [Anthropic's pricing](https://platform.claude.com/docs/en/about-claude/pricing)
and [model documentation](https://platform.claude.com/docs/en/models/overview)
when reviewing that snapshot.

## Select the report connection first

**Settings → AI connections** chooses AI off, Claude API, ChatGPT, or Gemini.
Connecting an account does not generate a report. Save the desired report
connection after selecting its model and, for ChatGPT, effort and speed.

| Connection | Implementation | Cost recorded by Thesis |
| --- | --- | --- |
| AI off | Fetch, validate and calculate locally; save a data-only report | No inference charge |
| Claude API | `ANTHROPIC_API_KEY`; Anthropic Messages API | USD estimated from provider usage and the registry, or conservative presumed spend |
| ChatGPT | Browser OAuth; OpenAI Responses API through the connected account | `$0` API cost; reported input/output tokens and execution evidence |
| Gemini | Separately installed official Gemini CLI **0.36.x**, Google OAuth | `$0` API cost; observed models and CLI-reported token totals |

A subscription report's `$0` means Thesis records no API dollar charge. It does
not mean free or unlimited provider usage, and Thesis cannot read remaining
account allowance. Provider credit settings still apply. The app's USD caps
do not cap subscription tokens or provider credits. There is no automatic
switch to paid Claude API usage after a subscription connection fails.

Before a connection store exists, an existing installation with a Claude key
defaults to Claude; without a key it defaults to AI off. Once stored, the
connection selection is authoritative, including AI off. Creating the store
during account setup can therefore require explicitly selecting Claude again.
Claude's analysis model/effort settings are separate from this connection store.

The selection is captured when a job executes. Subscription account, model,
effort and speed form part of the partial-work fingerprint; incompatible saved
work cannot be reused. Changing Settings does not rewrite saved reports.

## Claude model and effort settings

The selector accepts `auto` and active registry IDs. Explicit IDs are validated
offline against the registry; an API request can still fail for lack of access.
Unknown IDs and unlisted dated or `-latest` aliases are rejected. A listed dated
snapshot can be retained when already selected, but is not offered as a new
Settings choice.

`auto` queries the account's Models API and follows the registry preference
order, beginning with `claude-opus-5-5`. The result is cached in memory for one
hour. A failed catalog lookup is disclosed; it does not establish that another
model is available. Without a key, resolution uses the first registry preference
without a network request, and inference remains unavailable.

These are representative **registry values**, in USD per million tokens:

| Registry model | Input | Output | Five-minute cache write | Cache read |
| --- | ---: | ---: | ---: | ---: |
| `claude-opus-5-5` | 4 | 20 | 5 | 0.20 |
| `claude-sonnet-5-5` | 2 | 10 | 2.50 | 0.20 |
| `claude-fable-5-1` | 10 | 50 | 12.50 | 0.25 |
| `claude-haiku-4-5` | 1 | 5 | 1.25 | 0.10 |

The registry also retains Fable 5, Opus 5, Opus 4.8 and Sonnet 5. This list
describes selectable implementation entries, not measured research-quality
rankings. The registry's judge floor is `claude-sonnet-5-5`: Haiku analyst
requests use Haiku, while synthesis is raised to that floor and disclosed.

Claude effort resolves in this order: database setting, `ANALYSIS_EFFORT`,
then `high`. Model resolves similarly: database setting, `ANALYSIS_MODEL`,
then `auto`. Saved choices continue to override environment changes until
changed in Settings or cleared by `npm run settings:reset -- --yes`.
Without `--yes`, that reset prints what it would remove. It preserves the cache
maintenance stamp and settings revision, and does not clear AI connections.

Supported effort choices are `low`, `medium`, `high`, `xhigh` and `max`.
The adapter sends effort only when the registry says the model supports it;
Haiku ignores the configured effort and reports the adjustment. Thinking
parameters follow each entry's request policy; the adapter does not send
sampling parameters or manual thinking budgets. Selecting a different model
does not silently reset effort.

## What a report runs

The paid research path runs a bull analyst, a bear analyst, and a judge that
synthesizes their cases. Financial calculations precede these requests.
Verification afterwards is deterministic citation/provenance tracing with
**no model call and no inference cost**; `VERIFY_MODEL` is ignored. Coverage
measures whether claims trace to admitted evidence, not whether sources or
financial conclusions are independently correct.

Claude analyst requests expose server-side web search, capped at **eight uses
per request**. The judge has no web search. Retries and paused-turn resumptions
are separate requests, so eight is not a whole-report cap. The supplied payload
and model-returned successful search-result URLs define the citation evidence;
Thesis does not browse arbitrary URLs written in model prose. See
[Privacy](PRIVACY.md#what-the-ai-provider-receives) for payload contents.

Analyst JSON uses Anthropic structured output. The judge's larger schema is
included in its prompt and validated locally, rather than sent as a strict
structured-output grammar. Invalid judge/report output can receive up to two
additional repair attempts; completed rejected requests still incur usage.
Entity-validation repairs can also add analyst work.

`THESIS_JUDGE_ORDER` defaults to `random`, deterministically seeded by job ID.
`bull-first` and `bear-first` fix the presentation order. `both` requests a
second judge assessment with the cases swapped, then reconciles the pair;
this can roughly double judge work before any repairs. Order and reconciliation
are disclosed in the report. Bull, bear and judge can share a model family;
their adversarial roles do not establish independent model judgments.

With Claude streaming, bull starts first and bear waits for its first stream
event, allowing the evidence prefix cache to become reusable. Requests may
then overlap. If bull fails before that event, bear is not launched; when a
side's terminal failure makes synthesis impossible, the other request is
aborted and its incurred or presumed spend is retained. Non-streaming and
subscription paths run the analysts sequentially.

AI off, missing authorization, unsupported model selection and some terminal
analysis failures produce disclosed data-only reports. A data-only result may
still contain charges from work already attempted. Cancellation does not undo
remote usage. A saved successful analyst checkpoint can support an explicit
retry if its evidence and execution fingerprint still match.

## Request ceilings, caching and retries

The analyst pass constant is **64,000 output tokens** and the judge constant is
**96,000**. For an effort-capable Claude model at `high`, `xhigh` or `max`, the
adapter raises `max_tokens` to that model's registry ceiling (currently 128,000
for the listed larger models). Reasoning consumes output allowance. This is a
maximum request setting, not an expected report length or cost. Truncated,
refused, repeatedly paused or incomplete responses are not accepted as complete
research output.

Claude requests mark a shared evidence prefix for five-minute caching. Cache
eligibility and hits are provider decisions, and differing request schemas can
invalidate reuse. Recorded cache read/write tokens determine charges using
each model's own registry rates; there is no universal cache-price ratio.
The adapter does not request one-hour caching, Batch, Claude Fast mode or a
region-specific pricing tier.

The Anthropic SDK's own retries are disabled. Thesis owns a bounded transport
loop of up to **six attempts**, including retryable rate/transport failures,
and up to **five `pause_turn` resumptions** within an execution. Retryable
rate-limit responses honor provider retry delays; enforced spend-limit errors
stop. Request timeout and effort-scaled stream-idle limits can abort stalled
work. These paths can create billable requests even when no report completes.

The two Fable registry entries configure an explicit server-side refusal
fallback to `claude-opus-4-8`. Other entries have no such fallback. Requests
with fallback exposure reserve for both models, and the ledger uses separate
per-attempt provider billing evidence when available. Missing search/fallback
billing evidence remains conservative presumed spend. This is distinct from
subscription adapters, which do not invoke Claude fallbacks.

## Spend controls and reconciliation

`THESIS_MAX_JOB_COST_USD` and `THESIS_MAX_ROLLING_COST_USD` are optional;
both are **uncapped by default**. `THESIS_ROLLING_COST_WINDOW_MINUTES` defaults
to **1,440**. Default concurrency is one active job and two active paid calls.
Limits use persisted costs plus live reservations across workers sharing the
database; they do not cover usage in other apps, other databases, market-data
subscriptions, provider credits, taxes or an independently changed price sheet.

`THESIS_RESERVATION_MODE=request` is the default. Every transport retry,
resumption and mirrored judge request must acquire its own reservation before
launch. `pass` retains the larger whole-pass bound covering retry/resumption
exposure. Bounds use conservative input/output ceilings, up to ten server-tool
sampling inputs per search-enabled model and configured fallback exposure.
These are implementation assumptions, not an invoice guarantee. A small cap
can refuse a request whose typical actual cost would have fit. Completed usage
remains recorded when later admission fails.

Settlements and validated pass output are stored as durable artifacts with
generation/attempt identity. An expired unsettled paid lease is counted at its
full reserved amount as **presumed spend**. A late settlement can replace that
presumption automatically. A ledger amount based on usage still uses local
registry prices; it is not a provider invoice.

For abandoned requests that never settle, run:

```sh
npm run costs:reconcile
npm run costs:reconcile -- --write
```

The command requires the separate `ANTHROPIC_ADMIN_KEY` when there are rows to
compare. It reads the organization's daily Cost API totals from the oldest
unreconciled presumption through tomorrow, following pagination (maximum 24
pages of 31 buckets). The first command reads remote totals but makes no
reconciliation writes; `--write` lowers qualifying presumed ledger rows.
Ordinary database opening can still perform schema/cache maintenance.
The comparison bounds presumed spend by bucket totals minus recorded
settlements; it cannot attribute an organization total to an exact request.
Other organization usage can prevent a reduction. Changes refresh job progress
costs but leave saved report cost figures as persisted. The corrected export
CLI can reconstruct an export's cost from the current job ledger.

Queued paid work normally resumes on server start. Set
`THESIS_RESUME_ON_START=0` before startup to hold it for explicit queue resume
in Settings. Updating registry or pricing files does not itself launch work;
starting the application with its normal resume setting can.

## Registry maintenance and validation limits

```sh
npm run models:refresh
npm run models:refresh -- --write
npm run docs:pricing
npm run docs:pricing -- --write
```

`models:refresh` reads Anthropic's Models API using `ANTHROPIC_API_KEY` and the
public pricing page without sending inference. Its default is a registry
dry run; `--write` updates known entries and the snapshot. New models, missing
prices, capability policy and lifecycle changes still require manual review.
`docs:pricing` prints the pricing section from local registry/request policy;
`--write` regenerates that README section. The documentation tests check its
consistency with the generator. Check
[deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations)
and account access before relying on retained entries.

Offline regression coverage and static request checks do not demonstrate live
model access, quota, current billing terms or research quality. No live paid
inference was run as part of this documentation audit.
