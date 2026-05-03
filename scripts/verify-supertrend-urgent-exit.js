#!/usr/bin/env node
/**
 * Synthetic proof for PHASE2A-SUPERTREND-URGENT-T1.
 *
 * Does not import index.js, start cron, run the bot, or call trading APIs.
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  formatSupertrendUrgentExitReason,
  isUrgentSupertrendLossExit,
} from "../supertrend-urgent-exit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function supertrendConfirmation(overrides = {}) {
  return {
    enabled: true,
    confirmed: true,
    skipped: false,
    preset: "supertrend_break",
    side: "exit",
    reason: "supertrend_break confirmed on 15_MINUTE",
    intervals: [
      {
        interval: "15_MINUTE",
        ok: true,
        confirmed: true,
        reason: "Supertrend flipped bearish",
        signal: {
          supertrendBreakDown: true,
          supertrendDirection: "bearish",
        },
      },
    ],
    ...overrides,
  };
}

function main() {
  const lossExit = {
    action: "OUT_OF_RANGE",
    reason: "OOR: active bin above range for 180m",
  };
  const lossPosition = { pair: "LOSS-SOL", position: "pos-loss", pnl_pct: -6.12 };

  const urgent = isUrgentSupertrendLossExit({
    exit: lossExit,
    position: lossPosition,
    indicatorConfirmation: supertrendConfirmation(),
  });
  assert(urgent === true, "Supertrend bearish/breakdown confirmation plus loss PnL should be urgent-worthy");

  const nonSupertrend = isUrgentSupertrendLossExit({
    exit: lossExit,
    position: lossPosition,
    indicatorConfirmation: supertrendConfirmation({
      preset: "rsi_reversal",
      reason: "rsi_reversal confirmed on 15_MINUTE",
      intervals: [{ interval: "15_MINUTE", ok: true, confirmed: true, reason: "RSI 82 >= overbought 80", signal: {} }],
    }),
  });
  assert(nonSupertrend === false, "Non-Supertrend confirmations should not become urgent");

  const profitableSupertrend = isUrgentSupertrendLossExit({
    exit: lossExit,
    position: { ...lossPosition, pnl_pct: 2.4 },
    indicatorConfirmation: supertrendConfirmation(),
  });
  assert(profitableSupertrend === false, "Profitable Supertrend-confirmed exits should not become urgent");

  const trailingSupertrend = isUrgentSupertrendLossExit({
    exit: {
      action: "TRAILING_TP",
      reason: "Trailing TP: peak 8.00% -> current 4.00%",
      current_pnl_pct: 4,
    },
    position: { ...lossPosition, pnl_pct: 4 },
    indicatorConfirmation: supertrendConfirmation(),
  });
  assert(trailingSupertrend === false, "Trailing TP Supertrend confirmations should not become urgent");

  const formattedReason = formatSupertrendUrgentExitReason(lossExit, supertrendConfirmation());
  assert(
    formattedReason.includes("Supertrend urgent loss exit:") &&
      formattedReason.includes(lossExit.reason) &&
      formattedReason.includes("supertrend_break confirmed"),
    "Urgent direct close reason should preserve exit and indicator audit context",
  );

  const indexSource = readFileSync(join(ROOT, "index.js"), "utf8");
  const branchMatch = indexSource.match(/if \(isUrgentSupertrendLossExit\(\{ exit, position: p, indicatorConfirmation \}\)\) \{[\s\S]*?break;\n\s*\}/);
  assert(branchMatch, "PnL poller should contain a scoped urgent Supertrend loss branch");
  const branch = branchMatch[0];
  assert(
    branch.includes('closeUrgentStopLossDirect(p, urgentReason, "PnL poll Supertrend loss", null)'),
    "Supertrend branch should use direct close with a precise audit label",
  );
  assert(branch.includes("falling back to management") && branch.includes("runManagementCycle({ silent: true })"), "Direct failure should fall back to management");
  assert(!branch.includes("sinceLastTrigger") && !branch.includes("cooldownMs"), "Supertrend branch should not use shared poll cooldown checks");

  const branchIndex = indexSource.indexOf(branch);
  const stopLossIndex = indexSource.indexOf('const isStopLoss = exit.action === "STOP_LOSS";', branchIndex);
  assert(stopLossIndex > branchIndex, "Supertrend urgent branch should run before generic cooldown/management routing");

  const sourceMarkers = {
    helperRecognizesSupertrendLoss: urgent === true,
    nonSupertrendNotUrgent: nonSupertrend === false,
    profitableSupertrendNotUrgent: profitableSupertrend === false,
    trailingTpNotUrgent: trailingSupertrend === false,
    pnlPollerDirectClose: branch.includes("closeUrgentStopLossDirect"),
    pnlPollerBypassesCooldown: !branch.includes("sinceLastTrigger") && !branch.includes("cooldownMs"),
    directFailureFallback: branch.includes("runManagementCycle({ silent: true })"),
  };

  console.log(JSON.stringify({ success: true, sourceMarkers, formattedReason }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
