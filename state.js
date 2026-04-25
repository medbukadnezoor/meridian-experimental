/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import fs from "fs";
import { log } from "./logger.js";
import { buildStopLossExitDecision, calculatePnlVelocityDrop } from "./stop-loss-policy.js";

const STATE_FILE = "./state.json";

const MAX_RECENT_EVENTS = 20;
const MAX_PNL_HISTORY_POINTS = 30;
const MAX_INSTRUCTION_LENGTH = 280;
const GHOST_POSITION_GRACE_MS = 10 * 60_000;
const GHOST_VALUE_EPSILON = 0.0001;
const GHOST_OBSERVATIONS_TO_SUPPRESS = 3;

function sanitizeStoredText(text, maxLen = MAX_INSTRUCTION_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return { positions: {}, recentEvents: [], ghostCandidates: {}, lastUpdated: null };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    log("state_error", `Failed to read state.json: ${err.message}`);
    return { positions: {}, ghostCandidates: {}, lastUpdated: null };
  }
}

function save(state) {
  try {
    if (!state.positions || typeof state.positions !== "object" || Array.isArray(state.positions)) {
      state.positions = {};
    }
    if (!state.ghostCandidates || typeof state.ghostCandidates !== "object" || Array.isArray(state.ghostCandidates)) {
      state.ghostCandidates = {};
    }
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log("state_error", `Failed to write state.json: ${err.message}`);
  }
}

function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toFiniteNumberOrNull(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function appendPnlHistory(pos, currentPnlPct, velocityWindowMs, nowMs = Date.now()) {
  const current = toFiniteNumberOrNull(currentPnlPct);
  if (!pos || current == null) {
    return { changed: false, velocity: { dropPct: null, elapsedMs: null, baselinePnlPct: null }, initialized: false };
  }

  const existing = Array.isArray(pos.pnl_history) ? pos.pnl_history : [];
  const velocity = calculatePnlVelocityDrop(existing, current, velocityWindowMs, nowMs);
  const historyWindowMs = Math.max(Number(velocityWindowMs ?? 0) * 3, 10 * 60_000);
  const cutoffMs = nowMs - historyWindowMs;
  const pruned = existing
    .filter((point) => {
      const tsMs = new Date(point?.ts).getTime();
      return Number.isFinite(tsMs) && tsMs >= cutoffMs && toFiniteNumberOrNull(point?.pnl_pct) != null;
    })
    .slice(-(MAX_PNL_HISTORY_POINTS - 1));

  pruned.push({
    ts: new Date(nowMs).toISOString(),
    pnl_pct: Number(current.toFixed(4)),
  });

  const initialized = existing.length === 0;
  pos.pnl_history = pruned;
  if (initialized) pos.pnl_history_started_at = new Date(nowMs).toISOString();
  return { changed: true, velocity, initialized };
}

function isGhostLikeLivePosition(position) {
  const value = Math.abs(toFiniteNumber(position?.total_value_usd, 0));
  const fees = Math.abs(toFiniteNumber(position?.unclaimed_fees_usd, 0));
  const baseMint = typeof position?.base_mint === "string"
    ? position.base_mint.trim()
    : position?.base_mint;
  return value <= GHOST_VALUE_EPSILON && fees <= GHOST_VALUE_EPSILON && !baseMint;
}

function getGhostObservationAgeMs(tracked, livePosition) {
  const candidates = [];
  if (tracked?.deployed_at) {
    const deployedAt = new Date(tracked.deployed_at).getTime();
    if (Number.isFinite(deployedAt) && deployedAt > 0) {
      candidates.push(Date.now() - deployedAt);
    }
  }
  const liveAgeMinutes = toFiniteNumber(livePosition?.age_minutes, Number.NaN);
  if (Number.isFinite(liveAgeMinutes) && liveAgeMinutes >= 0) {
    candidates.push(liveAgeMinutes * 60_000);
  }
  return candidates.length > 0 ? Math.min(...candidates) : Number.POSITIVE_INFINITY;
}

// ─── Position Registry ─────────────────────────────────────────

/**
 * Record a newly deployed position.
 */
export function trackPosition({
  position,
  pool,
  pool_name,
  strategy,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  signal_snapshot = null,
}) {
  const state = load();
  state.positions[position] = {
    position,
    pool,
    pool_name,
    strategy,
    bin_range,
    amount_sol,
    amount_x,
    active_bin_at_deploy: active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    initial_fee_tvl_24h: fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    signal_snapshot: signal_snapshot || null,
    deployed_at: new Date().toISOString(),
    out_of_range_since: null,
    last_claim_at: null,
    total_fees_claimed_usd: 0,
    rebalance_count: 0,
    closed: false,
    closed_at: null,
    notes: [],
    peak_pnl_pct: 0,
    pending_peak_pnl_pct: null,
    pending_peak_started_at: null,
    pending_trailing_current_pnl_pct: null,
    pending_trailing_peak_pnl_pct: null,
    pending_trailing_drop_pct: null,
    pnl_history: [],
    pnl_history_started_at: null,
    pending_trailing_started_at: null,
    confirmed_trailing_exit_reason: null,
    confirmed_trailing_exit_until: null,
    trailing_active: false,
  };
  pushEvent(state, { action: "deploy", position, pool_name: pool_name || pool });
  save(state);
  log("state", `Tracked new position: ${position} in pool ${pool}`);
}

/**
 * Mark a position as out of range (sets timestamp on first detection).
 */
export function markOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (!pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    save(state);
    log("state", `Position ${position_address} marked out of range`);
  }
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 */
export function markInRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (pos.out_of_range_since) {
    pos.out_of_range_since = null;
    save(state);
    log("state", `Position ${position_address} back in range`);
  }
}

