import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOT_ROOT = path.resolve(__dirname, "..");

function firstExistingPath(paths) {
  return paths.find((candidate) => fs.existsSync(candidate)) ?? null;
}

const INTELLIGENCE_ROOT = firstExistingPath([
  path.resolve(BOT_ROOT, "../../meridian-intelligence"),
  path.resolve(BOT_ROOT, "../meridian-intelligence"),
]);
const DEFAULT_OUTPUT_ROOT = INTELLIGENCE_ROOT ?? path.join(BOT_ROOT, "reports");
const DEFAULT_PROCESSED_ROOT = INTELLIGENCE_ROOT
  ? path.join(INTELLIGENCE_ROOT, "data/processed")
  : DEFAULT_OUTPUT_ROOT;

export const DEFAULT_FROM = "2026-05-15";
export const DEFAULT_TO = "2026-05-16";
export const DEFAULT_LOGS_DIR = process.env.SCOUT_LOGS_DIR
  ?? (INTELLIGENCE_ROOT
    ? path.join(INTELLIGENCE_ROOT, "data/vps-logs/scout/logs")
    : path.join(BOT_ROOT, "logs"));
export const DEFAULT_REPORT_MD = path.join(DEFAULT_OUTPUT_ROOT, "latest_scout_tail_loss_prevention.md");
export const DEFAULT_REPORT_JSON = path.join(DEFAULT_PROCESSED_ROOT, "latest_scout_tail_loss_prevention.json");
export const DEFAULT_OHLCV_SHADOW_JSON = path.join(DEFAULT_PROCESSED_ROOT, "latest_scout_ohlcv_entry_veto_shadow.json");
export const DEFAULT_BELOW_RANGE_MD = path.join(DEFAULT_OUTPUT_ROOT, "latest_active_bin_below_range_emergency_replay.md");
export const DEFAULT_BELOW_RANGE_JSON = path.join(DEFAULT_PROCESSED_ROOT, "latest_active_bin_below_range_emergency_replay.json");

export const SEED_FACTS = Object.freeze({
  ballsackdorkl: {
    pair: "BALLSACKDORKL-SOL",
    pnlPct: -20.87177897034872,
    highDrawdownApprox: -57.2831,
  },
  yaeSecondLap: {
    pair: "Yae-SOL",
    pnlPct: -48.26465703731661,
    activeBin: -471,
    lowerBin: -422,
    upperBin: -405,
    rangeSide: "below_range",
    highDrawdownApprox: -46.3198,
  },
});

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
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

