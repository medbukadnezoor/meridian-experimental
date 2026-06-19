/**
 * Strategy Library — persistent store of LP strategies.
 *
 * Users paste a tweet or description via Telegram.
 * The agent extracts structured criteria and saves it here.
 * During screening, the active strategy's criteria guide token selection and position config.
 */

import fs from "fs";
import { log } from "./logger.js";

const STRATEGY_FILE = "./strategy-library.json";

export const MAIN_FABRIQ_DEGEN_FEE_ROTATION_V1 = Object.freeze({
  id: "main_fabriq_degen_fee_rotation_v1",
  name: "Main Fabriq Degen Fee Rotation V1",
  author: "meridian-main",
  lp_strategy: "bid_ask",
  token_criteria: {
    notes: "Main 5 SOL Fabriq-inspired fee-rotation profile. Target high-fee SOL DLMM pools with enough active liquidity for size, fresh volume/active-TVL, and fee velocity. Fabriq score is discovery inspiration only; runtime gates remain Meridian evidence.",
    min_mcap: 125000,
    max_mcap: 2500000,
    min_active_tvl: 10000,
    max_active_tvl: 200000,
    min_holders: 500,
    min_fee_active_tvl_ratio: 1,
    min_volume_active_tvl_multiple: 2.5,
    preferred_volume_active_tvl_multiple: 5,
  },
  entry: {
    condition: "Deploy SOL-only into a 35-bin bid_ask range only after Fabriq/Degen-style discovery passes Meridian liquidity, fee-velocity, volume/active-TVL, holder, organic, cooldown, and rug checks.",
    single_side: "sol",
    notes: "Use amount_y only, amount_x=0. Treat 60-80/day as a capacity ceiling, not a target. Runtime amount_y is pool-liquidity sized before deploy. Re-entry is allowed only when fresh fee velocity and OHLCV entry evidence remain present; stale/no-fee exits require cooldown.",
  },
  range: {
    type: "tight_fee_rotation",
    bins_below: 35,
    bins_below_min: 35,
    bins_below_max: 35,
    bins_above: 0,
    dynamic_range_width_enabled: false,
    dynamic_pool_sizing_enabled: true,
    ohlcv_entry_gate_enabled: true,
    notes: "Tight single-sided SOL bid_ask range for fee density. Bin width stays at the selected pool/range policy, while runtime deploy size is capped to active TVL share and entry requires DexPaprika/GMGN/OKX OHLCV evidence.",
  },
  exit: {
    take_profit_pct: 2,
    stop_loss_pct: -3.5,
    hard_stop_loss_pct: -15,
    trailing_trigger_pct: 1.5,
    trailing_drop_pct: 0.75,
    fee_harvest_min_hold_minutes: 8,
    fee_harvest_min_fee_pct_of_entry: 0.75,
    no_fee_abort_max_hold_minutes: 20,
    max_hold_timeout_minutes: 90,
    notes: "Fee harvest is the intended positive exit. Generic TP/trailing remain backstops; do not treat this profile as fully fee-gated until TP/trailing are made confluence-aware in code.",
  },
  best_for: "Main small-size validation of Fabriq-style DLMM degen fee rotation: 5 SOL x 4 max, tight range, fast fee-confirmed exits, and quick redeploy only when fresh fee velocity persists.",
  raw: "Owner-requested Main Fabriq Degen profile after Pro plan sign-off on 2026-06-20. Pro caveat: signed off as plan only, not live runtime approval without replay/shadow evidence and fee-first exit safeguards.",
  added_at: "2026-06-20T00:00:00.000Z",
  updated_at: "2026-06-20T00:00:00.000Z",
});

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteNumberArray(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;
  return value
    .map((entry) => finiteNumber(entry))
    .filter((entry) => entry != null);
}

function roundNumber(value, decimals = 4) {
  const number = finiteNumber(value);
  if (number == null) return null;
  const scale = 10 ** decimals;
  return Math.round(number * scale) / scale;
}

function timeframeToMinutes(timeframe) {
  const normalized = String(timeframe || "").trim().toLowerCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)(m|h|d)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (match[2] === "m") return amount;
  if (match[2] === "h") return amount * 60;
  if (match[2] === "d") return amount * 1440;
  return null;
}

function numberFromCandidate(candidate = {}, keys = []) {
  for (const key of keys) {
    const value = key.split(".").reduce((current, part) => current?.[part], candidate);
    const number = finiteNumber(value);
    if (number != null) return number;
  }
  return null;
}

export function computeVolumeActiveTvlMultiple(candidate = {}) {
  const volume = numberFromCandidate(candidate, ["volume_window", "volume"]);
  const activeTvl = numberFromCandidate(candidate, ["active_tvl", "tvl"]);
  if (volume == null || activeTvl == null || activeTvl <= 0) return null;
  return roundNumber(volume / activeTvl, 4);
}

export function estimateFeeVelocityUsdPerMin(candidate = {}, screeningConfig = {}) {
  const feeWindow = numberFromCandidate(candidate, ["fee_window", "fee", "fee_usd"]);
  const minutes = timeframeToMinutes(screeningConfig.timeframe);
  if (feeWindow == null || minutes == null || minutes <= 0) return null;
  return roundNumber(feeWindow / minutes, 4);
}

export function computeDownsideBinsForPct(targetDownsidePct, binStep) {
  const downsidePct = finiteNumber(targetDownsidePct);
  const step = finiteNumber(binStep);
  if (downsidePct == null || step == null || downsidePct <= 0 || downsidePct >= 100 || step <= 0) return null;
  const priceRatio = 1 - downsidePct / 100;
  const binRatio = 1 + step / 10_000;
  return Math.max(1, Math.ceil(Math.abs(Math.log(priceRatio) / Math.log(binRatio))));
}

function clampNumber(value, min, max) {
  const number = finiteNumber(value);
  if (number == null) return null;
  return Math.min(max, Math.max(min, number));
}

function compareRangePolicyViolation(proposedBins, proposedDownsidePct, rangePolicy = {}) {
  const violations = [];
  if (proposedBins != null && rangePolicy.binsBelowMin != null && proposedBins < rangePolicy.binsBelowMin) {
    violations.push("below_bins_min");
  }
  if (proposedBins != null && rangePolicy.binsBelowMax != null && proposedBins > rangePolicy.binsBelowMax) {
    violations.push("above_bins_max");
  }
  if (proposedDownsidePct != null && rangePolicy.targetDownsideMinPct != null && proposedDownsidePct < rangePolicy.targetDownsideMinPct) {
    violations.push("below_target_downside_min_pct");
  }
  if (proposedDownsidePct != null && rangePolicy.targetDownsideMaxPct != null && proposedDownsidePct > rangePolicy.targetDownsideMaxPct) {
    violations.push("above_target_downside_max_pct");
  }
  return violations;
}

function normalizeAdaptiveWidthMode(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  if (["live_current_pool", "shadow", "disabled"].includes(normalized)) return normalized;
  return "shadow";
}

function addUniqueProblem(problems, problem) {
  if (problem && !problems.includes(problem)) problems.push(problem);
}

function buildAdaptiveInputStatus({
  mcap,
  priceChangePct,
  volatility,
  deployUsd,
  deployShareOfActiveTvlPct,
} = {}) {
  const problems = [];
  if (mcap == null) problems.push("missing_mcap");
  else if (mcap <= 0) problems.push("malformed_mcap");
  if (priceChangePct == null) problems.push("missing_price_change_pct");
  if (volatility == null) problems.push("missing_volatility");
  else if (volatility < 0) problems.push("malformed_volatility");
  if (deployUsd == null) problems.push("missing_deploy_usd");
  else if (deployUsd <= 0) problems.push("malformed_deploy_usd");
  if (deployShareOfActiveTvlPct == null) problems.push("missing_deploy_share_of_active_tvl_pct");
  else if (deployShareOfActiveTvlPct < 0) problems.push("malformed_deploy_share_of_active_tvl_pct");
  return {
    status: problems.length === 0 ? "ok" : "insufficient_data",
    problems,
  };
}

