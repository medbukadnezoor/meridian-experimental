#!/usr/bin/env node
/**
 * Read-only analyzer for logs/pnl-snapshots-YYYY-MM-DD.jsonl.
 *
 * Summarizes MAE/MFE-style trial evidence without calling trading APIs.
 */

import fs from "fs";
import path from "path";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DEFAULT_LOG_DIR = join(ROOT, "logs");
const THRESHOLDS = [-8, -10, -12, -15, -25];

function printUsage() {
  console.error("Usage: node scripts/analyze-pnl-snapshots.js [--snapshots <file-or-dir>] [--actions <file-or-dir>] [--json]");
}

function parseArgs(argv) {
  const options = {
    snapshotsPath: DEFAULT_LOG_DIR,
    actionsPath: DEFAULT_LOG_DIR,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--snapshots") {
      const next = argv[i + 1];
      if (!next) {
        printUsage();
        process.exit(1);
      }
      options.snapshotsPath = resolve(next);
      i += 1;
      continue;
    }
    if (arg === "--actions") {
      const next = argv[i + 1];
      if (!next) {
        printUsage();
        process.exit(1);
      }
      options.actionsPath = resolve(next);
      i += 1;
      continue;
    }
    printUsage();
    console.error(`Unknown argument: ${arg}`);
    process.exit(1);
  }

  return options;
}

function listMatchingFiles(inputPath, prefix) {
  if (!fs.existsSync(inputPath)) return [];
  const stat = fs.statSync(inputPath);
  if (stat.isFile()) return [inputPath];
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(inputPath)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".jsonl"))
    .sort()
    .map((name) => path.join(inputPath, name));
}

function readJsonLines(files) {
  const rows = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        rows.push({ ...JSON.parse(line), _file: file });
      } catch {
        // Skip malformed partial lines from an active writer.
      }
    }
  }
  return rows;
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function summarizeSnapshots(rows) {
  const byPosition = new Map();
  for (const row of rows) {
    if (row.event !== "pnl_snapshot" || !row.position) continue;
    if (!byPosition.has(row.position)) byPosition.set(row.position, []);
    byPosition.get(row.position).push(row);
  }

  const positions = [];
  const thresholdCounts = Object.fromEntries(THRESHOLDS.map((threshold) => [String(threshold), 0]));
  let crossedMinus8RecoveredAbove0 = 0;
  let crossedMinus8ReachedTrailingTrigger = 0;

  for (const [position, ticks] of byPosition.entries()) {
    const sorted = ticks
      .map((tick) => ({ ...tick, pnlPct: toNumber(tick.pnlPct) }))
      .filter((tick) => tick.pnlPct != null)
      .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    if (!sorted.length) continue;

    const pnlValues = sorted.map((tick) => tick.pnlPct);
    const minPnl = Math.min(...pnlValues);
    const maxPnl = Math.max(...pnlValues);
    const firstMinus8Index = sorted.findIndex((tick) => tick.pnlPct <= -8);
    const afterMinus8 = firstMinus8Index >= 0 ? sorted.slice(firstMinus8Index + 1) : [];
    const recoveredAbove0 = afterMinus8.some((tick) => tick.pnlPct > 0);
    const reachedTrailingTrigger = afterMinus8.some((tick) => tick.pnlPct >= 8);

    for (const threshold of THRESHOLDS) {
      if (minPnl <= threshold) thresholdCounts[String(threshold)] += 1;
    }
    if (firstMinus8Index >= 0 && recoveredAbove0) crossedMinus8RecoveredAbove0 += 1;
    if (firstMinus8Index >= 0 && reachedTrailingTrigger) crossedMinus8ReachedTrailingTrigger += 1;

    positions.push({
      position,
      poolName: sorted[0].poolName ?? null,
      pool: sorted[0].pool ?? null,
      baseMint: sorted[0].baseMint ?? null,
      tickCount: sorted.length,
      firstTs: sorted[0].ts,
      lastTs: sorted[sorted.length - 1].ts,
      minPnlPct: Number(minPnl.toFixed(4)),
      maxPnlPct: Number(maxPnl.toFixed(4)),
      crossed: Object.fromEntries(THRESHOLDS.map((threshold) => [String(threshold), minPnl <= threshold])),
      crossedMinus8RecoveredAbove0: recoveredAbove0,
      crossedMinus8ReachedTrailingTrigger: reachedTrailingTrigger,
    });
  }

  positions.sort((a, b) => a.minPnlPct - b.minPnlPct);

  return {
    positionCount: positions.length,
    thresholdCounts,
    crossedMinus8RecoveredAbove0,
    crossedMinus8ReachedTrailingTrigger,
    positions,
  };
}

