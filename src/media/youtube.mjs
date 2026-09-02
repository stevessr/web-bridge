import path from 'node:path';
import { readJson, parseJsonLines, runCommand } from './utils.mjs';

function configPath(config, value) {
  return value ? path.resolve(config.configDir || process.cwd(), value) : '';
}

function authArgs(config, account) {
  const args = [];
  if (account.cookiesFile) args.push('--cookies', configPath(config, account.cookiesFile));
  if (account.cookiesFromBrowser) args.push('--cookies-from-browser', account.cookiesFromBrowser);
  if (account.proxy) args.push('--proxy', account.proxy);
  return args;
}

function baseArgs(config, account) {
  return [
    ...authArgs(config, account),
    ...config.ytDlpArgs,
    ...account.ytDlpArgs
  ];
}

function toEntry(raw, sourceUrl) {
  const id = String(raw.id || '').trim();
  if (!id) return null;
  const webpageUrl = raw.webpage_url || raw.original_url || (raw.url?.startsWith?.('http') ? raw.url : `https://www.youtube.com/watch?v=${id}`);
  return {
    id,
    title: raw.title || id,
    channel: raw.channel || raw.uploader || raw.channel_id || '',
    channelId: raw.channel_id || '',
    duration: Number(raw.duration) || 0,
    timestamp: Number(raw.timestamp) || Number(raw.release_timestamp) || 0,
    liveStatus: raw.live_status || '',
    webpageUrl,
    sourceUrl,
    raw
  };
}

export async function discoverYoutube(config, account, { signal } = {}) {
  const entries = [];
  for (const sourceUrl of account.sourceUrls) {
    const args = [
      ...baseArgs(config, account),
      '--flat-playlist',
      '--playlist-end', String(account.maxItemsPerSource),
      '--dump-json',
      '--no-warnings',
      sourceUrl
    ];
    const { stdout } = await runCommand(config.ytDlpBinary, args, { signal });
    for (const raw of parseJsonLines(stdout)) {
      const entry = toEntry(raw, sourceUrl);
      if (!entry) continue;
      if (entry.liveStatus === 'is_live' || entry.liveStatus === 'is_upcoming') continue;
      entries.push(entry);
    }
  }

  const seen = new Set();
  return entries
    .filter((entry) => !seen.has(entry.id) && seen.add(entry.id))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

export async function downloadYoutubeVideo(config, account, entry, jobDir, { signal } = {}) {
  const args = [
    ...baseArgs(config, account),
    '--no-playlist',
    '--no-warnings',
    '--write-info-json',
    '--merge-output-format', 'mp4',
    '-f', 'bv*+ba/b',
    '--print', 'after_move:filepath',
    '-o', 'source.%(ext)s',
    entry.webpageUrl
  ];
  const { stdout } = await runCommand(config.ytDlpBinary, args, { cwd: jobDir, signal, logOutput: true });
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error('yt-dlp did not report the downloaded file path');
  const reported = lines.at(-1);
  const videoPath = path.isAbsolute(reported) ? reported : path.resolve(jobDir, reported);
  const info = await readJson(path.join(jobDir, 'source.info.json'), null);
  return { videoPath, info };
}

export async function extractAsrAudio(config, videoPath, jobDir, { signal } = {}) {
  const audioPath = path.join(jobDir, 'audio.wav');
  await runCommand(config.ffmpegBinary, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', videoPath,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    audioPath
  ], { signal });
  return audioPath;
}

export async function burnSubtitles(config, videoPath, jobDir, { signal } = {}) {
  const outputPath = path.join(jobDir, 'fansub.mp4');
  await runCommand(config.ffmpegBinary, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', videoPath,
    '-vf', 'subtitles=translated.ass',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    outputPath
  ], { cwd: jobDir, signal, logOutput: true });
  return outputPath;
}
