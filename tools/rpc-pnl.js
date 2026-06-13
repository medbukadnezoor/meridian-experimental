import fs from "fs";
import path from "path";
import { PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { getTrackedPosition, minutesOutOfRange } from "../state.js";
import { buildEffectiveRangeState } from "../range-state.js";
import { RPC_PRIORITY, getSharedConnection, withRpcPriority } from "./rpc.js";

const JUP_SEARCH = "https://datapi.jup.ag/v1/assets/search";
const METEORA_PNL = "https://dlmm.datapi.meteora.ag/positions";
const SOL_MINT = "So11111111111111111111111111111111111111112";

let _DLMM = null;
let _pollCount = 0;
const _meteoraCache = new Map();

async function loadDlmmSdk() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
  }
  return _DLMM;
}

function num(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeNum(value) {
  return num(value) ?? 0;
}

function round(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function mapEntries(map) {
  return map instanceof Map ? [...map.entries()] : Object.entries(map || {});
}

function jsonlPath(logDir, prefix, ts = new Date()) {
  const day = ts.toISOString().slice(0, 10);
  return path.join(logDir, `${prefix}-${day}.jsonl`);
}

function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

export async function fetchRpcDlmmPnlForPool(poolAddress, walletAddress) {
  const url = `${METEORA_PNL}/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("rpc_pnl_warn", `Meteora PnL ${res.status} for ${poolAddress.slice(0, 8)}: ${body.slice(0, 120)}`);
      return {};
    }
    const data = await res.json();
    const positions = data.positions || data.data || [];
    const byAddress = {};
    for (const p of positions) {
      const addr = p.positionAddress || p.address || p.position;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (error) {
    log("rpc_pnl_warn", `Meteora PnL fetch failed for ${poolAddress.slice(0, 8)}: ${error.message}`);
    return {};
  }
}

async function getLatestSig(conn, addr) {
  try {
    const sigs = await withRpcPriority(
      RPC_PRIORITY.MANAGEMENT,
      "helius_rpc.rpc_pnl_signature",
      () => conn.getSignaturesForAddress(new PublicKey(addr), { limit: 1 }),
    );
    return sigs?.[0]?.signature ?? null;
  } catch {
    return null;
  }
}

async function getMeteoraData(conn, walletAddress, flat) {
  const ttlMs = Math.max(0, Number(config.pnl?.depositCacheTtlSec ?? 300)) * 1000;
  const byPool = new Map();
  for (const f of flat) {
    if (!byPool.has(f.pool)) byPool.set(f.pool, []);
    byPool.get(f.pool).push(f.position);
  }

  const byPosition = {};
  for (const [pool, positionAddrs] of byPool.entries()) {
    const cached = _meteoraCache.get(pool);
    const sigByPosition = {};
    await Promise.all(positionAddrs.map(async (addr) => {
      sigByPosition[addr] = await getLatestSig(conn, addr);
    }));

    const ageOk = cached && Date.now() - cached.at < ttlMs;
    const sigsMatch = cached && positionAddrs.every((addr) => cached.sigByPosition?.[addr] === sigByPosition[addr]);
    const data = ageOk && sigsMatch
      ? cached.byPosition
      : await fetchRpcDlmmPnlForPool(pool, walletAddress);
    if (!ageOk || !sigsMatch) {
      _meteoraCache.set(pool, { at: Date.now(), byPosition: data, sigByPosition });
    }
    for (const addr of positionAddrs) byPosition[addr] = data[addr] || null;
  }
  return byPosition;
}

async function getJupiterPrices(mints) {
  const list = unique(mints);
  if (!list.length) return {};
  try {
    const res = await fetch(`${JUP_SEARCH}?query=${list.join(",")}`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Jupiter ${res.status}`);
    const assets = await res.json();
    const out = {};
    for (const asset of Array.isArray(assets) ? assets : []) {
      out[asset.id] = num(asset.usdPrice);
    }
    return out;
  } catch (error) {
    log("rpc_pnl_warn", `Jupiter price fetch failed: ${error.message}`);
    return {};
  }
}

function human(raw, decimals) {
  const n = safeNum(raw?.toString?.() ?? raw);
  return n / 10 ** decimals;
}

