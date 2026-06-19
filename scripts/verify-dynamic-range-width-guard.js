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
      minMcap: 400_000,
      ...(overrides.screening ?? {}),
    },
    strategy: {
      dynamicRangeWidthEnabled: true,
      dynamicRangeWidthMode: "live",
      dynamicRangeWidthMinBins: 35,
      dynamicRangeWidthMaxBins: 120,
      dynamicRangeWidthBlockOnMissingInputs: true,
      dynamicRangeWidthMaxDeploySharePct: 5,
      dynamicRangeWidthLowerMcapInputFloor: 1_200_000,
      dynamicRangeWidthTiers: [
        { minMcap: 400_000, maxMcap: 500_000, targetDownsidePct: 60 },
        { minMcap: 500_000, maxMcap: 800_000, targetDownsidePct: 58 },
        { minMcap: 800_000, maxMcap: 1_200_000, targetDownsidePct: 55 },
        { minMcap: 1_200_000, maxMcap: null, targetDownsidePct: 35, maxTargetDownsidePct: 45 },
      ],
      ...(overrides.strategy ?? {}),
    },
  };
}

const expectedBins = [
  { pct: 55, values: { 50: 161, 80: 101, 100: 81, 125: 65 } },
  { pct: 58, values: { 50: 174, 80: 109, 100: 88, 125: 70 } },
  { pct: 60, values: { 50: 184, 80: 115, 100: 93, 125: 74 } },
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

const brimArgs = {
  pool_address: "brim-pool",
  amount_y: 12,
  amount_x: 0,
  bins_above: 0,
  bins_below: 35,
  bin_step: 125,
  mcap: 759_667,
  active_tvl: 16_793,
  deploy_share_of_active_tvl_pct: 10.36,
  volatility: 6.2381,
  price_change_pct: 80,
};
const brim = applyRangeWidthDecision(brimArgs, liveConfig());
assert.strictEqual(brim.ok, false, "BRIM-like oversize deploy share blocks in live mode");
assert.strictEqual(brim.decision.decision, "block", "BRIM-like decision is block");
assert.ok(brim.decision.reason_codes.includes("mcap_tier"), "BRIM-like mcap tier reason is present");
assert.ok(brim.decision.reason_codes.includes("volatility_bump"), "BRIM-like volatility bump reason is present");
assert.ok(brim.decision.reason_codes.includes("thin_active_tvl"), "BRIM-like thin active TVL reason is present");
assert.ok(brim.decision.reason_codes.includes("deploy_share_bump"), "BRIM-like deploy share bump reason is present");
assert.ok(brim.decision.reason_codes.includes("deploy_share_too_high"), "BRIM-like deploy share block reason is present");
assert.strictEqual(brim.decision.required_bins_below, 74, "BRIM-like required bins are widened before block reporting");
assert.strictEqual(brim.args.bins_below, 35, "blocked decision does not silently clamp or mutate to fallback");

const brimOverride = applyRangeWidthDecision(
  { ...brimArgs, active_tvl: 35_000, deploy_share_of_active_tvl_pct: 4.5 },
  liveConfig(),
);
assert.strictEqual(brimOverride.ok, true, "BRIM-like non-oversize deploy can proceed after override");
assert.strictEqual(brimOverride.decision.decision, "override", "BRIM-like 35 bins is overridden");
assert.strictEqual(brimOverride.args.bins_below, 74, "BRIM-like bins_below widens to required bins");
assert.ok(brimOverride.decision.reason_codes.includes("llm_bins_overridden"), "override reason is explicit");
assert.strictEqual(brimOverride.args.amount_y, 12, "range-width guard preserves amount_y");
assert.strictEqual(brimOverride.args.amount_x, 0, "range-width guard preserves SOL-only amount_x=0");
assert.strictEqual(brimOverride.args.bins_above, 0, "range-width guard preserves bins_above=0");

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
}, liveConfig());
assert.strictEqual(ansem.ok, true, "ANSEM-like volatile candidate can proceed after widening");
assert.strictEqual(ansem.decision.decision, "override", "ANSEM-like 35 bins is overridden");
assert.strictEqual(ansem.decision.target_downside_pct, 60, "ANSEM-like volatility reaches 60% downside target");
assert.strictEqual(ansem.args.bins_below, 74, "ANSEM-like required bins widen at 125 bps");

