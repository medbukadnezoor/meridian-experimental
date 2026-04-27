#!/usr/bin/env node
/**
 * Synthetic proof for deterministic falling-knife / suspicious-volume vetoes.
 *
 * Pure helper import only: no trading APIs, no bot runtime, no deploy/close calls.
 */

import { dirname, join } from "path";
import { pathToFileURL, fileURLToPath } from "url";

process.env.LOG_LEVEL = "error";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const screeningConfig = {
  fallingKnifeVetoEnabled: true,
  fallingKnifeMaxPriceChange1hPct: -35,
  fallingKnifeSeverePriceChangePct: -45,
  fallingKnifeMinSellBuyRatio: 1.25,
  fallingKnifeRequireOversoldRsi: false,
  suspiciousVolumeVetoEnabled: true,
  suspiciousVolumeMaxMcapToGlobalFeesRatio: 12000,
  suspiciousVolumeMinGlobalFeesSol: 20,
  suspiciousVolumeMaxTokenAgeHours: 96,
  suspiciousVolumeMinPriceDropPct: -25,
};

async function main() {
  try {
    const screeningModule = await import(`${pathToFileURL(join(ROOT, "tools", "screening.js")).href}?proof=${Date.now()}`);
    const {
      getDeterministicCandidateVetoReason,
      getDeterministicVetoAuditSnapshot,
      getFallingKnifeVetoReason,
      getSuspiciousVolumeVetoReason,
      formatDeterministicVetoAuditLine,
    } = screeningModule;

    const larpLike = {
      name: "LARP-SOL",
      price_change_pct: -48.8,
      mcap: 631429,
      global_fees_sol: 29.94,
      token_age_hours: 66,
      stats_1h: {
        price_change: -46.55,
        sell_vol: 73506,
        buy_vol: 44309,
      },
    };
    const larpReason = getDeterministicCandidateVetoReason(larpLike, screeningConfig);
    assert(larpReason?.startsWith("falling knife veto:"), "LARP-like dump should be vetoed as falling knife");
    assert(larpReason.includes("price_change=-48.8%"), "LARP reason should include severe 1h drop");
    assert(larpReason.includes("sell/buy=1.66"), "LARP reason should include sell/buy pressure");
    const larpAudit = getDeterministicVetoAuditSnapshot(larpLike);
    assert(Number(larpAudit.price_change_pct?.toFixed(1)) === -48.8, "LARP audit should include price change");
    assert(Number(larpAudit.sell_buy_ratio?.toFixed(2)) === 1.66, "LARP audit should include sell/buy ratio");
    assert(Math.round(larpAudit.mcap_global_fees_ratio) === 21090, "LARP audit should include mcap/global_fees ratio");
    assert(Number(larpAudit.token_age_hours) === 66, "LARP audit should include token age hours");
    const larpAuditLine = formatDeterministicVetoAuditLine(larpLike, larpReason);
    assert(larpAuditLine.includes("Deterministic veto: dropped LARP-SOL"), "audit line should include candidate name");
    assert(larpAuditLine.includes("price_change=-48.8%"), "audit line should include price change");
    assert(larpAuditLine.includes("sell/buy=1.66"), "audit line should include sell/buy ratio");
    assert(larpAuditLine.includes("mcap/global_fees=21090"), "audit line should include mcap/global_fees ratio");
    assert(larpAuditLine.includes("token_age_hours=66"), "audit line should include token age");

    const disabledReason = getDeterministicCandidateVetoReason(larpLike, {
      ...screeningConfig,
      fallingKnifeVetoEnabled: false,
      suspiciousVolumeVetoEnabled: false,
    });
    assert(disabledReason == null, "disabled veto config should preserve existing candidate behavior");

    const benign5mFrequency = {
      name: "BENIGN-5M-SOL",
      price_change_pct: -6.5,
      rsi: 24,
      mcap: 180000,
      global_fees_sol: 28,
      token_age_hours: 18,
      indicator_confirmation: {
        confirmed: true,
        intervals: [{ interval: "5_MINUTE", rsi: 24 }],
      },
      stats_1h: {
        price_change: -7.2,
        sell_vol: 12000,
        buy_vol: 11000,
      },
    };
    const benignReason = getDeterministicCandidateVetoReason(benign5mFrequency, screeningConfig);
    assert(benignReason == null, "benign 5m-frequency candidate should not be vetoed just because RSI is low");

    const ratioFallingKnife = {
      name: "RATIO-DUMP-SOL",
      price_change_pct: -36,
      stats_1h: {
        price_change: -34,
        sell_vol: 25000,
        buy_vol: 10000,
      },
    };
    const ratioReason = getFallingKnifeVetoReason(ratioFallingKnife, screeningConfig);
    assert(ratioReason?.startsWith("falling knife veto:"), "non-severe dump with high sell/buy ratio should be vetoed");

    const suspiciousVolume = {
      name: "SUS-VOL-SOL",
      price_change_pct: -30,
      mcap: 180000,
      global_fees_sol: 24,
      token_age_hours: 12,
      stats_1h: {
        price_change: -29,
        sell_vol: 15000,
        buy_vol: 14000,
      },
    };
    const suspiciousReason = getSuspiciousVolumeVetoReason(suspiciousVolume, screeningConfig);
    assert(suspiciousReason?.startsWith("suspicious volume/fees veto:"), "young high-fee low mcap/fee dump should be vetoed");
    assert(suspiciousReason.includes("mcap/global_fees=7500"), "suspicious reason should include mcap/global_fees");

    console.log(JSON.stringify({
      success: true,
      disabledDefault: { vetoed: false, reason: disabledReason },
      larpLike: { vetoed: true, reason: larpReason, audit: larpAudit, auditLine: larpAuditLine },
      benignOversold: { vetoed: false, reason: benignReason },
      benign5mFrequency: { vetoed: false, reason: benignReason },
      ratioFallingKnife: { vetoed: true, reason: ratioReason },
      suspiciousVolume: { vetoed: true, reason: suspiciousReason },
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ success: false, error: error.message }, null, 2));
    process.exit(1);
  }
}

await main();
