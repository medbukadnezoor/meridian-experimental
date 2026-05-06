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
  const binsBelow = finiteNumber(options.binsBelow);
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

  if (normalized.strategy !== "bid_ask") {
    withRepair(repairs, "strategy", normalized.strategy, "bid_ask", "forced SOL-only deploy strategy");
    normalized.strategy = "bid_ask";
  }

  const binsAbove = finiteNumber(normalized.bins_above);
  if (binsAbove != null && binsAbove > 0) {
    withRepair(repairs, "bins_above", normalized.bins_above, 0, "forced SOL-only bid_ask has no upside bins");
    normalized.bins_above = 0;
  } else if (normalized.bins_above !== 0) {
    withRepair(repairs, "bins_above", normalized.bins_above, 0, "forced SOL-only bid_ask pins upper bin to active bin");
    normalized.bins_above = 0;
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
        "forced SOL-only deploy uses the full computed deploy amount",
      );
      normalized.amount_y = deployAmountSol;
      delete normalized.amount_sol;
    } else if (amountY == null && amountSol != null) {
      withRepair(repairs, "amount_y", normalized.amount_sol, amountSol, "normalize legacy amount_sol alias");
      normalized.amount_y = amountSol;
      delete normalized.amount_sol;
    }
  }

  if (binsBelow != null && binsBelow > 0 && (normalized.bins_below == null || finiteNumber(normalized.bins_below) === 0)) {
    withRepair(repairs, "bins_below", normalized.bins_below, binsBelow, "forced SOL-only deploy uses configured downside bins");
    normalized.bins_below = binsBelow;
  }

  return {
    ok: true,
    args: normalized,
    repairs,
    forced: true,
    repaired: repairs.length > 0,
  };
}
