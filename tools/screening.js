import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isDevBlocked, getBlockedDevs } from "../dev-blocklist.js";
import { log } from "../logger.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { confirmIndicatorPreset } from "./chart-indicators.js";
import { discoverGmgnPools } from "./gmgn.js";
import { scoreSignalSnapshot } from "../signal-weights.js";
import {
  appendDecisionContext,
  buildCandidateDecisionContext,
  summarizeIndicatorConfirmation,
} from "../decision-context-log.js";

const DATAPI_JUP = "https://datapi.jup.ag/v1";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
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
const PVP_SHORTLIST_LIMIT = 2;
const PVP_RIVAL_LIMIT = 2;
const PVP_MIN_ACTIVE_TVL = 5_000;
const PVP_MIN_HOLDERS = 500;
const PVP_MIN_GLOBAL_FEES_SOL = 30;

function finiteNumberOrNull(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function scoreCandidate(pool) {
  const feeTvl = Number(pool.fee_active_tvl_ratio || 0);
  const organic = Number(pool.organic_score || 0);
  const volume = Number(pool.volume_window || 0);
  const holders = Number(pool.holders || 0);
  return feeTvl * 1000 + organic * 10 + volume / 100 + holders / 100;
}

function candidatePoolAddress(candidate = {}) {
  return candidate.pool ?? candidate.pool_address ?? candidate.address ?? null;
}

function candidateBaseMint(candidate = {}) {
  return candidate.base?.mint ?? candidate.base_mint ?? candidate.token_x?.address ?? candidate.token_x_mint ?? null;
}

function buildSourceEvidence(candidate = {}) {
  return {
    source: candidate.source ?? candidate.discovery_source ?? null,
    pool: candidatePoolAddress(candidate),
    base_mint: candidateBaseMint(candidate),
    name: candidate.name ?? null,
    active_tvl: candidate.active_tvl ?? candidate.tvl ?? null,
    volume_window: candidate.volume_window ?? candidate.volume ?? null,
    fee_active_tvl_ratio: candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio ?? null,
    bin_step: candidate.bin_step ?? candidate.dlmm_params?.bin_step ?? null,
    volatility: candidate.volatility ?? null,
    volatility_timeframe: candidate.volatility_timeframe ?? null,
    mcap: candidate.mcap ?? null,
    holders: candidate.holders ?? candidate.holder_count ?? null,
    gmgn_score: candidate.gmgn_score ?? null,
    gmgn_total_fee_sol: candidate.gmgn_total_fee_sol ?? null,
  };
}

function isMeteoraSolDlmmCandidate(candidate = {}, runtimeConfig = config) {
  const quoteMint = candidate.quote?.mint ?? candidate.token_y?.address ?? candidate.token_y_mint ?? null;
  const quoteSymbol = normalizeSymbol(candidate.quote?.symbol ?? candidate.token_y?.symbol);
  const poolType = String(candidate.pool_type ?? "").toLowerCase();
  const activeTvl = candidateThresholdNumber(candidate, "active_tvl", "tvl");
  const volume = candidateThresholdNumber(candidate, "volume_window", "volume");
  const feeActiveTvlRatio = candidateThresholdNumber(candidate, "fee_active_tvl_ratio", "fee_tvl_ratio");
  const binStep = candidateThresholdNumber(candidate, "bin_step", "dlmm_params.bin_step");
  const volatility = candidateThresholdNumber(candidate, "volatility");
  return Boolean(
    candidatePoolAddress(candidate) &&
    candidateBaseMint(candidate) &&
    (poolType === "dlmm" || poolType === "") &&
    (quoteMint === runtimeConfig.tokens?.SOL || quoteSymbol === "SOL") &&
    activeTvl != null && activeTvl > 0 &&
    volume != null && volume >= 0 &&
    feeActiveTvlRatio != null && feeActiveTvlRatio > 0 &&
    binStep != null && binStep > 0 &&
    volatility != null && volatility > 0
  );
}

function mergeCandidateSources(gmgnCandidate, meteoraCandidate, {
  sourceResolution,
  discoverySources,
  sourceMode = "both",
  sameMintAlternatives = [],
} = {}) {
  const preferredMetrics = meteoraCandidate || {};
  const gmgnEvidence = gmgnCandidate ? buildSourceEvidence(gmgnCandidate) : null;
  const meteoraEvidence = meteoraCandidate ? buildSourceEvidence(meteoraCandidate) : null;
  const merged = {
    ...(gmgnCandidate || {}),
    ...(meteoraCandidate || {}),
    source: sourceMode,
    source_mode: sourceMode,
    discovery_source: sourceMode,
    discovery_sources: discoverySources,
    source_resolution: sourceResolution,
    source_evidence: {
      gmgn: gmgnEvidence,
      meteora: meteoraEvidence,
      same_mint_alternatives: sameMintAlternatives,
    },
  };

  for (const key of [
    "active_tvl",
    "volume_window",
    "fee_active_tvl_ratio",
    "bin_step",
    "volatility",
    "volatility_timeframe",
    "organic_score",
    "quote_organic_score",
  ]) {
    if (preferredMetrics[key] != null) merged[key] = preferredMetrics[key];
  }

  if (preferredMetrics.base?.organic != null) merged.base = { ...(merged.base || {}), organic: preferredMetrics.base.organic };
  if (preferredMetrics.quote?.organic != null) merged.quote = { ...(merged.quote || {}), organic: preferredMetrics.quote.organic };
  if (gmgnCandidate) {
    for (const [key, value] of Object.entries(gmgnCandidate)) {
      if (key.startsWith("gmgn_") && value != null) merged[key] = value;
    }
    if (gmgnCandidate.gmgn != null) merged.gmgn = gmgnCandidate.gmgn;
  }

  return merged;
}

export function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

async function fetchPoolDiscoveryPage({ page_size, filters, timeframe, category }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${page_size}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${encodeURIComponent(timeframe)}` +
    `&category=${encodeURIComponent(category)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function fetchPoolDiscoveryDetail({ poolAddress, timeframe }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}` +
    `&timeframe=${encodeURIComponent(timeframe)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return (data.data || [])[0] ?? null;
}

async function applyVolatilityTimeframe(rawPools, sourceTimeframe) {
  if (!Array.isArray(rawPools) || rawPools.length === 0) return rawPools;
  const volatilityTimeframe = getVolatilityTimeframe(sourceTimeframe);
  if (sourceTimeframe === volatilityTimeframe) {
    for (const pool of rawPools) {
      if (pool) pool.volatility_timeframe = volatilityTimeframe;
    }
    return rawPools;
  }

  const uniquePoolAddresses = [...new Set(rawPools.map((pool) => pool?.pool_address).filter(Boolean))];
  const volatilityResults = await Promise.allSettled(
    uniquePoolAddresses.map((poolAddress) =>
      fetchPoolDiscoveryDetail({ poolAddress, timeframe: volatilityTimeframe })
        .then((pool) => ({ poolAddress, volatility: finiteNumberOrNull(pool?.volatility) }))
    )
  );

  const volatilityByPool = new Map();
  for (const result of volatilityResults) {
    if (result.status !== "fulfilled") continue;
    if (result.value.volatility == null) continue;
    volatilityByPool.set(result.value.poolAddress, result.value.volatility);
  }

  for (const pool of rawPools) {
    if (!pool?.pool_address) continue;
    pool.volatility = volatilityByPool.has(pool.pool_address)
      ? volatilityByPool.get(pool.pool_address)
      : null;
    pool.volatility_timeframe = volatilityTimeframe;
  }

  return rawPools;
}

async function fetchDiscordSignalCandidates() {
  const res = await fetch(`${config.api.url}/signals/discord/candidates`, {
    headers: config.api.publicApiKey ? { "x-api-key": config.api.publicApiKey } : {},
  });
  if (!res.ok) throw new Error(`discord signal candidates ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.candidates) ? data.candidates : [];
}

async function searchAssetsBySymbol(symbol) {
  const res = await fetch(`${DATAPI_JUP}/assets/search?query=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`assets/search ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [data];
}

async function fetchJupiterTokenSnapshot(mint) {
  if (!mint) return null;
  const res = await fetch(`${DATAPI_JUP}/assets/search?query=${encodeURIComponent(mint)}`);
  if (!res.ok) throw new Error(`assets/search ${res.status}`);
  const data = await res.json();
  const tokens = Array.isArray(data) ? data : [data];
  const token = tokens.find((item) => item?.id === mint) || tokens[0];
  if (!token) return null;
  const createdAtRaw = token.createdAt ?? token.created_at ?? token.firstPool?.createdAt ?? null;
  const createdAtMs = createdAtRaw == null
    ? null
    : (Number(createdAtRaw) < 10_000_000_000 ? Number(createdAtRaw) * 1000 : Number(createdAtRaw));

  return {
    mint: token.id ?? mint,
    mcap: finiteNumberOrNull(token.mcap ?? token.marketCap),
    global_fees_sol: finiteNumberOrNull(token.fees),
    token_age_hours: Number.isFinite(createdAtMs)
      ? Math.floor((Date.now() - createdAtMs) / 3_600_000)
      : null,
    stats_1h: token.stats1h ? {
      price_change: finiteNumberOrNull(token.stats1h.priceChange),
      buy_vol: finiteNumberOrNull(token.stats1h.buyVolume),
      sell_vol: finiteNumberOrNull(token.stats1h.sellVolume),
    } : null,
  };
}

async function enrichJupiterTokenSnapshots(pools) {
  const results = await Promise.allSettled(
    pools.map((pool) => fetchJupiterTokenSnapshot(pool.base?.mint)),
  );

  results.forEach((result, index) => {
    if (result.status !== "fulfilled" || !result.value) {
      const mint = pools[index]?.base?.mint;
      if (mint) log("screening", `Jupiter token snapshot unavailable for ${pools[index].name} (${mint.slice(0, 8)})`);
      return;
    }

    const snapshot = result.value;
    pools[index].token_info = snapshot;
    pools[index].global_fees_sol = snapshot.global_fees_sol;
    pools[index].stats_1h = snapshot.stats_1h;
    pools[index].buy_vol = snapshot.stats_1h?.buy_vol ?? null;
    pools[index].sell_vol = snapshot.stats_1h?.sell_vol ?? null;
    if (pools[index].mcap == null && snapshot.mcap != null) pools[index].mcap = snapshot.mcap;
    if (pools[index].token_age_hours == null && snapshot.token_age_hours != null) {
      pools[index].token_age_hours = snapshot.token_age_hours;
    }
  });
}

async function findRivalPool(mint) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent("tvl:desc")}&filter_by=${encodeURIComponent(`tvl>${PVP_MIN_ACTIVE_TVL}`)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`rival pool search ${res.status}`);
  const data = await res.json();
  const pools = Array.isArray(data?.data) ? data.data : [];
  return pools.find((pool) => pool?.token_x?.address === mint || pool?.token_y?.address === mint) || null;
}

function getMostNegativeNumber(...values) {
  const nums = values
    .map(finiteNumberOrNull)
    .filter((value) => value != null);
  return nums.length > 0 ? Math.min(...nums) : null;
}

function getCandidatePriceChange1hPct(candidate = {}) {
  return getMostNegativeNumber(
    candidate.price_change_pct,
    candidate.price_change_1h,
    candidate.change_1h,
    candidate.stats_1h?.price_change,
    candidate.token_info?.stats_1h?.price_change,
  );
}

function getCandidateSellBuyRatio(candidate = {}) {
  const sellVol = finiteNumberOrNull(
    candidate.sell_vol ?? candidate.stats_1h?.sell_vol ?? candidate.token_info?.stats_1h?.sell_vol,
  );
  const buyVol = finiteNumberOrNull(
    candidate.buy_vol ?? candidate.stats_1h?.buy_vol ?? candidate.token_info?.stats_1h?.buy_vol,
  );
  if (sellVol == null || buyVol == null || buyVol <= 0) {
    return { sellVol, buyVol, ratio: null };
  }
  return { sellVol, buyVol, ratio: sellVol / buyVol };
}

function candidateHasOversoldRsi(candidate = {}) {
  const values = [
    candidate.rsi,
    candidate.rsi_1h,
    candidate.rsi_5m,
    candidate.indicator_confirmation?.rsi,
    ...(Array.isArray(candidate.indicator_confirmation?.intervals)
      ? candidate.indicator_confirmation.intervals.map((interval) => interval?.rsi)
      : []),
  ].map(finiteNumberOrNull).filter((value) => value != null);
  return values.some((value) => value <= 35);
}

export function getFallingKnifeVetoReason(candidate = {}, screeningConfig = {}) {
  if (!screeningConfig.fallingKnifeVetoEnabled) return null;

  const priceChange = getCandidatePriceChange1hPct(candidate);
  if (priceChange == null) return null;
  if (screeningConfig.fallingKnifeRequireOversoldRsi && !candidateHasOversoldRsi(candidate)) return null;

  const severeDrop = finiteNumberOrNull(screeningConfig.fallingKnifeSeverePriceChangePct) ?? -45;
  const maxDrop = finiteNumberOrNull(screeningConfig.fallingKnifeMaxPriceChange1hPct) ?? -35;
  const minSellBuyRatio = finiteNumberOrNull(screeningConfig.fallingKnifeMinSellBuyRatio) ?? 1.25;
  const { ratio } = getCandidateSellBuyRatio(candidate);

  if (priceChange <= severeDrop) {
    const ratioLabel = ratio == null ? "unavailable" : ratio.toFixed(2);
    return `falling knife veto: 1h price_change=${priceChange.toFixed(1)}%, sell/buy=${ratioLabel}`;
  }

  if (priceChange <= maxDrop && ratio != null && ratio >= minSellBuyRatio) {
    return `falling knife veto: 1h price_change=${priceChange.toFixed(1)}%, sell/buy=${ratio.toFixed(2)}`;
  }

  return null;
}

export function getSuspiciousVolumeVetoReason(candidate = {}, screeningConfig = {}) {
  if (!screeningConfig.suspiciousVolumeVetoEnabled) return null;

  const mcap = finiteNumberOrNull(candidate.mcap ?? candidate.token_info?.mcap);
  const globalFeesSol = finiteNumberOrNull(candidate.global_fees_sol ?? candidate.token_info?.global_fees_sol);
  const ageHours = finiteNumberOrNull(candidate.token_age_hours ?? candidate.token_info?.token_age_hours);
  const priceChange = getCandidatePriceChange1hPct(candidate);
  const maxRatio = finiteNumberOrNull(screeningConfig.suspiciousVolumeMaxMcapToGlobalFeesRatio) ?? 12000;
  const minGlobalFees = finiteNumberOrNull(screeningConfig.suspiciousVolumeMinGlobalFeesSol) ?? 20;
  const maxAgeHours = finiteNumberOrNull(screeningConfig.suspiciousVolumeMaxTokenAgeHours) ?? 96;
  const minPriceDrop = finiteNumberOrNull(screeningConfig.suspiciousVolumeMinPriceDropPct) ?? -25;

  if (mcap == null || globalFeesSol == null || globalFeesSol <= 0 || ageHours == null || priceChange == null) {
    return null;
  }

  const ratio = mcap / globalFeesSol;
  if (
    ageHours <= maxAgeHours &&
    globalFeesSol >= minGlobalFees &&
    ratio <= maxRatio &&
    priceChange <= minPriceDrop
  ) {
    return `suspicious volume/fees veto: mcap/global_fees=${Math.round(ratio)}, age=${Math.round(ageHours)}h, price_change=${priceChange.toFixed(1)}%`;
  }

  return null;
}

export function getDeterministicCandidateVetoReason(candidate = {}, screeningConfig = {}) {
  return getFallingKnifeVetoReason(candidate, screeningConfig)
    || getSuspiciousVolumeVetoReason(candidate, screeningConfig);
}

function formatAuditNumber(value, decimals) {
  const num = finiteNumberOrNull(value);
  return num == null ? null : num.toFixed(decimals);
}

export function getDeterministicVetoAuditSnapshot(candidate = {}) {
  const priceChange = getCandidatePriceChange1hPct(candidate);
  const { ratio: sellBuyRatio } = getCandidateSellBuyRatio(candidate);
  const mcap = finiteNumberOrNull(candidate.mcap ?? candidate.token_info?.mcap);
  const globalFeesSol = finiteNumberOrNull(candidate.global_fees_sol ?? candidate.token_info?.global_fees_sol);
  const tokenAgeHours = finiteNumberOrNull(candidate.token_age_hours ?? candidate.token_info?.token_age_hours);
  const mcapGlobalFeesRatio = mcap != null && globalFeesSol != null && globalFeesSol > 0
    ? mcap / globalFeesSol
    : null;

  return {
    price_change_pct: priceChange,
    sell_buy_ratio: sellBuyRatio,
    mcap_global_fees_ratio: mcapGlobalFeesRatio,
    token_age_hours: tokenAgeHours,
  };
}

function getIndicatorDecisionStage(confirmation = {}) {
  if (confirmation.skipped) return "indicator_skip";
  return confirmation.confirmed ? "indicator_accept" : "indicator_reject";
}

function configuredNumber(value) {
  const num = finiteNumberOrNull(value);
  return num == null ? null : num;
}

function candidateThresholdNumber(candidate = {}, ...paths) {
  for (const path of paths) {
    const value = path.split(".").reduce((current, key) => current?.[key], candidate);
    const num = finiteNumberOrNull(value);
    if (num != null) return num;
  }
  return null;
}

function formatThresholdValue(value) {
  return value == null ? "missing" : String(value);
}

export function getConfiguredPoolThresholdVetoReason(candidate = {}, screeningConfig = {}) {
  const feeActiveTvlRatio = candidateThresholdNumber(candidate, "fee_active_tvl_ratio", "fee_tvl_ratio");
  const minFeeActiveTvlRatio = configuredNumber(screeningConfig.minFeeActiveTvlRatio);
  if (minFeeActiveTvlRatio != null && (feeActiveTvlRatio == null || feeActiveTvlRatio < minFeeActiveTvlRatio)) {
    return `configured threshold veto: fee_active_tvl_ratio ${formatThresholdValue(feeActiveTvlRatio)} < ${minFeeActiveTvlRatio}`;
  }

  const volatility = candidateThresholdNumber(candidate, "volatility");
  if (volatility == null || volatility <= 0) {
    const timeframe = candidate.volatility_timeframe || getVolatilityTimeframe(screeningConfig.timeframe);
    return `configured threshold veto: volatility_${timeframe} ${formatThresholdValue(volatility)} must be > 0`;
  }

  const binStep = candidateThresholdNumber(candidate, "bin_step", "dlmm_params.bin_step");
  const minBinStep = configuredNumber(screeningConfig.minBinStep);
  if (minBinStep != null && (binStep == null || binStep < minBinStep)) {
    return `configured threshold veto: bin_step ${formatThresholdValue(binStep)} < ${minBinStep}`;
  }
  const maxBinStep = configuredNumber(screeningConfig.maxBinStep);
  if (maxBinStep != null && (binStep == null || binStep > maxBinStep)) {
    return `configured threshold veto: bin_step ${formatThresholdValue(binStep)} > ${maxBinStep}`;
  }

  const tvl = candidateThresholdNumber(candidate, "active_tvl", "tvl");
  const minTvl = configuredNumber(screeningConfig.minTvl);
  if (minTvl != null && (tvl == null || tvl < minTvl)) {
    return `configured threshold veto: tvl ${formatThresholdValue(tvl)} < ${minTvl}`;
  }
  const maxTvl = configuredNumber(screeningConfig.maxTvl);
  if (maxTvl != null && (tvl == null || tvl > maxTvl)) {
    return `configured threshold veto: tvl ${formatThresholdValue(tvl)} > ${maxTvl}`;
  }

  const volume = candidateThresholdNumber(candidate, "volume_window", "volume");
  const minVolume = configuredNumber(screeningConfig.minVolume);
  if (minVolume != null && (volume == null || volume < minVolume)) {
    return `configured threshold veto: volume ${formatThresholdValue(volume)} < ${minVolume}`;
  }

  const mcap = candidateThresholdNumber(candidate, "mcap", "token_info.mcap");
  const minMcap = configuredNumber(screeningConfig.minMcap);
  if (minMcap != null && (mcap == null || mcap < minMcap)) {
    return `configured threshold veto: mcap ${formatThresholdValue(mcap)} < ${minMcap}`;
  }
  const maxMcap = configuredNumber(screeningConfig.maxMcap);
  if (maxMcap != null && (mcap == null || mcap > maxMcap)) {
    return `configured threshold veto: mcap ${formatThresholdValue(mcap)} > ${maxMcap}`;
  }

  const holders = candidateThresholdNumber(candidate, "holders", "holder_count", "base_token_holders");
  const minHolders = configuredNumber(screeningConfig.minHolders);
  if (minHolders != null && (holders == null || holders < minHolders)) {
    return `configured threshold veto: holders ${formatThresholdValue(holders)} < ${minHolders}`;
  }

  const organicScore = candidateThresholdNumber(candidate, "organic_score", "base.organic", "token_x.organic_score");
  const minOrganic = configuredNumber(screeningConfig.minOrganic);
  if (minOrganic != null && (organicScore == null || organicScore < minOrganic)) {
    return `configured threshold veto: organic_score ${formatThresholdValue(organicScore)} < ${minOrganic}`;
  }

  const quoteOrganic = candidateThresholdNumber(candidate, "quote.organic", "quote_organic_score", "token_y.organic_score");
  const minQuoteOrganic = configuredNumber(screeningConfig.minQuoteOrganic);
  if (minQuoteOrganic != null && (quoteOrganic == null || quoteOrganic < minQuoteOrganic)) {
    return `configured threshold veto: quote_organic_score ${formatThresholdValue(quoteOrganic)} < ${minQuoteOrganic}`;
  }

  return null;
}

function filterConfiguredPoolThresholds(pools = [], screeningConfig = {}, filteredOut = [], stageCounts = {}) {
  const accepted = [];
  for (const pool of pools) {
    const vetoReason = getConfiguredPoolThresholdVetoReason(pool, screeningConfig);
    if (vetoReason) {
      log("screening", `Configured threshold filter: dropped ${pool.name || pool.pool || "unknown"} — ${vetoReason}`);
      pushFilteredReason(filteredOut, pool, vetoReason, { priority: true });
      stageCounts.configured_threshold_reject = (stageCounts.configured_threshold_reject || 0) + 1;
    } else {
      accepted.push(pool);
    }
  }
  stageCounts.configured_threshold_accept = accepted.length;
  return accepted;
}

export function formatDeterministicVetoAuditLine(candidate = {}, reason = "deterministic veto") {
  const name = candidate.name || `${candidate.base?.symbol || "?"}-${candidate.quote?.symbol || "?"}`;
  const snapshot = getDeterministicVetoAuditSnapshot(candidate);
  const fields = [
    ["price_change", formatAuditNumber(snapshot.price_change_pct, 1), "%"],
    ["sell/buy", formatAuditNumber(snapshot.sell_buy_ratio, 2), ""],
    ["mcap/global_fees", snapshot.mcap_global_fees_ratio == null ? null : String(Math.round(snapshot.mcap_global_fees_ratio)), ""],
    ["token_age_hours", snapshot.token_age_hours == null ? null : String(Math.round(snapshot.token_age_hours)), ""],
  ]
    .filter(([, value]) => value != null)
    .map(([label, value, suffix]) => `${label}=${value}${suffix}`);

  const detail = fields.length > 0 ? ` | ${fields.join(", ")}` : "";
  return `Deterministic veto: dropped ${name} — ${reason}${detail}`;
}

async function enrichPvpRisk(pools) {
  const shortlist = [...pools]
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, PVP_SHORTLIST_LIMIT);

  if (shortlist.length === 0) return;

  const symbolCache = new Map();

  await Promise.all(shortlist.map(async (pool) => {
    const symbol = normalizeSymbol(pool.base?.symbol);
    const ownMint = pool.base?.mint;
    if (!symbol || !ownMint) return;

    let assets = symbolCache.get(symbol);
    if (!assets) {
      assets = await searchAssetsBySymbol(symbol).catch(() => []);
      symbolCache.set(symbol, assets);
    }

    const rivalAssets = assets
      .filter((asset) => normalizeSymbol(asset?.symbol) === symbol && asset?.id && asset.id !== ownMint)
      .sort((a, b) => Number(b?.liquidity || 0) - Number(a?.liquidity || 0))
      .slice(0, PVP_RIVAL_LIMIT);

    for (const rival of rivalAssets) {
      const rivalHolders = Number(rival?.holderCount || 0);
      const rivalFees = Number(rival?.fees || 0);
      if (rivalHolders < PVP_MIN_HOLDERS || rivalFees < PVP_MIN_GLOBAL_FEES_SOL) continue;

      const rivalPool = await findRivalPool(rival.id).catch(() => null);
      if (!rivalPool) continue;

      pool.is_pvp = true;
      pool.pvp_risk = "high";
      pool.pvp_symbol = pool.base?.symbol || symbol;
      pool.pvp_rival_name = rival?.name || pool.pvp_symbol;
      pool.pvp_rival_mint = rival.id;
      pool.pvp_rival_pool = rivalPool.address;
      pool.pvp_rival_tvl = round(Number(rivalPool.tvl || 0));
      pool.pvp_rival_holders = rivalHolders;
      pool.pvp_rival_fees = Number(rivalFees.toFixed(2));
      log("screening", `PVP guard: ${pool.name} has active rival ${pool.pvp_rival_name} (${rival.id.slice(0, 8)})`);
      break;
    }
  }));
}



/**
 * Fetch pools from the Meteora Pool Discovery API.
 * Returns condensed data optimized for LLM consumption (saves tokens).
 */
export async function discoverPools({
  page_size = 50,
  category = null,
} = {}) {
  const s = config.screening;
  const discoveryCategory = category || s.category;
  const filters = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    s.excludeHighSupplyConcentration ? "base_token_has_high_supply_concentration=false" : null,
    s.excludeHighSingleOwnership ? "base_token_has_high_single_ownership=false" : null,
    "pool_type=dlmm",
    `base_token_market_cap>=${s.minMcap}`,
    `base_token_market_cap<=${s.maxMcap}`,
    `base_token_holders>=${s.minHolders}`,
    `volume>=${s.minVolume}`,
    `tvl>=${s.minTvl}`,
    s.maxTvl != null ? `tvl<=${s.maxTvl}` : null,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    `base_token_organic_score>=${s.minOrganic}`,
    `quote_token_organic_score>=${s.minQuoteOrganic}`,
    s.minTokenAgeHours != null ? `base_token_created_at<=${Date.now() - s.minTokenAgeHours * 3_600_000}` : null,
    s.maxTokenAgeHours != null ? `base_token_created_at>=${Date.now() - s.maxTokenAgeHours * 3_600_000}` : null,
  ].filter(Boolean).join("&&");

  const data = await fetchPoolDiscoveryPage({
    page_size,
    filters,
    timeframe: s.timeframe,
    category: discoveryCategory,
  });

  let rawPools = Array.isArray(data.data) ? data.data : [];

  if (config.screening.useDiscordSignals) {
    const signalCandidates = await fetchDiscordSignalCandidates().catch((error) => {
      log("screening", `Discord signal fetch failed: ${error.message}`);
      return [];
    });
    const signalPools = signalCandidates
      .map((candidate) => {
        const discoveryPool = candidate.discovery_pool;
        if (!discoveryPool?.pool_address) return null;
        return {
          ...discoveryPool,
          discord_signal: true,
          discord_signal_count: candidate.source_count || 1,
          discord_signal_seen_count: candidate.seen_count || 1,
          discord_signal_first_seen_at: candidate.first_seen_at || null,
          discord_signal_last_seen_at: candidate.last_seen_at || null,
        };
      })
      .filter(Boolean);

    if (config.screening.discordSignalMode === "only") {
      rawPools = signalPools;
    } else if (signalPools.length > 0) {
      const byPool = new Map(rawPools.map((pool) => [pool.pool_address, pool]));
      for (const signalPool of signalPools) {
        if (byPool.has(signalPool.pool_address)) {
          byPool.set(signalPool.pool_address, {
            ...byPool.get(signalPool.pool_address),
            discord_signal: true,
            discord_signal_count: signalPool.discord_signal_count,
            discord_signal_seen_count: signalPool.discord_signal_seen_count,
            discord_signal_first_seen_at: signalPool.discord_signal_first_seen_at,
            discord_signal_last_seen_at: signalPool.discord_signal_last_seen_at,
          });
        } else {
          byPool.set(signalPool.pool_address, signalPool);
        }
      }
      rawPools = Array.from(byPool.values());
    }
  }

  rawPools = await applyVolatilityTimeframe(rawPools, s.timeframe);

  const condensed = rawPools.map(condensePool);

  // Hard-filter blacklisted tokens and blocked deployers (what pool discovery already gave us)
  let pools = condensed.filter((p) => {
    if (isBlacklisted(p.base?.mint)) {
      log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in pool ${p.name}`);
      return false;
    }
    if (p.dev && isDevBlocked(p.dev)) {
      log("dev_blocklist", `Filtered blocked deployer ${p.dev?.slice(0, 8)} token ${p.base?.symbol} in pool ${p.name}`);
      return false;
    }
    return true;
  });

  const filtered = condensed.length - pools.length;
  if (filtered > 0) log("blacklist", `Filtered ${filtered} pool(s) with blacklisted tokens/devs`);

  // If pool discovery didn't supply dev field, batch-fetch from Jupiter for any pools
  // where dev is null — but only if the dev blocklist is non-empty (avoid useless calls)
  const blockedDevs = getBlockedDevs();
  if (Object.keys(blockedDevs).length > 0) {
    const missingDev = pools.filter((p) => !p.dev && p.base?.mint);
    if (missingDev.length > 0) {
      const devResults = await Promise.allSettled(
        missingDev.map((p) =>
          fetch(`${DATAPI_JUP}/assets/search?query=${p.base.mint}`)
            .then((r) => r.ok ? r.json() : null)
            .then((d) => {
              const t = Array.isArray(d) ? d[0] : d;
              return { pool: p.pool, dev: t?.dev || null };
            })
            .catch(() => ({ pool: p.pool, dev: null }))
        )
      );
      const devMap = {};
      for (const r of devResults) {
        if (r.status === "fulfilled") devMap[r.value.pool] = r.value.dev;
      }
      pools = pools.filter((p) => {
        const dev = devMap[p.pool];
        if (dev) p.dev = dev; // enrich in-place
        if (dev && isDevBlocked(dev)) {
          log("dev_blocklist", `Filtered blocked deployer (jup) ${dev.slice(0, 8)} token ${p.base?.symbol}`);
          return false;
        }
        return true;
      });
    }
  }

  return {
    total: data.total,
    pools,
  };
}

