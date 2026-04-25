#!/usr/bin/env node
/**
 * Owner-facing relay guard evidence report.
 *
 * Safe by design: this script does not deploy, close, restart, or edit config.
 * When proving experimental parity it creates a temporary checkout, links the
 * already-installed dependency tree, runs verifiers, then removes the checkout.
 */

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const NANOCAP_GUARD_BASE_COMMIT = "10a5819";
const EXPERIMENTAL_GUARD_BASE_COMMIT = "9a7c72c";
const RELAY_STATUS_VALUES = Object.freeze([
  "not_yet_exercised",
  "guard_approved",
  "guard_rejected",
]);

const args = new Set(process.argv.slice(2));

function getArg(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function run(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    cwd: options.cwd || ROOT,
    encoding: "utf8",
    env: options.env || process.env,
    timeout: options.timeout ?? 120_000,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
  });
}

function runRequired(command, commandArgs, options = {}) {
  const result = run(command, commandArgs, options);
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "(no stderr)";
    const stdout = result.stdout?.trim() || "(no stdout)";
    throw new Error(`${command} ${commandArgs.join(" ")} failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return result.stdout.trim();
}

function parseJson(stdout, fallback = null) {
  try {
    return JSON.parse(stdout);
  } catch {
    return fallback;
  }
}

function isVpsRepo() {
  return resolve(ROOT) === "/home/ubuntu/meridian-nanocap";
}

function printProof(proof) {
  console.log(JSON.stringify(proof, null, 2));
}

function collectViaSsh() {
  const host = getArg("--host", "ohox");
  const remoteCommand = [
    "export PATH=/home/ubuntu/.nvm/versions/node/v20.20.2/bin:$PATH",
    "cd ~/meridian-nanocap",
    "node scripts/verify-relay-guard-evidence.js --json --direct",
  ].join("; ");
  const result = run("ssh", [host, remoteCommand], {
    cwd: ROOT,
    timeout: 240_000,
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "(no stderr)";
    const stdout = result.stdout?.trim() || "(no stdout)";
    throw new Error(`remote evidence command failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  const proof = parseJson(result.stdout);
  if (!proof) throw new Error("remote evidence command did not print JSON");
  proof.collection_mode = "ssh";
  proof.ssh_host = host;
  return proof;
}

function getGitHead() {
  return runRequired("git", ["rev-parse", "--short", "HEAD"]);
}

function gitContains(baseCommit) {
  const result = run("git", ["merge-base", "--is-ancestor", baseCommit, "HEAD"]);
  return result.status === 0;
}

function chooseExperimentalRemote() {
  const configured = getArg("--experimental-remote", null);
  const candidates = [configured, "private", "origin"].filter(Boolean);
  const fallbacks = [];

  for (const remote of candidates) {
    const result = run("git", ["ls-remote", remote, "experimental"], {
      cwd: ROOT,
      timeout: 60_000,
    });
    if (result.status !== 0 || !result.stdout.trim()) continue;
    const [hash] = result.stdout.trim().split(/\s+/);
    if (hash?.startsWith(EXPERIMENTAL_GUARD_BASE_COMMIT)) {
      return { remote, hash };
    }
    fallbacks.push({ remote, hash });
  }

  if (fallbacks.length > 0) return fallbacks[0];
  throw new Error("no git remote with an experimental branch was reachable");
}

function getPm2Process(name, list) {
  return list.find((entry) => entry?.name === name) || null;
}

function collectPm2() {
  const result = run("pm2", ["jlist"], { timeout: 30_000 });
  const list = result.status === 0 ? parseJson(result.stdout, []) : [];
  const main = getPm2Process("meridian", list);
  const nanocap = getPm2Process("meridian-nanocap", list);
  const startedAtMs = Number(nanocap?.pm2_env?.pm_uptime || 0);

  return {
    pm2_available: result.status === 0,
    pm2_main_status: main?.pm2_env?.status || "unknown",
    pm2_nanocap_status: nanocap?.pm2_env?.status || "unknown",
    pm2_nanocap_pid: nanocap?.pid || null,
    pm2_nanocap_restart_count: nanocap?.pm2_env?.restart_time ?? null,
    guard_runtime_start_time: startedAtMs > 0 ? new Date(startedAtMs).toISOString() : null,
    guardRuntimeStartMs: startedAtMs > 0 ? startedAtMs : null,
  };
}

function readTail(filePath, maxBytes = 2_000_000) {
  if (!fs.existsSync(filePath)) return "";
  const stat = fs.statSync(filePath);
  const length = Math.min(stat.size, maxBytes);
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function listLogFiles() {
  const files = [];
  const localLogs = join(ROOT, "logs");
  if (fs.existsSync(localLogs)) {
    for (const name of fs.readdirSync(localLogs)) {
      if (/^(agent|actions)-\d{4}-\d{2}-\d{2}\.(log|jsonl)$/.test(name)) {
        files.push(join(localLogs, name));
      }
    }
  }

  for (const filePath of [
    "/home/ubuntu/.pm2/logs/meridian-nanocap-out.log",
    "/home/ubuntu/.pm2/logs/meridian-nanocap-error.log",
  ]) {
    if (fs.existsSync(filePath)) files.push(filePath);
  }

  return files.sort();
}

function extractTimeMs(line) {
  const jsonMatch = line.match(/"timestamp"\s*:\s*"([^"]+)"/);
  const bracketMatch = line.match(/\[(\d{4}-\d{2}-\d{2}T[^\]]+Z)\]/);
  const plainMatch = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/);
  const value = jsonMatch?.[1] || bracketMatch?.[1] || plainMatch?.[1] || null;
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function normalizeActionResult(result) {
  if (typeof result === "string") {
    const parsed = parseJson(result, null);
    return parsed || { error: result };
  }
  return result || {};
}

