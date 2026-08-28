import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { CdpConnection, listTargets } from './cdp.mjs';
import { INJECTED_BRIDGE_SOURCE } from './injected.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const HOST = process.env.WEB_BRIDGE_HOST ?? '127.0.0.1';
const PORT = Number(process.env.WEB_BRIDGE_PORT ?? 8080);
const CDP_HOST = process.env.WEB_BRIDGE_CDP_HOST ?? '127.0.0.1';
const CDP_PORT = Number(process.env.WEB_BRIDGE_CDP_PORT ?? 9222);
const ATTACH_TIMEOUT = Number(process.env.WEB_BRIDGE_ATTACH_TIMEOUT_MS ?? 60000);
const SNAPSHOT_THROTTLE_MS = Number(process.env.WEB_BRIDGE_SNAPSHOT_THROTTLE_MS ?? 200);

const clients = new Set();
const resourceByToken = new Map();
const tokenByResource = new Map();
let cdp = null;
let target = null;
let latestSnapshot = null;
let latestSnapshotJson = '';
let snapshotTimer = null;
let snapshotInFlight = false;
let snapshotPending = false;

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store'
  });
  res.end(data);
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
  if (clean.endsWith('.svg')) return 'image/svg+xml';
  if (clean.endsWith('.woff2')) return 'font/woff2';
  if (clean.endsWith('.woff')) return 'font/woff';
  if (clean.endsWith('.ttf')) return 'font/ttf';
  if (clean.endsWith('.css')) return 'text/css';
  return 'application/octet-stream';
}

function broadcast(message) {
  const payload = typeof message === 'string' ? message : JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

function registerResource(url) {
  if (!url || typeof url !== 'string') return url;
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('data:') || trimmed.startsWith('/resource/')) return url;
  let token = tokenByResource.get(trimmed);
  if (!token) {
    token = randomBytes(18).toString('base64url');
    tokenByResource.set(trimmed, token);
    resourceByToken.set(token, { url: trimmed, buffer: null, mime: null });
  }
  return `/resource/${token}`;
}

function rewriteCssUrls(value) {
  if (!value || typeof value !== 'string' || !value.includes('url(')) return value;
  return value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_match, _quote, url) => `url("${registerResource(url)}")`);
}

function rewriteSnapshotResources(node) {
  if (!node || node.type !== 'element') return;
  for (const name of ['src', 'poster', 'xlink:href']) {
    if (node.attrs?.[name]) node.attrs[name] = registerResource(node.attrs[name]);
  }
  if (node.tag === 'use' || node.tag === 'image') {
    if (node.attrs?.href) node.attrs.href = registerResource(node.attrs.href);
  } else if (node.attrs?.href && !node.attrs.href.startsWith('#')) {
    // Client navigation is disabled. Keeping a non-resource href would leak it to the browser.
    node.attrs.href = '#';
  }
  if (node.style) {
    for (const [key, value] of Object.entries(node.style)) node.style[key] = rewriteCssUrls(value);
  }
  for (const child of node.children ?? []) rewriteSnapshotResources(child);
  for (const child of node.shadow ?? []) rewriteSnapshotResources(child);
}

async function serveStatic(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const table = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/client.js': 'client.js',
    '/style.css': 'style.css'
  };
  const filename = table[pathname];
  if (!filename) return false;
  const path = join(PUBLIC, filename);
  if (!existsSync(path)) {
    json(res, 404, { error: 'asset missing' });
    return true;
  }
  const info = await stat(path);
  res.writeHead(200, {
    'content-type': contentType(path),
    'content-length': info.size,
    'cache-control': filename === 'index.html' ? 'no-store' : 'public, max-age=60',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  });
  createReadStream(path).pipe(res);
  return true;
}

