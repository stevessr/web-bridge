# web-bridge v2

Greenfield unified messenger architecture using one shared Rust core for both the headless server and the Flutter client.

## Hard routing rules

- **QQ** always uses `server` routing. NapCatQQ connects to the Rust runtime through reverse OneBot 11 WebSocket; Flutter never talks to NapCat directly.
- **Matrix** can use `server` or `client` routing per account.
- **Telegram** can use `server` or `client` routing per account.
- QQ, Matrix and Telegram all support multiple simultaneous accounts.

An account is identified by `(network, account_id)`. Selecting another account in the UI changes only the active account; it does not sign out, stop or replace the other accounts.

## One core, two shells

- `crates/protocol` — shared wire types.
- `crates/core` — the only Rust business core: account registry, route policy, provider state and adapters.
- `crates/server` — thin headless launcher that starts `web-bridge-core` in server mode.
- `client/rust` — thin Flutter FFI wrapper that starts the same `web-bridge-core` in client mode.
- `client` — Flutter presentation layer.

There is intentionally no independent “server implementation” and “client implementation”. Provider work belongs in `crates/core`; the server is a daemon shell and the client adds Flutter UI around the embedded core.

## Protocol v2 account model

The v2 protocol includes:

- `list_accounts`
- `register_account`
- `remove_account`
- `set_account_route`
- `send_message`
- account added/changed/removed events
- per-account online/offline/error state

This means two Matrix accounts may use different routes, several Telegram accounts may stay connected together, and multiple NapCat sessions may expose several QQ accounts through one server.

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

## Current implementation

Implemented:

- shared Rust runtime used by both shells;
- multi-account registry for all three networks;
- per-account route selection;
- QQ server-only invariant enforced in protocol/core/native wrapper;
- multiple simultaneous NapCat connections keyed by QQ self ID;
- common OneBot message receive/send conversion;
- account state events and v2 account-management commands.

Matrix and Telegram transport engines, durable encrypted credential storage, durable message history and the full Flutter conversation UI are being added inside this shared-core architecture rather than as duplicated client/server implementations.
