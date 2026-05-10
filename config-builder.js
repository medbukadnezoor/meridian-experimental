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

const SCREENING_REASONING_EFFORTS = new Set(["low", "medium", "high"]);
const SCREENING_SOURCES = new Set(["meteora", "gmgn", "both"]);

export function normalizeScreeningReasoningEffort(value) {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  return SCREENING_REASONING_EFFORTS.has(normalized) ? normalized : null;
}

export function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

export function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function normalizeScreeningSource(value) {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  return SCREENING_SOURCES.has(normalized) ? normalized : "meteora";
}

export function normalizeDeepSeekThinking(value) {
  if (value === true) return "enabled";
  if (value === false || value == null) return "disabled";
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  return normalized === "enabled" || normalized === "true" ? "enabled" : "disabled";
}

export function firstNonEmptyString(...values) {
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
    if (normalized) return normalized;
  }
  return undefined;
}

export const DEEPSEEK_OPENAI_BASE_URL = "https://api.deepseek.com";

export function isDeepSeekBaseUrl(value) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return false;
  try {
    const hostname = new URL(normalized).hostname.toLowerCase();
    return hostname === "api.deepseek.com";
  } catch {
    return false;
  }
}

export function isDeepSeekModel(value) {
  return normalizeOptionalString(value)?.toLowerCase().startsWith("deepseek-") ?? false;
}

export function resolveEnvReference(value, env = process.env) {
  const normalized = normalizeOptionalString(value);
  const match = normalized?.match(/^env:([A-Z0-9_]+)$/i);
  if (!match) return normalized;
  return normalizeOptionalString(env[match[1]]);
}

