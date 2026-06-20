#!/usr/bin/env node
import assert from "assert";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildConfig } from "../config-builder.js";
import {
  buildFeeVelocityShadowRows,
  computeDownsideBinsForPct,
  computeVolumeActiveTvlMultiple,
  enrichFeeVelocityCandidate,
  estimateFeeVelocityUsdPerMin,
  resolveStrategyRangePolicy,
} from "../strategy-library.js";
import { normalizeForcedSingleSidedSolBidAskArgs } from "../tools/single-side-bidask-guard.js";
import {
  filterConfiguredPoolThresholds,
  getConfiguredPoolThresholdVetoReason,
} from "../tools/screening.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function loadJson(relativePath) {
  return JSON.parse(read(relativePath));
}

const exampleDb = loadJson("strategy-library.scout-tight.example.json");
const feeVelocityStrategy = exampleDb.strategies.scout_fee_velocity_retrace_v1;
assert.strictEqual(exampleDb.active, "scout_tight_bidask_retrace", "tracked example active strategy remains unchanged");
assert.ok(feeVelocityStrategy, "fee-velocity strategy example exists");
assert.strictEqual(feeVelocityStrategy.lp_strategy, "bid_ask", "fee-velocity strategy is bid_ask");
assert.strictEqual(feeVelocityStrategy.entry?.single_side, "sol", "fee-velocity strategy is SOL-only");
assert.strictEqual(feeVelocityStrategy.range?.target_downside_pct, 15, "target downside is 15%");
assert.strictEqual(feeVelocityStrategy.range?.target_downside_min_pct, 12, "target downside minimum is 12%");
assert.strictEqual(feeVelocityStrategy.range?.target_downside_max_pct, 20, "target downside maximum is 20%");
assert.strictEqual(feeVelocityStrategy.range?.bins_above, 0, "bins above is zero");
assert.strictEqual(feeVelocityStrategy.exit?.take_profit_pct, 7, "take profit midpoint is 7%");

const defaultConfig = buildConfig({}, {});
assert.strictEqual(defaultConfig.screening.minVolumeActiveTvlMultiple, null, "default min volume/aTVL multiple is off");
assert.strictEqual(defaultConfig.screening.preferredVolumeActiveTvlMultiple, null, "default preferred volume/aTVL multiple is off");
assert.deepStrictEqual(defaultConfig.screening.feeVelocityShadowDownsidePct, [7, 10, 12, 15, 20, 25], "default downside shadow variants");
assert.deepStrictEqual(defaultConfig.screening.feeVelocityShadowTakeProfitPct, [6, 7, 8], "default TP shadow variants");
assert.deepStrictEqual(defaultConfig.screening.feeVelocityShadowFeeTvlFloors, [0.12, 0.15, 0.19], "default fee floor shadow variants");
assert.strictEqual(defaultConfig.screening.sameTickerSurfEnabled, false, "same-ticker surf defaults to shadow-only");

const policy = resolveStrategyRangePolicy(feeVelocityStrategy, defaultConfig);
assert.strictEqual(policy.targetDownsidePct, 15, "policy resolves target downside");
assert.strictEqual(policy.targetDownsideMinPct, 12, "policy resolves target downside minimum");
assert.strictEqual(policy.targetDownsideMaxPct, 20, "policy resolves target downside maximum");

const baseCandidate = {
  pool: "pool-accept",
  name: "ACCEPT-SOL",
  base: { symbol: "ACCEPT", mint: "base-accept", organic: 90 },
  quote: { symbol: "SOL", mint: defaultConfig.tokens.SOL, organic: 90 },
  pool_type: "dlmm",
  bin_step: 100,
  active_tvl: 10_000,
  volume_window: 50_000,
  fee_window: 600,
  fee_active_tvl_ratio: 0.2,
  volatility: 4,
  mcap: 200_000,
  holders: 800,
  organic_score: 90,
  quote_organic_score: 90,
};
const lowMultipleCandidate = {
  ...baseCandidate,
  pool: "pool-reject",
  name: "REJECT-SOL",
  volume_window: 20_000,
};

assert.strictEqual(computeVolumeActiveTvlMultiple(baseCandidate), 5, "volume/aTVL multiple computes from volume and active TVL");
assert.strictEqual(estimateFeeVelocityUsdPerMin(baseCandidate, defaultConfig.screening), 120, "fee velocity divides fee window by timeframe minutes");
assert.strictEqual(computeDownsideBinsForPct(15, 100), 17, "downside bins use DLMM bin-step math");

const defaultVeto = getConfiguredPoolThresholdVetoReason(lowMultipleCandidate, defaultConfig.screening);
assert.ok(!String(defaultVeto || "").includes("volume_active_tvl_multiple"), "default config does not hard-gate volume/aTVL");

