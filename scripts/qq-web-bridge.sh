#!/usr/bin/env bash
set -euo pipefail

CDP_HOST="${WEB_BRIDGE_CDP_HOST:-127.0.0.1}"
WEB_HOST="${WEB_BRIDGE_HOST:-127.0.0.1}"
WEB_PORT="${WEB_BRIDGE_PORT:-8080}"
# QQ 3.2.33-52892 accepts neither the Node inspector nor a usable Chromium
# remote-debugging endpoint. The shadow main-entry shim therefore exposes a
# private Electron webContents transport. Runtime evaluation/input are handled
# with executeJavaScript/sendInputEvent instead of debugger.sendCommand().
MAIN_SHIM_MODE="${WEB_BRIDGE_QQ_MAIN_SHIM:-auto}"
# Kept only as an explicit diagnostic path for Electron builds whose
# nodeCliInspect fuse is enabled.
CDP_BOOTSTRAP="${WEB_BRIDGE_QQ_CDP_BOOTSTRAP:-0}"

case "$CDP_HOST" in
  127.0.0.1|localhost|::1) ;;
  *)
    if [[ "${WEB_BRIDGE_ALLOW_REMOTE_CDP:-0}" != "1" ]]; then
      echo "[web-bridge] refusing non-loopback bridge host: $CDP_HOST" >&2
      echo "[web-bridge] the Electron bridge transport is privileged; keep it on loopback." >&2
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

if [[ -z "${WEB_BRIDGE_QQ_SHIM_TOKEN:-}" ]]; then
  WEB_BRIDGE_QQ_SHIM_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")"
fi
export WEB_BRIDGE_QQ_SHIM_TOKEN

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
[web-bridge] Fully exit QQ first. A fresh process must receive the bridge setup.
EOF2
  exit 2
fi

export QQ_BIN
export WEB_BRIDGE_CDP_HOST="$CDP_HOST"
export WEB_BRIDGE_CDP_PORT="$CDP_PORT"
export WEB_BRIDGE_HOST="$WEB_HOST"
export WEB_BRIDGE_PORT="$WEB_PORT"

cleanup() {
  if [[ -n "${DIAG_PID:-}" ]] && kill -0 "$DIAG_PID" >/dev/null 2>&1; then kill "$DIAG_PID" >/dev/null 2>&1 || true; fi
  if [[ -n "${BRIDGE_PID:-}" ]] && kill -0 "$BRIDGE_PID" >/dev/null 2>&1; then kill "$BRIDGE_PID" >/dev/null 2>&1 || true; fi
  if [[ -n "${QQ_PID:-}" ]] && kill -0 "$QQ_PID" >/dev/null 2>&1; then kill "$QQ_PID" >/dev/null 2>&1 || true; fi
  if [[ -n "${SHIM_DIR:-}" ]]; then rm -rf "$SHIM_DIR" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT INT TERM

launch_qq_direct() {
  "$QQ_BIN" \
    "--remote-debugging-address=$CDP_HOST" \
    "--remote-debugging-port=$CDP_PORT" \
    "$@" &
  QQ_PID=$!
}

USE_MAIN_SHIM=0
SHIM_DIR=""
SHADOW_QQ_BIN=""
QQ_APP_PACKAGE="$(dirname "$QQ_BIN")/resources/app/package.json"

main_shim_forced() {
  case "$MAIN_SHIM_MODE" in
    1|true|yes|on|force) return 0 ;;
    *) return 1 ;;
  esac
}

main_shim_disabled() {
  case "$MAIN_SHIM_MODE" in
    0|false|no|off|disable|disabled) return 0 ;;
    *) return 1 ;;
  esac
}

prepare_main_shim() {
  if main_shim_disabled; then
    echo "[web-bridge] QQ main-entry Electron shim disabled by WEB_BRIDGE_QQ_MAIN_SHIM=$MAIN_SHIM_MODE"
    return 1
  fi
  if [[ ! -f "$QQ_APP_PACKAGE" ]]; then
    if main_shim_forced; then
      echo "[web-bridge] forced QQ main shim cannot find package.json: $QQ_APP_PACKAGE" >&2
      exit 4
    fi
    return 1
  fi

  local shim_base
  if [[ -n "${XDG_CACHE_HOME:-}" ]]; then
    shim_base="$XDG_CACHE_HOME/web-bridge"
  elif [[ -n "${HOME:-}" ]]; then
    shim_base="$HOME/.cache/web-bridge"
  else
    shim_base="${TMPDIR:-/tmp}/web-bridge"
  fi
  mkdir -p "$shim_base"
  chmod 700 "$shim_base" 2>/dev/null || true
  SHIM_DIR="$(mktemp -d "$shim_base/qq-shadow.XXXXXX")"
  SHADOW_QQ_BIN="$SHIM_DIR/$(basename "$QQ_BIN")"

  if ! node src/qq-main-shim.mjs --qq-bin "$QQ_BIN" --output "$SHIM_DIR" >/dev/null; then
    rm -rf "$SHIM_DIR" >/dev/null 2>&1 || true
    SHIM_DIR=""
    SHADOW_QQ_BIN=""
    if main_shim_forced; then exit 4; fi
    echo "[web-bridge] could not prepare QQ shadow distribution; falling back to executable CDP flags only" >&2
    return 1
  fi
  if [[ ! -x "$SHADOW_QQ_BIN" ]]; then
    echo "[web-bridge] QQ shadow executable was not created: $SHADOW_QQ_BIN" >&2
    rm -rf "$SHIM_DIR" >/dev/null 2>&1 || true
    SHIM_DIR=""
    SHADOW_QQ_BIN=""
    if main_shim_forced; then exit 4; fi
    return 1
  fi

  USE_MAIN_SHIM=1
  echo "[web-bridge] prepared temporary QQ shadow distribution (installed /opt/QQ is untouched)"
  echo "[web-bridge] shadow executable: $SHADOW_QQ_BIN"
  echo "[web-bridge] using Electron hybrid transport; QQ DevTools Runtime is not required"
  echo "[web-bridge] Chromium sandbox remains enabled; no bubblewrap/user namespace is used"
  return 0
}

