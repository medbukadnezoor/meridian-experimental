/**
 * exit-policy-shadow-logger.js — Shadow logger for trailing TP / exit policy counterfactuals.
 *
 * Appends shadow rows to logs/exit-policy-shadow-YYYY-MM-DD.jsonl every time
 * a PnL snapshot is processed. Tracks what various trailing/TP/giveback policies
 * WOULD have done without affecting live behavior.
 *
 * Integration: called from the PnL snapshot loop after each position check.
 * Does NOT close positions or modify state.
 *
 * Shadow policies tracked:
 * - Trailing TP at various trigger/drop levels (3/1.5, 3.5/1.5, 4/2)
 * - Profit giveback at various trigger/floor levels (3/1.5, 4/2)
 * - TP at 3%, 4%, 4.5%
 * - Time-in-profit bands
 */

import fs from "fs";
import path from "path";

const LOG_DIR = "./logs";
const SHADOW_PREFIX = "exit-policy-shadow";

// Shadow policies to evaluate on every snapshot
const TRAILING_POLICIES = [
  { id: "trail_3_1.5", trigger: 3, drop: 1.5 },
  { id: "trail_3.5_1.5", trigger: 3.5, drop: 1.5 },
  { id: "trail_4_2", trigger: 4, drop: 2 },
  { id: "trail_4.5_2", trigger: 4.5, drop: 2 },
];

const TP_POLICIES = [
  { id: "tp_3", level: 3 },
  { id: "tp_3.5", level: 3.5 },
  { id: "tp_4", level: 4 },
  { id: "tp_4.5", level: 4.5 },
];

const GIVEBACK_POLICIES = [
  { id: "gb_3_1.5", trigger: 3, floor: 1.5 },
  { id: "gb_4_2", trigger: 4, floor: 2 },
  { id: "gb_5_1", trigger: 5, floor: 1 },
];

// In-memory state per position (tracks which shadow policies have "fired")
const _positionState = new Map();
const STATE_TTL_MS = 24 * 60 * 60 * 1000; // 24h cleanup

function getLogPath(ts = new Date().toISOString()) {
  const dateStr = String(ts).slice(0, 10);
  return path.join(LOG_DIR, `${SHADOW_PREFIX}-${dateStr}.jsonl`);
}

function appendRow(row) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = getLogPath(row.ts);
  fs.appendFileSync(file, JSON.stringify(row) + "\n");
}

function cleanupStale() {
  const now = Date.now();
  for (const [pos, state] of _positionState) {
    if (now - state.lastSeen > STATE_TTL_MS) {
      _positionState.delete(pos);
    }
  }
}

/**
 * Evaluate shadow exit policies for a position snapshot.
 * Call this from the PnL snapshot loop.
 *
 * @param {object} snapshot - PnL snapshot object with:
 *   { position, pool, poolName, baseMint, pnlPct, peakPnlPct, ageMin, inRange, trailingActive }
 * @param {object} opts - { wallet, bot }
 */
