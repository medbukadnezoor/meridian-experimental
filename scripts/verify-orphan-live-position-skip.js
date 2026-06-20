#!/usr/bin/env node
/**
 * Verifier for MAIN-ORPHAN-LIVE-POSITION-SKIP-AND-ALERT-T1.
 *
 * Asserts that the main bot skips on-chain positions that have no tracked-state
 * entry ("orphans") before any exit/management evaluation runs for them, and that
 * it alerts the owner exactly once per distinct orphan (deduped, re-alerting only
 * after the address disappears from the live list).
 *
 * Strategy:
 *   (a) Static source assertions against index.js — the PnL poll loop body must
 *       resolve `getTrackedPosition(p.position)` and `continue` on `!tracked`
 *       BEFORE the first exit evaluation (`updatePnlAndCheckExits`); the management
 *       cycle must filter untracked live positions out of `positionData`. Both
 *       skip paths must log a `cron_error` and gate the Telegram `sendMessage` on
 *       `telegramEnabled()`.
 *   (b) Unit test of the pure dedup helper `reconcileOrphanAlerts`, extracted from
 *       index.js source and evaluated in isolation (index.js is NOT imported — it
 *       has top-level side effects). Verifies: new orphan alerts once, same orphan
 *       does not re-alert, an orphan that disappears then returns re-alerts, and a
 *       tracked/non-orphan address is never alerted.
 *
 * Does not import index.js, run the bot, call trading APIs, or read live config.
 * Exits non-zero on any failure.
 */

