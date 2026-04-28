# Meridian DLMM Agent

Autonomous Meteora DLMM liquidity management for Solana. Meridian screens pools, opens positions, monitors live PnL/range/yield, exits risk events, learns from closed trades, and reports through Telegram.

This repository supports two common operating lanes:

| Lane | Typical Branch | Purpose |
|---|---|---|
| Main Meridian | `experimental` | Larger deployment lane with more conservative screening |
| Meridian Nanocap | `nanocap-v1` | Lower-market-cap forward-test lane with faster rug/dump exits |

Do not commit `.env`, `user-config.json`, key material, live state, PM2 logs, or config backups. `user-config.example.json` documents intended settings; `user-config.json` is runtime-only.

---

## Current Capabilities

- **Meteora pool discovery** with hard prefilters before LLM: market cap, TVL, volume, holders, bin step, organic score, warnings, ownership flags, category, timeframe, and page size.
- **Nanocap expanded discovery**: supports configurable page size, extra categories such as `new`, and optional high-single-ownership exclusion.
- **Chart-gated entries**: RSI/Bollinger/Supertrend presets can confirm entries before the screener spends LLM calls.
- **LLM screener**: reviews eligible candidates, memory, GMGN/OKX/security signals, and decides deploy/no-deploy.
- **Deterministic dump protection**: hard stop, fast stop, velocity stop, early-dump stop, confirmed soft stop, and PnL snapshots.
- **Direct emergency exits**: urgent stop-loss paths bypass LLM and close directly.
- **Position management**: deterministic rules for stop loss, low yield, out-of-range, claims, trailing take-profit, operator notes, and instructions.
- **Darwin scoring**: learns from material closed outcomes and ranks candidates before final screener choice.
- **Material win metrics**: separates Raw WR, Material WR, neutral dust/operator closes, and Darwin material learning.
- **GMGN enrichment**: checks top holders, bot holders, bundle/sniper exposure, bluechip holders, global fees, and suspicious wallets.
- **Falling-knife and suspicious-volume vetoes**: deterministic pre-LLM filters for obvious dump/rug-like setups.
- **Range guard**: rejects tiny or malformed single-sided ranges and audits raw/normalized deploy ranges.
- **Relay hardening**: Agent Meridian relay first, LPAgent direct fallback, Meteora fallback, ownership guard, and retry-aware abort handling.
- **Telegram operations**: reports, `/setcfg`, `/screen`, `/positions`, settings menus, free-form operator requests, and live tool progress.
- **CLIProxyAPI routing**: SCREENER, GENERAL, and MANAGEMENT can use a VPS-local [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) OpenAI-compatible router. GENERAL/MANAGEMENT are dense non-reasoning routes.

---

## Architecture

Meridian is a ReAct-style agent system with deterministic policy gates wrapped around LLM decisions.

| Role | What It Does | Typical Trigger |
|---|---|---|
| `SCREENER` | Reviews candidate pools and may deploy | Screening cron or deploy-like Telegram command |
| `MANAGER` | Executes close/claim/instruction actions when deterministic policy says action is needed | Management cron only when action is needed |
| `GENERAL` | Operator chat, reports, manual research, status, explanations | Free-form Telegram or REPL |

Management cycles run on a schedule, but the MANAGER LLM is skipped when all positions are deterministic `STAY`. Urgent stop-loss exits bypass MANAGER entirely and close directly.

Core files:

| File | Purpose |
|---|---|
| `index.js` | Cron cycles, Telegram routing, PnL poller, management/screening orchestration |
| `agent.js` | Per-role LLM routes, tool selection, ReAct loop, API activity logging |
| `config-builder.js` | Runtime config assembly from `user-config.json` |
| `tools/screening.js` | Meteora discovery, candidate filters, chart indicator confirmation |
| `tools/dlmm.js` | Deploy/close/position/PnL logic |
| `stop-loss-policy.js` | Hard, fast, velocity, and confirmed stop-loss decisions |
| `state.js` | Position registry, PnL history, trailing TP, early dump logic |
| `tools/executor.js` | Tool dispatcher and operator-only config mutation gate |
| `pool-memory.js` | Pool performance memory and cooldowns |
| `signal-weights.js` | Darwin signal weighting |