function buildRpcPosition(flat, prices, solUsd, meteora, solMode) {
  const degradedReasons = [];
  const tracked = getTrackedPosition(flat.position);

  if (!(solUsd > 0)) degradedReasons.push("missing_sol_price");
  if (flat.decX == null || flat.decY == null) degradedReasons.push("missing_decimals");
  if (flat.active == null) degradedReasons.push("missing_active_bin");
  if (!meteora) degradedReasons.push("missing_meteora_position_row");

  const decX = flat.decX ?? 9;
  const decY = flat.decY ?? 9;
  const priceX = flat.baseMint ? prices[flat.baseMint] : null;
  const xHuman = human(flat.xRaw, decX);
  const yHuman = human(flat.yRaw, decY);
  const feeXHuman = human(flat.feeXRaw, decX);
  const feeYHuman = human(flat.feeYRaw, decY);
  const holdsTokenX = xHuman > 0 || feeXHuman > 0;
  if (holdsTokenX && flat.baseMint && !(priceX > 0)) degradedReasons.push("missing_base_price");

  const balancesUsd = xHuman * safeNum(priceX) + yHuman * safeNum(solUsd);
  const balancesSol = solUsd ? balancesUsd / solUsd : yHuman;
  const claimableUsd = feeXHuman * safeNum(priceX) + feeYHuman * safeNum(solUsd);
  const claimableSol = solUsd ? claimableUsd / solUsd : feeYHuman;
  const depositsUsd = safeNum(meteora?.allTimeDeposits?.total?.usd);
  const depositsSol = safeNum(meteora?.allTimeDeposits?.total?.sol);
  const withdrawUsd = safeNum(meteora?.allTimeWithdrawals?.total?.usd);
  const withdrawSol = safeNum(meteora?.allTimeWithdrawals?.total?.sol);
  const claimedUsd = safeNum(meteora?.allTimeFees?.total?.usd);
  const claimedSol = safeNum(meteora?.allTimeFees?.total?.sol);
  const depositBasis = solMode ? depositsSol : depositsUsd;
  if (!(depositBasis > 0)) degradedReasons.push("missing_deposit_basis");

  const pnlUsd = balancesUsd + withdrawUsd + claimableUsd + claimedUsd - depositsUsd;
  const pnlSol = balancesSol + withdrawSol + claimableSol + claimedSol - depositsSol;
  const pctUsd = depositsUsd > 0 ? (pnlUsd / depositsUsd) * 100 : null;
  const pctSol = depositsSol > 0 ? (pnlSol / depositsSol) * 100 : null;
  const ourPct = solMode ? pctSol : pctUsd;
  const reportedPct = solMode ? num(meteora?.pnlSolPctChange) : num(meteora?.pnlPctChange);
  const pnlPctDiff = reportedPct != null && ourPct != null ? Math.abs(ourPct - reportedPct) : null;

  const hasLiveBins = flat.active != null && flat.lower != null && flat.upper != null;
  const sourceInRange = hasLiveBins
    ? flat.active >= flat.lower && flat.active <= flat.upper
    : meteora ? !meteora.isOutOfRange : null;
  const rangeState = buildEffectiveRangeState({
    source_in_range: sourceInRange,
    lower_bin: flat.lower ?? tracked?.bin_range?.min ?? null,
    upper_bin: flat.upper ?? tracked?.bin_range?.max ?? null,
    active_bin: flat.active ?? tracked?.bin_range?.active ?? null,
    lower_bin_source: flat.lower != null ? "live_bin_data" : tracked?.bin_range?.min != null ? "tracked_state" : null,
    upper_bin_source: flat.upper != null ? "live_bin_data" : tracked?.bin_range?.max != null ? "tracked_state" : null,
    active_bin_source: flat.active != null ? "live_bin_data" : tracked?.bin_range?.active != null ? "tracked_state" : null,
  });

  const ageFromState = tracked?.deployed_at
    ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
    : null;
  const ageMinutes = meteora?.createdAt ? Math.floor((Date.now() - meteora.createdAt * 1000) / 60000) : ageFromState;

  return {
    position: flat.position,
    pool: flat.pool,
    pair: tracked?.pool_name || (meteora ? `${meteora.tokenX ?? "?"}/${meteora.tokenY ?? "SOL"}` : "?/SOL"),
    base_mint: flat.baseMint,
    lower_bin: rangeState.lower_bin,
    upper_bin: rangeState.upper_bin,
    active_bin: rangeState.active_bin,
    in_range: sourceInRange,
    source_in_range: rangeState.source_in_range,
    effective_in_range: rangeState.effective_in_range,
    range_side: rangeState.derived_range_side,
    derived_in_range: rangeState.derived_in_range,
    range_state_mismatch: rangeState.range_state_mismatch,
    range_state_source: rangeState.range_state_source,
    lower_bin_source: rangeState.lower_bin_source,
    upper_bin_source: rangeState.upper_bin_source,
    active_bin_source: rangeState.active_bin_source,
    unclaimed_fees_usd: round(solMode ? claimableSol : claimableUsd),
    total_value_usd: round(solMode ? balancesSol : balancesUsd),
    total_value_true_usd: round(balancesUsd),
    collected_fees_usd: round(solMode ? claimedSol : claimedUsd),
    collected_fees_true_usd: round(claimedUsd),
    pnl_usd: round(solMode ? pnlSol : pnlUsd),
    pnl_true_usd: round(pnlUsd),
    pnl_pct: round(ourPct, 2),
    pnl_pct_derived: round(ourPct, 2),
    pnl_pct_diff: round(pnlPctDiff, 2),
    pnl_pct_suspicious: degradedReasons.length > 0,
    pnl_confidence: degradedReasons.length ? "degraded" : "trusted",
    pnl_degraded_reasons: degradedReasons,
    fee_per_tvl_24h: meteora ? round(safeNum(meteora.feePerTvl24h), 2) : null,
    age_minutes: ageMinutes,
    minutes_out_of_range: minutesOutOfRange(flat.position),
    instruction: tracked?.instruction ?? null,
    note: tracked?.note ?? null,
    source: "rpc",
    position_source: "rpc_pnl",
  };
}