function summarizeActions(rows) {
  const byPosition = new Map();
  const reasonCounts = {};

  for (const row of rows) {
    if (row.tool !== "close_position") continue;
    const position = row.args?.position_address ?? row.result?.position ?? null;
    const reason = row.args?.reason ?? row.result?.reason ?? "unknown";
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    if (position) {
      byPosition.set(position, {
        ts: row.timestamp ?? null,
        reason,
        success: row.success ?? row.result?.success ?? null,
        pnlPct: toNumber(row.result?.pnl_pct),
      });
    }
  }

  return {
    closeCount: byPosition.size,
    reasonCounts,
    byPosition: Object.fromEntries(byPosition.entries()),
  };
}

function buildReport(snapshotFiles, actionFiles, snapshotRows, actionRows) {
  const snapshotSummary = summarizeSnapshots(snapshotRows);
  const actionSummary = summarizeActions(actionRows);

  const positions = snapshotSummary.positions.map((position) => ({
    ...position,
    exit: actionSummary.byPosition[position.position] ?? null,
  }));

  return {
    generatedAt: new Date().toISOString(),
    snapshotFiles,
    actionFiles,
    snapshotRows: snapshotRows.length,
    actionRows: actionRows.length,
    positionsObserved: snapshotSummary.positionCount,
    thresholdCounts: snapshotSummary.thresholdCounts,
    crossedMinus8RecoveredAbove0: snapshotSummary.crossedMinus8RecoveredAbove0,
    crossedMinus8ReachedTrailingTrigger: snapshotSummary.crossedMinus8ReachedTrailingTrigger,
    exitReasonSummary: actionSummary.reasonCounts,
    positions,
  };
}

function printText(report) {
  console.log("\n-- Nanocap PnL Snapshot Analysis -------------------------------\n");
  console.log(`Snapshot files: ${report.snapshotFiles.length}`);
  console.log(`Snapshot rows: ${report.snapshotRows}`);
  console.log(`Positions observed: ${report.positionsObserved}`);
  console.log("");
  console.log("Threshold crossings:");
  for (const threshold of THRESHOLDS) {
    console.log(`  <= ${threshold}%: ${report.thresholdCounts[String(threshold)]}`);
  }
  console.log("");
  console.log(`Crossed -8% and later recovered above 0%: ${report.crossedMinus8RecoveredAbove0}`);
  console.log(`Crossed -8% and later reached trailing trigger >= 8%: ${report.crossedMinus8ReachedTrailingTrigger}`);
  console.log("");

  if (Object.keys(report.exitReasonSummary).length) {
    console.log("Exit reason summary:");
    for (const [reason, count] of Object.entries(report.exitReasonSummary)) {
      console.log(`  ${count}x ${reason}`);
    }
    console.log("");
  }

  console.log("Per-position min/max:");
  for (const position of report.positions) {
    const label = position.poolName ?? position.position.slice(0, 8);
    const exit = position.exit?.reason ? ` | exit: ${position.exit.reason}` : "";
    console.log(`  ${label}: min ${position.minPnlPct}% | max ${position.maxPnlPct}% | ticks ${position.tickCount}${exit}`);
  }
  console.log("");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const snapshotFiles = listMatchingFiles(options.snapshotsPath, "pnl-snapshots-");
  const actionFiles = listMatchingFiles(options.actionsPath, "actions-");
  const snapshotRows = readJsonLines(snapshotFiles);
  const actionRows = readJsonLines(actionFiles);
  const report = buildReport(snapshotFiles, actionFiles, snapshotRows, actionRows);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printText(report);
}

main();
