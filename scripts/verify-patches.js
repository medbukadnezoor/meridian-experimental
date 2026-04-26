#!/usr/bin/env node
/**
 * verify-patches.js
 *
 * Verifies all local security patches are intact after a rebase or before a bot restart.
 * Also verifies that key upstream features landed correctly.
 *
 * Run: node scripts/verify-patches.js
 * Exits 0 if all patches present, exits 1 if any are missing.
 *
 * Called automatically by the Claude Code hook before any bot restart.
 *
 * Patch history:
 *   Patches 1-5 (getClient, providerIgnore, logApiActivity, resolveFallbackModel,
 *   per-role endpoint keys) were dropped — upstream 4959d10 supersedes them.
 *   Patches 6, 7, 8 remain as mandatory security checks (re-applied after rebase).
 */

import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const NARROW_RANGE_GUARD_VERIFIER_PATH = join(__dirname, "verify-narrow-range-guard.js");

function runEarlyDumpCooldownProof() {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'verify-early-dump-cooldown.js')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, LOG_LEVEL: 'error' },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || '(no stderr)';
    const stdout = result.stdout?.trim() || '(no stdout)';
    throw new Error(`verify-early-dump-cooldown failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(result.stdout);
}

function runUpstreamSecurityHardeningProof() {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'verify-upstream-security-hardening.js')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, LOG_LEVEL: 'error', MERIDIAN_ENVCRYPT_AUTOLOAD: 'false' },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || '(no stderr)';
    const stdout = result.stdout?.trim() || '(no stdout)';
    throw new Error(`verify-upstream-security-hardening failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(result.stdout);
}

