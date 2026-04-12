#!/bin/bash
# Polymarket Weather Bot — simulation runner
# Called by the macOS LaunchAgent every 30 minutes.
# Runs in paper mode (no real trades, no credentials required).

BOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$BOT_DIR/bot-log.txt"
NODE_BIN="/Users/brockmcguire/.nvm/versions/node/v20.20.0/bin/node"
NPXBIN="/Users/brockmcguire/.nvm/versions/node/v20.20.0/bin/npx"

cd "$BOT_DIR" || exit 1

echo "" >> "$LOG_FILE"
echo "=== $(date '+%Y-%m-%d %H:%M:%S') ===" >> "$LOG_FILE"

"$NPXBIN" ts-node src/index.ts --live >> "$LOG_FILE" 2>&1
echo "Exit code: $?" >> "$LOG_FILE"
