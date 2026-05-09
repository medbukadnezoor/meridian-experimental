import fs from "fs";
import path from "path";
import { config } from "./config.js";

const LOG_DIR = "./logs";
const SECRET_KEY_RE = /(api[_-]?key|private[_-]?key|secret|password|authorization|bearer|wallet[_-]?private)/i;
const MAX_STRING_LEN = 600;
const MAX_ARRAY_LEN = 20;
const MAX_OBJECT_KEYS = 80;
let _warningLogged = false;

function dateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function safeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function sanitize(value, depth = 0) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim().slice(0, MAX_STRING_LEN) || null;
  }
  if (Array.isArray(value)) {
    if (depth >= 4) return `[array:${value.length}]`;
    return value.slice(0, MAX_ARRAY_LEN).map((item) => sanitize(item, depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= 4) return "[object]";
    const out = {};
    for (const [key, inner] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      if (SECRET_KEY_RE.test(key)) {
        out[key] = "<redacted>";
      } else {
        out[key] = sanitize(inner, depth + 1);
      }
    }
    return out;
  }
  return String(value).slice(0, MAX_STRING_LEN);
}

export function summarizeIndicatorConfirmation(confirmation = null) {
  if (!confirmation) return null;
  const intervals = Array.isArray(confirmation.intervals)
    ? confirmation.intervals.map((entry) => ({
        interval: entry?.interval ?? null,
        ok: entry?.ok ?? null,
        confirmed: entry?.confirmed ?? null,
        reason: entry?.reason ?? null,
        rsi: safeNumber(entry?.signal?.rsi),
        close: safeNumber(entry?.signal?.close),
        lowerBand: safeNumber(entry?.signal?.lowerBand),
        upperBand: safeNumber(entry?.signal?.upperBand),
        supertrendDirection: entry?.signal?.supertrendDirection ?? null,
        supertrendValue: safeNumber(entry?.signal?.supertrendValue),
        supertrendBreakUp: entry?.signal?.supertrendBreakUp ?? null,
        supertrendBreakDown: entry?.signal?.supertrendBreakDown ?? null,
      }))
    : [];

  return {
    enabled: confirmation.enabled ?? null,
    skipped: confirmation.skipped ?? null,
    confirmed: confirmation.confirmed ?? null,
    preset: confirmation.preset ?? null,
    side: confirmation.side ?? null,
    requireAllIntervals: confirmation.requireAllIntervals ?? null,
    reason: confirmation.reason ?? null,
    shadow_quality_gates: confirmation.shadow_quality_gates ?? null,
    intervals,
  };
}

export function buildCandidateDecisionContext(candidate = {}) {
  if (!candidate) return {};
  return {
    pool: candidate.pool ?? candidate.pool_address ?? null,
    poolName: candidate.name ?? candidate.pool_name ?? null,
    baseMint: candidate.base?.mint ?? candidate.base_mint ?? null,
    quoteMint: candidate.quote?.mint ?? candidate.quote_mint ?? null,
    baseSymbol: candidate.base?.symbol ?? null,
    quoteSymbol: candidate.quote?.symbol ?? null,
    mcap: safeNumber(candidate.mcap ?? candidate.token_info?.mcap),
    activeTvl: safeNumber(candidate.active_tvl),
    feeActiveTvlRatio: safeNumber(candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio),
    volumeWindow: safeNumber(candidate.volume_window ?? candidate.volume),
    volumeChangePct: safeNumber(candidate.volume_change_pct),
    priceChangePct: safeNumber(candidate.price_change_pct ?? candidate.change_1h),
    binStep: safeNumber(candidate.bin_step),
    volatility: safeNumber(candidate.volatility),
    organicScore: safeNumber(candidate.organic_score ?? candidate.base?.organic),
    tokenAgeHours: safeNumber(candidate.token_age_hours ?? candidate.token_info?.token_age_hours),
    holders: safeNumber(candidate.holders ?? candidate.holder_count),
    top10Pct: safeNumber(candidate.gmgn_top10_concentration_pct ?? candidate.top10_pct),
    bundlePct: safeNumber(candidate.bundle_pct),
    sniperPct: safeNumber(candidate.sniper_pct),
    suspiciousPct: safeNumber(candidate.suspicious_pct),
    sellVol: safeNumber(candidate.sell_vol ?? candidate.stats_1h?.sell_vol ?? candidate.token_info?.stats_1h?.sell_vol),
    buyVol: safeNumber(candidate.buy_vol ?? candidate.stats_1h?.buy_vol ?? candidate.token_info?.stats_1h?.buy_vol),
    globalFeesSol: safeNumber(candidate.global_fees_sol ?? candidate.token_info?.global_fees_sol),
    launchpad: candidate.launchpad ?? candidate.token_info?.launchpad ?? null,
    darwinScore: safeNumber(candidate.darwin_score),
    darwinTopSignals: candidate.darwin_top_signals ?? null,
  };
}

export function appendDecisionContext(entry = {}) {
  if (String(process.env.MERIDIAN_SHADOW_DISABLE_DECISION_CONTEXT || "").toLowerCase() === "true") {
    return null;
  }

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const now = new Date();
    const payload = {
      ts: entry.ts ?? now.toISOString(),
      event_id: entry.event_id ?? `ctx_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
      event: "decision_context",
      bot: entry.bot ?? config.management?.pnlSnapshotBotName ?? "meridian",
      stage: entry.stage ?? "note",
      actor: entry.actor ?? null,
      screener_model: entry.screener_model ?? config.llm?.screeningModel ?? null,
      manager_model: entry.manager_model ?? config.llm?.managementModel ?? null,
      pool: entry.pool ?? null,
      poolName: entry.poolName ?? entry.pool_name ?? null,
      baseMint: entry.baseMint ?? entry.base_mint ?? null,
      quoteMint: entry.quoteMint ?? entry.quote_mint ?? null,
      position: entry.position ?? null,
      pair: entry.pair ?? entry.poolName ?? entry.pool_name ?? null,
      reason: entry.reason ?? null,
      metrics: entry.metrics ?? {},
      chart: entry.chart ?? null,
      deploy: entry.deploy ?? null,
      close: entry.close ?? null,
      source: entry.source ?? null,
    };

    const file = path.join(LOG_DIR, `decision-context-${dateKey(now)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(sanitize(payload)) + "\n");
    return payload.event_id;
  } catch (error) {
    if (!_warningLogged) {
      _warningLogged = true;
      console.warn(`[decision_context_warn] logging failed: ${error.message}`);
    }
    return null;
  }
}
