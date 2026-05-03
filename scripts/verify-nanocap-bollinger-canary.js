#!/usr/bin/env node
/**
 * Focused synthetic proof for the nanocap RSI-5m entry surface.
 *
 * Read-only: no network calls, no bot runtime, no deploys/closes, no config writes.
 */

import assert from "assert";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { resolveConfigFromPath } from "../config-builder.js";
import { summarizeIndicatorConfirmation } from "../decision-context-log.js";
import { buildShadowQualityGatesFromSignals } from "../tools/chart-indicators.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const EXAMPLE_CONFIG_PATH = join(ROOT, "user-config.example.json");

function src(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function makeSignal({
  close,
  lowerBand,
  upperBand = null,
  rsi,
  supertrendDirection = "unknown",
  supertrendValue = null,
}) {
  return {
    close,
    lowerBand,
    upperBand,
    rsi,
    supertrendDirection,
    supertrendValue,
  };
}

assert.ok(existsSync(EXAMPLE_CONFIG_PATH), "user-config.example.json exists");

const example = JSON.parse(readFileSync(EXAMPLE_CONFIG_PATH, "utf8"));
const resolved = resolveConfigFromPath(EXAMPLE_CONFIG_PATH, {
  env: { ...process.env },
  applyEnv: false,
}).config;

assert.strictEqual(resolved.indicators.enabled, true, "chart indicators enabled");
assert.strictEqual(resolved.indicators.entryPreset, "rsi_reversal", "entry preset is RSI reversal");
assert.strictEqual(resolved.indicators.exitPreset, null, "exit preset remains disabled");
assert.deepStrictEqual(resolved.indicators.intervals, ["5_MINUTE"], "entry gate checks 5m only");
assert.strictEqual(resolved.indicators.requireAllIntervals, false, "single-interval entry gate does not require all intervals");
assert.strictEqual(resolved.indicators.rsiLength, 2, "live gate uses RSI2 payloads");
assert.strictEqual(resolved.indicators.rsiOversold, 30, "live gate uses RSI2<=30");

assert.strictEqual(example.deployAmountSol, 1.5, "sizing unchanged: deployAmountSol");
assert.strictEqual(example.maxPositions, 2, "capital throttle: maxPositions");
assert.strictEqual(example.maxDeployAmount, 1.55, "sizing unchanged: maxDeployAmount");
assert.strictEqual(example.stopLossPct, -8, "stop loss unchanged");
assert.strictEqual(example.hardStopLossPct, -15, "hard stop unchanged");
assert.strictEqual(example.takeProfitPct, 25, "take profit unchanged");

const configuredModel = example.llmModel;
assert.ok(/^deepseek-/i.test(configuredModel), "base LLM model is DeepSeek");
assert.strictEqual(example.screeningModel, configuredModel, "screening model follows configured base model");
assert.strictEqual(example.managementModel, configuredModel, "management model follows configured base model");
assert.strictEqual(example.generalModel, configuredModel, "general model follows configured base model");
assert.strictEqual(resolved.llm.screeningModel, configuredModel, "resolved screening model follows config");
assert.strictEqual(resolved.llm.managementModel, configuredModel, "resolved management model follows config");
assert.strictEqual(resolved.llm.generalModel, configuredModel, "resolved general model follows config");

const passingShadow = buildShadowQualityGatesFromSignals({
  rsi2SignalsByInterval: {
    "5_MINUTE": makeSignal({
      close: 0.90,
      lowerBand: 0.91,
      rsi: 24,
    }),
    "15_MINUTE": makeSignal({
      close: 0.89,
      lowerBand: 0.90,
      rsi: 25,
      supertrendDirection: "bullish",
      supertrendValue: 0.84,
    }),
  },
  rsi14Signal15m: makeSignal({
    close: 0.89,
    lowerBand: 0.90,
    rsi: 49,
    supertrendDirection: "bullish",
    supertrendValue: 0.84,
  }),
});

assert.strictEqual(passingShadow.checks.bollinger_5m_lower_band.pass, true, "5m Bollinger lower-band pass is logged");
assert.strictEqual(passingShadow.checks.bollinger_15m_lower_band.pass, true, "15m Bollinger lower-band pass is logged");
assert.strictEqual(passingShadow.checks.rsi2_5m_lte_25.pass, true, "5m RSI2<=25 pass is logged");
assert.strictEqual(passingShadow.checks.rsi2_15m_lte_25.pass, true, "15m RSI2<=25 pass is logged");
assert.strictEqual(passingShadow.checks.rsi14_15m_lte_50.pass, true, "15m RSI14<=50 pass is logged");
assert.strictEqual(passingShadow.checks.supertrend_15m_bullish.pass, true, "15m Supertrend bullish pass is logged");
assert.strictEqual(passingShadow.strict_quality_gate.pass, true, "strict shadow gate passes only when all quality checks pass");

const failingShadow = buildShadowQualityGatesFromSignals({
  rsi2SignalsByInterval: {
    "5_MINUTE": makeSignal({
      close: 0.92,
      lowerBand: 0.91,
      rsi: 31,
    }),
    "15_MINUTE": makeSignal({
      close: 0.91,
      lowerBand: 0.90,
      rsi: 28,
      supertrendDirection: "bearish",
      supertrendValue: 0.93,
    }),
  },
  rsi14Signal15m: makeSignal({
    close: 0.91,
    lowerBand: 0.90,
    rsi: 55,
    supertrendDirection: "bearish",
    supertrendValue: 0.93,
  }),
});

assert.strictEqual(failingShadow.strict_quality_gate.pass, false, "strict shadow gate can fail without affecting canary config");

const summarized = summarizeIndicatorConfirmation({
  enabled: true,
  skipped: false,
  confirmed: true,
  preset: "bollinger_reversion",
  side: "entry",
  requireAllIntervals: false,
  reason: "bollinger_reversion confirmed on 5_MINUTE",
  intervals: [],
  shadow_quality_gates: passingShadow,
});

assert.strictEqual(
  summarized.shadow_quality_gates.strict_quality_gate.pass,
  true,
  "decision-context summary carries shadow quality gate",
);

const runtimeSources = [
  ["index.js", src("index.js")],
  ["agent.js", src("agent.js")],
  ["logger.js", src("logger.js")],
  ["tools/screening.js", src("tools/screening.js")],
  ["tools/chart-indicators.js", src("tools/chart-indicators.js")],
  ["tools/dlmm.js", src("tools/dlmm.js")],
  ["tools/executor.js", src("tools/executor.js")],
  ["decision-context-log.js", src("decision-context-log.js")],
];

const sourceProof = {
  boundedExtraRsi14: src("tools/chart-indicators.js").includes("rsiLength: 14"),
  indicatorAcceptLogged: src("tools/screening.js").includes("getIndicatorDecisionStage") &&
    src("tools/screening.js").includes('"indicator_accept"'),
  shadowQualityGatesSummarized: src("decision-context-log.js").includes("shadow_quality_gates"),
  noBirdeyeInLiveRuntime: runtimeSources.every(([, text]) => !/birdeye/i.test(text)),
};

assert.ok(sourceProof.boundedExtraRsi14, "shadow gate uses bounded extra 15m RSI14 request");
assert.ok(sourceProof.indicatorAcceptLogged, "accepted chart decisions are logged");
assert.ok(sourceProof.shadowQualityGatesSummarized, "decision context summary includes shadow gates");
assert.ok(sourceProof.noBirdeyeInLiveRuntime, "live runtime has no Birdeye dependency");

console.log(JSON.stringify({
  success: true,
  exampleConfig: {
    entryPreset: resolved.indicators.entryPreset,
    exitPreset: resolved.indicators.exitPreset,
    intervals: resolved.indicators.intervals,
    requireAllIntervals: resolved.indicators.requireAllIntervals,
    rsiLength: resolved.indicators.rsiLength,
  },
  unchangedSurfaces: {
    deployAmountSol: example.deployAmountSol,
    maxPositions: example.maxPositions,
    maxDeployAmount: example.maxDeployAmount,
    stopLossPct: example.stopLossPct,
    hardStopLossPct: example.hardStopLossPct,
    takeProfitPct: example.takeProfitPct,
    screeningModel: example.screeningModel,
    managementModel: example.managementModel,
    generalModel: example.generalModel,
  },
  shadowGate: {
    bollinger5m: passingShadow.checks.bollinger_5m_lower_band.pass,
    bollinger15m: passingShadow.checks.bollinger_15m_lower_band.pass,
    dualRsi2: passingShadow.checks.rsi2_5m_lte_25.pass && passingShadow.checks.rsi2_15m_lte_25.pass,
    rsi14_15m: passingShadow.checks.rsi14_15m_lte_50.pass,
    supertrend15mBullish: passingShadow.checks.supertrend_15m_bullish.pass,
    strictPass: passingShadow.strict_quality_gate.pass,
    strictFailFixture: failingShadow.strict_quality_gate.pass,
  },
  decisionContext: {
    shadowQualityGatesSummarized: summarized.shadow_quality_gates.strict_quality_gate.pass === true,
  },
  sourceSafety: sourceProof,
}, null, 2));
