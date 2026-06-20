const SCHEMA_VERSION = "main_shadow_data_collection_v1";
const CATASTROPHIC_LOSS_PCT = -8;

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstPresent(source = {}, keys = []) {
  for (const key of keys) {
    const value = key.split(".").reduce((current, part) => current?.[part], source);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function firstPresentEntry(source = {}, keys = []) {
  for (const key of keys) {
    const value = key.split(".").reduce((current, part) => current?.[part], source);
    if (value !== undefined && value !== null && value !== "") return { key, value };
  }
  return null;
}

function boolOrNull(value) {
  if (value === true || value === false) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export function classifyShadowVolumeTrend(volumeChangePct) {
  const change = finiteNumber(volumeChangePct);
  if (change == null) return null;
  if (change > 10) return "accelerating";
  if (change < -10) return "decelerating";
  return "stable";
}

const PRICE_CHANGE_ALIASES = {
  "5m": [
    "price_change_5m_pct",
    "price_change_5m",
    "priceChange5mPct",
    "priceChange5M",
    "stats_5m.price_change",
    "token_info.stats_5m.price_change",
    "token_info.price_change_5m",
  ],
  "1h": [
    "price_change_1h_pct",
    "price_change_1h",
    "price_change_pct",
    "priceChangePct",
    "change_1h",
    "price_change",
    "stats_1h.price_change",
    "token_info.stats_1h.price_change",
    "token_info.price_change_pct",
  ],
  "6h": [
    "price_change_6h_pct",
    "price_change_6h",
    "priceChange6hPct",
    "priceChange6H",
    "stats_6h.price_change",
    "token_info.stats_6h.price_change",
    "token_info.price_change_6h",
  ],
  "24h": [
    "price_change_24h_pct",
    "price_change_24h",
    "priceChange24hPct",
    "priceChange24H",
    "stats_24h.price_change",
    "token_info.stats_24h.price_change",
    "token_info.price_change_24h",
  ],
};

const PRIMARY_PRICE_CHANGE_ALIASES = [
  "price_change_primary_pct",
  "price_change_pct",
  "priceChangePct",
  "change_1h",
  "price_change_1h_pct",
  "price_change_1h",
  "stats_1h.price_change",
  "token_info.stats_1h.price_change",
];

const PRICE_CHANGE_MOMENTUM_THRESHOLD_PCT = 100;

function collectPriceChangeFields(candidate = {}) {
  const byTimeframe = Object.fromEntries(
    Object.entries(PRICE_CHANGE_ALIASES).map(([timeframe, aliases]) => {
      const entry = firstPresentEntry(candidate, aliases);
      return [timeframe, {
        value: finiteNumber(entry?.value),
        source: entry?.key ?? null,
      }];
    }),
  );

  const explicitPrimary = firstPresentEntry(candidate, PRIMARY_PRICE_CHANGE_ALIASES);
  const primaryCandidates = [
    explicitPrimary ? { timeframe: inferPriceChangeTimeframe(explicitPrimary.key), ...explicitPrimary } : null,
    byTimeframe["1h"].source ? { timeframe: "1h", key: byTimeframe["1h"].source, value: byTimeframe["1h"].value } : null,
    byTimeframe["5m"].source ? { timeframe: "5m", key: byTimeframe["5m"].source, value: byTimeframe["5m"].value } : null,
    byTimeframe["6h"].source ? { timeframe: "6h", key: byTimeframe["6h"].source, value: byTimeframe["6h"].value } : null,
    byTimeframe["24h"].source ? { timeframe: "24h", key: byTimeframe["24h"].source, value: byTimeframe["24h"].value } : null,
  ].filter(Boolean);
  const primary = primaryCandidates.find((entry) => finiteNumber(entry.value) != null) ?? null;

  return {
    price_change_5m_pct: byTimeframe["5m"].value,
    price_change_1h_pct: byTimeframe["1h"].value,
    price_change_6h_pct: byTimeframe["6h"].value,
    price_change_24h_pct: byTimeframe["24h"].value,
    price_change_primary_pct: finiteNumber(primary?.value),
    price_change_primary_timeframe: primary?.timeframe ?? null,
    price_change_source: primary?.key ?? null,
  };
}

function inferPriceChangeTimeframe(key = "") {
  if (/5m/i.test(key)) return "5m";
  if (/6h/i.test(key)) return "6h";
  if (/24h/i.test(key)) return "24h";
  return "1h";
}

function buildMomentumScreeningShadow(priceChangeFields) {
  const timeframe = priceChangeFields.price_change_primary_timeframe ?? "1h";
  const priceChangePct = finiteNumber(priceChangeFields.price_change_primary_pct);
  if (priceChangePct == null) {
    return {
      rule_version: "price_change_momentum_shadow_v1",
      timeframe,
      threshold_pct: PRICE_CHANGE_MOMENTUM_THRESHOLD_PCT,
      decision: "missing_data",
      reason: "missing price_change_primary_pct",
    };
  }
  const wouldPass = priceChangePct > PRICE_CHANGE_MOMENTUM_THRESHOLD_PCT;
  return {
    rule_version: "price_change_momentum_shadow_v1",
    timeframe,
    threshold_pct: PRICE_CHANGE_MOMENTUM_THRESHOLD_PCT,
    decision: wouldPass ? "would_pass" : "would_block",
    reason: `${timeframe} price_change ${priceChangePct} ${wouldPass ? ">" : "<="} ${PRICE_CHANGE_MOMENTUM_THRESHOLD_PCT}`,
  };
}

function getReentryContextScope(context = {}) {
  const explicitScope = firstPresent(context, ["reentry_context_scope", "reentryContextScope"]);
  if ([
    "same_pool",
    "same_base_mint",
    "same_pool_or_base_mint",
  ].includes(explicitScope)) {
    return explicitScope;
  }
  if (boolOrNull(firstPresent(context, [
    "same_pool_or_base_reentry_context",
    "samePoolOrBaseReentryContext",
  ])) === true) {
    return "same_pool_or_base_mint";
  }
  if (firstPresent(context, ["previous_same_pool_or_base_close_ts", "previousSamePoolOrBaseCloseTs"]) != null) {
    return "same_pool_or_base_mint";
  }
  return null;
}

function buildReentryMomentumShadow(context = {}, priceChangeFields = collectPriceChangeFields(context)) {
  const contextScope = getReentryContextScope(context);
  if (!contextScope) return null;

  const minutesSinceClose = finiteNumber(firstPresent(context, [
    "minutes_since_close",
    "minutesSinceClose",
  ]));
  const previousPnlPct = finiteNumber(firstPresent(context, [
    "previous_pnl_pct",
    "prior_pnl_pct",
    "previousPnlPct",
    "priorPnlPct",
  ]));
  const previousCloseTs = firstPresent(context, [
    "previous_same_pool_or_base_close_ts",
    "previous_close_ts",
    "prior_close_ts",
    "previousCloseTs",
    "priorCloseTs",
  ]);
  const priceChange1hPct = finiteNumber(
    priceChangeFields.price_change_1h_pct
      ?? firstPresent(context, ["price_change_1h_pct", "price_change_pct", "price_change_1h", "change_1h"]),
  );

  const base = {
    rule_version: "dynamic_reentry_momentum_shadow_v1",
    context_scope: contextScope,
    previous_close_ts: previousCloseTs ?? null,
    minutes_since_close: minutesSinceClose,
    previous_pnl_pct: previousPnlPct,
    price_change_1h_pct: priceChange1hPct,
    decision: "missing_data",
    reason: null,
  };

  if (minutesSinceClose == null) {
    return { ...base, reason: "missing minutes_since_close" };
  }
  if (minutesSinceClose < 60) {
    return { ...base, threshold_pct: null, decision: "would_block", reason: "minutes_since_close < 60" };
  }

  const thresholdPct = minutesSinceClose < 360
    ? 100
    : minutesSinceClose < 720
      ? 50
      : 20;
  if (priceChange1hPct == null) {
    return { ...base, threshold_pct: thresholdPct, reason: "missing price_change_1h_pct" };
  }
  const wouldAllow = priceChange1hPct > thresholdPct;
  return {
    ...base,
    threshold_pct: thresholdPct,
    decision: wouldAllow ? "would_allow" : "would_block",
    reason: `1h price_change ${priceChange1hPct} ${wouldAllow ? ">" : "<="} ${thresholdPct}`,
  };
}

export function buildCandidateShadowDataCollection(candidate = {}, { timeframe = null, stage = "candidate_snapshot" } = {}) {
  const volumeChangePct = finiteNumber(firstPresent(candidate, ["volume_change_pct", "volumeChangePct"]));
  const feeActiveTvlRatio = finiteNumber(firstPresent(candidate, ["fee_active_tvl_ratio", "fee_tvl_ratio"]));
  const holderCount = finiteNumber(firstPresent(candidate, ["holder_count", "holders", "base_token_holders", "token_info.holders"]));
  const top10Pct = finiteNumber(firstPresent(candidate, [
    "top10_pct",
    "top10_holder_pct",
    "top_holders_pct",
    "audit.top_holders_pct",
    "token_info.audit.top_holders_pct",
    "gmgn_top10_concentration_pct",
  ]));
  const botHoldersPct = finiteNumber(firstPresent(candidate, [
    "bot_holders_pct",
    "audit.bot_holders_pct",
    "token_info.audit.bot_holders_pct",
  ]));
  const totalLps = finiteNumber(firstPresent(candidate, [
    "total_lps",
    "totalLPs",
    "total_lp_count",
    "lp_count",
    "lps",
    "total_lpers",
  ]));
  const highSupplyConcentration = boolOrNull(firstPresent(candidate, [
    "high_supply_concentration",
    "has_high_supply_concentration",
    "audit.high_supply_concentration",
    "token_info.audit.high_supply_concentration",
  ]));
  const jupShieldSafeguard = boolOrNull(firstPresent(candidate, [
    "jupshield_safeguard",
    "jup_shield_safeguard",
    "jupShield.safeguard",
    "token_info.jupShield.safeguard",
    "token_info.audit.jupshield_safeguard",
  ]));
  const priceChangeFields = collectPriceChangeFields(candidate);

  return {
    schema_version: SCHEMA_VERSION,
    shadow_only: true,
    stage,
    source_articles: [
      "dikibagast_overfitting_optimization_for_meridian",
      "0xyunss_meteora_pool_discovery_screening",
    ],
    timeframe: timeframe ?? firstPresent(candidate, ["timeframe", "volume_timeframe", "volatility_timeframe"]) ?? null,
    pool: firstPresent(candidate, ["pool", "pool_address", "address"]),
    pool_name: firstPresent(candidate, ["name", "pool_name"]),
    base_mint: firstPresent(candidate, ["base.mint", "base_mint", "mint", "token_info.mint"]),
    quote_mint: firstPresent(candidate, ["quote.mint", "quote_mint"]),
    volume_change_pct: volumeChangePct,
    volume_trend: classifyShadowVolumeTrend(volumeChangePct),
    fee_active_tvl_ratio: feeActiveTvlRatio,
    organic_score: finiteNumber(firstPresent(candidate, ["organic_score", "base.organic", "token_info.organic_score"])),
    quote_organic_score: finiteNumber(firstPresent(candidate, ["quote_organic_score", "quote.organic"])),
    holder_count: holderCount,
    top10_pct: top10Pct,
    bot_holders_pct: botHoldersPct,
    mcap: finiteNumber(firstPresent(candidate, ["mcap", "token_info.mcap"])),
    volatility: finiteNumber(firstPresent(candidate, ["volatility"])),
    bin_step: finiteNumber(firstPresent(candidate, ["bin_step"])),
    active_tvl: finiteNumber(firstPresent(candidate, ["active_tvl", "tvl"])),
    volume_window: finiteNumber(firstPresent(candidate, ["volume_window", "volume"])),
    total_lps: totalLps,
    open_positions: finiteNumber(firstPresent(candidate, ["open_positions", "active_positions"])),
    jupshield_safeguard: jupShieldSafeguard,
    high_supply_concentration: highSupplyConcentration,
    ...priceChangeFields,
    momentum_screening_shadow: buildMomentumScreeningShadow(priceChangeFields),
    reentry_momentum_shadow: buildReentryMomentumShadow(candidate, priceChangeFields),
  };
}

export function attachOutcomeToShadowDataCollection(snapshot = null, outcome = {}) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const pnlPct = finiteNumber(outcome.pnl_pct ?? outcome.pnlPct);
  const minutesHeld = finiteNumber(outcome.minutes_held ?? outcome.minutesHeld);
  const reentryContext = { ...snapshot, ...outcome };
  return {
    ...snapshot,
    stage: "closed_position_outcome",
    close_reason: outcome.close_reason ?? outcome.reason ?? null,
    close_reason_bucket: outcome.close_reason_bucket ?? null,
    pnl_pct: pnlPct,
    pnl_usd: finiteNumber(outcome.pnl_usd ?? outcome.pnlUsd),
    minutes_held: minutesHeld,
    material_outcome: outcome.material_outcome ?? null,
    material_loss: outcome.material_loss === true,
    catastrophic_loss: pnlPct != null ? pnlPct <= CATASTROPHIC_LOSS_PCT : false,
    catastrophic_loss_threshold_pct: CATASTROPHIC_LOSS_PCT,
    reentry_momentum_shadow: snapshot.reentry_momentum_shadow ?? buildReentryMomentumShadow(reentryContext),
  };
}
