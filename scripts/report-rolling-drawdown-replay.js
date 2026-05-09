#!/usr/bin/env node
/**
 * Read-only replay for a candidate rolling local-peak drawdown exit rule.
 *
 * This script reads synced nanocap PnL snapshot and action logs only. It does
 * not import bot runtime code, call trading APIs, or change live behavior.
 */

import fs from "fs";
import path from "path";
import { resolve } from "path";
import { fileURLToPath } from "url";

const DEFAULT_LOG_DIR = "/Users/marcelyuwono/Trading Project Files/DLMM/meridian-intelligence/data/vps-logs/nanocap/logs";
const DEFAULT_OUTPUT = "/Users/marcelyuwono/Trading Project Files/DLMM/meridian-intelligence/reports/latest_rolling_drawdown_replay_nanocap.md";

export const DEFAULT_RULE = Object.freeze({
  currentPnlPctAtOrBelow: -2,
  rollingPeakPnlPctAtOrAbove: 1,
  dropFromPeakPctPointsAtLeast: 4,
  windowMinutes: 90,
  minSnapshots: 3,
});

function printUsage() {
  console.error([
    "Usage: node scripts/report-rolling-drawdown-replay.js [options]",
    "",
    "Options:",
    "  --snapshots <file-or-dir>       PnL snapshot JSONL file or directory",
    "  --actions <file-or-dir>         action JSONL file or directory",
    "  --output <file>                 write markdown report to file",
    "  --json                          print JSON instead of markdown",
    "  --window-minutes <n|full>       rolling window in minutes; default 90",
    "  --current-threshold <pct>       default -2",
    "  --peak-threshold <pct>          default 1",
    "  --drop-threshold <pp>           default 4",
    "  --min-snapshots <n>             default 3",
  ].join("\n"));
}

