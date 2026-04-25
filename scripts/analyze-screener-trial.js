#!/usr/bin/env node
/**
 * Read-only analyzer for the nanocap SCREENER model trial.
 *
 * Safe by design: reads local logs only. It does not import trading tools, call
 * network APIs, deploy, close, restart, or edit config.
 */

import fs from "fs";
import path from "path";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { classifyMaterialOutcome, summarizeMaterialPerformance } from "../performance-metrics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DEFAULT_LOG_DIR = join(ROOT, "logs");
const API_LOG_RE = /^api-activity-\d{4}-\d{2}-\d{2}\.jsonl$|^api_activity\.jsonl$/;
const ACTION_LOG_RE = /^actions-\d{4}-\d{2}-\d{2}\.jsonl$/;
const AGENT_LOG_RE = /^agent-\d{4}-\d{2}-\d{2}\.log$/;
const SNAPSHOT_LOG_RE = /^pnl-snapshots-\d{4}-\d{2}-\d{2}\.jsonl$/;
const TRIAL_MODEL = "gpt-5.5";

function usage() {
  console.error("Usage: node scripts/analyze-screener-trial.js [--hours 48] [--logs <dir>] [--json]");
}

function parseArgs(argv) {
  const options = {
    hours: 48,
    logsDir: DEFAULT_LOG_DIR,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--hours") {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) throw new Error("--hours must be a positive number");
      options.hours = value;
      continue;
    }
    if (arg === "--logs") {
      const next = argv[++i];
      if (!next) throw new Error("--logs requires a path");
      options.logsDir = resolve(next);
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

function listFiles(logsDir, re) {
  if (!fs.existsSync(logsDir)) return [];
  return fs.readdirSync(logsDir)
    .filter((name) => re.test(name))
    .sort()
    .map((name) => path.join(logsDir, name));
}

function parseJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function readJsonl(files) {
  const rows = [];
  for (const file of files) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parsed = parseJson(line, null);
      if (parsed && typeof parsed === "object") rows.push({ ...parsed, _file: file });
    }
  }
  return rows;
}

function readAgentEvents(files) {
  const events = [];
  for (const file of files) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const match = line.match(/^\[([^\]]+)\]\s+\[([^\]]+)\]\s+(.*)$/);
      if (!match) continue;
      events.push({
        timestamp: match[1],
        category: match[2].toLowerCase(),
        message: match[3],
        _file: file,
      });
    }
  }
  return events;
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function round4(value) {
  return Number.isFinite(value) ? Math.round(value * 10_000) / 10_000 : null;
}

function round6(value) {
  return Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : null;
}

function timestampMs(row) {
  const ms = Date.parse(row?.timestamp || row?.ts || "");
  return Number.isFinite(ms) ? ms : null;
}

function inWindow(row, sinceMs, untilMs) {
  const ms = timestampMs(row);
  return ms != null && ms >= sinceMs && ms <= untilMs;
}

function percentile(values, pct) {
  const finite = values.map(toNumber).filter((value) => value != null).sort((a, b) => a - b);
  if (!finite.length) return null;
  const index = Math.min(finite.length - 1, Math.max(0, Math.ceil((pct / 100) * finite.length) - 1));
  return finite[index];
}

function parseResult(result) {
  if (result && typeof result === "object") return result;
  if (typeof result !== "string") return {};
  const parsed = parseJson(result, null);
  return parsed && typeof parsed === "object" ? parsed : {};
}

function compactError(value) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 220) : "unknown";
}

function emptyCallStats() {
  return {
    calls: 0,
    success: 0,
    error: 0,
    fallback_calls: 0,
    timeout_errors: 0,
    total_tokens: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    latencies: [],
  };
}

function bumpCallStats(map, key, row) {
  const normalizedKey = key || "unknown";
  if (!map[normalizedKey]) map[normalizedKey] = emptyCallStats();
  const stats = map[normalizedKey];
  const status = String(row.status || "").toLowerCase();
  stats.calls += 1;
  if (status === "success") stats.success += 1;
  else stats.error += 1;
  if (row.route_kind === "fallback") stats.fallback_calls += 1;
  if (/timeout|timed out|etimedout|aborted/i.test(String(row.error || ""))) stats.timeout_errors += 1;
  stats.total_tokens += toNumber(row.total_tokens ?? row.tokens) ?? 0;
  stats.prompt_tokens += toNumber(row.prompt_tokens) ?? 0;
  stats.completion_tokens += toNumber(row.completion_tokens) ?? 0;
  const duration = toNumber(row.duration_ms);
  if (duration != null) stats.latencies.push(duration);
}