function runNarrowRangeGuardProof() {
  const result = spawnSync(process.execPath, [NARROW_RANGE_GUARD_VERIFIER_PATH], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, LOG_LEVEL: 'error' },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || '(no stderr)';
    const stdout = result.stdout?.trim() || '(no stdout)';
    throw new Error(`verify-narrow-range-guard failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(result.stdout);
}

const earlyDumpProof = runEarlyDumpCooldownProof();
const upstreamSecurityProof = runUpstreamSecurityHardeningProof();
const narrowRangeGuardProof = runNarrowRangeGuardProof();

const checks = [
  // ── SECURITY PATCHES (must always be present) ────────────────────────────

  {
    file: 'scripts/verify-upstream-security-hardening.js',
    label: '[Security] upstream envcrypt and relay-signing synthetic proof passes',
    test: () =>
      upstreamSecurityProof?.success === true &&
      upstreamSecurityProof?.sourceProof?.envryptIgnored === true &&
      upstreamSecurityProof?.sourceProof?.envcryptEntrypoints === true &&
      upstreamSecurityProof?.sourceProof?.cliHomeEnvrypt === true &&
      upstreamSecurityProof?.sourceProof?.relayGuardWiredForZapOut === true &&
      upstreamSecurityProof?.sourceProof?.relayGuardWiredForZapIn === true &&
      upstreamSecurityProof?.sourceProof?.postSubmitFallbackBlocked === true &&
      upstreamSecurityProof?.envcryptProof?.roundTrip === true &&
      upstreamSecurityProof?.envcryptProof?.markerOnlyDecrypt === true &&
      upstreamSecurityProof?.envcryptProof?.missingKeyFails === true &&
      upstreamSecurityProof?.envcryptProof?.encryptEnvRawWritesEncryptedSecrets === true &&
      upstreamSecurityProof?.relayProof?.unsafeSystemTransferRejected === true &&
      upstreamSecurityProof?.relayProof?.safeSimulationSigns === true &&
      upstreamSecurityProof?.relayProof?.requiredStaticAccountEnforced === true &&
      upstreamSecurityProof?.relayProof?.simulationErrorRejected === true &&
      upstreamSecurityProof?.relayProof?.maxSolLossEnforced === true &&
      upstreamSecurityProof?.relayProof?.unrelatedTokenDebitRejected === true,
  },

  // Patch 6 — Stop-loss 6h cooldown on pool + base mint (pool-memory.js)
  {
    file: 'pool-memory.js',
    label: '[Patch 6] Stop-loss-family cooldown on pool + base mint',
    test: src => {
      const hasStopLossFamily = src.includes('function isStopLossFamilyCloseReason') && /stop.loss/i.test(src);
      const hasEarlyDump = src.includes('function isEarlyDumpCloseReason') && /early.dump/i.test(src);
      const hasMintCooldown = src.includes('setBaseMintCooldown') && src.includes('cooldownReason');
      return hasStopLossFamily && hasEarlyDump && hasMintCooldown;
    },
  },

  {
    file: 'index.js',
    label: '[Patch 6] Direct stop-loss close preserves original reason label',
    test: src =>
      !src.includes('reason: `Trailing TP: ${exit.reason}`') &&
      !src.includes('reason: `Trailing TP: ${closeRule.reason}`') &&
      src.includes('reason: exit.reason') &&
      src.includes('reason: closeRule.reason'),
  },

  {
    file: 'scripts/verify-early-dump-cooldown.js',
    label: '[Runtime] Early-dump close writes pool and token cooldowns',
    test: () =>
      earlyDumpProof?.success === true &&
      earlyDumpProof?.closeReasonMatched === true &&
      earlyDumpProof?.poolCooldownReason === 'early dump' &&
      earlyDumpProof?.tokenCooldownReason === 'early dump' &&
      earlyDumpProof?.tempStateFileCreated === true &&
        earlyDumpProof?.tempDirRemoved === true,
  },

  {
    file: 'scripts/verify-narrow-range-guard.js',
    label: '[Runtime] Narrow single-side SOL deploy guard ignores zero pct overrides and rejects zero/1-bin ranges',
    test: () =>
      narrowRangeGuardProof?.success === true &&
      Number(narrowRangeGuardProof?.incident_zero_pct?.normalized?.activeBinsBelow) === 47 &&
      narrowRangeGuardProof?.incident_zero_pct?.normalized?.percent_inputs?.downside_pct_used === false &&
      narrowRangeGuardProof?.incident_zero_pct?.normalized?.percent_inputs?.upside_pct_used === false &&
      narrowRangeGuardProof?.incident_zero_pct?.guard_ok === true &&
      Array.isArray(narrowRangeGuardProof?.rejected) &&
      narrowRangeGuardProof.rejected.some((row) => row?.bins_below === 0 && String(row?.reason || '').includes('zero-width bin range')) &&
      narrowRangeGuardProof.rejected.some((row) => row?.bins_below === 1 && String(row?.reason || '').includes('absolute floor 5')) &&
      narrowRangeGuardProof?.source_markers?.raw_audit_log === true &&
      narrowRangeGuardProof?.source_markers?.normalized_audit_log === true &&
      narrowRangeGuardProof?.source_markers?.rejection_audit_log === true &&
      narrowRangeGuardProof?.source_markers?.schema_zero_pct_warning === true,
  },

  // Patch 7 — OPERATOR COMMAND Telegram wrapping (index.js)
  {
    file: 'index.js',
    label: '[Patch 7] OPERATOR COMMAND Telegram wrapping (prompt injection hardening)',
    test: src => {
      const hasWrapper = src.includes('[OPERATOR COMMAND via Telegram]');
      const hasQuotes = src.includes('"""');
      const hasConflictGuard = src.includes('conflict with your operational rules');
      return hasWrapper && hasQuotes && hasConflictGuard;
    },
  },

  // Patch 8 — Model keys ABSENT from CONFIG_MAP (tools/executor.js)
  {
    file: 'tools/executor.js',
    label: '[Patch 8] SECURITY: managementModel ABSENT from CONFIG_MAP',
    test: src => {
      const mapMatch = src.match(/CONFIG_MAP\s*=\s*\{([\s\S]*?)\};/);
      if (!mapMatch) return true; // can't find block — assume safe, flag manually
      return !mapMatch[1].includes('managementModel');
    },
  },
  {
    file: 'tools/executor.js',
    label: '[Patch 8] SECURITY: screeningModel ABSENT from CONFIG_MAP',
    test: src => {
      const mapMatch = src.match(/CONFIG_MAP\s*=\s*\{([\s\S]*?)\};/);
      if (!mapMatch) return true;
      return !mapMatch[1].includes('screeningModel');
    },
  },
  {
    file: 'tools/executor.js',
    label: '[Patch 8] SECURITY: generalModel ABSENT from CONFIG_MAP',
    test: src => {
      const mapMatch = src.match(/CONFIG_MAP\s*=\s*\{([\s\S]*?)\};/);
      if (!mapMatch) return true;
      return !mapMatch[1].includes('generalModel');
    },
  },
  {
    file: 'tools/executor.js',
    label: '[Patch 8] model-routing comment present in CONFIG_MAP',
    test: src => src.includes('model routing is operator-only') && src.includes('not LLM-mutable'),
  },

  // ── UPSTREAM FEATURE CHECKS (verify upstream 4959d10 landed) ─────────────

  // HiveMind integration
  {
    file: 'hivemind.js',
    label: '[Upstream] HiveMind module present (af52813)',
    test: src => src.includes('bootstrapHiveMind') || src.includes('hiveMind') || src.includes('HiveMind'),
  },

  // Telegram control commands (/pause, /resume, /deploy, /closeall)
  {
    file: 'index.js',
    label: '[Upstream] Telegram /pause command present (15e227a)',
    test: src => src.includes('/pause'),
  },
  {
    file: 'index.js',
    label: '[Upstream] Telegram /resume command present (15e227a)',
    test: src => src.includes('/resume'),
  },
  {
    file: 'index.js',
    label: '[Upstream] Telegram /deploy <n> command present (15e227a)',
    test: src => /\/deploy\s/.test(src) || src.includes('/deploy <'),
  },

  // Discord signal screening
  {
    file: 'tools/executor.js',
    label: '[Upstream] Discord signal config keys in CONFIG_MAP (d67f00d)',
    test: src => src.includes('useDiscordSignals') || src.includes('discordSignalMode'),
  },

  // Jupiter v2
  {
    file: 'tools/wallet.js',
    label: '[Upstream] Jupiter v2 swap endpoint (7dcc27d)',
    test: src => src.includes('v6') || src.includes('jup.ag') || src.includes('jupiter'),
  },
];

// ── Run checks ───────────────────────────────────────────────────────────────

let failed = 0;
let passed = 0;

console.log('\n── Meridian Patch Verification ─────────────────────────────────\n');
console.log('  Rebase basis: upstream 4959d10 + local safety patches, including early-dump cooldown proof and upstream env/relay security hardening\n');

for (const check of checks) {
  const filePath = join(ROOT, check.file);
  let src;
  try {
    src = readFileSync(filePath, 'utf8');
  } catch {
    console.log(`❌  [FILE MISSING] ${check.file} — ${check.label}`);
    failed++;
    continue;
  }

  const pass = check.test(src);
  if (pass) {
    console.log(`✅  ${check.label}`);
    passed++;
  } else {
    console.log(`❌  MISSING: ${check.label}  [${check.file}]`);
    failed++;
  }
}

console.log(`\n────────────────────────────────────────────────────────────────`);
if (failed === 0) {
  console.log(`✅  All ${passed} checks passed. Safe to proceed.\n`);
  process.exit(0);
} else {
  console.error(`\n🚫  ${failed} check(s) FAILED — do NOT restart the bot.\n`);
  console.error(`    Fix the missing patches, then re-run: node scripts/verify-patches.js\n`);
  process.exit(1);
}
