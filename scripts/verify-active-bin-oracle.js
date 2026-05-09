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
    classifyRangeProximityZone,
    classifyShadowVelocity,
    classifyWhaleEscapeShadow,
    computeBinDistanceFields,
    computeRangeProximityFields,
    computePriceWindows,
    computeVelocityWindows,
    normalizeLptele2LiquidityShape,
    normalizeLptele4SwapPressure,
    normalizeWhaleEscapeFlow,
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
  assert.strictEqual(inRange.range_side, "in_range");
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
  assert.strictEqual(adverseAbove.range_side, "above_range");
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
  assert.strictEqual(nonAdverseBelow.range_side, "below_range");
  assert.strictEqual(nonAdverseBelow.adverse_oor_guess, false);
  assert.strictEqual(nonAdverseBelow.would_close_reason, null);

  const velocity10s = computeVelocityWindows(115, 10_000, [{ activeBin: 100, observedAtMs: 0 }]);
  assert.strictEqual(velocity10s.velocity_10s_bin_delta, 15);
  assert.strictEqual(velocity10s.velocity_10s_elapsed_sec, 10);
  assert.strictEqual(velocity10s.velocity_10s_bins_per_sec, 1.5);
  const watchSignal = classifyShadowVelocity(velocity10s);
  assert.strictEqual(watchSignal.shadow_velocity_signal, "watch");
  assert.ok(watchSignal.shadow_velocity_reason.includes("shadow_only_velocity_watch"));

  const price10s = computePriceWindows(110, 10_000, [{ activeBin: 100, activePrice: 100, observedAtMs: 0 }]);
  assert.strictEqual(price10s.price_delta_pct_10s, 10);
  assert.strictEqual(price10s.price_elapsed_sec_10s, 10);
  assert.strictEqual(price10s.price_rate_pct_per_sec_10s, 1);

  const missingPrice = computePriceWindows("not-a-number", 10_000, [{ activeBin: 100, activePrice: 100, observedAtMs: 0 }]);
  assert.strictEqual(missingPrice.price_delta_pct_10s, null);
  assert.strictEqual(missingPrice.price_elapsed_sec_10s, null);
  assert.strictEqual(missingPrice.price_rate_pct_per_sec_10s, null);

  const binDistance = computeBinDistanceFields({ lower_bin: 100, upper_bin: 130 }, 106);
  assert.strictEqual(binDistance.bin_distance_to_lower, 6);
  assert.strictEqual(binDistance.bin_distance_to_upper, 24);
  assert.strictEqual(binDistance.range_width_bins, 30);

  assert.strictEqual(classifyRangeProximityZone({ activeBin: 106, lowerBin: 100, upperBin: 130 }), "lower_half");
  assert.strictEqual(classifyRangeProximityZone({ activeBin: 124, lowerBin: 100, upperBin: 130 }), "upper_half");
  assert.strictEqual(classifyRangeProximityZone({ activeBin: 90, lowerBin: 100, upperBin: 130 }), "below_range");
  assert.strictEqual(classifyRangeProximityZone({ activeBin: 140, lowerBin: 100, upperBin: 130 }), "above_range");
  const proximity = computeRangeProximityFields(
    { lower_bin: 100, upper_bin: 130 },
    112,
    90_000,
    { zone: "lower_half", zoneSinceMs: 30_000 },
  );
  assert.strictEqual(proximity.bin_distance_to_lower_pct_of_range, 40);
  assert.strictEqual(proximity.bin_distance_to_upper_pct_of_range, 60);
  assert.strictEqual(proximity.range_position_pct, 40);
  assert.strictEqual(proximity.range_proximity_zone, "lower_half");
  assert.strictEqual(proximity.previous_range_proximity_zone, "lower_half");
  assert.strictEqual(proximity.range_edge_zone, null);
  assert.strictEqual(proximity.range_edge_threshold_bins, 3);
  assert.strictEqual(proximity.rolling_lower_half_sec_60s, 60);
  assert.strictEqual(proximity.rolling_upper_half_sec_60s, 0);
  assert.strictEqual(proximity.rolling_near_edge_sec_60s, 0);
  assert.strictEqual(proximity.time_in_current_range_zone_minutes, 1);

  const edgeProximity = computeRangeProximityFields(
    { lower_bin: 100, upper_bin: 130 },
    102,
    90_000,
    {
      zone: "lower_half",
      edgeZone: "near_lower_edge",
      zoneSinceMs: 30_000,
      observedAtMs: 30_000,
    },
  );
  assert.strictEqual(edgeProximity.range_edge_zone, "near_lower_edge");
  assert.strictEqual(edgeProximity.rolling_near_edge_sec_60s, 60);
  assert.strictEqual(edgeProximity.rolling_near_lower_edge_sec_60s, 60);
  assert.strictEqual(edgeProximity.rolling_near_upper_edge_sec_60s, 0);

  const unavailableWhaleFlow = normalizeWhaleEscapeFlow(null);
  assert.strictEqual(unavailableWhaleFlow.pool_lp_net_dep_usd_5m, null);
  assert.strictEqual(unavailableWhaleFlow.pool_lp_net_dep_usd_15m, null);
  assert.strictEqual(unavailableWhaleFlow.pool_lp_net_dep_usd_30m, null);
  assert.strictEqual(unavailableWhaleFlow.pool_lp_add_count_5m, null);
  assert.strictEqual(unavailableWhaleFlow.pool_lp_remove_count_5m, null);
  assert.strictEqual(unavailableWhaleFlow.pool_lp_largest_remove_usd_5m, null);
  assert.strictEqual(unavailableWhaleFlow.whale_escape_data_source, null);

  const normalizedWhaleFlow = normalizeWhaleEscapeFlow({
    netDepUsd5m: "-1000.1234567",
    netDepUsd15m: "-2500.5",
    netDepUsd30m: "-7000",
    addCount5m: "2.9",
    removeCount5m: 3,
    largestRemoveUsd5m: "1750.1234567",
    dataSource: "reserve_delta_poll",
  });
  assert.strictEqual(normalizedWhaleFlow.pool_lp_net_dep_usd_5m, -1000.123457);
  assert.strictEqual(normalizedWhaleFlow.pool_lp_net_dep_usd_15m, -2500.5);
  assert.strictEqual(normalizedWhaleFlow.pool_lp_net_dep_usd_30m, -7000);
  assert.strictEqual(normalizedWhaleFlow.pool_lp_add_count_5m, 2);
  assert.strictEqual(normalizedWhaleFlow.pool_lp_remove_count_5m, 3);
  assert.strictEqual(normalizedWhaleFlow.pool_lp_largest_remove_usd_5m, 1750.123457);
  assert.strictEqual(normalizedWhaleFlow.whale_escape_data_source, "reserve_delta_poll");

  const unavailableLiquidityShape = normalizeLptele2LiquidityShape(null);
  assert.strictEqual(unavailableLiquidityShape.quote_reserves_in_active_bin_usd, null);
  assert.strictEqual(unavailableLiquidityShape.quote_reserves_within_5_bins_below_usd, null);
  assert.strictEqual(unavailableLiquidityShape.token_reserves_in_active_bin_usd, null);
  assert.strictEqual(unavailableLiquidityShape.adjacent_bin_liquidity_cliff_pct, null);
  assert.strictEqual(unavailableLiquidityShape.your_share_of_active_bin_tvl_pct, null);
  assert.strictEqual(unavailableLiquidityShape.lptele2_liquidity_shape_data_source, null);

  const normalizedLiquidityShape = normalizeLptele2LiquidityShape({
    activeBinQuoteUsd: "1200.1234567",
    quoteReservesWithin5BinsBelowUsd: "5500.5",
    activeBinTokenUsd: 720,
    adjacentBinLiquidityCliffPct: "42.25",
    positionShareOfActiveBinTvlPct: "3.5",
    dataSource: "bin_reserve_poll",
  });
  assert.strictEqual(normalizedLiquidityShape.quote_reserves_in_active_bin_usd, 1200.123457);
  assert.strictEqual(normalizedLiquidityShape.quote_reserves_within_5_bins_below_usd, 5500.5);
  assert.strictEqual(normalizedLiquidityShape.token_reserves_in_active_bin_usd, 720);
  assert.strictEqual(normalizedLiquidityShape.adjacent_bin_liquidity_cliff_pct, 42.25);
  assert.strictEqual(normalizedLiquidityShape.your_share_of_active_bin_tvl_pct, 3.5);
  assert.strictEqual(normalizedLiquidityShape.lptele2_liquidity_shape_data_source, "bin_reserve_poll");

  const unavailableSwapPressure = normalizeLptele4SwapPressure(null);
  assert.strictEqual(unavailableSwapPressure.swap_buy_usd_5m, null);
  assert.strictEqual(unavailableSwapPressure.swap_sell_usd_5m, null);
  assert.strictEqual(unavailableSwapPressure.sell_buy_ratio_5m, null);
  assert.strictEqual(unavailableSwapPressure.largest_single_sell_usd_5m, null);
  assert.strictEqual(unavailableSwapPressure.n_sells_over_threshold_5m, null);
  assert.strictEqual(unavailableSwapPressure.swap_slippage_p95_5m, null);
  assert.strictEqual(unavailableSwapPressure.lptele4_swap_pressure_data_source, null);

  const normalizedSwapPressure = normalizeLptele4SwapPressure({
    swapBuyUsd5m: "800.12",
    swapSellUsd5m: "3200.5",
    sellBuyRatio5m: "4.0",
    largestSingleSellUsd5m: "1500.777777",
    nSellsOverThreshold5m: "3.9",
    swapSlippageP95_5m: "2.125",
    dataSource: "swap_event_poll",
  });
  assert.strictEqual(normalizedSwapPressure.swap_buy_usd_5m, 800.12);
  assert.strictEqual(normalizedSwapPressure.swap_sell_usd_5m, 3200.5);
  assert.strictEqual(normalizedSwapPressure.sell_buy_ratio_5m, 4);
  assert.strictEqual(normalizedSwapPressure.largest_single_sell_usd_5m, 1500.777777);
  assert.strictEqual(normalizedSwapPressure.n_sells_over_threshold_5m, 3);
  assert.strictEqual(normalizedSwapPressure.swap_slippage_p95_5m, 2.125);
  assert.strictEqual(normalizedSwapPressure.lptele4_swap_pressure_data_source, "swap_event_poll");

  const whaleWatch = classifyWhaleEscapeShadow({
    flow: normalizedWhaleFlow,
    binDistanceToLower: 6,
    pnlPct: -5,
  });
  assert.strictEqual(whaleWatch.whale_escape_shadow_signal, "watch");
  assert.ok(whaleWatch.whale_escape_shadow_reason.includes("shadow_only_whale_escape_watch"));

  const whaleCandidate = classifyWhaleEscapeShadow({
    flow: { ...normalizedWhaleFlow, pool_lp_net_dep_usd_15m: -5500 },
    binDistanceToLower: 4,
    pnlPct: -1.5,
  });
  assert.strictEqual(whaleCandidate.whale_escape_shadow_signal, "candidate");
  assert.ok(whaleCandidate.whale_escape_shadow_reason.includes("shadow_only_whale_escape_candidate"));

  const whaleMissing = classifyWhaleEscapeShadow({
    flow: unavailableWhaleFlow,
    binDistanceToLower: 4,
    pnlPct: -1.5,
  });
  assert.strictEqual(whaleMissing.whale_escape_shadow_signal, null);
  assert.strictEqual(whaleMissing.whale_escape_shadow_reason, null);

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
    getActiveBinFn: async () => ({ binId: 148, price: "not-a-number", pricePerLamport: undefined }),
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
  assert.strictEqual(rows[0].active_price, null);
  assert.strictEqual(rows[0].active_price_per_lamport, null);
  assert.strictEqual(rows[0].prior_active_bin, 132);
  assert.strictEqual(rows[0].bin_delta, 16);
  assert.strictEqual(rows[0].in_range, false);
  assert.strictEqual(rows[0].range_side, "above_range");
  assert.strictEqual(rows[0].adverse_oor_guess, true);
  assert.ok(Object.hasOwn(rows[0], "velocity_10s_bin_delta"));
  assert.ok(Object.hasOwn(rows[0], "velocity_30s_bin_delta"));
  assert.ok(Object.hasOwn(rows[0], "price_delta_pct_10s"));
  assert.ok(Object.hasOwn(rows[0], "price_delta_pct_30s"));
  assert.strictEqual(rows[0].price_delta_pct_10s, null);
  assert.strictEqual(rows[0].price_rate_pct_per_sec_10s, null);
  assert.ok(Object.hasOwn(rows[0], "shadow_velocity_signal"));
  assert.ok(Object.hasOwn(rows[0], "shadow_velocity_reason"));
  assert.strictEqual(rows[0].pool_lp_net_dep_usd_5m, null);
  assert.strictEqual(rows[0].pool_lp_net_dep_usd_15m, null);
  assert.strictEqual(rows[0].pool_lp_net_dep_usd_30m, null);
  assert.strictEqual(rows[0].pool_lp_add_count_5m, null);
  assert.strictEqual(rows[0].pool_lp_remove_count_5m, null);
  assert.strictEqual(rows[0].pool_lp_largest_remove_usd_5m, null);
  assert.strictEqual(rows[0].quote_reserves_in_active_bin_usd, null);
  assert.strictEqual(rows[0].quote_reserves_within_5_bins_below_usd, null);
  assert.strictEqual(rows[0].token_reserves_in_active_bin_usd, null);
  assert.strictEqual(rows[0].adjacent_bin_liquidity_cliff_pct, null);
  assert.strictEqual(rows[0].your_share_of_active_bin_tvl_pct, null);
  assert.strictEqual(rows[0].lptele2_liquidity_shape_data_source, null);
  assert.strictEqual(rows[0].swap_buy_usd_5m, null);
  assert.strictEqual(rows[0].swap_sell_usd_5m, null);
  assert.strictEqual(rows[0].sell_buy_ratio_5m, null);
  assert.strictEqual(rows[0].largest_single_sell_usd_5m, null);
  assert.strictEqual(rows[0].n_sells_over_threshold_5m, null);
  assert.strictEqual(rows[0].swap_slippage_p95_5m, null);
  assert.strictEqual(rows[0].lptele4_swap_pressure_data_source, null);
  assert.strictEqual(rows[0].bin_distance_to_lower, 48);
  assert.strictEqual(rows[0].bin_distance_to_upper, -18);
  assert.strictEqual(rows[0].range_width_bins, 30);
  assert.strictEqual(rows[0].bin_distance_to_lower_pct_of_range, 160);
  assert.strictEqual(rows[0].bin_distance_to_upper_pct_of_range, -60);
  assert.strictEqual(rows[0].range_position_pct, 160);
  assert.strictEqual(rows[0].range_proximity_zone, "above_range");
  assert.strictEqual(rows[0].previous_range_proximity_zone, null);
  assert.strictEqual(rows[0].range_edge_zone, null);
  assert.strictEqual(rows[0].range_edge_threshold_bins, 3);
  assert.strictEqual(rows[0].rolling_lower_half_sec_60s, 0);
  assert.strictEqual(rows[0].rolling_upper_half_sec_60s, 0);
  assert.strictEqual(rows[0].rolling_near_edge_sec_60s, 0);
  assert.strictEqual(rows[0].time_in_current_range_zone_minutes, 0);
  assert.strictEqual(rows[0].whale_escape_shadow_signal, null);
  assert.strictEqual(rows[0].whale_escape_shadow_reason, null);
  assert.strictEqual(rows[0].whale_escape_data_source, null);
  assert.ok(rows[0].would_close_reason.includes("shadow_only_active_bin_above_range"));

  const whaleTempDir = mkdtempSync(join(tmpdir(), "meridian-whale-escape-"));
  const whaleConnection = new FakeConnection();
  const whaleRowsSeen = [];
  const lptele2RowsSeen = [];
  const lptele4RowsSeen = [];
  const whaleRecorder = new ActiveBinOracleRecorder({
    connection: whaleConnection,
    debounceMs: 10,
    logDir: whaleTempDir,
    getActiveBinFn: async () => ({ binId: 104, price: 1.04, pricePerLamport: "1040000000" }),
    getPoolLiquidityFlowFn: async (context) => {
      whaleRowsSeen.push(context.pool);
      return {
        pool_lp_net_dep_usd_5m: -1200,
        pool_lp_net_dep_usd_15m: -5500,
        pool_lp_net_dep_usd_30m: -8000,
        pool_lp_add_count_5m: 1,
        pool_lp_remove_count_5m: 4,
        pool_lp_largest_remove_usd_5m: 3250.25,
        whale_escape_data_source: "reserve_delta_poll",
      };
    },
    getLptele2LiquidityShapeFn: async (context) => {
      lptele2RowsSeen.push(context.pool);
      return {
        quote_reserves_in_active_bin_usd: 1_250.5,
        quote_reserves_within_5_bins_below_usd: 5_600,
        token_reserves_in_active_bin_usd: 725.25,
        adjacent_bin_liquidity_cliff_pct: 41.5,
        your_share_of_active_bin_tvl_pct: 3.75,
        lptele2_liquidity_shape_data_source: "bin_reserve_poll",
      };
    },
    getLptele4SwapPressureFn: async (context) => {
      lptele4RowsSeen.push(context.pool);
      return {
        swap_buy_usd_5m: 800,
        swap_sell_usd_5m: 3_400,
        sell_buy_ratio_5m: 4.25,
        largest_single_sell_usd_5m: 1_700,
        n_sells_over_threshold_5m: 4,
        swap_slippage_p95_5m: 2.4,
        lptele4_swap_pressure_data_source: "swap_event_poll",
      };
    },
    logger: () => {},
    now: () => new Date("2026-04-29T09:05:00.000Z"),
  });
  whaleRecorder.updatePositions([
    {
      pool,
      position: "Whale11111111111111111111111111111111",
      pair: "WHALE-SOL",
      lower_bin: 100,
      upper_bin: 130,
      active_bin: 106,
      pnl_pct: -1.2,
    },
  ]);
  await whaleRecorder.recordPoolSample(pool);
  const whaleRows = readFileSync(join(whaleTempDir, "active-bin-oracle-2026-04-29.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.strictEqual(whaleRowsSeen.length, 1);
  assert.strictEqual(lptele2RowsSeen.length, 1);
  assert.strictEqual(lptele4RowsSeen.length, 1);
  assert.strictEqual(whaleRows[0].pool_lp_net_dep_usd_5m, -1200);
  assert.strictEqual(whaleRows[0].pool_lp_net_dep_usd_15m, -5500);
  assert.strictEqual(whaleRows[0].pool_lp_net_dep_usd_30m, -8000);
  assert.strictEqual(whaleRows[0].pool_lp_add_count_5m, 1);
  assert.strictEqual(whaleRows[0].pool_lp_remove_count_5m, 4);
  assert.strictEqual(whaleRows[0].pool_lp_largest_remove_usd_5m, 3250.25);
  assert.strictEqual(whaleRows[0].quote_reserves_in_active_bin_usd, 1250.5);
  assert.strictEqual(whaleRows[0].quote_reserves_within_5_bins_below_usd, 5600);
  assert.strictEqual(whaleRows[0].token_reserves_in_active_bin_usd, 725.25);
  assert.strictEqual(whaleRows[0].adjacent_bin_liquidity_cliff_pct, 41.5);
  assert.strictEqual(whaleRows[0].your_share_of_active_bin_tvl_pct, 3.75);
  assert.strictEqual(whaleRows[0].lptele2_liquidity_shape_data_source, "bin_reserve_poll");
  assert.strictEqual(whaleRows[0].swap_buy_usd_5m, 800);
  assert.strictEqual(whaleRows[0].swap_sell_usd_5m, 3400);
  assert.strictEqual(whaleRows[0].sell_buy_ratio_5m, 4.25);
  assert.strictEqual(whaleRows[0].largest_single_sell_usd_5m, 1700);
  assert.strictEqual(whaleRows[0].n_sells_over_threshold_5m, 4);
  assert.strictEqual(whaleRows[0].swap_slippage_p95_5m, 2.4);
  assert.strictEqual(whaleRows[0].lptele4_swap_pressure_data_source, "swap_event_poll");
  assert.strictEqual(whaleRows[0].bin_distance_to_lower, 4);
  assert.strictEqual(whaleRows[0].bin_distance_to_upper, 26);
  assert.strictEqual(whaleRows[0].range_width_bins, 30);
  assert.strictEqual(whaleRows[0].bin_distance_to_lower_pct_of_range, 13.333);
  assert.strictEqual(whaleRows[0].bin_distance_to_upper_pct_of_range, 86.667);
  assert.strictEqual(whaleRows[0].range_position_pct, 13.333);
  assert.strictEqual(whaleRows[0].range_proximity_zone, "lower_half");
  assert.strictEqual(whaleRows[0].range_edge_zone, null);
  assert.strictEqual(whaleRows[0].range_edge_threshold_bins, 3);
  assert.strictEqual(whaleRows[0].rolling_lower_half_sec_60s, 0);
  assert.strictEqual(whaleRows[0].rolling_near_edge_sec_60s, 0);
  assert.strictEqual(whaleRows[0].time_in_current_range_zone_minutes, 0);
  assert.strictEqual(whaleRows[0].whale_escape_shadow_signal, "candidate");
  assert.ok(whaleRows[0].whale_escape_shadow_reason.includes("shadow_only_whale_escape_candidate"));
  assert.strictEqual(whaleRows[0].whale_escape_data_source, "reserve_delta_poll");
  await whaleRecorder.stop();
  rmSync(whaleTempDir, { recursive: true, force: true });

  const velocityTempDir = mkdtempSync(join(tmpdir(), "meridian-active-bin-velocity-"));
  const velocityConnection = new FakeConnection();
  const sampleTimes = [
    new Date("2026-04-29T10:00:00.000Z"),
    new Date("2026-04-29T10:00:10.000Z"),
    new Date("2026-04-29T10:00:31.000Z"),
  ];
  const sampleBins = [115, 165];
  const samplePrices = [1.15, 1.65];
  const samplePricesPerLamport = ["1150000000", "1650000000"];
  let nowIndex = 0;
  let binIndex = 0;
  let priceIndex = 0;
  const emergencyRows = [];
  const velocityRecorder = new ActiveBinOracleRecorder({
    connection: velocityConnection,
    debounceMs: 10,
    logDir: velocityTempDir,
    getActiveBinFn: async () => {
      const index = priceIndex++;
      return {
        binId: sampleBins[binIndex++],
        price: samplePrices[index],
        pricePerLamport: samplePricesPerLamport[index],
      };
    },
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
  assert.strictEqual(velocityRows[0].active_price, 1.15);
  assert.strictEqual(velocityRows[0].active_price_per_lamport, 1150000000);
  assert.strictEqual(velocityRows[0].shadow_velocity_signal, "watch");
  assert.strictEqual(velocityRows[1].velocity_30s_bin_delta, 65);
  assert.strictEqual(velocityRows[1].active_price, 1.65);
  assert.strictEqual(velocityRows[1].active_price_per_lamport, 1650000000);
  assert.strictEqual(velocityRows[1].price_delta_pct_30s, 43.478261);
  assert.strictEqual(velocityRows[1].price_rate_pct_per_sec_30s, 2.070393);
  assert.strictEqual(velocityRows[1].rolling_lower_half_sec_60s, 21);
  assert.strictEqual(velocityRows[1].rolling_upper_half_sec_60s, 0);
  assert.strictEqual(velocityRows[1].rolling_near_edge_sec_60s, 0);
  assert.strictEqual(velocityRows[1].shadow_velocity_signal, "rug_like_extreme");
  assert.strictEqual(emergencyRows.length, 1);
  assert.strictEqual(emergencyRows[0].position, "Velocity111111111111111111111111111111");
  await velocityRecorder.stop();
  rmSync(velocityTempDir, { recursive: true, force: true });

  const priceOnlyTempDir = mkdtempSync(join(tmpdir(), "meridian-active-price-only-"));
  const priceOnlyConnection = new FakeConnection();
  const priceOnlyTimes = [
    new Date("2026-04-29T11:00:00.000Z"),
    new Date("2026-04-29T11:00:10.000Z"),
    new Date("2026-04-29T11:00:31.000Z"),
  ];
  const priceOnlySamples = [
    { binId: 101, price: 1, pricePerLamport: "1000000000" },
    { binId: 102, price: 100, pricePerLamport: "100000000000" },
  ];
  let priceOnlyNowIndex = 0;
  let priceOnlySampleIndex = 0;
  const priceOnlyEmergencyRows = [];
  const priceOnlyRecorder = new ActiveBinOracleRecorder({
    connection: priceOnlyConnection,
    debounceMs: 10,
    logDir: priceOnlyTempDir,
    getActiveBinFn: async () => priceOnlySamples[priceOnlySampleIndex++],
    logger: () => {},
    now: () => priceOnlyTimes[priceOnlyNowIndex],
  });
  priceOnlyRecorder.setEmergencyExitHandler(async (row) => {
    priceOnlyEmergencyRows.push(row);
  }, { enabled: true, maxPnlPct: 2 });
  priceOnlyRecorder.updatePositions([
    {
      pool,
      position: "PriceOnly1111111111111111111111111111",
      pair: "PRICE-SOL",
      lower_bin: 90,
      upper_bin: 140,
      active_bin: 100,
      pnl_pct: -5,
    },
  ]);
  priceOnlyNowIndex = 1;
  await priceOnlyRecorder.recordPoolSample(pool);
  priceOnlyNowIndex = 2;
  await priceOnlyRecorder.recordPoolSample(pool);
  const priceOnlyRows = readFileSync(join(priceOnlyTempDir, "active-bin-oracle-2026-04-29.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.strictEqual(priceOnlyRows[1].price_delta_pct_30s, 9900);
  assert.strictEqual(priceOnlyRows[1].shadow_velocity_signal, null);
  assert.strictEqual(priceOnlyEmergencyRows.length, 0);
  await priceOnlyRecorder.stop();
  rmSync(priceOnlyTempDir, { recursive: true, force: true });

  const source = readFileSync(join(ROOT, "active-bin-oracle.js"), "utf8");
  assert.ok(!source.includes("closePosition"));
  assert.ok(!source.includes("executeTool"));
  const executionConsumerFiles = [
    "index.js",
    "pool-memory.js",
    "tools/dlmm.js",
    "tools/executor.js",
    "tools/screening.js",
    "oor-reposition.js",
  ];
  for (const file of executionConsumerFiles) {
    const consumerSource = readFileSync(join(ROOT, file), "utf8");
    assert.ok(!consumerSource.includes("whale_escape_"), `${file} must not consume whale_escape fields`);
    assert.ok(!consumerSource.includes("pool_lp_net_dep_usd"), `${file} must not consume pool_lp fields`);
    assert.ok(!consumerSource.includes("range_proximity_"), `${file} must not consume LPTELE-1 range proximity fields`);
    assert.ok(!consumerSource.includes("time_in_current_range_zone"), `${file} must not consume LPTELE-1 range duration fields`);
    assert.ok(!consumerSource.includes("range_edge_zone"), `${file} must not consume LPTELE-1 range edge fields`);
    assert.ok(!consumerSource.includes("rolling_near_edge_sec_60s"), `${file} must not consume LPTELE-1 rolling edge fields`);
    assert.ok(!consumerSource.includes("rolling_lower_half_sec_60s"), `${file} must not consume LPTELE-1 rolling half fields`);
    assert.ok(!consumerSource.includes("quote_reserves_in_active_bin_usd"), `${file} must not consume LPTELE-2 liquidity shape fields`);
    assert.ok(!consumerSource.includes("adjacent_bin_liquidity_cliff_pct"), `${file} must not consume LPTELE-2 liquidity cliff fields`);
    assert.ok(!consumerSource.includes("swap_sell_usd_5m"), `${file} must not consume LPTELE-4 swap pressure fields`);
    assert.ok(!consumerSource.includes("sell_buy_ratio_5m"), `${file} must not consume LPTELE-4 sell pressure fields`);
    assert.ok(!consumerSource.includes("largest_single_sell_usd_5m"), `${file} must not consume LPTELE-4 large sell fields`);
  }

  recorder.updatePositions([]);
  assert.deepStrictEqual(fakeConnection.removed, [1], "unsubscribes removed pools");
  await recorder.stop();

  proof = {
    success: true,
    checks: {
      inRangeClassification: true,
      rangeSideClassification: true,
      adverseOorClassification: true,
      nonAdverseProfitableOor: true,
      velocityCalculation: true,
      priceWindowCalculation: true,
      missingPriceNullFields: true,
      binDistanceFields: true,
      rangeProximityFields: true,
      rangeZoneDurationFields: true,
      rangeEdgeFields: true,
      rollingRangeDwellFields: true,
      whaleEscapeNullFields: true,
      whaleEscapeNormalization: true,
      lptele2NullFields: true,
      lptele2Normalization: true,
      lptele4NullFields: true,
      lptele4Normalization: true,
      whaleEscapeWatchSignal: true,
      whaleEscapeCandidateSignal: true,
      whaleEscapeFieldsPreservedInRows: true,
      lptele2FieldsPreservedInRows: true,
      lptele4FieldsPreservedInRows: true,
      velocity10sWatchSignal: true,
      velocity30sExtremeSignal: true,
      liveEmergencyTriggersExtremeOnly: true,
      priceMovementDoesNotTriggerEmergency: true,
      velocityWindowFieldsPreservedInRows: true,
      priceFieldsPreservedInRows: true,
      oneSubscriptionPerPool: true,
      jsonlRowsWritten: rows.length,
      noCloseOrExecuteImports: true,
      noWhaleEscapeExecutionConsumers: true,
      noRangeProximityExecutionConsumers: true,
      noLptele2ExecutionConsumers: true,
      noLptele4ExecutionConsumers: true,
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
