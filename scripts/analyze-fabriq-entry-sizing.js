#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { applyDynamicPoolSizing } from "../dynamic-pool-sizing.js";
import { evaluateFabriqOhlcvEntryGate } from "../fabriq-ohlcv-entry-gate.js";
import { buildConfig } from "../config-builder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const REPORT_DIR = path.join(ROOT, "reports");

function parseArgs(argv = process.argv.slice(2)) {
  const args = { input: null, output: path.join(REPORT_DIR, "fabriq-entry-sizing-report.json"), markdown: null, solUsd: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") args.input = argv[++i];
    else if (arg === "--output") args.output = argv[++i];
    else if (arg === "--markdown") args.markdown = argv[++i];
    else if (arg === "--sol-usd") args.solUsd = Number(argv[++i]);
    else if (arg === "--help") {
      console.log("Usage: node scripts/analyze-fabriq-entry-sizing.js --input candidates.json --sol-usd 70 [--output report.json] [--markdown report.md]");
      process.exit(0);
    }
  }
  if (!args.input) throw new Error("--input is required");
  if (!Number.isFinite(args.solUsd) || args.solUsd <= 0) throw new Error("--sol-usd is required for read-only sizing replay");
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function unwrapCandidates(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.candidates)) return payload.candidates;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.pools)) return payload.pools;
  return [];
}

function reportConfig() {
  return buildConfig({
    dynamicPoolSizingEnabled: true,
    dynamicPoolSizingMode: "live",
    dynamicPoolSizingTargetActiveTvlSharePct: 3.5,
    dynamicPoolSizingHardActiveTvlSharePct: 5,
    dynamicPoolSizingMinDeploySol: 1,
    dynamicPoolSizingMaxDeploySol: 5,
    dynamicPoolSizingBlockBelowMin: true,
    dynamicPoolSizingBlockOnMissingInputs: true,
    fabriqOhlcvEntryGateEnabled: true,
    fabriqOhlcvEntryGateMode: "live",
    fabriqOhlcvEntryGateProviders: ["dexpaprika", "gmgn", "okx"],
    fabriqOhlcvEntryGateDecisiveProviderOrder: ["dexpaprika", "gmgn", "okx"],
    fabriqOhlcvEntryGateIntervals: ["1m", "5m", "15m"],
    fabriqOhlcvEntryGateLookbackMinutes: 180,
    fabriqOhlcvEntryGateMinRows: 20,
    fabriqOhlcvEntryGateBlockOnMissingOhlcv: true,
  });
}

async function analyzeCandidate(candidate, runtimeConfig, solUsd) {
  const sizing = applyDynamicPoolSizing(
    {
      ...candidate,
      amount_y: candidate.amount_y ?? candidate.amount_sol ?? runtimeConfig.management.deployAmountSol,
      active_tvl: candidate.active_tvl ?? candidate.tvl,
      sol_usd: solUsd,
    },
    runtimeConfig,
    { solUsd },
  );
  const gate = await evaluateFabriqOhlcvEntryGate(candidate, runtimeConfig);
  const wouldEnter = sizing.ok && gate.result === "accept";
  return {
    name: candidate.name ?? candidate.symbol ?? candidate.pool_name ?? candidate.pool ?? candidate.pool_address ?? "unknown",
    pool: candidate.pool ?? candidate.pool_address ?? null,
    base_mint: candidate.base_mint ?? candidate.base?.mint ?? candidate.mint ?? null,
    active_tvl: candidate.active_tvl ?? candidate.tvl ?? null,
    sol_usd: solUsd,
    dynamic_pool_sizing: sizing.decision,
    fabriq_ohlcv_entry_gate: gate,
    would_enter: wouldEnter,
    would_skip_reason: wouldEnter
      ? null
      : sizing.ok
        ? `entry_gate_${gate.result}`
        : sizing.reason,
  };
}

function writeMarkdown(report, file) {
  const lines = [
    "# Fabriq Entry Sizing Replay",
    "",
    `Generated: ${report.generated_at}`,
    `SOL price used: $${report.sol_usd}`,
    "",
    "| Candidate | active TVL | size SOL | OHLCV | Decision |",
    "| --- | ---: | ---: | --- | --- |",
  ];
  for (const row of report.rows) {
    lines.push([
      row.name,
      row.active_tvl ?? "",
      row.dynamic_pool_sizing?.final_amount_y ?? "",
      `${row.fabriq_ohlcv_entry_gate?.decisive_provider ?? "none"}:${row.fabriq_ohlcv_entry_gate?.result ?? "unknown"}`,
      row.would_enter ? "would-enter" : `skip: ${row.would_skip_reason}`,
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

async function main() {
  const args = parseArgs();
  const payload = readJson(args.input);
  const candidates = unwrapCandidates(payload);
  const runtimeConfig = reportConfig();
  const rows = [];
  for (const candidate of candidates) {
    rows.push(await analyzeCandidate(candidate, runtimeConfig, args.solUsd));
  }
  const report = {
    generated_at: new Date().toISOString(),
    input: path.resolve(args.input),
    sol_usd: args.solUsd,
    rows,
    summary: {
      candidates: rows.length,
      would_enter: rows.filter((row) => row.would_enter).length,
      would_skip: rows.filter((row) => !row.would_enter).length,
    },
  };
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
  if (args.markdown) writeMarkdown(report, args.markdown);
  console.log(JSON.stringify({ success: true, output: args.output, markdown: args.markdown, summary: report.summary }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
