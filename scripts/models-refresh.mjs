/**
 * Rebuild config/models.json from the Anthropic Models API and the public
 * pricing page.
 *
 *   npm run models:refresh            # dry run: prints the proposed changes
 *   npm run models:refresh -- --write # writes config/models.json
 *
 * Needs ANTHROPIC_API_KEY (the Models API is free; no message is sent). The
 * tests use fixture inputs and intercept CLI provider reads. The Models API
 * now exposes token limits and capabilities, but this
 * script keeps the checked-in limits and request policy. Review those fields
 * against the Models API and model guides whenever a new id appears.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isEntryPoint } from "./lib/entrypoint.mjs";
import { loadMaintenanceEnv } from "./lib/load-env.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REGISTRY_PATH = path.join(HERE, "..", "config", "models.json");
export const MODELS_URL = "https://api.anthropic.com/v1/models";
export const PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing";
export const ANTHROPIC_VERSION = "2023-06-01";

/** Registry price fields; HTML table headers determine their column positions. */
const PRICING_COLUMNS = ["inputPerMTok", "cacheWrite5mPerMTok", "cacheWrite1hPerMTok", "cacheReadPerMTok", "outputPerMTok"];
const PRICING_HEADERS = {
  name: "name",
  input: "inputPerMTok",
  output: "outputPerMTok",
  "5m writes": "cacheWrite5mPerMTok",
  "1h writes": "cacheWrite1hPerMTok",
  "hits and refreshes": "cacheReadPerMTok",
};

/** Collapse an HTML document to whitespace-normalized text. */
export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Read named rows only from HTML tables with all six explicit pricing headers.
 * Sidebar mentions and similarly named models cannot supply another row's
 * prices. Duplicate rows, missing columns and ambiguous cells fail closed.
 */
export function parsePricingText(html, displayNames) {
  const parsed = {};
  const unparsed = [];
  const candidates = new Map(displayNames.map((name) => [name, []]));
  for (const table of html.match(/<table\b[\s\S]*?<\/table>/gi) ?? []) {
    let columns;
    for (const row of table.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
      const headers = [...row.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)];
      if (headers.length > 0) {
        const mapped = headers.map((cell) => PRICING_HEADERS[htmlToText(cell[1]).toLowerCase()]);
        // Group headings such as "Additional models" do not replace the columns.
        if (mapped.length === 6) columns = new Set(mapped).size === 6 && mapped.every(Boolean)
          ? mapped : undefined;
        continue;
      }
      if (columns === undefined) continue;
      const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cell[1]);
      const nameCell = cells[columns.indexOf("name")];
      if (nameCell === undefined) continue;
      const link = /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(nameCell);
      const name = htmlToText(link ? link[1] : nameCell);
      const rows = candidates.get(name);
      if (rows === undefined) continue;
      const pricing = {};
      let valid = cells.length === columns.length;
      for (const field of PRICING_COLUMNS) {
        const price = /^\$\s?(\d+(?:\.\d+)?)(?:\s*\/\s*MTok)?$/.exec(htmlToText(cells[columns.indexOf(field)] ?? ""));
        const amount = price === null ? NaN : Number(price[1]);
        if (!Number.isFinite(amount) || amount <= 0) valid = false;
        pricing[field] = amount;
      }
      rows.push(valid ? pricing : null);
    }
  }
  for (const name of displayNames) {
    const rows = candidates.get(name);
    if (rows.length === 0) unparsed.push(`${name}: not found in a recognized pricing table`);
    else if (rows.length !== 1 || rows[0] === null) unparsed.push(`${name}: ambiguous or incomplete pricing row`);
    else parsed[name] = rows[0];
  }
  return { parsed, unparsed };
}

