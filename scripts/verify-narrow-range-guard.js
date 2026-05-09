#!/usr/bin/env node
/**
 * Synthetic proof for the nanocap single-side SOL narrow-range deploy guard.
 *
 * Pure helper import only: no trading APIs, no bot runtime, no deploy calls.
 */

import assert from "assert";
import fs from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  normalizeDeployRangeInputs,
  validateSingleSidedSolBidAskRange,
} from "../tools/deploy-range-guard.js";
import { buildConfig } from "../config-builder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ACTIVE_BIN_ID = 1000;
const BIN_STEP = 50;

function priceOfBin(binId, binStep = BIN_STEP) {
  return Math.pow(1 + binStep / 10_000, binId);
}

function getBinIdFromPrice(price, binStep = BIN_STEP, roundDown = true) {
  const raw = Math.log(price) / Math.log(1 + binStep / 10_000);
  return roundDown ? Math.floor(raw) : Math.ceil(raw);
}

function coverageFor(activeBinsBelow, activeBinsAbove = 0) {
  const activePrice = priceOfBin(ACTIVE_BIN_ID);
  const minPrice = priceOfBin(ACTIVE_BIN_ID - activeBinsBelow);
  const maxPrice = priceOfBin(ACTIVE_BIN_ID + activeBinsAbove);
  return {
    downside_pct: ((activePrice - minPrice) / activePrice) * 100,
    upside_pct: ((maxPrice - activePrice) / activePrice) * 100,
    width_pct: ((maxPrice - minPrice) / minPrice) * 100,
    active_price: activePrice,
  };
}

function normalize(args, fallbackBinsBelow = 85) {
  return normalizeDeployRangeInputs({
    activeBinId: ACTIVE_BIN_ID,
    activePrice: priceOfBin(ACTIVE_BIN_ID),
    actualBinStep: BIN_STEP,
    getBinIdFromPrice,
    fallbackBinsBelow,
    ...args,
  });
}

function validate(activeBinsBelow, guardConfig) {
  return validateSingleSidedSolBidAskRange({
    activeStrategy: "bid_ask",
    isSingleSidedSol: true,
    activeBinId: ACTIVE_BIN_ID,
    minBinId: ACTIVE_BIN_ID - activeBinsBelow,
    maxBinId: ACTIVE_BIN_ID,
    activeBinsBelow,
    activeBinsAbove: 0,
    rangeCoverage: coverageFor(activeBinsBelow, 0),
    guardConfig,
  });
}

function loadSource(relativePath) {
  return fs.readFileSync(join(ROOT, relativePath), "utf8");
}

function main() {
  const nanocapConfig = buildConfig({ preset: "nanocap-v1" }, {});
  const guardConfig = nanocapConfig.strategy;
  assert.strictEqual(guardConfig.minSingleSidedSolBins, 35, "nanocap minSingleSidedSolBins default");
  assert.strictEqual(guardConfig.minSingleSidedSolDownsidePct, 1, "nanocap minSingleSidedSolDownsidePct default");

  const incident = normalize({
    bins_below: 79,
    bins_above: 0,
    downside_pct: 0,
    upside_pct: 0,
  });
  assert.strictEqual(incident.activeBinsBelow, 79, "downside_pct=0 must not override bins_below");
  assert.strictEqual(incident.activeBinsAbove, 0, "upside_pct=0 must not add upside bins");
  assert.strictEqual(incident.percent_inputs.downside_pct_used, false, "zero downside_pct is ignored");
  assert.strictEqual(incident.percent_inputs.upside_pct_used, false, "zero upside_pct is ignored");
  const incidentGuard = validate(incident.activeBinsBelow, guardConfig);
  assert.strictEqual(incidentGuard.ok, true, "incident-shape bins_below=79 should normalize to a valid range");

  const positiveDownside = normalize({
    bins_below: 79,
    bins_above: 0,
    downside_pct: 25,
    upside_pct: 0,
  });
  assert.strictEqual(positiveDownside.percent_inputs.downside_pct_used, true, "positive downside_pct still converts to bins");
  assert.ok(positiveDownside.activeBinsBelow > 0, "positive downside_pct produces downside bins");
  assert.notStrictEqual(positiveDownside.activeBinsBelow, 79, "positive downside_pct takes precedence over bins_below");

  const positiveUpside = normalize({
    bins_below: 79,
    bins_above: 0,
    downside_pct: 0,
    upside_pct: 5,
  });
  assert.strictEqual(positiveUpside.percent_inputs.upside_pct_used, true, "positive upside_pct remains visible for single-side rejection");
  assert.ok(positiveUpside.activeBinsAbove > 0, "positive upside_pct converts before deploy path rejects single-side SOL");

  const rejected = [0, 1, 4, 5, 34].map((bins) => {
    const result = validate(bins, guardConfig);
    assert.strictEqual(result.ok, false, `bins_below=${bins} should be rejected`);
    assert.ok(result.reason.includes("Narrow single-side SOL bid_ask deploy rejected"), `bins_below=${bins} reason prefix`);
    assert.ok(result.reason.includes("configured minimum 35"), `bins_below=${bins} configured threshold reason`);
    return { bins_below: bins, reason: result.reason, details: result.details };
  });

  const accepted = [35, 69, 79, 85, 90].map((bins) => {
    const result = validate(bins, guardConfig);
    assert.strictEqual(result.ok, true, `bins_below=${bins} should pass`);
    return { bins_below: bins, details: result.details };
  });

  const dlmmSource = loadSource("tools/dlmm.js");
  const definitionsSource = loadSource("tools/definitions.js");
  assert.ok(dlmmSource.includes("[range-raw]"), "deploy path logs raw range args");
  assert.ok(dlmmSource.includes("[range-normalized]"), "deploy path logs normalized range");
  assert.ok(dlmmSource.includes("[narrow-range-guard]"), "deploy path logs narrow-range rejection");
  assert.ok(dlmmSource.includes("normalizedRange.percent_inputs.upside_pct_used"), "single-side upside rejection reads normalized positive pct");
  assert.ok(definitionsSource.includes("Zero or negative percentage fields are ignored"), "tool schema discourages 0 pct overrides");

  console.log(JSON.stringify({
    success: true,
    guard_defaults: {
      minSingleSidedSolBins: guardConfig.minSingleSidedSolBins,
      minSingleSidedSolDownsidePct: guardConfig.minSingleSidedSolDownsidePct,
    },
    incident_zero_pct: {
      input: { bins_below: 79, downside_pct: 0, upside_pct: 0 },
      normalized: incident,
      guard_ok: incidentGuard.ok,
    },
    positive_downside_conversion: positiveDownside,
    positive_upside_visible_for_reject: positiveUpside,
    rejected,
    accepted,
    source_markers: {
      raw_audit_log: true,
      normalized_audit_log: true,
      rejection_audit_log: true,
      schema_zero_pct_warning: true,
    },
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ success: false, error: error.message }, null, 2));
  process.exit(1);
}
