const BIRDEYE_OHLCV_URL = "https://public-api.birdeye.so/defi/ohlcv";
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || "";
const CACHE_TTL_MS = 25_000;
const REQUEST_TIMEOUT_MS = 4_000;

const ohlcvCache = new Map();

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

async function fetchBirdeyeOhlcv(baseMint, pool, { aggregateMin = 1, beforeTimestamp = null } = {}) {
  const aggregate = clampAggregate(aggregateMin);
  const before = Math.floor(Number(beforeTimestamp ?? Date.now() / 1000));
  const tokenAddress = baseMint || pool;
  const cacheKey = `${tokenAddress}:${aggregate}:${Math.floor(before / 30)}`;
  const cached = ohlcvCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.value;

  const typeMap = { 1: "1m", 5: "5m", 15: "15m" };
  const timeFrom = before - (aggregate * 60 * 1000);
  const url = new URL(BIRDEYE_OHLCV_URL);
  url.searchParams.set("address", tokenAddress);
  url.searchParams.set("type", typeMap[aggregate] || "1m");
  url.searchParams.set("time_from", String(before - 86400));
  url.searchParams.set("time_to", String(before));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", "X-API-KEY": BIRDEYE_API_KEY, "x-chain": "solana" },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Birdeye OHLCV ${res.status}: ${text.slice(0, 160)}`);
    const payload = JSON.parse(text);
    const items = payload?.data?.items || [];
    const rows = items
      .map((item) => ({
        timestamp: Number(item.unixTime),
        iso: Number.isFinite(Number(item.unixTime)) ? new Date(Number(item.unixTime) * 1000).toISOString() : null,
        open: finiteNumberOrNull(item.o),
        high: finiteNumberOrNull(item.h),
        low: finiteNumberOrNull(item.l),
        close: finiteNumberOrNull(item.c),
        volumeUsd: finiteNumberOrNull(item.v),
      }))
      .filter((row) => Number.isFinite(row.timestamp) && row.close != null)
      .sort((a, b) => a.timestamp - b.timestamp);
    const value = {
      source: "birdeye",
      url: url.toString(),
      aggregateMin: aggregate,
      rows,
      meta: null,
    };
    ohlcvCache.set(cacheKey, { cachedAt: Date.now(), value });
    return value;
  } finally {
    clearTimeout(timer);
  }
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

  const aggregateMin = mgmtConfig.ohlcvDrawdownShadowAggregateMin ?? 1;
  const baseMint = position.base_mint ?? tracked?.base_mint ?? null;
  const ohlcv = await fetchBirdeyeOhlcv(baseMint, pool, {
    aggregateMin,
    beforeTimestamp: Math.floor(nowMs / 1000),
  });
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
  summarizeOhlcv,
  makeRuleRows,
  pctChange,
};
