#!/usr/bin/env node
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildConfig } from "../config-builder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function src(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

const resolved = buildConfig(
  {
    screeningSource: "gmgn",
    minMcap: 800_000,
    maxMcap: 5_000_000,
    minTvl: 20_000,
  },
  {},
  {
    apiKey: "test-key",
    limit: 25,
    enrichLimit: 3,
    requestDelayMs: 1200,
    maxRetries: 0,
    holdersLimit: 20,
    indicatorFilter: true,
  },
);

assert.strictEqual(resolved.screening.source, "gmgn", "screeningSource resolves to config.screening.source");
assert.strictEqual(resolved.gmgn.apiKey, "test-key", "gmgn-config api key has priority");
assert.strictEqual(resolved.gmgn.minMcap, 800_000, "GMGN defaults inherit main minMcap when unset");
assert.strictEqual(resolved.gmgn.maxMcap, 5_000_000, "GMGN defaults inherit main maxMcap when unset");
assert.strictEqual(resolved.gmgn.minTvl, 20_000, "GMGN defaults inherit main minTvl when unset");
assert.strictEqual(resolved.gmgn.enrichLimit, 3, "GMGN enrichLimit resolves from gmgn-config");
assert.strictEqual(resolved.gmgn.requestDelayMs, 1200, "GMGN request pacing resolves from gmgn-config");
assert.strictEqual(resolved.gmgn.maxRetries, 0, "GMGN defaults to no retry for shadow-safe probing");

const gmgnSource = src("tools/gmgn.js");
const screeningSource = src("tools/screening.js");
const chartSource = src("tools/chart-indicators.js");
const shadowScript = src("scripts/shadow-gmgn-discovery.js");

assert.ok(gmgnSource.includes("export async function discoverGmgnPools"), "GMGN discovery export exists");
assert.ok(gmgnSource.includes('"/v1/market/rank"'), "GMGN rank endpoint is wired");
assert.ok(gmgnSource.includes('"/v1/token/info"'), "GMGN token info endpoint is wired");
assert.ok(gmgnSource.includes("token_top_holders"), "GMGN holders endpoint is wired");
assert.ok(gmgnSource.includes("token_top_traders"), "GMGN traders endpoint is wired");
assert.ok(gmgnSource.includes('setDefaultResultOrder("ipv4first")'), "GMGN forces IPv4 first");
assert.ok(screeningSource.includes('String(config.screening.source || "meteora")'), "screening source switch is wired");
assert.ok(screeningSource.includes('source === "gmgn"'), "GMGN candidate source path is wired");
assert.ok(screeningSource.includes("stage_counts"), "GMGN stage counts are surfaced");
assert.ok(chartSource.includes('case "supertrend_or_rsi"'), "supertrend_or_rsi preset exists");
assert.ok(chartSource.includes('case "bb_plus_rsi"'), "bb_plus_rsi preset exists");
assert.ok(chartSource.includes('case "fibo_reclaim"'), "fibo_reclaim preset exists");
assert.ok(chartSource.includes('case "fibo_reject"'), "fibo_reject preset exists");
assert.ok(shadowScript.includes('live_entries_enabled: false'), "shadow script marks live entries disabled");
assert.ok(shadowScript.includes('runSource("meteora"'), "shadow script runs Meteora source");
assert.ok(shadowScript.includes('runSource("gmgn"'), "shadow script runs GMGN source");
assert.ok(!shadowScript.includes("deployPosition"), "shadow script does not import deployPosition");

console.log(JSON.stringify({
  success: true,
  screeningSource: resolved.screening.source,
  gmgn: {
    minMcap: resolved.gmgn.minMcap,
    maxMcap: resolved.gmgn.maxMcap,
    minTvl: resolved.gmgn.minTvl,
    enrichLimit: resolved.gmgn.enrichLimit,
    requestDelayMs: resolved.gmgn.requestDelayMs,
    maxRetries: resolved.gmgn.maxRetries,
  },
  sourceSafety: {
    discoveryExport: true,
    shadowScriptNoDeployImport: true,
    liveEntriesDisabled: true,
  },
}, null, 2));
