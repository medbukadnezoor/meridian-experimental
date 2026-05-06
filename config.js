import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");
const DEFAULT_HIVEMIND_URL = "https://api.agentmeridian.xyz";
const DEFAULT_AGENT_MERIDIAN_API_URL = "https://api.agentmeridian.xyz/api";
const DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";
const DEFAULT_HIVEMIND_API_KEY = DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY;

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};

const indicatorUserConfig = u.chartIndicators ?? {};

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

const SCREENING_REASONING_EFFORTS = new Set(["low", "medium", "high"]);

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

export const INTERNAL_FALLBACK_MODEL = "stepfun/step-3.5-flash:free";

export function resolveFallbackModel(configuredFallbackModel) {
  const normalizedFallbackModel = normalizeOptionalString(configuredFallbackModel);
  if (normalizedFallbackModel) return normalizedFallbackModel;
  return INTERNAL_FALLBACK_MODEL;
}

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
{
  const llmApiKey = resolveEnvReference(u.llmApiKey);
  if (llmApiKey) process.env.LLM_API_KEY ||= llmApiKey;
}
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.publicApiKey) process.env.PUBLIC_API_KEY ||= u.publicApiKey;
if (u.agentMeridianApiUrl) process.env.AGENT_MERIDIAN_API_URL ||= u.agentMeridianApiUrl;

