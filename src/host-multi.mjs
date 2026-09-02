import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { CdpConnection, listTargets } from './cdp.mjs';
import { INJECTED_BRIDGE_SOURCE } from './injected.mjs';
import { challenge, isAuthorized, originAllowed } from './auth.mjs';
import { loadConfig } from './config.mjs';
import { parseClientMessage, TokenBucket } from './protocol.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const config = loadConfig();

const clients = new Map();
const screens = new Map();
const controllerByScreen = new Map();
const resourceByToken = new Map();
const tokenByResource = new Map();
const uploadByToken = new Map();
const metrics = {
  startedAt: Date.now(), snapshots: 0, patchBatches: 0, patches: 0, inputEvents: 0,
  droppedMessages: 0, resourcesServed: 0, resourceBytes: 0, wsConnections: 0,
  cdpReconnects: 0, resyncs: 0, uploads: 0, uploadBytes: 0, screenSwitches: 0
};

let shuttingDown = false;
let discoveryLoopRunning = false;
let resourceCacheBytes = 0;
let lastDiscoveryError = '';
let lastDiscoveryErrorAt = 0;

function log(level, message, fields = {}) {
  const record = { time: new Date().toISOString(), level, message, ...fields };
  const writer = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  writer(JSON.stringify(record));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers
  });
  res.end(data);
}

function securityHeaders() {
  return {
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()',
    'cross-origin-opener-policy': 'same-origin'
  };
}

function contentType(path) {
  switch (extname(path)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    default: return 'application/octet-stream';
  }
}

