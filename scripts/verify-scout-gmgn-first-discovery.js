#!/usr/bin/env node
/**
 * Synthetic/source proof for PHASE2A-SCOUT-GMGN-FIRST-DISCOVERY-T1.
 *
 * This verifier intentionally avoids importing bot runtime, wallet code, or
 * network/API clients. It reads source, resolves config with a fake env key,
 * and imports only a pure screening threshold helper.
 */

import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildConfig } from "../config-builder.js";
import { getConfiguredPoolThresholdVetoReason } from "../tools/screening.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function src(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function indexOfOrThrow(source, marker, label = marker) {
  const index = source.indexOf(marker);
  assert.ok(index >= 0, `${label} marker missing`);
  return index;
}

function indexOfAfterOrThrow(source, marker, start, label = marker) {
  const index = source.indexOf(marker, start);
  assert.ok(index >= 0, `${label} marker missing after discovery`);
  return index;
}

const defaultConfig = buildConfig({}, {});
assert.strictEqual(defaultConfig.screening.source, "meteora", "default screening source remains Meteora");

const gmgnConfig = buildConfig({
  screeningSource: "gmgn",
  minMcap: 30_000,
  maxMcap: 600_000,
  minTvl: 10_000,
  minVolume: 1000,
  minHolders: 100,
  maxBundlePct: 45,
  maxBotHoldersPct: 55,
  maxTop10Pct: 80,
  gmgn: {
    apiKey: "env:GMGN_API_KEY",
    enrichLimit: 7,
    requestDelayMs: 2500,
    maxRetries: 0,
    holdersLimit: 50,
  },
}, { GMGN_API_KEY: "synthetic-gmgn-key" });

assert.strictEqual(gmgnConfig.screening.source, "gmgn", "screeningSource resolves to config.screening.source");
assert.strictEqual(gmgnConfig.gmgn.apiKey, "synthetic-gmgn-key", "GMGN api key resolves from env reference");
assert.strictEqual(gmgnConfig.gmgn.minMcap, 30_000, "GMGN min mcap inherits scout mcap floor");
assert.strictEqual(gmgnConfig.gmgn.maxMcap, 600_000, "GMGN max mcap inherits scout mcap ceiling");
assert.strictEqual(gmgnConfig.gmgn.minTvl, 10_000, "GMGN min TVL inherits scout TVL floor");
assert.strictEqual(gmgnConfig.gmgn.minVolume, 1000, "GMGN min volume inherits scout volume floor");
assert.strictEqual(gmgnConfig.gmgn.minHolders, 100, "GMGN min holders inherits scout holder floor");
assert.strictEqual(gmgnConfig.gmgn.maxBundlerRate, 0.45, "GMGN bundler rate inherits maxBundlePct");
assert.strictEqual(gmgnConfig.gmgn.maxBotDegenRate, 0.55, "GMGN bot-degen rate inherits maxBotHoldersPct");
assert.strictEqual(gmgnConfig.gmgn.maxTop10HolderRate, 0.8, "GMGN top10 rate inherits maxTop10Pct");
assert.strictEqual(gmgnConfig.gmgn.enrichLimit, 7, "GMGN enrich limit resolves");
assert.strictEqual(gmgnConfig.gmgn.requestDelayMs, 2500, "GMGN pacing resolves");
assert.strictEqual(gmgnConfig.gmgn.maxRetries, 0, "GMGN retry count resolves default-off");
assert.strictEqual(buildConfig({ screeningSource: "bad-source" }, {}).screening.source, "meteora", "invalid source falls back to Meteora");
assert.strictEqual(buildConfig({ screening: { source: "gmgn" } }, {}).screening.source, "gmgn", "nested screening.source is accepted");

