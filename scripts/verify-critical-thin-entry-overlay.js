#!/usr/bin/env node
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildConfig } from "../config-builder.js";
import { evaluateCriticalThinEntryOverlay } from "../critical-thin-entry-overlay.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function runtimeConfig(overrides = {}) {
  return {
    screening: {
      criticalThinEntryOverlayEnabled: true,
      criticalThinEntryOverlayMode: "live",
      criticalThinMcapUsd: 300_000,
      criticalThinActiveTvlUsd: 5_000,
      criticalThinWatchMcapUsd: 500_000,
      criticalThinWatchActiveTvlUsd: 10_000,
      criticalThinRequireChartAccept: true,
      criticalThinMinFeeActiveTvlRatio: 3,
      criticalThinMinVolumeActiveTvlMultiple: 5,
      criticalThinBlockOnMissingInputs: true,
      ...(overrides.screening ?? {}),
    },
  };
}

function sizingDecision(overrides = {}) {
  return {
    enabled: true,
    mode: "live",
    live_applied: true,
    decision: "override",
    final_amount_y: 1.2,
    active_tvl_usd: 5_000,
    sol_usd: 70,
    hard_active_tvl_share_pct: 5,
    ...(overrides ?? {}),
  };
}

function acceptedGate(overrides = {}) {
  return {
    enabled: true,
    mode: "live",
    live_applied: true,
    result: "accept",
    ...(overrides ?? {}),
  };
}

const mcapCriticalMissingProof = evaluateCriticalThinEntryOverlay(
  { mcap: 299_999, active_tvl: 20_000 },
  runtimeConfig(),
  { fabriqOhlcvEntryGate: acceptedGate(), dynamicPoolSizingDecision: sizingDecision({ active_tvl_usd: 20_000 }) },
);
assert.strictEqual(mcapCriticalMissingProof.ok, false, "mcap below 300k blocks when fee/activity proof is missing");
assert.strictEqual(mcapCriticalMissingProof.overlay.bucket, "critical", "mcap below 300k is critical");
assert.ok(mcapCriticalMissingProof.overlay.reason_codes.includes("missing_fee_density"), "missing fee density is explicit");
assert.ok(mcapCriticalMissingProof.overlay.reason_codes.includes("missing_activity"), "missing activity is explicit");

const tvlCriticalMissingProof = evaluateCriticalThinEntryOverlay(
  { mcap: 900_000, active_tvl: 4_999, fee_tvl_ratio: 5, volume_active_tvl_multiple: 7 },
  runtimeConfig(),
  { fabriqOhlcvEntryGate: acceptedGate(), dynamicPoolSizingDecision: sizingDecision({ active_tvl_usd: 4_999, final_amount_y: 0.5 }) },
);
assert.strictEqual(tvlCriticalMissingProof.ok, true, "active TVL below 5k can pass when all proof is present");
assert.strictEqual(tvlCriticalMissingProof.overlay.bucket, "critical", "active TVL below 5k is critical");

const nonCritical = evaluateCriticalThinEntryOverlay(
  { mcap: 900_000, active_tvl: 30_000 },
  runtimeConfig(),
  { fabriqOhlcvEntryGate: acceptedGate({ result: "reject" }), dynamicPoolSizingDecision: null },
);
assert.strictEqual(nonCritical.ok, true, "non-critical pool bypasses overlay");
assert.strictEqual(nonCritical.overlay.bucket, "none", "non-critical bucket is none");

const missingClassifier = evaluateCriticalThinEntryOverlay(
  { fee_tvl_ratio: 5, volume_active_tvl_multiple: 7 },
  runtimeConfig(),
  { fabriqOhlcvEntryGate: acceptedGate(), dynamicPoolSizingDecision: sizingDecision({ active_tvl_usd: 20_000 }) },
);
assert.strictEqual(missingClassifier.ok, false, "missing mcap/active TVL cannot bypass live overlay classification");
assert.strictEqual(missingClassifier.overlay.bucket, "unknown", "missing classifier inputs are logged as unknown");
assert.ok(missingClassifier.overlay.reason_codes.includes("missing_mcap"), "missing mcap is explicit");
assert.ok(missingClassifier.overlay.reason_codes.includes("missing_active_tvl"), "missing active TVL is explicit");