function firstPresentValue(source = {}, keys = []) {
  for (const key of keys) {
    const value = key.split(".").reduce((current, part) => current?.[part], source);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function safeTimestampMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isUnsafeTargetWidthSource(source) {
  const normalized = String(source || "").toLowerCase();
  return /screenshot|manual|chart|post[-_ ]?entry|post[-_ ]?low|outcome|after[-_ ]?entry|future|ohlcv|swing[-_ ]?low|l_pre/.test(normalized);
}

function buildBaseRangeFeasibilityShadow(extra = {}) {
  return {
    source: "dynamic_range_shadow_swing_envelope_bidask_v2a",
    profile: "swing_envelope_bidask",
    mode: "pool_step_fit_shadow",
    shadow_only: true,
    applied_to_deploy_args: false,
    sizing_policy: "static_unchanged",
    target_width_pct: null,
    target_width_source: null,
    target_width_asof_ts: null,
    current_pool_fit: {},
    pool_normalization_candidates: [],
    shadow_selected_pool_fit: null,
    shadow_verdict: "target_width_missing",
    missing_evidence_reason: null,
    ...extra,
  };
}

function resolvePoolStepFitTarget(candidate = {}, rangePolicy = {}) {
  const decisionTs = firstPresentValue(candidate, [
    "decision_ts",
    "decision_context_ts",
    "screened_at",
    "created_at",
    "ts",
  ]) ?? rangePolicy.decisionTs ?? rangePolicy.decision_ts ?? null;
  const decisionMs = safeTimestampMs(decisionTs);

  const targetFields = [
    ["target_width_pct", "target_width"],
    ["target_downside_pct", "target_downside"],
    ["dynamic_range_target_width_pct", "dynamic_range_target_width"],
    ["pool_width_fit_shadow.target_width_pct", "pool_width_fit_shadow"],
  ];

  for (const [field, label] of targetFields) {
    const targetWidthPct = numberFromCandidate(candidate, [field]);
    if (targetWidthPct == null) continue;
    const targetWidthSource = firstPresentValue(candidate, [
      `${label}_source`,
      "target_width_source",
      "target_downside_source",
      "dynamic_range_target_width_source",
      "pool_width_fit_shadow.target_width_source",
    ]);
    const targetWidthAsofTs = firstPresentValue(candidate, [
      `${label}_asof_ts`,
      "target_width_asof_ts",
      "target_downside_asof_ts",
      "dynamic_range_target_width_asof_ts",
      "pool_width_fit_shadow.target_width_asof_ts",
    ]);
    if (!targetWidthSource) {
      return {
        ok: false,
        targetWidthPct,
        targetWidthSource: null,
        targetWidthAsofTs,
        decisionTs,
        reason: "target_width_source_missing",
      };
    }
    if (isUnsafeTargetWidthSource(targetWidthSource)) {
      return {
        ok: false,
        targetWidthPct,
        targetWidthSource,
        targetWidthAsofTs,
        decisionTs,
        reason: "target_width_source_not_deploy_time_safe",
      };
    }
    const asofMs = safeTimestampMs(targetWidthAsofTs);
    if (asofMs != null && decisionMs != null && asofMs > decisionMs) {
      return {
        ok: false,
        targetWidthPct,
        targetWidthSource,
        targetWidthAsofTs,
        decisionTs,
        reason: "target_width_asof_after_decision",
      };
    }
    return {
      ok: true,
      targetWidthPct,
      targetWidthSource,
      targetWidthAsofTs,
      decisionTs,
      reason: null,
    };
  }

  const policyTarget = finiteNumber(rangePolicy.targetDownsidePct);
  if (policyTarget != null) {
    return {
      ok: true,
      targetWidthPct: policyTarget,
      targetWidthSource: "asof_supplied_or_policy",
      targetWidthAsofTs: rangePolicy.targetWidthAsofTs ?? rangePolicy.target_width_asof_ts ?? null,
      decisionTs,
      reason: null,
    };
  }

  return {
    ok: false,
    targetWidthPct: null,
    targetWidthSource: null,
    targetWidthAsofTs: null,
    decisionTs,
    reason: "target_width_missing",
  };
}

function computeDownsideCoveragePct(requiredBins, binStep) {
  const bins = finiteNumber(requiredBins);
  const step = finiteNumber(binStep);
  if (bins == null || step == null || bins <= 0 || step <= 0) return null;
  const coverage = 1 - (1 + step / 10_000) ** (-bins);
  return roundNumber(coverage * 100, 2);
}

function classifyPoolStepFit(requiredBins) {
  const bins = finiteNumber(requiredBins);
  if (bins == null) return "insufficient_data";
  if (bins >= 60 && bins <= 70) return "ideal_step_fit";
  if (bins <= 80) return "normal_step_fit";
  if (bins <= 100) return "wide_step_fit";
  if (bins <= 120) return "pool_step_mismatch";
  return "wrong_step_too_many_bins";
}

function buildTargetCoverageFlags(requiredBins, binStep, targetWidthPct, maxBins = 69) {
  const bins = finiteNumber(requiredBins);
  const step = finiteNumber(binStep);
  const target = finiteNumber(targetWidthPct);
  const limit = finiteNumber(maxBins);
  if (bins == null || step == null || target == null || limit == null || limit <= 0) {
    return {
      max_bins_limit: limit,
      too_many_bins: false,
      target_truncated: false,
      truncated_bins_below: null,
      truncated_downside_coverage_pct: null,
      target_undercoverage_pct: null,
    };
  }
  const truncated = bins > limit;
  const truncatedBins = truncated ? limit : bins;
  const truncatedCoverage = computeDownsideCoveragePct(truncatedBins, step);
  return {
    max_bins_limit: limit,
    too_many_bins: truncated,
    target_truncated: truncated,
    truncated_bins_below: truncated ? truncatedBins : null,
    truncated_downside_coverage_pct: truncated ? truncatedCoverage : null,
    target_undercoverage_pct: truncated && truncatedCoverage != null
      ? roundNumber(Math.max(0, target - truncatedCoverage), 2)
      : null,
  };
}

function scorePoolStepFit(requiredBins, actualCoveragePct, targetWidthPct, isCurrentPool = false) {
  const bins = finiteNumber(requiredBins);
  if (bins == null) return null;
  const idealCenter = 65;
  const distancePenalty = Math.abs(bins - idealCenter);
  const overCoveragePenalty = Math.max(0, (finiteNumber(actualCoveragePct) ?? 0) - (finiteNumber(targetWidthPct) ?? 0)) * 2;
  const tieBias = isCurrentPool ? 0.01 : 0;
  return roundNumber(Math.max(0, 100 - distancePenalty - overCoveragePenalty + tieBias), 2);
}

function candidateBaseMintValue(poolLike = {}) {
  return poolLike.base?.mint ?? poolLike.base_mint ?? poolLike.mint ?? poolLike.token_mint ?? null;
}

function candidateQuoteMintValue(poolLike = {}) {
  return poolLike.quote?.mint ?? poolLike.quote_mint ?? poolLike.quoteMint ?? null;
}

function candidateQuoteSymbolValue(poolLike = {}) {
  return poolLike.quote?.symbol ?? poolLike.quote_symbol ?? poolLike.quoteSymbol ?? null;
}

const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOURCE_EVIDENCE_KEYS = ["meteora", "okx_discovery", "gmgn"];

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && value !== "").map(String))];
}

function sourceEvidencePoolValue(evidence = {}) {
  return evidence.pool ?? evidence.pool_address ?? evidence.address ?? null;
}

function sourceEvidenceBaseMintValue(evidence = {}) {
  return evidence.base?.mint ?? evidence.base_mint ?? evidence.baseMint ?? evidence.mint ?? evidence.token_mint ?? null;
}

function sourceEvidenceQuoteMintValue(evidence = {}) {
  return evidence.quote?.mint ?? evidence.quote_mint ?? evidence.quoteMint ?? null;
}

function sourceEvidenceQuoteSymbolValue(evidence = {}) {
  return evidence.quote?.symbol ?? evidence.quote_symbol ?? evidence.quoteSymbol ?? null;
}

function compactSourceEvidence(evidence = {}) {
  if (!evidence || typeof evidence !== "object") return null;
  return {
    source: firstNonEmpty(evidence.source, evidence.evidence_source, evidence.discovery_source),
    row_id: firstNonEmpty(evidence.row_id, evidence.evidence_row_id, sourceEvidencePoolValue(evidence)),
    asof_ts: firstNonEmpty(evidence.asof_ts, evidence.evidence_asof_ts, evidence.fetched_at, evidence.updated_at, evidence.observed_at),
    pool: sourceEvidencePoolValue(evidence),
    base_mint: sourceEvidenceBaseMintValue(evidence),
    quote_mint: sourceEvidenceQuoteMintValue(evidence),
    quote_symbol: sourceEvidenceQuoteSymbolValue(evidence),
    active_tvl: numberFromCandidate(evidence, ["active_tvl", "tvl"]),
    fee_active_tvl_ratio: numberFromCandidate(evidence, ["fee_active_tvl_ratio", "fee_tvl_ratio"]),
    volume_window: numberFromCandidate(evidence, ["volume_window", "volume"]),
    bin_step: numberFromCandidate(evidence, ["bin_step", "dlmm_params.bin_step"]),
  };
}

