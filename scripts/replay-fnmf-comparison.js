#!/usr/bin/env node
/**
 * Read-only FNmf threshold comparison for Scout research.
 *
 * This is not a backtester. It reads local FNmf historical LP rows plus local
 * OHLCV entry/exit analysis, applies configurable entry/exit thresholds, and
 * writes a summary artifact. It does not import runtime bot code, read .env,
 * make network calls, or touch PM2.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export const DEFAULT_PATHS = Object.freeze({
  positions: path.join(REPO_ROOT, "meridian-intelligence/reports/fnmf-historical-lp-positions.json"),
  ohlcv: path.join(REPO_ROOT, "meridian-intelligence/reports/fnmf-ohlcv-entry-exit-analysis.json"),
  output: path.join(REPO_ROOT, "meridian-intelligence/reports/fnmf-threshold-comparison-summary.json"),
});

export const DEFAULT_CONFIG = Object.freeze({
  profile: "fnmf_hot_fee_scalp_scout_research_defaults",
  notes: [
    "Scout-only research defaults derived from Planpack FNmf recommendations.",
    "These thresholds are replay/report inputs only and are not runtime bot config.",
  ],
  entry: {
    minInputNative: 10,
    minPreEntryReturn5mPct: 0,
    maxPreEntryReturn5mPct: 250,
    minEntryRsi14: 65,
    maxEntryRsi14: 95,
    minVolume15mVs60m: 1,
    minOhlcvRowsAvailable: 1,
    maxBinSpan: 120,
    requireClosed: true,
  },
  exit: {
    feeHarvestFeeToInputPctAtLeast: 0.5,
    quickAbortMaxHoldMinutes: 0.75,
    quickAbortFeeToInputPctBelow: 0.05,
    earlyAbortLossPctAtOrBelow: -5,
    earlyAbortMaxFeeToInputPct: 0.1,
    earlyAbortMinHoldMinutes: 1,
    earlyAbortMaxHoldMinutes: 2,
    hardStopLossPct: -10,
    emergencyStopLossPct: -12,
  },
});

function usage() {
  return [
    "Usage: node scripts/replay-fnmf-comparison.js [options]",
    "",
    "Options:",
    "  --positions <file>       FNmf historical LP positions JSON",
    "  --ohlcv <file>           FNmf OHLCV entry/exit analysis JSON",
    "  --config <file>          optional JSON threshold config override",
    "  --output <file>          JSON summary output path",
    "  --print                  print summary JSON to stdout after writing",
    "  --help                   show this help",
    "",
    "Safety:",
    "  Local files only. No network calls, .env reads, PM2 commands, or bot runtime imports.",
    "",
    "Default config:",
    JSON.stringify(DEFAULT_CONFIG, null, 2),
  ].join("\n");
}

function fail(message) {
  console.error(message);
  console.error("");
  console.error(usage());
  process.exitCode = 1;
}

export function parseArgs(argv) {
  const options = {
    positionsPath: DEFAULT_PATHS.positions,
    ohlcvPath: DEFAULT_PATHS.ohlcv,
    configPath: null,
    outputPath: DEFAULT_PATHS.output,
    print: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--print") {
      options.print = true;
      continue;
    }
    if (arg === "--positions" || arg === "--ohlcv" || arg === "--config" || arg === "--output") {
      const next = argv[i + 1];
      if (!next) throw new Error(`Missing value for ${arg}`);
      if (arg === "--positions") options.positionsPath = path.resolve(next);
      if (arg === "--ohlcv") options.ohlcvPath = path.resolve(next);
      if (arg === "--config") options.configPath = path.resolve(next);
      if (arg === "--output") options.outputPath = path.resolve(next);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeConfig(base, override) {
  if (!isPlainObject(override)) return { ...base };
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      merged[key] = mergeConfig(base[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function readJsonFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} file does not exist: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rounded(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function pct(numerator, denominator, digits = 2) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return rounded((numerator / denominator) * 100, digits);
}

function holdMinutes(row) {
  const hours = toFiniteNumber(row.hold_hours);
  if (hours != null) return hours * 60;
  const created = Date.parse(row.created_at);
  const closed = Date.parse(row.closed_at);
  if (Number.isFinite(created) && Number.isFinite(closed)) return (closed - created) / 60000;
  return null;
}

function pickPositionRows(payload, label) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.normalized_positions)) return payload.normalized_positions;
  if (Array.isArray(payload.positions)) return payload.positions;
  throw new Error(`${label} JSON does not contain an array, normalized_positions, or positions`);
}

function indexByPosition(rows) {
  const indexed = new Map();
  let missingPosition = 0;
  for (const row of rows) {
    if (!row || !row.position) {
      missingPosition += 1;
      continue;
    }
    indexed.set(String(row.position), row);
  }
  return { indexed, missingPosition };
}

function classifyEntry(row, entryConfig) {
  const reasons = [];
  const inputNative = toFiniteNumber(row.input_native);
  const preEntryReturn5mPct = toFiniteNumber(row.pre_entry_return_5m_pct);
  const entryRsi14 = toFiniteNumber(row.entry_rsi14);
  const volume15mVs60m = toFiniteNumber(row.entry_volume_15m_vs_60m);
  const ohlcvRowsAvailable = toFiniteNumber(row.ohlcv_rows_available);
  const binSpan = toFiniteNumber(row.bin_span);

  if (entryConfig.requireClosed && row.status && String(row.status).toLowerCase() !== "close") {
    reasons.push("not_closed");
  }
  if (inputNative == null || inputNative < entryConfig.minInputNative) reasons.push("input_below_min");
  if (preEntryReturn5mPct == null || preEntryReturn5mPct < entryConfig.minPreEntryReturn5mPct) {
    reasons.push("pre_entry_5m_below_min");
  }
  if (preEntryReturn5mPct != null && preEntryReturn5mPct > entryConfig.maxPreEntryReturn5mPct) {
    reasons.push("pre_entry_5m_above_max");
  }
  if (entryRsi14 == null || entryRsi14 < entryConfig.minEntryRsi14) reasons.push("rsi_below_min");
  if (entryRsi14 != null && entryRsi14 > entryConfig.maxEntryRsi14) reasons.push("rsi_above_max");
  if (volume15mVs60m == null || volume15mVs60m < entryConfig.minVolume15mVs60m) {
    reasons.push("volume_ratio_below_min");
  }
  if (ohlcvRowsAvailable == null || ohlcvRowsAvailable < entryConfig.minOhlcvRowsAvailable) {
    reasons.push("ohlcv_rows_below_min");
  }
  if (binSpan != null && binSpan > entryConfig.maxBinSpan) reasons.push("bin_span_above_max");

  return {
    passed: reasons.length === 0,
    reasons,
  };
}

function classifyExit(row, exitConfig) {
  const reasons = [];
  const hold = holdMinutes(row);
  const feeToInputPct = toFiniteNumber(row.fee_to_input_pct);
  const pnlPct = toFiniteNumber(row.pnl_pct_native);

  if (feeToInputPct != null && feeToInputPct >= exitConfig.feeHarvestFeeToInputPctAtLeast) {
    reasons.push("fee_harvest");
  }
  if (
    hold != null &&
    hold <= exitConfig.quickAbortMaxHoldMinutes &&
    (feeToInputPct == null || feeToInputPct < exitConfig.quickAbortFeeToInputPctBelow)
  ) {
    reasons.push("quick_no_fee_abort");
  }
  if (
    pnlPct != null &&
    pnlPct <= exitConfig.earlyAbortLossPctAtOrBelow &&
    hold != null &&
    hold >= exitConfig.earlyAbortMinHoldMinutes &&
    hold <= exitConfig.earlyAbortMaxHoldMinutes &&
    (feeToInputPct == null || feeToInputPct <= exitConfig.earlyAbortMaxFeeToInputPct)
  ) {
    reasons.push("fee_aware_early_abort");
  }
  if (pnlPct != null && pnlPct <= exitConfig.hardStopLossPct) reasons.push("hard_stop_loss");
  if (pnlPct != null && pnlPct <= exitConfig.emergencyStopLossPct) reasons.push("emergency_stop_loss");

  return {
    reasons,
    firstReason: reasons[0] || "no_threshold_match",
  };
}

function sum(rows, field) {
  return rows.reduce((total, row) => {
    const value = toFiniteNumber(row[field]);
    return value == null ? total : total + value;
  }, 0);
}

function countBy(rows, reader) {
  const counts = {};
  for (const row of rows) {
    const key = reader(row);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function topLosses(rows, limit = 10) {
  return [...rows]
    .filter((row) => toFiniteNumber(row.pnl_pct_native) != null)
    .sort((a, b) => toFiniteNumber(a.pnl_pct_native) - toFiniteNumber(b.pnl_pct_native))
    .slice(0, limit)
    .map((row) => ({
      position: row.position,
      pair: row.pair,
      pool: row.pool,
      input_native: rounded(toFiniteNumber(row.input_native), 9),
      pnl_native: rounded(toFiniteNumber(row.pnl_native), 9),
      pnl_pct_native: rounded(toFiniteNumber(row.pnl_pct_native), 6),
      fee_to_input_pct: rounded(toFiniteNumber(row.fee_to_input_pct), 6),
      hold_minutes: rounded(holdMinutes(row), 3),
      exit_class: row.exit_class || null,
      threshold_matches: row.threshold_matches,
    }));
}

export function buildComparison({ positionsPayload, ohlcvPayload, config }) {
  const positionRows = pickPositionRows(positionsPayload, "positions");
  const ohlcvRows = pickPositionRows(ohlcvPayload, "ohlcv");
  const { indexed: ohlcvByPosition, missingPosition: ohlcvRowsMissingPosition } = indexByPosition(ohlcvRows);

  const mergedRows = [];
  const dataGaps = {
    positions_without_position_id: 0,
    positions_without_ohlcv_match: 0,
    ohlcv_rows_without_position_id: ohlcvRowsMissingPosition,
    missing_entry_rsi14: 0,
    missing_pre_entry_return_5m_pct: 0,
    missing_entry_volume_15m_vs_60m: 0,
    missing_ohlcv_rows_available: 0,
    missing_pnl_pct_native: 0,
    missing_fee_to_input_pct: 0,
  };

  for (const position of positionRows) {
    if (!position?.position) {
      dataGaps.positions_without_position_id += 1;
      continue;
    }
    const ohlcv = ohlcvByPosition.get(String(position.position));
    if (!ohlcv) dataGaps.positions_without_ohlcv_match += 1;
    const merged = { ...position, ...(ohlcv || {}) };

    if (toFiniteNumber(merged.entry_rsi14) == null) dataGaps.missing_entry_rsi14 += 1;
    if (toFiniteNumber(merged.pre_entry_return_5m_pct) == null) dataGaps.missing_pre_entry_return_5m_pct += 1;
    if (toFiniteNumber(merged.entry_volume_15m_vs_60m) == null) dataGaps.missing_entry_volume_15m_vs_60m += 1;
    if (toFiniteNumber(merged.ohlcv_rows_available) == null) dataGaps.missing_ohlcv_rows_available += 1;
    if (toFiniteNumber(merged.pnl_pct_native) == null) dataGaps.missing_pnl_pct_native += 1;
    if (toFiniteNumber(merged.fee_to_input_pct) == null) dataGaps.missing_fee_to_input_pct += 1;

    const entry = classifyEntry(merged, config.entry);
    const exit = classifyExit(merged, config.exit);
    merged.entry_passed = entry.passed;
    merged.entry_reject_reasons = entry.reasons;
    merged.threshold_matches = exit.reasons;
    merged.first_threshold_match = exit.firstReason;
    mergedRows.push(merged);
  }

  const entryPassedRows = mergedRows.filter((row) => row.entry_passed);
  const entryRejectedRows = mergedRows.filter((row) => !row.entry_passed);
  const lossRows = mergedRows.filter((row) => toFiniteNumber(row.pnl_native) < 0);
  const entryPassedLossRows = entryPassedRows.filter((row) => toFiniteNumber(row.pnl_native) < 0);

  const firstThresholdCounts = countBy(mergedRows, (row) => row.first_threshold_match);
  const thresholdMatchCounts = {};
  for (const row of mergedRows) {
    for (const match of row.threshold_matches) {
      thresholdMatchCounts[match] = (thresholdMatchCounts[match] || 0) + 1;
    }
  }

  const entryRejectReasonCounts = {};
  for (const row of entryRejectedRows) {
    for (const reason of row.entry_reject_reasons) {
      entryRejectReasonCounts[reason] = (entryRejectReasonCounts[reason] || 0) + 1;
    }
  }

  const totalInputNative = sum(mergedRows, "input_native");
  const totalPnlNative = sum(mergedRows, "pnl_native");
  const entryPassedInputNative = sum(entryPassedRows, "input_native");
  const entryPassedPnlNative = sum(entryPassedRows, "pnl_native");

  return {
    generated_at_utc: new Date().toISOString(),
    mode: "read_only_threshold_comparison_not_backtest",
    safety: {
      scope: "Oracle Scout research artifacts only",
      runtime_imports: false,
      network_calls: false,
      env_reads: false,
      pm2_or_bot_commands: false,
    },
    config,
    inputs: {
      historical_positions: {
        rows: positionRows.length,
        generated_at_utc: positionsPayload.generated_at_utc || null,
        wallet: positionsPayload.wallet || null,
      },
      ohlcv_analysis: {
        rows: ohlcvRows.length,
        generated_at_utc: ohlcvPayload.generated_at_utc || ohlcvPayload.summary?.generated_at_utc || null,
        wallet: ohlcvPayload.wallet || ohlcvPayload.summary?.wallet || null,
      },
    },
    data_gaps: dataGaps,
    summary: {
      positions_compared: mergedRows.length,
      entry_passed: entryPassedRows.length,
      entry_rejected: entryRejectedRows.length,
      entry_pass_rate_pct: pct(entryPassedRows.length, mergedRows.length),
      entry_reject_reason_counts: entryRejectReasonCounts,
      exit_threshold_first_match_counts: firstThresholdCounts,
      exit_threshold_match_counts: thresholdMatchCounts,
      all_rows: {
        total_input_native: rounded(totalInputNative, 9),
        total_pnl_native: rounded(totalPnlNative, 9),
        pnl_to_input_pct: pct(totalPnlNative, totalInputNative, 6),
        losses: lossRows.length,
        loss_rate_pct: pct(lossRows.length, mergedRows.length),
      },
      entry_passed_rows: {
        total_input_native: rounded(entryPassedInputNative, 9),
        total_pnl_native: rounded(entryPassedPnlNative, 9),
        pnl_to_input_pct: pct(entryPassedPnlNative, entryPassedInputNative, 6),
        losses: entryPassedLossRows.length,
        loss_rate_pct: pct(entryPassedLossRows.length, entryPassedRows.length),
      },
      exit_class_counts: countBy(mergedRows, (row) => row.exit_class || "missing_exit_class"),
      entry_passed_exit_class_counts: countBy(entryPassedRows, (row) => row.exit_class || "missing_exit_class"),
    },
    worst_losses: {
      all_rows: topLosses(mergedRows),
      entry_passed_rows: topLosses(entryPassedRows),
    },
  };
}

export function loadConfig(configPath) {
  if (!configPath) return mergeConfig(DEFAULT_CONFIG, {});
  const override = readJsonFile(configPath, "config");
  return mergeConfig(DEFAULT_CONFIG, override);
}

export function run(options) {
  const positionsPayload = readJsonFile(options.positionsPath, "positions");
  const ohlcvPayload = readJsonFile(options.ohlcvPath, "ohlcv");
  const config = loadConfig(options.configPath);
  const comparison = buildComparison({ positionsPayload, ohlcvPayload, config });

  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(options.outputPath, `${JSON.stringify(comparison, null, 2)}\n`);

  return comparison;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else {
      const comparison = run(options);
      console.error(`Wrote ${options.outputPath}`);
      if (options.print) console.log(JSON.stringify(comparison.summary, null, 2));
    }
  } catch (error) {
    fail(error?.message || String(error));
  }
}
