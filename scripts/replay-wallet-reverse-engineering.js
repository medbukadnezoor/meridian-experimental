#!/usr/bin/env node
/**
 * Wallet-agnostic read-only replay for reverse-engineering proposals.
 *
 * Local files only. No network calls, env reads, runtime imports, PM2 commands,
 * or config mutations.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildComparison, DEFAULT_CONFIG, loadConfig } from "./replay-fnmf-comparison.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function usage() {
  return [
    "Usage: node scripts/replay-wallet-reverse-engineering.js --evidence-dir <dir> [options]",
    "",
    "Options:",
    "  --evidence-dir <dir>     wallet_reverse_engineering/<wallet>/<run> directory",
    "  --proposal-json <file>   proposal JSON; defaults to <evidence-dir>/proposal.json",
    "  --config <file>          optional replay threshold override",
    "  --output <file>          defaults to <evidence-dir>/replay_summary.json",
    "  --print                  print summary JSON",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { evidenceDir: null, proposalJson: null, configPath: null, outputPath: null, print: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--print") options.print = true;
    else if (["--evidence-dir", "--proposal-json", "--config", "--output"].includes(arg)) {
      const value = argv[i + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      if (arg === "--evidence-dir") options.evidenceDir = path.resolve(value);
      if (arg === "--proposal-json") options.proposalJson = path.resolve(value);
      if (arg === "--config") options.configPath = path.resolve(value);
      if (arg === "--output") options.outputPath = path.resolve(value);
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.help && !options.evidenceDir) throw new Error("Missing --evidence-dir");
  return options;
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`${label} file does not exist: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function runWalletReplay(options) {
  const evidenceDir = path.resolve(options.evidenceDir);
  if (!evidenceDir.startsWith(REPO_ROOT)) {
    throw new Error(`Evidence dir must be inside repo: ${evidenceDir}`);
  }
  const positionsPayload = readJson(path.join(evidenceDir, "lpagent_historical_positions.json"), "positions");
  const ohlcvPayload = readJson(path.join(evidenceDir, "ohlcv_overlay.json"), "ohlcv");
  const proposalPath = options.proposalJson || path.join(evidenceDir, "proposal.json");
  const proposal = readJson(proposalPath, "proposal");
  if (proposal.status !== "NOT_APPLIED" || proposal.applied === true) {
    throw new Error("Proposal must be NOT_APPLIED and unapplied");
  }
  const config = loadConfig(options.configPath);
  const comparison = buildComparison({ positionsPayload, ohlcvPayload, config });
  comparison.proposal = {
    path: proposalPath,
    status: proposal.status,
    target: proposal.target,
    validation_status: proposal.validation_status,
    strategy_name: proposal.strategy_name,
  };
  comparison.safety.scope = "Oracle Scout reverse-engineering research artifacts only";
  comparison.mode = "read_only_wallet_reverse_engineering_replay_not_backtest";
  const outputPath = options.outputPath || path.join(evidenceDir, "replay_summary.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(comparison, null, 2)}\n`);
  return comparison;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else {
      const comparison = runWalletReplay(options);
      console.error(`Wrote ${options.outputPath || path.join(options.evidenceDir, "replay_summary.json")}`);
      if (options.print) console.log(JSON.stringify(comparison.summary, null, 2));
    }
  } catch (error) {
    console.error(error?.message || String(error));
    console.error("");
    console.error(usage());
    process.exitCode = 1;
  }
}

export { DEFAULT_CONFIG };
