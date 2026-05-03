function finiteNumberOrNull(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function isSupertrendBearishConfirmation(indicatorConfirmation = {}) {
  if (!indicatorConfirmation?.confirmed || indicatorConfirmation?.skipped) return false;
  if (indicatorConfirmation.side && indicatorConfirmation.side !== "exit") return false;
  if (indicatorConfirmation.preset && indicatorConfirmation.preset !== "supertrend_break") return false;

  const confirmedIntervals = Array.isArray(indicatorConfirmation.intervals)
    ? indicatorConfirmation.intervals.filter((entry) => entry?.ok && entry?.confirmed)
    : [];

  return confirmedIntervals.some((entry) => {
    const reason = String(entry?.reason || "").toLowerCase();
    const signal = entry?.signal || {};
    return (
      reason.includes("supertrend flipped bearish") ||
      reason.includes("below bearish supertrend") ||
      signal.supertrendBreakDown === true ||
      signal.supertrendDirection === "bearish"
    );
  });
}

function isLossExit(exit = {}, position = {}) {
  const action = String(exit?.action || "").toUpperCase();
  if (action === "TRAILING_TP" || action === "CLAIM" || action === "STAY") return false;

  const currentPnlPct = finiteNumberOrNull(
    exit?.current_pnl_pct ?? position?.pnl_pct ?? exit?.pnl_pct,
  );
  if (currentPnlPct == null || currentPnlPct >= 0) return false;

  const reason = String(exit?.reason || "").toLowerCase();
  if (reason.includes("take profit") || reason.includes("trailing tp")) return false;

  return true;
}

export function isUrgentSupertrendLossExit({ exit, position, indicatorConfirmation } = {}) {
  return isLossExit(exit, position) && isSupertrendBearishConfirmation(indicatorConfirmation);
}

export function formatSupertrendUrgentExitReason(exit = {}, indicatorConfirmation = {}) {
  const exitReason = String(exit?.reason || "loss exit").trim();
  const indicatorReason = String(indicatorConfirmation?.reason || "").trim();
  return indicatorReason
    ? `Supertrend urgent loss exit: ${exitReason}; ${indicatorReason}`
    : `Supertrend urgent loss exit: ${exitReason}`;
}
