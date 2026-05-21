#!/usr/bin/env node
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

import { buildCandidateDecisionContext } from "../decision-context-log.js";
import {
  filterConfiguredPoolThresholds,
  getConfiguredPoolThresholdVetoReason,
} from "../tools/screening.js";
import {
  appendTwoLaneClassification,
  attachTwoLaneClassification,
  classifyTwoLaneCandidate,
} from "../two-lane-classification-log.js";

function candidate(overrides = {}) {
  return {
    pool: "Pool111111111111111111111111111111111111111",
    name: "TEST-SOL",
    base: { mint: "Base111111111111111111111111111111111111111", symbol: "TEST", organic: 80 },
    quote: { symbol: "SOL", organic: 90 },
    fee_active_tvl_ratio: 10,
    fee_pct: 3,
    volatility: 5,
    bin_step: 100,
    active_tvl: 10_000,
    volume_window: 27_000,
    mcap: 200_000,
    holders: 500,
    organic_score: 80,
    quote_organic_score: 90,
    ...overrides,
  };
}

const baseConfig = {
  minFeeActiveTvlRatio: 0.19,
  minBinStep: 50,
  maxBinStep: 125,
  minTvl: 10_000,
  minVolume: 15_000,
  minVolumeActiveTvlMultiple: 2.5,
  minMcap: 80_000,
  maxMcap: 3_000_000,
  minHolders: 100,
  minOrganic: 45,
  minQuoteOrganic: 45,
  twoLaneClassificationLoggingEnabled: true,
  twoLanePrimaryVolumeActiveTvlMultiple: 3,
  looseVolumeActiveTvlMultiple: 2.5,
  looseLaneShadowOnly: true,
  looseLaneMinFeePct: 3,
  looseLaneMinFeeTvlRatio: 8,
  looseLaneMinBinStep: 100,
};

const primary = attachTwoLaneClassification(candidate({ name: "PRIMARY-SOL", volume_window: 35_000 }), baseConfig);
assert.equal(classifyTwoLaneCandidate(primary, baseConfig).lane, "primary");
assert.equal(getConfiguredPoolThresholdVetoReason(primary, baseConfig), null);

const looseQualified = attachTwoLaneClassification(candidate({ name: "LOOSE-QUAL-SOL", volume_window: 27_000 }), baseConfig);
assert.equal(looseQualified.two_lane_classification.lane, "loose");
assert.equal(looseQualified.two_lane_classification.looseLaneQualified, true);
assert.equal(
  getConfiguredPoolThresholdVetoReason(looseQualified, baseConfig),
  null,
  "shadow loose lane must not block candidates that pass the current live hard gate"
);

const looseSupplementalFail = attachTwoLaneClassification(
  candidate({
    name: "LOOSE-FAIL-SOL",
    volume_window: 27_000,
    fee_pct: 2,
    fee_active_tvl_ratio: 4,
    bin_step: 80,
  }),
  baseConfig,
);
assert.equal(looseSupplementalFail.two_lane_classification.lane, "loose");
assert.equal(looseSupplementalFail.two_lane_classification.looseLaneQualified, false);
assert.equal(
  getConfiguredPoolThresholdVetoReason(looseSupplementalFail, baseConfig),
  null,
  "supplemental loose-lane vetoes are shadow-only in T1"
);

const belowLoose = attachTwoLaneClassification(candidate({ name: "BELOW-SOL", volume_window: 24_000 }), baseConfig);
assert.equal(belowLoose.two_lane_classification.lane, "below_loose");
assert.match(
  getConfiguredPoolThresholdVetoReason(belowLoose, baseConfig),
  /volume_active_tvl_multiple .* < 2.5/,
  "existing hard gate still rejects below-live-floor candidates"
);

const futureHardGate = { ...baseConfig, minVolumeActiveTvlMultiple: 3 };
const futureLoose = attachTwoLaneClassification(candidate({ name: "FUTURE-LOOSE-SOL", volume_window: 27_000 }), futureHardGate);
assert.equal(futureLoose.two_lane_classification.lane, "loose");
assert.match(
  getConfiguredPoolThresholdVetoReason(futureLoose, futureHardGate),
  /volume_active_tvl_multiple .* < 3/,
  "shadow classification must not override a stricter configured hard gate"
);

