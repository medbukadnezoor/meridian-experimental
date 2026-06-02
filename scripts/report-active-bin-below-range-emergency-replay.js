#!/usr/bin/env node
import {
  DEFAULT_BELOW_RANGE_JSON,
  DEFAULT_BELOW_RANGE_MD,
  DEFAULT_FROM,
  DEFAULT_LOGS_DIR,
  DEFAULT_TO,
  buildTailLossReport,
  parseArgs,
  renderBelowRangeMarkdown,
  writeJsonAndMarkdown,
} from "./scout-tail-loss-lib.js";

const args = parseArgs();
const tail = buildTailLossReport({
  logsDir: args["logs-dir"] ?? DEFAULT_LOGS_DIR,
  from: args.from ?? DEFAULT_FROM,
  to: args.to ?? DEFAULT_TO,
});

const report = {
  generatedAt: new Date().toISOString(),
  evidenceWindow: tail.evidenceWindow,
  status: "replay_only_live_close_disabled",
  recommendation: "below_range_alone_not_safe",
  belowRangeCases: tail.positions.filter((p) => p.firstBelowRangeRow),
  replay: {
    activeBinBelowRange: tail.replay.activeBinBelowRange,
  },
  seedCases: {
    yaeSecondLap: tail.seedStatus.yaeSecondLap,
    dustCounterexamples: tail.positions
      .filter((p) => p.pair === "Dust-SOL" && p.firstBelowRangeRow)
      .map((p) => ({
        position: p.position,
        firstBelowRangePnlPct: p.firstBelowRangeRow.nearestPnlPct ?? p.firstBelowRangeRow.pnlPct,
        finalPnlPct: p.finalPnlPct,
        row: p.firstBelowRangeRow,
      })),
  },
};

writeJsonAndMarkdown({
  report,
  jsonPath: args["out-json"] ?? DEFAULT_BELOW_RANGE_JSON,
  markdownPath: args["out-md"] ?? DEFAULT_BELOW_RANGE_MD,
  renderMarkdown: renderBelowRangeMarkdown,
});

console.log(JSON.stringify({
  status: report.status,
  recommendation: report.recommendation,
  markdown: args["out-md"] ?? DEFAULT_BELOW_RANGE_MD,
  json: args["out-json"] ?? DEFAULT_BELOW_RANGE_JSON,
  belowRangeCases: report.belowRangeCases.length,
  yaeSecondLap: report.seedCases.yaeSecondLap,
  dustCounterexamples: report.seedCases.dustCounterexamples.length,
}, null, 2));
