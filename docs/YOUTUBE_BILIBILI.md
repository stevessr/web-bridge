# YouTube 自动烤肉并投稿 Bilibili

该分支新增一个独立的媒体流水线：

`YouTube 多账号订阅 -> yt-dlp -> ffmpeg -> ASR -> 翻译 -> SRT/ASS -> 烧录字幕 -> biliup 投稿`

它与原有 QQ/Web Bridge 主进程解耦，不会在 `npm start` 时自动启动。

## 依赖

- Node.js >= 22
- `yt-dlp`
- `ffmpeg`（需要 `subtitles/ass` filter，常规完整构建一般已包含）
- `biliup` / `biliup-rs` CLI
- 本地 ASR 时：Python 3 + `faster-whisper`

本地 ASR 安装示例：

```bash
python3 -m pip install faster-whisper
```

## 初始化

```bash
cp config/media.example.json config/media.json
mkdir -p secrets
```

`config/media.json`、cookie、token 等不要提交到 Git。示例配置只包含路径和环境变量名，不保存 API key。

### YouTube 登录态与多账号订阅

每个 `youtubeAccounts[]` 都可以有独立的：

- `cookiesFile`
- `cookiesFromBrowser`
- `sourceUrls`
- `ytDlpArgs`
- 目标 `bilibiliAccount`

`sourceUrls` 默认可以使用 yt-dlp 的 `:ytsubs` 特殊地址，它读取当前登录 YouTube 账号的订阅 feed，因此必须提供 cookies。也可以同时添加频道、播放列表、`/@name/videos` 等 yt-dlp 支持的 URL。

示例：

```json
{
  "id": "youtube-main",
  "sourceUrls": [":ytsubs", "https://www.youtube.com/@example/videos"],
  "cookiesFile": "../secrets/youtube-main.cookies.txt",
  "bilibiliAccount": "default"
}
```

多个 YouTube 账号之间默认按 YouTube video id 全局去重（`dedupeScope: "global"`）。如果同一个视频需要由不同账号分别处理，可改为 `"account"`。

### yt-dlp 自定义参数

全局 `ytDlpArgs` 和每账号 `youtubeAccounts[].ytDlpArgs` 都是 **argv 字符串数组**，不会经过 shell：

```json
{
  "ytDlpArgs": ["--concurrent-fragments", "4"],
  "youtubeAccounts": [
    {
      "id": "main",
      "ytDlpArgs": ["--sleep-requests", "0.5"]
    }
  ]
}
```

默认禁止 `--exec`、`--exec-before-download`、`--plugin-dirs`，因为这些选项能进一步执行命令或加载代码。只有完全信任配置来源时才应启用 `allowUnsafeYtDlpArgs`。

流水线自己固定最终下载输出模板、视频格式选择和 `--no-playlist`，避免自定义参数破坏任务目录和幂等状态。

## ASR

### 本地 faster-whisper

```json
{
  "asr": {
    "backend": "local-faster-whisper",
    "model": "large-v3",
    "language": "auto",
    "pythonBinary": "python3",
    "localScript": "scripts/asr-faster-whisper.py",
    "device": "auto",
    "computeType": "auto"
  }
}
```

音频会由 ffmpeg 转成 16 kHz mono WAV，再交给本地 helper。helper 输出带 segment 时间戳的 JSON。

### OpenAI-compatible ASR API

```json
{
  "asr": {
    "backend": "openai-compatible",
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "model": "gpt-4o-mini-transcribe",
    "language": "auto"
  }
}
```

服务端必须兼容 `/audio/transcriptions`，并在 `verbose_json` 响应中提供 `segments[].start/end/text`。

API key 只通过 `apiKeyEnv` 指定的环境变量读取。

## 翻译

默认使用 OpenAI-compatible `/chat/completions`，按字幕 segment 分批翻译，同时保持原时间轴：

```json
{
  "translation": {
    "backend": "openai-compatible",
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "model": "gpt-4.1-mini",
    "sourceLanguage": "auto",
    "targetLanguage": "zh-CN",
    "batchSegments": 36
  }
}
```

如果只需要 ASR 原文字幕：

```json
{ "translation": { "backend": "none" } }
```

每个任务会生成：

- `transcript.json`
- `translated.json`
- `translated.srt`
- `translated.ass`

默认 `burnSubtitles: true`，通过 ffmpeg 将 ASS 硬字幕烧录为 `fansub.mp4` 后再投稿。关闭后仍会生成字幕文件，但上传的是原视频画面，不会自动把软字幕轨提交到 Bilibili。

## Bilibili 多账号投稿

上传层使用 `biliup` CLI，避免在本项目内复制和维护 Bilibili 易变化的投稿接口实现。

先为每个账号登录并生成独立 cookie 文件，例如：

```bash
biliup --user-cookie secrets/bilibili-default.json login
biliup --user-cookie secrets/bilibili-secondary.json login
```

然后在配置中声明：

```json
{
  "bilibili": {
    "accounts": [
      {
        "id": "default",
        "cookieFile": "../secrets/bilibili-default.json",
        "tid": 17,
        "copyright": 2,
        "tags": ["中字"]
      }
    ]
  }
}
```

每个 YouTube 账号可以通过 `bilibiliAccount` 路由到不同 B 站账号。

`copyright` 默认为 `2`（转载），并自动把原 YouTube URL 填入 `--source`。请只转载你有权转载、获得许可或符合适用授权条款的视频，并遵守 YouTube/Bilibili 的服务条款和版权要求。

## 运行

先检查依赖、cookie 路径和 API key：

```bash
npm run media:doctor -- --config config/media.json
```

只发现并展示计划，不下载/转写/上传：

```bash
npm run media:once -- --config config/media.json --dry-run
```

处理一次：

```bash
npm run media:once -- --config config/media.json
```

常驻轮询：

```bash
npm run media -- --config config/media.json
```

查看状态：

```bash
npm run media:state -- --config config/media.json
```

## 幂等、失败恢复与目录

状态保存在：

```text
<workDir>/state.json
```

任务产物保存在：

```text
<workDir>/jobs/<job-key>/
```

状态包括 `discovered/running/failed/dead/completed`、尝试次数、下一次重试时间和 Bilibili 投稿结果。失败使用指数退避；达到 `maxAttempts` 后进入 `dead`，不会无限重试。

如果进程在 `running` 状态中被强制杀死，该任务不会自动再次执行。需要确认没有完成投稿后，将对应 job 的状态手工改为 `failed` 或 `discovered` 再运行，以避免崩溃边界下重复投稿。

`keepArtifacts: false` 会在成功投稿后删除任务目录，但仍保留 `state.json` 中的完成记录用于去重。

## 运行模型

当前版本刻意采用单任务串行执行：下载、ASR、翻译、视频转码、投稿不会并发跑多个视频。这样可避免本地 GPU/CPU 被多个 Whisper/ffmpeg 任务同时占满，也减少多账号投稿时的限流风险。
