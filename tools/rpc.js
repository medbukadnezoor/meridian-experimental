import { AsyncLocalStorage } from "node:async_hooks";
import { Connection, sendAndConfirmTransaction as web3SendAndConfirmTransaction } from "@solana/web3.js";
import { config } from "../config.js";
import { log } from "../logger.js";

export const RPC_PRIORITY = Object.freeze({
  URGENT_CLOSE: 0,
  MANAGEMENT: 1,
  NORMAL_SEND: 2,
  DEPLOY: 3,
  SCREENING: 4,
});

const PRIORITY_LABELS = Object.freeze({
  0: "P0",
  1: "P1",
  2: "P2",
  3: "P3",
  4: "P4",
});

const READ_METHODS = new Set([
  "confirmTransaction",
  "getAccountInfo",
  "getBalance",
  "getBlockTime",
  "getLatestBlockhash",
  "getMultipleAccountsInfo",
  "getParsedAccountInfo",
  "getProgramAccounts",
  "getSignaturesForAddress",
  "getSignatureStatuses",
  "getTransaction",
]);

const SEND_METHODS = new Set([
  "sendRawTransaction",
  "sendTransaction",
]);

const context = new AsyncLocalStorage();
const connectionCache = new Map();
let _deployCooldownUntilMs = 0;
let _deployCooldownReason = null;

function nowMs() {
  return Date.now();
}

function clampPriority(priority) {
  const parsed = Number(priority);
  if (!Number.isFinite(parsed)) return RPC_PRIORITY.DEPLOY;
  return Math.max(RPC_PRIORITY.URGENT_CLOSE, Math.min(RPC_PRIORITY.SCREENING, Math.floor(parsed)));
}

function rpcPressureConfig() {
  const c = config.rpcPressure || {};
  return {
    enabled: c.enabled !== false,
    readReqPerSec: Math.max(1, Number(c.readReqPerSec ?? 6)),
    sendReqPerSec: Math.max(0.1, Number(c.sendReqPerSec ?? 1)),
    deployCooldownMs: Math.max(60_000, Number(c.deployCooldownMs ?? 20 * 60_000)),
    telemetryMinQueueMs: Math.max(0, Number(c.telemetryMinQueueMs ?? 250)),
  };
}

export function classifyProvider(source = "") {
  const s = String(source || "").toLowerCase();
  if (s.includes("helius_wallet")) return "helius_wallet_api";
  if (s.includes("meteora")) return "meteora_datapi";
  if (s.includes("lpagent")) return "lpagent";
  if (s.includes("agent_meridian") || s.includes("meridian")) return "agent_meridian";
  if (s.includes("jupiter")) return "jupiter";
  if (s.includes("llm")) return "llm";
  return "helius_rpc";
}

export function isRpcRateLimitError(error) {
  const status = Number(error?.status || error?.code || error?.cause?.status || 0);
  const text = String(error?.message || error?.toString?.() || "").toLowerCase();
  return status === 429 ||
    status === -32429 ||
    text.includes("429") ||
    text.includes("too many requests") ||
    text.includes("max usage reached") ||
    text.includes("rate limited");
}

function errorBucket(error) {
  if (!error) return "ok";
  if (isRpcRateLimitError(error)) return "rate_limited";
  const status = Number(error?.status || error?.code || 0);
  if (Number.isFinite(status) && status !== 0) return `status_${status}`;
  return "error";
}

export class PriorityScheduler {
  constructor({ reqPerSec, lane }) {
    this.reqPerSec = reqPerSec;
    this.lane = lane;
    this.queues = new Map();
    this.running = false;
    this.lastStartMs = 0;
    this.inFlight = 0;
    for (let priority = RPC_PRIORITY.URGENT_CLOSE; priority <= RPC_PRIORITY.SCREENING; priority++) {
      this.queues.set(priority, []);
    }
  }

  configure(reqPerSec) {
    this.reqPerSec = Math.max(0.1, Number(reqPerSec || this.reqPerSec || 1));
  }

  get pendingUrgent() {
    return (this.queues.get(RPC_PRIORITY.URGENT_CLOSE) || []).length;
  }

  enqueue(priority, task, meta = {}) {
    const p = clampPriority(priority);
    const queuedAt = nowMs();
    return new Promise((resolve, reject) => {
      this.queues.get(p).push({ priority: p, task, meta, queuedAt, resolve, reject });
      this.pump();
    });
  }

  nextJob() {
    for (let priority = RPC_PRIORITY.URGENT_CLOSE; priority <= RPC_PRIORITY.SCREENING; priority++) {
      const queue = this.queues.get(priority);
      if (queue?.length) return queue.shift();
    }
    return null;
  }

  pump() {
    if (this.running) return;
    this.running = true;
    queueMicrotask(() => this.loop());
  }

  async loop() {
    try {
      while (this.hasPending()) {
        const cfg = rpcPressureConfig();
        this.configure(this.lane === "send" ? cfg.sendReqPerSec : cfg.readReqPerSec);
        const spacingMs = Math.ceil(1000 / this.reqPerSec);
        const waitMs = Math.max(0, this.lastStartMs + spacingMs - nowMs());
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
        const job = this.nextJob();
        if (!job) continue;
        this.lastStartMs = nowMs();
        this.inFlight += 1;
        this.runJob(job).catch(() => {});
      }
    } finally {
      this.running = false;
      if (this.hasPending()) this.pump();
    }
  }

  hasPending() {
    for (const queue of this.queues.values()) {
      if (queue.length) return true;
    }
    return false;
  }

