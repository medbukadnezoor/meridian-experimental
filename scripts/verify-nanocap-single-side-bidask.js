#!/usr/bin/env node
/**
 * Synthetic proof for forced nanocap SOL-only bid_ask deploy arguments.
 *
 * Pure helper/config/source checks only: no bot runtime, no wallet, no trading APIs.
 */

import assert from "assert";
import fs from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { buildConfig } from "../config-builder.js";
import { normalizeForcedSingleSidedSolBidAskArgs } from "../tools/single-side-bidask-guard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(join(ROOT, relativePath), "utf8"));
}

function loadSource(relativePath) {
  return fs.readFileSync(join(ROOT, relativePath), "utf8");
}

function normalize(args, overrides = {}) {
  return normalizeForcedSingleSidedSolBidAskArgs(args, {
    force: true,
    deployAmountSol: 0.8,
    binsBelow: 85,
    ...overrides,
  });
}

function main() {
  const builtNanocap = buildConfig({ preset: "nanocap-v1" }, {});
  assert.strictEqual(builtNanocap.strategy.forceSingleSidedSolBidAsk, true, "nanocap preset defaults forced SOL-only bid_ask on");

  const exampleConfig = readJson("user-config.example.json");
  assert.strictEqual(exampleConfig.forceSingleSidedSolBidAsk, true, "nanocap example config explicitly enables forced SOL-only bid_ask");
  assert.strictEqual(exampleConfig.strategy, "bid_ask", "nanocap example config strategy");
  assert.strictEqual(exampleConfig.binsBelow, 85, "nanocap example config binsBelow");

  const strategyLibrary = readJson("strategy-library.nanocap-v1.example.json");
  const active = strategyLibrary.strategies[strategyLibrary.active];
  assert.strictEqual(strategyLibrary.active, "nanocap_mean_reversion", "active nanocap strategy id");
  assert.strictEqual(active.lp_strategy, "bid_ask", "active nanocap lp_strategy");
  assert.strictEqual(active.entry.single_side, "sol", "active nanocap entry side");
  assert.strictEqual(active.range.bins_above, 0, "active nanocap bins_above");
  assert.strictEqual(active.range.bins_below, 85, "active nanocap bins_below");

  const spotRepair = normalize({ strategy: "spot", amount_y: 0.8, bins_below: 85, bins_above: 0 });
  assert.strictEqual(spotRepair.ok, true, "spot strategy should be deterministically repaired");
  assert.strictEqual(spotRepair.args.strategy, "bid_ask", "spot repaired to bid_ask");

  const dualSidedReject = normalize({ strategy: "bid_ask", amount_x: 0.1, amount_y: 0.8, bins_below: 85, bins_above: 0 });
  assert.strictEqual(dualSidedReject.ok, false, "amount_x > 0 should be rejected");
  assert.strictEqual(dualSidedReject.retryableToolArgs, true, "amount_x rejection should not consume deploy retry guard");
  assert.match(dualSidedReject.reason, /amount_x must be 0/i);

  const binsAboveRepair = normalize({ strategy: "bid_ask", amount_y: 0.8, bins_below: 85, bins_above: 25 });
  assert.strictEqual(binsAboveRepair.ok, true, "bins_above > 0 should be repaired");
  assert.strictEqual(binsAboveRepair.args.bins_above, 0, "bins_above repaired to zero");

  const halfAmountRepair = normalize({ strategy: "bid_ask", amount_y: 0.4, bins_below: 85, bins_above: 0 });
  assert.strictEqual(halfAmountRepair.ok, true, "half deploy amount should be repaired");
  assert.strictEqual(halfAmountRepair.args.amount_y, 0.8, "amount_y repaired to full computed deploy amount");
  assert.strictEqual(halfAmountRepair.args.amount_x, 0, "amount_x remains zero after half-amount repair");
  assert.strictEqual(halfAmountRepair.args.bins_above, 0, "bins_above remains zero after half-amount repair");

  const amountSolAliasRepair = normalize({ strategy: "bid_ask", amount_sol: 0.4, bins_below: 85, bins_above: 0 });
  assert.strictEqual(amountSolAliasRepair.ok, true, "legacy amount_sol half amount should be repaired");
  assert.strictEqual(amountSolAliasRepair.args.amount_y, 0.8, "amount_sol half repaired to full amount_y");
  assert.strictEqual(Object.hasOwn(amountSolAliasRepair.args, "amount_sol"), false, "legacy amount_sol removed after repair");

  const upsideReject = normalize({ strategy: "bid_ask", amount_y: 0.8, bins_below: 85, bins_above: 0, upside_pct: 5 });
  assert.strictEqual(upsideReject.ok, false, "positive upside_pct should be rejected");
  assert.strictEqual(upsideReject.retryableToolArgs, true, "upside_pct rejection should not consume deploy retry guard");
  assert.match(upsideReject.reason, /positive upside_pct is invalid/i);

  const executorSource = loadSource("tools/executor.js");
  const agentSource = loadSource("agent.js");
  const definitionsSource = loadSource("tools/definitions.js");
  assert.ok(executorSource.includes("normalizeForcedSingleSidedSolBidAskArgs"), "executor repairs forced deploy args before safety checks");
  assert.ok(executorSource.includes("computeDeployAmount"), "executor uses computed deploy amount as forced repair target when available");
  assert.ok(executorSource.indexOf("normalizeForcedSingleSidedSolBidAskArgs") < executorSource.indexOf("runSafetyChecks"), "forced repair runs before safety checks");
  assert.ok(agentSource.includes("result?.retryable_tool_args !== true"), "agent duplicate deploy guard skips retryable deterministic arg rejections");
  assert.ok(definitionsSource.includes("forced SOL-only mode"), "tool wording explains forced SOL-only mode");

  console.log(JSON.stringify({
    success: true,
    config: {
      preset_default_forceSingleSidedSolBidAsk: builtNanocap.strategy.forceSingleSidedSolBidAsk,
      example_forceSingleSidedSolBidAsk: exampleConfig.forceSingleSidedSolBidAsk,
      example_strategy: exampleConfig.strategy,
      example_binsBelow: exampleConfig.binsBelow,
    },
    active_strategy_example: {
      id: strategyLibrary.active,
      lp_strategy: active.lp_strategy,
      single_side: active.entry.single_side,
      bins_above: active.range.bins_above,
      bins_below: active.range.bins_below,
    },
    repairs_and_rejections: {
      spotRepair,
      dualSidedReject,
      binsAboveRepair,
      halfAmountRepair,
      amountSolAliasRepair,
      upsideReject,
    },
    bad_live_pattern: {
      input: { amount_y: 0.4, deployAmountSol: 0.8 },
      repaired_amount_y: halfAmountRepair.args.amount_y,
      would_hit_min_deploy_safety_block: halfAmountRepair.args.amount_y < 0.8,
      deploy_retry_guard_consumed_by_deterministic_rejection: false,
    },
    source_markers: {
      executor_pre_safety_repair: true,
      executor_computed_deploy_target: true,
      agent_retryable_arg_rejection: true,
      tool_wording_forced_mode: true,
    },
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ success: false, error: error.message }, null, 2));
  process.exit(1);
}
