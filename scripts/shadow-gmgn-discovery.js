#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";
import { getTopCandidates } from "../tools/screening.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    limit: 5,
    gmgnRankLimit: null,
    gmgnEnrichLimit: null,
    gmgnDelayMs: null,
    gmgnHoldersLimit: null,
    gmgnMaxRetries: 0,
    minMcap: null,
    maxMcap: null,
    minTvl: null,
    indicatorFilter: null,
    logDir: path.join(ROOT, "logs"),
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--limit") args.limit = Number(next());
    else if (arg === "--gmgn-rank-limit") args.gmgnRankLimit = Number(next());
    else if (arg === "--gmgn-enrich-limit" || arg === "--gmgn-max-tokens") args.gmgnEnrichLimit = Number(next());
    else if (arg === "--gmgn-delay-ms") args.gmgnDelayMs = Number(next());
    else if (arg === "--gmgn-holders-limit") args.gmgnHoldersLimit = Number(next());
    else if (arg === "--gmgn-max-retries") args.gmgnMaxRetries = Number(next());
    else if (arg === "--min-mcap") args.minMcap = Number(next());
    else if (arg === "--max-mcap") args.maxMcap = Number(next());
    else if (arg === "--min-tvl") args.minTvl = Number(next());
    else if (arg === "--no-indicator-filter") args.indicatorFilter = false;
    else if (arg === "--indicator-filter") args.indicatorFilter = true;
    else if (arg === "--log-dir") args.logDir = path.resolve(next());
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/shadow-gmgn-discovery.js [options]

Compares live read-only Meteora vs GMGN screening and appends one JSONL row.

Options:
  --limit N                  Final candidates per source (default: 5)
  --gmgn-rank-limit N        GMGN /market/rank limit override
  --gmgn-enrich-limit N      GMGN downstream token cap override
  --gmgn-delay-ms N          GMGN request pacing override
  --gmgn-holders-limit N     GMGN holders/traders limit override
  --gmgn-max-retries N       GMGN retries override (default: 0)
  --min-mcap N               Override Meteora and GMGN min mcap
  --max-mcap N               Override Meteora and GMGN max mcap
  --min-tvl N                Override Meteora and GMGN min TVL
  --no-indicator-filter      Disable GMGN-specific upstream indicator filter
  --log-dir PATH             Output directory (default: ./logs)
