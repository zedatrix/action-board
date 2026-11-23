#!/usr/bin/env bash
# One-command start: checks Node, installs app deps if needed, then serves the board on 127.0.0.1
# (default http://board.localhost:8085; ACTION_BOARD_HOST and ACTION_BOARD_PORT in app/.env.local change it).
# Opens a browser tab unless run as ./start.sh --no-open (use that for a background service).
set -euo pipefail
cd "$(dirname "$0")/app"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node 18 or newer (https://nodejs.org), then run ./start.sh again."
  exit 1
fi
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 18 ]; then
  echo "Node $(node -v) is too old. Install Node 18 or newer, then run ./start.sh again."
  exit 1
fi

# Settings and the webhook live in app/.env.local. Create it from the template once; never overwrite it.
if [ ! -f .env.local ]; then
  cp .env.example .env.local
  echo "Created app/.env.local. Fill in ACTION_BOARD_WEBHOOK_URL there so in-app answers reach your assistant."
fi

if [ ! -d node_modules ]; then
  echo "Installing app dependencies (first run only)..."
  npm ci
fi

if [ "${1:-}" != "--no-open" ]; then
  export AB_OPEN=1
fi
exec npx vite
