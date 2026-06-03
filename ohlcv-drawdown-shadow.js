const GECKOTERMINAL_SOLANA_POOL_OHLCV = "https://api.geckoterminal.com/api/v2/networks/solana/pools";
const BIRDEYE_OHLCV_V3 = "https://public-api.birdeye.so/defi/v3/ohlcv";
const CACHE_TTL_MS = 60_000;
const CACHE_BUCKET_SEC = 60;
const REQUEST_TIMEOUT_MS = 4_000;
const TOKEN_CONTEXT_TIMEOUT_MS = 750;
const BACKOFF_DURATION_MS = 300_000;

const ohlcvCache = new Map();
const providerBackoff = { geckoterminal: { until: 0 }, birdeye: { until: 0 } };

function finiteNumberOrNull(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function clampAggregate(value) {
  const aggregate = Math.trunc(Number(value));
  return [1, 5, 15].includes(aggregate) ? aggregate : 1;
}

function pctChange(current, reference) {
  const c = finiteNumberOrNull(current);
  const r = finiteNumberOrNull(reference);
  if (c == null || r == null || r <= 0) return null;
  return ((c / r) - 1) * 100;
}

function normalizeRows(payload) {
  const raw = payload?.data?.attributes?.ohlcv_list || [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => ({
      timestamp: Number(entry?.[0]),
      iso: Number.isFinite(Number(entry?.[0])) ? new Date(Number(entry[0]) * 1000).toISOString() : null,
      open: finiteNumberOrNull(entry?.[1]),
      high: finiteNumberOrNull(entry?.[2]),
      low: finiteNumberOrNull(entry?.[3]),
      close: finiteNumberOrNull(entry?.[4]),
      volumeUsd: finiteNumberOrNull(entry?.[5]),
    }))
    .filter((row) => Number.isFinite(row.timestamp) && row.close != null)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function birdeyeTimeframe(aggregateMin) {
  const map = { 1: "1m", 5: "5m", 15: "15m" };
  return map[clampAggregate(aggregateMin)] || "1m";
}

function normalizeBirdeyeRows(payload) {
  const items = payload?.data?.items;
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      timestamp: Number(item?.unix_time),
      iso: Number.isFinite(Number(item?.unix_time))
        ? new Date(Number(item.unix_time) * 1000).toISOString()
        : null,
      open: finiteNumberOrNull(item?.o),
      high: finiteNumberOrNull(item?.h),
      low: finiteNumberOrNull(item?.l),
      close: finiteNumberOrNull(item?.c),
      volumeUsd: finiteNumberOrNull(item?.v_usd),
    }))
    .filter((row) => Number.isFinite(row.timestamp) && row.close != null)
    .sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchBirdeyeOhlcv(tokenMint, { aggregateMin = 1, beforeTimestamp = null } = {}) {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) return null;
  if (Date.now() < providerBackoff.birdeye.until) return null;

  const aggregate = clampAggregate(aggregateMin);
  const type = birdeyeTimeframe(aggregate);
  const timeTo = Math.floor(Number(beforeTimestamp ?? Date.now() / 1000));
  const timeFrom = timeTo - (aggregate * 60 * 1000);

  const cacheKey = `birdeye:${tokenMint}:${aggregate}:${Math.floor(timeTo / CACHE_BUCKET_SEC)}`;
  const cached = ohlcvCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.value;

  const url = new URL(BIRDEYE_OHLCV_V3);
  url.searchParams.set("address", tokenMint);
  url.searchParams.set("type", type);
  url.searchParams.set("time_from", String(timeFrom));
  url.searchParams.set("time_to", String(timeTo));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "X-API-KEY": apiKey, "x-chain": "solana", accept: "application/json" },
      signal: controller.signal,
    });
    if (res.status === 429) {
      providerBackoff.birdeye.until = Date.now() + BACKOFF_DURATION_MS;
      return null;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Birdeye OHLCV ${res.status}: ${text.slice(0, 160)}`);
    const payload = JSON.parse(text);
    const value = {
      source: "birdeye",
      url: url.toString(),
      aggregateMin: aggregate,
      rows: normalizeBirdeyeRows(payload),
      meta: null,
    };
    ohlcvCache.set(cacheKey, { cachedAt: Date.now(), value });
    return value;
  } catch (err) {
    if (err?.name === "AbortError") return null;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGeckoTerminalOhlcv(pool, { aggregateMin = 1, beforeTimestamp = null } = {}) {
  const aggregate = clampAggregate(aggregateMin);
  const before = Math.floor(Number(beforeTimestamp ?? Date.now() / 1000));
  const cacheKey = `gecko:${pool}:${aggregate}:${Math.floor(before / CACHE_BUCKET_SEC)}`;
  const cached = ohlcvCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.value;
  if (Date.now() < providerBackoff.geckoterminal.until) return null;

  const url = new URL(`${GECKOTERMINAL_SOLANA_POOL_OHLCV}/${pool}/ohlcv/minute`);
  url.searchParams.set("aggregate", String(aggregate));
  url.searchParams.set("before_timestamp", String(before));
  url.searchParams.set("limit", "1000");
  url.searchParams.set("currency", "usd");
  url.searchParams.set("token", "base");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (res.status === 429) {
      providerBackoff.geckoterminal.until = Date.now() + BACKOFF_DURATION_MS;
      return null;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`GeckoTerminal OHLCV ${res.status}: ${text.slice(0, 160)}`);
    const payload = JSON.parse(text);
    const value = {
      source: "geckoterminal",
      url: url.toString(),
      aggregateMin: aggregate,
      rows: normalizeRows(payload),
      meta: payload?.meta ?? null,
    };
    ohlcvCache.set(cacheKey, { cachedAt: Date.now(), value });
    return value;
  } catch (err) {
    if (err?.name === "AbortError") return null;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOhlcv(pool, tokenMint, { aggregateMin = 1, beforeTimestamp = null } = {}) {
  const opts = { aggregateMin, beforeTimestamp };
  if (tokenMint && process.env.BIRDEYE_API_KEY) {
    const birdeye = await fetchBirdeyeOhlcv(tokenMint, opts);
    if (birdeye && birdeye.rows.length > 0) return birdeye;
  }
  const gecko = await fetchGeckoTerminalOhlcv(pool, opts);
  if (gecko && gecko.rows.length > 0) return gecko;
  return null;
}

async function fetchTargetPoolOhlcv(pool, tokenMint, { aggregateMin = 1, beforeTimestamp = null } = {}) {
  const opts = { aggregateMin, beforeTimestamp };
  const poolSpecific = await fetchGeckoTerminalOhlcv(pool, opts);
  let tokenContext = null;
  if (tokenMint && process.env.BIRDEYE_API_KEY) {
    tokenContext = await Promise.race([
      fetchBirdeyeOhlcv(tokenMint, opts).catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), TOKEN_CONTEXT_TIMEOUT_MS)),
    ]);
  }
  return {
    poolSpecific,
    tokenContext,
  };
}

export async function getTargetPoolOhlcvEvidence({
  candidate = null,
  pool = null,
  tokenMint = null,
  aggregateMin = 1,
  lookbackMinutes = 60,
  nowMs = Date.now(),
} = {}) {
  const poolAddress = pool ?? candidate?.pool ?? candidate?.pool_address ?? candidate?.address ?? null;
  const mint = tokenMint ?? candidate?.base?.mint ?? candidate?.base_mint ?? candidate?.mint ?? null;
  if (!poolAddress) return null;

  const nowSec = Math.floor(nowMs / 1000);
  const lookbackMs = Math.max(1, Number(lookbackMinutes) || 60) * 60_000;
  const { poolSpecific, tokenContext } = await fetchTargetPoolOhlcv(poolAddress, mint, {
    aggregateMin,
    beforeTimestamp: nowSec,
  });
  const ohlcv = poolSpecific;
  if (!ohlcv || !Array.isArray(ohlcv.rows) || ohlcv.rows.length === 0) return null;

  const sinceSec = Math.floor((nowMs - lookbackMs) / 1000);
  const windowRows = ohlcv.rows.filter((row) => row.timestamp >= sinceSec && row.timestamp <= nowSec);
  if (windowRows.length === 0) return null;
  const rows = windowRows;
  const first = rows[0] ?? null;
  const current = selectCurrentRow(rows, nowMs);
  const high = rows.reduce((best, row) => (row.high != null && (!best || row.high > best.high) ? row : best), null);
  const low = rows.reduce((best, row) => (row.low != null && (!best || row.low < best.low) ? row : best), null);
  const entryPrice = finiteNumberOrNull(first?.open ?? first?.close);
  const currentPrice = finiteNumberOrNull(current?.close);
  const highPrice = finiteNumberOrNull(high?.high);
  const lowPrice = finiteNumberOrNull(low?.low);

  return {
    source: ohlcv.source,
    aggregateMin: ohlcv.aggregateMin,
    lookbackMinutes: Math.max(1, Number(lookbackMinutes) || 60),
    rowCount: ohlcv.rows.length,
    windowRowCount: rows.length,
    entry: first,
    current,
    high,
    low,
    entryPrice,
    currentPrice,
    highPrice,
    lowPrice,
    entryDrawdownPct: pctChange(currentPrice, entryPrice),
    highDrawdownPct: pctChange(currentPrice, highPrice),
    peakRetracePct: pctChange(lowPrice, highPrice),
    lowDrawdownPct: pctChange(lowPrice, entryPrice),
    highRunupPct: pctChange(highPrice, entryPrice),
    highLowRangePct: pctChange(highPrice, lowPrice),
    decisiveEvidence: "pool_specific",
    tokenContext: tokenContext ? {
      source: tokenContext.source,
      aggregateMin: tokenContext.aggregateMin,
      rowCount: Array.isArray(tokenContext.rows) ? tokenContext.rows.length : 0,
      contextOnly: true,
    } : null,
  };
}

function selectEntryReference(rows, deployedAtMs) {
  if (!rows.length || !Number.isFinite(deployedAtMs)) return null;
  const deployedSec = Math.floor(deployedAtMs / 1000);
  const firstAtOrAfterDeploy = rows.find((row) => row.timestamp >= deployedSec);
  if (firstAtOrAfterDeploy) return firstAtOrAfterDeploy;

  let lastBeforeDeploy = null;
  for (const row of rows) {
    if (row.timestamp <= deployedSec) lastBeforeDeploy = row;
    else break;
  }
  return lastBeforeDeploy;
}

function selectCurrentRow(rows, nowMs = Date.now()) {
  if (!rows.length) return null;
  const nowSec = Math.floor(nowMs / 1000);
  let current = rows[0];
  for (const row of rows) {
    if (row.timestamp <= nowSec) current = row;
    else break;
  }
  return current;
}

function summarizeOhlcv(rows, deployedAtMs, nowMs = Date.now()) {
  const sinceSec = Math.floor(deployedAtMs / 1000);
  const nowSec = Math.floor(nowMs / 1000);
  const windowRows = rows.filter((row) => row.timestamp >= sinceSec && row.timestamp <= nowSec);
  const scoped = windowRows.length ? windowRows : rows;
  const entry = selectEntryReference(rows, deployedAtMs);
  const current = selectCurrentRow(rows, nowMs);
  const high = scoped.reduce((best, row) => (row.high != null && (!best || row.high > best.high) ? row : best), null);
  const low = scoped.reduce((best, row) => (row.low != null && (!best || row.low < best.low) ? row : best), null);
  const entryPrice = finiteNumberOrNull(entry?.open ?? entry?.close);
  const currentPrice = finiteNumberOrNull(current?.close);
  const highPrice = finiteNumberOrNull(high?.high);
  const lowPrice = finiteNumberOrNull(low?.low);
  return {
    rowCount: rows.length,
    windowRowCount: windowRows.length,
    entry,
    current,
    high,
    low,
    entryPrice,
    currentPrice,
    highPrice,
    lowPrice,
    entryDrawdownPct: pctChange(currentPrice, entryPrice),
    highDrawdownPct: pctChange(currentPrice, highPrice),
    lowDrawdownPct: pctChange(lowPrice, entryPrice),
  };
}

function makeRuleRows({
  position,
  tracked,
  wallet,
  summary,
  ohlcv,
  mgmtConfig,
  nowIso,
}) {
  const currentPnlPct = finiteNumberOrNull(position?.pnl_pct);
  const peakPnlPct = finiteNumberOrNull(tracked?.peak_pnl_pct);
  const entryDrawdownThreshold = finiteNumberOrNull(mgmtConfig.ohlcvDrawdownShadowEntryDrawdownPct ?? -20);
  const highDrawdownThreshold = finiteNumberOrNull(mgmtConfig.ohlcvDrawdownShadowHighDrawdownPct ?? -25);
  const divergencePnlFloor = finiteNumberOrNull(mgmtConfig.ohlcvDrawdownShadowPnlDivergenceMinPnlPct ?? -2);
  const combinedPeak = finiteNumberOrNull(mgmtConfig.ohlcvDrawdownShadowCombinedPeakPct ?? 2);
  const combinedCurrent = finiteNumberOrNull(mgmtConfig.ohlcvDrawdownShadowCombinedCurrentPnlPct ?? 0);
  const rows = [];

  const entryDrawdownHit = entryDrawdownThreshold != null &&
    summary.entryDrawdownPct != null &&
    summary.entryDrawdownPct <= entryDrawdownThreshold;
  const highDrawdownHit = highDrawdownThreshold != null &&
    summary.highDrawdownPct != null &&
    summary.highDrawdownPct <= highDrawdownThreshold;
  const ohlcvHit = entryDrawdownHit || highDrawdownHit;
  const greenToRedHit = peakPnlPct != null &&
    combinedPeak != null &&
    combinedCurrent != null &&
    peakPnlPct >= combinedPeak &&
    currentPnlPct != null &&
    currentPnlPct <= combinedCurrent;

  function baseRow(ruleId, ruleType) {
    return {
      ts: nowIso,
      event: "ohlcv_drawdown_shadow",
      bot: mgmtConfig.ohlcvDrawdownShadowBotName ?? mgmtConfig.profitProtectionShadowBotName ?? mgmtConfig.pnlSnapshotBotName ?? "meridian",
      wallet: wallet ?? null,
      pool: position.pool ?? position.pool_address ?? tracked?.pool ?? null,
      poolName: position.pair ?? position.pool_name ?? tracked?.pool_name ?? null,
      position: position.position ?? tracked?.position ?? null,
      baseMint: position.base_mint ?? tracked?.base_mint ?? null,
      ageMin: finiteNumberOrNull(position.age_minutes),
      pnlPct: currentPnlPct,
      peakPnlPct,
      dropFromPeakPct: currentPnlPct != null && peakPnlPct != null ? peakPnlPct - currentPnlPct : null,
      ruleId,
      ruleType,
      ohlcv: {
        source: ohlcv.source,
        aggregateMin: ohlcv.aggregateMin,
        entry: summary.entry,
        current: summary.current,
        high: summary.high,
        low: summary.low,
        rowCount: summary.rowCount,
        windowRowCount: summary.windowRowCount,
        entryDrawdownPct: summary.entryDrawdownPct,
        highDrawdownPct: summary.highDrawdownPct,
        lowDrawdownPct: summary.lowDrawdownPct,
      },
      rule: {
        entryDrawdownPct: entryDrawdownThreshold,
        highDrawdownPct: highDrawdownThreshold,
        pnlDivergenceMinPnlPct: divergencePnlFloor,
        combinedPeakPnlPct: combinedPeak,
        combinedCurrentPnlPct: combinedCurrent,
      },
      source: "ohlcv-drawdown-shadow",
      shadowOnly: true,
    };
  }

  if (entryDrawdownHit) rows.push(baseRow("ohlcv_entry_drawdown", "ohlcv_entry_drawdown"));
  if (highDrawdownHit) rows.push(baseRow("ohlcv_high_drawdown", "ohlcv_high_drawdown"));
  if (ohlcvHit && currentPnlPct != null && divergencePnlFloor != null && currentPnlPct >= divergencePnlFloor) {
    rows.push(baseRow("ohlcv_pnl_divergence", "ohlcv_pnl_divergence"));
  }
  if (ohlcvHit && greenToRedHit) {
    rows.push(baseRow("combined_profit_ohlcv_drawdown", "combined_profit_ohlcv_drawdown"));
  }

  return rows;
}

export async function getOhlcvDrawdownShadowRows({
  position,
  tracked,
  wallet = null,
  mgmtConfig = {},
  nowMs = Date.now(),
} = {}) {
  if (!mgmtConfig.ohlcvDrawdownShadowEnabled) return [];
  if (!position?.position || position?.pnl_pct_suspicious) return [];
  const pool = position.pool ?? position.pool_address ?? tracked?.pool;
  if (!pool) return [];
  const deployedAtMs = new Date(tracked?.deployed_at).getTime();
  if (!Number.isFinite(deployedAtMs)) return [];

  const tokenMint = position.base_mint ?? tracked?.base_mint ?? null;
  const aggregateMin = mgmtConfig.ohlcvDrawdownShadowAggregateMin ?? 1;
  const ohlcv = await fetchOhlcv(pool, tokenMint, {
    aggregateMin,
    beforeTimestamp: Math.floor(nowMs / 1000),
  });
  if (!ohlcv) return [];
  const summary = summarizeOhlcv(ohlcv.rows, deployedAtMs, nowMs);
  if (!summary.entry || !summary.current) return [];

  const logged = tracked?.ohlcv_drawdown_shadow_logged && typeof tracked.ohlcv_drawdown_shadow_logged === "object"
    ? tracked.ohlcv_drawdown_shadow_logged
    : {};
  return makeRuleRows({
    position,
    tracked,
    wallet,
    summary,
    ohlcv,
    mgmtConfig,
    nowIso: new Date(nowMs).toISOString(),
  }).filter((row) => !logged[row.ruleId]);
}

export const __test = {
  normalizeRows,
  normalizeBirdeyeRows,
  fetchOhlcv,
  fetchTargetPoolOhlcv,
  getTargetPoolOhlcvEvidence,
  summarizeOhlcv,
  makeRuleRows,
  pctChange,
};
