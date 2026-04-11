# meridian-experimental

## What This Repo Is
Live DLMM LP bot for Meteora on Solana. This checkout is the active `experimental` worktree used for real-money operation.

## Start Here
- Read [CHANGELOG.md](/Users/marcelyuwono/Trading%20Project%20Files/DLMM/.worktrees/meridian-experimental/CHANGELOG.md) first for release-by-release context.
- Review the current Darwin logic in [signal-weights.js](/Users/marcelyuwono/Trading%20Project%20Files/DLMM/.worktrees/meridian-experimental/signal-weights.js) and [tools/screening.js](/Users/marcelyuwono/Trading%20Project%20Files/DLMM/.worktrees/meridian-experimental/tools/screening.js).
- Review deploy/management flow in [index.js](/Users/marcelyuwono/Trading%20Project%20Files/DLMM/.worktrees/meridian-experimental/index.js), [signal-tracker.js](/Users/marcelyuwono/Trading%20Project%20Files/DLMM/.worktrees/meridian-experimental/signal-tracker.js), and [autoresearch.js](/Users/marcelyuwono/Trading%20Project%20Files/DLMM/.worktrees/meridian-experimental/autoresearch.js).
- HiveMind setup details live in [docs/hivemind-reference.md](/Users/marcelyuwono/Trading%20Project%20Files/DLMM/.worktrees/meridian-experimental/docs/hivemind-reference.md).

## Current Operational Context
- Current release context: `v1.0.4`
- `v1.0.3` added Darwin ranking plus shadow autoresearch.
- `v1.0.4` fixed the review-pass issues that mattered before restart:
  - sparse-data Darwin candidates no longer get a missing-data ranking advantage
  - manual `/screen` -> `/deploy` now preserves Darwin signal attribution
  - dead Darwin signals `study_win_rate` and `hive_consensus` were removed from active scoring/staging
  - shadow autoresearch trials now reach terminal history states instead of stalling in `activeTrials`
  - staged signal TTL increased from 10m to 30m
- Local management config currently uses `outOfRangeWaitMinutes: 15` and `outOfRangeHardCloseMinutes: 20`.
- Screening Phase 0 safety filter is live: Jupiter audit now hard-drops candidates whose mint authority or freeze authority is still enabled.

## Safety Protocol
- Before any restart:
  - run `node scripts/verify-patches.js`
  - if any check fails, do not restart
- Before any rebase:
  - run `bash scripts/backup-state.sh <label>`
  - create a tag first for the current baseline

## Non-Negotiable Security Constraints
- Keep Telegram OPERATOR COMMAND wrapping in [index.js](/Users/marcelyuwono/Trading%20Project%20Files/DLMM/.worktrees/meridian-experimental/index.js).
- Keep model-routing keys absent from `CONFIG_MAP` in [tools/executor.js](/Users/marcelyuwono/Trading%20Project%20Files/DLMM/.worktrees/meridian-experimental/tools/executor.js).
- Do not treat `user-config.json` as a safe place for secrets unless the operator explicitly accepts that tradeoff.

## Important Notes
- `studyTopLPers()` uses `process.env.PUBLIC_API_KEY` in [tools/study.js](/Users/marcelyuwono/Trading%20Project%20Files/DLMM/.worktrees/meridian-experimental/tools/study.js).
- LPAgent portfolio enrichment uses `process.env.LPAGENT_API_KEY` in [tools/dlmm.js](/Users/marcelyuwono/Trading%20Project%20Files/DLMM/.worktrees/meridian-experimental/tools/dlmm.js).
- HiveMind config is supported through `hiveMindUrl` / `hiveMindApiKey` in [config.js](/Users/marcelyuwono/Trading%20Project%20Files/DLMM/.worktrees/meridian-experimental/config.js).
- `minVolumeToRebalance` is currently exposed in config but does not yet drive active management behavior.
- `GMGN` and `InsightX` API keys may exist in `.env`, but no live screening code reads them yet.

## Next High-Value Work
1. Validate the first post-restart closes with non-null `signal_snapshot` and verify `study_top_lpers` data appears in the screener's reasoning log.
2. Keep `getPoolInfo()` on the roadmap, but do not mix it with the new shortlist enrichment work unless the write scope stays clean.
3. Add full screening snapshot logging for all candidates, not just deployed survivors.
4. Revisit winner-baseline attribution once the post-restart snapshot pipeline is proven live.

## Screening Enrichment Continuation Plan
### Phase 0 — already live
- `outOfRangeHardCloseMinutes` is implemented in code and currently set to `20` locally.
- Shortlisted candidates are hard-filtered if Jupiter audit reports `mint_disabled === false` or `freeze_disabled === false`.
- This Phase 0 work intentionally uses only data Meridian already fetches. No new providers were added.

### Phase 1 — GMGN shortlist enrichment
- Add `tools/gmgn.js`.
- Call GMGN only for the final 5-10 shortlisted candidates after [tools/screening.js](/Users/marcelyuwono/Trading%20Project%20Files/DLMM/.worktrees/meridian-experimental/tools/screening.js) returns candidates and before the screener LLM prompt is built in [index.js](/Users/marcelyuwono/Trading%20Project%20Files/DLMM/.worktrees/meridian-experimental/index.js).
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