---

## Nanocap Configuration Shape

Nanocap is the aggressive forward-test lane for low market cap mean reversion. Keep exact live values in private runtime config, not in public docs. A typical config shape looks like this:

```json
{
  "preset": "nanocap_mean_reversion",
  "deployAmountSol": "<per-position size>",
  "maxPositions": "<concurrent-position cap>",
  "maxDeployAmount": "<single-deploy safety cap>",

  "minMcap": "<lower market-cap bound>",
  "maxMcap": "<upper market-cap bound>",
  "minTvl": "<minimum TVL>",
  "maxTvl": "<maximum TVL>",
  "minVolume": "<minimum recent volume>",
  "minHolders": "<minimum holders>",
  "minBinStep": "<minimum bin step>",
  "maxBinStep": "<maximum bin step>",
  "minFeeActiveTvlRatio": "<minimum fee/active-TVL ratio>",
  "discoveryPageSize": "<candidate page size>",
  "discoveryExtraCategories": ["new"],
  "excludeHighSingleOwnership": "<true-or-false>",

  "entryPreset": "rsi_reversal",
  "indicatorIntervals": ["<entry interval>"],
  "rsiLength": "<RSI length>",
  "rsiOversold": "<oversold threshold>",
  "requireAllIntervals": "<true-or-false>",

  "stopLossPct": "<confirmed soft-stop pct>",
  "stopLossConfirmDelayMs": "<confirmation delay>",
  "hardStopLossPct": "<immediate hard-stop pct>",
  "stopLossFastClosePct": "<immediate fast-stop pct>",
  "stopLossVelocityWindowMs": "<velocity window>",
  "stopLossVelocityClosePct": "<velocity drop pct>",
  "earlyDumpPct": "<new-position dump pct>",
  "earlyDumpMaxAgeMin": "<early-dump age window>",

  "takeProfitPct": "<take-profit pct>",
  "trailingTakeProfit": true,
  "trailingTriggerPct": "<trail activation pct>",
  "trailingDropPct": "<trail giveback pct>",

  "screeningModel": "<screener model>",
  "screeningBaseUrl": "<OpenAI-compatible base URL>",
  "screeningReasoningEffort": "<optional screener reasoning effort>",

  "generalModel": "<general chat model>",
  "generalBaseUrl": "<OpenAI-compatible base URL>",

  "managementModel": "<management model>",
  "managementBaseUrl": "<OpenAI-compatible base URL>"
}
```

Do not add `generalReasoningEffort` or `managementReasoningEffort`. GENERAL and MANAGEMENT are dense non-reasoning routes. Only SCREENER uses `screeningReasoningEffort`.

## Main Configuration Shape

Main Meridian is the larger-size, more risk-averse lane. Keep its deploy sizing and screening thresholds private. A typical config shape looks like this:

```json
{
  "preset": "sol_dca_accumulator",
  "deployAmountSol": "<larger per-position size>",
  "maxPositions": "<conservative concurrent-position cap>",
  "maxDeployAmount": "<single-deploy safety cap>",

  "minTvl": "<minimum TVL>",
  "minFeeActiveTvlRatio": "<minimum fee/active-TVL ratio>",

  "entryPreset": "rsi_reversal",
  "indicatorIntervals": ["<entry interval>"],
  "rsiOversold": "<oversold threshold>",
  "exitPreset": null,

  "solMode": true,
  "trailingTakeProfit": true
}
```

Main should stay more conservative than nanocap because each deploy uses more capital. Keep wider nanocap recall experiments separate from main unless a forward-test result justifies promotion.

---

## Flash-Dump Protection

Nanocap exits are layered from fastest to slowest:

