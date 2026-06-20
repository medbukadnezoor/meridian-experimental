#!/usr/bin/env node
import assert from "assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "main-candidate-shadow-"));
process.env.MERIDIAN_MAIN_CANDIDATE_SHADOW_LOG_DIR = tmpDir;

const {
  classifyShadowVolumeTrend,
  buildCandidateShadowDataCollection,
  attachOutcomeToShadowDataCollection,
} = await import("../shadow-data-collection.js");
const {
  appendMainCandidateScreeningSnapshot,
  appendMainCandidateDeploySnapshot,
  appendMainCandidateOutcomeSnapshot,
} = await import("../main-candidate-shadow-log.js");

function readJsonl(fileName) {
  const filePath = path.join(tmpDir, fileName);
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function todaysFile(prefix) {
  return `${prefix}-${new Date().toISOString().slice(0, 10)}.jsonl`;
}

assert.equal(classifyShadowVolumeTrend(12), "accelerating");
assert.equal(classifyShadowVolumeTrend(-11), "decelerating");
assert.equal(classifyShadowVolumeTrend(0), "stable");
assert.equal(classifyShadowVolumeTrend(null), null);

const candidate = {
  pool: "POOL111111111111111111111111111111111111111",
  name: "TEST-SOL",
  base: { mint: "BASE111111111111111111111111111111111111111", organic: 72 },
  quote: { mint: "So11111111111111111111111111111111111111112", organic: 91 },
  volume_change_pct: 18,
  fee_active_tvl_ratio: 0.73,
  holders: 901,
  top10_pct: 42,
  bot_holders_pct: 3,
  mcap: 240000,
  volatility: 3.4,
  bin_step: 80,
  active_tvl: 6200,
  volume_window: 4400,
  total_lps: 26,
  open_positions: 31,
  jupshield_safeguard: true,
  high_supply_concentration: false,
  price_change_5m: 44,
  price_change_pct: 132,
  price_change_6h: 188,
  price_change_24h: 301,
  previous_same_pool_or_base_close_ts: "2026-06-18T01:00:00.000Z",
  minutes_since_close: 240,
  previous_pnl_pct: -6.4,
};

const snapshot = buildCandidateShadowDataCollection(candidate, {
  timeframe: "30m",
  stage: "pre_entry_candidate_snapshot",
});
assert.equal(snapshot.shadow_only, true);
assert.equal(snapshot.volume_trend, "accelerating");
assert.equal(snapshot.timeframe, "30m");
assert.equal(snapshot.fee_active_tvl_ratio, 0.73);
assert.equal(snapshot.total_lps, 26);
assert.equal(snapshot.jupshield_safeguard, true);
assert.equal(snapshot.high_supply_concentration, false);
assert.equal(snapshot.price_change_5m_pct, 44);
assert.equal(snapshot.price_change_1h_pct, 132);
assert.equal(snapshot.price_change_6h_pct, 188);
assert.equal(snapshot.price_change_24h_pct, 301);
assert.equal(snapshot.price_change_primary_pct, 132);
assert.equal(snapshot.price_change_primary_timeframe, "1h");
assert.equal(snapshot.price_change_source, "price_change_pct");
assert.deepEqual(snapshot.momentum_screening_shadow, {
  rule_version: "price_change_momentum_shadow_v1",
  timeframe: "1h",
  threshold_pct: 100,
  decision: "would_pass",
  reason: "1h price_change 132 > 100",
});
assert.deepEqual(snapshot.reentry_momentum_shadow, {
  rule_version: "dynamic_reentry_momentum_shadow_v1",
  context_scope: "same_pool_or_base_mint",
  previous_close_ts: "2026-06-18T01:00:00.000Z",
  minutes_since_close: 240,
  previous_pnl_pct: -6.4,
  price_change_1h_pct: 132,
  decision: "would_allow",
  reason: "1h price_change 132 > 100",
  threshold_pct: 100,
});

const missingMomentumSnapshot = buildCandidateShadowDataCollection({
  pool: "POOL333",
  same_pool_or_base_reentry_context: true,
  minutes_since_close: 90,
}, { timeframe: "30m" });
assert.equal(missingMomentumSnapshot.price_change_primary_pct, null);
assert.equal(missingMomentumSnapshot.momentum_screening_shadow.decision, "missing_data");
assert.equal(missingMomentumSnapshot.reentry_momentum_shadow.decision, "missing_data");
assert.equal(missingMomentumSnapshot.reentry_momentum_shadow.threshold_pct, 100);

const blockedMomentumSnapshot = buildCandidateShadowDataCollection({
  pool: "POOL444",
  price_change_1h: 20,
  reentry_context_scope: "same_pool",
  minutes_since_close: 40,
});
assert.equal(blockedMomentumSnapshot.momentum_screening_shadow.decision, "would_block");
assert.equal(blockedMomentumSnapshot.reentry_momentum_shadow.decision, "would_block");
assert.equal(blockedMomentumSnapshot.reentry_momentum_shadow.threshold_pct, null);

const genericPriorCloseSnapshot = buildCandidateShadowDataCollection({
  pool: "POOL445",
  price_change_1h: 140,
  previous_close_ts: "2026-06-18T03:00:00.000Z",
  minutes_since_close: 120,
  previous_pnl_pct: -5,
});
assert.equal(genericPriorCloseSnapshot.reentry_momentum_shadow, null);

const boundary60mSnapshot = buildCandidateShadowDataCollection({
  pool: "POOL446",
  price_change_1h: 101,
  previous_close_ts: "2026-06-18T03:00:00.000Z",
  minutes_since_close: 60,
  same_pool_or_base_reentry_context: true,
});
assert.equal(boundary60mSnapshot.reentry_momentum_shadow.context_scope, "same_pool_or_base_mint");
assert.equal(boundary60mSnapshot.reentry_momentum_shadow.previous_close_ts, "2026-06-18T03:00:00.000Z");
assert.equal(boundary60mSnapshot.reentry_momentum_shadow.threshold_pct, 100);
assert.equal(boundary60mSnapshot.reentry_momentum_shadow.decision, "would_allow");

const boundary360mSnapshot = buildCandidateShadowDataCollection({
  pool: "POOL447",
  price_change_1h: 51,
  minutes_since_close: 360,
  reentry_context_scope: "same_base_mint",
});
assert.equal(boundary360mSnapshot.reentry_momentum_shadow.context_scope, "same_base_mint");
assert.equal(boundary360mSnapshot.reentry_momentum_shadow.threshold_pct, 50);
assert.equal(boundary360mSnapshot.reentry_momentum_shadow.decision, "would_allow");

const boundary720mSnapshot = buildCandidateShadowDataCollection({
  pool: "POOL448",
  price_change_1h: 21,
  minutes_since_close: 720,
  reentry_context_scope: "same_pool_or_base_mint",
});
assert.equal(boundary720mSnapshot.reentry_momentum_shadow.context_scope, "same_pool_or_base_mint");
assert.equal(boundary720mSnapshot.reentry_momentum_shadow.threshold_pct, 20);
assert.equal(boundary720mSnapshot.reentry_momentum_shadow.decision, "would_allow");

const twelveHourPassSnapshot = buildCandidateShadowDataCollection({
  pool: "POOL449",
  price_change_1h: 21,
  minutes_since_close: 900,
  previous_same_pool_or_base_close_ts: "2026-06-17T12:00:00.000Z",
});
assert.equal(twelveHourPassSnapshot.reentry_momentum_shadow.threshold_pct, 20);
assert.equal(twelveHourPassSnapshot.reentry_momentum_shadow.decision, "would_allow");

const twelveHourFailSnapshot = buildCandidateShadowDataCollection({
  pool: "POOL450",
  price_change_1h: 20,
  minutes_since_close: 900,
  previous_same_pool_or_base_close_ts: "2026-06-17T12:00:00.000Z",
});
assert.equal(twelveHourFailSnapshot.reentry_momentum_shadow.threshold_pct, 20);
assert.equal(twelveHourFailSnapshot.reentry_momentum_shadow.decision, "would_block");

const outcome = attachOutcomeToShadowDataCollection(snapshot, {
  close_reason: "Stop loss confirmed",
  close_reason_bucket: "stop_loss",
  pnl_pct: -9.1,
  pnl_usd: -4.2,
  minutes_held: 38,
  material_outcome: "loss",
  material_loss: true,
});
assert.equal(outcome.stage, "closed_position_outcome");
assert.equal(outcome.catastrophic_loss, true);
assert.equal(outcome.close_reason_bucket, "stop_loss");
assert.equal(outcome.reentry_momentum_shadow.decision, "would_allow");

const outcomeOnlyReentry = attachOutcomeToShadowDataCollection(
  buildCandidateShadowDataCollection({ pool: "POOL555", price_change_1h: 55 }),
  {
    previous_close_ts: "2026-06-18T02:00:00.000Z",
    minutes_since_close: 500,
    reentry_context_scope: "same_pool",
  },
);
assert.equal(outcomeOnlyReentry.reentry_momentum_shadow.decision, "would_allow");
assert.equal(outcomeOnlyReentry.reentry_momentum_shadow.context_scope, "same_pool");
assert.equal(outcomeOnlyReentry.reentry_momentum_shadow.previous_close_ts, "2026-06-18T02:00:00.000Z");
assert.equal(outcomeOnlyReentry.reentry_momentum_shadow.threshold_pct, 50);

appendMainCandidateScreeningSnapshot({
  candidates: [candidate],
  filteredOut: [{ name: "FILTERED-SOL", pool: "POOL222", reason: "test reject", stage: "test" }],
  stageCounts: { ranked: 1 },
  source: "verify",
  timeframe: "30m",
});
appendMainCandidateDeploySnapshot({
  candidate: { shadow_data_collection: snapshot },
  result: { position: "POS111", pool: candidate.pool, pool_name: candidate.name },
  deploy: { relay: false, amount_y: 0.5, strategy: "bid_ask" },
  source: "verify",
});
appendMainCandidateOutcomeSnapshot({
  tracked: {
    position: "POS111",
    pool: candidate.pool,
    pool_name: candidate.name,
    shadow_data_collection: snapshot,
  },
  outcome: {
    close_reason: "Stop loss confirmed",
    close_reason_bucket: "stop_loss",
    pnl_pct: -9.1,
    pnl_usd: -4.2,
    minutes_held: 38,
  },
  source: "verify",
});

for (const prefix of [
  "main-candidate-screening-shadow",
  "main-candidate-deploy-shadow",
  "main-candidate-outcome-shadow",
]) {
  const rows = readJsonl(todaysFile(prefix));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].shadow_only, true);
  assert.equal(rows[0].applied_to_filtering, false);
  assert.equal(rows[0].applied_to_sizing, false);
  assert.equal(rows[0].applied_to_deploy_args, false);
  assert.equal(rows[0].applied_to_close, false);
}

