#!/usr/bin/env node
/**
 * Read-only owner summary for active-bin oracle JSONL evidence.
 *
 * Usage:
 *   node scripts/analyze-active-bin-oracle.js
 *   node scripts/analyze-active-bin-oracle.js logs/active-bin-oracle-2026-04-29.jsonl
 *   node scripts/analyze-active-bin-oracle.js ../meridian-intelligence/data/vps-logs/main/logs
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, dirname, join, resolve } from "path";

const DEFAULT_PATTERN = "logs/active-bin-oracle-*.jsonl";
const SIGNAL_RANK = {
  rug_like_extreme: 3,
  watch: 2,
  none: 1,
};

function globToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function resolveInputs(args) {
  const inputs = args.length ? args : [DEFAULT_PATTERN];
  const files = [];
  const missing = [];

  for (const input of inputs) {
    const absolute = resolve(input);
    if (input.includes("*")) {
      const dir = resolve(dirname(input));
      const pattern = globToRegex(basename(input));
      if (!existsSync(dir)) {
        missing.push(input);
        continue;
      }
      for (const entry of readdirSync(dir)) {
        const file = join(dir, entry);
        if (pattern.test(entry) && statSync(file).isFile()) files.push(file);
      }
      continue;
    }

    if (!existsSync(absolute)) {
      missing.push(input);
      continue;
    }

    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolute)) {
        if (/^active-bin-oracle-\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry)) {
          files.push(join(absolute, entry));
        }
      }
    } else {
      files.push(absolute);
    }
  }

  return {
    files: [...new Set(files)].sort(),
    missing,
    usedDefault: args.length === 0,
  };
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function updateMax(current, value, row, field) {
  const number = asNumber(value);
  if (number == null) return current;
  const abs = Math.abs(number);
  if (!current || abs > current.abs) {
    return {
      abs,
      value: number,
      field,
      timestamp: row.timestamp || null,
      pool: row.pool || null,
      position: row.position || null,
      pair: row.pair || null,
    };
  }
  return current;
}

function compactRow(row) {
  return {
    timestamp: row.timestamp || null,
    pair: row.pair || null,
    pool: row.pool || null,
    position: row.position || null,
    active_bin: row.active_bin ?? null,
    prior_active_bin: row.prior_active_bin ?? null,
    bin_delta: row.bin_delta ?? null,
    bin_velocity: row.bin_velocity ?? null,
    velocity_10s_bin_delta: row.velocity_10s_bin_delta ?? null,
    velocity_30s_bin_delta: row.velocity_30s_bin_delta ?? null,
    signal: row.shadow_velocity_signal || row.velocity_signal || "none",
    reason: row.shadow_velocity_reason || row.velocity_reason || row.would_close_reason || null,
    in_range: row.in_range ?? null,
    pnl_pct: row.pnl_pct ?? null,
    pnl_pct_derived: row.pnl_pct_derived ?? null,
  };
}

function scoreAlert(row) {
  const signal = row.shadow_velocity_signal || row.velocity_signal || "none";
  const signalRank = SIGNAL_RANK[signal] || 0;
  const movement = Math.max(
    Math.abs(asNumber(row.velocity_30s_bin_delta) || 0),
    Math.abs(asNumber(row.velocity_10s_bin_delta) || 0),
    Math.abs(asNumber(row.bin_delta) || 0),
    Math.abs(asNumber(row.bin_velocity) || 0),
  );
  const oorBoost = row.in_range === false ? 0.5 : 0;
  return signalRank * 1_000_000 + movement + oorBoost;
}

function analyzeFiles(files) {
  const summary = {
    files,
    rows: 0,
    malformedRows: 0,
    pools: new Set(),
    positions: new Set(),
    signalCounts: new Map(),
    oorRows: 0,
    inRangeRows: 0,
    unknownRangeRows: 0,
    maxInstantaneousVelocity: null,
    max10sVelocity: null,
    max30sVelocity: null,
    max10sDelta: null,
    max30sDelta: null,
    alerts: [],
  };

  for (const file of files) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        summary.malformedRows += 1;
        continue;
      }

      summary.rows += 1;
      if (row.pool) summary.pools.add(row.pool);
      if (row.position) summary.positions.add(row.position);
      const signal = row.shadow_velocity_signal || row.velocity_signal || "none";
      summary.signalCounts.set(signal, (summary.signalCounts.get(signal) || 0) + 1);

      if (row.in_range === false) summary.oorRows += 1;
      else if (row.in_range === true) summary.inRangeRows += 1;
      else summary.unknownRangeRows += 1;

      summary.maxInstantaneousVelocity = updateMax(summary.maxInstantaneousVelocity, row.bin_velocity, row, "bin_velocity");
      summary.max10sVelocity = updateMax(summary.max10sVelocity, row.velocity_10s_bins_per_sec, row, "velocity_10s_bins_per_sec");
      summary.max30sVelocity = updateMax(summary.max30sVelocity, row.velocity_30s_bins_per_sec, row, "velocity_30s_bins_per_sec");
      summary.max10sDelta = updateMax(summary.max10sDelta, row.velocity_10s_bin_delta, row, "velocity_10s_bin_delta");
      summary.max30sDelta = updateMax(summary.max30sDelta, row.velocity_30s_bin_delta, row, "velocity_30s_bin_delta");

      if (signal !== "none" || row.in_range === false || asNumber(row.bin_velocity) != null) {
        summary.alerts.push(row);
      }
    }
  }

  summary.alerts = summary.alerts
    .sort((a, b) => scoreAlert(b) - scoreAlert(a))
    .slice(0, 10)
    .map(compactRow);

  return summary;
}

function formatMax(max) {
  if (!max) return "n/a";
  const label = max.pair || (max.pool ? `${max.pool.slice(0, 8)}...` : "unknown");
  return `${max.value} (${max.field}, ${label}, ${max.timestamp || "no timestamp"})`;
}

function printSummary(summary) {
  console.log("Active-Bin Oracle Evidence Summary");
  console.log("==================================");
  console.log(`Files: ${summary.files.length}`);
  for (const file of summary.files) console.log(`- ${file}`);
  console.log("");
  console.log(`Rows: ${summary.rows}`);
  console.log(`Malformed rows skipped: ${summary.malformedRows}`);
  console.log(`Pools: ${summary.pools.size}`);
  console.log(`Positions: ${summary.positions.size}`);
  console.log(`In-range rows: ${summary.inRangeRows}`);
  console.log(`Out-of-range rows: ${summary.oorRows}`);
  console.log(`Unknown-range rows: ${summary.unknownRangeRows}`);
  console.log("");
  console.log("Velocity signals:");
  for (const [signal, count] of [...summary.signalCounts.entries()].sort()) {
    console.log(`- ${signal}: ${count}`);
  }
  console.log("");
  console.log(`Max instantaneous velocity: ${formatMax(summary.maxInstantaneousVelocity)}`);
  console.log(`Max 10s velocity: ${formatMax(summary.max10sVelocity)}`);
  console.log(`Max 30s velocity: ${formatMax(summary.max30sVelocity)}`);
  console.log(`Max 10s delta: ${formatMax(summary.max10sDelta)}`);
  console.log(`Max 30s delta: ${formatMax(summary.max30sDelta)}`);
  console.log("");
  console.log("Top shadow alerts / movement samples:");
  if (!summary.alerts.length) {
    console.log("- none");
  } else {
    for (const row of summary.alerts) console.log(`- ${JSON.stringify(row)}`);
  }
}

const args = process.argv.slice(2);
const { files, missing, usedDefault } = resolveInputs(args);

if (!files.length) {
  const message = usedDefault
    ? `No active-bin oracle JSONL files found at default pattern ${DEFAULT_PATTERN}.`
    : `No active-bin oracle JSONL files found for: ${[...args, ...missing].join(", ")}`;
  console.log(message);
  process.exit(usedDefault ? 0 : 1);
}

if (missing.length) {
  console.error(`Warning: skipped missing input(s): ${missing.join(", ")}`);
}

printSummary(analyzeFiles(files));
