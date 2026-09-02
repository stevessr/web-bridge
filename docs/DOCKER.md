# Headless Docker deployment

The Docker image runs Linux QQ inside a private **Xvfb** display and a private D-Bus session. No physical desktop is required and remote input does not focus or raise windows on the Docker host.

The image downloads the current official Tencent Linux QQ `.deb` during build from Tencent's `linuxConfig.js`. `amd64` and `arm64` builds are supported. If Tencent changes the discovery format, pass an official package URL explicitly with `--build-arg QQ_DEB_URL=...`.

## Docker Compose

Generate a strong Web UI password/token first:

```bash
export WEB_BRIDGE_AUTH_TOKEN="$(openssl rand -hex 32)"
docker compose build
docker compose up -d
```

By default Compose publishes only on `127.0.0.1:8080`. Put Caddy/Nginx in front of it for remote access. To intentionally publish directly on all interfaces:

```bash
export WEB_BRIDGE_PUBLISH_ADDR=0.0.0.0
export WEB_BRIDGE_AUTH_TOKEN="$(openssl rand -hex 32)"
docker compose up -d
```

The browser uses HTTP Basic authentication; any username can be used and `WEB_BRIDGE_AUTH_TOKEN` is the password.

## Persistent QQ data

Compose creates the named volume `qq-data` and mounts it at:

```text
/home/webbridge/.config/QQ
```

This keeps the QQ login/session, account database and normal QQ configuration across container replacement/rebuilds. Do not delete the volume if you want to keep the logged-in session.

Inspect it with:

```bash
docker volume ls
docker compose down              # keeps qq-data
docker compose down -v           # DELETES qq-data and QQ login state
```

For a host-directory data disk instead of a named volume, replace the Compose volume with:

```yaml
volumes:
  - /srv/web-bridge/qq:/home/webbridge/.config/QQ
```

The container runs as UID/GID `10001`, so prepare a bind-mounted directory with:

```bash
sudo mkdir -p /srv/web-bridge/qq
sudo chown -R 10001:10001 /srv/web-bridge/qq
```

Back up that directory/volume like any other application state. It contains private QQ account data.

## First login

Open the Web Bridge after the container becomes ready. The QQ login/QR-code renderer is mirrored into the browser, so the container does not need VNC or a real desktop. Once QQ persists a session under `.config/QQ`, normal restarts should reuse it.

Useful checks:

```bash
docker compose logs -f web-bridge
curl http://127.0.0.1:8080/healthz
curl http://127.0.0.1:8080/readyz
```

`/healthz` means the bridge process is alive. `/readyz` becomes ready after the QQ renderer has attached.

## Build controls

Use the latest package discovered from Tencent:

```bash
docker build -t web-bridge .
```

Pin/override an official Tencent `.deb` URL when reproducibility is required:

```bash
docker build \
  --build-arg QQ_DEB_URL='https://dldir1.qq.com/.../QQ_..._amd64_....deb' \
  -t web-bridge .
```

For multi-architecture images, use BuildKit/buildx. Tencent publishes Linux QQ for both `amd64` and `arm64`; the downloader chooses the package matching Docker's `TARGETARCH`.

## Headless/runtime notes

- Xvfb is a virtual display only; nothing is shown on the physical Docker host.
- The bridge never adds `--no-sandbox`.
- The official QQ `chrome-sandbox` permissions are preserved during image build.
- Compose allocates 512 MiB `/dev/shm`, avoiding Electron/Chromium instability caused by Docker's small default shared-memory area.
- The container uses software rendering (`--disable-gpu`) by default for predictable headless operation.
- The private Electron bridge remains on `127.0.0.1` inside the container. Only the Web UI port should be published.

If you publish a prebuilt image containing Tencent QQ instead of building it locally, check Tencent's redistribution/licensing terms first.
