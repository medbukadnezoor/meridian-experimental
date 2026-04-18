# Claude Code context — meridian-exp-sync
# This file is auto-synced from AGENTS.md via project-sync.
# To update: edit AGENTS.md, then run project-sync.

# meridian-experimental

## What This Repo Is
Live DLMM LP bot for Meteora on Solana. This is the production codebase — `experimental` branch, real-money operation on VPS ohox.

## Start Here
- Read [CHANGELOG.md](/Users/user/Trading%20Project%20Files/DLMM/meridian-experimental/CHANGELOG.md) first for release-by-release context.
- Review the current Darwin logic in [signal-weights.js](/Users/user/Trading%20Project%20Files/DLMM/meridian-experimental/signal-weights.js) and [tools/screening.js](/Users/user/Trading%20Project%20Files/DLMM/meridian-experimental/tools/screening.js).

## Current Operational Context
[CONFIRMED] Bot Version: **v1.0.9** (Enabled solMode + TP 4% on 2026-04-13)
[CONFIRMED] Bot Host: VPS **ohox** (TencentCloud Singapore, 43.156.182.93) under PM2.
[CONFIRMED] Current VPS PM2 runtime state (2026-04-18): `stopped` during critical main/experimental update staging. Verify with `ssh ohox ms` before restart.
[CONFIRMED] Security Status: ACTIVE (8 patches maintained).
[CONFIRMED] Active Role Models: All use `qwen3.6-plus` via DashScope Singapore.
[CONFIRMED] **takeProfitPct: 4%** / **deployAmountSol: 3.0** (Upsized 2026-04-15) / **maxPositions: 3** (Upsized 2026-04-15). `takeProfitFeePct` is still present in live config for compatibility, but current live branches treat it as a fallback alias into `takeProfitPct`, not as a separate runtime fee gate.
[CONFIRMED] **solMode: true** / **minTvl: 20000** (Upsized 2026-04-15) — All PnL/balance reporting in SOL. Close path now correctly reads `.sol` fields from Meteora datapi (fixed 2026-04-14, commit `f4911a1`). Both relay and non-relay paths branch on `solMode`. Fallback cache reads also use SOL-denominated fields. `lessons.json` performance records now store SOL values in `initial_value_usd`, `final_value_usd`, `fees_earned_usd` when solMode=true.
[CONFIRMED] **minFeeActiveTvlRatio: 0.08** (example baseline; evolved by Darwin).
[CONFIRMED] **Stop Loss: -5%** with 3h cooldown.
[CONFIRMED] **OOR Cooldown: 8h** after 4 consecutive OOR exits.
[CONFIRMED] **OOR Hard Close: 240m**.

## Safety Protocol
**The bot runs on VPS ohox, NOT locally. Do NOT run `node index.js` on Mac.**

### Restarting the bot
```bash
# From Mac — pull latest code and restart PM2:
ssh ohox mp
# Or just restart without pull:
ssh ohox "mr"
# Check logs after restart:
ssh ohox "ml"
```

## Strategy Library — Key Architecture Note
The strategy library (`strategy-library.json`) defines the LP posture injected into screening and should be treated as the live intent. Current code still retains `config.strategy.*` helper fallbacks underneath when a deploy call omits strategy fields, so this is not a hard deletion of config defaults.
[CONFIRMED] Active Strategy: **`sol_dca_accumulator`** — SOL accumulation on dips, RSI ≤ 35 entry gate.

## VPS Operations
| Task | Command |
|------|---------|
| Deploy code change | Commit → Push → `ssh ohox mp` |
| View live logs | `ssh ohox ml` |
| Check drift | `ssh ohox "node scripts/config-check.js"` |

## Rules for this project
- `AGENTS.md` is the source of truth. Never edit `CLAUDE.md` or `GEMINI.md` directly.
- **Config workflow (MANDATORY):** Edit example locally → commit + push → apply to VPS. Run `config-check.js` to detect drift.
- **Workspace git discipline**: This repo (`meridian-experimental/`) is its own git repo. Root `DLMM/` is a separate git repo.

---
*Edit this file to update project context.*
*Run project-sync after any edit to keep CLAUDE.md and GEMINI.md in sync.*
