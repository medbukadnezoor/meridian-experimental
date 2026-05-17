#!/usr/bin/env node
import assert from "assert";
import { PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import bs58 from "bs58";
import {
  METEORA_DLMM_PROGRAM_ID,
  createPoolLiquidityFlowProvider,
  encodeAnchorTestInstruction,
} from "../lp-withdrawal-shadow-provider.js";

const POOL = "11111111111111111111111111111111";
const EXTERNAL_SIGNER = "8G2c5FtBcf38Zs3qfpcsUcDc318yqBQt8f6H4C4iFFFG";
const BOT_SIGNER = "9kGcTuDkhXuNZ3LDKZTHe6mi1KEvx2hp3ogroqnXAggF";

function makeTx({ signature, signer, instructionData, blockTime = 1_779_000_000 }) {
  return {
    signature,
    blockTime,
    transaction: {
      message: {
        accountKeys: [
          { pubkey: new PublicKey(METEORA_DLMM_PROGRAM_ID), signer: false },
          { pubkey: new PublicKey(signer), signer: true },
        ],
        instructions: [
          {
            programId: new PublicKey(METEORA_DLMM_PROGRAM_ID),
            data: instructionData,
          },
        ],
      },
    },
    meta: {},
  };
}

function encodeUnknownInstruction() {
  const discriminator = createHash("sha256").update("global:swap").digest().subarray(0, 8);
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(9_999_000000n);
  return bs58.encode(Buffer.concat([discriminator, amount]));
}

class FakeConnection {
  constructor(transactions, { throw429 = false } = {}) {
    this.transactions = new Map(transactions.map((tx) => [tx.signature, tx]));
    this.throw429 = throw429;
    this.signatureRequests = [];
  }

  async getSignaturesForAddress(pubkey, options) {
    this.signatureRequests.push({ pubkey: pubkey.toString(), options });
    if (this.throw429) throw new Error("429 Too Many Requests");
    return [...this.transactions.keys()].map((signature) => ({ signature }));
  }

  async getTransaction(signature) {
    return this.transactions.get(signature) || null;
  }
}

async function main() {
  const removeTx = makeTx({
    signature: "remove-sig",
    signer: EXTERNAL_SIGNER,
    instructionData: encodeAnchorTestInstruction("removeLiquidity", 1_500_000000n),
  });
  const addTx = makeTx({
    signature: "add-sig",
    signer: EXTERNAL_SIGNER,
    instructionData: encodeAnchorTestInstruction("addLiquidityByStrategy", 600_000000n),
  });
  const selfTx = makeTx({
    signature: "self-remove-sig",
    signer: BOT_SIGNER,
    instructionData: encodeAnchorTestInstruction("removeLiquidity", 9_000_000000n),
  });
  const swapTx = makeTx({
    signature: "swap-sig",
    signer: EXTERNAL_SIGNER,
    instructionData: encodeUnknownInstruction(),
  });
  const connection = new FakeConnection([removeTx, addTx, selfTx, swapTx]);
  const provider = createPoolLiquidityFlowProvider({
    connection,
    walletAddress: BOT_SIGNER,
    now: () => new Date("2026-05-16T00:00:00.000Z"),
  });
  const result = await provider({
    pool: POOL,
    observedAtMs: 1_779_000_000_000,
    tokenDecimals: 6,
    tokenPriceUsd: 1,
  });

  assert.strictEqual(result.whale_escape_data_source, "helius_tx_decode");
  assert.strictEqual(result.pool_lp_add_count_5m, 1);
  assert.strictEqual(result.pool_lp_remove_count_5m, 1);
  assert.strictEqual(result.pool_lp_net_dep_usd_5m, -900);
  assert.strictEqual(result.pool_lp_net_dep_usd_15m, -900);
  assert.strictEqual(result.pool_lp_net_dep_usd_30m, -900);
  assert.strictEqual(result.pool_lp_largest_remove_usd_5m, 1500);
  assert.strictEqual(connection.signatureRequests[0].options.limit, 50);

  const quietProvider = createPoolLiquidityFlowProvider({
    connection: new FakeConnection([]),
  });
  const quiet = await quietProvider({ pool: POOL, observedAtMs: 1_779_000_000_000 });
  assert.strictEqual(quiet.whale_escape_data_source, "helius_tx_decode");
  assert.strictEqual(quiet.pool_lp_add_count_5m, 0);
  assert.strictEqual(quiet.pool_lp_remove_count_5m, 0);
  assert.strictEqual(quiet.pool_lp_net_dep_usd_5m, 0);

  const rateLimitedProvider = createPoolLiquidityFlowProvider({
    connection: new FakeConnection([], { throw429: true }),
    now: () => new Date("2026-05-16T00:00:00.000Z"),
  });
  const rateLimited = await rateLimitedProvider({ pool: POOL, observedAtMs: 1_779_000_000_000 });
  assert.strictEqual(rateLimited.whale_escape_data_source, "helius_tx_decode_ratelimit");

  const indexSource = await import("fs").then((fs) => fs.readFileSync(new URL("../index.js", import.meta.url), "utf8"));
  const providerSource = await import("fs").then((fs) => fs.readFileSync(new URL("../lp-withdrawal-shadow-provider.js", import.meta.url), "utf8"));
  assert.match(indexSource, /createPoolLiquidityFlowProvider/);
  assert.match(indexSource, /getPoolLiquidityFlowFn:\s*poolLiquidityFlowProvider/);
  assert.doesNotMatch(indexSource, /getPoolLiquidityFlowFn:\s*null/);
  assert.match(providerSource, /createMeteoraTxDecodeCache/);

  console.log(JSON.stringify({
    success: true,
    checks: [
      "mock LP remove counted",
      "mock LP add counted",
      "bot wallet signer excluded",
      "mock swap ignored",
      "quiet pool returns zeros",
      "rate-limit source is explicit",
      "uses shared tx decode cache",
      "index wires pool liquidity provider",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