const watchBand = evaluateCriticalThinEntryOverlay(
  { mcap: 400_000, active_tvl: 8_000 },
  runtimeConfig(),
  { fabriqOhlcvEntryGate: acceptedGate({ result: "reject" }), dynamicPoolSizingDecision: null },
);
assert.strictEqual(watchBand.ok, true, "watch band is shadow-only and does not block");
assert.strictEqual(watchBand.overlay.bucket, "watch", "watch band bucket is logged");
assert.strictEqual(watchBand.overlay.decision, "watch_only", "watch band decision is explicit");

const chartReject = evaluateCriticalThinEntryOverlay(
  { mcap: 250_000, active_tvl: 20_000, fee_tvl_ratio: 5, volume_active_tvl_multiple: 7 },
  runtimeConfig(),
  { fabriqOhlcvEntryGate: acceptedGate({ result: "reject" }), dynamicPoolSizingDecision: sizingDecision({ active_tvl_usd: 20_000 }) },
);
assert.strictEqual(chartReject.ok, false, "critical-thin Fabriq reject blocks");
assert.ok(chartReject.overlay.reason_codes.includes("fabriq_ohlcv_not_accept"), "chart reject reason is explicit");

const chartMissing = evaluateCriticalThinEntryOverlay(
  { mcap: 250_000, active_tvl: 20_000, fee_tvl_ratio: 5, volume_active_tvl_multiple: 7 },
  runtimeConfig(),
  { fabriqOhlcvEntryGate: acceptedGate({ result: "missing_evidence" }), dynamicPoolSizingDecision: sizingDecision({ active_tvl_usd: 20_000 }) },
);
assert.strictEqual(chartMissing.ok, false, "critical-thin missing chart evidence blocks");
assert.ok(chartMissing.overlay.reason_codes.includes("fabriq_ohlcv_not_accept"), "missing evidence is treated as not accepted");

const weakFee = evaluateCriticalThinEntryOverlay(
  { mcap: 250_000, active_tvl: 20_000, fee_tvl_ratio: 2.9, volume_active_tvl_multiple: 7 },
  runtimeConfig(),
  { fabriqOhlcvEntryGate: acceptedGate(), dynamicPoolSizingDecision: sizingDecision({ active_tvl_usd: 20_000 }) },
);
assert.strictEqual(weakFee.ok, false, "critical-thin weak fee density blocks");
assert.ok(weakFee.overlay.reason_codes.includes("fee_density_below_min"), "weak fee reason is explicit");

const weakActivity = evaluateCriticalThinEntryOverlay(
  { mcap: 250_000, active_tvl: 20_000, fee_tvl_ratio: 5, volume_active_tvl_multiple: 4.9 },
  runtimeConfig(),
  { fabriqOhlcvEntryGate: acceptedGate(), dynamicPoolSizingDecision: sizingDecision({ active_tvl_usd: 20_000 }) },
);
assert.strictEqual(weakActivity.ok, false, "critical-thin weak activity blocks");
assert.ok(weakActivity.overlay.reason_codes.includes("activity_below_min"), "weak activity reason is explicit");

const passed = evaluateCriticalThinEntryOverlay(
  { mcap: 250_000, active_tvl: 20_000, fee_tvl_ratio: 3, volume_active_tvl_multiple: 5 },
  runtimeConfig(),
  { fabriqOhlcvEntryGate: acceptedGate(), dynamicPoolSizingDecision: sizingDecision({ active_tvl_usd: 20_000 }) },
);
assert.strictEqual(passed.ok, true, "critical-thin chart accept plus fee/activity proof passes");
assert.strictEqual(passed.overlay.decision, "allow", "live critical pass is explicit");

const overShare = evaluateCriticalThinEntryOverlay(
  { mcap: 250_000, active_tvl: 20_000, fee_tvl_ratio: 3, volume_active_tvl_multiple: 5 },
  runtimeConfig(),
  { fabriqOhlcvEntryGate: acceptedGate(), dynamicPoolSizingDecision: sizingDecision({ active_tvl_usd: 20_000, final_amount_y: 20, sol_usd: 70 }) },
);
assert.strictEqual(overShare.ok, false, "critical-thin deploy share over cap blocks");
assert.ok(overShare.overlay.reason_codes.includes("dynamic_pool_sizing_over_share_cap"), "oversize reason is explicit");

