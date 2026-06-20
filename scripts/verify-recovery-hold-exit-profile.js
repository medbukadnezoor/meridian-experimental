#!/usr/bin/env node
/**
 * Synthetic proof for the Main recovery-hold exit profile.
 *
 * Runs in a temporary directory so state.js writes only temporary state.json/logs.
 * Does not import index.js, run the bot, call trading APIs, or read live config.
 */

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { dirname, join } from "path";
import { pathToFileURL, fileURLToPath } from "url";
import { evaluateFeeExitPolicy } from "../fee-exit-policy.js";
import { shouldTriggerActiveBinEmergencyExit } from "../active-bin-oracle.js";
import { buildConfig } from "../config-builder.js";

process.env.LOG_LEVEL = "error";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function recoveryConfig(overrides = {}) {
  return {
    recoveryHoldProfileEnabled: true,
    recoveryHoldNonFeeExitMinNetPnlPct: 0.25,
    requirePositivePnlForOutOfRangeExit: true,
    requirePositivePnlForLowYieldExit: true,
    requirePositivePnlForMaxHoldExit: true,
    earlyDumpPct: null,
    stopLossPct: null,
    stopLossConfirmDelayMs: 0,
    hardStopLossPct: -25,
    stopLossFastClosePct: null,
    stopLossVelocityWindowMs: 90000,
    stopLossVelocityClosePct: null,
    rollingDrawdownExitEnabled: false,
    trailingTakeProfit: true,
    trailingTriggerPct: 1.5,
    trailingDropPct: 0.75,
    profitGivebackEmergencyEnabled: true,
    profitGivebackTriggerPct: 6,
    profitGivebackFloorPct: 2,
    outOfRangeWaitMinutes: 60,
    outOfRangeHardCloseMinutes: 120,
    minFeePerTvl24h: 7,
    minAgeBeforeYieldCheck: 20,
    ...overrides,
  };
}

function makePosition(position, overrides = {}) {
  return {
    position,
    pool: `pool-${position}`,
    pair: `TEST-${position}`,
    pool_name: `TEST-${position}`,
    pnl_pct_suspicious: false,
    pnl_pct: -10,
    in_range: true,
    fee_per_tvl_24h: 10,
    age_minutes: 60,
    ...overrides,
  };
}

function readState(tempDir) {
  return JSON.parse(fs.readFileSync(path.join(tempDir, "state.json"), "utf8"));
}

function writeState(tempDir, state) {
  fs.writeFileSync(path.join(tempDir, "state.json"), JSON.stringify(state, null, 2));
}

function setTrackedFields(tempDir, position, fields) {
  const state = readState(tempDir);
  assert.ok(state.positions?.[position], `missing tracked position ${position}`);
  Object.assign(state.positions[position], fields);
  writeState(tempDir, state);
}

function feeDecision({ pnlPct, feePct = 0.01, ageMinutes = 120, overrides = {} } = {}) {
  return evaluateFeeExitPolicy({
    position: {
      position: "fee-proof",
      pair: "FEE-SOL",
      age_minutes: ageMinutes,
      pnl_pct: pnlPct,
      total_value_usd: 5 * (1 + (pnlPct / 100)),
      unclaimed_fees_usd: feePct,
    },
    tracked: { amount_sol: 5, total_fees_claimed_sol: 0 },
    managementConfig: {
      solMode: true,
      feeExitPolicy: {
        enabled: true,
        shadowOnly: false,
        recoveryHoldPositiveOnly: true,
        dustFloor: 0.000001,
        feeHarvestEnabled: true,
        feeHarvestMinHoldMinutes: 8,
        feeHarvestMinFeePctOfEntry: 0.75,
        feeHarvestMinNetPnlPct: 0.25,
        feeHarvestBypassConfluenceMinFeePctOfEntry: 2.0,
        feeHarvestBypassConfluenceMinNetPnlPct: 0.25,
        feeHarvestBypassConfluenceStrongNetPnlPct: 0.75,
        noFeeAbortEnabled: true,
        noFeeAbortMaxHoldMinutes: 20,
        noFeeAbortMaxFeePctOfEntry: 0.08,
        noFeeAbortMaxNetPnlPct: -0.5,
        feeConditionalAbortEnabled: true,
        feeConditionalAbortMinHoldMinutes: 12,
        feeConditionalAbortMaxFeePctOfEntry: 0.2,
        feeConditionalAbortMaxNetPnlPct: 0,
        feeConditionalAbortMinLossPct: 2,
        emergencyFailsafeEnabled: true,
        emergencyFailsafeMinHoldMinutes: 0,
        emergencyFailsafeMaxFeePctOfEntry: 0.5,
        emergencyFailsafeMinLossPct: 6,
        maxHoldTimeoutEnabled: true,
        maxHoldTimeoutMinutes: 90,
        maxHoldTimeoutMinNetPnlPct: 0.25,
        ...overrides,
      },
    },
  }).decision;
}

