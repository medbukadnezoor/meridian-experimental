#!/usr/bin/env node

import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "hivemind.js"), "utf8");

assert.ok(
  source.includes('mode === "disabled"') &&
    source.includes('mode === "off"') &&
    source.includes('mode === "false"'),
  "HiveMind pull mode should preserve explicit disabled/off/false values",
);
assert.ok(
  source.includes('if (getPullMode() === "disabled") return false;') &&
    source.includes("return !!(getBaseUrl() && getApiKey())"),
  "HiveMind enabled check should be false when pull mode is disabled, even if URL/API key are present",
);

console.log(JSON.stringify({
  success: true,
  checks: [
    "hiveMindPullMode disabled/off/false remains disabled",
    "isHiveMindEnabled returns false before URL/API-key checks when disabled",
  ],
}));
