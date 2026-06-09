import fs from "fs";
import path from "path";

export const MOMENTUM_SCORE_VERSION = "momentum_score_v1";
export const DYNAMIC_ENTRY_SHADOW_VERSION = "dynamic_entry_shadow_v1";

const DEFAULT_LOG_DIR = "./logs";
const THROTTLES = Object.freeze(["none", "slow_screening", "skip_candidate_shadow", "avoid_shadow"]);
const DEFAULT_PATIENT_HOLD_MINUTES = 120;
const DEFAULT_SCALP_HOLD_MINUTES = 25;

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function round(value, decimals = 4) {
  const num = finiteNumber(value);
  if (num == null) return null;
  const scale = 10 ** decimals;
  return Math.round(num * scale) / scale;
}

function clamp(value, min = 0, max = 100) {
  const num = finiteNumber(value);
  if (num == null) return null;
  return Math.max(min, Math.min(max, num));
}

function nestedValue(source, key) {
  return String(key)
    .split(".")
    .reduce((current, part) => current?.[part], source);
}

function candidateNumber(candidate = {}, keys = []) {
  for (const key of keys) {
    const num = finiteNumber(nestedValue(candidate, key));
    if (num != null) return { value: num, source: key };
  }
  return { value: null, source: null };
}

function computeVolumeActiveTvlMultiple(candidate = {}) {
  const explicit = candidateNumber(candidate, ["volume_active_tvl_multiple"]);
  if (explicit.value != null) return explicit;
  const volume = candidateNumber(candidate, ["volume_window", "volume"]);
  const activeTvl = candidateNumber(candidate, ["active_tvl", "tvl"]);
  if (volume.value == null || activeTvl.value == null || activeTvl.value <= 0) {
    return { value: null, source: null };
  }
  return {
    value: round(volume.value / activeTvl.value, 4),
    source: `${volume.source}/${activeTvl.source}`,
  };
}

function sellBuyRatio(candidate = {}) {
  const explicit = candidateNumber(candidate, ["sell_buy_ratio", "sellBuyRatio"]);
  if (explicit.value != null) return explicit;
  const sell = candidateNumber(candidate, ["sell_vol", "stats_1h.sell_vol", "token_info.stats_1h.sell_vol"]);
  const buy = candidateNumber(candidate, ["buy_vol", "stats_1h.buy_vol", "token_info.stats_1h.buy_vol"]);
  if (sell.value == null || buy.value == null || buy.value <= 0) return { value: null, source: null };
  return { value: round(sell.value / buy.value, 4), source: `${sell.source}/${buy.source}` };
}

function linearScore(value, zeroAt, fullAt) {
  const num = finiteNumber(value);
  if (num == null) return null;
  if (fullAt === zeroAt) return null;
  return round(clamp(((num - zeroAt) / (fullAt - zeroAt)) * 100), 2);
}

function priceScore(priceChangePct, profile) {
  if (priceChangePct == null) return null;
  if (profile === "hot_fee_scalp") {
    return linearScore(priceChangePct, -5, 35);
  }
  return linearScore(priceChangePct, -20, 60);
}

function feeTvlScore(feeActiveTvlRatio) {
  if (feeActiveTvlRatio == null) return null;
  const pctLike = feeActiveTvlRatio >= 1 ? feeActiveTvlRatio : feeActiveTvlRatio * 100;
  return linearScore(pctLike, 0, 12);
}

function volumeScore(volumeActiveTvlMultiple, volumeChangePct) {
  if (volumeActiveTvlMultiple != null) {
    return linearScore(volumeActiveTvlMultiple, 0, 5);
  }
  if (volumeChangePct != null) {
    return linearScore(volumeChangePct, -20, 80);
  }
  return null;
}

function feeVelocityScore(feeVelocityUsdPerMin) {
  if (feeVelocityUsdPerMin == null) return null;
  return linearScore(feeVelocityUsdPerMin, 0, 150);
}

function component(name, score, raw, source, weight) {
  return {
    name,
    score: round(score, 2),
    raw: round(raw, 6),
    source,
    weight,
    present: score != null,
  };
}

