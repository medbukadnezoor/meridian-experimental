#!/usr/bin/env node
/**
 * Focused verifier for the read-only FNmf Scout threshold comparison script.
 *
 * No network calls, .env reads, PM2 commands, or bot runtime imports.
 */

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import {
  DEFAULT_CONFIG,
  buildComparison,
  loadConfig,
  parseArgs,
  run,
} from "./replay-fnmf-comparison.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, "replay-fnmf-comparison.js");

const positionsPayload = {
  generated_at_utc: "2026-05-21T00:00:00Z",
  wallet: "FNmf-test",
  normalized_positions: [
    {
      position: "pass-fee",
      status: "Close",
      input_native: 10,
      pnl_native: 0.1,
      pnl_pct_native: 1,
      fee_to_input_pct: 0.6,
      hold_hours: 0.02,
      bin_span: 70,
      exit_class: "fee_harvest",
    },
    {
      position: "hard-stop",
      status: "Close",
      input_native: 10,
      pnl_native: -1.1,
      pnl_pct_native: -11,
      fee_to_input_pct: 0.02,
      hold_hours: 0.02,
      bin_span: 70,
      exit_class: "fast_loss_or_flat_abort",
    },
    {
      position: "reject-small",
      status: "Close",
      input_native: 1,
      pnl_native: 0,
      pnl_pct_native: 0,
      fee_to_input_pct: 0,
      hold_hours: 0.002,
      bin_span: 70,
      exit_class: "no_fee_quick_exit",
    },
  ],
};

const ohlcvPayload = {
  generated_at_utc: "2026-05-21T00:01:00Z",
  wallet: "FNmf-test",
  positions: [
    {
      position: "pass-fee",
      entry_rsi14: 75,
      entry_volume_15m_vs_60m: 1.4,
      pre_entry_return_5m_pct: 28,
      ohlcv_rows_available: 12,
    },
    {
      position: "hard-stop",
      entry_rsi14: 78,
      entry_volume_15m_vs_60m: 1.2,
      pre_entry_return_5m_pct: 24,
      ohlcv_rows_available: 10,
    },
    {
      position: "reject-small",
      entry_rsi14: 40,
      entry_volume_15m_vs_60m: 0.5,
      pre_entry_return_5m_pct: -5,
      ohlcv_rows_available: 0,
    },
  ],
};

const parsed = parseArgs([
  "--positions",
  "a.json",
  "--ohlcv",
  "b.json",
  "--config",
  "c.json",
  "--output",
  "d.json",
  "--print",
]);
assert.strictEqual(path.basename(parsed.positionsPath), "a.json", "CLI parses positions path");
assert.strictEqual(path.basename(parsed.ohlcvPath), "b.json", "CLI parses OHLCV path");
assert.strictEqual(path.basename(parsed.configPath), "c.json", "CLI parses config path");
assert.strictEqual(path.basename(parsed.outputPath), "d.json", "CLI parses output path");
assert.strictEqual(parsed.print, true, "CLI parses print flag");

const comparison = buildComparison({
  positionsPayload,
  ohlcvPayload,
  config: DEFAULT_CONFIG,
});
assert.strictEqual(comparison.safety.network_calls, false, "summary marks network calls disabled");
assert.strictEqual(comparison.safety.env_reads, false, "summary marks env reads disabled");
assert.strictEqual(comparison.safety.pm2_or_bot_commands, false, "summary marks PM2/bot commands disabled");
assert.strictEqual(comparison.summary.positions_compared, 3, "all synthetic positions compared");
assert.strictEqual(comparison.summary.entry_passed, 2, "entry thresholds pass expected rows");
assert.strictEqual(comparison.summary.entry_rejected, 1, "entry thresholds reject expected rows");
assert.strictEqual(comparison.summary.exit_threshold_match_counts.fee_harvest, 1, "fee harvest threshold counted");
assert.strictEqual(comparison.summary.exit_threshold_match_counts.hard_stop_loss, 1, "hard stop threshold counted");
assert.ok(
  comparison.summary.entry_reject_reason_counts.input_below_min >= 1,
  "entry reject reasons are counted",
);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fnmf-comparison-"));
const positionsPath = path.join(tempDir, "positions.json");
const ohlcvPath = path.join(tempDir, "ohlcv.json");
const configPath = path.join(tempDir, "config.json");
const outputPath = path.join(tempDir, "summary.json");
fs.writeFileSync(positionsPath, `${JSON.stringify(positionsPayload, null, 2)}\n`);
fs.writeFileSync(ohlcvPath, `${JSON.stringify(ohlcvPayload, null, 2)}\n`);
fs.writeFileSync(configPath, `${JSON.stringify({ entry: { minInputNative: 1 } }, null, 2)}\n`);

const mergedConfig = loadConfig(configPath);
assert.strictEqual(mergedConfig.entry.minInputNative, 1, "config override replaces focused threshold");
assert.strictEqual(
  mergedConfig.exit.hardStopLossPct,
  DEFAULT_CONFIG.exit.hardStopLossPct,
  "config override preserves default thresholds not specified",
);

const runResult = run({
  positionsPath,
  ohlcvPath,
  configPath,
  outputPath,
});
assert.strictEqual(runResult.summary.positions_compared, 3, "run returns comparison summary");
assert.ok(fs.existsSync(outputPath), "run writes output JSON");

const help = spawnSync(process.execPath, [SCRIPT_PATH, "--help"], {
  cwd: path.join(__dirname, ".."),
  encoding: "utf8",
});
assert.strictEqual(help.status, 0, "--help exits successfully");
assert.ok(help.stdout.includes("No network calls"), "help documents safety boundary");
assert.ok(help.stdout.includes("--config <file>"), "help documents config override");

console.log(JSON.stringify({
  ok: true,
  checks: [
    "CLI parses input/config/output/help flags",
    "threshold comparison classifies synthetic entry and exit rows",
    "config override is optional and preserves safe defaults",
    "output JSON is written without runtime imports",
    "help text documents safety boundary",
  ],
}, null, 2));
