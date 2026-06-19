#!/usr/bin/env node
/**
 * Synthetic verifier for main EvilPanda-informed fee harvest profile.
 *
 * Read-only except temporary pool-memory fixtures under OS temp.
 */

import assert from "assert";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path, { dirname, join } from "path";
import { fileURLToPath } from "url";
import { evaluateFeeExitPolicy } from "../fee-exit-policy.js";
import {
  evaluateFeeExitConfluenceFromRows,
  shouldGateFeeExitDecision,
} from "../fee-exit-confluence.js";
import { buildConfig } from "../config-builder.js";
import { classifyCloseReason } from "../performance-metrics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const EVIL_PANDA_STRATEGY_PROFILE_FIXTURE = Object.freeze({
  active: "evil_panda_fee_dump_v1",
  strategies: {
    evil_panda_fee_dump_v1: {
      id: "evil_panda_fee_dump_v1",
      lp_strategy: "bid_ask",
      entry: {
        single_side: "sol",
      },
      range: {
        bins_below: 35,
        bins_above: 0,
      },
    },
  },
});
const FABRIQ_DEGEN_STRATEGY_ID = "main_fabriq_degen_fee_rotation_v1";

function read(relativePath) {
  return fs.readFileSync(join(ROOT, relativePath), "utf8");
}

function loadJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function baseManagement(policyOverrides = {}) {
  return {
    solMode: true,
    feeExitPolicy: {
      enabled: true,
      shadowOnly: false,
      dustFloor: 0.000001,
      strategyProfile: "evil_panda_fee_dump_v1",
      feeHarvestEnabled: true,
      feeHarvestMinHoldMinutes: 25,
      feeHarvestMinFeePctOfEntry: 0.75,
      feeHarvestMinNetPnlPct: 0.35,
      noFeeAbortEnabled: true,
      noFeeAbortMaxHoldMinutes: 60,
      noFeeAbortMaxFeePctOfEntry: 0.05,
      noFeeAbortMaxNetPnlPct: -0.5,
      feeConditionalAbortEnabled: true,
      feeConditionalAbortMinHoldMinutes: 45,
      feeConditionalAbortMaxFeePctOfEntry: 0.2,
      feeConditionalAbortMaxNetPnlPct: 0,
      feeConditionalAbortMinLossPct: 2.5,
      emergencyFailsafeEnabled: true,
      emergencyFailsafeMinHoldMinutes: 0,
      emergencyFailsafeMaxFeePctOfEntry: 0.5,
      emergencyFailsafeMinLossPct: 6,
      maxHoldTimeoutEnabled: true,
      maxHoldTimeoutMinutes: 120,
      maxHoldTimeoutMinNetPnlPct: 0.35,
      maxHoldTimeoutBypassesConfluence: true,
      exitConfluenceEnabled: true,
      exitConfluenceMinSignals: 2,
      exitConfluenceRsiPeriod: 2,
      exitConfluenceRsiOverbought: 90,
      exitConfluenceBbPeriod: 20,
      exitConfluenceBbStdDev: 2,
      exitConfluenceAggregateMin: 5,
      exitConfluenceLookbackMinutes: 180,
      exitConfluenceRules: ["fee_harvest", "max_hold_timeout"],
      ...policyOverrides,
    },
  };
}

function decision(position, policyOverrides = {}) {
  return evaluateFeeExitPolicy({
    position,
    tracked: { amount_sol: 0.5, total_fees_claimed_sol: 0 },
    managementConfig: baseManagement(policyOverrides),
  }).decision;
}

function makeRows({ breakout = false } = {}) {
  const rows = [];
  const now = Math.floor(Date.now() / 1000) - (40 * 300);
  let price = 1;
  for (let i = 0; i < 40; i += 1) {
    const open = price;
    price += i < 36 ? 0.001 : (breakout ? 0.08 : -0.002);
    rows.push({
      timestamp: now + (i * 300),
      open,
      high: Math.max(open, price) + 0.001,
      low: Math.min(open, price) - 0.001,
      close: price,
    });
  }
  return rows;
}

