import fs from "fs";
import path from "path";
import { log } from "./logger.js";

const STATE_FILE = "./autoresearch-state.json";
const LOG_DIR = "./logs";
const HISTORY_LIMIT = 30;

function defaultState() {
  return {
    version: 1,
    mode: "shadow",
    activeTrials: [],
    history: [],
    lastRefreshAt: null,
  };
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return defaultState();
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      activeTrials: Array.isArray(parsed.activeTrials) ? parsed.activeTrials : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch (error) {
    log("autoresearch_warn", `Failed to read autoresearch-state.json: ${error.message}`);
    return defaultState();
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    ...state,
    history: (state.history || []).slice(0, HISTORY_LIMIT),
  }, null, 2));
}

function appendAutoresearchEvent(type, payload = {}) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const timestamp = new Date().toISOString();
    const file = path.join(LOG_DIR, `autoresearch-${timestamp.slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify({ timestamp, type, ...payload })}\n`);
  } catch (error) {
    log("autoresearch_warn", `Failed to write autoresearch log: ${error.message}`);
  }
}

export function refreshAutoresearch(perfData = [], cfg = {}) {
  const ar = cfg.autoresearch || {};
  if (!ar.enabled || ar.mode !== "shadow") {
    return { enabled: false, mode: ar.mode || "disabled", activeTrials: [] };
  }

  const state = loadState();
  const now = new Date().toISOString();
  const environment = getEnvironmentSnapshot(cfg);
  let changed = false;

  const remainingTrials = [];
  for (const trial of state.activeTrials) {
    if (environmentChangedSince(trial.environment_snapshot, environment)) {
      const invalidated = {
        ...trial,
        status: "invalidated",
        invalidated_at: now,
        invalidation_reason: "live screening or Darwin environment changed",
      };
      state.history.unshift(invalidated);
      appendAutoresearchEvent("trial_invalidated", {
        trial_id: invalidated.id,
        knob: invalidated.knob,
        candidate_value: invalidated.candidate_value,
      });
      changed = true;
      continue;
    }
    remainingTrials.push(trial);
  }
  state.activeTrials = remainingTrials;

  const recentPerf = filterRecentPerformance(perfData, ar.lookbackDays ?? 45);
  const existingKnobs = new Set(state.activeTrials.map((trial) => trial.knob));
  const proposals = buildTrialProposals(recentPerf, cfg)
    .filter((proposal) => !existingKnobs.has(proposal.knob))
    .slice(0, Math.max(0, (ar.maxActiveTrials ?? 3) - state.activeTrials.length));

  for (const proposal of proposals) {
    const trial = {
      ...proposal,
      id: `${proposal.knob}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      mode: "shadow",
      status: "active",
      created_at: now,
      started_at_position: perfData.length,
      environment_snapshot: environment,
      last_evaluated_at: null,
      metrics: null,
    };
    state.activeTrials.push(trial);
    appendAutoresearchEvent("trial_created", {
      trial_id: trial.id,
      knob: trial.knob,
      current_value: trial.live_value,
      candidate_value: trial.candidate_value,
      rationale: trial.rationale,
    });
    changed = true;
  }

  for (const trial of state.activeTrials) {
    const metrics = evaluateTrial(trial, perfData, cfg);
    if (!deepEqual(metrics, trial.metrics)) {
      appendAutoresearchEvent("trial_evaluated", {
        trial_id: trial.id,
        knob: trial.knob,
        recommendation: metrics.recommendation,
        evaluable_closes: metrics.evaluable_closes,
        pass_closes: metrics.pass_closes,
        reject_closes: metrics.reject_closes,
        absolute_win_rate_delta_pct: metrics.absolute_win_rate_delta_pct,
        absolute_pnl_delta_pct: metrics.absolute_pnl_delta_pct,
      });
      changed = true;
    }
    trial.metrics = metrics;
    trial.last_evaluated_at = now;
  }

  if (changed || state.lastRefreshAt == null) {
    state.mode = "shadow";
    state.lastRefreshAt = now;
    state.history = state.history.slice(0, HISTORY_LIMIT);
    saveState(state);
  }

  return buildStatusObject(state, cfg);
}

export function getAutoresearchStatus(cfg = {}) {
  const ar = cfg.autoresearch || {};
  if (!ar.enabled || ar.mode !== "shadow") {
    return {
      enabled: false,
      mode: ar.mode || "disabled",
      activeTrials: [],
      history: [],
      lastRefreshAt: null,
    };
  }
  return buildStatusObject(loadState(), cfg);
}

export function formatAutoresearchStatus(cfg = {}) {
  const status = getAutoresearchStatus(cfg);
  if (!status.enabled) return "Autoresearch: disabled";

  const lines = [
    `Autoresearch: ${status.mode.toUpperCase()} MODE`,
    `Active trials: ${status.activeTrials.length}`,
    status.lastRefreshAt ? `Last refresh: ${status.lastRefreshAt}` : null,
    "",
  ].filter(Boolean);

  if (status.activeTrials.length === 0) {
    lines.push("No active shadow trials yet. Need more evaluable closes with persisted signal snapshots.");
  } else {
    for (const trial of status.activeTrials) {
      const metrics = trial.metrics || {};
      lines.push(`${trial.knob}: ${formatValue(trial.live_value)} -> ${formatValue(trial.candidate_value)} (${trial.label})`);
      lines.push(`  rationale: ${trial.rationale}`);
      lines.push(`  status: ${metrics.recommendation || "waiting"} | evaluable ${metrics.evaluable_closes ?? 0}/${status.minEvaluableCloses}`);
      lines.push(`  pass/reject: ${metrics.pass_closes ?? 0}/${metrics.reject_closes ?? 0} | unknown ${metrics.unknown_closes ?? 0}`);
      if (metrics.evaluable_closes) {
        lines.push(
          `  pass WR ${fmtPct(metrics.pass_win_rate_pct)} vs baseline ${fmtPct(metrics.baseline_win_rate_pct)} | pass avg PnL ${fmtPct(metrics.pass_avg_pnl_pct)} vs baseline ${fmtPct(metrics.baseline_avg_pnl_pct)}`
        );
      }
      if (metrics.recommendation_reason) lines.push(`  note: ${metrics.recommendation_reason}`);
      lines.push("");
    }
  }

  if (status.history.length > 0) {
    const recent = status.history.slice(0, 3).map((trial) => {
      const endedAt = trial.invalidated_at || trial.last_evaluated_at || trial.created_at || "unknown";
      return `Recent history: ${trial.knob} ${formatValue(trial.live_value)} -> ${formatValue(trial.candidate_value)} | ${trial.status} @ ${endedAt}`;
    });
    lines.push(...recent);
  }

  return lines.join("\n").trim();
}

export function getAutoresearchBriefingSummary(cfg = {}) {
  const status = getAutoresearchStatus(cfg);
  if (!status.enabled) return "Autoresearch: disabled";
  const ready = status.activeTrials.filter((trial) => trial.metrics?.recommendation === "recommend_apply").length;
  const waiting = status.activeTrials.filter((trial) => !trial.metrics || trial.metrics.recommendation === "waiting").length;
  return `🧪 Autoresearch: ${status.activeTrials.length} active shadow trial(s), ${ready} ready recommendation(s), ${waiting} waiting for evidence`;
}

function buildStatusObject(state, cfg = {}) {
  return {
    enabled: true,
    mode: "shadow",
    minEvaluableCloses: cfg.autoresearch?.minEvaluableCloses ?? 8,
    activeTrials: [...(state.activeTrials || [])]
      .sort((a, b) => recommendationPriority(b.metrics?.recommendation) - recommendationPriority(a.metrics?.recommendation)),
    history: state.history || [],
    lastRefreshAt: state.lastRefreshAt || null,
  };
}

function buildTrialProposals(perfData, cfg = {}) {
  return [
    proposeMinOrganicTrial(perfData, cfg),
    proposeMinVolumeTrial(perfData, cfg),
    proposeAthFilterTrial(perfData, cfg),
    proposeMaxTokenAgeTrial(perfData, cfg),
  ].filter(Boolean);
}

function proposeMinOrganicTrial(perfData, cfg) {
  const values = splitValues(perfData, "organic_score");
  if (!hasEnoughValues(values, 3, 3)) return null;

  const current = cfg.screening?.minOrganic ?? 60;
  const winnerAvg = mean(values.wins);
  const loserAvg = mean(values.losses);
  if (winnerAvg - loserAvg < 6) return null;

  const target = clamp(Math.round(percentileFromValues(values.wins, 0.25) - 2), current + 1, 90);
  if (target <= current) return null;

  return {
    knob: "minOrganic",
    label: "raise organic floor",
    live_value: current,
    candidate_value: target,
    rationale: `Winners average organic ${winnerAvg.toFixed(1)} vs losers ${loserAvg.toFixed(1)}. Shadow-check whether requiring >= ${target} would improve entry quality.`,
  };
}

function proposeMinVolumeTrial(perfData, cfg) {
  const values = splitValues(perfData, "volume");
  if (!hasEnoughValues(values, 3, 3)) return null;

  const current = cfg.screening?.minVolume ?? 500;
  const winnerMedian = percentileFromValues(values.wins, 0.5);
  const loserUpper = percentileFromValues(values.losses, 0.75);
  if (winnerMedian <= loserUpper * 1.1) return null;

  const target = roundVolumeThreshold(Math.max(current + 500, loserUpper * 1.1));
  if (target <= current) return null;

  return {
    knob: "minVolume",
    label: "raise volume floor",
    live_value: current,
    candidate_value: target,
    rationale: `Winner median volume is $${Math.round(winnerMedian).toLocaleString()} vs loser upper quartile $${Math.round(loserUpper).toLocaleString()}. Shadow-check whether volume >= ${target.toLocaleString()} filters weak memecoin churn.`,
  };
}

function proposeAthFilterTrial(perfData, cfg) {
  const values = splitValues(perfData, "ath_proximity");
  if (!hasEnoughValues(values, 3, 3)) return null;

  const current = cfg.screening?.athFilterPct;
  const currentThreshold = current == null ? 100 : 100 + current;
  const winnerUpper = percentileFromValues(values.wins, 0.75);
  const loserMedian = percentileFromValues(values.losses, 0.5);
  if (loserMedian <= winnerUpper + 5) return null;

  const targetThreshold = clamp(Math.round(winnerUpper), 65, 95);
  if (targetThreshold >= currentThreshold) return null;

  return {
    knob: "athFilterPct",
    label: "tighten ATH chase filter",
    live_value: current,
    candidate_value: targetThreshold - 100,
    rationale: `Losing entries cluster closer to ATH (median ${loserMedian.toFixed(1)}%) than winners (75th pct ${winnerUpper.toFixed(1)}%). Shadow-check a ${targetThreshold}% of ATH ceiling.`,
  };
}

function proposeMaxTokenAgeTrial(perfData, cfg) {
  const values = splitValues(perfData, "token_age_hours");
  if (!hasEnoughValues(values, 3, 3)) return null;

  const current = cfg.screening?.maxTokenAgeHours ?? null;
  const winnerUpper = percentileFromValues(values.wins, 0.75);
  const loserAvg = mean(values.losses);
  if (loserAvg - winnerUpper < 24) return null;

  const target = clamp(roundToMultiple(winnerUpper, 12), 12, 24 * 45);
  if (current != null && target >= current) return null;

  return {
    knob: "maxTokenAgeHours",
    label: "cap token age",
    live_value: current,
    candidate_value: target,
    rationale: `Winning positions skew younger (${winnerUpper.toFixed(0)}h 75th pct) than losing positions (${loserAvg.toFixed(0)}h avg). Shadow-check a ${target}h max age ceiling.`,
  };
}

function evaluateTrial(trial, perfData, cfg = {}) {
  const started = trial.started_at_position ?? 0;
  const trialPerf = perfData.slice(started);
  const decisions = trialPerf.map((record) => ({ record, verdict: evaluateRecordAgainstTrial(record, trial) }));
  const passRecords = decisions.filter((item) => item.verdict === "pass").map((item) => item.record);
  const rejectRecords = decisions.filter((item) => item.verdict === "reject").map((item) => item.record);
  const unknownCloses = decisions.filter((item) => item.verdict === "unknown").length;
  const evaluableRecords = [...passRecords, ...rejectRecords];

  const baseline = summarizePerformance(evaluableRecords);
  const pass = summarizePerformance(passRecords);
  const reject = summarizePerformance(rejectRecords);

  const metrics = {
    total_closes_since_start: trialPerf.length,
    evaluable_closes: evaluableRecords.length,
    unknown_closes: unknownCloses,
    pass_closes: pass.count,
    reject_closes: reject.count,
    baseline_win_rate_pct: baseline.win_rate_pct,
    baseline_avg_pnl_pct: baseline.avg_pnl_pct,
    pass_win_rate_pct: pass.win_rate_pct,
    pass_avg_pnl_pct: pass.avg_pnl_pct,
    reject_win_rate_pct: reject.win_rate_pct,
    reject_avg_pnl_pct: reject.avg_pnl_pct,
    absolute_win_rate_delta_pct: pass.count > 0 ? round2(pass.win_rate_pct - baseline.win_rate_pct) : null,
    absolute_pnl_delta_pct: pass.count > 0 ? round2(pass.avg_pnl_pct - baseline.avg_pnl_pct) : null,
    recommendation: "waiting",
    recommendation_reason: null,
  };

  const ar = cfg.autoresearch || {};
  const minEvaluable = ar.minEvaluableCloses ?? 8;
  const minRejected = ar.minRejectedCloses ?? 3;
  const minWinDelta = ar.minAbsoluteWinRateDeltaPct ?? 8;
  const minPnlDelta = ar.minAbsolutePnlDeltaPct ?? 0.75;

  if (metrics.evaluable_closes < minEvaluable) {
    metrics.recommendation_reason = `Need ${minEvaluable} evaluable closes; have ${metrics.evaluable_closes}.`;
    return metrics;
  }

  if (metrics.pass_closes === 0) {
    metrics.recommendation = "inconclusive";
    metrics.recommendation_reason = "Shadow filter would have removed every evaluable close so far.";
    return metrics;
  }

  if (metrics.reject_closes < minRejected) {
    metrics.recommendation_reason = `Need ${minRejected} rejected closes to judge the filter edge; have ${metrics.reject_closes}.`;
    return metrics;
  }

  const winDelta = metrics.absolute_win_rate_delta_pct ?? 0;
  const pnlDelta = metrics.absolute_pnl_delta_pct ?? 0;
  const rejectWorseThanPass =
    (reject.avg_pnl_pct ?? 0) <= (pass.avg_pnl_pct ?? 0)
    && (reject.win_rate_pct ?? 0) <= (pass.win_rate_pct ?? 0);

  if ((winDelta >= minWinDelta || pnlDelta >= minPnlDelta) && rejectWorseThanPass) {
    metrics.recommendation = "recommend_apply";
    metrics.recommendation_reason = `Pass subset is outperforming the baseline by ${fmtPct(winDelta)} WR and ${fmtPct(pnlDelta)} avg PnL.`;
    return metrics;
  }

  if (winDelta <= -minWinDelta || pnlDelta <= -minPnlDelta) {
    metrics.recommendation = "recommend_keep_live";
    metrics.recommendation_reason = `Shadow filter is worse than live behavior by ${fmtPct(winDelta)} WR and ${fmtPct(pnlDelta)} avg PnL.`;
    return metrics;
  }

  metrics.recommendation = "inconclusive";
  metrics.recommendation_reason = "Enough data to score the trial, but the edge is not yet decisive.";
  return metrics;
}

function evaluateRecordAgainstTrial(record, trial) {
  const value = getTrialValue(record, trial.knob);
  if (value == null) return "unknown";

  switch (trial.knob) {
    case "minOrganic":
      return value >= trial.candidate_value ? "pass" : "reject";
    case "minVolume":
      return value >= trial.candidate_value ? "pass" : "reject";
    case "athFilterPct": {
      const threshold = 100 + trial.candidate_value;
      return value <= threshold ? "pass" : "reject";
    }
    case "maxTokenAgeHours":
      return value <= trial.candidate_value ? "pass" : "reject";
    default:
      return "unknown";
  }
}

function getTrialValue(record, knob) {
  const snapshot = record?.signal_snapshot || {};
  switch (knob) {
    case "minOrganic":
      return snapshot.organic_score ?? record?.organic_score ?? null;
    case "minVolume":
      return snapshot.volume ?? null;
    case "athFilterPct":
      return snapshot.ath_proximity ?? null;
    case "maxTokenAgeHours":
      return snapshot.token_age_hours ?? null;
    default:
      return null;
  }
}

function splitValues(records, signal) {
  const result = { wins: [], losses: [] };
  for (const record of records) {
    const value = getTrialValue(record, signalToKnob(signal));
    if (value == null || !Number.isFinite(value)) continue;
    if ((record.pnl_usd ?? 0) > 0) result.wins.push(value);
    else result.losses.push(value);
  }
  return result;
}

function signalToKnob(signal) {
  switch (signal) {
    case "organic_score":
      return "minOrganic";
    case "volume":
      return "minVolume";
    case "ath_proximity":
      return "athFilterPct";
    case "token_age_hours":
      return "maxTokenAgeHours";
    default:
      return signal;
  }
}

function summarizePerformance(records) {
  if (!records.length) {
    return {
      count: 0,
      win_rate_pct: 0,
      avg_pnl_pct: 0,
    };
  }

  const wins = records.filter((record) => (record.pnl_usd ?? 0) > 0).length;
  const totalPnlPct = records.reduce((sum, record) => sum + (record.pnl_pct ?? 0), 0);
  return {
    count: records.length,
    win_rate_pct: round2((wins / records.length) * 100),
    avg_pnl_pct: round2(totalPnlPct / records.length),
  };
}

function getEnvironmentSnapshot(cfg = {}) {
  return {
    screening: {
      minOrganic: cfg.screening?.minOrganic ?? null,
      minVolume: cfg.screening?.minVolume ?? null,
      athFilterPct: cfg.screening?.athFilterPct ?? null,
      maxTokenAgeHours: cfg.screening?.maxTokenAgeHours ?? null,
      minFeeActiveTvlRatio: cfg.screening?.minFeeActiveTvlRatio ?? null,
      timeframe: cfg.screening?.timeframe ?? null,
    },
  };
}

function environmentChangedSince(before = {}, current = {}) {
  return JSON.stringify(before) !== JSON.stringify(current);
}

function filterRecentPerformance(perfData, lookbackDays) {
  if (!lookbackDays) return perfData;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookbackDays);
  const cutoffIso = cutoff.toISOString();
  return perfData.filter((record) => (record.recorded_at || record.closed_at || record.deployed_at || "") >= cutoffIso);
}

function recommendationPriority(recommendation) {
  switch (recommendation) {
    case "recommend_apply":
      return 4;
    case "inconclusive":
      return 3;
    case "recommend_keep_live":
      return 2;
    case "waiting":
    default:
      return 1;
  }
}

function percentileFromValues(values, pct) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * pct)));
  return sorted[idx];
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function hasEnoughValues(values, minWins, minLosses) {
  return values.wins.length >= minWins && values.losses.length >= minLosses;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundVolumeThreshold(value) {
  if (value < 2_000) return Math.round(value / 250) * 250;
  if (value < 10_000) return Math.round(value / 500) * 500;
  return Math.round(value / 1000) * 1000;
}

function roundToMultiple(value, step) {
  return Math.ceil(value / step) * step;
}

function formatValue(value) {
  if (value == null) return "null";
  return typeof value === "number" ? String(value) : JSON.stringify(value);
}

function fmtPct(value) {
  return `${round2(value).toFixed(2)}%`;
}

function round2(value) {
  return Math.round((value ?? 0) * 100) / 100;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
