#!/usr/bin/env node
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { computeDownsideBinsForPct } from "../strategy-library.js";
import {
  applyRangeWidthDecision,
  buildRangeWidthDecision,
  resolveRangeWidthPolicy,
} from "../range-width-decision.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function liveConfig(overrides = {}) {
  return {
    screening: {
      minMcap: 125_000,
      ...(overrides.screening ?? {}),
    },
    strategy: {
      dynamicRangeWidthEnabled: true,
      dynamicRangeWidthMode: "live",
      dynamicRangeWidthMinBins: 12,
      dynamicRangeWidthMaxBins: 120,
      dynamicRangeWidthBlockOnMissingInputs: true,
      dynamicRangeWidthMaxDeploySharePct: 5,
      dynamicRangeWidthLowerMcapInputFloor: 500_000,
      dynamicRangeWidthMinTargetDownsidePct: 16,
      dynamicRangeWidthFeeDensityTighteningEnabled: true,
      dynamicRangeWidthStrongFeeActiveTvlRatio: 3,
      dynamicRangeWidthStrongVolumeActiveTvlMultiple: 1.5,
      dynamicRangeWidthStrongFeeVelocityUsdPerMin: 3,
      dynamicRangeWidthStrongTightenPct: 2,
      dynamicRangeWidthGoodFeeActiveTvlRatio: 1.5,
      dynamicRangeWidthGoodVolumeActiveTvlMultiple: 1.2,
      dynamicRangeWidthGoodTightenPct: 1,
      dynamicRangeWidthTiers: [
        { minMcap: 125_000, maxMcap: 250_000, targetDownsidePct: 30, maxTargetDownsidePct: 36 },
        { minMcap: 250_000, maxMcap: 500_000, targetDownsidePct: 28, maxTargetDownsidePct: 34 },
        { minMcap: 500_000, maxMcap: 800_000, targetDownsidePct: 25, maxTargetDownsidePct: 31 },
        { minMcap: 800_000, maxMcap: 1_200_000, targetDownsidePct: 22, maxTargetDownsidePct: 28 },
        { minMcap: 1_200_000, maxMcap: 2_500_000, targetDownsidePct: 20, maxTargetDownsidePct: 25 },
        { minMcap: 2_500_000, maxMcap: null, targetDownsidePct: 18, maxTargetDownsidePct: 22 },
      ],
      ...(overrides.strategy ?? {}),
    },
  };
}

const expectedBins = [
  { pct: 16, values: { 50: 35, 80: 22, 100: 18, 125: 15 } },
  { pct: 20, values: { 50: 45, 80: 29, 100: 23, 125: 18 } },
  { pct: 30, values: { 50: 72, 80: 45, 100: 36, 125: 29 } },
];
for (const row of expectedBins) {
  for (const [step, expected] of Object.entries(row.values)) {
    assert.strictEqual(
      computeDownsideBinsForPct(row.pct, Number(step)),
      expected,
      `${row.pct}% downside at ${step} bps requires ${expected} bins`,
    );
  }
}

const lowMcapArgs = {
  pool_address: "low-mcap-pool",
  amount_y: 12,
  amount_x: 0,
  bins_above: 0,
  bins_below: 35,
  bin_step: 100,
  mcap: 220_000,
  active_tvl: 20_000,
  deploy_share_of_active_tvl_pct: 2,
  volatility: 3,
  price_change_pct: 8,
};
const lowMcap = applyRangeWidthDecision(lowMcapArgs, liveConfig());
assert.strictEqual(lowMcap.ok, true, "low-mcap non-oversize deploy can proceed after widening");
assert.strictEqual(lowMcap.decision.decision, "override", "low-mcap 35 bins is overridden");
assert.strictEqual(lowMcap.decision.target_downside_pct, 33, "low-mcap thin-active-TVL target stays wider at 33% downside");
assert.strictEqual(lowMcap.args.bins_below, 41, "low-mcap bins widen to 33% at 100 bps");
assert.ok(lowMcap.decision.reason_codes.includes("thin_active_tvl"), "thin active TVL bump is explicit");
assert.ok(lowMcap.decision.reason_codes.includes("llm_bins_overridden"), "widen reason is explicit");
assert.strictEqual(lowMcap.args.amount_y, 12, "range-width guard preserves amount_y");
assert.strictEqual(lowMcap.args.amount_x, 0, "range-width guard preserves SOL-only amount_x=0");
assert.strictEqual(lowMcap.args.bins_above, 0, "range-width guard preserves bins_above=0");

