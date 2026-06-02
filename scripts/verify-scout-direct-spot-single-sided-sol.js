#!/usr/bin/env node
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  computeDownsideBinsForPct,
  describeRangePolicyForPrompt,
  resolveStrategyRangePolicy,
} from "../strategy-library.js";
import { normalizeForcedSingleSidedSolBidAskArgs } from "../tools/single-side-bidask-guard.js";
import { validateSingleSidedSolBidAskRange } from "../tools/deploy-range-guard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function loadJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function syntheticMaxHoldDecision({ deployedAt, now = Date.now(), maxHoldMinutes = 60 } = {}) {
  if (maxHoldMinutes == null) return { shouldClose: false, reason: "disabled" };
  const deployedAtMs = deployedAt ? new Date(deployedAt).getTime() : null;
  if (deployedAtMs == null || !Number.isFinite(deployedAtMs)) {
    return { shouldClose: false, reason: "missing_or_invalid_deployed_at" };
  }
  const ageMinutes = (now - deployedAtMs) / 60000;
  return {
    shouldClose: ageMinutes >= maxHoldMinutes,
    ageMinutes,
    action: ageMinutes >= maxHoldMinutes ? "MAX_HOLD" : null,
  };
}

const strategyDb = loadJson("strategy-library.scout-tight.example.json");
const active = strategyDb.strategies.scout_single_sided_sol_spot_scalp_v1;
assert.ok(active, "direct Spot strategy profile exists");
assert.strictEqual(active.id, "scout_single_sided_sol_spot_scalp_v1", "direct Spot profile id");
assert.strictEqual(active.lp_strategy, "spot", "direct Spot profile uses Spot");

const policy = resolveStrategyRangePolicy(active, { strategy: { strategy: "spot", binsBelow: 69 } });
assert.strictEqual(policy.lpStrategy, "spot", "range policy preserves Spot");
assert.strictEqual(policy.singleSidedSol, true, "range policy is single-sided SOL");
assert.strictEqual(policy.targetDownsidePct, 35, "target downside is 35%");
assert.strictEqual(policy.targetDownsideMinPct, 30, "target downside min is 30%");
assert.strictEqual(policy.targetDownsideMaxPct, 40, "target downside max is 40%");
assert.strictEqual(policy.binsAbove, 0, "bins_above is zero");

const indexSource = read("index.js");
assert.strictEqual(countOccurrences(indexSource, 'Do NOT use "spot"'), 0, "screening prompt no longer forbids Spot");
const spotGuidance = describeRangePolicyForPrompt(policy);
assert.ok(spotGuidance.includes("strategy=spot"), "range guidance includes strategy=spot");
assert.ok(!spotGuidance.includes("strategy=bid_ask"), "range guidance does not claim bid_ask for Spot strategy");
const stepsMatch = indexSource.match(/STEPS:[\s\S]*?3\. Report in this exact format/);
assert.ok(stepsMatch, "screening prompt steps block is present");
assert.ok(!stepsMatch[0].includes('Do NOT use "spot"'), "steps block does not forbid Spot");
assert.ok(stepsMatch[0].includes("Use exactly the strategy shown"), "steps block requires exact active strategy");

const validSpot = normalizeForcedSingleSidedSolBidAskArgs(
  { strategy: "spot", amount_y: 0.15, amount_x: 0, bins_above: 0 },
  { force: true, strategy: "spot", deployAmountSol: 0.15, binsAbove: 0 },
);
assert.strictEqual(validSpot.ok, true, "valid Spot SOL-only args accepted");
assert.strictEqual(validSpot.args.strategy, "spot", "valid Spot args preserve Spot");
assert.strictEqual(validSpot.args.amount_x, 0, "valid Spot args keep amount_x zero");
assert.strictEqual(validSpot.args.amount_y, 0.15, "valid Spot args keep amount_y");
assert.strictEqual(validSpot.args.bins_above, 0, "valid Spot args keep bins_above zero");

