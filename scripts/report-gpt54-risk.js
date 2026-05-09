#!/usr/bin/env node
/**
 * Read-only owner risk report for the nanocap configured SCREENER model.
 *
 * Safe by design: this script does not deploy, close, restart, or edit config.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { resolveConfigFromPath } from "../config-builder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const WATCH_P95_LATENCY_MS = 20_000;
const ESCALATE_P95_LATENCY_MS = 45_000;
const ESCALATE_ERROR_OR_FALLBACK_COUNT = 3;

function usage() {
  console.log([
    "Usage: node scripts/report-gpt54-risk.js [--json] [--logs <dir>] [--user-config <path>] [--since-minutes <n>] [--since-iso <timestamp>] [--no-pm2]",
    "",
    "Safe: read-only; does not deploy, close positions, restart PM2, or edit config.",
  ].join("\n"));
}

function parseArgs(argv) {
  const options = {
    json: false,
    logsDir: null,
    userConfigPath: null,
    sinceMinutes: null,
    sinceIso: null,
    noPm2: false,
    selfTest: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--logs") {
      options.logsDir = resolve(argv[++i] || "");
      continue;
    }
    if (arg === "--user-config") {
      options.userConfigPath = resolve(argv[++i] || "");
      continue;
    }
    if (arg === "--since-minutes") {
      options.sinceMinutes = Number(argv[++i]);
      continue;
    }
    if (arg === "--since-iso") {
      options.sinceIso = argv[++i] || null;
      continue;
    }
    if (arg === "--no-pm2") {
      options.noPm2 = true;
      continue;
    }
    if (arg === "--self-test") {
      options.selfTest = true;
      options.json = true;
      continue;
    }
    usage();
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    encoding: "utf8",
    timeout: options.timeout ?? 60_000,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    env: options.env || process.env,
  });
}

function parseJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function defaultLogsDir() {
  const local = join(ROOT, "logs");
  const synced = join(ROOT, "..", "archive", "vps-backups", "nanocap", "logs");
  if (hasApiLog(local)) return local;
  if (hasApiLog(synced)) return synced;
  return local;
}

function defaultUserConfigPath() {
  const candidates = [
    join(ROOT, "user-config.json"),
    join(ROOT, "..", "archive", "vps-backups", "nanocap", "user-config.json"),
    join(ROOT, "user-config.example.json"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function hasApiLog(dir) {
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((name) => /^api-activity-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) || name === "api_activity.jsonl");
}

function readApiRows(logsDir) {
  if (!fs.existsSync(logsDir)) return [];
  const rows = [];
  for (const name of fs.readdirSync(logsDir).sort()) {
    if (!/^api-activity-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name !== "api_activity.jsonl") continue;
    const filePath = path.join(logsDir, name);
    const text = fs.readFileSync(filePath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parsed = parseJson(line, null);
      if (parsed) rows.push(parsed);
    }
  }
  return rows;
}

function runRuntimeConfigProof(userConfigPath) {
  const args = ["scripts/verify-runtime-config.js", "--json"];
  if (userConfigPath) args.push("--user-config", userConfigPath);
  const result = run(process.execPath, args, { cwd: ROOT });
  if (result.status !== 0) {
    return {
      success: false,
      error: (result.stderr || result.stdout || "verify-runtime-config failed").trim(),
      llm: {},
    };
  }
  return {
    success: true,
    ...parseJson(result.stdout, { llm: {} }),
  };
}

function collectPm2(options) {
  if (options.noPm2) {
    return {
      pm2_available: false,
      pm2_skipped: true,
      pm2_main_status: "unknown",
      pm2_nanocap_status: "unknown",
      pm2_nanocap_pid: null,
      pm2_nanocap_restart_count: null,
      pm2_nanocap_start_time: null,
      pm2NanocapStartMs: null,
    };
  }

  const result = run("pm2", ["jlist"], { timeout: 30_000 });
  const list = result.status === 0 ? parseJson(result.stdout, []) : [];
  const main = Array.isArray(list) ? list.find((entry) => entry?.name === "meridian") : null;
  const nanocap = Array.isArray(list) ? list.find((entry) => entry?.name === "meridian-nanocap") : null;
  const startedAtMs = Number(nanocap?.pm2_env?.pm_uptime || 0);

  return {
    pm2_available: result.status === 0,
    pm2_skipped: false,
    pm2_main_status: main?.pm2_env?.status || "unknown",
    pm2_nanocap_status: nanocap?.pm2_env?.status || "unknown",
    pm2_nanocap_pid: nanocap?.pid || null,
    pm2_nanocap_restart_count: nanocap?.pm2_env?.restart_time ?? null,
    pm2_nanocap_start_time: startedAtMs > 0 ? new Date(startedAtMs).toISOString() : null,
    pm2NanocapStartMs: startedAtMs > 0 ? startedAtMs : null,
    pm2_error: result.status === 0 ? null : (result.stderr || "pm2 jlist failed").trim(),
  };
}

function readDocs() {
  const docs = [];
  for (const filePath of [
    join(ROOT, "AGENTS.md"),
    join(ROOT, "..", "AGENTS.md"),
  ]) {
    if (fs.existsSync(filePath)) {
      docs.push({ path: filePath, text: fs.readFileSync(filePath, "utf8") });
    }
  }
  return docs;
}

function docsMatchLiveRouting(docs) {
  return docs.map((doc) => ({
    path: doc.path,
    matches: /deepseek-v4-flash/i.test(doc.text) || /DeepSeek/i.test(doc.text),
    mentions_stale_gpt_or_qwen_routes: /gpt-5\.[45]|qwen3\.6-plus/i.test(doc.text),
  }));
}

function timestampMs(row) {
  const ms = Date.parse(row.timestamp || "");
  return Number.isFinite(ms) ? ms : null;
}

function percentile(values, pct) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[index];
}

function sinceMsFromOptions(options, pm2) {
  if (options.sinceIso) {
    const ms = Date.parse(options.sinceIso);
    return Number.isFinite(ms) ? ms : null;
  }
  if (Number.isFinite(Number(options.sinceMinutes)) && Number(options.sinceMinutes) > 0) {
    return Date.now() - Number(options.sinceMinutes) * 60_000;
  }
  return pm2.pm2NanocapStartMs || null;
}

function summarizeRows(rows, sinceMs, expectedModel, expectedReasoningEffort) {
  const inScope = sinceMs == null ? rows : rows.filter((row) => {
    const ms = timestampMs(row);
    return ms != null && ms >= sinceMs;
  });
  const screener = inScope.filter((row) => (row.agent_role || row.agent) === "SCREENER");
  const configuredRows = screener.filter((row) => row.model === expectedModel);
  const staleScreener = screener.filter((row) => /gpt-5\.[45]|qwen3\.6-plus/i.test(String(row.model || "")));
  const latencies = configuredRows
    .map((row) => Number(row.duration_ms))
    .filter((value) => Number.isFinite(value));
  const badReasoningRows = configuredRows.filter((row) => (row.reasoning_effort ?? null) !== (expectedReasoningEffort ?? null));
  const errorRows = screener.filter((row) => row.status && row.status !== "success");
  const fallbackRows = screener.filter((row) => row.route_kind === "fallback");
  const tokenTotal = configuredRows.reduce((sum, row) => sum + (Number(row.total_tokens ?? row.tokens ?? 0) || 0), 0);

  return {
    since_time: sinceMs == null ? null : new Date(sinceMs).toISOString(),
    source_rows: rows.length,
    scoped_rows: inScope.length,
    screener_calls: screener.length,
    configured_model: expectedModel,
    configured_model_calls: configuredRows.length,
    configured_model_success: configuredRows.filter((row) => row.status === "success").length,
    configured_model_error: configuredRows.filter((row) => row.status && row.status !== "success").length,
    stale_gpt_or_qwen_screener_calls: staleScreener.length,
    fallback_calls: fallbackRows.length,
    error_calls: errorRows.length,
    expected_reasoning_effort: expectedReasoningEffort ?? null,
    reasoning_effort_expected_calls: configuredRows.filter((row) => (row.reasoning_effort ?? null) === (expectedReasoningEffort ?? null)).length,
    reasoning_effort_bad_or_missing_calls: badReasoningRows.length,
    latest_guarded_call_time: configuredRows.filter((row) => (row.reasoning_effort ?? null) === (expectedReasoningEffort ?? null)).map((row) => row.timestamp).filter(Boolean).pop() || null,
    p50_latency_ms: percentile(latencies, 50),
    p95_latency_ms: percentile(latencies, 95),
    total_tokens: tokenTotal,
  };
}

function addReason(reasons, severity, code, message) {
  reasons.push({ severity, code, message });
}

function worstStatus(reasons) {
  if (reasons.some((reason) => reason.severity === "escalate")) return "escalate";
  if (reasons.some((reason) => reason.severity === "watch")) return "watch";
  return "ok";
}

function buildReport({ options, rows, runtimeConfig, pm2, docs }) {
  const sinceMs = sinceMsFromOptions(options, pm2);
  const llm = runtimeConfig.llm || {};
  const expectedModel = llm.screeningModel || null;
  const expectedReasoningEffort = llm.screeningReasoningEffort ?? null;
  const summary = summarizeRows(rows, sinceMs, expectedModel, expectedReasoningEffort);
  const docChecks = docsMatchLiveRouting(docs);
  const reasons = [];

  if (runtimeConfig.success !== true) {
    addReason(reasons, "escalate", "runtime_config_unavailable", "Runtime config proof failed.");
  }
  if (!/^deepseek-/i.test(String(llm.screeningModel || ""))) {
    addReason(reasons, "escalate", "screening_model_not_deepseek", `SCREENER model is ${llm.screeningModel || "unknown"}, expected DeepSeek from config.`);
  }
  if (llm.managementModel !== llm.screeningModel || llm.generalModel !== llm.screeningModel) {
    addReason(reasons, "watch", "role_model_mismatch", `Role models are SCREENER=${llm.screeningModel || "unknown"}, MANAGER=${llm.managementModel || "unknown"}, GENERAL=${llm.generalModel || "unknown"}.`);
  }

  if (!pm2.pm2_available) {
    addReason(reasons, "watch", "pm2_unavailable", "PM2 status is unavailable in this run; run on VPS for process-state proof.");
  } else {
    if (pm2.pm2_main_status !== "stopped") {
      addReason(reasons, "escalate", "main_online_unexpectedly", `Main meridian PM2 status is ${pm2.pm2_main_status}, expected stopped.`);
    }
    if (pm2.pm2_nanocap_status !== "online") {
      addReason(reasons, "escalate", "nanocap_not_online", `Nanocap PM2 status is ${pm2.pm2_nanocap_status}, expected online.`);
    }
  }

  if (summary.configured_model_calls === 0) {
    addReason(reasons, "watch", "no_recent_configured_model_calls", `No ${expectedModel || "configured"} SCREENER calls found in the scoped log window yet.`);
  }
  if (summary.reasoning_effort_bad_or_missing_calls > 0) {
    addReason(reasons, "escalate", "reasoning_effort_reverted_or_missing", `${summary.reasoning_effort_bad_or_missing_calls} scoped configured-model SCREENER call(s) had an unexpected reasoning effort.`);
  }
  if (summary.stale_gpt_or_qwen_screener_calls > 0) {
    addReason(reasons, "escalate", "stale_model_route_seen", `${summary.stale_gpt_or_qwen_screener_calls} scoped SCREENER call(s) still used stale GPT/Qwen routing.`);
  }
  if (summary.error_calls >= ESCALATE_ERROR_OR_FALLBACK_COUNT) {
    addReason(reasons, "escalate", "repeated_screener_errors", `${summary.error_calls} scoped SCREENER error row(s) found.`);
  } else if (summary.error_calls > 0) {
    addReason(reasons, "watch", "screener_errors_present", `${summary.error_calls} scoped SCREENER error row(s) found.`);
  }
  if (summary.fallback_calls >= ESCALATE_ERROR_OR_FALLBACK_COUNT) {
    addReason(reasons, "escalate", "repeated_screener_fallbacks", `${summary.fallback_calls} scoped SCREENER fallback row(s) found.`);
  } else if (summary.fallback_calls > 0) {
    addReason(reasons, "watch", "screener_fallbacks_present", `${summary.fallback_calls} scoped SCREENER fallback row(s) found.`);
  }
  if (summary.p95_latency_ms != null && summary.p95_latency_ms >= ESCALATE_P95_LATENCY_MS) {
    addReason(reasons, "escalate", "p95_latency_above_escalate_threshold", `${expectedModel || "Configured model"} p95 latency is ${summary.p95_latency_ms}ms.`);
  } else if (summary.p95_latency_ms != null && summary.p95_latency_ms >= WATCH_P95_LATENCY_MS) {
    addReason(reasons, "watch", "p95_latency_above_watch_threshold", `${expectedModel || "Configured model"} p95 latency is ${summary.p95_latency_ms}ms.`);
  }

  const mismatchedDocs = docChecks.filter((doc) => !doc.matches || doc.mentions_stale_gpt_or_qwen_routes);
  if (mismatchedDocs.length > 0) {
    addReason(reasons, "escalate", "context_docs_disagree_with_live_routing", `${mismatchedDocs.length} context doc(s) do not describe current DeepSeek routing cleanly.`);
  }

  return {
    status: worstStatus(reasons),
    generated_at: new Date().toISOString(),
    safety: {
      deploys_or_closes_positions: false,
      restarts_processes: false,
      changes_config: false,
    },
    thresholds: {
      watch_p95_latency_ms: WATCH_P95_LATENCY_MS,
      escalate_p95_latency_ms: ESCALATE_P95_LATENCY_MS,
      repeated_error_or_fallback_count: ESCALATE_ERROR_OR_FALLBACK_COUNT,
    },
    runtime: {
      current_screener_model: llm.screeningModel || null,
      current_screener_reasoning_effort: llm.screeningReasoningEffort || null,
      current_screener_base_url: llm.screeningBaseUrl || null,
      current_screener_fallback_model: llm.screeningFallbackModel || null,
      current_management_model: llm.managementModel || null,
      current_general_model: llm.generalModel || null,
      runtime_config_path: runtimeConfig.effectiveUserConfigPath || null,
    },
    pm2: {
      available: pm2.pm2_available,
      main_status: pm2.pm2_main_status,
      nanocap_status: pm2.pm2_nanocap_status,
      nanocap_pid: pm2.pm2_nanocap_pid,
      nanocap_restart_count: pm2.pm2_nanocap_restart_count,
      nanocap_start_time: pm2.pm2_nanocap_start_time,
    },
    llm_usage: summary,
    context_docs: docChecks,
    reasons,
  };
}

function printText(report) {
  console.log(`Nanocap configured SCREENER risk status: ${report.status.toUpperCase()}`);
  console.log(`Generated: ${report.generated_at}`);
  console.log(`Safe command: deploys/closes=${report.safety.deploys_or_closes_positions}, restarts=${report.safety.restarts_processes}, config_changes=${report.safety.changes_config}`);
  console.log("");
  console.log(`Runtime: SCREENER ${report.runtime.current_screener_model} reasoning=${report.runtime.current_screener_reasoning_effort}; MANAGER ${report.runtime.current_management_model}; GENERAL ${report.runtime.current_general_model}`);
  console.log(`PM2: main=${report.pm2.main_status}; nanocap=${report.pm2.nanocap_status}; nanocap_pid=${report.pm2.nanocap_pid ?? "unknown"}`);
  console.log(`Logs since: ${report.llm_usage.since_time || "all rows"}`);
  console.log(`Configured-model calls=${report.llm_usage.configured_model_calls}, success=${report.llm_usage.configured_model_success}, errors=${report.llm_usage.configured_model_error}, fallbacks=${report.llm_usage.fallback_calls}`);
  console.log(`Reasoning expected=${report.llm_usage.reasoning_effort_expected_calls}, bad/missing=${report.llm_usage.reasoning_effort_bad_or_missing_calls}`);
  console.log(`Latency p50=${report.llm_usage.p50_latency_ms ?? "n/a"}ms, p95=${report.llm_usage.p95_latency_ms ?? "n/a"}ms; tokens=${report.llm_usage.total_tokens}`);
  console.log("");
  if (report.reasons.length === 0) {
    console.log("Reasons: none");
    return;
  }
  console.log("Reasons:");
  for (const reason of report.reasons) {
    console.log(`- ${reason.severity.toUpperCase()} ${reason.code}: ${reason.message}`);
  }
}

function runSelfTest() {
  const now = Date.now();
  const exampleConfigPath = join(ROOT, "user-config.example.json");
  const exampleConfig = resolveConfigFromPath(exampleConfigPath, { env: { ...process.env }, applyEnv: false }).config;
  const expectedModel = exampleConfig.llm.screeningModel;
  const expectedReasoningEffort = exampleConfig.llm.screeningReasoningEffort ?? null;
  const docs = [{ path: "AGENTS.md", text: `Nanocap SCREENER, MANAGER, and GENERAL use DeepSeek ${expectedModel}.` }];
  const base = {
    options: { sinceIso: new Date(now - 1_000).toISOString(), sinceMinutes: null, noPm2: true },
    runtimeConfig: {
      success: true,
      effectiveUserConfigPath: "user-config.json",
      llm: {
        screeningModel: expectedModel,
        screeningReasoningEffort: expectedReasoningEffort,
        screeningBaseUrl: "https://api.deepseek.com",
        screeningFallbackModel: null,
        managementModel: expectedModel,
        generalModel: expectedModel,
      },
    },
    pm2: {
      pm2_available: true,
      pm2_main_status: "stopped",
      pm2_nanocap_status: "online",
      pm2_nanocap_pid: 123,
      pm2_nanocap_restart_count: 1,
      pm2_nanocap_start_time: new Date(now - 1_000).toISOString(),
      pm2NanocapStartMs: now - 1_000,
    },
    docs,
  };

  base.runtimeConfig.llm.screeningModel = expectedModel;
  const okRows = [{ timestamp: new Date(now).toISOString(), agent_role: "SCREENER", model: expectedModel, route_kind: "primary", reasoning_effort: expectedReasoningEffort, duration_ms: 12_000, status: "success", total_tokens: 100 }];
  const badReasoningRows = [{ ...okRows[0], reasoning_effort: "unexpected" }];
  const fallbackRows = Array.from({ length: 3 }, (_, index) => ({ ...okRows[0], timestamp: new Date(now + index).toISOString(), route_kind: "fallback", status: "success" }));
  const highLatencyRows = [{ ...okRows[0], duration_ms: 46_000 }];
  const mainOnline = { ...base, pm2: { ...base.pm2, pm2_main_status: "online" } };
  const docsMismatch = { ...base, docs: [{ path: "AGENTS.md", text: "Active Role Models: All use qwen3.6-plus." }] };

  return {
    success: true,
    safe_read_only_markers: buildReport({ ...base, rows: okRows }).safety,
    ok_status: buildReport({ ...base, rows: okRows }).status,
    bad_reasoning_status: buildReport({ ...base, rows: badReasoningRows }).status,
    repeated_fallback_status: buildReport({ ...base, rows: fallbackRows }).status,
    high_latency_status: buildReport({ ...base, rows: highLatencyRows }).status,
    main_online_status: buildReport({ ...mainOnline, rows: okRows }).status,
    docs_mismatch_status: buildReport({ ...docsMismatch, rows: okRows }).status,
    reason_codes: [
      ...buildReport({ ...base, rows: badReasoningRows }).reasons.map((reason) => reason.code),
      ...buildReport({ ...base, rows: fallbackRows }).reasons.map((reason) => reason.code),
      ...buildReport({ ...mainOnline, rows: okRows }).reasons.map((reason) => reason.code),
      ...buildReport({ ...docsMismatch, rows: okRows }).reasons.map((reason) => reason.code),
    ],
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    console.log(JSON.stringify(runSelfTest(), null, 2));
    return;
  }

  const logsDir = options.logsDir || defaultLogsDir();
  const userConfigPath = options.userConfigPath || defaultUserConfigPath();
  const pm2 = collectPm2(options);
  const report = buildReport({
    options,
    rows: readApiRows(logsDir),
    runtimeConfig: runRuntimeConfigProof(userConfigPath),
    pm2,
    docs: readDocs(),
  });
  report.sources = {
    logs_dir: logsDir,
    user_config_path: userConfigPath,
    hostname: os.hostname(),
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printText(report);
}

main();
