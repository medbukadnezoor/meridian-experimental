import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { config } from "../config.js";
import { log } from "../logger.js";
import {
  condenseResolvedMeteoraPool,
  resolveTokenToMeteoraDlmmPool,
} from "./meteora-pool-resolver.js";

const execFileAsync = promisify(execFile);
const OKX_STATE_DIR = path.resolve("state", "okx-discovery");
const WATCHLIST_FILE = path.join(OKX_STATE_DIR, "watchlist.json");
const SNAPSHOTS_FILE = path.join(OKX_STATE_DIR, "snapshots.json");
const CLI_TIMEOUT_MS = 15_000;
const SNAPSHOT_CAP = 500;

const DEFAULT_OKX_DISCOVERY = Object.freeze({
  enabled: false,
  shadowMode: true,
  pollMs: 60_000,
  mintCooldownMins: 60,
  watchlistTtlMins: 180,
  maxWatchMints: 120,
  maxCandidatesPerPoll: 4,
  seedLimit: 100,
  timeFrame: "1",
  rankBy: "5",
  includeBundleInfo: false,
  baseline: {
    minHolders: 100,
    minLiquidityUsd: 5000,
    minMcapUsd: 0,
    maxMcapUsd: 0,
    maxTop10HolderRate: 0.5,
    maxRugRatio: 0.3,
    maxBundlerRate: 0.5,
    maxBotRate: 0.5,
    maxCreatorBalanceRate: 0.2,
    requireNotWashTrading: true,
  },
  trigger: {
    minScans: 2,
    minHolderGrowthPct: 3,
    maxLiquidityDropPct: 30,
    minBuySellRatio: 1.1,
  },
});

const watchlist = new Map();
let snapshots = [];
let loadedState = false;
let running = false;
let polling = false;
let pollTimer = null;
const status = {
  enabled: false,
  configured: false,
  running: false,
  shadowMode: true,
  seeded: false,
  pollMs: DEFAULT_OKX_DISCOVERY.pollMs,
  lastPollAt: null,
  lastError: null,
  polls: 0,
  seedsSeen: 0,
  watchlistSize: 0,
  candidatesEmitted: 0,
  shadowCandidates: 0,
  poolsMapped: 0,
  poolsNotFound: 0,
  filtered: {},
  lastCandidate: null,
};

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function optionalNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pctRatio(value) {
  const n = optionalNum(value);
  if (n == null) return null;
  return n > 1 ? n / 100 : n;
}

function okxSettings(runtimeConfig = config) {
  const user = runtimeConfig.screening?.okxDiscovery || {};
  return {
    ...DEFAULT_OKX_DISCOVERY,
    ...user,
    baseline: {
      ...DEFAULT_OKX_DISCOVERY.baseline,
      ...(user.baseline || {}),
    },
    trigger: {
      ...DEFAULT_OKX_DISCOVERY.trigger,
      ...(user.trigger || {}),
    },
  };
}

function hasCredentials(env = process.env) {
  return Boolean(
    env.OKX_API_KEY &&
    env.OKX_SECRET_KEY &&
    (env.OKX_PASSPHRASE || env.OKX_API_PASSPHRASE)
  );
}

function onchainosEnv(env = process.env) {
  const childEnv = { ...env };
  if (!childEnv.OKX_PASSPHRASE && childEnv.OKX_API_PASSPHRASE) {
    childEnv.OKX_PASSPHRASE = childEnv.OKX_API_PASSPHRASE;
  }
  return childEnv;
}

async function runOnchainos(args, { timeout = CLI_TIMEOUT_MS } = {}) {
  const { stdout } = await execFileAsync("onchainos", args, {
    timeout,
    env: onchainosEnv(),
  });
  return parseCliJson(stdout);
}

function parseCliJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  const parsed = JSON.parse(text);
  if (parsed?.ok === false) {
    throw new Error(String(parsed.error || parsed.message || "onchainos returned ok=false"));
  }
  return parsed?.data ?? parsed;
}

