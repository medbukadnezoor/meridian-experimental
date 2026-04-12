#!/usr/bin/env node
/**
 * config-check.js — Config drift detector
 *
 * Compares user-config.json (live) against user-config.example.json (canonical reference).
 * Reports any keys that exist in one but not the other, or have different values.
 * Secret keys are skipped in the diff (they are expected to differ).
 *
 * Usage:
 *   node scripts/config-check.js             # from project root, local or VPS
 *   ssh ohox "cd ~/meridian && node scripts/config-check.js"
 *
 * Exit code 0 = clean, 1 = drift detected.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// Keys that are expected to differ (secrets or runtime-mutated by the bot)
const SKIP = new Set([
  "rpcUrl", "walletKey",
  "llmApiKey", "screeningApiKey", "managementApiKey", "generalApiKey",
  "hiveMindApiKey", "publicApiKey", "agentMeridianApiKey",
  "telegramToken", "telegramChatId",
  "agentId",
  // Runtime keys written by bot — not user intent
  "_lastAgentTune", "_lastEvolved", "_positionsAtEvolution",
  "llmProvider",
  // Internal note field in example
  "_note",
]);

function isSecret(key) {
  const last = key.split(".").pop();
  return SKIP.has(last) || last.endsWith("ApiKey") || last.endsWith("Key") ||
         last.endsWith("Secret") || last.endsWith("Token") || last === "rpcUrl" || last === "walletKey";
}

/** Flatten a nested object to dot-notation keys */
function flatten(obj, prefix = "") {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(out, flatten(v, full));
    } else {
      out[full] = v;
    }
  }
  return out;
}

// ── Load files ──────────────────────────────────────────────────────────────

const livePath    = path.join(ROOT, "user-config.json");
const examplePath = path.join(ROOT, "user-config.example.json");

if (!fs.existsSync(livePath)) {
  console.error("❌  user-config.json not found — run from project root.");
  process.exit(1);
}
if (!fs.existsSync(examplePath)) {
  console.error("❌  user-config.example.json not found.");
  process.exit(1);
}

const live    = flatten(JSON.parse(fs.readFileSync(livePath,    "utf8")));
const example = flatten(JSON.parse(fs.readFileSync(examplePath, "utf8")));

// ── Diff ─────────────────────────────────────────────────────────────────────

const drifted   = [];
const extraLive = [];

for (const [key, exVal] of Object.entries(example)) {
  if (isSecret(key)) continue;
  if (!(key in live)) {
    drifted.push({ type: "MISSING_IN_LIVE", key, example: exVal, live: undefined });
  } else if (JSON.stringify(live[key]) !== JSON.stringify(exVal)) {
    drifted.push({ type: "DRIFT", key, example: exVal, live: live[key] });
  }
}

for (const key of Object.keys(live)) {
  if (isSecret(key)) continue;
  if (!(key in example)) {
    extraLive.push({ key, live: live[key] });
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

console.log("── Config drift report (live vs user-config.example.json) ───────────────");

if (drifted.length === 0 && extraLive.length === 0) {
  console.log("✅  No drift. Live config matches user-config.example.json.\n");
  process.exit(0);
}

if (drifted.length > 0) {
  console.log(`\n⚠️  ${drifted.length} value(s) differ from example:\n`);
  for (const { type, key, example: ex, live: lv } of drifted) {
    if (type === "MISSING_IN_LIVE") {
      console.log(`  ❌ MISSING  ${key}  (example wants: ${JSON.stringify(ex)})`);
    } else {
      console.log(`  ⚠  DRIFT    ${key}`);
      console.log(`               live:    ${JSON.stringify(lv)}`);
      console.log(`               example: ${JSON.stringify(ex)}`);
    }
  }
}

if (extraLive.length > 0) {
  console.log(`\nℹ️  ${extraLive.length} key(s) in live not present in example (update example if intentional):\n`);
  for (const { key, live: lv } of extraLive) {
    console.log(`  +  ${key} = ${JSON.stringify(lv)}`);
  }
}

console.log("\n── Workflow reminder ─────────────────────────────────────────────────────");
console.log("   1. Edit user-config.example.json locally (secrets → YOUR_*)");
console.log("   2. Commit + push to private/experimental");
console.log("   3. ssh ohox 'cd ~/meridian && git pull'");
console.log("   4. Edit ~/meridian/user-config.json with real secrets applied");
console.log("   5. Restart: ssh ohox 'bash -i -c mr'");
console.log("─────────────────────────────────────────────────────────────────────────");

process.exit(1);
