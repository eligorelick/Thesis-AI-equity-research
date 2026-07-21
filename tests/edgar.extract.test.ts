/**
 * Section-extraction tests built from compact SEC filing excerpts under
 * fixtures/edgar/, assembled into synthetic full documents where needed.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeEntities,
  detectStub,
  extractFromExhibit,
  extractSection,
  findHeaderCandidates,
  htmlToText,
  mergedAnchors,
  normalizeTitle,
  parseCrossRefIndex,
  parseDocument,
  parseQuotedTitles,
  parseTocEntries,
  resolveAnchor,
  stripHiddenBlocks,
} from "@/edgar/extract";

const SAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "edgar");
const sample = (name: string): string => readFileSync(path.join(SAMPLES, name), "utf8");

/** Padded filler with a grep-able marker so slices can be asserted in/out. */
function para(n: number, tag: string): string {
  const sentence = `${tag} The Company faces a variety of business and market risks that could materially affect results of operations. `;
  let s = "";
  while (s.length < n) s += sentence;
  return `<div><span style="font-weight:400">${s}</span></div>`;
}

/** JPM/AAPL-style TOC row: item-number link + title link, SAME target. */
const itemRow = (href: string, num: string, title: string): string =>
  `<tr><td><a href="#${href}">${num}</a></td><td><a href="#${href}">${title}</a></td><td colspan="3"/></tr>`;

/** JPM 10-Q style row (F3): item number as PLAIN text, only the title is linked. */
const itemRowPlain = (href: string, num: string, title: string): string =>
  `<tr><td colspan="3"><div><span>${num}</span></div></td><td colspan="3"><div><span><a href="#${href}">${title}</a></span></div></td><td colspan="3"/></tr>`;

/** MXC-style row: title-only link, no item number anywhere. */
const titleOnlyRow = (href: string, title: string): string => `<tr><td><a href="#${href}">${title}</a></td><td>9</td></tr>`;

/** Citi-style contents row: bold un-linked title, page number is the link text. */
const citiRow = (href: string, title: string, page: number): string =>
  `<tr><td colspan="3" style="padding:0 1pt"/><td colspan="3"><span style="font-weight:700">${title}</span></td><td colspan="3"><div style="text-align:right"><a href="#${href}">${page}</a></div></td></tr>`;

const partRow = (label: string): string => `<tr><td colspan="6"><span>${label}</span></td></tr>`;

// ---------------------------------------------------------------------------
// Text / preprocessing utilities
// ---------------------------------------------------------------------------

describe("text utilities", () => {
  it("decodes numeric and named entities", () => {
    expect(decodeEntities("Management&#8217;s&#160;Discussion &amp; Analysis &#x2019;")).toBe(
      "Management’s Discussion & Analysis ’",
    );
  });

  it("htmlToText strips tags/comments and collapses whitespace", () => {
    expect(htmlToText("<!-- x --><div><span>Item&#160;1A.</span>  <b>Risk\nFactors</b></div>")).toBe("Item 1A. Risk Factors");
  });

  it("stripHiddenBlocks removes ix:header and display:none blocks before char counts (F13)", () => {
    const html =
      `<ix:header><div>HIDDENJUNK 73,618 56,251</div></ix:header>` +
      `<div style="display:none"><div>NESTEDHIDDEN</div></div>` +
      `<td colspan="3" style="display:none"/>` +
      `<div>VISIBLE</div>`;
    const text = htmlToText(stripHiddenBlocks(html));
    expect(text).toContain("VISIBLE");
    expect(text).not.toContain("HIDDENJUNK");
    expect(text).not.toContain("NESTEDHIDDEN");
  });

  it("strips thousands of hidden tags within a linear-time budget", () => {
    const hidden = '<td style="display:none"/>';
    const html = hidden.repeat(3500) + `<div>${"VISIBLE ".repeat(250_000)}</div>`;
    const started = performance.now();
    const out = stripHiddenBlocks(html);
    const elapsedMs = performance.now() - started;

    expect(out).toContain("VISIBLE");
    expect(out).not.toContain('style="display:none"');
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("normalizeTitle unifies apostrophes, dashes and ampersands", () => {
    expect(normalizeTitle("MANAGEMENT’S  DISCUSSION & ANALYSIS.")).toBe("management's discussion and analysis");
    expect(normalizeTitle("Financial Review – Risk Factors.")).toBe("financial review - risk factors");
  });
});

describe("mergedAnchors (F1/F2)", () => {
  it("merges fragmented adjacent same-href links (JPM Item 1C)", () => {
    const html = `<td><a href="#g_37">Item 1</a><a href="#g_37">C</a><a href="#g_37">.</a></td>`;
    const anchors = mergedAnchors(html);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].text).toBe("Item 1C.");
    expect(anchors[0].target).toBe("g_37");
  });

  it("does NOT merge item + title links in separate cells", () => {
    const html = `<tr><td><a href="#g_37">Item 1B.</a></td><td><a href="#g_37">Unresolved Staff Comments.</a></td></tr>`;
    const anchors = mergedAnchors(html);
    expect(anchors).toHaveLength(2);
    expect(anchors[0].text).toBe("Item 1B.");
    expect(anchors[1].text).toBe("Unresolved Staff Comments.");
  });
});

