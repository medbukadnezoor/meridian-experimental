#!/usr/bin/env node
import path from "path";
import { fileURLToPath } from "url";
import { appendJsonl, jsonlPath } from "../sol-equity-tracker.js";

function usage() {
  console.error([
    "Usage: node scripts/import-fabriq-pnl-snapshot.js --pnl-sol <n> [options]",
    "",
    "Options:",
    "  --bot <name>",
    "  --wallet <pubkey>",
    "  --ts <iso>",
    "  --log-dir <dir>     Default logs",
    "  --note <text>",
  ].join("\n"));
}

export function parseArgs(argv) {
  const options = { logDir: "logs", ts: new Date().toISOString(), bot: null, wallet: null, note: null, pnlSol: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (["--bot", "--wallet", "--ts", "--log-dir", "--note", "--pnl-sol"].includes(arg)) {
      if (!next) throw new Error(`Missing value for ${arg}`);
      if (arg === "--bot") options.bot = next;
      if (arg === "--wallet") options.wallet = next;
      if (arg === "--ts") options.ts = next;
      if (arg === "--log-dir") options.logDir = next;
      if (arg === "--note") options.note = next;
      if (arg === "--pnl-sol") {
        const number = Number(next);
        if (!Number.isFinite(number)) throw new Error(`Invalid --pnl-sol: ${next}`);
        options.pnlSol = number;
      }
      i += 1;
      continue;
    }
    usage();
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.pnlSol == null) throw new Error("--pnl-sol is required");
  if (!Number.isFinite(Date.parse(options.ts))) throw new Error(`Invalid --ts: ${options.ts}`);
  return options;
}

export function importFabriqSnapshot(options) {
  const row = {
    ts: options.ts,
    event: "fabriq_pnl_snapshot",
    bot: options.bot,
    wallet: options.wallet,
    fabriqPnlSol: options.pnlSol,
    note: options.note,
  };
  const file = jsonlPath(options.logDir, "fabriq-pnl-snapshots", new Date(options.ts));
  appendJsonl(file, row);
  return { file, row };
}

function main() {
  const result = importFabriqSnapshot(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
