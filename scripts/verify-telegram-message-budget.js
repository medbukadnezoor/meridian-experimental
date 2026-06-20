#!/usr/bin/env node
//
// Renders worst-case Telegram menu fixtures through the pure ./telegram-render.js
// module and asserts every surface stays within TELEGRAM_BUDGETS. This is the
// rendered-length guard the source scanners cannot provide: it actually builds
// the HTML and measures it, so a regression that re-bloats the dashboard or
// detail tabs fails here instead of silently clipping on a phone.

import {
  TELEGRAM_BUDGETS,
  buildDashboardHtml,
  buildPositionsPageHtml,
  buildPositionDetailHtml,
  buildClosePreviewHtml,
  buildCloseAllPreviewHtml,
  buildCycleReportHtml,
  buildDustMenuHtml,
  mdToTelegramHtml,
} from "../telegram-render.js";

// A deliberately hostile position view: long pair, large numbers, all fields set.
function fatView(index) {
  return {
    index,
    pair: "SUPERLONGTOKENNAME-SOL",
    address: "PoSiT1oNAddre55Exampl3Long000000000000000000",
    statusLabel: "OOR ABOVE",
    rangeLabel: "OOR above 9999m ⚠ API lag: API: OOR 9999m",
    pnlPct: -1234.5678,
    pnlUsd: -1234.5678,
    value: 123456.789,
    fees: 9876.5432,
    claimed: 1234.5678,
    lowerBin: -123456,
    upperBin: 654321,
    activeBin: 999999,
    binStep: 250,
    width: 777777,
    downCoverage: 99.99,
    baseFee: 12.5,
    ageMin: 99999,
    deploySol: 12345.6789,
    entryMcap: 123456789,
    feePerTvl: 99.99,
    strategy: "scout_tight_single_sided_bid_ask",
    solMode: true,
  };
}

const checks = [];
function budgetCheck(label, html, budget) {
  const len = String(html ?? "").length;
  checks.push({ label, ok: len <= budget, detail: `${len}/${budget}` });
}

// Dashboard — never carries position cards; SOL-denominated with sidecar block.
budgetCheck("dashboard within budget", buildDashboardHtml({
  nowLabel: "Jun 20 13:49 WIB",
  running: true,
  dryRun: true,
  sol: 12345.6789,
  solUsd: 1234567.89,
  equitySol: 123456.789,
  open: 8,
  maxPositions: 8,
  totalValue: 999999.99,
  totalFees: 9999.99,
  solMode: true,
  tracker: {
    available: true,
    stale: true,
    asOf: "2026-06-20T06:49:00.000Z",
    equitySol: 123456.789,
    ownerPnlSol: -1234.5678,
    ownerPnlPct: -12.34,
    baselineEquitySol: 124691.3,
    dayPnlSol: -987.6543,
    dayPnlPct: -7.89,
    prevDaySol: 124444.4443,
  },
}), TELEGRAM_BUDGETS.dashboard);

// Positions page — full page of 3 hostile cards.
budgetCheck("positions page (3 cards) within budget", buildPositionsPageHtml({
  views: [fatView(0), fatView(1), fatView(2)],
  total: 99,
  maxPositions: 99,
  nowLabel: "Jun 20 13:49 WIB",
}), TELEGRAM_BUDGETS.positionsPage);

// Each detail tab.
for (const tab of ["summary", "range", "market"]) {
  budgetCheck(`detail tab "${tab}" within budget`, buildPositionDetailHtml(fatView(0), tab), TELEGRAM_BUDGETS.detail);
}

// Close preview.
budgetCheck("close preview within budget", buildClosePreviewHtml(fatView(0), 60), TELEGRAM_BUDGETS.closePreview);

// Close-all — many positions, but capped to 4 rows + overflow summary.
budgetCheck("close-all preview within budget", buildCloseAllPreviewHtml({
  views: Array.from({ length: 25 }, (_, i) => fatView(i)),
  totalValue: 999999.99,
  totalPnlPct: -1234.56,
  solMode: true,
  ttlSeconds: 60,
}), TELEGRAM_BUDGETS.closeAllPreview);

// Cycle report (management/screening) with a full slate of positions stays
// within a comfortable bound for autonomous messages.
budgetCheck("management cycle report within budget", buildCycleReportHtml({
  items: Array.from({ length: 4 }, (_, i) => ({
    tag: i === 0 ? "⚡ CLOSE" : "STAY",
    notes: i === 0 ? ["⚡ Exit trigger: profit giveback peak 9.1% → 0.3%"] : [],
    view: { ...fatView(i), rangeLabel: "OOR above 9999m ⚠ API lag" },
  })),
  totalValue: 99999.99,
  totalFees: 999.99,
  solMode: true,
  actionSummary: "CLOSE (profit giveback)",
}), 1600);

// Dust menu — 8 worst-case spam rows with amount/SOL/USD + flags.
budgetCheck("dust menu within budget", buildDustMenuHtml({
  tokens: Array.from({ length: 8 }, (_, i) => ({
    symbol: `SCAMTOKENNAME${i}`,
    mint: `MintAddrExample${i}00000000000000000000000000`,
    amount: 123456789.123,
    valueSol: 0.0123,
    usd: 4.99,
    verdict: "spam",
    flags: ["honeypot", "dev rugged 3x", "top10 99%"],
  })),
  thresholdUsd: 5,
  nowLabel: "Jun 20 14:52 WIB",
}), TELEGRAM_BUDGETS.dustMenu);

// mdToTelegramHtml must neutralize raw HTML (no injection) and convert markdown.
function correctnessCheck(label, ok) {
  checks.push({ label, ok: Boolean(ok), detail: ok ? "ok" : "FAILED" });
}
const hostile = mdToTelegramHtml("<script>alert(1)</script> **bold** `code` & <b>x");
correctnessCheck("mdToTelegramHtml escapes raw HTML/ampersands", !hostile.includes("<script>") && hostile.includes("&lt;script&gt;") && hostile.includes("&amp;"));
correctnessCheck("mdToTelegramHtml converts **bold** to <b>", hostile.includes("<b>bold</b>"));
correctnessCheck("mdToTelegramHtml converts `code` to <code>", hostile.includes("<code>code</code>"));

const failed = checks.filter((item) => !item.ok);
const proof = {
  success: failed.length === 0,
  checks: checks.filter((item) => item.ok).map((item) => `${item.label} (${item.detail})`),
  failed: failed.map((item) => `${item.label} (${item.detail})`),
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
} else if (proof.success) {
  console.log(`PASS telegram message budgets (${proof.checks.length} checks)`);
  for (const line of proof.checks) console.log(` - ${line}`);
} else {
  console.error("FAIL telegram message budgets");
  for (const line of proof.failed) console.error(` - ${line}`);
}

process.exit(proof.success ? 0 : 1);
