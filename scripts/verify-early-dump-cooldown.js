#!/usr/bin/env node
/**
 * Runtime proof for early-dump cooldown classification.
 *
 * Uses a temporary working directory so the real pool-memory.json and logs are
 * not modified. The close reason intentionally matches the legacy production
 * shape observed after the uncraft-SOL early-dump close.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

process.env.LOG_LEVEL = process.env.LOG_LEVEL || "error";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const originalCwd = process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), "meridian-early-dump-cooldown-"));
const poolMemoryPath = join(tempDir, "pool-memory.json");

let proof;
let failure;

try {
  process.chdir(tempDir);

  const [{ recordPoolDeploy }, { config }] = await Promise.all([
    import(pathToFileURL(join(ROOT, "pool-memory.js")).href),
    import(pathToFileURL(join(ROOT, "config.js")).href),
  ]);

  const poolAddress = "EarlyDumpPool111111111111111111111111111111";
  const baseMint = "EarlyDumpMint111111111111111111111111111111";
  const closeReason = "Trailing TP: Early dump: PnL -7.58% <= -7% within first 3.94m (limit: 20m)";
  const cooldownHours = Number(config.management?.stopLossCooldownHours ?? 12);

  if (!Number.isFinite(cooldownHours)) {
    throw new Error(`Invalid stopLossCooldownHours: ${config.management?.stopLossCooldownHours}`);
  }

  const before = Date.now();
  recordPoolDeploy(poolAddress, {
    pool_name: "uncraft-SOL proof",
    base_mint: baseMint,
    deployed_at: "2026-04-24T00:00:00.000Z",
    closed_at: "2026-04-24T00:03:56.000Z",
    pnl_pct: -7.58,
    pnl_usd: -0.15,
    range_efficiency: 0,
    minutes_held: 3.94,
    close_reason: closeReason,
    strategy: "sol_dca_accumulator",
  });
  const after = Date.now();

  if (!existsSync(poolMemoryPath)) {
    throw new Error("Temporary pool-memory.json was not created");
  }

  const db = JSON.parse(readFileSync(poolMemoryPath, "utf8"));
  const entry = db[poolAddress];
  if (!entry) {
    throw new Error("Proof pool was not recorded");
  }

  const poolCooldownUntilMs = Date.parse(entry.cooldown_until || "");
  const tokenCooldownUntilMs = Date.parse(entry.base_mint_cooldown_until || "");
  const expectedMs = cooldownHours * 60 * 60 * 1000;
  const minExpected = before + expectedMs - 2000;
  const maxExpected = after + expectedMs + 2000;

  if (entry.cooldown_reason !== "early dump") {
    throw new Error(`Expected pool cooldown reason "early dump", got ${entry.cooldown_reason}`);
  }
  if (entry.base_mint_cooldown_reason !== "early dump") {
    throw new Error(`Expected token cooldown reason "early dump", got ${entry.base_mint_cooldown_reason}`);
  }
  if (!Number.isFinite(poolCooldownUntilMs) || poolCooldownUntilMs < minExpected || poolCooldownUntilMs > maxExpected) {
    throw new Error(`Pool cooldown timestamp outside expected ${cooldownHours}h window`);
  }
  if (!Number.isFinite(tokenCooldownUntilMs) || tokenCooldownUntilMs < minExpected || tokenCooldownUntilMs > maxExpected) {
    throw new Error(`Token cooldown timestamp outside expected ${cooldownHours}h window`);
  }

  proof = {
    success: true,
    scenario: "legacy-prefixed early-dump close reason",
    closeReasonMatched: entry.deploys?.[0]?.close_reason === closeReason,
    cooldownHours,
    poolCooldownReason: entry.cooldown_reason,
    tokenCooldownReason: entry.base_mint_cooldown_reason,
    poolCooldownUntil: entry.cooldown_until,
    tokenCooldownUntil: entry.base_mint_cooldown_until,
    tempStateFileCreated: true,
  };
} catch (error) {
  failure = error;
} finally {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
}

if (failure) {
  console.error(failure.stack || failure.message);
  process.exit(1);
}

console.log(JSON.stringify({
  ...proof,
  tempDirRemoved: !existsSync(tempDir),
}, null, 2));
