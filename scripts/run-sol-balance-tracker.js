#!/usr/bin/env node
import {
  appendSolBalanceSnapshot,
  collectSolEquitySnapshot,
  resolveTrackerConfig,
} from "../sol-equity-tracker.js";
import {
  appendSolPnlVerification,
  buildSolPnlVerification,
  loadVerificationInputs,
} from "../sol-pnl-verifier.js";
import { maybeWriteBalanceReport } from "./report-sol-balance-tracker.js";
import { maybeWriteVerificationReport } from "./report-sol-pnl-verification.js";
import { ensureBaselineInitialized } from "./sol-balance-baseline.js";

function usage() {
  console.error([
    "Usage: node scripts/run-sol-balance-tracker.js [options]",
    "",
    "Options:",
    "  --bot <name>                 Bot name for rows",
    "  --interval-ms <n>            Snapshot interval; default config or 30000",
    "  --residual-ms <n>            Residual token sample interval; default 300000",
    "  --verification-window-ms <n> Verification window; default 1800000",
    "  --log-dir <dir>              Log directory; default logs",
    "  --once                       Run one tick and exit",
  ].join("\n"));
}

function numberArg(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`Invalid ${label}: ${value}`);
  return number;
}

export function parseArgs(argv) {
  const options = { once: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--once") {
      options.once = true;
      continue;
    }
    if (arg === "--bot" || arg === "--log-dir") {
      const next = argv[i + 1];
      if (!next) throw new Error(`Missing value for ${arg}`);
      if (arg === "--bot") options.botName = next;
      if (arg === "--log-dir") options.logDir = next;
      i += 1;
      continue;
    }
    if (arg === "--interval-ms" || arg === "--residual-ms" || arg === "--verification-window-ms") {
      const next = argv[i + 1];
      if (!next) throw new Error(`Missing value for ${arg}`);
      if (arg === "--interval-ms") options.intervalMs = numberArg(next, arg);
      if (arg === "--residual-ms") options.residualTokenSampleEveryMs = numberArg(next, arg);
      if (arg === "--verification-window-ms") options.verificationWindowMs = numberArg(next, arg);
      i += 1;
      continue;
    }
    usage();
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export async function runTrackerTick({ trackerConfig, residualState }) {
  const snapshot = await collectSolEquitySnapshot({
    bot: trackerConfig.botName,
    logDir: trackerConfig.logDir,
    residualState,
    trackerConfig,
  });
  ensureBaselineInitialized({
    logDir: trackerConfig.logDir,
    snapshot,
    reason: "auto sidecar start baseline",
  });
  const snapshotWithBaseline = snapshot.baselineEquitySol == null
    ? { ...snapshot, baselineEquitySol: snapshot.estimatedEquitySol, externalFlowSol: 0, ownerAdjustedPnlSol: 0, ownerAdjustedPnlPct: 0, dataQuality: { ...snapshot.dataQuality, warnings: snapshot.dataQuality.warnings.filter((warning) => warning !== "baseline_missing") } }
    : snapshot;
  appendSolBalanceSnapshot(snapshotWithBaseline, { logDir: trackerConfig.logDir });

  const inputs = loadVerificationInputs({
    logDir: trackerConfig.logDir,
    windowMs: trackerConfig.verificationWindowMs,
    end: new Date(snapshotWithBaseline.ts),
  });
  const verification = buildSolPnlVerification({
    ...inputs,
    bot: trackerConfig.botName,
    wallet: snapshotWithBaseline.wallet,
    dustSol: trackerConfig.dustSol,
    fabriqToleranceSol: trackerConfig.fabriqToleranceSol,
  });
  appendSolPnlVerification(verification, { logDir: trackerConfig.logDir });
  maybeWriteBalanceReport({ logDir: trackerConfig.logDir });
  maybeWriteVerificationReport({ logDir: trackerConfig.logDir });
  return { snapshot: snapshotWithBaseline, verification };
}

async function main() {
  const overrides = parseArgs(process.argv.slice(2));
  const trackerConfig = resolveTrackerConfig(overrides);
  const residualState = { lastSample: null, lastSampleAtMs: null };
  let running = false;
  let stopped = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const result = await runTrackerTick({ trackerConfig, residualState });
      console.log(JSON.stringify({
        ok: true,
        ts: result.snapshot.ts,
        bot: result.snapshot.bot,
        wallet: result.snapshot.wallet,
        estimatedEquitySol: result.snapshot.estimatedEquitySol,
        verdict: result.verification.verdict,
      }));
    } catch (error) {
      console.error(`[sol-balance-tracker] ${error.stack || error.message}`);
    } finally {
      running = false;
      if (overrides.once) stopped = true;
    }
  }

  process.on("SIGINT", () => { stopped = true; });
  process.on("SIGTERM", () => { stopped = true; });

  await tick();
  if (overrides.once) process.exit(0);
  while (!stopped) {
    await new Promise((resolve) => setTimeout(resolve, trackerConfig.intervalMs));
    await tick();
  }
}

if (process.argv.some((arg) => String(arg).endsWith("run-sol-balance-tracker.js"))) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
