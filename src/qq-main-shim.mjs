import { constants as fsConstants } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
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
    `const { app } = require('electron');\n` +
    `const originalMain = ${JSON.stringify(originalMain)};\n` +
    `const host = process.env.WEB_BRIDGE_CDP_HOST || '127.0.0.1';\n` +
    `const port = String(process.env.WEB_BRIDGE_CDP_PORT || '');\n` +
    `if (!/^\\d+$/.test(port)) throw new Error('[web-bridge] WEB_BRIDGE_CDP_PORT is missing or invalid');\n` +
    `app.commandLine.removeSwitch('remote-debugging-address');\n` +
    `app.commandLine.removeSwitch('remote-debugging-port');\n` +
    `app.commandLine.appendSwitch('remote-debugging-address', host);\n` +
    `app.commandLine.appendSwitch('remote-debugging-port', port);\n` +
    `process.stderr.write('[web-bridge] QQ main shim injected Chromium CDP switches: ' + host + ':' + port + ' (resourcesPath=' + process.resourcesPath + ')\\n');\n` +
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
  const loaderEntry = relative(absoluteOutput, loaderPath) || './.web-bridge-main-shim.cjs';
  const normalizedLoaderEntry = loaderEntry.startsWith('.') ? loaderEntry : `./${loaderEntry}`;
  await writeFile(loaderPath, buildLoaderSource(originalMain), { mode: 0o600 });
  await writeFile(packageOutputPath, `${JSON.stringify(buildShimPackage(packageJson, normalizedLoaderEntry), null, 2)}\n`, { mode: 0o600 });
  return { packagePath: packageOutputPath, loaderPath, loaderEntry: normalizedLoaderEntry, originalMain };
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