const highMcapTight = applyRangeWidthDecision({
  pool_address: "high-mcap-fee-dense",
  amount_y: 5,
  amount_x: 0,
  bins_above: 0,
  bins_below: 35,
  bin_step: 125,
  mcap: 1_800_000,
  active_tvl: 90_000,
  dynamic_pool_sizing_decision: {
    enabled: true,
    final_amount_y: 3,
    active_tvl_usd: 90_000,
    sol_usd: 72,
    final_deploy_share_of_active_tvl_pct: 0.24,
  },
  volatility: 2,
  price_change_pct: 5,
  fee_tvl_ratio: 3.4,
  volume_active_tvl_multiple: 1.8,
  fee_velocity_usd_per_min: 4,
}, liveConfig());
assert.strictEqual(highMcapTight.ok, true, "high-mcap fee-dense pool passes");
assert.strictEqual(highMcapTight.decision.decision, "override", "high-mcap fee-dense pool tightens live bins");
assert.strictEqual(highMcapTight.decision.target_downside_pct, 18, "strong fee density tightens 20% tier to 18%");
assert.strictEqual(highMcapTight.args.bins_below, 16, "18% downside at 125 bps tightens below 35 bins");
assert.ok(highMcapTight.decision.reason_codes.includes("llm_bins_tightened"), "tighten reason is explicit");
assert.ok(highMcapTight.decision.reason_codes.includes("strong_fee_density_tighten"), "fee-density tighten reason is explicit");

const dynamicSizingShare = applyRangeWidthDecision({
  pool_address: "dynamic-share-pool",
  amount_y: 1.76,
  amount_x: 0,
  bins_above: 0,
  bins_below: 35,
  bin_step: 100,
  mcap: 220_000,
  active_tvl: 3_615,
  deploy_share_of_active_tvl_pct: 18.5,
  dynamic_pool_sizing_decision: {
    enabled: true,
    final_amount_y: 1.76,
    active_tvl_usd: 3_615,
    sol_usd: 71.86,
    final_deploy_share_of_active_tvl_pct: 3.5,
  },
  volatility: 3,
}, liveConfig());
assert.strictEqual(dynamicSizingShare.ok, true, "dynamic sizing final share overrides stale candidate deploy share");
assert.strictEqual(dynamicSizingShare.decision.deploy_share_of_active_tvl_pct, 3.5, "range decision records final dynamic deploy share");
assert.ok(!dynamicSizingShare.decision.reason_codes.includes("deploy_share_too_high"), "stale pre-sizing share does not block");

const ansem = applyRangeWidthDecision({
  pool_address: "ansem-pool",
  amount_y: 12,
  amount_x: 0,
  bins_above: 0,
  bins_below: 35,
  bin_step: 125,
  mcap: 1_181_308,
  active_tvl: 40_000,
  deploy_share_of_active_tvl_pct: 4,
  volatility: 8.5765,
  fee_tvl_ratio: 2,
  volume_active_tvl_multiple: 1.4,
}, liveConfig());
assert.strictEqual(ansem.ok, true, "ANSEM-like volatile candidate can proceed after widening");
assert.strictEqual(ansem.decision.decision, "override", "ANSEM-like 35 bins is overridden");
assert.strictEqual(ansem.decision.target_downside_pct, 27, "volatile mid-mcap candidate tightens one point with good fee/activity proof");
assert.strictEqual(ansem.args.bins_below, 26, "27% downside at 125 bps can still tighten below 35 bins");