const deployRows = readJsonl(todaysFile("main-candidate-deploy-shadow"));
assert.equal(deployRows[0].shadow_data_collection.volume_trend, "accelerating");
assert.equal(deployRows[0].shadow_data_collection.price_change_primary_pct, 132);
assert.equal(deployRows[0].shadow_data_collection.momentum_screening_shadow.decision, "would_pass");
assert.equal(deployRows[0].shadow_data_collection.reentry_momentum_shadow.decision, "would_allow");
assert.equal(deployRows[0].deploy.strategy, "bid_ask");

const outcomeRows = readJsonl(todaysFile("main-candidate-outcome-shadow"));
assert.equal(outcomeRows[0].shadow_data_collection.catastrophic_loss, true);
assert.equal(outcomeRows[0].shadow_data_collection.pnl_pct, -9.1);
assert.equal(outcomeRows[0].shadow_data_collection.price_change_1h_pct, 132);
assert.equal(outcomeRows[0].shadow_data_collection.reentry_momentum_shadow.decision, "would_allow");

const signalWeightsSrc = fs.readFileSync(path.join(ROOT, "signal-weights.js"), "utf8");
const lessonsSrc = fs.readFileSync(path.join(ROOT, "lessons.js"), "utf8");
const screeningSrc = fs.readFileSync(path.join(ROOT, "tools", "screening.js"), "utf8");
const dlmmSrc = fs.readFileSync(path.join(ROOT, "tools", "dlmm.js"), "utf8");

