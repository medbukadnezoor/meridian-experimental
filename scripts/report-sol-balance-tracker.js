#!/usr/bin/env node
import path from "path";
import { fileURLToPath } from "url";
import { latestBalanceSnapshot, writeReport } from "../sol-pnl-verifier.js";

function parseArgs(argv) {
  const options = { logDir: "logs", reportsDir: "reports", json: false, noWrite: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--no-write") {
      options.noWrite = true;
      continue;
    }
    if (arg === "--log-dir" || arg === "--reports-dir") {
      if (!next) throw new Error(`Missing value for ${arg}`);
      if (arg === "--log-dir") options.logDir = next;
      if (arg === "--reports-dir") options.reportsDir = next;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export function buildBalanceReport(row) {
  if (!row) {
    return {
      ok: false,
      markdown: "# SOL Balance Tracker\n\nNo balance snapshots found.\n",
      data: null,
    };
  }
  const warnings = row.dataQuality?.warnings || [];
  const lines = [
    "# SOL Balance Tracker",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Latest snapshot: ${row.ts}`,
    `Bot: ${row.bot || "unknown"}`,
    `Wallet: ${row.wallet || "unknown"}`,
    "",
    "## Warnings",
    warnings.length ? warnings.map((warning) => `- ${warning}`).join("\n") : "- none",
    "",
    "## Equity",
    `- Free SOL: ${row.freeSol ?? "unknown"}`,
    `- Open position value SOL: ${row.openPositionValueSol ?? "unknown"}`,
    `- Residual token value SOL: ${row.residualTokenValueSol ?? "unknown"}`,
    `- Estimated equity SOL: ${row.estimatedEquitySol ?? "unknown"}`,
    `- Baseline equity SOL: ${row.baselineEquitySol ?? "unknown"}`,
    `- External flow SOL: ${row.externalFlowSol ?? "unknown"}`,
    `- Owner-adjusted PnL SOL: ${row.ownerAdjustedPnlSol ?? "unknown"}`,
    `- Owner-adjusted PnL pct: ${row.ownerAdjustedPnlPct ?? "unknown"}`,
    "",
    "## Sources",
    `- Free SOL: ${row.dataQuality?.freeSolSource || "unknown"}`,
    `- Positions: ${row.dataQuality?.positionsSource || "unknown"}`,
    `- Residual tokens: ${row.dataQuality?.residualTokensSource || "unknown"}`,
    `- Position value completeness: ${row.dataQuality?.positionValueCompleteness || "unknown"}`,
    "",
  ];
  return { ok: true, markdown: `${lines.join("\n")}\n`, data: row };
}

export function maybeWriteBalanceReport({ logDir = "logs", reportsDir = "reports" } = {}) {
  const row = latestBalanceSnapshot(logDir);
  const report = buildBalanceReport(row);
  writeReport(path.join(reportsDir, "latest_sol_balance_tracker.md"), report.markdown);
  return report;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const row = latestBalanceSnapshot(options.logDir);
  const report = buildBalanceReport(row);
  if (!options.noWrite) writeReport(path.join(options.reportsDir, "latest_sol_balance_tracker.md"), report.markdown);
  console.log(options.json ? JSON.stringify(report.data || { ok: false, error: "no_snapshots" }, null, 2) : report.markdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
