# web-bridge v2 architecture

## 1. Non-negotiable routing invariant

QQ is **always server-owned**:

```text
QQ NT + NapCatQQ
      |
      | OneBot 11 Reverse WebSocket
      v
Rust Server Core
      |
      | web-bridge protocol v3
      v
Rust Client Core <-> flutter_rust_bridge <-> Flutter UI
```

There is deliberately no `QQ -> client direct` adapter. The invariant is enforced by the shared protocol, account registry, command executor, route policy, and Flutter-facing Rust API.

Matrix and Telegram are provider-owned per account:

```text
                         +--> embedded client-mode Rust Core
Flutter UI <-> FRB <-----|      Matrix / Telegram provider
                         |
                         +--> remote Rust Server Core
                                QQ / Matrix / Telegram provider
```

Changing ownership does not change the account, conversation, history, media, or message model. QQ is the only network whose ownership cannot be changed.

An account is keyed by `(network, account_id)`. UI account switching never disconnects other accounts.

## 2. Shared Rust Core

`crates/core` is the business/runtime layer used by both deployment modes. It owns:

- the multi-account registry and route policy;
- the unified command executor;
- Matrix provider sessions, sync, rich sending, and incoming mapping;
- Telegram provider sessions, login challenges, restore, updates, peer cache, replies, and media sending;
- NapCat/OneBot translation and real action acknowledgement tracking;
- the client-to-server `RemoteBridge` with automatic reconnect;
- local durable conversation/message history and cursors;
- per-account `MediaStore` and authenticated remote media transport;
- client credential/device/network/write authorization;
- the shared event bus.

The server binary and Flutter native library are shells around this same Core. Provider behavior must not be reimplemented in Dart.

## 3. Why NapCat uses reverse WebSocket

NapCat is placed beside QQ and actively connects to the server. The server therefore does not expose NapCat's own HTTP/WS API, and clients never receive NapCat credentials. `X-Self-ID` identifies the QQ account so multiple NapCat instances/accounts can connect concurrently.

Recommended NapCat settings:

- WebSocket Client / Reverse WebSocket: enabled
- URL: `wss://bridge.example.com/onebot/v11/ws`
- bearer token: the credential for that self ID from `WEB_BRIDGE_NAPCAT_TOKENS`, or the legacy `WEB_BRIDGE_NAPCAT_TOKEN`
- `messagePostFormat`: `array`
- reconnect: enabled
- self-message reporting: recommended for multi-device reconciliation

Outbound QQ commands are translated into OneBot actions in Core. Each action is correlated through `echo`; a unified command is acknowledged only after the required NapCat action response succeeds. File uploads use NapCat's private/group upload actions instead of pretending a file is a text segment.

## 4. Server responsibilities

The Rust server owns:

- all QQ/NapCat connections;
- optional server-owned Matrix and Telegram accounts;
- bearer authentication and structured client policy enforcement;
- device, network, read-only/write authorization;
- server-owned provider sessions/history/media;
- the server side of unified commands/events;
- authenticated media upload/download endpoints.

It never exposes raw OneBot frames to Flutter.

## 5. Client responsibilities

### Rust client core

- owns client-routed Matrix and Telegram providers;
- owns the remote Server WebSocket and reconnect manager;
- mirrors server-owned account state into the same account registry;
- automatically forwards server-routed commands;
- owns local provider history/media/session state;
- uploads server-owned attachments through authenticated Rust HTTP media transport;
- emits one unified event stream to Flutter;
- enforces the QQ server-only invariant even if UI input is malformed.

### Flutter

- renders navigation, account setup, account switching, history, and composer UI;
- collects credentials/challenge answers and turns them into unified Commands;
- selects native attachment files, then hands paths to the FRB media API;
- composes protocol `Text`, `Image`, `File`, `Mention`, and `Reply` parts;
- displays Core account/message/error/challenge events;
- does **not** own Matrix, Telegram, QQ, OneBot, HTTP authentication, or Server transport logic.

`flutter_rust_bridge` is the intended Flutter-to-Core boundary. Generated bindings are derived from `client/rust/src/api.rs`, and CI regenerates/validates them.

