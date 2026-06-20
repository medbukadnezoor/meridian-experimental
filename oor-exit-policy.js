import { finiteNumberOrNull } from "./range-state.js";

export function getRecoveryHoldNonFeeExitMinNetPnlPct(managementConfig = {}) {
  if (!managementConfig.recoveryHoldProfileEnabled) return null;
  return finiteNumberOrNull(managementConfig.recoveryHoldNonFeeExitMinNetPnlPct) ?? 0;
}

export function allowsRecoveryHoldNonFeeExit(currentPnlPct, managementConfig = {}, requirePositive = false) {
  if (!requirePositive) return true;
  const minNetPnlPct = getRecoveryHoldNonFeeExitMinNetPnlPct(managementConfig);
  if (minNetPnlPct == null) return true;
  const current = finiteNumberOrNull(currentPnlPct);
  return current != null && current >= minNetPnlPct;
}

export function allowsOutOfRangeExit(
  currentPnlPct,
  managementConfig = {},
  {
    rangeSide = null,
    oorStage = null,
    forceAboveRange = false,
  } = {},
) {
  if (!managementConfig.requirePositivePnlForOutOfRangeExit) return true;

  const current = finiteNumberOrNull(currentPnlPct);
  const isAboveRangeEscape = rangeSide === "above_range" && (oorStage === "hard" || forceAboveRange);
  if (isAboveRangeEscape) {
    return current != null && current >= 0;
  }

  return allowsRecoveryHoldNonFeeExit(current, managementConfig, true);
}
