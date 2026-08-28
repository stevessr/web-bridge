# Architecture

## Trust boundary

`web-bridge` treats the QQ NT process as the only authoritative application runtime. QQ renderer JavaScript, preload bridges, Electron IPC, credentials, native modules and filesystem access remain on the host.

The web client is intentionally a presentation terminal. It receives sanitized DOM/style/state structures and opaque resource endpoints, but never QQ's executable renderer bundle or an arbitrary remote-evaluation channel.

## Runtime path

```text
Browser DOM
   |  revisioned patches / typed input RPC
   v
web-bridge host
   |  allow-listed CDP
   v
QQ Chromium renderer
   |  original event handlers / preload IPC
   v
Electron Main / host resources
```

## DOM capture

The host installs `src/injected.mjs` through `Page.addScriptToEvaluateOnNewDocument` and `Runtime.evaluate`; QQ package files are unchanged. The helper assigns stable numeric IDs to live nodes, sanitizes attributes, computes the CSS properties required for layout/visual fidelity, records control/media state and observes document plus discovered open Shadow Roots.

Initial connection uses a full snapshot. Mutation records are collapsed into bounded local patch sets instead of serializing the whole document after every update. Child-list changes replace only the affected child subtree; text, attribute/style/state and viewport changes use narrower patches. Patch overflow falls back to a full integrity snapshot.

A periodic snapshot protects against synchronization drift and unusual custom rendering behavior that does not reliably produce useful mutation batches. Closed Shadow Roots remain an explicit compatibility boundary because normal page JavaScript cannot inspect them after creation.

## Revisions and recovery

The host owns a monotonic revision number. A patch contains `baseRevision` and `revision`. A browser refuses a patch whose base does not match its local revision and asks for resynchronization.

WebSocket send backpressure is monitored per client. A slow client is dropped from the live patch/snapshot stream instead of accumulating an unbounded send queue and receives `resyncRequired` after its send buffer recovers. This prevents one browser from causing unbounded host memory growth.

## Input path

The browser can request only normalized operations: focus, pointer, click, wheel, key, text, select, file commit, resync and control-lease operations. It cannot choose CDP methods or JavaScript expressions.

Pointer coordinates are represented relative to a mirrored node. The host resolves that node against the real QQ DOM and uses its current bounding rectangle before `Input.dispatchMouseEvent`. Keyboard/text events use `Input.dispatchKeyEvent` and `Input.insertText`, so QQ's original React/Vue listeners and IPC execute on the host.

Hover-sensitive nodes are explicitly marked after host pointer movement so computed `:hover` visuals can be patched back to the browser even though hover itself is not a DOM mutation.

## Resources

URLs discovered in DOM attributes, computed CSS and `@font-face` rules are replaced by random per-process tokens. The original URL remains only in host memory. A client can request only a token already discovered from QQ.

Resources are loaded from Chromium's resource tree when available, then from a credentialed renderer-side fetch fallback. Response and cache sizes are bounded. Cached resources support HTTP byte ranges for media playback.

## Files

A client-side HTML file selection is streamed to a private temporary directory on the host. The host validates an opaque upload token and uses the real file-input remote object with `DOM.setFileInputFiles`. The resulting QQ input/change path remains in the host renderer. Temporary files expire automatically and are removed during shutdown.

## Multi-client control

Multiple clients may observe the same mirror. By default only one client has the controller lease; other clients are read-only. The lease starts when control is assigned and can move after an idle timeout or explicit release. Concurrent controllers require the explicit `WEB_BRIDGE_MULTI_CONTROL=1` override.

## Deployment boundary

The HTTP/WebSocket layer can use built-in Basic/Bearer authentication. Non-loopback HTTP binding without authentication is rejected by default. CDP has a separate, stricter rule: it must remain loopback-only unless an explicit dangerous override is supplied.
