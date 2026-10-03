/**
 * Pure-function coverage for scripts/models-refresh.mjs. The script's main()
 * only runs when invoked as the entry point, so importing it here performs no
 * network access; the merge and parse helpers get fixture inputs.
 */
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { MODEL_REGISTRY, parseModelRegistry } from "@/models/registry";

const SCRIPT = path.join(process.cwd(), "scripts", "models-refresh.mjs");

interface RefreshModule {
  htmlToText(html: string): string;
  parsePricingText(text: string, names: readonly string[]): { parsed: Record<string, Record<string, number>>; unparsed: string[] };
  mergeModelList(registry: unknown, api: Array<{ id: string; display_name?: string }>, today: string): { registry: typeof MODEL_REGISTRY; report: string[] };
  applyPricing(registry: unknown, parsed: Record<string, Record<string, number>>): { registry: typeof MODEL_REGISTRY; report: string[] };
  refreshRegistryFile(registryPath: string, api: Array<{ id: string; display_name: string }>, html: string, today: string, write: boolean): { registry: typeof MODEL_REGISTRY; report: string[] };
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

  it("maps explicit pricing headers despite sidebar names, descriptions and column order", async () => {
    const { parsePricingText, applyPricing } = await load();
    const html = `
      <nav>Claude Opus 5 Claude Sonnet 5 Claude Fable 5.1</nav>
      <table><thead><tr><th>Model</th><th colspan="2">Base tokens</th><th colspan="3">Prompt caching</th></tr>
      <tr><th>Name</th><th>Input</th><th>Output</th><th><button>5m writes</button></th><th>1h writes</th><th>Hits and refreshes</th></tr></thead><tbody>
      <tr><td><a>Claude Opus 5.5</a></td><td>$4</td><td>$20</td><td>$5</td><td>$8</td><td>$0.20</td></tr>
      <tr><th colspan="6">Additional models</th></tr>
      <tr><td><a>Claude Opus 5</a><span>Some description</span></td><td>$5 / MTok</td><td>$25 / MTok</td><td>$6.25 / MTok</td><td>$10 / MTok</td><td>$0.50 / MTok</td></tr>
      <tr><td>Claude Sonnet 5</td><td>$2</td></tr></tbody></table>`;
    const { parsed, unparsed } = parsePricingText(html, ["Claude Opus 5", "Claude Sonnet 5", "Claude Fable 5.1"]);
    expect(parsed["Claude Opus 5"]).toEqual({
      inputPerMTok: 5, cacheWrite5mPerMTok: 6.25, cacheWrite1hPerMTok: 10, cacheReadPerMTok: 0.5, outputPerMTok: 25,
    });
    expect(unparsed).toEqual([
      expect.stringContaining("Claude Sonnet 5:"),
      expect.stringContaining("Claude Fable 5.1: not found"),
    ]);

    const changed = applyPricing(clone(), { "Claude Opus 5": { ...parsed["Claude Opus 5"]!, outputPerMTok: 30 } });
    expect(changed.report).toEqual(["claude-opus-5: outputPerMTok 25 -> 30"]);
    expect(changed.registry.models.find((m) => m.id === "claude-opus-5")?.pricing.outputPerMTok).toBe(30);
    const unchanged = applyPricing(clone(), { "Claude Opus 5": parsed["Claude Opus 5"]! });
    expect(unchanged.report).toEqual([]);
  });

  it("rejects ambiguous rows, unrecognized headers and malformed price cells", async () => {
    const { parsePricingText } = await load();
    const headers = "<tr><th>Name</th><th>Input</th><th>Output</th><th>5m writes</th><th>1h writes</th><th>Hits and refreshes</th></tr>";
    const row = "<tr><td>Claude Opus 5</td><td>$5</td><td>$25</td><td>$6.25</td><td>$10</td><td>$0.50</td></tr>";
    for (const html of [
      `<table>${headers}${row}${row}</table>`,
      `<table>${headers.replace("Output", "Unknown column")}${row}</table>`,
      `<table>${headers}${row.replace("$25", "$25 or $30")}</table>`,
      `<table>${headers}${row.replace("$25", "$25,000")}</table>`,
    ]) {
      const result = parsePricingText(html, ["Claude Opus 5"]);
      expect(result.parsed).toEqual({});
      expect(result.unparsed).toHaveLength(1);
    }
  });

  it("refuses to write or restamp a registry when any required pricing row is missing", async () => {
    const { refreshRegistryFile } = await load();
    const dir = mkdtempSync(path.join(os.tmpdir(), "thesis-model-refresh-"));
    const registryPath = path.join(dir, "models.json");
    const original = JSON.stringify(clone());
    writeFileSync(registryPath, original);
    try {
      expect(() => refreshRegistryFile(registryPath, [], "<nav>Claude Opus 5</nav>", "2026-10-02", true)).toThrow(/pricing/i);
      expect(readFileSync(registryPath, "utf8")).toBe(original);
      const dryRun = refreshRegistryFile(registryPath, [], "<nav>Claude Opus 5</nav>", "2026-10-02", false);
      expect(dryRun.report.some((line) => line.startsWith("pricing:"))).toBe(true);
      expect(readFileSync(registryPath, "utf8")).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
