#!/usr/bin/env node
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  computeDownsideBinsForPct,
  buildDynamicRangeShadowTelemetry,
  enrichFeeVelocityCandidate,
  normalizeCandidateEvidenceForDeploy,
  resolveDynamicRangeLiveDeployArgs,
  resolveStrategyRangePolicy,
} from "../strategy-library.js";
import { buildCandidateDecisionContext } from "../decision-context-log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

const strategy = {
  id: "main_shadow_policy",
  name: "Main shadow policy",
  lp_strategy: "bid_ask",
  entry: { single_side: "sol" },
  range: {
    bins_below: 35,
    bins_below_min: 29,
    bins_below_max: 35,
    target_downside_min_pct: 12,
    target_downside_max_pct: 20,
    bins_above: 0,
  },
};
const policy = resolveStrategyRangePolicy(strategy, { strategy: { strategy: "bid_ask", binsBelow: 69 } });
const riskyCandidate = {
  pool: "pool-shadow",
  name: "SHADOW-SOL",
  bin_step: 100,
  mcap: 80_000,
  active_tvl: 4_000,
  volatility: 9,
  price_change_pct: 64,
  organic_score: 42,
  fee_active_tvl_ratio: 0.05,
  deploy_share_of_active_tvl_pct: 5,
};
const shadow = buildDynamicRangeShadowTelemetry(riskyCandidate, {
  deployAmountSol: 0.5,
  rangePolicy: policy,
});

assert.strictEqual(shadow.shadow_only, true, "shadow flag is explicit");
assert.strictEqual(shadow.applied_to_deploy_args, false, "shadow is not applied to deploy args");
assert.strictEqual(shadow.proposed_target_downside_pct, 45, "risky candidate clamps proposal to telemetry max");
assert.strictEqual(shadow.proposed_bins_below, 61, "proposal converts downside pct into bins");
assert.strictEqual(shadow.deploy_share_of_active_tvl_pct, 5, "candidate deploy share is preserved");
assert.strictEqual(shadow.adaptive_width_mode, "shadow", "adaptive width defaults to shadow mode");
assert.strictEqual(shadow.adaptive_input_status, "insufficient_data", "missing deploy USD makes adaptive selector input insufficient");
assert.ok(shadow.adaptive_input_problems.includes("missing_deploy_usd"), "missing deploy USD is explicit");
assert.strictEqual(shadow.oversize_deploy_share, false, "exact 5% deploy share is not oversized");
assert.strictEqual(shadow.policy_violation, true, "policy violation is flagged");
assert.ok(shadow.policy_violations.includes("above_bins_max"), "bins max violation is marked");
assert.ok(shadow.policy_violations.includes("above_target_downside_max_pct"), "target downside max violation is marked");
assert.strictEqual(shadow.current_strategy_range.bins_below, 35, "current fixed strategy range is logged");
assert.ok(shadow.drivers.includes("deploy_share_gt_4pct:+6"), "deploy-share >4% driver is logged");
assert.ok(shadow.drivers.includes("low_quality_organic_lt_50:+4"), "quality driver is logged");

const calmCandidate = {
  pool: "pool-calm",
  name: "CALM-SOL",
  bin_step: 100,
  mcap: 3_000_000,
  active_tvl: 150_000,
  volatility: 1.5,
  price_change_pct: -2,
  organic_score: 88,
  fee_active_tvl_ratio: 0.25,
};
const calmShadow = buildDynamicRangeShadowTelemetry(calmCandidate, {
  assumedDeployUsd: 500,
  rangePolicy: policy,
});
assert.strictEqual(calmShadow.proposed_target_downside_pct, 5, "calm high-quality pool narrows proposal to telemetry floor");
assert.strictEqual(calmShadow.adaptive_input_status, "ok", "complete selector inputs are marked ok");
assert.strictEqual(calmShadow.policy_violation, true, "below target policy violation is marked without override");
assert.ok(calmShadow.policy_violations.includes("below_bins_min"), "bins min violation is marked");
assert.ok(calmShadow.policy_violations.includes("below_target_downside_min_pct"), "target downside min violation is marked");

function deployShareBoundary(sharePct) {
  return buildDynamicRangeShadowTelemetry({
    pool: `share-${sharePct}`,
    name: `SHARE-${sharePct}`,
    bin_step: 100,
    mcap: 500_000,
    active_tvl: 20_000,
    volatility: 3,
    price_change_pct: 10,
    organic_score: 60,
    fee_active_tvl_ratio: 0.12,
    deploy_share_of_active_tvl_pct: sharePct,
  }, {
    assumedDeployUsd: 500,
    rangePolicy: policy,
  });
}
const share29 = deployShareBoundary(2.9);
const share31 = deployShareBoundary(3.1);
const share49 = deployShareBoundary(4.9);
const share51 = deployShareBoundary(5.1);
assert.ok(share29.drivers.includes("deploy_share_gt_2pct:+4"), "2.9% deploy share gets >2% risk driver");
assert.ok(share31.drivers.includes("deploy_share_gt_2pct:+4"), "3.1% deploy share gets >2% risk driver");
assert.ok(share49.drivers.includes("deploy_share_gt_4pct:+6"), "4.9% deploy share gets >4% risk driver");
assert.ok(share51.drivers.includes("deploy_share_gt_5pct:+8"), "5.1% deploy share gets >5% risk driver");
assert.strictEqual(share49.oversize_deploy_share, false, "4.9% deploy share is not oversized");
assert.strictEqual(share51.oversize_deploy_share, true, "5.1% deploy share is oversized");
assert.ok(
  share29.proposed_target_downside_pct <= share31.proposed_target_downside_pct &&
  share31.proposed_target_downside_pct <= share49.proposed_target_downside_pct &&
  share49.proposed_target_downside_pct <= share51.proposed_target_downside_pct,
  "deploy-share risk contribution is monotonic across 2.9/3.1/4.9/5.1",
);

