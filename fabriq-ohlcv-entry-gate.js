import crypto from "crypto";
import { __test as ohlcvInternals } from "./ohlcv-drawdown-shadow.js";

const OKX_BASE_URL = "https://web3.okx.com";
const OKX_CHAIN_SOLANA = "501";
const REQUEST_TIMEOUT_MS = 4_000;
const BACKOFF_DURATION_MS = 300_000;

const providerBackoff = {
  okx: { until: 0 },
};

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizeMode(value) {
  const normalized = String(value || "shadow").trim().toLowerCase();
  return normalized === "live" ? "live" : "shadow";
}

function normalizeInterval(interval) {
  const normalized = String(interval || "1m").trim().toLowerCase();
  return ["1m", "5m", "15m"].includes(normalized) ? normalized : "1m";
}

function aggregateFromInterval(interval) {
  const normalized = normalizeInterval(interval);
  return Number(normalized.replace("m", ""));
}

function getOkxApiKey(env = process.env) {
  return env.OKX_API_KEY || env.OK_ACCESS_KEY || "";
}

function getOkxSecretKey(env = process.env) {
  return env.OKX_SECRET_KEY || env.OK_ACCESS_SECRET || "";
}

function getOkxPassphrase(env = process.env) {
  return env.OKX_PASSPHRASE || env.OKX_API_PASSPHRASE || env.OK_ACCESS_PASSPHRASE || "";
}

function getOkxProjectId(env = process.env) {
  return env.OKX_PROJECT_ID || env.OK_ACCESS_PROJECT || "";
}

function hasOkxCredentials(env = process.env) {
  return Boolean(getOkxApiKey(env) && getOkxSecretKey(env) && getOkxPassphrase(env));
}

function okxAuthHeaders(method, requestPath, bodyText = "", env = process.env) {
  const timestamp = new Date().toISOString();
  const prehash = `${timestamp}${method.toUpperCase()}${requestPath}${bodyText}`;
  const sign = crypto
    .createHmac("sha256", getOkxSecretKey(env))
    .update(prehash)
    .digest("base64");
  const headers = {
    "OK-ACCESS-KEY": getOkxApiKey(env),
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-PASSPHRASE": getOkxPassphrase(env),
    "OK-ACCESS-TIMESTAMP": timestamp,
  };
  const projectId = getOkxProjectId(env);
  if (projectId) headers["OK-ACCESS-PROJECT"] = projectId;
  return headers;
}

export function normalizeOkxCandlestickRows(payload) {
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.candlesticks)
        ? payload.candlesticks
        : Array.isArray(payload?.list)
          ? payload.list
          : [];
  return raw
    .map((item) => {
      const row = Array.isArray(item)
        ? { ts: item[0], o: item[1], h: item[2], l: item[3], c: item[4], vol: item[5], volUsd: item[6], confirm: item[7] }
        : item;
      const rawTime = finiteNumber(row?.ts ?? row?.time ?? row?.timestamp);
      const timestamp = rawTime == null ? null : rawTime > 10_000_000_000 ? Math.floor(rawTime / 1000) : Math.floor(rawTime);
      return {
        timestamp,
        iso: timestamp != null ? new Date(timestamp * 1000).toISOString() : null,
        open: finiteNumber(row?.o ?? row?.open),
        high: finiteNumber(row?.h ?? row?.high),
        low: finiteNumber(row?.l ?? row?.low),
        close: finiteNumber(row?.c ?? row?.close),
        volumeUsd: finiteNumber(row?.volUsd ?? row?.volumeUsd ?? row?.volume_usd ?? row?.vol ?? row?.volume),
        confirm: row?.confirm ?? null,
      };
    })
    .filter((row) => Number.isFinite(row.timestamp) && row.close != null)
    .sort((a, b) => a.timestamp - b.timestamp);
}

