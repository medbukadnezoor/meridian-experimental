# Phase 2A Oracle Scout Runbook

Purpose: run a third, isolated Meridian instance with tiny live sizing and loose filters to accelerate active-bin oracle evidence collection. This scout is for oracle/rug-signal stress data only. Do not treat its trade outcomes as evidence for main or nanocap strategy promotion.

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