launch_qq_main_shim() {
  # The main shim owns CDP_PORT as a private line-delimited Electron proxy.
  # Do not pass --remote-debugging-port here: Tencent's Electron build ignores it.
  "$SHADOW_QQ_BIN" "$@" &
  QQ_PID=$!
}

launch_qq_best() {
  if [[ "$USE_MAIN_SHIM" == "1" ]]; then
    launch_qq_main_shim "$@"
  else
    launch_qq_direct "$@"
  fi
}

echo "[web-bridge] QQ executable ($QQ_DETECT_SOURCE): $QQ_BIN"
if [[ "$QQ_BIN" == /opt/QQ/qq || "$QQ_BIN" == /opt/qq/qq ]]; then
  echo "[web-bridge] using direct packaged Electron host"
elif [[ "$QQ_BIN" == */linuxqq ]]; then
  echo "[web-bridge] warning: selected a linuxqq launcher/wrapper; prefer QQ_BIN=/opt/QQ/qq" >&2
fi
echo "[web-bridge] private bridge endpoint: $CDP_HOST:$CDP_PORT"

# Bring the browser endpoint up before QQ finishes booting. listTargets supports
# ordinary Chromium CDP and the main-shim Electron transport.
node src/host.mjs &
BRIDGE_PID=$!
echo "[web-bridge] browser endpoint: http://$WEB_HOST:$WEB_PORT"

prepare_main_shim || true

# Experimental inspector path only. Known-current Linux QQ rejects --inspect-brk
# because its Electron nodeCliInspect fuse is disabled. If explicitly enabled,
# fall back to the shadow Electron bridge rather than to argv-only launch.
if [[ "$CDP_BOOTSTRAP" != "0" && "$CDP_BOOTSTRAP" != "false" && "$CDP_BOOTSTRAP" != "off" ]]; then
  INSPECTOR_HOST="127.0.0.1"
  INSPECTOR_PORT="$(free_loopback_port)"
  echo "[web-bridge] experimental Electron inspector bootstrap enabled: $INSPECTOR_HOST:$INSPECTOR_PORT"
  launch_qq_direct "--inspect-brk=$INSPECTOR_HOST:$INSPECTOR_PORT" "$@"
  echo "[web-bridge] QQ PID: $QQ_PID"

  if ! node src/electron-cdp-bootstrap.mjs \
    --inspector-host "$INSPECTOR_HOST" \
    --inspector-port "$INSPECTOR_PORT" \
    --cdp-host "$CDP_HOST" \
    --cdp-port "$CDP_PORT" \
    --timeout "${WEB_BRIDGE_QQ_BOOTSTRAP_TIMEOUT_MS:-15000}"; then
    echo "[web-bridge] inspector bootstrap unavailable; restarting QQ with shadow Electron/argv fallback" >&2
    kill "$QQ_PID" >/dev/null 2>&1 || true
    wait "$QQ_PID" 2>/dev/null || true
    QQ_PID=""
    sleep 0.2
    launch_qq_best "$@"
    echo "[web-bridge] QQ PID (fallback): $QQ_PID"
  fi
else
  launch_qq_best "$@"
  echo "[web-bridge] QQ PID: $QQ_PID"
fi

# Emit one actionable diagnostic early instead of waiting a full attach timeout.
(
  sleep "${WEB_BRIDGE_CDP_DIAG_DELAY_SEC:-12}"
  if [[ "$USE_MAIN_SHIM" == "1" ]]; then
    if ! node --input-type=module - "$CDP_HOST" "$CDP_PORT" <<'NODE' >/dev/null 2>&1
import { listShimTargets } from './src/cdp.mjs';
const [, , host, port] = process.argv;
try {
  await listShimTargets(host, Number(port), 1500);
  process.exit(0);
} catch {
  process.exit(1);
}
NODE
    then
      echo "[web-bridge] QQ Electron hybrid bridge is still unreachable; look above for 'QQ Electron hybrid bridge listening'" >&2
    fi
  else
    if ! node - "$CDP_HOST" "$CDP_PORT" <<'NODE' >/dev/null 2>&1
const [, , host, port] = process.argv;
try {
  const response = await fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
    then
      echo "[web-bridge] Chromium CDP is still unreachable after startup; main-entry shim was not active (set WEB_BRIDGE_QQ_MAIN_SHIM=1 for a hard failure)" >&2
    fi
  fi
) &
DIAG_PID=$!

set +e
wait -n "$QQ_PID" "$BRIDGE_PID"
STATUS=$?
set -e
cleanup
wait "$QQ_PID" 2>/dev/null || true
wait "$BRIDGE_PID" 2>/dev/null || true
exit "$STATUS"