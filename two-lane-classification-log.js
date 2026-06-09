import fs from "fs";
import path from "path";

const DEFAULT_LOG_DIR = "./logs";

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function roundNumber(value, decimals = 4) {
  const num = finiteNumber(value);
  if (num == null) return null;
  const scale = 10 ** decimals;
  return Math.round(num * scale) / scale;
}

function nestedValue(source, key) {
  return String(key)
    .split(".")
    .reduce((current, part) => current?.[part], source);
}

function candidateNumber(candidate = {}, keys = []) {
  for (const key of keys) {
    const num = finiteNumber(nestedValue(candidate, key));
    if (num != null) return num;
  }
  return null;
}

function computeVolumeActiveTvlMultiple(candidate = {}) {
  const explicit = candidateNumber(candidate, ["volume_active_tvl_multiple"]);
  if (explicit != null) return explicit;
  const volume = candidateNumber(candidate, ["volume_window", "volume"]);
  const activeTvl = candidateNumber(candidate, ["active_tvl", "tvl"]);
  if (volume == null || activeTvl == null || activeTvl <= 0) return null;
  return roundNumber(volume / activeTvl, 4);
}

function dateKey(ts = new Date().toISOString()) {
  return String(ts).slice(0, 10);
}

function getBaseMint(candidate = {}) {
  return candidate.base?.mint ?? candidate.base_mint ?? candidate.baseMint ?? null;
}

function getBaseSymbol(candidate = {}) {
  return candidate.base?.symbol ?? candidate.base_symbol ?? candidate.baseSymbol ?? null;
}

function getQuoteSymbol(candidate = {}) {
  return candidate.quote?.symbol ?? candidate.quote_symbol ?? candidate.quoteSymbol ?? null;
}

export function classifyTwoLaneCandidate(candidate = {}, screeningConfig = {}) {
  const volumeActiveTvlMultiple = computeVolumeActiveTvlMultiple(candidate);
  const currentHardGate = finiteNumber(screeningConfig.minVolumeActiveTvlMultiple);
  const primaryFloor = finiteNumber(screeningConfig.twoLanePrimaryVolumeActiveTvlMultiple) ?? 3;
  const looseFloor = finiteNumber(screeningConfig.looseVolumeActiveTvlMultiple) ?? 2.5;
  const minFeePct = finiteNumber(screeningConfig.looseLaneMinFeePct) ?? 3;
  const minFeeTvlRatio = finiteNumber(screeningConfig.looseLaneMinFeeTvlRatio) ?? 8;
  const minBinStep = finiteNumber(screeningConfig.looseLaneMinBinStep) ?? 100;
  const maxPriceChangePct = finiteNumber(screeningConfig.looseLaneMaxPriceChangePct);

  let lane = "missing_volume_active_tvl";
  if (volumeActiveTvlMultiple != null) {
    if (volumeActiveTvlMultiple >= primaryFloor) lane = "primary";
    else if (volumeActiveTvlMultiple >= looseFloor) lane = "loose";
    else lane = "below_loose";
  }

  const feePct = candidateNumber(candidate, ["fee_pct", "base_fee"]);
  const feeTvlRatio = candidateNumber(candidate, ["fee_active_tvl_ratio", "fee_tvl_ratio"]);
  const binStep = candidateNumber(candidate, ["bin_step", "dlmm_params.bin_step"]);
  const priceChangePct = candidateNumber(candidate, ["price_change_pct", "change_1h"]);
  const vetoes = [];

  if (lane === "loose") {
    if (feePct == null || feePct < minFeePct) vetoes.push(`fee_pct ${feePct ?? "null"} < ${minFeePct}`);
    if (feeTvlRatio == null || feeTvlRatio < minFeeTvlRatio) {
      vetoes.push(`fee_active_tvl_ratio ${feeTvlRatio ?? "null"} < ${minFeeTvlRatio}`);
    }
    if (binStep == null || binStep < minBinStep) vetoes.push(`bin_step ${binStep ?? "null"} < ${minBinStep}`);
    if (maxPriceChangePct != null && priceChangePct != null && priceChangePct < maxPriceChangePct) {
      vetoes.push(`price_change_pct ${priceChangePct} < ${maxPriceChangePct}`);
    }
  }

  return {
    lane,
    looseLaneQualified: lane === "loose" ? vetoes.length === 0 : null,
    looseLaneVeto: vetoes.length > 0 ? vetoes.join("; ") : null,
    shadowOnly: true,
    volumeActiveTvlMultiple,
    currentHardGate,
    currentHardGatePass: currentHardGate != null && volumeActiveTvlMultiple != null
      ? volumeActiveTvlMultiple >= currentHardGate
      : null,
    primaryFloor,
    primaryPass: volumeActiveTvlMultiple != null ? volumeActiveTvlMultiple >= primaryFloor : null,
    looseFloor,
    loosePass: volumeActiveTvlMultiple != null ? volumeActiveTvlMultiple >= looseFloor : null,
    metrics: {
      volumeActiveTvlMultiple,
      currentHardGate,
      primaryFloor,
      looseFloor,
      feePct,
      feeActiveTvlRatio: feeTvlRatio,
      binStep,
      activeTvl: candidateNumber(candidate, ["active_tvl", "tvl"]),
      volumeWindow: candidateNumber(candidate, ["volume_window", "volume"]),
      feeVelocityUsdPerMin: candidateNumber(candidate, ["fee_velocity_usd_per_min"]),
      priceChangePct,
      momentumScoreV1: candidateNumber(candidate, ["momentum_score_v1", "momentum_score.primary.momentum_score_v1"]),
      momentumProfile: candidate.momentum_profile ?? candidate.momentum_score?.primary?.momentum_profile ?? null,
      momentumClassification: candidate.momentum_classification ?? candidate.momentum_score?.primary?.momentum_classification ?? null,
      momentumConfidence: candidateNumber(candidate, ["momentum_confidence", "momentum_score.primary.confidence"]),
      momentumWouldScalp: candidate.momentum_would_scalp ?? candidate.momentum_score?.would_scalp ?? null,
      momentumWouldThrottle: candidate.momentum_would_throttle ?? candidate.momentum_score?.would_throttle ?? null,
      momentumRiskFlags: candidate.momentum_risk_flags ?? candidate.momentum_score?.primary?.risk_flags ?? null,
      mcap: candidateNumber(candidate, ["mcap", "token_info.mcap"]),
      organicScore: candidateNumber(candidate, ["organic_score", "base.organic", "token_x.organic_score"]),
      tokenAgeHours: candidateNumber(candidate, ["token_age_hours", "token_info.token_age_hours"]),
    },
  };
}

