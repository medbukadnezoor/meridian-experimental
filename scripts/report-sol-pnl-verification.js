#!/usr/bin/env node
import path from "path";
import { fileURLToPath } from "url";
import {
  buildSolPnlVerification,
  latestVerificationRow,
  loadVerificationInputs,
  writeReport,
} from "../sol-pnl-verifier.js";

function parseArgs(argv) {
  const options = {
    logDir: "logs",
    reportsDir: "reports",
    json: false,
    noWrite: false,
    generate: false,
    windowMs: 1_800_000,
  };
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
    if (arg === "--generate") {
      options.generate = true;
      continue;
    }
    if (arg === "--log-dir" || arg === "--reports-dir" || arg === "--window-ms") {
      if (!next) throw new Error(`Missing value for ${arg}`);
      if (arg === "--log-dir") options.logDir = next;
      if (arg === "--reports-dir") options.reportsDir = next;
      if (arg === "--window-ms") {
        const number = Number(next);
        if (!Number.isFinite(number)) throw new Error(`Invalid --window-ms: ${next}`);
        options.windowMs = number;
      }
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export function buildVerificationReport(row) {
  if (!row) {
    return {
      ok: false,
      markdown: "# SOL PnL Verification\n\nNo verification rows found.\n",
      data: null,
    };
  }
  const warnings = row.warnings || [];
  const lines = [
    "# SOL PnL Verification",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Latest verification: ${row.ts}`,
    `Window: ${row.windowStart || "unknown"} to ${row.windowEnd || "unknown"}`,
    `Bot: ${row.bot || "unknown"}`,
    `Wallet: ${row.wallet || "unknown"}`,
    "",
    "## Verdict",
    `- ${row.verdict}`,
    "",
    "## Warnings",
    warnings.length ? warnings.map((warning) => `- ${warning}`).join("\n") : "- none",
    "",
    "## PnL",
    `- Owner-adjusted PnL SOL: ${row.ownerAdjustedPnlSol ?? "unknown"}`,
    `- Equity delta SOL: ${row.equityDeltaSol ?? "unknown"}`,
    `- External flow SOL: ${row.externalFlowSol ?? "unknown"}`,
    `- Fabriq PnL SOL: ${row.fabriqPnlSol ?? "not imported"}`,
    `- Fabriq delta SOL: ${row.fabriqDeltaSol ?? "not imported"}`,
    "",
    "## Evidence",
    `- Open positions: ${row.openPositionCount}`,
    `- Closed positions: ${row.closedPositionCount}`,
    `- Successful autoswaps: ${row.successfulAutoswapCount}`,
    `- Failed autoswaps: ${row.failedAutoswapCount}`,
    `- Residual token value SOL: ${row.residualTokenValueSol ?? "unknown"}`,
    `- Unresolved residual token value SOL: ${row.unresolvedResidualTokenValueSol ?? "unknown"}`,
    `- Balance snapshot file: ${row.evidence?.balanceSnapshotFile || "unknown"}`,
    `- Action files: ${(row.evidence?.actionFiles || []).join(", ") || "none"}`,
    `- Fabriq snapshot file: ${row.evidence?.fabriqSnapshotFile || "none"}`,
    "",
  ];
  return { ok: true, markdown: `${lines.join("\n")}\n`, data: row };
}

export function maybeWriteVerificationReport({ logDir = "logs", reportsDir = "reports" } = {}) {
  const row = latestVerificationRow(logDir);
  const report = buildVerificationReport(row);
  writeReport(path.join(reportsDir, "latest_sol_pnl_verification.md"), report.markdown);
  return report;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  let row = latestVerificationRow(options.logDir);
  if (options.generate || !row) {
    row = buildSolPnlVerification(loadVerificationInputs({ logDir: options.logDir, windowMs: options.windowMs }));
  }
  const report = buildVerificationReport(row);
  if (!options.noWrite) writeReport(path.join(options.reportsDir, "latest_sol_pnl_verification.md"), report.markdown);
  console.log(options.json ? JSON.stringify(report.data || { ok: false, error: "no_verification" }, null, 2) : report.markdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
