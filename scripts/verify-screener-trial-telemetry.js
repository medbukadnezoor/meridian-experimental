#!/usr/bin/env node
/**
 * Synthetic proof for SCREENER trial telemetry support.
 *
 * Creates local throwaway log fixtures and runs the read-only analyzer. No
 * trading modules, network calls, deploys, closes, process restarts, or config
 * edits are performed.
 */

import assert from "assert";
import fs from "fs";
import os from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { resolveConfigFromPath } from "../config-builder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ANALYZER = join(__dirname, "analyze-screener-trial.js");
const EXAMPLE_CONFIG_PATH = join(ROOT, "user-config.example.json");
const TRIAL_MODEL = resolveConfigFromPath(EXAMPLE_CONFIG_PATH, {
  env: { ...process.env },
  applyEnv: false,
}).config.llm.screeningModel;

function writeJsonl(filePath, rows) {
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function iso(msOffset) {
  return new Date(Date.now() + msOffset).toISOString();
}

function makeFixture() {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "screener-trial-telemetry-"));
  const day = new Date().toISOString().slice(0, 10);

  writeJsonl(join(dir, `api-activity-${day}.jsonl`), [
    { timestamp: iso(-3_600_000), agent_role: "SCREENER", model: TRIAL_MODEL, route_kind: "primary", reasoning_effort: null, duration_ms: 1200, status: "success", prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
    { timestamp: iso(-3_500_000), agent_role: "SCREENER", model: TRIAL_MODEL, route_kind: "primary", reasoning_effort: null, duration_ms: 2400, status: "success", prompt_tokens: 110, completion_tokens: 40, total_tokens: 150 },
    { timestamp: iso(-3_400_000), agent_role: "SCREENER", model: TRIAL_MODEL, route_kind: "primary", reasoning_effort: null, duration_ms: 5000, status: "error", error: "timeout waiting for provider" },
    { timestamp: iso(-3_300_000), agent_role: "SCREENER", model: TRIAL_MODEL, route_kind: "fallback", reasoning_effort: null, duration_ms: 900, status: "success", total_tokens: 90 },
    { timestamp: iso(-3_200_000), agent_role: "MANAGER", model: TRIAL_MODEL, route_kind: "primary", duration_ms: 800, status: "success", total_tokens: 70 },
  ]);

  writeJsonl(join(dir, `actions-${day}.jsonl`), [
    {
      timestamp: iso(-3_000_000),
      tool: "deploy_position",
      args: { pool_address: "Pool111", pool_name: "TEST/SOL", amount_sol: 1.5, bins_below: 85, bins_above: 0 },
      result: {
        success: true,
        position: "Pos111",
        pool: "Pool111",
        pool_name: "TEST/SOL",
        amount_y: 1.5,
        strategy: "bid_ask",
        bin_range: { min: 915, max: 1000, active: 1000 },
        range_coverage: { downside_pct: 34.6, upside_pct: 0, width_pct: 52.9 },
      },
      duration_ms: 1000,
      success: true,
    },
    {
      timestamp: iso(-2_900_000),
      tool: "deploy_position",
      args: { pool_address: "PoolBad", amount_sol: 1.5, bins_below: 0, bins_above: 0 },
      result: { success: false, error: "Narrow single-side SOL bid_ask deploy rejected: configured minimum 35" },
      duration_ms: 100,
      success: false,
    },
    {
      timestamp: iso(-1_500_000),
      tool: "close_position",
      args: { position_address: "Pos111", reason: "Trailing TP: fixture close" },
      result: { success: true, position: "Pos111", pool: "Pool111", pool_name: "TEST/SOL", pnl_pct: 4.2, pnl_usd: 8.4 },
      duration_ms: 200,
      success: true,
    },
  ]);

  writeJsonl(join(dir, `pnl-snapshots-${day}.jsonl`), [
    { ts: iso(-2_800_000), event: "pnl_snapshot", position: "Pos111", poolName: "TEST/SOL", pnlPct: -1.2 },
    { ts: iso(-2_000_000), event: "pnl_snapshot", position: "Pos111", poolName: "TEST/SOL", pnlPct: 6.4 },
    { ts: iso(-1_000_000), event: "pnl_snapshot", position: "Open222", poolName: "OPEN/SOL", pnlPct: 2.2 },
  ]);

  fs.writeFileSync(join(dir, `agent-${day}.log`), [
    `[${iso(-3_050_000)}] [DEPLOY_AUDIT] [range-raw] {"pool_address":"Pool111","bins_below":85,"bins_above":0,"downside_pct":null,"upside_pct":null,"active_bin":1000}`,
    `[${iso(-3_045_000)}] [DEPLOY_AUDIT] [range-normalized] {"pool_address":"Pool111","active_bin":1000,"min_bin":915,"max_bin":1000,"width_bins":85,"bins_below":85,"bins_above":0,"range_coverage":{"downside_pct":34.6,"upside_pct":0,"width_pct":52.9}}`,
    `[${iso(-2_950_000)}] [DEPLOY_REJECT] [narrow-range-guard] Narrow single-side SOL bid_ask deploy rejected: configured minimum 35 {"bins_below":0,"min_bins":35}`,
    `[${iso(-2_940_000)}] [SAFETY_BLOCK] deploy_position blocked: Max positions (3) reached. Close a position first.`,
    `[${iso(-2_930_000)}] [WARN] Repaired malformed JSON args for deploy_position`,
    `[${iso(-2_920_000)}] [AGENT] Rejected no-tool final answer (1/2) for tool-required request`,
    "",
  ].join("\n"));

  return dir;
}

