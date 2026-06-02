#!/usr/bin/env node
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  appendJsonl,
  summarizePositions,
  summarizeResidualTokens,
} from "../sol-equity-tracker.js";
import {
  buildSolPnlVerification,
  loadVerificationInputs,
  summarizeCloseActions,
} from "../sol-pnl-verifier.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function snapshot(patch = {}) {
  return {
    ts: patch.ts || "2026-05-17T00:00:00.000Z",
    event: "sol_balance_snapshot",
    bot: "meridian-oracle-scout",
    wallet: "wallet-proof",
    freeSol: 10,
    openPositionCount: 0,
    openPositionValueSol: 0,
    openPositionUnrealizedPnlSol: 0,
    openPositionUnrealizedPnlPctWeighted: null,
    residualTokenValueSol: 0,
    unresolvedResidualTokenValueSol: 0,
    estimatedEquitySol: 10,
    baselineEquitySol: 10,
    externalFlowSol: 0,
    ownerAdjustedPnlSol: 0,
    ownerAdjustedPnlPct: 0,
    openPositions: [],
    dataQuality: {
      freeSolSource: "rpc_getBalance",
      positionsSource: "Agent Meridian raw relay + fallback",
      residualTokensSource: "helius_wallet_balances",
      positionValueCompleteness: "complete",
      warnings: [],
    },
    ...patch,
  };
}

function closeAction(resultPatch = {}, patch = {}) {
  return {
    ts: patch.ts || "2026-05-17T00:05:00.000Z",
    tool: "close_position",
    success: true,
    args: { position_address: patch.position || "pos-proof" },
    result: {
      success: true,
      position: patch.position || "pos-proof",
      ...resultPatch,
    },
  };
}

function verifyOwnerDepositExcluded() {
  const row = snapshot({
    estimatedEquitySol: 13,
    externalFlowSol: 3,
    ownerAdjustedPnlSol: 0,
  });
  const proof = buildSolPnlVerification({
    snapshots: [row],
    windowStart: row.ts,
    windowEnd: row.ts,
  });
  assert.strictEqual(proof.ownerAdjustedPnlSol, 0, "owner deposit should be excluded from PnL");
  assert.strictEqual(proof.verdict, "verified", "clean owner-flow snapshot should verify");
  return proof;
}

function verifyFreeSolDeployDrop() {
  const first = snapshot({ ts: "2026-05-17T00:00:00.000Z", freeSol: 10, estimatedEquitySol: 10 });
  const latest = snapshot({
    ts: "2026-05-17T00:01:00.000Z",
    freeSol: 8,
    openPositionCount: 1,
    openPositionValueSol: 2,
    estimatedEquitySol: 10,
    ownerAdjustedPnlSol: 0,
    openPositions: [{ position: "pos-open", valueSol: 2, pnlSol: 0 }],
  });
  const proof = buildSolPnlVerification({
    snapshots: [first, latest],
    windowStart: first.ts,
    windowEnd: latest.ts,
  });
  assert.strictEqual(proof.equityDeltaSol, 0, "free SOL drop offset by LP value should not be a loss");
  assert.strictEqual(proof.ownerAdjustedPnlSol, 0, "owner-adjusted PnL should stay flat");
  return proof;
}

function verifyPricedResidual() {
  const proof = buildSolPnlVerification({
    snapshots: [snapshot()],
    actionRows: [closeAction({ post_close_swap_status: "failed", residual_token_amount: 12, residual_token_value_sol: 0.08 })],
    windowStart: "2026-05-17T00:00:00.000Z",
    windowEnd: "2026-05-17T00:10:00.000Z",
  });
  assert.strictEqual(proof.verdict, "verified_with_residuals", "priced residual should be counted as equity exposure");
  assert.strictEqual(proof.residualTokenValueSol, 0.08, "priced residual value should carry into verification");
  return proof;
}

