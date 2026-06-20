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
  const normalized = String(value || "shadow").trim().toLowerCase();
  return normalized === "live" ? "live" : "shadow";
}

function addReason(reasons, reason) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function readFeeDensity(args = {}) {
  return finiteNumber(args.fee_tvl_ratio ?? args.fee_active_tvl_ratio);
}

function readActivityMultiple(args = {}) {
  return finiteNumber(args.volume_active_tvl_multiple);
}

function dynamicSizingPresent(decision = null) {
  return decision && typeof decision === "object" && decision.enabled === true;
}

function dynamicSizingWithinShareCap(decision = null) {
  if (!dynamicSizingPresent(decision)) return false;
  if (decision.decision === "block") return false;
  const finalAmountY = positiveNumber(decision.final_amount_y);
  const activeTvlUsd = positiveNumber(decision.active_tvl_usd);
  const solUsd = positiveNumber(decision.sol_usd);
  const hardSharePct = positiveNumber(decision.hard_active_tvl_share_pct);
  if (finalAmountY == null || activeTvlUsd == null || solUsd == null || hardSharePct == null) return false;
  const finalDeployUsd = finalAmountY * solUsd;
  return (finalDeployUsd / activeTvlUsd) * 100 <= hardSharePct + 1e-9;
}

export function resolveCriticalThinEntryOverlayPolicy(runtimeConfig = {}) {
  const screening = runtimeConfig.screening ?? {};
  return {
    enabled: screening.criticalThinEntryOverlayEnabled === true,
    mode: normalizeMode(screening.criticalThinEntryOverlayMode),
    criticalMcapUsd: positiveNumber(screening.criticalThinMcapUsd) ?? 300_000,
    criticalActiveTvlUsd: positiveNumber(screening.criticalThinActiveTvlUsd) ?? 5_000,
    watchMcapUsd: positiveNumber(screening.criticalThinWatchMcapUsd) ?? 500_000,
    watchActiveTvlUsd: positiveNumber(screening.criticalThinWatchActiveTvlUsd) ?? 10_000,
    requireChartAccept: screening.criticalThinRequireChartAccept !== false,
    minFeeActiveTvlRatio: positiveNumber(screening.criticalThinMinFeeActiveTvlRatio) ?? 3,
    minVolumeActiveTvlMultiple: positiveNumber(screening.criticalThinMinVolumeActiveTvlMultiple) ?? 5,
    blockOnMissingInputs: screening.criticalThinBlockOnMissingInputs !== false,
  };
}

