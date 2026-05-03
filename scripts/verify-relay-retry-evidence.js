#!/usr/bin/env node

import assert from "assert";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const source = readFileSync(join(ROOT, "tools", "dlmm.js"), "utf8");

assert.ok(source.includes("function describeRetryEvidence(error)"), "relay fallback should format retry timing evidence");
assert.ok(source.includes("error.retryMeta = metadata"), "retry failures should carry structured retry metadata");
assert.ok(source.includes("elapsed=${meta.totalElapsedMs}ms"), "retry evidence should include total elapsed ms");
assert.ok(source.includes("attempts=${meta.attempts.length}/${meta.maxAttempts}"), "retry evidence should include attempt count");
assert.ok(source.includes("budget=${meta.maxElapsedMs}ms"), "retry evidence should include total retry budget");
assert.ok(source.includes("perAttempt=${meta.perAttemptTimeoutMs}ms"), "retry evidence should include per-attempt timeout");
assert.ok(source.includes("retryable=${attempt.retryable}"), "retry evidence should include retryable classification");
assert.ok(source.includes("maxElapsedMs: 45_000"), "open-position relay should use a 45s total retry budget");
assert.ok(source.includes("perAttemptTimeoutMs: 20_000"), "open-position relay should use a 20s per-attempt timeout");
assert.ok(source.includes("maxAttempts: 2"), "open-position relay should make at most two attempts");
assert.ok(
  source.includes("Agent Meridian relay retry evidence enabled: open-position budget=45000ms perAttempt=20000ms maxAttempts=2"),
  "runtime logs should include a one-time deploy marker for the evidence patch",
);
assert.ok(
  source.includes("describeRetryEvidence(error)") &&
    source.includes("Agent Meridian relay failed; trying LPAgent.io direct:"),
  "relay fallback warning should include retry evidence while preserving LPAgent fallback",
);
assert.ok(
  source.includes("isRetryableError(error)") &&
    source.includes('message.includes("aborted")'),
  "aborted relay reads should remain retryable",
);

console.log(JSON.stringify({
  ok: true,
  checks: 13,
  relayOpenPositionBudget: {
    maxElapsedMs: 45_000,
    perAttemptTimeoutMs: 20_000,
    maxAttempts: 2,
  },
  logMarker: "Agent Meridian relay retry evidence enabled",
}));