/**
 * Increment low-yield strike counter. Returns new count.
 * Resets automatically when position is closed via recordClose.
 */
export function incrementLowYieldStrike(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return 0;
  pos.low_yield_strikes = (pos.low_yield_strikes ?? 0) + 1;
  save(state);
  return pos.low_yield_strikes;
}

/**
 * Clear low-yield strike counter (position recovered above threshold).
 */
export function clearLowYieldStrike(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.low_yield_strikes) return;
  delete pos.low_yield_strikes;
  save(state);
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export function minutesOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

export function getOutOfRangeExitPolicy(minutesOOR, mgmtConfig = {}) {
  const softMinutes = Number(mgmtConfig.outOfRangeWaitMinutes ?? 30);
  if (!Number.isFinite(minutesOOR) || !Number.isFinite(softMinutes) || minutesOOR < softMinutes) {
    return null;
  }

  const rawHardMinutes = mgmtConfig.outOfRangeHardCloseMinutes;
  const parsedHardMinutes = rawHardMinutes == null ? null : Number(rawHardMinutes);
  const hardMinutes = Number.isFinite(parsedHardMinutes) && parsedHardMinutes >= softMinutes
    ? parsedHardMinutes
    : null;

  if (hardMinutes != null && minutesOOR >= hardMinutes) {
    return {
      stage: "hard",
      urgent: true,
      indicatorPolicy: "bypass",
      softMinutes,
      hardMinutes,
      reason: `Out of range for ${minutesOOR}m (soft ${softMinutes}m, hard ${hardMinutes}m)`,
    };
  }

  return {
    stage: "soft",
    urgent: false,
    indicatorPolicy: "confirm",
    softMinutes,
    hardMinutes,
    reason: `Out of range for ${minutesOOR}m (limit: ${softMinutes}m)`,
  };
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address, fees_usd) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.last_claim_at = new Date().toISOString();
  pos.total_fees_claimed_usd = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);
  pos.notes.push(`Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${pos.last_claim_at}`);
  save(state);
}

/**
 * Append to the recent events log (shown in every prompt).
 */
function pushEvent(state, event) {
  if (!state.recentEvents) state.recentEvents = [];
  state.recentEvents.push({ ts: new Date().toISOString(), ...event });
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

/**
 * Mark a position as closed.
 */
export function recordClose(position_address, reason) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.closed = true;
  pos.closed_at = new Date().toISOString();
  pos.notes.push(`Closed at ${pos.closed_at}: ${reason}`);
  pushEvent(state, { action: "close", position: position_address, pool_name: pos.pool_name || pos.pool, reason });
  save(state);
  log("state", `Position ${position_address} marked closed: ${reason}`);
}

