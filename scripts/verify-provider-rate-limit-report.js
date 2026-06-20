#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildProviderRateLimitReport,
  classifyLine,
} from "./report-provider-rate-limits.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const REPORT_SCRIPT = join(__dirname, "report-provider-rate-limits.js");
const NOW_MS = Date.parse("2026-06-18T12:45:00.000Z");

function writeLines(filePath, lines) {
  writeFileSync(filePath, `${lines.join("\n")}\n`);
}

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "provider-rate-limit-report-"));
  const logsDir = join(dir, "logs");
  const pm2LogsDir = join(dir, "pm2");
  execFileSync("mkdir", ["-p", logsDir, pm2LogsDir]);

  writeLines(join(logsDir, "agent-2026-06-18.log"), [
    "2026-06-18T10:05:00.000Z ws error: Unexpected server response: 429",
    "2026-06-18T10:06:00.000Z WALLET_ERROR Helius API error: 429 Too Many Requests",
    "2026-06-18T10:06:30.000Z normal heartbeat price=1.00",
    "2026-06-18T09:04:01.429Z RPC_PRESSURE provider helius_rpc error_bucket ok latency_ms=12",
    "legacy ws error: Unexpected server response: 429",
    "2026-06-17T11:59:00.000Z ws error: Unexpected server response: 429",
  ]);

  writeLines(join(logsDir, "actions-2026-06-18.jsonl"), [
    JSON.stringify({
      timestamp: "2026-06-18T08:00:00.000Z",
      provider: "helius_wallet_api",
      status: "rate_limited",
      error: "429 Too Many Requests",
      token: "secret-token-should-redact",
    }),
    JSON.stringify({
      timestamp: "2026-06-18T08:01:00.000Z",
      provider: "helius_rpc",
      error_bucket: "error",
      method: "getProgramAccounts",
      error: "RPC provider failed",
    }),
    JSON.stringify({
      timestamp: "2026-06-18T08:02:00.000Z",
      provider: "helius_rpc",
      error_bucket: "ok",
      event: "RPC_PRESSURE",
    }),
  ]);

  writeLines(join(logsDir, "decision-context-2026-06-18.jsonl"), [
    JSON.stringify({
      timestamp: "2026-06-18T08:03:00.000Z",
      provider: "meteora_datapi",
      error_bucket: "error",
      error: "provider timeout",
    }),
    JSON.stringify({
      timestamp: "2026-06-18T08:04:00.000Z",
      source: "LPAGENT_API",
      error: "HTTP 429 Too many requests",
    }),
  ]);

  writeLines(join(logsDir, "pnl-snapshots-2026-06-18.jsonl"), [
    JSON.stringify({
      timestamp: "2026-06-18T11:15:00.000Z",
      provider: "jupiter",
      error: "Jupiter HTTP 429 Too Many Requests",
    }),
  ]);

  writeLines(join(logsDir, "active-bin-oracle-2026-06-18.jsonl"), [
    JSON.stringify({
      timestamp: "2026-06-18T11:20:00.000Z",
      rpcProvider: "custom_rpc",
      errorBucket: "error",
      error: "RPC error loading active bin",
    }),
  ]);

  writeLines(join(pm2LogsDir, "meridian-error.log"), [
    "2026-06-18T11:30:00.000Z ws error: Unexpected server response: 429",
  ]);
  writeLines(join(pm2LogsDir, "meridian-out.log"), [
    "2026-06-18T11:31:00.000Z LPAGENT_API HTTP 429 Too many requests",
  ]);

  writeLines(join(logsDir, "ignored-random.log"), [
    "2026-06-18T11:35:00.000Z ws error: Unexpected server response: 429",
  ]);

  return { dir, logsDir, pm2LogsDir };
}

function assertBucket(report, name, expectedCount, first, last) {
  const bucket = report.buckets[name];
  assert.equal(bucket.count, expectedCount, `${name} count`);
  assert.equal(bucket.first_timestamp, first, `${name} first timestamp`);
  assert.equal(bucket.last_timestamp, last, `${name} last timestamp`);
  assert.ok(bucket.recent_samples.length <= 5, `${name} samples are bounded`);
  for (const sample of bucket.recent_samples) {
    assert.ok(!/secret-token-should-redact/.test(sample.line), `${name} sample redacts token-like values`);
  }
}

