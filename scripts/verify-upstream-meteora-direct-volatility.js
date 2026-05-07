#!/usr/bin/env node
/**
 * Source proof for UPSTREAM-METEORA-DIRECT-VOLATILITY-T1.
 *
 * This verifier is intentionally read-only and network-free. It proves the
 * adopted upstream hardening is present without starting a bot or touching VPS.
 */

import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function src(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${startMarker} missing`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `${endMarker} missing after ${startMarker}`);
  return source.slice(start, end);
}

const screeningSource = src("tools/screening.js");
const gmgnSource = src("tools/gmgn.js");
const executorSource = src("tools/executor.js");
const dlmmSource = src("tools/dlmm.js");
const deployRangeGuardSource = src("tools/deploy-range-guard.js");

assert.ok(screeningSource.includes('const MIN_VOLATILITY_TIMEFRAME = "30m"'), "screening has 30m minimum volatility timeframe");
assert.ok(screeningSource.includes("export function getVolatilityTimeframe"), "screening exports getVolatilityTimeframe");
assert.ok(screeningSource.includes("async function fetchPoolDiscoveryPage"), "direct Meteora page fetch helper exists");
assert.ok(screeningSource.includes("async function fetchPoolDiscoveryDetail"), "direct Meteora detail fetch helper exists");
assert.ok(screeningSource.includes("async function applyVolatilityTimeframe"), "Meteora discovery applies effective volatility timeframe");
assert.ok(screeningSource.includes("pool.volatility = volatilityByPool.has(pool.pool_address)"), "missing effective-timeframe volatility fails closed");
assert.ok(screeningSource.includes("volatility_timeframe:"), "condensed candidates expose volatility_timeframe");
assert.ok(screeningSource.includes("configured threshold veto: volatility_"), "screening threshold veto labels volatility timeframe");
assert.ok(screeningSource.includes("must be > 0"), "zero or invalid volatility is rejected at screening");

assert.ok(!screeningSource.includes("const useServerDiscovery = !!config.api.publicApiKey"), "Meteora discovery/detail no longer switches to Agent Meridian when publicApiKey exists");
assert.ok(!screeningSource.includes("${config.api.url}/discovery/pools"), "Meteora discovery/detail no longer calls Agent Meridian discovery endpoint");
assert.ok(!screeningSource.includes("base_token_launchpad=[${s.allowedLaunchpads.join(\",\")}]"), "direct Meteora discovery does not pass launchpad allow-list as a hard filter");

const discoverPoolsBlock = between(screeningSource, "export async function discoverPools", "async function discoverMeteoraCandidateUniverse");
assert.ok(discoverPoolsBlock.includes("fetchPoolDiscoveryPage"), "discoverPools uses direct Pool Discovery page fetch");
assert.ok(discoverPoolsBlock.includes("applyVolatilityTimeframe(rawPools, s.timeframe)"), "discoverPools refreshes volatility at effective timeframe");
assert.ok(!discoverPoolsBlock.includes("config.api.url"), "discoverPools does not call Agent Meridian");
assert.ok(!discoverPoolsBlock.includes("x-api-key"), "discoverPools does not send Agent Meridian API key");

const poolDetailBlock = between(screeningSource, "export async function getPoolDetail", "function condensePool");
assert.ok(poolDetailBlock.includes("fetchPoolDiscoveryDetail"), "getPoolDetail uses direct Pool Discovery detail fetch");
assert.ok(!poolDetailBlock.includes("config.api.url"), "getPoolDetail does not call Agent Meridian");
assert.ok(!poolDetailBlock.includes("x-api-key"), "getPoolDetail does not send Agent Meridian API key");

const discordSignalBlock = between(screeningSource, "async function fetchDiscordSignalCandidates", "export function getConfiguredPoolThresholdVetoReason");
assert.ok(discordSignalBlock.includes("config.api.url"), "Discord signals still use Agent Meridian endpoint");
assert.ok(discordSignalBlock.includes("x-api-key"), "Discord signal endpoint still uses public API key when configured");

assert.ok(gmgnSource.includes('const MIN_VOLATILITY_TIMEFRAME = "30m"'), "GMGN detail path has 30m minimum volatility timeframe");
assert.ok(gmgnSource.includes("function getVolatilityTimeframe"), "GMGN has local volatility timeframe resolver");
assert.ok(gmgnSource.includes("async function fetchPoolDetailDirect(poolAddress)"), "GMGN Meteora detail fetch is direct");
assert.ok(gmgnSource.includes("getVolatilityTimeframe(config.screening?.timeframe || \"5m\")"), "GMGN uses effective volatility timeframe for Meteora detail");
assert.ok(gmgnSource.includes("volatility_timeframe: getVolatilityTimeframe"), "GMGN candidates expose volatility_timeframe");

assert.ok(executorSource.includes("getPoolDetail, getTopCandidates, getVolatilityTimeframe"), "executor imports direct detail and volatility timeframe helpers");
assert.ok(executorSource.includes("async function validateDeployPoolThresholds"), "executor has fresh deploy-time Pool Discovery validation");
assert.ok(executorSource.includes("poolDetailTvl"), "executor validates deploy TVL from fresh detail");
assert.ok(executorSource.includes("poolDetailFeeActiveTvlRatio"), "executor validates deploy fee/active-TVL from fresh detail");
assert.ok(executorSource.includes("poolDetailBinStep"), "executor validates deploy bin step from fresh detail");
assert.ok(executorSource.includes("Pool ${volatilityTimeframe} volatility"), "executor validates deploy volatility from effective timeframe");
assert.ok(executorSource.includes("const poolThresholds = await validateDeployPoolThresholds(args);"), "deploy_position safety path calls fresh threshold validation");

assert.ok(dlmmSource.includes("dlmm.deploy.invalid_volatility"), "DLMM deploy rejects explicitly invalid volatility metadata");
assert.ok(dlmmSource.includes("Number(volatility) <= 0"), "DLMM deploy blocks zero or negative volatility metadata");

assert.ok(deployRangeGuardSource.includes("ABSOLUTE_MIN_SINGLE_SIDED_SOL_BINS = 5"), "single-sided range guard keeps configurable floor with absolute minimum 5");
for (const source of [screeningSource, gmgnSource, executorSource, dlmmSource]) {
  assert.ok(!source.includes("MIN_SAFE_BINS_BELOW"), "patch did not introduce a hardcoded 35-bin safe floor");
}

console.log(JSON.stringify({
  success: true,
  meteora_direct_pool_discovery: true,
  agent_meridian_discord_only: true,
  volatility_min_timeframe: "30m",
  deploy_threshold_recheck: true,
  hardcoded_35_bin_floor_introduced: false,
}, null, 2));
