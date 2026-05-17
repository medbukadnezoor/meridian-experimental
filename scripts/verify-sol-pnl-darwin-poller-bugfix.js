#!/usr/bin/env node
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { pathToFileURL } from "url";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function src(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

const index = src("index.js");
const dlmm = src("tools/dlmm.js");
const tracker = src("signal-tracker.js");
const lessons = src("lessons.js");
const weights = src("signal-weights.js");
const pollerStart = index.indexOf("const pnlPollInterval = setInterval");
const pollerEnd = index.indexOf("_cronTasks._pnlPollInterval", pollerStart);
const poller = pollerStart >= 0 && pollerEnd > pollerStart
  ? index.slice(pollerStart, pollerEnd)
  : "";

function functionBlock(source, name) {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not parse function ${name}`);
}

function loadClosedPnlHelpers() {
  const code = [
    functionBlock(dlmm, "maybeNum"),
    functionBlock(dlmm, "getClosedPnlValue"),
    functionBlock(dlmm, "getClosedPnlPct"),
    "return { getClosedPnlValue, getClosedPnlPct };",
  ].join("\n\n");
  return new Function(code)();
}

function almostEqual(actual, expected, epsilon = 1e-9) {
  return Math.abs(actual - expected) <= epsilon;
}

async function runSyntheticProofs() {
  const { getClosedPnlValue, getClosedPnlPct } = loadClosedPnlHelpers();
  const nativeEntry = {
    pnlUsd: "99",
    pnlPctChange: "9900",
    pnlSol: "0.125",
    pnlSolPctChange: "12.5",
    pnl: { value: "88", percent: "8800", valueNative: "0.124", percentNative: "12.4" },
    allTimeDeposits: { total: { sol: "1", usd: "100" } },
    allTimeWithdrawals: { total: { sol: "1.1", usd: "110" } },
    allTimeFees: { total: { sol: "0.025", usd: "2.5" } },
  };
  const fallbackEntry = {
    pnlUsd: "99",
    pnlPctChange: "9900",
    allTimeDeposits: { total: { sol: "1", usd: "100" } },
    allTimeWithdrawals: { total: { sol: "1.08", usd: "108" } },
    allTimeFees: { total: { sol: "0.02", usd: "2" } },
  };

  const solNativeProof =
    almostEqual(getClosedPnlValue(nativeEntry, true), 0.125) &&
    almostEqual(getClosedPnlPct(nativeEntry, true), 12.5) &&
    almostEqual(getClosedPnlValue(nativeEntry, false), 99) &&
    almostEqual(getClosedPnlPct(nativeEntry, false), 9900);

  const solFallbackProof =
    almostEqual(getClosedPnlValue(fallbackEntry, true), 0.1) &&
    almostEqual(getClosedPnlPct(fallbackEntry, true), 10);

  const trackerModule = await import(`${pathToFileURL(join(ROOT, "signal-tracker.js")).href}?verify=${Date.now()}`);
  trackerModule.stageSignals("pool-A", {
    base_mint: "mint-A",
    organic_score: 77,
    fee_tvl_ratio: 0.23,
  });
  const byBaseMint = trackerModule.getAndClearStagedSignals("pool-mismatch", "mint-A");
  const afterClear = trackerModule.getAndClearStagedSignals("pool-A", "mint-A");
  const baseMintRecoveryProof =
    byBaseMint?.base_mint === "mint-A" &&
    byBaseMint?.organic_score === 77 &&
    byBaseMint?.fee_tvl_ratio === 0.23 &&
    afterClear === null;

  return {
    solNativeClosedPnl: solNativeProof,
    solFallbackClosedPnl: solFallbackProof,
    stagedSignalBaseMintRecovery: baseMintRecoveryProof,
  };
}

const checks = [
  {
    name: "30s poller skips relay reads when no tracked open positions exist",
    ok: /import \{[^}]*getTrackedPositions[^}]*\} from "\.\/state\.js"/.test(index) &&
      poller.includes("getTrackedPositions(true).length === 0") &&
      poller.indexOf("getTrackedPositions(true).length === 0") < poller.indexOf("getMyPositions({ force: true, silent: true })"),
  },
  {
    name: "screening and manual deploy staging preserve base_mint provenance",
    ok: (index.match(/base_mint:\s*baseMint/g) || []).length >= 2 &&
      index.includes("pool.base?.mint || pool.base_mint || ti?.mint") &&
      index.includes("candidate.base?.mint || candidate.base_mint || candidate.mint"),
  },
  {
    name: "staged Darwin signals can be recovered by pool or base mint",
    ok: tracker.includes("_stagedByBaseMint") &&
      tracker.includes("getAndClearStagedSignals(poolAddress, baseMint = null)") &&
      tracker.includes("_stagedByBaseMint.get(baseKey)") &&
      tracker.includes("_stagedByBaseMint.delete(data.base_mint)"),
  },
  {
    name: "closed PnL helpers prefer SOL-native Meteora fields in solMode",
    ok: dlmm.includes("function getClosedPnlValue(posEntry, solMode = false)") &&
      dlmm.includes("posEntry?.pnlSol") &&
      dlmm.includes("posEntry?.pnl?.valueNative") &&
      dlmm.includes("function getClosedPnlPct(posEntry, solMode = false)") &&
      dlmm.includes("posEntry?.pnlSolPctChange") &&
      dlmm.includes("posEntry?.pnl?.percentNative"),
  },
  {
    name: "deploy and close performance paths persist Darwin signal snapshots",
    ok: (dlmm.match(/getAndClearStagedSignals\(pool_address,\s*baseMint\)/g) || []).length >= 2 &&
      dlmm.includes("function resolvePerformanceSignalSnapshot") &&
      (dlmm.match(/signal_snapshot:\s*signalSnapshot/g) || []).length >= 3 &&
      (dlmm.match(/base_mint:\s*closeBaseMint/g) || []).length >= 2,
  },
  {
    name: "lessons backfill signal_snapshot fields before performance recording",
    ok: lessons.includes("function buildSignalSnapshot(perf)") &&
      lessons.includes("signal_snapshot: signalSnapshot") &&
      lessons.includes("PERFORMANCE_SIGNAL_FIELDS"),
  },
  {
    name: "Darwin weights read signal_snapshot with legacy top-level fallback",
    ok: weights.includes("function getRecordSignalValue(record, signal)") &&
      weights.includes("record.signal_snapshot || {}") &&
      weights.includes("return record.organic_score ?? null") &&
      weights.includes("return record.fee_tvl_ratio ?? null"),
  },
];

const synthetic = await runSyntheticProofs();
checks.push(
  {
    name: "synthetic SOL-native closed PnL uses native fields before USD fields",
    ok: synthetic.solNativeClosedPnl,
  },
  {
    name: "synthetic SOL closed PnL fallback derives native value and percent from SOL totals",
    ok: synthetic.solFallbackClosedPnl,
  },
  {
    name: "synthetic Darwin staged signals recover once by base mint when pool address changed",
    ok: synthetic.stagedSignalBaseMintRecovery,
  },
);

const failed = checks.filter((check) => !check.ok);
if (failed.length) {
  console.error(JSON.stringify({ success: false, failed: failed.map((check) => check.name), checks }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  success: true,
  checks: checks.map((check) => check.name),
  synthetic,
}, null, 2));
