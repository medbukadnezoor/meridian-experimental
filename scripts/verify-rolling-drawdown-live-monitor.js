#!/usr/bin/env node
/**
 * Synthetic checks for report-rolling-drawdown-live-monitor.js.
 *
 * These tests use in-memory rows only. They do not import index.js, call APIs,
 * read credentials, or touch live bot state.
 */

import {
  buildLiveMonitorReport,
  parseRollingReason,
  renderMarkdown,
} from "./report-rolling-drawdown-live-monitor.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function ts(minute) {
  return new Date(Date.UTC(2026, 3, 30, 0, minute, 0)).toISOString();
}

function snapshot(position, minute, pnlPct, extra = {}) {
  return {
    event: "pnl_snapshot",
    ts: ts(minute),
    position,
    pnlPct,
    peakPnlPct: extra.peakPnlPct ?? null,
    poolName: extra.poolName ?? `${position}-SOL`,
    pool: extra.pool ?? `${position}-pool`,
    inRange: extra.inRange ?? true,
    ageMin: minute,
    ...extra,
  };
}

function deploy(position, minute, extra = {}) {
  return {
    timestamp: ts(minute),
    tool: "deploy_position",
    args: {
      pool_address: extra.pool ?? `${position}-pool`,
      pool_name: extra.poolName ?? `${position}-SOL`,
      amount_sol: extra.amountSol ?? 0.8,
    },
    result: {
      success: true,
      position,
      pool: extra.pool ?? `${position}-pool`,
      pool_name: extra.poolName ?? `${position}-SOL`,
    },
    success: true,
  };
}

function close(position, minute, reason, resultExtra = {}) {
  return {
    timestamp: ts(minute),
    tool: "close_position",
    args: {
      position_address: position,
      reason,
      urgent: true,
    },
    result: {
      success: true,
      position,
      pool: resultExtra.pool ?? `${position}-pool`,
      pool_name: resultExtra.poolName ?? `${position}-SOL`,
      pnl_pct: resultExtra.pnlPct,
      pnl_usd: resultExtra.pnlUsd,
      base_mint: resultExtra.baseMint ?? `${position}-mint`,
    },
    success: true,
  };
}

function build(rows = {}, generatedAt = ts(120)) {
  return buildLiveMonitorReport({
    actionRows: rows.actionRows ?? [],
    snapshotRows: rows.snapshotRows ?? [],
    actionFiles: ["synthetic-actions.jsonl"],
    snapshotFiles: ["synthetic-pnl-snapshots.jsonl"],
    generatedAt,
  });
}

function run() {
  const reason = "Rolling fast drawdown: peak 4.25% -> current -3.14% (drop 7.39pp within 90m)";
  const parsed = parseRollingReason(reason);
  assert(parsed.currentPnlPct === -3.14, "current PnL should parse from live close reason");
  assert(parsed.peakPnlPct === 4.25, "peak PnL should parse from live close reason");
  assert(parsed.dropPctPoints === 7.39, "drop percentage points should parse from live close reason");
  assert(parsed.windowMinutes === 90, "window minutes should parse from live close reason");

  const detected = build({
    actionRows: [
      deploy("live", 0, { poolName: "LIVE-SOL" }),
      close("live", 12, reason, { pnlPct: -3.4, pnlUsd: -0.02, poolName: "LIVE-SOL" }),
    ],
    snapshotRows: [
      snapshot("live", 9, 4.25, { peakPnlPct: 4.25, poolName: "LIVE-SOL" }),
      snapshot("live", 11, -2.7, { peakPnlPct: 4.25, poolName: "LIVE-SOL" }),
      snapshot("live", 12, -3.14, { peakPnlPct: 4.25, poolName: "LIVE-SOL" }),
      snapshot("live", 13, -3.6, { peakPnlPct: 4.25, poolName: "LIVE-SOL" }),
    ],
  });
  assert(detected.summary.observedLiveRollingDrawdownCloses === 1, "actual live close should be detected");
  assert(detected.liveCloses[0].poolName === "LIVE-SOL", "close should retain pool name");
  assert(detected.liveCloses[0].nearestSnapshots.before.length === 3, "nearest snapshots before close should be attached");
  assert(detected.liveCloses[0].nearestSnapshots.after.length === 1, "nearest snapshots after close should be attached");
  assert(detected.liveCloses[0].finalPnlPct === -3.4, "final PnL should be retained when present");

  const noTrigger = build({
    actionRows: [
      deploy("normal", 0),
      close("normal", 10, "Fast stop loss: PnL -11% <= -10%", { pnlPct: -11 }),
    ],
    snapshotRows: [snapshot("normal", 8, -10), snapshot("normal", 9, -11), snapshot("normal", 10, -11)],
  });
  assert(noTrigger.summary.observedLiveRollingDrawdownCloses === 0, "non-rolling close should not be counted");
  assert(renderMarkdown(noTrigger).includes("No live rolling-drawdown closes observed yet."), "no-trigger report should say zero clearly");

  const missingPnl = build({
    actionRows: [
      close("missing", 10, reason),
    ],
    snapshotRows: [
      snapshot("missing", 8, 2),
      snapshot("missing", 10, -3.5),
    ],
  });
  assert(missingPnl.summary.observedLiveRollingDrawdownCloses === 1, "close with missing final PnL should still count");
  assert(missingPnl.liveCloses[0].finalPnlPct == null, "missing final PnL should remain null");
  assert(missingPnl.liveCloses[0].dataQualityCaveats.includes("Final realized PnL was missing from the close action result."), "missing final PnL should be caveated");

  const replayOnly = build({
    actionRows: [
      {
        timestamp: ts(5),
        tool: "candidate_replay",
        args: { reason },
        result: { success: true },
        success: true,
      },
      {
        timestamp: ts(6),
        tool: "close_position",
        args: { position_address: "other", reason: "Trailing TP: peak 8% -> current 4%" },
        result: { success: true, position: "other", pnl_pct: 4 },
        success: true,
      },
    ],
    snapshotRows: [snapshot("other", 6, 4)],
  });
  assert(replayOnly.summary.observedLiveRollingDrawdownCloses === 0, "replay-only rolling text should not count as a live close");
  assert(replayOnly.dataQuality.skippedActions.replayOnlyMentionsIgnored === 1, "replay-only mention should be explicitly ignored");

  const watchlist = build({
    actionRows: [deploy("watch", 0, { poolName: "WATCH-SOL" })],
    snapshotRows: [
      snapshot("watch", 90, 3, { poolName: "WATCH-SOL" }),
      snapshot("watch", 100, 1.5, { poolName: "WATCH-SOL" }),
      snapshot("watch", 110, -0.5, { poolName: "WATCH-SOL" }),
    ],
  }, ts(111));
  assert(watchlist.summary.watchlistCount === 1, "near-trigger open position should enter watchlist when reliable");

  const markdown = renderMarkdown(detected);
  assert(markdown.includes("# Main Bot Rolling Fast-Drawdown Live Monitor"), "markdown should include title");
  assert(markdown.includes("actual close action whose reason starts with `Rolling fast drawdown:`"), "markdown should explain actual live close counting");
  assert(markdown.includes("LIVE-SOL"), "markdown should include detected close details");

  console.log(JSON.stringify({
    success: true,
    checks: [
      "detects actual close_position reason containing Rolling fast drawdown",
      "no-trigger case reports cleanly",
      "parses peak/current/drop/window from reason",
      "handles missing final PnL safely",
      "does not count replay-only candidate text as live close",
      "renders owner-readable markdown and reliable watchlist",
    ],
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({ success: false, error: error.message }, null, 2));
  process.exit(1);
}
