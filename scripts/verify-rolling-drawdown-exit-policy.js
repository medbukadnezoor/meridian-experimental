#!/usr/bin/env node
/**
 * Synthetic proof for the nanocap rolling fast-drawdown exit.
 *
 * Runs in a temporary directory so state.js writes only temporary state.json/logs.
 * Does not import index.js, run the bot, or call trading APIs.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { dirname, join } from "path";
import { pathToFileURL, fileURLToPath } from "url";

process.env.LOG_LEVEL = "error";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function baseConfig(overrides = {}) {
  return {
    earlyDumpPct: -8,
    earlyDumpMaxAgeMin: 20,
    stopLossPct: -8,
    stopLossConfirmDelayMs: 15000,
    hardStopLossPct: -15,
    stopLossFastClosePct: -10,
    stopLossVelocityWindowMs: 90000,
    stopLossVelocityClosePct: -3,
    rollingDrawdownExitEnabled: true,
    rollingDrawdownWindowMs: 5400000,
    rollingDrawdownMinPeakPct: 1,
    rollingDrawdownCurrentPnlPct: -2,
    rollingDrawdownMinDropPct: 4,
    trailingTakeProfit: true,
    trailingTriggerPct: 6,
    trailingDropPct: 3,
    profitGivebackEmergencyEnabled: true,
    profitGivebackTriggerPct: 6,
    profitGivebackFloorPct: 2,
    outOfRangeWaitMinutes: 60,
    outOfRangeHardCloseMinutes: 120,
    minFeePerTvl24h: 4,
    minAgeBeforeYieldCheck: 60,
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

function backdateLatestHistoryPoint(tempDir, position, ageMs) {
  const state = readState(tempDir);
  const history = state.positions?.[position]?.pnl_history;
  assert(Array.isArray(history) && history.length > 0, `missing pnl_history for ${position}`);
  history[history.length - 1].ts = new Date(Date.now() - ageMs).toISOString();
  writeState(tempDir, state);
}

function getHistory(tempDir, position) {
  const state = readState(tempDir);
  return state.positions?.[position]?.pnl_history ?? [];
}

async function main() {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-rolling-drawdown-proof-"));
  let tempStateFileCreated = false;
  let tempDirRemoved = false;

  try {
    process.chdir(tempDir);

    const stateModule = await import(`${pathToFileURL(join(ROOT, "state.js")).href}?proof=${Date.now()}`);
    const policyModule = await import(`${pathToFileURL(join(ROOT, "stop-loss-policy.js")).href}?proof=${Date.now()}`);
    const { trackPosition, updatePnlAndCheckExits } = stateModule;
    const { buildRollingDrawdownExitDecision, calculateRollingPeakDrawdown } = policyModule;

    function track(position) {
      trackPosition({
        position,
        pool: `pool-${position}`,
        pool_name: `TEST-${position}`,
        strategy: "bid_ask",
      });
    }

    const pureDrawdown = calculateRollingPeakDrawdown([
      { ts: new Date(Date.now() - 60_000).toISOString(), pnl_pct: 3 },
    ], -2, 5_400_000);
    const pureDecision = buildRollingDrawdownExitDecision({
      currentPnlPct: -2,
      managementConfig: baseConfig(),
      rollingDrawdown: pureDrawdown,
    });
    assert(pureDecision?.action === "STOP_LOSS", "pure helper should produce STOP_LOSS for +3% -> -2%");
    assert(pureDecision?.urgent === true, "pure helper decision should be urgent");
    assert(String(pureDecision?.reason || "").startsWith("Rolling fast drawdown:"), "pure helper reason should be labeled");

    track("fires");
    const fireInitial = updatePnlAndCheckExits("fires", makePosition("fires", { pnl_pct: 3 }), baseConfig());
    assert(fireInitial == null, "initial +3% sample should not close");
    backdateLatestHistoryPoint(tempDir, "fires", 80 * 60_000);
    const fireExit = updatePnlAndCheckExits("fires", makePosition("fires", { pnl_pct: -2 }), baseConfig());
    assert(fireExit?.action === "STOP_LOSS", "+3% then -2% within 90m should close");
    assert(fireExit?.urgent === true, "rolling drawdown exit should be urgent");
    assert(String(fireExit?.reason || "").startsWith("Rolling fast drawdown:"), "rolling exit reason should be labeled");
    assert(String(fireExit?.reason || "").includes("drop 5.00pp"), "rolling exit reason should include pp drop");
    assert(getHistory(tempDir, "fires").length >= 2, "90m rolling rule should retain history older than the 90s velocity window");

    track("low-peak");
    updatePnlAndCheckExits("low-peak", makePosition("low-peak", { pnl_pct: 0.9 }), baseConfig());
    backdateLatestHistoryPoint(tempDir, "low-peak", 60 * 60_000);
    const lowPeak = updatePnlAndCheckExits("low-peak", makePosition("low-peak", { pnl_pct: -3.5 }), baseConfig());
    assert(lowPeak == null, "peak below +1% should not fire even with >=4pp drop");

    track("current-high");
    updatePnlAndCheckExits("current-high", makePosition("current-high", { pnl_pct: 3 }), baseConfig());
    backdateLatestHistoryPoint(tempDir, "current-high", 60 * 60_000);
    const currentHigh = updatePnlAndCheckExits("current-high", makePosition("current-high", { pnl_pct: -1.9 }), baseConfig());
    assert(currentHigh == null, "current PnL above -2% should not fire");

    track("small-drop");
    updatePnlAndCheckExits("small-drop", makePosition("small-drop", { pnl_pct: 1.5 }), baseConfig());
    backdateLatestHistoryPoint(tempDir, "small-drop", 60 * 60_000);
    const smallDrop = updatePnlAndCheckExits("small-drop", makePosition("small-drop", { pnl_pct: -2 }), baseConfig());
    assert(smallDrop == null, "drop below 4pp should not fire");

    track("stale");
    updatePnlAndCheckExits("stale", makePosition("stale", { pnl_pct: 3 }), baseConfig());
    backdateLatestHistoryPoint(tempDir, "stale", 91 * 60_000);
    const stale = updatePnlAndCheckExits("stale", makePosition("stale", { pnl_pct: -2 }), baseConfig());
    assert(stale == null, "qualifying peak older than 90m should not fire");

    track("disabled");
    updatePnlAndCheckExits("disabled", makePosition("disabled", { pnl_pct: 3 }), baseConfig({ rollingDrawdownExitEnabled: false }));
    backdateLatestHistoryPoint(tempDir, "disabled", 60 * 60_000);
    const disabled = updatePnlAndCheckExits("disabled", makePosition("disabled", { pnl_pct: -2 }), baseConfig({ rollingDrawdownExitEnabled: false }));
    assert(disabled == null, "disabled rolling drawdown rule should not fire");

    track("suspicious");
    updatePnlAndCheckExits("suspicious", makePosition("suspicious", { pnl_pct: 3 }), baseConfig());
    backdateLatestHistoryPoint(tempDir, "suspicious", 60 * 60_000);
    const suspicious = updatePnlAndCheckExits("suspicious", makePosition("suspicious", { pnl_pct: -2, pnl_pct_suspicious: true }), baseConfig());
    assert(suspicious == null, "suspicious PnL should not trigger rolling drawdown exit");

    track("hard");
    const hardStop = updatePnlAndCheckExits("hard", makePosition("hard", { pnl_pct: -15.1 }), baseConfig());
    assert(hardStop?.action === "STOP_LOSS", "hard -15.1% should still close immediately");
    assert(hardStop?.urgent === true, "hard stop-loss should remain urgent");
    assert(String(hardStop?.reason || "").startsWith("Hard stop loss:"), "hard stop-loss label should be preserved");

    track("fast");
    const fastStop = updatePnlAndCheckExits("fast", makePosition("fast", { pnl_pct: -10.1 }), baseConfig());
    assert(fastStop?.action === "STOP_LOSS", "fast -10.1% should still close immediately");
    assert(fastStop?.urgent === true, "fast stop-loss should remain urgent");
    assert(String(fastStop?.reason || "").startsWith("Fast stop loss:"), "fast stop-loss label should be preserved");

    track("velocity");
    const velocityInitial = updatePnlAndCheckExits("velocity", makePosition("velocity", { pnl_pct: -5.2 }), baseConfig());
    assert(velocityInitial == null, "initial velocity sample should not close");
    backdateLatestHistoryPoint(tempDir, "velocity", 60_000);
    const velocityStop = updatePnlAndCheckExits("velocity", makePosition("velocity", { pnl_pct: -8.8 }), baseConfig());
    assert(velocityStop?.action === "STOP_LOSS", "velocity stop should remain intact");
    assert(velocityStop?.urgent === true, "velocity stop should remain urgent");
    assert(String(velocityStop?.reason || "").startsWith("Velocity stop loss:"), "velocity stop label should be preserved");

    tempStateFileCreated = fs.existsSync(path.join(tempDir, "state.json"));

    const proof = {
      success: true,
      pureDecision: { action: pureDecision.action, urgent: pureDecision.urgent, reason: pureDecision.reason },
      fireExit: { action: fireExit.action, urgent: fireExit.urgent, reason: fireExit.reason },
      noTriggerCases: {
        lowPeak: lowPeak == null,
        currentHigh: currentHigh == null,
        smallDrop: smallDrop == null,
        stale: stale == null,
        disabled: disabled == null,
        suspicious: suspicious == null,
      },
      preservedStops: {
        hard: { action: hardStop.action, urgent: hardStop.urgent, reason: hardStop.reason },
        fast: { action: fastStop.action, urgent: fastStop.urgent, reason: fastStop.reason },
        velocity: { action: velocityStop.action, urgent: velocityStop.urgent, reason: velocityStop.reason },
      },
      fireHistoryPoints: getHistory(tempDir, "fires").length,
      tempStateFileCreated,
    };

    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDirRemoved = !fs.existsSync(tempDir);

    console.log(JSON.stringify({ ...proof, tempDirRemoved }, null, 2));
  } catch (error) {
    process.chdir(originalCwd);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDirRemoved = !fs.existsSync(tempDir);
    } catch {
      // ignore cleanup failure; report original error
    }
    console.error(JSON.stringify({
      success: false,
      error: error.message,
      tempStateFileCreated,
      tempDirRemoved,
    }, null, 2));
    process.exit(1);
  }
}

await main();
