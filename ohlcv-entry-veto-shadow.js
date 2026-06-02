function finiteNumber(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export const DEFAULT_OHLCV_ENTRY_VETO_CONFIG = Object.freeze({
  ohlcvEntryVetoShadowEnabled: true,
  ohlcvEntryVetoLiveEnabled: false,
  ohlcvEntryVetoHighDrawdownPct: -45,
  ohlcvEntryVetoEntryDrawdownPct: -20,
  ohlcvEntryVetoExtremePriceChangePct: 500,
  ohlcvEntryVetoRequireCompound: true,
  ohlcvEntryVetoLiveReasonCodes: ["high_drawdown_with_extreme_positive_candidate_price_change"],
});

export function evaluateOhlcvEntryVetoShadow(candidate = {}, {
  ohlcv = null,
  samePoolPriorOutcome = null,
  config = {},
} = {}) {
  const cfg = { ...DEFAULT_OHLCV_ENTRY_VETO_CONFIG, ...config };
  const highDrawdownPct = finiteNumber(ohlcv?.highDrawdownPct ?? ohlcv?.high_drawdown_pct);
  const entryDrawdownPct = finiteNumber(ohlcv?.entryDrawdownPct ?? ohlcv?.entry_drawdown_pct);
  const priceChangePct = finiteNumber(candidate.priceChangePct ?? candidate.price_change_pct ?? candidate.change_1h);
  const volumeActiveTvlMultiple = finiteNumber(candidate.volumeActiveTvlMultiple ?? candidate.volume_active_tvl_multiple);
  const feeActiveTvlRatio = finiteNumber(candidate.feeActiveTvlRatio ?? candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio);
  const reasonCodes = [];
  const liveReasonCodes = Array.isArray(cfg.ohlcvEntryVetoLiveReasonCodes)
    ? cfg.ohlcvEntryVetoLiveReasonCodes
    : DEFAULT_OHLCV_ENTRY_VETO_CONFIG.ohlcvEntryVetoLiveReasonCodes;

  if (highDrawdownPct == null && entryDrawdownPct == null) {
    return baseResult("missing_evidence", ["missing_ohlcv_evidence"]);
  }

  const highHit = highDrawdownPct != null && highDrawdownPct <= cfg.ohlcvEntryVetoHighDrawdownPct;
  const entryHit = entryDrawdownPct != null && entryDrawdownPct <= cfg.ohlcvEntryVetoEntryDrawdownPct;
  const extremePriceChangePct = finiteNumber(cfg.ohlcvEntryVetoExtremePriceChangePct) ?? 500;
  const extremePositiveMismatch = highHit && priceChangePct != null && priceChangePct >= extremePriceChangePct;
  const recentSamePoolWin = highHit && samePoolPriorOutcome?.minutesSince != null && samePoolPriorOutcome.minutesSince <= 15;
  const weakVolumeActiveTvl = highHit && volumeActiveTvlMultiple != null && volumeActiveTvlMultiple < 2.5;
  if (extremePositiveMismatch) reasonCodes.push("high_drawdown_with_extreme_positive_candidate_price_change");
  if (recentSamePoolWin) reasonCodes.push("high_drawdown_after_recent_same_pool_win");
  if (weakVolumeActiveTvl) reasonCodes.push("high_drawdown_with_weak_volume_active_tvl");
  if (entryHit) reasonCodes.push("entry_drawdown_after_entry_candle_break");

  const compoundHit = cfg.ohlcvEntryVetoRequireCompound
    ? reasonCodes.length > 0
    : highHit || entryHit;

  if (!compoundHit) return baseResult("pass", ["compound_conditions_not_met"]);
  const hasLiveApprovedReason = reasonCodes.some((reason) => liveReasonCodes.includes(reason));
  const decision = cfg.ohlcvEntryVetoLiveEnabled && hasLiveApprovedReason ? "blocked" : "would_block";
  return baseResult(decision, reasonCodes);

  function baseResult(decision, reasons) {
    return {
      event: "ohlcv_entry_veto_shadow",
      pool: candidate.pool ?? candidate.pool_address ?? null,
      pair: candidate.name ?? candidate.pair ?? candidate.poolName ?? null,
      baseMint: candidate.base?.mint ?? candidate.base_mint ?? null,
      ohlcv: {
        source: ohlcv?.source ?? null,
        highDrawdownPct,
        entryDrawdownPct,
      },
      candidateMetrics: {
        priceChangePct,
        volumeActiveTvlMultiple,
        feeActiveTvlRatio,
      },
      samePoolPriorOutcome,
      decision,
      reasonCodes: reasons,
      shadowOnly: decision !== "blocked",
      liveBlockingEnabled: cfg.ohlcvEntryVetoLiveEnabled === true,
      liveReasonCodes,
      bluntHighDrawdownOnlyForbidden: true,
    };
  }
}
