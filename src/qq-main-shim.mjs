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
  return `'use strict';\n` +
    `const path = require('node:path');\n` +
    `const net = require('node:net');\n` +
    `const { app, webContents } = require('electron');\n` +
    `const originalMain = ${JSON.stringify(originalMain)};\n` +
    `const host = process.env.WEB_BRIDGE_CDP_HOST || '127.0.0.1';\n` +
    `const port = Number(process.env.WEB_BRIDGE_CDP_PORT || 0);\n` +
    `const token = process.env.WEB_BRIDGE_QQ_SHIM_TOKEN || '';\n` +
    `if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('[web-bridge] WEB_BRIDGE_CDP_PORT is missing or invalid');\n` +
    `function targetInfo(wc) {\n` +
    `  if (!wc || wc.isDestroyed()) return null;\n` +
    `  let kind = '';\n` +
    `  try { kind = wc.getType?.() || ''; } catch {}\n` +
    `  if (kind && !['window', 'browserView', 'webview', 'offscreen'].includes(kind)) return null;\n` +
    `  let title = ''; let url = '';\n` +
    `  try { title = wc.getTitle?.() || ''; } catch {}\n` +
    `  try { url = wc.getURL?.() || ''; } catch {}\n` +
    `  return { id: String(wc.id), type: 'page', title: title || 'QQ NT', url };\n` +
    `}\n` +
    `function startDebuggerBridge() {\n` +
    `  const server = net.createServer((socket) => {\n` +
    `    socket.setNoDelay(true);\n` +
    `    socket.setEncoding('utf8');\n` +
    `    let buffer = '';\n` +
    `    let target = null;\n` +
    `    let ownsDebugger = false;\n` +
    `    let cleaned = false;\n` +
    `    const send = (message) => { if (!socket.destroyed) socket.write(JSON.stringify(message) + '\\n'); };\n` +
    `    const onDebuggerMessage = (_event, method, params, sessionId) => {\n` +
    `      const message = { method, params: params || {} };\n` +
    `      if (sessionId) message.sessionId = sessionId;\n` +
    `      send(message);\n` +
    `    };\n` +
    `    const onDebuggerDetach = (_event, reason) => {\n` +
    `      send({ method: '__webBridgeShim.detached', params: { reason: reason || 'detached' } });\n` +
    `      socket.end();\n` +
    `    };\n` +
    `    const cleanup = () => {\n` +
    `      if (cleaned) return; cleaned = true;\n` +
    `      if (target && !target.isDestroyed()) {\n` +
    `        try { target.debugger.removeListener('message', onDebuggerMessage); } catch {}\n` +
    `        try { target.debugger.removeListener('detach', onDebuggerDetach); } catch {}\n` +
    `        if (ownsDebugger) { try { if (target.debugger.isAttached()) target.debugger.detach(); } catch {} }\n` +
    `      }\n` +
    `      target = null; ownsDebugger = false;\n` +
    `    };\n` +
    `    async function handle(message) {\n` +
    `      const id = message && message.id;\n` +
    `      if (token && message?.token !== token) { send({ id, error: { code: -32001, message: 'unauthorized shim debugger client' } }); return; }\n` +
    `      if (message?.op === 'list') {\n` +
    `        const targets = webContents.getAllWebContents().map(targetInfo).filter(Boolean);\n` +
    `        send({ id, result: targets });\n` +
    `        return;\n` +
    `      }\n` +
    `      if (message?.op === 'attach') {\n` +
    `        cleanup(); cleaned = false;\n` +
    `        const wc = webContents.fromId(Number(message.targetId));\n` +
    `        if (!wc || wc.isDestroyed()) { send({ id, error: { code: -32002, message: 'renderer target no longer exists' } }); return; }\n` +
    `        target = wc;\n` +
    `        try {\n` +
    `          if (!target.debugger.isAttached()) { target.debugger.attach('1.3'); ownsDebugger = true; }\n` +
    `          target.debugger.on('message', onDebuggerMessage);\n` +
    `          target.debugger.on('detach', onDebuggerDetach);\n` +
    `          send({ id, result: { attached: true, targetId: String(target.id) } });\n` +
    `        } catch (error) {\n` +
    `          target = null; ownsDebugger = false;\n` +
    `          send({ id, error: { code: -32003, message: error?.message || String(error) } });\n` +
    `        }\n` +
    `        return;\n` +
    `      }\n` +
    `      if (message?.method) {\n` +
    `        if (!target || target.isDestroyed()) { send({ id, error: { code: -32004, message: 'no renderer target attached' } }); return; }\n` +
    `        try {\n` +
    `          const result = await target.debugger.sendCommand(message.method, message.params || {});\n` +
    `          send({ id, result: result || {} });\n` +
    `        } catch (error) {\n` +
    `          send({ id, error: { code: -32005, message: error?.message || String(error) } });\n` +
    `        }\n` +
    `      }\n` +
    `    }\n` +
    `    socket.on('data', (chunk) => {\n` +
    `      buffer += chunk;\n` +
    `      if (buffer.startsWith('GET ') || buffer.startsWith('HEAD ')) { socket.end('HTTP/1.1 404 Not Found\\r\\nConnection: close\\r\\nContent-Length: 0\\r\\n\\r\\n'); return; }\n` +
    `      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { socket.destroy(); return; }\n` +
    `      let newline;\n` +
    `      while ((newline = buffer.indexOf('\\n')) >= 0) {\n` +
    `        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);\n` +
    `        if (!line) continue;\n` +
    `        let message; try { message = JSON.parse(line); } catch { continue; }\n` +
    `        Promise.resolve(handle(message)).catch((error) => send({ id: message?.id, error: { code: -32099, message: error?.message || String(error) } }));\n` +
    `      }\n` +
    `    });\n` +
    `    socket.on('close', cleanup);\n` +
    `    socket.on('error', cleanup);\n` +
    `  });\n` +
    `  server.on('error', (error) => process.stderr.write('[web-bridge] QQ debugger shim server error: ' + (error?.stack || error) + '\\n'));\n` +
    `  server.listen(port, host, () => process.stderr.write('[web-bridge] QQ webContents.debugger bridge listening: ' + host + ':' + port + ' (resourcesPath=' + process.resourcesPath + ')\\n'));\n` +
    `  app.once('before-quit', () => { try { server.close(); } catch {} });\n` +
    `}\n` +
    `startDebuggerBridge();\n` +
    `const appRoot = path.join(process.resourcesPath, 'app');\n` +
    `const entry = path.isAbsolute(originalMain) ? originalMain : path.resolve(appRoot, originalMain);\n` +
    `require(entry);\n` +
    `setTimeout(() => {\n` +
    `  try { if (global.launcher?.installPathPkgJson) global.launcher.installPathPkgJson.main = originalMain; } catch {}\n` +
    `}, 0);\n`;
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
