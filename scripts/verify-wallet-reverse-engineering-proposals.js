#!/usr/bin/env node
/**
 * Focused verifier for wallet reverse-engineering proposal/replay artifacts.
 */

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { runWalletReplay } from "./replay-wallet-reverse-engineering.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-re-"));
const evidenceDir = path.join(tempRoot, "meridian-intelligence/reports/wallet_reverse_engineering/Fake_1111/run");
fs.mkdirSync(evidenceDir, { recursive: true });

const positions = {
  wallet: "FakeWallet11111111111111111111111111111111111",
  normalized_positions: [
    {
      position: "p1",
      pair: "HOT-SOL",
      pool: "pool1",
      status: "close",
      input_native: 10,
      pnl_native: 1,
      pnl_pct_native: 10,
      fee_native: 0.1,
      fee_to_input_pct: 1,
      hold_hours: 0.05,
      bin_span: 70,
    },
    {
      position: "p2",
      pair: "MISS-SOL",
      pool: "pool2",
      status: "close",
      input_native: 10,
      pnl_native: -1.2,
      pnl_pct_native: -12,
      fee_native: 0,
      fee_to_input_pct: 0,
      hold_hours: 0.02,
      bin_span: 70,
    },
  ],
};
const ohlcv = {
  wallet: positions.wallet,
  positions: positions.normalized_positions.map((row, index) => ({
    ...row,
    entry_rsi14: index === 0 ? 70 : 55,
    pre_entry_return_5m_pct: 3,
    entry_volume_15m_vs_60m: 2,
    ohlcv_rows_available: 10,
  })),
};
const proposal = {
  status: "NOT_APPLIED",
  applied: false,
  target: "Oracle Scout only",
  validation_status: "valid",
  strategy_name: "fixture_hot_fee_scalp",
};

fs.writeFileSync(path.join(evidenceDir, "lpagent_historical_positions.json"), `${JSON.stringify(positions, null, 2)}\n`);
fs.writeFileSync(path.join(evidenceDir, "ohlcv_overlay.json"), `${JSON.stringify(ohlcv, null, 2)}\n`);
fs.writeFileSync(path.join(evidenceDir, "proposal.json"), `${JSON.stringify(proposal, null, 2)}\n`);

const repoEvidenceDir = path.join(REPO_ROOT, "meridian-intelligence/reports/wallet_reverse_engineering/verify_fixture/run");
fs.mkdirSync(repoEvidenceDir, { recursive: true });
for (const file of ["lpagent_historical_positions.json", "ohlcv_overlay.json", "proposal.json"]) {
  fs.copyFileSync(path.join(evidenceDir, file), path.join(repoEvidenceDir, file));
}

const summary = runWalletReplay({ evidenceDir: repoEvidenceDir });
assert.strictEqual(summary.mode, "read_only_wallet_reverse_engineering_replay_not_backtest");
assert.strictEqual(summary.safety.network_calls, false);
assert.strictEqual(summary.safety.env_reads, false);
assert.strictEqual(summary.proposal.status, "NOT_APPLIED");
assert.strictEqual(summary.proposal.target, "Oracle Scout only");
assert.strictEqual(summary.summary.positions_compared, 2);
assert.ok(fs.existsSync(path.join(repoEvidenceDir, "replay_summary.json")));

const badProposal = { ...proposal, status: "APPLIED", applied: true };
fs.writeFileSync(path.join(repoEvidenceDir, "proposal-bad.json"), `${JSON.stringify(badProposal, null, 2)}\n`);
assert.throws(
  () => runWalletReplay({ evidenceDir: repoEvidenceDir, proposalJson: path.join(repoEvidenceDir, "proposal-bad.json") }),
  /NOT_APPLIED/,
);

fs.rmSync(path.join(REPO_ROOT, "meridian-intelligence/reports/wallet_reverse_engineering/verify_fixture"), {
  recursive: true,
  force: true,
});

console.log("wallet reverse-engineering proposal verifier passed");
