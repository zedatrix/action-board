#!/usr/bin/env bash
# Removes the exact "127.0.0.1 <host>" line that add-host.sh added to /etc/hosts.
# The name is ACTION_BOARD_HOST (shell, then app/.env.local), default board.localhost. Needs your password once (sudo).
set -euo pipefail
cd "$(dirname "$0")"
host="${ACTION_BOARD_HOST:-$(grep -E '^ACTION_BOARD_HOST=' app/.env.local 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '[:space:]' || true)}"
host="${host:-board.localhost}"
pattern="/^127\.0\.0\.1[[:space:]]\{1,\}${host//./\\.}\$/d"
if [ "$(uname)" = "Darwin" ]; then
  sudo sed -i '' "$pattern" /etc/hosts
  sudo dscacheutil -flushcache
  sudo killall -HUP mDNSResponder
else
  sudo sed -i "$pattern" /etc/hosts
fi
echo "Done. $host is no longer in /etc/hosts."