function unwrapRows(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["list", "rows", "tokens", "items", "rank", "data"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
    if (Array.isArray(payload?.data?.[key])) return payload.data[key];
  }
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function tokenMint(row = {}) {
  return row.mint || row.address || row.tokenAddress || row.token_address || row.tokenContractAddress || row.contractAddress || null;
}

function tokenSymbol(row = {}) {
  return row.symbol || row.tokenSymbol || row.token_symbol || row.ticker || null;
}

function normalizeTokenRow(row = {}) {
  const buys = num(row.txsBuy ?? row.buyTxs ?? row.buy_count ?? row.buyCount);
  const sells = num(row.txsSell ?? row.sellTxs ?? row.sell_count ?? row.sellCount);
  return {
    mint: tokenMint(row),
    name: row.name || row.tokenName || row.token_name || tokenSymbol(row) || tokenMint(row),
    symbol: tokenSymbol(row),
    priceUsd: num(row.priceUsd ?? row.price ?? row.tokenPrice),
    marketCapUsd: num(row.marketCapUsd ?? row.marketCap ?? row.mcap ?? row.market_cap),
    liquidityUsd: num(row.liquidityUsd ?? row.liquidity ?? row.liquidity_usd),
    volumeUsd: num(row.volumeUsd ?? row.volume ?? row.volume_usd),
    holders: num(row.holders ?? row.holderCount ?? row.holder_count),
    uniqueTraders: num(row.uniqueTraders ?? row.unique_traders),
    txsBuy: buys,
    txsSell: sells,
    txsTotal: num(row.txsTotal ?? row.txCount ?? row.tx_count, buys + sells),
    changePct: num(row.changePct ?? row.priceChangePct ?? row.priceChangePercent ?? row.price_change_pct),
    top10Pct: pctRatio(row.top10HoldPercent ?? row.top10Pct ?? row.top10HolderRate) ?? 0,
    rugRatio: pctRatio(row.rugRatio ?? row.rug_ratio) ?? 0,
    bundlerPct: pctRatio(row.bundleHoldingPercent ?? row.bundlerPct ?? row.bundlerRate) ?? 0,
    sniperPct: pctRatio(row.sniperHoldingPercent ?? row.sniperPct ?? row.sniperRate) ?? 0,
    botPct: pctRatio(row.botRate ?? row.botHolderRate ?? row.botDegenRate) ?? 0,
    creatorBalancePct: pctRatio(row.creatorBalanceRate ?? row.devHoldingPercent ?? row.devHoldingRate) ?? 0,
    isWashTrading: Boolean(row.isWashTrading ?? row.is_wash_trading ?? row.washTrading),
    raw: row,
  };
}

function recordFilter(reason) {
  status.filtered[reason] = (status.filtered[reason] || 0) + 1;
}

function passBaseline(token, settings) {
  const b = settings.baseline;
  if (!token.mint) return "missing_mint";
  if (token.holders < b.minHolders) return "min_holders";
  if (token.liquidityUsd < b.minLiquidityUsd) return "min_liquidity";
  if (b.minMcapUsd > 0 && token.marketCapUsd < b.minMcapUsd) return "min_mcap";
  if (b.maxMcapUsd > 0 && token.marketCapUsd > b.maxMcapUsd) return "max_mcap";
  if (token.top10Pct > b.maxTop10HolderRate) return "top10_holder_rate";
  if (token.rugRatio > b.maxRugRatio) return "rug_ratio";
  if (token.bundlerPct > b.maxBundlerRate) return "bundler_rate";
  if (token.botPct > b.maxBotRate) return "bot_rate";
  if (token.creatorBalancePct > b.maxCreatorBalanceRate) return "creator_balance_rate";
  if (b.requireNotWashTrading && token.isWashTrading) return "wash_trading";
  return null;
}

function updateWatchlist(token) {
  const now = Date.now();
  const current = watchlist.get(token.mint);
  if (!current) {
    watchlist.set(token.mint, {
      ...token,
      firstSeenAt: now,
      lastSeenAt: now,
      firstHolders: token.holders,
      firstLiquidityUsd: token.liquidityUsd,
      scans: 1,
      emittedAt: null,
    });
    return watchlist.get(token.mint);
  }
  Object.assign(current, token, {
    lastSeenAt: now,
    scans: (current.scans || 0) + 1,
    firstSeenAt: current.firstSeenAt || now,
    firstHolders: current.firstHolders ?? token.holders,
    firstLiquidityUsd: current.firstLiquidityUsd ?? token.liquidityUsd,
  });
  return current;
}

function purgeWatchlist(settings) {
  const now = Date.now();
  const ttlMs = settings.watchlistTtlMins * 60_000;
  for (const [mint, entry] of watchlist.entries()) {
    if (now - (entry.lastSeenAt || 0) > ttlMs) watchlist.delete(mint);
  }
  if (watchlist.size <= settings.maxWatchMints) return;
  const sorted = [...watchlist.entries()].sort((a, b) => (b[1].lastSeenAt || 0) - (a[1].lastSeenAt || 0));
  watchlist.clear();
  for (const [mint, entry] of sorted.slice(0, settings.maxWatchMints)) {
    watchlist.set(mint, entry);
  }
}

function triggerReason(entry, settings) {
  const t = settings.trigger;
  if ((entry.scans || 0) < t.minScans) return "min_scans";
  if (entry.emittedAt && Date.now() - entry.emittedAt < settings.mintCooldownMins * 60_000) return "cooldown";

  const holderGrowthPct = entry.firstHolders > 0
    ? ((entry.holders - entry.firstHolders) / entry.firstHolders) * 100
    : 0;
  const liquidityDropPct = entry.firstLiquidityUsd > 0
    ? Math.max(0, ((entry.firstLiquidityUsd - entry.liquidityUsd) / entry.firstLiquidityUsd) * 100)
    : 0;
  const buySellRatio = entry.txsSell > 0 ? entry.txsBuy / entry.txsSell : (entry.txsBuy > 0 ? Infinity : 0);

  entry.okxHolderGrowthPct = Number(holderGrowthPct.toFixed(2));
  entry.okxLiquidityDropPct = Number(liquidityDropPct.toFixed(2));
  entry.okxBuySellRatio = Number(Number.isFinite(buySellRatio) ? buySellRatio.toFixed(2) : 999);

  if (holderGrowthPct < t.minHolderGrowthPct) return "holder_growth";
  if (liquidityDropPct > t.maxLiquidityDropPct) return "liquidity_drop";
  if (buySellRatio < t.minBuySellRatio) return "buy_sell_ratio";
  return null;
}

async function fetchHotTokens(settings) {
  const payload = await runOnchainos([
    "token",
    "hot-tokens",
    "--chain",
    "solana",
    "--rank-by",
    String(settings.rankBy),
    "--time-frame",
    String(settings.timeFrame),
    "--limit",
    String(settings.seedLimit),
  ]);
  return unwrapRows(payload).map(normalizeTokenRow).filter(Boolean);
}

async function fetchAdvancedInfo(mint) {
  try {
    const payload = await runOnchainos([
      "token",
      "advanced-info",
      "--chain",
      "solana",
      "--address",
      mint,
    ]);
    const row = Array.isArray(payload) ? payload[0] : payload?.data ?? payload;
    return row && typeof row === "object" ? normalizeTokenRow(row) : null;
  } catch (error) {
    log("okx_discovery", `advanced-info unavailable for ${mint.slice(0, 8)}: ${error.message}`);
    return null;
  }
}

function passAdvanced(entry, settings) {
  const b = settings.baseline;
  if (entry.top10Pct > b.maxTop10HolderRate) return "advanced_top10_holder_rate";
  if (entry.rugRatio > b.maxRugRatio) return "advanced_rug_ratio";
  if (entry.bundlerPct > b.maxBundlerRate) return "advanced_bundler_rate";
  if (entry.sniperPct > (b.maxSniperRate ?? b.maxBotRate)) return "advanced_sniper_rate";
  if (entry.creatorBalancePct > b.maxCreatorBalanceRate) return "advanced_creator_balance_rate";
  if (b.requireNotWashTrading && entry.isWashTrading) return "advanced_wash_trading";
  return null;
}

function okxScore(entry) {
  return Number((
    entry.volumeUsd / 1000 +
    entry.liquidityUsd / 2000 +
    entry.holders / 50 +
    (entry.okxHolderGrowthPct || 0) * 5 +
    (entry.okxBuySellRatio || 0) * 10
  ).toFixed(2));
}

async function mapEntryToCandidate(entry, runtimeConfig, settings) {
  const minTvl = num(settings.minTvl ?? runtimeConfig.screening?.minTvl ?? 0);
  const resolved = await resolveTokenToMeteoraDlmmPool(entry.mint, {
    minTvl,
    limit: 2,
    runtimeConfig,
  });
  if (!resolved?.pool) {
    status.poolsNotFound += 1;
    return null;
  }
  status.poolsMapped += 1;
  const candidate = condenseResolvedMeteoraPool({
    token: {
      mint: entry.mint,
      symbol: entry.symbol,
      holders: entry.holders,
      marketCapUsd: entry.marketCapUsd,
      volumeUsd: entry.volumeUsd,
      priceUsd: entry.priceUsd,
      changePct: entry.changePct,
      uniqueTraders: entry.uniqueTraders,
      txsTotal: entry.txsTotal,
    },
    pool: resolved.pool,
    poolDetail: resolved.detail,
    source: "okx_discovery",
    runtimeConfig,
  });
  if (!candidate) return null;
  return {
    ...candidate,
    source: "okx_discovery",
    discovery_source: "okx_discovery",
    okx_discovery: true,
    okxScore: okxScore(entry),
    okxScans: entry.scans || 0,
    okxHolderGrowthPct: entry.okxHolderGrowthPct || 0,
    okxBuySellRatio: entry.okxBuySellRatio || 0,
    okxBundlerPct: Number(((entry.bundlerPct || 0) * 100).toFixed(2)),
    okxSniperPct: Number(((entry.sniperPct || 0) * 100).toFixed(2)),
    okxTop10Pct: Number(((entry.top10Pct || 0) * 100).toFixed(2)),
    okxRugRatio: Number(((entry.rugRatio || 0) * 100).toFixed(2)),
    okxIsWashTrading: Boolean(entry.isWashTrading),
  };
}

async function loadState() {
  if (loadedState) return;
  await fs.mkdir(OKX_STATE_DIR, { recursive: true });
  try {
    const raw = JSON.parse(await fs.readFile(WATCHLIST_FILE, "utf8"));
    for (const entry of Array.isArray(raw) ? raw : raw.entries || []) {
      if (entry?.mint) watchlist.set(entry.mint, entry);
    }
  } catch {}
  try {
    const raw = JSON.parse(await fs.readFile(SNAPSHOTS_FILE, "utf8"));
    snapshots = Array.isArray(raw) ? raw : [];
  } catch {
    snapshots = [];
  }
  loadedState = true;
}

async function saveState() {
  await fs.mkdir(OKX_STATE_DIR, { recursive: true });
  await Promise.all([
    fs.writeFile(WATCHLIST_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), entries: [...watchlist.values()] }, null, 2)),
    fs.writeFile(SNAPSHOTS_FILE, JSON.stringify(snapshots.slice(-SNAPSHOT_CAP), null, 2)),
  ]);
}

