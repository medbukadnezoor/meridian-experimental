export function toFiniteNumberOrNull(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function firstFiniteNumber(...values) {
  for (const value of values) {
    const num = toFiniteNumberOrNull(value);
    if (num != null) return num;
  }
  return null;
}

export function nonNegativeNumberOrNull(value, dustFloor = 0) {
  const num = toFiniteNumberOrNull(value);
  if (num == null) return null;
  const normalized = Math.max(0, num);
  return normalized <= Math.max(0, Number(dustFloor ?? 0)) ? 0 : normalized;
}

export function normalizeFeeInputs(position = {}, tracked = {}, options = {}) {
  const solMode = options.solMode === true;
  const dustFloor = Math.max(0, Number(options.dustFloor ?? 0));

  const unclaimedFeeAmount = nonNegativeNumberOrNull(firstFiniteNumber(
    position.unclaimed_fees,
    position.unclaimed_fee,
    position.unclaimed_fee_amount,
    position.unclaimed_fees_amount,
    position.unclaimed_fees_sol,
    position.unclaimed_fee_sol,
    solMode ? position.unclaimed_fees_usd : null,
    solMode ? position.unclaimed_fee_usd : null,
    position.unclaimed_fees_usd,
    position.unclaimed_fee_usd,
  ), dustFloor);

  const claimedFeeAmount = nonNegativeNumberOrNull(firstFiniteNumber(
    position.claimed_fees,
    position.claimed_fee,
    position.claimed_fees_sol,
    tracked.claimed_fees,
    tracked.claimed_fee,
    tracked.claimed_fees_sol,
    tracked.total_fees_claimed_sol,
    solMode ? position.collected_fees_usd : null,
    position.collected_fees_sol,
  ), dustFloor);

  const totalFeeAmount = (() => {
    const explicit = nonNegativeNumberOrNull(firstFiniteNumber(
      position.total_fees,
      position.total_fee,
      position.total_fees_sol,
      tracked.total_fees,
      tracked.total_fee,
      tracked.total_fees_sol,
    ), dustFloor);
    if (explicit != null) return explicit;
    if (unclaimedFeeAmount == null && claimedFeeAmount == null) return null;
    return (unclaimedFeeAmount ?? 0) + (claimedFeeAmount ?? 0);
  })();

  const currentEquityAmount = nonNegativeNumberOrNull(firstFiniteNumber(
    position.equity,
    position.current_equity,
    position.current_value,
    position.total_value,
    position.total_value_sol,
    position.value_sol,
    solMode ? position.total_value_usd : null,
    position.total_value_usd,
  ), dustFloor);

  const entryEquityAmount = nonNegativeNumberOrNull(firstFiniteNumber(
    position.entry_equity,
    position.entry_value,
    position.deposit,
    position.deposit_sol,
    position.amount_sol,
    tracked.entry_equity,
    tracked.entry_value,
    tracked.deposit,
    tracked.deposit_sol,
    tracked.amount_sol,
  ), dustFloor);

  const ageMinutes = firstFiniteNumber(
    position.age_minutes,
    position.age_min,
    position.hold_minutes,
    tracked.age_minutes,
  );
  const pnlPct = firstFiniteNumber(position.pnl_pct, position.pnlPct);

  const feePctOfEntry = entryEquityAmount && totalFeeAmount != null
    ? (totalFeeAmount / entryEquityAmount) * 100
    : null;
  const unclaimedFeePctOfEntry = entryEquityAmount && unclaimedFeeAmount != null
    ? (unclaimedFeeAmount / entryEquityAmount) * 100
    : null;
  const netPnlPct = (() => {
    if (pnlPct != null) return pnlPct;
    if (!entryEquityAmount || currentEquityAmount == null) return null;
    return ((currentEquityAmount + (totalFeeAmount ?? 0) - entryEquityAmount) / entryEquityAmount) * 100;
  })();

  return {
    solMode,
    unit: solMode ? "SOL" : "USD",
    ageMinutes,
    pnlPct,
    netPnlPct,
    unclaimedFeeAmount,
    claimedFeeAmount,
    totalFeeAmount,
    currentEquityAmount,
    entryEquityAmount,
    feePctOfEntry,
    unclaimedFeePctOfEntry,
    missing: {
      ageMinutes: ageMinutes == null,
      totalFeeAmount: totalFeeAmount == null,
      entryEquityAmount: entryEquityAmount == null,
      netPnlPct: netPnlPct == null,
    },
  };
}

export function formatNumber(value, digits = 4) {
  const num = toFiniteNumberOrNull(value);
  return num == null ? "?" : num.toFixed(digits);
}
