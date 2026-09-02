# Media WebUI

The `feat/youtube-auto-fansub-bilibili` branch includes a dependency-free WebUI for the YouTube -> ASR -> translation -> subtitles -> Bilibili pipeline.

## Start

```bash
cp config/media.example.json config/media.json
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

## Features

- Pipeline overview and runtime status.
- YouTube subscription account and Bilibili account overview.
- One-shot execution and dry-run execution.
- Start/stop the automatic polling loop.
- Job list with status/search filters.
- Manual requeue for `failed` and `dead` jobs, resetting retry attempts.
- Raw `media.json` editor with server-side validation before atomic replacement.
- Environment doctor for `yt-dlp`, `ffmpeg`, `biliup`, ASR dependencies/API keys, and cookie files.
- Incremental runtime logs.
- Responsive desktop/mobile layout.

## API

The browser uses the same local management API. When `WEB_BRIDGE_MEDIA_WEB_TOKEN` is set, all `/api/*` routes require:

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

Configuration writes and manual requeue actions are rejected while the media pipeline is running to avoid state/config races.

## Credentials

Do not put API secrets directly into `media.json`.

- ASR/translation configuration stores the **environment variable name**, such as `OPENAI_API_KEY`.
- YouTube login state is referenced through `cookiesFile` / `cookiesFromBrowser`.
- Bilibili login state is referenced through an independent cookie file.
- Real `config/media.json`, cookies, secrets, and `.web-bridge-media/` are ignored by Git.

## Architecture

The WebUI intentionally has no React/Vite/npm frontend build dependency:

```text
public/media/index.html
public/media/style.css
public/media/app.js
        |
        v
src/media/web.mjs
        |
        +--> config.mjs / state.mjs
        +--> doctorMedia()
        +--> runMediaOnce()
        +--> runMediaLoop()
```

`src/media/pipeline.mjs` accepts an injectable logger. CLI use still defaults to `console`, while the WebUI stores a bounded in-memory log ring for the dashboard.
