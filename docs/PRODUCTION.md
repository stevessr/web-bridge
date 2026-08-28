# Production deployment

## Security boundary

QQ NT and its original JavaScript, preload, IPC, credentials and native access remain on the host. The browser receives sanitized DOM/style/state data and opaque resource URLs. Client input is validated and reinjected through an allow-listed set of CDP operations.

**CDP is more privileged than the Web Bridge. Never expose the QQ debugging port to the network.** The launcher binds CDP to loopback and chooses a random port by default. The host refuses a non-loopback CDP address unless `WEB_BRIDGE_ALLOW_REMOTE_CDP=1` is explicitly set.

When the HTTP listener is non-loopback, startup is refused unless `WEB_BRIDGE_AUTH_TOKEN` is set (or the unsafe override is explicitly enabled). If a reverse proxy exposes a loopback listener, set the token anyway.

## Recommended topology

```text
Internet/LAN
    |
 HTTPS
    v
Caddy / Nginx
    |
127.0.0.1:8080  web-bridge
    |
127.0.0.1:<random>  CDP
    |
QQ NT
```

Caddy and Nginx both proxy WebSocket upgrades. `deploy/Caddyfile.example` is a minimal TLS example.

## Authentication

Generate a long random token with `openssl rand -base64 36` and set it as `WEB_BRIDGE_AUTH_TOKEN`. The browser flow uses HTTP Basic authentication: any username is accepted; the token is the password. Bearer authentication is also accepted for API clients.

## systemd user service

```bash
mkdir -p ~/.config/web-bridge
cp deploy/web-bridge.env.example ~/.config/web-bridge/env
$EDITOR ~/.config/web-bridge/env
mkdir -p ~/.config/systemd/user
cp deploy/web-bridge.service ~/.config/systemd/user/web-bridge.service
systemctl --user daemon-reload
systemctl --user enable --now web-bridge
```

If the user manager does not inherit the graphical session automatically:

```bash
systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS
```

The service uses `Restart=always`, so a QQ or bridge exit restarts the pair.

## Health and metrics

- `/healthz` — liveness; intentionally public and contains no QQ metadata.
- `/readyz` — 200 only while attached to a QQ renderer.
- `/metrics` — Prometheus metrics; authenticated by default. `WEB_BRIDGE_METRICS_PUBLIC=1` makes it public.

## Synchronization model

The initial connection is a complete sanitized snapshot. Normal operation uses revisioned patches. Mutations update only affected children, text, style/state or viewport metadata. If patch budget is exceeded, a client falls behind, a revision is missed, navigation occurs, or a periodic integrity checkpoint fires, the server sends a fresh snapshot.

Only one browser controls QQ by default. Additional clients are read-only and can request control. An idle controller can be replaced after `WEB_BRIDGE_CONTROL_LEASE_MS`. Set `WEB_BRIDGE_MULTI_CONTROL=1` only if concurrent input is explicitly desired.

## Files and media

A mirrored HTML file input selects files in the browser, streams them to a mode-0600 temporary host directory, then calls `DOM.setFileInputFiles` on the real QQ input. Uploads have size and TTL limits and are cleaned on expiry/shutdown.

Image/font/media resources are exposed only through random opaque tokens discovered from QQ DOM/CSS. The resource proxy supports byte ranges after caching. Resource and cache size caps are configurable. `@font-face` rules are mirrored through the same opaque resource layer.

Canvas is synchronized as an element-local PNG surface. Native Electron/OS dialogs and high-frequency WebGL surfaces remain compatibility fallbacks rather than DOM-native surfaces.

## Acceptance checklist

Run `pnpm doctor`, then verify on the actual QQ NT version you deploy:

1. QR/login page renders and login completes.
2. Main window replaces/reconnects correctly after login.
3. Conversation list scrolling and hover states remain synchronized.
4. Chinese IME, paste, shortcuts, emoji and multi-line input work.
5. Sending images/files through an HTML file input works.
6. Received images/fonts and short media resources render.
7. A second browser is read-only until it receives control.
8. Killing/restarting QQ causes the service to recover.
9. Slow/throttled browser networking causes a resync rather than unbounded buffering.
10. `/readyz` and `/metrics` behave correctly behind the reverse proxy.

A real QQ runtime acceptance pass is required before declaring a specific QQ build certified because Tencent can change its renderer structure without notice.
