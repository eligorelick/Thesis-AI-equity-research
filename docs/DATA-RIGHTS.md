# License and data rights

## The license covers the code only

Thesis is MIT licensed (`LICENSE`). That license covers this source code. It
does not grant any right to the market and filing data the app retrieves: that
data belongs to the providers below, under their terms, not under the MIT
license. Configuring a key is your agreement with that provider, not with
Thesis.

## Per provider

**Yahoo Finance** (the keyless price fallback). Yahoo's terms prohibit
automated access and redistribution of its data, its quotes are delayed, and
the chart endpoint Thesis uses is unofficial and undocumented — Yahoo can
change or withdraw it without notice. Treat this path as personal, local,
non-redistributable use.

**Financial Modeling Prep.** Displaying or redistributing FMP data requires
FMP's Data Display and Licensing Agreement. Using the data privately under your
own subscription is not the same as putting it in front of others; if you plan
to publish, sign the agreement first.

**SEC EDGAR.** Filings are US government works in the public domain, so the
content carries no license restriction. Access does: the SEC requires a
declared `User-Agent` naming a real contact and limits clients to at most 10
requests per second. Thesis sends `EDGAR_CONTACT` on every request and does not
run the live EDGAR path until you configure a real one.

**FRED** (Federal Reserve Bank of St. Louis). FRED series carry their own terms
of use, and some series are redistributed from third parties whose separate
copyright terms apply. Check the terms for any series you intend to publish.

**Finnhub and FINRA.** Each has its own terms for the data it serves; the same
rule applies — the MIT license does not extend to it.

## Sharing a report

A generated report embeds provider data: figures, and quoted excerpts of
filings or transcripts where they were cited. Sharing the report shares that
data, and every restriction above travels with it. A report that is fine to
keep on your own machine may not be fine to publish.

Reports are informational only. They are not investment advice.
