#!/usr/bin/env node
/**
 * Behavioral proof for effective range truth.
 *
 * Runs in a temporary directory so state.js writes only temporary state.json.
 * Does not import index.js, start the bot, call trading APIs, or touch runtime files.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { dirname, join } from "path";
import { pathToFileURL, fileURLToPath } from "url";
import assert from "assert/strict";
import { isOorRepositionEligibleRangeSide } from "../oor-reposition.js";
import { buildEffectiveRangeState } from "../range-state.js";

process.env.LOG_LEVEL = "error";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function baseConfig(overrides = {}) {
  return {
    earlyDumpPct: -8,
    earlyDumpMaxAgeMin: 20,
    stopLossPct: -8,
    stopLossConfirmDelayMs: 15_000,
    hardStopLossPct: -15,
    stopLossVelocityWindowMs: 90_000,
    stopLossVelocityClosePct: -3,
    trailingTakeProfit: true,
    trailingTriggerPct: 6,
    trailingDropPct: 3,
    outOfRangeWaitMinutes: 30,
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
    pnl_pct: 0,
    pnl_pct_suspicious: false,
    in_range: true,
    source_in_range: true,
    fee_per_tvl_24h: 10,
    age_minutes: 60,
    ...overrides,
  };
}

function backdateOor(tempDir, position, ageMs) {
  const statePath = path.join(tempDir, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert(state.positions?.[position], `missing tracked position ${position}`);
  assert(state.positions[position].out_of_range_since, `expected ${position} to be marked OOR first`);
  state.positions[position].out_of_range_since = new Date(Date.now() - ageMs).toISOString();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function readPosition(tempDir, position) {
  const state = JSON.parse(fs.readFileSync(path.join(tempDir, "state.json"), "utf8"));
  return state.positions?.[position] ?? null;
}

async function main() {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-effective-range-proof-"));
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

    track("above");
    const aboveFirst = updatePnlAndCheckExits(
      "above",
      makePosition("above", {
        in_range: true,
        source_in_range: true,
        active_bin: 160,
        lower_bin: 100,
        upper_bin: 150,
        active_bin_source: "live_bin_data",
        lower_bin_source: "live_bin_data",
        upper_bin_source: "live_bin_data",
        range_side: "above_range",
      }),
      baseConfig(),
    );
    assert.equal(aboveFirst, null, "fresh above-range first sighting should start timer but not close immediately");
    assert(readPosition(tempDir, "above")?.out_of_range_since, "fresh above-range must start OOR timer even when API says in-range");
    backdateOor(tempDir, "above", 31 * 60_000);
    const aboveExit = updatePnlAndCheckExits(
      "above",
      makePosition("above", {
        in_range: true,
        source_in_range: true,
        active_bin: 160,
        lower_bin: 100,
        upper_bin: 150,
        active_bin_source: "live_bin_data",
        lower_bin_source: "live_bin_data",
        upper_bin_source: "live_bin_data",
        range_side: "above_range",
      }),
      baseConfig(),
    );
    assert.equal(aboveExit?.action, "OUT_OF_RANGE", "matured fresh above-range should trigger timed OOR exit");
    assert.equal(isOorRepositionEligibleRangeSide("above_range"), true, "above_range stays eligible for guarded reposition");

    track("below");
    updatePnlAndCheckExits(
      "below",
      makePosition("below", {
        in_range: true,
        source_in_range: true,
        active_bin: 90,
        lower_bin: 100,
        upper_bin: 150,
        active_bin_source: "live_bin_data",
        lower_bin_source: "live_bin_data",
        upper_bin_source: "live_bin_data",
        range_side: "below_range",
      }),
      baseConfig(),
    );
    assert(readPosition(tempDir, "below")?.out_of_range_since, "fresh below-range must start OOR timer even when API says in-range");
    assert.equal(isOorRepositionEligibleRangeSide("below_range"), false, "below_range must remain ineligible for same-pool reposition");

    track("clears");
    updatePnlAndCheckExits("clears", makePosition("clears", { in_range: false, source_in_range: false }), baseConfig());
    assert(readPosition(tempDir, "clears")?.out_of_range_since, "raw API fallback should start timer when bins are missing");
    updatePnlAndCheckExits(
      "clears",
      makePosition("clears", {
        in_range: false,
        source_in_range: false,
        active_bin: 125,
        lower_bin: 100,
        upper_bin: 150,
        active_bin_source: "live_bin_data",
        lower_bin_source: "live_bin_data",
        upper_bin_source: "live_bin_data",
        range_side: "in_range",
      }),
      baseConfig(),
    );
    assert.equal(readPosition(tempDir, "clears")?.out_of_range_since, null, "fresh derived in-range must clear stale API OOR timer");

    track("stale");
    updatePnlAndCheckExits(
      "stale",
      makePosition("stale", {
        in_range: true,
        source_in_range: true,
        active_bin: 160,
        lower_bin: 100,
        upper_bin: 150,
        active_bin_source: "tracked_state",
        lower_bin_source: "tracked_state",
        upper_bin_source: "tracked_state",
        range_side: "above_range",
      }),
      baseConfig(),
    );
    assert.equal(readPosition(tempDir, "stale")?.out_of_range_since, null, "stale tracked bins must not override API in-range");

    const state = buildEffectiveRangeState({
      source_in_range: true,
      active_bin: 160,
      lower_bin: 100,
      upper_bin: 150,
      active_bin_source: "live_bin_data",
      lower_bin_source: "live_bin_data",
      upper_bin_source: "live_bin_data",
    });
    assert.equal(state.effective_in_range, false);
    assert.equal(state.range_state_mismatch, true);
    assert.equal(state.range_state_source, "derived_live_bins");

    tempStateFileCreated = fs.existsSync(path.join(tempDir, "state.json"));
    console.log(JSON.stringify({
      success: true,
      cases: {
        apiInDerivedAboveStartsOor: true,
        maturedAboveTriggersOorExit: true,
        apiInDerivedBelowStartsOor: true,
        belowRangeRepositionBlocked: true,
        derivedInRangeClearsApiOor: true,
        staleTrackedBinsDoNotOverrideApi: true,
      },
      tempStateFileCreated,
    }, null, 2));
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDirRemoved = !fs.existsSync(tempDir);
    if (!tempDirRemoved) {
      throw new Error(`failed to remove temp dir ${tempDir}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
