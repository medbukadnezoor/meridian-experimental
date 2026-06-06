import "dotenv/config";
import fs from "fs";
import path from "path";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import { getSharedConnection, RPC_PRIORITY, withRpcPriority } from "./tools/rpc.js";

export const DEFAULT_SOL_BALANCE_TRACKER_CONFIG = Object.freeze({
  enabled: true,
  intervalMs: 30_000,
  botName: "meridian",
  residualTokenSampleEveryMs: 300_000,
  verificationWindowMs: 1_800_000,
  dustSol: 0.002,
  fabriqToleranceSol: 0.02,
  logDir: "logs",
});

const SOL_MINT = "So11111111111111111111111111111111111111112";
const LAMPORTS_DIGITS = 9;

function toNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function roundSol(value, digits = LAMPORTS_DIGITS) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function datePart(ts = new Date()) {
  return ts.toISOString().slice(0, 10);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function jsonlPath(logDir, prefix, ts = new Date()) {
  return path.join(logDir, `${prefix}-${datePart(ts)}.jsonl`);
}

export function appendJsonl(file, row) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

export function readJsonlFile(file) {
  if (!fs.existsSync(file)) return { rows: [], malformedLineCount: 0 };
  const rows = [];
  let malformedLineCount = 0;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push({ ...JSON.parse(line), _file: file });
    } catch {
      malformedLineCount += 1;
    }
  }
  return { rows, malformedLineCount };
}

export function listJsonlFiles(inputPath, prefix) {
  if (!inputPath || !fs.existsSync(inputPath)) return [];
  const stat = fs.statSync(inputPath);
  if (stat.isFile()) return [inputPath];
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(inputPath)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".jsonl"))
    .sort()
    .map((name) => path.join(inputPath, name));
}

export function readJsonlFiles(files) {
  const rows = [];
  let malformedLineCount = 0;
  for (const file of files) {
    const parsed = readJsonlFile(file);
    rows.push(...parsed.rows);
    malformedLineCount += parsed.malformedLineCount;
  }
  return { rows, malformedLineCount };
}

export function resolveTrackerConfig(overrides = {}) {
  const source = config?.management || {};
  return {
    enabled: source.solBalanceTrackerEnabled ?? DEFAULT_SOL_BALANCE_TRACKER_CONFIG.enabled,
    intervalMs: Number(source.solBalanceTrackerIntervalMs ?? DEFAULT_SOL_BALANCE_TRACKER_CONFIG.intervalMs),
    botName: source.solBalanceTrackerBotName || DEFAULT_SOL_BALANCE_TRACKER_CONFIG.botName,
    residualTokenSampleEveryMs: Number(source.solBalanceTrackerResidualTokenSampleEveryMs ?? DEFAULT_SOL_BALANCE_TRACKER_CONFIG.residualTokenSampleEveryMs),
    verificationWindowMs: Number(source.solBalanceTrackerVerificationWindowMs ?? DEFAULT_SOL_BALANCE_TRACKER_CONFIG.verificationWindowMs),
    dustSol: Number(source.solBalanceTrackerDustSol ?? DEFAULT_SOL_BALANCE_TRACKER_CONFIG.dustSol),
    fabriqToleranceSol: Number(source.solBalanceTrackerFabriqToleranceSol ?? DEFAULT_SOL_BALANCE_TRACKER_CONFIG.fabriqToleranceSol),
    logDir: source.solBalanceTrackerLogDir || DEFAULT_SOL_BALANCE_TRACKER_CONFIG.logDir,
    ...overrides,
  };
}

export function baselinePath(logDir) {
  return path.join(logDir, "sol-balance-baseline.json");
}

export function readBaseline(logDir) {
  const file = baselinePath(logDir);
  if (!fs.existsSync(file)) {
    return { file, baseline: null };
  }
  return { file, baseline: JSON.parse(fs.readFileSync(file, "utf8")) };
}

export function externalFlowSol(baseline) {
  return roundSol((baseline?.flows || []).reduce((sum, flow) => sum + Number(flow.amountSol || 0), 0));
}

function normalizePosition(position) {
  const valueSol = toNumber(position.total_value_usd ?? position.current_value_usd ?? position.value_sol ?? position.valueNative);
  const pnlSol = toNumber(position.pnl_usd ?? position.pnl_sol ?? position.pnlNative);
  const pnlPct = toNumber(position.pnl_pct);
  return {
    position: position.position ?? position.position_address ?? position.address ?? null,
    pool: position.pool ?? position.pool_address ?? null,
    pair: position.pair ?? position.pool_name ?? null,
    baseMint: position.base_mint ?? position.baseMint ?? null,
    valueSol,
    pnlSol,
    pnlPct,
  };
}

