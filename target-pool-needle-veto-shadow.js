function finiteNumber(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export const DEFAULT_TARGET_POOL_NEEDLE_VETO_CONFIG = Object.freeze({
  targetPoolNeedleVetoShadowEnabled: true,
  targetPoolNeedleVetoLiveEnabled: false,
  targetPoolNeedleVetoLookbackMinutes: 60,
  targetPoolNeedleVetoAggregateMin: 1,
  targetPoolNeedleVetoShortlistLimit: 3,
  targetPoolNeedleVetoMinWindowRows: 3,
  targetPoolNeedleVetoHighDrawdownPct: -45,
  targetPoolNeedleVetoMinHighRunupPct: 50,
  targetPoolNeedleVetoLiveReasonCodes: ["target_pool_high_needle_retrace"],
});

export function evaluateTargetPoolNeedleVetoShadow(candidate = {}, {
  ohlcv = null,
  config = {},
} = {}) {
  const cfg = { ...DEFAULT_TARGET_POOL_NEEDLE_VETO_CONFIG, ...config };
  const liveReasonCodes = Array.isArray(cfg.targetPoolNeedleVetoLiveReasonCodes)
    ? cfg.targetPoolNeedleVetoLiveReasonCodes
    : DEFAULT_TARGET_POOL_NEEDLE_VETO_CONFIG.targetPoolNeedleVetoLiveReasonCodes;

  const highDrawdownPct = finiteNumber(ohlcv?.highDrawdownPct ?? ohlcv?.high_drawdown_pct);
  const highRunupPct = finiteNumber(ohlcv?.highRunupPct ?? ohlcv?.high_runup_pct);
  const peakRetracePct = finiteNumber(ohlcv?.peakRetracePct ?? ohlcv?.peak_retrace_pct);
  const highLowRangePct = finiteNumber(ohlcv?.highLowRangePct ?? ohlcv?.high_low_range_pct);
  const windowRowCount = finiteNumber(ohlcv?.windowRowCount ?? ohlcv?.window_row_count);
  const minRows = finiteNumber(cfg.targetPoolNeedleVetoMinWindowRows) ?? 3;
  const highDrawdownThreshold = finiteNumber(cfg.targetPoolNeedleVetoHighDrawdownPct) ?? -45;
  const highRunupThreshold = finiteNumber(cfg.targetPoolNeedleVetoMinHighRunupPct) ?? 50;

  if (!ohlcv || (highDrawdownPct == null && highRunupPct == null && peakRetracePct == null && highLowRangePct == null)) {
    return baseResult("missing_evidence", ["missing_target_pool_ohlcv_evidence"]);
  }
  if (windowRowCount != null && windowRowCount < minRows) {
    return baseResult("missing_evidence", ["insufficient_target_pool_ohlcv_rows"]);
  }

  const currentNeedleRetrace = highDrawdownPct != null &&
    highRunupPct != null &&
    highDrawdownPct <= highDrawdownThreshold &&
    highRunupPct >= highRunupThreshold;
  const wickNeedleRetrace = peakRetracePct != null &&
    highLowRangePct != null &&
    peakRetracePct <= highDrawdownThreshold &&
    highLowRangePct >= highRunupThreshold;
  const needleRetrace = currentNeedleRetrace || wickNeedleRetrace;
  if (!needleRetrace) {
    return baseResult("pass", ["target_pool_needle_conditions_not_met"]);
  }

  const reasonCodes = ["target_pool_high_needle_retrace"];
  const decision = cfg.targetPoolNeedleVetoLiveEnabled === true &&
    reasonCodes.some((reason) => liveReasonCodes.includes(reason))
    ? "blocked"
    : "would_block";
  return baseResult(decision, reasonCodes);

  function baseResult(decision, reasonCodes) {
    return {
      event: "target_pool_needle_veto_shadow",
      pool: candidate.pool ?? candidate.pool_address ?? null,
      pair: candidate.name ?? candidate.pair ?? candidate.poolName ?? null,
      baseMint: candidate.base?.mint ?? candidate.base_mint ?? null,
      ohlcv: ohlcv ? {
        source: ohlcv.source ?? null,
        aggregateMin: ohlcv.aggregateMin ?? null,
        lookbackMinutes: ohlcv.lookbackMinutes ?? null,
        rowCount: ohlcv.rowCount ?? null,
        windowRowCount: ohlcv.windowRowCount ?? null,
        entryPrice: finiteNumber(ohlcv.entryPrice),
        currentPrice: finiteNumber(ohlcv.currentPrice),
        highPrice: finiteNumber(ohlcv.highPrice),
        lowPrice: finiteNumber(ohlcv.lowPrice),
        highDrawdownPct,
        peakRetracePct,
        highRunupPct,
        highLowRangePct,
        entryDrawdownPct: finiteNumber(ohlcv.entryDrawdownPct),
        lowDrawdownPct: finiteNumber(ohlcv.lowDrawdownPct),
        decisiveEvidence: ohlcv.decisiveEvidence ?? null,
        poolSpecificAvailable: ohlcv.poolSpecificAvailable ?? null,
      } : null,
      decision,
      reasonCodes,
      shadowOnly: decision !== "blocked",
      liveBlockingEnabled: cfg.targetPoolNeedleVetoLiveEnabled === true,
      liveReasonCodes,
      bluntHighDrawdownOnlyForbidden: true,
    };
  }
}
