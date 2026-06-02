/**
 * candidate-indicator-shadow-logger.js — Shadow logger for entry indicator quality.
 *
 * Logs full indicator state for ALL candidates (accepted AND rejected) so we can
 * prove whether RSI, supertrend, fee/TVL, volume/TVL, and other entry filters
 * are actually predictive.
 *
 * Appends to logs/candidate-indicator-shadow-YYYY-MM-DD.jsonl
 *
 * Integration: called from the screening/indicator gate after each candidate evaluation.
 * Does NOT affect deploy decisions.
 *
 * Key questions this enables:
 * - Is 5m RSI oversold actually predictive of better MFE/lower MAE?
 * - Do rejected candidates perform worse than accepted ones?
 * - Which indicator combinations predict material wins vs losses?
 * - Should RSI threshold be tightened or loosened?
 */

import fs from "fs";
import path from "path";

const LOG_DIR = "./logs";
const SHADOW_PREFIX = "candidate-indicator-shadow";

function getLogPath(ts = new Date().toISOString()) {
  const dateStr = String(ts).slice(0, 10);
  return path.join(LOG_DIR, `${SHADOW_PREFIX}-${dateStr}.jsonl`);
}

function appendRow(row) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = getLogPath(row.ts);
  fs.appendFileSync(file, JSON.stringify(row) + "\n");
}

/**
 * Log a candidate evaluation with full indicator state.
 * Call this for EVERY candidate that reaches the indicator gate,
 * regardless of accept/reject outcome.
 *
 * @param {object} params
 * @param {string} params.pool - Pool address
 * @param {string} params.poolName - Pool name
 * @param {string} params.baseMint - Base mint address
 * @param {string} params.source - Screening source (meteora/gmgn/both)
 * @param {boolean} params.accepted - Whether candidate was accepted
 * @param {string} params.rejectReason - Reason for rejection (null if accepted)
 * @param {object} params.indicators - Full indicator snapshot
 * @param {object} params.metrics - Pool metrics at evaluation time
 * @param {object} opts - { bot, wallet }
 */
export function logCandidateIndicators(params, opts = {}) {
  const {
    pool,
    poolName,
    baseMint,
    source,
    accepted,
    rejectReason,
    indicators,
    metrics,
  } = params;

  if (!pool) return;

  const ts = new Date().toISOString();

  appendRow({
    ts,
    event: "candidate_indicator_shadow",
    shadowOnly: true,
    bot: opts.bot ?? "meridian",
    wallet: opts.wallet ?? null,
    pool,
    poolName: poolName ?? null,
    baseMint: baseMint ?? null,
    source: source ?? null,
    accepted: !!accepted,
    rejectReason: rejectReason ?? null,

    // RSI state
    rsi5m: indicators?.rsi5m ?? null,
    rsi15m: indicators?.rsi15m ?? null,
    rsiReversal: indicators?.rsiReversal ?? null,
    rsiThreshold: indicators?.rsiThreshold ?? null,

    // Supertrend state
    supertrend5m: indicators?.supertrend5m ?? null,
    supertrend15m: indicators?.supertrend15m ?? null,
    supertrendDirection5m: indicators?.supertrendDirection5m ?? null,
    supertrendDirection15m: indicators?.supertrendDirection15m ?? null,
    supertrendBreakUp: indicators?.supertrendBreakUp ?? null,

    // Price action
    priceChange1h: indicators?.priceChange1h ?? null,
    priceChange5m: indicators?.priceChange5m ?? null,
    priceChange15m: indicators?.priceChange15m ?? null,
    athProximityPct: indicators?.athProximityPct ?? null,

    // Pool metrics
    feeActiveTvlRatio: metrics?.feeActiveTvlRatio ?? null,
    volumeActiveTvlMultiple: metrics?.volumeActiveTvlMultiple ?? null,
    activeTvl: metrics?.activeTvl ?? null,
    volume24h: metrics?.volume ?? null,
    mcap: metrics?.mcap ?? null,
    binStep: metrics?.binStep ?? null,
    tokenAgeHours: metrics?.tokenAgeHours ?? null,
    organicScore: metrics?.organicScore ?? null,
    volatility: metrics?.volatility ?? null,

    // Range/liquidity state
    activeBinId: indicators?.activeBinId ?? null,
    priceInRange: indicators?.priceInRange ?? null,
    binsFromActive: indicators?.binsFromActive ?? null,

    // OHLCV shadow state at entry
    ohlcvEntryDrawdown: indicators?.ohlcvEntryDrawdown ?? null,
    ohlcvHighDrawdown: indicators?.ohlcvHighDrawdown ?? null,
  });
}
