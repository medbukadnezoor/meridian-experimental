#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PROJECT_ROOT = path.resolve(ROOT, "..");
const DEFAULT_OUT_MD = path.join(PROJECT_ROOT, "meridian-intelligence/reports/latest_main_fee_velocity_protection_gate.md");
const DEFAULT_OUT_JSON = path.join(PROJECT_ROOT, "meridian-intelligence/data/processed/latest_main_fee_velocity_protection_gate.json");

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function loadJson(file) {
  if (!fs.existsSync(file)) return { ok: false, file, reason: "missing" };
  try {
    const stat = fs.statSync(file);
    return { ok: true, file, mtime: stat.mtime.toISOString(), data: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (error) {
    return { ok: false, file, reason: error.message };
  }
}

function findVariant(report, group, name) {
  return report?.replay?.[group]?.find((variant) => variant.name === name) ?? null;
}

export function buildMainFeeVelocityProtectionGate({
  tailJson = path.join(PROJECT_ROOT, "meridian-intelligence/data/processed/latest_scout_tail_loss_prevention.json"),
  ohlcvJson = path.join(PROJECT_ROOT, "meridian-intelligence/data/processed/latest_scout_ohlcv_entry_veto_shadow.json"),
  belowRangeJson = path.join(PROJECT_ROOT, "meridian-intelligence/data/processed/latest_active_bin_below_range_emergency_replay.json"),
} = {}) {
  const tail = loadJson(tailJson);
  const ohlcv = loadJson(ohlcvJson);
  const below = loadJson(belowRangeJson);
  const artifacts = { tail, ohlcv, belowRange: below };
  const blockers = [];

  if (!tail.ok) blockers.push(`T1 tail-loss artifact ${tail.reason}`);
  if (!ohlcv.ok) blockers.push(`T3 OHLCV shadow artifact ${ohlcv.reason}`);
  if (!below.ok) blockers.push(`T4 below-range artifact ${below.reason}`);

  const tailData = tail.data;
  const ballsack = tailData?.seedStatus?.ballsackdorkl;
  const yae = tailData?.seedStatus?.yaeSecondLap;
  if (tail.ok && !ballsack?.present) blockers.push("BALLSACKDORKL seed loss missing from T1 artifact");
  if (tail.ok && !yae?.present) blockers.push("Yae second-lap seed loss missing from T1 artifact");

  const samePool15 = findVariant(tailData, "samePoolPostWinCooldown", "same_pool_post_win<=15m");
  if (tail.ok && !samePool15?.blockedPositions?.some((p) => p.position === yae?.position)) {
    blockers.push("T2 same-pool replay does not block Yae second lap");
  }
  if (samePool15 && samePool15.blockedWinnerPnlPct !== 0) {
    blockers.push("T2 same-pool replay has blocked-winner cost");
  }

  if (ohlcv.ok && ohlcv.data?.warning !== "do not use blunt high-drawdown veto") {
    blockers.push("T3 artifact does not preserve blunt-veto warning");
  }
  const compoundCandidate = tailData?.replay?.ohlcvCompoundEntryVeto?.find((variant) =>
    variant.blockedPositions?.some((p) => p.position === ballsack?.position || p.position === yae?.position)
  );
  if (tail.ok && !compoundCandidate) blockers.push("T3 compound OHLCV variants do not block any seed loss");

  if (below.ok && below.data?.recommendation !== "below_range_alone_not_safe") {
    blockers.push("T4 artifact does not flag below-range alone as unsafe");
  }
  if (below.ok && below.data?.status !== "replay_only_live_close_disabled") {
    blockers.push("T4 artifact is not replay-only/live-close-disabled");
  }

  let status = "candidate_owner_review_required";
  if (blockers.length > 0) {
    status = (!tail.ok || !ohlcv.ok || !below.ok)
      ? "blocked_missing_evidence"
      : "blocked_failed_prevention";
  }

  return {
    generatedAt: new Date().toISOString(),
    status,
    ownerApprovalRequired: true,
    mainRuntimeChanged: false,
    mainSpecificSizingRisk: "Scout evidence is not Main approval. Main deploy size and exposure are larger, so any Main adoption requires explicit owner review.",
    seedLosses: {
      ballsackdorkl: {
        present: !!ballsack?.present,
        position: ballsack?.position ?? null,
        pnlPct: ballsack?.pnlPct ?? null,
        preventionStatus: compoundCandidate?.blockedPositions?.some((p) => p.position === ballsack?.position) ? "candidate_blocked_by_compound_ohlcv_variant" : "not_proven_blocked",
      },
      yaeSecondLap: {
        present: !!yae?.present,
        position: yae?.position ?? null,
        pnlPct: yae?.pnlPct ?? null,
        samePoolPreventionStatus: samePool15?.blockedPositions?.some((p) => p.position === yae?.position) ? "blocked_by_same_pool_post_win_15m" : "not_proven_blocked",
        activeBinStatus: below.data?.seedCases?.yaeSecondLap?.present ? "below_range_replay_present" : "below_range_replay_missing",
      },
    },
    artifacts: {
      tail: summarizeArtifact(tail),
      ohlcv: summarizeArtifact(ohlcv),
      belowRange: summarizeArtifact(below),
    },
    blockers,
  };
}

function summarizeArtifact(artifact) {
  return {
    ok: artifact.ok,
    file: artifact.file,
    mtime: artifact.mtime ?? null,
    reason: artifact.reason ?? null,
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Main Fee-Velocity Protection Gate");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Status: ${report.status}`);
  lines.push("");
  lines.push("## Owner Summary");
  lines.push("");
  lines.push("- Main fee-velocity adoption is not approved by this report.");
  lines.push("- Explicit owner approval is required even when the evidence reaches candidate status.");
  lines.push(`- Main runtime changed: ${report.mainRuntimeChanged}`);
  lines.push(`- Sizing risk: ${report.mainSpecificSizingRisk}`);
  lines.push("");
  lines.push("## Seed Losses");
  lines.push("");
  lines.push("| Case | Present | Position | PnL % | Prevention status |");
  lines.push("| --- | --- | --- | ---: | --- |");
  lines.push(`| BALLSACKDORKL | ${report.seedLosses.ballsackdorkl.present} | ${report.seedLosses.ballsackdorkl.position ?? ""} | ${report.seedLosses.ballsackdorkl.pnlPct ?? ""} | ${report.seedLosses.ballsackdorkl.preventionStatus} |`);
  lines.push(`| Yae second lap | ${report.seedLosses.yaeSecondLap.present} | ${report.seedLosses.yaeSecondLap.position ?? ""} | ${report.seedLosses.yaeSecondLap.pnlPct ?? ""} | ${report.seedLosses.yaeSecondLap.samePoolPreventionStatus}; ${report.seedLosses.yaeSecondLap.activeBinStatus} |`);
  lines.push("");
  lines.push("## Required Artifacts");
  lines.push("");
  for (const [name, artifact] of Object.entries(report.artifacts)) {
    lines.push(`- ${name}: ${artifact.ok ? "present" : "missing/invalid"} ${artifact.file} mtime=${artifact.mtime ?? "n/a"} ${artifact.reason ?? ""}`.trim());
  }
  if (report.blockers.length) {
    lines.push("");
    lines.push("## Blockers");
    for (const blocker of report.blockers) lines.push(`- ${blocker}`);
  }
  return `${lines.join("\n")}\n`;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const args = parseArgs();
  const report = buildMainFeeVelocityProtectionGate({
    tailJson: args["tail-json"],
    ohlcvJson: args["ohlcv-json"],
    belowRangeJson: args["below-range-json"],
  });
  const outJson = args["out-json"] ?? DEFAULT_OUT_JSON;
  const outMd = args["out-md"] ?? DEFAULT_OUT_MD;
  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.mkdirSync(path.dirname(outMd), { recursive: true });
  fs.writeFileSync(outJson, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(outMd, renderMarkdown(report));
  console.log(JSON.stringify({
    status: report.status,
    ownerApprovalRequired: report.ownerApprovalRequired,
    markdown: outMd,
    json: outJson,
    blockers: report.blockers,
  }, null, 2));
}
