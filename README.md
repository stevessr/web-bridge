# web-bridge v2 — unified IM client/server

This branch is a **greenfield rewrite**. It intentionally contains none of the old Electron/QQ-NT/CDP/Node implementation from `main`.

## Architecture

- **QQ**: `NapCatQQ -> OneBot 11 Reverse WebSocket -> Rust Server -> Unified protocol -> Client`. QQ is server-only by design; the client has no direct NapCat route.
- **Matrix**: configurable. Default is client-side via the same Matrix Dart SDK family used by FluffyChat/Extera. Server-side Matrix can be added as a connector without changing the client protocol.
- **Telegram**: configurable. The account can be owned by the server or by the client; both implement the same provider interface.
- **Client**: Flutter UI + Rust native core (`flutter_rust_bridge`).
- **Server**: async Rust/Axum.

## Current bootstrap milestone

The initial commit provides:

1. a typed cross-platform protocol crate;
2. a working Rust WebSocket server;
3. a working NapCat OneBot 11 reverse-WebSocket ingress and QQ send path;
4. a Flutter account-routing shell;
5. Matrix client bootstrap pinned to the Matrix Dart SDK revision currently used by Extera;
6. a Rust client core defining hard routing invariants.

The next milestones are persistent storage/history, media proxying, auth/device sessions, full Matrix provider wiring, Telegram providers, push, E2EE/session migration and production deployment.

## Run the server

```bash
cp config/server.example.toml config/server.toml
WEB_BRIDGE_BIND=0.0.0.0:8787 \
WEB_BRIDGE_CLIENT_TOKEN=change-me \
WEB_BRIDGE_NAPCAT_TOKEN=change-me-too \
cargo run -p web-bridge-server
```

Configure NapCatQQ WebSocket Client / Reverse WebSocket to:

```text
ws://SERVER:8787/onebot/v11/ws
```

Use `messagePostFormat = array`, enable self-message reporting if desired, and set the same NapCat token.

Client WebSocket endpoint:

```text
ws://SERVER:8787/v1/ws?token=CLIENT_TOKEN
```

See `docs/ARCHITECTURE.md` for protocol and trust-boundary details.
