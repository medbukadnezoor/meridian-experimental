#!/usr/bin/env node
/**
 * Read-only runtime-config proof helper.
 *
 * Resolves config through the shared config-builder against an explicit
 * user-config path without touching the live runtime loader or repo state.
 */

import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { resolveConfigFromPath } from "../config-builder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const RUNTIME_CONFIG_PATH = join(ROOT, "config.js");
const CONFIG_BUILDER_PATH = join(ROOT, "config-builder.js");
const REPO_LOCAL_USER_CONFIG_PATH = join(ROOT, "user-config.json");

function printUsage() {
  console.error("Usage: node scripts/verify-runtime-config.js [--user-config <path>] [--json]");
}

function parseArgs(argv) {
  const options = {
    json: false,
    userConfigPath: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--user-config") {
      const next = argv[i + 1];
      if (!next) {
        printUsage();
        process.exit(1);
      }
      options.userConfigPath = resolve(next);
      i += 1;
      continue;
    }
    printUsage();
    console.error(`Unknown argument: ${arg}`);
    process.exit(1);
  }

  return options;
}

function buildProof(imported, requestedUserConfigPath) {
  const llm = imported.config.llm;
  return {
    runtimeConfigPath: RUNTIME_CONFIG_PATH,
    configBuilderPath: CONFIG_BUILDER_PATH,
    requestedUserConfigPath,
    effectiveUserConfigPath: imported.userConfigPath,
    userConfigExists: imported.userConfigExists,
    management: {
      stopLossCooldownHours: imported.config.management.stopLossCooldownHours,
      oorCooldownHours: imported.config.management.oorCooldownHours,
      repeatDeployCooldownEnabled: imported.config.management.repeatDeployCooldownEnabled,
      repeatDeployCooldownTriggerCount: imported.config.management.repeatDeployCooldownTriggerCount,
      repeatDeployCooldownHours: imported.config.management.repeatDeployCooldownHours,
      repeatDeployCooldownScope: imported.config.management.repeatDeployCooldownScope,
      repeatDeployCooldownMinFeeEarnedPct: imported.config.management.repeatDeployCooldownMinFeeEarnedPct,
      repeatLowYieldCooldownEnabled: imported.config.management.repeatLowYieldCooldownEnabled,
      repeatLowYieldCooldownTriggerCount: imported.config.management.repeatLowYieldCooldownTriggerCount,
      repeatLowYieldCooldownLookbackHours: imported.config.management.repeatLowYieldCooldownLookbackHours,
      repeatLowYieldCooldownHours: imported.config.management.repeatLowYieldCooldownHours,
      repeatLowYieldCooldownScope: imported.config.management.repeatLowYieldCooldownScope,
      stopLossPct: imported.config.management.stopLossPct,
      stopLossConfirmDelayMs: imported.config.management.stopLossConfirmDelayMs,
      hardStopLossPct: imported.config.management.hardStopLossPct,
      stopLossFastClosePct: imported.config.management.stopLossFastClosePct,
      stopLossVelocityWindowMs: imported.config.management.stopLossVelocityWindowMs,
      stopLossVelocityClosePct: imported.config.management.stopLossVelocityClosePct,
      earlyDumpPct: imported.config.management.earlyDumpPct,
      earlyDumpMaxAgeMin: imported.config.management.earlyDumpMaxAgeMin,
      pnlSnapshotLoggingEnabled: imported.config.management.pnlSnapshotLoggingEnabled,
      pnlSnapshotDebug: imported.config.management.pnlSnapshotDebug,
      pnlSnapshotBotName: imported.config.management.pnlSnapshotBotName,
      minAgeBeforeYieldCheck: imported.config.management.minAgeBeforeYieldCheck,
    },
    screening: {
      fallingKnifeVetoEnabled: imported.config.screening.fallingKnifeVetoEnabled,
      fallingKnifeMaxPriceChange1hPct: imported.config.screening.fallingKnifeMaxPriceChange1hPct,
      fallingKnifeSeverePriceChangePct: imported.config.screening.fallingKnifeSeverePriceChangePct,
      fallingKnifeMinSellBuyRatio: imported.config.screening.fallingKnifeMinSellBuyRatio,
      fallingKnifeRequireOversoldRsi: imported.config.screening.fallingKnifeRequireOversoldRsi,
      suspiciousVolumeVetoEnabled: imported.config.screening.suspiciousVolumeVetoEnabled,
      suspiciousVolumeMaxMcapToGlobalFeesRatio: imported.config.screening.suspiciousVolumeMaxMcapToGlobalFeesRatio,
      suspiciousVolumeMinGlobalFeesSol: imported.config.screening.suspiciousVolumeMinGlobalFeesSol,
      suspiciousVolumeMaxTokenAgeHours: imported.config.screening.suspiciousVolumeMaxTokenAgeHours,
      suspiciousVolumeMinPriceDropPct: imported.config.screening.suspiciousVolumeMinPriceDropPct,
    },
    indicators: {
      enabled: imported.config.indicators.enabled,
      entryPreset: imported.config.indicators.entryPreset,
      exitPreset: imported.config.indicators.exitPreset,
      intervals: imported.config.indicators.intervals,
      rsiLength: imported.config.indicators.rsiLength,
      rsiOversold: imported.config.indicators.rsiOversold,
      rsiOverbought: imported.config.indicators.rsiOverbought,
      requireAllIntervals: imported.config.indicators.requireAllIntervals,
    },
    performance: {
      materialWinPct: imported.config.performance.materialWinPct,
      materialLossPct: imported.config.performance.materialLossPct,
      dustNeutralAbsPct: imported.config.performance.dustNeutralAbsPct,
      neutralCloseReasonBuckets: imported.config.performance.neutralCloseReasonBuckets,
      darwinUseMaterialOutcomes: imported.config.performance.darwinUseMaterialOutcomes,
      darwinExcludeNeutralOutcomes: imported.config.performance.darwinExcludeNeutralOutcomes,
    },
    llm: {
      screeningModel: llm.screeningModel,
      screeningBaseUrl: sanitizeBaseUrl(llm.screeningBaseUrl),
      screeningApiKeySet: maskSecretPresence(llm.screeningApiKey),
      screeningReasoningEffort: llm.screeningReasoningEffort,
      screeningFallbackModel: llm.screeningFallbackModel,
      screeningFallbackBaseUrl: sanitizeBaseUrl(llm.screeningFallbackBaseUrl),
      screeningFallbackApiKeySet: maskSecretPresence(llm.screeningFallbackApiKey),
      managementModel: llm.managementModel,
      managementBaseUrl: sanitizeBaseUrl(llm.managementBaseUrl),
      managementApiKeySet: maskSecretPresence(llm.managementApiKey),
      generalModel: llm.generalModel,
      generalBaseUrl: sanitizeBaseUrl(llm.generalBaseUrl),
      generalApiKeySet: maskSecretPresence(llm.generalApiKey),
      providerParamPolicy: {
        openRouterIncludesProviderIgnore: shouldIncludeProviderParams("https://openrouter.ai/api/v1"),
        cliProxyOmitsProviderIgnore: !shouldIncludeProviderParams("http://127.0.0.1:8317/v1"),
        dashScopeOmitsProviderIgnore: !shouldIncludeProviderParams("https://dashscope-intl.aliyuncs.com/compatible-mode/v1"),
      },
    },
  };
}

function maskSecretPresence(value) {
  return typeof value === "string" && value.trim() !== "" ? "set" : "not_set";
}

function sanitizeBaseUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "invalid";
  }
}

function shouldIncludeProviderParams(baseUrl) {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const resolution = resolveConfigFromPath(options.userConfigPath ?? REPO_LOCAL_USER_CONFIG_PATH, {
    env: { ...process.env },
    applyEnv: false,
  });
  const proof = buildProof(resolution, options.userConfigPath);

  if (options.json) {
    console.log(JSON.stringify(proof, null, 2));
    return;
  }

  console.log("\n-- Meridian Runtime Config Proof -------------------------------\n");
  console.log(`config.js: ${proof.runtimeConfigPath}`);
  console.log(`config-builder.js: ${proof.configBuilderPath}`);
  console.log(`requested user-config: ${proof.requestedUserConfigPath ?? "(repo-local default)"}`);
  console.log(`effective user-config: ${proof.effectiveUserConfigPath}${proof.userConfigExists ? "" : " (missing -> defaults only)"}`);
  console.log("");
  console.log(JSON.stringify({
    management: proof.management,
    performance: proof.performance,
    llm: proof.llm,
  }, null, 2));
  console.log("");
}

await main();