function mimeFromUrl(url) {
  const clean = String(url).split(/[?#]/, 1)[0].toLowerCase();
  if (clean.endsWith('.png')) return 'image/png';
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
  if (clean.endsWith('.gif')) return 'image/gif';
  if (clean.endsWith('.webp')) return 'image/webp';
  if (clean.endsWith('.avif')) return 'image/avif';
  if (clean.endsWith('.svg')) return 'image/svg+xml';
  if (clean.endsWith('.woff2')) return 'font/woff2';
  if (clean.endsWith('.woff')) return 'font/woff';
  if (clean.endsWith('.ttf')) return 'font/ttf';
  if (clean.endsWith('.css')) return 'text/css';
  return 'application/octet-stream';
}

function screenIdFor(candidate) {
  const nativeId = String(candidate?.id || '');
  if (/^[A-Za-z0-9._:-]{1,128}$/.test(nativeId)) return nativeId;
  const encoded = Buffer.from(String(candidate?.webSocketDebuggerUrl || candidate?.url || candidate?.title || randomBytes(8).toString('hex'))).toString('base64url');
  return `screen-${encoded.slice(0, 64)}`;
}

function targetScore(candidate, matcher = config.targetMatch) {
  if (candidate?.type !== 'page' || !candidate.webSocketDebuggerUrl) return -10000;
  const haystack = `${candidate.title || ''} ${candidate.url || ''}`;
  let score = 0;
  if (/\#\/main\/(message|contact|setting)|\#\/main\b/i.test(candidate.url || '')) score += 5000;
  if (candidate.focused) score += 1800;
  if (candidate.visible) score += 1200;
  if (candidate.kind === 'window') score += 400;
  else if (['browserView', 'webview', 'offscreen'].includes(candidate.kind)) score += 100;
  if (/qq|tencent/i.test(haystack)) score += 200;
  if (candidate.url?.startsWith('file:') || candidate.url?.startsWith('app:')) score += 50;
  if (/devtools|chrome-extension|background/i.test(haystack)) score -= 5000;
  if (/hiddenWindow|hiddenPoolBaseWin|chatPoolWin=1|GuildMainWebview|\#\/blank|about:blank/i.test(haystack)) score -= 4000;
  if (matcher) {
    try { score += new RegExp(matcher, 'i').test(haystack) ? 10000 : -10000; } catch { score -= 10000; }
  }
  return score;
}

function isScreenCandidate(candidate) {
  if (!candidate || candidate.type !== 'page' || !candidate.webSocketDebuggerUrl) return false;
  const haystack = `${candidate.title || ''} ${candidate.url || ''}`;
  if (/devtools|chrome-extension|background|hiddenWindow|hiddenPoolBaseWin|chatPoolWin=1|GuildMainWebview|\#\/blank|about:blank/i.test(haystack)) return false;
  if (candidate.kind === 'devTools') return false;
  if (candidate.kind && !['window', 'browserView', 'webview', 'offscreen'].includes(candidate.kind)) return false;
  const main = /\#\/main(?:\/|\b)/i.test(candidate.url || '');
  if (candidate.visible === false && !main) return false;
  return targetScore(candidate) > -10000;
}

function screenLabel(target, id) {
  const url = String(target?.url || '');
  const title = String(target?.title || '').trim();
  if (/\#\/main\/message/i.test(url)) return 'QQ 主窗口';
  if (/\#\/main\/contact/i.test(url)) return 'QQ 联系人';
  if (/\#\/main\/setting/i.test(url)) return 'QQ 设置';
  if (/\#\/main(?:\/|\b)/i.test(url)) return 'QQ 主窗口';
  if (/\#\/chat/i.test(url)) return 'QQ 聊天窗口';
  if (title && title !== url && !/^(app|file):\/\//i.test(title)) return title.slice(0, 80);
  return `QQ Screen ${id}`;
}

function createSession(target) {
  const id = screenIdFor(target);
  return {
    id,
    target,
    cdp: null,
    connecting: false,
    revision: 0,
    latestSnapshot: null,
    dirty: true,
    patchTimer: null,
    patchInFlight: false,
    patchPending: false,
    syncChain: Promise.resolve(),
    lastSeenAt: Date.now(),
    missingSince: 0,
    lastAttachError: '',
    lastAttachErrorAt: 0
  };
}

function sortedSessions() {
  return [...screens.values()].sort((a, b) => targetScore(b.target) - targetScore(a.target) || a.id.localeCompare(b.id));
}

function publicScreen(session) {
  return {
    id: session.id,
    label: screenLabel(session.target, session.id),
    title: session.target?.title || screenLabel(session.target, session.id),
    kind: session.target?.kind || 'page',
    visible: Boolean(session.target?.visible),
    focused: Boolean(session.target?.focused),
    ready: Boolean(session.cdp),
    revision: session.revision
  };
}

function publicScreens() {
  return sortedSessions().map(publicScreen);
}

function preferredSession() {
  const ordered = sortedSessions();
  return ordered.find((session) => session.cdp) || ordered[0] || null;
}

function resolveActiveSession(state) {
  if (!state) return preferredSession();
  if (state.activeScreenId && screens.has(state.activeScreenId)) return screens.get(state.activeScreenId);
  if (state.requestedScreenId && screens.has(state.requestedScreenId)) {
    state.activeScreenId = state.requestedScreenId;
    state.requestedScreenId = null;
    return screens.get(state.activeScreenId);
  }
  const preferred = preferredSession();
  state.activeScreenId = preferred?.id || null;
  return preferred;
}

function readyScreenCount() {
  let count = 0;
  for (const session of screens.values()) if (session.cdp) count += 1;
  return count;
}

function hasSubscribers(screenId) {
  for (const state of clients.values()) {
    if (state.activeScreenId === screenId && state.ws.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

function controllerIdFor(screenId) {
  if (!screenId || config.allowMultipleControllers) return null;
  return controllerByScreen.get(screenId) || null;
}

function controlActivity(state, screenId) {
  return state?.controlActivity?.get(screenId) || 0;
}

function claimControl(state, screenId = state?.activeScreenId) {
  if (!state || !screenId || !screens.has(screenId)) return false;
  if (config.allowMultipleControllers) return true;
  const currentId = controllerByScreen.get(screenId);
  const current = currentId ? clients.get(currentId) : null;
  if (!current || current.ws.readyState !== WebSocket.OPEN || Date.now() - controlActivity(current, screenId) > config.controlLeaseMs) {
    state.controlActivity.set(screenId, Date.now());
    controllerByScreen.set(screenId, state.id);
    return true;
  }
  return currentId === state.id;
}

function canControl(state, screenId = state?.activeScreenId) {
  return Boolean(screenId) && (config.allowMultipleControllers || controllerByScreen.get(screenId) === state?.id);
}

function releaseControllerForScreen(clientId, screenId, { reassign = true } = {}) {
  if (!screenId || config.allowMultipleControllers || controllerByScreen.get(screenId) !== clientId) return;
  controllerByScreen.delete(screenId);
  if (!reassign) return;
  const next = [...clients.values()].find((state) => state.id !== clientId && state.activeScreenId === screenId && state.ws.readyState === WebSocket.OPEN);
  if (next) {
    next.controlActivity.set(screenId, Date.now());
    controllerByScreen.set(screenId, next.id);
  }
}

function releaseClientControls(clientId) {
  for (const [screenId, owner] of [...controllerByScreen.entries()]) {
    if (owner === clientId) releaseControllerForScreen(clientId, screenId);
  }
}

function statusMessage(state) {
  const session = resolveActiveSession(state);
  const screenId = session?.id || null;
  return {
    type: 'status',
    attached: Boolean(session?.cdp),
    revision: session?.revision || 0,
    instanceId: config.instanceId,
    target: session ? { id: session.id, title: screenLabel(session.target, session.id), kind: session.target?.kind || 'page' } : null,
    screens: publicScreens(),
    activeScreenId: screenId,
    screenCount: screens.size,
    readyScreens: readyScreenCount(),
    controllerId: controllerIdFor(screenId),
    clients: clients.size,
    control: screenId && (config.allowMultipleControllers || controllerByScreen.get(screenId) === state?.id) ? 'granted' : 'readonly'
  };
}

function send(state, message, { force = false } = {}) {
  if (!state || state.ws.readyState !== WebSocket.OPEN) return false;
  const payload = typeof message === 'string' ? message : JSON.stringify(message);
  if (!force && state.ws.bufferedAmount > config.maxBufferedBytes) {
    state.needsResync = true;
    state.needsResyncScreenId = message?.screenId || state.activeScreenId || null;
    metrics.droppedMessages += 1;
    return false;
  }
  state.ws.send(payload);
  return true;
}

function broadcast(message, options) {
  for (const state of clients.values()) send(state, message, options);
}

function broadcastToScreen(screenId, message, options) {
  for (const state of clients.values()) {
    if (state.activeScreenId === screenId) send(state, message, options);
  }
}

function sendStatus(state) {
  send(state, statusMessage(state), { force: true });
}

function broadcastStatus() {
  for (const state of clients.values()) sendStatus(state);
}

function registerResource(url, screenId) {
  if (!url || typeof url !== 'string') return url;
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('data:') || trimmed.startsWith('/resource/')) return url;
  const key = `${screenId || ''}\n${trimmed}`;
  let token = tokenByResource.get(key);
  if (!token) {
    token = randomBytes(24).toString('base64url');
    tokenByResource.set(key, token);
    resourceByToken.set(token, { key, screenId, url: trimmed, buffer: null, mime: null, size: 0, createdAt: Date.now(), lastAccess: Date.now() });
  }
  return `/resource/${token}`;
}

function rewriteCssUrls(value, screenId) {
  if (!value || typeof value !== 'string' || !value.includes('url(')) return value;
  return value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_match, _quote, url) => `url("${registerResource(url, screenId)}")`);
}

function rewriteNodeResources(node, screenId) {
  if (!node || node.type !== 'element') return;
  for (const name of ['src', 'poster', 'xlink:href']) if (node.attrs?.[name]) node.attrs[name] = registerResource(node.attrs[name], screenId);
  if (node.tag === 'use' || node.tag === 'image') {
    if (node.attrs?.href) node.attrs.href = registerResource(node.attrs.href, screenId);
  } else if (node.attrs?.href && !node.attrs.href.startsWith('#')) node.attrs.href = '#';
  if (node.style) for (const [key, value] of Object.entries(node.style)) node.style[key] = rewriteCssUrls(value, screenId);
  for (const child of node.children ?? []) rewriteNodeResources(child, screenId);
  for (const child of node.shadow ?? []) rewriteNodeResources(child, screenId);
}

function rewritePatchResources(patch, screenId) {
  if (patch.op === 'children') {
    for (const child of patch.children ?? []) rewriteNodeResources(child, screenId);
    for (const child of patch.shadow ?? []) rewriteNodeResources(child, screenId);
  } else if (patch.op === 'update') {
    for (const name of ['src', 'poster', 'xlink:href']) if (patch.attrs?.[name]) patch.attrs[name] = registerResource(patch.attrs[name], screenId);
    if (patch.attrs?.href && !patch.attrs.href.startsWith('#')) patch.attrs.href = '#';
    if (patch.style) for (const [key, value] of Object.entries(patch.style)) patch.style[key] = rewriteCssUrls(value, screenId);
    for (const child of patch.shadow ?? []) rewriteNodeResources(child, screenId);
  }
}

function pruneResourceTokens() {
  const cutoff = Date.now() - config.resourceTokenTtlMs;
  for (const [token, entry] of resourceByToken) {
    if (entry.lastAccess >= cutoff) continue;
    if (entry.buffer) resourceCacheBytes -= entry.size;
    resourceByToken.delete(token);
    tokenByResource.delete(entry.key);
  }
  if (resourceCacheBytes <= config.resourceCacheBytes) return;
  const cached = [...resourceByToken.entries()].filter(([, entry]) => entry.buffer).sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  for (const [, entry] of cached) {
    if (resourceCacheBytes <= config.resourceCacheBytes) break;
    resourceCacheBytes -= entry.size;
    entry.buffer = null;
    entry.size = 0;
  }
}

async function getResourceTreeEntry(session, url) {
  if (!session?.cdp) return null;
  try {
    const tree = await session.cdp.call('Page.getResourceTree');
    const walk = (frameTree) => {
      for (const resource of frameTree.resources ?? []) if (resource.url === url) return { frameId: frameTree.frame.id, resource };
      for (const child of frameTree.childFrames ?? []) { const found = walk(child); if (found) return found; }
      return null;
    };
    return walk(tree.frameTree);
  } catch { return null; }
}

async function loadResource(entry) {
  entry.lastAccess = Date.now();
  if (entry.buffer) return entry;
  if (entry.loading) return entry.loading;
  entry.loading = (async () => {
    const session = screens.get(entry.screenId);
    if (!session?.cdp) throw new Error('QQ screen is not attached');
    const treeEntry = await getResourceTreeEntry(session, entry.url);
    if (treeEntry) {
      try {
        const content = await session.cdp.call('Page.getResourceContent', { frameId: treeEntry.frameId, url: entry.url });
        const buffer = content.base64Encoded ? Buffer.from(content.content, 'base64') : Buffer.from(content.content);
        if (buffer.length > config.maxResourceBytes) throw new Error('resource-too-large');
        entry.buffer = buffer; entry.size = buffer.length;
        entry.mime = treeEntry.resource.mimeType || mimeFromUrl(entry.url);
        resourceCacheBytes += entry.size; pruneResourceTokens();
        return entry;
      } catch (error) {
        if (error.message === 'resource-too-large') throw error;
      }
    }
    const result = await session.cdp.call('Runtime.evaluate', {
      expression: `globalThis.__WEB_BRIDGE__?.fetchResource(${JSON.stringify(entry.url)},${config.maxResourceBytes})`,
      awaitPromise: true, returnByValue: true
    });
    const value = result.result?.value;
    if (!value?.base64) throw new Error('resource is not fetchable from QQ renderer');
    const buffer = Buffer.from(value.base64, 'base64');
    if (buffer.length > config.maxResourceBytes) throw new Error('resource-too-large');
    entry.buffer = buffer; entry.size = buffer.length;
    entry.mime = value.mime || mimeFromUrl(entry.url);
    resourceCacheBytes += entry.size; pruneResourceTokens();
    return entry;
  })();
  try { return await entry.loading; } finally { entry.loading = null; }
}

function sendResource(req, res, resource) {
  const size = resource.buffer.length;
  const range = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
  const common = { 'content-type': resource.mime || 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' };
  if (range) {
    let start = range[1] ? Number(range[1]) : null;
    let end = range[2] ? Number(range[2]) : null;
    if (start == null && end != null) { start = Math.max(0, size - end); end = size - 1; }
    else { start = start ?? 0; end = Math.min(size - 1, end ?? size - 1); }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) {
      res.writeHead(416, { 'content-range': `bytes */${size}`, ...common }); res.end(); return;
    }
    const chunk = resource.buffer.subarray(start, end + 1);
    res.writeHead(206, { ...common, 'content-length': chunk.length, 'content-range': `bytes ${start}-${end}/${size}` });
    if (req.method === 'HEAD') res.end(); else res.end(chunk);
    return;
  }
  res.writeHead(200, { ...common, 'content-length': size });
  if (req.method === 'HEAD') res.end(); else res.end(resource.buffer);
}

function safeUploadName(value) {
  const name = basename(String(value || 'upload.bin')).replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 240);
  return name || 'upload.bin';
}

async function receiveUpload(req, url, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
  const nodeId = Math.trunc(Number(url.searchParams.get('nodeId')));
  if (!Number.isInteger(nodeId) || nodeId < 1) return json(res, 400, { error: 'invalid nodeId' });
  const requestedScreenId = String(url.searchParams.get('screenId') || '');
  const session = screens.get(requestedScreenId) || preferredSession();
  if (!session?.cdp) return json(res, 409, { error: 'screen unavailable' });
  const declared = Number(req.headers['content-length'] || 0);
  if (declared && declared > config.maxUploadBytes) return json(res, 413, { error: 'upload too large' });
  const dir = await mkdtemp(join(tmpdir(), 'web-bridge-upload-'));
  const path = join(dir, safeUploadName(url.searchParams.get('name')));
  const output = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  let bytes = 0;
  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > config.maxUploadBytes) throw new Error('upload-too-large');
      if (!output.write(chunk)) await once(output, 'drain');
    }
    const finished = once(output, 'finish');
    output.end();
    await finished;
  } catch (error) {
    output.destroy();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    if (error.message === 'upload-too-large') return json(res, 413, { error: 'upload too large' });
    throw error;
  }
  const token = randomBytes(24).toString('base64url');
  uploadByToken.set(token, { token, screenId: session.id, nodeId, path, dir, bytes, createdAt: Date.now(), lastAccess: Date.now() });
  metrics.uploads += 1; metrics.uploadBytes += bytes;
  return json(res, 201, { uploadToken: token, screenId: session.id, bytes });
}

async function pruneUploads() {
  const cutoff = Date.now() - config.uploadTtlMs;
  for (const [token, upload] of uploadByToken) {
    if (upload.lastAccess >= cutoff) continue;
    uploadByToken.delete(token);
    await rm(upload.dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function serveStatic(url, res) {
  const table = { '/': 'index.html', '/index.html': 'index.html', '/client.js': 'client.js', '/input-fastpath.js': 'input-fastpath.js', '/style.css': 'style.css', '/screens.css': 'screens.css' };
  const filename = table[url.pathname];
  if (!filename) return false;
  const path = join(PUBLIC, filename);
  if (!existsSync(path)) { json(res, 404, { error: 'asset missing' }); return true; }
  const info = await stat(path);
  res.writeHead(200, {
    'content-type': contentType(path), 'content-length': info.size,
    'cache-control': filename === 'index.html' ? 'no-store' : 'public, max-age=300, immutable',
    ...securityHeaders()
  });
  createReadStream(path).pipe(res);
  return true;
}

function metricsText() {
  const revisions = [...screens.values()].map((session) => session.revision);
  const rows = [
    ['web_bridge_up', 1], ['web_bridge_ready', readyScreenCount() ? 1 : 0], ['web_bridge_screens', readyScreenCount()],
    ['web_bridge_screen_candidates', screens.size], ['web_bridge_clients', clients.size],
    ['web_bridge_revision', revisions.length ? Math.max(...revisions) : 0], ['web_bridge_snapshots_total', metrics.snapshots],
    ['web_bridge_patch_batches_total', metrics.patchBatches], ['web_bridge_patches_total', metrics.patches],
    ['web_bridge_input_events_total', metrics.inputEvents], ['web_bridge_dropped_messages_total', metrics.droppedMessages],
    ['web_bridge_resources_served_total', metrics.resourcesServed], ['web_bridge_resource_bytes_total', metrics.resourceBytes],
    ['web_bridge_resource_cache_bytes', resourceCacheBytes], ['web_bridge_cdp_reconnects_total', metrics.cdpReconnects],
    ['web_bridge_resyncs_total', metrics.resyncs], ['web_bridge_screen_switches_total', metrics.screenSwitches],
    ['web_bridge_uploads_total', metrics.uploads], ['web_bridge_upload_bytes_total', metrics.uploadBytes],
    ['web_bridge_uptime_seconds', Math.floor((Date.now() - metrics.startedAt) / 1000)]
  ];
  return rows.map(([name, value]) => `${name} ${value}`).join('\n') + '\n';
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    if (url.pathname === '/readyz') return json(res, readyScreenCount() ? 200 : 503, { ready: readyScreenCount() > 0, screens: readyScreenCount() });
    if (url.pathname === '/metrics' && config.metricsPublic) {
      const text = metricsText(); res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4', 'content-length': Buffer.byteLength(text) }); res.end(text); return;
    }
    if (!isAuthorized(req, config)) return challenge(res, config);
    if (!['GET', 'HEAD'].includes(req.method || 'GET') && !originAllowed(req, config)) return json(res, 403, { error: 'origin denied' });
    if (url.pathname === '/upload') return receiveUpload(req, url, res);
    if (url.pathname === '/screens') return json(res, 200, { screens: publicScreens(), ready: readyScreenCount() });
    if (url.pathname === '/metrics') {
      const text = metricsText(); res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4', 'content-length': Buffer.byteLength(text), ...securityHeaders() }); res.end(text); return;
    }
    if (url.pathname.startsWith('/resource/')) {
      const token = url.pathname.slice('/resource/'.length);
      const entry = resourceByToken.get(token);
      if (!entry) return json(res, 404, { error: 'unknown resource token' });
      try {
        const resource = await loadResource(entry);
        metrics.resourcesServed += 1; metrics.resourceBytes += resource.buffer.length;
        sendResource(req, res, resource);
      } catch (error) {
        if (error.message === 'resource-too-large') return json(res, 413, { error: 'resource too large' });
        log('warn', 'resource fetch failed', { screenId: entry.screenId, error: error.message });
        return json(res, 502, { error: 'resource unavailable' });
      }
      return;
    }
    if (await serveStatic(url, res)) return;
    return json(res, 404, { error: 'not found' });
  } catch (error) {
    log('error', 'http request failed', { error: error.message });
    if (!res.headersSent) json(res, 500, { error: 'internal error' }); else res.destroy();
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxWsPayloadBytes, perMessageDeflate: { threshold: 1024 } });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws' || !originAllowed(req, config) || !isAuthorized(req, config) || clients.size >= config.maxClients) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  const id = randomBytes(8).toString('hex');
  const state = {
    id, ws,
    limiter: new TokenBucket(config.maxInputEventsPerSecond, config.maxInputBurst),
    controlActivity: new Map(),
    activeScreenId: null,
    requestedScreenId: null,
    needsResync: false,
    needsResyncScreenId: null,
    alive: true
  };
  clients.set(id, state); metrics.wsConnections += 1;
  const initial = resolveActiveSession(state);
  if (initial && !controllerByScreen.has(initial.id)) claimControl(state, initial.id);
  ws.on('pong', () => { state.alive = true; });
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    handleClientMessage(state, raw).catch((error) => log('warn', 'client input failed', { clientId: id, screenId: state.activeScreenId, error: error.message }));
  });
  ws.on('close', () => { clients.delete(id); releaseClientControls(id); broadcastStatus(); });
  ws.on('error', () => { clients.delete(id); releaseClientControls(id); broadcastStatus(); });
  broadcastStatus();
  if (initial?.cdp) captureSnapshot(initial, 'client-connect').catch((error) => log('warn', 'snapshot for new client failed', { screenId: initial.id, error: error.message }));
});

const heartbeatTimer = setInterval(() => {
  for (const state of clients.values()) {
    if (!state.alive) { state.ws.terminate(); continue; }
    state.alive = false;
    if (state.needsResync && state.ws.bufferedAmount < config.maxBufferedBytes / 2) {
      const screenId = state.needsResyncScreenId || state.activeScreenId;
      state.needsResync = false;
      state.needsResyncScreenId = null;
      const session = screenId ? screens.get(screenId) : null;
      if (session && state.activeScreenId === screenId) send(state, { type: 'resyncRequired', screenId, revision: session.revision }, { force: true });
    }
    try { state.ws.ping(); } catch {}
  }
  pruneResourceTokens();
  pruneUploads().catch((error) => log('warn', 'upload cleanup failed', { error: error.message }));
}, config.heartbeatMs);
heartbeatTimer.unref?.();

function modifierMask(modifiers = {}) {
  return (modifiers.alt ? 1 : 0) | (modifiers.ctrl ? 2 : 0) | (modifiers.meta ? 4 : 0) | (modifiers.shift ? 8 : 0);
}

function screenForMessage(state, message) {
  const id = message.screenId || state.activeScreenId;
  if (!id || id !== state.activeScreenId) return null;
  return screens.get(id) || null;
}

async function bridgePoint(session, nodeId, nx, ny) {
  if (!session?.cdp) return null;
  const result = await session.cdp.call('Runtime.evaluate', { expression: `globalThis.__WEB_BRIDGE__?.point(${nodeId},${nx},${ny})`, returnByValue: true });
  return result.result?.value ?? null;
}

async function focusNode(session, nodeId) {
  if (!session?.cdp || !nodeId) return;
  await session.cdp.call('Runtime.evaluate', { expression: `globalThis.__WEB_BRIDGE__?.focus(${nodeId})`, returnByValue: true });
}

async function markVisual(session, nodeId) {
  if (!session?.cdp || !nodeId) return;
  await session.cdp.call('Runtime.evaluate', { expression: `globalThis.__WEB_BRIDGE__?.markVisual(${nodeId})`, returnByValue: true });
}

async function resizeHostWindow(session, width, height) {
  if (!session?.cdp) throw new Error('QQ screen is not attached');
  const current = await session.cdp.call('Browser.getWindowForTarget');
  const windowId = Number(current?.windowId);
  if (!Number.isInteger(windowId)) throw new Error('QQ window id is unavailable');
  const state = String(current?.bounds?.windowState || 'normal');
  if (state !== 'normal') {
    await session.cdp.call('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  }
  await session.cdp.call('Browser.setWindowBounds', { windowId, bounds: { width, height } });
  const updated = await session.cdp.call('Browser.getWindowForTarget').catch(() => null);
  return updated?.bounds || { width, height, windowState: 'normal' };
}

async function selectScreen(state, screenId) {
  const next = screens.get(screenId);
  if (!next) {
    state.requestedScreenId = screenId;
    send(state, { type: 'screenUnavailable', screenId }, { force: true });
    sendStatus(state);
    return;
  }
  const previousId = state.activeScreenId;
  if (previousId && previousId !== screenId) releaseControllerForScreen(state.id, previousId);
  state.activeScreenId = screenId;
  state.requestedScreenId = null;
  state.needsResync = false;
  state.needsResyncScreenId = null;
  metrics.screenSwitches += previousId === screenId ? 0 : 1;
  if (!controllerByScreen.has(screenId)) claimControl(state, screenId);
  broadcastStatus();
  if (next.cdp) await captureSnapshot(next, 'screen-select');
}

async function handleClientMessage(state, raw) {
  const message = parseClientMessage(raw, { maxTextBytes: config.maxTextBytes });
  if (!message) return;
  if (message.type === 'selectScreen') return selectScreen(state, message.screenId);

  const session = screenForMessage(state, message) || resolveActiveSession(state);
  if (message.screenId && session?.id !== message.screenId) {
    send(state, { type: 'screenUnavailable', screenId: message.screenId }, { force: true });
    return;
  }
  if (message.type === 'resync') {
    if (!session?.cdp) return sendStatus(state);
    metrics.resyncs += 1;
    await captureSnapshot(session, 'client-resync');
    return;
  }
  if (message.type === 'takeControl') { if (session) claimControl(state, session.id); broadcastStatus(); return; }
  if (message.type === 'releaseControl') { if (session) releaseControllerForScreen(state.id, session.id); broadcastStatus(); return; }
  if (!session?.cdp || !canControl(state, session.id)) {
    send(state, { type: 'controlDenied', screenId: session?.id || null, controllerId: session ? controllerIdFor(session.id) : null }, { force: true });
    return;
  }
  if (!state.limiter.take(message.type === 'pointer' ? 0.25 : 1)) { send(state, { type: 'rateLimited', screenId: session.id }); return; }
  state.controlActivity.set(session.id, Date.now());
  metrics.inputEvents += 1;

  if (message.type === 'resizeWindow') {
    const bounds = await resizeHostWindow(session, message.width, message.height);
    broadcastToScreen(session.id, { type: 'windowBounds', screenId: session.id, bounds });
    const timer = setTimeout(() => {
      captureSnapshot(session, 'window-resize').catch((error) => log('warn', 'window resize snapshot failed', { screenId: session.id, error: error.message }));
    }, 40);
    timer.unref?.();
    return;
  }
  if (message.type === 'focus') return focusNode(session, message.nodeId);
  if (message.type === 'fileCommit') {
    const uploads = message.uploadTokens.map((token) => uploadByToken.get(token)).filter(Boolean);
    if (uploads.length !== message.uploadTokens.length || uploads.some((upload) => upload.nodeId !== message.nodeId || upload.screenId !== session.id)) return;
    const object = await session.cdp.call('Runtime.evaluate', { expression: `globalThis.__WEB_BRIDGE__?.objectFor(${message.nodeId})`, returnByValue: false });
    const objectId = object.result?.objectId;
    if (!objectId) return;
    await session.cdp.call('DOM.setFileInputFiles', { files: uploads.map((upload) => upload.path), objectId });
    for (const upload of uploads) upload.lastAccess = Date.now();
    await markVisual(session, message.nodeId);
    return;
  }
  if (message.type === 'select') {
    await session.cdp.call('Runtime.evaluate', { expression: `globalThis.__WEB_BRIDGE__?.selectOption(${message.nodeId},${message.index})`, returnByValue: true });
    return;
  }
  if (message.type === 'pointer' || message.type === 'click' || message.type === 'wheel') {
    const point = await bridgePoint(session, message.nodeId, message.nx, message.ny);
    if (!point) return;
    if (message.type === 'pointer') {
      await session.cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, modifiers: modifierMask(message.modifiers) });
      await markVisual(session, message.nodeId);
      return;
    }
    if (message.type === 'wheel') {
      await session.cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: message.deltaX, deltaY: message.deltaY, modifiers: modifierMask(message.modifiers) });
      return;
    }
    await focusNode(session, message.nodeId);
    const button = message.button === 2 ? 'right' : message.button === 1 ? 'middle' : 'left';
    await session.cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button, clickCount: 1, modifiers: modifierMask(message.modifiers) });
    await session.cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button, clickCount: 1, modifiers: modifierMask(message.modifiers) });
    await markVisual(session, message.nodeId);
    return;
  }
  if (message.type === 'key') {
    if (message.nodeId) await focusNode(session, message.nodeId);
    const mask = modifierMask(message.modifiers);
    await session.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: message.key, code: message.code, text: message.text, unmodifiedText: message.text, modifiers: mask, autoRepeat: message.repeat });
    await session.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: message.key, code: message.code, modifiers: mask });
    return;
  }
  if (message.type === 'text') {
    if (message.nodeId) await focusNode(session, message.nodeId);
    await session.cdp.call('Input.insertText', { text: message.text });
  }
}

