function finiteNumber(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function candidatePool(candidate = {}) {
  return normalizeString(candidate.pool ?? candidate.pool_address ?? candidate.address);
}

function candidateBaseMint(candidate = {}) {
  return normalizeString(candidate.base?.mint ?? candidate.base_mint ?? candidate.token_x?.address ?? candidate.token_x_mint ?? candidate.mint);
}

function isMaterialWin(close = {}, materialPnlPct = 1) {
  if (close.material_win === true) return true;
  if (close.material_outcome === "neutral" || close.neutral_reason) return false;
  const pnlPct = finiteNumber(close.pnl_pct ?? close.pnlPct ?? close.result?.pnl_pct);
  return pnlPct != null && pnlPct >= materialPnlPct;
}

export function findRecentSamePoolPostWin(candidate = {}, closeRecords = [], {
  now = new Date(),
  materialPnlPct = 1,
} = {}) {
  const pool = candidatePool(candidate);
  const baseMint = candidateBaseMint(candidate);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) return null;

  return closeRecords
    .filter((close) => isMaterialWin(close, materialPnlPct))
    .map((close) => {
      const closePool = normalizeString(close.pool ?? close.pool_address);
      const closeBaseMint = normalizeString(close.baseMint ?? close.base_mint);
      const closedAt = normalizeString(close.closed_at ?? close.closeTs ?? close.timestamp ?? close.ts);
      const closedMs = Date.parse(closedAt ?? "");
      const identity = pool && closePool && pool === closePool
        ? "same_pool"
        : baseMint && closeBaseMint && baseMint === closeBaseMint
          ? "same_base_mint"
          : null;
      if (!identity || !Number.isFinite(closedMs) || closedMs > nowMs) return null;
      return {
        identity,
        pool: closePool,
        baseMint: closeBaseMint,
        pair: close.pair ?? close.poolName ?? close.pool_name ?? null,
        position: close.position ?? null,
        closedAt,
        pnlPct: finiteNumber(close.pnl_pct ?? close.pnlPct ?? close.result?.pnl_pct),
        minutesSince: (nowMs - closedMs) / 60_000,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.minutesSince - b.minutesSince)[0] ?? null;
}

export function evaluateSamePoolPostWinDecay(candidate = {}, {
  closeRecords = [],
  now = new Date(),
  config = {},
  freshEvidence = {},
} = {}) {
  const materialPnlPct = finiteNumber(config.samePoolPostWinMaterialPnlPct) ?? 1;
  const cooldownMinutes = finiteNumber(config.samePoolPostWinCooldownMinutes) ?? 0;
  const enabled = config.samePoolPostWinDecayEnabled === true;
  const requireFreshDecayPass = config.samePoolPostWinRequireFreshDecayPass === true;
  const priorWin = findRecentSamePoolPostWin(candidate, closeRecords, { now, materialPnlPct });
  const base = {
    event: "same_pool_post_win_decay_decision",
    pool: candidatePool(candidate),
    baseMint: candidateBaseMint(candidate),
    pair: candidate.name ?? candidate.pair ?? candidate.poolName ?? null,
    priorCloseTimestamp: priorWin?.closedAt ?? null,
    priorClosePnlPct: priorWin?.pnlPct ?? null,
    minutesSincePriorWin: priorWin?.minutesSince ?? null,
    cooldownMinutes,
    freshOhlcvHighDrawdownPct: finiteNumber(freshEvidence.ohlcvHighDrawdownPct),
    freshVolumeActiveTvlMultiple: finiteNumber(freshEvidence.volumeActiveTvlMultiple ?? candidate.volume_active_tvl_multiple),
    freshFeeActiveTvlRatio: finiteNumber(freshEvidence.feeActiveTvlRatio ?? candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio),
    sameTickerSurfEnabled: config.sameTickerSurfEnabled === true,
    liveBlockingEnabled: enabled,
    shadowOnly: !enabled,
  };

  if (!priorWin) {
    return { ...base, decision: "allow", reasonCode: "same_pool_no_recent_material_win", priorWin: null };
  }

  if (cooldownMinutes > 0 && priorWin.minutesSince < cooldownMinutes) {
    return {
      ...base,
      decision: enabled ? "blocked" : "would_block",
      reasonCode: priorWin.identity === "same_pool" ? "same_pool_recent_win_cooldown" : "same_base_mint_recent_win_cooldown",
      priorWin,
    };
  }

  if (requireFreshDecayPass && !freshEvidence.decayPassed) {
    return {
      ...base,
      decision: enabled ? "blocked" : "would_block",
      reasonCode: "same_pool_decay_missing_evidence",
      priorWin,
    };
  }

  return {
    ...base,
    decision: "allow",
    reasonCode: requireFreshDecayPass ? "same_pool_decay_passed" : "same_pool_decay_disabled",
    priorWin,
  };
}
