import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import bs58 from "bs58";
import { createMeteoraTxDecodeCache } from "./tx-decode-cache.js";

export const METEORA_DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

const DEFAULT_SIGNATURE_LIMIT = 50;
const DEFAULT_MAX_WINDOW_MS = 30 * 60_000;
const DEFAULT_BASE_BACKOFF_MS = 2_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const REMOVE_INSTRUCTIONS = new Set(["removeLiquidity", "removeLiquidityByRange", "removeAllLiquidity"]);
const ADD_INSTRUCTIONS = new Set(["addLiquidity", "addLiquidityByWeight", "addLiquidityByStrategy", "addLiquidityOneSide"]);
const LP_INSTRUCTIONS = new Set([...REMOVE_INSTRUCTIONS, ...ADD_INSTRUCTIONS]);

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function anchorDiscriminator(name) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8).toString("hex");
}

const DLMM_DISCRIMINATORS = Object.freeze(Object.fromEntries(
  [...LP_INSTRUCTIONS].map((name) => [anchorDiscriminator(name), name]),
));

function decodeInstructionData(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.from(data);
  if (typeof data !== "string" || !data.trim()) return Buffer.alloc(0);
  try {
    return Buffer.from(bs58.decode(data));
  } catch {
    try {
      return Buffer.from(data, "base64");
    } catch {
      return Buffer.alloc(0);
    }
  }
}

function accountKeyToString(key) {
  if (!key) return null;
  if (typeof key === "string") return key;
  if (typeof key.pubkey?.toString === "function") return key.pubkey.toString();
  if (typeof key.toString === "function") return key.toString();
  return null;
}

function getAccountKeys(tx) {
  const keys = tx?.transaction?.message?.accountKeys
    || tx?.transaction?.message?.staticAccountKeys
    || tx?.message?.accountKeys
    || [];
  return keys.map(accountKeyToString);
}

function getSignerSet(tx) {
  const signerSet = new Set();
  const keys = tx?.transaction?.message?.accountKeys || tx?.message?.accountKeys || [];
  for (const key of keys) {
    if (key?.signer === true || key?.isSigner === true) {
      const value = accountKeyToString(key);
      if (value) signerSet.add(value);
    }
  }
  return signerSet;
}

function getInstructions(tx) {
  const message = tx?.transaction?.message || tx?.message || {};
  const accountKeys = getAccountKeys(tx);
  const raw = message.instructions || message.compiledInstructions || [];
  return raw.map((ix) => {
    const programId = accountKeyToString(ix.programId) || accountKeys[ix.programIdIndex] || null;
    return {
      programId,
      data: ix.data,
    };
  });
}

function classifyInstruction(ix) {
  if (ix.programId !== METEORA_DLMM_PROGRAM_ID) return null;
  const data = decodeInstructionData(ix.data);
  if (data.length < 8) return null;
  const name = DLMM_DISCRIMINATORS[data.subarray(0, 8).toString("hex")];
  if (!name) return null;
  return {
    name,
    type: REMOVE_INSTRUCTIONS.has(name) ? "remove" : "add",
    data,
  };
}

function largestU64AfterDiscriminator(data) {
  if (!Buffer.isBuffer(data) || data.length < 16) return null;
  let largest = 0n;
  for (let offset = 8; offset + 8 <= data.length; offset += 8) {
    const value = data.readBigUInt64LE(offset);
    if (value > largest) largest = value;
  }
  if (largest === 0n) return null;
  const number = Number(largest);
  return Number.isFinite(number) ? number : null;
}

function estimateInstructionUsd(classified, telemetryContext) {
  const explicit = asNumber(classified?.amountUsd);
  if (explicit != null) return explicit;
  const rawAmount = asNumber(classified.amountRaw) ?? largestU64AfterDiscriminator(classified.data);
  if (rawAmount == null) return 0;
  const decimals = asNumber(telemetryContext?.tokenDecimals) ?? asNumber(telemetryContext?.positions?.[0]?.base_decimals) ?? 9;
  const tokenAmount = rawAmount / (10 ** decimals);
  const tokenPriceUsd = asNumber(telemetryContext?.tokenPriceUsd)
    ?? asNumber(telemetryContext?.positions?.[0]?.base_price_usd)
    ?? asNumber(telemetryContext?.positions?.[0]?.token_price_usd)
    ?? null;
  return tokenPriceUsd != null ? tokenAmount * tokenPriceUsd : 0;
}

function txTimestampMs(tx, fallbackMs) {
  const blockTime = asNumber(tx?.blockTime);
  return blockTime != null ? blockTime * 1000 : fallbackMs;
}

function inferWalletAddress(walletAddress) {
  if (typeof walletAddress === "string" && walletAddress.trim()) return walletAddress.trim();
  if (!process.env.WALLET_PRIVATE_KEY) return null;
  try {
    return Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY)).publicKey.toString();
  } catch {
    return null;
  }
}

function isRateLimitError(error) {
  return /429|rate.?limit|too many requests/i.test(error?.message || "");
}

