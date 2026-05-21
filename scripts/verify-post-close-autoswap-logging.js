#!/usr/bin/env node
import assert from "assert";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const executor = readFileSync(join(ROOT, "tools", "executor.js"), "utf8");

function includesAll(source, needles) {
  return needles.every((needle) => source.includes(needle));
}

const swapCallIndex = executor.indexOf("const swapResult = await swapToken");
assert(swapCallIndex > 0, "executor should call swapToken during post-close autoswap");

const successCheckIndex = executor.indexOf("swapResult?.success === true", swapCallIndex);
const autoSwappedIndex = executor.indexOf("result.auto_swapped = fields.status === \"success\"");
assert(successCheckIndex > swapCallIndex, "post-close autoswap must check swapResult.success");
assert(autoSwappedIndex > 0, "auto_swapped should be derived from post-close swap status helper");

const oldUnsafePattern = /const\s+swapResult\s*=\s*await\s+swapToken\([\s\S]{0,500}?result\.auto_swapped\s*=\s*true/;
assert(!oldUnsafePattern.test(executor), "must not set auto_swapped=true immediately after swapToken");

assert(
  includesAll(executor, [
    "POST_CLOSE_SWAP_MAX_ATTEMPTS",
    "POST_CLOSE_SWAP_RETRY_DELAY_MS",
    "finalizePostCloseAutoSwap(result)",
    "post_close_swap_status",
    "post_close_swap_error",
    "residual_base_mint",
    "residual_token_amount",
    "residual_token_usd",
    "requires_operator_attention",
    "Post-close autoswap failed after",
  ]),
  "executor should expose failed post-close swap metadata and retry configuration",
);

assert(
  includesAll(executor, [
    "status: \"failed\"",
    "requiresOperatorAttention: true",
    "residualBaseMint: result.base_mint",
    "residualTokenAmount",
    "residualTokenUsd",
  ]),
  "failed post-close autoswap path should preserve close success while surfacing residual token state",
);

assert(
  includesAll(executor, [
    "status: \"success\"",
    "result.sol_received = swapResult.amount_out",
    "result.adaptive_close.final_sol_received = fields.solReceived ?? null",
    "Base token already auto-swapped back to SOL",
  ]),
  "successful post-close autoswap path should set SOL received and success note",
);

assert(
  includesAll(executor, [
    "getResidualTokensAboveThreshold",
    "Residual non-SOL token(s)",
    "block deploy until swapped",
    "RESIDUAL_TOKEN_DEPLOY_BLOCK_USD",
  ]),
  "deploy safety check should block when residual non-SOL tokens remain above threshold",
);

assert(
  includesAll(executor, [
    "post_close_swap_status: result.post_close_swap_status",
    "post_close_swap_error: result.post_close_swap_error",
    "residual_base_mint: result.residual_base_mint",
    "requires_operator_attention: result.requires_operator_attention",
  ]),
  "action log summary should include truthful post-close swap status fields",
);

console.log(JSON.stringify({
  success: true,
  checks: [
    "swapToken failure return is gated before auto_swapped true",
    "failed post-close autoswap records explicit residual metadata",
    "successful post-close autoswap records SOL received",
    "deploy is blocked by residual non-SOL token value",
    "close action summary includes post-close swap truth fields",
  ],
}, null, 2));
