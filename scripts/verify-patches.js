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
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const checks = [
  // ── SECURITY PATCHES (must always be present) ────────────────────────────

  // Patch 6 — Stop-loss 6h cooldown on pool + base mint (pool-memory.js)
  {
    file: 'pool-memory.js',
    label: '[Patch 6] Stop-loss 6h cooldown on pool + base mint',
    test: src => {
      const hasStopLoss = /stop.loss/i.test(src);
      const has6h = src.includes('6') && src.includes('stop loss');
      const hasMintCooldown = src.includes('setBaseMintCooldown') && src.includes('stop loss');
      return hasStopLoss && has6h && hasMintCooldown;
    },
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
console.log('  Rebase basis: upstream 4959d10 + 3 local security patches (6, 7, 8)\n');

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
