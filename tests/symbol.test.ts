import { describe, expect, it } from "vitest";

import * as symbolModule from "@/symbol";

type NormalizeSymbol = (raw: string) => string | null;

function helper(name: "normalizeSymbol" | "normalizeRouteSymbol"): NormalizeSymbol | undefined {
  const candidate = (symbolModule as Record<string, unknown>)[name];
  expect(candidate).toBeTypeOf("function");
  return typeof candidate === "function" ? (candidate as NormalizeSymbol) : undefined;
}

describe("symbol ingress normalization", () => {
  it.each([
    [" AAPL ", "AAPL"],
    ["aapl", "AAPL"],
    ["brk.b", "BRK.B"],
    ["bf-b", "BF-B"],
  ])("normalizes valid raw symbol %s", (raw, expected) => {
    expect(helper("normalizeSymbol")?.(raw)).toBe(expected);
  });

  it.each(["ß", "ſ", "ﬀ", "", "AAPL/US", ".AAPL"])(
    "rejects invalid raw symbol %s before case folding",
    (raw) => {
      expect(helper("normalizeSymbol")?.(raw)).toBeNull();
    },
  );

  it.each([
    ["aapl", "AAPL"],
    ["BRK.B", "BRK.B"],
    ["bf-b", "BF-B"],
  ])("normalizes already-decoded route symbol %s", (raw, expected) => {
    expect(helper("normalizeRouteSymbol")?.(raw)).toBe(expected);
  });

  it.each(["%", "%41APL", "ß", "ſ", "ﬀ"])(
    "rejects encoded residue or Unicode-expanding route param %s",
    (raw) => {
      expect(helper("normalizeRouteSymbol")?.(raw)).toBeNull();
    },
  );

  it("fails closed when canonicalizing or comparing invalid entity symbols", () => {
    expect(symbolModule.canonicalEntitySymbol("brk-b")).toBe("BRK.B");
    expect(symbolModule.canonicalEntitySymbol("ß")).toBeNull();
    expect(symbolModule.sameEntitySymbol("BRK.B", "brk-b")).toBe(true);
    for (const invalid of ["ß", "ſ", "ﬀ"]) {
      expect(symbolModule.sameEntitySymbol(invalid, invalid.toUpperCase())).toBe(false);
      expect(symbolModule.sameEntitySymbol(invalid.toUpperCase(), invalid)).toBe(false);
    }
  });
});
