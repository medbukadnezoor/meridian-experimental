#!/usr/bin/env node
/**
 * Synthetic checks for report-rolling-drawdown-replay.js.
 *
 * These tests use in-memory rows only. They do not import index.js, call APIs,
 * or read/write live bot state.
 */

import {
  DEFAULT_RULE,
  buildReplayReport,
  normalizeSnapshots,
  renderMarkdown,
  replayRollingDrawdown,
} from "./report-rolling-drawdown-replay.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function tick(position, minute, pnlPct, extra = {}) {
  return {
    event: "pnl_snapshot",
    position,
    ts: new Date(Date.UTC(2026, 3, 30, 0, minute, 0)).toISOString(),
    pnlPct,
    poolName: `${position}-SOL`,
    ...extra,
  };
}

function normalizeTicks(rows, position) {
  return normalizeSnapshots(rows).byPosition.get(position) ?? [];
}

function close(position, minute, pnlPct, reason = "synthetic close") {
  return {
    timestamp: new Date(Date.UTC(2026, 3, 30, 0, minute, 0)).toISOString(),
    tool: "close_position",
    args: { position_address: position, reason },
    result: { success: true, position, pnl_pct: pnlPct, pool_name: `${position}-SOL` },
    success: true,
  };
}

function run() {
  const fireRows = [
    tick("fires", 0, 0),
    tick("fires", 1, 3),
    tick("fires", 2, -2),
  ];
  const fire = replayRollingDrawdown(normalizeTicks(fireRows, "fires"), DEFAULT_RULE);
  assert(fire?.fired === true, "+3 -> -2 with 5pp drop should fire");
  assert(fire.firePnlPct === -2, "fire PnL should be the first qualifying current PnL");
  assert(fire.rollingPeakPnlPct === 3, "rolling peak should be retained");

  const noPositivePeakRows = [
    tick("nopeak", 0, -0.5),
    tick("nopeak", 1, 0.5),
    tick("nopeak", 2, -4),
  ];
  assert(replayRollingDrawdown(normalizeTicks(noPositivePeakRows, "nopeak"), DEFAULT_RULE) == null, "should not fire without a +1% peak");

  const currentNotLowEnoughRows = [
    tick("current", 0, 0),
    tick("current", 1, 3),
    tick("current", 2, -1.9),
  ];
  assert(replayRollingDrawdown(normalizeTicks(currentNotLowEnoughRows, "current"), DEFAULT_RULE) == null, "should not fire when current PnL is above -2%");

  const unorderedAndMissingRows = [
    tick("messy", 2, -2.5),
    { event: "pnl_snapshot", position: "messy", ts: "not-a-date", pnlPct: -10 },
    { event: "pnl_snapshot", position: "messy", ts: tick("x", 4, 0).ts },
    tick("messy", 0, 0),
    tick("messy", 1, 2),
  ];
  const normalized = normalizeSnapshots(unorderedAndMissingRows);
  assert(normalized.skipped.invalidTimestamp === 1, "invalid timestamp should be counted and skipped");
  assert(normalized.skipped.invalidPnl === 1, "missing PnL should be counted and skipped");
  const messy = replayRollingDrawdown(normalized.byPosition.get("messy"), DEFAULT_RULE);
  assert(messy?.fired === true, "unordered valid rows should still sort and fire");
  assert(messy.rollingPeakPnlPct === 2, "unordered rows should use chronological rolling peak");

  const stalePeakRows = [
    tick("stale", 0, 5),
    tick("stale", 91, 0),
    tick("stale", 92, -2.5),
  ];
  assert(replayRollingDrawdown(normalizeTicks(stalePeakRows, "stale"), DEFAULT_RULE) == null, "peak outside 90-minute window should not count");

  const inWindowPeakRows = [
    tick("window", 0, 0),
    tick("window", 1, 5),
    tick("window", 91, -2.5),
  ];
  const inWindow = replayRollingDrawdown(normalizeTicks(inWindowPeakRows, "window"), DEFAULT_RULE);
  assert(inWindow?.fired === true, "peak exactly inside 90-minute window should still count");
  assert(inWindow.rollingPeakPnlPct === 5, "in-window contrast should use the nearby peak");

  const report = buildReplayReport({
    snapshotRows: [...fireRows, ...noPositivePeakRows, ...currentNotLowEnoughRows],
    actionRows: [close("fires", 10, -8), close("nopeak", 10, -4), close("current", 10, 2)],
    snapshotFiles: ["synthetic-pnl.jsonl"],
    actionFiles: ["synthetic-actions.jsonl"],
    generatedAt: "2026-04-30T00:00:00.000Z",
  });
  assert(report.summary.positionsWithEnoughSnapshots === 3, "summary should count positions with enough snapshots");
  assert(report.summary.positionsWhereCandidateFired === 1, "summary should count one fired position");
  assert(report.summary.firedBeforeActualClose === 1, "summary should count fire before actual close");
  assert(report.summary.firedLosersFinalNegative === 1, "summary should classify fired final loser");

  const markdown = renderMarkdown(report);
  assert(markdown.includes("# Nanocap Rolling Fast-Drawdown Replay"), "markdown should include title");
  assert(markdown.includes("positions with enough PnL snapshots"), "markdown should include owner summary shape");
  assert(markdown.includes("This is replay evidence only"), "markdown should include evidence-only caveat");

  console.log(JSON.stringify({
    success: true,
    checks: [
      "fires on +3 -> -2 with >= 4pp drop",
      "does not fire without positive peak",
      "does not fire when current PnL is above -2%",
      "handles unordered rows and missing fields safely",
      "does not count a qualifying peak outside the 90-minute rolling window",
      "renders expected summary markdown shape",
    ],
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({ success: false, error: error.message }, null, 2));
  process.exit(1);
}