const lowStepMax = applyRangeWidthDecision({
  pool_address: "low-step-pool",
  amount_y: 12,
  amount_x: 0,
  bins_above: 0,
  bins_below: 35,
  bin_step: 50,
  mcap: 150_000,
  active_tvl: 20_000,
  deploy_share_of_active_tvl_pct: 2,
  volatility: 8,
}, liveConfig({
  strategy: { dynamicRangeWidthMaxBins: 80 },
}));
assert.strictEqual(lowStepMax.ok, false, "low-step pool requiring more than max blocks");
assert.strictEqual(lowStepMax.decision.required_bins_below, 90, "low-step required bins are computed");
assert.ok(lowStepMax.decision.reason_codes.includes("required_bins_exceeds_max"), "max-bin block reason is explicit");
assert.strictEqual(lowStepMax.args.bins_below, 35, "max-bin block does not clamp to 120 or fallback to 69");

const safe = applyRangeWidthDecision({
  pool_address: "safe-pool",
  amount_y: 12,
  amount_x: 0,
  bins_above: 0,
  bins_below: 35,
  bin_step: 125,
  mcap: 2_000_000,
  active_tvl: 150_000,
  deploy_share_of_active_tvl_pct: 1,
  volatility: 2,
  price_change_pct: 12,
}, liveConfig());
assert.strictEqual(safe.ok, true, "safe/deeper pool passes");
assert.strictEqual(safe.decision.decision, "keep", "safe/deeper pool keeps fallback when fee-density proof is missing");
assert.strictEqual(safe.args.bins_below, 35, "safe/deeper pool does not tighten without fee-density proof");
assert.ok(safe.decision.reason_codes.includes("tighten_blocked_missing_fee_density"), "missing fee-density proof blocks tightening");

const missing = applyRangeWidthDecision({
  pool_address: "missing-input-pool",
  amount_y: 12,
  amount_x: 0,
  bins_above: 0,
  bins_below: 35,
  mcap: 250_000,
  bin_step: 125,
}, liveConfig());
assert.strictEqual(missing.ok, false, "missing lower-mcap inputs block in live mode");
assert.ok(missing.decision.reason_codes.includes("missing_required_input"), "missing input reason code is present");
assert.ok(missing.decision.missing_inputs.includes("active_tvl"), "missing active TVL is explicit");
assert.ok(missing.decision.missing_inputs.includes("deploy_share_of_active_tvl_pct"), "missing deploy share is explicit");

const belowFloor = applyRangeWidthDecision({
  pool_address: "below-floor",
  amount_y: 12,
  amount_x: 0,
  bins_above: 0,
  bins_below: 35,
  bin_step: 125,
  mcap: 124_999,
  active_tvl: 50_000,
  deploy_share_of_active_tvl_pct: 1,
}, liveConfig());
assert.strictEqual(belowFloor.ok, false, "mcap below configured floor blocks");
assert.ok(belowFloor.decision.reason_codes.includes("mcap_below_configured_floor"), "mcap floor reason is explicit");

const shadowOnly = applyRangeWidthDecision(lowMcapArgs, liveConfig({
  strategy: { dynamicRangeWidthMode: "shadow" },
}));
assert.strictEqual(shadowOnly.ok, true, "shadow mode does not block");
assert.strictEqual(shadowOnly.decision.decision, "shadow_only", "shadow mode reports shadow_only");
assert.strictEqual(shadowOnly.decision.live_applied, false, "shadow mode does not apply live args");
assert.strictEqual(shadowOnly.args.bins_below, 35, "shadow mode leaves LLM bins unchanged");

const disabled = applyRangeWidthDecision(lowMcapArgs, liveConfig({
  strategy: { dynamicRangeWidthEnabled: false },
}));
assert.strictEqual(disabled.ok, true, "disabled guard does not block");
assert.strictEqual(disabled.decision.decision, "shadow_only", "disabled guard is telemetry only");
assert.strictEqual(disabled.args.bins_below, 35, "disabled guard does not mutate bins");

