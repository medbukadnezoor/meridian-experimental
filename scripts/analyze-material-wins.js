#!/usr/bin/env node
/**
 * Read-only analyzer for close outcomes in logs/actions-YYYY-MM-DD.jsonl.
 *
 * Uses the same raw/material/neutral classifier as runtime code. It never calls
 * trading APIs and only reads action-log files.
 */

import fs from "fs";
import path from "path";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { classifyMaterialOutcome, summarizeMaterialPerformance } from "../performance-metrics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DEFAULT_ACTION_DIR = join(ROOT, "logs");

function printUsage() {
  console.error("Usage: node scripts/analyze-material-wins.js [--actions <file-or-dir>] [--json]");
}

function parseArgs(argv) {
  const options = {
    actionsPath: DEFAULT_ACTION_DIR,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
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

function listActionFiles(inputPath) {
  if (!fs.existsSync(inputPath)) return [];
  const stat = fs.statSync(inputPath);
  if (stat.isFile()) return [inputPath];
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(inputPath)
    .filter((name) => name.startsWith("actions-") && name.endsWith(".jsonl"))
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
        // Active log writers can leave partial lines; ignore those.
      }
    }
  }
  return rows;
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
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

function buildDeployMap(rows) {
  const deploys = new Map();
  for (const row of rows) {
    if (row.tool !== "deploy_position" || row.success !== true) continue;
    const result = parseResult(row.result);
    if (result.success === false || !result.position) continue;
    const amountSol = toNumber(row.args?.amount_y ?? row.args?.amount_sol ?? result.amount_y ?? result.amount_sol);
    deploys.set(result.position, {
      position: result.position,
      pool: result.pool ?? row.args?.pool_address ?? null,
      pool_name: result.pool_name ?? row.args?.pool_name ?? null,
      amount_sol: amountSol,
      deployed_at: row.timestamp ?? null,
    });
  }
  return deploys;
}

function extractCloseRecords(rows, deploys) {
  const records = [];

  for (const row of rows) {
    if (row.tool !== "close_position") continue;
    const result = parseResult(row.result);
    const success = row.success === true && result.success !== false;
    if (!success) continue;

    const position = row.args?.position_address ?? result.position ?? null;
    const deploy = position ? deploys.get(position) : null;
    const pnlPct = toNumber(result.pnl_pct ?? result.pnlPct);
    if (pnlPct == null) continue;

    const amountSol = toNumber(deploy?.amount_sol);
    const estimatedSolPnl = amountSol != null ? (amountSol * pnlPct) / 100 : null;
    const record = {
      timestamp: row.timestamp ?? null,
      position,
      pool: result.pool ?? deploy?.pool ?? null,
      pool_name: result.pool_name ?? deploy?.pool_name ?? null,
      close_reason: row.args?.reason ?? result.reason ?? "unknown",
      pnl_pct: pnlPct,
      pnl_usd: toNumber(result.pnl_usd),
      amount_sol: amountSol,
      estimated_sol_pnl: estimatedSolPnl == null ? null : Math.round(estimatedSolPnl * 1_000_000) / 1_000_000,
    };
    records.push({ ...record, ...classifyMaterialOutcome(record) });
  }

  return records;
}

function median(values) {
  const finite = values.map(toNumber).filter((value) => value != null).sort((a, b) => a - b);
  if (!finite.length) return null;
  const mid = Math.floor(finite.length / 2);
  if (finite.length % 2 === 1) return finite[mid];
  return (finite[mid - 1] + finite[mid]) / 2;
}

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function round6(value) {
  return Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : null;
}

function summarizeByBucket(records) {
  const buckets = {};
  for (const record of records) {
    const bucket = record.close_reason_bucket || "other";
    if (!buckets[bucket]) buckets[bucket] = [];
    buckets[bucket].push(record);
  }

  return Object.fromEntries(Object.entries(buckets).map(([bucket, rows]) => {
    const pnlValues = rows.map((record) => record.pnl_pct).filter((value) => toNumber(value) != null);
    const solValues = rows.map((record) => record.estimated_sol_pnl).filter((value) => toNumber(value) != null);
    return [bucket, {
      count: rows.length,
      avg_pnl_pct: pnlValues.length ? round2(pnlValues.reduce((sum, value) => sum + value, 0) / pnlValues.length) : null,
      median_pnl_pct: round2(median(pnlValues)),
      estimated_sol_pnl: solValues.length ? round6(solValues.reduce((sum, value) => sum + value, 0)) : null,
    }];
  }));
}

