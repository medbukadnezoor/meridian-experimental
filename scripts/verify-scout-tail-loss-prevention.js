#!/usr/bin/env node
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import {
  buildTailLossReport,
  renderTailLossMarkdown,
  writeJsonAndMarkdown,
} from "./scout-tail-loss-lib.js";

function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scout-tail-loss-"));
  const day = "2026-05-16";
  writeJsonl(path.join(dir, `actions-${day}.jsonl`), [
    { timestamp: "2026-05-16T00:00:00.000Z", tool: "deploy_position", args: { pool_address: "poolA", pool_name: "LOSS-SOL", base_mint: "mintA" }, result: { success: true, position: "pos_loss", pool: "poolA", pool_name: "LOSS-SOL" }, success: true },
    { timestamp: "2026-05-16T00:10:00.000Z", tool: "close_position", args: { position_address: "pos_loss", reason: "hard stop" }, result: { success: true, position: "pos_loss", pool: "poolA", pool_name: "LOSS-SOL", pnl_pct: -30 }, success: true },
    { timestamp: "2026-05-16T01:00:00.000Z", tool: "deploy_position", args: { pool_address: "poolB", pool_name: "WIN-SOL", base_mint: "mintB" }, result: { success: true, position: "pos_win", pool: "poolB", pool_name: "WIN-SOL" }, success: true },
    { timestamp: "2026-05-16T01:10:00.000Z", tool: "close_position", args: { position_address: "pos_win", reason: "take profit" }, result: { success: true, position: "pos_win", pool: "poolB", pool_name: "WIN-SOL", pnl_pct: 6 }, success: true },
    { timestamp: "2026-05-16T02:00:00.000Z", tool: "deploy_position", args: { pool_address: "poolC", pool_name: "Yae-SOL", base_mint: "mintC" }, result: { success: true, position: "pos_yae_1", pool: "poolC", pool_name: "Yae-SOL" }, success: true },
    { timestamp: "2026-05-16T02:05:00.000Z", tool: "close_position", args: { position_address: "pos_yae_1", reason: "tp" }, result: { success: true, position: "pos_yae_1", pool: "poolC", pool_name: "Yae-SOL", pnl_pct: 4.2 }, success: true },
    { timestamp: "2026-05-16T02:11:00.000Z", tool: "deploy_position", args: { pool_address: "poolC", pool_name: "Yae-SOL", base_mint: "mintC" }, result: { success: true, position: "pos_yae_2", pool: "poolC", pool_name: "Yae-SOL" }, success: true },
    { timestamp: "2026-05-16T02:14:00.000Z", tool: "close_position", args: { position_address: "pos_yae_2", reason: "hard stop" }, result: { success: true, position: "pos_yae_2", pool: "poolC", pool_name: "Yae-SOL", pnl_pct: -48.26465703731661 }, success: true },
    { timestamp: "2026-05-16T03:00:00.000Z", tool: "deploy_position", args: { pool_address: "poolD", pool_name: "DUST-SOL", base_mint: "mintD" }, result: { success: true, position: "pos_dust", pool: "poolD", pool_name: "DUST-SOL" }, success: true },
    { timestamp: "2026-05-16T03:10:00.000Z", tool: "close_position", args: { position_address: "pos_dust", reason: "tp" }, result: { success: true, position: "pos_dust", pool: "poolD", pool_name: "DUST-SOL", pnl_pct: 0.2 }, success: true },
  ]);
  writeJsonl(path.join(dir, `decision-context-${day}.jsonl`), [
    { ts: "2026-05-16T00:00:01.000Z", position: "pos_loss", pool: "poolA", poolName: "LOSS-SOL", metrics: { priceChangePct: 1500 } },
    { ts: "2026-05-16T01:00:01.000Z", position: "pos_win", pool: "poolB", poolName: "WIN-SOL", metrics: { priceChangePct: 1200 } },
  ]);
  writeJsonl(path.join(dir, `ohlcv-drawdown-shadow-${day}.jsonl`), [
    { ts: "2026-05-16T00:00:30.000Z", position: "pos_loss", pool: "poolA", poolName: "LOSS-SOL", ruleId: "ohlcv_high_drawdown", ohlcv: { highDrawdownPct: -50, entryDrawdownPct: -5, source: "fixture" } },
    { ts: "2026-05-16T01:00:30.000Z", position: "pos_win", pool: "poolB", poolName: "WIN-SOL", ruleId: "ohlcv_high_drawdown", ohlcv: { highDrawdownPct: -50, entryDrawdownPct: -5, source: "fixture" } },
    { ts: "2026-05-16T02:11:30.000Z", position: "pos_yae_2", pool: "poolC", poolName: "Yae-SOL", ruleId: "ohlcv_high_drawdown", ohlcv: { highDrawdownPct: -46.3198, entryDrawdownPct: -2, source: "fixture" } },
  ]);
  writeJsonl(path.join(dir, `active-bin-oracle-${day}.jsonl`), [
    { timestamp: "2026-05-16T02:12:00.000Z", position: "pos_yae_2", pair: "Yae-SOL", pool: "poolC", active_bin: -471, lower_bin: -422, upper_bin: -405, range_side: "below_range", pnl_pct: -39.82 },
    { timestamp: "2026-05-16T03:03:00.000Z", position: "pos_dust", pair: "DUST-SOL", pool: "poolD", active_bin: -475, lower_bin: -473, upper_bin: -456, range_side: "below_range", pnl_pct: 2.69 },
  ]);
  writeJsonl(path.join(dir, `pnl-snapshots-${day}.jsonl`), [
    { timestamp: "2026-05-16T02:12:02.000Z", position: "pos_yae_2", pair: "Yae-SOL", pnl_pct: -39.82 },
    { timestamp: "2026-05-16T03:03:02.000Z", position: "pos_dust", pair: "DUST-SOL", pnl_pct: 2.69 },
  ]);
  return dir;
}

