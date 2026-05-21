#!/usr/bin/env node
import {
  DEFAULT_FROM,
  DEFAULT_LOGS_DIR,
  DEFAULT_REPORT_JSON,
  DEFAULT_REPORT_MD,
  DEFAULT_TO,
  buildTailLossReport,
  parseArgs,
  renderTailLossMarkdown,
  writeJsonAndMarkdown,
} from "./scout-tail-loss-lib.js";

const args = parseArgs();
const report = buildTailLossReport({
  logsDir: args["logs-dir"] ?? DEFAULT_LOGS_DIR,
  from: args.from ?? DEFAULT_FROM,
  to: args.to ?? DEFAULT_TO,
});

writeJsonAndMarkdown({
  report,
  jsonPath: args["out-json"] ?? DEFAULT_REPORT_JSON,
  markdownPath: args["out-md"] ?? DEFAULT_REPORT_MD,
  renderMarkdown: renderTailLossMarkdown,
});

console.log(JSON.stringify({
  status: report.reportStatus,
  markdown: args["out-md"] ?? DEFAULT_REPORT_MD,
  json: args["out-json"] ?? DEFAULT_REPORT_JSON,
  deploys: report.positions.filter((p) => p.deployTs).length,
  closes: report.positions.filter((p) => p.closeTs).length,
  ballsackdorkl: report.seedStatus.ballsackdorkl,
  yaeSecondLap: report.seedStatus.yaeSecondLap,
}, null, 2));