const pump = buildRangeWidthDecision({
  pool_address: "pump-pool",
  bins_below: 35,
  bin_step: 125,
  mcap: 1_500_000,
  active_tvl: 100_000,
  deploy_share_of_active_tvl_pct: 1,
  volatility: 2,
  price_change_pct: 150,
}, liveConfig());
assert.ok(pump.reason_codes.includes("pump_retrace_bump"), "pump retrace bump reason can be emitted");

const policy = resolveRangeWidthPolicy(liveConfig());
assert.strictEqual(policy.enabled, true, "policy resolves enabled live mode");
assert.strictEqual(policy.maxBins, 120, "policy resolves max bins");
assert.strictEqual(policy.minBins, 12, "policy resolves min bins");
assert.strictEqual(policy.feeDensityTighteningEnabled, true, "policy resolves fee-density tightening");

const executorSource = read("tools/executor.js");
const dlmmSource = read("tools/dlmm.js");
const indexSource = read("index.js");
const cliSource = read("cli.js");
const definitionsSource = read("tools/definitions.js");
const configBuilderSource = read("config-builder.js");
const exampleConfigSource = read("user-config.example.json");

assert.ok(executorSource.includes("applyRangeWidthDecision(args, config)"), "executor uses shared range-width guard");
assert.ok(executorSource.indexOf("applyRangeWidthDecision(args, config)") < executorSource.indexOf("runSafetyChecks(name, args)"), "width guard runs before protected tool safety/execute path");
assert.ok(executorSource.includes("source: \"executor.range_width_decision\""), "executor logs range-width block decisions");
assert.ok(dlmmSource.includes("range_width_decision"), "deploy action logs carry range_width_decision");
assert.ok(indexSource.includes("active_tvl: candidate.active_tvl ?? candidate.tvl ?? null"), "autonomous deploy passes explicit active TVL");
assert.ok(indexSource.includes("executeTool(\"deploy_position\""), "autonomous screening route uses executor deploy_position");
assert.ok(cliSource.includes("executeTool(\"deploy_position\""), "CLI deploy route uses executor deploy_position");
assert.ok(cliSource.includes("active_tvl: flags[\"active-tvl\"]"), "CLI exposes active TVL evidence flag");
assert.ok(cliSource.includes("fee_velocity_usd_per_min"), "CLI exposes fee velocity evidence flag");
assert.ok(definitionsSource.includes("active_tvl: { type: \"number\""), "deploy tool schema accepts active_tvl");
assert.ok(definitionsSource.includes("fee_velocity_usd_per_min"), "deploy tool schema accepts fee velocity");
assert.ok(configBuilderSource.includes("dynamicRangeWidthEnabled: u.dynamicRangeWidthEnabled ?? false"), "config builder defaults guard disabled");
assert.ok(exampleConfigSource.includes("\"dynamicRangeWidthEnabled\": true"), "example config enables live dynamic width");
assert.ok(exampleConfigSource.includes("\"dynamicRangeWidthFeeDensityTighteningEnabled\": true"), "example config enables fee-density tightening");
assert.ok(exampleConfigSource.includes("\"dynamicRangeWidthMaxBins\": 120"), "example config exposes max bins");

const proof = {
  success: true,
  checks: [
    "coverage math matches 16/20/30 percent target fixtures",
    "low-mcap pools keep wider downside while high-mcap fee-dense pools tighten below 35 bins",
    "dynamic sizing final share overrides stale candidate deploy share",
    "volatile mid-mcap candidates respect tier max target",
    "low-step required bins over max blocks without clamp/fallback",
    "safe deeper pool keeps fallback width when fee-density proof is missing",
    "missing lower-mcap inputs and mcap floor fail closed in live mode",
    "shadow and disabled modes attach telemetry without mutating deploy args",
    "executor, autonomous, direct tool, and CLI deploy paths share executeTool guard",
  ],
  samples: {
    low_mcap: lowMcap.decision,
    high_mcap_tight: highMcapTight.decision,
    dynamic_sizing_share: dynamicSizingShare.decision,
    ansem: ansem.decision,
    low_step_max: lowStepMax.decision,
    safe: safe.decision,
    missing: missing.decision,
  },
};

console.log(JSON.stringify(proof, null, 2));
