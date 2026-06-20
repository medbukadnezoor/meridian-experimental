#!/usr/bin/env node
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.join(__dirname, "..");

/** Safely parse JSON without leaking raw text (which may contain secrets) into error messages. */
function safeParseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function usage() {
  console.log(`Usage:
  node scripts/rotate-helius-key.js --backup-key-env HELIUS_API_KEY_BACKUP --apply --restart
  node scripts/rotate-helius-key.js --backup-key-file /secure/path/helius-key.txt --apply

Defaults to dry-run. The script never prints key values.

Options:
  --root <dir>              Project root containing .env and user-config.json
  --backup-key-env <name>   Env var containing the replacement Helius API key
  --backup-key-file <path>  File containing only the replacement Helius API key
  --old-key-env <name>      Optional env var containing key to replace
  --old-key-file <path>     Optional file containing key to replace
  --apply                   Write changes after making timestamped backups
  --restart                 After --apply, restart meridian and main balance tracker
  --pm2-bin <path>          pm2 binary, default: pm2
  --help                    Show this help
`);
}

function parseArgs(argv) {
  const args = {
    root: DEFAULT_ROOT,
    backupKeyEnv: null,
    backupKeyFile: null,
    oldKeyEnv: null,
    oldKeyFile: null,
    apply: false,
    restart: false,
    pm2Bin: "pm2",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else if (arg === "--apply") {
      args.apply = true;
    } else if (arg === "--restart") {
      args.restart = true;
    } else if (arg === "--root") {
      args.root = requireValue(argv, ++i, arg);
    } else if (arg === "--backup-key-env") {
      args.backupKeyEnv = requireValue(argv, ++i, arg);
    } else if (arg === "--backup-key-file") {
      args.backupKeyFile = requireValue(argv, ++i, arg);
    } else if (arg === "--old-key-env") {
      args.oldKeyEnv = requireValue(argv, ++i, arg);
    } else if (arg === "--old-key-file") {
      args.oldKeyFile = requireValue(argv, ++i, arg);
    } else if (arg === "--pm2-bin") {
      args.pm2Bin = requireValue(argv, ++i, arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function readSecretFromEnv(name, label) {
  if (!name) return null;
  const value = process.env[name];
  if (!value) throw new Error(`${label} env var ${name} is not set`);
  return value.trim();
}

function readSecretFromFile(file, label) {
  if (!file) return null;
  return fs.readFileSync(file, "utf8").trim();
}

function readSecret({ envName, file, label }) {
  const fromEnv = readSecretFromEnv(envName, label);
  const fromFile = readSecretFromFile(file, label);
  if (fromEnv && fromFile && fromEnv !== fromFile) {
    throw new Error(`${label} was provided by env and file but values differ`);
  }
  return fromEnv || fromFile;
}

function parseDotenv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]] = stripQuotes(match[2].trim());
  }
  return values;
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function keyFromUrl(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.searchParams.get("api-key");
  } catch {
    return null;
  }
}

function walkJson(value, visitor, pathParts = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkJson(item, visitor, pathParts.concat(String(index))));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      visitor(key, child, pathParts.concat(key));
      walkJson(child, visitor, pathParts.concat(key));
    }
  }
}

function discoverOldKeys({ envText, configText, explicitOldKey }) {
  const keys = new Set();
  if (explicitOldKey) keys.add(explicitOldKey);

  const envValues = parseDotenv(envText);
  for (const name of ["HELIUS_API_KEY"]) {
    if (envValues[name]) keys.add(envValues[name]);
  }
  for (const name of ["RPC_URL", "HELIUS_RPC_URL"]) {
    const key = keyFromUrl(envValues[name]);
    if (key) keys.add(key);
  }

  const config = JSON.parse(configText);
  walkJson(config, (key, value) => {
    if (typeof value !== "string") return;
    if (/helius|rpc/i.test(key)) {
      const urlKey = keyFromUrl(value);
      if (urlKey) keys.add(urlKey);
    }
    if (/helius.*api.*key|api.*key.*helius/i.test(key)) {
      keys.add(value);
    }
  });

  return [...keys].filter(isPlausibleKey);
}

