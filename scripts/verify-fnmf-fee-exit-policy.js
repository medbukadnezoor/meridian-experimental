#!/usr/bin/env node
/**
 * Synthetic proof for fee-normalized management fee (FNmf) exit policy.
 *
 * Does not import index.js, start the bot, call trading APIs, read .env, or
 * touch runtime state. It verifies pure normalization and policy ordering.
 */

import { evaluateFeeExitPolicy } from "../fee-exit-policy.js";
import { feeExitConfluenceBypassReason, shouldGateFeeExitDecision } from "../fee-exit-confluence.js";
import { normalizeFeeInputs } from "../fee-helpers.js";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function source(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function ordered(sourceText, earlier, later, message) {
  const earlierIndex = sourceText.indexOf(earlier);
  const laterIndex = sourceText.indexOf(later);
  assert(earlierIndex >= 0, `${message}: missing earlier marker`);
  assert(laterIndex >= 0, `${message}: missing later marker`);
  assert(earlierIndex < laterIndex, message);
  return true;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function basePosition(overrides = {}) {
  return {
    position: "pos-proof",
    pair: "FNMF-SOL",
    age_minutes: 90,
    pnl_pct: -0.5,
    total_value_usd: 0.148,
    unclaimed_fees_usd: 0.0015,
    ...overrides,
  };
}

function baseTracked(overrides = {}) {
  return {
    amount_sol: 0.15,
    total_fees_claimed_sol: 0,
    ...overrides,
  };
}

function basePolicy(overrides = {}) {
  return {
    solMode: true,
    feeExitPolicy: {
      enabled: true,
      shadowOnly: true,
      dustFloor: 0.000001,
      feeHarvestEnabled: true,
      feeHarvestMinFeePctOfEntry: 1.0,
      feeHarvestMinNetPnlPct: 0.25,
      feeHarvestBypassConfluenceMinFeePctOfEntry: 2.0,
      feeHarvestBypassConfluenceMinNetPnlPct: 0.25,
      feeHarvestBypassConfluenceStrongNetPnlPct: 0.75,
      feeHarvestMinHoldMinutes: 30,
      noFeeAbortEnabled: true,
      noFeeAbortMaxHoldMinutes: 60,
      noFeeAbortMaxFeePctOfEntry: 0.2,
      feeConditionalAbortEnabled: true,
      feeConditionalAbortMinHoldMinutes: 30,
      feeConditionalAbortMaxFeePctOfEntry: 0.5,
      feeConditionalAbortMinLossPct: 2,
      emergencyFailsafeEnabled: true,
      emergencyFailsafeMinHoldMinutes: 10,
      emergencyFailsafeMaxFeePctOfEntry: 0.5,
      emergencyFailsafeMinLossPct: 8,
      maxHoldTimeoutEnabled: true,
      maxHoldTimeoutMinutes: 180,
      exitConfluenceEnabled: true,
      exitConfluenceRules: ["fee_harvest", "max_hold_timeout"],
      ...overrides,
    },
  };
}

function decisionFor(positionOverrides = {}, policyOverrides = {}, trackedOverrides = {}) {
  return evaluateFeeExitPolicy({
    position: basePosition(positionOverrides),
    tracked: baseTracked(trackedOverrides),
    managementConfig: basePolicy(policyOverrides),
  }).decision;
}

function main() {
  const defaultOff = evaluateFeeExitPolicy({
    position: basePosition(),
    tracked: baseTracked(),
    managementConfig: { solMode: true },
  });
  assert(defaultOff.enabled === false, "policy must default off");
  assert(defaultOff.decision == null, "default-off policy must not emit a decision");

  const normalizedSol = normalizeFeeInputs(
    basePosition({ unclaimed_fees_usd: 0.000000001, total_value_usd: 0.149 }),
    baseTracked({ amount_sol: 0.15, total_fees_claimed_sol: 0.001 }),
    { solMode: true, dustFloor: 0.000001 },
  );
  assert(normalizedSol.unit === "SOL", "SOL mode should label normalized units as SOL");
  assert(normalizedSol.unclaimedFeeAmount === 0, "dust unclaimed fees should normalize to zero");
  assert(normalizedSol.totalFeeAmount === 0.001, "claimed fees should be preserved when unclaimed is dust");
  assert(Math.abs(normalizedSol.feePctOfEntry - 0.6666666667) < 0.0001, "fee percent should normalize against entry equity");

  const orderedHarvest = decisionFor({ pnl_pct: 0.5, total_value_usd: 0.151, unclaimed_fees_usd: 0.003 }, {});
  assert(orderedHarvest?.rule === "fee_harvest", "fee_harvest must remain the first positive fee-exit rule");
  assert(orderedHarvest.shadowOnly === true, "policy should default to shadow-only when enabled");

  const noFeeAbort = decisionFor({ age_minutes: 70, pnl_pct: 0, unclaimed_fees_usd: 0.0001 }, {
    feeHarvestEnabled: false,
  });
  assert(noFeeAbort?.rule === "no_fee_abort", "low fee after max hold should no-fee abort");

  const conditionalAbort = decisionFor({ age_minutes: 45, pnl_pct: -3, unclaimed_fees_usd: 0.0003 }, {
    feeHarvestEnabled: false,
    noFeeAbortEnabled: false,
  });
  assert(conditionalAbort?.rule === "fee_conditional_abort", "loss plus weak fees should conditional abort");

  const emergency = decisionFor({ age_minutes: 20, pnl_pct: -9, unclaimed_fees_usd: 0.0002 }, {
    feeHarvestEnabled: false,
    noFeeAbortEnabled: false,
    feeConditionalAbortEnabled: false,
  });
  assert(emergency?.rule === "emergency_failsafe", "deep loss plus weak fees should emergency failsafe");
  assert(emergency?.urgent === true, "emergency failsafe should be urgent");

  const maxHold = decisionFor({ age_minutes: 181, pnl_pct: 0.1, unclaimed_fees_usd: 0.001 }, {
    feeHarvestEnabled: false,
    noFeeAbortEnabled: false,
    feeConditionalAbortEnabled: false,
    emergencyFailsafeEnabled: false,
  });
  assert(maxHold?.rule === "max_hold_timeout", "max hold timeout should be the final ordered rule");

  const liveDecision = decisionFor({ pnl_pct: 0.5, total_value_usd: 0.151, unclaimed_fees_usd: 0.0016 }, { shadowOnly: false });
  assert(liveDecision?.rule === "fee_harvest", "live policy should still evaluate threshold cases");
  assert(liveDecision.shadowOnly === false, "shadowOnly:false must be preserved for runtime close gating");
  assert(shouldGateFeeExitDecision(liveDecision, basePolicy().feeExitPolicy) === true, "base live fee harvest should enter confluence gate");
  assert(feeExitConfluenceBypassReason(liveDecision, basePolicy().feeExitPolicy) === null, "base live fee harvest should not bypass confluence");

  const highFeeDecision = decisionFor({ pnl_pct: 0.3, total_value_usd: 0.1505, unclaimed_fees_usd: 0.0031 }, { shadowOnly: false });
  assert(highFeeDecision?.rule === "fee_harvest", "high-fee positive policy should still be a fee harvest");
  assert(
    feeExitConfluenceBypassReason(highFeeDecision, basePolicy().feeExitPolicy) === "fee_harvest_fee_and_net_pnl_bypass",
    "high-fee positive harvest should bypass confluence",
  );

  const strongNetDecision = decisionFor({ pnl_pct: 0.8, total_value_usd: 0.151, unclaimed_fees_usd: 0.0016 }, { shadowOnly: false });
  assert(strongNetDecision?.rule === "fee_harvest", "strong net policy should still be a fee harvest");
  assert(
    feeExitConfluenceBypassReason(strongNetDecision, basePolicy().feeExitPolicy) === "fee_harvest_strong_net_pnl_bypass",
    "strong net positive harvest should bypass confluence",
  );

  const missingFeeSafety = decisionFor({ unclaimed_fees_usd: null }, {
    feeHarvestEnabled: false,
    noFeeAbortEnabled: true,
    noFeeAbortMaxHoldMinutes: 60,
    noFeeAbortMaxFeePctOfEntry: 0.2,
  }, { total_fees_claimed_sol: null });
  assert(missingFeeSafety == null, "missing fee data must not trigger fee abort rules");

  const indexSource = source("index.js");
  const deterministicBody = indexSource.match(/function getDeterministicCloseRule[\s\S]*?\n}\n\n\/\/ ═/)?.[0] ?? "";
  const pnlPollBody = indexSource.match(/const pnlPollInterval = setInterval\(async \(\) => \{[\s\S]*?_pnlPollBusy = false;\n    }\n  }, pnlPollIntervalMs\);/)?.[0] ?? "";
  const managementBody = indexSource.match(/const closeRule = getDeterministicCloseRule\(p, config\.management\);[\s\S]*?\/\/ No close rule/)?.[0] ?? "";
  const noCloseRuleBody = indexSource.match(/\/\/ No close rule[\s\S]*?\/\/ Claim rule/)?.[0] ?? "";
  assert(deterministicBody, "deterministic close rule body should be found");
  assert(pnlPollBody, "PnL poll body should be found");
  assert(managementBody, "management close-rule body should be found");
  assert(noCloseRuleBody, "management no-close-rule body should be found");

  const sourceOrder = {
    deterministicOorBeforeTakeProfit: ordered(
      deterministicBody,
      'rangeSide === "above_range"',
      'reason: "take profit"',
      "deterministic OOR checks must run before ordinary take profit",
    ),
    pnlPollStopBeforeFee: ordered(
      pnlPollBody,
      "URGENT deterministic stop-loss",
      'tryLiveFeeExitPolicy(p, "PnL poll")',
      "PnL poll stop-loss must stay ahead of fee exits",
    ),
    pnlPollOorBeforeFee: ordered(
      pnlPollBody,
      "OOR reposition close rule",
      'tryLiveFeeExitPolicy(p, "PnL poll")',
      "PnL poll OOR reposition must stay ahead of fee exits",
    ),
    pnlPollFeeBeforeOrdinaryRules: ordered(
      pnlPollBody,
      'tryLiveFeeExitPolicy(p, "PnL poll")',
      "Non-stop-loss deterministic rules",
      "PnL poll fee exits must precede ordinary deterministic TP/low-yield handling",
    ),
    managementOorBeforeFee: ordered(
      managementBody,
      "isOorRepositionCloseRule(closeRule)",
      'tryLiveFeeExitPolicy(p, "Management cycle")',
      "management OOR reposition must stay ahead of fee exits",
    ),
    managementFeeBeforeLowYield: ordered(
      managementBody,
      'tryLiveFeeExitPolicy(p, "Management cycle")',
      'closeRule.reason === "low yield"',
      "management fee exits must precede ordinary low-yield handling",
    ),
    managementNoCloseFeeBeforeClaim: ordered(
      noCloseRuleBody,
      'tryLiveFeeExitPolicy(p, "Management cycle")',
      "Claim rule",
      "management fee exits must precede claim/STAY when no deterministic close rule exists",
    ),
  };

  console.log(JSON.stringify({
    success: true,
    defaultOff: defaultOff.decision,
    normalizedSol: {
      unit: normalizedSol.unit,
      unclaimedFeeAmount: normalizedSol.unclaimedFeeAmount,
      totalFeeAmount: normalizedSol.totalFeeAmount,
      feePctOfEntry: Number(normalizedSol.feePctOfEntry.toFixed(4)),
    },
    orderedRules: [
      orderedHarvest.rule,
      noFeeAbort.rule,
      conditionalAbort.rule,
      emergency.rule,
      maxHold.rule,
    ],
    liveShadowOnly: liveDecision.shadowOnly,
    hybridBypassReasons: [
      feeExitConfluenceBypassReason(liveDecision, basePolicy().feeExitPolicy),
      feeExitConfluenceBypassReason(highFeeDecision, basePolicy().feeExitPolicy),
      feeExitConfluenceBypassReason(strongNetDecision, basePolicy().feeExitPolicy),
    ],
    missingFeeSafety: missingFeeSafety ?? null,
    sourceOrder,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ success: false, error: error.message }, null, 2));
  process.exit(1);
}
