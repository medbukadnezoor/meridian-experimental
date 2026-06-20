import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  loadUserConfig,
  normalizeScreeningSource,
  resolveConfigFromPath,
} from "./config-builder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export {
  DEEPSEEK_OPENAI_BASE_URL,
  normalizeOptionalString,
  firstNonEmptyString,
  isDeepSeekBaseUrl,
  isDeepSeekModel,
  resolveEnvReference,
  resolveRoleApiKey,
  INTERNAL_FALLBACK_MODEL,
  resolveFallbackModel,
  normalizeScreeningSource,
} from "./config-builder.js";

export const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const runtimeConfigResolution = resolveConfigFromPath(USER_CONFIG_PATH, {
  env: process.env,
  applyEnv: true,
});
const u = runtimeConfigResolution.userConfig;

export const config = runtimeConfigResolution.config;

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
    const fresh = loadUserConfig(USER_CONFIG_PATH);
    const s = config.screening;
    const strategy = config.strategy;
    s.source = normalizeScreeningSource(fresh.screening?.source ?? fresh.screeningSource ?? s.source);
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.useDiscordSignals !== undefined) s.useDiscordSignals = fresh.useDiscordSignals;
    if (fresh.discordSignalMode != null) s.discordSignalMode = fresh.discordSignalMode;
    if (fresh.excludeHighSupplyConcentration !== undefined) s.excludeHighSupplyConcentration = fresh.excludeHighSupplyConcentration;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minQuoteOrganic != null) s.minQuoteOrganic = fresh.minQuoteOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         !== undefined) s.maxTvl   = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minVolumeActiveTvlMultiple !== undefined) s.minVolumeActiveTvlMultiple = fresh.minVolumeActiveTvlMultiple;
    if (fresh.preferredVolumeActiveTvlMultiple !== undefined) s.preferredVolumeActiveTvlMultiple = fresh.preferredVolumeActiveTvlMultiple;
    if (fresh.dynamicEntryShadowAssumedDeployUsd !== undefined) s.dynamicEntryShadowAssumedDeployUsd = fresh.dynamicEntryShadowAssumedDeployUsd;
    if (fresh.twoLaneClassificationLoggingEnabled !== undefined) s.twoLaneClassificationLoggingEnabled = fresh.twoLaneClassificationLoggingEnabled;
    if (fresh.twoLanePrimaryVolumeActiveTvlMultiple !== undefined) s.twoLanePrimaryVolumeActiveTvlMultiple = fresh.twoLanePrimaryVolumeActiveTvlMultiple;
    if (fresh.looseVolumeActiveTvlMultiple !== undefined) s.looseVolumeActiveTvlMultiple = fresh.looseVolumeActiveTvlMultiple;
    if (Array.isArray(fresh.feeVelocityShadowDownsidePct)) s.feeVelocityShadowDownsidePct = fresh.feeVelocityShadowDownsidePct;
    if (Array.isArray(fresh.feeVelocityShadowTakeProfitPct)) s.feeVelocityShadowTakeProfitPct = fresh.feeVelocityShadowTakeProfitPct;
    if (Array.isArray(fresh.feeVelocityShadowFeeTvlFloors)) s.feeVelocityShadowFeeTvlFloors = fresh.feeVelocityShadowFeeTvlFloors;
    if (fresh.sameTickerSurfEnabled !== undefined) s.sameTickerSurfEnabled = fresh.sameTickerSurfEnabled;
    if (fresh.samePoolPostWinDecayEnabled !== undefined) s.samePoolPostWinDecayEnabled = fresh.samePoolPostWinDecayEnabled;
    if (fresh.samePoolPostWinCooldownMinutes !== undefined) s.samePoolPostWinCooldownMinutes = fresh.samePoolPostWinCooldownMinutes;
    if (fresh.samePoolPostWinMaterialPnlPct !== undefined) s.samePoolPostWinMaterialPnlPct = fresh.samePoolPostWinMaterialPnlPct;
    if (fresh.samePoolPostWinRequireFreshDecayPass !== undefined) s.samePoolPostWinRequireFreshDecayPass = fresh.samePoolPostWinRequireFreshDecayPass;
    if (fresh.ohlcvEntryVetoShadowEnabled !== undefined) s.ohlcvEntryVetoShadowEnabled = fresh.ohlcvEntryVetoShadowEnabled;
    if (fresh.ohlcvEntryVetoLiveEnabled !== undefined) s.ohlcvEntryVetoLiveEnabled = fresh.ohlcvEntryVetoLiveEnabled;
    if (fresh.ohlcvEntryVetoHighDrawdownPct !== undefined) s.ohlcvEntryVetoHighDrawdownPct = fresh.ohlcvEntryVetoHighDrawdownPct;
    if (fresh.ohlcvEntryVetoEntryDrawdownPct !== undefined) s.ohlcvEntryVetoEntryDrawdownPct = fresh.ohlcvEntryVetoEntryDrawdownPct;
    if (fresh.ohlcvEntryVetoExtremePriceChangePct !== undefined) s.ohlcvEntryVetoExtremePriceChangePct = fresh.ohlcvEntryVetoExtremePriceChangePct;
    if (fresh.ohlcvEntryVetoRequireCompound !== undefined) s.ohlcvEntryVetoRequireCompound = fresh.ohlcvEntryVetoRequireCompound;
    if (Array.isArray(fresh.ohlcvEntryVetoLiveReasonCodes)) s.ohlcvEntryVetoLiveReasonCodes = fresh.ohlcvEntryVetoLiveReasonCodes;
    const freshScreening = fresh.screening ?? {};
    if (freshScreening.targetPoolNeedleVetoShadowEnabled !== undefined || fresh.targetPoolNeedleVetoShadowEnabled !== undefined) {
      s.targetPoolNeedleVetoShadowEnabled = freshScreening.targetPoolNeedleVetoShadowEnabled ?? fresh.targetPoolNeedleVetoShadowEnabled;
    }
    if (freshScreening.targetPoolNeedleVetoLiveEnabled !== undefined || fresh.targetPoolNeedleVetoLiveEnabled !== undefined) {
      s.targetPoolNeedleVetoLiveEnabled = freshScreening.targetPoolNeedleVetoLiveEnabled ?? fresh.targetPoolNeedleVetoLiveEnabled;
    }
    if (freshScreening.targetPoolNeedleVetoLookbackMinutes !== undefined || fresh.targetPoolNeedleVetoLookbackMinutes !== undefined) {
      s.targetPoolNeedleVetoLookbackMinutes = freshScreening.targetPoolNeedleVetoLookbackMinutes ?? fresh.targetPoolNeedleVetoLookbackMinutes;
    }
    if (freshScreening.targetPoolNeedleVetoAggregateMin !== undefined || fresh.targetPoolNeedleVetoAggregateMin !== undefined) {
      s.targetPoolNeedleVetoAggregateMin = freshScreening.targetPoolNeedleVetoAggregateMin ?? fresh.targetPoolNeedleVetoAggregateMin;
    }
    if (freshScreening.targetPoolNeedleVetoShortlistLimit !== undefined || fresh.targetPoolNeedleVetoShortlistLimit !== undefined) {
      s.targetPoolNeedleVetoShortlistLimit = freshScreening.targetPoolNeedleVetoShortlistLimit ?? fresh.targetPoolNeedleVetoShortlistLimit;
    }
    if (freshScreening.targetPoolNeedleVetoMinWindowRows !== undefined || fresh.targetPoolNeedleVetoMinWindowRows !== undefined) {
      s.targetPoolNeedleVetoMinWindowRows = freshScreening.targetPoolNeedleVetoMinWindowRows ?? fresh.targetPoolNeedleVetoMinWindowRows;
    }
    if (freshScreening.targetPoolNeedleVetoHighDrawdownPct !== undefined || fresh.targetPoolNeedleVetoHighDrawdownPct !== undefined) {
      s.targetPoolNeedleVetoHighDrawdownPct = freshScreening.targetPoolNeedleVetoHighDrawdownPct ?? fresh.targetPoolNeedleVetoHighDrawdownPct;
    }
    if (freshScreening.targetPoolNeedleVetoMinHighRunupPct !== undefined || fresh.targetPoolNeedleVetoMinHighRunupPct !== undefined) {
      s.targetPoolNeedleVetoMinHighRunupPct = freshScreening.targetPoolNeedleVetoMinHighRunupPct ?? fresh.targetPoolNeedleVetoMinHighRunupPct;
    }
    if (Array.isArray(freshScreening.targetPoolNeedleVetoLiveReasonCodes) || Array.isArray(fresh.targetPoolNeedleVetoLiveReasonCodes)) {
      s.targetPoolNeedleVetoLiveReasonCodes = Array.isArray(freshScreening.targetPoolNeedleVetoLiveReasonCodes)
        ? freshScreening.targetPoolNeedleVetoLiveReasonCodes
        : fresh.targetPoolNeedleVetoLiveReasonCodes;
    }
    if (freshScreening.fabriqOhlcvEntryGateEnabled !== undefined || fresh.fabriqOhlcvEntryGateEnabled !== undefined) s.fabriqOhlcvEntryGateEnabled = freshScreening.fabriqOhlcvEntryGateEnabled ?? fresh.fabriqOhlcvEntryGateEnabled;
    if (freshScreening.fabriqOhlcvEntryGateMode !== undefined || fresh.fabriqOhlcvEntryGateMode !== undefined) s.fabriqOhlcvEntryGateMode = freshScreening.fabriqOhlcvEntryGateMode ?? fresh.fabriqOhlcvEntryGateMode;
    if (Array.isArray(freshScreening.fabriqOhlcvEntryGateProviders) || Array.isArray(fresh.fabriqOhlcvEntryGateProviders)) s.fabriqOhlcvEntryGateProviders = Array.isArray(freshScreening.fabriqOhlcvEntryGateProviders) ? freshScreening.fabriqOhlcvEntryGateProviders : fresh.fabriqOhlcvEntryGateProviders;
    if (Array.isArray(freshScreening.fabriqOhlcvEntryGateDecisiveProviderOrder) || Array.isArray(fresh.fabriqOhlcvEntryGateDecisiveProviderOrder)) s.fabriqOhlcvEntryGateDecisiveProviderOrder = Array.isArray(freshScreening.fabriqOhlcvEntryGateDecisiveProviderOrder) ? freshScreening.fabriqOhlcvEntryGateDecisiveProviderOrder : fresh.fabriqOhlcvEntryGateDecisiveProviderOrder;
    if (Array.isArray(freshScreening.fabriqOhlcvEntryGateIntervals) || Array.isArray(fresh.fabriqOhlcvEntryGateIntervals)) s.fabriqOhlcvEntryGateIntervals = Array.isArray(freshScreening.fabriqOhlcvEntryGateIntervals) ? freshScreening.fabriqOhlcvEntryGateIntervals : fresh.fabriqOhlcvEntryGateIntervals;
    if (freshScreening.fabriqOhlcvEntryGateLookbackMinutes !== undefined || fresh.fabriqOhlcvEntryGateLookbackMinutes !== undefined) s.fabriqOhlcvEntryGateLookbackMinutes = freshScreening.fabriqOhlcvEntryGateLookbackMinutes ?? fresh.fabriqOhlcvEntryGateLookbackMinutes;
    if (freshScreening.fabriqOhlcvEntryGateMinRows !== undefined || fresh.fabriqOhlcvEntryGateMinRows !== undefined) s.fabriqOhlcvEntryGateMinRows = freshScreening.fabriqOhlcvEntryGateMinRows ?? fresh.fabriqOhlcvEntryGateMinRows;
    if (freshScreening.fabriqOhlcvEntryGateBlockOnMissingOhlcv !== undefined || fresh.fabriqOhlcvEntryGateBlockOnMissingOhlcv !== undefined) s.fabriqOhlcvEntryGateBlockOnMissingOhlcv = freshScreening.fabriqOhlcvEntryGateBlockOnMissingOhlcv ?? fresh.fabriqOhlcvEntryGateBlockOnMissingOhlcv;
    if (freshScreening.criticalThinEntryOverlayEnabled !== undefined || fresh.criticalThinEntryOverlayEnabled !== undefined) s.criticalThinEntryOverlayEnabled = freshScreening.criticalThinEntryOverlayEnabled ?? fresh.criticalThinEntryOverlayEnabled;
    if (freshScreening.criticalThinEntryOverlayMode !== undefined || fresh.criticalThinEntryOverlayMode !== undefined) s.criticalThinEntryOverlayMode = freshScreening.criticalThinEntryOverlayMode ?? fresh.criticalThinEntryOverlayMode;
    if (freshScreening.criticalThinMcapUsd !== undefined || fresh.criticalThinMcapUsd !== undefined) s.criticalThinMcapUsd = freshScreening.criticalThinMcapUsd ?? fresh.criticalThinMcapUsd;
    if (freshScreening.criticalThinActiveTvlUsd !== undefined || fresh.criticalThinActiveTvlUsd !== undefined) s.criticalThinActiveTvlUsd = freshScreening.criticalThinActiveTvlUsd ?? fresh.criticalThinActiveTvlUsd;
    if (freshScreening.criticalThinWatchMcapUsd !== undefined || fresh.criticalThinWatchMcapUsd !== undefined) s.criticalThinWatchMcapUsd = freshScreening.criticalThinWatchMcapUsd ?? fresh.criticalThinWatchMcapUsd;
    if (freshScreening.criticalThinWatchActiveTvlUsd !== undefined || fresh.criticalThinWatchActiveTvlUsd !== undefined) s.criticalThinWatchActiveTvlUsd = freshScreening.criticalThinWatchActiveTvlUsd ?? fresh.criticalThinWatchActiveTvlUsd;
    if (freshScreening.criticalThinRequireChartAccept !== undefined || fresh.criticalThinRequireChartAccept !== undefined) s.criticalThinRequireChartAccept = freshScreening.criticalThinRequireChartAccept ?? fresh.criticalThinRequireChartAccept;
    if (freshScreening.criticalThinMinFeeActiveTvlRatio !== undefined || fresh.criticalThinMinFeeActiveTvlRatio !== undefined) s.criticalThinMinFeeActiveTvlRatio = freshScreening.criticalThinMinFeeActiveTvlRatio ?? fresh.criticalThinMinFeeActiveTvlRatio;
    if (freshScreening.criticalThinMinVolumeActiveTvlMultiple !== undefined || fresh.criticalThinMinVolumeActiveTvlMultiple !== undefined) s.criticalThinMinVolumeActiveTvlMultiple = freshScreening.criticalThinMinVolumeActiveTvlMultiple ?? fresh.criticalThinMinVolumeActiveTvlMultiple;
    if (freshScreening.criticalThinBlockOnMissingInputs !== undefined || fresh.criticalThinBlockOnMissingInputs !== undefined) s.criticalThinBlockOnMissingInputs = freshScreening.criticalThinBlockOnMissingInputs ?? fresh.criticalThinBlockOnMissingInputs;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.athFilterPct      !== undefined) s.athFilterPct     = fresh.athFilterPct;
    if (fresh.athMinPriceVsAthPct !== undefined) s.athMinPriceVsAthPct = fresh.athMinPriceVsAthPct;
    if (fresh.maxBundlePct      != null) s.maxBundlePct     = fresh.maxBundlePct;
    if (fresh.avoidPvpSymbols   !== undefined) s.avoidPvpSymbols = fresh.avoidPvpSymbols;
    if (fresh.blockPvpSymbols   !== undefined) s.blockPvpSymbols = fresh.blockPvpSymbols;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.minSingleSidedSolBins !== undefined) strategy.minSingleSidedSolBins = fresh.minSingleSidedSolBins;
    if (fresh.dynamicRangeWidthEnabled !== undefined) strategy.dynamicRangeWidthEnabled = fresh.dynamicRangeWidthEnabled;
    if (fresh.dynamicRangeWidthMode !== undefined) strategy.dynamicRangeWidthMode = fresh.dynamicRangeWidthMode;
    if (fresh.dynamicRangeWidthMinBins !== undefined) strategy.dynamicRangeWidthMinBins = fresh.dynamicRangeWidthMinBins;
    if (fresh.dynamicRangeWidthMaxBins !== undefined) strategy.dynamicRangeWidthMaxBins = fresh.dynamicRangeWidthMaxBins;
    if (fresh.dynamicRangeWidthBlockOnMissingInputs !== undefined) strategy.dynamicRangeWidthBlockOnMissingInputs = fresh.dynamicRangeWidthBlockOnMissingInputs;
    if (fresh.dynamicRangeWidthMaxDeploySharePct !== undefined) strategy.dynamicRangeWidthMaxDeploySharePct = fresh.dynamicRangeWidthMaxDeploySharePct;
    if (fresh.dynamicRangeWidthLowerMcapInputFloor !== undefined) strategy.dynamicRangeWidthLowerMcapInputFloor = fresh.dynamicRangeWidthLowerMcapInputFloor;
    if (fresh.dynamicRangeWidthMinTargetDownsidePct !== undefined) strategy.dynamicRangeWidthMinTargetDownsidePct = fresh.dynamicRangeWidthMinTargetDownsidePct;
    if (fresh.dynamicRangeWidthFeeDensityTighteningEnabled !== undefined) strategy.dynamicRangeWidthFeeDensityTighteningEnabled = fresh.dynamicRangeWidthFeeDensityTighteningEnabled;
    if (fresh.dynamicRangeWidthStrongFeeActiveTvlRatio !== undefined) strategy.dynamicRangeWidthStrongFeeActiveTvlRatio = fresh.dynamicRangeWidthStrongFeeActiveTvlRatio;
    if (fresh.dynamicRangeWidthStrongVolumeActiveTvlMultiple !== undefined) strategy.dynamicRangeWidthStrongVolumeActiveTvlMultiple = fresh.dynamicRangeWidthStrongVolumeActiveTvlMultiple;
    if (fresh.dynamicRangeWidthStrongFeeVelocityUsdPerMin !== undefined) strategy.dynamicRangeWidthStrongFeeVelocityUsdPerMin = fresh.dynamicRangeWidthStrongFeeVelocityUsdPerMin;
    if (fresh.dynamicRangeWidthStrongTightenPct !== undefined) strategy.dynamicRangeWidthStrongTightenPct = fresh.dynamicRangeWidthStrongTightenPct;
    if (fresh.dynamicRangeWidthGoodFeeActiveTvlRatio !== undefined) strategy.dynamicRangeWidthGoodFeeActiveTvlRatio = fresh.dynamicRangeWidthGoodFeeActiveTvlRatio;
    if (fresh.dynamicRangeWidthGoodVolumeActiveTvlMultiple !== undefined) strategy.dynamicRangeWidthGoodVolumeActiveTvlMultiple = fresh.dynamicRangeWidthGoodVolumeActiveTvlMultiple;
    if (fresh.dynamicRangeWidthGoodTightenPct !== undefined) strategy.dynamicRangeWidthGoodTightenPct = fresh.dynamicRangeWidthGoodTightenPct;
    if (Array.isArray(fresh.dynamicRangeWidthTiers)) strategy.dynamicRangeWidthTiers = fresh.dynamicRangeWidthTiers;
    if (fresh.allowedLaunchpads !== undefined) s.allowedLaunchpads = fresh.allowedLaunchpads;
    if (fresh.blockedLaunchpads !== undefined) s.blockedLaunchpads = fresh.blockedLaunchpads;
    if (fresh.okxDiscovery !== undefined) s.okxDiscovery = fresh.okxDiscovery;
    if (fresh.screening?.okxDiscovery !== undefined) s.okxDiscovery = fresh.screening.okxDiscovery;
    if (fresh.preEntryMomentumGates !== undefined) s.preEntryMomentumGates = fresh.preEntryMomentumGates;
    if (fresh.screening?.preEntryMomentumGates !== undefined) s.preEntryMomentumGates = fresh.screening.preEntryMomentumGates;
  } catch { /* ignore */ }
}
