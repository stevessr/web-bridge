#!/usr/bin/env bash
set -euo pipefail

CDP_HOST="${WEB_BRIDGE_CDP_HOST:-127.0.0.1}"
WEB_HOST="${WEB_BRIDGE_HOST:-127.0.0.1}"
WEB_PORT="${WEB_BRIDGE_PORT:-8080}"

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

if [[ -n "${WEB_BRIDGE_CDP_PORT:-}" ]]; then
  CDP_PORT="$WEB_BRIDGE_CDP_PORT"
else
  CDP_PORT="$(node - <<'NODE'
const net = require('node:net');
const server = net.createServer();
server.unref();
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(String(server.address().port));
  server.close();
});
NODE
)"
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

echo "[web-bridge] QQ executable ($QQ_DETECT_SOURCE): $QQ_BIN"
echo "[web-bridge] private CDP endpoint: $CDP_HOST:$CDP_PORT"
"$QQ_BIN" \
  "--remote-debugging-address=$CDP_HOST" \
  "--remote-debugging-port=$CDP_PORT" \
  "$@" &
QQ_PID=$!

echo "[web-bridge] QQ PID: $QQ_PID"
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
