import fs from "fs";
import path from "path";

import { attachOutcomeToShadowDataCollection, buildCandidateShadowDataCollection } from "./shadow-data-collection.js";

const LOG_DIR = process.env.MERIDIAN_MAIN_CANDIDATE_SHADOW_LOG_DIR || "./logs";
const SECRET_KEY_RE = /(api[_-]?key|private[_-]?key|secret|password|authorization|bearer|wallet[_-]?private|mnemonic)/i;
const MAX_ARRAY_LEN = 50;
const MAX_STRING_LEN = 600;
let _warned = false;

function dateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function sanitize(value, depth = 0) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim().slice(0, MAX_STRING_LEN) || null;
  if (Array.isArray(value)) {
    if (depth >= 4) return `[array:${value.length}]`;
    return value.slice(0, MAX_ARRAY_LEN).map((entry) => sanitize(entry, depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= 4) return "[object]";
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SECRET_KEY_RE.test(key) ? "<redacted>" : sanitize(inner, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, MAX_STRING_LEN);
}

function shadowFlags() {
  return {
    shadow_only: true,
    applied_to_filtering: false,
    applied_to_sizing: false,
    applied_to_deploy_args: false,
    applied_to_close: false,
  };
}

function appendShadowRow(kind, row) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const now = new Date();
    const payload = {
      ts: row.ts ?? now.toISOString(),
      event: kind,
      ...shadowFlags(),
      ...row,
    };
    const file = path.join(LOG_DIR, `${kind}-${dateKey(now)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(sanitize(payload)) + "\n");
    return null;
  } catch (error) {
    if (!_warned) {
      _warned = true;
      console.warn(`[main_candidate_shadow_warn] logging failed: ${error.message}`);
    }
    return null;
  }
}

export function appendMainCandidateScreeningSnapshot({ candidates = [], filteredOut = [], stageCounts = {}, source = "screening", timeframe = null } = {}) {
  return appendShadowRow("main-candidate-screening-shadow", {
    source,
    timeframe,
    candidate_count: Array.isArray(candidates) ? candidates.length : 0,
    filtered_count: Array.isArray(filteredOut) ? filteredOut.length : 0,
    stage_counts: stageCounts,
    candidates: Array.isArray(candidates)
      ? candidates.map((candidate, rank) => ({
          rank: rank + 1,
          shadow_data_collection: buildCandidateShadowDataCollection(candidate, {
            timeframe,
            stage: "screening_ranked_candidate",
          }),
        }))
      : [],
    filtered_examples: Array.isArray(filteredOut)
      ? filteredOut.slice(0, 20).map((entry) => ({
          name: entry?.name ?? null,
          pool: entry?.pool ?? entry?.pool_address ?? null,
          reason: entry?.reason ?? null,
          stage: entry?.stage ?? null,
        }))
      : [],
  });
}

export function appendMainCandidateDeploySnapshot({ candidate = {}, result = {}, deploy = {}, source = "deploy_success", timeframe = null } = {}) {
  return appendShadowRow("main-candidate-deploy-shadow", {
    source,
    position: result?.position ?? null,
    deploy,
    shadow_data_collection: candidate?.shadow_data_collection ?? buildCandidateShadowDataCollection(candidate, {
      timeframe,
      stage: "pre_entry_deployed_candidate",
    }),
  });
}

export function appendMainCandidateOutcomeSnapshot({ tracked = {}, outcome = {}, source = "close_success" } = {}) {
  const baseSnapshot = tracked?.shadow_data_collection ?? tracked?.signal_snapshot?.shadow_data_collection ?? null;
  return appendShadowRow("main-candidate-outcome-shadow", {
    source,
    position: outcome.position ?? tracked?.position ?? null,
    pool: outcome.pool ?? tracked?.pool ?? null,
    pool_name: outcome.pool_name ?? tracked?.pool_name ?? null,
    shadow_data_collection: attachOutcomeToShadowDataCollection(baseSnapshot, outcome),
  });
}
