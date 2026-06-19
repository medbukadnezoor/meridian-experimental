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

function roundSol(value) {
  const number = finiteNumber(value);
  return number == null ? null : Math.floor(number * 100) / 100;
}

function readInput(args = {}, keys = []) {
  for (const key of keys) {
    const value = key.split(".").reduce((current, part) => current?.[part], args);
    const number = positiveNumber(value);
    if (number != null) return number;
  }
  return null;
}

export function resolveDynamicPoolSizingPolicy(runtimeConfig = {}) {
  const strategy = runtimeConfig.strategy ?? {};
  return {
    enabled: strategy.dynamicPoolSizingEnabled === true,
    mode: normalizeMode(strategy.dynamicPoolSizingMode),
    targetActiveTvlSharePct: positiveNumber(strategy.dynamicPoolSizingTargetActiveTvlSharePct) ?? 3.5,
    hardActiveTvlSharePct: positiveNumber(strategy.dynamicPoolSizingHardActiveTvlSharePct) ?? 5,
    minDeploySol: positiveNumber(strategy.dynamicPoolSizingMinDeploySol) ?? 1,
    maxDeploySol: positiveNumber(strategy.dynamicPoolSizingMaxDeploySol) ?? 5,
    blockBelowMin: strategy.dynamicPoolSizingBlockBelowMin !== false,
    blockOnMissingInputs: strategy.dynamicPoolSizingBlockOnMissingInputs !== false,
  };
}

export function buildDynamicPoolSizingDecision(args = {}, runtimeConfig = {}, context = {}) {
  const policy = resolveDynamicPoolSizingPolicy(runtimeConfig);
  const originalAmountY = finiteNumber(args.amount_y ?? args.amount_sol);
  const activeTvlUsd = readInput(args, ["active_tvl_usd", "active_tvl", "tvl", "initial_value_usd"]);
  const solUsd = positiveNumber(context.solUsd) ?? readInput(args, ["sol_usd", "sol_price", "wallet.sol_price"]);
  const reasonCodes = [];
  const missingInputs = [];

  const decision = {
    enabled: policy.enabled,
    mode: policy.mode,
    live_applied: false,
    decision: "disabled",
    original_amount_y: originalAmountY,
    final_amount_y: originalAmountY,
    active_tvl_usd: activeTvlUsd,
    sol_usd: solUsd,
    target_active_tvl_share_pct: policy.targetActiveTvlSharePct,
    hard_active_tvl_share_pct: policy.hardActiveTvlSharePct,
    min_deploy_sol: policy.minDeploySol,
    max_deploy_sol: policy.maxDeploySol,
    target_size_sol: null,
    hard_cap_sol: null,
    reason_codes: reasonCodes,
    missing_inputs: missingInputs,
    reason: "dynamic pool sizing disabled",
  };

  if (!policy.enabled) return decision;

  if (activeTvlUsd == null) missingInputs.push("active_tvl_usd");
  if (solUsd == null) missingInputs.push("sol_usd");
  if (missingInputs.length > 0) {
    reasonCodes.push("missing_required_input");
    decision.decision = policy.mode === "live" && policy.blockOnMissingInputs ? "block" : "missing_evidence";
    decision.reason = `dynamic pool sizing missing required input(s): ${missingInputs.join(", ")}`;
    return decision;
  }

  const targetSizeSol = activeTvlUsd * (policy.targetActiveTvlSharePct / 100) / solUsd;
  const hardCapSol = activeTvlUsd * (policy.hardActiveTvlSharePct / 100) / solUsd;
  const finalSizeSol = roundSol(Math.min(policy.maxDeploySol, targetSizeSol, hardCapSol));

  decision.target_size_sol = roundSol(targetSizeSol);
  decision.hard_cap_sol = roundSol(hardCapSol);
  decision.final_amount_y = finalSizeSol;

  if (finalSizeSol == null || finalSizeSol < policy.minDeploySol) {
    reasonCodes.push("below_min_dynamic_size");
    decision.decision = policy.mode === "live" && policy.blockBelowMin ? "block" : "shadow_only";
    decision.reason = `dynamic pool sizing computed ${finalSizeSol ?? "null"} SOL below minimum ${policy.minDeploySol} SOL`;
    return decision;
  }

  if (originalAmountY == null || Math.abs(originalAmountY - finalSizeSol) > 0.000001) {
    reasonCodes.push("amount_y_overridden");
    decision.decision = policy.mode === "live" ? "override" : "shadow_only";
    decision.reason = `dynamic pool sizing ${policy.mode === "live" ? "overrides" : "would override"} amount_y ${originalAmountY ?? "missing"} -> ${finalSizeSol}`;
  } else {
    decision.decision = policy.mode === "live" ? "keep" : "shadow_only";
    decision.reason = `dynamic pool sizing keeps amount_y ${finalSizeSol}`;
  }
  decision.live_applied = policy.mode === "live";
  return decision;
}

export function applyDynamicPoolSizing(args = {}, runtimeConfig = {}, context = {}) {
  const decision = buildDynamicPoolSizingDecision(args, runtimeConfig, context);
  if (!decision.enabled) return { ok: true, args, decision };
  if (decision.decision === "block") {
    return { ok: false, args, decision, reason: decision.reason };
  }
  if (decision.live_applied === true && decision.final_amount_y != null) {
    return {
      ok: true,
      args: {
        ...args,
        amount_x: 0,
        amount_y: decision.final_amount_y,
        bins_above: 0,
        dynamic_pool_sizing_decision: decision,
      },
      decision,
    };
  }
  return {
    ok: true,
    args: {
      ...args,
      dynamic_pool_sizing_decision: decision,
    },
    decision,
  };
}

export const __test = {
  finiteNumber,
  resolveDynamicPoolSizingPolicy,
  buildDynamicPoolSizingDecision,
  applyDynamicPoolSizing,
};
