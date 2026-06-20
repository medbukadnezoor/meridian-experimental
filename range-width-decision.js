import { computeDownsideBinsForPct } from "./strategy-library.js";

const DEFAULT_TIERS = Object.freeze([
  { minMcap: 125_000, maxMcap: 250_000, targetDownsidePct: 30, maxTargetDownsidePct: 36 },
  { minMcap: 250_000, maxMcap: 500_000, targetDownsidePct: 28, maxTargetDownsidePct: 34 },
  { minMcap: 500_000, maxMcap: 800_000, targetDownsidePct: 25, maxTargetDownsidePct: 31 },
  { minMcap: 800_000, maxMcap: 1_200_000, targetDownsidePct: 22, maxTargetDownsidePct: 28 },
  { minMcap: 1_200_000, maxMcap: 2_500_000, targetDownsidePct: 20, maxTargetDownsidePct: 25 },
  { minMcap: 2_500_000, maxMcap: null, targetDownsidePct: 18, maxTargetDownsidePct: 22 },
]);

const DEFAULT_POLICY = Object.freeze({
  enabled: false,
  mode: "shadow",
  minBins: 12,
  maxBins: 120,
  blockOnMissingInputs: true,
  maxDeploySharePct: 5,
  lowerMcapInputFloor: 500_000,
  minTargetDownsidePct: 16,
  feeDensityTighteningEnabled: false,
  requireFeeProofToTighten: false,
  strongFeeActiveTvlRatio: 3,
  strongVolumeActiveTvlMultiple: 1.5,
  strongFeeVelocityUsdPerMin: 3,
  strongTightenPct: 2,
  goodFeeActiveTvlRatio: 1.5,
  goodVolumeActiveTvlMultiple: 1.2,
  goodTightenPct: 1,
  tiers: DEFAULT_TIERS,
});

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number != null && number > 0 ? number : null;
}

function normalizeMode(value) {
  return String(value || "shadow").toLowerCase() === "live" ? "live" : "shadow";
}

function normalizeTier(tier = {}) {
  return {
    minMcap: finiteNumber(tier.minMcap ?? tier.min_mcap),
    maxMcap: finiteNumber(tier.maxMcap ?? tier.max_mcap),
    targetDownsidePct: finiteNumber(tier.targetDownsidePct ?? tier.target_downside_pct),
    maxTargetDownsidePct: finiteNumber(tier.maxTargetDownsidePct ?? tier.max_target_downside_pct),
  };
}

export function resolveRangeWidthPolicy(config = {}) {
  const strategy = config.strategy ?? {};
  const rawTiers = Array.isArray(strategy.dynamicRangeWidthTiers)
    ? strategy.dynamicRangeWidthTiers
    : DEFAULT_TIERS;
  const tiers = rawTiers.map(normalizeTier).filter((tier) => tier.targetDownsidePct != null);
  return {
    enabled: strategy.dynamicRangeWidthEnabled === true,
    mode: normalizeMode(strategy.dynamicRangeWidthMode),
    minBins: positiveNumber(strategy.dynamicRangeWidthMinBins) ?? DEFAULT_POLICY.minBins,
    maxBins: positiveNumber(strategy.dynamicRangeWidthMaxBins) ?? DEFAULT_POLICY.maxBins,
    blockOnMissingInputs: strategy.dynamicRangeWidthBlockOnMissingInputs !== false,
    maxDeploySharePct: positiveNumber(strategy.dynamicRangeWidthMaxDeploySharePct) ?? DEFAULT_POLICY.maxDeploySharePct,
    lowerMcapInputFloor: positiveNumber(strategy.dynamicRangeWidthLowerMcapInputFloor) ?? DEFAULT_POLICY.lowerMcapInputFloor,
    minTargetDownsidePct: positiveNumber(strategy.dynamicRangeWidthMinTargetDownsidePct) ?? DEFAULT_POLICY.minTargetDownsidePct,
    feeDensityTighteningEnabled: strategy.dynamicRangeWidthFeeDensityTighteningEnabled === true,
    requireFeeProofToTighten: strategy.dynamicRangeWidthRequireFeeProofToTighten === true,
    strongFeeActiveTvlRatio: positiveNumber(strategy.dynamicRangeWidthStrongFeeActiveTvlRatio) ?? DEFAULT_POLICY.strongFeeActiveTvlRatio,
    strongVolumeActiveTvlMultiple: positiveNumber(strategy.dynamicRangeWidthStrongVolumeActiveTvlMultiple) ?? DEFAULT_POLICY.strongVolumeActiveTvlMultiple,
    strongFeeVelocityUsdPerMin: positiveNumber(strategy.dynamicRangeWidthStrongFeeVelocityUsdPerMin) ?? DEFAULT_POLICY.strongFeeVelocityUsdPerMin,
    strongTightenPct: positiveNumber(strategy.dynamicRangeWidthStrongTightenPct) ?? DEFAULT_POLICY.strongTightenPct,
    goodFeeActiveTvlRatio: positiveNumber(strategy.dynamicRangeWidthGoodFeeActiveTvlRatio) ?? DEFAULT_POLICY.goodFeeActiveTvlRatio,
    goodVolumeActiveTvlMultiple: positiveNumber(strategy.dynamicRangeWidthGoodVolumeActiveTvlMultiple) ?? DEFAULT_POLICY.goodVolumeActiveTvlMultiple,
    goodTightenPct: positiveNumber(strategy.dynamicRangeWidthGoodTightenPct) ?? DEFAULT_POLICY.goodTightenPct,
    minMcap: finiteNumber(config.screening?.minMcap),
    tiers: tiers.length > 0 ? tiers : DEFAULT_TIERS,
  };
}

