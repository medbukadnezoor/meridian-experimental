/**
 * Strategy Library — persistent store of LP strategies.
 *
 * Users paste a tweet or description via Telegram.
 * The agent extracts structured criteria and saves it here.
 * During screening, the active strategy's criteria guide token selection and position config.
 */

import fs from "fs";
import { log } from "./logger.js";

const STRATEGY_FILE = "./strategy-library.json";

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteNumberArray(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;
  return value
    .map((entry) => finiteNumber(entry))
    .filter((entry) => entry != null);
}

function roundNumber(value, decimals = 4) {
  const number = finiteNumber(value);
  if (number == null) return null;
  const scale = 10 ** decimals;
  return Math.round(number * scale) / scale;
}

function timeframeToMinutes(timeframe) {
  const normalized = String(timeframe || "").trim().toLowerCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)(m|h|d)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (match[2] === "m") return amount;
  if (match[2] === "h") return amount * 60;
  if (match[2] === "d") return amount * 1440;
  return null;
}

function numberFromCandidate(candidate = {}, keys = []) {
  for (const key of keys) {
    const value = key.split(".").reduce((current, part) => current?.[part], candidate);
    const number = finiteNumber(value);
    if (number != null) return number;
  }
  return null;
}

export function computeVolumeActiveTvlMultiple(candidate = {}) {
  const volume = numberFromCandidate(candidate, ["volume_window", "volume"]);
  const activeTvl = numberFromCandidate(candidate, ["active_tvl", "tvl"]);
  if (volume == null || activeTvl == null || activeTvl <= 0) return null;
  return roundNumber(volume / activeTvl, 4);
}

export function estimateFeeVelocityUsdPerMin(candidate = {}, screeningConfig = {}) {
  const feeWindow = numberFromCandidate(candidate, ["fee_window", "fee", "fee_usd"]);
  const minutes = timeframeToMinutes(screeningConfig.timeframe);
  if (feeWindow == null || minutes == null || minutes <= 0) return null;
  return roundNumber(feeWindow / minutes, 4);
}

export function computeDownsideBinsForPct(targetDownsidePct, binStep) {
  const downsidePct = finiteNumber(targetDownsidePct);
  const step = finiteNumber(binStep);
  if (downsidePct == null || step == null || downsidePct <= 0 || downsidePct >= 100 || step <= 0) return null;
  const priceRatio = 1 - downsidePct / 100;
  const binRatio = 1 + step / 10_000;
  return Math.max(1, Math.ceil(Math.abs(Math.log(priceRatio) / Math.log(binRatio))));
}

function load() {
  if (!fs.existsSync(STRATEGY_FILE)) return { active: null, strategies: {} };
  try {
    return JSON.parse(fs.readFileSync(STRATEGY_FILE, "utf8"));
  } catch {
    return { active: null, strategies: {} };
  }
}

function save(data) {
  fs.writeFileSync(STRATEGY_FILE, JSON.stringify(data, null, 2));
}

// ─── Tool Handlers ─────────────────────────────────────────────

/**
 * Add or update a strategy.
 * The agent parses the raw tweet/text and fills in the structured fields.
 */
