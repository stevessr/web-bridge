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
const resourceByToken = new Map();
const tokenByResource = new Map();
const uploadByToken = new Map();
const metrics = {
  startedAt: Date.now(), snapshots: 0, patchBatches: 0, patches: 0, inputEvents: 0,
  droppedMessages: 0, resourcesServed: 0, resourceBytes: 0, wsConnections: 0,
  cdpReconnects: 0, resyncs: 0, uploads: 0, uploadBytes: 0
};

let cdp = null;
let target = null;
let revision = 0;
let latestSnapshot = null;
let patchTimer = null;
let patchInFlight = false;
let patchPending = false;
let attachLoopRunning = false;
let shuttingDown = false;
let controllerId = null;
let resourceCacheBytes = 0;
let syncChain = Promise.resolve();

function log(level, message, fields = {}) {
  const record = { time: new Date().toISOString(), level, message, ...fields };
  const writer = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  writer(JSON.stringify(record));
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

function statusMessage() {
  return {
    type: 'status', attached: Boolean(cdp), revision, instanceId: config.instanceId,
    target: target ? { title: target.title || 'QQ NT' } : null,
    controllerId, clients: clients.size
  };
}

function send(state, message, { force = false } = {}) {
  if (!state || state.ws.readyState !== WebSocket.OPEN) return false;
  const payload = typeof message === 'string' ? message : JSON.stringify(message);
  if (!force && state.ws.bufferedAmount > config.maxBufferedBytes) {
    state.needsResync = true;
    metrics.droppedMessages += 1;
    return false;
  }
  state.ws.send(payload);
  return true;
}

function broadcast(message, options) {
  for (const state of clients.values()) send(state, message, options);
}

function broadcastStatus() {
  const base = statusMessage();
  for (const state of clients.values()) {
    send(state, { ...base, control: config.allowMultipleControllers || state.id === controllerId ? 'granted' : 'readonly' }, { force: true });
  }
}

function releaseController(id) {
  if (config.allowMultipleControllers || controllerId !== id) return;
  controllerId = null;
  const next = [...clients.values()].find((state) => state.ws.readyState === WebSocket.OPEN);
  if (next) {
    next.lastInputAt = Date.now();
    controllerId = next.id;
  }
  broadcastStatus();
}

function claimControl(state) {
  if (config.allowMultipleControllers) return true;
  const current = controllerId ? [...clients.values()].find((candidate) => candidate.id === controllerId) : null;
  if (!current || current.ws.readyState !== WebSocket.OPEN || Date.now() - current.lastInputAt > config.controlLeaseMs) {
    state.lastInputAt = Date.now();
    controllerId = state.id;
    broadcastStatus();
    return true;
  }
  return controllerId === state.id;
}

function canControl(state) {
  return config.allowMultipleControllers || controllerId === state.id;
}

function registerResource(url) {
  if (!url || typeof url !== 'string') return url;
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('data:') || trimmed.startsWith('/resource/')) return url;
  let token = tokenByResource.get(trimmed);
  if (!token) {
    token = randomBytes(24).toString('base64url');
    tokenByResource.set(trimmed, token);
    resourceByToken.set(token, { url: trimmed, buffer: null, mime: null, size: 0, createdAt: Date.now(), lastAccess: Date.now() });
  }
  return `/resource/${token}`;
}

function rewriteCssUrls(value) {
  if (!value || typeof value !== 'string' || !value.includes('url(')) return value;
  return value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_match, _quote, url) => `url("${registerResource(url)}")`);
}

function rewriteNodeResources(node) {
  if (!node || node.type !== 'element') return;
  for (const name of ['src', 'poster', 'xlink:href']) if (node.attrs?.[name]) node.attrs[name] = registerResource(node.attrs[name]);
  if (node.tag === 'use' || node.tag === 'image') {
    if (node.attrs?.href) node.attrs.href = registerResource(node.attrs.href);
  } else if (node.attrs?.href && !node.attrs.href.startsWith('#')) node.attrs.href = '#';
  if (node.style) for (const [key, value] of Object.entries(node.style)) node.style[key] = rewriteCssUrls(value);
  for (const child of node.children ?? []) rewriteNodeResources(child);
  for (const child of node.shadow ?? []) rewriteNodeResources(child);
}