export function summarizePositions(positionResult) {
  const warnings = [];
  if (positionResult?.error) warnings.push(`positions_error:${positionResult.error}`);
  const positions = Array.isArray(positionResult?.positions) ? positionResult.positions.map(normalizePosition) : [];
  let valueComplete = true;
  let pnlComplete = true;
  let openPositionValueSol = 0;
  let openPositionUnrealizedPnlSol = 0;
  let weightedPnlNumerator = 0;
  let weightedPnlDenominator = 0;

  for (const position of positions) {
    if (position.valueSol == null) {
      valueComplete = false;
      continue;
    }
    openPositionValueSol += position.valueSol;
    if (position.pnlSol == null) {
      pnlComplete = false;
    } else {
      openPositionUnrealizedPnlSol += position.pnlSol;
    }
    if (position.pnlPct != null) {
      weightedPnlNumerator += position.pnlPct * Math.abs(position.valueSol);
      weightedPnlDenominator += Math.abs(position.valueSol);
    }
  }

  if (!valueComplete) warnings.push("open_position_value_incomplete");
  if (!pnlComplete && positions.length > 0) warnings.push("open_position_pnl_incomplete");

  return {
    openPositionCount: positions.length,
    openPositionValueSol: roundSol(openPositionValueSol),
    openPositionUnrealizedPnlSol: roundSol(openPositionUnrealizedPnlSol),
    openPositionUnrealizedPnlPctWeighted: weightedPnlDenominator > 0
      ? Math.round((weightedPnlNumerator / weightedPnlDenominator) * 10_000) / 10_000
      : null,
    openPositions: positions,
    positionValueCompleteness: valueComplete ? "complete" : "partial",
    positionPnlCompleteness: pnlComplete ? "complete" : "partial",
    positionsSource: positionResult?.source || positionResult?.sourceLabel || "Agent Meridian raw relay + fallback",
    warnings,
  };
}

function isSolToken(token) {
  return token?.mint === SOL_MINT || token?.symbol === "SOL";
}

export function summarizeResidualTokens(walletBalances, { dustSol = DEFAULT_SOL_BALANCE_TRACKER_CONFIG.dustSol } = {}) {
  const warnings = [];
  if (!walletBalances) {
    return {
      residualTokenValueSol: 0,
      unresolvedResidualTokenValueSol: 0,
      residualTokens: [],
      unpricedResidualTokens: [],
      residualTokensSource: "not_sampled",
      warnings: ["residual_token_sample_pending"],
    };
  }
  if (walletBalances.error) warnings.push(`residual_tokens_error:${walletBalances.error}`);

  const solPrice = toNumber(walletBalances.sol_price);
  let residualTokenValueSol = 0;
  const residualTokens = [];
  const unpricedResidualTokens = [];

  for (const token of walletBalances.tokens || []) {
    const balance = toNumber(token.balance);
    if (isSolToken(token) || balance == null || balance <= 0) continue;
    const usd = toNumber(token.usd);
    const valueSol = usd != null && solPrice && solPrice > 0 ? usd / solPrice : null;
    const normalized = {
      mint: token.mint ?? null,
      symbol: token.symbol ?? null,
      balance,
      usd,
      valueSol: valueSol != null ? roundSol(valueSol) : null,
    };
    if (normalized.valueSol == null) {
      unpricedResidualTokens.push(normalized);
    } else if (Math.abs(normalized.valueSol) >= dustSol) {
      residualTokens.push(normalized);
      residualTokenValueSol += normalized.valueSol;
    }
  }

  if (unpricedResidualTokens.length > 0) warnings.push("unpriced_residual_tokens_present");

  return {
    solPrice: solPrice != null ? roundSol(solPrice, 6) : null,
    residualTokenValueSol: roundSol(residualTokenValueSol),
    unresolvedResidualTokenValueSol: unpricedResidualTokens.length > 0 ? null : 0,
    residualTokens,
    unpricedResidualTokens,
    residualTokensSource: "helius_wallet_balances",
    warnings,
  };
}

