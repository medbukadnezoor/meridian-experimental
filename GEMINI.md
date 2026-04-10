# Gemini CLI context — meridian-experimental
# This file is auto-synced from AGENTS.md via project-sync.
# To update: edit AGENTS.md, then run project-sync.

# meridian-experimental

## LLM Log Reader (added 2026-04-06)
Tools live at: tools/log-reader/
- dlmm_log_reader.py — query dashscope/openrouter/sls logs
- dlmm_consultant.py — interactive DLMM codebase + log consultant
- run_consultant.sh — launcher with auto dep install

To start consultant session:
bash tools/log-reader/run_consultant.sh

To check last 24h log summary:
python3 tools/log-reader/dlmm_log_reader.py --source all --last 24 --summary
