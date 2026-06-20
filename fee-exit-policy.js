import { formatNumber, normalizeFeeInputs, toFiniteNumberOrNull } from "./fee-helpers.js";

const RULES = [
  "fee_harvest",
  "no_fee_abort",
  "fee_conditional_abort",
  "emergency_failsafe",
  "max_hold_timeout",
];

function boolValue(value, fallback = false) {
  if (value == null) return fallback;
  return value === true || value === "true";
}

function minutes(config, key) {
  const num = toFiniteNumberOrNull(config?.[key]);
  return num == null ? null : Math.max(0, num);
}

function threshold(config, key) {
  return toFiniteNumberOrNull(config?.[key]);
}

function buildDecision(rule, policy, normalized, reason, extra = {}) {
  return {
    action: "FEE_EXIT",
    rule,
    reason,
    urgent: extra.urgent === true,
    shadowOnly: boolValue(policy.shadowOnly, true),
    metrics: {
      unit: normalized.unit,
      age_minutes: normalized.ageMinutes,
      net_pnl_pct: normalized.netPnlPct,
      total_fee_amount: normalized.totalFeeAmount,
      unclaimed_fee_amount: normalized.unclaimedFeeAmount,
      claimed_fee_amount: normalized.claimedFeeAmount,
      entry_equity_amount: normalized.entryEquityAmount,
      current_equity_amount: normalized.currentEquityAmount,
      fee_pct_of_entry: normalized.feePctOfEntry,
      unclaimed_fee_pct_of_entry: normalized.unclaimedFeePctOfEntry,
      strategy_profile: policy.strategyProfile ?? null,
      ...extra.metrics,
    },
  };
}

function requiresNonNegativePnl(policy) {
  return boolValue(policy.positiveOnly, false) || boolValue(policy.recoveryHoldPositiveOnly, false);
}

function hasNonNegativePnl(normalized) {
  return normalized.netPnlPct != null && normalized.netPnlPct >= 0;
}

function hasRequired(...values) {
  return values.every((value) => value != null);
}

function evaluateFeeHarvest(policy, normalized) {
  if (!boolValue(policy.feeHarvestEnabled, false)) return null;
  if (requiresNonNegativePnl(policy) && !hasNonNegativePnl(normalized)) return null;
  const minAge = minutes(policy, "feeHarvestMinHoldMinutes");
  const minFeePct = threshold(policy, "feeHarvestMinFeePctOfEntry");
  const minFeeAmount = threshold(policy, "feeHarvestMinFeeAmount");
  const minNetPnlPct = threshold(policy, "feeHarvestMinNetPnlPct");

  if (minAge != null && (normalized.ageMinutes == null || normalized.ageMinutes < minAge)) return null;
  if (minFeePct != null && (normalized.feePctOfEntry == null || normalized.feePctOfEntry < minFeePct)) return null;
  if (minFeeAmount != null && (normalized.totalFeeAmount == null || normalized.totalFeeAmount < minFeeAmount)) return null;
  if (minNetPnlPct != null && (normalized.netPnlPct == null || normalized.netPnlPct < minNetPnlPct)) return null;
  if (minFeePct == null && minFeeAmount == null) return null;

  return buildDecision(
    "fee_harvest",
    policy,
    normalized,
    `Fee harvest: fees ${formatNumber(normalized.feePctOfEntry, 2)}% of entry (${formatNumber(normalized.totalFeeAmount)} ${normalized.unit}) reached configured harvest threshold`,
  );
}

function evaluateNoFeeAbort(policy, normalized) {
  if (!boolValue(policy.noFeeAbortEnabled, false)) return null;
  if (requiresNonNegativePnl(policy) && !hasNonNegativePnl(normalized)) return null;
  const maxHold = minutes(policy, "noFeeAbortMaxHoldMinutes");
  const maxFeePct = threshold(policy, "noFeeAbortMaxFeePctOfEntry");
  const maxFeeAmount = threshold(policy, "noFeeAbortMaxFeeAmount");
  const maxNetPnlPct = threshold(policy, "noFeeAbortMaxNetPnlPct");

  if (!hasRequired(normalized.ageMinutes, normalized.totalFeeAmount)) return null;
  if (maxHold == null || normalized.ageMinutes < maxHold) return null;
  if (maxFeePct != null && (normalized.feePctOfEntry == null || normalized.feePctOfEntry > maxFeePct)) return null;
  if (maxFeeAmount != null && normalized.totalFeeAmount > maxFeeAmount) return null;
  if (maxNetPnlPct != null && (normalized.netPnlPct == null || normalized.netPnlPct > maxNetPnlPct)) return null;
  if (maxFeePct == null && maxFeeAmount == null) return null;

  return buildDecision(
    "no_fee_abort",
    policy,
    normalized,
    `No-fee abort: age ${formatNumber(normalized.ageMinutes, 0)}m with fees ${formatNumber(normalized.feePctOfEntry, 2)}% of entry (${formatNumber(normalized.totalFeeAmount)} ${normalized.unit}) at or below configured no-fee threshold`,
  );
}

