/**
 * The generated pricing block (scripts/docs-pricing.mjs). Pure functions only:
 * importing the script runs no main(), so nothing reads the README or the
 * network here.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { MODEL_REGISTRY } from "@/models/registry";
import {
  PASS_MAX_REQUESTS,
  maximumRequestCostUsd,
  passWorstCaseCostUsd,
} from "@/providers/anthropic";

const SCRIPT = path.join(process.cwd(), "scripts", "docs-pricing.mjs");

interface PricingModule {
  BEGIN_MARKER: string;
  END_MARKER: string;
  FIXTURE_RUN_SHAPE: { passes: Array<{ pass: string }> };
  estimateRunCostUsd(model: unknown, judge: unknown, searchUsd: number): number;
  renderPricingBlock(registry: unknown, sizing: unknown): string;
  replaceBlock(readme: string, block: string): string;
}

async function load(): Promise<PricingModule> {
  return (await import(pathToFileURL(SCRIPT).href)) as PricingModule;
}

const sizing = {
  maximumRequestCostUsd,
  passWorstCaseCostUsd,
  maxRequestsPerPass: PASS_MAX_REQUESTS,
};

describe("generated pricing block", () => {
  it("renders one row per active model with the request bound, the worst case and an estimate", async () => {
    const { renderPricingBlock, BEGIN_MARKER, END_MARKER } = await load();
    const block = renderPricingBlock(MODEL_REGISTRY, sizing);

    expect(block.startsWith(BEGIN_MARKER)).toBe(true);
    expect(block.trimEnd().endsWith(END_MARKER)).toBe(true);
    expect(block).toContain(`Registry snapshot ${MODEL_REGISTRY.snapshotDate}`);
    for (const model of MODEL_REGISTRY.models.filter((m) => m.lifecycle === "active")) {
      expect(block).toContain(`| ${model.displayName} |`);
    }
    // Sonnet 5: one analyst request is $3.86 and the pass worst case $138.96.
    expect(block).toMatch(/\| Claude Sonnet 5 \| \$3\.86 \| \$3\.78 \| \$138\.96 \| \$\d/);
    // Haiku's synthesize figure is Sonnet 5's, because that pass is floored.
    expect(block).toMatch(/\| Claude Haiku 4\.5 \| \$0\.65 \| \$3\.78 \|/);
    expect(block).toContain(`(${PASS_MAX_REQUESTS}: six transport`);
    expect(block).toContain("reported, not");
    expect(block).toContain("a calculation, not a measurement");
  });

  it("prices the fixture run shape from the registry, cache reads included", async () => {
    const { estimateRunCostUsd, FIXTURE_RUN_SHAPE } = await load();
    const sonnet = MODEL_REGISTRY.models.find((m) => m.id === "claude-sonnet-5")!;
    const haiku = MODEL_REGISTRY.models.find((m) => m.id === "claude-haiku-4-5")!;
    expect(FIXTURE_RUN_SHAPE.passes.map((p) => p.pass)).toEqual(["bull", "bear", "synthesize"]);

    const sonnetRun = estimateRunCostUsd(sonnet, sonnet, 0.01);
    const haikuRun = estimateRunCostUsd(haiku, sonnet, 0.01);
    expect(sonnetRun).toBeGreaterThan(0);
    // A Haiku run costs less than a Sonnet one, but not proportionally: its
    // judge pass runs on Sonnet 5.
    expect(haikuRun).toBeLessThan(sonnetRun);
    expect(haikuRun).toBeGreaterThan(estimateRunCostUsd(haiku, haiku, 0.01));
    // Every run is far below one request's reservation bound.
    expect(sonnetRun).toBeLessThan(maximumRequestCostUsd("claude-sonnet-5", "bull"));
  });

  it("replaces only the marked block and refuses a README without markers", async () => {
    const { renderPricingBlock, replaceBlock, BEGIN_MARKER, END_MARKER } = await load();
    const block = renderPricingBlock(MODEL_REGISTRY, sizing);
    const readme = `# Thesis\n\nbefore\n\n${BEGIN_MARKER}\nstale table\n${END_MARKER}\n\nafter\n`;

    const rewritten = replaceBlock(readme, block);
    expect(rewritten.startsWith("# Thesis\n\nbefore\n\n")).toBe(true);
    expect(rewritten.endsWith("\n\nafter\n")).toBe(true);
    expect(rewritten).not.toContain("stale table");
    expect(replaceBlock(rewritten, block)).toBe(rewritten);

    expect(() => replaceBlock("# Thesis\n", block)).toThrow(/missing the/);
  });
});
