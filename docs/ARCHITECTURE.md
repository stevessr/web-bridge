# Architecture

## Trust boundary

`web-bridge` treats the QQ NT process as the authoritative application runtime.

The browser never receives or executes QQ's renderer bundles, preload code, Electron IPC objects, cookies, local filesystem paths, native modules, or arbitrary CDP access.

```text
untrusted / remote browser
        │
        │ typed bridge protocol
        ▼
web-bridge host process
        │
        │ allow-listed CDP methods
        ▼
QQ NT Chromium renderer
        │
        ├─ QQ renderer JavaScript
        ├─ preload / IPC
        └─ Electron main / native operations
```

## DOM transport

The host installs a small inspector helper into the renderer through CDP `Runtime.evaluate` and `Page.addScriptToEvaluateOnNewDocument`. It does not modify QQ's packaged files.

The helper:

1. Gives DOM nodes host-local numeric identities.
2. Serializes visible application structure, selected computed CSS properties and control state.
3. Removes executable/active content (`script`, inline event handlers, `srcdoc`, embedded frames/objects).
4. Redacts password values.
5. Signals the host when a `MutationObserver`, input, change, scroll or resize event makes the mirror dirty.

The PoC currently sends a throttled full sanitized tree after a dirty signal. This is deliberately simple and gives us a correctness baseline. A later transport should retain the same node IDs but encode structural patches (`insert`, `remove`, `attr`, `text`, `state`, `style`) instead.

## Input transport

Client messages are a fixed allow-list:

- `focus`
- `pointer`
- `click`
- `wheel`
- `key`
- `text`

The client cannot submit a CDP method name or JavaScript expression.

For pointer operations, the host resolves the client node ID inside the QQ renderer, obtains the element's current `getBoundingClientRect()`, maps normalized client coordinates into the host element, and calls Chromium `Input.dispatchMouseEvent`.

Keyboard input uses `Input.dispatchKeyEvent`; IME/paste text uses `Input.insertText`. Therefore QQ's own React/Vue handlers, DOM event listeners and Electron IPC chain execute on the host.

## Resource relay

Arbitrary `GET /resource?url=...` style proxying is intentionally not provided.

When the host creates a snapshot it discovers resource URLs already referenced by QQ, registers each one under a random opaque token, rewrites the browser-facing DOM/CSS to `/resource/<token>`, and stores the original URL only on the host.

A resource request is served by:

1. `Page.getResourceTree` + `Page.getResourceContent` when Chromium already knows the loaded resource.
2. A credentialed `fetch()` inside the QQ renderer as a fallback for blob/custom-protocol-compatible resources.

This prevents a remote browser from turning the bridge into a generic host-side URL fetcher.

## Surfaces that are not DOM

`canvas` is currently represented as an element-local PNG snapshot. This preserves QQ QR codes and simple canvas content without pixel-streaming the whole application.

The intended next layer is per-element surface transport:

- canvas with frequent changes: WebCodecs/WebRTC region stream
- WebGL: captured region stream
- video: media/region stream
- Electron native menus/dialogs: explicit bridge adapters or temporary region fallback

The DOM remains native in the browser; only non-DOM islands should use pixels/media.

## QQ NT notes

The default launcher targets Linux QQ NT at `/opt/QQ/qq`, but `QQ_BIN` is configurable. A pre-existing QQ process should be fully exited before launch because Electron single-instance forwarding may otherwise cause the new process (with the debugging flags) to terminate immediately.

For systems where QQ exposes multiple renderer targets, set `WEB_BRIDGE_TARGET_MATCH` to a regular expression matching the desired target title or URL.
