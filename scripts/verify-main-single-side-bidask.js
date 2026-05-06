#!/usr/bin/env node
/**
 * Synthetic proof for main SOL-only bid_ask deploy argument hardening.
 *
 * Pure helper/config/source checks only: no bot runtime, wallet, or trading API calls.
 */

import assert from "assert";
import fs from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
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
    deployAmountSol: 1,
    binsBelow: 69,
    ...overrides,
  });
}

function main() {
  const exampleConfig = readJson("user-config.example.json");
  assert.strictEqual(exampleConfig.forceSingleSidedSolBidAsk, true, "main example config explicitly enables forced SOL-only bid_ask");
  assert.strictEqual(exampleConfig.strategy, "bid_ask", "main example config strategy");
  assert.strictEqual(exampleConfig.binsBelow, 69, "main example config binsBelow");

  const noForce = normalizeForcedSingleSidedSolBidAskArgs({ strategy: "spot", amount_x: 0.2 }, { force: false });
  assert.strictEqual(noForce.ok, true, "non-forced mode should not reject dual-sided/spot args");
  assert.strictEqual(noForce.args.strategy, "spot", "non-forced mode leaves strategy unchanged");

  const spotRepair = normalize({ strategy: "spot", amount_y: 1, bins_below: 69, bins_above: 0 });
  assert.strictEqual(spotRepair.ok, true, "spot strategy should be deterministically repaired in forced mode");
  assert.strictEqual(spotRepair.args.strategy, "bid_ask", "spot repaired to bid_ask");

  const dualSidedReject = normalize({ strategy: "bid_ask", amount_x: 0.1, amount_y: 1, bins_below: 69, bins_above: 0 });
  assert.strictEqual(dualSidedReject.ok, false, "amount_x > 0 should be rejected");
  assert.strictEqual(dualSidedReject.retryableToolArgs, true, "amount_x rejection should not consume deploy retry guard");
  assert.match(dualSidedReject.reason, /amount_x must be 0/i);

  const binsAboveRepair = normalize({ strategy: "bid_ask", amount_y: 1, bins_below: 69, bins_above: 25 });
  assert.strictEqual(binsAboveRepair.ok, true, "bins_above > 0 should be repaired");
  assert.strictEqual(binsAboveRepair.args.bins_above, 0, "bins_above repaired to zero");

  const halfAmountRepair = normalize({ strategy: "bid_ask", amount_y: 0.5, bins_below: 69, bins_above: 0 });
  assert.strictEqual(halfAmountRepair.ok, true, "half deploy amount should be repaired");
  assert.strictEqual(halfAmountRepair.args.amount_y, 1, "amount_y repaired to full computed deploy amount");
  assert.strictEqual(halfAmountRepair.args.amount_x, 0, "amount_x remains zero after half-amount repair");

  const amountSolAliasRepair = normalize({ strategy: "bid_ask", amount_sol: 0.5, bins_below: 69, bins_above: 0 });
  assert.strictEqual(amountSolAliasRepair.ok, true, "legacy amount_sol half amount should be repaired");
  assert.strictEqual(amountSolAliasRepair.args.amount_y, 1, "amount_sol half repaired to full amount_y");
  assert.strictEqual(Object.hasOwn(amountSolAliasRepair.args, "amount_sol"), false, "legacy amount_sol removed after repair");

  const upsideReject = normalize({ strategy: "bid_ask", amount_y: 1, bins_below: 69, bins_above: 0, upside_pct: 5 });
  assert.strictEqual(upsideReject.ok, false, "positive upside_pct should be rejected");
  assert.strictEqual(upsideReject.retryableToolArgs, true, "upside_pct rejection should not consume deploy retry guard");
  assert.match(upsideReject.reason, /positive upside_pct is invalid/i);

  const configSource = loadSource("config.js");
  const executorSource = loadSource("tools/executor.js");
  const agentSource = loadSource("agent.js");
  assert.ok(configSource.includes("forceSingleSidedSolBidAsk"), "main config exposes forceSingleSidedSolBidAsk");
  assert.ok(executorSource.includes("shouldForceSingleSidedSolBidAsk"), "executor gates forced mode by config/active strategy");
  assert.ok(executorSource.includes("getActiveStrategy"), "executor reads active strategy before forcing single-side mode");
  assert.ok(executorSource.includes("normalizeForcedSingleSidedSolBidAskArgs"), "executor repairs forced deploy args before safety checks");
  assert.ok(executorSource.includes("computeDeployAmount"), "executor uses computed deploy amount as repair target");
  assert.ok(executorSource.indexOf("normalizeForcedSingleSidedSolBidAskArgs") < executorSource.indexOf("runSafetyChecks"), "forced repair runs before safety checks");
  assert.ok(agentSource.includes("result?.retryable_tool_args !== true"), "agent duplicate deploy guard skips retryable deterministic arg rejections");

  console.log(JSON.stringify({
    success: true,
    config: {
      example_forceSingleSidedSolBidAsk: exampleConfig.forceSingleSidedSolBidAsk,
      example_strategy: exampleConfig.strategy,
      example_binsBelow: exampleConfig.binsBelow,
    },
    repairs_and_rejections: {
      noForce,
      spotRepair,
      dualSidedReject,
      binsAboveRepair,
      halfAmountRepair,
      amountSolAliasRepair,
      upsideReject,
    },
    source_markers: {
      config_flag: true,
      executor_active_strategy_gate: true,
      executor_pre_safety_repair: true,
      executor_computed_deploy_target: true,
      agent_retryable_arg_rejection: true,
    },
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