function runAnalyzer(logsDir) {
  const result = spawnSync(process.execPath, [ANALYZER, "--logs", logsDir, "--user-config", EXAMPLE_CONFIG_PATH, "--hours", "48", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LOG_LEVEL: "error" },
  });

  if (result.status !== 0) {
    throw new Error(`analyze-screener-trial failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

function sourceSafetyProof() {
  const src = fs.readFileSync(ANALYZER, "utf8");
  return {
    deploys_or_closes_positions: /executeTool|getMyPositions|deployPosition|closePosition|pm2\s+restart|fetch\(/.test(src),
    changes_config: /writeFileSync\([^)]*user-config|appendFileSync|unlinkSync|rmSync/.test(src),
    reads_range_audits: src.includes("[range-raw]") && src.includes("[range-normalized]") && src.includes("[narrow-range-guard]"),
    exposes_measurement_limitations: src.includes("measurement_limitations"),
  };
}

function main() {
  const fixtureDir = makeFixture();
  const report = runAnalyzer(fixtureDir);
  const safety = sourceSafetyProof();

  assert.strictEqual(report.success, true, "analyzer succeeds");
  assert.strictEqual(report.trial_model, TRIAL_MODEL, "trial model follows config");
  assert.ok(/^deepseek-/i.test(report.trial_model), "trial model is DeepSeek");
  assert.strictEqual(report.llm.configured_primary.calls, 3, "configured primary calls counted");
  assert.strictEqual(report.llm.configured_primary.error, 1, "configured primary error counted");
  assert.strictEqual(report.llm.configured_primary.timeout_errors, 1, "timeout counted");
  assert.strictEqual(report.llm.calls_by_model_route[`${TRIAL_MODEL}|fallback`].calls, 1, "fallback route counted");
  assert.strictEqual(report.llm.json_tool_validity.repaired_malformed_json_args, 1, "JSON repair marker counted");
  assert.strictEqual(report.llm.json_tool_validity.no_tool_final_rejects, 1, "no-tool reject counted");
  assert.strictEqual(report.deploys.successes, 1, "deploy success counted");
  assert.strictEqual(report.deploys.action_rejects_or_errors, 1, "deploy reject counted");
  assert.strictEqual(report.deploys.safety_blocks_from_agent_log, 1, "safety block counted");
  assert.strictEqual(report.deploy_audits.raw_count, 1, "raw range audit counted");
  assert.strictEqual(report.deploy_audits.normalized_count, 1, "normalized range audit counted");
  assert.strictEqual(report.deploy_audits.narrow_range_reject_count, 1, "narrow reject counted");
  assert.strictEqual(report.realized_position_quality.closed_positions_opened_in_window, 1, "realized close quality counted");
  assert.strictEqual(report.realized_position_quality.realized_positions[0].material_outcome, "material_win", "material outcome classified");
  assert.ok(report.measurement_limitations.length >= 3, "measurement limitations exposed");
  assert.strictEqual(report.safe_read_only_markers.network_calls, false, "report declares no network calls");
  assert.strictEqual(safety.deploys_or_closes_positions, false, "source avoids trading/runtime calls");
  assert.strictEqual(safety.changes_config, false, "source avoids config/log mutation");
  assert.strictEqual(safety.reads_range_audits, true, "source reads deploy audit markers");
  assert.strictEqual(safety.exposes_measurement_limitations, true, "source exposes limitations");

  console.log(JSON.stringify({
    success: true,
    fixture_dir: fixtureDir,
    configured_primary: report.llm.configured_primary,
    fallback_route_calls: report.llm.calls_by_model_route[`${TRIAL_MODEL}|fallback`].calls,
    deploy_audits: report.deploy_audits,
    deploys: {
      successes: report.deploys.successes,
      action_rejects_or_errors: report.deploys.action_rejects_or_errors,
      safety_blocks_from_agent_log: report.deploys.safety_blocks_from_agent_log,
    },
    realized_position_quality: {
      closed_positions_opened_in_window: report.realized_position_quality.closed_positions_opened_in_window,
      first_material_outcome: report.realized_position_quality.realized_positions[0].material_outcome,
    },
    safe_read_only_markers: report.safe_read_only_markers,
    source_safety: safety,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ success: false, error: error.message }, null, 2));
  process.exit(1);
}
