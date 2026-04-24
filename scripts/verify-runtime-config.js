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
      earlyDumpPct: imported.config.management.earlyDumpPct,
      earlyDumpMaxAgeMin: imported.config.management.earlyDumpMaxAgeMin,
      pnlSnapshotLoggingEnabled: imported.config.management.pnlSnapshotLoggingEnabled,
      pnlSnapshotDebug: imported.config.management.pnlSnapshotDebug,
      pnlSnapshotBotName: imported.config.management.pnlSnapshotBotName,
      minAgeBeforeYieldCheck: imported.config.management.minAgeBeforeYieldCheck,
    },
    performance: {
      materialWinPct: imported.config.performance.materialWinPct,
      materialLossPct: imported.config.performance.materialLossPct,
      dustNeutralAbsPct: imported.config.performance.dustNeutralAbsPct,
      neutralCloseReasonBuckets: imported.config.performance.neutralCloseReasonBuckets,
      darwinUseMaterialOutcomes: imported.config.performance.darwinUseMaterialOutcomes,
      darwinExcludeNeutralOutcomes: imported.config.performance.darwinExcludeNeutralOutcomes,
    },
  };
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
  }, null, 2));
  console.log("");
}

await main();
