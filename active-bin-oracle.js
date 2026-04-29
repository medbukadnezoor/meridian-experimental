import fs from "fs";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { log } from "./logger.js";
import { getActiveBin } from "./tools/dlmm.js";

const DEFAULT_DEBOUNCE_MS = 3_000;
const DEFAULT_LOG_DIR = "./logs";
const DEFAULT_HISTORY_RETENTION_MS = 60_000;
const DEFAULT_MAX_HISTORY_POINTS = 120;

export const VELOCITY_WINDOWS = [
  { label: "10s", targetMs: 10_000, minMs: 7_000, maxMs: 20_000 },
  { label: "30s", targetMs: 30_000, minMs: 20_000, maxMs: 45_000 },
];

export const SHADOW_VELOCITY_THRESHOLDS = {
  // Conservative shadow labels only. These values are meant to surface
  // unusually fast bin movement for review, not to authorize a close.
  watch: {
    minAbs10sDelta: 12,
    minAbs30sDelta: 24,
    minAbsBinsPerSec: 1.0,
  },
  rugLikeExtreme: {
    minAbs10sDelta: 30,
    minAbs30sDelta: 60,
    minAbsBinsPerSec: 2.5,
  },
};

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function appendJsonl(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`);
}

function roundNumber(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function trimHistory(history, observedAtMs, retentionMs, maxPoints) {
  const minObservedAtMs = observedAtMs - retentionMs;
  const trimmed = (Array.isArray(history) ? history : [])
    .filter((point) => point?.observedAtMs >= minObservedAtMs && point?.activeBin != null)
    .slice(-maxPoints);
  return trimmed;
}

function findWindowBaseline(history, observedAtMs, window) {
  let best = null;
  let bestDistance = Infinity;
  for (const point of Array.isArray(history) ? history : []) {
    const elapsedMs = observedAtMs - point.observedAtMs;
    if (elapsedMs < window.minMs || elapsedMs > window.maxMs) continue;
    const distance = Math.abs(elapsedMs - window.targetMs);
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

export function computeVelocityWindows(activeBin, observedAtMs, history = [], windows = VELOCITY_WINDOWS) {
  const active = asNumber(activeBin);
  const features = {};
  for (const window of windows) {
    const baseline = active != null ? findWindowBaseline(history, observedAtMs, window) : null;
    const prefix = `velocity_${window.label}_`;
    const elapsedSec = baseline ? (observedAtMs - baseline.observedAtMs) / 1000 : null;
    const delta = active != null && baseline ? active - baseline.activeBin : null;
    const binsPerSec = delta != null && elapsedSec > 0 ? delta / elapsedSec : null;
    features[`${prefix}bin_delta`] = delta;
    features[`${prefix}elapsed_sec`] = elapsedSec != null ? roundNumber(elapsedSec, 3) : null;
    features[`${prefix}bins_per_sec`] = binsPerSec != null ? roundNumber(binsPerSec) : null;
  }
  return features;
}

export function classifyShadowVelocity(velocityFeatures = {}, thresholds = SHADOW_VELOCITY_THRESHOLDS) {
  const v10Delta = asNumber(velocityFeatures.velocity_10s_bin_delta);
  const v30Delta = asNumber(velocityFeatures.velocity_30s_bin_delta);
  const v10Rate = asNumber(velocityFeatures.velocity_10s_bins_per_sec);
  const v30Rate = asNumber(velocityFeatures.velocity_30s_bins_per_sec);
  const abs10Delta = v10Delta != null ? Math.abs(v10Delta) : null;
  const abs30Delta = v30Delta != null ? Math.abs(v30Delta) : null;
  const absMaxRate = Math.max(
    v10Rate != null ? Math.abs(v10Rate) : 0,
    v30Rate != null ? Math.abs(v30Rate) : 0,
  );

  const reasons = [];
  const extreme = (
    (abs10Delta != null && abs10Delta >= thresholds.rugLikeExtreme.minAbs10sDelta) ||
    (abs30Delta != null && abs30Delta >= thresholds.rugLikeExtreme.minAbs30sDelta) ||
    absMaxRate >= thresholds.rugLikeExtreme.minAbsBinsPerSec
  );
  if (extreme) {
    if (abs10Delta != null && abs10Delta >= thresholds.rugLikeExtreme.minAbs10sDelta) {
      reasons.push(`abs_10s_delta=${abs10Delta}`);
    }
    if (abs30Delta != null && abs30Delta >= thresholds.rugLikeExtreme.minAbs30sDelta) {
      reasons.push(`abs_30s_delta=${abs30Delta}`);
    }
    if (absMaxRate >= thresholds.rugLikeExtreme.minAbsBinsPerSec) {
      reasons.push(`max_rate=${roundNumber(absMaxRate)}_bins_per_sec`);
    }
    return {
      shadow_velocity_signal: "rug_like_extreme",
      shadow_velocity_reason: `shadow_only_velocity_candidate ${reasons.join(" ")}`,
    };
  }

  const watch = (
    (abs10Delta != null && abs10Delta >= thresholds.watch.minAbs10sDelta) ||
    (abs30Delta != null && abs30Delta >= thresholds.watch.minAbs30sDelta) ||
    absMaxRate >= thresholds.watch.minAbsBinsPerSec
  );
  if (watch) {
    if (abs10Delta != null && abs10Delta >= thresholds.watch.minAbs10sDelta) {
      reasons.push(`abs_10s_delta=${abs10Delta}`);
    }
    if (abs30Delta != null && abs30Delta >= thresholds.watch.minAbs30sDelta) {
      reasons.push(`abs_30s_delta=${abs30Delta}`);
    }
    if (absMaxRate >= thresholds.watch.minAbsBinsPerSec) {
      reasons.push(`max_rate=${roundNumber(absMaxRate)}_bins_per_sec`);
    }
    return {
      shadow_velocity_signal: "watch",
      shadow_velocity_reason: `shadow_only_velocity_watch ${reasons.join(" ")}`,
    };
  }

  return {
    shadow_velocity_signal: null,
    shadow_velocity_reason: null,
  };
}

export function classifyActiveBin(position, activeBin, priorActiveBin, previousObservedAtMs, observedAtMs, velocityFeatures = {}) {
  const lowerBin = asNumber(position?.lower_bin);
  const upperBin = asNumber(position?.upper_bin);
  const active = asNumber(activeBin);
  const prior = asNumber(priorActiveBin);
  const pnlPct = asNumber(position?.pnl_pct);
  const inRange = active != null && lowerBin != null && upperBin != null
    ? active >= lowerBin && active <= upperBin
    : null;
  const belowRange = inRange === false && active < lowerBin;
  const aboveRange = inRange === false && active > upperBin;
  const binDelta = active != null && prior != null ? active - prior : null;
  const elapsedSec = previousObservedAtMs != null && observedAtMs != null
    ? Math.max(0, (observedAtMs - previousObservedAtMs) / 1000)
    : null;
  const binVelocity = binDelta != null && elapsedSec > 0 ? binDelta / elapsedSec : null;
  const adverseOorGuess = inRange === false && (pnlPct == null || pnlPct <= 0);
  const rangeSide = belowRange ? "below_range" : aboveRange ? "above_range" : inRange === true ? "in_range" : "unknown";
  const velocitySignal = classifyShadowVelocity(velocityFeatures);
  const wouldCloseReason = adverseOorGuess
    ? [
        `shadow_only_active_bin_${rangeSide}`,
        binDelta != null ? `delta=${binDelta}` : null,
        binVelocity != null ? `velocity=${Number(binVelocity.toFixed(4))}_bins_per_sec` : null,
        pnlPct != null ? `api_pnl_pct=${pnlPct}` : null,
      ].filter(Boolean).join(" ")
    : null;

  return {
    lower_bin: lowerBin,
    upper_bin: upperBin,
    active_bin: active,
    prior_active_bin: prior,
    bin_delta: binDelta,
    bin_velocity: roundNumber(binVelocity),
    in_range: inRange,
    adverse_oor_guess: adverseOorGuess,
    ...velocityFeatures,
    ...velocitySignal,
    would_close_reason: wouldCloseReason,
  };
}

export class ActiveBinOracleRecorder {
  constructor({
    connection = null,
    rpcUrl = process.env.RPC_URL,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    logDir = DEFAULT_LOG_DIR,
    historyRetentionMs = DEFAULT_HISTORY_RETENTION_MS,
    maxHistoryPoints = DEFAULT_MAX_HISTORY_POINTS,
    getActiveBinFn = getActiveBin,
    logger = log,
    now = () => new Date(),
  } = {}) {
    this.connection = connection;
    this.rpcUrl = rpcUrl;
    this.debounceMs = debounceMs;
    this.logDir = logDir;
    this.historyRetentionMs = historyRetentionMs;
    this.maxHistoryPoints = maxHistoryPoints;
    this.getActiveBinFn = getActiveBinFn;
    this.logger = logger;
    this.now = now;
    this.positionsByPool = new Map();
    this.subscriptions = new Map();
    this.pendingSubscriptions = new Set();
    this.timers = new Map();
    this.poolState = new Map();
    this.disabledReason = null;
  }

  getLogFile(now = this.now()) {
    return path.join(this.logDir, `active-bin-oracle-${todayIso(now)}.jsonl`);
  }

  ensureConnection() {
    if (this.connection) return this.connection;
    if (!this.rpcUrl) {
      this.disabledReason = "RPC_URL not set";
      return null;
    }
    this.connection = new Connection(this.rpcUrl, "confirmed");
    return this.connection;
  }

  updatePositions(positions) {
    const nextByPool = new Map();
    for (const position of Array.isArray(positions) ? positions : []) {
      if (!position?.pool || !position?.position) continue;
      if (position.lower_bin == null || position.upper_bin == null) continue;
      if (!nextByPool.has(position.pool)) nextByPool.set(position.pool, []);
      nextByPool.get(position.pool).push(position);

      const activeBin = asNumber(position.active_bin);
      if (activeBin != null) {
        const state = this.poolState.get(position.pool) || {};
        if (state.lastActiveBin == null) {
          const nowMs = this.now().getTime();
          this.poolState.set(position.pool, {
            ...state,
            lastActiveBin: activeBin,
            lastObservedAtMs: nowMs,
            history: trimHistory(
              [...(state.history || []), { activeBin, observedAtMs: nowMs }],
              nowMs,
              this.historyRetentionMs,
              this.maxHistoryPoints,
            ),
          });
        }
      }
    }

    this.positionsByPool = nextByPool;

    for (const pool of nextByPool.keys()) {
      this.subscribePool(pool).catch((error) => {
        this.logger("active_bin_oracle_warn", `Subscribe failed for ${pool.slice(0, 8)}: ${error.message}`);
      });
    }

    for (const pool of this.subscriptions.keys()) {
      if (!nextByPool.has(pool)) {
        this.unsubscribePool(pool).catch((error) => {
          this.logger("active_bin_oracle_warn", `Unsubscribe failed for ${pool.slice(0, 8)}: ${error.message}`);
        });
      }
    }
  }

  async subscribePool(pool) {
    if (this.subscriptions.has(pool) || this.pendingSubscriptions.has(pool)) return;
    this.pendingSubscriptions.add(pool);
    const connection = this.ensureConnection();
    if (!connection) {
      this.pendingSubscriptions.delete(pool);
      this.logger("active_bin_oracle_warn", `Shadow recorder disabled: ${this.disabledReason}`);
      return;
    }
    try {
      const id = await connection.onAccountChange(
        new PublicKey(pool),
        () => this.queueSample(pool),
        "confirmed",
      );
      this.subscriptions.set(pool, id);
      this.logger("active_bin_oracle", `Subscribed shadow active-bin recorder for pool ${pool.slice(0, 8)}`);
    } finally {
      this.pendingSubscriptions.delete(pool);
    }
  }

  async unsubscribePool(pool) {
    const id = this.subscriptions.get(pool);
    if (id == null) return;
    clearTimeout(this.timers.get(pool));
    this.timers.delete(pool);
    this.pendingSubscriptions.delete(pool);
    this.subscriptions.delete(pool);
    this.positionsByPool.delete(pool);
    if (this.connection?.removeAccountChangeListener) {
      await this.connection.removeAccountChangeListener(id).catch(() => {});
    }
    this.logger("active_bin_oracle", `Unsubscribed shadow active-bin recorder for pool ${pool.slice(0, 8)}`);
  }

  queueSample(pool) {
    clearTimeout(this.timers.get(pool));
    const timer = setTimeout(() => {
      this.timers.delete(pool);
      this.recordPoolSample(pool).catch((error) => {
        this.logger("active_bin_oracle_warn", `Sample failed for ${pool.slice(0, 8)}: ${error.message}`);
      });
    }, this.debounceMs);
    this.timers.set(pool, timer);
  }

  async recordPoolSample(pool) {
    const positions = this.positionsByPool.get(pool) || [];
    if (!positions.length) return [];

    const observedAt = this.now();
    const observedAtMs = observedAt.getTime();
    const previous = this.poolState.get(pool) || {};
    const active = await this.getActiveBinFn({ pool_address: pool });
    const activeBin = asNumber(active?.binId);
    const history = trimHistory(previous.history || [], observedAtMs, this.historyRetentionMs, this.maxHistoryPoints);
    const velocityFeatures = computeVelocityWindows(activeBin, observedAtMs, history);
    const rows = positions.map((position) => {
      const classification = classifyActiveBin(
        position,
        activeBin,
        previous.lastActiveBin,
        previous.lastObservedAtMs,
        observedAtMs,
        velocityFeatures,
      );
      return {
        timestamp: observedAt.toISOString(),
        pool,
        position: position.position,
        pair: position.pair || null,
        ...classification,
        pnl_pct: position.pnl_pct ?? null,
        pnl_usd: position.pnl_usd ?? null,
        pnl_pct_derived: position.pnl_pct_derived ?? null,
        source: "shadow_active_bin_oracle",
      };
    });

    for (const row of rows) appendJsonl(this.getLogFile(observedAt), row);
    this.poolState.set(pool, {
      lastActiveBin: activeBin,
      lastObservedAtMs: observedAtMs,
      history: trimHistory(
        [...history, { activeBin, observedAtMs }],
        observedAtMs,
        this.historyRetentionMs,
        this.maxHistoryPoints,
      ),
    });
    return rows;
  }

  async stop() {
    const pools = [...this.subscriptions.keys()];
    await Promise.all(pools.map((pool) => this.unsubscribePool(pool)));
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

export const activeBinOracleRecorder = new ActiveBinOracleRecorder();
