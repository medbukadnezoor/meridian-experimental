#!/usr/bin/env node
/**
 * Summarize LPTELE provider health JSONL rows.
 *
 * Usage:
 *   node scripts/report-lptele-provider-health.js
 *   node scripts/report-lptele-provider-health.js --input logs/lptele-provider-health-2026-05-16.jsonl
 *   node scripts/report-lptele-provider-health.js --json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function parseArgs(argv) {
  const args = {
    input: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--input") args.input = argv[++i] ?? null;
  }
  return args;
}

function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function resolveInput(input) {
  if (input) return path.isAbsolute(input) ? input : path.join(ROOT, input);
  return path.join(ROOT, "logs", `lptele-provider-health-${todayIso()}.jsonl`);
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${filePath}:${index + 1} invalid JSON: ${error.message}`);
      }
    });
}

function addCount(target, key) {
  target[key] = (target[key] || 0) + 1;
}

function summarize(rows, inputPath) {
  const providers = {};
  let firstTimestamp = null;
  let lastTimestamp = null;
  for (const row of rows) {
    if (!firstTimestamp || row.timestamp < firstTimestamp) firstTimestamp = row.timestamp;
    if (!lastTimestamp || row.timestamp > lastTimestamp) lastTimestamp = row.timestamp;
    for (const [provider, status] of Object.entries(row.providers || {})) {
      if (!providers[provider]) {
        providers[provider] = {
          statuses: {},
          data_sources: {},
          errors: {},
        };
      }
      addCount(providers[provider].statuses, status.status || "unknown");
      addCount(providers[provider].data_sources, status.data_source || "none");
      if (status.error) addCount(providers[provider].errors, status.error);
    }
  }
  return {
    input: inputPath,
    rows: rows.length,
    first_timestamp: firstTimestamp,
    last_timestamp: lastTimestamp,
    providers,
  };
}

const args = parseArgs(process.argv.slice(2));
const inputPath = resolveInput(args.input);
const summary = summarize(readJsonl(inputPath), inputPath);

if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`LPTELE provider health: ${summary.rows} rows`);
  console.log(`input: ${summary.input}`);
  if (summary.first_timestamp) console.log(`window: ${summary.first_timestamp} -> ${summary.last_timestamp}`);
  for (const [provider, stats] of Object.entries(summary.providers)) {
    console.log(`${provider}: statuses=${JSON.stringify(stats.statuses)} data_sources=${JSON.stringify(stats.data_sources)}`);
    if (Object.keys(stats.errors).length) console.log(`${provider}: errors=${JSON.stringify(stats.errors)}`);
  }
}
