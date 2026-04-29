#!/usr/bin/env node
/**
 * Synthetic proof for the shadow active-bin oracle recorder.
 *
 * This is local-only. It does not start the bot, connect to Solana, deploy, or
 * close anything. It exercises range classification, velocity calculation,
 * one-subscription-per-pool tracking, and JSONL output.
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
  const { ActiveBinOracleRecorder, classifyActiveBin } = await import(join(ROOT, "active-bin-oracle.js"));

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
  assert.ok(rows[0].would_close_reason.includes("shadow_only_active_bin_above_range"));
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
