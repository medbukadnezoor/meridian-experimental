#!/usr/bin/env node
/**
 * Verifies that nanocap example config uses both-source discovery,
 * the dual-source resolver is present in screening.js,
 * and the candidate funnel shadow runner still exists for comparison.
 */
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildConfig } from "../config-builder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const examplePath = ["user-config.nanocap-v1.example.json", "user-config.example.json"]
  .map((f) => path.join(ROOT, f))
  .find((f) => fs.existsSync(f));
assert.ok(examplePath, "nanocap example config exists");

const example = JSON.parse(fs.readFileSync(examplePath, "utf8"));
const config = buildConfig(example);
assert.strictEqual(config.screening.source, "both", "nanocap example uses both-source discovery");

const screening = fs.readFileSync(path.join(ROOT, "tools/screening.js"), "utf8");
assert.ok(screening.includes("resolveDualSourceDiscovery"), "screening.js has dual-source resolver");
assert.ok(screening.includes('source === "both"'), "screening.js handles both source mode");

assert.ok(
  fs.existsSync(path.join(ROOT, "scripts/run-candidate-funnel-shadow.js")),
  "candidate funnel shadow runner still present"
);

const shadow = fs.readFileSync(path.join(ROOT, "scripts/run-candidate-funnel-shadow.js"), "utf8");
assert.ok(
  shadow.includes('"gmgn"') && shadow.includes('"meteora"'),
  "shadow runner compares gmgn and meteora independently"
);

console.log(JSON.stringify({
  success: true,
  nanocap_uses_both_source: true,
  dual_source_resolver_present: true,
  shadow_runner_present: true,
  shadow_runs_independently: true,
}, null, 2));
