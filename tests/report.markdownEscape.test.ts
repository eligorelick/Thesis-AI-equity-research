import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  markdownBlockquote,
  markdownCodeSpan,
  markdownHeading,
  markdownListItem,
  markdownProse,
  markdownSourceLabel,
  markdownTable,
  markdownTableCell,
} from "@/report/export/markdownEscape";

function longestBacktickRun(value: string): number {
  return Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
}

/** Independent CommonMark 0.31.2 code-span decoder for generated spans. */
function decodeCodeSpan(span: string): { fence: number; value: string } {
  const opening = span.match(/^`+/)?.[0];
  expect(opening, span).toBeDefined();
  const fence = opening!.length;
  const closing = "`".repeat(fence);
  expect(span.endsWith(closing), span).toBe(true);
  expect(span.length).toBeGreaterThanOrEqual(fence * 2 + 1);
  let value = span.slice(fence, -fence).replace(/\r\n?|\n/g, " ");
  if (
    value.startsWith(" ") &&
    value.endsWith(" ") &&
    /[^ ]/.test(value)
  ) {
    value = value.slice(1, -1);
  }
  return { fence, value };
}

function activeTablePipes(line: string): number {
  let count = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "|") continue;
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) {
      slashes += 1;
    }
    if (slashes % 2 === 0) count += 1;
  }
  return count;
}

const INLINE_SERIALIZERS = [
  markdownProse,
  markdownHeading,
  markdownListItem,
  markdownBlockquote,
] as const;

function expectCanonicalAcrossEveryPublicApi(raw: string, expected: string): void {
  for (const serialize of [...INLINE_SERIALIZERS, markdownTableCell]) {
    expect(serialize(raw), serialize.name).toBe(expected);
  }
  for (const serialize of [markdownCodeSpan, markdownSourceLabel]) {
    expect(decodeCodeSpan(serialize(raw)).value, serialize.name).toBe(expected);
  }
}

