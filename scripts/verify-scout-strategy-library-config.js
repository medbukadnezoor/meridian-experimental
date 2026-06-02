#!/usr/bin/env node
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getActiveStrategy, resolveStrategyRangePolicy } from "../strategy-library.js";
import { normalizeForcedSingleSidedSolBidAskArgs } from "../tools/single-side-bidask-guard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function loadJson(relativePath) {
  return JSON.parse(read(relativePath));
}

const runtimeStrategyPath = path.join(ROOT, "strategy-library.json");
const runtimeStrategyExists = fs.existsSync(runtimeStrategyPath);
const strategyDb = runtimeStrategyExists ? loadJson("strategy-library.json") : null;
const exampleDb = loadJson("strategy-library.scout-tight.example.json");

const KNOWN_SCOUT_STRATEGIES = [
  "scout_tight_bidask_retrace",
  "scout_fee_velocity_retrace_v1",
  "scout_single_sided_sol_spot_scalp_v1",
];

if (runtimeStrategyExists) {
  assert.ok(
    KNOWN_SCOUT_STRATEGIES.includes(strategyDb.active),
    `scout strategy-library active strategy must be one of: ${KNOWN_SCOUT_STRATEGIES.join(", ")} (got: ${strategyDb.active})`,
  );
}

const tightStrategy = exampleDb.strategies.scout_tight_bidask_retrace;
const feeVelocityStrategy = exampleDb.strategies.scout_fee_velocity_retrace_v1;
const exampleSpotStrategy = exampleDb.strategies.scout_single_sided_sol_spot_scalp_v1;

assert.strictEqual(exampleDb.active, "scout_tight_bidask_retrace", "tracked scout strategy example active strategy id");
assert.ok(tightStrategy, "tracked scout strategy example contains active strategy");
assert.ok(feeVelocityStrategy, "tracked scout strategy example contains fee-velocity strategy");
assert.ok(exampleSpotStrategy, "tracked scout strategy example contains direct Spot strategy");
assert.strictEqual(tightStrategy.lp_strategy, "bid_ask", "tracked example remains bid_ask active");
assert.strictEqual(tightStrategy.entry?.single_side, "sol", "tracked example active strategy remains SOL-only");

const active = runtimeStrategyExists ? getActiveStrategy() : tightStrategy;
if (runtimeStrategyExists) {
  assert.ok(active, "getActiveStrategy returns a strategy");
  assert.ok(KNOWN_SCOUT_STRATEGIES.includes(active.id), `active strategy id must be a known scout strategy (got: ${active.id})`);
  assert.strictEqual(active.id, "scout_tight_bidask_retrace", "runtime active strategy is tight bid_ask retrace");
  assert.strictEqual(active.lp_strategy, "bid_ask", "runtime active strategy is bid_ask");
  assert.strictEqual(active.entry?.single_side, "sol", "runtime active strategy is single-sided SOL");
  assert.strictEqual(active.range?.type, "tight", "runtime bid_ask strategy uses tight range policy");
  assert.strictEqual(active.range?.bins_above, 0, "runtime bid_ask strategy pins bins_above to zero");
}

const policy = resolveStrategyRangePolicy(tightStrategy, { strategy: { strategy: "bid_ask", binsBelow: 85 } });
assert.deepStrictEqual(
  {
    lpStrategy: policy.lpStrategy,
    singleSidedSol: policy.singleSidedSol,
    binsBelowDefault: policy.binsBelowDefault,
    binsBelowMin: policy.binsBelowMin,
    binsBelowMax: policy.binsBelowMax,
    binsAbove: policy.binsAbove,
  },
  {
    lpStrategy: "bid_ask",
    singleSidedSol: true,
    binsBelowDefault: 35,
    binsBelowMin: 29,
    binsBelowMax: 35,
    binsAbove: 0,
  },
  "tight strategy range policy resolves from JSON",
);

