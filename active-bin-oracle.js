import fs from "fs";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { log } from "./logger.js";
import { getActiveBin } from "./tools/dlmm.js";
import { deriveRangeSide } from "./oor-reposition.js";

const DEFAULT_DEBOUNCE_MS = 3_000;
const DEFAULT_LOG_DIR = "./logs";
const DEFAULT_HISTORY_RETENTION_MS = 60_000;
const DEFAULT_MAX_HISTORY_POINTS = 120;
const DEFAULT_LIVE_EMERGENCY_MAX_PNL_PCT = 2;
const RANGE_PROXIMITY_ROLLING_MS = 60_000;
const RANGE_EDGE_MIN_BINS = 2;
const RANGE_EDGE_MAX_BINS = 6;
const RANGE_EDGE_WIDTH_PCT = 0.10;

export const WHALE_ESCAPE_NULL_FIELDS = Object.freeze({
  pool_lp_net_dep_usd_5m: null,
  pool_lp_net_dep_usd_15m: null,
  pool_lp_net_dep_usd_30m: null,
  pool_lp_add_count_5m: null,
  pool_lp_remove_count_5m: null,
  pool_lp_largest_remove_usd_5m: null,
  whale_escape_data_source: null,
});

export const LPTELE2_LIQUIDITY_SHAPE_NULL_FIELDS = Object.freeze({
  quote_reserves_in_active_bin_usd: null,
  quote_reserves_within_5_bins_below_usd: null,
  token_reserves_in_active_bin_usd: null,
  adjacent_bin_liquidity_cliff_pct: null,
  your_share_of_active_bin_tvl_pct: null,
  lptele2_liquidity_shape_data_source: null,
});

export const LPTELE4_SWAP_PRESSURE_NULL_FIELDS = Object.freeze({
  swap_buy_usd_5m: null,
  swap_sell_usd_5m: null,
  sell_buy_ratio_5m: null,
  largest_single_sell_usd_5m: null,
  n_sells_over_threshold_5m: null,
  swap_slippage_p95_5m: null,
  lptele4_swap_pressure_data_source: null,
});

export const WHALE_ESCAPE_SHADOW_THRESHOLDS = Object.freeze({
  watch: {
    maxNetDepUsd15m: -2_500,
    maxBinDistanceToLower: 6,
  },
  candidate: {
    maxNetDepUsd15m: -5_000,
    maxBinDistanceToLower: 4,
    minPnlPct: -2,
  },
});

export const VELOCITY_WINDOWS = [
  { label: "10s", targetMs: 10_000, minMs: 7_000, maxMs: 20_000 },
  { label: "30s", targetMs: 30_000, minMs: 20_000, maxMs: 45_000 },
];

export const SHADOW_VELOCITY_THRESHOLDS = {
  // Conservative shadow labels only. These values are meant to surface
  // unusually fast bin movement for review, not to authorize a close.
  watch: {
    minAbs10sDelta: 12,
    minAbs30sDelta: 24,
    minAbsBinsPerSec: 1.0,
  },
  rugLikeExtreme: {
    minAbs10sDelta: 30,
    minAbs30sDelta: 60,
    minAbsBinsPerSec: 2.5,
  },
};

