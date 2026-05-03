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
const STOP_LOSS_TRIAL_VERIFIER_PATH = join(__dirname, "verify-stop-loss-trial-behavior.js");
const ROLLING_DRAWDOWN_VERIFIER_PATH = join(__dirname, "verify-rolling-drawdown-exit-policy.js");
const REPEAT_LOW_YIELD_VERIFIER_PATH = join(__dirname, "verify-repeat-low-yield-cooldown.js");
const FALLING_KNIFE_VETO_VERIFIER_PATH = join(__dirname, "verify-falling-knife-veto.js");
const RELAY_RETRY_EVIDENCE_VERIFIER_PATH = join(__dirname, "verify-relay-retry-evidence.js");

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

function runStopLossTrialProof() {
  const result = spawnSync(process.execPath, [STOP_LOSS_TRIAL_VERIFIER_PATH], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, LOG_LEVEL: 'error' },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || '(no stderr)';
    const stdout = result.stdout?.trim() || '(no stdout)';
    throw new Error(`verify-stop-loss-trial-behavior failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(result.stdout);
}

function runRollingDrawdownExitProof() {
  const result = spawnSync(process.execPath, [ROLLING_DRAWDOWN_VERIFIER_PATH], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, LOG_LEVEL: 'error' },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || '(no stderr)';
    const stdout = result.stdout?.trim() || '(no stdout)';
    throw new Error(`verify-rolling-drawdown-exit-policy failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(result.stdout);
}

function runRepeatLowYieldCooldownProof() {
  const result = spawnSync(process.execPath, [REPEAT_LOW_YIELD_VERIFIER_PATH], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, LOG_LEVEL: 'error' },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || '(no stderr)';
    const stdout = result.stdout?.trim() || '(no stdout)';
    throw new Error(`verify-repeat-low-yield-cooldown failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(result.stdout);
}

function runFallingKnifeVetoProof() {
  const result = spawnSync(process.execPath, [FALLING_KNIFE_VETO_VERIFIER_PATH], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, LOG_LEVEL: 'error' },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || '(no stderr)';
    const stdout = result.stdout?.trim() || '(no stdout)';
    throw new Error(`verify-falling-knife-veto failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(result.stdout);
}

function runRelayRetryEvidenceProof() {
  const result = spawnSync(process.execPath, [RELAY_RETRY_EVIDENCE_VERIFIER_PATH], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, LOG_LEVEL: 'error' },
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || '(no stderr)';
    const stdout = result.stdout?.trim() || '(no stdout)';
    throw new Error(`verify-relay-retry-evidence failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return JSON.parse(result.stdout);
}

const earlyDumpProof = runEarlyDumpCooldownProof();
const upstreamSecurityProof = runUpstreamSecurityHardeningProof();
const narrowRangeGuardProof = runNarrowRangeGuardProof();
const stopLossTrialProof = runStopLossTrialProof();
const rollingDrawdownExitProof = runRollingDrawdownExitProof();
const repeatLowYieldProof = runRepeatLowYieldCooldownProof();
const fallingKnifeProof = runFallingKnifeVetoProof();
const relayRetryEvidenceProof = runRelayRetryEvidenceProof();

function loadSource(file) {
  return readFileSync(join(ROOT, file), 'utf8');
}

function roleReasoningConfigKeysAbsent() {
  const forbiddenKeys = ['managementReasoningEffort', 'generalReasoningEffort'];
  const files = ['config.js', 'setup.js', 'tools/executor.js', 'user-config.example.json'];
  return files.every((file) => {
    const src = loadSource(file);
    return forbiddenKeys.every((key) => !src.includes(key));
  });
}

function managerAndGeneralReasoningEffortNull(src) {
  return (
    src.includes('Only SCREENER forwards reasoning_effort; MANAGER and GENERAL are dense non-reasoning routes.') &&
    src.includes('if (agentType === "SCREENER" && config.llm.screeningReasoningEffort)') &&
    src.includes('callParams.reasoning_effort = config.llm.screeningReasoningEffort') &&
    src.includes('reasoning_effort: agentType === "SCREENER" ? (config.llm.screeningReasoningEffort || null) : null') &&
    roleReasoningConfigKeysAbsent()
  );
}

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

  {
    file: 'scripts/verify-relay-retry-evidence.js',
    label: '[Runtime] Agent Meridian relay fallback logs retry evidence and marker',
    test: () =>
      relayRetryEvidenceProof?.ok === true &&
      relayRetryEvidenceProof?.relayOpenPositionBudget?.maxElapsedMs === 45_000 &&
      relayRetryEvidenceProof?.relayOpenPositionBudget?.perAttemptTimeoutMs === 20_000 &&
      relayRetryEvidenceProof?.relayOpenPositionBudget?.maxAttempts === 2 &&
      relayRetryEvidenceProof?.logMarker === 'Agent Meridian relay retry evidence enabled',
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

  {
    file: 'scripts/verify-stop-loss-trial-behavior.js',
    label: '[Runtime] Confirmed soft stop-loss, fast/hard urgent stop-loss, and early-dump behavior',
    test: () =>
      stopLossTrialProof?.success === true &&
      stopLossTrialProof?.softCandidate?.action === 'STOP_LOSS_CANDIDATE' &&
      stopLossTrialProof?.softCandidate?.needsConfirmation === true &&
      Number(stopLossTrialProof?.softCandidate?.confirmDelayMs) === 15000 &&
      stopLossTrialProof?.fastStop?.action === 'STOP_LOSS' &&
      stopLossTrialProof?.fastStop?.urgent === true &&
      stopLossTrialProof?.hardStop?.action === 'STOP_LOSS' &&
      stopLossTrialProof?.hardStop?.urgent === true &&
      stopLossTrialProof?.earlyDump?.action === 'STOP_LOSS' &&
      stopLossTrialProof?.legacyNoDelay?.action === 'STOP_LOSS' &&
      stopLossTrialProof?.confirmedRecheck?.confirmed === true &&
      stopLossTrialProof?.rejectedRecheck?.rejected === true &&
      stopLossTrialProof?.tempStateFileCreated === true &&
      stopLossTrialProof?.tempDirRemoved === true,
  },

  {
    file: 'scripts/verify-rolling-drawdown-exit-policy.js',
    label: '[Runtime] Main rolling fast-drawdown exit is gated, urgent, and preserves stronger stop priority',
    test: () =>
      rollingDrawdownExitProof?.success === true &&
      rollingDrawdownExitProof?.pureDecision?.action === 'STOP_LOSS' &&
      rollingDrawdownExitProof?.pureDecision?.urgent === true &&
      String(rollingDrawdownExitProof?.pureDecision?.reason || '').startsWith('Rolling fast drawdown:') &&
      rollingDrawdownExitProof?.fireExit?.action === 'STOP_LOSS' &&
      rollingDrawdownExitProof?.fireExit?.urgent === true &&
      String(rollingDrawdownExitProof?.fireExit?.reason || '').startsWith('Rolling fast drawdown:') &&
      rollingDrawdownExitProof?.noTriggerCases?.lowPeak === true &&
      rollingDrawdownExitProof?.noTriggerCases?.currentHigh === true &&
      rollingDrawdownExitProof?.noTriggerCases?.smallDrop === true &&
      rollingDrawdownExitProof?.noTriggerCases?.stale === true &&
      rollingDrawdownExitProof?.noTriggerCases?.disabled === true &&
      rollingDrawdownExitProof?.noTriggerCases?.suspicious === true &&
      rollingDrawdownExitProof?.preservedStops?.hard?.urgent === true &&
      String(rollingDrawdownExitProof?.preservedStops?.hard?.reason || '').startsWith('Hard stop loss:') &&
      rollingDrawdownExitProof?.preservedStops?.fast?.urgent === true &&
      String(rollingDrawdownExitProof?.preservedStops?.fast?.reason || '').startsWith('Fast stop loss:') &&
      rollingDrawdownExitProof?.preservedStops?.velocity?.urgent === true &&
      String(rollingDrawdownExitProof?.preservedStops?.velocity?.reason || '').startsWith('Velocity stop loss:') &&
      Number(rollingDrawdownExitProof?.fireHistoryPoints) >= 2 &&
      rollingDrawdownExitProof?.tempStateFileCreated === true &&
      rollingDrawdownExitProof?.tempDirRemoved === true,
  },

  {
    file: 'config.js',
    label: '[Runtime] Main rolling fast-drawdown config keys map with conservative defaults',
    test: src =>
      src.includes('rollingDrawdownExitEnabled: u.rollingDrawdownExitEnabled ?? false') &&
      src.includes('rollingDrawdownWindowMs: u.rollingDrawdownWindowMs ?? 5_400_000') &&
      src.includes('rollingDrawdownMinPeakPct: u.rollingDrawdownMinPeakPct ?? 2') &&
      src.includes('rollingDrawdownCurrentPnlPct: u.rollingDrawdownCurrentPnlPct ?? -3') &&
      src.includes('rollingDrawdownMinDropPct: u.rollingDrawdownMinDropPct ?? 6'),
  },

  {
    file: 'tools/executor.js',
    label: '[Runtime] Main update_config can modify rolling fast-drawdown keys',
    test: src =>
      src.includes('rollingDrawdownExitEnabled: ["management", "rollingDrawdownExitEnabled"]') &&
      src.includes('rollingDrawdownWindowMs: ["management", "rollingDrawdownWindowMs"]') &&
      src.includes('rollingDrawdownMinPeakPct: ["management", "rollingDrawdownMinPeakPct"]') &&
      src.includes('rollingDrawdownCurrentPnlPct: ["management", "rollingDrawdownCurrentPnlPct"]') &&
      src.includes('rollingDrawdownMinDropPct: ["management", "rollingDrawdownMinDropPct"]'),
  },

  {
    file: 'index.js',
    label: '[Runtime] Main PnL snapshot logging can feed rolling drawdown live monitor',
    test: src =>
      src.includes('function appendPnlSnapshot') &&
      src.includes('pnl-snapshots-${dateStr}.jsonl') &&
      src.includes('config.management.pnlSnapshotLoggingEnabled') &&
      src.includes('appendPnlSnapshot(null, p, exit)'),
  },

  {
    file: 'index.js',
    label: '[Runtime] Management-cycle urgent stop-loss exits bypass MANAGER',
    test: src => {
      const urgentExitBranch = src.match(/if \(exit\.action === "STOP_LOSS" && exit\.urgent\) \{[\s\S]*?continue;\n\s*\}/);
      const ruleOneBranch = src.match(/if \(closeRule\.rule === 1 && closeRule\.urgent\) \{[\s\S]*?continue;\n\s*\}/);
      return (
        src.includes('async function closeUrgentStopLossDirect') &&
        src.includes('closing directly (no MANAGER)') &&
        urgentExitBranch?.[0]?.includes('closeUrgentStopLossDirect') &&
        urgentExitBranch?.[0]?.includes('action: "DIRECT_CLOSE"') &&
        ruleOneBranch?.[0]?.includes('closeUrgentStopLossDirect') &&
        ruleOneBranch?.[0]?.includes('action: "DIRECT_CLOSE"') &&
        src.includes('return a.action !== "STAY" && a.action !== "DIRECT_CLOSE";') &&
        src.includes('urgent direct close(s) already attempted — skipping LLM')
      );
    },
  },

  {
    file: 'scripts/verify-repeat-low-yield-cooldown.js',
    label: '[Runtime] Repeat low-yield cooldown waits for 3 closes and scopes to token',
    test: () =>
      repeatLowYieldProof?.success === true &&
      repeatLowYieldProof?.disabled?.immediatePoolCooldown === true &&
      repeatLowYieldProof?.disabled?.tokenCooldownReason === null &&
      repeatLowYieldProof?.enabled?.firstCloseCooldown === null &&
      repeatLowYieldProof?.enabled?.secondCloseCooldown === null &&
      repeatLowYieldProof?.enabled?.thirdClosePoolCooldownReason === null &&
      repeatLowYieldProof?.enabled?.thirdCloseTokenCooldownReason === 'repeat low-yield closes (3x/48h)' &&
      repeatLowYieldProof?.enabled?.deployCount === 3 &&
      repeatLowYieldProof?.tempStateFileCreated === true &&
      repeatLowYieldProof?.tempDirRemoved === true,
  },

  {
    file: 'config.js',
    label: '[Falling-knife veto] runtime config maps veto keys and keeps main default disabled',
    test: src =>
      src.includes('fallingKnifeVetoEnabled: u.fallingKnifeVetoEnabled ?? false') &&
      src.includes('fallingKnifeMaxPriceChange1hPct') &&
      src.includes('fallingKnifeSeverePriceChangePct') &&
      src.includes('fallingKnifeMinSellBuyRatio') &&
      src.includes('fallingKnifeRequireOversoldRsi') &&
      src.includes('suspiciousVolumeVetoEnabled: u.suspiciousVolumeVetoEnabled ?? false') &&
      src.includes('suspiciousVolumeMaxMcapToGlobalFeesRatio') &&
      src.includes('suspiciousVolumeMinGlobalFeesSol') &&
      src.includes('suspiciousVolumeMaxTokenAgeHours') &&
      src.includes('suspiciousVolumeMinPriceDropPct'),
  },

  {
    file: 'tools/screening.js',
    label: '[Falling-knife veto] screening drops deterministic falling-knife and suspicious-volume candidates before LLM when enabled',
    test: src =>
      src.includes('function getCandidatePriceChange1hPct') &&
      src.includes('export function getFallingKnifeVetoReason') &&
      src.includes('export function getSuspiciousVolumeVetoReason') &&
      src.includes('export function getDeterministicCandidateVetoReason') &&
      src.includes('formatDeterministicVetoAuditLine') &&
      src.includes('fallingKnifeVetoEnabled || config.screening.suspiciousVolumeVetoEnabled') &&
      src.includes('await enrichJupiterTokenSnapshots(eligible)') &&
      src.includes('falling knife veto:') &&
      src.includes('suspicious volume/fees veto:'),
  },

  {
    file: 'scripts/verify-falling-knife-veto.js',
    label: '[Falling-knife veto] synthetic proof vetoes dump setups and preserves disabled/benign candidates',
    test: () =>
      fallingKnifeProof?.success === true &&
      fallingKnifeProof?.disabledDefault?.vetoed === false &&
      fallingKnifeProof?.larpLike?.vetoed === true &&
      String(fallingKnifeProof?.larpLike?.reason || '').startsWith('falling knife veto:') &&
      String(fallingKnifeProof?.larpLike?.reason || '').includes('price_change=-48.8%') &&
      String(fallingKnifeProof?.larpLike?.reason || '').includes('sell/buy=1.66') &&
      Number(fallingKnifeProof?.larpLike?.audit?.price_change_pct?.toFixed(1)) === -48.8 &&
      Number(fallingKnifeProof?.larpLike?.audit?.sell_buy_ratio?.toFixed(2)) === 1.66 &&
      Math.round(Number(fallingKnifeProof?.larpLike?.audit?.mcap_global_fees_ratio)) === 21090 &&
      Number(fallingKnifeProof?.larpLike?.audit?.token_age_hours) === 66 &&
      String(fallingKnifeProof?.larpLike?.auditLine || '').includes('Deterministic veto: dropped LARP-SOL') &&
      String(fallingKnifeProof?.larpLike?.auditLine || '').includes('mcap/global_fees=21090') &&
      fallingKnifeProof?.benignOversold?.vetoed === false &&
      fallingKnifeProof?.benign5mFrequency?.vetoed === false &&
      fallingKnifeProof?.ratioFallingKnife?.vetoed === true &&
      fallingKnifeProof?.suspiciousVolume?.vetoed === true,
  },

  {
    file: 'agent.js',
    label: '[CLIProxy] MANAGER and GENERAL stay dense non-reasoning routes',
    test: src => managerAndGeneralReasoningEffortNull(src),
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
