#!/usr/bin/env node
/**
 * Static proof for operator-facing position range display.
 *
 * This script does not import index.js, start the bot, call trading APIs, or touch runtime files.
 */

import fs from "fs";
import path from "path";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const indexPath = path.join(ROOT, "index.js");
const toolDefinitionsPath = path.join(ROOT, "tools", "definitions.js");
const rangeStatePath = path.join(ROOT, "range-state.js");
const source = fs.readFileSync(indexPath, "utf8");
const toolDefinitions = fs.readFileSync(toolDefinitionsPath, "utf8");
const rangeStateSource = fs.readFileSync(rangeStatePath, "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function extractFunction(src, name) {
  const marker = `function ${name}`;
  const start = src.indexOf(marker);
  assert(start >= 0, `missing ${name}`);
  const paramsEnd = src.indexOf(")", start);
  assert(paramsEnd >= 0, `missing params for ${name}`);
  const bodyStart = src.indexOf("{", paramsEnd);
  assert(bodyStart >= 0, `missing body for ${name}`);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    if (src[i] === "}") depth -= 1;
    if (depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function sliceBetween(src, startNeedle, endNeedle) {
  const start = src.indexOf(startNeedle);
  assert(start >= 0, `missing start marker: ${startNeedle}`);
  const end = src.indexOf(endNeedle, start);
  assert(end >= 0, `missing end marker after ${startNeedle}: ${endNeedle}`);
  return src.slice(start, end);
}

const displayStateHelper = extractFunction(source, "buildPositionDisplayRangeState");
const formatHelper = extractFunction(source, "formatPositionRangeLabel");
const telegramRangeStatusHelper = extractFunction(source, "positionRangeStatus");
// Telegram menu rendering now flows through a plain view-model built by
// toPositionView() (runtime-coupled), which is consumed by the pure
// ./telegram-render.js module. The derived-aware range label is carried into
// the rich cards/detail tabs via that view-model.
const telegramViewModelHelper = extractFunction(source, "toPositionView");
const managementReportBlock = sliceBetween(source, "const reportLines = positionData.map", "const needsAction");
const startupReportBlock = sliceBetween(source, "if (positions.total_positions > 0) {", "console.log(`Top pools");
const cliStatusBlock = sliceBetween(source, "if (input === \"/status\")", "if (input === \"/briefing\")");

assert(source.includes("buildEffectiveRangeStateFromPosition"), "index display helper must use shared effective range-state helper");
assert(rangeStateSource.includes("position.range_side ?? position.derivedRangeSide ?? position.derived_range_side"), "shared helper must prefer already-derived range fields");
assert(rangeStateSource.includes("deriveRangeSide({"), "shared helper must derive from bins when no derived range field exists");
assert(rangeStateSource.includes("sourceInRange !== derivedInRange"), "shared helper must compare API/source and derived range state");
assert(rangeStateSource.includes("isLiveBinSource(active_bin_source)"), "shared helper must require live active-bin provenance");
assert(formatHelper.includes("API lag:"), "format helper must explicitly label source/derived disagreement as API lag telemetry");
assert(formatHelper.includes("API: IN") && formatHelper.includes("API: OOR"), "format helper must preserve source/API state when mismatched");

for (const [name, block] of [
  ["management report", managementReportBlock],
  ["telegram view-model (rich cards + detail tabs)", telegramViewModelHelper],
  ["startup open positions", startupReportBlock],
  ["CLI /status", cliStatusBlock],
]) {
  assert(block.includes("formatPositionRangeLabel("), `${name} must use derived-aware display label`);
}

for (const forbidden of ["executeTool", "closePosition", "close_position", "deploy_position", "updatePnlAndCheckExits"]) {
  assert(!displayStateHelper.includes(forbidden), `display state helper must not call ${forbidden}`);
  assert(!formatHelper.includes(forbidden), `format helper must not call ${forbidden}`);
  assert(!telegramRangeStatusHelper.includes(forbidden), `telegram range status helper must not call ${forbidden}`);
}

const controlPathMarkers = [
  "scheduleStopLossConfirmation(",
  "closeEmergencyDirect(",
  "runOorRepositionAfterConfirmedClose(",
  "const exit = updatePnlAndCheckExits(p.position, p, config.management);",
  "const supertrendExit = await evaluateSupertrendLossExit(",
  "executeTool(\"close_position\"",
  "executeTool(\"deploy_position\"",
];
for (const marker of controlPathMarkers) {
  const index = source.indexOf(marker);
  assert(index >= 0, `missing control path marker: ${marker}`);
  const nearby = source.slice(Math.max(0, index - 500), Math.min(source.length, index + 1000));
  assert(!nearby.includes("formatPositionRangeLabel("), `display formatter must not be used near control path ${marker}`);
  assert(!nearby.includes("buildPositionDisplayRangeState("), `display state helper must not be used near control path ${marker}`);
}

assert(countOccurrences(source, "function buildPositionDisplayRangeState") === 1, "display state helper should have one definition");
assert(countOccurrences(source, "buildPositionDisplayRangeState(") === 3, "display state helper should only be defined and used by display formatters");
assert(countOccurrences(source, "function formatPositionRangeLabel") === 1, "display formatter should have one definition");
assert(countOccurrences(source, "formatPositionRangeLabel(") === 5, "display formatter should only be defined plus four operator-facing display uses (telegram view-model, management report, startup, CLI /status)");
assert(source.includes("If in_range says true but range_side is above_range or below_range"), "startup prompt must warn about API lag telemetry");
assert(toolDefinitions.includes("source/API in-range boolean plus effective derived bin range state"), "get_my_positions tool description must expose source/API vs effective derived range state");
assert(toolDefinitions.includes("API lag telemetry"), "get_my_positions tool description must tell LLM to report API lag telemetry");

console.log(JSON.stringify({
  success: true,
  displayUsesDerivedRangeState: true,
  apiLagLabelVisible: true,
  startupPromptWarnsOnMismatch: true,
  toolDescriptionWarnsOnMismatch: true,
  reportingOnly: true,
  coveredSurfaces: [
    "management report",
    "telegram view-model (rich cards + detail tabs)",
    "startup open positions",
    "CLI /status",
  ],
}, null, 2));