function evaluateFeeConditionalAbort(policy, normalized) {
  if (!boolValue(policy.feeConditionalAbortEnabled, false)) return null;
  if (requiresNonNegativePnl(policy) && !hasNonNegativePnl(normalized)) return null;
  const minHold = minutes(policy, "feeConditionalAbortMinHoldMinutes");
  const maxFeePct = threshold(policy, "feeConditionalAbortMaxFeePctOfEntry");
  const maxFeeAmount = threshold(policy, "feeConditionalAbortMaxFeeAmount");
  const maxNetPnlPct = threshold(policy, "feeConditionalAbortMaxNetPnlPct");
  const minLossPct = threshold(policy, "feeConditionalAbortMinLossPct");

  if (minHold != null && (normalized.ageMinutes == null || normalized.ageMinutes < minHold)) return null;
  if (maxFeePct != null && (normalized.feePctOfEntry == null || normalized.feePctOfEntry > maxFeePct)) return null;
  if (maxFeeAmount != null && (normalized.totalFeeAmount == null || normalized.totalFeeAmount > maxFeeAmount)) return null;
  if (maxNetPnlPct != null && (normalized.netPnlPct == null || normalized.netPnlPct > maxNetPnlPct)) return null;
  if (minLossPct != null && (normalized.netPnlPct == null || normalized.netPnlPct > -Math.abs(minLossPct))) return null;
  if (maxFeePct == null && maxFeeAmount == null) return null;

  return buildDecision(
    "fee_conditional_abort",
    policy,
    normalized,
    `Fee-conditional abort: weak fee capture ${formatNumber(normalized.feePctOfEntry, 2)}% of entry with net PnL ${formatNumber(normalized.netPnlPct, 2)}% crossed configured abort threshold`,
  );
}

function evaluateEmergencyFailsafe(policy, normalized) {
  if (!boolValue(policy.emergencyFailsafeEnabled, false)) return null;
  if (requiresNonNegativePnl(policy) && !hasNonNegativePnl(normalized)) return null;
  const minHold = minutes(policy, "emergencyFailsafeMinHoldMinutes");
  const maxFeePct = threshold(policy, "emergencyFailsafeMaxFeePctOfEntry");
  const minLossPct = threshold(policy, "emergencyFailsafeMinLossPct");

  if (minHold != null && (normalized.ageMinutes == null || normalized.ageMinutes < minHold)) return null;
  if (maxFeePct != null && (normalized.feePctOfEntry == null || normalized.feePctOfEntry > maxFeePct)) return null;
  if (minLossPct == null || normalized.netPnlPct == null || normalized.netPnlPct > -Math.abs(minLossPct)) return null;

  return buildDecision(
    "emergency_failsafe",
    policy,
    normalized,
    `Emergency fee failsafe: net PnL ${formatNumber(normalized.netPnlPct, 2)}% with fees ${formatNumber(normalized.feePctOfEntry, 2)}% of entry crossed configured failsafe`,
    { urgent: true },
  );
}

function evaluateMaxHoldTimeout(policy, normalized) {
  if (!boolValue(policy.maxHoldTimeoutEnabled, false)) return null;
  if (requiresNonNegativePnl(policy) && !hasNonNegativePnl(normalized)) return null;
  const maxHold = minutes(policy, "maxHoldTimeoutMinutes");
  const minNetPnlPct = threshold(policy, "maxHoldTimeoutMinNetPnlPct");

  if (maxHold == null || normalized.ageMinutes == null || normalized.ageMinutes < maxHold) return null;
  if (minNetPnlPct != null && (normalized.netPnlPct == null || normalized.netPnlPct < minNetPnlPct)) return null;

  return buildDecision(
    "max_hold_timeout",
    policy,
    normalized,
    `Max-hold timeout: age ${formatNumber(normalized.ageMinutes, 0)}m reached configured ${formatNumber(maxHold, 0)}m timeout`,
  );
}

const EVALUATORS = {
  fee_harvest: evaluateFeeHarvest,
  no_fee_abort: evaluateNoFeeAbort,
  fee_conditional_abort: evaluateFeeConditionalAbort,
  emergency_failsafe: evaluateEmergencyFailsafe,
  max_hold_timeout: evaluateMaxHoldTimeout,
};

export function resolveFeeExitPolicyConfig(managementConfig = {}) {
  const policy = managementConfig.feeExitPolicy ?? managementConfig.fnmfFeeExitPolicy ?? {};
  return {
    ...policy,
    enabled: boolValue(policy.enabled ?? managementConfig.feeExitPolicyEnabled, false),
    shadowOnly: boolValue(policy.shadowOnly ?? managementConfig.feeExitPolicyShadowOnly, true),
    dustFloor: toFiniteNumberOrNull(policy.dustFloor ?? managementConfig.feeExitPolicyDustFloor) ?? 0,
  };
}

export function evaluateFeeExitPolicy({
  position = {},
  tracked = {},
  managementConfig = {},
} = {}) {
  const policy = resolveFeeExitPolicyConfig(managementConfig);
  const normalized = normalizeFeeInputs(position, tracked, {
    solMode: managementConfig.solMode === true,
    dustFloor: policy.dustFloor,
  });

  if (!policy.enabled) {
    return { enabled: false, decision: null, normalized };
  }

  for (const rule of RULES) {
    const decision = EVALUATORS[rule](policy, normalized);
    if (decision) {
      return { enabled: true, decision, normalized };
    }
  }

  return { enabled: true, decision: null, normalized };
}

export { RULES as FEE_EXIT_RULE_ORDER };
