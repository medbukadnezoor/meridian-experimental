#!/usr/bin/env node
/**
 * Synthetic proof for nanocap OHLCV drawdown + combined guard shadow logging.
 *
 * Uses stubbed OHLCV responses and a temporary state/log directory. Does not
 * import index.js, run the bot, call trading APIs, or call live OHLCV APIs.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { dirname, join } from "path";
import { pathToFileURL, fileURLToPath } from "url";

process.env.LOG_LEVEL = "error";
process.env.BIRDEYE_API_KEY = "synthetic-birdeye-key-must-not-be-used";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function baseConfig(overrides = {}) {
  return {
    ohlcvDrawdownShadowEnabled: true,
    ohlcvDrawdownShadowBotName: "nanocap",
    ohlcvDrawdownShadowAggregateMin: 1,
    ohlcvDrawdownShadowEntryDrawdownPct: -20,
    ohlcvDrawdownShadowHighDrawdownPct: -25,
    ohlcvDrawdownShadowPnlDivergenceMinPnlPct: -2,
    ohlcvDrawdownShadowCombinedPeakPct: 2,
    ohlcvDrawdownShadowCombinedCurrentPnlPct: 0,
    stopLossPct: -8,
    stopLossConfirmDelayMs: 0,
    hardStopLossPct: -15,
    trailingTakeProfit: false,
    ...overrides,
  };
}

function makePosition(position, overrides = {}) {
  return {
    position,
    pool: `pool-${position}`,
    pair: `TEST-${position}`,
    pool_name: `TEST-${position}`,
    base_mint: `base-${position}`,
    pnl_pct_suspicious: false,
    pnl_pct: -0.5,
    age_minutes: 28,
    ...overrides,
  };
}

function stubOhlcvPayload(rows) {
  return {
    data: rows.map(([timestamp, open, high, low, close, volume]) => ({
      timestamp,
      timestamp_str: new Date(timestamp * 1000).toISOString(),
      open,
      high,
      low,
      close,
      volume,
    })),
    start_time: rows[0]?.[0] ?? null,
    end_time: rows[rows.length - 1]?.[0] ?? null,
    timeframe: "5m",
  };
}

function makeProviderRows(count, start = 10_000, step = 300, base = 100) {
  return Array.from({ length: count }, (_, index) => {
    const timestamp = start + (index * step);
    const open = base + index;
    const close = open + 0.5;
    return [timestamp, open, open + 1, open - 1, close, 1000 + index];
  });
}

function installFetchStub(rowsByPool) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const parsed = new URL(String(url));
    const match = parsed.pathname.match(/\/pools\/([^/]+)\/ohlcv$/);
    const pool = match?.[1];
    const rows = rowsByPool[pool] ?? rowsByPool.default ?? [];
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(stubOhlcvPayload(rows));
      },
    };
  };
  return calls;
}

function setTracked(tempDir, position, patch) {
  const statePath = path.join(tempDir, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert(state.positions?.[position], `missing tracked position ${position}`);
  Object.assign(state.positions[position], patch);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function getTracked(tempDir, position) {
  const state = JSON.parse(fs.readFileSync(path.join(tempDir, "state.json"), "utf8"));
  return state.positions?.[position];
}

function readJsonl(file) {
  return fs.readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function main() {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-ohlcv-drawdown-shadow-"));
  const originalFetch = globalThis.fetch;
  let tempStateFileCreated = false;
  let tempDirRemoved = false;

  try {
    process.chdir(tempDir);

    const nonce = Date.now();
    const stateModule = await import(`${pathToFileURL(join(ROOT, "state.js")).href}?proof=${nonce}`);
    const shadowModule = await import(`${pathToFileURL(join(ROOT, "ohlcv-drawdown-shadow.js")).href}?proof=${nonce}`);
    const logModule = await import(`${pathToFileURL(join(ROOT, "ohlcv-drawdown-shadow-log.js")).href}?proof=${nonce}`);
    const {
      trackPosition,
      updatePnlAndCheckExits,
      markOhlcvDrawdownShadowTriggersLogged,
    } = stateModule;
    const { getOhlcvDrawdownShadowRows } = shadowModule;
    const { appendOhlcvDrawdownShadowRows } = logModule;

    function track(position, deployedAtIso) {
      trackPosition({
        position,
        pool: `pool-${position}`,
        pool_name: `TEST-${position}`,
        base_mint: `base-${position}`,
        strategy: "bid_ask",
      });
      setTracked(tempDir, position, {
        deployed_at: deployedAtIso,
        peak_pnl_pct: 3.2,
      });
    }

    const calls = installFetchStub({
      "pool-combined": [
        [1_000, 100, 110, 95, 100, 1000],
        [1_060, 99, 105, 70, 76, 1400],
        [1_120, 75, 78, 70, 74, 900],
      ],
      "pool-entry-only": [
        [1_000, 100, 101, 99, 100, 1000],
        [1_060, 98, 99, 76, 79, 1100],
      ],
      "pool-disabled": [
        [1_000, 100, 110, 95, 100, 1000],
        [1_060, 70, 72, 69, 70, 1000],
      ],
      "pool-append-failure": [
        [1_000, 100, 110, 95, 100, 1000],
        [1_060, 74, 77, 72, 74, 1000],
      ],
    });

    track("combined", "1970-01-01T00:16:40.000Z");
    const combinedPosition = makePosition("combined", { pnl_pct: -0.4 });
    const combinedExit = updatePnlAndCheckExits("combined", combinedPosition, baseConfig());
    const combinedRows = await getOhlcvDrawdownShadowRows({
      position: combinedPosition,
      tracked: getTracked(tempDir, "combined"),
      wallet: "wallet-proof",
      mgmtConfig: baseConfig(),
      nowMs: 1_120_000,
    });
    appendOhlcvDrawdownShadowRows(combinedRows, { wallet: "wallet-proof" });
    const combinedMarked = markOhlcvDrawdownShadowTriggersLogged("combined", combinedRows);
    const combinedRepeatRows = await getOhlcvDrawdownShadowRows({
      position: combinedPosition,
      tracked: getTracked(tempDir, "combined"),
      wallet: "wallet-proof",
      mgmtConfig: baseConfig(),
      nowMs: 1_120_000,
    });

    track("entry-only", "1970-01-01T00:16:40.000Z");
    setTracked(tempDir, "entry-only", { peak_pnl_pct: 1.5 });
    const entryRows = await getOhlcvDrawdownShadowRows({
      position: makePosition("entry-only", { pnl_pct: -5.5 }),
      tracked: getTracked(tempDir, "entry-only"),
      wallet: "wallet-proof",
      mgmtConfig: baseConfig(),
      nowMs: 1_060_000,
    });
    appendOhlcvDrawdownShadowRows(entryRows, { wallet: "wallet-proof" });
    const entryMarked = markOhlcvDrawdownShadowTriggersLogged("entry-only", entryRows);

    track("disabled", "1970-01-01T00:16:40.000Z");
    const disabledRows = await getOhlcvDrawdownShadowRows({
      position: makePosition("disabled", { pnl_pct: -0.5 }),
      tracked: getTracked(tempDir, "disabled"),
      wallet: "wallet-proof",
      mgmtConfig: baseConfig({ ohlcvDrawdownShadowEnabled: false }),
      nowMs: 1_060_000,
    });

    track("append-failure", "1970-01-01T00:16:40.000Z");
    const appendFailurePosition = makePosition("append-failure", { pnl_pct: -0.2 });
    const appendFailureRows = await getOhlcvDrawdownShadowRows({
      position: appendFailurePosition,
      tracked: getTracked(tempDir, "append-failure"),
      wallet: "wallet-proof",
      mgmtConfig: baseConfig(),
      nowMs: 1_060_000,
    });
    const blockedLogDir = path.join(tempDir, "blocked-log-dir");
    fs.writeFileSync(blockedLogDir, "not a directory");
    let appendFailureCaught = false;
    try {
      appendOhlcvDrawdownShadowRows(appendFailureRows, { wallet: "wallet-proof", logDir: blockedLogDir });
      markOhlcvDrawdownShadowTriggersLogged("append-failure", appendFailureRows);
    } catch {
      appendFailureCaught = true;
    }
    const rowsAfterFailure = await getOhlcvDrawdownShadowRows({
      position: appendFailurePosition,
      tracked: getTracked(tempDir, "append-failure"),
      wallet: "wallet-proof",
      mgmtConfig: baseConfig(),
      nowMs: 1_060_000,
    });
    appendOhlcvDrawdownShadowRows(rowsAfterFailure, { wallet: "wallet-proof" });
    const retryMarked = markOhlcvDrawdownShadowTriggersLogged("append-failure", rowsAfterFailure);
    const rowsAfterRetry = await getOhlcvDrawdownShadowRows({
      position: appendFailurePosition,
      tracked: getTracked(tempDir, "append-failure"),
      wallet: "wallet-proof",
      mgmtConfig: baseConfig(),
      nowMs: 1_060_000,
    });

    tempStateFileCreated = fs.existsSync(path.join(tempDir, "state.json"));
    const logFiles = fs.readdirSync(path.join(tempDir, "logs")).filter((file) => file.startsWith("ohlcv-drawdown-shadow-"));
    assert(logFiles.length === 1, "expected one OHLCV drawdown shadow log file");
    const rows = readJsonl(path.join(tempDir, "logs", logFiles[0]));

    assert(combinedExit === null, "OHLCV shadow must not select an exit action");
    assert(combinedRows.length === 4, "combined sample should log entry, high, divergence, and combined rules");
    assert(combinedRows.some((row) => row.ruleId === "combined_profit_ohlcv_drawdown"), "combined rule should trigger");
    assert(combinedRows.every((row) => row.event === "ohlcv_drawdown_shadow"), "rows should use OHLCV shadow event");
    assert(combinedRows.every((row) => row.shadowOnly === true), "rows must be shadow-only");
    assert(combinedRows.every((row) => row.source === "ohlcv-drawdown-shadow"), "rows should identify source module");
    assert(combinedRows.every((row) => ["meteora_dlmm", "gmgn_kline", "dexpaprika"].includes(row.ohlcv?.source)), "rows should carry non-Birdeye OHLCV source");
    assert(combinedRows.every((row) => row.rule?.entryDrawdownPct === -20), "rows should carry configured thresholds");
    assert(combinedMarked === true, "combined rows should mark only after append succeeds");
    assert(combinedRepeatRows.length === 0, "combined rules should dedupe after append/mark");
    assert(entryRows.length === 1, "entry-only sample should avoid divergence/combined rows when PnL is already deeply red");
    assert(entryRows[0].ruleId === "ohlcv_entry_drawdown", "entry-only rule id mismatch");
    assert(entryMarked === true, "entry-only rows should mark");
    assert(disabledRows.length === 0, "disabled config should not fetch or emit rows");
    assert(appendFailureRows.length === 4, "append-failure sample should produce rows");
    assert(appendFailureCaught === true, "append failure should be caught by verifier");
    assert(rowsAfterFailure.length === 4, "failed append must not mark dedupe state");
    assert(retryMarked === true, "retry after successful append should mark state");
    assert(rowsAfterRetry.length === 0, "successful retry should dedupe future rows");
    assert(rows.length === 9, "expected combined log rows from successful appends only");
    assert(rows.every((row) => row.shadowOnly === true), "written rows must force shadowOnly true");
    assert(rows.every((row) => row.wallet === "wallet-proof"), "written rows should preserve wallet");
    assert(calls.length >= 3, "fetch stub should be used for enabled samples");
    assert(calls.every((call) => call.url.includes("dlmm.datapi.meteora.ag/pools/")), "fetch should use Meteora DLMM pool OHLCV path");
    assert(calls.every((call) => call.url.includes("timeframe=5m")), "fetch should request Meteora's shortest documented pool timeframe");

    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDirRemoved = !fs.existsSync(tempDir);

    // ── Provider normalizer proof ─────────────────────────────────────────────
    const providerTestApi = (await import(pathToFileURL(join(ROOT, "ohlcv-drawdown-shadow.js")).href)).__test;
    const {
      normalizeMeteoraRows,
      normalizeGmgnRows,
      normalizeDexPaprikaRows,
      fetchOhlcv,
    } = providerTestApi;
    const meteoraRows = normalizeMeteoraRows({
      data: [
        { timestamp: 1000, timestamp_str: "1970-01-01T00:16:40.000Z", open: 100, high: 110, low: 95, close: 105, volume: 500 },
        { timestamp: 1060, open: 105, high: 108, low: 70, close: 76, volume: 1400 },
        { timestamp: null, open: 1, high: 2, low: 0.5, close: null, volume: 10 },
      ],
    });
    assert(meteoraRows.length === 2, "meteora normalizer should filter null close/timestamp");
    assert(meteoraRows[0].timestamp === 1000, "meteora normalizer should map timestamp");
    assert(meteoraRows[0].volumeUsd === 500, "meteora normalizer should map volume");

    const gmgnRows = normalizeGmgnRows({
      data: {
        list: [
          { time: 1_000_000_000_000, open: "100", high: "110", low: "95", close: "105", volume: "500" },
          { time: 1_000_060_000_000, open: "105", high: "108", low: "70", close: "76", volume: "1400" },
          { time: null, open: "1", high: "2", low: "0.5", close: null, volume: "10" },
        ],
      },
    });
    assert(gmgnRows.length === 2, "gmgn normalizer should filter null close/timestamp");
    assert(gmgnRows[0].timestamp === 1_000_000_000, "gmgn normalizer should convert millisecond timestamps");
    assert(gmgnRows[0].open === 100, "gmgn normalizer should parse numeric strings");

    const dexPaprikaRows = normalizeDexPaprikaRows([
      { time_open: "2026-06-19T14:00:00Z", time_close: "2026-06-19T14:05:00Z", open: "100", high: "110", low: "95", close: "105", volume_usd: "500" },
      { time_open: "2026-06-19T14:05:00Z", time_close: "2026-06-19T14:10:00Z", open: "105", high: "108", low: "70", close: "76", volume: "1400" },
      { time_open: null, open: "1", high: "2", low: "0.5", close: null, volume_usd: "10" },
    ]);
    assert(dexPaprikaRows.length === 2, "dexpaprika normalizer should filter null close/timestamp");
    assert(dexPaprikaRows[0].timestamp === 1_781_877_900, "dexpaprika normalizer should use candle close timestamp");
    assert(dexPaprikaRows[0].volumeUsd === 500, "dexpaprika normalizer should parse volume_usd");

    const originalProviderFetch = globalThis.fetch;
    const originalGmgnKey = process.env.GMGN_API_KEY;
    process.env.GMGN_API_KEY = "synthetic-gmgn-key";
    const providerCalls = [];
    const providerRows = {
      meteoraPartial: makeProviderRows(16),
      meteoraFull: makeProviderRows(40),
      gmgnEmpty: [],
      gmgnFull: makeProviderRows(40, 20_000),
      dexPartial: makeProviderRows(29, 30_000),
      dexFullOneMinute: makeProviderRows(40, 40_000, 60),
    };
    globalThis.fetch = async (url) => {
      const href = String(url);
      providerCalls.push(href);
      if (href.includes("pool-meteora-full")) {
        return { ok: true, status: 200, async text() { return JSON.stringify(stubOhlcvPayload(providerRows.meteoraFull)); } };
      }
      if (href.includes("dlmm.datapi.meteora.ag")) {
        return { ok: true, status: 200, async text() { return JSON.stringify(stubOhlcvPayload(providerRows.meteoraPartial)); } };
      }
      if (href.includes("mint-gmgn-full")) {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              data: {
                list: providerRows.gmgnFull.map(([timestamp, open, high, low, close, volume]) => ({ time: timestamp * 1000, open, high, low, close, volume })),
              },
            });
          },
        };
      }
      if (href.includes("openapi.gmgn.ai")) {
        return { ok: true, status: 200, async text() { return JSON.stringify({ data: { list: providerRows.gmgnEmpty } }); } };
      }
      if (href.includes("api.dexpaprika.com")) {
        const parsed = new URL(href);
        const isOneMinute = parsed.searchParams.get("interval") === "1m";
        const rows = isOneMinute ? providerRows.dexFullOneMinute : providerRows.dexPartial;
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify(rows.map(([timestamp, open, high, low, close, volume]) => ({
              time_open: new Date((timestamp - (isOneMinute ? 60 : 300)) * 1000).toISOString(),
              time_close: new Date(timestamp * 1000).toISOString(),
              open,
              high,
              low,
              close,
              volume_usd: volume,
            })));
          },
        };
      }
      throw new Error(`unexpected provider URL ${href}`);
    };

    const gmgnFallback = await fetchOhlcv("pool-meteora-partial-gmgn", "mint-gmgn-full", {
      aggregateMin: 5,
      beforeTimestamp: 200_000,
      lookbackMinutes: 180,
      minRows: 35,
    });
    assert(gmgnFallback.source === "gmgn_kline", "insufficient Meteora rows should fall through to GMGN rows");
    assert(gmgnFallback.rows.length === 40, "GMGN fallback should provide enough rows");

    const dexPaprikaFallback = await fetchOhlcv("pool-meteora-partial-dexpaprika", "mint-gmgn-empty", {
      aggregateMin: 5,
      beforeTimestamp: 201_000,
      lookbackMinutes: 180,
      minRows: 35,
    });
    assert(dexPaprikaFallback.source === "dexpaprika", "insufficient Meteora and GMGN rows should fall through to DexPaprika rows");
    assert(dexPaprikaFallback.aggregateMin === 1, "DexPaprika should retry at 1m when 5m rows are insufficient");
    assert(dexPaprikaFallback.rows.length === 40, "DexPaprika fallback should provide enough rows");

    const meteoraEnough = await fetchOhlcv("pool-meteora-full", "mint-gmgn-full", {
      aggregateMin: 5,
      beforeTimestamp: 202_000,
      lookbackMinutes: 180,
      minRows: 35,
    });
    assert(meteoraEnough.source === "meteora_dlmm", "sufficient Meteora rows should remain first choice");

    globalThis.fetch = originalProviderFetch;
    if (originalGmgnKey == null) delete process.env.GMGN_API_KEY;
    else process.env.GMGN_API_KEY = originalGmgnKey;

    assert(providerCalls.some((url) => url.includes("openapi.gmgn.ai")), "provider fallback proof should call GMGN");
    assert(providerCalls.some((url) => url.includes("api.dexpaprika.com/networks/solana/pools/")), "provider fallback proof should call DexPaprika");
    assert(providerCalls.some((url) => url.includes("api.dexpaprika.com") && url.includes("interval=1m")), "provider fallback proof should retry DexPaprika at 1m");
    assert(providerCalls.filter((url) => url.includes("pool-meteora-full")).length === 1, "sufficient Meteora proof should not call fallbacks");

    assert(!("normalizeBirdeyeRows" in providerTestApi), "Birdeye normalizer must not be exported from live OHLCV module");
    const providerNormalizersOk = true;

    const summary = {
      success: true,
      shadowOnly: rows.every((row) => row.shadowOnly === true),
      combinedRows: combinedRows.map((row) => row.ruleId),
      entryOnlyRows: entryRows.map((row) => row.ruleId),
      disabledRows: disabledRows.length,
      appendFailureRetry: {
        initialRows: appendFailureRows.length,
        failureCaught: appendFailureCaught,
        rowsAfterFailure: rowsAfterFailure.length,
        retryMarked,
        rowsAfterRetry: rowsAfterRetry.length,
      },
      logRows: rows.length,
      tempStateFileCreated,
      tempDirRemoved,
      fetchCalls: calls.length,
      fallbackProviderCalls: providerCalls.length,
      providerNormalizersOk,
      providerFallbacksOk: true,
    };
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
