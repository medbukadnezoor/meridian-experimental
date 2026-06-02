#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  buildSwapExposureSummary,
  loadSwapExposureRows,
} from "../swap-exposure-observer.js";

function parseArgs(argv) {
  const options = {
    logDir: "logs",
    reportsDir: "reports",
    dataDir: path.join("..", "meridian-intelligence", "data", "processed"),
    json: false,
    noWrite: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--no-write") {
      options.noWrite = true;
      continue;
    }
    if (arg === "--log-dir" || arg === "--reports-dir" || arg === "--data-dir") {
      if (!next) throw new Error(`Missing value for ${arg}`);
      if (arg === "--log-dir") options.logDir = next;
      if (arg === "--reports-dir") options.reportsDir = next;
      if (arg === "--data-dir") options.dataDir = next;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function rowLine(row) {
  const trace = row.swap_trace || {};
  return [
    `| ${row.ts || ""}`,
    row.trace_source || "",
    row.pair || row.residual_symbol || "",
    row.post_close_swap_status || row.verifier_verdict || "",
    trace.router || "",
    trace.mode || "",
    trace.price_impact_bps ?? "",
    trace.value_leak_bps ?? "",
    trace.value_leak_usd ?? "",
    row.tx || trace.execute?.signature || "",
    "|",
  ].join(" | ");
}

export function buildMarkdown(summary) {
  const lines = [
    "# Swap Exposure Observer",
    "",
    `Generated: ${summary.generatedAt}`,
    "",
    "## Summary",
    `- Post-close swap trace rows: ${summary.postCloseTraceCount}`,
    `- Residual quote-only rows: ${summary.residualQuoteCount}`,
    `- Manual/external suspected residual rows: ${summary.residualManualSuspectedCount}`,
    `- Malformed lines: ${summary.malformedLineCount}`,
    "",
    "## Router Breakdown",
    summary.routerBreakdown.length ? summary.routerBreakdown.map((row) => `- ${row.key}: ${row.count}`).join("\n") : "- none",
    "",
    "## Mode Breakdown",
    summary.modeBreakdown.length ? summary.modeBreakdown.map((row) => `- ${row.key}: ${row.count}`).join("\n") : "- none",
    "",
    "## Worst Executed Swaps by Value Leak",
    "| ts | source | pair/token | status | router | mode | price impact bps | value leak bps | value leak usd | tx |",
    "| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |",
    ...(summary.worstExecutedByValueLeakBps.length ? summary.worstExecutedByValueLeakBps.map(rowLine) : ["| none | | | | | | | | | |"]),
    "",
    "## Worst Residual Quote-Only Rows by Price Impact",
    "| ts | source | pair/token | status | router | mode | price impact bps | value leak bps | value leak usd | tx |",
    "| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |",
    ...(summary.worstResidualQuotesByPriceImpactBps.length ? summary.worstResidualQuotesByPriceImpactBps.map(rowLine) : ["| none | | | | | | | | | |"]),
    "",
    "Observation only: these rows do not change close, swap, deploy, screening, cooldown, or quarantine behavior.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export function buildReport({ logDir = "logs" } = {}) {
  const rows = loadSwapExposureRows({ logDir });
  const summary = buildSwapExposureSummary(rows);
  return { summary, markdown: buildMarkdown(summary) };
}

function writeFile(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

export function maybeWriteSwapExposureReport({ logDir = "logs", reportsDir = "reports" } = {}) {
  const report = buildReport({ logDir });
  writeFile(path.join(reportsDir, "latest_swap_exposure_observer.md"), report.markdown);
  return report;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = buildReport({ logDir: options.logDir });
  if (!options.noWrite) {
    maybeWriteSwapExposureReport({ logDir: options.logDir, reportsDir: options.reportsDir });
    writeFile(path.join(options.dataDir, "latest_swap_exposure_observer.json"), `${JSON.stringify(report.summary, null, 2)}\n`);
  }
  console.log(options.json ? JSON.stringify(report.summary, null, 2) : report.markdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}
