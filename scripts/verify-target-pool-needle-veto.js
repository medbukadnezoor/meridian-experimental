#!/usr/bin/env node
import assert from "assert";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { buildConfig } from "../config-builder.js";
import { evaluateTargetPoolNeedleVetoShadow } from "../target-pool-needle-veto-shadow.js";
import {
  applyScoutTailLossShadowDecisions,
  evaluateTargetPoolNeedleDeployGuard,
} from "../tools/screening.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const candidate = {
  pool: "targetPool",
  pool_address: "targetPool",
  name: "NEEDLE-SOL",
  base: { mint: "needleMint", symbol: "NEEDLE" },
  quote: { mint: "So11111111111111111111111111111111111111112", symbol: "SOL" },
};
const decisivePoolEvidence = {
  source: "geckoterminal",
  decisiveEvidence: "pool_specific",
  aggregateMin: 1,
  lookbackMinutes: 60,
  rowCount: 12,
  windowRowCount: 12,
  entryPrice: 1,
  currentPrice: 0.48,
  highPrice: 2,
  lowPrice: 0.45,
  highDrawdownPct: -76,
  peakRetracePct: -77.5,
  highRunupPct: 100,
  highLowRangePct: 344.44444444444446,
  tokenContext: {
    source: "birdeye",
    contextOnly: true,
    rowCount: 12,
  },
};

const defaultConfig = buildConfig({}, {}).screening;
assert.equal(defaultConfig.targetPoolNeedleVetoShadowEnabled, true, "target-pool needle shadow defaults on");
assert.equal(defaultConfig.targetPoolNeedleVetoLiveEnabled, false, "target-pool needle live defaults off");
assert.equal(defaultConfig.targetPoolNeedleVetoShortlistLimit, 3, "target-pool needle shortlist defaults to 3");
assert.deepEqual(defaultConfig.targetPoolNeedleVetoLiveReasonCodes, ["target_pool_high_needle_retrace"]);

const nestedConfig = buildConfig({
  screening: {
    targetPoolNeedleVetoLiveEnabled: true,
    targetPoolNeedleVetoMinHighRunupPct: 70,
    targetPoolNeedleVetoLiveReasonCodes: ["not_the_needle_reason"],
  },
}, {}).screening;
assert.equal(nestedConfig.targetPoolNeedleVetoLiveEnabled, true, "nested target-pool config resolves");
assert.equal(nestedConfig.targetPoolNeedleVetoMinHighRunupPct, 70, "nested numeric target-pool config resolves");

const missing = evaluateTargetPoolNeedleVetoShadow(candidate, {
  ohlcv: null,
  config: {
    targetPoolNeedleVetoLiveEnabled: true,
    targetPoolNeedleVetoLiveReasonCodes: ["target_pool_high_needle_retrace"],
  },
});
assert.equal(missing.decision, "missing_evidence", "missing target-pool evidence is audit-only");
assert.equal(missing.shadowOnly, true, "missing evidence stays shadow-only");

const shadowNeedle = evaluateTargetPoolNeedleVetoShadow(candidate, {
  ohlcv: decisivePoolEvidence,
  config: defaultConfig,
});
assert.equal(shadowNeedle.decision, "would_block", "default target-pool needle policy shadows the veto");
assert.equal(shadowNeedle.ohlcv.source, "geckoterminal", "pool-specific OHLCV is preserved as decisive evidence");
assert.equal(shadowNeedle.ohlcv.highDrawdownPct, -76, "pool-specific drawdown drives the decision");
assert.equal(shadowNeedle.ohlcv.peakRetracePct, -77.5, "pool-specific wick retrace is preserved");

const preWindowPumpNeedle = evaluateTargetPoolNeedleVetoShadow(candidate, {
  ohlcv: {
    ...decisivePoolEvidence,
    entryPrice: 1.8,
    currentPrice: 1.02,
    highPrice: 2,
    lowPrice: 0.45,
    highDrawdownPct: -49,
    highRunupPct: 11.111111111111116,
    peakRetracePct: -77.5,
    highLowRangePct: 344.44444444444446,
  },
  config: defaultConfig,
});
assert.equal(preWindowPumpNeedle.decision, "would_block", "high-to-low target-pool wick catches pre-window pump retrace");

const liveNeedle = evaluateTargetPoolNeedleVetoShadow(candidate, {
  ohlcv: decisivePoolEvidence,
  config: {
    ...defaultConfig,
    targetPoolNeedleVetoLiveEnabled: true,
    targetPoolNeedleVetoLiveReasonCodes: ["target_pool_high_needle_retrace"],
  },
});
assert.equal(liveNeedle.decision, "blocked", "live allow-listed needle reason blocks");
assert.equal(liveNeedle.shadowOnly, false, "live allow-listed block is not shadow-only");

const liveNotAllowListed = evaluateTargetPoolNeedleVetoShadow(candidate, {
  ohlcv: decisivePoolEvidence,
  config: {
    ...defaultConfig,
    targetPoolNeedleVetoLiveEnabled: true,
    targetPoolNeedleVetoLiveReasonCodes: ["different_reason"],
  },
});
assert.equal(liveNotAllowListed.decision, "would_block", "non allow-listed needle reason stays shadow");

