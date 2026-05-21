import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import bs58 from "bs58";

export const METEORA_DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const REMOVE_INSTRUCTIONS = new Set(["removeLiquidity", "removeLiquidityByRange", "removeAllLiquidity"]);
const ADD_INSTRUCTIONS = new Set(["addLiquidity", "addLiquidityByWeight", "addLiquidityByStrategy", "addLiquidityOneSide"]);

export function anchorDiscriminator(name) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8).toString("hex");
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

function getInstructions(tx) {
  const message = tx?.transaction?.message || tx?.message || {};
  const accountKeys = getAccountKeys(tx);
  const raw = message.instructions || message.compiledInstructions || [];
  return raw.map((ix) => ({
    programId: accountKeyToString(ix.programId) || accountKeys[ix.programIdIndex] || null,
    data: decodeInstructionData(ix.data),
  }));
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

function readU64(data, offset = 8) {
  if (!Buffer.isBuffer(data) || data.length < offset + 8) return null;
  const value = Number(data.readBigUInt64LE(offset));
  return Number.isFinite(value) ? value : null;
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

function timestampMs(tx, fallbackMs) {
  return Number.isFinite(Number(tx?.blockTime)) ? Number(tx.blockTime) * 1000 : fallbackMs;
}

export function createMeteoraTxDecodeCache({
  connection = null,
  rpcUrl = process.env.RPC_URL,
  signatureLimit = 50,
} = {}) {
  const stateByPool = new Map();
  const getConnection = () => connection || new Connection(rpcUrl, "confirmed");
  const swapDiscriminators = new Map([
    [anchorDiscriminator("swap"), "swap"],
    [anchorDiscriminator("swapExactOut"), "swapExactOut"],
  ]);
  const lpDiscriminators = new Map([
    ...[...REMOVE_INSTRUCTIONS].map((name) => [anchorDiscriminator(name), { instruction: name, lpAction: "remove" }]),
    ...[...ADD_INSTRUCTIONS].map((name) => [anchorDiscriminator(name), { instruction: name, lpAction: "add" }]),
  ]);

  async function fetchDecodedPoolTransactions(pool, { observedAtMs = Date.now() } = {}) {
    const state = stateByPool.get(pool) || {
      seenSignatures: new Set(),
      lastSeenSignature: null,
    };
    stateByPool.set(pool, state);
    const conn = getConnection();
    const options = { limit: signatureLimit };
    if (state.lastSeenSignature) options.until = state.lastSeenSignature;
    const signatures = await conn.getSignaturesForAddress(new PublicKey(pool), options, "confirmed");
    const fresh = [];
    for (const info of signatures || []) {
      if (!info?.signature || state.seenSignatures.has(info.signature)) continue;
      fresh.push(info.signature);
    }
    if (signatures?.[0]?.signature) state.lastSeenSignature = signatures[0].signature;

    const decodedEvents = [];
    for (const signature of fresh.reverse()) {
      const tx = await conn.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      state.seenSignatures.add(signature);
      if (!tx) continue;
      const signers = [...getSignerSet(tx)];
      for (const ix of getInstructions(tx)) {
        if (ix.programId !== METEORA_DLMM_PROGRAM_ID || ix.data.length < 8) continue;
        const discriminator = ix.data.subarray(0, 8).toString("hex");
        const swapInstruction = swapDiscriminators.get(discriminator);
        if (swapInstruction) {
          decodedEvents.push({
            signature,
            type: "swap",
            instruction: swapInstruction,
            direction: ix.data[8] === 1 ? "sell" : "buy",
            amountRaw: readU64(ix.data, 9) ?? readU64(ix.data, 8) ?? 0,
            signers,
            timestampMs: timestampMs(tx, observedAtMs),
          });
          continue;
        }
        const lpInstruction = lpDiscriminators.get(discriminator);
        if (lpInstruction) {
          decodedEvents.push({
            signature,
            type: "lp",
            instruction: lpInstruction.instruction,
            lpAction: lpInstruction.lpAction,
            amountRaw: largestU64AfterDiscriminator(ix.data) ?? 0,
            signers,
            timestampMs: timestampMs(tx, observedAtMs),
          });
        }
      }
    }
    return decodedEvents;
  }

  return {
    fetchDecodedPoolTransactions,
  };
}
