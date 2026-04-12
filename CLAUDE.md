# Meridian — CLAUDE.md

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

---

## ⚠️ MANDATORY SAFETY PROTOCOLS — READ BEFORE ANY ACTION

**This bot runs with real SOL on Solana mainnet. These steps are non-negotiable.**

### Bot runs on VPS — NOT locally

The bot runs under PM2 on VPS `ohox` (43.156.182.93). **Do NOT run `node index.js` locally on Mac.**

```bash
# To restart the bot (pull latest code + restart):
ssh ohox mp

# To restart without pulling (e.g. after config change already on VPS):
ssh ohox "mr"

# To check logs:
ssh ohox "ml"
```

### BEFORE pushing code changes

Run patch verification on Mac first. If it fails, STOP and fix before pushing:
```bash
node scripts/verify-patches.js
```
All checks must show ✅. If any show ❌, do not push or restart.

**Authentication for `git push`**: 
Use the `GITHUB_PERSONAL_ACCESS_TOKEN` stored in the workspace-level `.env` file (`/Users/user/Trading Project Files/DLMM/.env`). If prompted for a password during `git push`, use this PAT instead of your account password.

### BEFORE any `git rebase`

All steps required, in order:
```bash
# 1. Rsync live state from VPS back to Mac (Darwin weights live on VPS, not in git)
rsync -avz ubuntu@ohox:~/meridian/signal-weights.json \
            ubuntu@ohox:~/meridian/lessons.json \
            ubuntu@ohox:~/meridian/pool-memory.json \
            ./

# 2. Tag current HEAD
git tag -a vX.Y.Z-pre-rebase -m "Pre-rebase snapshot $(date +%Y-%m-%d)"

# 3. Back up runtime state
bash scripts/backup-state.sh pre-rebase-$(date +%Y%m%d)
```
Then rebase. Then immediately: `node scripts/verify-patches.js`
Then push and deploy: `git push private experimental && ssh ohox mp`

### MANDATORY patches — must survive every rebase

| Patch | File | Why |
|-------|------|-----|
| Stop-loss 12h cooldown on pool + mint | `pool-memory.js` | Bot re-enters dumping tokens immediately without this. Now also configurable via `stopLossCooldownHours` in user-config. |
| OPERATOR COMMAND Telegram wrapping | `index.js` | Prompt injection hardening — upstream keeps removing this |
| `managementModel`/`screeningModel`/`generalModel` ABSENT from CONFIG_MAP | `tools/executor.js` | **Security**: LLM cannot mutate its own model routing |
| Qwen DashScope `tool_choice` rejection fix | `agent.js` | DashScope thinking mode rejects `tool_choice: "required"`. Code drops parameter on error and retries — confirmed working. 25 screener "errors" in logs are expected retry events, not failures. |

### Bin count guard (v1.0.7) — `tools/dlmm.js`
The LLM occasionally hallucinates large bin counts (e.g. types "690" instead of "69") which causes a Rust integer overflow in Meteora's `InitializePosition`. A general max-bins clamp (≤200 total) is applied after the `downside_pct` block — it preserves the `bins_above/bins_below` ratio and does NOT force symmetry. Single-sided `bid_ask` (`bins_above=0`) is **valid** and the SDK handles it natively via `toWeightBidAsk()`.

### Strategy library vs user-config (architecture note)
`strategy-library.json` takes full precedence over `user-config.json`'s `strategy` field. `index.js` calls `getActiveStrategy()` and injects the active entry into the screener system prompt as `ACTIVE STRATEGY: <name> — LP: <type>`. The LLM always uses the library entry. Changing `strategy` in `user-config.json` has **no effect** while a library strategy is active.

`single_sided_reseed` = EXIT strategy (token→SOL, high bins_above).
`sol_dca_accumulator` = ENTRY strategy (SOL→token, bins_below=69, bins_above=0, bid_ask). Currently used as the active primary strategy.

