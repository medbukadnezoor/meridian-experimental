#!/usr/bin/env node
/**
 * Synthetic/source proof for the read-only candidate funnel shadow runner.
 *
 * Does not call GMGN, Meteora, wallet, relay, LLM, or trading APIs.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  parseArgs,
  runCandidateFunnelShadow,
} from "./run-candidate-funnel-shadow.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function src(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

async function main() {
  const scriptSource = src("scripts/run-candidate-funnel-shadow.js");
  const decisionContextSource = src("decision-context-log.js");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-candidate-shadow-"));

  const parsed = parseArgs(["--once", "--limit", "4", "--interval-min", "3", "--log-dir", tempDir]);
  assert(parsed.once === true, "parseArgs should set once");
  assert(parsed.limit === 4, "parseArgs should parse limit");
  assert(parsed.intervalMin === 3, "parseArgs should parse interval");

  const originalImport = globalThis.__MERIDIAN_CANDIDATE_SHADOW_TEST_IMPORT__;
  globalThis.__MERIDIAN_CANDIDATE_SHADOW_TEST_IMPORT__ = async (specifier) => {
    if (specifier === "../config.js") {
      return {
        config: {
          screening: {
            source: "gmgn",
            minMcap: 30_000,
            maxMcap: 600_000,
            minTvl: 10_000,
            maxTvl: 300_000,
            minVolume: 1000,
            minFeeActiveTvlRatio: 0.19,
            minBinStep: 50,
            maxBinStep: 250,
            timeframe: "5m",
            category: "trending",
          },
          indicators: {
            enabled: true,
            entryPreset: "rsi_reversal",
          },
          management: {
            pnlSnapshotBotName: "nanocap",
          },
        },
      };
    }
    if (specifier === "../tools/screening.js") {
      return {
        getTopCandidates: async ({ limit }) => ({
          total_eligible: limit,
          total_screened: limit + 2,
          stage_counts: { source: "synthetic" },
          filtered_examples: [{ name: "FILTERED-SOL", reason: "synthetic reject" }],
          all_filtered: [{ name: "FILTERED-SOL", reason: "synthetic reject" }],
          candidates: Array.from({ length: limit }, (_, index) => ({
            pool: `${index === 0 ? "shared" : "pool"}-${index}`,
            name: `CAND${index}-SOL`,
            base: { mint: `${index === 0 ? "shared" : "mint"}-${index}`, symbol: `CAND${index}` },
            discovery_source: "synthetic",
            mcap: 100_000 + index,
            active_tvl: 20_000 + index,
            volume_window: 5_000 + index,
            fee_active_tvl_ratio: 1 + index,
            bin_step: 85,
            volatility: 0.05,
            darwin_score: 50 + index,
          })),
        }),
      };
    }
    throw new Error(`unexpected import ${specifier}`);
  };

  try {
    const row = await runCandidateFunnelShadow({
      limit: 3,
      logDir: tempDir,
      reportPath: path.join(tempDir, "latest.md"),
    });
    const logFiles = fs.readdirSync(tempDir).filter((file) => file.startsWith("candidate-funnel-shadow-"));
    assert(row.event === "candidate_funnel_shadow", "row event should be candidate_funnel_shadow");
    assert(row.shadowOnly === true && row.readOnly === true, "row should be read-only shadow");
    assert(row.noDeploy === true && row.noClose === true, "row should explicitly disable deploy/close");
    assert(row.sources.gmgn.candidateCount === 3, "GMGN synthetic candidates should be counted");
    assert(row.sources.meteora.candidateCount === 3, "Meteora synthetic candidates should be counted");
    assert(row.comparison.poolOverlapCount === 3, "overlap should be computed");
    assert(logFiles.length === 1, "JSONL evidence should be written");
    assert(fs.existsSync(path.join(tempDir, "latest.md")), "markdown latest report should be written");
  } finally {
    globalThis.__MERIDIAN_CANDIDATE_SHADOW_TEST_IMPORT__ = originalImport;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  assert(scriptSource.includes("getTopCandidates"), "runner should reuse normal candidate gates");
  assert(scriptSource.includes('SOURCES = Object.freeze(["gmgn", "meteora"])'), "runner should compare GMGN and Meteora");
  assert(scriptSource.includes("candidate-funnel-shadow-${todayKey(row.ts)}.jsonl"), "runner should write candidate-funnel JSONL");
  assert(scriptSource.includes("noDeploy: true"), "runner should label noDeploy evidence");
  assert(scriptSource.includes("noClose: true"), "runner should label noClose evidence");
  assert(!scriptSource.includes("deploy_position"), "runner must not call deploy_position");
  assert(!scriptSource.includes("close_position"), "runner must not call close_position");
  assert(decisionContextSource.includes("MERIDIAN_SHADOW_DISABLE_DECISION_CONTEXT"), "decision-context side writes can be disabled for shadow runs");

  console.log(JSON.stringify({
    success: true,
    checks: [
      "parses CLI options",
      "runs synthetic GMGN/Meteora comparison",
      "writes append-only JSONL and latest Markdown",
      "marks evidence read-only/no-deploy/no-close",
      "source scan finds no deploy/close calls",
      "decision-context writes are suppressible for shadow process",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ success: false, error: error.message }, null, 2));
  process.exit(1);
});