function resolvePoolBoundSourceEvidence(candidate = {}, pool, problems = []) {
  const sourceEvidence = candidate.source_evidence && typeof candidate.source_evidence === "object"
    ? candidate.source_evidence
    : {};
  const preferredSource = firstNonEmpty(candidate.source, candidate.discovery_source, sourceEvidence.source, sourceEvidence.evidence_source);
  const topPool = sourceEvidencePoolValue(sourceEvidence);
  const topMatches = topPool && pool && topPool === pool;
  const topHasEvidence = Boolean(sourceEvidence.source || sourceEvidence.evidence_source || sourceEvidence.row_id || sourceEvidence.evidence_row_id || sourceEvidence.asof_ts || sourceEvidence.evidence_asof_ts);
  if (topHasEvidence && topMatches) {
    return compactSourceEvidence(sourceEvidence);
  }
  if (topHasEvidence && !topPool) problems.push("source_pool_missing");
  if (topPool && pool && topPool !== pool) problems.push("source_pool_mismatch");

  const matches = [];
  for (const key of SOURCE_EVIDENCE_KEYS) {
    const evidence = sourceEvidence[key];
    if (!evidence || typeof evidence !== "object") continue;
    const evidencePool = sourceEvidencePoolValue(evidence);
    if (pool && evidencePool && evidencePool !== pool) continue;
    if (preferredSource && key !== preferredSource && evidence.source !== preferredSource && evidence.evidence_source !== preferredSource) {
      matches.push({ key, evidence, preferred: false });
    } else {
      matches.push({ key, evidence, preferred: true });
    }
  }

  const preferredMatches = matches.filter((entry) => entry.preferred);
  const usable = preferredMatches.length === 1 ? preferredMatches : (matches.length === 1 ? matches : []);
  if (usable.length === 1) return compactSourceEvidence(usable[0].evidence);
  if (matches.length > 1) return compactSourceEvidence(matches[0].evidence);
  return null;
}

function normalizeAlternativeEvidence(alternative = {}, currentBaseMint = null, currentQuoteMint = null) {
  const problems = [];
  const pool = alternative.pool ?? alternative.pool_address ?? alternative.address ?? null;
  const baseMint = sourceEvidenceBaseMintValue(alternative);
  const quoteMint = sourceEvidenceQuoteMintValue(alternative);
  if (currentBaseMint && baseMint && baseMint !== currentBaseMint) problems.push("alternative_base_mint_mismatch");
  if (currentQuoteMint && quoteMint && quoteMint !== currentQuoteMint) problems.push("alternative_quote_mint_mismatch");
  if (alternative.source_evidence && sourceEvidencePoolValue(alternative.source_evidence) && sourceEvidencePoolValue(alternative.source_evidence) !== pool) {
    problems.push("alternative_evidence_pool_mismatch");
  }
  return {
    ...alternative,
    pool,
    poolName: alternative.poolName ?? alternative.name ?? null,
    baseMint,
    base_mint: baseMint,
    quoteMint,
    quote_mint: quoteMint,
    baseSymbol: alternative.base?.symbol ?? alternative.base_symbol ?? alternative.baseSymbol ?? null,
    base_symbol: alternative.base?.symbol ?? alternative.base_symbol ?? alternative.baseSymbol ?? null,
    quoteSymbol: sourceEvidenceQuoteSymbolValue(alternative),
    quote_symbol: sourceEvidenceQuoteSymbolValue(alternative),
    source_evidence: {
      ...(alternative.source_evidence || {}),
      evidence_problems: [
        ...new Set([
          ...((alternative.source_evidence?.evidence_problems || alternative.evidence_problems || [])),
          ...problems,
        ]),
      ],
    },
    evidence_problems: [
      ...new Set([
        ...((alternative.evidence_problems || [])),
        ...problems,
      ]),
    ],
  };
}

export function normalizeCandidateEvidenceForDeploy(candidate = {}, {
  decisionTs = null,
  sourceStage = "candidate",
} = {}) {
  if (!candidate || typeof candidate !== "object") return candidate;
  const problems = [];
  const pool = candidate.pool ?? candidate.pool_address ?? candidate.address ?? null;
  const baseValues = uniqueStrings([
    candidate.base?.mint,
    candidate.base_mint,
    candidate.baseMint,
    candidate.mint,
    candidate.token_mint,
    candidate.token_x?.address,
    candidate.token_x_mint,
  ]);
  const quoteValues = uniqueStrings([
    candidate.quote?.mint,
    candidate.quote_mint,
    candidate.quoteMint,
    candidate.token_y?.address,
    candidate.token_y_mint,
  ]);
  const candidateBaseMint = baseValues.length === 1 ? baseValues[0] : null;
  const candidateQuoteMint = quoteValues.length === 1 ? quoteValues[0] : null;
  const poolBoundEvidence = resolvePoolBoundSourceEvidence(candidate, pool, problems);
  if (poolBoundEvidence?.base_mint && candidateBaseMint && poolBoundEvidence.base_mint !== candidateBaseMint) problems.push("source_base_mint_mismatch");
  if (poolBoundEvidence?.quote_mint && candidateQuoteMint && poolBoundEvidence.quote_mint !== candidateQuoteMint) problems.push("source_quote_mint_mismatch");
  if (poolBoundEvidence?.base_mint) baseValues.push(String(poolBoundEvidence.base_mint));
  if (poolBoundEvidence?.quote_mint) quoteValues.push(String(poolBoundEvidence.quote_mint));
  const uniqueBaseValues = [...new Set(baseValues)];
  const uniqueQuoteValues = [...new Set(quoteValues)];
  if (uniqueBaseValues.length > 1) problems.push("base_mint_conflict");
  if (uniqueQuoteValues.length > 1) problems.push("quote_mint_conflict");
  const baseMint = uniqueBaseValues.length === 1 ? uniqueBaseValues[0] : null;
  const quoteMint = uniqueQuoteValues.length === 1 ? uniqueQuoteValues[0] : null;
  if (poolBoundEvidence?.pool && pool && poolBoundEvidence.pool !== pool) problems.push("source_pool_mismatch");

  const quoteSymbol = firstNonEmpty(
    candidate.quote?.symbol,
    candidate.quote_symbol,
    candidate.quoteSymbol,
    candidate.token_y?.symbol,
    poolBoundEvidence?.quote_symbol,
  );
  const baseSymbol = firstNonEmpty(candidate.base?.symbol, candidate.base_symbol, candidate.baseSymbol, candidate.token_x?.symbol);
  const evidenceSource = firstNonEmpty(poolBoundEvidence?.source, candidate.source, candidate.discovery_source);
  const evidenceRowId = firstNonEmpty(poolBoundEvidence?.row_id, candidate.evidence_row_id, candidate.row_id);
  const evidenceAsofTs = firstNonEmpty(poolBoundEvidence?.asof_ts, candidate.evidence_asof_ts, candidate.asof_ts, candidate.fetched_at, candidate.updated_at, candidate.observed_at);
  const sameMintAlternatives = Array.isArray(candidate.source_evidence?.same_mint_alternatives)
    ? candidate.source_evidence.same_mint_alternatives.map((alternative) => normalizeAlternativeEvidence(alternative, baseMint, quoteMint))
    : [];

  return {
    ...candidate,
    pool,
    poolName: candidate.poolName ?? candidate.name ?? candidate.pool_name ?? null,
    baseMint,
    base_mint: baseMint,
    quoteMint,
    quote_mint: quoteMint,
    baseSymbol,
    base_symbol: baseSymbol,
    quoteSymbol,
    quote_symbol: quoteSymbol,
    bin_step: numberFromCandidate(candidate, ["bin_step", "dlmm_params.bin_step"]),
    active_tvl: numberFromCandidate(candidate, ["active_tvl", "tvl"]),
    fee_active_tvl_ratio: numberFromCandidate(candidate, ["fee_active_tvl_ratio", "fee_tvl_ratio"]),
    volume_window: numberFromCandidate(candidate, ["volume_window", "volume"]),
    evidence_problems: [...new Set([...(candidate.evidence_problems || []), ...problems])],
    source_evidence: {
      ...(candidate.source_evidence || {}),
      source: evidenceSource,
      evidence_source: evidenceSource,
      row_id: evidenceRowId,
      evidence_row_id: evidenceRowId,
      asof_ts: evidenceAsofTs,
      evidence_asof_ts: evidenceAsofTs,
      pool,
      base_mint: baseMint,
      quote_mint: quoteMint,
      quote_symbol: quoteSymbol,
      normalization_stage: sourceStage,
      normalization_decision_ts: decisionTs,
      evidence_problems: [...new Set([...(candidate.source_evidence?.evidence_problems || []), ...problems])],
      same_mint_alternatives: sameMintAlternatives,
    },
  };
}

