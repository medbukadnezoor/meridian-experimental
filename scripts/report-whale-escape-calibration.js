#!/usr/bin/env node
/**
 * Read-only Whale Escape calibration report for scout active-bin oracle JSONL.
 *
 * Usage:
 *   node scripts/report-whale-escape-calibration.js --input logs/active-bin-oracle-2026-05-05.jsonl
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function parseArgs(argv) {
  const args = { input: null, output: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") args.input = argv[++i];
    else if (arg === "--output") args.output = argv[++i];
    else if (arg === "--json") args.json = true;
  }
  return args;
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readJsonl(filePath) {
  if (!existsSync(filePath)) throw new Error(`Input not found: ${filePath}`);
  const rows = [];
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`Invalid JSON at ${filePath}:${index + 1}: ${error.message}`);
    }
  }
  return rows;
}

function pct(count, total) {
  return total > 0 ? Number(((count / total) * 100).toFixed(2)) : 0;
}

function groupBy(rows, key) {
  const grouped = new Map();
  for (const row of rows) {
    const value = row[key] || "(unknown)";
    grouped.set(value, (grouped.get(value) || 0) + 1);
  }
  return [...grouped.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([value, count]) => ({ value, count }));
}

function summarize(rows) {
  const signalRows = rows.filter((row) => row.whale_escape_shadow_signal);
  const watchRows = rows.filter((row) => row.whale_escape_shadow_signal === "watch");
  const candidateRows = rows.filter((row) => row.whale_escape_shadow_signal === "candidate");
  const flowRows = rows.filter((row) => asNumber(row.pool_lp_net_dep_usd_15m) != null);
  const distanceRows = rows.filter((row) => asNumber(row.bin_distance_to_lower) != null);
  const negativePnlRows = rows.filter((row) => asNumber(row.pnl_pct) != null && asNumber(row.pnl_pct) < 0);
  const signalNegativePnlRows = signalRows.filter((row) => asNumber(row.pnl_pct) != null && asNumber(row.pnl_pct) < 0);

  return {
    row_count: rows.length,
    non_null_lp_flow_15m_count: flowRows.length,
    non_null_lp_flow_15m_pct: pct(flowRows.length, rows.length),
    bin_distance_coverage_count: distanceRows.length,
    bin_distance_coverage_pct: pct(distanceRows.length, rows.length),
    whale_escape_watch_count: watchRows.length,
    whale_escape_candidate_count: candidateRows.length,
    whale_escape_signal_count: signalRows.length,
    negative_pnl_count: negativePnlRows.length,
    signal_negative_pnl_count: signalNegativePnlRows.length,
    signal_negative_pnl_pct: pct(signalNegativePnlRows.length, signalRows.length),
    data_sources: groupBy(rows, "whale_escape_data_source"),
    signal_pairs: groupBy(signalRows, "pair"),
    signal_pools: groupBy(signalRows, "pool"),
    examples: signalRows.slice(0, 10).map((row) => ({
      timestamp: row.timestamp,
      pair: row.pair,
      pool: row.pool,
      position: row.position,
      signal: row.whale_escape_shadow_signal,
      reason: row.whale_escape_shadow_reason,
      pnl_pct: row.pnl_pct ?? null,
      range_side: row.range_side ?? null,
      bin_distance_to_lower: row.bin_distance_to_lower ?? null,
      pool_lp_net_dep_usd_15m: row.pool_lp_net_dep_usd_15m ?? null,
    })),
  };
}

function renderMarkdown(inputPath, summary) {
  const lines = [];
  lines.push("# Whale Escape Calibration");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Input: \`${inputPath}\``);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Rows: ${summary.row_count}`);
  lines.push(`- LP-flow 15m coverage: ${summary.non_null_lp_flow_15m_count} (${summary.non_null_lp_flow_15m_pct}%)`);
  lines.push(`- Bin-distance coverage: ${summary.bin_distance_coverage_count} (${summary.bin_distance_coverage_pct}%)`);
  lines.push(`- Watch signals: ${summary.whale_escape_watch_count}`);
  lines.push(`- Candidate signals: ${summary.whale_escape_candidate_count}`);
  lines.push(`- Signal rows with negative API PnL: ${summary.signal_negative_pnl_count} (${summary.signal_negative_pnl_pct}%)`);
  lines.push("");
  lines.push("## Data Sources");
  lines.push("");
  for (const source of summary.data_sources) lines.push(`- ${source.value}: ${source.count}`);
  if (!summary.data_sources.length) lines.push("- none");
  lines.push("");
  lines.push("## Signal Pairs");
  lines.push("");
  for (const pair of summary.signal_pairs) lines.push(`- ${pair.value}: ${pair.count}`);
  if (!summary.signal_pairs.length) lines.push("- none");
  lines.push("");
  lines.push("## Examples");
  lines.push("");
  if (!summary.examples.length) {
    lines.push("No Whale Escape signal rows found.");
  } else {
    lines.push("| Time | Pair | Signal | PnL % | Dist Lower | Net Dep 15m | Reason |");
    lines.push("|---|---:|---:|---:|---:|---:|---|");
    for (const row of summary.examples) {
      lines.push(`| ${row.timestamp} | ${row.pair || ""} | ${row.signal || ""} | ${row.pnl_pct ?? ""} | ${row.bin_distance_to_lower ?? ""} | ${row.pool_lp_net_dep_usd_15m ?? ""} | ${String(row.reason || "").replaceAll("|", "/")} |`);
    }
  }
  lines.push("");
  lines.push("Shadow-only report. These fields are not live-exit authority.");
  return `${lines.join("\n")}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error("Usage: node scripts/report-whale-escape-calibration.js --input <active-bin-oracle.jsonl> [--output report.md] [--json]");
    process.exit(1);
  }

  const inputPath = resolve(ROOT, args.input);
  const rows = readJsonl(inputPath);
  const summary = summarize(rows);
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const markdown = renderMarkdown(inputPath, summary);
  if (args.output) {
    writeFileSync(resolve(ROOT, args.output), markdown);
    console.log(`Wrote ${args.output}`);
  } else {
    console.log(markdown);
  }
}

main();
