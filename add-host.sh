#!/usr/bin/env bash
# Optional. Maps the board's host name to 127.0.0.1 in /etc/hosts, for a browser or tool that does not
# resolve *.localhost on its own. The name is ACTION_BOARD_HOST (shell, then app/.env.local), default board.localhost.
# Needs your password once (sudo).
set -euo pipefail
cd "$(dirname "$0")"
host="${ACTION_BOARD_HOST:-$(grep -E '^ACTION_BOARD_HOST=' app/.env.local 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '[:space:]' || true)}"
host="${host:-board.localhost}"
if ! grep -qE "^127\.0\.0\.1[[:space:]]+${host//./\\.}\$" /etc/hosts; then
  echo "127.0.0.1 $host" | sudo tee -a /etc/hosts >/dev/null
fi
if [ "$(uname)" = "Darwin" ]; then
  sudo dscacheutil -flushcache
  sudo killall -HUP mDNSResponder
fi
echo "Done. $host now points to 127.0.0.1."
