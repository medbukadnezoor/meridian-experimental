function finiteNumber(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function evaluateActiveBinBelowRangeEmergency(row = {}, {
  liveEnabled = false,
  pnlThresholdPct = -10,
  entryDrawdownThresholdPct = -20,
} = {}) {
  const activeBin = finiteNumber(row.activeBin ?? row.active_bin);
  const lowerBin = finiteNumber(row.lowerBin ?? row.lower_bin);
  const upperBin = finiteNumber(row.upperBin ?? row.upper_bin);
  const pnlPct = finiteNumber(row.pnlPct ?? row.pnl_pct ?? row.nearestPnlPct);
  const entryDrawdownPct = finiteNumber(row.entryDrawdownPct ?? row.ohlcvEntryDrawdownPct);
  const belowRange = row.rangeSide === "below_range" || row.range_side === "below_range" || (activeBin != null && lowerBin != null && activeBin < lowerBin);
  const rangeWidth = lowerBin != null && upperBin != null ? Math.abs(upperBin - lowerBin) || null : null;
  const belowLowerBins = belowRange && activeBin != null && lowerBin != null ? lowerBin - activeBin : null;
  const belowLowerPctOfRange = belowLowerBins != null && rangeWidth ? (belowLowerBins / rangeWidth) * 100 : null;
  const reasonCodes = [];

  if (!belowRange) reasonCodes.push("not_below_range");
  if (belowRange && pnlPct != null && pnlPct <= pnlThresholdPct) reasonCodes.push("below_range_negative_pnl");
  if (belowRange && belowLowerPctOfRange != null && belowLowerPctOfRange >= 100 && pnlPct != null && pnlPct <= -5) {
    reasonCodes.push("deep_below_range_negative_pnl");
  }
  if (belowRange && entryDrawdownPct != null && entryDrawdownPct <= entryDrawdownThresholdPct) {
    reasonCodes.push("below_range_ohlcv_entry_collapse");
  }

  const compoundHit = reasonCodes.some((reason) => reason !== "not_below_range");
  return {
    event: "active_bin_below_range_emergency_shadow",
    activeBin,
    lowerBin,
    upperBin,
    rangeSide: belowRange ? "below_range" : row.rangeSide ?? row.range_side ?? null,
    pnlPct,
    entryDrawdownPct,
    belowLowerBins,
    belowLowerPctOfRange,
    decision: compoundHit ? (liveEnabled ? "blocked" : "would_close_shadow") : "pass",
    reasonCodes,
    shadowOnly: !liveEnabled,
    liveCloseEnabled: liveEnabled === true,
    blindBelowRangeCloseAllowed: false,
  };
}
