#!/usr/bin/env node
/**
 * verify-patches.js
 *
 * Verifies local hardening patches before any restart or deployment.
 * This script checks source-level guards and a small runtime proof for
 * config-management mapping using an explicit supplied user-config path.
 */

import {
  existsSync,
  readFileSync,
} from "fs";
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SYNCED_NANOCAP_USER_CONFIG_PATH = join(ROOT, "..", "archive", "vps-backups", "nanocap", "user-config.json");
const NANOCAP_EXAMPLE_CONFIG_PATH = join(ROOT, "user-config.example.json");
const NANOCAP_USER_CONFIG_PATH = existsSync(SYNCED_NANOCAP_USER_CONFIG_PATH)
  ? SYNCED_NANOCAP_USER_CONFIG_PATH
  : NANOCAP_EXAMPLE_CONFIG_PATH;
const RUNTIME_CONFIG_VERIFIER_PATH = join(__dirname, "verify-runtime-config.js");
const EARLY_DUMP_COOLDOWN_VERIFIER_PATH = join(__dirname, "verify-early-dump-cooldown.js");
const STOP_LOSS_TRIAL_BEHAVIOR_VERIFIER_PATH = join(__dirname, "verify-stop-loss-trial-behavior.js");
const EMERGENCY_STOP_POLICY_VERIFIER_PATH = join(__dirname, "verify-emergency-stop-policy.js");
const ROLLING_DRAWDOWN_EXIT_POLICY_VERIFIER_PATH = join(__dirname, "verify-rolling-drawdown-exit-policy.js");
const FALLING_KNIFE_VETO_VERIFIER_PATH = join(__dirname, "verify-falling-knife-veto.js");
const NARROW_RANGE_GUARD_VERIFIER_PATH = join(__dirname, "verify-narrow-range-guard.js");
const NANOCAP_SINGLE_SIDE_BIDASK_VERIFIER_PATH = join(__dirname, "verify-nanocap-single-side-bidask.js");
const MATERIAL_WIN_METRICS_VERIFIER_PATH = join(__dirname, "verify-material-win-metrics.js");
const UPSTREAM_SECURITY_HARDENING_VERIFIER_PATH = join(__dirname, "verify-upstream-security-hardening.js");
const RELAY_GUARD_EVIDENCE_VERIFIER_PATH = join(__dirname, "verify-relay-guard-evidence.js");
const RELAY_RETRY_EVIDENCE_VERIFIER_PATH = join(__dirname, "verify-relay-retry-evidence.js");
const GPT54_RISK_REPORT_PATH = join(__dirname, "report-gpt54-risk.js");
const SCREENER_TRIAL_TELEMETRY_VERIFIER_PATH = join(__dirname, "verify-screener-trial-telemetry.js");
const DECISION_CONTEXT_LOGGING_VERIFIER_PATH = join(__dirname, "verify-decision-context-logging.js");
const NANOCAP_BOLLINGER_CANARY_VERIFIER_PATH = join(__dirname, "verify-nanocap-bollinger-canary.js");
const SUPERTREND_LOSS_EXIT_VERIFIER_PATH = join(__dirname, "verify-supertrend-loss-exit.js");
const MATERIAL_UPDATE_CONFIG_FIELDS = Object.freeze([
  "materialWinPct",
  "materialLossPct",
  "dustNeutralAbsPct",
  "neutralCloseReasonBuckets",
  "darwinUseMaterialOutcomes",
  "darwinExcludeNeutralOutcomes",
]);

function loadSource(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function materialConfigMapEntryPresent(src, key) {
  return new RegExp(`${key}:\\s*\\["performance",\\s*"${key}"\\]`).test(src);
}

function materialDefinitionsFieldPresent(src, key) {
  return new RegExp(`["']${key}["']`).test(src);
}

function roleReasoningConfigKeysAbsent() {
  const forbiddenKeys = ["managementReasoningEffort", "generalReasoningEffort"];
  const files = ["config-builder.js", "config.js", "user-config.example.json"];
  return files.every((file) => {
    const src = loadSource(file);
    return forbiddenKeys.every((key) => !src.includes(key));
  });
}

function managerAndGeneralReasoningEffortNull(src) {
  const managerRoute = src.match(/if \(role === "MANAGER"\) \{[\s\S]*?return \{([\s\S]*?)\};\s*\}/);
  const generalRoute = src.match(/return \{\s*role,\s*routeKind: "primary",[\s\S]*?model:\s*modelOverride \|\| llmCfg\.generalModel[\s\S]*?\};\s*\}/);
  return Boolean(
    managerRoute?.[1] &&
    /reasoningEffort:\s*null/.test(managerRoute[1]) &&
    generalRoute?.[0] &&
    /reasoningEffort:\s*null/.test(generalRoute[0]) &&
    src.includes("MANAGER and GENERAL are dense non-reasoning routes; only SCREENER forwards reasoning_effort")
  );
}

function parseNanocapUserConfig() {
  if (!existsSync(NANOCAP_USER_CONFIG_PATH)) return {};
  return JSON.parse(readFileSync(NANOCAP_USER_CONFIG_PATH, "utf8"));
}

