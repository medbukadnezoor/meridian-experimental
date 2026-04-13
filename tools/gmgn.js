/**
 * GMGN Agent API helpers — token risk enrichment
 *
 * Endpoint: https://openapi.gmgn.ai/v1/market/token_top_traders
 * Auth:     X-APIKEY header + timestamp (unix seconds) + client_id (UUID per request)
 * Docs:     https://docs.gmgn.ai/index/gmgn-agent-api
 *
 * Used for logging and Darwin signal enrichment ONLY — never hard blockers.
 * Returns null on any error — never throws, never stalls the screening cycle.
 *
 * Signals derived (from badattrading_analyzer methodology research):
 *   bluechip_present    — quality signal: reputable wallets holding (positive)
 *   bundler_present     — risk signal: bundler bots in top traders (negative)
 *   fresh_wallet_count  — proxy for sniper count at launch
 *   top10_concentration_pct — supply concentration risk
 *   smart_tool_tags     — which smart-money tools are active (photon, padre, etc.)
 *   suspicious_count    — GMGN-flagged suspicious wallets
 *
 * GMGN coverage vs badattrading full methodology:
 *   ✅ Bluechip/quality holder detection  (tags: bluechip_owner)
 *   ✅ Bundler presence                   (tags: bundler)
 *   ✅ Fresh wallet / sniper proxy        (tags: fresh_wallet)
 *   ✅ Top10 concentration                (amount_percentage sum)
 *   ✅ Smart tool presence                (tags: photon, padre, axiom, bullx, trojan)
 *   ❌ Insider/sniper/team %             — DevsNightmarePro only
 *   ❌ Cluster structure                  — BubbleMaps / InsightX only
 *   ❌ Exchange-funded wallets            — Helius only
 */

import { randomUUID } from "crypto";
import { log } from "../logger.js";

const GMGN_BASE = "https://openapi.gmgn.ai/v1";
const GMGN_API_KEY = process.env.GMGN_API_KEY || "";

// Tags indicating smart-money tool activity (positive context)
const SMART_TOOL_TAGS = new Set(["photon", "padre", "gmgn", "axiom", "bullx", "trojan", "gmgnkol"]);

/**
 * Fetch top traders for a token from GMGN and compute risk signals.
 *
 * @param {string} mintAddress — Solana token mint address
 * @param {number} [limit=20]  — how many top traders to fetch
 * @returns {Promise<GmgnRisk|null>}
 */
export async function fetchGmgnTokenRisk(mintAddress, limit = 20) {
  if (!GMGN_API_KEY || !mintAddress) return null;

  try {
    const params = new URLSearchParams({
      chain:     "sol",
      address:   mintAddress,
      limit:     String(limit),
      timestamp: String(Math.floor(Date.now() / 1000)),
      client_id: randomUUID(),
    });

    const res = await fetch(`${GMGN_BASE}/market/token_top_traders?${params}`, {
      headers: { "X-APIKEY": GMGN_API_KEY },
      signal:  AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      log("gmgn", `HTTP ${res.status} for ${mintAddress.slice(0, 8)}`);
      return null;
    }

    const body = await res.json();
    if (body.code !== 0 || !Array.isArray(body.data?.list)) return null;

    const result = _computeRiskSignals(body.data.list);
    log("gmgn", `${mintAddress.slice(0, 8)} — top10=${result.top10_concentration_pct}% bluechip=${result.bluechip_count} bundler=${result.bundler_count} suspicious=${result.suspicious_count}`);
    return result;
  } catch (err) {
    log("gmgn_warn", `fetch failed for ${mintAddress.slice(0, 8)}: ${err.message}`);
    return null;
  }
}

/**
 * Compute structured risk signals from a list of GMGN top trader objects.
 * @param {Array} traders
 * @returns {GmgnRisk}
 */
function _computeRiskSignals(traders) {
  let top10_concentration_pct = 0;
  let bluechip_count    = 0;
  let bundler_count     = 0;
  let fresh_wallet_count = 0;
  let sandwich_bot_count = 0;
  let suspicious_count  = 0;
  let whale_count       = 0;
  let diamond_hands_count = 0;
  const smart_tool_tags_found = new Set();
  let named_holder_count = 0;

  for (let i = 0; i < traders.length; i++) {
    const t = traders[i];
    const allTags = [
      ...(Array.isArray(t.tags)             ? t.tags             : []),
      ...(Array.isArray(t.maker_token_tags) ? t.maker_token_tags : []),
    ];

    // Top-10 concentration (amount_percentage is a decimal, e.g. 0.0633 = 6.33%)
    if (i < 10) top10_concentration_pct += (t.amount_percentage || 0) * 100;

    if (t.is_suspicious)  suspicious_count++;
    if (t.name)           named_holder_count++;

    for (const tag of allTags) {
      if (tag === "bluechip_owner")   bluechip_count++;
      if (tag === "bundler")          bundler_count++;
      if (tag === "fresh_wallet")     fresh_wallet_count++;
      if (tag === "sandwich_bot")     sandwich_bot_count++;
      if (tag === "whale")            whale_count++;
      if (tag === "diamond_hands")    diamond_hands_count++;
      if (SMART_TOOL_TAGS.has(tag))   smart_tool_tags_found.add(tag);
    }
  }

  return {
    top10_concentration_pct: parseFloat(top10_concentration_pct.toFixed(1)),
    bluechip_count,
    bundler_count,
    fresh_wallet_count,   // proxy for sniper bots at launch
    sandwich_bot_count,
    suspicious_count,
    whale_count,
    diamond_hands_count,
    smart_tool_tags:    [...smart_tool_tags_found].sort(),
    named_holder_count,
    // ── Darwin boolean signals ──────────────────────────────────────
    bluechip_present: bluechip_count > 0,   // positive: quality wallets holding
    bundler_present:  bundler_count  > 0,   // negative: bundler bots in supply
  };
}