/**
 * Record a rebalance (close + redeploy).
 */
export function recordRebalance(old_position, new_position) {
  const state = load();
  const old = state.positions[old_position];
  if (old) {
    old.closed = true;
    old.closed_at = new Date().toISOString();
    old.notes.push(`Rebalanced into ${new_position} at ${old.closed_at}`);
  }
  const newPos = state.positions[new_position];
  if (newPos) {
    newPos.rebalance_count = (old?.rebalance_count || 0) + 1;
    newPos.notes.push(`Rebalanced from ${old_position}`);
  }
  save(state);
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address, instruction) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.instruction = sanitizeStoredText(instruction);
  save(state);
  log("state", `Position ${position_address} instruction set: ${pos.instruction}`);
  return true;
}

export function queuePeakConfirmation(position_address, candidatePnlPct) {
  if (candidatePnlPct == null) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const currentPeak = pos.peak_pnl_pct ?? 0;
  if (candidatePnlPct <= currentPeak) return false;

  const changed =
    pos.pending_peak_pnl_pct == null ||
    candidatePnlPct > pos.pending_peak_pnl_pct;

  if (!changed) return false;

  pos.pending_peak_pnl_pct = candidatePnlPct;
  pos.pending_peak_started_at = new Date().toISOString();
  save(state);
  log("state", `Position ${position_address} peak candidate ${candidatePnlPct.toFixed(2)}% queued for 15s confirmation`);
  return true;
}

export function resolvePendingPeak(position_address, currentPnlPct, toleranceRatio = 0.85) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed || pos.pending_peak_pnl_pct == null) return { confirmed: false, pending: false };

  const pendingPeak = pos.pending_peak_pnl_pct;
  pos.pending_peak_pnl_pct = null;
  pos.pending_peak_started_at = null;

  if (currentPnlPct != null && currentPnlPct >= pendingPeak * toleranceRatio) {
    pos.peak_pnl_pct = Math.max(pos.peak_pnl_pct ?? 0, pendingPeak, currentPnlPct);
    save(state);
    log("state", `Position ${position_address} peak PnL confirmed at ${pos.peak_pnl_pct.toFixed(2)}% after recheck`);
    return { confirmed: true, peak: pos.peak_pnl_pct };
  }

  save(state);
  log("state", `Position ${position_address} rejected pending peak ${pendingPeak.toFixed(2)}% after 15s recheck (current: ${currentPnlPct ?? "?"}%)`);
  return { confirmed: false, rejected: true, pendingPeak };
}

export function queueTrailingDropConfirmation(position_address, peakPnlPct, currentPnlPct, trailingDropPct) {
  if (peakPnlPct == null || currentPnlPct == null || trailingDropPct == null) return false;
  const dropFromPeak = peakPnlPct - currentPnlPct;
  if (dropFromPeak < trailingDropPct) return false;

  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const changed =
    pos.pending_trailing_current_pnl_pct == null ||
    currentPnlPct < pos.pending_trailing_current_pnl_pct ||
    dropFromPeak > (pos.pending_trailing_drop_pct ?? -Infinity);

  if (!changed) return false;

  pos.pending_trailing_peak_pnl_pct = peakPnlPct;
  pos.pending_trailing_current_pnl_pct = currentPnlPct;
  pos.pending_trailing_drop_pct = dropFromPeak;
  pos.pending_trailing_started_at = new Date().toISOString();
  save(state);
  log("state", `Position ${position_address} trailing drop candidate queued: peak ${peakPnlPct.toFixed(2)}% -> current ${currentPnlPct.toFixed(2)}%`);
  return true;
}