function runRuntimeConfigProof(userConfigPath) {
  const args = [RUNTIME_CONFIG_VERIFIER_PATH, "--json"];
  if (userConfigPath) {
    args.push("--user-config", userConfigPath);
  }

  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "(no stderr)";
    const stdout = result.stdout?.trim() || "(no stdout)";
    throw new Error(`verify-runtime-config failed for ${userConfigPath ?? "(repo-local default)"}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(result.stdout);
}

function runEarlyDumpCooldownProof() {
  const result = spawnSync(process.execPath, [EARLY_DUMP_COOLDOWN_VERIFIER_PATH], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LOG_LEVEL: "error" },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "(no stderr)";
    const stdout = result.stdout?.trim() || "(no stdout)";
    throw new Error(`verify-early-dump-cooldown failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(result.stdout);
}

function runStopLossTrialBehaviorProof() {
  const result = spawnSync(process.execPath, [STOP_LOSS_TRIAL_BEHAVIOR_VERIFIER_PATH], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LOG_LEVEL: "error" },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "(no stderr)";
    const stdout = result.stdout?.trim() || "(no stdout)";
    throw new Error(`verify-stop-loss-trial-behavior failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(result.stdout);
}

function runEmergencyStopPolicyProof() {
  const result = spawnSync(process.execPath, [EMERGENCY_STOP_POLICY_VERIFIER_PATH], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LOG_LEVEL: "error" },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "(no stderr)";
    const stdout = result.stdout?.trim() || "(no stdout)";
    throw new Error(`verify-emergency-stop-policy failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(result.stdout);
}

function runRollingDrawdownExitPolicyProof() {
  const result = spawnSync(process.execPath, [ROLLING_DRAWDOWN_EXIT_POLICY_VERIFIER_PATH], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LOG_LEVEL: "error" },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "(no stderr)";
    const stdout = result.stdout?.trim() || "(no stdout)";
    throw new Error(`verify-rolling-drawdown-exit-policy failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(result.stdout);
}

function runFallingKnifeVetoProof() {
  const result = spawnSync(process.execPath, [FALLING_KNIFE_VETO_VERIFIER_PATH], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LOG_LEVEL: "error" },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "(no stderr)";
    const stdout = result.stdout?.trim() || "(no stdout)";
    throw new Error(`verify-falling-knife-veto failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(result.stdout);
}

function runNarrowRangeGuardProof() {
  const result = spawnSync(process.execPath, [NARROW_RANGE_GUARD_VERIFIER_PATH], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LOG_LEVEL: "error" },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "(no stderr)";
    const stdout = result.stdout?.trim() || "(no stdout)";
    throw new Error(`verify-narrow-range-guard failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(result.stdout);
}

function runNanocapSingleSideBidAskProof() {
  const result = spawnSync(process.execPath, [NANOCAP_SINGLE_SIDE_BIDASK_VERIFIER_PATH], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LOG_LEVEL: "error" },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "(no stderr)";
    const stdout = result.stdout?.trim() || "(no stdout)";
    throw new Error(`verify-nanocap-single-side-bidask failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(result.stdout);
}

function runMaterialWinMetricsProof() {
  const result = spawnSync(process.execPath, [MATERIAL_WIN_METRICS_VERIFIER_PATH], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LOG_LEVEL: "error" },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "(no stderr)";
    const stdout = result.stdout?.trim() || "(no stdout)";
    throw new Error(`verify-material-win-metrics failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(result.stdout);
}

function runUpstreamSecurityHardeningProof() {
  const result = spawnSync(process.execPath, [UPSTREAM_SECURITY_HARDENING_VERIFIER_PATH], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LOG_LEVEL: "error", MERIDIAN_ENVCRYPT_AUTOLOAD: "false" },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "(no stderr)";
    const stdout = result.stdout?.trim() || "(no stdout)";
    throw new Error(`verify-upstream-security-hardening failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(result.stdout);
}

function runRelayGuardEvidenceSelfTest() {
  const result = spawnSync(process.execPath, [RELAY_GUARD_EVIDENCE_VERIFIER_PATH, "--self-test"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LOG_LEVEL: "error" },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "(no stderr)";
    const stdout = result.stdout?.trim() || "(no stdout)";
    throw new Error(`verify-relay-guard-evidence self-test failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(result.stdout);
}

function runRelayRetryEvidenceProof() {
  const result = spawnSync(process.execPath, [RELAY_RETRY_EVIDENCE_VERIFIER_PATH], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LOG_LEVEL: "error" },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "(no stderr)";
    const stdout = result.stdout?.trim() || "(no stdout)";
    throw new Error(`verify-relay-retry-evidence failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(result.stdout);
}

function runGpt54RiskReportSelfTest() {
  const result = spawnSync(process.execPath, [GPT54_RISK_REPORT_PATH, "--self-test"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LOG_LEVEL: "error" },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "(no stderr)";
    const stdout = result.stdout?.trim() || "(no stdout)";
    throw new Error(`report-gpt54-risk self-test failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(result.stdout);
}

function runScreenerTrialTelemetryProof() {
  const result = spawnSync(process.execPath, [SCREENER_TRIAL_TELEMETRY_VERIFIER_PATH], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LOG_LEVEL: "error" },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "(no stderr)";
    const stdout = result.stdout?.trim() || "(no stdout)";
    throw new Error(`verify-screener-trial-telemetry failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(result.stdout);
}

function runDecisionContextLoggingProof() {
  const result = spawnSync(process.execPath, [DECISION_CONTEXT_LOGGING_VERIFIER_PATH], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LOG_LEVEL: "error" },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "(no stderr)";
    const stdout = result.stdout?.trim() || "(no stdout)";
    throw new Error(`verify-decision-context-logging failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(result.stdout);
}

function runNanocapBollingerCanaryProof() {
  const result = spawnSync(process.execPath, [NANOCAP_BOLLINGER_CANARY_VERIFIER_PATH], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LOG_LEVEL: "error" },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "(no stderr)";
    const stdout = result.stdout?.trim() || "(no stdout)";
    throw new Error(`verify-nanocap-bollinger-canary failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(result.stdout);
}

function runSupertrendLossExitProof() {
  const result = spawnSync(process.execPath, [SUPERTREND_LOSS_EXIT_VERIFIER_PATH], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LOG_LEVEL: "error" },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "(no stderr)";
    const stdout = result.stdout?.trim() || "(no stdout)";
    throw new Error(`verify-supertrend-loss-exit failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(result.stdout);
}

function buildChecks() {
  const nanocapUserConfig = parseNanocapUserConfig();
  const defaultProofPath = join(ROOT, `.runtime-config-default-proof-${process.pid}-${Date.now()}.json`);
  const defaultProof = runRuntimeConfigProof(defaultProofPath);
  const exampleProof = runRuntimeConfigProof(NANOCAP_EXAMPLE_CONFIG_PATH);
  const nanocapConfig = existsSync(NANOCAP_USER_CONFIG_PATH)
    ? runRuntimeConfigProof(NANOCAP_USER_CONFIG_PATH)
    : null;
  const earlyDumpProof = runEarlyDumpCooldownProof();
  const stopLossBehaviorProof = runStopLossTrialBehaviorProof();
  const emergencyStopProof = runEmergencyStopPolicyProof();
  const rollingDrawdownExitProof = runRollingDrawdownExitPolicyProof();
  const fallingKnifeProof = runFallingKnifeVetoProof();
  const narrowRangeGuardProof = runNarrowRangeGuardProof();
  const nanocapSingleSideBidAskProof = runNanocapSingleSideBidAskProof();
  const materialProof = runMaterialWinMetricsProof();
  const upstreamSecurityProof = runUpstreamSecurityHardeningProof();
  const relayGuardEvidenceProof = runRelayGuardEvidenceSelfTest();
  const relayRetryEvidenceProof = runRelayRetryEvidenceProof();
  const gpt54RiskReportProof = runGpt54RiskReportSelfTest();
  const screenerTrialTelemetryProof = runScreenerTrialTelemetryProof();
  const decisionContextLoggingProof = runDecisionContextLoggingProof();
  const nanocapBollingerCanaryProof = runNanocapBollingerCanaryProof();
  const supertrendLossExitProof = runSupertrendLossExitProof();

  return [
    {
      file: "decision-context-log.js",
      label: "[Birdeye context] live bot emits offline-first decision-context JSONL without Birdeye in the trading loop",
      test: (src) =>
        decisionContextLoggingProof?.success === true &&
        decisionContextLoggingProof?.log_file_pattern_present === true &&
        decisionContextLoggingProof?.secret_redaction_present === true &&
        decisionContextLoggingProof?.no_birdeye_in_live_runtime === true &&
        decisionContextLoggingProof?.stages?.deterministic_veto === true &&
        decisionContextLoggingProof?.stages?.indicator_reject === true &&
        decisionContextLoggingProof?.stages?.cooldown_block === true &&
        decisionContextLoggingProof?.stages?.deploy_attempt === true &&
        decisionContextLoggingProof?.stages?.deploy_success === true &&
        decisionContextLoggingProof?.stages?.deploy_reject === true &&
        decisionContextLoggingProof?.stages?.close === true &&
        decisionContextLoggingProof?.stages?.pnl_snapshot_link === true &&
        decisionContextLoggingProof?.source_safety?.deploys_or_closes_positions === false &&
        decisionContextLoggingProof?.source_safety?.changes_config === false &&
        src.includes("appendDecisionContext") &&
        src.includes("summarizeIndicatorConfirmation"),
    },
    {
      file: "scripts/verify-upstream-security-hardening.js",
      label: "[Security] upstream envcrypt and relay-signing synthetic proof passes",
      test: () =>
        upstreamSecurityProof?.success === true &&
        upstreamSecurityProof?.sourceProof?.envryptIgnored === true &&
        upstreamSecurityProof?.sourceProof?.relayGuardWiredForZapOut === true &&
        upstreamSecurityProof?.sourceProof?.relayGuardWiredForZapIn === true &&
        upstreamSecurityProof?.sourceProof?.postSubmitFallbackBlocked === true &&
        upstreamSecurityProof?.envcryptProof?.roundTrip === true &&
        upstreamSecurityProof?.envcryptProof?.markerOnlyDecrypt === true &&
        upstreamSecurityProof?.envcryptProof?.missingKeyFails === true &&
        upstreamSecurityProof?.relayProof?.unsafeSystemTransferRejected === true &&
        upstreamSecurityProof?.relayProof?.safeSimulationSigns === true &&
        upstreamSecurityProof?.relayProof?.requiredStaticAccountEnforced === true &&
        upstreamSecurityProof?.relayProof?.simulationErrorRejected === true &&
        upstreamSecurityProof?.relayProof?.maxSolLossEnforced === true &&
        upstreamSecurityProof?.relayProof?.unrelatedTokenDebitRejected === true,
    },
    {
      file: "scripts/verify-relay-guard-evidence.js",
      label: "[Security] owner relay guard evidence report has safe status classifier",
      test: (src) =>
        relayGuardEvidenceProof?.success === true &&
        Array.isArray(relayGuardEvidenceProof?.relay_status_values) &&
        relayGuardEvidenceProof.relay_status_values.includes("not_yet_exercised") &&
        relayGuardEvidenceProof.relay_status_values.includes("guard_approved") &&
        relayGuardEvidenceProof.relay_status_values.includes("guard_rejected") &&
        relayGuardEvidenceProof?.approved_status === "guard_approved" &&
        relayGuardEvidenceProof?.rejected_status === "guard_rejected" &&
        relayGuardEvidenceProof?.empty_status === "not_yet_exercised" &&
        src.includes("deploys_or_closes_positions: false") &&
        src.includes("restarts_processes: false") &&
        src.includes("changes_config: false") &&
        src.includes("experimental_security_verifier_passed") &&
        src.includes("relay_guard_exercise_status"),
    },
    {
      file: "scripts/verify-relay-retry-evidence.js",
      label: "[Runtime] Agent Meridian relay fallback logs retry evidence and marker",
      test: () =>
        relayRetryEvidenceProof?.ok === true &&
        relayRetryEvidenceProof?.relayOpenPositionBudget?.maxElapsedMs === 45_000 &&
        relayRetryEvidenceProof?.relayOpenPositionBudget?.perAttemptTimeoutMs === 20_000 &&
        relayRetryEvidenceProof?.relayOpenPositionBudget?.maxAttempts === 2 &&
        relayRetryEvidenceProof?.logMarker === "Agent Meridian relay retry evidence enabled",
    },
    {
      file: "config-builder.js",
      label: "[CLIProxy] screener provider-level fallback config maps into runtime config",
      test: (src) =>
        src.includes("screeningFallbackModel") &&
        src.includes("screeningFallbackBaseUrl") &&
        src.includes("screeningFallbackApiKey"),
    },
    {
      file: "config-builder.js",
      label: "[CLIProxy] screener reasoning effort config maps into runtime config",
      test: (src) =>
        src.includes("normalizeScreeningReasoningEffort") &&
        src.includes('new Set(["low", "medium", "high"])') &&
        src.includes("screeningReasoningEffort"),
    },
    {
      file: "agent.js",
      label: "[CLIProxy] SCREENER can fall back to Qwen on a separate provider route",
      test: (src) =>
        src.includes("buildLlmRoute") &&
        src.includes("hasScreeningFallbackRoute") &&
        src.includes('routeKind === "fallback"') &&
        src.includes("SCREENER primary route failed") &&
        src.includes("route_kind"),
    },
    {
      file: "agent.js",
      label: "[CLIProxy] SCREENER sends and logs explicit Chat Completions reasoning_effort",
      test: (src) =>
        src.includes("reasoningEffort: llmCfg.screeningReasoningEffort || null") &&
        src.includes("callParams.reasoning_effort = activeRoute.reasoningEffort") &&
        src.includes("reasoning_effort: activeRoute.reasoningEffort || null"),
    },
    {
      file: "agent.js",
      label: "[CLIProxy] MANAGER and GENERAL stay dense non-reasoning routes",
      test: (src) =>
        managerAndGeneralReasoningEffortNull(src) &&
        roleReasoningConfigKeysAbsent(),
    },
    {
      file: "agent.js",
      label: "[CLIProxy] OpenRouter provider ignore is omitted for CLIProxy and DashScope",
      test: (src) =>
        src.includes("function isOpenRouterBaseUrl") &&
        src.includes("function providerIgnoreForBaseUrl") &&
        src.includes('providerIgnoreForBaseUrl(baseUrl) ? ["Parasail", "Nebius", "Together"] : []') === false &&
        src.includes('return isOpenRouterBaseUrl(baseUrl) ? ["Parasail", "Nebius", "Together"] : []'),
    },
    {
      file: "agent.js",
      label: "[CLIProxy] VPS-safe daily LLM usage logging is enabled",
      test: (src) =>
        src.includes("api-activity-${dateKey(date)}.jsonl") &&
        src.includes("API_LOGS_PATH") &&
        src.includes("base_url_host") &&
        src.includes("reasoning_effort") &&
        src.includes("prompt_tokens") &&
        src.includes("completion_tokens") &&
        src.includes("total_tokens") &&
        src.includes("sanitizeErrorMessage"),
    },
    {
      file: "scripts/verify-llm-endpoint.js",
      label: "[CLIProxy] read-only endpoint verifier covers chat completions and tool calls",
      test: (src) =>
        src.includes("--chat-smoke") &&
        src.includes("--tool-call-smoke") &&
        src.includes("--reasoning-effort") &&
        src.includes("reasoning_effort") &&
        src.includes("client.chat.completions.create") &&
        src.includes("tool_calls") &&
        src.includes("loads_wallet_or_trading_modules: false"),
    },
    {
      file: "scripts/analyze-llm-usage.js",
      label: "[CLIProxy] read-only LLM usage analyzer reports models, routes, status, tokens, and latency",
      test: (src) =>
        src.includes("calls_by_day") &&
        src.includes("calls_by_agent_role") &&
        src.includes("calls_by_model") &&
        src.includes("calls_by_reasoning_effort") &&
        src.includes("route_counts") &&
        src.includes("status_counts") &&
        src.includes("p95_latency_ms"),
    },
    {
      file: "scripts/analyze-screener-trial.js",
      label: "[CLIProxy] GPT-5.5 screener trial analyzer reports latency, fallback, validity, deploy rejects, range audits, and realized quality",
      test: (src) =>
        screenerTrialTelemetryProof?.success === true &&
        screenerTrialTelemetryProof?.gpt55_primary?.calls === 3 &&
        screenerTrialTelemetryProof?.gpt55_primary?.timeout_errors === 1 &&
        screenerTrialTelemetryProof?.fallback_route_calls === 1 &&
        screenerTrialTelemetryProof?.deploy_audits?.raw_count === 1 &&
        screenerTrialTelemetryProof?.deploy_audits?.normalized_count === 1 &&
        screenerTrialTelemetryProof?.deploy_audits?.narrow_range_reject_count === 1 &&
        screenerTrialTelemetryProof?.deploys?.successes === 1 &&
        screenerTrialTelemetryProof?.deploys?.action_rejects_or_errors === 1 &&
        screenerTrialTelemetryProof?.deploys?.safety_blocks_from_agent_log === 1 &&
        screenerTrialTelemetryProof?.realized_position_quality?.closed_positions_opened_in_window === 1 &&
        screenerTrialTelemetryProof?.realized_position_quality?.first_material_outcome === "material_win" &&
        screenerTrialTelemetryProof?.safe_read_only_markers?.deploys_or_closes_positions === false &&
        screenerTrialTelemetryProof?.safe_read_only_markers?.network_calls === false &&
        screenerTrialTelemetryProof?.source_safety?.deploys_or_closes_positions === false &&
        screenerTrialTelemetryProof?.source_safety?.changes_config === false &&
        src.includes("gpt-5.5") &&
        src.includes("calls_by_model_route") &&
        src.includes("json_tool_validity") &&
        src.includes("deploy_audits") &&
        src.includes("realized_position_quality") &&
        src.includes("measurement_limitations") &&
        src.includes("[range-raw]") &&
        src.includes("[range-normalized]") &&
        src.includes("[narrow-range-guard]"),
    },
    {
      file: "scripts/report-gpt54-risk.js",
      label: "[CLIProxy] owner risk report flags GPT-5.4 high-effort drift, fallback/error spikes, latency, PM2, and docs mismatch",
      test: (src) =>
        gpt54RiskReportProof?.success === true &&
        gpt54RiskReportProof?.safe_read_only_markers?.deploys_or_closes_positions === false &&
        gpt54RiskReportProof?.safe_read_only_markers?.restarts_processes === false &&
        gpt54RiskReportProof?.safe_read_only_markers?.changes_config === false &&
        gpt54RiskReportProof?.ok_status === "ok" &&
        gpt54RiskReportProof?.bad_reasoning_status === "escalate" &&
        gpt54RiskReportProof?.repeated_fallback_status === "escalate" &&
        gpt54RiskReportProof?.high_latency_status === "escalate" &&
        gpt54RiskReportProof?.main_online_status === "escalate" &&
        gpt54RiskReportProof?.docs_mismatch_status === "escalate" &&
        gpt54RiskReportProof?.reason_codes?.includes("reasoning_effort_reverted_or_missing") &&
        gpt54RiskReportProof?.reason_codes?.includes("repeated_screener_fallbacks") &&
        gpt54RiskReportProof?.reason_codes?.includes("main_online_unexpectedly") &&
        gpt54RiskReportProof?.reason_codes?.includes("context_docs_disagree_with_live_routing") &&
        src.includes("deploys_or_closes_positions: false") &&
        src.includes("restarts_processes: false") &&
        src.includes("changes_config: false") &&
        src.includes("p95_latency_above_escalate_threshold") &&
        src.includes("context_docs_disagree_with_live_routing"),
    },
    {
      file: "scripts/verify-runtime-config.js",
      label: "[CLIProxy] runtime config proof masks role routes and provider-param policy",
      test: () =>
        exampleProof?.llm?.screeningModel === "deepseek-v4-flash" &&
        exampleProof?.llm?.screeningBaseUrl === "https://api.deepseek.com" &&
        exampleProof?.llm?.screeningApiKeySet === "not_set" &&
        exampleProof?.llm?.screeningReasoningEffort === null &&
        exampleProof?.llm?.screeningFallbackModel === null &&
        exampleProof?.llm?.screeningFallbackBaseUrl === null &&
        exampleProof?.llm?.screeningFallbackApiKeySet === "not_set" &&
        exampleProof?.llm?.managementModel === "deepseek-v4-flash" &&
        exampleProof?.llm?.managementBaseUrl === "https://api.deepseek.com" &&
        exampleProof?.llm?.managementApiKeySet === "not_set" &&
        exampleProof?.llm?.generalModel === "deepseek-v4-flash" &&
        exampleProof?.llm?.generalBaseUrl === "https://api.deepseek.com" &&
        exampleProof?.llm?.generalApiKeySet === "not_set" &&
        exampleProof?.llm?.providerParamPolicy?.cliProxyOmitsProviderIgnore === true &&
        exampleProof?.llm?.providerParamPolicy?.dashScopeOmitsProviderIgnore === true &&
        exampleProof?.llm?.providerParamPolicy?.openRouterIncludesProviderIgnore === true,
    },
    {
      file: "docs/cliproxy-nanocap-runbook.md",
      label: "[CLIProxy] ohox-first runbook documents OAuth tunnel, verifier, and rollback",
      test: (src) =>
        src.includes("CLIProxyAPI runs on VPS `ohox`") &&
        src.includes("ssh -N -o ExitOnForwardFailure=yes -L 1455:127.0.0.1:1455 ohox") &&
        src.includes("node scripts/verify-llm-endpoint.js") &&
        src.includes("screeningReasoningEffort") &&
        src.includes("gpt-5.5") &&
        src.includes("reasoning_effort=medium") &&
        src.includes("node scripts/analyze-screener-trial.js --logs logs --hours 48 --json") &&
        src.includes("Do not restart the main `meridian`") &&
        src.includes("Rollback"),
    },
    {
      file: "config.js",
      label: "[Verifier] config.js no longer supports MERIDIAN_USER_CONFIG_PATH overrides",
      test: (src) => !src.includes("MERIDIAN_USER_CONFIG_PATH"),
    },
    {
      file: "scripts/verify-runtime-config.js",
      label: "[Verifier] runtime proof path no longer sets MERIDIAN_USER_CONFIG_PATH",
      test: (src) => !src.includes("MERIDIAN_USER_CONFIG_PATH"),
    },
    {
      file: "config-builder.js",
      label: "[Patch 6] stopLossCooldownHours mapped into config.management",
      test: (src) => /stopLossCooldownHours:\s*u\.stopLossCooldownHours\s*\?\?\s*12/.test(src),
    },
    {
      file: "config-builder.js",
      label: "[Stop-loss trial] confirmed stop-loss and snapshot config keys mapped",
      test: (src) =>
        /stopLossConfirmDelayMs:\s*u\.stopLossConfirmDelayMs\s*\?\?\s*0/.test(src) &&
        /hardStopLossPct:\s*u\.hardStopLossPct\s*\?\?\s*null/.test(src) &&
        /pnlSnapshotLoggingEnabled:\s*u\.pnlSnapshotLoggingEnabled\s*\?\?\s*false/.test(src),
    },
    {
      file: "config-builder.js",
      label: "[Emergency stop] fast and velocity stop config maps into runtime config",
      test: (src) =>
        src.includes("stopLossFastClosePct") &&
        src.includes("stopLossVelocityWindowMs") &&
        src.includes("stopLossVelocityClosePct") &&
        src.includes("profitGivebackEmergencyEnabled") &&
        src.includes("profitGivebackTriggerPct") &&
        src.includes("profitGivebackFloorPct") &&
        src.includes("isNanocapPreset ? -10 : null") &&
        src.includes("isNanocapPreset ? 90_000 : null") &&
        src.includes("isNanocapPreset ? -3 : null"),
    },
    {
      file: "config-builder.js",
      label: "[Rolling drawdown] deterministic exit config maps into runtime config with default-disabled gate",
      test: (src) =>
        src.includes("rollingDrawdownExitEnabled: u.rollingDrawdownExitEnabled ?? false") &&
        src.includes("rollingDrawdownWindowMs: u.rollingDrawdownWindowMs ?? 5_400_000") &&
        src.includes("rollingDrawdownMinPeakPct: u.rollingDrawdownMinPeakPct ?? 1") &&
        src.includes("rollingDrawdownCurrentPnlPct: u.rollingDrawdownCurrentPnlPct ?? -2") &&
        src.includes("rollingDrawdownMinDropPct: u.rollingDrawdownMinDropPct ?? 4"),
    },
    {
      file: "tools/executor.js",
      label: "[Rolling drawdown] update_config maps operator-tunable rolling drawdown fields",
      test: (src) =>
        src.includes('rollingDrawdownExitEnabled: ["management", "rollingDrawdownExitEnabled"]') &&
        src.includes('rollingDrawdownWindowMs: ["management", "rollingDrawdownWindowMs"]') &&
        src.includes('rollingDrawdownMinPeakPct: ["management", "rollingDrawdownMinPeakPct"]') &&
        src.includes('rollingDrawdownCurrentPnlPct: ["management", "rollingDrawdownCurrentPnlPct"]') &&
        src.includes('rollingDrawdownMinDropPct: ["management", "rollingDrawdownMinDropPct"]'),
    },
    {
      file: "config-builder.js",
      label: "[Falling-knife veto] deterministic nanocap veto config maps into runtime config",
      test: (src) =>
        src.includes("fallingKnifeVetoEnabled") &&
        src.includes("fallingKnifeMaxPriceChange1hPct") &&
        src.includes("fallingKnifeSeverePriceChangePct") &&
        src.includes("fallingKnifeMinSellBuyRatio") &&
        src.includes("suspiciousVolumeVetoEnabled") &&
        src.includes("suspiciousVolumeMaxMcapToGlobalFeesRatio") &&
        src.includes("suspiciousVolumeMinGlobalFeesSol"),
    },
    {
      file: "config-builder.js",
      label: "[Patch 6] repeat low-yield config defaults mapped",
      test: (src) =>
        src.includes("repeatLowYieldCooldownEnabled") &&
        src.includes("repeatLowYieldCooldownTriggerCount") &&
        src.includes("repeatLowYieldCooldownLookbackHours") &&
        src.includes("repeatLowYieldCooldownHours") &&
        src.includes('repeatLowYieldCooldownScope: u.repeatLowYieldCooldownScope ?? "token"'),
    },
    {
      file: "pool-memory.js",
      label: "[Patch 6] stop-loss fallback still reads config.management?.stopLossCooldownHours ?? 12",
      test: (src) => src.includes("config.management?.stopLossCooldownHours ?? 12"),
    },
    {
      file: "pool-memory.js",
      label: "[Patch 9] stop-loss-family close reasons use the stop-loss cooldown path",
      test: (src) =>
        src.includes("function isEarlyDumpCloseReason") &&
        src.includes("function isRollingFastDrawdownCloseReason") &&
        src.includes("function isStopLossCooldownCloseReason") &&
        src.includes("function getStopLossCooldownReason") &&
        src.includes("isRollingFastDrawdownCloseReason(text)") &&
        src.includes('if (isRollingFastDrawdownCloseReason(reason)) return "rolling fast drawdown"') &&
        src.includes("cooldownReason = getStopLossCooldownReason(deploy.close_reason)"),
    },
    {
      file: "index.js",
      label: "[Patch 9] PnL poll direct stop-loss closes preserve the original reason label",
      test: (src) =>
        !src.includes("reason: `Trailing TP: ${exit.reason}`") &&
        !src.includes("reason: `Trailing TP: ${closeRule.reason}`") &&
        src.includes("reason: exit.reason") &&
        src.includes("reason: closeRule.reason"),
    },
    {
      file: "index.js",
      label: "[Runtime] deterministic low-yield age gate reads config.management.minAgeBeforeYieldCheck",
      test: (src) =>
        src.includes("(position.age_minutes ?? 0) >= (managementConfig.minAgeBeforeYieldCheck ?? 60)") &&
        !src.includes("(position.age_minutes ?? 0) >= 60"),
    },
    {
      file: "index.js",
      label: "[Stop-loss trial] PnL snapshots write compact JSONL from poller",
      test: (src) =>
        src.includes("pnl-snapshots-") &&
        src.includes("pnlSnapshotLoggingEnabled") &&
        src.includes("appendPnlSnapshot(result.wallet, p, exit)") &&
        src.includes('event: "pnl_snapshot"') &&
        src.includes("stopCandidate"),
    },
    {
      file: "state.js",
      label: "[Stop-loss trial] soft stop-loss becomes a confirmation candidate when enabled",
      test: (src) =>
        src.includes("buildStopLossExitDecision") &&
        src.includes("appendPnlHistory"),
    },
    {
      file: "state.js",
      label: "[Emergency stop] state persists compact PnL history for velocity stop decisions",
      test: (src) =>
        src.includes("MAX_PNL_HISTORY_POINTS") &&
        src.includes("pnl_history") &&
        src.includes("pnl_history_started_at") &&
        src.includes("calculatePnlVelocityDrop") &&
        src.includes("velocity stop needs one prior sample"),
    },
    {
      file: "index.js",
      label: "[Stop-loss trial] confirmation scheduler uses shared confirmed/rejected helper",
      test: (src) =>
        src.includes("_stopLossConfirmTimers") &&
        src.includes("scheduleStopLossConfirmation") &&
        src.includes("buildStopLossConfirmationResult") &&
        src.includes("close_position"),
    },
    {
      file: "stop-loss-policy.js",
      label: "[Stop-loss trial] shared confirmation helper labels confirmed and rejected rechecks",
      test: (src) =>
        src.includes("buildStopLossConfirmationResult") &&
        src.includes("Stop loss confirmed:") &&
        src.includes("Stop loss candidate rejected:"),
    },
    {
      file: "stop-loss-policy.js",
      label: "[Emergency stop] shared policy helper labels hard, fast, velocity, and soft stop outcomes",
      test: (src) =>
        src.includes("buildStopLossExitDecision") &&
        src.includes("calculatePnlVelocityDrop") &&
        src.includes("Hard stop loss:") &&
        src.includes("Fast stop loss:") &&
        src.includes("Velocity stop loss:") &&
        src.includes("Stop loss candidate:") &&
        src.includes("includeSoftStop"),
    },
    {
      file: "tools/screening.js",
      label: "[Falling-knife veto] screening drops deterministic falling-knife and suspicious-volume candidates before LLM with audit logging",
      test: (src) =>
        src.includes("getFallingKnifeVetoReason") &&
        src.includes("getSuspiciousVolumeVetoReason") &&
        src.includes("getDeterministicCandidateVetoReason") &&
        src.includes("getDeterministicVetoAuditSnapshot") &&
        src.includes("formatDeterministicVetoAuditLine") &&
        src.includes("enrichJupiterTokenSnapshots") &&
        src.includes("falling knife veto:") &&
        src.includes("suspicious volume/fees veto:") &&
        src.includes("Deterministic veto: dropped") &&
        src.includes("mcap_global_fees_ratio") &&
        src.includes("pushFilteredReason(filteredOut, p, vetoReason"),
    },
    {
      file: "tools/dlmm.js",
      label: "[Narrow range guard] deploy path ignores zero pct range overrides, audits raw/normalized ranges, and rejects tiny single-side SOL bid_ask ranges",
      test: (src) =>
        narrowRangeGuardProof?.success === true &&
        Number(narrowRangeGuardProof?.guard_defaults?.minSingleSidedSolBins) === 35 &&
        Number(narrowRangeGuardProof?.incident_zero_pct?.normalized?.activeBinsBelow) === 79 &&
        narrowRangeGuardProof?.incident_zero_pct?.normalized?.percent_inputs?.downside_pct_used === false &&
        narrowRangeGuardProof?.incident_zero_pct?.normalized?.percent_inputs?.upside_pct_used === false &&
        narrowRangeGuardProof?.incident_zero_pct?.guard_ok === true &&
        Array.isArray(narrowRangeGuardProof?.rejected) &&
        narrowRangeGuardProof.rejected.some((entry) => Number(entry.bins_below) === 0) &&
        narrowRangeGuardProof.rejected.some((entry) => Number(entry.bins_below) === 1) &&
        narrowRangeGuardProof.rejected.some((entry) => Number(entry.bins_below) === 4) &&
        narrowRangeGuardProof.rejected.every((entry) => String(entry.reason || "").includes("configured minimum 35")) &&
        Array.isArray(narrowRangeGuardProof?.accepted) &&
        narrowRangeGuardProof.accepted.some((entry) => Number(entry.bins_below) === 35) &&
        narrowRangeGuardProof.accepted.some((entry) => Number(entry.bins_below) === 85) &&
        src.includes("normalizeDeployRangeInputs") &&
        src.includes("validateSingleSidedSolBidAskRange") &&
        src.includes("[range-raw]") &&
        src.includes("[range-normalized]") &&
        src.includes("[narrow-range-guard]"),
    },
    {
      file: "tools/executor.js",
      label: "[Nanocap single-side bid_ask] executor repairs forced SOL-only deploy args before safety and preserves corrected retry path",
      test: (src) =>
        nanocapSingleSideBidAskProof?.success === true &&
        nanocapSingleSideBidAskProof?.config?.preset_default_forceSingleSidedSolBidAsk === true &&
        nanocapSingleSideBidAskProof?.config?.example_forceSingleSidedSolBidAsk === true &&
        nanocapSingleSideBidAskProof?.active_strategy_example?.lp_strategy === "bid_ask" &&
        nanocapSingleSideBidAskProof?.active_strategy_example?.single_side === "sol" &&
        Number(nanocapSingleSideBidAskProof?.active_strategy_example?.bins_above) === 0 &&
        Number(nanocapSingleSideBidAskProof?.active_strategy_example?.bins_below) === 85 &&
        nanocapSingleSideBidAskProof?.repairs_and_rejections?.spotRepair?.args?.strategy === "bid_ask" &&
        nanocapSingleSideBidAskProof?.repairs_and_rejections?.dualSidedReject?.ok === false &&
        nanocapSingleSideBidAskProof?.repairs_and_rejections?.dualSidedReject?.retryableToolArgs === true &&
        Number(nanocapSingleSideBidAskProof?.repairs_and_rejections?.binsAboveRepair?.args?.bins_above) === 0 &&
        Number(nanocapSingleSideBidAskProof?.repairs_and_rejections?.halfAmountRepair?.args?.amount_y) === 0.8 &&
        nanocapSingleSideBidAskProof?.repairs_and_rejections?.upsideReject?.ok === false &&
        nanocapSingleSideBidAskProof?.bad_live_pattern?.would_hit_min_deploy_safety_block === false &&
        nanocapSingleSideBidAskProof?.source_markers?.agent_retryable_arg_rejection === true &&
        src.includes("normalizeForcedSingleSidedSolBidAskArgs") &&
        src.includes("[forced-single-side-bidask]"),
    },
    {
      file: "scripts/analyze-pnl-snapshots.js",
      label: "[Stop-loss trial] read-only PnL snapshot analyzer present",
      test: (src) =>
        src.includes("pnl-snapshots-") &&
        src.includes("THRESHOLDS = [-8, -10, -12, -15, -25]") &&
        src.includes("crossedMinus8RecoveredAbove0") &&
        src.includes("crossedMinus8ReachedTrailingTrigger") &&
        !src.includes("getMyPositions") &&
        !src.includes("executeTool"),
    },
    {
      file: "scripts/verify-stop-loss-trial-behavior.js",
      label: "[Stop-loss trial] synthetic behavior proof covers soft, hard, early, legacy, confirm, and reject",
      test: () =>
        stopLossBehaviorProof?.success === true &&
        stopLossBehaviorProof?.softCandidate?.action === "STOP_LOSS_CANDIDATE" &&
        stopLossBehaviorProof?.softCandidate?.needsConfirmation === true &&
        Number(stopLossBehaviorProof?.softCandidate?.confirmDelayMs) === 15000 &&
        String(stopLossBehaviorProof?.softCandidate?.reason || "").startsWith("Stop loss candidate:") &&
        stopLossBehaviorProof?.hardStop?.action === "STOP_LOSS" &&
        stopLossBehaviorProof?.hardStop?.urgent === true &&
        String(stopLossBehaviorProof?.hardStop?.reason || "").startsWith("Hard stop loss:") &&
        stopLossBehaviorProof?.earlyDump?.action === "STOP_LOSS" &&
        String(stopLossBehaviorProof?.earlyDump?.reason || "").startsWith("Early dump:") &&
        stopLossBehaviorProof?.legacyNoDelay?.action === "STOP_LOSS" &&
        String(stopLossBehaviorProof?.legacyNoDelay?.reason || "").startsWith("Stop loss:") &&
        stopLossBehaviorProof?.confirmedRecheck?.confirmed === true &&
        String(stopLossBehaviorProof?.confirmedRecheck?.closeReason || "").startsWith("Stop loss confirmed:") &&
        stopLossBehaviorProof?.rejectedRecheck?.rejected === true &&
        String(stopLossBehaviorProof?.rejectedRecheck?.rejectionReason || "").startsWith("Stop loss candidate rejected:") &&
        stopLossBehaviorProof?.tempStateFileCreated === true &&
        stopLossBehaviorProof?.tempDirRemoved === true,
    },
    {
      file: "scripts/verify-emergency-stop-policy.js",
      label: "[Emergency stop] synthetic behavior proof covers fast, velocity, ordinary soft, and hard stops",
      test: () =>
        emergencyStopProof?.success === true &&
        emergencyStopProof?.fastStop?.action === "STOP_LOSS" &&
        emergencyStopProof?.fastStop?.urgent === true &&
        String(emergencyStopProof?.fastStop?.reason || "").startsWith("Fast stop loss:") &&
        emergencyStopProof?.velocityStop?.action === "STOP_LOSS" &&
        emergencyStopProof?.velocityStop?.urgent === true &&
        String(emergencyStopProof?.velocityStop?.reason || "").startsWith("Velocity stop loss:") &&
        emergencyStopProof?.givebackExit?.action === "PROFIT_GIVEBACK" &&
        emergencyStopProof?.givebackExit?.urgent === true &&
        String(emergencyStopProof?.givebackExit?.reason || "").startsWith("Profit giveback emergency:") &&
        emergencyStopProof?.ordinarySoft?.action === "STOP_LOSS_CANDIDATE" &&
        emergencyStopProof?.ordinarySoft?.needsConfirmation === true &&
        Number(emergencyStopProof?.ordinarySoft?.confirmDelayMs) === 15000 &&
        emergencyStopProof?.hardStop?.action === "STOP_LOSS" &&
        emergencyStopProof?.hardStop?.urgent === true &&
        String(emergencyStopProof?.hardStop?.reason || "").startsWith("Hard stop loss:") &&
        emergencyStopProof?.youngHardStop?.action === "STOP_LOSS" &&
        emergencyStopProof?.youngHardStop?.urgent === true &&
        String(emergencyStopProof?.youngHardStop?.reason || "").startsWith("Hard stop loss:") &&
        emergencyStopProof?.youngFastStop?.action === "STOP_LOSS" &&
        emergencyStopProof?.youngFastStop?.urgent === true &&
        String(emergencyStopProof?.youngFastStop?.reason || "").startsWith("Fast stop loss:") &&
        emergencyStopProof?.youngVelocityStop?.action === "STOP_LOSS" &&
        emergencyStopProof?.youngVelocityStop?.urgent === true &&
        String(emergencyStopProof?.youngVelocityStop?.reason || "").startsWith("Velocity stop loss:") &&
        emergencyStopProof?.youngEarlyDump?.action === "STOP_LOSS" &&
        String(emergencyStopProof?.youngEarlyDump?.reason || "").startsWith("Early dump:") &&
        emergencyStopProof?.tempStateFileCreated === true &&
        emergencyStopProof?.tempDirRemoved === true,
    },
    {
      file: "scripts/verify-rolling-drawdown-exit-policy.js",
      label: "[Rolling drawdown] synthetic proof covers fire/no-fire cases, urgent STOP_LOSS integration, and preserved emergency stops",
      test: () =>
        rollingDrawdownExitProof?.success === true &&
        rollingDrawdownExitProof?.pureDecision?.action === "STOP_LOSS" &&
        rollingDrawdownExitProof?.pureDecision?.urgent === true &&
        String(rollingDrawdownExitProof?.pureDecision?.reason || "").startsWith("Rolling fast drawdown:") &&
        rollingDrawdownExitProof?.fireExit?.action === "STOP_LOSS" &&
        rollingDrawdownExitProof?.fireExit?.urgent === true &&
        String(rollingDrawdownExitProof?.fireExit?.reason || "").startsWith("Rolling fast drawdown:") &&
        rollingDrawdownExitProof?.noTriggerCases?.lowPeak === true &&
        rollingDrawdownExitProof?.noTriggerCases?.currentHigh === true &&
        rollingDrawdownExitProof?.noTriggerCases?.smallDrop === true &&
        rollingDrawdownExitProof?.noTriggerCases?.stale === true &&
        rollingDrawdownExitProof?.noTriggerCases?.disabled === true &&
        rollingDrawdownExitProof?.noTriggerCases?.suspicious === true &&
        rollingDrawdownExitProof?.preservedStops?.hard?.urgent === true &&
        String(rollingDrawdownExitProof?.preservedStops?.hard?.reason || "").startsWith("Hard stop loss:") &&
        rollingDrawdownExitProof?.preservedStops?.fast?.urgent === true &&
        String(rollingDrawdownExitProof?.preservedStops?.fast?.reason || "").startsWith("Fast stop loss:") &&
        rollingDrawdownExitProof?.preservedStops?.velocity?.urgent === true &&
        String(rollingDrawdownExitProof?.preservedStops?.velocity?.reason || "").startsWith("Velocity stop loss:") &&
        Number(rollingDrawdownExitProof?.fireHistoryPoints) >= 2 &&
        rollingDrawdownExitProof?.tempStateFileCreated === true &&
        rollingDrawdownExitProof?.tempDirRemoved === true,
    },
    {
      file: "scripts/verify-falling-knife-veto.js",
      label: "[Falling-knife veto] synthetic proof vetoes LARP-like setup, audits fields, and preserves benign 5m setup",
      test: () =>
        fallingKnifeProof?.success === true &&
        fallingKnifeProof?.larpLike?.vetoed === true &&
        String(fallingKnifeProof?.larpLike?.reason || "").startsWith("falling knife veto:") &&
        String(fallingKnifeProof?.larpLike?.reason || "").includes("price_change=-48.8%") &&
        String(fallingKnifeProof?.larpLike?.reason || "").includes("sell/buy=1.66") &&
        Number(fallingKnifeProof?.larpLike?.audit?.price_change_pct?.toFixed(1)) === -48.8 &&
        Number(fallingKnifeProof?.larpLike?.audit?.sell_buy_ratio?.toFixed(2)) === 1.66 &&
        Math.round(Number(fallingKnifeProof?.larpLike?.audit?.mcap_global_fees_ratio)) === 21090 &&
        Number(fallingKnifeProof?.larpLike?.audit?.token_age_hours) === 66 &&
        String(fallingKnifeProof?.larpLike?.auditLine || "").includes("Deterministic veto: dropped LARP-SOL") &&
        String(fallingKnifeProof?.larpLike?.auditLine || "").includes("mcap/global_fees=21090") &&
        fallingKnifeProof?.benignOversold?.vetoed === false &&
        fallingKnifeProof?.benign5mFrequency?.vetoed === false &&
        fallingKnifeProof?.ratioFallingKnife?.vetoed === true &&
        fallingKnifeProof?.suspiciousVolume?.vetoed === true,
    },
    {
      file: "performance-metrics.js",
      label: "[Material wins] canonical raw/material/neutral classifier present",
      test: (src) =>
        src.includes("classifyMaterialOutcome") &&
        src.includes("summarizeMaterialPerformance") &&
        src.includes("material_win") &&
        src.includes("neutral_reason") &&
        src.includes("close_reason_bucket"),
    },
    {
      file: "config-builder.js",
      label: "[Material wins] performance thresholds and Darwin material mode map into runtime config",
      test: (src) =>
        src.includes("performance: {") &&
        src.includes("materialWinPct") &&
        src.includes("materialLossPct") &&
        src.includes("dustNeutralAbsPct") &&
        src.includes("darwinUseMaterialOutcomes") &&
        src.includes("darwinExcludeNeutralOutcomes"),
    },
    {
      file: "tools/executor.js",
      label: "[Material wins] update_config executor maps all material outcome fields",
      test: (src) => MATERIAL_UPDATE_CONFIG_FIELDS.every((key) => materialConfigMapEntryPresent(src, key)),
    },
    {
      file: "tools/definitions.js",
      label: "[Material wins] definitions document operator-tunable material outcome fields",
      test: (src) =>
        src.includes("OPERATOR_UPDATE_CONFIG_MATERIAL_OUTCOME_FIELDS") &&
        src.includes("live-tunable through operator-only") &&
        src.includes("Raw WR/Material WR reporting") &&
        src.includes("Darwin material learning only") &&
        src.includes("not stop-loss, TP, entry, sizing, routing, or GMGN policy") &&
        MATERIAL_UPDATE_CONFIG_FIELDS.every((key) => materialDefinitionsFieldPresent(src, key)),
    },
    {
      file: "tools/definitions.js",
      label: "[Material wins] update_config executor and definitions agree on material outcome fields",
      test: (src) => {
        const executor = loadSource("tools/executor.js");
        return MATERIAL_UPDATE_CONFIG_FIELDS.every((key) =>
          materialDefinitionsFieldPresent(src, key) &&
          materialConfigMapEntryPresent(executor, key)
        );
      },
    },
    {
      file: "index.js",
      label: "[Material wins] owner-facing reports label Raw WR and Material WR explicitly",
      test: (src) => {
        const briefing = loadSource("briefing.js");
        const poolMemory = loadSource("pool-memory.js");
        const analyzer = loadSource("scripts/analyze-material-wins.js");
        return src.includes("Raw WR") &&
          src.includes("Material WR") &&
          briefing.includes("Raw WR") &&
          briefing.includes("Material WR") &&
          poolMemory.includes("raw WR") &&
          poolMemory.includes("material WR") &&
          analyzer.includes("Raw WR") &&
          analyzer.includes("Material WR") &&
          !src.includes("  Win rate:");
      },
    },
    {
      file: "lessons.js",
      label: "[Material wins] new performance records store material outcome fields",
      test: (src) =>
        src.includes("classifyMaterialOutcome") &&
        src.includes("raw_win: entry.raw_win") &&
        src.includes("material_outcome: entry.material_outcome") &&
        src.includes("material_win_rate_pct") &&
        src.includes("raw_win_rate_pct"),
    },
    {
      file: "pool-memory.js",
      label: "[Material wins] pool memory stores Material WR and neutral close counts",
      test: (src) =>
        src.includes("material_win_rate") &&
        src.includes("neutral_close_count") &&
        src.includes("low_yield_neutral_count") &&
        src.includes("POOL MEMORY") &&
        src.includes("raw WR") &&
        src.includes("material WR"),
    },
    {
      file: "signal-weights.js",
      label: "[Material wins] Darwin excludes neutral low-yield/dust outcomes in material mode",
      test: (src) =>
        src.includes("getMaterialOutcomeOptions") &&
        src.includes("classifyMaterialOutcome") &&
        src.includes("neutral_excluded") &&
        src.includes("material_learning_records") &&
        src.includes("Only ${learningRecords.length} material learning records"),
    },
    {
      file: "scripts/analyze-material-wins.js",
      label: "[Material wins] read-only action-log analyzer reports raw/material/neutral metrics",
      test: (src) =>
        src.includes("analyze-material-wins") &&
        src.includes("summarizeMaterialPerformance") &&
        src.includes("material_ev_per_deployed_sol_pct") &&
        src.includes("worst_stop_loss_tails") &&
        src.includes("top_material_wins") &&
        !src.includes("getMyPositions") &&
        !src.includes("deploy_position(") &&
        !src.includes("closePosition("),
    },
    {
      file: "scripts/verify-material-win-metrics.js",
      label: "[Material wins] synthetic verifier proves low-yield dust is neutral and Darwin learns from material outcomes",
      test: () =>
        materialProof?.success === true &&
        materialProof?.cases?.lowYieldDustWin?.raw_win === true &&
        materialProof?.cases?.lowYieldDustWin?.material_outcome === "neutral" &&
        materialProof?.cases?.lowYieldDustWin?.material_win === false &&
        materialProof?.cases?.tinyTrailingTp?.material_outcome === "neutral" &&
        materialProof?.cases?.materialTrailingTp?.material_outcome === "material_win" &&
        materialProof?.cases?.operatorDust?.material_outcome === "neutral" &&
        materialProof?.cases?.operatorMaterialLoss?.material_outcome === "material_loss" &&
        materialProof?.cases?.stopLoss?.material_outcome === "material_loss" &&
        materialProof?.cases?.hardStopLoss?.material_outcome === "material_loss" &&
        materialProof?.cases?.positiveOor?.material_outcome === "material_win" &&
        materialProof?.cases?.negativeOor?.material_outcome === "material_loss" &&
        materialProof?.darwinProof?.neutral_excluded === 3 &&
        materialProof?.darwinProof?.material_learning_records === 4,
    },
    {
      file: "pool-memory.js",
      label: "[Hygiene] repeat low-yield helper present and default-gated",
      test: (src) =>
        src.includes("function isLowYieldCloseReason") &&
        src.includes("config.management.repeatLowYieldCooldownEnabled"),
    },
    {
      file: "scripts/verify-runtime-config.js",
      label: "[Runtime] explicit proof path resolves defaults when supplied user-config file is absent",
      test: () =>
        defaultProof.userConfigExists === false &&
        Number(defaultProof?.management?.stopLossCooldownHours) === 12 &&
        Number(defaultProof?.management?.oorCooldownHours) === 12 &&
        Number(defaultProof?.management?.minAgeBeforeYieldCheck) === 60,
    },
    {
      file: "scripts/verify-runtime-config.js",
      label: "[Runtime] stop-loss trial defaults preserve legacy behavior until enabled",
      test: () =>
        defaultProof.userConfigExists === false &&
        Number(defaultProof?.management?.stopLossConfirmDelayMs) === 0 &&
        defaultProof?.management?.hardStopLossPct === null &&
        defaultProof?.management?.rollingDrawdownExitEnabled === false &&
        Number(defaultProof?.management?.rollingDrawdownWindowMs) === 5400000 &&
        Number(defaultProof?.management?.rollingDrawdownMinPeakPct) === 1 &&
        Number(defaultProof?.management?.rollingDrawdownCurrentPnlPct) === -2 &&
        Number(defaultProof?.management?.rollingDrawdownMinDropPct) === 4 &&
        defaultProof?.management?.pnlSnapshotLoggingEnabled === false,
    },
    {
      file: "scripts/verify-runtime-config.js",
      label: "[Runtime] material outcome defaults enable 1% material threshold and Darwin material mode",
      test: () =>
        defaultProof.userConfigExists === false &&
        Number(defaultProof?.performance?.materialWinPct) === 1 &&
        Number(defaultProof?.performance?.materialLossPct) === -1 &&
        Number(defaultProof?.performance?.dustNeutralAbsPct) === 1 &&
        defaultProof?.performance?.darwinUseMaterialOutcomes === true &&
        defaultProof?.performance?.darwinExcludeNeutralOutcomes === true,
    },
    {
      file: "user-config.example.json",
      label: "[Runtime] nanocap example resolves post-LARP -8/-10/-15 emergency stop config",
      test: () =>
        exampleProof.userConfigExists === true &&
        Number(exampleProof?.management?.stopLossPct) === -8 &&
        Number(exampleProof?.management?.stopLossConfirmDelayMs) === 15000 &&
        Number(exampleProof?.management?.hardStopLossPct) === -15 &&
        Number(exampleProof?.management?.stopLossFastClosePct) === -10 &&
        Number(exampleProof?.management?.stopLossVelocityWindowMs) === 90000 &&
        Number(exampleProof?.management?.stopLossVelocityClosePct) === -3 &&
        exampleProof?.management?.rollingDrawdownExitEnabled === true &&
        Number(exampleProof?.management?.rollingDrawdownWindowMs) === 5400000 &&
        Number(exampleProof?.management?.rollingDrawdownMinPeakPct) === 1 &&
        Number(exampleProof?.management?.rollingDrawdownCurrentPnlPct) === -2 &&
        Number(exampleProof?.management?.rollingDrawdownMinDropPct) === 4 &&
        Number(exampleProof?.management?.earlyDumpPct) === -8 &&
        Number(exampleProof?.management?.earlyDumpMaxAgeMin) === 20 &&
        Number(exampleProof?.management?.trailingTriggerPct) === 6 &&
        exampleProof?.management?.profitGivebackEmergencyEnabled === true &&
        Number(exampleProof?.management?.profitGivebackTriggerPct) === 6 &&
        Number(exampleProof?.management?.profitGivebackFloorPct) === 2 &&
        exampleProof?.management?.supertrendLossExitEnabled === true &&
        Number(exampleProof?.management?.supertrendLossExitPnlPct) === -4 &&
        exampleProof?.management?.supertrendLossExitInterval === "15_MINUTE" &&
        Number(exampleProof?.management?.supertrendLossExitConfirmChecks) === 2 &&
        exampleProof?.management?.pnlSnapshotLoggingEnabled === true &&
        exampleProof?.management?.pnlSnapshotBotName === "nanocap",
    },
    {
      file: "scripts/verify-runtime-config.js",
      label: "[Runtime] Supertrend loss exit defaults stay disabled outside nanocap presets",
      test: () =>
        defaultProof.userConfigExists === false &&
        defaultProof?.management?.supertrendLossExitEnabled === false &&
        defaultProof?.management?.supertrendLossExitPnlPct === null &&
        defaultProof?.management?.supertrendLossExitInterval === "15_MINUTE" &&
        Number(defaultProof?.management?.supertrendLossExitConfirmChecks) === 2,
    },
    {
      file: "scripts/verify-supertrend-loss-exit.js",
      label: "[Runtime] synthetic Supertrend loss exit proof covers two-check close, resets, suspicious PnL, disabled config, and no live API",
      test: () =>
        supertrendLossExitProof?.success === true &&
        supertrendLossExitProof?.cases?.firstBearishPending?.pending === true &&
        Number(supertrendLossExitProof?.cases?.firstBearishPending?.count) === 1 &&
        Number(supertrendLossExitProof?.cases?.firstBearishPending?.confirmChecks) === 2 &&
        supertrendLossExitProof?.cases?.secondBearishClose?.action === "CLOSE" &&
        supertrendLossExitProof?.cases?.secondBearishClose?.indicatorPolicy === "bypass" &&
        supertrendLossExitProof?.cases?.secondBearishClose?.urgent === false &&
        supertrendLossExitProof?.cases?.bullishReset === true &&
        supertrendLossExitProof?.cases?.unknownReset === true &&
        supertrendLossExitProof?.cases?.unavailableReset === true &&
        supertrendLossExitProof?.cases?.recoveredReset === true &&
        supertrendLossExitProof?.cases?.suspiciousNoTrigger === true &&
        supertrendLossExitProof?.cases?.disabledNoTrigger === true &&
        Number(supertrendLossExitProof?.sourceSafety?.liveApiCalls) === 0 &&
        supertrendLossExitProof?.sourceSafety?.importedIndexJs === false &&
        supertrendLossExitProof?.sourceSafety?.importedChartIndicators === false,
    },
    {
      file: "user-config.example.json",
      label: "[Runtime] nanocap example resolves falling-knife and suspicious-volume veto config",
      test: () =>
        exampleProof.userConfigExists === true &&
        exampleProof?.screening?.fallingKnifeVetoEnabled === true &&
        Number(exampleProof?.screening?.fallingKnifeMaxPriceChange1hPct) === -35 &&
        Number(exampleProof?.screening?.fallingKnifeSeverePriceChangePct) === -45 &&
        Number(exampleProof?.screening?.fallingKnifeMinSellBuyRatio) === 1.25 &&
        exampleProof?.screening?.fallingKnifeRequireOversoldRsi === false &&
        exampleProof?.screening?.suspiciousVolumeVetoEnabled === true &&
        Number(exampleProof?.screening?.suspiciousVolumeMaxMcapToGlobalFeesRatio) === 12000 &&
        Number(exampleProof?.screening?.suspiciousVolumeMinGlobalFeesSol) === 20 &&
        Number(exampleProof?.screening?.suspiciousVolumeMaxTokenAgeHours) === 96 &&
        Number(exampleProof?.screening?.suspiciousVolumeMinPriceDropPct) === -25,
    },
    {
      file: "user-config.example.json",
      label: "[Runtime] nanocap example resolves expanded Meteora discovery recall",
      test: () =>
        exampleProof.userConfigExists === true &&
        Number(exampleProof?.screening?.discoveryPageSize) === 100 &&
        Array.isArray(exampleProof?.screening?.discoveryExtraCategories) &&
        exampleProof.screening.discoveryExtraCategories.includes("new") &&
        exampleProof?.screening?.excludeHighSingleOwnership === false,
    },
    {
      file: "user-config.example.json",
      label: "[Runtime] nanocap example resolves RSI2 5m entry gate",
      test: () =>
        exampleProof.userConfigExists === true &&
        exampleProof?.indicators?.enabled === true &&
        exampleProof?.indicators?.entryPreset === "rsi_reversal" &&
        exampleProof?.indicators?.exitPreset === null &&
        Number(exampleProof?.indicators?.rsiLength) === 2 &&
        Number(exampleProof?.indicators?.rsiOversold) === 30 &&
        exampleProof?.indicators?.requireAllIntervals === false &&
        Array.isArray(exampleProof?.indicators?.intervals) &&
        exampleProof.indicators.intervals.length === 1 &&
        exampleProof.indicators.intervals[0] === "5_MINUTE",
    },
    {
      file: "scripts/verify-nanocap-bollinger-canary.js",
      label: "[Runtime] nanocap RSI-5m entry proof wires shadow quality gates",
      test: () =>
        nanocapBollingerCanaryProof?.success === true &&
        nanocapBollingerCanaryProof?.exampleConfig?.entryPreset === "rsi_reversal" &&
        nanocapBollingerCanaryProof?.exampleConfig?.requireAllIntervals === false &&
        nanocapBollingerCanaryProof?.shadowGate?.strictPass === true &&
        nanocapBollingerCanaryProof?.decisionContext?.shadowQualityGatesSummarized === true &&
        nanocapBollingerCanaryProof?.sourceSafety?.noBirdeyeInLiveRuntime === true,
    },
    {
      file: "user-config.example.json",
      label: "[Runtime] nanocap example resolves material win metrics config",
      test: () =>
        exampleProof.userConfigExists === true &&
        Number(exampleProof?.performance?.materialWinPct) === 1 &&
        Number(exampleProof?.performance?.materialLossPct) === -1 &&
        Number(exampleProof?.performance?.dustNeutralAbsPct) === 1 &&
        exampleProof?.performance?.darwinUseMaterialOutcomes === true &&
        exampleProof?.performance?.darwinExcludeNeutralOutcomes === true,
    },
    {
      file: "scripts/verify-runtime-config.js",
      label: "[Runtime] repeat deploy defaults resolve cleanly under explicit proof path",
      test: () =>
        defaultProof.management?.repeatDeployCooldownEnabled === true &&
        Number(defaultProof.management?.repeatDeployCooldownTriggerCount) === 3 &&
        Number(defaultProof.management?.repeatDeployCooldownHours) === 12 &&
        defaultProof.management?.repeatDeployCooldownScope === "token" &&
        Number(defaultProof.management?.repeatDeployCooldownMinFeeEarnedPct) === 0,
    },
    {
      file: NANOCAP_USER_CONFIG_PATH,
      label: "[Runtime] nanocap cooldown proof resolves from the supplied user-config path",
      test: () =>
        nanocapConfig != null &&
        nanocapConfig.userConfigExists === true &&
        Number.isFinite(Number(nanocapUserConfig.stopLossCooldownHours)) &&
        Number.isFinite(Number(nanocapUserConfig.oorCooldownHours)) &&
        Number.isFinite(Number(nanocapUserConfig.repeatDeployCooldownHours)) &&
        nanocapConfig.effectiveUserConfigPath === NANOCAP_USER_CONFIG_PATH &&
        Number(nanocapConfig.management?.stopLossCooldownHours) === Number(nanocapUserConfig.stopLossCooldownHours) &&
        Number(nanocapConfig.management?.oorCooldownHours) === Number(nanocapUserConfig.oorCooldownHours) &&
        Number(nanocapConfig.management?.minAgeBeforeYieldCheck) === Number(nanocapUserConfig.minAgeBeforeYieldCheck) &&
        Number(nanocapConfig.management?.repeatDeployCooldownHours) === Number(nanocapUserConfig.repeatDeployCooldownHours) &&
        nanocapConfig.management?.repeatDeployCooldownScope === nanocapUserConfig.repeatDeployCooldownScope,
    },
    {
      file: NANOCAP_USER_CONFIG_PATH,
      label: "[Runtime] nanocap repeat deploy defaults resolve exactly from the supplied user-config path",
      test: () =>
        nanocapConfig != null &&
        nanocapConfig.management?.repeatDeployCooldownEnabled === nanocapUserConfig.repeatDeployCooldownEnabled &&
        Number(nanocapConfig.management?.repeatDeployCooldownTriggerCount) === Number(nanocapUserConfig.repeatDeployCooldownTriggerCount) &&
        Number(nanocapConfig.management?.repeatDeployCooldownMinFeeEarnedPct) ===
          Number(nanocapUserConfig.repeatDeployCooldownMinFeeEarnedPct ?? nanocapUserConfig.repeatDeployCooldownMinFeeYieldPct ?? 0),
    },
    {
      file: "scripts/verify-runtime-config.js",
      label: "[Runtime] repeat low-yield defaults stay disabled until explicitly enabled",
      test: () =>
        defaultProof?.management?.repeatLowYieldCooldownEnabled === false &&
        Number(defaultProof?.management?.repeatLowYieldCooldownTriggerCount) === 3 &&
        Number(defaultProof?.management?.repeatLowYieldCooldownLookbackHours) === 48 &&
        Number(defaultProof?.management?.repeatLowYieldCooldownHours) === 12 &&
        defaultProof?.management?.repeatLowYieldCooldownScope === "token",
    },
    {
      file: NANOCAP_USER_CONFIG_PATH,
      label: "[Runtime] nanocap repeat low-yield config resolves exactly from the supplied user-config path",
      test: () =>
        nanocapConfig != null &&
        nanocapConfig.management?.repeatLowYieldCooldownEnabled === (nanocapUserConfig.repeatLowYieldCooldownEnabled ?? false) &&
        Number(nanocapConfig.management?.repeatLowYieldCooldownTriggerCount) === Number(nanocapUserConfig.repeatLowYieldCooldownTriggerCount ?? 3) &&
        Number(nanocapConfig.management?.repeatLowYieldCooldownLookbackHours) === Number(nanocapUserConfig.repeatLowYieldCooldownLookbackHours ?? 48) &&
        Number(nanocapConfig.management?.repeatLowYieldCooldownHours) === Number(nanocapUserConfig.repeatLowYieldCooldownHours ?? 12) &&
        nanocapConfig.management?.repeatLowYieldCooldownScope === (nanocapUserConfig.repeatLowYieldCooldownScope ?? "token"),
    },
    {
      file: NANOCAP_USER_CONFIG_PATH,
      label: "[Runtime] nanocap material metrics resolve from supplied config/defaults",
      test: () =>
        nanocapConfig != null &&
        Number(nanocapConfig?.performance?.materialWinPct) === Number(nanocapUserConfig.materialWinPct ?? nanocapUserConfig.performance?.materialWinPct ?? 1) &&
        Number(nanocapConfig?.performance?.materialLossPct) === Number(nanocapUserConfig.materialLossPct ?? nanocapUserConfig.performance?.materialLossPct ?? -1) &&
        Number(nanocapConfig?.performance?.dustNeutralAbsPct) === Number(nanocapUserConfig.dustNeutralAbsPct ?? nanocapUserConfig.performance?.dustNeutralAbsPct ?? 1) &&
        nanocapConfig?.performance?.darwinUseMaterialOutcomes === (nanocapUserConfig.darwinUseMaterialOutcomes ?? nanocapUserConfig.performance?.darwinUseMaterialOutcomes ?? true) &&
        nanocapConfig?.performance?.darwinExcludeNeutralOutcomes === (nanocapUserConfig.darwinExcludeNeutralOutcomes ?? nanocapUserConfig.performance?.darwinExcludeNeutralOutcomes ?? true),
    },
    {
      file: "scripts/verify-early-dump-cooldown.js",
      label: "[Runtime] stop-loss-family closes write pool and token cooldowns",
      test: () =>
        earlyDumpProof?.success === true &&
        earlyDumpProof?.earlyDump?.closeReasonMatched === true &&
        earlyDumpProof?.earlyDump?.poolCooldownReason === "early dump" &&
        earlyDumpProof?.earlyDump?.tokenCooldownReason === "early dump" &&
        earlyDumpProof?.rollingFastDrawdown?.closeReasonMatched === true &&
        earlyDumpProof?.rollingFastDrawdown?.poolCooldownReason === "rolling fast drawdown" &&
        earlyDumpProof?.rollingFastDrawdown?.tokenCooldownReason === "rolling fast drawdown" &&
        earlyDumpProof?.tempStateFileCreated === true &&
        earlyDumpProof?.tempDirRemoved === true,
    },

    {
      file: "index.js",
      label: "[Patch 7] OPERATOR COMMAND Telegram wrapping (prompt injection hardening)",
      test: (src) => {
        const hasWrapper = src.includes("[OPERATOR COMMAND via Telegram]");
        const hasQuotes = src.includes('"""');
        const hasConflictGuard = src.includes("conflict with your operational rules");
        return hasWrapper && hasQuotes && hasConflictGuard;
      },
    },
    {
      file: "tools/executor.js",
      label: "[Patch 8] SECURITY: managementModel absent from CONFIG_MAP",
      test: (src) => {
        const mapMatch = src.match(/CONFIG_MAP\s*=\s*\{([\s\S]*?)\};/);
        if (!mapMatch) return true;
        return !mapMatch[1].includes("managementModel");
      },
    },
    {
      file: "tools/executor.js",
      label: "[Patch 8] SECURITY: screeningModel absent from CONFIG_MAP",
      test: (src) => {
        const mapMatch = src.match(/CONFIG_MAP\s*=\s*\{([\s\S]*?)\};/);
        if (!mapMatch) return true;
        return !mapMatch[1].includes("screeningModel");
      },
    },
    {
      file: "tools/executor.js",
      label: "[Patch 8] SECURITY: generalModel absent from CONFIG_MAP",
      test: (src) => {
        const mapMatch = src.match(/CONFIG_MAP\s*=\s*\{([\s\S]*?)\};/);
        if (!mapMatch) return true;
        return !mapMatch[1].includes("generalModel");
      },
    },
    {
      file: "tools/executor.js",
      label: "[Patch 8] model-routing comment present in CONFIG_MAP",
      test: (src) => src.includes("model routing is operator-only") && src.includes("not LLM-mutable"),
    },
    {
      file: "hivemind.js",
      label: "[Upstream] HiveMind module present",
      test: (src) => src.includes("bootstrapHiveMind") || src.includes("hiveMind") || src.includes("HiveMind"),
    },
    {
      file: "index.js",
      label: "[Upstream] Telegram /pause command present",
      test: (src) => src.includes("/pause"),
    },
    {
      file: "index.js",
      label: "[Upstream] Telegram /resume command present",
      test: (src) => src.includes("/resume"),
    },
    {
      file: "index.js",
      label: "[Upstream] Telegram /deploy <n> command present",
      test: (src) => /\/deploy\s/.test(src) || src.includes("/deploy <"),
    },
    {
      file: "tools/executor.js",
      label: "[Upstream] Discord signal config keys in CONFIG_MAP",
      test: (src) => src.includes("useDiscordSignals") || src.includes("discordSignalMode"),
    },
    {
      file: "tools/wallet.js",
      label: "[Upstream] Jupiter v2 swap endpoint present",
      test: (src) => src.includes("v6") || src.includes("jup.ag") || src.includes("jupiter"),
    },
  ];
}

function main() {
  const checks = buildChecks();

  let failed = 0;
  let passed = 0;

  console.log("\n-- Meridian Patch Verification --------------------------------\n");
  console.log("  Includes runtime-truth checks for nanocap cooldown mapping, early-dump cooldown classification, confirmed stop-loss trial config, Supertrend loss exit, narrow-range deploy guard, material win metrics, upstream env/relay security hardening, owner relay guard evidence, CLIProxy screener routing, GPT-5.5 screener trial telemetry, and offline Birdeye decision-context logging.\n");

  for (const check of checks) {
    let src = "";
    if (!check.file.startsWith("/")) {
      try {
        src = loadSource(check.file);
      } catch {
        console.log(`FAIL  [FILE MISSING] ${check.file} -- ${check.label}`);
        failed += 1;
        continue;
      }
    } else if (!existsSync(check.file)) {
      console.log(`FAIL  [FILE MISSING] ${check.file} -- ${check.label}`);
      failed += 1;
      continue;
    }

    const pass = check.test(src);
    if (pass) {
      console.log(`PASS  ${check.label}`);
      passed += 1;
    } else {
      console.log(`FAIL  ${check.label}  [${check.file}]`);
      failed += 1;
    }
  }

  console.log("\n----------------------------------------------------------------");
  if (failed === 0) {
    console.log(`PASS  All ${passed} checks passed. Safe to proceed.\n`);
    process.exit(0);
  }

  console.error(`\nFAIL  ${failed} check(s) failed -- do NOT restart or deploy.\n`);
  console.error("      Fix the missing patches, then re-run: node scripts/verify-patches.js\n");
  process.exit(1);
}

main();