| Trigger | Behavior |
|---|---|
| `hardStopLossPct` | Immediate close at the hard loss threshold |
| `stopLossFastClosePct` | Immediate close at the fast-stop threshold |
| `stopLossVelocityClosePct` over `stopLossVelocityWindowMs` | Immediate close when losses accelerate quickly |
| `earlyDumpPct` within `earlyDumpMaxAgeMin` | Immediate close for fresh-position dumps |
| `stopLossPct` | Confirm after `stopLossConfirmDelayMs`, then close if still below threshold |

Urgent stop-loss paths in the PnL poller call `close_position` directly with `urgent: true`. They do not wait for MANAGER reasoning.

Useful proof commands:

```bash
node scripts/verify-emergency-stop-policy.js
node scripts/verify-stop-loss-trial-behavior.js
node scripts/analyze-pnl-snapshots.js --json
```

---

## LLM Routing

All LLM providers use OpenAI-compatible chat completions.

| Role | Example Route | Reasoning |
|---|---|---|
| SCREENER | Stronger model through an OpenAI-compatible router | Optional via `screeningReasoningEffort` |
| GENERAL | Dense chat/tool model through an OpenAI-compatible router | none |
| MANAGEMENT | Dense action model through an OpenAI-compatible router | none |
| SCREENER fallback | Separate compatible fallback provider | none |

Endpoint smoke test:

```bash
node scripts/verify-llm-endpoint.js \
  --base-url <openai-compatible-base-url> \
  --model <model-name> \
  --api-key NO_API_KEY \
  --chat-smoke \
  --tool-call-smoke
```

Runtime proof:

```bash
node scripts/verify-runtime-config.js --json
tail -n 40 logs/api-activity-$(date -u +%F).jsonl
```

Expected log shape:

```json
{"agent_role":"GENERAL","model":"<model-name>","base_url_host":"<host>","reasoning_effort":null,"status":"success"}
{"agent_role":"MANAGER","model":"<model-name>","base_url_host":"<host>","reasoning_effort":null,"status":"success"}
{"agent_role":"SCREENER","model":"<model-name>","base_url_host":"<host>","reasoning_effort":"<optional>","status":"success"}
```

The startup line `Model: ...` is legacy/global display text. Trust `verify-runtime-config.js` and `api-activity` for per-role routing.

---

## Setup

Requirements:

- Node.js 20 on VPS
- Solana wallet with SOL
- RPC endpoint
- Telegram bot token and allowed user IDs
- Optional OpenAI-compatible local or remote router, such as [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)

Install:

```bash
npm install
cp user-config.example.json user-config.json
cp .env.example .env
```

Minimum `.env` shape:

```env
WALLET_PRIVATE_KEY=<base58 private key>
RPC_URL=<solana rpc url>
DRY_RUN=true

TELEGRAM_BOT_TOKEN=<optional>
TELEGRAM_CHAT_ID=<required for Telegram>
TELEGRAM_ALLOWED_USER_IDS=<comma-separated user ids>

LPAGENT_API_KEY=<optional>
OKX_API_KEY=<optional>
GMGN_API_KEY=<optional>
```

Never commit `.env`, `user-config.json`, wallet keys, API keys, live state, logs, or config backups.

Local dry-run only:

```bash
npm run dev
```

Live production bots run on VPS under PM2. Do not run `node index.js` locally while a live VPS bot is running.

---

## VPS Operations

Main bot:

```bash
ssh <host> 'cd <main-bot-path> && git rev-parse --short HEAD && pm2 status <main-process-name>'
```

Nanocap bot:

```bash
ssh <host> 'cd <nanocap-bot-path> && git rev-parse --short HEAD && pm2 status <nanocap-process-name>'
```

Before analysis:

```bash
./scripts/sync-vps-full.sh
```

Before restart:

```bash
ssh <host> 'pm2 logs <process-name> --lines 120 --nostream'
```

Restart a process:

```bash
ssh <host> 'pm2 restart <process-name> --update-env'
```

Patch verifier:

```bash
node scripts/verify-patches.js
```

Runtime verifier:

```bash
node scripts/verify-runtime-config.js --json
```

---

## Telegram Tutorial