async function main() {
  const originalCwd = process.cwd();
  const originalStdoutWrite = process.stdout.write;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-recovery-hold-proof-"));

  try {
    process.chdir(tempDir);
    fs.mkdirSync("logs", { recursive: true });
    process.stdout.write = () => true;
    const stateModule = await import(`${pathToFileURL(join(ROOT, "state.js")).href}?proof=${Date.now()}`);
    const { trackPosition, updatePnlAndCheckExits, queueTrailingDropConfirmation } = stateModule;

    function track(position) {
      trackPosition({
        position,
        pool: `pool-${position}`,
        pool_name: `TEST-${position}`,
        strategy: "bid_ask",
      });
    }

    for (const pnlPct of [-1, -4, -8, -15, -24.9]) {
      const position = `hold-${String(Math.abs(pnlPct)).replace(".", "-")}`;
      track(position);
      const exit = updatePnlAndCheckExits(position, makePosition(position, { pnl_pct: pnlPct, age_minutes: 5 }), recoveryConfig());
      assert.equal(exit, null, `recovery profile should hold at ${pnlPct}%`);
    }

    track("catastrophic");
    const catastrophic = updatePnlAndCheckExits("catastrophic", makePosition("catastrophic", { pnl_pct: -25.1 }), recoveryConfig());
    assert.equal(catastrophic?.action, "STOP_LOSS", "catastrophic hard stop should close at <= -25%");
    assert.equal(catastrophic?.urgent, true, "catastrophic hard stop should be urgent");

    track("trailing-negative");
    setTrackedFields(tempDir, "trailing-negative", { peak_pnl_pct: 3, trailing_active: true });
    const trailingNegative = updatePnlAndCheckExits(
      "trailing-negative",
      makePosition("trailing-negative", { pnl_pct: -0.4 }),
      recoveryConfig(),
    );
    assert.equal(trailingNegative, null, "trailing TP should not close a negative recovery-hold position");

    track("giveback-negative");
    setTrackedFields(tempDir, "giveback-negative", { peak_pnl_pct: 7.2 });
    const givebackNegative = updatePnlAndCheckExits(
      "giveback-negative",
      makePosition("giveback-negative", { pnl_pct: -0.5 }),
      recoveryConfig(),
    );
    assert.equal(givebackNegative, null, "profit giveback should not close a negative recovery-hold position");

    track("oor-negative");
    setTrackedFields(tempDir, "oor-negative", { out_of_range_since: new Date(Date.now() - 70 * 60_000).toISOString() });
    const oorNegative = updatePnlAndCheckExits(
      "oor-negative",
      makePosition("oor-negative", { pnl_pct: -3, in_range: false }),
      recoveryConfig(),
    );
    assert.equal(oorNegative, null, "OOR should be positive-only under recovery-hold");

    track("oor-positive");
    setTrackedFields(tempDir, "oor-positive", { out_of_range_since: new Date(Date.now() - 70 * 60_000).toISOString() });
    const oorBelowFloor = updatePnlAndCheckExits(
      "oor-positive",
      makePosition("oor-positive", { pnl_pct: 0.2, in_range: false }),
      recoveryConfig(),
    );
    assert.equal(oorBelowFloor, null, "OOR below recovery-hold non-fee PnL floor should hold");
    const oorPositive = updatePnlAndCheckExits(
      "oor-positive",
      makePosition("oor-positive", { pnl_pct: 0.3, in_range: false }),
      recoveryConfig(),
    );
    assert.equal(oorPositive?.action, "OUT_OF_RANGE", "OOR above recovery-hold non-fee PnL floor may close");

    track("low-yield-negative");
    const lowYieldNegative = updatePnlAndCheckExits(
      "low-yield-negative",
      makePosition("low-yield-negative", { pnl_pct: -2, fee_per_tvl_24h: 0.1, age_minutes: 25 }),
      recoveryConfig(),
    );
    assert.equal(lowYieldNegative, null, "low-yield should be positive-only under recovery-hold");

    track("low-yield-positive");
    const lowYieldBelowFloor = updatePnlAndCheckExits(
      "low-yield-positive",
      makePosition("low-yield-positive", { pnl_pct: 0.1, fee_per_tvl_24h: 0.1, age_minutes: 25 }),
      recoveryConfig(),
    );
    assert.equal(lowYieldBelowFloor, null, "low-yield below recovery-hold non-fee PnL floor should hold");
    const lowYieldPositive = updatePnlAndCheckExits(
      "low-yield-positive",
      makePosition("low-yield-positive", { pnl_pct: 0.3, fee_per_tvl_24h: 0.1, age_minutes: 25 }),
      recoveryConfig(),
    );
    assert.equal(lowYieldPositive?.action, "LOW_YIELD", "low-yield above recovery-hold non-fee PnL floor may close");

    assert.equal(
      queueTrailingDropConfirmation("missing", 3, -0.5, 0.75, 0, recoveryConfig()),
      false,
      "trailing confirmation helper should reject negative recovery-hold current PnL",
    );

    assert.equal(feeDecision({ pnlPct: -7, overrides: { feeHarvestEnabled: false, noFeeAbortEnabled: false, feeConditionalAbortEnabled: false } }), null, "fee emergency failsafe should not close negative recovery-hold position");
    assert.equal(feeDecision({ pnlPct: -0.1, feePct: 0.05 }), null, "fee harvest should not close negative recovery-hold position");
    assert.equal(feeDecision({ pnlPct: -1, overrides: { feeHarvestEnabled: false } })?.rule ?? null, null, "no-fee abort should not close negative recovery-hold position");
    assert.equal(feeDecision({ pnlPct: -3, overrides: { feeHarvestEnabled: false, noFeeAbortEnabled: false } })?.rule ?? null, null, "fee-conditional abort should not close negative recovery-hold position");
    assert.equal(feeDecision({ pnlPct: 0.4, feePct: 0.05 })?.rule, "fee_harvest", "positive fee harvest remains enabled");
    assert.equal(feeDecision({ pnlPct: 0.3, feePct: 0.001, overrides: { feeHarvestEnabled: false, noFeeAbortEnabled: false, feeConditionalAbortEnabled: false, emergencyFailsafeEnabled: false } })?.rule, "max_hold_timeout", "positive max-hold fee exit remains enabled");

    assert.equal(
      shouldTriggerActiveBinEmergencyExit({ shadow_velocity_signal: "rug_like_extreme", pnl_pct: -1 }),
      true,
      "legacy helper default remains live-capable for explicit callers",
    );
    assert.equal(
      shouldTriggerActiveBinEmergencyExit({ shadow_velocity_signal: "rug_like_extreme", pnl_pct: -1 }, { enabled: false }),
      false,
      "recovery profile can disable active-bin velocity emergency by config",
    );

    const example = JSON.parse(fs.readFileSync(join(ROOT, "user-config.example.json"), "utf8"));
    const built = buildConfig(example, {});
    assert.equal(built.management.recoveryHoldProfileEnabled, true, "example enables recovery-hold profile");
    assert.equal(built.management.recoveryHoldNonFeeExitMinNetPnlPct, 0.25, "example gates non-fee recovery exits to +0.25% PnL");
    assert.equal(built.management.stopLossPct, null, "example disables ordinary stop loss");
    assert.equal(built.management.hardStopLossPct, -25, "example keeps catastrophic -25% hard stop");
    assert.equal(built.management.rollingDrawdownExitEnabled, false, "example disables rolling drawdown exit");
    assert.equal(built.management.earlyDumpPct, null, "example disables early dump");
    assert.equal(built.management.supertrendLossExitEnabled, false, "example disables Supertrend loss exit");
    assert.equal(built.management.requirePositivePnlForOutOfRangeExit, true, "example gates OOR exits to positive PnL");
    assert.equal(built.management.requirePositivePnlForLowYieldExit, true, "example gates low-yield exits to positive PnL");
    assert.equal(built.management.requirePositivePnlForMaxHoldExit, true, "example gates legacy max-hold exits to positive PnL");
    assert.equal(built.management.feeExitPolicy.recoveryHoldPositiveOnly, true, "example gates fee exits to positive PnL");
    assert.equal(built.management.feeExitPolicy.feeHarvestMinFeePctOfEntry, 0.75, "example keeps base fee harvest fee floor at 0.75%");
    assert.equal(built.management.feeExitPolicy.feeHarvestMinNetPnlPct, 0.25, "example keeps base fee harvest net PnL floor at +0.25%");
    assert.equal(built.management.feeExitPolicy.feeHarvestBypassConfluenceMinFeePctOfEntry, 2.0, "example high-fee harvest bypass requires 2.0% fees");
    assert.equal(built.management.feeExitPolicy.feeHarvestBypassConfluenceMinNetPnlPct, 0.25, "example high-fee harvest bypass requires +0.25% net PnL");
    assert.equal(built.management.feeExitPolicy.feeHarvestBypassConfluenceStrongNetPnlPct, 0.75, "example strong net harvest bypass requires +0.75% net PnL");
    assert.equal(built.management.feeExitPolicy.exitConfluenceAggregateMin, 3, "example targets locally rolled 3m confluence candles");
    assert.equal(built.management.feeExitPolicy.exitConfluenceLookbackMinutes, 90, "example uses 90m confluence lookback");
    assert.equal(built.management.feeExitPolicy.exitConfluenceClosedCandlesOnly, true, "example uses closed confluence candles only");
    assert.equal(built.management.feeExitPolicy.exitConfluenceCandleCloseLagSeconds, 10, "example waits 10s after candle close");
    assert.equal(built.management.activeBinVelocityEmergencyLiveEnabled, false, "example disables active-bin velocity live emergency");
    assert.equal(built.management.activeBinBelowRangeEmergencyLiveEnabled, false, "example keeps below-range emergency disabled");

    process.stdout.write = originalStdoutWrite;
    console.log(JSON.stringify({
      success: true,
      heldNegativePnlCases: [-1, -4, -8, -15, -24.9],
      catastrophic: { action: catastrophic.action, urgent: catastrophic.urgent, reason: catastrophic.reason },
      positiveAllowed: {
        oor: oorPositive.action,
        lowYield: lowYieldPositive.action,
        feeHarvest: "fee_harvest",
        maxHoldTimeout: "max_hold_timeout",
      },
      activeBinVelocityLiveEnabled: built.management.activeBinVelocityEmergencyLiveEnabled,
    }, null, 2));
    process.exit(0);
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ success: false, error: error.message }, null, 2));
  process.exit(1);
});
