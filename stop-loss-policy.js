export function toFiniteNumberOrNull(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function formatPct(value) {
  const num = toFiniteNumberOrNull(value);
  return num == null ? "?" : num.toFixed(2);
}

export function buildStopLossConfirmationResult({
  currentPnlPct,
  stopLossPct,
  delayMs,
  candidatePnlPct,
  pair,
} = {}) {
  const current = toFiniteNumberOrNull(currentPnlPct);
  const stop = toFiniteNumberOrNull(stopLossPct);
  const delaySeconds = Math.round(Math.max(0, Number(delayMs ?? 0)) / 1000);
  const pairLabel = pair ? `${pair} ` : "";

  if (stop == null) {
    return {
      confirmed: false,
      rejected: true,
      rejectionReason: `Stop loss candidate rejected: ${pairLabel}stop threshold unavailable after ${delaySeconds}s recheck`,
    };
  }

  if (current != null && current <= stop) {
    const closeReason = `Stop loss confirmed: PnL ${current.toFixed(2)}% <= ${stop}% after ${delaySeconds}s recheck (candidate ${formatPct(candidatePnlPct)}%)`;
    return {
      confirmed: true,
      rejected: false,
      closeReason,
      logMessage: `[Stop loss confirmed] ${pair || "position"} — ${closeReason} — closing directly`,
    };
  }

  const currentLabel = current == null ? "unavailable" : `${current.toFixed(2)}%`;
  const rejectionReason = `Stop loss candidate rejected: ${pairLabel}PnL ${currentLabel} recovered above ${stop}% after ${delaySeconds}s recheck (candidate ${formatPct(candidatePnlPct)}%)`;
  return {
    confirmed: false,
    rejected: true,
    rejectionReason,
    logMessage: rejectionReason,
  };
}