export function computeEquitySnapshot({
  now = new Date(),
  bot = DEFAULT_SOL_BALANCE_TRACKER_CONFIG.botName,
  wallet,
  freeSol,
  positions = [],
  positionResult = null,
  walletBalances = null,
  baseline = null,
  trackerConfig = resolveTrackerConfig(),
} = {}) {
  const warnings = [];
  const positionSummary = summarizePositions(positionResult || { positions });
  const residualSummary = summarizeResidualTokens(walletBalances, { dustSol: trackerConfig.dustSol });
  warnings.push(...positionSummary.warnings, ...residualSummary.warnings);

  const freeSolNumber = toNumber(freeSol);
  if (freeSolNumber == null) warnings.push("free_sol_unavailable");
  const baselineEquitySol = toNumber(baseline?.baselineEquitySol);
  const flowSol = externalFlowSol(baseline);
  const estimatedEquitySol = roundSol(
    (freeSolNumber || 0) + positionSummary.openPositionValueSol + residualSummary.residualTokenValueSol,
  );
  const ownerAdjustedPnlSol = baselineEquitySol != null
    ? roundSol(estimatedEquitySol - baselineEquitySol - flowSol)
    : null;
  const ownerAdjustedPnlPct = ownerAdjustedPnlSol != null && baselineEquitySol
    ? Math.round((ownerAdjustedPnlSol / baselineEquitySol) * 10_000) / 100
    : null;

  if (!baseline) warnings.push("baseline_missing");
  if (baseline?.wallet && wallet && baseline.wallet !== wallet) warnings.push("baseline_wallet_mismatch");

  return {
    ts: now.toISOString(),
    event: "sol_balance_snapshot",
    bot,
    wallet,
    freeSol: roundSol(freeSolNumber || 0),
    solPrice: residualSummary.solPrice,
    openPositionCount: positionSummary.openPositionCount,
    openPositionValueSol: positionSummary.openPositionValueSol,
    openPositionUnrealizedPnlSol: positionSummary.openPositionUnrealizedPnlSol,
    openPositionUnrealizedPnlPctWeighted: positionSummary.openPositionUnrealizedPnlPctWeighted,
    residualTokenValueSol: residualSummary.residualTokenValueSol,
    unresolvedResidualTokenValueSol: residualSummary.unresolvedResidualTokenValueSol,
    residualTokens: residualSummary.residualTokens,
    unpricedResidualTokens: residualSummary.unpricedResidualTokens,
    estimatedEquitySol,
    baselineEquitySol,
    externalFlowSol: flowSol,
    ownerAdjustedPnlSol,
    ownerAdjustedPnlPct,
    openPositions: positionSummary.openPositions,
    dataQuality: {
      freeSolSource: "rpc_getBalance",
      positionsSource: positionSummary.positionsSource,
      residualTokensSource: residualSummary.residualTokensSource,
      positionValueCompleteness: positionSummary.positionValueCompleteness,
      positionPnlCompleteness: positionSummary.positionPnlCompleteness,
      warnings,
    },
  };
}

export async function getFreeSolViaRpc({ rpcUrl = process.env.RPC_URL, wallet }) {
  if (!rpcUrl) throw new Error("RPC_URL not set");
  const connection = getSharedConnection(rpcUrl);
  const lamports = await withRpcPriority(
    RPC_PRIORITY.MANAGEMENT,
    "helius_rpc.sol_equity_balance",
    () => connection.getBalance(new PublicKey(wallet), "confirmed"),
  );
  return roundSol(lamports / LAMPORTS_PER_SOL);
}

async function defaultGetMyPositions(args) {
  const mod = await import("./tools/dlmm.js");
  return mod.getMyPositions(args);
}

async function defaultGetWalletBalances() {
  const mod = await import("./tools/wallet.js");
  return mod.getWalletBalances();
}

async function defaultGetWalletPublicKey() {
  const mod = await import("./tools/wallet.js");
  return mod.getWalletPublicKey();
}

export async function collectSolEquitySnapshot({
  bot = null,
  logDir = "logs",
  residualState = null,
  trackerConfig = resolveTrackerConfig(),
  now = new Date(),
  getFreeSol = getFreeSolViaRpc,
  getPositions = defaultGetMyPositions,
  getBalances = defaultGetWalletBalances,
  getPublicKey = defaultGetWalletPublicKey,
} = {}) {
  const warnings = [];
  const ts = now.toISOString();
  const wallet = await getPublicKey();
  const freeSol = await getFreeSol({ wallet });
  const positionResult = await getPositions({ force: true, silent: true });
  const positionSummary = summarizePositions(positionResult);
  warnings.push(...positionSummary.warnings);

  let residualSample = residualState?.lastSample || null;
  const elapsed = residualState?.lastSampleAtMs == null ? Infinity : now.getTime() - residualState.lastSampleAtMs;
  if (elapsed >= trackerConfig.residualTokenSampleEveryMs) {
    residualSample = await getBalances();
    if (residualState) {
      residualState.lastSample = residualSample;
      residualState.lastSampleAtMs = now.getTime();
    }
  }
  const { baseline } = readBaseline(logDir);
  const snapshot = computeEquitySnapshot({
    now,
    bot: bot || trackerConfig.botName,
    wallet,
    freeSol,
    positionResult,
    walletBalances: residualSample,
    baseline,
    trackerConfig,
  });
  return {
    ...snapshot,
    dataQuality: {
      ...snapshot.dataQuality,
      warnings: [...warnings, ...snapshot.dataQuality.warnings],
    },
  };
}

export function appendSolBalanceSnapshot(row, { logDir = "logs" } = {}) {
  const file = jsonlPath(logDir, "sol-balance-snapshots", new Date(row.ts));
  appendJsonl(file, row);
  return file;
}
