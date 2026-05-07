export function makeDeployThresholdsUnavailableBlock(error, poolAddress, scope = "pool screening thresholds") {
  const message = error?.message || String(error || "unknown error");
  return {
    pass: false,
    reason: `Could not verify ${scope} before deploy: ${message}`,
    guard: "deploy_thresholds",
    failures: [{ code: "deploy_threshold_recheck_unavailable", message, pool_address: poolAddress || null }],
  };
}
