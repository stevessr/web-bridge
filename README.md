# web-bridge

A DOM-reconstruction bridge for **QQ NT / closed-source Electron applications**.

QQ NT remains the authoritative runtime on the host. Its renderer JavaScript, preload, Electron IPC, account state, filesystem access and native modules are not moved into the browser. The browser renders a sanitized DOM/CSS/state mirror and sends validated user input back to the host, where Chromium CDP reinjects it into the real QQ renderer.

> Current status: production-oriented beta. The protocol, security and deployment layers are hardened, but each QQ NT release still needs a real-host acceptance pass because Tencent can change internal renderer behavior at any time.

## Architecture

```text
Browser                         Host
┌──────────────────┐           ┌───────────────────────────────┐
│ native DOM mirror│ <─patch── │ web-bridge                   │
│ no QQ JavaScript │           │  DOM sanitizer / patch relay │
│ resource tokens  │ ────────> │  resource + upload relay     │
│ input capture    │ ──RPC────>│  allow-listed CDP input      │
└──────────────────┘           └──────────────┬────────────────┘
                                             │ private loopback CDP
                                      ┌──────▼───────┐
                                      │ QQ NT        │
                                      │ renderer     │
                                      │ preload / IPC│
                                      │ Electron main│
                                      └──────────────┘
```

The client never receives QQ script bundles, preload objects, arbitrary CDP access or host-local resource paths.

## What is implemented

- automatic Linux QQ NT executable discovery, preferring the packaged Electron host over launcher wrappers
- random loopback-only CDP port by default
- Linux QQ main-entry CDP injection through a temporary Bubblewrap mount overlay when available
- automatic target attach and reconnect
- sanitized initial DOM snapshot
- **revisioned incremental DOM/state/style patches**
- snapshot resync on missed revisions, navigation, patch overflow or slow clients
- Shadow DOM reconstruction
- computed CSS and `@font-face` mirroring
- opaque image/font/media resource relay with cache limits and byte-range responses
- element-local canvas PNG fallback
- mouse, right-click, hover, wheel, keyboard, paste and Chinese IME input
- select controls and HTML file inputs
- browser file upload → host temp file → `DOM.setFileInputFiles` → real QQ event chain
- basic media state mirroring
- single-controller lease with additional read-only clients
- input rate limiting and WebSocket backpressure isolation
- HTTP Basic/Bearer authentication
- same-origin WebSocket checks and strict CSP/security headers
- `/healthz`, `/readyz`, Prometheus `/metrics`
- graceful shutdown and QQ/bridge pair supervision
- systemd user-service and Caddy deployment examples

## Quick start

Requirements: Linux QQ NT, Node.js 22+, pnpm. `bubblewrap`/`bwrap` is strongly recommended for current Linux QQ builds.

```bash
pnpm install
pnpm doctor
pnpm dev:qq
```

The launcher discovers QQ automatically and prints the local browser endpoint. It chooses a private random CDP port unless `WEB_BRIDGE_CDP_PORT` is explicitly set.

Current Linux QQ builds such as `3.2.33-52892` can reject Electron's `--inspect-brk` flags and may also fail to open the DevTools HTTP endpoint when `--remote-debugging-port` is supplied only on the packaged executable command line. Electron's supported application-side mechanism is `app.commandLine.appendSwitch(...)` before the application becomes ready.

On Linux, `pnpm dev:qq` therefore prefers a **temporary main-entry overlay** when `bwrap` is available:

1. read `/opt/QQ/resources/app/package.json` and remember its original `main` entry;
2. create a private temporary package copy and a tiny loader in the user's runtime/temp directory;
3. start QQ in a Bubblewrap mount namespace whose only intentional filesystem override is the package copy;
4. the loader calls `app.commandLine.appendSwitch('remote-debugging-address', ...)` and `app.commandLine.appendSwitch('remote-debugging-port', ...)` before loading QQ's original main entry;
5. the real `/opt/QQ/resources/app/package.json` is **never written or modified**.

A successful startup should contain a line similar to:

```text
[web-bridge] prepared temporary QQ main-entry overlay (host package.json is not modified)
[web-bridge] QQ main shim injected Chromium CDP switches: 127.0.0.1:33677
```

Control this behavior with:

