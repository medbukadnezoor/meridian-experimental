#!/usr/bin/env node

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function src(file) {
  return readFileSync(join(ROOT, file), "utf8");
}

const files = {
  index: src("index.js"),
  telegram: src("telegram.js"),
  render: src("telegram-render.js"),
  configBuilder: src("config-builder.js"),
  exampleConfig: src("user-config.example.json"),
};

const checks = [];

function check(label, test) {
  checks.push({ label, ok: Boolean(test()) });
}

function has(source, pattern) {
  return typeof pattern === "string" ? source.includes(pattern) : pattern.test(source);
}

check("telegram rich helpers call sendRichMessage/editMessageText with rich_message and HTML fallback", () =>
  // Menu surfaces render via standard parse_mode HTML (preserves newlines);
  // the rich_message field collapsed line breaks so it is intentionally unused.
  has(files.telegram, /export\s+async\s+function\s+sendRichMessage/) &&
  has(files.telegram, /export\s+async\s+function\s+editRichMessage/) &&
  has(files.telegram, /sendRichMessage[\s\S]*?postTelegram\("sendMessage"[\s\S]*?parse_mode:\s*"HTML"/) &&
  has(files.telegram, /editRichMessage[\s\S]*?postTelegram\("editMessageText"[\s\S]*?parse_mode:\s*"HTML"/) &&
  !has(files.telegram, /postTelegram\("sendRichMessage"/)
);

check("rich surfaces escape dynamic HTML before interpolation", () =>
  has(files.render, /export\s+function\s+escapeHtml\(value\)/) &&
  has(files.render, /\.replaceAll\("&",\s*"&amp;"\)/) &&
  has(files.render, /buildPositionCompactLine[\s\S]*?escapeHtml/) &&
  has(files.render, /buildPositionDetailHtml[\s\S]*?\bbuildDetail/) &&
  has(files.render, /buildDashboardHtml[\s\S]*?escapeHtml/) &&
  has(files.index, /import\s*\{[\s\S]*?escapeHtml[\s\S]*?\}\s*from\s*"\.\/telegram-render\.js"/) &&
  has(files.index, /closeResultLine[\s\S]*?escapeHtml/)
);

check("renderer is a pure module with budgeted message builders", () =>
  has(files.render, /export\s+const\s+TELEGRAM_BUDGETS\s*=/) &&
  has(files.render, /export\s+function\s+clampHtml\(html,\s*max\)/) &&
  has(files.render, /buildDashboardHtml[\s\S]*?clampHtml[\s\S]*?TELEGRAM_BUDGETS\.dashboard/) &&
  has(files.render, /buildPositionsPageHtml[\s\S]*?clampHtml[\s\S]*?TELEGRAM_BUDGETS\.positionsPage/) &&
  has(files.render, /buildPositionDetailHtml[\s\S]*?clampHtml[\s\S]*?TELEGRAM_BUDGETS\.detail/) &&
  has(files.render, /buildCloseAllPreviewHtml[\s\S]*?clampHtml[\s\S]*?TELEGRAM_BUDGETS\.closeAllPreview/) &&
  !has(files.render, /\bimport\b/)
);

check("dashboard is short: control summary only, no position cards", () => {
  const body = files.render.match(/export\s+function\s+buildDashboardHtml\(summary[\s\S]*?\n\}/);
  return (
    has(files.index, /function\s+buildDashboardSummary\(wallet,\s*positionsResult\)/) &&
    Boolean(body) &&
    !has(body[0], /buildPositionCompactLine/)
  );
});

check("position detail is split into summary/range/market tabs", () =>
  has(files.render, /export\s+const\s+DETAIL_TABS\s*=\s*\["summary",\s*"range",\s*"market"\]/) &&
  has(files.render, /function\s+buildDetailSummary\(view\)/) &&
  has(files.render, /function\s+buildDetailRange\(view\)/) &&
  has(files.render, /function\s+buildDetailMarket\(view\)/) &&
  has(files.index, /detailTabButton/) &&
  has(files.index, /tab:\s*parts\[4\]/)
);

check("close-all preview is capped with overflow summary, not full cards", () =>
  has(files.render, /buildCloseAllPreviewHtml\(\{[\s\S]*?maxRows\s*=\s*4/) &&
  has(files.render, /and\s+\$\{extra\}\s+more/)
);

check("dust menu shows amount/SOL/USD and a GMGN+OKX spam verdict", () =>
  has(files.render, /export\s+function\s+buildDustMenuHtml/) &&
  has(files.render, /export\s+function\s+dustSpamIcon/) &&
  has(files.render, /◎\$\{escapeHtml\(formatNum\(t\.valueSol/) &&
  has(files.index, /function\s+classifyDustRisk\(okx,\s*gmgn\)/) &&
  has(files.index, /getOkxAdvancedInfo\(mint\)/) &&
  has(files.index, /fetchGmgnTokenRisk\(mint\)/) &&
  has(files.index, /function\s+toDustView\(/) &&
  has(files.index, /buildDustMenuHtml\(\{/) &&
  has(files.index, /is_honeypot/)
);

check("markdown→HTML converter escapes first, then applies a fixed style allow-list", () =>
  has(files.render, /export\s+function\s+mdToTelegramHtml\(text\)/) &&
  has(files.render, /let\s+out\s*=\s*escapeHtml\(text\)/) &&
  has(files.render, /<b>\$\{bold\}<\/b>/) &&
  has(files.render, /<code>\$\{code\}<\/code>/)
);

check("live-message system supports HTML mode with a tag-stripped plain fallback", () =>
  has(files.telegram, /import\s*\{[\s\S]*?escapeHtml[\s\S]*?stripTags[\s\S]*?\}\s*from\s*"\.\/telegram-render\.js"/) &&
  has(files.telegram, /createLiveMessage\(title,\s*intro\s*=\s*"Starting\.\.\.",\s*\{\s*html\s*=\s*false\s*\}/) &&
  has(files.telegram, /parse_mode:\s*"HTML"/) &&
  has(files.telegram, /stripTags\(richText\)/)
);

check("dashboard equity is SOL-denominated and surfaces the SOL-equity sidecar", () =>
  has(files.render, /buildDashboardHtml[\s\S]*?🏦 Equity\s*<b>\$\{solAmount\(summary\.equitySol\)\}/) &&
  has(files.render, /function\s+solAmount\(value\)/) &&
  has(files.render, /SOL Equity[\s\S]*?day \$\{escapeHtml\(dayPnl\)\}[\s\S]*?prev-day/) &&
  !has(files.render, /formatCompactUsd\(summary\.equityUsd\)/) &&
  has(files.index, /function\s+readSolEquityTracker\(/) &&
  has(files.index, /function\s+wibDayCutoffUtc\(/) &&
  has(files.index, /sol-balance-snapshots-/) &&
  has(files.index, /const\s+tracker\s*=\s*readSolEquityTracker\(\)/) &&
  has(files.index, /const\s+liveEquitySol\s*=\s*freeSol\s*\+\s*totalValue/) &&
  has(files.index, /tracker\.equitySol\s*!=\s*null\)\s*\?\s*tracker\.equitySol\s*:\s*liveEquitySol/)
);

check("autonomous cycle/startup reports render as HTML (no literal markdown)", () =>
  has(files.index, /createLiveMessage\("🔄 Management Cycle"[\s\S]*?\{\s*html:\s*true\s*\}/) &&
  has(files.index, /createLiveMessage\("🔍 Screening Cycle"[\s\S]*?\{\s*html:\s*true\s*\}/) &&
  has(files.index, /createLiveMessage\("🚀 Startup Check"[\s\S]*?\{\s*html:\s*true\s*\}/) &&
  has(files.index, /mgmtReport\s*=\s*buildCycleReportHtml\(/) &&
  has(files.index, /screenReport\s*=\s*mdToTelegramHtml\(stripThink\(content\)\)/) &&
  has(files.index, /mdToTelegramHtml\(stripThink\(content\)\)/)
);

check("management action prompt defines currency symbol before interpolating action blocks", () =>
  has(files.index, /const\s+cur\s*=\s*config\.management\.solMode\s*\?\s*"◎"\s*:\s*"\$";[\s\S]*?const\s+actionBlocks\s*=/) &&
  has(files.index, /\$\{cur\}\$\{p\.unclaimed_fees_usd\}/) &&
  has(files.index, /\$\{cur\}\$\{p\.total_value_usd\}/)
);

check("destructive callbacks require TELEGRAM_ALLOWED_USER_IDS user allowlist", () =>
  has(files.index, /hasAllowedTelegramUsers/) &&
  has(files.index, /isAllowedTelegramUser/) &&
  has(files.index, /function\s+assertTelegramDestructiveAllowed\(msg\)[\s\S]*?hasAllowedTelegramUsers\(\)[\s\S]*?isAllowedTelegramUser\(msg\?\.from\?\.id\)/)
);

check("callback execution uses expiring server-side action IDs bound to chat and user", () =>
  has(files.index, /const\s+_telegramActions\s*=\s*new\s+Map\(\)/) &&
  has(files.index, /function\s+createTelegramAction\(type,\s*msg,\s*payload\s*=\s*\{\}\)/) &&
  has(files.index, /expiresAt:\s*now\s*\+\s*TELEGRAM_ACTION_TTL_MS/) &&
  has(files.index, /chatId:\s*String\(msg\?\.chat\?\.id/) &&
  has(files.index, /userId:\s*String\(msg\?\.from\?\.id/) &&
  has(files.index, /function\s+consumeTelegramAction\(id,\s*msg,\s*expectedType\)/) &&
  has(files.index, /Date\.now\(\)\s*>\s*action\.expiresAt/) &&
  has(files.index, /action\.chatId\s*!==\s*String\(msg\?\.chat\?\.id/) &&
  has(files.index, /action\.userId\s*!==\s*String\(msg\?\.from\?\.id/)
);

check("telegram handler routes short tg callbacks and answers callback queries", () =>
  has(files.index, /if\s*\(text\.startsWith\("tg:"\)\)\s*\{[\s\S]*?applyTelegramControlCallback\(msg\)/) &&
  has(files.index, /async\s+function\s+applyTelegramControlCallback\(msg\)/) &&
  has(files.index, /answerCallbackQuery\(msg\.callbackQueryId/) &&
  has(files.index, /callback_data:\s*data/)
);

check("slash close paths open previews and index.js has no direct closePosition import/calls", () =>
  !has(files.index, /import\s+\{[^}]*closePosition/) &&
  !has(files.index, /closePosition\s*\(/) &&
  has(files.index, /const\s+closeMatch\s*=\s*text\.match/) &&
  has(files.index, /await\s+showClosePreview\(msg,\s*\{\s*index:\s*idx/) &&
  has(files.index, /if\s*\(text\s*===\s*"\/closeall"\)[\s\S]*?showCloseAllPreview\(msg/)
);

check("close one/all execute through executor close_position and close-all is sequential", () =>
  has(files.index, /executeTool\("close_position",\s*\{[\s\S]*?reason:\s*"Telegram operator close"/) &&
  has(files.index, /executeTool\("close_position",\s*\{[\s\S]*?reason:\s*"Telegram operator close-all"/) &&
  has(files.index, /async\s+function\s+executeCloseAllAction\(action\)[\s\S]*?for\s*\(const\s+item\s+of\s+action\.payload\.positions/)
);

check("dust menu excludes SOL/USDC/USDT and active base mints, quotes first, then executor swaps to SOL", () =>
  has(files.index, /function\s+dustCandidatesFromWallet\(wallet,\s*positions\)/) &&
  has(files.index, /activeBaseMints\s*=\s*new\s+Set/) &&
  has(files.index, /new\s+Set\(\[config\.tokens\.SOL,\s*config\.tokens\.USDC,\s*config\.tokens\.USDT\]\)/) &&
  has(files.index, /TELEGRAM_DUST_MAX_USD/) &&
  has(files.index, /quoteSwapToken\(\{\s*input_mint:\s*token\.mint,\s*output_mint:\s*"SOL",\s*amount:\s*token\.balance\s*\}\)/) &&
  has(files.index, /createTelegramAction\("sell_dust"/) &&
  has(files.index, /executeTool\("swap_token",\s*\{[\s\S]*?input_mint:\s*action\.payload\.mint[\s\S]*?output_mint:\s*"SOL"/)
);

check("dust controls expose configurable thresholds", () =>
  has(files.configBuilder, /telegram:\s*\{[\s\S]*?dustMaxUsd/) &&
  has(files.configBuilder, /telegramDustMaxUsd/) &&
  has(files.configBuilder, /telegramDustMaxPriceImpactBps/) &&
  has(files.configBuilder, /telegramActionTtlMs/) &&
  has(files.exampleConfig, /"telegramDustMaxUsd":\s*5/) &&
  has(files.exampleConfig, /"telegramDustMaxPriceImpactBps":\s*250/) &&
  has(files.exampleConfig, /"telegramActionTtlMs":\s*60000/)
);

check("PM2 stop is allowlisted, confirmed, env-gated, and pm_id-bound", () =>
  has(files.index, /showStopPreview\(msg/) &&
  has(files.index, /process\.env\.TELEGRAM_ENABLE_PM2_STOP\s*!==\s*"true"/) &&
  has(files.index, /const\s+pmId\s*=\s*process\.env\.pm_id/) &&
  has(files.index, /createTelegramAction\("pm2_stop",\s*msg,\s*\{\s*pmId\s*\}\)/) &&
  has(files.index, /execFile\("pm2",\s*\["stop",\s*String\(pmId\)\]/) &&
  has(files.index, /String\(process\.env\.pm_id\)\s*!==\s*String\(action\.payload\.pmId\)/)
);

check("burn execution is deferred and no burn executor path exists", () =>
  has(files.index, /tg:burn_info/) &&
  has(files.index, /Burn execution is deferred/) &&
  !has(files.index, /executeTool\("burn/) &&
  !has(files.index, /burnToken\s*\(/)
);

const failed = checks.filter((item) => !item.ok);
const proof = {
  success: failed.length === 0,
  checks: checks.filter((item) => item.ok).map((item) => item.label),
  failed: failed.map((item) => item.label),
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
} else if (proof.success) {
  console.log(`PASS telegram rich controls (${proof.checks.length} checks)`);
} else {
  console.error("FAIL telegram rich controls");
  for (const label of proof.failed) console.error(` - ${label}`);
}

process.exit(proof.success ? 0 : 1);
