#!/usr/bin/env node
/**
 * Synthetic proof for MAIN-DEPLOY-GUARD-T1.
 *
 * Imports pure deploy lease helpers only. No trading APIs, bot runtime, or deploy calls.
 */

import assert from "assert";
import fs from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  buildDeployCandidateLease,
  clearDeployCandidateLeases,
  getDeployCandidateLease,
  recordDeployCandidateLeases,
  validateDeployCandidateLease,
} from "../tools/screening.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const NOW = Date.parse("2026-05-03T00:00:00.000Z");
const TTL_MS = 60_000;

const thresholds = {
  minFeeActiveTvlRatio: 1,
  minVolume: 20_000,
  minBinStep: 80,
  maxBinStep: 125,
  timeframe: "5m",
  category: "trending",
};

const goodCandidate = {
  pool: "GoodPool111111111111111111111111111111111111",
  name: "GOOD-SOL",
  fee_active_tvl_ratio: 1.25,
  volume_window: 25_000,
  bin_step: 100,
  base: { mint: "GoodMint111111111111111111111111111111111111" },
};

function loadSource(relativePath) {
  return fs.readFileSync(join(ROOT, relativePath), "utf8");
}

function failureByCode(result, code) {
  return result.failures.find((failure) => failure.code === code);
}

