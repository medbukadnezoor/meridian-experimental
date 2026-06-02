import fs from "fs";
import path from "path";
import {
  appendJsonl,
  datePart,
  jsonlPath,
  listJsonlFiles,
  readJsonlFiles,
  roundSol,
} from "./sol-equity-tracker.js";

const DEFAULT_DUST_SOL = 0.002;
const DEFAULT_FABRIQ_TOLERANCE_SOL = 0.02;

function toNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toMs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeResult(result) {
  if (result && typeof result === "object") return result;
  if (typeof result !== "string") return {};
  try {
    const parsed = JSON.parse(result);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function positionId(position) {
  return position?.position ?? position?.position_address ?? position?.address ?? null;
}

function inWindow(row, startMs, endMs) {
  const ms = toMs(row.ts || row.timestamp);
  return ms != null && ms >= startMs && ms <= endMs;
}

function latestByTimestamp(rows) {
  return [...rows].sort((a, b) => (toMs(a.ts || a.timestamp) ?? 0) - (toMs(b.ts || b.timestamp) ?? 0)).at(-1) || null;
}

export function summarizeCloseActions(actionRows, { dustSol = DEFAULT_DUST_SOL } = {}) {
  const closes = [];
  const warnings = [];
  let successfulAutoswapCount = 0;
  let failedAutoswapCount = 0;
  let pricedResidualSol = 0;
  let unresolvedResidualCount = 0;
  let missingCloseOrSwapEvidence = 0;
  const closedPositions = new Set();

  for (const action of actionRows) {
    if (action.tool !== "close_position") continue;
    const result = normalizeResult(action.result);
    const success = action.success === true || result.success === true;
    const close = {
      ts: action.ts || action.timestamp || null,
      position: action.args?.position_address || action.args?.position || result.position || result.position_address || null,
      success,
      autoSwapped: result.auto_swapped,
      postCloseSwapStatus: result.post_close_swap_status ?? null,
      residualBaseMint: result.residual_base_mint ?? result.base_mint ?? null,
      residualTokenAmount: toNumber(result.residual_token_amount),
      residualTokenUsd: toNumber(result.residual_token_usd),
      residualTokenValueSol: toNumber(result.residual_token_value_sol),
    };
    closes.push(close);
    if (close.position) closedPositions.add(close.position);
    if (!success) continue;

    if (close.autoSwapped === true || close.postCloseSwapStatus === "success") {
      successfulAutoswapCount += 1;
      continue;
    }

    if (close.postCloseSwapStatus === "failed") {
      failedAutoswapCount += 1;
      const valued = close.residualTokenValueSol ?? toNumber(result.residual_sol) ?? null;
      if (valued != null && Math.abs(valued) >= dustSol) {
        pricedResidualSol += valued;
      } else if (close.residualTokenUsd != null) {
        // USD-valued residual evidence is enough to prove the close did not lose
        // the token silently; SOL valuation should come from the wallet snapshot.
      } else if (close.residualTokenAmount != null && Math.abs(close.residualTokenAmount) > 0) {
        unresolvedResidualCount += 1;
      }
      continue;
    }

    const hasResidualEvidence = close.residualTokenValueSol != null || close.residualTokenUsd != null || close.residualTokenAmount != null;
    if (!hasResidualEvidence) {
      missingCloseOrSwapEvidence += 1;
      warnings.push(`close_missing_swap_or_residual_evidence:${close.position || "unknown"}`);
    }
  }

  return {
    closes,
    closedPositions,
    closedPositionCount: closes.filter((close) => close.success).length,
    successfulAutoswapCount,
    failedAutoswapCount,
    pricedResidualSol: roundSol(pricedResidualSol),
    unresolvedResidualCount,
    missingCloseOrSwapEvidence,
    warnings,
  };
}

export function detectDisappearedPositions(snapshots, closeSummary) {
  if (snapshots.length < 2) return [];
  const first = snapshots[0];
  const latest = snapshots.at(-1);
  const firstOpen = new Set((first.openPositions || []).map(positionId).filter(Boolean));
  const latestOpen = new Set((latest.openPositions || []).map(positionId).filter(Boolean));
  const disappeared = [];
  for (const position of firstOpen) {
    if (!latestOpen.has(position) && !closeSummary.closedPositions.has(position)) disappeared.push(position);
  }
  return disappeared;
}

export function buildSolPnlVerification({
  snapshots,
  actionRows = [],
  fabriqRows = [],
  malformedSnapshotLines = 0,
  malformedActionLines = 0,
  windowStart,
  windowEnd,
  bot = null,
  wallet = null,
  dustSol = DEFAULT_DUST_SOL,
  fabriqToleranceSol = DEFAULT_FABRIQ_TOLERANCE_SOL,
  evidence = {},
} = {}) {
  const warnings = [];
  const startMs = toMs(windowStart);
  const endMs = toMs(windowEnd);
  const windowSnapshots = startMs != null && endMs != null
    ? snapshots.filter((row) => inWindow(row, startMs, endMs))
    : snapshots;
  windowSnapshots.sort((a, b) => (toMs(a.ts) ?? 0) - (toMs(b.ts) ?? 0));
  const latest = windowSnapshots.at(-1) || null;
  const first = windowSnapshots[0] || null;

  if (malformedSnapshotLines > 0) warnings.push(`malformed_balance_snapshot_lines:${malformedSnapshotLines}`);
  if (malformedActionLines > 0) warnings.push(`malformed_action_lines:${malformedActionLines}`);
  if (!latest) {
    return {
      ts: new Date().toISOString(),
      event: "sol_pnl_verification",
      bot,
      wallet,
      windowStart,
      windowEnd,
      verdict: "data_gap",
      ownerAdjustedPnlSol: null,
      equityDeltaSol: null,
      externalFlowSol: null,
      fabriqPnlSol: null,
      fabriqDeltaSol: null,
      openPositionCount: 0,
      closedPositionCount: 0,
      successfulAutoswapCount: 0,
      failedAutoswapCount: 0,
      residualTokenValueSol: null,
      unresolvedResidualTokenValueSol: null,
      warnings: ["no_balance_snapshots"],
      evidence,
    };
  }

  warnings.push(...(latest.dataQuality?.warnings || []));
  const closeSummary = summarizeCloseActions(actionRows, { dustSol });
  warnings.push(...closeSummary.warnings);
  const disappeared = detectDisappearedPositions(windowSnapshots, closeSummary);
  if (disappeared.length > 0) warnings.push(`position_disappeared_without_close_evidence:${disappeared.join(",")}`);

  const latestFabriq = latestByTimestamp(fabriqRows);
  const fabriqPnlSol = toNumber(latestFabriq?.fabriqPnlSol ?? latestFabriq?.pnlSol);
  const ownerAdjustedPnlSol = toNumber(latest.ownerAdjustedPnlSol);
  const fabriqDeltaSol = fabriqPnlSol != null && ownerAdjustedPnlSol != null
    ? roundSol(ownerAdjustedPnlSol - fabriqPnlSol)
    : null;
  if (fabriqDeltaSol != null && Math.abs(fabriqDeltaSol) > fabriqToleranceSol) {
    warnings.push(`fabriq_divergence:${fabriqDeltaSol}`);
  }

  const unresolvedResidualTokenValueSol = latest.unresolvedResidualTokenValueSol;
  const residualTokenValueSol = roundSol((toNumber(latest.residualTokenValueSol) || 0) + (closeSummary.pricedResidualSol || 0));
  const hasDataGap = warnings.some((warning) =>
    warning === "baseline_missing" ||
    warning === "residual_token_sample_pending" ||
    warning.startsWith("positions_error:") ||
    warning.startsWith("residual_tokens_error:"),
  );

  let verdict = "verified";
  if (hasDataGap) verdict = "data_gap";
  if (disappeared.length > 0) verdict = "position_disappeared_without_close_evidence";
  if (closeSummary.missingCloseOrSwapEvidence > 0) verdict = "missing_close_or_swap_evidence";
  if (unresolvedResidualTokenValueSol == null || closeSummary.unresolvedResidualCount > 0) verdict = "unresolved_residual_exposure";
  if (fabriqDeltaSol != null && Math.abs(fabriqDeltaSol) > fabriqToleranceSol) verdict = "fabriq_divergence";
  if (verdict === "verified" && Math.abs(residualTokenValueSol) >= dustSol) verdict = "verified_with_residuals";

  return {
    ts: new Date().toISOString(),
    event: "sol_pnl_verification",
    bot: bot || latest.bot || null,
    wallet: wallet || latest.wallet || null,
    windowStart: first?.ts || windowStart || null,
    windowEnd: latest.ts || windowEnd || null,
    verdict,
    ownerAdjustedPnlSol,
    equityDeltaSol: first ? roundSol(toNumber(latest.estimatedEquitySol) - toNumber(first.estimatedEquitySol)) : null,
    externalFlowSol: toNumber(latest.externalFlowSol),
    fabriqPnlSol,
    fabriqDeltaSol,
    openPositionCount: Number(latest.openPositionCount || 0),
    closedPositionCount: closeSummary.closedPositionCount,
    successfulAutoswapCount: closeSummary.successfulAutoswapCount,
    failedAutoswapCount: closeSummary.failedAutoswapCount,
    residualTokenValueSol,
    unresolvedResidualTokenValueSol,
    warnings,
    evidence: {
      balanceSnapshotFile: evidence.balanceSnapshotFile ?? (latest._file ? path.basename(latest._file) : null),
      actionFiles: evidence.actionFiles || [],
      fabriqSnapshotFile: evidence.fabriqSnapshotFile || null,
    },
  };
}

export function buildVerification({
  snapshots = [],
  actions = [],
  actionRows = actions,
  fabriqSnapshots = [],
  fabriqRows = fabriqSnapshots,
  ...rest
} = {}) {
  return buildSolPnlVerification({
    snapshots,
    actionRows,
    fabriqRows,
    ...rest,
  });
}

export function loadVerificationInputs({
  logDir = "logs",
  windowMs = 1_800_000,
  end = new Date(),
} = {}) {
  const endMs = end.getTime();
  const start = new Date(endMs - windowMs);
  const snapshotFiles = listJsonlFiles(logDir, "sol-balance-snapshots-");
  const actionFiles = listJsonlFiles(logDir, "actions-");
  const fabriqFiles = listJsonlFiles(logDir, "fabriq-pnl-snapshots-");
  const snapshots = readJsonlFiles(snapshotFiles);
  const actions = readJsonlFiles(actionFiles);
  const fabriq = readJsonlFiles(fabriqFiles);
  const windowActionRows = actions.rows.filter((row) => inWindow(row, start.getTime(), endMs));
  const windowFabriqRows = fabriq.rows.filter((row) => inWindow(row, start.getTime(), endMs));
  return {
    snapshots: snapshots.rows,
    actionRows: windowActionRows,
    fabriqRows: windowFabriqRows,
    malformedSnapshotLines: snapshots.malformedLineCount,
    malformedActionLines: actions.malformedLineCount,
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    evidence: {
      actionFiles: actionFiles.map((file) => path.basename(file)),
      fabriqSnapshotFile: fabriqFiles.length > 0 ? path.basename(fabriqFiles.at(-1)) : null,
    },
  };
}

export function appendSolPnlVerification(row, { logDir = "logs" } = {}) {
  const file = jsonlPath(logDir, "sol-pnl-verification", new Date(row.ts));
  appendJsonl(file, row);
  return file;
}

export function latestVerificationRow(logDir = "logs") {
  const files = listJsonlFiles(logDir, "sol-pnl-verification-");
  const { rows } = readJsonlFiles(files);
  return latestByTimestamp(rows);
}

export function latestBalanceSnapshot(logDir = "logs") {
  const files = listJsonlFiles(logDir, "sol-balance-snapshots-");
  const { rows } = readJsonlFiles(files);
  return latestByTimestamp(rows);
}

export function writeReport(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

export function verificationFileForDate(logDir, date = new Date()) {
  return path.join(logDir, `sol-pnl-verification-${datePart(date)}.jsonl`);
}
