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

## Next High-Value Work
1. Validate the first post-restart closes with non-null `signal_snapshot`.
2. Implement `getPoolInfo()` and wire its organic/dev signals into screening.
3. Add full screening snapshot logging for all candidates, not just deployed survivors.
4. Revisit winner-baseline attribution once the post-restart snapshot pipeline is proven live.
