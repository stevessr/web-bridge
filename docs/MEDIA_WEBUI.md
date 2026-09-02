# Media WebUI

The `feat/youtube-auto-fansub-bilibili` branch includes a lightweight WebUI for the YouTube -> ASR -> translation -> subtitles -> Bilibili pipeline.

## Start

```bash
cp config/media.example.json config/media.json
npm install
npm run media:web -- --config config/media.json
```

Default address:

```text
http://127.0.0.1:8787/
```

Development mode with Node watch:

```bash
npm run media:web:dev -- --config config/media.json
```

## Remote access and authentication

The WebUI intentionally binds to loopback by default. A non-loopback bind is rejected unless a bearer token is configured.

```bash
WEB_BRIDGE_MEDIA_WEB_HOST=0.0.0.0 \
WEB_BRIDGE_MEDIA_WEB_PORT=8787 \
WEB_BRIDGE_MEDIA_WEB_TOKEN='replace-with-a-long-random-token' \
npm run media:web -- --config config/media.json
```

The token can be entered in **诊断与日志 -> WebUI 访问**. The browser stores it in `sessionStorage`, not persistent local storage.

For public deployments, place the service behind HTTPS and an authenticated reverse proxy even when the built-in token is enabled.

## Bilibili QR-code login

Each configured Bilibili account in the overview has a **扫码登录** button. The flow is:

1. Configure a writable `cookieFile` for that Bilibili account in `media.json`.
2. Open the WebUI and click **扫码登录** next to the target account.
3. Scan the QR code with the Bilibili mobile app and confirm the login on the phone.
4. The WebUI polls the BiliTV QR-login endpoint until confirmation.
5. On success, the server atomically writes a biliup-compatible `LoginInfo` JSON credential to that account's `cookieFile`.
6. Subsequent uploads automatically use the credential through `biliup --user-cookie`.

The QR code is normally valid for about three minutes. Expired codes can be refreshed directly in the dialog. Multiple Bilibili accounts are isolated by independent in-memory QR sessions.

Security properties:

- `auth_code`, cookies, access tokens and refresh tokens never leave the server API.
- The browser receives only an opaque random session ID, QR image data and coarse login status.
- QR sessions exist only in memory and expire automatically.
- Credential files are written atomically and set to mode `0600` on Unix.
- The media pipeline and QR login are mutually exclusive so an upload cannot race a credential replacement.
- QR login endpoints use the same WebUI Bearer authentication as all other `/api/*` routes.

Example account configuration:

```json
{
  "bilibili": {
    "accounts": [
      {
        "id": "default",
        "cookieFile": "../secrets/bilibili-default.json",
        "tid": 17,
        "copyright": 2
      }
    ]
  }
}
```

## Features

- Pipeline overview and runtime status.
- YouTube subscription account and Bilibili account overview.
- Per-account Bilibili QR-code login.
- One-shot execution and dry-run execution.
- Start/stop the automatic polling loop.
- Job list with status/search filters.
- Manual requeue for `failed` and `dead` jobs, resetting retry attempts.
- Raw `media.json` editor with server-side validation before atomic replacement.
- Environment doctor for `yt-dlp`, `ffmpeg`, `biliup`, ASR dependencies/API keys, and cookie files.
- Incremental runtime logs.
- Responsive desktop/mobile layout.

## API

When `WEB_BRIDGE_MEDIA_WEB_TOKEN` is set, all `/api/*` routes require:

```text
Authorization: Bearer <token>
```

Available endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/snapshot` | Configuration summary, state, runtime, statistics and log tail |
| `GET` | `/api/logs?after=<id>` | Incremental runtime logs |
| `PUT` | `/api/config` | Validate and atomically save `media.json` |
| `POST` | `/api/run` | Run one discovery/processing cycle; body may contain `{ "dryRun": true }` |
| `POST` | `/api/loop/start` | Start the automatic polling loop |
| `POST` | `/api/loop/stop` | Stop the automatic polling loop |
| `POST` | `/api/doctor` | Run environment checks |
| `POST` | `/api/jobs/requeue` | Requeue a failed/dead task |
| `POST` | `/api/bilibili/qr/start` | Create a QR session for `{ "accountId": "..." }` |
| `GET` | `/api/bilibili/qr/status?sessionId=...` | Poll scan/confirmation status; saves credential on success |
| `POST` | `/api/bilibili/qr/cancel` | Cancel an in-memory QR session |

Configuration writes are rejected while the media pipeline or a QR login is active. Manual requeue is rejected while the media pipeline is running.

## Credentials

Do not put API secrets directly into `media.json`.

- ASR/translation configuration stores the environment variable name, such as `OPENAI_API_KEY`.
- YouTube login state is referenced through `cookiesFile` / `cookiesFromBrowser`.
- Bilibili login state is referenced through an independent JSON credential file and can be created by QR login.
- Real `config/media.json`, cookies, secrets, and `.web-bridge-media/` are ignored by Git.

## Architecture

The dashboard itself still has no frontend build step. QR image encoding uses the small server-side `qrcode` npm package.

```text
public/media/index.html
public/media/style.css
public/media/app.js
public/media/qr-login.js
public/media/qr-login.css
        |
        v
src/media/web.mjs
        |
        +--> bilibili-login.mjs
        +--> config.mjs / state.mjs
        +--> doctorMedia()
        +--> runMediaOnce()
        +--> runMediaLoop()
```

`src/media/pipeline.mjs` accepts an injectable logger. CLI use still defaults to `console`, while the WebUI stores a bounded in-memory log ring for the dashboard.
