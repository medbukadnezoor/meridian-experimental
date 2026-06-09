#!/usr/bin/env node
import assert from "assert";
import fs from "fs";

import { evaluateAthPullbackBand } from "../ath-pullback-band.js";
import { buildConfig } from "../config-builder.js";

const config = { athFilterPct: -15, athMinPriceVsAthPct: 55 };

const tooClose = evaluateAthPullbackBand(92, config);
assert.strictEqual(tooClose.accepted, false, "92% of ATH is too close when max is 85%");
assert.strictEqual(tooClose.reason, "too_close_to_ath");
assert.match(tooClose.message, /> 85%/);

const controlledPullback = evaluateAthPullbackBand(70, config);
assert.strictEqual(controlledPullback.accepted, true, "70% of ATH is inside 55-85 band");
assert.strictEqual(controlledPullback.reason, "inside_ath_pullback_band");

const deepCollapse = evaluateAthPullbackBand(40, config);
assert.strictEqual(deepCollapse.accepted, false, "40% of ATH is too deeply collapsed when min is 55%");
assert.strictEqual(deepCollapse.reason, "too_far_below_ath");
assert.match(deepCollapse.message, /< 55%/);

const missing = evaluateAthPullbackBand(null, config);
assert.strictEqual(missing.accepted, true, "missing ATH evidence stays non-blocking for compatibility");
assert.strictEqual(missing.missing, true);

const runtime = buildConfig({ athFilterPct: -15, athMinPriceVsAthPct: 55 }, {});
assert.strictEqual(runtime.screening.athFilterPct, -15, "runtime screening config carries ATH max offset");
assert.strictEqual(runtime.screening.athMinPriceVsAthPct, 55, "runtime screening config carries ATH lower bound");
assert.strictEqual(runtime.gmgn.athFilterPct, -15, "GMGN config carries ATH max offset");
assert.strictEqual(runtime.gmgn.athMinPriceVsAthPct, 55, "GMGN config carries ATH lower bound");

const screeningSource = fs.readFileSync(new URL("../tools/screening.js", import.meta.url), "utf8");
assert.ok(screeningSource.includes("evaluateAthPullbackBand"), "screening uses shared ATH band helper");
assert.ok(screeningSource.includes("athMinPriceVsAthPct"), "screening reads ATH lower bound");
assert.ok(!screeningSource.includes("rsi_reversal not confirmed") || screeningSource.includes("Indicator confirmation removed"), "indicator path remains separate from ATH band");

const gmgnSource = fs.readFileSync(new URL("../tools/gmgn.js", import.meta.url), "utf8");
assert.ok(gmgnSource.includes("evaluateAthPullbackBand"), "GMGN uses shared ATH band helper");

const executorSource = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
assert.ok(executorSource.includes("athMinPriceVsAthPct"), "operator config updates can tune ATH lower bound");

console.log(JSON.stringify({
  success: true,
  band: {
    minPriceVsAthPct: 55,
    maxPriceVsAthPct: 85,
    acceptedExample: controlledPullback.priceVsAthPct,
    tooCloseReason: tooClose.reason,
    deepCollapseReason: deepCollapse.reason,
  },
  checks: [
    "too-close-to-ATH rejected",
    "controlled pullback accepted",
    "deep collapse rejected",
    "missing ATH data non-blocking",
    "runtime screening and GMGN config mapping",
    "screening and GMGN share ATH band helper",
    "operator update config exposes ATH lower bound",
  ],
}, null, 2));
