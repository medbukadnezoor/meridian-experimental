#!/usr/bin/env node
/**
 * Read-only live monitor for actual main-bot rolling fast-drawdown closes.
 *
 * This script reads synced action and PnL snapshot JSONL logs only. It does
 * not import bot runtime code, call trading APIs, or change live behavior.
 */

import fs from "fs";
import path from "path";
import { resolve } from "path";
import { fileURLToPath } from "url";

export const DEFAULT_LOG_DIR = "/Users/user/Trading Project Files/DLMM/meridian-intelligence/data/vps-logs/main/logs";
export const DEFAULT_OUTPUT = "/Users/user/Trading Project Files/DLMM/meridian-intelligence/reports/latest_rolling_drawdown_live_monitor_main.md";
export const ROLLING_DRAWDOWN_REASON_PREFIX = "Rolling fast drawdown:";

export const DEFAULT_RULE = Object.freeze({
  currentPnlPctAtOrBelow: -3,
  rollingPeakPnlPctAtOrAbove: 2,
  dropFromPeakPctPointsAtLeast: 6,
  windowMinutes: 90,
});

function printUsage() {
  console.error([
    "Usage: node scripts/report-rolling-drawdown-live-monitor.js [options]",
    "",
    "Options:",
    "  --logs <dir>          directory containing actions-*.jsonl and pnl-snapshots-*.jsonl",
    "  --actions <path>      action JSONL file or directory; default --logs",
    "  --snapshots <path>    PnL snapshot JSONL file or directory; default --logs",
    "  --output <file>       write markdown report to file; default owner report path",
    "  --json                print JSON instead of markdown",
  ].join("\n"));
}

export function parseArgs(argv) {
  const options = {
    logsPath: DEFAULT_LOG_DIR,
    actionsPath: null,
    snapshotsPath: null,
    outputPath: DEFAULT_OUTPUT,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--logs" || arg === "--actions" || arg === "--snapshots" || arg === "--output") {
      const next = argv[i + 1];
      if (!next) {
        printUsage();
        throw new Error(`Missing value for ${arg}`);
      }
      if (arg === "--logs") options.logsPath = resolve(next);
      if (arg === "--actions") options.actionsPath = resolve(next);
      if (arg === "--snapshots") options.snapshotsPath = resolve(next);
      if (arg === "--output") options.outputPath = resolve(next);
      i += 1;
      continue;
    }
    printUsage();
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.actionsPath) options.actionsPath = options.logsPath;
  if (!options.snapshotsPath) options.snapshotsPath = options.logsPath;
  return options;
}

export function listMatchingFiles(inputPath, prefix) {
  if (!inputPath || !fs.existsSync(inputPath)) return [];
  const stat = fs.statSync(inputPath);
  if (stat.isFile()) return [inputPath];
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(inputPath)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".jsonl"))
    .sort()
    .map((name) => path.join(inputPath, name));
}

export function readJsonLines(files) {
  const rows = [];
  let malformedLineCount = 0;
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        rows.push({ ...JSON.parse(line), _file: file });
      } catch {
        malformedLineCount += 1;
      }
    }
  }
  return { rows, malformedLineCount };
}

