function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function withRepair(repairs, field, from, to, reason) {
  repairs.push({ field, from: from ?? null, to, reason });
}

export function normalizeForcedSingleSidedSolBidAskArgs(args = {}, options = {}) {
  const force = options.force === true;
  if (!force) return { ok: true, args, repairs: [], forced: false };

  const deployAmountSol = finiteNumber(options.deployAmountSol);
  const binsBelowDefault = finiteNumber(options.binsBelow);
  const binsBelowMin = finiteNumber(options.binsBelowMin);
  const binsBelowMax = finiteNumber(options.binsBelowMax);
  const targetStrategy = options.strategy || "bid_ask";
  const targetBinsAbove = finiteNumber(options.binsAbove) ?? 0;
  const normalized = { ...args };
  const repairs = [];

  const amountX = finiteNumber(normalized.amount_x);
  if (amountX != null && amountX > 0) {
    return {
      ok: false,
      retryableToolArgs: true,
      forced: true,
      reason: "Forced SOL-only bid_ask deploy rejected: amount_x must be 0, null, or omitted.",
      details: { amount_x: amountX },
    };
  }
  if (normalized.amount_x !== 0) {
    withRepair(repairs, "amount_x", normalized.amount_x, 0, "forced SOL-only deploy uses no base token");
    normalized.amount_x = 0;
  }

  if (normalized.strategy !== targetStrategy) {
    withRepair(repairs, "strategy", normalized.strategy, targetStrategy, "forced single-sided deploy strategy from active config");
    normalized.strategy = targetStrategy;
  }

  const binsAbove = finiteNumber(normalized.bins_above);
  if (binsAbove !== targetBinsAbove) {
    withRepair(repairs, "bins_above", normalized.bins_above, targetBinsAbove, "forced single-sided deploy pins upside bins from active config");
    normalized.bins_above = targetBinsAbove;
  }

  const upsidePct = finiteNumber(normalized.upside_pct);
  if (upsidePct != null && upsidePct > 0) {
    return {
      ok: false,
      retryableToolArgs: true,
      forced: true,
      reason: "Forced SOL-only bid_ask deploy rejected: positive upside_pct is invalid; omit upside_pct and use bins_above=0.",
      details: { upside_pct: upsidePct },
    };
  }

  const amountY = finiteNumber(normalized.amount_y);
  const amountSol = finiteNumber(normalized.amount_sol);
  const suppliedAmount = amountY ?? amountSol;
  if (deployAmountSol != null && deployAmountSol > 0) {
    if (suppliedAmount == null || suppliedAmount < deployAmountSol) {
      withRepair(
        repairs,
        "amount_y",
        suppliedAmount,
        deployAmountSol,
        "forced single-sided deploy uses the full configured deploy amount",
      );
      normalized.amount_y = deployAmountSol;
      delete normalized.amount_sol;
    } else if (amountY == null && amountSol != null) {
      withRepair(repairs, "amount_y", normalized.amount_sol, amountSol, "normalize legacy amount_sol alias");
      normalized.amount_y = amountSol;
      delete normalized.amount_sol;
    }
  }

  const suppliedBinsBelow = finiteNumber(normalized.bins_below);
  let nextBinsBelow = suppliedBinsBelow;
  if (nextBinsBelow == null || nextBinsBelow <= 0) {
    nextBinsBelow = binsBelowDefault;
  }
  if (binsBelowMin != null && nextBinsBelow != null && nextBinsBelow < binsBelowMin) {
    nextBinsBelow = binsBelowMin;
  }
  if (binsBelowMax != null && nextBinsBelow != null && nextBinsBelow > binsBelowMax) {
    nextBinsBelow = binsBelowMax;
  }
  if (nextBinsBelow != null && nextBinsBelow > 0 && suppliedBinsBelow !== nextBinsBelow) {
    withRepair(repairs, "bins_below", normalized.bins_below, nextBinsBelow, "forced single-sided deploy uses active strategy/config downside bins");
    normalized.bins_below = nextBinsBelow;
  }

  return {
    ok: true,
    args: normalized,
    repairs,
    forced: true,
    repaired: repairs.length > 0,
  };
}
