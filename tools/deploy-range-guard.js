export const ABSOLUTE_MIN_SINGLE_SIDED_SOL_BINS = 5;

function optionalNumber(value, fieldName) {
  if (value == null) return { supplied: false, value: null, positive: false };
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`${fieldName} must be a valid number.`);
  }
  return {
    supplied: true,
    value: numeric,
    positive: numeric > 0,
  };
}

function binCount(value, fallback, fieldName) {
  const numeric = value == null ? Number(fallback) : Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`${fieldName} must be a valid number.`);
  }
  return Math.max(0, Math.floor(numeric));
}

export function normalizeDeployRangeInputs({
  activeBinId,
  activePrice,
  actualBinStep,
  getBinIdFromPrice,
  fallbackBinsBelow,
  bins_below,
  bins_above,
  downside_pct,
  upside_pct,
}) {
  let activeBinsBelow = binCount(bins_below, fallbackBinsBelow, "bins_below");
  let activeBinsAbove = binCount(bins_above, 0, "bins_above");
  const downsidePct = optionalNumber(downside_pct, "downside_pct");
  const upsidePct = optionalNumber(upside_pct, "upside_pct");

  if (downsidePct.positive) {
    if (downsidePct.value >= 100) {
      throw new Error("downside_pct must be less than 100.");
    }
    const lowerTargetPrice = activePrice * (1 - downsidePct.value / 100);
    const lowerBinId = getBinIdFromPrice(lowerTargetPrice, actualBinStep, true);
    activeBinsBelow = Math.max(0, activeBinId - lowerBinId);
  }

  if (upsidePct.positive) {
    const upperTargetPrice = activePrice * (1 + upsidePct.value / 100);
    const upperBinId = getBinIdFromPrice(upperTargetPrice, actualBinStep, false);
    activeBinsAbove = Math.max(0, upperBinId - activeBinId);
  }

  return {
    activeBinsBelow,
    activeBinsAbove,
    percent_inputs: {
      downside_pct: downsidePct.supplied ? downsidePct.value : null,
      upside_pct: upsidePct.supplied ? upsidePct.value : null,
      downside_pct_used: downsidePct.positive,
      upside_pct_used: upsidePct.positive,
    },
  };
}

export function normalizeSingleSidedSolGuardConfig(config = {}) {
  const rawMinBins = Number(config.minSingleSidedSolBins ?? ABSOLUTE_MIN_SINGLE_SIDED_SOL_BINS);
  const minBins = Number.isFinite(rawMinBins)
    ? Math.max(ABSOLUTE_MIN_SINGLE_SIDED_SOL_BINS, Math.floor(rawMinBins))
    : ABSOLUTE_MIN_SINGLE_SIDED_SOL_BINS;
  const rawMinDownsidePct = config.minSingleSidedSolDownsidePct;
  const minDownsidePct = rawMinDownsidePct == null
    ? null
    : Math.max(0, Number(rawMinDownsidePct));

  return {
    minBins,
    minDownsidePct: Number.isFinite(minDownsidePct) && minDownsidePct > 0 ? minDownsidePct : null,
  };
}

export function validateSingleSidedSolBidAskRange({
  activeStrategy,
  isSingleSidedSol,
  activeBinId,
  minBinId,
  maxBinId,
  activeBinsBelow,
  activeBinsAbove,
  rangeCoverage = {},
  guardConfig = {},
}) {
  if (!(isSingleSidedSol && activeStrategy === "bid_ask")) {
    return { ok: true, reason: null, details: null };
  }

  const { minBins, minDownsidePct } = normalizeSingleSidedSolGuardConfig(guardConfig);
  const widthBins = maxBinId - minBinId;
  const downsidePct = rangeCoverage.downside_pct;
  const reasons = [];

  if (minBinId >= maxBinId || widthBins <= 0) {
    reasons.push("zero-width bin range");
  }
  if (widthBins < ABSOLUTE_MIN_SINGLE_SIDED_SOL_BINS) {
    reasons.push(`range width ${widthBins} bins is below absolute floor ${ABSOLUTE_MIN_SINGLE_SIDED_SOL_BINS}`);
  }
  if (activeBinsBelow < minBins) {
    reasons.push(`bins_below ${activeBinsBelow} is below configured minimum ${minBins}`);
  }
  if (activeBinsAbove !== 0) {
    reasons.push(`bins_above ${activeBinsAbove} must be 0 for single-side SOL bid_ask`);
  }
  if (
    minDownsidePct != null &&
    downsidePct != null &&
    Number.isFinite(Number(downsidePct)) &&
    Number(downsidePct) < minDownsidePct
  ) {
    reasons.push(`downside coverage ${Number(downsidePct).toFixed(4)}% is below minimum ${minDownsidePct}%`);
  }

  const details = {
    active_bin: activeBinId,
    min_bin: minBinId,
    max_bin: maxBinId,
    width_bins: widthBins,
    bins_below: activeBinsBelow,
    bins_above: activeBinsAbove,
    min_required_bins: minBins,
    min_downside_pct: minDownsidePct,
    range_coverage: {
      downside_pct: downsidePct ?? null,
      upside_pct: rangeCoverage.upside_pct ?? null,
      width_pct: rangeCoverage.width_pct ?? null,
    },
  };

  if (reasons.length === 0) {
    return { ok: true, reason: null, details };
  }

  return {
    ok: false,
    reason: `Narrow single-side SOL bid_ask deploy rejected: ${reasons.join("; ")}`,
    details,
  };
}
