#!/usr/bin/env node

import assert from "assert";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const source = readFileSync(join(root, "index.js"), "utf8");

const closePositionCalls = source.match(/executeTool\("close_position"/g) || [];

assert.ok(source.includes("DIRECT_CLOSE_IN_FLIGHT_TTL_MS = 5 * 60 * 1000"), "guard TTL should be five minutes");
assert.ok(source.includes("const _directCloseInFlight = new Map()"), "guard should store in-flight closes by position");
assert.ok(source.includes("function tryMarkDirectCloseInFlight"), "guard mark helper should exist");
assert.ok(source.includes("function finishDirectCloseInFlight"), "guard cleanup helper should exist");
assert.ok(source.includes("async function runDirectCloseWithGuard"), "awaited guard helper should exist");
assert.ok(source.includes("function startDirectCloseWithGuard"), "non-blocking guard helper should exist");
assert.ok(source.includes("ageMs <= DIRECT_CLOSE_IN_FLIGHT_TTL_MS"), "fresh in-flight close should be skipped");
assert.ok(source.includes("Replacing stale close-in-flight marker"), "stale in-flight close should be replaceable");
assert.ok(source.includes("_directCloseInFlight.get(positionAddress) === marker"), "cleanup should be marker-safe");
assert.ok(source.includes("Skipping duplicate close"), "duplicate close skip should be logged");
assert.equal(closePositionCalls.length, 1, "index.js should call close_position only inside the guarded helper");

assert.ok(
  source.includes("if (!started) continue;"),
  "PnL poll direct close branches should continue scanning when a duplicate close is skipped",
);
assert.ok(
  source.includes("source: \"PnL poll direct TP\"") &&
    source.includes("source: \"PnL poll stop-loss\"") &&
    source.includes("source: \"PnL poll deterministic stop-loss\"") &&
    source.includes("source: \"PnL poll trailing TP\""),
  "PnL poll TP/SL/trailing direct branches should use startDirectCloseWithGuard",
);
assert.ok(
  source.includes("source: \"Stop loss confirmed\"") &&
    source.includes("source: \"Trailing recheck\"") &&
    source.includes("source: \"Management cycle OOR reposition\""),
  "timer and management direct close branches should use run/start guard helpers",
);
assert.ok(
  source.includes("if (!result?.close_in_flight)") &&
    source.includes("runOorRepositionAfterConfirmedClose"),
  "OOR reposition should not redeploy while another close is merely in flight",
);

console.log(JSON.stringify({
  success: true,
  checks: [
    "per-position close-in-flight map exists",
    "fresh duplicate close attempts are skipped",
    "stale close markers are replaceable",
    "marker-safe cleanup prevents old close from clearing newer marker",
    "all index.js close_position calls route through guarded helper",
    "PnL poll duplicate skips continue scanning other positions",
  ],
}, null, 2));