export function addStrategy({
  id,
  name,
  author = "unknown",
  lp_strategy = "bid_ask",       // "bid_ask" | "spot" | "curve"
  token_criteria = {},           // { min_mcap, min_age_days, requires_kol, notes }
  entry = {},                    // { condition, price_change_threshold_pct, single_side }
  range = {},                    // { type, bins_below_pct, notes }
  exit = {},                     // { take_profit_pct, notes }
  best_for = "",                 // short description of ideal conditions
  raw = "",                      // original tweet/text
}) {
  if (!id || !name) return { error: "id and name are required" };

  const db = load();

  // Slugify id
  const slug = id.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");

  db.strategies[slug] = {
    id: slug,
    name,
    author,
    lp_strategy,
    token_criteria,
    entry,
    range,
    exit,
    best_for,
    raw,
    added_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Auto-set as active if it's the first strategy
  if (!db.active) db.active = slug;

  save(db);
  log("strategy", `Strategy saved: ${name} (${slug})`);
  return { saved: true, id: slug, name, active: db.active === slug };
}

/**
 * List all strategies with a summary.
 */
export function listStrategies() {
  const db = load();
  const strategies = Object.values(db.strategies).map((s) => ({
    id: s.id,
    name: s.name,
    author: s.author,
    lp_strategy: s.lp_strategy,
    best_for: s.best_for,
    active: db.active === s.id,
    added_at: s.added_at?.slice(0, 10),
  }));
  return { active: db.active, count: strategies.length, strategies };
}

/**
 * Get full details of a strategy including raw text and all criteria.
 */
export function getStrategy({ id }) {
  if (!id) return { error: "id required" };
  const db = load();
  const strategy = db.strategies[id];
  if (!strategy) return { error: `Strategy "${id}" not found`, available: Object.keys(db.strategies) };
  return { ...strategy, is_active: db.active === id };
}

/**
 * Set the active strategy used during screening cycles.
 */
export function setActiveStrategy({ id }) {
  if (!id) return { error: "id required" };
  const db = load();
  if (!db.strategies[id]) return { error: `Strategy "${id}" not found`, available: Object.keys(db.strategies) };
  db.active = id;
  save(db);
  log("strategy", `Active strategy set to: ${db.strategies[id].name}`);
  return { active: id, name: db.strategies[id].name };
}

/**
 * Remove a strategy.
 */
export function removeStrategy({ id }) {
  if (!id) return { error: "id required" };
  const db = load();
  if (!db.strategies[id]) return { error: `Strategy "${id}" not found` };
  const name = db.strategies[id].name;
  delete db.strategies[id];
  if (db.active === id) db.active = Object.keys(db.strategies)[0] || null;
  save(db);
  log("strategy", `Strategy removed: ${name}`);
  return { removed: true, id, name, new_active: db.active };
}

/**
 * Get the currently active strategy — used by screening cycle.
 */
export function getActiveStrategy() {
  const db = load();
  if (!db.active || !db.strategies[db.active]) return null;
  return db.strategies[db.active];
}

export function resolveStrategyRangePolicy(strategy = null, runtimeConfig = {}) {
  const range = strategy?.range ?? {};
  // Compute targetDownsidePct first — if set, it takes precedence over fixed bins
  const targetDownsidePct = finiteNumber(range.target_downside_pct) ?? finiteNumber(runtimeConfig?.strategy?.targetDownsidePct);
  const targetDownsideMinPct = finiteNumber(range.target_downside_min_pct) ?? finiteNumber(runtimeConfig?.strategy?.targetDownsideMinPct);
  const targetDownsideMaxPct = finiteNumber(range.target_downside_max_pct) ?? finiteNumber(runtimeConfig?.strategy?.targetDownsideMaxPct);
  // When targetDownsidePct is set and range has no explicit bins_below, do NOT fall through to config default.
  // The bins will be computed per-pool from bin_step at deploy time.
  const binsBelowDefault = finiteNumber(range.bins_below) ?? (targetDownsidePct != null ? null : finiteNumber(runtimeConfig?.strategy?.binsBelow));
  const binsBelowMin = finiteNumber(range.bins_below_min) ?? null;
  const binsBelowMax = finiteNumber(range.bins_below_max) ?? null;
  const binsAbove = finiteNumber(range.bins_above);
  const lpStrategy = strategy?.lp_strategy || runtimeConfig?.strategy?.strategy || "bid_ask";
  const singleSide = String(strategy?.entry?.single_side || range.single_side || "").toLowerCase();
  const singleSidedSol = singleSide === "sol" || range.single_sided_sol === true;

  return {
    strategyId: strategy?.id ?? null,
    strategyName: strategy?.name ?? null,
    lpStrategy,
    singleSidedSol,
    binsBelowDefault,
    binsBelowMin,
    binsBelowMax,
    binsAbove: binsAbove ?? null,
    targetDownsidePct,
    targetDownsideMinPct,
    targetDownsideMaxPct,
    hasExplicitRangePolicy: binsBelowDefault != null || binsBelowMin != null || binsBelowMax != null || binsAbove != null || targetDownsidePct != null,
  };
}

export function resolveActiveStrategyRangePolicy(runtimeConfig = {}) {
  return resolveStrategyRangePolicy(getActiveStrategy(), runtimeConfig);
}

export function describeRangePolicyForPrompt(policy = {}) {
  if (!policy?.hasExplicitRangePolicy) {
    return "Use the active strategy and runtime config range policy. If no range is configured, use the deploy tool defaults and safety guards.";
  }
  const parts = [];
  if (policy.lpStrategy) parts.push(`strategy=${policy.lpStrategy}`);
  if (policy.singleSidedSol) parts.push("single-sided SOL");
  if (policy.binsBelowDefault != null && policy.targetDownsidePct == null) {
    parts.push(`default bins_below=${policy.binsBelowDefault}`);
  } else if (policy.targetDownsidePct != null && policy.binsBelowDefault == null) {
    parts.push(`compute bins_below from target_downside and pool bin_step (do NOT use a fixed bins_below number)`);
  }
  if (policy.binsBelowMin != null || policy.binsBelowMax != null) {
    parts.push(`bins_below bounds=[${policy.binsBelowMin ?? "none"}, ${policy.binsBelowMax ?? "none"}]`);
  }
  if (policy.targetDownsidePct != null) {
    const targetRange = policy.targetDownsideMinPct != null || policy.targetDownsideMaxPct != null
      ? ` range=[${policy.targetDownsideMinPct ?? "none"}, ${policy.targetDownsideMaxPct ?? "none"}]%`
      : "";
    parts.push(`target_downside=${policy.targetDownsidePct}%${targetRange}`);
  }
  if (policy.binsAbove != null) parts.push(`bins_above=${policy.binsAbove}`);
  return parts.join("; ");
}

export function buildFeeVelocityShadowRows(candidate = {}, screeningConfig = {}, rangePolicy = {}) {
  const binStep = numberFromCandidate(candidate, ["bin_step", "dlmm_params.bin_step"]);
  const volumeActiveTvlMultiple = computeVolumeActiveTvlMultiple(candidate);
  const feeVelocityUsdPerMin = estimateFeeVelocityUsdPerMin(candidate, screeningConfig);
  const downsideVariants = finiteNumberArray(screeningConfig.feeVelocityShadowDownsidePct, [7, 10, 12, 15, 20, 25])
    .map((downsidePct) => ({
      hypothesis: downsidePct <= 12 ? "H1" : "H3",
      downside_pct: downsidePct,
      bins_below: computeDownsideBinsForPct(downsidePct, binStep),
      bin_step: binStep,
    }));
  const takeProfitVariants = finiteNumberArray(screeningConfig.feeVelocityShadowTakeProfitPct, [6, 7, 8])
    .map((takeProfitPct) => ({
      hypothesis: "H3",
      take_profit_pct: takeProfitPct,
    }));
  const feeFloorVariants = finiteNumberArray(screeningConfig.feeVelocityShadowFeeTvlFloors, [0.12, 0.15, 0.19])
    .map((fee_tvl_floor) => ({
      hypothesis: "H5",
      fee_tvl_floor,
      passes_floor: numberFromCandidate(candidate, ["fee_active_tvl_ratio", "fee_tvl_ratio"]) != null
        ? numberFromCandidate(candidate, ["fee_active_tvl_ratio", "fee_tvl_ratio"]) >= fee_tvl_floor
        : null,
      volume_active_tvl_multiple: volumeActiveTvlMultiple,
      fee_velocity_usd_per_min: feeVelocityUsdPerMin,
    }));
  const sameTickerSurf = {
    hypothesis: "H4",
    enabled: screeningConfig.sameTickerSurfEnabled === true,
    opportunity: false,
    reject_reason: screeningConfig.sameTickerSurfEnabled === true
      ? "requires post-close same-pool/base-mint revalidation before action"
      : "sameTickerSurfEnabled is false; shadow-only",
  };

  // ─── Shadow Entry Indicator Signals ────────────────────────────────────────
  // All 5 signals are shadow-only: they attach to fee_velocity_shadow in
  // candidate metadata and get logged in action logs. They do NOT filter
  // candidates, do NOT change screening behavior, do NOT affect position sizing.

  // Signal 1: Price Direction Shadow
  const priceChange1h = numberFromCandidate(candidate, [
    "price_change_pct", "price_change_1h", "change_1h",
    "stats_1h.price_change", "token_info.stats_1h.price_change",
  ]);
  const pumpThresholds = finiteNumberArray(screeningConfig.feeVelocityShadowPumpThresholds, [30, 50, 100]);
  const price_direction_shadow = {
    price_change_1h_pct: priceChange1h,
    pump_risk: priceChange1h != null ? (
      priceChange1h > 100 ? "extreme" :
      priceChange1h > 50  ? "high" :
      priceChange1h > 30  ? "moderate" :
      priceChange1h > 0   ? "mild_up" :
      priceChange1h > -20 ? "mild_down" : "dump"
    ) : null,
    threshold_verdicts: pumpThresholds.map((threshold) => ({
      threshold_pct: threshold,
      would_reject: priceChange1h != null ? priceChange1h > threshold : null,
      label: `reject_if_1h_pump_gt_${threshold}pct`,
    })),
    note: "shadow_only — price direction check for post-pump entry risk",
  };

  // Signal 2: Sell Pressure Shadow
  const sellVol = numberFromCandidate(candidate, [
    "sell_vol", "stats_1h.sell_vol", "token_info.stats_1h.sell_vol",
  ]);
  const buyVol = numberFromCandidate(candidate, [
    "buy_vol", "stats_1h.buy_vol", "token_info.stats_1h.buy_vol",
  ]);
  const sellBuyRatio = (sellVol != null && buyVol != null && buyVol > 0)
    ? roundNumber(sellVol / buyVol, 3) : null;
  const sellBuyThresholds = finiteNumberArray(screeningConfig.feeVelocityShadowSellBuyThresholds, [1.2, 1.5, 2.0]);
  const sell_pressure_shadow = {
    sell_vol: sellVol,
    buy_vol: buyVol,
    sell_buy_ratio: sellBuyRatio,
    pressure_level: sellBuyRatio != null ? (
      sellBuyRatio > 2.0 ? "heavy_sell" :
      sellBuyRatio > 1.5 ? "moderate_sell" :
      sellBuyRatio > 1.2 ? "mild_sell" :
      sellBuyRatio > 0.8 ? "balanced" : "buy_pressure"
    ) : null,
    threshold_verdicts: sellBuyThresholds.map((threshold) => ({
      threshold,
      would_reject: sellBuyRatio != null ? sellBuyRatio > threshold : null,
      label: `reject_if_sell_buy_gt_${String(threshold).replace(".", "_")}`,
    })),
    note: "shadow_only — sell pressure check for distribution vs accumulation",
  };

  // Signal 3: Volume/TVL Multiple Threshold Variants Shadow
  const volTvlThresholds = finiteNumberArray(
    screeningConfig.feeVelocityShadowVolTvlThresholds,
    [3.5, 4.0, 4.5, 5.0, 6.0, 8.0],
  );
  const volume_tvl_threshold_shadow = {
    volume_active_tvl_multiple: volumeActiveTvlMultiple,
    threshold_verdicts: volTvlThresholds.map((threshold) => ({
      threshold,
      passes: volumeActiveTvlMultiple != null ? volumeActiveTvlMultiple >= threshold : null,
      label: `passes_vol_tvl_gte_${String(threshold).replace(".", "_")}x`,
    })),
    note: "shadow_only — calibrate optimal minVolumeActiveTvlMultiple threshold",
  };

  // Signal 4: Fee Velocity Momentum Shadow
  const tokenAgeHours = numberFromCandidate(candidate, [
    "token_age_hours", "token_info.token_age_hours",
  ]);
  const feeVelocityPerHour = feeVelocityUsdPerMin != null ? roundNumber(feeVelocityUsdPerMin * 60, 2) : null;
  const feeVelocityPerAgeHour = (feeVelocityPerHour != null && tokenAgeHours != null && tokenAgeHours > 0)
    ? roundNumber(feeVelocityPerHour / tokenAgeHours, 4) : null;
  const fee_velocity_momentum_shadow = {
    fee_velocity_usd_per_min: feeVelocityUsdPerMin,
    fee_velocity_usd_per_hour: feeVelocityPerHour,
    token_age_hours: tokenAgeHours,
    fee_velocity_per_age_hour: feeVelocityPerAgeHour,
    age_risk: tokenAgeHours != null ? (
      tokenAgeHours < 1  ? "very_young_lt_1h" :
      tokenAgeHours < 6  ? "young_lt_6h" :
      tokenAgeHours < 24 ? "recent_lt_24h" : "established"
    ) : null,
    note: "shadow_only — fee velocity relative to token age for pump-and-dump risk",
  };

  // Signal 5: Organic Score vs Fee Velocity Shadow
  const organicScore = numberFromCandidate(candidate, [
    "organic_score", "base.organic", "token_x.organic_score",
  ]);
  const feeActiveTvlRatio = numberFromCandidate(candidate, [
    "fee_active_tvl_ratio", "fee_tvl_ratio",
  ]);
  const quality_vs_velocity_shadow = {
    organic_score: organicScore,
    fee_active_tvl_ratio: feeActiveTvlRatio,
    volume_active_tvl_multiple: volumeActiveTvlMultiple,
    quality_signal: organicScore != null ? (
      organicScore >= 70 ? "high_quality" :
      organicScore >= 50 ? "moderate_quality" :
      organicScore >= 30 ? "low_quality" : "very_low_quality"
    ) : null,
    // Combined quality+velocity score: high organic + high fee velocity = best
    combined_score: (organicScore != null && volumeActiveTvlMultiple != null)
      ? roundNumber((organicScore / 100) * Math.min(volumeActiveTvlMultiple / 5, 2), 3)
      : null,
    note: "shadow_only — organic quality vs fee velocity for wash trading risk",
  };

  return {
    downside_pct_variants: downsideVariants,
    take_profit_pct_variants: takeProfitVariants,
    fee_tvl_floor_variants: feeFloorVariants,
    same_ticker_surf: sameTickerSurf,
    target_profile: {
      hypothesis: "H2",
      target_downside_pct: rangePolicy.targetDownsidePct ?? null,
      target_downside_min_pct: rangePolicy.targetDownsideMinPct ?? null,
      target_downside_max_pct: rangePolicy.targetDownsideMaxPct ?? null,
      target_downside_bins: computeDownsideBinsForPct(rangePolicy.targetDownsidePct, binStep),
      target_downside_min_bins: computeDownsideBinsForPct(rangePolicy.targetDownsideMinPct, binStep),
      target_downside_max_bins: computeDownsideBinsForPct(rangePolicy.targetDownsideMaxPct, binStep),
    },
    // Shadow entry indicator signals — shadow-only, no live filtering
    price_direction_shadow,
    sell_pressure_shadow,
    volume_tvl_threshold_shadow,
    fee_velocity_momentum_shadow,
    quality_vs_velocity_shadow,
  };
}

export function enrichFeeVelocityCandidate(candidate = {}, {
  screeningConfig = {},
  rangePolicy = {},
} = {}) {
  const volumeActiveTvlMultiple = computeVolumeActiveTvlMultiple(candidate);
  const feeVelocityUsdPerMin = estimateFeeVelocityUsdPerMin(candidate, screeningConfig);
  const shadow = buildFeeVelocityShadowRows(candidate, screeningConfig, rangePolicy);
  return {
    ...candidate,
    volume_active_tvl_multiple: volumeActiveTvlMultiple,
    fee_velocity_usd_per_min: feeVelocityUsdPerMin,
    target_downside_profile: shadow.target_profile,
    fee_velocity_shadow: shadow,
    same_ticker_surf_enabled: screeningConfig.sameTickerSurfEnabled === true,
  };
}
