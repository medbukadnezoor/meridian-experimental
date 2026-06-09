#!/usr/bin/env node
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

import { buildCandidateDecisionContext } from "../decision-context-log.js";
import {
  appendMomentumScoreV1,
  attachMomentumScoreV1,
  computeMomentumScoreV1,
  DYNAMIC_ENTRY_SHADOW_VERSION,
  getMomentumScoreLogPath,
  MOMENTUM_SCORE_VERSION,
} from "../momentum-score-v1.js";
import { buildMomentumScoreReport } from "./report-momentum-score-v1.js";
import {
  filterConfiguredPoolThresholds,
  getConfiguredPoolThresholdVetoReason,
  rankCandidatesByDarwin,
} from "../tools/screening.js";

function candidate(overrides = {}) {
  return {
    pool: "PoolMomentum1111111111111111111111111111111",
    name: "MOMO-SOL",
    base: { mint: "BaseMomentum1111111111111111111111111111111", symbol: "MOMO", organic: 80 },
    quote: { symbol: "SOL", organic: 90 },
    fee_active_tvl_ratio: 10,
    fee_pct: 5,
    volatility: 5,
    bin_step: 100,
    active_tvl: 20_000,
    volume_window: 100_000,
    volume_active_tvl_multiple: 5,
    fee_velocity_usd_per_min: 160,
    price_change_pct: 25,
    price_change_1h: 25,
    price_change_5m: 18,
    volume_change_pct: 45,
    buy_vol: 10_000,
    sell_vol: 6_000,
    mcap: 300_000,
    holders: 800,
    organic_score: 80,
    quote_organic_score: 90,
    token_age_hours: 12,
    ...overrides,
  };
}

const full = computeMomentumScoreV1(candidate(), { profile: "patient_fee_harvest" });
assert.strictEqual(full.version, MOMENTUM_SCORE_VERSION);
assert.strictEqual(full.dynamic_entry_shadow.version, DYNAMIC_ENTRY_SHADOW_VERSION);
assert.strictEqual(full.shadowOnly, true);
assert.strictEqual(full.momentum_profile, "patient_fee_harvest");
assert.ok(full.momentum_score_v1 >= 75, "full-data candidate should score as accelerating");
assert.strictEqual(full.momentum_classification, "accelerating");
assert.strictEqual(full.would_throttle, "none");
assert.ok(full.confidence >= 0.99, "full-data candidate should have high confidence");

const strongProfit = computeMomentumScoreV1(candidate({
  assumed_deploy_usd: 100,
  tx_cost_usd: 0.4,
  slippage_budget_usd: 0.5,
  reposition_budget_usd: 0.2,
  tail_risk_budget_usd: 1,
}), { profile: "patient_fee_harvest" });
assert.strictEqual(strongProfit.dynamic_entry_shadow.entry_label, "live_candidate", "strong candidate is a shadow live candidate");
assert.ok(strongProfit.dynamic_entry_shadow.estimated_net_fees_usd > 0, "strong candidate estimates positive net fees");
assert.ok(strongProfit.dynamic_entry_shadow.breakeven_hold_minutes > 0, "strong candidate computes breakeven minutes");

const cgoLike = computeMomentumScoreV1(candidate({
  name: "CGO-SOL",
  fee_active_tvl_ratio: 3.5181,
  fee_pct: 5,
  active_tvl: 30_542,
  volume_window: 20_805,
  volume_active_tvl_multiple: 0.6812,
  fee_velocity_usd_per_min: 4.475,
  price_change_pct: 0,
  price_change_1h: 0,
  volume_change_pct: 0,
  organic_score: 78,
  token_age_hours: 7,
  assumed_deploy_usd: 100,
}), { profile: "patient_fee_harvest" });
assert.strictEqual(cgoLike.dynamic_entry_shadow.entry_label, "watchlist", "CGO-like high-fee low-flow candidate becomes watchlist, not full-size live");
assert.ok(cgoLike.dynamic_entry_shadow.reason_codes.includes("high_fee_low_flow_exception"), "CGO-like candidate is flagged as high-fee low-flow");
assert.ok(cgoLike.dynamic_entry_shadow.estimated_gross_fees_usd > 0, "CGO-like candidate still records expected fee telemetry");

