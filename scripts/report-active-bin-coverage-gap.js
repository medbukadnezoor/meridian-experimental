#!/usr/bin/env node
/**
 * Read-only coverage report for active-bin oracle telemetry.
 *
 * Compares tracked positions, PnL snapshots, and active-bin oracle rows so
 * short-lived positions cannot silently have PnL evidence but no LPTELE/oracle
 * evidence.
 */

import fs from "fs";
import path from "path";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DEFAULT_LOG_DIR = join(ROOT, "logs");
const DEFAULT_STATE = join(ROOT, "state.json");

function printUsage() {
  console.error([
    "Usage: node scripts/report-active-bin-coverage-gap.js [options]",
    "",
    "Options:",
    "  --state <file>       state.json path (default: ./state.json)",
    "  --log-dir <dir>      directory containing logs (default: ./logs)",
    "  --snapshots <path>   pnl snapshot file or dir (default: log dir)",
    "  --oracle <path>      active-bin oracle file or dir (default: log dir)",
    "  --date <YYYY-MM-DD>  limit log files/positions to a UTC date",
    "  --grace-minutes <n>  ignore positions younger than this age (default: 2)",
    "  --min-snapshots <n>  only flag gaps with at least this many PnL rows (default: 1)",
    "  --json               print JSON instead of text",
  ].join("\n"));
}

function parseArgs(argv) {
  const options = {
    statePath: DEFAULT_STATE,
    logDir: DEFAULT_LOG_DIR,
    snapshotsPath: null,
    oraclePath: null,
    date: null,
    graceMinutes: 2,
    minSnapshots: 1,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--state" || arg === "--log-dir" || arg === "--snapshots" || arg === "--oracle" || arg === "--date" || arg === "--grace-minutes" || arg === "--min-snapshots") {
      const value = argv[i + 1];
      if (!value) {
        printUsage();
        process.exit(1);
      }
      if (arg === "--state") options.statePath = resolve(value);
      if (arg === "--log-dir") options.logDir = resolve(value);
      if (arg === "--snapshots") options.snapshotsPath = resolve(value);
      if (arg === "--oracle") options.oraclePath = resolve(value);
      if (arg === "--date") options.date = value;
      if (arg === "--grace-minutes") options.graceMinutes = Number(value);
      if (arg === "--min-snapshots") options.minSnapshots = Number(value);
      i += 1;
      continue;
    }
    printUsage();
    console.error(`Unknown argument: ${arg}`);
    process.exit(1);
  }

  if (!Number.isFinite(options.graceMinutes) || options.graceMinutes < 0) {
    throw new Error("--grace-minutes must be a non-negative number");
  }
  if (!Number.isInteger(options.minSnapshots) || options.minSnapshots < 0) {
    throw new Error("--min-snapshots must be a non-negative integer");
  }
  options.snapshotsPath = options.snapshotsPath || options.logDir;
  options.oraclePath = options.oraclePath || options.logDir;
  return options;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function listJsonl(inputPath, prefix, date = null) {
  if (!fs.existsSync(inputPath)) return [];
  const stat = fs.statSync(inputPath);
  if (stat.isFile()) return [inputPath];
  if (!stat.isDirectory()) return [];
  const datePart = date ? `-${date}` : "";
  return fs.readdirSync(inputPath)
    .filter((name) => name.startsWith(`${prefix}${datePart}`) && name.endsWith(".jsonl"))
    .sort()
    .map((name) => path.join(inputPath, name));
}

function readJsonl(files) {
  const rows = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        rows.push({ ...JSON.parse(line), _file: file });
      } catch {
        // Active writers can leave partial trailing lines. Skip them.
      }
    }
  }
  return rows;
}

function timestampOf(row) {
  return row?.timestamp || row?.ts || row?.time || row?.created_at || row?.updated_at || null;
}

function ms(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function positionId(position) {
  return position?.position || position?.address || position?.position_address || null;
}

function normalizePositions(state, date = null) {
  const raw = Object.values(state.positions || {});
  return raw
    .filter((position) => {
      const deployedAt = position.deployed_at || position.opened_at || position.created_at || null;
      const closedAt = position.closed_at || null;
      if (!date) return true;
      return String(deployedAt || "").startsWith(date) || String(closedAt || "").startsWith(date);
    })
    .map((position) => ({
      raw: position,
      position: positionId(position),
      pool: position.pool || position.pool_address || null,
      pair: position.pair || position.pool_name || null,
      deployedAt: position.deployed_at || position.opened_at || position.created_at || null,
      closedAt: position.closed_at || null,
      lowerBin: position.lower_bin ?? position.min_bin ?? position.bin_range?.min ?? null,
      upperBin: position.upper_bin ?? position.max_bin ?? position.bin_range?.max ?? null,
    }))
    .filter((position) => position.position);
}

function groupByPosition(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!row.position) continue;
    if (!grouped.has(row.position)) grouped.set(row.position, []);
    grouped.get(row.position).push(row);
  }
  for (const rowsForPosition of grouped.values()) {
    rowsForPosition.sort((a, b) => (ms(timestampOf(a)) || 0) - (ms(timestampOf(b)) || 0));
  }
  return grouped;
}

