#!/usr/bin/env node
/**
 * Live read-only candidate funnel shadow.
 *
 * Compares GMGN-first and direct Meteora discovery with the normal nanocap
 * post-discovery gates, then writes an append-only JSONL evidence row. It does
 * not deploy, close, edit config, restart PM2, or feed candidates to the agent.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DEFAULT_LOG_DIR = path.join(ROOT, "logs");
const DEFAULT_REPORT_PATH = path.join(ROOT, "reports", "latest_candidate_funnel_shadow.md");
const SOURCES = Object.freeze(["gmgn", "meteora"]);

function printUsage() {
  console.error([
    "Usage: node scripts/run-candidate-funnel-shadow.js [options]",
    "",
    "Options:",
    "  --once                 run one comparison and exit",
    "  --interval-min <n>     loop interval in minutes; default 15",
    "  --limit <n>            candidate limit per source; default 10",
    "  --log-dir <dir>        output log directory; default ./logs",
    "  --report <file>        latest markdown report path",
    "  --json                 print latest JSON row to stdout",
  ].join("\n"));
}

export function parseArgs(argv) {
  const options = {
    once: false,
    intervalMin: 15,
    limit: 10,
    logDir: DEFAULT_LOG_DIR,
    reportPath: DEFAULT_REPORT_PATH,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--once") {
      options.once = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (["--interval-min", "--limit", "--log-dir", "--report"].includes(arg)) {
      const next = argv[i + 1];
      if (!next) {
        printUsage();
        throw new Error(`Missing value for ${arg}`);
      }
      if (arg === "--interval-min") options.intervalMin = Math.max(1, Number(next));
      if (arg === "--limit") options.limit = Math.max(1, Math.floor(Number(next)));
      if (arg === "--log-dir") options.logDir = path.resolve(next);
      if (arg === "--report") options.reportPath = path.resolve(next);
      i += 1;
      continue;
    }
    printUsage();
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(options.intervalMin)) options.intervalMin = 15;
  if (!Number.isFinite(options.limit)) options.limit = 10;
  return options;
}

function todayKey(ts = new Date().toISOString()) {
  return String(ts).slice(0, 10);
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function shortCandidate(candidate = {}) {
  return {
    pool: candidate.pool ?? candidate.pool_address ?? null,
    name: candidate.name ?? candidate.pool_name ?? null,
    baseMint: candidate.base?.mint ?? candidate.base_mint ?? null,
    baseSymbol: candidate.base?.symbol ?? null,
    source: candidate.discovery_source ?? candidate.source ?? null,
    mcap: toNumber(candidate.mcap),
    activeTvl: toNumber(candidate.active_tvl),
    volumeWindow: toNumber(candidate.volume_window ?? candidate.volume),
    feeActiveTvlRatio: toNumber(candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio),
    binStep: toNumber(candidate.bin_step),
    volatility: toNumber(candidate.volatility),
    organicScore: toNumber(candidate.organic_score ?? candidate.base?.organic),
    holders: toNumber(candidate.holders ?? candidate.holder_count),
    darwinScore: toNumber(candidate.darwin_score),
    darwinCoveragePct: toNumber(candidate.darwin_coverage_pct),
    indicatorConfirmed: candidate.indicator_confirmation?.confirmed ?? null,
    indicatorReason: candidate.indicator_confirmation?.reason ?? null,
  };
}

function candidateKey(candidate = {}, field) {
  return String(field === "mint"
    ? (candidate.baseMint ?? candidate.base_mint ?? "")
    : (candidate.pool ?? candidate.pool_address ?? ""));
}

function compareCandidates(sourceResults = {}) {
  const gmgn = sourceResults.gmgn?.candidates ?? [];
  const meteora = sourceResults.meteora?.candidates ?? [];
  const gmgnPools = new Set(gmgn.map((c) => candidateKey(c, "pool")).filter(Boolean));
  const meteoraPools = new Set(meteora.map((c) => candidateKey(c, "pool")).filter(Boolean));
  const gmgnMints = new Set(gmgn.map((c) => candidateKey(c, "mint")).filter(Boolean));
  const meteoraMints = new Set(meteora.map((c) => candidateKey(c, "mint")).filter(Boolean));

  const poolOverlap = [...gmgnPools].filter((pool) => meteoraPools.has(pool));
  const mintOverlap = [...gmgnMints].filter((mint) => meteoraMints.has(mint));
  const gmgnOnly = gmgn.filter((candidate) => !meteoraPools.has(candidate.pool));
  const meteoraOnly = meteora.filter((candidate) => !gmgnPools.has(candidate.pool));

  return {
    poolOverlapCount: poolOverlap.length,
    mintOverlapCount: mintOverlap.length,
    gmgnOnlyCount: gmgnOnly.length,
    meteoraOnlyCount: meteoraOnly.length,
    gmgnOnly: gmgnOnly.slice(0, 5),
    meteoraOnly: meteoraOnly.slice(0, 5),
    poolOverlap: poolOverlap.slice(0, 10),
    mintOverlap: mintOverlap.slice(0, 10),
  };
}

function renderMarkdown(row) {
  const lines = [
    "# Candidate Funnel Shadow",
    "",
    `Generated: ${row.ts}`,
    `Bot: ${row.bot}`,
    `Shadow only: ${row.shadowOnly ? "yes" : "no"}`,
    "",
    "## Summary",
    "",
    `- GMGN candidates: ${row.sources.gmgn?.candidateCount ?? 0} / screened ${row.sources.gmgn?.totalScreened ?? "?"}`,
    `- Meteora candidates: ${row.sources.meteora?.candidateCount ?? 0} / screened ${row.sources.meteora?.totalScreened ?? "?"}`,
    `- Pool overlap: ${row.comparison.poolOverlapCount}`,
    `- Mint overlap: ${row.comparison.mintOverlapCount}`,
    `- GMGN-only: ${row.comparison.gmgnOnlyCount}`,
    `- Meteora-only: ${row.comparison.meteoraOnlyCount}`,
    "",
    "## Errors",
    "",
    `- GMGN: ${row.sources.gmgn?.error ?? "none"}`,
    `- Meteora: ${row.sources.meteora?.error ?? "none"}`,
    "",
    "## GMGN Top",
    "",
    ...row.sources.gmgn.candidates.slice(0, 5).map((c, i) => `${i + 1}. ${c.name ?? "unknown"} ${c.pool ?? ""} fee/TVL=${c.feeActiveTvlRatio ?? "?"} volume=${c.volumeWindow ?? "?"} mcap=${c.mcap ?? "?"}`),
    "",
    "## Meteora Top",
    "",
    ...row.sources.meteora.candidates.slice(0, 5).map((c, i) => `${i + 1}. ${c.name ?? "unknown"} ${c.pool ?? ""} fee/TVL=${c.feeActiveTvlRatio ?? "?"} volume=${c.volumeWindow ?? "?"} mcap=${c.mcap ?? "?"}`),
    "",
    "This report is read-only evidence. It does not change live screening, deploy, close, cooldown, or ranking decisions.",
  ];
  return `${lines.join("\n")}\n`;
}

function writeEvidence(row, options = {}) {
  fs.mkdirSync(options.logDir, { recursive: true });
  const logFile = path.join(options.logDir, `candidate-funnel-shadow-${todayKey(row.ts)}.jsonl`);
  fs.appendFileSync(logFile, `${JSON.stringify(row)}\n`);

  if (options.reportPath) {
    fs.mkdirSync(path.dirname(options.reportPath), { recursive: true });
    fs.writeFileSync(options.reportPath, renderMarkdown(row));
  }

  return { logFile, reportPath: options.reportPath };
}

async function loadModule(specifier) {
  if (typeof globalThis.__MERIDIAN_CANDIDATE_SHADOW_TEST_IMPORT__ === "function") {
    return globalThis.__MERIDIAN_CANDIDATE_SHADOW_TEST_IMPORT__(specifier);
  }
  return import(specifier);
}

async function runSource({ source, limit, config, getTopCandidates }) {
  const originalSource = config.screening.source;
  const startedAt = Date.now();
  try {
    config.screening.source = source;
    const result = await getTopCandidates({ limit });
    const candidates = (result.candidates || []).map(shortCandidate);
    return {
      source,
      ok: true,
      durationMs: Date.now() - startedAt,
      candidateCount: candidates.length,
      totalEligible: result.total_eligible ?? candidates.length,
      totalScreened: result.total_screened ?? null,
      stageCounts: result.stage_counts ?? {},
      filteredExamples: result.filtered_examples ?? [],
      allFilteredCount: Array.isArray(result.all_filtered) ? result.all_filtered.length : null,
      candidates,
      error: null,
    };
  } catch (error) {
    return {
      source,
      ok: false,
      durationMs: Date.now() - startedAt,
      candidateCount: 0,
      totalEligible: 0,
      totalScreened: null,
      stageCounts: {},
      filteredExamples: [],
      allFilteredCount: null,
      candidates: [],
      error: error.message,
    };
  } finally {
    config.screening.source = originalSource;
  }
}

export async function runCandidateFunnelShadow(options = {}) {
  process.env.MERIDIAN_SHADOW_DISABLE_DECISION_CONTEXT ||= "true";
  const [{ config }, { getTopCandidates }] = await Promise.all([
    loadModule("../config.js"),
    loadModule("../tools/screening.js"),
  ]);

  const ts = new Date().toISOString();
  const originalSource = config.screening.source;
  const sourceEntries = {};
  for (const source of SOURCES) {
    sourceEntries[source] = await runSource({ source, limit: options.limit, config, getTopCandidates });
  }
  config.screening.source = originalSource;

  const row = {
    ts,
    event: "candidate_funnel_shadow",
    bot: config.management?.pnlSnapshotBotName ?? "nanocap",
    shadowOnly: true,
    readOnly: true,
    noDeploy: true,
    noClose: true,
    activeRuntimeSource: originalSource,
    limit: options.limit,
    configSnapshot: {
      minMcap: config.screening.minMcap,
      maxMcap: config.screening.maxMcap,
      minTvl: config.screening.minTvl,
      maxTvl: config.screening.maxTvl,
      minVolume: config.screening.minVolume,
      minFeeActiveTvlRatio: config.screening.minFeeActiveTvlRatio,
      minBinStep: config.screening.minBinStep,
      maxBinStep: config.screening.maxBinStep,
      timeframe: config.screening.timeframe,
      category: config.screening.category,
      indicatorsEnabled: config.indicators?.enabled ?? null,
      entryPreset: config.indicators?.entryPreset ?? null,
    },
    sources: sourceEntries,
    comparison: compareCandidates(sourceEntries),
  };

  const writeResult = writeEvidence(row, options);
  return { ...row, output: writeResult };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });

  do {
    const row = await runCandidateFunnelShadow(options);
    const summary = {
      ts: row.ts,
      gmgn: {
        ok: row.sources.gmgn.ok,
        candidates: row.sources.gmgn.candidateCount,
        error: row.sources.gmgn.error,
      },
      meteora: {
        ok: row.sources.meteora.ok,
        candidates: row.sources.meteora.candidateCount,
        error: row.sources.meteora.error,
      },
      comparison: row.comparison,
      output: row.output,
    };
    if (options.json) console.log(JSON.stringify(summary, null, 2));
    else console.log(`[candidate_shadow] ${row.ts} gmgn=${summary.gmgn.candidates} meteora=${summary.meteora.candidates} overlap=${row.comparison.poolOverlapCount}`);
    if (options.once) break;
    await sleep(options.intervalMin * 60_000);
  } while (!stopping);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[candidate_shadow_error] ${error.stack || error.message}`);
    process.exit(1);
  });
}
