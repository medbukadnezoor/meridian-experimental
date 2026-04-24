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
const NANOCAP_USER_CONFIG_PATH = join(ROOT, "..", "archive", "vps-backups", "nanocap", "user-config.json");
const RUNTIME_CONFIG_VERIFIER_PATH = join(__dirname, "verify-runtime-config.js");
const EARLY_DUMP_COOLDOWN_VERIFIER_PATH = join(__dirname, "verify-early-dump-cooldown.js");

function loadSource(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8");
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

function buildChecks() {
  const nanocapUserConfig = parseNanocapUserConfig();
  const defaultProofPath = join(ROOT, `.runtime-config-default-proof-${process.pid}-${Date.now()}.json`);
  const defaultProof = runRuntimeConfigProof(defaultProofPath);
  const nanocapConfig = existsSync(NANOCAP_USER_CONFIG_PATH)
    ? runRuntimeConfigProof(NANOCAP_USER_CONFIG_PATH)
    : null;
  const earlyDumpProof = runEarlyDumpCooldownProof();

  return [
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
      label: "[Runtime] repeat deploy defaults resolve cleanly under explicit proof path",
      test: () =>
        defaultProof.management?.repeatDeployCooldownEnabled === true &&
        Number(defaultProof.management?.repeatDeployCooldownTriggerCount) === 3 &&
        Number(defaultProof.management?.repeatDeployCooldownHours) === 12 &&
        defaultProof.management?.repeatDeployCooldownScope === "token" &&
        Number(defaultProof.management?.repeatDeployCooldownMinFeeEarnedPct) === 0,
    },
    {
      file: "../archive/vps-backups/nanocap/user-config.json",
      label: "[Runtime] nanocap cooldown proof resolves from the supplied synced backup path",
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
      file: "../archive/vps-backups/nanocap/user-config.json",
      label: "[Runtime] nanocap repeat deploy defaults resolve exactly from the supplied synced backup path",
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
      file: "../archive/vps-backups/nanocap/user-config.json",
      label: "[Runtime] nanocap repeat low-yield config resolves exactly from the supplied synced backup path",
      test: () =>
        nanocapConfig != null &&
        nanocapConfig.management?.repeatLowYieldCooldownEnabled === (nanocapUserConfig.repeatLowYieldCooldownEnabled ?? false) &&
        Number(nanocapConfig.management?.repeatLowYieldCooldownTriggerCount) === Number(nanocapUserConfig.repeatLowYieldCooldownTriggerCount ?? 3) &&
        Number(nanocapConfig.management?.repeatLowYieldCooldownLookbackHours) === Number(nanocapUserConfig.repeatLowYieldCooldownLookbackHours ?? 48) &&
        Number(nanocapConfig.management?.repeatLowYieldCooldownHours) === Number(nanocapUserConfig.repeatLowYieldCooldownHours ?? 12) &&
        nanocapConfig.management?.repeatLowYieldCooldownScope === (nanocapUserConfig.repeatLowYieldCooldownScope ?? "token"),
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
  console.log("  Includes runtime-truth checks for nanocap stop-loss cooldown mapping and early-dump cooldown classification.\n");

  for (const check of checks) {
    let src = "";
    if (!check.file.startsWith("../archive/")) {
      try {
        src = loadSource(check.file);
      } catch {
        console.log(`FAIL  [FILE MISSING] ${check.file} -- ${check.label}`);
        failed += 1;
        continue;
      }
    } else if (!existsSync(join(ROOT, check.file))) {
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