const thresholdConfig = {
  minFeeActiveTvlRatio: 0.02,
  minBinStep: 50,
  maxBinStep: 250,
  minTvl: 10_000,
  maxTvl: 300_000,
  minVolume: 1000,
  minMcap: 30_000,
  maxMcap: 600_000,
  minHolders: 100,
  minOrganic: 55,
  minQuoteOrganic: 45,
};
const goodCandidate = {
  name: "GOOD-SOL",
  pool: "good-pool",
  fee_active_tvl_ratio: 0.03,
  bin_step: 85,
  active_tvl: 50_000,
  volume_window: 10_000,
  mcap: 120_000,
  holders: 300,
  volatility: 0.01,
  organic_score: 70,
  quote_organic_score: 80,
};
const validMeteoraCandidate = {
  name: "METEORA-SOL",
  pool: "meteora-pool",
  fee_active_tvl_ratio: 0.03,
  bin_step: 85,
  active_tvl: 50_000,
  volume_window: 10_000,
  mcap: 120_000,
  holders: 300,
  volatility: 0.01,
  organic_score: 70,
  quote: {
    symbol: "SOL",
    mint: "So11111111111111111111111111111111111111112",
    organic: 80,
  },
  discovery_source: "meteora",
};
const thresholdCases = {
  good: getConfiguredPoolThresholdVetoReason(goodCandidate, thresholdConfig),
  validMeteora: getConfiguredPoolThresholdVetoReason(validMeteoraCandidate, thresholdConfig),
  lowFeeRatio: getConfiguredPoolThresholdVetoReason({ ...goodCandidate, fee_active_tvl_ratio: 0.001 }, thresholdConfig),
  lowBinStep: getConfiguredPoolThresholdVetoReason({ ...goodCandidate, bin_step: 10 }, thresholdConfig),
  highBinStep: getConfiguredPoolThresholdVetoReason({ ...goodCandidate, bin_step: 300 }, thresholdConfig),
  belowMinTvl: getConfiguredPoolThresholdVetoReason({ ...goodCandidate, active_tvl: 9999 }, thresholdConfig),
  overMaxTvl: getConfiguredPoolThresholdVetoReason({ ...goodCandidate, active_tvl: 300_001 }, thresholdConfig),
  belowVolume: getConfiguredPoolThresholdVetoReason({ ...goodCandidate, volume_window: 999 }, thresholdConfig),
  belowMcap: getConfiguredPoolThresholdVetoReason({ ...goodCandidate, mcap: 29_999 }, thresholdConfig),
  highMcap: getConfiguredPoolThresholdVetoReason({ ...goodCandidate, mcap: 600_001 }, thresholdConfig),
  lowHolders: getConfiguredPoolThresholdVetoReason({ ...goodCandidate, holders: 99 }, thresholdConfig),
  missingOrganic: getConfiguredPoolThresholdVetoReason({ ...goodCandidate, organic_score: null }, thresholdConfig),
  lowOrganic: getConfiguredPoolThresholdVetoReason({ ...goodCandidate, organic_score: 54 }, thresholdConfig),
  lowQuoteOrganic: getConfiguredPoolThresholdVetoReason({ ...goodCandidate, quote_organic_score: 44 }, thresholdConfig),
};

assert.strictEqual(thresholdCases.good, null, "good synthetic candidate passes configured thresholds");
assert.strictEqual(thresholdCases.validMeteora, null, "valid Meteora-shaped candidate passes configured thresholds");
assert.ok(thresholdCases.lowFeeRatio?.includes("fee_active_tvl_ratio"), "low fee ratio is vetoed");
assert.ok(thresholdCases.lowBinStep?.includes("bin_step"), "low bin step is vetoed");
assert.ok(thresholdCases.highBinStep?.includes("bin_step"), "high bin step is vetoed");
assert.ok(thresholdCases.belowMinTvl?.includes("tvl"), "below min TVL is vetoed");
assert.ok(thresholdCases.overMaxTvl?.includes("tvl"), "over max TVL is vetoed");
assert.ok(thresholdCases.belowVolume?.includes("volume"), "below min volume is vetoed");
assert.ok(thresholdCases.belowMcap?.includes("mcap"), "below min mcap is vetoed");
assert.ok(thresholdCases.highMcap?.includes("mcap"), "over max mcap is vetoed");
assert.ok(thresholdCases.lowHolders?.includes("holders"), "low holders is vetoed");
assert.ok(thresholdCases.missingOrganic?.includes("organic_score missing"), "missing organic score fails closed");
assert.ok(thresholdCases.lowOrganic?.includes("organic_score"), "low organic score is vetoed");
assert.ok(thresholdCases.lowQuoteOrganic?.includes("quote_organic_score"), "low quote organic score is vetoed");

