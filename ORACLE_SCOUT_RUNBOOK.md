# Phase 2A Oracle Scout Runbook

Purpose: run a third, isolated Meridian instance with tiny live sizing and loose filters to accelerate active-bin oracle evidence collection. This scout is for oracle/rug-signal stress data only. Do not treat its trade outcomes as evidence for main or nanocap strategy promotion.

## Current Status

Confirmed read-only on 2026-05-03:

- Local worktree: `.worktrees/meridian-oracle-scout`
- Branch: `codex/oracle-scout-v1`
- Head: `38509a2`
- VPS directory: `~/meridian-scout`
- PM2 process name: `meridian-oracle-scout`
- PM2 state at check time: online
- Synced evidence path: `meridian-intelligence/data/vps-logs/scout/logs/`
- Active-bin oracle rows are present in `active-bin-oracle-2026-05-03.jsonl`

Do not create another scout unless this one is intentionally retired.

## Source

- Branch: `codex/oracle-scout-v1`
- Base: `private/nanocap-v1`
- Intended VPS directory: `~/meridian-scout`
- Intended PM2 process name: `meridian-oracle-scout`

## Fill These Blanks

Copy `user-config.oracle-scout.template.json` to `user-config.json` inside the scout directory, then fill:

- `walletKey`: Base58 private key for the dedicated scout wallet.
- `rpcUrl`: dedicated Helius Solana RPC URL. The active-bin oracle derives WebSocket transport from this URL.

Create a minimal `.env` in the scout directory with:

```bash
DEEPSEEK_API_KEY=FILL_DEEPSEEK_API_KEY
```

Optional `.env` values:

```bash
HELIUS_API_KEY=FILL_HELIUS_API_KEY_FOR_WALLET_BALANCE_ONLY
GMGN_API_KEY=FILL_GMGN_KEY_ONLY_IF_YOU_WANT_GMGN_ENRICHMENT
```

Do not add these for the scout:

```bash
LPAGENT_API_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_ALLOWED_USER_IDS=
```

## API Policy

- Open-position/PnL primary path: public Agent Meridian relay via `https://api.agentmeridian.xyz/api`.
- PnL fallback path: Meteora public datapi.
- Direct LPAgent path is skipped when `LPAGENT_API_KEY` is absent.
- Telegram is intentionally disabled; inspect logs directly.

## Safety Bounds

Initial profile:

- live mode, not dry-run
- `deployAmountSol`: `0.15`
- `maxPositions`: `1`
- `maxDeployAmount`: `0.25`
- hard stop: `-10%`
- soft stop: `-6%` with confirmation
- active-bin oracle and PnL snapshots enabled

Suggested stop criteria:

- stop immediately if active-bin oracle rows do not appear after the first open position
- stop if wallet drawdown reaches roughly `0.25 SOL`
- stop if there is any repeated close/relay failure
- review after 12-24 hours before increasing to two positions

## Whale Escape Run Plan

Whale Escape is a shadow-only research lane that asks:

```text
Are other LPs withdrawing liquidity while our active bin is near the lower edge of our position?
```

The scout is the first target because it is isolated from main and nanocap and already produces active-bin oracle rows.

Target future JSONL fields:

```text
pool_lp_net_dep_usd_5m
pool_lp_net_dep_usd_15m
pool_lp_net_dep_usd_30m
pool_lp_add_count_5m
pool_lp_remove_count_5m
pool_lp_largest_remove_usd_5m
bin_distance_to_lower
bin_distance_to_upper
range_width_bins
range_proximity_zone
previous_range_proximity_zone
range_position_pct
bin_distance_to_lower_pct_of_range
bin_distance_to_upper_pct_of_range
time_in_current_range_zone_minutes
whale_escape_shadow_signal
whale_escape_shadow_reason
whale_escape_data_source
```

Rules:

- Shadow-only. No exits, deploy blocks, screening changes, cooldowns, or quarantine writes.
- Missing data must be explicit `null`.
- `whale_escape_shadow_signal` may only be `null`, `"watch"`, or `"candidate"`.
- First implementation must be scout-only. Port to nanocap/main only after calibration evidence.

Initial log-only labels:

```text
watch:
  pool_lp_net_dep_usd_15m <= -2500
  AND bin_distance_to_lower <= 6

candidate:
  pool_lp_net_dep_usd_15m <= -5000
  AND bin_distance_to_lower <= 4
  AND pnl_pct > -2
```

Collection checkpoints:

- 2h: rows contain the new fields and no decode-error spam.
- 12h: count `watch` / `candidate` labels and inspect obvious false positives.
- 24h: compare labels to PnL deterioration, OOR events, and stop-loss events.
- 48h: decide whether to port shadow-only logging to nanocap/main.

Stop criteria:

- Scout active-bin rows stop appearing while positions are open.
- LP-flow decode errors spam logs.
- Scout drawdown reaches the owner-defined cap.
- Scout deploy/close failures repeat.
- Any code path can act on `whale_escape_shadow_signal`.

Owner checks after implementation:

```bash
./scripts/sync-vps-full.sh
tail -5 meridian-intelligence/data/vps-logs/scout/logs/active-bin-oracle-$(date -u +%F).jsonl
node .worktrees/meridian-oracle-scout/scripts/report-whale-escape-calibration.js \
  --input meridian-intelligence/data/vps-logs/scout/logs/active-bin-oracle-$(date -u +%F).jsonl
```

## After Whale Escape: LP-Flow Telemetry Backlog

This is a hypothesis-only menu after Whale Escape, not permission to ship more live exits.

Milestone order:

1. `LPTELE-1` position-relative bin proximity: `bin_distance_to_lower`, `bin_distance_to_upper`, range width, range-position pct, range proximity zone, previous zone, and time spent in the current range zone.
2. `LPTELE-2` bin-localized liquidity shape: quote reserves near active bin, adjacent-bin liquidity cliffs, and our share of active-bin TVL.
3. `LPTELE-3` tagged LP flow: net deposits/removes split by smart wallets, bot holders, and other LPs.
4. `LPTELE-4` aggressive sell pressure: rolling buy/sell USD, sell/buy ratio, large sells, and swap slippage.
5. `LPTELE-5` fee-velocity drift: fee/TVL and fees-earned-per-minute trend versus entry.

Rules:

- Add one signal family at a time.
- Keep all fields shadow-only until calibration says otherwise.
- Prefer compact nullable fields in `active-bin-oracle-YYYY-MM-DD.jsonl`.
- Add a dedicated calibration report per family.
- Do not add live exits, deploy blocks, cooldowns, quarantine writes, or hard pre-entry filters from this backlog without a new owner-approved ticket.

## Start Later

Do not start the process until the wallet is funded and the blanks above are filled. Before starting, check existing bot logs/PM2 state, then run the verifier:

```bash
node scripts/verify-patches.js
```

Expected evidence files after start:

- `logs/active-bin-oracle-YYYY-MM-DD.jsonl`
- `logs/pnl-snapshots-YYYY-MM-DD.jsonl`
- `logs/actions-YYYY-MM-DD.jsonl`
- `logs/agent-YYYY-MM-DD.log`
