#!/usr/bin/env node
/**
 * Synthetic proof for fee-normalized management fee (FNmf) exit policy.
 *
 * Does not import index.js, start the bot, call trading APIs, read .env, or
 * touch runtime state. It verifies pure normalization and policy ordering.
 */

import { evaluateFeeExitPolicy } from "../fee-exit-policy.js";
import { normalizeFeeInputs } from "../fee-helpers.js";

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

  const orderedHarvest = decisionFor({ pnl_pct: -20, unclaimed_fees_usd: 0.003 }, {});
  assert(orderedHarvest?.rule === "fee_harvest", "fee_harvest must win when multiple later rules also match");
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

  const liveDecision = decisionFor({ unclaimed_fees_usd: 0.003 }, { shadowOnly: false });
  assert(liveDecision?.rule === "fee_harvest", "live policy should still evaluate threshold cases");
  assert(liveDecision.shadowOnly === false, "shadowOnly:false must be preserved for runtime close gating");

  const missingFeeSafety = decisionFor({ unclaimed_fees_usd: null }, {
    feeHarvestEnabled: false,
    noFeeAbortEnabled: true,
    noFeeAbortMaxHoldMinutes: 60,
    noFeeAbortMaxFeePctOfEntry: 0.2,
  }, { total_fees_claimed_sol: null });
  assert(missingFeeSafety == null, "missing fee data must not trigger fee abort rules");

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
    missingFeeSafety: missingFeeSafety ?? null,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ success: false, error: error.message }, null, 2));
  process.exit(1);
}