function buildPoolWidthFitEntry(poolLike = {}, {
  targetWidthPct,
  currentBaseMint = null,
  currentQuoteMint = null,
  currentQuoteSymbol = null,
  isCurrentPool = false,
  decisionTs = null,
} = {}) {
  const pool = poolLike.pool ?? poolLike.pool_address ?? poolLike.address ?? null;
  const baseMint = candidateBaseMintValue(poolLike);
  const quoteMint = candidateQuoteMintValue(poolLike);
  const quoteSymbol = candidateQuoteSymbolValue(poolLike);
  const binStep = numberFromCandidate(poolLike, ["bin_step", "dlmm_params.bin_step"]);
  const activeTvl = numberFromCandidate(poolLike, ["active_tvl", "tvl"]);
  const feeMetric = numberFromCandidate(poolLike, ["fee_active_tvl_ratio", "fee_tvl_ratio", "fee_window", "fee", "fee_usd", "volume_window", "volume"]);
  const evidenceAsofTs = firstPresentValue(poolLike, [
    "evidence_asof_ts",
    "source_evidence.asof_ts",
    "source_evidence.meteora.evidence_asof_ts",
    "source_evidence.gmgn.evidence_asof_ts",
    "source_evidence.okx_discovery.evidence_asof_ts",
    "asof_ts",
    "updated_at",
    "fetched_at",
    "observed_at",
  ]) ?? (isCurrentPool ? decisionTs : null);
  const evidenceRow = firstPresentValue(poolLike, [
    "evidence_row_id",
    "source_evidence.row_id",
    "source_evidence.meteora.evidence_row_id",
    "source_evidence.gmgn.evidence_row_id",
    "source_evidence.okx_discovery.evidence_row_id",
    "row_id",
  ]);
  const evidenceSource = firstPresentValue(poolLike, [
    "evidence_source",
    "source_evidence.source",
    "source_evidence.meteora.evidence_source",
    "source_evidence.gmgn.evidence_source",
    "source_evidence.okx_discovery.evidence_source",
    "source",
  ]);
  const explicitEvidenceStatus = firstPresentValue(poolLike, [
    "evidence_status",
    "source_evidence.evidence_status",
    "source_evidence.status",
    "status",
  ]);
  const evidenceAsofMs = safeTimestampMs(evidenceAsofTs);
  const decisionMs = safeTimestampMs(decisionTs);
  const solMint = "So11111111111111111111111111111111111111112";
  const hasOwnSolQuote = String(quoteSymbol || "").toUpperCase() === "SOL" ||
    (quoteMint && (quoteMint === currentQuoteMint || quoteMint === solMint));
  const evidenceProblems = [];

  if (!pool) evidenceProblems.push("missing_pool");
  if (!baseMint) evidenceProblems.push("missing_base_mint");
  if (currentBaseMint && baseMint && baseMint !== currentBaseMint) evidenceProblems.push("base_mint_mismatch");
  if (!isCurrentPool && !currentBaseMint) evidenceProblems.push("missing_current_base_mint");
  if (currentQuoteMint && quoteMint && quoteMint !== currentQuoteMint) evidenceProblems.push("quote_mint_mismatch");
  if (!hasOwnSolQuote) {
    evidenceProblems.push("missing_sol_quote_evidence");
  }
  if (binStep == null || binStep <= 0) evidenceProblems.push("missing_valid_bin_step");
  if (activeTvl == null || activeTvl <= 0) evidenceProblems.push("missing_active_tvl");
  if (feeMetric == null) evidenceProblems.push("missing_fee_or_volume_metric");
  if (!evidenceAsofTs) evidenceProblems.push("missing_evidence_asof_ts");
  if (evidenceAsofMs != null && decisionMs != null && evidenceAsofMs > decisionMs) evidenceProblems.push("evidence_asof_after_decision");
  if (String(explicitEvidenceStatus || "").toLowerCase() === "stale" || poolLike.stale === true || poolLike.evidence_stale === true) {
    evidenceProblems.push("stale_evidence");
  }
  if (isUnsafeTargetWidthSource(evidenceSource)) evidenceProblems.push("pool_evidence_source_not_deploy_time_safe");
  if (!evidenceRow) evidenceProblems.push("missing_source_evidence");
  for (const problem of [
    ...(Array.isArray(poolLike.evidence_problems) ? poolLike.evidence_problems : []),
    ...(Array.isArray(poolLike.source_evidence?.evidence_problems) ? poolLike.source_evidence.evidence_problems : []),
  ]) {
    if (problem && !evidenceProblems.includes(problem)) evidenceProblems.push(problem);
  }

  const requiredBins = evidenceProblems.length === 0 ? computeDownsideBinsForPct(targetWidthPct, binStep) : null;
  const actualCoveragePct = requiredBins != null ? computeDownsideCoveragePct(requiredBins, binStep) : null;
  const poolStepStatus = evidenceProblems.length === 0 ? classifyPoolStepFit(requiredBins) : "insufficient_data";
  const coverageFlags = evidenceProblems.length === 0
    ? buildTargetCoverageFlags(requiredBins, binStep, targetWidthPct)
    : buildTargetCoverageFlags(null, binStep, targetWidthPct);
  const recommendableShadow = evidenceProblems.length === 0 && requiredBins != null && requiredBins <= 100 && actualCoveragePct >= targetWidthPct;

  return {
    pool,
    is_current_pool: isCurrentPool,
    base_mint: baseMint,
    bin_step: binStep,
    target_width_pct: roundNumber(targetWidthPct, 2),
    required_bins: requiredBins,
    actual_downside_coverage_pct: actualCoveragePct,
    ...coverageFlags,
    pool_step_status: poolStepStatus,
    recommendable_shadow: recommendableShadow,
    step_fit_score: recommendableShadow ? scorePoolStepFit(requiredBins, actualCoveragePct, targetWidthPct, isCurrentPool) : null,
    evidence_asof_ts: evidenceAsofTs,
    evidence_status: evidenceProblems.length === 0 ? "ok" : "insufficient_data",
    evidence_problems: evidenceProblems,
  };
}

