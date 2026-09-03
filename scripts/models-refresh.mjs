/**
 * Rebuild config/models.json from the Anthropic Models API and the public
 * pricing page.
 *
 *   npm run models:refresh            # dry run: prints the proposed changes
 *   npm run models:refresh -- --write # writes config/models.json
 *
 * Needs ANTHROPIC_API_KEY (the Models API is free; no message is sent). The
 * script never runs from tests; tests import its pure functions with fixture
 * inputs. Context windows, output ceilings, effort/sampling/thinking support
 * and lifecycle are not served by the API: the script keeps the checked-in
 * values and prints a reminder to review them against the models overview
 * page whenever a new id appears.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REGISTRY_PATH = path.join(HERE, "..", "config", "models.json");
export const MODELS_URL = "https://api.anthropic.com/v1/models";
export const PRICING_URL = "https://docs.anthropic.com/en/docs/about-claude/pricing";
export const ANTHROPIC_VERSION = "2023-06-01";

/** Pricing-page column order: base input, 5m cache write, 1h cache write, cache read, output. */
const PRICING_COLUMNS = ["inputPerMTok", "cacheWrite5mPerMTok", "cacheWrite1hPerMTok", "cacheReadPerMTok", "outputPerMTok"];

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
 * Find the five dollar figures that follow each display name in the pricing
 * text. Returns { [displayName]: pricing } for names that yielded exactly the
 * expected columns and lists the rest in `unparsed`.
 */
export function parsePricingText(text, displayNames) {
  const parsed = {};
  const unparsed = [];
  for (const name of displayNames) {
    const at = text.indexOf(name);
    if (at < 0) {
      unparsed.push(`${name}: not found on the pricing page`);
      continue;
    }
    const window = text.slice(at + name.length, at + name.length + 400);
    const amounts = [...window.matchAll(/\$\s?(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    if (amounts.length < PRICING_COLUMNS.length) {
      unparsed.push(`${name}: found ${amounts.length} dollar figures, expected ${PRICING_COLUMNS.length}`);
      continue;
    }
    const pricing = {};
    PRICING_COLUMNS.forEach((column, index) => {
      pricing[column] = amounts[index];
    });
    parsed[name] = pricing;
  }
  return { parsed, unparsed };
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
  const write = argv.includes("--write");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is required (the Models API is free; no message is sent).");
    return 2;
  }
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  const today = new Date().toISOString().slice(0, 10);

  const apiModels = await fetchAllModels(apiKey);
  const merged = mergeModelList(registry, apiModels, today);

  const pricingResponse = await fetch(PRICING_URL);
  if (!pricingResponse.ok) {
    throw new Error(`${PRICING_URL} responded ${pricingResponse.status}`);
  }
  const pricingText = htmlToText(await pricingResponse.text());
  const { parsed, unparsed } = parsePricingText(pricingText, merged.registry.models.map((m) => m.displayName));
  const priced = applyPricing(merged.registry, parsed);

  const report = [...merged.report, ...priced.report, ...unparsed.map((line) => `pricing: ${line}`)];
  console.log(`models:refresh — snapshot ${today}`);
  for (const line of report) console.log(`  ${line}`);
  if (report.length === 0) console.log("  no changes");
  console.log("  review context windows, output ceilings, effort/sampling/thinking support and lifecycle by hand; the API does not serve them.");

  if (write) {
    writeFileSync(REGISTRY_PATH, `${JSON.stringify(priced.registry, null, 2)}\n`, "utf8");
    console.log(`  wrote ${REGISTRY_PATH}`);
  } else {
    console.log("  dry run — pass --write to update config/models.json");
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