```bash
WEB_BRIDGE_QQ_MAIN_SHIM=auto pnpm dev:qq   # default: use it when bwrap works
WEB_BRIDGE_QQ_MAIN_SHIM=1 pnpm dev:qq      # require it; fail instead of silently falling back
WEB_BRIDGE_QQ_MAIN_SHIM=0 pnpm dev:qq      # disable it; argv-only CDP launch
```

The old Node-inspector bootstrap is retained only for diagnostics on compatible Electron builds and is off by default:

```bash
WEB_BRIDGE_QQ_CDP_BOOTSTRAP=1 pnpm dev:qq
```

Inspect discovery candidates with:

```bash
pnpm detect:qq
```

On the official-style Linux package, `/opt/QQ/qq` should rank ahead of `/usr/bin/linuxqq`. Override detection when necessary:

```bash
QQ_BIN=/opt/QQ/qq pnpm dev:qq
```

QQ must be fully closed before `pnpm dev:qq`; Electron single-instance forwarding otherwise prevents the fresh process from receiving the bridge setup.

## Exposing it to another machine

Do **not** expose the CDP port. Put only the Web Bridge HTTP endpoint behind TLS and configure a token:

```bash
WEB_BRIDGE_HOST=127.0.0.1
WEB_BRIDGE_AUTH_TOKEN="$(openssl rand -base64 36)"
pnpm dev:qq
```

Then reverse proxy `127.0.0.1:8080` with Caddy/Nginx. The browser uses HTTP Basic authentication; any username is accepted and the configured token is the password.

If `WEB_BRIDGE_HOST` is non-loopback and no authentication token is configured, startup is refused unless the explicit unsafe override is set. A non-loopback CDP host is refused separately.

See [`docs/PRODUCTION.md`](docs/PRODUCTION.md) and the files under [`deploy/`](deploy/).

## Synchronization protocol

A client starts from a full sanitized snapshot with a monotonically increasing revision. The injected observer then reports local mutations to the host. Normal updates are patches such as:

```text
children  replace the affected node's child subtree
update    attrs + computed style + control/media state
text      update one text node
meta      title / viewport / font metadata
```

The browser applies a patch only if `baseRevision` equals its current revision. Any gap requests a fresh snapshot. Slow clients are not allowed to build an unbounded server send queue; they are marked for resync instead.

## Security model

- `<script>`, inline `on*`, `srcdoc`, iframe/frame/object/embed/webview content are never reconstructed as executable content.
- `javascript:` navigation is removed.
- password and file-input values are not serialized.
- host-local app/resource URLs become random opaque resource tokens.
- the browser cannot submit arbitrary JavaScript or CDP method names.
- input messages are schema-normalized, size-limited and rate-limited.
- file uploads use private temporary directories with size/TTL limits.
- only one browser controls QQ by default; other sessions are read-only.
- CDP is treated as a privileged internal interface and is loopback-only by default.
- the Linux main-entry shim is user-owned, short-lived, and visible to QQ only inside its temporary mount namespace; `/opt/QQ` is not modified.
- the experimental Electron Node inspector path is disabled by default.

## Operational endpoints

```text
GET /healthz   process liveness
GET /readyz    QQ renderer attachment readiness
GET /metrics   Prometheus metrics (authenticated by default)
```

## Known compatibility boundaries

DOM-native QQ UI is the primary target. Canvas currently uses element-local image snapshots. High-frequency WebGL surfaces and Electron/OS-native dialogs are not reconstructed as DOM. HTML file inputs are bridged, but an app that exclusively invokes `dialog.showOpenDialog()` from Electron Main may still need a native-dialog adapter.

The Bubblewrap main-entry overlay requires an environment where `bwrap` can create a mount namespace. If it is unavailable, `auto` mode falls back to executable command-line switches and prints a diagnostic; `WEB_BRIDGE_QQ_MAIN_SHIM=1` converts that condition into a hard failure.

Those limitations do not weaken the isolation model; they affect fidelity for specific UI paths. See the production acceptance checklist before certifying a QQ build.

## Development

```bash
npm install --ignore-scripts
npm test
node --check src/host.mjs
node --check src/injected.mjs
node --check src/qq-main-shim.mjs
node --check src/electron-cdp-bootstrap.mjs
node --check public/client.js
bash -n scripts/qq-web-bridge.sh
```

This project does not patch or redistribute QQ NT. The Linux overlay changes QQ's view of one package metadata file only inside a temporary mount namespace and leaves the installed application untouched. You are responsible for complying with QQ's terms and applicable law.
