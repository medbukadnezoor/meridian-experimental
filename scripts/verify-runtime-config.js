#!/usr/bin/env node
/**
 * Read-only runtime-config proof helper for the main bot.
 *
 * For --user-config, this imports config.js from a temporary directory with a
 * copied user-config.json. It does not read repo-local user-config.json unless
 * the caller explicitly points at it, and it never imports index.js.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { dirname, join, resolve } from "path";
import { pathToFileURL, fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const RUNTIME_CONFIG_PATH = join(ROOT, "config.js");
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

function buildProof(imported, requestedUserConfigPath, effectiveUserConfigPath, userConfigExists) {
  const llm = imported.config.llm;
  return {
    runtimeConfigPath: RUNTIME_CONFIG_PATH,
    requestedUserConfigPath,
    effectiveUserConfigPath,
    userConfigExists,
    management: {
      stopLossPct: imported.config.management.stopLossPct,
      stopLossConfirmDelayMs: imported.config.management.stopLossConfirmDelayMs,
      hardStopLossPct: imported.config.management.hardStopLossPct,
      stopLossFastClosePct: imported.config.management.stopLossFastClosePct,
      stopLossVelocityWindowMs: imported.config.management.stopLossVelocityWindowMs,
      stopLossVelocityClosePct: imported.config.management.stopLossVelocityClosePct,
      rollingDrawdownExitEnabled: imported.config.management.rollingDrawdownExitEnabled,
      rollingDrawdownWindowMs: imported.config.management.rollingDrawdownWindowMs,
      rollingDrawdownMinPeakPct: imported.config.management.rollingDrawdownMinPeakPct,
      rollingDrawdownCurrentPnlPct: imported.config.management.rollingDrawdownCurrentPnlPct,
      rollingDrawdownMinDropPct: imported.config.management.rollingDrawdownMinDropPct,
      earlyDumpPct: imported.config.management.earlyDumpPct,
      earlyDumpMaxAgeMin: imported.config.management.earlyDumpMaxAgeMin,
      trailingTriggerPct: imported.config.management.trailingTriggerPct,
      trailingDropPct: imported.config.management.trailingDropPct,
      pnlSnapshotLoggingEnabled: imported.config.management.pnlSnapshotLoggingEnabled,
      pnlSnapshotDebug: imported.config.management.pnlSnapshotDebug,
      pnlSnapshotBotName: imported.config.management.pnlSnapshotBotName,
      deployAmountSol: imported.config.management.deployAmountSol,
      solMode: imported.config.management.solMode,
    },
    risk: {
      maxPositions: imported.config.risk.maxPositions,
      maxDeployAmount: imported.config.risk.maxDeployAmount,
    },
    llm: {
      screeningModel: llm.screeningModel,
      screeningBaseUrl: sanitizeBaseUrl(llm.screeningBaseUrl),
      screeningApiKeySet: maskSecretPresence(llm.screeningApiKey),
      screeningThinkingEnabled: llm.screeningThinkingEnabled,
      screeningReasoningEffort: llm.screeningReasoningEffort,
      screeningRequestTimeoutMs: llm.screeningRequestTimeoutMs,
      managementModel: llm.managementModel,
      managementBaseUrl: sanitizeBaseUrl(llm.managementBaseUrl),
      managementApiKeySet: maskSecretPresence(llm.managementApiKey),
      generalModel: llm.generalModel,
      generalBaseUrl: sanitizeBaseUrl(llm.generalBaseUrl),
      generalApiKeySet: maskSecretPresence(llm.generalApiKey),
    },
  };
}

async function importConfigWithOptionalUserConfig(userConfigPath) {
  const effectiveUserConfigPath = userConfigPath ?? REPO_LOCAL_USER_CONFIG_PATH;
  const userConfigExists = fs.existsSync(effectiveUserConfigPath);

  if (!userConfigPath) {
    const imported = await import(`${pathToFileURL(RUNTIME_CONFIG_PATH).href}?proof=${Date.now()}`);
    return { imported, effectiveUserConfigPath, userConfigExists, cleanup: () => {} };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-main-config-proof-"));
  fs.copyFileSync(RUNTIME_CONFIG_PATH, path.join(tempDir, "config.js"));
  if (userConfigExists) {
    fs.copyFileSync(effectiveUserConfigPath, path.join(tempDir, "user-config.json"));
  }

  const imported = await import(`${pathToFileURL(path.join(tempDir, "config.js")).href}?proof=${Date.now()}`);
  return {
    imported,
    effectiveUserConfigPath,
    userConfigExists,
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const resolution = await importConfigWithOptionalUserConfig(options.userConfigPath);

  try {
    const proof = buildProof(
      resolution.imported,
      options.userConfigPath,
      resolution.effectiveUserConfigPath,
      resolution.userConfigExists,
    );

    if (options.json) {
      console.log(JSON.stringify(proof, null, 2));
      return;
    }

    console.log("\n-- Meridian Main Runtime Config Proof --------------------------\n");
    console.log(`config.js: ${proof.runtimeConfigPath}`);
    console.log(`requested user-config: ${proof.requestedUserConfigPath ?? "(repo-local default)"}`);
    console.log(`effective user-config: ${proof.effectiveUserConfigPath}${proof.userConfigExists ? "" : " (missing -> defaults only)"}`);
    console.log("");
    console.log(JSON.stringify({
      management: proof.management,
      risk: proof.risk,
      llm: proof.llm,
    }, null, 2));
    console.log("");
  } finally {
    resolution.cleanup();
  }
}

await main();