function finalizeCallStats(stats) {
  const calls = stats.calls;
  return {
    calls,
    success: stats.success,
    error: stats.error,
    fallback_calls: stats.fallback_calls,
    timeout_errors: stats.timeout_errors,
    error_rate_pct: calls ? round2((stats.error / calls) * 100) : null,
    fallback_rate_pct: calls ? round2((stats.fallback_calls / calls) * 100) : null,
    timeout_rate_pct: calls ? round2((stats.timeout_errors / calls) * 100) : null,
    total_tokens: stats.total_tokens,
    prompt_tokens: stats.prompt_tokens,
    completion_tokens: stats.completion_tokens,
    p50_latency_ms: percentile(stats.latencies, 50),
    p95_latency_ms: percentile(stats.latencies, 95),
  };
}

function finalizeCallMap(map) {
  return Object.fromEntries(Object.entries(map).map(([key, stats]) => [key, finalizeCallStats(stats)]));
}

function summarizeLlm(apiRows, agentEvents) {
  const screenerRows = apiRows.filter((row) => String(row.agent_role || row.agent || "").toUpperCase() === "SCREENER");
  const byModelRoute = {};
  const byModel = {};
  const byRoute = {};
  const errorReasons = {};

  for (const row of screenerRows) {
    const model = row.model || "unknown";
    const route = row.route_kind || "unknown";
    bumpCallStats(byModelRoute, `${model}|${route}`, row);
    bumpCallStats(byModel, model, row);
    bumpCallStats(byRoute, route, row);
    if (row.status !== "success") {
      const reason = compactError(row.error);
      errorReasons[reason] = (errorReasons[reason] ?? 0) + 1;
    }
  }

  const repairedJsonArgs = agentEvents.filter((event) => /Repaired malformed JSON args/i.test(event.message)).length;
  const unrepairedJsonArgs = agentEvents.filter((event) => /Could not repair JSON args|Failed to parse args/i.test(event.message)).length;
  const noToolFinalRejects = agentEvents.filter((event) => /Rejected no-tool final answer/i.test(event.message)).length;

  return {
    screener_calls: screenerRows.length,
    calls_by_model_route: finalizeCallMap(byModelRoute),
    calls_by_model: finalizeCallMap(byModel),
    calls_by_route: finalizeCallMap(byRoute),
    gpt55_primary: finalizeCallStats(byModelRoute[`${TRIAL_MODEL}|primary`] || emptyCallStats()),
    error_reasons: errorReasons,
    json_tool_validity: {
      repaired_malformed_json_args: repairedJsonArgs,
      unrepaired_or_parse_failed_args: unrepairedJsonArgs,
      no_tool_final_rejects: noToolFinalRejects,
      measured_from_agent_log_markers: true,
    },
    fallback_inference: "fallback rate is inferred from api-activity route_kind=fallback rows; provider-internal fallback before response is only visible if logged as route_kind/status.",
  };
}

function extractJsonAfterMarker(message, marker) {
  const index = message.indexOf(marker);
  if (index < 0) return null;
  const jsonText = message.slice(index + marker.length).trim();
  return parseJson(jsonText, null);
}

function summarizeRangeAudits(agentEvents) {
  const raw = [];
  const normalized = [];
  const narrowRejects = [];

  for (const event of agentEvents) {
    if (event.category === "deploy_audit" && event.message.includes("[range-raw]")) {
      raw.push({ timestamp: event.timestamp, ...extractJsonAfterMarker(event.message, "[range-raw]") });
    }
    if (event.category === "deploy_audit" && event.message.includes("[range-normalized]")) {
      normalized.push({ timestamp: event.timestamp, ...extractJsonAfterMarker(event.message, "[range-normalized]") });
    }
    if (event.category === "deploy_reject" && event.message.includes("[narrow-range-guard]")) {
      const detailsStart = event.message.indexOf("{");
      narrowRejects.push({
        timestamp: event.timestamp,
        reason: event.message.slice("[narrow-range-guard]".length, detailsStart > 0 ? detailsStart : undefined).trim(),
        details: detailsStart > 0 ? parseJson(event.message.slice(detailsStart), {}) : {},
      });
    }
  }

  return {
    raw_count: raw.length,
    normalized_count: normalized.length,
    raw_normalized_pair_count: Math.min(raw.length, normalized.length),
    narrow_range_reject_count: narrowRejects.length,
    latest_raw: raw.at(-1) || null,
    latest_normalized: normalized.at(-1) || null,
    narrow_range_rejects: narrowRejects.slice(-20),
  };
}

