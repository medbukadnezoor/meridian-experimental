#!/usr/bin/env node
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildConfig } from "../config-builder.js";
import {
  evaluateFabriqOhlcvEntryGate,
  evaluateFabriqOhlcvRows,
  normalizeOkxCandlestickRows,
} from "../fabriq-ohlcv-entry-gate.js";
import { __test as ohlcvInternals } from "../ohlcv-drawdown-shadow.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function row(timestamp, open, close, volumeUsd = 1000) {
  return {
    timestamp,
    iso: new Date(timestamp * 1000).toISOString(),
    open,
    high: Math.max(open, close) * 1.01,
    low: Math.min(open, close) * 0.99,
    close,
    volumeUsd,
  };
}

function bullishRows(count = 45) {
  const out = [];
  let price = 1;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    price = price * (i < count - 4 ? 1.003 : 1.018);
    out.push(row(1_800_000_000 + i * 60, open, price, i < count - 3 ? 900 : 2500));
  }
  return out;
}

function collapsingPumpRows() {
  const rows = bullishRows(30);
  rows.push(row(1_800_001_800, 1.5, 1.9, 5000));
  rows.push(row(1_800_001_860, 1.9, 1.42, 4500));
  rows.push(row(1_800_001_920, 1.42, 1.35, 3000));
  return rows;
}

function gateConfig(overrides = {}) {
  return {
    screening: {
      fabriqOhlcvEntryGateEnabled: true,
      fabriqOhlcvEntryGateMode: "live",
      fabriqOhlcvEntryGateProviders: ["dexpaprika", "gmgn", "okx"],
      fabriqOhlcvEntryGateDecisiveProviderOrder: ["dexpaprika", "gmgn", "okx"],
      fabriqOhlcvEntryGateIntervals: ["1m"],
      fabriqOhlcvEntryGateLookbackMinutes: 180,
      fabriqOhlcvEntryGateMinRows: 20,
      fabriqOhlcvEntryGateBlockOnMissingOhlcv: true,
      ...(overrides.screening ?? {}),
    },
  };
}

const dexRows = ohlcvInternals.normalizeDexPaprikaRows([
  {
    time_open: "2026-06-20T00:00:00Z",
    time_close: "2026-06-20T00:01:00Z",
    open: 1,
    high: 1.1,
    low: 0.9,
    close: 1.05,
    volume_usd: 1234,
  },
]);
assert.strictEqual(dexRows[0].volumeUsd, 1234, "DexPaprika volume_usd normalizes to volumeUsd");
assert.strictEqual(dexRows[0].timestamp, 1781913660, "DexPaprika time_close is decisive timestamp");

const gmgnRows = ohlcvInternals.normalizeGmgnRows({
  data: {
    list: [
      { time: 1781913600000, open: "1", high: "1.1", low: "0.9", close: "1.05", volume: "1214", amount: "5379110" },
    ],
  },
});
assert.strictEqual(gmgnRows[0].volumeUsd, 1214, "GMGN kline uses USD volume, not token amount");

const okxRows = normalizeOkxCandlestickRows({
  data: [
    { ts: "1781913600000", o: "1", h: "1.1", l: "0.9", c: "1.05", volUsd: "888", confirm: "1" },
  ],
});
assert.strictEqual(okxRows[0].volumeUsd, 888, "OKX object candlestick maps volUsd");
assert.strictEqual(okxRows[0].timestamp, 1781913600, "OKX ms timestamp normalizes to seconds");

const okxArrayRows = normalizeOkxCandlestickRows([["1781913600000", "1", "1.1", "0.9", "1.05", "777", "999", "1"]]);
assert.strictEqual(okxArrayRows[0].volumeUsd, 999, "OKX array candlestick maps [ts,o,h,l,c,vol,volUsd,confirm]");

const accepted = evaluateFabriqOhlcvRows({ rows: bullishRows(), source: "dexpaprika" }, { active_tvl: 10_000 });
assert.strictEqual(accepted.result, "accept", "bullish high-volume rows are accepted");
assert.ok(accepted.reason_codes.includes("volume_expansion"), "volume expansion reason is present");

const rejected = evaluateFabriqOhlcvRows({ rows: collapsingPumpRows(), source: "dexpaprika" }, { active_tvl: 10_000 });
assert.strictEqual(rejected.result, "reject", "collapsing post-spike candle is rejected");
assert.ok(rejected.reason_codes.includes("pump_retrace_reject"), "pump-retrace reason is present");