async function discoverMeteoraCandidateUniverse(runtimeConfig) {
  const primaryCategory = runtimeConfig.screening.category || "trending";
  const categories = [primaryCategory, ...(runtimeConfig.screening.discoveryExtraCategories || [])]
    .map((category) => String(category || "").trim())
    .filter(Boolean)
    .filter((category, index, list) => list.indexOf(category) === index);
  const pageSize = runtimeConfig.screening.discoveryPageSize || 50;
  const discoveries = await Promise.all(categories.map((category) =>
    discoverPools({ page_size: pageSize, category })
      .catch((error) => {
        log("screening", `Discovery category ${category} failed: ${error.message}`);
        return { total: 0, pools: [] };
      })
  ));
  const poolsByAddress = new Map();
  for (const discovery of discoveries) {
    for (const pool of discovery.pools || []) {
      if (!poolsByAddress.has(pool.pool)) {
        poolsByAddress.set(pool.pool, {
          ...pool,
          source: pool.source || "meteora",
          discovery_source: pool.discovery_source || "meteora",
        });
      }
    }
  }
  return {
    total: discoveries.reduce((sum, discovery) => sum + (discovery.total ?? discovery.pools?.length ?? 0), 0),
    pools: [...poolsByAddress.values()],
    stage_counts: {
      categories: discoveries.length,
      deduped_pools: poolsByAddress.size,
    },
  };
}