function parseObject(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toMs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function minutesBetween(fromTs, toTs) {
  const fromMs = toMs(fromTs);
  const toTimeMs = toMs(toTs);
  if (fromMs == null || toTimeMs == null) return null;
  return round((toTimeMs - fromMs) / 60000, 1);
}

export function parseRollingReason(reason) {
  if (typeof reason !== "string" || !reason.includes(ROLLING_DRAWDOWN_REASON_PREFIX)) {
    return null;
  }

  const parsed = {
    currentPnlPct: null,
    peakPnlPct: null,
    dropPctPoints: null,
    windowMinutes: null,
  };

  const currentMatch = reason.match(/(?:current|PnL)\s+(-?\d+(?:\.\d+)?)%/i);
  const peakMatch = reason.match(/peak\s+(-?\d+(?:\.\d+)?)%/i);
  const dropMatch = reason.match(/drop(?:ped)?\s+(-?\d+(?:\.\d+)?)\s*(?:pp|%|percentage points?)/i);
  const windowMatch = reason.match(/(?:window|within)\s+(\d+(?:\.\d+)?)\s*m/i);

  parsed.currentPnlPct = currentMatch ? toNumber(currentMatch[1]) : null;
  parsed.peakPnlPct = peakMatch ? toNumber(peakMatch[1]) : null;
  parsed.dropPctPoints = dropMatch ? toNumber(dropMatch[1]) : null;
  parsed.windowMinutes = windowMatch ? toNumber(windowMatch[1]) : null;

  return parsed;
}

export function normalizeSnapshots(rows) {
  const byPosition = new Map();
  const skipped = {
    wrongEvent: 0,
    missingPosition: 0,
    invalidTimestamp: 0,
    invalidPnl: 0,
  };

  for (const row of rows) {
    if (row.event !== "pnl_snapshot") {
      skipped.wrongEvent += 1;
      continue;
    }
    if (!row.position) {
      skipped.missingPosition += 1;
      continue;
    }
    const tsMs = toMs(row.ts);
    if (tsMs == null) {
      skipped.invalidTimestamp += 1;
      continue;
    }
    const pnlPct = toNumber(row.pnlPct);
    if (pnlPct == null) {
      skipped.invalidPnl += 1;
      continue;
    }
    if (!byPosition.has(row.position)) byPosition.set(row.position, []);
    byPosition.get(row.position).push({
      ts: row.ts,
      tsMs,
      pnlPct,
      peakPnlPct: toNumber(row.peakPnlPct),
      poolName: row.poolName ?? null,
      pool: row.pool ?? null,
      baseMint: row.baseMint ?? null,
      inRange: typeof row.inRange === "boolean" ? row.inRange : null,
      ageMin: toNumber(row.ageMin),
      stopCandidate: typeof row.stopCandidate === "boolean" ? row.stopCandidate : null,
      file: row._file ?? null,
    });
  }

  for (const ticks of byPosition.values()) {
    ticks.sort((a, b) => a.tsMs - b.tsMs);
  }

  return { byPosition, skipped };
}

export function summarizeActions(rows) {
  const deploys = new Map();
  const closes = [];
  const closedPositions = new Set();
  const skipped = {
    liveCloseRowsWithoutPosition: 0,
    invalidLiveCloseTimestamp: 0,
    replayOnlyMentionsIgnored: 0,
  };

  for (const row of rows) {
    const result = parseObject(row.result);
    const reason = row.args?.reason ?? result.reason ?? "";

    if (
      row.tool !== "close_position"
      && typeof reason === "string"
      && reason.includes(ROLLING_DRAWDOWN_REASON_PREFIX)
    ) {
      skipped.replayOnlyMentionsIgnored += 1;
    }

    if (row.tool === "deploy_position" && row.success === true && result.success !== false) {
      const position = result.position ?? null;
      if (!position) continue;
      deploys.set(position, {
        position,
        ts: row.timestamp ?? null,
        pool: result.pool ?? row.args?.pool_address ?? null,
        poolName: result.pool_name ?? row.args?.pool_name ?? null,
        baseMint: row.args?.base_mint ?? result.base_mint ?? null,
        amountSol: toNumber(row.args?.amount_sol ?? row.args?.amount_y ?? result.amount_sol ?? result.amount_y),
      });
    }

    if (row.tool === "close_position" && row.success === true && result.success !== false) {
      const position = row.args?.position_address ?? result.position ?? null;
      if (position) closedPositions.add(position);

      if (typeof reason !== "string" || !reason.includes(ROLLING_DRAWDOWN_REASON_PREFIX)) {
        continue;
      }

      if (!position) {
        skipped.liveCloseRowsWithoutPosition += 1;
        continue;
      }
      if (row.timestamp && toMs(row.timestamp) == null) {
        skipped.invalidLiveCloseTimestamp += 1;
      }

      closes.push({
        position,
        ts: row.timestamp ?? null,
        tsMs: toMs(row.timestamp),
        reason,
        parsedReason: parseRollingReason(reason),
        finalPnlPct: toNumber(result.pnl_pct ?? result.pnlPct),
        finalPnlUsd: toNumber(result.pnl_usd ?? result.pnlUsd),
        pool: result.pool ?? null,
        poolName: result.pool_name ?? null,
        baseMint: result.base_mint ?? null,
        txs: Array.isArray(result.txs) ? result.txs : [],
        closeTxs: Array.isArray(result.close_txs) ? result.close_txs : [],
        file: row._file ?? null,
      });
    }
  }

  closes.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return { deploys, closes, closedPositions, skipped };
}

function summarizeTick(tick, closeTsMs = null) {
  if (!tick) return null;
  return {
    ts: tick.ts,
    minutesFromClose: closeTsMs == null ? null : round((tick.tsMs - closeTsMs) / 60000, 1),
    pnlPct: round(tick.pnlPct, 4),
    peakPnlPct: tick.peakPnlPct == null ? null : round(tick.peakPnlPct, 4),
    inRange: tick.inRange,
    ageMin: tick.ageMin,
  };
}

export function findNearestSnapshots(ticks, closeTsMs, beforeCount = 3, afterCount = 2) {
  if (!Array.isArray(ticks) || closeTsMs == null) {
    return { before: [], after: [] };
  }
  const before = ticks.filter((tick) => tick.tsMs <= closeTsMs).slice(-beforeCount);
  const after = ticks.filter((tick) => tick.tsMs > closeTsMs).slice(0, afterCount);
  return {
    before: before.map((tick) => summarizeTick(tick, closeTsMs)),
    after: after.map((tick) => summarizeTick(tick, closeTsMs)),
  };
}

export function computeWatchlist({ byPosition, deploys, closedPositions, generatedAtMs, rule = DEFAULT_RULE }) {
  const watchlist = [];
  const staleCutoffMs = generatedAtMs - 2 * 60 * 60 * 1000;

  for (const [position, ticks] of byPosition.entries()) {
    if (closedPositions.has(position)) continue;
    const deploy = deploys.get(position);
    const last = ticks[ticks.length - 1];
    if (!last || last.tsMs < staleCutoffMs) continue;

    const windowStart = last.tsMs - rule.windowMinutes * 60000;
    const windowTicks = ticks.filter((tick) => tick.tsMs >= windowStart && tick.tsMs <= last.tsMs);
    if (windowTicks.length < 3) continue;
    const peakTick = windowTicks.reduce((best, tick) => (
      !best || tick.pnlPct > best.pnlPct ? tick : best
    ), null);
    if (!peakTick) continue;

    const dropPctPoints = peakTick.pnlPct - last.pnlPct;
    const hasPeak = peakTick.pnlPct >= rule.rollingPeakPnlPctAtOrAbove;
    const nearCurrent = last.pnlPct <= 0;
    const nearDrop = dropPctPoints >= rule.dropFromPeakPctPointsAtLeast * 0.5;
    if (!hasPeak || !nearCurrent || !nearDrop) continue;

    watchlist.push({
      position,
      poolName: last.poolName ?? deploy?.poolName ?? position.slice(0, 8),
      pool: last.pool ?? deploy?.pool ?? null,
      lastTs: last.ts,
      lastPnlPct: round(last.pnlPct, 4),
      peakTs: peakTick.ts,
      peakPnlPct: round(peakTick.pnlPct, 4),
      dropPctPoints: round(dropPctPoints, 4),
      distanceToCurrentThresholdPp: round(last.pnlPct - rule.currentPnlPctAtOrBelow, 4),
      inRange: last.inRange,
      dataQuality: "computed from recent synced PnL snapshots only",
    });
  }

  return watchlist.sort((a, b) => b.dropPctPoints - a.dropPctPoints).slice(0, 10);
}

export function buildLiveMonitorReport({
  actionRows,
  snapshotRows,
  actionFiles = [],
  snapshotFiles = [],
  malformedActionLines = 0,
  malformedSnapshotLines = 0,
  generatedAt = new Date().toISOString(),
}) {
  const generatedAtMs = toMs(generatedAt) ?? Date.now();
  const { byPosition, skipped: skippedSnapshots } = normalizeSnapshots(snapshotRows);
  const { deploys, closes, closedPositions, skipped: skippedActions } = summarizeActions(actionRows);

  const liveCloses = closes.map((close) => {
    const ticks = byPosition.get(close.position) ?? [];
    const deploy = deploys.get(close.position) ?? null;
    const nearest = findNearestSnapshots(ticks, close.tsMs);
    return {
      ...close,
      poolName: close.poolName ?? deploy?.poolName ?? ticks[0]?.poolName ?? null,
      pool: close.pool ?? deploy?.pool ?? ticks[0]?.pool ?? null,
      baseMint: close.baseMint ?? deploy?.baseMint ?? ticks[0]?.baseMint ?? null,
      deployTs: deploy?.ts ?? null,
      amountSol: deploy?.amountSol ?? null,
      nearestSnapshots: nearest,
      snapshotCount: ticks.length,
      firstSnapshotTs: ticks[0]?.ts ?? null,
      lastSnapshotTs: ticks[ticks.length - 1]?.ts ?? null,
      minutesFromDeployToClose: deploy?.ts ? minutesBetween(deploy.ts, close.ts) : null,
      dataQualityCaveats: [
        ticks.length ? null : "No PnL snapshots found for this position in synced logs.",
        close.finalPnlPct == null ? "Final realized PnL was missing from the close action result." : null,
        close.parsedReason?.currentPnlPct == null ? "Close reason did not expose a parseable current PnL." : null,
      ].filter(Boolean),
    };
  });

  const watchlist = computeWatchlist({ byPosition, deploys, closedPositions, generatedAtMs });

  return {
    generatedAt,
    mode: "read-only live monitor; counts actual close_position actions only",
    reasonPrefix: ROLLING_DRAWDOWN_REASON_PREFIX,
    rule: DEFAULT_RULE,
    inputs: {
      actionFiles,
      snapshotFiles,
      actionRows: actionRows.length,
      snapshotRows: snapshotRows.length,
      malformedActionLines,
      malformedSnapshotLines,
    },
    dataQuality: {
      skippedActions,
      skippedSnapshots,
      note: "This monitor proves what was written to synced JSONL logs. It cannot prove an exit should have fired if the bot did not log a close action or if sync is stale.",
    },
    summary: {
      observedLiveRollingDrawdownCloses: liveCloses.length,
      closesWithFinalPnl: liveCloses.filter((close) => close.finalPnlPct != null).length,
      closesMissingSnapshots: liveCloses.filter((close) => close.snapshotCount === 0).length,
      watchlistCount: watchlist.length,
    },
    liveCloses,
    watchlist,
  };
}

function formatValue(value, suffix = "") {
  if (value == null) return "unknown";
  return `${value}${suffix}`;
}

function markdownTable(headers, rows) {
  if (!rows.length) return "_None._\n";
  const header = `| ${headers.join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map((cell) => String(cell ?? "unknown").replace(/\|/g, "\\|")).join(" | ")} |`);
  return [header, separator, ...body].join("\n") + "\n";
}

