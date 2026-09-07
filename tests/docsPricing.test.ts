/**
 * The generated pricing block (scripts/docs-pricing.mjs). Pure functions only:
 * importing the script runs no main(), so nothing reads the README or the
 * network here.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { MODEL_REGISTRY, isHighOrAboveEffort } from "@/models/registry";
import { ANALYST_MAX_TOKENS, JUDGE_MAX_TOKENS } from "@/pipeline/stageC/passes";
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
  FIXTURE_RUN_EFFORT: string;
  outputCeilingTokens(model: unknown, pass: string, effort: string, sizing: unknown): number;
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
  isHighOrAboveEffort,
  analystMaxTokens: ANALYST_MAX_TOKENS,
  judgeMaxTokens: JUDGE_MAX_TOKENS,
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
    expect(block).toContain("not a measurement");
  });

  /**
   * Effort is the app's cost knob, and the block used to publish one figure for
   * every level. The ceiling a pass bills against doubles at `high`
   * (`effectiveMaxTokens`), so a `max` run on Fable 5.1 can emit $6.40 of output
   * per analyst request where `low` cannot pass $3.20 — the step that turned one
   * abandoned request into a $6.86 pass on 2026-09-03.
   */
  it("publishes the analyst output ceiling on both sides of the effort step", async () => {
    const { renderPricingBlock, outputCeilingTokens } = await load();
    const fable = MODEL_REGISTRY.models.find((m) => m.id === "claude-fable-5-1")!;
    const haiku = MODEL_REGISTRY.models.find((m) => m.id === "claude-haiku-4-5")!;

    // Below `high` the pass constant applies; at `high` and above, the ceiling.
    expect(outputCeilingTokens(fable, "bull", "medium", sizing)).toBe(ANALYST_MAX_TOKENS);
    expect(outputCeilingTokens(fable, "bull", "high", sizing)).toBe(fable.maxOutputTokens);
    expect(outputCeilingTokens(fable, "synthesize", "low", sizing)).toBe(JUDGE_MAX_TOKENS);
    // Haiku's own ceiling IS the analyst constant, so it has no step to show.
    expect(outputCeilingTokens(haiku, "bull", "max", sizing)).toBe(ANALYST_MAX_TOKENS);

    const block = renderPricingBlock(MODEL_REGISTRY, sizing);
    // 64K then 128K output at $50/MTok.
    expect(block).toContain("| Claude Fable 5.1 | $18.98 | $18.90 | $683.28 | $3.20 → $6.40 |");
    // 64K at $10/MTok, and no arrow: the step does not exist on this model.
    expect(block).toContain("| Claude Haiku 4.5 | $0.65 | $3.78 | $23.40 | $0.32 |");
    expect(block).toContain("does NOT scale with effort");
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
