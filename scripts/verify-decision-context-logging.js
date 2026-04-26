#!/usr/bin/env node
/**
 * Synthetic source proof for offline-first decision-context logging.
 * Read-only: no network calls, no bot runtime, no deploys/closes, no config writes.
 */

import assert from "assert";
import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function src(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

const loggerPath = join(ROOT, "decision-context-log.js");
assert.ok(existsSync(loggerPath), "decision-context-log.js exists");

const logger = src("decision-context-log.js");
const screening = src("tools/screening.js");
const dlmm = src("tools/dlmm.js");
const index = src("index.js");
const executor = src("tools/executor.js");
const activeRuntimeSources = [
  ["index.js", index],
  ["agent.js", src("agent.js")],
  ["logger.js", src("logger.js")],
  ["tools/screening.js", screening],
  ["tools/dlmm.js", dlmm],
  ["tools/executor.js", executor],
  ["decision-context-log.js", logger],
];

const proof = {
  success: true,
  log_file_pattern_present: logger.includes("decision-context-${dateKey(now)}.jsonl"),
  secret_redaction_present: logger.includes("SECRET_KEY_RE") && logger.includes("<redacted>"),
  no_birdeye_in_live_runtime: activeRuntimeSources.every(([, text]) => !/birdeye/i.test(text)),
  stages: {
    deterministic_veto: screening.includes('stage: "deterministic_veto"'),
    indicator_reject: screening.includes('"indicator_reject"') && screening.includes("getIndicatorDecisionStage"),
    indicator_accept: screening.includes('"indicator_accept"') && screening.includes("getIndicatorDecisionStage"),
    indicator_skip: screening.includes('"indicator_skip"') && screening.includes("getIndicatorDecisionStage"),
    cooldown_block: screening.includes('stage: "cooldown_block"'),
    deploy_attempt: dlmm.includes('stage: "deploy_attempt"'),
    deploy_success: dlmm.includes('stage: "deploy_success"'),
    deploy_reject: dlmm.includes('stage: "deploy_reject"') && executor.includes('stage: "deploy_reject"'),
    close: dlmm.includes('stage: "close"'),
    pnl_snapshot_link: index.includes('stage: "pnl_snapshot_link"'),
  },
  source_safety: {
    deploys_or_closes_positions: false,
    restarts_processes: false,
    changes_config: false,
    network_calls: false,
  },
};

assert.ok(proof.log_file_pattern_present, "daily decision-context JSONL pattern is present");
assert.ok(proof.secret_redaction_present, "logger redacts secret-like keys");
assert.ok(proof.no_birdeye_in_live_runtime, "live runtime does not import or call Birdeye");
for (const [stage, present] of Object.entries(proof.stages)) {
  assert.ok(present, `${stage} logging is wired`);
}

console.log(JSON.stringify(proof, null, 2));
