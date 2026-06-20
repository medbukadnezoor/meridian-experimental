#!/usr/bin/env node
/**
 * Regression proof for Main OOR above-range hard-close policy.
 *
 * Runs in a temporary directory so state.js writes only temporary state.json.
 * Does not import index.js, start the bot, call trading APIs, or touch runtime files.
 */

import assert from "assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { dirname, join } from "path";
import { pathToFileURL, fileURLToPath } from "url";
import {
  allowsOutOfRangeExit,
  allowsRecoveryHoldNonFeeExit,
} from "../oor-exit-policy.js";

process.env.LOG_LEVEL = "error";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function recoveryConfig(overrides = {}) {
  return {
    recoveryHoldProfileEnabled: true,
    recoveryHoldNonFeeExitMinNetPnlPct: 0.25,
    requirePositivePnlForOutOfRangeExit: true,
    requirePositivePnlForLowYieldExit: true,
    earlyDumpPct: null,
    stopLossPct: null,
    stopLossConfirmDelayMs: 0,
    hardStopLossPct: -25,
    stopLossFastClosePct: null,
    stopLossVelocityWindowMs: 90_000,
    stopLossVelocityClosePct: null,
    rollingDrawdownExitEnabled: false,
    trailingTakeProfit: false,
    outOfRangeWaitMinutes: 60,
    outOfRangeHardCloseMinutes: 120,
    minFeePerTvl24h: 7,
    minAgeBeforeYieldCheck: 20,
    ...overrides,
  };
}

function positionData(position, overrides = {}) {
  return {
    position,
    pool: `pool-${position}`,
    pair: `TEST-${position}`,
    pool_name: `TEST-${position}`,
    pnl_pct_suspicious: false,
    pnl_pct: 0.05,
    in_range: false,
    source_in_range: false,
    fee_per_tvl_24h: 10,
    age_minutes: 180,
    active_bin: 170,
    lower_bin: 100,
    upper_bin: 150,
    active_bin_source: "live_bin_data",
    lower_bin_source: "live_bin_data",
    upper_bin_source: "live_bin_data",
    range_side: "above_range",
    ...overrides,
  };
}

function readState(tempDir) {
  return JSON.parse(fs.readFileSync(path.join(tempDir, "state.json"), "utf8"));
}

function writeState(tempDir, state) {
  fs.writeFileSync(path.join(tempDir, "state.json"), JSON.stringify(state, null, 2));
}

function setOorAge(tempDir, position, minutes) {
  const state = readState(tempDir);
  assert.ok(state.positions?.[position], `missing tracked position ${position}`);
  state.positions[position].out_of_range_since = new Date(Date.now() - minutes * 60_000).toISOString();
  writeState(tempDir, state);
}

async function main() {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-oor-above-hard-close-"));

  try {
    process.chdir(tempDir);
    const stateModule = await import(`${pathToFileURL(join(ROOT, "state.js")).href}?proof=${Date.now()}`);
    const { trackPosition, updatePnlAndCheckExits } = stateModule;

    function track(position) {
      trackPosition({
        position,
        pool: `pool-${position}`,
        pool_name: `TEST-${position}`,
        strategy: "bid_ask",
      });
    }

    assert.equal(
      allowsRecoveryHoldNonFeeExit(0.05, recoveryConfig(), true),
      false,
      "baseline recovery-hold non-fee floor should still reject +0.05%",
    );
    assert.equal(
      allowsOutOfRangeExit(0.05, recoveryConfig(), { rangeSide: "above_range", oorStage: "hard" }),
      true,
      "hard above-range OOR should bypass +0.25% floor at non-negative PnL",
    );
    assert.equal(
      allowsOutOfRangeExit(-0.01, recoveryConfig(), { rangeSide: "above_range", oorStage: "hard" }),
      false,
      "hard above-range OOR should not bypass positive-only protection for negative PnL",
    );

    track("above-soft");
    setOorAge(tempDir, "above-soft", 70);
    const aboveSoft = updatePnlAndCheckExits(
      "above-soft",
      positionData("above-soft"),
      recoveryConfig(),
    );
    assert.equal(aboveSoft, null, "soft above-range OOR below +0.25% should still hold");

    track("above-hard");
    setOorAge(tempDir, "above-hard", 130);
    const aboveHard = updatePnlAndCheckExits(
      "above-hard",
      positionData("above-hard"),
      recoveryConfig(),
    );
    assert.equal(aboveHard?.action, "OUT_OF_RANGE", "hard above-range OOR should close at non-negative PnL");
    assert.equal(aboveHard?.oor_stage, "hard", "hard above-range OOR should preserve hard stage");
    assert.equal(aboveHard?.urgent, true, "hard above-range OOR should stay urgent");
    assert.equal(aboveHard?.indicatorPolicy, "bypass", "hard above-range OOR should bypass indicators");

    track("above-hard-negative");
    setOorAge(tempDir, "above-hard-negative", 130);
    const aboveHardNegative = updatePnlAndCheckExits(
      "above-hard-negative",
      positionData("above-hard-negative", { pnl_pct: -0.01 }),
      recoveryConfig(),
    );
    assert.equal(aboveHardNegative, null, "hard above-range OOR should not close negative PnL");

    track("below-hard");
    setOorAge(tempDir, "below-hard", 130);
    const belowHard = updatePnlAndCheckExits(
      "below-hard",
      positionData("below-hard", {
        active_bin: 90,
        range_side: "below_range",
      }),
      recoveryConfig(),
    );
    assert.equal(belowHard, null, "hard below-range OOR below +0.25% should still hold");

    const indexSource = fs.readFileSync(join(ROOT, "index.js"), "utf8");
    const stateSource = fs.readFileSync(join(ROOT, "state.js"), "utf8");
    assert.match(indexSource, /allowsOutOfRangeExit\(currentPnlPct,\s*managementConfig,\s*\{\s*rangeSide,\s*forceAboveRange:\s*true\s*\}\)/);
    assert.match(indexSource, /allowsOutOfRangeExit\(currentPnlPct,\s*managementConfig,\s*\{\s*rangeSide,\s*oorStage:\s*oorExit\?\.stage\s*\}\)/);
    assert.match(stateSource, /allowsOutOfRangeExit\(currentPnlPct,\s*mgmtConfig,\s*\{\s*rangeSide:\s*rangeState\.derived_range_side,\s*oorStage:\s*oorExit\?\.stage,\s*\}\)/);

    console.log(JSON.stringify({
      success: true,
      checks: [
        "hard above-range OOR bypasses recovery floor at non-negative PnL",
        "soft above-range OOR still respects recovery floor",
        "hard above-range OOR does not close negative PnL",
        "hard below-range OOR still respects recovery floor",
        "poller deterministic OOR rules use shared above-range escape policy",
        "state OOR exit rules use shared above-range escape policy",
      ],
      cases: {
        aboveSoft: aboveSoft?.action ?? null,
        aboveHard: aboveHard?.action ?? null,
        aboveHardStage: aboveHard?.oor_stage ?? null,
        aboveHardUrgent: aboveHard?.urgent ?? null,
        aboveHardNegative: aboveHardNegative?.action ?? null,
        belowHard: belowHard?.action ?? null,
      },
    }, null, 2));
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
