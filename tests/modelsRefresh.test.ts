/**
 * Pure-function coverage for scripts/models-refresh.mjs. The script's main()
 * only runs when invoked as the entry point, so importing it here performs no
 * network access; the merge and parse helpers get fixture inputs.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { MODEL_REGISTRY, parseModelRegistry } from "@/models/registry";

const SCRIPT = path.join(process.cwd(), "scripts", "models-refresh.mjs");

interface RefreshModule {
  htmlToText(html: string): string;
  parsePricingText(text: string, names: readonly string[]): { parsed: Record<string, Record<string, number>>; unparsed: string[] };
  mergeModelList(registry: unknown, api: Array<{ id: string; display_name?: string }>, today: string): { registry: typeof MODEL_REGISTRY; report: string[] };
  applyPricing(registry: unknown, parsed: Record<string, Record<string, number>>): { registry: typeof MODEL_REGISTRY; report: string[] };
}

async function load(): Promise<RefreshModule> {
  return (await import(pathToFileURL(SCRIPT).href)) as RefreshModule;
}

const clone = () => JSON.parse(JSON.stringify(MODEL_REGISTRY)) as typeof MODEL_REGISTRY;

describe("models-refresh helpers", () => {
  it("syncs display names, flags unlisted and unknown ids, and stamps the snapshot date", async () => {
    const { mergeModelList } = await load();
    const api = [
      { id: "claude-opus-5", display_name: "Claude Opus 5" },
      { id: "claude-sonnet-5", display_name: "Claude Sonnet 5 (renamed)" },
      { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5" },
      { id: "claude-newmodel-6", display_name: "Claude Newmodel 6" },
    ];
    const { registry, report } = mergeModelList(clone(), api, "2027-01-15");
    expect(registry.snapshotDate).toBe("2027-01-15");
    expect(registry.models.find((m) => m.id === "claude-sonnet-5")?.displayName).toBe("Claude Sonnet 5 (renamed)");
    expect(report).toContainEqual(expect.stringContaining("claude-fable-5-1: not listed"));
    expect(report).toContainEqual(expect.stringContaining("claude-newmodel-6: listed by the API but not in the registry"));
    expect(report.some((line) => line.startsWith("claude-haiku-4-5-20251001:"))).toBe(false);
    // The merged document is still a valid registry.
    expect(() => parseModelRegistry(registry)).not.toThrow();
  });

  it("parses the five pricing columns that follow a display name and reports the rest", async () => {
    const { htmlToText, parsePricingText, applyPricing } = await load();
    const html = `
      <table><tr><td>Claude Opus 5</td><td>$5 / MTok</td><td>$6.25 / MTok</td><td>$10 / MTok</td><td>$0.50 / MTok</td><td>$25 / MTok</td></tr>
      <tr><td>Claude Sonnet 5</td><td>$2</td></tr></table>`;
    const text = htmlToText(html);
    const { parsed, unparsed } = parsePricingText(text, ["Claude Opus 5", "Claude Sonnet 5", "Claude Fable 5.1"]);
    expect(parsed["Claude Opus 5"]).toEqual({
      inputPerMTok: 5, cacheWrite5mPerMTok: 6.25, cacheWrite1hPerMTok: 10, cacheReadPerMTok: 0.5, outputPerMTok: 25,
    });
    expect(unparsed).toEqual([
      expect.stringContaining("Claude Sonnet 5: found 1 dollar figures"),
      expect.stringContaining("Claude Fable 5.1: not found"),
    ]);

    const changed = applyPricing(clone(), { "Claude Opus 5": { ...parsed["Claude Opus 5"]!, outputPerMTok: 30 } });
    expect(changed.report).toEqual(["claude-opus-5: outputPerMTok 25 -> 30"]);
    expect(changed.registry.models.find((m) => m.id === "claude-opus-5")?.pricing.outputPerMTok).toBe(30);
    const unchanged = applyPricing(clone(), { "Claude Opus 5": parsed["Claude Opus 5"]! });
    expect(unchanged.report).toEqual([]);
  });
});
