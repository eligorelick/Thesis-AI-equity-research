# License and data rights

## The code license and the data are separate

Thesis is MIT licensed ([`LICENSE`](../LICENSE)). That license covers this
source code. It does not grant rights to provider data, issuer-authored text,
transcripts, news articles, trademarks or other third-party material retrieved
by the application. A working endpoint, keyless access or an accepted API key
establishes technical access, not permission for every use.

This page describes data use in the implementation and points to provider
terms reviewed on **2026-10-04**. Your applicable agreement, dataset notices
and intended use still govern; Thesis does not check them or certify that an
account's rights cover this workflow. Provider terms and plans can change.

## What Thesis does with retrieved material

| Operation | Actual implementation behavior |
| --- | --- |
| Retrieval | Requests company/market/filing data through configured providers and keyless fallbacks; entitlement refusals become disclosed gaps |
| Local storage | Caches provider responses, potentially full filing HTML and transcripts; retains report history and settled AI pass artifacts |
| Calculations | Derives financial metrics, valuations, scores and comparisons from those inputs |
| AI inference | Sends budgeted excerpts, company/market figures, provenance and missing-data disclosures to the selected Claude, ChatGPT or Gemini connection; judge/repair requests can resend model outputs |
| Export | Renders saved reports as Markdown or print HTML for browser PDF; corrected export creates HTML plus structured JSON |
| Sharing | The app has no publishing service, but you can share the exported files or expose an instance yourself |

AI off disables inference but still permits retrieval and local calculations.
Choosing SEC statements does not remove other vendors' data from a report.
The FMP access tracker caches explicit endpoint/symbol refusals for 15 minutes;
that behavior manages requests, not licensing permission. Likewise, source
attribution and citation coverage document provenance without granting rights.

## Provider considerations

**Yahoo Finance.** Thesis uses the keyless chart endpoint as a quote/price
history fallback. It is an unofficial integration with no application API
contract guaranteeing availability. Yahoo's terms restrict automated data
collection without prior permission; local/personal use does not itself grant
that permission or redistribution rights. Review the applicable
[Yahoo terms](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html).

**Financial Modeling Prep.** Rights depend on the subscription and any order
form. The posted agreement distinguishes personal and display use, restricts
sharing and derived-data use outside the license, and includes obligations
concerning cached data after termination. This matters for local analysis,
sending evidence to an AI service, internal multi-user access and publication,
not just resale. An API key or paid plan alone does not resolve those rights.
Check your agreement against the
[FMP terms](https://site.financialmodelingprep.com/developer/docs/terms-of-service).
Thesis does not delete FMP cache/report data automatically when a subscription
ends or an API key is removed.

**SEC EDGAR.** The SEC's website policy permits copying/distributing public
site information without SEC permission and requests attribution. That policy
also addresses its logos/trademarks. Issuer-authored filings and embedded
third-party works are not automatically US government works merely because
EDGAR hosts them; this page does not establish unrestricted rights in every
excerpt. See the [SEC dissemination policy](https://www.sec.gov/about/privacy-information)
and the [government-work copyright provision](https://www.copyright.gov/title17/92chap1.html#105).
Access has a separate fair-access policy: SEC rate controls limit excessive
requests above 10 per second. Thesis's client limit is five per second, sends
`EDGAR_CONTACT` as its User-Agent and blocks live retrieval when the contact
fails its non-placeholder identity validator. That validator checks format;
it does not prove the mailbox is reachable. See the
[SEC rate-control notice](https://www.sec.gov/filergroup/announcements-old/new-rate-control-limits).

**FRED.** The service includes third-party series with their own copyright
notices, attribution requirements and use restrictions. Its posted terms also
restrict content use connected with software/AI development or training; do
not assume that using a pre-trained model settles whether the intended
workflow is allowed. Thesis currently places available FRED values in the
research payload and computed context. This is an implementation disclosure,
not a determination that every inference use is permitted. Review the
[FRED terms and series notices](https://fred.stlouisfed.org/legal/) for your use.
The report includes FRED attribution, but the app does not perform a per-series
license review or record all upstream notices. The keyless CSV fallback is
also FRED content subject to applicable terms.

**Finnhub.** Used for insider sentiment, news/earnings fallback and certain
sector data. Its posted terms limit personal plans, restrict business use even
internally without written approval, and restrict sharing of data or derived
results. Access through a free key does not establish commercial or third-party
display rights. Review your plan and
[Finnhub terms](https://finnhub.io/terms-of-service).

**FINRA.** Thesis queries short-interest partitions and settlement-cycle data
without a production credential. FINRA's API terms incorporate program and
dataset-specific terms and restrict transfers/disclosure outside authorized
use. Keyless retrieval is not a general public-domain license. Review the
[FINRA API terms](https://developer.finra.org/finra-api-terms-service) and the
specific terms for the dataset.

**AI services and web-search sources.** Your selected AI service has its own
account terms, data-use settings and content policies. Its authorization does
not grant rights to transmit another vendor's data to it. Claude analyst web
search can introduce additional source material governed by the originating
site's rights; successful observed URLs establish citation evidence, not a
license. ChatGPT/Gemini adapters use supplied evidence without additional web
search. [Privacy](PRIVACY.md) describes transmission and local credentials;
[AI usage](CLAUDE-USAGE.md) describes execution and billing.

## Retention and sharing

Provider cache rows are generally kept until 30 days beyond their stored TTL
and swept on database opening at most once per 24 hours. Filed documents and
transcripts have a ten-year TTL. Saved reports, analyst artifacts and job/cost
history do not expire. These technical retention choices can outlast rights
under a provider agreement. Removing a key or disconnecting AI does not purge
historical data. See [local deletion instructions](PRIVACY.md#deleting-local-data),
including legacy copies, exports and backups.

An export can contain provider figures, derived calculations, source URLs,
quoted filing/transcript evidence, executive/insider names and generated
analysis. Structured JSON may contain more than the visible printout. A
corrected export updates certain rendering/safety/accounting disclosures; it
does not cleanse data rights or replace historical evidence with newly licensed
data. Markdown, HTML, PDF, JSON, screenshots and shared database copies all
require consideration of the underlying rights. Thesis does not filter exports
by license, obtain display permission or remove restricted sources for you.

Reports are informational only. They are not investment advice.
