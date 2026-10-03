# Thesis

Thesis is a local-first equity research application. Enter a ticker to validate
market data, compute financial metrics and optionally run grounded AI analysis.
Saved reports give every number a source path and an as-of date.

> **Informational only — not investment advice.** Grades and price targets are
> model outputs from disclosed data and assumptions, not human recommendations.
> Market data and AI output can be delayed, incomplete, or wrong.

## What it does

- Fetches typed data from Financial Modeling Prep, SEC EDGAR, Yahoo Finance,
  FINRA, FRED and Finnhub, and validates freshness, balance-sheet identities
  and selected vendor figures against EDGAR XBRL.
- Computes growth, returns, capital structure, valuation, scenarios,
  technicals, grades and forensic indicators in deterministic TypeScript, on a
  sector route drawn from the industry label and SIC code and checked against
  what the filer actually tags — tags decide only where those are silent.
- Optionally runs separate bull and bear analyses and a judge
  pass, verifies every cited number without another model call, and turns
  missing inputs into disclosed gaps rather than fabricated values.

## Quick start

Node.js 22.18+ and npm are required; Node 24 is the CI-verified configuration.

```powershell
git clone https://github.com/eligorelick/Thesis-AI-equity-research.git
cd Thesis-AI-equity-research
npm ci
Copy-Item .env.example .env
npm run dev
```

On macOS/Linux, use `cp .env.example .env`. Production: `npm run build`, then `npm start`.
Keep `.env*` private; only the placeholder `.env.example` belongs in Git.

Open <http://127.0.0.1:3000>; development and production both bind to
`127.0.0.1`. Every provider key is optional: with no `FMP_API_KEY`, set
`EDGAR_CONTACT` to a truthful "Name email" identity and real US-listed tickers
come from SEC EDGAR and Yahoo. With no key at all, `/report/sample` renders a
fictional report, and `/company/DEMO` and `/company/DBNK` are reserved strings
served from `fixtures/fmp` whatever keys are set. None of the three reaches a
provider: the two company slices say so in the manifest and the sample is
labelled synthetic throughout; any other symbol is a live request.

## AI connections