export function attachTwoLaneClassification(candidate = {}, screeningConfig = {}) {
  const classification = classifyTwoLaneCandidate(candidate, screeningConfig);
  return {
    ...candidate,
    fee_lane: classification.lane,
    two_lane_classification: classification,
    loose_lane_qualified: classification.looseLaneQualified,
    loose_lane_veto: classification.looseLaneVeto,
  };
}

export function getTwoLaneClassificationLogPath(ts = new Date().toISOString(), logDir = DEFAULT_LOG_DIR) {
  return path.join(logDir, `two-lane-classification-${dateKey(ts)}.jsonl`);
}

export function appendTwoLaneClassification(candidate = {}, screeningConfig = {}, options = {}) {
  if (screeningConfig.twoLaneClassificationLoggingEnabled !== true) return null;

  try {
    const ts = options.ts ?? new Date().toISOString();
    const classification = candidate.two_lane_classification ?? classifyTwoLaneCandidate(candidate, screeningConfig);
    const row = {
      ts,
      event: "two_lane_classification",
      pool: candidate.pool ?? candidate.pool_address ?? candidate.address ?? null,
      poolName: candidate.name ?? candidate.pool_name ?? null,
      baseMint: getBaseMint(candidate),
      baseSymbol: getBaseSymbol(candidate),
      quoteSymbol: getQuoteSymbol(candidate),
      lane: classification.lane,
      looseLaneQualified: classification.looseLaneQualified,
      looseLaneVeto: classification.looseLaneVeto,
      shadowOnly: true,
      liveVetoReason: options.liveVetoReason ?? null,
      liveAccepted: options.liveAccepted ?? null,
      metrics: classification.metrics,
      config: {
        minVolumeActiveTvlMultiple: classification.currentHardGate,
        twoLanePrimaryVolumeActiveTvlMultiple: classification.primaryFloor,
        looseVolumeActiveTvlMultiple: classification.looseFloor,
        looseLaneMinFeePct: finiteNumber(screeningConfig.looseLaneMinFeePct) ?? 3,
        looseLaneMinFeeTvlRatio: finiteNumber(screeningConfig.looseLaneMinFeeTvlRatio) ?? 8,
        looseLaneMinBinStep: finiteNumber(screeningConfig.looseLaneMinBinStep) ?? 100,
        looseLaneShadowOnly: true,
      },
    };

    const logDir = options.logDir ?? process.env.MERIDIAN_TWO_LANE_CLASSIFICATION_LOG_DIR ?? DEFAULT_LOG_DIR;
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(getTwoLaneClassificationLogPath(ts, logDir), `${JSON.stringify(row)}\n`);
    return row;
  } catch (error) {
    if (options.throwOnError) throw error;
    return null;
  }
}