### Chart indicator philosophy (mean-reversion style)
The active strategy is a passive accumulator (wide downside bins, tight stop-loss, small trailing TP). Indicator config is tuned accordingly:

- **Entry** `entryPreset: rsi_reversal` — only allows new deploys when RSI ≤ `rsiOversold` (currently **35**, widened from 25 on 2026-04-12 for data volume). Prevents chasing momentum or deploying into a pump. Correct behaviour for "buy weakness" accumulation. If win rate drops, tighten back toward 25-30.
- **Exit** `exitPreset: null` — **disabled intentionally**. When null, `confirmIndicatorPreset()` returns `confirmed: true` unconditionally, meaning indicators never gate trailing TP, stop-loss, or OOR closes. This prevents the common failure mode where `supertrend_break` blocks exits during the exact conditions they're needed.
  - **Bug fixed (commit `a746df8`, 2026-04-12):** `config.js` was using `??` (nullish coalescing) to resolve presets, which coerces JSON `null` to the hardcoded default `"supertrend_break"`. Setting `exitPreset: null` in user-config had no runtime effect — the bot ran `supertrend_break` regardless. Fixed with `"exitPreset" in indicatorUserConfig ? value : default` so null is preserved. If `exitPreset: null` is set, `chart-indicators.js:161` (`if (!preset)`) now correctly short-circuits to `{ confirmed: true }`. Same fix applied to `entryPreset`.
- **Why not `supertrend_break` for exit?** Supertrend exit is a momentum-following gate — it fires on trend breaks, not on mean-reversion profit targets. It was blocking trailing TP and OOR closes in live Telegram reports. Not suitable for this style.
- **Available presets (in codebase):** `supertrend_break`, `rsi_reversal`, `bollinger_reversion`, `rsi_plus_supertrend`. (Note: some Telegram-mentioned presets like `bb_plus_rsi`, `fibo_reclaim` are NOT yet implemented.)

> Upstream (yunus-0x/meridian) has actively reversed all 3 of these patches. Assume every rebase will drop them.

### NEVER without explicit operator instruction
- Add model keys to `CONFIG_MAP` in `tools/executor.js`
- Force-push to `experimental`
- Restart the bot after a failed `verify-patches.js`
- Modify `user-config.json` model fields without operator approval

---

## Architecture Overview

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop (OpenRouter/OpenAI-compatible): LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env; exposes config object
prompt.js           Builds system prompt per agent role (SCREENER / MANAGER / GENERAL)
state.js            Position registry (state.json): tracks bin ranges, OOR timestamps, notes
lessons.js          Learning engine: records closed-position perf, derives lessons, evolves thresholds
pool-memory.js      Per-pool deploy history + snapshots (pool-memory.json)
strategy-library.js Saved LP strategies (strategy-library.json)
briefing.js         Daily Telegram briefing (HTML)
telegram.js         Telegram bot: polling, notifications (deploy/close/swap/OOR)
hive-mind.js        Optional collective intelligence server sync
smart-wallets.js    KOL/alpha wallet tracker (smart-wallets.json)
token-blacklist.js  Permanent token blacklist (token-blacklist.json)
logger.js           Daily-rotating log files + action audit trail

tools/
  definitions.js    Tool schemas in OpenAI format (what LLM sees)
  executor.js       Tool dispatch: name → fn, safety checks, pre/post hooks
  dlmm.js           Meteora DLMM SDK wrapper (deploy, close, claim, positions, PnL)
  screening.js      Pool discovery from Meteora API
  wallet.js         SOL/token balances (Helius) + Jupiter swap
  token.js          Token info/holders/narrative (Jupiter API)
  study.js          Top LPer study via LPAgent API