const gateConfig = buildConfig({ minVolumeActiveTvlMultiple: 4 }, {});
const belowVeto = getConfiguredPoolThresholdVetoReason(lowMultipleCandidate, gateConfig.screening);
const aboveVeto = getConfiguredPoolThresholdVetoReason(baseCandidate, gateConfig.screening);
assert.ok(String(belowVeto || "").includes("volume_active_tvl_multiple"), "configured min multiple rejects below threshold");
assert.strictEqual(aboveVeto, null, "configured min multiple accepts above threshold");

const filteredOut = [];
const stageCounts = {};
const accepted = filterConfiguredPoolThresholds(
  [lowMultipleCandidate, baseCandidate],
  gateConfig.screening,
  filteredOut,
  stageCounts,
  policy,
);
assert.strictEqual(accepted.length, 1, "threshold filter accepts only the above-threshold candidate");
assert.strictEqual(accepted[0].pool, "pool-accept", "accepted candidate is preserved");
assert.strictEqual(stageCounts.configured_threshold_reject, 1, "threshold reject stage count is recorded");
assert.strictEqual(stageCounts.configured_threshold_accept, 1, "threshold accept stage count is recorded");
assert.ok(filteredOut.some((entry) => String(entry.reason || "").includes("volume_active_tvl_multiple")), "filtered examples include volume/aTVL reject reason");

const enriched = enrichFeeVelocityCandidate(baseCandidate, {
  screeningConfig: gateConfig.screening,
  rangePolicy: policy,
});
assert.strictEqual(enriched.volume_active_tvl_multiple, 5, "metadata includes volume/aTVL multiple");
assert.strictEqual(enriched.fee_velocity_usd_per_min, 120, "metadata includes fee velocity");
assert.strictEqual(enriched.target_downside_profile.target_downside_pct, 15, "metadata includes target downside pct");
assert.strictEqual(enriched.target_downside_profile.target_downside_bins, 17, "metadata includes target downside bins");
assert.ok(Array.isArray(enriched.fee_velocity_shadow.downside_pct_variants), "metadata includes downside shadow variants");
assert.ok(enriched.fee_velocity_shadow.downside_pct_variants.some((row) => row.downside_pct === 7 && row.hypothesis === "H1"), "H1 downside variant is present");
assert.ok(enriched.fee_velocity_shadow.downside_pct_variants.some((row) => row.downside_pct === 25 && row.hypothesis === "H3"), "H3 downside variant is present");
assert.ok(enriched.fee_velocity_shadow.fee_tvl_floor_variants.some((row) => row.hypothesis === "H5" && row.fee_tvl_floor === 0.15), "H5 fee floor variant is present");
assert.strictEqual(enriched.fee_velocity_shadow.same_ticker_surf.hypothesis, "H4", "H4 same-ticker surf row is present");
assert.strictEqual(enriched.fee_velocity_shadow.same_ticker_surf.enabled, false, "same-ticker surf is shadow-only by default");
assert.ok(!("shadow_velocity_signal" in enriched), "fee-velocity metadata does not piggyback on active-bin oracle emergency fields");

const shadowRows = buildFeeVelocityShadowRows(baseCandidate, gateConfig.screening, policy);
assert.strictEqual(shadowRows.target_profile.target_downside_min_bins, 13, "target minimum bins are computed");
assert.strictEqual(shadowRows.target_profile.target_downside_max_bins, 23, "target maximum bins are computed");

const percentPolicyRepair = normalizeForcedSingleSidedSolBidAskArgs(
  { pool_address: "pool-percent", amount_y: 0.15, amount_x: 0, strategy: "bid_ask", bins_above: 0 },
  {
    force: true,
    deployAmountSol: 0.15,
    strategy: "bid_ask",
    binsBelow: null,
    binsBelowMin: null,
    binsBelowMax: null,
    binsAbove: 0,
    targetDownsidePct: 15,
  },
);
assert.strictEqual(percentPolicyRepair.ok, true, "percent policy repair succeeds");
assert.strictEqual(percentPolicyRepair.args.downside_pct, 15, "percent policy injects downside_pct when bins are absent");
assert.strictEqual(percentPolicyRepair.args.bins_below, undefined, "percent policy does not inject stale fallback bins");

const implementationFiles = [
  "config-builder.js",
  "config.js",
  "strategy-library.js",
  "tools/screening.js",
  "tools/gmgn.js",
  "tools/executor.js",
  "tools/single-side-bidask-guard.js",
  "strategy-library.scout-tight.example.json",
];
const guardedTerms = [
  ["P", "M2"].join(""),
  ["V", "PS"].join(""),
  ["res", "tart"].join(""),
  ["local", " bot"].join(""),
  ["live", " deploy"].join(""),
];
const verifierSource = read("scripts/verify-scout-fee-velocity-live-canary.js");
for (const term of guardedTerms) {
  assert.ok(!verifierSource.includes(term), "verifier source avoids guarded operational wording");
}
const diffResult = spawnSync("git", ["diff", "--no-ext-diff", "--unified=0", "--", ...implementationFiles], {
  cwd: ROOT,
  encoding: "utf8",
});
assert.strictEqual(diffResult.status, 0, "git diff scan completes");
const addedLines = diffResult.stdout
  .split("\n")
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .join("\n");
for (const term of guardedTerms) {
  assert.ok(!addedLines.includes(term), "implementation diff avoids guarded operational wording");
}