const lowStepMax = applyRangeWidthDecision({
  pool_address: "low-step-pool",
  amount_y: 12,
  amount_x: 0,
  bins_above: 0,
  bins_below: 35,
  bin_step: 50,
  mcap: 450_000,
  active_tvl: 50_000,
  deploy_share_of_active_tvl_pct: 2,
  volatility: 3,
}, liveConfig());
assert.strictEqual(lowStepMax.ok, false, "low-step pool requiring more than max blocks");
assert.strictEqual(lowStepMax.decision.required_bins_below, 184, "low-step required bins are computed");
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
assert.strictEqual(safe.decision.decision, "keep", "safe/deeper pool keeps original bins");
assert.strictEqual(safe.args.bins_below, 35, "safe/deeper pool keeps 35 bins");

const missing = applyRangeWidthDecision({
  pool_address: "missing-input-pool",
  amount_y: 12,
  amount_x: 0,
  bins_above: 0,
  bins_below: 35,
  mcap: 759_667,
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
  mcap: 399_999,
  active_tvl: 50_000,
  deploy_share_of_active_tvl_pct: 1,
}, liveConfig());
assert.strictEqual(belowFloor.ok, false, "mcap below configured floor blocks");
assert.ok(belowFloor.decision.reason_codes.includes("mcap_below_configured_floor"), "mcap floor reason is explicit");

const shadowOnly = applyRangeWidthDecision(brimArgs, liveConfig({
  strategy: { dynamicRangeWidthMode: "shadow" },
}));
assert.strictEqual(shadowOnly.ok, true, "shadow mode does not block");
assert.strictEqual(shadowOnly.decision.decision, "shadow_only", "shadow mode reports shadow_only");
assert.strictEqual(shadowOnly.decision.live_applied, false, "shadow mode does not apply live args");
assert.strictEqual(shadowOnly.args.bins_below, 35, "shadow mode leaves LLM bins unchanged");

const disabled = applyRangeWidthDecision(brimArgs, liveConfig({
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
assert.strictEqual(policy.minBins, 35, "policy resolves min bins");

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
assert.ok(definitionsSource.includes("active_tvl: { type: \"number\""), "deploy tool schema accepts active_tvl");
assert.ok(configBuilderSource.includes("dynamicRangeWidthEnabled: u.dynamicRangeWidthEnabled ?? false"), "config builder defaults guard disabled");
assert.ok(exampleConfigSource.includes("\"dynamicRangeWidthEnabled\": false"), "example config keeps guard disabled");
assert.ok(exampleConfigSource.includes("\"dynamicRangeWidthMaxBins\": 120"), "example config exposes max bins");

const proof = {
  success: true,
  checks: [
    "coverage math matches 55/58/60 percent target fixtures",
    "BRIM-like 35-bin input blocks on oversize deploy share or overrides to 74 bins when deploy share is allowed",
    "ANSEM-like volatility widens 35 bins to 74 bins at 125 bps",
    "low-step required bins over max blocks without clamp/fallback",
    "safe deeper pool keeps 35 bins",
    "missing lower-mcap inputs and mcap floor fail closed in live mode",
    "shadow and disabled modes attach telemetry without mutating deploy args",
    "executor, autonomous, direct tool, and CLI deploy paths share executeTool guard",
  ],
  samples: {
    brim_block: brim.decision,
    brim_override: brimOverride.decision,
    ansem: ansem.decision,
    low_step_max: lowStepMax.decision,
    safe: safe.decision,
    missing: missing.decision,
  },
};

console.log(JSON.stringify(proof, null, 2));
