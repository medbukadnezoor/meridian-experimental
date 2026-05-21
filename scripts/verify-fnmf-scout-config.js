#!/usr/bin/env node
/**
 * Focused proof that the FNmf Scout template resolves through config-builder.
 *
 * This does not import index.js, read .env, call PM2/SSH, or run bot runtime.
 */

import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildConfig } from "../config-builder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

const template = readJson("user-config.oracle-scout.template.json");
const strategies = readJson("strategy-library.scout-tight.example.json");
const runtimeStrategies = fs.existsSync(path.join(ROOT, "strategy-library.json"))
  ? readJson("strategy-library.json")
  : null;
const resolved = buildConfig(template, {});
const fnmfProfile = strategies.strategies?.fnmf_hot_fee_scalp;
const runtimeFnmfProfile = runtimeStrategies?.strategies?.fnmf_hot_fee_scalp ?? null;

assert.ok(fnmfProfile, "strategy-library contains fnmf_hot_fee_scalp profile");
assert.strictEqual(strategies.active, "scout_tight_bidask_retrace", "existing active strategy remains unchanged");
if (runtimeStrategies) {
  assert.ok(runtimeFnmfProfile, "local runtime strategy-library contains fnmf_hot_fee_scalp profile when present");
  assert.ok(runtimeStrategies.strategies?.[runtimeStrategies.active], "local runtime active strategy resolves when present");
}
assert.strictEqual(fnmfProfile.lp_strategy, "bid_ask", "FNmf profile is bid_ask");
assert.strictEqual(fnmfProfile.entry?.single_side, "sol", "FNmf profile is single-sided SOL");
assert.strictEqual(Number(fnmfProfile.range?.bins_below), 70, "FNmf profile carries configurable 70-bin range");

assert.strictEqual(resolved.risk.maxPositions, 3, "Scout FNmf template resolves maxPositions=3");
assert.strictEqual(resolved.risk.maxDeployAmount, 0.15, "Scout FNmf template resolves maxDeployAmount=0.15");
assert.strictEqual(resolved.management.deployAmountSol, 0.15, "Scout FNmf template resolves deployAmountSol=0.15");
assert.strictEqual(resolved.strategy.strategy, "bid_ask", "Scout FNmf template resolves bid_ask deploy strategy");
assert.strictEqual(resolved.strategy.binsBelow, 70, "Scout FNmf template resolves binsBelow=70");
assert.strictEqual(resolved.schedule.pnlPollIntervalMs, 15000, "Scout FNmf template resolves 15s poll interval");

assert.strictEqual(resolved.indicators.entryPreset, "rsi_momentum", "Scout FNmf template uses RSI momentum entry preset");
assert.strictEqual(resolved.indicators.rsiLength, 14, "Scout FNmf template uses RSI14");
assert.strictEqual(resolved.indicators.rsiMomentumMin, 60, "Scout FNmf template resolves momentum RSI min");
assert.strictEqual(resolved.indicators.rsiMomentumMax, 90, "Scout FNmf template resolves momentum RSI max");

assert.strictEqual(resolved.screening.preEntryMomentumGates.enabled, true, "pre-entry momentum gates are enabled");
assert.strictEqual(resolved.screening.preEntryMomentumGates.minReturnPct, 0, "pre-entry return threshold resolves");
assert.strictEqual(resolved.screening.preEntryMomentumGates.minVolumeRatio, 1, "volume ratio threshold resolves");
assert.strictEqual(resolved.screening.preEntryMomentumGates.missingDataPolicy, "warn", "missing-data policy resolves");

assert.strictEqual(resolved.management.feeExitPolicy.enabled, true, "fee exit policy resolves enabled");
assert.strictEqual(resolved.management.feeExitPolicy.shadowOnly, true, "fee exit policy resolves shadowOnly=true");
assert.strictEqual(resolved.management.feeExitPolicy.feeHarvestMinFeePctOfEntry, 0.5, "fee harvest threshold resolves");
assert.strictEqual(resolved.management.feeExitPolicy.noFeeAbortMaxHoldMinutes, 1, "no-fee abort threshold resolves");
assert.strictEqual(resolved.management.feeExitPolicy.feeConditionalAbortMinLossPct, 5, "fee conditional abort threshold resolves");
assert.strictEqual(resolved.management.feeExitPolicy.emergencyFailsafeMinLossPct, 12, "emergency failsafe threshold resolves");
assert.strictEqual(resolved.management.feeExitPolicy.maxHoldTimeoutMinutes, 10, "max hold threshold resolves");

console.log(JSON.stringify({
  ok: true,
  profile: fnmfProfile.id,
  runtimeProfilePresent: Boolean(runtimeFnmfProfile),
  trackedExampleActive: strategies.active,
  scout_config: {
    deployAmountSol: resolved.management.deployAmountSol,
    maxDeployAmount: resolved.risk.maxDeployAmount,
    maxPositions: resolved.risk.maxPositions,
    pnlPollIntervalMs: resolved.schedule.pnlPollIntervalMs,
    entryPreset: resolved.indicators.entryPreset,
    feeExitShadowOnly: resolved.management.feeExitPolicy.shadowOnly,
  },
}, null, 2));
