#!/usr/bin/env node
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { buildMainFeeVelocityProtectionGate } from "./report-main-fee-velocity-protection-gate.js";

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "main-fee-velocity-gate-"));
const missing = buildMainFeeVelocityProtectionGate({
  tailJson: path.join(tmp, "missing-tail.json"),
  ohlcvJson: path.join(tmp, "missing-ohlcv.json"),
  belowRangeJson: path.join(tmp, "missing-below.json"),
});
assert.equal(missing.status, "blocked_missing_evidence", "missing artifacts block as missing evidence");

const tailMissingSeed = path.join(tmp, "tail-missing-seed.json");
const ohlcv = path.join(tmp, "ohlcv.json");
const below = path.join(tmp, "below.json");
writeJson(tailMissingSeed, {
  seedStatus: { ballsackdorkl: { present: false }, yaeSecondLap: { present: true, position: "yae2" } },
  replay: { samePoolPostWinCooldown: [], ohlcvCompoundEntryVeto: [] },
});
writeJson(ohlcv, { warning: "do not use blunt high-drawdown veto" });
writeJson(below, { status: "replay_only_live_close_disabled", recommendation: "below_range_alone_not_safe", seedCases: { yaeSecondLap: { present: true } } });
const failedPrevention = buildMainFeeVelocityProtectionGate({ tailJson: tailMissingSeed, ohlcvJson: ohlcv, belowRangeJson: below });
assert.equal(failedPrevention.status, "blocked_failed_prevention", "missing seed causes failed prevention block");

const tailGood = path.join(tmp, "tail-good.json");
writeJson(tailGood, {
  seedStatus: {
    ballsackdorkl: { present: true, position: "balls", pnlPct: -20.87177897034872 },
    yaeSecondLap: { present: true, position: "yae2", pnlPct: -48.26465703731661 },
  },
  replay: {
    samePoolPostWinCooldown: [
      { name: "same_pool_post_win<=15m", blockedWinnerPnlPct: 0, blockedPositions: [{ position: "yae2" }] },
    ],
    ohlcvCompoundEntryVeto: [
      { name: "high<=-45_price_change>=1000", blockedPositions: [{ position: "balls" }], blockedWinnerPnlPct: 0 },
    ],
  },
});
const candidate = buildMainFeeVelocityProtectionGate({ tailJson: tailGood, ohlcvJson: ohlcv, belowRangeJson: below });
assert.equal(candidate.status, "candidate_owner_review_required", "successful fixture still requires owner review");
assert.equal(candidate.ownerApprovalRequired, true, "owner review is always required");
assert.equal(candidate.mainRuntimeChanged, false, "gate does not change Main runtime");

console.log(JSON.stringify({
  ok: true,
  checks: [
    "missing T1/T3/T4 artifacts return blocked_missing_evidence",
    "absent seed loss returns blocked_failed_prevention",
    "successful fixture returns candidate_owner_review_required",
    "owner approval is always required",
    "Main runtime behavior is unchanged",
  ],
  fixtureDir: tmp,
  candidateStatus: candidate.status,
}, null, 2));