```

---

## Agent Roles & Tool Access

Three agent roles filter which tools the LLM can call:

| Role | Purpose | Key Tools |
|------|---------|-----------|
| `SCREENER` | Find and deploy new positions | deploy_position, get_top_candidates, get_token_holders, check_smart_wallets_on_pool |
| `MANAGER` | Manage open positions | close_position, claim_fees, swap_token, get_position_pnl, set_position_note |
| `GENERAL` | Chat / manual commands | All tools |

Sets defined in `agent.js:6-7`. If you add a tool, also add it to the relevant set(s).

---

## Adding a New Tool

1. **`tools/definitions.js`** — Add OpenAI-format schema object to the `tools` array
2. **`tools/executor.js`** — Add `tool_name: functionImpl` to `toolMap`
3. **`agent.js`** — Add tool name to `MANAGER_TOOLS` and/or `SCREENER_TOOLS` if role-restricted
4. If the tool writes on-chain state, add it to `WRITE_TOOLS` in executor.js for safety checks

---

## Config System

`config.js` loads `user-config.json` at startup. Runtime mutations go through `update_config` tool (executor.js) which:
- Updates the live `config` object immediately
- Persists to `user-config.json`
- Restarts cron jobs if intervals changed

**Valid config keys and their sections:**

| Key | Section | Default |
|-----|---------|---------|
| minFeeActiveTvlRatio | screening | **0.07** (widened to 0.05 on 2026-04-12, evolved to 0.07 by lessons at 13:31 same day) |
| minTvl / maxTvl | screening | 10k / 150k |
| minVolume | screening | **3000** (widened from 10000 on 2026-04-12) |
| minOrganic | screening | **70** (VPS live; default is 60) |
| minHolders | screening | 500 |
| minMcap / maxMcap | screening | 150k / **5M** (VPS; default 10M) |
| minBinStep / maxBinStep | screening | 80 / 125 |
| timeframe | screening | "4h" (VPS; default "5m") |
| category | screening | "trending" |
| minTokenFeesSol | screening | 30 |
| maxBundlePct | screening | 30 |
| maxTop10Pct | screening | 60 |
| maxBotHoldersPct | screening | **35** (VPS; default 30) |
| athFilterPct | screening | **-10** (VPS; only deploy if price ≥ 10% below ATH; default null) |
| minTokenAgeHours / maxTokenAgeHours | screening | **3 / 720** (VPS; default null/null) |
| blockPvpSymbols | screening | **true** (VPS; hard-filter PVP rivals; default false) |
| blockedLaunchpads | screening | [] |
| deployAmountSol | management | **0.7** (VPS; default 0.5) |
| maxDeployAmount | risk | 200 (VPS; default 50) |
| maxPositions | risk | **4** (VPS; default 3) |
| gasReserve | management | 0.2 |
| positionSizePct | management | 0.35 |
| minSolToOpen | management | 0.15 (VPS) |
| outOfRangeWaitMinutes | management | 180 |
| outOfRangeHardCloseMinutes | management | 240 |
| outOfRangeBinsToClose | management | 50 |
| stopLossPct | management | **-5%** |
| takeProfitPct | management | **6%** (VPS; default 5%) |
| trailingTriggerPct | management | 3% |
| trailingDropPct | management | **2.5%** (VPS; default 1.5%) |
| stopLossCooldownHours | management | **3h** (VPS override; pool-memory.js default is 12h) |
| oorCooldownHours / oorCooldownTriggerCount | management | **8h / 4** (VPS; default 12h / 3) |
| autoSwapAfterClaim | management | **true** (VPS; default false) |
| managementIntervalMin | schedule | 10 |
| screeningIntervalMin | schedule | **20** (VPS; default 30) |
| managementModel / screeningModel / generalModel | llm | **qwen3.6-plus** (DashScope Singapore) |
| chartIndicators.entryPreset | indicators | **rsi_reversal** (confirmed working — RSI ≤ 35 on 5_MINUTE) |
| chartIndicators.exitPreset | indicators | **null** (disabled — exits always confirmed; bug fixed in a746df8) |
| chartIndicators.rsiOversold | indicators | **35** (widened from 25 on 2026-04-12) |
| chartIndicators.rsiOverbought | indicators | 80 |
| chartIndicators.intervals | indicators | **["5_MINUTE"]** (VPS; default ["5_MINUTE", "15_MINUTE"]) |

**Per-role LLM override fields** (`managementBaseUrl`, `managementApiKey`, `generalBaseUrl`, `generalApiKey`) default to `null`. When null, the role falls back to the global `llmBaseUrl` + `llmApiKey`. Set them only if you want a specific role to use a different provider or model endpoint.

**`computeDeployAmount(walletSol)`** — scales position size with wallet balance (compounding). Formula: `clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)`.

---

## Position Lifecycle

1. **Deploy**: 5-tool parallel fetch (see below) → SCREENER decides → `deploy_position` → executor safety checks → `trackPosition()` in state.js → Telegram notify
2. **Monitor**: management cron → `getMyPositions()` → `getPositionPnl()` → OOR detection → pool-memory snapshots
3. **Close**: `close_position` → `recordPerformance()` in lessons.js → auto-swap base token to SOL → Telegram notify
4. **Learn**: `evolveThresholds()` runs on performance data → updates config.screening → persists to user-config.json

---

## Screener Parallel Fetch (prompt.js — GENERAL role)

Before every deploy, the SCREENER calls **5 tools in a single parallel batch** (not sequentially):

| Tool | Purpose |
|------|---------|
| `get_pool_detail` | Current TVL, volume, fee/TVL, bin step, volatility |
| `check_smart_wallets_on_pool` | Are tracked smart wallets active here? |
| `get_token_holders` | Holder distribution, global fees, organic score |
| `get_token_narrative` | Is there a real story? Narrative quality signal |
| `study_top_lpers` | Winner positioning: avg hold time, range width, scalper vs holder dominance, suggested_range |

`study_top_lpers` data is used as a **prior** to calibrate `bins_below` and strategy choice. It does NOT override the formula or lessons. If it returns an error, the deploy proceeds on the remaining four signals.

---

## Screener Safety Checks (executor.js)

Before `deploy_position` executes:
- `bin_step` must be within `[minBinStep, maxBinStep]`
- Position count must be below `maxPositions` (force-fresh scan, no cache)
- No duplicate pool allowed (same pool_address)
- No duplicate base token allowed (same base_mint in another pool)
- If `amount_x > 0`: strip `amount_y` and `amount_sol` (tokenX-only deploy — no SOL needed)
- SOL balance must cover `amount_y + gasReserve` (skipped for tokenX-only)
- `blockedLaunchpads` enforced in `getTopCandidates()` before LLM sees candidates

---

## bins_below Calculation (SCREENER)

Linear formula based on pool volatility (set in screener prompt, `index.js`):

```
bins_below = round(35 + (volatility / 5) * 34), clamped to [35, 69]
```

- Low volatility (0) → 35 bins
- High volatility (5+) → 69 bins
- Any value in between is valid (continuous, not tiered)

---

## Telegram Commands

Handled directly in `index.js` (bypass LLM):

| Command | Action |
|---------|--------|
| `/help` | List all commands |
| `/status` | Wallet + positions snapshot |
| `/positions` | List open positions |
| `/pool <n>` | Detailed info for one open position |
| `/close <n>` | Close position by list index |
| `/closeall` | Close all open positions |
| `/set <n> <note>` | Set note/instruction on position |
| `/cooldowns` | Active cooldowns (Xh Ym left) + recently cleared in last 2h (cleared Xh Ym ago). Logs `[cooldowns]` trace on every call. |
| `/config` | Show important runtime config |
| `/setcfg <key> <value>` | Update persisted config live |
| `/screen` | Refresh deterministic candidate list |
| `/candidates` | Show latest cached candidates |
| `/deploy <n>` | Deploy candidate by cached index |
| `/briefing` | Morning briefing |
| `/autoresearch` | Shadow autoresearch status |
| `/hive` | HiveMind sync status |
| `/pause` / `/resume` | Stop / start cron cycles |
| `/stop` | Shut down agent |

---

## Race Condition: Double Deploy

`_screeningLastTriggered` in index.js prevents concurrent screener invocations. Management cycle sets this before triggering screener. Also, `deploy_position` safety check uses `force: true` on `getMyPositions()` for a fresh count.

---

## Bundler Detection (token.js)

Two signals used in `getTokenHolders()`:
- `common_funder` — multiple wallets funded by same source
- `funded_same_window` — multiple wallets funded in same time window

**Thresholds in config**: `maxBundlersPct` (default 30%), `maxTop10Pct` (default 60%)
Jupiter audit API: `botHoldersPercentage` (5–25% is normal for legitimate tokens)

---

## Base Fee Calculation (dlmm.js)

Read from pool object at deploy time:
```js
const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
const actualBaseFee = baseFactor > 0
  ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4))
  : null;