describe("context-safe Markdown primitives", () => {
  it("is dependency-free and keeps template markers outside content serializers", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src", "report", "export", "markdownEscape.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(
      /^\s*export\s*(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\b/m,
    );
    expect(markdownHeading("heading")).toBe("heading");
    expect(markdownListItem("item")).toBe("item");
    expect(markdownBlockquote("quote")).toBe("quote");
    expect(markdownHeading("heading")).not.toMatch(/^#\s/);
    expect(markdownListItem("item")).not.toMatch(/^-\s/);
    expect(markdownBlockquote("quote")).not.toMatch(/^>\s/);
  });

  it("canonicalizes every supported line separator and horizontal control", () => {
    const raw = "A\r\nB\rC\nD\u0085E\u2028F\u2029G\tH\vI\fJ";
    expectCanonicalAcrossEveryPublicApi(raw, "A B C D E F G H I J");
  });

  it("makes C0/C1 controls, NUL, BOM, bidi controls, and lone surrogates visible", () => {
    const whitespace = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x85]);
    const controls = [
      ...Array.from({ length: 0x20 }, (_, code) => code),
      ...Array.from({ length: 0x21 }, (_, offset) => 0x7f + offset),
    ];
    for (const code of controls) {
      const rendered = markdownProse(String.fromCharCode(code));
      const expected = code === 0
        ? "\ufffd"
        : whitespace.has(code)
          ? " "
          : `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
      expect(rendered, `U+${code.toString(16).toUpperCase().padStart(4, "0")}`)
        .toBe(expected);
    }
    expect(markdownProse("AZaz09 :;,.!?/='\"")).toBe("AZaz09 :;,.!?/='\"");

    const bidi = [
      0x061c, 0x200e, 0x200f,
      0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
      0x2066, 0x2067, 0x2068, 0x2069,
      0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f,
    ];
    for (const code of [0xfeff, ...bidi]) {
      expect(markdownProse(String.fromCharCode(code))).toBe(
        `U+${code.toString(16).toUpperCase().padStart(4, "0")}`,
      );
    }
    expect(markdownProse("\ud800A\udc00")).toBe("U+D800AU+DC00");
    expect(markdownProse("😀 café e\u0301 東京 العربية")).toBe(
      "😀 café e\u0301 東京 العربية",
    );
    expectCanonicalAcrossEveryPublicApi(
      "A\u0000B�C\u0001D\u007fE\u009fF\ufeffG\u202eH\ud800I\udc00J😀 e\u0301",
      "A�B�CU+0001DU+007FEU+009FFU+FEFFGU+202EHU+D800IU+DC00J😀 e\u0301",
    );
  });

  it("neutralizes raw HTML, inline syntax, entities, links, images, and bare autolinks visibly", () => {
    const raw = String.raw`<script>&amp; *bold* _em_ ~~strike~~ [click](javascript:alert(1)) ![img](https://evil.test/x) #tag @user \\tail https://evil.test www.evil.test a@evil.test`;
    const expected = String.raw`\<script\>\&amp; \*bold\* \_em\_ \~\~strike\~\~ \[click\](javascript\:alert(1)) !\[img\](https\://evil.test/x) \#tag \@user \\\\tail https\://evil.test www\.evil.test a\@evil.test`;
    for (const serialize of [...INLINE_SERIALIZERS, markdownTableCell]) {
      const rendered = serialize(raw);
      expect(rendered).toBe(expected);
    }
    expect(markdownTable([raw], [[raw]])).toBe([
      `| ${expected} |`,
      "| --- |",
      `| ${expected} |`,
    ].join("\n"));
  });

  it.each([
    ["# injected", String.raw`\# injected`],
    ["> injected", String.raw`\> injected`],
    ["- injected", String.raw`\- injected`],
    ["+ injected", String.raw`\+ injected`],
    ["1. injected", String.raw`1\. injected`],
    ["1) injected", String.raw`1\) injected`],
    ["===", String.raw`\===`],
    ["---", String.raw`\---`],
    ["```js", String.raw`\`\`\`js`],
    ["~~~", String.raw`\~\~\~`],
    ["    indented code", "\u00a0   indented code"],
    ["[label]: https://evil.test", String.raw`\[label\]: https\://evil.test`],
    [" # injected", String.raw` \# injected`],
    ["  > injected", String.raw`  \> injected`],
    ["   - injected", String.raw`   \- injected`],
    ["\t+ injected", String.raw` \+ injected`],
    ["  42. injected", String.raw`  42\. injected`],
    ["999999999) injected", String.raw`999999999\) injected`],
    ["-", String.raw`\-`],
    ["+", String.raw`\+`],
    ["  2.", String.raw`  2\.`],
    ["   2)", String.raw`   2\)`],
    ["=", String.raw`\=`],
    ["  ==", String.raw`  \==`],
    [" -- --", String.raw` \-- --`],
    ["--", String.raw`\--`],
  ])("neutralizes a line-leading structural form %s", (raw, expected) => {
    for (const serialize of INLINE_SERIALIZERS) {
      expect(serialize(raw), serialize.name).toBe(expected);
    }
  });

  it("breaks extended autolinks after punctuation boundaries", () => {
    const raw = "_hTtPs://evil.test ~www.evil.test (mailto:x@evil.test) "
      + "ftp://evil.test DaTa:text/html,x vbscript:evil";
    const expected = String.raw`\_hTtPs\://evil.test \~www\.evil.test (mailto\:x\@evil.test) ftp\://evil.test DaTa\:text/html,x vbscript\:evil`;
    for (const serialize of [...INLINE_SERIALIZERS, markdownTableCell]) {
      expect(serialize(raw), serialize.name).toBe(expected);
    }
  });

  it("neutralizes a trailing-space hard break without losing visible spacing", () => {
    for (const serialize of INLINE_SERIALIZERS) {
      expect(serialize("visible  "), serialize.name).toBe("visible \u00a0");
      expect(serialize("visible\u00a0  "), serialize.name).toBe("visible\u00a0 \u00a0");
    }
    expect(markdownTableCell("visible  ")).toBe("visible");
  });

  it("escapes table pipes with correct original-backslash parity", () => {
    expect(markdownTableCell("  padded  ")).toBe("padded");
    for (let originals = 0; originals <= 4; originals += 1) {
      const rendered = markdownTableCell(`${"\\".repeat(originals)}|tail`);
      const match = rendered.match(/^(\\*)\|tail$/);
      expect(match, rendered).not.toBeNull();
      expect(match![1].length).toBe(originals * 2 + 1);
    }
    expect(markdownTableCell("A\r\nB\rC\nD\u0085E\u2028F\u2029G|H"))
      .toBe(String.raw`A B C D E F G\|H`);

    const combined = [0, 1, 2, 3, 4]
      .map((slashes) => `${"\\".repeat(slashes)}|p${slashes}`)
      .join(";");
    const pipeRuns = Array.from(markdownTableCell(combined).matchAll(/(\\*)\|p([0-4])/g));
    expect(pipeRuns).toHaveLength(5);
    for (const match of pipeRuns) {
      expect(match[1].length).toBe(Number(match[2]) * 2 + 1);
    }
  });

  it("builds a GFM table from raw cells exactly once and preserves column structure", () => {
    const headers = ["A|B", "Raw"];
    const rows = [[String.raw`\*left\|right`, "line1\r\nline2"]];
    const before = JSON.stringify({ headers, rows });
    const table = markdownTable(headers, rows);
    expect(table).toBe([
      String.raw`| A\|B | Raw |`,
      "| --- | --- |",
      String.raw`| \\\*left\\\|right | line1 line2 |`,
    ].join("\n"));
    for (const line of table.split("\n")) expect(activeTablePipes(line)).toBe(3);
    expect(JSON.stringify({ headers, rows })).toBe(before);
  });

  it("uses a longer code fence and CommonMark padding while preserving canonical raw content", () => {
    const cases = [
      "plain",
      "a`b",
      "a``b```c",
      "`boundary`",
      " leading",
      "trailing ",
      " both ",
      "   ",
      String.raw`\\path\\name`,
      "line1\r\nline2",
      `${"`".repeat(64)}long fence${"`".repeat(64)}`,
      "<script>javascript:alert(1)</script>",
    ];
    for (const raw of cases) {
      const rendered = markdownCodeSpan(raw);
      const decoded = decodeCodeSpan(rendered);
      expect(decoded.fence).toBeGreaterThan(longestBacktickRun(raw));
      expect(decoded.value).toBe(raw.replace(/\r\n?|\n|\u0085|\u2028|\u2029/g, " "));
    }
    expect(markdownCodeSpan("plain")).toBe("`plain`");
    expect(decodeCodeSpan(markdownCodeSpan(
      "A\u0085B\u2028C\u2029D\tE\vF\fG\u0001H\ufeffI\ud800J",
    )).value).toBe("A B C D E F GU+0001HU+FEFFIU+D800J");
    const empty = markdownCodeSpan("");
    const decodedEmpty = decodeCodeSpan(empty);
    expect(decodedEmpty.value.trim()).toBe("");
  });

  it("creates one inert source-label code span without prose re-escaping", () => {
    const raw = String.raw`src: <script> ` + "``inside``" + String.raw` \\ [x](javascript:1)`;
    const rendered = markdownSourceLabel(raw);
    const decoded = decodeCodeSpan(rendered);
    expect(decoded.value).toBe(raw);
    expect(decoded.fence).toBeGreaterThan(longestBacktickRun(raw));
    expect(longestBacktickRun(rendered.slice(decoded.fence, -decoded.fence)))
      .toBeLessThan(decoded.fence);
    expect(markdownSourceLabel("source id: abc")).toBe("`source id: abc`");
  });

  it("is deterministic, non-mutating, and explicitly raw-only rather than idempotent", () => {
    const raw = String.raw`\* raw \| text`;
    const before = raw;
    const once = markdownTableCell(raw);
    expect(once).toBe(String.raw`\\\* raw \\\| text`);
    expect(markdownTableCell(raw)).toBe(once);
    expect(markdownTableCell(once)).not.toBe(once);
    expect(raw).toBe(before);
  });
});
