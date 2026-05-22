#!/usr/bin/env node
/**
 * Synthetic/source proof for PHASE2A-SCOUT-DUAL-SOURCE-DISCOVERY-T1.
 *
 * Does not call GMGN, Meteora, wallet, relay, LLM, or trading APIs.
 */

import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildConfig } from "../config-builder.js";
import { resolveDualSourceDiscovery, resolveMultiSourceDiscovery } from "../tools/screening.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SOL = "So11111111111111111111111111111111111111112";

function src(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function candidate({
  pool,
  mint,
  source,
  fee = 0.2,
  tvl = 50_000,
  volume = 20_000,
  volatility = 0.05,
  binStep = 35,
  organic = 70,
  quoteOrganic = 80,
  scoreName = null,
} = {}) {
  return {
    pool,
    name: scoreName || `${source}-${pool}`,
    base: { symbol: "TEST", mint, organic, warnings: 0 },
    quote: { symbol: "SOL", mint: SOL, organic: quoteOrganic },
    pool_type: "dlmm",
    active_tvl: tvl,
    volume_window: volume,
    fee_active_tvl_ratio: fee,
    bin_step: binStep,
    volatility,
    volatility_timeframe: "30m",
    holders: 200,
    mcap: 150_000,
    organic_score: organic,
    quote_organic_score: quoteOrganic,
    source,
    discovery_source: source,
    gmgn_score: source === "gmgn" ? 123 : null,
    gmgn_kol_wallets: source === "gmgn" ? 2 : null,
  };
}

const runtimeConfig = { tokens: { SOL } };
const samePoolGmgn = candidate({
  pool: "pool-overlap",
  mint: "mint-overlap",
  source: "gmgn",
  fee: 9.9,
  tvl: 999_999,
  volume: 999_999,
  volatility: 9.9,
});
const samePoolMeteora = candidate({
  pool: "pool-overlap",
  mint: "mint-overlap",
  source: "meteora",
  fee: 0.33,
  tvl: 33_000,
  volume: 44_000,
  volatility: 0.11,
});
const gmgnOnlyValidated = candidate({
  pool: "pool-gmgn-valid",
  mint: "mint-gmgn-valid",
  source: "gmgn",
  fee: 0.21,
});
const gmgnOnlyValidation = candidate({
  pool: "pool-gmgn-valid",
  mint: "mint-gmgn-valid",
  source: "meteora",
  fee: 0.22,
  tvl: 22_000,
});
const gmgnOnlyInvalid = {
  ...candidate({
    pool: "pool-gmgn-invalid",
    mint: "mint-gmgn-invalid",
    source: "gmgn",
  }),
  volatility: null,
};
const meteoraOnly = candidate({
  pool: "pool-meteora-only",
  mint: "mint-meteora-only",
  source: "meteora",
  fee: 0.19,
});
const okxOnly = {
  ...candidate({
    pool: "pool-okx-only",
    mint: "mint-okx-only",
    source: "okx_discovery",
    fee: 0.24,
  }),
  okxScore: 88,
  okxScans: 3,
  okxHolderGrowthPct: 4.2,
  okxBuySellRatio: 1.4,
};
const sameMintLowerScore = candidate({
  pool: "pool-same-mint-low",
  mint: "mint-meteora-only",
  source: "meteora",
  fee: 0.01,
  tvl: 10_000,
  volume: 1_000,
});

const resolved = resolveDualSourceDiscovery({
  gmgnDiscovery: {
    total: 4,
    pools: [samePoolGmgn, gmgnOnlyValidated, gmgnOnlyInvalid],
    stage_counts: { rank_filter: 3 },
    filtered_examples: [{ stage: "gmgn_rank_filter", reason: "synthetic" }],
  },
  meteoraDiscovery: {
    total: 4,
    pools: [samePoolMeteora, meteoraOnly, sameMintLowerScore],
    stage_counts: { deduped_pools: 3 },
    filtered_examples: [{ stage: "meteora_filter", reason: "synthetic" }],
  },
  gmgnValidationByPool: new Map([
    ["pool-gmgn-valid", gmgnOnlyValidation],
  ]),
  runtimeConfig,
});

const overlap = resolved.pools.find((pool) => pool.pool === "pool-overlap");
const validated = resolved.pools.find((pool) => pool.pool === "pool-gmgn-valid");
const meteora = resolved.pools.find((pool) => pool.pool === "pool-meteora-only");
const rejected = resolved.filtered_examples.find((row) => row.pool === "pool-gmgn-invalid");
const sameMintDrop = resolved.filtered_examples.find((row) => row.stage === "same_mint_alternative_dropped");

assert.strictEqual(buildConfig({ screeningSource: "both" }, {}).screening.source, "both", "config accepts screeningSource=both");
assert.strictEqual(buildConfig({ screening: { source: "both" } }, {}).screening.source, "both", "nested screening.source accepts both");
assert.ok(overlap, "same pool overlap is preserved");
assert.deepStrictEqual(overlap.discovery_sources, ["gmgn", "meteora"], "overlap preserves both source names");
assert.strictEqual(overlap.source_resolution, "overlap_same_pool", "overlap source resolution is labeled");
assert.strictEqual(overlap.active_tvl, samePoolMeteora.active_tvl, "overlap prefers Meteora active TVL");
assert.strictEqual(overlap.volume_window, samePoolMeteora.volume_window, "overlap prefers Meteora volume");
assert.strictEqual(overlap.fee_active_tvl_ratio, samePoolMeteora.fee_active_tvl_ratio, "overlap prefers Meteora fee/TVL");
assert.strictEqual(overlap.bin_step, samePoolMeteora.bin_step, "overlap prefers Meteora bin step");
assert.strictEqual(overlap.volatility, samePoolMeteora.volatility, "overlap prefers Meteora volatility");
assert.strictEqual(overlap.gmgn_score, samePoolGmgn.gmgn_score, "overlap preserves GMGN intelligence");
assert.ok(validated, "GMGN-only validated candidate is preserved");
assert.strictEqual(validated.source_resolution, "gmgn_only_validated", "GMGN-only validation is labeled");
assert.deepStrictEqual(validated.discovery_sources, ["gmgn"], "GMGN-only keeps GMGN provenance");
assert.ok(meteora, "Meteora-only candidate is preserved");
assert.strictEqual(meteora.source_resolution, "meteora_only", "Meteora-only resolution is labeled");
assert.ok(rejected?.reason.includes("GMGN-only candidate lacks valid direct Meteora"), "GMGN-only without validation rejects fail-closed");
assert.ok(sameMintDrop, "same-mint alternative is logged as dropped");
assert.strictEqual(resolved.stage_counts.source_mode, "both", "stage counts expose source_mode");
assert.strictEqual(resolved.stage_counts.gmgn_stage_counts.rank_filter, 3, "GMGN stage counts are preserved");
assert.strictEqual(resolved.stage_counts.meteora_stage_counts.deduped_pools, 3, "Meteora stage counts are preserved");
assert.strictEqual(resolved.stage_counts.union_stage_counts.pool_overlap, 1, "union counts pool overlap");
assert.strictEqual(resolved.stage_counts.union_stage_counts.gmgn_only_accepted, 1, "union counts accepted GMGN-only");
assert.strictEqual(resolved.stage_counts.union_stage_counts.gmgn_only_rejected, 1, "union counts rejected GMGN-only");
assert.strictEqual(resolved.stage_counts.union_stage_counts.same_mint_alternatives_dropped, 1, "union counts same-mint drops");

const gmgnFailure = resolveDualSourceDiscovery({
  gmgnDiscovery: { total: 0, pools: [], stage_counts: {} },
  meteoraDiscovery: { total: 1, pools: [meteoraOnly], stage_counts: { deduped_pools: 1 } },
  sourceErrors: { gmgn: "synthetic GMGN failure", meteora: null },
  runtimeConfig,
});
const meteoraFailure = resolveDualSourceDiscovery({
  gmgnDiscovery: { total: 1, pools: [gmgnOnlyValidated], stage_counts: { candidate_shape: 1 } },
  meteoraDiscovery: { total: 0, pools: [], stage_counts: {} },
  sourceErrors: { gmgn: null, meteora: "synthetic Meteora failure" },
  runtimeConfig,
});
assert.strictEqual(gmgnFailure.pools.length, 1, "GMGN failure still allows Meteora-only candidates");
assert.strictEqual(gmgnFailure.source_errors.gmgn, "synthetic GMGN failure", "GMGN source error is exposed");
assert.strictEqual(meteoraFailure.pools.length, 0, "Meteora failure blocks unvalidated GMGN-only candidates");
assert.strictEqual(meteoraFailure.stage_counts.union_stage_counts.source_validation_reject, 1, "Meteora failure source validation reject is counted");

const multi = resolveMultiSourceDiscovery({
  sources: [
    {
      name: "gmgn",
      discovery: { total: 1, pools: [gmgnOnlyValidated], stage_counts: { candidate_shape: 1 } },
      validationByPool: new Map([["pool-gmgn-valid", gmgnOnlyValidation]]),
      requiresValidation: true,
    },
    {
      name: "meteora",
      discovery: { total: 1, pools: [meteoraOnly], stage_counts: { deduped_pools: 1 } },
    },
    {
      name: "okx_discovery",
      discovery: { total: 1, pools: [okxOnly], stage_counts: { mapped_pools: 1 } },
    },
  ],
  sourceErrors: { gmgn: null, meteora: null, okx_discovery: null },
  runtimeConfig,
  sourceMode: "all",
});
const okxResolved = multi.pools.find((pool) => pool.pool === "pool-okx-only");
assert.ok(okxResolved, "OKX-only mapped candidate is preserved by multi-source resolver");
assert.strictEqual(okxResolved.okxScore, 88, "OKX evidence is preserved");
assert.strictEqual(multi.stage_counts.source_mode, "all", "multi-source resolver exposes all source mode");
assert.strictEqual(multi.stage_counts.source_stage_counts.okx_discovery.mapped_pools, 1, "OKX stage counts are preserved");
assert.strictEqual(multi.stage_counts.union_stage_counts.okx_discovery_only_accepted, 1, "OKX-only acceptance is counted");

const configBuilderSource = src("config-builder.js");
const screeningSource = src("tools/screening.js");
const okxDiscoverySource = src("tools/okx-discovery.js");
const verifierSource = src("scripts/verify-scout-dual-source-discovery.js");
assert.ok(configBuilderSource.includes('"all"') && configBuilderSource.includes('"meteora+okx"'), "config source set includes OKX source modes");
assert.ok(screeningSource.includes("export function resolveDualSourceDiscovery"), "pure resolver is exported");
assert.ok(screeningSource.includes("export function resolveMultiSourceDiscovery"), "multi-source resolver is exported");
assert.ok(screeningSource.includes('both: ["gmgn", "meteora"]'), "getTopCandidates has both source plan");
assert.ok(screeningSource.includes("Promise.allSettled"), "both branch isolates one-source failures");
assert.ok(screeningSource.includes("validateGmgnOnlyCandidatesWithMeteora"), "both branch validates GMGN-only pools with Meteora");
assert.ok(screeningSource.includes("discoverOkxPools"), "getTopCandidates can run OKX discovery");
assert.ok(screeningSource.includes("filterConfiguredPoolThresholds"), "shared configured threshold gate remains present");
assert.ok(screeningSource.includes("rankCandidatesByDarwin(eligible)"), "Darwin ranking still happens after shared gates");
assert.ok(okxDiscoverySource.includes("lastMappingMisses"), "OKX discovery exposes recent Meteora mapping misses");
assert.ok(okxDiscoverySource.includes("mapping_miss_sample"), "OKX discovery returns compact mapping miss samples");
assert.ok(okxDiscoverySource.includes("Pool map miss"), "OKX discovery logs compact map-fail diagnostics");
assert.ok(okxDiscoverySource.includes("resolved_pool_count"), "OKX mapping diagnostics record resolver pool counts");

const bothBranch = screeningSource.indexOf('both: ["gmgn", "meteora"]');
const thresholdGate = screeningSource.indexOf("filterConfiguredPoolThresholds", bothBranch);
const openPositionGate = screeningSource.indexOf("occupiedPools.has", bothBranch);
const darwinRank = screeningSource.indexOf("rankCandidatesByDarwin(eligible)", bothBranch);
assert.ok(bothBranch >= 0 && thresholdGate > bothBranch, "configured threshold gate is after both discovery");
assert.ok(openPositionGate > bothBranch && openPositionGate < darwinRank, "open-position gate remains after both discovery before Darwin");
assert.ok(thresholdGate < darwinRank, "configured threshold gate remains before Darwin");

for (const forbidden of [
  "deploy_" + "position",
  "close_" + "position",
  "deploy" + "Position(",
  "close" + "Position(",
  "p" + "m2",
  "P" + "M2",
  "node " + "index.js",
]) {
  assert.ok(!verifierSource.includes(forbidden), `verifier must not include ${forbidden}`);
}

console.log(JSON.stringify({
  success: true,
  checks: [
    "config accepts screeningSource=both",
    "same-pool overlap prefers Meteora metrics and preserves GMGN intelligence",
    "GMGN-only requires direct Meteora validation",
    "GMGN-only without validation rejects fail-closed",
    "Meteora-only candidates remain eligible for shared gates",
    "GMGN source failure can still return Meteora-only candidates",
    "Meteora source failure blocks unvalidated GMGN-only candidates",
    "OKX-only mapped candidates are preserved by the multi-source resolver",
    "OKX map-fail diagnostics expose compact token context without changing gates",
    "same-mint alternatives are dropped and logged",
    "stage counts preserve GMGN, Meteora, OKX, and union evidence",
    "source scan shows both branch before shared gates and no deploy/close verifier behavior",
  ],
  sourceFailureProof: {
    gmgnFailureAllowsMeteora: gmgnFailure.pools.length === 1,
    meteoraFailureBlocksUnvalidatedGmgn: meteoraFailure.pools.length === 0,
  },
}, null, 2));