function deploySummaryFromRow(row) {
  const result = parseResult(row.result);
  const amountSol = toNumber(row.args?.amount_y ?? row.args?.amount_sol ?? result.amount_y ?? result.amount_sol);
  const binRange = result.bin_range || {};
  const rangeCoverage = result.range_coverage || {};
  const binsBelow = toNumber(row.args?.bins_below ?? binRange.bins_below);
  const binsAbove = toNumber(row.args?.bins_above ?? binRange.bins_above);
  const widthBins = toNumber(binRange.max) != null && toNumber(binRange.min) != null
    ? toNumber(binRange.max) - toNumber(binRange.min)
    : (binsBelow != null && binsAbove != null ? binsBelow + binsAbove : null);
  return {
    timestamp: row.timestamp ?? null,
    position: result.position ?? null,
    pool: result.pool ?? row.args?.pool_address ?? null,
    pool_name: result.pool_name ?? row.args?.pool_name ?? null,
    model_visible_in_action_log: false,
    amount_sol: amountSol,
    strategy: result.strategy ?? row.args?.strategy ?? null,
    bin_range: result.bin_range ?? null,
    bins_below: binsBelow,
    bins_above: binsAbove,
    width_bins: widthBins,
    range_coverage: {
      downside_pct: round4(toNumber(rangeCoverage.downside_pct)),
      upside_pct: round4(toNumber(rangeCoverage.upside_pct)),
      width_pct: round4(toNumber(rangeCoverage.width_pct)),
    },
    pnl_seed_usd: toNumber(row.args?.initial_value_usd),
  };
}

function summarizeDeploys(actionRows, agentEvents) {
  const deployRows = actionRows.filter((row) => row.tool === "deploy_position");
  const deploySuccessRows = deployRows.filter((row) => row.success === true && parseResult(row.result).success !== false);
  const deployRejectRows = deployRows.filter((row) => row.success !== true || parseResult(row.result).success === false);
  const safetyBlocks = agentEvents.filter((event) =>
    event.category === "safety_block" && /deploy_position blocked/i.test(event.message)
  );
  const rejectReasons = {};

  for (const row of deployRejectRows) {
    const result = parseResult(row.result);
    const reason = compactError(row.error ?? result.error ?? result.reason ?? "deploy_position success:false");
    rejectReasons[reason] = (rejectReasons[reason] ?? 0) + 1;
  }
  for (const event of safetyBlocks) {
    const reason = compactError(event.message.replace(/^deploy_position blocked:\s*/i, ""));
    rejectReasons[reason] = (rejectReasons[reason] ?? 0) + 1;
  }

  return {
    attempts_logged_in_actions: deployRows.length,
    successes: deploySuccessRows.length,
    action_rejects_or_errors: deployRejectRows.length,
    safety_blocks_from_agent_log: safetyBlocks.length,
    reject_reason_counts: rejectReasons,
    successful_deploys: deploySuccessRows.map(deploySummaryFromRow),
  };
}

function buildDeployMap(allActionRows, windowedDeploys) {
  const deploys = new Map();
  const windowPositions = new Set();

  for (const row of allActionRows) {
    if (row.tool !== "deploy_position" || row.success !== true) continue;
    const result = parseResult(row.result);
    if (result.success === false || !result.position) continue;
    const summary = deploySummaryFromRow(row);
    deploys.set(result.position, summary);
  }

  for (const deploy of windowedDeploys.successful_deploys) {
    if (deploy.position) windowPositions.add(deploy.position);
  }

  return { deploys, windowPositions };
}

