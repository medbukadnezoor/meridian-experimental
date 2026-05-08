/**
 * GMGN Agent API helpers — token risk enrichment
 *
 * Endpoint: https://openapi.gmgn.ai/v1/market/token_top_traders
 * Auth:     X-APIKEY header + timestamp (unix seconds) + client_id (UUID per request)
 * Docs:     https://docs.gmgn.ai/index/gmgn-agent-api
 *
 * Used for logging and Darwin signal enrichment ONLY — never hard blockers.
 * Returns null on any error — never throws, never stalls the screening cycle.
 *
 * Signals derived (from badattrading_analyzer methodology research):
 *   bluechip_present    — quality signal: reputable wallets holding (positive)
 *   bundler_present     — risk signal: bundler bots in top traders (negative)
 *   fresh_wallet_count  — proxy for sniper count at launch
 *   top10_concentration_pct — supply concentration risk
 *   smart_tool_tags     — which smart-money tools are active (photon, padre, etc.)
 *   suspicious_count    — GMGN-flagged suspicious wallets
 *
 * GMGN coverage vs badattrading full methodology:
 *   ✅ Bluechip/quality holder detection  (tags: bluechip_owner)
 *   ✅ Bundler presence                   (tags: bundler)
 *   ✅ Fresh wallet / sniper proxy        (tags: fresh_wallet)
 *   ✅ Top10 concentration                (amount_percentage sum)
 *   ✅ Smart tool presence                (tags: photon, padre, axiom, bullx, trojan)
 *   ❌ Insider/sniper/team %             — DevsNightmarePro only
 *   ❌ Cluster structure                  — BubbleMaps / InsightX only
 *   ❌ Exchange-funded wallets            — Helius only
 */

import { randomUUID } from "crypto";
import { setDefaultResultOrder } from "dns";
import { config } from "../config.js";
import { log } from "../logger.js";

setDefaultResultOrder("ipv4first");

const METEORA_DLMM_API = "https://dlmm.datapi.meteora.ag";
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const GMGN_BASE = "https://openapi.gmgn.ai/v1";
const SUPPORTED_INTERVALS = new Set(["1m", "5m", "1h", "3h", "6h", "24h"]);
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES = Object.freeze({
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
});
let lastGmgnRequestAt = 0;
let gmgnRequestQueue = Promise.resolve();

// Tags indicating smart-money tool activity (positive context)
const SMART_TOOL_TAGS = new Set(["photon", "padre", "gmgn", "axiom", "bullx", "trojan", "gmgnkol"]);

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

/**
 * Fetch top traders for a token from GMGN and compute risk signals.
 *
 * @param {string} mintAddress — Solana token mint address
 * @param {number} [limit=20]  — how many top traders to fetch
 * @returns {Promise<GmgnRisk|null>}
 */