const poolStepBins = {
  step50: computeDownsideBinsForPct(50, 50),
  step80: computeDownsideBinsForPct(50, 80),
  step100: computeDownsideBinsForPct(50, 100),
  step125: computeDownsideBinsForPct(50, 125),
};
assert.deepStrictEqual(poolStepBins, {
  step50: 139,
  step80: 87,
  step100: 70,
  step125: 56,
}, "50% target maps to expected pool-step bins");

const v2aBase = {
  pool: "pool-step-50",
  name: "ZERO-SOL",
  base_mint: "ZERO_MINT",
  quote: { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" },
  bin_step: 50,
  active_tvl: 25_000,
  volume_window: 200_000,
  fee_active_tvl_ratio: 0.18,
  source: "meteora",
  evidence_asof_ts: "2026-06-15T11:55:00Z",
  decision_ts: "2026-06-15T12:00:00Z",
  evidence_row_id: "current-row",
};
const zeroWrongStepShadow = buildDynamicRangeShadowTelemetry({
  ...v2aBase,
  target_width_pct: 50,
  target_width_source: "asof_supplied_or_policy",
  target_width_asof_ts: "2026-06-15T11:58:00Z",
}, { rangePolicy: {} }).range_feasibility_shadow;
assert.strictEqual(zeroWrongStepShadow.current_pool_fit.required_bins, 139, "50 bps current pool requires too many bins");
assert.strictEqual(zeroWrongStepShadow.current_pool_fit.pool_step_status, "wrong_step_too_many_bins", "50 bps current pool is rejected as wrong step");
assert.strictEqual(zeroWrongStepShadow.current_pool_fit.recommendable_shadow, false, "wrong-step current pool is not recommendable");
assert.notStrictEqual(zeroWrongStepShadow.current_pool_fit.pool_step_status, "normal_step_fit", "wrong step is never normal");
assert.strictEqual(zeroWrongStepShadow.current_pool_fit.too_many_bins, true, "50 bps undercoverage is flagged against 69-bin cap");
assert.strictEqual(zeroWrongStepShadow.current_pool_fit.target_truncated, true, "50 bps target truncation is explicit");

const step80Undercoverage = buildDynamicRangeShadowTelemetry({
  ...v2aBase,
  pool: "pool-step-80",
  bin_step: 80,
  target_width_pct: 50,
  target_width_source: "asof_supplied_or_policy",
  target_width_asof_ts: "2026-06-15T11:58:00Z",
}, { rangePolicy: {} }).range_feasibility_shadow.current_pool_fit;
assert.strictEqual(step80Undercoverage.required_bins, 87, "80 bps current pool requires too many bins for 50% target");
assert.strictEqual(step80Undercoverage.too_many_bins, true, "80 bps undercoverage is flagged against 69-bin cap");
assert.strictEqual(step80Undercoverage.target_truncated, true, "80 bps target truncation is explicit");

const alternativeFitShadow = buildDynamicRangeShadowTelemetry({
  ...v2aBase,
  target_width_pct: 50,
  target_width_source: "asof_supplied_or_policy",
  target_width_asof_ts: "2026-06-15T11:58:00Z",
  source_evidence: {
    same_mint_alternatives: [
      {
        pool: "pool-step-125",
        base_mint: "ZERO_MINT",
        quote: { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" },
        bin_step: 125,
        active_tvl: 30_000,
        volume_window: 180_000,
        fee_active_tvl_ratio: 0.2,
        evidence_asof_ts: "2026-06-15T11:56:00Z",
        evidence_row_id: "alt-row-125",
        source: "meteora",
      },
      {
        pool: "pool-step-100",
        base_mint: "ZERO_MINT",
        quote: { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" },
        bin_step: 100,
        active_tvl: 40_000,
        volume_window: 210_000,
        fee_active_tvl_ratio: 0.22,
        evidence_asof_ts: "2026-06-15T11:56:00Z",
        evidence_row_id: "alt-row-100",
        source: "meteora",
      },
    ],
  },
}, { rangePolicy: {} }).range_feasibility_shadow;
assert.strictEqual(alternativeFitShadow.source, "dynamic_range_shadow_swing_envelope_bidask_v2a", "v2a source is explicit");
assert.strictEqual(alternativeFitShadow.profile, "swing_envelope_bidask", "v2a profile is explicit");
assert.strictEqual(alternativeFitShadow.mode, "pool_step_fit_shadow", "v2a mode is explicit");
assert.strictEqual(alternativeFitShadow.shadow_only, true, "v2a is shadow-only");
assert.strictEqual(alternativeFitShadow.applied_to_deploy_args, false, "v2a is not applied to deploy args");
assert.strictEqual(alternativeFitShadow.sizing_policy, "static_unchanged", "v2a sizing remains static");
assert.strictEqual(alternativeFitShadow.shadow_verdict, "alternative_pool_fit", "same-mint alternative can win shadow fit");
assert.strictEqual(alternativeFitShadow.shadow_selected_pool_fit.pool, "pool-step-100", "ideal 100 bps fit is selected over current wrong step");
assert.strictEqual(alternativeFitShadow.shadow_selected_pool_fit.required_bins, 70, "selected alternative carries computed bins");
assert.strictEqual(alternativeFitShadow.shadow_selected_pool_fit.applied_to_deploy_args, false, "selected fit is explicitly non-deployable");
assert.strictEqual(alternativeFitShadow.current_pool_fit.pool, "pool-step-50", "current deploy pool remains visible separately");
const liveAltDeferred = resolveDynamicRangeLiveDeployArgs({
  candidate: { pool: "pool-step-50", bin_step: 50 },
  dynamicRangeShadow: { range_feasibility_shadow: alternativeFitShadow },
  fallbackPool: "pool-step-50",
  fallbackBinsBelow: 35,
  fallbackBinStep: 50,
});
assert.strictEqual(liveAltDeferred.applied_to_deploy_args, false, "live resolver defers alternative pool switching");
assert.strictEqual(liveAltDeferred.reason, "adaptive_width_shadow_mode_fallback", "shadow mode fallback reason wins before alternative switching");
assert.ok(liveAltDeferred.eligibility_problems.includes("same_mint_alternative_shadow_only"), "alternative fit remains shadow-only in eligibility problems");
assert.strictEqual(liveAltDeferred.pool_address, "pool-step-50", "alternative fit cannot change deploy pool");
assert.strictEqual(liveAltDeferred.bins_below, 35, "alternative fit keeps static strategy bins");
assert.strictEqual(liveAltDeferred.bin_step, 50, "alternative fit keeps current pool bin step");

const currentPoolDynamicShadow = buildDynamicRangeShadowTelemetry({
  ...v2aBase,
  pool: "pool-step-100-current",
  bin_step: 100,
  mcap: 500_000,
  volatility: 3,
  price_change_pct: 12,
  target_width_pct: 50,
  target_width_source: "asof_supplied_or_policy",
  target_width_asof_ts: "2026-06-15T11:58:00Z",
  deploy_share_of_active_tvl_pct: 3,
}, {
  assumedDeployUsd: 500,
  rangePolicy: {},
});
const currentPoolFitShadow = currentPoolDynamicShadow.range_feasibility_shadow;
assert.strictEqual(currentPoolFitShadow.shadow_verdict, "current_pool_fit", "complete current-pool evidence can win live fit");
assert.strictEqual(currentPoolFitShadow.current_pool_fit.required_bins, 70, "current pool fit computes required bins");
assert.strictEqual(currentPoolFitShadow.current_pool_fit.target_truncated, true, "70-bin target is marked truncated against 69-bin cap");
assert.ok(
  Math.abs(currentPoolFitShadow.current_pool_fit.truncated_downside_coverage_pct - 49.68) < 0.5,
  "100 bps 69-bin coverage is within 0.5 percentage points of 50%",
);
assert.strictEqual(currentPoolDynamicShadow.adaptive_input_status, "ok", "current-pool fixture has complete adaptive inputs");
const liveApplied = resolveDynamicRangeLiveDeployArgs({
  candidate: { pool: "pool-step-100-current", bin_step: 100 },
  dynamicRangeShadow: currentPoolDynamicShadow,
  fallbackPool: "pool-step-100-current",
  fallbackBinsBelow: 35,
  fallbackBinStep: 100,
});
assert.strictEqual(liveApplied.adaptive_width_mode, "shadow", "resolver defaults to shadow mode");
assert.strictEqual(liveApplied.applied_to_deploy_args, false, "shadow resolver never applies current-pool fit to deploy args");
assert.strictEqual(liveApplied.reason, "adaptive_width_shadow_mode_fallback", "shadow fallback reason is explicit");
assert.strictEqual(liveApplied.pool_address, "pool-step-100-current", "resolver keeps the current deploy pool");
assert.strictEqual(liveApplied.bins_below, 35, "resolver keeps fallback strategy bins");
assert.strictEqual(liveApplied.bin_step, 100, "resolver keeps current pool bin step");
assert.ok(!JSON.stringify({ liveApplied }).includes('"applied_to_deploy_args":true'), "default current-pool resolver output has no applied=true flag");

const oversizeLiveBlocked = resolveDynamicRangeLiveDeployArgs({
  candidate: { pool: "pool-step-100-current", bin_step: 100 },
  dynamicRangeShadow: {
    ...currentPoolDynamicShadow,
    oversize_deploy_share: true,
  },
  fallbackPool: "pool-step-100-current",
  fallbackBinsBelow: 35,
  fallbackBinStep: 100,
  adaptiveWidthMode: "live_current_pool",
});
assert.strictEqual(oversizeLiveBlocked.applied_to_deploy_args, false, "oversize deploy share blocks future live mode");
assert.strictEqual(oversizeLiveBlocked.reason, "oversize_deploy_share_requires_size_policy", "oversize block reason is explicit");
assert.ok(oversizeLiveBlocked.eligibility_problems.includes("oversize_deploy_share_requires_size_policy"), "oversize block is in eligibility problems");

const activeTvlSubstitutionShadow = buildDynamicRangeShadowTelemetry({
  ...v2aBase,
  pool: "pool-initial-value-only",
  bin_step: 100,
  active_tvl: undefined,
  tvl: undefined,
  initial_value_usd: 30_000,
  target_width_pct: 50,
  target_width_source: "asof_supplied_or_policy",
  target_width_asof_ts: "2026-06-15T11:58:00Z",
}, { rangePolicy: {} }).range_feasibility_shadow;
assert.strictEqual(activeTvlSubstitutionShadow.current_pool_fit.evidence_status, "insufficient_data", "initial_value_usd is not accepted as active TVL evidence");
assert.ok(activeTvlSubstitutionShadow.current_pool_fit.evidence_problems.includes("missing_active_tvl"), "missing active TVL remains explicit");

const missingTargetShadow = buildDynamicRangeShadowTelemetry({
  ...v2aBase,
}, { rangePolicy: {} }).range_feasibility_shadow;
assert.strictEqual(missingTargetShadow.shadow_verdict, "target_width_missing", "missing supplied/policy target is explicit");
assert.strictEqual(missingTargetShadow.missing_evidence_reason, "target_width_missing", "missing target reason is explicit");

const afterDecisionShadow = buildDynamicRangeShadowTelemetry({
  ...v2aBase,
  target_width_pct: 50,
  target_width_source: "asof_supplied_or_policy",
  target_width_asof_ts: "2026-06-15T12:05:00Z",
}, { rangePolicy: {} }).range_feasibility_shadow;
assert.strictEqual(afterDecisionShadow.shadow_verdict, "insufficient_data", "future as-of target is not usable");
assert.strictEqual(afterDecisionShadow.missing_evidence_reason, "target_width_asof_after_decision", "future as-of rejection reason is explicit");

const manualSourceShadow = buildDynamicRangeShadowTelemetry({
  ...v2aBase,
  target_width_pct: 50,
  target_width_source: "screenshot_manual_chart_note",
  target_width_asof_ts: "2026-06-15T11:55:00Z",
}, { rangePolicy: {} }).range_feasibility_shadow;
assert.strictEqual(manualSourceShadow.shadow_verdict, "insufficient_data", "manual screenshot target is not usable");
assert.strictEqual(manualSourceShadow.missing_evidence_reason, "target_width_source_not_deploy_time_safe", "manual screenshot rejection reason is explicit");

const missingAlternativeEvidenceShadow = buildDynamicRangeShadowTelemetry({
  ...v2aBase,
  target_width_pct: 50,
  target_width_source: "asof_supplied_or_policy",
  target_width_asof_ts: "2026-06-15T11:58:00Z",
  source_evidence: {
    same_mint_alternatives: [
      {
        pool: "pool-step-125-missing-evidence",
        base_mint: "ZERO_MINT",
        quote: { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" },
        bin_step: 125,
      },
    ],
  },
}, { rangePolicy: {} }).range_feasibility_shadow;
const incompleteAlt = missingAlternativeEvidenceShadow.pool_normalization_candidates.find((entry) => entry.pool === "pool-step-125-missing-evidence");
assert.strictEqual(incompleteAlt.evidence_status, "insufficient_data", "missing alternative evidence is insufficient");
assert.strictEqual(incompleteAlt.recommendable_shadow, false, "missing alternative evidence is not recommended");
const liveFallback = resolveDynamicRangeLiveDeployArgs({
  candidate: { pool: "pool-step-50", bin_step: 50 },
  dynamicRangeShadow: { range_feasibility_shadow: missingAlternativeEvidenceShadow },
  fallbackPool: "pool-step-50",
  fallbackBinsBelow: 35,
  fallbackBinStep: 50,
});
assert.strictEqual(liveFallback.applied_to_deploy_args, false, "live resolver falls back without eligible fit");
assert.strictEqual(liveFallback.pool_address, "pool-step-50", "fallback keeps candidate pool");
assert.strictEqual(liveFallback.bins_below, 35, "fallback keeps strategy bins");

function firstAlternativeFitFor(alternative) {
  const shadow = buildDynamicRangeShadowTelemetry({
    ...v2aBase,
    target_width_pct: 50,
    target_width_source: "asof_supplied_or_policy",
    target_width_asof_ts: "2026-06-15T11:58:00Z",
    source_evidence: { same_mint_alternatives: [alternative] },
  }, { rangePolicy: {} }).range_feasibility_shadow;
  return shadow.pool_normalization_candidates.find((entry) => entry.is_current_pool === false);
}

const futureEvidenceAlt = firstAlternativeFitFor({
  pool: "pool-future-evidence",
  base_mint: "ZERO_MINT",
  quote: { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" },
  bin_step: 100,
  active_tvl: 30_000,
  volume_window: 180_000,
  fee_active_tvl_ratio: 0.2,
  evidence_asof_ts: "2026-06-15T12:05:00Z",
  evidence_row_id: "future-row",
  source: "meteora",
});
assert.strictEqual(futureEvidenceAlt.evidence_status, "insufficient_data", "future alternative evidence is insufficient");
assert.ok(futureEvidenceAlt.evidence_problems.includes("evidence_asof_after_decision"), "future alternative evidence reason is explicit");
assert.strictEqual(futureEvidenceAlt.recommendable_shadow, false, "future alternative evidence is not recommended");

const staleEvidenceAlt = firstAlternativeFitFor({
  pool: "pool-stale-evidence",
  base_mint: "ZERO_MINT",
  quote: { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" },
  bin_step: 100,
  active_tvl: 30_000,
  volume_window: 180_000,
  fee_active_tvl_ratio: 0.2,
  evidence_asof_ts: "2026-06-15T11:55:00Z",
  evidence_row_id: "stale-row",
  evidence_status: "stale",
  source: "meteora",
});
assert.strictEqual(staleEvidenceAlt.evidence_status, "insufficient_data", "stale alternative evidence is insufficient");
assert.ok(staleEvidenceAlt.evidence_problems.includes("stale_evidence"), "stale alternative evidence reason is explicit");
assert.strictEqual(staleEvidenceAlt.recommendable_shadow, false, "stale alternative evidence is not recommended");

const manualEvidenceAlt = firstAlternativeFitFor({
  pool: "pool-manual-evidence",
  base_mint: "ZERO_MINT",
  quote: { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" },
  bin_step: 100,
  active_tvl: 30_000,
  volume_window: 180_000,
  fee_active_tvl_ratio: 0.2,
  evidence_asof_ts: "2026-06-15T11:55:00Z",
  evidence_row_id: "manual-row",
  evidence_source: "manual_screenshot_chart",
});
assert.strictEqual(manualEvidenceAlt.evidence_status, "insufficient_data", "manual pool evidence is insufficient");
assert.ok(manualEvidenceAlt.evidence_problems.includes("pool_evidence_source_not_deploy_time_safe"), "manual pool evidence reason is explicit");
assert.strictEqual(manualEvidenceAlt.recommendable_shadow, false, "manual pool evidence is not recommended");

const wrongQuoteAlt = firstAlternativeFitFor({
  pool: "pool-wrong-quote",
  base_mint: "ZERO_MINT",
  quote: { symbol: "USDC", mint: "USDC_MINT" },
  bin_step: 100,
  active_tvl: 30_000,
  volume_window: 180_000,
  fee_active_tvl_ratio: 0.2,
  evidence_asof_ts: "2026-06-15T11:55:00Z",
  evidence_row_id: "wrong-quote-row",
  source: "meteora",
});
assert.strictEqual(wrongQuoteAlt.evidence_status, "insufficient_data", "wrong quote alternative is insufficient");
assert.ok(wrongQuoteAlt.evidence_problems.includes("quote_mint_mismatch"), "wrong quote mint reason is explicit");
assert.ok(wrongQuoteAlt.evidence_problems.includes("missing_sol_quote_evidence"), "missing SOL quote reason is explicit");
assert.strictEqual(wrongQuoteAlt.recommendable_shadow, false, "wrong quote alternative is not recommended");

const missingQuoteAlt = firstAlternativeFitFor({
  pool: "pool-missing-quote",
  base_mint: "ZERO_MINT",
  bin_step: 100,
  active_tvl: 30_000,
  volume_window: 180_000,
  fee_active_tvl_ratio: 0.2,
  evidence_asof_ts: "2026-06-15T11:55:00Z",
  evidence_row_id: "missing-quote-row",
  source: "meteora",
});
assert.strictEqual(missingQuoteAlt.evidence_status, "insufficient_data", "missing quote alternative is insufficient");
assert.ok(missingQuoteAlt.evidence_problems.includes("missing_sol_quote_evidence"), "missing SOL quote proof reason is explicit");
assert.strictEqual(missingQuoteAlt.recommendable_shadow, false, "missing quote alternative is not recommended");

const conflictCandidate = normalizeCandidateEvidenceForDeploy({
  pool: "pool-conflict",
  base_mint: "BASE_A",
  baseMint: "BASE_B",
  quote: { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" },
  bin_step: 100,
  active_tvl: 30_000,
  volume_window: 180_000,
  fee_active_tvl_ratio: 0.2,
  target_width_pct: 50,
  target_width_source: "asof_supplied_or_policy",
  target_width_asof_ts: "2026-06-15T11:58:00Z",
  source_evidence: {
    source: "meteora",
    row_id: "conflict-row",
    asof_ts: "2026-06-15T11:55:00Z",
    pool: "pool-conflict",
  },
}, { decisionTs: "2026-06-15T12:00:00Z", sourceStage: "verify_conflict" });
assert.ok(conflictCandidate.evidence_problems.includes("base_mint_conflict"), "base mint alias conflict is explicit");
const conflictShadow = buildDynamicRangeShadowTelemetry(conflictCandidate, { rangePolicy: {} }).range_feasibility_shadow;
assert.strictEqual(conflictShadow.current_pool_fit.evidence_status, "insufficient_data", "alias conflict fails closed");
assert.strictEqual(conflictShadow.current_pool_fit.recommendable_shadow, false, "alias conflict cannot recommend live bins");

const sourceMismatchCandidate = normalizeCandidateEvidenceForDeploy({
  pool: "pool-source-current",
  base_mint: "SOURCE_BASE",
  quote: { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" },
  bin_step: 100,
  active_tvl: 30_000,
  volume_window: 180_000,
  fee_active_tvl_ratio: 0.2,
  target_width_pct: 50,
  target_width_source: "asof_supplied_or_policy",
  target_width_asof_ts: "2026-06-15T11:58:00Z",
  source_evidence: {
    source: "meteora",
    row_id: "wrong-pool-row",
    asof_ts: "2026-06-15T11:55:00Z",
    pool: "pool-source-other",
    base_mint: "OTHER_BASE",
  },
}, { decisionTs: "2026-06-15T12:00:00Z", sourceStage: "verify_source_mismatch" });
assert.ok(sourceMismatchCandidate.evidence_problems.includes("source_pool_mismatch"), "source pool mismatch is explicit");
const sourceMismatchShadow = buildDynamicRangeShadowTelemetry(sourceMismatchCandidate, { rangePolicy: {} }).range_feasibility_shadow;
assert.strictEqual(sourceMismatchShadow.current_pool_fit.evidence_status, "insufficient_data", "source mismatch fails closed");

const sourceBaseMintMismatchCandidate = normalizeCandidateEvidenceForDeploy({
  pool: "pool-source-base-mismatch",
  base_mint: "SOURCE_BASE",
  quote: { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" },
  bin_step: 100,
  active_tvl: 30_000,
  volume_window: 180_000,
  fee_active_tvl_ratio: 0.2,
  target_width_pct: 50,
  target_width_source: "asof_supplied_or_policy",
  target_width_asof_ts: "2026-06-15T11:58:00Z",
  source_evidence: {
    source: "meteora",
    row_id: "wrong-base-row",
    asof_ts: "2026-06-15T11:55:00Z",
    pool: "pool-source-base-mismatch",
    base_mint: "OTHER_BASE",
    quote_mint: "So11111111111111111111111111111111111111112",
  },
}, { decisionTs: "2026-06-15T12:00:00Z", sourceStage: "verify_source_base_mint_mismatch" });
assert.ok(sourceBaseMintMismatchCandidate.evidence_problems.includes("source_base_mint_mismatch"), "same-pool source base mint mismatch is explicit");
assert.ok(sourceBaseMintMismatchCandidate.evidence_problems.includes("base_mint_conflict"), "same-pool source base mismatch still records alias conflict");
const sourceBaseMintMismatchShadow = buildDynamicRangeShadowTelemetry(sourceBaseMintMismatchCandidate, { rangePolicy: {} }).range_feasibility_shadow;
assert.strictEqual(sourceBaseMintMismatchShadow.current_pool_fit.evidence_status, "insufficient_data", "source base mint mismatch fails closed");
assert.strictEqual(sourceBaseMintMismatchShadow.current_pool_fit.recommendable_shadow, false, "source base mint mismatch cannot recommend live bins");

const sourceQuoteMintMismatchCandidate = normalizeCandidateEvidenceForDeploy({
  pool: "pool-source-quote-mismatch",
  base_mint: "SOURCE_BASE",
  quote: { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" },
  bin_step: 100,
  active_tvl: 30_000,
  volume_window: 180_000,
  fee_active_tvl_ratio: 0.2,
  target_width_pct: 50,
  target_width_source: "asof_supplied_or_policy",
  target_width_asof_ts: "2026-06-15T11:58:00Z",
  source_evidence: {
    source: "meteora",
    row_id: "wrong-quote-row",
    asof_ts: "2026-06-15T11:55:00Z",
    pool: "pool-source-quote-mismatch",
    base_mint: "SOURCE_BASE",
    quote_mint: "USDC_MINT",
  },
}, { decisionTs: "2026-06-15T12:00:00Z", sourceStage: "verify_source_quote_mint_mismatch" });
assert.ok(sourceQuoteMintMismatchCandidate.evidence_problems.includes("source_quote_mint_mismatch"), "same-pool source quote mint mismatch is explicit");
assert.ok(sourceQuoteMintMismatchCandidate.evidence_problems.includes("quote_mint_conflict"), "same-pool source quote mismatch still records alias conflict");
const sourceQuoteMintMismatchShadow = buildDynamicRangeShadowTelemetry(sourceQuoteMintMismatchCandidate, { rangePolicy: {} }).range_feasibility_shadow;
assert.strictEqual(sourceQuoteMintMismatchShadow.current_pool_fit.evidence_status, "insufficient_data", "source quote mint mismatch fails closed");
assert.strictEqual(sourceQuoteMintMismatchShadow.current_pool_fit.recommendable_shadow, false, "source quote mint mismatch cannot recommend live bins");

const islandReplay = normalizeCandidateEvidenceForDeploy({
  pool: "islands-pool",
  name: "Islands-SOL",
  base_mint: "",
  quoteMint: null,
  quoteSymbol: "SOL",
  bin_step: 125,
  active_tvl: 0,
  fee_active_tvl_ratio: 0.2,
  volume_window: 120_000,
  target_width_pct: 50,
  target_width_source: "asof_supplied_or_policy",
  target_width_asof_ts: "2026-06-16T02:20:00Z",
}, { decisionTs: "2026-06-16T02:21:34Z", sourceStage: "fixture_islands_deploy_shape" });
const islandShadow = buildDynamicRangeShadowTelemetry(islandReplay, { rangePolicy: {} }).range_feasibility_shadow;
assert.strictEqual(islandShadow.current_pool_fit.evidence_status, "insufficient_data", "Islands-like missing deploy evidence stays insufficient");
assert.ok(islandShadow.current_pool_fit.evidence_problems.includes("missing_base_mint"), "Islands replay exposes missing base mint");
assert.ok(islandShadow.current_pool_fit.evidence_problems.includes("missing_active_tvl"), "Islands replay exposes missing active TVL");

const chatonReplay = normalizeCandidateEvidenceForDeploy({
  pool: "chaton-pool",
  name: "Chaton-SOL",
  base_mint: "CHATON_MINT",
  quoteMint: null,
  quoteSymbol: "SOL",
  bin_step: 100,
  active_tvl: 45_000,
  fee_active_tvl_ratio: 0.25,
  volume_window: 140_000,
  target_width_pct: 50,
  target_width_source: "asof_supplied_or_policy",
  target_width_asof_ts: "2026-06-16T02:40:00Z",
}, { decisionTs: "2026-06-16T02:42:10Z", sourceStage: "fixture_chaton_deploy_shape" });
const chatonShadow = buildDynamicRangeShadowTelemetry(chatonReplay, { rangePolicy: {} }).range_feasibility_shadow;
assert.strictEqual(chatonShadow.current_pool_fit.evidence_status, "insufficient_data", "Chaton-like missing source evidence stays insufficient");
assert.ok(chatonShadow.current_pool_fit.evidence_problems.includes("missing_source_evidence"), "Chaton replay exposes missing source evidence");

const serializedV2a = JSON.stringify(alternativeFitShadow);
for (const forbidden of ["recommended_size", "size_bucket", "deploy_share_action", "micro", "reduced", "full"]) {
  assert.ok(!serializedV2a.includes(forbidden), `v2a output does not include sizing field ${forbidden}`);
}

const enriched = enrichFeeVelocityCandidate(riskyCandidate, {
  screeningConfig: { timeframe: "5m" },
  rangePolicy: policy,
  deployAmountSol: 0.5,
});
assert.deepStrictEqual(enriched.dynamic_range_shadow, shadow, "candidate enrichment attaches dynamic range shadow");

const context = buildCandidateDecisionContext(enriched);
assert.strictEqual(context.dynamicRangeShadow.shadow_only, true, "decision context carries shadow telemetry");
assert.strictEqual(context.dynamicRangeShadow.applied_to_deploy_args, false, "decision context preserves non-applied flag");

const strategySource = read("strategy-library.js");
const fnStart = strategySource.indexOf("export function buildDynamicRangeShadowTelemetry");
const fnEnd = strategySource.indexOf("\nfunction load()");
const fnBody = strategySource.slice(fnStart, fnEnd);
assert.ok(fnStart > -1 && fnEnd > fnStart, "dynamic shadow function body is located");
for (const forbidden of ["executeTool", "deployPosition", "deploy_position", "closePosition", "close_position", "pushFilteredReason"]) {
  assert.ok(!fnBody.includes(forbidden), `dynamic shadow helper does not call ${forbidden}`);
}

const indexSource = read("index.js");
assert.ok(indexSource.includes("normalizeCandidateEvidenceForDeploy"), "deploy path imports candidate evidence normalizer");
assert.ok(indexSource.includes("sourceStage: \"latest_candidates_cache\""), "candidate cache normalizes evidence");
assert.ok(indexSource.includes("sourceStage: \"deploy_latest_candidate\""), "deploy path normalizes evidence again");
assert.ok(indexSource.includes("const dynamicRangeShadow = buildDynamicRangeShadowTelemetry(candidate"), "deploy path rebuilds dynamic range shadow from normalized candidate");
assert.ok(indexSource.includes("dynamic_range_shadow: deployDynamicRangeShadow"), "deploylatest passes live-annotated shadow metadata explicitly");
assert.ok(indexSource.includes("deploy_provenance: deployProvenance"), "deploylatest passes compact provenance telemetry");
assert.ok(indexSource.includes("resolveDynamicRangeLiveDeployArgs"), "deploylatest resolves dynamic range live args explicitly");
assert.ok(indexSource.includes("pool_address: deployPoolAddress"), "deploylatest passes dynamic/fallback deploy pool");
assert.ok(indexSource.includes("bins_below: deployBinsBelow"), "deploylatest passes dynamic/fallback bins");
assert.ok(indexSource.includes("amount_y: deployAmount"), "deploylatest still uses static computed deploy amount");
assert.ok(indexSource.includes("deploy_share_of_active_tvl_pct: candidate.deploy_share_of_active_tvl_pct"), "deploylatest passes deploy share telemetry separately");
assert.ok(indexSource.includes("live_application: dynamicRangeLive"), "deploy telemetry records live dynamic range application");
assert.ok(!/range_feasibility_shadow[\s\S]{0,240}(amount_y|maxDeployAmount|maxPositions)/.test(indexSource), "v2a shadow does not feed amount or runtime size caps");

const dlmmSource = read("tools/dlmm.js");
assert.ok(dlmmSource.includes("dynamic_range_shadow: dynamic_range_shadow ?? null"), "deploy context logs dynamic range shadow");
assert.ok(dlmmSource.includes("deploy_provenance: deploy_provenance ?? null"), "deploy context logs provenance as telemetry");
assert.ok(dlmmSource.includes("buildDynamicRangeShadowTelemetry({"), "deploy context can derive shadow telemetry from read-only metadata");
assert.ok(dlmmSource.includes("rangePolicy: resolveStrategyRangePolicy(getActiveStrategy(), config)"), "deploy-derived shadow uses active strategy policy");
assert.ok(!/dynamic_range_shadow[\s\S]{0,120}activeBinsBelow\s*=/.test(dlmmSource), "dynamic shadow is not assigned into activeBinsBelow");
assert.ok(!/activeBinsBelow\s*=[\s\S]{0,120}dynamic_range_shadow/.test(dlmmSource), "activeBinsBelow is not assigned from dynamic shadow");
assert.ok(!/shadow_selected_pool_fit[\s\S]{0,200}pool_address/.test(dlmmSource), "selected pool fit is not assigned to pool_address");
assert.ok(!/shadow_selected_pool_fit[\s\S]{0,200}bins_below/.test(dlmmSource), "selected pool fit is not assigned to bins_below");
assert.ok(!/range_feasibility_shadow[\s\S]{0,240}(activeBinsBelow|pool_address|bins_below|amount_y|maxDeployAmount|maxPositions)/.test(dlmmSource), "dlmm deploy internals do not independently consume v2a shadow");
assert.ok(!strategySource.includes("recommended_pool_shadow"), "deprecated operational pool recommendation field is absent");

const definitionsSource = read("tools/definitions.js");
assert.ok(definitionsSource.includes("mcap: { type: \"number\""), "deploy tool accepts mcap telemetry");
assert.ok(definitionsSource.includes("deploy_share_of_active_tvl_pct: { type: \"number\""), "deploy tool accepts deploy-share telemetry");
assert.ok(!definitionsSource.includes("deploy_provenance"), "deploy provenance is not model-facing tool evidence");
assert.ok(!definitionsSource.includes("required: [\"pool_address\", \"mcap\""), "telemetry fields are not required deploy inputs");

console.log(JSON.stringify({
  success: true,
  riskyProposal: {
    proposed_target_downside_pct: shadow.proposed_target_downside_pct,
    proposed_bins_below: shadow.proposed_bins_below,
    policy_violations: shadow.policy_violations,
    applied_to_deploy_args: shadow.applied_to_deploy_args,
  },
  calmProposal: {
    proposed_target_downside_pct: calmShadow.proposed_target_downside_pct,
    proposed_bins_below: calmShadow.proposed_bins_below,
    policy_violations: calmShadow.policy_violations,
  },
  poolStepBins,
  zeroWrongStep: {
    required_bins: zeroWrongStepShadow.current_pool_fit.required_bins,
    pool_step_status: zeroWrongStepShadow.current_pool_fit.pool_step_status,
    recommendable_shadow: zeroWrongStepShadow.current_pool_fit.recommendable_shadow,
  },
  alternativeFit: {
    source: alternativeFitShadow.source,
    profile: alternativeFitShadow.profile,
    mode: alternativeFitShadow.mode,
    shadow_verdict: alternativeFitShadow.shadow_verdict,
    deploy_pool_unchanged: alternativeFitShadow.current_pool_fit.pool === "pool-step-50",
    selected_pool: alternativeFitShadow.shadow_selected_pool_fit?.pool,
    selected_required_bins: alternativeFitShadow.shadow_selected_pool_fit?.required_bins,
    selected_applied_to_deploy_args: alternativeFitShadow.shadow_selected_pool_fit?.applied_to_deploy_args,
  },
  currentPoolFit: {
    shadow_verdict: currentPoolFitShadow.shadow_verdict,
    required_bins: currentPoolFitShadow.current_pool_fit?.required_bins,
    live_applied_to_deploy_args: liveApplied.applied_to_deploy_args,
    live_pool_address: liveApplied.pool_address,
    live_bins_below: liveApplied.bins_below,
    live_bin_step: liveApplied.bin_step,
  },
  liveApplication: {
    applied_to_deploy_args: liveAltDeferred.applied_to_deploy_args,
    reason: liveAltDeferred.reason,
    pool_address: liveAltDeferred.pool_address,
    bins_below: liveAltDeferred.bins_below,
    bin_step: liveAltDeferred.bin_step,
    fallback_applied_to_deploy_args: liveFallback.applied_to_deploy_args,
    fallback_pool_address: liveFallback.pool_address,
    fallback_bins_below: liveFallback.bins_below,
  },
  missingTarget: {
    shadow_verdict: missingTargetShadow.shadow_verdict,
    missing_evidence_reason: missingTargetShadow.missing_evidence_reason,
  },
  asofReject: {
    shadow_verdict: afterDecisionShadow.shadow_verdict,
    missing_evidence_reason: afterDecisionShadow.missing_evidence_reason,
  },
  manualReject: {
    shadow_verdict: manualSourceShadow.shadow_verdict,
    missing_evidence_reason: manualSourceShadow.missing_evidence_reason,
  },
  missingAlternativeEvidence: {
    evidence_status: incompleteAlt.evidence_status,
    recommendable_shadow: incompleteAlt.recommendable_shadow,
  },
  poolEvidenceRejects: {
    future: futureEvidenceAlt.evidence_problems.includes("evidence_asof_after_decision") && futureEvidenceAlt.recommendable_shadow === false,
    stale: staleEvidenceAlt.evidence_problems.includes("stale_evidence") && staleEvidenceAlt.recommendable_shadow === false,
    manual: manualEvidenceAlt.evidence_problems.includes("pool_evidence_source_not_deploy_time_safe") && manualEvidenceAlt.recommendable_shadow === false,
    wrongQuote: wrongQuoteAlt.evidence_problems.includes("quote_mint_mismatch") && wrongQuoteAlt.recommendable_shadow === false,
    missingQuote: missingQuoteAlt.evidence_problems.includes("missing_sol_quote_evidence") && missingQuoteAlt.recommendable_shadow === false,
  },
  conflictRejects: {
    baseMintConflict: conflictCandidate.evidence_problems.includes("base_mint_conflict") && conflictShadow.current_pool_fit.recommendable_shadow === false,
    sourcePoolMismatch: sourceMismatchCandidate.evidence_problems.includes("source_pool_mismatch") && sourceMismatchShadow.current_pool_fit.recommendable_shadow === false,
    sourceBaseMintMismatch: sourceBaseMintMismatchCandidate.evidence_problems.includes("source_base_mint_mismatch") && sourceBaseMintMismatchShadow.current_pool_fit.recommendable_shadow === false,
    sourceQuoteMintMismatch: sourceQuoteMintMismatchCandidate.evidence_problems.includes("source_quote_mint_mismatch") && sourceQuoteMintMismatchShadow.current_pool_fit.recommendable_shadow === false,
  },
  replayFixtures: {
    islandsInsufficient: islandShadow.current_pool_fit.evidence_status === "insufficient_data",
    islandsMissingBaseMint: islandShadow.current_pool_fit.evidence_problems.includes("missing_base_mint"),
    islandsMissingActiveTvl: islandShadow.current_pool_fit.evidence_problems.includes("missing_active_tvl"),
    chatonInsufficient: chatonShadow.current_pool_fit.evidence_status === "insufficient_data",
    chatonMissingSourceEvidence: chatonShadow.current_pool_fit.evidence_problems.includes("missing_source_evidence"),
  },
  staticSizingInvariant: {
    sizing_policy: alternativeFitShadow.sizing_policy,
    forbiddenSizingFieldsAbsent: true,
  },
  contextCarriesShadow: context.dynamicRangeShadow?.source === "dynamic_range_shadow_v1",
  sourceSafety: {
    noDeployOrCloseCallsInHelper: true,
    deployArgsResolvedThroughLiveHelper: true,
    selectedPoolFitUsedOnlyWhenEligible: true,
    deploySizeAndCapsRemainSeparate: true,
    deployProvenanceTelemetryOnly: true,
  },
}, null, 2));
