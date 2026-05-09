import { config } from "../config.js";
import { log } from "../logger.js";

const DEFAULT_INTERVALS = ["5_MINUTE", "15_MINUTE"];
const DEFAULT_CANDLES = 298;
const SHADOW_RSI2_MAX = 25;
const SHADOW_RSI14_MAX = 50;

function getApiBase() {
  return String(config.api.url || "https://api.agentmeridian.xyz/api").replace(/\/+$/, "");
}

function getHeaders() {
  const headers = {};
  if (config.api.publicApiKey) headers["x-api-key"] = config.api.publicApiKey;
  return headers;
}

function normalizeIntervals(intervals) {
  const list = Array.isArray(intervals) ? intervals : DEFAULT_INTERVALS;
  return list
    .map((value) => String(value || "").trim().toUpperCase())
    .filter((value) => value === "5_MINUTE" || value === "15_MINUTE");
}

function safeNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function buildSignalSummary(payload) {
  const latest = payload?.latest || {};
  const candle = latest?.candle || {};
  const rsi = safeNum(latest?.rsi?.value);
  const bollinger = latest?.bollinger || {};
  const supertrend = latest?.supertrend || {};
  return {
    close: safeNum(candle.close),
    rsi,
    lowerBand: safeNum(bollinger.lower),
    middleBand: safeNum(bollinger.middle),
    upperBand: safeNum(bollinger.upper),
    supertrendValue: safeNum(supertrend.value),
    supertrendDirection: String(supertrend.direction || "unknown"),
    supertrendBreakUp: !!latest?.states?.supertrendBreakUp,
    supertrendBreakDown: !!latest?.states?.supertrendBreakDown,
  };
}

function evaluatePreset(side, preset, payload) {
  const summary = buildSignalSummary(payload);
  const oversold = Number(config.indicators.rsiOversold ?? 30);
  const overbought = Number(config.indicators.rsiOverbought ?? 80);
  const close = summary.close;
  const lowerBand = summary.lowerBand;
  const upperBand = summary.upperBand;
  const rsi = summary.rsi;
  const isBullish = summary.supertrendDirection === "bullish";
  const isBearish = summary.supertrendDirection === "bearish";

  switch (preset) {
    case "supertrend_break":
      return side === "entry"
        ? {
            confirmed: summary.supertrendBreakUp || (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue),
            reason: summary.supertrendBreakUp ? "Supertrend flipped bullish" : "Price is above bullish Supertrend",
            signal: summary,
          }
        : {
            confirmed: summary.supertrendBreakDown || (isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue),
            reason: summary.supertrendBreakDown ? "Supertrend flipped bearish" : "Price is below bearish Supertrend",
            signal: summary,
          };
    case "rsi_reversal":
      return side === "entry"
        ? {
            confirmed: rsi != null && rsi <= oversold,
            reason: `RSI ${rsi ?? "n/a"} <= oversold ${oversold}`,
            signal: summary,
          }
        : {
            confirmed: rsi != null && rsi >= overbought,
            reason: `RSI ${rsi ?? "n/a"} >= overbought ${overbought}`,
            signal: summary,
          };
    case "bollinger_reversion":
      return side === "entry"
        ? {
            confirmed: close != null && lowerBand != null && close <= lowerBand,
            reason: `Close ${close ?? "n/a"} <= lower band ${lowerBand ?? "n/a"}`,
            signal: summary,
          }
        : {
            confirmed: close != null && upperBand != null && close >= upperBand,
            reason: `Close ${close ?? "n/a"} >= upper band ${upperBand ?? "n/a"}`,
            signal: summary,
          };
    case "rsi_plus_supertrend":
      return side === "entry"
        ? {
            confirmed:
              (rsi != null && rsi <= oversold) &&
              (summary.supertrendBreakUp || isBullish),
            reason: `RSI oversold with bullish Supertrend context`,
            signal: summary,
          }
        : {
            confirmed:
              (rsi != null && rsi >= overbought) &&
              (summary.supertrendBreakDown || isBearish),
            reason: `RSI overbought with bearish Supertrend context`,
            signal: summary,
          };
    default:
      return {
        confirmed: false,
        reason: `Unknown preset ${preset}`,
        signal: summary,
      };
  }
}

