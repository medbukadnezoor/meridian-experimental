#!/usr/bin/env node
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PriorityScheduler,
  RPC_PRIORITY,
  classifyProvider,
  getDeployRpcCooldownState,
  isRpcRateLimitError,
  recordDeployRpcRateLimit,
} from "../tools/rpc.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function source(file) {
  return readFileSync(join(ROOT, file), "utf8");
}

function listJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(ROOT, full);
    if (rel.startsWith("node_modules") || rel.startsWith("logs")) continue;
    const st = statSync(full);
    if (st.isDirectory()) listJsFiles(full, out);
    else if (entry.endsWith(".js")) out.push(rel);
  }
  return out;
}

async function urgentReadPreemptsScreening() {
  const scheduler = new PriorityScheduler({ reqPerSec: 50, lane: "read" });
  const starts = [];
  const low = Array.from({ length: 75 }, (_, index) =>
    scheduler.enqueue(
      RPC_PRIORITY.SCREENING,
      async () => starts.push({ kind: "screening", index, at: Date.now() }),
      { method: "test_screening", source: "helius_rpc.test" },
    )
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  const queuedAt = Date.now();
  await scheduler.enqueue(
    RPC_PRIORITY.URGENT_CLOSE,
    async () => starts.push({ kind: "urgent", at: Date.now(), queuedAt }),
    { method: "test_urgent_close", source: "helius_rpc.test" },
  );
  await Promise.all(low);
  const urgent = starts.find((s) => s.kind === "urgent");
  assert.ok(urgent, "urgent close task should run");
  assert.ok(urgent.at - urgent.queuedAt < 250, `urgent close waited ${urgent.at - urgent.queuedAt}ms`);
  const lowBeforeUrgent = starts.filter((s) => s.kind === "screening" && s.at < urgent.at).length;
  assert.ok(lowBeforeUrgent < 75, "urgent close should not sit behind all screening work");
  return { urgentQueuedMs: urgent.at - urgent.queuedAt, lowBeforeUrgent };
}

async function urgentSendPreemptsQueuedDeploy() {
  const scheduler = new PriorityScheduler({ reqPerSec: 2, lane: "send" });
  const order = [];
  const first = scheduler.enqueue(
    RPC_PRIORITY.NORMAL_SEND,
    async () => order.push("initial_send"),
    { method: "initial", source: "helius_rpc.test" },
  );
  const deploy = scheduler.enqueue(
    RPC_PRIORITY.NORMAL_SEND,
    async () => order.push("deploy_send"),
    { method: "deploy", source: "helius_rpc.test" },
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  const urgent = scheduler.enqueue(
    RPC_PRIORITY.URGENT_CLOSE,
    async () => order.push("urgent_close_send"),
    { method: "urgent_close", source: "helius_rpc.test" },
  );
  await Promise.all([first, deploy, urgent]);
  assert.deepEqual(order, ["initial_send", "urgent_close_send", "deploy_send"]);
  return { order };
}

const dlmm = source("tools/dlmm.js");
const index = source("index.js");
const rpc = source("tools/rpc.js");
const wallet = source("tools/wallet.js");
const configBuilder = source("config-builder.js");
const example = source("user-config.example.json");

const connectionOffenders = listJsFiles(ROOT)
  .filter((file) => file !== "tools/rpc.js")
  .filter((file) => /\bnew\s+Connection\s*\(/.test(source(file)));
assert.deepEqual(connectionOffenders, [], `unwrapped new Connection call sites: ${connectionOffenders.join(", ")}`);

assert.ok(rpc.includes("export class PriorityScheduler"), "scheduler should be exported for runtime proof");
assert.ok(rpc.includes("READ_METHODS") && rpc.includes("SEND_METHODS"), "read and send budgets should be separate");
assert.ok(rpc.includes("deploy_cooldown"), "deploy cooldown telemetry should exist");
assert.ok(configBuilder.includes("rpcPressure") && example.includes("\"rpcPressure\""), "rpc pressure config should be exposed");

assert.ok(dlmm.includes("assertDeployRpcCooldownClear()"), "deploy should check deploy-only RPC cooldown before opening");
assert.ok(dlmm.includes("recordDeployRpcRateLimit(error, \"deploy_position\")"), "deploy 429 should record deploy cooldown");
assert.ok(dlmm.includes("recordDeployRpcRateLimit(error, \"deploy_preflight_pool\")"), "pool preflight 429 should record deploy cooldown");
assert.ok(dlmm.includes("recordDeployRpcRateLimit(error, \"deploy_preflight_active_bin\")"), "active-bin preflight 429 should record deploy cooldown");
assert.ok(dlmm.includes("recordDeployRpcRateLimit(error, \"deploy_preflight_bin_array\")"), "bin-array preflight 429 should record deploy cooldown");
assert.ok(dlmm.includes("sendAndConfirmTransactionWithPriority"), "DLMM sends should use priority send wrapper");
assert.ok(dlmm.includes("close_verification_status: \"rpc_rate_limited\""), "close verification rate-limit degradation should preserve tx evidence");
assert.ok(dlmm.includes("RPC_PRIORITY.URGENT_CLOSE"), "urgent close paths should use P0 priority");
assert.ok(dlmm.includes("const closePriority = urgent ? RPC_PRIORITY.URGENT_CLOSE : RPC_PRIORITY.MANAGEMENT"), "urgent close should select P0 close priority");
assert.ok(dlmm.includes("`${closeSourcePrefix}_pool_create`"), "urgent close should create/load pool through close priority context");
assert.ok(dlmm.includes("`${closeSourcePrefix}_position_state`"), "urgent close position-state reads should run through close priority context");
assert.ok(dlmm.includes("`${closeSourcePrefix}_remove_liquidity_tx_build`"), "urgent close remove-liquidity tx build should run through close priority context");
assert.ok(rpc.includes("\"confirmTransaction\""), "confirmation polling should be wrapped as read RPC");
assert.ok(rpc.includes("error.rpcProvider = classifyProvider(job.meta.source)"), "RPC errors should be provider-tagged before deploy cooldown");

assert.ok(index.includes("mapWithConcurrency"), "screening active-bin prefetch should be concurrency-bounded");
assert.ok(index.includes("screeningActiveBinConcurrency"), "screening active-bin concurrency should be configurable");
assert.ok(!index.includes("if (_managementBusy || _screeningBusy || _pnlPollBusy) return;"), "PnL poll should not skip solely because screening is busy");

assert.equal(classifyProvider("helius_wallet_api.balance"), "helius_wallet_api");
assert.equal(classifyProvider("meteora_datapi.pool"), "meteora_datapi");
assert.equal(classifyProvider("lpagent.positions"), "lpagent");
assert.equal(classifyProvider("agent_meridian.relay"), "agent_meridian");
assert.equal(classifyProvider("jupiter.swap"), "jupiter");
assert.equal(classifyProvider("llm.agent"), "llm");
assert.equal(classifyProvider("unknown"), "helius_rpc");
assert.ok(wallet.includes("provider: \"helius_wallet_api\""), "Helius Wallet API should log distinct rate-limit source");
assert.ok(wallet.includes("provider: \"jupiter\""), "Jupiter should log distinct rate-limit source");

assert.ok(isRpcRateLimitError(new Error("429 Too Many Requests")));
assert.ok(isRpcRateLimitError(new Error("max usage reached")));
assert.ok(!isRpcRateLimitError(new Error("invalid account data")));
const cooldown = recordDeployRpcRateLimit(new Error("429 Too Many Requests"), "verify");
assert.equal(cooldown, null, "generic non-RPC 429 should not activate deploy RPC cooldown");
const rpc429 = new Error("429 Too Many Requests");
rpc429.rpcProvider = "helius_rpc";
const rpcCooldown = recordDeployRpcRateLimit(rpc429, "verify");
assert.ok(rpcCooldown.active, "deploy RPC cooldown should activate on Helius RPC 429");
assert.ok(getDeployRpcCooldownState().remaining_ms > 0, "deploy cooldown should expose remaining time");

const urgentRead = await urgentReadPreemptsScreening();
const urgentSend = await urgentSendPreemptsQueuedDeploy();

console.log(JSON.stringify({
  ok: true,
  checks: [
    "all live Connection constructors route through tools/rpc.js",
    "urgent close read priority preempts screening backlog",
    "urgent close send priority preempts queued deploy send",
    "deploy 429 creates deploy-only cooldown",
    "provider attribution distinguishes RPC, wallet, Meteora, Jupiter, LLM, LPAgent",
    "PnL poll is not blocked by screening busy state",
    "close verification can degrade without dropping tx evidence",
  ],
  urgentRead,
  urgentSend,
}, null, 2));
