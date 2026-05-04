export const OOR_RANGE_SIDES = Object.freeze({
  ABOVE: "above_range",
  BELOW: "below_range",
  IN: "in_range",
  UNKNOWN: "unknown",
});

function finiteNumberOrNull(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function deriveRangeSide({ active_bin, lower_bin, upper_bin } = {}) {
  const active = finiteNumberOrNull(active_bin);
  const lower = finiteNumberOrNull(lower_bin);
  const upper = finiteNumberOrNull(upper_bin);
  if (active == null || lower == null || upper == null) return OOR_RANGE_SIDES.UNKNOWN;
  if (active < lower) return OOR_RANGE_SIDES.BELOW;
  if (active > upper) return OOR_RANGE_SIDES.ABOVE;
  return OOR_RANGE_SIDES.IN;
}

export function isOorRepositionEnabled(runtimeConfig = {}) {
  return runtimeConfig?.management?.oorRepositionEnabled === true;
}

export function isOorRepositionEligibleRangeSide(rangeSide) {
  return rangeSide === OOR_RANGE_SIDES.ABOVE;
}

export function normalizeBaseMint(candidate = {}) {
  return candidate.base?.mint ?? candidate.base_mint ?? candidate.baseMint ?? null;
}

export function findFreshSamePoolCandidate(candidates = [], { pool, baseMint, base_mint } = {}) {
  const expectedBaseMint = baseMint ?? base_mint ?? null;
  const list = Array.isArray(candidates) ? candidates : [];
  return list.find((candidate) => {
    const samePool = candidate?.pool === pool;
    const candidateBaseMint = normalizeBaseMint(candidate);
    const sameBaseMint = expectedBaseMint != null && candidateBaseMint === expectedBaseMint;
    return samePool && sameBaseMint;
  }) || null;
}

export function buildOorRepositionDeployArgs(candidate = {}, runtimeConfig = {}) {
  const activeStrategy = runtimeConfig?.strategy?.strategy ?? "bid_ask";
  return {
    pool_address: candidate.pool,
    pool_name: candidate.name,
    base_mint: normalizeBaseMint(candidate),
    amount_y: runtimeConfig?.management?.deployAmountSol,
    amount_x: 0,
    strategy: activeStrategy,
    bins_below: runtimeConfig?.strategy?.binsBelow,
    bins_above: 0,
    bin_step: candidate.bin_step ?? null,
    base_fee: candidate.fee_pct ?? null,
    volatility: candidate.volatility ?? null,
    fee_tvl_ratio: candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio ?? null,
    organic_score: candidate.organic_score ?? null,
    initial_value_usd: candidate.active_tvl ?? null,
    reposition_source: "oor_above_confirmed_close",
  };
}

export function buildOorRepositionDecision({
  position = {},
  closeReason = null,
  closeResult = null,
  rangeSide = null,
  freshScreeningAt = null,
  freshCandidates = [],
  freshCandidate = null,
  guardResult = null,
  decision = "skip",
  reason = null,
} = {}) {
  const samePoolCandidate = freshCandidate?.pool === position.pool;
  const freshCandidateBaseMint = freshCandidate ? normalizeBaseMint(freshCandidate) : null;
  const sameBaseMintCandidate = freshCandidateBaseMint != null && freshCandidateBaseMint === position.base_mint;
  const guardFailures = [
    guardResult?.reason,
    guardResult?.error,
    ...(Array.isArray(guardResult?.details?.reasons) ? guardResult.details.reasons : []),
  ].filter(Boolean);

  return {
    event: "oor_reposition_decision",
    position: position.position ?? null,
    pool: position.pool ?? null,
    pair: position.pair ?? null,
    baseMint: position.base_mint ?? null,
    closeReason,
    oorDurationMinutes: position.minutes_out_of_range ?? null,
    rangeSide: rangeSide ?? deriveRangeSide(position),
    oorSide: rangeSide ?? deriveRangeSide(position),
    activeBinAtClose: position.active_bin ?? null,
    lowerBin: position.lower_bin ?? null,
    upperBin: position.upper_bin ?? null,
    pnlPctAtClose: position.pnl_pct ?? closeResult?.pnl_pct ?? null,
    freshScreeningAt,
    freshCandidateFound: Boolean(freshCandidate),
    freshCandidatePool: freshCandidate?.pool ?? null,
    freshCandidateBaseMint,
    samePoolCandidate,
    sameBaseMintCandidate,
    guardPassed: guardResult ? guardResult.success !== false && !guardResult.error && !guardResult.blocked : null,
    guardFailures,
    decision,
    reason,
    freshCandidateCount: Array.isArray(freshCandidates) ? freshCandidates.length : 0,
  };
}
