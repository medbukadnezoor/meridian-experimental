#!/usr/bin/env node
import assert from "assert/strict";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { buildConfig } from "../config-builder.js";
import {
  classifyAdaptiveCloseReason,
  selectAdaptiveCloseMode,
} from "../tools/dlmm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function source(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

const configSource = source("config-builder.js");
const exampleConfigSource = source("user-config.example.json");
const dlmmSource = source("tools/dlmm.js");
const executorSource = source("tools/executor.js");

const defaultConfig = buildConfig({}, {});
assert.equal(defaultConfig.management.adaptiveCloseModeEnabled, false);
assert.equal(defaultConfig.management.adaptiveCloseFastZapTimeoutMs, 1500);
assert.equal(defaultConfig.management.adaptiveCloseModes.rolling_drawdown, "fast_zap_attempt");
assert.equal(defaultConfig.management.adaptiveCloseModes.profit_giveback, "fast_zap_attempt");
assert.equal(defaultConfig.management.adaptiveCloseModes.hard_stop, "local_liquidity_first");

const enabledConfig = buildConfig({
  adaptiveCloseModeEnabled: true,
  adaptiveCloseFastZapTimeoutMs: 1200,
}, {});

const disabledUrgent = selectAdaptiveCloseMode({
  reason: "Rolling fast drawdown: peak +4.50% now -3.67%",
  urgent: true,
  relayEnabled: true,
  managementConfig: defaultConfig.management,
});
assert.equal(disabledUrgent.enabled, false);
assert.equal(disabledUrgent.selectedMode, "local_liquidity_first");
assert.equal(disabledUrgent.shouldAttemptRelay, false);

const disabledNormal = selectAdaptiveCloseMode({
  reason: "Manual operator close",
  urgent: false,
  relayEnabled: true,
  managementConfig: defaultConfig.management,
});
assert.equal(disabledNormal.selectedMode, "relay_zap_normal");
assert.equal(disabledNormal.shouldAttemptRelay, true);

const rolling = selectAdaptiveCloseMode({
  reason: "Rolling fast drawdown: peak +4.50% now -0.07%",
  urgent: true,
  relayEnabled: true,
  managementConfig: enabledConfig.management,
});
assert.equal(rolling.exitType, "rolling_drawdown");
assert.equal(rolling.selectedMode, "fast_zap_attempt");
assert.equal(rolling.shouldUseFastZapBudget, true);
assert.equal(rolling.shouldAttemptRelay, true);
assert.equal(rolling.fastZapTimeoutMs, 1200);

const giveback = selectAdaptiveCloseMode({
  reason: "Profit giveback emergency: peak +6.1% floor +2.0%",
  urgent: true,
  relayEnabled: true,
  managementConfig: enabledConfig.management,
});
assert.equal(giveback.exitType, "profit_giveback");
assert.equal(giveback.selectedMode, "fast_zap_attempt");

for (const [reason, exitType] of [
  ["Hard stop loss: -15.1%", "hard_stop"],
  ["Fast stop loss: -10.2%", "fast_stop"],
  ["Velocity stop loss: -3.4% in window", "velocity_stop"],
  ["Early dump: -8.4% inside 20m", "fast_stop"],
]) {
  const decision = selectAdaptiveCloseMode({
    reason,
    urgent: true,
    relayEnabled: true,
    managementConfig: enabledConfig.management,
  });
  assert.equal(classifyAdaptiveCloseReason(reason, true), exitType);
  assert.equal(decision.selectedMode, "local_liquidity_first");
  assert.equal(decision.shouldAttemptRelay, false);
}

assert.match(configSource, /adaptiveCloseModeEnabled:\s*u\.adaptiveCloseModeEnabled\s*\?\?\s*false/);
assert.match(configSource, /adaptiveCloseFastZapTimeoutMs:\s*u\.adaptiveCloseFastZapTimeoutMs\s*\?\?\s*1500/);
assert.match(exampleConfigSource, /"adaptiveCloseModeEnabled":\s*false/);
assert.match(exampleConfigSource, /"rolling_drawdown":\s*"fast_zap_attempt"/);
assert.match(dlmmSource, /selectAdaptiveCloseMode\(\{[\s\S]*managementConfig:\s*config\.management/);
assert.match(dlmmSource, /if \(closeModeDecision\.shouldAttemptRelay\)/);
assert.doesNotMatch(dlmmSource, /if \(!urgent && shouldUseLpAgentRelay\(\)\)/);
assert.match(dlmmSource, /assertFastZapSubmitBudget\(closeModeAudit,\s*fastZapDeadlineAt\);\s*relaySubmitted = true/);
assert.match(dlmmSource, /if \(relaySubmitted\) throw relayError/);
assert.match(dlmmSource, /falling back to local close \+ Jupiter autoswap/);
assert.match(dlmmSource, /close_mode:\s*closeModeContext\(closeModeAudit\)/);
assert.match(dlmmSource, /local_close_ms/);
assert.match(executorSource, /delayCloseActionLog = name === "close_position"/);
assert.match(executorSource, /post_close_swap_ms/);
assert.match(executorSource, /final_sol_received/);
assert.match(executorSource, /!result\.skip_post_close_swap/);

const proof = {
  success: true,
  default_off: defaultConfig.management.adaptiveCloseModeEnabled === false,
  disabled_urgent_preserves_local: disabledUrgent.selectedMode === "local_liquidity_first" && disabledUrgent.shouldAttemptRelay === false,
  disabled_normal_preserves_relay: disabledNormal.selectedMode === "relay_zap_normal" && disabledNormal.shouldAttemptRelay === true,
  rolling_drawdown_fast_zap: rolling.selectedMode === "fast_zap_attempt" && rolling.shouldUseFastZapBudget === true,
  profit_giveback_fast_zap: giveback.selectedMode === "fast_zap_attempt",
  catastrophic_local_first: true,
  fast_zap_submit_guard_present: /assertFastZapSubmitBudget\(closeModeAudit,\s*fastZapDeadlineAt\);\s*relaySubmitted = true/.test(dlmmSource),
  fallback_before_submit_present: /if \(relaySubmitted\) throw relayError/.test(dlmmSource),
  audit_fields_present: /close_mode:\s*closeModeContext\(closeModeAudit\)/.test(dlmmSource) && /post_close_swap_ms/.test(executorSource),
  source_safety: {
    deploys_or_closes_positions: false,
    restarts_processes: false,
    changes_live_config: false,
  },
};

console.log(JSON.stringify(proof, null, 2));
process.exit(0);