const repairedStrategy = normalizeForcedSingleSidedSolBidAskArgs(
  { strategy: "bid_ask", amount_y: 0.15, amount_x: 0, bins_above: 0 },
  { force: true, strategy: "spot", deployAmountSol: 0.15, binsAbove: 0 },
);
assert.strictEqual(repairedStrategy.ok, true, "mismatched strategy is repairable");
assert.strictEqual(repairedStrategy.args.strategy, "spot", "mismatched strategy repairs to Spot");

const positiveAmountX = normalizeForcedSingleSidedSolBidAskArgs(
  { strategy: "spot", amount_y: 0.15, amount_x: 0.01, bins_above: 0 },
  { force: true, strategy: "spot", deployAmountSol: 0.15, binsAbove: 0 },
);
assert.strictEqual(positiveAmountX.ok, false, "positive amount_x rejected");
assert.ok(!JSON.stringify(positiveAmountX).includes('"strategy":"bid_ask"'), "positive amount_x rejection does not emit bid_ask fallback");

const positiveBinsAbove = normalizeForcedSingleSidedSolBidAskArgs(
  { strategy: "spot", amount_y: 0.15, amount_x: 0, bins_above: 5 },
  { force: true, strategy: "spot", deployAmountSol: 0.15, binsAbove: 0 },
);
assert.strictEqual(positiveBinsAbove.ok, true, "positive bins_above repaired");
assert.strictEqual(positiveBinsAbove.args.strategy, "spot", "bins_above repair preserves Spot");
assert.strictEqual(positiveBinsAbove.args.bins_above, 0, "positive bins_above repairs to zero");

const validRange = validateSingleSidedSolBidAskRange({
  activeStrategy: "spot",
  isSingleSidedSol: true,
  activeBinId: 1000,
  minBinId: 960,
  maxBinId: 1000,
  activeBinsBelow: 40,
  activeBinsAbove: 0,
  rangeCoverage: { downside_pct: 35, upside_pct: 0, width_pct: 35 },
  guardConfig: { minSingleSidedSolBins: 30, minSingleSidedSolDownsidePct: 0.5 },
});
assert.strictEqual(validRange.ok, true, "deploy range guard accepts valid Spot range");

const tooNarrow = validateSingleSidedSolBidAskRange({
  activeStrategy: "spot",
  isSingleSidedSol: true,
  activeBinId: 1000,
  minBinId: 998,
  maxBinId: 1000,
  activeBinsBelow: 2,
  activeBinsAbove: 0,
  rangeCoverage: { downside_pct: 0.2, upside_pct: 0, width_pct: 0.2 },
  guardConfig: { minSingleSidedSolBins: 30, minSingleSidedSolDownsidePct: 0.5 },
});
assert.strictEqual(tooNarrow.ok, false, "deploy range guard rejects too-narrow Spot range");
assert.ok(String(tooNarrow.reason).includes("spot"), "too-narrow rejection names Spot");

const upsideBins = validateSingleSidedSolBidAskRange({
  activeStrategy: "spot",
  isSingleSidedSol: true,
  activeBinId: 1000,
  minBinId: 960,
  maxBinId: 1005,
  activeBinsBelow: 40,
  activeBinsAbove: 5,
  rangeCoverage: { downside_pct: 35, upside_pct: 4, width_pct: 40 },
  guardConfig: { minSingleSidedSolBins: 30 },
});
assert.strictEqual(upsideBins.ok, false, "deploy range guard rejects upside bins for Spot");
assert.ok(String(upsideBins.reason).includes("spot"), "upside bins rejection names Spot");

const dlmmSource = read("tools/dlmm.js");
assert.ok(dlmmSource.includes("spot: StrategyType.Spot"), "dlmm strategy map includes Spot");
assert.ok(dlmmSource.includes('activeStrategy === "spot" ? "Spot" : "BidAsk"'), "relay payload maps Spot for activeStrategy spot");