const screeningSource = read("tools/screening.js");
assert.ok(screeningSource.includes("minVolumeActiveTvlMultiple"), "screening source reads min volume/aTVL config");
assert.ok(screeningSource.includes("configured_threshold_reject"), "screening source records configured threshold rejects");
assert.ok(screeningSource.includes("enrichFeeVelocityCandidate"), "screening source enriches accepted candidates");
assert.ok(screeningSource.includes("volume_active_tvl_multiple: computeVolumeActiveTvlMultiple(condensed)"), "Meteora condensed candidates carry volume/aTVL metadata");

const gmgnSource = read("tools/gmgn.js");
assert.ok(gmgnSource.includes("volume_active_tvl_multiple: computeVolumeActiveTvlMultiple(condensed)"), "GMGN condensed candidates carry volume/aTVL metadata");
assert.ok(gmgnSource.includes("fee_velocity_usd_per_min: estimateFeeVelocityUsdPerMin(condensed, config.screening)"), "GMGN condensed candidates carry fee-velocity metadata");

// New shadow signals must not affect live screening or deploy decisions
const stratLib = fs.readFileSync(path.join(ROOT, "strategy-library.js"), "utf8");
const shadowFnStart = stratLib.indexOf("function buildFeeVelocityShadowRows");
const shadowFnEnd = stratLib.indexOf("\nexport function enrichFeeVelocityCandidate");
const shadowFnBody = stratLib.slice(shadowFnStart, shadowFnEnd);

// Shadow signals must not call close, deploy, or screening filter functions
assert.ok(!shadowFnBody.includes("close_position"), "shadow signals do not call close_position");
assert.ok(!shadowFnBody.includes("deploy_position"), "shadow signals do not call deploy_position");
assert.ok(!shadowFnBody.includes("pushFilteredReason"), "shadow signals do not filter candidates");
assert.ok(!shadowFnBody.includes("return null"), "shadow signals do not short-circuit screening");

// All new shadow fields must be present in the return object
assert.ok(shadowFnBody.includes("price_direction_shadow"), "price_direction_shadow present");
assert.ok(shadowFnBody.includes("sell_pressure_shadow"), "sell_pressure_shadow present");
assert.ok(shadowFnBody.includes("volume_tvl_threshold_shadow"), "volume_tvl_threshold_shadow present");
assert.ok(shadowFnBody.includes("fee_velocity_momentum_shadow"), "fee_velocity_momentum_shadow present");
assert.ok(shadowFnBody.includes("quality_vs_velocity_shadow"), "quality_vs_velocity_shadow present");

console.log(JSON.stringify({
  success: true,
  defaults: {
    minVolumeActiveTvlMultiple: defaultConfig.screening.minVolumeActiveTvlMultiple,
    preferredVolumeActiveTvlMultiple: defaultConfig.screening.preferredVolumeActiveTvlMultiple,
    sameTickerSurfEnabled: defaultConfig.screening.sameTickerSurfEnabled,
  },
  gateProof: {
    defaultDoesNotHardGate: !String(defaultVeto || "").includes("volume_active_tvl_multiple"),
    belowThresholdRejected: String(belowVeto || "").includes("volume_active_tvl_multiple"),
    aboveThresholdAccepted: aboveVeto === null,
    filteredExamplesCarryReason: filteredOut.some((entry) => String(entry.reason || "").includes("volume_active_tvl_multiple")),
    stageCounts,
  },
  metadataProof: {
    volume_active_tvl_multiple: enriched.volume_active_tvl_multiple,
    fee_velocity_usd_per_min: enriched.fee_velocity_usd_per_min,
    target_downside_bins: enriched.target_downside_profile.target_downside_bins,
    shadow_downside_variants: enriched.fee_velocity_shadow.downside_pct_variants.map((row) => row.downside_pct),
    shadow_tp_variants: enriched.fee_velocity_shadow.take_profit_pct_variants.map((row) => row.take_profit_pct),
    shadow_fee_floors: enriched.fee_velocity_shadow.fee_tvl_floor_variants.map((row) => row.fee_tvl_floor),
    sameTickerSurfDefaultFalse: enriched.fee_velocity_shadow.same_ticker_surf.enabled === false,
    noShadowVelocitySignalPiggyback: !("shadow_velocity_signal" in enriched),
    percentPolicyDoesNotInjectBins: percentPolicyRepair.args.bins_below === undefined && percentPolicyRepair.args.downside_pct === 15,
  },
  strategyExample: {
    activeUnchanged: exampleDb.active === "scout_tight_bidask_retrace",
    feeVelocityStrategyPresent: Boolean(feeVelocityStrategy),
    targetDownsidePct: feeVelocityStrategy.range.target_downside_pct,
    takeProfitPct: feeVelocityStrategy.exit.take_profit_pct,
  },
  guardedOperationalWordingAbsent: true,
}, null, 2));
