#!/usr/bin/env bash
set -euo pipefail

ARCH_INPUT="${1:-${TARGETARCH:-$(dpkg --print-architecture 2>/dev/null || uname -m)}}"
OUTPUT="${2:-/tmp/linuxqq.deb}"
CONFIG_URL="${QQ_LINUX_CONFIG_URL:-https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js}"

case "$ARCH_INPUT" in
  amd64|x86_64) ARCH=amd64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *)
    echo "[web-bridge] unsupported Linux QQ architecture: $ARCH_INPUT" >&2
    echo "[web-bridge] Docker image currently supports amd64 and arm64." >&2
    exit 2
    ;;
esac

URL="${QQ_DEB_URL:-}"
if [[ -z "$URL" ]]; then
  echo "[web-bridge] discovering latest official Linux QQ .deb for $ARCH" >&2
  CONFIG="$(curl -fsSL --retry 4 --retry-delay 2 --retry-all-errors "$CONFIG_URL")"
  # Tencent's config may escape URL slashes. Extract only official HTTPS .deb URLs
  # that contain the requested Debian architecture marker.
  URL="$(printf '%s' "$CONFIG" \
    | sed 's#\\/#/#g' \
    | grep -Eo "https://[^\"'[:space:]]*${ARCH}[^\"'[:space:]]*\.deb([?][^\"'[:space:]]*)?" \
    | head -n 1 || true)"
fi

if [[ -z "$URL" ]]; then
  echo "[web-bridge] could not discover an official Linux QQ .deb for $ARCH" >&2
  echo "[web-bridge] config source: $CONFIG_URL" >&2
  echo "[web-bridge] override with docker build --build-arg QQ_DEB_URL=https://.../QQ_..._${ARCH}_....deb ." >&2
  exit 3
fi

case "$URL" in
  https://*.qq.com/*|https://*.gtimg.com/*|https://*.cdn-go.cn/*|https://cdn-go.cn/*) ;;
  *)
    if [[ "${QQ_ALLOW_NONOFFICIAL_DOWNLOAD:-0}" != "1" ]]; then
      echo "[web-bridge] refusing non-Tencent QQ download URL: $URL" >&2
      echo "[web-bridge] set QQ_ALLOW_NONOFFICIAL_DOWNLOAD=1 only if you intentionally trust that source" >&2
      exit 4
    fi
    ;;
esac

echo "[web-bridge] downloading Linux QQ: $URL" >&2
mkdir -p "$(dirname "$OUTPUT")"
curl -fL --retry 5 --retry-delay 2 --retry-all-errors "$URL" -o "$OUTPUT"
dpkg-deb --info "$OUTPUT" >/dev/null
PACKAGE_ARCH="$(dpkg-deb -f "$OUTPUT" Architecture 2>/dev/null || true)"
if [[ -n "$PACKAGE_ARCH" && "$PACKAGE_ARCH" != "$ARCH" ]]; then
  echo "[web-bridge] downloaded package architecture $PACKAGE_ARCH does not match requested $ARCH" >&2
  exit 5
fi
printf '%s\n' "$URL"
