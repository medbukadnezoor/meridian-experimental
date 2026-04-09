/**
 * Darwinian signal weighting system.
 *
 * Tracks which screening signals actually predict profitable positions,
 * learns the direction of those signals, and scores fresh candidates
 * against historically winning signal patterns.
 */

import fs from "fs";
import { log } from "./logger.js";

const WEIGHTS_FILE = "./signal-weights.json";
const LESSONS_FILE = "./lessons.json";
const CALIBRATION_WINDOW_DAYS = 90;
const MIN_CALIBRATION_SAMPLES = 20;

let _signalCalibrationCache = { mtimeMs: null, calibration: null };

// ─── Signal Definitions ─────────────────────────────────────────

const SIGNAL_NAMES = [
  "organic_score",
  "fee_tvl_ratio",
  "volume",
  "mcap",
  "holder_count",
  "smart_wallets_present",
  "narrative_quality",
  "study_win_rate",
  "hive_consensus",
  "volatility",
  // Extended Darwin signals — derived from already-fetched data, no new API calls needed
  "ath_proximity",
  "volume_trend",
  "change_1h",
  "candle_price_range",
  "okx_signal_present",
];

const DEFAULT_WEIGHTS = Object.fromEntries(SIGNAL_NAMES.map((signal) => [signal, 1.0]));
const DEFAULT_DIRECTIONS = {
  organic_score: "higher",
  fee_tvl_ratio: "higher",
  volume: "higher",
  mcap: "lower",
  holder_count: "higher",
  smart_wallets_present: "higher",
  narrative_quality: "higher",
  study_win_rate: "higher",
  hive_consensus: "higher",
  volatility: "lower",
  ath_proximity: "lower",
  volume_trend: "higher",
  change_1h: "higher",
  candle_price_range: "lower",
  okx_signal_present: "higher",
};

const BOOLEAN_SIGNALS = new Set(["smart_wallets_present", "okx_signal_present"]);
const CATEGORICAL_SIGNALS = new Set(["narrative_quality", "volume_trend"]);

// ─── Persistence ─────────────────────────────────────────────────

export function loadWeights() {
  if (!fs.existsSync(WEIGHTS_FILE)) {
    const initial = {
      weights: { ...DEFAULT_WEIGHTS },
      directions: { ...DEFAULT_DIRECTIONS },
      calibration: {},
      last_recalc: null,
      recalc_count: 0,
      history: [],
    };
    saveWeights(initial);
    log("signal_weights", "Created signal-weights.json with default weights");
    return initial;
  }

  try {
    const data = JSON.parse(fs.readFileSync(WEIGHTS_FILE, "utf8"));
    data.weights = { ...DEFAULT_WEIGHTS, ...(data.weights || {}) };
    data.directions = { ...DEFAULT_DIRECTIONS, ...(data.directions || {}) };
    if (!data.calibration || typeof data.calibration !== "object") data.calibration = {};
    if (!Array.isArray(data.history)) data.history = [];
    if (typeof data.recalc_count !== "number") data.recalc_count = 0;
    if (data.last_recalc === undefined) data.last_recalc = null;
    return data;
  } catch (err) {
    log("signal_weights_error", `Failed to read signal-weights.json: ${err.message}`);
    return {
      weights: { ...DEFAULT_WEIGHTS },
      directions: { ...DEFAULT_DIRECTIONS },
      calibration: {},
      last_recalc: null,
      recalc_count: 0,
      history: [],
    };
  }
}

export function saveWeights(data) {
  try {
    fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    log("signal_weights_error", `Failed to write signal-weights.json: ${err.message}`);
  }
}

// ─── Core Algorithm ──────────────────────────────────────────────

/**
 * Recalculate signal weights based on actual position performance.
 *
 * @param {Array}  perfData - Array of performance records (from lessons.json)
 * @param {Object} cfg      - Live config object (reads cfg.darwin for tuning)
 * @returns {{ changes: Array, weights: Object, directions: Object }}
 */
