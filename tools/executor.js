import { discoverPools, evaluateTargetPoolNeedleDeployGuard, getPoolDetail, getTopCandidates } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  searchPools,
} from "./dlmm.js";
import { getWalletBalances, swapToken } from "./wallet.js";
import { studyTopLPers } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons } from "../lessons.js";
import { setPositionInstruction } from "../state.js";

import { getPoolMemory, addPoolNote } from "../pool-memory.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy, getActiveStrategy, resolveStrategyRangePolicy } from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../dev-blocklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { config, computeDeployAmount, reloadScreeningThresholds } from "../config.js";
import { normalizeForcedSingleSidedSolBidAskArgs } from "./single-side-bidask-guard.js";
import { applyRangeWidthDecision } from "../range-width-decision.js";
import { applyDynamicPoolSizing } from "../dynamic-pool-sizing.js";
import { evaluateFabriqOhlcvEntryGate } from "../fabriq-ohlcv-entry-gate.js";
import { getRecentDecisions } from "../decision-log.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "../user-config.json");
import { log, logAction } from "../logger.js";
import { appendDecisionContext } from "../decision-context-log.js";
import { notifyDeploy, notifyClose, notifySwap } from "../telegram.js";
import { appendJsonl, jsonlPath } from "../sol-equity-tracker.js";

const OPERATOR_UPDATE_CONFIG_REASONS = new Set([
  "CLI config set",
  "Telegram slash command /setcfg",
]);

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