function componentMap(candidate = {}, profile = "patient_fee_harvest") {
  const feeActiveTvlRatio = candidateNumber(candidate, ["fee_active_tvl_ratio", "fee_tvl_ratio"]);
  const volumeActiveTvlMultiple = computeVolumeActiveTvlMultiple(candidate);
  const feeVelocityUsdPerMin = candidateNumber(candidate, ["fee_velocity_usd_per_min"]);
  const priceChangePct = candidateNumber(candidate, [
    profile === "hot_fee_scalp" ? "price_change_5m" : "price_change_1h",
    "price_change_pct",
    "change_1h",
    "stats_1h.price_change",
    "token_info.stats_1h.price_change",
  ]);
  const volumeChangePct = candidateNumber(candidate, ["volume_change_pct", "volumeChangePct"]);
  const activeTvl = candidateNumber(candidate, ["active_tvl", "tvl"]);
  const organicScore = candidateNumber(candidate, ["organic_score", "base.organic", "token_x.organic_score"]);
  const tokenAgeHours = candidateNumber(candidate, ["token_age_hours", "token_info.token_age_hours"]);
  const ratio = sellBuyRatio(candidate);

  const weights = profile === "hot_fee_scalp"
    ? { price: 0.3, volume: 0.25, feeTvl: 0.2, feeVelocity: 0.15, quality: 0.1 }
    : { feeTvl: 0.3, volume: 0.25, price: 0.2, feeVelocity: 0.15, quality: 0.1 };

  const qualityScore = organicScore.value == null && activeTvl.value == null
    ? null
    : Math.min(
      organicScore.value == null ? 100 : clamp(organicScore.value),
      activeTvl.value == null ? 100 : linearScore(activeTvl.value, 2_500, 20_000),
    );

  return {
    rawInputs: {
      fee_active_tvl_ratio: feeActiveTvlRatio.value,
      volume_active_tvl_multiple: volumeActiveTvlMultiple.value,
      fee_velocity_usd_per_min: feeVelocityUsdPerMin.value,
      price_change_pct: priceChangePct.value,
      volume_change_pct: volumeChangePct.value,
      sell_buy_ratio: ratio.value,
      token_age_hours: tokenAgeHours.value,
      organic_score: organicScore.value,
      active_tvl: activeTvl.value,
    },
    sources: {
      fee_active_tvl_ratio: feeActiveTvlRatio.source,
      volume_active_tvl_multiple: volumeActiveTvlMultiple.source,
      fee_velocity_usd_per_min: feeVelocityUsdPerMin.source,
      price_change_pct: priceChangePct.source,
      volume_change_pct: volumeChangePct.source,
      sell_buy_ratio: ratio.source,
      token_age_hours: tokenAgeHours.source,
      organic_score: organicScore.source,
      active_tvl: activeTvl.source,
    },
    components: {
      fee_tvl: component("fee_tvl", feeTvlScore(feeActiveTvlRatio.value), feeActiveTvlRatio.value, feeActiveTvlRatio.source, weights.feeTvl),
      volume_acceleration: component("volume_acceleration", volumeScore(volumeActiveTvlMultiple.value, volumeChangePct.value), volumeActiveTvlMultiple.value ?? volumeChangePct.value, volumeActiveTvlMultiple.source ?? volumeChangePct.source, weights.volume),
      price_momentum: component("price_momentum", priceScore(priceChangePct.value, profile), priceChangePct.value, priceChangePct.source, weights.price),
      fee_velocity: component("fee_velocity", feeVelocityScore(feeVelocityUsdPerMin.value), feeVelocityUsdPerMin.value, feeVelocityUsdPerMin.source, weights.feeVelocity),
      quality: component("quality", qualityScore, organicScore.value ?? activeTvl.value, organicScore.source ?? activeTvl.source, weights.quality),
    },
  };
}

function scoreComponents(components = {}) {
  let weighted = 0;
  let availableWeight = 0;
  const missingFields = [];
  for (const [key, entry] of Object.entries(components)) {
    if (entry.score == null) {
      missingFields.push(key);
      continue;
    }
    weighted += entry.score * entry.weight;
    availableWeight += entry.weight;
  }
  const confidence = round(availableWeight, 3);
  return {
    score: confidence > 0 ? round(weighted / availableWeight, 2) : null,
    confidence,
    missingFields,
  };
}

function boundedScore(value, zeroAt, fullAt) {
  const score = linearScore(value, zeroAt, fullAt);
  return score == null ? null : clamp(score);
}

function averageScores(entries = []) {
  const present = entries.filter((entry) => entry != null);
  if (!present.length) return null;
  return round(present.reduce((sum, entry) => sum + entry, 0) / present.length, 2);
}

