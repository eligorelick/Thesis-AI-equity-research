# Thesis

Thesis is a local-first equity research application. Enter a ticker: it collects
and validates market data, computes deterministic financial metrics, optionally
runs grounded AI analysis, and saves a report in which every number carries a
source path and an as-of date.

> **Informational only — not investment advice.** Reports contain A-F letter
> grades and scenario price targets: model outputs derived from the data and
> assumptions the report discloses, not a recommendation to buy, sell or hold
> any security, and no price target in one is authored by a person. Market data
> and AI output can be delayed, incomplete, or wrong.

## What it does

- Fetches typed data from Financial Modeling Prep, SEC EDGAR, Yahoo Finance,
  FINRA, FRED and Finnhub, and validates freshness, balance-sheet identities
  and selected vendor figures against EDGAR XBRL.
- Computes growth, returns, capital structure, valuation, scenarios,
  technicals, grades and forensic indicators in deterministic TypeScript, on a
  route decided by what the filer actually tags.
- Optionally runs independent Anthropic bull and bear analyses and a judge
  pass, verifies every cited number without another model call, and turns
  missing inputs into disclosed gaps rather than fabricated values.

## Quick start

Node.js 22.18 or newer, and npm. CI tests Node 24, the supported
configuration; Node 20 reached end of life in April 2026.

```powershell
npm ci
Copy-Item .env.example .env   # cp on macOS and Linux
npm run dev
```

Open <http://127.0.0.1:3000>; development and production both bind to
`127.0.0.1`. Every provider key is optional: with no `FMP_API_KEY`, set
`EDGAR_CONTACT` to a truthful "Name email" identity and real US-listed tickers
come from SEC EDGAR and Yahoo. With no key at all, `/report/sample` renders a
fictional report, and `/company/DEMO` and `/company/DBNK` are reserved strings
served from `fixtures/fmp` whatever keys are set. None of the three reaches a
provider and each says so in the manifest; any other symbol is a live request.

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
| `THESIS_STREAM_IDLE_SECONDS` | `120` | Gap with no stream event after which a paid request is abandoned. |
| `THESIS_ROLLING_COST_WINDOW_MINUTES` | `1440` | Maximum supported window: 52,560,000 minutes (100 years). |
| `THESIS_PAID_PASS_LEASE_SECONDS` | `900` | Anthropic requests hard-timeout after 600 seconds. |
| `THESIS_JOB_LEASE_SECONDS` | `900` | Anthropic requests hard-timeout after 600 seconds. |
| `THESIS_RESUME_ON_START` | `1` | Startup hold. |
| `THESIS_EV_INCLUDE_LEASES` | `1` (opt in) | Keep the OPERATING-lease liability in enterprise value and in the DCF equity bridge. |
| `THESIS_ALLOWED_HOST` | unset | `npm run dev` and `npm start` bind to 127.0.0.1 by default. |
| `THESIS_TOKEN_FILE` | unset (opt in) | Mutating routes (report, retry, cancel, settings, watchlist, resume) reject a request that carries neither browser Fetch Metadata nor a matching Origin. |
| `THESIS_DB_PATH` | unset (opt in) | The SQLite DB defaults to the OS app-data directory (so its WAL/SHM writes do not trigger Next.js dev-server rebuilds from inside the repo). |
| `THESIS_DATA_DIR` | unset (opt in) | The SQLite DB defaults to the OS app-data directory (so its WAL/SHM writes do not trigger Next.js dev-server rebuilds from inside the repo). |
| `THESIS_IMPORT_LEGACY_DB` | `1` (opt in) | One-time migration only. |

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

[`docs/METHODOLOGY.md`](docs/METHODOLOGY.md) documents every convention and
names its sources. In short: sector routing reads XBRL tag evidence alongside
the SIC code and the industry label, and evidence that contradicts the declared
classification is disclosed rather than acted on. Bank, insurer and
mortgage-REIT routes withhold the FCFF discounted cash flow, the reverse DCF,
EV/EBITDA, ROIC-minus-WACC, Altman Z, Beneish M and the accrual ratios — every
estimation sample behind those excluded financial institutions — and value the
company on excess returns to equity instead. Near-term growth is the median of
the methods the data supports, with the range shown and every unavailable one
named. Free cash flow is reported after stock-based compensation with the
before figure beside it, and an own-history multiple is a rank among N quarters
rather than a percentile, N printed beside it. Where a rule is this project's
own choice rather than a standard, the report calls it a house convention in
the same breath as the number.

A report with no Anthropic key still carries every deterministic result and
says that no analyst pass ran; only the narrative sections are empty.
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
around those figures: a direction word must match the sign of its change, a
period naming a year must match the cited period, a unit word must match the
registered unit, and a claim naming a person must cite a filing or a transcript
rather than a web search. Checked is printed beside cited and never merged into
it: a figure can be perfectly cited by a sentence that contradicts it.

`ANALYSIS_MODEL` takes `auto` or a model from `config/models.json`, which is
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

| Analysis model | One analyst request | One synthesize request | Analyst pass worst case | Estimated run |
| --- | ---: | ---: | ---: | ---: |
| Claude Fable 5.1 | $18.98 | $18.90 | $683.28 | $4.46 |
| Claude Fable 5 | $18.98 | $18.90 | $683.28 | $4.60 |
| Claude Opus 5 | $9.53 | $9.45 | $343.08 | $2.34 |
| Claude Opus 4.8 | $9.53 | $9.45 | $343.08 | $2.34 |
| Claude Sonnet 5 | $3.86 | $3.78 | $138.96 | $0.98 |
| Claude Haiku 4.5 | $0.65 | $3.78 | $23.40 | $0.69 |

The worst case is every request one pass could make (36: six transport attempts,
each able to pause and resume five times); it is reported, not reserved, so a job
cap need only cover the requests in flight. The estimate is a calculation,
not a measurement: the fixture run shape at registry rates, with Haiku's
synthesize figures those of Sonnet 5 because that pass is raised to it.
Measured: Haiku $1.43; Opus 5 on MSFT $5.31 over six requests — each of the three
passes was schema-rejected once and repaired, so its winning requests were $2.66.

<!-- END GENERATED: pricing -->

## Running it safely

Thesis sends nothing to Thesis: no telemetry, no analytics, no update check.
The only outbound traffic goes to the providers you configure —
[Privacy and safety](docs/PRIVACY.md) names exactly what each one receives,
where the local database lives, and how to delete it.

The application is single-user and has no authentication; keep it on loopback
unless you add a security layer of your own. Mutating routes reject a request
carrying neither browser Fetch Metadata nor a matching `Origin`; browsers send
those automatically, and scripts must send `X-Thesis-Token` with the contents
of the `csrf-token` file the server writes at every start and names on stdout.
That is a browser-CSRF boundary, not local access control: any process on the
machine can present the same headers. Report security problems through the
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
GitHub Actions runs the same gates on Node 24; administrators must configure
branch protection to require the `CI / full` check, which the workflow cannot
enable itself. Issues and pull requests are welcome: keep changes focused, add
regression tests, preserve deterministic computation and source tracing, and
run `npm run verify` first.

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

The code is [MIT](LICENSE). The license does not cover the market data,
filings, news or model output Thesis retrieves, and sharing a generated report
shares that provider data with it. See
[License and data rights](docs/DATA-RIGHTS.md).
