#!/usr/bin/env node
/**
 * Synthetic/source proof for the scout-only discovery shadow runner.
 *
 * Does not call GMGN, Meteora, wallet, relay, LLM, or trading APIs.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  parseArgs,
  runScoutDiscoveryShadow,
} from "./run-scout-discovery-shadow.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function src(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function makeSyntheticImporter({ failures = new Set(), sourceHistory = [] } = {}) {
  const syntheticConfig = {
    screening: {
      source: "gmgn",
      minMcap: 80_000,
      maxMcap: 3_000_000,
      minTvl: 10_000,
      maxTvl: 300_000,
      minVolume: 15_000,
      minFeeActiveTvlRatio: 0.12,
      minBinStep: 35,
      maxBinStep: 125,
      timeframe: "5m",
      category: "trending",
    },
    indicators: {
      enabled: true,
      entryPreset: "rsi_reversal",
    },
    management: {
      pnlSnapshotBotName: "oracle-scout",
    },
  };

  return async (specifier) => {
    if (specifier === "../envcrypt.js") {
      return {};
    }
    if (specifier === "../config.js") {
      return { config: syntheticConfig };
    }
    if (specifier === "../tools/screening.js") {
      return {
        getTopCandidates: async ({ limit }) => {
          sourceHistory.push(syntheticConfig.screening.source);
          if (failures.has(syntheticConfig.screening.source)) {
            throw new Error(`synthetic ${syntheticConfig.screening.source} failure`);
          }
          return {
            total_eligible: limit,
            total_screened: limit + 2,
            stage_counts: { source: syntheticConfig.screening.source, synthetic: true },
            filtered_examples: [{ name: "FILTERED-SOL", reason: "synthetic reject" }],
            all_filtered: [{ name: "FILTERED-SOL", reason: "synthetic reject" }],
            candidates: Array.from({ length: limit }, (_, index) => ({
              pool: `${index === 0 ? "shared" : syntheticConfig.screening.source}-pool-${index}`,
              name: `${syntheticConfig.screening.source.toUpperCase()}${index}-SOL`,
              base: {
                mint: `${index === 0 ? "shared" : syntheticConfig.screening.source}-mint-${index}`,
                symbol: `${syntheticConfig.screening.source.toUpperCase()}${index}`,
              },
              discovery_source: syntheticConfig.screening.source,
              mcap: 100_000 + index,
              active_tvl: 20_000 + index,
              volume_window: 20_000 + index,
              fee_active_tvl_ratio: 1 + index,
              bin_step: 35,
              volatility: 0.05,
              volatility_timeframe: "30m",
              darwin_score: 50 + index,
            })),
          };
        },
      };
    }
    throw new Error(`unexpected import ${specifier}`);
  };
}

async function withSyntheticImports(importer, fn) {
  const originalImport = globalThis.__MERIDIAN_SCOUT_DISCOVERY_SHADOW_TEST_IMPORT__;
  globalThis.__MERIDIAN_SCOUT_DISCOVERY_SHADOW_TEST_IMPORT__ = importer;
  try {
    return await fn();
  } finally {
    globalThis.__MERIDIAN_SCOUT_DISCOVERY_SHADOW_TEST_IMPORT__ = originalImport;
  }
}

async function main() {
  const scriptSource = src("scripts/run-scout-discovery-shadow.js");
  const decisionContextSource = src("decision-context-log.js");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-scout-discovery-shadow-"));

  const parsed = parseArgs(["--once", "--limit", "4", "--interval-min", "3", "--log-dir", tempDir]);
  assert(parsed.once === true, "parseArgs should set once");
  assert(parsed.limit === 4, "parseArgs should parse limit");
  assert(parsed.intervalMin === 3, "parseArgs should parse interval");

  try {
    const sourceHistory = [];
    const row = await withSyntheticImports(makeSyntheticImporter({ sourceHistory }), () =>
      runScoutDiscoveryShadow({
        limit: 3,
        logDir: tempDir,
        reportPath: path.join(tempDir, "latest.md"),
      })
    );
    const logFiles = fs.readdirSync(tempDir).filter((file) => file.startsWith("scout-discovery-shadow-"));
    assert(row.event === "scout_discovery_shadow", "row event should be scout_discovery_shadow");
    assert(row.bot === "scout/oracle-scout", "row should use scout bot identity");
    assert(row.shadowOnly === true && row.readOnly === true, "row should be read-only shadow");
    assert(row.noDeploy === true && row.noClose === true, "row should explicitly disable deploy/close");
    assert(row.noCooldown === true && row.noRankingMutation === true, "row should explicitly avoid cooldown/ranking mutation");
    assert(row.sources.gmgn.candidateCount === 3, "GMGN synthetic candidates should be counted");
    assert(row.sources.meteora.candidateCount === 3, "Meteora synthetic candidates should be counted");
    assert(row.comparison.poolOverlapCount === 1, "overlap should be computed");
    assert(logFiles.length === 1, "scout JSONL evidence should be written");
    assert(fs.existsSync(path.join(tempDir, "latest.md")), "markdown latest report should be written");
    assert(row.output.logFile.includes("scout-discovery-shadow-"), "log file should be scout-named");
    assert(sourceHistory.join(",") === "gmgn,meteora", "runner should compare GMGN then Meteora");

    const gmgnFailure = await withSyntheticImports(
      makeSyntheticImporter({ failures: new Set(["gmgn"]) }),
      () => runScoutDiscoveryShadow({ limit: 2, logDir: tempDir, reportPath: path.join(tempDir, "gmgn-failure.md") })
    );
    assert(gmgnFailure.activeRuntimeSource === "gmgn", "source should restore after GMGN failure");
    assert(gmgnFailure.sources.gmgn.ok === false, "GMGN failure should be captured as evidence");
    assert(gmgnFailure.sources.meteora.ok === true, "Meteora should still run after GMGN failure");

    const meteoraFailure = await withSyntheticImports(
      makeSyntheticImporter({ failures: new Set(["meteora"]) }),
      () => runScoutDiscoveryShadow({ limit: 2, logDir: tempDir, reportPath: path.join(tempDir, "meteora-failure.md") })
    );
    assert(meteoraFailure.activeRuntimeSource === "gmgn", "source should restore after Meteora failure");
    assert(meteoraFailure.sources.gmgn.ok === true, "GMGN should run before Meteora failure");
    assert(meteoraFailure.sources.meteora.ok === false, "Meteora failure should be captured as evidence");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  assert(scriptSource.includes("runScoutDiscoveryShadow"), "runner should expose scout-specific API");
  assert(scriptSource.includes('SOURCES = Object.freeze(["gmgn", "meteora"])'), "runner should compare GMGN and Meteora");
  assert(scriptSource.includes("scout-discovery-shadow-${todayKey(row.ts)}.jsonl"), "runner should write scout-named JSONL");
  assert(scriptSource.includes("latest_scout_discovery_shadow.md"), "runner should write scout-named latest report");
  assert(scriptSource.includes('loadModule("../envcrypt.js")'), "runner should load local env only during actual shadow use");
  assert(scriptSource.includes("MERIDIAN_SHADOW_DISABLE_DECISION_CONTEXT"), "runner should suppress decision-context side writes");
  assert(scriptSource.includes("noDeploy: true"), "runner should label noDeploy evidence");
  assert(scriptSource.includes("noClose: true"), "runner should label noClose evidence");
  assert(scriptSource.includes("noCooldown: true"), "runner should label noCooldown evidence");
  assert(scriptSource.includes("noRankingMutation: true"), "runner should label noRankingMutation evidence");
  for (const forbidden of ["deploy_position", "close_position", "deployPosition", "closePosition", "pm2", "PM2", "agentLoop("]) {
    assert(!scriptSource.includes(forbidden), `runner must not include ${forbidden}`);
  }
  assert(decisionContextSource.includes("MERIDIAN_SHADOW_DISABLE_DECISION_CONTEXT"), "decision-context side writes can be disabled for shadow runs");

  console.log(JSON.stringify({
    success: true,
    checks: [
      "parses CLI options",
      "runs synthetic scout GMGN/Meteora comparison",
      "writes scout-named append-only JSONL and latest Markdown",
      "marks evidence read-only/no-deploy/no-close/no-cooldown/no-ranking-mutation",
      "restores source after GMGN and Meteora failures",
      "source scan finds no deploy/close/PM2/agent-loop calls",
      "decision-context writes are suppressible for shadow process",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ success: false, error: error.message }, null, 2));
  process.exit(1);
});