export function evaluateCriticalThinEntryOverlay(args = {}, runtimeConfig = {}, context = {}) {
  const policy = resolveCriticalThinEntryOverlayPolicy(runtimeConfig);
  const mcap = finiteNumber(args.mcap ?? args.token_info?.mcap);
  const activeTvl = finiteNumber(args.active_tvl ?? args.active_tvl_usd ?? args.tvl);
  const feeDensity = readFeeDensity(args);
  const activityMultiple = readActivityMultiple(args);
  const fabriqGate = context.fabriqOhlcvEntryGate ?? args.fabriq_ohlcv_entry_gate ?? null;
  const dynamicPoolSizingDecision = context.dynamicPoolSizingDecision ?? args.dynamic_pool_sizing_decision ?? null;
  const reasonCodes = [];
  const missingInputs = [];

  const criticalByMcap = mcap != null && mcap < policy.criticalMcapUsd;
  const criticalByActiveTvl = activeTvl != null && activeTvl < policy.criticalActiveTvlUsd;
  const watchByMcap = mcap != null && mcap < policy.watchMcapUsd;
  const watchByActiveTvl = activeTvl != null && activeTvl < policy.watchActiveTvlUsd;
  const missingClassificationInput = mcap == null || activeTvl == null;
  const bucket = missingClassificationInput
    ? "unknown"
    : criticalByMcap || criticalByActiveTvl
    ? "critical"
    : (watchByMcap || watchByActiveTvl ? "watch" : "none");

  if (criticalByMcap) addReason(reasonCodes, "critical_thin_mcap");
  if (criticalByActiveTvl) addReason(reasonCodes, "critical_thin_active_tvl");
  if (!criticalByMcap && watchByMcap) addReason(reasonCodes, "watch_thin_mcap");
  if (!criticalByActiveTvl && watchByActiveTvl) addReason(reasonCodes, "watch_thin_active_tvl");

  const overlay = {
    enabled: policy.enabled,
    mode: policy.mode,
    live_applied: policy.enabled === true && policy.mode === "live",
    bucket,
    blocked: false,
    decision: "pass",
    reason: "critical-thin entry overlay pass",
    reason_codes: reasonCodes,
    missing_inputs: missingInputs,
    thresholds: {
      critical_mcap_usd: policy.criticalMcapUsd,
      critical_active_tvl_usd: policy.criticalActiveTvlUsd,
      watch_mcap_usd: policy.watchMcapUsd,
      watch_active_tvl_usd: policy.watchActiveTvlUsd,
      min_fee_active_tvl_ratio: policy.minFeeActiveTvlRatio,
      min_volume_active_tvl_multiple: policy.minVolumeActiveTvlMultiple,
    },
    inputs: {
      mcap,
      active_tvl: activeTvl,
      fee_active_tvl_ratio: feeDensity,
      volume_active_tvl_multiple: activityMultiple,
      fabriq_ohlcv_result: fabriqGate?.result ?? null,
      dynamic_pool_sizing_decision: dynamicPoolSizingDecision?.decision ?? null,
      dynamic_pool_sizing_final_amount_y: finiteNumber(dynamicPoolSizingDecision?.final_amount_y),
    },
  };

  if (!policy.enabled || (bucket !== "critical" && bucket !== "unknown")) {
    overlay.decision = !policy.enabled ? "disabled" : (bucket === "watch" ? "watch_only" : "not_thin");
    overlay.reason = !policy.enabled ? "critical-thin entry overlay disabled" : overlay.reason;
    return { ok: true, overlay };
  }

  if (mcap == null) {
    missingInputs.push("mcap");
    addReason(reasonCodes, "missing_mcap");
  }
  if (activeTvl == null) {
    missingInputs.push("active_tvl");
    addReason(reasonCodes, "missing_active_tvl");
  }
  if (feeDensity == null) {
    missingInputs.push("fee_density");
    addReason(reasonCodes, "missing_fee_density");
  }
  if (activityMultiple == null) {
    missingInputs.push("volume_active_tvl_multiple");
    addReason(reasonCodes, "missing_activity");
  }
  if (!dynamicSizingPresent(dynamicPoolSizingDecision)) {
    missingInputs.push("dynamic_pool_sizing_decision");
    addReason(reasonCodes, "missing_dynamic_pool_sizing");
  }

  if (policy.requireChartAccept && fabriqGate?.result !== "accept") {
    addReason(reasonCodes, "fabriq_ohlcv_not_accept");
  }
  if (feeDensity != null && feeDensity < policy.minFeeActiveTvlRatio) {
    addReason(reasonCodes, "fee_density_below_min");
  }
  if (activityMultiple != null && activityMultiple < policy.minVolumeActiveTvlMultiple) {
    addReason(reasonCodes, "activity_below_min");
  }
  if (dynamicSizingPresent(dynamicPoolSizingDecision) && !dynamicSizingWithinShareCap(dynamicPoolSizingDecision)) {
    addReason(reasonCodes, "dynamic_pool_sizing_over_share_cap");
  }

  const failingReasons = reasonCodes.filter((reason) => (
    reason.startsWith("missing_") ||
    reason === "fabriq_ohlcv_not_accept" ||
    reason === "fee_density_below_min" ||
    reason === "activity_below_min" ||
    reason === "dynamic_pool_sizing_over_share_cap"
  ));
  const missingFailure = missingInputs.length > 0 && policy.blockOnMissingInputs;
  const proofFailure = failingReasons.some((reason) => !reason.startsWith("missing_"));
  const shouldBlock = overlay.live_applied === true && (missingFailure || proofFailure);

  overlay.blocked = shouldBlock;
  overlay.decision = shouldBlock ? "block" : (overlay.live_applied ? "allow" : "shadow_block_candidate");
  overlay.reason = shouldBlock
    ? `critical-thin entry overlay blocked: ${failingReasons.join(", ")}`
    : "critical-thin entry overlay passed";

  return { ok: !shouldBlock, overlay };
}

export const __test = {
  finiteNumber,
  resolveCriticalThinEntryOverlayPolicy,
  evaluateCriticalThinEntryOverlay,
};