```

---

## Model Configuration

- Default model: `process.env.LLM_MODEL` or `openrouter/healer-alpha`
- Fallback on 502/503/529: `stepfun/step-3.5-flash:free` (2nd attempt), then retry
- Per-role models: `managementModel`, `screeningModel`, `generalModel` in user-config.json
- LM Studio: set `LLM_BASE_URL=http://localhost:1234/v1` and `LLM_API_KEY=lm-studio`
- `maxOutputTokens` minimum: 2048 (free models may have lower limits causing empty responses)

---

## Lessons System

`lessons.js` records closed position performance and auto-derives lessons. Key points:
- `getLessonsForPrompt({ agentType })` — injects relevant lessons into system prompt
- `evolveThresholds()` — adjusts screening thresholds based on winners vs losers
- Performance recorded via `recordPerformance()` called from executor.js after `close_position`
- **Known issue**: `evolveThresholds()` references `maxVolatility` and `minFeeTvlRatio` but config.js uses `minFeeActiveTvlRatio` and has no `maxVolatility` key — the evolution of these keys is a no-op

---

## Hive Mind (hive-mind.js)

Optional feature. Enabled by setting `HIVE_MIND_URL` and `HIVE_MIND_API_KEY` in `.env`.
Syncs lessons/deploys to a shared server, queries consensus patterns.
Not required for normal operation.

