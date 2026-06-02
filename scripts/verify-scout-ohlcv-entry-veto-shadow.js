#!/usr/bin/env node
import assert from "assert";
import { evaluateOhlcvEntryVetoShadow } from "../ohlcv-entry-veto-shadow.js";
import { applyScoutTailLossShadowDecisions } from "../tools/screening.js";

const ballsack = evaluateOhlcvEntryVetoShadow(
  {
    pool: "ballsackPool",
    name: "BALLSACKDORKL-SOL",
    price_change_pct: 1521.8,
    volume_active_tvl_multiple: 2.9,
    fee_active_tvl_ratio: 0.2,
  },
  { ohlcv: { source: "fixture", highDrawdownPct: -57.2831, entryDrawdownPct: -1 } },
);
assert.equal(ballsack.decision, "would_block", "BALLSACKDORKL source mismatch would block in shadow");
assert(ballsack.reasonCodes.includes("high_drawdown_with_extreme_positive_candidate_price_change"));

const yae = evaluateOhlcvEntryVetoShadow(
  {
    pool: "yaePool",
    name: "Yae-SOL",
    price_change_pct: 0,
    volume_active_tvl_multiple: 2.8,
    fee_active_tvl_ratio: 0.19,
  },
  {
    ohlcv: { source: "fixture", highDrawdownPct: -46.3198, entryDrawdownPct: -2 },
    samePoolPriorOutcome: { pnlPct: 4.132780530842969, minutesSince: 6.75 },
  },
);
assert.equal(yae.decision, "would_block", "Yae recent-win high-drawdown compound would block in shadow");
assert(yae.reasonCodes.includes("high_drawdown_after_recent_same_pool_win"));

const trkWinner = evaluateOhlcvEntryVetoShadow(
  {
    pool: "trkPool",
    name: "TRK-SOL",
    price_change_pct: 100,
    volume_active_tvl_multiple: 5,
    fee_active_tvl_ratio: 0.4,
  },
  { ohlcv: { source: "fixture", highDrawdownPct: -49.0768, entryDrawdownPct: -3 } },
);
assert.equal(trkWinner.decision, "pass", "TRK-style high-drawdown winner proves blunt veto unsafe");

const diamondWinner = evaluateOhlcvEntryVetoShadow(
  {
    pool: "diamondPool",
    name: "DIAMOND-SOL",
    price_change_pct: 100,
    volume_active_tvl_multiple: 4,
    fee_active_tvl_ratio: 0.4,
  },
  { ohlcv: { source: "fixture", highDrawdownPct: -71.3574, entryDrawdownPct: -4 } },
);
assert.equal(diamondWinner.decision, "pass", "DIAMOND-style high-drawdown winner is not blocked by compound rule");

const missing = evaluateOhlcvEntryVetoShadow({ pool: "unknown" }, {});
assert.equal(missing.decision, "missing_evidence", "missing OHLCV emits missing_evidence");
assert.equal(ballsack.liveBlockingEnabled, false, "live block is disabled by default");
assert.equal(ballsack.shadowOnly, true, "shadow only by default");

const liveBallsack = evaluateOhlcvEntryVetoShadow(
  {
    pool: "ballsackPool",
    name: "BALLSACKDORKL-SOL",
    price_change_pct: 1521.8,
  },
  {
    ohlcv: { source: "fixture", highDrawdownPct: -57.2831, entryDrawdownPct: -1 },
    config: {
      ohlcvEntryVetoLiveEnabled: true,
      ohlcvEntryVetoHighDrawdownPct: -45,
      ohlcvEntryVetoExtremePriceChangePct: 500,
      ohlcvEntryVetoLiveReasonCodes: ["high_drawdown_with_extreme_positive_candidate_price_change"],
    },
  },
);
assert.equal(liveBallsack.decision, "blocked", "live promotion blocks only the replay-supported extreme-pump reason");
assert.equal(liveBallsack.shadowOnly, false, "live extreme-pump block is not shadow-only");

