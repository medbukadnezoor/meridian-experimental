import fs from "fs";

export const DEFAULT_HIVEMIND_URL = "https://api.agentmeridian.xyz";
export const DEFAULT_AGENT_MERIDIAN_API_URL = "https://api.agentmeridian.xyz/api";
export const DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";
export const DEFAULT_HIVEMIND_API_KEY = DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY;

export function normalizeOptionalString(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function firstNonEmptyString(...values) {
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
    if (normalized) return normalized;
  }
  return undefined;
}

export const INTERNAL_FALLBACK_MODEL = "stepfun/step-3.5-flash:free";

export function resolveFallbackModel(configuredFallbackModel) {
  const normalizedFallbackModel = normalizeOptionalString(configuredFallbackModel);
  if (normalizedFallbackModel) return normalizedFallbackModel;
  return INTERNAL_FALLBACK_MODEL;
}

export function loadUserConfig(userConfigPath) {
  return fs.existsSync(userConfigPath)
    ? JSON.parse(fs.readFileSync(userConfigPath, "utf8"))
    : {};
}

export function applyUserConfigToEnv(userConfig, env = process.env) {
  const u = userConfig ?? {};
  if (u.rpcUrl) env.RPC_URL ||= u.rpcUrl;
  if (u.walletKey) env.WALLET_PRIVATE_KEY ||= u.walletKey;
  if (u.llmModel) env.LLM_MODEL ||= u.llmModel;
  if (u.llmBaseUrl) env.LLM_BASE_URL ||= u.llmBaseUrl;
  if (u.llmApiKey) env.LLM_API_KEY ||= u.llmApiKey;
  if (u.dryRun !== undefined) env.DRY_RUN ||= String(u.dryRun);
  if (u.publicApiKey) env.PUBLIC_API_KEY ||= u.publicApiKey;
  if (u.agentMeridianApiUrl) env.AGENT_MERIDIAN_API_URL ||= u.agentMeridianApiUrl;
}