function buildRangeFeasibilityShadow(candidate = {}, { rangePolicy = {} } = {}) {
  const target = resolvePoolStepFitTarget(candidate, rangePolicy);
  if (!target.ok) {
    return buildBaseRangeFeasibilityShadow({
      target_width_pct: target.targetWidthPct != null ? roundNumber(target.targetWidthPct, 2) : null,
      target_width_source: target.targetWidthSource,
      target_width_asof_ts: target.targetWidthAsofTs,
      shadow_verdict: target.reason === "target_width_missing" ? "target_width_missing" : "insufficient_data",
      missing_evidence_reason: target.reason,
    });
  }

  const currentBaseMint = candidateBaseMintValue(candidate);
  const currentQuoteMint = candidateQuoteMintValue(candidate);
  const currentQuoteSymbol = candidateQuoteSymbolValue(candidate);
  const currentPoolFit = buildPoolWidthFitEntry(candidate, {
    targetWidthPct: target.targetWidthPct,
    currentBaseMint,
    currentQuoteMint,
    currentQuoteSymbol,
    isCurrentPool: true,
    decisionTs: target.decisionTs,
  });
  const alternatives = Array.isArray(candidate?.source_evidence?.same_mint_alternatives)
    ? candidate.source_evidence.same_mint_alternatives
    : [];
  const alternativeFits = alternatives.map((alternative) => buildPoolWidthFitEntry(alternative, {
    targetWidthPct: target.targetWidthPct,
    currentBaseMint,
    currentQuoteMint,
    currentQuoteSymbol,
    isCurrentPool: false,
    decisionTs: target.decisionTs,
  }));
  const poolNormalizationCandidates = [currentPoolFit, ...alternativeFits];
  const recommendable = poolNormalizationCandidates
    .filter((entry) => entry.recommendable_shadow)
    .sort((a, b) => {
      const scoreDelta = (b.step_fit_score ?? 0) - (a.step_fit_score ?? 0);
      if (scoreDelta !== 0) return scoreDelta;
      return Number(b.is_current_pool) - Number(a.is_current_pool);
    });
  const selected = recommendable[0] ?? null;
  const hasInsufficient = poolNormalizationCandidates.some((entry) => entry.evidence_status !== "ok");
  const hasWrongStep = poolNormalizationCandidates.some((entry) => entry.pool_step_status === "wrong_step_too_many_bins");
  const hasOkPool = poolNormalizationCandidates.some((entry) => entry.evidence_status === "ok");
  let verdict = "no_eligible_pool";
  if (selected?.is_current_pool) verdict = "current_pool_fit";
  else if (selected) verdict = "alternative_pool_fit";
  else if (!hasOkPool && hasInsufficient) verdict = "insufficient_data";
  else if (hasWrongStep) verdict = "wrong_step_skip";

  return buildBaseRangeFeasibilityShadow({
    target_width_pct: roundNumber(target.targetWidthPct, 2),
    target_width_source: target.targetWidthSource,
    target_width_asof_ts: target.targetWidthAsofTs,
    current_pool_fit: currentPoolFit,
    pool_normalization_candidates: poolNormalizationCandidates,
    shadow_selected_pool_fit: selected
      ? { ...selected, shadow_only: true, applied_to_deploy_args: false }
      : null,
    shadow_verdict: verdict,
    missing_evidence_reason: null,
  });
}

export function resolveDynamicRangeLiveDeployArgs({
  candidate = {},
  dynamicRangeShadow = null,
  fallbackPool = null,
  fallbackBinsBelow = null,
  fallbackBinStep = null,
  adaptiveWidthMode = null,
} = {}) {
  const mode = normalizeAdaptiveWidthMode(adaptiveWidthMode ?? dynamicRangeShadow?.adaptive_width_mode ?? candidate.adaptive_width_mode);
  const rangeFeasibility = dynamicRangeShadow?.range_feasibility_shadow ?? null;
  const selected = rangeFeasibility?.shadow_selected_pool_fit ?? null;
  const requiredBins = finiteNumber(selected?.required_bins);
  const selectedPool = selected?.pool ?? null;
  const selectedBinStep = finiteNumber(selected?.bin_step);
  const fallbackPoolAddress = fallbackPool ?? candidate.pool ?? null;
  const fallbackStep = fallbackBinStep ?? numberFromCandidate(candidate, ["bin_step", "dlmm_params.bin_step"]);
  const adaptiveInputStatus = dynamicRangeShadow?.adaptive_input_status ?? "insufficient_data";
  const adaptiveInputProblems = Array.isArray(dynamicRangeShadow?.adaptive_input_problems)
    ? dynamicRangeShadow.adaptive_input_problems
    : ["missing_adaptive_input_status"];
  const evidenceStatus = selected?.evidence_status ?? rangeFeasibility?.current_pool_fit?.evidence_status ?? "insufficient_data";
  const evidenceProblems = [
    ...(Array.isArray(selected?.evidence_problems) ? selected.evidence_problems : []),
    ...(Array.isArray(rangeFeasibility?.current_pool_fit?.evidence_problems) ? rangeFeasibility.current_pool_fit.evidence_problems : []),
  ];
  const eligibilityProblems = [];
  if (mode !== "live_current_pool") addUniqueProblem(eligibilityProblems, `adaptive_width_mode_${mode}`);
  if (rangeFeasibility?.source !== "dynamic_range_shadow_swing_envelope_bidask_v2a") addUniqueProblem(eligibilityProblems, "missing_range_feasibility_shadow");
  if (selected?.is_current_pool !== true) {
    addUniqueProblem(eligibilityProblems, selected ? "same_mint_alternative_shadow_only" : "missing_current_pool_fit_selection");
  }
  if (selected?.recommendable_shadow !== true) addUniqueProblem(eligibilityProblems, "selected_fit_not_recommendable");
  if (evidenceStatus !== "ok") addUniqueProblem(eligibilityProblems, "current_pool_fit_evidence_not_ok");
  if (adaptiveInputStatus !== "ok") addUniqueProblem(eligibilityProblems, "adaptive_input_status_not_ok");
  if (!selectedPool || selectedPool !== fallbackPoolAddress) addUniqueProblem(eligibilityProblems, "selected_pool_must_match_fallback_pool");
  if (requiredBins == null || requiredBins <= 0) addUniqueProblem(eligibilityProblems, "missing_required_bins");
  if (requiredBins != null && requiredBins > 100) addUniqueProblem(eligibilityProblems, "required_bins_gt_100");
  if (selected?.target_truncated === true || selected?.too_many_bins === true) addUniqueProblem(eligibilityProblems, "target_width_truncated");
  if (dynamicRangeShadow?.oversize_deploy_share === true) addUniqueProblem(eligibilityProblems, "oversize_deploy_share_requires_size_policy");
  for (const problem of evidenceProblems) addUniqueProblem(eligibilityProblems, problem);
  for (const problem of adaptiveInputProblems) addUniqueProblem(eligibilityProblems, problem);

  const canApply = mode === "live_current_pool" && eligibilityProblems.length === 0;

  if (!canApply) {
    return {
      enabled: mode === "live_current_pool",
      adaptive_width_mode: mode,
      applied_to_deploy_args: false,
      reason: mode !== "live_current_pool"
        ? `adaptive_width_${mode}_mode_fallback`
        : (dynamicRangeShadow?.oversize_deploy_share === true
          ? "oversize_deploy_share_requires_size_policy"
          : (selected && selected?.is_current_pool !== true
            ? "alternative_pool_switch_deferred"
            : (selected ? "selected_fit_not_live_eligible" : (rangeFeasibility?.shadow_verdict ?? "missing_range_feasibility_shadow")))),
      pool_address: fallbackPoolAddress,
      bins_below: fallbackBinsBelow,
      bin_step: fallbackStep,
      evidence_status: evidenceStatus,
      evidence_problems: [...new Set(evidenceProblems)],
      adaptive_input_status: adaptiveInputStatus,
      adaptive_input_problems: adaptiveInputProblems,
      eligibility_problems: eligibilityProblems,
      selected_pool_fit: selected ?? null,
    };
  }

  return {
    enabled: true,
    adaptive_width_mode: mode,
    applied_to_deploy_args: true,
    reason: "current_pool_fit_applied",
    pool_address: fallbackPoolAddress ?? selectedPool,
    bins_below: Math.round(requiredBins),
    bin_step: selectedBinStep ?? fallbackStep,
    evidence_status: evidenceStatus,
    evidence_problems: [...new Set(evidenceProblems)],
    adaptive_input_status: adaptiveInputStatus,
    adaptive_input_problems: adaptiveInputProblems,
    eligibility_problems: [],
    selected_pool_fit: selected,
  };
}