  async runJob(job) {
    const startMs = nowMs();
    let err = null;
    try {
      const value = await job.task();
      job.resolve(value);
    } catch (error) {
      err = error;
      if (isRpcRateLimitError(error)) {
        error.rpcProvider = classifyProvider(job.meta.source);
        error.rpcPressureLane = this.lane;
        error.rpcPressureMethod = job.meta.method;
      }
      job.reject(error);
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
      emitRpcTelemetry({
        lane: this.lane,
        priority: job.priority,
        method: job.meta.method,
        source: job.meta.source,
        queuedMs: startMs - job.queuedAt,
        executionMs: nowMs() - startMs,
        inFlight: this.inFlight,
        error: err,
      });
    }
  }
}

const readScheduler = new PriorityScheduler({ reqPerSec: 6, lane: "read" });
const sendScheduler = new PriorityScheduler({ reqPerSec: 1, lane: "send" });

function emitRpcTelemetry({ lane, priority, method, source, queuedMs, executionMs, inFlight, error }) {
  const cfg = rpcPressureConfig();
  if (!cfg.enabled) return;
  const bucket = errorBucket(error);
  if (bucket === "ok" && queuedMs < cfg.telemetryMinQueueMs) return;
  const provider = classifyProvider(source);
  const cooldown = getDeployRpcCooldownState();
  log("rpc_pressure", JSON.stringify({
    provider,
    lane,
    method: method || "unknown",
    priority: PRIORITY_LABELS[priority] || `P${priority}`,
    queued_ms: queuedMs,
    execution_ms: executionMs,
    in_flight: inFlight,
    error_bucket: bucket,
    deploy_cooldown_active: cooldown.active,
    deploy_cooldown_remaining_ms: cooldown.remaining_ms,
  }));
}

function currentRpcContext() {
  return context.getStore() || {};
}

export function withRpcPriority(priority, source, fn) {
  return context.run({ priority: clampPriority(priority), source }, fn);
}

function scheduleMethod(method, source, lane, fn) {
  const cfg = rpcPressureConfig();
  if (!cfg.enabled) return fn();
  const ctx = currentRpcContext();
  const priority = clampPriority(ctx.priority);
  const scheduler = lane === "send" ? sendScheduler : readScheduler;
  return scheduler.enqueue(priority, fn, {
    method,
    source: ctx.source || source || "helius_rpc",
  });
}

export function getSharedConnection(rpcUrl = process.env.RPC_URL, rpcWsUrl = process.env.RPC_WS_URL) {
  const cacheKey = `${rpcUrl || ""}|${rpcWsUrl || ""}`;
  if (connectionCache.has(cacheKey)) return connectionCache.get(cacheKey);
  const raw = new Connection(rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: rpcWsUrl || undefined,
  });
  const proxy = new Proxy(raw, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (READ_METHODS.has(prop)) {
        return (...args) => scheduleMethod(prop, "helius_rpc", "read", () => value.apply(target, args));
      }
      if (SEND_METHODS.has(prop)) {
        return (...args) => scheduleMethod(prop, "helius_rpc", "send", () => value.apply(target, args));
      }
      return value.bind(target);
    },
  });
  connectionCache.set(cacheKey, proxy);
  return proxy;
}

export async function sendAndConfirmTransactionWithPriority(connection, transaction, signers, options = {}, {
  priority = RPC_PRIORITY.NORMAL_SEND,
  source = "helius_rpc.send",
} = {}) {
  return withRpcPriority(priority, source, () =>
    web3SendAndConfirmTransaction(connection, transaction, signers, options)
  );
}

export function getDeployRpcCooldownState() {
  const remainingMs = Math.max(0, _deployCooldownUntilMs - nowMs());
  return {
    active: remainingMs > 0,
    until: remainingMs > 0 ? new Date(_deployCooldownUntilMs).toISOString() : null,
    remaining_ms: remainingMs,
    reason: remainingMs > 0 ? _deployCooldownReason : null,
  };
}

export function recordDeployRpcRateLimit(error, source = "deploy") {
  if (!isRpcRateLimitError(error) || error?.rpcProvider !== "helius_rpc") return null;
  const cfg = rpcPressureConfig();
  _deployCooldownUntilMs = Math.max(_deployCooldownUntilMs, nowMs() + cfg.deployCooldownMs);
  _deployCooldownReason = `${source}: ${errorBucket(error)}`;
  const state = getDeployRpcCooldownState();
  log("rpc_pressure", JSON.stringify({
    provider: "helius_rpc",
    lane: "deploy_cooldown",
    method: "deploy",
    priority: "P3",
    error_bucket: "rate_limited",
    deploy_cooldown_active: true,
    deploy_cooldown_until: state.until,
    deploy_cooldown_remaining_ms: state.remaining_ms,
  }));
  return state;
}

export function assertDeployRpcCooldownClear() {
  const state = getDeployRpcCooldownState();
  if (!state.active) return;
  const error = new Error(`Deploy RPC cooldown active until ${state.until} (${Math.ceil(state.remaining_ms / 60000)}m remaining)`);
  error.deployRpcCooldown = state;
  throw error;
}

export function getRpcPressureDebugState() {
  return {
    read: { inFlight: readScheduler.inFlight, pendingUrgent: readScheduler.pendingUrgent },
    send: { inFlight: sendScheduler.inFlight, pendingUrgent: sendScheduler.pendingUrgent },
    deployCooldown: getDeployRpcCooldownState(),
  };
}
