# web-bridge

Experimental DOM-reconstruction bridge for **QQ NT / closed-source Electron apps**.

The host keeps QQ NT and all of its JavaScript, preload, IPC, credentials, filesystem access and native modules on the machine running QQ. A browser receives only a sanitized DOM/CSS representation and sends typed input RPCs back to the host.

> Status: early PoC. Do not expose the bridge directly to the public Internet yet.

## Architecture

```text
QQ NT (Electron renderer + main)
        │
        │ Chrome DevTools Protocol
        ▼
web-bridge host
  ├─ DOM/CSS serializer
  ├─ resource token relay
  ├─ CDP input injector
  └─ WebSocket protocol
        │
        ▼
Browser
  ├─ native DOM reconstruction
  ├─ no QQ JavaScript/preload
  └─ pointer/keyboard/wheel RPC
```

The browser is a presentation terminal. Business logic always executes inside the original QQ NT process.

## Quick start (Linux QQ NT)

Requirements: Node.js 22+, pnpm, Linux QQ NT.

```bash
pnpm install
pnpm dev:qq
```

The launcher now **auto-detects the installed QQ NT executable**. `QQ_BIN` is only needed as an explicit override.

Discovery checks, in priority order:

1. `QQ_BIN` when explicitly set.
2. A currently running native QQ process (useful for discovering the installation path; the launcher will still ask you to exit it before relaunching with CDP).
3. `qq`, `linuxqq`, and `QQ` on `PATH`.
4. Known native paths such as `/opt/QQ/qq` and `/usr/bin/linuxqq`.
5. QQ/Tencent `.desktop` entries under the XDG application directories, including `Exec=env ... /path/to/linuxqq ...` forms.
6. Installed-file lists from dpkg/pacman/rpm when available.
7. QQ/AppImage candidates in `~/Applications` and `~/.local/bin`.

Inspect every candidate and its discovery source with:

```bash
pnpm detect:qq
```

Override the result when needed:

```bash
QQ_BIN=/custom/path/to/qq \
WEB_BRIDGE_PORT=8080 \
WEB_BRIDGE_CDP_PORT=9222 \
pnpm dev:qq
```

`QQ_BIN=linuxqq` also works when the command is on `PATH`.

If QQ is already running, fully exit it first. Electron single-instance handling can otherwise route the second launch into the existing process without enabling the requested debugging port. The launcher reports the detected executable and existing PID to make this case easier to diagnose.

## Security model

- Original `<script>` elements are never sent to the client.
- Inline `on*` handlers, `javascript:` URLs, `srcdoc`, embedded objects and frames are removed/replaced.
- Password values are redacted from snapshots.
- The browser cannot submit arbitrary CDP commands or arbitrary URLs.
- Resources referenced by QQ are replaced with opaque per-session resource tokens before being exposed to the browser.
- Client input is mapped to a small allow-listed RPC set and reinjected through Chromium's input path on the host.

This PoC currently has **no authentication/TLS layer**. Bind it to loopback or put it behind your own authenticated reverse proxy.

## Current scope

Implemented:

- attach to a QQ NT Chromium renderer through CDP
- automatic native Linux QQ executable discovery with diagnostics and explicit override
- sanitized DOM + computed-style reconstruction
- shadow-root reconstruction
- image/font/background resource relay through opaque tokens
- mouse click/right-click/hover
- keyboard and text input
- wheel scrolling
- canvas snapshot fallback
- mutation-driven, throttled state refresh

Planned:

- structural incremental patches instead of whole-tree dirty snapshots
- video/WebGL element-local streaming surfaces
- Electron native menu/dialog interception helpers
- multi-window / multi-target sessions
- IME composition fidelity improvements
- authentication and session isolation

## Legal / operational note

This project does not patch or redistribute QQ NT. It attaches to a locally installed application through Chromium debugging facilities. You are responsible for complying with the application's terms and local law.