function formatSnapshotList(snaps) {
  if (!snaps.length) return "_None found._";
  return markdownTable(
    ["ts", "minutes from close", "PnL", "peak", "in range", "age"],
    snaps.map((snap) => [
      snap.ts,
      formatValue(snap.minutesFromClose, "m"),
      formatValue(snap.pnlPct, "%"),
      formatValue(snap.peakPnlPct, "%"),
      snap.inRange == null ? "unknown" : snap.inRange,
      formatValue(snap.ageMin, "m"),
    ]),
  ).trim();
}

function renderClose(close, index) {
  const parsed = close.parsedReason ?? {};
  return [
    `### ${index + 1}. ${close.poolName ?? close.position}`,
    "",
    markdownTable(
      ["Field", "Value"],
      [
        ["close timestamp", close.ts ?? "unknown"],
        ["pool", close.pool ?? "unknown"],
        ["position", close.position],
        ["deploy timestamp", close.deployTs ?? "unknown"],
        ["minutes held", formatValue(close.minutesFromDeployToClose, "m")],
        ["amount", formatValue(close.amountSol, " SOL")],
        ["final realized PnL", formatValue(close.finalPnlPct, "%")],
        ["final realized USD/native", formatValue(close.finalPnlUsd)],
        ["parsed current", formatValue(parsed.currentPnlPct, "%")],
        ["parsed peak", formatValue(parsed.peakPnlPct, "%")],
        ["parsed drop", formatValue(parsed.dropPctPoints, "pp")],
        ["parsed window", formatValue(parsed.windowMinutes, "m")],
        ["snapshot count", close.snapshotCount],
      ],
    ),
    "Close reason:",
    "",
    `> ${close.reason}`,
    "",
    "Nearest PnL snapshots before close:",
    "",
    formatSnapshotList(close.nearestSnapshots.before),
    "",
    "Nearest PnL snapshots after close:",
    "",
    formatSnapshotList(close.nearestSnapshots.after),
    "",
    "Data quality caveats:",
    "",
    close.dataQualityCaveats.length
      ? close.dataQualityCaveats.map((item) => `- ${item}`).join("\n")
      : "- None specific to this close.",
    "",
  ].join("\n");
}