function serializedSync(session, task) {
  const next = session.syncChain.then(task, task);
  session.syncChain = next.catch(() => {});
  return next;
}

function schedulePatch(session, delay = config.patchThrottleMs) {
  if (!session?.cdp) return;
  session.dirty = true;
  if (!hasSubscribers(session.id)) return;
  if (session.patchInFlight) { session.patchPending = true; return; }
  if (session.patchTimer) return;
  session.patchTimer = setTimeout(() => {
    session.patchTimer = null;
    flushPatches(session).catch((error) => log('warn', 'patch flush failed', { screenId: session.id, error: error.message }));
  }, delay);
  session.patchTimer.unref?.();
}

function flushPatches(session) {
  return serializedSync(session, () => flushPatchesNow(session));
}

async function flushPatchesNow(session) {
  if (!session?.cdp || session.patchInFlight || !hasSubscribers(session.id)) return;
  session.patchInFlight = true;
  try {
    const result = await session.cdp.call('Runtime.evaluate', { expression: 'globalThis.__WEB_BRIDGE__?.flushPatches()', returnByValue: true, awaitPromise: true });
    const payload = result.result?.value;
    if (!payload) { session.dirty = false; return; }
    if (payload.reset) { await captureSnapshotNow(session, payload.reason || 'patch-reset'); return; }
    const patches = Array.isArray(payload.patches) ? payload.patches : [];
    if (!patches.length && !payload.meta) { session.dirty = false; return; }
    for (const patch of patches) rewritePatchResources(patch, session.id);
    if (payload.meta) delete payload.meta.url;
    if (Array.isArray(payload.meta?.fontFaces)) payload.meta.fontFaces = payload.meta.fontFaces.map((value) => rewriteCssUrls(value, session.id));
    const baseRevision = session.revision;
    session.revision += 1;
    session.dirty = false;
    metrics.patchBatches += 1; metrics.patches += patches.length;
    broadcastToScreen(session.id, { type: 'patch', screenId: session.id, baseRevision, revision: session.revision, patches, meta: payload.meta || null });
  } finally {
    session.patchInFlight = false;
    if (session.patchPending) { session.patchPending = false; schedulePatch(session); }
  }
}

