import { createMeteoraTxDecodeCache } from "./tx-decode-cache.js";

const DEFAULT_WINDOW_MS = 5 * 60_000;
const DEFAULT_SELL_THRESHOLD_USD = 500;

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundNumber(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : 0;
}

function resolveAmountUsd(event, telemetryContext, defaults) {
  const explicit = asNumber(event.amountUsd);
  if (explicit != null) return explicit;
  const decimals = asNumber(telemetryContext?.tokenDecimals)
    ?? asNumber(telemetryContext?.positions?.[0]?.base_decimals)
    ?? defaults.tokenDecimals;
  const tokenPriceUsd = asNumber(telemetryContext?.tokenPriceUsd)
    ?? asNumber(telemetryContext?.positions?.[0]?.base_price_usd)
    ?? defaults.tokenPriceUsd;
  const quotePriceUsd = asNumber(telemetryContext?.quotePriceUsd)
    ?? asNumber(telemetryContext?.solPriceUsd)
    ?? defaults.quotePriceUsd;
  const price = event.direction === "sell" ? tokenPriceUsd : quotePriceUsd;
  if (price == null) return 0;
  return (asNumber(event.amountRaw) || 0) / (10 ** decimals) * price;
}

function summarize(events, nowMs, sellThresholdUsd) {
  const inWindow = events.filter((event) => nowMs - event.timestampMs <= DEFAULT_WINDOW_MS);
  let buy = 0;
  let sell = 0;
  let largestSell = 0;
  let sellsOverThreshold = 0;
  for (const event of inWindow) {
    if (event.direction === "sell") {
      sell += event.amountUsd;
      largestSell = Math.max(largestSell, event.amountUsd);
      if (event.amountUsd > sellThresholdUsd) sellsOverThreshold += 1;
    } else if (event.direction === "buy") {
      buy += event.amountUsd;
    }
  }
  return {
    swap_buy_usd_5m: roundNumber(buy),
    swap_sell_usd_5m: roundNumber(sell),
    sell_buy_ratio_5m: buy > 0 ? roundNumber(sell / buy, 6) : (sell > 0 ? 999 : 0),
    largest_single_sell_usd_5m: roundNumber(largestSell),
    n_sells_over_threshold_5m: sellsOverThreshold,
    swap_slippage_p95_5m: null,
    swap_slippage_p95_5m_reason: "slippage_unavailable",
  };
}

export function createSwapPressureProvider({
  decodeCache = null,
  fetchSwapEventsFn = null,
  sellThresholdUsd = DEFAULT_SELL_THRESHOLD_USD,
  tokenDecimals = 6,
  tokenPriceUsd = null,
  quotePriceUsd = null,
  logger = () => {},
  ...cacheConfig
} = {}) {
  const cache = decodeCache || createMeteoraTxDecodeCache(cacheConfig);
  const eventsByPool = new Map();
  const defaults = { tokenDecimals, tokenPriceUsd, quotePriceUsd };

  return async function getLptele4SwapPressure(telemetryContext = {}) {
    const pool = telemetryContext.pool;
    const nowMs = asNumber(telemetryContext.observedAtMs) ?? Date.now();
    if (!pool) {
      return {
        ...summarize([], nowMs, sellThresholdUsd),
        lptele4_swap_pressure_data_source: "helius_tx_decode_error",
      };
    }
    try {
      const fresh = typeof fetchSwapEventsFn === "function"
        ? await fetchSwapEventsFn(telemetryContext)
        : await cache.fetchDecodedPoolTransactions(pool, { observedAtMs: nowMs });
      const prior = eventsByPool.get(pool) || [];
      const next = [...prior];
      for (const event of fresh || []) {
        if (event.type !== "swap") continue;
        const amountUsd = resolveAmountUsd(event, telemetryContext, defaults);
        next.push({
          ...event,
          amountUsd,
          timestampMs: asNumber(event.timestampMs) ?? nowMs,
        });
      }
      const trimmed = next.filter((event) => nowMs - event.timestampMs <= DEFAULT_WINDOW_MS);
      eventsByPool.set(pool, trimmed);
      return {
        ...summarize(trimmed, nowMs, sellThresholdUsd),
        lptele4_swap_pressure_data_source: "helius_tx_decode",
      };
    } catch (error) {
      logger("lptele_provider_warn", `LPTELE-4 swap-pressure provider failed: ${error.message}`);
      return {
        ...summarize(eventsByPool.get(pool) || [], nowMs, sellThresholdUsd),
        lptele4_swap_pressure_data_source: "helius_tx_decode_error",
      };
    }
  };
}
