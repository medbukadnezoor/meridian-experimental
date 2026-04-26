#!/usr/bin/env node
/**
 * Synthetic proof for the single-side SOL narrow-range deploy guard.
 *
 * Imports pure range helpers only. No trading APIs, bot runtime, or deploy calls.
 */

import assert from "assert";
import fs from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  normalizeDeployRangeInputs,
  validateSingleSidedSolBidAskRange,
} from "../tools/deploy-range-guard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ACTIVE_BIN_ID = 1000;
const BIN_STEP = 100;

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

function normalize(args, fallbackBinsBelow = 69) {
  return normalizeDeployRangeInputs({
    activeBinId: ACTIVE_BIN_ID,
    activePrice: priceOfBin(ACTIVE_BIN_ID),
    actualBinStep: BIN_STEP,
    getBinIdFromPrice,
    fallbackBinsBelow,
    ...args,
  });
}

function validate(activeBinsBelow, guardConfig = { minSingleSidedSolBins: 35, minSingleSidedSolDownsidePct: 1 }) {
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
  const incident = normalize({
    bins_below: 47,
    bins_above: 0,
    downside_pct: 0,
    upside_pct: 0,
  });
  assert.strictEqual(incident.activeBinsBelow, 47, "downside_pct=0 must not override bins_below");
  assert.strictEqual(incident.activeBinsAbove, 0, "upside_pct=0 must not add upside bins");
  assert.strictEqual(incident.percent_inputs.downside_pct_used, false, "zero downside_pct is ignored");
  assert.strictEqual(incident.percent_inputs.upside_pct_used, false, "zero upside_pct is ignored");
  assert.strictEqual(validate(incident.activeBinsBelow).ok, true, "incident-shape bins_below=47 should pass");

  const zeroWidth = validate(0);
  assert.strictEqual(zeroWidth.ok, false, "zero-width single-side SOL bid_ask range should reject");
  assert.ok(zeroWidth.reason.includes("zero-width bin range"), "zero-width reason should be explicit");

  const oneBin = validate(1);
  assert.strictEqual(oneBin.ok, false, "1-bin single-side SOL bid_ask range should reject");
  assert.ok(oneBin.reason.includes("absolute floor 5"), "1-bin reason should include absolute floor");

  const belowConfigured = validate(34);
  assert.strictEqual(belowConfigured.ok, false, "below configured floor should reject");
  assert.ok(belowConfigured.reason.includes("configured minimum 35"), "configured floor reason should be explicit");

  const accepted = validate(35);
  assert.strictEqual(accepted.ok, true, "configured floor should pass");

  const positiveUpside = normalize({
    bins_below: 47,
    bins_above: 0,
    downside_pct: 0,
    upside_pct: 5,
  });
  assert.strictEqual(positiveUpside.percent_inputs.upside_pct_used, true, "positive upside_pct remains visible for single-side rejection");
  assert.ok(positiveUpside.activeBinsAbove > 0, "positive upside_pct converts before deploy path rejects single-side SOL");

  const dlmmSource = loadSource("tools/dlmm.js");
  const definitionsSource = loadSource("tools/definitions.js");
  const configSource = loadSource("config.js");
  const agentSource = loadSource("agent.js");
  assert.ok(dlmmSource.includes("[range-raw]"), "deploy path logs raw range args");
  assert.ok(dlmmSource.includes("[range-normalized]"), "deploy path logs normalized range");
  assert.ok(dlmmSource.includes("[narrow-range-guard]"), "deploy path logs narrow-range rejection");
  assert.ok(dlmmSource.includes("normalizedRange.percent_inputs.upside_pct_used"), "single-side upside rejection reads normalized positive pct");
  assert.ok(definitionsSource.includes("Zero or negative percentage fields are ignored"), "tool schema discourages 0 pct overrides");
  assert.ok(configSource.includes("minSingleSidedSolBins"), "runtime config exposes minSingleSidedSolBins");
  assert.ok(agentSource.includes("callParams.reasoning_effort = config.llm.screeningReasoningEffort"), "SCREENER passes configured reasoning effort");

  console.log(JSON.stringify({
    success: true,
    incident_zero_pct: {
      input: { bins_below: 47, downside_pct: 0, upside_pct: 0 },
      normalized: incident,
      guard_ok: true,
    },
    rejected: [
      { bins_below: 0, reason: zeroWidth.reason, details: zeroWidth.details },
      { bins_below: 1, reason: oneBin.reason, details: oneBin.details },
      { bins_below: 34, reason: belowConfigured.reason, details: belowConfigured.details },
    ],
    accepted: { bins_below: 35, details: accepted.details },
    positive_upside_visible_for_reject: positiveUpside,
    source_markers: {
      raw_audit_log: true,
      normalized_audit_log: true,
      rejection_audit_log: true,
      schema_zero_pct_warning: true,
      screener_reasoning_effort: true,
    },
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ success: false, error: error.message }, null, 2));
  process.exit(1);
}
