#!/usr/bin/env node
/**
 * Read-only provider/rate-limit report from existing bot and PM2 logs.
 *
 * Safe by design: no network calls, no PM2 calls, no .env reads, no runtime
 * mutation. The script only scans candidate log files already present on disk.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DEFAULT_PM2_LOGS_DIR = "/home/ubuntu/.pm2/logs";
const SAMPLE_LIMIT = 5;
const SAMPLE_MAX_CHARS = 360;

const BUCKET_NAMES = Object.freeze([
  "helius_ws_429",
  "helius_wallet_api_429",
  "helius_rpc_error_bucket",
  "lpagent_http_429",
  "jupiter_http_429",
  "other_rpc_error",
]);

function usage() {
  console.log([
    "Usage: node scripts/report-provider-rate-limits.js [--logs-dir <path>] [--pm2-logs-dir <path>] [--hours <n>] [--now-ms <epoch_ms>] [--now-iso <iso>] [--json]",
    "",
    "Read-only: scans local log files only; performs no network, PM2, env, or runtime actions.",
  ].join("\n"));
}

export function parseArgs(argv) {
  const options = {
    logsDir: join(ROOT, "logs"),
    pm2LogsDir: existsSync(DEFAULT_PM2_LOGS_DIR) ? DEFAULT_PM2_LOGS_DIR : null,
    hours: 24,
    json: false,
  };
  let nowFlag = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--logs-dir") {
      options.logsDir = resolvePath(argv[++i] || "");
      continue;
    }
    if (arg === "--pm2-logs-dir") {
      const value = argv[++i] || "";
      options.pm2LogsDir = value ? resolvePath(value) : null;
      continue;
    }
    if (arg === "--hours") {
      options.hours = Number(argv[++i]);
      continue;
    }
    if (arg === "--now-ms") {
      if (nowFlag) throw new Error(`Use only one timestamp override, got --${nowFlag} and --now-ms`);
      nowFlag = "now-ms";
      options.nowMs = Number(argv[++i]);
      continue;
    }
    if (arg === "--now-iso") {
      if (nowFlag) throw new Error(`Use only one timestamp override, got --${nowFlag} and --now-iso`);
      nowFlag = "now-iso";
      const value = argv[++i] || "";
      options.nowMs = Date.parse(value);
      continue;
    }
    usage();
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(options.hours) || options.hours <= 0) {
    throw new Error(`--hours must be a positive number, got: ${options.hours}`);
  }
  if (options.nowMs != null && !Number.isFinite(options.nowMs)) {
    throw new Error(`--now-ms/--now-iso must resolve to a valid timestamp, got: ${options.nowMs}`);
  }

  return options;
}

function resolvePath(inputPath) {
  if (isAbsolute(inputPath)) return inputPath;
  return resolve(inputPath);
}

function candidateFileNames(logsDir, pm2LogsDir) {
  const files = [];
  if (logsDir && existsSync(logsDir)) {
    for (const name of readdirSync(logsDir).sort()) {
      if (isBotLogCandidate(name)) files.push(join(logsDir, name));
    }
  }
  if (pm2LogsDir && existsSync(pm2LogsDir)) {
    for (const name of ["meridian-error.log", "meridian-out.log"]) {
      const full = join(pm2LogsDir, name);
      if (existsSync(full)) files.push(full);
    }
  }
  return files.filter((file) => {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

function isBotLogCandidate(name) {
  return [
    /^agent-\d{4}-\d{2}-\d{2}\.log$/,
    /^actions-\d{4}-\d{2}-\d{2}\.jsonl$/,
    /^decision-context-\d{4}-\d{2}-\d{2}\.jsonl$/,
    /^pnl-snapshots-\d{4}-\d{2}-\d{2}\.jsonl$/,
    /^active-bin-oracle-\d{4}-\d{2}-\d{2}\.jsonl$/,
  ].some((pattern) => pattern.test(name));
}

function emptyBucket() {
  return {
    count: 0,
    first_timestamp: null,
    last_timestamp: null,
    by_hour: {},
    source_files: [],
    recent_samples: [],
  };
}

function makeEmptyBuckets() {
  return Object.fromEntries(BUCKET_NAMES.map((name) => [name, emptyBucket()]));
}

function parseJsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractTimestampMs(line, parsed) {
  for (const key of ["timestamp", "time", "ts", "created_at", "generated_at"]) {
    const value = parsed?.[key];
    const ms = timestampValueMs(value);
    if (ms != null) return ms;
  }

  const match = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z/);
  if (!match) return null;
  return timestampValueMs(match[0]);
}

function timestampValueMs(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function hourKey(timestampMs) {
  const date = new Date(timestampMs);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function lineWithoutTimestamps(line) {
  return line.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z/g, "");
}

function has429OrRateLimit(text) {
  return /(^|[^0-9])429([^0-9]|$)/.test(text) ||
    /\brate[_ -]?limited\b/i.test(text) ||
    /\btoo many requests\b/i.test(text);
}

function flattenValue(value, out = []) {
  if (value == null) return out;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenValue(item, out);
    return out;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      out.push(String(key));
      flattenValue(item, out);
    }
  }
  return out;
}

function structuredText(parsed) {
  return parsed ? flattenValue(parsed).join(" ") : "";
}

function jsonField(parsed, key) {
  if (!parsed || typeof parsed !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(parsed, key)) return parsed[key];
  for (const value of Object.values(parsed)) {
    if (value && typeof value === "object") {
      const nested = jsonField(value, key);
      if (nested != null) return nested;
    }
  }
  return null;
}

export function classifyLine(line, parsed = parseJsonLine(line)) {
  const text = lineWithoutTimestamps(`${line} ${structuredText(parsed)}`);
  const provider = String(jsonField(parsed, "provider") ?? jsonField(parsed, "rpcProvider") ?? "").toLowerCase();
  const errorBucket = String(jsonField(parsed, "error_bucket") ?? jsonField(parsed, "errorBucket") ?? "").toLowerCase();
  const bucketIsOk = errorBucket === "ok";

  if (/ws error:\s*unexpected server response:\s*429/i.test(text)) {
    return "helius_ws_429";
  }

  if (
    has429OrRateLimit(text) &&
    (
      /helius[_\s-]*wallet[_\s-]*api/i.test(text) ||
      /\bwallet_error\b/i.test(text) ||
      /helius api error/i.test(text) ||
      provider === "helius_wallet_api"
    )
  ) {
    return "helius_wallet_api_429";
  }

  if (provider === "helius_rpc" && errorBucket && !bucketIsOk) {
    return "helius_rpc_error_bucket";
  }

  if (has429OrRateLimit(text) && /\blpagent_api\b|\blpagent\b/i.test(text)) {
    return "lpagent_http_429";
  }

  if (has429OrRateLimit(text) && /\bjupiter\b/i.test(text)) {
    return "jupiter_http_429";
  }

  if (bucketIsOk) return null;

  if (
    /\brpc\b|\bprovider\b|rpcProvider|error_bucket|errorBucket/i.test(text) &&
    /\berror\b|\bfail(?:ed|ure)?\b|\brate[_ -]?limited\b|\btoo many requests\b|(^|[^0-9])429([^0-9]|$)/i.test(text)
  ) {
    return "other_rpc_error";
  }

  return null;
}

function sanitizeSample(line) {
  return line
    .replace(/(api[_-]?key|apikey|token|secret|authorization|bearer)(["'\s:=]+)[^"',\s}]+/gi, "$1$2[redacted]")
    .replace(/(https?:\/\/[^?\s"']+)\?[^"'\s]+/gi, "$1?[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SAMPLE_MAX_CHARS);
}

function addMatch(bucket, timestampMs, sourceFile, line) {
  const ts = new Date(timestampMs).toISOString();
  bucket.count += 1;
  if (!bucket.first_timestamp || ts < bucket.first_timestamp) bucket.first_timestamp = ts;
  if (!bucket.last_timestamp || ts > bucket.last_timestamp) bucket.last_timestamp = ts;
  const byHour = hourKey(timestampMs);
  bucket.by_hour[byHour] = (bucket.by_hour[byHour] || 0) + 1;
  if (!bucket.source_files.includes(sourceFile)) bucket.source_files.push(sourceFile);
  bucket.recent_samples.push({
    timestamp: ts,
    source_file: sourceFile,
    line: sanitizeSample(line),
  });
  if (bucket.recent_samples.length > SAMPLE_LIMIT) {
    bucket.recent_samples = bucket.recent_samples.slice(-SAMPLE_LIMIT);
  }
}

function paidHeliusDecision(buckets) {
  const heliusBuckets = ["helius_ws_429", "helius_wallet_api_429", "helius_rpc_error_bucket"];
  const total = heliusBuckets.reduce((sum, name) => sum + buckets[name].count, 0);
  let maxHour = 0;
  for (const name of heliusBuckets) {
    for (const count of Object.values(buckets[name].by_hour)) {
      maxHour = Math.max(maxHour, count);
    }
  }
  const status = total > 100 || maxHour > 50
    ? "consider_paid_or_higher_quota"
    : total > 0
      ? "watch"
      : "insufficient_evidence";
  return {
    status,
    helius_total_matches: total,
    max_helius_matches_in_hour: maxHour,
    rationale: status === "consider_paid_or_higher_quota"
      ? "Helius rate-limit/error evidence exceeds conservative local-report thresholds."
      : status === "watch"
        ? "Helius provider errors exist, but local-report thresholds for quota escalation are not met."
        : "No recent Helius provider matches were found in scanned logs.",
    thresholds: {
      consider_paid_or_higher_quota_total_gt: 100,
      consider_paid_or_higher_quota_hour_gt: 50,
    },
  };
}

export function buildProviderRateLimitReport(options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const hours = Number(options.hours ?? 24);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(`hours must be a positive number, got: ${options.hours}`);
  }
  const sinceMs = nowMs - hours * 60 * 60 * 1000;
  const buckets = makeEmptyBuckets();
  const sourceFiles = candidateFileNames(options.logsDir ?? join(ROOT, "logs"), options.pm2LogsDir ?? null);

  for (const filePath of sourceFiles) {
    const sourceFile = basename(filePath);
    const text = readFileSync(filePath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parsed = parseJsonLine(line);
      const timestampMs = extractTimestampMs(line, parsed);
      if (timestampMs == null || timestampMs < sinceMs || timestampMs > nowMs) continue;
      const bucketName = classifyLine(line, parsed);
      if (!bucketName) continue;
      addMatch(buckets[bucketName], timestampMs, sourceFile, line);
    }
  }

  for (const bucket of Object.values(buckets)) {
    bucket.source_files.sort();
    bucket.by_hour = Object.fromEntries(Object.entries(bucket.by_hour).sort(([a], [b]) => a.localeCompare(b)));
    bucket.recent_samples.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  const totalMatches = Object.values(buckets).reduce((sum, bucket) => sum + bucket.count, 0);
  return {
    generated_at: new Date(nowMs).toISOString(),
    since: new Date(sinceMs).toISOString(),
    hours,
    total_matches: totalMatches,
    scanned_files: sourceFiles.map((filePath) => basename(filePath)),
    buckets,
    paid_helius_decision: paidHeliusDecision(buckets),
  };
}

function formatMarkdown(report) {
  const lines = [
    "# Provider Rate-Limit Report",
    "",
    `Generated: ${report.generated_at}`,
    `Since: ${report.since}`,
    `Hours: ${report.hours}`,
    `Total matches: ${report.total_matches}`,
    `Paid Helius decision: ${report.paid_helius_decision.status}`,
    "",
    "## Buckets",
  ];

  for (const name of BUCKET_NAMES) {
    const bucket = report.buckets[name];
    lines.push("");
    lines.push(`### ${name}`);
    lines.push(`Count: ${bucket.count}`);
    lines.push(`First: ${bucket.first_timestamp ?? "n/a"}`);
    lines.push(`Last: ${bucket.last_timestamp ?? "n/a"}`);
    lines.push(`Sources: ${bucket.source_files.join(", ") || "n/a"}`);
    if (Object.keys(bucket.by_hour).length) {
      lines.push(`By hour: ${JSON.stringify(bucket.by_hour)}`);
    }
    for (const sample of bucket.recent_samples) {
      lines.push(`- ${sample.timestamp} ${sample.source_file}: ${sample.line}`);
    }
  }

  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = buildProviderRateLimitReport(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatMarkdown(report));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
