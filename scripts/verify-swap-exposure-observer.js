#!/usr/bin/env node
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import {
  buildSwapTrace,
  sanitizeJupiterOrder,
} from "../tools/wallet.js";
import {
  buildSwapExposureSummary,
  loadSwapExposureRows,
  observeResidualSwapExposure,
} from "../swap-exposure-observer.js";
import { buildSolPnlVerification } from "../sol-pnl-verifier.js";
import { appendJsonl } from "../sol-equity-tracker.js";

const order = {
  transaction: "base64-unsigned-transaction-should-not-persist",
  requestId: "req-1",
  quoteId: "quote-1",
  mode: "ultra",
  router: "iris",
  inputMint: "BASE",
  outputMint: "So11111111111111111111111111111111111111112",
  inAmount: "1000000",
  outAmount: "1000000000",
  inUsdValue: 100,
  outUsdValue: 98,
  priceImpact: -0.02,
  otherAmountThreshold: "950000000",
  slippageBps: 500,
  feeBps: 10,
  feeMint: "BASE",
  routePlan: [{ swapInfo: { label: "Meteora DLMM", ammKey: "amm", inputMint: "BASE", outputMint: "SOL", inAmount: "1000000", outAmount: "1000000000" }, percent: 100, bps: 10000, usdValue: 98 }],
};

const execute = {
  status: "Success",
  signature: "sig-1",
  code: 0,
  inputAmountResult: "1000000",
  outputAmountResult: "900000000",
  totalInputAmount: "1000000",
  totalOutputAmount: "900000000",
  swapEvents: [{ inputMint: "BASE", inputAmount: "1000000", outputMint: "SOL", outputAmount: "900000000" }],
};

const sanitizedOrder = sanitizeJupiterOrder(order);
assert.strictEqual(sanitizedOrder.transaction, undefined, "unsigned transaction must not be persisted");
assert.strictEqual(sanitizedOrder.requestId, "req-1");
assert.strictEqual(sanitizedOrder.priceImpactBps, -200);

const trace = buildSwapTrace({
  order,
  execute,
  requestedAt: "2026-05-22T12:00:00.000Z",
  executedAt: "2026-05-22T12:00:01.250Z",
});
assert.strictEqual(trace.actual_vs_expected_bps, -1000);
assert.strictEqual(trace.actual_vs_min_out_bps, -526.32);
assert.strictEqual(trace.price_impact_bps, -200);
assert.strictEqual(trace.quote_to_execute_ms, 1250);
assert.deepStrictEqual(trace.route_labels, ["Meteora DLMM"]);

const verification = buildSolPnlVerification({
  snapshots: [
    {
      ts: "2026-05-22T12:00:00.000Z",
      openPositions: [{ position: "pos-1" }],
      openPositionCount: 1,
      estimatedEquitySol: 10,
      residualTokenValueSol: 0,
      unresolvedResidualTokenValueSol: 0,
      dataQuality: { warnings: [] },
    },
    {
      ts: "2026-05-22T12:05:00.000Z",
      openPositions: [],
      openPositionCount: 0,
      estimatedEquitySol: 9.7,
      residualTokenValueSol: 0.3,
      unresolvedResidualTokenValueSol: 0,
      dataQuality: { warnings: [] },
    },
  ],
  actionRows: [],
});
assert.strictEqual(verification.verdict, "position_disappeared_without_close_evidence");
assert.deepStrictEqual(verification.disappearedPositions, ["pos-1"]);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-exposure-observer-"));
const quoteRows = await observeResidualSwapExposure({
  logDir: dir,
  snapshot: {
    bot: "meridian",
    wallet: "wallet",
    residualTokens: [{ mint: "BASE", symbol: "BASE", balance: 42, usd: 100, valueSol: 0.3 }],
  },
  verification,
  quoteSwap: async ({ input_mint, output_mint, amount }) => ({
    success: true,
    input_mint,
    output_mint,
    amount,
    swap_trace: buildSwapTrace({ order, requestedAt: "2026-05-22T12:05:00.000Z" }),
  }),
});
assert.strictEqual(quoteRows.length, 1);
assert.strictEqual(quoteRows[0].manual_or_external_close_suspected, true);
assert.deepStrictEqual(quoteRows[0].disappeared_positions, ["pos-1"]);
assert.strictEqual(quoteRows[0].swap_trace.execute, null);

appendJsonl(path.join(dir, "post-close-swap-trace-2026-05-22.jsonl"), {
  ts: "2026-05-22T12:06:00.000Z",
  event: "post_close_swap_trace",
  trace_source: "meridian_close_autoswap",
  post_close_swap_status: "success",
  pair: "BASE-SOL",
  swap_trace: trace,
});

const loaded = loadSwapExposureRows({ logDir: dir });
const summary = buildSwapExposureSummary(loaded);
assert.strictEqual(summary.postCloseTraceCount, 1);
assert.strictEqual(summary.residualQuoteCount, 1);
assert.strictEqual(summary.residualManualSuspectedCount, 1);
assert.strictEqual(summary.worstExecutedByValueLeakBps[0].swap_trace.value_leak_bps, -1000);

const serialized = JSON.stringify({ sanitizedOrder, trace, quoteRows, summary });
assert(!serialized.includes("base64-unsigned-transaction-should-not-persist"), "transaction bytes must not be persisted");
assert(!serialized.includes("x-api-key"), "headers must not be persisted");

console.log(JSON.stringify({
  success: true,
  checks: [
    "Jupiter order sanitizer drops transaction payload",
    "executed swap trace computes expected vs actual output deltas",
    "manual/external position disappearance is carried into observer rows",
    "quote-only residual rows never contain execute data",
    "swap exposure summary ranks leak and residual quote rows",
  ],
}, null, 2));