In **Settings → AI connections**, connect an account, choose a model and save.
ChatGPT uses official plan OAuth; Gemini uses the separately installed official
CLI **0.36.x**. Claude API remains optional and separately billed. Sign-in runs
no inference, and failed connections never switch to paid API usage.
ChatGPT opens normal Chrome; make Chrome the default browser for Gemini.
Only one running Thesis server per OS user can use these account connections.
Plan allowances and provider credit settings apply; API dollar caps do not
measure subscription usage. Live OAuth sign-in/inference remains unverified.
See [connection setup, privacy and limits](docs/PRIVACY.md#ai-connection-setup).

## Configuration

<!-- BEGIN GENERATED: config -->

Every key is optional. This table is generated from `.env.example`, which
carries the long form of each one, so the two cannot drift apart.

| Key | Default | What it does |
| --- | --- | --- |
| `FMP_API_KEY` | unset | Financial Modeling Prep key — any plan. |
| `ANTHROPIC_API_KEY` | unset | Anthropic — enables the bull/bear/judge LLM passes + web search. |
| `FRED_API_KEY` | unset | FRED — free key from https://fred.stlouisfed.org/docs/api/api_key.html The macro dashboard. |
| `FINNHUB_API_KEY` | unset | Finnhub — free-tier key. |
| `EDGAR_CONTACT` | unset | SEC EDGAR is keyless but REQUIRES a declared contact in the User-Agent of every request. |
| `THESIS_STATEMENT_SOURCE` | `auto` | Where the income statement, balance sheet and cash flow history comes from. |
| `ANALYSIS_MODEL` | `auto` | Model used for the analysis pipeline (bull/bear/judge passes). |
| `ANALYSIS_EFFORT` | `high` | Reasoning effort for the LLM passes: low \| medium \| high \| xhigh \| max. |
| `THESIS_JUDGE_ORDER` | `random` | Which order the judge/synthesis pass reads the two analyst cases in. |
| `ANTHROPIC_ADMIN_KEY` | unset | Optional Admin API key (distinct from ANTHROPIC_API_KEY). |
| `THESIS_MAX_ACTIVE_JOBS` | `1` | Cross-process concurrency is enforced in SQLite. |
| `THESIS_MAX_ACTIVE_LLM_CALLS` | `2` | Cross-process concurrency is enforced in SQLite. |
| `THESIS_MAX_JOB_COST_USD` | unset | Optional exact USD caps. |
| `THESIS_MAX_ROLLING_COST_USD` | unset | Optional exact USD caps. |
| `THESIS_RESERVATION_MODE` | `request` | How paid work is admitted against these caps: one reservation per provider request, or one per pass. |
| `THESIS_STREAM_IDLE_SECONDS` | `300` | Base gap with no stream event after which a paid request is abandoned, scaled by analysis effort. |
| `THESIS_ROLLING_COST_WINDOW_MINUTES` | `1440` | Maximum supported window: 52,560,000 minutes (100 years). |
| `THESIS_PAID_PASS_LEASE_SECONDS` | `900` | Anthropic requests time out after 600 seconds waiting for response headers. |
| `THESIS_JOB_LEASE_SECONDS` | `900` | Anthropic requests time out after 600 seconds waiting for response headers. |
| `THESIS_RESUME_ON_START` | `1` | Startup hold. |
| `THESIS_EV_INCLUDE_LEASES` | `1` (opt in) | Keep the OPERATING-lease liability in enterprise value and in the DCF equity bridge. |
| `THESIS_ALLOWED_HOST` | unset | `npm run dev` and `npm start` bind to 127.0.0.1 by default. |
| `THESIS_TOKEN_FILE` | unset (opt in) | Mutating routes (report, retry, cancel, settings, watchlist, resume) reject a request that carries neither browser Fetch Metadata nor a matching Origin. |
| `THESIS_DB_PATH` | unset (opt in) | The SQLite DB defaults to the OS app-data directory (so its WAL/SHM writes do not trigger Next.js dev-server rebuilds from inside the repo). |
| `THESIS_DATA_DIR` | unset (opt in) | The SQLite DB defaults to the OS app-data directory (so its WAL/SHM writes do not trigger Next.js dev-server rebuilds from inside the repo). |
| `THESIS_IMPORT_LEGACY_DB` | `1` (opt in) | One-time migration only. |
| `NEXT_TELEMETRY_DISABLED` | `1` | The Next.js CLI behind `npm run dev` / `npm run build` posts anonymous usage events to telemetry.nextjs.org unless this is set. |

<!-- END GENERATED: config -->

Stored settings beat environment variables, which beat defaults; reset the
stored ones with `npm run settings:reset -- --yes`.

## Where the numbers come from

With an FMP key of any plan, FMP is the primary source. Lower tiers cap the
`limit` parameter at five periods and restrict some endpoints and symbols;
Thesis reads the cap from FMP's own rejection, retries within it, and fills the
rest from keyless sources. Five fiscal years still support the growth, returns,
forensic, DCF and scoring modules; the own-history multiple rank needs eight
quarters and waits for them.

With no key at all, set `EDGAR_CONTACT` and real US filers still produce a full
report: statements, share counts and public float from SEC EDGAR XBRL company
facts, prices from Yahoo's unofficial chart endpoint, and the profile and
enterprise values derived from the two. `THESIS_STATEMENT_SOURCE` chooses
between the vendor and EDGAR; where both serve, no period mixes sources and the
manifest names how many each served.

Where a filer uses an extension tag the field is `null` rather than a guess,
and each stand-in is named in the manifest with the periods it served. Analyst
estimates, price targets, peers, insider trades (SEC Form 4), institutional
ownership, news, transcripts, executive compensation and segment revenue have
no keyless source, as do IFRS filers' statements, and all stay disclosed gaps.
See [License and data rights](docs/DATA-RIGHTS.md) for what each allows.
## What the numbers mean

[Methodology](docs/METHODOLOGY.md) defines the conventions and sources. Sector
routing weighs XBRL evidence, SIC and industry labels, disclosing contradictions.
Banks, insurers and mortgage REITs use excess returns to equity instead of
inapplicable industrial-company valuation and forensic models. Growth shows
supported methods and their range; free cash flow shows before/after stock-based
compensation. Historical multiple ranks show sample size. Project-specific
choices are labelled house conventions beside the affected figures.

[`docs/RESEARCH.md`](docs/RESEARCH.md) documents the forensic scores' papers,
coefficients, estimation populations and limits; the source cites it by section.

With AI off or unavailable, reports retain deterministic results and disclose
that no analyst pass ran; the narrative sections remain empty.
## AI analysis

Two analysts build the bull and bear cases independently: neither sees the
other's output, and the bear prompt forbids assuming a bull case exists. A
judge pass then reads both and writes the report. Which case it reads first is
drawn from the job id rather than fixed, so first position is not a standing
advantage, and the order is printed in the report header. Both cases share one
character cap and the judge is told both lengths, so a longer case cannot win
on volume; each analyst scores its own side 1-5 against a stated rubric, and
the judge may discount a side that scored itself low.
`THESIS_JUDGE_ORDER=both` runs the judge twice with the cases swapped and
reconciles every grade and probability, for two judge passes.

The verification pass makes no model call. It measures citation coverage — can
each figure be traced to the record it cites — and separately checks the prose
around figures it can locate: a direction word must match the sign of its
change, a period naming a year must match the cited year, a unit word must fit
the registered unit, and a claim naming a person must rest on a filing, a
transcript, a registry figure or the payload's own executive rows; any other
source, or none, fails it. Checked is printed beside cited, never merged into it.

For the Claude API, `ANALYSIS_MODEL` takes `auto` or a model from `config/models.json`, which is
also where prices and limits come from; anything else is rejected, because the
scheduler cannot prove a spend bound for it, and the run degrades to a
data-only report. Choosing Haiku does not make the whole run Haiku — the judge
pass is raised to Sonnet 5, disclosed as a `model-floor` adjustment.

<!-- BEGIN GENERATED: pricing -->

Registry snapshot 2026-09-02, generated by `npm run docs:pricing`
from `config/models.json` and the reservation code. Each request is admitted
against the spend caps before it is sent, bounded by the model's full context
window priced as a five-minute cache write, its maximum output, and eight web
searches at $0.01 (the judge never searches).

| Analysis model | One analyst request | One synthesize request | Analyst pass worst case | Analyst output ceiling | Estimated run |
| --- | ---: | ---: | ---: | ---: | ---: |
| Claude Fable 5.1 | $18.98 | $18.90 | $683.28 | $3.20 → $6.40 | $4.46 |
| Claude Fable 5 | $18.98 | $18.90 | $683.28 | $3.20 → $6.40 | $4.60 |
| Claude Opus 5 | $9.53 | $9.45 | $343.08 | $1.60 → $3.20 | $2.34 |
| Claude Opus 4.8 | $9.53 | $9.45 | $343.08 | $1.60 → $3.20 | $2.34 |
| Claude Sonnet 5 | $3.86 | $3.78 | $138.96 | $0.64 → $1.28 | $0.98 |
| Claude Haiku 4.5 | $0.65 | $3.78 | $23.40 | $0.32 | $0.69 |

The worst case is every request one pass could make (36: six transport attempts,
each able to pause and resume five times); in the default request mode it is
reported, not reserved, so a job cap need only cover the requests in flight, while
`THESIS_RESERVATION_MODE=pass` reserves it whole. Neither reservation column varies
with effort — both bound a request at the model's full context and output ceiling.

The output ceiling is the one part of per-effort cost that is derivable, and
thinking bills as output: below `high` a pass is capped at its own constant
(analyst 64K, judge 96K), at `high` and above at the model's registry ceiling — so
an abandoned Fable 5.1 request at effort `max` settles at $6.40 of presumed output.

The estimated run is a calculation, not a measurement: the fixture shape at effort
`high` and registry rates, Haiku's synthesize figures those of Sonnet 5
because that pass is raised to it. It does NOT scale with effort — nothing is
measured at the other levels — so read it as a floor at `xhigh` and `max`, where the
same passes think longer inside the same ceiling. Measured on the maintainer's own
runs (not reproducible from the repository): Haiku $1.43; Opus 5 on MSFT $5.31 over
six requests, each pass schema-rejected once and repaired, so its winning requests were $2.66.

<!-- END GENERATED: pricing -->

## Running it safely

Thesis sends nothing to Thesis: no telemetry, no analytics, no update check;
its own outbound traffic goes only to the providers you configure. The Next.js
CLI has separate anonymous telemetry, off when the shipped
`NEXT_TELEMETRY_DISABLED=1` is in your `.env` (or `npx next telemetry disable`).
[Privacy and safety](docs/PRIVACY.md) names what each receives, where the local
database lives, and how to delete it.

The application is single-user and has no authentication; keep it on loopback
unless you add a security layer of your own. Mutating routes reject a request
carrying neither browser Fetch Metadata nor a matching `Origin`; browsers send
those automatically, and scripts must send `X-Thesis-Token` with the contents of
the `csrf-token` file the server writes at every start and names on stdout. That
is a browser-CSRF boundary, not local access control: any process on the machine
can present the same headers. Report security problems through the
repository's [private advisory form](https://github.com/eligorelick/Thesis-AI-equity-research/security/advisories/new), not a public issue.

## Commands

<!-- BEGIN GENERATED: commands -->

| Command | What it does |
| --- | --- |
| `npm run dev` | Run the app on 127.0.0.1 in development. |
| `npm run build` | Production build. |
| `npm run start` | Serve the production build on 127.0.0.1. |
| `npm run typecheck` | Type-check without emitting. |
| `npm run lint` | ESLint over the repository. |
| `npm run test` | The product test suite. Fully offline whatever .env holds. |
| `npm run test:integration` | The database CLI suite, which runs in its own process. |
| `npm run test:coverage` | Both coverage contracts, core and risk. |
| `npm run test:watch` | The product suite in watch mode. |
| `npm run export:corrected` | Write a corrected report export from a stored run. |
| `npm run settings:reset` | Delete stored settings rows so .env takes precedence again. Needs --yes. |
| `npm run db:push` | Apply the Drizzle schema to the configured database. |
| `npm run check:dependencies` | Assert the dependency tree's shape. |
| `npm run models:refresh` | Diff config/models.json against the published model list and prices. Sends no model request. |
| `npm run costs:reconcile` | Lower presumed spend rows against the Usage and Cost API. Needs ANTHROPIC_ADMIN_KEY. |
| `npm run docs:config` | Regenerate the README's configuration and commands tables. |
| `npm run docs:pricing` | Regenerate the README's cost table from the model registry. |
| `npm run audit:deltas` | Refresh the audited fixture comparison's intended-delta list. |
| `npm run audit:security` | Dependency audit at the release threshold. |
| `npm run verify` | Everything the release gate runs, in order. |

<!-- END GENERATED: commands -->

The product suite makes no network request whatever your `.env` contains; one
live SEC check is opt-in with `EDGAR_LIVE_SMOKE=1` and a real `EDGAR_CONTACT`.
GitHub Actions requires `full` and `windows-smoke` on Node 24. Contributions
should preserve source tracing, add focused regressions and pass `npm run verify`.

## Limitations

- Thesis is a research tool for one local user, not a broker or a trading
  system. A traced number can still come from incorrect source data, and AI
  narrative can be wrong even when its citations resolve.
- Verification traces numbers against the registry only: a figure lifted from
  filing prose stays unverified, and each consistency check judges only the
  claims whose figure it can locate. An analyst case over the length cap is
  truncated before the judge sees it — what went is named in the manifest, but
  the judge read less of it.

## License and data rights

The code is [MIT](LICENSE); retrieved data and model output have separate
[data rights](docs/DATA-RIGHTS.md), including when shared in reports.