export function resolvePendingTrailingDrop(position_address, currentPnlPct, trailingDropPct, tolerancePct = 1.0) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed || pos.pending_trailing_current_pnl_pct == null || pos.pending_trailing_peak_pnl_pct == null) {
    return { confirmed: false, pending: false };
  }

  const pendingCurrent = pos.pending_trailing_current_pnl_pct;
  const pendingPeak = pos.pending_trailing_peak_pnl_pct;
  const pendingDrop = pos.pending_trailing_drop_pct ?? (pendingPeak - pendingCurrent);

  pos.pending_trailing_current_pnl_pct = null;
  pos.pending_trailing_peak_pnl_pct = null;
  pos.pending_trailing_drop_pct = null;
  pos.pending_trailing_started_at = null;

  const stillNearCrash = currentPnlPct != null && currentPnlPct <= pendingCurrent + tolerancePct;
  const stillDroppedEnough = currentPnlPct != null && (pendingPeak - currentPnlPct) >= trailingDropPct;

  if (stillNearCrash && stillDroppedEnough) {
    const reason = `Trailing TP: peak ${pendingPeak.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${(pendingPeak - currentPnlPct).toFixed(2)}% >= ${trailingDropPct}%)`;
    pos.confirmed_trailing_exit_reason = reason;
    pos.confirmed_trailing_exit_until = new Date(Date.now() + 30_000).toISOString();
    save(state);
    log("state", `Position ${position_address} trailing drop confirmed after recheck: pending drop ${pendingDrop.toFixed(2)}%, current ${currentPnlPct.toFixed(2)}%`);
    return { confirmed: true, reason };
  }

  save(state);
  log("state", `Position ${position_address} rejected trailing drop after 15s recheck (pending current: ${pendingCurrent.toFixed(2)}%, current: ${currentPnlPct ?? "?"}%)`);
  return { confirmed: false, rejected: true };
}

/**
 * Get all tracked positions (optionally filter open-only).
 */
