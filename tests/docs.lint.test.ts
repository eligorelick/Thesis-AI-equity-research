/**
 * The README has to be true of the code. Three of its sections are generated,
 * and this proves the checked-in file still matches what the generators
 * produce; the rest is checked for the claims the 2026-09-02 audit found stale,
 * so a retired rule cannot quietly reappear. No network.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { MODEL_REGISTRY } from "@/models/registry";
import {
  PASS_MAX_REQUESTS,
  maximumRequestCostUsd,
  passWorstCaseCostUsd,
} from "@/providers/anthropic";

const ROOT = process.cwd();
const README = path.join(ROOT, "README.md");
const readme = (): string => readFileSync(README, "utf8");

async function loadConfigScript(): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(path.join(ROOT, "scripts", "docs-config.mjs")).href)) as Record<string, unknown>;
}

async function loadPricingScript(): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(path.join(ROOT, "scripts", "docs-pricing.mjs")).href)) as Record<string, unknown>;
}

function blockBetween(text: string, begin: string, end: string): string {
  const from = text.indexOf(begin);
  const to = text.indexOf(end);
  expect(from, `README is missing ${begin}`).toBeGreaterThanOrEqual(0);
  expect(to, `README is missing ${end}`).toBeGreaterThan(from);
  return text.slice(from, to + end.length);
}

describe("the README's generated blocks", () => {
  it("carries the configuration table the current .env.example and schema produce", async () => {
    const script = (await loadConfigScript()) as {
      parseEnvExample(text: string): unknown;
      envSchemaKeys(source: string): string[];
      renderConfigBlock(sections: unknown, keys: string[]): string;
      CONFIG_BEGIN: string;
      CONFIG_END: string;
    };
    const expected = script.renderConfigBlock(
      script.parseEnvExample(readFileSync(path.join(ROOT, ".env.example"), "utf8")),
      script.envSchemaKeys(readFileSync(path.join(ROOT, "src", "config", "env.ts"), "utf8")),
    );
    expect(blockBetween(readme(), script.CONFIG_BEGIN, script.CONFIG_END)).toBe(expected);
  });

  it("carries the commands table package.json produces", async () => {
    const script = (await loadConfigScript()) as {
      renderCommandsBlock(scripts: Record<string, string>): string;
      COMMANDS_BEGIN: string;
      COMMANDS_END: string;
    };
    const scripts = (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    }).scripts;
    expect(blockBetween(readme(), script.COMMANDS_BEGIN, script.COMMANDS_END)).toBe(
      script.renderCommandsBlock(scripts),
    );
  });

  it("carries the cost table the model registry and the reservation code produce", async () => {
    const script = (await loadPricingScript()) as {
      renderPricingBlock(registry: unknown, sizing: unknown): string;
      BEGIN_MARKER: string;
      END_MARKER: string;
    };
    const expected = script.renderPricingBlock(MODEL_REGISTRY, {
      maximumRequestCostUsd,
      passWorstCaseCostUsd,
      maxRequestsPerPass: PASS_MAX_REQUESTS,
    });
    expect(blockBetween(readme(), script.BEGIN_MARKER, script.END_MARKER)).toBe(expected);
  });
});

describe("the README's prose", () => {
  /**
   * A front door someone will actually read, not a manual.
   *
   * Raised from 250 to 260 on 2026-09-03 to make room for the handoff to
   * `docs/RESEARCH.md`, the forensic models' evidence base. The alternative was
   * to delete a true statement or compress prose until it read badly, and the
   * cap exists to keep the README readable — not to hold it at a round number.
   * It is still a hard cap: the next addition earns its space by removing
   * something, or moves the number again on the record, as this one did.
   */
  it("stays short enough to be read", () => {
    expect(readme().trimEnd().split("\n").length).toBeLessThanOrEqual(260);
  });

  it("links only to files that exist", () => {
    const links = [...readme().matchAll(/\]\((?!https?:|#|mailto:)([^)]+)\)/g)].map((match) => match[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const target = path.join(ROOT, link.split("#")[0]);
      expect(existsSync(target), `README links to ${link}, which does not exist`).toBe(true);
    }
  });

  it("does not restate a rule the remediation retired", () => {
    const text = readme();
    for (const retired of [
      "own-history multiple percentile",
      "lower of the three- and five-year",
      "108-request",
      "eight-digit dated snapshot",
      "Node.js 20 reached end-of-life",
    ]) {
      expect(text, `README still says "${retired}"`).not.toContain(retired);
    }
  });

  it("names every document it is meant to hand off to", () => {
    const text = readme();
    for (const doc of ["docs/METHODOLOGY.md", "docs/PRIVACY.md", "docs/DATA-RIGHTS.md", "docs/RESEARCH.md"]) {
      expect(text).toContain(doc);
    }
  });
});

