# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim

ARG TARGETARCH
ARG QQ_DEB_URL=""
ARG QQ_LINUX_CONFIG_URL="https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js"

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/home/webbridge \
    QQ_BIN=/opt/QQ/qq \
    WEB_BRIDGE_QQ_MAIN_SHIM=1 \
    WEB_BRIDGE_HOST=0.0.0.0 \
    WEB_BRIDGE_PORT=8080 \
    WEB_BRIDGE_CDP_HOST=127.0.0.1 \
    WEB_BRIDGE_SHIM_POLL_MS=1000 \
    XDG_RUNTIME_DIR=/tmp/web-bridge-runtime

COPY deploy/download-linuxqq.sh /usr/local/bin/download-linuxqq

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      dbus-x11 \
      dumb-init \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
      xauth \
      xvfb \
 && chmod +x /usr/local/bin/download-linuxqq \
 && QQ_DEB_URL="$QQ_DEB_URL" QQ_LINUX_CONFIG_URL="$QQ_LINUX_CONFIG_URL" \
      /usr/local/bin/download-linuxqq "$TARGETARCH" /tmp/linuxqq.deb >/tmp/linuxqq-url \
 && apt-get install -y --no-install-recommends /tmp/linuxqq.deb \
 && rm -f /tmp/linuxqq.deb \
 && if [ -e /opt/QQ/chrome-sandbox ]; then chown root:root /opt/QQ/chrome-sandbox && chmod 4755 /opt/QQ/chrome-sandbox; fi \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --uid 10001 --create-home --shell /bin/bash webbridge \
 && mkdir -p /app /home/webbridge/.config/QQ /home/webbridge/.cache /home/webbridge/.local/share /tmp/web-bridge-runtime \
 && chown -R webbridge:webbridge /app /home/webbridge /tmp/web-bridge-runtime

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chown=webbridge:webbridge . .
RUN chmod +x scripts/qq-web-bridge.sh deploy/docker-entrypoint.sh deploy/download-linuxqq.sh

USER webbridge
VOLUME ["/home/webbridge/.config/QQ"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/app/deploy/docker-entrypoint.sh"]
CMD ["bash", "scripts/qq-web-bridge.sh", "--disable-gpu"]