// Map tool names to implementations
const toolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const result = execSync("git pull", { cwd: process.cwd(), encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        const child = spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: "inherit",
          cwd: process.cwd(),
        });
        child.unref();
        process.exit(0);
      }, 3000);
      return { success: true, updated: true, message: `Updated! Restarting in 3s...\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  get_performance_history: getPerformanceHistory,
  get_recent_decisions: ({ limit } = {}) => ({ decisions: getRecentDecisions(limit || 6) }),
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_deployer: blockDev,
  unblock_deployer: unblockDev,
  list_blocked_deployers: listBlockedDevs,
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: ({ changes, reason = "" }) => {
    // Flat key → config section mapping (covers everything in config.js)
    const CONFIG_MAP = {
      // screening
      minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
      excludeHighSupplyConcentration: ["screening", "excludeHighSupplyConcentration"],
      minTvl: ["screening", "minTvl"],
      maxTvl: ["screening", "maxTvl"],
      minVolume: ["screening", "minVolume"],
      minOrganic: ["screening", "minOrganic"],
      minQuoteOrganic: ["screening", "minQuoteOrganic"],
      minHolders: ["screening", "minHolders"],
      minMcap: ["screening", "minMcap"],
      maxMcap: ["screening", "maxMcap"],
      minBinStep: ["screening", "minBinStep"],
      maxBinStep: ["screening", "maxBinStep"],
      timeframe: ["screening", "timeframe"],
      category: ["screening", "category"],
      minTokenFeesSol: ["screening", "minTokenFeesSol"],
      useDiscordSignals: ["screening", "useDiscordSignals"],
      discordSignalMode: ["screening", "discordSignalMode"],
      avoidPvpSymbols: ["screening", "avoidPvpSymbols"],
      blockPvpSymbols: ["screening", "blockPvpSymbols"],
      maxBundlePct:     ["screening", "maxBundlePct"],
      maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
      maxTop10Pct: ["screening", "maxTop10Pct"],
      allowedLaunchpads: ["screening", "allowedLaunchpads"],
      blockedLaunchpads: ["screening", "blockedLaunchpads"],
      minTokenAgeHours: ["screening", "minTokenAgeHours"],
      maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
      athFilterPct:     ["screening", "athFilterPct"],
      athMinPriceVsAthPct: ["screening", "athMinPriceVsAthPct"],
      fallingKnifeVetoEnabled: ["screening", "fallingKnifeVetoEnabled"],
      fallingKnifeMaxPriceChange1hPct: ["screening", "fallingKnifeMaxPriceChange1hPct"],
      fallingKnifeSeverePriceChangePct: ["screening", "fallingKnifeSeverePriceChangePct"],
      fallingKnifeMinSellBuyRatio: ["screening", "fallingKnifeMinSellBuyRatio"],
      fallingKnifeRequireOversoldRsi: ["screening", "fallingKnifeRequireOversoldRsi"],
      suspiciousVolumeVetoEnabled: ["screening", "suspiciousVolumeVetoEnabled"],
      suspiciousVolumeMaxMcapToGlobalFeesRatio: ["screening", "suspiciousVolumeMaxMcapToGlobalFeesRatio"],
      suspiciousVolumeMinGlobalFeesSol: ["screening", "suspiciousVolumeMinGlobalFeesSol"],
      suspiciousVolumeMaxTokenAgeHours: ["screening", "suspiciousVolumeMaxTokenAgeHours"],
      suspiciousVolumeMinPriceDropPct: ["screening", "suspiciousVolumeMinPriceDropPct"],
      targetPoolNeedleVetoShadowEnabled: ["screening", "targetPoolNeedleVetoShadowEnabled"],
      targetPoolNeedleVetoLiveEnabled: ["screening", "targetPoolNeedleVetoLiveEnabled"],
      targetPoolNeedleVetoLookbackMinutes: ["screening", "targetPoolNeedleVetoLookbackMinutes"],
      targetPoolNeedleVetoAggregateMin: ["screening", "targetPoolNeedleVetoAggregateMin"],
      targetPoolNeedleVetoMinWindowRows: ["screening", "targetPoolNeedleVetoMinWindowRows"],
      targetPoolNeedleVetoHighDrawdownPct: ["screening", "targetPoolNeedleVetoHighDrawdownPct"],
      targetPoolNeedleVetoMinHighRunupPct: ["screening", "targetPoolNeedleVetoMinHighRunupPct"],
      targetPoolNeedleVetoLiveReasonCodes: ["screening", "targetPoolNeedleVetoLiveReasonCodes"],
      fabriqOhlcvEntryGateEnabled: ["screening", "fabriqOhlcvEntryGateEnabled"],
      fabriqOhlcvEntryGateMode: ["screening", "fabriqOhlcvEntryGateMode"],
      fabriqOhlcvEntryGateProviders: ["screening", "fabriqOhlcvEntryGateProviders"],
      fabriqOhlcvEntryGateDecisiveProviderOrder: ["screening", "fabriqOhlcvEntryGateDecisiveProviderOrder"],
      fabriqOhlcvEntryGateIntervals: ["screening", "fabriqOhlcvEntryGateIntervals"],
      fabriqOhlcvEntryGateLookbackMinutes: ["screening", "fabriqOhlcvEntryGateLookbackMinutes"],
      fabriqOhlcvEntryGateMinRows: ["screening", "fabriqOhlcvEntryGateMinRows"],
      fabriqOhlcvEntryGateBlockOnMissingOhlcv: ["screening", "fabriqOhlcvEntryGateBlockOnMissingOhlcv"],
      minFeePerTvl24h: ["management", "minFeePerTvl24h"],
      // management
      minClaimAmount: ["management", "minClaimAmount"],
      autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      oorCooldownTriggerCount: ["management", "oorCooldownTriggerCount"],
      oorCooldownHours: ["management", "oorCooldownHours"],
      repeatDeployCooldownEnabled: ["management", "repeatDeployCooldownEnabled"],
      repeatDeployCooldownTriggerCount: ["management", "repeatDeployCooldownTriggerCount"],
      repeatDeployCooldownHours: ["management", "repeatDeployCooldownHours"],
      repeatDeployCooldownScope: ["management", "repeatDeployCooldownScope"],
      repeatDeployCooldownMinFeeEarnedPct: ["management", "repeatDeployCooldownMinFeeEarnedPct"],
      minVolumeToRebalance: ["management", "minVolumeToRebalance"],
      stopLossPct: ["management", "stopLossPct"],
      stopLossConfirmDelayMs: ["management", "stopLossConfirmDelayMs"],
      hardStopLossPct: ["management", "hardStopLossPct"],
      stopLossFastClosePct: ["management", "stopLossFastClosePct"],
      stopLossVelocityWindowMs: ["management", "stopLossVelocityWindowMs"],
      stopLossVelocityClosePct: ["management", "stopLossVelocityClosePct"],
      rollingDrawdownExitEnabled: ["management", "rollingDrawdownExitEnabled"],
      rollingDrawdownWindowMs: ["management", "rollingDrawdownWindowMs"],
      rollingDrawdownMinPeakPct: ["management", "rollingDrawdownMinPeakPct"],
      rollingDrawdownCurrentPnlPct: ["management", "rollingDrawdownCurrentPnlPct"],
      rollingDrawdownMinDropPct: ["management", "rollingDrawdownMinDropPct"],
      ohlcvDrawdownShadowEnabled: ["management", "ohlcvDrawdownShadowEnabled"],
      ohlcvDrawdownShadowBotName: ["management", "ohlcvDrawdownShadowBotName"],
      ohlcvDrawdownShadowAggregateMin: ["management", "ohlcvDrawdownShadowAggregateMin"],
      ohlcvDrawdownShadowEntryDrawdownPct: ["management", "ohlcvDrawdownShadowEntryDrawdownPct"],
      ohlcvDrawdownShadowHighDrawdownPct: ["management", "ohlcvDrawdownShadowHighDrawdownPct"],
      ohlcvDrawdownShadowPnlDivergenceMinPnlPct: ["management", "ohlcvDrawdownShadowPnlDivergenceMinPnlPct"],
      ohlcvDrawdownShadowCombinedPeakPct: ["management", "ohlcvDrawdownShadowCombinedPeakPct"],
      ohlcvDrawdownShadowCombinedCurrentPnlPct: ["management", "ohlcvDrawdownShadowCombinedCurrentPnlPct"],
      takeProfitPct: ["management", "takeProfitPct"],
      takeProfitFeePct: ["management", "takeProfitPct"],
      trailingTakeProfit: ["management", "trailingTakeProfit"],
      trailingTriggerPct: ["management", "trailingTriggerPct"],
      trailingDropPct: ["management", "trailingDropPct"],
      profitGivebackEmergencyEnabled: ["management", "profitGivebackEmergencyEnabled"],
      profitGivebackTriggerPct: ["management", "profitGivebackTriggerPct"],
      profitGivebackFloorPct: ["management", "profitGivebackFloorPct"],
      pnlSanityMaxDiffPct: ["management", "pnlSanityMaxDiffPct"],
      earlyDumpPct: ["management", "earlyDumpPct"],
      earlyDumpMaxAgeMin: ["management", "earlyDumpMaxAgeMin"],
      solMode: ["management", "solMode"],
      minSolToOpen: ["management", "minSolToOpen"],
      deployAmountSol: ["management", "deployAmountSol"],
      gasReserve: ["management", "gasReserve"],
      positionSizePct: ["management", "positionSizePct"],
      minAgeBeforeYieldCheck: ["management", "minAgeBeforeYieldCheck"],
      // risk
      maxPositions: ["risk", "maxPositions"],
      maxDeployAmount: ["risk", "maxDeployAmount"],
      // schedule
      managementIntervalMin: ["schedule", "managementIntervalMin"],
      screeningIntervalMin: ["schedule", "screeningIntervalMin"],
      healthCheckIntervalMin: ["schedule", "healthCheckIntervalMin"],
      pnlPollIntervalMs: ["schedule", "pnlPollIntervalMs"],
      // pnl source
      pnlSource: ["pnl", "source"],
      pnlRpcUrl: ["pnl", "rpcUrl"],
      pnlDepositCacheTtlSec: ["pnl", "depositCacheTtlSec"],
      // performance outcome classification
      materialWinPct: ["performance", "materialWinPct"],
      materialLossPct: ["performance", "materialLossPct"],
      dustNeutralAbsPct: ["performance", "dustNeutralAbsPct"],
      neutralCloseReasonBuckets: ["performance", "neutralCloseReasonBuckets"],
      darwinUseMaterialOutcomes: ["performance", "darwinUseMaterialOutcomes"],
      darwinExcludeNeutralOutcomes: ["performance", "darwinExcludeNeutralOutcomes"],
      // model routing is operator-only — not LLM-mutable
      // strategy
      strategy: ["strategy", "strategy"],
      binsBelow: ["strategy", "binsBelow"],
      dynamicPoolSizingEnabled: ["strategy", "dynamicPoolSizingEnabled"],
      dynamicPoolSizingMode: ["strategy", "dynamicPoolSizingMode"],
      dynamicPoolSizingTargetActiveTvlSharePct: ["strategy", "dynamicPoolSizingTargetActiveTvlSharePct"],
      dynamicPoolSizingHardActiveTvlSharePct: ["strategy", "dynamicPoolSizingHardActiveTvlSharePct"],
      dynamicPoolSizingMinDeploySol: ["strategy", "dynamicPoolSizingMinDeploySol"],
      dynamicPoolSizingMaxDeploySol: ["strategy", "dynamicPoolSizingMaxDeploySol"],
      dynamicPoolSizingBlockBelowMin: ["strategy", "dynamicPoolSizingBlockBelowMin"],
      dynamicPoolSizingBlockOnMissingInputs: ["strategy", "dynamicPoolSizingBlockOnMissingInputs"],
      // hivemind
      hiveMindUrl: ["hiveMind", "url"],
      hiveMindApiKey: ["hiveMind", "apiKey"],
      agentId: ["hiveMind", "agentId"],
      hiveMindPullMode: ["hiveMind", "pullMode"],
      // meridian api / relay
      publicApiKey: ["api", "publicApiKey"],
      agentMeridianApiUrl: ["api", "url"],
      lpAgentRelayEnabled: ["api", "lpAgentRelayEnabled"],
    };

    const applied = {};
    const unknown = [];

    // Build case-insensitive lookup
    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );

    for (const [key, val] of Object.entries(changes)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      applied[match[0]] = val;
    }

    if (Object.keys(applied).length === 0) {
      log("config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`);
      return { success: false, unknown, reason };
    }

    // Apply to live config immediately
    for (const [key, val] of Object.entries(applied)) {
      const [section, field] = CONFIG_MAP[key];
      const before = config[section][field];
      config[section][field] = val;
      log("config", `update_config: config.${section}.${field} ${before} → ${val} (verify: ${config[section][field]})`);
    }

    // Persist to user-config.json
    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /**/ }
    }
    Object.assign(userConfig, applied);
    userConfig._lastAgentTune = new Date().toISOString();
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

    // Restart cron jobs if intervals changed
    const intervalChanged = applied.managementIntervalMin != null ||
      applied.screeningIntervalMin != null ||
      applied.pnlPollIntervalMs != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("config", `Cron reloaded — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m, pnlPoll: ${config.schedule.pnlPollIntervalMs}ms`);
    }

    // Save as a lesson — but skip ephemeral per-deploy interval changes
    // (managementIntervalMin / screeningIntervalMin change every deploy based on volatility;
    //  the rule is already in the system prompt, storing it 75+ times is pure noise)
    const lessonsKeys = Object.keys(applied).filter(
      k => k !== "managementIntervalMin" && k !== "screeningIntervalMin" && k !== "pnlPollIntervalMs"
    );
    if (lessonsKeys.length > 0) {
      const summary = lessonsKeys.map(k => `${k}=${applied[k]}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, reason };
  },
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
]);
const PROTECTED_TOOLS = new Set([
  ...WRITE_TOOLS,
  "self_update",
]);

const POST_CLOSE_SWAP_MAX_ATTEMPTS = Math.max(1, Number(process.env.POST_CLOSE_SWAP_MAX_ATTEMPTS || 3));
const POST_CLOSE_SWAP_RETRY_DELAY_MS = Math.max(0, Number(process.env.POST_CLOSE_SWAP_RETRY_DELAY_MS || 1500));
const POST_CLOSE_SWAP_DUST_USD = 0.10;
const RESIDUAL_TOKEN_DEPLOY_BLOCK_USD = Math.max(0, Number(process.env.RESIDUAL_TOKEN_DEPLOY_BLOCK_USD || POST_CLOSE_SWAP_DUST_USD));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSolToken(token = {}) {
  return token.symbol === "SOL" ||
    token.mint === config.tokens.SOL ||
    token.mint === "So11111111111111111111111111111111111111111" ||
    token.mint === "So11111111111111111111111111111111111111112";
}

function getResidualTokensAboveThreshold(balances = {}, thresholdUsd = RESIDUAL_TOKEN_DEPLOY_BLOCK_USD) {
  return (balances.tokens || [])
    .filter((token) => !isSolToken(token))
    .filter((token) => Number(token.balance || 0) > 0)
    .filter((token) => Number(token.usd ?? 0) >= thresholdUsd)
    .map((token) => ({
      mint: token.mint,
      symbol: token.symbol || token.mint?.slice(0, 8),
      balance: token.balance,
      usd: token.usd,
    }));
}

function hasSwapAmountOut(swapResult) {
  return swapResult?.amount_out != null &&
    swapResult.amount_out !== "" &&
    swapResult.amount_out !== "0" &&
    Number(swapResult.amount_out) !== 0;
}

function markPostCloseSwap(result, fields) {
  result.post_close_swap_status = fields.status;
  result.post_close_swap_error = fields.error ?? null;
  result.residual_base_mint = fields.residualBaseMint ?? null;
  result.residual_token_amount = fields.residualTokenAmount ?? null;
  result.residual_token_usd = fields.residualTokenUsd ?? null;
  result.requires_operator_attention = fields.requiresOperatorAttention === true;
  result.auto_swapped = fields.status === "success";

  if (result.adaptive_close) {
    result.adaptive_close.post_close_swap_status = fields.status;
    result.adaptive_close.post_close_swap_error = fields.error ?? null;
    result.adaptive_close.post_close_swap_attempts = fields.attempts ?? null;
    result.adaptive_close.final_sol_received = fields.solReceived ?? null;
  }
}

function appendPostCloseSwapTrace({ result, token = null, swapResult = null, status, attempt = null, error = null, residual = null }) {
  const trace = swapResult?.swap_trace ?? null;
  const ts = new Date();
  appendJsonl(jsonlPath("logs", "post-close-swap-trace", ts), {
    ts: ts.toISOString(),
    event: "post_close_swap_trace",
    trace_source: "meridian_close_autoswap",
    position: result.position ?? result.position_address ?? null,
    pool: result.pool ?? result.pool_address ?? null,
    pair: result.pool_name ?? result.pair ?? null,
    close_reason: result.close_reason ?? result.reason ?? null,
    pnl_usd: result.pnl_usd ?? null,
    pnl_pct: result.pnl_pct ?? null,
    base_mint: result.base_mint ?? token?.mint ?? null,
    token_symbol: token?.symbol ?? null,
    token_balance: token?.balance ?? null,
    token_usd: token?.usd ?? null,
    attempt,
    post_close_swap_status: status,
    post_close_swap_error: error,
    tx: swapResult?.tx ?? null,
    residual_token_amount: residual?.balance ?? null,
    residual_token_usd: residual?.usd ?? null,
    swap_trace: trace,
  });
}

async function finalizePostCloseAutoSwap(result) {
  if (!result.base_mint) return;

  const autoSwapStartedAt = Date.now();
  let token = null;
  let lastError = null;
  let attempts = 0;
  let lastSwapResult = null;

  try {
    const balances = await getWalletBalances({});
    token = balances.tokens?.find((t) => t.mint === result.base_mint);
    if (!token || Number(token.usd ?? 0) < POST_CLOSE_SWAP_DUST_USD || Number(token.balance || 0) <= 0) {
      markPostCloseSwap(result, {
        status: "not_needed",
        attempts: 0,
      });
      return;
    }

    for (let attempt = 1; attempt <= POST_CLOSE_SWAP_MAX_ATTEMPTS; attempt += 1) {
      attempts = attempt;
      log(
        "executor",
        `Auto-swapping ${token.symbol || result.base_mint.slice(0, 8)} ($${Number(token.usd || 0).toFixed(2)}) back to SOL ` +
        `(attempt ${attempt}/${POST_CLOSE_SWAP_MAX_ATTEMPTS})`,
      );
      const swapResult = await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: token.balance });
      lastSwapResult = swapResult;
      if (swapResult?.success === true && hasSwapAmountOut(swapResult)) {
        result.sol_received = swapResult.amount_out;
        result.post_close_swap_trace = swapResult.swap_trace ?? null;
        result.auto_swap_note = `Base token already auto-swapped back to SOL (${token.symbol || result.base_mint.slice(0, 8)} → SOL). Do NOT call swap_token again.`;
        markPostCloseSwap(result, {
          status: "success",
          attempts: attempt,
          solReceived: swapResult.amount_out,
        });
        if (result.adaptive_close) {
          result.adaptive_close.post_close_swap_ms = Date.now() - autoSwapStartedAt;
        }
        appendPostCloseSwapTrace({ result, token, swapResult, status: "success", attempt });
        return;
      }

      lastError = swapResult?.error || "swap returned no output amount";
      if (attempt < POST_CLOSE_SWAP_MAX_ATTEMPTS && POST_CLOSE_SWAP_RETRY_DELAY_MS > 0) {
        await sleep(POST_CLOSE_SWAP_RETRY_DELAY_MS);
      }
    }
  } catch (error) {
    lastError = error.message;
  }

  let residual = token;
  try {
    const balances = await getWalletBalances({});
    residual = balances.tokens?.find((t) => t.mint === result.base_mint) || token;
  } catch {
    // Preserve the pre-swap token observation if refresh fails.
  }

  markPostCloseSwap(result, {
    status: "failed",
    error: lastError || "post-close autoswap failed",
    attempts,
    residualBaseMint: result.base_mint,
    residualTokenAmount: residual?.balance ?? token?.balance ?? null,
    residualTokenUsd: residual?.usd ?? token?.usd ?? null,
    requiresOperatorAttention: true,
  });
  if (result.adaptive_close) {
    result.adaptive_close.post_close_swap_ms = Date.now() - autoSwapStartedAt;
  }
  appendPostCloseSwapTrace({
    result,
    token,
    swapResult: lastSwapResult,
    status: "failed",
    attempt: attempts,
    error: lastError || "post-close autoswap failed",
    residual,
  });
  log(
    "executor_error",
    `Post-close autoswap failed after ${attempts} attempt(s): ${lastError || "unknown error"}; ` +
    `residual ${residual?.symbol || result.base_mint.slice(0, 8)}=${residual?.balance ?? "unknown"} ` +
    `($${residual?.usd ?? "unknown"})`,
  );
}

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args) {
  const startTime = Date.now();

  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  name = name.replace(/<.*$/, "").trim();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  if (name === "update_config") {
    const reason = String(args?.reason || "").trim();
    if (!OPERATOR_UPDATE_CONFIG_REASONS.has(reason)) {
      return {
        success: false,
        blocked: true,
        reason: "update_config is operator-only. Use explicit operator paths such as /setcfg or CLI config set.",
      };
    }
  }

  if (name === "deploy_position") {
    const walletSnapshot = process.env.DRY_RUN === "true"
      ? { sol: null, sol_price: args?.sol_usd ?? args?.sol_price ?? null }
      : await getWalletBalances().catch(() => ({ sol: null, sol_price: args?.sol_usd ?? args?.sol_price ?? null }));
    const dynamicPoolSizing = applyDynamicPoolSizing(args, config, {
      solUsd: walletSnapshot?.sol_price ?? args?.sol_usd ?? args?.sol_price ?? null,
    });
    args = dynamicPoolSizing.args;
    if (!dynamicPoolSizing.ok) {
      log("deploy_reject", `[dynamic-pool-sizing] ${dynamicPoolSizing.reason}`);
      appendDecisionContext({
        stage: "deploy_reject",
        actor: "SCREENER",
        pool: args?.pool_address ?? null,
        poolName: args?.pool_name ?? null,
        baseMint: args?.base_mint ?? null,
        reason: dynamicPoolSizing.reason,
        metrics: {
          dynamic_pool_sizing_decision: dynamicPoolSizing.decision,
        },
        deploy: {
          dynamic_pool_sizing_decision: dynamicPoolSizing.decision,
          args,
        },
        source: "executor.dynamic_pool_sizing",
      });
      return {
        success: false,
        blocked: true,
        reason: dynamicPoolSizing.reason,
        dynamic_pool_sizing_decision: dynamicPoolSizing.decision,
      };
    }
    if (dynamicPoolSizing.decision?.decision === "override") {
      log("deploy", `[dynamic-pool-sizing] Override amount_y ${dynamicPoolSizing.decision.original_amount_y} -> ${dynamicPoolSizing.decision.final_amount_y} active_tvl=$${dynamicPoolSizing.decision.active_tvl_usd} sol=$${dynamicPoolSizing.decision.sol_usd}`);
    } else if (dynamicPoolSizing.decision?.decision === "shadow_only") {
      log("deploy", `[dynamic-pool-sizing] Shadow decision=${JSON.stringify(dynamicPoolSizing.decision)}`);
    }

    const forcedDeployAmountSol = dynamicPoolSizing.decision?.live_applied === true && dynamicPoolSizing.decision?.final_amount_y != null
      ? dynamicPoolSizing.decision.final_amount_y
      : process.env.DRY_RUN === "true"
      ? config.management.deployAmountSol
      : computeDeployAmount(walletSnapshot?.sol);
    const activeRangePolicy = resolveStrategyRangePolicy(getActiveStrategy(), config);
    const forcedDeploy = normalizeForcedSingleSidedSolBidAskArgs(args, {
      force: config.strategy.forceSingleSidedSolBidAsk || activeRangePolicy.singleSidedSol,
      deployAmountSol: Number.isFinite(forcedDeployAmountSol) ? forcedDeployAmountSol : config.management.deployAmountSol,
      strategy: activeRangePolicy.lpStrategy || config.strategy.strategy,
      binsBelow: activeRangePolicy.binsBelowDefault ?? (activeRangePolicy.targetDownsidePct != null ? null : config.strategy.binsBelow),
      binsBelowMin: activeRangePolicy.binsBelowMin,
      binsBelowMax: activeRangePolicy.binsBelowMax,
      binsAbove: activeRangePolicy.binsAbove ?? 0,
      targetDownsidePct: activeRangePolicy.targetDownsidePct,
    });
    if (!forcedDeploy.ok) {
      log("deploy_reject", `[forced-single-side-bidask] ${forcedDeploy.reason}`);
      appendDecisionContext({
        stage: "deploy_reject",
        actor: "SCREENER",
        pool: args?.pool_address ?? null,
        poolName: args?.pool_name ?? null,
        baseMint: args?.base_mint ?? null,
        reason: forcedDeploy.reason,
        deploy: {
          forced_single_side_bidask: true,
          args,
          details: forcedDeploy.details ?? null,
        },
        source: "executor.forced_single_side_bidask",
      });
      return {
        success: false,
        blocked: true,
        retryable_tool_args: forcedDeploy.retryableToolArgs === true,
        reason: forcedDeploy.reason,
        details: forcedDeploy.details ?? null,
      };
    }
    if (forcedDeploy.repaired) {
      log("deploy", `[forced-single-side-bidask] Repaired deploy args: ${JSON.stringify(forcedDeploy.repairs)}`);
      args = forcedDeploy.args;
    }

    const rangeWidth = applyRangeWidthDecision(args, config);
    args = rangeWidth.args;
    if (!rangeWidth.ok) {
      log("deploy_reject", `[range-width-decision] ${rangeWidth.reason}`);
      appendDecisionContext({
        stage: "deploy_reject",
        actor: "SCREENER",
        pool: args?.pool_address ?? null,
        poolName: args?.pool_name ?? null,
        baseMint: args?.base_mint ?? null,
        reason: rangeWidth.reason,
        metrics: {
          range_width_decision: rangeWidth.decision,
        },
        deploy: {
          range_width_decision: rangeWidth.decision,
          args,
        },
        source: "executor.range_width_decision",
      });
      return {
        success: false,
        blocked: true,
        reason: rangeWidth.reason,
        range_width_decision: rangeWidth.decision,
      };
    }
    if (rangeWidth.decision?.decision === "override") {
      log("deploy", `[range-width-decision] Override bins_below ${rangeWidth.decision.original_bins_below} -> ${rangeWidth.decision.final_bins_below} target=${rangeWidth.decision.target_downside_pct}% step=${rangeWidth.decision.bin_step}`);
    } else if (rangeWidth.decision?.decision === "shadow_only") {
      log("deploy", `[range-width-decision] Shadow decision=${JSON.stringify(rangeWidth.decision)}`);
    }

    const fabriqOhlcvEntryGate = await evaluateFabriqOhlcvEntryGate({
      ...args,
      pool: args?.pool_address,
      pool_address: args?.pool_address,
      name: args?.pool_name,
      base_mint: args?.base_mint,
    }, config);
    if (fabriqOhlcvEntryGate.enabled) {
      args = {
        ...args,
        fabriq_ohlcv_entry_gate: fabriqOhlcvEntryGate,
      };
      log("deploy", `[fabriq-ohlcv-entry-gate] result=${fabriqOhlcvEntryGate.result} provider=${fabriqOhlcvEntryGate.decisive_provider ?? "none"} rows=${fabriqOhlcvEntryGate.row_count}`);
      if (
        fabriqOhlcvEntryGate.live_applied === true &&
        (
          fabriqOhlcvEntryGate.result === "reject" ||
          (fabriqOhlcvEntryGate.result === "missing_evidence" && config.screening.fabriqOhlcvEntryGateBlockOnMissingOhlcv !== false)
        )
      ) {
        const reason = fabriqOhlcvEntryGate.result === "missing_evidence"
          ? "fabriq OHLCV entry gate missing evidence"
          : "fabriq OHLCV entry gate rejected candidate";
        appendDecisionContext({
          stage: "deploy_reject",
          actor: "SCREENER",
          pool: args?.pool_address ?? null,
          poolName: args?.pool_name ?? null,
          baseMint: args?.base_mint ?? null,
          reason,
          metrics: {
            fabriq_ohlcv_entry_gate: fabriqOhlcvEntryGate,
          },
          deploy: {
            fabriq_ohlcv_entry_gate: fabriqOhlcvEntryGate,
            args,
          },
          source: "executor.fabriq_ohlcv_entry_gate",
        });
        return {
          success: false,
          blocked: true,
          reason,
          fabriq_ohlcv_entry_gate: fabriqOhlcvEntryGate,
        };
      }
    }

    const targetPoolNeedleGuard = await evaluateTargetPoolNeedleDeployGuard({
      ...args,
      pool: args?.pool_address,
      pool_address: args?.pool_address,
      name: args?.pool_name,
      base_mint: args?.base_mint,
    }, config.screening);
    if (targetPoolNeedleGuard.decision === "blocked") {
      return {
        success: false,
        blocked: true,
        reason: "target-pool needle veto live block",
        details: targetPoolNeedleGuard,
      };
    }
  }

  // ─── Pre-execution safety checks ──────────
  if (PROTECTED_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      if (name === "deploy_position") {
        appendDecisionContext({
          stage: "deploy_reject",
          actor: "SCREENER",
          pool: args?.pool_address ?? null,
          poolName: args?.pool_name ?? null,
          baseMint: args?.base_mint ?? null,
          reason: safetyCheck.reason,
          deploy: {
            safety_block: true,
            args,
          },
          source: "executor.safety_block",
        });
      }
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  }

  // ─── Execute ──────────────────────────────
  try {
    const result = await fn(args);
    let duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;
    const delayCloseActionLog = name === "close_position";

    if (!delayCloseActionLog) {
      logAction({
        tool: name,
        args,
        result: summarizeResult(result),
        duration_ms: duration,
        success,
      });
    }

    if (success) {
      if (name === "swap_token" && result.tx) {
        notifySwap({ inputSymbol: args.input_mint?.slice(0, 8), outputSymbol: args.output_mint === "So11111111111111111111111111111111111111112" || args.output_mint === "SOL" ? "SOL" : args.output_mint?.slice(0, 8), amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch(() => {});
      } else if (name === "deploy_position") {
        notifyDeploy({ pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8), amountSol: args.amount_y ?? args.amount_sol ?? 0, position: result.position, tx: result.txs?.[0] ?? result.tx, priceRange: result.price_range, rangeCoverage: result.range_coverage, binStep: result.bin_step, baseFee: result.base_fee }).catch(() => {});
      } else if (name === "close_position") {
        notifyClose({ pair: result.pool_name || args.position_address?.slice(0, 8), pnlUsd: result.pnl_usd ?? 0, pnlPct: result.pnl_pct ?? 0 }).catch(() => {});
        // Note low-yield closes in pool memory so screener avoids redeploying
        if (args.reason && args.reason.toLowerCase().includes("yield")) {
          const poolAddr = result.pool || args.pool_address;
          if (poolAddr) addPoolNote({ pool_address: poolAddr, note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0,10)}` }).catch?.(() => {});
        }
        // Auto-swap base token back to SOL unless user said to hold
        if (!args.skip_swap && !result.skip_post_close_swap && result.base_mint) {
          await finalizePostCloseAutoSwap(result);
        } else if (args.skip_swap || result.skip_post_close_swap) {
          markPostCloseSwap(result, { status: "skipped", attempts: 0 });
          if (result.adaptive_close) {
            result.adaptive_close.post_close_swap_ms = 0;
            result.adaptive_close.post_close_swap_skipped = true;
          }
        }
      } else if (name === "claim_fees" && config.management.autoSwapAfterClaim && result.base_mint) {
        try {
          const balances = await getWalletBalances({});
          const token = balances.tokens?.find(t => t.mint === result.base_mint);
          if (token && token.usd >= 0.10) {
            log("executor", `Auto-swapping claimed ${token.symbol || result.base_mint.slice(0, 8)} ($${token.usd.toFixed(2)}) back to SOL`);
            await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: token.balance });
          }
        } catch (e) {
          log("executor_warn", `Auto-swap after claim failed: ${e.message}`);
        }
      }
    }

    if (delayCloseActionLog) {
      duration = Date.now() - startTime;
      logAction({
        tool: name,
        args,
        result: summarizeResult(result),
        duration_ms: duration,
        success,
      });
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Return error to LLM so it can decide what to do
    return {
      error: error.message,
      tool: name,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      if (process.env.DRY_RUN !== "true") {
        const balances = await getWalletBalances();
        const residualTokens = getResidualTokensAboveThreshold(balances);
        if (residualTokens.length > 0) {
          const sample = residualTokens
            .slice(0, 3)
            .map((token) => `${token.symbol || token.mint.slice(0, 8)} $${token.usd}`)
            .join(", ");
          return {
            pass: false,
            reason: `Residual non-SOL token(s) above $${RESIDUAL_TOKEN_DEPLOY_BLOCK_USD} block deploy until swapped: ${sample}.`,
          };
        }
      }

      // Reject pools with bin_step out of configured range
      const minStep = config.screening.minBinStep;
      const maxStep = config.screening.maxBinStep;
      if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        };
      }

      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      const positions = await getMyPositions({ force: true });
      if (positions.total_positions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      const alreadyInPool = positions.positions.some(
        (p) => p.pool === args.pool_address
      );
      if (alreadyInPool) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
        };
      }

      // Block same base token across different pools
      if (args.base_mint) {
        const alreadyHasMint = positions.positions.some(
          (p) => p.base_mint === args.base_mint
        );
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
          };
        }
      }

      // Check amount limits
      const amountY = args.amount_y ?? args.amount_sol ?? 0;
      if (amountY <= 0) {
        return {
          pass: false,
          reason: `Must provide a positive SOL amount (amount_y).`,
        };
      }

      const dynamicSizingMin = args.dynamic_pool_sizing_decision?.live_applied === true
        ? Number(args.dynamic_pool_sizing_decision?.min_deploy_sol)
        : null;
      const minDeploy = Math.max(0.1, Number.isFinite(dynamicSizingMin) ? dynamicSizingMin : config.management.deployAmountSol);
      if (amountY < minDeploy) {
        return {
          pass: false,
          reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
        };
      }
      if (amountY > config.risk.maxDeployAmount) {
        return {
          pass: false,
          reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
        };
      }

      // Check SOL balance
      if (process.env.DRY_RUN !== "true") {
        const balance = await getWalletBalances();
        const gasReserve = config.management.gasReserve;
        const minRequired = amountY + gasReserve;
        if (balance.sol < minRequired) {
          return {
            pass: false,
            reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
          };
        }
      }

      return { pass: true };
    }

    case "swap_token": {
      // Basic check — prevent swapping when DRY_RUN is true
      // (handled inside swapToken itself, but belt-and-suspenders)
      return { pass: true };
    }

    case "self_update": {
      if (process.env.ALLOW_SELF_UPDATE !== "true") {
        return {
          pass: false,
          reason: "self_update is disabled by default. Set ALLOW_SELF_UPDATE=true locally if you really want to enable it.",
        };
      }
      if (!process.stdin.isTTY) {
        return {
          pass: false,
          reason: "self_update is only allowed from a local interactive TTY session, not from Telegram or background automation.",
        };
      }
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  if (result?.adaptive_close) {
    return {
      success: result.success,
      relay: result.relay,
      close_mode: result.close_mode,
      adaptive_close: result.adaptive_close,
      position: result.position,
      pool: result.pool,
      pool_name: result.pool_name,
      pnl_usd: result.pnl_usd,
      pnl_pct: result.pnl_pct,
      sol_received: result.sol_received,
      auto_swapped: result.auto_swapped,
      post_close_swap_status: result.post_close_swap_status,
      post_close_swap_error: result.post_close_swap_error,
      post_close_swap_trace: result.post_close_swap_trace ? {
        router: result.post_close_swap_trace.router,
        mode: result.post_close_swap_trace.mode,
        price_impact_bps: result.post_close_swap_trace.price_impact_bps,
        actual_vs_expected_bps: result.post_close_swap_trace.actual_vs_expected_bps,
        value_leak_bps: result.post_close_swap_trace.value_leak_bps,
      } : null,
      residual_base_mint: result.residual_base_mint,
      residual_token_amount: result.residual_token_amount,
      residual_token_usd: result.residual_token_usd,
      requires_operator_attention: result.requires_operator_attention,
      skip_post_close_swap: result.skip_post_close_swap,
      txs: result.txs,
      close_txs: result.close_txs,
      error: result.error,
    };
  }
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}
