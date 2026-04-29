#!/usr/bin/env node
/**
 * Synthetic proof for the shadow active-bin oracle recorder.
 *
 * This is local-only. It does not start the bot, connect to Solana, deploy, or
 * close anything. It exercises range classification, velocity calculation,
 * one-subscription-per-pool tracking, short-window velocity labels, and JSONL output.
 */

import assert from "assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

process.env.LOG_LEVEL = process.env.LOG_LEVEL || "error";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const tempDir = mkdtempSync(join(tmpdir(), "meridian-active-bin-oracle-"));

let proof;
let failure;

class FakeConnection {
  constructor() {
    this.subscriptions = [];
    this.removed = [];
  }

  onAccountChange(pubkey, callback) {
    const id = this.subscriptions.length + 1;
    this.subscriptions.push({ id, pubkey: pubkey.toString(), callback });
    return id;
  }

  async removeAccountChangeListener(id) {
    this.removed.push(id);
  }
}

try {
  const {
    ActiveBinOracleRecorder,
    classifyActiveBin,
    classifyShadowVelocity,
    computeVelocityWindows,
    shouldTriggerActiveBinEmergencyExit,
  } = await import(join(ROOT, "active-bin-oracle.js"));

  const inRange = classifyActiveBin(
    { lower_bin: 100, upper_bin: 130, pnl_pct: 1.2 },
    115,
    110,
    1_000,
    4_000,
  );
  assert.strictEqual(inRange.in_range, true);
  assert.strictEqual(inRange.adverse_oor_guess, false);
  assert.strictEqual(inRange.bin_delta, 5);
  assert.strictEqual(inRange.bin_velocity, 1.666667);
  assert.strictEqual(inRange.would_close_reason, null);

  const adverseAbove = classifyActiveBin(
    { lower_bin: 100, upper_bin: 130, pnl_pct: -12.5 },
    148,
    132,
    10_000,
    14_000,
  );
  assert.strictEqual(adverseAbove.in_range, false);
  assert.strictEqual(adverseAbove.adverse_oor_guess, true);
  assert.strictEqual(adverseAbove.bin_delta, 16);
  assert.strictEqual(adverseAbove.bin_velocity, 4);
  assert.ok(adverseAbove.would_close_reason.includes("shadow_only_active_bin_above_range"));

  const nonAdverseBelow = classifyActiveBin(
    { lower_bin: 100, upper_bin: 130, pnl_pct: 4.4 },
    90,
    95,
    20_000,
    25_000,
  );
  assert.strictEqual(nonAdverseBelow.in_range, false);
  assert.strictEqual(nonAdverseBelow.adverse_oor_guess, false);
  assert.strictEqual(nonAdverseBelow.would_close_reason, null);

  const velocity10s = computeVelocityWindows(115, 10_000, [{ activeBin: 100, observedAtMs: 0 }]);
  assert.strictEqual(velocity10s.velocity_10s_bin_delta, 15);
  assert.strictEqual(velocity10s.velocity_10s_elapsed_sec, 10);
  assert.strictEqual(velocity10s.velocity_10s_bins_per_sec, 1.5);
  const watchSignal = classifyShadowVelocity(velocity10s);
  assert.strictEqual(watchSignal.shadow_velocity_signal, "watch");
  assert.ok(watchSignal.shadow_velocity_reason.includes("shadow_only_velocity_watch"));

  const velocity30s = computeVelocityWindows(165, 31_000, [
    { activeBin: 100, observedAtMs: 0 },
    { activeBin: 115, observedAtMs: 10_000 },
  ]);
  assert.strictEqual(velocity30s.velocity_30s_bin_delta, 65);
  assert.strictEqual(velocity30s.velocity_30s_elapsed_sec, 31);
  assert.strictEqual(velocity30s.velocity_30s_bins_per_sec, 2.096774);
  const extremeSignal = classifyShadowVelocity(velocity30s);
  assert.strictEqual(extremeSignal.shadow_velocity_signal, "rug_like_extreme");
  assert.ok(extremeSignal.shadow_velocity_reason.includes("shadow_only_velocity_candidate"));
  assert.strictEqual(shouldTriggerActiveBinEmergencyExit({ ...extremeSignal, pnl_pct: -1.1 }), true);
  assert.strictEqual(shouldTriggerActiveBinEmergencyExit({ ...watchSignal, pnl_pct: -20 }), false);
  assert.strictEqual(shouldTriggerActiveBinEmergencyExit({ ...extremeSignal, pnl_pct: 4.5 }), false);

  const fakeConnection = new FakeConnection();
  const recorder = new ActiveBinOracleRecorder({
    connection: fakeConnection,
    debounceMs: 10,
    logDir: tempDir,
    getActiveBinFn: async () => ({ binId: 148 }),
    logger: () => {},
    now: () => new Date("2026-04-29T09:00:04.000Z"),
  });

  const pool = "11111111111111111111111111111111";
  recorder.updatePositions([
    {
      pool,
      position: "Position1111111111111111111111111111111",
      pair: "SCAM-SOL",
      lower_bin: 100,
      upper_bin: 130,
      active_bin: 132,
      pnl_pct: -15.24,
      pnl_usd: -0.61,
      pnl_pct_derived: -14.9,
    },
    {
      pool,
      position: "Position2222222222222222222222222222222",
      pair: "SCAM-SOL",
      lower_bin: 105,
      upper_bin: 150,
      active_bin: 132,
      pnl_pct: 2.5,
    },
  ]);
  recorder.updatePositions([
    {
      pool,
      position: "Position1111111111111111111111111111111",
      pair: "SCAM-SOL",
      lower_bin: 100,
      upper_bin: 130,
      active_bin: 132,
      pnl_pct: -15.24,
      pnl_usd: -0.61,
      pnl_pct_derived: -14.9,
    },
  ]);
  assert.strictEqual(fakeConnection.subscriptions.length, 1, "subscribes once per unique pool");

  await recorder.recordPoolSample(pool);
  const logFile = join(tempDir, "active-bin-oracle-2026-04-29.jsonl");
  assert.ok(existsSync(logFile), "JSONL shadow log was written");
  const rows = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].source, "shadow_active_bin_oracle");
  assert.strictEqual(rows[0].pool, pool);
  assert.strictEqual(rows[0].position, "Position1111111111111111111111111111111");
  assert.strictEqual(rows[0].active_bin, 148);
  assert.strictEqual(rows[0].prior_active_bin, 132);
  assert.strictEqual(rows[0].bin_delta, 16);
  assert.strictEqual(rows[0].in_range, false);
  assert.strictEqual(rows[0].adverse_oor_guess, true);
  assert.ok(Object.hasOwn(rows[0], "velocity_10s_bin_delta"));
  assert.ok(Object.hasOwn(rows[0], "velocity_30s_bin_delta"));
  assert.ok(Object.hasOwn(rows[0], "shadow_velocity_signal"));
  assert.ok(Object.hasOwn(rows[0], "shadow_velocity_reason"));
  assert.ok(rows[0].would_close_reason.includes("shadow_only_active_bin_above_range"));

  const velocityTempDir = mkdtempSync(join(tmpdir(), "meridian-active-bin-velocity-"));
  const velocityConnection = new FakeConnection();
  const sampleTimes = [
    new Date("2026-04-29T10:00:00.000Z"),
    new Date("2026-04-29T10:00:10.000Z"),
    new Date("2026-04-29T10:00:31.000Z"),
  ];
  const sampleBins = [115, 165];
  let nowIndex = 0;
  let binIndex = 0;
  const emergencyRows = [];
  const velocityRecorder = new ActiveBinOracleRecorder({
    connection: velocityConnection,
    debounceMs: 10,
    logDir: velocityTempDir,
    getActiveBinFn: async () => ({ binId: sampleBins[binIndex++] }),
    logger: () => {},
    now: () => sampleTimes[nowIndex],
  });
  velocityRecorder.setEmergencyExitHandler(async (row) => {
    emergencyRows.push(row);
  }, { enabled: true, maxPnlPct: 2 });

  velocityRecorder.updatePositions([
    {
      pool,
      position: "Velocity111111111111111111111111111111",
      pair: "FAST-SOL",
      lower_bin: 90,
      upper_bin: 140,
      active_bin: 100,
      pnl_pct: -3.5,
    },
  ]);
  nowIndex = 1;
  await velocityRecorder.recordPoolSample(pool);
  nowIndex = 2;
  await velocityRecorder.recordPoolSample(pool);
  const velocityLogFile = join(velocityTempDir, "active-bin-oracle-2026-04-29.jsonl");
  const velocityRows = readFileSync(velocityLogFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.strictEqual(velocityRows[0].velocity_10s_bin_delta, 15);
  assert.strictEqual(velocityRows[0].shadow_velocity_signal, "watch");
  assert.strictEqual(velocityRows[1].velocity_30s_bin_delta, 65);
  assert.strictEqual(velocityRows[1].shadow_velocity_signal, "rug_like_extreme");
  assert.strictEqual(emergencyRows.length, 1);
  assert.strictEqual(emergencyRows[0].position, "Velocity111111111111111111111111111111");
  await velocityRecorder.stop();
  rmSync(velocityTempDir, { recursive: true, force: true });

  const source = readFileSync(join(ROOT, "active-bin-oracle.js"), "utf8");
  assert.ok(!source.includes("closePosition"));
  assert.ok(!source.includes("executeTool"));

  recorder.updatePositions([]);
  assert.deepStrictEqual(fakeConnection.removed, [1], "unsubscribes removed pools");
  await recorder.stop();

  proof = {
    success: true,
    checks: {
      inRangeClassification: true,
      adverseOorClassification: true,
      nonAdverseProfitableOor: true,
      velocityCalculation: true,
      velocity10sWatchSignal: true,
      velocity30sExtremeSignal: true,
      liveEmergencyTriggersExtremeOnly: true,
      velocityWindowFieldsPreservedInRows: true,
      oneSubscriptionPerPool: true,
      jsonlRowsWritten: rows.length,
      noCloseOrExecuteImports: true,
      unsubscribeRemovedPools: true,
    },
    sampleLogFile: logFile,
    productionLogPattern: "logs/active-bin-oracle-YYYY-MM-DD.jsonl",
  };
} catch (error) {
  failure = error;
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

if (failure) {
  console.error(failure.stack || failure.message);
  process.exit(1);
}

console.log(JSON.stringify(proof, null, 2));
process.exit(0);
