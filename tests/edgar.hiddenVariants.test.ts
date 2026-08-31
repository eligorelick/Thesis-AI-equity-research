import { describe, expect, it } from "vitest";

import { htmlToText, stripHiddenBlocks } from "@/edgar/extract";

/**
 * `stripHiddenBlocks` is the single boundary that removes visually hidden
 * markup before text extraction and section-heading selection. Its matcher only
 * recognized a double-quoted, all-lowercase `style="display:none"` on a tag
 * whose name had no namespace, so every other spelling a filer may emit left
 * hidden content in the extracted text — where it can be read as filing prose
 * or picked as a section heading.
 */
const visible = "VISIBLETEXT";
const hidden = "HIDDENTEXT";

const text = (html: string) => htmlToText(stripHiddenBlocks(html));

describe("stripHiddenBlocks recognizes every valid display:none spelling", () => {
  it("still removes the baseline double-quoted lowercase form", () => {
    const out = text(`<p>${visible}</p><div style="display:none">${hidden}</div>`);
    expect(out).toContain(visible);
    expect(out).not.toContain(hidden);
  });

  for (const [label, attr] of [
    ["single-quoted", `style='display:none'`],
    ["unquoted", `style=display:none`],
    ["uppercase attribute", `STYLE="display:none"`],
    ["uppercase value", `style="DISPLAY:NONE"`],
    ["mixed case", `style="Display:None"`],
    ["spaced around colon", `style="display : none"`],
    ["not the first declaration", `style="color:red; display:none;"`],
  ] as const) {
    it(`removes a ${label} hidden block`, () => {
      const out = text(`<p>${visible}</p><div ${attr}>${hidden}</div>`);
      expect(out).toContain(visible);
      expect(out).not.toContain(hidden);
    });
  }

  it("removes a hidden block on a namespaced iXBRL tag", () => {
    const out = text(
      `<p>${visible}</p><ix:nonFraction style="display:none">${hidden}</ix:nonFraction>`,
    );
    expect(out).toContain(visible);
    expect(out).not.toContain(hidden);
  });

  it("keeps visible content that merely contains the words display or none", () => {
    const prose = "The segment display was none too strong this quarter.";
    expect(text(`<p>${prose}</p>`)).toContain("none too strong");
  });

  it("does not treat an unrelated attribute ending in style as a hidden marker", () => {
    const out = text(`<div data-style="display:none">${visible}</div>`);
    expect(out).toContain(visible);
  });

  /**
   * `display` must START a declaration. A property that merely ENDS in it hides
   * nothing, and because the strip deletes through the matching close tag, a
   * false positive on a wrapper <div> would drop a whole visible section.
   */
  it.each([
    ["custom property", `style="--display:none"`],
    ["vendor-prefixed", `style="mso-display:none"`],
    ["prefixed after another declaration", `style="color:red;mso-display:none"`],
  ])("keeps visible content when a property merely ends in display (%s)", (_label, attr) => {
    const out = text(`<div ${attr}>${visible}</div>`);
    expect(out).toContain(visible);
  });

  it("still strips a real declaration that follows another one", () => {
    const out = text(`<p>${visible}</p><div style="color:red;display:none">${hidden}</div>`);
    expect(out).toContain(visible);
    expect(out).not.toContain(hidden);
  });
});