export function buildDynamicRangeShadowTelemetry(candidate = {}, {
  deployAmountSol = null,
  assumedDeployUsd = null,
  solUsd = null,
  rangePolicy = {},
  currentRange = {},
  adaptiveWidthMode = null,
} = {}) {
  const mode = normalizeAdaptiveWidthMode(adaptiveWidthMode ?? rangePolicy.adaptiveWidthMode ?? rangePolicy.adaptive_width_mode);
  const mcap = numberFromCandidate(candidate, ["mcap", "token_info.mcap"]);
  const activeTvl = numberFromCandidate(candidate, ["active_tvl", "tvl"]);
  const binStep = numberFromCandidate(candidate, ["bin_step", "dlmm_params.bin_step"]);
  const volatility = numberFromCandidate(candidate, ["volatility"]);
  const priceChangePct = numberFromCandidate(candidate, ["price_change_pct", "change_1h", "stats_1h.price_change", "token_info.stats_1h.price_change"]);
  const organicScore = numberFromCandidate(candidate, ["organic_score", "base.organic", "token_x.organic_score"]);
  const feeActiveTvlRatio = numberFromCandidate(candidate, ["fee_active_tvl_ratio", "fee_tvl_ratio"]);
  const deploySol = finiteNumber(deployAmountSol);
  const deployUsd = finiteNumber(assumedDeployUsd) ?? (
    deploySol != null && finiteNumber(solUsd) != null ? deploySol * finiteNumber(solUsd) : null
  );
  const candidateDeployShare = numberFromCandidate(candidate, [
    "deploy_share_of_active_tvl_pct",
    "dynamic_entry_shadow.deploy_share_of_active_tvl_pct",
    "momentum_score.primary.dynamic_entry_shadow.deploy_share_of_active_tvl_pct",
  ]);
  const deployShareOfActiveTvlPct = candidateDeployShare != null ? roundNumber(candidateDeployShare, 4) : (
    deployUsd != null &&
    activeTvl != null &&
    activeTvl > 0
  ) ? roundNumber((deployUsd / activeTvl) * 100, 4) : null;
  const adaptiveInput = buildAdaptiveInputStatus({
    mcap,
    priceChangePct,
    volatility,
    deployUsd,
    deployShareOfActiveTvlPct,
  });
  const currentBinsBelow = finiteNumber(currentRange.binsBelow ?? currentRange.bins_below ?? rangePolicy.binsBelowDefault);
  const currentDownsidePct = finiteNumber(currentRange.targetDownsidePct ?? currentRange.target_downside_pct ?? rangePolicy.targetDownsidePct);

  let targetDownsidePct = 15;
  const drivers = [];

  if (mcap != null) {
    if (mcap < 100_000) {
      targetDownsidePct += 8;
      drivers.push("nanocap_mcap_lt_100k:+8");
    } else if (mcap < 300_000) {
      targetDownsidePct += 4;
      drivers.push("low_mcap_lt_300k:+4");
    } else if (mcap > 2_000_000) {
      targetDownsidePct -= 2;
      drivers.push("larger_mcap_gt_2m:-2");
    }
  }

  if (activeTvl != null) {
    if (activeTvl < 5_000) {
      targetDownsidePct += 6;
      drivers.push("thin_active_tvl_lt_5k:+6");
    } else if (activeTvl < 15_000) {
      targetDownsidePct += 3;
      drivers.push("thin_active_tvl_lt_15k:+3");
    } else if (activeTvl > 100_000) {
      targetDownsidePct -= 2;
      drivers.push("deep_active_tvl_gt_100k:-2");
    }
  }

  if (deployShareOfActiveTvlPct != null) {
    if (deployShareOfActiveTvlPct > 5) {
      targetDownsidePct += 8;
      drivers.push("deploy_share_gt_5pct:+8");
    } else if (deployShareOfActiveTvlPct > 4) {
      targetDownsidePct += 6;
      drivers.push("deploy_share_gt_4pct:+6");
    } else if (deployShareOfActiveTvlPct > 2) {
      targetDownsidePct += 4;
      drivers.push("deploy_share_gt_2pct:+4");
    } else if (deployShareOfActiveTvlPct < 0.5) {
      targetDownsidePct -= 1;
      drivers.push("deploy_share_lt_0_5pct:-1");
    }
  }

  if (volatility != null) {
    if (volatility > 8) {
      targetDownsidePct += 8;
      drivers.push("volatility_gt_8:+8");
    } else if (volatility > 5) {
      targetDownsidePct += 4;
      drivers.push("volatility_gt_5:+4");
    } else if (volatility < 2) {
      targetDownsidePct -= 2;
      drivers.push("volatility_lt_2:-2");
    }
  }

  if (priceChangePct != null) {
    if (priceChangePct > 50) {
      targetDownsidePct += 8;
      drivers.push("pump_drawdown_risk_gt_50pct:+8");
    } else if (priceChangePct > 25) {
      targetDownsidePct += 4;
      drivers.push("pump_drawdown_risk_gt_25pct:+4");
    } else if (priceChangePct < -35) {
      targetDownsidePct += 4;
      drivers.push("deep_drawdown_lt_-35pct:+4");
    } else if (priceChangePct < -15) {
      targetDownsidePct += 2;
      drivers.push("drawdown_lt_-15pct:+2");
    }
  }

  if (organicScore != null) {
    if (organicScore >= 80) {
      targetDownsidePct -= 3;
      drivers.push("high_quality_organic_gte_80:-3");
    } else if (organicScore < 50) {
      targetDownsidePct += 4;
      drivers.push("low_quality_organic_lt_50:+4");
    }
  }

  if (feeActiveTvlRatio != null) {
    if (feeActiveTvlRatio >= 0.2) {
      targetDownsidePct -= 1;
      drivers.push("strong_fee_tvl_gte_0_2:-1");
    } else if (feeActiveTvlRatio < 0.08) {
      targetDownsidePct += 2;
      drivers.push("weak_fee_tvl_lt_0_08:+2");
    }
  }

  const proposedTargetDownsidePct = clampNumber(targetDownsidePct, 5, 45);
  const proposedBinsBelow = computeDownsideBinsForPct(proposedTargetDownsidePct, binStep);
  const policyViolations = compareRangePolicyViolation(proposedBinsBelow, proposedTargetDownsidePct, rangePolicy);
  const rangeFeasibilityShadow = buildRangeFeasibilityShadow(candidate, { rangePolicy });
  const oversizeDeployShare = deployShareOfActiveTvlPct != null && deployShareOfActiveTvlPct > 5;

  return {
    shadow_only: true,
    source: "dynamic_range_shadow_v1",
    adaptive_width_mode: mode,
    live_apply_eligible: false,
    proposed_target_downside_pct: roundNumber(proposedTargetDownsidePct, 2),
    proposed_bins_below: proposedBinsBelow,
    bin_step: binStep,
    deploy_amount_sol: deploySol,
    assumed_deploy_usd: deployUsd != null ? roundNumber(deployUsd, 4) : null,
    deploy_share_of_active_tvl_pct: deployShareOfActiveTvlPct,
    oversize_deploy_share: oversizeDeployShare,
    oversize_deploy_share_requires_size_policy: oversizeDeployShare,
    adaptive_input_status: adaptiveInput.status,
    adaptive_input_problems: adaptiveInput.problems,
    inputs: {
      mcap,
      active_tvl: activeTvl,
      volatility,
      price_change_pct: priceChangePct,
      organic_score: organicScore,
      fee_active_tvl_ratio: feeActiveTvlRatio,
    },
    current_strategy_range: {
      strategy_id: rangePolicy.strategyId ?? null,
      strategy_name: rangePolicy.strategyName ?? null,
      target_downside_pct: currentDownsidePct,
      bins_below: currentBinsBelow,
      bins_above: rangePolicy.binsAbove ?? null,
      target_downside_min_pct: rangePolicy.targetDownsideMinPct ?? null,
      target_downside_max_pct: rangePolicy.targetDownsideMaxPct ?? null,
      bins_below_min: rangePolicy.binsBelowMin ?? null,
      bins_below_max: rangePolicy.binsBelowMax ?? null,
    },
    delta_vs_current: {
      target_downside_pct: proposedTargetDownsidePct != null && currentDownsidePct != null
        ? roundNumber(proposedTargetDownsidePct - currentDownsidePct, 2)
        : null,
      bins_below: proposedBinsBelow != null && currentBinsBelow != null
        ? proposedBinsBelow - currentBinsBelow
        : null,
    },
    policy_violation: policyViolations.length > 0,
    policy_violations: policyViolations,
    applied_to_deploy_args: false,
    range_feasibility_shadow: rangeFeasibilityShadow,
    drivers,
    note: "shadow_only — proposed dynamic range is logged for calibration only; strategy-library policy remains authoritative",
  };
}

function load() {
  if (!fs.existsSync(STRATEGY_FILE)) return { active: null, strategies: {} };
  try {
    return JSON.parse(fs.readFileSync(STRATEGY_FILE, "utf8"));
  } catch {
    return { active: null, strategies: {} };
  }
}

function save(data) {
  fs.writeFileSync(STRATEGY_FILE, JSON.stringify(data, null, 2));
}

// ─── Tool Handlers ─────────────────────────────────────────────

/**
 * Add or update a strategy.
 * The agent parses the raw tweet/text and fills in the structured fields.
 */