function summarizeSnapshots(snapshotRows) {
  const byPosition = new Map();
  for (const row of snapshotRows) {
    if (row.event !== "pnl_snapshot" || !row.position) continue;
    if (!byPosition.has(row.position)) byPosition.set(row.position, []);
    byPosition.get(row.position).push(row);
  }

  const summaries = new Map();
  for (const [position, rows] of byPosition.entries()) {
    const sorted = rows
      .map((row) => ({ ...row, pnlPct: toNumber(row.pnlPct ?? row.pnl_pct) }))
      .filter((row) => row.pnlPct != null)
      .sort((a, b) => String(a.ts || a.timestamp).localeCompare(String(b.ts || b.timestamp)));
    if (!sorted.length) continue;
    const pnlValues = sorted.map((row) => row.pnlPct);
    const latest = sorted.at(-1);
    summaries.set(position, {
      position,
      snapshot_count: sorted.length,
      first_ts: sorted[0].ts ?? sorted[0].timestamp ?? null,
      latest_ts: latest.ts ?? latest.timestamp ?? null,
      latest_pnl_pct: round4(latest.pnlPct),
      min_pnl_pct: round4(Math.min(...pnlValues)),
      peak_pnl_pct: round4(Math.max(...pnlValues)),
    });
  }
  return summaries;
}

function summarizeRealizedQuality(allActionRows, windowPositions, deploys, snapshotSummaries) {
  const records = [];
  const closedPositions = new Set();

  for (const row of allActionRows) {
    if (row.tool !== "close_position") continue;
    const result = parseResult(row.result);
    if (row.success !== true || result.success === false) continue;
    const position = row.args?.position_address ?? result.position ?? null;
    if (!position || !windowPositions.has(position)) continue;
    closedPositions.add(position);
    const deploy = deploys.get(position) || {};
    const pnlPct = toNumber(result.pnl_pct ?? result.pnlPct);
    const amountSol = toNumber(deploy.amount_sol);
    const estimatedSolPnl = amountSol != null && pnlPct != null ? (amountSol * pnlPct) / 100 : null;
    const record = {
      timestamp: row.timestamp ?? null,
      opened_at: deploy.timestamp ?? null,
      position,
      pool: result.pool ?? deploy.pool ?? null,
      pool_name: result.pool_name ?? deploy.pool_name ?? null,
      close_reason: row.args?.reason ?? result.reason ?? "unknown",
      pnl_pct: round4(pnlPct),
      pnl_usd: toNumber(result.pnl_usd),
      estimated_sol_pnl: round6(estimatedSolPnl),
      amount_sol: amountSol,
      range: {
        bin_range: deploy.bin_range ?? null,
        bins_below: deploy.bins_below ?? null,
        bins_above: deploy.bins_above ?? null,
        width_bins: deploy.width_bins ?? null,
        range_coverage: deploy.range_coverage ?? null,
      },
      snapshots: snapshotSummaries.get(position) ?? null,
    };
    records.push({ ...record, ...classifyMaterialOutcome(record) });
  }

  const openPositions = [...windowPositions]
    .filter((position) => !closedPositions.has(position))
    .map((position) => {
      const deploy = deploys.get(position) || {};
      return {
        position,
        opened_at: deploy.timestamp ?? null,
        pool: deploy.pool ?? null,
        pool_name: deploy.pool_name ?? null,
        amount_sol: deploy.amount_sol ?? null,
        range: {
          bin_range: deploy.bin_range ?? null,
          bins_below: deploy.bins_below ?? null,
          bins_above: deploy.bins_above ?? null,
          width_bins: deploy.width_bins ?? null,
          range_coverage: deploy.range_coverage ?? null,
        },
        snapshots: snapshotSummaries.get(position) ?? null,
      };
    });

  const materialSummary = summarizeMaterialPerformance(records);
  const closeReasonBuckets = {};
  for (const record of records) {
    closeReasonBuckets[record.close_reason_bucket] = (closeReasonBuckets[record.close_reason_bucket] ?? 0) + 1;
  }

  return {
    closed_positions_opened_in_window: records.length,
    material_summary: materialSummary,
    close_reason_buckets: closeReasonBuckets,
    realized_positions: records,
    current_open_trial_positions: openPositions,
  };
}

