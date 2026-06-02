#!/usr/bin/env node
import assert from "assert";
import { evaluateSamePoolPostWinDecay } from "../post-win-decay-gate.js";
import { applyScoutTailLossShadowDecisions } from "../tools/screening.js";

const closeRecords = [
  {
    position: "first_lap",
    pool: "poolYae",
    base_mint: "mintYae",
    pair: "Yae-SOL",
    closed_at: "2026-05-16T12:37:32.819Z",
    pnl_pct: 4.132780530842969,
    material_outcome: "win",
  },
  {
    position: "neutral_lap",
    pool: "poolNeutral",
    base_mint: "mintNeutral",
    pair: "Neutral-SOL",
    closed_at: "2026-05-16T12:37:32.819Z",
    pnl_pct: 0.02,
    material_outcome: "neutral",
    neutral_reason: "dust",
  },
  {
    position: "old_win",
    pool: "poolOld",
    base_mint: "mintOld",
    pair: "Old-SOL",
    closed_at: "2026-05-16T10:00:00.000Z",
    pnl_pct: 5,
    material_outcome: "win",
  },
];

const baseConfig = {
  samePoolPostWinDecayEnabled: false,
  samePoolPostWinCooldownMinutes: 15,
  samePoolPostWinMaterialPnlPct: 1,
  samePoolPostWinRequireFreshDecayPass: false,
  sameTickerSurfEnabled: false,
};

const firstLap = evaluateSamePoolPostWinDecay(
  { pool: "newPool", base_mint: "newMint", name: "FIRST-SOL" },
  { closeRecords, now: "2026-05-16T12:44:18.012Z", config: baseConfig },
);
assert.equal(firstLap.decision, "allow", "first-lap candidate passes");

const yaeShadow = evaluateSamePoolPostWinDecay(
  { pool: "poolYae", base_mint: "mintYae", name: "Yae-SOL" },
  { closeRecords, now: "2026-05-16T12:44:18.012Z", config: baseConfig },
);
assert.equal(yaeShadow.decision, "would_block", "Yae-like second lap would block in shadow mode");
assert.equal(yaeShadow.reasonCode, "same_pool_recent_win_cooldown");

const yaeLive = evaluateSamePoolPostWinDecay(
  { pool: "poolYae", base_mint: "mintYae", name: "Yae-SOL" },
  { closeRecords, now: "2026-05-16T12:44:18.012Z", config: { ...baseConfig, samePoolPostWinDecayEnabled: true } },
);
assert.equal(yaeLive.decision, "blocked", "Yae-like second lap blocks only when explicitly enabled");

const tickerOnly = evaluateSamePoolPostWinDecay(
  { pool: "differentPool", base_mint: "differentMint", name: "Yae-SOL" },
  { closeRecords, now: "2026-05-16T12:44:18.012Z", config: baseConfig },
);
assert.equal(tickerOnly.decision, "allow", "same ticker without same pool/base mint is not blocked");

const stale = evaluateSamePoolPostWinDecay(
  { pool: "poolOld", base_mint: "mintOld", name: "Old-SOL" },
  { closeRecords, now: "2026-05-16T12:44:18.012Z", config: baseConfig },
);
assert.equal(stale.decision, "allow", "stale win outside cooldown passes");

const neutral = evaluateSamePoolPostWinDecay(
  { pool: "poolNeutral", base_mint: "mintNeutral", name: "Neutral-SOL" },
  { closeRecords, now: "2026-05-16T12:44:18.012Z", config: baseConfig },
);
assert.equal(neutral.decision, "allow", "neutral/dust close is ignored");

const surfFalseStillChecks = evaluateSamePoolPostWinDecay(
  { pool: "poolYae", base_mint: "mintYae", name: "Yae-SOL" },
  { closeRecords, now: "2026-05-16T12:44:18.012Z", config: { ...baseConfig, sameTickerSurfEnabled: false } },
);
assert.equal(surfFalseStillChecks.decision, "would_block", "sameTickerSurfEnabled=false does not disable normal redeploy safety");

const runtimeCandidates = [{ pool: "poolYae", base_mint: "mintYae", name: "Yae-SOL" }];
const runtimeAccepted = applyScoutTailLossShadowDecisions(runtimeCandidates, baseConfig, {
  closeRecords,
  now: "2026-05-16T12:44:18.012Z",
  appendContext: false,
});
assert.equal(runtimeAccepted.length, 1, "default shadow runtime hook does not live-block candidate");
assert.equal(
  runtimeCandidates[0].same_pool_post_win_decay_decision?.decision,
  "would_block",
  "normal candidate runtime hook attaches same-pool decay shadow decision",
);

console.log(JSON.stringify({
  ok: true,
  checks: [
    "first lap passes",
    "Yae-like second lap would_block in shadow mode",
    "Yae-like second lap blocked in explicit live mode",
    "ticker-only match is not blocked",
    "stale old win passes",
    "neutral close ignored",
    "sameTickerSurf false still checks normal redeploy safety",
    "normal candidate runtime hook attaches same-pool decay shadow without live block",
  ],
  sampleDecision: yaeShadow,
}, null, 2));