function relayRejectionReason(text) {
  const patterns = [
    /direct SOL transfer from owner/i,
    /missing required account/i,
    /would debit .* SOL from owner/i,
    /would debit unrelated token mint/i,
    /would close\/debit unrelated token mint/i,
    /Relay .* simulation failed/i,
  ];
  const matched = patterns.find((pattern) => pattern.test(text));
  return matched ? matched.source : null;
}

function relayApprovalReasonFromText(text) {
  if (/\[RELAY_GUARD\].*approved/i.test(text)) return "explicit relay guard approval log";
  if (/Relay deployed .* with /i.test(text)) return "relay deploy success after guarded runtime start";
  if (/Relay closed (?:at|position)/i.test(text)) return "relay close success after guarded runtime start";
  return null;
}

function classifyRelayGuardEventsFromText(text, startedAtMs = null, source = "logs") {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const timeMs = extractTimeMs(line);
    if (startedAtMs && timeMs && timeMs < startedAtMs) continue;

    let event = null;
    const trimmed = line.trim();
    if (trimmed.startsWith("{")) {
      const action = parseJson(trimmed, null);
      if (action?.tool === "deploy_position" || action?.tool === "close_position") {
        const result = normalizeActionResult(action.result);
        const serialized = JSON.stringify(result);
        if (result?.success === true && result?.relay === true) {
          event = {
            status: "guard_approved",
            reason: `${action.tool} returned success with relay=true`,
          };
        } else {
          const rejection = relayRejectionReason(serialized);
          if (rejection) {
            event = {
              status: "guard_rejected",
              reason: rejection,
            };
          }
        }
      }
    }

    if (!event) {
      const rejection = relayRejectionReason(line);
      if (rejection) {
        event = {
          status: "guard_rejected",
          reason: rejection,
        };
      }
    }

    if (!event) {
      const approval = relayApprovalReasonFromText(line);
      if (approval) {
        event = {
          status: "guard_approved",
          reason: approval,
        };
      }
    }

    if (event) {
      events.push({
        ...event,
        time_ms: timeMs,
        time: timeMs ? new Date(timeMs).toISOString() : null,
        source,
        sample: line.slice(0, 240),
      });
    }
  }

  const counts = {
    guard_approved: events.filter((event) => event.status === "guard_approved").length,
    guard_rejected: events.filter((event) => event.status === "guard_rejected").length,
  };
  const latest = events
    .slice()
    .sort((a, b) => (b.time_ms || 0) - (a.time_ms || 0))[0] || null;

  return {
    relay_guard_exercise_status: latest?.status || "not_yet_exercised",
    latest_guard_event_time: latest?.time || null,
    latest_guard_event_source: latest?.source || null,
    latest_guard_event_reason: latest?.reason || null,
    guard_event_counts: counts,
  };
}

