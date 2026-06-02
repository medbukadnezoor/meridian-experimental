/**
 * Shadow Logger Integration Guide
 *
 * This file documents how to wire the shadow loggers into the main bot loop.
 * The shadow loggers are read-only — they append JSONL rows but never close
 * positions, modify state, or affect deploy decisions.
 *
 * Files:
 *   exit-policy-shadow-logger.js   — tracks trailing/TP/giveback counterfactuals
 *   candidate-indicator-shadow-logger.js — tracks entry indicator state for all candidates
 *
 * Output logs:
 *   logs/exit-policy-shadow-YYYY-MM-DD.jsonl
 *   logs/candidate-indicator-shadow-YYYY-MM-DD.jsonl
 */

// ============================================================
// 1. EXIT POLICY SHADOW — wire into PnL snapshot loop
// ============================================================
//
// In the main loop where pnl_snapshot events are emitted (likely index.js
// or the position monitor), add after each snapshot is logged:
//
//   import { evaluateExitPolicyShadow, onPositionClosed } from "./exit-policy-shadow-logger.js";
//
//   // After logging pnl_snapshot:
//   evaluateExitPolicyShadow(snapshot, { bot: "meridian", wallet: config.wallet });
//
//   // After any position close (in close_position handler):
//   onPositionClosed(positionAddress, pnlPct, reason, {
//     bot: "meridian", wallet: config.wallet, pool, poolName
//   });
//
// This adds ~0.1ms per snapshot (in-memory state + conditional file append).
// File I/O only happens when a shadow policy triggers or every 30 snapshots.

// ============================================================
// 2. CANDIDATE INDICATOR SHADOW — wire into screening/indicator gate
// ============================================================
//
// In the indicator gate (where rsi_reversal is checked), add for BOTH
// accept and reject paths:
//
//   import { logCandidateIndicators } from "./candidate-indicator-shadow-logger.js";
//
//   // After RSI/indicator evaluation completes:
//   logCandidateIndicators({
//     pool: candidate.pool,
//     poolName: candidate.poolName,
//     baseMint: candidate.baseMint,
//     source: candidate.source,
//     accepted: rsiPassed,
//     rejectReason: rsiPassed ? null : `rsi_reversal not confirmed (RSI=${rsiValue})`,
//     indicators: {
//       rsi5m: rsiValue,
//       rsi15m: rsi15mValue,
//       rsiReversal: rsiPassed,
//       rsiThreshold: config.rsiOversoldThreshold ?? 35,
//       supertrend5m: supertrendValue,
//       supertrendDirection5m: supertrendDir,
//       supertrendBreakUp: breakUp,
//       priceChange1h: candidate.priceChange1h,
//       priceChange5m: candidate.priceChange5m,
//       athProximityPct: candidate.athProximityPct,
//       activeBinId: candidate.activeBinId,
//       priceInRange: candidate.priceInRange,
//       ohlcvEntryDrawdown: ohlcvState?.entryDrawdownPct,
//       ohlcvHighDrawdown: ohlcvState?.highDrawdownPct,
//     },
//     metrics: {
//       feeActiveTvlRatio: candidate.feeActiveTvlRatio,
//       volumeActiveTvlMultiple: candidate.volumeActiveTvlMultiple,
//       activeTvl: candidate.activeTvl,
//       volume: candidate.volume,
//       mcap: candidate.mcap,
//       binStep: candidate.binStep,
//       tokenAgeHours: candidate.tokenAgeHours,
//       organicScore: candidate.organicScore,
//       volatility: candidate.volatility,
//     },
//   }, { bot: "meridian", wallet: config.wallet });

// ============================================================
// 3. ANALYSIS SCRIPTS (run locally after syncing logs)
// ============================================================
//
// After syncing logs from VPS:
//   rsync ohox:~/meridian/logs/exit-policy-shadow-*.jsonl ./data/analysis/
//   rsync ohox:~/meridian/logs/candidate-indicator-shadow-*.jsonl ./data/analysis/
//
// Then run analysis to answer:
//   - Which trailing policy fires earliest on positions that later crash?
//   - Do rejected candidates actually perform worse?
//   - Which RSI bucket correlates with best MFE?
//   - Is there an optimal trailing trigger that avoids false stops?
