import { config } from "../config.js";

const METEORA_DLMM_API = "https://dlmm.datapi.meteora.ag";
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES = Object.freeze({
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
});
const POOL_MAPPING_CACHE_MS = 5 * 60 * 1000;
const poolMappingCache = new Map();

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function optionalNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

export async function fetchTopMeteoraDlmmPoolsForMint(mint, minTvl = 0, limit = 2, runtimeConfig = config) {
  const filterBy = minTvl > 0 ? `&filter_by=${encodeURIComponent(`tvl>${minTvl}`)}` : "";
  const url = `${METEORA_DLMM_API}/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent("tvl:desc")}${filterBy}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Meteora pool search ${res.status}`);
  const data = await res.json();
  const pools = Array.isArray(data?.data) ? data.data : [];
  return pools
    .filter((pool) => {
      const baseMatches = pool?.token_x?.address === mint || pool?.token_x_mint === mint;
      const quoteIsSol =
        pool?.token_y?.address === runtimeConfig.tokens?.SOL ||
        pool?.token_y_mint === runtimeConfig.tokens?.SOL ||
        pool?.token_y?.symbol === "SOL";
      const poolType = String(pool?.pool_type || "dlmm").toLowerCase();
      return baseMatches && quoteIsSol && (poolType === "dlmm" || poolType === "");
    })
    .slice(0, limit);
}

export async function fetchPoolDiscoveryDetailDirect(poolAddress, runtimeConfig = config) {
  const timeframe = encodeURIComponent(getVolatilityTimeframe(runtimeConfig.screening?.timeframe || "5m"));
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=${timeframe}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return null;
  const data = await res.json();
  return (data?.data || [])[0] ?? null;
}

export async function pickBestMeteoraDlmmPool(pools, runtimeConfig = config) {
  const details = await Promise.all(
    pools.map((pool) => fetchPoolDiscoveryDetailDirect(pool.address || pool.pool_address, runtimeConfig).catch(() => null)),
  );
  if (pools.length <= 1) return { pool: pools[0] ?? null, detail: details[0] ?? null };
  const scored = pools.map((pool, index) => {
    const detail = details[index];
    const activeTvl = num(detail?.active_tvl ?? pool.active_tvl ?? pool.tvl ?? pool.liquidity);
    const feeActiveTvlRatio = Number(detail?.fee_active_tvl_ratio) > 0
      ? Number(detail.fee_active_tvl_ratio)
      : (activeTvl > 0 ? (num(detail?.fee) / activeTvl) * 100 : 0);
    return { pool, detail, feeActiveTvlRatio, activeTvl };
  });
  scored.sort((a, b) => b.feeActiveTvlRatio - a.feeActiveTvlRatio || b.activeTvl - a.activeTvl);
  return { pool: scored[0].pool, detail: scored[0].detail };
}

export async function resolveTokenToMeteoraDlmmPool(mint, {
  minTvl = 0,
  limit = 2,
  runtimeConfig = config,
  cacheMs = POOL_MAPPING_CACHE_MS,
} = {}) {
  if (!mint) return null;
  const cacheKey = `${mint}:${minTvl}:${limit}:${runtimeConfig.screening?.timeframe || "5m"}`;
  const cached = poolMappingCache.get(cacheKey);
  if (cached && Date.now() - cached.at < cacheMs) return cached.value;

  const value = await (async () => {
    const topPools = await fetchTopMeteoraDlmmPoolsForMint(mint, minTvl, limit, runtimeConfig);
    if (topPools.length === 0) return { pool: null, detail: null, pools: [] };
    const best = await pickBestMeteoraDlmmPool(topPools, runtimeConfig);
    return { ...best, pools: topPools };
  })();

  poolMappingCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

export function condenseResolvedMeteoraPool({ token = {}, pool, poolDetail, source = "meteora", runtimeConfig = config } = {}) {
  if (!pool) return null;
  const poolAddress = pool.address || pool.pool_address;
  const activeTvl = num(poolDetail?.active_tvl ?? pool.active_tvl ?? pool.tvl ?? pool.liquidity);
  const feeActiveTvlRatio = Number(poolDetail?.fee_active_tvl_ratio) > 0
    ? Number(Number(poolDetail.fee_active_tvl_ratio).toFixed(4))
    : (activeTvl > 0 ? Number(((num(poolDetail?.fee) / activeTvl) * 100).toFixed(4)) : 0);
  const mint = token.mint || token.address || pool.token_x?.address || pool.token_x_mint;
  return {
    pool: poolAddress,
    name: pool.name || `${token.symbol || pool.token_x?.symbol || "?"}-SOL`,
    base: {
      symbol: token.symbol || pool.token_x?.symbol,
      mint,
      organic: optionalNum(poolDetail?.token_x?.organic_score ?? pool.token_x?.organic_score),
      warnings: 0,
    },
    quote: {
      symbol: pool.token_y?.symbol || "SOL",
      mint: pool.token_y?.address || runtimeConfig.tokens?.SOL,
      organic: optionalNum(poolDetail?.token_y?.organic_score ?? pool.token_y?.organic_score),
    },
    pool_type: "dlmm",
    bin_step: pool.pool_config?.bin_step ?? poolDetail?.dlmm_params?.bin_step ?? null,
    fee_pct: pool.pool_config?.base_fee_pct ?? poolDetail?.fee_pct ?? null,
    active_tvl: Math.round(activeTvl),
    fee_active_tvl_ratio: feeActiveTvlRatio,
    volatility: poolDetail?.volatility != null ? Number(Number(poolDetail.volatility).toFixed(4)) : null,
    volatility_timeframe: getVolatilityTimeframe(runtimeConfig.screening?.timeframe || "5m"),
    holders: num(token.holders ?? token.holder_count),
    mcap: Math.round(num(token.market_cap ?? token.marketCapUsd ?? token.mcap)),
    organic_score: optionalNum(poolDetail?.token_x?.organic_score ?? pool.token_x?.organic_score),
    quote_organic_score: optionalNum(poolDetail?.token_y?.organic_score ?? pool.token_y?.organic_score),
    token_age_hours: token.token_age_hours ?? null,
    dev: token.creator || token.dev || null,
    price: num(token.price ?? token.priceUsd),
    price_change_pct: num(token.price_change_pct ?? token.changePct),
    volume: num(token.volume ?? token.volumeUsd),
    volume_window: num(token.volume ?? token.volumeUsd),
    swap_count: token.swap_count ?? token.txsTotal ?? null,
    unique_traders: token.uniqueTraders ?? null,
    source,
    discovery_source: source,
  };
}
