#!/usr/bin/env node
/**
 * Focused static proof for PnL snapshot range-state telemetry.
 *
 * Does not import index.js, start the bot, call trading APIs, or touch runtime logs.
 */

import fs from "fs";
import path from "path";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const indexPath = path.join(ROOT, "index.js");
const rangeStatePath = path.join(ROOT, "range-state.js");
const source = fs.readFileSync(indexPath, "utf8");
const rangeStateSource = fs.readFileSync(rangeStatePath, "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function extractFunction(src, name) {
  const marker = `function ${name}`;
  const start = src.indexOf(marker);
  assert(start >= 0, `missing ${name}`);
  const paramsEnd = src.indexOf(")", start);
  assert(paramsEnd >= 0, `missing params for ${name}`);
  const bodyStart = src.indexOf("{", paramsEnd);
  assert(bodyStart >= 0, `missing body for ${name}`);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    if (src[i] === "}") depth -= 1;
    if (depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const rangeHelper = extractFunction(source, "buildPnlSnapshotRangeState");
const appendSnapshot = extractFunction(source, "appendPnlSnapshot");
const pollerCall = "const exit = updatePnlAndCheckExits(p.position, p, config.management);";
const snapshotCall = "appendPnlSnapshot(result.wallet, p, exit);";

for (const field of [
  "sourceInRange",
  "derivedRangeSide",
  "derivedInRange",
  "effectiveInRange",
  "lowerBin",
  "upperBin",
  "activeBin",
  "rangeStateMismatch",
  "rangeStateSource",
]) {
  assert(appendSnapshot.includes(field), `snapshot entry missing ${field}`);
}

for (const metric of [
  "source_in_range",
  "derived_range_side",
  "derived_in_range",
  "effective_in_range",
  "lower_bin",
  "upper_bin",
  "active_bin",
  "range_state_mismatch",
  "range_state_source",
]) {
  assert(appendSnapshot.includes(metric), `decision-context metrics missing ${metric}`);
}

assert(appendSnapshot.includes("inRange: rangeState.sourceInRange"), "existing inRange field must remain source/API compatible");
assert(rangeHelper.includes("buildEffectiveRangeStateFromPosition"), "snapshot helper must use shared effective range-state helper");
assert(rangeStateSource.includes("deriveRangeSide"), "derived range side must be computed from bin state");
assert(rangeStateSource.includes("position.lower_bin") && rangeStateSource.includes("position.upper_bin") && rangeStateSource.includes("position.active_bin"), "shared range helper must read lower/upper/active bins");
assert(rangeStateSource.includes("sourceInRange !== derivedInRange"), "mismatch flag must compare source/API and derived state");
assert(rangeStateSource.includes("isLiveBinSource(active_bin_source)"), "effective range must require live active-bin provenance");

for (const forbidden of ["executeTool", "closePosition", "close_position", "updatePnlAndCheckExits"]) {
  assert(!appendSnapshot.includes(forbidden), `appendPnlSnapshot must not alter exit behavior via ${forbidden}`);
  assert(!rangeHelper.includes(forbidden), `range telemetry helper must not alter exit behavior via ${forbidden}`);
}

const pollerExitIndex = source.indexOf(pollerCall);
const pollerSnapshotIndex = source.indexOf(snapshotCall);
assert(pollerExitIndex >= 0, "missing poller exit calculation");
assert(pollerSnapshotIndex >= 0, "missing poller snapshot call");
assert(pollerExitIndex < pollerSnapshotIndex, "snapshot telemetry must remain after exit calculation");

const firstMismatchUse = source.indexOf("rangeStateMismatch");
const updateExitUse = source.indexOf(pollerCall);
assert(firstMismatchUse >= 0 && updateExitUse >= 0, "missing mismatch telemetry or exit calculation");
assert(!source.slice(updateExitUse, pollerSnapshotIndex).includes("rangeStateMismatch"), "mismatch telemetry must not feed exit calculation");

console.log(JSON.stringify({
  success: true,
  snapshotSchema: {
    keepsBackwardCompatibleInRange: true,
    includesSourceInRange: true,
    includesDerivedRangeSide: true,
    includesDerivedInRange: true,
    includesEffectiveInRange: true,
    requiresLiveBinProvenance: true,
    includesBins: true,
    includesMismatch: true,
  },
  decisionContextMetrics: true,
  exitBehaviorUnchanged: true,
}, null, 2));
