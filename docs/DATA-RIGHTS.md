# License and data rights

## The license covers the code only

Thesis is MIT licensed (`LICENSE`). That license covers this source code. It
does not grant any right to the market and filing data the app retrieves: that
data belongs to the providers below, under their terms, not under the MIT
license. Configuring a key is your agreement with that provider, not with
Thesis.

## Per provider

**Yahoo Finance** (the keyless price fallback). Yahoo's terms prohibit
automated access without permission, its quotes can be delayed, and
the chart endpoint Thesis uses is unofficial and undocumented — Yahoo can
change or withdraw it without notice. Local or personal use does not itself
grant permission for automated access or redistribution. Check the applicable
[Yahoo terms](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html).

**Financial Modeling Prep.** Displaying or redistributing FMP data requires
the rights granted by your FMP agreement. Using the data privately under your
own subscription is not the same as putting it in front of others; if you plan
to publish, confirm the relevant display and redistribution permissions first.
See [FMP terms](https://site.financialmodelingprep.com/developer/docs/terms-of-service).

**SEC EDGAR.** The SEC's [website dissemination policy](https://www.sec.gov/about/privacy-information)
allows copying and distributing public information from its site without SEC
permission and requests source attribution. Issuer-authored filings are not
automatically US government works merely because EDGAR hosts them; do not infer
unrestricted rights in every embedded third-party work from the government's
[copyright exception](https://www.copyright.gov/title17/92chap1.html#105).
Access also has conditions: the SEC requires a
declared `User-Agent` naming a real contact and limits clients to at most 10
requests per second. Thesis sends `EDGAR_CONTACT` on every request and does not
run the live EDGAR path until you configure a real one.

**FRED** (Federal Reserve Bank of St. Louis). FRED series carry their own terms
of use, and some series are redistributed from third parties whose separate
copyright terms apply. Check the [current FRED terms](https://fred.stlouisfed.org/legal/)
and series notices for your intended use. The terms also restrict development
or training of AI systems using FRED content. This audit does not establish
whether every Thesis inference use is permitted; that remains a provider-rights
question, and source attribution alone does not resolve it.

**Finnhub and FINRA.** Each has its own terms for the data it serves; the same
rule applies — the MIT license does not extend to it.

## Sharing a report

A generated report embeds provider data: figures, and quoted excerpts of
filings or transcripts where they were cited. Sharing the report shares that
data, and every restriction above travels with it. A report that is fine to
keep on your own machine may not be fine to publish.

Reports are informational only. They are not investment advice.