function buildReport({ logsDir, hours, apiRows, actionRows, agentEvents, snapshotRows, files }) {
  const untilMs = Date.now();
  const sinceMs = untilMs - hours * 60 * 60 * 1000;
  const windowedApiRows = apiRows.filter((row) => inWindow(row, sinceMs, untilMs));
  const windowedActionRows = actionRows.filter((row) => inWindow(row, sinceMs, untilMs));
  const windowedAgentEvents = agentEvents.filter((row) => inWindow(row, sinceMs, untilMs));
  const windowedSnapshotRows = snapshotRows.filter((row) => inWindow(row, sinceMs, untilMs));
  const deploys = summarizeDeploys(windowedActionRows, windowedAgentEvents);
  const { deploys: deployMap, windowPositions } = buildDeployMap(actionRows, deploys);
  const snapshotSummaries = summarizeSnapshots(snapshotRows);
  const quality = summarizeRealizedQuality(actionRows, windowPositions, deployMap, snapshotSummaries);
  const rangeAudits = summarizeRangeAudits(windowedAgentEvents);

  return {
    success: true,
    generated_at: new Date().toISOString(),
    trial_model: TRIAL_MODEL,
    window: {
      hours,
      since: new Date(sinceMs).toISOString(),
      until: new Date(untilMs).toISOString(),
      logs_dir: logsDir,
    },
    files: {
      api_activity: files.api.length,
      actions: files.actions.length,
      agent: files.agent.length,
      pnl_snapshots: files.snapshots.length,
    },
    rows: {
      api_activity_total: apiRows.length,
      api_activity_in_window: windowedApiRows.length,
      actions_total: actionRows.length,
      actions_in_window: windowedActionRows.length,
      agent_events_total: agentEvents.length,
      agent_events_in_window: windowedAgentEvents.length,
      pnl_snapshots_total: snapshotRows.length,
      pnl_snapshots_in_window: windowedSnapshotRows.length,
    },
    llm: summarizeLlm(windowedApiRows, windowedAgentEvents),
    deploys,
    deploy_audits: rangeAudits,
    realized_position_quality: quality,
    measurement_limitations: [
      "Action logs do not store the model that initiated each tool call; this report attributes deploy quality to the trial window, not to a per-action model field.",
      "Fallback rate is inferred from api-activity route_kind/status rows; provider-internal retries are only counted if the runtime emitted rows for them.",
      "JSON/tool-call validity is inferred from agent log repair/reject markers; fully valid tool calls leave no per-call validity marker.",
      "Raw/normalized deploy range audit counts come from structured JSON embedded in agent log lines, not standalone JSONL rows.",
      "Current open trial positions are inferred from deploy rows without matching close rows in the supplied local logs; this script does not query chain or PM2 state.",
    ],
    safe_read_only_markers: {
      deploys_or_closes_positions: false,
      restarts_processes: false,
      changes_config: false,
      network_calls: false,
      reads_local_files_only: true,
    },
  };
}

function printText(report) {
  console.log("\n-- Nanocap SCREENER Trial Analysis -----------------------------\n");
  console.log(`Window: ${report.window.hours}h (${report.window.since} to ${report.window.until})`);
  console.log(`Logs: ${report.window.logs_dir}`);
  console.log("");
  console.log(`SCREENER calls: ${report.llm.screener_calls}`);
  console.log(`GPT-5.5 primary: ${report.llm.gpt55_primary.calls} calls | p50 ${report.llm.gpt55_primary.p50_latency_ms ?? "n/a"}ms | p95 ${report.llm.gpt55_primary.p95_latency_ms ?? "n/a"}ms | errors ${report.llm.gpt55_primary.error_rate_pct ?? "n/a"}%`);
  console.log(`Deploys: ${report.deploys.successes} success | ${report.deploys.action_rejects_or_errors} action rejects/errors | ${report.deploys.safety_blocks_from_agent_log} safety blocks`);
  console.log(`Range audits: raw ${report.deploy_audits.raw_count} | normalized ${report.deploy_audits.normalized_count} | narrow rejects ${report.deploy_audits.narrow_range_reject_count}`);
  console.log(`Closed trial positions: ${report.realized_position_quality.closed_positions_opened_in_window}`);
  console.log(`Open trial positions: ${report.realized_position_quality.current_open_trial_positions.length}`);
  console.log("");
  console.log("Measurement limitations:");
  for (const item of report.measurement_limitations) console.log(`  - ${item}`);
  console.log("");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = {
    api: listFiles(options.logsDir, API_LOG_RE),
    actions: listFiles(options.logsDir, ACTION_LOG_RE),
    agent: listFiles(options.logsDir, AGENT_LOG_RE),
    snapshots: listFiles(options.logsDir, SNAPSHOT_LOG_RE),
  };
  const report = buildReport({
    logsDir: options.logsDir,
    hours: options.hours,
    apiRows: readJsonl(files.api),
    actionRows: readJsonl(files.actions),
    agentEvents: readAgentEvents(files.agent),
    snapshotRows: readJsonl(files.snapshots),
    files,
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printText(report);
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ success: false, error: error.message }, null, 2));
  process.exit(1);
}
