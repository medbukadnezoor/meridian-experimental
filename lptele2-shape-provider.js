import { Connection, PublicKey } from "@solana/web3.js";

const DEFAULT_BINS_BELOW = 5;
const DEFAULT_BINS_ABOVE = 3;
const SOL_DECIMALS = 9;

let _DLMM = null;

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function tokenAmount(value, decimals) {
  if (value == null) return 0;
  const raw = typeof value?.toString === "function" ? value.toString() : value;
  const number = Number(raw);
  return Number.isFinite(number) ? number / (10 ** decimals) : 0;
}

function roundNumber(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : 0;
}

function getBinId(bin) {
  return asNumber(bin?.binId ?? bin?.id);
}

function getXAmount(bin) {
  return bin?.xAmount ?? bin?.amountX ?? bin?.tokenAmount ?? 0;
}

function getYAmount(bin) {
  return bin?.yAmount ?? bin?.amountY ?? bin?.quoteAmount ?? 0;
}

function getSupply(bin) {
  return tokenAmount(bin?.supply ?? bin?.liquidity ?? bin?.totalLiquidity ?? 0, 0);
}

function derivePriceInputs(telemetryContext, defaults) {
  const position = telemetryContext?.positions?.[0] || {};
  return {
    tokenDecimals: asNumber(telemetryContext?.tokenDecimals) ?? asNumber(position.base_decimals) ?? defaults.tokenDecimals,
    quoteDecimals: asNumber(telemetryContext?.quoteDecimals) ?? defaults.quoteDecimals,
    tokenPriceUsd: asNumber(telemetryContext?.tokenPriceUsd)
      ?? asNumber(position.base_price_usd)
      ?? asNumber(position.token_price_usd)
      ?? defaults.tokenPriceUsd,
    quotePriceUsd: asNumber(telemetryContext?.quotePriceUsd)
      ?? asNumber(telemetryContext?.solPriceUsd)
      ?? asNumber(position.quote_price_usd)
      ?? defaults.quotePriceUsd,
  };
}

async function loadDlmm() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
  }
  return _DLMM;
}

function summarizeBins({ bins, activeBin, telemetryContext, defaults }) {
  const { tokenDecimals, quoteDecimals, tokenPriceUsd, quotePriceUsd } = derivePriceInputs(telemetryContext, defaults);
  const missingUsdPrice = tokenPriceUsd == null || quotePriceUsd == null;
  const byId = new Map((bins || []).map((bin) => [getBinId(bin), bin]).filter(([id]) => id != null));
  const active = byId.get(activeBin);
  const below = [];
  for (let id = activeBin - 5; id < activeBin; id += 1) below.push(byId.get(id));
  const quoteActiveUsd = active && quotePriceUsd != null
    ? tokenAmount(getYAmount(active), quoteDecimals) * quotePriceUsd
    : 0;
  const quoteBelowUsd = quotePriceUsd != null
    ? below.reduce((sum, bin) => sum + tokenAmount(getYAmount(bin), quoteDecimals) * quotePriceUsd, 0)
    : 0;
  const tokenActiveUsd = active && tokenPriceUsd != null
    ? tokenAmount(getXAmount(active), tokenDecimals) * tokenPriceUsd
    : 0;
  const activeLiquidity = getSupply(active);
  const lowerLiquidity = getSupply(byId.get(activeBin - 1));
  const cliffPct = activeLiquidity > 0
    ? ((activeLiquidity - lowerLiquidity) / activeLiquidity) * 100
    : 0;
  return {
    quote_reserves_in_active_bin_usd: roundNumber(quoteActiveUsd),
    quote_reserves_within_5_bins_below_usd: roundNumber(quoteBelowUsd),
    token_reserves_in_active_bin_usd: roundNumber(tokenActiveUsd),
    adjacent_bin_liquidity_cliff_pct: roundNumber(cliffPct, 3),
    your_share_of_active_bin_tvl_pct: null,
    your_share_of_active_bin_tvl_pct_reason: "position_share_unavailable",
    lptele2_liquidity_shape_data_source: missingUsdPrice ? "rpc_bin_state_partial" : "rpc_bin_state",
  };
}

export function createLiquidityShapeProvider({
  connection = null,
  rpcUrl = process.env.RPC_URL,
  binsBelow = DEFAULT_BINS_BELOW,
  binsAbove = DEFAULT_BINS_ABOVE,
  tokenDecimals = 9,
  quoteDecimals = SOL_DECIMALS,
  tokenPriceUsd = null,
  quotePriceUsd = null,
  fetchBinStatesFn = null,
  logger = () => {},
} = {}) {
  const defaults = { tokenDecimals, quoteDecimals, tokenPriceUsd, quotePriceUsd };
  const getConnection = () => connection || new Connection(rpcUrl, "confirmed");

  return async function getLptele2LiquidityShape(telemetryContext = {}) {
    try {
      const activeBin = asNumber(telemetryContext.activeBin);
      if (activeBin == null) {
        return {
          quote_reserves_in_active_bin_usd: 0,
          quote_reserves_within_5_bins_below_usd: 0,
          token_reserves_in_active_bin_usd: 0,
          adjacent_bin_liquidity_cliff_pct: 0,
          your_share_of_active_bin_tvl_pct: null,
          your_share_of_active_bin_tvl_pct_reason: "active_bin_unavailable",
          lptele2_liquidity_shape_data_source: "rpc_bin_state_partial",
        };
      }

      let bins;
      let resolvedActiveBin = activeBin;
      if (typeof fetchBinStatesFn === "function") {
        const result = await fetchBinStatesFn({ ...telemetryContext, binsBelow, binsAbove });
        bins = Array.isArray(result) ? result : result?.bins;
        resolvedActiveBin = asNumber(result?.activeBin) ?? activeBin;
      } else {
        const DLMM = await loadDlmm();
        const dlmmPool = await DLMM.create(getConnection(), new PublicKey(telemetryContext.pool));
        const result = await dlmmPool.getBinsAroundActiveBin(binsBelow, binsAbove);
        bins = result.bins;
        resolvedActiveBin = asNumber(result.activeBin) ?? activeBin;
      }

      return summarizeBins({
        bins,
        activeBin: resolvedActiveBin,
        telemetryContext,
        defaults,
      });
    } catch (error) {
      logger("lptele_provider_warn", `LPTELE-2 bin-state provider failed: ${error.message}`);
      return {
        quote_reserves_in_active_bin_usd: 0,
        quote_reserves_within_5_bins_below_usd: 0,
        token_reserves_in_active_bin_usd: 0,
        adjacent_bin_liquidity_cliff_pct: 0,
        your_share_of_active_bin_tvl_pct: null,
        your_share_of_active_bin_tvl_pct_reason: "provider_error",
        lptele2_liquidity_shape_data_source: "rpc_bin_state_error",
      };
    }
  };
}