function rawNumber(rawInputs = {}, key) {
  return finiteNumber(rawInputs[key]);
}

function candidateUsd(candidate = {}, keys = []) {
  const found = candidateNumber(candidate, keys);
  return found.value != null && found.value > 0 ? found.value : null;
}

function estimateDynamicEntryShadow(candidate = {}, mapped = {}, scored = {}, flags = [], profile = "patient_fee_harvest") {
  const rawInputs = mapped.rawInputs ?? {};
  const activeTvlUsd = rawNumber(rawInputs, "active_tvl");
  const feeVelocityUsdPerMin = rawNumber(rawInputs, "fee_velocity_usd_per_min");
  const volumeActiveTvlMultiple = rawNumber(rawInputs, "volume_active_tvl_multiple");
  const feeActiveTvlRatio = rawNumber(rawInputs, "fee_active_tvl_ratio");
  const volumeChangePct = rawNumber(rawInputs, "volume_change_pct");
  const priceChangePct = rawNumber(rawInputs, "price_change_pct");
  const organicScore = rawNumber(rawInputs, "organic_score");
  const tokenAgeHours = rawNumber(rawInputs, "token_age_hours");
  const assumedDeployUsd = candidateUsd(candidate, [
    "dynamic_entry_shadow.assumed_deploy_usd",
    "assumed_deploy_usd",
    "deploy_usd",
    "deployAmountUsd",
    "entry_amount_usd",
  ]);
  const txCostUsd = candidateUsd(candidate, ["dynamic_entry_shadow.tx_cost_usd", "tx_cost_usd"]);
  const slippageBudgetUsd = candidateUsd(candidate, ["dynamic_entry_shadow.slippage_budget_usd", "slippage_budget_usd"]);
  const repositionBudgetUsd = candidateUsd(candidate, ["dynamic_entry_shadow.reposition_budget_usd", "reposition_budget_usd"]);
  const tailRiskBudgetUsd = candidateUsd(candidate, ["dynamic_entry_shadow.tail_risk_budget_usd", "tail_risk_budget_usd"]);
  const holdMinutes = finiteNumber(candidate.dynamic_entry_shadow?.hold_minutes ?? candidate.shadow_hold_minutes)
    ?? (profile === "hot_fee_scalp" ? DEFAULT_SCALP_HOLD_MINUTES : DEFAULT_PATIENT_HOLD_MINUTES);

  const feeVelocityUsdPerHour = feeVelocityUsdPerMin != null ? round(feeVelocityUsdPerMin * 60, 4) : null;
  const feeVelocityActiveTvlHourlyPct = (
    feeVelocityUsdPerHour != null &&
    activeTvlUsd != null &&
    activeTvlUsd > 0
  ) ? round((feeVelocityUsdPerHour / activeTvlUsd) * 100, 4) : null;

  const deployShareOfActiveTvlPct = (
    assumedDeployUsd != null &&
    activeTvlUsd != null &&
    activeTvlUsd > 0
  ) ? round((assumedDeployUsd / activeTvlUsd) * 100, 4) : null;

  const captureDiscount = volumeActiveTvlMultiple == null
    ? 0.35
    : volumeActiveTvlMultiple < 1
      ? 0.25
      : volumeActiveTvlMultiple < 2
        ? 0.45
        : 0.65;
  const estimatedGrossFeesUsd = (
    feeVelocityUsdPerMin != null &&
    holdMinutes != null &&
    deployShareOfActiveTvlPct != null
  ) ? round(feeVelocityUsdPerMin * holdMinutes * (deployShareOfActiveTvlPct / 100) * captureDiscount, 4) : null;
  const totalCostBudgetUsd = [txCostUsd, slippageBudgetUsd, repositionBudgetUsd, tailRiskBudgetUsd]
    .reduce((sum, entry) => sum + (entry ?? 0), 0);
  const estimatedNetFeesUsd = estimatedGrossFeesUsd != null
    ? round(estimatedGrossFeesUsd - totalCostBudgetUsd, 4)
    : null;
  const breakevenHoldMinutes = (
    feeVelocityUsdPerMin != null &&
    feeVelocityUsdPerMin > 0 &&
    deployShareOfActiveTvlPct != null &&
    deployShareOfActiveTvlPct > 0 &&
    captureDiscount > 0 &&
    totalCostBudgetUsd > 0
  ) ? round(totalCostBudgetUsd / (feeVelocityUsdPerMin * (deployShareOfActiveTvlPct / 100) * captureDiscount), 2) : null;

  const expectedFeeScore = averageScores([
    boundedScore(feeVelocityActiveTvlHourlyPct, 0, 8),
    boundedScore(feeVelocityUsdPerMin, 0, profile === "hot_fee_scalp" ? 40 : 12),
    boundedScore(feeActiveTvlRatio, 0, 8),
  ]);
  const persistenceScore = averageScores([
    volumeChangePct == null ? null : boundedScore(volumeChangePct, -25, 35),
    volumeActiveTvlMultiple == null ? null : boundedScore(volumeActiveTvlMultiple, 0, profile === "hot_fee_scalp" ? 5 : 3),
  ]);
  const flowQualityScore = averageScores([
    volumeActiveTvlMultiple == null ? null : boundedScore(volumeActiveTvlMultiple, 0, profile === "hot_fee_scalp" ? 6 : 4),
    feeVelocityUsdPerMin == null ? null : boundedScore(feeVelocityUsdPerMin, 0, profile === "hot_fee_scalp" ? 60 : 15),
  ]);
  const depthRiskScore = averageScores([
    activeTvlUsd == null ? null : boundedScore(activeTvlUsd, 10_000, 60_000),
    deployShareOfActiveTvlPct == null ? null : 100 - boundedScore(deployShareOfActiveTvlPct, 0.25, 1.5),
  ]);
  const qualityRiskScore = averageScores([
    organicScore == null ? null : boundedScore(organicScore, 45, 85),
    tokenAgeHours == null ? null : boundedScore(tokenAgeHours, 1, profile === "hot_fee_scalp" ? 12 : 24),
  ]);
  const priceRegimeScore = priceChangePct == null
    ? null
    : profile === "hot_fee_scalp"
      ? boundedScore(priceChangePct, -15, 35)
      : boundedScore(Math.abs(Math.min(priceChangePct, 0)), 0, 35);

  const weighted = [
    [expectedFeeScore, 0.25],
    [persistenceScore, profile === "hot_fee_scalp" ? 0.05 : 0.20],
    [flowQualityScore, profile === "hot_fee_scalp" ? 0.30 : 0.15],
    [depthRiskScore, profile === "hot_fee_scalp" ? 0.20 : 0.15],
    [qualityRiskScore, 0.15],
    [priceRegimeScore, 0.10],
  ];
  let weightedScore = 0;
  let availableWeight = 0;
  for (const [score, weight] of weighted) {
    if (score == null) continue;
    weightedScore += score * weight;
    availableWeight += weight;
  }
  const dynamicScore = availableWeight > 0 ? round(weightedScore / availableWeight, 2) : null;
  const reasonCodes = [];
  if (flags.includes("low_active_tvl") || (activeTvlUsd != null && activeTvlUsd < 10_000)) reasonCodes.push("low_active_tvl");
  if (flags.includes("low_organic_score")) reasonCodes.push("low_organic_score");
  if (flags.includes("overheated_price_change")) reasonCodes.push("overheated_price_change");
  if (flags.includes("sell_pressure")) reasonCodes.push("sell_pressure");
  if (volumeActiveTvlMultiple != null && volumeActiveTvlMultiple < 1) reasonCodes.push("weak_flow_relative_to_active_tvl");
  if (feeActiveTvlRatio != null && feeActiveTvlRatio >= 3 && volumeActiveTvlMultiple != null && volumeActiveTvlMultiple < 1) {
    reasonCodes.push("high_fee_low_flow_exception");
  }
  if (estimatedNetFeesUsd != null && estimatedNetFeesUsd <= 0) reasonCodes.push("negative_expected_net_after_budgets");

  let entryLabel = "reject";
  if (reasonCodes.includes("low_active_tvl") || reasonCodes.includes("low_organic_score") || reasonCodes.includes("overheated_price_change") || reasonCodes.includes("sell_pressure")) {
    entryLabel = "reject";
  } else if (reasonCodes.includes("high_fee_low_flow_exception")) {
    entryLabel = "watchlist";
  } else if (dynamicScore != null && dynamicScore >= 75 && (estimatedNetFeesUsd == null || estimatedNetFeesUsd > 0)) {
    entryLabel = "live_candidate";
  } else if (dynamicScore != null && dynamicScore >= 55) {
    entryLabel = "watchlist";
  } else if (dynamicScore != null && dynamicScore >= 40) {
    entryLabel = "micro_canary";
  }

  return {
    version: DYNAMIC_ENTRY_SHADOW_VERSION,
    shadowOnly: true,
    profile,
    entry_label: entryLabel,
    reason_codes: reasonCodes,
    dynamic_score: dynamicScore,
    confidence: round(availableWeight, 3),
    hold_minutes: holdMinutes,
    fee_velocity_usd_per_hour: feeVelocityUsdPerHour,
    fee_velocity_active_tvl_hourly_pct: feeVelocityActiveTvlHourlyPct,
    deploy_share_of_active_tvl_pct: deployShareOfActiveTvlPct,
    assumed_deploy_usd: assumedDeployUsd,
    capture_discount: round(captureDiscount, 4),
    estimated_gross_fees_usd: estimatedGrossFeesUsd,
    estimated_net_fees_usd: estimatedNetFeesUsd,
    breakeven_hold_minutes: breakevenHoldMinutes,
    budgets_usd: {
      tx_cost: txCostUsd,
      slippage: slippageBudgetUsd,
      reposition: repositionBudgetUsd,
      tail_risk: tailRiskBudgetUsd,
      total: totalCostBudgetUsd > 0 ? round(totalCostBudgetUsd, 4) : null,
    },
    components: {
      expected_fee: round(expectedFeeScore, 2),
      persistence: round(persistenceScore, 2),
      flow_quality: round(flowQualityScore, 2),
      depth_risk: round(depthRiskScore, 2),
      quality_risk: round(qualityRiskScore, 2),
      price_regime: round(priceRegimeScore, 2),
    },
  };
}

