#!/usr/bin/env node
/**
 * Verifies that nanocap rolling drawdown thresholds are tightened per ROJO evidence.
 * peak >= 3%, current <= 0%, drop >= 4pp.
 * Shadow fields preserve old thresholds for comparison logging.
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

assert.strictEqual(config.management.rollingDrawdownMinPeakPct, 3, "rollingDrawdownMinPeakPct tightened to 3");
assert.strictEqual(config.management.rollingDrawdownCurrentPnlPct, 0, "rollingDrawdownCurrentPnlPct tightened to 0");
assert.strictEqual(config.management.rollingDrawdownMinDropPct, 4, "rollingDrawdownMinDropPct stays 4");
assert.ok(config.management.rollingDrawdownExitEnabled, "rollingDrawdownExitEnabled is true");
assert.strictEqual(config.management.rollingDrawdownShadowMinPeakPct, 1, "shadow preserves old peak threshold 1");
assert.strictEqual(config.management.rollingDrawdownShadowCurrentPnlPct, -2, "shadow preserves old current threshold -2");

console.log(JSON.stringify({
  success: true,
  peak_threshold: config.management.rollingDrawdownMinPeakPct,
  current_threshold: config.management.rollingDrawdownCurrentPnlPct,
  drop_threshold: config.management.rollingDrawdownMinDropPct,
  shadow_peak: config.management.rollingDrawdownShadowMinPeakPct,
  shadow_current: config.management.rollingDrawdownShadowCurrentPnlPct,
}, null, 2));
