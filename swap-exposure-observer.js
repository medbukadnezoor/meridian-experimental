import {
  appendJsonl,
  jsonlPath,
  listJsonlFiles,
  readJsonlFiles,
} from "./sol-equity-tracker.js";
import { quoteSwapToken } from "./tools/wallet.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

function toNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isDisappearedVerification(verification) {
  return verification?.verdict === "position_disappeared_without_close_evidence" ||
    (verification?.warnings || []).some((warning) => String(warning).startsWith("position_disappeared_without_close_evidence:"));
}

function residualKey(token) {
  return `${token?.mint || "unknown"}:${token?.balance ?? "unknown"}:${token?.usd ?? "unknown"}`;
}

export async function observeResidualSwapExposure({
  snapshot,
  verification,
  logDir = "logs",
  minResidualValueSol = 0.002,
  quoteSwap = quoteSwapToken,
  observerState = null,
} = {}) {
  const residualTokens = Array.isArray(snapshot?.residualTokens) ? snapshot.residualTokens : [];
  const manualOrExternalCloseSuspected = isDisappearedVerification(verification);
  const disappearedPositions = verification?.disappearedPositions || [];
  const rows = [];

  for (const token of residualTokens) {
    if (!token?.mint || token.mint === SOL_MINT) continue;
    const balance = toNumber(token.balance);
    const valueSol = toNumber(token.valueSol);
    if (balance == null || balance <= 0) continue;
    if (valueSol != null && Math.abs(valueSol) < minResidualValueSol) continue;

    const key = residualKey(token);
    if (observerState?.seenResidualQuoteKeys?.has(key)) continue;

    const quote = await quoteSwap({
      input_mint: token.mint,
      output_mint: "SOL",
      amount: balance,
    });
    const row = {
      ts: new Date().toISOString(),
      event: "residual_swap_quote_observer",
      trace_source: "quote_only_residual_observer",
      bot: snapshot?.bot ?? verification?.bot ?? null,
      wallet: snapshot?.wallet ?? verification?.wallet ?? null,
      manual_or_external_close_suspected: manualOrExternalCloseSuspected,
      disappeared_positions: disappearedPositions,
      verifier_verdict: verification?.verdict ?? null,
      verifier_warnings: verification?.warnings || [],
      residual_mint: token.mint,
      residual_symbol: token.symbol ?? null,
      residual_balance: balance,
      residual_usd: toNumber(token.usd),
      residual_value_sol: valueSol,
      quote_success: quote.success === true,
      quote_error: quote.error ?? null,
      swap_trace: quote.swap_trace ?? null,
    };
    appendJsonl(jsonlPath(logDir, "residual-swap-quote-observer", new Date(row.ts)), row);
    rows.push(row);
    observerState?.seenResidualQuoteKeys?.add(key);
  }

  return rows;
}

export function loadSwapExposureRows({ logDir = "logs" } = {}) {
  const postCloseFiles = listJsonlFiles(logDir, "post-close-swap-trace-");
  const residualFiles = listJsonlFiles(logDir, "residual-swap-quote-observer-");
  const postClose = readJsonlFiles(postCloseFiles);
  const residual = readJsonlFiles(residualFiles);
  return {
    postCloseRows: postClose.rows,
    residualRows: residual.rows,
    malformedLineCount: postClose.malformedLineCount + residual.malformedLineCount,
    files: {
      postClose: postCloseFiles.map((file) => file.split("/").at(-1)),
      residual: residualFiles.map((file) => file.split("/").at(-1)),
    },
  };
}

function worstBy(rows, selector, limit = 20) {
  return [...rows]
    .filter((row) => selector(row) != null)
    .sort((a, b) => Math.abs(selector(b)) - Math.abs(selector(a)))
    .slice(0, limit);
}

function groupCount(rows, selector) {
  const counts = new Map();
  for (const row of rows) {
    const key = selector(row) || "unknown";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, count }));
}

export function buildSwapExposureSummary({ postCloseRows = [], residualRows = [], malformedLineCount = 0, files = {} } = {}) {
  const postCloseWithTrace = postCloseRows.filter((row) => row.swap_trace);
  const residualWithTrace = residualRows.filter((row) => row.swap_trace);
  return {
    generatedAt: new Date().toISOString(),
    postCloseTraceCount: postCloseRows.length,
    residualQuoteCount: residualRows.length,
    malformedLineCount,
    files,
    worstExecutedByValueLeakBps: worstBy(postCloseWithTrace, (row) => row.swap_trace?.value_leak_bps),
    worstExecutedByPriceImpactBps: worstBy(postCloseWithTrace, (row) => row.swap_trace?.price_impact_bps),
    worstResidualQuotesByPriceImpactBps: worstBy(residualWithTrace, (row) => row.swap_trace?.price_impact_bps),
    residualManualSuspectedCount: residualRows.filter((row) => row.manual_or_external_close_suspected).length,
    routerBreakdown: groupCount([...postCloseWithTrace, ...residualWithTrace], (row) => row.swap_trace?.router),
    modeBreakdown: groupCount([...postCloseWithTrace, ...residualWithTrace], (row) => row.swap_trace?.mode),
    statusBreakdown: groupCount(postCloseRows, (row) => row.post_close_swap_status),
  };
}