function riskFlags({ rawInputs = {}, components = {} }, score, confidence, profile) {
  const flags = [];
  const priceChange = finiteNumber(rawInputs.price_change_pct);
  const sellBuy = finiteNumber(rawInputs.sell_buy_ratio);
  const tokenAge = finiteNumber(rawInputs.token_age_hours);
  const organic = finiteNumber(rawInputs.organic_score);
  const activeTvl = finiteNumber(rawInputs.active_tvl);
  const feeTvl = components.fee_tvl?.score;
  const volume = components.volume_acceleration?.score;
  const overheatThreshold = profile === "hot_fee_scalp" ? 85 : 150;

  if (confidence < 0.6) flags.push("low_confidence");
  if (priceChange != null && priceChange >= overheatThreshold) flags.push("overheated_price_change");
  if (sellBuy != null && sellBuy >= 1.5) flags.push("sell_pressure");
  if (tokenAge != null && tokenAge < 1) flags.push("very_young_token");
  if (organic != null && organic < 45) flags.push("low_organic_score");
  if (activeTvl != null && activeTvl < 5_000) flags.push("low_active_tvl");
  if (feeTvl != null && feeTvl < 25 && volume != null && volume < 40) flags.push("weak_fee_flow");
  if (score == null) flags.push("missing_score");
  return flags;
}