export function evaluateExitPolicyShadow(snapshot, opts = {}) {
  if (!snapshot?.position || snapshot.pnlPct == null) return;

  const pos = snapshot.position;
  const pnl = snapshot.pnlPct;
  const peak = snapshot.peakPnlPct ?? pnl;
  const ts = snapshot.ts ?? new Date().toISOString();

  // Initialize or retrieve position state
  if (!_positionState.has(pos)) {
    _positionState.set(pos, {
      lastSeen: Date.now(),
      runningPeak: peak,
      fired: new Set(),
      firstSeenTs: ts,
      timeAbove2Pct: 0,
      timeAbove3Pct: 0,
      snapCount: 0,
    });
  }

  const state = _positionState.get(pos);
  state.lastSeen = Date.now();
  state.runningPeak = Math.max(state.runningPeak, peak, pnl);
  state.snapCount += 1;
  if (pnl >= 2) state.timeAbove2Pct += 1;
  if (pnl >= 3) state.timeAbove3Pct += 1;

  const triggers = [];

  // Evaluate trailing policies
  for (const policy of TRAILING_POLICIES) {
    if (state.fired.has(policy.id)) continue;
    if (state.runningPeak >= policy.trigger && (state.runningPeak - pnl) >= policy.drop) {
      state.fired.add(policy.id);
      triggers.push({
        policy: policy.id,
        type: "trailing",
        triggerLevel: policy.trigger,
        dropPp: policy.drop,
        exitPnl: pnl,
        peakAtFire: state.runningPeak,
      });
    }
  }

  // Evaluate TP policies
  for (const policy of TP_POLICIES) {
    if (state.fired.has(policy.id)) continue;
    if (pnl >= policy.level) {
      state.fired.add(policy.id);
      triggers.push({
        policy: policy.id,
        type: "tp",
        level: policy.level,
        exitPnl: pnl,
        peakAtFire: state.runningPeak,
      });
    }
  }

  // Evaluate giveback policies
  for (const policy of GIVEBACK_POLICIES) {
    if (state.fired.has(policy.id)) continue;
    if (state.runningPeak >= policy.trigger && pnl <= policy.floor) {
      state.fired.add(policy.id);
      triggers.push({
        policy: policy.id,
        type: "giveback",
        triggerLevel: policy.trigger,
        floorLevel: policy.floor,
        exitPnl: pnl,
        peakAtFire: state.runningPeak,
      });
    }
  }

  // Only log when something fires (reduces log volume)
  if (triggers.length > 0) {
    appendRow({
      ts,
      event: "exit_policy_shadow_trigger",
      shadowOnly: true,
      bot: opts.bot ?? "meridian",
      wallet: opts.wallet ?? null,
      position: pos,
      pool: snapshot.pool,
      poolName: snapshot.poolName,
      baseMint: snapshot.baseMint,
      currentPnl: pnl,
      peakPnl: state.runningPeak,
      ageMin: snapshot.ageMin,
      inRange: snapshot.inRange,
      snapCount: state.snapCount,
      timeAbove2Pct: state.timeAbove2Pct,
      timeAbove3Pct: state.timeAbove3Pct,
      triggers,
    });
  }

  // Periodic state snapshot every 30 snaps (for analysis of time-in-profit)
  if (state.snapCount % 30 === 0) {
    appendRow({
      ts,
      event: "exit_policy_shadow_state",
      shadowOnly: true,
      bot: opts.bot ?? "meridian",
      position: pos,
      pool: snapshot.pool,
      poolName: snapshot.poolName,
      currentPnl: pnl,
      peakPnl: state.runningPeak,
      ageMin: snapshot.ageMin,
      inRange: snapshot.inRange,
      snapCount: state.snapCount,
      timeAbove2Pct: state.timeAbove2Pct,
      timeAbove3Pct: state.timeAbove3Pct,
      firedPolicies: [...state.fired],
    });
  }

  // Cleanup stale entries periodically
  if (Math.random() < 0.01) cleanupStale();
}

/**
 * Call when a position is actually closed (by any mechanism).
 * Logs final shadow state showing which policies would have fired earlier.
 */
export function onPositionClosed(positionAddress, actualExitPnl, actualReason, opts = {}) {
  const state = _positionState.get(positionAddress);
  if (!state) return;

  appendRow({
    ts: new Date().toISOString(),
    event: "exit_policy_shadow_close",
    shadowOnly: true,
    bot: opts.bot ?? "meridian",
    wallet: opts.wallet ?? null,
    position: positionAddress,
    pool: opts.pool ?? null,
    poolName: opts.poolName ?? null,
    actualExitPnl,
    actualReason,
    peakPnl: state.runningPeak,
    snapCount: state.snapCount,
    timeAbove2Pct: state.timeAbove2Pct,
    timeAbove3Pct: state.timeAbove3Pct,
    firedPolicies: [...state.fired],
    // Which shadow policies would have closed earlier and at what PnL
    wouldHaveFiredBefore: [...state.fired].length > 0,
  });

  _positionState.delete(positionAddress);
}
