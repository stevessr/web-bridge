#!/usr/bin/env bash
set -euo pipefail

umask 077

: "${HOME:=/home/webbridge}"
: "${XDG_RUNTIME_DIR:=/tmp/web-bridge-runtime}"
: "${WEB_BRIDGE_XVFB_SCREEN:=1440x900x24}"

mkdir -p "$HOME/.config/QQ" "$HOME/.cache" "$HOME/.local/share" "$XDG_RUNTIME_DIR"
chmod 700 "$HOME" "$HOME/.config" "$HOME/.config/QQ" "$XDG_RUNTIME_DIR" 2>/dev/null || true

if [[ "${WEB_BRIDGE_HOST:-0.0.0.0}" != "127.0.0.1" && -z "${WEB_BRIDGE_AUTH_TOKEN:-}" && "${WEB_BRIDGE_ALLOW_INSECURE:-0}" != "1" ]]; then
  cat >&2 <<'EOF'
[web-bridge] Docker deployment exposes the Web UI outside the container.
[web-bridge] Set WEB_BRIDGE_AUTH_TOKEN before startup, for example:
[web-bridge]   export WEB_BRIDGE_AUTH_TOKEN="$(openssl rand -hex 32)"
EOF
  exit 64
fi

if [[ ! -x "${QQ_BIN:-/opt/QQ/qq}" ]]; then
  echo "[web-bridge] Linux QQ executable is missing: ${QQ_BIN:-/opt/QQ/qq}" >&2
  echo "[web-bridge] rebuild the image so the Dockerfile can download/install QQ" >&2
  exit 65
fi

# A private Xvfb + D-Bus session keeps QQ fully off the physical host display.
# No --no-sandbox flag is used. In the normal Docker deployment this process is
# already isolated from the host desktop, so remote control cannot steal host focus.
exec dbus-run-session -- xvfb-run \
  -a \
  -e /dev/stderr \
  -s "-screen 0 ${WEB_BRIDGE_XVFB_SCREEN} -nolisten tcp -noreset" \
  "$@"