function classify(score, flags = []) {
  if (score == null) return "missing_data";
  if (flags.includes("low_confidence")) return "missing_data";
  if (flags.includes("overheated_price_change") || flags.includes("sell_pressure")) return "overheated";
  if (score >= 75) return "accelerating";
  if (score >= 45) return "neutral";
  return "weak";
}

function throttleFor(score, confidence, flags = []) {
  if (score == null || flags.includes("missing_score") || flags.includes("overheated_price_change") || flags.includes("sell_pressure")) return "avoid_shadow";
  if (flags.includes("low_confidence") || flags.includes("very_young_token") || flags.includes("low_active_tvl")) return "skip_candidate_shadow";
  if (flags.includes("weak_fee_flow") || score < 45) return "skip_candidate_shadow";
  if (confidence < 0.8 || score < 60) return "slow_screening";
  return "none";
}

export function computeMomentumScoreV1(candidate = {}, { profile = "patient_fee_harvest" } = {}) {
  const resolvedProfile = profile === "hot_fee_scalp" ? "hot_fee_scalp" : "patient_fee_harvest";
  const mapped = componentMap(candidate, resolvedProfile);
  const scored = scoreComponents(mapped.components);
  const flags = riskFlags(mapped, scored.score, scored.confidence, resolvedProfile);
  const momentumClassification = classify(scored.score, flags);
  const wouldThrottle = throttleFor(scored.score, scored.confidence, flags);
  const dynamicEntry = estimateDynamicEntryShadow(candidate, mapped, scored, flags, resolvedProfile);
  const wouldScalp = resolvedProfile === "hot_fee_scalp" &&
    scored.score != null &&
    scored.score >= 75 &&
    scored.confidence >= 0.75 &&
    !flags.includes("overheated_price_change") &&
    !flags.includes("sell_pressure") &&
    !flags.includes("low_active_tvl") &&
    !flags.includes("low_organic_score");

  return {
    version: MOMENTUM_SCORE_VERSION,
    shadowOnly: true,
    momentum_profile: resolvedProfile,
    momentum_score_v1: scored.score,
    momentum_classification: momentumClassification,
    confidence: scored.confidence,
    missing_fields: scored.missingFields,
    risk_flags: flags,
    would_scalp: Boolean(wouldScalp),
    would_throttle: THROTTLES.includes(wouldThrottle) ? wouldThrottle : "none",
    dynamic_entry_shadow: dynamicEntry,
    components: mapped.components,
    raw_inputs: mapped.rawInputs,
    sources: mapped.sources,
  };
}

