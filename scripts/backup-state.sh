#!/usr/bin/env bash
# backup-state.sh
#
# Backs up all runtime-learned state files before a rebase or bot restart.
# Usage: bash scripts/backup-state.sh [label]
#
# State files backed up:
#   pool-memory.json     — 44 pools of deploy history, win rates, avg PnL
#   lessons.json         — derived lessons from closed positions
#   signal-weights.json  — Darwin signal weights (auto-tuned from outcomes)
#   smart-wallets.json   — KOL/alpha wallet tracker state
#   token-blacklist.json — permanent token blacklist

set -euo pipefail

BOTDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${1:-$(date +%Y%m%d-%H%M%S)}"
BACKUP_DIR="$BOTDIR/backups/$LABEL"

mkdir -p "$BACKUP_DIR"

STATE_FILES=(
  pool-memory.json
  lessons.json
  signal-weights.json
  smart-wallets.json
  token-blacklist.json
)

backed_up=0
for f in "${STATE_FILES[@]}"; do
  src="$BOTDIR/$f"
  if [ -f "$src" ]; then
    cp "$src" "$BACKUP_DIR/$f"
    echo "  ✅  $f"
    ((backed_up++))
  else
    echo "  ⚠️   $f — not found, skipping"
  fi
done

# Write a manifest
cat > "$BACKUP_DIR/MANIFEST.txt" <<EOF
Meridian state backup
Label:   $LABEL
Date:    $(date)
GitHEAD: $(git -C "$BOTDIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")
GitBranch: $(git -C "$BOTDIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
Files:   $backed_up backed up
EOF

echo ""
echo "✅  State backed up → backups/$LABEL  ($backed_up files)"
echo ""
