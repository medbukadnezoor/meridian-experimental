import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = __dirname;

function dateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function resolveApiLogsPath(date = new Date()) {
  const configured = process.env.API_LOGS_PATH;
  if (configured) {
    if (configured.endsWith(".jsonl")) return configured;
    return path.join(configured, `api-activity-${dateKey(date)}.jsonl`);
  }
  return path.join(REPO_ROOT, "logs", `api-activity-${dateKey(date)}.jsonl`);
}

function sanitizeErrorMessage(error) {
  return String(error?.message || error?.error?.message || error || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
    .replace(/dashscope[_-]?[A-Za-z0-9_-]+/gi, "dashscope_[redacted]")
    .slice(0, 500);
}

function sanitizeBaseUrlHost(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "invalid";
  }
}

function logApiActivity(data) {
  try {
    const logPath = resolveApiLogsPath();
    if (!fs.existsSync(path.dirname(logPath))) {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
    }
    fs.appendFileSync(logPath, JSON.stringify({ timestamp: new Date().toISOString(), ...data }) + "\n");
  } catch(e) {
    // Silent block to not disrupt the agent
  }
}

const MANAGER_TOOLS  = new Set(["close_position", "claim_fees", "swap_token", "get_position_pnl", "get_my_positions", "get_wallet_balance"]);
const SCREENER_TOOLS = new Set(["deploy_position", "get_active_bin", "get_top_candidates", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_pool_memory", "get_wallet_balance", "get_my_positions"]);
const GENERAL_INTENT_ONLY_TOOLS = new Set([
  "self_update",
  "add_to_blacklist",
  "remove_from_blacklist",
  "block_deployer",
  "unblock_deployer",
  "add_pool_note",
  "set_position_note",
  "add_smart_wallet",
  "remove_smart_wallet",
  "add_lesson",
  "pin_lesson",
  "unpin_lesson",
  "clear_lessons",
  "add_strategy",
  "remove_strategy",
  "set_active_strategy",
]);

// Intent → tool subsets for GENERAL role
const INTENT_TOOLS = {
  decisions:   new Set(["get_recent_decisions"]),
  deploy:      new Set(["deploy_position", "get_top_candidates", "get_active_bin", "get_pool_memory", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_wallet_balance", "get_my_positions", "add_pool_note"]),
  close:       new Set(["close_position", "get_my_positions", "get_position_pnl", "get_wallet_balance", "swap_token"]),
  claim:       new Set(["claim_fees", "get_my_positions", "get_position_pnl", "get_wallet_balance"]),
  swap:        new Set(["swap_token", "get_wallet_balance"]),
  blocklist:   new Set(["add_to_blacklist", "remove_from_blacklist", "list_blacklist", "block_deployer", "unblock_deployer", "list_blocked_deployers"]),
  selfupdate:  new Set(["self_update"]),
  balance:     new Set(["get_wallet_balance", "get_my_positions", "get_wallet_positions"]),
  positions:   new Set(["get_my_positions", "get_position_pnl", "get_wallet_balance", "set_position_note", "get_wallet_positions"]),
  strategy:    new Set(["list_strategies", "get_strategy", "add_strategy", "update_strategy", "delete_strategy", "remove_strategy", "set_active_strategy"]),
  screen:      new Set(["get_top_candidates", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "check_smart_wallets_on_pool", "get_pool_detail", "get_my_positions", "discover_pools"]),
  memory:      new Set(["get_pool_memory", "add_pool_note", "list_blacklist", "add_to_blacklist", "remove_from_blacklist"]),
  smartwallet: new Set(["add_smart_wallet", "remove_smart_wallet", "list_smart_wallets", "check_smart_wallets_on_pool"]),
  study:       new Set(["study_top_lpers", "get_top_lpers", "get_pool_detail", "search_pools", "get_token_info", "discover_pools", "add_smart_wallet", "list_smart_wallets"]),
  performance: new Set(["get_performance_history", "get_my_positions", "get_position_pnl"]),
  lessons:     new Set(["add_lesson", "pin_lesson", "unpin_lesson", "list_lessons", "clear_lessons"]),
};

const INTENT_PATTERNS = [
  { intent: "decisions",   re: /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i },
  { intent: "deploy",      re: /\b(deploy|open|add liquidity|lp into|invest in)\b/i },
  { intent: "close",       re: /\b(close|exit|withdraw|remove liquidity|shut down)\b/i },
  { intent: "claim",       re: /\b(claim|harvest|collect)\b.*\bfee/i },
  { intent: "swap",        re: /\b(swap|convert|sell|exchange)\b/i },
  { intent: "selfupdate",  re: /\b(self.?update|git pull|pull latest|update (the )?bot|update (the )?agent|update yourself)\b/i },
  { intent: "blocklist",   re: /\b(blacklist|block|unblock|blocklist|blocked deployer|rugger|block dev|block deployer)\b/i },
  { intent: "config",      re: /\b(config|setting|threshold|update|set |change)\b/i },
  { intent: "balance",     re: /\b(balance|wallet|sol|how much)\b/i },
  { intent: "positions",   re: /\b(position|portfolio|open|pnl|yield|range)\b/i },
  { intent: "strategy",    re: /\b(strategy|strategies)\b/i },
  { intent: "screen",      re: /\b(screen|candidate|find pool|search|research|token)\b/i },
  { intent: "memory",      re: /\b(memory|pool history|note|remember)\b/i },
  { intent: "smartwallet", re: /\b(smart wallet|kol|whale|watch.?list|add wallet|remove wallet|list wallet|tracked wallet|check pool|who.?s in|wallets in|add to (smart|watch|kol))\b/i },
  { intent: "study",       re: /\b(study top|top lpers?|best lpers?|who.?s lping|lp behavior|lpers?)\b/i },
  { intent: "performance", re: /\b(performance|history|how.?s the bot|how.?s it doing|stats|report)\b/i },
  { intent: "lessons",     re: /\b(lesson|learned|teach|pin|unpin|clear lesson|what did you learn)\b/i },
];

function getToolsForRole(agentType, goal = "") {
  if (agentType === "MANAGER")  return tools.filter(t => MANAGER_TOOLS.has(t.function.name));
  if (agentType === "SCREENER") return tools.filter(t => SCREENER_TOOLS.has(t.function.name));

  // GENERAL: match intent from goal, combine matched tool sets
  const matched = new Set();
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(goal)) {
      const intentTools = INTENT_TOOLS[intent];
      if (!intentTools) continue;
      for (const t of intentTools) matched.add(t);
    }
  }

  // Fall back to all tools if no intent matched
  if (matched.size === 0) return tools.filter(t => !GENERAL_INTENT_ONLY_TOOLS.has(t.function.name));
  return tools.filter(t => matched.has(t.function.name));
}
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { log } from "./logger.js";
import { config, resolveFallbackModel } from "./config.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";
import { getDecisionSummary } from "./decision-log.js";

// Supports OpenRouter (default) or any OpenAI-compatible endpoint (e.g. CLIProxy, DashScope).
// Per-role endpoints can be set via screeningBaseUrl/screeningApiKey etc. in user-config.json.
// SCREENER can also define a provider-level fallback route.
const _clientCache = new Map();
function getClientForRoute(route) {
  const cacheKey = `${route.role}:${route.routeKind}:${route.baseURL}:${route.apiKey ? "key" : "no-key"}`;
  if (_clientCache.has(cacheKey)) return _clientCache.get(cacheKey);
  const c = new OpenAI({ baseURL: route.baseURL, apiKey: route.apiKey || "NO_API_KEY", timeout: 5 * 60 * 1000 });
  _clientCache.set(cacheKey, c);
  return c;
}

function buildLlmRoute(agentType = "GENERAL", routeKind = "primary", modelOverride = null) {
  const role = (agentType || "GENERAL").toUpperCase();
  const llmCfg = config.llm;
  const globalUrl = process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1";
  const globalKey = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY;

  if (role === "SCREENER" && routeKind === "fallback" && llmCfg.screeningFallbackModel && llmCfg.screeningFallbackBaseUrl) {
    return {
      role,
      routeKind,
      model: llmCfg.screeningFallbackModel,
      baseURL: llmCfg.screeningFallbackBaseUrl,
      apiKey: llmCfg.screeningFallbackApiKey || globalKey,
    };
  }

  if (role === "SCREENER") {
    return {
      role,
      routeKind: "primary",
      model: modelOverride || llmCfg.screeningModel || process.env.LLM_MODEL || "openrouter/hunter-alpha",
      baseURL: llmCfg.screeningBaseUrl || globalUrl,
      apiKey: llmCfg.screeningApiKey || globalKey,
    };
  }

  if (role === "MANAGER") {
    return {
      role,
      routeKind: "primary",
      model: modelOverride || llmCfg.managementModel || process.env.LLM_MODEL || "openrouter/healer-alpha",
      baseURL: llmCfg.managementBaseUrl || globalUrl,
      apiKey: llmCfg.managementApiKey || globalKey,
    };
  }

  return {
    role,
    routeKind: "primary",
    model: modelOverride || llmCfg.generalModel || process.env.LLM_MODEL || "openrouter/healer-alpha",
    baseURL: llmCfg.generalBaseUrl || globalUrl,
    apiKey: llmCfg.generalApiKey || globalKey,
  };
}

function hasScreeningFallbackRoute() {
  return Boolean(config.llm.screeningFallbackModel && config.llm.screeningFallbackBaseUrl);
}

function isOpenRouterBaseUrl(baseUrl) {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

function providerIgnoreForBaseUrl(baseUrl) {
  return isOpenRouterBaseUrl(baseUrl) ? ["Parasail", "Nebius", "Together"] : [];
}

function isTransientProviderError(error) {
  const message = sanitizeErrorMessage(error);
  const code = String(error?.code || error?.cause?.code || "");
  const status = Number(error?.status || error?.response?.status || 0);
  return (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500 ||
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|timeout|timed out|socket hang up/i.test(`${code} ${message}`)
  );
}

function isMalformedProviderResponse(response) {
  return !response?.choices?.length;
}

const MUTATING_TOOL_INTENTS = /\b(deploy|open position|add liquidity|lp into|invest in|close|exit|withdraw|remove liquidity|claim|harvest|collect|swap|convert|sell|exchange|block|unblock|blacklist|add smart wallet|remove smart wallet|add wallet|remove wallet|pin|unpin|clear lesson|add lesson|set active strategy|remove strategy|add strategy|set |change |update |self.?update|pull latest|git pull|update yourself)\b/i;
const LIVE_DATA_TOOL_INTENTS = /\b(balance|wallet|position|portfolio|pnl|yield|range|show positions|open positions|screen|candidate|find pool|search|research|analyze|check pool|token holders|narrative|study top|top lpers?|lp behavior|who.?s lping|performance|history|stats|report|list smart wallets|list blacklist|list blocked deployers|list lessons)\b/i;
const CONFIG_READ_ONLY_INTENTS = /\b(check|show|what(?:'s| is)?|review|inspect|see)\b.*\b(config|settings?|thresholds?)\b/i;
const DECISION_EXPLANATION_INTENTS = /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i;

function shouldRequireRealToolUse(goal, agentType, interactive = false) {
  if (agentType === "MANAGER") return false;
  if (DECISION_EXPLANATION_INTENTS.test(goal)) return false;
  if (CONFIG_READ_ONLY_INTENTS.test(goal)) return false;
  if (MUTATING_TOOL_INTENTS.test(goal)) return true;
  return interactive && LIVE_DATA_TOOL_INTENTS.test(goal);
}

function buildMessages(systemPrompt, sessionHistory, goal, providerMode = "system") {
  if (providerMode === "user_embedded") {
    return [
      ...sessionHistory,
      {
        role: "user",
        content: `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${goal}`,
      },
    ];
  }

  return [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: goal },
  ];
}

function isSystemRoleError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /invalid message role:\s*system/i.test(message);
}

function isToolChoiceRequiredError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  // DashScope thinking mode rejects tool_choice set to "required" or "object"
  // OpenRouter returns 404 when the selected provider doesn't support tool_choice at all
  return (
    /tool_choice/i.test(message) &&
    (/required/i.test(message) || /object/i.test(message) || /thinking mode/i.test(message) || /no endpoints found/i.test(message) || /does not support/i.test(message))
  );
}

/**
 * Core ReAct agent loop.
 *
 * @param {string} goal - The task description for the agent
 * @param {number} maxSteps - Safety limit on iterations (default 20)
 * @returns {string} - The agent's final text response
 */
export async function agentLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = [], agentType = "GENERAL", model = null, maxOutputTokens = null, options = {}) {
  const { interactive = false, onToolStart = null, onToolFinish = null } = options;
  // Build dynamic system prompt with current portfolio state
  const [portfolio, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
  const stateSummary = getStateSummary();
  const lessons = getLessonsForPrompt({ agentType });
  const perfSummary = getPerformanceSummary();
  const decisionSummary = getDecisionSummary();
  let weightsSummary = null;
  if (agentType === "SCREENER") {
    try {
      const { getWeightsSummary } = await import("./signal-weights.js");
      const { config } = await import("./config.js");
      if (config.darwin?.enabled) weightsSummary = getWeightsSummary();
    } catch { /* signal-weights not critical */ }
  }
  const systemPrompt = buildSystemPrompt(agentType, portfolio, positions, stateSummary, lessons, perfSummary, weightsSummary, decisionSummary);

  let providerMode = "system";
  let messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);

  // Track write tools fired this session — prevent the model from calling the same
  // destructive tool twice (e.g. deploy twice, swap twice after auto-swap)
  const ONCE_PER_SESSION = new Set(["deploy_position", "swap_token", "close_position"]);
  // These lock after first attempt regardless of success — retrying them is always wrong
  const NO_RETRY_TOOLS = new Set(["deploy_position"]);
  const firedOnce = new Set();
  const mustUseRealTool = shouldRequireRealToolUse(goal, agentType, interactive);
  let sawToolCall = false;
  let noToolRetryCount = 0;

  let emptyStreak = 0;
  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      // Retry transient provider failures; SCREENER can switch endpoint/model to a Qwen fallback route.
      const FALLBACK_MODEL = resolveFallbackModel(config.llm.fallbackModel);
      let response;
      let activeRoute = buildLlmRoute(agentType, "primary", model);
      let usedModel = activeRoute.model;
      // Force a tool call on step 0 for action intents — prevents the model from inventing deploy/close outcomes
      // GLM and similar models don't support tool_choice: "required" — use "auto" for those
      const ACTION_INTENTS = /\b(deploy|open|add liquidity|close|exit|withdraw|claim|swap|block|unblock)\b/i;
      const modelSupportsRequiredToolChoice = !/glm|qwen|deepseek.*think/i.test(activeRoute.model);
      let toolChoice = (step === 0 && modelSupportsRequiredToolChoice && (ACTION_INTENTS.test(goal) || mustUseRealTool)) ? "required" : "auto";
      let providerIgnore = providerIgnoreForBaseUrl(activeRoute.baseURL);
      let switchedToProviderFallback = false;

      for (let attempt = 0; attempt < 3; attempt++) {
        let startTime = Date.now();
        try {
          const callParams = {
            model: activeRoute.model,
            messages,
            tools: getToolsForRole(agentType, goal),
            temperature: config.llm.temperature,
            max_tokens: maxOutputTokens ?? config.llm.maxTokens,
            ...(providerIgnore.length > 0 ? { provider: { ignore: providerIgnore } } : {}),
          };
          // Only include tool_choice if explicitly set — omitting it avoids DashScope thinking mode errors
          if (toolChoice !== undefined) callParams.tool_choice = toolChoice;
          response = await getClientForRoute(activeRoute).chat.completions.create(callParams);
          logApiActivity({
            agent_role: agentType,
            model: activeRoute.model,
            base_url_host: sanitizeBaseUrlHost(activeRoute.baseURL),
            route_kind: activeRoute.routeKind,
            duration_ms: Date.now() - startTime,
            status: "success",
            prompt_tokens: response?.usage?.prompt_tokens ?? null,
            completion_tokens: response?.usage?.completion_tokens ?? null,
            total_tokens: response?.usage?.total_tokens ?? null,
            cost: response?.usage?.cost || 0,
            provider: response?.provider || response?.system_fingerprint || "unknown",
          });
        } catch (error) {
          logApiActivity({
            agent_role: agentType,
            model: activeRoute.model,
            base_url_host: sanitizeBaseUrlHost(activeRoute.baseURL),
            route_kind: activeRoute.routeKind,
            duration_ms: Date.now() - startTime,
            status: "error",
            error: sanitizeErrorMessage(error),
            provider: "unknown",
          });
          if (providerMode === "system" && isSystemRoleError(error)) {
            providerMode = "user_embedded";
            messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);
            log("agent", "Provider rejected system role — retrying with embedded system instructions");
            attempt -= 1;
            continue;
          }
          if (isToolChoiceRequiredError(error)) {
            // DashScope thinking mode rejects tool_choice in any explicit form — omit the parameter entirely
            toolChoice = undefined;
            log("agent", `Provider rejected tool_choice (thinking mode) — retrying without tool_choice parameter`);
            attempt -= 1;
            continue;
          }
          if (providerIgnore.length > 0 && /400|Provider returned error/i.test(String(error?.message || error))) {
            log("agent", "Provider ignore list caused 400 — retrying without provider filter");
            providerIgnore = [];
            toolChoice = "auto";
            attempt -= 1;
            continue;
          }
          if (
            agentType === "SCREENER" &&
            activeRoute.routeKind === "primary" &&
            hasScreeningFallbackRoute() &&
            isTransientProviderError(error)
          ) {
            activeRoute = buildLlmRoute(agentType, "fallback");
            usedModel = activeRoute.model;
            providerIgnore = providerIgnoreForBaseUrl(activeRoute.baseURL);
            switchedToProviderFallback = true;
            log("agent", `SCREENER primary route failed (${sanitizeErrorMessage(error)}) — retrying via fallback ${activeRoute.model} on ${sanitizeBaseUrlHost(activeRoute.baseURL)}`);
            attempt = -1;
            continue;
          }
          throw error;
        }
        if (response.choices?.length) break;
        if (
          agentType === "SCREENER" &&
          activeRoute.routeKind === "primary" &&
          hasScreeningFallbackRoute() &&
          isMalformedProviderResponse(response)
        ) {
          logApiActivity({
            agent_role: agentType,
            model: activeRoute.model,
            base_url_host: sanitizeBaseUrlHost(activeRoute.baseURL),
            route_kind: activeRoute.routeKind,
            duration_ms: Date.now() - startTime,
            status: "error",
            error: "provider returned no choices",
            provider: response?.provider || "unknown",
          });
          activeRoute = buildLlmRoute(agentType, "fallback");
          usedModel = activeRoute.model;
          providerIgnore = providerIgnoreForBaseUrl(activeRoute.baseURL);
          switchedToProviderFallback = true;
          log("agent", `SCREENER primary route returned no choices — retrying via fallback ${activeRoute.model}`);
          attempt = -1;
          continue;
        }
        const errCode = response.error?.code;
        if (errCode === 502 || errCode === 503 || errCode === 529) {
          const wait = (attempt + 1) * 5000;
          if (agentType === "SCREENER" && activeRoute.routeKind === "primary" && hasScreeningFallbackRoute()) {
            activeRoute = buildLlmRoute(agentType, "fallback");
            usedModel = activeRoute.model;
            providerIgnore = providerIgnoreForBaseUrl(activeRoute.baseURL);
            switchedToProviderFallback = true;
            log("agent", `SCREENER provider error ${errCode} — switching to fallback route ${activeRoute.model}`);
            attempt = -1;
          } else if (attempt === 1 && usedModel !== FALLBACK_MODEL) {
            activeRoute = { ...activeRoute, model: FALLBACK_MODEL };
            usedModel = FALLBACK_MODEL;
            log("agent", `Switching to fallback model ${FALLBACK_MODEL}`);
          } else {
            log("agent", `Provider error ${errCode}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
            await new Promise((r) => setTimeout(r, wait));
          }
        } else {
          break;
        }
      }

      if (!response.choices?.length) {
        log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
        throw new Error(`API returned no choices: ${response.error?.message || JSON.stringify(response)}`);
      }
      if (switchedToProviderFallback) {
        log("agent", `SCREENER response completed via fallback route ${activeRoute.model}`);
      } else {
        log("agent", `${agentType} response completed via primary route ${activeRoute.model}`);
      }
      const msg = response.choices[0].message;
      // Repair malformed tool call JSON before pushing to history —
      // the API rejects the next request if history contains invalid JSON args
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments) {
            try {
              JSON.parse(tc.function.arguments);
            } catch {
              try {
                tc.function.arguments = JSON.stringify(JSON.parse(jsonrepair(tc.function.arguments)));
                log("warn", `Repaired malformed JSON args for ${tc.function.name}`);
              } catch {
                tc.function.arguments = "{}";
                log("error", `Could not repair JSON args for ${tc.function.name} — cleared to {}`);
              }
            }
          }
        }
      }
      messages.push(msg);

      // If the model didn't call any tools, it's done
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Hermes sometimes returns null content — pop the empty message and retry once
        if (!msg.content) {
          messages.pop(); // remove the empty assistant message
          log("agent", "Empty response, retrying...");
          continue;
        }
        if (mustUseRealTool && !sawToolCall) {
          noToolRetryCount += 1;
          messages.pop();
          log("agent", `Rejected no-tool final answer (${noToolRetryCount}/2) for tool-required request`);
          if (noToolRetryCount >= 2) {
            return {
              content: "I couldn't complete that reliably because no tool call was made. Please retry after checking the logs.",
              userMessage: goal,
            };
          }
          messages.push({
            role: providerMode === "system" ? "system" : "user",
            content: providerMode === "system"
              ? "You have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result."
              : "[SYSTEM REMINDER]\nYou have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result.",
          });
          continue;
        }
        log("agent", "Final answer reached");
        log("agent", msg.content);
        return { content: msg.content, userMessage: goal };
      }
      sawToolCall = true;

      // Execute each tool call in parallel
      const toolResults = await Promise.all(msg.tool_calls.map(async (toolCall) => {
        const functionName = toolCall.function.name.replace(/<.*$/, "").trim();
        let functionArgs;

        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          try {
            functionArgs = JSON.parse(jsonrepair(toolCall.function.arguments));
            log("warn", `Repaired malformed JSON args for ${functionName}`);
          } catch (parseError) {
            log("error", `Failed to parse args for ${functionName}: ${parseError.message}`);
            functionArgs = {};
          }
        }

        // Block once-per-session tools from firing a second time
        if (ONCE_PER_SESSION.has(functionName) && firedOnce.has(functionName)) {
          log("agent", `Blocked duplicate ${functionName} call — already executed this session`);
          await onToolFinish?.({
            name: functionName,
            args: functionArgs,
            result: { blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` },
            success: false,
            step,
          });
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` }),
          };
        }

        await onToolStart?.({ name: functionName, args: functionArgs, step });
        const result = await executeTool(functionName, functionArgs);
        await onToolFinish?.({
          name: functionName,
          args: functionArgs,
          result,
          success: result?.success !== false && !result?.error && !result?.blocked,
          step,
        });

        // Lock deploy_position after first attempt regardless of outcome — retrying is never right
        // For close/swap: only lock on success so genuine failures can be retried
        if (NO_RETRY_TOOLS.has(functionName)) firedOnce.add(functionName);
        else if (ONCE_PER_SESSION.has(functionName) && result.success === true) firedOnce.add(functionName);

        return {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        };
      }));

      messages.push(...toolResults);
    } catch (error) {
      log("error", `Agent loop error at step ${step}: ${error.message}`);

      // If it's a rate limit, wait and retry
      if (error.status === 429) {
        log("agent", "Rate limited, waiting 30s...");
        await sleep(30000);
        continue;
      }

      // For other errors, break the loop
      throw error;
    }
  }

  log("agent", "Max steps reached without final answer");
  return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
