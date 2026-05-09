#!/usr/bin/env node
/**
 * Read-only runtime evidence report for PHASE2A-SUPERTREND-URGENT-T2.
 *
 * This scans agent logs only. It does not import bot runtime modules, touch
 * config, start cron, call trading APIs, or close positions.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function usage() {
  console.log(`Usage: node scripts/report-supertrend-urgent-runtime-proof.js [options]

Options:
  --logs <path>      Agent log file or directory. Default: ./logs
  --since <ISO>      Split pre/post deploy evidence at this timestamp.
  --json             Print JSON only.
  --help             Show this help.

The report classifies post-deploy Supertrend loss-exit evidence as:
  proven_urgent              a qualifying event closed through the urgent path
  no_qualifying_event_yet    no post-deploy Supertrend close event was seen
  regression_old_route_seen  old cooldown/management route appeared post-deploy
`);
}

function parseArgs(argv) {
  const options = {
    logsPath: join(ROOT, "logs"),
    since: null,
    json: false,
  };

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
    if (arg === "--logs") {
      options.logsPath = argv[++i];
      continue;
    }
    if (arg === "--since") {
      options.since = argv[++i];
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.since && Number.isNaN(Date.parse(options.since))) {
    throw new Error(`Invalid --since timestamp: ${options.since}`);
  }

  return options;
}

function listLogFiles(inputPath) {
  const absolute = resolve(inputPath);
  if (!existsSync(absolute)) return [];
  const stat = statSync(absolute);
  if (stat.isFile()) return [absolute];
  if (!stat.isDirectory()) return [];

  return readdirSync(absolute)
    .filter((entry) => /^agent-\d{4}-\d{2}-\d{2}\.log$/u.test(entry))
    .sort()
    .map((entry) => join(absolute, entry));
}

function parseTimestamp(line) {
  const match = line.match(/^\[(\d{4}-\d{2}-\d{2}T[^Z\]]+Z)\]/u);
  return match ? match[1] : null;
}

function eventKind(line) {
  if (!line.includes("Supertrend loss exit")) return null;
  if (line.includes("[PnL poll] URGENT Supertrend loss exit") && line.includes("closing directly")) {
    return "urgent_direct";
  }
  if (line.includes("[PnL poll] Supertrend loss exit") && line.includes("cooldown (")) {
    return "old_cooldown";
  }
  if (line.includes("[PnL poll] Supertrend loss exit") && line.includes("triggering management")) {
    return "old_management";
  }
  if (line.includes("Direct Supertrend loss close failed")) {
    return "urgent_direct_failure";
  }
  if (line.includes("Position ") && line.includes("marked closed: Supertrend loss exit")) {
    return "marked_closed";
  }
  return "other_supertrend";
}

function parsePnl(line) {
  const match = line.match(/PnL\s+(-?\d+(?:\.\d+)?)%/u);
  return match ? Number(match[1]) : null;
}

function parsePair(line) {
  const match = line.match(/Supertrend loss exit:\s+([A-Za-z0-9_.-]+-SOL)\s+/u);
  if (match) return match[1];
  const lesson = line.match(/FAILED:\s+([^,]+),/u);
  if (lesson) return lesson[1];
  const closed = line.match(/\*\*([^*]+)\*\*\s+.*Supertrend loss exit/u);
  if (closed) return closed[1];
  return null;
}

function scanFiles(files, sinceIso) {
  const sinceMs = sinceIso ? Date.parse(sinceIso) : null;
  const events = [];
  let lineCount = 0;

  for (const file of files) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/u);
    lines.forEach((line, index) => {
      lineCount += 1;
      const kind = eventKind(line);
      if (!kind) return;
      const timestamp = parseTimestamp(line);
      const tsMs = timestamp ? Date.parse(timestamp) : null;
      events.push({
        file,
        line: index + 1,
        timestamp,
        phase: sinceMs != null && tsMs != null && tsMs >= sinceMs ? "post_deploy" : "pre_deploy_or_unknown",
        kind,
        pair: parsePair(line),
        pnl_pct: parsePnl(line),
        text: line.slice(0, 320),
      });
    });
  }

  return { lineCount, events };
}

function summarize(events, phase = null) {
  const selected = phase ? events.filter((event) => event.phase === phase) : events;
  const counts = {};
  for (const event of selected) counts[event.kind] = (counts[event.kind] || 0) + 1;
  return {
    total: selected.length,
    counts,
    examples: selected.slice(0, 10),
  };
}

function statusFromPostDeploy(post) {
  const urgent = post.counts.urgent_direct || 0;
  const old = (post.counts.old_cooldown || 0) + (post.counts.old_management || 0);
  if (old > 0) return "regression_old_route_seen";
  if (urgent > 0) return "proven_urgent";
  return "no_qualifying_event_yet";
}

function buildReport(options) {
  const files = listLogFiles(options.logsPath);
  const { lineCount, events } = scanFiles(files, options.since);
  const pre = summarize(events, "pre_deploy_or_unknown");
  const post = summarize(events, "post_deploy");
  const status = options.since ? statusFromPostDeploy(post) : "no_since_timestamp";

  const preDeployFailurePattern = events.some(
    (event) =>
      event.phase === "pre_deploy_or_unknown" &&
      event.kind === "old_cooldown" &&
      String(event.pair || "").includes("UNIPUMP"),
  );

  return {
    success: status !== "regression_old_route_seen",
    analysis_only: true,
    logs_path: resolve(options.logsPath),
    since: options.since,
    files_scanned: files.length,
    lines_scanned: lineCount,
    post_deploy_status: status,
    pre_deploy_failure_pattern_seen: preDeployFailurePattern,
    pre_deploy_or_unknown: pre,
    post_deploy: post,
    interpretation:
      status === "proven_urgent"
        ? "A post-deploy Supertrend loss event used the urgent direct PnL-poller path."
        : status === "no_qualifying_event_yet"
          ? "No post-deploy Supertrend loss close event has occurred yet; keep monitoring."
          : status === "regression_old_route_seen"
            ? "A post-deploy Supertrend loss event used the old cooldown/management route."
            : "No --since timestamp supplied; report is aggregate only.",
    source_safety: {
      imports_runtime_modules: false,
      starts_bot: false,
      calls_trading_apis: false,
      writes_files: false,
    },
  };
}

function printMarkdown(report) {
  console.log("# Supertrend Urgent Runtime Proof");
  console.log("");
  console.log(`- Logs path: \`${report.logs_path}\``);
  console.log(`- Since: \`${report.since || "not supplied"}\``);
  console.log(`- Files scanned: \`${report.files_scanned}\``);
  console.log(`- Lines scanned: \`${report.lines_scanned}\``);
  console.log(`- Post-deploy status: \`${report.post_deploy_status}\``);
  console.log(`- Pre-deploy UNIPUMP cooldown pattern seen: \`${report.pre_deploy_failure_pattern_seen}\``);
  console.log(`- Interpretation: ${report.interpretation}`);
  console.log("");
  console.log("## Counts");
  console.log("");
  console.log(`- Pre/unknown: \`${JSON.stringify(report.pre_deploy_or_unknown.counts)}\``);
  console.log(`- Post-deploy: \`${JSON.stringify(report.post_deploy.counts)}\``);
  console.log("");
  console.log("## Post-Deploy Examples");
  console.log("");
  for (const event of report.post_deploy.examples) {
    console.log(`- \`${event.timestamp || "unknown"}\` ${event.kind} ${event.pair || ""} ${event.pnl_pct ?? ""} at ${event.file}:${event.line}`);
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  const report = buildReport(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printMarkdown(report);
  }
  process.exit(report.success ? 0 : 1);
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