export function buildConfig(userConfig = {}, env = process.env) {
  const u = userConfig ?? {};
  const indicatorUserConfig = u.chartIndicators ?? {};
  const fallbackModel = normalizeOptionalString(u.fallbackModel);

  return {
    risk: {
      maxPositions: u.maxPositions ?? 3,
      maxDeployAmount: u.maxDeployAmount ?? 50,
    },

    screening: {
      excludeHighSupplyConcentration: u.excludeHighSupplyConcentration ?? true,
      minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
      minTvl: u.minTvl ?? 10_000,
      maxTvl: u.maxTvl !== undefined ? u.maxTvl : 150_000,
      minVolume: u.minVolume ?? 500,
      minOrganic: u.minOrganic ?? 60,
      minQuoteOrganic: u.minQuoteOrganic ?? 60,
      minHolders: u.minHolders ?? 500,
      minMcap: u.minMcap ?? 150_000,
      maxMcap: u.maxMcap ?? 10_000_000,
      minBinStep: u.minBinStep ?? 80,
      maxBinStep: u.maxBinStep ?? 125,
      timeframe: u.timeframe ?? "5m",
      category: u.category ?? "trending",
      minTokenFeesSol: u.minTokenFeesSol ?? 30,
      useDiscordSignals: u.useDiscordSignals ?? false,
      discordSignalMode: u.discordSignalMode ?? "merge",
      avoidPvpSymbols: u.avoidPvpSymbols ?? true,
      blockPvpSymbols: u.blockPvpSymbols ?? false,
      maxBundlePct: u.maxBundlePct ?? 30,
      maxBotHoldersPct: u.maxBotHoldersPct ?? 30,
      maxTop10Pct: u.maxTop10Pct ?? 60,
      allowedLaunchpads: u.allowedLaunchpads ?? [],
      blockedLaunchpads: u.blockedLaunchpads ?? [],
      minTokenAgeHours: u.minTokenAgeHours ?? null,
      maxTokenAgeHours: u.maxTokenAgeHours ?? null,
      athFilterPct: u.athFilterPct ?? null,
    },

    management: {
      minClaimAmount: u.minClaimAmount ?? 5,
      autoSwapAfterClaim: u.autoSwapAfterClaim ?? false,
      outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
      outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
      outOfRangeHardCloseMinutes: u.outOfRangeHardCloseMinutes ?? null,
      oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
      oorCooldownHours: u.oorCooldownHours ?? 12,
      stopLossCooldownHours: u.stopLossCooldownHours ?? 12,
      repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
      repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 3,
      repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
      repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "token",
      repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
      repeatLowYieldCooldownEnabled: u.repeatLowYieldCooldownEnabled ?? false,
      repeatLowYieldCooldownTriggerCount: u.repeatLowYieldCooldownTriggerCount ?? 3,
      repeatLowYieldCooldownLookbackHours: u.repeatLowYieldCooldownLookbackHours ?? 48,
      repeatLowYieldCooldownHours: u.repeatLowYieldCooldownHours ?? 12,
      repeatLowYieldCooldownScope: u.repeatLowYieldCooldownScope ?? "token",
      minVolumeToRebalance: u.minVolumeToRebalance ?? 1000,
      stopLossPct: u.stopLossPct ?? u.emergencyPriceDropPct ?? -50,
      stopLossConfirmDelayMs: u.stopLossConfirmDelayMs ?? 0,
      hardStopLossPct: u.hardStopLossPct ?? null,
      takeProfitPct: u.takeProfitPct ?? u.takeProfitFeePct ?? 5,
      minFeePerTvl24h: u.minFeePerTvl24h ?? 7,
      minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60,
      minSolToOpen: u.minSolToOpen ?? 0.55,
      deployAmountSol: u.deployAmountSol ?? 0.5,
      gasReserve: u.gasReserve ?? 0.2,
      positionSizePct: u.positionSizePct ?? 0.35,
      trailingTakeProfit: u.trailingTakeProfit ?? true,
      trailingTriggerPct: u.trailingTriggerPct ?? 3,
      trailingDropPct: u.trailingDropPct ?? 1.5,
      pnlSanityMaxDiffPct: u.pnlSanityMaxDiffPct ?? 5,
      pnlSnapshotLoggingEnabled: u.pnlSnapshotLoggingEnabled ?? false,
      pnlSnapshotDebug: u.pnlSnapshotDebug ?? false,
      pnlSnapshotBotName: u.pnlSnapshotBotName ?? (String(u.preset ?? "").toLowerCase().includes("nanocap") ? "nanocap" : "meridian"),
      earlyDumpPct: u.earlyDumpPct ?? null,
      earlyDumpMaxAgeMin: u.earlyDumpMaxAgeMin ?? 30,
      solMode: u.solMode ?? false,
    },

    strategy: {
      strategy: u.strategy ?? "bid_ask",
      binsBelow: u.binsBelow ?? 69,
    },

    schedule: {
      managementIntervalMin: u.managementIntervalMin ?? 10,
      screeningIntervalMin: u.screeningIntervalMin ?? 30,
      healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
    },

    llm: {
      temperature: u.temperature ?? 0.373,
      maxTokens: u.maxTokens ?? 4096,
      maxSteps: u.maxSteps ?? 20,
      managementModel: u.managementModel ?? env.LLM_MODEL ?? "openrouter/healer-alpha",
      screeningModel: u.screeningModel ?? env.LLM_MODEL ?? "openrouter/hunter-alpha",
      generalModel: u.generalModel ?? env.LLM_MODEL ?? "openrouter/healer-alpha",
      fallbackModel,
      screeningBaseUrl: u.screeningBaseUrl ?? null,
      screeningApiKey: u.screeningApiKey ?? null,
      managementBaseUrl: u.managementBaseUrl ?? null,
      managementApiKey: u.managementApiKey ?? null,
      generalBaseUrl: u.generalBaseUrl ?? null,
      generalApiKey: u.generalApiKey ?? null,
    },

    darwin: {
      enabled: u.darwinEnabled ?? true,
      windowDays: u.darwinWindowDays ?? 60,
      recalcEvery: u.darwinRecalcEvery ?? 5,
      boostFactor: u.darwinBoost ?? 1.05,
      decayFactor: u.darwinDecay ?? 0.95,
      weightFloor: u.darwinFloor ?? 0.3,
      weightCeiling: u.darwinCeiling ?? 2.5,
      minSamples: u.darwinMinSamples ?? 10,
      perSignalMinSamples: u.darwinPerSignalMinSamples ?? 12,
      minAbsLiftToAdjust: u.darwinMinAbsLiftToAdjust ?? 0.05,
      strongLiftThreshold: u.darwinStrongLiftThreshold ?? 0.2,
      calibrationMinSamples: u.darwinCalibrationMinSamples ?? 20,
      meanReversionRate: u.darwinMeanReversionRate ?? 0.02,
    },

    autoresearch: {
      enabled: u.autoresearchEnabled ?? true,
      mode: u.autoresearchMode ?? "shadow",
      maxActiveTrials: u.autoresearchMaxActiveTrials ?? 3,
      minClosesPerTrial: u.autoresearchMinClosesPerTrial ?? 12,
      minEvaluableCloses: u.autoresearchMinEvaluableCloses ?? 8,
      minRejectedCloses: u.autoresearchMinRejectedCloses ?? 3,
      minAbsoluteWinRateDeltaPct: u.autoresearchMinAbsoluteWinRateDeltaPct ?? 8,
      minAbsolutePnlDeltaPct: u.autoresearchMinAbsolutePnlDeltaPct ?? 0.75,
      lookbackDays: u.autoresearchLookbackDays ?? 45,
    },

    tokens: {
      SOL: "So11111111111111111111111111111111111111112",
      USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    },

    hiveMind: {
      url: firstNonEmptyString(u.hiveMindUrl, DEFAULT_HIVEMIND_URL) ?? DEFAULT_HIVEMIND_URL,
      apiKey: firstNonEmptyString(u.hiveMindApiKey, env.HIVEMIND_API_KEY, DEFAULT_HIVEMIND_API_KEY) ?? DEFAULT_HIVEMIND_API_KEY,
      agentId: u.agentId ?? null,
      pullMode: u.hiveMindPullMode ?? "auto",
    },

    api: {
      url: firstNonEmptyString(u.agentMeridianApiUrl, env.AGENT_MERIDIAN_API_URL, DEFAULT_AGENT_MERIDIAN_API_URL) ?? DEFAULT_AGENT_MERIDIAN_API_URL,
      publicApiKey: firstNonEmptyString(u.publicApiKey, env.PUBLIC_API_KEY, DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY) ?? DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY,
      lpAgentRelayEnabled: u.lpAgentRelayEnabled ?? false,
    },

    jupiter: {
      apiKey: firstNonEmptyString(env.JUPITER_API_KEY) ?? "",
      referralAccount:
        firstNonEmptyString(env.JUPITER_REFERRAL_ACCOUNT, "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey")
        ?? "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey",
      referralFeeBps: Number(env.JUPITER_REFERRAL_FEE_BPS ?? 50),
    },

    indicators: {
      enabled: indicatorUserConfig.enabled ?? false,
      entryPreset: "entryPreset" in indicatorUserConfig ? indicatorUserConfig.entryPreset : "supertrend_break",
      exitPreset: "exitPreset" in indicatorUserConfig ? indicatorUserConfig.exitPreset : "supertrend_break",
      rsiLength: indicatorUserConfig.rsiLength ?? 2,
      intervals: Array.isArray(indicatorUserConfig.intervals)
        ? indicatorUserConfig.intervals
        : ["5_MINUTE", "15_MINUTE"],
      candles: indicatorUserConfig.candles ?? 298,
      rsiOversold: indicatorUserConfig.rsiOversold ?? 30,
      rsiOverbought: indicatorUserConfig.rsiOverbought ?? 80,
      requireAllIntervals: indicatorUserConfig.requireAllIntervals ?? false,
    },
  };
}

export function resolveConfigFromPath(userConfigPath, { env = process.env, applyEnv = false } = {}) {
  const userConfigExists = fs.existsSync(userConfigPath);
  const userConfig = userConfigExists ? JSON.parse(fs.readFileSync(userConfigPath, "utf8")) : {};
  if (applyEnv) {
    applyUserConfigToEnv(userConfig, env);
  }
  return {
    userConfigPath,
    userConfigExists,
    userConfig,
    config: buildConfig(userConfig, env),
  };
}
