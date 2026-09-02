import { constants as fsConstants } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function buildShimPackage(packageJson, loaderEntry) {
  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
    throw new Error('QQ package.json must contain a JSON object');
  }
  if (typeof packageJson.main !== 'string' || !packageJson.main.trim()) {
    throw new Error('QQ package.json does not contain a usable main entry');
  }
  if (typeof loaderEntry !== 'string' || !loaderEntry.trim()) throw new Error('loaderEntry is required');
  return { ...packageJson, main: loaderEntry };
}

export function buildLoaderSource(originalMain) {
  if (typeof originalMain !== 'string' || !originalMain.trim()) throw new Error('originalMain is required');
  return String.raw`'use strict';
const path = require('node:path');
const net = require('node:net');
const fs = require('node:fs/promises');
const { app, webContents } = require('electron');
const originalMain = ${JSON.stringify(originalMain)};
const host = process.env.WEB_BRIDGE_CDP_HOST || '127.0.0.1';
const port = Number(process.env.WEB_BRIDGE_CDP_PORT || 0);
const token = process.env.WEB_BRIDGE_QQ_SHIM_TOKEN || '';
const pollMs = Math.max(25, Math.min(5000, Number(process.env.WEB_BRIDGE_SHIM_POLL_MS || 120) || 120));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('[web-bridge] WEB_BRIDGE_CDP_PORT is missing or invalid');

function targetInfo(wc) {
  if (!wc || wc.isDestroyed()) return null;
  let kind = ''; let title = ''; let url = ''; let visible = false; let focused = false; let debuggerAttached = false;
  try { kind = wc.getType?.() || ''; } catch {}
  if (kind === 'devTools') return null;
  try { title = wc.getTitle?.() || ''; } catch {}
  try { url = wc.getURL?.() || ''; } catch {}
  try { const owner = wc.getOwnerBrowserWindow?.(); visible = Boolean(owner?.isVisible?.()); focused = Boolean(owner?.isFocused?.()); } catch {}
  try { debuggerAttached = Boolean(wc.debugger?.isAttached?.()); } catch {}
  return { id: String(wc.id), type: 'page', title: title || url || 'QQ NT', url, kind, visible, focused, debuggerAttached, transport: 'electron-webcontents' };
}

function targetRank(info) {
  let score = 0;
  const haystack = (info?.title || '') + ' ' + (info?.url || '');
  if (/\#\/main\/(message|contact|setting)|\#\/main\b/i.test(info?.url || '')) score += 5000;
  if (/chatPoolWin=1|\#\/chat/i.test(info?.url || '')) score += 1200;
  if (info?.visible) score += 1000;
  if (info?.focused) score += 500;
  if (info?.kind === 'window') score += 250;
  else if (['browserView', 'webview', 'offscreen'].includes(info?.kind)) score += 120;
  if (info?.url && info.url !== 'about:blank') score += 50;
  if (/qq|tencent/i.test(haystack)) score += 25;
  if (/hiddenWindow|hiddenPoolBaseWin/i.test(info?.url || '')) score -= 2000;
  if (/\#\/blank|about:blank/i.test(info?.url || '')) score -= 1000;
  return score;
}

function candidates(requestedId = '') {
  const items = webContents.getAllWebContents().map((wc) => ({ wc, info: targetInfo(wc) })).filter((item) => item.info);
  items.sort((a, b) => targetRank(b.info) - targetRank(a.info));
  if (requestedId) {
    const index = items.findIndex((item) => item.info.id === String(requestedId));
    if (index > 0) items.unshift(items.splice(index, 1)[0]);
  }
  return items;
}

function modifiersFromMask(mask) {
  const value = Number(mask) || 0;
  const result = [];
  if (value & 1) result.push('alt');
  if (value & 2) result.push('control');
  if (value & 4) result.push('meta');
  if (value & 8) result.push('shift');
  return result;
}

function runtimeResult(value) {
  if (value === undefined) return { result: { type: 'undefined' } };
  if (value === null) return { result: { type: 'object', subtype: 'null', value: null } };
  const type = typeof value;
  if (type === 'bigint') return { result: { type: 'bigint', unserializableValue: String(value) + 'n' } };
  if (type === 'number' && !Number.isFinite(value)) return { result: { type: 'number', unserializableValue: String(value) } };
  return { result: { type, value } };
}

function startElectronBridge() {
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    socket.setEncoding('utf8');
    let buffer = '';
    let target = null;
    let cleaned = false;
    let dirtyPoll = null;
    const scripts = [];
    const bindings = new Set();
    const send = (message) => { if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n'); };

    const stopDirtyPoll = () => {
      if (!dirtyPoll) return;
      clearInterval(dirtyPoll);
      dirtyPoll = null;
    };
    const startDirtyPoll = () => {
      stopDirtyPoll();
      if (!bindings.has('__webBridgeDirty')) return;
      dirtyPoll = setInterval(() => {
        if (!target || target.isDestroyed() || socket.destroyed) return;
        send({ method: 'Runtime.bindingCalled', params: { name: '__webBridgeDirty', payload: 'poll', executionContextId: 0 } });
      }, pollMs);
      dirtyPoll.unref?.();
    };
    const installBindings = async () => {
      if (!target || target.isDestroyed() || !bindings.size) return;
      const names = JSON.stringify([...bindings]);
      await target.executeJavaScript('(function(){for(const n of ' + names + '){if(typeof globalThis[n]!=="function")globalThis[n]=function(){};}})()', true);
    };
    const installScripts = async () => {
      if (!target || target.isDestroyed()) return;
      await installBindings().catch(() => {});
      for (const source of scripts) {
        if (!target || target.isDestroyed()) return;
        await target.executeJavaScript(source, true).catch(() => {});
      }
    };
    const onDomReady = () => { installScripts().catch(() => {}); };
    const onDidStartNavigation = (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame === false) return;
      send({ method: 'Runtime.executionContextsCleared', params: {} });
    };
    const onDidNavigate = (_event, url) => {
      send({ method: 'Page.frameNavigated', params: { frame: { id: 'main', url: String(url || '') } } });
    };
    const onDidNavigateInPage = (_event, url, isMainFrame) => {
      if (isMainFrame === false) return;
      send({ method: 'Page.frameNavigated', params: { frame: { id: 'main', url: String(url || '') } } });
    };
    const onGone = (_event, details) => {
      send({ method: '__webBridgeShim.detached', params: { reason: details?.reason || 'render-process-gone' } });
      socket.end();
    };
    const onDestroyed = () => socket.end();

    const cleanupTarget = () => {
      stopDirtyPoll();
      const current = target;
      target = null;
      if (!current || current.isDestroyed()) return;
      try { current.removeListener('dom-ready', onDomReady); } catch {}
      try { current.removeListener('did-start-navigation', onDidStartNavigation); } catch {}
      try { current.removeListener('did-navigate', onDidNavigate); } catch {}
      try { current.removeListener('did-navigate-in-page', onDidNavigateInPage); } catch {}
      try { current.removeListener('render-process-gone', onGone); } catch {}
      try { current.removeListener('destroyed', onDestroyed); } catch {}
    };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      cleanupTarget();
    };

    async function evaluate(params) {
      const expression = String(params?.expression || '');
      if (params?.returnByValue === false) {
        const match = expression.match(/__WEB_BRIDGE__\?\.objectFor\((\d+)\)/);
        if (match) return { result: { type: 'object', subtype: 'node', objectId: 'wb-node:' + match[1] } };
        throw new Error('hybrid bridge only supports object handles for __WEB_BRIDGE__.objectFor()');
      }
      const value = await target.executeJavaScript(expression, true);
      return runtimeResult(value);
    }

    async function setFileInputFiles(params) {
      const match = String(params?.objectId || '').match(/^wb-node:(\d+)$/);
      if (!match) throw new Error('hybrid bridge requires a web-bridge node objectId');
      const files = Array.isArray(params?.files) ? params.files : [];
      const payload = [];
      for (const filename of files) {
        const data = await fs.readFile(String(filename));
        payload.push({ name: path.basename(String(filename)), base64: data.toString('base64') });
      }
      const nodeId = Number(match[1]);
      const source = '(function(){' +
        'const node=globalThis.__WEB_BRIDGE__?.objectFor(' + nodeId + ');' +
        'if(!(node instanceof HTMLInputElement)||String(node.type).toLowerCase()!=="file")throw new Error("file input no longer exists");' +
        'const dt=new DataTransfer();const items=' + JSON.stringify(payload) + ';' +
        'for(const item of items){const binary=atob(item.base64);const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);dt.items.add(new File([bytes],item.name,{type:"application/octet-stream"}));}' +
        'node.files=dt.files;node.dispatchEvent(new Event("input",{bubbles:true}));node.dispatchEvent(new Event("change",{bubbles:true}));' +
        'globalThis.__WEB_BRIDGE__?.markVisual(' + nodeId + ');return {count:dt.files.length};})()';
      await target.executeJavaScript(source, true);
      return {};
    }

    async function dispatchMouse(params) {
      const typeMap = { mouseMoved: 'mouseMove', mousePressed: 'mouseDown', mouseReleased: 'mouseUp', mouseWheel: 'mouseWheel' };
      const type = typeMap[params?.type];
      if (!type) throw new Error('unsupported mouse event type: ' + String(params?.type || ''));
      const event = {
        type,
        x: Math.round(Number(params?.x) || 0),
        y: Math.round(Number(params?.y) || 0),
        modifiers: modifiersFromMask(params?.modifiers)
      };
      if (type === 'mouseDown' || type === 'mouseUp') {
        event.button = params?.button || 'left';
        event.clickCount = Number(params?.clickCount) || 1;
      }
      if (type === 'mouseWheel') {
        event.deltaX = Number(params?.deltaX) || 0;
        event.deltaY = Number(params?.deltaY) || 0;
        event.canScroll = true;
      }
      target.sendInputEvent(event);
      return {};
    }

    async function dispatchKey(params) {
      const kind = params?.type === 'keyUp' ? 'keyUp' : params?.type === 'char' ? 'char' : 'keyDown';
      const keyCode = String(params?.key || params?.code || '');
      if (!keyCode) throw new Error('keyCode is required');
      target.sendInputEvent({ type: kind, keyCode, modifiers: modifiersFromMask(params?.modifiers), isAutoRepeat: Boolean(params?.autoRepeat) });
      return {};
    }

    async function command(method, params) {
      if (!target || target.isDestroyed()) throw new Error('no renderer target attached');
      if (method === 'Runtime.enable' || method === 'Page.enable' || method === 'DOM.enable') return {};
      if (method === 'Runtime.addBinding') {
        const name = String(params?.name || '');
        if (!name) throw new Error('binding name is required');
        bindings.add(name);
        await installBindings();
        startDirtyPoll();
        return {};
      }
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        const source = String(params?.source || '');
        scripts.push(source);
        return { identifier: 'web-bridge-script-' + scripts.length };
      }
      if (method === 'Runtime.evaluate') return evaluate(params || {});
      if (method === 'Input.dispatchMouseEvent') return dispatchMouse(params || {});
      if (method === 'Input.dispatchKeyEvent') return dispatchKey(params || {});
      if (method === 'Input.insertText') {
        await Promise.resolve(target.insertText(String(params?.text || '')));
        return {};
      }
      if (method === 'DOM.setFileInputFiles') return setFileInputFiles(params || {});
      throw Object.assign(new Error('unsupported by Electron hybrid bridge: ' + method), { code: -32601 });
    }

    async function handle(message) {
      const id = message && message.id;
      if (token && message?.token !== token) { send({ id, error: { code: -32001, message: 'unauthorized shim client' } }); return; }
      if (message?.op === 'list') {
        send({ id, result: candidates().map((item) => item.info) });
        return;
      }
      if (message?.op === 'attach') {
        cleanupTarget();
        cleaned = false;
        const selected = candidates(message.targetId)[0];
        if (!selected?.wc || selected.wc.isDestroyed()) {
          send({ id, error: { code: -32003, message: 'no usable Electron webContents target' } });
          return;
        }
        target = selected.wc;
        target.on('dom-ready', onDomReady);
        target.on('did-start-navigation', onDidStartNavigation);
        target.on('did-navigate', onDidNavigate);
        target.on('did-navigate-in-page', onDidNavigateInPage);
        target.on('render-process-gone', onGone);
        target.on('destroyed', onDestroyed);
        startDirtyPoll();
        send({ id, result: { attached: true, targetId: String(target.id), target: targetInfo(target), mode: 'electron-hybrid' } });
        return;
      }
      if (message?.method) {
        try {
          const result = await command(message.method, message.params || {});
          send({ id, result: result || {} });
        } catch (error) {
          send({ id, error: { code: error?.code || -32005, message: error?.message || String(error) } });
        }
      }
    }

    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.startsWith('GET ') || buffer.startsWith('HEAD ')) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { socket.destroy(); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        Promise.resolve(handle(message)).catch((error) => send({ id: message?.id, error: { code: -32099, message: error?.message || String(error) } }));
      }
    });
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
  server.on('error', (error) => process.stderr.write('[web-bridge] QQ Electron bridge server error: ' + (error?.stack || error) + '\n'));
  server.listen(port, host, () => process.stderr.write('[web-bridge] QQ Electron hybrid bridge listening: ' + host + ':' + port + ' (resourcesPath=' + process.resourcesPath + ')\n'));
  app.once('before-quit', () => { try { server.close(); } catch {} });
}

startElectronBridge();
const appRoot = path.join(process.resourcesPath, 'app');
const entry = path.isAbsolute(originalMain) ? originalMain : path.resolve(appRoot, originalMain);
require(entry);
setTimeout(() => {
  try { if (global.launcher?.installPathPkgJson) global.launcher.installPathPkgJson.main = originalMain; } catch {}
}, 0);
`;
}

