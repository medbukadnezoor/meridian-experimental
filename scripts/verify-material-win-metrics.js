#!/usr/bin/env node
/**
 * Synthetic proof for material win metrics.
 *
 * Runs entirely from local fixtures/temp files. It does not call trading APIs
 * and does not touch live bot state.
 */

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  classifyCloseReason,
  classifyMaterialOutcome,
  summarizeMaterialPerformance,
} from "../performance-metrics.js";
import { buildConfig } from "../config-builder.js";
import { recalculateWeights } from "../signal-weights.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MATERIAL_UPDATE_CONFIG_FIELDS = Object.freeze([
  "materialWinPct",
  "materialLossPct",
  "dustNeutralAbsPct",
  "neutralCloseReasonBuckets",
  "darwinUseMaterialOutcomes",
  "darwinExcludeNeutralOutcomes",
]);

function baseOptions() {
  return {
    performance: {
      materialWinPct: 1,
      materialLossPct: -1,
      dustNeutralAbsPct: 1,
      neutralCloseReasonBuckets: ["low_yield", "operator"],
      darwinUseMaterialOutcomes: true,
      darwinExcludeNeutralOutcomes: true,
    },
  };
}

function classify(record) {
  return classifyMaterialOutcome(record, baseOptions());
}

function loadSource(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function materialConfigMapEntryPresent(src, key) {
  return new RegExp(`${key}:\\s*\\["performance",\\s*"${key}"\\]`).test(src);
}

function materialDefinitionsFieldPresent(src, key) {
  return new RegExp(`["']${key}["']`).test(src);
}

function assertClassification(label, record, expected) {
  const actual = classify(record);
  for (const [key, value] of Object.entries(expected)) {
    assert.deepStrictEqual(actual[key], value, `${label}: expected ${key}=${value}, got ${actual[key]}`);
  }
  return actual;
}

function recentRecord(daysAgo, extra) {
  const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return {
    recorded_at: ts,
    fee_tvl_ratio: 1,
    volatility: 2,
    signal_snapshot: {},
    ...extra,
  };
}

function runDarwinProof() {
  const previousCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-material-wins-"));
  try {
    process.chdir(tempDir);
    fs.mkdirSync(path.join(tempDir, "logs"), { recursive: true });
    const records = [
      recentRecord(1, { pnl_pct: 0.01, pnl_usd: 0.01, close_reason: "low yield", organic_score: 5 }),
      recentRecord(1, { pnl_pct: 0.02, pnl_usd: 0.01, close_reason: "low yield: fee/TVL dust", organic_score: 10 }),
      recentRecord(1, { pnl_pct: 0.03, pnl_usd: 0.01, close_reason: "Trailing TP: Low yield", organic_score: 15 }),
      recentRecord(1, { pnl_pct: 8, pnl_usd: 0.8, close_reason: "Trailing TP: peak 10 -> current 8", organic_score: 90 }),
      recentRecord(1, { pnl_pct: 7, pnl_usd: 0.7, close_reason: "take profit", organic_score: 82 }),
      recentRecord(1, { pnl_pct: -8, pnl_usd: -0.8, close_reason: "Stop loss: PnL -8% <= -8%", organic_score: 25 }),
      recentRecord(1, { pnl_pct: -15, pnl_usd: -1.5, close_reason: "Hard stop loss: PnL -15% <= -15%", organic_score: 20 }),
    ];

    const originalConsoleLog = console.log;
    let result;
    try {
      console.log = () => {};
      result = recalculateWeights(records, {
        ...baseOptions(),
        darwin: {
          enabled: true,
          windowDays: 30,
          minSamples: 4,
          perSignalMinSamples: 2,
          calibrationMinSamples: 2,
          minAbsLiftToAdjust: 0.01,
          strongLiftThreshold: 0.1,
          boostFactor: 1.1,
          decayFactor: 0.9,
          weightFloor: 0.3,
          weightCeiling: 2.5,
        },
      });
    } finally {
      console.log = originalConsoleLog;
    }

    assert.strictEqual(result.learning.raw_recent_records, 7, "Darwin raw recent count");
    assert.strictEqual(result.learning.material_learning_records, 4, "Darwin material learning count");
    assert.strictEqual(result.learning.material_wins, 2, "Darwin material wins");
    assert.strictEqual(result.learning.material_losses, 2, "Darwin material losses");
    assert.strictEqual(result.learning.neutral_excluded, 3, "Darwin neutral exclusions");
    assert.ok(fs.existsSync(path.join(tempDir, "signal-weights.json")), "Darwin wrote only temp signal-weights.json");
    return {
      ...result.learning,
      tempSignalWeightsCreated: true,
    };
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runUpdateConfigProof() {
  const executor = loadSource("tools/executor.js");
  const definitions = loadSource("tools/definitions.js");
  const executorKeys = MATERIAL_UPDATE_CONFIG_FIELDS.filter((key) => materialConfigMapEntryPresent(executor, key));
  const definitionKeys = MATERIAL_UPDATE_CONFIG_FIELDS.filter((key) => materialDefinitionsFieldPresent(definitions, key));

  assert.deepStrictEqual(executorKeys, [...MATERIAL_UPDATE_CONFIG_FIELDS], "executor material update_config keys");
  assert.deepStrictEqual(definitionKeys, [...MATERIAL_UPDATE_CONFIG_FIELDS], "definitions material update_config keys");
  assert.ok(definitions.includes("live-tunable through operator-only"), "definitions document live-tunable operator-only scope");
  assert.ok(definitions.includes("Raw WR/Material WR reporting"), "definitions document report labels");
  assert.ok(definitions.includes("Darwin material learning only"), "definitions document Darwin-only learning scope");
  assert.ok(definitions.includes("not stop-loss, TP, entry, sizing, routing, or GMGN policy"), "definitions document no trading-policy change");

  return {
    liveTunable: true,
    operatorPaths: ["meridian config set", "Telegram /setcfg"],
    fields: [...MATERIAL_UPDATE_CONFIG_FIELDS],
    affects: ["Raw WR/Material WR reporting", "Darwin material learning"],
    doesNotAffect: ["stop-loss", "TP", "entry", "sizing", "routing", "GMGN"],
  };
}

function runOwnerLabelProof() {
  const index = loadSource("index.js");
  const briefing = loadSource("briefing.js");
  const poolMemory = loadSource("pool-memory.js");
  const analyzer = loadSource("scripts/analyze-material-wins.js");
  const proof = {
    thresholdsCommand: index.includes("Raw WR") && index.includes("Material WR") && !index.includes("  Win rate:"),
    briefing: briefing.includes("Raw WR") && briefing.includes("Material WR"),
    poolMemory: poolMemory.includes("raw WR") && poolMemory.includes("material WR"),
    analyzerText: analyzer.includes("Raw WR") && analyzer.includes("Material WR"),
    ambiguousBareWinRateHeadlineAbsent: !index.includes("  Win rate:"),
  };

  assert.ok(proof.thresholdsCommand, "/thresholds labels Raw WR and Material WR explicitly");
  assert.ok(proof.briefing, "briefing labels Raw WR and Material WR explicitly");
  assert.ok(proof.poolMemory, "pool memory labels raw/material WR explicitly");
  assert.ok(proof.analyzerText, "material analyzer labels Raw WR and Material WR explicitly");
  assert.ok(proof.ambiguousBareWinRateHeadlineAbsent, "ambiguous bare Win rate headline absent");

  return proof;
}

function main() {
  assert.strictEqual(classifyCloseReason("Trailing TP: Early dump: PnL -8%"), "early_dump");
  assert.strictEqual(classifyCloseReason("Trailing TP: Stop loss: PnL -27%"), "stop_loss");
  assert.strictEqual(classifyCloseReason("low yield: fee/TVL 0.01%"), "low_yield");

  const cases = {
    lowYieldDustWin: assertClassification("+0.01% low yield", {
      pnl_pct: 0.01,
      pnl_usd: 0.001,
      close_reason: "low yield",
    }, {
      raw_win: true,
      material_outcome: "neutral",
      material_win: false,
      neutral_reason: "low_yield",
      close_reason_bucket: "low_yield",
    }),
    tinyTrailingTp: assertClassification("+0.8% trailing TP", {
      pnl_pct: 0.8,
      pnl_usd: 0.01,
      close_reason: "Trailing TP: peak 3 -> current 0.8",
    }, {
      raw_win: true,
      material_outcome: "neutral",
      material_win: false,
      neutral_reason: "dust",
      close_reason_bucket: "trailing_tp",
    }),
    materialTrailingTp: assertClassification("+8% trailing TP", {
      pnl_pct: 8,
      pnl_usd: 0.08,
      close_reason: "Trailing TP: peak 10 -> current 8",
    }, {
      raw_win: true,
      material_outcome: "material_win",
      material_win: true,
      close_reason_bucket: "trailing_tp",
    }),
    operatorDust: assertClassification("-0.2% operator", {
      pnl_pct: -0.2,
      pnl_usd: -0.002,
      close_reason: "operator command: blacklist",
    }, {
      raw_win: false,
      material_outcome: "neutral",
      material_loss: false,
      neutral_reason: "operator",
      close_reason_bucket: "operator",
    }),
    operatorMaterialLoss: assertClassification("-2% operator", {
      pnl_pct: -2,
      pnl_usd: -0.02,
      close_reason: "operator command: close all",
    }, {
      raw_win: false,
      material_outcome: "material_loss",
      material_loss: true,
      close_reason_bucket: "operator",
    }),
    stopLoss: assertClassification("-8% stop loss", {
      pnl_pct: -8,
      pnl_usd: -0.08,
      close_reason: "stop loss: PnL -8% <= -8%",
    }, {
      material_outcome: "material_loss",
      material_loss: true,
      close_reason_bucket: "stop_loss",
    }),
    hardStopLoss: assertClassification("-15% hard stop", {
      pnl_pct: -15,
      pnl_usd: -0.15,
      close_reason: "Hard stop loss: PnL -15% <= -15%",
    }, {
      material_outcome: "material_loss",
      material_loss: true,
      close_reason_bucket: "stop_loss",
    }),
    positiveOor: assertClassification("+3% OOR", {
      pnl_pct: 3,
      pnl_usd: 0.03,
      close_reason: "OOR: Out of range for 60m",
    }, {
      material_outcome: "material_win",
      material_win: true,
      close_reason_bucket: "oor",
    }),
    negativeOor: assertClassification("-3% OOR", {
      pnl_pct: -3,
      pnl_usd: -0.03,
      close_reason: "OOR: Out of range for 60m",
    }, {
      material_outcome: "material_loss",
      material_loss: true,
      close_reason_bucket: "oor",
    }),
  };

  const summaryRecords = [
    { pnl_pct: 0.01, pnl_usd: 0.001, close_reason: "low yield" },
    { pnl_pct: 0.8, pnl_usd: 0.01, close_reason: "Trailing TP: peak 3 -> current 0.8" },
    { pnl_pct: 8, pnl_usd: 0.08, close_reason: "Trailing TP: peak 10 -> current 8" },
    { pnl_pct: -0.2, pnl_usd: -0.002, close_reason: "operator command: blacklist" },
    { pnl_pct: -2, pnl_usd: -0.02, close_reason: "operator command: close all" },
    { pnl_pct: -8, pnl_usd: -0.08, close_reason: "stop loss: PnL -8% <= -8%" },
    { pnl_pct: -15, pnl_usd: -0.15, close_reason: "Hard stop loss: PnL -15% <= -15%" },
    { pnl_pct: 3, pnl_usd: 0.03, close_reason: "OOR: Out of range for 60m" },
    { pnl_pct: -3, pnl_usd: -0.03, close_reason: "OOR: Out of range for 60m" },
  ];
  const summary = summarizeMaterialPerformance(summaryRecords, baseOptions());
  assert.strictEqual(summary.raw_sample_count, 9);
  assert.strictEqual(summary.material_sample_count, 6);
  assert.strictEqual(summary.low_yield_neutral_count, 1);
  assert.strictEqual(summary.dust_neutral_count, 1);
  assert.strictEqual(summary.operator_neutral_count, 1);
  assert.strictEqual(summary.material_win_rate_pct, 22.22);
  assert.strictEqual(summary.material_decision_win_rate_pct, 33.33);

  const defaultConfig = buildConfig({});
  assert.strictEqual(defaultConfig.performance.materialWinPct, 1.0);
  assert.strictEqual(defaultConfig.performance.materialLossPct, -1.0);
  assert.strictEqual(defaultConfig.performance.dustNeutralAbsPct, 1.0);
  assert.strictEqual(defaultConfig.performance.darwinUseMaterialOutcomes, true);
  assert.strictEqual(defaultConfig.performance.darwinExcludeNeutralOutcomes, true);

  const flatConfig = buildConfig({
    materialWinPct: 2,
    materialLossPct: -3,
    dustNeutralAbsPct: 0.5,
    darwinUseMaterialOutcomes: false,
    darwinExcludeNeutralOutcomes: false,
  });
  assert.strictEqual(flatConfig.performance.materialWinPct, 2);
  assert.strictEqual(flatConfig.performance.materialLossPct, -3);
  assert.strictEqual(flatConfig.performance.dustNeutralAbsPct, 0.5);
  assert.strictEqual(flatConfig.performance.darwinUseMaterialOutcomes, false);
  assert.strictEqual(flatConfig.performance.darwinExcludeNeutralOutcomes, false);

  const darwinProof = runDarwinProof();
  const updateConfigProof = runUpdateConfigProof();
  const ownerLabelProof = runOwnerLabelProof();

  console.log(JSON.stringify({
    success: true,
    cases,
    summary,
    runtimeConfig: defaultConfig.performance,
    darwinProof,
    updateConfigProof,
    ownerLabelProof,
    scriptReadOnly: true,
    repoRoot: ROOT,
  }, null, 2));
}

main();
