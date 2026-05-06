const DEFAULT_MATERIAL_OPTIONS = Object.freeze({
  materialWinPct: 1.0,
  materialLossPct: -1.0,
  dustNeutralAbsPct: 1.0,
  neutralCloseReasonBuckets: ["low_yield", "operator"],
  darwinUseMaterialOutcomes: true,
  darwinExcludeNeutralOutcomes: true,
});

function finiteNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function numberOption(value, fallback) {
  const num = finiteNumberOrNull(value);
  return num == null ? fallback : num;
}

function booleanOption(value, fallback) {
  return value === undefined ? fallback : Boolean(value);
}

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function pct(count, total) {
  return total > 0 ? round2((count / total) * 100) : null;
}

function average(values) {
  const finite = values.map(finiteNumberOrNull).filter((value) => value != null);
  if (finite.length === 0) return null;
  return round2(finite.reduce((sum, value) => sum + value, 0) / finite.length);
}

function normalizeBucket(bucket) {
  const normalized = String(bucket || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || null;
}

export function getMaterialOutcomeOptions(configOrOptions = {}) {
  const root = configOrOptions && typeof configOrOptions === "object" ? configOrOptions : {};
  const performance = root.performance && typeof root.performance === "object"
    ? root.performance
    : {};
  const read = (key) => performance[key] ?? root[key];

  const neutralBucketsRaw = Array.isArray(read("neutralCloseReasonBuckets"))
    ? read("neutralCloseReasonBuckets")
    : DEFAULT_MATERIAL_OPTIONS.neutralCloseReasonBuckets;
  const neutralCloseReasonBuckets = neutralBucketsRaw
    .map(normalizeBucket)
    .filter(Boolean);

  return {
    materialWinPct: numberOption(read("materialWinPct"), DEFAULT_MATERIAL_OPTIONS.materialWinPct),
    materialLossPct: numberOption(read("materialLossPct"), DEFAULT_MATERIAL_OPTIONS.materialLossPct),
    dustNeutralAbsPct: Math.abs(numberOption(read("dustNeutralAbsPct"), DEFAULT_MATERIAL_OPTIONS.dustNeutralAbsPct)),
    neutralCloseReasonBuckets,
    darwinUseMaterialOutcomes: booleanOption(read("darwinUseMaterialOutcomes"), DEFAULT_MATERIAL_OPTIONS.darwinUseMaterialOutcomes),
    darwinExcludeNeutralOutcomes: booleanOption(read("darwinExcludeNeutralOutcomes"), DEFAULT_MATERIAL_OPTIONS.darwinExcludeNeutralOutcomes),
  };
}

export function normalizeCloseReason(reason) {
  return String(reason || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[→≥≤]/g, " ")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyCloseReason(reason) {
  const text = normalizeCloseReason(reason);
  if (!text) return "other";

  if (/low\s*yield/.test(text)) return "low_yield";
  if (/early\s*dump/.test(text)) return "early_dump";
  if (/hard\s*stop\s*loss/.test(text) || /stop\s*loss/.test(text)) return "stop_loss";
  if (/pumped\s*far\s*above\s*range/.test(text)) return "pumped_far_above_range";
  if (/\boor\b/.test(text) || /out\s*of\s*range/.test(text)) return "oor";
  if (/operator/.test(text) || /manual/.test(text) || /blacklist/.test(text)) return "operator";
  if (/trailing\s*tp/.test(text) || /take\s*profit/.test(text)) return "trailing_tp";

  return "other";
}

export function classifyMaterialOutcome(record = {}, configOrOptions = {}) {
  const opts = getMaterialOutcomeOptions(configOrOptions);
  const closeReasonBucket = classifyCloseReason(record.close_reason ?? record.reason ?? record.closeReason);
  const pnlPct = finiteNumberOrNull(record.pnl_pct ?? record.pnlPct ?? record.pnl_percent);
  const pnlUsd = finiteNumberOrNull(record.pnl_usd ?? record.pnlUsd);
  const rawWin = pnlPct != null ? pnlPct > 0 : (pnlUsd != null ? pnlUsd > 0 : false);
  const lossByPnl = pnlPct != null && pnlPct <= opts.materialLossPct;
  const winByPnl = pnlPct != null && pnlPct >= opts.materialWinPct;
  const dustByPnl = pnlPct != null && Math.abs(pnlPct) < opts.dustNeutralAbsPct;

  let materialOutcome = "neutral";
  let neutralReason = "none";

  if (closeReasonBucket === "stop_loss" || closeReasonBucket === "early_dump") {
    materialOutcome = "material_loss";
  } else if (opts.neutralCloseReasonBuckets.includes(closeReasonBucket)) {
    if (lossByPnl) {
      materialOutcome = "material_loss";
    } else {
      materialOutcome = "neutral";
      neutralReason = closeReasonBucket === "low_yield" ? "low_yield" : "operator";
    }
  } else if (dustByPnl) {
    materialOutcome = "neutral";
    neutralReason = "dust";
  } else if (winByPnl) {
    materialOutcome = "material_win";
  } else if (lossByPnl) {
    materialOutcome = "material_loss";
  }

  return {
    raw_win: rawWin,
    material_outcome: materialOutcome,
    material_win: materialOutcome === "material_win",
    material_loss: materialOutcome === "material_loss",
    neutral_reason: neutralReason,
    close_reason_bucket: closeReasonBucket,
  };
}

export function summarizeMaterialPerformance(records = [], configOrOptions = {}) {
  const classified = (Array.isArray(records) ? records : []).map((record) => ({
    ...record,
    ...classifyMaterialOutcome(record, configOrOptions),
  }));

  const rawSampleCount = classified.length;
  const rawWinCount = classified.filter((record) => record.raw_win).length;
  const materialWins = classified.filter((record) => record.material_win);
  const materialLosses = classified.filter((record) => record.material_loss);
  const neutrals = classified.filter((record) => record.material_outcome === "neutral");
  const materialSampleCount = materialWins.length + materialLosses.length;
  const pnlValues = classified.map((record) => finiteNumberOrNull(record.pnl_pct)).filter((value) => value != null);

  const bucket_counts = {};
  const material_outcome_counts = { material_win: 0, material_loss: 0, neutral: 0 };
  for (const record of classified) {
    bucket_counts[record.close_reason_bucket] = (bucket_counts[record.close_reason_bucket] ?? 0) + 1;
    material_outcome_counts[record.material_outcome] = (material_outcome_counts[record.material_outcome] ?? 0) + 1;
  }

  return {
    raw_sample_count: rawSampleCount,
    material_sample_count: materialSampleCount,
    raw_win_count: rawWinCount,
    raw_loss_count: rawSampleCount - rawWinCount,
    material_win_count: materialWins.length,
    material_loss_count: materialLosses.length,
    neutral_count: neutrals.length,
    raw_win_rate_pct: pct(rawWinCount, rawSampleCount),
    win_rate_pct: pct(rawWinCount, rawSampleCount),
    material_win_rate_pct: pct(materialWins.length, rawSampleCount),
    material_loss_rate_pct: pct(materialLosses.length, rawSampleCount),
    material_decision_win_rate_pct: pct(materialWins.length, materialSampleCount),
    material_decision_loss_rate_pct: pct(materialLosses.length, materialSampleCount),
    neutral_rate_pct: pct(neutrals.length, rawSampleCount),
    low_yield_neutral_count: neutrals.filter((record) => record.neutral_reason === "low_yield").length,
    dust_neutral_count: neutrals.filter((record) => record.neutral_reason === "dust").length,
    operator_neutral_count: neutrals.filter((record) => record.neutral_reason === "operator").length,
    avg_material_win_pct: average(materialWins.map((record) => record.pnl_pct)),
    avg_material_loss_pct: average(materialLosses.map((record) => record.pnl_pct)),
    net_ev_per_record_pct: average(pnlValues),
    bucket_counts,
    material_outcome_counts,
  };
}