export async function discoverOkxPools({ limit = 10, runtimeConfig = config, force = false } = {}) {
  const settings = okxSettings(runtimeConfig);
  Object.assign(status, {
    enabled: Boolean(settings.enabled),
    configured: hasCredentials(),
    shadowMode: Boolean(settings.shadowMode),
    pollMs: settings.pollMs,
    running,
    lastError: null,
  });

  if (!settings.enabled && !force) {
    return { total: 0, pools: [], filtered_examples: [], stage_counts: { source: "okx_discovery", skipped: "disabled" } };
  }
  if (!hasCredentials()) {
    log("okx_discovery", "Skipping OKX discovery: OKX credentials are not configured");
    return { total: 0, pools: [], filtered_examples: [], stage_counts: { source: "okx_discovery", skipped: "missing_credentials" } };
  }

  await loadState();
  const filtered = [];
  const stageCounts = {
    source: "okx_discovery",
    seeded: 0,
    baseline_pass: 0,
    watchlist_size: 0,
    trigger_pass: 0,
    advanced_pass: 0,
    mapped_pools: 0,
    no_pool: 0,
    shadow_candidates: 0,
  };

  try {
    status.polls += 1;
    status.lastPollAt = new Date().toISOString();
    const rows = await fetchHotTokens(settings);
    status.seedsSeen += rows.length;
    stageCounts.seeded = rows.length;
    snapshots.push({
      at: Date.now(),
      count: rows.length,
      rows: rows.slice(0, settings.seedLimit).map((row) => ({
        mint: row.mint,
        symbol: row.symbol,
        liquidityUsd: row.liquidityUsd,
        holders: row.holders,
        volumeUsd: row.volumeUsd,
      })),
    });

    for (const row of rows) {
      const reason = passBaseline(row, settings);
      if (reason) {
        recordFilter(reason);
        filtered.push({ stage: "okx_baseline_filter", name: row.name || row.mint || "unknown", reason, source: "okx_discovery" });
        continue;
      }
      stageCounts.baseline_pass += 1;
      updateWatchlist(row);
    }
    purgeWatchlist(settings);
    stageCounts.watchlist_size = watchlist.size;
    status.watchlistSize = watchlist.size;

    const triggered = [];
    for (const entry of watchlist.values()) {
      const reason = triggerReason(entry, settings);
      if (reason) {
        if (reason !== "cooldown" && reason !== "min_scans") recordFilter(reason);
        continue;
      }
      triggered.push(entry);
    }
    triggered.sort((a, b) => okxScore(b) - okxScore(a));
    stageCounts.trigger_pass = triggered.length;

    const candidates = [];
    for (const entry of triggered.slice(0, Math.min(limit, settings.maxCandidatesPerPoll))) {
      const advanced = await fetchAdvancedInfo(entry.mint);
      if (advanced) Object.assign(entry, advanced);
      const advancedReject = passAdvanced(entry, settings);
      if (advancedReject) {
        recordFilter(advancedReject);
        filtered.push({ stage: "okx_advanced_filter", name: entry.name || entry.mint, reason: advancedReject, source: "okx_discovery" });
        continue;
      }
      stageCounts.advanced_pass += 1;
      const candidate = await mapEntryToCandidate(entry, runtimeConfig, settings);
      if (!candidate) {
        stageCounts.no_pool += 1;
        filtered.push({ stage: "okx_meteora_pool_map", name: entry.name || entry.mint, reason: "no SOL DLMM pool above configured minimum TVL", source: "okx_discovery" });
        continue;
      }
      entry.emittedAt = Date.now();
      status.lastCandidate = candidate;
      candidates.push(candidate);
    }

    stageCounts.mapped_pools = candidates.length;
    if (settings.shadowMode) {
      status.shadowCandidates += candidates.length;
      stageCounts.shadow_candidates = candidates.length;
      if (candidates.length > 0) {
        log("okx_discovery", `Shadow found ${candidates.length} mapped candidate(s); not entering screening decisions`);
      }
    } else {
      status.candidatesEmitted += candidates.length;
    }
    status.seeded = true;
    await saveState();

    return {
      total: rows.length,
      pools: settings.shadowMode ? [] : candidates,
      shadow_pools: settings.shadowMode ? candidates : [],
      filtered_examples: filtered,
      stage_counts: stageCounts,
      okx_status: getOkxDiscoveryStatus(),
    };
  } catch (error) {
    status.lastError = error.message;
    await saveState().catch(() => {});
    log("okx_discovery", `Discovery skipped after error: ${error.message}`);
    return {
      total: 0,
      pools: [],
      filtered_examples: [{ stage: "okx_discovery_error", reason: error.message, source: "okx_discovery" }],
      stage_counts: { source: "okx_discovery", error: error.message },
    };
  }
}

async function pollLoop(options = {}) {
  if (!running || polling) return;
  polling = true;
  try {
    await discoverOkxPools({ ...options, force: true });
  } finally {
    polling = false;
    if (running) {
      const settings = okxSettings(options.runtimeConfig || config);
      pollTimer = setTimeout(() => pollLoop(options), settings.pollMs);
    }
  }
}

export async function startOkxDiscovery(options = {}) {
  const settings = okxSettings(options.runtimeConfig || config);
  if (!settings.enabled && !options.force) return getOkxDiscoveryStatus();
  running = true;
  status.running = true;
  await loadState();
  pollLoop(options);
  return getOkxDiscoveryStatus();
}

export function stopOkxDiscovery() {
  running = false;
  status.running = false;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  return getOkxDiscoveryStatus();
}

export function getOkxDiscoveryStatus() {
  return {
    ...status,
    watchlistSize: watchlist.size,
    watchedMints: watchlist.size,
  };
}
