import { access, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { transcribeAudio } from './asr.mjs';
import { findBilibiliAccount, uploadToBilibili } from './bilibili.mjs';
import { MediaState } from './state.mjs';
import { segmentsToAss, segmentsToSrt } from './subtitles.mjs';
import { translateSegments } from './translate.mjs';
import { ensureDir, envValue, renderTemplate, runCommand, sleep, writeJsonAtomic } from './utils.mjs';
import { burnSubtitles, discoverYoutube, downloadYoutubeVideo, extractAsrAudio } from './youtube.mjs';

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160) || 'job';
}

function unique(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function metadataValues(entry, info, config, youtubeAccount) {
  return {
    videoId: entry.id,
    title: info?.title || entry.title || entry.id,
    channel: info?.channel || info?.uploader || entry.channel || '',
    channelId: info?.channel_id || entry.channelId || '',
    webpageUrl: info?.webpage_url || info?.original_url || entry.webpageUrl,
    description: info?.description || '',
    uploadDate: info?.upload_date || '',
    youtubeAccount: youtubeAccount.id,
    targetLanguage: config.translation.targetLanguage || config.targetLanguage
  };
}

async function processEntry(config, state, youtubeAccount, entry, { signal, dryRun = false, logger = console } = {}) {
  await state.discovered(youtubeAccount.id, entry);
  if (!state.canRun(youtubeAccount.id, entry.id)) return { status: 'skipped', entry };
  if (dryRun) return { status: 'planned', entry, youtubeAccount: youtubeAccount.id };

  const key = state.key(youtubeAccount.id, entry.id);
  const jobDir = path.join(config.workDir, 'jobs', safeName(key));
  await ensureDir(jobDir);
  await state.markRunning(youtubeAccount.id, entry);

  try {
    logger.log(`[media] ${key}: downloading ${entry.webpageUrl}`);
    const downloaded = await downloadYoutubeVideo(config, youtubeAccount, entry, jobDir, { signal });
    const values = metadataValues(entry, downloaded.info, config, youtubeAccount);
    await writeJsonAtomic(path.join(jobDir, 'metadata.json'), { entry, info: downloaded.info, values });

    logger.log(`[media] ${key}: extracting ASR audio`);
    const audioPath = await extractAsrAudio(config, downloaded.videoPath, jobDir, { signal });

    logger.log(`[media] ${key}: transcribing with ${config.asr.backend}`);
    const transcript = await transcribeAudio(config, audioPath, { signal });
    await writeJsonAtomic(path.join(jobDir, 'transcript.json'), transcript.payload);

    logger.log(`[media] ${key}: translating ${transcript.segments.length} segments with ${config.translation.backend}`);
    const translated = await translateSegments(config, transcript.segments, { signal });
    await writeJsonAtomic(path.join(jobDir, 'translated.json'), { segments: translated });
    await writeFile(path.join(jobDir, 'translated.srt'), segmentsToSrt(translated), 'utf8');
    await writeFile(path.join(jobDir, 'translated.ass'), segmentsToAss(translated, { title: values.title }), 'utf8');

    let uploadPath = downloaded.videoPath;
    if (config.burnSubtitles) {
      logger.log(`[media] ${key}: burning subtitles`);
      uploadPath = await burnSubtitles(config, downloaded.videoPath, jobDir, { signal });
    }

    const biliId = youtubeAccount.bilibiliAccount || config.bilibiliAccount;
    const biliAccount = findBilibiliAccount(config, biliId);
    const title = renderTemplate(config.titleTemplate, values);
    const description = renderTemplate(config.descriptionTemplate, values);
    const tags = unique([...config.tags, ...youtubeAccount.tags, ...biliAccount.tags]);

    logger.log(`[media] ${key}: uploading with Bilibili account ${biliId}`);
    const upload = await uploadToBilibili(config, biliAccount, uploadPath, {
      title,
      description,
      tags,
      source: values.webpageUrl
    }, { signal });

    const result = {
      youtubeAccount: youtubeAccount.id,
      bilibiliAccount: biliId,
      title: values.title,
      webpageUrl: values.webpageUrl,
      bvid: upload.bvid,
      aid: upload.aid,
      artifactDir: config.keepArtifacts ? jobDir : null
    };
    await state.markCompleted(youtubeAccount.id, entry.id, result);
    if (!config.keepArtifacts) await rm(jobDir, { recursive: true, force: true });
    logger.log(`[media] ${key}: completed${upload.bvid ? ` as ${upload.bvid}` : ''}`);
    return { status: 'completed', entry, ...result };
  } catch (error) {
    await state.markFailed(youtubeAccount.id, entry.id, error);
    logger.error(`[media] ${key}: failed: ${error.message}`);
    return { status: 'failed', entry, error };
  }
}

function retryCandidates(config, state) {
  const byAccount = new Map(config.youtubeAccounts.map((account) => [account.id, account]));
  const result = [];
  for (const job of Object.values(state.data.jobs)) {
    if (!['failed', 'discovered'].includes(job.status)) continue;
    const account = byAccount.get(job.youtubeAccount);
    if (!account?.enabled || !state.canRun(job.youtubeAccount, job.videoId)) continue;
    result.push({
      account,
      entry: {
        id: job.videoId,
        title: job.title || job.videoId,
        webpageUrl: job.webpageUrl || `https://www.youtube.com/watch?v=${job.videoId}`,
        timestamp: Date.parse(job.discoveredAt || 0) / 1000 || 0
      },
      retry: job.status === 'failed'
    });
  }
  return result;
}

export async function runMediaOnce(config, { signal, dryRun = false, logger = console } = {}) {
  await ensureDir(config.workDir);
  const state = await new MediaState(config).load();
  const candidates = retryCandidates(config, state);
  const candidateKeys = new Set(candidates.map(({ account, entry }) => state.key(account.id, entry.id)));

  for (const account of config.youtubeAccounts.filter((item) => item.enabled)) {
    logger.log(`[media] discovering YouTube account ${account.id}`);
    try {
      const entries = await discoverYoutube(config, account, { signal });
      for (const entry of entries) {
        await state.discovered(account.id, entry);
        const key = state.key(account.id, entry.id);
        if (candidateKeys.has(key) || !state.canRun(account.id, entry.id)) continue;
        candidateKeys.add(key);
        candidates.push({ account, entry, retry: false });
      }
    } catch (error) {
      logger.error(`[media] discovery failed for ${account.id}: ${error.message}`);
    }
  }

  candidates.sort((a, b) => Number(b.retry) - Number(a.retry) || (a.entry.timestamp || 0) - (b.entry.timestamp || 0));
  const selected = candidates.slice(0, config.maxItemsPerPoll);
  const results = [];
  for (const candidate of selected) {
    if (signal?.aborted) break;
    results.push(await processEntry(config, state, candidate.account, candidate.entry, { signal, dryRun, logger }));
  }
  return { discovered: candidates.length, selected: selected.length, results, stateFile: state.file };
}

export async function runMediaLoop(config, { signal, logger = console } = {}) {
  while (!signal?.aborted) {
    await runMediaOnce(config, { signal, logger });
    await sleep(config.pollIntervalSeconds * 1000, signal).catch((error) => {
      if (!signal?.aborted) throw error;
    });
  }
}

async function checkCommand(name, command, args) {
  try {
    const { stdout, stderr } = await runCommand(command, args, { maxOutputBytes: 1024 * 1024 });
    return { name, ok: true, detail: (stdout || stderr).trim().split(/\r?\n/)[0] || 'ok' };
  } catch (error) {
    return { name, ok: false, detail: error.message };
  }
}

async function checkFile(name, file) {
  try {
    await access(file);
    return { name, ok: true, detail: file };
  } catch {
    return { name, ok: false, detail: `not found: ${file}` };
  }
}

export async function doctorMedia(config) {
  const checks = [
    await checkCommand('yt-dlp', config.ytDlpBinary, ['--version']),
    await checkCommand('ffmpeg', config.ffmpegBinary, ['-version']),
    await checkCommand('biliup', config.bilibili.binary, ['--version'])
  ];

  if (config.asr.backend === 'local-faster-whisper') {
    checks.push(await checkCommand('faster-whisper', config.asr.pythonBinary, ['-c', 'import faster_whisper; print(faster_whisper.__version__)']));
  } else {
    checks.push({ name: config.asr.apiKeyEnv, ok: Boolean(envValue(config.asr.apiKeyEnv)), detail: envValue(config.asr.apiKeyEnv) ? 'set' : 'missing' });
  }
  if (config.translation.backend === 'openai-compatible') {
    checks.push({ name: config.translation.apiKeyEnv, ok: Boolean(envValue(config.translation.apiKeyEnv)), detail: envValue(config.translation.apiKeyEnv) ? 'set' : 'missing' });
  }

  for (const account of config.youtubeAccounts.filter((item) => item.enabled)) {
    if (account.sourceUrls.includes(':ytsubs') && !account.cookiesFile && !account.cookiesFromBrowser) {
      checks.push({ name: `youtube:${account.id}`, ok: false, detail: ':ytsubs requires cookiesFile or cookiesFromBrowser' });
    }
    if (account.cookiesFile) checks.push(await checkFile(`youtube-cookie:${account.id}`, path.resolve(config.configDir, account.cookiesFile)));
  }
  for (const account of config.bilibili.accounts.filter((item) => item.enabled && item.cookieFile)) {
    checks.push(await checkFile(`bilibili-cookie:${account.id}`, path.resolve(config.configDir, account.cookieFile)));
  }
  return checks;
}
