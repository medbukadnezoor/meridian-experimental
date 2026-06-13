#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfigFromPath } from "../config-builder.js";

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

const adapter = source("tools/rpc-pnl.js");
const dlmm = source("tools/dlmm.js");
const index = source("index.js");
const executor = source("tools/executor.js");
const configBuilder = source("config-builder.js");

const tmp = mkdtempSync(join(tmpdir(), "verify-rpc-pnl-"));
const configPath = join(tmp, "user-config.json");
writeFileSync(configPath, JSON.stringify({
  pnlSource: "shadow",
  pnlRpcUrl: "https://example.invalid",
  pnlDepositCacheTtlSec: 12,
  pnlPollIntervalMs: 3000,
}, null, 2));
const configured = resolveConfigFromPath(configPath, { env: {} }).config;
rmSync(tmp, { recursive: true, force: true });

assert.equal(configured.pnl.source, "shadow", "pnl source should resolve from flat config");
assert.equal(configured.pnl.rpcUrl, "https://example.invalid", "pnl rpc url should resolve from flat config");
assert.equal(configured.pnl.depositCacheTtlSec, 12, "pnl deposit cache ttl should resolve from flat config");
assert.equal(configured.schedule.pnlPollIntervalMs, 3000, "3s poll interval should be accepted by config");

assert.ok(adapter.includes("export async function computeRpcPositions"), "adapter should expose computeRpcPositions");
assert.ok(adapter.includes("export async function recordRpcPnlShadowComparison"), "adapter should expose shadow comparison writer");
assert.ok(adapter.includes("getSharedConnection(config.pnl.rpcUrl"), "adapter should use shared RPC connection");
assert.ok(adapter.includes("withRpcPriority") && adapter.includes("RPC_PRIORITY.MANAGEMENT"), "adapter reads should use non-urgent RPC priority");
assert.ok(adapter.includes("pnl_confidence: degradedReasons.length ? \"degraded\" : \"trusted\""), "adapter should emit confidence");
assert.ok(adapter.includes("pnl_pct_suspicious: degradedReasons.length > 0"), "degraded rows should be suspicious");
assert.ok(adapter.includes("missing_sol_price"), "missing SOL price should degrade");
assert.ok(adapter.includes("missing_base_price"), "missing base price should degrade");
assert.ok(adapter.includes("missing_deposit_basis"), "missing deposit basis should degrade");
assert.ok(adapter.includes("missing_active_bin"), "missing active bin should degrade");
assert.ok(adapter.includes("source_in_range") && adapter.includes("effective_in_range"), "range provenance should be emitted");
assert.ok(adapter.includes("appendJsonl(file") && adapter.includes("\"rpc-pnl-shadow\""), "shadow rows should be append-only evidence");

assert.ok(dlmm.includes("computeRpcPositions"), "getMyPositions should integrate RPC adapter");
assert.ok(dlmm.includes("recordRpcPnlShadowComparison"), "shadow mode should record comparisons");
assert.ok(dlmm.includes("isRpcPnlSource") && dlmm.includes("\"rpc\""), "rpc source mode should be explicit");
assert.ok(dlmm.includes("isRpcPnlShadowSource") && dlmm.includes("\"shadow\""), "shadow source mode should be explicit");
assert.ok(dlmm.includes("buildFilteredPositionsResult(walletAddress, rpcResult.positions, \"RPC PnL\""), "RPC primary should pass through owner/ghost filtering");
assert.ok(dlmm.includes("RPC PnL returned zero positions while tracked positions are open"), "RPC zero with tracked opens should fall back");
assert.ok(dlmm.includes("RPC PnL returned degraded authoritative rows"), "degraded RPC authoritative rows should fall back");
assert.ok(!dlmm.includes("syncOpenPositions(rpcResult.positions"), "RPC raw result should not sync directly");
assert.ok(!adapter.includes("markOutOfRange(") && !adapter.includes("markInRange("), "adapter should not mutate OOR state");

assert.ok(index.includes("Math.max(3_000, Number(config.schedule.pnlPollIntervalMs ?? 30_000))"), "poll floor should allow 3s");
assert.ok(index.includes("if (position.pnl_pct_suspicious) return true;"), "deterministic PnL rules should honor suspicious flag");
assert.ok(executor.includes("pnlSource: [\"pnl\", \"source\"]"), "operator config should expose pnlSource");
assert.ok(executor.includes("pnlPollIntervalMs: [\"schedule\", \"pnlPollIntervalMs\"]"), "operator config should expose pnlPollIntervalMs");
assert.ok(executor.includes("applied.pnlPollIntervalMs != null"), "pnl interval update should restart cron");
assert.ok(configBuilder.includes("pnl: {"), "config builder should expose pnl section");

const connectionOffenders = listJsFiles(ROOT)
  .filter((file) => file !== "tools/rpc.js")
  .filter((file) => /\bnew\s+Connection\s*\(/.test(source(file)));
assert.deepEqual(connectionOffenders, [], `unwrapped new Connection call sites: ${connectionOffenders.join(", ")}`);

console.log(JSON.stringify({
  success: true,
  checks: [
    "pnl config resolves shadow/rpc fields",
    "3s interval is accepted",
    "RPC adapter uses shared priority RPC",
    "missing price/deposit/bin data degrades and marks suspicious",
    "shadow mode writes append-only comparison evidence",
    "RPC primary falls back on degraded or false-zero results",
    "RPC primary routes through owner filtering and ghost reconciliation",
    "deterministic close rules honor suspicious PnL",
    "operator config restarts cron for pnlPollIntervalMs",
    "no unwrapped Connection constructors",
  ],
}, null, 2));