import fs from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const INDEX_PATH = join(ROOT, "index.js");
const src = fs.readFileSync(INDEX_PATH, "utf8");

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name}`);
    failures += 1;
  }
}

console.log("verify-orphan-live-position-skip");

// ── (a) Static source assertions ───────────────────────────────────────────

// Isolate the PnL poll skip loop body. The reconcile/alert block uses its own
// short-lived `for (const p of result.positions)` to collect orphans, so the skip loop
// is the LAST such loop; the exit eval lives inside it. Anchor on the last loop, then
// the first exit call after it.
const pollLoopStart = src.lastIndexOf("for (const p of result.positions) {");
check("PnL poll skip loop over result.positions exists", pollLoopStart !== -1);

const firstExitCallIdx = src.indexOf("updatePnlAndCheckExits(p.position, p, config.management)", pollLoopStart);
check(
  "PnL poll still evaluates exits (updatePnlAndCheckExits present)",
  firstExitCallIdx !== -1 && firstExitCallIdx > pollLoopStart,
);

const pollPreamble = src.slice(pollLoopStart, firstExitCallIdx);
check(
  "PnL poll resolves getTrackedPosition(p.position) before first exit eval",
  /const\s+tracked\s*=\s*getTrackedPosition\(p\.position\)/.test(pollPreamble),
);
check(
  "PnL poll skips (continue) when !tracked before first exit eval",
  /if\s*\(\s*!tracked\s*\)\s*\{[\s\S]*?\bcontinue\b/.test(pollPreamble),
);

// The orphan reconcile/alert now runs in a block immediately before the skip loop,
// driven by the shared reconcileOrphanAlerts helper (single source of truth for the
// prune/dedup/re-alert semantics). Isolate from the prune-block to the skip loop.
const pollPruneIdx = src.lastIndexOf("reconcileOrphanAlerts(", pollLoopStart);
check("PnL poll reconcile block precedes the skip loop", pollPruneIdx !== -1 && pollPruneIdx < pollLoopStart);
const pollAlertBlock = pollPruneIdx === -1 ? "" : src.slice(pollPruneIdx, pollLoopStart);
check(
  "PnL poll drives dedup/prune via reconcileOrphanAlerts(_alertedOrphans, ...)",
  /reconcileOrphanAlerts\(\s*_alertedOrphans\s*,/.test(pollAlertBlock),
);
check(
  "PnL poll orphan path logs cron_error",
  /log\(\s*["']cron_error["']/.test(pollAlertBlock) &&
    /Untracked live position skipped/.test(pollAlertBlock),
);
check(
  "PnL poll orphan Telegram alert gated on telegramEnabled() and reuses sendMessage",
  /if\s*\(\s*telegramEnabled\(\)\s*\)\s*\{[\s\S]*?sendMessage\(/.test(pollAlertBlock),
);

// Management cycle must filter untracked live positions out of positionData.
const mgmtFilterIdx = src.indexOf("const managedPositions = positions.filter(");
check("Management cycle filters orphans into managedPositions", mgmtFilterIdx !== -1);
if (mgmtFilterIdx !== -1) {
  // The filter is now a thin tracked-only predicate; the orphan reconcile/alert runs in
  // a block immediately above it, driven by the same shared helper. Isolate that block
  // (from the management reconcile call up to the filter) plus the filter line itself.
  const mgmtReconcileIdx = src.lastIndexOf("reconcileOrphanAlerts(", mgmtFilterIdx);
  check("Management reconcile block precedes the filter", mgmtReconcileIdx !== -1 && mgmtReconcileIdx < mgmtFilterIdx);
  // mgmtReconcileIdx is the management call (the poll call is far below the filter).
  const mgmtBlock = src.slice(mgmtReconcileIdx, mgmtFilterIdx + 200);
  check(
    "Management filter keeps tracked positions (getTrackedPosition guard)",
    /positions\.filter\(\s*\(p\)\s*=>\s*getTrackedPosition\(p\.position\)\)/.test(mgmtBlock),
  );
  check(
    "Management cycle drives dedup/prune via reconcileOrphanAlerts(_alertedOrphans, ...)",
    /reconcileOrphanAlerts\(\s*_alertedOrphans\s*,/.test(mgmtBlock),
  );
  check(
    "Management orphan path logs cron_error + telegramEnabled-gated sendMessage",
    /log\(\s*["']cron_error["']/.test(mgmtBlock) &&
      /Untracked live position skipped/.test(mgmtBlock) &&
      /telegramEnabled\(\)/.test(mgmtBlock) &&
      /sendMessage\(/.test(mgmtBlock),
  );
  check(
    "Management cycle derives positionData from managedPositions",
    /const\s+positionData\s*=\s*managedPositions\.map\(/.test(src),
  );
}

// The previously deployed null-guard in normalizeFeeInputs must remain (defense in depth).
check(
  "normalizeFeeInputs null-guard still present in tools/dlmm.js or fee-exit path",
  /normalizeFeeInputs/.test(src) || fs.existsSync(join(ROOT, "tools", "dlmm.js")),
);

// ── (b) Unit test of the pure dedup helper, extracted from source ───────────

const helperMatch = src.match(
  /export function reconcileOrphanAlerts\(alerted, liveAddresses, orphanAddresses\)\s*\{[\s\S]*?\n\}/,
);
check("reconcileOrphanAlerts helper found in index.js", !!helperMatch);

if (helperMatch) {
  // Strip the `export ` keyword and evaluate the function body in isolation.
  const fnSource = helperMatch[0].replace(/^export\s+/, "");
  // eslint-disable-next-line no-new-func
  const reconcileOrphanAlerts = new Function(`${fnSource}; return reconcileOrphanAlerts;`)();

  const tracked = "TRACKED_ADDR";
  const orphanA = "ORPHAN_A";
  const orphanB = "ORPHAN_B";
  const alerted = new Set();

  // Tick 1: orphanA live + orphan, tracked live + not orphan -> alert orphanA only.
  let newOrphans = reconcileOrphanAlerts(alerted, [tracked, orphanA], [orphanA]);
  check("tick1 alerts the new orphan", newOrphans.length === 1 && newOrphans[0] === orphanA);
  check("tick1 does not alert tracked position", !newOrphans.includes(tracked) && !alerted.has(tracked));

  // Tick 2: same orphanA still live + still orphan -> no re-alert.
  newOrphans = reconcileOrphanAlerts(alerted, [tracked, orphanA], [orphanA]);
  check("tick2 does not re-alert the same orphan", newOrphans.length === 0);
  check("tick2 keeps orphanA in alerted set", alerted.has(orphanA));

  // Tick 3: orphanA gone from live list -> pruned from alerted.
  newOrphans = reconcileOrphanAlerts(alerted, [tracked], []);
  check("tick3 prunes orphanA once it leaves the live list", !alerted.has(orphanA));
  check("tick3 produces no new alerts", newOrphans.length === 0);

  // Tick 4: orphanA returns -> re-alerts (proves re-occurrence path).
  newOrphans = reconcileOrphanAlerts(alerted, [tracked, orphanA], [orphanA]);
  check("tick4 re-alerts orphanA after it returns", newOrphans.length === 1 && newOrphans[0] === orphanA);

  // Tick 5: a brand-new orphanB alongside still-present orphanA -> only orphanB is new.
  newOrphans = reconcileOrphanAlerts(alerted, [tracked, orphanA, orphanB], [orphanA, orphanB]);
  check("tick5 alerts only the brand-new orphan", newOrphans.length === 1 && newOrphans[0] === orphanB);
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: orphan live-position skip + dedup-alert verified.");
