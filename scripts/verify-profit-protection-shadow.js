#!/usr/bin/env node
/**
 * Synthetic proof for nanocap profit-protection shadow logging.
 *
 * Runs in a temporary directory so state.json/logs are isolated.
 * Does not import index.js, run the bot, or call trading APIs.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { dirname, join } from "path";
import { pathToFileURL, fileURLToPath } from "url";

process.env.LOG_LEVEL = "error";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function baseConfig(overrides = {}) {
  return {
    trailingTakeProfit: false,
    trailingTriggerPct: 6,
    trailingDropPct: 3,
    earlyDumpPct: null,
    stopLossPct: -8,
    stopLossConfirmDelayMs: 0,
    hardStopLossPct: -15,
    stopLossFastClosePct: null,
    stopLossVelocityWindowMs: null,
    stopLossVelocityClosePct: null,
    profitGivebackEmergencyEnabled: false,
    rollingDrawdownExitEnabled: false,
    outOfRangeWaitMinutes: 60,
    outOfRangeHardCloseMinutes: 120,
    minFeePerTvl24h: null,
    profitProtectionShadowLoggingEnabled: true,
    profitProtectionShadowBotName: "nanocap",
    profitProtectionShadowPrimaryPeakPct: 5,
    profitProtectionShadowPrimaryDropPct: 3,
    profitProtectionShadowSecondaryPeakPct: 2,
    profitProtectionShadowSecondaryCurrentPnlPct: 0,
    profitProtectionShadowHardTakeProfitPcts: [6, 7],
    profitProtectionShadowTrailingVariants: [
      { triggerPct: 6, dropPct: 2 },
      { triggerPct: 6, dropPct: 1.5 },
    ],
    ...overrides,
  };
}

function makePosition(position, overrides = {}) {
  return {
    position,
    pool: `pool-${position}`,
    pair: `TEST-${position}`,
    pool_name: `TEST-${position}`,
    base_mint: `base-${position}`,
    pnl_pct_suspicious: false,
    in_range: true,
    fee_per_tvl_24h: 10,
    age_minutes: 42,
    ...overrides,
  };
}

function setPeakPnl(tempDir, position, peakPnlPct) {
  const statePath = path.join(tempDir, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert(state.positions?.[position], `missing tracked position ${position}`);
  state.positions[position].peak_pnl_pct = peakPnlPct;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function readJsonl(file) {
  return fs.readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function getLoggedRules(tempDir, position) {
  const statePath = path.join(tempDir, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  return state.positions?.[position]?.profit_protection_shadow_logged ?? {};
}

async function main() {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-profit-protection-shadow-"));
  let tempStateFileCreated = false;
  let tempDirRemoved = false;

  try {
    process.chdir(tempDir);

    const nonce = Date.now();
    const stateModule = await import(`${pathToFileURL(join(ROOT, "state.js")).href}?proof=${nonce}`);
    const logModule = await import(`${pathToFileURL(join(ROOT, "profit-protection-shadow-log.js")).href}?proof=${nonce}`);
    const {
      trackPosition,
      updatePnlAndCheckExits,
      getProfitProtectionShadowTriggers,
      markProfitProtectionShadowTriggersLogged,
    } = stateModule;
    const { appendProfitProtectionShadowRows } = logModule;

    function track(position) {
      trackPosition({
        position,
        pool: `pool-${position}`,
        pool_name: `TEST-${position}`,
        strategy: "bid_ask",
      });
    }

    track("primary");
    setPeakPnl(tempDir, "primary", 5.6);
    const primaryPosition = makePosition("primary", { pnl_pct: 2.4 });
    const primaryExit = updatePnlAndCheckExits("primary", primaryPosition, baseConfig());
    const primaryRows = getProfitProtectionShadowTriggers("primary", primaryPosition, baseConfig());
    appendProfitProtectionShadowRows(primaryRows, { wallet: "wallet-proof" });
    const primaryMarked = markProfitProtectionShadowTriggersLogged("primary", primaryRows);
    const primaryRepeatRows = getProfitProtectionShadowTriggers("primary", primaryPosition, baseConfig());

    track("secondary");
    setPeakPnl(tempDir, "secondary", 2.2);
    const secondaryPosition = makePosition("secondary", { pnl_pct: -0.1 });
    const secondaryExit = updatePnlAndCheckExits("secondary", secondaryPosition, baseConfig());
    const secondaryRows = getProfitProtectionShadowTriggers("secondary", secondaryPosition, baseConfig());
    appendProfitProtectionShadowRows(secondaryRows, { wallet: "wallet-proof" });
    const secondaryMarked = markProfitProtectionShadowTriggersLogged("secondary", secondaryRows);
    const secondaryRepeatRows = getProfitProtectionShadowTriggers("secondary", secondaryPosition, baseConfig());

    track("hard-tp");
    setPeakPnl(tempDir, "hard-tp", 7.2);
    const hardTpPosition = makePosition("hard-tp", { pnl_pct: 7.2 });
    const hardTpRows = getProfitProtectionShadowTriggers("hard-tp", hardTpPosition, baseConfig());
    appendProfitProtectionShadowRows(hardTpRows, { wallet: "wallet-proof" });
    const hardTpMarked = markProfitProtectionShadowTriggersLogged("hard-tp", hardTpRows);
    const hardTpRepeatRows = getProfitProtectionShadowTriggers("hard-tp", hardTpPosition, baseConfig());

    track("tight-trailing");
    setPeakPnl(tempDir, "tight-trailing", 6.4);
    const tightTrailingPosition = makePosition("tight-trailing", { pnl_pct: 4.2 });
    const tightTrailingRows = getProfitProtectionShadowTriggers("tight-trailing", tightTrailingPosition, baseConfig());
    appendProfitProtectionShadowRows(tightTrailingRows, { wallet: "wallet-proof" });
    const tightTrailingMarked = markProfitProtectionShadowTriggersLogged("tight-trailing", tightTrailingRows);
    const tightTrailingRepeatRows = getProfitProtectionShadowTriggers("tight-trailing", tightTrailingPosition, baseConfig());

    track("disabled");
    setPeakPnl(tempDir, "disabled", 9);
    const disabledRows = getProfitProtectionShadowTriggers(
      "disabled",
      makePosition("disabled", { pnl_pct: -1 }),
      baseConfig({ profitProtectionShadowLoggingEnabled: false }),
    );

    track("stop-loss");
    setPeakPnl(tempDir, "stop-loss", 6);
    const stopLossExit = updatePnlAndCheckExits(
      "stop-loss",
      makePosition("stop-loss", { pnl_pct: -8.5 }),
      baseConfig({ stopLossConfirmDelayMs: 15000 }),
    );
    const stopLossShadowRows = getProfitProtectionShadowTriggers(
      "stop-loss",
      makePosition("stop-loss", { pnl_pct: -8.5 }),
      baseConfig({ stopLossConfirmDelayMs: 15000 }),
    );

    track("append-failure");
    setPeakPnl(tempDir, "append-failure", 5.4);
    const appendFailurePosition = makePosition("append-failure", { pnl_pct: 2.1 });
    const appendFailureRows = getProfitProtectionShadowTriggers("append-failure", appendFailurePosition, baseConfig());
    const blockedLogDir = path.join(tempDir, "blocked-log-dir");
    fs.writeFileSync(blockedLogDir, "not a directory");
    let appendFailureCaught = false;
    try {
      appendProfitProtectionShadowRows(appendFailureRows, { wallet: "wallet-proof", logDir: blockedLogDir });
      markProfitProtectionShadowTriggersLogged("append-failure", appendFailureRows);
    } catch {
      appendFailureCaught = true;
    }
    const retryRowsAfterAppendFailure = getProfitProtectionShadowTriggers("append-failure", appendFailurePosition, baseConfig());
    appendProfitProtectionShadowRows(retryRowsAfterAppendFailure, { wallet: "wallet-proof" });
    const retryMarked = markProfitProtectionShadowTriggersLogged("append-failure", retryRowsAfterAppendFailure);
    const rowsAfterSuccessfulRetry = getProfitProtectionShadowTriggers("append-failure", appendFailurePosition, baseConfig());

    tempStateFileCreated = fs.existsSync(path.join(tempDir, "state.json"));
    const logFiles = fs.readdirSync(path.join(tempDir, "logs")).filter((file) => file.startsWith("profit-protection-shadow-"));
    assert(logFiles.length === 1, "expected one profit-protection shadow log file");
    const rows = readJsonl(path.join(tempDir, "logs", logFiles[0]));

    assert(primaryExit === null, "primary shadow rule must not select an exit action");
    assert(secondaryExit === null, "secondary shadow rule must not select an exit action");
    assert(primaryRows.length === 1, "primary rule should log once");
    assert(primaryMarked === true, "primary rule should mark only after append succeeds");
    assert(primaryRows[0].ruleId === "primary_peak_5_drop_3", "primary rule id mismatch");
    assert(Number(primaryRows[0].peakPnlPct) === 5.6, "primary peak should be recorded");
    assert(Number(primaryRows[0].currentPnlPct) === 2.4, "primary current PnL should be recorded");
    assert(Number(primaryRows[0].dropFromPeakPct.toFixed(1)) === 3.2, "primary drop should be recorded");
    assert(primaryRepeatRows.length === 0, "primary rule should dedupe after first trigger");
    assert(Boolean(getLoggedRules(tempDir, "primary").primary_peak_5_drop_3), "primary logged state should persist after successful append");
    assert(secondaryRows.length === 1, "secondary rule should log once");
    assert(secondaryMarked === true, "secondary rule should mark only after append succeeds");
    assert(secondaryRows[0].ruleId === "secondary_peak_2_current_lte_0", "secondary rule id mismatch");
    assert(secondaryRepeatRows.length === 0, "secondary rule should dedupe after first trigger");
    assert(hardTpRows.length === 2, "hard TP sample should log TP6 and TP7 once");
    assert(hardTpMarked === true, "hard TP rows should mark after append succeeds");
    assert(hardTpRows.map((row) => row.ruleId).join(",") === "hard_tp_6,hard_tp_7", "hard TP rule ids mismatch");
    assert(hardTpRows.every((row) => row.ruleType === "hard_take_profit"), "hard TP rows should carry hard_take_profit type");
    assert(hardTpRepeatRows.length === 0, "hard TP rules should dedupe after first trigger");
    assert(tightTrailingRows.length === 2, "tight trailing sample should log both trailing variants");
    assert(tightTrailingMarked === true, "tight trailing rows should mark after append succeeds");
    assert(tightTrailingRows.map((row) => row.ruleId).join(",") === "trailing_6_drop_2,trailing_6_drop_1_5", "tight trailing rule ids mismatch");
    assert(tightTrailingRows.every((row) => row.ruleType === "trailing_variant"), "tight trailing rows should carry trailing_variant type");
    assert(tightTrailingRepeatRows.length === 0, "tight trailing rules should dedupe after first trigger");
    assert(disabledRows.length === 0, "disabled shadow logging should not emit rows");
    assert(stopLossExit?.action === "STOP_LOSS_CANDIDATE", "shadow code must not change stop-loss candidate selection");
    assert(stopLossShadowRows.length === 4, "stop-loss sample should still record shadow evidence rules without changing exit");
    assert(appendFailureRows.length === 1, "append-failure setup should produce a shadow row");
    assert(appendFailureCaught === true, "append failure should be observable");
    assert(retryRowsAfterAppendFailure.length === 1, "failed append must not dedupe the event");
    assert(retryMarked === true, "retry should mark after successful append");
    assert(rowsAfterSuccessfulRetry.length === 0, "successful retry should dedupe subsequent polls");
    assert(Boolean(getLoggedRules(tempDir, "append-failure").primary_peak_5_drop_3), "retry logged state should persist after successful append");
    assert(rows.length === 7, "append-only log should contain primary, secondary, hard TP, tight trailing, and retry rows");
    assert(rows.every((row) => row.event === "profit_protection_shadow"), "log rows should use profit_protection_shadow event");
    assert(rows.every((row) => row.bot === "nanocap"), "log rows should identify nanocap bot");
    assert(rows.every((row) => row.wallet === "wallet-proof"), "log rows should include wallet");
    assert(rows.every((row) => row.shadowOnly === true), "log rows must be explicitly shadowOnly");
    assert(rows.every((row) => row.source === "updatePnlAndCheckExits"), "log rows should name the update path source");

    const proof = {
      success: true,
      primary: {
        exitAction: primaryExit?.action ?? null,
        firstRows: primaryRows.length,
        repeatRows: primaryRepeatRows.length,
        ruleId: primaryRows[0].ruleId,
      },
      secondary: {
        exitAction: secondaryExit?.action ?? null,
        firstRows: secondaryRows.length,
        repeatRows: secondaryRepeatRows.length,
        ruleId: secondaryRows[0].ruleId,
      },
      hardTakeProfit: {
        firstRows: hardTpRows.length,
        repeatRows: hardTpRepeatRows.length,
        ruleIds: hardTpRows.map((row) => row.ruleId),
        marked: hardTpMarked,
      },
      tightTrailing: {
        firstRows: tightTrailingRows.length,
        repeatRows: tightTrailingRepeatRows.length,
        ruleIds: tightTrailingRows.map((row) => row.ruleId),
        marked: tightTrailingMarked,
      },
      disabledRows: disabledRows.length,
      appendFailureRetry: {
        initialRows: appendFailureRows.length,
        failureCaught: appendFailureCaught,
        rowsAfterFailure: retryRowsAfterAppendFailure.length,
        rowsAfterRetry: rowsAfterSuccessfulRetry.length,
        retryMarked,
      },
      stopLossSelection: {
        action: stopLossExit.action,
        shadowRows: stopLossShadowRows.length,
      },
      logRows: rows.length,
      logFile: logFiles[0],
      tempStateFileCreated,
    };

    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDirRemoved = !fs.existsSync(tempDir);

    console.log(JSON.stringify({ ...proof, tempDirRemoved }, null, 2));
  } catch (error) {
    process.chdir(originalCwd);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDirRemoved = !fs.existsSync(tempDir);
    } catch {
      // ignore cleanup failure; report original error
    }
    console.error(JSON.stringify({
      success: false,
      error: error.message,
      tempStateFileCreated,
      tempDirRemoved,
    }, null, 2));
    process.exit(1);
  }
}

await main();