function makeHeliusBurstFixture() {
  const dir = mkdtempSync(join(tmpdir(), "provider-rate-limit-burst-"));
  const logsDir = join(dir, "logs");
  execFileSync("mkdir", ["-p", logsDir]);
  const lines = [];
  for (let i = 0; i < 51; i += 1) {
    lines.push(`2026-06-18T12:00:${String(i).padStart(2, "0")}.000Z ws error: Unexpected server response: 429`);
  }
  writeLines(join(logsDir, "agent-2026-06-18.log"), lines);
  return { dir, logsDir };
}

function assertReportScriptSourceIsReadOnly() {
  const src = readFileSync(REPORT_SCRIPT, "utf8");
  const forbiddenPatterns = [
    [/\bfrom\s+["']node:child_process["']|\bfrom\s+["']child_process["']|\bspawn(?:Sync)?\b|\bexec(?:File|Sync)?\b/, "process execution"],
    [/\bfetch\s*\(|\baxios\b|\bgot\s*\(|\bfrom\s+["']got["']|\brequest\s*\(|\bnode-fetch\b/, "HTTP client"],
    [/\bfrom\s+["']node:https?["']|\brequire\s*\(\s*["']https?["']\s*\)/, "HTTP module"],
    [/\bdotenv\b|\.config\s*\(\s*\)|\.env\//, "dotenv/env-file loading"],
    [/\bprocess\.env\b/, "process.env access"],
    [/\bwriteFile(?:Sync)?\b|\bappendFile(?:Sync)?\b|\bcreateWriteStream\b/, "runtime file writes"],
    [/\bssh\b/, "ssh command"],
  ];

  for (const [pattern, label] of forbiddenPatterns) {
    assert.ok(!pattern.test(src), `report script must not use ${label}`);
  }
  assert.ok(!/\bpm2\s+(?:list|jlist|logs|restart|start|stop)\b/.test(src), "report script must not call PM2 commands");
}

function assertCliFails(args, expectedPattern) {
  assert.throws(
    () => execFileSync(process.execPath, [REPORT_SCRIPT, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
    expectedPattern,
  );
}

const fixture = makeFixture();
try {
  const report = buildProviderRateLimitReport({
    logsDir: fixture.logsDir,
    pm2LogsDir: fixture.pm2LogsDir,
    hours: 24,
    nowMs: NOW_MS,
  });

  assert.equal(report.generated_at, "2026-06-18T12:45:00.000Z");
  assert.equal(report.since, "2026-06-17T12:45:00.000Z");
  assert.equal(report.hours, 24);
  assert.equal(report.total_matches, 10);
  assert.deepEqual(report.scanned_files.sort(), [
    "actions-2026-06-18.jsonl",
    "active-bin-oracle-2026-06-18.jsonl",
    "agent-2026-06-18.log",
    "decision-context-2026-06-18.jsonl",
    "meridian-error.log",
    "meridian-out.log",
    "pnl-snapshots-2026-06-18.jsonl",
  ]);

  assertBucket(report, "helius_ws_429", 2, "2026-06-18T10:05:00.000Z", "2026-06-18T11:30:00.000Z");
  assertBucket(report, "helius_wallet_api_429", 2, "2026-06-18T08:00:00.000Z", "2026-06-18T10:06:00.000Z");
  assertBucket(report, "helius_rpc_error_bucket", 1, "2026-06-18T08:01:00.000Z", "2026-06-18T08:01:00.000Z");
  assertBucket(report, "lpagent_http_429", 2, "2026-06-18T08:04:00.000Z", "2026-06-18T11:31:00.000Z");
  assertBucket(report, "jupiter_http_429", 1, "2026-06-18T11:15:00.000Z", "2026-06-18T11:15:00.000Z");
  assertBucket(report, "other_rpc_error", 2, "2026-06-18T08:03:00.000Z", "2026-06-18T11:20:00.000Z");

  assert.deepEqual(report.buckets.helius_ws_429.by_hour, {
    "2026-06-18T10:00:00.000Z": 1,
    "2026-06-18T11:00:00.000Z": 1,
  });
  assert.equal(report.buckets.helius_rpc_error_bucket.source_files[0], "actions-2026-06-18.jsonl");
  assert.equal(report.paid_helius_decision.status, "watch");
  assert.equal(report.paid_helius_decision.helius_total_matches, 5);

  assert.equal(
    classifyLine('{"timestamp":"2026-06-18T09:04:01.429Z","provider":"helius_rpc","error_bucket":"ok","event":"RPC_PRESSURE"}'),
    null,
    ".429Z timestamp milliseconds must not be treated as an HTTP 429",
  );
  assert.equal(
    classifyLine('{"timestamp":"2026-06-18T09:04:01.429Z","provider":"jupiter","event":"quote_shadow","message":"healthy quote sample"}'),
    null,
    ".429Z timestamp milliseconds must not create non-Helius HTTP 429 matches",
  );

  const cliJson = JSON.parse(execFileSync(process.execPath, [
    REPORT_SCRIPT,
    "--logs-dir",
    fixture.logsDir,
    "--pm2-logs-dir",
    fixture.pm2LogsDir,
    "--hours",
    "24",
    "--now-ms",
    String(NOW_MS),
    "--json",
  ], {
    encoding: "utf8",
  }));
  assert.ok(cliJson.generated_at, "CLI JSON includes generated_at");
  assert.equal(cliJson.buckets.helius_ws_429.count, 2, "CLI JSON reports expected bucket count");

  const cliIsoJson = JSON.parse(execFileSync(process.execPath, [
    REPORT_SCRIPT,
    "--logs-dir",
    fixture.logsDir,
    "--pm2-logs-dir",
    fixture.pm2LogsDir,
    "--hours",
    "24",
    "--now-iso",
    "2026-06-18T12:45:00.000Z",
    "--json",
  ], {
    encoding: "utf8",
  }));
  assert.equal(cliIsoJson.generated_at, "2026-06-18T12:45:00.000Z", "CLI --now-iso freezes generated_at");
  assert.equal(cliIsoJson.buckets.helius_ws_429.count, 2, "CLI --now-iso reports expected bucket count");

  const cliRealClockJson = JSON.parse(execFileSync(process.execPath, [
    REPORT_SCRIPT,
    "--logs-dir",
    fixture.logsDir,
    "--pm2-logs-dir",
    fixture.pm2LogsDir,
    "--hours",
    "24",
    "--json",
  ], {
    encoding: "utf8",
  }));
  assert.notEqual(cliRealClockJson.generated_at, "2026-06-18T12:45:00.000Z", "CLI default path still uses runtime clock");

  assertCliFails([
    "--logs-dir",
    fixture.logsDir,
    "--now-ms",
    "not-a-number",
    "--json",
  ], /--now-ms\/--now-iso must resolve to a valid timestamp/);
  assertCliFails([
    "--logs-dir",
    fixture.logsDir,
    "--now-iso",
    "not-a-date",
    "--json",
  ], /--now-ms\/--now-iso must resolve to a valid timestamp/);
  assertCliFails([
    "--logs-dir",
    fixture.logsDir,
    "--now-ms",
    String(NOW_MS),
    "--now-iso",
    "2026-06-18T12:45:00.000Z",
    "--json",
  ], /Use only one timestamp override/);

  const emptyReport = buildProviderRateLimitReport({
    logsDir: join(fixture.dir, "missing"),
    pm2LogsDir: null,
    hours: 24,
    nowMs: NOW_MS,
  });
  assert.equal(emptyReport.paid_helius_decision.status, "insufficient_evidence");

  const burst = makeHeliusBurstFixture();
  try {
    const burstReport = buildProviderRateLimitReport({
      logsDir: burst.logsDir,
      pm2LogsDir: null,
      hours: 24,
      nowMs: NOW_MS,
    });
    assert.equal(burstReport.paid_helius_decision.status, "consider_paid_or_higher_quota");
    assert.equal(burstReport.paid_helius_decision.max_helius_matches_in_hour, 51);
    assert.ok(burstReport.buckets.helius_ws_429.recent_samples.length <= 5, "burst samples remain bounded");
  } finally {
    rmSync(burst.dir, { recursive: true, force: true });
  }

  assertReportScriptSourceIsReadOnly();

  console.log(JSON.stringify({
    success: true,
    checks: [
      "all provider/rate-limit buckets classify representative fixture rows",
      "RPC_PRESSURE error_bucket ok and .429Z timestamp false positives are excluded",
      "old and undated legacy rows are excluded",
      "by-hour, first/last, source files, and bounded redacted samples are reported",
      "Helius decision statuses cover insufficient evidence, watch, and quota escalation",
      "source scan proves the report script is read-only and has no network, PM2, env, or runtime-write calls",
    ],
    total_matches: report.total_matches,
    paid_helius_decision: report.paid_helius_decision.status,
  }, null, 2));
} finally {
  rmSync(fixture.dir, { recursive: true, force: true });
}