function isPlausibleKey(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < 16) return false;
  if (/your_|fill_|example|placeholder/i.test(trimmed)) return false;
  if (/^env:/i.test(trimmed)) return false;
  return true;
}

function replaceAllSecrets(text, oldKeys, newKey) {
  let next = text;
  const changedKeys = [];
  for (const oldKey of oldKeys) {
    if (oldKey === newKey) continue;
    if (next.includes(oldKey)) {
      next = next.split(oldKey).join(newKey);
      changedKeys.push(oldKey);
    }
  }
  return { text: next, changedKeys };
}

function backupFile(file, stamp) {
  const backup = `${file}.pre-helius-rotate-${stamp}`;
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  return backup;
}

function runPm2(pm2Bin) {
  const commands = [
    [pm2Bin, ["restart", "meridian", "--update-env"]],
    [pm2Bin, ["restart", "meridian-main-sol-balance-tracker", "--update-env"]],
    [pm2Bin, ["save", "--force"]],
  ];
  for (const [cmd, args] of commands) {
    execFileSync(cmd, args, { stdio: "inherit" });
  }
}

function main() {
  const args = parseArgs(process.argv);
  const root = path.resolve(args.root);
  const envPath = path.join(root, ".env");
  const configPath = path.join(root, "user-config.json");

  if (!fs.existsSync(envPath)) throw new Error(`Missing ${envPath}`);
  if (!fs.existsSync(configPath)) throw new Error(`Missing ${configPath}`);

  const newKey = readSecret({
    envName: args.backupKeyEnv,
    file: args.backupKeyFile,
    label: "backup key",
  });
  if (!isPlausibleKey(newKey)) {
    throw new Error("Backup key is missing or does not look like a real API key");
  }

  const explicitOldKey = readSecret({
    envName: args.oldKeyEnv,
    file: args.oldKeyFile,
    label: "old key",
  });
  if (explicitOldKey && !isPlausibleKey(explicitOldKey)) {
    throw new Error("Old key was provided but does not look like a real API key");
  }

  const envText = fs.readFileSync(envPath, "utf8");
  const configText = fs.readFileSync(configPath, "utf8");
  safeParseJson(configText, "user-config.json");

  const oldKeys = discoverOldKeys({ envText, configText, explicitOldKey });
  if (oldKeys.length === 0) throw new Error("No existing Helius key material found to rotate");

  const envResult = replaceAllSecrets(envText, oldKeys, newKey);
  const configResult = replaceAllSecrets(configText, oldKeys, newKey);
  safeParseJson(configResult.text, "user-config.json (post-replace)");

  const envChanged = envResult.text !== envText;
  const configChanged = configResult.text !== configText;
  const changedFiles = [
    envChanged ? ".env" : null,
    configChanged ? "user-config.json" : null,
  ].filter(Boolean);

  console.log(`Mode: ${args.apply ? "apply" : "dry-run"}`);
  console.log(`Root: ${root}`);
  console.log(`Discovered old key candidate(s): ${oldKeys.length}`);
  console.log(`Files that would change: ${changedFiles.length ? changedFiles.join(", ") : "none"}`);
  console.log(`Restart requested: ${args.restart ? "yes" : "no"}`);

  if (!envChanged && !configChanged) {
    console.log("No file changes needed.");
    return;
  }
  if (!args.apply) {
    console.log("Dry-run only. Re-run with --apply to write backups and rotate.");
    return;
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
  const backups = [];
  if (envChanged) {
    backups.push(backupFile(envPath, stamp));
    fs.writeFileSync(envPath, envResult.text, "utf8");
  }
  if (configChanged) {
    backups.push(backupFile(configPath, stamp));
    fs.writeFileSync(configPath, configResult.text, "utf8");
  }

  safeParseJson(fs.readFileSync(configPath, "utf8"), "user-config.json (post-write)");
  console.log(`Rotated Helius key material in ${changedFiles.join(", ")}.`);
  console.log(`Backups created: ${backups.map((file) => path.basename(file)).join(", ")}`);

  if (args.restart) {
    runPm2(args.pm2Bin);
    console.log("PM2 restart complete.");
  } else {
    console.log("Restart skipped. Run PM2 restart separately or re-run with --restart.");
  }
}

try {
  main();
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
}