function filterSummary(config) {
  const filteredOut = [];
  const stageCounts = {};
  const pools = [
    primary,
    looseQualified,
    looseSupplementalFail,
    belowLoose,
  ].map((pool) => ({ ...pool }));
  const accepted = filterConfiguredPoolThresholds(pools, config, filteredOut, stageCounts, {});
  return {
    accepted: accepted.map((entry) => entry.name).sort(),
    rejected: filteredOut.map((entry) => entry.name).sort(),
    acceptCount: stageCounts.configured_threshold_accept,
    rejectCount: stageCounts.configured_threshold_reject,
  };
}

const disabledSummary = filterSummary({ ...baseConfig, twoLaneClassificationLoggingEnabled: false, looseLaneEnabled: false });
const enabledSummary = filterSummary({
  ...baseConfig,
  twoLaneClassificationLoggingEnabled: false,
  looseLaneEnabled: true,
  looseLaneShadowOnly: true,
});
assert.deepEqual(enabledSummary, disabledSummary, "shadow two-lane fields must preserve accepted/rejected candidates and counts");

const context = buildCandidateDecisionContext(looseSupplementalFail);
assert.equal(context.feeLane, "loose");
assert.equal(context.looseLaneQualified, false);
assert.match(context.looseLaneVeto, /fee_pct/);
assert.equal(context.feePct, 2);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "two-lane-gate-"));
try {
  const row = appendTwoLaneClassification(looseSupplementalFail, baseConfig, {
    logDir: tmp,
    ts: "2026-05-16T00:00:00.000Z",
    liveAccepted: true,
    liveVetoReason: null,
    throwOnError: true,
  });
  assert.equal(row.event, "two_lane_classification");
  assert.equal(row.lane, "loose");
  assert.equal(row.liveAccepted, true);
  assert.equal(row.config.minVolumeActiveTvlMultiple, 2.5);

  const file = path.join(tmp, "two-lane-classification-2026-05-16.jsonl");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8").trim());
  assert.equal(parsed.poolName, "LOOSE-FAIL-SOL");
  assert.equal(parsed.metrics.volumeActiveTvlMultiple, 2.7);
  assert.equal(parsed.looseLaneQualified, false);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const sourceGuardFiles = [
  ["index.js", fs.readFileSync(new URL("../index.js", import.meta.url), "utf8")],
  ["tools/dlmm.js", fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8")],
  ["tools/executor.js", fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8")],
];
for (const [file, source] of sourceGuardFiles) {
  assert.equal(
    /looseLaneDeployAmountSol|looseLaneShadowOnly/.test(source),
    false,
    `${file} must not consume loose-lane activation or sizing fields in T1`
  );
}

console.log(JSON.stringify({
  success: true,
  acceptanceParity: enabledSummary.accepted.join(",") === disabledSummary.accepted.join(",") &&
    enabledSummary.rejected.join(",") === disabledSummary.rejected.join(",") &&
    enabledSummary.acceptCount === disabledSummary.acceptCount &&
    enabledSummary.rejectCount === disabledSummary.rejectCount,
  belowLiveFloorRejected: /volume_active_tvl_multiple .* < 2.5/.test(getConfiguredPoolThresholdVetoReason(belowLoose, baseConfig)),
  looseSupplementalVetoShadowOnly: getConfiguredPoolThresholdVetoReason(looseSupplementalFail, baseConfig) === null,
  primaryAccepted: getConfiguredPoolThresholdVetoReason(primary, baseConfig) === null,
  futureHardGateNotOverridden: /volume_active_tvl_multiple .* < 3/.test(getConfiguredPoolThresholdVetoReason(futureLoose, futureHardGate)),
  sourceGuardNoDeployConsumers: true,
  decisionContextFields: {
    feeLane: context.feeLane,
    looseLaneQualified: context.looseLaneQualified,
    hasLooseLaneVeto: Boolean(context.looseLaneVeto),
    feePct: context.feePct,
  },
  checks: [
    "accepted/rejected parity with shadow fields enabled",
    "primary lane classification",
    "loose lane is shadow-only and preserves current acceptance",
    "supplemental loose vetoes do not reject in T1",
    "below-live-floor candidates still fail existing hard gate",
    "future stricter hard gate is not overridden by shadow lane",
    "decision-context carries lane fields",
    "two-lane JSONL row shape",
  ],
}, null, 2));
