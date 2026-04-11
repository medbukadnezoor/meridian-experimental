# meridian-experimental

## What This Repo Is
Live DLMM LP bot for Meteora on Solana. This is the production codebase — `experimental` branch, real-money operation on VPS ohox.

## Start Here
- Read [CHANGELOG.md](/Users/user/Trading%20Project%20Files/DLMM/meridian-experimental/CHANGELOG.md) first for release-by-release context.
- Review the current Darwin logic in [signal-weights.js](/Users/user/Trading%20Project%20Files/DLMM/meridian-experimental/signal-weights.js) and [tools/screening.js](/Users/user/Trading%20Project%20Files/DLMM/meridian-experimental/tools/screening.js).
- Review deploy/management flow in [index.js](/Users/user/Trading%20Project%20Files/DLMM/meridian-experimental/index.js), [signal-tracker.js](/Users/user/Trading%20Project%20Files/DLMM/meridian-experimental/signal-tracker.js), and [autoresearch.js](/Users/user/Trading%20Project%20Files/DLMM/meridian-experimental/autoresearch.js).
- HiveMind setup details live in [docs/hivemind-reference.md](/Users/user/Trading%20Project%20Files/DLMM/meridian-experimental/docs/hivemind-reference.md).

## Current Operational Context
- Current release context: `v1.0.7`
- **Bot runs on VPS `ohox` (TencentCloud Singapore, 43.156.182.93) under PM2. NOT running locally on Mac.**
- `v1.0.5` added GMGN Phase 1 enrichment: `tools/gmgn.js`, sniper/bluechip/bundler signals, bot-holder filter.
- `v1.0.6` added LP Army config experiment: `minFeeActiveTvlRatio=0.15`, `maxPositions=4`, `minBinStep=100`. Added chart indicator layer (`signal-tracker.js`, `autoresearch.js`). Darwin expanded to 17 signals (15 + gmgn_bluechip_present + gmgn_bundler_present).
- VPS `user-config.json` uses `outOfRangeWaitMinutes: 15` and `outOfRangeHardCloseMinutes: 20`.
- Screening Phase 0 safety filter is live: Jupiter audit now hard-drops candidates whose mint authority or freeze authority is still enabled.
- GMGN Phase 1 is live: bot-holder filter (>35% bots → drop) + Darwin signal wiring.

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

### Before pushing logic changes
- Run `node scripts/verify-patches.js` on Mac first — all 12 checks must pass before pushing.

### Before any rebase
1. Rsync state files FROM VPS back to Mac first (Darwin weights, lessons, pool-memory):
   ```bash
   rsync -avz ubuntu@ohox:~/meridian/signal-weights.json \
               ubuntu@ohox:~/meridian/lessons.json \
               ubuntu@ohox:~/meridian/pool-memory.json \
               "./"
   ```
2. Run `bash scripts/backup-state.sh <label>`
3. Create a git tag for the current baseline
4. Rebase, then immediately run `node scripts/verify-patches.js`
5. Push, then `ssh ohox mp`

## Non-Negotiable Security Constraints
- Keep Telegram OPERATOR COMMAND wrapping in [index.js](/Users/user/Trading%20Project%20Files/DLMM/meridian-experimental/index.js).
- Keep model-routing keys absent from `CONFIG_MAP` in [tools/executor.js](/Users/user/Trading%20Project%20Files/DLMM/meridian-experimental/tools/executor.js).
- Do not treat `user-config.json` as a safe place for secrets unless the operator explicitly accepts that tradeoff.

## Important Notes
- `studyTopLPers()` uses `process.env.PUBLIC_API_KEY` in `tools/study.js`.
- LPAgent portfolio enrichment uses `process.env.LPAGENT_API_KEY` in `tools/dlmm.js`.
- HiveMind config is supported through `hiveMindUrl` / `hiveMindApiKey` in `config.js`.
- `minVolumeToRebalance` is currently exposed in config but does not yet drive active management behavior.
- **GMGN** (`LPAGENT_API_KEY` in `.env` on VPS) — live via `tools/gmgn.js`. Note: env var is named `LPAGENT_API_KEY`, not `GMGN_API_KEY`.
- **InsightX** (`INSIGHTX_API_KEY` in `.env` on VPS) — NOT YET WIRED (Phase 2).
- **State files live on VPS only** (`~/meridian/`). They are gitignored. Rsync them back before rebase.