const signalNamesBlock = signalWeightsSrc.match(/const SIGNAL_NAMES = \[[\s\S]*?\];/)?.[0] ?? "";
const performanceFieldsBlock = lessonsSrc.match(/const PERFORMANCE_SIGNAL_FIELDS = \[[\s\S]*?\];/)?.[0] ?? "";
for (const forbidden of [
  "shadow_data_collection",
  "total_lps",
  "open_positions",
  "jupshield_safeguard",
  "high_supply_concentration",
  "price_change_5m_pct",
  "price_change_1h_pct",
  "price_change_6h_pct",
  "price_change_24h_pct",
  "price_change_primary_pct",
  "momentum_screening_shadow",
  "reentry_momentum_shadow",
]) {
  assert.equal(signalNamesBlock.includes(forbidden), false, `${forbidden} must not become a Darwin signal`);
  assert.equal(performanceFieldsBlock.includes(forbidden), false, `${forbidden} must not become an evolved performance signal`);
}

assert.equal(/jupshield_safeguard|minJupShield|high_supply_concentration.*return `configured threshold veto/.test(screeningSrc), false);
assert.equal(/shadow_data_collection[^\n]*(bins_below|amount_sol|amount_y|strategyType|minBinId|maxBinId)/.test(dlmmSrc), false);
for (const source of [screeningSrc, dlmmSrc, fs.readFileSync(path.join(ROOT, "index.js"), "utf8")]) {
  assert.equal(/momentum_screening_shadow|reentry_momentum_shadow|price_change_primary_pct/.test(source), false);
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(JSON.stringify({
  ok: true,
  verifier: "verify-main-candidate-shadow-collection",
  rows_verified: {
    screening: 1,
    deploy: 1,
    outcome: 1,
  },
  behavior_boundary: "shadow-only; no signal weights, live vetoes, sizing, range, or close use",
}, null, 2));