const fixture = makeFixture();
const report = buildTailLossReport({ logsDir: fixture, from: "2026-05-16", to: "2026-05-16" });
const outJson = path.join(fixture, "report.json");
const outMd = path.join(fixture, "report.md");
writeJsonAndMarkdown({ report, jsonPath: outJson, markdownPath: outMd, renderMarkdown: renderTailLossMarkdown });

const high45 = report.replay.ohlcvHighDrawdown.find((v) => v.name === "ohlcv_high_drawdown<=-45");
assert(high45, "high-drawdown replay exists");
assert(high45.avoidedLossPct > 70, "avoided-loss total is separate and positive");
assert(high45.blockedWinnerPnlPct === 6, "blocked-winner total is separate");
const same15 = report.replay.samePoolPostWinCooldown.find((v) => v.name === "same_pool_post_win<=15m");
assert(same15.blockedPositions.some((p) => p.position === "pos_yae_2"), "same-pool replay blocks Yae-style second lap");
const belowAny = report.replay.activeBinBelowRange.find((v) => v.name === "below_range_any");
assert(belowAny.blockedPositions.some((p) => p.position === "pos_dust"), "below-range counterexample is included");
assert(fs.readFileSync(outMd, "utf8").includes("Scout restart remains blocked"), "restart-block text is present");
assert(fs.readFileSync(outMd, "utf8").includes("Reconstructed 5 deploys and 5 closes"), "markdown summary counts deployTs/closeTs fields");
assert(!fs.readFileSync(new URL("../index.js", import.meta.url), "utf8").includes("report-scout-tail-loss-prevention"), "report does not require runtime index.js");

console.log(JSON.stringify({
  ok: true,
  checks: [
    "fixture has blocked loss",
    "fixture has blocked winner",
    "same-pool second-lap loss is replay-blocked",
    "below-range non-loss counterexample is included",
    "avoided-loss and blocked-winner totals are separate",
    "markdown summary counts normalized deployTs/closeTs fields",
    "runtime files are not required by report verifier",
  ],
  fixture,
}, null, 2));
