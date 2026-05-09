#!/usr/bin/env node
/**
 * Synthetic behavioral proof for the nanocap stop-loss trial.
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
  if (!condition) {
    throw new Error(message);
  }
}

function baseConfig(overrides = {}) {
  return {
    earlyDumpPct: -8,
    earlyDumpMaxAgeMin: 20,
    stopLossPct: -8,
    stopLossConfirmDelayMs: 15000,
    hardStopLossPct: -15,
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

async function main() {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-stop-loss-proof-"));
  let tempStateFileCreated = false;
  let tempDirRemoved = false;

  try {
    process.chdir(tempDir);

    const stateModule = await import(`${pathToFileURL(join(ROOT, "state.js")).href}?proof=${Date.now()}`);
    const policyModule = await import(`${pathToFileURL(join(ROOT, "stop-loss-policy.js")).href}?proof=${Date.now()}`);
    const { trackPosition, updatePnlAndCheckExits } = stateModule;
    const { buildStopLossConfirmationResult } = policyModule;

    function track(position) {
      trackPosition({
        position,
        pool: `pool-${position}`,
        pool_name: `TEST-${position}`,
        strategy: "bid_ask",
      });
    }

    track("soft");
    const softCandidate = updatePnlAndCheckExits("soft", makePosition("soft", { pnl_pct: -8.5 }), baseConfig());
    assert(softCandidate?.action === "STOP_LOSS_CANDIDATE", "soft -8.5% should queue a stop-loss candidate");
    assert(softCandidate?.needs_confirmation === true, "soft stop-loss candidate should require confirmation");
    assert(Number(softCandidate?.confirm_delay_ms) === 15000, "soft stop-loss should honor 15000ms confirmation delay");
    assert(String(softCandidate?.reason || "").startsWith("Stop loss candidate:"), "soft stop-loss reason should be candidate-labeled");

    track("hard");
    const hardStop = updatePnlAndCheckExits("hard", makePosition("hard", { pnl_pct: -15.1 }), baseConfig());
    assert(hardStop?.action === "STOP_LOSS", "hard -15.1% should close immediately");
    assert(hardStop?.urgent === true, "hard stop-loss should be urgent");
    assert(String(hardStop?.reason || "").startsWith("Hard stop loss:"), "hard stop-loss reason should be clearly labeled");

    track("early");
    const earlyDump = updatePnlAndCheckExits("early", makePosition("early", { pnl_pct: -8.2, age_minutes: 5 }), baseConfig());
    assert(earlyDump?.action === "STOP_LOSS", "young -8.2% should trigger early-dump stop-loss family exit");
    assert(String(earlyDump?.reason || "").startsWith("Early dump:"), "early dump should keep a separate reason label");
    assert(!earlyDump?.needs_confirmation, "early dump should not be routed through ordinary stop-loss confirmation");

    track("legacy");
    const legacy = updatePnlAndCheckExits(
      "legacy",
      makePosition("legacy", { pnl_pct: -8.5 }),
      baseConfig({ stopLossConfirmDelayMs: 0, hardStopLossPct: null }),
    );
    assert(legacy?.action === "STOP_LOSS", "legacy no-delay stop-loss should close immediately");
    assert(String(legacy?.reason || "").startsWith("Stop loss:"), "legacy stop-loss reason should remain unchanged");
    assert(!legacy?.needs_confirmation, "legacy no-delay stop-loss should not require confirmation");

    const confirmed = buildStopLossConfirmationResult({
      currentPnlPct: -8.25,
      stopLossPct: -8,
      delayMs: 15000,
      candidatePnlPct: -8.5,
      pair: "TEST-SOL",
    });
    assert(confirmed.confirmed === true, "recheck still below -8% should confirm");
    assert(String(confirmed.closeReason || "").startsWith("Stop loss confirmed:"), "confirmed close reason should be owner-readable");

    const rejected = buildStopLossConfirmationResult({
      currentPnlPct: -7.75,
      stopLossPct: -8,
      delayMs: 15000,
      candidatePnlPct: -8.5,
      pair: "TEST-SOL",
    });
    assert(rejected.rejected === true, "recheck above -8% should reject");
    assert(String(rejected.rejectionReason || "").startsWith("Stop loss candidate rejected:"), "rejected candidate should be owner-readable");

    tempStateFileCreated = fs.existsSync(path.join(tempDir, "state.json"));

    const proof = {
      success: true,
      softCandidate: {
        action: softCandidate.action,
        needsConfirmation: softCandidate.needs_confirmation,
        confirmDelayMs: softCandidate.confirm_delay_ms,
        reason: softCandidate.reason,
      },
      hardStop: {
        action: hardStop.action,
        urgent: hardStop.urgent,
        reason: hardStop.reason,
      },
      earlyDump: {
        action: earlyDump.action,
        reason: earlyDump.reason,
      },
      legacyNoDelay: {
        action: legacy.action,
        reason: legacy.reason,
      },
      confirmedRecheck: {
        confirmed: confirmed.confirmed,
        closeReason: confirmed.closeReason,
      },
      rejectedRecheck: {
        rejected: rejected.rejected,
        rejectionReason: rejected.rejectionReason,
      },
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