---

## Environment Variables

| Var | Required | Purpose |
|-----|----------|---------|
| `WALLET_PRIVATE_KEY` | Yes | Base58 or JSON array private key |
| `RPC_URL` | Yes | Solana RPC endpoint |
| `OPENROUTER_API_KEY` | Yes | LLM API key |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target |
| `LLM_BASE_URL` | No | Override for local LLM (e.g. LM Studio) |
| `LLM_MODEL` | No | Override default model |
| `DRY_RUN` | No | Skip all on-chain transactions |
| `HIVE_MIND_URL` | No | Collective intelligence server |
| `HIVE_MIND_API_KEY` | No | Hive mind auth token |
| `HELIUS_API_KEY` | No | Enhanced wallet balance data |

---

## Known Issues / Tech Debt

- `lessons.js evolveThresholds()` — code is CORRECT (uses `minFeeActiveTvlRatio` and `minOrganic`). The previous "wrong key names" bug is fixed. Old CLAUDE.md documentation was stale. What it actually does: every 5 closes, nudges `minFeeActiveTvlRatio` and `minOrganic` up when winners consistently separate from losers. Max 20% per step; writes to user-config.json and applies immediately.
- `get_wallet_positions` tool — only available in GENERAL role (not in SCREENER_TOOLS or MANAGER_TOOLS). This is intentional: the autonomous agents use `getMyPositions()` (on-chain LP positions) not wallet balance lookups. Not blocking normal operation.
- Stop-loss cooldown (12h), low-yield cooldown (4h), anti-chase cooldown (2h) are hardcoded in `pool-memory.js`. They are NOT user-config keys. `stopLossCooldownHours` has been added to make the stop-loss cooldown configurable.