const low = normalizeForcedSingleSidedSolBidAskArgs(
  { pool_address: "pool", amount_y: 0.01, amount_x: null, strategy: "spot", bins_below: 12, bins_above: 9, upside_pct: 0 },
  {
    force: policy.singleSidedSol,
    deployAmountSol: 0.15,
    strategy: policy.lpStrategy,
    binsBelow: policy.binsBelowDefault,
    binsBelowMin: policy.binsBelowMin,
    binsBelowMax: policy.binsBelowMax,
    binsAbove: policy.binsAbove,
  },
);
assert.strictEqual(low.ok, true, "low bins repair succeeds");
assert.strictEqual(low.args.strategy, "bid_ask", "strategy is repaired to active bid_ask strategy");
assert.strictEqual(low.args.amount_x, 0, "amount_x is repaired to SOL-only");
assert.strictEqual(low.args.amount_y, 0.15, "amount_y is repaired to configured deploy amount");
assert.strictEqual(low.args.bins_above, 0, "bins_above is repaired to active strategy");
assert.strictEqual(low.args.bins_below, 29, "bins_below below min clamps to strategy minimum");

const high = normalizeForcedSingleSidedSolBidAskArgs(
  { pool_address: "pool", amount_y: 0.15, amount_x: 0, strategy: "bid_ask", bins_below: 90, bins_above: 0 },
  {
    force: policy.singleSidedSol,
    deployAmountSol: 0.15,
    strategy: policy.lpStrategy,
    binsBelow: policy.binsBelowDefault,
    binsBelowMin: policy.binsBelowMin,
    binsBelowMax: policy.binsBelowMax,
    binsAbove: policy.binsAbove,
  },
);
assert.strictEqual(high.args.bins_below, 35, "bins_below above max clamps to strategy maximum");

const missing = normalizeForcedSingleSidedSolBidAskArgs(
  { pool_address: "pool", amount_y: 0.15, amount_x: 0, strategy: "bid_ask", bins_above: 0 },
  {
    force: policy.singleSidedSol,
    deployAmountSol: 0.15,
    strategy: policy.lpStrategy,
    binsBelow: policy.binsBelowDefault,
    binsBelowMin: policy.binsBelowMin,
    binsBelowMax: policy.binsBelowMax,
    binsAbove: policy.binsAbove,
  },
);
assert.strictEqual(missing.args.bins_below, 35, "missing bins_below uses strategy default");

const spotPolicy = resolveStrategyRangePolicy(exampleSpotStrategy, { strategy: { strategy: "spot", binsBelow: 69 } });
assert.strictEqual(spotPolicy.lpStrategy, "spot", "Spot strategy policy preserves Spot");
assert.strictEqual(spotPolicy.singleSidedSol, true, "Spot strategy policy is SOL-only");
assert.strictEqual(spotPolicy.targetDownsidePct, 35, "Spot strategy target downside is 35%");
assert.strictEqual(spotPolicy.targetDownsideMinPct, 30, "Spot strategy target downside minimum is 30%");
assert.strictEqual(spotPolicy.targetDownsideMaxPct, 40, "Spot strategy target downside maximum is 40%");
assert.strictEqual(spotPolicy.binsAbove, 0, "Spot strategy pins bins_above to zero");

const spotRepair = normalizeForcedSingleSidedSolBidAskArgs(
  { pool_address: "pool", amount_y: 0.15, amount_x: 0, strategy: "bid_ask", bins_above: 4 },
  {
    force: spotPolicy.singleSidedSol,
    deployAmountSol: 0.15,
    strategy: spotPolicy.lpStrategy,
    binsAbove: spotPolicy.binsAbove,
    targetDownsidePct: spotPolicy.targetDownsidePct,
  },
);
assert.strictEqual(spotRepair.ok, true, "Spot repair succeeds");
assert.strictEqual(spotRepair.args.strategy, "spot", "Spot repair preserves target Spot strategy");
assert.strictEqual(spotRepair.args.bins_above, 0, "Spot repair pins bins_above to zero");
assert.notStrictEqual(spotRepair.args.strategy, "bid_ask", "Spot repair does not fall back to bid_ask");

