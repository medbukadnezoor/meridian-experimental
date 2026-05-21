#!/usr/bin/env node
import assert from "assert";
import fs from "fs";
import { evaluateActiveBinBelowRangeEmergency } from "../active-bin-emergency-shadow.js";
import { shouldTriggerActiveBinEmergencyExit } from "../active-bin-oracle.js";

const yae = evaluateActiveBinBelowRangeEmergency({
  active_bin: -471,
  lower_bin: -422,
  upper_bin: -405,
  range_side: "below_range",
  pnl_pct: -39.82,
  entryDrawdownPct: -47.77,
});
assert.equal(yae.decision, "would_close_shadow", "Yae-style catastrophic below-range is shadow close candidate");
assert(yae.reasonCodes.includes("below_range_negative_pnl"));
assert(yae.reasonCodes.includes("deep_below_range_negative_pnl"));

const dustPositive = evaluateActiveBinBelowRangeEmergency({
  active_bin: -475,
  lower_bin: -473,
  upper_bin: -456,
  range_side: "below_range",
  pnl_pct: 2.69,
});
assert.equal(dustPositive.decision, "pass", "Dust positive-PnL below-range counterexample proves below-range alone unsafe");
assert.equal(dustPositive.blindBelowRangeCloseAllowed, false, "blind below-range close is not allowed");

const dustLosing = evaluateActiveBinBelowRangeEmergency({
  active_bin: -504,
  lower_bin: -488,
  upper_bin: -471,
  range_side: "below_range",
  pnl_pct: -4.65,
});
assert.equal(dustLosing.decision, "pass", "mild losing below-range does not pass default compound threshold");

const liveDisabled = evaluateActiveBinBelowRangeEmergency({
  active_bin: -471,
  lower_bin: -422,
  upper_bin: -405,
  range_side: "below_range",
  pnl_pct: -39.82,
});
assert.equal(liveDisabled.liveCloseEnabled, false, "live close flag defaults false");
assert.equal(liveDisabled.shadowOnly, true, "default action is shadow only");

const liveYae = evaluateActiveBinBelowRangeEmergency({
  active_bin: -471,
  lower_bin: -422,
  upper_bin: -405,
  range_side: "below_range",
  pnl_pct: -39.82,
}, {
  liveEnabled: true,
  pnlThresholdPct: -5,
});
assert.equal(liveYae.decision, "blocked", "live below-range negative-PnL emergency can be promoted by config");
assert.equal(liveYae.liveCloseEnabled, true, "live below-range promotion records live close enabled");
assert.equal(liveYae.shadowOnly, false, "live below-range promotion is not shadow-only");
assert.equal(shouldTriggerActiveBinEmergencyExit({
  active_bin_below_range_emergency_shadow_decision: liveYae.decision,
  active_bin_below_range_live_close_enabled: liveYae.liveCloseEnabled,
}, { belowRangeEnabled: true }), true, "live below-range blocked row triggers active-bin emergency exit");

const liveMildLoss = evaluateActiveBinBelowRangeEmergency({
  active_bin: -504,
  lower_bin: -488,
  upper_bin: -471,
  range_side: "below_range",
  pnl_pct: -4.65,
}, {
  liveEnabled: true,
  pnlThresholdPct: -5,
});
assert.equal(liveMildLoss.decision, "pass", "live below-range promotion preserves replay threshold and ignores mild losses");

const activeBinOracleSource = fs.readFileSync(new URL("../active-bin-oracle.js", import.meta.url), "utf8");
assert(activeBinOracleSource.includes("evaluateActiveBinBelowRangeEmergency"), "active-bin oracle runtime path evaluates below-range emergency shadow");
assert(activeBinOracleSource.includes("active_bin_below_range_emergency_shadow_decision"), "active-bin oracle rows persist below-range emergency shadow decision");
assert(activeBinOracleSource.includes("active_bin_below_range_live_close_enabled"), "active-bin oracle rows persist live-close disabled flag");
assert(activeBinOracleSource.includes("belowRangeEnabled"), "active-bin oracle trigger supports below-range live promotion gate");

console.log(JSON.stringify({
  ok: true,
  checks: [
    "Yae-style catastrophic below-range is a shadow-only candidate",
    "Dust positive-PnL below-range counterexample passes",
    "mild losing below-range alone passes",
    "live close defaults false",
    "live below-range negative-PnL promotion can trigger active-bin emergency exit",
    "live below-range promotion preserves -5% threshold and ignores mild losses",
    "below-range alone is not live-close eligible",
    "active-bin oracle runtime rows persist below-range shadow decision fields",
  ],
  sampleDecisions: { yae, dustPositive, dustLosing, liveYae, liveMildLoss },
}, null, 2));
process.exit(0);
