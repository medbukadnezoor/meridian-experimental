const GECKOTERMINAL_SOLANA_POOL_OHLCV = "https://api.geckoterminal.com/api/v2/networks/solana/pools";
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

async function fetchGeckoTerminalOhlcv(pool, { aggregateMin = 1, beforeTimestamp = null } = {}) {
  const aggregate = clampAggregate(aggregateMin);
  const before = Math.floor(Number(beforeTimestamp ?? Date.now() / 1000));
  const cacheKey = `${pool}:${aggregate}:${Math.floor(before / 30)}`;
  const cached = ohlcvCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.value;

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
  const ohlcv = await fetchGeckoTerminalOhlcv(pool, {
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
