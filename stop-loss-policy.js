export function toFiniteNumberOrNull(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function formatPct(value) {
  const num = toFiniteNumberOrNull(value);
  return num == null ? "?" : num.toFixed(2);
}

export function calculatePnlVelocityDrop(history = [], currentPnlPct, windowMs, nowMs = Date.now()) {
  const current = toFiniteNumberOrNull(currentPnlPct);
  const window = Math.max(0, Number(windowMs ?? 0));
  if (current == null || window <= 0 || !Array.isArray(history) || history.length === 0) {
    return { dropPct: null, elapsedMs: null, baselinePnlPct: null };
  }

  const cutoffMs = nowMs - window;
  let baseline = null;
  for (const point of history) {
    const tsMs = new Date(point?.ts).getTime();
    const pnlPct = toFiniteNumberOrNull(point?.pnl_pct);
    if (!Number.isFinite(tsMs) || pnlPct == null || tsMs < cutoffMs || tsMs > nowMs) continue;
    if (!baseline || pnlPct > baseline.pnlPct) {
      baseline = { tsMs, pnlPct };
    }
  }

  if (!baseline) return { dropPct: null, elapsedMs: null, baselinePnlPct: null };

  return {
    dropPct: current - baseline.pnlPct,
    elapsedMs: Math.max(0, nowMs - baseline.tsMs),
    baselinePnlPct: baseline.pnlPct,
  };
}

export function calculateRollingPeakDrawdown(history = [], currentPnlPct, windowMs, nowMs = Date.now()) {
  const current = toFiniteNumberOrNull(currentPnlPct);
  const window = Math.max(0, Number(windowMs ?? 0));
  if (current == null || window <= 0 || !Array.isArray(history) || history.length === 0) {
    return { peakPnlPct: null, dropPct: null, elapsedMs: null };
  }

  const cutoffMs = nowMs - window;
  let peak = null;
  for (const point of history) {
    const tsMs = new Date(point?.ts).getTime();
    const pnlPct = toFiniteNumberOrNull(point?.pnl_pct);
    if (!Number.isFinite(tsMs) || pnlPct == null || tsMs < cutoffMs || tsMs > nowMs) continue;
    if (!peak || pnlPct > peak.pnlPct) {
      peak = { tsMs, pnlPct };
    }
  }

  if (!peak) return { peakPnlPct: null, dropPct: null, elapsedMs: null };

  return {
    peakPnlPct: peak.pnlPct,
    dropPct: peak.pnlPct - current,
    elapsedMs: Math.max(0, nowMs - peak.tsMs),
  };
}

export function buildRollingDrawdownExitDecision({
  currentPnlPct,
  managementConfig = {},
  rollingDrawdown = null,
  immediateAction = "STOP_LOSS",
  rule = "rolling_fast_drawdown",
} = {}) {
  if (!managementConfig.rollingDrawdownExitEnabled) return null;

  const current = toFiniteNumberOrNull(currentPnlPct);
  const currentThreshold = toFiniteNumberOrNull(managementConfig.rollingDrawdownCurrentPnlPct);
  const minPeak = toFiniteNumberOrNull(managementConfig.rollingDrawdownMinPeakPct);
  const minDrop = toFiniteNumberOrNull(managementConfig.rollingDrawdownMinDropPct);
  const windowMs = Math.max(0, Number(managementConfig.rollingDrawdownWindowMs ?? 0));
  const peak = toFiniteNumberOrNull(rollingDrawdown?.peakPnlPct);
  const drop = toFiniteNumberOrNull(rollingDrawdown?.dropPct);
  const elapsedMs = toFiniteNumberOrNull(rollingDrawdown?.elapsedMs);

  if (
    current == null ||
    currentThreshold == null ||
    minPeak == null ||
    minDrop == null ||
    windowMs <= 0 ||
    peak == null ||
    drop == null ||
    current > currentThreshold ||
    peak < minPeak ||
    drop < minDrop
  ) {
    return null;
  }

  const elapsedMinutes = elapsedMs == null ? "?" : Math.round(Math.max(0, elapsedMs) / 60_000);
  const windowMinutes = Math.round(windowMs / 60_000);
  return {
    action: immediateAction,
    rule,
    reason: `Rolling fast drawdown: peak ${peak.toFixed(2)}% -> current ${current.toFixed(2)}% (drop ${drop.toFixed(2)}pp over ${elapsedMinutes}m <= window ${windowMinutes}m)`,
    urgent: true,
    peak_pnl_pct: peak,
    current_pnl_pct: current,
    drop_from_peak_pct: drop,
    elapsed_ms: elapsedMs,
    window_ms: windowMs,
  };
}

export function buildStopLossExitDecision({
  currentPnlPct,
  managementConfig = {},
  velocityDropPct = null,
  velocityElapsedMs = null,
  immediateAction = "STOP_LOSS",
  rule = null,
  includeSoftStop = true,
} = {}) {
  const current = toFiniteNumberOrNull(currentPnlPct);
  const stopLossPct = toFiniteNumberOrNull(managementConfig.stopLossPct);
  if (current == null || stopLossPct == null) return null;

  const hardStopLossPct = toFiniteNumberOrNull(managementConfig.hardStopLossPct);
  if (hardStopLossPct != null && current <= hardStopLossPct) {
    return {
      action: immediateAction,
      rule,
      reason: `Hard stop loss: PnL ${current.toFixed(2)}% <= ${hardStopLossPct}%`,
      urgent: true,
    };
  }

  const fastClosePct = toFiniteNumberOrNull(managementConfig.stopLossFastClosePct);
  if (fastClosePct != null && current <= fastClosePct) {
    return {
      action: immediateAction,
      rule,
      reason: `Fast stop loss: PnL ${current.toFixed(2)}% <= ${fastClosePct}%`,
      urgent: true,
    };
  }

  if (current > stopLossPct) return null;

  const velocityClosePct = toFiniteNumberOrNull(managementConfig.stopLossVelocityClosePct);
  const velocityThreshold = velocityClosePct == null ? null : Math.abs(velocityClosePct);
  const drop = toFiniteNumberOrNull(velocityDropPct);
  if (velocityThreshold != null && drop != null && drop <= -velocityThreshold) {
    const elapsedSeconds = velocityElapsedMs == null ? "?" : Math.round(Math.max(0, Number(velocityElapsedMs)) / 1000);
    return {
      action: immediateAction,
      rule,
      reason: `Velocity stop loss: PnL ${current.toFixed(2)}%, dropped ${drop.toFixed(2)}pp over ${elapsedSeconds}s`,
      urgent: true,
    };
  }

  if (!includeSoftStop) return null;

  const stopLossConfirmDelayMs = Math.max(0, Number(managementConfig.stopLossConfirmDelayMs ?? 0));
  if (stopLossConfirmDelayMs > 0) {
    return {
      action: "STOP_LOSS_CANDIDATE",
      rule,
      reason: `Stop loss candidate: PnL ${current.toFixed(2)}% <= ${stopLossPct}%`,
      needs_confirmation: true,
      current_pnl_pct: current,
      stop_loss_pct: stopLossPct,
      confirm_delay_ms: stopLossConfirmDelayMs,
    };
  }

  return {
    action: immediateAction,
    rule,
    reason: `Stop loss: PnL ${current.toFixed(2)}% <= ${stopLossPct}%`,
  };
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
      logMessage: `[Stop loss confirmed] ${pair || "position"} - ${closeReason} - closing directly`,
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