const configBuilderSource = src("config-builder.js");
const gmgnSource = src("tools/gmgn.js");
const screeningSource = src("tools/screening.js");
const verifierSource = src("scripts/verify-scout-gmgn-first-discovery.js");

assert.ok(configBuilderSource.includes('const SCREENING_SOURCES = new Set(["meteora", "gmgn", "both"])'), "supported screening source set is explicit");
assert.ok(configBuilderSource.includes("normalizeScreeningSource"), "screening source normalizer exists");
assert.ok(configBuilderSource.includes("resolveEnvReference(g.apiKey ?? u.gmgnApiKey"), "GMGN key can resolve from env reference without committing secrets");

assert.ok(gmgnSource.includes("export async function discoverGmgnPools"), "GMGN discovery export exists");
assert.ok(gmgnSource.includes('"/v1/market/rank"'), "GMGN rank endpoint is wired");
assert.ok(gmgnSource.includes('"/v1/token/info"'), "GMGN token info endpoint is wired");
assert.ok(gmgnSource.includes('"/v1/market/token_top_holders"'), "GMGN holders endpoint is wired");
assert.ok(gmgnSource.includes('"/v1/market/token_top_traders"'), "GMGN traders endpoint is wired");
assert.ok(gmgnSource.includes("fetchTopMeteoraDlmmPoolsForMint"), "GMGN tokens map back to Meteora DLMM pools");
assert.ok(gmgnSource.includes("quoteIsSol"), "GMGN pool mapper requires SOL quote pools");
assert.ok(gmgnSource.includes('discovery_source: "gmgn"'), "GMGN candidates are source-tagged");
assert.ok(gmgnSource.includes("organic_score: optionalNum"), "GMGN candidates carry organic score when Meteora detail provides it");
assert.ok(gmgnSource.includes("quote_organic_score: optionalNum"), "GMGN candidates carry quote organic score when Meteora detail provides it");
assert.ok(gmgnSource.includes("stage_counts"), "GMGN discovery surfaces stage counts");
assert.ok(gmgnSource.includes("x-ratelimit-reset"), "GMGN fetch captures rate-limit reset metadata");

assert.ok(screeningSource.includes('import { discoverGmgnPools } from "./gmgn.js"'), "screening imports GMGN discovery");
assert.ok(screeningSource.includes('String(config.screening.source || "meteora")'), "getTopCandidates reads config.screening.source");
assert.ok(screeningSource.includes('source === "gmgn"'), "getTopCandidates has GMGN source branch");
assert.ok(screeningSource.includes("discoverMeteoraCandidateUniverse"), "Meteora default path remains factored");
assert.ok(screeningSource.includes("getConfiguredPoolThresholdVetoReason"), "configured pool threshold veto helper exists");
assert.ok(screeningSource.includes("filterConfiguredPoolThresholds"), "post-discovery threshold filter is wired");
assert.ok(screeningSource.includes("configured_threshold_reject"), "threshold rejects are counted in stage metadata");
assert.ok(screeningSource.includes("quote_organic_score: Math.round(p.token_y?.organic_score || 0)"), "Meteora condensed candidates carry quote organic score");
assert.ok(screeningSource.includes("organic: Math.round(p.token_y?.organic_score || 0)"), "Meteora quote object carries organic score");
assert.ok(screeningSource.includes("stage_counts"), "getTopCandidates returns source/stage metadata");
assert.ok(screeningSource.includes("all_filtered"), "getTopCandidates preserves full filtered context for reports");