const runtimeShadowCandidate = {
  ...candidate,
  target_pool_ohlcv_evidence: decisivePoolEvidence,
};
const runtimeShadowAccepted = applyScoutTailLossShadowDecisions([runtimeShadowCandidate], defaultConfig, {
  closeRecords: [],
  appendContext: false,
});
assert.equal(runtimeShadowAccepted.length, 1, "shadow target-pool needle decision does not filter finalist");
assert.equal(runtimeShadowCandidate.target_pool_needle_veto_shadow.decision, "would_block");

const runtimeLiveCandidate = {
  ...candidate,
  target_pool_ohlcv_evidence: decisivePoolEvidence,
};
const runtimeLiveAccepted = applyScoutTailLossShadowDecisions([runtimeLiveCandidate], {
  ...defaultConfig,
  targetPoolNeedleVetoLiveEnabled: true,
  targetPoolNeedleVetoLiveReasonCodes: ["target_pool_high_needle_retrace"],
}, {
  closeRecords: [],
  appendContext: false,
});
assert.equal(runtimeLiveAccepted.length, 0, "live target-pool needle block filters finalist");

const deployGuardCandidate = {
  ...candidate,
  target_pool_ohlcv_evidence: decisivePoolEvidence,
};
const deployGuard = await evaluateTargetPoolNeedleDeployGuard(deployGuardCandidate, {
  ...defaultConfig,
  targetPoolNeedleVetoLiveEnabled: true,
  targetPoolNeedleVetoLiveReasonCodes: ["target_pool_high_needle_retrace"],
}, {
  appendContext: false,
});
assert.equal(deployGuard.decision, "blocked", "last-chance deploy guard returns live block");

const ohlcvSource = readFileSync(join(ROOT, "ohlcv-drawdown-shadow.js"), "utf8");
const screeningSource = readFileSync(join(ROOT, "tools", "screening.js"), "utf8");
const indexSource = readFileSync(join(ROOT, "index.js"), "utf8");
const executorSource = readFileSync(join(ROOT, "tools", "executor.js"), "utf8");
const configSource = readFileSync(join(ROOT, "config.js"), "utf8");

assert(ohlcvSource.includes("fetchTargetPoolOhlcv"), "production target-pool OHLCV helper exists");
assert(ohlcvSource.includes("poolSpecific"), "target-pool helper names pool-specific evidence");
assert(ohlcvSource.includes("decisiveEvidence: \"pool_specific\""), "target-pool helper marks decisive pool evidence");
assert(ohlcvSource.includes("TOKEN_CONTEXT_TIMEOUT_MS"), "context-only token OHLCV has a short timeout");
assert(ohlcvSource.includes("if (windowRows.length === 0) return null"), "stale-only target-pool OHLCV becomes missing evidence");
assert(ohlcvSource.includes("peakRetracePct"), "target-pool helper emits high-to-low wick retrace evidence");
assert(!screeningSource.includes("__test"), "production screening does not import test-only OHLCV helpers");
assert(screeningSource.includes("attachTargetPoolOhlcvEvidence("), "target-pool evidence fetch is wired");
assert(screeningSource.includes("const rankedBeforeTailLoss = rankCandidatesByDarwin(eligible)"), "Darwin ranking happens before target-pool OHLCV fetch");
assert(screeningSource.includes("targetPoolNeedleVetoShortlistLimit"), "target-pool evidence fetch is bounded by shortlist config");
assert(screeningSource.includes("rankedBeforeTailLoss.slice(0, targetPoolNeedleShortlistLimit)"), "only the target-pool shortlist gets OHLCV evidence");
assert(screeningSource.includes("deploy_guard_target_pool_needle"), "deploy guard decision-context logging is wired");
assert(indexSource.includes("evaluateTargetPoolNeedleDeployGuard"), "cached deploy path has last-chance guard");
assert(executorSource.includes("evaluateTargetPoolNeedleDeployGuard"), "direct deploy tool has last-chance guard");
assert(configSource.includes("freshScreening.targetPoolNeedleVetoLiveEnabled"), "hot reload reads nested target-pool keys");

console.log(JSON.stringify({
  ok: true,
  checks: [
    "target-pool needle shadow defaults on/live off",
    "nested config-builder keys resolve",
    "missing target-pool evidence never live-blocks",
    "pool-specific OHLCV is decisive; token context is context-only",
    "pre-window pump retrace is caught by high-to-low target-pool wick evidence",
    "stale-only rows and slow context-only token data do not become decisive evidence",
    "target-pool evidence fetch is limited to Darwin-ranked shortlist",
    "live allow-list is required to block",
    "finalist screening rejects only live allow-listed decisions",
    "last-chance deploy guard returns and logs the same decision family",
    "production code does not import __test OHLCV helpers",
  ],
  sampleDecisions: { missing, shadowNeedle, preWindowPumpNeedle, liveNeedle, liveNotAllowListed, deployGuard },
}, null, 2));
