#!/usr/bin/env node
import fs from "fs";
import path from "path";
import {
  DEFAULT_FROM,
  DEFAULT_LOGS_DIR,
  DEFAULT_OHLCV_SHADOW_JSON,
  DEFAULT_TO,
  buildTailLossReport,
  parseArgs,
} from "./scout-tail-loss-lib.js";

const args = parseArgs();
const tail = buildTailLossReport({
  logsDir: args["logs-dir"] ?? DEFAULT_LOGS_DIR,
  from: args.from ?? DEFAULT_FROM,
  to: args.to ?? DEFAULT_TO,
});

const report = {
  generatedAt: new Date().toISOString(),
  status: "shadow_only_default_off_for_live_blocking",
  warning: "do not use blunt high-drawdown veto",
  evidenceWindow: tail.evidenceWindow,
  sourceTailLossArtifact: args["tail-json"] ?? null,
  variants: tail.replay.ohlcvCompoundEntryVeto,
  counterexamples: tail.positions
    .filter((p) => p.finalPnlPct > 0 && p.ageZeroOhlcv?.highDrawdownPct <= -35)
    .map((p) => ({
      pair: p.pair,
      position: p.position,
      finalPnlPct: p.finalPnlPct,
      ageZeroHighDrawdownPct: p.ageZeroOhlcv.highDrawdownPct,
    })),
};

const outJson = args["out-json"] ?? DEFAULT_OHLCV_SHADOW_JSON;
fs.mkdirSync(path.dirname(outJson), { recursive: true });
fs.writeFileSync(outJson, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  status: report.status,
  json: outJson,
  counterexamples: report.counterexamples.length,
  variants: report.variants.length,
}, null, 2));