export function resolveRoleApiKey(configuredApiKey, roleBaseUrl, roleModel, env = process.env, globalApiKey = undefined) {
  return firstNonEmptyString(
    resolveEnvReference(configuredApiKey, env),
    isDeepSeekBaseUrl(roleBaseUrl) || isDeepSeekModel(roleModel) ? env.DEEPSEEK_API_KEY : undefined,
    globalApiKey
  );
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

function configValue(configObject, key, legacyObject, legacyKey, fallback) {
  return configObject?.[key] ?? legacyObject?.[legacyKey] ?? fallback;
}

function configArray(configObject, key, legacyObject, legacyKey, fallback) {
  if (Array.isArray(configObject?.[key])) return configObject[key];
  if (Array.isArray(legacyObject?.[legacyKey])) return legacyObject[legacyKey];
  return fallback;
}

export function applyUserConfigToEnv(userConfig, env = process.env) {
  const u = userConfig ?? {};
  const g = u.gmgn ?? {};
  if (u.rpcUrl) env.RPC_URL ||= u.rpcUrl;
  if (u.walletKey) env.WALLET_PRIVATE_KEY ||= u.walletKey;
  if (u.llmModel) env.LLM_MODEL ||= u.llmModel;
  if (u.llmBaseUrl) env.LLM_BASE_URL ||= u.llmBaseUrl;
  {
    const llmApiKey = resolveEnvReference(u.llmApiKey, env);
    if (llmApiKey) env.LLM_API_KEY ||= llmApiKey;
  }
  if (u.dryRun !== undefined) env.DRY_RUN ||= String(u.dryRun);
  if (u.publicApiKey) env.PUBLIC_API_KEY ||= u.publicApiKey;
  if (u.agentMeridianApiUrl) env.AGENT_MERIDIAN_API_URL ||= u.agentMeridianApiUrl;
  {
    const gmgnApiKey = resolveEnvReference(g.apiKey ?? u.gmgnApiKey, env);
    if (gmgnApiKey) env.GMGN_API_KEY ||= gmgnApiKey;
  }
}

export function buildConfig(userConfig = {}, env = process.env) {
  const u = userConfig ?? {};
  const g = u.gmgn ?? {};
  const indicatorUserConfig = u.chartIndicators ?? {};
  const performanceUserConfig = u.performance ?? {};
  const fallbackModel = normalizeOptionalString(u.fallbackModel);
  const isNanocapPreset = String(u.preset ?? "").toLowerCase().includes("nanocap");
  const globalLlmBaseUrl = firstNonEmptyString(env.LLM_BASE_URL, "https://openrouter.ai/api/v1");
  const globalLlmApiKey = firstNonEmptyString(env.LLM_API_KEY, env.OPENROUTER_API_KEY);
  const screeningBaseUrl = u.screeningBaseUrl ?? null;
  const screeningFallbackBaseUrl = u.screeningFallbackBaseUrl ?? null;
  const managementBaseUrl = u.managementBaseUrl ?? null;
  const generalBaseUrl = u.generalBaseUrl ?? null;
  const managementModel = u.managementModel ?? env.LLM_MODEL ?? "openrouter/healer-alpha";
  const screeningModel = u.screeningModel ?? env.LLM_MODEL ?? "openrouter/hunter-alpha";
  const generalModel = u.generalModel ?? env.LLM_MODEL ?? "openrouter/healer-alpha";
  const screeningFallbackModel = u.screeningFallbackModel ?? null;

  return {
    risk: {
      maxPositions: u.maxPositions ?? 3,
      maxDeployAmount: u.maxDeployAmount ?? 50,
    },

    screening: {
      source: normalizeScreeningSource(u.screening?.source ?? u.screeningSource),
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
      excludeHighSingleOwnership: u.excludeHighSingleOwnership ?? true,
      discoveryPageSize: u.discoveryPageSize ?? 50,
      discoveryExtraCategories: Array.isArray(u.discoveryExtraCategories) ? u.discoveryExtraCategories : [],
      maxBundlePct: u.maxBundlePct ?? 30,
      maxBotHoldersPct: u.maxBotHoldersPct ?? 30,
      maxTop10Pct: u.maxTop10Pct ?? 60,
      allowedLaunchpads: u.allowedLaunchpads ?? [],
      blockedLaunchpads: u.blockedLaunchpads ?? [],
      minTokenAgeHours: u.minTokenAgeHours ?? null,
      maxTokenAgeHours: u.maxTokenAgeHours ?? null,
      athFilterPct: u.athFilterPct ?? null,
      fallingKnifeVetoEnabled: u.fallingKnifeVetoEnabled ?? isNanocapPreset,
      fallingKnifeMaxPriceChange1hPct: u.fallingKnifeMaxPriceChange1hPct ?? -35,
      fallingKnifeSeverePriceChangePct: u.fallingKnifeSeverePriceChangePct ?? -45,
      fallingKnifeMinSellBuyRatio: u.fallingKnifeMinSellBuyRatio ?? 1.25,
      fallingKnifeRequireOversoldRsi: u.fallingKnifeRequireOversoldRsi ?? false,
      suspiciousVolumeVetoEnabled: u.suspiciousVolumeVetoEnabled ?? isNanocapPreset,
      suspiciousVolumeMaxMcapToGlobalFeesRatio: u.suspiciousVolumeMaxMcapToGlobalFeesRatio ?? 12000,
      suspiciousVolumeMinGlobalFeesSol: u.suspiciousVolumeMinGlobalFeesSol ?? 20,
      suspiciousVolumeMaxTokenAgeHours: u.suspiciousVolumeMaxTokenAgeHours ?? 96,
      suspiciousVolumeMinPriceDropPct: u.suspiciousVolumeMinPriceDropPct ?? -25,
    },

    gmgn: {
      apiKey: firstNonEmptyString(resolveEnvReference(g.apiKey, env), resolveEnvReference(u.gmgnApiKey, env), env.GMGN_API_KEY) ?? null,
      baseUrl: firstNonEmptyString(g.baseUrl, u.gmgnBaseUrl, "https://openapi.gmgn.ai") ?? "https://openapi.gmgn.ai",
      interval: configValue(g, "interval", u, "gmgnInterval", "1h"),
      orderBy: configValue(g, "orderBy", u, "gmgnOrderBy", "volume"),
      direction: configValue(g, "direction", u, "gmgnDirection", "desc"),
      limit: configValue(g, "limit", u, "gmgnLimit", 100),
      enrichLimit: configValue(g, "enrichLimit", u, "gmgnEnrichLimit", 20),
      requestDelayMs: configValue(g, "requestDelayMs", u, "gmgnRequestDelayMs", 2500),
      maxRetries: configValue(g, "maxRetries", u, "gmgnMaxRetries", 0),
      holdersLimit: configValue(g, "holdersLimit", u, "gmgnHoldersLimit", 100),
      filters: configArray(g, "filters", u, "gmgnFilters", ["renounced", "frozen", "not_wash_trading"]),
      platforms: configArray(g, "platforms", u, "gmgnPlatforms", ["Pump.fun", "meteora_virtual_curve", "pool_meteora"]),
      minMcap: configValue(g, "minMcap", u, "gmgnMinMcap", u.minMcap ?? 150_000),
      maxMcap: configValue(g, "maxMcap", u, "gmgnMaxMcap", u.maxMcap ?? 10_000_000),
      minTvl: configValue(g, "minTvl", u, "gmgnMinTvl", u.minTvl ?? 10_000),
      minVolume: configValue(g, "minVolume", u, "gmgnMinVolume", u.minVolume ?? 500),
      minHolders: configValue(g, "minHolders", u, "gmgnMinHolders", u.minHolders ?? 500),
      minTokenAgeHours: configValue(g, "minTokenAgeHours", u, "gmgnMinTokenAgeHours", u.minTokenAgeHours ?? null),
      maxTokenAgeHours: configValue(g, "maxTokenAgeHours", u, "gmgnMaxTokenAgeHours", u.maxTokenAgeHours ?? null),
      minSmartDegenCount: configValue(g, "minSmartDegenCount", u, "gmgnMinSmartDegenCount", 0),
      requireKol: configValue(g, "requireKol", u, "gmgnRequireKol", false),
      minKolCount: configValue(g, "minKolCount", u, "gmgnMinKolCount", 1),
      minTotalFeeSol: configValue(g, "minTotalFeeSol", u, "gmgnMinTotalFeeSol", u.minTokenFeesSol ?? 30),
      athFilterPct: configValue(g, "athFilterPct", u, "gmgnAthFilterPct", u.athFilterPct ?? null),
      maxTop10HolderRate: configValue(g, "maxTop10HolderRate", u, "gmgnMaxTop10HolderRate", (u.maxTop10Pct ?? 60) / 100),
      maxBundlerRate: configValue(g, "maxBundlerRate", u, "gmgnMaxBundlerRate", (u.maxBundlePct ?? 30) / 100),
      maxRatTraderRate: configValue(g, "maxRatTraderRate", u, "gmgnMaxRatTraderRate", 0.2),
      maxFreshWalletRate: configValue(g, "maxFreshWalletRate", u, "gmgnMaxFreshWalletRate", 0.2),
      maxDevTeamHoldRate: configValue(g, "maxDevTeamHoldRate", u, "gmgnMaxDevTeamHoldRate", 0.02),
      maxBotDegenRate: configValue(g, "maxBotDegenRate", u, "gmgnMaxBotDegenRate", (u.maxBotHoldersPct ?? 30) / 100),
      maxSniperHoldRate: configValue(g, "maxSniperHoldRate", u, "gmgnMaxSniperHoldRate", 0.3),
      preferredKolNames: configArray(g, "preferredKolNames", u, "gmgnPreferredKolNames", []),
      preferredKolMinHoldPct: configValue(g, "preferredKolMinHoldPct", u, "gmgnPreferredKolMinHoldPct", 1),
      dumpKolNames: configArray(g, "dumpKolNames", u, "gmgnDumpKolNames", []),
      dumpKolMinHoldPct: configValue(g, "dumpKolMinHoldPct", u, "gmgnDumpKolMinHoldPct", 0.5),
    },

    management: {
      minClaimAmount: u.minClaimAmount ?? 5,
      autoSwapAfterClaim: u.autoSwapAfterClaim ?? false,
      outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
      outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
      outOfRangeHardCloseMinutes: u.outOfRangeHardCloseMinutes ?? null,
      oorRepositionEnabled: u.oorRepositionEnabled ?? false,
      oorRepositionCandidateLimit: u.oorRepositionCandidateLimit ?? 25,
      adaptiveCloseModeEnabled: u.adaptiveCloseModeEnabled ?? false,
      adaptiveCloseFastZapTimeoutMs: u.adaptiveCloseFastZapTimeoutMs ?? 1500,
      adaptiveCloseModes: u.adaptiveCloseModes ?? {
        hard_stop: "local_liquidity_first",
        fast_stop: "local_liquidity_first",
        velocity_stop: "local_liquidity_first",
        rolling_drawdown: "fast_zap_attempt",
        profit_giveback: "fast_zap_attempt",
        low_yield: "relay_zap_normal",
        oor_above: "relay_zap_normal",
        manual: "relay_zap_normal",
      },
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
      stopLossFastClosePct: u.stopLossFastClosePct ?? (isNanocapPreset ? -10 : null),
      stopLossVelocityWindowMs: u.stopLossVelocityWindowMs ?? (isNanocapPreset ? 90_000 : null),
      stopLossVelocityClosePct: u.stopLossVelocityClosePct ?? (isNanocapPreset ? -3 : null),
      rollingDrawdownExitEnabled: u.rollingDrawdownExitEnabled ?? false,
      rollingDrawdownWindowMs: u.rollingDrawdownWindowMs ?? 5_400_000,
      rollingDrawdownMinPeakPct: u.rollingDrawdownMinPeakPct ?? 1,
      rollingDrawdownCurrentPnlPct: u.rollingDrawdownCurrentPnlPct ?? -2,
      rollingDrawdownMinDropPct: u.rollingDrawdownMinDropPct ?? 4,
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
      // When true: TP (Rule 2) and confirmed trailing TP close directly — no LLM,
      // no relay, no poll cooldown — same fast path as stop-loss.
      // When false (legacy): TP goes through runManagementCycle → LLM → close_position.
      tpDirectCloseEnabled: u.tpDirectCloseEnabled ?? true,
      // When true: direct TP close uses urgent=true (priority fees, 2 tx attempts).
      // When false: urgent=false (no priority fee bump, 1 attempt).
      tpDirectCloseUrgent: u.tpDirectCloseUrgent ?? false,
      profitGivebackEmergencyEnabled: u.profitGivebackEmergencyEnabled ?? isNanocapPreset,
      profitGivebackTriggerPct: u.profitGivebackTriggerPct ?? (isNanocapPreset ? 6 : null),
      profitGivebackFloorPct: u.profitGivebackFloorPct ?? (isNanocapPreset ? 2 : null),
      supertrendLossExitEnabled: u.supertrendLossExitEnabled ?? isNanocapPreset,
      supertrendLossExitPnlPct: u.supertrendLossExitPnlPct ?? (isNanocapPreset || u.supertrendLossExitEnabled ? -4 : null),
      supertrendLossExitInterval: u.supertrendLossExitInterval ?? "15_MINUTE",
      supertrendLossExitConfirmChecks: u.supertrendLossExitConfirmChecks ?? 2,
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
      forceSingleSidedSolBidAsk: u.forceSingleSidedSolBidAsk ?? isNanocapPreset,
      // Nanocap prompt canon is 35-90 bins below; keep live guard deterministic.
      minSingleSidedSolBins: u.minSingleSidedSolBins ?? (isNanocapPreset ? 35 : 5),
      minSingleSidedSolDownsidePct: u.minSingleSidedSolDownsidePct ?? (isNanocapPreset ? 1 : null),
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
      managementModel,
      screeningModel,
      generalModel,
      fallbackModel,
      screeningBaseUrl,
      screeningApiKey: resolveRoleApiKey(u.screeningApiKey, screeningBaseUrl ?? globalLlmBaseUrl, screeningModel, env, globalLlmApiKey) ?? null,
      screeningThinking: normalizeDeepSeekThinking(u.screeningThinking),
      screeningReasoningEffort: normalizeScreeningReasoningEffort(u.screeningReasoningEffort),
      screeningFallbackModel,
      screeningFallbackBaseUrl,
      screeningFallbackApiKey: resolveRoleApiKey(u.screeningFallbackApiKey, screeningFallbackBaseUrl ?? globalLlmBaseUrl, screeningFallbackModel, env, globalLlmApiKey) ?? null,
      managementBaseUrl,
      managementApiKey: resolveRoleApiKey(u.managementApiKey, managementBaseUrl ?? globalLlmBaseUrl, managementModel, env, globalLlmApiKey) ?? null,
      generalBaseUrl,
      generalApiKey: resolveRoleApiKey(u.generalApiKey, generalBaseUrl ?? globalLlmBaseUrl, generalModel, env, globalLlmApiKey) ?? null,
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

    performance: {
      materialWinPct: performanceUserConfig.materialWinPct ?? u.materialWinPct ?? 1.0,
      materialLossPct: performanceUserConfig.materialLossPct ?? u.materialLossPct ?? -1.0,
      dustNeutralAbsPct: performanceUserConfig.dustNeutralAbsPct ?? u.dustNeutralAbsPct ?? 1.0,
      neutralCloseReasonBuckets: Array.isArray(performanceUserConfig.neutralCloseReasonBuckets)
        ? performanceUserConfig.neutralCloseReasonBuckets
        : (Array.isArray(u.neutralCloseReasonBuckets) ? u.neutralCloseReasonBuckets : ["low_yield", "operator"]),
      darwinUseMaterialOutcomes: performanceUserConfig.darwinUseMaterialOutcomes ?? u.darwinUseMaterialOutcomes ?? true,
      darwinExcludeNeutralOutcomes: performanceUserConfig.darwinExcludeNeutralOutcomes ?? u.darwinExcludeNeutralOutcomes ?? true,
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