const hot = computeMomentumScoreV1(candidate(), { profile: "hot_fee_scalp" });
assert.strictEqual(hot.momentum_profile, "hot_fee_scalp");
assert.strictEqual(hot.would_scalp, true, "hot-flow candidate can produce would_scalp shadow");
assert.strictEqual(hot.shadowOnly, true, "scalp recommendation remains shadow-only");

const missing = computeMomentumScoreV1({
  pool: "Missing111111111111111111111111111111111111",
  price_change_pct: 30,
}, { profile: "patient_fee_harvest" });
assert.ok(missing.confidence < 0.6, "missing data lowers confidence");
assert.strictEqual(missing.momentum_classification, "missing_data", "missing data cannot classify as bullish");
assert.notStrictEqual(missing.would_throttle, "none", "missing data produces a throttle shadow");

const overheated = computeMomentumScoreV1(candidate({ price_change_pct: 220, price_change_1h: 220 }), { profile: "patient_fee_harvest" });
assert.ok(overheated.risk_flags.includes("overheated_price_change"));
assert.strictEqual(overheated.momentum_classification, "overheated");
assert.strictEqual(overheated.would_throttle, "avoid_shadow");

const weak = attachMomentumScoreV1(candidate({
  name: "WEAK-SOL",
  fee_active_tvl_ratio: 0.01,
  active_tvl: 4_000,
  volume_window: 2_000,
  volume_active_tvl_multiple: 0.5,
  fee_velocity_usd_per_min: 1,
  price_change_pct: -8,
  price_change_1h: -8,
  organic_score: 30,
}));
assert.strictEqual(weak.momentum_score.primary.would_throttle, "skip_candidate_shadow");
assert.strictEqual(weak.momentum_score.primary.momentum_classification, "weak");