function findMcapTier(mcap, tiers) {
  if (mcap == null) return null;
  return tiers.find((tier) => {
    const aboveMin = tier.minMcap == null || mcap >= tier.minMcap;
    const belowMax = tier.maxMcap == null || mcap < tier.maxMcap;
    return aboveMin && belowMax;
  }) ?? null;
}

function tierLabel(tier) {
  if (!tier) return null;
  const min = tier.minMcap == null ? "0" : String(Math.round(tier.minMcap));
  const max = tier.maxMcap == null ? "inf" : String(Math.round(tier.maxMcap));
  return `${min}-${max}`;
}

function addUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

function roundPct(value) {
  const number = finiteNumber(value);
  return number == null ? null : Number(number.toFixed(4));
}

function derivedDeploySharePct(args = {}, activeTvl = null) {
  const sizing = args.dynamic_pool_sizing_decision ?? {};
  const sizingShare = finiteNumber(sizing.final_deploy_share_of_active_tvl_pct);
  if (sizingShare != null && sizingShare > 0) return sizingShare;
  const deploySol = positiveNumber(sizing.final_amount_y ?? args.amount_y ?? args.amount_sol);
  const solUsd = positiveNumber(sizing.sol_usd ?? args.sol_usd ?? args.sol_price);
  const activeTvlUsd = positiveNumber(sizing.active_tvl_usd ?? activeTvl);
  if (deploySol != null && solUsd != null && activeTvlUsd != null) {
    return (deploySol * solUsd / activeTvlUsd) * 100;
  }
  const explicit = finiteNumber(args.deploy_share_of_active_tvl_pct);
  return explicit != null && explicit > 0 ? explicit : null;
}

function applyFeeDensityTightening(targetDownsidePct, args = {}, policy, reasonCodes) {
  if (!policy.feeDensityTighteningEnabled) return targetDownsidePct;
  const feeDensity = positiveNumber(args.fee_tvl_ratio ?? args.fee_active_tvl_ratio);
  const volumeMultiple = positiveNumber(args.volume_active_tvl_multiple);
  const feeVelocity = positiveNumber(args.fee_velocity_usd_per_min);
  const strongFee = feeDensity != null && feeDensity >= policy.strongFeeActiveTvlRatio;
  const strongActivity = volumeMultiple != null && volumeMultiple >= policy.strongVolumeActiveTvlMultiple;
  const strongVelocity = feeVelocity != null && feeVelocity >= policy.strongFeeVelocityUsdPerMin;
  const goodFee = feeDensity != null && feeDensity >= policy.goodFeeActiveTvlRatio;
  const goodActivity = volumeMultiple != null && volumeMultiple >= policy.goodVolumeActiveTvlMultiple;

  if (strongFee && (strongActivity || strongVelocity)) {
    addUnique(reasonCodes, "strong_fee_density_tighten");
    if (strongActivity) addUnique(reasonCodes, "strong_activity_density");
    if (strongVelocity) addUnique(reasonCodes, "strong_fee_velocity");
    return targetDownsidePct - policy.strongTightenPct;
  }
  if (goodFee && goodActivity) {
    addUnique(reasonCodes, "good_fee_density_tighten");
    return targetDownsidePct - policy.goodTightenPct;
  }
  if (policy.feeDensityTighteningEnabled && feeDensity == null) {
    addUnique(reasonCodes, "fee_density_tighten_missing_fee");
  }
  return targetDownsidePct;
}

