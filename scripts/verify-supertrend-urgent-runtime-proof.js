#!/usr/bin/env node
/**
 * Focused verifier for the Supertrend urgent runtime evidence reporter.
 *
 * Uses synthetic log files only; no bot runtime modules or trading APIs.
 */

import assert from "assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const REPORTER = join(__dirname, "report-supertrend-urgent-runtime-proof.js");

function runReporter(logsDir, since) {
  const result = spawnSync(process.execPath, [REPORTER, "--logs", logsDir, "--since", since, "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `reporter failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function main() {
  const tempDir = mkdtempSync(join(tmpdir(), "meridian-supertrend-runtime-proof-"));
  const logsDir = join(tempDir, "logs");
  mkdirSync(logsDir);

  writeFileSync(
    join(logsDir, "agent-2026-05-02.log"),
    [
      "[2026-05-02T20:51:20.741Z] [STATE] [PnL poll] Supertrend loss exit pending: PnL -5.62% <= -4% and 15m Supertrend bearish (1/2)",
      "[2026-05-02T20:51:51.229Z] [STATE] [PnL poll] Supertrend loss exit: UNIPUMP-SOL -- Supertrend loss exit: PnL -6.07% <= -4% and 15m Supertrend bearish for 2 checks -- cooldown (120s left)",
      "[2026-05-02T20:52:23.989Z] [STATE] [PnL poll] Supertrend loss exit: UNIPUMP-SOL -- Supertrend loss exit: PnL -6.39% <= -4% and 15m Supertrend bearish for 2 checks -- cooldown (87s left)",
      "[2026-05-02T20:53:40.806Z] [STATE] [Stop loss confirmed] UNIPUMP-SOL -- Stop loss confirmed: PnL -9.71% <= -8% after 15s recheck (candidate -8.02%) -- closing directly",
    ].join("\n"),
  );

  writeFileSync(
    join(logsDir, "agent-2026-05-03.log"),
    [
      "[2026-05-03T09:03:56.760Z] [STARTUP] DLMM LP Agent starting...",
      "[2026-05-03T09:04:33.760Z] [AGENT] Final answer reached",
    ].join("\n"),
  );

  const noEventReport = runReporter(logsDir, "2026-05-03T09:03:56.000Z");
  assert.equal(noEventReport.success, true, "no post-deploy event should not fail");
  assert.equal(noEventReport.post_deploy_status, "no_qualifying_event_yet", "no qualifying event status");
  assert.equal(noEventReport.pre_deploy_failure_pattern_seen, true, "UNIPUMP pre-deploy cooldown pattern should be captured");
  assert.equal(noEventReport.pre_deploy_or_unknown.counts.old_cooldown, 2, "old cooldown examples counted");
  assert.equal(noEventReport.post_deploy.total, 0, "no post-deploy Supertrend event counted");

  writeFileSync(
    join(logsDir, "agent-2026-05-04.log"),
    [
      "[2026-05-04T00:00:01.000Z] [STATE] [PnL poll] URGENT Supertrend loss exit: TEST-SOL -- Supertrend loss exit: PnL -5.10% <= -4% and 15m Supertrend bearish for 2 checks -- closing directly (no cooldown, no LLM)",
      "[2026-05-04T00:00:12.000Z] [STATE] [PnL poll Supertrend loss] Direct urgent stop-loss close succeeded: TEST-SOL PnL=-5.25%",
    ].join("\n"),
  );

  const urgentReport = runReporter(logsDir, "2026-05-03T09:03:56.000Z");
  assert.equal(urgentReport.success, true, "urgent report should pass");
  assert.equal(urgentReport.post_deploy_status, "proven_urgent", "urgent event should prove runtime path");
  assert.equal(urgentReport.post_deploy.counts.urgent_direct, 1, "urgent direct event counted");

  writeFileSync(
    join(logsDir, "agent-2026-05-05.log"),
    "[2026-05-05T00:00:01.000Z] [STATE] [PnL poll] Supertrend loss exit: REGRESSION-SOL -- Supertrend loss exit: PnL -6.00% <= -4% and 15m Supertrend bearish for 2 checks -- cooldown (60s left)\n",
  );
  const regression = spawnSync(process.execPath, [REPORTER, "--logs", logsDir, "--since", "2026-05-05T00:00:00.000Z", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.notEqual(regression.status, 0, "post-deploy old route should fail the reporter");
  const regressionJson = JSON.parse(regression.stdout);
  assert.equal(regressionJson.post_deploy_status, "regression_old_route_seen", "regression status classified");

  const reporterSource = readFileSync(REPORTER, "utf8");
  assert.equal(/from\s+["'][^"']*(?:index|tools|config|state|supertrend-loss-exit)[^"']*["']/u.test(reporterSource), false, "reporter must not import runtime modules");
  assert.equal(reporterSource.includes("writeFileSync"), false, "reporter must not write files");

  console.log(JSON.stringify({
    success: true,
    cases: {
      noQualifyingEventYet: noEventReport.post_deploy_status,
      provenUrgent: urgentReport.post_deploy_status,
      regressionOldRouteSeen: regressionJson.post_deploy_status,
      preDeployFailurePatternSeen: noEventReport.pre_deploy_failure_pattern_seen,
    },
    sourceSafety: {
      importsRuntimeModules: false,
      writesFiles: false,
      startsBot: false,
      callsTradingApis: false,
    },
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