const enriched = attachMomentumScoreV1(candidate({
  assumed_deploy_usd: 100,
  tx_cost_usd: 0.4,
  slippage_budget_usd: 0.5,
  reposition_budget_usd: 0.2,
  tail_risk_budget_usd: 1,
}));
const context = buildCandidateDecisionContext(enriched);
assert.strictEqual(context.momentumProfile, "patient_fee_harvest");
assert.strictEqual(context.momentumWouldScalp, true);
assert.ok(context.momentumScoreV1 >= 75);
assert.ok(context.momentumScore?.shadowOnly, "decision-context carries shadow-only momentum object");
assert.strictEqual(context.dynamicEntryLabel, "live_candidate", "decision-context carries dynamic entry label");
assert.ok(context.dynamicEntryScore > 0, "decision-context carries dynamic entry score");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "momentum-score-v1-"));
try {
  const row = appendMomentumScoreV1(enriched, {
    logDir: tmp,
    ts: "2026-06-09T00:00:00.000Z",
    liveAccepted: true,
    liveVetoReason: null,
    throwOnError: true,
  });
  assert.strictEqual(row.event, "momentum_score_v1");
  assert.strictEqual(row.shadowOnly, true);
  assert.strictEqual(row.liveAccepted, true);
  assert.strictEqual(row.currentLiveDecision, "accepted_by_existing_filters");
  const logPath = getMomentumScoreLogPath("2026-06-09T00:00:00.000Z", tmp);
  const parsed = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
  assert.strictEqual(parsed.momentum.version, MOMENTUM_SCORE_VERSION);
  assert.strictEqual(parsed.momentum.primary.dynamic_entry_shadow.version, DYNAMIC_ENTRY_SHADOW_VERSION);
  assert.strictEqual(parsed.momentum.profiles.hot_fee_scalp.would_scalp, true);

  const actions = [
    {
      timestamp: "2026-06-09T00:01:00.000Z",
      tool: "deploy_position",
      success: true,
      args: { pool_address: enriched.pool, amount_y: 1 },
      result: JSON.stringify({ position: "PosMomentum111", pool: enriched.pool, pool_name: enriched.name, amount_y: 1 }),
    },
    {
      timestamp: "2026-06-09T00:31:00.000Z",
      tool: "close_position",
      success: true,
      args: { position_address: "PosMomentum111", reason: "fee_harvest" },
      result: JSON.stringify({ position: "PosMomentum111", success: true, pnl_pct: 2.5, fees_sol: 0.01, hold_minutes: 30 }),
    },
  ];
  fs.writeFileSync(path.join(tmp, "actions-2026-06-09.jsonl"), `${actions.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const report = buildMomentumScoreReport({ date: "2026-06-09", logs: tmp, source: "main" });
  assert.strictEqual(report.source, "main");
  assert.strictEqual(report.closedPositions, 1);
  assert.strictEqual(report.candidateReplayRows, 1);
  assert.strictEqual(report.candidateByDynamicEntryLabel.live_candidate.count, 1);
  assert.strictEqual(report.byScoreBucket["75_plus"].count, 1);
  assert.strictEqual(report.byDynamicEntryLabel.live_candidate.count, 1);
  assert.strictEqual(report.byWouldScalp.true.count, 1);
  assert.ok("shadowBlockedLossEstimate" in report, "report includes blocked-loss estimate");
  assert.ok("shadowBlockedWinnerCost" in report, "report includes blocked-winner cost");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const filterConfig = {
  minFeeActiveTvlRatio: 0.19,
  minBinStep: 50,
  maxBinStep: 125,
  minTvl: 10_000,
  minVolume: 15_000,
  minVolumeActiveTvlMultiple: 2.5,
  minMcap: 80_000,
  maxMcap: 3_000_000,
  minHolders: 100,
  minOrganic: 45,
  minQuoteOrganic: 45,
  twoLaneClassificationLoggingEnabled: false,
};
const previousLogDir = process.env.MERIDIAN_MOMENTUM_SCORE_LOG_DIR;
process.env.MERIDIAN_MOMENTUM_SCORE_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "momentum-filter-"));
try {
  const basePools = [
    candidate({ name: "PASS-SOL" }),
    candidate({ name: "FAIL-SOL", volume_active_tvl_multiple: 0.5, volume_window: 2_000 }),
  ];
  const beforeAccepted = basePools
    .filter((pool) => getConfiguredPoolThresholdVetoReason(pool, filterConfig) == null)
    .map((pool) => pool.name);
  const filteredOut = [];
  const stageCounts = {};
  const originalConsoleLog = console.log;
  console.log = () => {};
  let afterAccepted;
  try {
    afterAccepted = filterConfiguredPoolThresholds(basePools.map((pool) => ({ ...pool })), filterConfig, filteredOut, stageCounts, {})
      .map((pool) => pool.name);
  } finally {
    console.log = originalConsoleLog;
  }
  assert.deepStrictEqual(afterAccepted, beforeAccepted, "momentum shadow fields do not change filter acceptance");
  assert.strictEqual(stageCounts.configured_threshold_accept, 1);
  assert.strictEqual(stageCounts.configured_threshold_reject, 1);
} finally {
  fs.rmSync(process.env.MERIDIAN_MOMENTUM_SCORE_LOG_DIR, { recursive: true, force: true });
  if (previousLogDir == null) delete process.env.MERIDIAN_MOMENTUM_SCORE_LOG_DIR;
  else process.env.MERIDIAN_MOMENTUM_SCORE_LOG_DIR = previousLogDir;
}

const rankedPlain = rankCandidatesByDarwin([
  candidate({ pool: "PoolA", name: "A-SOL", fee_active_tvl_ratio: 2, volume_window: 20_000 }),
  candidate({ pool: "PoolB", name: "B-SOL", fee_active_tvl_ratio: 1, volume_window: 10_000 }),
]).map((entry) => entry.pool);
const rankedWithMomentum = rankCandidatesByDarwin([
  attachMomentumScoreV1(candidate({ pool: "PoolA", name: "A-SOL", fee_active_tvl_ratio: 2, volume_window: 20_000 })),
  attachMomentumScoreV1(candidate({ pool: "PoolB", name: "B-SOL", fee_active_tvl_ratio: 1, volume_window: 10_000, price_change_pct: 220, price_change_1h: 220 })),
]).map((entry) => entry.pool);
assert.deepStrictEqual(rankedWithMomentum, rankedPlain, "momentum shadow fields do not change Darwin ranking");

const sourceFiles = [
  ["index.js", fs.readFileSync(new URL("../index.js", import.meta.url), "utf8")],
  ["tools/dlmm.js", fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8")],
  ["tools/executor.js", fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8")],
  ["pool-memory.js", fs.readFileSync(new URL("../pool-memory.js", import.meta.url), "utf8")],
];
for (const [file, source] of sourceFiles) {
  assert.strictEqual(
    /momentum_score_v1|momentum_score|would_scalp|would_throttle|momentum_would/.test(source),
    false,
    `${file} must not consume momentum score fields in T1`,
  );
}

const screeningSource = fs.readFileSync(new URL("../tools/screening.js", import.meta.url), "utf8");
const rankStart = screeningSource.indexOf("export function rankCandidatesByDarwin");
const rankEnd = screeningSource.indexOf("\nfunction round", rankStart);
const rankBody = screeningSource.slice(rankStart, rankEnd);
assert.strictEqual(/momentum_score|would_scalp|would_throttle/.test(rankBody), false, "Darwin ranking must not consume momentum fields");

const thresholdStart = screeningSource.indexOf("export function getConfiguredPoolThresholdVetoReason");
const thresholdEnd = screeningSource.indexOf("\nfunction filterPreEntryMomentumGates", thresholdStart);
const thresholdBody = screeningSource.slice(thresholdStart, thresholdEnd);
assert.strictEqual(/momentum_score|would_scalp|would_throttle/.test(thresholdBody), false, "configured threshold vetoes must not consume momentum fields");

console.log(JSON.stringify({
  success: true,
  version: MOMENTUM_SCORE_VERSION,
  fullScore: full.momentum_score_v1,
  dynamicEntryVersion: DYNAMIC_ENTRY_SHADOW_VERSION,
  strongDynamicEntryLabel: strongProfit.dynamic_entry_shadow.entry_label,
  cgoDynamicEntryLabel: cgoLike.dynamic_entry_shadow.entry_label,
  cgoDynamicReasons: cgoLike.dynamic_entry_shadow.reason_codes,
  hotWouldScalp: hot.would_scalp,
  missingDataThrottle: missing.would_throttle,
  overheatedThrottle: overheated.would_throttle,
  weakThrottle: weak.momentum_score.primary.would_throttle,
  decisionContextFields: {
    momentumScoreV1: context.momentumScoreV1,
    momentumProfile: context.momentumProfile,
    momentumWouldScalp: context.momentumWouldScalp,
    dynamicEntryLabel: context.dynamicEntryLabel,
  },
  checks: [
    "deterministic full-data scoring",
    "hot-flow scalping shadow label",
    "missing data fails non-bullish",
    "overheated price movement is risk flagged",
    "weak fee/flow would throttle shadow",
    "decision-context carries momentum telemetry",
    "dynamic entry shadow carries expected fee telemetry",
    "CGO-like high-fee low-flow becomes watchlist",
    "append-only momentum JSONL row shape",
    "report groups candidates and closes by dynamic entry label",
    "filter acceptance parity",
    "ranking parity",
    "no deploy/close/sizing/cooldown consumers",
  ],
}, null, 2));