function buildReport(actionFiles, actionRows) {
  const deploys = buildDeployMap(actionRows);
  const records = extractCloseRecords(actionRows, deploys);
  const materialSummary = summarizeMaterialPerformance(records);
  const totalEstimatedSolPnl = records
    .map((record) => record.estimated_sol_pnl)
    .filter((value) => toNumber(value) != null)
    .reduce((sum, value) => sum + value, 0);
  const totalDeployedSol = records
    .map((record) => record.amount_sol)
    .filter((value) => toNumber(value) != null)
    .reduce((sum, value) => sum + value, 0);
  const lowYieldCount = records.filter((record) => record.close_reason_bucket === "low_yield").length;

  const compactRecord = (record) => ({
    timestamp: record.timestamp,
    pool_name: record.pool_name,
    position: record.position,
    pnl_pct: round2(record.pnl_pct),
    estimated_sol_pnl: record.estimated_sol_pnl,
    reason: record.close_reason,
    close_reason_bucket: record.close_reason_bucket,
    material_outcome: record.material_outcome,
  });

  return {
    generatedAt: new Date().toISOString(),
    actionFiles,
    actionRows: actionRows.length,
    closeRows: records.length,
    raw_win_rate_pct: materialSummary.raw_win_rate_pct,
    material_win_rate_pct: materialSummary.material_win_rate_pct,
    material_loss_rate_pct: materialSummary.material_loss_rate_pct,
    material_decision_win_rate_pct: materialSummary.material_decision_win_rate_pct,
    material_decision_loss_rate_pct: materialSummary.material_decision_loss_rate_pct,
    neutral_rate_pct: materialSummary.neutral_rate_pct,
    material_sample_count: materialSummary.material_sample_count,
    raw_sample_count: materialSummary.raw_sample_count,
    neutral_close_count: materialSummary.neutral_count,
    low_yield_neutral_count: materialSummary.low_yield_neutral_count,
    dust_neutral_count: materialSummary.dust_neutral_count,
    operator_neutral_count: materialSummary.operator_neutral_count,
    bucket_counts: materialSummary.bucket_counts,
    bucket_stats: summarizeByBucket(records),
    estimated_sol_pnl: records.length ? round6(totalEstimatedSolPnl) : null,
    low_yield_share_pct: records.length ? round2((lowYieldCount / records.length) * 100) : null,
    material_ev_per_deployed_sol_pct: totalDeployedSol > 0 ? round2((totalEstimatedSolPnl / totalDeployedSol) * 100) : null,
    worst_stop_loss_tails: records
      .filter((record) => record.close_reason_bucket === "stop_loss" || record.close_reason_bucket === "early_dump")
      .sort((a, b) => a.pnl_pct - b.pnl_pct)
      .slice(0, 10)
      .map(compactRecord),
    top_material_wins: records
      .filter((record) => record.material_win)
      .sort((a, b) => b.pnl_pct - a.pnl_pct)
      .slice(0, 10)
      .map(compactRecord),
  };
}

function printText(report) {
  console.log("\n-- Nanocap Material Win Analysis -------------------------------\n");
  console.log(`Action files: ${report.actionFiles.length}`);
  console.log(`Closed positions analyzed: ${report.closeRows}`);
  console.log(`Raw WR: ${report.raw_win_rate_pct ?? "N/A"}%`);
  console.log(`Material WR: ${report.material_win_rate_pct ?? "N/A"}% of all closes`);
  console.log(`Material decision WR: ${report.material_decision_win_rate_pct ?? "N/A"}% over ${report.material_sample_count} material sample(s)`);
  console.log(`Neutral/dust closes: ${report.neutral_close_count} (${report.neutral_rate_pct ?? "N/A"}%)`);
  console.log(`Low-yield share of closes: ${report.low_yield_share_pct ?? "N/A"}%`);
  console.log(`Estimated SOL PnL: ${report.estimated_sol_pnl ?? "N/A"}`);
  console.log(`Material EV per deployed SOL: ${report.material_ev_per_deployed_sol_pct ?? "N/A"}%`);
  console.log("");

  console.log("Bucket stats:");
  for (const [bucket, stats] of Object.entries(report.bucket_stats)) {
    console.log(`  ${bucket}: count ${stats.count}, avg ${stats.avg_pnl_pct ?? "N/A"}%, median ${stats.median_pnl_pct ?? "N/A"}%, est SOL ${stats.estimated_sol_pnl ?? "N/A"}`);
  }
  console.log("");

  console.log("Worst stop-loss tails:");
  for (const item of report.worst_stop_loss_tails) {
    console.log(`  ${item.pool_name || item.position?.slice(0, 8)}: ${item.pnl_pct}% | ${item.reason}`);
  }
  console.log("");

  console.log("Top material wins:");
  for (const item of report.top_material_wins) {
    console.log(`  ${item.pool_name || item.position?.slice(0, 8)}: ${item.pnl_pct}% | ${item.reason}`);
  }
  console.log("");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const actionFiles = listActionFiles(options.actionsPath);
  const actionRows = readJsonLines(actionFiles);
  const report = buildReport(actionFiles, actionRows);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printText(report);
}

main();