for (const step of [80, 100, 125]) {
  const bins30 = computeDownsideBinsForPct(30, step);
  const bins35 = computeDownsideBinsForPct(35, step);
  const bins40 = computeDownsideBinsForPct(40, step);
  assert.ok(Number.isFinite(bins35) && bins35 > 0, `35% downside bins are positive for bin step ${step}`);
  assert.ok(bins30 <= bins35 && bins35 <= bins40, `downside bins monotonic for bin step ${step}`);
}
assert.ok(computeDownsideBinsForPct(35, 80) >= 1, "35% downside bins for step 80 never round to zero");

assert.notStrictEqual(validSpot.args.strategy, "bid_ask", "valid Spot args do not fall back to bid_ask");
assert.notStrictEqual(repairedStrategy.args.strategy, "bid_ask", "repaired Spot args do not fall back to bid_ask");
assert.notStrictEqual(positiveBinsAbove.args.strategy, "bid_ask", "bins_above repair does not fall back to bid_ask");

const configBuilderSource = read("config-builder.js");
assert.ok(/maxHoldMinutes:\s*u\.maxHoldMinutes\s*\?\?\s*null/.test(configBuilderSource), "maxHoldMinutes defaults to null");
const maxHoldIndex = indexSource.indexOf("const maxHoldMinutes = config.management.maxHoldMinutes");
assert.ok(maxHoldIndex >= 0, "max-hold block exists");
const closeRuleIndex = indexSource.indexOf("const closeRule = getDeterministicCloseRule", maxHoldIndex);
assert.ok(closeRuleIndex > maxHoldIndex, "max-hold block runs before deterministic close rule");
const maxHoldBlock = indexSource.slice(maxHoldIndex, closeRuleIndex);
assert.ok(maxHoldBlock.includes("closeEmergencyDirect(p,"), "max-hold uses closeEmergencyDirect");
assert.ok(maxHoldBlock.includes('action: "MAX_HOLD"'), "max-hold action is MAX_HOLD");
assert.ok(maxHoldBlock.includes("urgent: true"), "max-hold is urgent");
assert.ok(maxHoldBlock.includes("Max hold time:"), "max-hold reason is explicit");
assert.ok(maxHoldBlock.includes("_pollTriggeredAt = Date.now()"), "max-hold updates poll trigger time");
assert.ok(!maxHoldBlock.includes('executeTool("close_position"'), "max-hold does not duplicate bare close_position call");
const now = Date.parse("2026-05-19T10:00:00Z");
assert.strictEqual(syntheticMaxHoldDecision({ deployedAt: "2026-05-19T08:59:00Z", now }).shouldClose, true, "61m old position triggers max-hold");
assert.strictEqual(syntheticMaxHoldDecision({ deployedAt: "2026-05-19T09:01:00Z", now }).shouldClose, false, "59m old position does not trigger max-hold");
assert.strictEqual(syntheticMaxHoldDecision({ deployedAt: null, now }).shouldClose, false, "missing deployed_at does not trigger max-hold");
assert.strictEqual(syntheticMaxHoldDecision({ deployedAt: "not-a-date", now }).shouldClose, false, "invalid deployed_at does not trigger max-hold");
assert.doesNotThrow(() => syntheticMaxHoldDecision({ deployedAt: "2026-05-19T08:59:00Z", now }), "max-hold decision does not throw with pending timers elsewhere");

const tailLossFiles = [
  "tools/screening.js",
  "ohlcv-entry-veto-shadow.js",
  "post-win-decay-gate.js",
];
for (const file of tailLossFiles) {
  const src = read(file);
  assert.ok(!src.includes('strategy === "bid_ask"'), `${file} has no bid_ask-only tail-loss gate`);
  assert.ok(!src.includes('strategy !== "spot"'), `${file} has no not-spot tail-loss gate`);
}

console.log(JSON.stringify({
  success: true,
  strategy_resolution: true,
  prompt_guidance: true,
  guard_preserves_spot: true,
  deploy_range_guard: true,
  relay_payload: true,
  target_downside_bins: true,
  no_bidask_fallback: true,
  max_hold: true,
  tail_loss_agnostic: true,
}, null, 2));