function rewritePatchResources(patch) {
  if (patch.op === 'children') {
    for (const child of patch.children ?? []) rewriteNodeResources(child);
    for (const child of patch.shadow ?? []) rewriteNodeResources(child);
  } else if (patch.op === 'update') {
    for (const name of ['src', 'poster', 'xlink:href']) if (patch.attrs?.[name]) patch.attrs[name] = registerResource(patch.attrs[name]);
    if (patch.attrs?.href && !patch.attrs.href.startsWith('#')) patch.attrs.href = '#';
    if (patch.style) for (const [key, value] of Object.entries(patch.style)) patch.style[key] = rewriteCssUrls(value);
    for (const child of patch.shadow ?? []) rewriteNodeResources(child);
  }
}

function pruneResourceTokens() {
  const cutoff = Date.now() - config.resourceTokenTtlMs;
  for (const [token, entry] of resourceByToken) {
    if (entry.lastAccess >= cutoff) continue;
    if (entry.buffer) resourceCacheBytes -= entry.size;
    resourceByToken.delete(token);
    tokenByResource.delete(entry.url);
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

async function getResourceTreeEntry(url) {
  if (!cdp) return null;
  try {
    const tree = await cdp.call('Page.getResourceTree');
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
    if (!cdp) throw new Error('QQ renderer is not attached');
    const treeEntry = await getResourceTreeEntry(entry.url);
    if (treeEntry) {
      try {
        const content = await cdp.call('Page.getResourceContent', { frameId: treeEntry.frameId, url: entry.url });
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
    const result = await cdp.call('Runtime.evaluate', {
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
  uploadByToken.set(token, { token, nodeId, path, dir, bytes, createdAt: Date.now(), lastAccess: Date.now() });
  metrics.uploads += 1; metrics.uploadBytes += bytes;
  return json(res, 201, { uploadToken: token, bytes });
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
  const table = { '/': 'index.html', '/index.html': 'index.html', '/client.js': 'client.js', '/style.css': 'style.css' };
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
  const rows = [
    ['web_bridge_up', 1], ['web_bridge_ready', cdp ? 1 : 0], ['web_bridge_clients', clients.size],
    ['web_bridge_revision', revision], ['web_bridge_snapshots_total', metrics.snapshots],
    ['web_bridge_patch_batches_total', metrics.patchBatches], ['web_bridge_patches_total', metrics.patches],
    ['web_bridge_input_events_total', metrics.inputEvents], ['web_bridge_dropped_messages_total', metrics.droppedMessages],
    ['web_bridge_resources_served_total', metrics.resourcesServed], ['web_bridge_resource_bytes_total', metrics.resourceBytes],
    ['web_bridge_resource_cache_bytes', resourceCacheBytes], ['web_bridge_cdp_reconnects_total', metrics.cdpReconnects],
    ['web_bridge_resyncs_total', metrics.resyncs], ['web_bridge_uploads_total', metrics.uploads], ['web_bridge_upload_bytes_total', metrics.uploadBytes], ['web_bridge_uptime_seconds', Math.floor((Date.now() - metrics.startedAt) / 1000)]
  ];
  return rows.map(([name, value]) => `${name} ${value}`).join('\n') + '\n';
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    if (url.pathname === '/readyz') return json(res, cdp ? 200 : 503, { ready: Boolean(cdp) });
    if (url.pathname === '/metrics' && config.metricsPublic) {
      const text = metricsText(); res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4', 'content-length': Buffer.byteLength(text) }); res.end(text); return;
    }
    if (!isAuthorized(req, config)) return challenge(res, config);
    if (!['GET', 'HEAD'].includes(req.method || 'GET') && !originAllowed(req, config)) return json(res, 403, { error: 'origin denied' });
    if (url.pathname === '/upload') return receiveUpload(req, url, res);
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
        log('warn', 'resource fetch failed', { error: error.message });
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
  const state = { id, ws, limiter: new TokenBucket(config.maxInputEventsPerSecond, config.maxInputBurst), lastInputAt: Date.now(), needsResync: false, alive: true };
  clients.set(id, state); metrics.wsConnections += 1;
  if (config.allowMultipleControllers || !controllerId) controllerId = id;
  ws.on('pong', () => { state.alive = true; });
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    handleClientMessage(state, raw).catch((error) => log('warn', 'client input failed', { clientId: id, error: error.message }));
  });
  ws.on('close', () => { clients.delete(id); releaseController(id); });
  ws.on('error', () => { clients.delete(id); releaseController(id); });
  broadcastStatus();
  if (cdp) captureSnapshot('client-connect').catch((error) => log('warn', 'snapshot for new client failed', { error: error.message }));
});

const heartbeatTimer = setInterval(() => {
  for (const state of clients.values()) {
    if (!state.alive) { state.ws.terminate(); continue; }
    state.alive = false;
    if (state.needsResync && state.ws.bufferedAmount < config.maxBufferedBytes / 2) {
      state.needsResync = false;
      send(state, { type: 'resyncRequired', revision }, { force: true });
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

async function bridgePoint(nodeId, nx, ny) {
  if (!cdp) return null;
  const result = await cdp.call('Runtime.evaluate', { expression: `globalThis.__WEB_BRIDGE__?.point(${nodeId},${nx},${ny})`, returnByValue: true });
  return result.result?.value ?? null;
}

async function focusNode(nodeId) {
  if (!cdp || !nodeId) return;
  await cdp.call('Runtime.evaluate', { expression: `globalThis.__WEB_BRIDGE__?.focus(${nodeId})`, returnByValue: true });
}

async function markVisual(nodeId) {
  if (!cdp || !nodeId) return;
  await cdp.call('Runtime.evaluate', { expression: `globalThis.__WEB_BRIDGE__?.markVisual(${nodeId})`, returnByValue: true });
}

async function handleClientMessage(state, raw) {
  const message = parseClientMessage(raw, { maxTextBytes: config.maxTextBytes });
  if (!message) return;
  if (message.type === 'resync') { metrics.resyncs += 1; await captureSnapshot('client-resync'); return; }
  if (message.type === 'takeControl') { claimControl(state); broadcastStatus(); return; }
  if (message.type === 'releaseControl') { releaseController(state.id); return; }
  if (!cdp || !canControl(state)) { send(state, { type: 'controlDenied', controllerId }, { force: true }); return; }
  if (!state.limiter.take(message.type === 'pointer' ? 0.25 : 1)) { send(state, { type: 'rateLimited' }); return; }
  state.lastInputAt = Date.now(); metrics.inputEvents += 1;

  if (message.type === 'focus') return focusNode(message.nodeId);
  if (message.type === 'fileCommit') {
    const uploads = message.uploadTokens.map((token) => uploadByToken.get(token)).filter(Boolean);
    if (uploads.length !== message.uploadTokens.length || uploads.some((upload) => upload.nodeId !== message.nodeId)) return;
    const object = await cdp.call('Runtime.evaluate', { expression: `globalThis.__WEB_BRIDGE__?.objectFor(${message.nodeId})`, returnByValue: false });
    const objectId = object.result?.objectId;
    if (!objectId) return;
    await cdp.call('DOM.setFileInputFiles', { files: uploads.map((upload) => upload.path), objectId });
    for (const upload of uploads) upload.lastAccess = Date.now();
    await markVisual(message.nodeId);
    return;
  }
  if (message.type === 'select') {
    await cdp.call('Runtime.evaluate', { expression: `globalThis.__WEB_BRIDGE__?.selectOption(${message.nodeId},${message.index})`, returnByValue: true });
    return;
  }
  if (message.type === 'pointer' || message.type === 'click' || message.type === 'wheel') {
    const point = await bridgePoint(message.nodeId, message.nx, message.ny);
    if (!point) return;
    if (message.type === 'pointer') {
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, modifiers: modifierMask(message.modifiers) });
      await markVisual(message.nodeId);
      return;
    }
    if (message.type === 'wheel') {
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: message.deltaX, deltaY: message.deltaY, modifiers: modifierMask(message.modifiers) });
      return;
    }
    await focusNode(message.nodeId);
    const button = message.button === 2 ? 'right' : message.button === 1 ? 'middle' : 'left';
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button, clickCount: 1, modifiers: modifierMask(message.modifiers) });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button, clickCount: 1, modifiers: modifierMask(message.modifiers) });
    await markVisual(message.nodeId);
    return;
  }
  if (message.type === 'key') {
    if (message.nodeId) await focusNode(message.nodeId);
    const mask = modifierMask(message.modifiers);
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: message.key, code: message.code, text: message.text, unmodifiedText: message.text, modifiers: mask, autoRepeat: message.repeat });
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: message.key, code: message.code, modifiers: mask });
    return;
  }
  if (message.type === 'text') {
    if (message.nodeId) await focusNode(message.nodeId);
    await cdp.call('Input.insertText', { text: message.text });
  }
}

