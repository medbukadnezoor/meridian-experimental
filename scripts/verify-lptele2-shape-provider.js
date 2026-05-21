#!/usr/bin/env node
import assert from "assert";
import { readFileSync } from "fs";
import { createLiquidityShapeProvider } from "../lptele2-shape-provider.js";

function bnLike(value) {
  return { toString: () => String(value) };
}

async function main() {
  const provider = createLiquidityShapeProvider({
    fetchBinStatesFn: async () => ({
      activeBin: 100,
      bins: [
        { binId: 95, xAmount: bnLike(0), yAmount: bnLike(100_000000000), supply: bnLike(100) },
        { binId: 96, xAmount: bnLike(0), yAmount: bnLike(200_000000000), supply: bnLike(200) },
        { binId: 97, xAmount: bnLike(0), yAmount: bnLike(300_000000000), supply: bnLike(300) },
        { binId: 98, xAmount: bnLike(0), yAmount: bnLike(400_000000000), supply: bnLike(400) },
        { binId: 99, xAmount: bnLike(0), yAmount: bnLike(500_000000000), supply: bnLike(500) },
        { binId: 100, xAmount: bnLike(1_000_000000), yAmount: bnLike(2_000_000000), supply: bnLike(5_000) },
      ],
    }),
    tokenDecimals: 6,
    quoteDecimals: 9,
    tokenPriceUsd: 2,
    quotePriceUsd: 150,
  });
  const result = await provider({ pool: "11111111111111111111111111111111", activeBin: 100 });
  assert.strictEqual(result.lptele2_liquidity_shape_data_source, "rpc_bin_state");
  assert.strictEqual(result.quote_reserves_in_active_bin_usd, 300);
  assert.strictEqual(result.quote_reserves_within_5_bins_below_usd, 225000);
  assert.strictEqual(result.token_reserves_in_active_bin_usd, 2000);
  assert.strictEqual(result.adjacent_bin_liquidity_cliff_pct, 90);
  assert.strictEqual(result.your_share_of_active_bin_tvl_pct, null);
  assert.strictEqual(result.your_share_of_active_bin_tvl_pct_reason, "position_share_unavailable");

  const quietProvider = createLiquidityShapeProvider({
    fetchBinStatesFn: async () => ({ activeBin: 100, bins: [] }),
    tokenPriceUsd: 1,
    quotePriceUsd: 1,
  });
  const quiet = await quietProvider({ pool: "11111111111111111111111111111111", activeBin: 100 });
  assert.strictEqual(quiet.lptele2_liquidity_shape_data_source, "rpc_bin_state");
  assert.strictEqual(quiet.quote_reserves_in_active_bin_usd, 0);
  assert.strictEqual(quiet.quote_reserves_within_5_bins_below_usd, 0);
  assert.strictEqual(quiet.adjacent_bin_liquidity_cliff_pct, 0);

  const errorProvider = createLiquidityShapeProvider({
    fetchBinStatesFn: async () => {
      throw new Error("synthetic rpc failure");
    },
  });
  const errorResult = await errorProvider({ pool: "11111111111111111111111111111111", activeBin: 100 });
  assert.strictEqual(errorResult.lptele2_liquidity_shape_data_source, "rpc_bin_state_error");

  const indexSource = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(indexSource, /createLiquidityShapeProvider/);
  assert.match(indexSource, /getLptele2LiquidityShapeFn:\s*lptele2LiquidityShapeProvider/);
  assert.doesNotMatch(indexSource, /getLptele2LiquidityShapeFn:\s*null/);

  console.log(JSON.stringify({
    success: true,
    checks: [
      "mock bin state computes active quote reserve",
      "mock bin state computes below support",
      "mock bin state computes token reserve",
      "mock bin state computes liquidity cliff",
      "position share unavailable is explicit",
      "quiet bins return zeros",
      "error source is explicit",
      "index wires LPTELE-2 provider",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
