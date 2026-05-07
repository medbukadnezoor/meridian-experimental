#!/usr/bin/env node
/**
 * Synthetic proof for empty-position ghost reconciliation.
 *
 * This avoids network, wallet, and bot runtime. It uses an isolated temp cwd
 * because state.js stores relative to ./state.json.
 */

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { reconcileGhostPositions } from "../state.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-ghost-proof-"));
const originalCwd = process.cwd();

function statePath() {
  return path.join(tempDir, "state.json");
}

function writeState(state) {
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

function readState() {
  return JSON.parse(fs.readFileSync(statePath(), "utf8"));
}

try {
  process.chdir(tempDir);
  fs.mkdirSync("logs", { recursive: true });

  const ghost = {
    position: "Ghost111111111111111111111111111111111111",
    pool: "Pool1111111111111111111111111111111111111",
    pair: "GHOST-SOL",
    total_value_usd: 0,
    unclaimed_fees_usd: 0,
    base_mint: null,
    age_minutes: 1,
  };

  writeState({ positions: {}, recentEvents: [], ghostCandidates: {}, lastUpdated: null });
  assert.strictEqual(reconcileGhostPositions([ghost]).positions.length, 1, "first untracked ghost observation is kept");
  assert.strictEqual(reconcileGhostPositions([ghost]).positions.length, 1, "second untracked ghost observation is kept");
  const third = reconcileGhostPositions([ghost]);
  assert.strictEqual(third.positions.length, 0, "third untracked ghost observation is suppressed");
  assert.strictEqual(third.suppressed.length, 1, "suppressed ghost is reported");
  assert.strictEqual(readState().ghostCandidates[ghost.position].suppressed, true, "suppression is persisted");

  const trackedFresh = {
    ...ghost,
    position: "Fresh111111111111111111111111111111111111",
    age_minutes: 1,
  };
  writeState({
    positions: {
      [trackedFresh.position]: {
        position: trackedFresh.position,
        pool: trackedFresh.pool,
        pool_name: "FRESH-SOL",
        deployed_at: new Date().toISOString(),
        closed: false,
        notes: [],
      },
    },
    recentEvents: [],
    ghostCandidates: {},
    lastUpdated: null,
  });
  const fresh = reconcileGhostPositions([trackedFresh]);
  assert.strictEqual(fresh.positions.length, 1, "fresh tracked ghost-like position remains inside grace");
  assert.strictEqual(fresh.suppressed.length, 0, "fresh tracked position is not suppressed");

  console.log(JSON.stringify({
    success: true,
    untracked_empty_position_suppressed_after_observations: true,
    fresh_tracked_position_grace_preserved: true,
  }, null, 2));
} finally {
  process.chdir(originalCwd);
  fs.rmSync(tempDir, { recursive: true, force: true });
}