function serializedSync(task) {
  const next = syncChain.then(task, task);
  syncChain = next.catch(() => {});
  return next;
}

function schedulePatch(delay = config.patchThrottleMs) {
  if (patchInFlight) { patchPending = true; return; }
  if (patchTimer) return;
  patchTimer = setTimeout(() => { patchTimer = null; flushPatches().catch((error) => log('warn', 'patch flush failed', { error: error.message })); }, delay);
}

function flushPatches() { return serializedSync(flushPatchesNow); }

async function flushPatchesNow() {
  if (!cdp || patchInFlight) return;
  patchInFlight = true;
  try {
    const result = await cdp.call('Runtime.evaluate', { expression: 'globalThis.__WEB_BRIDGE__?.flushPatches()', returnByValue: true, awaitPromise: true });
    const payload = result.result?.value;
    if (!payload) return;
    if (payload.reset) { await captureSnapshotNow(payload.reason || 'patch-reset'); return; }
    const patches = Array.isArray(payload.patches) ? payload.patches : [];
    if (!patches.length && !payload.meta) return;
    for (const patch of patches) rewritePatchResources(patch);
    if (payload.meta) delete payload.meta.url;
    if (Array.isArray(payload.meta?.fontFaces)) payload.meta.fontFaces = payload.meta.fontFaces.map(rewriteCssUrls);
    const baseRevision = revision;
    revision += 1;
    metrics.patchBatches += 1; metrics.patches += patches.length;
    broadcast({ type: 'patch', baseRevision, revision, patches, meta: payload.meta || null });
  } finally {
    patchInFlight = false;
    if (patchPending) { patchPending = false; schedulePatch(); }
  }
}