export function attachMomentumScoreV1(candidate = {}) {
  const patient = computeMomentumScoreV1(candidate, { profile: "patient_fee_harvest" });
  const scalp = computeMomentumScoreV1(candidate, { profile: "hot_fee_scalp" });
  return {
    ...candidate,
    momentum_score_v1: patient.momentum_score_v1,
    momentum_profile: patient.momentum_profile,
    momentum_classification: patient.momentum_classification,
    momentum_confidence: patient.confidence,
    momentum_risk_flags: patient.risk_flags,
    momentum_would_throttle: patient.would_throttle,
    momentum_would_scalp: scalp.would_scalp,
    dynamic_entry_shadow: patient.dynamic_entry_shadow,
    momentum_score: {
      version: MOMENTUM_SCORE_VERSION,
      shadowOnly: true,
      primary: patient,
      profiles: {
        patient_fee_harvest: patient,
        hot_fee_scalp: scalp,
      },
      would_scalp: scalp.would_scalp,
      would_throttle: patient.would_throttle === "none" ? scalp.would_throttle : patient.would_throttle,
    },
  };
}

function dateKey(ts = new Date().toISOString()) {
  return String(ts).slice(0, 10);
}

function baseMint(candidate = {}) {
  return candidate.base?.mint ?? candidate.base_mint ?? candidate.token_x?.address ?? candidate.token_x_mint ?? null;
}

export function getMomentumScoreLogPath(ts = new Date().toISOString(), logDir = DEFAULT_LOG_DIR) {
  return path.join(logDir, `momentum-score-v1-${dateKey(ts)}.jsonl`);
}

export function appendMomentumScoreV1(candidate = {}, options = {}) {
  const momentum = candidate.momentum_score ?? attachMomentumScoreV1(candidate).momentum_score;
  try {
    const ts = options.ts ?? new Date().toISOString();
    const row = {
      ts,
      event: "momentum_score_v1",
      shadowOnly: true,
      pool: candidate.pool ?? candidate.pool_address ?? candidate.address ?? null,
      poolName: candidate.name ?? candidate.pool_name ?? null,
      baseMint: baseMint(candidate),
      baseSymbol: candidate.base?.symbol ?? candidate.base_symbol ?? candidate.token_x?.symbol ?? null,
      quoteSymbol: candidate.quote?.symbol ?? candidate.quote_symbol ?? candidate.token_y?.symbol ?? null,
      liveAccepted: options.liveAccepted ?? null,
      liveVetoReason: options.liveVetoReason ?? null,
      currentLiveDecision: options.liveAccepted === true ? "accepted_by_existing_filters" : options.liveAccepted === false ? "rejected_by_existing_filters" : null,
      momentum,
    };
    const logDir = options.logDir ?? process.env.MERIDIAN_MOMENTUM_SCORE_LOG_DIR ?? DEFAULT_LOG_DIR;
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(getMomentumScoreLogPath(ts, logDir), `${JSON.stringify(row)}\n`);
    return row;
  } catch (error) {
    if (options.throwOnError) throw error;
    return null;
  }
}