/**
 * Every relative link in every shipped document resolves.
 *
 * The README already had this check; the other fifteen documents did not, and
 * two links in a handoff note pointed at paths that only resolve from the
 * repository root — a reader clicking them from `docs/audit/` got a 404.
 */
describe("relative links in the documentation", () => {
  /**
   * Markdown link targets, ignoring fenced blocks and inline code spans.
   * Quoted link SOURCE (`` `[text](path)` ``) is not a link a reader can click,
   * and the handoff notes quote README markdown deliberately.
   */
  function relativeLinks(markdown: string): string[] {
    const prose = markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
    return [...prose.matchAll(/\]\((?!https?:|#|mailto:)([^)]+)\)/g)]
      .map((match) => match[1]!.split("#")[0]!)
      .filter((target) => target.length > 0);
  }

  function shippedDocs(): string[] {
    const docs = ["README.md", "CHANGELOG.md"];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else if (entry.name.endsWith(".md")) docs.push(rel);
      }
    };
    walk("docs");
    return docs;
  }

  it("resolves from the file the link is written in", () => {
    const docs = shippedDocs();
    expect(docs.length).toBeGreaterThan(10);
    for (const doc of docs) {
      for (const link of relativeLinks(readFileSync(path.join(ROOT, doc), "utf8"))) {
        const target = path.resolve(path.dirname(path.join(ROOT, doc)), link);
        expect(existsSync(target), `${doc} links to ${link}, which does not resolve from there`).toBe(true);
      }
    }
  });

  it("hands the reader on to the evidence base from the methodology", () => {
    // METHODOLOGY states the conventions; RESEARCH says where they come from.
    // A reader who wants to check a coefficient should not have to guess.
    expect(readFileSync(path.join(ROOT, "docs", "METHODOLOGY.md"), "utf8")).toContain("RESEARCH.md");
  });
});

/**
 * The forensic code cites its evidence base by section — `research §2.5`, and
 * eighteen others. For months no such document existed in the repository, so a
 * reader auditing a coefficient had nowhere to go and the citations could say
 * anything. This asserts each one lands on a real heading of docs/RESEARCH.md.
 */
describe("the research citations in the source", () => {
  const research = (): string => readFileSync(path.join(ROOT, "docs", "RESEARCH.md"), "utf8");

  /** Every `research §N` / `§N.M` / `§N.M–N.M` cited anywhere under src/. */
  function citedSections(): string[] {
    const cited = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) {
          const text = readFileSync(full, "utf8");
          for (const match of text.matchAll(/research §([0-9]+(?:\.[0-9]+)?)(?:\s*[–-]\s*([0-9]+(?:\.[0-9]+)?))?/g)) {
            cited.add(match[1]!);
            // A range cites its endpoints AND everything between: "§1.1–1.3"
            // must not pass while §1.2 is missing.
            if (match[2] !== undefined) {
              const [from, to] = [Number(match[1]), Number(match[2])];
              const major = Math.trunc(from);
              for (let minor = Math.round(from * 10); minor <= Math.round(to * 10); minor++) {
                cited.add(minor % 10 === 0 ? String(major) : (minor / 10).toFixed(1));
              }
            }
          }
        }
      }
    };
    walk(path.join(ROOT, "src"));
    return [...cited].sort();
  }

  /** Section numbers docs/RESEARCH.md actually defines, from its headings. */
  function definedSections(): Set<string> {
    return new Set(
      [...research().matchAll(/^#{2,3} ([0-9]+(?:\.[0-9]+)?)[.\s]/gm)].map((match) => match[1]!),
    );
  }

  it("cites at least the sections the forensic models need", () => {
    const cited = citedSections();
    expect(cited.length).toBeGreaterThanOrEqual(15);
    // The four models and the applicability limits are the load-bearing ones.
    for (const section of ["1", "2.4", "4.3", "6.3"]) expect(cited).toContain(section);
  });

  it("resolves every cited section to a heading in docs/RESEARCH.md", () => {
    const defined = definedSections();
    for (const section of citedSections()) {
      expect(defined.has(section), `src cites research §${section}, which docs/RESEARCH.md does not define`).toBe(true);
    }
  });

  it("separates published findings from house rules on every model", () => {
    const text = research();
    // The distinction is the document's whole point: a reader must be able to
    // tell a coefficient from the original paper apart from a display band this
    // project chose. Both labels appear, and the legend explaining them does.
    expect(text).toContain("**Published");
    expect(text).toContain("**House rule");
    expect(text).toContain("**Resolved ambiguity");
    // The Beneish transcription error is the one a reader is most likely to
    // "correct" back to the wrong value.
    expect(text).toContain("4.679");
    expect(text).toContain("4.697");
  });
});