function analyzeCoverage({ state, pnlRows, oracleRows, date, graceMinutes, minSnapshots, nowMs = Date.now() }) {
  const positions = normalizePositions(state, date);
  const pnlByPosition = groupByPosition(pnlRows.filter((row) => !row.event || row.event === "pnl_snapshot"));
  const oracleByPosition = groupByPosition(oracleRows);
  const graceMs = graceMinutes * 60 * 1000;

  const rows = positions.map((position) => {
    const pnl = pnlByPosition.get(position.position) || [];
    const oracle = oracleByPosition.get(position.position) || [];
    const deployedMs = ms(position.deployedAt);
    const closedMs = ms(position.closedAt);
    const ageBasisMs = closedMs || nowMs;
    const ageMs = deployedMs ? ageBasisMs - deployedMs : null;
    const staleEnough = ageMs == null || ageMs >= graceMs;
    const eligible = Boolean(position.pool && position.lowerBin != null && position.upperBin != null);
    const gap = eligible && staleEnough && pnl.length >= minSnapshots && oracle.length === 0;
    const firstPnlTs = timestampOf(pnl[0]);
    const firstOracleTs = timestampOf(oracle[0]);

    return {
      pair: position.pair,
      pool: position.pool,
      position: position.position,
      deployed_at: position.deployedAt,
      closed_at: position.closedAt,
      duration_min: deployedMs && closedMs ? Number(((closedMs - deployedMs) / 60000).toFixed(2)) : null,
      eligible,
      stale_enough: staleEnough,
      pnl_rows: pnl.length,
      oracle_rows: oracle.length,
      first_pnl_delay_sec: deployedMs && firstPnlTs ? Number(((ms(firstPnlTs) - deployedMs) / 1000).toFixed(1)) : null,
      first_oracle_delay_sec: deployedMs && firstOracleTs ? Number(((ms(firstOracleTs) - deployedMs) / 1000).toFixed(1)) : null,
      coverage_gap: gap,
    };
  });

  return {
    generated_at: new Date(nowMs).toISOString(),
    date,
    grace_minutes: graceMinutes,
    min_snapshots: minSnapshots,
    positions: rows.length,
    positions_with_pnl: rows.filter((row) => row.pnl_rows > 0).length,
    positions_with_oracle: rows.filter((row) => row.oracle_rows > 0).length,
    coverage_gaps: rows.filter((row) => row.coverage_gap).length,
    rows,
  };
}

function printText(report, files) {
  console.log("Active-Bin Oracle Coverage Gap Report");
  console.log("=====================================");
  console.log(`Generated: ${report.generated_at}`);
  console.log(`Date filter: ${report.date || "all"}`);
  console.log(`Grace: ${report.grace_minutes}m`);
  console.log(`Min PnL snapshots to flag: ${report.min_snapshots}`);
  console.log(`PNL files: ${files.pnlFiles.length}`);
  console.log(`Oracle files: ${files.oracleFiles.length}`);
  console.log("");
  console.log(`Positions: ${report.positions}`);
  console.log(`Positions with PnL rows: ${report.positions_with_pnl}`);
  console.log(`Positions with oracle rows: ${report.positions_with_oracle}`);
  console.log(`Coverage gaps: ${report.coverage_gaps}`);
  console.log("");

  const gaps = report.rows.filter((row) => row.coverage_gap);
  if (!gaps.length) {
    console.log("No stale PnL-without-oracle coverage gaps found.");
    return;
  }

  console.log("Coverage gaps:");
  for (const row of gaps) {
    console.log([
      `- ${row.pair || "unknown"}`,
      row.position ? row.position.slice(0, 8) : "no-position",
      row.pool ? row.pool.slice(0, 8) : "no-pool",
      `pnl_rows=${row.pnl_rows}`,
      `oracle_rows=${row.oracle_rows}`,
      row.duration_min != null ? `duration=${row.duration_min}m` : null,
      row.deployed_at ? `deployed=${row.deployed_at}` : null,
      row.closed_at ? `closed=${row.closed_at}` : null,
    ].filter(Boolean).join(" | "));
  }
}

export {
  analyzeCoverage,
  listJsonl,
  normalizePositions,
  readJsonl,
};

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const state = readJson(options.statePath);
    const pnlFiles = listJsonl(options.snapshotsPath, "pnl-snapshots", options.date);
    const oracleFiles = listJsonl(options.oraclePath, "active-bin-oracle", options.date);
    const report = analyzeCoverage({
      state,
      pnlRows: readJsonl(pnlFiles),
      oracleRows: readJsonl(oracleFiles),
      date: options.date,
      graceMinutes: options.graceMinutes,
      minSnapshots: options.minSnapshots,
    });
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printText(report, { pnlFiles, oracleFiles });
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}
