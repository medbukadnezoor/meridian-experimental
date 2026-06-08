#!/usr/bin/env node
/**
 * Read-only daily profitability report for main fee-harvest validation.
 *
 * Reads action JSONL logs only. No trading APIs, no wallet access, no state writes.
 */

import fs from "fs";
import path from "path";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { classifyMaterialOutcome, classifyCloseReason } from "../performance-metrics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DEFAULT_LOG_DIR = join(ROOT, "logs");

function dateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function parseArgs(argv) {
  const out = {
    date: dateKey(),
    logs: DEFAULT_LOG_DIR,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      out.json = true;
    } else if (arg === "--date") {
      out.date = argv[++i];
    } else if (arg === "--logs") {
      out.logs = resolve(argv[++i]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.date)) throw new Error("--date must be YYYY-MM-DD");
  return out;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function parseResult(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function deployMap(rows) {
  const map = new Map();
  for (const row of rows) {
    if (row.tool !== "deploy_position" || row.success !== true) continue;
    const result = parseResult(row.result);
    const position = result.position ?? null;
    if (!position) continue;
    map.set(position, {
      position,
      pool: result.pool ?? row.args?.pool_address ?? null,
      pool_name: result.pool_name ?? row.args?.pool_name ?? null,
      amount_sol: num(result.amount_y ?? row.args?.amount_y ?? row.args?.amount_sol),
      strategy: result.strategy ?? row.args?.strategy ?? null,
      strategy_profile: result.strategy_profile ?? row.args?.strategy_profile ?? null,
      fee_tvl_ratio: num(row.args?.fee_tvl_ratio),
      volume_tvl_ratio: num(row.args?.volume_active_tvl_multiple),
    });
  }
  return map;
}

function closeRows(rows, deploys) {
  return rows
    .filter((row) => row.tool === "close_position")
    .map((row) => {
      const result = parseResult(row.result);
      if (row.success !== true || result.success === false) return null;
      const position = row.args?.position_address ?? result.position ?? null;
      const deploy = position ? deploys.get(position) : null;
      const pnlPct = num(result.pnl_pct ?? result.pnlPct);
      const amountSol = num(deploy?.amount_sol);
      const reason = row.args?.reason ?? result.reason ?? "unknown";
      const estimatedSolPnl = amountSol != null && pnlPct != null ? (amountSol * pnlPct) / 100 : null;
      const record = {
        timestamp: row.timestamp ?? null,
        position,
        pool: result.pool ?? deploy?.pool ?? null,
        pool_name: result.pool_name ?? deploy?.pool_name ?? null,
        strategy: deploy?.strategy ?? null,
        strategy_profile: deploy?.strategy_profile ?? null,
        exit_reason: reason,
        exit_reason_bucket: classifyCloseReason(reason),
        pnl_pct: pnlPct,
        pnl_sol: num(result.pnl_usd ?? result.pnl_sol),
        estimated_sol_pnl: round(estimatedSolPnl),
        fee_earned_sol: num(result.fees_sol ?? result.fees_usd),
        amount_sol: amountSol,
        fee_tvl_ratio: deploy?.fee_tvl_ratio ?? null,
        volume_tvl_ratio: deploy?.volume_tvl_ratio ?? null,
      };
      return { ...record, ...classifyMaterialOutcome({ ...record, close_reason: reason }) };
    })
    .filter(Boolean);
}

function grouped(records, keyFn) {
  const out = {};
  for (const record of records) {
    const key = keyFn(record) || "unknown";
    out[key] ||= {
      count: 0,
      wins: 0,
      estimated_sol_pnl: 0,
      fee_earned_sol: 0,
      avg_hold_minutes: null,
      avg_pnl_pct: 0,
    };
    const bucket = out[key];
    bucket.count += 1;
    if ((record.pnl_pct ?? 0) > 0) bucket.wins += 1;
    bucket.estimated_sol_pnl += record.estimated_sol_pnl ?? 0;
    bucket.fee_earned_sol += record.fee_earned_sol ?? 0;
    bucket.avg_pnl_pct += record.pnl_pct ?? 0;
  }
  for (const bucket of Object.values(out)) {
    bucket.win_rate_pct = bucket.count ? round((bucket.wins / bucket.count) * 100, 2) : null;
    bucket.avg_pnl_pct = bucket.count ? round(bucket.avg_pnl_pct / bucket.count, 2) : null;
    bucket.estimated_sol_pnl = round(bucket.estimated_sol_pnl);
    bucket.fee_earned_sol = round(bucket.fee_earned_sol);
  }
  return out;
}

function buildReport({ date, logs }) {
  const actionsFile = path.join(logs, `actions-${date}.jsonl`);
  const rows = readJsonl(actionsFile);
  const deploys = deployMap(rows);
  const closes = closeRows(rows, deploys);
  return {
    generatedAt: new Date().toISOString(),
    date,
    actionsFile,
    actionRows: rows.length,
    closedPositions: closes.length,
    byExitReason: grouped(closes, (record) => record.exit_reason_bucket),
    byStrategyProfile: grouped(closes, (record) => record.strategy_profile ?? record.strategy),
    closes,
  };
}

function printReport(report) {
  console.log(`Main profitability daily report: ${report.date}`);
  console.log(`Closed positions: ${report.closedPositions}`);
  console.log("");
  console.log("By exit reason:");
  for (const [reason, stats] of Object.entries(report.byExitReason)) {
    console.log(`  ${reason}: count=${stats.count} winRate=${stats.win_rate_pct ?? "n/a"}% avgPnl=${stats.avg_pnl_pct ?? "n/a"}% estSol=${stats.estimated_sol_pnl}`);
  }
  console.log("");
  console.log("By strategy profile:");
  for (const [profile, stats] of Object.entries(report.byStrategyProfile)) {
    console.log(`  ${profile}: count=${stats.count} winRate=${stats.win_rate_pct ?? "n/a"}% avgPnl=${stats.avg_pnl_pct ?? "n/a"}% estSol=${stats.estimated_sol_pnl}`);
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  const report = buildReport(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

