import {
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";
import { getSharedConnection, RPC_PRIORITY, withRpcPriority } from "./rpc.js";

let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) _connection = getSharedConnection();
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

export function getWalletPublicKey() {
  return getWallet().publicKey.toString();
}

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";
const DEFAULT_JUPITER_API_KEY = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382";
const SOL_MINT = "So11111111111111111111111111111111111111112";

function getJupiterApiKey() {
  return config.jupiter.apiKey || process.env.JUPITER_API_KEY || DEFAULT_JUPITER_API_KEY;
}

function getJupiterReferralParams() {
  const referralAccount = String(config.jupiter.referralAccount || "").trim();
  const referralFee = Number(config.jupiter.referralFeeBps || 0);
  if (!referralAccount || !Number.isFinite(referralFee) || referralFee <= 0) {
    return null;
  }
  if (referralFee < 50 || referralFee > 255) {
    log("swap_warn", `Ignoring Jupiter referral fee ${referralFee}; /swap/v2/order requires 50-255 bps`);
    return null;
  }
  try {
    new PublicKey(referralAccount);
  } catch {
    log("swap_warn", "Ignoring invalid Jupiter referral account");
    return null;
  }
  return { referralAccount, referralFee: Math.round(referralFee) };
}

function toNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundNumber(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function bpsDelta(actualRaw, expectedRaw) {
  const actual = toNumber(actualRaw);
  const expected = toNumber(expectedRaw);
  if (actual == null || expected == null || expected === 0) return null;
  return roundNumber(((actual - expected) / expected) * 10_000, 2);
}

function routeSummary(routePlan) {
  if (!Array.isArray(routePlan)) return [];
  return routePlan.map((route) => ({
    label: route?.swapInfo?.label ?? null,
    ammKey: route?.swapInfo?.ammKey ?? null,
    percent: toNumber(route?.percent),
    bps: toNumber(route?.bps),
    usdValue: toNumber(route?.usdValue),
    inputMint: route?.swapInfo?.inputMint ?? null,
    outputMint: route?.swapInfo?.outputMint ?? null,
    inAmount: route?.swapInfo?.inAmount ?? null,
    outAmount: route?.swapInfo?.outAmount ?? null,
  }));
}

export function sanitizeJupiterOrder(order = {}) {
  return {
    requestId: order.requestId ?? null,
    quoteId: order.quoteId ?? null,
    mode: order.mode ?? null,
    router: order.router ?? order.swapType ?? null,
    inputMint: order.inputMint ?? null,
    outputMint: order.outputMint ?? null,
    inAmount: order.inAmount ?? null,
    outAmount: order.outAmount ?? null,
    inUsdValue: toNumber(order.inUsdValue),
    outUsdValue: toNumber(order.outUsdValue),
    swapUsdValue: toNumber(order.swapUsdValue),
    priceImpact: toNumber(order.priceImpact),
    priceImpactBps: toNumber(order.priceImpact) != null ? roundNumber(toNumber(order.priceImpact) * 10_000, 2) : null,
    otherAmountThreshold: order.otherAmountThreshold ?? null,
    swapMode: order.swapMode ?? null,
    slippageBps: toNumber(order.slippageBps),
    feeBps: toNumber(order.feeBps),
    feeMint: order.feeMint ?? null,
    platformFee: order.platformFee ? {
      amount: order.platformFee.amount ?? null,
      feeBps: toNumber(order.platformFee.feeBps),
      feeMint: order.platformFee.feeMint ?? null,
    } : null,
    signatureFeeLamports: toNumber(order.signatureFeeLamports),
    prioritizationFeeLamports: toNumber(order.prioritizationFeeLamports),
    rentFeeLamports: toNumber(order.rentFeeLamports),
    gasless: order.gasless ?? null,
    lastValidBlockHeight: order.lastValidBlockHeight ?? null,
    totalTime: toNumber(order.totalTime),
    expireAt: order.expireAt ?? null,
    errorCode: order.errorCode ?? null,
    errorMessage: order.errorMessage ?? order.error ?? null,
    routePlan: routeSummary(order.routePlan),
  };
}

export function sanitizeJupiterExecute(result = {}) {
  return {
    status: result.status ?? null,
    signature: result.signature ?? null,
    slot: result.slot ?? null,
    code: result.code ?? null,
    error: result.error ?? null,
    totalInputAmount: result.totalInputAmount ?? null,
    totalOutputAmount: result.totalOutputAmount ?? null,
    inputAmountResult: result.inputAmountResult ?? null,
    outputAmountResult: result.outputAmountResult ?? null,
    swapEvents: Array.isArray(result.swapEvents)
      ? result.swapEvents.map((event) => ({
        inputMint: event?.inputMint ?? null,
        inputAmount: event?.inputAmount ?? null,
        outputMint: event?.outputMint ?? null,
        outputAmount: event?.outputAmount ?? null,
      }))
      : [],
  };
}

export function buildSwapTrace({ order, execute = null, requestedAt = null, executedAt = null } = {}) {
  const sanitizedOrder = sanitizeJupiterOrder(order);
  const sanitizedExecute = execute ? sanitizeJupiterExecute(execute) : null;
  const requestedMs = requestedAt ? Date.parse(requestedAt) : null;
  const executedMs = executedAt ? Date.parse(executedAt) : null;
  const expectedOutRaw = sanitizedOrder.outAmount;
  const actualOutRaw = sanitizedExecute?.outputAmountResult ?? null;
  const minOutRaw = sanitizedOrder.otherAmountThreshold;
  const actualOutputValueUsd = sanitizedExecute?.outputAmountResult != null &&
    sanitizedOrder.outAmount != null &&
    sanitizedOrder.outUsdValue != null &&
    Number(sanitizedOrder.outAmount) !== 0
    ? (Number(sanitizedExecute.outputAmountResult) / Number(sanitizedOrder.outAmount)) * sanitizedOrder.outUsdValue
    : null;
  const valueLeakUsd = sanitizedOrder.outUsdValue != null && actualOutputValueUsd != null
    ? actualOutputValueUsd - sanitizedOrder.outUsdValue
    : null;
  return {
    order_requested_at: requestedAt,
    execute_completed_at: executedAt,
    quote_to_execute_ms: requestedMs != null && executedMs != null ? executedMs - requestedMs : null,
    order: sanitizedOrder,
    execute: sanitizedExecute,
    expected_out_raw: expectedOutRaw,
    actual_out_raw: actualOutRaw,
    min_out_raw: minOutRaw,
    actual_vs_expected_bps: bpsDelta(actualOutRaw, expectedOutRaw),
    actual_vs_min_out_bps: bpsDelta(actualOutRaw, minOutRaw),
    price_impact_bps: sanitizedOrder.priceImpactBps,
    pre_swap_value_usd: sanitizedOrder.inUsdValue,
    expected_output_value_usd: sanitizedOrder.outUsdValue,
    actual_output_value_usd: actualOutputValueUsd != null ? roundNumber(actualOutputValueUsd, 6) : null,
    value_leak_usd: valueLeakUsd != null ? roundNumber(valueLeakUsd, 6) : null,
    value_leak_bps: sanitizedOrder.outUsdValue && valueLeakUsd != null ? roundNumber((valueLeakUsd / sanitizedOrder.outUsdValue) * 10_000, 2) : null,
    route_labels: sanitizedOrder.routePlan.map((route) => route.label).filter(Boolean),
    route_count: sanitizedOrder.routePlan.length,
    router: sanitizedOrder.router,
    mode: sanitizedOrder.mode,
    fee_bps_total: sanitizedOrder.feeBps,
  };
}

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using Helius Wallet API.
 * Returns USD-denominated values provided by Helius.
 */
export async function getWalletBalances() {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
  }

  const HELIUS_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) {
    log("wallet_error", "HELIUS_API_KEY not set in .env");
    return { wallet: walletAddress, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Helius API key missing" };
  }

  try {
    const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${HELIUS_KEY}`;
    const res = await fetch(url);
    
    if (!res.ok) {
      if (res.status === 429) {
        log("rpc_pressure", JSON.stringify({
          provider: "helius_wallet_api",
          lane: "fetch",
          method: "wallet_balances",
          error_bucket: "rate_limited",
        }));
      }
      throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const balances = data.balances || [];

    // ─── Find SOL and USDC ────────────────────────────────────
    const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
    const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");

    const solBalance = solEntry?.balance || 0;
    const solPrice = solEntry?.pricePerToken || 0;
    const solUsd = solEntry?.usdValue || 0;
    const usdcBalance = usdcEntry?.balance || 0;

    // ─── Map all tokens ───────────────────────────────────────
    const enrichedTokens = balances.map(b => ({
      mint: b.mint,
      symbol: b.symbol || b.mint.slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
    }));

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
    };
  } catch (error) {
    log("wallet_error", error.message);
    return {
      wallet: walletAddress,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: error.message,
    };
  }
}

/**
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
 */
// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint) {
  if (!mint) return mint;
  if (
    mint === "SOL" || 
    mint === "native" || 
    /^So1+$/.test(mint) || 
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

async function tokenDecimals(connection, inputMint) {
  if (inputMint === config.tokens.SOL || inputMint === SOL_MINT) return 9;
  const mintInfo = await withRpcPriority(
    RPC_PRIORITY.MANAGEMENT,
    "helius_rpc.wallet_token_decimals",
    () => connection.getParsedAccountInfo(new PublicKey(inputMint)),
  );
  return mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
}

async function getJupiterOrder({
  input_mint,
  output_mint,
  amount,
  taker = null,
  includeReferral = false,
}) {
  const connection = getConnection();
  const decimals = await tokenDecimals(connection, input_mint);
  const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();
  const search = new URLSearchParams({
    inputMint: input_mint,
    outputMint: output_mint,
    amount: amountStr,
  });
  if (taker) search.set("taker", taker);
  const referralParams = includeReferral ? getJupiterReferralParams() : null;
  if (referralParams) {
    search.set("referralAccount", referralParams.referralAccount);
    search.set("referralFee", String(referralParams.referralFee));
  }
  const jupiterApiKey = getJupiterApiKey();
  const requestedAt = new Date().toISOString();
  const orderRes = await fetch(`${JUPITER_SWAP_V2_API}/order?${search.toString()}`, {
    headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
  });
  if (!orderRes.ok) {
    const body = await orderRes.text();
    if (orderRes.status === 429) {
      log("rpc_pressure", JSON.stringify({
        provider: "jupiter",
        lane: "fetch",
        method: "swap_order",
        error_bucket: "rate_limited",
      }));
    }
    throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
  }
  const order = await orderRes.json();
  if (order.errorCode || order.errorMessage) {
    throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);
  }
  return { order, amountStr, requestedAt, referralParams };
}

export async function quoteSwapToken({
  input_mint,
  output_mint,
  amount,
}) {
  input_mint = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);
  try {
    const { order, requestedAt } = await getJupiterOrder({
      input_mint,
      output_mint,
      amount,
      taker: null,
      includeReferral: false,
    });
    return {
      success: true,
      input_mint,
      output_mint,
      amount,
      swap_trace: buildSwapTrace({ order, requestedAt }),
    };
  } catch (error) {
    log("swap_warn", `Quote-only swap observer failed: ${error.message}`);
    return { success: false, input_mint, output_mint, amount, error: error.message };
  }
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
}) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const { order, requestedAt, referralParams } = await getJupiterOrder({
      input_mint,
      output_mint,
      amount,
      taker: wallet.publicKey.toString(),
      includeReferral: true,
    });

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // ─── Execute ───────────────────────────────────────────────
    const jupiterApiKey = getJupiterApiKey();
    const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) {
      if (execRes.status === 429) {
        log("rpc_pressure", JSON.stringify({
          provider: "jupiter",
          lane: "fetch",
          method: "swap_execute",
          error_bucket: "rate_limited",
        }));
      }
      throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result = await execRes.json();
    const executedAt = new Date().toISOString();
    const swapTrace = buildSwapTrace({ order, execute: result, requestedAt, executedAt });
    if (result.status === "Failed") {
      return {
        success: false,
        error: `Swap failed on-chain: code=${result.code}`,
        tx: result.signature,
        input_mint,
        output_mint,
        amount_in: result.inputAmountResult,
        amount_out: result.outputAmountResult,
        swap_trace: swapTrace,
      };
    }

    log("swap", `SUCCESS tx: ${result.signature}`);
    if (referralParams && order.feeBps !== referralParams.referralFee) {
      log(
        "swap_warn",
        `Jupiter referral fee requested ${referralParams.referralFee} bps but order applied ${order.feeBps ?? "unknown"} bps`,
      );
    }

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
      referral_account: referralParams?.referralAccount || null,
      referral_fee_bps_requested: referralParams?.referralFee || 0,
      fee_bps_applied: order.feeBps ?? null,
      fee_mint: order.feeMint ?? null,
      swap_trace: swapTrace,
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}