function main() {
  clearDeployCandidateLeases();

  const goodLease = buildDeployCandidateLease(goodCandidate, thresholds, { now: NOW, ttlMs: TTL_MS });
  assert.strictEqual(goodLease.pool, goodCandidate.pool, "lease should preserve pool address");
  assert.strictEqual(goodLease.name, goodCandidate.name, "lease should preserve pool name");
  assert.strictEqual(goodLease.fee_active_tvl_ratio, 1.25, "lease should preserve fee_active_tvl_ratio");
  assert.strictEqual(goodLease.volume_window, 25_000, "lease should preserve volume_window");
  assert.strictEqual(goodLease.bin_step, 100, "lease should preserve bin_step");
  assert.strictEqual(goodLease.base_mint, goodCandidate.base.mint, "lease should preserve base mint");
  assert.strictEqual(goodLease.threshold_snapshot.minFeeActiveTvlRatio, 1, "lease should preserve threshold snapshot");

  const freshPass = validateDeployCandidateLease({
    pool_address: goodCandidate.pool,
    pool_name: goodCandidate.name,
    base_mint: goodCandidate.base.mint,
    amount_y: 4,
    rationale: "best candidate from latest scan",
    confidence: 0.72,
  }, thresholds, { now: NOW, lease: goodLease });
  assert.strictEqual(freshPass.pass, true, "fresh lease above thresholds should pass");
  assert.strictEqual(freshPass.audit.decision, "allow", "fresh pass audit should allow");
  assert.strictEqual(freshPass.audit.attempted.rationale, "best candidate from latest scan", "audit should preserve rationale");
  assert.strictEqual(freshPass.audit.attempted.confidence, 0.72, "audit should preserve confidence");
  assert.strictEqual(freshPass.audit.attempted.deploy_args.amount_y, 4, "audit should preserve deploy args");

  const missingLease = validateDeployCandidateLease({
    pool_address: "MissingPool111111111111111111111111111111111",
    amount_y: 4,
  }, thresholds, { now: NOW, lease: null });
  assert.strictEqual(missingLease.pass, false, "missing lease should block");
  assert.ok(failureByCode(missingLease, "missing_fresh_candidate_lease"), "missing lease should report exact code");

  const staleLease = { ...goodLease, expires_at_ms: NOW - 1, expires_at: new Date(NOW - 1).toISOString() };
  const staleBlock = validateDeployCandidateLease({
    pool_address: goodCandidate.pool,
    amount_y: 4,
  }, thresholds, { now: NOW, lease: staleLease });
  assert.strictEqual(staleBlock.pass, false, "stale lease should block");
  assert.ok(failureByCode(staleBlock, "stale_candidate_lease"), "stale lease should report exact code");

  const lowFeeLease = buildDeployCandidateLease({
    ...goodCandidate,
    pool: "LowFeePool111111111111111111111111111111111",
    fee_active_tvl_ratio: 0.02,
  }, thresholds, { now: NOW, ttlMs: TTL_MS });
  const lowFeeBlock = validateDeployCandidateLease({
    pool_address: lowFeeLease.pool,
    pool_name: "LOWFEE-SOL",
    amount_y: 4,
    rationale: "caller still wants deploy",
    confidence: 0.9,
  }, thresholds, { now: NOW, lease: lowFeeLease });
  const lowFeeFailure = failureByCode(lowFeeBlock, "fee_active_tvl_ratio_below_threshold");
  assert.strictEqual(lowFeeBlock.pass, false, "below fee threshold should block");
  assert.strictEqual(lowFeeFailure.actual, 0.02, "fee failure should preserve actual value");
  assert.strictEqual(lowFeeFailure.threshold, 1, "fee failure should preserve exact live threshold");
  assert.strictEqual(lowFeeBlock.audit.decision, "safety_block", "blocked audit should use safety_block");
  assert.strictEqual(lowFeeBlock.audit.attempted.pool_name, "LOWFEE-SOL", "blocked audit should preserve attempted pool name");
  assert.strictEqual(lowFeeBlock.audit.attempted.rationale, "caller still wants deploy", "blocked audit should preserve rationale");
  assert.strictEqual(lowFeeBlock.audit.attempted.confidence, 0.9, "blocked audit should preserve confidence");

  const lowVolumeLease = buildDeployCandidateLease({
    ...goodCandidate,
    pool: "LowVolumePool1111111111111111111111111111111",
    volume_window: 19_999,
  }, thresholds, { now: NOW, ttlMs: TTL_MS });
  const lowVolumeBlock = validateDeployCandidateLease({
    pool_address: lowVolumeLease.pool,
    amount_y: 4,
  }, thresholds, { now: NOW, lease: lowVolumeLease });
  const lowVolumeFailure = failureByCode(lowVolumeBlock, "volume_window_below_threshold");
  assert.strictEqual(lowVolumeBlock.pass, false, "below volume threshold should block");
  assert.strictEqual(lowVolumeFailure.actual, 19_999, "volume failure should preserve actual value");
  assert.strictEqual(lowVolumeFailure.threshold, 20_000, "volume failure should preserve exact live threshold");

  clearDeployCandidateLeases();
  recordDeployCandidateLeases([goodCandidate], thresholds, { now: NOW, ttlMs: TTL_MS });
  assert.ok(getDeployCandidateLease(goodCandidate.pool, { now: NOW + 1 }), "recorded fresh lease should be retrievable");
  assert.strictEqual(getDeployCandidateLease(goodCandidate.pool, { now: NOW + TTL_MS + 1 }), null, "expired lease should be evicted");
  recordDeployCandidateLeases([goodCandidate], thresholds, { now: NOW, ttlMs: TTL_MS });
  recordDeployCandidateLeases([], thresholds, { now: NOW + 1, ttlMs: TTL_MS });
  assert.strictEqual(getDeployCandidateLease(goodCandidate.pool, { now: NOW + 2 }), null, "empty fresh candidate scan should clear old deploy leases");

  const screeningSource = loadSource("tools/screening.js");
  const executorSource = loadSource("tools/executor.js");
  const definitionsSource = loadSource("tools/definitions.js");
  assert.ok(screeningSource.includes("recordDeployCandidateLeases(ranked, config.screening)"), "get_top_candidates should record deploy leases");
  assert.ok(executorSource.includes("validateDeployCandidateLease(args, config.screening)"), "executor should validate lease before deploy execution");
  assert.ok(executorSource.includes('type: "deploy_guard"'), "executor should append deploy_guard decision on block");
  assert.ok(definitionsSource.includes("rationale"), "deploy_position schema should include optional rationale");
  assert.ok(definitionsSource.includes("confidence"), "deploy_position schema should include optional confidence");

  console.log(JSON.stringify({
    success: true,
    fresh_pass: freshPass,
    missing_lease_block: missingLease,
    stale_lease_block: staleBlock,
    low_fee_block: lowFeeBlock,
    low_volume_block: lowVolumeBlock,
    source_markers: {
      leases_recorded_from_get_top_candidates: true,
      executor_guard_wired: true,
      deploy_guard_decision_logged: true,
      rationale_confidence_schema: true,
    },
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ success: false, error: error.message }, null, 2));
  process.exit(1);
}