function verifyUnpricedResidual() {
  const proof = buildSolPnlVerification({
    snapshots: [snapshot()],
    actionRows: [closeAction({ post_close_swap_status: "failed", residual_token_amount: 12 })],
    windowStart: "2026-05-17T00:00:00.000Z",
    windowEnd: "2026-05-17T00:10:00.000Z",
  });
  assert.strictEqual(proof.verdict, "unresolved_residual_exposure", "unpriced residual should be unresolved");
  return proof;
}

function verifyMissingCloseEvidence() {
  const proof = buildSolPnlVerification({
    snapshots: [snapshot()],
    actionRows: [closeAction({})],
    windowStart: "2026-05-17T00:00:00.000Z",
    windowEnd: "2026-05-17T00:10:00.000Z",
  });
  assert.strictEqual(proof.verdict, "missing_close_or_swap_evidence", "close without swap/residual fields should be flagged");
  return proof;
}

function verifyPositionDisappeared() {
  const first = snapshot({
    ts: "2026-05-17T00:00:00.000Z",
    openPositionCount: 1,
    openPositionValueSol: 1,
    estimatedEquitySol: 11,
    openPositions: [{ position: "pos-vanished", valueSol: 1 }],
  });
  const latest = snapshot({ ts: "2026-05-17T00:10:00.000Z" });
  const proof = buildSolPnlVerification({
    snapshots: [first, latest],
    actionRows: [],
    windowStart: first.ts,
    windowEnd: latest.ts,
  });
  assert.strictEqual(proof.verdict, "position_disappeared_without_close_evidence", "vanished position should be flagged");
  return proof;
}

function verifyFabriqDivergence() {
  const proof = buildSolPnlVerification({
    snapshots: [snapshot({ ownerAdjustedPnlSol: 0.5 })],
    fabriqRows: [{ ts: "2026-05-17T00:05:00.000Z", fabriqPnlSol: 0.1 }],
    windowStart: "2026-05-17T00:00:00.000Z",
    windowEnd: "2026-05-17T00:10:00.000Z",
    fabriqToleranceSol: 0.02,
  });
  assert.strictEqual(proof.verdict, "fabriq_divergence", "Fabriq divergence should be explicit");
  assert.strictEqual(proof.ownerAdjustedPnlSol, 0.5, "Fabriq should not override on-chain PnL");
  return proof;
}

function verifySummaries() {
  const positionSummary = summarizePositions({
    source: "Agent Meridian raw relay + fallback",
    positions: [
      { position: "p1", total_value_usd: 1.2, pnl_usd: 0.1, pnl_pct: 8.33 },
      { position: "p2", total_value_usd: 0.8, pnl_usd: -0.05, pnl_pct: -6.25 },
    ],
  });
  assert.strictEqual(positionSummary.openPositionValueSol, 2, "position values should sum in SOL mode");
  assert.strictEqual(positionSummary.openPositionUnrealizedPnlSol, 0.05, "position PnL should sum in SOL mode");

  const residualSummary = summarizeResidualTokens({
    sol_price: 200,
    tokens: [
      { mint: "So11111111111111111111111111111111111111112", symbol: "SOL", balance: 1, usd: 200 },
      { mint: "base", symbol: "BASE", balance: 10, usd: 10 },
      { mint: "unknown", symbol: "UNK", balance: 5, usd: null },
    ],
  });
  assert.strictEqual(residualSummary.residualTokenValueSol, 0.05, "priced residual token should convert from USD to SOL");
  assert.strictEqual(residualSummary.unpricedResidualTokens.length, 1, "unpriced residual token should not be silently zeroed");

  const closeSummary = summarizeCloseActions([
    closeAction({ post_close_swap_status: "success", auto_swapped: true }, { position: "a" }),
    closeAction({ post_close_swap_status: "failed", residual_token_amount: 1, residual_token_value_sol: 0.03 }, { position: "b" }),
  ]);
  assert.strictEqual(closeSummary.successfulAutoswapCount, 1, "successful autoswap counted");
  assert.strictEqual(closeSummary.failedAutoswapCount, 1, "failed autoswap counted");
}