function hasFeeDensityRangeProof(args = {}, policy) {
  if (!policy.feeDensityTighteningEnabled) return true;
  const feeDensity = positiveNumber(args.fee_tvl_ratio ?? args.fee_active_tvl_ratio);
  const volumeMultiple = positiveNumber(args.volume_active_tvl_multiple);
  const feeVelocity = positiveNumber(args.fee_velocity_usd_per_min);
  const strongFee = feeDensity != null && feeDensity >= policy.strongFeeActiveTvlRatio;
  const strongActivity = volumeMultiple != null && volumeMultiple >= policy.strongVolumeActiveTvlMultiple;
  const strongVelocity = feeVelocity != null && feeVelocity >= policy.strongFeeVelocityUsdPerMin;
  const goodFee = feeDensity != null && feeDensity >= policy.goodFeeActiveTvlRatio;
  const goodActivity = volumeMultiple != null && volumeMultiple >= policy.goodVolumeActiveTvlMultiple;
  return (strongFee && (strongActivity || strongVelocity)) || (goodFee && goodActivity);
}

export function buildRangeWidthDecision(args = {}, config = {}) {
  const policy = resolveRangeWidthPolicy(config);
  const liveEnabled = policy.enabled === true && policy.mode === "live";
  const originalBinsBelow = finiteNumber(args.bins_below);
  const binStep = positiveNumber(args.bin_step);
  const mcap = positiveNumber(args.mcap);
  const activeTvl = positiveNumber(args.active_tvl);
  const deployShare = derivedDeploySharePct(args, activeTvl);
  const volatility = finiteNumber(args.volatility);
  const priceChangePct = finiteNumber(args.price_change_pct ?? args.price_change_1h);
  const reasonCodes = [];
  const missingInputs = [];

  const decision = {
    target_downside_pct: null,
    required_bins_below: null,
    original_bins_below: originalBinsBelow,
    final_bins_below: originalBinsBelow,
    bin_step: binStep,
    deploy_share_of_active_tvl_pct: deployShare == null ? null : roundPct(deployShare),
    fee_active_tvl_ratio: finiteNumber(args.fee_tvl_ratio ?? args.fee_active_tvl_ratio),
    volume_active_tvl_multiple: finiteNumber(args.volume_active_tvl_multiple),
    fee_velocity_usd_per_min: finiteNumber(args.fee_velocity_usd_per_min),
    mode: policy.mode,
    live_applied: false,
    decision: policy.enabled ? "keep" : "shadow_only",
    reason_codes: reasonCodes,
    missing_inputs: missingInputs,
    policy: {
      enabled: policy.enabled,
      min_bins: policy.minBins,
      max_bins: policy.maxBins,
      max_deploy_share_pct: policy.maxDeploySharePct,
      min_mcap: policy.minMcap,
      min_target_downside_pct: policy.minTargetDownsidePct,
      fee_density_tightening_enabled: policy.feeDensityTighteningEnabled,
    },
  };

  if (mcap == null) missingInputs.push("mcap");
  if (activeTvl == null) missingInputs.push("active_tvl");
  if (binStep == null) missingInputs.push("bin_step");
  if (deployShare == null) missingInputs.push("deploy_share_of_active_tvl_pct");
  if (missingInputs.length > 0) addUnique(reasonCodes, "missing_required_input");

  if (policy.minMcap != null && mcap != null && mcap < policy.minMcap) {
    decision.decision = liveEnabled ? "block" : "shadow_only";
    decision.blocked = liveEnabled;
    decision.reason = `dynamic range width blocked: mcap ${mcap} below configured floor ${policy.minMcap}`;
    addUnique(reasonCodes, "mcap_below_configured_floor");
    return decision;
  }

  const lowerMcapCandidate = mcap == null || mcap <= policy.lowerMcapInputFloor;
  if (policy.blockOnMissingInputs && lowerMcapCandidate && missingInputs.length > 0) {
    decision.decision = liveEnabled ? "block" : "shadow_only";
    decision.blocked = liveEnabled;
    decision.reason = `dynamic range width missing required input(s): ${missingInputs.join(", ")}`;
    return decision;
  }

  const tier = findMcapTier(mcap, policy.tiers);
  let targetDownsidePct = tier?.targetDownsidePct ?? 35;
  const tierMaxTarget = tier?.maxTargetDownsidePct ?? 60;
  addUnique(reasonCodes, "mcap_tier");

  if (volatility != null && volatility >= 8) {
    targetDownsidePct += 5;
    addUnique(reasonCodes, "volatility_bump");
  } else if (volatility != null && volatility >= 6) {
    targetDownsidePct += 2;
    addUnique(reasonCodes, "volatility_bump");
  }

  if (activeTvl != null && activeTvl < 25_000) {
    targetDownsidePct += 3;
    addUnique(reasonCodes, "thin_active_tvl");
  }

  if (deployShare != null && deployShare > 4) {
    targetDownsidePct += 3;
    addUnique(reasonCodes, "deploy_share_bump");
  } else if (deployShare != null && deployShare > 2) {
    targetDownsidePct += 1;
    addUnique(reasonCodes, "deploy_share_bump");
  }

  if (priceChangePct != null && priceChangePct >= 100) {
    targetDownsidePct += 3;
    addUnique(reasonCodes, "pump_retrace_bump");
  }

  targetDownsidePct = applyFeeDensityTightening(targetDownsidePct, args, policy, reasonCodes);
  targetDownsidePct = Math.min(60, tierMaxTarget, Math.max(policy.minTargetDownsidePct, targetDownsidePct));
  const requiredBins = binStep != null ? computeDownsideBinsForPct(targetDownsidePct, binStep) : null;
  decision.target_downside_pct = roundPct(targetDownsidePct);
  decision.required_bins_below = requiredBins;
  decision.mcap_tier = tierLabel(tier);

  if (deployShare != null && deployShare > policy.maxDeploySharePct) {
    decision.decision = liveEnabled ? "block" : "shadow_only";
    decision.blocked = liveEnabled;
    decision.reason = `dynamic range width blocked: deploy share ${roundPct(deployShare)}% exceeds ${policy.maxDeploySharePct}% max`;
    addUnique(reasonCodes, "deploy_share_too_high");
    return decision;
  }

  if (requiredBins == null) {
    decision.decision = liveEnabled ? "block" : "shadow_only";
    decision.blocked = liveEnabled;
    decision.reason = "dynamic range width could not compute required bins";
    addUnique(reasonCodes, "missing_required_input");
    return decision;
  }

  if (requiredBins > policy.maxBins) {
    decision.decision = liveEnabled ? "block" : "shadow_only";
    decision.blocked = liveEnabled;
    decision.reason = `dynamic range width blocked: required bins ${requiredBins} exceeds max ${policy.maxBins}`;
    addUnique(reasonCodes, "required_bins_exceeds_max");
    return decision;
  }

  const policyBins = Math.max(policy.minBins, requiredBins);
  if (policy.requireFeeProofToTighten && originalBinsBelow != null && originalBinsBelow > policyBins && !hasFeeDensityRangeProof(args, policy)) {
    decision.final_bins_below = originalBinsBelow;
    decision.decision = liveEnabled ? "keep" : "shadow_only";
    addUnique(reasonCodes, "tighten_blocked_missing_fee_density");
    return decision;
  }
  if (originalBinsBelow == null || originalBinsBelow !== policyBins) {
    decision.final_bins_below = policyBins;
    addUnique(reasonCodes, originalBinsBelow != null && originalBinsBelow > policyBins ? "llm_bins_tightened" : "llm_bins_overridden");
    if (liveEnabled) {
      decision.decision = "override";
      decision.live_applied = true;
    } else {
      decision.decision = "shadow_only";
    }
    return decision;
  }

  decision.final_bins_below = originalBinsBelow;
  decision.decision = liveEnabled ? "keep" : "shadow_only";
  return decision;
}

export function applyRangeWidthDecision(args = {}, config = {}) {
  const decision = buildRangeWidthDecision(args, config);
  const nextArgs = {
    ...args,
    range_width_decision: decision,
  };

  if (decision.blocked === true) {
    return {
      ok: false,
      args: nextArgs,
      decision,
      reason: decision.reason || "dynamic range width blocked deploy",
    };
  }

  if (decision.live_applied === true && decision.final_bins_below != null) {
    nextArgs.bins_below = decision.final_bins_below;
  }

  return {
    ok: true,
    args: nextArgs,
    decision,
    repaired: decision.live_applied === true,
  };
}