export function dateKeys(from = DEFAULT_FROM, to = DEFAULT_TO) {
  const out = [];
  const cur = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function safeJsonParse(line) {
  try {
    return { value: JSON.parse(line), error: null };
  } catch (error) {
    return { value: null, error };
  }
}

export function readJsonlWindow(logsDir, prefix, from = DEFAULT_FROM, to = DEFAULT_TO) {
  const rows = [];
  const parseFailures = [];
  for (const day of dateKeys(from, to)) {
    const file = path.join(logsDir, `${prefix}-${day}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const stat = fs.statSync(file);
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      const { value, error } = safeJsonParse(line);
      if (error) {
        parseFailures.push({ file, line: index + 1, error: error.message });
      } else {
        rows.push({ ...value, _sourceFile: file, _line: index + 1, _mtime: stat.mtime.toISOString() });
      }
    });
  }
  return { rows, parseFailures };
}

export function finiteNumber(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function tsMs(row) {
  const raw = row?.timestamp ?? row?.ts;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function positionKey(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function addPosition(map, position, seed = {}) {
  const key = positionKey(position);
  if (!key) return null;
  if (!map.has(key)) {
    map.set(key, {
      position: key,
      pair: null,
      pool: null,
      baseMint: null,
      deploy: null,
      close: null,
      decisionContexts: [],
      pnlSnapshots: [],
      activeBinRows: [],
      ohlcvRows: [],
      ...seed,
    });
  }
  return map.get(key);
}

function rowPair(row) {
  return row?.pair ?? row?.poolName ?? row?.pool_name ?? row?.result?.pool_name ?? row?.args?.pool_name ?? null;
}

export function buildScoutEvidence({ logsDir = DEFAULT_LOGS_DIR, from = DEFAULT_FROM, to = DEFAULT_TO } = {}) {
  const actions = readJsonlWindow(logsDir, "actions", from, to);
  const contexts = readJsonlWindow(logsDir, "decision-context", from, to);
  const pnl = readJsonlWindow(logsDir, "pnl-snapshots", from, to);
  const active = readJsonlWindow(logsDir, "active-bin-oracle", from, to);
  const ohlcv = readJsonlWindow(logsDir, "ohlcv-drawdown-shadow", from, to);
  const positions = new Map();

  for (const row of actions.rows) {
    if (row.tool !== "deploy_position" && row.tool !== "close_position") continue;
    const position = positionKey(row.result?.position ?? row.args?.position_address);
    const p = addPosition(positions, position);
    if (!p) continue;
    if (row.tool === "deploy_position" && row.result?.success) {
      p.deploy = row;
      p.pair = row.result?.pool_name ?? row.args?.pool_name ?? p.pair;
      p.pool = row.result?.pool ?? row.args?.pool_address ?? p.pool;
      p.baseMint = row.args?.base_mint ?? p.baseMint;
    }
    if (row.tool === "close_position" && row.success) {
      p.close = row;
      p.pair = row.result?.pool_name ?? p.pair;
      p.pool = row.result?.pool ?? p.pool;
      p.baseMint = row.result?.residual_base_mint ?? p.baseMint;
    }
  }

  for (const row of contexts.rows) {
    const p = addPosition(positions, row.position);
    if (!p) continue;
    p.decisionContexts.push(row);
    p.pair ||= rowPair(row);
    p.pool ||= row.pool;
    p.baseMint ||= row.baseMint ?? row.base_mint;
  }

  for (const row of contexts.rows) {
    if (row.position) continue;
    if (!row.pool) continue;
    const rowMs = tsMs(row);
    if (!Number.isFinite(rowMs)) continue;
    let best = null;
    for (const p of positions.values()) {
      if (!p.deploy || p.pool !== row.pool) continue;
      const deployMs = tsMs(p.deploy);
      const deltaMs = deployMs - rowMs;
      if (deltaMs < 0 || deltaMs > 15 * 60_000) continue;
      if (!best || deltaMs < best.deltaMs) best = { p, deltaMs };
    }
    if (best) {
      best.p.decisionContexts.push(row);
      best.p.baseMint ||= row.baseMint ?? row.base_mint;
    }
  }

  for (const row of pnl.rows) {
    const p = addPosition(positions, row.position);
    if (!p) continue;
    p.pnlSnapshots.push(row);
    p.pair ||= rowPair(row);
    p.pool ||= row.pool;
    p.baseMint ||= row.baseMint ?? row.base_mint;
  }

  for (const row of active.rows) {
    const p = addPosition(positions, row.position);
    if (!p) continue;
    p.activeBinRows.push(row);
    p.pair ||= rowPair(row);
    p.pool ||= row.pool;
  }

  for (const row of ohlcv.rows) {
    const p = addPosition(positions, row.position);
    if (!p) continue;
    p.ohlcvRows.push(row);
    p.pair ||= rowPair(row);
    p.pool ||= row.pool;
    p.baseMint ||= row.baseMint ?? row.base_mint;
  }

  const parseFailures = [
    ...actions.parseFailures,
    ...contexts.parseFailures,
    ...pnl.parseFailures,
    ...active.parseFailures,
    ...ohlcv.parseFailures,
  ];

  const sourceFiles = [
    ...new Set([
      ...actions.rows,
      ...contexts.rows,
      ...pnl.rows,
      ...active.rows,
      ...ohlcv.rows,
    ].map((row) => row._sourceFile).filter(Boolean)),
  ].sort();

  const list = [...positions.values()]
    .filter((p) => p.deploy || p.close)
    .map((p) => summarizePosition(p))
    .sort((a, b) => Date.parse(a.deployTs ?? a.closeTs ?? 0) - Date.parse(b.deployTs ?? b.closeTs ?? 0));

  return {
    generatedAt: new Date().toISOString(),
    evidenceWindow: { from, to },
    logsDir,
    sourceFiles,
    parseFailures,
    rawCounts: {
      actions: actions.rows.length,
      decisionContexts: contexts.rows.length,
      pnlSnapshots: pnl.rows.length,
      activeBinRows: active.rows.length,
      ohlcvRows: ohlcv.rows.length,
    },
    positions: list,
  };
}

function nearestSnapshot(pnlSnapshots, whenMs, maxDeltaMs = 60_000) {
  if (!Number.isFinite(whenMs)) return null;
  let best = null;
  for (const row of pnlSnapshots) {
    const deltaMs = Math.abs((tsMs(row) ?? Number.POSITIVE_INFINITY) - whenMs);
    if (deltaMs <= maxDeltaMs && (!best || deltaMs < best.deltaMs)) best = { row, deltaMs };
  }
  return best?.row ?? null;
}

function worstOhlcv(rows, field) {
  let worst = null;
  for (const row of rows) {
    const value = finiteNumber(row?.ohlcv?.[field] ?? row?.[field]);
    if (value == null) continue;
    if (!worst || value < worst.value) worst = { value, row };
  }
  return worst;
}

function firstOhlcvWithin(rows, deployTs, minutes = 3) {
  const deployMs = Date.parse(deployTs ?? "");
  if (!Number.isFinite(deployMs)) return null;
  const maxMs = deployMs + minutes * 60_000;
  return rows
    .filter((row) => {
      const ms = tsMs(row);
      return Number.isFinite(ms) && ms >= deployMs && ms <= maxMs;
    })
    .sort((a, b) => tsMs(a) - tsMs(b))[0] ?? null;
}

function firstBelowRange(activeRows) {
  return activeRows
    .filter((row) => row.range_side === "below_range" || (finiteNumber(row.active_bin) != null && finiteNumber(row.lower_bin) != null && finiteNumber(row.active_bin) < finiteNumber(row.lower_bin)))
    .sort((a, b) => tsMs(a) - tsMs(b))[0] ?? null;
}

function summarizePosition(p) {
  const deployTs = p.deploy?.timestamp ?? null;
  const closeTs = p.close?.timestamp ?? null;
  const deployMs = Date.parse(deployTs ?? "");
  const closeMs = Date.parse(closeTs ?? "");
  const finalPnlPct = finiteNumber(p.close?.result?.pnl_pct);
  const ageZero = firstOhlcvWithin(p.ohlcvRows, deployTs, 5);
  const worstHigh = worstOhlcv(p.ohlcvRows, "highDrawdownPct");
  const worstEntry = worstOhlcv(p.ohlcvRows, "entryDrawdownPct");
  const below = firstBelowRange(p.activeBinRows);
  const belowPnl = nearestSnapshot(p.pnlSnapshots, tsMs(below));
  const deployMetrics = p.decisionContexts
    .filter((row) => row.stage && ["indicator_accept", "indicator_skipped", "deterministic_veto", "candidate_accept", "cooldown_block"].includes(row.stage))
    .at(-1)?.metrics ?? null;

  return {
    position: p.position,
    pair: p.pair,
    pool: p.pool,
    baseMint: p.baseMint,
    deployTs,
    closeTs,
    holdMinutes: Number.isFinite(deployMs) && Number.isFinite(closeMs) ? (closeMs - deployMs) / 60_000 : null,
    finalPnlPct,
    closeReason: p.close?.args?.reason ?? p.close?.result?.adaptive_close?.requested_reason ?? null,
    classification: finalPnlPct == null ? "open_or_unknown" : finalPnlPct > 0 ? "winner" : "loser",
    deployMetrics,
    ageZeroOhlcv: ageZero ? {
      ts: ageZero.ts,
      highDrawdownPct: finiteNumber(ageZero.ohlcv?.highDrawdownPct),
      entryDrawdownPct: finiteNumber(ageZero.ohlcv?.entryDrawdownPct),
      ruleId: ageZero.ruleId,
      ruleType: ageZero.ruleType,
      source: ageZero.ohlcv?.source ?? ageZero.source ?? null,
    } : null,
    worstOhlcv: {
      highDrawdownPct: worstHigh?.value ?? null,
      highDrawdownTs: worstHigh?.row?.ts ?? null,
      entryDrawdownPct: worstEntry?.value ?? null,
      entryDrawdownTs: worstEntry?.row?.ts ?? null,
      rowCount: p.ohlcvRows.length,
    },
    firstActiveBinRow: p.activeBinRows[0] ? compactActiveBin(p.activeBinRows[0]) : null,
    firstBelowRangeRow: below ? {
      ...compactActiveBin(below),
      nearestPnlPct: finiteNumber(belowPnl?.pnl_pct ?? belowPnl?.metrics?.pnl_pct),
      nearestPnlTs: belowPnl?.timestamp ?? belowPnl?.ts ?? null,
    } : null,
    activeBinRowCount: p.activeBinRows.length,
    pnlSnapshotRowCount: p.pnlSnapshots.length,
    decisionContextRowCount: p.decisionContexts.length,
  };
}

function compactActiveBin(row) {
  return {
    ts: row.timestamp ?? row.ts ?? null,
    activeBin: finiteNumber(row.active_bin),
    lowerBin: finiteNumber(row.lower_bin),
    upperBin: finiteNumber(row.upper_bin),
    rangeSide: row.range_side ?? null,
    pnlPct: finiteNumber(row.pnl_pct),
    binDelta: finiteNumber(row.bin_delta),
    velocity30sBinsPerSec: finiteNumber(row.velocity_30s_bins_per_sec),
    rangeWidthBins: finiteNumber(row.range_width_bins),
  };
}

function mostRecentPriorWin(positions, current, materialWinPct = 1) {
  const deployMs = Date.parse(current.deployTs ?? "");
  if (!Number.isFinite(deployMs)) return null;
  const candidates = positions
    .filter((p) => p.position !== current.position)
    .filter((p) => p.finalPnlPct != null && p.finalPnlPct >= materialWinPct)
    .filter((p) => p.closeTs && Date.parse(p.closeTs) <= deployMs)
    .filter((p) => (p.pool && current.pool && p.pool === current.pool) || (p.baseMint && current.baseMint && p.baseMint === current.baseMint))
    .sort((a, b) => Date.parse(b.closeTs) - Date.parse(a.closeTs));
  const prior = candidates[0] ?? null;
  if (!prior) return null;
  return {
    position: prior.position,
    pair: prior.pair,
    pool: prior.pool,
    baseMint: prior.baseMint,
    closedAt: prior.closeTs,
    pnlPct: prior.finalPnlPct,
    minutesSince: (deployMs - Date.parse(prior.closeTs)) / 60_000,
    identity: prior.pool && current.pool && prior.pool === current.pool ? "same_pool" : "same_base_mint",
  };
}

export function attachReplayContext(evidence) {
  const positions = evidence.positions.map((p) => ({ ...p }));
  for (const p of positions) {
    p.samePoolPriorWin = mostRecentPriorWin(positions, p);
  }
  return { ...evidence, positions };
}

export function evaluateOhlcvHighThresholds(positions, thresholds = [-25, -35, -45, -55]) {
  return thresholds.map((threshold) => {
    const blocked = positions.filter((p) => p.ageZeroOhlcv?.highDrawdownPct != null && p.ageZeroOhlcv.highDrawdownPct <= threshold);
    return summarizeBlockedVariant(`ohlcv_high_drawdown<=${threshold}`, blocked, positions, {
      missingEvidenceCount: positions.filter((p) => p.ageZeroOhlcv?.highDrawdownPct == null).length,
      threshold,
    });
  });
}

export function evaluateOhlcvEntryThresholds(positions, thresholds = [-10, -20, -30]) {
  return thresholds.map((threshold) => {
    const blocked = positions.filter((p) => p.ageZeroOhlcv?.entryDrawdownPct != null && p.ageZeroOhlcv.entryDrawdownPct <= threshold);
    return summarizeBlockedVariant(`ohlcv_entry_drawdown<=${threshold}`, blocked, positions, {
      missingEvidenceCount: positions.filter((p) => p.ageZeroOhlcv?.entryDrawdownPct == null).length,
      threshold,
    });
  });
}

export function evaluateSamePoolCooldowns(positions, windows = [15, 30, 60]) {
  return windows.map((minutes) => {
    const blocked = positions.filter((p) => p.samePoolPriorWin?.minutesSince != null && p.samePoolPriorWin.minutesSince <= minutes);
    return summarizeBlockedVariant(`same_pool_post_win<=${minutes}m`, blocked, positions, {
      missingEvidenceCount: positions.filter((p) => p.samePoolPriorWin == null).length,
      cooldownMinutes: minutes,
    });
  });
}

export function evaluateBelowRangeVariants(positions) {
  const variants = [
    {
      name: "below_range_any",
      test: (p) => !!p.firstBelowRangeRow,
    },
    {
      name: "below_range_pnl<=-5",
      test: (p) => !!p.firstBelowRangeRow && (p.firstBelowRangeRow.nearestPnlPct ?? p.firstBelowRangeRow.pnlPct) <= -5,
    },
    {
      name: "below_range_pnl<=-10",
      test: (p) => !!p.firstBelowRangeRow && (p.firstBelowRangeRow.nearestPnlPct ?? p.firstBelowRangeRow.pnlPct) <= -10,
    },
    {
      name: "below_range_pnl<=-20",
      test: (p) => !!p.firstBelowRangeRow && (p.firstBelowRangeRow.nearestPnlPct ?? p.firstBelowRangeRow.pnlPct) <= -20,
    },
    {
      name: "below_range_ohlcv_entry<=-20",
      test: (p) => !!p.firstBelowRangeRow && p.worstOhlcv?.entryDrawdownPct != null && p.worstOhlcv.entryDrawdownPct <= -20,
    },
  ];
  return variants.map((variant) => summarizeBlockedVariant(variant.name, positions.filter(variant.test), positions, {
    missingEvidenceCount: positions.filter((p) => !p.firstBelowRangeRow).length,
  }));
}

export function evaluateCompoundOhlcvVariants(positions) {
  const variants = [];
  for (const highThreshold of [-35, -45, -55]) {
    for (const priceChangeThreshold of [500, 1000]) {
      variants.push({
        name: `high<=${highThreshold}_price_change>=${priceChangeThreshold}`,
        highThreshold,
        priceChangeThreshold,
        test: (p) => p.ageZeroOhlcv?.highDrawdownPct != null &&
          p.ageZeroOhlcv.highDrawdownPct <= highThreshold &&
          (p.deployMetrics?.priceChangePct ?? 0) >= priceChangeThreshold,
      });
    }
    for (const window of [15, 30, 60]) {
      variants.push({
        name: `high<=${highThreshold}_same_pool_win<=${window}m`,
        highThreshold,
        samePoolWindowMinutes: window,
        test: (p) => p.ageZeroOhlcv?.highDrawdownPct != null &&
          p.ageZeroOhlcv.highDrawdownPct <= highThreshold &&
          p.samePoolPriorWin?.minutesSince != null &&
          p.samePoolPriorWin.minutesSince <= window,
      });
    }
  }
  return variants.map((variant) => summarizeBlockedVariant(variant.name, positions.filter(variant.test), positions, {
    missingEvidenceCount: positions.filter((p) => p.ageZeroOhlcv?.highDrawdownPct == null).length,
    highThreshold: variant.highThreshold,
    priceChangeThreshold: variant.priceChangeThreshold ?? null,
    samePoolWindowMinutes: variant.samePoolWindowMinutes ?? null,
  }));
}

function summarizeBlockedVariant(name, blocked, allPositions, extra = {}) {
  const closed = blocked.filter((p) => p.finalPnlPct != null);
  const losses = closed.filter((p) => p.finalPnlPct < 0);
  const winners = closed.filter((p) => p.finalPnlPct > 0);
  return {
    name,
    blockedPositions: blocked.map((p) => ({
      pair: p.pair,
      position: p.position,
      finalPnlPct: p.finalPnlPct,
      deployTs: p.deployTs,
      closeTs: p.closeTs,
    })),
    blockedCount: blocked.length,
    avoidedLossPct: Math.abs(losses.reduce((sum, p) => sum + p.finalPnlPct, 0)),
    blockedWinnerPnlPct: winners.reduce((sum, p) => sum + p.finalPnlPct, 0),
    blockedOpenOrUnknownCount: blocked.filter((p) => p.finalPnlPct == null).length,
    missingEvidenceCount: extra.missingEvidenceCount ?? 0,
    recommendation: winners.length > 0 && losses.length > 0
      ? "shadow_only_counterexamples_present"
      : losses.length > 0
        ? "candidate_for_owner_review"
        : "not_useful_for_tail_loss_prevention",
    ...extra,
    sampleSize: allPositions.length,
  };
}

export function buildTailLossReport({ logsDir = DEFAULT_LOGS_DIR, from = DEFAULT_FROM, to = DEFAULT_TO } = {}) {
  const evidence = attachReplayContext(buildScoutEvidence({ logsDir, from, to }));
  const positions = evidence.positions;
  const replay = {
    ohlcvHighDrawdown: evaluateOhlcvHighThresholds(positions),
    ohlcvEntryDrawdown: evaluateOhlcvEntryThresholds(positions),
    samePoolPostWinCooldown: evaluateSamePoolCooldowns(positions),
    activeBinBelowRange: evaluateBelowRangeVariants(positions),
    ohlcvCompoundEntryVeto: evaluateCompoundOhlcvVariants(positions),
  };
  const seedStatus = {
    ballsackdorkl: findSeed(positions, "BALLSACKDORKL-SOL", SEED_FACTS.ballsackdorkl.pnlPct),
    yaeSecondLap: findSeed(positions, "Yae-SOL", SEED_FACTS.yaeSecondLap.pnlPct),
  };
  return {
    ...evidence,
    reportStatus: "scout_restart_blocked",
    restartDecision: "Scout restart remains blocked pending owner approval.",
    seedStatus,
    replay,
    artifactVersion: 1,
  };
}

function findSeed(positions, pair, pnlPct) {
  const seed = positions.find((p) => p.pair === pair && Math.abs((p.finalPnlPct ?? 999) - pnlPct) < 1e-9);
  return {
    present: !!seed,
    position: seed?.position ?? null,
    pair,
    pnlPct: seed?.finalPnlPct ?? null,
    ageZeroHighDrawdownPct: seed?.ageZeroOhlcv?.highDrawdownPct ?? null,
    firstBelowRangeRow: seed?.firstBelowRangeRow ?? null,
    samePoolPriorWin: seed?.samePoolPriorWin ?? null,
  };
}

export function renderTailLossMarkdown(report) {
  const lines = [];
  lines.push("# Scout Tail Loss Prevention Report");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Evidence window: ${report.evidenceWindow.from} through ${report.evidenceWindow.to}`);
  lines.push(`Status: ${report.reportStatus}`);
  lines.push("");
  lines.push("## Owner Summary");
  lines.push("");
  lines.push("- Scout restart remains blocked pending owner approval.");
  lines.push(`- Reconstructed ${report.positions.filter((p) => p.deployTs).length} deploys and ${report.positions.filter((p) => p.closeTs).length} closes from local Scout JSONL logs.`);
  lines.push(`- BALLSACKDORKL seed present: ${report.seedStatus.ballsackdorkl.present} pnl_pct=${report.seedStatus.ballsackdorkl.pnlPct}`);
  lines.push(`- Yae second lap seed present: ${report.seedStatus.yaeSecondLap.present} pnl_pct=${report.seedStatus.yaeSecondLap.pnlPct}`);
  lines.push("- Do not use blunt high-drawdown veto as a live rule: replay includes profitable counterexamples.");
  lines.push("");
  lines.push("## Seed Evidence");
  lines.push("");
  lines.push("| Case | Position | PnL % | Age-zero high drawdown % | First below-range | Prior win |");
  lines.push("| --- | --- | ---: | ---: | --- | --- |");
  for (const [name, seed] of Object.entries(report.seedStatus)) {
    const below = seed.firstBelowRangeRow
      ? `${seed.firstBelowRangeRow.rangeSide} active=${seed.firstBelowRangeRow.activeBin} lower=${seed.firstBelowRangeRow.lowerBin} upper=${seed.firstBelowRangeRow.upperBin} pnl=${seed.firstBelowRangeRow.nearestPnlPct ?? seed.firstBelowRangeRow.pnlPct}`
      : "none";
    const prior = seed.samePoolPriorWin
      ? `${seed.samePoolPriorWin.pnlPct}% ${seed.samePoolPriorWin.minutesSince.toFixed(2)}m`
      : "none";
    lines.push(`| ${name} | ${seed.position ?? "missing"} | ${fmt(seed.pnlPct)} | ${fmt(seed.ageZeroHighDrawdownPct)} | ${below} | ${prior} |`);
  }
  lines.push("");
  lines.push("## Position Reconstruction");
  lines.push("");
  lines.push("| Pair | Position | Deploy | Close | Final PnL % | OHLCV high@entry % | Worst high DD % | First below-range |");
  lines.push("| --- | --- | --- | --- | ---: | ---: | ---: | --- |");
  for (const p of report.positions) {
    const below = p.firstBelowRangeRow
      ? `${p.firstBelowRangeRow.rangeSide} active=${p.firstBelowRangeRow.activeBin} lower=${p.firstBelowRangeRow.lowerBin} upper=${p.firstBelowRangeRow.upperBin} pnl=${fmt(p.firstBelowRangeRow.nearestPnlPct ?? p.firstBelowRangeRow.pnlPct)}`
      : "";
    lines.push(`| ${p.pair ?? "unknown"} | ${p.position} | ${p.deployTs ?? ""} | ${p.closeTs ?? ""} | ${fmt(p.finalPnlPct)} | ${fmt(p.ageZeroOhlcv?.highDrawdownPct)} | ${fmt(p.worstOhlcv.highDrawdownPct)} | ${below} |`);
  }
  lines.push("");
  appendVariantTable(lines, "OHLCV High-Drawdown Entry Veto Replay", report.replay.ohlcvHighDrawdown);
  appendVariantTable(lines, "OHLCV Entry-Drawdown Entry Veto Replay", report.replay.ohlcvEntryDrawdown);
  appendVariantTable(lines, "Same-Pool/Base-Mint Post-Win Cooldown Replay", report.replay.samePoolPostWinCooldown);
  appendVariantTable(lines, "Active-Bin Below-Range Replay", report.replay.activeBinBelowRange);
  appendVariantTable(lines, "OHLCV Compound Entry Veto Shadow Variants", report.replay.ohlcvCompoundEntryVeto);
  lines.push("## Evidence Files");
  lines.push("");
  for (const file of report.sourceFiles) lines.push(`- ${file}`);
  if (report.parseFailures.length) {
    lines.push("");
    lines.push("## Parse Failures");
    for (const failure of report.parseFailures) lines.push(`- ${failure.file}:${failure.line} ${failure.error}`);
  }
  return `${lines.join("\n")}\n`;
}

function appendVariantTable(lines, title, variants) {
  lines.push(`## ${title}`);
  lines.push("");
  lines.push("| Variant | Blocked | Avoided loss % | Blocked winner % | Missing evidence | Recommendation |");
  lines.push("| --- | ---: | ---: | ---: | ---: | --- |");
  for (const v of variants) {
    lines.push(`| ${v.name} | ${v.blockedCount} | ${fmt(v.avoidedLossPct)} | ${fmt(v.blockedWinnerPnlPct)} | ${v.missingEvidenceCount} | ${v.recommendation} |`);
  }
  lines.push("");
}

export function renderBelowRangeMarkdown(report) {
  const lines = [];
  lines.push("# Active-Bin Below-Range Emergency Replay");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Evidence window: ${report.evidenceWindow.from} through ${report.evidenceWindow.to}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("- Below-range alone is not recommended as a live direct-close rule.");
  lines.push("- Compound candidates with severe negative PnL or OHLCV entry collapse remain replay-only/default-off.");
  lines.push("");
  lines.push("## Below-Range Cases");
  lines.push("");
  lines.push("| Pair | Position | First below-range | Active | Lower | Upper | PnL near row % | Final PnL % | Outcome |");
  lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const p of report.belowRangeCases) {
    const row = p.firstBelowRangeRow;
    lines.push(`| ${p.pair} | ${p.position} | ${row.ts} | ${row.activeBin} | ${row.lowerBin} | ${row.upperBin} | ${fmt(row.nearestPnlPct ?? row.pnlPct)} | ${fmt(p.finalPnlPct)} | ${p.classification} |`);
  }
  lines.push("");
  appendVariantTable(lines, "Candidate Rule Replay", report.replay.activeBinBelowRange);
  return `${lines.join("\n")}\n`;
}

function fmt(value) {
  const num = finiteNumber(value);
  return num == null ? "" : String(Math.round(num * 10000) / 10000);
}

export function writeJsonAndMarkdown({ report, jsonPath, markdownPath, renderMarkdown }) {
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(markdownPath, renderMarkdown(report));
}