`);
}

function applyOverrides(args) {
  if (Number.isFinite(args.minMcap)) {
    config.screening.minMcap = args.minMcap;
    config.gmgn.minMcap = args.minMcap;
  }
  if (Number.isFinite(args.maxMcap)) {
    config.screening.maxMcap = args.maxMcap;
    config.gmgn.maxMcap = args.maxMcap;
  }
  if (Number.isFinite(args.minTvl)) {
    config.screening.minTvl = args.minTvl;
    config.gmgn.minTvl = args.minTvl;
  }
  if (Number.isFinite(args.gmgnRankLimit)) config.gmgn.limit = args.gmgnRankLimit;
  if (Number.isFinite(args.gmgnEnrichLimit)) config.gmgn.enrichLimit = args.gmgnEnrichLimit;
  if (Number.isFinite(args.gmgnDelayMs)) config.gmgn.requestDelayMs = args.gmgnDelayMs;
  if (Number.isFinite(args.gmgnHoldersLimit)) config.gmgn.holdersLimit = args.gmgnHoldersLimit;
  if (Number.isFinite(args.gmgnMaxRetries)) config.gmgn.maxRetries = args.gmgnMaxRetries;
  if (args.indicatorFilter !== null) config.gmgn.indicatorFilter = args.indicatorFilter;
}

function candidateSummary(candidate = {}) {
  return {
    pool: candidate.pool ?? null,
    name: candidate.name ?? null,
    mint: candidate.base?.mint ?? null,
    mcap: candidate.mcap ?? null,
    active_tvl: candidate.active_tvl ?? null,
    fee_active_tvl_ratio: candidate.fee_active_tvl_ratio ?? null,
    volume: candidate.volume_window ?? candidate.volume ?? null,
    token_age_hours: candidate.token_age_hours ?? null,
    source: candidate.gmgn ? "gmgn" : "meteora",
    gmgn_score: candidate.gmgn_score ?? null,
    gmgn_smart_wallets: candidate.gmgn_smart_wallets ?? null,
    gmgn_kol_wallets: candidate.gmgn_kol_wallets ?? null,
    gmgn_total_fee_sol: candidate.gmgn_total_fee_sol ?? null,
    reject_context: candidate.indicator_confirmation?.reason ?? null,
  };
}

function classifyError(error) {
  const message = String(error?.message || error || "");
  return {
    message,
    status: error?.status ?? null,
    code: error?.code ?? null,
    account_warning: Boolean(error?.accountWarning) || /temporarily banned|account|1010|forbidden|whitelist/i.test(message),
    rate_limited: /rate limit|temporarily banned|429/i.test(message),
  };
}

async function runSource(source, limit) {
  const previousSource = config.screening.source;
  config.screening.source = source;
  const started = Date.now();
  try {
    const result = await getTopCandidates({ limit });
    const candidates = (result.candidates || []).map(candidateSummary);
    return {
      ok: true,
      source,
      elapsed_ms: Date.now() - started,
      total_screened: result.total_screened ?? null,
      total_eligible: result.total_eligible ?? candidates.length,
      stage_counts: result.stage_counts ?? null,
      filtered_examples: result.filtered_examples ?? [],
      all_filtered_count: Array.isArray(result.all_filtered) ? result.all_filtered.length : null,
      candidates,
    };
  } catch (error) {
    return {
      ok: false,
      source,
      elapsed_ms: Date.now() - started,
      error: classifyError(error),
      total_screened: null,
      total_eligible: 0,
      stage_counts: null,
      filtered_examples: [],
      candidates: [],
    };
  } finally {
    config.screening.source = previousSource;
  }
}

function compareSources(meteora, gmgn) {
  const meteoraMints = new Set(meteora.candidates.map((candidate) => candidate.mint).filter(Boolean));
  const gmgnMints = new Set(gmgn.candidates.map((candidate) => candidate.mint).filter(Boolean));
  const overlap = [...gmgnMints].filter((mint) => meteoraMints.has(mint));
  const gmgnOnly = [...gmgnMints].filter((mint) => !meteoraMints.has(mint));
  const meteoraOnly = [...meteoraMints].filter((mint) => !gmgnMints.has(mint));
  return {
    meteora_final_count: meteora.candidates.length,
    gmgn_final_count: gmgn.candidates.length,
    gmgn_returned_more_final: gmgn.candidates.length > meteora.candidates.length,
    overlap_mints: overlap,
    gmgn_only_mints: gmgnOnly,
    meteora_only_mints: meteoraOnly,
  };
}

function outputPath(logDir) {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(logDir, `gmgn-shadow-discovery-${date}.jsonl`);
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    return;
  }
  applyOverrides(args);

  const startedAt = new Date().toISOString();
  const meteora = await runSource("meteora", args.limit);
  const gmgn = await runSource("gmgn", args.limit);
  const record = {
    generated_at: startedAt,
    run_id: `gmgn_shadow_${startedAt.replace(/[-:.TZ]/g, "").slice(0, 14)}`,
    mode: "read_only_shadow",
    live_entries_enabled: false,
    settings: {
      limit: args.limit,
      screening: {
        minMcap: config.screening.minMcap,
        maxMcap: config.screening.maxMcap,
        minTvl: config.screening.minTvl,
        minFeeActiveTvlRatio: config.screening.minFeeActiveTvlRatio,
      },
      gmgn: {
        keyConfigured: Boolean(config.gmgn.apiKey || process.env.GMGN_API_KEY),
        interval: config.gmgn.interval,
        rankLimit: config.gmgn.limit,
        enrichLimit: config.gmgn.enrichLimit,
        requestDelayMs: config.gmgn.requestDelayMs,
        holdersLimit: config.gmgn.holdersLimit,
        maxRetries: config.gmgn.maxRetries,
        indicatorFilter: config.gmgn.indicatorFilter,
      },
    },
    paths: { meteora, gmgn },
    comparison: compareSources(meteora, gmgn),
  };

  fs.mkdirSync(args.logDir, { recursive: true });
  const file = outputPath(args.logDir);
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);

  console.log(JSON.stringify({
    ok: meteora.ok && gmgn.ok,
    output: file,
    meteora_final_count: record.comparison.meteora_final_count,
    gmgn_final_count: record.comparison.gmgn_final_count,
    gmgn_returned_more_final: record.comparison.gmgn_returned_more_final,
    gmgn_error: gmgn.error ?? null,
    gmgn_stage_counts: gmgn.stage_counts,
  }, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
