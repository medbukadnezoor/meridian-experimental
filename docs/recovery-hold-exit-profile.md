# Recovery-Hold Exit Profile

Updated: 2026-06-20

## Intent

Main Meridian now runs a recovery-hold profile for high-volume tokens where normal drawdowns around 20% are tolerated. The bot should keep positions open through negative recovery periods and only close loss-side exposure at the catastrophic hard stop.

The profile preserves positive exits:

- take profit
- trailing take profit while non-negative
- fee harvest
- fee max-hold harvest
- non-fee housekeeping exits only after a positive PnL buffer

## Live Profile

The live Main deployment on `ohox:~/meridian` was updated and restarted on 2026-06-20.

Key live config after deploy:

```json
{
  "recoveryHoldProfileEnabled": true,
  "recoveryHoldNonFeeExitMinNetPnlPct": 0.25,
  "requirePositivePnlForOutOfRangeExit": true,
  "requirePositivePnlForLowYieldExit": true,
  "requirePositivePnlForMaxHoldExit": true,
  "hardStopLossPct": -25,
  "stopLossPct": null,
  "rollingDrawdownExitEnabled": false,
  "supertrendLossExitEnabled": false,
  "activeBinVelocityEmergencyLiveEnabled": false
}
```

Fee harvest remains independently gated:

```json
{
  "feeHarvestMinHoldMinutes": 8,
  "feeHarvestMinFeePctOfEntry": 0.75,
  "feeHarvestMinNetPnlPct": 0.25,
  "recoveryHoldPositiveOnly": true
}
```

## Exit Semantics

| Exit path | Recovery-hold behavior |
| --- | --- |
| Hard stop loss | Catastrophic only at or below `-25%` |
| Ordinary stop loss | Disabled by `stopLossPct: null` |
| Fast / velocity stop loss | Disabled by config |
| Rolling drawdown | Disabled by config |
| Early dump | Disabled by config |
| Supertrend loss exit | Disabled by config |
| OOR close | Allowed only when net PnL is at least `+0.25%` |
| Low-yield close | Allowed only when net PnL is at least `+0.25%` |
| Legacy max-hold close | Allowed only when net PnL is at least `+0.25%` |
| Fee max-hold timeout | Allowed only when fee policy min PnL passes |
| Fee harvest | Allowed when fee policy min hold, fees, confluence, and PnL pass |
| Take profit | Unchanged positive exit |
| Active-bin velocity emergency | Disabled by config for this profile |

The `+0.25%` non-fee floor was added after live evidence showed near-breakeven low-yield exits could be allowed at displayed `0%` and settle slightly negative after close/swap execution.

## Active-Bin Label Fix

The active-bin oracle no longer labels extreme velocity rows as `shadow_only_velocity_candidate`. The neutral label is now `velocity_extreme_candidate`.

Live emergency behavior is explicit config:

```json
{
  "activeBinVelocityEmergencyLiveEnabled": false,
  "activeBinVelocityEmergencyMaxPnlPct": 2
}
```

This keeps the telemetry accurate while leaving velocity emergency close disabled for recovery-hold.

## Verification

Local and VPS checks passed before and after deploy:

```bash
node scripts/verify-recovery-hold-exit-profile.js
node scripts/verify-patches.js
```

Expected verifier result:

```text
PASS All 124 checks passed.
```

The focused recovery-hold verifier proves:

- no automated non-catastrophic close from `0%` down to `-24.9%`
- catastrophic close still fires below `-25%`
- OOR and low-yield hold at `+0.20%`
- OOR and low-yield may close at `+0.30%`
- fee harvest and fee max-hold positive exits remain enabled
- active-bin velocity live emergency remains disabled by config

## Deployment Evidence

VPS backup before the 2026-06-20 deploy:

```text
/home/ubuntu/meridian-main-backups/non-fee-exit-floor-20260620T052207Z
```

Post-restart PM2 state:

```text
meridian online, pid 3451567, restart count 67
meridian-main-sol-balance-tracker online
Scout processes stopped
```

Fresh logs showed LIVE startup, cron cycles, wallet initialization, RPC PnL poller alive, and active-bin recorder subscriptions.
