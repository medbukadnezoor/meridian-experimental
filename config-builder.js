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
const SCREENING_SOURCES = new Set(["meteora", "gmgn", "okx", "both", "all", "gmgn+okx", "meteora+okx"]);
const PNL_SOURCES = new Set(["legacy", "rpc", "shadow"]);

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

function normalizeNullableNumber(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function configValueAllowNull(config, key, fallback = null) {
  return Object.prototype.hasOwnProperty.call(config, key) ? config[key] : fallback;
}

export function normalizeScreeningSource(value) {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  return SCREENING_SOURCES.has(normalized) ? normalized : "meteora";
}

function normalizePnlSource(value) {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  return PNL_SOURCES.has(normalized) ? normalized : "legacy";
}

function buildOkxDiscoveryConfig(userConfig = {}) {
  const o = userConfig.screening?.okxDiscovery ?? userConfig.okxDiscovery ?? {};
  return {
    enabled: o.enabled ?? false,
    shadowMode: o.shadowMode ?? true,
    pollMs: o.pollMs ?? 60_000,
    mintCooldownMins: o.mintCooldownMins ?? 60,
    watchlistTtlMins: o.watchlistTtlMins ?? 180,
    maxWatchMints: o.maxWatchMints ?? 120,
    maxCandidatesPerPoll: o.maxCandidatesPerPoll ?? 4,
    seedLimit: o.seedLimit ?? 100,
    timeFrame: o.timeFrame ?? "1",
    rankBy: o.rankBy ?? "5",
    includeBundleInfo: o.includeBundleInfo ?? false,
    baseline: {
      minHolders: o.baseline?.minHolders ?? 100,
      minLiquidityUsd: o.baseline?.minLiquidityUsd ?? 5000,
      minMcapUsd: o.baseline?.minMcapUsd ?? 0,
      maxMcapUsd: o.baseline?.maxMcapUsd ?? 0,
      maxTop10HolderRate: o.baseline?.maxTop10HolderRate ?? 0.5,
      maxRugRatio: o.baseline?.maxRugRatio ?? 0.3,
      maxBundlerRate: o.baseline?.maxBundlerRate ?? 0.5,
      maxBotRate: o.baseline?.maxBotRate ?? 0.5,
      maxCreatorBalanceRate: o.baseline?.maxCreatorBalanceRate ?? 0.2,
      requireNotWashTrading: o.baseline?.requireNotWashTrading ?? true,
    },
    trigger: {
      minScans: o.trigger?.minScans ?? 2,
      minHolderGrowthPct: o.trigger?.minHolderGrowthPct ?? 3,
      maxLiquidityDropPct: o.trigger?.maxLiquidityDropPct ?? 30,
      minBuySellRatio: o.trigger?.minBuySellRatio ?? 1.1,
    },
  };
}

function normalizeMissingDataPolicy(value, fallback = "skip") {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  return ["reject", "skip", "warn"].includes(normalized) ? normalized : fallback;
}

function buildPreEntryMomentumGatesConfig(userConfig = {}) {
  const gate = userConfig.screening?.preEntryMomentumGates ?? userConfig.preEntryMomentumGates ?? {};
  return {
    enabled: gate.enabled === true,
    minReturnPct: normalizeNullableNumber(gate.minReturnPct),
    maxReturnPct: normalizeNullableNumber(gate.maxReturnPct),
    minVolumeRatio: normalizeNullableNumber(gate.minVolumeRatio),
    maxVolumeRatio: normalizeNullableNumber(gate.maxVolumeRatio),
    missingDataPolicy: normalizeMissingDataPolicy(gate.missingDataPolicy, "skip"),
  };
}

function buildFeeExitPolicyConfig(userConfig = {}) {
  const policy = userConfig.management?.feeExitPolicy ?? userConfig.feeExitPolicy ?? userConfig.fnmfFeeExitPolicy ?? {};
  return {
    enabled: policy.enabled === true,
    shadowOnly: policy.shadowOnly !== false,
    dustFloor: normalizeNullableNumber(policy.dustFloor, 0),
    strategyProfile: normalizeOptionalString(policy.strategyProfile),
    feeHarvestEnabled: policy.feeHarvestEnabled === true,
    feeHarvestMinHoldMinutes: normalizeNullableNumber(policy.feeHarvestMinHoldMinutes),
    feeHarvestMinFeePctOfEntry: normalizeNullableNumber(policy.feeHarvestMinFeePctOfEntry),
    feeHarvestMinFeeAmount: normalizeNullableNumber(policy.feeHarvestMinFeeAmount),
    feeHarvestMinNetPnlPct: normalizeNullableNumber(policy.feeHarvestMinNetPnlPct),
    feeHarvestBypassConfluenceMinFeePctOfEntry: normalizeNullableNumber(policy.feeHarvestBypassConfluenceMinFeePctOfEntry, 2.0),
    feeHarvestBypassConfluenceMinNetPnlPct: normalizeNullableNumber(policy.feeHarvestBypassConfluenceMinNetPnlPct, 0.25),
    feeHarvestBypassConfluenceStrongNetPnlPct: normalizeNullableNumber(policy.feeHarvestBypassConfluenceStrongNetPnlPct, 0.75),
    noFeeAbortEnabled: policy.noFeeAbortEnabled === true,
    noFeeAbortMaxHoldMinutes: normalizeNullableNumber(policy.noFeeAbortMaxHoldMinutes),
    noFeeAbortMaxFeePctOfEntry: normalizeNullableNumber(policy.noFeeAbortMaxFeePctOfEntry),
    noFeeAbortMaxFeeAmount: normalizeNullableNumber(policy.noFeeAbortMaxFeeAmount),
    noFeeAbortMaxNetPnlPct: normalizeNullableNumber(policy.noFeeAbortMaxNetPnlPct),
    feeConditionalAbortEnabled: policy.feeConditionalAbortEnabled === true,
    feeConditionalAbortMinHoldMinutes: normalizeNullableNumber(policy.feeConditionalAbortMinHoldMinutes),
    feeConditionalAbortMaxFeePctOfEntry: normalizeNullableNumber(policy.feeConditionalAbortMaxFeePctOfEntry),
    feeConditionalAbortMaxFeeAmount: normalizeNullableNumber(policy.feeConditionalAbortMaxFeeAmount),
    feeConditionalAbortMaxNetPnlPct: normalizeNullableNumber(policy.feeConditionalAbortMaxNetPnlPct),
    feeConditionalAbortMinLossPct: normalizeNullableNumber(policy.feeConditionalAbortMinLossPct),
    emergencyFailsafeEnabled: policy.emergencyFailsafeEnabled === true,
    emergencyFailsafeMinHoldMinutes: normalizeNullableNumber(policy.emergencyFailsafeMinHoldMinutes),
    emergencyFailsafeMaxFeePctOfEntry: normalizeNullableNumber(policy.emergencyFailsafeMaxFeePctOfEntry),
    emergencyFailsafeMinLossPct: normalizeNullableNumber(policy.emergencyFailsafeMinLossPct),
    maxHoldTimeoutEnabled: policy.maxHoldTimeoutEnabled === true,
    maxHoldTimeoutMinutes: normalizeNullableNumber(policy.maxHoldTimeoutMinutes),
    maxHoldTimeoutMinNetPnlPct: normalizeNullableNumber(policy.maxHoldTimeoutMinNetPnlPct),
    exitConfluenceEnabled: policy.exitConfluenceEnabled === true,
    exitConfluenceMinSignals: normalizeNullableNumber(policy.exitConfluenceMinSignals, 2),
    exitConfluenceRsiPeriod: normalizeNullableNumber(policy.exitConfluenceRsiPeriod, 2),
    exitConfluenceRsiOverbought: normalizeNullableNumber(policy.exitConfluenceRsiOverbought, 90),
    exitConfluenceBbPeriod: normalizeNullableNumber(policy.exitConfluenceBbPeriod, 20),
    exitConfluenceBbStdDev: normalizeNullableNumber(policy.exitConfluenceBbStdDev, 2),
    exitConfluenceAggregateMin: normalizeNullableNumber(policy.exitConfluenceAggregateMin, 3),
    exitConfluenceLookbackMinutes: normalizeNullableNumber(policy.exitConfluenceLookbackMinutes, 90),
    exitConfluenceClosedCandlesOnly: policy.exitConfluenceClosedCandlesOnly !== false,
    exitConfluenceCandleCloseLagSeconds: normalizeNullableNumber(policy.exitConfluenceCandleCloseLagSeconds, 10),
    exitConfluenceRules: Array.isArray(policy.exitConfluenceRules) ? policy.exitConfluenceRules : ["fee_harvest", "max_hold_timeout"],
    maxHoldTimeoutBypassesConfluence: policy.maxHoldTimeoutBypassesConfluence === true,
    positiveOnly: policy.positiveOnly === true,
    recoveryHoldPositiveOnly: policy.recoveryHoldPositiveOnly === true,
  };
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
  const s = u.screening ?? {};
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
      minVolumeActiveTvlMultiple: u.minVolumeActiveTvlMultiple ?? null,
      preferredVolumeActiveTvlMultiple: u.preferredVolumeActiveTvlMultiple ?? null,
      dynamicEntryShadowAssumedDeployUsd: u.dynamicEntryShadowAssumedDeployUsd ?? s.dynamicEntryShadowAssumedDeployUsd ?? null,
      twoLaneClassificationLoggingEnabled: u.twoLaneClassificationLoggingEnabled ?? true,
      twoLanePrimaryVolumeActiveTvlMultiple: u.twoLanePrimaryVolumeActiveTvlMultiple ?? 3,
      looseVolumeActiveTvlMultiple: u.looseVolumeActiveTvlMultiple ?? 2.5,
      feeVelocityShadowDownsidePct: Array.isArray(u.feeVelocityShadowDownsidePct) ? u.feeVelocityShadowDownsidePct : [7, 10, 12, 15, 20, 25],
      feeVelocityShadowTakeProfitPct: Array.isArray(u.feeVelocityShadowTakeProfitPct) ? u.feeVelocityShadowTakeProfitPct : [6, 7, 8],
      feeVelocityShadowFeeTvlFloors: Array.isArray(u.feeVelocityShadowFeeTvlFloors) ? u.feeVelocityShadowFeeTvlFloors : [0.12, 0.15, 0.19],
      feeVelocityShadowPumpThresholds: Array.isArray(u.feeVelocityShadowPumpThresholds) ? u.feeVelocityShadowPumpThresholds : [30, 50, 100],
      feeVelocityShadowSellBuyThresholds: Array.isArray(u.feeVelocityShadowSellBuyThresholds) ? u.feeVelocityShadowSellBuyThresholds : [1.2, 1.5, 2.0],
      feeVelocityShadowVolTvlThresholds: Array.isArray(u.feeVelocityShadowVolTvlThresholds) ? u.feeVelocityShadowVolTvlThresholds : [3.5, 4.0, 4.5, 5.0, 6.0, 8.0],
      sameTickerSurfEnabled: u.sameTickerSurfEnabled ?? false,
      samePoolPostWinDecayEnabled: u.samePoolPostWinDecayEnabled ?? false,
      samePoolPostWinCooldownMinutes: u.samePoolPostWinCooldownMinutes ?? 0,
      samePoolPostWinMaterialPnlPct: u.samePoolPostWinMaterialPnlPct ?? 1,
      samePoolPostWinRequireFreshDecayPass: u.samePoolPostWinRequireFreshDecayPass ?? false,
      ohlcvEntryVetoShadowEnabled: u.ohlcvEntryVetoShadowEnabled ?? true,
      ohlcvEntryVetoLiveEnabled: u.ohlcvEntryVetoLiveEnabled ?? false,
      ohlcvEntryVetoHighDrawdownPct: u.ohlcvEntryVetoHighDrawdownPct ?? -45,
      ohlcvEntryVetoEntryDrawdownPct: u.ohlcvEntryVetoEntryDrawdownPct ?? -20,
      ohlcvEntryVetoExtremePriceChangePct: u.ohlcvEntryVetoExtremePriceChangePct ?? 500,
      ohlcvEntryVetoRequireCompound: u.ohlcvEntryVetoRequireCompound ?? true,
      ohlcvEntryVetoLiveReasonCodes: Array.isArray(u.ohlcvEntryVetoLiveReasonCodes)
        ? u.ohlcvEntryVetoLiveReasonCodes
        : ["high_drawdown_with_extreme_positive_candidate_price_change"],
      targetPoolNeedleVetoShadowEnabled: s.targetPoolNeedleVetoShadowEnabled ?? u.targetPoolNeedleVetoShadowEnabled ?? true,
      targetPoolNeedleVetoLiveEnabled: s.targetPoolNeedleVetoLiveEnabled ?? u.targetPoolNeedleVetoLiveEnabled ?? false,
      targetPoolNeedleVetoLookbackMinutes: s.targetPoolNeedleVetoLookbackMinutes ?? u.targetPoolNeedleVetoLookbackMinutes ?? 60,
      targetPoolNeedleVetoAggregateMin: s.targetPoolNeedleVetoAggregateMin ?? u.targetPoolNeedleVetoAggregateMin ?? 1,
      targetPoolNeedleVetoShortlistLimit: s.targetPoolNeedleVetoShortlistLimit ?? u.targetPoolNeedleVetoShortlistLimit ?? 3,
      targetPoolNeedleVetoMinWindowRows: s.targetPoolNeedleVetoMinWindowRows ?? u.targetPoolNeedleVetoMinWindowRows ?? 3,
      targetPoolNeedleVetoHighDrawdownPct: s.targetPoolNeedleVetoHighDrawdownPct ?? u.targetPoolNeedleVetoHighDrawdownPct ?? -45,
      targetPoolNeedleVetoMinHighRunupPct: s.targetPoolNeedleVetoMinHighRunupPct ?? u.targetPoolNeedleVetoMinHighRunupPct ?? 50,
      targetPoolNeedleVetoLiveReasonCodes: Array.isArray(s.targetPoolNeedleVetoLiveReasonCodes)
        ? s.targetPoolNeedleVetoLiveReasonCodes
        : Array.isArray(u.targetPoolNeedleVetoLiveReasonCodes)
        ? u.targetPoolNeedleVetoLiveReasonCodes
        : ["target_pool_high_needle_retrace"],
      fabriqOhlcvEntryGateEnabled: s.fabriqOhlcvEntryGateEnabled ?? u.fabriqOhlcvEntryGateEnabled ?? false,
      fabriqOhlcvEntryGateMode: s.fabriqOhlcvEntryGateMode ?? u.fabriqOhlcvEntryGateMode ?? "shadow",
      fabriqOhlcvEntryGateProviders: Array.isArray(s.fabriqOhlcvEntryGateProviders)
        ? s.fabriqOhlcvEntryGateProviders
        : Array.isArray(u.fabriqOhlcvEntryGateProviders)
          ? u.fabriqOhlcvEntryGateProviders
          : ["dexpaprika", "gmgn", "okx"],
      fabriqOhlcvEntryGateDecisiveProviderOrder: Array.isArray(s.fabriqOhlcvEntryGateDecisiveProviderOrder)
        ? s.fabriqOhlcvEntryGateDecisiveProviderOrder
        : Array.isArray(u.fabriqOhlcvEntryGateDecisiveProviderOrder)
          ? u.fabriqOhlcvEntryGateDecisiveProviderOrder
          : ["dexpaprika", "gmgn", "okx"],
      fabriqOhlcvEntryGateIntervals: Array.isArray(s.fabriqOhlcvEntryGateIntervals)
        ? s.fabriqOhlcvEntryGateIntervals
        : Array.isArray(u.fabriqOhlcvEntryGateIntervals)
          ? u.fabriqOhlcvEntryGateIntervals
          : ["1m", "5m", "15m"],
      fabriqOhlcvEntryGateLookbackMinutes: s.fabriqOhlcvEntryGateLookbackMinutes ?? u.fabriqOhlcvEntryGateLookbackMinutes ?? 180,
      fabriqOhlcvEntryGateMinRows: s.fabriqOhlcvEntryGateMinRows ?? u.fabriqOhlcvEntryGateMinRows ?? 20,
      fabriqOhlcvEntryGateMinScore: s.fabriqOhlcvEntryGateMinScore ?? u.fabriqOhlcvEntryGateMinScore ?? 3,
      fabriqOhlcvEntryGateBlockOnMissingOhlcv: s.fabriqOhlcvEntryGateBlockOnMissingOhlcv ?? u.fabriqOhlcvEntryGateBlockOnMissingOhlcv ?? true,
      criticalThinEntryOverlayEnabled: s.criticalThinEntryOverlayEnabled ?? u.criticalThinEntryOverlayEnabled ?? false,
      criticalThinEntryOverlayMode: s.criticalThinEntryOverlayMode ?? u.criticalThinEntryOverlayMode ?? "shadow",
      criticalThinMcapUsd: s.criticalThinMcapUsd ?? u.criticalThinMcapUsd ?? 275_000,
      criticalThinActiveTvlUsd: s.criticalThinActiveTvlUsd ?? u.criticalThinActiveTvlUsd ?? 5_000,
      criticalThinWatchMcapUsd: s.criticalThinWatchMcapUsd ?? u.criticalThinWatchMcapUsd ?? 450_000,
      criticalThinWatchActiveTvlUsd: s.criticalThinWatchActiveTvlUsd ?? u.criticalThinWatchActiveTvlUsd ?? 10_000,
      criticalThinRequireChartAccept: s.criticalThinRequireChartAccept ?? u.criticalThinRequireChartAccept ?? true,
      criticalThinMinFeeActiveTvlRatio: s.criticalThinMinFeeActiveTvlRatio ?? u.criticalThinMinFeeActiveTvlRatio ?? 3,
      criticalThinMinVolumeActiveTvlMultiple: s.criticalThinMinVolumeActiveTvlMultiple ?? u.criticalThinMinVolumeActiveTvlMultiple ?? 5,
      criticalThinBlockOnMissingInputs: s.criticalThinBlockOnMissingInputs ?? u.criticalThinBlockOnMissingInputs ?? true,
      preEntryMomentumGates: buildPreEntryMomentumGatesConfig(u),
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
      athMinPriceVsAthPct: u.athMinPriceVsAthPct ?? null,
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
      okxDiscovery: buildOkxDiscoveryConfig(u),
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
      athMinPriceVsAthPct: configValue(g, "athMinPriceVsAthPct", u, "gmgnAthMinPriceVsAthPct", u.athMinPriceVsAthPct ?? null),
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

    pnl: {
      source: normalizePnlSource(u.pnl?.source ?? u.pnlSource),
      rpcUrl: firstNonEmptyString(u.pnl?.rpcUrl, u.pnlRpcUrl, "https://pump.helius-rpc.com") ?? "https://pump.helius-rpc.com",
      depositCacheTtlSec: normalizePositiveInteger(u.pnl?.depositCacheTtlSec ?? u.pnlDepositCacheTtlSec, 300),
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
      noFeeAbortCooldownHours: u.noFeeAbortCooldownHours ?? 12,
      velocityStopCooldownHours: u.velocityStopCooldownHours ?? 24,
      repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
      repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 1,
      repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 1,
      repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "pool",
      repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
      repeatLowYieldCooldownEnabled: u.repeatLowYieldCooldownEnabled ?? false,
      repeatLowYieldCooldownTriggerCount: u.repeatLowYieldCooldownTriggerCount ?? 3,
      repeatLowYieldCooldownLookbackHours: u.repeatLowYieldCooldownLookbackHours ?? 48,
      repeatLowYieldCooldownHours: u.repeatLowYieldCooldownHours ?? 12,
      repeatLowYieldCooldownScope: u.repeatLowYieldCooldownScope ?? "token",
      minVolumeToRebalance: u.minVolumeToRebalance ?? 1000,
      recoveryHoldProfileEnabled: u.recoveryHoldProfileEnabled ?? false,
      recoveryHoldNonFeeExitMinNetPnlPct: u.recoveryHoldNonFeeExitMinNetPnlPct ?? 0,
      requirePositivePnlForOutOfRangeExit: u.requirePositivePnlForOutOfRangeExit ?? false,
      requirePositivePnlForLowYieldExit: u.requirePositivePnlForLowYieldExit ?? false,
      requirePositivePnlForMaxHoldExit: u.requirePositivePnlForMaxHoldExit ?? false,
      stopLossPct: configValueAllowNull(u, "stopLossPct", u.emergencyPriceDropPct ?? -50),
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
      profitGivebackEmergencyEnabled: u.profitGivebackEmergencyEnabled ?? isNanocapPreset,
      profitGivebackTriggerPct: u.profitGivebackTriggerPct ?? (isNanocapPreset ? 6 : null),
      profitGivebackFloorPct: u.profitGivebackFloorPct ?? (isNanocapPreset ? 2 : null),
      supertrendLossExitEnabled: u.supertrendLossExitEnabled ?? isNanocapPreset,
      supertrendLossExitPnlPct: u.supertrendLossExitPnlPct ?? (isNanocapPreset || u.supertrendLossExitEnabled ? -4 : null),
      supertrendLossExitInterval: u.supertrendLossExitInterval ?? "15_MINUTE",
      supertrendLossExitConfirmChecks: u.supertrendLossExitConfirmChecks ?? 2,
      ohlcvDrawdownShadowEnabled: u.ohlcvDrawdownShadowEnabled ?? true,
      ohlcvDrawdownShadowBotName: u.ohlcvDrawdownShadowBotName ?? (String(u.preset ?? "").toLowerCase().includes("nanocap") ? "nanocap" : "meridian"),
      ohlcvDrawdownShadowAggregateMin: u.ohlcvDrawdownShadowAggregateMin ?? 1,
      ohlcvDrawdownShadowEntryDrawdownPct: u.ohlcvDrawdownShadowEntryDrawdownPct ?? -20,
      ohlcvDrawdownShadowHighDrawdownPct: u.ohlcvDrawdownShadowHighDrawdownPct ?? -25,
      ohlcvDrawdownShadowPnlDivergenceMinPnlPct: u.ohlcvDrawdownShadowPnlDivergenceMinPnlPct ?? -2,
      ohlcvDrawdownShadowCombinedPeakPct: u.ohlcvDrawdownShadowCombinedPeakPct ?? 2,
      ohlcvDrawdownShadowCombinedCurrentPnlPct: u.ohlcvDrawdownShadowCombinedCurrentPnlPct ?? 0,
      activeBinBelowRangeEmergencyLiveEnabled: u.activeBinBelowRangeEmergencyLiveEnabled ?? false,
      activeBinBelowRangeEmergencyPnlPct: u.activeBinBelowRangeEmergencyPnlPct ?? -5,
      activeBinBelowRangeEmergencyEntryDrawdownPct: u.activeBinBelowRangeEmergencyEntryDrawdownPct ?? -20,
      activeBinVelocityEmergencyLiveEnabled: u.activeBinVelocityEmergencyLiveEnabled ?? false,
      activeBinVelocityEmergencyMaxPnlPct: u.activeBinVelocityEmergencyMaxPnlPct ?? 2,
      pnlSanityMaxDiffPct: u.pnlSanityMaxDiffPct ?? 5,
      pnlSnapshotLoggingEnabled: u.pnlSnapshotLoggingEnabled ?? false,
      pnlSnapshotDebug: u.pnlSnapshotDebug ?? false,
      pnlSnapshotBotName: u.pnlSnapshotBotName ?? (String(u.preset ?? "").toLowerCase().includes("nanocap") ? "nanocap" : "meridian"),
      earlyDumpPct: u.earlyDumpPct ?? null,
      earlyDumpMaxAgeMin: u.earlyDumpMaxAgeMin ?? 30,
      maxHoldMinutes: u.maxHoldMinutes ?? null,
      feeExitPolicy: buildFeeExitPolicyConfig(u),
      solMode: u.solMode ?? false,
    },

    strategy: {
      strategy: u.strategy ?? "bid_ask",
      binsBelow: u.binsBelow ?? 69,
      targetDownsidePct: u.targetDownsidePct ?? null,
      targetDownsideMinPct: u.targetDownsideMinPct ?? null,
      targetDownsideMaxPct: u.targetDownsideMaxPct ?? null,
      forceSingleSidedSolBidAsk: u.forceSingleSidedSolBidAsk ?? isNanocapPreset,
      // Nanocap prompt canon is 35-90 bins below; keep live guard deterministic.
      minSingleSidedSolBins: u.minSingleSidedSolBins ?? (isNanocapPreset ? 35 : 5),
      minSingleSidedSolDownsidePct: u.minSingleSidedSolDownsidePct ?? (isNanocapPreset ? 1 : null),
      dynamicRangeWidthEnabled: u.dynamicRangeWidthEnabled ?? false,
      dynamicRangeWidthMode: u.dynamicRangeWidthMode ?? "shadow",
      dynamicRangeWidthMinBins: u.dynamicRangeWidthMinBins ?? 12,
      dynamicRangeWidthMaxBins: u.dynamicRangeWidthMaxBins ?? 120,
      dynamicRangeWidthBlockOnMissingInputs: u.dynamicRangeWidthBlockOnMissingInputs ?? true,
      dynamicRangeWidthMaxDeploySharePct: u.dynamicRangeWidthMaxDeploySharePct ?? 5,
      dynamicRangeWidthLowerMcapInputFloor: u.dynamicRangeWidthLowerMcapInputFloor ?? 500_000,
      dynamicRangeWidthMinTargetDownsidePct: u.dynamicRangeWidthMinTargetDownsidePct ?? 16,
      dynamicRangeWidthFeeDensityTighteningEnabled: u.dynamicRangeWidthFeeDensityTighteningEnabled ?? false,
      dynamicRangeWidthStrongFeeActiveTvlRatio: u.dynamicRangeWidthStrongFeeActiveTvlRatio ?? 3,
      dynamicRangeWidthStrongVolumeActiveTvlMultiple: u.dynamicRangeWidthStrongVolumeActiveTvlMultiple ?? 1.5,
      dynamicRangeWidthStrongFeeVelocityUsdPerMin: u.dynamicRangeWidthStrongFeeVelocityUsdPerMin ?? 3,
      dynamicRangeWidthStrongTightenPct: u.dynamicRangeWidthStrongTightenPct ?? 2,
      dynamicRangeWidthGoodFeeActiveTvlRatio: u.dynamicRangeWidthGoodFeeActiveTvlRatio ?? 1.5,
      dynamicRangeWidthGoodVolumeActiveTvlMultiple: u.dynamicRangeWidthGoodVolumeActiveTvlMultiple ?? 1.2,
      dynamicRangeWidthGoodTightenPct: u.dynamicRangeWidthGoodTightenPct ?? 1,
      dynamicRangeWidthTiers: u.dynamicRangeWidthTiers ?? [
        { minMcap: 125_000, maxMcap: 250_000, targetDownsidePct: 30, maxTargetDownsidePct: 36 },
        { minMcap: 250_000, maxMcap: 500_000, targetDownsidePct: 28, maxTargetDownsidePct: 34 },
        { minMcap: 500_000, maxMcap: 800_000, targetDownsidePct: 25, maxTargetDownsidePct: 31 },
        { minMcap: 800_000, maxMcap: 1_200_000, targetDownsidePct: 22, maxTargetDownsidePct: 28 },
        { minMcap: 1_200_000, maxMcap: 2_500_000, targetDownsidePct: 20, maxTargetDownsidePct: 25 },
        { minMcap: 2_500_000, maxMcap: null, targetDownsidePct: 18, maxTargetDownsidePct: 22 },
      ],
      dynamicPoolSizingEnabled: u.dynamicPoolSizingEnabled ?? false,
      dynamicPoolSizingMode: u.dynamicPoolSizingMode ?? "shadow",
      dynamicPoolSizingTargetActiveTvlSharePct: u.dynamicPoolSizingTargetActiveTvlSharePct ?? 3.5,
      dynamicPoolSizingHardActiveTvlSharePct: u.dynamicPoolSizingHardActiveTvlSharePct ?? 5,
      dynamicPoolSizingMinDeploySol: u.dynamicPoolSizingMinDeploySol ?? 1,
      dynamicPoolSizingMaxDeploySol: u.dynamicPoolSizingMaxDeploySol ?? 5,
      dynamicPoolSizingBlockBelowMin: u.dynamicPoolSizingBlockBelowMin ?? true,
      dynamicPoolSizingBlockOnMissingInputs: u.dynamicPoolSizingBlockOnMissingInputs ?? true,
    },

    schedule: {
      managementIntervalMin: u.managementIntervalMin ?? 10,
      screeningIntervalMin: u.screeningIntervalMin ?? 30,
      healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
      pnlPollIntervalMs: normalizePositiveInteger(u.monitoring?.pnlPollIntervalMs ?? u.pnlPollIntervalMs, 30_000),
    },

    rpcPressure: {
      enabled: u.rpcPressure?.enabled ?? u.rpcPressureEnabled ?? true,
      readReqPerSec: normalizeNullableNumber(u.rpcPressure?.readReqPerSec ?? u.rpcReadReqPerSec, 6),
      sendReqPerSec: normalizeNullableNumber(u.rpcPressure?.sendReqPerSec ?? u.rpcSendReqPerSec, 1),
      deployCooldownMs: normalizePositiveInteger(u.rpcPressure?.deployCooldownMs ?? u.rpcDeployCooldownMs, 20 * 60_000),
      telemetryMinQueueMs: normalizePositiveInteger(u.rpcPressure?.telemetryMinQueueMs ?? u.rpcTelemetryMinQueueMs, 250),
      screeningActiveBinConcurrency: normalizePositiveInteger(u.rpcPressure?.screeningActiveBinConcurrency ?? u.screeningActiveBinConcurrency, 1),
      screeningCycleBudgetMs: normalizePositiveInteger(u.rpcPressure?.screeningCycleBudgetMs ?? u.screeningCycleBudgetMs, 4 * 60_000),
    },

    telegram: {
      dustMaxUsd: normalizeNullableNumber(u.telegram?.dustMaxUsd ?? u.telegramDustMaxUsd, 5),
      dustMaxPriceImpactBps: normalizeNullableNumber(u.telegram?.dustMaxPriceImpactBps ?? u.telegramDustMaxPriceImpactBps, 250),
      actionTtlMs: normalizePositiveInteger(u.telegram?.actionTtlMs ?? u.telegramActionTtlMs, 60_000),
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
      rsiMomentumMin: indicatorUserConfig.rsiMomentumMin ?? indicatorUserConfig.rsiOverbought ?? 80,
      rsiMomentumMax: indicatorUserConfig.rsiMomentumMax ?? indicatorUserConfig.rsiOversold ?? 30,
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