function captureSnapshot(session, reason = 'snapshot') {
  return serializedSync(session, () => captureSnapshotNow(session, reason));
}

async function captureSnapshotNow(session, reason = 'snapshot') {
  if (!session?.cdp || !hasSubscribers(session.id)) return;
  const result = await session.cdp.call('Runtime.evaluate', { expression: 'globalThis.__WEB_BRIDGE__?.snapshot()', returnByValue: true, awaitPromise: true });
  const snapshot = result.result?.value;
  if (!snapshot?.root) return;
  rewriteNodeResources(snapshot.root, session.id);
  delete snapshot.url;
  if (Array.isArray(snapshot.fontFaces)) snapshot.fontFaces = snapshot.fontFaces.map((value) => rewriteCssUrls(value, session.id));
  session.revision += 1;
  session.dirty = false;
  snapshot.revision = session.revision;
  session.latestSnapshot = snapshot;
  metrics.snapshots += 1;
  broadcastToScreen(session.id, { type: 'snapshot', screenId: session.id, snapshot, reason });
}

async function attachScreen(session) {
  if (!session || session.cdp || session.connecting || shuttingDown) return;
  session.connecting = true;
  const targetCandidate = session.target;
  const connection = new CdpConnection(targetCandidate.webSocketDebuggerUrl, { callTimeoutMs: config.callTimeoutMs });
  try {
    await connection.connect();
    await connection.call('Runtime.enable');
    await connection.call('Page.enable');
    try { await connection.call('DOM.enable'); } catch {}
    await connection.call('Runtime.addBinding', { name: '__webBridgeDirty' });
    await connection.call('Page.addScriptToEvaluateOnNewDocument', { source: INJECTED_BRIDGE_SOURCE });
    await connection.call('Runtime.evaluate', { expression: INJECTED_BRIDGE_SOURCE, returnByValue: true });

    connection.on('Runtime.bindingCalled', (event) => {
      if (event.name !== '__webBridgeDirty') return;
      if (hasSubscribers(session.id)) schedulePatch(session);
      else session.dirty = true;
    });
    connection.on('Page.frameNavigated', (event) => {
      if (event.frame?.parentId) return;
      session.latestSnapshot = null;
      session.dirty = true;
      if (hasSubscribers(session.id)) {
        setTimeout(() => captureSnapshot(session, 'navigation').catch((error) => log('warn', 'navigation snapshot failed', { screenId: session.id, error: error.message })), 250).unref?.();
      }
    });
    connection.on('Runtime.executionContextsCleared', () => { session.latestSnapshot = null; session.dirty = true; });
    connection.on('disconnect', () => {
      if (session.cdp !== connection) return;
      session.cdp = null;
      session.latestSnapshot = null;
      session.dirty = true;
      broadcastStatus();
    });

    session.cdp = connection;
    session.dirty = true;
    session.lastAttachError = '';
    metrics.cdpReconnects += 1;
    log('info', 'attached to QQ screen', { screenId: session.id, title: screenLabel(session.target, session.id), kind: session.target?.kind || '' });
    broadcastStatus();
    if (hasSubscribers(session.id)) await captureSnapshot(session, 'attach');
  } catch (error) {
    try { connection.close(); } catch {}
    const now = Date.now();
    if (error.message !== session.lastAttachError || now - session.lastAttachErrorAt > 5000) {
      log('warn', 'QQ screen attach pending', { screenId: session.id, title: screenLabel(session.target, session.id), error: error.message });
      session.lastAttachError = error.message;
      session.lastAttachErrorAt = now;
    }
  } finally {
    session.connecting = false;
  }
}

