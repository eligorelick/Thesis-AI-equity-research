import { describe, expect, it } from "vitest";

import { normalizeTitle, parseQuotedTitles } from "@/edgar/extract";

/**
 * `parseQuotedTitles` feeds `buildSynonyms`, which gives stub-quoted titles
 * priority over the generic synonyms, and Route 1 of `extractFromExhibit`
 * selects its start entry with a substring test. A title truncated at an inner
 * apostrophe therefore becomes a short, high-priority substring matcher that
 * can select the wrong exhibit section.
 *
 * `decodeEntities` maps `&quot;` to `"` and `&apos;`/`&#39;` to `'`, so a
 * filing that quotes with double quotes and spells the possessive with a
 * straight apostrophe reaches this parser as pure ASCII.
 */
describe("parseQuotedTitles quote pairing", () => {
  it("keeps an ASCII-quoted title whole across an inner ASCII apostrophe", () => {
    const stub =
      'Information with respect to Item 7 is incorporated by reference from the section entitled ' +
      '"Management\'s Discussion and Analysis of Financial Condition and Results of Operations" ' +
      "of the Annual Report.";

    const titles = parseQuotedTitles(stub).map(normalizeTitle);

    expect(titles).toContain(
      "management's discussion and analysis of financial condition and results of operations",
    );
    expect(titles).not.toContain("management");
  });

  it("still reads curly-quoted titles", () => {
    const stub = "the section entitled “Management’s Discussion and Analysis” of the Annual Report.";

    expect(parseQuotedTitles(stub).map(normalizeTitle)).toContain(
      "management's discussion and analysis",
    );
  });

  it("reads a single-quoted title", () => {
    const stub = "the section entitled 'Financial Review' of the Annual Report.";

    expect(parseQuotedTitles(stub).map(normalizeTitle)).toContain("financial review");
  });

  it("does not invent a title from ordinary possessive apostrophes", () => {
    const stub =
      "The Company's results were presented at the shareholders' meeting and in the registrant's filing.";

    expect(parseQuotedTitles(stub)).toEqual([]);
  });
});