export async function fetchGmgnTokenRisk(mintAddress, limit = 20) {
  const apiKey = config.gmgn?.apiKey || process.env.GMGN_API_KEY || "";
  if (!apiKey || !mintAddress) return null;

  try {
    const params = new URLSearchParams({
      chain:     "sol",
      address:   mintAddress,
      limit:     String(limit),
      timestamp: String(Math.floor(Date.now() / 1000)),
      client_id: randomUUID(),
    });

    const res = await fetch(`${GMGN_BASE}/market/token_top_traders?${params}`, {
      headers: { "X-APIKEY": apiKey },
      signal:  AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      log("gmgn", `HTTP ${res.status} for ${mintAddress.slice(0, 8)}`);
      return null;
    }

    const body = await res.json();
    if (body.code !== 0 || !Array.isArray(body.data?.list)) return null;

    const result = _computeRiskSignals(body.data.list);
    log("gmgn", `${mintAddress.slice(0, 8)} — top10=${result.top10_concentration_pct}% bluechip=${result.bluechip_count} bundler=${result.bundler_count} suspicious=${result.suspicious_count}`);
    return result;
  } catch (err) {
    log("gmgn_warn", `fetch failed for ${mintAddress.slice(0, 8)}: ${err.message}`);
    return null;
  }
}

/**
 * Compute structured risk signals from a list of GMGN top trader objects.
 * @param {Array} traders
 * @returns {GmgnRisk}
 */
function _computeRiskSignals(traders) {
  let top10_concentration_pct = 0;
  let bluechip_count    = 0;
  let bundler_count     = 0;
  let fresh_wallet_count = 0;
  let sandwich_bot_count = 0;
  let suspicious_count  = 0;
  let whale_count       = 0;
  let diamond_hands_count = 0;
  const smart_tool_tags_found = new Set();
  let named_holder_count = 0;

  for (let i = 0; i < traders.length; i++) {
    const t = traders[i];
    const allTags = [
      ...(Array.isArray(t.tags)             ? t.tags             : []),
      ...(Array.isArray(t.maker_token_tags) ? t.maker_token_tags : []),
    ];

    // Top-10 concentration (amount_percentage is a decimal, e.g. 0.0633 = 6.33%)
    if (i < 10) top10_concentration_pct += (t.amount_percentage || 0) * 100;

    if (t.is_suspicious)  suspicious_count++;
    if (t.name)           named_holder_count++;

    for (const tag of allTags) {
      if (tag === "bluechip_owner")   bluechip_count++;
      if (tag === "bundler")          bundler_count++;
      if (tag === "fresh_wallet")     fresh_wallet_count++;
      if (tag === "sandwich_bot")     sandwich_bot_count++;
      if (tag === "whale")            whale_count++;
      if (tag === "diamond_hands")    diamond_hands_count++;
      if (SMART_TOOL_TAGS.has(tag))   smart_tool_tags_found.add(tag);
    }
  }

  return {
    top10_concentration_pct: parseFloat(top10_concentration_pct.toFixed(1)),
    bluechip_count,
    bundler_count,
    fresh_wallet_count,   // proxy for sniper bots at launch
    sandwich_bot_count,
    suspicious_count,
    whale_count,
    diamond_hands_count,
    smart_tool_tags:    [...smart_tool_tags_found].sort(),
    named_holder_count,
    // ── Darwin boolean signals ──────────────────────────────────────
    bluechip_present: bluechip_count > 0,   // positive: quality wallets holding
    bundler_present:  bundler_count  > 0,   // negative: bundler bots in supply
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function paceGmgnRequest() {
  const run = gmgnRequestQueue.then(async () => {
    const delayMs = Math.max(0, Number(config.gmgn?.requestDelayMs ?? 2500));
    if (!delayMs) return;
    const elapsed = Date.now() - lastGmgnRequestAt;
    if (elapsed < delayMs) await sleep(delayMs - elapsed);
    lastGmgnRequestAt = Date.now();
  });
  gmgnRequestQueue = run.catch(() => {});
  await run;
}

function normalizeInterval(value, fallback = "1h") {
  const normalized = String(value || fallback).trim();
  return SUPPORTED_INTERVALS.has(normalized) ? normalized : fallback;
}

function appendParams(url, params = {}) {
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const entry of value.filter((item) => item != null && item !== "")) {
        url.searchParams.append(key, String(entry));
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

function getRequiredGmgnApiKey() {
  const key = config.gmgn?.apiKey || process.env.GMGN_API_KEY;
  if (!key) throw new Error("GMGN_API_KEY is required for GMGN discovery.");
  return key;
}

async function gmgnFetch(pathname, { method = "GET", params = {}, body = null } = {}) {
  const baseUrl = String(config.gmgn?.baseUrl || "https://openapi.gmgn.ai").replace(/\/+$/, "");
  const url = new URL(`${baseUrl}${pathname}`);
  appendParams(url, {
    ...params,
    timestamp: Math.floor(Date.now() / 1000),
    client_id: randomUUID(),
  });

  const maxRetries = Math.max(0, Number(config.gmgn?.maxRetries ?? 0));
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await paceGmgnRequest();
    const res = await fetch(url, {
      method,
      headers: {
        "X-APIKEY": getRequiredGmgnApiKey(),
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : null,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text().catch(() => "");
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }

    const message = payload?.message || payload?.error || payload?.raw || `GMGN ${pathname} ${res.status}`;
    const codeFailure = payload?.code != null && Number(payload.code) !== 0;
    const rateLimited = res.status === 429 || /rate limit|temporarily banned/i.test(String(message));
    const retryAfterHeader = res.headers.get("retry-after");
    const rateLimitResetHeader = res.headers.get("x-ratelimit-reset");
    if (res.ok && !codeFailure) return payload;

    if (rateLimited && attempt < maxRetries) {
      const retryAfter = Number(retryAfterHeader);
      const backoffMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : /temporarily banned/i.test(String(message))
          ? 60_000
          : Math.min(30_000, 3000 * Math.pow(2, attempt));
      await sleep(backoffMs);
      continue;
    }

    const error = new Error(message);
    error.status = res.status;
    error.code = payload?.code ?? null;
    error.apiError = payload?.error ?? null;
    error.retryAfter = retryAfterHeader ?? null;
    error.rateLimitReset = rateLimitResetHeader ?? null;
    error.pathname = pathname;
    error.accountWarning = /temporarily banned|account|1010|forbidden|whitelist/i.test(String(message));
    throw error;
  }
  throw new Error(`GMGN ${pathname} failed`);
}

function unwrapList(payload, keys = ["list", "rank", "data"]) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
    if (Array.isArray(payload?.data?.[key])) return payload.data[key];
    if (Array.isArray(payload?.data?.data?.[key])) return payload.data.data[key];
  }
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.data)) return payload.data.data;
  return [];
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function optionalNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ratioPct(value) {
  const n = optionalNum(value);
  if (n == null) return null;
  return Number((n * 100).toFixed(2));
}

function tokenAddress(token = {}) {
  return token.address || token.token_address || token.mint || token.mint_address || token.base_address || null;
}

function tokenAgeHours(token = {}) {
  const raw = num(token.creation_timestamp || token.open_timestamp || token.created_at);
  if (!raw) return null;
  const seconds = raw > 10_000_000_000 ? raw / 1000 : raw;
  return (Date.now() / 1000 - seconds) / 3600;
}

function hasTag(entry, tag) {
  const tags = []
    .concat(entry?.tags || [])
    .concat(entry?.maker_token_tags || [])
    .map((value) => String(value || "").toLowerCase());
  return tags.includes(tag);
}

function entryName(entry) {
  return String(entry?.name || entry?.twitter_username || entry?.username || entry?.label || entry?.address || entry || "").trim();
}

function entryAmountPct(entry) {
  const raw = entry?.amount_percentage ?? entry?.balance_percentage ?? entry?.amount_cur_percentage;
  const n = optionalNum(raw);
  if (n == null) return 0;
  return n > 1 ? n : n * 100;
}

function namedMatch(entry, names = []) {
  const normalized = entryName(entry).toLowerCase();
  return names
    .map((name) => String(name || "").trim().toLowerCase())
    .filter(Boolean)
    .some((name) => normalized.includes(name));
}

function passBasicRankFilter(token) {
  const g = config.gmgn;
  const reasons = [];
  const mcap = num(token.market_cap);
  const ageHours = tokenAgeHours(token);
  if (mcap < g.minMcap) reasons.push(`mcap ${mcap} < ${g.minMcap}`);
  if (g.maxMcap != null && mcap > g.maxMcap) reasons.push(`mcap ${mcap} > ${g.maxMcap}`);
  if (num(token.bundler_rate) > g.maxBundlerRate) reasons.push(`bundler ${(num(token.bundler_rate) * 100).toFixed(1)}% > ${(g.maxBundlerRate * 100).toFixed(1)}%`);
  if (g.minTokenAgeHours != null && ageHours != null && ageHours < g.minTokenAgeHours) {
    reasons.push(`age ${ageHours.toFixed(2)}h < ${g.minTokenAgeHours}h`);
  }
  if (g.maxTokenAgeHours != null && ageHours != null && ageHours > g.maxTokenAgeHours) {
    reasons.push(`age ${ageHours.toFixed(2)}h > ${g.maxTokenAgeHours}h`);
  }
  if (num(token.volume) < g.minVolume) reasons.push(`volume ${num(token.volume)} < ${g.minVolume}`);
  return { pass: reasons.length === 0, reasons };
}

function analyzeTokenInfo(info = {}) {
  const g = config.gmgn;
  const stat = info.stat || {};
  const tags = info.wallet_tags_stat || {};
  const reasons = [];
  const price = num(info.price);
  const athPrice = num(info.ath_price);
  const priceVsAthPct = athPrice > 0 && price > 0 ? (price / athPrice) * 100 : null;
  if (g.athFilterPct != null && priceVsAthPct != null) {
    const threshold = 100 + Number(g.athFilterPct);
    if (priceVsAthPct > threshold) reasons.push(`price ${priceVsAthPct.toFixed(1)}% of ATH > ${threshold}%`);
  }
  const totalFeeSol = num(info.total_fee);
  if (num(info.holder_count) < g.minHolders) reasons.push(`holders ${num(info.holder_count)} < ${g.minHolders}`);
  if (totalFeeSol < g.minTotalFeeSol) reasons.push(`total fee ${totalFeeSol} SOL < ${g.minTotalFeeSol} SOL`);
  if (num(stat.top_10_holder_rate) > g.maxTop10HolderRate) reasons.push(`top10 ${ratioPct(stat.top_10_holder_rate)}%`);
  if (g.maxDevTeamHoldRate != null && num(stat.dev_team_hold_rate) > g.maxDevTeamHoldRate) reasons.push(`dev team ${ratioPct(stat.dev_team_hold_rate)}%`);
  if (num(stat.bot_degen_rate) > g.maxBotDegenRate) reasons.push(`bot degen ${ratioPct(stat.bot_degen_rate)}%`);
  if (g.maxFreshWalletRate != null && num(stat.fresh_wallet_rate) > g.maxFreshWalletRate) reasons.push(`fresh wallets ${ratioPct(stat.fresh_wallet_rate)}%`);
  if (num(stat.top_bundler_trader_percentage) > g.maxBundlerRate) reasons.push(`bundler ${ratioPct(stat.top_bundler_trader_percentage)}%`);
  if (num(stat.top_rat_trader_percentage) > g.maxRatTraderRate) reasons.push(`insider ${ratioPct(stat.top_rat_trader_percentage)}%`);
  return {
    passed: reasons.length === 0,
    reasons,
    smartWallets: num(tags.smart_wallets),
    kolWallets: num(tags.renowned_wallets),
    totalFeeSol,
    tradeFeeSol: num(info.trade_fee),
    priceVsAthPct,
    top10HolderPct: ratioPct(stat.top_10_holder_rate),
    devTeamHoldPct: ratioPct(stat.dev_team_hold_rate),
    botDegenPct: ratioPct(stat.bot_degen_rate),
    freshWalletPct: ratioPct(stat.fresh_wallet_rate),
    bundlerPct: ratioPct(stat.top_bundler_trader_percentage),
    insiderPct: ratioPct(stat.top_rat_trader_percentage),
    sniperWallets: num(tags.sniper_wallets),
    bundlerWallets: num(tags.bundler_wallets),
    whaleWallets: num(tags.whale_wallets),
    freshWallets: num(tags.fresh_wallets),
  };
}

function analyzeHoldersAndTraders(holders = [], traders = []) {
  const g = config.gmgn;
  const combined = [...holders, ...traders];
  const kolHolders = holders.filter((entry) => hasTag(entry, "kol") && !entry.end_holding_at);
  const smartHolders = holders.filter((entry) => hasTag(entry, "smart_degen") && !entry.end_holding_at);
  const kolTraders = traders.filter((entry) => hasTag(entry, "kol"));
  const smartTraders = traders.filter((entry) => hasTag(entry, "smart_degen"));
  const preferredKolHolders = kolHolders.filter((entry) =>
    namedMatch(entry, g.preferredKolNames) && entryAmountPct(entry) >= g.preferredKolMinHoldPct
  );
  const dumpKolHoldersAll = [...kolHolders, ...kolTraders.filter((entry) => !entry.end_holding_at)]
    .filter((entry) => namedMatch(entry, g.dumpKolNames));
  const dumpKolSignificant = dumpKolHoldersAll.filter((entry) => entryAmountPct(entry) >= (g.dumpKolMinHoldPct ?? 0.5));
  const sniperTopHolders = holders.filter((entry) => hasTag(entry, "sniper"));
  const sniperHoldRate = holders.length > 0 ? sniperTopHolders.length / holders.length : 0;
  const reasons = [];
  if (sniperHoldRate > g.maxSniperHoldRate) reasons.push(`sniper top-holder rate ${(sniperHoldRate * 100).toFixed(1)}%`);
  return {
    passed: reasons.length === 0,
    reasons,
    kolHolding: kolHolders.length,
    smartHolding: smartHolders.length,
    smartAccumulating: smartTraders.filter((entry) => num(entry.buy_volume_cur) > num(entry.sell_volume_cur)).length,
    smartExiting: smartTraders.filter((entry) => num(entry.sell_volume_cur) > num(entry.buy_volume_cur)).length,
    mostlyExited: combined.filter((entry) =>
      (hasTag(entry, "kol") || hasTag(entry, "smart_degen")) &&
      num(entry.sell_amount_percentage) >= 0.8
    ).length,
    kolHolderNames: kolHolders.map(entryName).filter(Boolean).slice(0, 12),
    kolProfitNames: kolTraders.sort((a, b) => num(b.profit) - num(a.profit)).map(entryName).filter(Boolean).slice(0, 12),
    preferredKolHolding: preferredKolHolders.length,
    preferredKolHolders: preferredKolHolders.map((entry) => ({
      name: entryName(entry),
      amountPct: Number(entryAmountPct(entry).toFixed(2)),
    })),
    dumpKolSignificantCount: dumpKolSignificant.length,
    dumpKolMinorCount: Math.max(0, dumpKolHoldersAll.length - dumpKolSignificant.length),
    dumpKolHolders: dumpKolSignificant.map((entry) => ({
      name: entryName(entry),
      amountPct: Number(entryAmountPct(entry).toFixed(2)),
    })),
    bundlerTopHolderCount: holders.filter((entry) => hasTag(entry, "bundler")).length,
    sniperTopHolderCount: sniperTopHolders.length,
    sniperHoldRate,
  };
}

async function fetchTopMeteoraDlmmPoolsForMint(mint, minTvl = 0, limit = 2) {
  const filterBy = minTvl > 0 ? `&filter_by=${encodeURIComponent(`tvl>${minTvl}`)}` : "";
  const url = `${METEORA_DLMM_API}/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent("tvl:desc")}${filterBy}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Meteora pool search ${res.status}`);
  const data = await res.json();
  const pools = Array.isArray(data?.data) ? data.data : [];
  return pools
    .filter((pool) => {
      const baseMatches = pool?.token_x?.address === mint || pool?.token_x_mint === mint;
      const quoteIsSol =
        pool?.token_y?.address === config.tokens.SOL ||
        pool?.token_y_mint === config.tokens.SOL ||
        pool?.token_y?.symbol === "SOL";
      return baseMatches && quoteIsSol;
    })
    .slice(0, limit);
}

async function fetchPoolDetailDirect(poolAddress) {
  const timeframe = encodeURIComponent(getVolatilityTimeframe(config.screening?.timeframe || "5m"));
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=${timeframe}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return null;
  const data = await res.json();
  return (data?.data || [])[0] ?? null;
}

async function pickBestPool(pools) {
  const details = await Promise.all(
    pools.map((pool) => fetchPoolDetailDirect(pool.address || pool.pool_address).catch(() => null)),
  );
  if (pools.length <= 1) return { pool: pools[0] ?? null, detail: details[0] ?? null };
  const scored = pools.map((pool, index) => {
    const detail = details[index];
    const activeTvl = num(detail?.active_tvl ?? pool.active_tvl ?? pool.tvl ?? pool.liquidity);
    const feeActiveTvlRatio = Number(detail?.fee_active_tvl_ratio) > 0
      ? Number(detail.fee_active_tvl_ratio)
      : (activeTvl > 0 ? (num(detail?.fee) / activeTvl) * 100 : 0);
    return { pool, detail, feeActiveTvlRatio, activeTvl };
  });
  scored.sort((a, b) => b.feeActiveTvlRatio - a.feeActiveTvlRatio || b.activeTvl - a.activeTvl);
  return { pool: scored[0].pool, detail: scored[0].detail };
}

function condenseGmgnCandidate({ token, pool, poolDetail, info, infoAnalysis, holdersAnalysis }) {
  const poolAddress = pool.address || pool.pool_address;
  const activeTvl = num(poolDetail?.active_tvl ?? pool.tvl ?? pool.liquidity);
  const feeActiveTvlRatio = Number(poolDetail?.fee_active_tvl_ratio) > 0
    ? Number(Number(poolDetail.fee_active_tvl_ratio).toFixed(4))
    : (activeTvl > 0 ? Number(((num(poolDetail?.fee) / activeTvl) * 100).toFixed(4)) : 0);
  const kolCount = holdersAnalysis.kolHolding || num(token.renowned_count) || num(info?.wallet_tags_stat?.renowned_wallets);
  const smartCount = holdersAnalysis.smartHolding + holdersAnalysis.smartAccumulating || num(token.smart_degen_count) || num(info?.wallet_tags_stat?.smart_wallets);
  const gmgnScore =
    num(token.volume) / 100 +
    num(token.smart_degen_count) * 50 +
    kolCount * 35 +
    num(holdersAnalysis?.preferredKolHolding) * 75 -
    num(holdersAnalysis?.dumpKolSignificantCount) * 100 -
    num(holdersAnalysis?.dumpKolMinorCount) * 20 +
    feeActiveTvlRatio * 1000;
  const mint = tokenAddress(token) || info.address || pool.token_x?.address;
  const ageHours = tokenAgeHours(token);

  return {
    pool: poolAddress,
    name: pool.name || `${token.symbol || info.symbol || "?"}-SOL`,
    base: {
      symbol: token.symbol || info.symbol || pool.token_x?.symbol,
      mint,
      organic: optionalNum(poolDetail?.token_x?.organic_score ?? pool.token_x?.organic_score),
      warnings: 0,
    },
    quote: {
      symbol: pool.token_y?.symbol || "SOL",
      mint: pool.token_y?.address || config.tokens.SOL,
      organic: optionalNum(poolDetail?.token_y?.organic_score ?? pool.token_y?.organic_score),
    },
    pool_type: "dlmm",
    bin_step: pool.pool_config?.bin_step ?? poolDetail?.dlmm_params?.bin_step ?? null,
    fee_pct: pool.pool_config?.base_fee_pct ?? poolDetail?.fee_pct ?? null,
    active_tvl: round(activeTvl),
    fee_active_tvl_ratio: feeActiveTvlRatio,
    volatility: poolDetail?.volatility != null ? Number(Number(poolDetail.volatility).toFixed(4)) : null,
    volatility_timeframe: getVolatilityTimeframe(config.screening?.timeframe || "5m"),
    holders: num(token.holder_count || info.holder_count),
    mcap: round(num(token.market_cap || (num(info.price) * num(info.circulating_supply)))),
    organic_score: optionalNum(poolDetail?.token_x?.organic_score ?? pool.token_x?.organic_score),
    quote_organic_score: optionalNum(poolDetail?.token_y?.organic_score ?? pool.token_y?.organic_score),
    token_age_hours: ageHours != null ? Math.floor(ageHours) : null,
    dev: info.dev?.creator_address || info.creator_address || null,
    price: num(info.price || token.price),
    price_change_pct: num(token.price_change_percent5m ?? token.price_change_percent),
    volume: num(token.volume ?? 0),
    volume_window: num(token.volume ?? 0),
    swap_count: token.swaps ?? null,
    source: "gmgn",
    discovery_source: "gmgn",
    gmgn: true,
    gmgn_score: Number(gmgnScore.toFixed(2)),
    gmgn_total_fee_sol: num(infoAnalysis?.totalFeeSol ?? info.total_fee),
    gmgn_trade_fee_sol: num(infoAnalysis?.tradeFeeSol ?? info.trade_fee),
    gmgn_smart_wallets: smartCount,
    gmgn_kol_wallets: kolCount,
    gmgn_kol_names: holdersAnalysis?.kolHolderNames || [],
    gmgn_kol_profit_names: holdersAnalysis?.kolProfitNames || [],
    gmgn_preferred_kol_matches: num(holdersAnalysis?.preferredKolHolding),
    gmgn_preferred_kol_holders: holdersAnalysis?.preferredKolHolders || [],
    gmgn_dump_kol_significant: num(holdersAnalysis?.dumpKolSignificantCount),
    gmgn_dump_kol_minor: num(holdersAnalysis?.dumpKolMinorCount),
    gmgn_dump_kol_holders: holdersAnalysis?.dumpKolHolders || [],
    gmgn_token_info_top10_pct: infoAnalysis?.top10HolderPct ?? null,
    gmgn_dev_team_hold_pct: infoAnalysis?.devTeamHoldPct ?? null,
    gmgn_fresh_wallet_pct: infoAnalysis?.freshWalletPct ?? null,
    gmgn_bot_degen_pct: infoAnalysis?.botDegenPct ?? null,
    gmgn_token_info_bundler_pct: infoAnalysis?.bundlerPct ?? null,
    gmgn_token_info_insider_pct: infoAnalysis?.insiderPct ?? null,
    gmgn_sniper_wallets: infoAnalysis?.sniperWallets ?? null,
    gmgn_bundler_wallets: infoAnalysis?.bundlerWallets ?? null,
    gmgn_whale_wallets: infoAnalysis?.whaleWallets ?? null,
    gmgn_fresh_wallets: infoAnalysis?.freshWallets ?? null,
    gmgn_kol_holding: holdersAnalysis.kolHolding,
    gmgn_smart_holding: holdersAnalysis.smartHolding,
    gmgn_smart_accumulating: holdersAnalysis.smartAccumulating,
    gmgn_smart_exiting: holdersAnalysis.smartExiting,
    gmgn_mostly_exited: holdersAnalysis.mostlyExited,
    price_vs_ath_pct: infoAnalysis?.priceVsAthPct != null ? Number(infoAnalysis.priceVsAthPct.toFixed(2)) : null,
    ath: info.ath_price || null,
    launchpad: token.launchpad_platform || info.launchpad_platform || info.launchpad || null,
  };
}

export async function discoverGmgnPools({ limit = 10 } = {}) {
  const g = config.gmgn;
  const filtered = [];
  const stageCounts = {};

  const rankPayload = await gmgnFetch("/v1/market/rank", {
    params: {
      chain: "sol",
      interval: normalizeInterval(g.interval),
      order_by: g.orderBy || "volume",
      direction: g.direction || "desc",
      limit: Math.min(100, Math.max(1, Number(g.limit || 100))),
      filters: g.filters || [],
      platforms: g.platforms || [],
    },
  });
  const ranked = unwrapList(rankPayload, ["rank", "list", "data"]);
  const s1 = ranked.filter((token) => {
    const check = passBasicRankFilter(token);
    if (!check.pass) {
      filtered.push({ stage: "gmgn_rank_filter", name: token.symbol || tokenAddress(token), reason: check.reasons.join(", ") });
      return false;
    }
    return true;
  }).sort((a, b) => num(b.volume) - num(a.volume))
    .slice(0, Math.max(limit, Number(g.enrichLimit || 20)));
  stageCounts.rank_filter = s1.length;
  log("gmgn", `Stage1 rank: ${ranked.length} -> ${s1.length} pass`);

  const s2 = [];
  for (const token of s1) {
    const mint = tokenAddress(token);
    if (!mint) {
      filtered.push({ stage: "gmgn_token_info", name: token.symbol || "unknown", reason: "missing token address" });
      continue;
    }
    try {
      const infoPayload = await gmgnFetch("/v1/token/info", { params: { chain: "sol", address: mint } });
      const info = infoPayload?.data?.data || infoPayload?.data || infoPayload;
      const infoCheck = analyzeTokenInfo(info);
      if (!infoCheck.passed) {
        filtered.push({ stage: "gmgn_token_info", name: token.symbol || mint, reason: infoCheck.reasons.join(", ") });
        continue;
      }
      s2.push({ token, info, infoCheck, mint });
    } catch (error) {
      filtered.push({ stage: "gmgn_token_info", name: token.symbol || mint, reason: error.message });
    }
  }
  stageCounts.token_info = s2.length;
  log("gmgn", `Stage2 info: ${s1.length} -> ${s2.length} pass`);

  const s3 = [];
  const minTvl = num(g.minTvl ?? config.screening.minTvl ?? 0);
  for (const { token, info, infoCheck, mint } of s2) {
    try {
      const [holdersPayload, tradersPayload] = await Promise.all([
        gmgnFetch("/v1/market/token_top_holders", {
          params: { chain: "sol", address: mint, limit: g.holdersLimit || 100, order_by: "amount_percentage", direction: "desc" },
        }),
        gmgnFetch("/v1/market/token_top_traders", {
          params: { chain: "sol", address: mint, limit: g.holdersLimit || 100, order_by: "profit", direction: "desc" },
        }),
      ]);
      const holders = unwrapList(holdersPayload, ["list", "holders", "data"]);
      const traders = unwrapList(tradersPayload, ["list", "traders", "data"]);
      const holdersCheck = analyzeHoldersAndTraders(holders, traders);
      if (!holdersCheck.passed) {
        filtered.push({ stage: "gmgn_holders_traders", name: token.symbol || mint, reason: holdersCheck.reasons.join(", ") });
        continue;
      }
      if (g.requireKol && holdersCheck.kolHolding < g.minKolCount) {
        filtered.push({ stage: "gmgn_holders_traders", name: token.symbol || mint, reason: `KOL holders ${holdersCheck.kolHolding} < ${g.minKolCount}` });
        continue;
      }
      if (holdersCheck.smartHolding + holdersCheck.smartAccumulating < g.minSmartDegenCount) {
        filtered.push({ stage: "gmgn_holders_traders", name: token.symbol || mint, reason: `smart wallets ${holdersCheck.smartHolding + holdersCheck.smartAccumulating} < ${g.minSmartDegenCount}` });
        continue;
      }
      const topPools = await fetchTopMeteoraDlmmPoolsForMint(mint, minTvl, 2);
      if (topPools.length === 0) {
        filtered.push({ stage: "gmgn_meteora_pool_map", name: token.symbol || mint, reason: `no SOL DLMM pool above tvl>${minTvl}` });
        continue;
      }
      s3.push({ token, info, infoCheck, holdersCheck, topPools, mint });
    } catch (error) {
      filtered.push({ stage: "gmgn_holders_traders", name: token.symbol || mint, reason: error.message });
    }
  }
  stageCounts.holders_traders = s3.length;
  log("gmgn", `Stage3 pool: ${s2.length} -> ${s3.length} pass`);

  const pools = [];
  for (const { token, info, infoCheck, holdersCheck, topPools, mint } of s3) {
    if (pools.length >= limit) break;
    try {
      const { pool, detail: poolDetail } = await pickBestPool(topPools);
      if (!pool) {
        filtered.push({ stage: "gmgn_candidate_shape", name: token.symbol || mint, reason: "pool selection failed" });
        continue;
      }
      const candidate = condenseGmgnCandidate({ token, pool, poolDetail, info, infoAnalysis: infoCheck, holdersAnalysis: holdersCheck });
      if (!candidate.pool || !candidate.base?.mint) {
        filtered.push({ stage: "gmgn_candidate_shape", name: token.symbol || mint, reason: "incomplete pool mapping" });
        continue;
      }
      pools.push(candidate);
    } catch (error) {
      filtered.push({ stage: "gmgn_candidate_shape", name: token.symbol || mint, reason: error.message });
    }
  }
  stageCounts.candidate_shape = pools.length;
  log("gmgn", `Stage4 final: ${s3.length} -> ${pools.length} candidates`);

  return {
    total: ranked.length,
    stage_counts: stageCounts,
    pools,
    filtered_examples: filtered,
  };
}

function round(n) {
  return n != null ? Math.round(n) : null;
}