function captureSnapshot(reason = 'snapshot') { return serializedSync(() => captureSnapshotNow(reason)); }

async function captureSnapshotNow(reason = 'snapshot') {
  if (!cdp) return;
  const result = await cdp.call('Runtime.evaluate', { expression: 'globalThis.__WEB_BRIDGE__?.snapshot()', returnByValue: true, awaitPromise: true });
  const snapshot = result.result?.value;
  if (!snapshot?.root) return;
  rewriteNodeResources(snapshot.root);
  delete snapshot.url;
  if (Array.isArray(snapshot.fontFaces)) snapshot.fontFaces = snapshot.fontFaces.map(rewriteCssUrls);
  revision += 1;
  snapshot.revision = revision;
  latestSnapshot = snapshot;
  metrics.snapshots += 1;
  broadcast({ type: 'snapshot', snapshot, reason });
}

function targetScore(candidate, matcher) {
  if (candidate.type !== 'page' || !candidate.webSocketDebuggerUrl) return -10000;
  const haystack = `${candidate.title || ''} ${candidate.url || ''}`;
  let score = 0;
  if (/qq|tencent/i.test(haystack)) score += 200;
  if (/devtools|chrome-extension|background/i.test(haystack)) score -= 500;
  if (matcher) {
    try { score += new RegExp(matcher, 'i').test(haystack) ? 1000 : -1000; } catch { score -= 1000; }
  }
  if (candidate.url?.startsWith('file:') || candidate.url?.startsWith('app:')) score += 25;
  return score;
}