function getSignalMetric(signal, key) {
  return signal ? safeNum(signal[key]) : null;
}

function buildThresholdCheck(value, threshold, comparator = "lte") {
  const numeric = safeNum(value);
  const pass = numeric == null
    ? null
    : (comparator === "gte" ? numeric >= threshold : numeric <= threshold);
  return {
    available: numeric != null,
    pass,
    value: numeric,
    threshold,
  };
}

function buildLowerBandCheck(signal) {
  const close = getSignalMetric(signal, "close");
  const lowerBand = getSignalMetric(signal, "lowerBand");
  return {
    available: close != null && lowerBand != null,
    pass: close != null && lowerBand != null ? close <= lowerBand : null,
    close,
    lowerBand,
  };
}

function buildSupertrendBullishCheck(signal) {
  const direction = String(signal?.supertrendDirection || "unknown");
  return {
    available: direction !== "unknown",
    pass: direction !== "unknown" ? direction === "bullish" : null,
    direction,
    value: getSignalMetric(signal, "supertrendValue"),
  };
}

export function buildShadowQualityGatesFromSignals({
  rsi2SignalsByInterval = {},
  rsi14Signal15m = null,
  rsi2Source = "chart-indicators",
  rsi14Source = "chart-indicators",
  rsi14Error = null,
} = {}) {
  const signal5m = rsi2SignalsByInterval["5_MINUTE"] || null;
  const signal15m = rsi2SignalsByInterval["15_MINUTE"] || null;

  const checks = {
    bollinger_5m_lower_band: buildLowerBandCheck(signal5m),
    bollinger_15m_lower_band: buildLowerBandCheck(signal15m),
    rsi2_5m_lte_25: buildThresholdCheck(getSignalMetric(signal5m, "rsi"), SHADOW_RSI2_MAX),
    rsi2_15m_lte_25: buildThresholdCheck(getSignalMetric(signal15m, "rsi"), SHADOW_RSI2_MAX),
    rsi14_15m_lte_50: buildThresholdCheck(getSignalMetric(rsi14Signal15m, "rsi"), SHADOW_RSI14_MAX),
    supertrend_15m_bullish: buildSupertrendBullishCheck(rsi14Signal15m || signal15m),
  };

  const strictChecks = [
    checks.rsi2_5m_lte_25,
    checks.rsi2_15m_lte_25,
    checks.rsi14_15m_lte_50,
    checks.supertrend_15m_bullish,
  ];
  const strictAvailable = strictChecks.every((entry) => entry.available);
  const strictPass = strictAvailable
    ? strictChecks.every((entry) => entry.pass === true)
    : null;

  return {
    enabled: true,
    mode: "shadow",
    thresholds: {
      rsi2Max: SHADOW_RSI2_MAX,
      rsi14Max: SHADOW_RSI14_MAX,
    },
    sources: {
      rsi2: rsi2Source,
      rsi14: rsi14Source,
    },
    checks,
    strict_quality_gate: {
      available: strictAvailable,
      pass: strictPass,
      reason: strictAvailable
        ? "15m RSI14<=50 AND 15m Supertrend bullish AND 5m/15m RSI2<=25"
        : "shadow gate incomplete; missing chart data",
    },
    rsi14_error: rsi14Error ? String(rsi14Error).slice(0, 160) : null,
  };
}