export function recalculateWeights(perfData, cfg = {}) {
  const darwin = cfg.darwin || {};
  const windowDays = darwin.windowDays ?? 60;
  const minSamples = darwin.minSamples ?? 10;
  const perSignalMinSamples = darwin.perSignalMinSamples ?? 12;
  const minAbsLiftToAdjust = darwin.minAbsLiftToAdjust ?? 0.05;
  const strongLiftThreshold = darwin.strongLiftThreshold ?? 0.2;
  const boostFactor = darwin.boostFactor ?? 1.05;
  const decayFactor = darwin.decayFactor ?? 0.95;
  const weightFloor = darwin.weightFloor ?? 0.3;
  const weightCeiling = darwin.weightCeiling ?? 2.5;
  const calibrationMinSamples = darwin.calibrationMinSamples ?? 20;
  const meanReversionRate = darwin.meanReversionRate ?? 0.02;

  const data = loadWeights();
  const weights = data.weights || { ...DEFAULT_WEIGHTS };
  const directions = data.directions || { ...DEFAULT_DIRECTIONS };

  for (const name of SIGNAL_NAMES) {
    if (weights[name] == null) weights[name] = 1.0;
    if (directions[name] == null) directions[name] = DEFAULT_DIRECTIONS[name] || "higher";
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const cutoffISO = cutoff.toISOString();

  const recent = perfData.filter((p) => {
    const ts = p.recorded_at || p.closed_at || p.deployed_at;
    return ts && ts >= cutoffISO;
  });

  if (recent.length < minSamples) {
    log("signal_weights", `Only ${recent.length} records in ${windowDays}d window (need ${minSamples}), skipping recalc`);
    return { changes: [], weights, directions };
  }

  const wins = recent.filter((p) => (p.pnl_usd ?? 0) > 0);
  const losses = recent.filter((p) => (p.pnl_usd ?? 0) <= 0);

  if (wins.length === 0 || losses.length === 0) {
    log("signal_weights", `Need both wins (${wins.length}) and losses (${losses.length}) to compute lift, skipping`);
    return { changes: [], weights, directions };
  }

  data.calibration = buildCalibrationStats(recent, calibrationMinSamples);

  const statsBySignal = {};
  const sampleCounts = {};
  for (const signal of SIGNAL_NAMES) {
    const stats = computeSignalStats(signal, wins, losses, perSignalMinSamples);
    sampleCounts[signal] = countSignalSamples(signal, recent);
    if (!stats) continue;
    statsBySignal[signal] = stats;
    directions[signal] = stats.direction || directions[signal] || DEFAULT_DIRECTIONS[signal] || "higher";
  }

  const ranked = Object.entries(statsBySignal)
    .map(([signal, stats]) => ({ signal, ...stats, samples: sampleCounts[signal] ?? 0 }))
    .sort((a, b) => Math.abs(b.lift) - Math.abs(a.lift));

  const adjustable = ranked.filter((item) =>
    item.samples >= perSignalMinSamples &&
    Math.abs(item.lift) >= minAbsLiftToAdjust
  );

  if (ranked.length === 0) {
    log("signal_weights", "No signals had enough samples for lift calculation");
    return { changes: [], weights, directions };
  }

  const q1End = Math.ceil(adjustable.length * 0.25);
  const q3Start = Math.floor(adjustable.length * 0.75);
  const topQuartile = new Set(adjustable.slice(0, q1End).map((item) => item.signal));
  const bottomQuartile = new Set(adjustable.slice(q3Start).map((item) => item.signal));

  const changes = [];
  for (const item of ranked) {
    const { signal, lift, direction, samples } = item;
    const prev = weights[signal];
    let next = prev;

    if (samples >= perSignalMinSamples && Math.abs(lift) >= minAbsLiftToAdjust) {
      const confidence = clamp01(Math.abs(lift) / Math.max(strongLiftThreshold, 0.001));
      if (topQuartile.has(signal)) {
        next = prev * (1 + ((boostFactor - 1) * confidence));
      } else if (bottomQuartile.has(signal)) {
        next = prev * (1 - ((1 - decayFactor) * confidence));
      }
      next += (1 - next) * meanReversionRate;
      next = clamp(next, weightFloor, weightCeiling);
      next = Math.round(next * 1000) / 1000;

      if (next !== prev) {
        const action = next > prev ? "boosted" : "decayed";
        const confidenceRounded = Math.round(confidence * 1000) / 1000;
        changes.push({
          signal,
          from: prev,
          to: next,
          lift: Math.round(lift * 1000) / 1000,
          direction,
          action,
          samples,
          confidence: confidenceRounded,
        });
        weights[signal] = next;
        log(
          "signal_weights",
          `${signal}: ${prev} -> ${next} (${action}, lift=${lift.toFixed(3)}, confidence=${confidenceRounded.toFixed(3)}, samples=${samples}, direction=${direction})`
        );
      }
    }
  }

  data.weights = weights;
  data.directions = directions;
  data.last_recalc = new Date().toISOString();
  data.recalc_count = (data.recalc_count || 0) + 1;
  if (changes.length > 0) {
    data.history.push({
      timestamp: data.last_recalc,
      changes,
      window_size: recent.length,
      win_count: wins.length,
      loss_count: losses.length,
    });
    if (data.history.length > 20) data.history = data.history.slice(-20);
  }
  saveWeights(data);

  log(
    "signal_weights",
    changes.length > 0
      ? `Recalculated: ${changes.length} weight(s) adjusted from ${recent.length} records`
      : `Recalculated: no changes needed (${recent.length} records, ${ranked.length} signals evaluated)`
  );

  return { changes, weights, directions };
}

// ─── Candidate Scoring ───────────────────────────────────────────

export function scoreSignalSnapshot(snapshot = {}, opts = {}) {
  const data = opts.weightData || loadWeights();
  const calibration = opts.calibration
    || (Object.keys(data.calibration || {}).length > 0
      ? data.calibration
      : loadSignalCalibration(opts.windowDays ?? CALIBRATION_WINDOW_DAYS));
  const weights = data.weights || {};
  const directions = data.directions || {};
  const contributions = [];

  let weightedSum = 0;
  let totalWeight = 0;

  for (const signal of SIGNAL_NAMES) {
    const value = snapshot?.[signal];
    const baseScore = getBaseSignalScore(signal, value, calibration);
    if (baseScore == null) continue;

    const weight = weights[signal] ?? 1.0;
    const direction = directions[signal] || DEFAULT_DIRECTIONS[signal] || "higher";
    const score = applyDirection(baseScore, direction);
    const contribution = score * weight;

    contributions.push({
      signal,
      value,
      weight,
      direction,
      score: Math.round(score * 1000) / 1000,
      contribution: Math.round(contribution * 1000) / 1000,
    });

    weightedSum += contribution;
    totalWeight += weight;
  }

  contributions.sort((a, b) => b.contribution - a.contribution);

  const normalizedScore = totalWeight > 0 ? weightedSum / totalWeight : 0.5;
  const topN = opts.topN ?? 4;

  return {
    score: normalizedScore,
    score_pct: Math.round(normalizedScore * 1000) / 10,
    totalWeight: Math.round(totalWeight * 1000) / 1000,
    coverage: contributions.length,
    topSignals: contributions.slice(0, topN),
    contributions,
  };
}

// ─── Lift Computation ────────────────────────────────────────────

function computeSignalStats(signal, wins, losses, minSamples) {
  if (BOOLEAN_SIGNALS.has(signal)) return computeBooleanStats(signal, wins, losses, minSamples);
  if (CATEGORICAL_SIGNALS.has(signal)) return computeCategoricalStats(signal, wins, losses, minSamples);
  return computeNumericStats(signal, wins, losses, minSamples);
}

function computeNumericStats(signal, wins, losses, minSamples) {
  const winVals = extractNumeric(signal, wins);
  const lossVals = extractNumeric(signal, losses);
  if (winVals.length + lossVals.length < minSamples) return null;
  if (winVals.length === 0 || lossVals.length === 0) return null;

  const all = [...winVals, ...lossVals];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const range = max - min;
  if (range === 0) {
    return { lift: 0, direction: DEFAULT_DIRECTIONS[signal] || "higher", winMean: 0.5, lossMean: 0.5 };
  }

  const normalize = (v) => (v - min) / range;
  const winMean = mean(winVals.map(normalize));
  const lossMean = mean(lossVals.map(normalize));
  const direction = winMean >= lossMean ? "higher" : "lower";

  return {
    lift: Math.abs(winMean - lossMean),
    direction,
    winMean,
    lossMean,
  };
}

function computeBooleanStats(signal, wins, losses, minSamples) {
  const allEntries = [...wins.map((entry) => ({ win: true, entry })), ...losses.map((entry) => ({ win: false, entry }))];
  let trueWins = 0;
  let trueTotal = 0;
  let falseWins = 0;
  let falseTotal = 0;

  for (const { win, entry } of allEntries) {
    const value = getRecordSignalValue(entry, signal);
    if (value === undefined || value === null) continue;
    if (Boolean(value)) {
      trueTotal++;
      if (win) trueWins++;
    } else {
      falseTotal++;
      if (win) falseWins++;
    }
  }

  if (trueTotal + falseTotal < minSamples) return null;
  if (trueTotal === 0 || falseTotal === 0) return null;

  const trueRate = trueWins / trueTotal;
  const falseRate = falseWins / falseTotal;
  return {
    lift: Math.abs(trueRate - falseRate),
    direction: trueRate >= falseRate ? "higher" : "lower",
    winMean: trueRate,
    lossMean: falseRate,
  };
}

function computeCategoricalStats(signal, wins, losses, minSamples) {
  const normalize = (entry) => normalizeCategorical(signal, getRecordSignalValue(entry, signal));
  const winVals = wins.map(normalize).filter((value) => value != null);
  const lossVals = losses.map(normalize).filter((value) => value != null);
  if (winVals.length + lossVals.length < minSamples) return null;
  if (winVals.length === 0 || lossVals.length === 0) return null;

  const winMean = mean(winVals);
  const lossMean = mean(lossVals);
  return {
    lift: Math.abs(winMean - lossMean),
    direction: winMean >= lossMean ? "higher" : "lower",
    winMean,
    lossMean,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────

function getRecordSignalValue(record, signal) {
  if (!record) return null;
  const snapshot = record.signal_snapshot || {};
  if (snapshot[signal] !== undefined) return snapshot[signal];

  switch (signal) {
    case "organic_score":
      return record.organic_score ?? null;
    case "fee_tvl_ratio":
      return record.fee_tvl_ratio ?? null;
    case "volatility":
      return record.volatility ?? null;
    default:
      return null;
  }
}

function extractNumeric(signal, entries) {
  const values = [];
  for (const entry of entries) {
    const value = getRecordSignalValue(entry, signal);
    if (value != null && typeof value === "number" && Number.isFinite(value)) values.push(value);
  }
  return values;
}

function countSignalSamples(signal, entries) {
  let count = 0;
  for (const entry of entries) {
    const value = getRecordSignalValue(entry, signal);
    if (value !== undefined && value !== null && value !== "") count++;
  }
  return count;
}

function buildCalibrationStats(entries, minSamples) {
  const calibration = {};
  for (const signal of SIGNAL_NAMES) {
    if (BOOLEAN_SIGNALS.has(signal) || CATEGORICAL_SIGNALS.has(signal)) continue;
    const values = extractNumeric(signal, entries).sort((a, b) => a - b);
    if (values.length < minSamples) continue;
    const low = percentile(values, 0.1);
    const high = percentile(values, 0.9);
    if (low == null || high == null || high <= low) continue;
    calibration[signal] = { low, high };
  }
  return calibration;
}

function loadSignalCalibration(windowDays = CALIBRATION_WINDOW_DAYS) {
  try {
    if (!fs.existsSync(LESSONS_FILE)) return {};
    const stat = fs.statSync(LESSONS_FILE);
    if (_signalCalibrationCache.mtimeMs === stat.mtimeMs && _signalCalibrationCache.calibration) {
      return _signalCalibrationCache.calibration;
    }

    const raw = JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
    const perfData = raw.performance || [];
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - windowDays);
    const cutoffISO = cutoff.toISOString();
    const recent = perfData.filter((record) => {
      const ts = record.recorded_at || record.closed_at || record.deployed_at;
      return ts && ts >= cutoffISO;
    });

    const calibration = buildCalibrationStats(recent, MIN_CALIBRATION_SAMPLES);
    _signalCalibrationCache = { mtimeMs: stat.mtimeMs, calibration };
    return calibration;
  } catch {
    return {};
  }
}

function percentile(sortedValues, pct) {
  if (!sortedValues.length) return null;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.floor((sortedValues.length - 1) * pct)));
  return sortedValues[idx];
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeLinear(value, min, max) {
  if (value == null || !Number.isFinite(value)) return null;
  if (max <= min) return 0.5;
  return clamp01((value - min) / (max - min));
}

function normalizeLog(value, min, max) {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  if (max <= min || min <= 0) return 0.5;
  const numerator = Math.log10(Math.max(value, min));
  const denominator = Math.log10(max) - Math.log10(min);
  if (denominator <= 0) return 0.5;
  return clamp01((numerator - Math.log10(min)) / denominator);
}

function normalizeCategorical(signal, value) {
  if (value == null) return null;
  const normalized = String(value).toLowerCase();

  if (signal === "volume_trend") {
    if (normalized === "increasing") return 1;
    if (normalized === "stable") return 0.5;
    if (normalized === "decreasing") return 0;
  }

  if (signal === "narrative_quality") {
    if (["present", "strong", "excellent", "good", "specific", "real"].includes(normalized)) return 1;
    if (["mixed", "neutral"].includes(normalized)) return 0.5;
    if (["absent", "weak", "bad", "empty", "none", "null"].includes(normalized)) return 0;
  }

  return null;
}

function getBaseSignalScore(signal, value, calibration = {}) {
  if (value == null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (BOOLEAN_SIGNALS.has(signal)) return Boolean(value) ? 1 : 0;
  if (CATEGORICAL_SIGNALS.has(signal) || typeof value === "string") return normalizeCategorical(signal, value);
  if (!Number.isFinite(value)) return null;

  const bounds = calibration?.[signal] || null;

  switch (signal) {
    case "organic_score":
    case "study_win_rate":
      return bounds ? normalizeLinear(value, bounds.low, bounds.high) : normalizeLinear(value, 0, 100);
    case "fee_tvl_ratio":
      return bounds ? normalizeLinear(value, bounds.low, bounds.high) : normalizeLinear(value, 0, 5);
    case "volume":
      return bounds
        ? normalizeLog(value, Math.max(bounds.low, 1), Math.max(bounds.high, bounds.low * 1.01))
        : normalizeLog(value, 100, 1_000_000);
    case "mcap":
      return bounds
        ? normalizeLog(value, Math.max(bounds.low, 1), Math.max(bounds.high, bounds.low * 1.01))
        : normalizeLog(value, 100_000, 100_000_000);
    case "holder_count":
      return bounds
        ? normalizeLog(value, Math.max(bounds.low, 1), Math.max(bounds.high, bounds.low * 1.01))
        : normalizeLog(value, 100, 50_000);
    case "volatility":
      return bounds ? normalizeLinear(value, bounds.low, bounds.high) : normalizeLinear(value, 0, 15);
    case "ath_proximity":
      return bounds ? normalizeLinear(value, bounds.low, bounds.high) : normalizeLinear(value, 0, 100);
    case "change_1h":
      return bounds ? normalizeLinear(value, bounds.low, bounds.high) : normalizeLinear(value, -50, 50);
    case "candle_price_range":
      return bounds ? normalizeLinear(value, bounds.low, bounds.high) : normalizeLinear(value, 0, 25);
    case "hive_consensus":
      return bounds ? normalizeLinear(value, bounds.low, bounds.high) : normalizeLinear(value, 0, 1);
    default:
      return bounds ? normalizeLinear(value, bounds.low, bounds.high) : normalizeLinear(value, 0, 1);
  }
}

function applyDirection(baseScore, direction) {
  if (baseScore == null) return null;
  return direction === "lower" ? 1 - baseScore : baseScore;
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((sum, value) => sum + value, 0) / arr.length;
}

// ─── Summary for LLM Prompt Injection ────────────────────────────

export function getWeightsSummary() {
  const data = loadWeights();
  const weights = data.weights || {};
  const directions = data.directions || {};

  const lines = ["Signal Weights (Darwinian — learned from past positions):"];
  const sorted = SIGNAL_NAMES
    .filter((signal) => weights[signal] != null)
    .sort((a, b) => (weights[b] ?? 1) - (weights[a] ?? 1));

  for (const signal of sorted) {
    const value = weights[signal] ?? 1.0;
    const label = interpretWeight(value);
    const bar = weightBar(value);
    const direction = directions[signal] || DEFAULT_DIRECTIONS[signal] || "higher";
    lines.push(`  ${signal.padEnd(24)} ${value.toFixed(2)}  ${bar}  ${label}  (${direction})`);
  }

  if (data.last_recalc) {
    lines.push(`\nLast recalculated: ${data.last_recalc} (${data.recalc_count || 0} total)`);
  } else {
    lines.push("\nWeights have not been recalculated yet (using defaults).");
  }

  return lines.join("\n");
}

function interpretWeight(value) {
  if (value >= 1.8) return "[STRONG]";
  if (value >= 1.2) return "[above avg]";
  if (value >= 0.8) return "[neutral]";
  if (value >= 0.5) return "[below avg]";
  return "[weak]";
}

function weightBar(value) {
  const filled = Math.round(((value - 0.3) / (2.5 - 0.3)) * 10);
  const clamped = Math.max(0, Math.min(10, filled));
  return "#".repeat(clamped) + ".".repeat(10 - clamped);
}
