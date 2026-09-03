/**
 * The README has to be true of the code. Three of its sections are generated,
 * and this proves the checked-in file still matches what the generators
 * produce; the rest is checked for the claims the 2026-09-02 audit found stale,
 * so a retired rule cannot quietly reappear. No network.
 */
import { existsSync, readFileSync } from "node:fs";
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
  it("stays short enough to be read", () => {
    expect(readme().trimEnd().split("\n").length).toBeLessThanOrEqual(250);
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
    for (const doc of ["docs/METHODOLOGY.md", "docs/PRIVACY.md", "docs/DATA-RIGHTS.md"]) {
      expect(text).toContain(doc);
    }
  });
});