## Next High-Value Work
1. **Monitor Darwin convergence** on new GMGN signals (`gmgn_bluechip_present`, `gmgn_bundler_present`) — needs 10+ closes each before tuning.
2. **InsightX Phase 2**: Add `tools/insightx.js` for BubbleMaps-style cluster concentration on shortlisted candidates. Key: `INSIGHTX_API_KEY` is already in `.env` on VPS.
3. **`getPoolInfo()` tool** from fciaf420/meridian fork — adds token audit depth, organic buy ratio, dev balance %, fee trend history.
4. **Smart wallet ranking/pruning** pass — 30 wallets in `smart-wallets.json`, no ranking yet.
5. Add full screening snapshot logging for all candidates (reduces survivorship bias in autoresearch).
6. **`sol_dca_accumulator` strategy**: Add to `strategy-library.json` as a `bid_ask`-type entry with `bins_below: 62`, `bins_above: 0`, SOL-only deploy side. This is the correct accumulation strategy for entry during memecoin drawdowns (distinct from `single_sided_reseed` which is an EXIT strategy).

## Strategy Library — Key Architecture Note
The strategy library (`strategy-library.json`) takes **full precedence** over `user-config.json`'s `strategy` field. `index.js` calls `getActiveStrategy()` and injects the active library entry into the screener system prompt. The LLM sees `ACTIVE STRATEGY: <name> — LP: <type>` and uses that strategy name/type in every `deploy_position` call. Changing `strategy` in `user-config.json` has **no effect** while a library strategy is active.

To change the deploy strategy:
- Use Telegram `/set active <strategy_name>` or directly edit `strategy-library.json` `active` field on VPS, then `mr` to reload.
- Or add a new library entry and set it as active.

Key strategy types and their direction:
| Library name | lp_strategy | Direction | Notes |
|---|---|---|---|
| `custom_ratio_spot` | spot | neutral | Default; balanced around current price |
| `single_sided_reseed` | bid_ask | EXIT (token→SOL) | bins_above high, bins_below low — reseeds into base token to exit |
| `sol_dca_accumulator` (proposed) | bid_ask | ENTRY (SOL→token) | bins_above=0 or low, bins_below=55-69 — accumulates token during drawdowns |

## Screening Enrichment Continuation Plan
### Phase 0 — already live
- `outOfRangeHardCloseMinutes` is implemented in code and currently set to `20` locally.
- Shortlisted candidates are hard-filtered if Jupiter audit reports `mint_disabled === false` or `freeze_disabled === false`.
- This Phase 0 work intentionally uses only data Meridian already fetches. No new providers were added.

### Phase 1 — GMGN shortlist enrichment
- Add `tools/gmgn.js`.
- Call GMGN only for the final 5-10 shortlisted candidates after [tools/screening.js](/Users/user/Trading%20Project%20Files/DLMM/meridian-experimental/tools/screening.js) returns candidates and before the screener LLM prompt is built in [index.js](/Users/user/Trading%20Project%20Files/DLMM/meridian-experimental/index.js).
- First GMGN priorities:
  - sniper share / launch sniping pressure
  - bluechip-holder presence
  - any audit-style safety flags that are genuinely additive versus Jupiter and OKX
- First recommended policy:
  - use bluechip presence as a soft confidence boost
  - use obviously excessive sniper share as a hard skip

### Phase 2 — InsightX cluster concentration
- Add `tools/insightx.js`.
- Call InsightX only on the same shortlisted candidates.
- Surface BubbleMaps-style linked-wallet concentration into the candidate object and filtered examples.
- First recommended policy:
  - hard-filter if the top linked cluster concentration is clearly excessive
  - start around a 35-40% cluster ceiling and tune only after live review

### Phase 3 — structured signals and Darwin wiring
- Promote stable shortlist-only enrichment into structured screening features and Darwin snapshots.
- Best first additions:
  - `bluechip_holders_present` as a boolean confidence signal
  - `sniper_pct` as a hard skip when clearly excessive
  - cluster concentration as a hard negative / filter reason
- Keep these as shortlist enrichments. Do not call GMGN or InsightX on the full 50+ discovery universe unless latency and rate-limit behavior are proven safe.
