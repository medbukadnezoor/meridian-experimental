import fs from "fs";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { log } from "./logger.js";
import { getActiveBin } from "./tools/dlmm.js";

const DEFAULT_DEBOUNCE_MS = 3_000;
const DEFAULT_LOG_DIR = "./logs";

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

export function classifyActiveBin(position, activeBin, priorActiveBin, previousObservedAtMs, observedAtMs) {
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
    bin_velocity: binVelocity != null ? Number(binVelocity.toFixed(6)) : null,
    in_range: inRange,
    adverse_oor_guess: adverseOorGuess,
    would_close_reason: wouldCloseReason,
  };
}

export class ActiveBinOracleRecorder {
  constructor({
    connection = null,
    rpcUrl = process.env.RPC_URL,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    logDir = DEFAULT_LOG_DIR,
    getActiveBinFn = getActiveBin,
    logger = log,
    now = () => new Date(),
  } = {}) {
    this.connection = connection;
    this.rpcUrl = rpcUrl;
    this.debounceMs = debounceMs;
    this.logDir = logDir;
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
          this.poolState.set(position.pool, {
            ...state,
            lastActiveBin: activeBin,
            lastObservedAtMs: this.now().getTime(),
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
    const rows = positions.map((position) => {
      const classification = classifyActiveBin(
        position,
        activeBin,
        previous.lastActiveBin,
        previous.lastObservedAtMs,
        observedAtMs,
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
    this.poolState.set(pool, { lastActiveBin: activeBin, lastObservedAtMs: observedAtMs });
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