export async function prepareMainShim({ packagePath, outputDir }) {
  const absolutePackagePath = resolve(packagePath);
  const raw = await readFile(absolutePackagePath, 'utf8');
  const packageJson = JSON.parse(raw);
  const originalMain = packageJson.main;
  const absoluteOutput = resolve(outputDir);
  await mkdir(absoluteOutput, { recursive: true, mode: 0o700 });
  const loaderPath = join(absoluteOutput, '.web-bridge-main-shim.cjs');
  const packageOutputPath = join(absoluteOutput, 'package.json');
  const loaderEntry = './.web-bridge-main-shim.cjs';
  await writeFile(loaderPath, buildLoaderSource(originalMain), { mode: 0o600 });
  await writeFile(packageOutputPath, `${JSON.stringify(buildShimPackage(packageJson, loaderEntry), null, 2)}\n`, { mode: 0o600 });
  return { packagePath: packageOutputPath, loaderPath, loaderEntry, originalMain };
}

async function mirrorDirectory(sourceDir, destinationDir, excludedNames = new Set()) {
  await mkdir(destinationDir, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (excludedNames.has(entry.name)) continue;
    await symlink(join(sourceDir, entry.name), join(destinationDir, entry.name));
  }
}

async function copyExecutable(source, destination) {
  try {
    await copyFile(source, destination, fsConstants.COPYFILE_FICLONE);
  } catch (error) {
    if (!['EXDEV', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) throw error;
    await copyFile(source, destination);
  }
  const info = await stat(source);
  await chmod(destination, info.mode & 0o777);
}

/**
 * Build an ephemeral QQ/Electron distribution without a mount or user namespace.
 * Electron derives process.resourcesPath from the real executable path, so a real
 * executable copy plus a mostly-symlinked resources tree lets us replace only
 * resources/app/package.json. Chromium keeps its normal Linux sandbox instead of
 * trying to nest its namespace sandbox inside bubblewrap's user namespace.
 */
export async function prepareShadowQQ({ qqBin, outputDir }) {
  if (!qqBin) throw new Error('qqBin is required');
  const sourceBin = resolve(qqBin);
  const sourceRoot = dirname(sourceBin);
  const sourceResources = join(sourceRoot, 'resources');
  const sourceApp = join(sourceResources, 'app');
  const sourcePackage = join(sourceApp, 'package.json');
  const shadowRoot = resolve(outputDir);
  const shadowResources = join(shadowRoot, 'resources');
  const shadowApp = join(shadowResources, 'app');
  const shadowBin = join(shadowRoot, basename(sourceBin));

  await stat(sourcePackage);
  await mkdir(shadowRoot, { recursive: true, mode: 0o700 });
  await copyExecutable(sourceBin, shadowBin);
  await mirrorDirectory(sourceRoot, shadowRoot, new Set([basename(sourceBin), 'resources']));
  await mirrorDirectory(sourceResources, shadowResources, new Set(['app']));
  await mirrorDirectory(sourceApp, shadowApp, new Set(['package.json', '.web-bridge-main-shim.cjs']));
  const shim = await prepareMainShim({ packagePath: sourcePackage, outputDir: shadowApp });

  return {
    ...shim,
    sourceBin,
    shadowBin,
    shadowRoot,
    shadowResources,
    shadowApp
  };
}

function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
    values.set(arg, value);
  }
  const packagePath = values.get('--package');
  const qqBin = values.get('--qq-bin');
  const outputDir = values.get('--output');
  if (!outputDir || Boolean(packagePath) === Boolean(qqBin)) {
    throw new Error('Usage: node src/qq-main-shim.mjs (--package /path/to/package.json | --qq-bin /opt/QQ/qq) --output /tmp/dir');
  }
  return { packagePath, qqBin, outputDir };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = args.qqBin
    ? await prepareShadowQQ({ qqBin: args.qqBin, outputDir: args.outputDir })
    : await prepareMainShim({ packagePath: args.packagePath, outputDir: args.outputDir });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[web-bridge] failed to prepare QQ main shim: ${error.message}`);
    process.exitCode = 1;
  });
}
