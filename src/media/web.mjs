#!/usr/bin/env node
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBilibiliQrLoginService, saveBilibiliCredential } from './bilibili-login.mjs';
import { normalizeMediaConfig } from './config.mjs';
import { doctorMedia, runMediaLoop, runMediaOnce } from './pipeline.mjs';
import { MediaState } from './state.mjs';
import { readJson, writeJsonAtomic } from './utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(HERE, '../../public/media');
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_LOGS = 600;

function parseArgs(argv) {
  const result = {
    config: process.env.WEB_BRIDGE_MEDIA_CONFIG || 'config/media.json',
    host: process.env.WEB_BRIDGE_MEDIA_WEB_HOST || '127.0.0.1',
    port: Number(process.env.WEB_BRIDGE_MEDIA_WEB_PORT || 8787),
    token: process.env.WEB_BRIDGE_MEDIA_WEB_TOKEN || ''
  };
  const args = [...argv];
  while (args.length) {
    const arg = args.shift();
    if (arg === '--config' || arg === '-c') result.config = args.shift() || '';
    else if (arg === '--host') result.host = args.shift() || '';
    else if (arg === '--port') result.port = Number(args.shift());
    else if (arg === '--token') result.token = args.shift() || '';
    else if (arg === '--help' || arg === '-h') result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.config) throw new Error('--config requires a path');
  if (!result.host) throw new Error('--host requires a value');
  if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535) throw new Error('--port must be an integer from 1 to 65535');
  return result;
}

function isLoopback(host) {
  const value = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return value === '127.0.0.1' || value === '::1' || value === 'localhost';
}

function usage() {
  console.log(`web-bridge media WebUI\n\nUsage:\n  node src/media/web.mjs [--config FILE] [--host HOST] [--port PORT] [--token TOKEN]\n\nEnvironment:\n  WEB_BRIDGE_MEDIA_CONFIG\n  WEB_BRIDGE_MEDIA_WEB_HOST     default: 127.0.0.1\n  WEB_BRIDGE_MEDIA_WEB_PORT     default: 8787\n  WEB_BRIDGE_MEDIA_WEB_TOKEN    required for non-loopback binds\n`);
}

function json(res, status, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(body);
}

function errorJson(res, status, error) {
  json(res, status, { error: error?.message || String(error) });
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(req, token) {
  if (!token) return true;
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') && secureEqual(header.slice(7), token);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON');
    error.statusCode = 400;
    throw error;
  }
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function publicConfig(config) {
  if (!config) return null;
  return {
    workDir: config.workDir,
    pollIntervalSeconds: config.pollIntervalSeconds,
    maxItemsPerPoll: config.maxItemsPerPoll,
    maxAttempts: config.maxAttempts,
    retryBackoffSeconds: config.retryBackoffSeconds,
    dedupeScope: config.dedupeScope,
    burnSubtitles: config.burnSubtitles,
    keepArtifacts: config.keepArtifacts,
    targetLanguage: config.targetLanguage,
    youtubeAccounts: config.youtubeAccounts.map((account) => ({
      id: account.id,
      enabled: account.enabled,
      sourceUrls: account.sourceUrls,
      bilibiliAccount: account.bilibiliAccount || config.bilibiliAccount
    })),
    asr: { backend: config.asr.backend, model: config.asr.model },
    translation: { backend: config.translation.backend, model: config.translation.model, targetLanguage: config.translation.targetLanguage || config.targetLanguage },
    bilibiliAccounts: await Promise.all(config.bilibili.accounts.map(async (account) => ({
      id: account.id,
      enabled: account.enabled,
      credentialConfigured: Boolean(account.cookieFile),
      credentialPresent: Boolean(account.cookieFile) && await exists(path.resolve(config.configDir, account.cookieFile))
    })))
  };
}

function summarizeJobs(state) {
  const jobs = Object.values(state?.jobs || {});
  const counts = { total: jobs.length, discovered: 0, running: 0, completed: 0, failed: 0, dead: 0 };
  for (const job of jobs) if (Object.hasOwn(counts, job.status)) counts[job.status] += 1;
  return counts;
}

