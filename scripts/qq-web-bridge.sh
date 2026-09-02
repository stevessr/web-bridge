#!/usr/bin/env bash
set -euo pipefail

CDP_HOST="${WEB_BRIDGE_CDP_HOST:-127.0.0.1}"
WEB_HOST="${WEB_BRIDGE_HOST:-127.0.0.1}"
WEB_PORT="${WEB_BRIDGE_PORT:-8080}"
CDP_BOOTSTRAP="${WEB_BRIDGE_QQ_CDP_BOOTSTRAP:-1}"

case "$CDP_HOST" in
  127.0.0.1|localhost|::1) ;;
  *)
    if [[ "${WEB_BRIDGE_ALLOW_REMOTE_CDP:-0}" != "1" ]]; then
      echo "[web-bridge] refusing non-loopback CDP host: $CDP_HOST" >&2
      echo "[web-bridge] CDP is privileged; keep it on loopback." >&2
      exit 3
    fi
    ;;
esac

free_loopback_port() {
  node - <<'NODE'
const net = require('node:net');
const server = net.createServer();
server.unref();
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(String(server.address().port));
  server.close();
});
NODE
}

if [[ -n "${WEB_BRIDGE_CDP_PORT:-}" ]]; then
  CDP_PORT="$WEB_BRIDGE_CDP_PORT"
else
  CDP_PORT="$(free_loopback_port)"
fi

if [[ -n "${QQ_BIN:-}" ]]; then
  QQ_DETECT_SOURCE="env:QQ_BIN"
else
  QQ_DETECT_SOURCE="auto"
  echo "[web-bridge] auto-detecting QQ NT executable..." >&2
fi

if ! QQ_BIN="$(node src/qq-detect.mjs --print-path)"; then
  cat >&2 <<'ERR'
[web-bridge] QQ NT discovery failed.
[web-bridge] Inspect candidates with: pnpm detect:qq
[web-bridge] Or override with: QQ_BIN=/path/to/qq pnpm dev:qq
ERR
  exit 1
fi

find_running_pid() {
  local wanted="$1" proc exe
  if [[ -d /proc ]]; then
    for proc in /proc/[0-9]*; do
      [[ -e "$proc/exe" ]] || continue
      exe="$(readlink -f "$proc/exe" 2>/dev/null || true)"
      if [[ -n "$exe" && "$exe" == "$wanted" ]]; then basename "$proc"; return 0; fi
    done
  fi
  pgrep -f -- "$wanted" 2>/dev/null | head -n1 || true
}

RUNNING_PID="$(find_running_pid "$QQ_BIN")"
if [[ -n "$RUNNING_PID" ]]; then
  cat >&2 <<EOF2
[web-bridge] QQ NT is already running (PID $RUNNING_PID).
[web-bridge] detected executable: $QQ_BIN
[web-bridge] Fully exit QQ first. A fresh process must receive the private CDP flags.
EOF2
  exit 2
fi

export QQ_BIN
export WEB_BRIDGE_CDP_HOST="$CDP_HOST"
export WEB_BRIDGE_CDP_PORT="$CDP_PORT"
export WEB_BRIDGE_HOST="$WEB_HOST"
export WEB_BRIDGE_PORT="$WEB_PORT"

cleanup() {
  if [[ -n "${BRIDGE_PID:-}" ]] && kill -0 "$BRIDGE_PID" >/dev/null 2>&1; then kill "$BRIDGE_PID" >/dev/null 2>&1 || true; fi
  if [[ -n "${QQ_PID:-}" ]] && kill -0 "$QQ_PID" >/dev/null 2>&1; then kill "$QQ_PID" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT INT TERM

launch_qq() {
  "$QQ_BIN" \
    "--remote-debugging-address=$CDP_HOST" \
    "--remote-debugging-port=$CDP_PORT" \
    "$@" &
  QQ_PID=$!
}

echo "[web-bridge] QQ executable ($QQ_DETECT_SOURCE): $QQ_BIN"
echo "[web-bridge] private CDP endpoint: $CDP_HOST:$CDP_PORT"

# Recent QQ NT builds can accept ordinary Chromium switches while still failing
# to bring up the renderer DevTools HTTP endpoint from --remote-debugging-port.
# Electron officially supports setting this switch through app.commandLine before
# the ready event. Use a short-lived, random loopback Node inspector to do exactly
# that before QQ's main script starts, then close the inspector after resuming.
if [[ "$CDP_BOOTSTRAP" != "0" && "$CDP_BOOTSTRAP" != "false" && "$CDP_BOOTSTRAP" != "off" ]]; then
  INSPECTOR_HOST="127.0.0.1"
  INSPECTOR_PORT="$(free_loopback_port)"
  echo "[web-bridge] bootstrapping QQ CDP through temporary Electron inspector: $INSPECTOR_HOST:$INSPECTOR_PORT"
  launch_qq "--inspect-brk=$INSPECTOR_HOST:$INSPECTOR_PORT" "$@"
  echo "[web-bridge] QQ PID: $QQ_PID"

  if ! node src/electron-cdp-bootstrap.mjs \
    --inspector-host "$INSPECTOR_HOST" \
    --inspector-port "$INSPECTOR_PORT" \
    --cdp-host "$CDP_HOST" \
    --cdp-port "$CDP_PORT" \
    --timeout "${WEB_BRIDGE_QQ_BOOTSTRAP_TIMEOUT_MS:-15000}"; then
    echo "[web-bridge] inspector bootstrap unavailable; restarting QQ with normal CDP flags" >&2
    kill "$QQ_PID" >/dev/null 2>&1 || true
    wait "$QQ_PID" 2>/dev/null || true
    QQ_PID=""
    sleep 0.2
    launch_qq "$@"
    echo "[web-bridge] QQ PID (fallback): $QQ_PID"
  fi
else
  launch_qq "$@"
  echo "[web-bridge] QQ PID: $QQ_PID"
fi

echo "[web-bridge] browser endpoint: http://$WEB_HOST:$WEB_PORT"

node src/host.mjs &
BRIDGE_PID=$!
set +e
wait -n "$QQ_PID" "$BRIDGE_PID"
STATUS=$?
set -e
cleanup
wait "$QQ_PID" 2>/dev/null || true
wait "$BRIDGE_PID" 2>/dev/null || true
exit "$STATUS"
