#!/usr/bin/env node

import assert from "assert";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const source = readFileSync(join(root, "index.js"), "utf8");

const closePositionCalls = source.match(/executeTool\("close_position"/g) || [];

function extractFunction(src, name) {
  const marker = `function ${name}`;
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `missing ${name}`);
  const paramsEnd = src.indexOf(")", start);
  assert.ok(paramsEnd >= 0, `missing params for ${name}`);
  const bodyStart = src.indexOf("{", paramsEnd);
  assert.ok(bodyStart >= 0, `missing body for ${name}`);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    if (src[i] === "}") depth -= 1;
    if (depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const markedDirectCloseHelper = extractFunction(source, "executeMarkedDirectClose");
const telegramCloseOneHelper = extractFunction(source, "executeCloseOneAction");
const telegramCloseAllHelper = extractFunction(source, "executeCloseAllAction");

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
assert.equal(closePositionCalls.length, 3, "index.js should call close_position only inside guarded or Telegram-confirmed executor helpers");
assert.ok(markedDirectCloseHelper.includes("executeTool(\"close_position\""), "marked direct close helper should call close_position");
assert.ok(telegramCloseOneHelper.includes("executeTool(\"close_position\""), "Telegram close-one action should call close_position through executor");
assert.ok(telegramCloseAllHelper.includes("executeTool(\"close_position\""), "Telegram close-all action should call close_position through executor");
assert.ok(!source.includes("closePosition("), "index.js should not call raw closePosition directly");

assert.ok(
  source.includes("if (!started) continue;"),
  "PnL poll direct close branches should continue scanning when a duplicate close is skipped",
);
assert.ok(
  source.includes("source: \"PnL poll stop-loss\"") &&
    source.includes("source: \"PnL poll deterministic stop-loss\"") &&
    source.includes("closeEmergencyDirect(p, supertrendExit, \"PnL poll Supertrend loss\")") &&
    source.includes("closeEmergencyDirect(p, {\n                  action: \"MAX_HOLD\""),
  "PnL poll direct close branches should use guarded helpers",
);
assert.ok(
  source.includes("source: \"Stop loss confirmed\"") &&
    source.includes("source: \"Management cycle OOR reposition\"") &&
    source.includes("source: `${source} fee-exit`"),
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
    "all index.js close_position calls route through guarded or Telegram-confirmed executor helpers",
    "PnL poll duplicate skips continue scanning other positions",
  ],
}, null, 2));
