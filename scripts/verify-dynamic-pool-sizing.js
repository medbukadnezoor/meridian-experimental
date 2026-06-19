#!/usr/bin/env node
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  applyDynamicPoolSizing,
  buildDynamicPoolSizingDecision,
} from "../dynamic-pool-sizing.js";
import { buildConfig } from "../config-builder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function liveConfig(overrides = {}) {
  return {
    strategy: {
      dynamicPoolSizingEnabled: true,
      dynamicPoolSizingMode: "live",
      dynamicPoolSizingTargetActiveTvlSharePct: 3.5,
      dynamicPoolSizingHardActiveTvlSharePct: 5,
      dynamicPoolSizingMinDeploySol: 1,
      dynamicPoolSizingMaxDeploySol: 5,
      dynamicPoolSizingBlockBelowMin: true,
      dynamicPoolSizingBlockOnMissingInputs: true,
      ...(overrides.strategy ?? {}),
    },
    ...(overrides.root ?? {}),
  };
}

const mcat = buildDynamicPoolSizingDecision(
  { amount_y: 5, active_tvl: 6080 },
  liveConfig(),
  { solUsd: 70 },
);
assert.strictEqual(mcat.decision, "override", "MCAT-like pool overrides fixed 5 SOL amount");
assert.strictEqual(mcat.final_amount_y, 3.04, "MCAT-like active_tvl=6080 at $70/SOL sizes to 3.04 SOL");
assert.strictEqual(mcat.target_size_sol, 3.04, "target 3.5% active TVL is reflected");
assert.strictEqual(mcat.hard_cap_sol, 4.34, "hard 5% active TVL cap is reflected");

const bwick = buildDynamicPoolSizingDecision(
  { amount_y: 5, active_tvl: 1380 },
  liveConfig(),
  { solUsd: 70 },
);
assert.strictEqual(bwick.decision, "block", "BWICK-like pool below 1 SOL target blocks");
assert.ok(bwick.reason_codes.includes("below_min_dynamic_size"), "below-min reason is owner-readable");

const flkr = buildDynamicPoolSizingDecision(
  { amount_y: 5, active_tvl: 50_000 },
  liveConfig(),
  { solUsd: 70 },
);
assert.strictEqual(flkr.decision, "keep", "deep pool capped at 5 SOL keeps configured amount");
assert.strictEqual(flkr.final_amount_y, 5, "FLKR-like deep pool caps at max 5 SOL");

const missing = buildDynamicPoolSizingDecision(
  { amount_y: 5 },
  liveConfig(),
  { solUsd: 70 },
);
assert.strictEqual(missing.decision, "block", "missing active TVL blocks in live mode");
assert.ok(missing.reason_codes.includes("missing_required_input"), "missing input reason is logged");

const applied = applyDynamicPoolSizing(
  { amount_y: 5, amount_x: 2, bins_above: 9, active_tvl: 6080 },
  liveConfig(),
  { solUsd: 70 },
);
assert.strictEqual(applied.ok, true, "sizing application succeeds for MCAT-like input");
assert.strictEqual(applied.args.amount_y, 3.04, "sizing mutates amount_y before forced guard");
assert.strictEqual(applied.args.amount_x, 0, "sizing preserves SOL-only deployment");
assert.strictEqual(applied.args.bins_above, 0, "sizing preserves no-upside-bin deployment");

const built = buildConfig({
  dynamicPoolSizingEnabled: true,
  dynamicPoolSizingMode: "live",
  dynamicPoolSizingTargetActiveTvlSharePct: 3.5,
  dynamicPoolSizingHardActiveTvlSharePct: 5,
  dynamicPoolSizingMinDeploySol: 1,
  dynamicPoolSizingMaxDeploySol: 5,
});
assert.strictEqual(built.strategy.dynamicPoolSizingEnabled, true, "config builder maps dynamicPoolSizingEnabled");
assert.strictEqual(built.strategy.dynamicPoolSizingMode, "live", "config builder maps live mode");
assert.strictEqual(built.strategy.dynamicPoolSizingTargetActiveTvlSharePct, 3.5, "config builder maps target active TVL share");

const executor = read("tools/executor.js");
assert.ok(executor.includes("applyDynamicPoolSizing(args, config"), "executor applies dynamic pool sizing before deploy safety");
assert.ok(executor.includes("dynamicPoolSizing.decision?.final_amount_y"), "forced deploy amount uses dynamic pool size when live-applied");
assert.ok(executor.includes("dynamic_pool_sizing_decision"), "executor carries sizing decision into deploy args/logs");
assert.ok(executor.includes("dynamicSizingMin"), "safety minimum respects dynamic min deploy instead of fixed 5 SOL");

const dlmm = read("tools/dlmm.js");
assert.ok(dlmm.includes("dynamic_pool_sizing_decision"), "DLMM deploy audit carries dynamic sizing decision");

const example = JSON.parse(read("user-config.example.json"));
assert.strictEqual(example.dynamicPoolSizingEnabled, true, "example config enables dynamic pool sizing for Fabriq profile");
assert.strictEqual(example.dynamicPoolSizingMode, "live", "example config ships dynamic pool sizing live");

const result = {
  success: true,
  cases: {
    mcat: {
      active_tvl: 6080,
      sol_usd: 70,
      final_amount_y: mcat.final_amount_y,
      target_size_sol: mcat.target_size_sol,
      hard_cap_sol: mcat.hard_cap_sol,
    },
    bwick: {
      active_tvl: 1380,
      sol_usd: 70,
      decision: bwick.decision,
      reason_codes: bwick.reason_codes,
    },
    flkr: {
      active_tvl: 50_000,
      final_amount_y: flkr.final_amount_y,
    },
  },
  checks: [
    "MCAT-like active TVL sizes to 3.04 SOL at $70/SOL",
    "BWICK-like active TVL blocks below 1 SOL instead of forcing the floor",
    "Deep pool caps at 5 SOL",
    "Executor applies sizing before forced single-sided normalization",
    "Safety min deploy respects dynamic min when live-applied",
  ],
};

console.log(JSON.stringify(result, null, 2));