function closeScreenSession(session, reason = 'removed') {
  if (!session) return;
  if (session.patchTimer) clearTimeout(session.patchTimer);
  session.patchTimer = null;
  try { session.cdp?.close(); } catch {}
  session.cdp = null;
  controllerByScreen.delete(session.id);
  log('info', 'QQ screen detached', { screenId: session.id, reason });
}

function normalizeClientScreens() {
  const preferred = preferredSession();
  for (const state of clients.values()) {
    if (state.requestedScreenId && screens.has(state.requestedScreenId)) {
      if (state.activeScreenId && state.activeScreenId !== state.requestedScreenId) releaseControllerForScreen(state.id, state.activeScreenId);
      state.activeScreenId = state.requestedScreenId;
      state.requestedScreenId = null;
    }
    if (!state.activeScreenId || !screens.has(state.activeScreenId)) state.activeScreenId = preferred?.id || null;
    if (state.activeScreenId && !controllerByScreen.has(state.activeScreenId)) claimControl(state, state.activeScreenId);
  }
}

async function reconcileScreens() {
  const candidates = (await listTargets(config.cdpHost, config.cdpPort, Math.min(5000, config.callTimeoutMs)))
    .filter(isScreenCandidate)
    .sort((a, b) => targetScore(b) - targetScore(a))
    .slice(0, config.maxScreens);
  const seen = new Set();
  const now = Date.now();
  let changed = false;

  for (const candidate of candidates) {
    const id = screenIdFor(candidate);
    seen.add(id);
    let session = screens.get(id);
    if (!session) {
      session = createSession(candidate);
      screens.set(id, session);
      changed = true;
    } else {
      const before = `${session.target?.title || ''}|${session.target?.url || ''}|${session.target?.visible}|${session.target?.focused}`;
      session.target = candidate;
      const after = `${candidate.title || ''}|${candidate.url || ''}|${candidate.visible}|${candidate.focused}`;
      if (before !== after) changed = true;
    }
    session.lastSeenAt = now;
    session.missingSince = 0;
  }

  const removalGrace = Math.max(1000, config.screenDiscoveryMs * 2);
  for (const [id, session] of [...screens.entries()]) {
    if (seen.has(id)) continue;
    if (!session.missingSince) session.missingSince = now;
    if (now - session.missingSince < removalGrace) continue;
    closeScreenSession(session, 'target-disappeared');
    screens.delete(id);
    for (const state of clients.values()) if (state.activeScreenId === id) state.activeScreenId = null;
    changed = true;
  }

  normalizeClientScreens();
  for (const session of sortedSessions()) if (!session.cdp && !session.connecting) await attachScreen(session);
  if (changed) broadcastStatus();
}