export function getTrackedPositions(openOnly = false) {
  const state = load();
  const all = Object.values(state.positions);
  return openOnly ? all.filter((p) => !p.closed) : all;
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address) {
  const state = load();
  return state.positions[position_address] || null;
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary() {
  const state = load();
  const open = Object.values(state.positions).filter((p) => !p.closed);
  const closed = Object.values(state.positions).filter((p) => p.closed);
  const totalFeesClaimed = Object.values(state.positions)
    .reduce((sum, p) => sum + (p.total_fees_claimed_usd || 0), 0);

  return {
    open_positions: open.length,
    closed_positions: closed.length,
    total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
    positions: open.map((p) => ({
      position: p.position,
      pool: p.pool,
      strategy: p.strategy,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since,
      minutes_out_of_range: minutesOutOfRange(p.position),
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      initial_fee_tvl_24h: p.initial_fee_tvl_24h,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
    })),
    last_updated: state.lastUpdated,
    recent_events: (state.recentEvents || []).slice(-10),
  };
}

/**
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield).
 * Updates peak_pnl_pct, trailing_active, and OOR state.
 * @param {string} position_address
 * @param {object} positionData - fields from getMyPositions: pnl_pct, in_range, fee_per_tvl_24h
 * @param {object} mgmtConfig
 * Returns { action, reason } or null if no exit needed.
 */
export function updatePnlAndCheckExits(position_address, positionData, mgmtConfig) {
  const { pnl_pct: currentPnlPct, pnl_pct_suspicious, in_range, fee_per_tvl_24h } = positionData;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;

  if (pos.confirmed_trailing_exit_until) {
    if (new Date(pos.confirmed_trailing_exit_until).getTime() > Date.now() && pos.confirmed_trailing_exit_reason) {
      const reason = pos.confirmed_trailing_exit_reason;
      pos.confirmed_trailing_exit_reason = null;
      pos.confirmed_trailing_exit_until = null;
      save(state);
      return { action: "TRAILING_TP", reason, confirmed_recheck: true };
    }
    pos.confirmed_trailing_exit_reason = null;
    pos.confirmed_trailing_exit_until = null;
  }

  let changed = false;

  // Activate trailing TP once trigger threshold is reached
  if (mgmtConfig.trailingTakeProfit && !pos.trailing_active && (pos.peak_pnl_pct ?? 0) >= mgmtConfig.trailingTriggerPct) {
    pos.trailing_active = true;
    changed = true;
    log("state", `Position ${position_address} trailing TP activated (confirmed peak: ${pos.peak_pnl_pct}%)`);
  }

  // Update OOR state
  if (in_range === false && !pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    changed = true;
    log("state", `Position ${position_address} marked out of range`);
  } else if (in_range === true && pos.out_of_range_since) {
    pos.out_of_range_since = null;
    changed = true;
    log("state", `Position ${position_address} back in range`);
  }

  if (changed) save(state);

  const velocityWindowMs = Math.max(0, Number(mgmtConfig.stopLossVelocityWindowMs ?? 0));
  const pnlHistory = appendPnlHistory(pos, currentPnlPct, velocityWindowMs);
  if (pnlHistory.changed) {
    if (pnlHistory.initialized && velocityWindowMs > 0) {
      log("state", `Position ${position_address} PnL velocity history initialized; velocity stop needs one prior sample`);
    }
    save(state);
  }

  // Hard/fast/velocity stops outrank early dump so the owner sees the strongest
  // time-critical reason instead of a generic young-position label.
  if (!pnl_pct_suspicious) {
    const immediateStopLossDecision = buildStopLossExitDecision({
      currentPnlPct,
      managementConfig: mgmtConfig,
      velocityDropPct: pnlHistory.velocity.dropPct,
      velocityElapsedMs: pnlHistory.velocity.elapsedMs,
      immediateAction: "STOP_LOSS",
      includeSoftStop: false,
    });
    if (immediateStopLossDecision) {
      return immediateStopLossDecision;
    }
  }

  // ── Early dump detection (young position losing fast) ─────────
  const earlyDumpPct = mgmtConfig.earlyDumpPct ?? null;        // e.g. -2
  const earlyDumpMaxAgeMin = mgmtConfig.earlyDumpMaxAgeMin ?? 30;
  if (
    earlyDumpPct != null &&
    !pnl_pct_suspicious &&
    currentPnlPct != null &&
    currentPnlPct <= earlyDumpPct
  ) {
    const { age_minutes: ageMin } = positionData;
    if (ageMin != null && ageMin <= earlyDumpMaxAgeMin) {
      return {
        action: "STOP_LOSS",
        reason: `Early dump: PnL ${currentPnlPct.toFixed(2)}% <= ${earlyDumpPct}% within first ${ageMin}m (limit: ${earlyDumpMaxAgeMin}m)`,
      };
    }
  }

  // ── Stop loss ──────────────────────────────────────────────────
  if (!pnl_pct_suspicious) {
    const stopLossDecision = buildStopLossExitDecision({
      currentPnlPct,
      managementConfig: mgmtConfig,
      velocityDropPct: pnlHistory.velocity.dropPct,
      velocityElapsedMs: pnlHistory.velocity.elapsedMs,
      immediateAction: "STOP_LOSS",
    });
    if (stopLossDecision) {
      return stopLossDecision;
    }
  }

  // ── Trailing TP ────────────────────────────────────────────────
  if (!pnl_pct_suspicious && pos.trailing_active) {
    const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
    if (dropFromPeak >= mgmtConfig.trailingDropPct) {
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${mgmtConfig.trailingDropPct}%)`,
        needs_confirmation: true,
        peak_pnl_pct: pos.peak_pnl_pct,
        current_pnl_pct: currentPnlPct,
        drop_from_peak_pct: dropFromPeak,
      };
    }
  }

  // ── Out of range too long ──────────────────────────────────────
  if (pos.out_of_range_since) {
    const minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
    const oorExit = getOutOfRangeExitPolicy(minutesOOR, mgmtConfig);
    if (oorExit) {
      return {
        action: "OUT_OF_RANGE",
        reason: oorExit.reason,
        oor_stage: oorExit.stage,
        urgent: oorExit.urgent,
        indicatorPolicy: oorExit.indicatorPolicy,
        minutes_out_of_range: minutesOOR,
      };
    }
  }

  // ── Low yield (only after position has had time to accumulate fees) ───
  const { age_minutes } = positionData;
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  if (
    fee_per_tvl_24h != null &&
    mgmtConfig.minFeePerTvl24h != null &&
    fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h &&
    (age_minutes == null || age_minutes >= minAgeForYieldCheck)
  ) {
    return {
      action: "LOW_YIELD",
      reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m)`,
    };
  }

  return null;
}

// ─── Briefing Tracking ─────────────────────────────────────────