async function buildShadowQualityGates({
  mint,
  side,
  refresh,
  results,
} = {}) {
  if (side !== "entry" || !mint) return null;

  const configuredRsiLength = Number(config.indicators.rsiLength ?? 2);
  const rsi2SignalsByInterval = {};
  let rsi2Source = "current-confirmation";

  if (configuredRsiLength === 2) {
    for (const result of results || []) {
      if (result?.ok && (result.interval === "5_MINUTE" || result.interval === "15_MINUTE")) {
        rsi2SignalsByInterval[result.interval] = result.signal || null;
      }
    }
  } else {
    rsi2Source = "unavailable-current-rsi-length-not-2";
  }

  let rsi14Signal15m = null;
  let rsi14Error = null;
  try {
    const payload = await fetchChartIndicatorsForMint(mint, {
      interval: "15_MINUTE",
      rsiLength: 14,
      refresh,
    });
    rsi14Signal15m = buildSignalSummary(payload);
  } catch (error) {
    rsi14Error = error.message;
    log("indicators_warn", `Shadow quality gate RSI14 fetch failed for ${mint.slice(0, 8)} 15_MINUTE: ${error.message}`);
  }

  return buildShadowQualityGatesFromSignals({
    rsi2SignalsByInterval,
    rsi14Signal15m,
    rsi2Source,
    rsi14Source: rsi14Signal15m ? "bounded-extra-15m-rsi14" : "unavailable",
    rsi14Error,
  });
}

export async function fetchChartIndicatorsForMint(
  mint,
  {
    interval,
    candles = config.indicators.candles ?? DEFAULT_CANDLES,
    rsiLength = config.indicators.rsiLength ?? 2,
    refresh = false,
  } = {},
) {
  const normalizedInterval = String(interval || "15_MINUTE").trim().toUpperCase();
  const search = new URLSearchParams({
    interval: normalizedInterval,
    candles: String(candles),
    rsiLength: String(rsiLength),
  });
  if (refresh) search.set("refresh", "1");

  const res = await fetch(`${getApiBase()}/chart-indicators/${mint}?${search.toString()}`, {
    headers: getHeaders(),
  });
  const text = await res.text().catch(() => "");
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    throw new Error(payload?.error || `chart indicators ${res.status}`);
  }
  return payload;
}

export async function confirmIndicatorPreset({
  mint,
  side,
  preset = side === "entry" ? config.indicators.entryPreset : config.indicators.exitPreset,
  intervals = config.indicators.intervals,
  refresh = false,
} = {}) {
  if (!config.indicators.enabled || !mint || !preset) {
    return { enabled: false, confirmed: true, reason: "Indicators disabled or not configured", intervals: [] };
  }

  const targets = normalizeIntervals(intervals);
  if (targets.length === 0) {
    return { enabled: false, confirmed: true, reason: "No indicator intervals configured", intervals: [] };
  }

  const results = [];
  for (const interval of targets) {
    try {
      const payload = await fetchChartIndicatorsForMint(mint, { interval, refresh });
      const evaluation = evaluatePreset(side, preset, payload);
      results.push({
        interval,
        ok: true,
        confirmed: !!evaluation.confirmed,
        reason: evaluation.reason,
        signal: evaluation.signal,
        latest: payload?.latest || null,
      });
    } catch (error) {
      log("indicators_warn", `Indicator fetch failed for ${mint.slice(0, 8)} ${interval}: ${error.message}`);
      results.push({
        interval,
        ok: false,
        confirmed: null,
        reason: error.message,
        signal: null,
        latest: null,
      });
    }
  }

  const successful = results.filter((entry) => entry.ok);
  if (successful.length === 0) {
    return {
      enabled: true,
      confirmed: true,
      skipped: true,
      preset,
      side,
      reason: "Indicator API unavailable; falling back to existing logic",
      intervals: results,
    };
  }

  const shadowQualityGates = await buildShadowQualityGates({
    mint,
    side,
    refresh,
    results,
  });

  const requireAll = !!config.indicators.requireAllIntervals;
  const confirmed = requireAll
    ? successful.every((entry) => entry.confirmed)
    : successful.some((entry) => entry.confirmed);

  return {
    enabled: true,
    confirmed,
    skipped: false,
    preset,
    side,
    requireAllIntervals: requireAll,
    reason: confirmed
      ? `${preset} confirmed on ${successful.filter((entry) => entry.confirmed).map((entry) => entry.interval).join(", ")}`
      : `${preset} not confirmed on ${successful.map((entry) => entry.interval).join(", ")}`,
    intervals: results,
    shadow_quality_gates: shadowQualityGates,
  };
}
