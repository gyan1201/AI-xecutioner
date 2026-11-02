#!/usr/bin/env node
/**
 * Diff your account's live /v1/models against the curated catalog.
 *
 *   NVIDIA_API_KEY=nvapi-... node scripts/sync-models.mjs [--write]
 *
 * --write saves the raw payload to data/models.live.json so you can inspect it
 * offline. The running app does the same merge at runtime (Models → Sync live
 * catalog); this script is for CI and for seeing what is new before you look.
 *
 * Zero dependencies, no state beyond the optional file.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { paths, runtimeConfig } from "../server/config.mjs";
import { MODEL_CATALOG } from "../server/nim/catalog.mjs";

const args = new Set(process.argv.slice(2));
const config = runtimeConfig();

if (!config.apiKey) {
  console.error("No NVIDIA API key. Set NVIDIA_API_KEY (or add one in Settings) first.");
  console.error(`Base URL: ${config.baseUrl}`);
  process.exit(2);
}

const url = `${config.baseUrl.replace(/\/+$/, "")}/models`;
const started = Date.now();

let payload;
try {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    console.error(`GET ${url} → ${response.status} ${response.statusText}`);
    if (response.status === 401) console.error("NVIDIA rejected the key.");
    process.exit(1);
  }
  payload = await response.json();
} catch (error) {
  console.error(`Could not reach ${url}: ${error.message}`);
  console.error("This host may not have egress to the NVIDIA API; the app keeps working on the snapshot.");
  process.exit(1);
}

const live = Array.isArray(payload?.data) ? payload.data : [];
const liveIds = new Set(live.map((model) => model.id));
const curatedIds = new Set(MODEL_CATALOG.map((model) => model.id));

const added = [...liveIds].filter((id) => !curatedIds.has(id)).sort();
const missing = [...curatedIds].filter((id) => !liveIds.has(id)).sort();

console.log(`GET ${url} → ${live.length} models in ${Date.now() - started}ms`);
console.log(`curated catalog: ${curatedIds.size}`);
console.log(`new on this account (${added.length}):`);
for (const id of added) console.log(`  + ${id}`);
console.log(`in the catalog but not returned (${missing.length}):`);
for (const id of missing) console.log(`  - ${id}`);

if (args.has("--write")) {
  mkdirSync(paths.data, { recursive: true });
  const file = join(paths.data, "models.live.json");
  writeFileSync(file, `${JSON.stringify({ fetchedAt: new Date().toISOString(), baseUrl: config.baseUrl, count: live.length, data: live }, null, 2)}\n`);
  console.log(`\nwrote ${file}`);
}
