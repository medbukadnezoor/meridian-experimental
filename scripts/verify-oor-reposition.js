#!/usr/bin/env node
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import assert from "assert/strict";
import {
  buildOorRepositionDecision,
  deriveRangeSide,
  findFreshSamePoolCandidate,
  isOorRepositionEligibleRangeSide,
  isOorRepositionEnabled,
} from "../oor-reposition.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function source(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

const abovePosition = {
  position: "PositionAbove111",
  pool: "Pool111",
  pair: "ABOVE-SOL",
  base_mint: "Base111",
  lower_bin: 100,
  upper_bin: 150,
  active_bin: 151,
  minutes_out_of_range: 61,
  pnl_pct: 1.2,
};

const belowPosition = {
  ...abovePosition,
  position: "PositionBelow111",
  active_bin: 99,
};

const unknownPosition = {
  ...abovePosition,
  position: "PositionUnknown111",
  active_bin: null,
};

assert.equal(deriveRangeSide(abovePosition), "above_range");
assert.equal(deriveRangeSide(belowPosition), "below_range");
assert.equal(deriveRangeSide({ ...abovePosition, active_bin: 125 }), "in_range");
assert.equal(deriveRangeSide(unknownPosition), "unknown");

assert.equal(isOorRepositionEnabled({ management: {} }), false);
assert.equal(isOorRepositionEnabled({ management: { oorRepositionEnabled: true } }), true);
assert.equal(isOorRepositionEligibleRangeSide("above_range"), true);
assert.equal(isOorRepositionEligibleRangeSide("below_range"), false);
assert.equal(isOorRepositionEligibleRangeSide("unknown"), false);

const freshCandidate = {
  pool: "Pool111",
  name: "ABOVE-SOL",
  base: { mint: "Base111" },
};
assert.equal(findFreshSamePoolCandidate([freshCandidate], abovePosition), freshCandidate);
assert.equal(findFreshSamePoolCandidate([{ ...freshCandidate, pool: "OtherPool" }], abovePosition), null);
assert.equal(findFreshSamePoolCandidate([{ ...freshCandidate, base: { mint: "OtherBase" } }], abovePosition), null);

const skipped = buildOorRepositionDecision({
  position: abovePosition,
  rangeSide: "above_range",
  decision: "skip",
  reason: "OOR reposition disabled",
});
assert.equal(skipped.event, "oor_reposition_decision");
assert.equal(skipped.decision, "skip");
assert.equal(skipped.freshCandidateFound, false);

const success = buildOorRepositionDecision({
  position: abovePosition,
  rangeSide: "above_range",
  freshScreeningAt: "2026-05-04T00:00:00.000Z",
  freshCandidates: [freshCandidate],
  freshCandidate,
  guardResult: { success: true, position: "NewPosition111" },
  decision: "success",
  reason: "guarded same-pool reposition deployed",
});
assert.equal(success.samePoolCandidate, true);
assert.equal(success.sameBaseMintCandidate, true);
assert.equal(success.guardPassed, true);

const blocked = buildOorRepositionDecision({
  position: abovePosition,
  rangeSide: "above_range",
  freshCandidate,
  guardResult: { blocked: true, reason: "Pool on cooldown" },
  decision: "blocked",
  reason: "Pool on cooldown",
});
assert.equal(blocked.guardPassed, false);
assert.deepEqual(blocked.guardFailures, ["Pool on cooldown"]);

const indexSource = source("index.js");
const oracleSource = source("active-bin-oracle.js");
const dlmmSource = source("tools/dlmm.js");
const configSource = source("config-builder.js");
const exampleConfig = source("user-config.example.json");

assert.match(configSource, /oorRepositionEnabled:\s*u\.oorRepositionEnabled\s*\?\?\s*false/);
assert.match(exampleConfig, /"oorRepositionEnabled":\s*false/);
assert.match(oracleSource, /range_side:\s*rangeSide/);
assert.match(dlmmSource, /range_side:\s*deriveRangeSide/);
assert.match(indexSource, /runOorRepositionAfterConfirmedClose/);
assert.match(indexSource, /executeTool\("close_position"/);
assert.match(indexSource, /getTopCandidates\(\{\s*limit:\s*config\.management\.oorRepositionCandidateLimit/);
assert.match(indexSource, /findFreshSamePoolCandidate/);
assert.doesNotMatch(indexSource, /_latestCandidates[\s\S]{0,400}runOorRepositionAfterConfirmedClose/);
assert.match(indexSource, /tool:\s*"oor_reposition_decision"[\s\S]*\.\.\.decision/);
assert.match(indexSource, /close confirmation blocked: old position still appears open/);
assert.match(indexSource, /max positions reached after close/);
const repositionFunctionBody = indexSource.match(/async function runOorRepositionAfterConfirmedClose[\s\S]*?\n}\n\nfunction formatActiveBinOracleExitReason/)?.[0] ?? "";
assert.doesNotMatch(repositionFunctionBody, /_latestCandidates/);

const forbiddenMainHooks = [
  "../meridian-experimental",
  "meridian-experimental/",
  "meridian-nanocap/",
  "../meridian-nanocap",
];
for (const file of ["index.js", "oor-reposition.js", "active-bin-oracle.js", "tools/dlmm.js"]) {
  const body = source(file);
  for (const forbidden of forbiddenMainHooks) {
    assert.equal(body.includes(forbidden), false, `${file} must not hook main/nanocap via ${forbidden}`);
  }
}

const proof = {
  disabled_flag_default_off: true,
  range_side: {
    above: deriveRangeSide(abovePosition),
    below: deriveRangeSide(belowPosition),
    in_range: deriveRangeSide({ ...abovePosition, active_bin: 125 }),
    unknown: deriveRangeSide(unknownPosition),
  },
  above_success_path: success.decision === "success" && success.samePoolCandidate && success.sameBaseMintCandidate,
  below_blocked_path: !isOorRepositionEligibleRangeSide("below_range"),
  non_oor_closes_not_enqueued: !isOorRepositionEligibleRangeSide("in_range"),
  stale_close_confirmation_blocked: indexSource.includes("old position still appears open"),
  max_positions_blocked: indexSource.includes("max positions reached after close"),
  cooldown_or_guard_failure_blocked: blocked.decision === "blocked" && blocked.guardPassed === false,
  no_stale_latest_candidates: !repositionFunctionBody.includes("_latestCandidates"),
  no_main_nanocap_hooks: true,
};

console.log(JSON.stringify(proof, null, 2));