async function findTarget() {
  const targets = await listTargets(config.cdpHost, config.cdpPort, Math.min(5000, config.callTimeoutMs));
  return targets.map((candidate) => ({ candidate, score: targetScore(candidate, config.targetMatch) })).sort((a, b) => b.score - a.score)[0]?.candidate || null;
}

async function attach(targetCandidate) {
  const connection = new CdpConnection(targetCandidate.webSocketDebuggerUrl, { callTimeoutMs: config.callTimeoutMs });
  await connection.connect();
  await connection.call('Runtime.enable');
  await connection.call('Page.enable');
  try { await connection.call('DOM.enable'); } catch {}
  await connection.call('Runtime.addBinding', { name: '__webBridgeDirty' });
  await connection.call('Page.addScriptToEvaluateOnNewDocument', { source: INJECTED_BRIDGE_SOURCE });
  await connection.call('Runtime.evaluate', { expression: INJECTED_BRIDGE_SOURCE, returnByValue: true });

  connection.on('Runtime.bindingCalled', (event) => { if (event.name === '__webBridgeDirty') schedulePatch(); });
  connection.on('Page.frameNavigated', (event) => {
    if (event.frame?.parentId) return;
    latestSnapshot = null;
    setTimeout(() => captureSnapshot('navigation').catch((error) => log('warn', 'navigation snapshot failed', { error: error.message })), 250);
  });
  connection.on('Runtime.executionContextsCleared', () => { latestSnapshot = null; });
  connection.on('disconnect', () => {
    if (cdp !== connection) return;
    cdp = null; target = null; latestSnapshot = null;
    broadcastStatus();
    if (!shuttingDown) startAttachLoop();
  });
  cdp = connection;
  target = targetCandidate;
  metrics.cdpReconnects += 1;
  broadcastStatus();
  await captureSnapshot('attach');
  log('info', 'attached to QQ renderer', { title: target.title || '', targetId: target.id || '' });
}

async function startAttachLoop() {
  if (attachLoopRunning || shuttingDown || cdp) return;
  attachLoopRunning = true;
  const started = Date.now();
  let delay = config.reconnectMinMs;
  try {
    while (!shuttingDown && !cdp) {
      try {
        const candidate = await findTarget();
        if (candidate) { await attach(candidate); return; }
      } catch (error) {
        if (Date.now() - started > config.attachTimeoutMs) log('warn', 'waiting for QQ CDP target', { error: error.message });
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(config.reconnectMaxMs, Math.ceil(delay * 1.6));
    }
  } finally { attachLoopRunning = false; }
}

const periodicSnapshot = setInterval(() => {
  if (cdp) captureSnapshot('periodic').catch((error) => log('warn', 'periodic snapshot failed', { error: error.message }));
}, config.fullSnapshotIntervalMs);
periodicSnapshot.unref?.();

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutting down', { signal });
  clearInterval(heartbeatTimer); clearInterval(periodicSnapshot); clearTimeout(patchTimer);
  for (const state of clients.values()) { try { state.ws.close(1001, 'server shutdown'); } catch {} }
  try { cdp?.close(); } catch {}
  for (const upload of uploadByToken.values()) await rm(upload.dir, { recursive: true, force: true }).catch(() => {});
  uploadByToken.clear();
  await new Promise((resolve) => server.close(() => resolve()));
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown(signal).finally(() => process.exit(0)));
process.on('uncaughtException', (error) => { log('error', 'uncaught exception', { error: error.stack || error.message }); });
process.on('unhandledRejection', (error) => { log('error', 'unhandled rejection', { error: error?.stack || String(error) }); });

server.listen(config.port, config.host, () => {
  log('info', 'web-bridge listening', { host: config.host, port: config.port, auth: Boolean(config.authToken), instanceId: config.instanceId });
  startAttachLoop();
});
