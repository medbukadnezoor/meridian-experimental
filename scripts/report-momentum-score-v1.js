#!/usr/bin/env node
/**
 * Read-only momentum-score-v1 outcome report.
 *
 * Joins future momentum shadow rows with action logs where possible. Older
 * closes remain in the "unknown" bucket instead of being backfilled with
 * post-hoc data.
 */

import fs from "fs";
import path from "path";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

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
    source: "main",
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--date") out.date = argv[++i];
    else if (arg === "--logs") out.logs = resolve(argv[++i]);
    else if (arg === "--source") out.source = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
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

function scoreBucket(score) {
  if (score == null) return "unknown";
  if (score >= 75) return "75_plus";
  if (score >= 60) return "60_74";
  if (score >= 45) return "45_59";
  return "below_45";
}

function momentumKey(row = {}) {
  return row.pool ?? row.baseMint ?? row.poolName ?? null;
}

function latestMomentumByKey(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const key = momentumKey(row);
    if (!key) continue;
    const current = map.get(key);
    if (!current || String(row.ts || "") >= String(current.ts || "")) map.set(key, row);
  }
  return map;
}

function deployMap(rows, momentumByKey) {
  const map = new Map();
  for (const row of rows) {
    if (row.tool !== "deploy_position" || row.success !== true) continue;
    const result = parseResult(row.result);
    const position = result.position ?? null;
    if (!position) continue;
    const pool = result.pool ?? row.args?.pool_address ?? null;
    const baseMint = row.args?.base_mint ?? result.base_mint ?? null;
    const momentum = momentumByKey.get(pool) ?? momentumByKey.get(baseMint) ?? null;
    map.set(position, {
      position,
      pool,
      pool_name: result.pool_name ?? row.args?.pool_name ?? null,
      base_mint: baseMint,
      amount_sol: num(result.amount_y ?? row.args?.amount_y ?? row.args?.amount_sol),
      momentum,
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
      const momentum = deploy?.momentum?.momentum ?? null;
      const primary = momentum?.primary ?? null;
      const pnlPct = num(result.pnl_pct ?? result.pnlPct);
      const amountSol = num(deploy?.amount_sol);
      const estimatedSolPnl = amountSol != null && pnlPct != null ? (amountSol * pnlPct) / 100 : null;
      return {
        timestamp: row.timestamp ?? null,
        position,
        pool: result.pool ?? deploy?.pool ?? null,
        pool_name: result.pool_name ?? deploy?.pool_name ?? null,
        exit_reason: row.args?.reason ?? result.reason ?? "unknown",
        pnl_pct: pnlPct,
        estimated_sol_pnl: round(estimatedSolPnl),
        fee_earned_sol: num(result.fees_sol ?? result.fees_usd),
        hold_minutes: num(result.hold_minutes ?? result.duration_minutes),
        momentum_profile: primary?.momentum_profile ?? "unknown",
        momentum_score_v1: num(primary?.momentum_score_v1),
        momentum_bucket: scoreBucket(num(primary?.momentum_score_v1)),
        momentum_classification: primary?.momentum_classification ?? "unknown",
        would_scalp: momentum?.would_scalp ?? null,
        would_throttle: momentum?.would_throttle ?? "unknown",
      };
    })
    .filter(Boolean);
}

function emptyGroup() {
  return {
    count: 0,
    wins: 0,
    estimated_sol_pnl: 0,
    fee_earned_sol: 0,
    avg_pnl_pct: 0,
    avg_hold_minutes: 0,
  };
}

function grouped(records, keyFn) {
  const out = {};
  for (const record of records) {
    const key = keyFn(record) || "unknown";
    out[key] ||= emptyGroup();
    const bucket = out[key];
    bucket.count += 1;
    if ((record.pnl_pct ?? 0) > 0) bucket.wins += 1;
    bucket.estimated_sol_pnl += record.estimated_sol_pnl ?? 0;
    bucket.fee_earned_sol += record.fee_earned_sol ?? 0;
    bucket.avg_pnl_pct += record.pnl_pct ?? 0;
    bucket.avg_hold_minutes += record.hold_minutes ?? 0;
  }
  for (const bucket of Object.values(out)) {
    bucket.win_rate = bucket.count ? round(bucket.wins / bucket.count, 4) : null;
    bucket.estimated_sol_pnl = round(bucket.estimated_sol_pnl);
    bucket.fee_earned_sol = round(bucket.fee_earned_sol);
    bucket.avg_pnl_pct = bucket.count ? round(bucket.avg_pnl_pct / bucket.count, 4) : null;
    bucket.avg_hold_minutes = bucket.count ? round(bucket.avg_hold_minutes / bucket.count, 2) : null;
  }
  return out;
}

export function buildMomentumScoreReport({ date, logs, source = "main" }) {
  const momentumRows = readJsonl(path.join(logs, `momentum-score-v1-${date}.jsonl`));
  const actionRows = readJsonl(path.join(logs, `actions-${date}.jsonl`));
  const deploys = deployMap(actionRows, latestMomentumByKey(momentumRows));
  const closes = closeRows(actionRows, deploys);
  const throttledRows = momentumRows.filter((row) => row.momentum?.would_throttle && row.momentum.would_throttle !== "none");
  const blockedLossEstimate = closes.filter((row) => row.would_throttle && row.would_throttle !== "none" && (row.pnl_pct ?? 0) < 0);
  const blockedWinnerCost = closes.filter((row) => row.would_throttle && row.would_throttle !== "none" && (row.pnl_pct ?? 0) > 0);

  return {
    date,
    source,
    momentumRows: momentumRows.length,
    closedPositions: closes.length,
    closes,
    byProfile: grouped(closes, (row) => row.momentum_profile),
    byScoreBucket: grouped(closes, (row) => row.momentum_bucket),
    byWouldScalp: grouped(closes, (row) => String(row.would_scalp)),
    byWouldThrottle: grouped(closes, (row) => row.would_throttle),
    shadowBlockedLossEstimate: {
      count: blockedLossEstimate.length,
      estimated_sol_pnl: round(blockedLossEstimate.reduce((sum, row) => sum + (row.estimated_sol_pnl ?? 0), 0)),
    },
    shadowBlockedWinnerCost: {
      count: blockedWinnerCost.length,
      estimated_sol_pnl: round(blockedWinnerCost.reduce((sum, row) => sum + (row.estimated_sol_pnl ?? 0), 0)),
    },
    throttleRows: throttledRows.length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const report = buildMomentumScoreReport(args);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Momentum Score V1 report (${report.source}) ${report.date}`);
    console.log(`Momentum rows: ${report.momentumRows}`);
    console.log(`Closed positions: ${report.closedPositions}`);
    console.log(`By score bucket: ${JSON.stringify(report.byScoreBucket)}`);
    console.log(`By would_throttle: ${JSON.stringify(report.byWouldThrottle)}`);
    console.log(`Shadow blocked losses: ${report.shadowBlockedLossEstimate.count} / ${report.shadowBlockedLossEstimate.estimated_sol_pnl} SOL`);
    console.log(`Shadow blocked winners: ${report.shadowBlockedWinnerCost.count} / ${report.shadowBlockedWinnerCost.estimated_sol_pnl} SOL`);
  }
}