export function renderMarkdown(report) {
  const { summary, inputs, dataQuality } = report;
  const headline = summary.observedLiveRollingDrawdownCloses === 0
    ? "No live rolling-drawdown closes observed yet."
    : `${summary.observedLiveRollingDrawdownCloses} live rolling-drawdown close(s) observed.`;

  return [
    "# Main Bot Rolling Fast-Drawdown Live Monitor",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Headline",
    "",
    headline,
    "",
    "## Inputs",
    "",
    markdownTable(
      ["Input", "Value"],
      [
        ["action log path(s)", inputs.actionFiles.length ? inputs.actionFiles.join("<br>") : "none found"],
        ["snapshot log path(s)", inputs.snapshotFiles.length ? inputs.snapshotFiles.join("<br>") : "none found"],
        ["action rows read", inputs.actionRows],
        ["snapshot rows read", inputs.snapshotRows],
        ["malformed action lines skipped", inputs.malformedActionLines],
        ["malformed snapshot lines skipped", inputs.malformedSnapshotLines],
      ],
    ),
    "## Summary",
    "",
    markdownTable(
      ["Question", "Answer"],
      [
        ["actual live close_position rows with Rolling fast drawdown", summary.observedLiveRollingDrawdownCloses],
        ["of those, closes with final PnL", summary.closesWithFinalPnl],
        ["of those, closes missing nearby snapshots", summary.closesMissingSnapshots],
        ["near-trigger/watchlist rows", summary.watchlistCount],
      ],
    ),
    "## Observed Live Rolling-Drawdown Closes",
    "",
    report.liveCloses.length
      ? report.liveCloses.map(renderClose).join("\n")
      : "No actual `close_position` action with a `Rolling fast drawdown:` reason was found in the synced main action logs.",
    "",
    "## Near Trigger / Watchlist",
    "",
    report.watchlist.length
      ? markdownTable(
        ["Pool/position", "Last PnL", "Recent peak", "Drop", "Distance to -3%", "Last snapshot", "In range"],
        report.watchlist.map((item) => [
          item.poolName ?? item.position,
          formatValue(item.lastPnlPct, "%"),
          `${formatValue(item.peakPnlPct, "%")} at ${item.peakTs}`,
          formatValue(item.dropPctPoints, "pp"),
          formatValue(item.distanceToCurrentThresholdPp, "pp"),
          item.lastTs,
          item.inRange == null ? "unknown" : item.inRange,
        ]),
      )
      : "No reliable near-trigger rows found from current synced PnL snapshots. This is normal when open positions are profitable, flat, closed, or when the latest synced snapshots are stale.",
    "",
    "## Data Quality",
    "",
    markdownTable(
      ["Check", "Count"],
      [
        ["replay-only rolling reason mentions ignored", dataQuality.skippedActions.replayOnlyMentionsIgnored],
        ["live rolling close rows without position skipped", dataQuality.skippedActions.liveCloseRowsWithoutPosition],
        ["live rolling close rows with invalid timestamp", dataQuality.skippedActions.invalidLiveCloseTimestamp],
        ["snapshot rows skipped: missing position", dataQuality.skippedSnapshots.missingPosition],
        ["snapshot rows skipped: invalid timestamp", dataQuality.skippedSnapshots.invalidTimestamp],
        ["snapshot rows skipped: invalid PnL", dataQuality.skippedSnapshots.invalidPnl],
      ],
    ),
    `Data quality limit: ${dataQuality.note}`,
    "",
    "## What This Proves",
    "",
    "This monitor proves whether the live bot has written an actual close action whose reason starts with `Rolling fast drawdown:` in the synced logs, and shows the nearest PnL snapshots around that close.",
    "",
    "It does not prove that the rule should or should not have fired on every market move. It cannot see missing logs, unsynced VPS data, or price moves between PnL snapshots.",
    "",
  ].join("\n");
}

export function runLiveMonitor(options) {
  const actionFiles = listMatchingFiles(options.actionsPath, "actions-");
  const snapshotFiles = listMatchingFiles(options.snapshotsPath, "pnl-snapshots-");
  const actions = readJsonLines(actionFiles);
  const snapshots = readJsonLines(snapshotFiles);
  return buildLiveMonitorReport({
    actionRows: actions.rows,
    snapshotRows: snapshots.rows,
    actionFiles,
    snapshotFiles,
    malformedActionLines: actions.malformedLineCount,
    malformedSnapshotLines: snapshots.malformedLineCount,
  });
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = runLiveMonitor(options);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    const markdown = renderMarkdown(report);
    if (options.outputPath) {
      fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
      fs.writeFileSync(options.outputPath, markdown);
      console.log(`Wrote ${options.outputPath}`);
      return;
    }
    console.log(markdown);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