/**
 * Get the date (YYYY-MM-DD UTC) when the last briefing was sent.
 */
export function getLastBriefingDate() {
  const state = load();
  return state._lastBriefingDate || null;
}

/**
 * Record that the briefing was sent today.
 */
export function setLastBriefingDate() {
  const state = load();
  state._lastBriefingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  save(state);
}

/**
 * Reconcile local state with actual on-chain positions.
 * Marks any local open positions as closed if they are not in the on-chain list.
 */
const SYNC_GRACE_MS = 5 * 60_000; // don't auto-close positions deployed < 5 min ago

export function syncOpenPositions(active_addresses) {
  const state = load();
  const activeSet = new Set(active_addresses);
  let changed = false;

  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || activeSet.has(posId)) continue;

    // Grace period: newly deployed positions may not be indexed yet
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_MS) {
      log("state", `Position ${posId} not on-chain yet — within grace period, skipping auto-close`);
      continue;
    }

    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push(`Auto-closed during state sync (not found on-chain)`);
    changed = true;
    log("state", `Position ${posId} auto-closed (missing from on-chain data)`);
  }

  if (changed) save(state);
}

export function reconcileGhostPositions(livePositions = []) {
  const state = load();
  if (!state.positions || typeof state.positions !== "object" || Array.isArray(state.positions)) {
    state.positions = {};
  }
  if (!state.ghostCandidates || typeof state.ghostCandidates !== "object" || Array.isArray(state.ghostCandidates)) {
    state.ghostCandidates = {};
  }

  const nowIso = new Date().toISOString();
  const kept = [];
  const suppressed = [];
  const seen = new Set();
  let changed = false;

  for (const livePosition of Array.isArray(livePositions) ? livePositions : []) {
    const posId = livePosition?.position;
    if (!posId) {
      kept.push(livePosition);
      continue;
    }

    seen.add(posId);
    const tracked = state.positions[posId] || null;
    const candidate = state.ghostCandidates[posId] || {
      observations: 0,
      first_seen_at: nowIso,
      reason: "zero-value live position with no base mint",
    };
    const ghostLike = isGhostLikeLivePosition(livePosition);
    const ageMs = getGhostObservationAgeMs(tracked, livePosition);

    if (!ghostLike || ageMs < GHOST_POSITION_GRACE_MS) {
      if (state.ghostCandidates[posId]) {
        delete state.ghostCandidates[posId];
        changed = true;
      }
      kept.push(livePosition);
      continue;
    }

    if (candidate.suppressed) {
      suppressed.push({
        ...livePosition,
        ghost_reason: candidate.reason,
        ghost_observations: candidate.observations,
      });
      continue;
    }

    candidate.observations += 1;
    candidate.last_seen_at = nowIso;
    candidate.pool = livePosition.pool || tracked?.pool || null;
    state.ghostCandidates[posId] = candidate;
    changed = true;

    if (candidate.observations >= GHOST_OBSERVATIONS_TO_SUPPRESS) {
      candidate.suppressed = true;
      candidate.suppressed_at = nowIso;

      if (tracked && !tracked.closed) {
        tracked.closed = true;
        tracked.closed_at = nowIso;
        tracked.notes = Array.isArray(tracked.notes) ? tracked.notes : [];
        tracked.notes.push(`Auto-closed during ghost reconciliation: ${candidate.reason}`);
        pushEvent(state, {
          action: "close",
          position: posId,
          pool_name: tracked.pool_name || tracked.pool,
          reason: `ghost reconciliation: ${candidate.reason}`,
        });
        log("state", `Position ${posId} auto-closed during ghost reconciliation`);
      } else {
        log("state", `Suppressing ghost position ${posId} after ${candidate.observations} observations`);
      }

      suppressed.push({
        ...livePosition,
        ghost_reason: candidate.reason,
        ghost_observations: candidate.observations,
      });
      continue;
    }

    kept.push(livePosition);
  }

  for (const posId of Object.keys(state.ghostCandidates)) {
    if (!seen.has(posId)) {
      delete state.ghostCandidates[posId];
      changed = true;
    }
  }

  if (changed) save(state);
  return { positions: kept, suppressed };
}
