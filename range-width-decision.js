import { computeDownsideBinsForPct } from "./strategy-library.js";

const DEFAULT_TIERS = Object.freeze([
  { minMcap: 400_000, maxMcap: 500_000, targetDownsidePct: 60 },
  { minMcap: 500_000, maxMcap: 800_000, targetDownsidePct: 58 },
  { minMcap: 800_000, maxMcap: 1_200_000, targetDownsidePct: 55 },
  { minMcap: 1_200_000, maxMcap: null, targetDownsidePct: 35, maxTargetDownsidePct: 45 },
]);

const DEFAULT_POLICY = Object.freeze({
  enabled: false,
  mode: "shadow",
  minBins: 35,
  maxBins: 120,
  blockOnMissingInputs: true,
  maxDeploySharePct: 5,
  lowerMcapInputFloor: 1_200_000,
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

export function buildRangeWidthDecision(args = {}, config = {}) {
  const policy = resolveRangeWidthPolicy(config);
  const liveEnabled = policy.enabled === true && policy.mode === "live";
  const originalBinsBelow = finiteNumber(args.bins_below);
  const binStep = positiveNumber(args.bin_step);
  const mcap = positiveNumber(args.mcap);
  const activeTvl = positiveNumber(args.active_tvl);
  const deployShare = positiveNumber(args.deploy_share_of_active_tvl_pct);
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

  targetDownsidePct = Math.min(60, tierMaxTarget, Math.max(35, targetDownsidePct));
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

  const floorBins = Math.max(policy.minBins, requiredBins);
  if (originalBinsBelow == null || originalBinsBelow < floorBins) {
    decision.final_bins_below = floorBins;
    addUnique(reasonCodes, "llm_bins_overridden");
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
