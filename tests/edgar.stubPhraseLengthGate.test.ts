import { describe, expect, it } from "vitest";

import { STUB_MIN_CHARS, detectStub } from "@/edgar/extract";

/**
 * Layer 3's incorporation-phrase test had no upper length bound, so it applied
 * to a section of ANY size. Real 10-K sections routinely open with a
 * cross-reference sentence — "should be read in conjunction with ... refer to
 * the information ... appearing on pages F-1" — and MD&A and Item 1A are the
 * two most likely to do so.
 *
 * Because the length leg above it already returns for anything under
 * STUB_MIN_CHARS, the phrase leg's ONLY reachable effect was on text that is
 * already long enough to be a real section. And a detected stub is a LOUD HARD
 * FAIL by design, so a correctly extracted 40,000-character MD&A was discarded
 * outright rather than returned.
 */
const INCORPORATION_OPENING =
  "The information required by this Item is incorporated by reference to the " +
  "information appearing on pages F-1 through F-40 of this Annual Report. ";

const prose = (chars: number): string => "Operating results improved materially. ".repeat(Math.ceil(chars / 39)).slice(0, chars);

describe("stub detection is bounded by length, not phrasing alone", () => {
  it("still flags a genuine short incorporation-by-reference stub", () => {
    const r = detectStub(INCORPORATION_OPENING + prose(200));

    expect(r.isStub).toBe(true);
  });

  it("still flags a medium wrapper stub that is mostly boilerplate", () => {
    const r = detectStub(INCORPORATION_OPENING + prose(3_000));

    expect(r.isStub).toBe(true);
    expect(r.reason).toMatch(/incorporation|cross-reference/i);
  });

  it("does NOT discard a full-length section that merely opens with a cross-reference", () => {
    // 40k chars — the module documents real sections as >= 18k.
    const r = detectStub(INCORPORATION_OPENING + prose(40_000));

    expect(r.isStub).toBe(false);
  });

  it("does not discard a full-length section opening with 'see ... on page'", () => {
    const r = detectStub(
      "See the consolidated financial statements on page 45 for further detail. " + prose(40_000),
    );

    expect(r.isStub).toBe(false);
  });

  it("keeps flagging anything below the minimum length regardless of phrasing", () => {
    const r = detectStub(prose(STUB_MIN_CHARS - 100));

    expect(r.isStub).toBe(true);
    expect(r.reason).toMatch(/chars/);
  });
});