Free-form Telegram requests go to `GENERAL` unless they are deploy-like, in which case they go to `SCREENER`.

Examples:

```text
status?
what are your recommendations?
screen now and see if we can deploy any pools
find <PAIR> and screen
why was this pool skipped?
show wallet balances and open positions
```

Operator config changes should use explicit slash commands:

```text
/setcfg maxPositions <number>
/setcfg maxMcap <usd-cap>
/setcfg stopLossFastClosePct <negative-percent>
```

Free-form messages like `change maxPositions to <number>` may be answered conversationally by GENERAL and should not be trusted as persisted config unless the logs show `update_config`.

Settings menu and `/setcfg` use the operator-only `update_config` path. LLM free-form config mutation is blocked.

---

## Candidate Pipeline

1. Meteora discovery query applies hard filters.
2. Optional extra categories are merged and deduped.
3. Blacklists, cooldowns, ownership flags, warning filters, and launchpad filters apply.
4. Falling-knife and suspicious-volume vetoes remove obvious bad setups.
5. Chart indicators confirm entry, for example an RSI, Bollinger, or Supertrend preset on the configured interval.
6. GMGN/OKX/security enrichment adds holder and behavior signals.
7. Darwin ranks the shortlist.
8. SCREENER decides deploy or no-deploy.
9. Deploy path audits range and rejects malformed/tiny ranges before transaction.

Discovery filters are intentionally pre-LLM. If a pool never appears in candidates, inspect discovery filters first.

Useful manual checks:

```bash
node scripts/verify-runtime-config.js --json
node scripts/analyze-screener-trial.js --json
rg -n "Indicator rejected|Filtered cooldown|NO DEPLOY|DEPLOYED" logs/agent-$(date -u +%F).log
```

---

## Management Pipeline

1. Fetch open positions.
2. Update tracked state, OOR state, PnL history, peak PnL, and snapshots.
3. Apply immediate exits: hard, fast, velocity, early dump, urgent OOR.
4. Queue confirmed exits: ordinary soft stop and trailing TP rechecks.
5. Apply deterministic close/claim rules.
6. If all positions are `STAY`, skip MANAGER LLM.
7. If action is required, MANAGER executes only the required tool calls.
8. After management, screening may run if there is free capacity.

Useful log patterns:

```bash
rg -n "Hard stop loss|Fast stop loss|Velocity stop loss|Early dump|Stop loss candidate|Stop loss confirmed|Direct stop-loss close" logs/agent-$(date -u +%F).log
rg -n '"agent_role":"MANAGER"' logs/api-activity-$(date -u +%F).jsonl
```

---

## Learning And Reports

Closed outcomes are classified into:

- raw wins/losses
- material wins
- material losses
- neutral dust/low-yield/operator closes

Darwin can exclude neutral outcomes so low-yield dust closes do not distort strategy learning.

Useful commands:

```bash
node scripts/analyze-material-wins.js --actions logs --json
node scripts/analyze-pnl-snapshots.js --json
node scripts/analyze-llm-usage.js --json
```

---

## Git And Branch Hygiene

Live code branches:

```text
experimental  -> main VPS bot
nanocap-v1    -> nanocap VPS bot
```

Suggested local worktree intent:

```text
<main-worktree>     experimental
<nanocap-worktree>  nanocap-v1
```

Old worktrees should be archived or removed instead of left around as active-looking branches.

Before pushing code:

```bash
node scripts/verify-patches.js
git status --short --branch
```

Push nanocap:

```bash
git push origin nanocap-v1
git push private nanocap-v1
```

Push main:

```bash
git push origin experimental
git push private experimental
```

---

## Safety Rules

- Do not run `node index.js` locally while a VPS bot is live.
- Do not restart without checking PM2 logs first.
- Do not commit credentials or runtime config.
- Do not edit `CLAUDE.md` or `GEMINI.md` directly; keep `AGENTS.md` canonical and use the refresh workflow.
- Use `/setcfg` or CLI config set for live config changes.
- Use `verify-runtime-config.js --json` after config changes.
- Use `verify-patches.js` before pushing code.