const candidate = { pool_address: "poolA", base_mint: "mintA", active_tvl: 10_000 };
const sufficientDex = await evaluateFabriqOhlcvEntryGate(candidate, gateConfig(), {
  nowMs: 1_800_003_000_000,
  providers: {
    dexpaprika: async () => ({ source: "dexpaprika", aggregateMin: 1, rows: bullishRows() }),
    gmgn: async () => { throw new Error("gmgn should not be decisive when DexPaprika is sufficient"); },
    okx: async () => { throw new Error("okx should not be decisive when DexPaprika is sufficient"); },
  },
});
assert.strictEqual(sufficientDex.result, "accept", "DexPaprika sufficient rows accept");
assert.strictEqual(sufficientDex.decisive_provider, "dexpaprika", "DexPaprika is decisive first");

const gmgnFallback = await evaluateFabriqOhlcvEntryGate(candidate, gateConfig(), {
  nowMs: 1_800_003_000_000,
  providers: {
    dexpaprika: async () => ({ source: "dexpaprika", aggregateMin: 1, rows: bullishRows(3) }),
    gmgn: async () => ({ source: "gmgn_kline", aggregateMin: 1, rows: bullishRows() }),
    okx: async () => null,
  },
});
assert.strictEqual(gmgnFallback.result, "accept", "GMGN accepts when DexPaprika is sparse");
assert.strictEqual(gmgnFallback.decisive_provider, "gmgn", "GMGN is decisive fallback");

const okxFallback = await evaluateFabriqOhlcvEntryGate(candidate, gateConfig(), {
  nowMs: 1_800_003_000_000,
  providers: {
    dexpaprika: async () => ({ source: "dexpaprika", aggregateMin: 1, rows: [] }),
    gmgn: async () => ({ source: "gmgn_kline", aggregateMin: 1, rows: bullishRows(4) }),
    okx: async () => ({ source: "okx", aggregateMin: 1, rows: bullishRows() }),
  },
});
assert.strictEqual(okxFallback.result, "accept", "OKX accepts when DexPaprika and GMGN are sparse");
assert.strictEqual(okxFallback.decisive_provider, "okx", "OKX is decisive final fallback");

const missing = await evaluateFabriqOhlcvEntryGate(candidate, gateConfig(), {
  nowMs: 1_800_003_000_000,
  providers: {
    dexpaprika: async () => ({ source: "dexpaprika", aggregateMin: 1, rows: [] }),
    gmgn: async () => null,
    okx: async () => ({ source: "okx", aggregateMin: 1, rows: bullishRows(2) }),
  },
});
assert.strictEqual(missing.result, "missing_evidence", "all insufficient providers return missing evidence");
assert.ok(missing.reason_codes.includes("missing_ohlcv_evidence"), "missing evidence reason is logged");

const built = buildConfig({
  fabriqOhlcvEntryGateEnabled: true,
  fabriqOhlcvEntryGateMode: "live",
  fabriqOhlcvEntryGateProviders: ["dexpaprika", "gmgn", "okx"],
});
assert.strictEqual(built.screening.fabriqOhlcvEntryGateEnabled, true, "config builder maps OHLCV entry gate enabled");
assert.deepStrictEqual(built.screening.fabriqOhlcvEntryGateProviders, ["dexpaprika", "gmgn", "okx"], "config builder maps provider order");

const executor = read("tools/executor.js");
assert.ok(executor.includes("evaluateFabriqOhlcvEntryGate"), "executor calls Fabriq OHLCV entry gate");
assert.ok(executor.includes("fabriq_ohlcv_entry_gate"), "executor attaches OHLCV gate decision to deploy args");
assert.ok(executor.includes("fabriq OHLCV entry gate missing evidence"), "executor live-blocks missing evidence");

const source = read("fabriq-ohlcv-entry-gate.js");
assert.ok(source.includes("OKX_API_KEY") && source.includes("OK_ACCESS_KEY"), "OKX fallback reuses existing env credential names");
assert.ok(source.includes("chainIndex: OKX_CHAIN_SOLANA"), "OKX fallback uses Solana chain index 501");
assert.ok(!source.includes("console.log(getOkx"), "OKX secrets are not printed");

const example = JSON.parse(read("user-config.example.json"));
assert.strictEqual(example.fabriqOhlcvEntryGateEnabled, true, "example config enables OHLCV entry gate");
assert.strictEqual(example.fabriqOhlcvEntryGateMode, "live", "example config ships OHLCV entry gate live");

console.log(JSON.stringify({
  success: true,
  cases: {
    dexpaprikaDecisive: sufficientDex.decisive_provider,
    gmgnFallback: gmgnFallback.decisive_provider,
    okxFallback: okxFallback.decisive_provider,
    missing: missing.result,
  },
  checks: [
    "DexPaprika volume_usd normalizes",
    "GMGN kline uses USD volume, not amount",
    "OKX ts/o/h/l/c/volUsd normalizes",
    "Provider precedence is DexPaprika -> GMGN -> OKX",
    "Live missing evidence blocks at executor boundary",
  ],
}, null, 2));