const liveYaeStillShadow = evaluateOhlcvEntryVetoShadow(
  {
    pool: "yaePool",
    name: "Yae-SOL",
    price_change_pct: 0,
  },
  {
    ohlcv: { source: "fixture", highDrawdownPct: -46.3198, entryDrawdownPct: -2 },
    samePoolPriorOutcome: { pnlPct: 4.132780530842969, minutesSince: 6.75 },
    config: {
      ohlcvEntryVetoLiveEnabled: true,
      ohlcvEntryVetoHighDrawdownPct: -45,
      ohlcvEntryVetoExtremePriceChangePct: 500,
      ohlcvEntryVetoLiveReasonCodes: ["high_drawdown_with_extreme_positive_candidate_price_change"],
    },
  },
);
assert.equal(liveYaeStillShadow.decision, "would_block", "same-pool decay remains shadow when not in live reason allow-list");

const runtimeCandidates = [{
  pool: "ballsackPool",
  name: "BALLSACKDORKL-SOL",
  price_change_pct: 1521.8,
  volume_active_tvl_multiple: 2.9,
  fee_active_tvl_ratio: 0.2,
  ohlcv_high_drawdown_pct: -57.2831,
  ohlcv_entry_drawdown_pct: -1,
}];
const runtimeAccepted = applyScoutTailLossShadowDecisions(runtimeCandidates, {
  ohlcvEntryVetoShadowEnabled: true,
  ohlcvEntryVetoLiveEnabled: false,
  ohlcvEntryVetoHighDrawdownPct: -45,
  ohlcvEntryVetoEntryDrawdownPct: -20,
  ohlcvEntryVetoRequireCompound: true,
}, {
  closeRecords: [],
  now: "2026-05-16T12:44:18.012Z",
  appendContext: false,
});
assert.equal(runtimeAccepted.length, 1, "default OHLCV shadow runtime hook does not live-block candidate");
assert.equal(
  runtimeCandidates[0].ohlcv_entry_veto_shadow?.decision,
  "would_block",
  "normal candidate runtime hook attaches OHLCV entry veto shadow decision",
);

const liveRuntimeCandidates = [{
  pool: "ballsackPool",
  name: "BALLSACKDORKL-SOL",
  price_change_pct: 1521.8,
  volume_active_tvl_multiple: 2.9,
  fee_active_tvl_ratio: 0.2,
  ohlcv_high_drawdown_pct: -57.2831,
  ohlcv_entry_drawdown_pct: -1,
}];
const liveRuntimeAccepted = applyScoutTailLossShadowDecisions(liveRuntimeCandidates, {
  ohlcvEntryVetoShadowEnabled: true,
  ohlcvEntryVetoLiveEnabled: true,
  ohlcvEntryVetoHighDrawdownPct: -45,
  ohlcvEntryVetoEntryDrawdownPct: -20,
  ohlcvEntryVetoExtremePriceChangePct: 500,
  ohlcvEntryVetoRequireCompound: true,
  ohlcvEntryVetoLiveReasonCodes: ["high_drawdown_with_extreme_positive_candidate_price_change"],
}, {
  closeRecords: [],
  now: "2026-05-16T12:44:18.012Z",
  appendContext: false,
});
assert.equal(liveRuntimeAccepted.length, 0, "live OHLCV extreme-pump promotion filters the candidate");

console.log(JSON.stringify({
  ok: true,
  checks: [
    "BALLSACKDORKL-style source mismatch would_block",
    "Yae second-lap recent-win compound would_block",
    "TRK/DIAMOND high-drawdown winners pass compound rule",
    "missing OHLCV emits missing_evidence",
    "live block disabled by default",
    "live block allow-list only promotes extreme-pump reason",
    "same-pool decay remains shadow under recommended live allow-list",
    "blunt high-drawdown-only live block is forbidden",
    "runtime live config filters replay-supported extreme-pump candidate",
    "normal candidate runtime hook attaches OHLCV entry veto shadow without live block",
  ],
  sampleDecisions: { ballsack, yae, trkWinner, diamondWinner, missing, liveBallsack, liveYaeStillShadow },
}, null, 2));