/** Prepare a refresh, and write only when every registry entry has valid prices. */
export function refreshRegistryFile(registryPath, apiModels, pricingHtml, today, write) {
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  const merged = mergeModelList(registry, apiModels, today);
  const { parsed, unparsed } = parsePricingText(pricingHtml, merged.registry.models.map((model) => model.displayName));
  const priced = applyPricing(merged.registry, parsed);
  const report = [...merged.report, ...priced.report, ...unparsed.map((line) => `pricing: ${line}`)];
  if (write) {
    if (unparsed.length > 0) throw new Error(`Refusing to write incomplete pricing: ${unparsed.join("; ")}`);
    writeFileSync(registryPath, `${JSON.stringify(priced.registry, null, 2)}\n`, "utf8");
  }
  return { registry: priced.registry, report };
}

/**
 * Merge the Models API listing into the registry: sync display names, flag
 * registry ids the API no longer lists, and list API ids the registry does
 * not know. Never invents context, output, or price data.
 */
export function mergeModelList(registry, apiModels, today) {
  const report = [];
  const apiById = new Map(apiModels.map((m) => [m.id, m]));
  const next = {
    ...registry,
    snapshotDate: today,
    models: registry.models.map((model) => {
      const listed = apiById.get(model.id);
      if (listed === undefined) {
        report.push(`${model.id}: not listed by ${MODELS_URL}; lifecycle "${model.lifecycle}" kept — check the deprecations page`);
        return model;
      }
      if (typeof listed.display_name === "string" && listed.display_name !== model.displayName) {
        report.push(`${model.id}: displayName "${model.displayName}" -> "${listed.display_name}"`);
        return { ...model, displayName: listed.display_name };
      }
      return model;
    }),
  };
  const known = new Set(registry.models.flatMap((m) => [m.id, ...m.datedSnapshotIds]));
  for (const api of apiModels) {
    if (typeof api.id === "string" && api.id.startsWith("claude-") && !known.has(api.id)) {
      report.push(`${api.id}: listed by the API but not in the registry — add an entry by hand (context, output, effort, sampling, thinking, prices)`);
    }
  }
  return { registry: next, report };
}

/** Apply parsed pricing rows (keyed by display name) to matching registry entries. */
export function applyPricing(registry, parsedByDisplayName) {
  const report = [];
  const models = registry.models.map((model) => {
    const row = parsedByDisplayName[model.displayName];
    if (row === undefined) return model;
    const changed = PRICING_COLUMNS.filter((column) => model.pricing[column] !== row[column]);
    if (changed.length === 0) return model;
    for (const column of changed) {
      report.push(`${model.id}: ${column} ${model.pricing[column]} -> ${row[column]}`);
    }
    return { ...model, pricing: { ...model.pricing, ...row } };
  });
  return { registry: { ...registry, models }, report };
}

async function fetchAllModels(apiKey) {
  const models = [];
  let afterId;
  for (;;) {
    const url = new URL(MODELS_URL);
    url.searchParams.set("limit", "100");
    if (afterId !== undefined) url.searchParams.set("after_id", afterId);
    const response = await fetch(url, {
      headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
    });
    if (!response.ok) {
      throw new Error(`${MODELS_URL} responded ${response.status}`);
    }
    const page = await response.json();
    models.push(...(page.data ?? []));
    if (page.has_more !== true || typeof page.last_id !== "string") break;
    afterId = page.last_id;
  }
  return models;
}

async function main(argv) {
  loadMaintenanceEnv();
  const write = argv.includes("--write");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is required (the Models API is free; no message is sent).");
    return 2;
  }
  const today = new Date().toISOString().slice(0, 10);

  const apiModels = await fetchAllModels(apiKey);

  const pricingResponse = await fetch(PRICING_URL);
  if (!pricingResponse.ok) {
    throw new Error(`${PRICING_URL} responded ${pricingResponse.status}`);
  }
  const { report } = refreshRegistryFile(REGISTRY_PATH, apiModels, await pricingResponse.text(), today, write);
  console.log(`models:refresh — snapshot ${today}`);
  for (const line of report) console.log(`  ${line}`);
  if (report.length === 0) console.log("  no changes");
  console.log("  review registry limits and request policy against the Models API capabilities, model guides and lifecycle documentation.");

  if (write) {
    console.log(`  wrote ${REGISTRY_PATH}`);
  } else {
    console.log("  dry run — pass --write to update config/models.json");
  }
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
