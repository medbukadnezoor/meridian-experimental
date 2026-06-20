// telegram-render.js
//
// Pure, dependency-free presentation layer for the Meridian Telegram control
// menu. Everything here takes plain data (view-models built in index.js) and
// returns HTML strings. No imports, no runtime singletons, no I/O — so the
// rendered output is deterministic and can be exercised with fixtures by
// scripts/verify-telegram-message-budget.js.
//
// Telegram client surfaces are narrow (phone width) and clip long messages, so
// every builder is designed to stay well under TELEGRAM_BUDGETS and to drop
// unknown/placeholder fields instead of printing "?" noise.

// ─── Message length budgets (HTML chars, incl. tags) ─────────────────────────
// Worst-case fixtures must render at or under these. They are intentionally far
// below Telegram's 4096 hard limit so the rendered text never visually clips.
export const TELEGRAM_BUDGETS = {
  dashboard: 900,
  positionsPage: 1100,
  detail: 900,
  closePreview: 700,
  closeAllPreview: 1100,
  dustMenu: 1500,
  result: 700,
};

export const DETAIL_TABS = ["summary", "range", "market"];

// ─── Primitives ──────────────────────────────────────────────────────────────
function finite(value) {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function shortAddress(value, head = 4, tail = 4) {
  const text = String(value || "");
  if (text.length <= head + tail + 1) return text || "?";
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

export function formatNum(value, digits = 2) {
  const num = finite(value);
  if (num == null) return "?";
  return num.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function formatCompactUsd(value) {
  const num = finite(value);
  if (num == null) return "$?";
  const abs = Math.abs(num);
  if (abs >= 1_000_000) return `$${formatNum(num / 1_000_000, 2)}M`;
  if (abs >= 1_000) return `$${formatNum(num / 1_000, 1)}k`;
  return `$${formatNum(num, 2)}`;
}

// signed=true prepends +/- (use for PnL). Balances like value/fees stay unsigned.
export function formatCurrency(value, solMode = true, { signed = false } = {}) {
  const cur = solMode ? "◎" : "$";
  const num = finite(value);
  if (num == null) return `${cur}?`;
  const sign = signed ? (num > 0 ? "+" : num < 0 ? "-" : "") : (num < 0 ? "-" : "");
  return `${sign}${cur}${formatNum(Math.abs(num), solMode ? 4 : 2)}`;
}

export function formatSignedPct(value) {
  const num = finite(value);
  if (num == null) return "?%";
  return `${num > 0 ? "+" : ""}${formatNum(num, 2)}%`;
}

export function formatAgeMinutes(minutes) {
  const value = finite(minutes);
  if (value == null) return "?";
  const total = Math.max(0, Math.floor(value));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}

// ─── Visual language ─────────────────────────────────────────────────────────
// Status label (from index.js positionRangeStatus) → emoji + short tag.
export function statusEmoji(statusLabel) {
  switch (statusLabel) {
    case "IN": return "🟢";
    case "OOR ABOVE": return "🔺";
    case "OOR BELOW": return "🔻";
    case "OOR": return "🔴";
    case "API LAG": return "🟡";
    case "DEGRADED PNL": return "🟠";
    default: return "⚪";
  }
}

export function statusTag(statusLabel) {
  switch (statusLabel) {
    case "IN": return "IN";
    case "OOR ABOVE": return "OOR↑";
    case "OOR BELOW": return "OOR↓";
    case "OOR": return "OOR";
    case "API LAG": return "LAG";
    case "DEGRADED PNL": return "DEG";
    default: return "?";
  }
}

export function pnlGlyph(pnlPct) {
  const num = finite(pnlPct);
  if (num == null) return "▬";
  if (num > 0) return "▲";
  if (num < 0) return "▼";
  return "▬";
}

// 5-cell range bar showing where the active bin sits across the position range.
export function rangeBar(view = {}) {
  const lower = finite(view.lowerBin);
  const upper = finite(view.upperBin);
  const active = finite(view.activeBin);
  if (lower == null || upper == null || active == null || upper <= lower) return "▱▱▱▱▱";
  if (active < lower) return "▰▱▱▱▱";
  if (active > upper) return "▱▱▱▱▰";
  const pct = Math.max(0, Math.min(1, (active - lower) / (upper - lower)));
  const idx = Math.min(4, Math.max(0, Math.round(pct * 4)));
  return Array.from({ length: 5 }, (_, i) => (i === idx ? "▰" : "▱")).join("");
}

// Drop empty lines so optional/unknown fields don't leave blank gaps.
function joinLines(lines) {
  return lines.filter((line) => line != null).join("\n");
}

// Strip HTML tags — used for the plain-text fallback when an HTML send fails.
export function stripTags(html) {
  return String(html ?? "").replace(/<[^>]+>/g, "");
}

// Convert the light markdown the cycle/LLM reports emit into safe Telegram HTML.
// Escapes everything first, then re-applies a tiny, fixed allow-list of styles so
// free-text (LLM) output can never inject markup or break the HTML parser.
export function mdToTelegramHtml(text) {
  let out = escapeHtml(text);
  // `code` spans first so ** inside them is left alone.
  out = out.replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`);
  // **bold**
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_, bold) => `<b>${bold}</b>`);
  // Leading "- " bullets → "• " for a cleaner look.
  out = out.replace(/^(\s*)-\s+/gm, (_, indent) => `${indent}• `);
  return out;
}

// Safety net only — builders are designed to fit, but never let a runaway
// string blow the Telegram limit or visually clip.
export function clampHtml(html, max) {
  const text = String(html ?? "");
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const cut = slice.lastIndexOf("\n");
  return `${(cut > max * 0.5 ? slice.slice(0, cut) : slice).trimEnd()}…`;
}

// ─── Position card (2 lines, scannable) ──────────────────────────────────────
export function buildPositionCompactLine(view = {}, index = 0) {
  const n = (view.index ?? index) + 1;
  const pair = escapeHtml(view.pair || shortAddress(view.address));
  const emoji = statusEmoji(view.statusLabel);
  const pnl = `${pnlGlyph(view.pnlPct)} <b>${escapeHtml(formatSignedPct(view.pnlPct))}</b>`;
  const value = escapeHtml(formatCurrency(view.value, view.solMode));
  const fees = escapeHtml(formatCurrency(view.fees, view.solMode));
  const tag = escapeHtml(statusTag(view.statusLabel));
  const age = escapeHtml(formatAgeMinutes(view.ageMin));
  return joinLines([
    `${emoji} <b>${n}. ${pair}</b> ${pnl}`,
    `${value} · 🪙 ${fees} · ${rangeBar(view)} ${tag} · ${age}`,
  ]);
}

// SOL amount helpers — the dashboard is SOL-denominated, not USD.
function solAmount(value) {
  const num = finite(value);
  return num == null ? "◎—" : `◎${formatNum(num, 4)}`;
}
function signedSol(value) {
  const num = finite(value);
  if (num == null) return "◎—";
  return `${num >= 0 ? "+" : "-"}◎${formatNum(Math.abs(num), 4)}`;
}

// ─── Dashboard (short — no position cards) ───────────────────────────────────
// Equity is shown in SOL. The SOL-equity sidecar (sol-equity-tracker) feeds the
// day PnL (since the WIB day cutoff), the previous-day balance, and since-baseline
// owner-adjusted PnL — all in SOL.
export function buildDashboardHtml(summary = {}) {
  const runState = summary.running ? "🟢 Running" : "⏸ Paused";
  const dry = summary.dryRun ? " · 🧪 dry run" : "";
  const t = summary.tracker || {};
  const trackerLines = [];
  if (t.available) {
    const dayPnl = t.dayPnlSol != null
      ? `${pnlGlyph(t.dayPnlSol)} ${signedSol(t.dayPnlSol)}${t.dayPnlPct != null ? ` (${formatSignedPct(t.dayPnlPct)})` : ""}`
      : "—";
    const sinceBase = t.ownerPnlSol != null
      ? `${signedSol(t.ownerPnlSol)}${t.ownerPnlPct != null ? ` (${formatSignedPct(t.ownerPnlPct)})` : ""}`
      : "—";
    trackerLines.push(
      `📈 <b>SOL Equity</b>${t.stale ? " ⚠️ stale" : ""}`,
      `   equity <b>${solAmount(t.equitySol)}</b> · since base ${escapeHtml(sinceBase)}`,
      `   day ${escapeHtml(dayPnl)} · prev-day ${solAmount(t.prevDaySol)}`,
    );
  } else {
    trackerLines.push(`📈 <i>SOL equity tracker: no snapshot data</i>`);
  }
  return clampHtml(joinLines([
    `📊 <b>Meridian Control</b>`,
    `<i>${escapeHtml(summary.nowLabel || "")} · ${runState}${dry}</i>`,
    "",
    `💰 Wallet <b>${solAmount(summary.sol)}</b>  ·  ${escapeHtml(formatCompactUsd(summary.solUsd))}`,
    `🏦 Equity <b>${solAmount(summary.equitySol)}</b>`,
    `📦 Positions <b>${summary.open ?? 0}/${summary.maxPositions ?? "?"}</b> · ${escapeHtml(formatCurrency(summary.totalValue, summary.solMode))} · 🪙 ${escapeHtml(formatCurrency(summary.totalFees, summary.solMode))}`,
    "",
    ...trackerLines,
  ]), TELEGRAM_BUDGETS.dashboard);
}

// ─── Positions page ──────────────────────────────────────────────────────────
export function buildPositionsPageHtml({ views = [], total = 0, maxPositions = "?", nowLabel = "" } = {}) {
  const body = views.length
    ? views.map((view) => buildPositionCompactLine(view)).join("\n\n")
    : "No open positions.";
  return clampHtml(joinLines([
    `📦 <b>Positions ${total}/${maxPositions}</b>`,
    `<i>${escapeHtml(nowLabel)}</i>`,
    "",
    body,
  ]), TELEGRAM_BUDGETS.positionsPage);
}

// ─── Position detail (tabbed) ────────────────────────────────────────────────
function detailHeader(view, tabLabel) {
  const pair = escapeHtml(view.pair || shortAddress(view.address));
  const suffix = tabLabel ? ` · <i>${escapeHtml(tabLabel)}</i>` : "";
  return `${statusEmoji(view.statusLabel)} <b>${pair}</b>${suffix}`;
}

function buildDetailSummary(view) {
  const opt = (cond, line) => (cond ? line : null);
  const claimed = finite(view.claimed);
  return joinLines([
    detailHeader(view, null),
    `<code>${escapeHtml(shortAddress(view.address, 6, 6))}</code>`,
    "",
    `📈 PnL ${pnlGlyph(view.pnlPct)} <b>${escapeHtml(formatSignedPct(view.pnlPct))}</b> · ${escapeHtml(formatCurrency(view.pnlUsd, view.solMode, { signed: true }))}`,
    `💵 Value ${escapeHtml(formatCurrency(view.value, view.solMode))}`,
    `🪙 Fees ${escapeHtml(formatCurrency(view.fees, view.solMode))} unclaimed`,
    opt(claimed != null, `   ${escapeHtml(formatCurrency(view.claimed, view.solMode))} claimed`),
    `⏱ ${escapeHtml(formatAgeMinutes(view.ageMin))} · ${escapeHtml(statusTag(view.statusLabel))}`,
  ]);
}

function buildDetailRange(view) {
  const opt = (cond, line) => (cond ? line : null);
  const width = finite(view.width);
  const binStep = finite(view.binStep);
  const baseFee = finite(view.baseFee);
  const down = finite(view.downCoverage);
  return joinLines([
    detailHeader(view, "Range"),
    "",
    `${rangeBar(view)}  ${escapeHtml(view.rangeLabel || statusTag(view.statusLabel))}`,
    `🎯 bins ${escapeHtml(view.lowerBin ?? "?")} → ${escapeHtml(view.upperBin ?? "?")} · active ${escapeHtml(view.activeBin ?? "?")}`,
    joinLines([
      `📏 width ${escapeHtml(width ?? "?")}`,
      opt(binStep != null, `step ${escapeHtml(view.binStep)}`),
      opt(baseFee != null, `base fee ${escapeHtml(view.baseFee)}%`),
    ].filter(Boolean)).replaceAll("\n", " · "),
    opt(down != null, `🛡 coverage ${escapeHtml(view.downCoverage)}% down`),
  ]);
}

function buildDetailMarket(view) {
  const opt = (cond, line) => (cond ? line : null);
  const entry = finite(view.entryMcap);
  const feeTvl = finite(view.feePerTvl);
  const deploy = finite(view.deploySol);
  const lines = [
    opt(entry != null, `🏷 entry mcap ${escapeHtml(formatCompactUsd(view.entryMcap))}`),
    opt(feeTvl != null, `📊 fee/aTVL ${escapeHtml(view.feePerTvl)}%`),
    opt(deploy != null, `🚀 deploy ◎${escapeHtml(formatNum(view.deploySol, 2))}`),
    opt(view.strategy, `🧭 strategy ${escapeHtml(view.strategy)}`),
  ].filter(Boolean);
  return joinLines([
    detailHeader(view, "Market"),
    "",
    lines.length ? joinLines(lines) : "No market metadata recorded for this position yet.",
  ]);
}

export function buildPositionDetailHtml(view = {}, tab = "summary") {
  let body;
  if (tab === "range") body = buildDetailRange(view);
  else if (tab === "market") body = buildDetailMarket(view);
  else body = buildDetailSummary(view);
  return clampHtml(body, TELEGRAM_BUDGETS.detail);
}

// ─── Close previews ──────────────────────────────────────────────────────────
export function buildClosePreviewHtml(view = {}, ttlSeconds = 60) {
  return clampHtml(joinLines([
    `⚠️ <b>Confirm Close</b>`,
    "",
    buildPositionCompactLine(view),
    "",
    `Routes through the <code>close_position</code> executor and keeps post-close autoswap evidence.`,
    `⏳ Expires in ${ttlSeconds}s.`,
  ]), TELEGRAM_BUDGETS.closePreview);
}

function closeAllLine(view, index) {
  const n = index + 1;
  const pair = escapeHtml(view.pair || shortAddress(view.address));
  const value = escapeHtml(formatCurrency(view.value, view.solMode));
  const pnl = escapeHtml(formatSignedPct(view.pnlPct));
  return `${n}. ${statusEmoji(view.statusLabel)} ${pair} · ${value} · ${pnl}`;
}

// ─── Autonomous cycle report (management/screening) ──────────────────────────
// items: [{ view, tag, notes? }]. tag is the per-position action label (already
// decorated by the caller, e.g. "STAY", "⚡ CLOSE"). notes are pre-escaped or
// plain strings that get escaped here.
export function buildCyclePositionCard(item = {}) {
  const view = item.view || {};
  const pair = escapeHtml(view.pair || shortAddress(view.address));
  const emoji = statusEmoji(view.statusLabel);
  const pnl = `${pnlGlyph(view.pnlPct)} <b>${escapeHtml(formatSignedPct(view.pnlPct))}</b>`;
  const tag = item.tag ? ` · ${escapeHtml(item.tag)}` : "";
  const value = escapeHtml(formatCurrency(view.value, view.solMode));
  const fees = escapeHtml(formatCurrency(view.fees, view.solMode));
  const yld = finite(view.feePerTvl) != null ? ` · yield ${escapeHtml(formatNum(view.feePerTvl, 2))}%` : "";
  const age = escapeHtml(formatAgeMinutes(view.ageMin));
  const range = escapeHtml(view.rangeLabel || statusTag(view.statusLabel));
  const noteLines = (item.notes || []).filter(Boolean).map((note) => `   ${escapeHtml(note)}`);
  return joinLines([
    `${emoji} <b>${pair}</b>  ${pnl}${tag}`,
    `${value} · 🪙 ${fees}${yld} · ${age} · ${range}`,
    ...noteLines,
  ]);
}

export function buildCycleReportHtml({ headline = null, items = [], totalValue = 0, totalFees = 0, solMode = true, actionSummary = "no action", extra = null } = {}) {
  const cards = items.length
    ? items.map((item) => buildCyclePositionCard(item)).join("\n\n")
    : "No open positions.";
  return joinLines([
    headline ? `<b>${escapeHtml(headline)}</b>` : null,
    headline ? "" : null,
    cards,
    "",
    `💼 <b>${items.length} open</b> · ${escapeHtml(formatCurrency(totalValue, solMode))} · 🪙 ${escapeHtml(formatCurrency(totalFees, solMode))} · ${escapeHtml(actionSummary)}`,
    extra ? "" : null,
    extra || null,
  ]);
}

// ─── Dust menu ───────────────────────────────────────────────────────────────
// Spam verdict icon (risk from GMGN + OKX, classified in index.js).
export function dustSpamIcon(verdict) {
  if (verdict === "spam") return "🚫";
  if (verdict === "ok") return "✅";
  return "❔";
}

// tokens: [{ symbol, mint, amount, valueSol, usd, verdict, flags }]
export function buildDustMenuHtml({ tokens = [], thresholdUsd = 5, nowLabel = "" } = {}) {
  const body = tokens.length
    ? tokens.map((t, i) => {
        const sym = escapeHtml(t.symbol || shortAddress(t.mint));
        const amt = escapeHtml(formatNum(t.amount, finite(t.amount) != null && Math.abs(t.amount) >= 1000 ? 0 : 4));
        const sol = `◎${escapeHtml(formatNum(t.valueSol, 4))}`;
        const usd = escapeHtml(formatCompactUsd(t.usd));
        const flags = (t.flags || []).slice(0, 3).join(", ");
        return joinLines([
          `${i + 1}. ${dustSpamIcon(t.verdict)} <b>${sym}</b>`,
          `${amt} · ${sol} · ${usd}${flags ? ` · <i>${escapeHtml(flags)}</i>` : ""}`,
        ]);
      }).join("\n\n")
    : "No sellable dust candidates.";
  return clampHtml(joinLines([
    `🧹 <b>Dust Tokens</b>`,
    `<i>≤ ${escapeHtml(formatCompactUsd(thresholdUsd))} · excludes SOL/USDC/USDT + active mints</i>`,
    nowLabel ? `<i>${escapeHtml(nowLabel)}</i>` : null,
    "",
    body,
    "",
    `🚫 spam · ✅ ok · ❔ unknown — risk via GMGN + OKX`,
  ]), TELEGRAM_BUDGETS.dustMenu);
}

export function buildCloseAllPreviewHtml({ views = [], totalValue = 0, totalPnlPct = null, solMode = true, ttlSeconds = 60, maxRows = 4 } = {}) {
  const shown = views.slice(0, maxRows);
  const extra = views.length - shown.length;
  const pnlPart = totalPnlPct != null ? ` · ${escapeHtml(formatSignedPct(totalPnlPct))}` : "";
  return clampHtml(joinLines([
    `⚠️ <b>Confirm Close All</b>`,
    `${views.length} positions · ${escapeHtml(formatCurrency(totalValue, solMode))}${pnlPart}`,
    "",
    shown.map((view, index) => closeAllLine(view, index)).join("\n"),
    extra > 0 ? `…and ${extra} more` : null,
    "",
    `Sequential executor closes · ⏳ ${ttlSeconds}s`,
  ]), TELEGRAM_BUDGETS.closeAllPreview);
}
