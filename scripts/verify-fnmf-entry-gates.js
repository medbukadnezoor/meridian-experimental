#!/usr/bin/env node
/**
 * Compact synthetic proof for Scout-only FNMF entry/config gates.
 *
 * This verifier does not run bot runtime, discovery, wallet code, or network
 * clients. It imports pure helpers and uses synthetic candidate/chart payloads.
 */

import assert from "assert";
import { buildConfig } from "../config-builder.js";
import { config } from "../config.js";
import { evaluatePreset } from "../tools/chart-indicators.js";
import {
  evaluatePreEntryMomentumGates,
  getPreEntryMomentumGateVetoReason,
} from "../tools/screening.js";

function withIndicatorConfig(overrides, fn) {
  const previous = { ...config.indicators };
  Object.assign(config.indicators, overrides);
  try {
    return fn();
  } finally {
    Object.keys(config.indicators).forEach((key) => delete config.indicators[key]);
    Object.assign(config.indicators, previous);
  }
}

function chartPayloadWithRsi(rsi) {
  return {
    latest: {
      candle: { close: 1 },
      rsi: { value: rsi },
      bollinger: {},
      supertrend: { direction: "bullish", value: 0.9 },
      states: {},
    },
  };
}

const defaultConfig = buildConfig({}, {});
assert.strictEqual(defaultConfig.indicators.enabled, false, "chart indicators remain disabled by default");
assert.strictEqual(defaultConfig.indicators.entryPreset, "supertrend_break", "default entry preset is unchanged");
assert.strictEqual(defaultConfig.indicators.rsiOversold, 30, "default reversal oversold threshold is unchanged");
assert.strictEqual(defaultConfig.indicators.rsiOverbought, 80, "default reversal overbought threshold is unchanged");
assert.deepStrictEqual(
  defaultConfig.screening.preEntryMomentumGates,
  {
    enabled: false,
    minReturnPct: null,
    maxReturnPct: null,
    minVolumeRatio: null,
    maxVolumeRatio: null,
    missingDataPolicy: "skip",
  },
  "pre-entry momentum gates default off",
);

withIndicatorConfig({
  rsiOversold: 30,
  rsiOverbought: 80,
  rsiMomentumMin: 70,
  rsiMomentumMax: 45,
}, () => {
  const reversalHighRsi = evaluatePreset("entry", "rsi_reversal", chartPayloadWithRsi(82));
  assert.strictEqual(reversalHighRsi.confirmed, false, "reversal entry rejects high RSI");
  assert.ok(reversalHighRsi.reason.includes("<= oversold 30"), "reversal reason keeps oversold threshold");

  const momentumHighRsi = evaluatePreset("entry", "rsi_momentum", chartPayloadWithRsi(82));
  assert.strictEqual(momentumHighRsi.confirmed, true, "momentum entry accepts high RSI");
  assert.ok(momentumHighRsi.reason.includes(">= momentum min 70"), "momentum reason uses configurable min");

  const momentumExitLowRsi = evaluatePreset("exit", "rsi_momentum", chartPayloadWithRsi(42));
  assert.strictEqual(momentumExitLowRsi.confirmed, true, "momentum exit accepts low RSI using configurable max");
});

const gateConfig = buildConfig({
  screening: {
    preEntryMomentumGates: {
      enabled: true,
      minReturnPct: 5,
      maxReturnPct: 60,
      minVolumeRatio: 1.2,
      maxVolumeRatio: 4,
      missingDataPolicy: "reject",
    },
  },
}, {}).screening;

const passingCandidate = {
  name: "MOM-SOL",
  pool: "mom-pool",
  price_change_pct: 12,
  volume_change_pct: 80,
};
const passingDecision = evaluatePreEntryMomentumGates(passingCandidate, gateConfig);
assert.strictEqual(passingDecision.accepted, true, "candidate with return and volume momentum passes");
assert.strictEqual(passingDecision.snapshot.pre_entry_return_source, "price_change_pct", "return uses available candidate price_change_pct");
assert.strictEqual(passingDecision.snapshot.volume_ratio_source, "volume_change_pct->ratio", "volume ratio can derive from available volume_change_pct");

assert.ok(
  getPreEntryMomentumGateVetoReason({ ...passingCandidate, price_change_pct: 2 }, gateConfig)?.includes("return 2 < min 5"),
  "low pre-entry return is rejected",
);
assert.ok(
  getPreEntryMomentumGateVetoReason({ ...passingCandidate, volume_change_pct: 5 }, gateConfig)?.includes("volume_ratio 1.05 < min 1.2"),
  "low volume ratio is rejected",
);

const missingReject = evaluatePreEntryMomentumGates({ name: "MISS-SOL" }, gateConfig);
assert.strictEqual(missingReject.accepted, false, "missing-data reject policy rejects missing fields");
assert.strictEqual(missingReject.missingDataPolicy, "reject", "reject policy is surfaced");

const missingSkip = evaluatePreEntryMomentumGates(
  { name: "MISS-SOL" },
  {
    preEntryMomentumGates: {
      ...gateConfig.preEntryMomentumGates,
      missingDataPolicy: "skip",
    },
  },
);
assert.strictEqual(missingSkip.accepted, true, "missing-data skip policy accepts");
assert.strictEqual(missingSkip.skipped, true, "skip policy marks decision skipped");

const missingWarn = evaluatePreEntryMomentumGates(
  { name: "MISS-SOL" },
  {
    preEntryMomentumGates: {
      ...gateConfig.preEntryMomentumGates,
      missingDataPolicy: "warn",
    },
  },
);
assert.strictEqual(missingWarn.accepted, true, "missing-data warn policy accepts");
assert.strictEqual(missingWarn.warning, true, "warn policy marks decision warning");

const disabledDecision = evaluatePreEntryMomentumGates(
  { name: "ANY-SOL" },
  defaultConfig.screening,
);
assert.strictEqual(disabledDecision.enabled, false, "default screening gate stays disabled");
assert.strictEqual(disabledDecision.accepted, true, "disabled gate remains backward-compatible");

console.log(JSON.stringify({
  success: true,
  indicatorProof: {
    reversalHighRsiRejects: true,
    momentumHighRsiAccepts: true,
    momentumThresholdsConfigurable: true,
  },
  preEntryMomentumProof: {
    defaultEnabled: defaultConfig.screening.preEntryMomentumGates.enabled,
    missingReject: !missingReject.accepted,
    missingSkip: missingSkip.accepted && missingSkip.skipped,
    missingWarn: missingWarn.accepted && missingWarn.warning,
    usesCandidateFieldsOnly: [
      passingDecision.snapshot.pre_entry_return_source,
      passingDecision.snapshot.volume_ratio_source,
    ],
  },
}, null, 2));