export async function computeRpcPositions(walletAddress) {
  const conn = getSharedConnection(config.pnl.rpcUrl);
  const DLMM = await loadDlmmSdk();
  const map = await withRpcPriority(
    RPC_PRIORITY.MANAGEMENT,
    "helius_rpc.rpc_pnl_positions",
    () => DLMM.getAllLbPairPositionsByUser(conn, new PublicKey(walletAddress)),
  );

  _pollCount += 1;
  if (_pollCount % 20 === 1) {
    const n = mapEntries(map).reduce((sum, [, info]) => sum + (info?.lbPairPositionsData?.length ?? 0), 0);
    log("pnl_tick", `rpc poller alive — ${n} position(s) tracked (tick #${_pollCount})`);
  }

  const flat = [];
  for (const [lbPairKey, info] of mapEntries(map)) {
    const decX = info?.tokenX?.mint?.decimals;
    const decY = info?.tokenY?.mint?.decimals;
    const baseMint = info?.tokenX?.mint?.address?.toString?.() ?? null;
    const active = info?.lbPair?.activeId ?? null;
    for (const p of info?.lbPairPositionsData || []) {
      const d = p.positionData || {};
      flat.push({
        position: p.publicKey.toString(),
        pool: lbPairKey,
        baseMint,
        decX,
        decY,
        active,
        lower: d.lowerBinId ?? null,
        upper: d.upperBinId ?? null,
        xRaw: d.totalXAmount,
        yRaw: d.totalYAmount,
        feeXRaw: d.feeX?.toString?.() ?? d.feeX ?? 0,
        feeYRaw: d.feeY?.toString?.() ?? d.feeY ?? 0,
      });
    }
  }

  if (flat.length === 0) {
    return { wallet: walletAddress, total_positions: 0, positions: [], source: "rpc", complete: true };
  }

  const [prices, meteoraByPosition] = await Promise.all([
    getJupiterPrices([SOL_MINT, config.tokens?.SOL, ...flat.map((f) => f.baseMint)]),
    getMeteoraData(conn, walletAddress, flat),
  ]);
  const solUsd = prices[config.tokens?.SOL] ?? prices[SOL_MINT] ?? null;
  const positions = flat.map((f) => buildRpcPosition(f, prices, solUsd, meteoraByPosition[f.position], !!config.management?.solMode));

  return {
    wallet: walletAddress,
    total_positions: positions.length,
    positions,
    source: "rpc",
    complete: true,
  };
}

function summarizeLegacyPosition(position) {
  if (!position) return null;
  return {
    pnl_pct: position.pnl_pct ?? null,
    pnl_pct_suspicious: position.pnl_pct_suspicious ?? null,
    pnl_confidence: position.pnl_confidence ?? null,
    in_range: position.in_range ?? null,
    effective_in_range: position.effective_in_range ?? null,
    range_side: position.range_side ?? null,
    active_bin: position.active_bin ?? null,
    lower_bin: position.lower_bin ?? null,
    upper_bin: position.upper_bin ?? null,
    fee_per_tvl_24h: position.fee_per_tvl_24h ?? null,
    age_minutes: position.age_minutes ?? null,
  };
}

export async function recordRpcPnlShadowComparison(walletAddress, legacyResult, { logDir = "logs" } = {}) {
  const rpcResult = await computeRpcPositions(walletAddress);
  const legacyByPosition = new Map((legacyResult?.positions || []).map((p) => [p.position, p]));
  const rpcByPosition = new Map((rpcResult.positions || []).map((p) => [p.position, p]));
  const allPositions = new Set([...legacyByPosition.keys(), ...rpcByPosition.keys()]);
  const ts = new Date();
  const file = jsonlPath(logDir, "rpc-pnl-shadow", ts);

  for (const position of allPositions) {
    const legacy = legacyByPosition.get(position);
    const rpc = rpcByPosition.get(position);
    appendJsonl(file, {
      ts: ts.toISOString(),
      event: "rpc_pnl_shadow",
      wallet: walletAddress,
      position,
      pool: rpc?.pool ?? legacy?.pool ?? null,
      pair: rpc?.pair ?? legacy?.pair ?? null,
      rpc: summarizeLegacyPosition(rpc),
      legacy: summarizeLegacyPosition(legacy),
      rpc_only: !!rpc && !legacy,
      legacy_only: !!legacy && !rpc,
      shadow_only: true,
      no_state_sync: true,
      no_close_authority: true,
    });
  }

  if (allPositions.size === 0) {
    appendJsonl(file, {
      ts: ts.toISOString(),
      event: "rpc_pnl_shadow",
      wallet: walletAddress,
      position: null,
      rpc_zero_positions: true,
      legacy_zero_positions: (legacyResult?.positions || []).length === 0,
      shadow_only: true,
      no_state_sync: true,
      no_close_authority: true,
    });
  }

  return { rpcResult, rows: allPositions.size || 1, file };
}
