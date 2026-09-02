# web-bridge

A DOM-reconstruction bridge for **QQ NT / closed-source Electron applications**.

QQ NT remains the authoritative runtime on the host. Its renderer JavaScript, preload, Electron IPC, account state, filesystem access and native modules are not moved into the browser. The browser renders a sanitized DOM/CSS/state mirror and sends validated user input back to the host.

> Current status: production-oriented beta. The protocol, security and deployment layers are hardened, but each QQ NT release still needs a real-host acceptance pass because Tencent can change Electron and renderer behavior at any time.

## Architecture

```text
Browser                         Host / QQ process
┌──────────────────┐           ┌──────────────────────────────────────┐
│ native DOM mirror│ <─patch── │ web-bridge                           │
│ no QQ JavaScript │           │  DOM sanitizer / patch relay         │
│ resource tokens  │ ────────> │  resource + upload relay             │
│ input capture    │ ──RPC────>│                                      │
└──────────────────┘           │ private loopback debugger transport │
                               │        │                             │
                               │        ▼                             │
                               │ QQ Main shim → webContents.debugger │
                               │                     │                │
                               │                     ▼                │
                               │                QQ renderer           │
                               └──────────────────────────────────────┘
```

The client never receives QQ script bundles, preload objects, arbitrary debugger access or host-local resource paths.

## What is implemented

- automatic Linux QQ NT executable discovery, preferring the packaged Electron host over launcher wrappers
- random loopback-only debugger endpoint by default
- Linux QQ main-entry debugger bridge through a temporary shadow Electron distribution
- automatic renderer target attach and reconnect
- sanitized initial DOM snapshot
- **revisioned incremental DOM/state/style patches**
- snapshot resync on missed revisions, navigation, patch overflow or slow clients
- Shadow DOM reconstruction
- computed CSS and `@font-face` mirroring
- opaque image/font/media resource relay with cache limits and byte-range responses
- element-local canvas PNG fallback
- mouse, right-click, hover, wheel, keyboard, paste and Chinese IME input
- select controls and HTML file inputs
- browser file upload → host temp file → real QQ event chain
- basic media state mirroring
- single-controller lease with additional read-only clients
- input rate limiting and WebSocket backpressure isolation
- HTTP Basic/Bearer authentication
- same-origin WebSocket checks and strict CSP/security headers
- `/healthz`, `/readyz`, Prometheus `/metrics`
- graceful shutdown and QQ/bridge pair supervision
- systemd user-service and Caddy deployment examples

## Quick start

Requirements: Linux QQ NT, Node.js 22+, pnpm.

```bash
pnpm install
pnpm doctor
pnpm dev:qq
```

The launcher discovers QQ automatically and prints the local browser endpoint. It chooses a private random debugger port unless `WEB_BRIDGE_CDP_PORT` is explicitly set.

### Why current Linux QQ uses a debugger shim

Linux QQ `3.2.33-52892` has been observed to reject Electron's Node inspector (`electron: bad option: --inspect-brk=...`) and to leave Chromium's `--remote-debugging-port` HTTP endpoint closed even when the switch is injected before QQ Main starts.

The bridge therefore no longer depends on Chromium's remote-debugging HTTP server for current QQ builds. Instead the QQ Main shim starts a private, per-launch authenticated loopback transport backed by Electron's `webContents.debugger` API. The host maps that transport to the same small CDP connection interface already used by the DOM bridge.

To load the shim without modifying `/opt/QQ`, `pnpm dev:qq` creates a temporary **shadow Electron distribution**:

1. copy only `/opt/QQ/qq` into a private user cache directory;
2. symlink the remaining QQ distribution and resources back to `/opt/QQ`;
3. replace only the shadow copy of `resources/app/package.json`;
4. run a tiny loader before QQ's original Main entry;
5. start the loopback `webContents.debugger` bridge and then load QQ normally;
6. remove the shadow tree when the launcher exits.

No mount namespace, Bubblewrap, root privileges, or `--no-sandbox` flag is used. Chromium's normal Linux sandbox remains enabled.

A successful startup should contain lines similar to:

```text
[web-bridge] prepared temporary QQ shadow distribution (installed /opt/QQ is untouched)
[web-bridge] using Electron webContents.debugger transport; Chromium remote-debugging-port is not required
[web-bridge] QQ webContents.debugger bridge listening: 127.0.0.1:33677 (...)
```

Control this behavior with:

```bash
WEB_BRIDGE_QQ_MAIN_SHIM=auto pnpm dev:qq   # default
WEB_BRIDGE_QQ_MAIN_SHIM=1 pnpm dev:qq      # require it; fail instead of falling back
WEB_BRIDGE_QQ_MAIN_SHIM=0 pnpm dev:qq      # disable it; try ordinary Chromium CDP flags
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

Do **not** expose the private debugger transport. Put only the Web Bridge HTTP endpoint behind TLS and configure a token:

```bash
WEB_BRIDGE_HOST=127.0.0.1
WEB_BRIDGE_AUTH_TOKEN="$(openssl rand -base64 36)"
pnpm dev:qq
```

Then reverse proxy `127.0.0.1:8080` with Caddy/Nginx. The browser uses HTTP Basic authentication; any username is accepted and the configured token is the password.

If `WEB_BRIDGE_HOST` is non-loopback and no authentication token is configured, startup is refused unless the explicit unsafe override is set. A non-loopback debugger host is refused separately.

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
- the browser cannot submit arbitrary JavaScript or debugger method names.
- input messages are schema-normalized, size-limited and rate-limited.
- file uploads use private temporary directories with size/TTL limits.
- only one browser controls QQ by default; other sessions are read-only.
- the QQ debugger bridge is loopback-only and requires a random per-launch token.
- the Linux main-entry shim and shadow executable are user-owned, short-lived, and deleted when the launcher exits; `/opt/QQ` is not modified.
- the shadow launcher does not disable Chromium's normal renderer sandbox.

## Operational endpoints

```text
GET /healthz   process liveness
GET /readyz    QQ renderer attachment readiness
GET /metrics   Prometheus metrics (authenticated by default)
```

## Known compatibility boundaries

DOM-native QQ UI is the primary target. Canvas currently uses element-local image snapshots. High-frequency WebGL surfaces and Electron/OS-native dialogs are not reconstructed as DOM. HTML file inputs are bridged, but an app that exclusively invokes `dialog.showOpenDialog()` from Electron Main may still need a native-dialog adapter.

The shadow launcher depends on the packaged Electron layout (`<qq>/resources/app/package.json`) and on Electron deriving `process.resourcesPath` from the copied executable. If that layout changes, `auto` mode falls back to executable command-line switches and prints a diagnostic; `WEB_BRIDGE_QQ_MAIN_SHIM=1` converts the condition into a hard failure.

## Development

```bash
npm install --ignore-scripts
npm test
node --check src/cdp.mjs
node --check src/host.mjs
node --check src/injected.mjs
node --check src/qq-main-shim.mjs
node --check src/electron-cdp-bootstrap.mjs
node --check public/client.js
bash -n scripts/qq-web-bridge.sh
```

This project does not patch or redistribute QQ NT. You are responsible for complying with QQ's terms and applicable law.