const built = buildConfig({
  criticalThinEntryOverlayEnabled: true,
  criticalThinEntryOverlayMode: "live",
  criticalThinMcapUsd: 300_000,
  criticalThinActiveTvlUsd: 5_000,
  criticalThinMinFeeActiveTvlRatio: 3,
  criticalThinMinVolumeActiveTvlMultiple: 5,
});
assert.strictEqual(built.screening.criticalThinEntryOverlayEnabled, true, "config builder maps overlay enabled");
assert.strictEqual(built.screening.criticalThinEntryOverlayMode, "live", "config builder maps live mode");
assert.strictEqual(built.screening.criticalThinMcapUsd, 300_000, "config builder maps mcap threshold");

const executor = read("tools/executor.js");
const sizingIndex = executor.indexOf("applyDynamicPoolSizing(args, config");
const rangeIndex = executor.indexOf("applyRangeWidthDecision(args, config)");
const fabriqIndex = executor.indexOf("const fabriqOhlcvEntryGate = await evaluateFabriqOhlcvEntryGate");
const overlayIndex = executor.indexOf("const criticalThinOverlay = evaluateCriticalThinEntryOverlay");
const needleIndex = executor.indexOf("const targetPoolNeedleGuard = await evaluateTargetPoolNeedleDeployGuard");
const protectedIndex = executor.indexOf("if (PROTECTED_TOOLS.has(name))");
assert.ok(sizingIndex >= 0 && rangeIndex > sizingIndex, "dynamic pool sizing runs before range width");
assert.ok(fabriqIndex > rangeIndex, "Fabriq gate runs after range width");
assert.ok(overlayIndex > fabriqIndex, "critical-thin overlay runs after Fabriq gate");
assert.ok(needleIndex > overlayIndex, "target pool needle guard runs after critical-thin overlay");
assert.ok(protectedIndex > overlayIndex, "critical-thin overlay runs before protected tool execution");
assert.ok(executor.includes("critical_thin_entry_overlay"), "executor carries overlay metadata");
assert.ok(executor.includes("criticalThinEntryOverlayEnabled"), "operator config map includes overlay keys");

const definitions = read("tools/definitions.js");
assert.ok(definitions.includes("volume_active_tvl_multiple"), "deploy_position schema accepts activity proof");

const index = read("index.js");
assert.ok(index.includes("volume_active_tvl_multiple: candidate.volume_active_tvl_multiple"), "autonomous deploy passes activity proof");

const dlmm = read("tools/dlmm.js");
assert.ok(dlmm.includes("critical_thin_entry_overlay"), "DLMM deploy audit carries overlay metadata");

const configJs = read("config.js");
assert.ok(configJs.includes("criticalThinEntryOverlayEnabled"), "runtime reload maps overlay config");

const example = JSON.parse(read("user-config.example.json"));
assert.strictEqual(example.criticalThinEntryOverlayEnabled, true, "example config enables critical-thin overlay");
assert.strictEqual(example.criticalThinEntryOverlayMode, "live", "example config sets overlay live");
assert.strictEqual(example.dynamicRangeWidthEnabled, false, "example config keeps dynamic range width disabled");
assert.strictEqual(example.dynamicRangeWidthMode, "shadow", "example config keeps dynamic range width shadow");

console.log(JSON.stringify({
  success: true,
  cases: {
    mcapCriticalMissingProof: mcapCriticalMissingProof.overlay.decision,
    tvlCriticalPass: tvlCriticalMissingProof.overlay.decision,
    nonCritical: nonCritical.overlay.bucket,
    missingClassifier: missingClassifier.overlay.decision,
    watchBand: watchBand.overlay.decision,
    chartReject: chartReject.overlay.decision,
    chartMissing: chartMissing.overlay.decision,
    passed: passed.overlay.decision,
    overShare: overShare.overlay.decision,
  },
  checks: [
    "mcap below 300k blocks without proof",
    "active TVL below 5k is critical",
    "non-critical pool bypasses overlay",
    "missing classifier inputs block live overlay",
    "watch-band pool logs shadow-only metadata",
    "critical-thin Fabriq reject blocks",
    "critical-thin missing chart evidence blocks",
    "critical-thin chart accept plus fee/activity proof passes",
    "dynamic pool sizing stays before critical-thin overlay",
    "dynamic range width remains disabled in example config",
  ],
}, null, 2));
