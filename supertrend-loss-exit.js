import { clearSupertrendLossExitCheck, recordSupertrendLossExitCheck } from "./state.js";

function finiteNumberOrNull(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeInterval(value) {
  const normalized = String(value || "15_MINUTE").trim().toUpperCase();
  return normalized === "5_MINUTE" || normalized === "15_MINUTE"
    ? normalized
    : "15_MINUTE";
}

export async function evaluateSupertrendLossExit(
  position,
  managementConfig = {},
  {
    fetchIndicators = null,
    buildSummary = null,
  } = {},
) {
  const positionAddress = position?.position;
  if (!positionAddress) return null;

  if (!managementConfig.supertrendLossExitEnabled) {
    clearSupertrendLossExitCheck(positionAddress);
    return null;
  }

  const thresholdPct = finiteNumberOrNull(managementConfig.supertrendLossExitPnlPct);
  const currentPnlPct = finiteNumberOrNull(position?.pnl_pct);
  if (thresholdPct == null || currentPnlPct == null || position?.pnl_pct_suspicious || currentPnlPct > thresholdPct) {
    clearSupertrendLossExitCheck(positionAddress);
    return null;
  }

  if (!position?.base_mint) {
    clearSupertrendLossExitCheck(positionAddress);
    return null;
  }

  const interval = normalizeInterval(managementConfig.supertrendLossExitInterval);
  const confirmChecks = Math.max(1, Math.trunc(Number(managementConfig.supertrendLossExitConfirmChecks ?? 2) || 2));
  let summary = null;

  try {
    const chartIndicators = fetchIndicators && buildSummary
      ? null
      : await import("./tools/chart-indicators.js");
    const fetchFn = fetchIndicators || chartIndicators.fetchChartIndicatorsForMint;
    const buildSummaryFn = buildSummary || chartIndicators.buildSignalSummary;
    const payload = await fetchFn(position.base_mint, { interval });
    summary = buildSummaryFn(payload);
  } catch {
    clearSupertrendLossExitCheck(positionAddress);
    return null;
  }

  const direction = String(summary?.supertrendDirection || "unknown").toLowerCase();
  if (direction !== "bearish") {
    clearSupertrendLossExitCheck(positionAddress);
    return null;
  }

  const check = recordSupertrendLossExitCheck(positionAddress, {
    bearish: true,
    confirmChecks,
  });

  if (!check.confirmed) {
    return {
      action: "SUPER_TREND_LOSS_EXIT_PENDING",
      pending: true,
      count: check.count,
      confirmChecks: check.confirmChecks,
      reason: `Supertrend loss exit pending: PnL ${currentPnlPct.toFixed(2)}% <= ${thresholdPct}% and ${intervalLabel(interval)} Supertrend bearish (${check.count}/${check.confirmChecks})`,
      signal: summary,
      interval,
    };
  }

  return {
    action: "STOP_LOSS",
    rule: "supertrend_loss_exit",
    reason: `Supertrend loss exit: PnL ${currentPnlPct.toFixed(2)}% <= ${thresholdPct}% and ${intervalLabel(interval)} Supertrend bearish for ${check.confirmChecks} checks`,
    indicatorPolicy: "bypass",
    urgent: true,
    signal: summary,
    interval,
    count: check.count,
    confirmChecks: check.confirmChecks,
  };
}

function intervalLabel(interval) {
  return interval === "15_MINUTE" ? "15m" : "5m";
}
