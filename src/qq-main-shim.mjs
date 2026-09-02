import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function buildShimPackage(packageJson, loaderPath) {
  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
    throw new Error('QQ package.json must contain a JSON object');
  }
  if (typeof packageJson.main !== 'string' || !packageJson.main.trim()) {
    throw new Error('QQ package.json does not contain a usable main entry');
  }
  if (!isAbsolute(loaderPath)) throw new Error('loaderPath must be absolute');
  return { ...packageJson, main: loaderPath };
}

export function buildLoaderSource(originalMain) {
  if (typeof originalMain !== 'string' || !originalMain.trim()) throw new Error('originalMain is required');
  return `'use strict';\n` +
    `const path = require('node:path');\n` +
    `const { app } = require('electron');\n` +
    `const originalMain = ${JSON.stringify(originalMain)};\n` +
    `const host = process.env.WEB_BRIDGE_CDP_HOST || '127.0.0.1';\n` +
    `const port = String(process.env.WEB_BRIDGE_CDP_PORT || '');\n` +
    `if (!/^\\d+$/.test(port)) throw new Error('[web-bridge] WEB_BRIDGE_CDP_PORT is missing or invalid');\n` +
    `app.commandLine.removeSwitch('remote-debugging-address');\n` +
    `app.commandLine.removeSwitch('remote-debugging-port');\n` +
    `app.commandLine.appendSwitch('remote-debugging-address', host);\n` +
    `app.commandLine.appendSwitch('remote-debugging-port', port);\n` +
    `process.stderr.write('[web-bridge] QQ main shim injected Chromium CDP switches: ' + host + ':' + port + '\\n');\n` +
    `const appRoot = path.join(process.resourcesPath, 'app');\n` +
    `const entry = path.isAbsolute(originalMain) ? originalMain : path.resolve(appRoot, originalMain);\n` +
    `require(entry);\n` +
    `setTimeout(() => {\n` +
    `  try { if (global.launcher?.installPathPkgJson) global.launcher.installPathPkgJson.main = originalMain; } catch {}\n` +
    `}, 0);\n`;
}

export async function prepareMainShim({ packagePath, outputDir }) {
  const raw = await readFile(packagePath, 'utf8');
  const packageJson = JSON.parse(raw);
  const originalMain = packageJson.main;
  const absoluteOutput = resolve(outputDir);
  await mkdir(absoluteOutput, { recursive: true, mode: 0o700 });
  const loaderPath = join(absoluteOutput, 'qq-main-shim.cjs');
  const packageOutputPath = join(absoluteOutput, 'package.json');
  await writeFile(loaderPath, buildLoaderSource(originalMain), { mode: 0o600 });
  await writeFile(packageOutputPath, `${JSON.stringify(buildShimPackage(packageJson, loaderPath), null, 2)}\n`, { mode: 0o600 });
  return { packagePath: packageOutputPath, loaderPath, originalMain };
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
  const outputDir = values.get('--output');
  if (!packagePath || !outputDir) throw new Error('Usage: node src/qq-main-shim.mjs --package /path/to/package.json --output /tmp/dir');
  return { packagePath, outputDir };
}

async function main() {
  const result = await prepareMainShim(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[web-bridge] failed to prepare QQ main shim: ${error.message}`);
    process.exitCode = 1;
  });
}
