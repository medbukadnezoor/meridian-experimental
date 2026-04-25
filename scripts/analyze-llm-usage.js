#!/usr/bin/env node
/**
 * Read-only LLM usage analyzer for logs/api-activity-YYYY-MM-DD.jsonl.
 */

import fs from "fs";
import path from "path";

function usage() {
  console.log("Usage: node scripts/analyze-llm-usage.js --logs <dir> [--json]");
}

function parseArgs(argv) {
  const options = { logsDir: "logs", json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--logs") {
      options.logsDir = argv[++i] || "logs";
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    usage();
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function emptyStats() {
  return {
    calls: 0,
    success: 0,
    error: 0,
    total_tokens: 0,
    latencies: [],
  };
}

function bump(map, key, row) {
  const normalized = key || "unknown";
  if (!map[normalized]) map[normalized] = emptyStats();
  const stats = map[normalized];
  stats.calls += 1;
  if (row.status === "success") stats.success += 1;
  else stats.error += 1;
  stats.total_tokens += Number(row.total_tokens ?? row.tokens ?? 0) || 0;
  if (Number.isFinite(Number(row.duration_ms))) stats.latencies.push(Number(row.duration_ms));
}

function percentile(values, pct) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[index];
}

function finalizeMap(map) {
  return Object.fromEntries(Object.entries(map).map(([key, stats]) => {
    const latencies = stats.latencies;
    return [key, {
      calls: stats.calls,
      success: stats.success,
      error: stats.error,
      total_tokens: stats.total_tokens,
      p50_latency_ms: percentile(latencies, 50),
      p95_latency_ms: percentile(latencies, 95),
    }];
  }));
}

function readRows(logsDir) {
  if (!fs.existsSync(logsDir)) return [];
  const rows = [];
  for (const name of fs.readdirSync(logsDir).sort()) {
    if (!/^api-activity-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name !== "api_activity.jsonl") continue;
    const filePath = path.join(logsDir, name);
    const text = fs.readFileSync(filePath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // Ignore partial active-writer lines.
      }
    }
  }
  return rows;
}

function dayFromTimestamp(timestamp) {
  return typeof timestamp === "string" && timestamp.length >= 10
    ? timestamp.slice(0, 10)
    : "unknown";
}

function analyze(rows) {
  const byDay = {};
  const byRole = {};
  const byModel = {};
  const routeCounts = {};
  const statusCounts = {};
  const allLatencies = [];
  let totalTokens = 0;

  for (const row of rows) {
    bump(byDay, dayFromTimestamp(row.timestamp), row);
    bump(byRole, row.agent_role ?? row.agent, row);
    bump(byModel, row.model, row);
    routeCounts[row.route_kind || "unknown"] = (routeCounts[row.route_kind || "unknown"] || 0) + 1;
    statusCounts[row.status || "unknown"] = (statusCounts[row.status || "unknown"] || 0) + 1;
    totalTokens += Number(row.total_tokens ?? row.tokens ?? 0) || 0;
    if (Number.isFinite(Number(row.duration_ms))) allLatencies.push(Number(row.duration_ms));
  }

  return {
    success: true,
    generated_at: new Date().toISOString(),
    rows: rows.length,
    calls_by_day: finalizeMap(byDay),
    calls_by_agent_role: finalizeMap(byRole),
    calls_by_model: finalizeMap(byModel),
    route_counts: routeCounts,
    status_counts: statusCounts,
    total_tokens: totalTokens,
    p50_latency_ms: percentile(allLatencies, 50),
    p95_latency_ms: percentile(allLatencies, 95),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const proof = analyze(readRows(options.logsDir));
  console.log(JSON.stringify(proof, null, 2));
}

main();