function classifyRelayGuardEvents(startedAtMs) {
  const files = listLogFiles();
  const combined = files
    .map((filePath) => readTail(filePath))
    .join("\n");
  return {
    ...classifyRelayGuardEventsFromText(combined, startedAtMs, "nanocap logs"),
    scanned_log_files: files.map((filePath) => path.relative(ROOT, filePath).startsWith("..") ? filePath : path.relative(ROOT, filePath)),
  };
}

function proveExperimentalVerifier() {
  const tempRoot = fs.mkdtempSync(join(os.tmpdir(), "meridian-experimental-proof-"));
  const tempRepo = join(tempRoot, "experimental");
  const dependencySource = join(ROOT, "node_modules");
  const cleanup = !args.has("--keep-temp");
  let chosenRemote = null;

  try {
    if (!fs.existsSync(dependencySource)) {
      throw new Error(`missing installed dependencies at ${dependencySource}`);
    }

    chosenRemote = chooseExperimentalRemote();
    runRequired("git", ["fetch", "--quiet", chosenRemote.remote, "experimental:refs/remotes/proof/experimental"], {
      cwd: ROOT,
      timeout: 180_000,
    });
    runRequired("git", ["clone", "--quiet", "--shared", "--no-checkout", ROOT, tempRepo], {
      cwd: ROOT,
      timeout: 120_000,
    });
    runRequired("git", ["fetch", "--quiet", "origin", "refs/remotes/proof/experimental:refs/heads/experimental-proof"], {
      cwd: tempRepo,
      timeout: 120_000,
    });
    runRequired("git", ["checkout", "--quiet", "experimental-proof"], {
      cwd: tempRepo,
      timeout: 120_000,
    });

    fs.symlinkSync(dependencySource, join(tempRepo, "node_modules"), "dir");

    const security = run(process.execPath, ["scripts/verify-upstream-security-hardening.js"], {
      cwd: tempRepo,
      env: { ...process.env, LOG_LEVEL: "error", MERIDIAN_ENVCRYPT_AUTOLOAD: "false" },
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const patches = run(process.execPath, ["scripts/verify-patches.js"], {
      cwd: tempRepo,
      env: { ...process.env, LOG_LEVEL: "error", MERIDIAN_ENVCRYPT_AUTOLOAD: "false" },
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const head = runRequired("git", ["rev-parse", "--short", "HEAD"], { cwd: tempRepo });
    const containsBase = run("git", ["merge-base", "--is-ancestor", EXPERIMENTAL_GUARD_BASE_COMMIT, "HEAD"], {
      cwd: tempRepo,
    }).status === 0;

    return {
      experimental_security_verifier_passed: security.status === 0,
      experimental_patch_verifier_passed: patches.status === 0,
      experimental_security_verifier_exit_code: security.status,
      experimental_patch_verifier_exit_code: patches.status,
      experimental_head: head,
      experimental_guard_base_commit: EXPERIMENTAL_GUARD_BASE_COMMIT,
      experimental_contains_guard_base: containsBase,
      experimental_remote: chosenRemote.remote,
      experimental_remote_head: chosenRemote.hash,
      experimental_dependency_mode: "temporary_checkout_with_current_node_modules_symlink",
      experimental_temp_path: args.has("--keep-temp") ? tempRepo : null,
      experimental_error: security.status === 0 && patches.status === 0 ? null : {
        security_stderr: security.stderr?.trim() || null,
        patches_stderr: patches.stderr?.trim() || null,
      },
    };
  } catch (error) {
    return {
      experimental_security_verifier_passed: false,
      experimental_patch_verifier_passed: false,
      experimental_head: null,
      experimental_guard_base_commit: EXPERIMENTAL_GUARD_BASE_COMMIT,
      experimental_contains_guard_base: false,
      experimental_remote: chosenRemote?.remote || null,
      experimental_remote_head: chosenRemote?.hash || null,
      experimental_dependency_mode: "temporary_checkout_with_current_node_modules_symlink",
      experimental_temp_path: args.has("--keep-temp") ? tempRepo : null,
      experimental_error: error.message,
    };
  } finally {
    if (cleanup) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runSelfTest() {
  const start = Date.parse("2026-04-25T14:05:12.000Z");
  const approved = classifyRelayGuardEventsFromText(
    "[2026-04-25T14:10:00.000Z] [CLOSE] Relay closed position",
    start,
    "self-test",
  );
  const rejected = classifyRelayGuardEventsFromText(
    "[2026-04-25T14:10:00.000Z] [CLOSE_WARN] Relay zap-out close 1 would debit 0.100000 SOL from owner.",
    start,
    "self-test",
  );
  const empty = classifyRelayGuardEventsFromText(
    "[2026-04-25T14:10:00.000Z] [CRON] Starting management cycle",
    start,
    "self-test",
  );

  assert.strictEqual(approved.relay_guard_exercise_status, "guard_approved");
  assert.strictEqual(rejected.relay_guard_exercise_status, "guard_rejected");
  assert.strictEqual(empty.relay_guard_exercise_status, "not_yet_exercised");
  assert.deepStrictEqual(RELAY_STATUS_VALUES, [
    "not_yet_exercised",
    "guard_approved",
    "guard_rejected",
  ]);

  return {
    success: true,
    relay_status_values: RELAY_STATUS_VALUES,
    approved_status: approved.relay_guard_exercise_status,
    rejected_status: rejected.relay_guard_exercise_status,
    empty_status: empty.relay_guard_exercise_status,
  };
}

async function main() {
  if (args.has("--self-test")) {
    printProof(runSelfTest());
    return;
  }

  if (!args.has("--direct") && !isVpsRepo()) {
    printProof(collectViaSsh());
    return;
  }

  const pm2 = collectPm2();
  const relay = classifyRelayGuardEvents(pm2.guardRuntimeStartMs);
  const experimental = args.has("--skip-experimental")
    ? {
        experimental_security_verifier_passed: null,
        experimental_patch_verifier_passed: null,
        experimental_error: "skipped by --skip-experimental",
      }
    : proveExperimentalVerifier();

  const proof = {
    success:
      gitContains(NANOCAP_GUARD_BASE_COMMIT) &&
      pm2.pm2_main_status === "stopped" &&
      pm2.pm2_nanocap_status === "online" &&
      RELAY_STATUS_VALUES.includes(relay.relay_guard_exercise_status) &&
      experimental.experimental_security_verifier_passed === true,
    generated_at: new Date().toISOString(),
    collection_mode: "direct",
    safety: {
      read_only_check: true,
      deploys_or_closes_positions: false,
      restarts_processes: false,
      changes_config: false,
      experimental_verifier_uses_temporary_checkout: true,
    },
    nanocap_head: getGitHead(),
    nanocap_guard_base_commit: NANOCAP_GUARD_BASE_COMMIT,
    nanocap_contains_guard_base: gitContains(NANOCAP_GUARD_BASE_COMMIT),
    pm2_main_status: pm2.pm2_main_status,
    pm2_nanocap_status: pm2.pm2_nanocap_status,
    pm2_nanocap_pid: pm2.pm2_nanocap_pid,
    pm2_nanocap_restart_count: pm2.pm2_nanocap_restart_count,
    guard_runtime_start_time: pm2.guard_runtime_start_time,
    relay_guard_exercise_status: relay.relay_guard_exercise_status,
    latest_guard_event_time: relay.latest_guard_event_time,
    latest_guard_event_source: relay.latest_guard_event_source,
    latest_guard_event_reason: relay.latest_guard_event_reason,
    guard_event_counts: relay.guard_event_counts,
    scanned_log_files: relay.scanned_log_files,
    experimental_security_verifier_passed: experimental.experimental_security_verifier_passed,
    experimental_patch_verifier_passed: experimental.experimental_patch_verifier_passed,
    experimental_head: experimental.experimental_head,
    experimental_guard_base_commit: experimental.experimental_guard_base_commit,
    experimental_contains_guard_base: experimental.experimental_contains_guard_base,
    experimental_dependency_mode: experimental.experimental_dependency_mode,
    experimental_error: experimental.experimental_error,
    requires_operator_review: relay.relay_guard_exercise_status === "guard_rejected",
  };

  printProof(proof);
  if (!proof.success) process.exit(1);
}

main().catch((error) => {
  printProof({
    success: false,
    generated_at: new Date().toISOString(),
    error: error.message,
  });
  process.exit(1);
});
