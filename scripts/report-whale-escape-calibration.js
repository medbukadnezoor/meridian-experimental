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
  if (value == null) return null;
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
  const proximityPctRows = rows.filter((row) => asNumber(row.range_position_pct) != null);
  const timeInZoneRows = rows.filter((row) => asNumber(row.time_in_current_range_zone_minutes) != null);
  const rangeEdgeRows = rows.filter((row) => typeof row.range_edge_zone === "string" && row.range_edge_zone);
  const rollingDwellRows = rows.filter((row) => asNumber(row.rolling_lower_half_sec_60s) != null);
  const lptele2ShapeRows = rows.filter((row) => asNumber(row.quote_reserves_in_active_bin_usd) != null);
  const lptele4PressureRows = rows.filter((row) => asNumber(row.swap_sell_usd_5m) != null);
  const negativePnlRows = rows.filter((row) => asNumber(row.pnl_pct) != null && asNumber(row.pnl_pct) < 0);
  const signalNegativePnlRows = signalRows.filter((row) => asNumber(row.pnl_pct) != null && asNumber(row.pnl_pct) < 0);

  return {
    row_count: rows.length,
    non_null_lp_flow_15m_count: flowRows.length,
    non_null_lp_flow_15m_pct: pct(flowRows.length, rows.length),
    bin_distance_coverage_count: distanceRows.length,
    bin_distance_coverage_pct: pct(distanceRows.length, rows.length),
    range_position_pct_coverage_count: proximityPctRows.length,
    range_position_pct_coverage_pct: pct(proximityPctRows.length, rows.length),
    time_in_current_range_zone_count: timeInZoneRows.length,
    time_in_current_range_zone_pct: pct(timeInZoneRows.length, rows.length),
    range_edge_count: rangeEdgeRows.length,
    rolling_dwell_coverage_count: rollingDwellRows.length,
    rolling_dwell_coverage_pct: pct(rollingDwellRows.length, rows.length),
    lptele2_liquidity_shape_count: lptele2ShapeRows.length,
    lptele2_liquidity_shape_pct: pct(lptele2ShapeRows.length, rows.length),
    lptele4_swap_pressure_count: lptele4PressureRows.length,
    lptele4_swap_pressure_pct: pct(lptele4PressureRows.length, rows.length),
    whale_escape_watch_count: watchRows.length,
    whale_escape_candidate_count: candidateRows.length,
    whale_escape_signal_count: signalRows.length,
    negative_pnl_count: negativePnlRows.length,
    signal_negative_pnl_count: signalNegativePnlRows.length,
    signal_negative_pnl_pct: pct(signalNegativePnlRows.length, signalRows.length),
    data_sources: groupBy(rows, "whale_escape_data_source"),
    lptele2_data_sources: groupBy(rows, "lptele2_liquidity_shape_data_source"),
    lptele4_data_sources: groupBy(rows, "lptele4_swap_pressure_data_source"),
    range_proximity_zones: groupBy(rows, "range_proximity_zone"),
    range_edges: groupBy(rows, "range_edge_zone"),
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
      range_position_pct: row.range_position_pct ?? null,
      range_proximity_zone: row.range_proximity_zone ?? null,
      range_edge_zone: row.range_edge_zone ?? null,
      rolling_lower_half_sec_60s: row.rolling_lower_half_sec_60s ?? null,
      rolling_upper_half_sec_60s: row.rolling_upper_half_sec_60s ?? null,
      rolling_near_edge_sec_60s: row.rolling_near_edge_sec_60s ?? null,
      time_in_current_range_zone_minutes: row.time_in_current_range_zone_minutes ?? null,
      pool_lp_net_dep_usd_15m: row.pool_lp_net_dep_usd_15m ?? null,
      quote_reserves_in_active_bin_usd: row.quote_reserves_in_active_bin_usd ?? null,
      adjacent_bin_liquidity_cliff_pct: row.adjacent_bin_liquidity_cliff_pct ?? null,
      swap_sell_usd_5m: row.swap_sell_usd_5m ?? null,
      sell_buy_ratio_5m: row.sell_buy_ratio_5m ?? null,
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
  lines.push(`- Range-position pct coverage: ${summary.range_position_pct_coverage_count} (${summary.range_position_pct_coverage_pct}%)`);
  lines.push(`- Time-in-zone coverage: ${summary.time_in_current_range_zone_count} (${summary.time_in_current_range_zone_pct}%)`);
  lines.push(`- Near-edge rows: ${summary.range_edge_count}`);
  lines.push(`- Rolling dwell coverage: ${summary.rolling_dwell_coverage_count} (${summary.rolling_dwell_coverage_pct}%)`);
  lines.push(`- LPTELE-2 liquidity-shape coverage: ${summary.lptele2_liquidity_shape_count} (${summary.lptele2_liquidity_shape_pct}%)`);
  lines.push(`- LPTELE-4 swap-pressure coverage: ${summary.lptele4_swap_pressure_count} (${summary.lptele4_swap_pressure_pct}%)`);
  lines.push(`- Watch signals: ${summary.whale_escape_watch_count}`);
  lines.push(`- Candidate signals: ${summary.whale_escape_candidate_count}`);
  lines.push(`- Signal rows with negative API PnL: ${summary.signal_negative_pnl_count} (${summary.signal_negative_pnl_pct}%)`);
  lines.push("");
  lines.push("## Data Sources");
  lines.push("");
  for (const source of summary.data_sources) lines.push(`- ${source.value}: ${source.count}`);
  if (!summary.data_sources.length) lines.push("- none");
  lines.push("");
  lines.push("## LPTELE-2 Data Sources");
  lines.push("");
  for (const source of summary.lptele2_data_sources) lines.push(`- ${source.value}: ${source.count}`);
  if (!summary.lptele2_data_sources.length) lines.push("- none");
  lines.push("");
  lines.push("## LPTELE-4 Data Sources");
  lines.push("");
  for (const source of summary.lptele4_data_sources) lines.push(`- ${source.value}: ${source.count}`);
  if (!summary.lptele4_data_sources.length) lines.push("- none");
  lines.push("");
  lines.push("## Range Proximity Zones");
  lines.push("");
  for (const zone of summary.range_proximity_zones) lines.push(`- ${zone.value}: ${zone.count}`);
  if (!summary.range_proximity_zones.length) lines.push("- none");
  lines.push("");
  lines.push("## Range Edge Zones");
  lines.push("");
  for (const edge of summary.range_edges) lines.push(`- ${edge.value}: ${edge.count}`);
  if (!summary.range_edges.length) lines.push("- none");
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
    lines.push("| Time | Pair | Signal | PnL % | Zone | Edge | Lower 60s | Upper 60s | Edge 60s | Dist Lower | Net Dep 15m | Active Quote USD | Cliff % | Sell 5m | S/B 5m | Reason |");
    lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
    for (const row of summary.examples) {
      lines.push(`| ${row.timestamp} | ${row.pair || ""} | ${row.signal || ""} | ${row.pnl_pct ?? ""} | ${row.range_proximity_zone ?? ""} | ${row.range_edge_zone ?? ""} | ${row.rolling_lower_half_sec_60s ?? ""} | ${row.rolling_upper_half_sec_60s ?? ""} | ${row.rolling_near_edge_sec_60s ?? ""} | ${row.bin_distance_to_lower ?? ""} | ${row.pool_lp_net_dep_usd_15m ?? ""} | ${row.quote_reserves_in_active_bin_usd ?? ""} | ${row.adjacent_bin_liquidity_cliff_pct ?? ""} | ${row.swap_sell_usd_5m ?? ""} | ${row.sell_buy_ratio_5m ?? ""} | ${String(row.reason || "").replaceAll("|", "/")} |`);
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
