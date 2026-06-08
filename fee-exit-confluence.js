function finiteNumberOrNull(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function average(values) {
  const finite = values.map(finiteNumberOrNull).filter((value) => value != null);
  if (!finite.length) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function stdDev(values, mean) {
  const finite = values.map(finiteNumberOrNull).filter((value) => value != null);
  if (!finite.length || mean == null) return null;
  const variance = finite.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / finite.length;
  return Math.sqrt(variance);
}

function ema(values, period) {
  const finite = values.map(finiteNumberOrNull).filter((value) => value != null);
  if (finite.length < period || period <= 0) return [];
  const k = 2 / (period + 1);
  const result = [];
  let prev = average(finite.slice(0, period));
  result.push(prev);
  for (let i = period; i < finite.length; i++) {
    prev = (finite[i] * k) + (prev * (1 - k));
    result.push(prev);
  }
  return result;
}

export function calculateRsi(closes = [], period = 2) {
  const values = closes.map(finiteNumberOrNull).filter((value) => value != null);
  if (values.length <= period || period <= 0) return null;
  let gains = 0;
  let losses = 0;
  const start = values.length - period;
  for (let i = start; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

export function calculateBollingerUpper(closes = [], period = 20, multiplier = 2) {
  const values = closes.map(finiteNumberOrNull).filter((value) => value != null);
  if (values.length < period || period <= 0) return null;
  const window = values.slice(-period);
  const mean = average(window);
  const sd = stdDev(window, mean);
  return mean == null || sd == null ? null : mean + (sd * multiplier);
}

export function calculateMacdHistogram(closes = []) {
  const values = closes.map(finiteNumberOrNull).filter((value) => value != null);
  const fast = ema(values, 12);
  const slow = ema(values, 26);
  if (!fast.length || !slow.length) return [];
  const offset = fast.length - slow.length;
  const macd = slow.map((slowValue, index) => fast[index + offset] - slowValue);
  const signal = ema(macd, 9);
  if (!signal.length) return [];
  const signalOffset = macd.length - signal.length;
  return signal.map((signalValue, index) => macd[index + signalOffset] - signalValue);
}

function rowClose(row) {
  return finiteNumberOrNull(row?.close ?? row?.c);
}

function rowOpen(row) {
  return finiteNumberOrNull(row?.open ?? row?.o);
}

export function evaluateFeeExitConfluenceFromRows(rows = [], policy = {}) {
  if (policy.exitConfluenceEnabled !== true) {
    return { enabled: false, accepted: true, reason: "exit confluence disabled", signalCount: 0, signals: {} };
  }

  const minSignals = Math.max(1, Math.trunc(Number(policy.exitConfluenceMinSignals ?? 2) || 2));
  const rsiPeriod = Math.max(1, Math.trunc(Number(policy.exitConfluenceRsiPeriod ?? 2) || 2));
  const rsiOverbought = Number(policy.exitConfluenceRsiOverbought ?? 90);
  const bbPeriod = Math.max(2, Math.trunc(Number(policy.exitConfluenceBbPeriod ?? 20) || 20));
  const bbStdDev = Math.max(0.1, Number(policy.exitConfluenceBbStdDev ?? 2) || 2);
  const minRows = Math.max(bbPeriod + 5, 35);
  const sorted = (Array.isArray(rows) ? rows : [])
    .filter((row) => rowClose(row) != null)
    .sort((a, b) => Number(a.timestamp ?? a.t ?? 0) - Number(b.timestamp ?? b.t ?? 0));

  if (sorted.length < minRows) {
    return {
      enabled: true,
      accepted: false,
      reason: `exit confluence unavailable: ${sorted.length}/${minRows} OHLCV rows`,
      signalCount: 0,
      signals: {},
    };
  }

  const closes = sorted.map(rowClose);
  const latest = sorted[sorted.length - 1];
  const latestClose = rowClose(latest);
  const latestOpen = rowOpen(latest);
  const rsi = calculateRsi(closes, rsiPeriod);
  const upperBand = calculateBollingerUpper(closes, bbPeriod, bbStdDev);
  const histogram = calculateMacdHistogram(closes);
  const prevHist = histogram.length >= 2 ? histogram[histogram.length - 2] : null;
  const currHist = histogram.length >= 1 ? histogram[histogram.length - 1] : null;
  const closeTwoBarsAgo = closes.length >= 3 ? closes[closes.length - 3] : null;

  const signals = {
    rsi_overbought: rsi != null && rsi >= rsiOverbought,
    bollinger_upper_break: latestClose != null && upperBand != null && latestClose >= upperBand,
    macd_first_green: prevHist != null && currHist != null && prevHist < 0 && currHist > 0,
    green_candle_or_bounce: (
      latestClose != null &&
      ((latestOpen != null && latestClose > latestOpen) || (closeTwoBarsAgo != null && latestClose > closeTwoBarsAgo))
    ),
  };
  const signalCount = Object.values(signals).filter(Boolean).length;

  return {
    enabled: true,
    accepted: signalCount >= minSignals,
    reason: signalCount >= minSignals
      ? `exit confluence passed: ${signalCount}/${minSignals} signals`
      : `exit confluence held: ${signalCount}/${minSignals} signals`,
    signalCount,
    signals,
    metrics: {
      rsi,
      rsiOverbought,
      upperBand,
      latestClose,
      latestOpen,
      prevMacdHistogram: prevHist,
      currMacdHistogram: currHist,
      rowCount: sorted.length,
    },
  };
}

export function shouldGateFeeExitDecision(decision = {}, policy = {}) {
  if (policy.exitConfluenceEnabled !== true) return false;
  if (!decision || decision.urgent === true) return false;
  if (["no_fee_abort", "fee_conditional_abort", "emergency_failsafe"].includes(decision.rule)) {
    return false;
  }
  const rules = Array.isArray(policy.exitConfluenceRules)
    ? policy.exitConfluenceRules
    : ["fee_harvest", "max_hold_timeout"];
  if (!rules.includes(decision.rule)) return false;
  if (decision.rule === "max_hold_timeout" && policy.maxHoldTimeoutBypassesConfluence === true) {
    return false;
  }
  return true;
}
