import path from 'node:path';
import { readJson, stringArray } from './utils.mjs';

const DEFAULTS = Object.freeze({
  workDir: '.web-bridge-media',
  pollIntervalSeconds: 600,
  maxItemsPerPoll: 6,
  maxAttempts: 4,
  retryBackoffSeconds: 900,
  dedupeScope: 'global',
  ytDlpBinary: 'yt-dlp',
  ffmpegBinary: 'ffmpeg',
  ytDlpArgs: [],
  allowUnsafeYtDlpArgs: false,
  burnSubtitles: true,
  keepArtifacts: true,
  targetLanguage: 'zh-CN',
  titleTemplate: '【中字】{{title}}',
  descriptionTemplate: '原视频：{{webpageUrl}}\n原作者：{{channel}}\n\n本视频由自动字幕流水线生成，请以原视频内容为准。',
  tags: ['YouTube', '字幕', '搬运'],
  bilibiliAccount: 'default'
});

const UNSAFE_YTDLP_FLAGS = new Set([
  '--exec',
  '--exec-before-download',
  '--plugin-dirs'
]);

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}

function positiveInt(value, name, fallback) {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function optionalString(value, name, fallback = '') {
  if (value == null) return fallback;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

function validateYtDlpArgs(args, allowUnsafe, name) {
  const result = stringArray(args, name);
  if (!allowUnsafe) {
    for (const arg of result) {
      const flag = arg.split('=', 1)[0];
      if (UNSAFE_YTDLP_FLAGS.has(flag)) {
        throw new Error(`${name} contains ${flag}; set allowUnsafeYtDlpArgs=true only for trusted operator-controlled configs`);
      }
    }
  }
  return result;
}

function normalizeYoutubeAccount(account, index, globalAllowUnsafe) {
  assertObject(account, `youtubeAccounts[${index}]`);
  const id = optionalString(account.id, `youtubeAccounts[${index}].id`).trim();
  if (!id) throw new Error(`youtubeAccounts[${index}].id is required`);
  const sourceUrls = account.sourceUrls == null ? [':ytsubs'] : stringArray(account.sourceUrls, `youtubeAccounts[${index}].sourceUrls`);
  if (!sourceUrls.length) throw new Error(`youtubeAccounts[${index}].sourceUrls must not be empty`);
  return Object.freeze({
    id,
    enabled: account.enabled !== false,
    sourceUrls,
    cookiesFile: optionalString(account.cookiesFile, `youtubeAccounts[${index}].cookiesFile`),
    cookiesFromBrowser: optionalString(account.cookiesFromBrowser, `youtubeAccounts[${index}].cookiesFromBrowser`),
    proxy: optionalString(account.proxy, `youtubeAccounts[${index}].proxy`),
    maxItemsPerSource: positiveInt(account.maxItemsPerSource, `youtubeAccounts[${index}].maxItemsPerSource`, 20),
    ytDlpArgs: validateYtDlpArgs(account.ytDlpArgs, globalAllowUnsafe || account.allowUnsafeYtDlpArgs === true, `youtubeAccounts[${index}].ytDlpArgs`),
    bilibiliAccount: optionalString(account.bilibiliAccount, `youtubeAccounts[${index}].bilibiliAccount`),
    tags: stringArray(account.tags, `youtubeAccounts[${index}].tags`)
  });
}

function normalizeAsr(raw = {}) {
  assertObject(raw, 'asr');
  const backend = optionalString(raw.backend, 'asr.backend', 'openai-compatible');
  if (!['openai-compatible', 'local-faster-whisper'].includes(backend)) {
    throw new Error('asr.backend must be openai-compatible or local-faster-whisper');
  }
  return Object.freeze({
    backend,
    baseUrl: optionalString(raw.baseUrl, 'asr.baseUrl', 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKeyEnv: optionalString(raw.apiKeyEnv, 'asr.apiKeyEnv', 'OPENAI_API_KEY'),
    model: optionalString(raw.model, 'asr.model', backend === 'local-faster-whisper' ? 'large-v3' : 'gpt-4o-mini-transcribe'),
    language: optionalString(raw.language, 'asr.language', 'auto'),
    prompt: optionalString(raw.prompt, 'asr.prompt'),
    pythonBinary: optionalString(raw.pythonBinary, 'asr.pythonBinary', 'python3'),
    localScript: optionalString(raw.localScript, 'asr.localScript', 'scripts/asr-faster-whisper.py'),
    device: optionalString(raw.device, 'asr.device', 'auto'),
    computeType: optionalString(raw.computeType, 'asr.computeType', 'auto'),
    extraArgs: stringArray(raw.extraArgs, 'asr.extraArgs')
  });
}

function normalizeTranslation(raw = {}) {
  assertObject(raw, 'translation');
  const backend = optionalString(raw.backend, 'translation.backend', 'openai-compatible');
  if (!['openai-compatible', 'none'].includes(backend)) throw new Error('translation.backend must be openai-compatible or none');
  return Object.freeze({
    backend,
    baseUrl: optionalString(raw.baseUrl, 'translation.baseUrl', 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKeyEnv: optionalString(raw.apiKeyEnv, 'translation.apiKeyEnv', 'OPENAI_API_KEY'),
    model: optionalString(raw.model, 'translation.model', 'gpt-4.1-mini'),
    sourceLanguage: optionalString(raw.sourceLanguage, 'translation.sourceLanguage', 'auto'),
    targetLanguage: optionalString(raw.targetLanguage, 'translation.targetLanguage'),
    systemPrompt: optionalString(raw.systemPrompt, 'translation.systemPrompt', 'You are a professional subtitle translator. Preserve meaning, tone, names, terminology, and concise spoken rhythm. Do not add commentary.'),
    batchSegments: positiveInt(raw.batchSegments, 'translation.batchSegments', 36),
    extraBody: raw.extraBody && typeof raw.extraBody === 'object' && !Array.isArray(raw.extraBody) ? raw.extraBody : {}
  });
}

function normalizeBilibiliAccount(account, index) {
  assertObject(account, `bilibili.accounts[${index}]`);
  const id = optionalString(account.id, `bilibili.accounts[${index}].id`).trim();
  if (!id) throw new Error(`bilibili.accounts[${index}].id is required`);
  const copyright = account.copyright == null ? 2 : Number(account.copyright);
  if (![1, 2].includes(copyright)) throw new Error(`bilibili.accounts[${index}].copyright must be 1 or 2`);
  return Object.freeze({
    id,
    enabled: account.enabled !== false,
    cookieFile: optionalString(account.cookieFile, `bilibili.accounts[${index}].cookieFile`),
    proxy: optionalString(account.proxy, `bilibili.accounts[${index}].proxy`),
    line: optionalString(account.line, `bilibili.accounts[${index}].line`),
    submit: optionalString(account.submit, `bilibili.accounts[${index}].submit`),
    tid: positiveInt(account.tid, `bilibili.accounts[${index}].tid`, 17),
    copyright,
    tags: stringArray(account.tags, `bilibili.accounts[${index}].tags`),
    extraArgs: stringArray(account.extraArgs, `bilibili.accounts[${index}].extraArgs`)
  });
}

function normalizeBilibili(raw = {}) {
  assertObject(raw, 'bilibili');
  const accounts = (raw.accounts || []).map(normalizeBilibiliAccount);
  if (!accounts.length) throw new Error('bilibili.accounts must contain at least one account');
  if (new Set(accounts.map((item) => item.id)).size !== accounts.length) throw new Error('bilibili account ids must be unique');
  return Object.freeze({
    binary: optionalString(raw.binary, 'bilibili.binary', 'biliup'),
    accounts
  });
}

export function normalizeMediaConfig(raw, { configDir = process.cwd() } = {}) {
  assertObject(raw, 'config');
  const merged = { ...DEFAULTS, ...raw };
  const allowUnsafeYtDlpArgs = merged.allowUnsafeYtDlpArgs === true;
  const youtubeAccounts = (merged.youtubeAccounts || []).map((account, index) => normalizeYoutubeAccount(account, index, allowUnsafeYtDlpArgs));
  if (!youtubeAccounts.length) throw new Error('youtubeAccounts must contain at least one account');
  if (new Set(youtubeAccounts.map((item) => item.id)).size !== youtubeAccounts.length) throw new Error('youtube account ids must be unique');
  if (!['global', 'account'].includes(merged.dedupeScope)) throw new Error('dedupeScope must be global or account');

  const config = {
    ...merged,
    configDir: path.resolve(configDir),
    workDir: path.resolve(configDir, optionalString(merged.workDir, 'workDir', DEFAULTS.workDir)),
    pollIntervalSeconds: positiveInt(merged.pollIntervalSeconds, 'pollIntervalSeconds', DEFAULTS.pollIntervalSeconds),
    maxItemsPerPoll: positiveInt(merged.maxItemsPerPoll, 'maxItemsPerPoll', DEFAULTS.maxItemsPerPoll),
    maxAttempts: positiveInt(merged.maxAttempts, 'maxAttempts', DEFAULTS.maxAttempts),
    retryBackoffSeconds: positiveInt(merged.retryBackoffSeconds, 'retryBackoffSeconds', DEFAULTS.retryBackoffSeconds),
    dedupeScope: merged.dedupeScope,
    ytDlpBinary: optionalString(merged.ytDlpBinary, 'ytDlpBinary', DEFAULTS.ytDlpBinary),
    ffmpegBinary: optionalString(merged.ffmpegBinary, 'ffmpegBinary', DEFAULTS.ffmpegBinary),
    ytDlpArgs: validateYtDlpArgs(merged.ytDlpArgs, allowUnsafeYtDlpArgs, 'ytDlpArgs'),
    allowUnsafeYtDlpArgs,
    burnSubtitles: merged.burnSubtitles !== false,
    keepArtifacts: merged.keepArtifacts !== false,
    targetLanguage: optionalString(merged.targetLanguage, 'targetLanguage', DEFAULTS.targetLanguage),
    titleTemplate: optionalString(merged.titleTemplate, 'titleTemplate', DEFAULTS.titleTemplate),
    descriptionTemplate: optionalString(merged.descriptionTemplate, 'descriptionTemplate', DEFAULTS.descriptionTemplate),
    tags: stringArray(merged.tags, 'tags'),
    bilibiliAccount: optionalString(merged.bilibiliAccount, 'bilibiliAccount', DEFAULTS.bilibiliAccount),
    youtubeAccounts,
    asr: normalizeAsr(merged.asr || {}),
    translation: normalizeTranslation(merged.translation || {}),
    bilibili: normalizeBilibili(merged.bilibili || {})
  };

  const enabledBili = new Set(config.bilibili.accounts.filter((item) => item.enabled).map((item) => item.id));
  for (const account of youtubeAccounts.filter((item) => item.enabled)) {
    const target = account.bilibiliAccount || config.bilibiliAccount;
    if (!enabledBili.has(target)) throw new Error(`YouTube account ${account.id} references unknown/disabled Bilibili account ${target}`);
  }
  return Object.freeze(config);
}

export async function loadMediaConfig(file = process.env.WEB_BRIDGE_MEDIA_CONFIG || 'config/media.json') {
  const absolute = path.resolve(file);
  const raw = await readJson(absolute);
  if (!raw) throw new Error(`Media config not found: ${absolute}`);
  return normalizeMediaConfig(raw, { configDir: path.dirname(absolute) });
}
