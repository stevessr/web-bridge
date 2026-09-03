# web-bridge v2

Greenfield unified messenger architecture using one shared Rust Core for both the headless server and Flutter client.

## Routing invariants

- **QQ is always server-routed.** NapCatQQ connects to the Rust server through reverse OneBot 11 WebSocket. Flutter never talks to NapCat or OneBot directly.
- **Matrix** can be `server` or `client` routed per account.
- **Telegram** can be `server` or `client` routed per account.
- All three networks support multiple simultaneous accounts.
- An account is uniquely identified by `(network, account_id)`.
- Changing the active account in Flutter is only a UI selection change. It must not sign out, replace, or disconnect another account.

## One Core, two shells

- `crates/protocol` — shared wire/account/message/command types.
- `crates/core` — account registry, route policy, command executor, durable history/media, remote transport, and QQ/Matrix/Telegram providers.
- `crates/server` — thin daemon launcher running Core in server mode.
- `client/rust` — Flutter native library running the same Core in client mode and bridging server-owned accounts.
- `client` — Flutter presentation layer.

Provider/network behavior belongs in Rust Core. Dart is responsible for UI, user input, native file selection, and rendering Core events. It must not implement Matrix, Telegram, QQ, OneBot, or remote authentication logic itself.

## Protocol

The current wire protocol is **protocol v3**. It includes:

- account registration, removal, disconnect, and routing;
- Matrix password login and Telegram login-code/2FA challenges;
- unified `Text`, `Image`, `File`, `Mention`, and `Reply` message parts;
- send, conversation history, message history, and durable cursors;
- account snapshots, messages, acknowledgements, structured errors, and auth challenges.

The embedded client Core executes client-routed Matrix/Telegram commands locally and forwards server-routed commands through its Rust `RemoteBridge`. QQ commands are always forwarded to the server.

## Development server

For local-only development, bind to loopback:

```bash
export WEB_BRIDGE_BIND=127.0.0.1:8787
export WEB_BRIDGE_CLIENT_TOKEN=change-me
export WEB_BRIDGE_NAPCAT_TOKEN=change-me-too
cargo run -p web-bridge-server
```

Endpoints:

- `GET /healthz`
- `GET /v1/info`
- `GET /v1/ws` — client protocol WebSocket; authenticate with `Authorization: Bearer ...`
- `POST /v1/media/{network}/{account_id}` — authenticated media upload
- `GET /v1/media/{network}/{account_id}/{media_id}` — authenticated media download
- `GET /onebot/v11/ws` — NapCat reverse WebSocket; requires `Authorization: Bearer ...` and `X-Self-ID`

NapCat should use array message format and connect to `ws(s)://SERVER/onebot/v11/ws` as a WebSocket client.

## Production authentication

For non-loopback binds the server refuses to start with the built-in development credentials. Prefer structured credentials instead of the legacy single client token:

```bash
export WEB_BRIDGE_CLIENT_CREDENTIALS='[
  {
    "token": "replace-with-a-long-random-secret",
    "principal": "desktop",
    "devices": ["flutter-device-id"],
    "networks": ["matrix", "telegram"],
    "read_only": false
  }
]'

export WEB_BRIDGE_NAPCAT_TOKENS='{
  "10001": "replace-with-a-different-long-random-secret"
}'
```

`WEB_BRIDGE_CLIENT_CREDENTIALS` binds a token to a principal, optional device allowlist, optional network allowlist, and read-only/write policy. When the structured credential list is non-empty, the legacy `WEB_BRIDGE_CLIENT_TOKEN` is not a fallback credential.

`WEB_BRIDGE_NAPCAT_TOKENS` maps each QQ self ID to its own NapCat credential. This keeps multiple QQ accounts independently authenticated.

Browser-originated client connections may additionally be restricted with a comma-separated allowlist:

```bash
export WEB_BRIDGE_ALLOWED_ORIGINS='https://app.example.com,https://admin.example.com'
```

Native clients normally do not send an `Origin` header.

## Device identity and media ACL

The WebSocket client sends its device ID in the protocol `Hello` frame. HTTP media requests send the same device identity using:

```text
X-Web-Bridge-Device-ID: <device-id>
```

`X-Device-ID` remains accepted as a transition compatibility header. If both headers are present they must have the same value; conflicting values are rejected.

Media access uses the same client credential policy as the WebSocket transport:

- the bearer credential must be valid;
- the device must be allowed by that credential;
- the network must be allowed by that credential;
- uploads require a writable credential;
- the target account must exist locally in the server runtime;
- media objects are limited to 64 MiB by Core.

Tokens are sent in the `Authorization` header, never in media URLs.

## TLS / reverse proxy deployment

The Rust daemon currently serves HTTP/WebSocket itself and does not terminate public TLS. For an Internet-facing deployment, terminate TLS at a reverse proxy and expose only **HTTPS/WSS** externally.

A recommended topology is:

```text
Flutter / native client
        |
        | HTTPS + WSS
        v
TLS reverse proxy
        |
        | HTTP + WS on a private/loopback hop
        v
web-bridge-server :8787
        |
        +-- QQ -> NapCatQQ / OneBot 11
        +-- Matrix -> matrix-sdk
        +-- Telegram -> grammers
```

Production proxy requirements:

- forward `Authorization`, `X-Web-Bridge-Device-ID`, `X-File-Name`, `Content-Type`, `Origin`, and NapCat `X-Self-ID` headers unchanged;
- support WebSocket upgrade for both `/v1/ws` and `/onebot/v11/ws`;
- allow request bodies of at least 64 MiB on `/v1/media/` if the Core media maximum is intended to be usable;
- use sufficiently long WebSocket idle/read timeouts;
- do not log bearer tokens or rewrite them into query strings;
- keep the direct Rust listener private when possible, for example `WEB_BRIDGE_BIND=127.0.0.1:8787` when the proxy runs on the same host.

The Flutter client should therefore use an endpoint such as `wss://bridge.example.com/v1/ws`. Rust automatically derives the matching HTTPS media endpoint from that WSS URL.

## Durable provider state

- Matrix uses a per-account Matrix SDK SQLite store and persisted native session.
- Telegram uses a per-account Rusqlite-backed grammers session.
- Existing legacy grammers SQLite sessions are migrated through a temporary database and verified before replacement; the old session is preserved as a `.legacy.bak` backup on successful migration.
- `DisconnectAccount` disconnects a provider while preserving account/session/history/media state.
- `RemoveAccount` performs the destructive account-data purge.

## Message/media status

Implemented in shared Rust Core:

- multi-account account registry and route policy;
- multi-account NapCat/QQ reverse WebSocket receive/send path with real action acknowledgements;
- Matrix password login, restore, continuous sync, text/reply/mention/media mapping and attachments;
- Telegram persistent sessions, login-code/2FA, restore, update streaming, peer cache, replies, media upload, and explicit mention capability handling;
- unified local history and cursors;
- local and authenticated remote `media:<uuid>` transport;
- Rust client-to-server `RemoteBridge` with automatic reconnect and server-account mirroring;
- Flutter composer using unified protocol parts and Rust media upload APIs;
- CI for Rust fmt/clippy/tests and Flutter analyze;
- FRB codegen workflow that regenerates bindings/lockfiles and validates the generated commit.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the detailed topology and invariants.
