#!/usr/bin/env node
/**
 * Synthetic proof for nanocap emergency stop-loss policy.
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
    trailingTakeProfit: true,
    trailingTriggerPct: 8,
    trailingDropPct: 3,
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

function backdateLatestHistoryPoint(tempDir, position, ageMs) {
  const statePath = path.join(tempDir, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const history = state.positions?.[position]?.pnl_history;
  assert(Array.isArray(history) && history.length > 0, `missing pnl_history for ${position}`);
  history[history.length - 1].ts = new Date(Date.now() - ageMs).toISOString();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

async function main() {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-emergency-stop-proof-"));
  let tempStateFileCreated = false;
  let tempDirRemoved = false;

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

    track("fast");
    const fastStop = updatePnlAndCheckExits("fast", makePosition("fast", { pnl_pct: -10.1 }), baseConfig());
    assert(fastStop?.action === "STOP_LOSS", "fast <= -10% should close immediately");
    assert(fastStop?.urgent === true, "fast stop-loss should be urgent");
    assert(String(fastStop?.reason || "").startsWith("Fast stop loss:"), "fast stop-loss reason should be labeled");

    track("velocity");
    const velocityInitial = updatePnlAndCheckExits("velocity", makePosition("velocity", { pnl_pct: -5.2 }), baseConfig());
    assert(velocityInitial == null, "initial velocity sample should not close");
    backdateLatestHistoryPoint(tempDir, "velocity", 60000);
    const velocityStop = updatePnlAndCheckExits("velocity", makePosition("velocity", { pnl_pct: -8.8 }), baseConfig());
    assert(velocityStop?.action === "STOP_LOSS", "rapid drop through -8% should close immediately");
    assert(velocityStop?.urgent === true, "velocity stop-loss should be urgent");
    assert(String(velocityStop?.reason || "").startsWith("Velocity stop loss:"), "velocity stop-loss reason should be labeled");
    assert(String(velocityStop?.reason || "").includes("dropped -3.60pp over 60s"), "velocity reason should include pp drop and window");

    track("ordinary");
    const ordinaryInitial = updatePnlAndCheckExits("ordinary", makePosition("ordinary", { pnl_pct: -6.2 }), baseConfig());
    assert(ordinaryInitial == null, "initial ordinary sample should not close");
    backdateLatestHistoryPoint(tempDir, "ordinary", 60000);
    const ordinarySoft = updatePnlAndCheckExits("ordinary", makePosition("ordinary", { pnl_pct: -8.5 }), baseConfig());
    assert(ordinarySoft?.action === "STOP_LOSS_CANDIDATE", "ordinary -8.5% should still use confirmation");
    assert(ordinarySoft?.needs_confirmation === true, "ordinary soft stop should need confirmation");
    assert(Number(ordinarySoft?.confirm_delay_ms) === 15000, "ordinary soft stop should honor 15000ms confirmation");

    track("hard");
    const hardStop = updatePnlAndCheckExits("hard", makePosition("hard", { pnl_pct: -15.1 }), baseConfig());
    assert(hardStop?.action === "STOP_LOSS", "hard -15.1% should close immediately");
    assert(hardStop?.urgent === true, "hard stop-loss should be urgent");
    assert(String(hardStop?.reason || "").startsWith("Hard stop loss:"), "hard stop-loss reason should remain distinct");

    track("young-hard");
    const youngHardStop = updatePnlAndCheckExits("young-hard", makePosition("young-hard", { pnl_pct: -15.1, age_minutes: 5 }), baseConfig());
    assert(youngHardStop?.action === "STOP_LOSS", "young hard -15.1% should close immediately");
    assert(youngHardStop?.urgent === true, "young hard stop-loss should be urgent");
    assert(String(youngHardStop?.reason || "").startsWith("Hard stop loss:"), "young hard stop should not be masked by early dump");

    track("young-fast");
    const youngFastStop = updatePnlAndCheckExits("young-fast", makePosition("young-fast", { pnl_pct: -10.1, age_minutes: 5 }), baseConfig());
    assert(youngFastStop?.action === "STOP_LOSS", "young fast <= -10% should close immediately");
    assert(youngFastStop?.urgent === true, "young fast stop-loss should be urgent");
    assert(String(youngFastStop?.reason || "").startsWith("Fast stop loss:"), "young fast stop should not be masked by early dump");

    track("young-velocity");
    const youngVelocityInitial = updatePnlAndCheckExits("young-velocity", makePosition("young-velocity", { pnl_pct: -5.2, age_minutes: 4 }), baseConfig());
    assert(youngVelocityInitial == null, "initial young velocity sample should not close");
    backdateLatestHistoryPoint(tempDir, "young-velocity", 60000);
    const youngVelocityStop = updatePnlAndCheckExits("young-velocity", makePosition("young-velocity", { pnl_pct: -8.8, age_minutes: 5 }), baseConfig());
    assert(youngVelocityStop?.action === "STOP_LOSS", "young rapid drop through -8% should close immediately");
    assert(youngVelocityStop?.urgent === true, "young velocity stop-loss should be urgent");
    assert(String(youngVelocityStop?.reason || "").startsWith("Velocity stop loss:"), "young velocity stop should not be masked by early dump");

    track("young-early");
    const youngEarlyDump = updatePnlAndCheckExits("young-early", makePosition("young-early", { pnl_pct: -8.2, age_minutes: 5 }), baseConfig());
    assert(youngEarlyDump?.action === "STOP_LOSS", "young -8.2% should still trigger early dump when no fast/hard/velocity rule applies");
    assert(String(youngEarlyDump?.reason || "").startsWith("Early dump:"), "young ordinary soft loss should keep early dump label");

    tempStateFileCreated = fs.existsSync(path.join(tempDir, "state.json"));

    const proof = {
      success: true,
      fastStop: { action: fastStop.action, urgent: fastStop.urgent, reason: fastStop.reason },
      velocityStop: { action: velocityStop.action, urgent: velocityStop.urgent, reason: velocityStop.reason },
      ordinarySoft: {
        action: ordinarySoft.action,
        needsConfirmation: ordinarySoft.needs_confirmation,
        confirmDelayMs: ordinarySoft.confirm_delay_ms,
        reason: ordinarySoft.reason,
      },
      hardStop: { action: hardStop.action, urgent: hardStop.urgent, reason: hardStop.reason },
      youngHardStop: { action: youngHardStop.action, urgent: youngHardStop.urgent, reason: youngHardStop.reason },
      youngFastStop: { action: youngFastStop.action, urgent: youngFastStop.urgent, reason: youngFastStop.reason },
      youngVelocityStop: { action: youngVelocityStop.action, urgent: youngVelocityStop.urgent, reason: youngVelocityStop.reason },
      youngEarlyDump: { action: youngEarlyDump.action, urgent: youngEarlyDump.urgent ?? false, reason: youngEarlyDump.reason },
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
