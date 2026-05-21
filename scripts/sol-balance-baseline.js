#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  baselinePath,
  collectSolEquitySnapshot,
  ensureDir,
  externalFlowSol,
  readBaseline,
  roundSol,
} from "../sol-equity-tracker.js";

function usage() {
  console.error([
    "Usage: node scripts/sol-balance-baseline.js <command> [options]",
    "",
    "Commands:",
    "  init --reason <text>          Initialize from current estimated equity",
    "  show                          Print baseline JSON",
    "  add-flow --amount <sol> --reason <text>",
    "  reset --reason <text>         Reset baseline from current estimated equity",
    "",
    "Options:",
    "  --log-dir <dir>               Default logs",
  ].join("\n"));
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, logDir: "logs", reason: null, amount: null };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const next = rest[i + 1];
    if (arg === "--log-dir") {
      if (!next) throw new Error("Missing value for --log-dir");
      options.logDir = next;
      i += 1;
      continue;
    }
    if (arg === "--reason") {
      if (!next) throw new Error("Missing value for --reason");
      options.reason = next;
      i += 1;
      continue;
    }
    if (arg === "--amount") {
      if (!next) throw new Error("Missing value for --amount");
      const amount = Number(next);
      if (!Number.isFinite(amount)) throw new Error(`Invalid --amount: ${next}`);
      options.amount = amount;
      i += 1;
      continue;
    }
    usage();
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function writeBaseline(logDir, baseline) {
  const file = baselinePath(logDir);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`);
  return file;
}

export function ensureBaselineInitialized({ logDir = "logs", snapshot, reason = "auto baseline" }) {
  const existing = readBaseline(logDir).baseline;
  if (existing) return { created: false, baseline: existing };
  const baseline = {
    ts: new Date().toISOString(),
    event: "sol_balance_baseline",
    wallet: snapshot.wallet,
    bot: snapshot.bot,
    baselineEquitySol: snapshot.estimatedEquitySol,
    baselineSnapshotTs: snapshot.ts,
    reason,
    flows: [],
    resets: [],
  };
  writeBaseline(logDir, baseline);
  return { created: true, baseline };
}

async function initBaseline({ logDir, reason, reset = false }) {
  if (!reason) throw new Error("--reason is required");
  const existing = readBaseline(logDir).baseline;
  if (existing && !reset) throw new Error("Baseline already exists; use reset --reason to replace it");
  const snapshot = await collectSolEquitySnapshot({ logDir, residualState: { lastSample: null, lastSampleAtMs: null } });
  if (existing && existing.wallet !== snapshot.wallet && !reset) {
    throw new Error(`Wallet mismatch: baseline=${existing.wallet} current=${snapshot.wallet}; use reset --reason explicitly`);
  }
  const baseline = {
    ts: new Date().toISOString(),
    event: "sol_balance_baseline",
    wallet: snapshot.wallet,
    bot: snapshot.bot,
    baselineEquitySol: snapshot.estimatedEquitySol,
    baselineSnapshotTs: snapshot.ts,
    reason,
    flows: reset ? [] : (existing?.flows || []),
    resets: [
      ...(existing?.resets || []),
      ...(existing ? [{ ts: new Date().toISOString(), reason, previous: existing }] : []),
    ],
  };
  return { file: writeBaseline(logDir, baseline), baseline };
}

function addFlow({ logDir, amount, reason }) {
  if (!reason) throw new Error("--reason is required");
  if (!Number.isFinite(amount)) throw new Error("--amount is required");
  const { baseline } = readBaseline(logDir);
  if (!baseline) throw new Error("Baseline missing; run init first");
  baseline.flows = [
    ...(baseline.flows || []),
    {
      ts: new Date().toISOString(),
      amountSol: roundSol(amount),
      reason,
    },
  ];
  baseline.updatedAt = new Date().toISOString();
  baseline.externalFlowSol = externalFlowSol(baseline);
  return { file: writeBaseline(logDir, baseline), baseline };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.command) {
    usage();
    process.exit(1);
  }
  let result;
  if (options.command === "show") {
    result = readBaseline(options.logDir);
  } else if (options.command === "init") {
    result = await initBaseline({ logDir: options.logDir, reason: options.reason, reset: false });
  } else if (options.command === "reset") {
    result = await initBaseline({ logDir: options.logDir, reason: options.reason, reset: true });
  } else if (options.command === "add-flow") {
    result = addFlow({ logDir: options.logDir, amount: options.amount, reason: options.reason });
  } else {
    usage();
    throw new Error(`Unknown command: ${options.command}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
