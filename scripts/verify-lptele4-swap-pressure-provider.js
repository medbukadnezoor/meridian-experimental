#!/usr/bin/env node
import assert from "assert";
import { readFileSync } from "fs";
import { createSwapPressureProvider } from "../lptele4-swap-pressure-provider.js";

async function main() {
  const nowMs = 1_779_000_000_000;
  const provider = createSwapPressureProvider({
    sellThresholdUsd: 500,
    fetchSwapEventsFn: async () => [
      { type: "swap", direction: "sell", amountUsd: 800, timestampMs: nowMs },
      { type: "swap", direction: "sell", amountUsd: 200, timestampMs: nowMs },
      { type: "swap", direction: "buy", amountUsd: 2000, timestampMs: nowMs },
      { type: "lp_remove", direction: "sell", amountUsd: 9999, timestampMs: nowMs },
    ],
  });
  const result = await provider({ pool: "11111111111111111111111111111111", observedAtMs: nowMs });
  assert.strictEqual(result.lptele4_swap_pressure_data_source, "helius_tx_decode");
  assert.strictEqual(result.swap_sell_usd_5m, 1000);
  assert.strictEqual(result.swap_buy_usd_5m, 2000);
  assert.strictEqual(result.sell_buy_ratio_5m, 0.5);
  assert.strictEqual(result.largest_single_sell_usd_5m, 800);
  assert.strictEqual(result.n_sells_over_threshold_5m, 1);
  assert.strictEqual(result.swap_slippage_p95_5m, null);
  assert.strictEqual(result.swap_slippage_p95_5m_reason, "slippage_unavailable");

  const sellOnlyProvider = createSwapPressureProvider({
    sellThresholdUsd: 500,
    fetchSwapEventsFn: async () => [
      { type: "swap", direction: "sell", amountUsd: 700, timestampMs: nowMs },
    ],
  });
  const sellOnly = await sellOnlyProvider({ pool: "11111111111111111111111111111111", observedAtMs: nowMs });
  assert.strictEqual(sellOnly.sell_buy_ratio_5m, 999);

  const quietProvider = createSwapPressureProvider({
    fetchSwapEventsFn: async () => [],
  });
  const quiet = await quietProvider({ pool: "11111111111111111111111111111111", observedAtMs: nowMs });
  assert.strictEqual(quiet.swap_sell_usd_5m, 0);
  assert.strictEqual(quiet.swap_buy_usd_5m, 0);
  assert.strictEqual(quiet.sell_buy_ratio_5m, 0);

  const errorProvider = createSwapPressureProvider({
    fetchSwapEventsFn: async () => {
      throw new Error("synthetic decode failure");
    },
  });
  const errorResult = await errorProvider({ pool: "11111111111111111111111111111111", observedAtMs: nowMs });
  assert.strictEqual(errorResult.lptele4_swap_pressure_data_source, "helius_tx_decode_error");

  const indexSource = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(indexSource, /createSwapPressureProvider/);
  assert.match(indexSource, /getLptele4SwapPressureFn:\s*lptele4SwapPressureProvider/);
  assert.doesNotMatch(indexSource, /getLptele4SwapPressureFn:\s*null/);

  console.log(JSON.stringify({
    success: true,
    checks: [
      "mock sell swap increases sell pressure",
      "mock buy swap increases buy pressure",
      "sell buy ratio handles normal and sell-only windows",
      "large sell threshold counted",
      "LP events do not leak into swap pressure",
      "slippage p95 deferred with explicit reason",
      "quiet swaps return zeros",
      "error source is explicit",
      "index wires LPTELE-4 provider",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
