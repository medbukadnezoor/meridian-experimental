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
const REPO_LOCAL_USER_CONFIG_PATH = join(ROOT, "user-config.json");
const NANOCAP_USER_CONFIG_PATH = existsSync(SYNCED_NANOCAP_USER_CONFIG_PATH)
  ? SYNCED_NANOCAP_USER_CONFIG_PATH
  : REPO_LOCAL_USER_CONFIG_PATH;
const NANOCAP_EXAMPLE_CONFIG_PATH = join(ROOT, "user-config.example.json");
const RUNTIME_CONFIG_VERIFIER_PATH = join(__dirname, "verify-runtime-config.js");
const EARLY_DUMP_COOLDOWN_VERIFIER_PATH = join(__dirname, "verify-early-dump-cooldown.js");
const STOP_LOSS_TRIAL_BEHAVIOR_VERIFIER_PATH = join(__dirname, "verify-stop-loss-trial-behavior.js");
const MATERIAL_WIN_METRICS_VERIFIER_PATH = join(__dirname, "verify-material-win-metrics.js");
const UPSTREAM_SECURITY_HARDENING_VERIFIER_PATH = join(__dirname, "verify-upstream-security-hardening.js");
const RELAY_GUARD_EVIDENCE_VERIFIER_PATH = join(__dirname, "verify-relay-guard-evidence.js");
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
  const materialProof = runMaterialWinMetricsProof();
  const upstreamSecurityProof = runUpstreamSecurityHardeningProof();
  const relayGuardEvidenceProof = runRelayGuardEvidenceSelfTest();

  return [
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
      label: "[Patch 9] early-dump close reasons use the stop-loss cooldown path",
      test: (src) =>
        src.includes("function isEarlyDumpCloseReason") &&
        src.includes("function isStopLossCooldownCloseReason") &&
        src.includes('cooldownReason = isEarlyDumpCloseReason(deploy.close_reason) ? "early dump" : "stop loss"'),
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
        src.includes('action: "STOP_LOSS_CANDIDATE"') &&
        src.includes("stopLossConfirmDelayMs > 0") &&
        src.includes("mgmtConfig.hardStopLossPct == null") &&
        src.includes("Stop loss candidate:") &&
        src.includes("Hard stop loss:"),
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
      label: "[Runtime] nanocap example resolves confirmed -8/-15 stop-loss trial config",
      test: () =>
        exampleProof.userConfigExists === true &&
        Number(exampleProof?.management?.stopLossPct) === -8 &&
        Number(exampleProof?.management?.stopLossConfirmDelayMs) === 15000 &&
        Number(exampleProof?.management?.hardStopLossPct) === -15 &&
        Number(exampleProof?.management?.earlyDumpPct) === -8 &&
        Number(exampleProof?.management?.earlyDumpMaxAgeMin) === 20 &&
        exampleProof?.management?.pnlSnapshotLoggingEnabled === true &&
        exampleProof?.management?.pnlSnapshotBotName === "nanocap",
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
      label: "[Runtime] legacy-prefixed early-dump close writes pool and token cooldowns",
      test: () =>
        earlyDumpProof?.success === true &&
        earlyDumpProof?.closeReasonMatched === true &&
        earlyDumpProof?.poolCooldownReason === "early dump" &&
        earlyDumpProof?.tokenCooldownReason === "early dump" &&
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
  console.log("  Includes runtime-truth checks for nanocap cooldown mapping, early-dump cooldown classification, confirmed stop-loss trial config, material win metrics, upstream env/relay security hardening, and owner relay guard evidence.\n");

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