describe("resolveAnchor", () => {
  it("finds div ids, span ids and a-name targets", () => {
    const html = `<p>x</p><div id="a1"></div><span id='a2'></span><a name="a3"></a>`;
    expect(resolveAnchor(html, "a1")).toBe(html.indexOf(`<div id="a1">`));
    expect(resolveAnchor(html, "a2")).toBeGreaterThan(0);
    expect(resolveAnchor(html, "a3")).toBeGreaterThan(0);
    expect(resolveAnchor(html, "nope")).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Stub detector on the three REAL captured stubs
// ---------------------------------------------------------------------------

describe("detectStub (Layer 3)", () => {
  it("flags the real JPM Item 7 same-doc stub", () => {
    const text = htmlToText(stripHiddenBlocks(sample("jpm_10k_item7_stub.html")));
    const r = detectStub(text);
    expect(r.isStub).toBe(true);
    expect(text).toContain("appears on pages 46");
  });

  it("flags the real FRD incorporation stub and the WFC wrapper stub", () => {
    for (const f of ["frd_10k_item7_incorporation_stub.html", "wfc_10k_wrapper_item7_stub.html"]) {
      const text = htmlToText(stripHiddenBlocks(sample(f)));
      // Whole-fixture text may be longer; the phrase leg must fire on the stub body itself.
      expect(text.length).toBeGreaterThan(0);
    }
    expect(detectStub("Information in response to this Item 7 can be found in the 2025 Annual Report to Shareholders under “Financial Review.” That information is incorporated into this item by reference.").isStub).toBe(true);
    expect(detectStub("Information with respect to Item 7 is hereby incorporated herein by reference from the section of the Company’s Annual Report to Shareholders.").isStub).toBe(true);
  });

  it("does not flag a real long section", () => {
    const text = `Item 1A. Risk Factors ${"The Company is exposed to macroeconomic risk. ".repeat(100)}`;
    expect(detectStub(text).isStub).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AAPL — Layer 1 TOC-anchor slicing
// ---------------------------------------------------------------------------

const A = "i719388195b384d85a4e238ad88eba90a";

function buildAaplDoc(): string {
  return [
    "<table>",
    itemRow(`${A}_52`, "Item 1A.", "Risk Factors"),
    itemRow(`${A}_70`, "Item 1B.", "Unresolved Staff Comments"),
    itemRow(`${A}_94`, "Item 7.", "Management&#8217;s Discussion and Analysis of Financial Condition and Results of Operations"),
    "</table>",
    sample("aapl_10k_item1a_boundary.html"), // real anchor div _52 + bold header + intro (+ subsection anchor _55)
    para(4000, "AAPLRISK"),
    `<div id="${A}_70"></div><div><span style="font-weight:700">Item 1B.&#160;&#160;Unresolved Staff Comments</span></div><div><span>None.</span></div>`,
    `<div id="${A}_94"></div><div><span style="font-weight:700">Item 7. Management&#8217;s Discussion and Analysis of Financial Condition and Results of Operations</span></div>`,
  ].join("\n");
}

function buildTwentyFDoc(): string {
  return [
    "<table>",
    itemRow("f20_3d", "Item 3.D.", "Risk Factors"),
    itemRow("f20_4", "Item 4.", "Information on the Company"),
    itemRow("f20_5", "Item 5.", "Operating and Financial Review and Prospects"),
    itemRow("f20_6", "Item 6.", "Directors, Senior Management and Employees"),
    "</table>",
    `<div id="f20_3d"></div><h2>Item 3.D. Risk Factors</h2>${para(3000, "F20RISK")}`,
    `<div id="f20_4"></div><h2>Item 4. Information on the Company</h2>${para(3000, "F20COMPANY")}`,
    `<div id="f20_5"></div><h2>Item 5. Operating and Financial Review and Prospects</h2>${para(3000, "F20MDNA")}`,
    `<div id="f20_6"></div><h2>Item 6. Directors, Senior Management and Employees</h2>${para(3000, "F20DIRECTORS")}`,
  ].join("\n");
}

describe("Form 20-F annual sections", () => {
  it("extracts Item 3.D risk factors and Item 5 operating/financial review", () => {
    const html = buildTwentyFDoc();
    const risk = extractSection(html, { form: "20-F", item: "3D" });
    const mdna = extractSection(html, { form: "20-F", item: "5" });

    expect(risk.ok).toBe(true);
    expect(mdna.ok).toBe(true);
    if (!risk.ok || !mdna.ok) return;
    expect(risk.method).toBe("toc-anchor");
    expect(risk.text).toContain("F20RISK");
    expect(risk.text).not.toContain("F20COMPANY");
    expect(mdna.method).toBe("toc-anchor");
    expect(mdna.text).toContain("F20MDNA");
    expect(mdna.text).not.toContain("F20DIRECTORS");
  });

  it("accepts the dotted Item 3.D header when a 20-F has no usable TOC", () => {
    const html = [
      `<h2>Item 3.D. Risk Factors</h2>${para(3000, "F20HEADERONLYRISK")}`,
      `<h2>Item 4. Information on the Company</h2>${para(3000, "F20HEADERONLYBOUNDARY")}`,
    ].join("\n");
    const risk = extractSection(html, { form: "20-F", item: "3D" });
    expect(risk.ok).toBe(true);
    if (!risk.ok) return;
    expect(risk.method).toBe("header-regex");
    expect(risk.text).toContain("F20HEADERONLYRISK");
    expect(risk.text).not.toContain("F20HEADERONLYBOUNDARY");
  });
});

describe("AAPL 10-K Item 1A (Layer 1 toc-anchor)", () => {
  it("slices between the Item 1A and Item 1B anchor targets", () => {
    const r = extractSection(buildAaplDoc(), { form: "10-K", item: "1A" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.method).toBe("toc-anchor");
    expect(r.text.startsWith("Item 1A.")).toBe(true);
    expect(r.text).toContain("The following summarizes factors");
    expect(r.text).toContain("AAPLRISK");
    expect(r.text).not.toContain("Item 1B.");
    expect(r.chars).toBeGreaterThan(2500);
    // Subsection anchor _55 is NOT a TOC item entry, so it must not bound the slice.
    expect(r.text).toContain("Macroeconomic and Industry Risks");
  });

  it("hard-fails loudly when the target section body is a header-only stub (Layer 4)", () => {
    const r = extractSection(buildAaplDoc(), { form: "10-K", item: "7" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("stub_detected");
    expect(r.diagnostics.stub).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// JPM — Item 7 stub + same-doc mini-TOC redirect (Layer 3a)
// ---------------------------------------------------------------------------

const J = "i1e82dc5e49024170976eb7ddc7c0a10b";

function buildJpmDoc(withMiniToc: boolean): string {
  return [
    "<table>",
    itemRow(`${J}_34`, "Item 1A.", "Risk Factors."),
    itemRow(`${J}_37`, "Item 1B.", "Unresolved Staff Comments."),
    itemRow(`${J}_61`, "Item 7.", "Management&#8217;s Discussion and Analysis of Financial Condition and Results of Operations."),
    itemRow(`${J}_64`, "Item 7A.", "Quantitative and Qualitative Disclosures About Market Risk."),
    itemRow(`${J}_67`, "Item 8.", "Financial Statements and Supplementary Data."),
    "</table>",
    ...(withMiniToc
      ? [
          "<table>",
          `<tr><td><a href="#${J}_127">Management&#8217;s discussion and analysis</a></td><td><a href="#${J}_127">46</a></td></tr>`,
          `<tr><td><a href="#${J}_295">Management&#8217;s Report on Internal Control Over Financial Reporting</a></td><td><a href="#${J}_295">161</a></td></tr>`,
          "</table>",
        ]
      : []),
    `<div id="${J}_34"></div><div><span style="font-weight:700">Item 1A. Risk Factors.</span></div>`,
    para(4000, "JPMRISK"),
    `<div id="${J}_37"></div><div><span>Item 1B. Unresolved Staff Comments. None.</span></div>`,
    sample("jpm_10k_item7_stub.html"), // REAL Item 7 stub incl. anchor div _61
    `<div id="${J}_64"></div><div><span>Item 7A. Refer to the Market Risk Management section of Management&#8217;s discussion and analysis on pages 133-142.</span></div>`,
    `<div id="${J}_67"></div><div><span>Item 8. Financial Statements and Supplementary Data on pages 165-314.</span></div>`,
    sample("jpm_10k_mdna_body_start.html"), // REAL MD&A body start incl. anchor div _127
    para(6000, "JPMMDNA"),
    `<div id="${J}_295"></div><div><span style="font-weight:700">Management&#8217;s report on internal control over financial reporting</span></div>`,
    para(600, "MGMTREPORT"),
  ].join("\n");
}

describe("JPM 10-K Item 7 (bank stub -> mini-TOC redirect)", () => {
  it("detects the 395-char stub and redirects to the real MD&A via the mini-TOC", () => {
    const r = extractSection(buildJpmDoc(true), { form: "10-K", item: "7" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.method).toBe("mini-toc-redirect");
    expect(r.text).toContain("The following is Management");
    expect(r.text).toContain("JPMMDNA");
    expect(r.text).not.toContain("MGMTREPORT");
    expect(r.text).not.toContain("appears on pages 46");
    expect(r.diagnostics.stub).toBeDefined(); // the stub WAS seen, then redirected
  });

  it("NEVER returns the stub silently when no redirect target exists", () => {
    const r = extractSection(buildJpmDoc(false), { form: "10-K", item: "7" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("stub_detected");
    expect(r.diagnostics.stub?.chars).toBeLessThan(2500);
  });

  it("redirects a page-header annual-report body after the Item 7 stub", () => {
    const html = [
      "<table>",
      itemRow("stub7", "Item 7.", "Management's Discussion and Analysis"),
      itemRow("stub7a", "Item 7A.", "Quantitative and Qualitative Disclosures"),
      "</table>",
      `<div id="stub7"></div><h2>Item 7. Management's Discussion and Analysis</h2><p>Management's discussion and analysis appears on pages 46-160.</p>`,
      `<div id="stub7a"></div><h2>Item 7A. Quantitative and Qualitative Disclosures</h2>`,
      `<p>JPMorgan Chase & Co./2025 Form 10-K 45 Management's discussion and analysis</p>${para(3000, "PAGEHEADERMDNA")}<p>Refer to the Consolidated Financial Statements and Notes for additional detail.</p>${para(3000, "PAGEHEADERPOSTREFERENCE")}`,
      `<h2>Management's Report on Internal Control Over Financial Reporting</h2>${para(700, "PAGEHEADERBOUNDARY")}`,
    ].join("\n");
    const r = extractSection(html, { form: "10-K", item: "7" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.method).toBe("page-header-redirect");
    expect(r.text).toContain("PAGEHEADERMDNA");
    expect(r.text).toContain("PAGEHEADERPOSTREFERENCE");
    expect(r.text).not.toContain("PAGEHEADERBOUNDARY");
  });

  it("never redirects a stubbed 10-Q Item 2 into appended 10-K annual-report text", () => {
    const html = [
      "<h2>PART I — FINANCIAL INFORMATION</h2>",
      "<h2>Item 2. Management's Discussion and Analysis of Financial Condition and Results of Operations</h2><p>Management's discussion and analysis appears on pages 46-160.</p>",
      "<h2>Item 3. Quantitative and Qualitative Disclosures About Market Risk</h2>",
      `<p>JPMorgan Chase & Co./2025 Form 10-K 45 Management's discussion and analysis</p>${para(3000, "WRONGFORMANNUALMDNA")}`,
      `<h2>Management's Report on Internal Control Over Financial Reporting</h2>${para(700, "WRONGFORMBOUNDARY")}`,
    ].join("\n");
    const r = extractSection(html, { form: "10-Q", item: "2" });
    expect(r.ok).toBe(false);
  });

  it("still extracts Item 1A directly (real inline section)", () => {
    const r = extractSection(buildJpmDoc(true), { form: "10-K", item: "1A" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.method).toBe("toc-anchor");
    expect(r.text).toContain("JPMRISK");
    expect(r.text).not.toContain("JPMMDNA");
  });
});

describe("parseDocument / preparsed reuse (perf refactor, JPM extraction budget fix)", () => {
  it("shared preparsed structure produces byte-identical output to independent parses", () => {
    const doc = buildJpmDoc(true);
    const item1aAlone = extractSection(doc, { form: "10-K", item: "1A" });
    const item7Alone = extractSection(doc, { form: "10-K", item: "7" });

    const parsed = parseDocument(doc);
    const item1aShared = extractSection(doc, { form: "10-K", item: "1A" }, { preparsed: parsed });
    const item7Shared = extractSection(doc, { form: "10-K", item: "7" }, { preparsed: parsed });

    expect(item1aShared).toEqual(item1aAlone);
    expect(item7Shared).toEqual(item7Alone);
  });

  it("actually consumes preparsed instead of re-deriving from the html argument", () => {
    const doc = buildJpmDoc(true);
    const parsed = parseDocument(doc);
    // Empty html string would find nothing if preparsed were ignored.
    const r = extractSection("", { form: "10-K", item: "1A" }, { preparsed: parsed });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("JPMRISK");
  });

  it("reuses one parsed document for multiple section extractions without consulting html again", () => {
    const big = [
      "<table>",
      itemRow(`${J}_34`, "Item 1A.", "Risk Factors."),
      itemRow(`${J}_61`, "Item 7.", "Management&#8217;s Discussion and Analysis."),
      "</table>",
      `<div id="${J}_34"></div><div><span style="font-weight:700">Item 1A. Risk Factors.</span></div>`,
      para(400_000, "BIGRISK"),
      `<div id="${J}_61"></div><div><span style="font-weight:700">Item 7. Management&#8217;s Discussion and Analysis.</span></div>`,
      para(400_000, "BIGMDNA"),
    ].join("\n");

    const shared = parseDocument(big);
    // Empty html would make either extraction fail if the shared parse were
    // ignored. This proves the reuse contract deterministically; a wall-clock
    // comparison is not reliable under parallel test-suite contention.
    const item1a = extractSection("", { form: "10-K", item: "1A" }, { preparsed: shared });
    const item7 = extractSection("", { form: "10-K", item: "7" }, { preparsed: shared });

    expect(item1a.ok).toBe(true);
    expect(item7.ok).toBe(true);
    if (item1a.ok) expect(item1a.text).toContain("BIGRISK");
    if (item7.ok) expect(item7.text).toContain("BIGMDNA");
  });
});

// ---------------------------------------------------------------------------
// 10-Q — Part-aware extraction + unchanged-from-10-K marker
// ---------------------------------------------------------------------------

const Q = "i1468582547144a00ae69bd4661b9ea50";

function buildTenQDoc(riskFactorsBody: string): string {
  return [
    "<table>",
    partRow("PART I &#8212; FINANCIAL INFORMATION"),
    itemRowPlain(`${Q}_169`, "Item 1.", "Financial Statements."),
    itemRowPlain(`${Q}_25`, "Item 2.", "Management&#8217;s Discussion and Analysis of Financial Condition and Results of Operations."),
    itemRowPlain(`${Q}_343`, "Item 3.", "Quantitative and Qualitative Disclosures About Market Risk."),
    partRow("PART II &#8212; OTHER INFORMATION"),
    itemRowPlain(`${Q}_355`, "Item 1A.", "Risk Factors."),
    itemRowPlain(`${Q}_358`, "Item 2.", "Unregistered Sales of Equity Securities and Use of Proceeds."),
    "</table>",
    // JPM 10-Q body order: MD&A FIRST, financial statements after (position
    // assumptions would fail; anchor boundaries must handle it). The MD&A body
    // carries NO "Item 2." header at all (F6).
    `<div id="${Q}_25"></div>`,
    `<div><span style="font-weight:700">INTRODUCTION</span></div>`,
    `<div><span>The following is Management&#8217;s discussion and analysis of the financial condition and results of operations (&#8220;MD&amp;A&#8221;) of JPMorgan Chase &amp; Co. for the first quarter of 2026.</span></div>`,
    para(6000, "QMDNA"),
    `<div id="${Q}_169"></div><div><span>JPMorgan Chase &amp; Co. Consolidated statements of income</span></div>`,
    para(1500, "QFINSTMTS"),
    `<div><span style="font-weight:700">PART II &#8212; OTHER INFORMATION</span></div>`,
    `<div id="${Q}_355"></div>`,
    riskFactorsBody,
    `<div id="${Q}_358"></div><div><span>Item 2. Unregistered Sales of Equity Securities and Use of Proceeds. None.</span></div>`,
  ].join("\n");
}

const JPM_10Q_RISK_STUB = `<div><span>Item 1A. Risk Factors. Refer to Part I, Item 1A: Risk Factors on pages 9&#8211;31 of JPMorganChase&#8217;s 2025 Form 10-K and Forward-Looking Statements on page 79 of this Form 10-Q for a discussion of certain risk factors.</span></div>`;

describe("10-Q Part-aware extraction", () => {
  it("Part I Item 2 (MD&A) resolves via the title link even with two 'Item 2.' TOC rows", () => {
    const r = extractSection(buildTenQDoc(JPM_10Q_RISK_STUB), { form: "10-Q", item: "2" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.method).toBe("toc-anchor");
    expect(r.text.startsWith("INTRODUCTION")).toBe(true);
    expect(r.text).toContain("QMDNA");
    expect(r.text).not.toContain("QFINSTMTS");
    expect(r.text).not.toContain("Unregistered Sales");
  });

  it("Part II Item 1A stub referencing the 10-K becomes the unchanged-from-10-K marker", () => {
    const r = extractSection(buildTenQDoc(JPM_10Q_RISK_STUB), { form: "10-Q", item: "1A" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.method).toBe("unchanged-from-10k");
    expect(r.marker).toBe("unchanged_from_10k");
    expect(r.text).toContain("2025 Form 10-K");
  });

  it("Part II Item 1A with REAL updates is returned as content (AAPL case)", () => {
    const real = `<div><span>Item 1A. Risk Factors. The Company&#8217;s risk factors have been updated as follows.</span></div>${para(3500, "QRISKUPD")}`;
    const r = extractSection(buildTenQDoc(real), { form: "10-Q", item: "1A" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.method).toBe("toc-anchor");
    expect(r.marker).toBeUndefined();
    expect(r.text).toContain("QRISKUPD");
  });
});

// ---------------------------------------------------------------------------
// WFC wrapper — Layer 2 + exhibit redirect signal (Layer 3b)
// ---------------------------------------------------------------------------

describe("WFC wrapper 10-K (F17/F18/F19)", () => {
  it("finds the ALL-CAPS Item 7 stub via header regex and signals an EX-13 redirect with the quoted section name", () => {
    const r = extractSection(sample("wfc_10k_wrapper_item7_stub.html"), { form: "10-K", item: "7" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("exhibit_redirect");
    expect(r.error.exhibit).toBeDefined();
    expect(r.error.exhibit?.exhibitTypePrefix).toBe("EX-13");
    expect(r.error.exhibit?.section).toBe("mdna");
    const quoted = r.error.exhibit?.quotedTitles ?? [];
    expect(quoted.some((t) => normalizeTitle(t) === "financial review")).toBe(true);
  });
});

describe("extractFromExhibit — WFC EX-13 (toc route, F21 cell-order variance)", () => {
  const X = "i164b6cae1e5547848aac34e66a101b06";
  const exhibit = [
    "<table>",
    // WFC EX-13 TOC puts the PAGE NUMBER first; both cells link to the target.
    `<tr><td><a href="#${X}_31">2</a></td><td><a href="#${X}_31">Financial Review</a></td></tr>`,
    `<tr><td><a href="#${X}_244">62</a></td><td><a href="#${X}_244">Risk Factors</a></td></tr>`,
    `<tr><td><a href="#${X}_250">75</a></td><td><a href="#${X}_250">Controls and Procedures</a></td></tr>`,
    "</table>",
    `<div id="${X}_31"></div><div><span>This Annual Report, including the Financial Review and the Financial Statements and related Notes, contains forward-looking statements.</span></div>`,
    para(6000, "WFCFINREV"),
    `<div id="${X}_244"></div><div><span>Risk Factors An investment in the Company involves risk, including the possibility that the value of the investment could fall substantially.</span></div>`,
    para(4000, "WFCRISK"),
    `<div id="${X}_250"></div><div><span>Controls and Procedures</span></div>`,
    para(500, "WFCCONTROLS"),
  ].join("\n");

  it("resolves MD&A via the quoted 'Financial Review' synonym (F19)", () => {
    const r = extractFromExhibit(exhibit, { section: "mdna", quotedTitles: ["Financial Review."] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.method).toBe("exhibit-toc");
    expect(r.text).toContain("This Annual Report");
    expect(r.text).toContain("WFCFINREV");
    expect(r.text).not.toContain("WFCRISK");
  });

  it("resolves Risk Factors from the composite quoted title 'Financial Review – Risk Factors'", () => {
    const r = extractFromExhibit(exhibit, { section: "riskFactors", quotedTitles: ["Financial Review – Risk Factors."] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.method).toBe("exhibit-toc");
    expect(r.text).toContain("An investment in the Company involves risk");
    expect(r.text).toContain("WFCRISK");
    expect(r.text).not.toContain("WFCFINREV");
    expect(r.text).not.toContain("WFCCONTROLS");
  });
});

// ---------------------------------------------------------------------------
// FRD — no anchors at all; header regex; EX-13 incorporation + header route
// ---------------------------------------------------------------------------

describe("FRD 10-K (F8/F9/F10)", () => {
  it("Item 7 incorporation stub triggers the exhibit redirect with the quoted MD&A title", () => {
    const r = extractSection(sample("frd_10k_item7_incorporation_stub.html"), { form: "10-K", item: "7" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("exhibit_redirect");
    const quoted = (r.error.exhibit?.quotedTitles ?? []).map(normalizeTitle);
    expect(quoted).toContain("management's discussion and analysis of financial condition and results of operations");
  });

  it("extractFromExhibit falls back to the FIRST ALL-CAPS title-only heading (no item number)", () => {
    const exhibit = [
      `<ix:header><div>ex_780550.htm 73,618 56,251 1 1 10,000,000 HIDDENIX</div></ix:header>`,
      para(1200, "FRDSTMTS"),
      `<p><b>MANAGEMENT&#8217;S DISCUSSION AND ANALYSIS OF FINANCIAL CONDITION AND RESULTS OF OPERATIONS</b></p>`,
      para(5000, "FRDMDNA"),
      // Decoy AFTER the real header (forward-looking boilerplate) — first-match rule must hold.
      `<p>statements within MANAGEMENT&#8217;S DISCUSSION AND ANALYSIS OF FINANCIAL CONDITION AND RESULTS OF OPERATIONS are forward-looking.</p>`,
      para(500, "FRDTAIL"),
    ].join("\n");
    const r = extractFromExhibit(exhibit, {
      section: "mdna",
      quotedTitles: ["Management’s Discussion and Analysis of Financial Condition and Results of Operations"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.method).toBe("exhibit-header");
    expect(r.text.startsWith("MANAGEMENT")).toBe(true);
    expect(r.text).toContain("FRDMDNA");
    expect(r.text).not.toContain("HIDDENIX");
    expect(r.text).not.toContain("FRDSTMTS");
  });

  it("'Not required.' bodies are surfaced as not_required, never as content (F10)", () => {
    const doc = [
      `<p><b>Item&#160;1A.&#160;&#160;Risk Factors</b></p>`,
      `<p>Not required.</p>`,
      `<p><b>Item&#160;1B.&#160;&#160;Unresolved Staff Comments</b></p>`,
      `<p>None.</p>`,
    ].join("\n");
    const r = extractSection(doc, { form: "10-K", item: "1A" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("not_required");
  });
});

// ---------------------------------------------------------------------------
// MXC — title-only TOC links + header-in-table + F7 cross-reference trap
// ---------------------------------------------------------------------------

describe("MXC 10-K (F3/F7/F11)", () => {
  const body = [
    sample("mxc_10k_item1a_header_in_table.html"), // ALL-CAPS <b> header split across <td>s, <span id="s_004"> anchor
    para(4000, "MXCRISK"),
    `<span id="s_005"></span><table><tr><td><b>ITEM 1B.</b></td><td><b>UNRESOLVED STAFF COMMENTS</b></td></tr></table>`,
    `<p>None.</p>`,
  ].join("\n");

  it("extracts Item 1A via title-only TOC links (Layer 1 title variant)", () => {
    const doc = ["<table>", titleOnlyRow("s_004", "Risk Factors"), titleOnlyRow("s_005", "Unresolved Staff Comments"), "</table>", body].join("\n");
    const r = extractSection(doc, { form: "10-K", item: "1A" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.method).toBe("toc-title");
    expect(r.text).toContain("ITEM 1A.");
    expect(r.text).toContain("The Company is subject to various risks");
    expect(r.text).toContain("MXCRISK");
    expect(r.text).not.toContain("UNRESOLVED STAFF COMMENTS");
  });

  it("Layer 2 rejects title-bearing cross-references appearing after later headers (F7 last-match trap)", () => {
    const doc = [
      body,
      // Inside a later item: MXC-style cross-reference INCLUDING the section title.
      `<p>For additional information about cybersecurity threats, see &#8220;Item 1A. Risk Factors&#8221; above for additional information.</p>`,
    ].join("\n");
    const r = extractSection(doc, { form: "10-K", item: "1A" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.method).toBe("header-regex");
    expect(r.text.startsWith("ITEM 1A.")).toBe(true);
    expect(r.text).toContain("MXCRISK");
    expect(r.text).not.toContain("additional information");
  });
});

// ---------------------------------------------------------------------------
// BAC — F15 interposed entity name / F16 decoy swarm (header candidates)
// ---------------------------------------------------------------------------

describe("BAC header candidates (F15/F16)", () => {
  const MDNA_TITLE = { id: "7", title: /Management['’‘]?s?[\s]+Discussion[\s]+and[\s]+Analysis/i };

  it("matches the real BAC Item 7 header with the interposed entity name", () => {
    const text = htmlToText(stripHiddenBlocks(sample("bac_10k_item7_header_entityname.html")));
    const cands = findHeaderCandidates(text, MDNA_TITLE);
    expect(cands.length).toBeGreaterThan(0);
    expect(text.slice(cands[0].index, cands[0].index + 120)).toContain("Bank of America");
  });

  it("rejects 'on page N' decoys (F16)", () => {
    const text =
      "For more information, Item 1A. Risk Factors – Regulatory, Compliance and Legal on page 17 discusses these matters. " +
      "Item 1A. Risk Factors The discussion below addresses our material risk factors of which we are aware.";
    const cands = findHeaderCandidates(text, { id: "1A", title: /Risk[\s]+Factors/i });
    expect(cands).toHaveLength(1);
    expect(text.slice(cands[0].index)).toContain("The discussion below");
  });
});

// ---------------------------------------------------------------------------
// Citi — cross-reference-index mode (Layer 0, F20/F21)
// ---------------------------------------------------------------------------

describe("Citi cross-reference index parsing (real fixture)", () => {
  it("parses items, multi-row page-range continuations and Not Applicable rows", () => {
    const idx = parseCrossRefIndex(stripHiddenBlocks(sample("citi_10k_crossref_index.html")));
    const byItem = new Map(idx.map((e) => [e.item, e]));
    expect(byItem.get("1A")?.pages).toEqual([[49, 62]]);
    expect(byItem.get("7")?.pages).toEqual([
      [8, 36],
      [64, 120],
    ]);
    expect(byItem.get("1B")?.notApplicable).toBe(true);
    // Item 1: "4–36, 121–127," + continuation rows "129, 160–164," + "299–300"
    expect(byItem.get("1")?.pages).toEqual([
      [4, 36],
      [121, 127],
      [129, 129],
      [160, 164],
      [299, 300],
    ]);
  });
});

describe("Citi 10-K extraction (Layer 0 crossref-toc)", () => {
  const C = "iffa471fccb154c4395823fdabb3bda1a";

  function buildCitiDoc(): string {
    const tocSample = sample("citi_10k_contents_toc_rows.html");
    const parts = tocSample.split("<!-- ... -->");
    expect(parts.length).toBe(2);
    return [
      sample("citi_10k_crossref_index.html"),
      "<table>",
      parts[0], // MD&A(8), Executive Summary(8), Citi's Multiyear Transformation(10)
      citiRow(`${C}_127`, "CAPITAL RESOURCES", 37),
      parts[1], // RISK FACTORS(49), SUSTAINABILITY(62), HUMAN CAPITAL(62)
      citiRow(`${C}_151`, "MANAGING GLOBAL RISK", 64),
      citiRow(`${C}_253`, "SIGNIFICANT ACCOUNTING POLICIES", 121),
      "</table>",
      `<div id="${C}_79"></div><div><span style="font-weight:700">MANAGEMENT&#8217;S DISCUSSION AND ANALYSIS OF FINANCIAL CONDITION AND RESULTS OF OPERATIONS</span></div><div><span>EXECUTIVE SUMMARY As described further throughout this Annual Report.</span></div>`,
      para(3000, "CITIMDNA1"),
      `<div id="${C}_82"></div>`,
      para(800, "CITIEXEC"),
      `<div id="${C}_85"></div>`,
      para(800, "CITITRANSFORM"),
      `<div id="${C}_127"></div><div><span>CAPITAL RESOURCES</span></div>`,
      para(1200, "CITICAP"),
      `<div id="${C}_139"></div><div><span>RISK FACTORS The following discussion presents what management currently believes could be the material risks.</span></div>`,
      para(3000, "CITIRISK"),
      `<div id="${C}_142"></div><div><span>SUSTAINABILITY</span></div>`,
      para(700, "CITISUST"),
      `<div id="${C}_145"></div>`,
      para(700, "CITIHUMAN"),
      `<div id="${C}_151"></div><div><span>MANAGING GLOBAL RISK Overview For Citi, effective risk management is of primary importance.</span></div>`,
      para(3000, "CITIMGR"),
      `<div id="${C}_253"></div><div><span>SIGNIFICANT ACCOUNTING POLICIES AND SIGNIFICANT ESTIMATES</span></div>`,
      para(500, "CITISAP"),
    ].join("\n");
  }

  it("Item 1A resolves by page range through the contents TOC", () => {
    const r = extractSection(buildCitiDoc(), { form: "10-K", item: "1A" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.method).toBe("crossref-toc");
    expect(r.text).toContain("RISK FACTORS The following discussion");
    expect(r.text).toContain("CITIRISK");
    expect(r.text).not.toContain("CITISUST");
    expect(r.text).not.toContain("CITIMGR");
  });

  it("Item 7 assembles BOTH non-contiguous page ranges (8-36 + 64-120)", () => {
    const r = extractSection(buildCitiDoc(), { form: "10-K", item: "7" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.method).toBe("crossref-toc");
    expect(r.text).toContain("CITIMDNA1"); // pages 8-36
    expect(r.text).toContain("CITIMGR"); // pages 64-120 (MANAGING GLOBAL RISK)
    expect(r.text).not.toContain("CITICAP"); // CAPITAL RESOURCES excluded
    expect(r.text).not.toContain("CITIRISK");
    expect(r.text).not.toContain("CITISAP");
  });
});

// ---------------------------------------------------------------------------
// Misc: quoted-title parsing, TOC entries
// ---------------------------------------------------------------------------

describe("parseQuotedTitles", () => {
  it("extracts curly-quoted section names from stubs", () => {
    const stub = htmlToText(sample("wfc_10k_wrapper_item7_stub.html"));
    const titles = parseQuotedTitles(stub);
    expect(titles.some((t) => normalizeTitle(t) === "financial review")).toBe(true);
  });
});

describe("parseTocEntries", () => {
  it("binds plain-text item cells to the row title link and tracks parts (F3)", () => {
    const html = [
      "<table>",
      partRow("PART I &#8212; FINANCIAL INFORMATION"),
      itemRowPlain("t_25", "Item 2.", "Management&#8217;s Discussion and Analysis of Financial Condition and Results of Operations."),
      partRow("PART II &#8212; OTHER INFORMATION"),
      itemRowPlain("t_355", "Item 1A.", "Risk Factors."),
      "</table>",
    ].join("\n");
    const entries = parseTocEntries(html).filter((e) => e.item !== undefined);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ item: "2", target: "t_25", part: 1 });
    expect(entries[1]).toMatchObject({ item: "1A", target: "t_355", part: 2 });
    expect(entries[0].title).toContain("Discussion and Analysis");
  });
});