export function addStrategy({
  id,
  name,
  author = "unknown",
  lp_strategy = "bid_ask",       // "bid_ask" | "spot" | "curve"
  token_criteria = {},           // { min_mcap, min_age_days, requires_kol, notes }
  entry = {},                    // { condition, price_change_threshold_pct, single_side }
  range = {},                    // { type, bins_below_pct, notes }
  exit = {},                     // { take_profit_pct, notes }
  best_for = "",                 // short description of ideal conditions
  raw = "",                      // original tweet/text
}) {
  if (!id || !name) return { error: "id and name are required" };

  const db = load();

  // Slugify id
  const slug = id.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");

  db.strategies[slug] = {
    id: slug,
    name,
    author,
    lp_strategy,
    token_criteria,
    entry,
    range,
    exit,
    best_for,
    raw,
    added_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Auto-set as active if it's the first strategy
  if (!db.active) db.active = slug;

  save(db);
  log("strategy", `Strategy saved: ${name} (${slug})`);
  return { saved: true, id: slug, name, active: db.active === slug };
}

/**
 * List all strategies with a summary.
 */
export function listStrategies() {
  const db = load();
  const strategies = Object.values(db.strategies).map((s) => ({
    id: s.id,
    name: s.name,
    author: s.author,
    lp_strategy: s.lp_strategy,
    best_for: s.best_for,
    active: db.active === s.id,
    added_at: s.added_at?.slice(0, 10),
  }));
  return { active: db.active, count: strategies.length, strategies };
}

/**
 * Get full details of a strategy including raw text and all criteria.
 */
export function getStrategy({ id }) {
  if (!id) return { error: "id required" };
  const db = load();
  const strategy = db.strategies[id];
  if (!strategy) return { error: `Strategy "${id}" not found`, available: Object.keys(db.strategies) };
  return { ...strategy, is_active: db.active === id };
}

/**
 * Set the active strategy used during screening cycles.
 */
export function setActiveStrategy({ id }) {
  if (!id) return { error: "id required" };
  const db = load();
  if (!db.strategies[id]) return { error: `Strategy "${id}" not found`, available: Object.keys(db.strategies) };
  db.active = id;
  save(db);
  log("strategy", `Active strategy set to: ${db.strategies[id].name}`);
  return { active: id, name: db.strategies[id].name };
}

/**
 * Remove a strategy.
 */
export function removeStrategy({ id }) {
  if (!id) return { error: "id required" };
  const db = load();
  if (!db.strategies[id]) return { error: `Strategy "${id}" not found` };
  const name = db.strategies[id].name;
  delete db.strategies[id];
  if (db.active === id) db.active = Object.keys(db.strategies)[0] || null;
  save(db);
  log("strategy", `Strategy removed: ${name}`);
  return { removed: true, id, name, new_active: db.active };
}

/**
 * Get the currently active strategy — used by screening cycle.
 */
export function getActiveStrategy() {
  const db = load();
  if (!db.active || !db.strategies[db.active]) return null;
  return db.strategies[db.active];
}

export function resolveStrategyRangePolicy(strategy = null, runtimeConfig = {}) {
  const range = strategy?.range ?? {};
  // Compute targetDownsidePct first — if set, it takes precedence over fixed bins
  const targetDownsidePct = finiteNumber(range.target_downside_pct) ?? finiteNumber(runtimeConfig?.strategy?.targetDownsidePct);
  const targetDownsideMinPct = finiteNumber(range.target_downside_min_pct) ?? finiteNumber(runtimeConfig?.strategy?.targetDownsideMinPct);
  const targetDownsideMaxPct = finiteNumber(range.target_downside_max_pct) ?? finiteNumber(runtimeConfig?.strategy?.targetDownsideMaxPct);
  // When targetDownsidePct is set and range has no explicit bins_below, do NOT fall through to config default.
  // The bins will be computed per-pool from bin_step at deploy time.
  const binsBelowDefault = finiteNumber(range.bins_below) ?? (targetDownsidePct != null ? null : finiteNumber(runtimeConfig?.strategy?.binsBelow));
  const binsBelowMin = finiteNumber(range.bins_below_min) ?? null;
  const binsBelowMax = finiteNumber(range.bins_below_max) ?? null;
  const binsAbove = finiteNumber(range.bins_above);
  const lpStrategy = strategy?.lp_strategy || runtimeConfig?.strategy?.strategy || "bid_ask";
  const singleSide = String(strategy?.entry?.single_side || range.single_side || "").toLowerCase();
  const singleSidedSol = singleSide === "sol" || range.single_sided_sol === true;

  return {
    strategyId: strategy?.id ?? null,
    strategyName: strategy?.name ?? null,
    lpStrategy,
    singleSidedSol,
    binsBelowDefault,
    binsBelowMin,
    binsBelowMax,
    binsAbove: binsAbove ?? null,
    targetDownsidePct,
    targetDownsideMinPct,
    targetDownsideMaxPct,
    hasExplicitRangePolicy: binsBelowDefault != null || binsBelowMin != null || binsBelowMax != null || binsAbove != null || targetDownsidePct != null,
  };
}

export function resolveActiveStrategyRangePolicy(runtimeConfig = {}) {
  return resolveStrategyRangePolicy(getActiveStrategy(), runtimeConfig);
}

export function describeRangePolicyForPrompt(policy = {}) {
  if (!policy?.hasExplicitRangePolicy) {
    return "Use the active strategy and runtime config range policy. If no range is configured, use the deploy tool defaults and safety guards.";
  }
  const parts = [];
  if (policy.lpStrategy) parts.push(`strategy=${policy.lpStrategy}`);
  if (policy.singleSidedSol) parts.push("single-sided SOL");
  if (policy.binsBelowDefault != null && policy.targetDownsidePct == null) {
    parts.push(`default bins_below=${policy.binsBelowDefault}`);
  } else if (policy.targetDownsidePct != null && policy.binsBelowDefault == null) {
    parts.push(`compute bins_below from target_downside and pool bin_step (do NOT use a fixed bins_below number)`);
  }
  if (policy.binsBelowMin != null || policy.binsBelowMax != null) {
    parts.push(`bins_below bounds=[${policy.binsBelowMin ?? "none"}, ${policy.binsBelowMax ?? "none"}]`);
  }
  if (policy.targetDownsidePct != null) {
    const targetRange = policy.targetDownsideMinPct != null || policy.targetDownsideMaxPct != null
      ? ` range=[${policy.targetDownsideMinPct ?? "none"}, ${policy.targetDownsideMaxPct ?? "none"}]%`
      : "";
    parts.push(`target_downside=${policy.targetDownsidePct}%${targetRange}`);
  }
  if (policy.binsAbove != null) parts.push(`bins_above=${policy.binsAbove}`);
  return parts.join("; ");
}

export function buildFeeVelocityShadowRows(candidate = {}, screeningConfig = {}, rangePolicy = {}) {
  const binStep = numberFromCandidate(candidate, ["bin_step", "dlmm_params.bin_step"]);
  const volumeActiveTvlMultiple = computeVolumeActiveTvlMultiple(candidate);
  const feeVelocityUsdPerMin = estimateFeeVelocityUsdPerMin(candidate, screeningConfig);
  const downsideVariants = finiteNumberArray(screeningConfig.feeVelocityShadowDownsidePct, [7, 10, 12, 15, 20, 25])
    .map((downsidePct) => ({
      hypothesis: downsidePct <= 12 ? "H1" : "H3",
      downside_pct: downsidePct,
      bins_below: computeDownsideBinsForPct(downsidePct, binStep),
      bin_step: binStep,
    }));
  const takeProfitVariants = finiteNumberArray(screeningConfig.feeVelocityShadowTakeProfitPct, [6, 7, 8])
    .map((takeProfitPct) => ({
      hypothesis: "H3",
      take_profit_pct: takeProfitPct,
    }));
  const feeFloorVariants = finiteNumberArray(screeningConfig.feeVelocityShadowFeeTvlFloors, [0.12, 0.15, 0.19])
    .map((fee_tvl_floor) => ({
      hypothesis: "H5",
      fee_tvl_floor,
      passes_floor: numberFromCandidate(candidate, ["fee_active_tvl_ratio", "fee_tvl_ratio"]) != null
        ? numberFromCandidate(candidate, ["fee_active_tvl_ratio", "fee_tvl_ratio"]) >= fee_tvl_floor
        : null,
      volume_active_tvl_multiple: volumeActiveTvlMultiple,
      fee_velocity_usd_per_min: feeVelocityUsdPerMin,
    }));
  const sameTickerSurf = {
    hypothesis: "H4",
    enabled: screeningConfig.sameTickerSurfEnabled === true,
    opportunity: false,
    reject_reason: screeningConfig.sameTickerSurfEnabled === true
      ? "requires post-close same-pool/base-mint revalidation before action"
      : "sameTickerSurfEnabled is false; shadow-only",
  };

  // ─── Shadow Entry Indicator Signals ────────────────────────────────────────
  // All 5 signals are shadow-only: they attach to fee_velocity_shadow in
  // candidate metadata and get logged in action logs. They do NOT filter
  // candidates, do NOT change screening behavior, do NOT affect position sizing.

  // Signal 1: Price Direction Shadow
  const priceChange1h = numberFromCandidate(candidate, [
    "price_change_pct", "price_change_1h", "change_1h",
    "stats_1h.price_change", "token_info.stats_1h.price_change",
  ]);
  const pumpThresholds = finiteNumberArray(screeningConfig.feeVelocityShadowPumpThresholds, [30, 50, 100]);
  const price_direction_shadow = {
    price_change_1h_pct: priceChange1h,
    pump_risk: priceChange1h != null ? (
      priceChange1h > 100 ? "extreme" :
      priceChange1h > 50  ? "high" :
      priceChange1h > 30  ? "moderate" :
      priceChange1h > 0   ? "mild_up" :
      priceChange1h > -20 ? "mild_down" : "dump"
    ) : null,
    threshold_verdicts: pumpThresholds.map((threshold) => ({
      threshold_pct: threshold,
      would_reject: priceChange1h != null ? priceChange1h > threshold : null,
      label: `reject_if_1h_pump_gt_${threshold}pct`,
    })),
    note: "shadow_only — price direction check for post-pump entry risk",
  };

  // Signal 2: Sell Pressure Shadow
  const sellVol = numberFromCandidate(candidate, [
    "sell_vol", "stats_1h.sell_vol", "token_info.stats_1h.sell_vol",
  ]);
  const buyVol = numberFromCandidate(candidate, [
    "buy_vol", "stats_1h.buy_vol", "token_info.stats_1h.buy_vol",
  ]);
  const sellBuyRatio = (sellVol != null && buyVol != null && buyVol > 0)
    ? roundNumber(sellVol / buyVol, 3) : null;
  const sellBuyThresholds = finiteNumberArray(screeningConfig.feeVelocityShadowSellBuyThresholds, [1.2, 1.5, 2.0]);
  const sell_pressure_shadow = {
    sell_vol: sellVol,
    buy_vol: buyVol,
    sell_buy_ratio: sellBuyRatio,
    pressure_level: sellBuyRatio != null ? (
      sellBuyRatio > 2.0 ? "heavy_sell" :
      sellBuyRatio > 1.5 ? "moderate_sell" :
      sellBuyRatio > 1.2 ? "mild_sell" :
      sellBuyRatio > 0.8 ? "balanced" : "buy_pressure"
    ) : null,
    threshold_verdicts: sellBuyThresholds.map((threshold) => ({
      threshold,
      would_reject: sellBuyRatio != null ? sellBuyRatio > threshold : null,
      label: `reject_if_sell_buy_gt_${String(threshold).replace(".", "_")}`,
    })),
    note: "shadow_only — sell pressure check for distribution vs accumulation",
  };

  // Signal 3: Volume/TVL Multiple Threshold Variants Shadow
  const volTvlThresholds = finiteNumberArray(
    screeningConfig.feeVelocityShadowVolTvlThresholds,
    [3.5, 4.0, 4.5, 5.0, 6.0, 8.0],
  );
  const volume_tvl_threshold_shadow = {
    volume_active_tvl_multiple: volumeActiveTvlMultiple,
    threshold_verdicts: volTvlThresholds.map((threshold) => ({
      threshold,
      passes: volumeActiveTvlMultiple != null ? volumeActiveTvlMultiple >= threshold : null,
      label: `passes_vol_tvl_gte_${String(threshold).replace(".", "_")}x`,
    })),
    note: "shadow_only — calibrate optimal minVolumeActiveTvlMultiple threshold",
  };

  // Signal 4: Fee Velocity Momentum Shadow
  const tokenAgeHours = numberFromCandidate(candidate, [
    "token_age_hours", "token_info.token_age_hours",
  ]);
  const feeVelocityPerHour = feeVelocityUsdPerMin != null ? roundNumber(feeVelocityUsdPerMin * 60, 2) : null;
  const feeVelocityPerAgeHour = (feeVelocityPerHour != null && tokenAgeHours != null && tokenAgeHours > 0)
    ? roundNumber(feeVelocityPerHour / tokenAgeHours, 4) : null;
  const fee_velocity_momentum_shadow = {
    fee_velocity_usd_per_min: feeVelocityUsdPerMin,
    fee_velocity_usd_per_hour: feeVelocityPerHour,
    token_age_hours: tokenAgeHours,
    fee_velocity_per_age_hour: feeVelocityPerAgeHour,
    age_risk: tokenAgeHours != null ? (
      tokenAgeHours < 1  ? "very_young_lt_1h" :
      tokenAgeHours < 6  ? "young_lt_6h" :
      tokenAgeHours < 24 ? "recent_lt_24h" : "established"
    ) : null,
    note: "shadow_only — fee velocity relative to token age for pump-and-dump risk",
  };

  // Signal 5: Organic Score vs Fee Velocity Shadow
  const organicScore = numberFromCandidate(candidate, [
    "organic_score", "base.organic", "token_x.organic_score",
  ]);
  const feeActiveTvlRatio = numberFromCandidate(candidate, [
    "fee_active_tvl_ratio", "fee_tvl_ratio",
  ]);
  const quality_vs_velocity_shadow = {
    organic_score: organicScore,
    fee_active_tvl_ratio: feeActiveTvlRatio,
    volume_active_tvl_multiple: volumeActiveTvlMultiple,
    quality_signal: organicScore != null ? (
      organicScore >= 70 ? "high_quality" :
      organicScore >= 50 ? "moderate_quality" :
      organicScore >= 30 ? "low_quality" : "very_low_quality"
    ) : null,
    // Combined quality+velocity score: high organic + high fee velocity = best
    combined_score: (organicScore != null && volumeActiveTvlMultiple != null)
      ? roundNumber((organicScore / 100) * Math.min(volumeActiveTvlMultiple / 5, 2), 3)
      : null,
    note: "shadow_only — organic quality vs fee velocity for wash trading risk",
  };

  return {
    downside_pct_variants: downsideVariants,
    take_profit_pct_variants: takeProfitVariants,
    fee_tvl_floor_variants: feeFloorVariants,
    same_ticker_surf: sameTickerSurf,
    target_profile: {
      hypothesis: "H2",
      target_downside_pct: rangePolicy.targetDownsidePct ?? null,
      target_downside_min_pct: rangePolicy.targetDownsideMinPct ?? null,
      target_downside_max_pct: rangePolicy.targetDownsideMaxPct ?? null,
      target_downside_bins: computeDownsideBinsForPct(rangePolicy.targetDownsidePct, binStep),
      target_downside_min_bins: computeDownsideBinsForPct(rangePolicy.targetDownsideMinPct, binStep),
      target_downside_max_bins: computeDownsideBinsForPct(rangePolicy.targetDownsideMaxPct, binStep),
    },
    // Shadow entry indicator signals — shadow-only, no live filtering
    price_direction_shadow,
    sell_pressure_shadow,
    volume_tvl_threshold_shadow,
    fee_velocity_momentum_shadow,
    quality_vs_velocity_shadow,
  };
}

export function enrichFeeVelocityCandidate(candidate = {}, {
  screeningConfig = {},
  rangePolicy = {},
  deployAmountSol = null,
  assumedDeployUsd = null,
  solUsd = null,
} = {}) {
  const volumeActiveTvlMultiple = computeVolumeActiveTvlMultiple(candidate);
  const feeVelocityUsdPerMin = estimateFeeVelocityUsdPerMin(candidate, screeningConfig);
  const shadow = buildFeeVelocityShadowRows(candidate, screeningConfig, rangePolicy);
  const dynamicRangeShadow = buildDynamicRangeShadowTelemetry(candidate, {
    deployAmountSol,
    assumedDeployUsd,
    solUsd,
    rangePolicy,
  });
  return {
    ...candidate,
    volume_active_tvl_multiple: volumeActiveTvlMultiple,
    fee_velocity_usd_per_min: feeVelocityUsdPerMin,
    target_downside_profile: shadow.target_profile,
    fee_velocity_shadow: shadow,
    dynamic_range_shadow: dynamicRangeShadow,
    same_ticker_surf_enabled: screeningConfig.sameTickerSurfEnabled === true,
  };
}