async function serveStatic(res, pathname) {
  const mapping = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/app.js': 'app.js',
    '/style.css': 'style.css',
    '/qr-login.js': 'qr-login.js',
    '/qr-login.css': 'qr-login.css'
  };
  const file = mapping[pathname];
  if (!file) return false;
  const body = await readFile(path.join(STATIC_DIR, file));
  const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8';
  res.writeHead(200, {
    'content-type': type,
    'content-length': body.length,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"
  });
  res.end(body);
  return true;
}

export function createMediaWebApp({ configFile, token = '', bilibiliLogin = createBilibiliQrLoginService() }) {
  const absoluteConfig = path.resolve(configFile);
  const configDir = path.dirname(absoluteConfig);
  const logs = [];
  const qrSessions = new Map();
  let runPromise = null;
  let loopPromise = null;
  let loopController = null;
  let lastRun = null;

  const addLog = (level, message) => {
    logs.push({ id: Date.now() + Math.random(), at: new Date().toISOString(), level, message: String(message) });
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
  };
  const logger = {
    log: (...args) => addLog('info', args.map(String).join(' ')),
    error: (...args) => addLog('error', args.map(String).join(' ')),
    warn: (...args) => addLog('warn', args.map(String).join(' '))
  };

  async function loadRawAndConfig() {
    const raw = await readJson(absoluteConfig, null);
    if (!raw) return { raw: null, config: null, configError: `Media config not found: ${absoluteConfig}` };
    try { return { raw, config: normalizeMediaConfig(raw, { configDir }), configError: null }; }
    catch (error) { return { raw, config: null, configError: error.message }; }
  }

  async function loadState(config) {
    if (!config) return { version: 1, jobs: {} };
    return (await new MediaState(config).load()).data;
  }

  function cleanupQrSessions() {
    const now = Date.now();
    for (const [id, session] of qrSessions) if (Date.parse(session.expiresAt) <= now) qrSessions.delete(id);
  }

  function hasActiveQrSessions() {
    cleanupQrSessions();
    return qrSessions.size > 0;
  }

  function runtime() {
    cleanupQrSessions();
    return {
      busy: Boolean(runPromise || loopPromise),
      mode: loopPromise ? 'loop' : runPromise ? 'once' : 'idle',
      loopRunning: Boolean(loopPromise),
      qrLogins: qrSessions.size,
      lastRun
    };
  }

  function assertPipelineCanStart() {
    if (runPromise || loopPromise) {
      const error = new Error('Media pipeline is already running');
      error.statusCode = 409;
      throw error;
    }
    if (hasActiveQrSessions()) {
      const error = new Error('Finish or cancel the active Bilibili QR login before starting the pipeline');
      error.statusCode = 409;
      throw error;
    }
  }

  async function runOnce({ dryRun = false } = {}) {
    assertPipelineCanStart();
    const { config, configError } = await loadRawAndConfig();
    if (!config) { const error = new Error(configError); error.statusCode = 400; throw error; }
    const controller = new AbortController();
    const startedAt = new Date().toISOString();
    addLog('info', `[web] starting ${dryRun ? 'dry-run' : 'one-shot'} pipeline`);
    runPromise = runMediaOnce(config, { signal: controller.signal, dryRun, logger });
    try {
      const result = await runPromise;
      lastRun = { startedAt, finishedAt: new Date().toISOString(), dryRun, ok: true, discovered: result.discovered, selected: result.selected };
      addLog('info', `[web] one-shot finished: ${result.selected}/${result.discovered} selected`);
      return result;
    } catch (error) {
      lastRun = { startedAt, finishedAt: new Date().toISOString(), dryRun, ok: false, error: error.message };
      addLog('error', `[web] one-shot failed: ${error.message}`);
      throw error;
    } finally { runPromise = null; }
  }

  async function startLoop() {
    assertPipelineCanStart();
    const { config, configError } = await loadRawAndConfig();
    if (!config) { const error = new Error(configError); error.statusCode = 400; throw error; }
    loopController = new AbortController();
    const controller = loopController;
    const startedAt = new Date().toISOString();
    addLog('info', `[web] automatic loop started; interval=${config.pollIntervalSeconds}s`);
    loopPromise = runMediaLoop(config, { signal: controller.signal, logger })
      .then(() => { lastRun = { startedAt, finishedAt: new Date().toISOString(), loop: true, ok: true }; })
      .catch((error) => {
        if (!controller.signal.aborted) {
          lastRun = { startedAt, finishedAt: new Date().toISOString(), loop: true, ok: false, error: error.message };
          addLog('error', `[web] automatic loop failed: ${error.message}`);
        }
      })
      .finally(() => {
        addLog('info', '[web] automatic loop stopped');
        loopPromise = null;
        if (loopController === controller) loopController = null;
      });
    return { started: true, intervalSeconds: config.pollIntervalSeconds };
  }

  function stopLoop() {
    if (!loopController || !loopPromise) return { stopped: false, reason: 'loop is not running' };
    addLog('warn', '[web] stopping automatic loop');
    loopController.abort(new Error('Stopped from WebUI'));
    return { stopped: true };
  }

  async function startQrLogin(accountId) {
    if (runPromise || loopPromise) {
      const error = new Error('Stop the media pipeline before logging in to Bilibili');
      error.statusCode = 409;
      throw error;
    }
    const { config, configError } = await loadRawAndConfig();
    if (!config) { const error = new Error(configError); error.statusCode = 400; throw error; }
    const account = config.bilibili.accounts.find((item) => item.id === accountId);
    if (!account) { const error = new Error(`Unknown Bilibili account: ${accountId}`); error.statusCode = 404; throw error; }
    if (!account.cookieFile) {
      const error = new Error(`Bilibili account ${accountId} must configure cookieFile before QR login`);
      error.statusCode = 400;
      throw error;
    }
    cleanupQrSessions();
    for (const [id, session] of qrSessions) if (session.accountId === accountId) qrSessions.delete(id);
    const started = await bilibiliLogin.start();
    const sessionId = randomBytes(24).toString('base64url');
    qrSessions.set(sessionId, {
      accountId,
      authCode: started.authCode,
      pollTs: started.pollTs,
      expiresAt: started.expiresAt
    });
    addLog('info', `[web] Bilibili QR login started for account ${accountId}`);
    return { sessionId, accountId, qrDataUrl: started.qrDataUrl, expiresAt: started.expiresAt };
  }

  async function pollQrLogin(sessionId) {
    cleanupQrSessions();
    const session = qrSessions.get(sessionId);
    if (!session) {
      const error = new Error('Bilibili QR login session expired or does not exist');
      error.statusCode = 410;
      throw error;
    }
    const result = await bilibiliLogin.poll(session);
    if (result.status === 'expired') {
      qrSessions.delete(sessionId);
      addLog('warn', `[web] Bilibili QR login expired for account ${session.accountId}`);
      return { status: 'expired', accountId: session.accountId };
    }
    if (result.status !== 'success') return { status: result.status, accountId: session.accountId, expiresAt: session.expiresAt };

    const { config, configError } = await loadRawAndConfig();
    if (!config) { const error = new Error(configError); error.statusCode = 400; throw error; }
    const account = config.bilibili.accounts.find((item) => item.id === session.accountId);
    if (!account?.cookieFile) {
      const error = new Error(`Bilibili account ${session.accountId} no longer has cookieFile configured`);
      error.statusCode = 409;
      throw error;
    }
    await saveBilibiliCredential(path.resolve(config.configDir, account.cookieFile), result.credential);
    qrSessions.delete(sessionId);
    addLog('info', `[web] Bilibili QR login completed for account ${session.accountId}`);
    return { status: 'success', accountId: session.accountId, credentialSaved: true, mid: result.mid };
  }

  function cancelQrLogin(sessionId) {
    const session = qrSessions.get(sessionId);
    if (!session) return { cancelled: false };
    qrSessions.delete(sessionId);
    addLog('info', `[web] Bilibili QR login cancelled for account ${session.accountId}`);
    return { cancelled: true, accountId: session.accountId };
  }

  async function handler(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
        if (await serveStatic(res, url.pathname)) return;
        return json(res, 404, { error: 'Not found' });
      }
      if (!authorized(req, token)) {
        res.setHeader('www-authenticate', 'Bearer');
        return json(res, 401, { error: 'Unauthorized' });
      }

      if (req.method === 'GET' && url.pathname === '/api/snapshot') {
        const { raw, config, configError } = await loadRawAndConfig();
        const state = await loadState(config);
        return json(res, 200, {
          configFile: absoluteConfig,
          config: await publicConfig(config),
          rawConfig: raw,
          configError,
          state,
          stats: summarizeJobs(state),
          runtime: runtime(),
          logTail: logs.slice(-80)
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/logs') {
        const after = Number(url.searchParams.get('after') || 0);
        return json(res, 200, { logs: after ? logs.filter((entry) => entry.id > after) : logs.slice(-200), runtime: runtime() });
      }
      if (req.method === 'PUT' && url.pathname === '/api/config') {
        if (runPromise || loopPromise || hasActiveQrSessions()) return json(res, 409, { error: 'Stop the pipeline and QR login before changing configuration' });
        const raw = await readBody(req);
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return json(res, 400, { error: 'Configuration must be a JSON object' });
        normalizeMediaConfig(raw, { configDir });
        await writeJsonAtomic(absoluteConfig, raw);
        addLog('info', '[web] configuration saved');
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/run') {
        const body = await readBody(req) || {};
        const result = await runOnce({ dryRun: body.dryRun === true });
        const cleanResults = result.results.map(({ error, ...item }) => error ? { ...item, error: error.message } : item);
        return json(res, 200, { ...result, results: cleanResults });
      }
      if (req.method === 'POST' && url.pathname === '/api/loop/start') return json(res, 202, await startLoop());
      if (req.method === 'POST' && url.pathname === '/api/loop/stop') return json(res, 200, stopLoop());
      if (req.method === 'POST' && url.pathname === '/api/doctor') {
        const { config, configError } = await loadRawAndConfig();
        if (!config) return json(res, 400, { error: configError });
        const checks = await doctorMedia(config);
        addLog(checks.every((item) => item.ok) ? 'info' : 'warn', `[web] doctor finished: ${checks.filter((item) => item.ok).length}/${checks.length} checks passed`);
        return json(res, 200, { checks, ok: checks.every((item) => item.ok) });
      }
      if (req.method === 'POST' && url.pathname === '/api/jobs/requeue') {
        if (runPromise || loopPromise) return json(res, 409, { error: 'Stop the media pipeline before requeueing jobs' });
        const body = await readBody(req) || {};
        if (typeof body.key !== 'string' || !body.key) return json(res, 400, { error: 'key is required' });
        const { config, configError } = await loadRawAndConfig();
        if (!config) return json(res, 400, { error: configError });
        const state = await new MediaState(config).load();
        const job = await state.requeue(body.key, { resetAttempts: body.resetAttempts !== false });
        addLog('info', `[web] requeued ${body.key}`);
        return json(res, 200, { job });
      }
      if (req.method === 'POST' && url.pathname === '/api/bilibili/qr/start') {
        const body = await readBody(req) || {};
        if (typeof body.accountId !== 'string' || !body.accountId) return json(res, 400, { error: 'accountId is required' });
        return json(res, 201, await startQrLogin(body.accountId));
      }
      if (req.method === 'GET' && url.pathname === '/api/bilibili/qr/status') {
        const sessionId = url.searchParams.get('sessionId') || '';
        if (!sessionId) return json(res, 400, { error: 'sessionId is required' });
        return json(res, 200, await pollQrLogin(sessionId));
      }
      if (req.method === 'POST' && url.pathname === '/api/bilibili/qr/cancel') {
        const body = await readBody(req) || {};
        if (typeof body.sessionId !== 'string' || !body.sessionId) return json(res, 400, { error: 'sessionId is required' });
        return json(res, 200, cancelQrLogin(body.sessionId));
      }
      return json(res, 404, { error: 'API route not found' });
    } catch (error) {
      addLog('error', `[web] ${req.method} ${req.url}: ${error.message}`);
      return errorJson(res, error.statusCode || 500, error);
    }
  }

  return { handler, runtime, logs, qrSessions };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  if (!isLoopback(args.host) && !args.token) throw new Error('Refusing non-loopback media WebUI bind without WEB_BRIDGE_MEDIA_WEB_TOKEN or --token');
  const app = createMediaWebApp({ configFile: args.config, token: args.token });
  const server = createServer(app.handler);
  server.listen(args.port, args.host, () => {
    console.log(`[media-web] http://${args.host}:${args.port}/`);
    console.log(`[media-web] config: ${path.resolve(args.config)}`);
    if (args.token) console.log('[media-web] API bearer authentication enabled');
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
