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
      | web-bridge protocol
      v
Rust Client Core <-> flutter_rust_bridge <-> Flutter UI
```

There is deliberately no `QQ -> client direct` adapter. The invariant is enforced by the shared protocol, shared account registry, shared command executor and Flutter-facing Rust API.

Matrix and Telegram are provider-owned per account:

```text
                         +--> embedded client-mode Rust Core
Flutter UI <-> FRB <-----|      Matrix / Telegram provider
                         |
                         +--> remote Rust Server Core
                                QQ / Matrix / Telegram provider
```

Changing ownership does not change the account, conversation or message model. QQ is the only network whose ownership cannot be changed.

## 2. Shared Rust Core

`crates/core` is the business/runtime layer used by both deployment modes. It owns:

- the multi-account registry and route policy;
- the unified command executor;
- Matrix provider sessions, sync and sending;
- Telegram provider sessions, login challenges, updates and sending;
- NapCat/OneBot translation used by the server runtime;
- the client-to-server remote bridge;
- the shared event bus.

The server binary and Flutter native library are shells around this same Core. Provider behavior must not be reimplemented in Dart.

## 3. Why NapCat uses reverse WebSocket

NapCat is placed beside QQ and actively connects to the server. The server therefore does not expose NapCat's own HTTP/WS API, and clients never receive NapCat credentials. `X-Self-ID` identifies the QQ account so multiple NapCat instances/accounts can connect concurrently.

Recommended NapCat settings:

- WebSocket Client / Reverse WebSocket: enabled
- URL: `wss://bridge.example.com/onebot/v11/ws`
- token: same secret as `WEB_BRIDGE_NAPCAT_TOKEN`
- `messagePostFormat`: `array`
- reconnect: enabled
- self-message reporting: recommended for multi-device reconciliation

## 4. Server responsibilities

The Rust server owns:

- all QQ/NapCat connections;
- optional server-owned Matrix and Telegram accounts;
- client authentication and account authorization;
- the server side of unified commands/events;
- future durable event sequencing, offline replay and media proxying.

It must never expose raw OneBot frames to Flutter.

## 5. Client responsibilities

The native client is split deliberately:

### Rust client core

- owns client-routed Matrix and Telegram providers;
- owns the remote Server WebSocket;
- mirrors server-owned account state into the same account registry;
- automatically forwards server-routed commands;
- emits one unified event stream to Flutter;
- enforces the QQ server-only invariant even if UI input is malformed.

### Flutter

- renders navigation, account setup, account switching and message UI;
- collects credentials/challenge answers and turns them into unified Commands;
- displays Core account/message/error/challenge events;
- does **not** own Matrix, Telegram or Server transport logic.

`flutter_rust_bridge` is the only intended Flutter-to-Core boundary. Generated bindings are derived from `client/rust/src/api.rs`.

## 6. Provider implementation

### Matrix

The shared Core uses `matrix-sdk` with an independent SQLite store per account. Password login, continuous sync, room text sending and incoming room-message translation are implemented in the same provider for both client-owned and server-owned routes.

### Telegram

The shared Core uses grammers with an independent SQLite session per account. It implements login-code and 2FA-password challenges, update streaming, peer caching and text sending. The same provider runs in client or server mode according to account route.

### QQ

QQ uses NapCatQQ/OneBot 11 only on the server. Multiple QQ accounts are keyed by their self ID and can remain connected concurrently.

## 7. Unified protocol

`crates/protocol` defines:

- network/account identity and route ownership;
- account lifecycle snapshots;
- conversation identity and rich message parts;
- typed client Commands;
- account/message/auth-challenge/ack/error server frames.

JSON over WebSocket is currently used for inspectability. Durable production sync should add monotonic sequence IDs, resume cursors, idempotency keys, per-device acknowledgements and bounded replay. Binary media must not be embedded in ordinary WebSocket frames.

## 8. Security model

Bootstrap tokens remain intentionally simple. Production design should use:

1. short-lived user access tokens plus rotating refresh tokens;
2. per-device keys and revocation;
3. distinct credentials for NapCat instances/accounts;
4. TLS-only external endpoints;
5. authorization checks on every account command and event subscription;
6. SSRF-safe media fetching with strict size/MIME limits.

QQ credentials remain on the NapCat host. Matrix/Telegram credentials and sessions remain in whichever Rust runtime owns that account.

## 9. Current implementation status

Implemented:

- greenfield Rust workspace and protocol v2;
- shared multi-account Core;
- QQ/NapCat reverse WebSocket server path;
- Matrix provider in shared Core;
- Telegram provider and auth challenges in shared Core;
- client RemoteBridge and server-account mirroring;
- shared command executor;
- Flutter-facing FRB API boundary;
- CI fmt/clippy/test/analyze and dependency caching.

Next integration work:

- generated FRB bindings wired into Flutter;
- removal of the legacy Dart `ServerGateway` path;
- Matrix/Telegram account-login and challenge UI;
- persisted client settings and active-account selection;
- durable event sequencing/history/media services;
- production authentication and multi-device authorization.