async function validateGmgnOnlyCandidatesWithMeteora(candidates, runtimeConfig) {
  const validations = new Map();
  await Promise.all((candidates || []).map(async (candidate) => {
    const poolAddress = candidatePoolAddress(candidate);
    if (!poolAddress) return;
    try {
      const detail = await fetchPoolDiscoveryDetail({
        poolAddress,
        timeframe: getVolatilityTimeframe(runtimeConfig.screening?.timeframe || "5m"),
      });
      if (!detail) return;
      const [withVolatility] = await applyVolatilityTimeframe([detail], runtimeConfig.screening?.timeframe || "5m");
      const condensed = condensePool(withVolatility || detail);
      if (isMeteoraSolDlmmCandidate(condensed, runtimeConfig)) {
        validations.set(poolAddress, condensed);
      }
    } catch (error) {
      log("screening", `GMGN-only Meteora validation failed for ${poolAddress.slice(0, 8)}: ${error.message}`);
    }
  }));
  return validations;
}

export function resolveDualSourceDiscovery({
  gmgnDiscovery = {},
  meteoraDiscovery = {},
  gmgnValidationByPool = new Map(),
  sourceErrors = {},
  runtimeConfig = config,
} = {}) {
  const gmgnPools = Array.isArray(gmgnDiscovery.pools) ? gmgnDiscovery.pools : [];
  const meteoraPools = Array.isArray(meteoraDiscovery.pools) ? meteoraDiscovery.pools : [];
  const filtered = [
    ...(Array.isArray(gmgnDiscovery.filtered_examples) ? gmgnDiscovery.filtered_examples : []),
    ...(Array.isArray(meteoraDiscovery.filtered_examples) ? meteoraDiscovery.filtered_examples : []),
  ];
  const counts = {
    pool_overlap: 0,
    mint_overlap: 0,
    gmgn_only_accepted: 0,
    gmgn_only_rejected: 0,
    meteora_only_accepted: 0,
    meteora_only_rejected: 0,
    same_mint_alternatives_dropped: 0,
    source_validation_reject: 0,
  };

  const gmgnByPool = new Map();
  const meteoraByPool = new Map();
  for (const pool of gmgnPools) {
    const address = candidatePoolAddress(pool);
    if (address && !gmgnByPool.has(address)) gmgnByPool.set(address, pool);
  }
  for (const pool of meteoraPools) {
    const address = candidatePoolAddress(pool);
    if (address && !meteoraByPool.has(address)) meteoraByPool.set(address, pool);
  }

  const candidates = [];
  const allPools = new Set([...gmgnByPool.keys(), ...meteoraByPool.keys()]);
  for (const poolAddress of allPools) {
    const gmgnPool = gmgnByPool.get(poolAddress);
    const meteoraPool = meteoraByPool.get(poolAddress);
    if (gmgnPool && meteoraPool) {
      counts.pool_overlap += 1;
      candidates.push(mergeCandidateSources(gmgnPool, meteoraPool, {
        sourceResolution: "overlap_same_pool",
        discoverySources: ["gmgn", "meteora"],
      }));
      continue;
    }
    if (gmgnPool) {
      const validated = gmgnValidationByPool.get(poolAddress);
      if (!validated || !isMeteoraSolDlmmCandidate(validated, runtimeConfig)) {
        counts.gmgn_only_rejected += 1;
        counts.source_validation_reject += 1;
        filtered.push({
          stage: "source_validation_reject",
          name: gmgnPool.name || gmgnPool.base?.symbol || poolAddress,
          pool: poolAddress,
          reason: "GMGN-only candidate lacks valid direct Meteora SOL DLMM validation",
          source: "gmgn",
        });
        continue;
      }
      counts.gmgn_only_accepted += 1;
      candidates.push(mergeCandidateSources(gmgnPool, validated, {
        sourceResolution: "gmgn_only_validated",
        discoverySources: ["gmgn"],
      }));
      continue;
    }
    if (meteoraPool) {
      if (!isMeteoraSolDlmmCandidate(meteoraPool, runtimeConfig)) {
        counts.meteora_only_rejected += 1;
        filtered.push({
          stage: "source_validation_reject",
          name: meteoraPool.name || poolAddress,
          pool: poolAddress,
          reason: "Meteora-only candidate is not a valid SOL DLMM pool",
          source: "meteora",
        });
        continue;
      }
      counts.meteora_only_accepted += 1;
      candidates.push(mergeCandidateSources(null, meteoraPool, {
        sourceResolution: "meteora_only",
        discoverySources: ["meteora"],
      }));
    }
  }

  const byMint = new Map();
  for (const candidate of candidates) {
    const mint = candidateBaseMint(candidate);
    if (!mint) continue;
    const list = byMint.get(mint) || [];
    list.push(candidate);
    byMint.set(mint, list);
  }

  const resolved = [];
  for (const list of byMint.values()) {
    if (list.length === 1) {
      resolved.push(list[0]);
      continue;
    }
    counts.mint_overlap += list.length;
    const sorted = [...list].sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
    const [winner, ...dropped] = sorted;
    const alternatives = dropped.map(buildSourceEvidence);
    winner.source_evidence = {
      ...(winner.source_evidence || {}),
      same_mint_alternatives: alternatives,
    };
    for (const candidate of dropped) {
      counts.same_mint_alternatives_dropped += 1;
      filtered.push({
        stage: "same_mint_alternative_dropped",
        name: candidate.name || candidate.base?.symbol || candidate.pool,
        pool: candidate.pool,
        base_mint: candidateBaseMint(candidate),
        reason: "same base mint already represented by a higher-scored resolved pool",
        source: Array.isArray(candidate.discovery_sources) ? candidate.discovery_sources.join("+") : candidate.source,
      });
    }
    resolved.push(winner);
  }

  return {
    total: (gmgnDiscovery.total ?? gmgnPools.length) + (meteoraDiscovery.total ?? meteoraPools.length),
    pools: resolved.sort((a, b) => scoreCandidate(b) - scoreCandidate(a)),
    filtered_examples: filtered,
    source_errors: sourceErrors,
    stage_counts: {
      source: "both",
      source_mode: "both",
      gmgn_stage_counts: gmgnDiscovery.stage_counts || {},
      meteora_stage_counts: meteoraDiscovery.stage_counts || {},
      union_stage_counts: {
        gmgn_candidates: gmgnPools.length,
        meteora_candidates: meteoraPools.length,
        resolved_candidates: resolved.length,
        ...counts,
      },
      ...counts,
    },
  };
}

