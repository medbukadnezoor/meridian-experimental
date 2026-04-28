#!/usr/bin/env node
/**
 * Synthetic proof for the nanocap Supertrend loss exit gate.
 *
 * Runs in a temporary directory so state.js writes only temporary state.json/logs.
 * Does not import index.js, run the bot, or call live indicator/trading APIs.
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
  if (!condition) {
    throw new Error(message);
  }
}

function baseConfig(overrides = {}) {
  return {
    supertrendLossExitEnabled: true,
    supertrendLossExitPnlPct: -4,
    supertrendLossExitInterval: "15_MINUTE",
    supertrendLossExitConfirmChecks: 2,
    ...overrides,
  };
}

function makePosition(position, overrides = {}) {
  return {
    position,
    pair: `TEST-${position}`,
    base_mint: `mint-${position}`,
    pnl_pct: -4.3,
    pnl_pct_suspicious: false,
    ...overrides,
  };
}

function makePayload(direction) {
  return {
    latest: {
      candle: { close: 1 },
      supertrend: { direction, value: 0.9 },
      states: {},
    },
  };
}

function buildSyntheticSummary(payload) {
  return {
    close: Number(payload?.latest?.candle?.close),
    supertrendValue: Number(payload?.latest?.supertrend?.value),
    supertrendDirection: String(payload?.latest?.supertrend?.direction || "unknown"),
  };
}

function readState(tempDir) {
  return JSON.parse(fs.readFileSync(path.join(tempDir, "state.json"), "utf8"));
}

async function main() {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-supertrend-loss-proof-"));

  try {
    process.chdir(tempDir);

    const nonce = Date.now();
    const stateModule = await import(`${pathToFileURL(join(ROOT, "state.js")).href}?proof=${nonce}`);
    const exitModule = await import(`${pathToFileURL(join(ROOT, "supertrend-loss-exit.js")).href}?proof=${nonce}`);
    const { trackPosition } = stateModule;
    const { evaluateSupertrendLossExit } = exitModule;

    function track(position) {
      trackPosition({
        position,
        pool: `pool-${position}`,
        pool_name: `TEST-${position}`,
        strategy: "bid_ask",
      });
    }

    let liveFetchCalls = 0;
    const fetchBearish = async (_mint, options) => {
      liveFetchCalls += 1;
      assert(options?.interval === "15_MINUTE", "gate should request configured 15m Supertrend interval");
      return makePayload("bearish");
    };
    const fetchBullish = async () => {
      liveFetchCalls += 1;
      return makePayload("bullish");
    };
    const fetchUnknown = async () => {
      liveFetchCalls += 1;
      return makePayload("unknown");
    };
    const fetchUnavailable = async () => {
      liveFetchCalls += 1;
      throw new Error("synthetic unavailable");
    };
    const fetchShouldNotRun = async () => {
      throw new Error("fetch should not be called");
    };

    track("two-check");
    const first = await evaluateSupertrendLossExit(makePosition("two-check"), baseConfig(), {
      fetchIndicators: fetchBearish,
      buildSummary: buildSyntheticSummary,
    });
    assert(first?.pending === true, "first bearish check should not close");
    assert(first?.count === 1 && first?.confirmChecks === 2, "first bearish check should record 1/2");
    assert(readState(tempDir).positions["two-check"].supertrend_loss_exit_checks === 1, "state should persist 1/2 count");

    const second = await evaluateSupertrendLossExit(makePosition("two-check"), baseConfig(), {
      fetchIndicators: fetchBearish,
      buildSummary: buildSyntheticSummary,
    });
    assert(second?.action === "CLOSE", "second consecutive bearish check should close");
    assert(second?.indicatorPolicy === "bypass", "gate should bypass optional exit indicator confirmation");
    assert(second?.urgent === false, "gate should use normal deterministic close routing, not urgent stop-loss routing");
    assert(String(second?.reason || "").includes("15m Supertrend bearish for 2 checks"), "close reason should be deterministic and owner-readable");

    track("bullish-reset");
    await evaluateSupertrendLossExit(makePosition("bullish-reset"), baseConfig(), { fetchIndicators: fetchBearish, buildSummary: buildSyntheticSummary });
    const bullish = await evaluateSupertrendLossExit(makePosition("bullish-reset"), baseConfig(), { fetchIndicators: fetchBullish, buildSummary: buildSyntheticSummary });
    assert(bullish === null, "bullish Supertrend should not close");
    assert(readState(tempDir).positions["bullish-reset"].supertrend_loss_exit_checks == null, "bullish Supertrend should reset counter");

    track("unknown-reset");
    await evaluateSupertrendLossExit(makePosition("unknown-reset"), baseConfig(), { fetchIndicators: fetchBearish, buildSummary: buildSyntheticSummary });
    const unknown = await evaluateSupertrendLossExit(makePosition("unknown-reset"), baseConfig(), { fetchIndicators: fetchUnknown, buildSummary: buildSyntheticSummary });
    assert(unknown === null, "unknown Supertrend should not close");
    assert(readState(tempDir).positions["unknown-reset"].supertrend_loss_exit_checks == null, "unknown Supertrend should reset counter");

    track("unavailable-reset");
    await evaluateSupertrendLossExit(makePosition("unavailable-reset"), baseConfig(), { fetchIndicators: fetchBearish, buildSummary: buildSyntheticSummary });
    const unavailable = await evaluateSupertrendLossExit(makePosition("unavailable-reset"), baseConfig(), { fetchIndicators: fetchUnavailable, buildSummary: buildSyntheticSummary });
    assert(unavailable === null, "unavailable indicator data should not close");
    assert(readState(tempDir).positions["unavailable-reset"].supertrend_loss_exit_checks == null, "unavailable indicator data should reset counter");

    track("recovered-reset");
    await evaluateSupertrendLossExit(makePosition("recovered-reset"), baseConfig(), { fetchIndicators: fetchBearish, buildSummary: buildSyntheticSummary });
    const recovered = await evaluateSupertrendLossExit(
      makePosition("recovered-reset", { pnl_pct: -3.9 }),
      baseConfig(),
      { fetchIndicators: fetchShouldNotRun, buildSummary: buildSyntheticSummary },
    );
    assert(recovered === null, "PnL above threshold should not close");
    assert(readState(tempDir).positions["recovered-reset"].supertrend_loss_exit_checks == null, "PnL above threshold should reset counter");

    track("suspicious");
    const suspicious = await evaluateSupertrendLossExit(
      makePosition("suspicious", { pnl_pct_suspicious: true }),
      baseConfig(),
      { fetchIndicators: fetchShouldNotRun, buildSummary: buildSyntheticSummary },
    );
    assert(suspicious === null, "suspicious PnL should not trigger");

    track("disabled");
    const disabled = await evaluateSupertrendLossExit(
      makePosition("disabled"),
      baseConfig({ supertrendLossExitEnabled: false }),
      { fetchIndicators: fetchShouldNotRun, buildSummary: buildSyntheticSummary },
    );
    assert(disabled === null, "disabled config should not trigger");

    const proof = {
      success: true,
      cases: {
        firstBearishPending: {
          action: first.action,
          pending: first.pending,
          count: first.count,
          confirmChecks: first.confirmChecks,
        },
        secondBearishClose: {
          action: second.action,
          reason: second.reason,
          indicatorPolicy: second.indicatorPolicy,
          urgent: second.urgent,
        },
        bullishReset: bullish === null,
        unknownReset: unknown === null,
        unavailableReset: unavailable === null,
        recoveredReset: recovered === null,
        suspiciousNoTrigger: suspicious === null,
        disabledNoTrigger: disabled === null,
      },
      sourceSafety: {
        liveApiCalls: 0,
        syntheticFetchCalls: liveFetchCalls,
        importedIndexJs: false,
        importedChartIndicators: false,
      },
    };

    console.log(JSON.stringify(proof, null, 2));
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
