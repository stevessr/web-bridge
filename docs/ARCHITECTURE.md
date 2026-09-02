# web-bridge v2 architecture

## 1. Non-negotiable routing invariant

QQ is **always server-owned**:

```text
QQ NT + NapCatQQ
      |
      | OneBot 11 Reverse WebSocket
      v
Rust Server
      |
      | web-bridge protocol (WS now; resumable sync later)
      v
Flutter + Rust Client
```

There is deliberately no `QQ -> client direct` adapter. The invariant exists in three layers: the shared Rust protocol (`Network::permits_route`), the server command validator, and the client account model/native policy function.

Matrix and Telegram are provider-owned per account:

```text
                    +--> server-owned Matrix/Telegram connector
Flutter UI <--------|
                    +--> client-owned Matrix/Telegram connector
```

Changing ownership must not change conversation/message UI models.

## 2. Why NapCat uses reverse WebSocket

NapCat is placed beside the QQ runtime and actively connects to the server. The server therefore does not need to expose NapCat's own HTTP/WS API, and clients never receive NapCat credentials. `X-Self-ID` identifies the QQ account so multiple NapCat instances/accounts can connect concurrently.

Recommended NapCat settings:

- WebSocket Client / Reverse WebSocket: enabled
- URL: `wss://bridge.example.com/onebot/v11/ws`
- token: same secret as `WEB_BRIDGE_NAPCAT_TOKEN`
- `messagePostFormat`: `array`
- reconnect: enabled
- self-message reporting: optional, but recommended for multi-device reconciliation

## 3. Server responsibilities

The Rust server owns:

- NapCat connections and QQ action/event translation;
- authentication, device sessions and account ACLs;
- durable event sequencing and offline sync (next milestone);
- attachment/media proxy and object storage (next milestone);
- optional Matrix and Telegram providers;
- push fan-out and presence aggregation.

It must not expose raw OneBot directly to Flutter.

## 4. Client responsibilities

Flutter owns UI/navigation/account setup. Rust owns native policy, cryptographic/session helpers and future local database/sync primitives through `flutter_rust_bridge`.

For **client-owned Matrix**, use Matrix Dart SDK directly. This branch pins the same `stevessr/matrix-dart-sdk` revision currently used by Extera, so MSC behavior does not silently diverge.

For Telegram, the provider boundary is intentionally not coupled to a library yet. A client-owned implementation can use TDLib or a Rust MTProto implementation; a server-owned implementation can use the same unified message model behind the server.

## 5. Unified protocol

`crates/protocol` defines:

- network/account identity;
- route ownership;
- conversation identity;
- rich message parts;
- client command frames;
- server event/ack/error/provider-state frames.

The bootstrap uses JSON over WebSocket for inspectability. Production sync should add monotonic sequence IDs, resume cursors, idempotency keys, per-device acknowledgement and bounded replay; binary media must never be embedded in ordinary WS frames.

## 6. Security model

Bootstrap tokens are intentionally simple. Production design should use:

1. server user login -> short-lived access token + rotating refresh token;
2. per-device key material and revocation;
3. a distinct credential for each NapCat instance/account rather than one global token;
4. TLS-only external endpoints;
5. account ACL checks on every command/event subscription;
6. SSRF-safe media fetching and size/MIME limits.

QQ credentials remain on the NapCat host; the Flutter client gets only web-bridge credentials.

## 7. Milestones

- M0 (this commit): greenfield tree, protocol, Rust server, NapCat RX/TX, Flutter shell, Matrix SDK bootstrap.
- M1: SQLite/PostgreSQL event store, seq/cursor sync, per-user auth, multi-device sessions.
- M2: complete OneBot mapping (reply/forward/voice/video/files/reactions/notices), media service, history API.
- M3: full Matrix client provider and account migration between client/server ownership.
- M4: Telegram client + server providers.
- M5: push, background sync, E2EE/key backup, calls, production observability/deployment.
