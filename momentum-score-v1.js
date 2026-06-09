import fs from "fs";
import path from "path";

export const MOMENTUM_SCORE_VERSION = "momentum_score_v1";

const DEFAULT_LOG_DIR = "./logs";
const THROTTLES = Object.freeze(["none", "slow_screening", "skip_candidate_shadow", "avoid_shadow"]);

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
