#!/usr/bin/env bash
set -euo pipefail

CDP_HOST="${WEB_BRIDGE_CDP_HOST:-127.0.0.1}"
CDP_PORT="${WEB_BRIDGE_CDP_PORT:-9222}"
WEB_HOST="${WEB_BRIDGE_HOST:-127.0.0.1}"
WEB_PORT="${WEB_BRIDGE_PORT:-8080}"

if [[ -n "${QQ_BIN:-}" ]]; then
  QQ_DETECT_SOURCE="env:QQ_BIN"
else
  QQ_DETECT_SOURCE="auto"
  echo "[web-bridge] auto-detecting QQ NT executable..." >&2
fi

if ! QQ_BIN="$(node src/qq-detect.mjs --print-path)"; then
  cat >&2 <<'ERR'
[web-bridge] QQ NT discovery failed.
[web-bridge] You can inspect discovery candidates with:
             node src/qq-detect.mjs --all
[web-bridge] Or override discovery with:
             QQ_BIN=/path/to/qq pnpm dev:qq
ERR
  exit 1
fi

find_running_pid() {
  local wanted="$1"
  local proc exe
  if [[ -d /proc ]]; then
    for proc in /proc/[0-9]*; do
      [[ -e "$proc/exe" ]] || continue
      exe="$(readlink -f "$proc/exe" 2>/dev/null || true)"
      if [[ -n "$exe" && "$exe" == "$wanted" ]]; then
        basename "$proc"
        return 0
      fi
    done
  fi
  pgrep -f -- "$wanted" 2>/dev/null | head -n1 || true
}

RUNNING_PID="$(find_running_pid "$QQ_BIN")"
if [[ -n "$RUNNING_PID" ]]; then
  cat >&2 <<EOF
[web-bridge] QQ NT is already running (PID $RUNNING_PID).
[web-bridge] detected executable: $QQ_BIN
[web-bridge] Fully exit QQ first so a fresh Electron process receives:
             --remote-debugging-address=$CDP_HOST --remote-debugging-port=$CDP_PORT
EOF
  exit 2
fi

export QQ_BIN
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

echo "[web-bridge] QQ executable ($QQ_DETECT_SOURCE): $QQ_BIN"
echo "[web-bridge] launching QQ NT with CDP on $CDP_HOST:$CDP_PORT"
"$QQ_BIN" \
  "--remote-debugging-address=$CDP_HOST" \
  "--remote-debugging-port=$CDP_PORT" \
  "$@" &
QQ_PID=$!

echo "[web-bridge] QQ PID: $QQ_PID"
echo "[web-bridge] browser endpoint: http://$WEB_HOST:$WEB_PORT"

node src/host.mjs