function asNumber(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function appendJsonl(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`);
}

function roundNumber(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function normalizeActiveBinResult(active) {
  return {
    activeBin: asNumber(active?.binId),
    activePrice: asNumber(active?.price),
    activePricePerLamport: asNumber(active?.pricePerLamport),
  };
}

function normalizeCount(value) {
  const number = asNumber(value);
  return number != null && number >= 0 ? Math.trunc(number) : null;
}

function normalizeWhaleEscapeDataSource(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function normalizeWhaleEscapeFlow(flow = {}) {
  if (!flow || typeof flow !== "object") return { ...WHALE_ESCAPE_NULL_FIELDS };
  return {
    pool_lp_net_dep_usd_5m: roundNumber(asNumber(flow.pool_lp_net_dep_usd_5m) ?? asNumber(flow.netDepUsd5m)),
    pool_lp_net_dep_usd_15m: roundNumber(asNumber(flow.pool_lp_net_dep_usd_15m) ?? asNumber(flow.netDepUsd15m)),
    pool_lp_net_dep_usd_30m: roundNumber(asNumber(flow.pool_lp_net_dep_usd_30m) ?? asNumber(flow.netDepUsd30m)),
    pool_lp_add_count_5m: normalizeCount(flow.pool_lp_add_count_5m ?? flow.addCount5m),
    pool_lp_remove_count_5m: normalizeCount(flow.pool_lp_remove_count_5m ?? flow.removeCount5m),
    pool_lp_largest_remove_usd_5m: roundNumber(asNumber(flow.pool_lp_largest_remove_usd_5m) ?? asNumber(flow.largestRemoveUsd5m)),
    whale_escape_data_source: normalizeWhaleEscapeDataSource(flow.whale_escape_data_source ?? flow.dataSource),
  };
}

export function normalizeLptele2LiquidityShape(shape = {}) {
  if (!shape || typeof shape !== "object") return { ...LPTELE2_LIQUIDITY_SHAPE_NULL_FIELDS };
  return {
    quote_reserves_in_active_bin_usd: roundNumber(
      asNumber(shape.quote_reserves_in_active_bin_usd)
        ?? asNumber(shape.quoteReservesInActiveBinUsd)
        ?? asNumber(shape.quoteReservesActiveBinUsd)
        ?? asNumber(shape.activeBinQuoteUsd),
    ),
    quote_reserves_within_5_bins_below_usd: roundNumber(
      asNumber(shape.quote_reserves_within_5_bins_below_usd)
        ?? asNumber(shape.quoteReservesWithin5BinsBelowUsd)
        ?? asNumber(shape.quoteBelow5BinsUsd),
    ),
    token_reserves_in_active_bin_usd: roundNumber(
      asNumber(shape.token_reserves_in_active_bin_usd)
        ?? asNumber(shape.tokenReservesInActiveBinUsd)
        ?? asNumber(shape.activeBinTokenUsd),
    ),
    adjacent_bin_liquidity_cliff_pct: roundNumber(
      asNumber(shape.adjacent_bin_liquidity_cliff_pct)
        ?? asNumber(shape.adjacentBinLiquidityCliffPct),
    ),
    your_share_of_active_bin_tvl_pct: roundNumber(
      asNumber(shape.your_share_of_active_bin_tvl_pct)
        ?? asNumber(shape.yourShareOfActiveBinTvlPct)
        ?? asNumber(shape.positionShareOfActiveBinTvlPct),
    ),
    lptele2_liquidity_shape_data_source: normalizeWhaleEscapeDataSource(
      shape.lptele2_liquidity_shape_data_source ?? shape.dataSource,
    ),
  };
}

export function normalizeLptele4SwapPressure(pressure = {}) {
  if (!pressure || typeof pressure !== "object") return { ...LPTELE4_SWAP_PRESSURE_NULL_FIELDS };
  return {
    swap_buy_usd_5m: roundNumber(asNumber(pressure.swap_buy_usd_5m) ?? asNumber(pressure.swapBuyUsd5m)),
    swap_sell_usd_5m: roundNumber(asNumber(pressure.swap_sell_usd_5m) ?? asNumber(pressure.swapSellUsd5m)),
    sell_buy_ratio_5m: roundNumber(asNumber(pressure.sell_buy_ratio_5m) ?? asNumber(pressure.sellBuyRatio5m)),
    largest_single_sell_usd_5m: roundNumber(
      asNumber(pressure.largest_single_sell_usd_5m) ?? asNumber(pressure.largestSingleSellUsd5m),
    ),
    n_sells_over_threshold_5m: normalizeCount(
      pressure.n_sells_over_threshold_5m ?? pressure.nSellsOverThreshold5m,
    ),
    swap_slippage_p95_5m: roundNumber(
      asNumber(pressure.swap_slippage_p95_5m) ?? asNumber(pressure.swapSlippageP95_5m),
    ),
    lptele4_swap_pressure_data_source: normalizeWhaleEscapeDataSource(
      pressure.lptele4_swap_pressure_data_source ?? pressure.dataSource,
    ),
  };
}

export function computeBinDistanceFields(position, activeBin) {
  const lowerBin = asNumber(position?.lower_bin);
  const upperBin = asNumber(position?.upper_bin);
  const active = asNumber(activeBin);
  return {
    bin_distance_to_lower: active != null && lowerBin != null ? active - lowerBin : null,
    bin_distance_to_upper: active != null && upperBin != null ? upperBin - active : null,
    range_width_bins: lowerBin != null && upperBin != null ? upperBin - lowerBin : null,
  };
}

export function classifyRangeProximityZone({
  activeBin = null,
  lowerBin = null,
  upperBin = null,
} = {}) {
  const active = asNumber(activeBin);
  const lower = asNumber(lowerBin);
  const upper = asNumber(upperBin);
  if (active == null || lower == null || upper == null || upper <= lower) return "unknown";
  if (active < lower) return "below_range";
  if (active > upper) return "above_range";
  const midpoint = lower + ((upper - lower) / 2);
  return active <= midpoint ? "lower_half" : "upper_half";
}

function computeRangeEdgeThreshold(width) {
  const rangeWidth = asNumber(width);
  if (rangeWidth == null || rangeWidth < 0) return null;
  if (rangeWidth === 0) return 0;
  return Math.min(
    RANGE_EDGE_MAX_BINS,
    Math.max(RANGE_EDGE_MIN_BINS, Math.ceil(rangeWidth * RANGE_EDGE_WIDTH_PCT)),
  );
}

function classifyRangeEdgeZone({
  activeBin = null,
  lowerBin = null,
  upperBin = null,
  edgeThresholdBins = null,
} = {}) {
  const active = asNumber(activeBin);
  const lower = asNumber(lowerBin);
  const upper = asNumber(upperBin);
  const threshold = asNumber(edgeThresholdBins);
  if (active == null || lower == null || upper == null || threshold == null) return null;
  if (active < lower || active > upper) return null;
  const distanceToLower = active - lower;
  const distanceToUpper = upper - active;
  if (distanceToLower > threshold && distanceToUpper > threshold) return null;
  return distanceToLower <= distanceToUpper ? "near_lower_edge" : "near_upper_edge";
}

function buildRangeProximitySamples(previousState, currentSample, observedAtMs) {
  const observed = asNumber(observedAtMs);
  const windowStart = observed != null ? observed - RANGE_PROXIMITY_ROLLING_MS : null;
  const previousSamples = Array.isArray(previousState?.samples) ? previousState.samples : [];
  const fallbackObservedAtMs = asNumber(previousState?.observedAtMs) ?? asNumber(previousState?.zoneSinceMs);
  const fallbackPrevious = previousSamples.length || fallbackObservedAtMs == null
    ? []
    : [{
        observedAtMs: fallbackObservedAtMs,
        zone: typeof previousState.zone === "string" ? previousState.zone : null,
        edgeZone: typeof previousState.edgeZone === "string" ? previousState.edgeZone : null,
      }];
  return [
    ...fallbackPrevious,
    ...previousSamples,
    currentSample,
  ]
    .filter((sample) => (
      asNumber(sample?.observedAtMs) != null &&
      (windowStart == null || sample.observedAtMs >= windowStart)
    ))
    .sort((a, b) => a.observedAtMs - b.observedAtMs);
}

function computeRollingRangeSeconds(samples, observedAtMs) {
  const observed = asNumber(observedAtMs);
  const totals = {
    rolling_lower_half_sec_60s: null,
    rolling_upper_half_sec_60s: null,
    rolling_near_edge_sec_60s: null,
    rolling_near_lower_edge_sec_60s: null,
    rolling_near_upper_edge_sec_60s: null,
  };
  if (observed == null || !Array.isArray(samples) || !samples.length) return totals;
  totals.rolling_lower_half_sec_60s = 0;
  totals.rolling_upper_half_sec_60s = 0;
  totals.rolling_near_edge_sec_60s = 0;
  totals.rolling_near_lower_edge_sec_60s = 0;
  totals.rolling_near_upper_edge_sec_60s = 0;
  const windowStart = observed - RANGE_PROXIMITY_ROLLING_MS;
  for (let index = 1; index < samples.length; index += 1) {
    const previousObserved = asNumber(samples[index - 1]?.observedAtMs);
    const currentObserved = asNumber(samples[index]?.observedAtMs);
    if (previousObserved == null || currentObserved == null) continue;
    const elapsedSec = Math.max(0, (currentObserved - Math.max(previousObserved, windowStart)) / 1000);
    if (!Number.isFinite(elapsedSec) || elapsedSec <= 0) continue;
    const zone = samples[index - 1].zone;
    const edgeZone = samples[index - 1].edgeZone;
    if (zone === "lower_half") totals.rolling_lower_half_sec_60s += elapsedSec;
    if (zone === "upper_half") totals.rolling_upper_half_sec_60s += elapsedSec;
    if (edgeZone) totals.rolling_near_edge_sec_60s += elapsedSec;
    if (edgeZone === "near_lower_edge") totals.rolling_near_lower_edge_sec_60s += elapsedSec;
    if (edgeZone === "near_upper_edge") totals.rolling_near_upper_edge_sec_60s += elapsedSec;
  }
  return {
    rolling_lower_half_sec_60s: roundNumber(totals.rolling_lower_half_sec_60s, 3),
    rolling_upper_half_sec_60s: roundNumber(totals.rolling_upper_half_sec_60s, 3),
    rolling_near_edge_sec_60s: roundNumber(totals.rolling_near_edge_sec_60s, 3),
    rolling_near_lower_edge_sec_60s: roundNumber(totals.rolling_near_lower_edge_sec_60s, 3),
    rolling_near_upper_edge_sec_60s: roundNumber(totals.rolling_near_upper_edge_sec_60s, 3),
  };
}

export function computeRangeProximityFields(position, activeBin, observedAtMs = null, previousState = null) {
  const lowerBin = asNumber(position?.lower_bin);
  const upperBin = asNumber(position?.upper_bin);
  const active = asNumber(activeBin);
  const width = lowerBin != null && upperBin != null ? upperBin - lowerBin : null;
  const validWidth = width != null && width > 0;
  const distanceToLower = active != null && lowerBin != null ? active - lowerBin : null;
  const distanceToUpper = active != null && upperBin != null ? upperBin - active : null;
  const positionPct = validWidth && distanceToLower != null ? (distanceToLower / width) * 100 : null;
  const zone = classifyRangeProximityZone({ activeBin: active, lowerBin, upperBin });
  const edgeThresholdBins = computeRangeEdgeThreshold(width);
  const edgeZone = classifyRangeEdgeZone({
    activeBin: active,
    lowerBin,
    upperBin,
    edgeThresholdBins,
  });
  const previousZone = typeof previousState?.zone === "string" ? previousState.zone : null;
  const previousSinceMs = asNumber(previousState?.zoneSinceMs);
  const observed = asNumber(observedAtMs);
  const zoneSinceMs = observed != null && zone !== "unknown" && zone === previousZone && previousSinceMs != null
    ? previousSinceMs
    : observed;
  const timeInZoneMinutes = observed != null && zoneSinceMs != null && zone !== "unknown"
    ? Math.max(0, (observed - zoneSinceMs) / 60_000)
    : null;
  const samples = buildRangeProximitySamples(previousState, {
    observedAtMs: observed,
    zone,
    edgeZone,
  }, observed);
  const rollingFields = zone !== "unknown"
    ? computeRollingRangeSeconds(samples, observed)
    : computeRollingRangeSeconds([], null);

  return {
    bin_distance_to_lower: distanceToLower,
    bin_distance_to_upper: distanceToUpper,
    range_width_bins: width,
    bin_distance_to_lower_pct_of_range: validWidth && distanceToLower != null ? roundNumber((distanceToLower / width) * 100, 3) : null,
    bin_distance_to_upper_pct_of_range: validWidth && distanceToUpper != null ? roundNumber((distanceToUpper / width) * 100, 3) : null,
    range_position_pct: positionPct != null ? roundNumber(positionPct, 3) : null,
    range_proximity_zone: zone,
    previous_range_proximity_zone: previousZone,
    range_edge_zone: edgeZone,
    range_edge_threshold_bins: edgeThresholdBins,
    ...rollingFields,
    time_in_current_range_zone_minutes: timeInZoneMinutes != null ? roundNumber(timeInZoneMinutes, 3) : null,
    range_zone_since_ms: zoneSinceMs,
    range_proximity_samples: samples,
  };
}

export function classifyWhaleEscapeShadow({
  flow = {},
  binDistanceToLower = null,
  pnlPct = null,
  thresholds = WHALE_ESCAPE_SHADOW_THRESHOLDS,
} = {}) {
  const netDep15m = asNumber(flow.pool_lp_net_dep_usd_15m);
  const distanceToLower = asNumber(binDistanceToLower);
  const pnl = asNumber(pnlPct);
  if (netDep15m == null || distanceToLower == null) {
    return {
      whale_escape_shadow_signal: null,
      whale_escape_shadow_reason: null,
    };
  }

  const candidate = (
    netDep15m <= thresholds.candidate.maxNetDepUsd15m &&
    distanceToLower <= thresholds.candidate.maxBinDistanceToLower &&
    pnl != null &&
    pnl > thresholds.candidate.minPnlPct
  );
  if (candidate) {
    return {
      whale_escape_shadow_signal: "candidate",
      whale_escape_shadow_reason: `shadow_only_whale_escape_candidate net_dep_15m=${roundNumber(netDep15m, 2)} bin_distance_to_lower=${distanceToLower} pnl_pct=${roundNumber(pnl, 2)}`,
    };
  }

  const watch = (
    netDep15m <= thresholds.watch.maxNetDepUsd15m &&
    distanceToLower <= thresholds.watch.maxBinDistanceToLower
  );
  if (watch) {
    return {
      whale_escape_shadow_signal: "watch",
      whale_escape_shadow_reason: `shadow_only_whale_escape_watch net_dep_15m=${roundNumber(netDep15m, 2)} bin_distance_to_lower=${distanceToLower}`,
    };
  }

  return {
    whale_escape_shadow_signal: null,
    whale_escape_shadow_reason: null,
  };
}

function trimHistory(history, observedAtMs, retentionMs, maxPoints) {
  const minObservedAtMs = observedAtMs - retentionMs;
  const trimmed = (Array.isArray(history) ? history : [])
    .filter((point) => point?.observedAtMs >= minObservedAtMs && point?.activeBin != null)
    .slice(-maxPoints);
  return trimmed;
}

function findWindowBaseline(history, observedAtMs, window) {
  let best = null;
  let bestDistance = Infinity;
  for (const point of Array.isArray(history) ? history : []) {
    const elapsedMs = observedAtMs - point.observedAtMs;
    if (elapsedMs < window.minMs || elapsedMs > window.maxMs) continue;
    const distance = Math.abs(elapsedMs - window.targetMs);
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

export function computeVelocityWindows(activeBin, observedAtMs, history = [], windows = VELOCITY_WINDOWS) {
  const active = asNumber(activeBin);
  const features = {};
  for (const window of windows) {
    const baseline = active != null ? findWindowBaseline(history, observedAtMs, window) : null;
    const prefix = `velocity_${window.label}_`;
    const elapsedSec = baseline ? (observedAtMs - baseline.observedAtMs) / 1000 : null;
    const delta = active != null && baseline ? active - baseline.activeBin : null;
    const binsPerSec = delta != null && elapsedSec > 0 ? delta / elapsedSec : null;
    features[`${prefix}bin_delta`] = delta;
    features[`${prefix}elapsed_sec`] = elapsedSec != null ? roundNumber(elapsedSec, 3) : null;
    features[`${prefix}bins_per_sec`] = binsPerSec != null ? roundNumber(binsPerSec) : null;
  }
  return features;
}

export function computePriceWindows(activePrice, observedAtMs, history = [], windows = VELOCITY_WINDOWS) {
  const active = asNumber(activePrice);
  const features = {};
  for (const window of windows) {
    const baseline = active != null
      ? findWindowBaseline(
          (Array.isArray(history) ? history : []).filter((point) => asNumber(point?.activePrice) != null),
          observedAtMs,
          window,
        )
      : null;
    const suffix = window.label;
    const elapsedSec = baseline ? (observedAtMs - baseline.observedAtMs) / 1000 : null;
    const baselinePrice = asNumber(baseline?.activePrice);
    const deltaPct = active != null && baselinePrice != null && baselinePrice !== 0
      ? ((active - baselinePrice) / baselinePrice) * 100
      : null;
    const pctPerSec = deltaPct != null && elapsedSec > 0 ? deltaPct / elapsedSec : null;
    features[`price_delta_pct_${suffix}`] = deltaPct != null ? roundNumber(deltaPct) : null;
    features[`price_elapsed_sec_${suffix}`] = elapsedSec != null ? roundNumber(elapsedSec, 3) : null;
    features[`price_rate_pct_per_sec_${suffix}`] = pctPerSec != null ? roundNumber(pctPerSec) : null;
  }
  return features;
}

export function classifyShadowVelocity(velocityFeatures = {}, thresholds = SHADOW_VELOCITY_THRESHOLDS) {
  const v10Delta = asNumber(velocityFeatures.velocity_10s_bin_delta);
  const v30Delta = asNumber(velocityFeatures.velocity_30s_bin_delta);
  const v10Rate = asNumber(velocityFeatures.velocity_10s_bins_per_sec);
  const v30Rate = asNumber(velocityFeatures.velocity_30s_bins_per_sec);
  const abs10Delta = v10Delta != null ? Math.abs(v10Delta) : null;
  const abs30Delta = v30Delta != null ? Math.abs(v30Delta) : null;
  const absMaxRate = Math.max(
    v10Rate != null ? Math.abs(v10Rate) : 0,
    v30Rate != null ? Math.abs(v30Rate) : 0,
  );

  const reasons = [];
  const extreme = (
    (abs10Delta != null && abs10Delta >= thresholds.rugLikeExtreme.minAbs10sDelta) ||
    (abs30Delta != null && abs30Delta >= thresholds.rugLikeExtreme.minAbs30sDelta) ||
    absMaxRate >= thresholds.rugLikeExtreme.minAbsBinsPerSec
  );
  if (extreme) {
    if (abs10Delta != null && abs10Delta >= thresholds.rugLikeExtreme.minAbs10sDelta) {
      reasons.push(`abs_10s_delta=${abs10Delta}`);
    }
    if (abs30Delta != null && abs30Delta >= thresholds.rugLikeExtreme.minAbs30sDelta) {
      reasons.push(`abs_30s_delta=${abs30Delta}`);
    }
    if (absMaxRate >= thresholds.rugLikeExtreme.minAbsBinsPerSec) {
      reasons.push(`max_rate=${roundNumber(absMaxRate)}_bins_per_sec`);
    }
    return {
      shadow_velocity_signal: "rug_like_extreme",
      shadow_velocity_reason: `shadow_only_velocity_candidate ${reasons.join(" ")}`,
    };
  }

  const watch = (
    (abs10Delta != null && abs10Delta >= thresholds.watch.minAbs10sDelta) ||
    (abs30Delta != null && abs30Delta >= thresholds.watch.minAbs30sDelta) ||
    absMaxRate >= thresholds.watch.minAbsBinsPerSec
  );
  if (watch) {
    if (abs10Delta != null && abs10Delta >= thresholds.watch.minAbs10sDelta) {
      reasons.push(`abs_10s_delta=${abs10Delta}`);
    }
    if (abs30Delta != null && abs30Delta >= thresholds.watch.minAbs30sDelta) {
      reasons.push(`abs_30s_delta=${abs30Delta}`);
    }
    if (absMaxRate >= thresholds.watch.minAbsBinsPerSec) {
      reasons.push(`max_rate=${roundNumber(absMaxRate)}_bins_per_sec`);
    }
    return {
      shadow_velocity_signal: "watch",
      shadow_velocity_reason: `shadow_only_velocity_watch ${reasons.join(" ")}`,
    };
  }

  return {
    shadow_velocity_signal: null,
    shadow_velocity_reason: null,
  };
}

export function shouldTriggerActiveBinEmergencyExit(row, {
  enabled = true,
  maxPnlPct = DEFAULT_LIVE_EMERGENCY_MAX_PNL_PCT,
  signal = "rug_like_extreme",
} = {}) {
  if (!enabled) return false;
  if (!row || row.shadow_velocity_signal !== signal) return false;
  const pnlPct = asNumber(row.pnl_pct);
  if (pnlPct == null) return false;
  return pnlPct <= maxPnlPct;
}

export function classifyActiveBin(position, activeBin, priorActiveBin, previousObservedAtMs, observedAtMs, velocityFeatures = {}, priceFeatures = {}) {
  const lowerBin = asNumber(position?.lower_bin);
  const upperBin = asNumber(position?.upper_bin);
  const active = asNumber(activeBin);
  const prior = asNumber(priorActiveBin);
  const pnlPct = asNumber(position?.pnl_pct);
  const inRange = active != null && lowerBin != null && upperBin != null
    ? active >= lowerBin && active <= upperBin
    : null;
  const binDelta = active != null && prior != null ? active - prior : null;
  const elapsedSec = previousObservedAtMs != null && observedAtMs != null
    ? Math.max(0, (observedAtMs - previousObservedAtMs) / 1000)
    : null;
  const binVelocity = binDelta != null && elapsedSec > 0 ? binDelta / elapsedSec : null;
  const adverseOorGuess = inRange === false && (pnlPct == null || pnlPct <= 0);
  const rangeSide = deriveRangeSide({ active_bin: active, lower_bin: lowerBin, upper_bin: upperBin });
  const velocitySignal = classifyShadowVelocity(velocityFeatures);
  const wouldCloseReason = adverseOorGuess
    ? [
        `shadow_only_active_bin_${rangeSide}`,
        binDelta != null ? `delta=${binDelta}` : null,
        binVelocity != null ? `velocity=${Number(binVelocity.toFixed(4))}_bins_per_sec` : null,
        pnlPct != null ? `api_pnl_pct=${pnlPct}` : null,
      ].filter(Boolean).join(" ")
    : null;

  return {
    lower_bin: lowerBin,
    upper_bin: upperBin,
    active_bin: active,
    prior_active_bin: prior,
    bin_delta: binDelta,
    bin_velocity: roundNumber(binVelocity),
    in_range: inRange,
    range_side: rangeSide,
    adverse_oor_guess: adverseOorGuess,
    ...velocityFeatures,
    ...priceFeatures,
    ...velocitySignal,
    would_close_reason: wouldCloseReason,
  };
}

export class ActiveBinOracleRecorder {
  constructor({
    connection = null,
    rpcUrl = process.env.RPC_URL,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    logDir = DEFAULT_LOG_DIR,
    historyRetentionMs = DEFAULT_HISTORY_RETENTION_MS,
    maxHistoryPoints = DEFAULT_MAX_HISTORY_POINTS,
    getActiveBinFn = getActiveBin,
    logger = log,
    now = () => new Date(),
    emergencyExitHandler = null,
    liveEmergencyExitEnabled = false,
    liveEmergencyExitMaxPnlPct = DEFAULT_LIVE_EMERGENCY_MAX_PNL_PCT,
    getPoolLiquidityFlowFn = null,
    getLptele2LiquidityShapeFn = null,
    getLptele4SwapPressureFn = null,
  } = {}) {
    this.connection = connection;
    this.rpcUrl = rpcUrl;
    this.debounceMs = debounceMs;
    this.logDir = logDir;
    this.historyRetentionMs = historyRetentionMs;
    this.maxHistoryPoints = maxHistoryPoints;
    this.getActiveBinFn = getActiveBinFn;
    this.logger = logger;
    this.now = now;
    this.emergencyExitHandler = emergencyExitHandler;
    this.liveEmergencyExitEnabled = liveEmergencyExitEnabled;
    this.liveEmergencyExitMaxPnlPct = liveEmergencyExitMaxPnlPct;
    this.getPoolLiquidityFlowFn = typeof getPoolLiquidityFlowFn === "function" ? getPoolLiquidityFlowFn : null;
    this.getLptele2LiquidityShapeFn = typeof getLptele2LiquidityShapeFn === "function" ? getLptele2LiquidityShapeFn : null;
    this.getLptele4SwapPressureFn = typeof getLptele4SwapPressureFn === "function" ? getLptele4SwapPressureFn : null;
    this.positionsByPool = new Map();
    this.subscriptions = new Map();
    this.pendingSubscriptions = new Set();
    this.timers = new Map();
    this.poolState = new Map();
    this.positionProximityState = new Map();
    this.disabledReason = null;
  }

  getLogFile(now = this.now()) {
    return path.join(this.logDir, `active-bin-oracle-${todayIso(now)}.jsonl`);
  }

  setEmergencyExitHandler(handler, {
    enabled = true,
    maxPnlPct = DEFAULT_LIVE_EMERGENCY_MAX_PNL_PCT,
  } = {}) {
    this.emergencyExitHandler = typeof handler === "function" ? handler : null;
    this.liveEmergencyExitEnabled = Boolean(enabled && this.emergencyExitHandler);
    this.liveEmergencyExitMaxPnlPct = maxPnlPct;
  }

  ensureConnection() {
    if (this.connection) return this.connection;
    if (!this.rpcUrl) {
      this.disabledReason = "RPC_URL not set";
      return null;
    }
    this.connection = new Connection(this.rpcUrl, "confirmed");
    return this.connection;
  }

  updatePositions(positions) {
    const nextByPool = new Map();
    const activePositionIds = new Set();
    for (const position of Array.isArray(positions) ? positions : []) {
      if (!position?.pool || !position?.position) continue;
      activePositionIds.add(position.position);
      if (position.lower_bin == null || position.upper_bin == null) continue;
      if (!nextByPool.has(position.pool)) nextByPool.set(position.pool, []);
      nextByPool.get(position.pool).push(position);

      const activeBin = asNumber(position.active_bin);
      if (activeBin != null) {
        const state = this.poolState.get(position.pool) || {};
        if (state.lastActiveBin == null) {
          const nowMs = this.now().getTime();
          this.poolState.set(position.pool, {
            ...state,
            lastActiveBin: activeBin,
            lastObservedAtMs: nowMs,
            history: trimHistory(
              [...(state.history || []), { activeBin, observedAtMs: nowMs }],
              nowMs,
              this.historyRetentionMs,
              this.maxHistoryPoints,
            ),
          });
        }
      }
    }

    this.positionsByPool = nextByPool;
    for (const positionId of this.positionProximityState.keys()) {
      if (!activePositionIds.has(positionId)) this.positionProximityState.delete(positionId);
    }

    for (const pool of nextByPool.keys()) {
      this.subscribePool(pool).catch((error) => {
        this.logger("active_bin_oracle_warn", `Subscribe failed for ${pool.slice(0, 8)}: ${error.message}`);
      });
    }

    for (const pool of this.subscriptions.keys()) {
      if (!nextByPool.has(pool)) {
        this.unsubscribePool(pool).catch((error) => {
          this.logger("active_bin_oracle_warn", `Unsubscribe failed for ${pool.slice(0, 8)}: ${error.message}`);
        });
      }
    }
  }

  async subscribePool(pool) {
    if (this.subscriptions.has(pool) || this.pendingSubscriptions.has(pool)) return;
    this.pendingSubscriptions.add(pool);
    const connection = this.ensureConnection();
    if (!connection) {
      this.pendingSubscriptions.delete(pool);
      this.logger("active_bin_oracle_warn", `Shadow recorder disabled: ${this.disabledReason}`);
      return;
    }
    try {
      const id = await connection.onAccountChange(
        new PublicKey(pool),
        () => this.queueSample(pool),
        "confirmed",
      );
      this.subscriptions.set(pool, id);
      this.logger("active_bin_oracle", `Subscribed shadow active-bin recorder for pool ${pool.slice(0, 8)}`);
    } finally {
      this.pendingSubscriptions.delete(pool);
    }
  }

  async unsubscribePool(pool) {
    const id = this.subscriptions.get(pool);
    if (id == null) return;
    clearTimeout(this.timers.get(pool));
    this.timers.delete(pool);
    this.pendingSubscriptions.delete(pool);
    this.subscriptions.delete(pool);
    this.positionsByPool.delete(pool);
    if (this.connection?.removeAccountChangeListener) {
      await this.connection.removeAccountChangeListener(id).catch(() => {});
    }
    this.logger("active_bin_oracle", `Unsubscribed shadow active-bin recorder for pool ${pool.slice(0, 8)}`);
  }

  queueSample(pool) {
    clearTimeout(this.timers.get(pool));
    const timer = setTimeout(() => {
      this.timers.delete(pool);
      this.recordPoolSample(pool).catch((error) => {
        this.logger("active_bin_oracle_warn", `Sample failed for ${pool.slice(0, 8)}: ${error.message}`);
      });
    }, this.debounceMs);
    this.timers.set(pool, timer);
  }

  async recordPoolSample(pool) {
    const positions = this.positionsByPool.get(pool) || [];
    if (!positions.length) return [];

    const observedAt = this.now();
    const observedAtMs = observedAt.getTime();
    const previous = this.poolState.get(pool) || {};
    const active = await this.getActiveBinFn({ pool_address: pool });
    const {
      activeBin,
      activePrice,
      activePricePerLamport,
    } = normalizeActiveBinResult(active);
    const history = trimHistory(previous.history || [], observedAtMs, this.historyRetentionMs, this.maxHistoryPoints);
    const velocityFeatures = computeVelocityWindows(activeBin, observedAtMs, history);
    const priceFeatures = computePriceWindows(activePrice, observedAtMs, history);
    const telemetryContext = {
      pool,
      activeBin,
      activePrice,
      activePricePerLamport,
      observedAt,
      observedAtMs,
      positions,
      history,
    };
    let whaleEscapeFlow = { ...WHALE_ESCAPE_NULL_FIELDS };
    if (this.getPoolLiquidityFlowFn) {
      try {
        whaleEscapeFlow = normalizeWhaleEscapeFlow(await this.getPoolLiquidityFlowFn(telemetryContext));
      } catch (error) {
        this.logger("active_bin_oracle_warn", `Whale Escape flow unavailable for ${pool.slice(0, 8)}: ${error.message}`);
      }
    }
    let lptele2LiquidityShape = { ...LPTELE2_LIQUIDITY_SHAPE_NULL_FIELDS };
    if (this.getLptele2LiquidityShapeFn) {
      try {
        lptele2LiquidityShape = normalizeLptele2LiquidityShape(await this.getLptele2LiquidityShapeFn(telemetryContext));
      } catch (error) {
        this.logger("active_bin_oracle_warn", `LPTELE-2 liquidity shape unavailable for ${pool.slice(0, 8)}: ${error.message}`);
      }
    }
    let lptele4SwapPressure = { ...LPTELE4_SWAP_PRESSURE_NULL_FIELDS };
    if (this.getLptele4SwapPressureFn) {
      try {
        lptele4SwapPressure = normalizeLptele4SwapPressure(await this.getLptele4SwapPressureFn(telemetryContext));
      } catch (error) {
        this.logger("active_bin_oracle_warn", `LPTELE-4 swap pressure unavailable for ${pool.slice(0, 8)}: ${error.message}`);
      }
    }
    const rows = positions.map((position) => {
      const classification = classifyActiveBin(
        position,
        activeBin,
        previous.lastActiveBin,
        previous.lastObservedAtMs,
        observedAtMs,
        velocityFeatures,
        priceFeatures,
      );
      const positionKey = position.position;
      const rangeProximityFields = computeRangeProximityFields(
        position,
        activeBin,
        observedAtMs,
        this.positionProximityState.get(positionKey),
      );
      const whaleEscapeSignal = classifyWhaleEscapeShadow({
        flow: whaleEscapeFlow,
        binDistanceToLower: rangeProximityFields.bin_distance_to_lower,
        pnlPct: position.pnl_pct,
      });
      this.positionProximityState.set(positionKey, {
        zone: rangeProximityFields.range_proximity_zone,
        edgeZone: rangeProximityFields.range_edge_zone,
        zoneSinceMs: rangeProximityFields.range_zone_since_ms,
        observedAtMs,
        samples: rangeProximityFields.range_proximity_samples,
      });
      const {
        range_zone_since_ms: _rangeZoneSinceMs,
        range_proximity_samples: _rangeProximitySamples,
        ...rangeProximityLogFields
      } = rangeProximityFields;
      return {
        timestamp: observedAt.toISOString(),
        pool,
        position: position.position,
        pair: position.pair || null,
        active_price: activePrice,
        active_price_per_lamport: activePricePerLamport,
        ...classification,
        ...whaleEscapeFlow,
        ...lptele2LiquidityShape,
        ...lptele4SwapPressure,
        ...rangeProximityLogFields,
        ...whaleEscapeSignal,
        pnl_pct: position.pnl_pct ?? null,
        pnl_usd: position.pnl_usd ?? null,
        pnl_pct_derived: position.pnl_pct_derived ?? null,
        source: "shadow_active_bin_oracle",
      };
    });

    for (const row of rows) appendJsonl(this.getLogFile(observedAt), row);
    if (this.emergencyExitHandler) {
      for (const row of rows) {
        if (!shouldTriggerActiveBinEmergencyExit(row, {
          enabled: this.liveEmergencyExitEnabled,
          maxPnlPct: this.liveEmergencyExitMaxPnlPct,
        })) continue;
        await this.emergencyExitHandler(row).catch((error) => {
          this.logger("active_bin_oracle_warn", `Emergency exit handler failed for ${row.position?.slice(0, 8) || "position"}: ${error.message}`);
        });
      }
    }
    this.poolState.set(pool, {
      lastActiveBin: activeBin,
      lastObservedAtMs: observedAtMs,
      history: trimHistory(
        [...history, { activeBin, activePrice, activePricePerLamport, observedAtMs }],
        observedAtMs,
        this.historyRetentionMs,
        this.maxHistoryPoints,
      ),
    });
    return rows;
  }

  async stop() {
    const pools = [...this.subscriptions.keys()];
    await Promise.all(pools.map((pool) => this.unsubscribePool(pool)));
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

export const activeBinOracleRecorder = new ActiveBinOracleRecorder();