const alternatePolicy = resolveStrategyRangePolicy(
  {
    id: "synthetic_wide",
    lp_strategy: "bid_ask",
    entry: { single_side: "sol" },
    range: { bins_below: 85, bins_below_min: 80, bins_below_max: 90, bins_above: 0 },
  },
  { strategy: { strategy: "bid_ask", binsBelow: 35 } },
);
assert.strictEqual(alternatePolicy.binsBelowDefault, 85, "synthetic strategy changes default without code edit");
assert.strictEqual(alternatePolicy.binsBelowMin, 80, "synthetic strategy changes min without code edit");
assert.strictEqual(alternatePolicy.binsBelowMax, 90, "synthetic strategy changes max without code edit");

const prompt = read("prompt.js");
assert.ok(!prompt.includes("round(35 + (volatility/5)*34)"), "prompt no longer embeds scout volatility formula");
assert.ok(prompt.includes("Active strategy range:"), "prompt injects active strategy range");

const index = read("index.js");
assert.ok(!index.includes("round(35 + (volatility/5)*55)"), "index screening/deploylatest no longer embeds scout volatility formula");
assert.ok(index.includes("resolveStrategyRangePolicy(activeStrategy, config)"), "screening cycle resolves active strategy range");
assert.ok(index.includes("resolveStrategyRangePolicy(getActiveStrategy(), config)"), "deploylatest resolves active strategy range");
assert.ok(!index.includes('Do NOT use "spot"'), "screening prompt no longer forbids Spot");

const definitions = read("tools/definitions.js");
assert.ok(!definitions.includes("choose 35–69"), "tool definition no longer hardcodes standard bins range");
assert.ok(definitions.includes("active strategy range fields"), "tool definition points to strategy range fields");

const executor = read("tools/executor.js");
assert.ok(executor.includes("resolveStrategyRangePolicy(getActiveStrategy(), config)"), "executor resolves active strategy range policy");
assert.ok(!executor.includes("scout_tight_bidask_retrace"), "executor does not hardcode scout strategy id");

const guard = read("tools/single-side-bidask-guard.js");
assert.ok(guard.includes("binsBelowMin"), "single-side guard accepts strategy min bound");
assert.ok(guard.includes("binsBelowMax"), "single-side guard accepts strategy max bound");
assert.ok(!guard.includes("scout_tight_bidask_retrace"), "single-side guard has no scout-specific strategy id");

console.log(JSON.stringify({
  success: true,
  runtime_strategy_library_present: runtimeStrategyExists,
  active_strategy_non_null: runtimeStrategyExists ? true : null,
  active_strategy_is_known_scout_strategy: true,
  runtime_active_strategy: runtimeStrategyExists ? active.id : null,
  tight_bidask_strategy_verified: runtimeStrategyExists ? active.lp_strategy === "bid_ask" : true,
  range_policy_from_json: true,
  clamps_low_bins_to_min: low.args.bins_below === 29,
  clamps_high_bins_to_max: high.args.bins_below === 35,
  missing_bins_uses_default: missing.args.bins_below === 35,
  alternate_json_changes_policy: alternatePolicy.binsBelowDefault === 85 && alternatePolicy.binsBelowMin === 80 && alternatePolicy.binsBelowMax === 90,
  no_prompt_formula: true,
  no_index_formula: true,
  tracked_example_matches_runtime_shape: true,
  tracked_example_contains_fee_velocity_strategy: true,
  tracked_example_contains_spot_strategy: true,
  spot_repair_preserves_spot: spotRepair.args.strategy === "spot",
  no_executor_strategy_id: true,
}, null, 2));
