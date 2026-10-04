# Claude models and API usage

Verified against Anthropic's public documentation on **2026-10-03**. The
checked-in model registry supplies the selector, request capabilities, prices,
and spend reservations. A registry entry does not establish your key's access.

## Choosing a model and effort

For a new Claude configuration, start with **Opus 5.5 at medium**. Consider
**Sonnet 5.5** when lower cost and latency matter. **Fable 5.1** is a more
expensive option for demanding work that still needs improvement after
evaluating Opus at higher effort. These are Anthropic's starting recommendations,
not measured Thesis accuracy rankings. [Model selection guide](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model).

| Current model | API ID | Provider default effort | Input / output per million tokens |
| --- | --- | --- | --- |
| Opus 5.5 | `claude-opus-5-5` | medium | $4 / $20 |
| Sonnet 5.5 | `claude-sonnet-5-5` | high | $2 / $10 |
| Fable 5.1 | `claude-fable-5-1` | high | $10 / $50 |

All three have a 1M-token context and a regular 128,000-token output ceiling.
See the [Opus](https://platform.claude.com/docs/en/models/opus-5-5/overview),
[Sonnet](https://platform.claude.com/docs/en/models/sonnet-5-5/overview), and
[Fable](https://platform.claude.com/docs/en/models/fable-5-1/overview) model pages.

Thesis sends an **explicit effort**. Its existing default remains `high`, and
saved settings override environment defaults. Choosing Opus does not silently
reset effort to medium. Review both selectors when changing models. Reasoning
tokens are billed as output; increasing effort can increase cost and latency
without guaranteeing better results. [Effort guidance](https://platform.claude.com/docs/en/build-with-claude/effort).

`auto` now prefers Opus 5.5 among models available to the key. Explicit existing
selections remain valid while active. Haiku 4.5 remains the cheapest analyst
option; its judge is raised to Sonnet 5.5 and disclosed in the report. Older
active models remain selectable for comparison and reproducibility. Restricted
Mythos access is not presented as a generally available option.

## Costs and limits

Thesis uses standard global API pricing, including model-specific cache rates.
Opus 5.5 cache reads cost $0.20 per million tokens, five-minute writes $5;
Sonnet 5.5 reads cost $0.20 and writes $2.50. Cache prices are not inferred from
one universal ratio. [Pricing](https://platform.claude.com/docs/en/about-claude/pricing).

The app uses five-minute prefix caching. Its bull-before-bear launch sequence
lets the second analyst reuse the shared evidence prefix once available.
Both new models require at least 512 tokens for caching; actual cache hits are
reported, not guaranteed. [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

Claude Fast mode, Batch discounts, one-hour caching and US-only inference are
not enabled by this update. Their pricing differs from the app's standard
request path. The **Fast** switch under ChatGPT applies only to ChatGPT OAuth.
Claude API billing is separate from Claude chat subscriptions and ChatGPT plans.

Set job and rolling dollar caps before paid work if you need a spending limit.
Reservations bound possible requests; the README's example costs are estimates,
not promised report prices. A long output can still reach its token ceiling.
Account rate and spending limits vary; check your own Claude Console limits.
Temporary throttling can be retried after the provider's delay, while an enforced
spend cap requires restored account allowance. [API limits](https://platform.claude.com/docs/en/api/rate-limits).

## Compatibility and upkeep

The new models use adaptive reasoning. Thesis omits unsupported sampling and
manual thinking-budget settings, and uses its existing structured-output path.
It retains explicit, priced Fable fallback targets rather than opting into
unbounded automatic model routing. A fallback can involve multiple models;
its per-attempt usage must be kept separate from the final attempt's top-level
usage. [Fallback behavior and billing](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback).

When a server-side fallback is configured, Thesis reserves for both the
primary and fallback model, including up to ten sampling inputs per
search-enabled model, and labels charges as presumed when the
response lacks billing evidence. Interrupted search or fallback requests
retain their request bound until reconciliation. These conservative reserves
can require a much larger cap than a typical report's actual cost. Anthropic's
[server-tool loop limit](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons#pause_turn)
is the basis for this bound. Rate-limited retries honor
`Retry-After`; enforced monthly spend limits stop immediately. None of these
changes automatically starts or retries a stored report.

Each transport retry or paused-turn resumption needs its own admitted request
reservation. A cap refusal stops the next request and keeps completed usage
and costs recorded. Correcting presumed costs also refreshes the job's
progress snapshot; existing saved reports retain their persisted cost figures.

`npm run models:refresh` checks public model/pricing information without
inference; registry changes still need review. Regenerate the README's price
table with `npm run docs:pricing -- --write`. Check
[deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations)
before removing older entries. This update was checked statically and through
offline CI; live Claude report quality has not been evaluated here.