/**
 * Returns eligible pools for the agent to evaluate and pick from.
 * Hard filters applied in code, agent decides which to deploy into.
 */
export async function getTopCandidates({ limit = 10 } = {}) {
  const { config } = await import("../config.js");
  const source = String(config.screening.source || "meteora").toLowerCase();
  if (!["meteora", "gmgn", "both"].includes(source)) {
    throw new Error(`Invalid screeningSource: ${config.screening.source}. Use meteora, gmgn, or both.`);
  }

  let discovery;
  if (source === "gmgn") {
    discovery = await discoverGmgnPools({ limit: Math.max(limit, config.gmgn.enrichLimit || 20) });
  } else if (source === "both") {
    const [gmgnResult, meteoraResult] = await Promise.allSettled([
      discoverGmgnPools({ limit: Math.max(limit, config.gmgn.enrichLimit || 20) }),
      discoverMeteoraCandidateUniverse(config),
    ]);
    const gmgnDiscovery = gmgnResult.status === "fulfilled"
      ? gmgnResult.value
      : { total: 0, pools: [], filtered_examples: [], stage_counts: {} };
    const meteoraDiscovery = meteoraResult.status === "fulfilled"
      ? meteoraResult.value
      : { total: 0, pools: [], filtered_examples: [], stage_counts: {} };
    const meteoraPools = new Set((meteoraDiscovery.pools || []).map(candidatePoolAddress).filter(Boolean));
    const gmgnOnlyPools = (gmgnDiscovery.pools || []).filter((pool) => !meteoraPools.has(candidatePoolAddress(pool)));
    const gmgnValidationByPool = await validateGmgnOnlyCandidatesWithMeteora(gmgnOnlyPools, config);
    discovery = resolveDualSourceDiscovery({
      gmgnDiscovery,
      meteoraDiscovery,
      gmgnValidationByPool,
      sourceErrors: {
        gmgn: gmgnResult.status === "rejected" ? gmgnResult.reason?.message || String(gmgnResult.reason) : null,
        meteora: meteoraResult.status === "rejected" ? meteoraResult.reason?.message || String(meteoraResult.reason) : null,
      },
      runtimeConfig: config,
    });
  } else {
    discovery = await discoverMeteoraCandidateUniverse(config);
  }
  let pools = discovery.pools || [];
  const totalScreened = discovery.total ?? pools.length;
  const filteredOut = Array.isArray(discovery.filtered_examples) ? [...discovery.filtered_examples] : [];
  const postDiscoveryStageCounts = {};

  if (source === "gmgn") {
    const before = pools.length;
    pools = pools.filter((p) => {
      if (isBlacklisted(p.base?.mint)) {
        log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in GMGN pool ${p.name}`);
        pushFilteredReason(filteredOut, p, "blacklisted token");
        return false;
      }
      if (p.dev && isDevBlocked(p.dev)) {
        log("dev_blocklist", `Filtered blocked deployer ${p.dev?.slice(0, 8)} token ${p.base?.symbol} in GMGN pool ${p.name}`);
        pushFilteredReason(filteredOut, p, "blocked deployer");
        return false;
      }
      return true;
    });
    if (pools.length < before) log("blacklist", `GMGN: filtered ${before - pools.length} blacklisted/blocked pool(s)`);
  }

  pools = filterConfiguredPoolThresholds(
    pools,
    config.screening,
    filteredOut,
    postDiscoveryStageCounts,
  );

  // Exclude pools where the wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedPools = new Set(positions.map((p) => p.pool));
  const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));

  const eligible = pools
    .filter((p) => {
      if (occupiedPools.has(p.pool)) {
        pushFilteredReason(filteredOut, p, "already have an open position in this pool");
        return false;
      }
      if (occupiedMints.has(p.base?.mint)) {
        pushFilteredReason(filteredOut, p, "already holding this base token in another pool");
        return false;
      }
      if (isPoolOnCooldown(p.pool)) {
        log("screening", `Filtered cooldown pool ${p.name} (${p.pool.slice(0, 8)})`);
        appendDecisionContext({
          stage: "cooldown_block",
          actor: "SCREENER",
          pool: p.pool,
          poolName: p.name,
          baseMint: p.base?.mint ?? null,
          quoteMint: p.quote?.mint ?? null,
          reason: "pool cooldown active",
          metrics: buildCandidateDecisionContext(p),
          source: "screening.pool_cooldown",
        });
        pushFilteredReason(filteredOut, p, "pool cooldown active");
        return false;
      }
      if (isBaseMintOnCooldown(p.base?.mint)) {
        log("screening", `Filtered cooldown token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)})`);
        appendDecisionContext({
          stage: "cooldown_block",
          actor: "SCREENER",
          pool: p.pool,
          poolName: p.name,
          baseMint: p.base?.mint ?? null,
          quoteMint: p.quote?.mint ?? null,
          reason: "token cooldown active",
          metrics: buildCandidateDecisionContext(p),
          source: "screening.token_cooldown",
        });
        pushFilteredReason(filteredOut, p, "token cooldown active");
        return false;
      }
      return true;
    })
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, limit);

  if (config.screening.avoidPvpSymbols && eligible.length > 0) {
    await enrichPvpRisk(eligible);
    if (config.screening.blockPvpSymbols) {
      const before = eligible.length;
      const pvpRemoved = eligible.filter((p) => p.is_pvp);
      pvpRemoved.forEach((p) => pushFilteredReason(filteredOut, p, "PVP hard filter"));
      eligible.splice(0, eligible.length, ...eligible.filter((p) => !p.is_pvp));
      if (eligible.length < before) {
        log("screening", `PVP hard filter removed ${before - eligible.length} pool(s)`);
      }
    }
  }

  // Enrich with OKX data — advanced info (risk/bundle/sniper) + ATH price (no API key required)
  if (eligible.length > 0) {
    const { getAdvancedInfo, getPriceInfo, getClusterList, getRiskFlags } = await import("./okx.js");
    const okxResults = await Promise.allSettled(
      eligible.map(async (p) => {
        if (!p.base?.mint) return { adv: null, price: null, clusters: [], risk: null };
        const [adv, price, clusters, risk] = await Promise.allSettled([
          getAdvancedInfo(p.base.mint),
          getPriceInfo(p.base.mint),
          getClusterList(p.base.mint),
          getRiskFlags(p.base.mint),
        ]);

        const mintShort = p.base.mint.slice(0, 8);
        if (adv.status !== "fulfilled")      log("okx", `advanced-info unavailable for ${p.name} (${mintShort})`);
        if (price.status !== "fulfilled")    log("okx", `price-info unavailable for ${p.name} (${mintShort})`);
        if (clusters.status !== "fulfilled") log("okx", `cluster-list unavailable for ${p.name} (${mintShort})`);
        if (risk.status !== "fulfilled")     log("okx", `risk-check unavailable for ${p.name} (${mintShort})`);

        return {
          adv: adv.status === "fulfilled" ? adv.value : null,
          price: price.status === "fulfilled" ? price.value : null,
          clusters: clusters.status === "fulfilled" ? clusters.value : [],
          risk: risk.status === "fulfilled" ? risk.value : null,
        };
      })
    );
    for (let i = 0; i < eligible.length; i++) {
      const r = okxResults[i];
      if (r.status !== "fulfilled") continue;
      const { adv, price, clusters, risk } = r.value;
      if (adv) {
        eligible[i].risk_level      = adv.risk_level;
        eligible[i].bundle_pct      = adv.bundle_pct;
        eligible[i].sniper_pct      = adv.sniper_pct;
        eligible[i].suspicious_pct  = adv.suspicious_pct;
        eligible[i].smart_money_buy = adv.smart_money_buy;
        eligible[i].dev_sold_all    = adv.dev_sold_all;
        eligible[i].dex_boost       = adv.dex_boost;
        eligible[i].dex_screener_paid = adv.dex_screener_paid;
        if (adv.creator && !eligible[i].dev) eligible[i].dev = adv.creator;
      }
      if (risk) {
        eligible[i].is_rugpull = risk.is_rugpull;
        eligible[i].is_wash    = risk.is_wash;
      }
      if (price) {
        eligible[i].price_vs_ath_pct = price.price_vs_ath_pct;
        eligible[i].ath              = price.ath;
      }
      if (clusters?.length) {
        // Surface KOL presence and top cluster trend for LLM
        eligible[i].kol_in_clusters      = clusters.some((c) => c.has_kol);
        eligible[i].top_cluster_trend    = clusters[0]?.trend ?? null;      // buy|sell|neutral
        eligible[i].top_cluster_hold_pct = clusters[0]?.holding_pct ?? null;
      }
    }

    await enrichJupiterTokenSnapshots(eligible);

    // Deterministic nanocap safety gates. These run before the LLM sees candidates.
    eligible.splice(0, eligible.length, ...eligible.filter((p) => {
      const vetoReason = getDeterministicCandidateVetoReason(p, config.screening);
      if (vetoReason) {
        log("screening", formatDeterministicVetoAuditLine(p, vetoReason));
        appendDecisionContext({
          stage: "deterministic_veto",
          actor: "SCREENER",
          pool: p.pool,
          poolName: p.name,
          baseMint: p.base?.mint ?? null,
          quoteMint: p.quote?.mint ?? null,
          reason: vetoReason,
          metrics: {
            ...buildCandidateDecisionContext(p),
            veto_audit: getDeterministicVetoAuditSnapshot(p),
          },
          source: "screening.deterministic_veto",
        });
        pushFilteredReason(filteredOut, p, vetoReason, {
          priority: true,
          audit: getDeterministicVetoAuditSnapshot(p),
        });
        return false;
      }
      return true;
    }));

    // Wash trading hard filter — fake volume = misleading fee yield
    eligible.splice(0, eligible.length, ...eligible.filter((p) => {
      if (p.is_wash) {
        log("screening", `Risk filter: dropped ${p.name} — wash trading flagged`);
        pushFilteredReason(filteredOut, p, "wash trading flagged");
        return false;
      }
      return true;
    }));

    // ATH filter — drop pools where price is too close to ATH
    const athFilter = config.screening.athFilterPct;
    if (athFilter != null) {
      const threshold = 100 + athFilter; // e.g. -20 → threshold = 80 (price must be <= 80% of ATH)
      const before = eligible.length;
      eligible.splice(0, eligible.length, ...eligible.filter((p) => {
        if (p.price_vs_ath_pct == null) return true; // no data → don't filter
        if (p.price_vs_ath_pct > threshold) {
          log("screening", `ATH filter: dropped ${p.name} — ${p.price_vs_ath_pct}% of ATH (limit: ${threshold}%)`);
          pushFilteredReason(filteredOut, p, `${p.price_vs_ath_pct}% of ATH > ${threshold}% limit`);
          return false;
        }
        return true;
      }));
      if (eligible.length < before) log("screening", `ATH filter removed ${before - eligible.length} pool(s)`);
    }

    // Drop any pools whose creator is on the dev blocklist (caught via advanced-info)
    const before = eligible.length;
    const filtered = eligible.filter((p) => {
      if (p.dev && isDevBlocked(p.dev)) {
        log("dev_blocklist", `Filtered blocked deployer (okx) ${p.dev.slice(0, 8)} token ${p.base?.symbol}`);
        pushFilteredReason(filteredOut, p, "blocked deployer");
        return false;
      }
      return true;
    });
    eligible.splice(0, eligible.length, ...filtered);
    if (eligible.length < before) log("dev_blocklist", `Filtered ${before - eligible.length} pool(s) via OKX creator check`);
  }

  // Chart indicator entry confirmation — filters candidates that don't meet the entry preset
  // Falls back gracefully (confirmed: true) if API is unavailable or config.indicators.enabled is false
  if (config.indicators.enabled && eligible.length > 0) {
    const confirmations = await Promise.all(
      eligible.map(async (pool) => {
        try {
          const confirmation = await confirmIndicatorPreset({
            mint: pool.base?.mint,
            side: "entry",
          });
          return { pool: pool.pool, confirmation };
        } catch (error) {
          return {
            pool: pool.pool,
            confirmation: {
              enabled: true,
              confirmed: true,
              skipped: true,
              reason: `Indicator confirmation unavailable: ${error.message}`,
              intervals: [],
            },
          };
        }
      }),
    );
    const confirmationByPool = new Map(confirmations.map((entry) => [entry.pool, entry.confirmation]));
    const before = eligible.length;
    const confirmedEligible = eligible.filter((pool) => {
      const confirmation = confirmationByPool.get(pool.pool);
      pool.indicator_confirmation = confirmation || null;
      if (confirmation) {
        appendDecisionContext({
          stage: getIndicatorDecisionStage(confirmation),
          actor: "SCREENER",
          pool: pool.pool,
          poolName: pool.name,
          baseMint: pool.base?.mint ?? null,
          quoteMint: pool.quote?.mint ?? null,
          reason: confirmation.reason,
          metrics: buildCandidateDecisionContext(pool),
          chart: summarizeIndicatorConfirmation(confirmation),
          source: "screening.indicator_confirmation",
        });
      }
      if (!confirmation || confirmation.confirmed) return true;
      pushFilteredReason(filteredOut, pool, `indicator reject: ${confirmation.reason}`);
      log("screening", `Indicator rejected ${pool.name} (${pool.pool.slice(0, 8)}): ${confirmation.reason}`);
      return false;
    });
    eligible.splice(0, eligible.length, ...confirmedEligible);
    if (eligible.length < before) {
      log("screening", `Indicator confirmation removed ${before - eligible.length} candidate(s)`);
    }
  }

  const ranked = rankCandidatesByDarwin(eligible);

  return {
    candidates: ranked,
    total_eligible: ranked.length,
    total_screened: totalScreened || pools.length,
    source,
    stage_counts: {
      source,
      ranked: totalScreened || pools.length,
      ...(discovery.stage_counts || {}),
      ...postDiscoveryStageCounts,
    },
    source_errors: discovery.source_errors || {},
    filtered_examples: filteredOut.slice(0, 3),
    all_filtered: filteredOut,
  };
}

/**
 * Get full raw details for a specific pool.
 * Fetches top 50 pools from discovery API and finds the matching address.
 * Returns the full unfiltered API object (all fields, not condensed).
 */
export async function getPoolDetail({ pool_address, timeframe = "5m" }) {
  const pool = await fetchPoolDiscoveryDetail({ poolAddress: pool_address, timeframe });

  if (!pool) {
    throw new Error(`Pool ${pool_address} not found`);
  }

  return pool;
}

/**
 * Condense a pool object for LLM consumption.
 * Raw API returns ~100+ fields per pool. The LLM only needs ~20.
 */
function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint: p.token_y?.address,
      organic: Math.round(p.token_y?.organic_score || 0),
    },
    pool_type: p.pool_type,
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,

    // Core metrics (the numbers that matter)
    active_tvl: round(p.active_tvl),
    fee_window: round(p.fee),
    volume_window: round(p.volume),
    // API sometimes returns 0 for fee_active_tvl_ratio on short timeframes — compute from raw values as fallback
    fee_active_tvl_ratio: p.fee_active_tvl_ratio > 0
      ? fix(p.fee_active_tvl_ratio, 4)
      : (p.active_tvl > 0 ? fix((p.fee / p.active_tvl) * 100, 4) : 0),
    volatility: fix(p.volatility, 4),
    volatility_timeframe: p.volatility_timeframe || getVolatilityTimeframe(config.screening.timeframe),


    // Token health
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),
    quote_organic_score: Math.round(p.token_y?.organic_score || 0),
    token_age_hours: p.token_x?.created_at
      ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000)
      : null,
    dev: p.token_x?.dev || null,

    // Position health
    active_positions: p.active_positions,
    active_pct: fix(p.active_positions_pct, 1),
    open_positions: p.open_positions,
    discord_signal: Boolean(p.discord_signal),
    discord_signal_count: p.discord_signal_count || 0,
    discord_signal_seen_count: p.discord_signal_seen_count || 0,
    discord_signal_last_seen_at: p.discord_signal_last_seen_at || null,

    // Price action
    price: p.pool_price,
    price_change_pct: fix(p.pool_price_change_pct, 1),
    price_trend: p.price_trend,
    min_price: p.min_price,
    max_price: p.max_price,
    candle_price_range: (p.min_price > 0 && p.max_price > 0)
      ? fix((p.max_price - p.min_price) / p.min_price * 100, 2)
      : null,

    // Activity trends
    volume_change_pct: fix(p.volume_change_pct, 1),
    fee_change_pct: fix(p.fee_change_pct, 1),
    swap_count: p.swap_count,
    unique_traders: p.unique_traders,
  };
}

export function normalizeCandidateForUi(candidate) {
  if (!candidate) return {};
  return {
    ...candidate,
    pool: candidate.pool ?? candidate.pool_address ?? candidate.address,
    volume: candidate.volume ?? candidate.volume_window ?? null,
    fee_tvl_ratio: candidate.fee_tvl_ratio ?? candidate.fee_active_tvl_ratio ?? null,
    holder_count: candidate.holder_count ?? candidate.holders ?? candidate.base_token_holders ?? null,
  };
}

export function getCandidateSignalSnapshot(candidate = {}) {
  const c = normalizeCandidateForUi(candidate);
  const okxSignalPresent = c.okx_signal_present ?? (c.smart_money_buy === true || c.kol_in_clusters === true);
  const volumeTrend = c.volume_trend ?? (() => {
    const change = c.volume_change_pct;
    if (change == null) return null;
    if (change > 10) return "increasing";
    if (change < -10) return "decreasing";
    return "stable";
  })();
  return {
    organic_score:         c.organic_score ?? c.base?.organic ?? null,
    fee_tvl_ratio:         c.fee_active_tvl_ratio ?? c.fee_tvl_ratio ?? null,
    volume:                c.volume_window ?? c.volume ?? null,
    mcap:                  c.mcap ?? null,
    holder_count:          c.holders ?? c.holder_count ?? null,
    smart_wallets_present: c._smartWalletCount != null ? c._smartWalletCount > 0 : c.smart_wallets_present ?? null,
    narrative_quality:     c.narrative_quality ?? null,
    volatility:            c.volatility ?? null,
    ath_proximity:         c.price_vs_ath_pct ?? c.ath_proximity ?? null,
    volume_trend:          volumeTrend,
    okx_signal_present:    okxSignalPresent,
    change_1h:             c.change_1h ?? c.price_change ?? c.price_change_pct ?? null,
    candle_price_range:    c.candle_price_range ?? null,
    token_age_hours:       c.token_age_hours ?? null,
    // GMGN-derived signals — populated when GMGN API is available
    gmgn_bluechip_present: c.gmgn_bluechip_present ?? null,
    gmgn_bundler_present:  c.gmgn_bundler_present  ?? null,
  };
}

export function rankCandidatesByDarwin(candidates = []) {
  return candidates
    .map((candidate, index) => {
      const normalized = normalizeCandidateForUi(candidate);
      const darwinSignalSnapshot = getCandidateSignalSnapshot(normalized);
      const darwin = scoreSignalSnapshot(darwinSignalSnapshot, { topN: 3 });
      return {
        ...normalized,
        darwin_score: darwin.score_pct,
        darwin_observed_score: darwin.observed_score_pct,
        darwin_weight_coverage: darwin.coverage,
        darwin_coverage_pct: darwin.coverage_pct,
        darwin_top_signals: darwin.topSignals,
        darwin_signal_snapshot: darwinSignalSnapshot,
        _darwin_sort_index: index,
      };
    })
    .sort((a, b) =>
      (b.darwin_score ?? 0) - (a.darwin_score ?? 0)
      || (b.darwin_coverage_pct ?? 0) - (a.darwin_coverage_pct ?? 0)
      || (b.fee_active_tvl_ratio ?? 0) - (a.fee_active_tvl_ratio ?? 0)
      || (b.volume_window ?? b.volume ?? 0) - (a.volume_window ?? a.volume ?? 0)
      || (b.organic_score ?? 0) - (a.organic_score ?? 0)
      || (a._darwin_sort_index ?? 0) - (b._darwin_sort_index ?? 0)
    )
    .map(({ _darwin_sort_index, ...candidate }) => candidate);
}

function round(n) {
  return n != null ? Math.round(n) : null;
}

function fix(n, decimals) {
  return n != null ? Number(n.toFixed(decimals)) : null;
}

function pushFilteredReason(list, pool, reason, options = {}) {
  if (!list || !pool) return;
  const entry = {
    name: pool.name || `${pool.base?.symbol || "?"}-${pool.quote?.symbol || "?"}`,
    reason,
  };
  if (options.audit) {
    for (const [key, value] of Object.entries(options.audit)) {
      if (value != null) entry[key] = value;
    }
  }
  if (options.priority) list.unshift(entry);
  else list.push(entry);
}
