# web-bridge v2

Greenfield unified messenger architecture using one shared Rust Core for both the headless server and Flutter client.

## Routing rules

- **QQ** is always `server` routed. NapCatQQ connects to the Rust server through reverse OneBot 11 WebSocket; Flutter never talks to NapCat directly.
- **Matrix** can be `server` or `client` routed per account.
- **Telegram** can be `server` or `client` routed per account.
- All three networks support multiple simultaneous accounts.

An account is identified by `(network, account_id)`. Switching the active UI account never signs out or replaces the other accounts.

## One Core, two shells

- `crates/protocol` — shared wire/account/message/command types.
- `crates/core` — account registry, route policy, shared command executor and QQ/Matrix/Telegram providers.
- `crates/server` — thin daemon launcher running Core in server mode.
- `client/rust` — Flutter native library running the same Core in client mode and bridging remote server-owned accounts.
- `client` — Flutter presentation layer.

Provider/network behavior belongs in Rust Core. Dart should contain UI, credential input and event rendering only.

## Protocol v2

Protocol v2 includes account registration/removal/routing, Matrix and Telegram login commands, Telegram auth challenges, provider disconnect, unified message sending, account snapshots, messages, acknowledgements and errors.

The embedded client Core automatically executes client-routed Matrix/Telegram commands locally and forwards server-routed commands through its Rust `RemoteBridge`. QQ is always forwarded.

## Development server

```bash
export WEB_BRIDGE_CLIENT_TOKEN=change-me
export WEB_BRIDGE_NAPCAT_TOKEN=change-me-too
cargo run -p web-bridge-server
```

Endpoints:

- `GET /healthz`
- `GET /v1/info`
- `GET /v1/ws?token=...` — client protocol v2
- `GET /onebot/v11/ws` — NapCat reverse WebSocket (`Authorization: Bearer ...`, `X-Self-ID` required)

NapCat should use array message format and connect to `ws(s)://SERVER/onebot/v11/ws` as a WebSocket client.

## Provider status

Implemented in shared Rust Core:

- multi-account account registry and route policy;
- multi-account NapCat/QQ reverse WebSocket receive/send path;
- Matrix password login, per-account SQLite store, continuous sync, incoming room messages and room text sending;
- Telegram per-account SQLite sessions, login-code/2FA challenges, update streaming, peer cache and text sending;
- client-to-server Rust RemoteBridge and server-account mirroring;
- shared command executor used by both server and client runtimes;
- Flutter-facing FRB API surface in `client/rust/src/api.rs`;
- CI for Rust fmt/clippy/tests and Flutter analyze.

Current integration work is focused on generated FRB bindings, removing the legacy Dart `ServerGateway`, Matrix/Telegram login UI, durable settings/history/media and production authentication.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the detailed topology and invariants.