async function getResourceTreeEntry(url) {
  if (!cdp) return null;
  try {
    const tree = await cdp.call('Page.getResourceTree');
    const walk = (frameTree) => {
      for (const resource of frameTree.resources ?? []) {
        if (resource.url === url) return { frameId: frameTree.frame.id, resource };
      }
      for (const child of frameTree.childFrames ?? []) {
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(tree.frameTree);
  } catch {
    return null;
  }
}

async function loadResource(entry) {
  if (entry.buffer) return entry;
  if (!cdp) throw new Error('QQ renderer is not attached');

  const treeEntry = await getResourceTreeEntry(entry.url);
  if (treeEntry) {
    try {
      const content = await cdp.call('Page.getResourceContent', {
        frameId: treeEntry.frameId,
        url: entry.url
      });
      entry.buffer = content.base64Encoded ? Buffer.from(content.content, 'base64') : Buffer.from(content.content);
      entry.mime = treeEntry.resource.mimeType || mimeFromUrl(entry.url);
      return entry;
    } catch {}
  }

  const expression = `globalThis.__WEB_BRIDGE__?.fetchResource(${JSON.stringify(entry.url)})`;
  const result = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  const value = result.result?.value;
  if (!value?.base64) throw new Error('resource is not fetchable from QQ renderer');
  entry.buffer = Buffer.from(value.base64, 'base64');
  entry.mime = value.mime || mimeFromUrl(entry.url);
  return entry;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') {
      json(res, 200, { ok: true, attached: Boolean(cdp), target: target ? { title: target.title, url: target.url } : null });
      return;
    }
    if (url.pathname.startsWith('/resource/')) {
      const token = url.pathname.slice('/resource/'.length);
      const entry = resourceByToken.get(token);
      if (!entry) {
        json(res, 404, { error: 'unknown resource token' });
        return;
      }
      const resource = await loadResource(entry);
      res.writeHead(200, {
        'content-type': resource.mime || 'application/octet-stream',
        'content-length': resource.buffer.length,
        'cache-control': 'private, max-age=300',
        'x-content-type-options': 'nosniff'
      });
      res.end(resource.buffer);
      return;
    }
    if (await serveStatic(req, res)) return;
    json(res, 404, { error: 'not found' });
  } catch (error) {
    console.error('[http]', error);
    if (!res.headersSent) json(res, 500, { error: 'internal error' });
    else res.destroy();
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'status', attached: Boolean(cdp), target: target ? { title: target.title, url: target.url } : null }));
  if (latestSnapshot) ws.send(JSON.stringify({ type: 'snapshot', snapshot: latestSnapshot }));
  ws.on('message', (raw) => handleClientMessage(ws, raw).catch((error) => console.error('[input]', error)));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function bridgePoint(nodeId, nx, ny) {
  const id = Math.trunc(finiteNumber(nodeId, -1));
  const x = Math.min(1, Math.max(0, finiteNumber(nx, 0.5)));
  const y = Math.min(1, Math.max(0, finiteNumber(ny, 0.5)));
  if (id < 1) return null;
  const result = await cdp.call('Runtime.evaluate', {
    expression: `globalThis.__WEB_BRIDGE__?.point(${id},${x},${y})`,
    returnByValue: true
  });
  return result.result?.value ?? null;
}

async function focusNode(nodeId) {
  const id = Math.trunc(finiteNumber(nodeId, -1));
  if (id < 1) return;
  await cdp.call('Runtime.evaluate', {
    expression: `globalThis.__WEB_BRIDGE__?.focus(${id})`,
    returnByValue: true
  });
}

function modifierMask(modifiers = {}) {
  return (modifiers.alt ? 1 : 0) |
    (modifiers.ctrl ? 2 : 0) |
    (modifiers.meta ? 4 : 0) |
    (modifiers.shift ? 8 : 0);
}

async function handleClientMessage(_ws, raw) {
  if (!cdp) return;
  let message;
  try { message = JSON.parse(raw.toString()); } catch { return; }
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'focus') {
    await focusNode(message.nodeId);
    return;
  }

  if (message.type === 'pointer') {
    const point = await bridgePoint(message.nodeId, message.nx, message.ny);
    if (!point) return;
    await cdp.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      modifiers: modifierMask(message.modifiers)
    });
    return;
  }

  if (message.type === 'click') {
    const point = await bridgePoint(message.nodeId, message.nx, message.ny);
    if (!point) return;
    await focusNode(message.nodeId);
    const button = message.button === 2 ? 'right' : message.button === 1 ? 'middle' : 'left';
    await cdp.call('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button, clickCount: 1,
      modifiers: modifierMask(message.modifiers)
    });
    await cdp.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button, clickCount: 1,
      modifiers: modifierMask(message.modifiers)
    });
    return;
  }

  if (message.type === 'wheel') {
    const point = await bridgePoint(message.nodeId, message.nx, message.ny);
    if (!point) return;
    await cdp.call('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: point.x, y: point.y,
      deltaX: finiteNumber(message.deltaX),
      deltaY: finiteNumber(message.deltaY),
      modifiers: modifierMask(message.modifiers)
    });
    return;
  }

  if (message.type === 'key') {
    if (message.nodeId) await focusNode(message.nodeId);
    const key = String(message.key ?? '').slice(0, 64);
    const code = String(message.code ?? '').slice(0, 64);
    const text = typeof message.text === 'string' ? message.text.slice(0, 16) : '';
    const modifiers = modifierMask(message.modifiers);
    await cdp.call('Input.dispatchKeyEvent', {
      type: 'keyDown', key, code, text, unmodifiedText: text, modifiers,
      autoRepeat: Boolean(message.repeat)
    });
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
    return;
  }

  if (message.type === 'text') {
    if (message.nodeId) await focusNode(message.nodeId);
    const text = String(message.text ?? '').slice(0, 32768);
    if (text) await cdp.call('Input.insertText', { text });
  }
}

