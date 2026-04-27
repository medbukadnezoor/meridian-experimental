#!/usr/bin/env node
/**
 * Runtime proof for controlled repeat low-yield cooldown behavior.
 *
 * Uses a temporary working directory so the real pool-memory.json and logs are
 * not modified.
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
const tempDir = mkdtempSync(join(tmpdir(), "meridian-repeat-low-yield-cooldown-"));
const poolMemoryPath = join(tempDir, "pool-memory.json");

function lowYieldDeploy(i, baseMint) {
  return {
    pool_name: "repeat-low-yield proof",
    base_mint: baseMint,
    deployed_at: new Date(Date.now() - (90 - i) * 60 * 1000).toISOString(),
    closed_at: new Date(Date.now() - (3 - i) * 60 * 1000).toISOString(),
    pnl_pct: 0.25,
    pnl_usd: 0.01,
    fees_earned_usd: 0,
    fees_earned_sol: 0,
    fee_earned_pct: 0,
    range_efficiency: 0,
    minutes_held: 60,
    close_reason: "Trailing TP: Low yield: fee/TVL 3.00% < min 7% (age: 60m)",
    strategy: "sol_dca_accumulator",
  };
}

function readEntry(poolAddress) {
  const db = JSON.parse(readFileSync(poolMemoryPath, "utf8"));
  const entry = db[poolAddress];
  if (!entry) throw new Error(`Pool ${poolAddress} was not recorded`);
  return entry;
}

let proof;
let failure;

try {
  process.chdir(tempDir);

  const [{ recordPoolDeploy }, { config }] = await Promise.all([
    import(pathToFileURL(join(ROOT, "pool-memory.js")).href),
    import(pathToFileURL(join(ROOT, "config.js")).href),
  ]);

  const disabledPool = "LowYieldDisabledPool1111111111111111111111";
  const disabledMint = "LowYieldDisabledMint1111111111111111111111";

  config.management.repeatLowYieldCooldownEnabled = false;
  recordPoolDeploy(disabledPool, lowYieldDeploy(1, disabledMint));
  const disabledEntry = readEntry(disabledPool);

  if (disabledEntry.cooldown_reason !== "low yield") {
    throw new Error(`Disabled mode should preserve immediate pool cooldown, got ${disabledEntry.cooldown_reason}`);
  }
  if (disabledEntry.base_mint_cooldown_reason) {
    throw new Error(`Disabled mode should not set token cooldown, got ${disabledEntry.base_mint_cooldown_reason}`);
  }

  const enabledPool = "LowYieldEnabledPool11111111111111111111111";
  const enabledMint = "LowYieldEnabledMint11111111111111111111111";

  config.management.repeatLowYieldCooldownEnabled = true;
  config.management.repeatLowYieldCooldownTriggerCount = 3;
  config.management.repeatLowYieldCooldownLookbackHours = 48;
  config.management.repeatLowYieldCooldownHours = 12;
  config.management.repeatLowYieldCooldownScope = "token";

  const before = Date.now();
  recordPoolDeploy(enabledPool, lowYieldDeploy(1, enabledMint));
  const afterFirst = readEntry(enabledPool);
  if (afterFirst.cooldown_reason || afterFirst.base_mint_cooldown_reason) {
    throw new Error("Enabled mode should wait after first low-yield close");
  }

  recordPoolDeploy(enabledPool, lowYieldDeploy(2, enabledMint));
  const afterSecond = readEntry(enabledPool);
  if (afterSecond.cooldown_reason || afterSecond.base_mint_cooldown_reason) {
    throw new Error("Enabled mode should wait after second low-yield close");
  }

  recordPoolDeploy(enabledPool, lowYieldDeploy(3, enabledMint));
  const afterThird = readEntry(enabledPool);
  const after = Date.now();
  const tokenCooldownUntilMs = Date.parse(afterThird.base_mint_cooldown_until || "");
  const expectedMs = 12 * 60 * 60 * 1000;

  if (afterThird.cooldown_reason) {
    throw new Error(`Token-scoped repeat low-yield cooldown should not set pool cooldown, got ${afterThird.cooldown_reason}`);
  }
  if (afterThird.base_mint_cooldown_reason !== "repeat low-yield closes (3x/48h)") {
    throw new Error(`Expected repeat low-yield token cooldown, got ${afterThird.base_mint_cooldown_reason}`);
  }
  if (!Number.isFinite(tokenCooldownUntilMs) || tokenCooldownUntilMs < before + expectedMs - 2000 || tokenCooldownUntilMs > after + expectedMs + 2000) {
    throw new Error("Token cooldown timestamp outside expected 12h window");
  }

  proof = {
    success: true,
    disabled: {
      immediatePoolCooldown: disabledEntry.cooldown_reason === "low yield",
      tokenCooldownReason: disabledEntry.base_mint_cooldown_reason || null,
    },
    enabled: {
      firstCloseCooldown: afterFirst.cooldown_reason || afterFirst.base_mint_cooldown_reason || null,
      secondCloseCooldown: afterSecond.cooldown_reason || afterSecond.base_mint_cooldown_reason || null,
      thirdClosePoolCooldownReason: afterThird.cooldown_reason || null,
      thirdCloseTokenCooldownReason: afterThird.base_mint_cooldown_reason,
      thirdCloseTokenCooldownUntil: afterThird.base_mint_cooldown_until,
      deployCount: afterThird.deploys.length,
    },
    tempStateFileCreated: existsSync(poolMemoryPath),
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