const fallbackModel = normalizeOptionalString(u.fallbackModel);
const globalLlmBaseUrl = firstNonEmptyString(process.env.LLM_BASE_URL, "https://openrouter.ai/api/v1");
const globalLlmApiKey = firstNonEmptyString(process.env.LLM_API_KEY, process.env.OPENROUTER_API_KEY);
const screeningBaseUrl = u.screeningBaseUrl ?? null;
const managementBaseUrl = u.managementBaseUrl ?? null;
const generalBaseUrl = u.generalBaseUrl ?? null;
const managementModel = u.managementModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha";
const screeningModel = u.screeningModel ?? process.env.LLM_MODEL ?? "openrouter/hunter-alpha";
const generalModel = u.generalModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha";

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    discoveryPageSize: u.discoveryPageSize ?? 50,
    excludeHighSupplyConcentration: u.excludeHighSupplyConcentration ?? true,
    excludeHighSingleOwnership: u.excludeHighSingleOwnership ?? true,
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl !== undefined ? u.maxTvl : 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minQuoteOrganic:   u.minQuoteOrganic   ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    useDiscordSignals: u.useDiscordSignals ?? false,
    discordSignalMode: u.discordSignalMode ?? "merge", // merge | only
    avoidPvpSymbols:   u.avoidPvpSymbols   ?? true, // avoid exact-symbol rivals with real active pools
    blockPvpSymbols:   u.blockPvpSymbols   ?? false, // hard-filter PVP rivals before the LLM sees them
    maxBundlePct:      u.maxBundlePct      ?? 30,  // max bundle holding % (OKX advanced-info)
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    allowedLaunchpads: u.allowedLaunchpads ?? [],  // allow-list launchpads, [] = no allow-list
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
    athFilterPct:       u.athFilterPct       ?? null, // e.g. -20 = only deploy if price is >= 20% below ATH
    fallingKnifeVetoEnabled: u.fallingKnifeVetoEnabled ?? false,
    fallingKnifeMaxPriceChange1hPct: u.fallingKnifeMaxPriceChange1hPct ?? -35,
    fallingKnifeSeverePriceChangePct: u.fallingKnifeSeverePriceChangePct ?? -45,
    fallingKnifeMinSellBuyRatio: u.fallingKnifeMinSellBuyRatio ?? 1.25,
    fallingKnifeRequireOversoldRsi: u.fallingKnifeRequireOversoldRsi ?? false,
    suspiciousVolumeVetoEnabled: u.suspiciousVolumeVetoEnabled ?? false,
    suspiciousVolumeMaxMcapToGlobalFeesRatio: u.suspiciousVolumeMaxMcapToGlobalFeesRatio ?? 12000,
    suspiciousVolumeMinGlobalFeesSol: u.suspiciousVolumeMinGlobalFeesSol ?? 20,
    suspiciousVolumeMaxTokenAgeHours: u.suspiciousVolumeMaxTokenAgeHours ?? 96,
    suspiciousVolumeMinPriceDropPct: u.suspiciousVolumeMinPriceDropPct ?? -25,
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    outOfRangeHardCloseMinutes: u.outOfRangeHardCloseMinutes ?? null,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
    repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 3,
    repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
    repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "token", // pool | token | both
    repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
    repeatLowYieldCooldownEnabled: u.repeatLowYieldCooldownEnabled ?? false,
    repeatLowYieldCooldownTriggerCount: u.repeatLowYieldCooldownTriggerCount ?? 3,
    repeatLowYieldCooldownLookbackHours: u.repeatLowYieldCooldownLookbackHours ?? 48,
    repeatLowYieldCooldownHours: u.repeatLowYieldCooldownHours ?? 12,
    repeatLowYieldCooldownScope: u.repeatLowYieldCooldownScope ?? "token", // pool | token | both
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -50,
    stopLossConfirmDelayMs: Math.max(0, Number(u.stopLossConfirmDelayMs ?? 0)),
    hardStopLossPct:        u.hardStopLossPct        ?? null,
    stopLossFastClosePct:   u.stopLossFastClosePct   ?? null,
    stopLossVelocityWindowMs: Math.max(0, Number(u.stopLossVelocityWindowMs ?? 0)),
    stopLossVelocityClosePct: u.stopLossVelocityClosePct ?? null,
    rollingDrawdownExitEnabled: u.rollingDrawdownExitEnabled ?? false,
    rollingDrawdownWindowMs: u.rollingDrawdownWindowMs ?? 5_400_000,
    rollingDrawdownMinPeakPct: u.rollingDrawdownMinPeakPct ?? 2,
    rollingDrawdownCurrentPnlPct: u.rollingDrawdownCurrentPnlPct ?? -3,
    rollingDrawdownMinDropPct: u.rollingDrawdownMinDropPct ?? 6,
    takeProfitPct:         u.takeProfitPct         ?? u.takeProfitFeePct ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    pnlSnapshotLoggingEnabled: u.pnlSnapshotLoggingEnabled ?? false,
    pnlSnapshotDebug: u.pnlSnapshotDebug ?? false,
    pnlSnapshotBotName: u.pnlSnapshotBotName ?? "meridian",
    // Early dump detection — close young positions losing fast
    earlyDumpPct:          u.earlyDumpPct          ?? null,  // e.g. -2 — PnL threshold for young positions (null = disabled)
    earlyDumpMaxAgeMin:    u.earlyDumpMaxAgeMin    ?? 30,    // only trigger if position is younger than this (minutes)
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:  u.strategy  ?? "bid_ask",
    binsBelow: u.binsBelow ?? 69,
    forceSingleSidedSolBidAsk: u.forceSingleSidedSolBidAsk ?? true,
    minSingleSidedSolBins: u.minSingleSidedSolBins ?? 5,
    minSingleSidedSolDownsidePct: u.minSingleSidedSolDownsidePct ?? null,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    managementModel,
    screeningModel,
    generalModel,
    fallbackModel,
    // Per-role endpoint overrides — null falls back to global llmBaseUrl / llmApiKey
    screeningBaseUrl,
    screeningApiKey:  resolveRoleApiKey(u.screeningApiKey, screeningBaseUrl ?? globalLlmBaseUrl, screeningModel, process.env, globalLlmApiKey) ?? null,
    screeningThinkingEnabled: normalizeBoolean(u.screeningThinkingEnabled, false),
    screeningReasoningEffort: normalizeScreeningReasoningEffort(u.screeningReasoningEffort),
    screeningRequestTimeoutMs: normalizePositiveInteger(u.screeningRequestTimeoutMs ?? u.llmRequestTimeoutMs, 90_000),
    managementBaseUrl,
    managementApiKey:  resolveRoleApiKey(u.managementApiKey, managementBaseUrl ?? globalLlmBaseUrl, managementModel, process.env, globalLlmApiKey) ?? null,
    generalBaseUrl,
    generalApiKey:  resolveRoleApiKey(u.generalApiKey, generalBaseUrl ?? globalLlmBaseUrl, generalModel, process.env, globalLlmApiKey) ?? null,
  },

  // ─── Darwinian Signal Weighting ───────
  darwin: {
    enabled:               u.darwinEnabled               ?? true,
    windowDays:            u.darwinWindowDays            ?? 60,
    recalcEvery:           u.darwinRecalcEvery           ?? 5,    // recalc every N closes
    boostFactor:           u.darwinBoost                 ?? 1.05,
    decayFactor:           u.darwinDecay                 ?? 0.95,
    weightFloor:           u.darwinFloor                 ?? 0.3,
    weightCeiling:         u.darwinCeiling               ?? 2.5,
    minSamples:            u.darwinMinSamples            ?? 10,
    perSignalMinSamples:   u.darwinPerSignalMinSamples   ?? 12,
    minAbsLiftToAdjust:    u.darwinMinAbsLiftToAdjust    ?? 0.05,
    strongLiftThreshold:   u.darwinStrongLiftThreshold   ?? 0.2,
    calibrationMinSamples: u.darwinCalibrationMinSamples ?? 20,
    meanReversionRate:     u.darwinMeanReversionRate     ?? 0.02,
  },

  // ─── Performance Classification ───────
  performance: {
    materialWinPct: u.materialWinPct ?? 1.0,
    materialLossPct: u.materialLossPct ?? -1.0,
    dustNeutralAbsPct: u.dustNeutralAbsPct ?? 1.0,
    neutralCloseReasonBuckets: Array.isArray(u.neutralCloseReasonBuckets)
      ? u.neutralCloseReasonBuckets
      : ["low_yield", "operator"],
    darwinUseMaterialOutcomes: u.darwinUseMaterialOutcomes ?? true,
    darwinExcludeNeutralOutcomes: u.darwinExcludeNeutralOutcomes ?? true,
  },

  // ─── Shadow Autoresearch ───────────────
  autoresearch: {
    enabled:                    u.autoresearchEnabled                    ?? true,
    mode:                       u.autoresearchMode                       ?? "shadow",
    maxActiveTrials:            u.autoresearchMaxActiveTrials            ?? 3,
    minClosesPerTrial:          u.autoresearchMinClosesPerTrial          ?? 12,
    minEvaluableCloses:         u.autoresearchMinEvaluableCloses         ?? 8,
    minRejectedCloses:          u.autoresearchMinRejectedCloses          ?? 3,
    minAbsoluteWinRateDeltaPct: u.autoresearchMinAbsoluteWinRateDeltaPct ?? 8,
    minAbsolutePnlDeltaPct:     u.autoresearchMinAbsolutePnlDeltaPct     ?? 0.75,
    lookbackDays:               u.autoresearchLookbackDays               ?? 45,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── HiveMind ─────────────────────────
  hiveMind: {
    url: firstNonEmptyString(u.hiveMindUrl, DEFAULT_HIVEMIND_URL) ?? DEFAULT_HIVEMIND_URL,
    apiKey: firstNonEmptyString(u.hiveMindApiKey, process.env.HIVEMIND_API_KEY, DEFAULT_HIVEMIND_API_KEY) ?? DEFAULT_HIVEMIND_API_KEY,
    agentId: u.agentId ?? null,
    pullMode: u.hiveMindPullMode ?? "auto",
  },

  // ─── Agent Meridian API ───────────────
  api: {
    url: firstNonEmptyString(u.agentMeridianApiUrl, process.env.AGENT_MERIDIAN_API_URL, DEFAULT_AGENT_MERIDIAN_API_URL) ?? DEFAULT_AGENT_MERIDIAN_API_URL,
    publicApiKey: firstNonEmptyString(u.publicApiKey, process.env.PUBLIC_API_KEY, DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY) ?? DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY,
    lpAgentRelayEnabled: u.lpAgentRelayEnabled ?? false,
  },

  // ─── Jupiter Swap V2 ──────────────────
  jupiter: {
    apiKey: firstNonEmptyString(process.env.JUPITER_API_KEY) ?? "",
    referralAccount:
      firstNonEmptyString(process.env.JUPITER_REFERRAL_ACCOUNT, "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey")
      ?? "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey",
    referralFeeBps: Number(process.env.JUPITER_REFERRAL_FEE_BPS ?? 50),
  },

  // ─── Chart Indicator Confirmations ────
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

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  if (!fs.existsSync(USER_CONFIG_PATH)) return;
  try {
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const s = config.screening;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.useDiscordSignals !== undefined) s.useDiscordSignals = fresh.useDiscordSignals;
    if (fresh.discordSignalMode != null) s.discordSignalMode = fresh.discordSignalMode;
    if (fresh.discoveryPageSize != null) s.discoveryPageSize = fresh.discoveryPageSize;
    if (fresh.excludeHighSupplyConcentration !== undefined) s.excludeHighSupplyConcentration = fresh.excludeHighSupplyConcentration;
    if (fresh.excludeHighSingleOwnership !== undefined) s.excludeHighSingleOwnership = fresh.excludeHighSingleOwnership;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minQuoteOrganic != null) s.minQuoteOrganic = fresh.minQuoteOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         !== undefined) s.maxTvl   = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.athFilterPct      !== undefined) s.athFilterPct     = fresh.athFilterPct;
    if (fresh.maxBundlePct      != null) s.maxBundlePct     = fresh.maxBundlePct;
    if (fresh.avoidPvpSymbols   !== undefined) s.avoidPvpSymbols = fresh.avoidPvpSymbols;
    if (fresh.blockPvpSymbols   !== undefined) s.blockPvpSymbols = fresh.blockPvpSymbols;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.allowedLaunchpads !== undefined) s.allowedLaunchpads = fresh.allowedLaunchpads;
    if (fresh.blockedLaunchpads !== undefined) s.blockedLaunchpads = fresh.blockedLaunchpads;
  } catch { /* ignore */ }
}