function scheduleSnapshot(delay = SNAPSHOT_THROTTLE_MS) {
  if (snapshotInFlight) {
    snapshotPending = true;
    return;
  }
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    captureSnapshot().catch((error) => console.error('[snapshot]', error));
  }, delay);
}

async function captureSnapshot() {
  if (!cdp || snapshotInFlight) return;
  snapshotInFlight = true;
  try {
    const result = await cdp.call('Runtime.evaluate', {
      expression: 'globalThis.__WEB_BRIDGE__?.snapshot()',
      returnByValue: true,
      awaitPromise: true
    });
    const snapshot = result.result?.value;
    if (!snapshot?.root) return;
    rewriteSnapshotResources(snapshot.root);
    const serialized = JSON.stringify(snapshot);
    if (serialized === latestSnapshotJson) return;
    latestSnapshot = snapshot;
    latestSnapshotJson = serialized;
    broadcast(JSON.stringify({ type: 'snapshot', snapshot }));
  } finally {
    snapshotInFlight = false;
    if (snapshotPending) {
      snapshotPending = false;
      scheduleSnapshot();
    }
  }
}

function targetScore(candidate, matcher) {
  if (candidate.type !== 'page') return -1000;
  if (!candidate.webSocketDebuggerUrl) return -1000;
  let score = 0;
  const haystack = `${candidate.title ?? ''} ${candidate.url ?? ''}`;
  if (matcher.test(haystack)) score += 100;
  if (/qq/i.test(haystack)) score += 20;
  if (candidate.url && !/^about:blank/.test(candidate.url)) score += 5;
  if (/devtools:/i.test(candidate.url ?? '')) score -= 1000;
  return score;
}

function getTargetMatcher() {
  const source = process.env.WEB_BRIDGE_TARGET_MATCH ?? 'QQ|qq';
  try { return new RegExp(source, 'i'); }
  catch { return /QQ|qq/i; }
}

async function waitForTarget() {
  const started = Date.now();
  const matcher = getTargetMatcher();
  let lastError = null;
  while (Date.now() - started < ATTACH_TIMEOUT) {
    try {
      const targets = await listTargets(CDP_HOST, CDP_PORT);
      const ranked = targets
        .map((candidate) => ({ candidate, score: targetScore(candidate, matcher) }))
        .filter(({ score }) => score > -1000)
        .sort((a, b) => b.score - a.score);
      if (ranked[0]?.candidate) return ranked[0].candidate;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Unable to find a QQ/Electron page target on ${CDP_HOST}:${CDP_PORT}${lastError ? `: ${lastError.message}` : ''}`);
}

async function attach() {
  target = await waitForTarget();
  console.log(`[bridge] attaching to ${target.title || '(untitled)'} ${target.url}`);
  cdp = new CdpConnection(target.webSocketDebuggerUrl);
  await cdp.connect();
  await Promise.all([
    cdp.call('Runtime.enable'),
    cdp.call('Page.enable')
  ]);
  try { await cdp.call('Runtime.addBinding', { name: '__webBridgeDirty' }); } catch {}
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: INJECTED_BRIDGE_SOURCE });
  await cdp.call('Runtime.evaluate', { expression: INJECTED_BRIDGE_SOURCE, awaitPromise: false });

  cdp.on('Runtime.bindingCalled', (event) => {
    if (event.name === '__webBridgeDirty') scheduleSnapshot();
  });
  cdp.on('Page.loadEventFired', () => scheduleSnapshot(50));
  cdp.on('disconnect', () => {
    broadcast({ type: 'status', attached: false, target: null });
    cdp = null;
    target = null;
  });

  broadcast({ type: 'status', attached: true, target: { title: target.title, url: target.url } });
  await captureSnapshot();
}

server.listen(PORT, HOST, () => {
  console.log(`[bridge] web client: http://${HOST}:${PORT}`);
  console.log(`[bridge] waiting for QQ NT CDP at http://${CDP_HOST}:${CDP_PORT}`);
});

attach().catch((error) => {
  console.error('[bridge] attach failed:', error.message);
  broadcast({ type: 'status', attached: false, error: error.message });
  process.exitCode = 1;
});
