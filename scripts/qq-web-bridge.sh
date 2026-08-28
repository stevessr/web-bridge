#!/usr/bin/env bash
set -euo pipefail

QQ_BIN="${QQ_BIN:-/opt/QQ/qq}"
CDP_HOST="${WEB_BRIDGE_CDP_HOST:-127.0.0.1}"
CDP_PORT="${WEB_BRIDGE_CDP_PORT:-9222}"
WEB_HOST="${WEB_BRIDGE_HOST:-127.0.0.1}"
WEB_PORT="${WEB_BRIDGE_PORT:-8080}"

if [[ ! -x "$QQ_BIN" ]]; then
  echo "[web-bridge] QQ binary not executable: $QQ_BIN" >&2
  echo "[web-bridge] set QQ_BIN=/path/to/qq if QQ NT is installed elsewhere" >&2
  exit 1
fi

if pgrep -f -- "$QQ_BIN" >/dev/null 2>&1; then
  cat >&2 <<EOF
[web-bridge] QQ NT appears to already be running.
[web-bridge] Fully exit QQ first so the new Electron process actually receives:
             --remote-debugging-address=$CDP_HOST --remote-debugging-port=$CDP_PORT
EOF
  exit 2
fi

export WEB_BRIDGE_CDP_HOST="$CDP_HOST"
export WEB_BRIDGE_CDP_PORT="$CDP_PORT"
export WEB_BRIDGE_HOST="$WEB_HOST"
export WEB_BRIDGE_PORT="$WEB_PORT"

cleanup() {
  if [[ -n "${QQ_PID:-}" ]] && kill -0 "$QQ_PID" >/dev/null 2>&1; then
    kill "$QQ_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

echo "[web-bridge] launching QQ NT with CDP on $CDP_HOST:$CDP_PORT"
"$QQ_BIN" \
  "--remote-debugging-address=$CDP_HOST" \
  "--remote-debugging-port=$CDP_PORT" \
  "$@" &
QQ_PID=$!

echo "[web-bridge] QQ PID: $QQ_PID"
echo "[web-bridge] browser endpoint: http://$WEB_HOST:$WEB_PORT"

node src/host.mjs