function summarizeEvents(events, nowMs) {
  const windows = {
    "5m": 5 * 60_000,
    "15m": 15 * 60_000,
    "30m": 30 * 60_000,
  };
  const summary = {
    pool_lp_net_dep_usd_5m: 0,
    pool_lp_net_dep_usd_15m: 0,
    pool_lp_net_dep_usd_30m: 0,
    pool_lp_add_count_5m: 0,
    pool_lp_remove_count_5m: 0,
    pool_lp_largest_remove_usd_5m: 0,
  };
  for (const event of events) {
    const ageMs = nowMs - event.timestampMs;
    if (ageMs <= windows["5m"]) {
      summary.pool_lp_net_dep_usd_5m += event.signedUsd;
      if (event.type === "add") summary.pool_lp_add_count_5m += 1;
      if (event.type === "remove") {
        summary.pool_lp_remove_count_5m += 1;
        summary.pool_lp_largest_remove_usd_5m = Math.max(summary.pool_lp_largest_remove_usd_5m, Math.abs(event.amountUsd));
      }
    }
    if (ageMs <= windows["15m"]) summary.pool_lp_net_dep_usd_15m += event.signedUsd;
    if (ageMs <= windows["30m"]) summary.pool_lp_net_dep_usd_30m += event.signedUsd;
  }
  for (const key of Object.keys(summary)) {
    summary[key] = Number(summary[key].toFixed(6));
  }
  return summary;
}

export function createPoolLiquidityFlowProvider({
  connection = null,
  rpcUrl = process.env.RPC_URL,
  walletAddress = null,
  signatureLimit = DEFAULT_SIGNATURE_LIMIT,
  maxWindowMs = DEFAULT_MAX_WINDOW_MS,
  baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  decodeCache = null,
  now = () => new Date(),
  logger = () => {},
} = {}) {
  const stateByPool = new Map();
  const selfWallet = inferWalletAddress(walletAddress);
  const cache = decodeCache || createMeteoraTxDecodeCache({ connection, rpcUrl, signatureLimit });
  const getConnection = () => connection || new Connection(rpcUrl, "confirmed");

  async function fetchTransactions(pool, poolState, nowMs) {
    if (poolState.backoffUntilMs && nowMs < poolState.backoffUntilMs) {
      return { status: "helius_tx_decode_ratelimit", decodedEvents: [] };
    }

    const decodedEvents = await cache.fetchDecodedPoolTransactions(pool, { observedAtMs: nowMs });
    return { status: "helius_tx_decode", decodedEvents };
  }

  return async function getPoolLiquidityFlow(telemetryContext = {}) {
    const pool = telemetryContext.pool;
    const nowMs = asNumber(telemetryContext.observedAtMs) ?? now().getTime();
    if (!pool) {
      return { ...summarizeEvents([], nowMs), whale_escape_data_source: "helius_tx_decode_error" };
    }
    const poolState = stateByPool.get(pool) || {
      events: [],
      seenSignatures: new Set(),
      lastSeenSignature: null,
      backoffMs: baseBackoffMs,
      backoffUntilMs: 0,
    };
    stateByPool.set(pool, poolState);

    try {
      const { status, decodedEvents } = await fetchTransactions(pool, poolState, nowMs);
      for (const event of decodedEvents) {
        if (event.type !== "lp") continue;
        if (selfWallet && Array.isArray(event.signers) && event.signers.includes(selfWallet)) continue;
        const classified = {
          name: event.instruction,
          type: event.lpAction,
          amountUsd: event.amountUsd,
          data: event.data,
          amountRaw: event.amountRaw,
        };
        const amountUsd = estimateInstructionUsd(classified, telemetryContext);
        poolState.events.push({
          signature: event.signature,
          instruction: classified.name,
          type: classified.type,
          amountUsd,
          signedUsd: classified.type === "remove" ? -amountUsd : amountUsd,
          timestampMs: event.timestampMs ?? nowMs,
        });
      }
      poolState.events = poolState.events.filter((event) => nowMs - event.timestampMs <= maxWindowMs);
      poolState.backoffMs = baseBackoffMs;
      poolState.backoffUntilMs = 0;
      const summary = summarizeEvents(poolState.events, nowMs);
      return {
        ...summary,
        whale_escape_data_source: status,
      };
    } catch (error) {
      if (isRateLimitError(error)) {
        const jitter = Math.floor(Math.random() * 250);
        poolState.backoffUntilMs = nowMs + Math.min(poolState.backoffMs, maxBackoffMs) + jitter;
        poolState.backoffMs = Math.min(poolState.backoffMs * 2, maxBackoffMs);
        logger("lptele_provider_warn", `Whale Escape TX decode rate-limited for ${pool.slice(0, 8)}: ${error.message}`);
        return {
          ...summarizeEvents(poolState.events, nowMs),
          whale_escape_data_source: "helius_tx_decode_ratelimit",
        };
      }
      logger("lptele_provider_warn", `Whale Escape TX decode failed for ${pool.slice(0, 8)}: ${error.message}`);
      return {
        ...summarizeEvents(poolState.events, nowMs),
        whale_escape_data_source: "helius_tx_decode_error",
      };
    }
  };
}

export function encodeAnchorTestInstruction(name, ...u64Values) {
  const discriminator = Buffer.from(anchorDiscriminator(name), "hex");
  const values = u64Values.map((value) => {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(BigInt(value));
    return buffer;
  });
  return bs58.encode(Buffer.concat([discriminator, ...values]));
}
