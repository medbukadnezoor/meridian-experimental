function finiteNumber(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function evaluateAthPullbackBand(priceVsAthPct, {
  athFilterPct = null,
  athMinPriceVsAthPct = null,
} = {}) {
  const pricePct = finiteNumber(priceVsAthPct);
  const maxOffset = finiteNumber(athFilterPct);
  const minPriceVsAth = finiteNumber(athMinPriceVsAthPct);
  const maxPriceVsAth = maxOffset != null ? 100 + maxOffset : null;

  if (pricePct == null) {
    return {
      accepted: true,
      reason: "missing_price_vs_ath",
      priceVsAthPct: null,
      minPriceVsAthPct: minPriceVsAth,
      maxPriceVsAthPct: maxPriceVsAth,
      missing: true,
    };
  }

  if (maxPriceVsAth != null && pricePct > maxPriceVsAth) {
    return {
      accepted: false,
      reason: "too_close_to_ath",
      message: `${pricePct.toFixed(1)}% of ATH > ${maxPriceVsAth}% limit`,
      priceVsAthPct: pricePct,
      minPriceVsAthPct: minPriceVsAth,
      maxPriceVsAthPct: maxPriceVsAth,
    };
  }

  if (minPriceVsAth != null && pricePct < minPriceVsAth) {
    return {
      accepted: false,
      reason: "too_far_below_ath",
      message: `${pricePct.toFixed(1)}% of ATH < ${minPriceVsAth}% minimum`,
      priceVsAthPct: pricePct,
      minPriceVsAthPct: minPriceVsAth,
      maxPriceVsAthPct: maxPriceVsAth,
    };
  }

  return {
    accepted: true,
    reason: "inside_ath_pullback_band",
    priceVsAthPct: pricePct,
    minPriceVsAthPct: minPriceVsAth,
    maxPriceVsAthPct: maxPriceVsAth,
  };
}