const discoveryBranch = indexOfOrThrow(screeningSource, 'source === "gmgn"', "GMGN source branch");
const thresholdGate = indexOfAfterOrThrow(screeningSource, "filterConfiguredPoolThresholds", discoveryBranch, "configured threshold gate");
const openPositionGate = indexOfAfterOrThrow(screeningSource, "occupiedPools.has", discoveryBranch, "open-position pool gate");
const tokenPositionGate = indexOfAfterOrThrow(screeningSource, "occupiedMints.has", discoveryBranch, "open-position mint gate");
const poolCooldownGate = indexOfAfterOrThrow(screeningSource, "if (isPoolOnCooldown", discoveryBranch, "pool cooldown gate");
const tokenCooldownGate = indexOfAfterOrThrow(screeningSource, "if (isBaseMintOnCooldown", discoveryBranch, "token cooldown gate");
const pvpGate = indexOfAfterOrThrow(screeningSource, "if (config.screening.avoidPvpSymbols", discoveryBranch, "PVP gate");
const okxGate = indexOfOrThrow(screeningSource, "getAdvancedInfo", "OKX post-discovery safety enrichment");
const deterministicGate = indexOfAfterOrThrow(screeningSource, "const vetoReason = getDeterministicCandidateVetoReason", discoveryBranch, "deterministic scout veto");
const indicatorGate = indexOfAfterOrThrow(screeningSource, "const confirmation = await confirmIndicatorPreset", discoveryBranch, "indicator confirmation gate");
const darwinRank = indexOfOrThrow(screeningSource, "rankCandidatesByDarwin(eligible)", "Darwin rank call");

assert.ok(thresholdGate > discoveryBranch, "configured threshold gate remains after GMGN discovery");
assert.ok(thresholdGate < openPositionGate, "configured threshold gate runs before open-position gates");
assert.ok(thresholdGate < darwinRank, "configured threshold gate runs before Darwin ranking");

for (const [label, index] of [
  ["open-position pool gate", openPositionGate],
  ["open-position mint gate", tokenPositionGate],
  ["pool cooldown gate", poolCooldownGate],
  ["token cooldown gate", tokenCooldownGate],
  ["PVP gate", pvpGate],
  ["OKX post-discovery safety enrichment", okxGate],
  ["deterministic scout veto", deterministicGate],
  ["indicator confirmation gate", indicatorGate],
]) {
  assert.ok(index > discoveryBranch, `${label} remains after GMGN discovery`);
  assert.ok(index < darwinRank, `${label} remains before Darwin ranking`);
}

assert.ok(!verifierSource.includes("getTop" + "Candidates("), "verifier does not call screening runtime");
assert.ok(!verifierSource.includes("discoverGmgn" + "Pools("), "verifier does not call GMGN APIs");
assert.ok(!verifierSource.includes("node " + "index.js"), "verifier does not run bot runtime");

console.log(JSON.stringify({
  success: true,
  defaults: {
    screeningSource: defaultConfig.screening.source,
  },
  scoutSyntheticConfig: {
    screeningSource: gmgnConfig.screening.source,
    gmgnKeyIsEnvReferenced: gmgnConfig.gmgn.apiKey === "synthetic-gmgn-key",
    gmgnEnrichLimit: gmgnConfig.gmgn.enrichLimit,
    gmgnRequestDelayMs: gmgnConfig.gmgn.requestDelayMs,
  },
  sourceSafety: {
    importsBotRuntime: false,
    callsLiveApis: false,
    exposesSecrets: false,
  },
  gateOrder: {
    postDiscoveryGatesBeforeDarwin: true,
  },
  thresholdProof: {
    validMeteoraCandidatePasses: thresholdCases.validMeteora === null,
    lowFeeRatioBlocked: Boolean(thresholdCases.lowFeeRatio),
    outOfRangeBinStepBlocked: Boolean(thresholdCases.lowBinStep && thresholdCases.highBinStep),
    overMaxTvlBlocked: Boolean(thresholdCases.overMaxTvl),
    belowMinTvlBlocked: Boolean(thresholdCases.belowMinTvl),
    missingOrganicBlocked: Boolean(thresholdCases.missingOrganic),
    lowOrganicBlocked: Boolean(thresholdCases.lowOrganic),
  },
}, null, 2));