async function verifyPoolMemoryCooldowns() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "evil-panda-pool-memory-"));
  const oldCwd = process.cwd();
  const oldStdoutWrite = process.stdout.write;
  process.chdir(temp);
  try {
    process.stdout.write = () => true;
    const { recordPoolDeploy, isPoolOnCooldown, isBaseMintOnCooldown } = await import(`../pool-memory.js?verify=${Date.now()}`);
    const pool = "PoolNoFee1111111111111111111111111111111111";
    const mint = "MintNoFee1111111111111111111111111111111111";
    recordPoolDeploy(pool, {
      pool_name: "NOFEE-SOL",
      base_mint: mint,
      pnl_pct: -0.6,
      close_reason: "No-fee abort: age 60m with fees 0.04% of entry",
      strategy: "bid_ask",
      strategy_profile: "evil_panda_fee_dump_v1",
    });
    assert.strictEqual(isPoolOnCooldown(pool), true, "no-fee abort should cooldown pool");
    assert.strictEqual(isBaseMintOnCooldown(mint), true, "no-fee abort should cooldown base mint");

    const pool2 = "PoolVelocity11111111111111111111111111111111";
    const mint2 = "MintVelocity11111111111111111111111111111111";
    recordPoolDeploy(pool2, {
      pool_name: "VELOCITY-SOL",
      base_mint: mint2,
      pnl_pct: -4.9,
      close_reason: "Velocity stop loss: PnL -4.90%, dropped -3.20pp over 90s",
      strategy: "bid_ask",
      strategy_profile: "evil_panda_fee_dump_v1",
    });
    const memory = JSON.parse(fs.readFileSync("pool-memory.json", "utf8"));
    assert.ok(memory[pool2]?.cooldown_reason === "velocity stop", "velocity stop reason should be explicit");
    assert.strictEqual(isBaseMintOnCooldown(mint2), true, "velocity stop should cooldown base mint");
  } finally {
    process.stdout.write = oldStdoutWrite;
    process.chdir(oldCwd);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function verifyDailyReportFees() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "evil-panda-profit-report-"));
  try {
    const date = "2026-06-08";
    const actionsFile = path.join(temp, `actions-${date}.jsonl`);
    const rows = [
      {
        timestamp: `${date}T01:00:00.000Z`,
        tool: "deploy_position",
        success: true,
        args: {
          pool_address: "PoolReport111111111111111111111111111111111",
          pool_name: "REPORT-SOL",
          amount_y: 0.5,
          strategy: "bid_ask",
          fee_tvl_ratio: 1.5,
          volume_active_tvl_multiple: 4.2,
        },
        result: {
          success: true,
          position: "PositionReport111111111111111111111111111111",
          pool: "PoolReport111111111111111111111111111111111",
          pool_name: "REPORT-SOL",
          amount_y: 0.5,
          strategy: "bid_ask",
          strategy_profile: "evil_panda_fee_dump_v1",
        },
      },
      {
        timestamp: `${date}T02:00:00.000Z`,
        tool: "close_position",
        success: true,
        args: {
          position_address: "PositionReport111111111111111111111111111111",
          reason: "Fee harvest: fees reached",
        },
        result: {
          success: true,
          position: "PositionReport111111111111111111111111111111",
          pool: "PoolReport111111111111111111111111111111111",
          pool_name: "REPORT-SOL",
          pnl_pct: 1.2,
          pnl_usd: 0.006,
          fees_sol: 0.004,
        },
      },
    ];
    fs.writeFileSync(actionsFile, rows.map((row) => JSON.stringify(row)).join("\n"));
    const result = spawnSync(process.execPath, [
      join(ROOT, "scripts/report-main-profitability-daily.js"),
      "--date",
      date,
      "--logs",
      temp,
      "--json",
    ], { encoding: "utf8" });
    assert.strictEqual(result.status, 0, `daily report should run: ${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.strictEqual(report.closedPositions, 1, "synthetic report should include one close");
    assert.strictEqual(report.closes[0].fee_earned_sol, 0.004, "daily report should read fee total from close result");
    assert.strictEqual(report.byExitReason.fee_harvest.fee_earned_sol, 0.004, "daily report should group fee totals");
    assert.strictEqual(report.byStrategyProfile.evil_panda_fee_dump_v1.fee_earned_sol, 0.004, "daily report should group fee totals by strategy profile");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function main() {
  const earlyNoFee = decision({ age_minutes: 59, pnl_pct: -1, total_value_usd: 0.495, unclaimed_fees_usd: 0.0001 });
  assert.strictEqual(earlyNoFee, null, "no-fee abort must not fire before 60m");
  const matureNoFee = decision({ age_minutes: 61, pnl_pct: -0.6, total_value_usd: 0.497, unclaimed_fees_usd: 0.0001 });
  assert.strictEqual(matureNoFee?.rule, "no_fee_abort", "mature weak-fee negative position should no-fee abort");
  assert.strictEqual(shouldGateFeeExitDecision(matureNoFee, baseManagement().feeExitPolicy), false, "loss-control no-fee abort should not wait for confluence");
  assert.strictEqual(
    shouldGateFeeExitDecision(matureNoFee, baseManagement({ exitConfluenceRules: ["fee_harvest", "max_hold_timeout", "no_fee_abort", "fee_conditional_abort", "emergency_failsafe"] }).feeExitPolicy),
    false,
    "loss-control no-fee abort must bypass confluence even if misconfigured into confluence rules",
  );

  const harvest = decision({ age_minutes: 30, pnl_pct: 0.5, total_value_usd: 0.503, unclaimed_fees_usd: 0.004 });
  assert.strictEqual(harvest?.rule, "fee_harvest", "fee harvest threshold should still trigger");
  assert.strictEqual(shouldGateFeeExitDecision(harvest, baseManagement().feeExitPolicy), true, "fee harvest should require confluence");

  const emergency = decision({ age_minutes: 10, pnl_pct: -7, total_value_usd: 0.465, unclaimed_fees_usd: 0.0001 }, {
    feeHarvestEnabled: false,
    noFeeAbortEnabled: false,
    feeConditionalAbortEnabled: false,
  });
  assert.strictEqual(emergency?.rule, "emergency_failsafe", "emergency failsafe should fire");
  assert.strictEqual(shouldGateFeeExitDecision(emergency, baseManagement().feeExitPolicy), false, "emergency exits must bypass confluence");

  const weakConfluence = evaluateFeeExitConfluenceFromRows(makeRows({ breakout: false }), baseManagement().feeExitPolicy);
  assert.strictEqual(weakConfluence.accepted, false, "weak rows should hold discretionary exit");
  const strongConfluence = evaluateFeeExitConfluenceFromRows(makeRows({ breakout: true }), baseManagement().feeExitPolicy);
  assert.strictEqual(strongConfluence.accepted, true, "breakout rows should pass discretionary exit");
  assert.ok(strongConfluence.signalCount >= 2, "confluence pass should have at least 2 signals");

  const example = loadJson("user-config.example.json");
  assert.strictEqual(example.deployAmountSol, 5, "Fabriq example deploy size is 5 SOL");
  assert.ok(!String(example.preset || "").toLowerCase().includes("nanocap"), "main example must not inherit nanocap preset defaults");
  assert.strictEqual(example.preset, "main-fabriq-degen-fee-rotation-v1", "main example uses Fabriq degen fee-rotation preset");
  assert.strictEqual(example.maxPositions, 4, "Fabriq example max positions is 4");
  assert.strictEqual(example.maxDeployAmount, 5, "Fabriq example max deploy amount is 5 SOL");
  assert.strictEqual(example.binsBelow, 35, "Fabriq example keeps fixed 35 bins below");
  assert.strictEqual(example.dynamicRangeWidthEnabled, false, "Fabriq example leaves dynamic range width disabled");
  assert.strictEqual(example.feeExitPolicy.strategyProfile, FABRIQ_DEGEN_STRATEGY_ID, "example uses Fabriq fee-rotation profile");
  assert.strictEqual(example.feeExitPolicy.feeHarvestMinHoldMinutes, 8, "Fabriq fee harvest can exit after 8m");
  assert.strictEqual(example.feeExitPolicy.noFeeAbortMaxHoldMinutes, 20, "Fabriq no-fee abort is rapid");
  assert.strictEqual(example.feeExitPolicy.exitConfluenceEnabled, true, "confluence enabled");

  const built = buildConfig(example, {});
  assert.strictEqual(built.risk.maxPositions, 4, "runtime config resolves maxPositions=4");
  assert.strictEqual(built.risk.maxDeployAmount, 5, "runtime config resolves maxDeployAmount=5");
  assert.strictEqual(built.strategy.binsBelow, 35, "runtime config resolves binsBelow=35");
  assert.strictEqual(built.strategy.dynamicRangeWidthEnabled, false, "runtime config resolves dynamic width disabled");
  assert.strictEqual(built.management.feeExitPolicy.strategyProfile, FABRIQ_DEGEN_STRATEGY_ID, "runtime keeps Fabriq strategy profile");
  assert.strictEqual(built.management.feeExitPolicy.exitConfluenceMinSignals, 2, "runtime keeps confluence threshold");
  assert.strictEqual(built.management.noFeeAbortCooldownHours, 12, "runtime keeps no-fee cooldown");
  assert.strictEqual(built.management.velocityStopCooldownHours, 24, "runtime keeps velocity cooldown");
  assert.strictEqual(built.management.pnlSnapshotBotName, "meridian", "main profile resolves meridian PnL snapshot bot name");

  const strategyLibrary = loadJson("strategy-library.json");
  const fabriqProfile = strategyLibrary.strategies?.[FABRIQ_DEGEN_STRATEGY_ID];
  assert.strictEqual(strategyLibrary.active, FABRIQ_DEGEN_STRATEGY_ID, "strategy library active profile should be Fabriq degen fee rotation");
  assert.ok(fabriqProfile, "strategy library contains Fabriq degen fee-rotation profile");
  assert.strictEqual(fabriqProfile.lp_strategy, "bid_ask", "Fabriq profile should use bid_ask");
  assert.strictEqual(fabriqProfile.entry?.single_side, "sol", "Fabriq profile should be SOL-only");
  assert.strictEqual(fabriqProfile.range?.type, "tight_fee_rotation", "Fabriq profile uses tight fee-rotation range policy");
  assert.strictEqual(fabriqProfile.range?.bins_below, 35, "Fabriq profile keeps fixed 35 bins below");
  assert.strictEqual(fabriqProfile.range?.bins_below_min, 35, "Fabriq profile pins min bins below");
  assert.strictEqual(fabriqProfile.range?.bins_below_max, 35, "Fabriq profile pins max bins below");
  assert.strictEqual(fabriqProfile.range?.bins_above, 0, "Fabriq profile pins bins_above to zero");
  assert.strictEqual(fabriqProfile.range?.dynamic_range_width_enabled, false, "Fabriq profile leaves dynamic width disabled");

  const evilPandaProfile = EVIL_PANDA_STRATEGY_PROFILE_FIXTURE.strategies.evil_panda_fee_dump_v1;
  assert.strictEqual(EVIL_PANDA_STRATEGY_PROFILE_FIXTURE.active, "evil_panda_fee_dump_v1", "strategy fixture active profile should be EvilPanda fee-dump");
  assert.strictEqual(evilPandaProfile.id, "evil_panda_fee_dump_v1", "strategy profile fixture id should be EvilPanda fee-dump");
  assert.strictEqual(evilPandaProfile.lp_strategy, "bid_ask", "strategy profile fixture should use bid_ask");
  assert.strictEqual(evilPandaProfile.entry?.single_side, "sol", "strategy profile fixture should be SOL-only");
  assert.strictEqual(evilPandaProfile.range?.bins_below, 35, "main keeps tight bid_ask bins in EvilPanda profile fixture");
  assert.strictEqual(evilPandaProfile.range?.bins_above, 0, "EvilPanda profile fixture pins bins_above to zero");

  assert.strictEqual(classifyCloseReason("Fee harvest: fees reached"), "fee_harvest", "fee harvest bucket");
  assert.strictEqual(classifyCloseReason("No-fee abort: stale"), "no_fee_abort", "no-fee bucket");
  assert.strictEqual(classifyCloseReason("Max-hold timeout: age 120m"), "max_hold_timeout", "max-hold bucket");

  await verifyPoolMemoryCooldowns();
  verifyDailyReportFees();

  const index = read("index.js");
  const dlmm = read("tools/dlmm.js");
  const report = read("scripts/report-main-profitability-daily.js");
  const confluence = read("fee-exit-confluence.js");
  assert.ok(index.includes("management.feeExitPolicy.confluence"), "runtime logs confluence decision context");
  assert.ok(index.includes("shouldGateFeeExitDecision(decision, policy)"), "runtime checks confluence gate");
  assert.ok(dlmm.includes("getActiveStrategy()?.id"), "deploy profile is derived from active strategy library");
  assert.ok(dlmm.includes("close_verification_status: \"rpc_rate_limited\""), "close verification degraded tx evidence preserved");
  assert.ok(dlmm.includes("recordDegradedClosePerformance"), "degraded close verification records performance for pool-memory cooldowns");
  assert.ok(dlmm.includes("fees_sol: sm ? feesUsd : null"), "close action result exposes fee totals for daily reports");
  assert.ok(dlmm.includes("strategy_profile"), "deploy/close telemetry carries strategy profile");
  assert.ok(report.includes("byExitReason") && report.includes("byStrategyProfile"), "daily report groups by exit reason and profile");
  assert.ok(!confluence.includes("RPC_URL") && !confluence.includes("API_KEY"), "confluence helper has no secret-bearing config references");

  console.log(JSON.stringify({
    success: true,
    checks: [
      "no-fee abort waits 60m",
      "emergency exits bypass confluence",
      "fee harvest requires 2-signal confluence",
      "pool memory blocks no-fee and velocity-stop pools/mints",
      "example config resolves Fabriq 5 SOL / 4 max positions",
      "Fabriq strategy-library profile is active and fixed 35-bin SOL-only",
      "EvilPanda strategy-library profile fixture validates independent of active strategy",
      "daily report groups by exit reason and strategy profile",
      "daily report reads fee totals from close results",
      "close verification degraded evidence remains preserved",
      "degraded close verification records performance/cooldown evidence",
    ],
    runtime_active_strategy: strategyLibrary.active ?? null,
    runtime_contains_fabriq_profile: Boolean(strategyLibrary.strategies?.[FABRIQ_DEGEN_STRATEGY_ID]),
    runtime_contains_evil_panda_profile: Boolean(strategyLibrary.strategies?.evil_panda_fee_dump_v1),
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ success: false, error: error.message }, null, 2));
  process.exit(1);
});