## 6. Provider implementation

### Matrix

The shared Core uses `matrix-sdk` with an independent SQLite store per account. It supports password login/restore, continuous sync, text, reply, mention, image/file sending, incoming rich-part mapping, and per-account disconnect without affecting other Matrix accounts.

### Telegram

The shared Core uses grammers with an independent Rusqlite session per account. It supports login-code and 2FA challenges, restore, update streaming, peer caching, replies, images/files, username mentions, and explicit capability errors when an outgoing mention cannot be represented safely.

Old grammers SQLite sessions are detected and migrated through a separately written/verified temporary database. The old database is kept as `.legacy.bak` after a successful migration; an export/migration failure does not overwrite the original session.

### QQ

QQ uses NapCatQQ/OneBot 11 only on the server. Multiple QQ accounts are keyed by self ID and can remain connected concurrently. Unified reply, mention, text, image, and file parts are translated to OneBot/NapCat operations with per-action acknowledgement tracking.

## 7. Unified protocol v3

`crates/protocol` defines:

- network/account identity and route ownership;
- account lifecycle snapshots;
- conversation identity;
- unified `Text`, `Image`, `File`, `Mention`, `Reply`, and explicit `Unsupported` message parts;
- typed client Commands;
- account/message/history/cursor/auth-challenge/ack/error server frames.

JSON over WebSocket is used for control/event traffic. Binary attachments are deliberately kept out of ordinary WebSocket frames and use `media:<uuid>` references backed by the Rust media layer.

## 8. History, media, and lifecycle

History is stored in Core rather than Dart. `ListConversations`, `ListMessages`, `GetCursor`, and `SetCursor` use the same command path for local and server-owned accounts.

The media layer is account-scoped and enforces a 64 MiB object limit. Flutter never uploads directly to an arbitrary provider endpoint: it invokes the Rust FRB media API, which either stores locally or uses the authenticated remote media client and returns a `media:<uuid>` reference.

Lifecycle semantics are intentionally distinct:

- `DisconnectAccount` stops the provider connection but preserves registration, provider session, history, cursors, and media.
- `RemoveAccount` is destructive and purges provider state, history, cursors, media, and registration.

## 9. Security model

Current production controls include:

1. bearer authentication for client and NapCat transports;
2. structured client credentials with principal/device/network/read-only policy;
3. per-QQ-account NapCat tokens;
4. WebSocket `Hello` device binding before commands are accepted;
5. the same credential/device/network ACL on HTTP media requests;
6. write permission enforcement on media uploads and mutating commands;
7. explicit browser `Origin` allowlisting when an Origin header is present;
8. server refusal to use built-in development credentials on a non-loopback bind;
9. media size limits and account-local media namespaces;
10. restricted permissions for persisted provider/session/media files.

The canonical HTTP media device header is `X-Web-Bridge-Device-ID`. `X-Device-ID` is accepted temporarily for compatibility; conflicting dual-header identities are rejected.

The daemon does not currently terminate public TLS itself. Internet-facing deployments should use a TLS reverse proxy and expose HTTPS/WSS only. QQ credentials remain on the NapCat/server side. Matrix/Telegram credentials and sessions remain in whichever Rust runtime owns that account.

## 10. Current implementation status

Implemented:

- protocol v3 and shared multi-account Core;
- QQ/NapCat reverse WebSocket receive/send with action ACK correlation;
- Matrix login/restore/sync and rich text/reply/mention/media mapping;
- Telegram login/2FA/restore/update streaming, legacy-session migration, reply/media sending, and peer cache;
- local durable history/cursors/media;
- authenticated remote media transport;
- client `RemoteBridge`, reconnect, request correlation, and server-account mirroring;
- Flutter account/login/history/composer integration through FRB;
- destructive remove vs non-destructive disconnect semantics;
- structured authentication/device/network/read-only ACL;
- Rust fmt/clippy/tests and Flutter analyze CI;
- FRB codegen/lockfile workflow with generated-commit validation.

Remaining provider-polish work should stay inside shared Rust Core. In particular, richer provider-specific incoming entity/media metadata should be translated into the existing unified message model rather than leaking SDK objects into Flutter.
