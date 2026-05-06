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

  const cooldownHours = Number(config.management?.stopLossCooldownHours ?? 12);

  if (!Number.isFinite(cooldownHours)) {
    throw new Error(`Invalid stopLossCooldownHours: ${config.management?.stopLossCooldownHours}`);
  }

  const before = Date.now();
  const scenarios = [
    {
      key: "earlyDump",
      poolAddress: "EarlyDumpPool111111111111111111111111111111",
      baseMint: "EarlyDumpMint111111111111111111111111111111",
      poolName: "uncraft-SOL proof",
      closeReason: "Trailing TP: Early dump: PnL -7.58% <= -7% within first 3.94m (limit: 20m)",
      cooldownReason: "early dump",
      pnlPct: -7.58,
    },
    {
      key: "rollingFastDrawdown",
      poolAddress: "RollingDrawdownPool11111111111111111111111",
      baseMint: "RollingDrawdownMint11111111111111111111111",
      poolName: "rolling-SOL proof",
      closeReason: "Rolling fast drawdown: peak 4.25% -> current -3.14% (drop 7.39pp within 90m)",
      cooldownReason: "rolling fast drawdown",
      pnlPct: -3.14,
    },
  ];

  for (const scenario of scenarios) {
    recordPoolDeploy(scenario.poolAddress, {
      pool_name: scenario.poolName,
      base_mint: scenario.baseMint,
      deployed_at: "2026-04-24T00:00:00.000Z",
      closed_at: "2026-04-24T00:03:56.000Z",
      pnl_pct: scenario.pnlPct,
      pnl_usd: -0.15,
      range_efficiency: 0,
      minutes_held: 3.94,
      close_reason: scenario.closeReason,
      strategy: "sol_dca_accumulator",
    });
  }
  const after = Date.now();

  if (!existsSync(poolMemoryPath)) {
    throw new Error("Temporary pool-memory.json was not created");
  }

  const db = JSON.parse(readFileSync(poolMemoryPath, "utf8"));
  const expectedMs = cooldownHours * 60 * 60 * 1000;
  const minExpected = before + expectedMs - 2000;
  const maxExpected = after + expectedMs + 2000;
  const results = {};

  for (const scenario of scenarios) {
    const entry = db[scenario.poolAddress];
    if (!entry) {
      throw new Error(`Proof pool was not recorded: ${scenario.key}`);
    }

    const poolCooldownUntilMs = Date.parse(entry.cooldown_until || "");
    const tokenCooldownUntilMs = Date.parse(entry.base_mint_cooldown_until || "");

    if (entry.cooldown_reason !== scenario.cooldownReason) {
      throw new Error(`Expected pool cooldown reason "${scenario.cooldownReason}", got ${entry.cooldown_reason}`);
    }
    if (entry.base_mint_cooldown_reason !== scenario.cooldownReason) {
      throw new Error(`Expected token cooldown reason "${scenario.cooldownReason}", got ${entry.base_mint_cooldown_reason}`);
    }
    if (!Number.isFinite(poolCooldownUntilMs) || poolCooldownUntilMs < minExpected || poolCooldownUntilMs > maxExpected) {
      throw new Error(`Pool cooldown timestamp outside expected ${cooldownHours}h window for ${scenario.key}`);
    }
    if (!Number.isFinite(tokenCooldownUntilMs) || tokenCooldownUntilMs < minExpected || tokenCooldownUntilMs > maxExpected) {
      throw new Error(`Token cooldown timestamp outside expected ${cooldownHours}h window for ${scenario.key}`);
    }

    results[scenario.key] = {
      closeReasonMatched: entry.deploys?.[0]?.close_reason === scenario.closeReason,
      poolCooldownReason: entry.cooldown_reason,
      tokenCooldownReason: entry.base_mint_cooldown_reason,
      poolCooldownUntil: entry.cooldown_until,
      tokenCooldownUntil: entry.base_mint_cooldown_until,
    };
  }

  proof = {
    success: true,
    scenario: "stop-loss-family cooldown classification",
    cooldownHours,
    ...results,
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
