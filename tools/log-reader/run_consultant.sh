#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Install deps quietly if missing
pip install -r requirements.txt --quiet --break-system-packages 2>/dev/null

# Source workflow for project context
source /Users/marcelyuwono/CascadeProjects/workflow-manager/scripts/workflow.sh 2>/dev/null

# Run
python3 dlmm_consultant.py "$@"