function verifyLogLoading() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sol-balance-tracker-proof-"));
  try {
    appendJsonl(path.join(dir, "sol-balance-snapshots-2026-05-17.jsonl"), snapshot());
    appendJsonl(path.join(dir, "actions-2026-05-17.jsonl"), closeAction({ post_close_swap_status: "success", auto_swapped: true }));
    const inputs = loadVerificationInputs({
      logDir: dir,
      windowMs: 1_800_000,
      end: new Date("2026-05-17T00:15:00.000Z"),
    });
    const proof = buildSolPnlVerification(inputs);
    assert.strictEqual(proof.verdict, "verified", "log-loaded verification should pass");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function verifySourceSafety() {
  const files = [
    "sol-equity-tracker.js",
    "sol-pnl-verifier.js",
    "scripts/run-sol-balance-tracker.js",
    "scripts/sol-balance-baseline.js",
    "scripts/report-sol-balance-tracker.js",
    "scripts/report-sol-pnl-verification.js",
    "scripts/import-fabriq-pnl-snapshot.js",
  ];
  const sources = Object.fromEntries(files.map((file) => [file, fs.readFileSync(join(ROOT, file), "utf8")]));
  const sidecarSource = `${sources["sol-equity-tracker.js"]}\n${sources["scripts/run-sol-balance-tracker.js"]}`;
  assert.match(sidecarSource, /getMyPositions/);
  assert.match(sidecarSource, /getWalletBalances/);
  assert.match(sidecarSource, /getBalance/);
  assert.doesNotMatch(sidecarSource, /from\s+["']\.\/tools\/executor|from\s+["']\.\.\/tools\/executor/);
  assert.doesNotMatch(sidecarSource, /\bexecuteTool\b|\bswapToken\b|\bdeployPosition\b|\bclosePosition\b|\bclaimPosition\b/);
  assert.doesNotMatch(sidecarSource, /\bdeploy_position\b|\bclaim_fees\b|\bswap_token\b/);
  assert.doesNotMatch(sidecarSource, /\bsendAndConfirmTransaction\b|\bVersionedTransaction\b|\bTransaction\b/);
  assert.doesNotMatch(sidecarSource, /\bpm2\b|\bchild_process\b/);
  return {
    sidecar_uses_rpc_getBalance: sidecarSource.includes("getBalance"),
    sidecar_uses_getMyPositions: sidecarSource.includes("getMyPositions"),
    sidecar_uses_getWalletBalances: sidecarSource.includes("getWalletBalances"),
    imports_executor_or_mutation_tool: false,
    sends_transactions: false,
    restarts_processes: false,
  };
}

function main() {
  const cases = {
    ownerDepositExcluded: verifyOwnerDepositExcluded().verdict,
    deployFreeSolDrop: verifyFreeSolDeployDrop().verdict,
    pricedResidual: verifyPricedResidual().verdict,
    unpricedResidual: verifyUnpricedResidual().verdict,
    missingCloseEvidence: verifyMissingCloseEvidence().verdict,
    positionDisappeared: verifyPositionDisappeared().verdict,
    fabriqDivergence: verifyFabriqDivergence().verdict,
  };
  verifySummaries();
  verifyLogLoading();
  const sourceSafety = verifySourceSafety();

  fs.writeSync(1, `${JSON.stringify({
    success: true,
    cases,
    sourceSafety,
    checks: [
      "owner deposit excluded from PnL",
      "deploy free-SOL drop is not a loss when LP value exists",
      "priced residual tokens are counted as equity exposure",
      "unpriced residual tokens emit unresolved_residual_exposure",
      "missing close autoswap/residual evidence is detected",
      "Fabriq divergence warns without overriding on-chain equity",
      "position disappearance requires close evidence",
      "sidecar source scan has no mutating tool path",
    ],
  }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
  process.exit(0);
}