async function startDiscoveryLoop() {
  if (discoveryLoopRunning || shuttingDown) return;
  discoveryLoopRunning = true;
  try {
    while (!shuttingDown) {
      try {
        await reconcileScreens();
        lastDiscoveryError = '';
      } catch (error) {
        const now = Date.now();
        if (error.message !== lastDiscoveryError || now - lastDiscoveryErrorAt > 5000) {
          log('warn', 'waiting for QQ screens', { error: error.message });
          lastDiscoveryError = error.message;
          lastDiscoveryErrorAt = now;
        }
      }
      await sleep(config.screenDiscoveryMs);
    }
  } finally {
    discoveryLoopRunning = false;
  }
}

const periodicSnapshot = setInterval(() => {
  for (const session of screens.values()) {
    if (session.cdp && hasSubscribers(session.id)) {
      captureSnapshot(session, 'periodic').catch((error) => log('warn', 'periodic snapshot failed', { screenId: session.id, error: error.message }));
    }
  }
}, config.fullSnapshotIntervalMs);
periodicSnapshot.unref?.();

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutting down', { signal });
  clearInterval(heartbeatTimer);
  clearInterval(periodicSnapshot);
  for (const state of clients.values()) { try { state.ws.close(1001, 'server shutdown'); } catch {} }
  for (const session of screens.values()) closeScreenSession(session, 'shutdown');
  screens.clear();
  for (const upload of uploadByToken.values()) await rm(upload.dir, { recursive: true, force: true }).catch(() => {});
  uploadByToken.clear();
  await new Promise((resolve) => server.close(() => resolve()));
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown(signal).finally(() => process.exit(0)));
process.on('uncaughtException', (error) => { log('error', 'uncaught exception', { error: error.stack || error.message }); });
process.on('unhandledRejection', (error) => { log('error', 'unhandled rejection', { error: error?.stack || String(error) }); });

server.listen(config.port, config.host, () => {
  log('info', 'web-bridge listening', {
    host: config.host,
    port: config.port,
    auth: Boolean(config.authToken),
    instanceId: config.instanceId,
    multiScreen: true,
    maxScreens: config.maxScreens,
    screenDiscoveryMs: config.screenDiscoveryMs
  });
  startDiscoveryLoop();
});