async function okxRequest(requestPath, env = process.env) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${OKX_BASE_URL}${requestPath}`, {
      headers: {
        ...okxAuthHeaders("GET", requestPath, "", env),
        accept: "application/json",
      },
      signal: controller.signal,
    });
    const text = await res.text();
    if (res.status === 429) {
      providerBackoff.okx.until = Date.now() + BACKOFF_DURATION_MS;
      return { rateLimited: true, rows: [] };
    }
    const payload = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`OKX candlesticks ${res.status}: ${String(payload?.msg || payload?.message || text).slice(0, 160)}`);
    if (payload?.code != null && String(payload.code) !== "0") {
      if (String(payload.code) === "50011") providerBackoff.okx.until = Date.now() + BACKOFF_DURATION_MS;
      throw new Error(`OKX candlesticks ${payload.code}: ${String(payload.msg || payload.message || "unknown").slice(0, 160)}`);
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") return null;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchOkxTokenCandlesticks(tokenMint, {
  interval = "1m",
  lookbackMinutes = 180,
  beforeTimestamp = null,
  env = process.env,
} = {}) {
  if (!tokenMint || !hasOkxCredentials(env)) return null;
  if (Date.now() < providerBackoff.okx.until) return null;
  const bar = normalizeInterval(interval);
  const endMs = Math.floor(Number(beforeTimestamp ?? Date.now() / 1000)) * 1000;
  const afterMs = endMs - Math.max(1, Number(lookbackMinutes) || 180) * 60_000;
  const params = new URLSearchParams({
    chainIndex: OKX_CHAIN_SOLANA,
    tokenContractAddress: tokenMint,
    bar,
    after: String(afterMs),
    before: String(endMs),
    limit: "300",
  });
  const requestPath = `/api/v6/dex/market/candlesticks?${params.toString()}`;
  let payload = await okxRequest(requestPath, env);
  if (!payload || payload.rateLimited) return null;
  let rows = normalizeOkxCandlestickRows(payload);
  if (rows.length === 0) {
    const historyPath = `/api/v6/dex/market/candlesticks-history?${params.toString()}`;
    payload = await okxRequest(historyPath, env);
    rows = normalizeOkxCandlestickRows(payload);
  }
  return {
    source: "okx",
    aggregateMin: aggregateFromInterval(bar),
    interval: bar,
    rows,
    meta: { chainIndex: OKX_CHAIN_SOLANA },
  };
}

export function resolveFabriqOhlcvEntryGatePolicy(runtimeConfig = {}) {
  const screening = runtimeConfig.screening ?? {};
  return {
    enabled: screening.fabriqOhlcvEntryGateEnabled === true,
    mode: normalizeMode(screening.fabriqOhlcvEntryGateMode),
    providers: Array.isArray(screening.fabriqOhlcvEntryGateProviders)
      ? screening.fabriqOhlcvEntryGateProviders
      : ["dexpaprika", "gmgn", "okx"],
    decisiveProviderOrder: Array.isArray(screening.fabriqOhlcvEntryGateDecisiveProviderOrder)
      ? screening.fabriqOhlcvEntryGateDecisiveProviderOrder
      : ["dexpaprika", "gmgn", "okx"],
    intervals: Array.isArray(screening.fabriqOhlcvEntryGateIntervals)
      ? screening.fabriqOhlcvEntryGateIntervals.map(normalizeInterval)
      : ["1m", "5m", "15m"],
    lookbackMinutes: positiveInteger(screening.fabriqOhlcvEntryGateLookbackMinutes, 180),
    minRows: positiveInteger(screening.fabriqOhlcvEntryGateMinRows, 20),
    minScore: positiveInteger(screening.fabriqOhlcvEntryGateMinScore, 3),
    knifeVetoEnabled: screening.fabriqOhlcvEntryGateKnifeVetoEnabled !== false,
    retraceVetoPct: finiteNumber(screening.fabriqOhlcvEntryGateRetraceVetoPct) ?? -25,
    reboundMinPct: finiteNumber(screening.fabriqOhlcvEntryGateReboundMinPct) ?? 3,
    blockOnMissingOhlcv: screening.fabriqOhlcvEntryGateBlockOnMissingOhlcv !== false,
  };
}

function closes(rows) {
  return rows.map((row) => finiteNumber(row.close)).filter((value) => value != null);
}

function volumes(rows) {
  return rows.map((row) => finiteNumber(row.volumeUsd)).filter((value) => value != null);
}

function calculateRsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  const start = values.length - period;
  for (let i = start; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function sma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / slice.length;
}

function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const alpha = 2 / (period + 1);
  const out = [];
  let prev = sma(values.slice(0, period), period);
  out.push(prev);
  for (const value of values.slice(period)) {
    prev = (value - prev) * alpha + prev;
    out.push(prev);
  }
  return out;
}

function macdHistogram(values) {
  if (!Array.isArray(values) || values.length < 35) return null;
  const fast = emaSeries(values, 12);
  const slow = emaSeries(values, 26);
  const offset = fast.length - slow.length;
  const macd = slow.map((value, index) => fast[index + offset] - value);
  const signal = emaSeries(macd, 9);
  if (signal.length < 2) return null;
  const hist = macd.slice(-signal.length).map((value, index) => value - signal[index]);
  return { previous: hist.at(-2), current: hist.at(-1) };
}

function bollinger(values, period = 20, multiplier = 2) {
  if (!Array.isArray(values) || values.length < period) return null;
  const slice = values.slice(-period);
  const mid = slice.reduce((sum, value) => sum + value, 0) / period;
  const variance = slice.reduce((sum, value) => sum + ((value - mid) ** 2), 0) / period;
  const std = Math.sqrt(variance);
  return { lower: mid - std * multiplier, middle: mid, upper: mid + std * multiplier };
}

function rowPctChange(current, reference) {
  if (current == null || reference == null || reference <= 0) return null;
  return ((current / reference) - 1) * 100;
}

export function evaluateFabriqOhlcvRows(ohlcv, candidate = {}, opts = {}) {
  const { minScore = 3, knifeVetoEnabled = true, retraceVetoPct = -25, reboundMinPct = 3 } = opts;
  const rows = Array.isArray(ohlcv?.rows) ? ohlcv.rows : [];
  const closeValues = closes(rows);
  const volumeValues = volumes(rows);
  const reasonCodes = [];
  let score = 0;
  const latest = rows.at(-1) ?? null;
  const prev = rows.at(-2) ?? null;
  const first = rows[0] ?? null;
  const high = rows.reduce((best, row) => row.high != null && (!best || row.high > best.high) ? row : best, null);
  const low = rows.reduce((best, row) => row.low != null && (!best || row.low < best.low) ? row : best, null);
  const rsi = calculateRsi(closeValues, 14);
  const bb = bollinger(closeValues, 20, 2);
  const macd = macdHistogram(closeValues);
  const currentVolume = finiteNumber(latest?.volumeUsd);
  const avgVolume = volumeValues.length >= 10 ? sma(volumeValues, Math.min(20, volumeValues.length)) : null;
  const activeTvl = finiteNumber(candidate.active_tvl ?? candidate.tvl);
  const volumeActiveTvl = currentVolume != null && activeTvl != null && activeTvl > 0 ? currentVolume / activeTvl : null;
  const trendPct = rowPctChange(latest?.close, first?.open ?? first?.close);
  const retraceFromHighPct = rowPctChange(latest?.close, high?.high);
  const reboundFromLowPct = rowPctChange(latest?.close, low?.low);
  const latestGreen = latest?.close != null && latest?.open != null && latest.close >= latest.open;
  const closeRising = latest?.close != null && prev?.close != null && latest.close > prev.close;

  if (rsi != null && rsi >= 55 && rsi <= 82) {
    score += 1;
    reasonCodes.push("rsi_momentum");
  } else if (rsi != null && rsi < 35 && closeRising) {
    score += 1;
    reasonCodes.push("rsi_reversal");
  }

  if (bb && latest?.close != null && latest.close >= bb.lower && latest.close <= bb.middle && closeRising) {
    score += 1;
    reasonCodes.push("bollinger_reversion");
  }

  if (macd?.current != null && macd?.previous != null && macd.current > macd.previous) {
    score += 1;
    reasonCodes.push(macd.current >= 0 && macd.previous < 0 ? "macd_first_green" : "macd_histogram_turn");
  }

  if (currentVolume != null && avgVolume != null && currentVolume >= avgVolume * 1.25) {
    score += 1;
    reasonCodes.push("volume_expansion");
  }

  if (volumeActiveTvl != null && volumeActiveTvl >= 0.05) {
    score += 1;
    reasonCodes.push("volume_active_tvl_support");
  }

  if (latestGreen && closeRising) {
    score += 1;
    reasonCodes.push("short_term_rebound");
  }

  const pumpRetrace = trendPct != null && trendPct > 25 && retraceFromHighPct != null && retraceFromHighPct <= -18;
  const reboundPass = reboundFromLowPct != null && reboundFromLowPct >= reboundMinPct && latestGreen && closeRising;
  if (pumpRetrace && !reboundPass) {
    reasonCodes.push("pump_retrace_reject");
    return {
      result: "reject",
      score,
      selected_signal: null,
      reason_codes: reasonCodes,
      indicators: { rsi, macd, bollinger: bb, trendPct, retraceFromHighPct, reboundFromLowPct, volumeActiveTvl },
    };
  }
  if (pumpRetrace && reboundPass) reasonCodes.push("pump_retrace_rebound_pass");

  const sharpRetraceKnife = knifeVetoEnabled
    && retraceFromHighPct != null && retraceFromHighPct <= retraceVetoPct
    && !reboundPass;
  if (sharpRetraceKnife) {
    reasonCodes.push("first_bounce_knife_reject");
    return {
      result: "reject",
      score,
      selected_signal: null,
      reason_codes: reasonCodes,
      indicators: { rsi, macd, bollinger: bb, trendPct, retraceFromHighPct, reboundFromLowPct, volumeActiveTvl },
    };
  }

  return {
    result: score >= minScore ? "accept" : "reject",
    score,
    selected_signal: reasonCodes.find((code) => ["macd_first_green", "rsi_momentum", "rsi_reversal", "volume_expansion"].includes(code)) ?? reasonCodes[0] ?? null,
    reason_codes: reasonCodes,
    indicators: { rsi, macd, bollinger: bb, trendPct, retraceFromHighPct, reboundFromLowPct, volumeActiveTvl },
  };
}

function sufficient(ohlcv, minRows) {
  return Array.isArray(ohlcv?.rows) && ohlcv.rows.length >= minRows;
}

async function fetchProvider(provider, candidate, interval, policy, providers, nowMs) {
  const aggregateMin = aggregateFromInterval(interval);
  const pool = candidate.pool_address ?? candidate.pool ?? candidate.address ?? null;
  const tokenMint = candidate.base_mint ?? candidate.base?.mint ?? candidate.mint ?? null;
  const opts = {
    aggregateMin,
    interval,
    beforeTimestamp: Math.floor(nowMs / 1000),
    lookbackMinutes: policy.lookbackMinutes,
  };
  if (provider === "dexpaprika") return providers.dexpaprika(pool, opts);
  if (provider === "gmgn") return providers.gmgn(tokenMint, opts);
  if (provider === "okx") return providers.okx(tokenMint, opts);
  return null;
}

export async function evaluateFabriqOhlcvEntryGate(candidate = {}, runtimeConfig = {}, options = {}) {
  const policy = resolveFabriqOhlcvEntryGatePolicy(runtimeConfig);
  const providerAttempts = [];
  const nowMs = options.nowMs ?? Date.now();
  const providers = {
    dexpaprika: options.providers?.dexpaprika ?? ohlcvInternals.fetchDexPaprikaPoolOhlcv,
    gmgn: options.providers?.gmgn ?? ohlcvInternals.fetchGmgnKlineOhlcv,
    okx: options.providers?.okx ?? fetchOkxTokenCandlesticks,
  };

  const gate = {
    enabled: policy.enabled,
    mode: policy.mode,
    result: "disabled",
    live_applied: false,
    decisive_provider: null,
    decisive_source: null,
    interval: null,
    row_count: 0,
    score: null,
    selected_signal: null,
    reason_codes: [],
    provider_attempts: providerAttempts,
  };
  if (!policy.enabled) return gate;

  for (const provider of policy.decisiveProviderOrder) {
    if (!policy.providers.includes(provider)) continue;
    for (const interval of policy.intervals) {
      try {
        const ohlcv = await fetchProvider(provider, candidate, interval, policy, providers, nowMs);
        const rowCount = Array.isArray(ohlcv?.rows) ? ohlcv.rows.length : 0;
        providerAttempts.push({
          provider,
          source: ohlcv?.source ?? provider,
          interval,
          row_count: rowCount,
          sufficient: rowCount >= policy.minRows,
        });
        if (!sufficient(ohlcv, policy.minRows)) continue;
        const evaluated = evaluateFabriqOhlcvRows(ohlcv, candidate, {
          minScore: policy.minScore,
          knifeVetoEnabled: policy.knifeVetoEnabled,
          retraceVetoPct: policy.retraceVetoPct,
          reboundMinPct: policy.reboundMinPct,
        });
        return {
          ...gate,
          result: evaluated.result,
          live_applied: policy.mode === "live",
          decisive_provider: provider,
          decisive_source: ohlcv.source ?? provider,
          interval,
          row_count: rowCount,
          score: evaluated.score,
          selected_signal: evaluated.selected_signal,
          reason_codes: evaluated.reason_codes,
          indicators: evaluated.indicators,
        };
      } catch (error) {
        providerAttempts.push({
          provider,
          interval,
          row_count: 0,
          sufficient: false,
          error: String(error?.message || error).slice(0, 160),
        });
      }
    }
  }

  gate.result = "missing_evidence";
  gate.live_applied = policy.mode === "live";
  gate.reason_codes = ["missing_ohlcv_evidence"];
  return gate;
}

export const __test = {
  finiteNumber,
  normalizeOkxCandlestickRows,
  resolveFabriqOhlcvEntryGatePolicy,
  evaluateFabriqOhlcvRows,
  evaluateFabriqOhlcvEntryGate,
};