export function parseArgs(argv) {
  const options = {
    snapshotsPath: DEFAULT_LOG_DIR,
    actionsPath: DEFAULT_LOG_DIR,
    outputPath: null,
    json: false,
    rule: { ...DEFAULT_RULE },
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--snapshots" || arg === "--actions" || arg === "--output") {
      const next = argv[i + 1];
      if (!next) {
        printUsage();
        throw new Error(`Missing value for ${arg}`);
      }
      if (arg === "--snapshots") options.snapshotsPath = resolve(next);
      if (arg === "--actions") options.actionsPath = resolve(next);
      if (arg === "--output") options.outputPath = resolve(next);
      i += 1;
      continue;
    }
    if (arg === "--window-minutes") {
      const next = argv[i + 1];
      if (!next) throw new Error("Missing value for --window-minutes");
      options.rule.windowMinutes = next === "full" ? null : readFiniteNumber(next, "--window-minutes");
      i += 1;
      continue;
    }
    if (arg === "--current-threshold") {
      options.rule.currentPnlPctAtOrBelow = readFiniteNumber(argv[i + 1], "--current-threshold");
      i += 1;
      continue;
    }
    if (arg === "--peak-threshold") {
      options.rule.rollingPeakPnlPctAtOrAbove = readFiniteNumber(argv[i + 1], "--peak-threshold");
      i += 1;
      continue;
    }
    if (arg === "--drop-threshold") {
      options.rule.dropFromPeakPctPointsAtLeast = readFiniteNumber(argv[i + 1], "--drop-threshold");
      i += 1;
      continue;
    }
    if (arg === "--min-snapshots") {
      options.rule.minSnapshots = readFiniteNumber(argv[i + 1], "--min-snapshots");
      i += 1;
      continue;
    }
    printUsage();
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function readFiniteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid numeric value for ${label}: ${value}`);
  return number;
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

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toMs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function parseResult(result) {
  if (result && typeof result === "object") return result;
  if (typeof result !== "string") return {};
  try {
    const parsed = JSON.parse(result);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
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

export function normalizeSnapshots(rows) {
  const skipped = {
    wrongEvent: 0,
    missingPosition: 0,
    invalidTimestamp: 0,
    invalidPnl: 0,
  };
  const byPosition = new Map();

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
      poolName: row.poolName ?? null,
      pool: row.pool ?? null,
      baseMint: row.baseMint ?? null,
      inRange: typeof row.inRange === "boolean" ? row.inRange : null,
      file: row._file ?? null,
    });
  }

  for (const ticks of byPosition.values()) {
    ticks.sort((a, b) => a.tsMs - b.tsMs);
  }

  return { byPosition, skipped };
}

export function replayRollingDrawdown(ticks, rule = DEFAULT_RULE) {
  const sorted = [...ticks]
    .filter((tick) => Number.isFinite(tick.tsMs) && Number.isFinite(tick.pnlPct))
    .sort((a, b) => a.tsMs - b.tsMs);

  if (sorted.length < rule.minSnapshots) return null;

  const windowMs = rule.windowMinutes == null ? null : rule.windowMinutes * 60000;
  const window = [];

  for (const tick of sorted) {
    window.push(tick);
    if (windowMs != null) {
      const cutoff = tick.tsMs - windowMs;
      while (window.length && window[0].tsMs < cutoff) window.shift();
    }

    const peakTick = window.reduce((best, candidate) => (
      !best || candidate.pnlPct > best.pnlPct ? candidate : best
    ), null);
    if (!peakTick) continue;

    const dropPctPoints = peakTick.pnlPct - tick.pnlPct;
    if (
      tick.pnlPct <= rule.currentPnlPctAtOrBelow
      && peakTick.pnlPct >= rule.rollingPeakPnlPctAtOrAbove
      && dropPctPoints >= rule.dropFromPeakPctPointsAtLeast
    ) {
      return {
        fired: true,
        fireTs: tick.ts,
        firePnlPct: round(tick.pnlPct, 4),
        rollingPeakTs: peakTick.ts,
        rollingPeakPnlPct: round(peakTick.pnlPct, 4),
        dropPctPoints: round(dropPctPoints, 4),
        snapshotsBeforeFire: sorted.filter((candidate) => candidate.tsMs <= tick.tsMs).length,
      };
    }
  }

  return null;
}

export function summarizeActions(rows) {
  const deploys = new Map();
  const closes = new Map();
  const skipped = {
    invalidCloseTimestamp: 0,
    invalidDeployTimestamp: 0,
    closeRowsWithoutPosition: 0,
    deployRowsWithoutPosition: 0,
  };

  for (const row of rows) {
    const result = parseResult(row.result);
    if (row.tool === "deploy_position" && row.success === true && result.success !== false) {
      const position = result.position ?? null;
      if (!position) {
        skipped.deployRowsWithoutPosition += 1;
        continue;
      }
      if (row.timestamp && toMs(row.timestamp) == null) {
        skipped.invalidDeployTimestamp += 1;
      }
      deploys.set(position, {
        position,
        ts: row.timestamp ?? null,
        pool: result.pool ?? row.args?.pool_address ?? null,
        poolName: result.pool_name ?? row.args?.pool_name ?? null,
        amountSol: toNumber(row.args?.amount_sol ?? row.args?.amount_y ?? result.amount_sol ?? result.amount_y),
      });
    }

    if (row.tool === "close_position" && row.success === true && result.success !== false) {
      const position = row.args?.position_address ?? result.position ?? null;
      if (!position) {
        skipped.closeRowsWithoutPosition += 1;
        continue;
      }
      if (row.timestamp && toMs(row.timestamp) == null) {
        skipped.invalidCloseTimestamp += 1;
      }
      closes.set(position, {
        position,
        ts: row.timestamp ?? null,
        reason: row.args?.reason ?? result.reason ?? "unknown",
        pnlPct: toNumber(result.pnl_pct ?? result.pnlPct),
        pnlUsd: toNumber(result.pnl_usd ?? result.pnlUsd),
        pool: result.pool ?? null,
        poolName: result.pool_name ?? null,
        baseMint: result.base_mint ?? null,
      });
    }
  }

  return { deploys, closes, skipped };
}

export function buildReplayReport({
  snapshotRows,
  actionRows,
  snapshotFiles = [],
  actionFiles = [],
  malformedSnapshotLines = 0,
  malformedActionLines = 0,
  rule = DEFAULT_RULE,
  generatedAt = new Date().toISOString(),
}) {
  const { byPosition, skipped: skippedSnapshots } = normalizeSnapshots(snapshotRows);
  const { deploys, closes, skipped: skippedActions } = summarizeActions(actionRows);
  const positions = [];

  for (const [position, ticks] of byPosition.entries()) {
    const first = ticks[0];
    const last = ticks[ticks.length - 1];
    const pnlValues = ticks.map((tick) => tick.pnlPct);
    const replay = replayRollingDrawdown(ticks, rule);
    const close = closes.get(position) ?? null;
    const deploy = deploys.get(position) ?? null;
    const finalPnlPct = close?.pnlPct ?? null;
    const closed = Boolean(close);
    const firedBeforeClose = Boolean(replay && close?.ts && toMs(replay.fireTs) != null && toMs(close.ts) != null && toMs(replay.fireTs) < toMs(close.ts));
    const timeGainedMinutes = firedBeforeClose ? minutesBetween(replay.fireTs, close.ts) : null;
    const fireVsFinalPp = replay && finalPnlPct != null ? round(finalPnlPct - replay.firePnlPct, 4) : null;

    positions.push({
      position,
      poolName: first.poolName ?? close?.poolName ?? deploy?.poolName ?? null,
      pool: first.pool ?? close?.pool ?? deploy?.pool ?? null,
      baseMint: first.baseMint ?? close?.baseMint ?? null,
      snapshotCount: ticks.length,
      enoughSnapshots: ticks.length >= rule.minSnapshots,
      firstSnapshotTs: first.ts,
      lastSnapshotTs: last.ts,
      deployTs: deploy?.ts ?? null,
      closeTs: close?.ts ?? null,
      closeReason: close?.reason ?? null,
      minPnlPct: round(Math.min(...pnlValues), 4),
      maxPnlPct: round(Math.max(...pnlValues), 4),
      finalPnlPct: finalPnlPct == null ? null : round(finalPnlPct, 4),
      fired: Boolean(replay),
      firedBeforeClose,
      timeGainedMinutes,
      fireVsFinalPp,
      candidate: replay,
    });
  }

  positions.sort((a, b) => {
    if (a.fired !== b.fired) return a.fired ? -1 : 1;
    return (a.finalPnlPct ?? a.minPnlPct ?? 0) - (b.finalPnlPct ?? b.minPnlPct ?? 0);
  });

  const enoughPositions = positions.filter((position) => position.enoughSnapshots);
  const firedPositions = positions.filter((position) => position.fired);
  const closedPositions = positions.filter((position) => position.closeTs);
  const firedClosedPositions = firedPositions.filter((position) => position.closeTs);
  const firedBeforeClosePositions = firedClosedPositions.filter((position) => position.firedBeforeClose);
  const firedWinnerPositions = firedClosedPositions.filter((position) => position.finalPnlPct != null && position.finalPnlPct > 0);
  const firedLoserPositions = firedClosedPositions.filter((position) => position.finalPnlPct != null && position.finalPnlPct < 0);
  const closedLosers = closedPositions.filter((position) => position.finalPnlPct != null && position.finalPnlPct < 0);
  const closedLargeLosers = closedLosers.filter((position) => position.finalPnlPct <= -8);

  const timeGainedValues = firedBeforeClosePositions
    .map((position) => position.timeGainedMinutes)
    .filter((value) => value != null);

  return {
    generatedAt,
    mode: "read-only replay evidence; not live behavior",
    parameters: {
      currentPnlPctAtOrBelow: rule.currentPnlPctAtOrBelow,
      rollingPeakPnlPctAtOrAbove: rule.rollingPeakPnlPctAtOrAbove,
      dropFromPeakPctPointsAtLeast: rule.dropFromPeakPctPointsAtLeast,
      windowMinutes: rule.windowMinutes,
      minSnapshots: rule.minSnapshots,
    },
    inputs: {
      snapshotFiles,
      actionFiles,
      snapshotRows: snapshotRows.length,
      actionRows: actionRows.length,
      malformedSnapshotLines,
      malformedActionLines,
    },
    dataQuality: {
      skippedSnapshots,
      skippedActions,
      note: "Replay only sees PnL polling snapshots that were written to synced logs. A fast move between snapshots can be missed or timestamped late.",
    },
    summary: {
      positionsWithAnyValidSnapshots: positions.length,
      positionsWithEnoughSnapshots: enoughPositions.length,
      positionsWhereCandidateFired: firedPositions.length,
      closedPositionsWithSnapshots: closedPositions.length,
      firedClosedPositions: firedClosedPositions.length,
      firedBeforeActualClose: firedBeforeClosePositions.length,
      firedWinnersFinalPositive: firedWinnerPositions.length,
      firedLosersFinalNegative: firedLoserPositions.length,
      closedLosersWithSnapshots: closedLosers.length,
      closedLargeLosersWithSnapshots: closedLargeLosers.length,
      avgTimeGainedMinutes: timeGainedValues.length
        ? round(timeGainedValues.reduce((sum, value) => sum + value, 0) / timeGainedValues.length, 1)
        : null,
      maxTimeGainedMinutes: timeGainedValues.length ? Math.max(...timeGainedValues) : null,
    },
    topCases: firedPositions
      .slice()
      .sort((a, b) => {
        const aBenefit = a.fireVsFinalPp == null ? -Infinity : -a.fireVsFinalPp;
        const bBenefit = b.fireVsFinalPp == null ? -Infinity : -b.fireVsFinalPp;
        return bBenefit - aBenefit;
      })
      .slice(0, 12),
    recentLargeLosers: closedLargeLosers
      .slice()
      .sort((a, b) => String(b.closeTs).localeCompare(String(a.closeTs)))
      .slice(0, 12),
    positions,
  };
}

function formatValue(value, suffix = "") {
  if (value == null) return "unknown";
  return `${value}${suffix}`;
}

function formatPositionRow(position) {
  const fire = position.candidate
    ? `${position.candidate.firePnlPct}% at ${position.candidate.fireTs} (peak ${position.candidate.rollingPeakPnlPct}%, drop ${position.candidate.dropPctPoints}pp)`
    : "no";
  return [
    position.poolName ?? position.position.slice(0, 8),
    position.snapshotCount,
    fire,
    formatValue(position.finalPnlPct, "%"),
    position.firedBeforeClose ? `${position.timeGainedMinutes}m` : "no/unknown",
    position.closeReason ?? "open/unknown",
  ];
}

function markdownTable(headers, rows) {
  if (!rows.length) return "_None._\n";
  const header = `| ${headers.join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map((cell) => String(cell).replace(/\|/g, "\\|")).join(" | ")} |`);
  return [header, separator, ...body].join("\n") + "\n";
}

export function renderMarkdown(report) {
  const { summary, parameters, inputs, dataQuality } = report;
  return [
    "# Nanocap Rolling Fast-Drawdown Replay",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Status",
    "",
    "This is replay evidence only. It does not change live exit behavior and is not a live rule.",
    "",
    "## Test Parameters",
    "",
    markdownTable(
      ["Parameter", "Value"],
      [
        ["current PnL <=", `${parameters.currentPnlPctAtOrBelow}%`],
        ["rolling recent peak >=", `${parameters.rollingPeakPnlPctAtOrAbove}%`],
        ["drop from peak >=", `${parameters.dropFromPeakPctPointsAtLeast} percentage points`],
        ["rolling window", parameters.windowMinutes == null ? "full position" : `${parameters.windowMinutes} minutes`],
        ["minimum valid snapshots", parameters.minSnapshots],
      ],
    ),
    "## Summary",
    "",
    markdownTable(
      ["Question", "Answer"],
      [
        ["positions with enough PnL snapshots", summary.positionsWithEnoughSnapshots],
        ["positions where candidate rule fired", summary.positionsWhereCandidateFired],
        ["closed positions with snapshots", summary.closedPositionsWithSnapshots],
        ["candidate fired before actual close", summary.firedBeforeActualClose],
        ["average time gained before close", formatValue(summary.avgTimeGainedMinutes, "m")],
        ["max time gained before close", formatValue(summary.maxTimeGainedMinutes, "m")],
        ["closed losers with snapshots", summary.closedLosersWithSnapshots],
        ["large closed losers (final <= -8%)", summary.closedLargeLosersWithSnapshots],
        ["false-positive caveat: fired on final winners", summary.firedWinnersFinalPositive],
      ],
    ),
    "## Top Candidate Cases",
    "",
    markdownTable(
      ["Pool/position", "Snapshots", "Candidate fire", "Final/API PnL", "Time gained", "Actual close reason"],
      report.topCases.map(formatPositionRow),
    ),
    "## Recent Large Losers",
    "",
    markdownTable(
      ["Pool/position", "Snapshots", "Candidate fire", "Final/API PnL", "Time gained", "Actual close reason"],
      report.recentLargeLosers.map(formatPositionRow),
    ),
    "## Data Quality",
    "",
    markdownTable(
      ["Input", "Count"],
      [
        ["snapshot files", inputs.snapshotFiles.length],
        ["action files", inputs.actionFiles.length],
        ["snapshot rows", inputs.snapshotRows],
        ["action rows", inputs.actionRows],
        ["malformed snapshot lines skipped", inputs.malformedSnapshotLines],
        ["malformed action lines skipped", inputs.malformedActionLines],
        ["snapshot rows skipped: missing position", dataQuality.skippedSnapshots.missingPosition],
        ["snapshot rows skipped: invalid timestamp", dataQuality.skippedSnapshots.invalidTimestamp],
        ["snapshot rows skipped: invalid PnL", dataQuality.skippedSnapshots.invalidPnl],
      ],
    ),
    `Data quality limit: ${dataQuality.note}`,
    "",
    "## Conclusion",
    "",
    summary.positionsWhereCandidateFired > 0
      ? "The candidate rule found replay hits worth reviewing, but promotion still requires broader replay and false-positive review before any live exit logic."
      : "The candidate rule did not fire on the current replay sample, so the synced PnL snapshots do not yet prove this rule would help.",
    "",
  ].join("\n");
}

export function runReplay(options) {
  const snapshotFiles = listMatchingFiles(options.snapshotsPath, "pnl-snapshots-");
  const actionFiles = listMatchingFiles(options.actionsPath, "actions-");
  const snapshots = readJsonLines(snapshotFiles);
  const actions = readJsonLines(actionFiles);
  return buildReplayReport({
    snapshotRows: snapshots.rows,
    actionRows: actions.rows,
    snapshotFiles,
    actionFiles,
    malformedSnapshotLines: snapshots.malformedLineCount,
    malformedActionLines: actions.malformedLineCount,
    rule: options.rule,
  });
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = runReplay(options);
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

export { DEFAULT_LOG_DIR, DEFAULT_OUTPUT };
